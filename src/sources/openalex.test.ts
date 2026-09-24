/**
 * Offline tests for the OpenAlex helpers (v30.6: journal facets behind
 * the wizard's journal picker).
 * Run: node src/sources/openalex.test.ts
 */

import assert from "node:assert/strict";
import { accessFromWork, buildAuthorSearchFilter, buildBlockSearch, buildFacetFilter, buildFacetParams, lookupOpenalexDois, parseFacetPage, parseFacets, toSourceRecord,
	autocompleteAuthors,
	buildAuthorIdFilter,
	buildWorksParams,
	parseAuthorAutocomplete,
	searchOpenalex,
} from "./openalex.ts";

/** v30.11: journals and authors share the facet parser. */
const parseJournalFacets = parseFacets;
const parseJournalFacetPage = parseFacetPage;

// Buckets parse into name+count, unknown/empty names drop, order is by
// count descending with a deterministic name tie-break, limit applies.
{
	const data = {
		group_by: [
			{ key: "https://openalex.org/S1", key_display_name: "Remote Sensing", count: 1739 },
			{ key: "https://openalex.org/S2", key_display_name: "Water", count: 91 },
			{ key: "unknown", key_display_name: "unknown", count: 500 },
			{ key: "https://openalex.org/S3", key_display_name: "", count: 77 },
			{ key: "https://openalex.org/S4", key_display_name: "Sensors", count: 129 },
			{ key: "https://openalex.org/S5", key_display_name: "Atmosphere", count: 91 },
		],
	};
	assert.deepEqual(parseJournalFacets(data, 10), [
		{ id: "S1", name: "Remote Sensing", count: 1739 },
		{ id: "S4", name: "Sensors", count: 129 },
		{ id: "S5", name: "Atmosphere", count: 91 }, // 91-tie resolves by name
		{ id: "S2", name: "Water", count: 91 },
	]);
	assert.deepEqual(parseJournalFacets(data, 2), [
		{ id: "S1", name: "Remote Sensing", count: 1739 },
		{ id: "S4", name: "Sensors", count: 129 },
	]);
}

// v30.11: the "other" bucket is meta.count minus the LISTED journals --
// works in unlisted journals and works without any source included.
{
	const data = {
		meta: { count: 10040 },
		group_by: [
			{ key: "https://openalex.org/S1", key_display_name: "Remote Sensing", count: 1739 },
			{ key: "https://openalex.org/S2", key_display_name: "Water", count: 91 },
			{ key: "unknown", key_display_name: "unknown", count: 500 },
		],
	};
	const page = parseJournalFacetPage(data, 1);
	assert.deepEqual(page.listed, [{ id: "S1", name: "Remote Sensing", count: 1739 }]);
	assert.equal(page.otherCount, 10040 - 1739);
	// Everything listed still leaves the works outside the returned buckets.
	assert.equal(parseJournalFacetPage(data, 10).otherCount, 10040 - 1739 - 91);
	// Without meta.count the bucket sum is the honest floor; never negative.
	assert.equal(parseJournalFacetPage({ group_by: data.group_by }, 10).otherCount, 500);
	assert.deepEqual(parseJournalFacetPage({}, 5), { listed: [], otherCount: 0 });
}

// Degenerate responses never throw: missing group_by, wrong shapes.
{
	assert.deepEqual(parseJournalFacets({}, 5), []);
	assert.deepEqual(parseJournalFacets(null, 5), []);
	assert.deepEqual(parseJournalFacets({ group_by: "nope" }, 5), []);
	assert.deepEqual(parseJournalFacets({ group_by: [{ count: 3 }] }, 5), []);
}

// Facet scope -> OpenAlex filter= value (v30.13: the pickers reflect the
// configured run -- period and picked journals -- not the query alone).
{
	assert.equal(buildFacetFilter({}), "");
	assert.equal(buildFacetFilter({ yearFrom: 2022 }), "from_publication_date:2022-01-01");
	assert.equal(
		buildFacetFilter({ yearFrom: 2022, yearTo: 2024 }),
		"from_publication_date:2022-01-01,to_publication_date:2024-12-31",
	);
	assert.equal(
		buildFacetFilter({ yearTo: 2024, sourceIds: ["S1", "S2"] }),
		"to_publication_date:2024-12-31,primary_location.source.id:S1|S2",
	);
	assert.equal(buildFacetFilter({ sourceIds: [] }), ""); // empty list scopes nothing
}

