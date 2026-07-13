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
