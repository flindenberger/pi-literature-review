/**
 * Result cards of one search run for the browser, and the user's list
 * filters applied to a saved run payload for a report. Pure functions
 * over the run's JSON sidecar: the browser shows the cards and filters
 * them instantly; a report "from this list" re-sorts the same payload
 * (filtered-out records move to the dropped table with a reason, the
 * screening flow counts them) and renders with the unchanged renderer.
 * No model anywhere.
 */

import type { ResultFilters } from "../pipeline.ts";
import type { RenderPayload } from "../render.ts";

export type CardAccess = "free" | "abstract_only" | "restricted" | "unknown";

/** Kind of publication, read from the OpenAlex work type and the type of
 * its primary source (both copied into `access` by the access stage). */
export type PaperKind = "journal" | "review" | "conference" | "abstract" | "preprint" | "book" | "other" | "unknown";

export const PAPER_KINDS: PaperKind[] = ["journal", "review", "conference", "abstract", "preprint", "book", "other", "unknown"];

/** One record as the browser card shows it. `id` is the download
 * identifier exactly as the pick step and the report use it (DOI, or
 * `arXiv:<id>`); records without one are shown but cannot be ticked. */
export interface CardRow {
	/** Row number among the results, then the dropped table (the report's numbering). */
	n: number;
	id: string;
	title: string;
	authors: string[];
	year: string | null;
	venue: string;
	doi: string;
	arxiv: string;
	url: string;
	pdf: string | null;
	cites: number | null;
	access: CardAccess | null;
	journalScore: number | null;
	codeUrl: string | null;
	dataLinks: Array<{ url: string; archive: string }>;
	sources: string[];
	group: "on_target" | "adjacent" | null;
	dropped: boolean;
	reason: string | null;
	inLibrary: boolean;
	abstract: string;
	kind: PaperKind;
	/** False when OpenAlex knows no references and no citing works (no graph). */
	graph: boolean;
}

/** The list filters of the browser; every field optional, absent = off. */
export interface CardFilters {
	/** Keep records published in this year or later. */
	yearFrom?: number;
	/** Keep records with one of these access levels. */
	access?: CardAccess[];
	/** Keep records with at least this many citations (unknown counts pass). */
	minCites?: number;
	/** Keep records that carry a code repository or a data link. */
	codeOrData?: boolean;
	/** Keep records whose venue looks like a journal (not a conference). */
	journalOnly?: boolean;
	/** Keep records whose venue or an author contains this text. */
	text?: string;
	/** Keep records found by one of these sources. */
	sources?: string[];
	/** Keep records that carry one of these links (code repository, data link). */
	links?: Array<"code" | "data">;
	/** Keep records of one of these kinds. */
	kinds?: PaperKind[];
	/** Keep records whose venue is one of these names (exact). */
	venues?: string[];
	/** Keep records with at least one of these authors (exact name). */
	authors?: string[];
}

type AnyRecord = Record<string, any>;

interface PayloadLike {
	results: AnyRecord[];
	dropped: Array<{ record: AnyRecord; reason: string }>;
	flow?: RenderPayload["flow"];
	filters?: ResultFilters | null;
	[key: string]: unknown;
}

const CONFERENCE = /\b(conference|symposium|proceedings|workshop|congress|igarss|isprs archives|river flow|meeting|colloquium)\b/i;

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The kind of a record: OpenAlex work type first ("article" split by
 * its source type), an arXiv-only record is a preprint; nothing else is
 * guessed. */
export function paperKind(record: AnyRecord): PaperKind {
	const access = record.access && typeof record.access === "object" ? record.access : {};
	const type = str(access.work_type);
	const source = str(access.source_type);
	switch (type) {
		case "article": return source === "conference" ? "conference" : source === "repository" ? "preprint" : "journal";
		case "review": return "review";
		case "conference-paper": return "conference";
		case "conference-abstract": return "abstract";
		case "preprint": return "preprint";
		case "book-chapter": case "book": return "book";
		case "": return str(record.arxiv_id) && !str(record.doi) ? "preprint" : "unknown";
		default: return "other";
	}
}

