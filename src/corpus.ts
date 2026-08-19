/**
 * Library corpus for the synthesis stage: which PDFs belong to which
 * VERIFIED search record, and a persisted embedding index per paper.
 *
 * Matching order per PDF (no fuzzy matching, no guessing):
 *   1. the metadata twin <basename>.json written by the selection stage
 *   2. filename recomputation: every saved-search record's paperFilename()
 *      and identifierSlug() (older names) against the PDF's basename
 * A PDF matching neither has no verified bibliographic identity -- it is
 * listed by name, honestly, and (unless adoption finds an identifier in
 * its text) cited by filename and page only.
 *
 * The index (one JSON per paper under lit-synthesis/index/) caches
 * extraction and embeddings; a paper is re-processed only when its content
 * hash, the embedding model, the chunking rules or its identity change. IO
 * is injectable (CorpusDeps) so everything tests offline.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	type BibliographyCut,
	chunkPages,
	CHUNK_SIGNATURE,
	cleanPageText,
	extractPdfPages,
	isExtractionUsable,
	stripBibliography,
	verifiedPhraseWords,
} from "./extract.ts";
import { identifierSlug, loadSidecarIndex, paperFilename, parseIdentifier, type SidecarEntry } from "./selection.ts";
import { viewerPageTexts } from "./pdfjs-find.ts";
import { identityKey } from "./pipeline.ts";

export interface LibraryPaper {
	/** Absolute path of the PDF. */
	file: string;
	/** PDF basename without extension; also names the index file. */
	base: string;
	/** Identity key (doi:... / arxiv:...) linking to the verified record. */
	key: string;
	entry: SidecarEntry;
}

export interface LibraryMatch {
	matched: LibraryPaper[];
	/** PDF basenames without a verified record -- excluded from synthesis. */
	unmatched: string[];
	/** The unmatched files grouped by the folder they live in (the corpus
	 * may span several folders; adoption and filename-only citation need the
	 * right one per file). Optional so injected fixtures and core results
	 * keep working -- read it via unmatchedGroups(). */
	unmatchedByDir?: Array<{ dir: string; files: string[] }>;
	/** Primary directory (the first of dirs) -- kept for messages and as
	 * the place "no papers" errors point at. */
	papersDir: string;
	/** Every directory that contributed PDFs. Optional, see above. */
	dirs?: string[];
}

/** The unmatched files with their folders; falls back to the single
 * papersDir for matches without unmatchedByDir (fixtures, core results). */
export function unmatchedGroups(match: LibraryMatch): Array<{ dir: string; files: string[] }> {
	if (match.unmatchedByDir) return match.unmatchedByDir;
	return match.unmatched.length ? [{ dir: match.papersDir, files: match.unmatched }] : [];
}

/**
 * Where PDFs live. Candidate chain, so that starting pi in ANY folder of
 * papers just works:
 *   1. <root>/lit-selection -- the canonical downloaded library
 *   2. <cwd>/lit-selection  -- a library folder next to where pi runs
 *   3. <cwd>/pi-literature-review/lit-selection -- a library downloaded
 *      by an earlier version that bundled the stage folders (downloaded
 *      papers must stay selectable)
 *   4. <cwd> itself         -- loose PDFs right in the working directory
 * EVERY candidate that holds a PDF contributes to the corpus (an existing
 * library must not hide loose PDFs). When none holds one, the canonical
 * location is reported so "no papers" messages point at the place the
 * selection stage would fill. Pure via injected checks for tests.
 */
export function papersDirs(
	root: string,
	cwd: string = process.cwd(),
	hasPdfs: (dir: string) => boolean = hasPdfsReal,
): string[] {
	const candidates = [...new Set([
		join(root, "lit-selection"),
		join(cwd, "lit-selection"),
		join(cwd, "pi-literature-review", "lit-selection"),
		cwd,
	])];
	const withPdfs = candidates.filter((dir) => hasPdfs(dir));
	return withPdfs.length ? withPdfs : [candidates[0]];
}

