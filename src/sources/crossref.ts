/**
 * Native CrossRef client (replaces the paper-search engine for this source).
 *
 * GET https://api.crossref.org/works?query=...&rows=N&sort=relevance
 * mirrors the engine's request shape so results stay comparable with the
 * Python oracle. Mapping CrossRef's response onto SourceRecord happens here,
 * at the source boundary; no field is ever invented.
 */

import { contactMailto, type SourceRecord, type SourceScope, userAgent } from "../types.ts";
import { retryDelayMs } from "./arxiv.ts";

const BASE_URL = "https://api.crossref.org/works";
const TIMEOUT_MS = 30_000;

/** CrossRef politeness (2026-08-06 field finding: a five-variant run fired
 * five requests back-to-back and the last two answered HTTP 429): the same
 * pattern as the arXiv client since v30.13 -- module-wide request spacing
 * (shared across query variants in a run AND across runs in one pi
 * session) plus a rate-limit retry that honors a sane numeric Retry-After
 * (retryDelayMs is the shared pure helper). */
const REQUEST_SPACING_MS = 1_000;

/** Earliest time the next CrossRef request may go out. */
let nextRequestAt = 0;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWorks(params: URLSearchParams): Promise<Record<string, any>> {
	for (let attempt = 0; ; attempt++) {
		const wait = nextRequestAt - Date.now();
		if (wait > 0) await sleep(wait);
		nextRequestAt = Date.now() + REQUEST_SPACING_MS;
		const response = await fetch(`${BASE_URL}?${params}`, {
			headers: { "User-Agent": userAgent(), Accept: "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (response.ok) return (await response.json()) as Record<string, any>;
		const rateLimited = response.status === 429 || response.status === 503;
		const delay = rateLimited ? retryDelayMs(attempt, response.headers.get("retry-after")) : null;
		if (delay === null) {
			throw new Error(
				`CrossRef answered HTTP ${response.status}`
				+ (rateLimited && attempt
					? ` (rate limited; ${attempt} retr${attempt === 1 ? "y" : "ies"} did not clear it)`
					: ""),
			);
		}
		await sleep(delay);
	}
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
 * Concept blocks flattened for CrossRef (2026-08-06 block search): CrossRef
 * has NO boolean query syntax -- its bibliographic search is relevance
 * ranking over keywords. The honest translation of a block query is all
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
	// Picked authors go into CrossRef's author search field (v30.14). The
	// field is relevance-ranked, not boolean -- the deterministic post-filter
	// still guarantees that only matching records survive.
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
