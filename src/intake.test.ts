/**
 * Tests for the pure intake-dialog helpers.
 * Run: node src/intake.test.ts
 */

import assert from "node:assert/strict";
import {
	alignBlocksToBase,
	alignVariantExpression,
	deriveCoreGroupsFromQuery,
	deriveGroupsFromQuery,
	formatGroupExpression,
	isBlockExpression,
	isProseQuery,
	parseGroupSpec,
	parseGroupTerms,
	parsePerSource,
	parseVariantLines,
	parseYearRange,
	queryBlocks,
	sortVariantsByBreadth,
	yearRangeToSpec,
} from "./intake.ts";

// formatGroupExpression: groups AND-linked, terms OR-linked
{
	assert.equal(
		formatGroupExpression([["river", "fluvial"], ["sandbar", "bar"], ["sentinel"]]),
		"(river OR fluvial) AND (sandbar OR bar) AND (sentinel)",
	);
	assert.equal(formatGroupExpression([]), "");
	assert.equal(formatGroupExpression([[], ["a"]]), "(a)"); // empty groups dropped
}

// parseGroupTerms: "a,b;c,d" syntax, whitespace-tolerant, blanks dropped
{
	assert.deepEqual(parseGroupTerms("river,fluvial;sandbar,bar"), [
		["river", "fluvial"],
		["sandbar", "bar"],
	]);
	assert.deepEqual(parseGroupTerms(" river , fluvial ; ; sandbar "), [
		["river", "fluvial"],
		["sandbar"],
	]);
	assert.deepEqual(parseGroupTerms(""), []);
	assert.deepEqual(parseGroupTerms(" ; , ; "), []);
}

// parseGroupSpec: the displayed AND/OR expression is directly editable
{
	assert.deepEqual(parseGroupSpec("(river OR fluvial) AND (sandbar OR bar)"), [
		["river", "fluvial"],
		["sandbar", "bar"],
	]);
	assert.deepEqual(parseGroupSpec("river or fluvial and sandbar"), [
		["river", "fluvial"],
		["sandbar"],
	]); // keywords case-insensitive, parens optional
	assert.deepEqual(parseGroupSpec("(remote sensing OR earth observation) AND (uav)"), [
		["remote sensing", "earth observation"],
		["uav"],
	]); // multi-word terms survive
	assert.deepEqual(parseGroupSpec("(sensor OR radar)"), [["sensor", "radar"]]); // "or" inside a word does not split
	assert.deepEqual(parseGroupSpec("river,fluvial;sandbar"), [["river", "fluvial"], ["sandbar"]]); // legacy syntax still accepted
	assert.deepEqual(parseGroupSpec(""), []);
}

// round trip: groups -> displayed expression -> groups
{
	const groups = [["river", "fluvial"], ["sandbar", "bar"], ["sentinel", "s-1", "s-2"]];
	assert.deepEqual(parseGroupSpec(formatGroupExpression(groups)), groups);
}

// parseYearRange: accepted forms
{
	assert.deepEqual(parseYearRange("2015-2024"), { yearFrom: 2015, yearTo: 2024 });
	assert.deepEqual(parseYearRange("2015-"), { yearFrom: 2015 });
	assert.deepEqual(parseYearRange("-2024"), { yearTo: 2024 });
	assert.deepEqual(parseYearRange("2020"), { yearFrom: 2020, yearTo: 2020 });
	assert.deepEqual(parseYearRange("  2015 - 2024  "), { yearFrom: 2015, yearTo: 2024 });
	assert.deepEqual(parseYearRange(""), {});
	assert.deepEqual(parseYearRange("   "), {});
}

// parseYearRange: rejected forms -> null (dialog keeps the proposal)
{
	assert.equal(parseYearRange("-"), null);
	assert.equal(parseYearRange("letzte 10 Jahre"), null);
	assert.equal(parseYearRange("2024-2015"), null); // inverted range
	assert.equal(parseYearRange("15-24"), null); // two-digit years
}

