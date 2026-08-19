/**
 * Synthesis engine: grounded answers and reports from the local, verified
 * PDF library (retrieval-augmented generation sized for a 10-100 paper
 * corpus on a local GPU). Shared by the pi tool/command and the CLI.
 *
 * Entry points: runRound (one question, one or several papers, persisted
 * as a protocol round), runChatReport (session summary of one paper) and
 * runReport (composable report: summaries, detail questions, review). All
 * share the same chain: match library -> ensure embedding index -> retrieval (query
 * variants + embedding union + lexical layer, retrieve.ts) -> ONE
 * generation pass -> deterministic citation enforcement -> paper-level
 * references.
 *
 * THE ONE INVIOLABLE RULE, enforced structurally here: the generator sees
 * numbered excerpts and may cite ONLY by bracketed numbers. Its raw output
 * is untrusted prose; the only thing this code accepts from it are those
 * numbers. Every number outside the provided set is stripped and reported;
 * a model-written reference section is cut and reported. All bibliographic
 * data in the result comes from the verified search records. A run whose
 * output contains zero valid citations is marked grounded:false and must
 * not be used as a review.
 */

import { join } from "node:path";

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
	unmatchedGroups,
} from "./corpus.ts";
import { phraseOf } from "./extract.ts";
import { createBackend, type GenerateOptions, type LlmBackend } from "./llm.ts";
import { outputRoot } from "./output.ts";
import {
	appendRound,
	type CitationSite,
	loadRounds,
	type PaperIdentity,
	type ProtocolDeps,
	readCurrentScope,
	realProtocolDeps,
	type Round,
	singlePaperOf,
	writeCurrentScope,
} from "./protocol.ts";
import {
	type QueryVariant,
	retrieve,
	type RetrievedChunk,
	type TranslateFn,
	translateViaBackend,
} from "./retrieve.ts";

// Retrieval primitives live in retrieve.ts; re-exported so importers and
// tests keep one stable surface.
export {
	cosine,
	type QueryVariant,
	type RetrievedChunk,
	topKChunks,
	unionChunks,
} from "./retrieve.ts";

/** Context window requested from the backend (Ollama defaults to ~4k and
 * silently truncates -- it MUST be set explicitly). */
export const NUM_CTX = 8192;
/** Tokens kept free for the generated answer. */
export const OUTPUT_RESERVE_TOKENS = 1024;
/** Deterministic char->token estimate for the budget guard. */
const CHARS_PER_TOKEN = 4;
export const DEFAULT_TOP_K = 8;
export const MAX_TOP_K = 20;
/** Low sampling temperature for every genre; tone comes from the prompt. */
const TEMPERATURE = 0.2;

/**
 * Guard against an EMPTY generation: a thinking model can spend its whole
 * token budget on hidden reasoning and return no answer text, which would
 * otherwise flow through the citation gate as an empty "ungrounded draft".
 * An empty output is a backend failure, not a groundable answer; fail
 * loudly with the likely cause and the ways out.
 */
export function requireOutput(rawOutput: string): void {
	if (rawOutput.trim()) return;
	throw new Error(
		"the generator returned no answer text -- a thinking model may have spent its entire "
		+ "token budget on hidden reasoning. Ask again (thinking length varies), rephrase the "
		+ "question, or switch to a non-thinking model",
	);
}

/* ------------------------------------------------------------------ *
 * Prompt -- pure                                                      *
 * ------------------------------------------------------------------ */

/** The grounding contract. Kept as one visible constant: this is the only
 * instruction the generator ever gets. */
export function systemPrompt(language: string): string {
	return [
		"You are writing a short grounded synthesis for a scientific literature review.",
		"You are given numbered source excerpts [1]..[k]. Rules:",
		"- Use ONLY information from the excerpts. If they do not answer the question, say so plainly.",
		"- After every claim taken from an excerpt, put its number in brackets, e.g. [3].",
		"  Multiple sources: [1][4]. Use ONLY numbers that appear in the given excerpts.",
		"- NEVER write author names, years, paper titles, DOIs, or a reference list.",
		"  The reference list is added by software afterwards. Do not add a heading like \"References\".",
		`- Write in ${language}. Be concise and factual; no speculation beyond the excerpts.`,
	].join("\n");
}

export function buildPrompt(
	question: string,
	chunks: RetrievedChunk[],
	language?: string,
): { system: string; user: string } {
	const blocks = chunks.map((chunk) => `[${chunk.id}] (source ${chunk.id})\n${chunk.text}`);
	return {
		system: systemPrompt(language?.trim() || "the language of the question"),
		user: `Question: ${question}\n\nSource excerpts:\n\n${blocks.join("\n\n")}`,
	};
}

/** Estimated prompt size in tokens, for the context-budget guard. */
export function promptTokens(prompt: { system: string; user: string }): number {
	return Math.ceil((prompt.system.length + prompt.user.length) / CHARS_PER_TOKEN);
}

/* ------------------------------------------------------------------ *
 * Citation enforcement -- pure, the trust gate of this stage           *
 * ------------------------------------------------------------------ */

export interface CitationScan {
	/** Prose with ONLY validated chunk-level markers left in. */
	text: string;
	/** Chunk ids in order of first citation. */
	citedChunkIds: number[];
	/** Markers that named non-existent excerpts; stripped from the text. */
	invalidMarkers: string[];
	/** Sentences carrying no marker (connective prose; disclosed, kept). */
	unmarkedSentences: number;
	/** True when a model-written reference section was cut off. */
	strippedReferenceSection: boolean;
}

