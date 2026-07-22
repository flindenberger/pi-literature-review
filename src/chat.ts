/**
 * Paper-chat engine: answer a reader's question about ONE paper from the
 * local, verified PDF library -- the per-paper counterpart to the corpus
 * synthesis in synthesize.ts, sharing its retrieval and citation machinery.
 *
 * Pipeline per question: match library (adopting loose PDFs) -> select the
 * ONE paper -> ensure its embedding index -> shared retrieval WITHIN that
 * paper (query variants + embedding union + lexical layer, retrieve.ts) ->
 * one generation pass with a didactic prompt -> deterministic citation
 * enforcement -> references from the verified record.
 *
 * THE ONE INVIOLABLE RULE holds unchanged: the generator sees numbered
 * excerpts and may cite ONLY by bracketed numbers; everything bibliographic
 * in the result comes from the verified search records. Each call is
 * stateless -- the Pi conversation carries the thread; the code-validated
 * rounds are persisted to a protocol file on disk (the report is built from
 * that protocol, never from the chat transcript).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { adoptUnmatched, type AdoptionResult, realAdoptDeps } from "./adopt.ts";
import { chatModel, llmConfig } from "./config.ts";
import {
	type CorpusDeps,
	ensureIndexed,
	type ExtractionFailure,
	type LibraryMatch,
	type LibraryPaper,
	matchLibrary,
	realCorpusDeps,
} from "./corpus.ts";
import { createBackend, type GenerateOptions, type LlmBackend } from "./llm.ts";
import { outputRoot } from "./output.ts";
import {
	type QueryVariant,
	retrieve,
	type RetrievedChunk,
	type TranslateFn,
	translateViaBackend,
} from "./retrieve.ts";
import {
	buildReferences,
	DEFAULT_TOP_K,
	enforceCitations,
	MAX_TOP_K,
	NUM_CTX,
	OUTPUT_RESERVE_TOKENS,
	promptTokens,
	type ReferenceEntry,
	requireOutput,
} from "./synthesize.ts";

/** Explanatory tone comes from the prompt, not from sampling. */
const ASK_TEMPERATURE = 0.2;
/** Report retrieval: chunks fetched per session question ... */
export const REPORT_PER_QUESTION_K = 4;
/** ... and the cap on the union that goes into the prompt. */
export const REPORT_MAX_CHUNKS = MAX_TOP_K;
/** Used when a report is requested without any chat session or focus. */
export const DEFAULT_REPORT_QUESTION = "What are the main contributions, methods and findings of this paper?";

/* ------------------------------------------------------------------ *
 * Prompt -- pure                                                      *
 * ------------------------------------------------------------------ */

/** The grounding contract of the chat: didactic, excerpts-only, marker
 * after every claim. Deliberately its own prompt (the synthesis prompt
 * asks for terse review prose; here the reader wants an explanation). */
export function chatSystemPrompt(language: string): string {
	return [
		"You are helping a reader understand ONE scientific paper by answering their question about it.",
		"You are given numbered source excerpts [1]..[k] from that paper. Rules:",
		"- Use ONLY information from the excerpts. If they do not answer the question, say so plainly.",
		"- Explain in plain, accessible language; briefly unpack technical terms where they matter.",
		"- After every claim taken from an excerpt, put its number in brackets, e.g. [3].",
		"  Multiple sources: [1][4]. Use ONLY numbers that appear in the given excerpts.",
		"- NEVER write author names, years, paper titles, DOIs, or a reference list.",
		"  The reference list is added by software afterwards. Do not add a heading like \"References\".",
		`- Write in ${language}. Stay factual; no speculation beyond the excerpts.`,
	].join("\n");
}

export function buildChatPrompt(
	question: string,
	chunks: RetrievedChunk[],
	language?: string,
): { system: string; user: string } {
	const blocks = chunks.map((chunk) => `[${chunk.id}] (source ${chunk.id})\n${chunk.text}`);
	return {
		system: chatSystemPrompt(language?.trim() || "the language of the question"),
		user: `Question: ${question}\n\nSource excerpts:\n\n${blocks.join("\n\n")}`,
	};
}

/** The report contract: a structured, grounded summary of ONE paper,
 * weighted toward what the reader actually asked during the session. */
export function reportSystemPrompt(language: string): string {
	return [
		"You are writing a short grounded summary of ONE scientific paper for a reader who has been studying it.",
		"You are given the reader's questions and numbered source excerpts [1]..[k] from that paper. Rules:",
		"- Summarize what the excerpts say about the paper's aim, methods, findings and limitations,",
		"  insofar as the excerpts cover them, giving weight to the reader's questions.",
		"- Use ONLY information from the excerpts. If they do not cover a point, say so plainly.",
		"- After every claim taken from an excerpt, put its number in brackets, e.g. [3].",
		"  Multiple sources: [1][4]. Use ONLY numbers that appear in the given excerpts.",
		"- NEVER write author names, years, paper titles, DOIs, or a reference list.",
		"  The reference list is added by software afterwards. Do not add a heading like \"References\".",
		`- Write in ${language}. Stay factual; no speculation beyond the excerpts.`,
	].join("\n");
}

