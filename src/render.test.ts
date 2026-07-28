/**
 * Logic tests for the deterministic HTML renderer (no network). The payload
 * below is a synthetic fixture for exercising escaping, linking and layout
 * rules -- its records are never shown to a user as papers.
 *
 * Run: node src/render.test.ts
 */

import assert from "node:assert/strict";
import type { ChatReport, SynthReport } from "./synthesize.ts";
import {
	localPdfHref,
	renderHtml,
	renderPaperChatReportHtml,
	renderSynthReportHtml,
	type RenderPayload,
	renderReviewHtml,
	searchSnippet,
} from "./render.ts";
import type { SynthesisResult } from "./synthesize.ts";

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
	// The author picker reports the same way (v30.11).
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

// arXiv transparency row: the expression actually sent to arXiv, per query (v18)
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
	assert.ok(!html.includes("Sent to arXiv")); // no arXiv in the run, no row
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

/* ---------------- renderReviewHtml ---------------- */

const synthesis: SynthesisResult = {
	question: 'How are sandbars detected? <script>alert(1)</script>',
	generated: "2026-07-15T12:00:00Z",
	model: "openscholar-8b",
	embedding_model: "nomic-embed-text",
	backend: "ollama at http://127.0.0.1:11434",
	top_k: 8,
	grounded: true,
	prose: 'Detected via "S2" & <b>SAR</b> [1]. See https://evil.example [2].\n\nSecond paragraph [1].',
	references: [
		{ n: 1, key: "doi:10.1/x", title: "Paper <One>", authors: ["A B", "C D"], year: "2021",
			doi: "10.1/x", arxiv_id: "", pages: [2, 5], chunk_ids: [1, 3] },
		{ n: 2, key: "arxiv:2401.16393", title: "Paper Two", authors: [], year: null,
			doi: "", arxiv_id: "2401.16393", pages: [1], chunk_ids: [2] },
	],
	chunks: [
		{ id: 1, paper_key: "doi:10.1/x", title: "Paper <One>", page: 2, score: 0.91, text: "Excerpt <text> one." },
		{ id: 2, paper_key: "arxiv:2401.16393", title: "Paper Two", page: 1, score: 0.52, text: "Excerpt two." },
		{ id: 3, paper_key: "doi:10.1/x", title: "Paper <One>", page: 5, score: 0.4, text: "Excerpt three." },
	],
	sites: [],
	query_variants: [],
	lexical_terms: [],
	lexical_added: 0,
	invalid_markers: ["[9]"],
	unmarked_sentences: 1,
	stripped_reference_section: true,
	trimmed_chunks: 0,
	papers_matched: 2,
	papers_cited: 2,
	papers_uncited: [],
	adopted_pdfs: ["2020_Found_A_paper.pdf"],
	adoption_failures: [{ file: "alien_scan.pdf", reason: "no DOI or arXiv ID found on the first 2 pages" }],
	unmatched_pdfs: ["alien_scan.pdf"],
	extraction_failures: [{ file: "scan.pdf", reason: "no extractable text (likely scanned)" }],
	raw_output: "raw",
};

