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

/** Retrieval chunk target: ~350-400 tokens of academic prose. */
export const CHUNK_TARGET_CHARS = 1600;
/** Trailing fragments below this merge into the previous chunk. */
export const CHUNK_MIN_CHARS = 400;
/** Carried over from the previous chunk so no claim is cut mid-thought. */
export const CHUNK_OVERLAP_CHARS = 200;

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
