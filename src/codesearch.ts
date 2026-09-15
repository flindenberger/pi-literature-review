/**
 * Code-first search: find repositories for the query FIRST, read the paper
 * identifiers they name, then resolve those identifiers to real records at
 * arXiv / OpenAlex. The reverse of the code-link stage in enrich.ts (paper
 * first, repository second); both directions share the GitHub client and
 * the field-measured date gate.
 *
 * Four searchers, same signature as the database searchers plus a context:
 *   hf-papers      Hugging Face Papers search (arXiv id + linked repo per hit)
 *   github-readme  GitHub repository search restricted to READMEs that
 *                  mention arxiv.org, then the README text itself
 *   awesome-lists  curated "awesome" lists found by GitHub topic on
 *                  awesome.ecosyste.ms, entries matched against the query
 *                  blocks, then each repository's README
 *   gee-github     GitHub search for Google Earth Engine repositories whose
 *                  README mentions doi.org, then the README
 *
 * Every searcher returns records whose `source` is the code platform, with
 * `resolved_via` naming the database that delivered the metadata, `code_url`
 * the repository and `enriched.code_url` the provenance. Pairs whose
 * repository was created more than a year after the paper (measured: almost
 * always a project CITING the paper, not its code) come back flagged
 * `code_gate: "late"` -- the engine lists them in the dropped table instead
 * of discarding them. No language model anywhere: identifiers are matched
 * by regular expressions, metadata comes from the APIs.
 */

import { DEFAULT_CODE_LIST_TOPICS } from "./config.ts";
import { createdTooLate } from "./enrich.ts";
import { queryBlocks } from "./intake.ts";
import { termMatches } from "./pipeline.ts";
import { lookupArxivIds } from "./sources/arxiv.ts";
import { flattenBlockTerms } from "./sources/crossref.ts";
import { fetchRepoMeta, listEntries, listsForTopic, type ListEntry, type RepoMeta } from "./sources/ecosystems.ts";
import { fetchReadme, LIST_REPO_NAME, parseRepoUrl, repoUrl, searchRepositories } from "./sources/github.ts";
import { searchHfPapers, buildHfQuery, type HfPaper } from "./sources/huggingface.ts";
import { lookupOpenalexDois } from "./sources/openalex.ts";
import type { SourceRecord, SourceScope } from "./types.ts";

/* ---------------- 1. Types and registry ---------------- */

export interface CodeSearchFailure {
	/** Which step failed: "search", "readme", "resolve at arXiv", "resolve at OpenAlex". */
	step: string;
	error: string;
}

export interface CodeSearchResult {
	records: SourceRecord[];
	/** Repository->identifier pairs gathered before resolution (transparency:
	 * "12 candidates, 4 resolved"). */
	candidates: number;
	failures: CodeSearchFailure[];
	/** awesome-lists only: the lists actually read, "<owner>/<repo>
	 * (N entries)", largest first -- the report names them next to the
	 * topics (transparency: which curated lists this run relied on). */
	listsRead?: string[];
}

/** Injectable network functions: tests pass stubs, the engine the real ones. */
export interface CodeSearchDeps {
	hfSearch: (text: string, limit: number) => Promise<HfPaper[]>;
	githubSearch: (query: string, perPage: number) => Promise<Array<Record<string, any>>>;
	readme: (owner: string, repo: string) => Promise<string | null>;
	repoMeta: (owner: string, repo: string) => Promise<RepoMeta | null>;
	listsForTopic: (topic: string) => Promise<Array<{ slug: string; projectsCount: number }>>;
	listEntries: (slug: string) => Promise<ListEntry[]>;
	lookupArxiv: (ids: string[]) => Promise<SourceRecord[]>;
	lookupDois: (dois: string[]) => Promise<SourceRecord[]>;
}

export interface CodeSearchContext {
	signal?: AbortSignal;
	warn?: (message: string) => void;
	deps?: Partial<CodeSearchDeps>;
	/** GitHub topics whose awesome lists are searched (awesome-lists only). */
	listTopics?: string[];
}

export type CodeSearcher = (query: string, perSource: number, scope: SourceScope | undefined, ctx: CodeSearchContext) => Promise<CodeSearchResult>;

