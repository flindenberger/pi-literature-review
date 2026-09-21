/**
 * Logic tests for the deterministic HTML renderer (no network). The payload
 * below is a synthetic fixture for exercising escaping, linking and layout
 * rules -- its records are never shown to a user as papers.
 *
 * Run: node src/render.test.ts
 */

import assert from "node:assert/strict";
import { type ChatReport, searchSnippet, type SynthReport } from "./synthesis.ts";
import {
	bibtexEntry,
	codeLinkLabel,
	filterExclusionBreakdown,
	localPdfHref,
	renderHtml,
	renderPaperChatReportHtml,
	renderSynthReportHtml,
	type RenderPayload,
} from "./render.ts";

const payload: RenderPayload = {
	query: 'sandbars & "Sentinel" <test>',
	generated: "2026-07-09T12:00:00Z",
	sources_used: ["arxiv", "crossref", "openalex"],
	grouping: [["river", "fluvial"], ["sandbar"]],
	filters: { yearFrom: 2016, venues: ["Remote Sensing"] },
	sort: "cites",
	results: [
		{
			title: "River sandbar dynamics <script>alert(1)</script>",
			authors: ["A. Author", "B. Author"],
			year: "2021",
			venue: "Remote Sensing",
			doi: "10.1234/abc",
			arxiv_id: "",
			pdf_url: "https://example.org/paper.pdf",
			url: "https://doi.org/10.1234/abc",
			cites: 12,
			abstract: "Fluvial sandbar study.",
			sources: ["crossref", "openalex"],
			verified: true,
			verify_note: "",
			group: "on_target",
			group_matched: { query: 2, terms: ["sandbar", "river"] },
			journal_2yr_citedness: 4.422208,
		},
		{
			title: "Preprint without DOI",
			authors: ["C. Author"],
			year: "2024",
			venue: "Filled Venue",
			doi: "",
			arxiv_id: "2401.16393v1",
			pdf_url: "javascript:alert(1)",
			url: "javascript:alert(1)",
			cites: 3,
			abstract: "",
			sources: ["arxiv"],
			verified: false,
			verify_note: "arxiv.org answered HTTP 404",
			group: "adjacent",
			enriched: { cites: "openalex", venue: "openalex" },
		},
	],
	dropped: [
		{
			reason: "empty author list",
			record: {
				title: "Component junk",
				authors: [],
				year: "1983",
				venue: "",
				doi: "10.9/junk",
				arxiv_id: "",
				pdf_url: "",
				url: "https://doi.org/10.9/junk",
				cites: 0,
				abstract: "",
				source: "crossref",
			},
		},
	],
};

const html = renderHtml(payload);

// document shell: standalone, titled after the query, emoji-free inputs escaped
{
	assert.ok(html.startsWith("<!doctype html>"));
	assert.ok(html.includes("<title>Literature Search: sandbars &amp; &quot;Sentinel&quot; &lt;test&gt;</title>"));
}

// escaping: hostile title never reaches the page unescaped
{
	assert.ok(!html.includes("<script>alert(1)"));
	assert.ok(html.includes("River sandbar dynamics &lt;script&gt;alert(1)&lt;/script&gt;"));
}

// links: http(s) URLs are linked; javascript: URLs are rendered as text only
{
	assert.ok(html.includes('<a href="https://doi.org/10.1234/abc" target="_blank" rel="noopener">10.1234/abc</a>'));
	assert.ok(html.includes('<a href="https://example.org/paper.pdf" target="_blank" rel="noopener">PDF</a>'));
	assert.ok(!html.includes('href="javascript:'));
}

// DOI column: arXiv ID fallback for preprints; failed trust gate is flagged
{
	assert.ok(html.includes('<a href="https://arxiv.org/abs/2401.16393v1" target="_blank" rel="noopener">arXiv:2401.16393v1</a>'));
	assert.ok(html.includes('<span class="unverified">did not verify</span>'));
	assert.ok(html.includes("arxiv.org answered HTTP 404"));
}

// header block: grouping rules, filters, sort and counts are echoed
{
	assert.ok(html.includes("(river OR fluvial) AND (sandbar)"));
	assert.ok(html.includes("year from: 2016; venues: Remote Sensing"));
	assert.ok(html.includes("2 (1 on_target, 1 adjacent); 1/2 identifiers verified; 1 dropped"));
}

// v30.11: a run with the picker's "other journals/sources" row states what
// it EXCLUDES (the unselected listed journals), not the whole listed head
{
	const withOther = renderHtml({
		...payload,
		filters: {
			venues: ["Remote Sensing"], venuesOther: true,
			venuesListed: ["Remote Sensing", "Water", "Sensors"],
		},
	});
	assert.ok(withOther.includes("journals excluded: Water, Sensors (all other journals kept)"));
	assert.ok(!withOther.includes("venuesListed"));
	// Everything selected is honestly "no filter left".
	const allPicked = renderHtml({
		...payload,
		filters: {
			venues: ["Remote Sensing", "Water"], venuesOther: true,
			venuesListed: ["Remote Sensing", "Water"],
		},
	});
	assert.ok(allPicked.includes("journals: all kept"));
	// The author picker reports the same way.
	const withAuthors = renderHtml({
		...payload,
		filters: {
			authors: ["Claudia Kuenzer"], authorsOther: true,
			authorsListed: ["Claudia Kuenzer", "Xiao Xiang Zhu"],
		},
	});
	assert.ok(withAuthors.includes("authors excluded: Xiao Xiang Zhu (all other authors kept)"));
	assert.ok(!withAuthors.includes("authorsListed"));
}

// table: expected column order, sortable markup, on_target highlighting
{
	// The fixture has no code_url anywhere, so the Code column is absent
	// -- the with-code header order is pinned in the code
	// column block below.
	assert.ok(html.includes("</th><th>#</th><th>Article</th><th>Authors</th><th>Year</th><th>Journal</th><th>Journal score&sup1;</th><th>Citations</th><th>DOI</th><th class=\"no-sort\">BibTeX</th><th>Data source</th><th>Label</th>"));
	assert.ok(html.includes('<th class="no-sort"')); // checkbox column is not sortable
	assert.ok(html.includes('<table class="sortable records">'));
	// Both tables share one fixed colgroup, so results and dropped columns
	// align perfectly.
	assert.equal(html.split("<colgroup>").length - 1, 2);
	assert.ok(html.includes("table.records { table-layout: fixed; }"));
	// The search page runs wide; synthesis pages keep 78rem.
	assert.ok(html.includes("body { max-width: 120rem; }"));
	// The results table has its own counted heading.
	assert.ok(html.includes(`<h2>Query results (${payload.results.length})</h2>`));
	assert.ok(html.includes('<tr class="on-target">'));
	assert.ok(html.includes('data-sort="12"'));
	assert.ok(html.includes("<details><summary>Abstract</summary><p>Fluvial sandbar study.</p></details>"));
}

// enrichment: filled values carry an asterisk; footnote names the provider
{
	assert.ok(html.includes("Filled Venue*"));
	assert.ok(html.includes(">3*<") || html.includes("3*</td>"));
	assert.ok(html.includes("OpenAlex (api.openalex.org)"));
	assert.ok(html.includes('data-sort="3"')); // sort key stays the bare value
	// A looked-up abstract stars its summary too.
	const enrichedAbstract = renderHtml({
		...payload,
		results: [{
			...payload.results[0],
			abstract: "Looked-up text.",
			enriched: { abstract: "openalex" },
		}],
		dropped: [],
	});
	assert.ok(enrichedAbstract.includes("<summary>Abstract*</summary>"));
	assert.ok(html.includes("<summary>Abstract</summary>")); // own abstracts stay unstarred
}

// code column: GitHub link plus the heuristic footnote; a page
// without any code_url drops the WHOLE column and its footnote
// (an all-dash column with an unexplained &sup2; would be noise)
{
	const withCode = renderHtml({
		...payload,
		results: [{ ...payload.results[0], code_url: "https://github.com/acme/sandbar-net" }],
		dropped: [],
	});
	assert.ok(withCode.includes('<a href="https://github.com/acme/sandbar-net" target="_blank" rel="noopener">GitHub</a>'));
	assert.ok(withCode.includes("<th>Code&sup2;</th>"));
	assert.ok(withCode.includes("&sup2; Code = "));
	assert.ok(!html.includes("<th>Code&sup2;</th>")); // no code link anywhere -> no column
	assert.ok(!html.includes("&sup2; Code = "));
	// Dropped records carry code links too (the engine
	// passes them through the lookup at lowest cap priority): a link on a
	// dropped row alone brings the column AND the footnote to BOTH tables.
	const droppedCode = renderHtml({
		...payload,
		results: [payload.results[0]],
		dropped: [{
			reason: "year out of range",
			record: { ...payload.results[1], code_url: "https://github.com/acme/dropped-net" },
		}],
	});
	assert.ok(droppedCode.includes('<a href="https://github.com/acme/dropped-net" target="_blank" rel="noopener">GitHub</a>'));
	assert.equal(droppedCode.split("<th>Code&sup2;</th>").length - 1, 2);
	assert.ok(droppedCode.includes("&sup2; Code = "));
	// The footnote discloses the field-measured guards (2026-09-02).
	assert.ok(withCode.includes("created more than a year after the paper are skipped"));
	assert.ok(withCode.includes("owner's name matches an author"));
}

