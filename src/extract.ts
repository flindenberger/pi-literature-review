/**
 * PDF text extraction and chunking for the synthesis stage. Everything in
 * here is mechanical: unpdf (a serverless pdfjs build, pure JS) reads the
 * PDF's embedded text layer, deterministic cleanup joins hyphenated line
 * breaks and drops page-number lines, and chunkPages() packs sentences
 * into retrieval-sized pieces. No OCR, no LLM cleanup -- a language model
 * repairing the text would stand upstream of the quoted evidence.
 *
 * Honesty gate: isExtractionUsable() rejects scanned PDFs (no real text
 * layer); such papers are excluded from synthesis and reported by name,
 * never silently included as empty context.
 */

import { viewerFindsPhrase } from "./pdfjs-find.ts";

/**
 * Retrieval target: ~250 tokens of academic prose (~1 paragraph).
 * 1000/300/150 (target / minimum / overlap) is the measured middle ground
 * between "finds the passage" and "cites a paragraph, not a page".
 *
 * MEASURED, not guessed. In a chunk-size experiment, we took 8 question/
 * passage pairs across 3 papers where a human had pre-located the answer
 * passage, then ranked the chunk containing that passage using bge-m3
 * embeddings and the same cosine ranking as retrieve.ts. Versus the
 * previous 1600/400/200 setup, no case regressed and 4 improved:
 * median rank 2 -> 1, worst rank 4 -> 3. Meanwhile, a single citation
 * marker's text coverage dropped from ~1550 to ~900 characters. That's
 * the actual goal: a citation should point to the relevant paragraph,
 * not half a page.
 *
 * Do not shrink this further without handling context-poor fragments.
 * At 600, the same test collapsed on a results table (rank 3 -> 159):
 * a table fragment is mostly number soup. At 1600, it was retrievable
 * because the chunk also contained the page header. The current
 * measurement is small (8 passages / 3 papers), so widen the ground
 * truth before changing these numbers again.
 */
export const CHUNK_TARGET_CHARS = 1000;
/** Trailing fragments below this merge into the previous chunk. */
export const CHUNK_MIN_CHARS = 300;
/** Carried over from the previous chunk so no claim is cut mid-thought.
 * Held at ~15 % of the target: more is duplicated text in the prompt. */
export const CHUNK_OVERLAP_CHARS = 150;

/** Identity of everything that shapes the chunks, stored in every index.
 * Any change here MUST invalidate cached indexes -- otherwise pieces made
 * by old and new rules are ranked against each other in the same
 * retrieval. "nobib" marks the bibliography removal (stripBibliography). */
export const CHUNK_SIGNATURE = `${CHUNK_TARGET_CHARS}/${CHUNK_MIN_CHARS}/${CHUNK_OVERLAP_CHARS}+nobib`;

/** Extraction gate: below these, the PDF has no usable text layer. */
const MIN_TOTAL_LETTERS = 200;
const MIN_MEAN_LETTERS_PER_PAGE = 25;

/**
 * Raw per-page text via unpdf. Dynamically imported so offline tests (and
 * every non-synthesis code path) never load pdfjs. Failures throw with a
 * plain message; the caller reports the paper as unextractable.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
	const { getDocumentProxy, extractText } = await import("unpdf");
	// pdfjs may transfer the buffer to a worker; hand over a copy.
	const document = await getDocumentProxy(new Uint8Array(bytes));
	const { text } = await extractText(document, { mergePages: false });
	return text;
}

/**
 * Deterministic cleanup of one raw page:
 *  - drop page-furniture lines (bare page numbers)
 *  - join words hyphenated across a line break ("demon-\nstrated" ->
 *    "demonstrated"); only when the continuation starts lowercase, so
 *    genuine hyphens before names/codes ("Sentinel-\n2") keep the hyphen
 *  - collapse remaining line breaks and whitespace runs into single spaces
 * Nothing more: two-column reading-order imperfections are accepted and
 * disclosed, not "repaired".
 */
export function cleanPageText(raw: string): string {
	const lines = raw.split("\n").filter((line) => !/^\s*\d{1,4}\s*$/.test(line));
	return lines
		.join("\n")
		.replace(/(\p{L})-\n\s*(\p{Ll})/gu, "$1$2")
		.replace(/(\p{L})-\n\s*([\p{L}\p{N}])/gu, "$1-$2")
		.replace(/\s+/g, " ")
		.trim();
}

/* ------------------------------------------------------------------ *
 * Bibliography removal                                                 *
 * ------------------------------------------------------------------ */

/** Section headings that open a reference list, as a line of their own
 * (optionally numbered, optionally with a colon). */
const BIBLIOGRAPHY_HEADING =
	/^\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:references?(?:\s+list)?|bibliography|literature\s+cited|works\s+cited|literatur(?:verzeichnis)?|quellen(?:verzeichnis)?|referencias|bibliograf[ií]a|r[ée]f[ée]rences)\s*:?\s*$/i;

