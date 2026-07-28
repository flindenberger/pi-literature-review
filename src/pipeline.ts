/**
 * Deterministic pipeline over source records: filter and dedupe (this step);
 * verify and group follow in later steps. Direct port of the Python oracle
 * (pi_literature_review.py, formerly academic_discovery.py); pure functions,
 * no network, no LLM.
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
 * Drop records that cannot be cited: no title or no authors.
 *
 * These empty-field rules are proven (Phase 2) to remove the known junk --
 * the empty-title "component" record and the Sentinel Lymph Node chapter --
 * without touching real papers. Pure, no network.
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
 * Exported: the fetch stage keys its papers/ library the same way, so one
 * paper is never stored twice.
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

/**
 * Merge two records for the same paper: start from the richer one and fill
 * its gaps from the other. Values are only copied, never rewritten.
 */
function mergePair(a: MergedRecord, b: MergedRecord): MergedRecord {
	const [base, other] = filledFieldCount(a) >= filledFieldCount(b) ? [a, b] : [b, a];
	const merged: MergedRecord = { ...base };
	for (const key of Object.keys(other) as Array<keyof MergedRecord>) {
		if (isEmpty(merged[key]) && !isEmpty(other[key])) {
			(merged as Record<string, unknown>)[key] = other[key];
		}
	}
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
			mergedByKey.set(key, mergePair(mergedByKey.get(key) as MergedRecord, record));
		} else {
			mergedByKey.set(key, record);
			order.push(key);
		}
	}
	return [...order.map((key) => mergedByKey.get(key) as MergedRecord), ...unidentified];
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
	 * not evidence against the paper (v30 user decision: filters are
	 * strictly opt-in and never silently lose the unknown). */
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
	/** v30.11: also keep records that belong to NO journal on the picker's
	 * list -- the "Other journals/sources" row. Venue-less records (arXiv,
	 * preprints) count as "other" and pass. Without venuesListed the row
	 * cannot know what "other" excludes, so nothing is filtered at all. */
	venuesOther?: boolean;
	/** The journal names the picker LISTED (its top-N facet head). Only
	 * read together with venuesOther: a record whose venue matches none of
	 * these is "other". */
	venuesListed?: string[];
	/** Keep records where at least one AUTHOR NAME contains one of these
	 * strings (case-insensitive; v30.9). Author names are API metadata;
	 * records without any matching author are dropped, with a reason --
	 * UNLESS authorsOther is set (see below). */
	authors?: string[];
	/** v30.11: also keep records by authors who are NOT on the picker's
	 * list -- the "Other authors" row. Same shape as venuesOther. */
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
	// nothing -- the venue filter is then off, honestly (v30.11).
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
	// Same rule as the journals above (v30.11): "other authors" without a
	// list of who IS listed excludes nobody.
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
 * query -- e.g. [["river","fluvial"],["sandbar","bar"],["sentinel"]] for
 * the WP1 sandbar topic. The CHECK is fixed deterministic code; an LLM may
 * propose the word lists (that is "labeling a group"), it never touches
 * the records.
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
 * Whole-word term matching (design/2026-07-14_v18). Substring matching let
 * "s2" hit "S2GIS" and "bar" hit "sandbar"; a term now only matches a whole
 * word: no word character may touch it on either side (explicit lookarounds
 * instead of \b, which flips at non-word term edges like "sentinel-2").
 * Exactly two tolerances, both user decisions: separators inside a term
 * match hyphen or whitespace interchangeably ("sentinel-2" finds
 * "Sentinel 2"), and an optional plural-s ("sandbar" finds "sandbars" but
 * not "sandbarrier"). No stemming, no synonyms -- those belong in the term
 * groups, visible and editable in the intake dialog.
 */
export function termMatches(text: string, term: string): boolean {
	const parts = term.split(/[-\s]+/).filter(Boolean).map(escapeRegExp);
	if (!parts.length) return false;
	const pattern = new RegExp(`(?<!\\w)${parts.join("[-\\s]+")}s?(?!\\w)`);
	return pattern.test(text);
}

/**
 * Deterministic on_target/adjacent split -- fixed matching code, never an
 * LLM. By default every term group must match; minGroups relaxes that to
 * "at least this many groups" (v30.3: the wide "any two concepts"
 * variant -- (a AND b) OR (a AND c) OR (b AND c) expressed without a DNF
 * rule format). A small on_target set is correct; never padded.
 */
export function group(
	record: { title: string; abstract: string },
	termGroups: TermGroups,
	minGroups?: number,
): "on_target" | "adjacent" {
	const text = `${record.title} ${record.abstract}`.toLowerCase();
	const required = Math.min(minGroups ?? termGroups.length, termGroups.length);
	const matched = termGroups
		.filter((groupTerms) => groupTerms.some((term) => termMatches(text, term)))
		.length;
	return matched >= required && required > 0 ? "on_target" : "adjacent";
}

/**
 * Stamp each record with its group; on_target first in the output. With no
 * (usable) term groups, records pass through untouched and ungrouped --
 * honest "no rules, no grouping" instead of a meaningless all-adjacent.
 */
export function groupAll<T extends { title: string; abstract: string }>(
	records: T[],
	termGroups: TermGroups,
	minGroups?: number,
): Array<T & { group?: "on_target" | "adjacent" }> {
	if (!termGroups.length) return records;
	const grouped = records.map((record) => ({ ...record, group: group(record, termGroups, minGroups) }));
	return [
		...grouped.filter((r) => r.group === "on_target"),
		...grouped.filter((r) => r.group === "adjacent"),
	];
}
