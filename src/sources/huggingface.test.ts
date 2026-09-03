/**
 * Offline tests for the Hugging Face Papers client: query building and the
 * response parser, pinned to the shape measured on 2026-09-03.
 * Run: node src/sources/huggingface.test.ts
 */

import assert from "node:assert/strict";
import { buildHfQuery, parseHfPapers, searchHfPapers } from "./huggingface.ts";

// buildHfQuery: blocks flatten to words (no boolean syntax there), else the
// plain query.
{
	assert.equal(buildHfQuery("ignored", [["water", "river"], ["segmentation"]]), "water river segmentation");
	assert.equal(buildHfQuery("  flood mapping SAR ", []), "flood mapping SAR");
	assert.equal(buildHfQuery("flood mapping SAR"), "flood mapping SAR");
}

// parseHfPapers: measured shape -- [{paper:{id, title, githubRepo, githubStars}}].
{
	const fixture = [
		{ paper: { id: "2305.01698", title: "DeepAqua: Self-Supervised Semantic Segmentation of Wetlands from SAR\n  Images", githubRepo: "https://github.com/melqkiades/deep-wetlands", githubStars: 18 } },
		{ paper: { id: "2410.05624", title: "Remote Sensing Image Segmentation Using Vision Mamba", githubRepo: null } },
		{ paper: { id: "not-an-id", title: "junk" } },
		{ paper: { id: "2107.07933", title: "Panoptic Segmentation", githubRepo: "https://github.com/VSainteuf/utae-paps.git" } },
	];
	const papers = parseHfPapers(fixture);
	assert.equal(papers.length, 3);
	assert.deepEqual(papers[0], { arxivId: "2305.01698", title: "DeepAqua: Self-Supervised Semantic Segmentation of Wetlands from SAR Images", repoUrl: "https://github.com/melqkiades/deep-wetlands", stars: 18 });
	assert.equal(papers[1].repoUrl, null);
	assert.equal(papers[1].stars, null);
	assert.equal(papers[2].repoUrl, "https://github.com/VSainteuf/utae-paps");
	assert.throws(() => parseHfPapers({ results: [] }), /unexpected response shape/);
	assert.throws(() => parseHfPapers([{ id: "2305.01698" }]), /without a paper object/);
	assert.deepEqual(parseHfPapers([]), []);
}

// searchHfPapers: q and limit on the URL, parser applied.
{
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown) => {
		calls.push(String(url));
		return new Response(JSON.stringify([{ paper: { id: "2411.01411", title: "AI4G flood", githubRepo: "https://github.com/microsoft/ai4g-flood" } }]), { status: 200 });
	}) as typeof fetch;
	try {
		const papers = await searchHfPapers("water segmentation", 15);
		const url = new URL(calls[0]);
		assert.equal(url.origin + url.pathname, "https://huggingface.co/api/papers/search");
		assert.equal(url.searchParams.get("q"), "water segmentation");
		assert.equal(url.searchParams.get("limit"), "15");
		assert.equal(papers[0].arxivId, "2411.01411");
	} finally {
		globalThis.fetch = realFetch;
	}
}

console.log("huggingface.test.ts: all assertions passed");
