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

export interface RenderPayload {
	query: string;
	/** Additional query phrasings searched in the same run (null: single query). */
	query_variants?: string[] | null;
	generated: string;
	sources_used: string[];
	grouping: string[][] | null;
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

function describeFilters(filters: Record<string, unknown> | null): string {
	if (!filters) return "none";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(filters)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value) && !value.length) continue;
		const label = FILTER_LABELS[key] ?? key;
		parts.push(`${label}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
	}
	return parts.length ? parts.join("; ") : "none";
}

function describeGrouping(grouping: string[][] | null): string {
	if (!grouping?.length) return "none (results ungrouped)";
	return grouping.map((terms) => `(${terms.join(" OR ")})`).join(" AND ");
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
 * chat, where the fetch tool downloads after the user confirms the terminal
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
		bar.querySelector(".select-on-target")?.addEventListener("click", () => {
			for (const box of picks()) box.checked = box.closest("tr").classList.contains("on-target");
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

	const fetchable = results.some((record) => fetchIdOf(record));
	const onTargetButton = payload.grouping?.length
		? `<button type="button" class="select-on-target">Select all on_target</button>\n`
		: "";
	const selectBar = results.length && fetchable
		? `\n<div class="selectbar">
<span class="selectcount">0 selected</span>
${onTargetButton}<button type="button" class="select-clear">Clear</button>
<button type="button" class="copy-selection" disabled>Copy download request</button>
<span class="copy-feedback copied"></span>
<span class="hint">Tick papers above, copy the request, then paste it into the Pi chat -- the fetch tool
downloads the PDFs into the papers/ library after you confirm the terminal dialog.</span>
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
<dt>Sources</dt><dd>${esc(payload.sources_used.join(", ")) || "none reachable"}</dd>
<dt>Grouping</dt><dd>${esc(describeGrouping(payload.grouping))}</dd>
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