// code cell label follows the link's host (2026-09-02: the abstract may
// name repositories beyond GitHub); unknown hosts get a generic label,
// old GitHub-only sidecars render unchanged (pinned above).
{
	assert.equal(codeLinkLabel("https://github.com/a/b"), "GitHub");
	assert.equal(codeLinkLabel("https://www.gitlab.com/a/b"), "GitLab");
	assert.equal(codeLinkLabel("https://zenodo.org/records/123"), "Zenodo");
	assert.equal(codeLinkLabel("https://huggingface.co/a/b"), "Hugging Face");
	assert.equal(codeLinkLabel("https://example.org/a/b"), "Code");
	const gitlabCode = renderHtml({
		...payload,
		results: [{ ...payload.results[0], code_url: "https://gitlab.com/acme/river-net" }],
		dropped: [],
	});
	assert.ok(gitlabCode.includes('<a href="https://gitlab.com/acme/river-net" target="_blank" rel="noopener">GitLab</a>'));
}

// network column: opt-in via renderHtml options -- callers set
// it exactly when they also write the network.html sidecar page, so the
// relative link can never dangle; plain renders (old sidecars) stay free of
// the column. DOI-carrying records link with doi AND title (title = the
// fallback seed, arXiv DataCite DOIs are not in OpenAlex); identifiers are
// URL-encoded, the parameter separator is entity-escaped in the attribute.
{
	const withNetwork = renderHtml(payload, { network: true });
	// Both tables carry the header (results + dropped).
	assert.equal(withNetwork.split('<th class="no-sort">Network</th>').length - 1, 2);
	assert.ok(withNetwork.includes('href="network.html#doi=10.1234%2Fabc&amp;title=River%20sandbar%20dynamics'));
	// Styled like the BibTeX button, but as an anchor.
	assert.ok(withNetwork.includes('<a class="graph-link"'));
	assert.ok(withNetwork.includes(".graph-link {"));
	// The arXiv-only record has no DOI -> title-only seed.
	assert.ok(withNetwork.includes('href="network.html#title=Preprint%20without%20DOI"'));
	assert.ok(withNetwork.includes("Network = opens a citation-context graph"));
	// Without the flag: no column, no link, no footnote (byte-identical
	// legacy rendering).
	assert.ok(!html.includes("Network</th>"));
	assert.ok(!html.includes("network.html#"));
	assert.ok(!html.includes("Network = opens"));
	// The four colgroup variants (code x network) all pass the loud
	// width/header consistency check.
	renderHtml({
		...payload,
		results: [{ ...payload.results[0], code_url: "https://github.com/acme/sandbar-net" }],
		dropped: [],
	}, { network: true });
}

// journal-score footnote (&sup1;): the score COLUMN always exists, so its
// header mark always carries the explanation -- even when no record has a
// score (enrich:false / preprint-only runs; the
// gated footnote left an unexplained superscript, the defect class the
// code column had already fixed)
{
	const noScores = renderHtml({
		...payload,
		results: [payload.results[1]],
		dropped: [],
	});
	assert.ok(noScores.includes("Journal score&sup1;"));
	assert.ok(noScores.includes("&sup1; Journal score = "));
}

// query variants: header lists Q1/Q2, data-source cell notes which found it
{
	const multi = renderHtml({
		...payload,
		query_variants: ["water body mapping Sentinel-2"],
		results: [{ ...payload.results[0], found_by: ["water body mapping Sentinel-2"] }],
		dropped: [],
	});
	assert.ok(multi.includes("Q1: sandbars &amp; &quot;Sentinel&quot; &lt;test&gt;"));
	assert.ok(multi.includes("<dt>Variants</dt><dd>Q2: water body mapping Sentinel-2</dd>"));
	assert.ok(multi.includes('<span class="note">Q2</span>'));
	assert.ok(!html.includes("<dt>Variants</dt>")); // single-query page stays clean
}

// arXiv transparency row: the expression actually sent to arXiv, per query
{
	const single = renderHtml({
		...payload,
		arxiv_queries: ['all:"sentinel 2" AND all:sandbar AND all:detection'],
	});
	assert.ok(
		single.includes(
			"<dt>Sent to arXiv</dt><dd>all:&quot;sentinel 2&quot; AND all:sandbar AND all:detection</dd>",
		),
	);
	const multi = renderHtml({
		...payload,
		arxiv_queries: ["all:river AND all:sandbar", "all:fluvial AND all:sandbar"],
	});
	assert.ok(multi.includes("<dd>Q1: all:river AND all:sandbar</dd>"));
	assert.ok(multi.includes("<dd>Q2: all:fluvial AND all:sandbar</dd>"));
	// The row alone read as "only arXiv was searched" in the field
	// -- the closing note names the other sources' plain-text
	// treatment, on single- and multi-query runs alike.
	assert.ok(single.includes("CrossRef and OpenAlex received the query text unchanged"));
	assert.ok(multi.includes("CrossRef and OpenAlex received the query text unchanged"));
	assert.ok(!html.includes("Sent to arXiv")); // no arXiv in the run, no row
	assert.ok(!html.includes("received the query text unchanged")); // note rides with the row
}

// Per-source transparency + per-query grouping
{
	const blockRun = renderHtml({
		...payload,
		query_variants: ["(cnn OR deep learning) AND (river)"],
		arxiv_queries: ["all:water AND all:mask", "(all:cnn OR all:\"deep learning\") AND all:river"],
		openalex_queries: ["water AND mask", "(cnn OR \"deep learning\") AND river"],
		crossref_queries: ["water mask", "cnn deep learning river"],
		semanticscholar_queries: ["+water +mask", '+(cnn | "deep learning") +river'],
		grouping_by_query: [
			{ query: "water mask", groups: [["water"], ["mask"]] },
			{ query: "(cnn OR deep learning) AND (river)", groups: [["cnn", "deep learning"], ["river"]] },
		],
	});
	assert.ok(blockRun.includes("<dt>Sent to OpenAlex</dt>"));
	assert.ok(blockRun.includes("<dd>Q2: (cnn OR &quot;deep learning&quot;) AND river</dd>"));
	assert.ok(blockRun.includes("<dt>Sent to CrossRef</dt>"));
	assert.ok(blockRun.includes("CrossRef offers no boolean search"));
	// Both Sent-to notes disclose the record-type filter.
	assert.ok(blockRun.includes("A type filter requests scholarly works only"));
	assert.ok(blockRun.includes("A type filter keeps peer-review reports and author replies"));
	// 4th source: the bulk boolean expression per query plus
	// the citation-sort disclosure.
	assert.ok(blockRun.includes("<dt>Sent to Semantic Scholar</dt>"));
	assert.ok(blockRun.includes("<dd>Q2: +(cnn | &quot;deep learning&quot;) +river</dd>"));
	assert.ok(blockRun.includes("sorted by citation count"));
	// PRISMA-S section: the per-database rows live
	// in a COLLAPSED details block at the end of the meta block, not in
	// the skim path; the main dl no longer carries them.
	assert.ok(blockRun.includes('<details class="prisma"><summary>Search documentation</summary>'));
	const mainMeta = blockRun.slice(0, blockRun.indexOf('<details class="prisma">'));
	assert.ok(!mainMeta.includes("Sent to arXiv"));
	assert.ok(!mainMeta.includes("<dt>Targeting</dt>"));
	// Per-query grouping rows replace the single line.
	assert.ok(blockRun.includes("<dd>Q1: (water) AND (mask)</dd>"));
	assert.ok(blockRun.includes("<dd>Q2: (cnn OR deep learning) AND (river)</dd>"));
	// The legacy "unchanged" note is for OLD sidecars only -- with the
	// per-source rows present it would contradict them.
	assert.ok(!blockRun.includes("received the query text unchanged"));
}

