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
import { type SourceRecord, userAgent } from "../types.ts";

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
 * Two pass-through cases keep the user in control: a query that already
 * carries uppercase operators or quotes is the user's own arXiv syntax, and
 * a query without any multi-character word offers nothing to anchor on --
 * both go out in the legacy all:<query> form unchanged.
 */
export function buildSearchQuery(query: string): string {
	const trimmed = query.trim().replace(/\s+/g, " ");
	const hasOperators = /(^|\s)(AND|OR|NOT|ANDNOT)(\s|$)/.test(trimmed) || trimmed.includes('"');
	const tokens = trimmed.toLowerCase().split(" ").filter(Boolean);
	if (hasOperators || !tokens.some((token) => token.length > 1)) return `all:${trimmed}`;

	const units: string[][] = [];
	let leading: string[] = []; // single chars with no word yet; bound to the next word
	for (const token of tokens) {
		if (token.length === 1) {
			if (units.length) units[units.length - 1].push(token);
			else leading.push(token);
		} else {
			units.push([...leading, token]);
			leading = [];
		}
	}
	return units
		.map((unit) => (unit.length === 1 ? `all:${unit[0]}` : `all:"${unit.join(" ")}"`))
		.join(" AND ");
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
	const response = await fetch(`${BASE_URL}?${params}`, {
		headers: { "User-Agent": userAgent() },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`arXiv answered HTTP ${response.status}`);
	}
	return parseArxivFeed(await response.text());
}

export async function searchArxiv(query: string, rows: number): Promise<SourceRecord[]> {
	return fetchFeed(new URLSearchParams({
		search_query: buildSearchQuery(query),
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
