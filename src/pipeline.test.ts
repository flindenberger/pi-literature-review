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
	dropWithoutAbstract,
	filterRecords,
	group,
	groupAcrossQueries,
	groupAll,
	sanitizeTermGroups,
	sortRecords,
	termMatches,
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

// termMatches: whole words only -- no substring hits (v18)
{
	assert.equal(termMatches("using s2 imagery", "s2"), true);
	assert.equal(termMatches("the s2gis toolbox", "s2"), false); // no match inside words
	assert.equal(termMatches("the rs2 sensor", "s2"), false);
	assert.equal(termMatches("a sandbar in the river", "bar"), false); // "bar" no longer hits "sandbar"
	assert.equal(termMatches("a sandbarrier model", "sandbar"), false);
}

// termMatches: optional plural-s, nothing more (user decision, v18)
{
	assert.equal(termMatches("alternate sandbars move", "sandbar"), true);
	assert.equal(termMatches("one sandbar", "sandbar"), true);
	assert.equal(termMatches("a sandbank", "sandbar"), false); // no stemming
}

// termMatches: hyphen and whitespace inside a term are interchangeable (user decision, v18)
{
	assert.equal(termMatches("sentinel-2 images", "sentinel-2"), true);
	assert.equal(termMatches("sentinel 2 images", "sentinel-2"), true);
	assert.equal(termMatches("sentinel-2 images", "sentinel 2"), true);
	assert.equal(termMatches("sentinel-1 images", "sentinel-2"), false);
	// generic term still matches the specific compound's word part
	assert.equal(termMatches("sentinel-2 images", "sentinel"), true);
}

