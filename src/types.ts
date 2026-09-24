/**
 * Shared record shapes and small helpers used across all stages (version,
 * contact email, user agent, stderr warnings, error names, author last
 * names). Every field in a SourceRecord traces to a search-API response, or
 * it does not exist. Nothing is invented: missing stays missing (empty
 * string / null).
 */

import { storedMailto } from "./config.ts";

export interface SourceRecord {
	title: string;
	authors: string[];
	year: string | null;
	venue: string;
	doi: string;
	arxiv_id: string;
	pdf_url: string;
	url: string;
	cites: number | null;
	source: string;
	abstract: string;
	/** Query variants that found this record; only set on multi-query runs. */
	found_by?: string[];
	/** OpenAlex source (journal) ID, e.g. "S43295729", when the API named one. */
	venue_id?: string;
	/** Journal-level 2-yr mean citedness from OpenAlex; set by enrichment. */
	journal_2yr_citedness?: number;
	/** Code repository URL: set by the code-first searchers (codesearch.ts)
	 * or by the abstract code-link stage (enrich.ts). Never overwritten. */
	code_url?: string;
	/** Data and code archives the publisher linked to the paper in its
	 * CrossRef record (set by the data-link stage, enrich.ts). */
	data_links?: DataLink[];
	/** Provenance of filled fields (field -> provider), see enrich.ts. */
	enriched?: Record<string, string>;
	/** Code-first records only: which database delivered the metadata
	 * ("arxiv" | "openalex") -- the `source` names the code platform. */
	resolved_via?: string;
	/** Code-first records only: "late" when the repository was created more
	 * than a year after the paper (the pair failed the date gate; the record
	 * lands in the dropped table), "unchecked" when no repository metadata
	 * was available. Absent = passed. */
	code_gate?: "late" | "unchecked";
	/** Human-readable reason for a "late" gate result. */
	code_gate_note?: string;
}

/** A data or code archive entry the publisher linked to a paper. */
export interface DataLink {
	url: string;
	/** Display name of the archive ("Zenodo", "PANGAEA", ...). */
	archive: string;
}

/**
 * Scope pushed into the SOURCE query itself: picked author names narrow
 * what a source FETCHES, not only what survives the post-filter -- a small
 * run can then actually contain the wanted authors' papers. Every source
 * maps it onto its own author search field; an empty scope leaves the
 * request byte-identical to a scopeless one.
 */
export interface SourceScope {
	authors?: string[];
	/** Picked authors as OpenAlex ids (exact); OpenAlex uses them instead
	 * of the names, the other sources only know names. */
	authorIds?: string[];
	/** "all": the picked authors' works regardless of the query (the text
	 * search is dropped where the source can search by author alone);
	 * "query" (default): author AND query. */
	authorScope?: "query" | "all";
	/** Concept blocks of THIS query: OR-linked synonyms per block, AND
	 * between blocks. Boolean-capable sources (arXiv, OpenAlex, Semantic
	 * Scholar) send them as a real boolean expression; CrossRef (no boolean
	 * support) flattens the terms into its relevance keyword search. The
	 * same blocks label the results on_target/adjacent, so the search and
	 * the label can never disagree. Absent: the plain query text is sent. */
	blocks?: string[][];
}

export const VERSION = "0.1.0";

/**
 * Polite User-Agent. The contact address is configurable and defaults to
 * none: no personal data ships in the code. Sources, in order: the
 * PI_LITERATURE_REVIEW_MAILTO environment variable (override), then the
 * email stored via the selection dialog (src/config.ts). It opts search APIs
 * like CrossRef into their "polite pool" and enables Unpaywall lookups.
 */
export function contactMailto(): string {
	const env = (process.env.PI_LITERATURE_REVIEW_MAILTO || "").trim();
	return env || storedMailto();
}

export function userAgent(): string {
	const mailto = contactMailto();
	const contact = mailto ? `; mailto:${mailto}` : "";
	return `pi-literature-review/${VERSION} (deterministic literature discovery${contact})`;
}

export function warn(message: string): void {
	process.stderr.write(`pi-literature-review: ${message}\n`);
}

/** Short name of a failed request's error (the underlying cause's name when
 * Node wraps it, e.g. "TimeoutError", "AbortError", "ECONNREFUSED"). */
export function errorName(error: unknown): string {
	if (!(error instanceof Error)) return "unknown";
	const cause = error.cause;
	return cause instanceof Error ? cause.name : error.name;
}

/**
 * Deterministic last name of the first author, for sorting and file
 * naming. Handles both API spellings: "Anna Kryniecka" (last token) and
 * "Kryniecka, A." (part before the comma). No repair, no guessing -- an
 * empty author list yields "".
 */
export function firstAuthorLastName(authors: string[]): string {
	const first = (authors[0] ?? "").trim();
	if (!first) return "";
	const comma = first.indexOf(",");
	if (comma > 0) return first.slice(0, comma).trim();
	const parts = first.split(/\s+/);
	return parts[parts.length - 1];
}

/** ASCII-safe filename fragment: German umlauts transliterated, other
 * diacritics stripped, everything else collapsed to underscores. Shared by
 * the library filenames and the report filenames. */
export function asciiPart(value: string): string {
	return value
		.replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue")
		.replaceAll("Ä", "Ae").replaceAll("Ö", "Oe").replaceAll("Ü", "Ue")
		.replaceAll("ß", "ss")
		.normalize("NFD").replace(/[̀-ͯ]/g, "")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}
