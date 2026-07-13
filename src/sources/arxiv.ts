/**
 * Native arXiv client (replaces the paper-search engine for this source).
 *
 * GET https://export.arxiv.org/api/query?search_query=all:...&max_results=N
 * mirrors the engine's request shape; all: searches title, abstract, authors
 * and categories. The response is an Atom XML feed, parsed with
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

export async function searchArxiv(query: string, rows: number): Promise<SourceRecord[]> {
	const params = new URLSearchParams({
		search_query: `all:${query}`,
		max_results: String(rows),
		sortBy: "relevance",
		sortOrder: "descending",
	});

	const response = await fetch(`${BASE_URL}?${params}`, {
		headers: { "User-Agent": userAgent() },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`arXiv answered HTTP ${response.status}`);
	}
	const xml = await response.text();
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
