/**
 * Logic tests for the deterministic output-path rules (no filesystem writes;
 * existence is injected). Run: node src/output.test.ts
 */

import assert from "node:assert/strict";
import { htmlPathFor, jsonPathFor, querySlug, synthReportName } from "./output.ts";

// querySlug: keyword-preserving, deterministic sanitization
{
	assert.equal(
		querySlug("sandbar detection rivers Sentinel-1 Sentinel-2"),
		"sandbar_detection_rivers_Sentinel-1_Sentinel-2",
	);
	assert.equal(querySlug('  weird / "query" & (stuff)?  '), "weird_query_stuff");
	assert.equal(querySlug("___"), "query"); // nothing usable left
	assert.equal(querySlug("a".repeat(200)).length, 80); // capped
	assert.ok(!querySlug(`x${"_".repeat(100)}y`).endsWith("_")); // no trailing _ after cap
}

// htmlPathFor: date + slug under lit-search/; collisions get _2, _3, ...
{
	const none = () => false;
	assert.equal(
		htmlPathFor("/data", "2026-07-09T12:00:00Z", "sandbar rivers", none),
		"/data/lit-search/2026-07-09_sandbar_rivers.html",
	);
	const taken = new Set([
		"/data/lit-search/2026-07-09_sandbar_rivers.html",
		"/data/lit-search/2026-07-09_sandbar_rivers_2.html",
	]);
	assert.equal(
		htmlPathFor("/data", "2026-07-09T12:00:00Z", "sandbar rivers", (p) => taken.has(p)),
		"/data/lit-search/2026-07-09_sandbar_rivers_3.html",
	);
}

// jsonPathFor: sidecar shares the basename, whatever the html extension case
{
	assert.equal(jsonPathFor("/data/lit-search/2026-07-09_q.html"), "/data/lit-search/2026-07-09_q.json");
	assert.equal(jsonPathFor("/data/lit-search/2026-07-09_q_2.html"), "/data/lit-search/2026-07-09_q_2.json");
	assert.equal(jsonPathFor("/x/report.HTML"), "/x/report.json");
	assert.equal(jsonPathFor("/x/no-extension"), "/x/no-extension.json"); // explicit odd override still gets a sidecar
}

// pair collision policy: a leftover .json alone must also push to the next suffix
{
	const taken = new Set(["/data/lit-search/2026-07-09_sandbar_rivers.json"]);
	const pairExists = (p: string) => taken.has(p) || taken.has(jsonPathFor(p));
	assert.equal(
		htmlPathFor("/data", "2026-07-09T12:00:00Z", "sandbar rivers", pairExists),
		"/data/lit-search/2026-07-09_sandbar_rivers_2.html",
	);
}

/* ---------------- htmlPathFor: stage subdir ---------------- */
{
	const none = () => false;
	// The synthesis stage writes to reviews/ with identical naming rules.
	assert.equal(
		htmlPathFor("/data", "2026-07-15T09:00:00Z", "How are sandbars detected?", none, "reviews"),
		"/data/reviews/2026-07-15_How_are_sandbars_detected.html",
	);
	// Default stays lit-search/ so existing callers are untouched.
	assert.equal(
		htmlPathFor("/data", "2026-07-15T09:00:00Z", "q", none),
		"/data/lit-search/2026-07-15_q.html",
	);
	const taken = new Set(["/data/reviews/2026-07-15_q.html"]);
	assert.equal(
		htmlPathFor("/data", "2026-07-15T09:00:00Z", "q", (p) => taken.has(p), "reviews"),
		"/data/reviews/2026-07-15_q_2.html",
	);
}

/* ---------------- synthReportName: the report names its papers ---------------- */
{
	const paper = (authors: string[]) => ({ authors });
	// First authors' last names in scope order, both API spellings.
	assert.equal(
		synthReportName([paper(["Wei Li", "Q Chen"]), paper(["Moortgat, J."]), paper(["Hong Chen"])]),
		"synthesis_report_Li_Moortgat_Chen",
	);
	// One paper: one name, no et_al.
	assert.equal(synthReportName([paper(["Anna Kryniecka"])]), "synthesis_report_Kryniecka");
	// More papers than listed names -> et_al (a library report).
	assert.equal(
		synthReportName([paper(["A Li"]), paper(["B Moortgat"]), paper(["C Chen"]), paper(["D Vos"])]),
		"synthesis_report_Li_Moortgat_Chen_et_al",
	);
	// Same first author twice counts once, and the remaining paper makes it et_al.
	assert.equal(
		synthReportName([paper(["Wei Li"]), paper(["Wei Li"])]),
		"synthesis_report_Li_et_al",
	);
	// Umlauts transliterate; papers without authors contribute nothing.
	assert.equal(
		synthReportName([paper([]), paper(["Jürgen Müller"])]),
		"synthesis_report_Mueller_et_al",
	);
	// No name anywhere: the caller's question slug stands.
	assert.equal(synthReportName([paper([]), paper([""])]), null);
	assert.equal(synthReportName([]), null);
}

console.log("output.test.ts: all assertions passed");
