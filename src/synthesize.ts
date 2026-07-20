/**
 * Synthesis engine: answer a research question from the local, verified
 * PDF library -- grounded RAG in the OpenScholar spirit, sized for a
 * 10-100 paper corpus on a local GPU.
 *
 * Pipeline: match library -> ensure embedding index -> embed the question
 * -> cosine top-k chunks -> ONE generation pass -> deterministic citation
 * enforcement -> paper-level references.
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
import { llmConfig } from "./config.ts";
import {
	type CorpusDeps,
	ensureIndexed,
	type ExtractionFailure,
	type LibraryMatch,
	type LibraryPaper,
	matchLibrary,
	type PaperIndex,
	realCorpusDeps,
} from "./corpus.ts";
import { createBackend, type GenerateOptions, type LlmBackend } from "./llm.ts";
import { outputRoot } from "./output.ts";

/** Context window requested from the backend (Ollama defaults to ~4k and
 * silently truncates -- it MUST be set explicitly). */
export const NUM_CTX = 8192;
/** Tokens kept free for the generated answer. */
export const OUTPUT_RESERVE_TOKENS = 1024;
/** Deterministic char->token estimate for the budget guard. */
const CHARS_PER_TOKEN = 4;
export const DEFAULT_TOP_K = 8;
export const MAX_TOP_K = 20;
const TEMPERATURE = 0.2;

/* ------------------------------------------------------------------ *
 * Retrieval -- pure                                                    *
 * ------------------------------------------------------------------ */

export interface RetrievedChunk {
	/** 1-based number the excerpt carries in the prompt ([1]..[k]). */
	id: number;
	paper: PaperIndex["paper"];
	page: number;
	score: number;
	text: string;
}

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const norm = Math.sqrt(normA) * Math.sqrt(normB);
	return norm === 0 ? 0 : dot / norm;
}

/** Best k chunks across all papers by cosine similarity. Deterministic
 * tie-break (paper key, then chunk id) so equal scores never reorder
 * between runs. */
export function topKChunks(queryVector: number[], indexes: PaperIndex[], k: number): RetrievedChunk[] {
	const scored: Array<Omit<RetrievedChunk, "id">> = [];
	for (const index of indexes) {
		for (const chunk of index.chunks) {
			scored.push({
				paper: index.paper,
				page: chunk.page,
				score: cosine(queryVector, chunk.embedding),
				text: chunk.text,
			});
		}
	}
	scored.sort((a, b) => b.score - a.score
		|| a.paper.key.localeCompare(b.paper.key)
		|| a.page - b.page
		|| a.text.localeCompare(b.text));
	return scored.slice(0, k).map((chunk, i) => ({ id: i + 1, ...chunk }));
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
}

/**
 * Renumber validated chunk-level markers to paper-level reference numbers
 * (several excerpts of one paper become ONE reference) and build the
 * reference list -- exclusively from the verified paper records carried by
 * the retrieved chunks. This is the only place the final citation numbers
 * are produced, and no model output flows into any field but the marker
 * positions themselves.
 */
export function buildReferences(
	text: string,
	chunks: RetrievedChunk[],
): { prose: string; references: ReferenceEntry[] } {
	const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
	const references: ReferenceEntry[] = [];
	const numberByKey = new Map<string, number>();
	const prose = text
		.replace(/\[(\d+)\]/g, (match, digits: string) => {
			const chunk = byId.get(Number.parseInt(digits, 10));
			if (!chunk) return match; // cannot happen after enforceCitations
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
			return `[${n}]`;
		})
		.replace(/\[(\d+)\](?:\s*\[\1\])+/g, "[$1]"); // same paper, adjacent excerpts
	return { prose, references };
}

/* ------------------------------------------------------------------ *
 * Orchestration                                                        *
 * ------------------------------------------------------------------ */

export interface SynthesizeOptions {
	question: string;
	/** Restrict to these PDF filenames (basename, with or without .pdf). */
	papers?: string[];
	model?: string;
	embedModel?: string;
	topK?: number;
	/** Output language of the prose; default: the language of the question. */
	language?: string;
	/** Force re-extraction and re-embedding of every paper. */
	reindex?: boolean;
	root?: string;
	onWarn?: (message: string) => void;
	signal?: AbortSignal;
}

