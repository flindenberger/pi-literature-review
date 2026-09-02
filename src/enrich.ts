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
 *   4. addCodeLinks: a code repository per paper -- from the abstract
 *      text, else one guarded GitHub search per arXiv id or DOI (a
 *      disclosed heuristic).
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

export interface EnrichmentResult<T> {
	records: Array<Enriched<T>>;
	/** DOI -> error message for records whose Semantic Scholar abstract
	 * lookup FAILED (rate limit, network); empty when every lookup answered.
	 * The caller words the abstract-gate drop reason and the payload's
	 * failure entry from this -- a failed lookup must never read as
	 * "the source has no abstract". */
	s2AbstractFailures: Map<string, string>;
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
	abstractLookup: (doi: string, opts?: { retry?: boolean }) => Promise<string | null> = fetchAbstractByDoi,
): Promise<EnrichmentResult<T>> {
	const out: Array<Enriched<T>> = [];
	let lookups = 0;
	let gained = 0;
	let s2Lookups = 0;
	let s2Gained = 0;
	let s2Degraded = false;
	const s2AbstractFailures = new Map<string, string>();
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
		// first hard failure every remaining lookup is still TRIED, but only
		// once, without the backoff sleeps -- a blocked pool then costs
		// seconds instead of minutes, and if it opens up mid-run the later
		// records still get their abstracts. Every failure is recorded so
		// the drop reason and the payload can say "lookup failed" instead of
		// "delivered none".
		if (!current.abstract && record.doi) {
			s2Lookups++;
			try {
				const abstract = await abstractLookup(record.doi, { retry: !s2Degraded });
				if (abstract) {
					s2Gained++;
					current = { ...current, abstract, enriched: { ...current.enriched, abstract: "semanticscholar" } };
					warn(`enriched "${record.title}": abstract (semanticscholar)`);
				}
			} catch (error) {
				s2AbstractFailures.set(record.doi, error instanceof Error ? error.message : String(error));
				if (!s2Degraded) {
					s2Degraded = true;
					warn(`abstract lookup at Semantic Scholar for "${record.title}" failed: ${s2AbstractFailures.get(record.doi)}; record kept as delivered, the remaining lookups of this run are tried once each without retries`);
				}
			}
		}
		out.push(current);
	}
	if (lookups) warn(`enrichment: ${lookups} lookup(s), ${gained} record(s) gained fields`);
	if (s2Lookups) {
		warn(`abstract lookups at Semantic Scholar: ${s2Lookups}, ${s2Gained} abstract(s) filled`
			+ (s2AbstractFailures.size ? `, ${s2AbstractFailures.size} lookup(s) failed` : ""));
	}
	return { records: out, s2AbstractFailures };
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
 * Code-link stage: ONE GitHub repository search per record (q = "<key>"
 * in:name,description,readme, key = bare arXiv id or, for journal papers,
 * the DOI) attaches the best-matching repository as code_url -- the
 * stand-in for Papers with Code, which has no public API any more (an API
 * would replace this heuristic). A HEURISTIC, disclosed as such in the
 * HTML: the repo mentions the paper, nothing here verifies it IS the
 * paper's code. Field-measured guards keep it honest: repositories
 * created more than a year after the paper are skipped (third-party
 * reimplementations appear years later; author repos appear with the
 * paper), and a DOI match is only linked when the repository owner's
 * name matches an author (DOIs in READMEs are usually citations, not the
 * authors' code -- the owner name separated correct from wrong picks
 * perfectly in the field test; arXiv-id matches skip the owner rule
 * because author repos there often live under organization accounts).
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

/** The paper a search answer is judged against, plus how strictly. */
export interface CodePaperContext {
	year: string | null;
	title: string;
	/** Author display names; consulted only when requireOwner is set. */
	authors?: string[];
	/** DOI path: a pick must have an owner matching an author name. */
	requireOwner?: boolean;
}

/** Repository created more than a year AFTER the paper = almost certainly
 * a third-party reimplementation or a project merely citing it (field-
 * measured: correct picks were created in the paper's year -1..0, wrong
 * ones 2-11 years later). No lower bound: code precedes publication, and
 * preprint->journal delay stretches the gap. Unreadable year on either
 * side disables the gate -- absence is not evidence. */