// Author scope -> raw_author_name.search filter (v30.14): picked authors
// narrow the fetch itself; commas/pipes are filter syntax and get stripped.
{
	assert.equal(buildAuthorSearchFilter(["Claudia Kuenzer"]), "raw_author_name.search:Claudia Kuenzer");
	assert.equal(
		buildAuthorSearchFilter(["Kuenzer", "Mahdianpari"]),
		"raw_author_name.search:Kuenzer|Mahdianpari",
	);
	assert.equal(buildAuthorSearchFilter(["Kuenzer, C."]), "raw_author_name.search:Kuenzer C.");
	assert.equal(buildAuthorSearchFilter([]), "");
	assert.equal(buildAuthorSearchFilter(undefined), "");
	assert.equal(buildAuthorSearchFilter(["  ", "|"]), "");
}

// buildBlockSearch (2026-08-06 block search): UPPERCASE boolean operators,
// parentheses only around real OR groups, multi-word terms quoted.
{
	assert.equal(
		buildBlockSearch([["river", "stream"], ["water extraction", "water mapping"], ["satellite"]]),
		'(river OR stream) AND ("water extraction" OR "water mapping") AND satellite',
	);
	assert.equal(buildBlockSearch([["mask"]]), "mask");
	assert.equal(buildBlockSearch([]), "");
	assert.equal(buildBlockSearch(undefined), "");
	// Embedded quotes in terms are stripped, empty groups drop.
	assert.equal(buildBlockSearch([['"sentinel 2"'], [""]]), '"sentinel 2"');
}

// toSourceRecord: the one mapper both the search and the DOI lookup use.
{
	const item = {
		id: "https://openalex.org/W1",
		doi: "https://doi.org/10.3390/RS12152469",
		title: " Comparing Sentinel-1 Surface Water Mapping Algorithms ",
		publication_year: 2020,
		cited_by_count: 42,
		authorships: [{ author: { display_name: "Amanda Markert" } }, { author: {} }, { author: { display_name: " Kel Markert " } }],
		primary_location: { source: { id: "https://openalex.org/S123", display_name: "Remote Sensing" }, pdf_url: "", landing_page_url: "https://www.mdpi.com/x" },
		open_access: { is_oa: true, oa_url: "https://www.mdpi.com/x/pdf" },
		abstract_inverted_index: { Surface: [0], water: [1] },
	};
	const record = toSourceRecord(item);
	assert.equal(record.doi, "10.3390/RS12152469");
	assert.equal(record.title, "Comparing Sentinel-1 Surface Water Mapping Algorithms");
	assert.deepEqual(record.authors, ["Amanda Markert", "Kel Markert"]);
	assert.equal(record.year, "2020");
	assert.equal(record.venue, "Remote Sensing");
	assert.equal(record.venue_id, "S123");
	assert.equal(record.pdf_url, "https://www.mdpi.com/x/pdf");
	assert.equal(record.url, "https://www.mdpi.com/x");
	assert.equal(record.cites, 42);
	assert.equal(record.source, "openalex");
	assert.equal(record.abstract, "Surface water");
	assert.equal(record.arxiv_id, "");
	// Sparse work: nothing invented.
	const sparse = toSourceRecord({ publication_date: "2019-05-01" });
	assert.equal(sparse.title, "");
	assert.equal(sparse.year, "2019");
	assert.equal(sparse.cites, null);
	assert.equal(sparse.doi, "");
}

// lookupOpenalexDois: pipe-joined filter, lowercase + deduped DOIs, unknown
// DOIs simply absent, batches of 50.
{
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown) => {
		calls.push(String(url));
		const filter = new URL(String(url)).searchParams.get("filter") ?? "";
		const dois = filter.replace(/^doi:/, "").split("|");
		return new Response(JSON.stringify({
			results: dois.filter((d) => d !== "10.1/missing").map((d) => ({ doi: `https://doi.org/${d}`, title: `T ${d}`, publication_year: 2021 })),
		}), { status: 200 });
	}) as typeof fetch;
	try {
		const records = await lookupOpenalexDois(["10.3390/RS1", " 10.3390/rs1", "10.1/missing", "10.1016/x"]);
		assert.equal(calls.length, 1);
		const filter = new URL(calls[0]).searchParams.get("filter");
		assert.equal(filter, "doi:10.3390/rs1|10.1/missing|10.1016/x");
		assert.deepEqual(records.map((r) => r.doi), ["10.3390/rs1", "10.1016/x"]);
		assert.equal(records[0].source, "openalex");
		assert.equal(records[0].year, "2021");
		// 60 DOIs -> two requests of 50 + 10.
		calls.length = 0;
		const many = await lookupOpenalexDois(Array.from({ length: 60 }, (_, i) => `10.1/d${i}`));
		assert.equal(calls.length, 2);
		assert.equal(many.length, 60);
		// Empty input -> no request.
		calls.length = 0;
		assert.deepEqual(await lookupOpenalexDois([]), []);
		assert.equal(calls.length, 0);
	} finally {
		globalThis.fetch = realFetch;
	}
}

