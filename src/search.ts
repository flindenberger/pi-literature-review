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
	dropWithoutAbstract,
	filterRecords,
	groupAcrossQueries,
	type ResultFilters,
	sanitizeTermGroups,
	type SortKey,
	sortRecords,
	type TermGroups,
} from "./pipeline.ts";
import { addCodeLinks, addJournalScores, enrichAll } from "./enrich.ts";
import { queryBlocks } from "./intake.ts";
import { buildSearchQuery, searchArxiv } from "./sources/arxiv.ts";
import { flattenBlockTerms, searchCrossref } from "./sources/crossref.ts";
import { buildBlockSearch, searchOpenalex } from "./sources/openalex.ts";
import { buildBulkQuery, searchSemanticScholar } from "./sources/semanticscholar.ts";
import type { SourceRecord, SourceScope } from "./types.ts";
import { verifyAll } from "./verify.ts";

type Searcher = (query: string, perSource: number, scope?: SourceScope) => Promise<SourceRecord[]>;

export const SEARCHERS: Record<string, Searcher> = {
	arxiv: searchArxiv,
	crossref: searchCrossref,
	openalex: searchOpenalex,
	// 4th source (2026-08-10): boolean via the bulk endpoint, citation-
	// sorted; degrades loudly without an API key (see the module header).
	semanticscholar: searchSemanticScholar,
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
	/** Grouping rules (term groups); see pipeline.ts. Optional. Since the
	 * block search (2026-08-06) these are the BASE query's concept blocks:
	 * they label on_target/adjacent AND go out as the boolean source query
	 * (arXiv, OpenAlex; CrossRef gets the flattened terms). Without them
	 * every query derives its own blocks (queryBlocks). */
	groupTerms?: unknown;
	/** on_target needs only this many groups to match (default: all) --
	 * the wide "any two concepts" variant (v30.3). */
	groupRequire?: number;
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

	// Concept blocks per query (2026-08-06 block search): agent group_terms
	// override the BASE query's blocks; every other query derives its own
	// (an expression like "(river OR stream) AND (mask)" parses, plain
	// keywords become one block per content word; quoted/field-syntax
	// queries get none -- legacy pass-through). ONE structure per query
	// drives the boolean source search AND the on_target labeling.
	const blocksByQuery: TermGroups[] = queries.map((query, index) =>
		(index === 0 && termGroups.length ? termGroups : sanitizeTermGroups(queryBlocks(query))));

	const aborted = () => {
		if (options.signal?.aborted) throw new Error("search aborted by the user");
	};

	// Picked authors narrow the SOURCE queries themselves (v30.14 user
	// decision): a small run then actually fetches the wanted authors'
	// papers instead of the post-filter dropping a whole author-less head.
	// Only for a pure positive selection -- with the "other authors" row
	// (authorsOther) the filter means "these OR anyone unlisted", which no
	// source query can express; and without any authors the requests stay
	// byte-identical to before. The post-filter keeps running either way:
	// it is the guarantee, the scope is the fetch optimization.
	const scopeAuthors = options.filters?.authors?.length && !options.filters.authorsOther
		? options.filters.authors
		: undefined;

	const records: SourceRecord[] = [];
	const sourcesUsed: string[] = [];
	// A failed source must stay visible AFTER the run (v30.1 field finding:
	// the warn() line is transient status chrome -- an arXiv timeout left no
	// trace in digest, HTML or payload, so the user could not tell a failed
	// source from one that honestly found nothing).
	const sourceFailures: Array<{ source: string; error: string }> = [];
	// Raw per-source×query hit counts BEFORE any processing (2026-08-10,
	// PRISMA-S: "records identified per database" is the first number of
	// the flow diagram and was not recoverable from the sidecar before).
	const sourceCounts: Array<{ source: string; query: string; count: number }> = [];
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
			// Scope per query: the picked authors are run-wide, the concept
			// blocks belong to THIS query (2026-08-06 block search).
			const scope: SourceScope = {
				...(scopeAuthors ? { authors: scopeAuthors } : {}),
				...(blocksByQuery[index].length ? { blocks: blocksByQuery[index] } : {}),
			};
			try {
				const found = await search(query, perSource, scope);
				warn(`${label}: ${found.length} record(s)`);
				sourceCounts.push({ source, query, count: found.length });
				records.push(...(multiQuery ? found.map((r) => ({ ...r, found_by: [query] })) : found));
				succeeded = true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warn(`${label} failed: ${message}`);
				sourceFailures.push({ source: multiQuery ? `${source} (Q${index + 1})` : source, error: message });
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

	// Abstract gate (2026-08-10 user decision): a record still without an
	// abstract AFTER enrichment cannot be judged by the block labeling
	// (title-only matching under-matches systematically) and moves to the
	// dropped table -- visible and selectable there, never silently gone.
	const abstractGate = dropWithoutAbstract(
		scored,
		options.enrich === false
			? "no abstract (sources delivered none; enrichment disabled)"
			: "no abstract (sources and the OpenAlex lookup delivered none)",
	);
	for (const { record, reason } of abstractGate.dropped) {
		warn(`dropped "${record.title}": ${reason}`);
	}
	if (abstractGate.dropped.length) {
		warn(`abstract gate removed ${abstractGate.dropped.length} record(s), kept ${abstractGate.kept.length}`);
	}

	const filters = options.filters ?? {};
	const filterResult = applyFilters(abstractGate.kept, filters);
	for (const { record, reason } of filterResult.dropped) {
		warn(`${reason}: "${record.title}"`);
	}
	if (filterResult.dropped.length) {
		warn(`filters removed ${filterResult.dropped.length} record(s), kept ${filterResult.kept.length}`);
	}

	const sorted = options.sort ? sortRecords(filterResult.kept, options.sort) : filterResult.kept;
	const groupRequire = options.groupRequire !== undefined && blocksByQuery[0].length
		? Math.max(1, Math.min(Math.trunc(options.groupRequire), blocksByQuery[0].length))
		: undefined;
	// Labeling across ALL confirmed queries (2026-08-06, revised same day):
	// on_target = full match of at least one confirmed query's blocks,
	// regardless of which query surfaced the record (found_by stays pure
	// provenance). Single-query runs behave exactly as before.
	const anyBlocks = blocksByQuery.some((blocks) => blocks.length);
	const grouped = groupAcrossQueries(sorted, blocksByQuery, groupRequire);
	if (anyBlocks) {
		const onTarget = grouped.filter((r) => r.group === "on_target").length;
		warn(`grouped: ${onTarget} on_target, ${grouped.length - onTarget} adjacent`);
	} else {
		warn("no grouping rules supplied; results are ungrouped");
	}

	// Code-link stage (2026-08-07; extended to DROPPED records 2026-08-10 --
	// user wish: interesting papers keep landing in the dropped table, their
	// code links matter there too). ONE pass over kept + dropped records;
	// the abstract signal is free for everyone, and the capped GitHub search
	// spends its budget kept-on_target first, then kept, then dropped (input
	// order -- dropped records carry no group and sort behind). Rides the
	// enrich switch like every lookup beyond the search itself.
	aborted();
	const droppedEntries = [...dropped, ...abstractGate.dropped, ...filterResult.dropped];
	let results = grouped;
	let droppedOut = droppedEntries;
	if (options.enrich !== false) {
		const combined = [...grouped, ...droppedEntries.map((entry) => entry.record)] as typeof grouped;
		const withLinks = await addCodeLinks(combined, warn, options.signal);
		// addCodeLinks maps its input 1:1 (same length, same order; pinned
		// in enrich.test). A violation would silently re-pair drop reasons
		// with the wrong records, so it fails loudly here instead.
		if (withLinks.length !== combined.length) {
			throw new Error(`code-link stage returned ${withLinks.length} record(s) for ${combined.length} input(s)`);
		}
		results = withLinks.slice(0, grouped.length) as typeof grouped;
		droppedOut = droppedEntries.map((entry, index) => ({
			reason: entry.reason,
			record: withLinks[grouped.length + index],
		}));
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
		// How deep the run went (v30.13: the digest logs the dialog inputs;
		// the requested depth is one of them).
		per_source: perSource,
		source_failures: sourceFailures.length ? sourceFailures : null,
		// Per-source transparency (v18 arXiv; extended 2026-08-06 for the
		// block search, PRISMA-S habit: document the strategy per database):
		// the expression each source ACTUALLY received, per query. arXiv =
		// boolean all:-syntax incl. the au: author clause (v30.14); OpenAlex
		// = the boolean block search (or the plain text without blocks);
		// CrossRef = the flattened block terms (no boolean support there).
		arxiv_queries: sourcesUsed.includes("arxiv")
			? queries.map((query, index) => buildSearchQuery(query, scopeAuthors, blocksByQuery[index]))
			: null,
		openalex_queries: sourcesUsed.includes("openalex")
			? queries.map((query, index) => buildBlockSearch(blocksByQuery[index]) || query)
			: null,
		crossref_queries: sourcesUsed.includes("crossref")
			? queries.map((query, index) => flattenBlockTerms(blocksByQuery[index]) || query)
			: null,
		// Semantic Scholar = the bulk endpoint's boolean syntax (+/|), see
		// sources/semanticscholar.ts (2026-08-10).
		semanticscholar_queries: sourcesUsed.includes("semanticscholar")
			? queries.map((query, index) => buildBulkQuery(query, blocksByQuery[index]))
			: null,
		grouping: blocksByQuery[0].length ? blocksByQuery[0] : null,
		// Per-query blocks (2026-08-06): what labeled each query's finds --
		// null entries mean that query carried no blocks (quoted/field
		// syntax) and fell back to the primary blocks.
		grouping_by_query: multiQuery
			? queries.map((query, index) => ({
				query,
				groups: blocksByQuery[index].length ? blocksByQuery[index] : null,
			}))
			: null,
		grouping_require: groupRequire !== undefined && groupRequire < blocksByQuery[0].length ? groupRequire : null,
		// PRISMA flow numbers (2026-08-10): every count is a plain length of
		// a list this run actually produced -- identified (raw per-source
		// hits, pre-dedupe), removed as uncitable by the junk filter,
		// duplicates merged, screened (= post-dedupe), excluded by the
		// requested metadata filters (reasons ship in `dropped`), included.
		// Verification/enrichment/grouping never change the count.
		source_counts: sourceCounts.length ? sourceCounts : null,
		flow: {
			identified: records.length,
			junk_removed: dropped.length,
			duplicates_removed: kept.length - deduped.length,
			screened: deduped.length,
			no_abstract_removed: abstractGate.dropped.length,
			excluded_by_filters: filterResult.dropped.length,
			included: results.length,
		},
		filters: filtersActive ? filters : null,
		sort: options.sort ?? null,
		results,
		dropped: droppedOut,
	};
}