export function enforceCitations(raw: string, chunkCount: number): CitationScan {
	let text = raw.trim();
	// A model-written reference list is fabrication by definition (the rule:
	// references come from code). Cut it and say so.
	const refHeading = /\n\s*(?:#+\s*|\*\*)?(?:references|bibliography|reference list|literaturverzeichnis|quellen)\b[\s\S]*$/i;
	const strippedReferenceSection = refHeading.test(text);
	if (strippedReferenceSection) text = text.replace(refHeading, "").trimEnd();

	const invalidMarkers: string[] = [];
	// Normalize list forms [1, 3] / [1;3] into adjacent single markers.
	text = text.replace(/\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})+)\]/g, (_match, list: string) =>
		list.split(/[,;]/).map((part) => `[${part.trim()}]`).join(""));
	// Expand valid ranges [2-4]; an impossible range is one invalid marker.
	text = text.replace(/\[(\d{1,3})\s*[-–]\s*(\d{1,3})\]/g, (match, a: string, b: string) => {
		const start = Number.parseInt(a, 10);
		const end = Number.parseInt(b, 10);
		if (start >= 1 && end <= chunkCount && start <= end) {
			return Array.from({ length: end - start + 1 }, (_, i) => `[${start + i}]`).join("");
		}
		invalidMarkers.push(match);
		return "";
	});
	// Validate every single marker; collect citation order.
	const citedChunkIds: number[] = [];
	text = text.replace(/\[(\d{1,3})\]/g, (match, digits: string) => {
		const id = Number.parseInt(digits, 10);
		if (id >= 1 && id <= chunkCount) {
			if (!citedChunkIds.includes(id)) citedChunkIds.push(id);
			return `[${id}]`;
		}
		invalidMarkers.push(match);
		return "";
	});
	// Cleanup after stripping: adjacent duplicates, double spaces, orphaned
	// space before punctuation.
	text = text
		.replace(/\[(\d+)\](?:\s*\[\1\])+/g, "[$1]")
		.replace(/[^\S\n]{2,}/g, " ")
		.replace(/[^\S\n]+([.,;:!?])/g, "$1")
		.trim();

	const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
	const unmarkedSentences = sentences.filter((s) => !/\[\d+\]/.test(s)).length;

	return { text, citedChunkIds, invalidMarkers, unmarkedSentences, strippedReferenceSection };
}

/**
 * Shared tail of every generation: trim the retrieved excerpts to the
 * context budget (lowest-ranked first, ids renumbered), run ONE generation
 * pass, and push the raw output through the citation gate. Returns the
 * excerpts actually shown to the model, so the caller's trail and
 * references stay exact.
 */
async function generateGrounded(args: {
	retrieved: RetrievedChunk[];
	promptOf: (chunks: RetrievedChunk[]) => { system: string; user: string };
	backend: LlmBackend;
	model: string;
	onWarn: (message: string) => void;
	/** Status line before the generation call; receives the final excerpt count. */
	progress?: (excerpts: number) => string;
	abortMessage: string;
	signal?: AbortSignal;
}): Promise<{ retrieved: RetrievedChunk[]; trimmed: number; rawOutput: string; scan: CitationScan }> {
	let retrieved = args.retrieved;
	let prompt = args.promptOf(retrieved);
	let trimmed = 0;
	const budget = NUM_CTX - OUTPUT_RESERVE_TOKENS;
	while (retrieved.length > 1 && promptTokens(prompt) > budget) {
		retrieved = retrieved.slice(0, -1).map((chunk, i) => ({ ...chunk, id: i + 1 }));
		prompt = args.promptOf(retrieved);
		trimmed++;
	}
	if (trimmed) args.onWarn(`context budget: dropped the ${trimmed} lowest-ranked chunk(s) to fit ${NUM_CTX} tokens`);
	if (args.signal?.aborted) throw new Error(args.abortMessage);
	if (args.progress) args.onWarn(args.progress(retrieved.length));
	// think:false -- excerpt-grounded answers need no hidden reasoning; a
	// thinking model would burn the output budget on it (Ollama dialect
	// only; the OpenAI dialect and the pi backend ignore the field).
	const generateOptions: GenerateOptions = { model: args.model, numCtx: NUM_CTX, temperature: TEMPERATURE, think: false };
	const rawOutput = await args.backend.generate(prompt.system, prompt.user, generateOptions, args.signal);
	requireOutput(rawOutput);
	const scan = enforceCitations(rawOutput, retrieved.length);
	if (scan.invalidMarkers.length) {
		args.onWarn(`stripped ${scan.invalidMarkers.length} invalid citation marker(s): ${scan.invalidMarkers.join(" ")}`);
	}
	if (scan.strippedReferenceSection) {
		args.onWarn("the model wrote its own reference section; it was cut (references come from verified records only)");
	}
	return { retrieved, trimmed, rawOutput, scan };
}

/* ------------------------------------------------------------------ *
 * Paper-level references -- pure                                       *
 * ------------------------------------------------------------------ */

export interface ReferenceEntry {
	/** Display number in the final prose ([1]..[P], first-citation order). */
	n: number;
	key: string;
	title: string;
	authors: string[];
	year: string | null;
	doi: string;
	arxiv_id: string;
	/** Pages of the cited excerpts (evidence trail). */
	pages: number[];
	/** Prompt excerpt numbers this reference rests on. */
	chunk_ids: number[];
	/** Local PDF of the cited paper -- a code-constructed library path (the
	 * trust boundary of localPdfHref), never model or API text. Absent when
	 * the caller knows no path. */
	pdf_path?: string;
}

/**
 * FALLBACK search phrase for the PDF #search fragment: the first run of at
 * least 3 CONSECUTIVE words containing only letters/digits (capped at 5).
 * Deliberately timid, because it is a guess: the viewer's phrase search
 * matches the text layer verbatim, so a single comma inside the snippet
 * would kill the match. Chunks indexed by the current code carry
 * phrase_words (a length MEASURED against the viewer's text layer) and
 * highlightPhrase() prefers that; this guess still serves chunks from
 * older indexes and hand-built fixtures. Lives here because the snippet is
 * citation provenance (persisted in CitationSite), not a rendering detail.
 */
export function searchSnippet(text: string): string | null {
	const words = text.replace(/\[\d+\]/g, " ").split(/\s+/).filter(Boolean);
	let run: string[] = [];
	for (const word of words) {
		if (/^[\p{L}\p{N}]+$/u.test(word)) {
			run.push(word);
			if (run.length === 5) break;
		} else if (run.length >= 3) {
			break; // first usable run wins -- deterministic
		} else {
			run = [];
		}
	}
	const snippet = run.join(" ");
	return run.length >= 3 && snippet.length >= 15 ? snippet : null;
}