const REAL_DEPS: CodeSearchDeps = {
	hfSearch: searchHfPapers,
	githubSearch: (query, perPage) => searchRepositories(query, perPage),
	readme: fetchReadme,
	repoMeta: fetchRepoMeta,
	listsForTopic,
	listEntries,
	lookupArxiv: lookupArxivIds,
	lookupDois: lookupOpenalexDois,
};

/** Default GitHub topics for the awesome-lists searcher (config.ts owns
 * the list; codeListTopics() applies env/config overrides). */
export const DEFAULT_LIST_TOPICS = DEFAULT_CODE_LIST_TOPICS;
/** At most this many lists are read per run (largest first). */
export const MAX_LISTS = 8;
/** Identifier candidates gathered per source and query before resolution:
 * a multiple of the per-source cap so the gate has something to drop. */
const CANDIDATE_FACTOR = 3;
/** Identifiers read per README: a paper repository names its own paper
 * first (a companion paper at most second); everything beyond that is a
 * reference list -- the live run showed one thesis repository dragging in
 * four unrelated papers. */
export const MAX_IDS_PER_README = 2;
/** The Hugging Face model-card template paper: tagged on thousands of
 * models and repositories that have nothing to do with it. */
const BLACKLISTED_ARXIV = new Set(["1910.09700"]);
/** Batch size for the arXiv id lookup (one request per batch). */
const ARXIV_BATCH = 50;
/** A repository created MORE than this many years after the paper is not
 * even worth the dropped table (a 1996 NDWI paper cited by a 2025 course
 * repository): discarded with a warn count. Gaps of 2..5 years stay in
 * the dropped table -- those are the cited methods a reader may want. */
export const LATE_DISCARD_YEARS = 5;

/* ---------------- 2. Pure helpers ---------------- */

export interface PaperId {
	kind: "arxiv" | "doi";
	value: string;
}

/** Identifier key for dedupe: kind + lowercase value, arXiv version dropped. */
export function paperIdKey(id: PaperId): string {
	return `${id.kind}:${id.value.toLowerCase().replace(/v\d+$/, "")}`;
}

/**
 * Every paper identifier a text names, in order of appearance, deduplicated:
 * arXiv ids from arxiv.org URLs and "arXiv:" mentions, DOIs from doi.org URLs
 * and "doi:" mentions. DataCite's arXiv DOIs (10.48550/arXiv.x) become arXiv
 * ids, Zenodo self-DOIs (10.5281/zenodo.*) are skipped (software/data
 * archives, not papers), the model-card template paper is skipped. Trailing
 * punctuation that Markdown drags along is stripped. Pure.
 */
export function paperIdsFromText(text: string): PaperId[] {
	const ids: PaperId[] = [];
	const seen = new Set<string>();
	const push = (id: PaperId) => {
		const key = paperIdKey(id);
		if (seen.has(key)) return;
		seen.add(key);
		ids.push(id);
	};
	const pattern = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?|arXiv:\s?(\d{4}\.\d{4,5})|(?:doi\.org\/|\bdoi:\s?)(10\.\d{4,9}\/[^\s)\]>"'<]+)/gi;
	for (const match of text.matchAll(pattern)) {
		const arxiv = match[1] ?? match[2];
		if (arxiv) {
			if (!BLACKLISTED_ARXIV.has(arxiv)) push({ kind: "arxiv", value: arxiv });
			continue;
		}
		let doi = match[3].replace(/[.,;:*}\]\)]+$/, "");
		const arxivDoi = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i.exec(doi);
		if (arxivDoi) {
			if (!BLACKLISTED_ARXIV.has(arxivDoi[1])) push({ kind: "arxiv", value: arxivDoi[1] });
			continue;
		}
		if (/^10\.5281\/zenodo\./i.test(doi)) continue;
		if (!/^10\.\d{4,9}\/\S+$/.test(doi)) continue;
		push({ kind: "doi", value: doi });
	}
	return ids;
}

/** The plain words sent to text searches without boolean syntax: the
 * block terms flattened, else the query itself. Pure. */
export function searchWords(query: string, blocks: string[][] | undefined): string {
	return flattenBlockTerms(blocks) || query.trim();
}

