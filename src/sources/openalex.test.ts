/**
 * Offline tests for the OpenAlex helpers (v30.6: journal facets behind
 * the wizard's journal picker).
 * Run: node src/sources/openalex.test.ts
 */

import assert from "node:assert/strict";
import { parseFacetPage, parseFacets } from "./openalex.ts";

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

console.log("openalex.test.ts: all assertions passed");