/**
 * The phrase a PDF link may highlight for one excerpt: the span VERIFIED
 * against the raw text layer when the chunk was indexed, else the timid
 * searchSnippet guess. One place, so every link -- citation superscript
 * and evidence trail alike -- highlights the same text.
 */
export function highlightPhrase(chunk: { text: string; phrase_words?: number }): string | null {
	return phraseOf(chunk.text, chunk.phrase_words) ?? searchSnippet(chunk.text);
}

/**
 * Renumber validated chunk-level markers to paper-level reference numbers
 * (several excerpts of one paper become ONE reference), build the
 * reference list -- exclusively from the verified paper records carried by
 * the retrieved chunks -- and record one CitationSite per surviving marker
 * in document order: the exact chunk (page, snippet) behind every number
 * the reader sees. This is the only place the final citation numbers are
 * produced, and no model output flows into any field but the marker
 * positions themselves.
 *
 * Collapse rule: adjacent markers merge ONLY when they cite the same CHUNK
 * (a same-paper collapse would destroy the page targets -- [page 4][page
 * 18] becoming one number pointing nowhere specific); the cost is more
 * visible markers.
 *
 * Invariant (tested): the number of markers in the returned prose equals
 * sites.length.
 */
export function buildCitations(
	text: string,
	chunks: RetrievedChunk[],
	pdfPathByKey?: Map<string, string>,
): { prose: string; references: ReferenceEntry[]; sites: CitationSite[] } {
	const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
	const references: ReferenceEntry[] = [];
	const numberByKey = new Map<string, number>();
	const sites: CitationSite[] = [];
	let prose = "";
	let cursor = 0;
	let lastChunkId: number | null = null;
	for (const match of text.matchAll(/\[(\d+)\]/g)) {
		const between = text.slice(cursor, match.index);
		cursor = match.index + match[0].length;
		const chunk = byId.get(Number.parseInt(match[1], 10));
		if (!chunk) { // cannot happen after enforceCitations
			prose += between + match[0];
			lastChunkId = null;
			continue;
		}
		if (between.trim()) lastChunkId = null;
		if (lastChunkId === chunk.id) continue; // same chunk back-to-back: one marker
		prose += between;
		let n = numberByKey.get(chunk.paper.key);
		if (n === undefined) {
			n = references.length + 1;
			numberByKey.set(chunk.paper.key, n);
			references.push({
				n,
				key: chunk.paper.key,
				title: chunk.paper.title,
				authors: chunk.paper.authors,
				year: chunk.paper.year,
				doi: chunk.paper.doi,
				arxiv_id: chunk.paper.arxiv_id,
				pages: [],
				chunk_ids: [],
				...(pdfPathByKey?.has(chunk.paper.key) ? { pdf_path: pdfPathByKey.get(chunk.paper.key) } : {}),
			});
		}
		const entry = references[n - 1];
		if (!entry.chunk_ids.includes(chunk.id)) {
			entry.chunk_ids.push(chunk.id);
			if (!entry.pages.includes(chunk.page)) {
				entry.pages.push(chunk.page);
				entry.pages.sort((a, b) => a - b);
			}
		}
		prose += `[${n}]`;
		sites.push({
			ref: n,
			chunk_id: chunk.id,
			paper_key: chunk.paper.key,
			page: chunk.page,
			snippet: highlightPhrase(chunk),
		});
		lastChunkId = chunk.id;
	}
	prose += text.slice(cursor);
	return { prose, references, sites };
}

/** One grounded prose unit as assembleReport consumes it. */
export interface CitedUnit {
	prose: string;
	references: ReferenceEntry[];
	sites: CitationSite[];
}

/**
 * Merge several independently numbered units into ONE report numbering:
 * papers are numbered globally in first-citation order across units, the
 * unit prose markers and sites[].ref are rewritten accordingly, and the
 * global reference list merges pages per paper (chunk ids stay with the
 * units -- they are prompt-local). For a single unit this is the identity
 * on the prose. Pure; marker rewriting walks the markers in document
 * order, mirrored one-to-one by the unit's sites (the buildCitations
 * invariant), so no text is ever interpreted beyond the validated markers.
 */
export function assembleReport<T extends CitedUnit>(units: T[]): { units: T[]; references: ReferenceEntry[] } {
	const references: ReferenceEntry[] = [];
	const numberByKey = new Map<string, number>();
	const globalOf = (local: ReferenceEntry): number => {
		let n = numberByKey.get(local.key);
		if (n === undefined) {
			n = references.length + 1;
			numberByKey.set(local.key, n);
			references.push({ ...local, n, chunk_ids: [], pages: [...local.pages] });
		} else {
			const entry = references[n - 1];
			for (const page of local.pages) {
				if (!entry.pages.includes(page)) entry.pages.push(page);
			}
			entry.pages.sort((a, b) => a - b);
			if (!entry.pdf_path && local.pdf_path) entry.pdf_path = local.pdf_path;
		}
		return n;
	};
	const rewritten = units.map((unit) => {
		const byLocalN = new Map(unit.references.map((entry) => [entry.n, globalOf(entry)]));
		let index = 0;
		const prose = unit.prose.replace(/\[(\d+)\]/g, (match, digits: string) => {
			const site = unit.sites[index++];
			const global = byLocalN.get(Number.parseInt(digits, 10));
			return site && global !== undefined ? `[${global}]` : match;
		});
		return {
			...unit,
			prose,
			sites: unit.sites.map((site) => ({ ...site, ref: byLocalN.get(site.ref) ?? site.ref })),
		};
	});
	return { units: rewritten, references };
}