// PRISMA counts and flow: raw per-source×query hits and the
// selection chain render inside the collapsed section; old sidecars
// without the fields keep the section with strategies/grouping only.
{
	const withFlow = renderHtml({
		...payload,
		query_variants: ["water body mapping"],
		source_counts: [
			{ source: "arxiv", query: 'sandbars & "Sentinel" <test>', count: 3 },
			{ source: "arxiv", query: "water body mapping", count: 2 },
			{ source: "crossref", query: 'sandbars & "Sentinel" <test>', count: 5 },
		],
		flow: {
			identified: 10, junk_removed: 2, duplicates_removed: 3,
			screened: 5, excluded_by_filters: 3, included: 2,
		},
	});
	assert.ok(withFlow.includes("<dt>Records identified</dt>"));
	assert.ok(withFlow.includes("<dd>Q1 arxiv: 3</dd>"));
	assert.ok(withFlow.includes("<dd>Q2 arxiv: 2</dd>"));
	assert.ok(withFlow.includes("raw hits per source and query, before deduplication and filtering."));
	// The chain ends "remaining / dropped" -- the records are pipeline
	// survivors awaiting the human's pick, not PRISMA-"included".
	// It sits in the ALWAYS-VISIBLE head block, REPLACES the Results line
	// there (same numbers twice) and ends with the label/verification
	// summary; the collapsed section no longer repeats it. A sidecar
	// without the abstract-gate field renders the chain without that step.
	const flowHead = withFlow.slice(0, withFlow.indexOf('<details class="prisma">'));
	assert.ok(flowHead.includes(
		"<dt>Screening flow</dt><dd>10 record(s) identified &rarr; 2 removed as uncitable (no title or no authors) &rarr; "
		+ "3 duplicate(s) merged &rarr; 5 screened &rarr; 3 excluded by the user filters "
		+ "&rarr; 2 record(s) remaining (1 on_target, 1 adjacent; 1/2 verified), 1 dropped</dd>"));
	// A dim note right under the chain: both tables stay selectable.
	assert.ok(flowHead.includes("Papers of both tables (results and dropped) can still be selected and downloaded."));
	assert.ok(!flowHead.includes("<dt>Results</dt>"));
	// (the SVG's aria-label still says "Screening flow diagram" -- only the
	// chain row itself must not repeat inside the section)
	assert.ok(!withFlow.slice(withFlow.indexOf('<details class="prisma">')).includes("<dt>Screening flow</dt>"));
	assert.ok(!withFlow.includes("row(s) of the dropped table"));
	// With the abstract gate the chain carries its step.
	const withGate = renderHtml({
		...payload,
		flow: {
			identified: 10, junk_removed: 2, duplicates_removed: 3,
			screened: 5, no_abstract_removed: 1, excluded_by_filters: 2, included: 2,
		},
	});
	assert.ok(withGate.includes("5 screened &rarr; 1 removed without abstract &rarr; 2 excluded"));
	// Single-query runs drop the Q labels on the identified rows.
	const singleQuery = renderHtml({
		...payload,
		source_counts: [{ source: "openalex", query: payload.query, count: 4 }],
	});
	assert.ok(singleQuery.includes("<dd>openalex: 4</dd>"));
	// Old sidecar without counts/flow: the section still holds the
	// strategy and grouping rows, no identified rows -- and the head block
	// falls back to the classic Results line instead of the chain.
	assert.ok(html.includes('<details class="prisma">'));
	assert.ok(!html.includes("<dt>Records identified</dt>"));
	assert.ok(!html.includes("Screening flow"));
	assert.ok(html.includes("<dt>Results</dt>"));
	// A query without blocks says where its labels came from.
	const fallback = renderHtml({
		...payload,
		query_variants: ['"quoted"'],
		grouping_by_query: [
			{ query: "water mask", groups: [["water"], ["mask"]] },
			{ query: '"quoted"', groups: null },
		],
	});
	assert.ok(fallback.includes("<dd>Q2: (no blocks -- query passed through unchanged)</dd>"));
	// The label semantics ride with the per-query grouping block: ANY
	// confirmed query's blocks may label a record on_target.
	assert.ok(fallback.includes("full match of at least one of these block sets"));
}

// journal score: rounded display, raw sort key, footnote, label sort keys
{
	assert.ok(html.includes('data-sort="4.422208">4.4</td>'));
	assert.ok(html.includes("&sup1; Journal score = the journal's 2-year mean citedness"));
	assert.ok(html.includes("sort-clear")); // per-column clear control in the sorter
	assert.ok(html.includes('data-sort="0_on_target"'));
	// Evidence line at the label: the winning query and the
	// exact term that hit per block; adjacent rows carry none.
	assert.ok(html.includes("via Q2: sandbar · river"));
	assert.ok(html.includes('data-sort="1_adjacent"'));
	// No records at all -> no table, no &sup1; header -> no footnote either.
	const bare = renderHtml({ ...payload, results: [], dropped: [] });
	assert.ok(!bare.includes("2-year mean citedness"));
}

// authors column: own cell, sorted by the FIRST author's last name; the
// dropped table keeps authors inside the article cell (no own column there)
{
	assert.ok(html.includes('<td class="authorscol" data-sort="author">A. Author; B. Author</td>'));
	const commaStyle = renderHtml({
		...payload,
		results: [{ ...payload.results[0], authors: ["Kryniecka, A.", "Magnuszewski, A."] }],
		dropped: [],
	});
	assert.ok(commaStyle.includes('data-sort="kryniecka"')); // "Last, F." spelling
	// Long author lists collapse: the cell shows the first
	// three and the last name; the middle hides behind a "+N more" toggle.
	// Four or fewer names stay a plain join without any toggle.
	const many = renderHtml({
		...payload,
		results: [{ ...payload.results[0],
			authors: ["A1 One", "A2 Two", "A3 Three", "A4 Four", "A5 Five", "A6 Six"] }],
		dropped: [],
	});
	assert.ok(many.includes('A1 One; A2 Two; A3 Three<span class="mid-authors" hidden>; A4 Four; A5 Five</span>'));
	assert.ok(many.includes('<span class="authors-gap">; &hellip;</span>; A6 Six'));
	assert.ok(many.includes('data-more="(+2 more)"'));
	assert.ok(many.includes('data-sort="one"')); // sort key stays the first author
	const four = renderHtml({
		...payload,
		results: [{ ...payload.results[0], authors: ["A One", "B Two", "C Three", "D Four"] }],
		dropped: [],
	});
	assert.ok(four.includes(">A One; B Two; C Three; D Four</td>"));
	assert.ok(!four.includes('class="authors-toggle"'));
	// dropped table (FULL parity with the results
	// table -- same headers incl. checkbox/#/Code/Label; the Label cell
	// reads "dropped" with the reason as its dim note, keyed on the reason).
	const droppedFull = renderHtml({
		...payload,
		results: [],
		dropped: [{ reason: "year out of range", record: payload.results[0] }],
	});
	assert.ok(droppedFull.includes('<td class="authorscol" data-sort="author">A. Author; B. Author</td>'));
	assert.ok(!droppedFull.includes('<span class="authors">')); // never doubled into the article cell
	// Both tables share resultHeaders(withCode) (two occurrences on a page
	// with rows in each; here results is empty, so exactly one).
	assert.ok(droppedFull.includes("<th class=\"no-sort\">BibTeX</th><th>Data source</th><th>Label</th>"));
	assert.ok(droppedFull.includes(
		'<td data-sort="year out of range">dropped<br><span class="note">reason: year out of range</span></td>'));
	assert.ok(droppedFull.includes("Remote Sensing")); // venue survives the drop
	assert.ok(droppedFull.includes('data-sort="4.422208"')); // journal score too
	assert.ok(droppedFull.includes("crossref, openalex")); // sources stay visible
	// Dropped rows are selectable for download: checkbox with the fetch id,
	// and the download steps render although results is EMPTY -- they sit
	// above the results table and cover both tables together.
	assert.ok(droppedFull.includes('<input type="checkbox" class="pick" data-id="10.1234/abc"'));
	assert.ok(droppedFull.includes('<div class="selectsteps"'));
	assert.ok(droppedFull.indexOf('<div class="selectsteps"') < droppedFull.indexOf("Dropped records (1)"));
	assert.ok(droppedFull.includes("the download request\nabove includes them"));
	// sticky strip styling is present, ticked rows keep the hover tint
	assert.ok(html.includes("position: sticky; top: 0;"));
	assert.ok(html.includes("tbody tr:has(input.pick:checked) td { background: #eaeff5; }"));
}