function hasPdfsReal(dir: string): boolean {
	try {
		return readdirSync(dir).some((name) => name.toLowerCase().endsWith(".pdf"));
	} catch {
		return false;
	}
}

/** Parse a metadata twin into a SidecarEntry; null when it carries no
 * citable identity (then filename recomputation gets its chance). */
export function entryFromTwin(twin: unknown): { key: string; entry: SidecarEntry } | null {
	const { title, authors, year, doi, arxiv_id, pdf_url } = (twin ?? {}) as Record<string, unknown>;
	const entry: SidecarEntry = {
		title: typeof title === "string" ? title : "",
		pdf_url: typeof pdf_url === "string" ? pdf_url : "",
		doi: typeof doi === "string" ? doi : "",
		arxiv_id: typeof arxiv_id === "string" ? arxiv_id : "",
		authors: Array.isArray(authors) ? authors.filter((a): a is string => typeof a === "string") : [],
		year: typeof year === "string" ? year : null,
	};
	const key = identityKey(entry);
	return key === null ? null : { key, entry };
}

/** Every filename a saved-search record could have produced, mapped back
 * to its identity -- covers current human-readable names, legacy slugs,
 * and the version-stripped identifier (records may say "2401.16393v1"
 * while the file was fetched as "2401.16393"; the identity key treats
 * them as the same paper, so the filenames must too). */
export function filenameIndex(index: Map<string, SidecarEntry>): Map<string, { key: string; entry: SidecarEntry }> {
	const names = new Map<string, { key: string; entry: SidecarEntry }>();
	for (const [key, entry] of index) {
		const targets = [parseIdentifier(entry.doi || entry.arxiv_id)];
		const versionless = key.slice(key.indexOf(":") + 1);
		if (targets[0].kind !== "unknown" && targets[0].id.toLowerCase() !== versionless) {
			targets.push(parseIdentifier(versionless));
		}
		for (const target of targets) {
			if (target.kind === "unknown") continue;
			for (const name of [paperFilename(target, entry), identifierSlug(target)]) {
				if (!names.has(name)) names.set(name, { key, entry });
			}
		}
	}
	return names;
}

/** Pure matching core; basenames come without the .pdf extension. */
export function matchLibraryCore(
	pdfBases: string[],
	twins: Map<string, unknown>,
	index: Map<string, SidecarEntry>,
	papersDir: string,
): LibraryMatch {
	const byFilename = filenameIndex(index);
	const matched: LibraryPaper[] = [];
	const unmatched: string[] = [];
	for (const base of pdfBases) {
		const hit = entryFromTwin(twins.get(base)) ?? byFilename.get(base) ?? null;
		if (hit) {
			matched.push({ file: join(papersDir, `${base}.pdf`), base, key: hit.key, entry: hit.entry });
		} else {
			unmatched.push(`${base}.pdf`);
		}
	}
	return {
		matched,
		unmatched,
		unmatchedByDir: unmatched.length ? [{ dir: papersDir, files: unmatched }] : [],
		papersDir,
	};
}

/**
 * Thin IO wrapper: locate the PDFs, read twins, delegate to the pure core.
 * The corpus is the UNION of every candidate folder holding PDFs
 * (canonical library, cwd library, cwd itself). Basenames stay unique
 * corpus-wide (they key the sticky scope, protocols and the index cache):
 * on a collision the earlier folder in the chain wins and the shadowed file
 * is skipped with a warning.
 */
