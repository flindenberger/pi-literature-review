/**
 * CrossRef client. GET https://api.crossref.org/works?query=...&rows=N
 * &sort=relevance -- a keyword relevance search (CrossRef has no boolean
 * syntax). Mapping CrossRef's response onto SourceRecord happens here, at
 * the source boundary; no field is ever invented.
 */

import { contactMailto, type DataLink, type SourceRecord, type SourceScope, userAgent } from "../types.ts";
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

/** The parameters of one works request: the flattened block terms (or
 * the plain text) plus the author field; with author scope "all" the text
 * query is dropped and the author field alone is sent. Relevance order in
 * BOTH cases -- measured 2026-09-14: query.author alone by relevance gave
 * 10/10 papers of the wanted author, sorted by citation count 0/10 (the
 * name match is loose, citation order surfaces unrelated mega-cited
 * works). Pure; exported so the payload can show what was sent. */
/** Record types requested from CrossRef: scholarly works only. CrossRef
 * knows no negative filter, so this is the positive list; it keeps out
 * peer-review reports and author replies of open review platforms
 * (Copernicus "Reply on RC1", typed peer-review), datasets, journal
 * issues, components, grants and standards. */
export const CROSSREF_WORK_TYPES = [
	"journal-article", "proceedings-article", "posted-content", "book-chapter",
	"book", "monograph", "edited-book", "report", "dissertation",
];

export function buildCrossrefParams(query: string, rows: number, scope?: SourceScope): URLSearchParams {
	const authorTerms = (scope?.authors ?? []).map((name) => name.trim()).filter(Boolean);
	const allByAuthor = scope?.authorScope === "all" && authorTerms.length > 0;
	const params = new URLSearchParams({
		...(allByAuthor ? {} : { query: flattenBlockTerms(scope?.blocks) || query }),
		rows: String(rows),
		sort: "relevance",
		order: "desc",
		filter: CROSSREF_WORK_TYPES.map((type) => `type:${type}`).join(","),
	});
	// Picked authors go into CrossRef's author search field. The field is
	// relevance-ranked, not boolean -- the deterministic post-filter still
	// guarantees that only matching records survive.
	if (authorTerms.length) params.set("query.author", authorTerms.join(" "));
	return params;
}

