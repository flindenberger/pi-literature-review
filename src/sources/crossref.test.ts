/**
 * Offline tests for the pure CrossRef helpers.
 * Run: node src/sources/crossref.test.ts
 */

import assert from "node:assert/strict";
import { buildCrossrefParams, flattenBlockTerms } from "./crossref.ts";

// flattenBlockTerms: CrossRef has no boolean search -- blocks arrive as
// flat, deduplicated relevance keywords, order kept, quotes stripped.
{
	assert.equal(
		flattenBlockTerms([["river", "stream"], ["water extraction"], ["river"]]),
		"river stream water extraction",
	);
	assert.equal(flattenBlockTerms([['"Sentinel 2"'], ["Sentinel 2"]]), "Sentinel 2");
	assert.equal(flattenBlockTerms([]), "");
	assert.equal(flattenBlockTerms(undefined), "");
	assert.equal(flattenBlockTerms([["  ", ""]]), "");
}

// buildCrossrefParams: author scope "all" drops the text query and sends
// the author field alone, citation-sorted; otherwise text plus author.
{
	const byQuery = buildCrossrefParams("water flood", 5, { authors: ["Claudia Kuenzer"], blocks: [["water"], ["flood"]] });
	assert.equal(byQuery.get("query"), "water flood");
	assert.equal(byQuery.get("query.author"), "Claudia Kuenzer");
	assert.equal(byQuery.get("sort"), "relevance");
	const all = buildCrossrefParams("water flood", 5, { authors: ["Claudia Kuenzer"], authorScope: "all" });
	assert.equal(all.get("query"), null);
	assert.equal(all.get("query.author"), "Claudia Kuenzer");
	assert.equal(all.get("sort"), "relevance");
	assert.equal(buildCrossrefParams("water", 5, { authorScope: "all" }).get("query"), "water");
	// Positive type list on EVERY request (CrossRef has no negative filter):
	// scholarly works only, so peer-review reports and author replies
	// ("Reply on RC2", typed peer-review; 7 of the first 10 hits of a plain
	// query.author request, measured 2026-09-15) never arrive.
	const filter = buildCrossrefParams("water", 5).get("filter")!;
	assert.ok(filter.startsWith("type:journal-article,type:proceedings-article,type:posted-content"));
	assert.ok(!filter.includes("peer-review"));
	assert.equal(all.get("filter"), filter);
}

console.log("crossref.test.ts: all assertions passed");