// Author lookup: the autocomplete answer (shape measured 2026-09-13) ->
// matches; ids as a filter; the works parameters per author scope.
{
	const matches = parseAuthorAutocomplete({ results: [
		{ id: "https://openalex.org/A5059343226", display_name: "Claudia Kuenzer", hint: "University of Würzburg, Germany", cited_by_count: 16579, works_count: 306, external_id: null },
		{ id: "https://openalex.org/A5076899684", display_name: "Christopher Kuenze", hint: null, cited_by_count: 3667, works_count: 201, external_id: "https://orcid.org/0000-0001-9184-4636" },
		{ id: "https://openalex.org/A5059343226", display_name: "Claudia Kuenzer" },
		{ id: "https://openalex.org/W1", display_name: "not an author" },
		{ display_name: "no id" },
	] });
	assert.deepEqual(matches.map((m) => m.id), ["A5059343226", "A5076899684"]);
	assert.deepEqual(matches[0], { id: "A5059343226", name: "Claudia Kuenzer", hint: "University of Würzburg, Germany", works: 306, cites: 16579, orcid: "" });
	assert.equal(matches[1].hint, "");
	assert.equal(matches[1].orcid, "https://orcid.org/0000-0001-9184-4636");
	assert.deepEqual(parseAuthorAutocomplete({ error: "x" }), []);
	assert.equal(buildAuthorIdFilter(["A5059343226", "https://openalex.org/A1", " junk ", ""]), "authorships.author.id:A5059343226|A1");
	assert.equal(buildAuthorIdFilter([]), "");
	// Scope "query": text search plus the id filter (ids win over names).
	const byQuery = buildWorksParams("water flood", 5, { authorIds: ["A5059343226"], authors: ["Claudia Kuenzer"], blocks: [["water"], ["flood"]] });
	assert.equal(byQuery.get("search"), "water AND flood");
	assert.equal(byQuery.get("filter"), "type:!peer-review|supplementary-materials|paratext|dataset|grant,authorships.author.id:A5059343226");
	assert.equal(byQuery.get("sort"), null);
	// Scope "all": no text search, citation-sorted, the id filter alone.
	const all = buildWorksParams("water flood", 5, { authorIds: ["A5059343226"], authorScope: "all", blocks: [["water"]] });
	assert.equal(all.get("search"), null);
	assert.equal(all.get("sort"), "cited_by_count:desc");
	assert.equal(all.get("filter"), "type:!peer-review|supplementary-materials|paratext|dataset|grant,authorships.author.id:A5059343226");
	// Scope "all" without any author falls back to the text search.
	assert.equal(buildWorksParams("water", 5, { authorScope: "all" }).get("search"), "water");
	// Names only (no ids): the raw_author_name search as before.
	assert.equal(buildWorksParams("water", 5, { authors: ["Kuenzer"] }).get("filter"), "type:!peer-review|supplementary-materials|paratext|dataset|grant,raw_author_name.search:Kuenzer");
	// Type exclusion on EVERY works search (peer-review reports and author
	// replies of open review platforms are typed peer-review; measured
	// 2026-09-15: the negated pipe form and the comma form agree, 210 -> 188
	// works for one author), also without any author scope.
	assert.equal(buildWorksParams("water", 5).get("filter"), "type:!peer-review|supplementary-materials|paratext|dataset|grant");
}

