/**
 * GitHub client shared by both code directions: the paper-first code-link
 * lookup (enrich.ts) and the code-first searchers (codesearch.ts). One
 * module-level pacer so both stay inside GitHub's search budget together
 * (10 requests/min anonymous, 30/min with a token); raw README fetches go
 * to raw.githubusercontent.com, which has no API rate limit, behind their
 * own gentle pacer. Nothing here interprets content -- callers extract
 * identifiers from the README text they get back.
 */

import { githubToken } from "../config.ts";
import { userAgent } from "../types.ts";
import { pacedClient } from "./polite.ts";

export const GITHUB_SEARCH_URL = "https://api.github.com/search/repositories";
const RAW_URL = "https://raw.githubusercontent.com";
/** GitHub's search rate limit is 10 requests/min unauthenticated, 30/min
 * with a token. Module-wide pacing, spanning back-to-back runs; GitHub
 * answers rate-limit violations with 403 or 429. The token is re-read per
 * request so a config change applies without a restart. */
const GITHUB_SPACING_MS = 6_500;
const GITHUB_SPACING_AUTH_MS = 2_100;
export const fetchGithub = pacedClient({
	label: "GitHub",
	spacingMs: () => (githubToken() ? GITHUB_SPACING_AUTH_MS : GITHUB_SPACING_MS),
	rateLimitStatuses: [403, 429],
});
/** raw.githubusercontent.com: no documented limit; 250 ms keeps a run of
 * README fetches polite. A missing README answers 404 and passes through. */
const fetchRaw = pacedClient({ label: "GitHub raw", spacingMs: 250, passStatuses: [404] });

/** Aggregator repositories (daily arXiv digests, awesome lists, personal
 * star lists, survey collections) mention THOUSANDS of paper ids in their
 * READMEs and are never a paper's code. Matched on the repo NAME; precision
 * over recall, a skipped legitimate repo just means no link. `stars` and
 * `starred` are word-bounded so names like "starship" survive. */
export const LIST_REPO_NAME = /awesome|daily|weekly|digest|arxiv|papers?([_-]|\b)|reading|survey|collection|curated|\bstars?\b|\bstarred\b/i;

/** Request headers for the REST API; the optional token raises the limit. */
export function githubHeaders(token: string = githubToken()): Record<string, string> {
	return {
		"User-Agent": userAgent(),
		Accept: "application/vnd.github+json",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

/** Owner and repository name out of a GitHub URL (`.git`, fragments and
 * deeper paths stripped); null for anything that is not a repository URL. */
export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
	const match = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url.trim());
	if (!match) return null;
	const [, owner, repo] = match;
	if (!owner || !repo || owner.startsWith(".") || repo.startsWith(".")) return null;
	return { owner, repo };
}

/** Canonical `https://github.com/<owner>/<repo>` form. */
export function repoUrl(owner: string, repo: string): string {
	return `https://github.com/${owner}/${repo}`;
}

/** One repository search; returns the raw item objects (html_url, name,
 * owner.login, created_at, description ...). Throws on non-2xx after the
 * pacer's retries. */
export async function searchRepositories(query: string, perPage: number, sort?: "updated"): Promise<Array<Record<string, any>>> {
	const params = new URLSearchParams({ q: query, per_page: String(Math.max(1, Math.min(100, perPage))) });
	if (sort) params.set("sort", sort);
	const response = await fetchGithub(`${GITHUB_SEARCH_URL}?${params}`, { headers: githubHeaders() });
	const data = (await response.json()) as Record<string, any>;
	return Array.isArray(data?.items) ? data.items : [];
}

/** The repository's README.md on its default branch (HEAD), or null when
 * there is none under that exact name. Only README.md is tried -- precision
 * over recall, documented. */
export async function fetchReadme(owner: string, repo: string): Promise<string | null> {
	const response = await fetchRaw(`${RAW_URL}/${owner}/${repo}/HEAD/README.md`, {
		headers: { "User-Agent": userAgent() },
	});
	if (response.status === 404) return null;
	return response.text();
}