export function buildReportPrompt(
	questions: string[],
	chunks: RetrievedChunk[],
	language?: string,
): { system: string; user: string } {
	const asked = questions.map((question) => `- ${question}`).join("\n");
	const blocks = chunks.map((chunk) => `[${chunk.id}] (source ${chunk.id})\n${chunk.text}`);
	return {
		system: reportSystemPrompt(language?.trim() || "the language of the questions"),
		user: `The reader's questions about the paper:\n${asked}\n\nSource excerpts:\n\n${blocks.join("\n\n")}`,
	};
}

/* ------------------------------------------------------------------ *
 * Paper selection -- pure                                             *
 * ------------------------------------------------------------------ */

/** Identity-key prefix for PDFs without a verified record. */
export const FILE_KEY_PREFIX = "file:";

/**
 * The selectable chat pool: verified papers PLUS filename-only entries for
 * PDFs without a record (user decision 2026-07-16: every PDF in the folder
 * must be choosable; when no metadata exists, citations honestly carry
 * filename and page -- nothing bibliographic is ever invented). Pure.
 */
export function chatPool(match: LibraryMatch): LibraryPaper[] {
	const unverified = match.unmatched.map((file) => {
		const base = file.replace(/\.pdf$/i, "");
		return {
			file: join(match.papersDir, file),
			base,
			key: `${FILE_KEY_PREFIX}${base}`,
			entry: { title: "", pdf_url: "", doi: "", arxiv_id: "", authors: [], year: null },
		};
	});
	return [...match.matched, ...unverified];
}

function availablePapers(matched: LibraryPaper[]): string {
	return matched.map((paper) => `${paper.base}.pdf`).join(", ") || "(none)";
}

/** Resolve the wanted PDF filename (with or without .pdf, case-insensitive
 * as a fallback) to exactly one matched library paper. The error message
 * lists what IS available -- it is relayed verbatim by the CLI and the
 * tool, so the user can correct the name without another lookup. */
export function selectPaper(matched: LibraryPaper[], wanted: string): LibraryPaper {
	const base = wanted.trim().replace(/\.pdf$/i, "");
	if (!base) {
		throw new Error(`no paper selected -- pass the PDF filename (papers in the library: ${availablePapers(matched)})`);
	}
	const exact = matched.find((paper) => paper.base === base);
	if (exact) return exact;
	const relaxed = matched.filter((paper) => paper.base.toLowerCase() === base.toLowerCase());
	if (relaxed.length === 1) return relaxed[0];
	throw new Error(`paper not in the matched library: ${base}.pdf (available: ${availablePapers(matched)})`);
}

/* ------------------------------------------------------------------ *
 * Library with adoption                                               *
 * ------------------------------------------------------------------ */

export interface ChatLibraryOptions {
	library?: (root: string, onWarn: (message: string) => void) => LibraryMatch;
	adopt?: (unmatched: string[], papersDir: string) => Promise<AdoptionResult[]>;
	signal?: AbortSignal;
}

/**
 * Library scan with an adoption attempt for loose PDFs (same orchestration
 * as the synthesis stage): whatever gains a verified identity is re-matched;
 * whatever does not stays excluded and named. Exported because the tool's
 * paper picker needs the very same view before any question is asked.
 */
export async function ensureChatLibrary(
	root: string,
	onWarn: (message: string) => void,
	options: ChatLibraryOptions = {},
): Promise<{ match: LibraryMatch; adopted: string[]; adoptionFailures: Array<{ file: string; reason: string }> }> {
	const libraryFn = options.library ?? matchLibrary;
	let match = libraryFn(root, onWarn);
	const adopted: string[] = [];
	const adoptionFailures: Array<{ file: string; reason: string }> = [];
	if (match.unmatched.length) {
		onWarn(`${match.unmatched.length} PDF(s) without verified metadata -- attempting adoption (identifier lookup)`);
		const adoptFn = options.adopt
			?? ((files: string[], dir: string) => adoptUnmatched(files, dir, realAdoptDeps(), onWarn, options.signal));
		const adoptions = await adoptFn(match.unmatched, match.papersDir);
		for (const adoption of adoptions) {
			if (adoption.status === "adopted") {
				adopted.push(adoption.file);
				onWarn(`adopted ${adoption.file}: ${adoption.detail}`);
			} else {
				adoptionFailures.push({ file: adoption.file, reason: adoption.detail });
				onWarn(`could not adopt ${adoption.file}: ${adoption.detail}`);
			}
		}
		if (adopted.length) match = libraryFn(root, onWarn); // new twins -> re-match
	}
	return { match, adopted, adoptionFailures };
}