/* ================================================================== *
 * Round & session-report engine: grounded Q&A rounds (runRound) and   *
 * the session report (runChatReport) share retrieval, citation gate   *
 * and protocol with the composable report (runReport) below.          *
 * ================================================================== */

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
export function answerSystemPrompt(language: string, multi = false): string {
	return [
		multi
			? "You are helping a reader understand a SET of scientific papers by answering their question about them."
			: "You are helping a reader understand ONE scientific paper by answering their question about it.",
		multi
			? "You are given numbered source excerpts [1]..[k] from those papers. Rules:"
			: "You are given numbered source excerpts [1]..[k] from that paper. Rules:",
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
	multi = false,
): { system: string; user: string } {
	const blocks = chunks.map((chunk) => `[${chunk.id}] (source ${chunk.id})\n${chunk.text}`);
	return {
		system: answerSystemPrompt(language?.trim() || "the language of the question", multi),
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
 * PDFs without a record (every PDF in the folder must be choosable; when no
 * metadata exists, citations honestly carry filename and page -- nothing
 * bibliographic is ever invented). Pure.
 */
export function chatPool(match: LibraryMatch): LibraryPaper[] {
	// Unmatched files may live in different folders (library + loose PDFs
	// in the cwd) -- each entry keeps its own path.
	const unverified = unmatchedGroups(match).flatMap(({ dir, files }) => files.map((file) => {
		const base = file.replace(/\.pdf$/i, "");
		return {
			file: join(dir, file),
			base,
			key: `${FILE_KEY_PREFIX}${base}`,
			entry: { title: "", pdf_url: "", doi: "", arxiv_id: "", authors: [], year: null },
		};
	}));
	return [...match.matched, ...unverified];
}

function availablePapers(matched: LibraryPaper[]): string {
	return matched.map((paper) => `${paper.base}.pdf`).join(", ") || "(none)";
}

/**
 * Protocol identity (file base + record key) of a scope, matching what
 * runRound records: a single paper uses the paper's own identity, several
 * papers the sorted-member scope identity, the library its fixed marker.
 * Pure; null when a named single paper is not in the pool. Exported so
 * the adapter can look up THIS session's asked questions for a scope
 * (report-wizard seed) without duplicating the naming rules.
 */
export function scopeProtocolId(
	scope: string[] | "library",
	pool: LibraryPaper[],
): { base: string; key: string } | null {
	if (scope === "library") return { base: "library", key: "scope:library" };
	if (scope.length === 1) {
		const paper = pool.find((entry) => entry.base === scope[0]);
		return paper ? { base: paper.base, key: paper.key } : null;
	}
	const bases = [...scope].sort();
	const joined = bases.join("+");
	return {
		base: joined.length <= 60 ? `scope_${joined}` : `scope_${bases[0]}_and_${bases.length - 1}_more`,
		key: `scope:${joined}`,
	};
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
export async function ensureLibrary(
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
		// One adoption pass per folder (the corpus may span several).
		const adoptions: AdoptionResult[] = [];
		for (const group of unmatchedGroups(match)) {
			adoptions.push(...await adoptFn(group.files, group.dir));
		}
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
 * Orchestration                                                       *
 * ------------------------------------------------------------------ */

export interface ChatOptions {
	question: string;
	/** PDF filename in the library (basename, with or without .pdf). */
	paper?: string;
	/** Document scope for the round: several PDFs or the whole library. Takes precedence over paper; when both are absent the
	 * session's sticky scope decides. Multi-paper rounds retrieve across
	 * the scope and are protocolled under a scope identity. */
	papers?: string[] | "library";
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

export interface ChatDeps {
	/** Both optional: omitted pieces are wired from the local config. The
	 * pi adapter injects a backend whose generate() calls the model
	 * currently selected in pi, while embed() stays on the configured
	 * embedding server. */
	corpus?: CorpusDeps;
	backend?: LlmBackend;
	/** Library scan; injectable so the orchestration tests offline. */
	library?: ChatLibraryOptions["library"];
	/** Adoption of unmatched PDFs; injectable for offline tests. */
	adopt?: ChatLibraryOptions["adopt"];
	/** Protocol/sticky persistence (see protocol.ts); injectable for
	 * offline tests. */
	protocol?: ProtocolDeps;
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
	/** Per-marker chunk provenance in document order (one entry per marker
	 * in the prose; drives the clickable PDF superscripts). */
	sites: CitationSite[];
	/** Retrieval trail: every excerpt that was in the prompt. */
	chunks: Array<{ id: number; page: number; score: number; text: string; lexical?: boolean; phrase_words?: number }>;
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
	/** First scope paper (single-paper rounds: THE paper; kept for existing
	 * consumers). */
	paper: ChatPaper;
	/** Every paper of the round's scope (length > 1 on multi rounds). */
	papers: ChatPaper[];
	/** The scope as remembered in the sticky marker. */
	scope: string[] | "library";
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

export async function runRound(options: ChatOptions, deps?: ChatDeps): Promise<ChatAnswer> {
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
	const protocolDeps = deps?.protocol ?? realProtocolDeps();

	// 1. Library (loose PDFs get an adoption attempt; whatever stays
	// unverified remains choosable by filename), then the ONE paper --
	// named, or the session's sticky current paper.
	const { match, adopted, adoptionFailures } = await ensureLibrary(root, onWarn, {
		library: deps?.library,
		adopt: deps?.adopt,
		signal: options.signal,
	});
	const pool = chatPool(match);
	if (!pool.length) {
		throw new Error("no PDFs in the library -- run a search and fetch first, or start pi in the folder holding the PDFs");
	}
	const session = options.session?.trim() || null;
	const stickyScope = options.papers || options.paper?.trim() ? null : readCurrentScope(root, session, protocolDeps);
	const libraryScope = options.papers === "library" || stickyScope?.papers === "library";
	const scopePapers: LibraryPaper[] = libraryScope
		? pool
		: Array.isArray(options.papers)
			? options.papers.map((name) => selectPaper(pool, name))
			: options.paper?.trim()
				? [selectPaper(pool, options.paper.trim())]
				: Array.isArray(stickyScope?.papers)
					? stickyScope.papers.map((name) => selectPaper(pool, name))
					: [selectPaper(pool, "")]; // throws, listing what IS available
	const multi = scopePapers.length > 1;
	const paper = scopePapers[0];
	for (const scoped of scopePapers) {
		if (scoped.key.startsWith(FILE_KEY_PREFIX)) {
			onWarn(`${scoped.base}.pdf has no verified bibliographic record -- citations identify it by filename and page only`);
		}
	}

	// 2. Index the scope (cached after the first question), then retrieval.
	const { indexes, failures } = await ensureIndexed(scopePapers, join(root, "lit-synthesis", "index"), embedModel, corpus, {
		force: options.reindex,
		onProgress: onWarn,
		signal: options.signal,
	});
	if (!indexes.length) {
		throw new Error(
			(multi ? "no paper in the scope has extractable text" : `${paper.base}.pdf has no extractable text`)
			+ " -- nothing to answer from"
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
	// 4. ONE generation pass (budget trim, generation, citation gate);
	// untrusted prose until the gate has run.
	const { retrieved, trimmed, rawOutput, scan } = await generateGrounded({
		retrieved: retrieval.chunks,
		promptOf: (chunks) => buildChatPrompt(question, chunks, options.language, multi),
		backend,
		model,
		onWarn,
		progress: (excerpts) => `generating with ${model} (${excerpts} excerpts from `
			+ (multi ? `${scopePapers.length} documents)` : `${paper.base}.pdf)`),
		abortMessage: "paper chat aborted by the user",
		signal: options.signal,
	});

	// 5. References from the verified records only.
	const { prose, references, sites } = buildCitations(
		scan.text,
		retrieved,
		new Map(scopePapers.map((scoped) => [scoped.key, scoped.file])),
	);

	const now = deps?.now ?? (() => new Date());
	const generated = now().toISOString();
	const chatPapers: ChatPaper[] = scopePapers.map((scoped) => ({
		base: scoped.base,
		key: scoped.key,
		title: scoped.entry.title,
		authors: scoped.entry.authors ?? [],
		year: scoped.entry.year ?? null,
		doi: scoped.entry.doi,
		arxiv_id: scoped.entry.arxiv_id,
		pdf_path: scoped.file,
		verified: !scoped.key.startsWith(FILE_KEY_PREFIX),
	}));
	const chatPaper = chatPapers[0];
	const scope: string[] | "library" = libraryScope ? "library" : scopePapers.map((scoped) => scoped.base);
	const chunkTrail = retrieved.map((chunk) => ({
		id: chunk.id,
		page: chunk.page,
		score: Number(chunk.score.toFixed(4)),
		text: chunk.text,
		...(multi ? { paper_key: chunk.paper.key } : {}),
		...(chunk.lexical ? { lexical: true } : {}),
		...(chunk.phrase_words ? { phrase_words: chunk.phrase_words } : {}),
	}));

	// 6. Persist the validated round. A write failure must never lose the
	// answer -- it degrades to a warning and protocol_path stays null.
	// Multi-paper and library rounds are protocolled under a SCOPE identity;
	// the key carries the full sorted member list, so the quarantine logic
	// keeps different scopes in different files.
	const citedIds = new Set(references.flatMap((reference) => reference.chunk_ids));
	const identity: PaperIdentity = multi || libraryScope
		? {
			...scopeProtocolId(libraryScope ? "library" : scopePapers.map((scoped) => scoped.base), scopePapers)!,
			title: libraryScope ? "Whole library" : `${scopePapers.length} documents`,
			authors: [],
			year: null,
			doi: "",
			arxiv_id: "",
		}
		: chatPaper;
	const chatRound: Round = {
		asked: generated,
		question,
		language: options.language?.trim() || null,
		model,
		session,
		...(multi || libraryScope ? { scope } : {}),
		top_k: topK,
		grounded: references.length > 0,
		prose,
		references,
		sites,
		cited_chunks: chunkTrail.filter((chunk) => citedIds.has(chunk.id)),
		invalid_markers: scan.invalidMarkers,
		unmarked_sentences: scan.unmarkedSentences,
		stripped_reference_section: scan.strippedReferenceSection,
	};
	let protocolPath: string | null = null;
	let roundNumber = 0;
	try {
		const appended = appendRound(root, identity, chatRound, protocolDeps, onWarn);
		protocolPath = appended.path;
		roundNumber = appended.roundNumber;
	} catch (error) {
		onWarn(`could not persist the chat round: ${error instanceof Error ? error.message : error}`
			+ " -- the answer itself is unaffected");
	}
	// Sticky scope: the next call of THIS session without a scope means the
	// same documents.
	writeCurrentScope(root, { papers: scope }, session, protocolDeps, onWarn);

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
		sites,
		chunks: chunkTrail,
		query_variants: retrieval.variants,
		lexical_terms: retrieval.lexical_terms,
		lexical_added: retrieval.lexical_added,
		invalid_markers: scan.invalidMarkers,
		unmarked_sentences: scan.unmarkedSentences,
		stripped_reference_section: scan.strippedReferenceSection,
		trimmed_chunks: trimmed,
		paper: chatPaper,
		papers: chatPapers,
		scope,
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
	/** Per-marker chunk provenance in document order (one entry per marker
	 * in the prose; drives the clickable PDF superscripts). */
	sites: CitationSite[];
	chunks: Array<{ id: number; page: number; score: number; text: string; lexical?: boolean; phrase_words?: number }>;
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
	rounds: Round[];
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
 * earlier sessions stay on disk but are never re-surfaced. Does NOT
 * append to the protocol -- a report is an output, not a round.
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
	const { match, adopted, adoptionFailures } = await ensureLibrary(root, onWarn, {
		library: deps?.library,
		adopt: deps?.adopt,
		signal: options.signal,
	});
	const pool = chatPool(match);
	if (!pool.length) {
		throw new Error("no PDFs in the library -- run a search and fetch first, or start pi in the folder holding the PDFs");
	}
	const protocolDeps = deps?.protocol ?? realProtocolDeps();
	const session = options.session?.trim() || null;
	const wanted = options.paper?.trim() || singlePaperOf(readCurrentScope(root, session, protocolDeps)) || "";
	const paper = selectPaper(pool, wanted);
	if (paper.key.startsWith(FILE_KEY_PREFIX)) {
		onWarn(`${paper.base}.pdf has no verified bibliographic record -- citations identify it by filename and page only`);
	}
	const { rounds, files: protocolFiles } = loadRounds(root, paper.base, paper.key, session, protocolDeps, onWarn);

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
	const { indexes, failures } = await ensureIndexed([paper], join(root, "lit-synthesis", "index"), embedModel, corpus, {
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
	// 5. ONE generation pass (budget trim, generation, citation gate).
	const { retrieved, trimmed, rawOutput, scan } = await generateGrounded({
		retrieved: retrieval.chunks,
		promptOf: (chunks) => buildReportPrompt(queries, chunks, options.language),
		backend,
		model,
		onWarn,
		progress: (excerpts) => `generating the report with ${model} (${excerpts} excerpts, ${queries.length} question(s))`,
		abortMessage: "paper chat report aborted by the user",
		signal: options.signal,
	});
	const { prose, references, sites } = buildCitations(scan.text, retrieved, new Map([[paper.key, paper.file]]));

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
		sites,
		chunks: retrieved.map((chunk) => ({
			id: chunk.id,
			page: chunk.page,
			score: Number(chunk.score.toFixed(4)),
			text: chunk.text,
			...(chunk.lexical ? { lexical: true } : {}),
			...(chunk.phrase_words ? { phrase_words: chunk.phrase_words } : {}),
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


/* ================================================================== *
 * Composable report: summaries, detail questions in two modes,        *
 * optional review synthesis -- assembled into ONE numbering            *
 * ================================================================== */

/** The six summary facets, fixed in code. Bilingual retrieval queries --
 * the rubric itself never comes from a model. */
export const SUMMARY_FACETS = [
	"research objective, aim of the study / Forschungsziel",
	"methods, methodology, study design / Methodik",
	"study area, study site, location / Untersuchungsort",
	"results, findings / Ergebnisse",
	"discussion, limitations / Diskussion",
	"future work, outlook / Zukunftsausblick",
] as const;

/** Chunks fetched per facet query; the union is capped by topK. */
export const SUMMARY_FACET_K = 3;

/** Asked of the whole scope when a review synthesis is requested. */
export const DEFAULT_REVIEW_QUESTION =
	"What is the current state of the literature across these papers: main findings, methods, and open gaps?";

/** The structured per-paper summary contract: the SAME six aspects as the
 * retrieval facets, as a fixed rubric. Format and language vary; the
 * rubric does not. */
export function summarySystemPrompt(format: "bullets" | "prose", language: string): string {
	const style = format === "bullets"
		? "- Write short bullet points (lines starting with \"- \") under each heading."
		: "- Write one short prose paragraph under each heading.";
	// Heading names in the OUTPUT language, fixed by code (models ignore a
	// "translate the headings" instruction). Unknown languages keep the
	// translate instruction.
	const headings = /german|deutsch/i.test(language)
		? ["Structure the summary under EXACTLY these six headings, in this order:",
			"Forschungsziel; Methodik; Untersuchungsort; Ergebnisse; Diskussion; Zukunftsausblick."]
		: /english|englisch/i.test(language)
			? ["Structure the summary under EXACTLY these six headings, in this order:",
				"Research objective; Methods; Study area; Results; Discussion; Future work."]
			: ["Structure the summary under EXACTLY these six headings, in this order, translated into the output language:",
				"Forschungsziel (research objective); Methodik (methods); Untersuchungsort (study area);",
				"Ergebnisse (results); Diskussion (discussion); Zukunftsausblick (future work)."];
	return [
		"You are writing a structured summary of ONE scientific paper from numbered source excerpts [1]..[k].",
		...headings,
		style,
		"- Use ONLY information from the excerpts. If they do not cover a heading, say so plainly under it.",
		"- After every claim taken from an excerpt, put its number in brackets, e.g. [3].",
		"  Multiple sources: [1][4]. Use ONLY numbers that appear in the given excerpts.",
		"- NEVER write author names, years, paper titles, DOIs, or a reference list.",
		"  The reference list is added by software afterwards. Do not add a heading like \"References\".",
		`- Write in ${language}. Stay factual; no speculation beyond the excerpts.`,
	].join("\n");
}

export function buildSummaryPrompt(
	chunks: RetrievedChunk[],
	format: "bullets" | "prose",
	language?: string,
): { system: string; user: string } {
	const blocks = chunks.map((chunk) => `[${chunk.id}] (source ${chunk.id})\n${chunk.text}`);
	return {
		system: summarySystemPrompt(format, language?.trim() || "the language of the paper's field, German preferred"),
		user: `Source excerpts of the paper:\n\n${blocks.join("\n\n")}`,
	};
}

export interface ReportOptions {
	/** Scope: PDF basenames, or "library" for every PDF in the pool. */
	papers: string[] | "library";
	/** Detail questions (may be empty when a summary is requested). */
	questions?: string[];
	/** Structured per-paper summaries; "none"/undefined skips them. */
	summary?: "bullets" | "prose" | "none";
	/** How detail questions are answered: one call per paper x question
	 * (didactic), or one call per question across the whole scope. */
	detailMode?: "per-paper" | "cross-paper";
	/** Append a review synthesis over the whole scope. */
	includeReview?: boolean;
	/** Focus of the review synthesis; default DEFAULT_REVIEW_QUESTION. */
	reviewQuestion?: string;
	session?: string;
	/** Overrides the per-genre model defaults for ALL units. */
	model?: string;
	/** Model for the didactic genres (summaries + mode A); default
	 * chatModel(). The pi adapter passes the model selected in pi here. */
	explainModel?: string;
	/** Model for the synthesis genres (mode B + review); default the
	 * configured generateModel (openscholar). */
	reviewModel?: string;
	embedModel?: string;
	topK?: number;
	/** Output language of the prose; default: the language of the question. */
	language?: string;
	/** Language of the rendered page chrome (headings); default "de". */
	uiLanguage?: string;
	reindex?: boolean;
	root?: string;
	onWarn?: (message: string) => void;
	/** Per-unit progress ("Unit 3/9: ..."; English like every status
	 * message). Defaults to onWarn. */
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

export interface ReportUnit {
	kind: "summary" | "detail-per-paper" | "detail-cross" | "review";
	/** PDF basename for per-paper units; null for cross-scope units. */
	paper_base: string | null;
	/** The question for detail units; null for summaries and the review. */
	question: string | null;
	/** Summary format, on summary units. */
	format?: "bullets" | "prose";
	model: string;
	grounded: boolean;
	prose: string;
	/** Unit-local references/sites, rewritten to the GLOBAL numbering by
	 * assembleReport before the report is returned. */
	references: ReferenceEntry[];
	sites: CitationSite[];
	chunks: Array<{ id: number; paper_key: string; page: number; score: number; text: string; lexical?: boolean; phrase_words?: number }>;
	query_variants: QueryVariant[];
	lexical_terms: string[];
	lexical_added: number;
	invalid_markers: string[];
	unmarked_sentences: number;
	stripped_reference_section: boolean;
	trimmed_chunks: number;
	/** Untouched generator output (sidecar only). */
	raw_output: string;
}

/** Full report payload; written as the JSON sidecar next to the HTML. */
export interface SynthReport {
	/** "Report: <scope label>" -- drives the output filename. */
	question: string;
	generated: string;
	backend: string;
	embedding_model: string;
	ui_language: string;
	language: string | null;
	scope: { papers: string[]; library: boolean };
	questions: string[];
	summary: "bullets" | "prose" | null;
	detail_mode: "per-paper" | "cross-paper" | null;
	include_review: boolean;
	/** Resolved scope papers (identity + local path, verified flag). */
	papers: ChatPaper[];
	units: ReportUnit[];
	/** Global references across all units (assembleReport numbering). */
	references: ReferenceEntry[];
	/** True only when EVERY generated unit passed the citation gate. */
	grounded: boolean;
	adopted_pdfs: string[];
	adoption_failures: Array<{ file: string; reason: string }>;
	unmatched_pdfs: string[];
	extraction_failures: ExtractionFailure[];
}

/**
 * The composable report: per-paper structured summaries, detail questions
 * in mode A (per paper, didactic) or B (cross-paper), and an optional
 * review synthesis -- each unit its own retrieval + generation + citation
 * gate, all assembled into ONE global reference numbering. Runs
 * P + PxQ (or Q) + 1 generation calls; the caller shows progress and
 * warns the user beforehand when that gets large (wizard).
 */
export async function runReport(options: ReportOptions, deps?: ChatDeps): Promise<SynthReport> {
	const onWarn = options.onWarn ?? (() => {});
	const onProgress = options.onProgress ?? onWarn;
	const questions = (options.questions ?? []).map((question) => question.trim()).filter(Boolean);
	const summaryFormat = options.summary && options.summary !== "none" ? options.summary : null;
	const detailMode = questions.length ? options.detailMode ?? "per-paper" : null;
	const includeReview = options.includeReview ?? false;
	if (!summaryFormat && !questions.length && !includeReview) {
		throw new Error("empty report: pass questions, a summary format, or include_review");
	}
	const root = options.root ?? outputRoot();
	const cfg = llmConfig();
	const embedModel = options.embedModel?.trim() || cfg.embedModel;
	const topK = Math.max(1, Math.min(options.topK ?? DEFAULT_TOP_K, MAX_TOP_K));
	const explainModel = options.model?.trim() || options.explainModel?.trim() || chatModel();
	const reviewModel = options.model?.trim() || options.reviewModel?.trim() || cfg.generateModel;
	const backend = deps?.backend ?? createBackend({ ...cfg, generateModel: explainModel, embedModel });
	const corpus = deps?.corpus ?? realCorpusDeps((texts, signal) => backend.embed(texts, signal));
	const protocolDeps = deps?.protocol ?? realProtocolDeps();

	// 1. Library + scope. "library" means every PDF in the pool (verified
	// papers plus honest filename-only entries), a list means exactly those.
	const { match, adopted, adoptionFailures } = await ensureLibrary(root, onWarn, {
		library: deps?.library,
		adopt: deps?.adopt,
		signal: options.signal,
	});
	const pool = chatPool(match);
	if (!pool.length) {
		throw new Error("no PDFs in the library -- run a search and fetch first, or start pi in the folder holding the PDFs");
	}
	const scopePapers = options.papers === "library"
		? pool
		: options.papers.map((name) => selectPaper(pool, name));
	if (!scopePapers.length) throw new Error("empty scope -- select at least one document");
	for (const paper of scopePapers) {
		if (paper.key.startsWith(FILE_KEY_PREFIX)) {
			onWarn(`${paper.base}.pdf has no verified bibliographic record -- citations identify it by filename and page only`);
		}
	}

	// 2. Index the whole scope once.
	const { indexes, failures } = await ensureIndexed(scopePapers, join(root, "lit-synthesis", "index"), embedModel, corpus, {
		force: options.reindex,
		onProgress: onWarn,
		signal: options.signal,
	});
	if (!indexes.length) {
		throw new Error("no paper in the selection has extractable text -- nothing to report on");
	}
	const indexByKey = new Map(indexes.map((index) => [index.paper.key, index]));
	const pdfPathByKey = new Map(scopePapers.map((paper) => [paper.key, paper.file]));
	const reportPapers: ChatPaper[] = scopePapers.map((paper) => ({
		base: paper.base,
		key: paper.key,
		title: paper.entry.title,
		authors: paper.entry.authors ?? [],
		year: paper.entry.year ?? null,
		doi: paper.entry.doi,
		arxiv_id: paper.entry.arxiv_id,
		pdf_path: paper.file,
		verified: !paper.key.startsWith(FILE_KEY_PREFIX),
	}));
	const indexedPapers = scopePapers.filter((paper) => indexByKey.has(paper.key));
	for (const paper of scopePapers) {
		if (!indexByKey.has(paper.key)) onWarn(`${paper.base}.pdf has no extractable text -- skipped in this report`);
	}

	// 3. The unit plan, in document order.
	interface PlannedUnit {
		kind: ReportUnit["kind"];
		paper?: LibraryPaper;
		question?: string;
		label: string;
	}
	const planned: PlannedUnit[] = [];
	if (summaryFormat) {
		for (const paper of indexedPapers) {
			planned.push({ kind: "summary", paper, label: `Summary ${paper.base}.pdf` });
		}
	}
	if (questions.length && detailMode === "per-paper") {
		for (const paper of indexedPapers) {
			for (const question of questions) {
				planned.push({ kind: "detail-per-paper", paper, question, label: `Question to ${paper.base}.pdf: ${question}` });
			}
		}
	} else if (questions.length) {
		for (const question of questions) {
			planned.push({ kind: "detail-cross", question, label: `Question to all documents: ${question}` });
		}
	}
	if (includeReview) {
		planned.push({ kind: "review", question: options.reviewQuestion?.trim() || DEFAULT_REVIEW_QUESTION, label: "Review synthesis" });
	}

	// 4. One retrieval + generation + citation gate per unit.
	const units: ReportUnit[] = [];
	for (const [unitIndex, plan] of planned.entries()) {
		if (options.signal?.aborted) throw new Error("report aborted by the user");
		onProgress(`Unit ${unitIndex + 1}/${planned.length}: ${plan.label}`);
		const unitIndexes = plan.paper ? [indexByKey.get(plan.paper.key)!] : indexes;
		const model = plan.kind === "summary" || plan.kind === "detail-per-paper" ? explainModel : reviewModel;
		const translate = deps?.translate !== undefined ? deps.translate : translateViaBackend(backend, model);
		const retrieval = plan.kind === "summary"
			// The bilingual facet queries need no translation variant and no
			// lexical layer -- they are code-owned, not user words.
			? await retrieve({
				queries: [...SUMMARY_FACETS],
				indexes: unitIndexes,
				perQueryK: SUMMARY_FACET_K,
				cap: topK,
				embed: (texts, signal) => corpus.embed(texts, signal),
				translate: null,
				lexical: false,
				onWarn,
				signal: options.signal,
			})
			: await retrieve({
				queries: [plan.question!],
				indexes: unitIndexes,
				perQueryK: topK,
				cap: topK,
				embed: (texts, signal) => corpus.embed(texts, signal),
				translate,
				onWarn,
				signal: options.signal,
			});
		const { retrieved, trimmed, rawOutput, scan } = await generateGrounded({
			retrieved: retrieval.chunks,
			promptOf: (chunks) =>
				plan.kind === "summary" ? buildSummaryPrompt(chunks, summaryFormat!, options.language)
				: plan.kind === "detail-per-paper" ? buildChatPrompt(plan.question!, chunks, options.language)
				: buildPrompt(plan.question!, chunks, options.language),
			backend,
			model,
			onWarn,
			abortMessage: "report aborted by the user",
			signal: options.signal,
		});
		const { prose, references, sites } = buildCitations(scan.text, retrieved, pdfPathByKey);
		units.push({
			kind: plan.kind,
			paper_base: plan.paper?.base ?? null,
			question: plan.question ?? null,
			...(plan.kind === "summary" ? { format: summaryFormat! } : {}),
			model,
			grounded: references.length > 0,
			prose,
			references,
			sites,
			chunks: retrieved.map((chunk) => ({
				id: chunk.id,
				paper_key: chunk.paper.key,
				page: chunk.page,
				score: Number(chunk.score.toFixed(4)),
				text: chunk.text,
				...(chunk.lexical ? { lexical: true } : {}),
				...(chunk.phrase_words ? { phrase_words: chunk.phrase_words } : {}),
			})),
			query_variants: retrieval.variants,
			lexical_terms: retrieval.lexical_terms,
			lexical_added: retrieval.lexical_added,
			invalid_markers: scan.invalidMarkers,
			unmarked_sentences: scan.unmarkedSentences,
			stripped_reference_section: scan.strippedReferenceSection,
			trimmed_chunks: trimmed,
			raw_output: rawOutput,
		});
	}

	// 5. ONE report numbering across all units.
	const assembled = assembleReport(units);
	const assembledUnits = assembled.units;

	// 6. Remember the scope for the session (sticky scope).
	const session = options.session?.trim() || null;
	writeCurrentScope(
		root,
		{ papers: options.papers === "library" ? "library" : scopePapers.map((paper) => paper.base) },
		session,
		protocolDeps,
		onWarn,
	);

	const uiLanguage = options.uiLanguage?.trim() || "de";
	const scopeLabel = options.papers === "library"
		? "library"
		: scopePapers.length === 1 ? `${scopePapers[0].base}.pdf` : `${scopePapers.length} documents`;
	const now = deps?.now ?? (() => new Date());
	return {
		question: `Report: ${scopeLabel}`,
		generated: now().toISOString(),
		backend: backend.label ?? `${cfg.api} at ${cfg.baseUrl}`,
		embedding_model: embedModel,
		ui_language: uiLanguage,
		language: options.language?.trim() || null,
		scope: { papers: scopePapers.map((paper) => paper.base), library: options.papers === "library" },
		questions,
		summary: summaryFormat,
		detail_mode: detailMode,
		include_review: includeReview,
		papers: reportPapers,
		units: assembledUnits,
		references: assembled.references,
		grounded: assembledUnits.length > 0 && assembledUnits.every((unit) => unit.grounded),
		adopted_pdfs: adopted,
		adoption_failures: adoptionFailures,
		unmatched_pdfs: match.unmatched.filter((file) => options.papers === "library"
			? true
			: scopePapers.some((paper) => `${paper.base}.pdf` === file)),
		extraction_failures: failures,
	};
}
