/**
 * Shared retrieval core for chat rounds, chat reports and synthesis
 * (design/2026-07-21_v24, Stage 1). A measured field failure drove it: the
 * German question "welche kameras benutzen sie?" ranked the camera chunk
 * 14/81 while its English twin ranked it 1 -- the query language, not the
 * tools, was the bottleneck. Three layers answer it:
 *
 *   1. Query variants: the original question PLUS an English translation
 *      (one small generate() call per question). Doctrine-conform: an LLM
 *      may SHAPE queries, it never touches citations; every variant is
 *      disclosed in the digest and the HTML meta (precedent: arxiv_queries,
 *      v18). Translator failure/empty/identical -> original only, never an
 *      abort reason.
 *   2. Embedding retrieval: ONE embed call for all variants, topKChunks per
 *      variant, deduplicated union ranked by best score.
 *   3. Lexical layer: salient terms of the ORIGINAL question(s) --
 *      capitalized words outside sentence starts, model-number tokens,
 *      quoted phrases -- exact-matched over the chunk texts by fixed code
 *      (whole-word with the v18 tolerances). Hits get guaranteed slots in
 *      the excerpt list, so an exact term like "Q1645" can never lose to
 *      embedding geometry.
 *
 * Everything here is deterministic except the translation call, whose
 * output is used as a search query only. The context-budget trim stays with
 * the callers.
 */

import type { PaperIndex } from "./corpus.ts";
import type { LlmBackend } from "./llm.ts";

/* ------------------------------------------------------------------ *
 * Embedding retrieval primitives -- pure (moved from synthesize.ts)   *
 * ------------------------------------------------------------------ */