/* ---------------- accessFromWork ---------------- */
{
	// Hybrid article: best location first, then every OTHER open location;
	// closed locations and image files (graphical abstracts) are left out.
	const hybrid = accessFromWork({
		type: "article",
		open_access: { is_oa: true, oa_status: "hybrid" },
		best_oa_location: { pdf_url: "https://ars.els-cdn.com/content/image/ga1_lrg.jpg" },
		locations: [
			{ is_oa: false, pdf_url: "https://www.sciencedirect.com/closed/pdf" },
			{ is_oa: true, pdf_url: "https://upcommons.upc.edu/bitstreams/x/download" },
			{ is_oa: true, pdf_url: "https://upcommons.upc.edu/bitstreams/x/download" },
			{ is_oa: true, pdf_url: null },
		],
	});
	assert.deepEqual(hybrid, {
		level: "free",
		oa_status: "hybrid",
		pdf_urls: ["https://upcommons.upc.edu/bitstreams/x/download"],
	});
	// Conference abstract: abstract_only even though OpenAlex calls it gold.
	assert.equal(accessFromWork({ type: "conference-abstract", open_access: { is_oa: true, oa_status: "gold" } }).level, "abstract_only");
	assert.deepEqual(accessFromWork({ type: "article", open_access: { is_oa: false, oa_status: "closed" } }), { level: "restricted", oa_status: "closed" });
	assert.deepEqual(accessFromWork({}), { level: "unknown" });
}

// Rate limiting: the works search goes through the paced search client, so
// a 429 is retried after the server's Retry-After (not dropped as a dead
// source) and the failure names the free key. The wizard's author typing
// row sends ONE attempt: a retry sleep there would freeze the keystroke.
{
	const realFetch = globalThis.fetch;
	const sentAt: number[] = [];
	let answers: number[] = [];
	globalThis.fetch = (async () => {
		sentAt.push(Date.now());
		const status = answers.shift() ?? 200;
		const body = status === 200 ? JSON.stringify({ results: [{ doi: "https://doi.org/10.1/ok", title: "Ok" }] }) : "";
		// Retry-After 1 keeps the test fast; the rule itself (header wins
		// over the fixed 5 s backoff) is covered in polite.test.ts.
		return new Response(body, { status, headers: { "retry-after": "1" } });
	}) as typeof fetch;
	try {
		answers = [429];
		const records = await searchOpenalex("x", 5);
		assert.equal(sentAt.length, 2); // one retry, then the answer
		assert.ok(sentAt[1] - sentAt[0] >= 990, `retry after ${sentAt[1] - sentAt[0]} ms, expected the Retry-After second`);
		assert.deepEqual(records.map((r) => r.doi), ["10.1/ok"]);
		// Budget used up -> the error carries the key hint.
		sentAt.length = 0;
		answers = [429, 429, 429];
		await assert.rejects(() => searchOpenalex("x", 5), /OpenAlex answered HTTP 429 .*FREE API key/);
		// Typing row: exactly one request, immediate failure, no sleep.
		sentAt.length = 0;
		answers = [429];
		const before = Date.now();
		await assert.rejects(() => autocompleteAuthors("Moortgat"), /OpenAlex answered HTTP 429/);
		assert.equal(sentAt.length, 1);
		assert.ok(Date.now() - before < 900, "autocomplete must not sleep on a rate limit");
	} finally {
		globalThis.fetch = realFetch;
	}
}

// buildFacetParams: the pickers ask with the works search's own boolean
// expression, in title and abstract only, with the same type exclusion and
// the live scope; no search= and no per-page (per-page collapses group_by
// to one bucket). Commas and pipes cannot live inside a filter value.
{
	const params = buildFacetParams("(Water Level) AND (Monitoring) AND (River)", "authorships.author.id", {
		yearFrom: 2017, sourceIds: ["S1"], blocks: [["water level"], ["monitoring"], ["river"]],
	});
	assert.equal(params.get("search"), null);
	assert.equal(params.get("per-page"), null);
	assert.equal(params.get("group_by"), "authorships.author.id");
	assert.equal(params.get("filter"),
		'title_and_abstract.search:"water level" AND monitoring AND river,'
		+ "type:!peer-review|supplementary-materials|paratext|dataset|grant,"
		+ "from_publication_date:2017-01-01,primary_location.source.id:S1");
	// Without blocks (quoted or field-syntax queries) the text goes as is.
	assert.ok(buildFacetParams("sar, flood | mapping", "primary_location.source.id").get("filter")!
		.startsWith("title_and_abstract.search:sar flood mapping,type:!"));
}

console.log("openalex.test.ts: all assertions passed");
