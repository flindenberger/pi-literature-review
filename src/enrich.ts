/**
 * Deterministic metadata enrichment (Phase 5, step 3).
 *
 * Some search sources cannot deliver certain fields at all: arXiv, a
 * preprint server, has no citation counts and no journal; CrossRef and
 * Semantic Scholar ship MANY records without abstracts (publishers often
 * do not deposit them / may not be relayed -- measured 2026-08-10: 65%
 * of CrossRef records lacked one). For records that still miss cites,
 * venue or abstract after dedupe, one identifier lookup at OpenAlex
 * (GET api.openalex.org/works/doi:<doi>) fills the gap -- an open API, not
 * scraping, and no LLM. An abstract still missing after that is asked
 * from Semantic Scholar by DOI (2026-08-18; OpenAlex lacks abstracts for
 * many Elsevier papers that S2 carries -- such a record used to fall to
 * the abstract gate depending on which source happened to find it).
 * Only empty fields are filled, never overwritten,
 * and every filled field is recorded in `enriched` (field -> provider) so
 * both the JSON and the HTML rendering can mark the provenance. A filled
 * abstract also feeds the block labeling, which matches title+abstract.
 */

import { githubToken } from "./config.ts";
import { retryDelayMs } from "./sources/arxiv.ts";
import { reconstructAbstract } from "./sources/openalex.ts";
import { fetchAbstractByDoi } from "./sources/semanticscholar.ts";
import { contactMailto, userAgent, warn as defaultWarn } from "./types.ts";

const BASE_URL = "https://api.openalex.org/works";
const SOURCES_URL = "https://api.openalex.org/sources";
const AUTHORS_URL = "https://api.openalex.org/authors";
const TIMEOUT_MS = 30_000;
/** OpenAlex allows up to ~100 OR-joined values per filter; stay well under. */
const BATCH_SIZE = 50;

export interface EnrichableRecord {
	title: string;
	doi: string;
	arxiv_id: string;
	cites: number | null;
	venue: string;
	/** Missing abstracts are filled too since 2026-08-10 (optional so
	 * older minimal callers/fixtures stay valid). */
	abstract?: string;
	/** OpenAlex source (journal) ID; captured at search time or filled here. */
	venue_id?: string;
}

export type Enriched<T> = T & { enriched?: Record<string, string> };

function needsEnrichment(record: EnrichableRecord): boolean {
	return record.cites === null || !record.venue || !record.abstract;
}

/**
 * The DOI to look up: the record's own, or the DataCite DOI that arXiv
 * assigns to every preprint (10.48550/arxiv.<id>, version suffix dropped).
 * No identifier means no lookup -- a record is never matched by title.
 */
export function lookupDoi(record: EnrichableRecord): string | null {
	if (record.doi) return record.doi;
	if (record.arxiv_id) return `10.48550/arxiv.${record.arxiv_id.replace(/v\d+$/i, "")}`;
	return null;
}

/** Fill gaps from an OpenAlex work object. Pure; reports the filled fields. */
export function applyEnrichment<T extends EnrichableRecord>(
	record: T,
	work: Record<string, any>,
): { record: Enriched<T>; filled: string[] } {
	const filled: string[] = [];
	const result: Enriched<T> = { ...record };
	if (record.cites === null && Number.isInteger(work?.cited_by_count)) {
		result.cites = work.cited_by_count as number;
		filled.push("cites");
	}
	const venue = work?.primary_location?.source?.display_name;
	if (!record.venue && typeof venue === "string" && venue.trim()) {
		result.venue = venue.trim();
		filled.push("venue");
	}
	// Missing abstract (2026-08-10): OpenAlex ships it as an inverted
	// index in the SAME work object the cites/venue lookup already
	// fetches; the reconstruction is pure string ops (openalex.ts).
	const abstract = reconstructAbstract(work?.abstract_inverted_index);
	if (!record.abstract && abstract) {
		result.abstract = abstract;
		filled.push("abstract");
	}
	// The journal ID is lookup plumbing for the journal-score stage, not
	// user-facing metadata; filled quietly, visible in the JSON as venue_id.
	const venueId = work?.primary_location?.source?.id;
	if (!record.venue_id && typeof venueId === "string" && venueId.trim()) {
		result.venue_id = venueId.replace("https://openalex.org/", "").trim();
	}
	if (filled.length) {
		// MERGE with what earlier stages recorded -- overwriting the map
		// would silently erase their provenance (design-doc find 2026-08-06,
		// fixed 2026-08-07 with the second enrichment stage).
		result.enriched = {
			...(record as Enriched<T>).enriched,
			...Object.fromEntries(filled.map((field) => [field, "openalex"])),
		};
	}
	return { record: result, filled };
}

