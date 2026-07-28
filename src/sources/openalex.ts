/**
 * Native OpenAlex client (replaces the paper-search engine for this source).
 *
 * GET https://api.openalex.org/works?search=...&per-page=N mirrors the
 * engine's request shape. OpenAlex ships abstracts as an inverted index
 * (word -> positions); reconstruction below is a deterministic reassembly of
 * API data. The DOI comes only from the API's doi field -- never scraped out
 * of text. Unlike the engine we also map the venue
 * (primary_location.source.display_name); it too is plain API metadata.
 */

import { contactMailto, type SourceRecord, userAgent } from "../types.ts";

const BASE_URL = "https://api.openalex.org/works";
const TIMEOUT_MS = 30_000;

/** Rebuild the abstract text from OpenAlex's inverted index. String ops only. */
function reconstructAbstract(invertedIndex: unknown): string {
	if (!invertedIndex || typeof invertedIndex !== "object") return "";
	const positioned: Array<[number, string]> = [];
	for (const [word, positions] of Object.entries(invertedIndex as Record<string, number[]>)) {
		if (!Array.isArray(positions)) continue;
		for (const position of positions) {
			if (Number.isInteger(position)) positioned.push([position, word]);
		}
	}
	positioned.sort((a, b) => a[0] - b[0]);
	return positioned.map(([, word]) => word).join(" ").trim();
}