// BibTeX column: deterministic entry from the record's API
// fields, LaTeX specials escaped, identifiers verbatim; a copy button with
// a hidden textarea sits in BOTH tables
{
	const entry = bibtexEntry(payload.results[0]);
	assert.ok(entry.startsWith("@article{author2021river,"));
	assert.ok(entry.includes("  author = {A. Author and B. Author},"));
	assert.ok(entry.includes("  journal = {Remote Sensing},"));
	assert.ok(entry.includes("  year = {2021},"));
	assert.ok(entry.includes("  doi = {10.1234/abc},"));
	const arxivEntry = bibtexEntry(payload.results[1]);
	assert.ok(arxivEntry.includes("  eprint = {2401.16393v1},"));
	assert.ok(arxivEntry.includes("  archivePrefix = {arXiv},"));
	const escaped = bibtexEntry({ ...payload.results[0], title: "Water & sediment 100% _new_" });
	assert.ok(escaped.includes("title = {{Water \\& sediment 100\\% \\_new\\_}}"));
	const misc = bibtexEntry({ ...payload.results[0], venue: "", doi: "", url: "https://example.org/x" });
	assert.ok(misc.startsWith("@misc{"));
	assert.ok(misc.includes("  url = {https://example.org/x},"));
	assert.ok(html.includes('<button type="button" class="bibtex-copy"'));
	assert.ok(html.includes('<textarea class="bibtex-src" hidden>@article{author2021river,'));
	assert.ok(html.includes("@misc{anon1983component,")); // the dropped row's entry
}

// selection layer: checkboxes carry the fetch identifier, the download steps
// and the copy sentence exist, and rows without any identifier get no checkbox
{
	assert.ok(html.includes('<input type="checkbox" class="pick" data-id="10.1234/abc"'));
	assert.ok(html.includes('data-id="arXiv:2401.16393v1"'));
	assert.ok(html.includes('<div class="selectsteps"'));
	assert.ok(html.includes("Copy download request"));
	// the three steps, in order, and the state the script switches to
	const steps = ["Tick papers to download", "Copy the request", "Paste it into the Pi chat"].map((t) => html.indexOf(t));
	assert.ok(steps.every((i, k) => i > 0 && (k === 0 || i > steps[k - 1])));
	assert.ok(html.includes("Copied &mdash; now paste in Pi"));
	assert.ok(html.includes('<svg width="15" height="15"')); // inline icon, no asset
	// plain "Select all" independent of grouping; the copy button is the blue primary
	assert.ok(html.includes(">Select all</button>"));
	assert.ok(!html.includes("Select all on_target"));
	assert.ok(html.includes("background: #2b4a6f; border-color: #223c5b; color: #fff;"));
	// the strip sits between the results heading and the results table
	assert.ok(html.indexOf('<div class="selectsteps"') > html.indexOf("Query results ("));
	assert.ok(html.indexOf('<div class="selectsteps"') < html.indexOf('<table class="sortable records">'));
	assert.ok(html.includes('"Download these papers: "')); // the copy script's sentence

	// a record with neither DOI nor arXiv ID cannot be fetched -> no checkbox
	const noId = renderHtml({
		...payload,
		results: [{ ...payload.results[0], doi: "", arxiv_id: "", url: "" }],
		dropped: [],
	});
	assert.ok(!noId.includes('class="pick"'));
	assert.ok(!noId.includes('<div class="selectsteps"')); // nothing fetchable, no strip

	// "Select all" is independent of grouping, strip still there
	const ungrouped = renderHtml({ ...payload, grouping: null });
	assert.ok(ungrouped.includes(">Select all</button>"));
	assert.ok(ungrouped.includes('<div class="selectsteps"'));

	// hostile identifier text stays inside the escaped attribute
	const hostile = renderHtml({
		...payload,
		results: [{ ...payload.results[0], doi: '10.1/a"b<c' }],
		dropped: [],
	});
	assert.ok(hostile.includes('data-id="10.1/a&quot;b&lt;c"'));

	// no results -> no download steps at all
	const bare = renderHtml({ ...payload, results: [], dropped: [] });
	assert.ok(!bare.includes('<div class="selectsteps"'));
}

// dropped section: record appears with its reason
{
	assert.ok(html.includes("Dropped records (1)"));
	assert.ok(html.includes("Component junk"));
	assert.ok(html.includes("empty author list"));
	// Footnotes sit BELOW the dropped table (below both tables).
	assert.ok(html.indexOf("&sup1; Journal score") > html.indexOf("Dropped records (1)"));
}

// no grouping rules and no results: honest fallbacks instead of empty markup
{
	const bare = renderHtml({ ...payload, grouping: null, filters: null, sort: null, results: [], dropped: [] });
	assert.ok(bare.includes("none (results ungrouped)"));
	assert.ok(bare.includes("<p>No results.</p>"));
	assert.ok(!bare.includes("Dropped records"));
	assert.ok(!bare.includes("OpenAlex (api.openalex.org)")); // no enrichment, no footnote
}

/* ---------------- localPdfHref / searchSnippet ---------------- */
{
	// pathToFileURL percent-encodes; page, search and phrase=true (contiguous
	// highlight) land in the fragment.
	assert.equal(
		localPdfHref("/p/a b.pdf", 5, "term one two"),
		"file:///p/a%20b.pdf#page=5&search=term%20one%20two&phrase=true",
	);
	assert.equal(localPdfHref("/p/a.pdf", 5), "file:///p/a.pdf#page=5");
	assert.equal(localPdfHref("/p/a.pdf", 5, null), "file:///p/a.pdf#page=5");
	assert.equal(localPdfHref("/p/a.pdf"), "file:///p/a.pdf"); // no page -> no fragment
	// The snippet is encoded exactly once, inside the helper.
	assert.ok(localPdfHref("/p/a.pdf", 2, "50% of cases").endsWith("&search=50%25%20of%20cases&phrase=true"));

	// Deterministic snippet: the first run of >= 3 consecutive clean words
	// (letters/digits only -- a trimmed comma would break the exact phrase
	// match), capped at 5. "threshold," ends the first run early here.
	assert.equal(
		searchSnippet("The adaptive threshold, applied per scene [3],\n  separates water from sand robustly."),
		"applied per scene",
	);
	assert.equal(searchSnippet("Too short."), null); // no clean run of 3
	assert.equal(searchSnippet("a b c d e"), null); // run of 5 but < 15 chars
	// Capped at the first 5 words of the run.
	assert.equal(searchSnippet("One two three four five six seven eight nine ten"), "One two three four five");
}

/* ---------------- renderPaperChatReportHtml ---------------- */

const chatReport: ChatReport = {
	question: "Paper chat report: a.pdf",
	focus: "Validierung <focus>",
	session_questions: ["Wie funktioniert die Methode? <script>alert(1)</script>", "Wie wird validiert?"],
	generated: "2026-07-16T10:00:00.000Z",
	model: "chat-model",
	backend: "ollama at http://127.0.0.1:11434",
	embedding_model: "embed-model",
	grounded: true,
	prose: "Die Methode nutzt einen Schwellwert [1].\n\nValidiert wird mit Felddaten [2].",
	references: [{
		n: 1, key: "doi:10.1234/abc", title: "River sandbar dynamics", authors: ["A. Author"],
		year: "2021", doi: "10.1234/abc", arxiv_id: "", pages: [2, 5], chunk_ids: [1, 2],
	}],
	chunks: [
		{ id: 1, page: 2, score: 0.91, text: "Excerpt <text> one about the adaptive threshold method used." },
		{ id: 2, page: 5, score: 0.83, text: "shrt" },
	],
	sites: [],
	query_variants: [],
	lexical_terms: [],
	lexical_added: 0,
	invalid_markers: ["[9]"],
	unmarked_sentences: 0,
	stripped_reference_section: false,
	trimmed_chunks: 0,
	paper: {
		base: "a", key: "doi:10.1234/abc", title: "River sandbar dynamics", authors: ["A. Author"],
		year: "2021", doi: "10.1234/abc", arxiv_id: "", pdf_path: "/papers dir/a.pdf", verified: true,
	},
	rounds: [{
		asked: "2026-07-16T09:00:00.000Z", question: "Wie funktioniert die Methode? <script>alert(1)</script>",
		language: null, model: "chat-model", session: null, top_k: 8, grounded: true,
		prose: "Antwort mit Marker [1] als Klartext.",
		references: [{
			n: 1, key: "doi:10.1234/abc", title: "River sandbar dynamics", authors: ["A. Author"],
			year: "2021", doi: "10.1234/abc", arxiv_id: "", pages: [2], chunk_ids: [1],
		}],
		cited_chunks: [{ id: 1, page: 2, score: 0.91, text: "Excerpt one." }],
		invalid_markers: [], unmarked_sentences: 0, stripped_reference_section: false,
	}],
	protocol_files: ["/chats/2026-07-16_a.json"],
	adopted_pdfs: [],
	adoption_failures: [],
	extraction_failures: [],
	raw_output: "raw",
};