export function matchLibrary(root: string, onWarn: (message: string) => void): LibraryMatch {
	const dirs = papersDirs(root);
	const index = loadSidecarIndex(root, onWarn);
	const matched: LibraryPaper[] = [];
	const unmatched: string[] = [];
	const unmatchedByDir: Array<{ dir: string; files: string[] }> = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			continue; // no folder yet -- the others may still hold PDFs
		}
		const bases: string[] = [];
		for (const base of names
			.filter((name) => name.toLowerCase().endsWith(".pdf"))
			.map((name) => name.slice(0, -4))
			.sort()) {
			if (seen.has(base)) {
				onWarn(`skipped ${join(dir, `${base}.pdf`)}: a paper with this filename is already in the corpus (earlier folder wins)`);
				continue;
			}
			seen.add(base);
			bases.push(base);
		}
		const twins = new Map<string, unknown>();
		for (const base of bases) {
			try {
				twins.set(base, JSON.parse(readFileSync(join(dir, `${base}.json`), "utf8")));
			} catch {
				// no twin (pre-twin download) or unreadable -- recomputation decides
			}
		}
		const result = matchLibraryCore(bases, twins, index, dir);
		matched.push(...result.matched);
		unmatched.push(...result.unmatched);
		if (result.unmatched.length) unmatchedByDir.push({ dir, files: result.unmatched });
	}
	return { matched, unmatched, unmatchedByDir, papersDir: dirs[0], dirs };
}

/* ------------------------------------------------------------------ *
 * Embedding index -- one JSON per paper, hash+model+chunking          *
 * invalidation                                                        *
 * ------------------------------------------------------------------ */

/** Index file schema; older schemas are silently re-indexed -- an index is
 * derived data, the PDF stays the ground truth. */
export const INDEX_SCHEMA = 2;

export interface IndexedChunk {
	id: number;
	page: number;
	text: string;
	embedding: number[];
	/** Leading words of `text` VERIFIED at index time against the viewer's
	 * own rendering of the page, and therefore highlightable in the PDF
	 * (see verifiedPhraseWords); 0 = no highlight, page link only. */
	phrase_words: number;
}

export interface PaperIndex {
	schema: number;
	sha256: string;
	embedding_model: string;
	/** CHUNK_SIGNATURE the chunks were cut with; part of cache validity. */
	chunking: string;
	paper: {
		key: string;
		title: string;
		authors: string[];
		year: string | null;
		doi: string;
		arxiv_id: string;
	};
	chunks: IndexedChunk[];
}

export interface ExtractionFailure {
	file: string;
	reason: string;
}

export interface CorpusDeps {
	readPdf(path: string): Uint8Array;
	sha256(bytes: Uint8Array): string;
	/** Raw per-page text (extractPdfPages); cleanup happens here. */
	extract(bytes: Uint8Array): Promise<string[]>;
	/** Per-page text as the PDF VIEWER searches it (viewerPageTexts), used
	 * to verify the highlight phrase of every chunk. Optional: without it
	 * chunks carry no verified phrase and links fall back to the timid
	 * clean-word snippet -- offline tests inject nothing here. */
	viewerPages?(bytes: Uint8Array): Promise<string[]>;
	embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
	loadIndex(file: string): PaperIndex | null;
	saveIndex(file: string, index: PaperIndex): void;
}

/** The real IO wiring, shared by the CLI and the synthesis engine; only
 * the embed step (the LLM backend) is passed in. */
export function realCorpusDeps(embed: CorpusDeps["embed"]): CorpusDeps {
	return {
		readPdf: (path) => readFileSync(path),
		sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
		extract: extractPdfPages,
		viewerPages: viewerPageTexts,
		embed,
		loadIndex: (file) => {
			try {
				return JSON.parse(readFileSync(file, "utf8")) as PaperIndex;
			} catch {
				return null;
			}
		},
		saveIndex: (file, index) => {
			// The index directory may not exist yet on a first run in a fresh
			// folder.
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify(index) + "\n", "utf8");
		},
	};
}

