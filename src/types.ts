/**
 * Shared shapes and helpers for the pi-literature-review pipeline.
 *
 * Every field in a SourceRecord traces to a search-API response, or it does
 * not exist. Nothing is invented: missing stays missing (empty string / null).
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
}

export const VERSION = "0.1.0";

/**
 * Polite User-Agent. The contact address is configurable and defaults to
 * none: no personal data ships in the code. Sources, in order: the
 * PI_LITERATURE_REVIEW_MAILTO environment variable (override), then the
 * email stored via the fetch dialog (src/config.ts). It opts search APIs
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
