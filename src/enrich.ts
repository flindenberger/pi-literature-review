/**
 * Deterministic metadata enrichment for the search stage -- lookups at open
 * APIs, never scraping, never an LLM. Six stages live here:
 *
 *   1. enrichAll: records still missing citations, venue or abstract after
 *      dedupe are looked up at OpenAlex by DOI, in batches (arXiv records
 *      via their DataCite DOI); an abstract still missing afterwards is
 *      asked from Semantic Scholar by the record's own DOI (API key only).
 *   2. addJournalScores: the journal's OpenAlex 2-yr mean citedness (open
 *      analog of the impact factor), two batched lookups per run.
 *   3. fetchJournalScores / fetchAuthorMetrics: the batched lookups the
 *      wizard's journal and author pickers use.
 *   4. addCodeLinks: a code repository the paper's own abstract names
 *      (zero requests).
 *   5. addDataLinks: data and code archives the publisher linked to the
 *      paper in its CrossRef record, batched.
 *   6. addAccessStatus: open-access level and open PDF locations per
 *      paper from OpenAlex, batched (full text free, abstract only,
 *      restricted, unknown).
 *
 * Only empty fields are filled, never overwritten, and every filled field
 * is recorded in `enriched` (field -> provider) so JSON and HTML can mark
 * the provenance. A filled abstract also feeds the block labeling.
 */

import { s2ApiKey } from "./config.ts";
import { lookupDataLinksByDoi } from "./sources/crossref.ts";
import {
	type AccessInfo,
	type AccessLevel,
	fetchLookup,
	lookupAccessByDoi,
	reconstructAbstract,
} from "./sources/openalex.ts";
import { fetchAbstractByDoi } from "./sources/semanticscholar.ts";
import { contactMailto, type DataLink, userAgent, warn as defaultWarn } from "./types.ts";

const BASE_URL = "https://api.openalex.org/works";
const SOURCES_URL = "https://api.openalex.org/sources";
const AUTHORS_URL = "https://api.openalex.org/authors";
/** OpenAlex allows up to ~100 OR-joined values per filter; stay well under. */
const BATCH_SIZE = 50;

/** Query string for an OpenAlex request; the contact email (polite pool)
 * rides along whenever one is configured. */
function apiQuery(params: Record<string, string> = {}): string {
	const mailto = contactMailto();
	const merged = mailto ? { ...params, mailto } : params;
	return Object.keys(merged).length ? `?${new URLSearchParams(merged)}` : "";
}

/** One OpenAlex GET; non-2xx answers throw with the status. Uses the shared
 * lookup client from the OpenAlex module, so enrichment and the search stage
 * queue in one line towards the same server and a rate-limit answer is
 * retried instead of losing the field. */