/** GitHub's boolean form of the blocks: "(a OR b) (c OR d)" -- terms
 * within a block OR-ed, blocks side by side (GitHub ANDs them). Measured
 * 2026-09-03: with the Earth Engine qualifiers this finds 180 repositories
 * where the flat word list finds none; on the open arXiv pool the same
 * form drowns in aggregator lists, so only gee-github uses it. Without
 * blocks the plain query is sent. Pure. */
export function blockQuery(query: string, blocks: string[][] | undefined): string {
	const groups = (blocks ?? [])
		.map((block) => block.map((term) => term.replace(/"/g, "").trim()).filter(Boolean))
		.filter((block) => block.length);
	if (!groups.length) return query.trim();
	return groups.map((block) => (block.length > 1 ? `(${block.join(" OR ")})` : block[0])).join(" ");
}

/** Does a list entry (name + description + category) satisfy the blocks?
 * Whole-word, same tolerances as the result labeling. One-line list
 * entries are short, so with three or more blocks ALL BUT ONE must hit
 * (a "(satellite) (water body) (mapping)" query still finds "water body
 * extraction from satellite images"); with one or two blocks every block
 * must hit. The labeling of the resolved paper stays strict. Pure. */
export function entryMatchesBlocks(entry: ListEntry, blocks: string[][]): boolean {
	if (!blocks.length) return false;
	const text = `${entry.name} ${entry.description} ${entry.category}`.toLowerCase();
	const hits = blocks.filter((block) => block.some((term) => termMatches(text, term.replace(/"/g, "").toLowerCase()))).length;
	const required = blocks.length >= 3 ? blocks.length - 1 : blocks.length;
	return hits >= required;
}

/** A repository->identifier pair before resolution. */
export interface CodePair {
	repoUrl: string;
	id: PaperId;
	/** created_at when the search answer already carried it (GitHub
	 * search items do); otherwise looked up at repos.ecosyste.ms. */
	createdAt?: string | null;
	/** Other GitHub repositories the README links (canonical URLs, the
	 * README's own repository excluded): when the found repository is a
	 * paper list, the paper's real repository is usually among them. */
	readmeRepos?: string[];
}

/** Repo-name tokens (split on separators and camelCase, >= 4 chars,
 * lowercased) -- the same rule the paper-first picker uses. */
function nameTokens(name: string): string[] {
	const tokens: string[] = [];
	for (const part of name.split(/[-_.\s]+/)) {
		tokens.push(...(part.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []));
	}
	return tokens.map((token) => token.toLowerCase()).filter((token) => token.length >= 4);
}

/** Every GitHub repository URL a text links, canonical, deduplicated,
 * in order; `except` (the README's own repository) is skipped. Pure. */
export function repoUrlsFromText(text: string, except?: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const skip = except ? except.toLowerCase() : "";
	for (const match of text.matchAll(/https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s)\]>"'<#?/,;]|$)/gi)) {
		const url = repoUrl(match[1], match[2]).toLowerCase();
		if (url === skip || seen.has(url)) continue;
		seen.add(url);
		out.push(repoUrl(match[1], match[2]));
	}
	return out;
}

/** A README linking at least this many OTHER repositories reads as an
 * overview page (a paper list), not as one project's own README. */
export const OVERVIEW_LINK_COUNT = 3;

/**
 * The paper's own repository out of a README's links: when the README
 * belongs to an overview page (it links OVERVIEW_LINK_COUNT or more other
 * repositories) and its own name shares no word (>= 4 chars) with the
 * paper title, a linked repository whose name does share one wins -- a
 * paper list page ("GeoAI in NeurIPS 2024") links the real FUSU repository
 * next to the FUSU paper. Null when the host repository already fits,
 * when the README is not an overview page, or when no link fits. Pure.
 */
export function betterRepoFromReadme(hostUrl: string, readmeRepos: string[], title: string): string | null {
	if (readmeRepos.length < OVERVIEW_LINK_COUNT) return null;
	const lower = title.toLowerCase();
	const fits = (url: string): boolean => {
		const parsed = parseRepoUrl(url);
		return !!parsed && nameTokens(parsed.repo).some((token) => lower.includes(token));
	};
	if (fits(hostUrl)) return null;
	// Never switch onto an aggregator (an "awesome-satellite-imagery-
	// datasets" link shares "satellite" with many titles).
	return readmeRepos.find((url) => fits(url) && !LIST_REPO_NAME.test(parseRepoUrl(url)?.repo ?? "")) ?? null;
}

/** GitHub search items -> usable repositories: https URL, not an aggregator
 * or star list, not a fork. Pure. */
export function usableRepoItems(items: Array<Record<string, any>>): Array<{ owner: string; repo: string; createdAt: string | null }> {
	const out: Array<{ owner: string; repo: string; createdAt: string | null }> = [];
	for (const item of items) {
		if (item?.fork === true) continue;
		if (LIST_REPO_NAME.test(String(item?.name ?? ""))) continue;
		const parsed = typeof item?.html_url === "string" ? parseRepoUrl(item.html_url) : null;
		if (!parsed) continue;
		out.push({ ...parsed, createdAt: typeof item?.created_at === "string" ? item.created_at : null });
	}
	return out;
}

/* ---------------- 3. Shared resolution ---------------- */

function deps(ctx: CodeSearchContext): CodeSearchDeps {
	return { ...REAL_DEPS, ...(ctx.deps ?? {}) };
}

function aborted(ctx: CodeSearchContext): void {
	if (ctx.signal?.aborted) throw new Error("search aborted by the user");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Read the README of each repository (in order) and collect identifier
 * pairs until `limit` pairs are gathered. A README failure is recorded and
 * the loop continues; a missing README is simply skipped.
 */
async function pairsFromReadmes(
	repos: Array<{ owner: string; repo: string; createdAt: string | null }>,
	limit: number,
	ctx: CodeSearchContext,
	failures: CodeSearchFailure[],
): Promise<CodePair[]> {
	const d = deps(ctx);
	const pairs: CodePair[] = [];
	for (const entry of repos) {
		if (pairs.length >= limit) break;
		aborted(ctx);
		let text: string | null;
		try {
			text = await d.readme(entry.owner, entry.repo);
		} catch (error) {
			failures.push({ step: `readme ${entry.owner}/${entry.repo}`, error: errorText(error) });
			continue;
		}
		if (!text) continue;
		const host = repoUrl(entry.owner, entry.repo);
		const readmeRepos = repoUrlsFromText(text, host);
		for (const id of paperIdsFromText(text).slice(0, MAX_IDS_PER_README)) {
			pairs.push({ repoUrl: host, id, createdAt: entry.createdAt, readmeRepos });
		}
	}
	return pairs.slice(0, limit);
}

/**
 * Resolve pairs to records: identifiers deduplicated (the first repository
 * naming a paper keeps it), arXiv ids looked up in batches, DOIs at
 * OpenAlex, then the date gate per pair. Records without a repository
 * (Hugging Face papers without a linked repo) pass through ungated.
 * Returns the gate survivors first (capped at perSource), then the late
 * pairs (for the dropped table), each stamped with source, provenance and
 * resolved_via.
 */
export async function resolvePairs(
	pairs: Array<CodePair | { id: PaperId; repoUrl: null }>,
	source: string,
	perSource: number,
	ctx: CodeSearchContext,
	failures: CodeSearchFailure[],
): Promise<SourceRecord[]> {
	const d = deps(ctx);
	const byKey = new Map<string, CodePair | { id: PaperId; repoUrl: null }>();
	for (const pair of pairs) {
		const key = paperIdKey(pair.id);
		if (!byKey.has(key)) byKey.set(key, pair);
	}
	const arxivIds = [...byKey.values()].filter((p) => p.id.kind === "arxiv").map((p) => p.id.value);
	const dois = [...byKey.values()].filter((p) => p.id.kind === "doi").map((p) => p.id.value);

	const resolved = new Map<string, SourceRecord>();
	for (let i = 0; i < arxivIds.length; i += ARXIV_BATCH) {
		aborted(ctx);
		try {
			for (const record of await d.lookupArxiv(arxivIds.slice(i, i + ARXIV_BATCH))) {
				if (record.arxiv_id) resolved.set(paperIdKey({ kind: "arxiv", value: record.arxiv_id }), { ...record, resolved_via: "arxiv" });
			}
		} catch (error) {
			failures.push({ step: "resolve at arXiv", error: errorText(error) });
		}
	}
	if (dois.length) {
		aborted(ctx);
		try {
			for (const record of await d.lookupDois(dois)) {
				if (record.doi) resolved.set(paperIdKey({ kind: "doi", value: record.doi }), { ...record, resolved_via: "openalex" });
			}
		} catch (error) {
			failures.push({ step: "resolve at OpenAlex", error: errorText(error) });
		}
	}

	const passed: SourceRecord[] = [];
	const late: SourceRecord[] = [];
	let discarded = 0;
	const metaCache = new Map<string, RepoMeta | null>();
	for (const [key, pair] of byKey) {
		const record = resolved.get(key);
		if (!record) continue;
		const stamped: SourceRecord = { ...record, source };
		if (!pair.repoUrl) {
			passed.push(stamped);
			continue;
		}
		// A README link that fits the paper title beats the README's own
		// repository (paper lists); the switched repository's date is then
		// unknown and gets looked up like any other.
		const better = "readmeRepos" in pair && pair.readmeRepos?.length
			? betterRepoFromReadme(pair.repoUrl, pair.readmeRepos, stamped.title)
			: null;
		const chosenUrl = better ?? pair.repoUrl;
		stamped.code_url = chosenUrl;
		stamped.enriched = { ...(record.enriched ?? {}), code_url: source };
		let createdAt: string | null | undefined = better ? undefined : pair.createdAt;
		if (createdAt === undefined) {
			aborted(ctx);
			const parsed = parseRepoUrl(chosenUrl);
			if (parsed) {
				const cacheKey = `${parsed.owner}/${parsed.repo}`.toLowerCase();
				if (!metaCache.has(cacheKey)) {
					try {
						metaCache.set(cacheKey, await d.repoMeta(parsed.owner, parsed.repo));
					} catch (error) {
						ctx.warn?.(`${source}: repository metadata for ${cacheKey} unavailable (${errorText(error)}); date gate skipped`);
						metaCache.set(cacheKey, null);
					}
				}
				createdAt = metaCache.get(cacheKey)?.createdAt ?? null;
			} else {
				createdAt = null;
			}
		}
		if (createdAt === null) {
			stamped.code_gate = "unchecked";
			passed.push(stamped);
		} else if (createdTooLate(createdAt, stamped.year)) {
			const gap = Number.parseInt(createdAt.slice(0, 4), 10) - Number.parseInt(stamped.year ?? "", 10);
			if (gap > LATE_DISCARD_YEARS) {
				discarded++;
				continue;
			}
			stamped.code_gate = "late";
			stamped.code_gate_note = `found via code repository ${chosenUrl}, created ${gap} years after the paper -- probably a project citing the paper, not the paper's own code`;
			late.push(stamped);
		} else {
			passed.push(stamped);
		}
	}
	if (discarded) {
		ctx.warn?.(`${source}: ${discarded} pair(s) discarded -- repository created more than ${LATE_DISCARD_YEARS} years after the paper`);
	}
	return [...passed.slice(0, Math.max(0, perSource)), ...late];
}

/* ---------------- 4. The searchers ---------------- */

/** Hugging Face Papers: papers with a linked repository come first (the
 * point of the feature), papers without one follow and stay ungated. */
export const searchHfPapersCode: CodeSearcher = async (query, perSource, scope, ctx) => {
	const d = deps(ctx);
	const failures: CodeSearchFailure[] = [];
	const text = buildHfQuery(query, scope?.blocks);
	let papers: HfPaper[];
	try {
		papers = await d.hfSearch(text, Math.min(120, perSource * CANDIDATE_FACTOR));
	} catch (error) {
		throw new Error(`Hugging Face papers search failed: ${errorText(error)}`);
	}
	const ordered = [...papers.filter((p) => p.repoUrl), ...papers.filter((p) => !p.repoUrl)];
	const pairs = ordered.map((p) => ({ id: { kind: "arxiv", value: p.arxivId } as PaperId, repoUrl: p.repoUrl }));
	const records = await resolvePairs(pairs as Array<CodePair | { id: PaperId; repoUrl: null }>, "hf-papers", perSource, ctx, failures);
	return { records, candidates: pairs.length, failures };
};

async function githubReadmeSearch(source: string, qualifiers: string, query: string, perSource: number, scope: SourceScope | undefined, ctx: CodeSearchContext, form: "words" | "blocks"): Promise<CodeSearchResult> {
	const d = deps(ctx);
	const failures: CodeSearchFailure[] = [];
	const words = form === "blocks" ? blockQuery(query, scope?.blocks) : searchWords(query, scope?.blocks);
	const limit = perSource * CANDIDATE_FACTOR;
	let items: Array<Record<string, any>>;
	try {
		items = await d.githubSearch(`${words} ${qualifiers}`, Math.min(100, limit));
	} catch (error) {
		throw new Error(`GitHub repository search failed: ${errorText(error)}`);
	}
	const pairs = await pairsFromReadmes(usableRepoItems(items), limit, ctx, failures);
	const records = await resolvePairs(pairs, source, perSource, ctx, failures);
	return { records, candidates: pairs.length, failures };
}

/** GitHub repositories whose README cites arxiv.org and matches the query words. */
export const searchGithubReadme: CodeSearcher = (query, perSource, scope, ctx) =>
	githubReadmeSearch("github-readme", '"arxiv.org" in:readme', query, perSource, scope, ctx, "words");

/** Google Earth Engine repositories (README names the GEE code editor)
 * whose README cites a DOI -- GEE papers are journal papers. */
export const searchGeeGithub: CodeSearcher = (query, perSource, scope, ctx) =>
	githubReadmeSearch("gee-github", '"code.earthengine.google.com" in:readme "doi.org" in:readme', query, perSource, scope, ctx, "blocks");

/** Per-process cache of list entries: one run reads a list once, back-to-back
 * runs in one pi session reuse it. */
const listCache = new Map<string, Promise<ListEntry[]>>();

/** Curated lists found by topic; entries matched against the query blocks. */
export const searchAwesomeLists: CodeSearcher = async (query, perSource, scope, ctx) => {
	const d = deps(ctx);
	const failures: CodeSearchFailure[] = [];
	const blocks = scope?.blocks?.length ? scope.blocks : queryBlocks(query);
	if (!blocks.length) {
		ctx.warn?.("awesome-lists: the query has no concept blocks (quoted or field syntax); list entries cannot be matched, source skipped");
		return { records: [], candidates: 0, failures };
	}
	const lists = new Map<string, number>();
	for (const topic of ctx.listTopics ?? DEFAULT_LIST_TOPICS) {
		aborted(ctx);
		try {
			for (const list of await d.listsForTopic(topic)) {
				if (!lists.has(list.slug)) lists.set(list.slug, list.projectsCount);
			}
		} catch (error) {
			failures.push({ step: `lists for topic ${topic}`, error: errorText(error) });
		}
	}
	const slugs = [...lists.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LISTS).map(([slug]) => slug);
	const repos: Array<{ owner: string; repo: string; createdAt: string | null }> = [];
	const seen = new Set<string>();
	const listsRead: string[] = [];
	for (const slug of slugs) {
		aborted(ctx);
		let entries: ListEntry[];
		try {
			if (!listCache.has(slug)) listCache.set(slug, d.listEntries(slug));
			entries = await listCache.get(slug)!;
		} catch (error) {
			listCache.delete(slug);
			failures.push({ step: `entries of list ${slug}`, error: errorText(error) });
			continue;
		}
		listsRead.push(`${slug} (${entries.length} entries)`);
		for (const entry of entries) {
			if (!entry.repoUrl || !entryMatchesBlocks(entry, blocks)) continue;
			const parsed = parseRepoUrl(entry.repoUrl);
			if (!parsed) continue;
			const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
			if (seen.has(key) || LIST_REPO_NAME.test(parsed.repo)) continue;
			seen.add(key);
			repos.push({ ...parsed, createdAt: null });
		}
	}
	const limit = perSource * CANDIDATE_FACTOR;
	// createdAt unknown here -> resolvePairs asks repos.ecosyste.ms.
	const pairs = (await pairsFromReadmes(repos, limit, ctx, failures)).map((p) => ({ ...p, createdAt: undefined }));
	const records = await resolvePairs(pairs, "awesome-lists", perSource, ctx, failures);
	return { records, candidates: pairs.length, failures, listsRead };
};

export const CODE_SEARCHERS: Record<string, CodeSearcher> = {
	"hf-papers": searchHfPapersCode,
	"github-readme": searchGithubReadme,
	"awesome-lists": searchAwesomeLists,
	"gee-github": searchGeeGithub,
};

/** Reset the per-process list cache (tests). */
export function clearListCache(): void {
	listCache.clear();
}