{
	const html = renderReviewHtml(synthesis);
	// Escaping: model/question text never becomes markup.
	assert.ok(!html.includes("<script>alert"));
	assert.ok(html.includes("&lt;script&gt;"));
	assert.ok(html.includes("&lt;b&gt;SAR&lt;/b&gt;"));
	assert.ok(html.includes("Paper &lt;One&gt;"));
	// Validated markers become in-page reference links -- the only live
	// parts of the prose.
	assert.ok(html.includes('<a class="cite" href="#ref-1">[1]</a>'));
	assert.ok(html.includes('<a class="cite" href="#ref-2">[2]</a>'));
	// A URL the model wrote stays plain text, never an href.
	assert.ok(!html.includes('href="https://evil.example"'));
	// Reference hrefs come only from verified identifiers.
	assert.ok(html.includes('href="https://doi.org/10.1/x"'));
	assert.ok(html.includes('href="https://arxiv.org/abs/2401.16393"'));
	assert.ok(html.includes('id="ref-1"'));
	assert.ok(html.includes("2, 5")); // pages cited
	// Honest disclosures in the methods block.
	assert.ok(html.includes("1 invalid citation marker(s) stripped ([9])"));
	assert.ok(html.includes("reference section was cut"));
	assert.ok(html.includes("alien_scan.pdf -- no DOI or arXiv ID found on the first 2 pages"));
	assert.ok(html.includes("scan.pdf"));
	assert.ok(html.includes("2020_Found_A_paper.pdf -- identifier found in the PDF text"));
	// Grounded run: no warning banner; excerpt trail present.
	assert.ok(!html.includes("UNGROUNDED"));
	assert.ok(html.includes("Excerpt &lt;text&gt; one."));
	assert.ok(html.includes("similarity 0.910"));
}

{
	const html = renderReviewHtml({ ...synthesis, grounded: false, references: [] });
	assert.ok(html.includes("UNGROUNDED DRAFT"));
	assert.ok(html.includes("None -- no valid citations survived the gate."));
}

/* ---------------- renderReviewHtml: clickable superscripts ---------------- */
{
	// With citation sites and a known local PDF, markers become superscript
	// links to the cited page; a reference without a path falls back to the
	// in-page anchor. Marker order maps one-to-one onto sites.
	const cited: SynthesisResult = {
		...synthesis,
		references: [
			{ ...synthesis.references[0], pdf_path: "/papers/one.pdf" },
			synthesis.references[1], // no local PDF known
		],
		sites: [
			{ ref: 1, chunk_id: 1, paper_key: "doi:10.1/x", page: 2, snippet: "adaptive threshold applied" },
			{ ref: 2, chunk_id: 2, paper_key: "arxiv:2401.16393", page: 1, snippet: null },
			{ ref: 1, chunk_id: 3, paper_key: "doi:10.1/x", page: 5, snippet: null },
		],
	};
	const html = renderReviewHtml(cited);
	assert.ok(html.includes(
		'<sup><a class="cite" href="file:///papers/one.pdf#page=2&amp;search=adaptive%20threshold%20applied&amp;phrase=true" target="_blank" rel="noopener">1</a></sup>',
	));
	assert.ok(html.includes('<sup><a class="cite" href="file:///papers/one.pdf#page=5" target="_blank" rel="noopener">1</a></sup>'));
	assert.ok(html.includes('<a class="cite" href="#ref-2">[2]</a>')); // no path -> classic anchor
	assert.ok(html.includes("Superscript numbers open the cited page")); // honest Chromium footnote
}

