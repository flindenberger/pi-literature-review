/**
 * Logic tests for the deterministic output-path rules (no filesystem writes;
 * existence is injected). Run: node src/output.test.ts
 */

import assert from "node:assert/strict";
import { htmlPathFor, jsonPathFor, querySlug } from "./output.ts";

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

// htmlPathFor: date + slug under queries/; collisions get _2, _3, ...
{
	const none = () => false;
	assert.equal(
		htmlPathFor("/data", "2026-07-09T12:00:00Z", "sandbar rivers", none),
		"/data/queries/2026-07-09_sandbar_rivers.html",
	);
	const taken = new Set([
		"/data/queries/2026-07-09_sandbar_rivers.html",
		"/data/queries/2026-07-09_sandbar_rivers_2.html",
	]);
	assert.equal(
		htmlPathFor("/data", "2026-07-09T12:00:00Z", "sandbar rivers", (p) => taken.has(p)),
		"/data/queries/2026-07-09_sandbar_rivers_3.html",
	);
}

// jsonPathFor: sidecar shares the basename, whatever the html extension case
{
	assert.equal(jsonPathFor("/data/queries/2026-07-09_q.html"), "/data/queries/2026-07-09_q.json");
	assert.equal(jsonPathFor("/data/queries/2026-07-09_q_2.html"), "/data/queries/2026-07-09_q_2.json");
	assert.equal(jsonPathFor("/x/report.HTML"), "/x/report.json");
	assert.equal(jsonPathFor("/x/no-extension"), "/x/no-extension.json"); // explicit odd override still gets a sidecar
}

// pair collision policy: a leftover .json alone must also push to the next suffix
{
	const taken = new Set(["/data/queries/2026-07-09_sandbar_rivers.json"]);
	const pairExists = (p: string) => taken.has(p) || taken.has(jsonPathFor(p));
	assert.equal(
		htmlPathFor("/data", "2026-07-09T12:00:00Z", "sandbar rivers", pairExists),
		"/data/queries/2026-07-09_sandbar_rivers_2.html",
	);
}

console.log("output.test.ts: all assertions passed");