// yearRangeToSpec: prefill strings
{
	assert.equal(yearRangeToSpec(2015, 2024), "2015-2024");
	assert.equal(yearRangeToSpec(2015, undefined), "2015-");
	assert.equal(yearRangeToSpec(undefined, 2024), "-2024");
	assert.equal(yearRangeToSpec(2020, 2020), "2020");
	assert.equal(yearRangeToSpec(undefined, undefined), "");
}

// parsePerSource: whole numbers clamped to [1, max]; anything else -> null
{
	assert.equal(parsePerSource("25", 50), 25);
	assert.equal(parsePerSource(" 10 ", 50), 10);
	assert.equal(parsePerSource("200", 50), 50); // clamped to the politeness cap
	assert.equal(parsePerSource("1", 50), 1);
	assert.equal(parsePerSource("0", 50), null);
	assert.equal(parsePerSource("", 50), null);
	assert.equal(parsePerSource("ten", 50), null);
	assert.equal(parsePerSource("12.5", 50), null);
	assert.equal(parsePerSource("-5", 50), null);
}

// deriveGroupsFromQuery (v30): one AND group per content word; standalone
// single chars bind to the neighbouring word (v18 arXiv rule); function
// words drop out; the user's own boolean syntax derives nothing.
{
	assert.deepEqual(
		deriveGroupsFromQuery("sandbar detection rivers Sentinel-2"),
		[["sandbar"], ["detection"], ["rivers"], ["sentinel-2"]],
	);
	// "Sentinel 2": the standalone digit binds to the word before it.
	assert.deepEqual(
		deriveGroupsFromQuery("Sentinel 2 sandbar detection"),
		[["sentinel 2"], ["sandbar"], ["detection"]],
	);
	// Function words (both languages) never form groups.
	assert.deepEqual(
		deriveGroupsFromQuery("detection of sandbars in rivers"),
		[["detection"], ["sandbars"], ["rivers"]],
	);
	assert.deepEqual(
		deriveGroupsFromQuery("Erkennung von Sandbänken in Flüssen"),
		[["erkennung"], ["sandbänken"], ["flüssen"]],
	);
	// The user's own operators or quotes: no second-guessing, no derivation.
	assert.deepEqual(deriveGroupsFromQuery("(river OR fluvial) AND sandbar"), []);
	assert.deepEqual(deriveGroupsFromQuery('"river sandbar" detection'), []);
	assert.deepEqual(deriveGroupsFromQuery(""), []);
	assert.deepEqual(deriveGroupsFromQuery("   "), []);
	// 2026-08-10 (prose field find): punctuation glued to a word never
	// enters the term ("approach," derived as all:approach, before); inner
	// hyphens and dots stay ("4.0"); sentence glue like "based"/"as"/
	// "beyond" is a stopword now.
	assert.deepEqual(
		deriveGroupsFromQuery("digitalization based on RAMI 4.0, beyond industrial environments"),
		[["digitalization"], ["rami"], ["4.0"], ["industrial"], ["environments"]],
	);
	assert.deepEqual(
		deriveGroupsFromQuery("components as a general approach,"),
		[["components"], ["general"], ["approach"]],
	);
	// The derived groups round-trip through the dialog's expression form.
	assert.equal(
		formatGroupExpression(deriveGroupsFromQuery("Sentinel 2 sandbar detection")),
		"(sentinel 2) AND (sandbar) AND (detection)",
	);
	assert.deepEqual(
		parseGroupSpec(formatGroupExpression(deriveGroupsFromQuery("Sentinel 2 sandbar detection"))),
		[["sentinel 2"], ["sandbar"], ["detection"]],
	);
}

