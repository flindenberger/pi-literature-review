/**
 * Deterministic processing steps over source records, used by the search
 * engine (src/search.ts): junk filter, dedupe, user filters, abstract gate,
 * sorting and the on_target/adjacent labeling. Pure functions only -- no
 * network, no LLM; every drop ships with its reason.
 */

import type { SourceRecord } from "./types.ts";

/** After dedupe, the per-hit `source` folds into a `sources` list. */
export interface MergedRecord extends Omit<SourceRecord, "source"> {
	sources: string[];
}

export interface FilterResult {
	kept: SourceRecord[];
	dropped: Array<{ record: SourceRecord; reason: string }>;
}

/**
 * Drop records that cannot be cited: no title or no authors. These two
 * empty-field rules remove the known API junk (empty-title "component"
 * records, stray keyword matches without authors) without touching real
 * papers.
 */
export function filterRecords(records: SourceRecord[]): FilterResult {
	const kept: SourceRecord[] = [];
	const dropped: FilterResult["dropped"] = [];
	for (const record of records) {
		if (!record.title) {
			dropped.push({ record, reason: "empty title" });
		} else if (!record.authors.length) {
			dropped.push({ record, reason: "empty author list" });
		} else {
			kept.push(record);
		}
	}
	return { kept, dropped };
}

/**
 * What makes two records the same paper: DOI first, else arXiv ID.
 * Version suffixes name revisions of the same paper, not different papers,
 * and are ignored for identity: OSF-style "..._v1" DOI variants and arXiv
 * "...v2" IDs (seen live: 10.31227/osf.io/pz6jv vs .../pz6jv_v1 returned as
 * two records). Only the key is normalized; record fields stay untouched.
 * Exported: the selection stage keys its lit-selection/ library the same
 * way, so one paper is never stored twice.
 */
export function identityKey(record: Pick<MergedRecord, "doi" | "arxiv_id">): string | null {
	if (record.doi) return `doi:${record.doi.toLowerCase().replace(/_v\d+$/, "")}`;
	if (record.arxiv_id) return `arxiv:${record.arxiv_id.toLowerCase().replace(/v\d+$/, "")}`;
	return null;
}

function isEmpty(value: unknown): boolean {
	return value === "" || value === null || value === undefined
		|| (Array.isArray(value) && value.length === 0);
}

function filledFieldCount(record: MergedRecord): number {
	return Object.values(record).filter((value) => !isEmpty(value)).length;
}

/** Copy of `base` whose empty fields are filled from `other` (same shape);
 * values are only copied, never rewritten. */
function fillGaps<T extends object>(base: T, other: T): T {
	const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(other)) {
		if (isEmpty(merged[key]) && !isEmpty(value)) merged[key] = value;
	}
	return merged as T;
}

/**
 * Merge two records for the same paper: start from the richer one and fill
 * its gaps from the other; citations take the higher count, sources and
 * found_by are unioned.
 */
function mergePair(a: MergedRecord, b: MergedRecord): MergedRecord {
	const [base, other] = filledFieldCount(a) >= filledFieldCount(b) ? [a, b] : [b, a];
	const merged = fillGaps(base, other);
	const counts = [a.cites, b.cites].filter((c): c is number => Number.isInteger(c));
	merged.cites = counts.length ? Math.max(...counts) : null;
	merged.sources = [...a.sources, ...b.sources.filter((s) => !a.sources.includes(s))];
	const foundByA = a.found_by ?? [];
	const foundBy = [...foundByA, ...(b.found_by ?? []).filter((q) => !foundByA.includes(q))];
	if (foundBy.length) merged.found_by = foundBy;
	return merged;
}

/**
 * Collapse multi-source hits into one record per paper.
 *
 * Keyed by DOI (case-insensitive), else arXiv ID; records without any
 * identifier stay as they are. Every record gains a `sources` list; the
 * per-hit `source` field is folded into it. Pure, no network.
 */
export function dedupe(records: SourceRecord[]): MergedRecord[] {
	const mergedByKey = new Map<string, MergedRecord>();
	const order: string[] = [];
	const unidentified: MergedRecord[] = [];
	for (const sourceRecord of records) {
		const { source, ...rest } = sourceRecord;
		const record: MergedRecord = { ...rest, sources: [source] };
		const key = identityKey(record);
		if (key === null) {
			unidentified.push(record);
		} else if (mergedByKey.has(key)) {
			mergedByKey.set(key, mergePair(mergedByKey.get(key)!, record));
		} else {
			mergedByKey.set(key, record);
			order.push(key);
		}
	}
	return [...order.map((key) => mergedByKey.get(key)!), ...unidentified];
}

