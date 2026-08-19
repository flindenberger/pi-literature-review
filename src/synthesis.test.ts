/**
 * Offline tests for the synthesis engine -- the trust gate of the stage.
 * Centerpiece: a fake generator whose output carries valid, duplicate,
 * list, range AND invalid citation markers plus a fabricated reference
 * section; the assertions prove that only verified data survives into the
 * result. No filesystem, no network, no models.
 */

import assert from "node:assert/strict";
import { type CorpusDeps, INDEX_SCHEMA, type LibraryMatch, type PaperIndex } from "./corpus.ts";
import { CHUNK_SIGNATURE } from "./extract.ts";
import type { GenerateOptions } from "./llm.ts";
import {
	buildPrompt,
	assembleReport,
	buildCitations,
	cosine,
	enforceCitations,
	promptTokens,
	type RetrievedChunk,
	topKChunks,
} from "./synthesis.ts";

/* ---------------- cosine ---------------- */
{
	assert.equal(cosine([1, 0], [0, 1]), 0);
	assert.equal(cosine([2, 0], [4, 0]), 1);
	assert.equal(cosine([0, 0], [1, 1]), 0); // zero vector never divides by zero
	assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9);
}

/* ---------------- fixtures ---------------- */

const paperA: PaperIndex["paper"] = {
	key: "doi:10.3390/rs13081505", title: "Vistula sandbars", authors: ["Anna Kryniecka", "A. Magnuszewski"],
	year: "2021", doi: "10.3390/rs13081505", arxiv_id: "",
};
const paperB: PaperIndex["paper"] = {
	key: "arxiv:2401.16393", title: "Amazon drought", authors: ["Fabien H. Wagner"],
	year: "2024", doi: "", arxiv_id: "2401.16393",
};

const indexA: PaperIndex = {
	schema: INDEX_SCHEMA, chunking: CHUNK_SIGNATURE, sha256: "hash-a", embedding_model: "fake-embed", paper: paperA,
	chunks: [
		{ id: 0, page: 2, text: "Sandbars were mapped with Sentinel-2 imagery.", embedding: [1, 0], phrase_words: 0 },
		{ id: 1, page: 5, text: "Alternate bars appear along the Vistula reach.", embedding: [0.9, 0.1], phrase_words: 0 },
	],
};
const indexB: PaperIndex = {
	schema: INDEX_SCHEMA, chunking: CHUNK_SIGNATURE, sha256: "hash-b", embedding_model: "fake-embed", paper: paperB,
	chunks: [
		{ id: 0, page: 1, text: "Rio Negro water surfaces contracted during the drought.", embedding: [0, 1], phrase_words: 0 },
	],
};

/* ---------------- topKChunks ---------------- */
{
	const top = topKChunks([1, 0.05], [indexA, indexB], 2);
	assert.equal(top.length, 2);
	assert.deepEqual(top.map((c) => c.id), [1, 2]); // ids are prompt numbers
	assert.equal(top[0].paper.key, paperA.key); // best match first
	assert.equal(top[0].page, 2);
	assert.ok(top[0].score > top[1].score);
	// k larger than the corpus: everything, never padding.
	assert.equal(topKChunks([1, 0], [indexA, indexB], 10).length, 3);
	// Deterministic order for [1,1]: the mixed chunk [0.9,0.1] scores
	// highest; [1,0] and [0,1] tie exactly and fall back to the paper key
	// (arxiv < doi) -- same result no matter the index order.
	const tied = topKChunks([1, 1], [indexB, indexA], 3);
	assert.deepEqual(
		tied.map((c) => `${c.paper.key}:${c.page}`),
		["doi:10.3390/rs13081505:5", "arxiv:2401.16393:1", "doi:10.3390/rs13081505:2"],
	);
}

