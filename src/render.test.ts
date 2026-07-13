/**
 * Logic tests for the deterministic HTML renderer (no network). The payload
 * below is a synthetic fixture for exercising escaping, linking and layout
 * rules -- its records are never shown to a user as papers.
 *
 * Run: node src/render.test.ts
 */

import assert from "node:assert/strict";
import { renderHtml, type RenderPayload } from "./render.ts";

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
	assert.ok(html.includes('<a href="https://doi.org/10.1234/abc">10.1234/abc</a>'));
	assert.ok(html.includes('<a href="https://example.org/paper.pdf">PDF</a>'));
	assert.ok(!html.includes('href="javascript:'));
}

// DOI column: arXiv ID fallback for preprints; failed trust gate is flagged
{
	assert.ok(html.includes('<a href="https://arxiv.org/abs/2401.16393v1">arXiv:2401.16393v1</a>'));
	assert.ok(html.includes('<span class="unverified">did not verify</span>'));
	assert.ok(html.includes("arxiv.org answered HTTP 404"));
}

// header block: grouping rules, filters, sort and counts are echoed
{
	assert.ok(html.includes("(river OR fluvial) AND (sandbar)"));
	assert.ok(html.includes("year from: 2016; venues: Remote Sensing"));
	assert.ok(html.includes("2 (1 on_target, 1 adjacent); 1/2 identifiers verified; 1 dropped"));
}

// table: expected column order, sortable markup, on_target highlighting
{
	assert.ok(html.includes("</th><th>#</th><th>Article</th><th>Authors</th><th>Year</th><th>Journal</th><th>Journal score&sup1;</th><th>Citations</th><th>DOI</th><th>Data source</th><th>Label</th>"));
	assert.ok(html.includes('<th class="no-sort"')); // checkbox column is not sortable
	assert.ok(html.includes('<table class="sortable">'));
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

// journal score: rounded display, raw sort key, footnote, label sort keys
{
	assert.ok(html.includes('data-sort="4.422208">4.4</td>'));
	assert.ok(html.includes("&sup1; Journal score = the journal's 2-year mean citedness"));
	assert.ok(html.includes("sort-clear")); // per-column clear control in the sorter
	assert.ok(html.includes('data-sort="0_on_target"'));
	assert.ok(html.includes('data-sort="1_adjacent"'));
	const bare = renderHtml({ ...payload, results: [], dropped: [] });
	assert.ok(!bare.includes("2-year mean citedness")); // no scores, no footnote
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
	// dropped table: authors stay inside the article cell (no own column there)
	const droppedWithAuthors = renderHtml({
		...payload,
		results: [],
		dropped: [{ reason: "year out of range", record: payload.results[0] }],
	});
	assert.ok(droppedWithAuthors.includes('<span class="authors">A. Author; B. Author</span>'));
	// sticky selection bar styling is present
	assert.ok(html.includes("position: sticky; bottom: 0;"));
}

// selection layer: checkboxes carry the fetch identifier, the bar and the
// copy sentence exist, and rows without any identifier get no checkbox
{
	assert.ok(html.includes('<input type="checkbox" class="pick" data-id="10.1234/abc"'));
	assert.ok(html.includes('data-id="arXiv:2401.16393v1"'));
	assert.ok(html.includes('<div class="selectbar">'));
	assert.ok(html.includes("Copy download request"));
	assert.ok(html.includes("Select all on_target")); // grouping is on in the fixture
	assert.ok(html.includes("paste it into the Pi chat"));
	assert.ok(html.includes('"Download these papers: "')); // the copy script's sentence

	// a record with neither DOI nor arXiv ID cannot be fetched -> no checkbox
	const noId = renderHtml({
		...payload,
		results: [{ ...payload.results[0], doi: "", arxiv_id: "", url: "" }],
		dropped: [],
	});
	assert.ok(!noId.includes('class="pick"'));
	assert.ok(!noId.includes('<div class="selectbar">')); // nothing fetchable, no bar

	// no grouping -> no "Select all on_target" button, bar still there
	const ungrouped = renderHtml({ ...payload, grouping: null });
	assert.ok(!ungrouped.includes("Select all on_target"));
	assert.ok(ungrouped.includes('<div class="selectbar">'));

	// hostile identifier text stays inside the escaped attribute
	const hostile = renderHtml({
		...payload,
		results: [{ ...payload.results[0], doi: '10.1/a"b<c' }],
		dropped: [],
	});
	assert.ok(hostile.includes('data-id="10.1/a&quot;b&lt;c"'));

	// no results -> no selection bar at all
	const bare = renderHtml({ ...payload, results: [], dropped: [] });
	assert.ok(!bare.includes('<div class="selectbar">'));
}

// dropped section: record appears with its reason
{
	assert.ok(html.includes("Dropped records (1)"));
	assert.ok(html.includes("Component junk"));
	assert.ok(html.includes("empty author list"));
}

// no grouping rules and no results: honest fallbacks instead of empty markup
{
	const bare = renderHtml({ ...payload, grouping: null, filters: null, sort: null, results: [], dropped: [] });
	assert.ok(bare.includes("none (results ungrouped)"));
	assert.ok(bare.includes("<p>No results.</p>"));
	assert.ok(!bare.includes("Dropped records"));
	assert.ok(!bare.includes("OpenAlex (api.openalex.org)")); // no enrichment, no footnote
}

console.log("render.test.ts: all assertions passed");
