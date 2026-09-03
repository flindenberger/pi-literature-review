/**
 * Hugging Face Papers search: the strongest code-first source. One request
 * per query returns arXiv papers ranked over title and summary, each with
 * its arXiv id and -- for roughly half of them -- the GitHub repository
 * linked on the paper's Hugging Face page (community-linked, not an author
 * declaration; the results page says so). The endpoint is the site's own,
 * undocumented API: the parser fails loudly on a shape change and an
 * offline test pins the shape measured on 2026-09-03. No key involved;
 * measured limit 50 searches per 5 minutes.
 */

import { userAgent } from "../types.ts";
import { flattenBlockTerms } from "./crossref.ts";
import { pacedClient } from "./polite.ts";

const SEARCH_URL = "https://huggingface.co/api/papers/search";
/** 50 searches / 300 s measured in the response headers -> one per 6 s. */
const fetchPaced = pacedClient({ label: "Hugging Face", spacingMs: 6_000, rateLimitStatuses: [429, 503] });

export interface HfPaper {
	arxivId: string;
	title: string;
	/** Canonical https://github.com/<owner>/<repo> or null. */
	repoUrl: string | null;
	stars: number | null;
}

/** The search text sent to Hugging Face: the block terms flattened (its
 * search has no boolean syntax), else the plain query. Pure. */
export function buildHfQuery(query: string, blocks?: string[][]): string {
	return flattenBlockTerms(blocks) || query.trim();
}

/** Parse the search answer. Throws when the shape is not the measured
 * array-of-{paper} form, so a silent API change never yields nothing. */
export function parseHfPapers(data: unknown): HfPaper[] {
	if (!Array.isArray(data)) throw new Error("Hugging Face papers search: unexpected response shape (expected an array)");
	const papers: HfPaper[] = [];
	for (const entry of data as Array<Record<string, any>>) {
		const paper = entry?.paper;
		if (!paper || typeof paper !== "object") throw new Error("Hugging Face papers search: entry without a paper object");
		const id = typeof paper.id === "string" ? paper.id.trim() : "";
		if (!/^\d{4}\.\d{4,5}$/.test(id)) continue;
		const repo = typeof paper.githubRepo === "string" ? paper.githubRepo.trim() : "";
		const match = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(repo);
		papers.push({
			arxivId: id,
			title: typeof paper.title === "string" ? paper.title.replace(/\s+/g, " ").trim() : "",
			repoUrl: match ? `https://github.com/${match[1]}/${match[2]}` : null,
			stars: Number.isInteger(paper.githubStars) ? (paper.githubStars as number) : null,
		});
	}
	return papers;
}

/** One search; `limit` caps the answer (the API returns up to 120). */
export async function searchHfPapers(text: string, limit: number): Promise<HfPaper[]> {
	const params = new URLSearchParams({ q: text, limit: String(Math.max(1, Math.min(120, limit))) });
	const response = await fetchPaced(`${SEARCH_URL}?${params}`, {
		headers: { "User-Agent": userAgent(), Accept: "application/json" },
	});
	return parseHfPapers(await response.json());
}
