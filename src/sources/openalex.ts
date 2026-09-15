/**
 * OpenAlex client: the works search (boolean block search in the search
 * parameter, optional author filter) and the facet pre-queries behind the
 * wizard's journal and author pickers. OpenAlex ships abstracts as an
 * inverted index (word -> positions); reconstruction below is a
 * deterministic reassembly of API data. The DOI comes only from the API's
 * doi field -- never scraped out of text; the venue is plain API metadata.
 */

import { contactMailto, type SourceRecord, type SourceScope, userAgent } from "../types.ts";

const BASE_URL = "https://api.openalex.org/works";
const AUTOCOMPLETE_URL = "https://api.openalex.org/autocomplete/authors";
const TIMEOUT_MS = 30_000;
/** OpenAlex accepts up to 50 pipe-joined values in one filter. */
const DOI_BATCH_SIZE = 50;

/** Rebuild the abstract text from OpenAlex's inverted index. String ops
 * only; the enrichment stage fills missing abstracts from the same work
 * objects. */
export function reconstructAbstract(invertedIndex: unknown): string {
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

/**
 * Author scope as an OpenAlex filter= value: raw_author_name.search is the
 * documented full-text search over author names as printed on the works;
 * "|" OR-joins the names. Commas and pipes are OpenAlex filter syntax and
 * are stripped from the names ("Kuenzer, C." arrives as a tool param like
 * that). Pure; exported for offline tests. Empty result = no filter.
 */
export function buildAuthorSearchFilter(authors: string[] | undefined): string {
	const names = (authors ?? [])
		.map((name) => name.replace(/[|,]/g, " ").replace(/\s+/g, " ").trim())
		.filter(Boolean);
	return names.length ? `raw_author_name.search:${names.join("|")}` : "";
}

/** Author ids as an OpenAlex filter= value: authorships.author.id takes
 * pipe-joined ids (A5059343226|A...). Ids are taken as given, URL prefixes
 * stripped. Pure. Empty = no filter. */
export function buildAuthorIdFilter(ids: string[] | undefined): string {
	const clean = (ids ?? [])
		.map((id) => id.replace(/^https?:\/\/openalex\.org\//i, "").trim())
		.filter((id) => /^A\d+$/.test(id));
	return clean.length ? `authorships.author.id:${clean.join("|")}` : "";
}

export interface AuthorMatch {
	/** Short OpenAlex id, "A5059343226". */
	id: string;
	name: string;
	/** Institution line as OpenAlex prints it ("University of Würzburg,
	 * Germany"), empty when unknown. */
	hint: string;
	works: number | undefined;
	cites: number | undefined;
	orcid: string;
}

/** Pure: the author autocomplete answer -> matches (measured shape
 * 2026-09-13: results[].id/display_name/hint/works_count/cited_by_count/
 * external_id). Entries without a usable id are skipped; duplicates by id
 * collapse (OpenAlex sometimes lists a person twice under DIFFERENT ids --
 * those stay, the row shows works and institution to tell them apart). */
export function parseAuthorAutocomplete(data: unknown): AuthorMatch[] {
	const results = (data as { results?: unknown })?.results;
	if (!Array.isArray(results)) return [];
	const seen = new Set<string>();
	const matches: AuthorMatch[] = [];
	for (const entry of results as Array<Record<string, unknown>>) {
		const id = typeof entry?.id === "string" ? entry.id.replace(/^https?:\/\/openalex\.org\//i, "").trim() : "";
		const name = typeof entry?.display_name === "string" ? entry.display_name.trim() : "";
		if (!/^A\d+$/.test(id) || !name || seen.has(id)) continue;
		seen.add(id);
		matches.push({
			id,
			name,
			hint: typeof entry.hint === "string" ? entry.hint.trim() : "",
			works: Number.isInteger(entry.works_count) ? (entry.works_count as number) : undefined,
			cites: Number.isInteger(entry.cited_by_count) ? (entry.cited_by_count as number) : undefined,
			orcid: typeof entry.external_id === "string" ? entry.external_id.trim() : "",
		});
	}
	return matches;
}

/** Author name lookup for the wizard's typing row: GET /autocomplete/
 * authors?q=<prefix>, the best ten. An optional signal bounds the wait. */
export async function autocompleteAuthors(prefix: string, signal?: AbortSignal): Promise<AuthorMatch[]> {
	const params = new URLSearchParams({ q: prefix.trim() });
	const mailto = contactMailto();
	if (mailto) params.set("mailto", mailto);
	const response = await fetch(`${AUTOCOMPLETE_URL}?${params}`, {
		headers: { "User-Agent": userAgent(), Accept: "application/json" },
		signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`OpenAlex answered HTTP ${response.status}`);
	return parseAuthorAutocomplete(await response.json());
}

/**
 * Concept blocks as an OpenAlex boolean search string. OpenAlex supports
 * full boolean queries in its search parameter:
 * UPPERCASE AND/OR/NOT, parentheses, quoted phrases (stemming and stopword
 * removal still apply on their side). Multi-word terms are quoted so they
 * match as phrases. Pure; exported for offline tests. Empty result = no
 * blocks, caller falls back to the plain query text.
 */
export function buildBlockSearch(blocks: string[][] | undefined): string {
	const groups = (blocks ?? [])
		.map((group) => group.map((term) => term.replace(/"/g, "").trim()).filter(Boolean))
		.filter((group) => group.length);
	if (!groups.length) return "";
	return groups
		.map((group) => {
			const terms = group.map((term) => (term.includes(" ") ? `"${term}"` : term));
			return terms.length > 1 ? `(${terms.join(" OR ")})` : terms[0];
		})
		.join(" AND ");
}

/** The parameters of one works request: the boolean block search (or the
 * plain text) plus the author scope -- picked authors by OpenAlex id
 * (exact) or by name (raw_author_name.search); with authorScope "all" the
 * text search is dropped and the author's works come citation-sorted.
 * Pure; exported so the payload can show what was sent. */
/** Record types EXCLUDED from OpenAlex work searches (negated filter):
 * peer-review reports and author replies of open review platforms,
 * supplementary material, datasets, paratext (covers, issue matter) and
 * grants are not papers. Errata and retraction notices stay: they
 * concern papers. */
export const OPENALEX_EXCLUDED_TYPES = ["peer-review", "supplementary-materials", "paratext", "dataset", "grant"];

export function buildWorksParams(query: string, rows: number, scope?: SourceScope): URLSearchParams {
	const params = new URLSearchParams();
	const allByAuthor = scope?.authorScope === "all" && ((scope.authorIds?.length ?? 0) > 0 || (scope.authors?.length ?? 0) > 0);
	if (!allByAuthor) {
		// Blocks (OR synonyms, AND between concepts) go out as a REAL boolean
		// search; without blocks the plain text keeps the legacy behavior
		// (OpenAlex ANDs plain words by itself).
		params.set("search", buildBlockSearch(scope?.blocks) || query);
	} else {
		params.set("sort", "cited_by_count:desc");
	}
	params.set("per-page", String(Math.min(rows, 200)));
	// Picked authors narrow the fetch itself: OpenAlex then returns per-page
	// papers BY those authors on the topic instead of the global relevance
	// head the post-filter would decimate. Ids win over names (exact).
	const authorFilter = buildAuthorIdFilter(scope?.authorIds) || buildAuthorSearchFilter(scope?.authors);
	// Type exclusion first, then the author filter (comma = AND).
	params.set("filter", [`type:!${OPENALEX_EXCLUDED_TYPES.join("|")}`, authorFilter].filter(Boolean).join(","));
	return params;
}

export async function searchOpenalex(query: string, rows: number, scope?: SourceScope): Promise<SourceRecord[]> {
	const params = buildWorksParams(query, rows, scope);
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

	return items.map(toSourceRecord);
}

/** One OpenAlex work object -> our record shape. Pure; shared by the
 * search above and the DOI lookup below so both paths map identically. */
export function toSourceRecord(item: Record<string, any>): SourceRecord {
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
}

/**
 * Exact lookup by DOI (no relevance ranking involved): the code-first
 * search turns DOIs found in repository READMEs into records here. Batched
 * 50 per request via OpenAlex's pipe-joined filter; DOIs OpenAlex does not
 * know are simply absent from the result. Order follows the API answer.
 */
export async function lookupOpenalexDois(dois: string[]): Promise<SourceRecord[]> {
	const unique = [...new Set(dois.map((d) => d.trim().toLowerCase()).filter(Boolean))];
	const records: SourceRecord[] = [];
	for (let i = 0; i < unique.length; i += DOI_BATCH_SIZE) {
		const batch = unique.slice(i, i + DOI_BATCH_SIZE);
		const params = new URLSearchParams({
			filter: `doi:${batch.join("|")}`,
			"per-page": String(DOI_BATCH_SIZE),
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
		records.push(...((data?.results ?? []) as Array<Record<string, any>>).map(toSourceRecord));
	}
	return records;
}

/** One bucket of a facet query below: plain API metadata. Journals and
 * authors share the shape. */
export interface Facet {
	/** OpenAlex id -- a source id ("S43295729", feeds the journal score
	 * lookup) or an author id ("A5059343226", feeds the author metrics
	 * lookup). */
	id: string;
	name: string;
	count: number;
}

/**
 * Parse the group_by buckets of an OpenAlex works response into facets
 * (the wizard's journal and author pickers). Pure and exported for offline
 * tests. Buckets without a display name (works without a source, e.g. some
 * preprints) are dropped; order is by count descending, deterministic
 * tie-break by name.
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

/** The listed head of a facet query plus everything behind it (the picker
 * shows an explicit "other ..." row, so selecting every row really means
 * "no filter"). */
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

/** Scope of a facet pre-query: the picker lists must reflect the run the
 * user is configuring -- search period and picked journals included -- not
 * the query text alone (the top authors over ALL years and journals hardly
 * ever appear in a small, scoped run's result table). */
export interface FacetScope {
	yearFrom?: number;
	yearTo?: number;
	/** OpenAlex source ids ("S...") of picked journals. */
	sourceIds?: string[];
}

/** Build the OpenAlex filter= value for a facet scope: documented from/to
 * publication-date filters plus an OR-joined source-id filter. Pure;
 * exported for offline tests. */
export function buildFacetFilter(scope: FacetScope): string {
	const parts: string[] = [];
	if (scope.yearFrom !== undefined) parts.push(`from_publication_date:${scope.yearFrom}-01-01`);
	if (scope.yearTo !== undefined) parts.push(`to_publication_date:${scope.yearTo}-12-31`);
	if (scope.sourceIds?.length) parts.push(`primary_location.source.id:${scope.sourceIds.join("|")}`);
	return parts.join(",");
}

/**
 * ONE cheap facet request over the query's works, grouped by the given
 * field -- the pre-query behind the wizard's pickers. Deterministic API
 * data; the LLM is nowhere near it.
 */
async function facetPage(query: string, groupBy: string, limit: number, scope?: FacetScope): Promise<FacetPage> {
	// NO per-page here: sending it alongside group_by makes OpenAlex return
	// a single bucket; bare group_by returns 200.
	const params = new URLSearchParams({ search: query, group_by: groupBy });
	const filter = buildFacetFilter(scope ?? {});
	if (filter) params.set("filter", filter);
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

/** Which journals do results for this query appear in (scoped to the
 * wizard's live search period). */
export function journalFacets(query: string, limit: number, scope?: FacetScope): Promise<FacetPage> {
	return facetPage(query, "primary_location.source.id", limit, scope);
}

/** Which authors publish the results for this query -- the same mechanics
 * as the journal list, one request; scoped to the live period AND the
 * picked journals. */
export function authorFacets(query: string, limit: number, scope?: FacetScope): Promise<FacetPage> {
	return facetPage(query, "authorships.author.id", limit, scope);
}
