/**
 * Shared shapes and helpers for the pi-literature-review pipeline.
 *
 * Every field in a SourceRecord traces to a search-API response, or it does
 * not exist. Nothing is invented: missing stays missing (empty string / null).
 */

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
 * none: no personal data ships in the code. Setting PI_LITERATURE_REVIEW_MAILTO
 * opts search APIs like CrossRef into their "polite pool".
 */
export function contactMailto(): string {
	return (process.env.PI_LITERATURE_REVIEW_MAILTO || "").trim();
}

export function userAgent(): string {
	const mailto = contactMailto();
	const contact = mailto ? `; mailto:${mailto}` : "";
	return `pi-literature-review/${VERSION} (deterministic literature discovery${contact})`;
}

export function warn(message: string): void {
	process.stderr.write(`pi-literature-review: ${message}\n`);
}