function rowOf(record: AnyRecord, n: number, dropped: boolean, reason: string | null, libraryKeys: Set<string>): CardRow {
	const doi = str(record.doi);
	const arxiv = str(record.arxiv_id);
	const id = doi || (arxiv ? `arXiv:${arxiv}` : "");
	const key = doi ? `doi:${doi.toLowerCase()}` : arxiv ? `arxiv:${arxiv.replace(/v\d+$/i, "").toLowerCase()}` : "";
	const access = record.access && typeof record.access === "object" ? record.access : null;
	const level = access && typeof access.level === "string" ? (access.level as CardAccess) : null;
	const pdfUrls = access && Array.isArray(access.pdf_urls) ? access.pdf_urls.filter((u: unknown) => typeof u === "string") : [];
	const sources = Array.isArray(record.sources) ? record.sources.filter((s: unknown) => typeof s === "string") : record.source ? [str(record.source)] : [];
	const deposited = Array.isArray(record.data_links)
		? record.data_links.filter((d: AnyRecord) => d && typeof d.url === "string").map((d: AnyRecord) => ({ url: d.url as string, archive: str(d.archive) }))
		: [];
	// A repository host among the deposited links is the code link when
	// the record has none of its own (a Zenodo release of a GitHub repo).
	const ownCode = str(record.code_url);
	const repoLink = ownCode ? undefined : deposited.find((d: { archive: string }) => d.archive === "GitHub" || d.archive === "GitLab");
	const dataLinks = repoLink ? deposited.filter((d: { url: string }) => d !== repoLink) : deposited;
	return {
		n,
		id,
		title: str(record.title),
		authors: Array.isArray(record.authors) ? record.authors.filter((a: unknown) => typeof a === "string") : [],
		year: typeof record.year === "string" && record.year ? record.year : null,
		venue: str(record.venue),
		doi,
		arxiv,
		url: str(record.url) || (doi ? `https://doi.org/${doi}` : arxiv ? `https://arxiv.org/abs/${arxiv}` : ""),
		pdf: pdfUrls[0] ?? (str(record.pdf_url) || null),
		cites: typeof record.cites === "number" ? record.cites : null,
		access: level,
		journalScore: typeof record.journal_2yr_citedness === "number" ? record.journal_2yr_citedness : null,
		codeUrl: ownCode || repoLink?.url || null,
		dataLinks,
		sources,
		group: record.group === "on_target" || record.group === "adjacent" ? record.group : null,
		dropped,
		reason,
		inLibrary: Boolean(key) && libraryKeys.has(key),
		abstract: str(record.abstract),
		kind: paperKind(record),
		graph: !(access && access.graph === false),
	};
}

/** The cards of a run: results first, then the dropped table, numbered
 * like the report (results 1..n, dropped continue). */
export function cardRows(payload: PayloadLike, libraryKeys: Set<string>): CardRow[] {
	const rows: CardRow[] = [];
	for (const record of payload.results ?? []) rows.push(rowOf(record, rows.length + 1, false, null, libraryKeys));
	for (const entry of payload.dropped ?? []) {
		if (!entry || !entry.record) continue;
		rows.push(rowOf(entry.record, rows.length + 1, true, str(entry.reason) || null, libraryKeys));
	}
	return rows;
}

/** Why a row falls out of the user's list filters, worded like the
 * pipeline's filter reasons ("filtered: ..."), so the report's flow
 * breakdown counts it under the matching category; null = kept. The
 * browser applies the same rules in its own script. */
export function cardFilterReason(row: CardRow, filters: CardFilters): string | null {
	if (filters.yearFrom !== undefined) {
		const year = row.year && /^\d{4}$/.test(row.year) ? Number(row.year) : null;
		if (year === null) return "filtered: publication year unknown, cannot prove it is in the requested range";
		if (year < filters.yearFrom) return `filtered: published ${year}, before requested ${filters.yearFrom}`;
	}
	if (filters.access && filters.access.length) {
		const level = row.access ?? "unknown";
		if (!filters.access.includes(level)) return `filtered: access "${level}" not among the requested (${filters.access.join(", ")})`;
	}
	if (filters.minCites !== undefined && row.cites !== null && row.cites < filters.minCites) {
		return `filtered: ${row.cites} citation(s) < requested minimum ${filters.minCites}`;
	}
	if (filters.codeOrData && !row.codeUrl && !row.dataLinks.length) return "filtered: no code repository or data link";
	if (filters.journalOnly && (!row.venue || CONFERENCE.test(row.venue))) {
		return row.venue ? `filtered: venue "${row.venue}" is not a journal` : "filtered: no venue in the metadata (e.g. preprint), journal articles requested";
	}
	const text = (filters.text ?? "").trim().toLowerCase();
	if (text) {
		const hit = row.venue.toLowerCase().includes(text) || row.authors.some((author) => author.toLowerCase().includes(text));
		if (!hit) return `filtered: venue and authors do not contain "${filters.text!.trim()}"`;
	}
	if (filters.sources && filters.sources.length && !row.sources.some((source) => filters.sources!.includes(source))) {
		return `filtered: not found by ${filters.sources.join(" or ")}`;
	}
	if (filters.links && filters.links.length) {
		const has = (filters.links.includes("code") && Boolean(row.codeUrl)) || (filters.links.includes("data") && row.dataLinks.length > 0);
		if (!has) return `filtered: no ${filters.links.map((link) => (link === "code" ? "code repository" : "data link")).join(" or ")}`;
	}
	if (filters.kinds && filters.kinds.length && !filters.kinds.includes(row.kind)) {
		return `filtered: publication type ${KIND_TEXT[row.kind]} not among the requested (${filters.kinds.map((kind) => KIND_TEXT[kind]).join(", ")})`;
	}
	if (filters.venues && filters.venues.length && !filters.venues.includes(row.venue)) {
		return row.venue ? `filtered: venue "${row.venue}" not among the picked journals` : "filtered: no venue in the metadata, journals picked";
	}
	if (filters.authors && filters.authors.length && !row.authors.some((author) => filters.authors!.includes(author))) {
		return "filtered: none of the picked authors";
	}
	return null;
}