/** Headings that end a reference list: real content follows again. Kept
 * deliberately narrow -- only sections that carry substance. Front matter
 * that sometimes trails the list (acknowledgements, author contributions,
 * funding) is NOT here: resuming there would un-cut everything behind it,
 * including reference lists that follow. */
const AFTER_BIBLIOGRAPHY_HEADING =
	/^\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:appendi(?:x|ces)|annex|anhang|supplement(?:ary|al)?(?:\s+(?:material|information))?|supporting\s+information|ap[ée]ndice)\b/i;

/** A heading in the first part of a document is a table-of-contents entry
 * or a forward reference, not the list itself. */
const BIBLIOGRAPHY_MIN_POSITION = 0.4;
/** Cutting more than this is a sign the detection went wrong; then nothing
 * is cut and the honest cost is a few reference chunks in the index. */
const BIBLIOGRAPHY_MAX_SHARE = 0.6;

export interface BibliographyCut {
	/** Pages with the reference list blanked out; the ARRAY LENGTH and all
	 * page positions are preserved, so page numbers stay exact. */
	pages: string[];
	/** Characters removed (0 when nothing was detected or the guard hit). */
	removed: number;
	/** 1-based page the reference list starts on; null when none was found. */
	page: number | null;
}

/**
 * Blank out the reference list of a paper. Its entries are titles of OTHER
 * work: they answer no question about THIS paper, they occupy a fifth of
 * the index, and they occasionally win an excerpt slot with a title that
 * happens to match the question.
 *
 * Deterministic and conservative:
 *   - the heading must stand on a LINE OF ITS OWN and sit in the last 60 %
 *     of the text, so a table-of-contents entry or "see the references"
 *     inside a sentence never triggers it;
 *   - everything from there is dropped UNTIL an appendix-like heading, if
 *     one follows -- appendices carry content and often sit behind the
 *     reference list;
 *   - if the cut would swallow more than BIBLIOGRAPHY_MAX_SHARE of the
 *     text, nothing is cut at all;
 *   - no heading found (many preprints) means no cut.
 *
 * Runs on RAW pages, before cleanPageText collapses the line structure.
 * Pure.
 */
export function stripBibliography(rawPages: string[]): BibliographyCut {
	const total = rawPages.reduce((sum, page) => sum + page.length, 0);
	if (!total) return { pages: rawPages, removed: 0, page: null };

	let seen = 0;
	let start: { page: number; line: number } | null = null;
	for (const [pageIndex, page] of rawPages.entries()) {
		const lines = page.split("\n");
		for (const [lineIndex, line] of lines.entries()) {
			if (!start && BIBLIOGRAPHY_HEADING.test(line) && seen / total >= BIBLIOGRAPHY_MIN_POSITION) {
				start = { page: pageIndex, line: lineIndex };
			}
			seen += line.length + 1;
		}
		if (start) break;
	}
	if (!start) return { pages: rawPages, removed: 0, page: null };

	// Where content resumes (appendix and friends), if it does.
	let end: { page: number; line: number } | null = null;
	for (let pageIndex = start.page; pageIndex < rawPages.length && !end; pageIndex++) {
		const lines = rawPages[pageIndex].split("\n");
		for (const [lineIndex, line] of lines.entries()) {
			if (pageIndex === start.page && lineIndex <= start.line) continue;
			if (AFTER_BIBLIOGRAPHY_HEADING.test(line.trim()) && line.trim().length <= 60) {
				end = { page: pageIndex, line: lineIndex };
				break;
			}
		}
	}

	const kept = rawPages.map((page, pageIndex) => {
		if (pageIndex < start.page) return page;
		if (end && pageIndex > end.page) return page;
		const lines = page.split("\n");
		return lines.filter((_, lineIndex) => {
			const afterStart = pageIndex > start.page || lineIndex >= start.line;
			const beforeEnd = !end || pageIndex < end.page || lineIndex < end.line;
			return !(afterStart && beforeEnd);
		}).join("\n");
	});

	const removed = total - kept.reduce((sum, page) => sum + page.length, 0);
	if (removed / total > BIBLIOGRAPHY_MAX_SHARE) {
		return { pages: rawPages, removed: 0, page: null }; // detection looks wrong
	}
	return { pages: kept, removed, page: start.page + 1 };
}

/** True when the pages carry a real text layer (see gate constants). */
export function isExtractionUsable(pages: string[]): boolean {
	if (!pages.length) return false;
	let letters = 0;
	for (const page of pages) letters += (page.match(/\p{L}/gu) ?? []).length;
	return letters >= MIN_TOTAL_LETTERS && letters / pages.length >= MIN_MEAN_LETTERS_PER_PAGE;
}

