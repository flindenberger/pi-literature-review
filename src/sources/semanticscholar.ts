/**
 * Semantic Scholar client (login-free API, optional free key via the config
 * pattern, never a dialog).
 *
 * Endpoint: GET https://api.semanticscholar.org/graph/v1/paper/search/bulk
 * -- the BULK endpoint, because it is the only one with boolean query
 * syntax: `+term` = required, `a | b` = OR, `-term` = exclude, quoted
 * phrases, parentheses (the relevance endpoint /paper/search accepts no
 * operators). The block search maps onto it: (a OR b) AND (c) -> `+(a | b)
 * +c`. Trade-off, disclosed in the HTML meta: bulk has NO relevance
 * ranking, so results are requested sorted by citationCount:desc -- the
 * most cited matching papers, not the "most relevant".
 *
 * Rate limits: with a free API key 1 request per second; WITHOUT one only a
 * shared anonymous pool that can answer HTTP 429 for minutes. The client
 * paces and retries like the other sources, then fails loudly with a
 * get-a-key hint -- runSearch records the failure in source_failures and
 * the run continues with the other sources. Key precedence:
 * PI_LITERATURE_REVIEW_S2_API_KEY > config.json s2ApiKey.
 */

import { s2ApiKey } from "../config.ts";
import { type SourceRecord, type SourceScope, userAgent } from "../types.ts";
import { pacedClient } from "./polite.ts";

const GRAPH_URL = "https://api.semanticscholar.org/graph/v1/paper";
const BASE_URL = GRAPH_URL + "/search/bulk";
const FIELDS = "title,year,venue,externalIds,citationCount,openAccessPdf,abstract,authors";

/** Key tier allows 1 request/second; the anonymous pool is stricter, not
 * looser -- one spacing for both keeps the client honest everywhere. A 404
 * is passed through (the abstract lookup reads it as "unknown DOI"). */
const fetchPaced = pacedClient({
	label: "Semantic Scholar",
	spacingMs: 1_100,
	passStatuses: [404],
	rateLimitHint: "the anonymous shared pool is heavily contended; a FREE API key lifts this"
		+ " (semanticscholar.org/product/api; store it as s2ApiKey in config.json or"
		+ " PI_LITERATURE_REVIEW_S2_API_KEY)",
});

/**
 * Concept blocks as bulk boolean syntax (pure, exported for tests):
 * every block is a required group (`+`), synonyms OR-join with `|`,
 * multi-word terms are quoted phrases. No blocks -> the raw query text
 * passes through unchanged (bulk treats plain words as loose matching;
 * quoted/field-syntax queries stay the user's business).
 */
export function buildBulkQuery(query: string, blocks?: string[][]): string {
	const groups = (blocks ?? []).map((group) => group.map((term) => term.replace(/"/g, "").trim()).filter(Boolean))
		.filter((group) => group.length);
	if (!groups.length) return query;
	const printed = (term: string): string => (/\s/.test(term) ? `"${term}"` : term);
	return groups
		.map((group) => (group.length === 1 ? `+${printed(group[0])}` : `+(${group.map(printed).join(" | ")})`))
		.join(" ");
}

/** Map one bulk-endpoint paper onto the common record shape. Pure; every
 * field traces to the API response, absent fields stay honestly empty. */
export function toSourceRecord(paper: Record<string, any>): SourceRecord {
	const externalIds = (paper.externalIds ?? {}) as Record<string, unknown>;
	const doi = typeof externalIds.DOI === "string" ? externalIds.DOI.trim() : "";
	const arxivId = typeof externalIds.ArXiv === "string" ? externalIds.ArXiv.trim() : "";
	const paperId = typeof paper.paperId === "string" ? paper.paperId : "";
	return {
		title: typeof paper.title === "string" ? paper.title.trim() : "",
		authors: ((paper.authors ?? []) as Array<Record<string, unknown>>)
			.map((author) => (typeof author?.name === "string" ? author.name.trim() : ""))
			.filter(Boolean),
		year: Number.isInteger(paper.year) ? String(paper.year) : null,
		venue: typeof paper.venue === "string" ? paper.venue.trim() : "",
		doi,
		arxiv_id: arxivId,
		pdf_url: typeof paper.openAccessPdf?.url === "string" ? paper.openAccessPdf.url.trim() : "",
		url: doi ? `https://doi.org/${doi}`
			: arxivId ? `https://arxiv.org/abs/${arxivId}`
			: paperId ? `https://www.semanticscholar.org/paper/${paperId}`
			: "",
		cites: typeof paper.citationCount === "number" && Number.isFinite(paper.citationCount)
			? paper.citationCount
			: null,
		source: "semanticscholar",
		abstract: typeof paper.abstract === "string" ? paper.abstract.trim() : "",
	};
}

/** URL of the single-paper abstract lookup (pure, exported for tests). */
export function abstractLookupUrl(doi: string): string {
	return `${GRAPH_URL}/DOI:${encodeURIComponent(doi)}?fields=abstract`;
}

/**
 * Abstract of one paper by DOI: the second abstract source behind the
 * OpenAlex lookup in enrichment (OpenAlex carries no abstract for many
 * Elsevier papers that Semantic Scholar does have). Same pacing, key and
 * retry mechanics as the search; an unknown DOI (HTTP 404) is null, not an
 * error.
 */
export async function fetchAbstractByDoi(doi: string): Promise<string | null> {
	const data = await fetchS2(abstractLookupUrl(doi), s2ApiKey());
	const abstract = typeof data?.abstract === "string" ? data.abstract.trim() : "";
	return abstract || null;
}

/** One paced, retrying GET with the optional API key; null on 404 (the
 * bulk search never 404s, the abstract lookup does for unknown DOIs). */
async function fetchS2(url: string, apiKey: string): Promise<Record<string, any> | null> {
	const response = await fetchPaced(url, {
		headers: {
			"User-Agent": userAgent(),
			Accept: "application/json",
			...(apiKey ? { "x-api-key": apiKey } : {}),
		},
	});
	if (response.status === 404) return null;
	return (await response.json()) as Record<string, any>;
}

/**
 * Search Semantic Scholar. The concept blocks become a real boolean bulk
 * query; picked authors are NOT pushed into the request -- the bulk
 * endpoint has no author search field (unlike arXiv au:, CrossRef
 * query.author, OpenAlex raw_author_name.search), so the deterministic
 * post-filter alone guarantees the author scope here.
 */
export async function searchSemanticScholar(
	query: string,
	limit: number,
	scope?: SourceScope,
): Promise<SourceRecord[]> {
	const params = new URLSearchParams({
		query: buildBulkQuery(query, scope?.blocks),
		limit: String(limit),
		sort: "citationCount:desc",
		fields: FIELDS,
	});
	const data = (await fetchS2(`${BASE_URL}?${params}`, s2ApiKey())) ?? {};
	const papers: Array<Record<string, any>> = Array.isArray(data?.data) ? data.data : [];
	return papers.slice(0, limit).map(toSourceRecord);
}