// isProseQuery (2026-08-10): six or more derived blocks mark a prose
// sentence; the user's own boolean/quote/field syntax is never prose.
{
	assert.equal(isProseQuery(
		"Digitalization based on RAMI 4.0 I4.0 Components as a general digitalization approach, beyond industrial environments",
	), true);
	assert.equal(isProseQuery("sandbar detection rivers Sentinel-1 Sentinel-2"), false);
	assert.equal(isProseQuery("(river OR fluvial) AND sandbar AND x AND y AND z AND w"), false);
	assert.equal(isProseQuery('"a long quoted phrase that would otherwise derive many blocks here"'), false);
	assert.equal(isProseQuery(""), false);
}

// deriveCoreGroupsFromQuery (v30.2): the broader variant drops generic
// task/method words; domain concepts and bound phrases stay.
{
	assert.deepEqual(
		deriveCoreGroupsFromQuery("Water Mask Extraction Using Sentinel 2"),
		[["water"], ["mask"], ["sentinel 2"]],
	);
	assert.deepEqual(
		deriveCoreGroupsFromQuery("Erkennung von Sandbänken in Flüssen"),
		[["sandbänken"], ["flüssen"]],
	);
	// Nothing but task words: no core to anchor on -> empty (caller treats
	// it as "no grouping").
	assert.deepEqual(deriveCoreGroupsFromQuery("detection and classification methods"), []);
	// User syntax still derives nothing.
	assert.deepEqual(deriveCoreGroupsFromQuery("(a OR b) AND c"), []);
}

// parseVariantLines (2026-08-06): LLM suggestion output -> clean variant
// list. Models habitually number, bullet and quote despite instructions.
{
	assert.deepEqual(
		parseVariantLines(
			'1. "river water segmentation"\n- surface water mapping satellite\n* Water Mask Extraction\n\n2) river extraction remote sensing',
			"water mask extraction",
		),
		["river water segmentation", "surface water mapping satellite", "river extraction remote sensing"],
	);
	// Case-insensitive dedupe against the base query AND among the lines.
	assert.deepEqual(
		parseVariantLines("Water Mask\nwater mask\nsurface water", "Water Mask"),
		["surface water"],
	);
	// The cap holds.
	assert.deepEqual(
		parseVariantLines("a1\na2\na3", "base", 2),
		["a1", "a2"],
	);
	// Junk/empty input -> empty list, never a throw.
	assert.deepEqual(parseVariantLines("", "base"), []);
	assert.deepEqual(parseVariantLines("\n- \n\"\"\n", "base"), []);
	// German quotes strip too.
	assert.deepEqual(parseVariantLines("„Wassermaske Sentinel-2“", "base"), ["Wassermaske Sentinel-2"]);
}

// sortVariantsByBreadth (2026-08-10): suggestions run narrow-to-broad no
// matter what order the model emitted -- fewer terms first, then fewer
// base-foreign terms, ties keep the model's order (stable).
{
	const base = queryBlocks("water mask satellite");
	// Term count decides first: the broad 9-term row falls behind the
	// narrow 4-term row although the model emitted it first.
	assert.deepEqual(
		sortVariantsByBreadth(
			[
				"(water OR waterbody OR hydrology) AND (mask OR mapping OR segmentation) AND (satellite OR spaceborne OR remote sensing)",
				"(water) AND (mask OR mapping) AND (satellite)",
			],
			base,
		),
		[
			"(water) AND (mask OR mapping) AND (satellite)",
			"(water OR waterbody OR hydrology) AND (mask OR mapping OR segmentation) AND (satellite OR spaceborne OR remote sensing)",
		],
	);
	// Same term count: the row with fewer base-foreign terms comes first.
	assert.deepEqual(
		sortVariantsByBreadth(
			[
				"(waterbody OR hydrology) AND (segmentation OR delineation)",
				"(water OR waterbody) AND (mask OR mapping)",
			],
			base,
		),
		[
			"(water OR waterbody) AND (mask OR mapping)",
			"(waterbody OR hydrology) AND (segmentation OR delineation)",
		],
	);
	// Fully tied rows keep the model's order.
	assert.deepEqual(
		sortVariantsByBreadth(["(a OR b) AND (c)", "(d OR e) AND (f)"], base),
		["(a OR b) AND (c)", "(d OR e) AND (f)"],
	);
	// parseVariantLines applies the sort end-to-end.
	assert.deepEqual(
		parseVariantLines(
			"(water OR waterbody OR hydrology) AND (mask OR mapping OR segmentation)\n(water) AND (mask)",
			"water mask satellite",
		),
		["(water) AND (mask)", "(water OR waterbody OR hydrology) AND (mask OR mapping OR segmentation)"],
	);
}

