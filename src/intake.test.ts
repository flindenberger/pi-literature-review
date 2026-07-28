/**
 * Tests for the pure intake-dialog helpers.
 * Run: node src/intake.test.ts
 */

import assert from "node:assert/strict";
import {
	deriveCoreGroupsFromQuery,
	deriveGroupsFromQuery,
	formatGroupExpression,
	parseGroupSpec,
	parseGroupTerms,
	parsePerSource,
	parseYearRange,
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

console.log("intake.test.ts: all assertions passed");