{
	const html = renderPaperChatReportHtml(chatReport);
	// Escaping: question and chunk text are inert.
	assert.ok(!html.includes("<script>alert(1)</script>"));
	assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
	assert.ok(html.includes("Excerpt &lt;text&gt; one"));
	// Summary markers are live reference links...
	assert.ok(html.includes('<a class="cite" href="#ref-1">[1]</a>'));
	assert.ok(html.includes('id="ref-1"'));
	// ...but the appendix round keeps its markers as plain text.
	assert.ok(html.includes("Antwort mit Marker [1] als Klartext."));
	assert.ok(!html.includes('Antwort mit Marker <a class="cite"'));
	// Local PDF links: encoded path, page anchors; & escaped in attributes;
	// contiguous-phrase highlight; opened in a new tab.
	assert.ok(html.includes('href="file:///papers%20dir/a.pdf" target="_blank" rel="noopener"'));
	assert.ok(html.includes('href="file:///papers%20dir/a.pdf#page=2" target="_blank"'));
	assert.ok(html.includes("#page=2&amp;search=one%20about%20the%20adaptive%20threshold&amp;phrase=true"));
	// The too-short excerpt gets a page link but no search fragment.
	assert.ok(html.includes('href="file:///papers%20dir/a.pdf#page=5"'));
	assert.ok(!html.includes("#page=5&amp;search="));
	// Verified record data + external identifier link.
	assert.ok(html.includes("River sandbar dynamics"));
	assert.ok(html.includes('href="https://doi.org/10.1234/abc"'));
	// Focus, integrity, protocol file name, footer.
	assert.ok(html.includes("Validierung &lt;focus&gt;"));
	assert.ok(html.includes("1 invalid citation marker(s) stripped ([9])"));
	assert.ok(html.includes("2026-07-16_a.json"));
	assert.ok(html.includes("never\nfrom model output"));
	assert.ok(!html.includes("UNGROUNDED"));
}

{
	const html = renderPaperChatReportHtml({ ...chatReport, grounded: false, references: [] });
	assert.ok(html.includes("UNGROUNDED DRAFT"));
	assert.ok(html.includes("None -- no valid citations survived the gate."));
}

/* ---------------- renderPaperChatReportHtml: clickable superscripts ---------------- */
{
	// With sites, every summary marker becomes a superscript into the ONE
	// paper's PDF at ITS page -- two markers of the same reference keep
	// distinct page targets (the point of the v25 collapse-rule change).
	const cited: ChatReport = {
		...chatReport,
		sites: [
			{ ref: 1, chunk_id: 1, paper_key: "doi:10.1234/abc", page: 2, snippet: "one about the adaptive threshold" },
			{ ref: 1, chunk_id: 2, paper_key: "doi:10.1234/abc", page: 5, snippet: null },
		],
		prose: "Die Methode nutzt einen Schwellwert [1].\n\nValidiert wird mit Felddaten [1].",
	};
	const html = renderPaperChatReportHtml(cited);
	assert.ok(html.includes(
		'<sup><a class="cite" href="file:///papers%20dir/a.pdf#page=2&amp;search=one%20about%20the%20adaptive%20threshold&amp;phrase=true" target="_blank" rel="noopener">1</a></sup>',
	));
	assert.ok(html.includes('<sup><a class="cite" href="file:///papers%20dir/a.pdf#page=5" target="_blank" rel="noopener">1</a></sup>'));
	assert.ok(html.includes("Superscript numbers open the cited page"));
	// The appendix round still shows its markers as plain text.
	assert.ok(html.includes("Antwort mit Marker [1] als Klartext."));
}

/* ---------------- neighbouring markers share ONE superscript ---------------- */
{
	// "[1][2]" as two <sup> elements reads as the single number "12" --
	// a run of markers becomes one superscript with comma-separated
	// numbers, and a number repeated inside the run is shown once.
	const cited: ChatReport = {
		...chatReport,
		sites: [
			{ ref: 1, chunk_id: 1, paper_key: "doi:10.1234/abc", page: 2, snippet: null },
			{ ref: 1, chunk_id: 2, paper_key: "doi:10.1234/abc", page: 5, snippet: null },
			{ ref: 1, chunk_id: 1, paper_key: "doi:10.1234/abc", page: 3, snippet: null },
			{ ref: 1, chunk_id: 2, paper_key: "doi:10.1234/abc", page: 4, snippet: null },
			{ ref: 1, chunk_id: 1, paper_key: "doi:10.1234/abc", page: 7, snippet: null },
			{ ref: 1, chunk_id: 2, paper_key: "doi:10.1234/abc", page: 7, snippet: null },
		],
		prose: "Zwei Belege [1][2].\n\nMit Leerzeichen [1] [2].\n\nDoppelt [3][3].",
		rounds: [],
	};
	const html = renderPaperChatReportHtml(cited);
	const supRuns = html.match(/<sup>.*?<\/sup>/g) ?? [];
	// Adjacent and space-separated runs both collapse into one superscript.
	assert.equal(supRuns.length, 3);
	assert.equal(supRuns.filter((run) => run.includes(", ")).length, 2);
	assert.ok(supRuns[0]?.includes("#page=2") && supRuns[0]?.includes("#page=5"));
	assert.ok(supRuns[0]?.startsWith('<sup><a class="cite"') && supRuns[0]?.endsWith("</sup>"));
	assert.ok(!html.includes("</sup><sup>"));
	// Same number twice in a row: one visible marker (both sites consumed,
	// so the numbering of later markers does not shift).
	assert.equal(
		supRuns[2],
		'<sup><a class="cite" href="file:///papers%20dir/a.pdf#page=7" target="_blank" rel="noopener">3</a></sup>',
	);
}

/* ---------------- chat protocol appendix: rounds with sites link too ---------------- */
{
	// A round recorded since v25 carries its own sites -- its markers become
	// PDF superscripts like the summary's (like the summary); a round
	// whose sites do not match its markers falls back to plain text.
	const cited: ChatReport = {
		...chatReport,
		rounds: [
			{
				...chatReport.rounds[0],
				prose: "Antwort mit klickbarem Marker [1].",
				sites: [{ ref: 1, chunk_id: 1, paper_key: "doi:10.1234/abc", page: 2, snippet: null }],
			},
			{
				...chatReport.rounds[0],
				prose: "Kaputte Runde [1][1].",
				sites: [{ ref: 1, chunk_id: 1, paper_key: "doi:10.1234/abc", page: 2, snippet: null }], // 1 site, 2 markers
			},
		],
	};
	const html = renderPaperChatReportHtml(cited);
	assert.ok(html.includes('Antwort mit klickbarem Marker <sup><a class="cite" href="file:///papers%20dir/a.pdf#page=2"'));
	assert.ok(html.includes("Kaputte Runde [1][1].")); // mismatch -> honest plain text
}

{
	// Unverified paper: identified by filename, no external identifier link.
	const html = renderPaperChatReportHtml({
		...chatReport,
		paper: { ...chatReport.paper, verified: false, doi: "", title: "", key: "file:a" },
		references: [{ ...chatReport.references[0], doi: "", title: "", key: "file:a" }],
		rounds: [],
		protocol_files: [],
	});
	assert.ok(html.includes("(unverified -- no bibliographic record, identified by filename)"));
	assert.ok(html.includes("a.pdf (unverified)"));
	assert.ok(html.includes("(no verified record -- cited by filename)"));
	assert.ok(!html.includes("doi.org")); // nothing bibliographic invented
	// The local PDF links are unaffected (paths come from the file scan).
	assert.ok(html.includes('href="file:///papers%20dir/a.pdf#page=2"'));
}

/* ---------------- renderSynthReportHtml (composable report) ---------------- */