/* ------------------------------------------------------------------ *
 * Chat protocol -- the code-validated record of a session             *
 * ------------------------------------------------------------------ */

export const CHAT_SCHEMA = 1;

/** One validated question round as persisted: everything in here has
 * passed the citation gate; nothing comes from the Pi chat transcript. */
export interface ChatRound {
	/** ISO timestamp of the question. */
	asked: string;
	question: string;
	language: string | null;
	model: string;
	/** Pi session the round belongs to (null: recorded without a session,
	 * e.g. by a CLI run outside any pi session or before session scoping). */
	session: string | null;
	top_k: number;
	grounded: boolean;
	prose: string;
	references: ReferenceEntry[];
	/** Only the excerpts the answer actually cites (bounds file growth;
	 * the report re-retrieves, so nothing is lost). */
	cited_chunks: Array<{ id: number; page: number; score: number; text: string }>;
	invalid_markers: string[];
	unmarked_sentences: number;
	stripped_reference_section: boolean;
}

/** On-disk shape -- never a bare array, so the schema can evolve. */
export interface ChatProtocol {
	schema: number;
	base: string;
	paper: { key: string; title: string; authors: string[]; year: string | null; doi: string; arxiv_id: string };
	/** UTC date the file is named after. */
	date: string;
	rounds: ChatRound[];
}

export function realChatLogDeps(): ChatLogDeps {
	return {
		read: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
		write: (path, text) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text, "utf8");
		},
		exists: (path) => existsSync(path),
		list: (dir) => {
			try {
				return readdirSync(dir);
			} catch {
				return [];
			}
		},
	};
}

/** Protocol file for a paper on a given day. Dates are UTC (the ISO date
 * of the round's timestamp), matching writeRunOutputs' date handling. */
export function chatLogPath(root: string, dateIso10: string, base: string, suffix = 0): string {
	const name = suffix > 1 ? `${dateIso10}_${base}_${suffix}.json` : `${dateIso10}_${base}.json`;
	return join(root, "chats", name);
}

/** Marker file remembering the session's current paper (sticky selection).
 * The date-anchored protocol filename pattern never matches it. */
export function currentPaperPath(root: string): string {
	return join(root, "chats", "current-paper.json");
}

/**
 * The sticky selection: set after every successful round, used whenever a
 * call names no paper -- a weak agent model then only has to transport the
 * user's question (user decision 2026-07-16, after a field test with an
 * agent that could not carry the paper name across turns). SESSION-SCOPED
 * (user decision 2026-07-21): the marker only counts inside the pi session
 * that wrote it -- a new pi session starts with no current paper. Null when
 * unset, unreadable, or written by a different session.
 */
export function readCurrentPaper(
	root: string,
	session: string | null | undefined,
	deps: ChatLogDeps = realChatLogDeps(),
): string | null {
	if (!session) return null;
	try {
		const parsed = JSON.parse(deps.read(currentPaperPath(root)) ?? "null") as
			| { base?: unknown; session?: unknown }
			| null;
		if (!parsed || typeof parsed.base !== "string" || !parsed.base.trim()) return null;
		return parsed.session === session ? parsed.base.trim() : null;
	} catch {
		return null;
	}
}

/** Best-effort: failure to remember the paper must never break a run. */
export function writeCurrentPaper(
	root: string,
	base: string,
	session: string | null | undefined,
	deps: ChatLogDeps = realChatLogDeps(),
	onWarn: (message: string) => void = () => {},
): void {
	try {
		deps.write(currentPaperPath(root), JSON.stringify({ base, session: session ?? null }, null, 2) + "\n");
	} catch (error) {
		onWarn(`could not remember the current paper: ${error instanceof Error ? error.message : error}`);
	}
}

function parseProtocol(text: string | null): ChatProtocol | null {
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text) as ChatProtocol;
		if (parsed && parsed.schema === CHAT_SCHEMA && typeof parsed.base === "string"
			&& parsed.paper && typeof parsed.paper.key === "string" && Array.isArray(parsed.rounds)) {
			return parsed;
		}
	} catch {
		// fall through -- caller treats null as unreadable
	}
	return null;
}

/**
 * Append one validated round to the paper's protocol of the day. A file
 * that is corrupt or records a DIFFERENT paper identity (renamed PDF) is
 * never overwritten: it stays untouched with a warning and the round goes
 * to the next _2/_3 file -- the same quarantine policy as the output
 * collision suffixes. Writing is not atomic; a crash mid-write corrupts
 * at most one day file, which this fallback then quarantines.
 */
