/**
 * Deterministic metadata enrichment for the search stage -- lookups at open
 * APIs, never scraping, never an LLM. Four stages live here:
 *
 *   1. enrichAll: records still missing citations, venue or abstract after
 *      dedupe get ONE OpenAlex work lookup by DOI (arXiv records via their
 *      DataCite DOI); an abstract still missing afterwards is asked from
 *      Semantic Scholar by the record's own DOI.
 *   2. addJournalScores: the journal's OpenAlex 2-yr mean citedness (open
 *      analog of the impact factor), two batched lookups per run.
 *   3. fetchJournalScores / fetchAuthorMetrics: the batched lookups the
 *      wizard's journal and author pickers use.
 *   4. addCodeLinks: a GitHub repository per paper -- from the abstract
 *      text, else one GitHub search per arXiv id (a disclosed heuristic).
 *
 * Only empty fields are filled, never overwritten, and every filled field
 * is recorded in `enriched` (field -> provider) so JSON and HTML can mark
 * the provenance. A filled abstract also feeds the block labeling.
 */

import { githubToken } from "./config.ts";
import { pacedClient } from "./sources/polite.ts";
import { reconstructAbstract } from "./sources/openalex.ts";
import { fetchAbstractByDoi } from "./sources/semanticscholar.ts";
import { contactMailto, userAgent, warn as defaultWarn } from "./types.ts";

const BASE_URL = "https://api.openalex.org/works";
const SOURCES_URL = "https://api.openalex.org/sources";
const AUTHORS_URL = "https://api.openalex.org/authors";
const TIMEOUT_MS = 30_000;
/** OpenAlex allows up to ~100 OR-joined values per filter; stay well under. */
const BATCH_SIZE = 50;

/** Query string for an OpenAlex request; the contact email (polite pool)
 * rides along whenever one is configured. */
function apiQuery(params: Record<string, string> = {}): string {
	const mailto = contactMailto();
	const merged = mailto ? { ...params, mailto } : params;
	return Object.keys(merged).length ? `?${new URLSearchParams(merged)}` : "";
}

