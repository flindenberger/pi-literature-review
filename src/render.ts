/**
 * Deterministic HTML rendering -- three self-contained pages:
 *   renderHtml()                 the search results page (both record tables,
 *                                meta block, PRISMA documentation, selection bar)
 *   renderPaperChatReportHtml()  the session report of one paper (paper chat)
 *   renderSynthReportHtml()      the composable literature report (de/en chrome)
 *
 * Pure functions, no network, no LLM: every page is a typographic view of
 * its JSON payload and nothing else. All strings are HTML-escaped; hrefs are
 * built only from record fields with an http(s) scheme or from
 * code-constructed local PDF paths (localPdfHref). The only "live" markup
 * inside model prose are the code-validated citation markers. Plain,
 * scholarly, emoji-free; inline CSS and small inline scripts that only
 * reorder, reveal or copy what is already on the page.
 */

import { pathToFileURL } from "node:url";

import type { ResultFilters } from "./pipeline.ts";
import type { CitationSite } from "./protocol.ts";
import { type ChatReport, highlightPhrase, type ReportUnit, type SynthReport } from "./synthesis.ts";
import type { AccessInfo, AccessLevel } from "./sources/openalex.ts";
import { firstAuthorLastName } from "./types.ts";

/** One search record as the page needs it (kept AND dropped records). */
interface RenderRecord {
	title: string;
	authors: string[];
	year: string | null;
	venue: string;
	doi: string;
	arxiv_id: string;
	pdf_url: string;
	url: string;
	cites: number | null;
	abstract: string;
	/** Post-dedupe records carry `sources`; raw dropped records carry `source`. */
	sources?: string[];
	source?: string;
	verified?: boolean;
	verify_note?: string;
	group?: "on_target" | "adjacent";
	/** Which query's blocks earned the on_target label, with the exact term
	 * that hit per block -- absent on adjacent records and older sidecars. */
	group_matched?: { query: number; terms: string[] } | null;
	/** Fields filled by the deterministic identifier lookup: field -> provider. */
	enriched?: Record<string, string>;
	/** Query variants that found this record (multi-query runs only). */
	found_by?: string[];
	/** Journal-level 2-yr mean citedness from OpenAlex (open JIF analog). */
	journal_2yr_citedness?: number | null;
	/** Repository named in the abstract, found by the identifier search, or
	 * the repository a code-first source started from -- a disclosed
	 * heuristic, not a verified artifact link. */
	code_url?: string;
	/** Code-first records: the database that delivered the metadata
	 * ("arxiv" | "openalex") while `sources` names the code platform. */
	resolved_via?: string;
	/** Code-first pair gate: "late" (repository created long after the
	 * paper; record sits in the dropped table), "unchecked" (no repository
	 * metadata available). */
	code_gate?: "late" | "unchecked";
	code_gate_note?: string;
	/** Open-access level and open PDF locations from OpenAlex (absent in
	 * sidecars written by older versions and with enrichment off). */
	access?: AccessInfo;
}

/** The search payload (runSearch output / JSON sidecar) as the page reads
 * it; optional fields are absent in sidecars written by older versions. */
export interface RenderPayload {
	query: string;
	/** Results per access level (null or absent: not looked up). */
	access_counts?: Record<AccessLevel, number> | null;
	/** Additional query phrasings searched in the same run (null: single query). */
	query_variants?: string[] | null;
	generated: string;
	sources_used: string[];
	/** Requested records per source. */
	per_source?: number | null;
	/** Sources that errored during the run (null: none failed); a failed
	 * source must stay visible on the page. */
	source_failures?: Array<{ source: string; error: string }> | null;
	abstract_lookup_failures?: Array<{ source: string; error: string; records: number }> | null;
	/** Sources deliberately not queried (an optional API key missing). */
	sources_skipped?: Array<{ source: string; reason: string }> | null;
	/** Boolean expression actually sent to arXiv per query (null: arXiv unused). */
	arxiv_queries?: string[] | null;
	/** Authors picked in the wizard's lookup (null: none): names, OpenAlex
	 * ids, the required position and whether the query still applied. */
	author_scope?: { names: string[]; ids: string[]; position: string; scope: string } | null;
	/** Boolean block search actually sent to OpenAlex per query. */
	openalex_queries?: string[] | null;
	/** Flattened block terms actually sent to CrossRef per query (CrossRef
	 * has no boolean search). */
	crossref_queries?: string[] | null;
	/** Boolean bulk-endpoint query sent to Semantic Scholar per query (+/|
	 * syntax, citation-sorted). */
	semanticscholar_queries?: string[] | null;
	/** Code-first sources that ran (repositories first, papers resolved from
	 * what they cite) and the search text each received per query. */
	code_sources_used?: string[] | null;
	code_queries?: Record<string, string[]> | null;
	/** Raw per-source x query hit counts before any processing (PRISMA-S
	 * "records identified"); code-first sources add the repository->paper
	 * candidates gathered before resolution. */
	source_counts?: Array<{ source: string; query: string; count: number; candidates?: number }> | null;
	/** PRISMA flow numbers of the run; every value is the plain length of a
	 * list the run actually produced. */
	flow?: {
		identified: number;
		junk_removed: number;
		duplicates_removed: number;
		screened: number;
		/** Code-first pairs whose repository was created long after the
		 * paper, moved to the dropped table (only when a code source ran). */
		late_code_pairs_removed?: number;
		/** Records still without an abstract after enrichment. */
		no_abstract_removed?: number;
		/** Code-only records whose title/abstract miss the query blocks,
		 * moved to the dropped table (only when a code source ran). */
		off_topic_code_removed?: number;
		excluded_by_filters: number;
		included: number;
	} | null;
	grouping: string[][] | null;
	/** Per-query concept blocks of a multi-query run; a record is on_target
	 * when it fully matches ANY of these sets. */
	grouping_by_query?: Array<{ query: string; groups: string[][] | null }> | null;
	filters: ResultFilters | null;
	sort: string | null;
	results: RenderRecord[];
	dropped: Array<{ reason: string; record: RenderRecord }>;
}