export function appendChatRound(
	root: string,
	paper: ChatPaper,
	round: ChatRound,
	deps: ChatLogDeps,
	onWarn: (message: string) => void,
): { path: string; roundNumber: number } {
	const date = round.asked.slice(0, 10);
	for (let suffix = 0; ; suffix = suffix < 2 ? 2 : suffix + 1) {
		const path = chatLogPath(root, date, paper.base, suffix);
		if (!deps.exists(path)) {
			const protocol: ChatProtocol = {
				schema: CHAT_SCHEMA,
				base: paper.base,
				paper: {
					key: paper.key,
					title: paper.title,
					authors: paper.authors,
					year: paper.year,
					doi: paper.doi,
					arxiv_id: paper.arxiv_id,
				},
				date,
				rounds: [round],
			};
			deps.write(path, JSON.stringify(protocol, null, 2) + "\n");
			return { path, roundNumber: 1 };
		}
		const existing = parseProtocol(deps.read(path));
		if (existing && existing.paper.key === paper.key) {
			existing.rounds.push(round);
			deps.write(path, JSON.stringify(existing, null, 2) + "\n");
			return { path, roundNumber: existing.rounds.length };
		}
		onWarn(`chat protocol ${path} is ${existing ? "for a different paper" : "not readable"}`
			+ " -- keeping it untouched, continuing in a new file");
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The protocol rounds of ONE pi session for this paper (user decision
 * 2026-07-21: reports cover only the current session; earlier sessions stay
 * on disk as ground truth but are never re-surfaced). The scan still spans
 * all day files -- /resume keeps the session id, so "chat on Tuesday, report
 * on Wednesday" works within the resumed session. Filenames are matched with
 * an anchored pattern so report sidecars and other papers sharing a name
 * prefix are never ingested; files recording a different paper identity are
 * skipped with a warning. Without a session id nothing matches.
 */
export function loadChatRounds(
	root: string,
	base: string,
	paperKey: string,
	session: string | null,
	deps: ChatLogDeps,
	onWarn: (message: string) => void,
): { rounds: ChatRound[]; files: string[] } {
	if (!session) return { rounds: [], files: [] };
	const dir = join(root, "chats");
	const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}_${escapeRegExp(base)}(_\\d+)?\\.json$`);
	const names = deps.list(dir).filter((name) => pattern.test(name)).sort();
	const rounds: ChatRound[] = [];
	const files: string[] = [];
	for (const name of names) {
		const path = join(dir, name);
		const protocol = parseProtocol(deps.read(path));
		if (!protocol) {
			onWarn(`skipping unreadable chat protocol ${path}`);
			continue;
		}
		if (protocol.paper.key !== paperKey) {
			onWarn(`skipping ${path}: it records a different paper identity`);
			continue;
		}
		const ofSession = protocol.rounds.filter((round) => round.session === session);
		if (!ofSession.length) continue;
		rounds.push(...ofSession);
		files.push(path);
	}
	return { rounds, files };
}

/* ------------------------------------------------------------------ *
 * Orchestration                                                       *
 * ------------------------------------------------------------------ */

export interface ChatOptions {
	question: string;
	/** PDF filename in the library (basename, with or without .pdf). */
	paper?: string;
	/** Pi session id; scopes the sticky current paper and the protocol
	 * rounds a later report will cover. Absent: no sticky, rounds are
	 * recorded session-less. */
	session?: string;
	model?: string;
	embedModel?: string;
	topK?: number;
	/** Output language of the answer; default: the language of the question. */
	language?: string;
	/** Force re-extraction and re-embedding of the paper. */
	reindex?: boolean;
	root?: string;
	onWarn?: (message: string) => void;
	signal?: AbortSignal;
}

/** Injectable persistence for the chat protocol (wired in the protocol
 * step; a no-op until then). Everything tests offline through this. */
export interface ChatLogDeps {
	read(path: string): string | null;
	write(path: string, text: string): void;
	exists(path: string): boolean;
	list(dir: string): string[];
}

export interface ChatDeps {
	/** Both optional: omitted pieces are wired from the local config. The
	 * Pi adapter injects a backend whose generate() calls the model
	 * currently selected in pi (user decision 2026-07-16), while embed()
	 * stays on the configured local embedding server. */
	corpus?: CorpusDeps;
	backend?: LlmBackend;
	/** Library scan; injectable so the orchestration tests offline. */
	library?: ChatLibraryOptions["library"];
	/** Adoption of unmatched PDFs; injectable for offline tests. */
	adopt?: ChatLibraryOptions["adopt"];
	chatLog?: ChatLogDeps;
	/** English-variant translator for retrieval (see retrieve.ts). Omitted:
	 * one small generate() call on the backend; null: variant disabled. */
	translate?: TranslateFn | null;
	/** Clock; injectable for deterministic protocol tests. */
	now?: () => Date;
}

/** The paper the answer is about -- identity from the verified record,
 * path from the filesystem scan (the only source of local PDF links). */
export interface ChatPaper {
	base: string;
	key: string;
	title: string;
	authors: string[];
	year: string | null;
	doi: string;
	arxiv_id: string;
	pdf_path: string;
	/** False for filename-only papers (no verified record): citations then
	 * carry file + page and say so -- nothing bibliographic is invented. */
	verified: boolean;
}

/** Full payload of one question round. */
export interface ChatAnswer {
	question: string;
	generated: string;
	model: string;
	embedding_model: string;
	backend: string;
	top_k: number;
	grounded: boolean;
	/** Validated prose with paper-level [n] markers. */
	prose: string;
	references: ReferenceEntry[];
	/** Retrieval trail: every excerpt that was in the prompt. */
	chunks: Array<{ id: number; page: number; score: number; text: string; lexical?: boolean }>;
	/** Queries of the ONE embed call (original + disclosed English variant). */
	query_variants: QueryVariant[];
	/** Salient terms the lexical layer exact-matched over the chunk texts. */
	lexical_terms: string[];
	/** Excerpts in the prompt only because a term matched exactly. */
	lexical_added: number;
	invalid_markers: string[];
	unmarked_sentences: number;
	stripped_reference_section: boolean;
	/** Chunks dropped by the context-budget guard (lowest-ranked first). */
	trimmed_chunks: number;
	paper: ChatPaper;
	/** Loose PDFs that gained a verified identity this run. */
	adopted_pdfs: string[];
	adoption_failures: Array<{ file: string; reason: string }>;
	extraction_failures: ExtractionFailure[];
	/** Untouched generator output, kept for inspection. */
	raw_output: string;
	/** Where this round was appended; null when persistence failed. */
	protocol_path: string | null;
	/** 1-based round number within the protocol file; 0 when not persisted. */
	round: number;
}

export async function runChat(options: ChatOptions, deps?: ChatDeps): Promise<ChatAnswer> {
	const onWarn = options.onWarn ?? (() => {});
	const question = options.question.trim();
	if (!question) throw new Error("empty question");
	const root = options.root ?? outputRoot();
	const cfg = llmConfig();
	const model = options.model?.trim() || chatModel();
	const embedModel = options.embedModel?.trim() || cfg.embedModel;
	const topK = Math.max(1, Math.min(options.topK ?? DEFAULT_TOP_K, MAX_TOP_K));
	const backend = deps?.backend ?? createBackend({ ...cfg, generateModel: model, embedModel });
	const corpus = deps?.corpus ?? realCorpusDeps((texts, signal) => backend.embed(texts, signal));
	const chatLog = deps?.chatLog ?? realChatLogDeps();

	// 1. Library (loose PDFs get an adoption attempt; whatever stays
	// unverified remains choosable by filename), then the ONE paper --
	// named, or the session's sticky current paper.
	const { match, adopted, adoptionFailures } = await ensureChatLibrary(root, onWarn, {
		library: deps?.library,
		adopt: deps?.adopt,
		signal: options.signal,
	});
	const pool = chatPool(match);
	if (!pool.length) {
		throw new Error("no PDFs in the library -- run a search and fetch first, or start pi in the folder holding the PDFs");
	}
	const session = options.session?.trim() || null;
	const wanted = options.paper?.trim() || readCurrentPaper(root, session, chatLog) || "";
	const paper = selectPaper(pool, wanted);
	if (paper.key.startsWith(FILE_KEY_PREFIX)) {
		onWarn(`${paper.base}.pdf has no verified bibliographic record -- citations identify it by filename and page only`);
	}

	// 2. Index for this paper only (cached after the first question), then
	// the question vector.
	const { indexes, failures } = await ensureIndexed([paper], join(root, "index"), embedModel, corpus, {
		force: options.reindex,
		onProgress: onWarn,
		signal: options.signal,
	});
	if (!indexes.length) {
		throw new Error(
			`${paper.base}.pdf has no extractable text -- nothing to answer from`
			+ (failures.length ? ` (${failures[0].reason})` : ""),
		);
	}
	if (options.signal?.aborted) throw new Error("paper chat aborted by the user");

	// 3. Retrieval WITHIN the paper (query variants + lexical layer, see
	// retrieve.ts) + context-budget guard.
	const translate = deps?.translate !== undefined ? deps.translate : translateViaBackend(backend, model);
	const retrieval = await retrieve({
		queries: [question],
		indexes,
		perQueryK: topK,
		cap: topK,
		embed: (texts, signal) => corpus.embed(texts, signal),
		translate,
		onWarn,
		signal: options.signal,
	});
	let retrieved = retrieval.chunks;
	let prompt = buildChatPrompt(question, retrieved, options.language);
	let trimmed = 0;
	const budget = NUM_CTX - OUTPUT_RESERVE_TOKENS;
	while (retrieved.length > 1 && promptTokens(prompt) > budget) {
		retrieved = retrieved.slice(0, -1).map((chunk, i) => ({ ...chunk, id: i + 1 }));
		prompt = buildChatPrompt(question, retrieved, options.language);
		trimmed++;
	}
	if (trimmed) onWarn(`context budget: dropped the ${trimmed} lowest-ranked chunk(s) to fit ${NUM_CTX} tokens`);

	// 4. ONE generation pass; untrusted prose from here on.
	if (options.signal?.aborted) throw new Error("paper chat aborted by the user");
	onWarn(`generating with ${model} (${retrieved.length} excerpts from ${paper.base}.pdf)`);
	// think:false -- excerpt-grounded answers need no hidden reasoning; a
	// thinking model would burn the output budget on it (Ollama dialect
	// only; the OpenAI dialect and the pi backend ignore the field).
	const generateOptions: GenerateOptions = { model, numCtx: NUM_CTX, temperature: ASK_TEMPERATURE, think: false };
	const rawOutput = await backend.generate(prompt.system, prompt.user, generateOptions, options.signal);
	requireOutput(rawOutput);

	// 5. Trust gate: validate markers, references from the verified record.
	const scan = enforceCitations(rawOutput, retrieved.length);
	if (scan.invalidMarkers.length) {
		onWarn(`stripped ${scan.invalidMarkers.length} invalid citation marker(s): ${scan.invalidMarkers.join(" ")}`);
	}
	if (scan.strippedReferenceSection) {
		onWarn("the model wrote its own reference section; it was cut (references come from verified records only)");
	}
	const { prose, references } = buildReferences(scan.text, retrieved);

	const now = deps?.now ?? (() => new Date());
	const generated = now().toISOString();
	const chatPaper: ChatPaper = {
		base: paper.base,
		key: paper.key,
		title: paper.entry.title,
		authors: paper.entry.authors ?? [],
		year: paper.entry.year ?? null,
		doi: paper.entry.doi,
		arxiv_id: paper.entry.arxiv_id,
		pdf_path: paper.file,
		verified: !paper.key.startsWith(FILE_KEY_PREFIX),
	};
	const chunkTrail = retrieved.map((chunk) => ({
		id: chunk.id,
		page: chunk.page,
		score: Number(chunk.score.toFixed(4)),
		text: chunk.text,
		...(chunk.lexical ? { lexical: true } : {}),
	}));

	// 6. Persist the validated round. A write failure must never lose the
	// answer -- it degrades to a warning and protocol_path stays null.
	const citedIds = new Set(references.flatMap((reference) => reference.chunk_ids));
	const chatRound: ChatRound = {
		asked: generated,
		question,
		language: options.language?.trim() || null,
		model,
		session,
		top_k: topK,
		grounded: references.length > 0,
		prose,
		references,
		cited_chunks: chunkTrail.filter((chunk) => citedIds.has(chunk.id)),
		invalid_markers: scan.invalidMarkers,
		unmarked_sentences: scan.unmarkedSentences,
		stripped_reference_section: scan.strippedReferenceSection,
	};
	let protocolPath: string | null = null;
	let roundNumber = 0;
	try {
		const appended = appendChatRound(root, chatPaper, chatRound, chatLog, onWarn);
		protocolPath = appended.path;
		roundNumber = appended.roundNumber;
	} catch (error) {
		onWarn(`could not persist the chat round: ${error instanceof Error ? error.message : error}`
			+ " -- the answer itself is unaffected");
	}
	// Sticky selection: the next call of THIS session without a paper name
	// means this paper.
	writeCurrentPaper(root, paper.base, session, chatLog, onWarn);

	return {
		question,
		generated,
		model,
		embedding_model: embedModel,
		backend: backend.label ?? `${cfg.api} at ${cfg.baseUrl}`,
		top_k: topK,
		grounded: references.length > 0,
		prose,
		references,
		chunks: chunkTrail,
		query_variants: retrieval.variants,
		lexical_terms: retrieval.lexical_terms,
		lexical_added: retrieval.lexical_added,
		invalid_markers: scan.invalidMarkers,
		unmarked_sentences: scan.unmarkedSentences,
		stripped_reference_section: scan.strippedReferenceSection,
		trimmed_chunks: trimmed,
		paper: chatPaper,
		adopted_pdfs: adopted,
		adoption_failures: adoptionFailures,
		extraction_failures: failures,
		raw_output: rawOutput,
		protocol_path: protocolPath,
		round: roundNumber,
	};
}

/* ------------------------------------------------------------------ *
 * Report mode -- grounded summary from the session's questions         *
 * ------------------------------------------------------------------ */

export interface ChatReportOptions {
	/** Optional extra focus, added to the session's questions. */
	question?: string;
	/** PDF filename in the library (basename, with or without .pdf). */
	paper?: string;
	/** Pi session id; the report covers ONLY this session's rounds (and the
	 * sticky paper of this session). Absent: no rounds, default question. */
	session?: string;
	model?: string;
	embedModel?: string;
	/** Output language of the prose; default: the language of the questions. */
	language?: string;
	reindex?: boolean;
	root?: string;
	onWarn?: (message: string) => void;
	signal?: AbortSignal;
}

/** Full report payload; written as the JSON sidecar next to the HTML. */
export interface ChatReport {
	/** "Paper chat report: <base>.pdf" -- drives the output filename, whose
	 * slug therefore always starts with Paper_chat_report_ and can never
	 * collide with a protocol file name. */
	question: string;
	focus: string | null;
	/** Deduplicated questions of the session, in the order first asked. */
	session_questions: string[];
	generated: string;
	model: string;
	embedding_model: string;
	backend: string;
	grounded: boolean;
	prose: string;
	references: ReferenceEntry[];
	chunks: Array<{ id: number; page: number; score: number; text: string; lexical?: boolean }>;
	/** Queries of the ONE embed call (originals + disclosed English variants). */
	query_variants: QueryVariant[];
	/** Salient terms the lexical layer exact-matched over the chunk texts. */
	lexical_terms: string[];
	/** Excerpts in the prompt only because a term matched exactly. */
	lexical_added: number;
	invalid_markers: string[];
	unmarked_sentences: number;
	stripped_reference_section: boolean;
	trimmed_chunks: number;
	paper: ChatPaper;
	/** The session's validated rounds, verbatim (report appendix). */
	rounds: ChatRound[];
	protocol_files: string[];
	adopted_pdfs: string[];
	adoption_failures: Array<{ file: string; reason: string }>;
	extraction_failures: ExtractionFailure[];
	/** Untouched generator output, kept for inspection (sidecar only). */
	raw_output: string;
}

/**
 * Grounded summary of ONE paper, built from the code-validated protocol
 * (never from the Pi chat transcript): the CURRENT session's questions
 * become the retrieval queries, the union of their best excerpts becomes
 * the context, and the same citation gate validates the prose. Rounds of
 * earlier sessions stay on disk but are never re-surfaced (user decision
 * 2026-07-21). Does NOT append to the protocol -- a report is an output,
 * not a round.
 */
export async function runChatReport(options: ChatReportOptions, deps?: ChatDeps): Promise<ChatReport> {
	const onWarn = options.onWarn ?? (() => {});
	const root = options.root ?? outputRoot();
	const cfg = llmConfig();
	const model = options.model?.trim() || chatModel();
	const embedModel = options.embedModel?.trim() || cfg.embedModel;
	const backend = deps?.backend ?? createBackend({ ...cfg, generateModel: model, embedModel });
	const corpus = deps?.corpus ?? realCorpusDeps((texts, signal) => backend.embed(texts, signal));

	// 1. The ONE paper (named, or the sticky current paper), then its
	// session protocol.
	const { match, adopted, adoptionFailures } = await ensureChatLibrary(root, onWarn, {
		library: deps?.library,
		adopt: deps?.adopt,
		signal: options.signal,
	});
	const pool = chatPool(match);
	if (!pool.length) {
		throw new Error("no PDFs in the library -- run a search and fetch first, or start pi in the folder holding the PDFs");
	}
	const chatLog = deps?.chatLog ?? realChatLogDeps();
	const session = options.session?.trim() || null;
	const wanted = options.paper?.trim() || readCurrentPaper(root, session, chatLog) || "";
	const paper = selectPaper(pool, wanted);
	if (paper.key.startsWith(FILE_KEY_PREFIX)) {
		onWarn(`${paper.base}.pdf has no verified bibliographic record -- citations identify it by filename and page only`);
	}
	const { rounds, files: protocolFiles } = loadChatRounds(root, paper.base, paper.key, session, chatLog, onWarn);

	// 2. Retrieval queries: the session's questions (deduplicated, order
	// kept) plus the optional focus; the default question when both are
	// empty, so "report without prior chat" still works.
	const sessionQuestions: string[] = [];
	for (const round of rounds) {
		if (!sessionQuestions.includes(round.question)) sessionQuestions.push(round.question);
	}
	const focus = options.question?.trim() || null;
	const queries = [...sessionQuestions];
	if (focus && !queries.includes(focus)) queries.push(focus);
	if (!queries.length) {
		queries.push(DEFAULT_REPORT_QUESTION);
		onWarn("no chat rounds recorded for this session -- reporting on the default question");
	}

	// 3. Index, then ONE embed call for all queries.
	const { indexes, failures } = await ensureIndexed([paper], join(root, "index"), embedModel, corpus, {
		force: options.reindex,
		onProgress: onWarn,
		signal: options.signal,
	});
	if (!indexes.length) {
		throw new Error(
			`${paper.base}.pdf has no extractable text -- nothing to report on`
			+ (failures.length ? ` (${failures[0].reason})` : ""),
		);
	}
	if (options.signal?.aborted) throw new Error("paper chat report aborted by the user");

	// 4. Shared retrieval over all session questions (variants + lexical
	// layer, one embed call; see retrieve.ts) + context-budget guard.
	const translate = deps?.translate !== undefined ? deps.translate : translateViaBackend(backend, model);
	const retrieval = await retrieve({
		queries,
		indexes,
		perQueryK: REPORT_PER_QUESTION_K,
		cap: REPORT_MAX_CHUNKS,
		embed: (texts, signal) => corpus.embed(texts, signal),
		translate,
		onWarn,
		signal: options.signal,
	});
	let retrieved = retrieval.chunks;
	let prompt = buildReportPrompt(queries, retrieved, options.language);
	let trimmed = 0;
	const budget = NUM_CTX - OUTPUT_RESERVE_TOKENS;
	while (retrieved.length > 1 && promptTokens(prompt) > budget) {
		retrieved = retrieved.slice(0, -1).map((chunk, i) => ({ ...chunk, id: i + 1 }));
		prompt = buildReportPrompt(queries, retrieved, options.language);
		trimmed++;
	}
	if (trimmed) onWarn(`context budget: dropped the ${trimmed} lowest-ranked chunk(s) to fit ${NUM_CTX} tokens`);

	// 5. ONE generation pass, then the same trust gate as every answer.
	if (options.signal?.aborted) throw new Error("paper chat report aborted by the user");
	onWarn(`generating the report with ${model} (${retrieved.length} excerpts, ${queries.length} question(s))`);
	// think:false -- excerpt-grounded answers need no hidden reasoning; a
	// thinking model would burn the output budget on it (Ollama dialect
	// only; the OpenAI dialect and the pi backend ignore the field).
	const generateOptions: GenerateOptions = { model, numCtx: NUM_CTX, temperature: ASK_TEMPERATURE, think: false };
	const rawOutput = await backend.generate(prompt.system, prompt.user, generateOptions, options.signal);
	requireOutput(rawOutput);
	const scan = enforceCitations(rawOutput, retrieved.length);
	if (scan.invalidMarkers.length) {
		onWarn(`stripped ${scan.invalidMarkers.length} invalid citation marker(s): ${scan.invalidMarkers.join(" ")}`);
	}
	if (scan.strippedReferenceSection) {
		onWarn("the model wrote its own reference section; it was cut (references come from verified records only)");
	}
	const { prose, references } = buildReferences(scan.text, retrieved);

	const now = deps?.now ?? (() => new Date());
	return {
		question: `Paper chat report: ${paper.base}.pdf`,
		focus,
		session_questions: sessionQuestions,
		generated: now().toISOString(),
		model,
		embedding_model: embedModel,
		backend: backend.label ?? `${cfg.api} at ${cfg.baseUrl}`,
		grounded: references.length > 0,
		prose,
		references,
		chunks: retrieved.map((chunk) => ({
			id: chunk.id,
			page: chunk.page,
			score: Number(chunk.score.toFixed(4)),
			text: chunk.text,
			...(chunk.lexical ? { lexical: true } : {}),
		})),
		query_variants: retrieval.variants,
		lexical_terms: retrieval.lexical_terms,
		lexical_added: retrieval.lexical_added,
		invalid_markers: scan.invalidMarkers,
		unmarked_sentences: scan.unmarkedSentences,
		stripped_reference_section: scan.strippedReferenceSection,
		trimmed_chunks: trimmed,
		paper: {
			base: paper.base,
			key: paper.key,
			title: paper.entry.title,
			authors: paper.entry.authors ?? [],
			year: paper.entry.year ?? null,
			doi: paper.entry.doi,
			arxiv_id: paper.entry.arxiv_id,
			pdf_path: paper.file,
			verified: !paper.key.startsWith(FILE_KEY_PREFIX),
		},
		rounds,
		protocol_files: protocolFiles,
		adopted_pdfs: adopted,
		adoption_failures: adoptionFailures,
		extraction_failures: failures,
		raw_output: rawOutput,
	};
}
