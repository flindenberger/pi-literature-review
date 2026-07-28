/**
 * Deterministic metadata enrichment (Phase 5, step 3).
 *
 * Some search sources cannot deliver certain fields at all: arXiv, a
 * preprint server, has no citation counts and no journal. For records that
 * still miss cites or venue after dedupe, one identifier lookup at OpenAlex
 * (GET api.openalex.org/works/doi:<doi>) fills the gap -- an open API, not
 * scraping, and no LLM. Only empty fields are filled, never overwritten,
 * and every filled field is recorded in `enriched` (field -> provider) so
 * both the JSON and the HTML rendering can mark the provenance.
 */

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
	/** OpenAlex source (journal) ID; captured at search time or filled here. */
	venue_id?: string;
}

export type Enriched<T> = T & { enriched?: Record<string, string> };

function needsEnrichment(record: EnrichableRecord): boolean {
	return record.cites === null || !record.venue;
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
	// The journal ID is lookup plumbing for the journal-score stage, not
	// user-facing metadata; filled quietly, visible in the JSON as venue_id.
	const venueId = work?.primary_location?.source?.id;
	if (!record.venue_id && typeof venueId === "string" && venueId.trim()) {
		result.venue_id = venueId.replace("https://openalex.org/", "").trim();
	}
	if (filled.length) {
		result.enriched = Object.fromEntries(filled.map((field) => [field, "openalex"]));
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
): Promise<Array<Enriched<T>>> {
	const out: Array<Enriched<T>> = [];
	let lookups = 0;
	let gained = 0;
	for (const record of records) {
		const doi = lookupDoi(record);
		if (doi === null || !needsEnrichment(record)) {
			out.push(record);
			continue;
		}
		lookups++;
		try {
			const mailto = contactMailto();
			const query = mailto ? `?${new URLSearchParams({ mailto })}` : "";
			const response = await fetch(`${BASE_URL}/doi:${doi}${query}`, {
				headers: { "User-Agent": userAgent(), Accept: "application/json" },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!response.ok) {
				warn(`enrichment lookup for "${record.title}" answered HTTP ${response.status}; record kept as delivered`);
				out.push(record);
				continue;
			}
			const work = (await response.json()) as Record<string, any>;
			const { record: enrichedRecord, filled } = applyEnrichment(record, work);
			if (filled.length) {
				gained++;
				warn(`enriched "${record.title}": ${filled.join(", ")} (openalex)`);
			}
			out.push(enrichedRecord);
		} catch (error) {
			warn(`enrichment lookup for "${record.title}" failed: ${error instanceof Error ? error.message : error}; record kept as delivered`);
			out.push(record);
		}
	}
	if (lookups) warn(`enrichment: ${lookups} lookup(s), ${gained} record(s) gained fields`);
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
				select: "id,cited_by_count,works_count,summary_stats",
				"per-page": String(BATCH_SIZE),
			})}`);
			for (const author of (data.results ?? []) as Array<Record<string, any>>) {
				const id = typeof author.id === "string" ? author.id.replace("https://openalex.org/", "").trim() : "";
				if (!id) continue;
				const number = (value: unknown): number | undefined =>
					typeof value === "number" && Number.isFinite(value) ? value : undefined;
				byAuthorId.set(id, {
					cites: number(author.cited_by_count),
					works: number(author.works_count),
					hIndex: number(author?.summary_stats?.h_index),
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
