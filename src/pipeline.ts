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
	/** Keep records published in [yearFrom, yearTo]. A record with unknown
	 * year cannot prove it is in range and is dropped, with a reason. */
	yearFrom?: number;
	yearTo?: number;
	/** Keep records whose venue contains one of these strings
	 * (case-insensitive). Venue-less records (e.g. arXiv preprints) do not
	 * match a venue request and are dropped, with a reason. */
	venues?: string[];
	/** Keep only records with a direct PDF link. */
	requirePdf?: boolean;
	/** Keep only records whose identifier resolved (verified: true). */
	verifiedOnly?: boolean;
}

interface FilterableRecord {
	cites: number | null;
	year: string | null;
	venue: string;
	pdf_url: string;
	verified: boolean;
}

/** Reason a record fails the filters, or null if it passes. Fixed strings. */
function filterReason(record: FilterableRecord, filters: ResultFilters): string | null {
	if (filters.minCites !== undefined && record.cites !== null && record.cites < filters.minCites) {
		return `filtered: ${record.cites} citation(s) < requested minimum ${filters.minCites}`;
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
	if (filters.venues?.length) {
		if (!record.venue) {
			return "filtered: no venue in the metadata (e.g. preprint), cannot match requested venues";
		}
		const venue = record.venue.toLowerCase();
		if (!filters.venues.some((wanted) => venue.includes(wanted.trim().toLowerCase()))) {
			return `filtered: venue "${record.venue}" matches none of the requested venues`;
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

/**
 * Deterministic on_target/adjacent split -- fixed matching code, never an
 * LLM. Everything not matching every term group is adjacent. A small
 * on_target set is correct; the list is never padded.
 */
export function group(
	record: { title: string; abstract: string },
	termGroups: TermGroups,
): "on_target" | "adjacent" {
	const text = `${record.title} ${record.abstract}`.toLowerCase();
	const hit = termGroups.every((groupTerms) => groupTerms.some((term) => text.includes(term)));
	return hit ? "on_target" : "adjacent";
}

/**
 * Stamp each record with its group; on_target first in the output. With no
 * (usable) term groups, records pass through untouched and ungrouped --
 * honest "no rules, no grouping" instead of a meaningless all-adjacent.
 */
export function groupAll<T extends { title: string; abstract: string }>(
	records: T[],
	termGroups: TermGroups,
): Array<T & { group?: "on_target" | "adjacent" }> {
	if (!termGroups.length) return records;
	const grouped = records.map((record) => ({ ...record, group: group(record, termGroups) }));
	return [
		...grouped.filter((r) => r.group === "on_target"),
		...grouped.filter((r) => r.group === "adjacent"),
	];
}
