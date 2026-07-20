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

import type { ChatReport } from "./chat.ts";
import type { SynthesisResult } from "./synthesize.ts";

export interface RenderPayload {
	query: string;
	/** Additional query phrasings searched in the same run (null: single query). */
	query_variants?: string[] | null;
	generated: string;
	sources_used: string[];
	/** Boolean expression actually sent to arXiv per query (null: arXiv unused). */
	arxiv_queries?: string[] | null;
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
	// Transparency: the boolean expression actually sent to arXiv (v18) --
	// what was asked stays verifiable, same line as grouping and dropped list.
	const arxivQueries = payload.arxiv_queries ?? [];
	const arxivQueryRows = arxivQueries.length
		? `\n<dt>Sent to arXiv</dt>${arxivQueries
			.map((q, i) => `<dd>${arxivQueries.length > 1 ? `Q${i + 1}: ` : ""}${esc(q)}</dd>`)
			.join("")}`
		: "";

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
<dt>Sources</dt><dd>${esc(payload.sources_used.join(", ")) || "none reachable"}</dd>${arxivQueryRows}
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
 * gate -- no other model text is interpreted as markup. */
function proseHtml(prose: string): string {
	return prose
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map((paragraph) => {
			const withLinks = esc(paragraph)
				.replaceAll("\n", "<br>")
				.replace(/\[(\d+)\]/g, '<a class="cite" href="#ref-$1">[$1]</a>');
			return `<p>${withLinks}</p>`;
		})
		.join("\n");
}

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
		`<details><summary>[${chunk.id}] ${esc(chunk.title || chunk.paper_key)} -- page ${chunk.page}, similarity ${chunk.score.toFixed(3)}</summary>
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
${proseHtml(result.prose)}
</div>
${referencesSection}
<h2>Method &amp; transparency</h2>
<dl class="meta">
<dt>Generator</dt><dd>${esc(result.model)} (${esc(result.backend)})</dd>
<dt>Embeddings</dt><dd>${esc(result.embedding_model)}</dd>
<dt>Retrieval</dt><dd>top ${esc(result.top_k)} excerpts by cosine similarity; ${result.chunks.length} in the prompt</dd>
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
 * Deterministic search phrase for the #search fragment: the first run of
 * at least 3 CONSECUTIVE words containing only letters/digits (capped at
 * 5). Phrase search matches the text layer verbatim, so a single comma
 * inside the snippet -- or a word we trimmed punctuation from -- would
 * kill the match (live finding 2026-07-16); shorter also means fewer
 * line-break crossings. Null when no such run exists or it is too short
 * to be distinctive -- the #page anchor alone is then the honest offer.
 */
export function searchSnippet(text: string): string | null {
	const words = text.replace(/\[\d+\]/g, " ").split(/\s+/).filter(Boolean);
	let run: string[] = [];
	for (const word of words) {
		if (/^[\p{L}\p{N}]+$/u.test(word)) {
			run.push(word);
			if (run.length === 5) break;
		} else if (run.length >= 3) {
			break; // first usable run wins -- deterministic
		} else {
			run = [];
		}
	}
	const snippet = run.join(" ");
	return run.length >= 3 && snippet.length >= 15 ? snippet : null;
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
		const href = localPdfHref(paper.pdf_path, chunk.page, searchSnippet(chunk.text));
		return `<details><summary>[${chunk.id}] page ${chunk.page}, similarity ${chunk.score.toFixed(3)}</summary>
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
		return `<div class="round">
<p class="roundmeta">Round ${i + 1} -- ${esc(round.asked)} (UTC), ${esc(round.model)}${state}</p>
<p class="question">${esc(round.question)}</p>
<p class="answer">${esc(round.prose)}</p>
${cited}</div>`;
	}).join("\n");
	const protocolSection = report.rounds.length
		? `<h2>Chat protocol</h2>
<p class="meta">The code-validated rounds of this session (from ${esc(report.protocol_files.map((file) => file.split("/").pop() ?? file).join(", "))}).
Bracketed numbers inside the answers refer to each round's own excerpts and are left as plain text here.</p>
${roundBlocks}`
		: "";

	const adoptedRow = report.adopted_pdfs.length
		? `\n<dt>Adopted</dt><dd>${esc(report.adopted_pdfs.join(", "))} -- identifier found in the PDF text, metadata from a verified API lookup</dd>`
		: "";
	const failureRows = report.extraction_failures.length
		? `\n<dt>Extraction</dt><dd>${esc(report.extraction_failures.map((f) => `${f.file}: ${f.reason}`).join("; "))}</dd>`
		: "";
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
${proseHtml(report.prose)}
</div>
${referencesSection}
<h2>Method &amp; transparency</h2>
<dl class="meta">
<dt>Generator</dt><dd>${esc(report.model)} (${esc(report.backend)})</dd>
<dt>Embeddings</dt><dd>${esc(report.embedding_model)}</dd>
<dt>Retrieval</dt><dd>union of the best excerpts per session question; ${report.chunks.length} in the prompt</dd>${adoptedRow}${failureRows}
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
