/**
 * arXiv client. GET https://export.arxiv.org/api/query?search_query=...
 * with an explicit boolean expression built by buildSearchQuery (all:
 * searches title, abstract, authors and categories); the response is an
 * Atom XML feed parsed with fast-xml-parser. arXiv records usually have no
 * DOI but always an arXiv ID; the ID is the citable identifier and is never
 * discarded. A DOI is taken only from the feed's doi metadata (arxiv:doi
 * element or the rel=doi link), never scraped out of abstract text.
 */

import { XMLParser } from "fast-xml-parser";
import { QUERY_STOPWORDS } from "../intake.ts";
import { type SourceRecord, type SourceScope, userAgent } from "../types.ts";
import { pacedClient } from "./polite.ts";

const BASE_URL = "https://export.arxiv.org/api/query";

/** arXiv's API terms ask for no more than one request every 3 seconds; 429
 * (and 503) is how it answers a client that comes back faster. */
const fetchPaced = pacedClient({ label: "arXiv", spacingMs: 3_000 });

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
 * Concept blocks win: OR-synonyms per block become a parenthesized OR
 * clause, blocks join with AND -- the same structure that labels on_target;
 * multi-word terms stay quoted phrases. Without blocks the plain query is
 * tokenized: arXiv treats unquoted space-separated words as OR with
 * similarity ranking, and on topics arXiv does not cover stray tokens like
 * the "2" in "Sentinel 2" pull in unrelated papers -- so standalone single
 * characters bind to the neighbouring word as a quoted phrase and the units
 * join with explicit AND. Zero hits from a source that has nothing on the
 * topic is the honest answer.
 *
 * Function words are dropped first (an AND clause over an everyday word
 * like "using" makes arXiv's backend time out or rate-limit); the list is
 * shared with the block derivation (QUERY_STOPWORDS), so the arXiv
 * expression and the derived blocks stay consistent.
 *
 * Two pass-through cases keep the user in control: a query that already
 * carries uppercase operators or quotes is the user's own arXiv syntax, and
 * a query without any usable content word offers nothing to anchor on --
 * both go out as all:<query> unchanged.
 *
 * Picked authors join as an AND-linked au: clause so the source FETCHES
 * papers by those authors on the topic; both sides are parenthesized so the
 * clause composes with every query form.
 */
export function buildSearchQuery(query: string, authors?: string[], blocks?: string[][], authorsOnly = false): string {
	const trimmed = query.trim().replace(/\s+/g, " ");
	const hasOperators = /(^|\s)(AND|OR|NOT|ANDNOT)(\s|$)/.test(trimmed) || trimmed.includes('"');
	const tokens = trimmed.toLowerCase().split(" ").filter(Boolean);
	const names = (authors ?? [])
		.map((name) => name.replace(/["|,]/g, " ").replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const authorClause = names.map((name) => `au:"${name}"`).join(" OR ");
	// Author scope "all": the au: clause alone -- the picked authors' papers
	// regardless of the topic.
	if (authorsOnly && names.length) return names.length > 1 ? `(${authorClause})` : authorClause;
	const withAuthors = (expression: string): string => {
		if (!names.length) return expression;
		return `(${expression}) AND (${authorClause})`;
	};
	// Blocks win over the token derivation below; the field-syntax/quote
	// escape hatch never gets blocks (queryBlocks hands off there).
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

async function fetchFeed(params: URLSearchParams): Promise<SourceRecord[]> {
	const response = await fetchPaced(`${BASE_URL}?${params}`, { headers: { "User-Agent": userAgent() } });
	return parseArxivFeed(await response.text());
}

export async function searchArxiv(query: string, rows: number, scope?: SourceScope): Promise<SourceRecord[]> {
	return fetchFeed(new URLSearchParams({
		search_query: buildSearchQuery(query, scope?.authors, scope?.blocks, scope?.authorScope === "all"),
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
