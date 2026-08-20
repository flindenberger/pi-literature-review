/**
 * Search engine: runSearch() runs the whole deterministic pipeline
 * (sources -> junk filter -> dedupe -> verify -> enrich -> abstract gate ->
 * user filters -> sort -> grouping -> code links) and returns the payload
 * that the HTML page, the digest and the JSON sidecar are built from.
 * Shared by the pi tool/command and the CLI. No LLM call anywhere: every
 * record field traces to a search-API response; the only LLM influence
 * (query variants, block proposals) arrives upstream as plain input.
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
	// Boolean via the bulk endpoint, citation-sorted; may fail loudly on
	// the anonymous rate limit (see the module header).
	semanticscholar: searchSemanticScholar,
};

export const DEFAULT_PER_SOURCE = 5;
/** Politeness cap towards the free APIs. */
export const MAX_PER_SOURCE = 50;

export interface SearchOptions {
	query: string;
	/** Additional phrasings of the same question, searched in the same run;
	 * results are deduplicated ACROSS variants and each record notes which
	 * variants found it (found_by). Variants may come from an LLM -- that is
	 * query shaping, never citation data. */
	queryVariants?: string[];
	perSource?: number;
	sources?: string[];
	/** Concept blocks for the BASE query (term groups, see pipeline.ts):
	 * they label on_target/adjacent AND go out as the boolean source query
	 * (arXiv, OpenAlex, Semantic Scholar; CrossRef gets the flattened
	 * terms). Without them every query derives its own blocks (queryBlocks). */
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

/** What runSearch returns: the HTML page, the digest and the JSON sidecar
 * are built from this. */
export type SearchPayload = Awaited<ReturnType<typeof runSearch>>;

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

	// Concept blocks per query: passed group_terms override the BASE
	// query's blocks; every other query derives its own (an expression like
	// "(river OR stream) AND (mask)" parses, plain keywords become one block
	// per content word; quoted/field-syntax queries get none and pass
	// through unchanged). ONE structure per query drives both the boolean
	// source search AND the on_target labeling.
	const blocksByQuery: TermGroups[] = queries.map((query, index) =>
		(index === 0 && termGroups.length ? termGroups : sanitizeTermGroups(queryBlocks(query))));

	const aborted = () => {
		if (options.signal?.aborted) throw new Error("search aborted by the user");
	};

	// Picked authors narrow the SOURCE queries themselves, so a small run
	// actually fetches the wanted authors' papers instead of the post-filter
	// dropping an author-less head. Only for a pure positive selection --
	// with the "other authors" row (authorsOther) the filter means "these OR
	// anyone unlisted", which no source query can express. The post-filter
	// keeps running either way: it is the guarantee, the scope is the fetch
	// optimization.
	const scopeAuthors = options.filters?.authors?.length && !options.filters.authorsOther
		? options.filters.authors
		: undefined;

	const records: SourceRecord[] = [];
	const sourcesUsed: string[] = [];
	// A failed source stays visible in the payload: the warn() line is
	// transient status chrome, and the reader must be able to tell a failed
	// source from one that honestly found nothing.
	const sourceFailures: Array<{ source: string; error: string }> = [];
	// Raw per-source x query hit counts BEFORE any processing -- PRISMA-S
	// "records identified per database", the first number of the flow.
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
			// blocks belong to THIS query.
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
	const enrichment = options.enrich === false ? null : await enrichAll(verified, warn);
	const enriched = enrichment ? enrichment.records : verified;
	// Failed Semantic Scholar abstract lookups, by DOI: they word the drop
	// reason honestly ("failed", not "delivered none") and land in the
	// payload -- a transient warn() alone would make the failure
	// undiagnosable from the sidecar afterwards.
	const s2Failures = enrichment?.s2AbstractFailures ?? new Map<string, string>();
	aborted();
	const scored = options.enrich === false ? enriched : await addJournalScores(enriched, warn);