function reportUnit(partial: Record<string, unknown>): SynthReport["units"][number] {
	return {
		kind: "summary", paper_base: "a", question: null, model: "fake-gen", grounded: true,
		prose: "Antwort [1].",
		references: [{ n: 1, key: "doi:10.1/x", title: "Paper One", authors: ["A B"], year: "2021",
			doi: "10.1/x", arxiv_id: "", pages: [2], chunk_ids: [1], pdf_path: "/papers/a.pdf" }],
		sites: [{ ref: 1, chunk_id: 1, paper_key: "doi:10.1/x", page: 2, snippet: "adaptive threshold applied" }],
		chunks: [{ id: 1, paper_key: "doi:10.1/x", page: 2, score: 0.9, text: "The adaptive threshold applied per scene separates water." }],
		query_variants: [], lexical_terms: [], lexical_added: 0,
		invalid_markers: [], unmarked_sentences: 0, stripped_reference_section: false,
		trimmed_chunks: 0, raw_output: "raw",
		...partial,
	} as SynthReport["units"][number];
}

const paperOne = {
	base: "a", key: "doi:10.1/x", title: "Paper One", authors: ["A B"], year: "2021",
	doi: "10.1/x", arxiv_id: "", pdf_path: "/papers/a.pdf", verified: true,
};
const paperTwo = {
	base: "b", key: "arxiv:2401.16393", title: "Paper Two", authors: [], year: "2024",
	doi: "", arxiv_id: "2401.16393", pdf_path: "/papers/b.pdf", verified: true,
};

const baseReport: SynthReport = {
	question: "Report: a.pdf",
	generated: "2026-07-22T12:00:00.000Z",
	backend: "ollama at http://127.0.0.1:11434",
	embedding_model: "bge-m3",
	ui_language: "de",
	language: null,
	scope: { papers: ["a"], library: false },
	questions: ["Welche Kamera?"],
	summary: "bullets",
	detail_mode: "per-paper",
	include_review: false,
	papers: [paperOne],
	units: [],
	references: [],
	grounded: true,
	adopted_pdfs: [], adoption_failures: [], unmatched_pdfs: [], extraction_failures: [],
};

{
	// SINGLE-paper report: passage numbering, no reference table; two
	// markers citing DIFFERENT chunks show DIFFERENT superscript numbers
	// even though both cite reference [1] (the E2b field complaint).
	const summaryUnit = reportUnit({
		prose: "- Ziel: Wasserstand [1].\n- Methode: KI [1].",
		format: "bullets",
		sites: [
			{ ref: 1, chunk_id: 1, paper_key: "doi:10.1/x", page: 2, snippet: "adaptive threshold applied" },
			{ ref: 1, chunk_id: 2, paper_key: "doi:10.1/x", page: 4, snippet: null },
		],
		chunks: [
			{ id: 1, paper_key: "doi:10.1/x", page: 2, score: 0.9, text: "Chunk one text about thresholds." },
			{ id: 2, paper_key: "doi:10.1/x", page: 4, score: 0.8, text: "Chunk two text about cameras." },
		],
	});
	const detailUnit = reportUnit({
		kind: "detail-per-paper", question: "Welche Kamera?", format: undefined,
		prose: "Die Kamera steht auf Seite vier [1].",
		sites: [{ ref: 1, chunk_id: 1, paper_key: "doi:10.1/x", page: 4, snippet: null }],
		chunks: [
			{ id: 1, paper_key: "doi:10.1/x", page: 4, score: 0.8, text: "Chunk two text about cameras." },
			// Retrieved but never cited: lands in the rest block.
			{ id: 2, paper_key: "doi:10.1/x", page: 9, score: 0.7, text: "Uncited chunk text." },
		],
	});
	const html = renderSynthReportHtml({
		...baseReport,
		units: [summaryUnit, detailUnit],
		references: summaryUnit.references,
	});
	// Bullets became a real list; German chrome.
	assert.ok(html.includes("<ul>"));
	assert.ok(html.includes("<li>Ziel: Wasserstand"));
	// v27 layout (second iteration): metadata first, NO numbers, NO TOC;
	// technical details collapsed and explained in plain language.
	assert.ok(html.includes("<h2>Abfrage-Metadaten</h2>"));
	assert.ok(!/<h2>\d+\./.test(html)); // no numbered headings
	assert.ok(html.includes("Technische Details (einfach erklärt)"));
	assert.ok(html.includes("Textstellen-Suche"));
	assert.ok(html.includes("Qualitätsprüfung"));
	assert.ok(html.includes("Belegstellen"));
	// v31.6/.7: the truncated passage line IS the expander -- a "more" hint
	// at its end, the truncated span hidden while open (no duplicated first
	// sentence), full excerpt + retrieval rank/similarity per citing unit...
	assert.ok(html.includes('<details class="passage"><summary>'));
	assert.ok(html.includes('<span class="short">'));
	assert.ok(html.includes('<span class="hint-more">▸ mehr</span>'));
	assert.ok(html.includes('<span class="hint-less">▾ weniger</span>'));
	assert.ok(html.includes("details.passage[open] summary .short { display: none; }"));
	assert.ok(html.includes("Zusammenfassung: a.pdf: abgerufen als Treffer 1 von 2, similarity 0.900"));
	assert.ok(html.includes("a.pdf -- Welche Kamera?: abgerufen als Treffer 1 von 2, similarity 0.800"));
	// ...and the advanced block holds ONLY the retrieved-but-uncited rest.
	assert.ok(html.includes("Weitere abgerufene, nicht zitierte Textstellen (für Fortgeschrittene)"));
	assert.ok(html.includes("Uncited chunk text."));
	assert.ok(html.includes("Kosinus-Ähnlichkeit"));
	assert.ok(!html.includes('id="references"')); // no reference table in single mode
	// Passage numbering: chunk one -> 1, chunk two -> 2; the detail unit
	// cites chunk two again -> ALSO 2 (stable identity across units).
	assert.ok(html.includes('#page=2&amp;search=adaptive%20threshold%20applied&amp;phrase=true" target="_blank" rel="noopener">1</a>'));
	assert.ok(html.includes('href="file:///papers/a.pdf#page=4" target="_blank" rel="noopener">2</a>'));
	const detailSection = html.slice(html.indexOf("Die Kamera steht"));
	assert.ok(detailSection.includes('rel="noopener">2</a>'));
	// The passages list has exactly two entries with page links.
	assert.ok(html.includes('<li id="site-1" value="1">'));
	assert.ok(html.includes('<li id="site-2" value="2">'));
	assert.ok(!html.includes('id="site-3"'));
	// Metadata sits BEFORE the paper section; NO table of contents; the
	// answers live in COLLAPSED blocks under the paper.
	assert.ok(html.indexOf("Abfrage-Metadaten") < html.indexOf('id="paper-a"'));
	assert.ok(!html.includes('class="toc"'));
	assert.ok(html.includes('<details class="block"><summary>Zusammenfassung</summary>'));
	assert.ok(html.includes('<details class="block"><summary>Fragen</summary>'));
	assert.ok(html.includes('<details class="block"><summary>Belegstellen</summary>'));
	// v31.5/.6: no top-level excerpts block anymore -- the uncited REST
	// nests at the END of the cited-passages block (after the list).
	assert.ok(!html.includes('<details class="block"><summary>Quell-Textstellen'));
	assert.ok(html.includes('</ol>\n<details><summary>Weitere abgerufene, nicht zitierte Textstellen (für Fortgeschrittene)</summary>'));
	// The anchor-opening script ships (targets live inside details).
	assert.ok(html.includes("openTarget"));
	// Summary/review choices are stated in plain rows.
	assert.ok(html.includes("Ja, als Bulletpoints"));
	assert.ok(html.includes("<dt>Review-Synthese</dt><dd>Nein</dd>"));
}

