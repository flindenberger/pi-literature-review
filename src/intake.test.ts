/**
 * Tests for the pure intake-dialog helpers.
 * Run: node src/intake.test.ts
 */

import assert from "node:assert/strict";
import {
	alignBlocksToBase,
	alignVariantExpression,
	arxivVariantPrompt,
	blocksForEditing,
	capVariantBlocks,
	deriveGroupsFromQuery,
	formatGroupExpression,
	isBlockExpression,
	isProseQuery,
	parseGroupSpec,
	parseGroupTerms,
	parseArxivSuggestion,
	parsePerSource,
	parseTopicLines,
	parseVariantSuggestions,
	parseYearRange,
	queryBlocks,
	queryFromBlockAnswers,
	topicPrompt,
	topicSlug,
	variantPrompt,
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

// deriveGroupsFromQuery: one AND group per content word; standalone
// single chars bind to the neighbouring word (arXiv rule); function
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
	// punctuation glued to a word never
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

// isProseQuery: six or more derived blocks mark a prose
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

/** Text-only view of the parsed suggestions (the roles are tested separately). */
const parseVariantLines = (raw: string, base: string): string[] =>
	parseVariantSuggestions(raw, base).map((entry) => entry.text);

// parseVariantLines: LLM suggestion output -> clean variant
// list. Models habitually number, bullet and quote despite instructions.
{
	assert.deepEqual(
		parseVariantLines(
			'1. "river water segmentation"\n- surface water mapping satellite\n* Water Mask Extraction\n\n2) river extraction remote sensing',
			"water mask extraction",
		),
		["river water segmentation", "surface water mapping satellite"],
	);
	// Case-insensitive dedupe against the base query AND among the lines.
	assert.deepEqual(
		parseVariantLines("Water Mask\nwater mask\nsurface water", "Water Mask"),
		["surface water"],
	);
	// Two unmarked rows at most (plus1, plus2); further lines are ignored.
	assert.deepEqual(
		parseVariantLines("a1\na2\na3", "base"),
		["a1", "a2"],
	);
	// Junk/empty input -> empty list, never a throw.
	assert.deepEqual(parseVariantLines("", "base"), []);
	assert.deepEqual(parseVariantLines("\n- \n\"\"\n", "base"), []);
	// German quotes strip too.
	assert.deepEqual(parseVariantLines("„Wassermaske Sentinel-2“", "base"), ["Wassermaske Sentinel-2"]);
}

// alignBlocksToBase / alignVariantExpression: suggestions
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

// isBlockExpression / queryBlocks: ONE structure
// per query drives the boolean fetch and the labeling.
{
	// Plain keywords derive one block per content word (derivation rules).
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

// parseVariantSuggestions: three role slots in fixed order. The
// arXiv-marked line fills "arxiv" wherever the model put it, the first
// unmarked line "plus1", the next "plus2"; the marker is stripped.
{
	const raw = "1. arXiv: (river OR water body) AND (segmentation OR mapping) AND (satellite OR SAR)\n"
		+ "2. river sandbar satellite\n3. sandbar remote sensing";
	const parsed = parseVariantSuggestions(raw, "sandbar detection");
	assert.deepEqual(parsed.map((entry) => entry.role), ["plus1", "plus2", "arxiv"]);
	assert.equal(parsed[0]!.text, "river sandbar satellite");
	assert.ok(!/arxiv:/i.test(parsed[2]!.text), "marker stripped");
	// A second arXiv-marked line is ignored; a missing role is left out.
	assert.deepEqual(
		parseVariantSuggestions("arXiv: a b\narXiv: c d", "base").map((entry) => [entry.role, entry.text]),
		[["arxiv", "a b"]],
	);
	// A row that collapses onto an earlier one after capping frees its
	// slot for the next line.
	assert.deepEqual(
		parseVariantLines(
			"(satellite OR remote sensing) AND (river OR fluvial)\n"
			+ "(satellite OR remote sensing OR x) AND (river OR fluvial)\n"
			+ "(satellite OR Sentinel OR remote sensing) AND (river OR river channel OR fluvial)",
			"satellite AND river",
		).length,
		2,
	);
}

// capVariantBlocks: the role's breadth holds whatever the model emitted.
// plus1/plus2 keep the base block's own terms first and add at most one
// or two synonyms; the arXiv row keeps at most three terms per block.
{
	const base = queryBlocks("satellite AND river AND water classification");
	const bloated = "(remote sensing OR satellite OR earth observation OR spaceborne) AND "
		+ "(river OR stream network OR fluvial OR river channel) AND "
		+ "(water body mapping OR water classification OR water segmentation)";
	assert.equal(
		capVariantBlocks(bloated, base, "plus1"),
		"(satellite OR remote sensing) AND (river OR stream network) AND (water classification OR water body mapping)",
	);
	assert.equal(
		capVariantBlocks(bloated, base, "plus2"),
		"(satellite OR remote sensing OR earth observation) AND (river OR stream network OR fluvial) "
		+ "AND (water classification OR water body mapping OR water segmentation)",
	);
	assert.equal(
		capVariantBlocks("(a OR b OR c OR d) AND (e OR f)", base, "arxiv"),
		"(a OR b OR c) AND (e OR f)",
	);
	// The user's own synonyms count as base terms and are never cut:
	// "+1" is counted from them.
	assert.equal(
		capVariantBlocks(
			"(satellite OR SAR OR radar OR Sentinel) AND (river OR fluvial OR stream network)",
			queryBlocks("(satellite OR SAR) AND river"),
			"plus1",
		),
		"(satellite OR SAR OR radar) AND (river OR fluvial)",
	);
	// A block sharing no word with the base takes the base block at the
	// same position when the block counts agree ...
	assert.equal(
		capVariantBlocks("(earth observation OR spaceborne OR orbital) AND (river OR fluvial)",
			queryBlocks("(satellite OR SAR) AND river"), "plus1"),
		"(earth observation OR spaceborne OR orbital) AND (river OR fluvial)",
	);
	// ... and counts as one base term otherwise.
	assert.equal(
		capVariantBlocks("(orbital OR spaceborne OR x) AND (river OR fluvial) AND (y)", queryBlocks("river"), "plus1"),
		"(orbital OR spaceborne) AND (river OR fluvial) AND (y)",
	);
	// Plain keywords and hands-off syntax pass through untouched.
	assert.equal(capVariantBlocks("a b c d e", base, "plus1"), "a b c d e");
	assert.equal(capVariantBlocks('"a b" AND (c OR d OR e OR f)', base, "plus1"), '"a b" AND (c OR d OR e OR f)');
}

// parseArxivSuggestion: the follow-up answer -> one capped arXiv row,
// marker optional; nothing usable or a repeat -> null.
{
	assert.equal(
		parseArxivSuggestion("- arXiv: (a OR b OR c OR d) AND (e)", "base", []),
		"(a OR b OR c) AND (e)",
	);
	assert.equal(parseArxivSuggestion("\n(a OR b) AND (e)\nnoise", "base", []), "(a OR b) AND (e)");
	assert.equal(parseArxivSuggestion("", "base", []), null);
	assert.equal(parseArxivSuggestion("arXiv: (a OR b) AND (e)", "base", ["(a OR b) AND (e)"]), null);
}

// queryFromBlockAnswers: the query tab's block form -> one query string.
// Blocks serialize parenthesized; a filled free text IS the query.
{
	assert.deepEqual(
		queryFromBlockAnswers(["satellite imagery OR remote sensing", "data fusion"], ""),
		{ query: "(satellite imagery OR remote sensing) AND (data fusion)", bothFilled: false },
	);
	// Commas separate synonyms too; empty/whitespace fields drop out.
	assert.deepEqual(
		queryFromBlockAnswers(["river, fluvial", "  ", "sandbar"], ""),
		{ query: "(river OR fluvial) AND (sandbar)", bothFilled: false },
	);
	// A single block keeps its parentheses (round-trips as an expression).
	assert.equal(queryFromBlockAnswers(["deep learning"], "").query, "(deep learning)");
	// A stray AND inside one field reads as synonyms -- one field is one
	// concept by definition.
	assert.equal(queryFromBlockAnswers(["a AND b"], "").query, "(a OR b)");
	// Everything empty -> empty query (the submit mapping cancels honestly).
	assert.deepEqual(queryFromBlockAnswers(["", " "], " "), { query: "", bothFilled: false });
	// Filled free text wins verbatim; blocks alongside flag the warning.
	assert.deepEqual(
		queryFromBlockAnswers(["satellite"], " water mapping from space "),
		{ query: "water mapping from space", bothFilled: true },
	);
	assert.deepEqual(
		queryFromBlockAnswers(["", ""], "water mapping"),
		{ query: "water mapping", bothFilled: false },
	);
	// Round-trip: queryBlocks over the serialized form yields exactly the
	// entered blocks (search and labeling see what the tab showed), and
	// re-serializing is byte-stable (loader keys must not churn).
	const composed = queryFromBlockAnswers(["satellite OR remote sensing", "data fusion"], "").query;
	assert.deepEqual(queryBlocks(composed), [["satellite", "remote sensing"], ["data fusion"]]);
	assert.equal(
		queryFromBlockAnswers(queryBlocks(composed).map((group) => group.join(" OR ")), "").query,
		composed,
	);
}

// blocksForEditing: prefill routing for the block form -- expressions
// split into one line per block, everything else belongs in free text.
{
	assert.deepEqual(blocksForEditing("(river OR fluvial) AND (sandbar)"), ["river OR fluvial", "sandbar"]);
	assert.deepEqual(blocksForEditing("river,fluvial;sandbar"), ["river OR fluvial", "sandbar"]);
	assert.equal(blocksForEditing("water mask satellite"), null); // plain keywords
	assert.equal(blocksForEditing('"water mask" AND satellite'), null); // hands-off quotes
	assert.equal(blocksForEditing("ti:water AND abs:mask"), null); // arXiv field syntax
	assert.equal(blocksForEditing(""), null);
}

// variantPrompt: the block-faithful branch pins the block count for
// expression bases (user-authored structure), stays absent for plain and
// prose bases, and never touches the arXiv-line rule.
{
	const faithful = variantPrompt("(river OR stream) AND (sandbar)", "", false);
	assert.ok(faithful.includes("exactly 2 concept block(s)"));
	assert.ok(faithful.includes("SAME number of concept blocks"));
	assert.ok(faithful.includes("arXiv: "), "arXiv marker rule kept");
	assert.ok(faithful.includes("The arXiv line follows its own rule instead."));
	const plain = variantPrompt("water mask satellite", "", false);
	assert.ok(!plain.includes("SAME number of concept blocks"));
	assert.ok(plain.includes("2-4 concept blocks"));
	const prose = variantPrompt("i would like papers about water mapping from satellites", "", true);
	assert.ok(prose.includes("faithful distillation"));
	assert.ok(!prose.includes("SAME number of concept blocks"));
	// Hands-off syntax (quotes) yields no blocks -> never block-faithful.
	assert.ok(!variantPrompt('"water mask" AND satellite', "", false).includes("SAME number of concept blocks"));
	// The steering hint rides as its own line.
	assert.ok(variantPrompt("x", "more deep learning", false).includes("more deep learning"));
	// The three roles are spelled out in order.
	assert.ok(plain.includes("Line 1: the base query's own terms plus exactly ONE synonym"));
	assert.ok(plain.includes("Line 2: the base query's own terms plus at most TWO synonyms"));
	// The follow-up prompt asks for the arXiv line alone, hint included.
	const retry = arxivVariantPrompt("water mask satellite", "more SAR");
	assert.ok(retry.includes("more SAR"));
	assert.ok(retry.includes("Output exactly one line, starting with 'arXiv: '"));
}

// List topics for the code tab: slug normalisation, the prompt carries
// the block chain and the field rule, the parser strips list markup,
// drops generic/duplicate topics and caps.
{
	assert.equal(topicSlug("Remote Sensing"), "remote-sensing");
	assert.equal(topicSlug("  earth_observation "), "earth-observation");
	assert.equal(topicSlug("Sentinel-2!"), "sentinel-2");
	assert.equal(topicSlug("--gis--"), "gis");
	assert.equal(topicSlug("###"), "");
	const prompt = topicPrompt("water body mapping", [["satellite", "Sentinel-2"], ["water body", "river"]], 5);
	assert.ok(prompt.includes("(satellite OR Sentinel-2) AND (water body OR river)"));
	assert.ok(prompt.includes("up to 5 GitHub topics"));
	assert.ok(prompt.includes("not the words of the search itself"));
	assert.ok(topicPrompt("plain words", [], 3).includes("Literature search: plain words"));
	assert.deepEqual(
		parseTopicLines("1. remote-sensing\n- `Earth Observation`\n* \"hydrology\"\nmachine-learning\nremote sensing\n2) GIS\nagriculture\nclimate"),
		["remote-sensing", "earth-observation", "hydrology", "gis", "agriculture"],
	);
	assert.deepEqual(parseTopicLines("awesome\npython\n\n"), []);
	assert.deepEqual(parseTopicLines("Here are some topics you could use for this search, hopefully they help\nremote-sensing"), ["remote-sensing"]);
	assert.deepEqual(parseTopicLines("a\nbioinformatics", 1), ["bioinformatics"]);
}

console.log("intake.test.ts: all assertions passed");