function createdTooLate(createdAt: unknown, year: string | null): boolean {
	const paperYear = Number.parseInt(year ?? "", 10);
	const created = typeof createdAt === "string" ? Number.parseInt(createdAt.slice(0, 4), 10) : NaN;
	if (!Number.isFinite(paperYear) || !Number.isFinite(created)) return false;
	return created > paperYear + 1;
}

/** Repo-name tokens for the title check: split on separators and
 * camelCase, keep tokens of at least 4 characters, lowercased. */
function repoNameTokens(name: string): string[] {
	const tokens: string[] = [];
	for (const part of name.split(/[-_.\s]+/)) {
		tokens.push(...(part.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []));
	}
	return tokens.map((token) => token.toLowerCase()).filter((token) => token.length >= 4);
}

/** Does the repository owner's login look like one of the authors?
 * Two login patterns cover the field-measured correct picks: a name
 * part of at least 4 characters contained in the login (IamShubhamGupto
 * ~ "Shubham Gupta", connorlee77 ~ "Connor Lee"), or the classic
 * initial+surname login (kvos ~ "Kilian Vos"). Shorter fragments are
 * skipped -- too many false matches. Pure. */
export function ownerMatchesAuthor(login: string, authors: string[]): boolean {
	const lower = login.toLowerCase();
	if (!lower) return false;
	for (const author of authors) {
		const parts = author.toLowerCase().split(/[^a-z]+/).filter(Boolean);
		for (const part of parts) {
			if (part.length >= 4 && lower.includes(part)) return true;
		}
		if (parts.length >= 2) {
			const initialSurname = parts[0][0] + parts[parts.length - 1];
			if (initialSurname.length >= 4 && lower.includes(initialSurname)) return true;
		}
	}
	return false;
}

/** Pick the repository URL from a GitHub search answer, judged against
 * the paper: usable html_url, not an aggregator/reading-list name, not
 * created long after the paper, owner matching an author when the
 * context demands it (DOI path). Among the survivors, one whose name
 * shares a word with the paper title wins (the method name usually IS
 * the repo name); otherwise GitHub's best-match order stands -- the
 * title check is a preference, never a requirement (correct repos
 * without a title word exist). Pure. */
export function pickCodeRepo(data: Record<string, any>, paper: CodePaperContext): string | null {
	const survivors = ((data?.items ?? []) as Array<Record<string, any>>)
		.filter((entry) => typeof entry?.html_url === "string" && entry.html_url.startsWith("https://")
			&& !LIST_REPO_NAME.test(String(entry?.name ?? ""))
			&& !createdTooLate(entry?.created_at, paper.year)
			&& (!paper.requireOwner || ownerMatchesAuthor(String(entry?.owner?.login ?? ""), paper.authors ?? [])));
	const title = paper.title.toLowerCase();
	const titled = survivors.find((entry) =>
		repoNameTokens(String(entry?.name ?? "")).some((token) => title.includes(token)));
	const item = titled ?? survivors[0];
	return item ? (item.html_url as string) : null;
}

/** Non-GitHub hosts the abstract may name a repository or code archive
 * on: git forges need owner/repo (an owner-only profile link is no
 * repository), Hugging Face allows model/dataset paths, Zenodo a record
 * id, OSF a short id. The URL ships as found (minus trailing
 * .git/punctuation); GitHub keeps its canonical owner/repo rebuild
 * below. */
const OTHER_CODE_HOSTS = /https?:\/\/(?:www\.)?(?:(?:gitlab\.com|bitbucket\.org|codeberg\.org)\/[\w.-]+\/[\w.-]+|huggingface\.co\/(?:datasets\/)?[\w.-]+(?:\/[\w.-]+)?|zenodo\.org\/records?\/\w+|osf\.io\/\w+)/i;

/**
 * A repository the paper's own ABSTRACT names (many papers write "code
 * available at https://github.com/...") -- the most precise code signal
 * there is, straight from the search API's record, zero requests. A
 * GitHub link wins when several hosts appear (code host over archive);
 * trailing .git and punctuation stripped. Pure.
 */