export interface SynthesizeDeps {
	corpus: CorpusDeps;
	backend: LlmBackend;
	/** Library scan; injectable so the orchestration tests offline. */
	library?: (root: string, onWarn: (message: string) => void) => LibraryMatch;
	/** Adoption of unmatched PDFs; injectable for offline tests. */
	adopt?: (unmatched: string[], papersDir: string) => Promise<AdoptionResult[]>;
}

/** Full payload; written as the JSON sidecar next to the HTML. */
export interface SynthesisResult {
	question: string;
	generated: string;
	model: string;
	embedding_model: string;
	backend: string;
	top_k: number;
	grounded: boolean;
	/** Final prose with paper-level [n] markers. */
	prose: string;
	references: ReferenceEntry[];
	/** Retrieval trail: every excerpt that was in the prompt. */
	chunks: Array<{ id: number; paper_key: string; title: string; page: number; score: number; text: string }>;
	invalid_markers: string[];
	unmarked_sentences: number;
	stripped_reference_section: boolean;
	/** Chunks dropped by the context-budget guard (lowest-ranked first). */
	trimmed_chunks: number;
	papers_matched: number;
	papers_cited: number;
	/** Retrieved but not cited by the model (keys, for the methods footer). */
	papers_uncited: string[];
	/** Loose PDFs that gained a verified identity this run (see adopt.ts). */
	adopted_pdfs: string[];
	/** Adoption attempts that failed, with the plain-language reason. */
	adoption_failures: Array<{ file: string; reason: string }>;
	/** PDFs without a verified record -- excluded, listed honestly. */
	unmatched_pdfs: string[];
	extraction_failures: ExtractionFailure[];
	/** Untouched generator output, kept for inspection (sidecar only). */
	raw_output: string;
}

function filterPapers(matched: LibraryPaper[], wanted: string[] | undefined, onWarn: (m: string) => void): LibraryPaper[] {
	if (!wanted?.length) return matched;
	const bases = new Set(wanted.map((name) => name.trim().replace(/\.pdf$/i, "")).filter(Boolean));
	const kept = matched.filter((paper) => bases.has(paper.base));
	for (const base of bases) {
		if (!matched.some((paper) => paper.base === base)) {
			onWarn(`requested paper not in the matched library: ${base}.pdf`);
		}
	}
	return kept;
}

