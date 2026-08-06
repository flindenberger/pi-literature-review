/**
 * Offline tests for the OpenAlex helpers (v30.6: journal facets behind
 * the wizard's journal picker).
 * Run: node src/sources/openalex.test.ts
 */

import assert from "node:assert/strict";
import { buildAuthorSearchFilter, buildBlockSearch, buildFacetFilter, parseFacetPage, parseFacets } from "./openalex.ts";

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

console.log("openalex.test.ts: all assertions passed");
