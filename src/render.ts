/**
 * Deterministic HTML rendering of a discovery payload (Phase 5).
 *
 * Pure function, no network, no LLM: the page is a typographic view of the
 * emitted JSON and nothing else. Every title, author, year, venue and link
 * on the page comes from the payload; all strings are HTML-escaped, and
 * hrefs are built only from record fields with an http(s) scheme. Plain,
 * scholarly, emoji-free, self-contained (inline CSS and a small inline
 * column-sort script; sorting only reorders already-rendered rows).
 */

import { pathToFileURL } from "node:url";

import { firstAuthorLastName } from "./types.ts";

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
	/** Fields filled by the deterministic identifier lookup: field -> provider. */
	enriched?: Record<string, string>;
	/** Query variants that found this record (multi-query runs only). */
	found_by?: string[];
	/** Journal-level 2-yr mean citedness from OpenAlex (open JIF analog). */
	journal_2yr_citedness?: number | null;
}

import type { ChatReport } from "./synthesis.ts";
import type { CitationSite } from "./protocol.ts";
import { highlightPhrase, type ReportUnit, type SynthesisResult, type SynthReport } from "./synthesis.ts";

// Moved to synthesize.ts in v25 E2b (the snippet is citation provenance);
// re-exported here for existing importers.
export { searchSnippet } from "./synthesis.ts";