export async function runSynthesize(
	options: SynthesizeOptions,
	deps?: SynthesizeDeps,
): Promise<SynthesisResult> {
	const onWarn = options.onWarn ?? (() => {});
	const question = options.question.trim();
	if (!question) throw new Error("empty question");
	const root = options.root ?? outputRoot();
	const cfg = llmConfig();
	const model = options.model?.trim() || cfg.generateModel;
	const embedModel = options.embedModel?.trim() || cfg.embedModel;
	const topK = Math.max(1, Math.min(options.topK ?? DEFAULT_TOP_K, MAX_TOP_K));
	const backend = deps?.backend ?? createBackend({ ...cfg, generateModel: model, embedModel });
	const corpus = deps?.corpus ?? realCorpusDeps((texts, signal) => backend.embed(texts, signal));

	// 1. Library: verified papers only. Loose PDFs first get an adoption
	// attempt (identifier from the PDF text, verified API lookup, twin on
	// disk); whatever still has no verified identity is excluded and named.
	const libraryFn = deps?.library ?? matchLibrary;
	let match = libraryFn(root, onWarn);
	const adoptedPdfs: string[] = [];
	const adoptionFailures: Array<{ file: string; reason: string }> = [];
	if (match.unmatched.length) {
		onWarn(`${match.unmatched.length} PDF(s) without verified metadata -- attempting adoption (identifier lookup)`);
		const adoptFn = deps?.adopt
			?? ((files: string[], dir: string) => adoptUnmatched(files, dir, realAdoptDeps(), onWarn, options.signal));
		const adoptions = await adoptFn(match.unmatched, match.papersDir);
		for (const adoption of adoptions) {
			if (adoption.status === "adopted") {
				adoptedPdfs.push(adoption.file);
				onWarn(`adopted ${adoption.file}: ${adoption.detail}`);
			} else {
				adoptionFailures.push({ file: adoption.file, reason: adoption.detail });
				onWarn(`could not adopt ${adoption.file}: ${adoption.detail}`);
			}
		}
		if (adoptedPdfs.length) match = libraryFn(root, onWarn); // new twins -> re-match
	}
	const { matched, unmatched } = match;
	const papers = filterPapers(matched, options.papers, onWarn);
	if (!papers.length) {
		throw new Error(
			"no papers with verified metadata in the library -- run a search and fetch first"
			+ (adoptionFailures.length
				? `; adoption failed for: ${adoptionFailures.map((f) => `${f.file} (${f.reason})`).join("; ")}`
				: ""),
		);
	}

	// 2. Index (cached unless content/model changed), then the question vector.
	const { indexes, failures } = await ensureIndexed(papers, join(root, "index"), embedModel, corpus, {
		force: options.reindex,
		onProgress: onWarn,
		signal: options.signal,
	});
	if (!indexes.length) {
		throw new Error("no paper in the selection has extractable text -- nothing to synthesize from");
	}
	if (options.signal?.aborted) throw new Error("synthesis aborted by the user");
	const [queryVector] = await corpus.embed([question], options.signal);

	// 3. Retrieval + context-budget guard (NUM_CTX minus the answer reserve).
	let retrieved = topKChunks(queryVector, indexes, topK);
	let prompt = buildPrompt(question, retrieved, options.language);
	let trimmed = 0;
	const budget = NUM_CTX - OUTPUT_RESERVE_TOKENS;
	while (retrieved.length > 1 && promptTokens(prompt) > budget) {
		retrieved = retrieved.slice(0, -1).map((chunk, i) => ({ ...chunk, id: i + 1 }));
		prompt = buildPrompt(question, retrieved, options.language);
		trimmed++;
	}
	if (trimmed) onWarn(`context budget: dropped the ${trimmed} lowest-ranked chunk(s) to fit ${NUM_CTX} tokens`);

	// 4. ONE generation pass; the output is untrusted prose from here on.
	if (options.signal?.aborted) throw new Error("synthesis aborted by the user");
	onWarn(`generating with ${model} (${retrieved.length} excerpts; this can take a few minutes on a local GPU)`);
	const generateOptions: GenerateOptions = { model, numCtx: NUM_CTX, temperature: TEMPERATURE };
	const rawOutput = await backend.generate(prompt.system, prompt.user, generateOptions, options.signal);

	// 5. Trust gate: validate markers, then paper-level references from
	// verified records only.
	const scan = enforceCitations(rawOutput, retrieved.length);
	if (scan.invalidMarkers.length) {
		onWarn(`stripped ${scan.invalidMarkers.length} invalid citation marker(s): ${scan.invalidMarkers.join(" ")}`);
	}
	if (scan.strippedReferenceSection) {
		onWarn("the model wrote its own reference section; it was cut (references come from verified records only)");
	}
	const { prose, references } = buildReferences(scan.text, retrieved);
	const citedKeys = new Set(references.map((reference) => reference.key));
	const retrievedKeys = [...new Set(retrieved.map((chunk) => chunk.paper.key))];

	return {
		question,
		generated: new Date().toISOString(),
		model,
		embedding_model: embedModel,
		backend: `${cfg.api} at ${cfg.baseUrl}`,
		top_k: topK,
		grounded: references.length > 0,
		prose,
		references,
		chunks: retrieved.map((chunk) => ({
			id: chunk.id,
			paper_key: chunk.paper.key,
			title: chunk.paper.title,
			page: chunk.page,
			score: Number(chunk.score.toFixed(4)),
			text: chunk.text,
		})),
		invalid_markers: scan.invalidMarkers,
		unmarked_sentences: scan.unmarkedSentences,
		stripped_reference_section: scan.strippedReferenceSection,
		trimmed_chunks: trimmed,
		papers_matched: papers.length,
		papers_cited: citedKeys.size,
		papers_uncited: retrievedKeys.filter((key) => !citedKeys.has(key)),
		adopted_pdfs: adoptedPdfs,
		adoption_failures: adoptionFailures,
		unmatched_pdfs: unmatched,
		extraction_failures: failures,
		raw_output: rawOutput,
	};
}
