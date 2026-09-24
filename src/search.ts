/**
 * Search engine: runSearch() runs the whole deterministic pipeline
 * (sources incl. the opt-in code-first searchers -> junk filter -> dedupe ->
 * late code pairs to dropped -> verify -> enrich -> abstract gate ->
 * user filters -> sort -> grouping -> code links -> access) and returns the payload
 * that the HTML page, the digest and the JSON sidecar are built from.
 * Shared by the pi tool/command and the CLI. No LLM call anywhere: every
 * record field traces to a search-API response; the only LLM influence
 * (query variants, block proposals) arrives upstream as plain input.
 */

import {
	applyFilters,
	dedupe,
	dropLateCodePairs,
	dropOffTopicCodeRecords,
	dropWithoutAbstract,
	filterRecords,
	groupAcrossQueries,
	type ResultFilters,
	sanitizeTermGroups,
	type SortKey,
	sortRecords,
	type TermGroups,
} from "./pipeline.ts";
import { blockQuery, CODE_SEARCHERS, searchWords } from "./codesearch.ts";
import { codeListTopics, s2ApiKey } from "./config.ts";
import { addAccessStatus, addCodeLinks, addDataLinks, addJournalScores, enrichAll } from "./enrich.ts";
import { queryBlocks } from "./intake.ts";
import { buildSearchQuery, searchArxiv } from "./sources/arxiv.ts";
import { buildCrossrefParams, lookupDataLinksByDoi, searchCrossref } from "./sources/crossref.ts";
import { type AccessInfo, type AccessLevel, buildWorksParams, searchOpenalex } from "./sources/openalex.ts";
import { buildHfQuery } from "./sources/huggingface.ts";
import { buildBulkQuery, searchSemanticScholar } from "./sources/semanticscholar.ts";
import type { DataLink, SourceRecord, SourceScope } from "./types.ts";
import { verifyAll } from "./verify.ts";

type Searcher = (query: string, perSource: number, scope?: SourceScope) => Promise<SourceRecord[]>;

export const SEARCHERS: Record<string, Searcher> = {
	arxiv: searchArxiv,
	crossref: searchCrossref,
	openalex: searchOpenalex,
	// Boolean via the bulk endpoint, citation-sorted. Queried only with an
	// API key (see keyRequirement).
	semanticscholar: searchSemanticScholar,
};

/** Why a source is not queried in this configuration, or null when it is.
 * Semantic Scholar needs an API key: its anonymous pool is saturated
 * nearly all the time, so without one it only produced rate-limit
 * failures. Read per call so a config change applies without a restart. */
export function keyRequirement(source: string): string | null {
	return source === "semanticscholar" && !s2ApiKey()
		? "not queried: optional, needs a free API key (s2ApiKey in config.json, see docs/configuration.md)"
		: null;
}

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
	/** Code-first sources (codesearch.ts: hf-papers, github-readme,
	 * awesome-lists, gee-github): repositories first, their papers resolved
	 * at arXiv/OpenAlex. Off unless named -- costs up to ~40 s per run. Runs
	 * regardless of `enrich` (identification, not enrichment). */
	codeSources?: string[];
	/** GitHub topics for the awesome-lists searcher; default from config
	 * (codeListTopics(): env > config.json > remote-sensing,
	 * satellite-imagery, earth-observation). */
	codeListTopics?: string[];
	/** Concept blocks for the BASE query (term groups, see pipeline.ts):
	 * they label on_target/adjacent AND go out as the boolean source query
	 * (arXiv, OpenAlex, Semantic Scholar; CrossRef gets the flattened
	 * terms). Without them every query derives its own blocks (queryBlocks). */
	groupTerms?: unknown;
	/** Metadata filters (min citations, year range, venues, ...). Optional. */
	filters?: ResultFilters;
	/** Authors picked in the wizard's lookup, as OpenAlex ids (exact; the
	 * names travel in filters.pickedAuthors for the other sources and the
	 * post-filter). */
	authorIds?: string[];
	/** "all": the picked authors' works regardless of the query (OpenAlex
	 * by id citation-sorted, CrossRef/arXiv by name alone; Semantic Scholar
	 * cannot search by author and is skipped, noted as such); default
	 * "query" = author AND query. Only read with picked authors. */
	authorScope?: "query" | "all";
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

