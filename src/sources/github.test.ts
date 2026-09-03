/**
 * Offline tests for the shared GitHub client: URL parsing, the aggregator
 * name filter and the raw README fetch (global fetch stubbed).
 * Run: node src/sources/github.test.ts
 */

import assert from "node:assert/strict";
import { fetchReadme, LIST_REPO_NAME, parseRepoUrl, repoUrl, searchRepositories } from "./github.ts";

// parseRepoUrl: owner/repo out of every common GitHub URL form.
{
	assert.deepEqual(parseRepoUrl("https://github.com/kvos/CoastSat"), { owner: "kvos", repo: "CoastSat" });
	assert.deepEqual(parseRepoUrl("http://www.github.com/kvos/CoastSat.git"), { owner: "kvos", repo: "CoastSat" });
	assert.deepEqual(parseRepoUrl("https://github.com/kvos/CoastSat/tree/main/src"), { owner: "kvos", repo: "CoastSat" });
	assert.deepEqual(parseRepoUrl("https://github.com/kvos/CoastSat#readme"), { owner: "kvos", repo: "CoastSat" });
	assert.equal(parseRepoUrl("https://github.com/kvos"), null);
	assert.equal(parseRepoUrl("https://gitlab.com/a/b"), null);
	assert.equal(parseRepoUrl("not a url"), null);
	assert.equal(repoUrl("kvos", "CoastSat"), "https://github.com/kvos/CoastSat");
}

// LIST_REPO_NAME: aggregator and star lists die, real names survive.
{
	for (const name of ["awesome-stars", "my-awesome-stars", "starred", "stars", "cv-arxiv-daily", "Robust_arXiv_daily", "papers-we-love", "curated-list"]) {
		assert.ok(LIST_REPO_NAME.test(name), `should match list name ${name}`);
	}
	for (const name of ["starship", "CoastSat", "floodmaps", "gff", "SegmentingWater", "hydra-floods"]) {
		assert.ok(!LIST_REPO_NAME.test(name), `should keep repo name ${name}`);
	}
}

// fetchReadme: README.md on HEAD, 404 = null, text otherwise;
// searchRepositories: q and per_page on the search URL.
{
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown) => {
		const u = String(url);
		calls.push(u);
		if (u.includes("/none/none/")) return new Response("404: Not Found", { status: 404 });
		if (u.startsWith("https://api.github.com/search/repositories")) {
			return new Response(JSON.stringify({ items: [{ html_url: "https://github.com/a/b", name: "b" }] }), { status: 200 });
		}
		return new Response("# Title\nSee https://arxiv.org/abs/2411.01411", { status: 200 });
	}) as typeof fetch;
	try {
		assert.equal(await fetchReadme("none", "none"), null);
		assert.equal(calls[0], "https://raw.githubusercontent.com/none/none/HEAD/README.md");
		const text = await fetchReadme("microsoft", "ai4g-flood");
		assert.ok(text?.includes("2411.01411"));
		const items = await searchRepositories('water "arxiv.org" in:readme', 30);
		assert.equal(items.length, 1);
		const searchUrl = new URL(calls[2]);
		assert.equal(searchUrl.searchParams.get("q"), 'water "arxiv.org" in:readme');
		assert.equal(searchUrl.searchParams.get("per_page"), "30");
	} finally {
		globalThis.fetch = realFetch;
	}
}

console.log("github.test.ts: all assertions passed");
