/**
 * Logic tests for the pure pipeline functions (no network). Records here are
 * synthetic test fixtures for exercising filter/dedupe logic -- they are
 * never shown to a user as papers.
 *
 * Run: node src/pipeline.test.ts
 */

import assert from "node:assert/strict";
import {
	applyFilters,
	dedupe,
	filterRecords,
	group,
	groupAll,
	sanitizeTermGroups,
	sortRecords,
} from "./pipeline.ts";
import type { SourceRecord } from "./types.ts";

function record(overrides: Partial<SourceRecord>): SourceRecord {
	return {
		title: "A Title",
		authors: ["An Author"],
		year: "2020",
		venue: "",
		doi: "",
		arxiv_id: "",
		pdf_url: "",
		url: "",
		cites: null,
		source: "crossref",
		abstract: "",
		...overrides,
	};
}

// filter: empty title / empty authors are dropped with reasons, rest kept
{
	const { kept, dropped } = filterRecords([
		record({ title: "" }),
		record({ authors: [] }),
		record({ title: "Real paper" }),
	]);
	assert.equal(kept.length, 1);
	assert.equal(kept[0].title, "Real paper");
	assert.deepEqual(dropped.map((d) => d.reason), ["empty title", "empty author list"]);
}

// dedupe: same DOI (case-insensitive) merges; richer record wins, gaps fill
{
	const merged = dedupe([
		record({ doi: "10.1234/ABC", venue: "", cites: 3, source: "crossref", abstract: "long abstract text" }),
		record({ doi: "10.1234/abc", venue: "Some Journal", cites: 7, source: "openalex" }),
	]);
	assert.equal(merged.length, 1);
	assert.deepEqual(merged[0].sources.sort(), ["crossref", "openalex"]);
	assert.equal(merged[0].venue, "Some Journal"); // gap filled from the other record
	assert.equal(merged[0].abstract, "long abstract text"); // existing value never rewritten
	assert.equal(merged[0].cites, 7); // max of both counts
}

// dedupe: no DOI falls back to arXiv ID; no identifier at all stays separate
{
	const merged = dedupe([
		record({ arxiv_id: "2401.16393v1", source: "arxiv" }),
		record({ arxiv_id: "2401.16393V1", source: "openalex" }),
		record({ title: "No identifier A" }),
		record({ title: "No identifier B" }),
	]);
	assert.equal(merged.length, 3);
	assert.deepEqual(merged[0].sources.sort(), ["arxiv", "openalex"]);
}

// dedupe: version suffixes (OSF "_v1" DOIs, arXiv "v2") mean the same paper
{
	const merged = dedupe([
		record({ doi: "10.31227/osf.io/pz6jv", source: "crossref" }),
		record({ doi: "10.31227/osf.io/pz6jv_v1", source: "crossref", venue: "V" }),
		record({ arxiv_id: "2311.10579v1", source: "arxiv" }),
		record({ arxiv_id: "2311.10579v2", source: "openalex" }),
	]);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].venue, "V"); // merged, gap filled
	assert.deepEqual(merged[1].sources.sort(), ["arxiv", "openalex"]);
}

// dedupe: found_by (query variants) is unioned across merged records
{
	const merged = dedupe([
		record({ doi: "10.1/v", found_by: ["query one"], source: "crossref" }),
		record({ doi: "10.1/V", found_by: ["query two"], source: "openalex" }),
		record({ doi: "10.1/V", found_by: ["query one"], source: "arxiv" }),
	]);
	assert.equal(merged.length, 1);
	assert.deepEqual(merged[0].found_by, ["query one", "query two"]);
}

// dedupe: first-seen order is preserved
{
	const merged = dedupe([
		record({ doi: "10.1/first" }),
		record({ doi: "10.1/second" }),
		record({ doi: "10.1/FIRST", venue: "V" }),
	]);
	assert.deepEqual(merged.map((r) => r.doi.toLowerCase()), ["10.1/first", "10.1/second"]);
}

// group: on_target needs a hit from EVERY term group, case-insensitive
{
	const rules = sanitizeTermGroups([["river", "fluvial"], ["sandbar", "bar"], ["sentinel"]]);
	const vistula = { title: "Sentinel-2 study of alternate sandbars", abstract: "Vistula River reach" };
	const coastal = { title: "Submerged sandbar crest from Sentinel-2", abstract: "Mediterranean beaches" };
	assert.equal(group(vistula, rules), "on_target");
	assert.equal(group(coastal, rules), "adjacent"); // no river context -> adjacent
}

// groupAll: on_target sorts first; without rules, records stay ungrouped
{
	const rules = sanitizeTermGroups([["match"]]);
	const grouped = groupAll(
		[record({ title: "no hit", abstract: "" }), record({ title: "a match here", abstract: "" })],
		rules,
	);
	assert.deepEqual(grouped.map((r) => r.group), ["on_target", "adjacent"]);
	const ungrouped = groupAll([record({ title: "anything" })], sanitizeTermGroups(undefined));
	assert.equal("group" in ungrouped[0], false);
}

// sanitizeTermGroups: trims, lowercases, drops empty terms/groups/garbage
{
	assert.deepEqual(
		sanitizeTermGroups([[" River ", ""], [], ["S-1"], "garbage", [42]]),
		[["river"], ["s-1"]],
	);
	assert.deepEqual(sanitizeTermGroups("not a list"), []);
}

// user filters: every rule drops with a reason; unknown cites pass min_cites
{
	const fr = (over: object) => ({
		cites: 50, year: "2021", venue: "Remote Sensing", pdf_url: "x", verified: true, ...over,
	});
	const { kept, dropped } = applyFilters(
		[
			fr({}), // passes everything below
			fr({ cites: 3 }), // fails minCites
			fr({ cites: null }), // UNKNOWN count passes minCites
			fr({ year: "2015" }), // fails yearFrom
			fr({ year: null }), // unknown year cannot prove range -> dropped
			fr({ venue: "" }), // venue-less fails venue request
			fr({ venue: "Nature" }), // wrong venue
			fr({ pdf_url: "" }), // fails requirePdf
			fr({ verified: false }), // fails verifiedOnly
		],
		{ minCites: 10, yearFrom: 2019, yearTo: 2026, venues: ["remote sensing"], requirePdf: true, verifiedOnly: true },
	);
	assert.equal(kept.length, 2);
	assert.equal(dropped.length, 7);
	assert.ok(dropped.every((d) => d.reason.startsWith("filtered: ")));
}

// no filters -> everything passes untouched
{
	const { kept, dropped } = applyFilters(
		[{ cites: null, year: null, venue: "", pdf_url: "", verified: false }],
		{},
	);
	assert.equal(kept.length, 1);
	assert.equal(dropped.length, 0);
}

// sort: descending, unknown values last, input untouched
{
	const input = [
		{ cites: 5, year: "1999" },
		{ cites: null, year: "2026" },
		{ cites: 300, year: null },
	];
	assert.deepEqual(sortRecords(input, "cites").map((r) => r.cites), [300, 5, null]);
	assert.deepEqual(sortRecords(input, "year").map((r) => r.year), ["2026", "1999", null]);
	assert.equal(input[0].cites, 5); // original order untouched
}

console.log("pipeline.test.ts: all assertions passed");