// alignBlocksToBase / alignVariantExpression (2026-08-07): suggestions
// mirror the base query's concept order, so all variant rows share one
// parallel structure. AND blocks are commutative -- display order only.
{
	// The user's example: base "Sentinel Water Detection in Rivers" wants
	// sensor block first, then water/river, then task -- whatever order
	// the model produced.
	assert.equal(
		alignVariantExpression(
			"(water body OR water surface OR river) AND (sentinel OR satellite) AND (detection OR classification OR segmentation)",
			queryBlocks("Sentinel Water Detection in Rivers"),
		),
		"(sentinel OR satellite) AND (water body OR water surface OR river) AND (detection OR classification OR segmentation)",
	);
	// Word tolerances carry over from termMatches: base "rivers" anchors
	// "river channel" (plural-s, phrase words).
	assert.equal(
		alignVariantExpression(
			"(change detection OR mapping) AND (river channel OR stream network)",
			queryBlocks("Rivers Detection"),
		),
		"(river channel OR stream network) AND (change detection OR mapping)",
	);
	// A block matching no base concept KEEPS its position -- the model may
	// have placed a pure synonym block correctly; only anchored blocks
	// reorder among themselves.
	assert.deepEqual(
		alignBlocksToBase(
			[["river", "stream"], ["radar"], ["sentinel"]],
			[["sentinel"], ["river"]],
		),
		[["sentinel"], ["radar"], ["river", "stream"]],
	);
	// Plain-keyword suggestions and hands-off syntax pass through untouched.
	assert.equal(
		alignVariantExpression("surface water mapping satellite", queryBlocks("water mask")),
		"surface water mapping satellite",
	);
	assert.equal(
		alignVariantExpression('(a OR b) AND "water mask"', queryBlocks("water mask")),
		'(a OR b) AND "water mask"',
	);
	// parseVariantLines aligns before dedupe: the emitted line is the
	// canonical reordered expression.
	assert.deepEqual(
		parseVariantLines("(water OR river) AND (sentinel OR landsat)", "sentinel water"),
		["(sentinel OR landsat) AND (water OR river)"],
	);
}

// isBlockExpression / queryBlocks (2026-08-06 block search): ONE structure
// per query drives the boolean fetch and the labeling.
{
	// Plain keywords derive one block per content word (v18/v30 rules).
	assert.equal(isBlockExpression("water mask sentinel 2"), false);
	assert.deepEqual(queryBlocks("Water Mask Sentinel 2"), [["water"], ["mask"], ["sentinel 2"]]);
	// UPPERCASE operators / parentheses / the legacy a,b;c spec parse.
	assert.equal(isBlockExpression("(river OR stream) AND (mask)"), true);
	assert.deepEqual(queryBlocks("(river OR stream) AND (mask)"), [["river", "stream"], ["mask"]]);
	assert.equal(isBlockExpression("river,stream;mask"), true);
	// Lowercase and/or are everyday words, not operators.
	assert.equal(isBlockExpression("rivers and streams"), false);
	// Quotes and arXiv field syntax are the user's own source syntax: no
	// blocks, the sources keep their legacy pass-through paths.
	assert.deepEqual(queryBlocks('"water mask" sentinel'), []);
	assert.deepEqual(queryBlocks("all:water AND cat:eess.IV"), []);
	assert.deepEqual(queryBlocks("ti:flood mapping"), []);
}

console.log("intake.test.ts: all assertions passed");
