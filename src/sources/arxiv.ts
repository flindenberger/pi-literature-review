/**
 * Native arXiv client (replaces the paper-search engine for this source).
 *
 * GET https://export.arxiv.org/api/query?search_query=...&max_results=N
 * with an explicit boolean expression built by buildSearchQuery (see there);
 * all: searches title, abstract, authors and categories. The response is an
 * Atom XML feed, parsed with
 * fast-xml-parser. arXiv records usually have no DOI but always an arXiv ID;
 * the ID is the citable identifier and is never discarded. A DOI is taken
 * only from the feed's doi metadata (arxiv:doi element or the rel=doi link),
 * never scraped out of abstract text.
 */

import { XMLParser } from "fast-xml-parser";
import { QUERY_STOPWORDS } from "../intake.ts";
import { type SourceRecord, type SourceScope, userAgent } from "../types.ts";

const BASE_URL = "https://export.arxiv.org/api/query";
const TIMEOUT_MS = 30_000;

/** Atom wraps text over indented lines; collapse whitespace runs. String ops only. */
function collapseWhitespace(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** fast-xml-parser yields an object for a single child, an array for many. */
function asArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function extractDoi(entry: Record<string, any>): string {
	const element = entry["arxiv:doi"];
	const fromElement = typeof element === "string" ? element : element?.["#text"];
	if (typeof fromElement === "string" && fromElement.trim()) return fromElement.trim();
	for (const link of asArray<Record<string, any>>(entry.link)) {
		if (link?.["@_title"] === "doi" && typeof link?.["@_href"] === "string") {
			return link["@_href"].replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
		}
	}
	return "";
}

/**
 * Build the arXiv search_query expression.
 *
 * arXiv treats unquoted space-separated words as OR with similarity ranking;
 * on topics arXiv does not cover, the ranking degenerates and stray tokens
 * like the "2" in "Sentinel 2" pull in unrelated papers (the ALOHA 2
 * incident, design/2026-07-14_v18). Therefore: tokenize, bind standalone
 * single characters to the neighbouring word (previous preferred) as a
 * quoted phrase, and join the units with explicit AND. Zero hits from a
 * source that has nothing on the topic is the honest answer.
 *
 * Function words are dropped before building the expression (v30.1 field
 * finding: `all:using` as an AND clause made arXiv's backend hang for 60s
 * or answer 429, while the same expression without it answered within
 * seconds -- an everyday word matches half the corpus and the AND join
 * turns that into an expensive intersection). The list is shared with the
 * grouping derivation (QUERY_STOPWORDS), so the arXiv expression and the
 * derived term groups stay consistent.
 *
 * Two pass-through cases keep the user in control: a query that already
 * carries uppercase operators or quotes is the user's own arXiv syntax, and
 * a query without any usable content word offers nothing to anchor on --
 * both go out in the legacy all:<query> form unchanged.
 *
 * Picked authors (v30.14 user decision) join as an AND-linked au: clause --
 * the source then FETCHES papers by those authors on the topic instead of
 * the post-filter dropping everything the topic query happened to return.
 * Both sides are parenthesized so the clause composes with every query
 * form, including the legacy pass-throughs.
 */
export function buildSearchQuery(query: string, authors?: string[], blocks?: string[][]): string {
	const trimmed = query.trim().replace(/\s+/g, " ");
	const hasOperators = /(^|\s)(AND|OR|NOT|ANDNOT)(\s|$)/.test(trimmed) || trimmed.includes('"');
	const tokens = trimmed.toLowerCase().split(" ").filter(Boolean);
	const withAuthors = (expression: string): string => {
		const names = (authors ?? [])
			.map((name) => name.replace(/["|,]/g, " ").replace(/\s+/g, " ").trim())
			.filter(Boolean);
		if (!names.length) return expression;
		return `(${expression}) AND (${names.map((name) => `au:"${name}"`).join(" OR ")})`;
	};
	// Concept blocks (2026-08-06 block search): OR-synonyms per block become
	// a parenthesized OR clause, blocks join with AND -- the same structure
	// that labels on_target. Multi-word terms stay quoted phrases. Blocks
	// win over the token derivation below; the field-syntax/quote escape
	// hatch never gets blocks (queryBlocks hands off there).
	const groups = (blocks ?? [])
		.map((group) => group.map((term) => term.replace(/"/g, "").trim().toLowerCase()).filter(Boolean))
		.filter((group) => group.length);
	if (groups.length) {
		return withAuthors(groups
			.map((group) => {
				const terms = group.map((term) => (term.includes(" ") ? `all:"${term}"` : `all:${term}`));
				return terms.length > 1 ? `(${terms.join(" OR ")})` : terms[0];
			})
			.join(" AND "));
	}
	if (hasOperators || !tokens.some((token) => token.length > 1)) return withAuthors(`all:${trimmed}`);

	const units: string[][] = [];
	let leading: string[] = []; // single chars with no word yet; bound to the next word
	for (const token of tokens) {
		if (QUERY_STOPWORDS.has(token)) continue;
		if (token.length === 1) {
			if (units.length) units[units.length - 1].push(token);
			else leading.push(token);
		} else {
			units.push([...leading, token]);
			leading = [];
		}
	}
	if (!units.length) return withAuthors(`all:${trimmed}`); // nothing but function words
	return withAuthors(units
		.map((unit) => (unit.length === 1 ? `all:${unit[0]}` : `all:"${unit.join(" ")}"`))
		.join(" AND "));
}

/** Parse an arXiv Atom feed into records; shared by the relevance search
 * and the exact id_list lookup (PDF adoption). Exported for offline tests. */
export function parseArxivFeed(xml: string): SourceRecord[] {
	const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
	const feed = parser.parse(xml)?.feed ?? {};

	return asArray<Record<string, any>>(feed.entry).map((entry) => {
		// entry.id is https://arxiv.org/abs/<arxiv_id>; the last path segment
		// (including its version suffix) is the citable arXiv ID.
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		const arxivId = id.split("/").pop() ?? "";
		const pdfLink = asArray<Record<string, any>>(entry.link).find(
			(link) => link?.["@_type"] === "application/pdf" && link?.["@_href"],
		);
		const published = typeof entry.published === "string" ? entry.published : "";

		return {
			title: collapseWhitespace(entry.title),
			authors: asArray<Record<string, any>>(entry.author)
				.map((author) => collapseWhitespace(author?.name))
				.filter(Boolean),
			year: /^\d{4}/.test(published) ? published.slice(0, 4) : null,
			venue: "",
			doi: extractDoi(entry),
			arxiv_id: arxivId,
			pdf_url: pdfLink ? String(pdfLink["@_href"]).trim() : "",
			url: id,
			cites: null,
			source: "arxiv",
			abstract: collapseWhitespace(entry.summary),
		};
	});
}

/** arXiv's API terms ask for no more than one request every 3 seconds; 429
 * (and 503) is how it answers a client that comes back faster. Field runs
 * 2026-07-29: several wizard test searches in a row hit 429 on EVERY run --
 * the client must pace itself and ride a rate-limit answer out instead of
 * reporting the source as failed. */
const REQUEST_SPACING_MS = 3_000;
const RETRY_DELAYS_MS = [5_000, 15_000];

/** Earliest time the next arXiv request may go out (module-wide: query
 * variants in one run AND back-to-back runs in one pi session share it). */
let nextRequestAt = 0;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before retry number `attempt + 1` after a rate-limit
 * answer, or null when the attempts are used up. A sane numeric Retry-After
 * header wins over the fixed backoff; a huge one (arXiv sometimes says
 * "come back tomorrow") is not worth blocking a run for -- give up then.
 * Pure; exported for offline tests.
 */
export function retryDelayMs(attempt: number, retryAfter: string | null): number | null {
	if (attempt >= RETRY_DELAYS_MS.length) return null;
	const trimmed = retryAfter?.trim() ?? "";
	if (/^\d+$/.test(trimmed)) {
		const ms = Number(trimmed) * 1000;
		if (ms > 60_000) return null;
		if (ms > 0) return ms;
	}
	return RETRY_DELAYS_MS[attempt];
}

async function fetchFeed(params: URLSearchParams): Promise<SourceRecord[]> {
	for (let attempt = 0; ; attempt++) {
		const wait = nextRequestAt - Date.now();
		if (wait > 0) await sleep(wait);
		nextRequestAt = Date.now() + REQUEST_SPACING_MS;
		const response = await fetch(`${BASE_URL}?${params}`, {
			headers: { "User-Agent": userAgent() },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (response.ok) return parseArxivFeed(await response.text());
		const rateLimited = response.status === 429 || response.status === 503;
		const delay = rateLimited ? retryDelayMs(attempt, response.headers.get("retry-after")) : null;
		if (delay === null) {
			throw new Error(
				`arXiv answered HTTP ${response.status}`
				+ (rateLimited && attempt ? ` (rate limited; ${attempt} retr${attempt === 1 ? "y" : "ies"} did not clear it)` : ""),
			);
		}
		await sleep(delay);
	}
}

export async function searchArxiv(query: string, rows: number, scope?: SourceScope): Promise<SourceRecord[]> {
	return fetchFeed(new URLSearchParams({
		search_query: buildSearchQuery(query, scope?.authors, scope?.blocks),
		max_results: String(rows),
		sortBy: "relevance",
		sortOrder: "descending",
	}));
}

/** Exact lookup by arXiv IDs (no relevance ranking involved) -- used by
 * PDF adoption to turn an ID found in a PDF into a verified record. */
export async function lookupArxivIds(ids: string[]): Promise<SourceRecord[]> {
	if (!ids.length) return [];
	return fetchFeed(new URLSearchParams({
		id_list: ids.join(","),
		max_results: String(ids.length),
	}));
}