/**
 * User-requested result filters. All of them act on metadata the APIs
 * delivered (citation counts, years, venue names, links, verification
 * status) -- pure deterministic checks, nothing invented. What a filter
 * removes is returned with a reason, never silently discarded.
 */
export interface ResultFilters {
	/** Keep records with at least this many citations. Records with an
	 * UNKNOWN count (cites: null, e.g. arXiv) pass -- visible as null. */
	minCites?: number;
	/** Keep records whose journal 2-yr citedness (OpenAlex, an open JIF
	 * analog attached by enrichment) is at least this. Records WITHOUT a
	 * score (preprints, unmatched venues) pass -- absence of the score is
	 * not evidence against the paper; filters are strictly opt-in and never
	 * silently lose the unknown. */
	minJournalScore?: number;
	/** Keep records published in [yearFrom, yearTo]. A record with unknown
	 * year cannot prove it is in range and is dropped, with a reason. */
	yearFrom?: number;
	yearTo?: number;
	/** Keep records whose venue contains one of these strings
	 * (case-insensitive). Venue-less records (e.g. arXiv preprints) do not
	 * match a venue request and are dropped, with a reason -- UNLESS
	 * venuesOther is set (see below). */
	venues?: string[];
	/** Also keep records that belong to NO journal on the picker's list --
	 * the "Other journals/sources" row. Venue-less records (arXiv,
	 * preprints) count as "other" and pass. Without venuesListed the row
	 * cannot know what "other" excludes, so nothing is filtered at all. */
	venuesOther?: boolean;
	/** The journal names the picker LISTED (its top-N facet head). Only
	 * read together with venuesOther: a record whose venue matches none of
	 * these is "other". */
	venuesListed?: string[];
	/** Keep records where at least one AUTHOR NAME contains one of these
	 * strings (case-insensitive). Author names are API metadata;
	 * records without any matching author are dropped, with a reason --
	 * UNLESS authorsOther is set (see below). */
	authors?: string[];
	/** Also keep records by authors who are NOT on the picker's list -- the
	 * "Other authors" row. Same shape as venuesOther. */
	authorsOther?: boolean;
	/** The author names the picker LISTED (its top-N facet head). */
	authorsListed?: string[];
	/** Keep only records with a direct PDF link. */
	requirePdf?: boolean;
	/** Keep only records whose identifier resolved (verified: true). */
	verifiedOnly?: boolean;
}

interface FilterableRecord {
	cites: number | null;
	year: string | null;
	venue: string;
	authors: string[];
	pdf_url: string;
	verified: boolean;
	journal_2yr_citedness?: number;
}