export async function searchCrossref(query: string, rows: number, scope?: SourceScope): Promise<SourceRecord[]> {
	const params = buildCrossrefParams(query, rows, scope);
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

/* ---------------- Data and code links from CrossRef relation metadata ---------------- */

/** Relation types that point from a paper to its own material. Copernicus
 * journals deposit their "Code and data availability" assets as
 * is-part-of; other publishers use is-supplemented-by or references.
 * Preprint, review and comment relations are never material. */
export const DATA_RELATION_TYPES = ["is-supplemented-by", "is-part-of", "references"];

/** Known data and code archives, matched by DOI prefix or by URL. A target
 * outside this list is not shown: the relation field also carries links to
 * other papers, which are not material. */
export const DATA_ARCHIVES: Array<{ archive: string; doi?: RegExp; url?: RegExp }> = [
	{ archive: "Zenodo", doi: /^10\.5281\/zenodo\./i, url: /^https?:\/\/(?:www\.)?zenodo\.org\//i },
	{ archive: "PANGAEA", doi: /^10\.1594\/pangaea\./i, url: /^https?:\/\/(?:doi\.)?pangaea\.de\//i },
	{ archive: "Mendeley Data", doi: /^10\.17632\//, url: /^https?:\/\/data\.mendeley\.com\//i },
	{ archive: "Dryad", doi: /^10\.5061\/dryad\./i, url: /^https?:\/\/(?:www\.)?datadryad\.org\//i },
	{ archive: "figshare", doi: /^10\.6084\/m9\.figshare\./i, url: /^https?:\/\/(?:[\w-]+\.)?figshare\.com\//i },
	{ archive: "Dataverse", doi: /^10\.7910\/dvn\//i, url: /^https?:\/\/dataverse\.[\w.-]+\//i },
	{ archive: "HydroShare", doi: /^10\.4211\//, url: /^https?:\/\/(?:www\.)?hydroshare\.org\//i },
	{ archive: "OSF", doi: /^10\.17605\/osf\.io\//i, url: /^https?:\/\/osf\.io\/\w+/i },
	{ archive: "Eawag", doi: /^10\.25678\//, url: /^https?:\/\/opendata\.eawag\.ch\//i },
	{ archive: "GitHub", url: /^https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+/i },
	{ archive: "GitLab", url: /^https?:\/\/(?:www\.)?gitlab\.com\/[\w.-]+\/[\w.-]+/i },
];

/** The archive a relation target belongs to, with the link to show, or
 * null for anything outside DATA_ARCHIVES. DOIs become doi.org links;
 * a doi.org URL is read as its DOI. Pure. */
export function dataLinkFor(idType: unknown, id: unknown): DataLink | null {
	if (typeof id !== "string" || !id.trim()) return null;
	let value = id.trim();
	let kind = typeof idType === "string" ? idType.toLowerCase() : "";
	const doiUrl = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(value);
	if (doiUrl) {
		value = decodeURIComponent(doiUrl[1]);
		kind = "doi";
	}
	if (kind === "doi") {
		const archive = DATA_ARCHIVES.find((entry) => entry.doi?.test(value));
		return archive ? { url: `https://doi.org/${value}`, archive: archive.archive } : null;
	}
	if (/^https?:\/\//i.test(value)) {
		const archive = DATA_ARCHIVES.find((entry) => entry.url?.test(value));
		return archive ? { url: value.replace(/[.,;]+$/, ""), archive: archive.archive } : null;
	}
	return null;
}

/** Data and code links from one CrossRef `relation` object: only the
 * material relation types, only known archives, each link once (case-
 * insensitive), in the order CrossRef lists them. Pure. */
export function dataLinksFromRelation(relation: unknown): DataLink[] {
	if (!relation || typeof relation !== "object") return [];
	const links: DataLink[] = [];
	const seen = new Set<string>();
	for (const type of DATA_RELATION_TYPES) {
		const targets = (relation as Record<string, unknown>)[type];
		if (!Array.isArray(targets)) continue;
		for (const target of targets as Array<Record<string, unknown>>) {
			const link = dataLinkFor(target?.["id-type"], target?.id);
			if (!link || seen.has(link.url.toLowerCase())) continue;
			seen.add(link.url.toLowerCase());
			links.push(link);
		}
	}
	return links;
}

/** DOIs per relation lookup; 40 keeps the filter URL short. */
const RELATION_BATCH_SIZE = 40;

/**
 * Data and code links for a list of DOIs, keyed by lower-case DOI. One
 * batched request per 40 DOIs (filter doi:a,doi:b,..., only the DOI and
 * relation fields), through the paced CrossRef client. DOIs CrossRef does
 * not hold (arXiv's DataCite DOIs, for example) are simply absent from the
 * answer; DOIs containing a comma are skipped because the filter syntax
 * cannot carry them. Records without links are absent from the map. A
 * non-2xx answer throws; the caller degrades.
 */
export async function lookupDataLinksByDoi(dois: string[]): Promise<Map<string, DataLink[]>> {
	const unique = [...new Set(dois.map((doi) => doi.trim().toLowerCase())
		.filter((doi) => doi && !doi.includes(",") && !doi.startsWith("10.48550/")))];
	const links = new Map<string, DataLink[]>();
	for (let i = 0; i < unique.length; i += RELATION_BATCH_SIZE) {
		const batch = unique.slice(i, i + RELATION_BATCH_SIZE);
		const params = new URLSearchParams({
			filter: batch.map((doi) => `doi:${doi}`).join(","),
			select: "DOI,relation",
			rows: String(batch.length),
		});
		const mailto = contactMailto();
		if (mailto) params.set("mailto", mailto);
		const data = await fetchWorks(params);
		for (const item of (data?.message?.items ?? []) as Array<Record<string, any>>) {
			const doi = typeof item?.DOI === "string" ? item.DOI.trim().toLowerCase() : "";
			const found = dataLinksFromRelation(item?.relation);
			if (doi && found.length) links.set(doi, found);
		}
	}
	return links;
}