/* ---------------- localPdfHref / searchSnippet ---------------- */
{
	// pathToFileURL percent-encodes; page, search and phrase=true (contiguous
	// highlight, live finding 2026-07-16) land in the fragment.
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
		language: null, model: "chat-model", top_k: 8, grounded: true,
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

/* ---------------- chat protocol appendix: rounds with sites link too ---------------- */
{
	// A round recorded since v25 carries its own sites -- its markers become
	// PDF superscripts like the summary's (field wish 2026-07-22); a round
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

/* ---------------- renderSynthReportHtml (v25 composable report) ---------------- */

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
	// SINGLE-paper report: passages numbering replaces the reference table;
	// two markers citing DIFFERENT chunks show DIFFERENT superscript numbers
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
		chunks: [{ id: 1, paper_key: "doi:10.1/x", page: 4, score: 0.8, text: "Chunk two text about cameras." }],
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
	assert.ok(html.includes("Textauszüge"));
	assert.ok(!html.includes('id="references"')); // no reference table in single mode
	// Passage numbering: chunk one -> 1, chunk two -> 2; the detail unit
	// cites chunk two again -> ALSO 2 (stable identity across units).
	assert.ok(html.includes('#page=2&amp;search=adaptive%20threshold%20applied&amp;phrase=true" target="_blank" rel="noopener">1</a>'));
	assert.ok(html.includes('href="file:///papers/a.pdf#page=4" target="_blank" rel="noopener">2</a>'));
	const detailSection = html.slice(html.indexOf("Die Kamera steht"));
	assert.ok(detailSection.includes('rel="noopener">2</a>'));
	// The passages list has exactly two entries with page links.
	assert.ok(html.includes('<li id="site-1">'));
	assert.ok(html.includes('<li id="site-2">'));
	assert.ok(!html.includes('<li id="site-3">'));
	// Metadata sits BEFORE the paper section; NO table of contents; the
	// answers live in COLLAPSED blocks under the paper.
	assert.ok(html.indexOf("Abfrage-Metadaten") < html.indexOf('id="paper-a"'));
	assert.ok(!html.includes('class="toc"'));
	assert.ok(html.includes('<details class="block"><summary>Zusammenfassung</summary>'));
	assert.ok(html.includes('<details class="block"><summary>Fragen</summary>'));
	assert.ok(html.includes('<details class="block"><summary>Belegstellen</summary>'));
	assert.ok(html.includes('<details class="block"><summary>Textauszüge</summary>'));
	// The anchor-opening script ships (targets live inside details).
	assert.ok(html.includes("openTarget"));
	// Summary/review choices are stated in plain rows.
	assert.ok(html.includes("Ja, als Bulletpoints"));
	assert.ok(html.includes("<dt>Review-Synthese</dt><dd>Nein</dd>"));
}

{
	// MULTI-paper report: TOC, <hr> separators, cross section, review with
	// its note, and the paper-level reference table.
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
		question: "Report: 2 Dokumente",
		scope: { papers: ["a", "b"], library: false },
		papers: [paperOne, paperTwo],
		units: [unitA, unitB, crossUnit, reviewUnit],
		references: [...unitA.references, ...unitB.references],
		include_review: true,
	});
	assert.ok(!html.includes('class="toc"')); // no TOC anywhere (v27 layout)
	assert.ok(html.includes('<hr class="paper">'));
	assert.ok(html.includes("Detailfragen (paperübergreifend)"));
	assert.ok(html.includes("Stand der Literatur"));
	assert.ok(html.includes('class="reviewnote"'));
	// References live WITH each paper (collapsed), not at the page bottom;
	// each paper's block lists only ITS cited entries with global numbers.
	assert.ok(html.includes('<details class="block"><summary>Referenzen</summary>'));
	assert.ok(html.includes('id="ref-1"') && html.includes('id="ref-2"'));
	const paperA = html.slice(html.indexOf('id="paper-a"'), html.indexOf('id="paper-b"'));
	assert.ok(paperA.includes("[1]") && !paperA.includes('<tr id="ref-2">'));
	// Multi mode keeps the marker's own (paper-level) numbers as labels.
	assert.ok(html.includes('rel="noopener">1</a>'));
	assert.ok(html.includes('rel="noopener">2</a>'));
	assert.ok(html.includes('id="paper-a"') && html.includes('id="paper-b"'));
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

// The wide grouping variant shows its "at least N of" form (v30.3).
{
	const wide = renderHtml({ ...payload, grouping: [["water"], ["mask"], ["sentinel 2"]], grouping_require: 2 });
	assert.ok(wide.includes("at least 2 of: water | mask | sentinel 2"));
	// Without grouping_require the classic AND expression stays.
	assert.ok(html.includes("(river OR fluvial) AND (sandbar)"));
}

// Source failures get their own meta row (v30.1); no row when none failed.
{
	assert.ok(!html.includes("Failed sources"));
	const failed = renderHtml({
		...payload,
		sources_used: ["crossref", "openalex"],
		source_failures: [{ source: "arxiv", error: "timeout <60s>" }],
	});
	assert.ok(failed.includes("<dt>Failed sources</dt>"));
	assert.ok(failed.includes("arxiv: timeout &lt;60s&gt; (results may be incomplete)"));
}

console.log("render.test.ts: all assertions passed");