{
	// MULTI-paper report: <hr> separators, cross section, review with its
	// note. Passages are numbered across the whole report exactly as in
	// single mode (a paper number on every marker of a summary told the
	// reader nothing); cross sections name the paper per passage line and
	// keep the paper-level reference table.
	const unitA = reportUnit({});
	const unitB = reportUnit({
		paper_base: "b",
		prose: "Antwort [2].",
		references: [{ n: 2, key: "arxiv:2401.16393", title: "Paper Two", authors: [], year: "2024",
			doi: "", arxiv_id: "2401.16393", pages: [1], chunk_ids: [1], pdf_path: "/papers/b.pdf" }],
		sites: [{ ref: 2, chunk_id: 1, paper_key: "arxiv:2401.16393", page: 1, snippet: null }],
		chunks: [{ id: 1, paper_key: "arxiv:2401.16393", page: 1, score: 0.7, text: "B text." }],
	});
	const crossUnit = reportUnit({
		kind: "detail-cross", paper_base: null, question: "Welche Methoden?", format: undefined,
	});
	const reviewUnit = reportUnit({ kind: "review", paper_base: null, question: null, format: undefined });
	const html = renderSynthReportHtml({
		...baseReport,
		question: "Report: 2 documents",
		scope: { papers: ["a", "b"], library: false },
		papers: [paperOne, paperTwo],
		units: [unitA, unitB, crossUnit, reviewUnit],
		references: [...unitA.references, ...unitB.references],
		include_review: true,
	});
	assert.ok(!html.includes('class="toc"')); // no TOC anywhere (layout without TOC)
	assert.ok(html.includes('<hr class="paper">'));
	assert.ok(html.includes("Detailfragen (paperübergreifend)"));
	assert.ok(html.includes("Stand der Literatur"));
	assert.ok(html.includes('class="reviewnote"'));
	assert.ok(html.includes('id="paper-a"') && html.includes('id="paper-b"'));
	const paperA = html.slice(html.indexOf('id="paper-a"'), html.indexOf('id="paper-b"'));
	const paperB = html.slice(html.indexOf('id="paper-b"'), html.indexOf('id="cross-questions"'));
	const cross = html.slice(html.indexOf('id="cross-questions"'), html.indexOf('id="review"'));
	const review = html.slice(html.indexOf('id="review"'));
	// Each paper block lists ITS cited passages with report-global numbers
	// (explicit <li value>), no reference table -- the block head is the
	// paper's identity.
	assert.ok(paperA.includes('<summary>Belegstellen</summary>') && !paperA.includes("<summary>Referenzen</summary>"));
	assert.ok(paperA.includes('<li id="site-1" value="1">') && !paperA.includes('value="2"'));
	assert.ok(paperB.includes('<li id="site-2" value="2">') && !paperB.includes('value="1"'));
	// Superscripts show passage numbers: paper A's marker 1, paper B's 2.
	assert.ok(paperA.includes('rel="noopener">1</a>') && !paperA.includes('rel="noopener">2</a>'));
	assert.ok(paperB.includes('rel="noopener">2</a>'));
	// The cross section cites paper A's chunk again -> the SAME passage
	// number 1; its line names the paper (author, year) linked to the
	// block, carries no duplicate anchor id, and the paper-level reference
	// table follows with the cited paper only.
	assert.ok(cross.includes('<li value="1"><details class="passage"><summary><a href="#paper-a">B 2021</a>, '));
	assert.ok(!cross.includes('id="site-1"'));
	assert.ok(cross.includes("<summary>Referenzen</summary>") && cross.includes('<tr id="ref-1">'));
	assert.ok(!html.includes('id="ref-2"')); // nobody cites paper B across papers
	assert.ok(review.includes('<li value="1">') && review.includes("<summary>Referenzen</summary>"));
	// The uncited evidence trail nests at the end of every passages block.
	assert.ok(!html.includes('<details class="block"><summary>Quell-Textstellen'));
}

/* ---------------- passage numbers run paper by paper ---------------- */
{
	// A cross-paper section citing a NEW passage of the FIRST paper must not
	// push that passage behind the second paper's numbers: every paper's
	// block keeps one contiguous range (paper A 1-2, paper B 3), whatever
	// the order in which the model cited them.
	const unitA = reportUnit({});
	const unitB = reportUnit({
		paper_base: "b",
		prose: "Antwort [2].",
		references: [{ n: 2, key: "arxiv:2401.16393", title: "Paper Two", authors: [], year: "2024",
			doi: "", arxiv_id: "2401.16393", pages: [1], chunk_ids: [1], pdf_path: "/papers/b.pdf" }],
		sites: [{ ref: 2, chunk_id: 1, paper_key: "arxiv:2401.16393", page: 1, snippet: null }],
		chunks: [{ id: 1, paper_key: "arxiv:2401.16393", page: 1, score: 0.7, text: "B text." }],
	});
	const crossUnit = reportUnit({
		kind: "detail-cross", paper_base: null, question: "Welche Methoden?", format: undefined,
		prose: "Beide Paper [1].",
		sites: [{ ref: 1, chunk_id: 2, paper_key: "doi:10.1/x", page: 9, snippet: null }],
		chunks: [{ id: 2, paper_key: "doi:10.1/x", page: 9, score: 0.6, text: "A second passage of paper A." }],
	});
	const html = renderSynthReportHtml({
		...baseReport,
		question: "Report: 2 documents",
		scope: { papers: ["a", "b"], library: false },
		papers: [paperOne, paperTwo],
		units: [unitA, unitB, crossUnit],
		references: [...unitA.references, ...unitB.references],
	});
	const paperA = html.slice(html.indexOf('id="paper-a"'), html.indexOf('id="paper-b"'));
	const paperB = html.slice(html.indexOf('id="paper-b"'), html.indexOf('id="cross-questions"'));
	const cross = html.slice(html.indexOf('id="cross-questions"'));
	// Paper A owns numbers 1 and 2 (2 = the passage only the cross section
	// cites, listed there), paper B starts at 3 -- in pure citation order
	// paper A's late passage would have become 3, behind paper B.
	assert.ok(paperA.includes('<li id="site-1" value="1">') && !paperA.includes('value="2"'));
	assert.ok(paperB.includes('<li id="site-3" value="3">') && !paperB.includes('value="2"'));
	assert.ok(cross.includes('<li id="site-2" value="2">'));
	// The cross section's marker shows paper A's second passage as 2.
	assert.ok(cross.includes('rel="noopener">2</a>'));
}

{
	// uiLanguage "en" switches the chrome; an ungrounded report banners.
	const html = renderSynthReportHtml({
		...baseReport,
		ui_language: "en",
		units: [reportUnit({ grounded: false })],
		grounded: false,
	});
	assert.ok(html.includes("Query metadata"));
	assert.ok(html.includes("Technical details (in plain language)"));
	assert.ok(html.includes("Cited passages"));
	assert.ok(html.includes("UNGROUNDED DRAFT"));
	assert.ok(html.includes('<html lang="en">'));
}

{
	// v27: **bold** becomes <strong>, and bullet lines inside ANSWER units
	// become real lists (models write markdown-ish prose).
	const unit = reportUnit({
		kind: "detail-per-paper", question: "Welche Daten?", format: undefined,
		prose: "**1. Satellite Imagery**\n* **SPOT4:** high resolution [1].\n* **Landsat:** wider range [1].",
		sites: [
			{ ref: 1, chunk_id: 1, paper_key: "doi:10.1/x", page: 2, snippet: null },
			{ ref: 1, chunk_id: 1, paper_key: "doi:10.1/x", page: 2, snippet: null },
		],
		chunks: [{ id: 1, paper_key: "doi:10.1/x", page: 2, score: 0.9, text: "Chunk." }],
	});
	const html = renderSynthReportHtml({ ...baseReport, units: [unit], references: unit.references });
	assert.ok(html.includes("<strong>1. Satellite Imagery</strong>"));
	assert.ok(html.includes("<li><strong>SPOT4:</strong> high resolution"));
	assert.ok(!html.includes("**"));
}

