/**
 * Orchestration: one call runs the full deterministic pipeline
 * (search -> filter -> dedupe -> verify -> group) and returns the emit
 * payload. Used by both the standalone CLI and the Pi extension tool.
 * Contains no LLM call of any kind; every record field traces to a
 * search-API response.
 */

import {
	applyFilters,
	dedupe,
	filterRecords,
	groupAll,
	type ResultFilters,
	sanitizeTermGroups,
	type SortKey,
	sortRecords,
} from "./pipeline.ts";
import { addJournalScores, enrichAll } from "./enrich.ts";
import { buildSearchQuery, searchArxiv } from "./sources/arxiv.ts";
import { searchCrossref } from "./sources/crossref.ts";
import { searchOpenalex } from "./sources/openalex.ts";
import type { SourceRecord } from "./types.ts";
import { verifyAll } from "./verify.ts";

type Searcher = (query: string, perSource: number) => Promise<SourceRecord[]>;

export const SEARCHERS: Record<string, Searcher> = {
	arxiv: searchArxiv,
	crossref: searchCrossref,
	openalex: searchOpenalex,
};

export const DEFAULT_PER_SOURCE = 5;
/** Politeness cap towards the free APIs. */
export const MAX_PER_SOURCE = 50;

export interface SearchOptions {
	query: string;
	/** Additional phrasings of the same question, searched in the same run;
	 * results are deduplicated ACROSS variants and each record notes which
	 * variants found it (found_by). The variants come from the agent -- that
	 * is query shaping, the one allowed LLM contribution besides word lists. */
	queryVariants?: string[];
	perSource?: number;
	sources?: string[];
	/** Grouping rules (term groups); see pipeline.ts. Optional. */
	groupTerms?: unknown;
	/** Metadata filters (min citations, year range, venues, ...). Optional. */
	filters?: ResultFilters;
	/** Sort results descending by "cites" or "year" (unknown values last). */
	sort?: SortKey;
	/** Fill missing cites/venue via an OpenAlex identifier lookup; filled
	 * fields are marked in each record's `enriched` map. Default: true. */
	enrich?: boolean;
	/** Receives diagnostics (drops, failures, counts). Default: silent. */
	onWarn?: (message: string) => void;
	/** Abort signal from the agent (Esc). Checked between network steps;
	 * an aborted run throws instead of returning a partial payload. */
	signal?: AbortSignal;
}

export async function runSearch(options: SearchOptions) {
	const warn = options.onWarn ?? (() => {});
	const perSource = Math.min(
		Math.max(1, Math.trunc(options.perSource ?? DEFAULT_PER_SOURCE)),
		MAX_PER_SOURCE,
	);
	const sources = options.sources?.length ? options.sources : Object.keys(SEARCHERS);
	const termGroups = sanitizeTermGroups(options.groupTerms);

	// The primary query plus distinct variants (trimmed, case-insensitive dedupe).
	const queries: string[] = [];
	for (const candidate of [options.query, ...(options.queryVariants ?? [])]) {
		const query = typeof candidate === "string" ? candidate.trim() : "";
		if (query && !queries.some((q) => q.toLowerCase() === query.toLowerCase())) {
			queries.push(query);
		}
	}
	const multiQuery = queries.length > 1;

	const aborted = () => {
		if (options.signal?.aborted) throw new Error("search aborted by the user");
	};

	const records: SourceRecord[] = [];
	const sourcesUsed: string[] = [];
	for (const source of sources) {
		const search = SEARCHERS[source];
		if (!search) {
			warn(`unknown source '${source}'; skipping (available: ${Object.keys(SEARCHERS).join(", ")})`);
			continue;
		}
		let succeeded = false;
		for (const [index, query] of queries.entries()) {
			aborted();
			const label = multiQuery ? `source '${source}' (Q${index + 1})` : `source '${source}'`;
			try {
				const found = await search(query, perSource);
				warn(`${label}: ${found.length} record(s)`);
				records.push(...(multiQuery ? found.map((r) => ({ ...r, found_by: [query] })) : found));
				succeeded = true;
			} catch (error) {
				warn(`${label} failed: ${error instanceof Error ? error.message : error}`);
			}
		}
		if (succeeded) sourcesUsed.push(source);
	}

	const { kept, dropped } = filterRecords(records);
	for (const { record, reason } of dropped) {
		const label = record.title || record.doi || record.arxiv_id || "(no identifier)";
		warn(`dropped [${record.source}] "${label}": ${reason}`);
	}
	const deduped = dedupe(kept);
	if (deduped.length < kept.length) {
		warn(`dedupe merged ${kept.length - deduped.length} duplicate record(s)`);
	}
	aborted();
	const verified = await verifyAll(deduped, warn, options.signal);
	warn(`verified ${verified.filter((r) => r.verified).length}/${verified.length} records`);

	// Enrichment runs before the user filters so that e.g. min_cites can act
	// on a looked-up count instead of dropping an arXiv record as unknown.
	// The journal-score stage rides on the same switch: enrich: false turns
	// off all OpenAlex lookups beyond the search itself.
	aborted();
	const enriched = options.enrich === false ? verified : await enrichAll(verified, warn);
	aborted();
	const scored = options.enrich === false ? enriched : await addJournalScores(enriched, warn);

	const filters = options.filters ?? {};
	const filterResult = applyFilters(scored, filters);
	for (const { record, reason } of filterResult.dropped) {
		warn(`${reason}: "${record.title}"`);
	}
	if (filterResult.dropped.length) {
		warn(`filters removed ${filterResult.dropped.length} record(s), kept ${filterResult.kept.length}`);
	}

	const sorted = options.sort ? sortRecords(filterResult.kept, options.sort) : filterResult.kept;
	const grouped = groupAll(sorted, termGroups);
	if (termGroups.length) {
		const onTarget = grouped.filter((r) => r.group === "on_target").length;
		warn(`grouped: ${onTarget} on_target, ${grouped.length - onTarget} adjacent`);
	} else {
		warn("no grouping rules supplied; results are ungrouped");
	}

	// Dropped records stay inspectable: nothing disappears silently --
	// junk drops and user-filter drops alike ship with full record and
	// reason. Grouping rules and filters used are part of the payload, so
	// every label and every exclusion is reproducible by the reader.
	const filtersActive = Object.values(filters).some(
		(value) => value !== undefined && (!Array.isArray(value) || value.length),
	);
	return {
		query: queries[0] ?? options.query,
		query_variants: multiQuery ? queries.slice(1) : null,
		generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		sources_used: sourcesUsed,
		// Transparency (design/2026-07-14_v18): the boolean expression actually
		// sent to arXiv per query, so every reader can verify what was asked.
		// CrossRef/OpenAlex receive the query text unchanged.
		arxiv_queries: sourcesUsed.includes("arxiv") ? queries.map(buildSearchQuery) : null,
		grouping: termGroups.length ? termGroups : null,
		filters: filtersActive ? filters : null,
		sort: options.sort ?? null,
		results: grouped,
		dropped: [
			...dropped.map(({ reason, record }) => ({ reason, record })),
			...filterResult.dropped.map(({ reason, record }) => ({ reason, record })),
		],
	};
}