// group: the ALOHA 2 incident fixture (arXiv noise) hits zero groups -> adjacent
{
	const rules = sanitizeTermGroups([
		["sentinel-2", "satellite"],
		["sandbar", "sediment"],
		["detection", "classification"],
	]);
	const aloha = {
		title: "ALOHA 2: An Enhanced Low-Cost Hardware for Bimanual Teleoperation",
		abstract:
			"Diverse demonstration datasets have powered significant advances in robot " +
			"learning, but the dexterity and scale of such data can be limited by the hardware " +
			"cost, the hardware robustness, and the ease of teleoperation. We introduce ALOHA 2, " +
			"an enhanced version of ALOHA that has greater performance, ergonomics, and " +
			"robustness compared to the original design. To accelerate research in large-scale " +
			"bimanual manipulation, we open source all hardware designs of ALOHA 2 with a " +
			"detailed tutorial, together with a MuJoCo model of ALOHA 2 with system identification.",
	};
	assert.equal(group(aloha, rules), "adjacent");
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

// groupAcrossQueries (2026-08-06, revised same day on user decision): a
// record is on_target when it fully matches ANY confirmed query's blocks,
// regardless of which query found it -- the field case: a surface-water
// review found only by the strict base query must not stay adjacent when
// a variant's blocks match it fully.
{
	const blockSets = [
		sanitizeTermGroups([["water"], ["mask"]]),
		sanitizeTermGroups([["surface water", "water body"], ["satellite", "remote sensing"]]),
		[], // a quoted/field-syntax query carries no blocks; ignored
	];
	const records = [
		// The Wieland case: misses the strict base blocks (no "mask") but
		// fully matches the variant's blocks -> on_target now.
		record({ title: "Semantic segmentation of water bodies in satellite images", abstract: "" }),
		// Matches the base blocks only -> on_target too (any set counts).
		record({ title: "a water mask paper", abstract: "" }),
		// Matches no set fully -> adjacent.
		record({ title: "water levels from gauges", abstract: "" }),
	] as SourceRecord[];
	const grouped = groupAcrossQueries(records, blockSets);
	const byTitle = new Map(grouped.map((r) => [r.title, r.group]));
	assert.equal(byTitle.get("Semantic segmentation of water bodies in satellite images"), "on_target");
	assert.equal(byTitle.get("a water mask paper"), "on_target");
	assert.equal(byTitle.get("water levels from gauges"), "adjacent");
	// on_target rows sort first.
	assert.equal(grouped[grouped.length - 1].title, "water levels from gauges");
	// Evidence (2026-08-06): the winning set's number and the exact term
	// that hit per block travel with the record; adjacent records carry
	// nothing. The Wieland record wins via set 2 (1-based query numbers).
	const wieland = grouped.find((r) => r.title.startsWith("Semantic segmentation"));
	assert.deepEqual(wieland?.group_matched, { query: 2, terms: ["water body", "satellite"] });
	assert.equal(grouped.find((r) => r.title === "water levels from gauges")?.group_matched, undefined);
	// The field case that motivated the evidence line: a pedestrian-
	// detection CNN paper earns on_target through the homonym "stream"
	// (two-stream networks) plus generic terms -- the evidence names them.
	const pedestrian = groupAcrossQueries(
		[record({
			title: "Multispectral pedestrian detection via a two-stream network",
			abstract: "We improve feature extraction for pedestrians.",
		})],
		[sanitizeTermGroups([["satellite", "multispectral"], ["fluvial", "stream"], ["boundary detection", "feature extraction"]])],
	);
	assert.equal(pedestrian[0].group, "on_target");
	assert.deepEqual(pedestrian[0].group_matched, {
		query: 1,
		terms: ["multispectral", "stream", "feature extraction"],
	});
	// No blocks anywhere: records pass through ungrouped.
	const untouched = groupAcrossQueries([record({ title: "anything" })], [[], []]);
	assert.equal("group" in untouched[0], false);
}

// termMatches third tolerance (2026-08-06 user decision): consonant+y
// takes the English ies-plural; vowel+y stays on the s-path; the old
// guarantees hold.
{
	assert.equal(termMatches("semantic segmentation of water bodies", "water body"), true);
	assert.equal(termMatches("two case studies", "study"), true);
	assert.equal(termMatches("several surveys", "survey"), true); // vowel+y -> s
	assert.equal(termMatches("the body of work", "body"), true); // singular still matches
	assert.equal(termMatches("nobody expects it", "body"), false); // whole word only
	assert.equal(termMatches("sandbarrier", "sandbar"), false); // no stemming beyond plurals
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

// "Other journals/sources" (v30.11): the picker's catch-all row keeps every
// journal that is NOT on the listed head, so checking every row filters
// nothing at all -- "select all" can never exclude.
{
	const fr = (venue: string) => ({
		cites: 50, year: "2021", venue, authors: ["A"], pdf_url: "x", verified: true,
	});
	const listed = ["Remote Sensing", "Water", "Sensors"];
	const records = [
		fr("Remote Sensing"), // listed AND selected
		fr("Water"), // listed, NOT selected -> the only drop
		fr("Acta Scientiarum Polonorum"), // unlisted -> "other"
		fr(""), // venue-less preprint -> "other"
	];
	const other = applyFilters(records, {
		venues: ["Remote Sensing", "Sensors"], venuesOther: true, venuesListed: listed,
	});
	assert.equal(other.kept.length, 3);
	assert.equal(other.dropped.length, 1);
	assert.equal(other.dropped[0].record.venue, "Water");
	assert.ok(other.dropped[0].reason.includes("listed journal that was not selected"));
	// Everything checked: no filter -- including the venue-less record.
	assert.equal(
		applyFilters(records, { venues: listed, venuesOther: true, venuesListed: listed }).dropped.length,
		0,
	);
	// Without the catch-all row the whitelist semantics stay untouched.
	const strict = applyFilters(records, { venues: ["Remote Sensing", "Sensors"] });
	assert.equal(strict.kept.length, 1);
	assert.equal(strict.dropped.length, 3);
	// "other" without a list of what IS listed excludes nothing, honestly.
	assert.equal(applyFilters(records, { venuesOther: true }).dropped.length, 0);
}

// author filter (v30.9): any listed name substring may match any author;
// no match drops with a reason
{
	const fr = (authors: string[]) => ({
		cites: 50, year: "2021", venue: "Remote Sensing", authors, pdf_url: "x", verified: true,
	});
	const { kept, dropped } = applyFilters(
		[
			fr(["A. Kryniecka", "B. Magnuszewski"]), // matches "kryniecka"
			fr(["C. Calvillo"]), // no match
			fr(["Jan Magnuszewski"]), // matches the second substring
		],
		{ authors: ["Kryniecka", "magnuszewski"] },
	);
	assert.equal(kept.length, 2);
	assert.equal(dropped.length, 1);
	assert.ok(dropped[0].reason.includes("no author matches Kryniecka, magnuszewski"));
}

// "Other authors" (v30.11): the author picker's catch-all row keeps every
// record whose authors are all OFF the listed head -- so checking every row
// filters nothing, exactly like the journal picker.
{
	const fr = (authors: string[]) => ({
		cites: 50, year: "2021", venue: "Remote Sensing", authors, pdf_url: "x", verified: true,
	});
	const listed = ["Claudia Kuenzer", "Xiao Xiang Zhu", "Meisam Amani"];
	const records = [
		fr(["Claudia Kuenzer", "Someone Else"]), // listed AND selected
		fr(["Xiao Xiang Zhu"]), // listed, NOT selected -> the only drop
		fr(["A. Nobody", "B. Unknown"]), // nobody listed -> "other"
	];
	const other = applyFilters(records, {
		authors: ["Claudia Kuenzer"], authorsOther: true, authorsListed: listed,
	});
	assert.equal(other.kept.length, 2);
	assert.equal(other.dropped.length, 1);
	assert.deepEqual(other.dropped[0].record.authors, ["Xiao Xiang Zhu"]);
	assert.ok(other.dropped[0].reason.includes("only listed authors that were not selected"));
	// Everything checked = no filter; and without a listed head "other"
	// excludes nobody.
	assert.equal(
		applyFilters(records, { authors: listed, authorsOther: true, authorsListed: listed }).dropped.length,
		0,
	);
	assert.equal(applyFilters(records, { authorsOther: true }).dropped.length, 0);
	// A record with a listed co-author is NOT "other" -- co-authorship with
	// a deselected name is enough to drop it (documented semantics).
	assert.equal(
		applyFilters([fr(["A. Nobody", "Meisam Amani"])], { authorsOther: true, authorsListed: listed }).dropped.length,
		1,
	);
}

// minGroups (v30.3): the wide "any two concepts" variant -- on_target when
// at least minGroups of the term groups match; default stays "all"
{
	const record = (title: string) => ({ title, abstract: "" });
	const groups = [["water"], ["mask"], ["sentinel 2"]];
	assert.equal(group(record("water mask study"), groups), "adjacent"); // strict: all three needed
	assert.equal(group(record("water mask study"), groups, 2), "on_target"); // any two suffice
	assert.equal(group(record("water study"), groups, 2), "adjacent"); // one is not enough
	assert.equal(group(record("mask of the sentinel-2 sensor"), groups, 2), "on_target"); // hyphen tolerance holds
	// minGroups above the group count degrades to "all" (never impossible).
	assert.equal(group(record("water mask sentinel 2"), groups, 5), "on_target");
}

// min journal score (v30): drops only records WITH a lower score; records
// without a score (preprints, unmatched venues) always pass -- absence of
// the open JIF analog is not evidence against the paper
{
	const fr = (over: object) => ({
		cites: 50, year: "2021", venue: "Remote Sensing", pdf_url: "x", verified: true, ...over,
	});
	const { kept, dropped } = applyFilters(
		[
			fr({ journal_2yr_citedness: 5.2 }), // passes
			fr({ journal_2yr_citedness: 1.1 }), // below the threshold
			fr({}), // no score at all -> passes
		],
		{ minJournalScore: 3 },
	);
	assert.equal(kept.length, 2);
	assert.equal(dropped.length, 1);
	assert.ok(dropped[0].reason.includes("journal score 1.1 < requested minimum 3"));
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

// abstract gate (2026-08-10): records still without an abstract after
// enrichment move to dropped with the caller's reason; whitespace-only
// counts as empty; order preserved.
{
	const { kept, dropped } = dropWithoutAbstract(
		[
			{ title: "a", abstract: "Real text." },
			{ title: "b", abstract: "" },
			{ title: "c", abstract: "   " },
			{ title: "d", abstract: "Also real." },
		],
		"no abstract (sources, the OpenAlex and the Semantic Scholar lookup delivered none)",
	);
	assert.deepEqual(kept.map((r) => r.title), ["a", "d"]);
	assert.deepEqual(dropped.map((d) => d.record.title), ["b", "c"]);
	assert.ok(dropped.every((d) => d.reason === "no abstract (sources, the OpenAlex and the Semantic Scholar lookup delivered none)"));
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