export interface EnsureIndexedOptions {
	/** Re-extract and re-embed everything, ignoring cached indexes. */
	force?: boolean;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

/**
 * Bring the index up to date for the matched papers. Per paper: reuse the
 * cached index when content hash, embedding model and schema all agree;
 * otherwise extract, gate, chunk and embed. Papers without a usable text
 * layer (or whose extraction throws) become honest failures and are
 * excluded -- one broken PDF never aborts the run. A user abort does.
 */
export async function ensureIndexed(
	papers: LibraryPaper[],
	indexDir: string,
	embeddingModel: string,
	deps: CorpusDeps,
	options: EnsureIndexedOptions = {},
): Promise<{ indexes: PaperIndex[]; failures: ExtractionFailure[] }> {
	const progress = options.onProgress ?? (() => {});
	const indexes: PaperIndex[] = [];
	const failures: ExtractionFailure[] = [];
	for (const [i, paper] of papers.entries()) {
		if (options.signal?.aborted) throw new Error("indexing aborted by the user");
		const indexFile = join(indexDir, `${paper.base}.json`);
		const bytes = deps.readPdf(paper.file);
		const hash = deps.sha256(bytes);
		if (!options.force) {
			const cached = deps.loadIndex(indexFile);
			// The identity key is part of the cache validity: a paper indexed
			// as filename-only (file:...) must be re-indexed once adoption
			// gives it a verified identity, or its citations would keep the
			// stale unverified label.
			if (cached && cached.schema === INDEX_SCHEMA && cached.sha256 === hash
				&& cached.embedding_model === embeddingModel && cached.paper.key === paper.key
				&& cached.chunking === CHUNK_SIGNATURE) {
				indexes.push(cached);
				progress(`index ${i + 1}/${papers.length}: ${paper.base} (cached)`);
				continue;
			}
		}
		progress(`index ${i + 1}/${papers.length}: ${paper.base} (extracting)`);
		let pages: string[];
		let bibliography: BibliographyCut = { pages: [], removed: 0, page: null };
		try {
			// The reference list is removed BEFORE cleanup and chunking: its
			// entries are titles of other work, they answer nothing about this
			// paper, and they cost a fifth of the index. Page positions are
			// preserved, so page numbers and the highlight verification below
			// stay exact.
			bibliography = stripBibliography(await deps.extract(bytes));
			pages = bibliography.pages.map(cleanPageText);
		} catch (error) {
			failures.push({
				file: `${paper.base}.pdf`,
				reason: `extraction failed: ${error instanceof Error ? error.message : error}`,
			});
			continue;
		}
		if (!isExtractionUsable(pages)) {
			failures.push({ file: `${paper.base}.pdf`, reason: "no extractable text (likely scanned)" });
			continue;
		}
		const chunks = chunkPages(pages);
		if (bibliography.page) {
			progress(`index ${i + 1}/${papers.length}: ${paper.base} `
				+ `(reference list from page ${bibliography.page} excluded from the search)`);
		}
		// A second read of the SAME bytes, this time as the PDF viewer sees
		// them: the highlight phrase of each chunk is verified against that
		// text. A failure here costs highlights, never the index itself.
		let viewerPages: string[] = [];
		if (deps.viewerPages) {
			try {
				viewerPages = await deps.viewerPages(bytes);
			} catch (error) {
				progress(`index ${i + 1}/${papers.length}: ${paper.base} (no PDF highlights: `
					+ `${error instanceof Error ? error.message : error})`);
			}
		}
		progress(`index ${i + 1}/${papers.length}: ${paper.base} (embedding ${chunks.length} chunks)`);
		const vectors = await deps.embed(chunks.map((chunk) => chunk.text), options.signal);
		const index: PaperIndex = {
			schema: INDEX_SCHEMA,
			sha256: hash,
			embedding_model: embeddingModel,
			chunking: CHUNK_SIGNATURE,
			paper: {
				key: paper.key,
				title: paper.entry.title,
				authors: paper.entry.authors ?? [],
				year: paper.entry.year ?? null,
				doi: paper.entry.doi,
				arxiv_id: paper.entry.arxiv_id,
			},
			chunks: chunks.map((chunk, id) => ({
				id,
				page: chunk.page,
				text: chunk.text,
				embedding: vectors[id],
				phrase_words: verifiedPhraseWords(chunk.text, viewerPages[chunk.page - 1] ?? ""),
			})),
		};
		deps.saveIndex(indexFile, index);
		indexes.push(index);
	}
	return { indexes, failures };
}
