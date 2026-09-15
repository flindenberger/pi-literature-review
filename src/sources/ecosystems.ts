/**
 * Two ecosyste.ms services (open data, CC-BY-SA, no key; the results page
 * attributes them):
 *
 *  - repos.ecosyste.ms: repository metadata (created date, stars, archived)
 *    for the code-pair date gate -- replaces the GitHub core API, 15 000
 *    requests/hour anonymous.
 *  - awesome.ecosyste.ms: an index of "awesome" lists. It has NO text
 *    search; lists are found by GitHub topic, and a list's entries come
 *    structured (name, description, category, project URL), 100 per page.
 *    Measured trap: numeric-id URLs redirect to the slug form and DROP the
 *    query string (page 2 = page 1), so only the slug form is ever used.
 *    `topic` is undocumented (read off the site's own UI); a fixture pins
 *    the shape measured on 2026-09-03.
 */

import { userAgent } from "../types.ts";
import { pacedClient } from "./polite.ts";

const REPOS_URL = "https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories";
const AWESOME_URL = "https://awesome.ecosyste.ms/api/v1";
const PAGE_SIZE = 100;
/** Hard stop for one list's pagination (the largest measured list has 17
 * pages); a broken pager can never loop forever. */
export const MAX_LIST_PAGES = 30;
const fetchPaced = pacedClient({ label: "ecosyste.ms", spacingMs: 250, passStatuses: [404] });

function headers(): Record<string, string> {
	return { "User-Agent": userAgent(), Accept: "application/json" };
}

export interface RepoMeta {
	createdAt: string | null;
	stars: number | null;
	archived: boolean;
}

/** Pure: the fields the gate needs out of a repository object. */
export function parseRepoMeta(data: unknown): RepoMeta | null {
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, any>;
	return {
		createdAt: typeof d.created_at === "string" && d.created_at ? d.created_at : null,
		stars: Number.isInteger(d.stargazers_count) ? (d.stargazers_count as number) : null,
		archived: d.archived === true,
	};
}

/** Repository metadata, or null when the service does not know the repo. */
export async function fetchRepoMeta(owner: string, repo: string): Promise<RepoMeta | null> {
	const response = await fetchPaced(`${REPOS_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers: headers() });
	if (response.status === 404) return null;
	return parseRepoMeta(await response.json());
}

export interface AwesomeList {
	/** "<owner>/<repo>" -- the slug the entries endpoint needs. */
	slug: string;
	url: string;
	projectsCount: number;
}

/** Pure: lists out of the topic answer; entries without a GitHub URL or
 * without a project count are skipped, largest lists first. */
export function parseLists(data: unknown): AwesomeList[] {
	if (!Array.isArray(data)) return [];
	const lists: AwesomeList[] = [];
	for (const entry of data as Array<Record<string, any>>) {
		const url = typeof entry?.url === "string" ? entry.url.trim() : "";
		const match = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/?$/i.exec(url);
		const count = entry?.projects_count;
		if (!match || !Number.isInteger(count) || count <= 0) continue;
		lists.push({ slug: match[1], url, projectsCount: count });
	}
	return lists.sort((a, b) => b.projectsCount - a.projectsCount);
}

/** Lists tagged with a GitHub topic (e.g. "remote-sensing"). An optional
 * signal bounds the wait (the wizard's topic check uses a short timeout;
 * the run keeps the default). */
export async function listsForTopic(topic: string, signal?: AbortSignal): Promise<AwesomeList[]> {
	const params = new URLSearchParams({ topic, per_page: String(PAGE_SIZE) });
	const response = await fetchPaced(`${AWESOME_URL}/lists?${params}`, { headers: headers(), ...(signal ? { signal } : {}) });
	if (response.status === 404) return [];
	return parseLists(await response.json());
}

export interface ListEntry {
	name: string;
	description: string;
	category: string;
	/** Canonical https://github.com/<owner>/<repo>, or null for non-GitHub entries. */
	repoUrl: string | null;
}

/** Pure: one page of list entries. */
export function parseListEntries(data: unknown): ListEntry[] {
	if (!Array.isArray(data)) return [];
	return (data as Array<Record<string, any>>).map((entry) => {
		const url = typeof entry?.project?.url === "string" ? entry.project.url.trim() : "";
		const match = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
		return {
			name: typeof entry?.name === "string" ? entry.name.trim() : "",
			description: typeof entry?.description === "string" ? entry.description.trim() : "",
			category: typeof entry?.category === "string" ? entry.category.trim() : "",
			repoUrl: match ? `https://github.com/${match[1]}/${match[2]}` : null,
		};
	});
}

/** The URL of one entries page -- slug form only (see the module note). */
export function listEntriesUrl(slug: string, page: number): string {
	return `${AWESOME_URL}/lists/${encodeURIComponent(slug)}/list_projects?per_page=${PAGE_SIZE}&page=${page}`;
}

/** Every entry of one list, all pages. */
export async function listEntries(slug: string): Promise<ListEntry[]> {
	const entries: ListEntry[] = [];
	for (let page = 1; page <= MAX_LIST_PAGES; page++) {
		const response = await fetchPaced(listEntriesUrl(slug, page), { headers: headers() });
		if (response.status === 404) break;
		const batch = parseListEntries(await response.json());
		entries.push(...batch);
		if (batch.length < PAGE_SIZE) break;
	}
	return entries;
}