/** One OpenAlex GET; non-2xx answers throw with the status. */
async function fetchJson(url: string): Promise<Record<string, any>> {
	const response = await fetch(url, {
		headers: { "User-Agent": userAgent(), Accept: "application/json" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`OpenAlex answered HTTP ${response.status}`);
	return (await response.json()) as Record<string, any>;
}

/** Split a list into batches of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

/** OpenAlex ids arrive as full URLs; keep the bare id (W..., S..., A...). */
function bareOpenAlexId(value: unknown): string {
	return typeof value === "string" ? value.replace("https://openalex.org/", "").trim() : "";
}

/* ---------------- 1. Field enrichment (OpenAlex + Semantic Scholar) ---------------- */

export interface EnrichableRecord {
	title: string;
	doi: string;
	arxiv_id: string;
	cites: number | null;
	venue: string;
	/** Missing abstracts are filled too (optional: minimal callers and
	 * fixtures need not carry one). */
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
	// OpenAlex ships the abstract as an inverted index in the SAME work
	// object; the reconstruction is pure string ops (openalex.ts).
	const abstract = reconstructAbstract(work?.abstract_inverted_index);
	if (!record.abstract && abstract) {
		result.abstract = abstract;
		filled.push("abstract");
	}
	// The journal ID is lookup plumbing for the journal-score stage, not
	// user-facing metadata; filled quietly, visible in the JSON as venue_id.
	const venueId = bareOpenAlexId(work?.primary_location?.source?.id);
	if (!record.venue_id && venueId) result.venue_id = venueId;
	if (filled.length) {
		// MERGE with what earlier stages recorded -- overwriting the map
		// would silently erase their provenance.
		result.enriched = {
			...(record as Enriched<T>).enriched,
			...Object.fromEntries(filled.map((field) => [field, "openalex"])),
		};
	}
	return { record: result, filled };
}

/**
 * Enrich all records that miss cites, venue or abstract and carry an
 * identifier. A failing lookup degrades gracefully: the record ships as
 * delivered, with a warning. Sequential requests, politeness towards the
 * free APIs. The Semantic Scholar lookup is injectable for tests.
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
			const work = await fetchJson(`${BASE_URL}/doi:${doi}${apiQuery()}`);
			const { record: enrichedRecord, filled } = applyEnrichment(record, work);
			if (filled.length) {
				gained++;
				warn(`enriched "${record.title}": ${filled.join(", ")} (openalex)`);
			}
			current = enrichedRecord;
		} catch (error) {
			warn(`enrichment lookup for "${record.title}" failed: ${error instanceof Error ? error.message : error}; record kept as delivered`);
		}
		// Second abstract source: Semantic Scholar by the record's own DOI
		// (arXiv DataCite DOIs are not asked -- arXiv records always carry
		// their abstract). Failure keeps the record as it is, loudly. The
		// anonymous S2 pool rate-limits for minutes at a time; after the
		// first hard failure the remaining lookups of this run are skipped
		// instead of each burning its own retries.
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

/* ---------------- 2. Journal-score stage ---------------- */

/** Stamp each record with its journal's score. Pure; nothing overwritten. */
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
				const id = bareOpenAlexId(work?.primary_location?.source?.id);
				if (doi && id) venueIdByDoi.set(doi, id);
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

/* ---------------- 3. Picker lookups: author metrics, journal scores ---------------- */

/** What OpenAlex publishes about an author (the wizard's author list shows
 * it next to the hit count). All plain API metadata. */
export interface AuthorMetrics {
	/** Total citations of everything this author published. */
	cites: number | undefined;
	works: number | undefined;
	hIndex: number | undefined;
	/** The author's main research areas: top OpenAlex topics by work count,
	 * shown behind the h-index in the author tab. Plain API display names,
	 * nothing derived. */
	topics: string[] | undefined;
}

/**
 * Fetch citation counts / works / h-index / top topics for a set of
 * OpenAlex author ids, in batches. Failures leave authors unscored,
 * loudly; only finite API numbers land in the map. Nothing here is
 * derived, guessed or model-generated.
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
				const id = bareOpenAlexId(author.id);
				if (!id) continue;
				const number = (value: unknown): number | undefined =>
					typeof value === "number" && Number.isFinite(value) ? value : undefined;
				// OpenAlex orders an author's topics by work count already; the
				// top entries are the person's main research areas across their
				// ENTIRE work.
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

/**
 * Fetch the OpenAlex 2-yr mean citedness for a set of journal ids, in
 * batches (the wizard's journal list shows the score too). Failures leave
 * journals unscored, loudly; the map only ever contains finite numbers
 * from the API.
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
				const id = bareOpenAlexId(source.id);
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

/* ---------------- 4. Code links (GitHub heuristic) ---------------- */

/**
 * Code-link stage: for records carrying an arXiv id, ONE GitHub repository
 * search per record (q = "<id>" in:name,description,readme) attaches the
 * best-matching repository as code_url -- the stand-in for Papers with
 * Code, which has no public API any more (an API would replace this
 * heuristic). A HEURISTIC, disclosed as such in the HTML: the repo
 * mentions the paper, nothing here verifies it IS the paper's code. Only
 * records with an arxiv_id are looked up -- DOI-only journal papers have
 * no comparably precise search key (a title search would guess).
 */
const GITHUB_SEARCH_URL = "https://api.github.com/search/repositories";
/** GitHub's search rate limit is 10 requests/min unauthenticated, 30/min
 * with a token. Module-wide pacing, spanning back-to-back runs; GitHub
 * answers rate-limit violations with 403 or 429. */
const GITHUB_SPACING_MS = 6_500;
const GITHUB_SPACING_AUTH_MS = 2_100;
const fetchGithub = pacedClient({
	label: "GitHub",
	spacingMs: () => (githubToken() ? GITHUB_SPACING_AUTH_MS : GITHUB_SPACING_MS),
	rateLimitStatuses: [403, 429],
});
/** Per-run lookup cap: keeps the stage's worst case around a minute
 * (cap x 6.5s unauthenticated). Capped-out records honestly stay
 * unmarked, with a warn line naming the count. */
export const CODE_LOOKUP_CAP = 12;

/** Aggregator repositories (daily arXiv digests, awesome lists, survey
 * collections) mention THOUSANDS of arXiv ids in their READMEs and are
 * never the paper's code. Matched on the repo NAME; precision over
 * recall, a skipped legitimate repo just means no link. */
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
	const params = new URLSearchParams({
		q: `"${bareArxivId(arxivId)}" in:name,description,readme`,
		per_page: "3",
	});
	const response = await fetchGithub(`${GITHUB_SEARCH_URL}?${params}`, {
		headers: {
			"User-Agent": userAgent(),
			Accept: "application/vnd.github+json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});
	return pickCodeRepo((await response.json()) as Record<string, any>);
}

/**
 * Attach code_url to records. Two deterministic signals, in order of
 * precision: (1) a GitHub URL the paper's own abstract names (any record,
 * zero requests, provider "abstract"); (2) a GitHub repository search per
 * arXiv id (provider "github"). Runs AFTER filters/grouping; the engine
 * passes kept AND dropped records, dropped ones appended behind, so the
 * cap prefers on_target, then kept, then dropped. Failures degrade per
 * record, loudly; order and everything else ship unchanged (one output
 * per input, same order).
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