const KIND_TEXT: Record<PaperKind, string> = {
	journal: "journal article", review: "review article", conference: "conference paper", abstract: "conference abstract",
	preprint: "preprint", book: "book or chapter", other: "other", unknown: "unknown",
};

/** The filters as one readable line ("last 10 years" needs the current year). */
export function describeCardFilters(filters: CardFilters, thisYear: number): string[] {
	const parts: string[] = [];
	if (filters.yearFrom !== undefined) parts.push(`published ${filters.yearFrom} or later (last ${thisYear - filters.yearFrom + 1} years)`);
	if (filters.access && filters.access.length) parts.push(`access: ${filters.access.map((level) => level.replace("_", " ")).join(" or ")}`);
	if (filters.minCites !== undefined) parts.push(`at least ${filters.minCites} citation${filters.minCites === 1 ? "" : "s"}`);
	if (filters.codeOrData) parts.push("code or data link");
	if (filters.journalOnly) parts.push("journal articles only");
	if ((filters.text ?? "").trim()) parts.push(`venue or author contains "${filters.text!.trim()}"`);
	if (filters.sources && filters.sources.length) parts.push(`source: ${filters.sources.join(" or ")}`);
	if (filters.links && filters.links.length) parts.push(`with ${filters.links.map((link) => (link === "code" ? "code" : "data")).join(" or ")}`);
	if (filters.kinds && filters.kinds.length) parts.push(`type: ${filters.kinds.map((kind) => KIND_TEXT[kind]).join(" or ")}`);
	if (filters.venues && filters.venues.length) parts.push(`journal: ${filters.venues.join(" or ")}`);
	if (filters.authors && filters.authors.length) parts.push(`author: ${filters.authors.join(" or ")}`);
	return parts;
}

/** True when at least one filter is set. */
export function hasCardFilters(filters: CardFilters): boolean {
	return describeCardFilters(filters, 2000).length > 0;
}

/** The user's filters read from a request body: unknown keys dropped,
 * wrong types ignored. Pure. */
export function parseCardFilters(body: unknown): CardFilters {
	const b = (body && typeof body === "object" ? body : {}) as AnyRecord;
	const out: CardFilters = {};
	if (Number.isInteger(b.yearFrom) && b.yearFrom > 0) out.yearFrom = b.yearFrom;
	if (Array.isArray(b.access)) {
		const levels = b.access.filter((v: unknown): v is CardAccess => v === "free" || v === "abstract_only" || v === "restricted" || v === "unknown");
		if (levels.length) out.access = levels;
	}
	if (Number.isInteger(b.minCites) && b.minCites >= 0) out.minCites = b.minCites;
	if (b.codeOrData === true) out.codeOrData = true;
	if (b.journalOnly === true) out.journalOnly = true;
	if (typeof b.text === "string" && b.text.trim()) out.text = b.text.trim().slice(0, 80);
	if (Array.isArray(b.sources)) {
		const sources = b.sources.filter((v: unknown): v is string => typeof v === "string" && /^[a-z0-9-]+$/.test(v));
		if (sources.length) out.sources = sources;
	}
	if (Array.isArray(b.links)) {
		const links = b.links.filter((v: unknown): v is "code" | "data" => v === "code" || v === "data");
		if (links.length) out.links = [...new Set(links)];
	}
	if (Array.isArray(b.kinds)) {
		const kinds = b.kinds.filter((v: unknown): v is PaperKind => PAPER_KINDS.includes(v as PaperKind));
		if (kinds.length) out.kinds = [...new Set(kinds)];
	}
	const names = (list: unknown): string[] => Array.isArray(list)
		? [...new Set(list.filter((v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 300))].slice(0, 200)
		: [];
	const venues = names(b.venues);
	if (venues.length) out.venues = venues;
	const authors = names(b.authors);
	if (authors.length) out.authors = authors;
	return out;
}

/** A copy of the run payload with the list filters applied as one more
 * screening step: filtered-out results join the dropped table with their
 * reason, the flow counts them under excluded_by_filters, and the list
 * filters are named for the report header. The original is untouched. */
export function applyCardFilters<T extends PayloadLike>(payload: T, filters: CardFilters, thisYear: number): T & { list_filters: string[] | null } {
	const rows = cardRows(payload, new Set());
	const kept: AnyRecord[] = [];
	const removed: Array<{ record: AnyRecord; reason: string }> = [];
	(payload.results ?? []).forEach((record, index) => {
		const reason = cardFilterReason(rows[index], filters);
		if (reason) removed.push({ record, reason });
		else kept.push(record);
	});
	const flow = payload.flow
		? { ...payload.flow, excluded_by_filters: payload.flow.excluded_by_filters + removed.length, included: kept.length }
		: payload.flow;
	const described = describeCardFilters(filters, thisYear);
	return {
		...payload,
		results: kept,
		dropped: [...(payload.dropped ?? []), ...removed],
		flow,
		list_filters: described.length ? described : null,
	};
}