/* ---------------- buildPrompt ---------------- */
{
	const chunks: RetrievedChunk[] = [
		{ id: 1, paper: paperA, page: 2, score: 0.9, text: "Excerpt one." },
		{ id: 2, paper: paperB, page: 1, score: 0.5, text: "Excerpt two." },
	];
	const prompt = buildPrompt("How are sandbars detected?", chunks);
	assert.ok(prompt.user.includes("Question: How are sandbars detected?"));
	assert.ok(prompt.user.includes("[1] (source 1)\nExcerpt one."));
	assert.ok(prompt.user.includes("[2] (source 2)\nExcerpt two."));
	assert.ok(prompt.system.includes("NEVER write author names"));
	assert.ok(prompt.system.includes("the language of the question"));
	assert.ok(buildPrompt("q", chunks, "German").system.includes("Write in German"));
	assert.ok(promptTokens(prompt) > 0);
	assert.equal(promptTokens(prompt), Math.ceil((prompt.system.length + prompt.user.length) / 4));
}

/* ---------------- enforceCitations ---------------- */
{
	const raw = [
		"Sandbars are detected with Sentinel-2 [1]. The Amazon dried out [3].",
		"More detail from the same paper [2]. Redundant claim [1][1].",
		"List form [1, 3]. Range form [1-3]. Fabricated marker [9]. Impossible range [7-9].",
		"A connective sentence without any marker.",
		"",
		"References",
		"[1] Fabricated, F. (2099). Made-up title. Journal of Nowhere.",
	].join("\n");
	const scan = enforceCitations(raw, 3);
	// The fabricated reference section is gone, and said so.
	assert.equal(scan.strippedReferenceSection, true);
	assert.ok(!scan.text.includes("Made-up title"));
	assert.ok(!scan.text.includes("References"));
	// Invalid markers stripped and reported; impossible range is ONE marker.
	// (Ranges are validated before singles, hence the order.)
	assert.deepEqual(scan.invalidMarkers, ["[7-9]", "[9]"]);
	assert.ok(!scan.text.includes("[9]"));
	// Citation order of first appearance.
	assert.deepEqual(scan.citedChunkIds, [1, 3, 2]);
	// List expanded, duplicates collapsed, range expanded.
	assert.ok(scan.text.includes("Redundant claim [1]."));
	assert.ok(scan.text.includes("List form [1][3]."));
	assert.ok(scan.text.includes("Range form [1][2][3]."));
	// Stripping leaves no dangling space before punctuation.
	assert.ok(scan.text.includes("Fabricated marker."));
	assert.ok(scan.text.includes("Impossible range."));
	assert.equal(scan.unmarkedSentences, 3); // the two stripped-marker sentences + the connective one
}
{
	// Zero markers: nothing cited, nothing invented.
	const scan = enforceCitations("A fluent answer without any citation at all.", 5);
	assert.deepEqual(scan.citedChunkIds, []);
	assert.deepEqual(scan.invalidMarkers, []);
	assert.equal(scan.strippedReferenceSection, false);
}