/** Reason a record fails the filters, or null if it passes. Fixed strings. */
function filterReason(record: FilterableRecord, filters: ResultFilters): string | null {
	if (filters.minCites !== undefined && record.cites !== null && record.cites < filters.minCites) {
		return `filtered: ${record.cites} citation(s) < requested minimum ${filters.minCites}`;
	}
	if (
		filters.minJournalScore !== undefined
		&& typeof record.journal_2yr_citedness === "number"
		&& record.journal_2yr_citedness < filters.minJournalScore
	) {
		return `filtered: journal score ${record.journal_2yr_citedness} < requested minimum ${filters.minJournalScore}`;
	}
	const year = record.year !== null && /^\d{4}$/.test(record.year) ? Number(record.year) : null;
	if ((filters.yearFrom !== undefined || filters.yearTo !== undefined) && year === null) {
		return "filtered: publication year unknown, cannot prove it is in the requested range";
	}
	if (filters.yearFrom !== undefined && year !== null && year < filters.yearFrom) {
		return `filtered: published ${year}, before requested ${filters.yearFrom}`;
	}
	if (filters.yearTo !== undefined && year !== null && year > filters.yearTo) {
		return `filtered: published ${year}, after requested ${filters.yearTo}`;
	}
	const wantedVenues = (filters.venues ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
	const listedVenues = (filters.venuesListed ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
	// "Other journals/sources" without a list of what IS listed excludes
	// nothing -- the venue filter is then off, honestly.
	const otherWanted = !!filters.venuesOther && listedVenues.length > 0;
	if (wantedVenues.length || otherWanted) {
		const venue = record.venue.trim().toLowerCase();
		const matchesWanted = !!venue && wantedVenues.some((wanted) => venue.includes(wanted));
		// A record whose venue is on the picker's list but was not selected
		// is not "other"; a venue-less record (preprint) always is.
		const isListed = !!venue && listedVenues.some((listed) => venue.includes(listed));
		if (!matchesWanted && !(otherWanted && !isListed)) {
			if (!record.venue) {
				return "filtered: no venue in the metadata (e.g. preprint), cannot match requested venues";
			}
			return otherWanted
				? `filtered: venue "${record.venue}" is a listed journal that was not selected`
				: `filtered: venue "${record.venue}" matches none of the requested venues`;
		}
	}
	const wantedAuthors = (filters.authors ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
	const listedAuthors = (filters.authorsListed ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
	// Same rule as the journals above: "other authors" without a list of
	// who IS listed excludes nobody.
	const otherAuthorsWanted = !!filters.authorsOther && listedAuthors.length > 0;
	if (wantedAuthors.length || otherAuthorsWanted) {
		const names = record.authors.map((author) => author.toLowerCase());
		const matchesWanted = names.some((author) => wantedAuthors.some((name) => author.includes(name)));
		// "Other" means: none of this record's authors is on the listed head.
		const hasListed = names.some((author) => listedAuthors.some((name) => author.includes(name)));
		if (!matchesWanted && !(otherAuthorsWanted && !hasListed)) {
			return otherAuthorsWanted
				? "filtered: only listed authors that were not selected"
				: `filtered: no author matches ${(filters.authors ?? []).join(", ")}`;
		}
	}
	if (filters.requirePdf && !record.pdf_url) {
		return "filtered: no direct PDF link";
	}
	if (filters.verifiedOnly && !record.verified) {
		return "filtered: identifier did not verify";
	}
	return null;
}

/**
 * Records still without an abstract AFTER enrichment move to the dropped
 * list: the block labeling matches title+abstract, so an abstract-less
 * record cannot be judged fairly -- and since the dropped table carries
 * the full columns and checkboxes, nothing is lost, only set aside. The
 * reason is the caller's (it differs with enrichment on/off); a function
 * words it per record (e.g. "lookup failed" vs "delivered none"). Pure.
 */
export function dropWithoutAbstract<T extends { abstract: string }>(
	records: T[],
	reason: string | ((record: T) => string),
): { kept: T[]; dropped: Array<{ record: T; reason: string }> } {
	const kept: T[] = [];
	const dropped: Array<{ record: T; reason: string }> = [];
	for (const record of records) {
		if (record.abstract.trim()) kept.push(record);
		else dropped.push({ record, reason: typeof reason === "string" ? reason : reason(record) });
	}
	return { kept, dropped };
}

/** Apply user filters; returns kept records and dropped ones with reasons. */
export function applyFilters<T extends FilterableRecord>(
	records: T[],
	filters: ResultFilters,
): { kept: T[]; dropped: Array<{ record: T; reason: string }> } {
	const kept: T[] = [];
	const dropped: Array<{ record: T; reason: string }> = [];
	for (const record of records) {
		const reason = filterReason(record, filters);
		if (reason === null) kept.push(record);
		else dropped.push({ record, reason });
	}
	return { kept, dropped };
}

export type SortKey = "cites" | "year";

/** Sort descending by citations or year; unknown values go last. Stable. */
export function sortRecords<T extends { cites: number | null; year: string | null }>(
	records: T[],
	sort: SortKey,
): T[] {
	const value = (record: T): number => {
		if (sort === "cites") return record.cites ?? Number.NEGATIVE_INFINITY;
		return record.year !== null && /^\d{4}$/.test(record.year)
			? Number(record.year)
			: Number.NEGATIVE_INFINITY;
	};
	return [...records].sort((a, b) => value(b) - value(a));
}

/**
 * Grouping rules: a list of term groups. A record is on_target when at
 * least one term from EVERY group appears in its title+abstract
 * (case-insensitive substring match). The rules are data, supplied per
 * query -- e.g. [["river","fluvial"],["sandbar","bar"],["sentinel"]]. The
 * CHECK is fixed deterministic code; an LLM may propose the word lists, it
 * never touches the records.
 */
export type TermGroups = string[][];

/** Drop empty terms/groups so a stray empty string cannot skew the rule. */
export function sanitizeTermGroups(termGroups: unknown): TermGroups {
	if (!Array.isArray(termGroups)) return [];
	return termGroups
		.map((groupTerms) =>
			Array.isArray(groupTerms)
				? groupTerms
					.filter((term): term is string => typeof term === "string")
					.map((term) => term.trim().toLowerCase())
					.filter(Boolean)
				: [],
		)
		.filter((groupTerms) => groupTerms.length > 0);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Code-first pairs that failed the date gate (repository created more than
 * a year after the paper -- measured: almost always a project citing the
 * paper, not its code). Runs AFTER dedupe. A record that ONLY code sources
 * delivered moves to the dropped list with the gate note as its reason --
 * still listed, still selectable (cited methods are sometimes exactly what
 * the reader wants). A record that a database ALSO delivered stays in the
 * results, but the late link is removed from it (a wrong repository must
 * not ride on a correct paper). A "late" flag whose note names a different
 * repository than the record now carries came in through the merge of a
 * passing pair with a late one: the flag is cleared, the link kept. Pure.
 */
export function dropLateCodePairs(
	records: MergedRecord[],
	isCodeSource: (source: string) => boolean,
): { kept: MergedRecord[]; dropped: Array<{ record: MergedRecord; reason: string }>; stripped: MergedRecord[] } {
	const kept: MergedRecord[] = [];
	const dropped: Array<{ record: MergedRecord; reason: string }> = [];
	const stripped: MergedRecord[] = [];
	for (const record of records) {
		if (record.code_gate !== "late") {
			kept.push(record);
			continue;
		}
		const lateUrl = /code repository (\S+),/.exec(record.code_gate_note ?? "")?.[1];
		const { code_gate: _gate, code_gate_note: note, ...rest } = record;
		if (lateUrl && record.code_url && record.code_url !== lateUrl) {
			kept.push(rest);
			continue;
		}
		if (record.sources.every(isCodeSource)) {
			dropped.push({ record, reason: note ?? "code repository created long after the paper" });
			continue;
		}
		const { code_url: _url, resolved_via: _via, ...clean } = rest;
		const enriched = { ...(clean.enriched ?? {}) };
		delete enriched.code_url;
		const cleaned: MergedRecord = Object.keys(enriched).length ? { ...clean, enriched } : (({ enriched: _e, ...noEnriched }) => noEnriched)(clean);
		kept.push(cleaned);
		stripped.push(cleaned);
	}
	return { kept, dropped, stripped };
}

/**
 * Whole-word term matching. A term only matches a whole word: no word
 * character may touch it on either side (explicit lookarounds instead of
 * \b, which flips at non-word term edges like "sentinel-2"), so "s2" does
 * not hit "S2GIS" and "bar" does not hit "sandbar". Exactly three
 * tolerances: separators inside a term match hyphen or whitespace
 * interchangeably ("sentinel-2" finds "Sentinel 2"), an optional plural-s
 * ("sandbar" finds "sandbars" but not "sandbarrier"), and the English
 * y->ies plural on consonant+y endings ("body" finds "bodies"). No
 * stemming, no synonyms -- those belong in the term groups, visible and
 * editable in the dialog.
 */
export function termMatches(text: string, term: string): boolean {
	const rawParts = term.split(/[-\s]+/).filter(Boolean);
	if (!rawParts.length) return false;
	const parts = rawParts.map((part, index) => {
		const escaped = escapeRegExp(part);
		if (index < rawParts.length - 1) return escaped;
		// Plural tolerance on the LAST word only: consonant+y -> y|ies,
		// everything else keeps the optional trailing s ("survey" ->
		// "surveys" stays on the s-path; vowel+y never takes ies).
		return /[^aeiou\s]y$/i.test(part)
			? `${escaped.slice(0, -1)}(?:y|ies)`
			: `${escaped}s?`;
	});
	const pattern = new RegExp(`(?<!\\w)${parts.join("[-\\s]+")}(?!\\w)`);
	return pattern.test(text);
}

/**
 * Multi-query labeling: every record is checked against the blocks of ALL
 * confirmed queries -- on_target means "full match for at least one of the
 * confirmed queries", regardless of which query surfaced the record
 * (found_by stays pure provenance). Judging only against the finder's
 * blocks would let chance decide the label. Accepted cost: a loose
 * variant's blocks bless every record they match, so block quality carries
 * the precision. group_matched records which query and which term per
 * block hit, so the page can show WHY a record is on_target. With no
 * blocks anywhere records stay ungrouped. Ordering: on_target first,
 * everything else in incoming order.
 */
export function groupAcrossQueries<T extends { title: string; abstract: string }>(
	records: T[],
	blockSets: TermGroups[],
): Array<T & { group?: "on_target" | "adjacent"; group_matched?: { query: number; terms: string[] } }> {
	const sets = blockSets
		.map((blocks, index) => ({ blocks, query: index + 1 }))
		.filter((set) => set.blocks.length);
	if (!sets.length) return records;
	const grouped = records.map((record) => {
		const text = `${record.title} ${record.abstract}`.toLowerCase();
		for (const set of sets) {
			// Which term hit per block; a full set of hits = on_target.
			const hits: string[] = [];
			for (const groupTerms of set.blocks) {
				const hit = groupTerms.find((term) => termMatches(text, term));
				if (hit !== undefined) hits.push(hit);
			}
			if (hits.length === set.blocks.length) {
				return {
					...record,
					group: "on_target" as const,
					group_matched: { query: set.query, terms: hits },
				};
			}
		}
		return { ...record, group: "adjacent" as const };
	});
	return [
		...grouped.filter((r) => r.group === "on_target"),
		...grouped.filter((r) => r.group !== "on_target"),
	];
}