export interface RetrievedChunk {
	/** 1-based number the excerpt carries in the prompt ([1]..[k]). */
	id: number;
	paper: PaperIndex["paper"];
	page: number;
	score: number;
	text: string;
	/** True when a salient term of the question matches this chunk exactly
	 * (lexical layer); informative for trails, digest and HTML meta. */
	lexical?: boolean;
	/** The salient terms that matched (set together with lexical). */
	terms?: string[];
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
 * tie-break (paper key, then page, then text) so equal scores never reorder
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

/** Dedupe key of a chunk within a retrieval run. The paper key is part of
 * it: in multi-paper scopes, identical boilerplate on the same page number
 * of two different papers is two distinct pieces of evidence. */
function chunkKey(chunk: { paper: PaperIndex["paper"]; page: number; text: string }): string {
	return `${chunk.paper.key}\u0000${chunk.page}\u0000${chunk.text}`;
}

/** Union of per-query retrievals: each distinct excerpt once (max score
 * wins), ranked by score with a deterministic tie-break, capped and
 * renumbered 1..m. The dedupe key includes the page -- identical
 * boilerplate text CAN legitimately occur on two pages. Pure. */
export function unionChunks(perQuery: RetrievedChunk[][], cap: number): RetrievedChunk[] {
	const byKey = new Map<string, RetrievedChunk>();
	for (const list of perQuery) {
		for (const chunk of list) {
			const key = chunkKey(chunk);
			const existing = byKey.get(key);
			if (!existing || chunk.score > existing.score) byKey.set(key, chunk);
		}
	}
	return [...byKey.values()]
		.sort((a, b) => b.score - a.score
			|| a.paper.key.localeCompare(b.paper.key)
			|| a.page - b.page
			|| a.text.localeCompare(b.text))
		.slice(0, cap)
		.map((chunk, i) => ({ ...chunk, id: i + 1 }));
}

/* ------------------------------------------------------------------ *
 * Query variants -- the one LLM call in here, shaping queries only     *
 * ------------------------------------------------------------------ */

export interface QueryVariant {
	query: string;
	/** "original" = the user's words; "english" = LLM-shaped translation,
	 * disclosed wherever variants are shown. */
	kind: "original" | "english";
}

export type TranslateFn = (question: string, signal?: AbortSignal) => Promise<string>;

export const TRANSLATE_SYSTEM_PROMPT =
	"You translate a reader's question about scientific literature into English for use as a search query. "
	+ "Reply with ONLY the English translation of the question -- no explanations, no quotes, nothing else.";

/** Hard cap on the translation call -- a runaway thinking model must not
 * turn query building into a long wait. */
export const TRANSLATE_MAX_TOKENS = 256;

/** Default translator: one small generate() call on the caller's backend.
 * The engines pass their resolved generator model so the translation runs
 * on the same model that will answer. */
export function translateViaBackend(backend: LlmBackend, model?: string): TranslateFn {
	// think:false -- a thinking model would spend the capped budget on
	// hidden reasoning and return empty content (v22 failure mode, re-found
	// live on this call 2026-07-22).
	return (question, signal) =>
		backend.generate(TRANSLATE_SYSTEM_PROMPT, question,
			{ model, temperature: 0, maxTokens: TRANSLATE_MAX_TOKENS, think: false }, signal);
}

/** First non-empty line of the translator output, surrounding quotes
 * stripped -- everything else a chatty model adds is discarded. */
function firstLine(raw: string): string {
	const line = raw.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
	return line.replace(/^["'„“‚‘]+/, "").replace(/["'“”‘’]+$/, "").trim();
}

/**
 * The original question plus, when a translator is given and delivers
 * something usable, its English translation. Any translator problem
 * degrades to the original variant with a warning -- retrieval must never
 * fail because of the optional variant. A user abort still propagates.
 */
export async function buildQueryVariants(
	question: string,
	translate: TranslateFn | null,
	onWarn: (message: string) => void = () => {},
	signal?: AbortSignal,
): Promise<QueryVariant[]> {
	const original = question.trim();
	const variants: QueryVariant[] = [{ query: original, kind: "original" }];
	if (!translate) return variants;
	try {
		const english = firstLine(await translate(original, signal));
		if (!english) {
			onWarn("English query variant: the translator returned no text -- retrieving with the original question only");
		} else if (english.length > 400) {
			onWarn("English query variant: the translator returned prose instead of a query -- ignored");
		} else if (english.toLowerCase() !== original.toLowerCase()) {
			variants.push({ query: english, kind: "english" });
		}
	} catch (error) {
		if (signal?.aborted) throw error;
		onWarn(`English query variant unavailable (${error instanceof Error ? error.message : error})`
			+ " -- retrieving with the original question only");
	}
	return variants;
}

/* ------------------------------------------------------------------ *
 * Lexical layer -- pure, deterministic                                 *
 * ------------------------------------------------------------------ */

/**
 * Salient terms of a question -- the parts embedding geometry is most
 * likely to lose: quoted phrases, model-number tokens (letters AND digits,
 * e.g. Q1645, S-2, bge-m3) and capitalized words outside sentence starts.
 * Pure text analysis of the USER's words; translations never contribute
 * terms. Deduplicated case-insensitively, original spelling kept.
 */
export function salientTerms(question: string): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	const add = (term: string | undefined) => {
		const cleaned = (term ?? "").trim().replace(/\s+/g, " ");
		if (cleaned.length < 2) return;
		const key = cleaned.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			terms.push(cleaned);
		}
	};
	// Quoted phrases: straight, typographic and German quotes.
	for (const match of question.matchAll(
		/"([^"\n]{2,80})"|“([^”\n]{2,80})”|„([^“”\n]{2,80})[“”]|‚([^‘’\n]{2,80})[‘’]/g,
	)) {
		add(match[1] ?? match[2] ?? match[3] ?? match[4]);
	}
	// Tokens (hyphens kept): model numbers and capitalized words.
	for (const match of question.matchAll(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu)) {
		const token = match[0];
		if (/\p{N}/u.test(token) && /\p{L}/u.test(token)) {
			add(token); // model-number token, salient wherever it stands
			continue;
		}
		if (token.length >= 2 && /^\p{Lu}/u.test(token) && !isSentenceStart(question, match.index)) {
			add(token);
		}
	}
	return terms;
}