// PRISMA polish (2026-08-20): the collapsed documentation section holds
// four always-visible levels; the excluded counts split "no abstract
// available" from "abstract retrieval failed" and break the filter
// exclusions down per filter (all derived from the recorded drop
// reasons); the identifier-verification line comes from the real counts;
// the flow diagram is a standalone SVG offered as a download; the
// closing sentence claims provenance support, not PRISMA compliance.
{
	const junkRecord = payload.dropped[0].record;
	const prismaHtml = renderHtml({
		...payload,
		arxiv_queries: ["all:sandbar"],
		flow: {
			identified: 10, junk_removed: 1, duplicates_removed: 2,
			screened: 7, no_abstract_removed: 3, excluded_by_filters: 2, included: 2,
		},
		dropped: [
			{ reason: "empty author list", record: junkRecord },
			{ reason: "no abstract (sources, the OpenAlex and the Semantic Scholar lookup delivered none)", record: junkRecord },
			{ reason: "no abstract (sources and the OpenAlex lookup delivered none; the Semantic Scholar lookup failed -- the abstract may exist)", record: junkRecord },
			{ reason: "no abstract (sources and the OpenAlex lookup delivered none; the Semantic Scholar lookup failed -- the abstract may exist)", record: junkRecord },
			{ reason: "filtered: published 2015, before requested 2017", record: junkRecord },
			{ reason: "filtered: 3 citation(s) < requested minimum 5", record: junkRecord },
		],
	});
	assert.ok(prismaHtml.includes("<h3>Search strategy</h3>"));
	assert.ok(prismaHtml.includes("<h3>Database-specific search translation</h3>"));
	assert.ok(prismaHtml.includes("<h3>Retrieval and screening</h3>"));
	assert.ok(prismaHtml.includes("<dd>no abstract available: 1</dd>"));
	assert.ok(prismaHtml.includes("abstract retrieval failed: 2"));
	assert.ok(prismaHtml.includes("user filters: 2 (publication year: 1, minimum citations: 1)"));
	// The chain carries the same breakdown inline ("N by <filter>").
	assert.ok(prismaHtml.includes("2 excluded by the user filters (1 by publication year, 1 by minimum citations)"));
	assert.ok(prismaHtml.includes("<dt>User filters</dt>"));
	assert.ok(!prismaHtml.includes("Eligibility filters"));
	// The dropped table says its rows stay selectable; the diagram caption
	// says the same for the excluded numbers.
	assert.ok(prismaHtml.includes("every row stays selectable"));
	assert.ok(prismaHtml.includes("Excluded records remain listed and selectable in the dropped table."));
	// "Verification" and not "Identifier verification": the dt column is
	// 8.5rem wide -- the long label wrapped and shoved the Targeting row.
	assert.ok(prismaHtml.includes("<dt>Verification</dt>"));
	assert.ok(prismaHtml.includes("1 of 2 retained record(s)"));
	assert.ok(prismaHtml.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
	assert.ok(prismaHtml.includes("Records found"));
	assert.ok(!prismaHtml.includes("eligible for manual selection"));
	assert.ok(prismaHtml.includes('download="prisma_flow.svg"'));
	assert.ok(prismaHtml.includes("data:image/svg+xml"));
	assert.ok(prismaHtml.includes("provide the search provenance needed to support"));
	assert.ok(!prismaHtml.includes("the material a PRISMA-2020/PRISMA-S methods section documents"));
	// Limitations only when a source or lookup actually failed.
	assert.ok(!prismaHtml.includes("<h3>Limitations</h3>"));
	const withLimitations = renderHtml({
		...payload,
		abstract_lookup_failures: [{ source: "semanticscholar", error: "HTTP 429", records: 2 }],
	});
	assert.ok(withLimitations.includes("<h3>Limitations</h3>"));
	// No flow (old sidecar) -> no diagram, no excluded rows.
	assert.ok(!html.includes("<svg xmlns"));
	assert.ok(!html.includes("<dt>Records excluded</dt>"));
}

// filterExclusionBreakdown: first matching category wins, output follows
// the fixed category order, unknown wordings land in "other".
{
	assert.deepEqual(filterExclusionBreakdown([
		"filtered: 3 citation(s) < requested minimum 5",
		"filtered: published 1998, before requested 2017",
		"filtered: publication year unknown, cannot prove it is in the requested range",
		"filtered: venue \"X\" matches none of the requested venues",
		"filtered: no author matches Kuenzer",
		"filtered: something new"
	]), [
		{ label: "publication year", count: 2 },
		{ label: "minimum citations", count: 1 },
		{ label: "journal selection", count: 1 },
		{ label: "author selection", count: 1 },
		{ label: "other", count: 1 },
	]);
}

// Source failures get their own meta row; no row when none failed.
{
	assert.ok(!html.includes("Failed sources"));
	const failed = renderHtml({
		...payload,
		sources_used: ["crossref", "openalex"],
		source_failures: [{ source: "arxiv", error: "timeout <60s>" }],
	});
	assert.ok(failed.includes("<dt>Failed sources</dt>"));
	assert.ok(failed.includes("arxiv: timeout &lt;60s&gt; (results may be incomplete)"));
	// a source skipped for a missing optional key: neutral note on the
	// Sources row, never a failure row
	const skipped = renderHtml({
		...payload,
		sources_skipped: [{ source: "semanticscholar", reason: "not queried: optional, needs a free API key" }],
	});
	assert.ok(skipped.includes('<span class="note"> -- semanticscholar not queried: optional, needs a free API key</span></dd>'));
	assert.ok(!skipped.includes("Failed sources"));
}

// Failed abstract lookups get their own meta row (2026-08-20: a
// rate-limited Semantic Scholar pool dropped 11 records as "no abstract"
// with no trace on the page); no row when none failed.
{
	assert.ok(!html.includes("Failed lookups"));
	const failed = renderHtml({
		...payload,
		abstract_lookup_failures: [{ source: "semanticscholar", error: "HTTP 429 <pool>", records: 11 }],
	});
	assert.ok(failed.includes("<dt>Failed lookups</dt>"));
	assert.ok(failed.includes(
		"semanticscholar abstract lookup: HTTP 429 &lt;pool&gt; (11 record(s) affected -- their abstracts may exist; they sit in the dropped table)",
	));
}

// Code-first sources: skim row, "Other methods" + "Sent to" rows with the
// per-source note, candidates on the identified rows, the flow step, the
// extended footnote; a dropped late pair keeps its repo link in the Code
// cell with the gate note as reason. Old sidecars (no fields) unchanged.
{
	const codeRun = renderHtml({
		...payload,
		code_sources_used: ["hf-papers", "awesome-lists"],
		code_queries: {
			"hf-papers": ["sandbar river sentinel"],
			"awesome-lists": ["lists tagged remote-sensing; entries matched against the blocks (sandbar) AND (river)"],
		},
		source_counts: [
			{ source: "arxiv", query: payload.query, count: 3 },
			{ source: "hf-papers", query: payload.query, count: 2, candidates: 7 },
		],
		flow: { identified: 5, junk_removed: 0, duplicates_removed: 0, screened: 5, late_code_pairs_removed: 1, no_abstract_removed: 0, excluded_by_filters: 0, included: 2 },
		results: [{ ...payload.results[0], sources: ["hf-papers"], resolved_via: "arxiv", code_url: "https://github.com/acme/sandbar-net", enriched: { code_url: "hf-papers" } }],
		dropped: [{
			reason: "found via code repository https://github.com/x/cropmask, created 2 years after the paper -- probably a project citing the paper, not the paper's own code",
			record: { ...payload.results[1], sources: ["awesome-lists"], code_url: "https://github.com/x/cropmask", code_gate: "late" },
		}],
	});
	assert.ok(codeRun.includes("<dt>Code sources</dt><dd>hf-papers, awesome-lists"));
	assert.ok(codeRun.includes("<dt>Other methods</dt><dd>code repositories: hf-papers, awesome-lists"));
	assert.ok(codeRun.includes("<dt>Sent to Hugging Face Papers</dt><dd>sandbar river sentinel</dd>"));
	assert.ok(codeRun.includes("community-linked, not an author declaration"));
	assert.ok(codeRun.includes("<dt>Matched against curated lists</dt><dd>lists tagged remote-sensing;"));
	assert.ok(codeRun.includes("hf-papers: 2 (resolved from 7 repository candidate(s))"));
	assert.ok(codeRun.includes("1 code pair(s) moved to dropped (repository created long after the paper)"));
	assert.ok(codeRun.includes("Repository first (code sources, when enabled)"));
	assert.ok(codeRun.includes("repos.ecosyste.ms (data CC-BY-SA)"));
	assert.ok(codeRun.includes("abstract | github | hf-papers | github-readme | awesome-lists | gee-github"));
	assert.ok(codeRun.includes("https://github.com/x/cropmask"));
	assert.ok(codeRun.includes("created 2 years after the paper"));
	assert.ok(!html.includes("<dt>Code sources</dt>"));
	assert.ok(!html.includes("<dt>Other methods</dt>"));
	assert.ok(!html.includes("code pair(s) moved to dropped"));
}

// Author scope row: picked authors with ids, position and scope wording in
// both meta blocks; absent without picked authors; the filter summary
// names the picked authors and the position.
{
	const scoped = renderHtml({
		...payload,
		author_scope: { names: ["Claudia Kuenzer"], ids: ["A5059343226"], position: "first", scope: "all" },
		filters: { pickedAuthors: ["Claudia Kuenzer"], authorPosition: "first" },
	});
	assert.ok(scoped.includes("<dt>Author scope</dt><dd>Claudia Kuenzer (A5059343226) -- first author only, all their publications (query used only for the on_target label)</dd>"));
	assert.equal(scoped.split("<dt>Author scope</dt>").length, 3);
	assert.ok(scoped.includes("picked authors: Claudia Kuenzer; author position: first"));
	const anyPos = renderHtml({ ...payload, author_scope: { names: ["X"], ids: [], position: "any", scope: "query" } });
	assert.ok(anyPos.includes("<dt>Author scope</dt><dd>X -- any author position, publications matching the query</dd>"));
	assert.ok(!renderHtml({ ...payload, author_scope: null }).includes("Author scope"));
}

console.log("render.test.ts: all assertions passed");
