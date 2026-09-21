/**
 * Offline tests for the search engine's source stage: sources run
 * concurrently, yet records, counts and sources_used come out in the fixed
 * source order. Fake searchers, a stubbed fetch for the verify HEADs, no
 * enrichment -- no network.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyRequirement, runSearch, SEARCHERS } from "./search.ts";
import type { SourceRecord } from "./types.ts";

// Hermetic config: an empty config dir, no S2 key in the environment.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "pi-lit-search-test-"));
delete process.env.PI_LITERATURE_REVIEW_S2_API_KEY;

const record = (source: string, doi: string, title: string): SourceRecord => ({
	title, authors: ["A. Author"], year: "2022", venue: "Journal", doi, arxiv_id: "",
	pdf_url: "", url: "", cites: 1, source, abstract: "river sandbar satellite",
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

{
	const realFetch = globalThis.fetch;
	const saved = { ...SEARCHERS };
	// verify HEADs: every DOI resolves (3xx)
	globalThis.fetch = (async () => new Response(null, { status: 302 })) as typeof fetch;
	// The FIRST source is the slow one: a sequential engine would need
	// 300 + 300 ms, and a completion-order merge would put "fast" first.
	SEARCHERS.slow = async (query) => {
		await sleep(300);
		return [record("slow", `10.1/slow-${query.length}`, `Slow paper ${query}`)];
	};
	SEARCHERS.fast = async (query) => {
		await sleep(300);
		return [record("fast", `10.1/fast-${query.length}`, `Fast paper ${query}`)];
	};
	SEARCHERS.broken = async () => {
		throw new Error("source down");
	};
	try {
		const started = Date.now();
		const payload = await runSearch({
			query: "river sandbar",
			queryVariants: ["sandbar satellite imagery"],
			sources: ["slow", "broken", "fast"],
			enrich: false,
		});
		const elapsed = Date.now() - started;
		// two queries x 300 ms per source; concurrent sources -> ~600 ms, not 1200
		assert.ok(elapsed < 1100, `sources ran sequentially (${elapsed} ms)`);
		assert.deepEqual(payload.sources_used, ["slow", "fast"]);
		assert.deepEqual(payload.source_counts?.map((c) => c.source), ["slow", "slow", "fast", "fast"]);
		assert.deepEqual(payload.source_failures?.map((f) => f.source), ["broken (Q1)", "broken (Q2)"]);
		// merge order = source order, then query order (never completion order)
		assert.deepEqual(payload.results.map((r) => r.title), [
			"Slow paper river sandbar", "Slow paper sandbar satellite imagery",
			"Fast paper river sandbar", "Fast paper sandbar satellite imagery",
		]);
	} finally {
		globalThis.fetch = realFetch;
		for (const key of Object.keys(SEARCHERS)) if (!(key in saved)) delete SEARCHERS[key];
	}
}

// Semantic Scholar without an API key: not queried, reported as a neutral
// skip (never as a failed source); with a key it is a regular source.
{
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(null, { status: 302 })) as typeof fetch;
	SEARCHERS.fast = async () => [record("fast", "10.1/fast", "Fast paper")];
	try {
		const payload = await runSearch({ query: "river sandbar", sources: ["fast", "semanticscholar"], enrich: false });
		assert.deepEqual(payload.sources_used, ["fast"]);
		assert.equal(payload.source_failures, null);
		assert.equal(payload.sources_skipped?.[0].source, "semanticscholar");
		assert.ok(payload.sources_skipped?.[0].reason.includes("needs a free API key"));
		assert.equal(keyRequirement("crossref"), null);
		process.env.PI_LITERATURE_REVIEW_S2_API_KEY = "test-key";
		assert.equal(keyRequirement("semanticscholar"), null);
	} finally {
		delete process.env.PI_LITERATURE_REVIEW_S2_API_KEY;
		globalThis.fetch = realFetch;
		delete SEARCHERS.fast;
	}
}

console.log("search.test.ts: all assertions passed");
