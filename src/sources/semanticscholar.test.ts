/**
 * Offline tests for the Semantic Scholar client's pure parts (2026-08-10).
 * The paper fixture mirrors a real bulk-endpoint response captured live on
 * the build day (sandbar / Sentinel-2 query). No network.
 *
 * Run: node src/sources/semanticscholar.test.ts
 */

import assert from "node:assert/strict";
import { abstractLookupUrl, buildBulkQuery, toSourceRecord } from "./semanticscholar.ts";

/* ---------------- buildBulkQuery ---------------- */
{
	// Blocks become required (+) groups, synonyms OR-join with |, multi-word
	// terms are quoted phrases -- the bulk endpoint's own syntax (verified
	// live 2026-08-10: +sandbar +("sentinel-2" | "sentinel 2") answered 200
	// with on-topic, citation-sorted records).
	assert.equal(
		buildBulkQuery("ignored", [["river", "fluvial"], ["sandbar"], ["sentinel-2", "sentinel 2"]]),
		'+(river | fluvial) +sandbar +(sentinel-2 | "sentinel 2")',
	);
	// Single-word blocks need no parentheses; embedded quotes are stripped
	// before phrasing (the term itself decides the quoting).
	assert.equal(buildBulkQuery("x", [['"water mask"']]), '+"water mask"');
	// No blocks (quoted/field-syntax queries pass hands-off): the raw query
	// text goes through unchanged.
	assert.equal(buildBulkQuery('"exact phrase"', []), '"exact phrase"');
	assert.equal(buildBulkQuery("plain text", undefined), "plain text");
	// Empty groups vanish instead of producing +().
	assert.equal(buildBulkQuery("x", [[""], ["river"]]), "+river");
}

/* ---------------- toSourceRecord ---------------- */
{
	// Field-for-field from the live capture (abbreviated abstract).
	const record = toSourceRecord({
		paperId: "940c7cbbb23ddd38155c37a26811d3cfcf4e1c8d",
		externalIds: { DBLP: "journals/remotesensing/JanusaiteJJPZ21", DOI: "10.3390/rs13112233", CorpusId: 235813094 },
		title: "A Novel GIS-Based Approach for Automated Detection of Nearshore Sandbar Morphological Characteristics in Optical Satellite Imagery",
		venue: "Remote Sensing",
		year: 2021,
		citationCount: 13,
		openAccessPdf: { url: "https://www.mdpi.com/2072-4292/13/11/2233/pdf?version=1623138608", status: "GOLD" },
		authors: [{ authorId: "1567508808", name: "Rasa Janušaitė" }, { authorId: "90895016", name: "Laurynas Jukna" }],
		abstract: "Satellite remote sensing is a valuable tool for coastal management.",
	});
	assert.equal(record.source, "semanticscholar");
	assert.equal(record.doi, "10.3390/rs13112233");
	assert.equal(record.arxiv_id, "");
	assert.equal(record.year, "2021");
	assert.equal(record.venue, "Remote Sensing");
	assert.equal(record.cites, 13);
	assert.deepEqual(record.authors, ["Rasa Janušaitė", "Laurynas Jukna"]);
	assert.equal(record.pdf_url, "https://www.mdpi.com/2072-4292/13/11/2233/pdf?version=1623138608");
	assert.equal(record.url, "https://doi.org/10.3390/rs13112233");
	assert.equal(record.abstract, "Satellite remote sensing is a valuable tool for coastal management.");
}
{
	// arXiv-only preprint: identifier and url fall back to arxiv.org; the
	// paperId page is the last resort. Absent fields stay honestly empty.
	const preprint = toSourceRecord({
		paperId: "abc123",
		externalIds: { ArXiv: "2401.16393" },
		title: "Preprint",
		year: 2024,
		venue: "",
		citationCount: 0,
		authors: [],
		abstract: null,
	});
	assert.equal(preprint.doi, "");
	assert.equal(preprint.arxiv_id, "2401.16393");
	assert.equal(preprint.url, "https://arxiv.org/abs/2401.16393");
	assert.equal(preprint.cites, 0);
	assert.equal(preprint.abstract, "");
	const bare = toSourceRecord({ paperId: "abc123", title: "No ids" });
	assert.equal(bare.url, "https://www.semanticscholar.org/paper/abc123");
	assert.equal(bare.year, null);
	assert.equal(bare.cites, null);
}

// abstractLookupUrl (2026-08-18): single-paper endpoint by DOI, abstract only
{
	assert.equal(
		abstractLookupUrl("10.1016/j.geomorph.2019.02.014"),
		"https://api.semanticscholar.org/graph/v1/paper/DOI:10.1016%2Fj.geomorph.2019.02.014?fields=abstract",
	);
}

console.log("semanticscholar.test.ts: all assertions passed");