export function codeUrlFromAbstract(abstract: string | undefined): string | null {
	const match = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(abstract ?? "");
	if (match) {
		const repo = match[2].replace(/\.git$/i, "").replace(/[.,;:!?]+$/, "");
		if (repo) return `https://github.com/${match[1]}/${repo}`;
	}
	const other = OTHER_CODE_HOSTS.exec(abstract ?? "");
	if (!other) return null;
	return other[0].replace(/\.git$/i, "").replace(/[.,;:!?]+$/, "");
}

/** The version-free arXiv id -- the most precise GitHub search key. Pure. */
export function bareArxivId(arxivId: string): string {
	return arxivId.replace(/v\d+$/i, "");
}

/** A record's GitHub search key: the bare arXiv id when present, else its
 * DOI (journal papers; the stricter DOI pick rules apply). Also the
 * dedupe key of the lookup stage (the same paper may enter twice, e.g.
 * junk drops collected per query variant before deduplication). Pure. */
export function codeSearchKey(record: { arxiv_id: string; doi?: string }): string {
	return record.arxiv_id ? bareArxivId(record.arxiv_id) : (record.doi ?? "");
}

/** Which records get a lookup: arxiv_id or doi holders, on_target ones
 * first (the cap should spend its budget on the labeled hits), one
 * candidate per search key (a duplicate would burn a capped slot on an
 * identical search), capped. Pure; stable within each priority class. */
export function codeLookupCandidates<T extends { arxiv_id: string; doi?: string; group?: string }>(
	records: T[],
	cap: number = CODE_LOOKUP_CAP,
): T[] {
	const withKey = records.filter((record) => codeSearchKey(record));
	const seen = new Set<string>();
	return [
		...withKey.filter((record) => record.group === "on_target"),
		...withKey.filter((record) => record.group !== "on_target"),
	].filter((record) => {
		const key = codeSearchKey(record);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).slice(0, Math.max(0, cap));
}

async function fetchCodeLink(searchKey: string, paper: CodePaperContext, token: string): Promise<string | null> {
	const params = new URLSearchParams({
		q: `"${searchKey}" in:name,description,readme`,
		per_page: "3",
	});
	const response = await fetchGithub(`${GITHUB_SEARCH_URL}?${params}`, {
		headers: {
			"User-Agent": userAgent(),
			Accept: "application/vnd.github+json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});
	return pickCodeRepo((await response.json()) as Record<string, any>, paper);
}

/**
 * Attach code_url to records. Two deterministic signals, in order of
 * precision: (1) a repository URL the paper's own abstract names (any
 * record, zero requests, provider "abstract"); (2) a GitHub repository
 * search per record -- by arXiv id, or by DOI with the stricter
 * owner-must-match-an-author rule (provider "github" either way). Runs
 * AFTER filters/grouping; the engine passes kept AND dropped records,
 * dropped ones appended behind, so the cap prefers on_target, then kept,
 * then dropped. Failures degrade per record, loudly; order and
 * everything else ship unchanged (one output per input, same order).
 */
export async function addCodeLinks<T extends EnrichableRecord & {
	group?: string; abstract?: string; year?: string | null; authors?: string[];
}>(
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
	// Pass 2 candidates: records still without a link, one per search key
	// (codeLookupCandidates dedupes -- duplicate records share one search
	// and one capped slot).
	const searchable = records.filter((record) => !abstractUrl.has(record));
	const candidates = codeLookupCandidates(searchable);
	const eligible = new Set(
		searchable.map((record) => codeSearchKey(record)).filter(Boolean),
	).size;
	if (eligible > candidates.length) {
		warn(`code links: lookup capped at ${candidates.length} of ${eligible} record(s); the rest stays unmarked`);
	}
	const token = githubToken();
	// Resolve the candidates first, keyed by search key, so EVERY record
	// carrying that key receives the link -- including duplicates that were
	// not themselves candidates.
	const resolvedByKey = new Map<string, string | null>();
	let found = 0;
	for (const record of candidates) {
		if (signal?.aborted) throw new Error("search aborted by the user");
		try {
			const codeUrl = await fetchCodeLink(codeSearchKey(record), {
				year: record.year ?? null,
				title: record.title,
				authors: record.authors,
				requireOwner: !record.arxiv_id,
			}, token);
			resolvedByKey.set(codeSearchKey(record), codeUrl);
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
		const key = codeSearchKey(record);
		const fromLookup = key ? resolvedByKey.get(key) : undefined;
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