/* ---------------- buildCitations ---------------- */
{
	const chunks: RetrievedChunk[] = [
		{ id: 1, paper: paperA, page: 2, score: 0.9, text: "The adaptive threshold separates water from sand robustly." },
		{ id: 2, paper: paperA, page: 5, score: 0.8, text: "b" },
		{ id: 3, paper: paperB, page: 1, score: 0.7, text: "c" },
	];
	const { prose, references, sites } = buildCitations(
		"First [1]. Second [3]. Same paper again [2]. Adjacent same paper [1][2]. Same chunk [1] [1].",
		chunks,
		new Map([[paperA.key, "/papers/a.pdf"]]),
	);
	// Paper-level renumbering in first-citation order: A=1, B=2. Adjacent
	// markers of the SAME paper but DIFFERENT chunks stay separate (v25:
	// each keeps its page target); the same chunk back-to-back collapses.
	assert.equal(prose, "First [1]. Second [2]. Same paper again [1]. Adjacent same paper [1][1]. Same chunk [1].");
	assert.equal(references.length, 2);
	assert.equal(references[0].key, paperA.key);
	assert.equal(references[0].title, "Vistula sandbars"); // verbatim from the record
	assert.equal(references[0].doi, "10.3390/rs13081505");
	assert.deepEqual(references[0].pages, [2, 5]);
	assert.deepEqual(references[0].chunk_ids, [1, 2]);
	assert.equal(references[0].pdf_path, "/papers/a.pdf"); // code-constructed library path
	assert.equal(references[1].key, paperB.key);
	assert.deepEqual(references[1].pages, [1]);
	assert.equal(references[1].pdf_path, undefined); // no path known -> field absent
	// THE invariant: one site per marker in the prose, in document order.
	assert.equal((prose.match(/\[\d+\]/g) ?? []).length, sites.length);
	assert.deepEqual(sites.map((site) => [site.ref, site.chunk_id, site.page]), [
		[1, 1, 2], [2, 3, 1], [1, 2, 5], [1, 1, 2], [1, 2, 5], [1, 1, 2],
	]);
	assert.equal(sites[0].paper_key, paperA.key);
	assert.equal(sites[0].snippet, "The adaptive threshold separates water"); // clean-word run for the PDF highlight
	assert.equal(sites[2].snippet, null); // too short for a distinctive phrase
}
{
	// A chunk carrying a VERIFIED phrase length highlights that whole span
	// instead of the timid clean-word guess (2026-07-27). The guess remains
	// for chunks without the field -- see the case above.
	const text = "The adaptive threshold separates water, sediment and vegetation reliably.";
	const chunks: RetrievedChunk[] = [
		{ id: 1, paper: paperA, page: 2, score: 0.9, text, phrase_words: 9 },
		{ id: 2, paper: paperA, page: 3, score: 0.8, text, phrase_words: 0 },
	];
	const { sites } = buildCitations("Full span [1]. Nothing verified [2].", chunks);
	assert.equal(sites[0].snippet, "The adaptive threshold separates water, sediment and vegetation reliably.");
	// phrase_words 0 = the raw text layer did not match; fall back to the
	// guess, which stops at the comma -- exactly the timidity being replaced.
	assert.equal(sites[1].snippet, "The adaptive threshold separates");
}
{
	// No markers, no sites; unknown markers pass through untouched.
	const chunks: RetrievedChunk[] = [{ id: 1, paper: paperA, page: 2, score: 0.9, text: "a" }];
	assert.deepEqual(buildCitations("No citations at all.", chunks).sites, []);
}

/* ---------------- assembleReport ---------------- */
{
	const chunksA: RetrievedChunk[] = [{ id: 1, paper: paperA, page: 2, score: 0.9, text: "a" }];
	const chunksB: RetrievedChunk[] = [
		{ id: 1, paper: paperB, page: 1, score: 0.9, text: "b" },
		{ id: 2, paper: paperA, page: 5, score: 0.8, text: "c" },
	];
	const unitOne = buildCitations("Alpha [1].", chunksA, new Map([[paperA.key, "/papers/a.pdf"]]));
	const unitTwo = buildCitations("Beta [1]. Gamma [2].", chunksB);
	const { units, references } = assembleReport([unitOne, unitTwo]);
	// Global numbering in first-citation order across units: A=1, B=2; the
	// second unit's local B=1/A=2 markers are rewritten.
	assert.equal(units[0].prose, "Alpha [1].");
	assert.equal(units[1].prose, "Beta [2]. Gamma [1].");
	assert.deepEqual(units[1].sites.map((site) => site.ref), [2, 1]);
	assert.deepEqual(references.map((reference) => [reference.n, reference.key]), [[1, paperA.key], [2, paperB.key]]);
	// Pages merge per paper across units; the path survives from whichever
	// unit knew it.
	assert.deepEqual(references[0].pages, [2, 5]);
	assert.equal(references[0].pdf_path, "/papers/a.pdf");
	// A single unit assembles to itself (identity on the prose).
	const single = assembleReport([buildCitations("Solo [1].", chunksA)]);
	assert.equal(single.units[0].prose, "Solo [1].");
	assert.deepEqual(single.references.map((reference) => reference.key), [paperA.key]);
}

console.log("synthesis.test.ts: all assertions passed");