export async function searchOpenalex(query: string, rows: number): Promise<SourceRecord[]> {
	const params = new URLSearchParams({
		search: query,
		"per-page": String(Math.min(rows, 200)),
	});
	const mailto = contactMailto();
	if (mailto) params.set("mailto", mailto);

	const response = await fetch(`${BASE_URL}?${params}`, {
		headers: { "User-Agent": userAgent(), Accept: "application/json" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`OpenAlex answered HTTP ${response.status}`);
	}
	const data = (await response.json()) as Record<string, any>;
	const items: Array<Record<string, any>> = (data?.results ?? []).slice(0, rows);

	return items.map((item) => {
		const doi = typeof item.doi === "string"
			? item.doi.replace("https://doi.org/", "").trim()
			: "";
		const primary = item.primary_location ?? {};
		const openAccess = item.open_access ?? {};
		const year = Number.isInteger(item.publication_year)
			? String(item.publication_year)
			: typeof item.publication_date === "string" && /^\d{4}/.test(item.publication_date)
				? item.publication_date.slice(0, 4)
				: null;

		return {
			title: typeof item.title === "string" ? item.title.trim() : "",
			authors: ((item.authorships as Array<Record<string, any>>) ?? [])
				.map((authorship) => authorship?.author?.display_name)
				.filter((name: unknown): name is string => typeof name === "string" && !!name.trim())
				.map((name) => name.trim()),
			year,
			venue: typeof primary?.source?.display_name === "string"
				? primary.source.display_name.trim()
				: "",
			doi,
			arxiv_id: "",
			pdf_url: (typeof primary?.pdf_url === "string" && primary.pdf_url.trim())
				|| (openAccess?.is_oa && typeof openAccess?.oa_url === "string" && openAccess.oa_url.trim())
				|| "",
			url: (typeof primary?.landing_page_url === "string" && primary.landing_page_url.trim())
				|| (typeof item.id === "string" ? item.id.trim() : ""),
			cites: Number.isInteger(item.cited_by_count) ? (item.cited_by_count as number) : null,
			source: "openalex",
			abstract: reconstructAbstract(item.abstract_inverted_index),
			venue_id: typeof primary?.source?.id === "string"
				? primary.source.id.replace("https://openalex.org/", "").trim()
				: "",
		};
	});
}

/** One bucket of a facet query below: plain API metadata. Journals and
 * authors share the shape (v30.11: the author picker mirrors the journal
 * picker). */
export interface Facet {
	/** OpenAlex id -- a source id ("S43295729", feeds the journal score
	 * lookup, v30.8) or an author id ("A5059343226", feeds the author
	 * metrics lookup, v30.11). */
	id: string;
	name: string;
	count: number;
}

/** Kept for the journal call sites: journals were the first facet (v30.6). */
export type JournalFacet = Facet;

/**
 * Parse the group_by buckets of an OpenAlex works response into facets
 * (v30.6: the wizard's "choose journals from a list" option; v30.11: the
 * same for authors). Pure and exported for offline tests. Buckets without a
 * display name (works without a source, e.g. some preprints) are dropped;
 * order is by count descending, deterministic tie-break by name.
 */
export function parseFacets(data: unknown, limit: number): Facet[] {
	const buckets = Array.isArray((data as Record<string, any>)?.group_by)
		? ((data as Record<string, any>).group_by as Array<Record<string, any>>)
		: [];
	return buckets
		.map((bucket) => ({
			id: typeof bucket?.key === "string" ? bucket.key.replace("https://openalex.org/", "").trim() : "",
			name: typeof bucket?.key_display_name === "string" ? bucket.key_display_name.trim() : "",
			count: Number.isInteger(bucket?.count) ? (bucket.count as number) : 0,
		}))
		.filter((facet) => facet.name && facet.name.toLowerCase() !== "unknown")
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
		.slice(0, Math.max(1, limit));
}

/** The listed head of a facet query plus everything behind it (v30.11:
 * the picker shows an explicit "other ..." row, so selecting every row
 * really means "no filter"). */
export interface FacetPage {
	listed: Facet[];
	/** Works matching the query that sit OUTSIDE the listed facets:
	 * meta.count minus the listed buckets (works without a source / without
	 * a listed author included). Plain API arithmetic -- nothing estimated. */
	otherCount: number;
}

/**
 * Parse a facet response into the listed head AND the count behind it.
 * meta.count is the total number of matching works; without it (degenerate
 * responses) the bucket sum is the honest floor.
 */
export function parseFacetPage(data: unknown, limit: number): FacetPage {
	const listed = parseFacets(data, limit);
	const buckets = Array.isArray((data as Record<string, any>)?.group_by)
		? ((data as Record<string, any>).group_by as Array<Record<string, any>>)
		: [];
	const bucketSum = buckets.reduce(
		(sum, bucket) => sum + (Number.isInteger(bucket?.count) ? (bucket.count as number) : 0),
		0,
	);
	const total = Number.isInteger((data as Record<string, any>)?.meta?.count)
		? ((data as Record<string, any>).meta.count as number)
		: bucketSum;
	const listedSum = listed.reduce((sum, facet) => sum + facet.count, 0);
	return { listed, otherCount: Math.max(0, total - listedSum) };
}

/**
 * ONE cheap facet request over the query's works, grouped by the given
 * field -- the pre-query behind the wizard's pickers. Deterministic API
 * data; the LLM is nowhere near it.
 */
async function facetPage(query: string, groupBy: string, limit: number): Promise<FacetPage> {
	// NO per-page here: sending it alongside group_by makes OpenAlex return
	// a single bucket (measured 2026-07-28); bare group_by returns 200.
	const params = new URLSearchParams({ search: query, group_by: groupBy });
	const mailto = contactMailto();
	if (mailto) params.set("mailto", mailto);
	const response = await fetch(`${BASE_URL}?${params}`, {
		headers: { "User-Agent": userAgent(), Accept: "application/json" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`OpenAlex answered HTTP ${response.status}`);
	}
	return parseFacetPage(await response.json(), limit);
}

/** Which journals do results for this query appear in (v30.6). */
export function journalFacets(query: string, limit: number): Promise<FacetPage> {
	return facetPage(query, "primary_location.source.id", limit);
}

/** Which authors publish the results for this query (v30.11) -- the same
 * mechanics as the journal list, one request. */
export function authorFacets(query: string, limit: number): Promise<FacetPage> {
	return facetPage(query, "authorships.author.id", limit);
}