export interface PageChunk {
	/** 1-based page number the chunk starts on. */
	page: number;
	text: string;
}

/** Conservative sentence split: end punctuation, then whitespace, then an
 * upper-case/digit/quote start. Abbreviation false-positives only shift a
 * pack boundary, never lose text. */
function splitSentences(text: string): string[] {
	return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(“])/).filter((s) => s.trim().length > 0);
}

export interface ChunkOptions {
	targetChars?: number;
	minChars?: number;
	overlapChars?: number;
}

/**
 * Pack CLEANED pages (cleanPageText output) into retrieval chunks. Pure.
 * Sentences are packed up to the target size; each new chunk starts with
 * the tail of the previous one (overlap) so no claim is cut mid-thought;
 * a trailing fragment below the minimum merges into the previous chunk.
 * Chunks never span pages -- the page number is part of the evidence trail.
 */
export function chunkPages(pages: string[], options: ChunkOptions = {}): PageChunk[] {
	const target = options.targetChars ?? CHUNK_TARGET_CHARS;
	const min = options.minChars ?? CHUNK_MIN_CHARS;
	const overlap = options.overlapChars ?? CHUNK_OVERLAP_CHARS;
	const chunks: PageChunk[] = [];
	for (const [index, page] of pages.entries()) {
		const pageNo = index + 1;
		const first = chunks.length; // chunks belonging to THIS page start here
		let current = "";
		const flush = () => {
			const text = current.trim();
			current = "";
			if (!text) return;
			// A short trailing piece reads better attached to its predecessor
			// (same page only -- page attribution stays exact).
			const previous = chunks[chunks.length - 1];
			if (text.length < min && chunks.length > first && previous.page === pageNo) {
				previous.text = `${previous.text} ${text}`;
				return;
			}
			chunks.push({ page: pageNo, text });
		};
		for (const sentence of splitSentences(page)) {
			if (current && current.length + 1 + sentence.length > target) {
				// Overlap starts at a word boundary, never mid-word.
				const tail = current.slice(-overlap).replace(/^\S*\s+/, "");
				flush();
				current = tail ? `${tail} ${sentence}` : sentence;
			} else {
				current = current ? `${current} ${sentence}` : sentence;
			}
		}
		flush();
	}
	return chunks;
}

/* ------------------------------------------------------------------ *
 * Verified highlight phrase                                           *
 * ------------------------------------------------------------------ */

/** Shorter runs carry no signal and would light up half the page. */
export const PHRASE_MIN_WORDS = 3;
/** Upper bound; a chunk of CHUNK_TARGET_CHARS holds roughly this many
 * words, so in practice the whole excerpt is offered for highlighting. */
export const PHRASE_MAX_WORDS = 200;

/**
 * How many LEADING words of a chunk the PDF viewer can actually highlight.
 *
 * Our chunk text is cleaned (hyphenated line breaks joined, page furniture
 * dropped) while the viewer searches its OWN rendering of the text layer,
 * and where the two diverge a search phrase silently finds nothing. The
 * length is therefore not guessed but MEASURED here, once per chunk at
 * index time: the longest leading run that viewerFindsPhrase() confirms,
 * found by binary search over the word count. `viewerPage` must come from
 * viewerPageTexts() -- an approximation of it is not good enough, see the
 * ligature case documented in pdfjs-find.ts. Pure.
 *
 * Measured on the test corpus: most excerpts are highlightable
 * in full; the rest are cut short where our cleanup removed something the
 * viewer still sees, and a small remainder gets no highlight at all --
 * there the reader still lands on the right page, which is the honest
 * offer.
 *
 * Returns 0 when nothing usable matches.
 */
export function verifiedPhraseWords(
	chunkText: string,
	viewerPage: string,
	maxWords: number = PHRASE_MAX_WORDS,
): number {
	const words = chunkText.split(/\s+/).filter(Boolean);
	const cap = Math.min(words.length, maxWords);
	if (cap < PHRASE_MIN_WORDS || !viewerPage) return 0;
	const finds = (count: number): boolean =>
		viewerFindsPhrase(words.slice(0, count).join(" "), viewerPage);
	if (!finds(PHRASE_MIN_WORDS)) return 0;
	// Invariant: PHRASE_MIN_WORDS matches, cap + 1 does not.
	let low = PHRASE_MIN_WORDS;
	let high = cap;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (finds(middle)) low = middle;
		else high = middle - 1;
	}
	return low;
}

/** The verified phrase itself, rebuilt from the same word split that
 * measured it. Null when the chunk carries no usable run. */
export function phraseOf(chunkText: string, phraseWords: number | undefined): string | null {
	if (!phraseWords || phraseWords < PHRASE_MIN_WORDS) return null;
	const words = chunkText.split(/\s+/).filter(Boolean).slice(0, phraseWords);
	return words.length >= PHRASE_MIN_WORDS ? words.join(" ") : null;
}
