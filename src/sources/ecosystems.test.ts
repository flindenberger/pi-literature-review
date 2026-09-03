/**
 * Offline tests for the ecosyste.ms clients: parsers pinned to the shapes
 * measured on 2026-09-03, the slug-form pagination URL (numeric ids lose
 * the query string on redirect) and the page loop.
 * Run: node src/sources/ecosystems.test.ts
 */

import assert from "node:assert/strict";
import { fetchRepoMeta, listEntries, listEntriesUrl, listsForTopic, MAX_LIST_PAGES, parseListEntries, parseLists, parseRepoMeta } from "./ecosystems.ts";

// parseRepoMeta
{
	assert.deepEqual(parseRepoMeta({ created_at: "2018-09-28T06:37:19.000Z", stargazers_count: 888, archived: false }),
		{ createdAt: "2018-09-28T06:37:19.000Z", stars: 888, archived: false });
	assert.deepEqual(parseRepoMeta({}), { createdAt: null, stars: null, archived: false });
	assert.equal(parseRepoMeta(null), null);
}

// parseLists: GitHub lists with a count, largest first; junk skipped.
{
	const lists = parseLists([
		{ url: "https://github.com/opengeos/Awesome-GEE", projects_count: 207 },
		{ url: "https://github.com/satellite-image-deep-learning/techniques", projects_count: 1750 },
		{ url: "https://github.com/x/unsynced", projects_count: null },
		{ url: "https://gitlab.com/a/b", projects_count: 5 },
	]);
	assert.deepEqual(lists.map((l) => l.slug), ["satellite-image-deep-learning/techniques", "opengeos/Awesome-GEE"]);
	assert.equal(lists[0].projectsCount, 1750);
	assert.deepEqual(parseLists({ error: "not found" }), []);
}

// parseListEntries: name/description/category + canonical repo URL.
{
	const entries = parseListEntries([
		{ name: "hydra-floods", description: "An open source Python application ...", category: "Python API", project: { url: "https://github.com/Servir-Mekong/hydra-floods" } },
		{ name: "Global Surface Water Explorer", description: "", category: "Websites", project: { url: "https://global-surface-water.appspot.com/" } },
		{ name: null, project: null },
	]);
	assert.equal(entries.length, 3);
	assert.equal(entries[0].repoUrl, "https://github.com/Servir-Mekong/hydra-floods");
	assert.equal(entries[0].category, "Python API");
	assert.equal(entries[1].repoUrl, null);
	assert.deepEqual(entries[2], { name: "", description: "", category: "", repoUrl: null });
}

// listEntriesUrl: slug form, never a numeric id.
{
	assert.equal(listEntriesUrl("satellite-image-deep-learning/techniques", 3),
		"https://awesome.ecosyste.ms/api/v1/lists/satellite-image-deep-learning%2Ftechniques/list_projects?per_page=100&page=3");
}

// Network paths with a stubbed fetch: repo meta 404 -> null; topic lists;
// page loop stops on a short page and never exceeds MAX_LIST_PAGES.
{
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown) => {
		const u = String(url);
		calls.push(u);
		if (u.includes("/repositories/none/none")) return new Response("{}", { status: 404 });
		if (u.includes("/repositories/")) return new Response(JSON.stringify({ created_at: "2020-01-01T00:00:00.000Z", stargazers_count: 7 }), { status: 200 });
		if (u.includes("/lists?")) return new Response(JSON.stringify([{ url: "https://github.com/a/list", projects_count: 3 }]), { status: 200 });
		const page = Number(new URL(u).searchParams.get("page"));
		if (u.includes("endless")) {
			return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ name: `p${page}-${i}` }))), { status: 200 });
		}
		const size = page === 1 ? 100 : 5;
		return new Response(JSON.stringify(Array.from({ length: size }, (_, i) => ({ name: `p${page}-${i}`, project: { url: "https://github.com/o/r" } }))), { status: 200 });
	}) as typeof fetch;
	try {
		assert.equal(await fetchRepoMeta("none", "none"), null);
		assert.deepEqual(await fetchRepoMeta("kvos", "CoastSat"), { createdAt: "2020-01-01T00:00:00.000Z", stars: 7, archived: false });
		assert.ok(calls[1].endsWith("/repositories/kvos/CoastSat"));
		const lists = await listsForTopic("remote-sensing");
		assert.equal(lists[0].slug, "a/list");
		assert.ok(calls[2].includes("topic=remote-sensing"));
		calls.length = 0;
		const entries = await listEntries("a/list");
		assert.equal(entries.length, 105);
		assert.equal(calls.length, 2);
		assert.ok(calls[0].includes("/lists/a%2Flist/list_projects?per_page=100&page=1"));
		calls.length = 0;
		const endless = await listEntries("a/endless");
		assert.equal(calls.length, MAX_LIST_PAGES);
		assert.equal(endless.length, 100 * MAX_LIST_PAGES);
	} finally {
		globalThis.fetch = realFetch;
	}
}

console.log("ecosystems.test.ts: all assertions passed");