/** A capitalized word right after start-of-text, .!?: or an opening
 * quote/bracket following one of those is ordinary sentence case, not
 * salience. */
function isSentenceStart(text: string, index: number): boolean {
	for (let i = index - 1; i >= 0; i--) {
		const ch = text[i];
		if (/\s/.test(ch)) continue;
		if ("\"'„“”‚‘’([{".includes(ch)) continue;
		return ".!?:".includes(ch);
	}
	return true;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive matcher for one term -- the v18 rules
 * (design/2026-07-14): no word character may touch the term, separators
 * inside it match hyphen or whitespace interchangeably, optional plural-s. */
export function lexicalTermPattern(term: string): RegExp | null {
	const parts = term.split(/[-\s]+/).filter(Boolean).map(escapeRegExp);
	if (!parts.length) return null;
	return new RegExp(`(?<!\\w)${parts.join("[-\\s]+")}s?(?!\\w)`, "i");
}

/** A term matching more chunks than this carries no signal ("Sentinel" in
 * a Sentinel paper) and is dropped from the lexical layer. */
export const LEXICAL_TERM_MAX_HITS = 8;

export interface LexicalHit {
	paper: PaperIndex["paper"];
	page: number;
	text: string;
	/** The salient terms that match this chunk exactly. */
	terms: string[];
	/** Chunk embedding, kept so retrieve() can report an honest similarity
	 * score for lexical-only additions. */
	embedding: number[];
}

/**
 * Exact whole-word matches of the salient terms over all chunk texts.
 * Terms matching more than LEXICAL_TERM_MAX_HITS chunks are discarded as
 * non-discriminative. Hits are ordered deterministically: most distinct
 * terms matched first, then paper key, page, text.
 */
export function lexicalMatches(terms: string[], indexes: PaperIndex[]): LexicalHit[] {
	const patterns = terms
		.map((term) => ({ term, pattern: lexicalTermPattern(term) }))
		.filter((entry): entry is { term: string; pattern: RegExp } => entry.pattern !== null);
	if (!patterns.length) return [];
	const counts = new Map<string, number>();
	for (const index of indexes) {
		for (const chunk of index.chunks) {
			for (const { term, pattern } of patterns) {
				if (pattern.test(chunk.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
			}
		}
	}
	const discriminative = patterns.filter(({ term }) => (counts.get(term) ?? 0) <= LEXICAL_TERM_MAX_HITS);
	if (!discriminative.length) return [];
	const hits: LexicalHit[] = [];
	for (const index of indexes) {
		for (const chunk of index.chunks) {
			const matched = discriminative
				.filter(({ pattern }) => pattern.test(chunk.text))
				.map(({ term }) => term);
			if (matched.length) {
				hits.push({ paper: index.paper, page: chunk.page, text: chunk.text, terms: matched, embedding: chunk.embedding });
			}
		}
	}
	hits.sort((a, b) => b.terms.length - a.terms.length
		|| a.paper.key.localeCompare(b.paper.key)
		|| a.page - b.page
		|| a.text.localeCompare(b.text));
	return hits;
}

/* ------------------------------------------------------------------ *
 * The shared retrieval pass                                            *
 * ------------------------------------------------------------------ */

/** Guaranteed excerpt slots for lexical hits; the embedding union fills
 * the rest of the cap. */
export const MAX_LEXICAL_CHUNKS = 4;

export interface RetrieveOptions {
	/** The user's question(s), verbatim -- variants and lexical terms both
	 * start from these. */
	queries: string[];
	indexes: PaperIndex[];
	/** Chunks fetched per query variant (embedding layer). */
	perQueryK: number;
	/** Cap on the final excerpt list, lexical additions included. */
	cap: number;
	embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
	/** English-variant translator; null/omitted disables the variant
	 * (offline tests, callers without a generator). */
	translate?: TranslateFn | null;
	onWarn?: (message: string) => void;
	signal?: AbortSignal;
}

export interface RetrievalResult {
	/** Final numbered excerpt list (1..m) for the prompt: embedding-ranked
	 * chunks first, lexical-only additions appended. */
	chunks: RetrievedChunk[];
	/** Every query that went into the ONE embed call, disclosed. */
	variants: QueryVariant[];
	/** Salient terms the lexical layer searched for. */
	lexical_terms: string[];
	/** Chunks in the list ONLY because a term matched exactly. */
	lexical_added: number;
}

/**
 * The shared retrieval pass: build variants -> ONE embed call -> topK per
 * variant -> union -> reserve slots for lexical hits -> renumber. The
 * total never exceeds cap; when a lexical hit is also an embedding hit it
 * keeps its embedding rank and is merely flagged (the run then simply
 * carries fewer excerpts than cap -- honest, not padded).
 */
export async function retrieve(options: RetrieveOptions): Promise<RetrievalResult> {
	const onWarn = options.onWarn ?? (() => {});
	const queries = options.queries.map((query) => query.trim()).filter(Boolean);
	if (!queries.length) throw new Error("no retrieval queries");

	// 1. Variants (per question), deduplicated case-insensitively.
	const variants: QueryVariant[] = [];
	for (const query of queries) {
		for (const variant of await buildQueryVariants(query, options.translate ?? null, onWarn, options.signal)) {
			if (!variants.some((known) => known.query.toLowerCase() === variant.query.toLowerCase())) {
				variants.push(variant);
			}
		}
	}

	// 2. ONE embed call for all variants, topK per variant, deduped union.
	const vectors = await options.embed(variants.map((variant) => variant.query), options.signal);
	const union = unionChunks(
		vectors.map((vector) => topKChunks(vector, options.indexes, options.perQueryK)),
		options.cap,
	);

	// 3. Lexical layer over the ORIGINAL queries only.
	const terms: string[] = [];
	{
		const seen = new Set<string>();
		for (const query of queries) {
			for (const term of salientTerms(query)) {
				if (!seen.has(term.toLowerCase())) {
					seen.add(term.toLowerCase());
					terms.push(term);
				}
			}
		}
	}
	const hits = lexicalMatches(terms, options.indexes);
	const hitByKey = new Map(hits.map((hit) => [chunkKey(hit), hit]));

	// 4. Composition: lexical hits get reserved slots (at most
	// MAX_LEXICAL_CHUNKS, never the whole cap), the embedding union fills
	// the rest; overlaps stay at their embedding rank, flagged.
	const reserved = hits.slice(0, Math.min(MAX_LEXICAL_CHUNKS, Math.max(0, options.cap - 1)));
	const kept = union.slice(0, options.cap - reserved.length).map((chunk) => {
		const hit = hitByKey.get(chunkKey(chunk));
		return hit ? { ...chunk, lexical: true, terms: hit.terms } : chunk;
	});
	const keptKeys = new Set(kept.map(chunkKey));
	const additions = reserved
		.filter((hit) => !keptKeys.has(chunkKey(hit)))
		.map((hit) => ({
			paper: hit.paper,
			page: hit.page,
			text: hit.text,
			score: Math.max(...vectors.map((vector) => cosine(vector, hit.embedding))),
			lexical: true as const,
			terms: hit.terms,
		}));
	const chunks = [...kept, ...additions].map((chunk, i) => ({ ...chunk, id: i + 1 }));
	if (additions.length) {
		onWarn(`lexical layer: ${additions.length} excerpt(s) added by exact term match (${
			[...new Set(additions.flatMap((chunk) => chunk.terms ?? []))].join(", ")})`);
	}

	return { chunks, variants, lexical_terms: terms, lexical_added: additions.length };
}
