/**
 * CrossRef client. GET https://api.crossref.org/works?query=...&rows=N
 * &sort=relevance -- a keyword relevance search (CrossRef has no boolean
 * syntax). Mapping CrossRef's response onto SourceRecord happens here, at
 * the source boundary; no field is ever invented.
 */

import { contactMailto, type SourceRecord, type SourceScope, userAgent } from "../types.ts";
import { pacedClient } from "./polite.ts";

const BASE_URL = "https://api.crossref.org/works";

/** Back-to-back requests (one per query variant) earn HTTP 429 from
 * CrossRef; one second of spacing keeps multi-variant runs clean. */
const fetchPaced = pacedClient({ label: "CrossRef", spacingMs: 1_000 });

async function fetchWorks(params: URLSearchParams): Promise<Record<string, any>> {
	const response = await fetchPaced(`${BASE_URL}?${params}`, {
		headers: { "User-Agent": userAgent(), Accept: "application/json" },
	});
	return (await response.json()) as Record<string, any>;
}

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

/**
 * Concept blocks flattened for CrossRef: CrossRef has NO boolean query
 * syntax -- its bibliographic search is relevance ranking over keywords. The honest translation of a block query is all
 * its terms as flat keywords (deduplicated, order kept); the deterministic
 * post-labeling still marks which records fully match the blocks. Pure;
 * exported for offline tests. Empty = no blocks, caller keeps the raw text.
 */
export function flattenBlockTerms(blocks: string[][] | undefined): string {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const group of blocks ?? []) {
		for (const raw of group) {
			const term = raw.replace(/"/g, "").trim();
			if (!term || seen.has(term.toLowerCase())) continue;
			seen.add(term.toLowerCase());
			terms.push(term);
		}
	}
	return terms.join(" ");
}

export async function searchCrossref(query: string, rows: number, scope?: SourceScope): Promise<SourceRecord[]> {
	const params = new URLSearchParams({
		query: flattenBlockTerms(scope?.blocks) || query,
		rows: String(rows),
		sort: "relevance",
		order: "desc",
	});
	// Picked authors go into CrossRef's author search field. The field is
	// relevance-ranked, not boolean -- the deterministic post-filter still
	// guarantees that only matching records survive.
	const authorTerms = (scope?.authors ?? []).map((name) => name.trim()).filter(Boolean);
	if (authorTerms.length) params.set("query.author", authorTerms.join(" "));
	const mailto = contactMailto();
	if (mailto) params.set("mailto", mailto);

	const data = await fetchWorks(params);
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