function esc(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** Only link URLs the APIs delivered with a plain http(s) scheme. */
function safeHref(url: string): string | null {
	return /^https?:\/\//i.test(url) ? url : null;
}

/** An escaped link that opens in a new tab; plain text when there is no
 * safe href. */
function link(href: string | null, text: string): string {
	if (href === null) return esc(text);
	return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

/** A table cell with a data-sort key for the client-side column sorter. */
function cell(sortKey: string, html: string, className?: string): string {
	const cls = className ? ` class="${className}"` : "";
	return `<td${cls} data-sort="${esc(sortKey)}">${html}</td>`;
}

const FILTER_LABELS: Record<string, string> = {
	minCites: "min. citations",
	yearFrom: "year from",
	yearTo: "year to",
	venues: "venues",
	requirePdf: "PDF required",
	verifiedOnly: "verified only",
	pickedAuthors: "picked authors",
	authorPosition: "author position",
};

/** Human-readable filter summary; shared with the digest so both log the
 * dialog inputs in one wording. */
export function describeFilters(filters: ResultFilters | null): string {
	if (!filters) return "none";
	const parts: string[] = [];
	// The pickers' "other journals/sources" and "other authors" rows: what
	// such a run actually removes is the LISTED entries that were not
	// selected -- state that, instead of dumping the whole list.
	const venuesOther = filters.venuesOther === true;
	const authorsOther = filters.authorsOther === true;
	const skip = new Set<string>(["venuesListed", "authorsListed", "venuesOther", "authorsOther"]);
	if (venuesOther) skip.add("venues");
	if (authorsOther) skip.add("authors");
	for (const [key, value] of Object.entries(filters)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value) && !value.length) continue;
		if (skip.has(key)) continue;
		const label = FILTER_LABELS[key] ?? key;
		parts.push(`${label}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
	}
	const names = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);
	const excludedPart = (listed: string[], picked: string[], noun: string): string => {
		const excluded = listed.filter((name) =>
			!picked.some((wanted) => name.toLowerCase().includes(wanted.trim().toLowerCase())));
		return excluded.length
			? `${noun} excluded: ${excluded.join(", ")} (all other ${noun} kept)`
			: `${noun}: all kept`;
	};
	if (venuesOther && names(filters.venuesListed).length) {
		parts.push(excludedPart(names(filters.venuesListed), names(filters.venues), "journals"));
	}
	if (authorsOther && names(filters.authorsListed).length) {
		parts.push(excludedPart(names(filters.authorsListed), names(filters.authors), "authors"));
	}
	return parts.length ? parts.join("; ") : "none";
}

/** Grouping expression as shown to the reader (shared with the digest). */
export function describeGrouping(grouping: string[][] | null): string {
	if (!grouping?.length) return "none (results ungrouped)";
	return grouping.map((terms) => `(${terms.join(" OR ")})`).join(" AND ");
}

function sourcesOf(record: RenderRecord): string[] {
	return record.sources ?? (record.source ? [record.source] : []);
}

/** Visible label and tooltip of each access level. */
const ACCESS_LABEL: Record<AccessLevel, { text: string; title: string }> = {
	free: { text: "full text free", title: "Open access: the full text is legally free" },
	abstract_only: { text: "abstract only", title: "Conference abstract: no paper PDF exists" },
	restricted: { text: "restricted", title: "Subscription needed; often reachable in the browser, e.g. in a university network" },
	unknown: { text: "unknown", title: "Access status unknown (no DOI, or OpenAlex does not list it)" },
};

/** The access marker of a row: level label, OpenAlex oa_status in the
 * tooltip. Empty for records without access info (older sidecars). */
function accessBadge(record: RenderRecord): string {
	if (!record.access) return "";
	const label = ACCESS_LABEL[record.access.level] ?? ACCESS_LABEL.unknown;
	const status = record.access.oa_status ? ` (OpenAlex: ${record.access.oa_status})` : "";
	return `<span class="access access-${esc(record.access.level)}" title="${esc(label.title + status)}">${esc(label.text)}</span>`;
}

/** The PDF link of a row: the first open PDF location OpenAlex lists,
 * else the link the source delivered. None for restricted papers (a
 * source's PDF link there leads behind the paywall) and none for image
 * files (graphical abstracts listed as PDF). */
function pdfHref(record: RenderRecord): string | null {
	if (record.access?.level === "restricted") return null;
	const url = record.access?.pdf_urls?.[0] || record.pdf_url;
	if (!url || /\.(jpe?g|png|gif|webp|svg)(\?|$)/i.test(url)) return null;
	return safeHref(url);
}

/**
 * DOI column: the DOI linked at doi.org, else the arXiv ID at arxiv.org
 * (preprints have no DOI); the access marker and a direct PDF link on
 * their own line. An identifier that failed the HTTP trust gate is flagged
 * right here, with the plain-language note from the verifier.
 */
function doiCell(record: RenderRecord): string {
	const parts: string[] = [];
	if (record.doi) parts.push(link(`https://doi.org/${record.doi}`, record.doi));
	else if (record.arxiv_id) parts.push(link(`https://arxiv.org/abs/${record.arxiv_id}`, `arXiv:${record.arxiv_id}`));
	const pdf = pdfHref(record);
	const accessLine = [accessBadge(record), pdf ? link(pdf, "PDF") : ""].filter(Boolean).join(" &middot; ");
	if (accessLine) parts.push(accessLine);
	if (record.verified === false) {
		parts.push(`<span class="unverified">did not verify</span><span class="note">${esc(record.verify_note ?? "")}</span>`);
	}
	return parts.length ? parts.join("<br>") : "&mdash;";
}

function articleCell(record: RenderRecord, withAuthors = false): string {
	const title = `<span class="title">${link(safeHref(record.url), record.title || "(untitled)")}</span>`;
	const authors = withAuthors && record.authors.length
		? `<br><span class="authors">${esc(record.authors.join("; "))}</span>`
		: "";
	// A looked-up abstract carries the enrichment star like any filled
	// field (the footnote under the table explains it).
	const abstract = record.abstract
		? `<details><summary>Abstract${record.enriched?.abstract ? "*" : ""}</summary><p>${esc(record.abstract)}</p></details>`
		: "";
	return `${title}${authors}${abstract}`;
}

/** The identifier the selection stage accepts for this record: DOI first,
 * else the arXiv ID in its arXiv:... spelling; empty when the record has
 * neither (then there is nothing to download and the row gets no checkbox). */
function fetchIdOf(record: RenderRecord): string {
	if (record.doi) return record.doi;
	if (record.arxiv_id) return `arXiv:${record.arxiv_id}`;
	return "";
}

/* --- BibTeX column (copy & paste into LaTeX) --------------------------- *
 * The entry is generated DETERMINISTICALLY from the record's API fields;
 * no LLM is ever near it. Identifiers (DOI, arXiv id) stay verbatim --
 * escaping would corrupt them. */
const LATEX_SPECIALS: Record<string, string> = {
	"\\": "\\textbackslash{}", "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#",
	"_": "\\_", "{": "\\{", "}": "\\}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
};
function latexEscape(text: string): string {
	return text.replace(/[\\&%$#_{}~^]/g, (char) => LATEX_SPECIALS[char] as string);
}

/** Citation key <firstauthor><year><firsttitleword>, ASCII-only; records
 * without authors key as "anon". */
function bibtexKey(record: RenderRecord): string {
	const author = firstAuthorLastName(record.authors).toLowerCase().replace(/[^a-z0-9]/g, "");
	const year = record.year && /^\d{4}$/.test(record.year) ? record.year : "";
	const titleWord = (record.title.toLowerCase().match(/[a-z0-9]{3,}/) ?? [""])[0];
	return `${author || "anon"}${year}${titleWord}`;
}

/** @article when a venue exists, else @misc (arXiv preprints carry
 * eprint/archivePrefix). The doubled title braces protect capitalization
 * in LaTeX; only fields the record actually has are emitted. */
export function bibtexEntry(record: RenderRecord): string {
	const fields: string[] = [];
	const push = (name: string, value: string): void => {
		if (value) fields.push(`  ${name} = {${value}},`);
	};
	push("title", `{${latexEscape(record.title)}}`);
	push("author", latexEscape(record.authors.join(" and ")));
	if (record.venue) push("journal", latexEscape(record.venue));
	if (record.year && /^\d{4}$/.test(record.year)) push("year", record.year);
	if (record.doi) push("doi", record.doi);
	else if (record.arxiv_id) {
		push("eprint", record.arxiv_id);
		push("archivePrefix", "arXiv");
	} else if (record.url) push("url", record.url);
	return `@${record.venue ? "article" : "misc"}{${bibtexKey(record)},\n${fields.join("\n")}\n}`;
}

/** Long author lists collapse: the cell shows the first three and the
 * LAST author; the middle names sit hidden behind a "+N more" toggle
 * (AUTHORS_SCRIPT). Sorting is untouched -- the column's sort key stays
 * the first author's last name. */
const AUTHOR_HEAD = 3;
function authorsCellHtml(authors: string[]): string {
	if (!authors.length) return "&mdash;";
	// First three plus last covers the list entirely up to four names.
	if (authors.length <= AUTHOR_HEAD + 1) return esc(authors.join("; "));
	const head = esc(authors.slice(0, AUTHOR_HEAD).join("; "));
	const middle = esc(authors.slice(AUTHOR_HEAD, -1).join("; "));
	const last = esc(authors[authors.length - 1]);
	const hiddenCount = authors.length - AUTHOR_HEAD - 1;
	return `${head}<span class="mid-authors" hidden>; ${middle}</span><span class="authors-gap">; &hellip;</span>; ${last}`
		+ ` <a href="#" class="authors-toggle" data-more="(+${hiddenCount} more)" data-less="(show fewer)">(+${hiddenCount} more)</a>`;
}

/** The metadata cells the results table and the dropped table share, so
 * both tables stay comparable: Article / Authors / Year / Journal / Journal
 * score / Citations / DOI / BibTeX. Values filled by the enrichment lookup
 * carry an asterisk (footnote under the tables); sort keys stay the bare
 * values. */
function metadataCells(record: RenderRecord): string[] {
	const year = record.year !== null && /^\d{4}$/.test(record.year) ? record.year : "";
	const cites = record.cites === null || record.cites === undefined ? "" : String(record.cites);
	const venueStar = record.enriched?.venue ? "*" : "";
	const citesStar = record.enriched?.cites ? "*" : "";
	const score = typeof record.journal_2yr_citedness === "number"
		? record.journal_2yr_citedness
		: null;
	// Sort key of the Authors column: last name of the FIRST author,
	// lowercased -- a header click orders by exactly that.
	const authorKey = firstAuthorLastName(record.authors).toLowerCase();
	return [
		cell(record.title.toLowerCase(), articleCell(record), "paper"),
		cell(authorKey, authorsCellHtml(record.authors), "authorscol"),
		cell(year, esc(record.year ?? "") || "&mdash;"),
		cell(record.venue.toLowerCase(), record.venue ? esc(record.venue) + venueStar : "&mdash;"),
		cell(score === null ? "" : String(score), score === null ? "&mdash;" : score.toFixed(1)),
		cell(cites, cites ? cites + citesStar : "&mdash;"),
		cell((record.doi || record.arxiv_id).toLowerCase(), doiCell(record)),
		// BibTeX copy button: the entry text sits in a hidden textarea,
		// escaped -- the copy script reads .value, so the clipboard gets the
		// original characters back.
		cell("", `<button type="button" class="bibtex-copy" title="Copy BibTeX entry">BibTeX</button>`
			+ `<textarea class="bibtex-src" hidden>${esc(bibtexEntry(record))}</textarea>`, "bibtexcell"),
	];
}

/** Link label for the Code cell, derived from the URL's host -- the
 * abstract may name repositories on hosts beyond GitHub. Unknown hosts
 * fall back to a generic label; old sidecars (GitHub-only) render
 * unchanged. Pure, exported for tests. */
export function codeLinkLabel(url: string): string {
	const host = /^https?:\/\/(?:www\.)?([^/]+)/i.exec(url)?.[1]?.toLowerCase() ?? "";
	const labels: Record<string, string> = {
		"github.com": "GitHub",
		"gitlab.com": "GitLab",
		"bitbucket.org": "Bitbucket",
		"codeberg.org": "Codeberg",
		"huggingface.co": "Hugging Face",
		"zenodo.org": "Zenodo",
		"osf.io": "OSF",
	};
	return labels[host] ?? "Code";
}

/** The Code cell, shared by BOTH tables: sort key 0/1 so the first header
 * click puts records WITH code on top. Only present when the page has any
 * code link at all. */
function codeCells(record: RenderRecord, withCode: boolean): string[] {
	if (!withCode) return [];
	return [cell(record.code_url ? "0" : "1",
		record.code_url ? link(safeHref(record.code_url), codeLinkLabel(record.code_url)) : "&mdash;")];
}

/** The Network cell: a link into the static network.html written NEXT TO
 * the results page, carrying the record's identifiers in the hash -- the
 * network page fetches the citation neighbourhood live from OpenAlex only
 * when opened, so the run itself costs nothing. DOI first (exact lookup),
 * title always as the fallback seed (arXiv DataCite DOIs are not indexed
 * by OpenAlex). Not sortable; every record has a title, so the cell never
 * renders a dash while the column exists. */
function networkCells(record: RenderRecord, withNetwork: boolean): string[] {
	if (!withNetwork) return [];
	const params = [
		record.doi ? `doi=${encodeURIComponent(record.doi)}` : "",
		`title=${encodeURIComponent(record.title)}`,
	].filter(Boolean).join("&");
	// Styled like the BibTeX button, but it stays an anchor: it opens a page
	// instead of running script.
	return [cell("", `<a class="graph-link" href="${esc(`network.html#${params}`)}" target="_blank" rel="noopener"`
		+ ` title="Open the citation network of this paper (fetches live from OpenAlex)">Graph</a>`, "graphcell")];
}

/** Column flags shared by every row builder of the two record tables. */
interface TableColumns {
	withCode: boolean;
	withNetwork: boolean;
	/** Query text -> "Q1"/"Q2"... labels (size > 1 on multi-query runs). */
	queryLabels: Map<string, string>;
}

/** Every cell of a record row EXCEPT the last (Label) one -- identical for
 * the results table and the dropped table, which mirror each other column
 * for column: checkbox, #, the shared metadata cells, Code, Network, Data
 * source (with the finding query variants on multi-query runs). */
function leadingCells(record: RenderRecord, index: number, columns: TableColumns): string[] {
	const fetchId = fetchIdOf(record);
	const pickBox = fetchId
		? `<input type="checkbox" class="pick" data-id="${esc(fetchId)}"${record.access ? ` data-access="${esc(record.access.level)}"` : ""} aria-label="Select for PDF download">`
		: "";
	const foundBy = columns.queryLabels.size > 1 && record.found_by?.length
		? `<br><span class="note">${esc(record.found_by.map((q) => columns.queryLabels.get(q) ?? q).join(", "))}</span>`
		: "";
	const sources = sourcesOf(record).join(", ");
	return [
		cell("", pickBox, "pickcell"),
		cell(String(index + 1), String(index + 1)),
		...metadataCells(record),
		...codeCells(record, columns.withCode),
		...networkCells(record, columns.withNetwork),
		cell(sources, (esc(sources) || "&mdash;") + foundBy),
	];
}

function resultRow(record: RenderRecord, index: number, columns: TableColumns): string {
	const rowClass = record.group === "on_target" ? ' class="on-target"' : "";
	// Label sort keys are prefixed so that the FIRST click puts on_target on
	// top (matching the initial page order), not alphabetical "adjacent".
	const groupKey = record.group === "on_target" ? "0_on_target" : record.group ? "1_adjacent" : "";
	// The evidence line: which query's blocks earned the label, and the exact
	// term that hit per block -- a homonym like "stream" (two-stream CNNs) is
	// then readable right at the label.
	const evidence = record.group_matched?.terms?.length
		? `<br><span class="note">via Q${record.group_matched.query}: ${esc(record.group_matched.terms.join(" · "))}</span>`
		: "";
	const cells = [
		...leadingCells(record, index, columns),
		cell(groupKey, (record.group ? esc(record.group) : "&mdash;") + evidence),
	];
	return `<tr${rowClass}>${cells.join("")}</tr>`;
}

/** Dropped rows mirror the results table (dropped papers are selectable for
 * download exactly like kept ones); the Label column reads "dropped" with
 * the exclusion reason as its dim note, sort key = the reason, so a header
 * click clusters equal reasons. */
function droppedRow(entry: { reason: string; record: RenderRecord }, index: number, columns: TableColumns): string {
	const cells = [
		...leadingCells(entry.record, index, columns),
		cell(entry.reason.toLowerCase(), `dropped<br><span class="note">reason: ${esc(entry.reason)}</span>`),
	];
	return `<tr>${cells.join("")}</tr>`;
}

const STYLE = `
	body { font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
		color: #1c1c1c; background: #fdfdfc; max-width: 78rem; margin: 2rem auto;
		padding: 0 1.5rem; line-height: 1.45; }
	h1 { font-size: 1.4rem; margin: 0 0 0.2rem; }
	h2 { font-size: 1.05rem; margin: 2rem 0 0.4rem; }
	.meta { font-size: 0.88rem; color: #3d3d3d; margin: 0.15rem 0; }
	.meta dt { font-weight: 600; float: left; clear: left; width: 8.5rem; }
	.meta dd { margin: 0 0 0.15rem 9rem; }
	table { border-collapse: collapse; width: 100%; margin-top: 0.8rem; font-size: 0.84rem; }
	th, td { border: 1px solid #d9d9d4; padding: 0.4rem 0.55rem; vertical-align: top; text-align: left; }
	th { background: #f1f1ec; text-transform: uppercase; letter-spacing: 0.04em;
		font-size: 0.72rem; font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; }
	.sort-clear { color: #8a8a8a; margin-left: 0.3rem; padding: 0 0.15rem; font-weight: 700; }
	.sort-clear:hover { color: #8a1f11; }
	tr.on-target td { background: #f3f8f1; }
	tbody tr:hover td { background: #eaeff5; }
	.title { font-weight: 600; }
	.authors { color: #3d3d3d; }
	.note { display: block; color: #6b6b6b; font-size: 0.78rem; }
	.unverified { color: #8a1f11; font-weight: 600; }
	details { margin-top: 0.3rem; }
	details summary { cursor: pointer; color: #44506b; font-size: 0.78rem; }
	details.prisma { margin: 0.6rem 0 0; }
	details.prisma > summary { font-size: 0.88rem; font-weight: 600; }
	details p { margin: 0.3rem 0 0; color: #2c2c2c; }
	a { color: #2b4a6f; }
	td.paper { min-width: 18rem; }
	td.authorscol { color: #3d3d3d; max-width: 13rem; }
	/* Search tables: fixed layout + shared colgroup = identical column
	   widths in the results AND the dropped table (they sit under each
	   other). Headers may wrap; long unbroken strings (DOIs, URLs) break
	   inside their column instead of overflowing. */
	table.records { table-layout: fixed; }
	table.records th { white-space: normal; }
	table.records td { overflow-wrap: break-word; }
	table.records td.paper { min-width: 0; }
	table.records td.authorscol { max-width: none; }
	.authors-toggle { font-size: 0.78rem; white-space: nowrap; }
	td.bibtexcell { text-align: center; }
	.bibtex-copy { font: inherit; font-size: 0.72rem; padding: 0.15rem 0.4rem; cursor: pointer;
		background: #f1f1ec; border: 1px solid #c9c9c2; border-radius: 3px; }
	.bibtex-copy:hover { background: #e6e6df; }
	td.graphcell { text-align: center; }
	.graph-link { display: inline-block; font-size: 0.72rem; padding: 0.15rem 0.4rem;
		background: #f1f1ec; border: 1px solid #c9c9c2; border-radius: 3px;
		color: #1c1c1c; text-decoration: none; }
	.graph-link:hover { background: #e6e6df; }
	td.pickcell { text-align: center; }
	/* Access marker in the DOI column: full text free / abstract only /
	   restricted / unknown. */
	.access { display: inline-block; font-size: 0.72rem; padding: 0 0.3rem; border-radius: 3px;
		border: 1px solid transparent; white-space: nowrap; }
	.access-free { color: #1f5f2c; background: #e7f3e9; border-color: #b9dcc0; }
	.access-abstract_only { color: #6b4f12; background: #faf2de; border-color: #e6d3a3; }
	.access-restricted { color: #555; background: #eeeeea; border-color: #cfcfc8; }
	.access-unknown { color: #777; background: transparent; border-color: #ddd; }
	.selectsteps .accessnote { flex-basis: 100%; font-size: 0.84rem; color: #6b4f12; }
	.selectsteps .accessnote:empty { display: none; }
	th.no-sort { cursor: default; }
	/* Download steps: a sticky strip above the results table that walks the
	   user through tick -> copy -> paste; ticked rows keep the hover tint. */
	tbody tr:has(input.pick:checked) td { background: #eaeff5; }
	.selectsteps { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1.1rem;
		position: sticky; top: 0; z-index: 5; margin: 0.6rem 0 0.9rem; padding: 0.6rem 1rem;
		background: #eef2f7; border: 1px solid #c9d3df; border-left: 5px solid #2b4a6f;
		border-radius: 4px; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.07); font-size: 0.92rem; }
	.selectsteps .step { display: flex; align-items: center; gap: 0.5rem; white-space: nowrap;
		color: #33404f; padding: 0.2rem 0.5rem; border: 2px solid transparent; border-radius: 4px; }
	.selectsteps .step b { display: inline-flex; align-items: center; justify-content: center;
		width: 1.5rem; height: 1.5rem; border-radius: 50%; font-size: 0.8rem;
		background: #fff; border: 2px solid #2b4a6f; color: #2b4a6f; }
	.selectsteps .step.done b { background: #2b4a6f; color: #fff; }
	.selectsteps .step.now { background: #fff; border-color: #2b4a6f; color: #2b4a6f; font-weight: 600;
		animation: steppulse 1.6s ease-in-out 3; }
	.selectsteps .step.now b { background: #2b4a6f; color: #fff; }
	@keyframes steppulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(43, 74, 111, 0); }
		50% { box-shadow: 0 0 0 5px rgba(43, 74, 111, 0.25); } }
	.selectsteps .selectcount { font-weight: 600; color: #2b4a6f; }
	.selectsteps .sep { color: #8a9aae; }
	.selectsteps .actions { margin-left: auto; display: flex; align-items: center; gap: 0.5rem; }
	.selectsteps button { font: inherit; font-size: 0.84rem; padding: 0.3rem 0.7rem; cursor: pointer;
		background: #fff; border: 1px solid #c9c9c2; border-radius: 4px; }
	.selectsteps button:hover:enabled { background: #e6e6df; }
	.selectsteps button.copy-selection { min-width: 15rem; font-size: 0.92rem; font-weight: 600;
		padding: 0.5rem 1rem; background: #2b4a6f; border-color: #223c5b; color: #fff; }
	.selectsteps button.copy-selection:hover:enabled { background: #223c5b; }
	.selectsteps button.copy-selection:disabled { background: #f1f1ec; border-color: #c9c9c2;
		color: #9a9a94; font-weight: 400; cursor: default; }
	.selectsteps button.copy-selection.copied { background: #fff; color: #2b4a6f; border-color: #2b4a6f; }
	.selectsteps svg { vertical-align: -3px; margin-right: 0.35rem; }
	footer { margin: 2.5rem 0 1rem; font-size: 0.78rem; color: #6b6b6b;
		border-top: 1px solid #d9d9d4; padding-top: 0.6rem; }
	@media print { body { max-width: none; } details, .selectsteps, td.pickcell, td.bibtexcell, th.no-sort { display: none; } }
`;

/**
 * Column sorter with Excel-like refinement: the first clicked column is the
 * primary sort key; each further column clicked refines the order WITHIN the
 * earlier keys (click Label, then Citations: on_target stays on top, most
 * cited first inside each label). Clicking a column again flips only its
 * direction; the header shows the direction arrow and, with several keys,
 * the priority (1, 2, ...). Numeric columns start descending (largest
 * first), text columns ascending, the # column ascending; empty keys
 * (unknown values) always sort last. Pure view logic on data already on the
 * page; reload to reset.
 */
const SORT_SCRIPT = `
for (const table of document.querySelectorAll("table.sortable")) {
	const headers = Array.from(table.querySelectorAll("thead th"));
	const body = table.tBodies[0];
	const originalRows = Array.from(body.rows);
	const stack = [];
	const applySort = () => {
		// With no keys left, the original page order comes back.
		const rows = stack.length ? Array.from(body.rows) : originalRows.slice();
		if (stack.length) {
			rows.sort((a, b) => {
				for (const entry of stack) {
					const ka = a.cells[entry.column].dataset.sort ?? "";
					const kb = b.cells[entry.column].dataset.sort ?? "";
					if (ka === "" || kb === "") {
						if (ka !== kb) return ka === "" ? 1 : -1;
						continue;
					}
					const cmp = entry.numeric ? Number(ka) - Number(kb) : ka.localeCompare(kb);
					if (cmp) return entry.dir === "asc" ? cmp : -cmp;
				}
				return 0;
			});
		}
		for (const row of rows) body.appendChild(row);
	};
	const renderHeaders = () => {
		headers.forEach((h, i) => {
			if (h.classList.contains("no-sort")) return;
			if (h.dataset.label === undefined) h.dataset.label = h.textContent;
			const entry = stack.find((e) => e.column === i);
			if (!entry) {
				h.textContent = h.dataset.label;
				return;
			}
			const rank = stack.length > 1 ? String(stack.indexOf(entry) + 1) : "";
			h.textContent = h.dataset.label + (entry.dir === "asc" ? " \\u25B2" : " \\u25BC") + rank;
			const clear = document.createElement("span");
			clear.className = "sort-clear";
			clear.title = "Remove this sort key";
			clear.textContent = "\\u00D7";
			clear.addEventListener("click", (event) => {
				event.stopPropagation();
				stack.splice(stack.indexOf(entry), 1);
				applySort();
				renderHeaders();
			});
			h.appendChild(clear);
		});
	};
	headers.forEach((header, column) => {
		if (header.classList.contains("no-sort")) return;
		header.addEventListener("click", () => {
			const keys = Array.from(body.rows).map((row) => row.cells[column].dataset.sort ?? "");
			const numeric = keys.every((key) => key === "" || !Number.isNaN(Number(key)));
			const label = (header.dataset.label ?? header.textContent).trim();
			const existing = stack.find((entry) => entry.column === column);
			if (existing) existing.dir = existing.dir === "asc" ? "desc" : "asc";
			else stack.push({ column, dir: numeric && label !== "#" ? "desc" : "asc", numeric });
			applySort();
			renderHeaders();
		});
	});
}
`;

/** Header row of both record tables. The Code column exists only when at
 * least one record on the page carries a code link (an all-dash column
 * with an unexplained footnote mark would be noise). */
function resultHeaders(withCode: boolean, withNetwork: boolean): string {
	return "<tr><th class=\"no-sort\" title=\"Select rows, then copy the download request below\"></th><th>#</th><th>Article</th><th>Authors</th><th>Year</th><th>Journal</th><th>Journal score&sup1;</th><th>Citations</th><th>DOI</th><th class=\"no-sort\">BibTeX</th>"
		+ (withCode ? "<th>Code&sup2;</th>" : "")
		+ (withNetwork ? "<th class=\"no-sort\">Network</th>" : "")
		+ "<th>Data source</th><th>Label</th></tr>";
}

/** Both search tables share this colgroup and table-layout: fixed, so the
 * results table and the dropped table get IDENTICAL column widths and sit
 * aligned under each other. Widths sum to 100%; without the Code column
 * its share goes to DOI, Data source and Label. */
function resultColgroup(withCode: boolean, withNetwork: boolean): string {
	// Four variants (Code and Network are each conditional); the Network
	// column takes 4% from Article/DOI/Label when present.
	const widths = withCode
		? (withNetwork
			? [2.2, 2.8, 18, 12.5, 4.3, 8.5, 5.5, 6, 11, 5, 4.2, 4, 7, 9]
			: [2.2, 2.8, 20, 12.5, 4.3, 8.5, 5.5, 6, 12, 5, 4.2, 7, 10])
		: (withNetwork
			? [2.2, 2.8, 18, 12.5, 4.3, 8.5, 5.5, 6, 13, 5, 4, 8, 10.2]
			: [2.2, 2.8, 20, 12.5, 4.3, 8.5, 5.5, 6, 14, 5, 8, 11.2]);
	// Headers, widths and row builders are parallel structures nothing ties
	// together -- under table-layout:fixed a mismatch SHIFTS every column
	// silently instead of erroring, so it is checked loudly here (every
	// render in the test suite exercises the variants).
	const headerCount = resultHeaders(withCode, withNetwork).split("<th").length - 1;
	const sum = widths.reduce((a, b) => a + b, 0);
	if (widths.length !== headerCount || Math.abs(sum - 100) > 0.01) {
		throw new Error(`column spec mismatch: ${widths.length} width(s) for ${headerCount} header(s), width sum ${sum}`);
	}
	return `<colgroup>${widths.map((width) => `<col style="width:${width}%">`).join("")}</colgroup>`;
}

/** Download arrow for the copy button: inline SVG, no external asset. */
const DOWNLOAD_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M6 11l6 6 6-6"/><path d="M4 21h16"/></svg>';

/**
 * Selection layer: checkboxes feed a ready-made chat sentence ("Download
 * these papers: <id>, <id>, ...") into the clipboard. Pure view logic on
 * identifiers that are already printed on the page -- the page itself can
 * never download (file:// pages have neither filesystem access nor
 * permission to call other servers); the sentence is pasted into the Pi
 * chat, where the selection tool downloads after the user confirms the terminal
 * dialog. The three step markers of the strip follow the state: 1 filled
 * once something is ticked, 2 filled after copying, 3 highlighted until the
 * ticks change again.
 */
const SELECT_SCRIPT = `
{
	const bar = document.querySelector(".selectsteps");
	if (bar) {
		const picks = () => Array.from(document.querySelectorAll("input.pick"));
		const chosen = () => picks().filter((box) => box.checked);
		const countLabel = bar.querySelector(".selectcount");
		const accessNote = bar.querySelector(".accessnote");
		const copyButton = bar.querySelector(".copy-selection");
		const copyLabel = copyButton.innerHTML;
		const step = (n) => bar.querySelector(".step" + n);
		// copied: the clipboard holds the request for the CURRENT ticks; any
		// tick change makes it stale and drops back to step 2.
		let copied = false;
		const update = () => {
			const n = chosen().length;
			if (n === 0) copied = false;
			countLabel.textContent = n ? "(" + n + " ticked)" : "";
			// Ticked papers that will not download automatically, by level.
			const level = (name) => chosen().filter((box) => box.dataset.access === name).length;
			const restricted = level("restricted");
			const abstractOnly = level("abstract_only");
			const notes = [];
			if (restricted) notes.push(restricted + " restricted (open in your browser, e.g. in your university network)");
			if (abstractOnly) notes.push(abstractOnly + " abstract only (no PDF exists)");
			accessNote.textContent = notes.length ? "Of the ticked papers: " + notes.join("; ") + "." : "";
			step(1).classList.toggle("done", n > 0);
			step(2).classList.toggle("done", copied);
			step(3).classList.toggle("now", copied);
			copyButton.disabled = n === 0;
			copyButton.classList.toggle("copied", copied);
			copyButton.innerHTML = copied ? "Copied &mdash; now paste in Pi" : copyLabel;
		};
		const changed = () => { copied = false; update(); };
		document.addEventListener("change", (event) => {
			if (event.target instanceof HTMLInputElement && event.target.classList.contains("pick")) changed();
		});
		bar.querySelector(".select-all").addEventListener("click", () => {
			for (const box of picks()) box.checked = true;
			changed();
		});
		bar.querySelector(".select-clear").addEventListener("click", () => {
			for (const box of picks()) box.checked = false;
			changed();
		});
		copyButton.addEventListener("click", () => {
			const sentence = "Download these papers: "
				+ chosen().map((box) => box.dataset.id).join(", ");
			const done = () => { copied = true; update(); };
			const fallback = () => {
				const area = document.createElement("textarea");
				area.value = sentence;
				document.body.appendChild(area);
				area.select();
				document.execCommand("copy");
				area.remove();
				done();
			};
			if (navigator.clipboard?.writeText) {
				navigator.clipboard.writeText(sentence).then(done, fallback);
			} else {
				fallback();
			}
		});
		update();
	}
}
`;

/** Per-row BibTeX copy: reads the hidden textarea's value --
 * the browser has decoded the escaped entities back to the original
 * characters there -- and puts it on the clipboard, with the same
 * execCommand fallback as the selection bar. Brief "Copied" feedback on
 * the button itself. */
const BIBTEX_SCRIPT = `
for (const button of document.querySelectorAll("button.bibtex-copy")) {
	let resetTimer = null;
	button.addEventListener("click", () => {
		const source = button.closest("td").querySelector("textarea.bibtex-src");
		const done = () => {
			button.textContent = "Copied";
			// One live timer per button: without the clear, a second click
			// within the second would let the FIRST click's timeout snap the
			// fresh "Copied" straight back to "BibTeX".
			if (resetTimer !== null) clearTimeout(resetTimer);
			resetTimer = setTimeout(() => { button.textContent = "BibTeX"; resetTimer = null; }, 1000);
		};
		const fallback = () => {
			source.hidden = false;
			source.select();
			document.execCommand("copy");
			source.hidden = true;
			done();
		};
		if (navigator.clipboard?.writeText) navigator.clipboard.writeText(source.value).then(done, fallback);
		else fallback();
	});
}
`;

/** Expands/collapses the hidden middle names of a long author list (see
 * authorsCellHtml). Pure view logic; the sort keys and checkboxes are
 * untouched, and the sorter only moves whole rows, so the listeners
 * survive re-ordering. */
const AUTHORS_SCRIPT = `
for (const toggle of document.querySelectorAll("a.authors-toggle")) {
	toggle.addEventListener("click", (event) => {
		event.preventDefault();
		const cell = toggle.closest("td");
		const mid = cell.querySelector(".mid-authors");
		const gap = cell.querySelector(".authors-gap");
		const open = mid.hidden;
		mid.hidden = !open;
		gap.hidden = open;
		toggle.textContent = open ? toggle.dataset.less : toggle.dataset.more;
	});
}
`;
/** Render the full search payload as a standalone HTML document.
 * options.network adds the Network column linking into the static
 * network.html BESIDE this page -- callers set it exactly when they also
 * write that file (writeNetworkPage), so the link can never dangle;
 * re-renders of old sidecars without the flag stay column-free. */

/**
 * Per-filter exclusion counts, derived from the recorded drop reasons --
 * no payload change needed, so any sidecar with reasons gets the
 * breakdown. Each reason lands in its first matching category; wordings
 * no category knows count as "other". Pure, exported for tests.
 */
export function filterExclusionBreakdown(reasons: string[]): Array<{ label: string; count: number }> {
	const categories: Array<{ label: string; match: (reason: string) => boolean }> = [
		{ label: "publication year", match: (r) => r.includes("published ") || r.includes("publication year unknown") },
		{ label: "minimum citations", match: (r) => r.includes("citation(s) <") },
		{ label: "minimum journal score", match: (r) => r.includes("journal score") },
		{ label: "journal selection", match: (r) => r.includes("venue") },
		{ label: "author selection", match: (r) => r.includes("author") },
		{ label: "PDF required", match: (r) => r.includes("no direct PDF link") },
		{ label: "verified identifiers only", match: (r) => r.includes("identifier did not verify") },
	];
	const counts = new Map<string, number>();
	for (const reason of reasons) {
		const label = categories.find((category) => category.match(reason))?.label ?? "other";
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const order = [...categories.map((c) => c.label), "other"];
	return order.filter((label) => counts.has(label)).map((label) => ({ label, count: counts.get(label)! }));
}

/** Numbers behind the screening-flow diagram; the abstract split and the
 * filter breakdown come from the recorded drop reasons. */
export interface FlowDiagramExtras {
	abstractNone: number;
	abstractFailed: number;
	filterBreakdown: Array<{ label: string; count: number }>;
}

/**
 * PRISMA-2020-style screening-flow diagram as a standalone SVG string
 * (xmlns included, so the same string works inline AND as a downloadable
 * file). Deterministic boxes from the recorded counts: main column
 * identified -> screened -> eligible, side boxes for the removals with
 * the abstract split and per-filter counts. No language model anywhere.
 */
export function flowDiagramSvg(
	flow: NonNullable<RenderPayload["flow"]>,
	extras: FlowDiagramExtras,
): string {
	const LINE = 17;
	const PAD = 9;
	const MAIN_X = 20;
	const MAIN_W = 320;
	const SIDE_X = 400;
	const SIDE_W = 330;
	const WIDTH = 750;
	const mainCx = MAIN_X + MAIN_W / 2;

	const excludedTotal = (flow.late_code_pairs_removed ?? 0) + (flow.no_abstract_removed ?? 0)
		+ (flow.off_topic_code_removed ?? 0) + flow.excluded_by_filters;
	const side1Lines = [
		"Records removed before screening",
		`uncitable (no title or no authors): n = ${flow.junk_removed}`,
		`duplicate records merged: n = ${flow.duplicates_removed}`,
	];
	const side2Lines = [`Records excluded: n = ${excludedTotal}`];
	if (flow.late_code_pairs_removed) side2Lines.push(`code repository long after the paper: n = ${flow.late_code_pairs_removed}`);
	if (extras.abstractNone) side2Lines.push(`no abstract available: n = ${extras.abstractNone}`);
	if (extras.abstractFailed) side2Lines.push(`abstract retrieval failed: n = ${extras.abstractFailed}`);
	if (flow.off_topic_code_removed) side2Lines.push(`code-only find off topic: n = ${flow.off_topic_code_removed}`);
	if (flow.excluded_by_filters) {
		side2Lines.push(`user filters: n = ${flow.excluded_by_filters}`);
		for (const entry of extras.filterBreakdown) side2Lines.push(` ${entry.label}: n = ${entry.count}`);
	}
	const boxes = [
		{ x: MAIN_X, w: MAIN_W, lines: ["Records identified", `n = ${flow.identified}`] },
		{ x: SIDE_X, w: SIDE_W, lines: side1Lines },
		{ x: MAIN_X, w: MAIN_W, lines: ["Records screened", `n = ${flow.screened}`] },
		{ x: SIDE_X, w: SIDE_W, lines: side2Lines },
		{ x: MAIN_X, w: MAIN_W, lines: ["Records found", `n = ${flow.included}`] },
	] as Array<{ x: number; w: number; lines: string[]; y?: number; h?: number }>;
	for (const box of boxes) box.h = PAD * 2 + box.lines.length * LINE;

	// Main boxes stack down the left; each side box sits in the gap to its
	// right, and the gap grows with the side box so nothing overlaps.
	boxes[0].y = 10;
	boxes[1].y = boxes[0].y! + boxes[0].h! + 14;
	boxes[2].y = boxes[1].y! + boxes[1].h! + 14;
	boxes[3].y = boxes[2].y! + boxes[2].h! + 14;
	boxes[4].y = boxes[3].y! + boxes[3].h! + 14;
	const height = boxes[4].y! + boxes[4].h! + 10;

	const boxSvg = boxes.map((box) => {
		const text = box.lines.map((line, i) =>
			`<tspan x="${box.x + PAD}" dy="${i === 0 ? 0 : LINE}"${i === 0 ? ' font-weight="600"' : ""}>${esc(line)}</tspan>`).join("");
		return `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="3" fill="#f1f1ec" stroke="#c9c9c2"/>`
			+ `<text x="${box.x + PAD}" y="${box.y! + PAD + 12}" font-family="system-ui, sans-serif" font-size="13" fill="#1c1c1c">${text}</text>`;
	}).join("\n");

	// One vertical spine through the main column, horizontal branches into
	// the side boxes at their vertical centre.
	const arrow = (x1: number, y1: number, x2: number, y2: number) =>
		`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#6b6b6b" stroke-width="1.3" marker-end="url(#pf-arrow)"/>`;
	const arrows = [
		arrow(mainCx, boxes[0].y! + boxes[0].h!, mainCx, boxes[2].y! - 2),
		arrow(mainCx, boxes[1].y! + boxes[1].h! / 2, SIDE_X - 3, boxes[1].y! + boxes[1].h! / 2),
		arrow(mainCx, boxes[2].y! + boxes[2].h!, mainCx, boxes[4].y! - 2),
		arrow(mainCx, boxes[3].y! + boxes[3].h! / 2, SIDE_X - 3, boxes[3].y! + boxes[3].h! / 2),
	].join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-label="Screening flow diagram">
<defs><marker id="pf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#6b6b6b"/></marker></defs>
<rect width="${WIDTH}" height="${height}" fill="#fdfdfc"/>
${boxSvg}
${arrows}
</svg>`;
}

export function renderHtml(payload: RenderPayload, options?: { network?: boolean }): string {
	const results = payload.results;
	const onTarget = results.filter((r) => r.group === "on_target").length;
	const verifiedCount = results.filter((r) => r.verified).length;
	const groupSummary = payload.grouping?.length
		? ` (${onTarget} on_target, ${results.length - onTarget} adjacent)`
		: "";

	const PROVIDER_LABELS: Record<string, string> = { openalex: "OpenAlex (api.openalex.org)" };
	// Footnote gates look at BOTH tables (the dropped table carries the
	// full columns): a star or score appearing only on a dropped row still
	// needs its explanation.
	const allRecords = [...results, ...payload.dropped.map((entry) => entry.record)];
	// The code column has its own footnote (&sup2;) -- its provenance entry
	// must not pull "github" into the asterisk note, which describes FILLED
	// metadata fields.
	const enrichedProviders = [...new Set(allRecords.flatMap((r) =>
		Object.entries(r.enriched ?? {}).filter(([field]) => field !== "code_url").map(([, provider]) => provider)))]
		.map((provider) => PROVIDER_LABELS[provider] ?? provider);
	const enrichmentFootnote = enrichedProviders.length
		? `\n<p class="meta">* Value filled in by a deterministic identifier lookup at ${esc(enrichedProviders.join(", "))} because the original search source did not deliver this field (arXiv, for example, carries no citation counts or journal names). Looked up from an open API, never generated; each record's <code>enriched</code> field in the JSON names the filled fields.</p>`
		: "";
	// The score column exists on every rendered table, so its &sup1; header
	// mark needs the explanation whenever ANY row renders -- even when no
	// record carries a score (enrich:false, preprint-only runs). A page
	// without records renders no table, no header, no footnote. Same rule
	// as the code pair below: mark and footnote only ever appear together.
	const scoreFootnote = allRecords.length
		? `\n<p class="meta">&sup1; Journal score = the journal's 2-year mean citedness from OpenAlex (api.openalex.org): average citations received in the last two years by works the journal published in the two years before. It is the open analog of the proprietary journal impact factor; values are computed over the OpenAlex citation graph and differ somewhat from Clarivate's JIF. It rates the journal, not the paper.</p>`
		: "";
	// The Code column exists only when any record carries a link; column and
	// &sup2; footnote share this ONE flag so they can never drift apart.
	const withCode = allRecords.some((r) => r.code_url);
	// The Network column: only when the caller wrote the network.html
	// sidecar page, and only when any row exists to link from. Its
	// explanation is an unmarked footnote -- a numbered mark would renumber
	// with the conditional Code column.
	const withNetwork = options?.network === true && allRecords.length > 0;
	const networkFootnote = withNetwork
		? `\n<p class="meta">Network = opens a citation-context graph of the paper in a new tab: its references and citing works, related by the classic bibliometric similarity measures (bibliographic coupling, Kessler 1963; co-citation analysis, Small 1973 -- the graph page explains how each is used). The page fetches this live from the open OpenAlex API when opened (internet needed then; only the paper's DOI or title is sent, never paper content) and involves no language model.</p>`
		: "";
	const codeFootnote = withCode
		? `\n<p class="meta">&sup2; Code = a repository found deterministically, by one of two paths. Paper first: preferably the code URL the paper's own abstract names (GitHub, GitLab, Bitbucket, Codeberg, Hugging Face, Zenodo, OSF), else the best-matching repository from one GitHub search per record -- by arXiv id, or by DOI for journal papers (the repository mentions the identifier in its name, description or README; aggregator/reading-list repositories and repositories created more than a year after the paper are skipped, and a DOI match is only linked when the repository owner's name matches an author). Repository first (code sources, when enabled): repositories are searched for the query and the paper is resolved from the identifiers they cite -- Hugging Face Papers (repository as linked on the paper's Hugging Face page by the community), GitHub README searches, curated awesome lists (awesome.ecosyste.ms) and Google Earth Engine repositories; the paper's metadata then comes from arXiv or OpenAlex (<code>resolved_via</code>), and a repository created more than a year after the paper moves the record to the dropped table with the reason (usually a project citing the paper, not its code; more than five years after and the pair is not listed at all); when the found repository is a paper list, the linked repository whose name matches the paper title is taken instead; repository creation dates come from repos.ecosyste.ms (data CC-BY-SA). Both paths are heuristic pointers to likely code, not verified artifact links -- follow it and judge. Recorded in the JSON as <code>code_url</code>, provenance in <code>enriched</code> (abstract | github | hf-papers | github-readme | awesome-lists | gee-github).</p>`
		: "";

	const variants = payload.query_variants ?? [];
	const queryLabels = new Map(
		[payload.query, ...variants].map((query, index) => [query, `Q${index + 1}`] as const),
	);
	const variantRows = variants.length
		? `\n<dt>Variants</dt>${variants.map((v, i) => `<dd>Q${i + 2}: ${esc(v)}</dd>`).join("")}`
		: "";
	const queryLabel = variants.length ? `Q1: ${payload.query}` : payload.query;
	// Per-source transparency (PRISMA-S: document the strategy per
	// database): the expression each source actually received, per query.
	const sentRows = (label: string, values: string[] | null | undefined, note?: string): string => {
		const list = values ?? [];
		if (!list.length) return "";
		return `\n<dt>${label}</dt>${list
			.map((q, i) => `<dd>${list.length > 1 ? `Q${i + 1}: ` : ""}${esc(q)}</dd>`)
			.join("")}${note ? `<dd><span class="note">${esc(note)}</span></dd>` : ""}`;
	};
	const arxivQueries = payload.arxiv_queries ?? [];
	// Old sidecars carry only arxiv_queries; without the other rows this one
	// reads as "only arXiv was searched" -- the legacy note keeps those
	// pages honest.
	const legacySidecar = arxivQueries.length && !payload.openalex_queries?.length
		&& !payload.crossref_queries?.length;
	const arxivQueryRows = sentRows(
		"Sent to arXiv",
		payload.arxiv_queries,
		legacySidecar
			? "arXiv is the only source needing this boolean syntax; CrossRef and OpenAlex received the query text unchanged (keyword relevance search)."
			: undefined,
	);
	const openalexQueryRows = sentRows(
		"Sent to OpenAlex",
		payload.openalex_queries,
		"A type filter keeps peer-review reports and author replies, supplementary material, datasets, paratext and grants out of the results.",
	);
	const crossrefQueryRows = sentRows(
		"Sent to CrossRef",
		payload.crossref_queries,
		"CrossRef offers no boolean search; it receives the block terms as plain relevance keywords. A type filter requests scholarly works only (articles, proceedings, preprints, books, chapters, reports, theses), so peer-review reports and author replies never arrive.",
	);
	const semanticscholarQueryRows = sentRows(
		"Sent to Semantic Scholar",
		payload.semanticscholar_queries,
		"Bulk-endpoint boolean syntax (+ = required block, | = OR); the bulk endpoint has no relevance ranking, results arrive sorted by citation count.",
	);
	// Code-first sources: what each repository search received. Labels and
	// notes per source; unknown source names (a newer sidecar) fall back to
	// the raw name.
	const CODE_SOURCE_LABELS: Record<string, [string, string]> = {
		"hf-papers": ["Sent to Hugging Face Papers", "Relevance search over arXiv papers indexed by Hugging Face; the repository is the one linked on the paper's Hugging Face page (community-linked, not an author declaration)."],
		"github-readme": ["Sent to GitHub (README search)", "Repositories whose README cites arxiv.org and matches the words; aggregator and star-list repositories skipped; identifiers then read from each README."],
		"gee-github": ["Sent to GitHub (Google Earth Engine)", "Repositories whose README names the Earth Engine code editor and cites doi.org; identifiers then read from each README."],
		"awesome-lists": ["Matched against curated lists", "Awesome lists found by GitHub topic on awesome.ecosyste.ms; an entry matches when its name, description or category hits every block; identifiers then read from the repository README."],
	};
	const codeQueries = payload.code_queries ?? {};
	const codeQueryRows = (payload.code_sources_used ?? [])
		.map((source) => {
			const [label, note] = CODE_SOURCE_LABELS[source] ?? [`Sent to ${source}`, undefined];
			return sentRows(label, codeQueries[source], note);
		})
		.join("");
	// Picked authors (the wizard lookup): who, in which position, and
	// whether the query still applied -- one row in both meta blocks.
	const authorScopeRow = payload.author_scope
		? `<dt>Author scope</dt><dd>${esc(payload.author_scope.names.map((name, i) =>
			`${name}${payload.author_scope?.ids[i] ? ` (${payload.author_scope.ids[i]})` : ""}`).join(", "))} -- ${
			esc(payload.author_scope.position === "first" ? "first author only"
				: payload.author_scope.position === "contributing" ? "contributing author only"
				: "any author position")}, ${
			esc(payload.author_scope.scope === "all" ? "all their publications (query used only for the on_target label)" : "publications matching the query")}</dd>\n`
		: "";
	const codeSourcesRow = payload.code_sources_used?.length
		? `\n<dt>Code sources</dt><dd>${esc(payload.code_sources_used.join(", "))}<span class="note"> -- repositories first, papers resolved at arXiv / OpenAlex (see footnote &sup2;)</span></dd>`
		: "";
	// Grouping: per query on multi-query runs; a record is on_target when it
	// fully matches ANY confirmed query's blocks. Single-query runs and old
	// sidecars keep the one-line form.
	const groupingByQuery = payload.grouping_by_query ?? [];
	const groupingRows = groupingByQuery.length
		? `\n<dt>Targeting</dt>${groupingByQuery
			.map((entry, i) => `<dd>Q${i + 1}: ${esc(entry.groups?.length
				? describeGrouping(entry.groups)
				: "(no blocks -- query passed through unchanged)")}</dd>`)
			.join("")}<dd><span class="note">on_target = full match of at least one of these block sets, regardless of which query found the record.</span></dd>`
		: `\n<dt>Targeting</dt><dd>${esc(describeGrouping(payload.grouping))}</dd>`;
	// PRISMA-S documentation, collapsed at the END of the meta block: the
	// per-database strategies, raw counts, flow chain and labeling rule are
	// expert info -- out of the skim path, one click away. Old sidecars
	// without counts/flow show whatever rows they carry.
	const identifiedRows = payload.source_counts?.length
		? `\n<dt>Records identified</dt>${payload.source_counts
			.map((entry) => `<dd>${queryLabels.size > 1 ? `${queryLabels.get(entry.query) ?? "?"} ` : ""}${esc(entry.source)}: ${entry.count}${
				typeof entry.candidates === "number" ? ` (resolved from ${entry.candidates} repository candidate(s))` : ""}</dd>`)
			.join("")}<dd><span class="note">raw hits per source and query, before deduplication and filtering${
				payload.code_sources_used?.length ? "; code sources count resolved papers" : ""}.</span></dd>`
		: "";
	// The chain's last step names its destination honestly: these records
	// are pipeline survivors ELIGIBLE for the human's selection, not yet
	// "included" in the PRISMA sense (that decision is the reader's). The
	// chain lives in the ALWAYS-VISIBLE skim block and REPLACES the old
	// Results line there (they told the same numbers twice); the label
	// summary rides at the chain's end. Old sidecars without flow keep the
	// Results line.
	const flow = payload.flow;
	// Screening breakdown, derived from the recorded drop reasons (works
	// for any sidecar; old reason wordings simply land in one bucket): the
	// abstract removals split into "none exists at the sources" vs "the
	// lookup failed" -- methodically different facts -- and the filter
	// exclusions split per filter.
	const dropReasons = payload.dropped.map((entry) => entry.reason);
	const abstractReasons = dropReasons.filter((r) => r.startsWith("no abstract"));
	const abstractFailed = abstractReasons.filter((r) => r.includes("lookup failed")).length;
	const abstractNone = abstractReasons.length - abstractFailed;
	const filterCategories = filterExclusionBreakdown(dropReasons.filter((r) => r.startsWith("filtered: ")));
	const flowSummary = `(${payload.grouping?.length
		? `${onTarget} on_target, ${results.length - onTarget} adjacent; `
		: ""}${verifiedCount}/${results.length} verified)`;
	// The chain ends with what the two tables actually show ("remaining" /
	// "dropped" -- the dropped count is the table's real row count), and a
	// dim note says that BOTH stay selectable; the diagram's last box says
	// "Records found" for the same reason (dropped rows are selectable
	// too, so nothing here is "included" or exclusively eligible). The
	// filter step carries its per-filter breakdown inline.
	const flowRow = flow
		? `\n<dt>Screening flow</dt><dd>${flow.identified} record(s) identified &rarr; ${flow.junk_removed} removed as uncitable (no title or no authors) &rarr; ${flow.duplicates_removed} duplicate(s) merged &rarr; ${flow.screened} screened${
			typeof flow.late_code_pairs_removed === "number"
				? ` &rarr; ${flow.late_code_pairs_removed} code pair(s) moved to dropped (repository created long after the paper)`
				: ""}${
			typeof flow.no_abstract_removed === "number"
				? ` &rarr; ${flow.no_abstract_removed} removed without abstract`
				: ""}${
			typeof flow.off_topic_code_removed === "number"
				? ` &rarr; ${flow.off_topic_code_removed} code-only find(s) moved to dropped (title/abstract miss the query blocks)`
				: ""} &rarr; ${flow.excluded_by_filters} excluded by the user filters${
			filterCategories.length ? ` (${esc(filterCategories.map((c) => `${c.count} by ${c.label}`).join(", "))})` : ""} &rarr; ${flow.included} record(s) remaining ${flowSummary}, ${payload.dropped.length} dropped</dd><dd><span class="note">Papers of both tables (results and dropped) can still be selected and downloaded.</span></dd>`
		: "";
	const excludedRows = flow && (abstractReasons.length || flow.off_topic_code_removed || flow.excluded_by_filters)
		? `\n<dt>Records excluded</dt>`
			+ (abstractNone ? `<dd>no abstract available: ${abstractNone}</dd>` : "")
			+ (abstractFailed ? `<dd>abstract retrieval failed: ${abstractFailed} (their abstracts may exist -- see the failed-lookups note)</dd>` : "")
			+ (flow.off_topic_code_removed
				? `<dd>code-only finds off topic: ${flow.off_topic_code_removed} (title/abstract hit fewer query blocks than required -- see the dropped table)</dd>`
				: "")
			+ (flow.excluded_by_filters
				? `<dd>user filters: ${flow.excluded_by_filters}${
					filterCategories.length ? ` (${esc(filterCategories.map((c) => `${c.label}: ${c.count}`).join(", "))})` : ""}</dd>`
				: "")
		: "";
	// Access levels of the results (OpenAlex open-access status); absent in
	// older sidecars and with enrichment off.
	const accessCounts = payload.access_counts;
	const accessRow = accessCounts
		? `\n<dt>Access</dt><dd>${(["free", "abstract_only", "restricted", "unknown"] as AccessLevel[])
			.map((level) => `${accessCounts[level] ?? 0} ${ACCESS_LABEL[level].text}`).join(", ")}<span class="note"> -- open-access status from OpenAlex; restricted papers are often reachable in the browser, e.g. in a university network</span></dd>`
		: "";
	// The verify stage is the trust gate of the whole citation story --
	// worth its own line in the methods material, from the real numbers.
	const verificationRow = results.length
		? `\n<dt>Verification</dt><dd>${verifiedCount} of ${results.length} retained record(s) carry an identifier that resolved via HTTP at doi.org / arxiv.org; unverified records are flagged in the table.</dd>`
		: "";
	// The flow diagram renders from the same counts; the download link
	// carries the identical standalone SVG for reuse in a manuscript.
	const diagramSvg = flow ? flowDiagramSvg(flow, { abstractNone, abstractFailed, filterBreakdown: filterCategories }) : "";
	const diagramBlock = diagramSvg
		? `\n${diagramSvg}\n<p class="meta"><a class="flow-download" download="prisma_flow.svg" href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagramSvg)}">Download diagram (SVG)</a> -- screening flow of this search run, PRISMA-2020 style; full-text assessment happens during the manual selection and is not part of this run. Excluded records remain listed and selectable in the dropped table.</p>`
		: "";
	// Honest degradation stays visible: a source that errored is listed with
	// its reason -- the results may be incomplete and the page must say so,
	// not just a transient status line during the run.
	// A source left out on purpose (optional key missing) is a neutral
	// note on the Sources row, never a failure.
	const skippedNote = (payload.sources_skipped ?? [])
		.map((s) => `<span class="note"> -- ${esc(s.source)} ${esc(s.reason)}</span>`)
		.join("");
	const sourceFailures = payload.source_failures ?? [];
	const sourceFailureRows = sourceFailures.length
		? `\n<dt>Failed sources</dt>${sourceFailures
			.map((f) => `<dd>${esc(f.source)}: ${esc(f.error)} (results may be incomplete)</dd>`)
			.join("")}`
		: "";
	// Same honesty for failed abstract lookups: the affected records sit in
	// the dropped table with a "lookup failed" reason -- this row explains
	// why and that their abstracts may exist regardless.
	const lookupFailures = payload.abstract_lookup_failures ?? [];
	const lookupFailureRows = lookupFailures.length
		? `\n<dt>Failed lookups</dt>${lookupFailures
			.map((f) => `<dd>${esc(f.source)} abstract lookup: ${esc(f.error)} (${f.records} record(s) affected -- their abstracts may exist; they sit in the dropped table)</dd>`)
			.join("")}`
		: "";

	// The download steps sit above the results table and cover BOTH tables
	// (the select script collects every input.pick on the page); the strip
	// is sticky, so it stays in view over the dropped table too.
	const fetchable = allRecords.some((record) => fetchIdOf(record));
	const selectSteps = fetchable
		? `<div class="selectsteps" title="The selection tool downloads the open-access PDFs into the lit-selection/ library after you confirm the terminal dialog.">
<span class="step step1"><b>1</b>Tick papers to download <span class="selectcount"></span></span><span class="sep">&rarr;</span>
<span class="step step2"><b>2</b>Copy the request</span><span class="sep">&rarr;</span>
<span class="step step3"><b>3</b>Paste it into the Pi chat</span>
<span class="actions"><button type="button" class="select-all">Select all</button>
<button type="button" class="select-clear">Clear</button>
<button type="button" class="copy-selection" disabled>${DOWNLOAD_ICON}Copy download request</button></span>
<span class="accessnote"></span>
</div>\n`
		: "";

	const columns: TableColumns = { withCode, withNetwork, queryLabels };
	const resultsTable = `<h2>Query results (${results.length})</h2>\n` + selectSteps + (results.length
		? `<table class="sortable records">
${resultColgroup(withCode, withNetwork)}
<thead>${resultHeaders(withCode, withNetwork)}</thead>
<tbody>
${results.map((record, index) => resultRow(record, index, columns)).join("\n")}
</tbody>
</table>`
		: "<p>No results.</p>");

	const droppedSection = payload.dropped.length
		? `<h2>Dropped records (${payload.dropped.length})</h2>
<p class="meta">Removed by the screening steps or by your filters -- nothing disappears silently, the Label
column carries each reason, and every row stays selectable: tick dropped papers too, the download request
above includes them. Same columns as the results table.</p>
<table class="sortable records">
${resultColgroup(withCode, withNetwork)}
<thead>${resultHeaders(withCode, withNetwork)}</thead>
<tbody>
${payload.dropped.map((entry, index) => droppedRow(entry, index, columns)).join("\n")}
</tbody>
</table>`
		: "";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Literature Search: ${esc(payload.query)}</title>
<style>${STYLE}
/* The search page runs wide (13 columns are too cramped inside the shared
   78rem reading width) -- on a big screen the two record tables get the
   room; smaller windows stay responsive. The synthesis/report pages keep
   the narrower width for reading prose. */
body { max-width: 120rem; }
/* The search-documentation section: four always-visible levels behind ONE
   collapsed summary; the flow diagram scales down on narrow windows. */
details.prisma h3 { font-size: 0.95rem; margin: 1.1rem 0 0.3rem; }
details.prisma svg { max-width: 100%; height: auto; margin-top: 0.4rem; }
a.flow-download { display: inline-block; font-size: 0.78rem; padding: 0.15rem 0.5rem;
    background: #f1f1ec; border: 1px solid #c9c9c2; border-radius: 3px;
    color: #1c1c1c; text-decoration: none; }
a.flow-download:hover { background: #e6e6df; }
</style>
</head>
<body>
<h1>Literature Search</h1>
<dl class="meta">
<dt>Query</dt><dd>${esc(queryLabel)}</dd>${variantRows}
<dt>Generated</dt><dd>${esc(payload.generated)} (UTC)</dd>
<dt>Sources</dt><dd>${esc(payload.sources_used.join(", ")) || "none reachable"}${skippedNote}</dd>${codeSourcesRow}${sourceFailureRows}${lookupFailureRows}${
	payload.per_source ? `\n<dt>Records per source</dt><dd>${esc(payload.per_source)}</dd>` : ""}
${authorScopeRow}<dt>User filters</dt><dd>${esc(describeFilters(payload.filters))}</dd>
<dt>Sort</dt><dd>${esc(payload.sort ?? "source order")}</dd>${accessRow}${flowRow || `
<dt>Results</dt><dd>${results.length}${groupSummary}; ${verifiedCount}/${results.length} identifiers verified; ${payload.dropped.length} dropped</dd>`}
</dl>
<details class="prisma"><summary>Search documentation</summary>
<h3>Search strategy</h3>
<dl class="meta">
<dt>Search date</dt><dd>${esc(payload.generated)} (UTC)</dd>
<dt>Query</dt><dd>${esc(queryLabel)}</dd>${variantRows}
<dt>Databases</dt><dd>${esc(payload.sources_used.join(", ")) || "none reachable"}</dd>${
	payload.code_sources_used?.length
		? `\n<dt>Other methods</dt><dd>code repositories: ${esc(payload.code_sources_used.join(", "))} (repository search first, papers resolved from the identifiers the repositories cite)</dd>`
		: ""}${
	payload.per_source ? `\n<dt>Requested depth</dt><dd>${esc(payload.per_source)} record(s) per source and query</dd>` : ""}
${authorScopeRow}<dt>User filters</dt><dd>${esc(describeFilters(payload.filters))}</dd>
</dl>${
	arxivQueryRows || openalexQueryRows || crossrefQueryRows || semanticscholarQueryRows || codeQueryRows
		? `\n<h3>Database-specific search translation</h3>\n<dl class="meta">${arxivQueryRows}${openalexQueryRows}${crossrefQueryRows}${semanticscholarQueryRows}${codeQueryRows}\n</dl>`
		: ""}
<h3>Retrieval and screening</h3>
<dl class="meta">${identifiedRows}${excludedRows}${verificationRow}${groupingRows}
</dl>${diagramBlock}${
	sourceFailureRows || lookupFailureRows
		? `\n<h3>Limitations</h3>\n<dl class="meta">${sourceFailureRows}${lookupFailureRows}\n</dl>`
		: ""}
<p class="meta">The recorded search strategy, database-specific translations, raw retrieval counts, selection
flow, exclusion reasons and labeling rule provide the search provenance needed to support
PRISMA-S / PRISMA-2020 reporting.</p>
</details>
${resultsTable}
${droppedSection}${enrichmentFootnote}${scoreFootnote}${codeFootnote}${networkFootnote}
<footer>Rendered deterministically from the pi-literature-review JSON payload. Every field on this page
originates from a search-API response; an identifier counts as verified when it resolved via HTTP at
doi.org / arxiv.org. Column sorting only reorders the rows above. No language model produced or
modified any citation data.</footer>
<script>${SORT_SCRIPT}</script>
<script>${SELECT_SCRIPT}</script>
<script>${AUTHORS_SCRIPT}</script>
<script>${BIBTEX_SCRIPT}</script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * Shared pieces of the synthesis pages (prose, markers, references)   *
 * ------------------------------------------------------------------ */

/** An escaped link that opens in a new tab (PDF links: the report stays
 * open next to the paper). */
function pdfAnchor(href: string, text: string): string {
	return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

const REVIEW_STYLE = `
	.warnbanner { background: #fbeee6; border: 1px solid #d9a184; border-left: 5px solid #8a1f11;
		color: #6d1a0e; padding: 0.7rem 1rem; border-radius: 3px; margin: 1rem 0; font-weight: 600; }
	.prose { max-width: 46rem; font-size: 0.95rem; }
	.prose p { margin: 0.6rem 0; }
	a.cite { text-decoration: none; font-weight: 600; }
	.excerpt { color: #2c2c2c; font-size: 0.84rem; margin: 0.3rem 0 0.8rem; }
`;

/** Escaped prose with validated [n] markers turned into reference links.
 * The regex only ever touches bracketed digits that survived the citation
 * gate -- no other model text is interpreted as markup. With `cite`, each
 * marker instance is resolved through its CitationSite (one site per
 * marker, in document order -- the buildCitations invariant) to a clickable
 * superscript that opens the source PDF at the cited page; a site the
 * resolver cannot turn into a link (no local PDF) falls back to the
 * in-page reference anchor. All hrefs come from localPdfHref over
 * code-constructed library paths -- never from model or API text. */
interface CiteContext {
	sites: CitationSite[];
	hrefFor: (site: CitationSite) => string | null;
	/** Override of the DISPLAYED number (single-paper reports number cited
	 * passages, not papers); defaults to the marker's own digits. */
	labelFor?: (site: CitationSite, digits: string) => string;
	/** In-page anchor prefix of the fallback link (default "ref"). */
	anchorPrefix?: string;
}

/** One shared marker renderer per prose unit: replaces [n] markers in an
 * ALREADY-ESCAPED string, consuming the unit's sites in document order.
 * A RUN of neighbouring markers ("[16][26]", also spaced) becomes ONE
 * superscript whose numbers are comma-separated -- two adjacent <sup>
 * elements read as a single number ("1626"). Inside the run the numbers
 * are shown ASCENDING and each number only once (display order only: the
 * sites are still consumed in the model's marker order, so every number
 * keeps its own passage link). Fallback markers keep their brackets,
 * which separate them by themselves. */
function makeMarkerRenderer(cite?: CiteContext): (escaped: string) => string {
	let markerIndex = 0;
	const render = (digits: string): { label: string; html: string; sup: boolean } => {
		const site = cite?.sites[markerIndex++];
		const label = site && cite?.labelFor ? cite.labelFor(site, digits) : digits;
		const href = site ? cite?.hrefFor(site) : null;
		if (href) {
			return {
				label, sup: true,
				html: `<a class="cite" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`,
			};
		}
		return {
			label, sup: false,
			html: `<a class="cite" href="#${cite?.anchorPrefix ?? "ref"}-${label}">[${label}]</a>`,
		};
	};
	return (escaped) => escaped.replace(/\[\d+\](?:[ \t]*\[\d+\])*/g, (run) => {
		const parts = Array.from(run.matchAll(/\[(\d+)\]/g), (marker) => render(marker[1]));
		// Ascending by number when every label is numeric (a labelFor may
		// return anything); otherwise the marker order stands.
		if (parts.every((part) => /^\d+$/.test(part.label))) {
			parts.sort((a, b) => Number(a.label) - Number(b.label));
		}
		const shown: typeof parts = [];
		for (const part of parts) {
			if (!shown.some((kept) => kept.label === part.label)) shown.push(part);
		}
		if (shown.every((part) => part.sup)) {
			return `<sup>${shown.map((part) => part.html).join(", ")}</sup>`;
		}
		return shown.map((part) => (part.sup ? `<sup>${part.html}</sup>` : part.html)).join("");
	});
}

/** Inline markdown BOLD on an already-escaped string: models habitually
 * write **heading** / **term:** and the literal asterisks read as noise.
 * Only the double-asterisk pair is interpreted -- nothing else in the
 * model's text becomes markup. */
function strongHtml(escaped: string): string {
	return escaped.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<strong>$1</strong>");
}

function proseHtml(prose: string, cite?: CiteContext): string {
	const renderMarkers = makeMarkerRenderer(cite);
	return prose
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map((paragraph) => `<p>${renderMarkers(strongHtml(esc(paragraph)).replaceAll("\n", "<br>"))}</p>`)
		.join("\n");
}

/**
 * Prose where "- "/"* " line groups become real lists (the bullets summary
 * format) -- a deterministic text transformation; markers keep their
 * document order across paragraphs and list items via the shared renderer.
 */
function bulletsHtml(prose: string, cite?: CiteContext): string {
	const renderMarkers = makeMarkerRenderer(cite);
	const lines = prose.split("\n").map((line) => line.trim());
	const parts: string[] = [];
	let list: string[] = [];
	let paragraph: string[] = [];
	const flushList = (): void => {
		if (list.length) parts.push(`<ul>\n${list.map((item) => `<li>${item}</li>`).join("\n")}\n</ul>`);
		list = [];
	};
	const flushParagraph = (): void => {
		if (paragraph.length) parts.push(`<p>${paragraph.join("<br>")}</p>`);
		paragraph = [];
	};
	for (const line of lines) {
		const bullet = /^[-*]\s+(.*)$/.exec(line);
		if (bullet) {
			flushParagraph();
			list.push(renderMarkers(strongHtml(esc(bullet[1]))));
		} else if (!line) {
			flushList();
			flushParagraph();
		} else {
			flushList();
			paragraph.push(renderMarkers(strongHtml(esc(line))));
		}
	}
	flushList();
	flushParagraph();
	return parts.join("\n");
}

/** Honest footnote under superscript-cited prose (Chromium ignores the
 * #search highlight; the page anchor is the floor everywhere). */
const SUP_NOTE = '<p class="meta">Superscript numbers open the cited page of the source PDF in a new tab;'
	+ " Firefox also highlights the cited passage (Chromium opens the page without the highlight).</p>";

function referenceHref(reference: { doi: string; arxiv_id: string }): string | null {
	if (reference.doi) return safeHref(`https://doi.org/${reference.doi}`);
	if (reference.arxiv_id) return safeHref(`https://arxiv.org/abs/${reference.arxiv_id}`);
	return null;
}

/**
 * Retrieval transparency rows: the disclosed English query variant(s) --
 * the ONE place an LLM shapes retrieval, citations unaffected -- and the
 * deterministic lexical exact-match layer.
 */
function retrievalMetaRows(
	result: { query_variants?: Array<{ query: string; kind: string }>; lexical_terms?: string[]; lexical_added?: number },
): string {
	const english = (result.query_variants ?? []).filter((variant) => variant.kind === "english");
	const variantRow = english.length
		? `\n<dt>Query variants</dt><dd>English translation(s) used for retrieval: ${
			esc(english.map((variant) => variant.query).join("; "))} (LLM-shaped search query; citations unaffected)</dd>`
		: "";
	const lexicalRow = result.lexical_terms?.length
		? `\n<dt>Lexical layer</dt><dd>exact whole-word match for: ${esc(result.lexical_terms.join(", "))}${
			result.lexical_added
				? `; ${result.lexical_added} excerpt(s) guaranteed in the prompt`
				: "; no additional excerpts"}</dd>`
		: "";
	return `${variantRow}${lexicalRow}`;
}

/* ------------------------------------------------------------------ *
 * Paper-chat report page                                              *
 * ------------------------------------------------------------------ */

const CHAT_STYLE = `
	.round { border-left: 3px solid #c8d0d8; padding: 0.2rem 0 0.2rem 1rem; margin: 1.1rem 0; }
	.round .question { font-weight: 600; margin: 0.2rem 0; }
	.round .answer { white-space: pre-wrap; font-size: 0.92rem; margin: 0.4rem 0; }
	.round .roundmeta { color: #555; font-size: 0.8rem; }
`;

/**
 * file:// link into the local PDF library, optionally anchored to a page
 * and carrying a best-effort search term (Firefox's built-in PDF.js viewer
 * honors #page and #search and highlights the matches; Chromium honors
 * #page and ignores #search).
 *
 * TRUST BOUNDARY: callers may pass ONLY code-constructed paths -- in
 * practice LibraryPaper.file, which the filesystem scan built from the
 * papers directory. No API- or model-delivered string ever reaches this
 * function; safeHref stays the gate for all record-derived URLs.
 */
export function localPdfHref(pdfPath: string, page?: number, snippet?: string | null): string {
	let href = pathToFileURL(pdfPath).href; // correct percent-encoding
	if (page !== undefined) {
		href += `#page=${page}`;
		// phrase=true makes PDF.js highlight the CONTIGUOUS passage; without
		// it the query is split into single words and stray words light up.
		if (snippet) href += `&search=${encodeURIComponent(snippet)}&phrase=true`;
	}
	return href;
}

/**
 * Deterministic rendering of an ChatReport (paper chat). Same trust
 * boundary as the review page -- verified record data, escaped prose,
 * code-validated markers as the only live markup -- plus one new element:
 * file:// links into the local PDF, built exclusively from the scanned
 * library path (see localPdfHref). The chat protocol appendix renders the
 * per-round answers as PLAIN escaped text: their round-local [n] markers
 * refer to excerpts of THAT round, so linking them to this page's
 * reference anchors would wire them to the wrong targets.
 */
export function renderPaperChatReportHtml(report: ChatReport): string {
	const paper = report.paper;
	const banner = report.grounded
		? ""
		: `\n<div class="warnbanner">UNGROUNDED DRAFT -- the model produced no verifiable citations.
Do not use this text as a summary of the paper.</div>`;

	const identifier = paper.verified
		? paper.doi || (paper.arxiv_id ? `arXiv:${paper.arxiv_id}` : paper.key)
		: "(unverified -- no bibliographic record, identified by filename)";
	const pageLinks = (pages: number[]): string =>
		pages.map((page) => pdfAnchor(localPdfHref(paper.pdf_path, page), String(page))).join(", ");

	const referenceRows = report.references.map((reference) => {
		const unverified = reference.key.startsWith("file:");
		const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}`
			: unverified ? `${reference.key.slice(5)}.pdf (unverified)` : reference.key);
		const title = reference.title
			|| (unverified ? "(no verified record -- cited by filename)" : "(title not in the saved search records)");
		return `<tr id="ref-${reference.n}">
<td>[${reference.n}]</td>
<td>${esc(reference.year ?? "")}</td>
<td class="authorscol">${esc(reference.authors.join("; "))}</td>
<td class="paper title">${esc(title)}</td>
<td>${link(referenceHref(reference), id)}</td>
<td>${pageLinks(reference.pages)}</td>
</tr>`;
	}).join("\n");
	const referencesSection = report.references.length
		? `<h2>References</h2>
<p class="meta">Inserted by fixed code from HTTP-verified search records; the model only chose excerpt numbers. Page numbers link into the local PDF.</p>
<table>
<thead><tr><th>#</th><th>Year</th><th>Authors</th><th>Title</th><th>Identifier</th><th>PDF pages cited</th></tr></thead>
<tbody>
${referenceRows}
</tbody>
</table>`
		: "<h2>References</h2>\n<p>None -- no valid citations survived the gate.</p>";

	const excerptItems = report.chunks.map((chunk) => {
		const href = localPdfHref(paper.pdf_path, chunk.page, highlightPhrase(chunk));
		return `<details><summary>[${chunk.id}] page ${chunk.page}, similarity ${chunk.score.toFixed(3)}${chunk.lexical ? ", exact term match" : ""}</summary>
<p class="excerpt">${esc(chunk.text)}</p>
<p class="meta">${pdfAnchor(href, `Open the PDF at page ${chunk.page}`)} (Firefox also highlights the passage)</p>
</details>`;
	}).join("\n");

	const questionItems = report.session_questions.map((question) => `<li>${esc(question)}</li>`).join("\n");
	const focusRow = report.focus ? `\n<dt>Focus</dt><dd>${esc(report.focus)}</dd>` : "";
	const roundBlocks = report.rounds.map((round, i) => {
		const pages = [...new Set(round.references.flatMap((reference) => reference.pages))].sort((a, b) => a - b);
		const state = round.grounded ? "" : " -- UNGROUNDED (no verifiable citations)";
		const cited = pages.length ? `<p class="roundmeta">Cited pages: ${pageLinks(pages)}</p>` : "";
		// Rounds carrying per-marker citation sites link into the PDF exactly
		// like the summary; the count guard keeps a hand-edited or older
		// round from misaligning marker and site -- such rounds fall back to
		// plain text, honestly.
		const markerCount = (round.prose.match(/\[\d+\]/g) ?? []).length;
		const roundCite = round.sites && round.sites.length === markerCount && markerCount > 0
			? {
				sites: round.sites,
				hrefFor: (site: CitationSite): string | null => localPdfHref(paper.pdf_path, site.page, site.snippet),
			}
			: undefined;
		const answer = roundCite
			? `<div class="answer">${proseHtml(round.prose, roundCite)}</div>`
			: `<p class="answer">${esc(round.prose)}</p>`;
		return `<div class="round">
<p class="roundmeta">Round ${i + 1} -- ${esc(round.asked)} (UTC), ${esc(round.model)}${state}</p>
<p class="question">${esc(round.question)}</p>
${answer}
${cited}</div>`;
	}).join("\n");
	const protocolSection = report.rounds.length
		? `<h2>Chat protocol</h2>
<p class="meta">The code-validated rounds of this session (from ${esc(report.protocol_files.map((file) => file.split("/").pop() ?? file).join(", "))}).
Superscript markers open the cited PDF page; older rounds without marker sites keep their bracketed numbers as plain text.</p>
${roundBlocks}`
		: "";

	const adoptedRow = report.adopted_pdfs.length
		? `\n<dt>Adopted</dt><dd>${esc(report.adopted_pdfs.join(", "))} -- identifier found in the PDF text, metadata from a verified API lookup</dd>`
		: "";
	const failureRows = report.extraction_failures.length
		? `\n<dt>Extraction</dt><dd>${esc(report.extraction_failures.map((f) => `${f.file}: ${f.reason}`).join("; "))}</dd>`
		: "";
	// Clickable superscripts: every marker resolves into the ONE paper's
	// local PDF at the cited page.
	const cite = (report.sites ?? []).length
		? {
			sites: report.sites,
			hrefFor: (site: CitationSite): string | null => localPdfHref(paper.pdf_path, site.page, site.snippet),
		}
		: undefined;

	const integrity: string[] = [];
	integrity.push(`${report.invalid_markers.length} invalid citation marker(s) stripped`
		+ (report.invalid_markers.length ? ` (${report.invalid_markers.join(" ")})` : ""));
	integrity.push(`${report.unmarked_sentences} sentence(s) without a citation marker`);
	if (report.stripped_reference_section) {
		integrity.push("a model-written reference section was cut (references come from verified records only)");
	}
	if (report.trimmed_chunks) {
		integrity.push(`${report.trimmed_chunks} lowest-ranked excerpt(s) dropped by the context budget`);
	}

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paper Chat Report: ${esc(paper.title || paper.base)}</title>
<style>${STYLE}${REVIEW_STYLE}${CHAT_STYLE}</style>
</head>
<body>
<h1>Paper Chat Report</h1>
<dl class="meta">
<dt>Paper</dt><dd>${esc(paper.title || `${paper.base}.pdf`)}</dd>
<dt>Authors</dt><dd>${esc(paper.authors.join("; "))}</dd>
<dt>Year</dt><dd>${esc(paper.year ?? "n.d.")}</dd>
<dt>Identifier</dt><dd>${link(referenceHref(paper), identifier)}</dd>
<dt>Local PDF</dt><dd>${pdfAnchor(localPdfHref(paper.pdf_path), `${paper.base}.pdf`)}</dd>
<dt>Generated</dt><dd>${esc(report.generated)} (UTC)</dd>${focusRow}
</dl>${banner}
${report.session_questions.length ? `<h2>Questions of the session</h2>\n<ol>\n${questionItems}\n</ol>` : ""}
<h2>Summary</h2>
<div class="prose">
${proseHtml(report.prose, cite)}
</div>${cite ? `\n${SUP_NOTE}` : ""}
${referencesSection}
<h2>Method &amp; transparency</h2>
<dl class="meta">
<dt>Generator</dt><dd>${esc(report.model)} (${esc(report.backend)})</dd>
<dt>Embeddings</dt><dd>${esc(report.embedding_model)}</dd>
<dt>Retrieval</dt><dd>union of the best excerpts per session question; ${report.chunks.length} in the prompt</dd>${retrievalMetaRows(report)}${adoptedRow}${failureRows}
<dt>Integrity</dt><dd>${esc(integrity.join("; "))}</dd>
</dl>
<h2>Excerpts given to the model</h2>
<p class="meta">The complete evidence trail: these are the only sources the model saw.</p>
${excerptItems || "<p>None.</p>"}
${protocolSection}
<footer>Rendered deterministically from the pi-literature-review paper-chat payload. The language model wrote
the prose and chose excerpt numbers only; every reference on this page was inserted by fixed code from
HTTP-verified search records. Links into the PDF are built by code from the scanned library path -- never
from model output. No language model produced or modified any citation data.</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * Composable report page                                              *
 * ------------------------------------------------------------------ */

/** Page chrome per uiLanguage; "de" is the default. */
const REPORT_LABELS = {
	de: {
		pageTitle: "Literaturbericht",
		generated: "Erstellt",
		scopeLibrary: "gesamte Bibliothek",
		questionsLabel: "Fragen",
		metadataTitle: "Abfrage-Metadaten",
		documents: "Dokumente",
		models: "Modelle (LLM)",
		embeddings: "Embeddings",
		yes: "Ja",
		no: "Nein",
		asBullets: "als Bulletpoints",
		asProse: "als Fließtext",
		reviewRow: "Review-Synthese",
		technical: "Technische Details (einfach erklärt)",
		retrieval: "Textstellen-Suche",
		retrievalPlain: "Jede Frage wird mit allen Textabschnitten der PDFs verglichen (Ähnlichkeitssuche); "
			+ "nur die passendsten Auszüge bekommt das Sprachmodell zu sehen. Das Literaturverzeichnis "
			+ "eines Papers wird dabei ausgelassen -- es enthält Titel anderer Arbeiten, keine Antworten "
			+ "auf Fragen zu diesem Paper. Jede Quellenangabe setzt "
			+ "festes Programm aus geprüften Daten ein -- nie das Sprachmodell.",
		variantsLabel: "Zusätzliche Suchanfragen",
		variantsPlain: "Umformulierungen, die nur für die SUCHE verwendet wurden (z. B. die englische "
			+ "Übersetzung der Frage); auf die Zitate haben sie keinen Einfluss.",
		lexicalLabel: "Wortsuche",
		lexicalPlain: "Diese Wörter aus den Fragen wurden zusätzlich wortwörtlich im Text gesucht, damit "
			+ "exakte Begriffe (etwa Modellnummern) nicht verloren gehen.",
		lexicalAddedNote: (n: number) => `${n} Auszug/Auszüge über die Wortsuche ergänzt`,
		integrity: "Qualitätsprüfung",
		integrityPlain: "Automatische Prüfung der Antworten: Verweise auf nicht vorhandene Auszüge werden "
			+ "entfernt, Sätze ohne Beleg-Marker gezählt und hier ausgewiesen.",
		integrityInvalid: (n: number) => `${n} ungültige Zitatmarker entfernt`,
		integrityUnmarked: (n: number) => `${n} Satz/Sätze ohne Zitatmarker`,
		integrityRefSection: "vom Modell geschriebene Literaturverzeichnisse entfernt",
		integrityTrimmed: (n: number) => `${n} Auszug/Auszüge aus Platzgründen weggelassen`,
		summary: "Zusammenfassung",
		crossQuestions: "Detailfragen (paperübergreifend)",
		review: "Stand der Literatur",
		reviewNote: "Review-Synthese über die gewählten Dokumente -- bei kleiner Auswahl mit Vorsicht zu lesen.",
		references: "Referenzen",
		passages: "Belegstellen",
		passagesNote: "Hochgestellte Zahlen öffnen die zitierte Seite des Quell-PDFs in einem neuen Tab; "
			+ "Firefox markiert zusätzlich die Passage (Chromium öffnet nur die Seite).",
		excerpts: "Quell-Textstellen (für Fortgeschrittene)",
		excerptsNote: "Die vollständige Beweisspur: nur diese Auszüge hat das Modell gesehen. "
			+ "\"similarity\" ist der Abruf-Score (Kosinus-Ähnlichkeit), nach dem sie ausgewählt wurden.",
		excerptsRest: "Weitere abgerufene, nicht zitierte Textstellen (für Fortgeschrittene)",
		excerptsRestNote: "Diese Auszüge hat das Modell ebenfalls gesehen -- und NICHT als Beleg verwendet. "
			+ "Zusammen mit den Belegstellen oben ist das die vollständige Beweisspur; \"similarity\" ist der "
			+ "Abruf-Score (Kosinus-Ähnlichkeit).",
		expandMore: "▸ mehr",
		expandLess: "▾ weniger",
		retrievedAs: (unit: string, rank: number, of: number, score: string, lexical: boolean) =>
			`${unit}: abgerufen als Treffer ${rank} von ${of}, similarity ${score}${lexical ? ", exakter Worttreffer" : ""}`,
		unverified: "UNVERIFIZIERT -- ohne bibliografischen Nachweis, zitiert nur über Dateiname und Seite",
		authors: "Autoren",
		year: "Jahr",
		identifier: "Identifier",
		localPdf: "Lokales PDF",
		pages: "Seiten",
		page: "S.",
		noUnits: "Für dieses Dokument konnte kein Text extrahiert werden.",
		ungrounded: "UNGEPRÜFTER ENTWURF: Mindestens eine Einheit dieses Berichts enthält keine gültigen "
			+ "Zitatmarker und darf nicht als belegte Aussage gelesen werden.",
		footer: "Deterministisch gerendert aus dem pi-literature-review-Report. Das Sprachmodell schrieb die "
			+ "Prosa und wählte Auszugsnummern; jede Referenz und jeder PDF-Link auf dieser Seite wurde von "
			+ "festem Code aus verifizierten Datensätzen bzw. dem Bibliotheks-Scan eingesetzt. Ungültige "
			+ "Marker wurden entfernt und ausgewiesen. Kein Sprachmodell hat Zitatdaten erzeugt oder verändert.",
	},
	en: {
		pageTitle: "Literature report",
		generated: "Generated",
		scopeLibrary: "whole library",
		questionsLabel: "Questions",
		metadataTitle: "Query metadata",
		documents: "Documents",
		models: "Models (LLM)",
		embeddings: "Embeddings",
		yes: "Yes",
		no: "No",
		asBullets: "as bullet points",
		asProse: "as prose",
		reviewRow: "Review synthesis",
		technical: "Technical details (in plain language)",
		retrieval: "Passage search",
		retrievalPlain: "Each question is compared against every text chunk of the PDFs (similarity "
			+ "search); only the best-matching excerpts are shown to the language model. A paper's "
			+ "reference list is left out of that search -- it holds titles of other work, not answers "
			+ "about this paper. Every citation "
			+ "is inserted by fixed code from verified records -- never by the model.",
		variantsLabel: "Additional search queries",
		variantsPlain: "Rephrasings used for the SEARCH only (e.g. an English translation of the "
			+ "question); they never influence the citations.",
		lexicalLabel: "Word search",
		lexicalPlain: "These words from the questions were additionally matched verbatim in the text so "
			+ "exact terms (e.g. model numbers) cannot get lost.",
		lexicalAddedNote: (n: number) => `${n} excerpt(s) added via the word search`,
		integrity: "Quality check",
		integrityPlain: "Automatic check of the answers: references to non-existent excerpts are removed, "
			+ "sentences without an evidence marker are counted and disclosed here.",
		integrityInvalid: (n: number) => `${n} invalid citation marker(s) stripped`,
		integrityUnmarked: (n: number) => `${n} sentence(s) without a citation marker`,
		integrityRefSection: "model-written reference section(s) cut",
		integrityTrimmed: (n: number) => `${n} excerpt(s) dropped by the context budget`,
		summary: "Summary",
		crossQuestions: "Detail questions (cross-paper)",
		review: "State of the literature",
		reviewNote: "Review synthesis over the selected documents -- read with care on small selections.",
		references: "References",
		passages: "Cited passages",
		passagesNote: "Superscript numbers open the cited page of the source PDF in a new tab; "
			+ "Firefox also highlights the passage (Chromium opens the page only).",
		excerpts: "Source passages (advanced)",
		excerptsNote: "The complete evidence trail: these are the only excerpts the model saw. "
			+ "\"similarity\" is the retrieval score (cosine similarity) they were selected by.",
		excerptsRest: "Other retrieved, uncited passages (advanced)",
		excerptsRestNote: "The model saw these excerpts too -- and did NOT use them as evidence. "
			+ "Together with the cited passages above they are the complete evidence trail; \"similarity\" "
			+ "is the retrieval score (cosine similarity).",
		expandMore: "▸ more",
		expandLess: "▾ less",
		retrievedAs: (unit: string, rank: number, of: number, score: string, lexical: boolean) =>
			`${unit}: retrieved as hit ${rank} of ${of}, similarity ${score}${lexical ? ", exact term match" : ""}`,
		unverified: "UNVERIFIED -- no bibliographic record, cited by filename and page only",
		authors: "Authors",
		year: "Year",
		identifier: "Identifier",
		localPdf: "Local PDF",
		pages: "Pages",
		page: "p.",
		noUnits: "No text could be extracted from this document.",
		ungrounded: "UNGROUNDED DRAFT: at least one unit of this report carries no valid citation markers "
			+ "and must not be read as an evidenced statement.",
		footer: "Rendered deterministically from the pi-literature-review report payload. The language model "
			+ "wrote the prose and chose excerpt numbers only; every reference and PDF link on this page was "
			+ "inserted by fixed code from verified records and the library scan. Invalid markers were "
			+ "stripped and disclosed. No language model produced or modified any citation data.",
	},
} as const;

function unitLabel(unit: ReportUnit, labels: (typeof REPORT_LABELS)["de" | "en"]): string {
	switch (unit.kind) {
		case "summary":
			return `${labels.summary}: ${unit.paper_base}.pdf`;
		case "detail-per-paper":
			return `${unit.paper_base}.pdf -- ${unit.question}`;
		case "detail-cross":
			return unit.question ?? "";
		case "review":
			return labels.review;
	}
}

const REPORT_STYLE = `
	section.paper { margin: 1.4rem 0; }
	hr.paper { border: none; border-top: 2px solid #c8d0d8; margin: 1.6rem 0; }
	.reviewnote { background: #eef3f8; border-left: 4px solid #4a6fa5; padding: 0.5rem 0.9rem;
		font-size: 0.86rem; color: #2c3e50; margin: 0.6rem 0; }
	ol.passages li { margin: 0.25rem 0; }
	/* The truncated passage line IS the expander -- no default disclosure
	 * triangle, a dim "more"/"less" hint at the line end, and while OPEN the
	 * truncated span disappears (the full excerpt below replaces it instead
	 * of repeating it). */
	ol.passages details.passage { display: inline; }
	/* The preview text matches the EXPANDED excerpt (same grey, same size)
	 * -- only the more/less hint keeps the accent color. */
	ol.passages details.passage summary { cursor: pointer; list-style: none; display: inline;
		color: #2c2c2c; font-size: 0.84rem; }
	ol.passages details.passage summary::-webkit-details-marker { display: none; }
	ol.passages details.passage .expandhint { color: #44506b; font-size: 0.78rem; white-space: nowrap; }
	ol.passages details.passage[open] summary .short { display: none; }
	ol.passages details.passage[open] summary .hint-more { display: none; }
	ol.passages details.passage:not([open]) summary .hint-less { display: none; }
	details.technical { margin: 0.6rem 0; }
	details.technical > summary { cursor: pointer; color: #4a6fa5; font-size: 0.9rem; }
	details.block { margin: 0.8rem 0; }
	details.block > summary { cursor: pointer; font-size: 1.05rem; font-weight: 600; color: #24435f; padding: 0.15rem 0; }
	details.block[open] > summary { margin-bottom: 0.4rem; }
`;

/**
 * Deterministic rendering of the composable report. Answers live up top
 * inside each paper's section, method & transparency sits right under the
 * head metadata, and SINGLE-paper reports number the cited PASSAGES (a
 * reference table naming the one paper the reader is asking about carries
 * no information) -- multi-paper reports keep scholarly paper-level
 * numbering.
 */
export function renderSynthReportHtml(report: SynthReport): string {
	const labels = REPORT_LABELS[report.ui_language === "en" ? "en" : "de"];
	const pdfPathByKey = new Map(report.papers.map((paper) => [paper.key, paper.pdf_path]));
	const paperByKey = new Map(report.papers.map((paper) => [paper.key, paper]));

	// Number the distinct cited passages (identity: paper, page, chunk
	// text) -- in every report, whatever its document count. The superscript
	// the reader sees is this passage number, never the paper's reference
	// number: a paper number repeats on every marker of that paper's summary
	// ("[1][1]") and tells the reader nothing, while a passage number stands
	// for one page and one excerpt.
	// The numbering runs PAPER BY PAPER in scope order (inside a paper in
	// first-citation order), so every paper's block carries ONE contiguous
	// range. Pure citation order would scatter a paper's numbers across the
	// whole report, because the cross-paper and review sections cite all
	// papers again at the end.
	// Each passage remembers WHERE it came from: per citing unit its
	// retrieval rank and score -- chunk ids are assigned in score order, so
	// the id IS the rank.
	interface Passage {
		n: number; page: number; text: string; snippet: string | null; paper_key: string;
		origins: Array<{ unit: string; rank: number; of: number; score: number; lexical: boolean }>;
	}
	const passageOfSite = new Map<CitationSite, number>();
	const passages: Passage[] = [];
	// Identity keys of all CITED chunks -- the advanced rest block below
	// shows only what was retrieved and NOT cited.
	const citedChunkKeys = new Set<string>();
	{
		const byKey = new Map<string, Passage>();
		const found: Passage[] = []; // first-citation order, numbered below
		const siteOf = new Map<CitationSite, Passage>();
		for (const unit of report.units) {
			for (const site of unit.sites) {
				const chunk = unit.chunks.find((entry) => entry.id === site.chunk_id);
				const key = `${site.paper_key}\u0000${site.page}\u0000${chunk?.text ?? site.snippet ?? ""}`;
				citedChunkKeys.add(key);
				let passage = byKey.get(key);
				if (!passage) {
					passage = {
						n: 0, page: site.page, text: chunk?.text ?? "", snippet: site.snippet,
						paper_key: site.paper_key, origins: [],
					};
					byKey.set(key, passage);
					found.push(passage);
				}
				siteOf.set(site, passage);
				if (chunk) {
					const origin = {
						unit: unitLabel(unit, labels),
						rank: chunk.id,
						of: unit.chunks.length,
						score: chunk.score,
						lexical: chunk.lexical === true,
					};
					if (!passage.origins.some((seen) => seen.unit === origin.unit && seen.rank === origin.rank)) {
						passage.origins.push(origin);
					}
				}
			}
		}
		// Group by paper (scope order; a passage of an unlisted paper sorts
		// last), keep first-citation order inside a paper, then number.
		const paperRank = (key: string): number => {
			const index = report.papers.findIndex((paper) => paper.key === key);
			return index < 0 ? report.papers.length : index;
		};
		const foundAt = new Map(found.map((passage, index) => [passage, index]));
		passages.push(...found.slice().sort((a, b) =>
			paperRank(a.paper_key) - paperRank(b.paper_key)
			|| (foundAt.get(a) ?? 0) - (foundAt.get(b) ?? 0)));
		passages.forEach((passage, index) => { passage.n = index + 1; });
		for (const [site, passage] of siteOf) passageOfSite.set(site, passage.n);
	}

	const citeOf = (unit: ReportUnit): CiteContext | undefined => (unit.sites.length
		? {
			sites: unit.sites,
			hrefFor: (site) => {
				const path = pdfPathByKey.get(site.paper_key);
				return path ? localPdfHref(path, site.page, site.snippet) : null;
			},
			labelFor: (site: CitationSite, digits: string) => String(passageOfSite.get(site) ?? digits),
			anchorPrefix: "site",
		}
		: undefined);

	// EVERY unit renders through the bullet-aware transformer: models write
	// "- "/"* " lists in ANSWERS too. bulletsHtml is a superset -- plain
	// paragraphs pass through unchanged.
	const unitHtml = (unit: ReportUnit): string =>
		`<div class="prose">\n${bulletsHtml(unit.prose, citeOf(unit))}\n</div>`;

	// ---- Page order: query metadata -> one section per document (summary,
	// questions, references/passages, source excerpts) -> cross questions ->
	// state of the literature. Technical transparency lives in a collapsed
	// block with plain-language explanations for the lay reader.
	const crossUnits = report.units.filter((unit) => unit.kind === "detail-cross");
	const reviewUnits = report.units.filter((unit) => unit.kind === "review");

	const scopeValue = report.scope.library
		? `${labels.scopeLibrary} (${report.papers.length} PDFs)`
		: report.papers.map((paper) => `${paper.base}.pdf`).join(", ");
	const models = [...new Set(report.units.map((unit) => unit.model))];
	const englishVariants = [...new Set(report.units.flatMap((unit) =>
		unit.query_variants.filter((variant) => variant.kind === "english").map((variant) => variant.query)))];
	const lexicalTerms = [...new Set(report.units.flatMap((unit) => unit.lexical_terms))];
	const lexicalAdded = report.units.reduce((sum, unit) => sum + unit.lexical_added, 0);
	const invalid = report.units.reduce((sum, unit) => sum + unit.invalid_markers.length, 0);
	const unmarked = report.units.reduce((sum, unit) => sum + unit.unmarked_sentences, 0);
	const trimmed = report.units.reduce((sum, unit) => sum + unit.trimmed_chunks, 0);
	const integrity: string[] = [labels.integrityInvalid(invalid), labels.integrityUnmarked(unmarked)];
	if (report.units.some((unit) => unit.stripped_reference_section)) integrity.push(labels.integrityRefSection);
	if (trimmed) integrity.push(labels.integrityTrimmed(trimmed));
	const questionRows = report.questions.length
		? `\n<dt>${labels.questionsLabel}</dt>${report.questions.map((question) => `<dd>${esc(question)}</dd>`).join("")}`
		: "";
	const summaryValue = report.summary
		? `${labels.yes}, ${report.summary === "bullets" ? labels.asBullets : labels.asProse}`
		: labels.no;
	const reviewModel = reviewUnits[0]?.model;
	const reviewValue = report.include_review
		? `${labels.yes}${reviewModel ? ` (${esc(reviewModel)})` : ""}`
		: labels.no;
	const variantRow = englishVariants.length
		? `\n<dt>${labels.variantsLabel}</dt><dd>${esc(englishVariants.join("; "))}<br><span class="authors">${esc(labels.variantsPlain)}</span></dd>`
		: "";
	const lexicalRow = lexicalTerms.length
		? `\n<dt>${labels.lexicalLabel}</dt><dd>${esc(lexicalTerms.join(", "))}${lexicalAdded ? `; ${esc(labels.lexicalAddedNote(lexicalAdded))}` : ""}<br><span class="authors">${esc(labels.lexicalPlain)}</span></dd>`
		: "";
	const technicalBlock = `<details class="technical"><summary>${esc(labels.technical)}</summary>
<dl class="meta">
<dt>${labels.retrieval}</dt><dd>${esc(labels.retrievalPlain)}</dd>${variantRow}${lexicalRow}
<dt>${labels.integrity}</dt><dd>${esc(integrity.join("; "))}<br><span class="authors">${esc(labels.integrityPlain)}</span></dd>
</dl></details>`;

	// ---- Layout: no table of contents, no section numbers. One block per
	// document -- title + metadata open, Summary / Questions /
	// References|Passages / Source excerpts each COLLAPSED -- then cross
	// questions and State of the literature; horizontal rules separate the
	// blocks. References live WITH their paper, not at the page bottom.
	const blocks: string[] = [];

	blocks.push(`<section id="metadata">
<h2>${esc(labels.metadataTitle)}</h2>
<dl class="meta">
<dt>${labels.generated}</dt><dd>${esc(report.generated)} (UTC)</dd>
<dt>${labels.documents}</dt><dd>${esc(scopeValue)}</dd>
<dt>${labels.models}</dt><dd>${esc(models.join(", "))} (${esc(report.backend)})</dd>
<dt>${labels.embeddings}</dt><dd>${esc(report.embedding_model)}</dd>${questionRows}
<dt>${labels.summary}</dt><dd>${esc(summaryValue)}</dd>
<dt>${labels.reviewRow}</dt><dd>${reviewValue}</dd>
</dl>
${technicalBlock}
</section>`);

	// Paper-level reference table of a CROSS section (cross questions, the
	// review): only the papers the given units cite, with their GLOBAL [n]
	// numbers and cited pages. A paper's own block needs no such table --
	// its identity sits in the block head. Anchor ids stay unique across
	// the page (first occurrence wins).
	const usedRefIds = new Set<number>();
	const referencesBlock = (units: ReportUnit[]): string | null => {
		const cited = new Set(units.flatMap((unit) => unit.sites.map((site) => site.ref)));
		const refs = report.references.filter((reference) => cited.has(reference.n));
		if (!refs.length) return null;
		const rows = refs.map((reference) => {
			const unverified = reference.key.startsWith("file:");
			const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}`
				: unverified ? `${reference.key.slice(5)}.pdf (${labels.unverified.split(" -- ")[0]})` : reference.key);
			const pdfCell = reference.pdf_path ? pdfAnchor(localPdfHref(reference.pdf_path), "PDF") : "&mdash;";
			const anchor = usedRefIds.has(reference.n) ? "" : ` id="ref-${reference.n}"`;
			usedRefIds.add(reference.n);
			return `<tr${anchor}><td>[${reference.n}]</td>
<td>${esc(reference.title || id)}<br><span class="authors">${esc(reference.authors.join("; "))}</span></td>
<td>${esc(reference.year ?? "n.d.")}</td>
<td>${link(referenceHref(reference), id)}</td>
<td>${esc(reference.pages.join(", "))}</td>
<td>${pdfCell}</td></tr>`;
		}).join("\n");
		return `<details class="block"><summary>${labels.references}</summary>
<p class="meta">${esc(labels.passagesNote)}</p>
<table>
<thead><tr><th></th><th>${labels.references}</th><th>${labels.year}</th><th>${labels.identifier}</th><th>${labels.pages}</th><th>PDF</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</details>`;
	};

	// Per-block evidence trail (the excerpts each unit's model saw), a
	// NESTED details at the end of the cited-passages block. The CITED
	// chunks carry their retrieval detail at the passage itself, so the
	// trail shows only what was retrieved and NOT cited (onlyUncited) --
	// together they stay the complete trail.
	const excerptsBlock = (units: ReportUnit[], onlyUncited = false): string | null => {
		const chunkKey = (chunk: ReportUnit["chunks"][number]): string =>
			`${chunk.paper_key}\u0000${chunk.page}\u0000${chunk.text}`;
		const perUnit = units
			.map((unit) => ({
				unit,
				chunks: unit.chunks.filter((chunk) => !onlyUncited || !citedChunkKeys.has(chunkKey(chunk))),
			}))
			.filter((entry) => entry.chunks.length);
		if (!perUnit.length) return null;
		const inner = perUnit.map(({ unit, chunks }) => {
			const items = chunks.map((chunk) => {
				const path = pdfPathByKey.get(chunk.paper_key);
				const anchor = path ? `\n<p class="meta">${pdfAnchor(localPdfHref(path, chunk.page, highlightPhrase(chunk)), `${labels.page} ${chunk.page}`)}</p>` : "";
				return `<details><summary>[${chunk.id}] ${labels.page} ${chunk.page}, similarity ${chunk.score.toFixed(3)}${chunk.lexical ? ", exact term match" : ""}</summary>
<p class="excerpt">${esc(chunk.text)}</p>${anchor}</details>`;
			}).join("\n");
			return `<details><summary>${esc(unitLabel(unit, labels))} (${chunks.length})</summary>\n${items}\n</details>`;
		}).join("\n");
		return `<details><summary>${onlyUncited ? labels.excerptsRest : labels.excerpts}</summary>
<p class="meta">${esc(onlyUncited ? labels.excerptsRestNote : labels.excerptsNote)}</p>
${inner}
</details>`;
	};

	// Short display label of a paper on a cross section's passage line:
	// first author's last name, "et al." when several, year -- read off the
	// verified record; a record without authors shows its file name. The
	// identity behind the label is the paper block the line links to.
	const paperLabel = (paper: SynthReport["papers"][number]): string => {
		const surname = paper.authors[0]?.trim().split(/\s+/).pop();
		if (!surname) return `${paper.base}.pdf`;
		const who = paper.authors.length > 1 ? `${surname} et al.` : surname;
		return paper.year ? `${who} ${paper.year}` : who;
	};

	// The passages the given units cite, in report numbering order.
	const citedBy = (units: ReportUnit[]): typeof passages => {
		const numbers = new Set(units.flatMap((unit) => unit.sites.map((site) => passageOfSite.get(site))));
		return passages.filter((passage) => numbers.has(passage.n));
	};

	// The cited passages of a block, numbered as the superscripts are. The
	// truncated line itself is the expander: a "more" hint at its end opens
	// the FULL excerpt -- CSS hides the truncated span while open -- plus,
	// per citing unit, the retrieval rank and similarity. Numbers are
	// report-global, so every item carries its number explicitly (<li
	// value>); anchor ids stay unique across the page (first occurrence
	// wins -- marker fallback links land there). A cross section names the
	// paper on every line (withPaper), linked to the paper's block. The
	// uncited evidence trail nests at the end.
	const usedSiteIds = new Set<number>();
	const passagesBlock = (subset: typeof passages, withPaper: boolean, trail: string | null): string | null => {
		if (!subset.length) return null;
		const items = subset.map((passage) => {
			const paper = paperByKey.get(passage.paper_key);
			const pageLabel = `${labels.page} ${passage.page}`;
			const pageLink = paper ? pdfAnchor(localPdfHref(paper.pdf_path, passage.page, passage.snippet), pageLabel) : esc(pageLabel);
			const source = withPaper && paper ? `<a href="#paper-${esc(paper.base)}">${esc(paperLabel(paper))}</a>, ` : "";
			const excerpt = passage.text.length > 160 ? `${passage.text.slice(0, 160)}...` : passage.text;
			const originLines = passage.origins
				.map((origin) => `<br>${esc(labels.retrievedAs(origin.unit, origin.rank, origin.of, origin.score.toFixed(3), origin.lexical))}`)
				.join("");
			const id = usedSiteIds.has(passage.n) ? "" : ` id="site-${passage.n}"`;
			usedSiteIds.add(passage.n);
			const item = `<li${id} value="${passage.n}">`;
			if (!passage.origins.length && !passage.text) {
				return `${item}${source}${pageLink} -- ${esc(excerpt)}</li>`;
			}
			return `${item}<details class="passage"><summary>${source}${pageLink} -- <span class="short">${esc(excerpt)}</span> <span class="expandhint"><span class="hint-more">${labels.expandMore}</span><span class="hint-less">${labels.expandLess}</span></span></summary>
<p class="excerpt">${esc(passage.text)}</p>${originLines ? `\n<p class="meta">${originLines.slice("<br>".length)}</p>` : ""}
</details></li>`;
		}).join("\n");
		return `<details class="block"><summary>${labels.passages}</summary>
<p class="meta">${esc(labels.passagesNote)}</p>
<ol class="passages">
${items}
</ol>${trail ? `\n${trail}` : ""}
</details>`;
	};

	// One block per document.
	for (const paper of report.papers) {
		const paperTitle = paper.title || `${paper.base}.pdf`;
		const identifier = paper.doi || (paper.arxiv_id ? `arXiv:${paper.arxiv_id}` : paper.verified ? paper.key : "");
		const identifierRow = paper.verified
			? `\n<dt>${labels.identifier}</dt><dd>${link(referenceHref(paper), identifier || "&mdash;")}</dd>`
			: `\n<dt>${labels.identifier}</dt><dd>${esc(labels.unverified)}</dd>`;
		const authorsRow = paper.authors.length ? `\n<dt>${labels.authors}</dt><dd>${esc(paper.authors.join("; "))}</dd>` : "";
		const summaryUnit = report.units.find((unit) => unit.kind === "summary" && unit.paper_base === paper.base);
		const questionUnits = report.units.filter((unit) => unit.kind === "detail-per-paper" && unit.paper_base === paper.base);
		const paperUnits = [...(summaryUnit ? [summaryUnit] : []), ...questionUnits];
		const parts: string[] = [];
		if (summaryUnit) {
			parts.push(`<details class="block"><summary>${labels.summary}</summary>\n${unitHtml(summaryUnit)}\n</details>`);
		}
		if (questionUnits.length) {
			parts.push(`<details class="block"><summary>${labels.questionsLabel}</summary>\n${questionUnits
				.map((unit) => `<h4>${esc(unit.question ?? "")}</h4>\n${unitHtml(unit)}`).join("\n")}\n</details>`);
		}
		// Cited chunks explain themselves at the passage, so the trail
		// carries only the uncited leftovers. No cited passages at all (e.g.
		// an ungrounded unit): the trail still appears, honestly, as its own
		// collapsed block.
		const trail = excerptsBlock(paperUnits, true);
		const block = passagesBlock(citedBy(paperUnits), false, trail);
		if (block) parts.push(block);
		else if (trail) parts.push(`<details class="block">${trail.slice("<details>".length)}`);
		const content = parts.length ? parts.join("\n") : `<p class="meta">${esc(labels.noUnits)}</p>`;
		blocks.push(`<section class="paper" id="paper-${esc(paper.base)}">
<h2>${esc(paperTitle)}</h2>
<dl class="meta">${authorsRow}
<dt>${labels.year}</dt><dd>${esc(paper.year ?? "n.d.")}</dd>${identifierRow}
<dt>${labels.localPdf}</dt><dd>${pdfAnchor(localPdfHref(paper.pdf_path), `${paper.base}.pdf`)}</dd>
</dl>
${content}
</section>`);
	}

	// A cross section (cross questions, review) cites several papers: its
	// passages name the paper per line, and a paper-level reference table
	// follows for the bibliographic identity of everything cited.
	const crossParts = (units: ReportUnit[]): string[] => {
		const parts: string[] = [];
		const trail = excerptsBlock(units, true);
		const block = passagesBlock(citedBy(units), true, trail);
		if (block) parts.push(block);
		else if (trail) parts.push(`<details class="block">${trail.slice("<details>".length)}`);
		const refs = referencesBlock(units);
		if (refs) parts.push(refs);
		return parts;
	};

	// Cross-paper detail questions (mode B), with their own passages and
	// references.
	if (crossUnits.length) {
		const parts = [
			...crossUnits.map((unit) => `<h4>${esc(unit.question ?? "")}</h4>\n${unitHtml(unit)}`),
			...crossParts(crossUnits),
		];
		blocks.push(`<section id="cross-questions">
<h2>${labels.crossQuestions}</h2>
${parts.join("\n")}
</section>`);
	}

	// State of the literature (review synthesis), with its own passages and
	// references.
	if (reviewUnits.length) {
		const parts = [...reviewUnits.map((unit) => unitHtml(unit)), ...crossParts(reviewUnits)];
		blocks.push(`<section id="review">
<h2>${labels.review}</h2>
<div class="reviewnote">${esc(labels.reviewNote)}</div>
${parts.join("\n")}
</section>`);
	}

	const banner = report.grounded ? "" : `\n<div class="warnbanner">${esc(labels.ungrounded)}</div>`;

	// Anchor targets (reference rows, passage items) may live inside
	// COLLAPSED details -- open every <details> ancestor when a fragment is
	// navigated, so citation superscripts always land on visible content.
	const anchorScript = `<script>
(function () {
	function openTarget() {
		var id = location.hash.slice(1);
		if (!id) return;
		var el = document.getElementById(id);
		if (!el) return;
		for (var p = el; p; p = p.parentElement) {
			if (p.tagName === "DETAILS") p.open = true;
		}
		el.scrollIntoView();
	}
	addEventListener("hashchange", openTarget);
	openTarget();
})();
</script>`;

	return `<!doctype html>
<html lang="${esc(report.ui_language === "en" ? "en" : "de")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(labels.pageTitle)}: ${esc(report.question)}</title>
<style>${STYLE}${REVIEW_STYLE}${REPORT_STYLE}</style>
</head>
<body>
<h1>${esc(labels.pageTitle)}</h1>${banner}
${blocks.join('\n<hr class="paper">\n')}
<footer>${esc(labels.footer)}</footer>
${anchorScript}
</body>
</html>
`;
}