/**
 * Enrich all records that miss cites or venue and carry an identifier.
 * A failing lookup degrades gracefully: the record ships as delivered,
 * with a warning. Sequential requests, politeness towards the free API.
 */
export async function enrichAll<T extends EnrichableRecord>(
	records: T[],
	warn: (message: string) => void = defaultWarn,
	abstractLookup: (doi: string) => Promise<string | null> = fetchAbstractByDoi,
): Promise<Array<Enriched<T>>> {
	const out: Array<Enriched<T>> = [];
	let lookups = 0;
	let gained = 0;
	let s2Lookups = 0;
	let s2Gained = 0;
	let s2Down = false;
	for (const record of records) {
		const doi = lookupDoi(record);
		if (doi === null || !needsEnrichment(record)) {
			out.push(record);
			continue;
		}
		lookups++;
		let current: Enriched<T> = record;
		try {
			const mailto = contactMailto();
			const query = mailto ? `?${new URLSearchParams({ mailto })}` : "";
			const response = await fetch(`${BASE_URL}/doi:${doi}${query}`, {
				headers: { "User-Agent": userAgent(), Accept: "application/json" },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!response.ok) {
				warn(`enrichment lookup for "${record.title}" answered HTTP ${response.status}; record kept as delivered`);
			} else {
				const work = (await response.json()) as Record<string, any>;
				const { record: enrichedRecord, filled } = applyEnrichment(record, work);
				if (filled.length) {
					gained++;
					warn(`enriched "${record.title}": ${filled.join(", ")} (openalex)`);
				}
				current = enrichedRecord;
			}
		} catch (error) {
			warn(`enrichment lookup for "${record.title}" failed: ${error instanceof Error ? error.message : error}; record kept as delivered`);
		}
		// Second abstract source: Semantic Scholar by the record's own DOI
		// (arXiv DataCite DOIs are not asked -- arXiv records always carry
		// their abstract). Failure keeps the record as it is, loudly.
		// The anonymous S2 pool answers 429 for minutes at a time (measured
		// 2026-08-10); after the first hard failure the remaining lookups of
		// this run are skipped instead of each burning its own retries.
		if (!current.abstract && record.doi && !s2Down) {
			s2Lookups++;
			try {
				const abstract = await abstractLookup(record.doi);
				if (abstract) {
					s2Gained++;
					current = { ...current, abstract, enriched: { ...current.enriched, abstract: "semanticscholar" } };
					warn(`enriched "${record.title}": abstract (semanticscholar)`);
				}
			} catch (error) {
				s2Down = true;
				warn(`abstract lookup at Semantic Scholar for "${record.title}" failed: ${error instanceof Error ? error.message : error}; record kept as delivered, further Semantic Scholar abstract lookups skipped this run`);
			}
		}
		out.push(current);
	}
	if (lookups) warn(`enrichment: ${lookups} lookup(s), ${gained} record(s) gained fields`);
	if (s2Lookups) warn(`abstract lookups at Semantic Scholar: ${s2Lookups}, ${s2Gained} abstract(s) filled`);
	return out;
}

function apiQuery(params: Record<string, string>): string {
	const mailto = contactMailto();
	return `?${new URLSearchParams(mailto ? { ...params, mailto } : params)}`;
}

async function fetchJson(url: string): Promise<Record<string, any>> {
	const response = await fetch(url, {
		headers: { "User-Agent": userAgent(), Accept: "application/json" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`OpenAlex answered HTTP ${response.status}`);
	return (await response.json()) as Record<string, any>;
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

/** What OpenAlex publishes about an author (v30.11: the wizard's author
 * list shows it next to the hit count). All plain API metadata. */
export interface AuthorMetrics {
	/** Total citations of everything this author published. */
	cites: number | undefined;
	works: number | undefined;
	hIndex: number | undefined;
	/** The author's main research areas: top OpenAlex topics by work count
	 * (2026-08-10 user wish -- shown behind the h-index in the author tab).
	 * Plain API display names, nothing derived. */
	topics: string[] | undefined;
}

/**
 * Fetch citation counts / works / h-index for a set of OpenAlex author ids,
 * in batches -- the author-list analog of fetchJournalScores (v30.11).
 * Failures leave authors unscored, loudly; only finite API numbers land in
 * the map. Nothing here is derived, guessed or model-generated.
 */
export async function fetchAuthorMetrics(
	authorIds: string[],
	warn: (message: string) => void = defaultWarn,
): Promise<Map<string, AuthorMetrics>> {
	const byAuthorId = new Map<string, AuthorMetrics>();
	for (const batch of chunk([...new Set(authorIds.filter(Boolean))], BATCH_SIZE)) {
		try {
			const data = await fetchJson(`${AUTHORS_URL}${apiQuery({
				filter: `ids.openalex:${batch.join("|")}`,
				select: "id,cited_by_count,works_count,summary_stats,topics",
				"per-page": String(BATCH_SIZE),
			})}`);
			for (const author of (data.results ?? []) as Array<Record<string, any>>) {
				const id = typeof author.id === "string" ? author.id.replace("https://openalex.org/", "").trim() : "";
				if (!id) continue;
				const number = (value: unknown): number | undefined =>
					typeof value === "number" && Number.isFinite(value) ? value : undefined;
				// OpenAlex orders an author's topics by work count already
				// (verified live 2026-08-10); the top entries are the person's
				// main research areas across their ENTIRE work.
				const topics = (Array.isArray(author.topics) ? author.topics : [])
					.map((topic: Record<string, unknown>) => typeof topic?.display_name === "string" ? topic.display_name : "")
					.filter(Boolean)
					.slice(0, 3);
				byAuthorId.set(id, {
					cites: number(author.cited_by_count),
					works: number(author.works_count),
					hIndex: number(author?.summary_stats?.h_index),
					topics: topics.length ? topics : undefined,
				});
			}
		} catch (error) {
			warn(`author metrics batch lookup failed: ${error instanceof Error ? error.message : error}; affected authors ship without metrics`);
		}
	}
	return byAuthorId;
}

/** Stamp each record with its journal's score. Pure; nothing overwritten. */
/**
 * Fetch the OpenAlex 2-yr mean citedness for a set of journal ids, in
 * batches (extracted from addJournalScores in v30.8 -- the wizard's
 * journal list shows the score too). Failures leave journals unscored,
 * loudly; the map only ever contains finite numbers from the API.
 */
export async function fetchJournalScores(
	venueIds: string[],
	warn: (message: string) => void = defaultWarn,
): Promise<Map<string, number>> {
	const scoreByVenueId = new Map<string, number>();
	for (const batch of chunk([...new Set(venueIds.filter(Boolean))], BATCH_SIZE)) {
		try {
			const data = await fetchJson(`${SOURCES_URL}${apiQuery({
				filter: `ids.openalex:${batch.join("|")}`,
				select: "id,summary_stats",
				"per-page": String(BATCH_SIZE),
			})}`);
			for (const source of (data.results ?? []) as Array<Record<string, any>>) {
				const id = typeof source.id === "string" ? source.id.replace("https://openalex.org/", "").trim() : "";
				const score = source?.summary_stats?.["2yr_mean_citedness"];
				if (id && typeof score === "number" && Number.isFinite(score)) {
					scoreByVenueId.set(id, score);
				}
			}
		} catch (error) {
			warn(`journal-score batch lookup failed: ${error instanceof Error ? error.message : error}; affected journals ship without a score`);
		}
	}
	return scoreByVenueId;
}

export function applyJournalScores<T extends EnrichableRecord>(
	records: T[],
	scoreByVenueId: Map<string, number>,
): Array<T & { journal_2yr_citedness?: number }> {
	return records.map((record) => {
		const score = record.venue_id ? scoreByVenueId.get(record.venue_id) : undefined;
		return score === undefined ? record : { ...record, journal_2yr_citedness: score };
	});
}

/**
 * Journal-score stage: attach each journal's OpenAlex "2-yr mean citedness"
 * (the open analog of the proprietary impact factor; it rates the journal,
 * not the paper). Two batched lookups keep this cheap: records without a
 * known journal ID are resolved by DOI (max ${BATCH_SIZE} per request), then
 * all distinct journals are fetched in one sweep. Failures degrade gracefully;
 * records ship without a score rather than blocking the run.
 */
export async function addJournalScores<T extends EnrichableRecord>(
	records: T[],
	warn: (message: string) => void = defaultWarn,
): Promise<Array<T & { journal_2yr_citedness?: number }>> {
	// Resolve missing journal IDs by DOI, in batches.
	const unresolved = records.filter((r) => !r.venue_id && lookupDoi(r) !== null);
	const venueIdByDoi = new Map<string, string>();
	for (const batch of chunk(unresolved, BATCH_SIZE)) {
		const dois = batch.map((r) => (lookupDoi(r) as string).toLowerCase());
		try {
			const data = await fetchJson(`${BASE_URL}${apiQuery({
				filter: `doi:${dois.join("|")}`,
				select: "doi,primary_location",
				"per-page": String(BATCH_SIZE),
			})}`);
			for (const work of (data.results ?? []) as Array<Record<string, any>>) {
				const doi = typeof work.doi === "string" ? work.doi.replace("https://doi.org/", "").toLowerCase() : "";
				const id = work?.primary_location?.source?.id;
				if (doi && typeof id === "string" && id.trim()) {
					venueIdByDoi.set(doi, id.replace("https://openalex.org/", "").trim());
				}
			}
		} catch (error) {
			warn(`journal-id batch lookup failed: ${error instanceof Error ? error.message : error}; affected records ship without a journal score`);
		}
	}
	const withIds = records.map((record) => {
		if (record.venue_id) return record;
		const doi = lookupDoi(record)?.toLowerCase();
		const venueId = doi ? venueIdByDoi.get(doi) : undefined;
		return venueId ? { ...record, venue_id: venueId } : record;
	});

	// Fetch every distinct journal's summary stats, in batches.
	const venueIds = [...new Set(withIds.map((r) => r.venue_id).filter((id): id is string => !!id))];
	const scoreByVenueId = await fetchJournalScores(venueIds, warn);
	const scored = applyJournalScores(withIds, scoreByVenueId);
	const count = scored.filter((r) => typeof r.journal_2yr_citedness === "number").length;
	if (venueIds.length) {
		warn(`journal scores: ${count}/${records.length} record(s) scored across ${venueIds.length} distinct journal(s)`);
	}
	return scored;
}

/* ---------------- Code links (GitHub heuristic, 2026-08-07) ---------------- */

/**
 * Code-link stage: for records carrying an arXiv id, ONE GitHub repository
 * search per record (q = "<id>" in:name,description,readme) attaches the
 * best-matching repository as code_url -- the interim replacement for
 * Papers with Code (the .com site died 2025-07; the official .co revival
 * has no public API and blocks bots -- watch it, an API would replace
 * this heuristic). A HEURISTIC, disclosed as such in the HTML: the repo
 * mentions the paper, nothing here verifies it IS the paper's code.
 * Only records with an arxiv_id are looked up -- DOI-only journal papers
 * have no comparably precise search key (title search would guess;
 * doctrine forbids guessing).
 */
const GITHUB_SEARCH_URL = "https://api.github.com/search/repositories";
const GITHUB_TIMEOUT_MS = 30_000;
/** GitHub's search rate limit is 10 requests/min unauthenticated, 30/min
 * with a token (measured live 2026-08-07: x-ratelimit-limit 10, resource
 * "search"). Module-wide pacing, spanning back-to-back runs (the arXiv
 * v30.13 pattern); 429/403 rate answers retry via the shared pure
 * retryDelayMs. */
const GITHUB_SPACING_MS = 6_500;
const GITHUB_SPACING_AUTH_MS = 2_100;
/** Per-run lookup cap: keeps the stage's worst case around a minute
 * (cap x 6.5s unauthenticated). Capped-out records honestly stay
 * unmarked, with a warn line naming the count. */
export const CODE_LOOKUP_CAP = 12;
let nextGithubRequestAt = 0;

function githubSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Aggregator repositories (daily arXiv digests, awesome lists, survey
 * collections) mention THOUSANDS of arXiv ids in their READMEs and are
 * never the paper's code -- measured live 2026-08-07: the only hit for a
 * SAR water paper was "Robust_arXiv_daily". Matched on the repo NAME;
 * precision over recall, a skipped legitimate repo just means no link. */
const LIST_REPO_NAME = /awesome|daily|weekly|digest|arxiv|papers?([_-]|\b)|reading|survey|collection|curated/i;

/** Pick the repository URL from a GitHub search answer: the first item
 * (GitHub's best-match ranking) with a usable html_url whose name does
 * not look like an aggregator/reading-list repo. Pure. */
export function pickCodeRepo(data: Record<string, any>): string | null {
	const item = ((data?.items ?? []) as Array<Record<string, any>>)
		.find((entry) => typeof entry?.html_url === "string" && entry.html_url.startsWith("https://")
			&& !LIST_REPO_NAME.test(String(entry?.name ?? "")));
	return item ? (item.html_url as string) : null;
}

/**
 * A GitHub repository the paper's own ABSTRACT names (many papers write
 * "code available at https://github.com/...") -- the most precise code
 * signal there is, straight from the search API's record, zero requests.
 * Trailing .git and punctuation stripped. Pure.
 */
export function codeUrlFromAbstract(abstract: string | undefined): string | null {
	const match = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(abstract ?? "");
	if (!match) return null;
	const repo = match[2].replace(/\.git$/i, "").replace(/[.,;:!?]+$/, "");
	return repo ? `https://github.com/${match[1]}/${repo}` : null;
}

/** The version-free arXiv id -- the GitHub search key; also the dedupe
 * key of the lookup stage (the same paper may enter twice, e.g. junk
 * drops collected per query variant before deduplication). Pure. */
export function bareArxivId(arxivId: string): string {
	return arxivId.replace(/v\d+$/i, "");
}

/** Which records get a lookup: arxiv_id holders, on_target ones first
 * (the cap should spend its budget on the labeled hits), one candidate
 * per bare arXiv id (a duplicate would burn a capped slot on an
 * identical search), capped. Pure; stable within each priority class. */
export function codeLookupCandidates<T extends { arxiv_id: string; group?: string }>(
	records: T[],
	cap: number = CODE_LOOKUP_CAP,
): T[] {
	const withId = records.filter((record) => record.arxiv_id);
	const seen = new Set<string>();
	return [
		...withId.filter((record) => record.group === "on_target"),
		...withId.filter((record) => record.group !== "on_target"),
	].filter((record) => {
		const id = bareArxivId(record.arxiv_id);
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	}).slice(0, Math.max(0, cap));
}

async function fetchCodeLink(arxivId: string, token: string): Promise<string | null> {
	const spacing = token ? GITHUB_SPACING_AUTH_MS : GITHUB_SPACING_MS;
	const bareId = bareArxivId(arxivId);
	const params = new URLSearchParams({
		q: `"${bareId}" in:name,description,readme`,
		per_page: "3",
	});
	for (let attempt = 0; ; attempt++) {
		const wait = nextGithubRequestAt - Date.now();
		if (wait > 0) await githubSleep(wait);
		nextGithubRequestAt = Date.now() + spacing;
		const response = await fetch(`${GITHUB_SEARCH_URL}?${params}`, {
			headers: {
				"User-Agent": userAgent(),
				Accept: "application/vnd.github+json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
		});
		if (response.ok) return pickCodeRepo((await response.json()) as Record<string, any>);
		// GitHub answers rate-limit violations with 403 or 429.
		const rateLimited = response.status === 403 || response.status === 429;
		const delay = rateLimited ? retryDelayMs(attempt, response.headers.get("retry-after")) : null;
		if (delay === null) throw new Error(`GitHub answered HTTP ${response.status}`);
		await githubSleep(delay);
	}
}

/**
 * Attach code_url to records. Two deterministic signals, in order of
 * precision: (1) a GitHub URL the paper's own abstract names (any record,
 * zero requests, provider "abstract"); (2) a GitHub repository search per
 * arXiv id (provider "github"). Runs AFTER filters/grouping; since
 * 2026-08-10 the engine passes DROPPED records too (user wish -- their
 * code links matter as well), appended behind the kept ones so the cap
 * prefers on_target, then kept, then dropped. Failures degrade per
 * record, loudly; order and everything else ship unchanged.
 */
export async function addCodeLinks<T extends EnrichableRecord & { group?: string; abstract?: string }>(
	records: T[],
	warn: (message: string) => void = defaultWarn,
	signal?: AbortSignal,
): Promise<Array<Enriched<T> & { code_url?: string }>> {
	// Pass 1: the abstract names the repository -- the record is done and
	// spends no search budget.
	const abstractUrl = new Map<T, string>();
	for (const record of records) {
		const url = codeUrlFromAbstract(record.abstract);
		if (url !== null) abstractUrl.set(record, url);
	}
	// Pass 2 candidates: arXiv records still without a link, one per bare
	// id (codeLookupCandidates dedupes -- duplicate records share one
	// search and one capped slot).
	const searchable = records.filter((record) => !abstractUrl.has(record));
	const candidates = codeLookupCandidates(searchable);
	const eligible = new Set(
		searchable.filter((record) => record.arxiv_id).map((record) => bareArxivId(record.arxiv_id)),
	).size;
	if (eligible > candidates.length) {
		warn(`code links: lookup capped at ${candidates.length} of ${eligible} arXiv record(s); the rest stays unmarked`);
	}
	const token = githubToken();
	// Resolve the candidates first, keyed by bare id, so EVERY record
	// carrying that id receives the link -- including duplicates that were
	// not themselves candidates.
	const resolvedById = new Map<string, string | null>();
	let found = 0;
	for (const record of candidates) {
		if (signal?.aborted) throw new Error("search aborted by the user");
		try {
			const codeUrl = await fetchCodeLink(record.arxiv_id, token);
			resolvedById.set(bareArxivId(record.arxiv_id), codeUrl);
			if (codeUrl !== null) found++;
		} catch (error) {
			const name = record.title || record.doi || record.arxiv_id || "(unidentified record)";
			warn(`code lookup for "${name}" failed: ${error instanceof Error ? error.message : error}; record kept as delivered`);
		}
	}
	// One output per input, in input order -- the engine re-zips kept and
	// dropped records positionally and relies on this 1:1 mapping.
	const out: Array<Enriched<T> & { code_url?: string }> = records.map((record) => {
		const fromAbstract = abstractUrl.get(record);
		if (fromAbstract !== undefined) {
			return {
				...record,
				code_url: fromAbstract,
				enriched: { ...(record as Enriched<T>).enriched, code_url: "abstract" },
			};
		}
		const fromLookup = record.arxiv_id ? resolvedById.get(bareArxivId(record.arxiv_id)) : undefined;
		if (fromLookup !== undefined && fromLookup !== null) {
			return {
				...record,
				code_url: fromLookup,
				enriched: { ...(record as Enriched<T>).enriched, code_url: "github" },
			};
		}
		return record;
	});
	if (abstractUrl.size || candidates.length) {
		warn(`code links: ${abstractUrl.size} from abstract(s), ${found}/${candidates.length} from GitHub lookup(s)`);
	}
	return out;
}