async function fetchJson(url: string): Promise<Record<string, any>> {
	const response = await fetchLookup(url, {
		headers: { "User-Agent": userAgent(), Accept: "application/json" },
	});
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

/** The work objects for a batch of DOIs, keyed by lowercased DOI. One
 * OpenAlex request per BATCH_SIZE DOIs instead of one per record. */
async function fetchWorksByDoi(dois: string[]): Promise<Map<string, Record<string, any>>> {
	const works = new Map<string, Record<string, any>>();
	for (const batch of chunk([...new Set(dois.map((doi) => doi.toLowerCase()))], BATCH_SIZE)) {
		const data = await fetchJson(`${BASE_URL}${apiQuery({
			filter: `doi:${batch.join("|")}`,
			"per-page": String(BATCH_SIZE),
		})}`);
		for (const work of (data.results ?? []) as Array<Record<string, any>>) {
			const doi = typeof work.doi === "string" ? work.doi.replace("https://doi.org/", "").toLowerCase() : "";
			if (doi) works.set(doi, work);
		}
	}
	return works;
}

/**
 * Enrich all records that miss cites, venue or abstract and carry an
 * identifier. OpenAlex is asked in batches of DOIs; a failing batch
 * degrades gracefully (its records ship as delivered, with a warning).
 * Afterwards, when a Semantic Scholar API key is configured, S2 is asked
 * one record at a time for abstracts still missing (without a key its
 * anonymous pool is saturated nearly always -- not asked at all). The
 * lookup is injectable for tests, as is whether a key is configured.
 */
export async function enrichAll<T extends EnrichableRecord>(
	records: T[],
	warn: (message: string) => void = defaultWarn,
	abstractLookup: (doi: string, opts?: { retry?: boolean }) => Promise<string | null> = fetchAbstractByDoi,
	s2Keyed: boolean = !!s2ApiKey(),
): Promise<EnrichmentResult<T>> {
	const targets = records.filter((record) => lookupDoi(record) !== null && needsEnrichment(record));
	let works = new Map<string, Record<string, any>>();
	if (targets.length) {
		try {
			works = await fetchWorksByDoi(targets.map((record) => lookupDoi(record) as string));
		} catch (error) {
			warn(`enrichment lookup failed: ${error instanceof Error ? error.message : error}; affected records kept as delivered`);
		}
	}
	let gained = 0;
	let s2Lookups = 0;
	let s2Gained = 0;
	let s2Degraded = false;
	const s2AbstractFailures = new Map<string, string>();
	const out: Array<Enriched<T>> = [];
	for (const record of records) {
		const doi = lookupDoi(record);
		if (doi === null || !needsEnrichment(record)) {
			out.push(record);
			continue;
		}
		let current: Enriched<T> = record;
		const work = works.get(doi.toLowerCase());
		if (work) {
			const { record: enrichedRecord, filled } = applyEnrichment(record, work);
			if (filled.length) {
				gained++;
				warn(`enriched "${record.title}": ${filled.join(", ")} (openalex)`);
			}
			current = enrichedRecord;
		}
		// Second abstract source: Semantic Scholar by the record's own DOI,
		// only with an API key (arXiv DataCite DOIs are not asked -- arXiv
		// records always carry their abstract). Failure keeps the record as
		// it is, loudly, and is recorded so the drop reason can say "lookup
		// failed" instead of "delivered none". After the first hard failure
		// every remaining lookup is still tried, but once, without the
		// backoff sleeps -- a blocked service then costs seconds, not minutes.
		if (s2Keyed && !current.abstract && record.doi) {
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
	if (targets.length) warn(`enrichment: ${targets.length} lookup(s), ${gained} record(s) gained fields`);
	if (s2Lookups) {
		warn(`abstract lookups at Semantic Scholar: ${s2Lookups}, ${s2Gained} abstract(s) filled`
			+ (s2AbstractFailures.size ? `, ${s2AbstractFailures.size} lookup(s) failed` : ""));
	}
	return { records: out, s2AbstractFailures };
}

/* ---------------- Access stage (OpenAlex open-access status) ---------------- */

/**
 * Stamp every record with its access level and the open PDF locations
 * OpenAlex lists. Records with a DOI are looked up in batches; an arXiv
 * record is free in any case (the arXiv PDF endpoint always answers). A
 * failed lookup leaves the DOI records "unknown", with a warning. Maps
 * its input 1:1 (same length, same order); the lookup is injectable for
 * tests.
 */
export async function addAccessStatus<T extends EnrichableRecord>(
	records: T[],
	warn: (message: string) => void = defaultWarn,
	lookup: (dois: string[]) => Promise<Map<string, AccessInfo>> = lookupAccessByDoi,
): Promise<Array<T & { access: AccessInfo }>> {
	const dois = records.map((record) => record.doi).filter(Boolean);
	let byDoi = new Map<string, AccessInfo>();
	if (dois.length) {
		try {
			byDoi = await lookup(dois);
		} catch (error) {
			warn(`access lookup failed: ${error instanceof Error ? error.message : error}; access shown as unknown`);
		}
	}
	const out = records.map((record) => {
		const found = record.doi ? byDoi.get(record.doi.toLowerCase()) : undefined;
		let access: AccessInfo = found ?? { level: "unknown" };
		if (record.arxiv_id && access.level !== "abstract_only") access = { ...access, level: "free" };
		return { ...record, access };
	});
	const count = (level: AccessLevel) => out.filter((record) => record.access.level === level).length;
	warn(`access: ${count("free")} full text free, ${count("abstract_only")} abstract only, `
		+ `${count("restricted")} restricted, ${count("unknown")} unknown`);
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

/* ---------------- 4. Code links (abstract) ---------------- */

/** Repository created more than a year AFTER the paper = almost certainly
 * a third-party reimplementation or a project merely citing it (field-
 * measured: correct picks were created in the paper's year -1..0, wrong
 * ones 2-11 years later). No lower bound: code precedes publication, and
 * preprint->journal delay stretches the gap. Unreadable year on either
 * side disables the gate -- absence is not evidence. Used by the
 * code-first sources (codesearch.ts). */
export function createdTooLate(createdAt: unknown, year: string | null): boolean {
	const paperYear = Number.parseInt(year ?? "", 10);
	const created = typeof createdAt === "string" ? Number.parseInt(createdAt.slice(0, 4), 10) : NaN;
	if (!Number.isFinite(paperYear) || !Number.isFinite(created)) return false;
	return created > paperYear + 1;
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

/**
 * Attach code_url from the paper's own abstract (provider "abstract"):
 * zero requests, runs on every search. Records that already carry a link
 * (the code-first sources set it) are left alone -- only empty fields are
 * filled, never rewritten. Maps its input 1:1 (same length, same order):
 * the engine re-zips kept and dropped records positionally.
 */
export function addCodeLinks<T extends EnrichableRecord & { abstract?: string }>(
	records: T[],
	warn: (message: string) => void = defaultWarn,
): Array<Enriched<T> & { code_url?: string }> {
	let fromAbstract = 0;
	const out = records.map((record) => {
		if ((record as { code_url?: string }).code_url) return record;
		const url = codeUrlFromAbstract(record.abstract);
		if (url === null) return record;
		fromAbstract++;
		return {
			...record,
			code_url: url,
			enriched: { ...(record as Enriched<T>).enriched, code_url: "abstract" },
		};
	});
	if (fromAbstract) warn(`code links: ${fromAbstract} from abstract(s)`);
	return out;
}

/* ---------------- 5. Data links (CrossRef relation metadata) ---------------- */

/**
 * Attach the data and code archives the publisher linked to each paper in
 * its CrossRef record (field data_links, provider "crossref" in
 * `enriched`). One batched request per 40 DOIs, on every search; records
 * without a DOI, or whose DOI CrossRef does not hold, stay unchanged. A
 * failed lookup leaves all records unchanged, with a warning. Maps its
 * input 1:1 (same length, same order); the lookup is injectable for tests.
 */
export async function addDataLinks<T extends EnrichableRecord>(
	records: T[],
	warn: (message: string) => void = defaultWarn,
	lookup: (dois: string[]) => Promise<Map<string, DataLink[]>> = lookupDataLinksByDoi,
): Promise<Array<Enriched<T> & { data_links?: DataLink[] }>> {
	const dois = records.map((record) => record.doi).filter(Boolean);
	let byDoi = new Map<string, DataLink[]>();
	if (dois.length) {
		try {
			byDoi = await lookup(dois);
		} catch (error) {
			warn(`data-link lookup failed: ${error instanceof Error ? error.message : error}; records ship without data links`);
		}
	}
	let linked = 0;
	const out = records.map((record) => {
		const found = record.doi ? byDoi.get(record.doi.toLowerCase()) : undefined;
		if (!found?.length) return record;
		linked++;
		return {
			...record,
			data_links: found,
			enriched: { ...(record as Enriched<T>).enriched, data_links: "crossref" },
		};
	});
	if (linked) warn(`data links: ${linked} record(s) with data or code archives from CrossRef`);
	return out;
}