	// Abstract gate: a record still without an abstract AFTER enrichment
	// cannot be judged by the block labeling (title-only matching
	// under-matches systematically) and moves to the dropped table --
	// visible and selectable there, never silently gone.
	const abstractGate = dropWithoutAbstract(scored, (record) =>
		options.enrich === false
			? "no abstract (sources delivered none; enrichment disabled)"
			: s2Failures.has(record.doi)
				? "no abstract (sources and the OpenAlex lookup delivered none; the Semantic Scholar lookup failed -- the abstract may exist)"
				: "no abstract (sources, the OpenAlex and the Semantic Scholar lookup delivered none)");
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
	// Labeling across ALL confirmed queries: on_target = full match of at
	// least one query's blocks, regardless of which query surfaced the
	// record (found_by stays pure provenance).
	const anyBlocks = blocksByQuery.some((blocks) => blocks.length);
	const grouped = groupAcrossQueries(sorted, blocksByQuery);
	if (anyBlocks) {
		const onTarget = grouped.filter((r) => r.group === "on_target").length;
		warn(`grouped: ${onTarget} on_target, ${grouped.length - onTarget} adjacent`);
	} else {
		warn("no grouping rules supplied; results are ungrouped");
	}

	// Code-link stage: ONE pass over kept + dropped records (interesting
	// papers land in the dropped table too). The abstract signal is free for
	// everyone; the capped GitHub search spends its budget kept-on_target
	// first, then kept, then dropped (input order -- dropped records carry
	// no group and sort behind). Rides the enrich switch like every lookup
	// beyond the search itself.
	aborted();
	const droppedEntries = [...dropped, ...abstractGate.dropped, ...filterResult.dropped];
	let results = grouped;
	let droppedOut = droppedEntries;
	if (options.enrich !== false) {
		const combined = [...grouped, ...droppedEntries.map((entry) => entry.record)] as typeof grouped;
		const withLinks = await addCodeLinks(combined, warn, options.signal);
		// addCodeLinks maps its input 1:1 (same length, same order). A
		// violation would silently re-pair drop reasons with the wrong
		// records, so it fails loudly here instead.
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
		// Requested depth, logged by digest and HTML meta.
		per_source: perSource,
		source_failures: sourceFailures.length ? sourceFailures : null,
		// Failed abstract lookups are a fact about this run, like a failed
		// source: without this field a rate-limited Semantic Scholar pool is
		// invisible in the sidecar and its drops read as "the source has no
		// abstract". One entry per provider (only S2 looks up abstracts today).
		abstract_lookup_failures: s2Failures.size
			? [{
				source: "semanticscholar",
				error: s2Failures.values().next().value ?? "",
				records: s2Failures.size,
			}]
			: null,
		// Per-source transparency (PRISMA-S: document the strategy per
		// database): the expression each source ACTUALLY received, per
		// query. arXiv = boolean all:-syntax incl. the au: author clause;
		// OpenAlex = the boolean block search (or the plain text without
		// blocks); CrossRef = the flattened block terms (no boolean there);
		// Semantic Scholar = the bulk endpoint's +/| syntax.
		arxiv_queries: sourcesUsed.includes("arxiv")
			? queries.map((query, index) => buildSearchQuery(query, scopeAuthors, blocksByQuery[index]))
			: null,
		openalex_queries: sourcesUsed.includes("openalex")
			? queries.map((query, index) => buildBlockSearch(blocksByQuery[index]) || query)
			: null,
		crossref_queries: sourcesUsed.includes("crossref")
			? queries.map((query, index) => flattenBlockTerms(blocksByQuery[index]) || query)
			: null,
		semanticscholar_queries: sourcesUsed.includes("semanticscholar")
			? queries.map((query, index) => buildBulkQuery(query, blocksByQuery[index]))
			: null,
		grouping: blocksByQuery[0].length ? blocksByQuery[0] : null,
		// Per-query blocks; null = that query carried no blocks (quoted/field
		// syntax) and passed through unchanged.
		grouping_by_query: multiQuery
			? queries.map((query, index) => ({
				query,
				groups: blocksByQuery[index].length ? blocksByQuery[index] : null,
			}))
			: null,
		// PRISMA flow numbers: every count is the plain length of a list this
		// run produced -- identified (raw per-source hits, pre-dedupe),
		// removed as uncitable by the junk filter, duplicates merged, screened
		// (= post-dedupe), removed without abstract, excluded by the requested
		// filters (reasons ship in `dropped`), included. Verification,
		// enrichment and grouping never change the count.
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