/** Records per access level (free, abstract_only, restricted, unknown);
 * records without an access field are not counted. Pure. */
export function countAccess(records: Array<{ access?: AccessInfo }>): Record<AccessLevel, number> {
	const counts: Record<AccessLevel, number> = { free: 0, abstract_only: 0, restricted: 0, unknown: 0 };
	for (const record of records) if (record.access) counts[record.access.level]++;
	return counts;
}

/**
 * Data links for `dois`, taken from the lookup started early in the run
 * (`early`, over `earlyDois`); DOIs that entered the record set only later
 * are looked up now. A failed early lookup is rethrown here, so the link
 * stage degrades it like any other failure. Exported for tests.
 */
export async function collectDataLinks(
	early: Promise<{ links: Map<string, DataLink[]>; error: unknown }> | null,
	earlyDois: string[],
	dois: string[],
	lookup: (dois: string[]) => Promise<Map<string, DataLink[]>> = lookupDataLinksByDoi,
): Promise<Map<string, DataLink[]>> {
	const links = new Map<string, DataLink[]>();
	if (early) {
		const outcome = await early;
		if (outcome.error) throw outcome.error;
		for (const [doi, found] of outcome.links) links.set(doi, found);
	}
	const asked = new Set(earlyDois.map((doi) => doi.toLowerCase()));
	const late = dois.filter((doi) => !asked.has(doi.toLowerCase()));
	if (late.length) {
		for (const [doi, found] of await lookup(late)) links.set(doi, found);
	}
	return links;
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
	const picked = options.filters?.pickedAuthors?.filter(Boolean) ?? [];
	const scopeAuthors = picked.length ? picked
		: options.filters?.authors?.length && !options.filters.authorsOther
			? options.filters.authors
			: undefined;
	const authorScope: "query" | "all" = picked.length && options.authorScope === "all" ? "all" : "query";
	const authorIds = picked.length ? options.authorIds?.filter(Boolean) : undefined;

	const records: SourceRecord[] = [];
	const sourcesUsed: string[] = [];
	// A failed source stays visible in the payload: the warn() line is
	// transient status chrome, and the reader must be able to tell a failed
	// source from one that honestly found nothing.
	const sourceFailures: Array<{ source: string; error: string }> = [];
	// Sources deliberately not queried (a missing optional key): a neutral
	// note, never a failure.
	const sourcesSkipped: Array<{ source: string; reason: string }> = [];
	// Raw per-source x query hit counts BEFORE any processing -- PRISMA-S
	// "records identified per database", the first number of the flow.
	// `candidates` only for code-first sources: repository->identifier pairs
	// gathered before resolution ("12 candidates, 4 resolved").
	const sourceCounts: Array<{ source: string; query: string; count: number; candidates?: number }> = [];
	const codeSources = options.codeSources ?? [];
	const codeSourcesUsed: string[] = [];
	// Curated lists the awesome-lists source actually read (run-wide; the
	// report names them next to the topics).
	const listsRead: string[] = [];
	// Scope per query: the picked authors are run-wide, the concept blocks
	// belong to THIS query.
	const scopeFor = (index: number): SourceScope => ({
		...(scopeAuthors ? { authors: scopeAuthors } : {}),
		...(authorIds?.length ? { authorIds } : {}),
		...(authorScope === "all" ? { authorScope } : {}),
		...(blocksByQuery[index].length ? { blocks: blocksByQuery[index] } : {}),
	});
	// One source x every query; shared by the database and the code-first
	// sources. Sources run CONCURRENTLY (different servers; a server shared
	// by two sources is serialized by its paced client), the queries of one
	// source stay sequential. Everything a source produces is buffered and
	// merged below in the fixed source order, so records, counts, failures
	// and found_by come out exactly as with a sequential run.
	type SourceRun = {
		records: SourceRecord[];
		counts: typeof sourceCounts;
		failures: typeof sourceFailures;
		lists: string[];
		succeeded: boolean;
	};
	const runSource = async (
		source: string,
		run: (query: string, scope: SourceScope) => Promise<{ records: SourceRecord[]; candidates?: number; failures?: Array<{ step: string; error: string }>; listsRead?: string[] }>,
	): Promise<SourceRun> => {
		const out: SourceRun = { records: [], counts: [], failures: [], lists: [], succeeded: false };
		for (const [index, query] of queries.entries()) {
			aborted();
			const qLabel = multiQuery ? ` (Q${index + 1})` : "";
			const label = `source '${source}'${qLabel}`;
			try {
				const found = await run(query, scopeFor(index));
				const candidates = found.candidates !== undefined ? `, ${found.candidates} candidate(s)` : "";
				warn(`${label}: ${found.records.length} record(s)${candidates}`);
				out.counts.push({
					source, query, count: found.records.length,
					...(found.candidates !== undefined ? { candidates: found.candidates } : {}),
				});
				out.records.push(...(multiQuery ? found.records.map((r) => ({ ...r, found_by: [query] })) : found.records));
				out.lists.push(...(found.listsRead ?? []));
				// Partial failures (e.g. candidates found, arXiv resolution
				// rate-limited) are real failures of this run -- same list,
				// step-labelled, so the page and the digest show them.
				for (const failure of found.failures ?? []) {
					warn(`${label}: ${failure.step} failed: ${failure.error}`);
					out.failures.push({ source: `${source} (${failure.step}${qLabel ? `, Q${index + 1}` : ""})`, error: failure.error });
				}
				out.succeeded = true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warn(`${label} failed: ${message}`);
				out.failures.push({ source: `${source}${qLabel}`, error: message });
			}
		}
		return out;
	};
	type Job = { source: string; kind: "database" | "code"; run: Promise<SourceRun> | null; skip?: string };
	const jobs: Job[] = [];
	for (const source of sources) {
		const search = SEARCHERS[source];
		if (!search) {
			warn(`unknown source '${source}'; skipping (available: ${Object.keys(SEARCHERS).join(", ")})`);
			continue;
		}
		// "All publications of the picked authors": Semantic Scholar's bulk
		// search has no author field, so it cannot serve that scope -- said
		// in the payload instead of returning the query's unrelated head.
		const needsKey = keyRequirement(source);
		if (needsKey) {
			warn(`source '${source}': ${needsKey}`);
			sourcesSkipped.push({ source, reason: needsKey });
			continue;
		}
		if (authorScope === "all" && source === "semanticscholar") {
			const note = "not queried: the bulk search has no author field (author scope: all publications)";
			warn(`source '${source}': ${note}`);
			jobs.push({ source, kind: "database", run: null, skip: note });
			continue;
		}
		jobs.push({ source, kind: "database", run: runSource(source, async (query, scope) => ({ records: await search(query, perSource, scope) })) });
	}
	// Code-first sources: repositories first, papers resolved from what they
	// cite. Identification, not enrichment -- they run even with enrich:false.
	const listTopics = options.codeListTopics ?? codeListTopics();
	const codeContext = { signal: options.signal, warn, listTopics };
	for (const source of codeSources) {
		const search = CODE_SEARCHERS[source];
		if (!search) {
			warn(`unknown code source '${source}'; skipping (available: ${Object.keys(CODE_SEARCHERS).join(", ")})`);
			continue;
		}
		jobs.push({ source, kind: "code", run: runSource(source, (query, scope) => search(query, perSource, scope, codeContext)) });
	}
	// allSettled: every started source finishes (or hits the abort check)
	// before the run goes on; an abort then surfaces as the thrown error.
	const settled = await Promise.allSettled(jobs.map((job) => job.run ?? Promise.resolve(null)));
	for (const [index, job] of jobs.entries()) {
		const outcome = settled[index];
		if (outcome.status === "rejected") throw outcome.reason;
		if (job.skip) {
			sourceFailures.push({ source: job.source, error: job.skip });
			continue;
		}
		const result = outcome.value as SourceRun;
		records.push(...result.records);
		sourceCounts.push(...result.counts);
		sourceFailures.push(...result.failures);
		for (const list of result.lists) {
			if (!listsRead.includes(list)) listsRead.push(list);
		}
		if (result.succeeded) (job.kind === "database" ? sourcesUsed : codeSourcesUsed).push(job.source);
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
	// The data-link lookup needs only DOIs, and they are known from here on:
	// it starts now and runs alongside verification and enrichment (CrossRef
	// takes 1-3 s per batch); the link stage collects it. The outcome is
	// captured, never left as a floating rejection.
	const earlyDataDois = options.enrich === false
		? []
		: [...deduped, ...dropped.map((entry) => entry.record)].map((record) => record.doi).filter(Boolean);
	const earlyDataLinks = earlyDataDois.length
		? lookupDataLinksByDoi(earlyDataDois).then(
			(links) => ({ links, error: null as unknown }),
			(error: unknown) => ({ links: new Map<string, DataLink[]>(), error }),
		)
		: null;
	// Code pairs that failed the date gate: records only a code source
	// delivered move to the dropped table (listed, selectable, reason named);
	// records a database also delivered lose the late link instead.
	const lateGate = dropLateCodePairs(deduped, (source) => source in CODE_SEARCHERS);
	for (const { record, reason } of lateGate.dropped) {
		warn(`dropped "${record.title}": ${reason}`);
	}
	for (const record of lateGate.stripped) {
		warn(`"${record.title}": late code repository link removed (the paper also came from ${record.sources.filter((s) => !(s in CODE_SEARCHERS)).join(", ")})`);
	}
	aborted();
	const verified = await verifyAll(lateGate.kept, warn, options.signal);
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
			: !s2ApiKey()
				? "no abstract (sources and the OpenAlex lookup delivered none)"
			: s2Failures.has(record.doi)
				? "no abstract (sources and the OpenAlex lookup delivered none; the Semantic Scholar lookup failed -- the abstract may exist)"
				: "no abstract (sources, the OpenAlex and the Semantic Scholar lookup delivered none)");
	for (const { record, reason } of abstractGate.dropped) {
		warn(`dropped "${record.title}": ${reason}`);
	}
	if (abstractGate.dropped.length) {
		warn(`abstract gate removed ${abstractGate.dropped.length} record(s), kept ${abstractGate.kept.length}`);
	}

	// Topic gate for code-first finds: a paper only a code source
	// delivered must itself fit the query blocks (the repository matched,
	// not necessarily the paper). Runs after the abstract gate, so it
	// judges the final abstracts.
	const topicGate = dropOffTopicCodeRecords(abstractGate.kept, blocksByQuery, (source) => source in CODE_SEARCHERS);
	for (const { record, reason } of topicGate.dropped) {
		warn(`dropped "${record.title}": ${reason}`);
	}

	const filters = options.filters ?? {};
	const filterResult = applyFilters(topicGate.kept, filters);
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

	// Link stages: ONE pass over kept + dropped records (interesting papers
	// land in the dropped table too). Ride the enrich switch like every
	// lookup beyond the search itself.
	aborted();
	const droppedEntries = [...dropped, ...lateGate.dropped, ...abstractGate.dropped, ...topicGate.dropped, ...filterResult.dropped];
	let results: Array<(typeof grouped)[number] & { access?: AccessInfo }> = grouped;
	let droppedOut = droppedEntries;
	if (options.enrich !== false) {
		const combined = [...grouped, ...droppedEntries.map((entry) => entry.record)] as typeof grouped;
		// Code links named in the abstracts (no request), then the data and
		// code archives the publishers deposited at CrossRef (one batched
		// request per 40 DOIs) -- both on every search, for kept AND dropped
		// rows.
		const linked = addCodeLinks(combined, warn);
		aborted();
		const withData = await addDataLinks(linked, warn, (dois) => collectDataLinks(earlyDataLinks, earlyDataDois, dois));
		// Access stage over the same list: dropped rows are tickable too, so
		// they need the open-access level and the open PDF locations as well.
		aborted();
		const withLinks = await addAccessStatus(withData, warn);
		// All three stages map their input 1:1 (same length, same order). A
		// violation would silently re-pair drop reasons with the wrong
		// records, so it fails loudly here instead.
		if (linked.length !== combined.length || withData.length !== combined.length || withLinks.length !== combined.length) {
			throw new Error(`code-link/data-link/access stage returned ${withLinks.length} record(s) for ${combined.length} input(s)`);
		}
		results = withLinks.slice(0, grouped.length) as typeof results;
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
		sources_skipped: sourcesSkipped.length ? sourcesSkipped : null,
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
			? queries.map((query, index) => {
				const params = buildWorksParams(query, perSource, scopeFor(index));
				const search = params.get("search");
				const filter = params.get("filter");
				return `${search !== null ? search : `(no text search; sort=${params.get("sort")})`}${filter ? ` [filter: ${filter}]` : ""}`;
			})
			: null,
		crossref_queries: sourcesUsed.includes("crossref")
			? queries.map((query, index) => {
				const params = buildCrossrefParams(query, perSource, scopeFor(index));
				const text = params.get("query");
				const author = params.get("query.author");
				const filter = params.get("filter");
				return `${text !== null ? text : "(no text query; author field only)"}${author ? ` [query.author: ${author}]` : ""}${filter ? ` [filter: ${filter}]` : ""}`;
			})
			: null,
		semanticscholar_queries: sourcesUsed.includes("semanticscholar")
			? queries.map((query, index) => buildBulkQuery(query, blocksByQuery[index]))
			: null,
		// Code-first sources of this run and what each received (PRISMA
		// "other methods": the reader sees which repository search ran).
		code_sources_used: codeSourcesUsed.length ? codeSourcesUsed : null,
		code_queries: codeSourcesUsed.length
			? Object.fromEntries(codeSourcesUsed.map((source) => [source, queries.map((query, index) => {
				const words = searchWords(query, blocksByQuery[index]);
				switch (source) {
					case "hf-papers": return buildHfQuery(query, blocksByQuery[index]);
					case "github-readme": return `${words} "arxiv.org" in:readme`;
					case "gee-github": return `${blockQuery(query, blocksByQuery[index])} "code.earthengine.google.com" in:readme "doi.org" in:readme`;
					case "awesome-lists": return `lists tagged ${listTopics.length ? listTopics.join(", ") : "(no topics)"}; lists read: ${listsRead.length ? listsRead.join(", ") : "none"}; entries matched against the blocks ${blocksByQuery[index].length ? blocksByQuery[index].map((b) => `(${b.join(" OR ")})`).join(" AND ") : "(none -- skipped)"}`;
					default: return words;
				}
			})]))
			: null,
		// Author lookup scope (null: no picked author): who was picked, in
		// which position, and whether the query still applied.
		author_scope: picked.length
			? {
				names: picked,
				ids: authorIds ?? [],
				position: options.filters?.authorPosition ?? "any",
				scope: authorScope,
			}
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
		// filters (reasons ship in `dropped`), included; with code sources
		// also the late code pairs and the off-topic code-only finds. Verification,
		// enrichment and grouping never change the count.
		source_counts: sourceCounts.length ? sourceCounts : null,
		flow: {
			identified: records.length,
			junk_removed: dropped.length,
			duplicates_removed: kept.length - deduped.length,
			screened: deduped.length,
			// Optional: only present when a code-first source ran.
			...(codeSourcesUsed.length ? { late_code_pairs_removed: lateGate.dropped.length } : {}),
			no_abstract_removed: abstractGate.dropped.length,
			...(codeSourcesUsed.length ? { off_topic_code_removed: topicGate.dropped.length } : {}),
			excluded_by_filters: filterResult.dropped.length,
			included: results.length,
		},
		// Access levels of the results table (OpenAlex open-access status;
		// null when enrichment is off).
		access_counts: options.enrich === false ? null : countAccess(results),
		filters: filtersActive ? filters : null,
		sort: options.sort ?? null,
		results,
		dropped: droppedOut,
	};
}
