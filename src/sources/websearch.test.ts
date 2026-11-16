/**
 * Offline tests for the web search engines: response parsing for SearXNG
 * and Exa, engine choice from the configuration (SearXNG first, nothing
 * without either).
 * Run: node src/sources/websearch.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An empty private config: the user's real settings must not decide the test.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "plr-websearch-"));
delete process.env.PI_LITERATURE_REVIEW_EXA_API_KEY;
delete process.env.PI_LITERATURE_REVIEW_SEARXNG_URL;

const { parseExaResults, parseSearxngResults, webEngine } = await import("./websearch.ts");

// SearXNG JSON: url/title/content; non-web addresses and junk dropped.
{
	const hits = parseSearxngResults({
		query: "sandbar",
		results: [
			{ url: "https://github.com/kk-hydro/sandbar-detector", title: "sandbar-detector", content: "Detect sandbars", engine: "google" },
			{ url: "javascript:alert(1)", title: "x", content: "y" },
			{ title: "no url" },
		],
	});
	assert.deepEqual(hits, [{ url: "https://github.com/kk-hydro/sandbar-detector", title: "sandbar-detector", text: "Detect sandbars" }]);
	assert.deepEqual(parseSearxngResults({}), []);
	assert.deepEqual(parseSearxngResults(null), []);
}

// Exa JSON: text plus highlights joined; missing fields tolerated.
{
	const hits = parseExaResults({
		requestId: "r",
		results: [
			{ url: "https://github.com/conorosully/SWED-edge-detection", title: "SWED", score: 0.9, text: "README text https://arxiv.org/abs/2405.11494", highlights: ["coastline", 3] },
			{ url: "https://example.org/page", title: null },
		],
	});
	assert.equal(hits.length, 2);
	assert.equal(hits[0].text, "README text https://arxiv.org/abs/2405.11494\ncoastline");
	assert.deepEqual(hits[1], { url: "https://example.org/page", title: "", text: "" });
	assert.deepEqual(parseExaResults({ error: "Payment required" }), []);
}

// Engine choice: none by default, Exa with a key, SearXNG first when both.
{
	assert.equal(webEngine({}), null);
	assert.equal(webEngine({ PI_LITERATURE_REVIEW_EXA_API_KEY: "k" }), "exa");
	assert.equal(webEngine({ PI_LITERATURE_REVIEW_EXA_API_KEY: "k", PI_LITERATURE_REVIEW_SEARXNG_URL: "http://127.0.0.1:8888/" }), "searxng");
}

console.log("websearch.test.ts: all assertions passed");
