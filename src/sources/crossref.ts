/**
 * Native CrossRef client (replaces the paper-search engine for this source).
 *
 * GET https://api.crossref.org/works?query=...&rows=N&sort=relevance
 * mirrors the engine's request shape so results stay comparable with the
 * Python oracle. Mapping CrossRef's response onto SourceRecord happens here,
 * at the source boundary; no field is ever invented.
 */

import { contactMailto, type SourceRecord, type SourceScope, userAgent } from "../types.ts";

const BASE_URL = "https://api.crossref.org/works";
const TIMEOUT_MS = 30_000;

/** CrossRef ships title/container-title as arrays of strings. */
function firstString(value: unknown): string {
	if (Array.isArray(value)) value = value[0];
	return typeof value === "string" ? value.trim() : "";
}

function extractAuthors(item: Record<string, unknown>): string[] {
	const authors: string[] = [];
	for (const author of (item.author as Array<Record<string, string>>) ?? []) {
		const name = [author.given, author.family].filter(Boolean).join(" ").trim();
		if (name) authors.push(name);
	}
	return authors;
}

/** Year from date-parts, preferring print/online publication over deposit. */
function extractYear(item: Record<string, any>): string | null {
	for (const field of ["published", "issued", "created"]) {
		const year = item[field]?.["date-parts"]?.[0]?.[0];
		if (Number.isInteger(year)) return String(year);
	}
	return null;
}

function extractPdfUrl(item: Record<string, any>): string {
	for (const link of item.link ?? []) {
		if (link?.["content-type"] === "application/pdf" && link?.URL) {
			return String(link.URL).trim();
		}
	}
	return "";
}

/** Remove <jats:...> markup from CrossRef abstracts. String ops only. */
function stripJats(abstract: unknown): string {
	if (typeof abstract !== "string") return "";
	return abstract.replace(/<\/?jats:[a-zA-Z]+[^>]*>/g, "").trim();
}

export async function searchCrossref(query: string, rows: number, scope?: SourceScope): Promise<SourceRecord[]> {
	const params = new URLSearchParams({
		query,
		rows: String(rows),
		sort: "relevance",
		order: "desc",
	});
	// Picked authors go into CrossRef's author search field (v30.14). The
	// field is relevance-ranked, not boolean -- the deterministic post-filter
	// still guarantees that only matching records survive.
	const authorTerms = (scope?.authors ?? []).map((name) => name.trim()).filter(Boolean);
	if (authorTerms.length) params.set("query.author", authorTerms.join(" "));
	const mailto = contactMailto();
	if (mailto) params.set("mailto", mailto);

	const response = await fetch(`${BASE_URL}?${params}`, {
		headers: { "User-Agent": userAgent(), Accept: "application/json" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`CrossRef answered HTTP ${response.status}`);
	}
	const data = (await response.json()) as Record<string, any>;
	const items: Array<Record<string, any>> = data?.message?.items ?? [];

	return items.map((item) => {
		const doi = typeof item.DOI === "string" ? item.DOI.trim() : "";
		return {
			title: firstString(item.title),
			authors: extractAuthors(item),
			year: extractYear(item),
			venue: firstString(item["container-title"]),
			doi,
			arxiv_id: "",
			pdf_url: extractPdfUrl(item),
			url: typeof item.URL === "string" && item.URL.trim()
				? item.URL.trim()
				: doi ? `https://doi.org/${doi}` : "",
			cites: Number.isInteger(item["is-referenced-by-count"])
				? (item["is-referenced-by-count"] as number)
				: null,
			source: "crossref",
			abstract: stripJats(item.abstract),
		};
	});
}