export interface RenderPayload {
	query: string;
	/** Additional query phrasings searched in the same run (null: single query). */
	query_variants?: string[] | null;
	generated: string;
	sources_used: string[];
	/** Requested records per source (undefined in pre-v30.13 sidecars). */
	per_source?: number | null;
	/** Sources that errored during the run (v30.1: a failed source must stay
	 * visible after the run; null: none failed). */
	source_failures?: Array<{ source: string; error: string }> | null;
	/** Boolean expression actually sent to arXiv per query (null: arXiv unused). */
	arxiv_queries?: string[] | null;
	grouping: string[][] | null;
	/** on_target needs only this many groups (null: all groups; v30.3). */
	grouping_require?: number | null;
	filters: Record<string, unknown> | null;
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

function link(href: string | null, text: string): string {
	if (href === null) return esc(text);
	return `<a href="${esc(href)}">${esc(text)}</a>`;
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
};

/** Human-readable filter summary; exported since v30.13 -- the digest logs
 * the same dialog inputs as the HTML meta block, from one wording. */
export function describeFilters(filters: Record<string, unknown> | null): string {
	if (!filters) return "none";
	const parts: string[] = [];
	// The pickers' "other journals/sources" and "other authors" rows
	// (v30.11): what such a run actually removes is the LISTED entries that
	// were not selected -- state that, instead of dumping the whole list.
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

/** Grouping expression as shown to the reader; exported since v30.13 (see
 * describeFilters). */
export function describeGrouping(grouping: string[][] | null, require?: number | null): string {
	if (!grouping?.length) return "none (results ungrouped)";
	const expression = grouping.map((terms) => `(${terms.join(" OR ")})`).join(" AND ");
	// The wide variant (v30.3): on_target needs only `require` of the groups.
	if (typeof require === "number" && require < grouping.length) {
		return `at least ${require} of: ${grouping.map((terms) => terms.join(" OR ")).join(" | ")}`;
	}
	return expression;
}

function sourcesOf(record: RenderRecord): string[] {
	return record.sources ?? (record.source ? [record.source] : []);
}

/**
 * DOI column: the DOI linked at doi.org, else the arXiv ID at arxiv.org
 * (preprints have no DOI); a direct PDF link on its own line when the APIs
 * delivered one. An identifier that failed the HTTP trust gate is flagged
 * right here, with the plain-language note from the verifier.
 */
function doiCell(record: RenderRecord): string {
	const parts: string[] = [];
	if (record.doi) parts.push(link(`https://doi.org/${record.doi}`, record.doi));
	else if (record.arxiv_id) parts.push(link(`https://arxiv.org/abs/${record.arxiv_id}`, `arXiv:${record.arxiv_id}`));
	if (record.pdf_url) parts.push(link(safeHref(record.pdf_url), "PDF"));
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
	const abstract = record.abstract
		? `<details><summary>Abstract</summary><p>${esc(record.abstract)}</p></details>`
		: "";
	return `${title}${authors}${abstract}`;
}

/** Column order: # / Article / Year / Journal / Citations / DOI / Data source / Label.
 * Values filled by the enrichment lookup carry an asterisk; a footnote under
 * the table names the provider. The sort key stays the bare value. On
 * multi-query runs the data-source cell also notes which query variants
 * found the record (Q1, Q2, ... as listed in the page header). */
/** The identifier the fetch stage accepts for this record: DOI first, else
 * the arXiv ID in its arXiv:... spelling; empty when the record has neither
 * (then there is nothing to fetch and the row gets no checkbox). */
function fetchIdOf(record: RenderRecord): string {
	if (record.doi) return record.doi;
	if (record.arxiv_id) return `arXiv:${record.arxiv_id}`;
	return "";
}

function resultRow(record: RenderRecord, index: number, queryLabels: Map<string, string>): string {
	const rowClass = record.group === "on_target" ? ' class="on-target"' : "";
	const year = record.year !== null && /^\d{4}$/.test(record.year) ? record.year : "";
	const cites = record.cites === null || record.cites === undefined ? "" : String(record.cites);
	const venueStar = record.enriched?.venue ? "*" : "";
	const citesStar = record.enriched?.cites ? "*" : "";
	const foundBy = queryLabels.size > 1 && record.found_by?.length
		? `<br><span class="note">${esc(record.found_by.map((q) => queryLabels.get(q) ?? q).join(", "))}</span>`
		: "";
	const score = typeof record.journal_2yr_citedness === "number"
		? record.journal_2yr_citedness
		: null;
	// Label sort keys are prefixed so that the FIRST click puts on_target on
	// top (matching the initial page order), not alphabetical "adjacent".
	const groupKey = record.group === "on_target" ? "0_on_target" : record.group ? "1_adjacent" : "";
	const fetchId = fetchIdOf(record);
	const pickBox = fetchId
		? `<input type="checkbox" class="pick" data-id="${esc(fetchId)}" aria-label="Select for PDF download">`
		: "";
	// Sort key of the Authors column: last name of the FIRST author,
	// lowercased -- a header click orders by exactly that.
	const authorKey = firstAuthorLastName(record.authors).toLowerCase();
	const cells = [
		cell("", pickBox, "pickcell"),
		cell(String(index + 1), String(index + 1)),
		cell(record.title.toLowerCase(), articleCell(record), "paper"),
		cell(authorKey, record.authors.length ? esc(record.authors.join("; ")) : "&mdash;", "authorscol"),
		cell(year, esc(record.year ?? "") || "&mdash;"),
		cell(record.venue.toLowerCase(), record.venue ? esc(record.venue) + venueStar : "&mdash;"),
		cell(score === null ? "" : String(score), score === null ? "&mdash;" : score.toFixed(1)),
		cell(cites, cites ? cites + citesStar : "&mdash;"),
		cell((record.doi || record.arxiv_id).toLowerCase(), doiCell(record)),
		cell(sourcesOf(record).join(", "), (esc(sourcesOf(record).join(", ")) || "&mdash;") + foundBy),
		cell(groupKey, record.group ? esc(record.group) : "&mdash;"),
	];
	return `<tr${rowClass}>${cells.join("")}</tr>`;
}

function droppedRow(entry: { reason: string; record: RenderRecord }): string {
	const { record, reason } = entry;
	const year = record.year !== null && /^\d{4}$/.test(record.year) ? record.year : "";
	return `<tr>${[
		cell(record.title.toLowerCase(), articleCell(record, true), "paper"),
		cell(year, esc(record.year ?? "") || "&mdash;"),
		cell((record.doi || record.arxiv_id).toLowerCase(), doiCell(record)),
		cell(reason.toLowerCase(), esc(reason)),
	].join("")}</tr>`;
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
	details p { margin: 0.3rem 0 0; color: #2c2c2c; }
	a { color: #2b4a6f; }
	td.paper { min-width: 18rem; }
	td.authorscol { color: #3d3d3d; max-width: 13rem; }
	td.pickcell { text-align: center; }
	th.no-sort { cursor: default; }
	.selectbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem;
		margin-top: 0.8rem; font-size: 0.84rem;
		position: sticky; bottom: 0; z-index: 5; background: #fdfdfc;
		padding: 0.5rem 0.2rem; border-top: 1px solid #d9d9d4;
		box-shadow: 0 -3px 8px rgba(0, 0, 0, 0.07); }
	.selectbar button { font: inherit; padding: 0.3rem 0.7rem; cursor: pointer;
		background: #f1f1ec; border: 1px solid #c9c9c2; border-radius: 3px; }
	.selectbar button:hover:enabled { background: #e6e6df; }
	.selectbar button:disabled { color: #9a9a94; cursor: default; }
	.selectbar button.copy-selection { background: #2b4a6f; border-color: #223c5b; color: #fff;
		font-weight: 600; }
	.selectbar button.copy-selection:hover:enabled { background: #223c5b; }
	.selectbar button.copy-selection:disabled { background: #f1f1ec; border-color: #c9c9c2;
		color: #9a9a94; font-weight: 400; }
	.selectbar .hint { color: #6b6b6b; font-size: 0.78rem; }
	.selectbar .copied { color: #2e7d43; font-weight: 600; }
	footer { margin: 2.5rem 0 1rem; font-size: 0.78rem; color: #6b6b6b;
		border-top: 1px solid #d9d9d4; padding-top: 0.6rem; }
	@media print { body { max-width: none; } details, .selectbar, td.pickcell, th.no-sort { display: none; } }
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

const RESULT_HEADERS = "<tr><th class=\"no-sort\" title=\"Select rows, then copy the download request below\"></th><th>#</th><th>Article</th><th>Authors</th><th>Year</th><th>Journal</th><th>Journal score&sup1;</th><th>Citations</th><th>DOI</th><th>Data source</th><th>Label</th></tr>";

/**
 * Selection layer: checkboxes feed a ready-made chat sentence ("Download
 * these papers: <id>, <id>, ...") into the clipboard. Pure view logic on
 * identifiers that are already printed on the page -- the page itself can
 * never download (file:// pages have neither filesystem access nor
 * permission to call other servers); the sentence is pasted into the Pi
 * chat, where the selection tool downloads after the user confirms the terminal
 * dialog.
 */
const SELECT_SCRIPT = `
{
	const bar = document.querySelector(".selectbar");
	if (bar) {
		const picks = () => Array.from(document.querySelectorAll("input.pick"));
		const chosen = () => picks().filter((box) => box.checked);
		const countLabel = bar.querySelector(".selectcount");
		const copyButton = bar.querySelector(".copy-selection");
		const feedback = bar.querySelector(".copy-feedback");
		const update = () => {
			const n = chosen().length;
			countLabel.textContent = n + " selected";
			copyButton.disabled = n === 0;
			feedback.textContent = "";
		};
		document.addEventListener("change", (event) => {
			if (event.target instanceof HTMLInputElement && event.target.classList.contains("pick")) update();
		});
		bar.querySelector(".select-all")?.addEventListener("click", () => {
			for (const box of picks()) box.checked = true;
			update();
		});
		bar.querySelector(".select-clear").addEventListener("click", () => {
			for (const box of picks()) box.checked = false;
			update();
		});
		copyButton.addEventListener("click", () => {
			const sentence = "Download these papers: "
				+ chosen().map((box) => box.dataset.id).join(", ");
			const done = () => { feedback.textContent = "Copied. Now paste it into the Pi chat."; };
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
const DROPPED_HEADERS = "<tr><th>Article</th><th>Year</th><th>DOI</th><th>Reason</th></tr>";

/** Render the full discovery payload as a standalone HTML document. */
export function renderHtml(payload: RenderPayload): string {
	const results = payload.results;
	const onTarget = results.filter((r) => r.group === "on_target").length;
	const verifiedCount = results.filter((r) => r.verified).length;
	const groupSummary = payload.grouping?.length
		? ` (${onTarget} on_target, ${results.length - onTarget} adjacent)`
		: "";

	const PROVIDER_LABELS: Record<string, string> = { openalex: "OpenAlex (api.openalex.org)" };
	const enrichedProviders = [...new Set(results.flatMap((r) => Object.values(r.enriched ?? {})))]
		.map((provider) => PROVIDER_LABELS[provider] ?? provider);
	const enrichmentFootnote = enrichedProviders.length
		? `\n<p class="meta">* Value filled in by a deterministic identifier lookup at ${esc(enrichedProviders.join(", "))} because the original search source did not deliver this field (arXiv, for example, carries no citation counts or journal names). Looked up from an open API, never generated; each record's <code>enriched</code> field in the JSON names the filled fields.</p>`
		: "";
	const scoreFootnote = results.some((r) => typeof r.journal_2yr_citedness === "number")
		? `\n<p class="meta">&sup1; Journal score = the journal's 2-year mean citedness from OpenAlex (api.openalex.org): average citations received in the last two years by works the journal published in the two years before. It is the open analog of the proprietary journal impact factor; values are computed over the OpenAlex citation graph and differ somewhat from Clarivate's JIF. It rates the journal, not the paper.</p>`
		: "";

	const variants = payload.query_variants ?? [];
	const queryLabels = new Map(
		[payload.query, ...variants].map((query, index) => [query, `Q${index + 1}`] as const),
	);
	const variantRows = variants.length
		? `\n<dt>Variants</dt>${variants.map((v, i) => `<dd>Q${i + 2}: ${esc(v)}</dd>`).join("")}`
		: "";
	const queryLabel = variants.length ? `Q1: ${payload.query}` : payload.query;
	// Transparency: the boolean expression actually sent to arXiv (v18) --
	// what was asked stays verifiable, same line as grouping and dropped list.
	const arxivQueries = payload.arxiv_queries ?? [];
	const arxivQueryRows = arxivQueries.length
		? `\n<dt>Sent to arXiv</dt>${arxivQueries
			.map((q, i) => `<dd>${arxivQueries.length > 1 ? `Q${i + 1}: ` : ""}${esc(q)}</dd>`)
			.join("")}`
		: "";
	// Honest degradation stays visible (v30.1): a source that errored is
	// listed with its reason -- the results may be incomplete and the page
	// must say so, not just a transient status line during the run.
	const sourceFailures = payload.source_failures ?? [];
	const sourceFailureRows = sourceFailures.length
		? `\n<dt>Failed sources</dt>${sourceFailures
			.map((f) => `<dd>${esc(f.source)}: ${esc(f.error)} (results may be incomplete)</dd>`)
			.join("")}`
		: "";

	const fetchable = results.some((record) => fetchIdOf(record));
	// Plain "Select all" (v30.15 user decision): the earlier on_target-only
	// button was useless on runs without any on_target hit.
	const selectBar = results.length && fetchable
		? `\n<div class="selectbar">
<span class="selectcount">0 selected</span>
<button type="button" class="select-all">Select all</button>
<button type="button" class="select-clear">Clear</button>
<button type="button" class="copy-selection" disabled>Copy download request</button>
<span class="copy-feedback copied"></span>
<span class="hint">Tick papers above, copy the request, then paste it into the Pi chat -- the selection tool
downloads the PDFs into the lit-selection/ library after you confirm the terminal dialog.</span>
</div>`
		: "";

	const resultsTable = results.length
		? `<table class="sortable">
<thead>${RESULT_HEADERS}</thead>
<tbody>
${results.map((record, index) => resultRow(record, index, queryLabels)).join("\n")}
</tbody>
</table>${selectBar}${enrichmentFootnote}${scoreFootnote}`
		: "<p>No results.</p>";

	const droppedSection = payload.dropped.length
		? `<h2>Dropped records (${payload.dropped.length})</h2>
<p class="meta">Removed by the junk filter or by the requested metadata filters. Nothing disappears silently; every exclusion carries its reason.</p>
<table class="sortable">
<thead>${DROPPED_HEADERS}</thead>
<tbody>
${payload.dropped.map(droppedRow).join("\n")}
</tbody>
</table>`
		: "";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Literature Search: ${esc(payload.query)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Literature Search</h1>
<dl class="meta">
<dt>Query</dt><dd>${esc(queryLabel)}</dd>${variantRows}
<dt>Generated</dt><dd>${esc(payload.generated)} (UTC)</dd>
<dt>Sources</dt><dd>${esc(payload.sources_used.join(", ")) || "none reachable"}</dd>${sourceFailureRows}${arxivQueryRows}${
	payload.per_source ? `\n<dt>Records per source</dt><dd>${esc(payload.per_source)}</dd>` : ""}
<dt>Grouping</dt><dd>${esc(describeGrouping(payload.grouping, payload.grouping_require))}</dd>
<dt>Filters</dt><dd>${esc(describeFilters(payload.filters))}</dd>
<dt>Sort</dt><dd>${esc(payload.sort ?? "source order")}</dd>
<dt>Results</dt><dd>${results.length}${groupSummary}; ${verifiedCount}/${results.length} identifiers verified; ${payload.dropped.length} dropped</dd>
</dl>
${resultsTable}
${droppedSection}
<footer>Rendered deterministically from the pi-literature-review JSON payload. Every field on this page
originates from a search-API response; an identifier counts as verified when it resolved via HTTP at
doi.org / arxiv.org. Column sorting only reorders the rows above. No language model produced or
modified any citation data.</footer>
<script>${SORT_SCRIPT}</script>
<script>${SELECT_SCRIPT}</script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * Synthesis review page                                               *
 * ------------------------------------------------------------------ */

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
	/** Override of the DISPLAYED number (v25 single-paper reports number
	 * cited passages, not papers); defaults to the marker's own digits. */
	labelFor?: (site: CitationSite, digits: string) => string;
	/** In-page anchor prefix of the fallback link (default "ref"). */
	anchorPrefix?: string;
}

/** One shared marker renderer per prose unit: replaces [n] markers in an
 * ALREADY-ESCAPED string, consuming the unit's sites in document order. */
function makeMarkerRenderer(cite?: CiteContext): (escaped: string) => string {
	let markerIndex = 0;
	return (escaped) => escaped.replace(/\[(\d+)\]/g, (match, digits: string) => {
		const site = cite?.sites[markerIndex++];
		const label = site && cite?.labelFor ? cite.labelFor(site, digits) : digits;
		const href = site ? cite?.hrefFor(site) : null;
		if (href) {
			return `<sup><a class="cite" href="${esc(href)}" target="_blank" rel="noopener">${label}</a></sup>`;
		}
		return `<a class="cite" href="#${cite?.anchorPrefix ?? "ref"}-${label}">[${label}]</a>`;
	});
}

/** Inline markdown BOLD on an already-escaped string: models habitually
 * write **heading** / **term:** and the literal asterisks read as noise
 * (v27 field finding). Only the double-asterisk pair is interpreted --
 * nothing else in the model's text becomes markup. */
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
 * format, v25) -- a deterministic text transformation; markers keep their
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
 * Deterministic rendering of a SynthesisResult. Same trust boundary as the
 * search page: every value in the reference table originates from verified
 * search records; the model's prose is escaped text whose only live parts
 * are the code-validated citation markers. An ungrounded result renders
 * with an unmissable warning banner instead of being suppressed -- the
 * draft stays inspectable, but nobody can mistake it for a review.
 */
/**
 * Retrieval transparency rows (v24): the disclosed English query variant(s)
 * -- the ONE place an LLM shapes retrieval, citations unaffected -- and the
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

export function renderReviewHtml(result: SynthesisResult): string {
	const banner = result.grounded
		? ""
		: `\n<div class="warnbanner">UNGROUNDED DRAFT -- the model produced no verifiable citations.
Do not use this text as a literature review.</div>`;

	const referenceRows = result.references.map((reference) => {
		const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}` : reference.key);
		return `<tr id="ref-${reference.n}">
<td>[${reference.n}]</td>
<td>${esc(reference.year ?? "")}</td>
<td class="authorscol">${esc(reference.authors.join("; "))}</td>
<td class="paper title">${esc(reference.title || "(title not in the saved search records)")}</td>
<td>${link(referenceHref(reference), id)}</td>
<td>${esc(reference.pages.join(", "))}</td>
</tr>`;
	}).join("\n");

	const referencesSection = result.references.length
		? `<h2>References</h2>
<p class="meta">Inserted by fixed code from HTTP-verified search records; the model only chose excerpt numbers.</p>
<table>
<thead><tr><th>#</th><th>Year</th><th>Authors</th><th>Title</th><th>Identifier</th><th>PDF pages cited</th></tr></thead>
<tbody>
${referenceRows}
</tbody>
</table>`
		: "<h2>References</h2>\n<p>None -- no valid citations survived the gate.</p>";

	const excerptItems = result.chunks.map((chunk) =>
		`<details><summary>[${chunk.id}] ${esc(chunk.title || chunk.paper_key)} -- page ${chunk.page}, similarity ${chunk.score.toFixed(3)}${chunk.lexical ? ", exact term match" : ""}</summary>
<p class="excerpt">${esc(chunk.text)}</p></details>`).join("\n");

	const adoptionReasons = new Map(result.adoption_failures.map((failure) => [failure.file, failure.reason]));
	const exclusions: string[] = [];
	for (const file of result.unmatched_pdfs) {
		exclusions.push(`<dd>${esc(file)} -- ${esc(adoptionReasons.get(file)
			?? "no verified record (not part of any saved search); run a search that covers it")}</dd>`);
	}
	for (const failure of result.extraction_failures) {
		exclusions.push(`<dd>${esc(failure.file)} -- ${esc(failure.reason)}</dd>`);
	}
	const exclusionRows = exclusions.length ? `\n<dt>Excluded</dt>${exclusions.join("")}` : "";
	const adoptedRow = result.adopted_pdfs.length
		? `\n<dt>Adopted</dt><dd>${esc(result.adopted_pdfs.join(", "))} -- identifier found in the PDF text, metadata from a verified API lookup</dd>`
		: "";
	const uncitedRow = result.papers_uncited.length
		? `\n<dt>Retrieved, uncited</dt><dd>${esc(result.papers_uncited.join(", "))}</dd>`
		: "";
	// Clickable superscripts: resolve each marker through its citation site
	// to the cited page of the paper's local PDF (path from the verified
	// library scan, carried on the reference entry).
	const pdfPathByKey = new Map(result.references.map((reference) => [reference.key, reference.pdf_path]));
	const cite = (result.sites ?? []).length
		? {
			sites: result.sites,
			hrefFor: (site: CitationSite): string | null => {
				const path = pdfPathByKey.get(site.paper_key);
				return path ? localPdfHref(path, site.page, site.snippet) : null;
			},
		}
		: undefined;

	const integrity: string[] = [];
	integrity.push(`${result.invalid_markers.length} invalid citation marker(s) stripped`
		+ (result.invalid_markers.length ? ` (${result.invalid_markers.join(" ")})` : ""));
	integrity.push(`${result.unmarked_sentences} sentence(s) without a citation marker`);
	if (result.stripped_reference_section) {
		integrity.push("a model-written reference section was cut (references come from verified records only)");
	}
	if (result.trimmed_chunks) {
		integrity.push(`${result.trimmed_chunks} lowest-ranked excerpt(s) dropped by the context budget`);
	}

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Literature Synthesis: ${esc(result.question)}</title>
<style>${STYLE}${REVIEW_STYLE}</style>
</head>
<body>
<h1>Literature Synthesis</h1>
<dl class="meta">
<dt>Question</dt><dd>${esc(result.question)}</dd>
<dt>Generated</dt><dd>${esc(result.generated)} (UTC)</dd>
</dl>${banner}
<div class="prose">
${proseHtml(result.prose, cite)}
</div>${cite ? `\n${SUP_NOTE}` : ""}
${referencesSection}
<h2>Method &amp; transparency</h2>
<dl class="meta">
<dt>Generator</dt><dd>${esc(result.model)} (${esc(result.backend)})</dd>
<dt>Embeddings</dt><dd>${esc(result.embedding_model)}</dd>
<dt>Retrieval</dt><dd>top ${esc(result.top_k)} excerpts by cosine similarity; ${result.chunks.length} in the prompt</dd>${retrievalMetaRows(result)}
<dt>Corpus</dt><dd>${result.papers_matched} paper(s) with verified metadata; ${result.papers_cited} cited</dd>${uncitedRow}${adoptedRow}${exclusionRows}
<dt>Integrity</dt><dd>${esc(integrity.join("; "))}</dd>
</dl>
<h2>Excerpts given to the model</h2>
<p class="meta">The complete evidence trail: these are the only sources the model saw. Chunk-level citations per reference are in the JSON sidecar next to this file.</p>
${excerptItems || "<p>None.</p>"}
<footer>Rendered deterministically from the pi-literature-review synthesis payload. The language model wrote
the prose and chose excerpt numbers only; every reference on this page was inserted by fixed code from
HTTP-verified search records. Citation markers naming non-existent excerpts were stripped and are reported
above. No language model produced or modified any citation data.</footer>
</body>
</html>
`;
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
		// it the query is split into single words (live finding 2026-07-16:
		// an 8-word snippet lit up countless stray words, even bare letters).
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
	// PDF links open in a new tab (user decision 2026-07-16): the report
	// stays open next to the paper.
	const pdfAnchor = (href: string, text: string): string =>
		`<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
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
		// Rounds recorded since v25 carry per-marker citation sites -- their
		// markers then link into the PDF exactly like the summary's (field
		// wish 2026-07-22: dead round answers annoyed). The count guard keeps
		// a hand-edited or legacy round from misaligning marker and site;
		// such rounds fall back to plain text, honestly.
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
Superscript markers open the cited PDF page; rounds recorded before v25 keep their bracketed numbers as plain text.</p>
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
 * Composable report page (v25 E2d)                                    *
 * ------------------------------------------------------------------ */

/** Page chrome per uiLanguage; "de" is the default (user decision: the
 * report audience reads German -- "Excerpts" was not understood). */
const REPORT_LABELS = {
	de: {
		pageTitle: "Literaturbericht",
		generated: "Erstellt",
		scopeLibrary: "gesamte Bibliothek",
		questionsLabel: "Fragen",
		toc: "Inhalt",
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
		toc: "Contents",
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
	/* v31.7: the truncated passage line IS the expander -- no default
	 * disclosure triangle, a dim "more"/"less" hint at the line end, and
	 * while OPEN the truncated span disappears (the full excerpt below
	 * replaces it instead of repeating it). */
	ol.passages details.passage { display: inline; }
	/* The preview text matches the EXPANDED excerpt (same grey, same size,
	 * v31.7 user wish) -- only the more/less hint keeps the accent color. */
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
 * Deterministic rendering of the composable report (v25). Layout follows
 * the 2026-07-22 field feedback: answers live up top inside each paper's
 * section, method & transparency sits right under the head metadata, and
 * SINGLE-paper reports number the cited PASSAGES (a reference table naming
 * the one paper the reader is asking about carries no information) --
 * multi-paper reports keep scholarly paper-level numbering.
 */
export function renderSynthReportHtml(report: SynthReport): string {
	const labels = REPORT_LABELS[report.ui_language === "en" ? "en" : "de"];
	const singleMode = report.papers.length === 1;
	const pdfPathByKey = new Map(report.papers.map((paper) => [paper.key, paper.pdf_path]));
	const pdfAnchor = (href: string, text: string): string =>
		`<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

	// Single-paper mode: number distinct cited passages across all units in
	// first-citation order (identity: paper, page, chunk text). Each passage
	// remembers WHERE it came from (v31.6 user wish: the retrieval detail
	// belongs at the passage): per citing unit its retrieval rank and score
	// -- chunk ids are assigned in score order, so the id IS the rank.
	const passageOfSite = new Map<CitationSite, number>();
	const passages: Array<{
		n: number; page: number; text: string; snippet: string | null; paper_key: string;
		origins: Array<{ unit: string; rank: number; of: number; score: number; lexical: boolean }>;
	}> = [];
	// Identity keys of all CITED chunks -- the advanced rest block below
	// shows only what was retrieved and NOT cited.
	const citedChunkKeys = new Set<string>();
	if (singleMode) {
		const byKey = new Map<string, number>();
		for (const unit of report.units) {
			for (const site of unit.sites) {
				const chunk = unit.chunks.find((entry) => entry.id === site.chunk_id);
				const key = `${site.paper_key}\u0000${site.page}\u0000${chunk?.text ?? site.snippet ?? ""}`;
				citedChunkKeys.add(key);
				let n = byKey.get(key);
				if (n === undefined) {
					n = passages.length + 1;
					byKey.set(key, n);
					passages.push({
						n, page: site.page, text: chunk?.text ?? "", snippet: site.snippet,
						paper_key: site.paper_key, origins: [],
					});
				}
				passageOfSite.set(site, n);
				if (chunk) {
					const origin = {
						unit: unitLabel(unit, labels),
						rank: chunk.id,
						of: unit.chunks.length,
						score: chunk.score,
						lexical: chunk.lexical === true,
					};
					const origins = passages[n - 1].origins;
					if (!origins.some((seen) => seen.unit === origin.unit && seen.rank === origin.rank)) {
						origins.push(origin);
					}
				}
			}
		}
	}

	const citeOf = (unit: ReportUnit): CiteContext | undefined => (unit.sites.length
		? {
			sites: unit.sites,
			hrefFor: (site) => {
				const path = pdfPathByKey.get(site.paper_key);
				return path ? localPdfHref(path, site.page, site.snippet) : null;
			},
			...(singleMode
				? {
					labelFor: (site: CitationSite, digits: string) => String(passageOfSite.get(site) ?? digits),
					anchorPrefix: "site",
				}
				: {}),
		}
		: undefined);

	// EVERY unit renders through the bullet-aware transformer: models write
	// "- "/"* " lists in ANSWERS too, and proseHtml kept the asterisks
	// literal (v27 field finding). bulletsHtml is a superset -- plain
	// paragraphs pass through unchanged.
	const unitHtml = (unit: ReportUnit): string =>
		`<div class="prose">\n${bulletsHtml(unit.prose, citeOf(unit))}\n</div>`;

	// ---- Numbered sections following the v27 user template: Contents ->
	// Query metadata -> one section per document (N.1 Summary, N.2
	// Questions) -> cross questions -> state of the literature ->
	// references/passages -> source excerpts. Technical transparency lives
	// in a collapsed block with plain-language explanations (field wish:
	// "Retrieval/Lexical layer/Integrity" meant nothing to a lay reader).
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

	// ---- Layout (v27 user decision, second iteration): NO table of
	// contents, NO section numbers. Query metadata first, then one block
	// per document -- title + metadata open, Summary / Questions /
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

	// Per-block reference table: only the entries the given units cite,
	// keeping their GLOBAL [n] numbers. Anchor ids stay unique across the
	// page (first occurrence wins -- marker fallback links land there).
	// v31.5 (user decision): the retrieval excerpts are no longer their own
	// top-level block -- they ride collapsed at the END of this block as an
	// "advanced" sub-details (the user reads the cited passages; similarity
	// scores are for the curious).
	const usedRefIds = new Set<number>();
	const referencesBlock = (units: ReportUnit[], trail: string | null): string | null => {
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
</table>${trail ? `\n${trail}` : ""}
</details>`;
	};

	// Per-block evidence trail (the excerpts each unit's model saw) --
	// since v31.5 a NESTED details at the end of the cited-passages block.
	// v31.6 (single mode): the CITED chunks carry their retrieval detail at
	// the passage itself, so the trail here shows only what was retrieved
	// and NOT cited (onlyUncited) -- together they stay the complete trail.
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
		// Single mode: cited chunks explain themselves at the passage
		// (v31.6), so the trail carries only the uncited leftovers.
		const trail = excerptsBlock(paperUnits, singleMode);
		let trailPlaced = false;
		if (singleMode) {
			// Single paper: the numbered passages replace the reference table.
			// The truncated line itself is the expander (v31.7 user wish: no
			// duplicated first sentence): a "more" hint at its end opens the
			// FULL excerpt -- CSS hides the truncated span while open -- plus,
			// per citing question, the retrieval rank and similarity.
			const items = passages.map((passage) => {
				const href = localPdfHref(paper.pdf_path, passage.page, passage.snippet);
				const excerpt = passage.text.length > 160 ? `${passage.text.slice(0, 160)}...` : passage.text;
				const originLines = passage.origins
					.map((origin) => `<br>${esc(labels.retrievedAs(origin.unit, origin.rank, origin.of, origin.score.toFixed(3), origin.lexical))}`)
					.join("");
				if (!passage.origins.length && !passage.text) {
					return `<li id="site-${passage.n}">${pdfAnchor(href, `${labels.page} ${passage.page}`)} -- ${esc(excerpt)}</li>`;
				}
				return `<li id="site-${passage.n}"><details class="passage"><summary>${pdfAnchor(href, `${labels.page} ${passage.page}`)} -- <span class="short">${esc(excerpt)}</span> <span class="expandhint"><span class="hint-more">${labels.expandMore}</span><span class="hint-less">${labels.expandLess}</span></span></summary>
<p class="excerpt">${esc(passage.text)}</p>${originLines ? `\n<p class="meta">${originLines.slice("<br>".length)}</p>` : ""}
</details></li>`;
			}).join("\n");
			if (items) {
				parts.push(`<details class="block"><summary>${labels.passages}</summary>
<p class="meta">${esc(labels.passagesNote)}</p>
<ol class="passages">
${items}
</ol>${trail ? `\n${trail}` : ""}
</details>`);
				trailPlaced = true;
			}
		} else {
			const refs = referencesBlock(paperUnits, trail);
			if (refs) {
				parts.push(refs);
				trailPlaced = true;
			}
		}
		// No cited passages at all (e.g. an ungrounded unit): the trail
		// still appears, honestly, as its own collapsed block.
		if (trail && !trailPlaced) parts.push(`<details class="block">${trail.slice("<details>".length)}`);
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

	// Cross-paper detail questions (mode B), with their own references.
	if (crossUnits.length) {
		const parts = crossUnits.map((unit) => `<h4>${esc(unit.question ?? "")}</h4>\n${unitHtml(unit)}`);
		const trail = excerptsBlock(crossUnits);
		const refs = singleMode ? null : referencesBlock(crossUnits, trail);
		if (refs) parts.push(refs);
		else if (trail) parts.push(`<details class="block">${trail.slice("<details>".length)}`);
		blocks.push(`<section id="cross-questions">
<h2>${labels.crossQuestions}</h2>
${parts.join("\n")}
</section>`);
	}

	// State of the literature (review synthesis), with its own references.
	if (reviewUnits.length) {
		const parts = reviewUnits.map((unit) => unitHtml(unit));
		const trail = excerptsBlock(reviewUnits);
		const refs = singleMode ? null : referencesBlock(reviewUnits, trail);
		if (refs) parts.push(refs);
		else if (trail) parts.push(`<details class="block">${trail.slice("<details>".length)}`);
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


