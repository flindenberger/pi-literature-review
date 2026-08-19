/**
 * Logic tests for the static citation-network page (no network here; the
 * page fetches OpenAlex only when OPENED in a browser). Pins the contract
 * the rest of the package relies on: self-contained file, the hash
 * parameters the Network column writes, the live-proven OpenAlex endpoints,
 * the honest disclosures, and the write-beside-the-results placement.
 *
 * Run: node src/network.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETWORK_PAGE_NAME, renderNetworkHtml, writeNetworkPage } from "./network.ts";

const html = renderNetworkHtml();

// a complete, standalone document
{
	assert.ok(html.startsWith("<!doctype html>"));
	assert.ok(html.includes("<title>Citation Network</title>"));
	assert.ok(html.includes("</html>"));
}

// self-contained: no external script/style/font -- the ONLY remote host the
// page ever touches by itself is api.openalex.org, via fetch, when opened;
// doi.org / wikipedia appear solely as user-clicked method references
{
	assert.ok(!/<script[^>]*\ssrc=/.test(html));
	assert.ok(!/<link[^>]/.test(html));
	assert.ok(!html.includes("@import"));
	const remoteHosts = [...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
	for (const host of remoteHosts) {
		assert.ok(
			["api.openalex.org", "openalex.org", "www.w3.org", "doi.org", "en.wikipedia.org"].includes(host),
			`unexpected remote host in the page: ${host}`,
		);
	}
	// the fetch() calls stay OpenAlex-only
	for (const m of html.matchAll(/getJson\((API[^)]*|url)\)/g)) assert.ok(m[1], m[0]);
	assert.equal([...html.matchAll(/getJson\(/g)].length, [...html.matchAll(/getJson\((API|url)/g)].length);
	assert.equal([...html.matchAll(/\bfetch\(/g)].length, 1);
	assert.ok(html.includes("doi.org/10.1002/asi.5090140103"));
	assert.ok(html.includes("doi.org/10.1002/asi.4630240406"));
}

// header line: bold title, year, first three + last author 
{
	assert.ok(html.includes("function seedLineHtml("));
	assert.ok(html.includes("names.slice(0, 3).concat"));
	assert.ok(html.includes('class="seed-title"'));
	assert.ok(html.includes('class="seed-authors"'));
	// one-screen layout: flex column, canvas takes the rest
	assert.ok(html.includes("flex-direction: column"));
	assert.ok(html.includes("flex: 1 1 auto"));
	assert.ok(html.includes('<details id="method"><summary>Method: bibliographic coupling (Kessler 1963)'));
	assert.ok(html.includes("hence not all citations are shown"));
}

// the seed contract with the Network column: doi first, title fallback --
// and the endpoints stay the live-proven ones (filter=doi / search= for the
// seed, filter=cites: for citers, filter=ids.openalex: for batch metadata;
// the /works/arxiv: path form 404s, so it must NOT appear)
{
	assert.ok(html.includes('params.get("doi")'));
	assert.ok(html.includes('params.get("title")'));
	assert.ok(html.includes("/works?filter=doi:"));
	assert.ok(html.includes("/works?search="));
	assert.ok(html.includes("/works?filter=cites:"));
	assert.ok(html.includes("/works?filter=ids.openalex:"));
	assert.ok(!html.includes("/works/arxiv:"));
	assert.ok(html.includes("resolved by title search"));
}

// honest disclosures: data source + licence, what leaves the machine, the
// no-LLM rule, offline behaviour, and the coverage caveat
{
	assert.ok(html.includes("CC0"));
	assert.ok(html.includes("never any paper content"));
	assert.ok(html.includes("no language model is involved"));
	assert.ok(html.includes("Could not reach api.openalex.org"));
	assert.ok(html.includes("missing open citation data"));
}

// the method is NAMED with its literature: both
// classic measures, and the page explains where each one acts
{
	assert.ok(html.includes("Kessler 1963"));
	assert.ok(html.includes("Small 1973"));
	assert.ok(html.includes("bibliographic coupling"));
	assert.ok(html.includes("co-citation"));
}

// hover focus: edges are hover targets too and the
// edge tooltip states WHY the link exists
{
	assert.ok(html.includes("data-edge"));
	assert.ok(html.includes("shared reference(s)"));
	assert.ok(html.includes("direct citation"));
}

// zoom + pan (small screens): wheel zoom around the
// cursor, drag to pan, double-click resets -- all via the viewBox, the
// fixed 1400x900 start view stays; the status line tells the user
{
	assert.ok(html.includes('addEventListener("wheel"'));
	assert.ok(html.includes('addEventListener("dblclick"'));
	assert.ok(html.includes("installViewControls(width, height)"));
	assert.ok(html.includes("Mouse wheel zooms, drag pans, double-click resets the view."));
	assert.ok(html.includes('"0 0 " + width + " " + height'));
	// settled layout glides to a padded bounding-box start view; the
	// full stage stays the outer limit
	assert.ok(html.includes("viewControls.setHome(homeView(points, width, height))"));
	assert.ok(html.includes("HOME_FILL"));
}

// citation direction: the plain view
// shows NO arrows; two toggles draw the seed's direct citations to that
// group as arrows (heads as own top-layer paths, never under a thick
// line), highlight the group and fade the rest; the seed's citation edges
// survive the top-4 cut for exactly that; references settle left, citers
// right; tooltip names each node's role and each direct edge's direction
{
	assert.ok(html.includes('id="toggle-refs"'));
	assert.ok(html.includes('id="toggle-citers"'));
	assert.ok(html.includes('"Cited by this paper ("'));
	assert.ok(html.includes('"Citing this paper ("'));
	assert.ok(html.includes('" of " + totalCiters + " shown)"'));
	assert.ok(html.includes("ARROW_FILL"));
	assert.ok(html.includes("function arrowHead("));
	assert.ok(html.includes("parts.concat(arrows)"));
	assert.ok(!html.includes("<marker"));
	assert.ok(html.includes("if (edge.pruned && !shown) return;"));
	assert.ok(html.includes("cited by the selected paper"));
	assert.ok(html.includes("cites the selected paper"));
	assert.ok(html.includes("cite each other"));
	assert.ok(html.includes("return width * 0.3;"));
	assert.ok(html.includes("return width * 0.7;"));
}

// deterministic layout: seeded PRNG, no Math.random / Date.now in the page
{
	assert.ok(html.includes("seededRandom"));
	assert.ok(!html.includes("Math.random"));
	assert.ok(!html.includes("Date.now"));
}

// no-hash state: honest usage hint instead of an error soup
{
	assert.ok(html.includes("Open this page through the Network column"));
}

// writeNetworkPage: lands beside the given results file, fixed basename
// (the tables link relatively), content identical to renderNetworkHtml
{
	const dir = mkdtempSync(join(tmpdir(), "pi-lit-network-"));
	try {
		const written = writeNetworkPage(join(dir, "2026-08-12_some_query.html"));
		assert.equal(written, join(dir, NETWORK_PAGE_NAME));
		assert.ok(existsSync(written));
		assert.equal(readFileSync(written, "utf8"), html);
		// A rerun overwrites in place (static content, no run data).
		assert.equal(writeNetworkPage(join(dir, "2026-08-12_other_query_2.html")), written);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("network.test.ts: all assertions passed");
