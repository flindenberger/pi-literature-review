/**
 * Tests for the plain-text digest handed to the agent model.
 * Run: node src/digest.test.ts
 */

import assert from "node:assert/strict";
import { renderDigest } from "./digest.ts";
import type { RenderPayload } from "./render.ts";

function record(overrides: Record<string, unknown>) {
	return {
		title: "A Paper",
		authors: ["A. Author"],
		year: "2021",
		venue: "Remote Sensing",
		doi: "10.1234/example",
		arxiv_id: "",
		pdf_url: "",
		url: "",
		cites: 3,
		abstract: "Not for the model's eyes.",
		sources: ["crossref"],
		verified: true,
		verify_note: "",
		...overrides,
	};
}

function payload(overrides: Partial<RenderPayload>): RenderPayload {
	return {
		query: "sandbar detection rivers Sentinel-1 Sentinel-2",
		generated: "2026-07-10T00:00:00Z",
		sources_used: ["arxiv", "crossref", "openalex"],
		grouping: null,
		filters: null,
		sort: null,
		results: [],
		dropped: [],
		...overrides,
	};
}

// Grouped run: counts, group labels, exact reference lines
{
	const digest = renderDigest(
		payload({
			grouping: [["river"], ["sandbar"]],
			results: [
				record({ doi: "10.3390/rs13081505", title: "Vistula Sandbars", group: "on_target" }),
				record({ doi: "10.1109/other", title: "Something Else", group: "adjacent", year: "2019" }),
			],
		}),
		"/data/queries/2026-07-10_q.html",
	);
	assert.ok(digest.startsWith("Discovery complete: 2 records (2 verified; 1 on_target, 1 adjacent), 0 dropped."));
	assert.ok(digest.includes("Query: sandbar detection rivers Sentinel-1 Sentinel-2"));
	assert.ok(digest.includes("Sources: arxiv, crossref, openalex"));
	assert.ok(digest.includes("  /data/queries/2026-07-10_q.html"));
	// the JSON sidecar is agent infrastructure; its path stays out of the digest
	assert.ok(!digest.includes(".json"));
	assert.ok(!digest.toLowerCase().includes("payload"));
	assert.ok(digest.includes("open the HTML file to review and select papers"));
	assert.ok(digest.includes("1. [on_target] 2021 | 10.3390/rs13081505 | Vistula Sandbars"));
	assert.ok(digest.includes("2. [adjacent] 2019 | 10.1109/other | Something Else"));
	// no citation data beyond title/year/id leaks into the digest
	assert.ok(!digest.includes("A. Author"));
	assert.ok(!digest.includes("Not for the model's eyes"));
	assert.ok(!digest.includes("Remote Sensing"));
}

// Ungrouped run: no group bracket; UNVERIFIED flag; arXiv-ID fallback; n.d. year
{
	const digest = renderDigest(
		payload({
			results: [
				record({ doi: "", arxiv_id: "2403.19646v3", title: "Preprint" }),
				record({ verified: false, title: "Shaky", year: null }),
			],
		}),
		"/x.html",
	);
	assert.ok(digest.includes("Discovery complete: 2 records (1 verified), 0 dropped."));
	assert.ok(digest.includes("1. 2021 | arXiv:2403.19646v3 | Preprint"));
	assert.ok(digest.includes("2. [UNVERIFIED] n.d. | 10.1234/example | Shaky"));
}

// Dropped records: count plus pointer, no per-record dropped lines
{
	const digest = renderDigest(
		payload({
			results: [record({})],
			dropped: [
				{ reason: "empty title", record: record({ title: "" }) },
				{ reason: "keyword noise", record: record({ title: "Lymph Node" }) },
			],
		}),
		"/x.html",
	);
	assert.ok(digest.includes("2 dropped (reasons listed in the HTML file)"));
	assert.ok(!digest.includes("Lymph Node"));
}

// Query variants: Q1/Q2 labels
{
	const digest = renderDigest(
		payload({ query_variants: ["fluvial bar mapping Sentinel"], results: [record({})] }),
		"/x.html",
	);
	assert.ok(digest.includes("Query Q1: sandbar detection rivers Sentinel-1 Sentinel-2"));
	assert.ok(digest.includes("Query Q2: fluvial bar mapping Sentinel"));
}

// Empty result set stays honest; write failures are named
{
	const digest = renderDigest(payload({}), null);
	assert.ok(digest.includes("Discovery complete: 0 records (0 verified), 0 dropped."));
	assert.ok(digest.includes("No records survived filtering and verification."));
	assert.ok(digest.includes("WARNING: the output files could not be written"));
	assert.ok(!digest.includes("open the HTML file"));
}

console.log("digest.test.ts: all assertions passed");
