/**
 * PDF adoption: give a loose PDF (one that never went through search+fetch)
 * a VERIFIED bibliographic identity, deterministically.
 *
 * Nearly every published paper PDF carries its own identifier in the text
 * of the first page: arXiv PDFs have the "arXiv:NNNN.NNNNN" watermark,
 * publisher PDFs print their DOI in the header or footer. Adoption:
 *   1. extract the identifier by fixed pattern from the first pages
 *      (no guessing, no fuzzy matching, no LLM),
 *   2. look the identifier up at the open APIs (OpenAlex for DOIs, the
 *      arXiv API for arXiv IDs) -- a successful by-identifier lookup is the
 *      verification: the API resolved exactly this identity,
 *   3. write the metadata twin next to the PDF (same format the selection stage writes),
 *      so the library matcher picks the paper up like any fetched one.
 * A PDF whose text names no identifier, or whose identifier the APIs do
 * not know, stays excluded -- honestly, with the reason. THE ONE INVIOLABLE
 * RULE holds: every metadata field in the twin is copied verbatim from an
 * API response.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildPaperMeta, parseIdentifier, type PaperMeta, type SidecarEntry } from "./selection.ts";
import { extractPdfPages } from "./extract.ts";
import { lookupArxivIds } from "./sources/arxiv.ts";
import { contactMailto, userAgent } from "./types.ts";

/** Pages scanned for the paper's own identifier. Front matter only: deeper
 * pages are dominated by OTHER papers' identifiers (the reference list). */
const SCAN_PAGES = 2;
const LOOKUP_TIMEOUT_MS = 20_000;

export interface FoundIdentifier {
	kind: "doi" | "arxiv";
	id: string;
}

/**
 * Fixed-pattern identifier scan over the first pages. Priority per page:
 * the arXiv watermark first (it is unambiguously the paper's OWN id),
 * then the first DOI. Trailing punctuation that page layout glues onto a
 * DOI is stripped.
 */
export function findIdentifier(pages: string[]): FoundIdentifier | null {
	for (const page of pages.slice(0, SCAN_PAGES)) {
		const arxiv = page.match(/arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
		if (arxiv) return { kind: "arxiv", id: arxiv[1] };
		const doi = page.match(/\b(10\.\d{4,9}\/[^\s"<>()[\]{}]+)/);
		if (doi) return { kind: "doi", id: doi[1].replace(/[.,;:]+$/, "") };
	}
	return null;
}

export interface AdoptDeps {
	readPdf(path: string): Uint8Array;
	extract(bytes: Uint8Array): Promise<string[]>;
	/** By-identifier lookups; null = the API does not know this identifier. */
	lookupDoi(doi: string, signal?: AbortSignal): Promise<SidecarEntry | null>;
	lookupArxiv(id: string, signal?: AbortSignal): Promise<SidecarEntry | null>;
	saveMeta(path: string, meta: PaperMeta): void;
}

export interface AdoptionResult {
	file: string;
	status: "adopted" | "no_identifier" | "lookup_failed";
	/** Plain-language outcome, shown wherever exclusions are reported. */
	detail: string;
}

/**
 * Try to adopt every unmatched PDF. One broken PDF never aborts the run;
 * a user abort does. Network use is one lookup per PDF, nothing else.
 */
export async function adoptUnmatched(
	unmatched: string[],
	papersDir: string,
	deps: AdoptDeps,
	onProgress: (message: string) => void = () => {},
	signal?: AbortSignal,
): Promise<AdoptionResult[]> {
	const results: AdoptionResult[] = [];
	for (const file of unmatched) {
		if (signal?.aborted) throw new Error("adoption aborted by the user");
		const path = join(papersDir, file);
		let found: FoundIdentifier | null = null;
		try {
			found = findIdentifier(await deps.extract(deps.readPdf(path)));
		} catch (error) {
			results.push({
				file,
				status: "no_identifier",
				detail: `text extraction failed (${error instanceof Error ? error.message : error})`,
			});
			continue;
		}
		if (!found) {
			results.push({
				file,
				status: "no_identifier",
				detail: `no DOI or arXiv ID found on the first ${SCAN_PAGES} pages`,
			});
			continue;
		}
		onProgress(`adopting ${file}: found ${found.kind === "doi" ? "DOI" : "arXiv ID"} ${found.id}, looking it up`);
		let entry: SidecarEntry | null = null;
		try {
			entry = found.kind === "doi"
				? await deps.lookupDoi(found.id, signal)
				: await deps.lookupArxiv(found.id, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			results.push({
				file,
				status: "lookup_failed",
				detail: `lookup of ${found.id} failed (${error instanceof Error ? error.message : error})`,
			});
			continue;
		}
		if (!entry) {
			results.push({
				file,
				status: "lookup_failed",
				detail: `${found.id} is not known to the ${found.kind === "doi" ? "OpenAlex" : "arXiv"} API`,
			});
			continue;
		}
		const target = parseIdentifier(entry.doi || entry.arxiv_id || found.id);
		deps.saveMeta(
			path.replace(/\.pdf$/i, ".json"),
			buildPaperMeta(target, entry, "adopted", new Date().toISOString()),
		);
		results.push({ file, status: "adopted", detail: `identity ${found.id} verified by API lookup` });
	}
	return results;
}

/* ------------------------------------------------------------------ *
 * Real lookups (open APIs, polite headers, no keys)                   *
 * ------------------------------------------------------------------ */

/** OpenAlex by-DOI lookup; 404 = unknown identifier (null). Same API the
 * enrichment step uses; fields are copied verbatim. */
export async function lookupDoiOpenAlex(doi: string, signal?: AbortSignal): Promise<SidecarEntry | null> {
	const mailto = contactMailto();
	const query = mailto ? `?mailto=${encodeURIComponent(mailto)}` : "";
	const response = await fetch(
		`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}${query}`,
		{
			headers: { "User-Agent": userAgent() },
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]) : AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		},
	);
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`OpenAlex answered HTTP ${response.status}`);
	const work = await response.json() as {
		display_name?: string;
		publication_year?: number;
		doi?: string;
		authorships?: Array<{ author?: { display_name?: string } }>;
		best_oa_location?: { pdf_url?: string | null } | null;
	};
	return {
		title: work.display_name ?? "",
		pdf_url: work.best_oa_location?.pdf_url ?? "",
		doi: (work.doi ?? "").replace(/^https?:\/\/doi\.org\//i, "") || doi,
		arxiv_id: "",
		authors: (work.authorships ?? [])
			.map((authorship) => authorship.author?.display_name ?? "")
			.filter(Boolean),
		year: typeof work.publication_year === "number" ? String(work.publication_year) : null,
	};
}

/** arXiv by-ID lookup; an empty feed = unknown identifier (null). */
export async function lookupArxivById(id: string, _signal?: AbortSignal): Promise<SidecarEntry | null> {
	const [record] = await lookupArxivIds([id]);
	if (!record) return null;
	return {
		title: record.title,
		pdf_url: record.pdf_url,
		doi: record.doi,
		arxiv_id: record.arxiv_id,
		authors: record.authors,
		year: record.year,
	};
}

/** The real IO wiring, used by the engine and the CLI. */
export function realAdoptDeps(): AdoptDeps {
	return {
		readPdf: (path) => readFileSync(path),
		extract: extractPdfPages,
		lookupDoi: lookupDoiOpenAlex,
		lookupArxiv: lookupArxivById,
		// Same serialization as the fetch twin writer.
		saveMeta: (path, meta) => writeFileSync(path, JSON.stringify(meta, null, 2) + "\n", "utf8"),
	};
}
