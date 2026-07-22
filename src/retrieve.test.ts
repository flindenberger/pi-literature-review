/**
 * Offline tests for the shared retrieval core (v24 Stage 1). Centerpieces:
 * the disclosed English query variant (degrades, never aborts), the
 * deterministic lexical layer (salient terms, whole-word matching,
 * guaranteed slots) and the paper-aware union. No network, no models.
 */

import assert from "node:assert/strict";
import type { PaperIndex } from "./corpus.ts";
import {
	buildQueryVariants,
	LEXICAL_TERM_MAX_HITS,
	lexicalMatches,
	lexicalTermPattern,
	retrieve,
	type RetrievedChunk,
	salientTerms,
	unionChunks,
} from "./retrieve.ts";

/* ---------------- fixtures ---------------- */

const paperA: PaperIndex["paper"] = {
	key: "doi:10.3390/rs13081505", title: "Vistula sandbars", authors: ["Anna Kryniecka"],
	year: "2021", doi: "10.3390/rs13081505", arxiv_id: "",
};
const paperB: PaperIndex["paper"] = {
	key: "arxiv:2401.16393", title: "Amazon drought", authors: ["Fabien H. Wagner"],
	year: "2024", doi: "", arxiv_id: "2401.16393",
};

function makeIndex(paper: PaperIndex["paper"], chunks: Array<{ page: number; text: string; embedding: number[] }>): PaperIndex {
	return {
		schema: 1, sha256: "hash", embedding_model: "fake-embed", paper,
		chunks: chunks.map((chunk, i) => ({ id: i, ...chunk })),
	};
}

/* ---------------- salientTerms ---------------- */
{
	// Quoted phrases, straight and German typographic quotes.
	assert.deepEqual(salientTerms('wo steht das zitat "alternate sandbars" genau?'), ["alternate sandbars"]);
	assert.deepEqual(salientTerms("was bedeutet „mean citedness“ hier?"), ["mean citedness"]);
	// Model-number tokens (letters AND digits) are salient anywhere, even at
	// the sentence start; pure numbers (years, counts) are not.
	assert.deepEqual(salientTerms("Q1645 oder Q1615?"), ["Q1645", "Q1615"]);
	assert.deepEqual(salientTerms("was geschah 2021 mit 15 messungen?"), []);
	assert.deepEqual(salientTerms("wurde bge-m3 mit S-2 daten trainiert?"), ["bge-m3", "S-2"]);
	// Capitalized words count only OUTSIDE sentence starts (start of text,
	// after .!?: and through opening quotes/brackets).
	assert.deepEqual(salientTerms("Welche Kameras nutzt die Axis Anlage?"), ["Kameras", "Axis", "Anlage"]);
	assert.deepEqual(salientTerms("Frage: Welche gibt es? Und dann."), []);
	// Opening quotes/brackets are transparent in both directions: a capital
	// in mid-sentence parentheses counts, one starting a quoted sentence not.
	assert.deepEqual(salientTerms("ist die (Axis) kamera gemeint?"), ["Axis"]);
	assert.deepEqual(salientTerms("what cameras did they use?"), []);
	// Dedupe is case-insensitive, first spelling wins; quoted phrase and
	// token of the same text collapse.
	assert.deepEqual(salientTerms('ist "Q1645" das modell q1645?'), ["Q1645"]);
	// Single characters never qualify.
	assert.deepEqual(salientTerms("hat A das gemessen?"), []);
}

/* ---------------- lexicalTermPattern ---------------- */
{
	const pattern = (term: string, text: string): boolean => lexicalTermPattern(term)?.test(text) ?? false;
	assert.equal(pattern("Q1645", "the Axis Q1645 LE camera"), true);
	assert.equal(pattern("q1645", "the Axis Q1645 LE camera"), true); // case-insensitive
	assert.equal(pattern("Q1645", "the Q16450 sensor"), false); // whole word only
	assert.equal(pattern("sandbar", "several sandbars formed"), true); // plural-s
	assert.equal(pattern("bar", "the sandbar moved"), false); // no substring hits
	assert.equal(pattern("sentinel-2", "with Sentinel 2 imagery"), true); // hyphen/space interchange
	assert.equal(pattern("mean citedness", "the mean-citedness score"), true);
	assert.equal(lexicalTermPattern("   "), null);
}

/* ---------------- lexicalMatches ---------------- */
{
	const index = makeIndex(paperA, [
		{ page: 2, text: "Sandbars were mapped with Sentinel-2 imagery.", embedding: [1, 0] },
		{ page: 4, text: "The Axis Q1645 LE camera recorded the reach.", embedding: [0, 1] },
		{ page: 5, text: "A second camera, the Q1615 Mk III, was added.", embedding: [0, 1] },
	]);
	const hits = lexicalMatches(["Q1645", "Axis"], [index]);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].page, 4);
	assert.deepEqual(hits[0].terms, ["Q1645", "Axis"]); // both terms hit page 4
	// Ordering: most distinct terms first, then paper/page.
	const ordered = lexicalMatches(["camera", "Q1645"], [index]);
	assert.deepEqual(ordered.map((hit) => hit.page), [4, 5]);
	// A term matching more than LEXICAL_TERM_MAX_HITS chunks carries no
	// signal and is dropped entirely.
	const noisy = makeIndex(paperB, Array.from({ length: LEXICAL_TERM_MAX_HITS + 1 }, (_, i) => ({
		page: i + 1, text: `Sentinel appears on page ${i + 1}.`, embedding: [1, 0],
	})));
	assert.deepEqual(lexicalMatches(["Sentinel"], [noisy]), []);
	assert.deepEqual(lexicalMatches([], [index]), []);
}

/* ---------------- buildQueryVariants ---------------- */
{
	// Success: the translation becomes a second, disclosed variant.
	const variants = await buildQueryVariants("welche kameras benutzen sie?", async () => "what cameras do they use?");
	assert.deepEqual(variants, [
		{ query: "welche kameras benutzen sie?", kind: "original" },
		{ query: "what cameras do they use?", kind: "english" },
	]);
	// Chatty output: first non-empty line, surrounding quotes stripped.
	const chatty = await buildQueryVariants("frage?", async () => '\n  "What cameras?"  \nNote: literal translation.');
	assert.deepEqual(chatty[1], { query: "What cameras?", kind: "english" });
	// Identical (already English) -> original only.
	assert.equal((await buildQueryVariants("what cameras?", async () => "What cameras?")).length, 1);
	// Empty output and translator failure both degrade with a warning.
	const warnings: string[] = [];
	const empty = await buildQueryVariants("frage?", async () => "   ", (m) => warnings.push(m));
	assert.equal(empty.length, 1);
	const failed = await buildQueryVariants("frage?", async () => {
		throw new Error("no LLM server reachable");
	}, (m) => warnings.push(m));
	assert.deepEqual(failed, [{ query: "frage?", kind: "original" }]);
	assert.equal(warnings.length, 2);
	assert.ok(warnings[1].includes("no LLM server reachable"));
	// Runaway prose is not a query.
	const prose = await buildQueryVariants("frage?", async () => "x".repeat(500), (m) => warnings.push(m));
	assert.equal(prose.length, 1);
	// No translator -> original only, no warning.
	assert.equal((await buildQueryVariants("frage?", null)).length, 1);
	// A user abort propagates instead of degrading.
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => buildQueryVariants("frage?", async () => {
			throw new Error("aborted");
		}, () => {}, controller.signal),
		/aborted/,
	);
}

/* ---------------- unionChunks: paper-aware dedupe ---------------- */
{
	const c = (paper: PaperIndex["paper"], page: number, text: string, score: number): RetrievedChunk =>
		({ id: 0, paper, page, score, text });
	// Identical page+text in two different papers is two pieces of evidence.
	const twoPapers = unionChunks([[c(paperA, 1, "same boilerplate", 0.9)], [c(paperB, 1, "same boilerplate", 0.8)]], 10);
	assert.equal(twoPapers.length, 2);
	// Within one paper the max score wins and ids are renumbered.
	const deduped = unionChunks([
		[c(paperA, 1, "alpha", 0.5), c(paperA, 2, "beta", 0.4)],
		[c(paperA, 1, "alpha", 0.9)],
	], 10);
	assert.deepEqual(deduped.map((x) => [x.id, x.text, x.score]), [[1, "alpha", 0.9], [2, "beta", 0.4]]);
}

/* ---------------- retrieve: variants + union + lexical slots ---------------- */
{
	// Two chunks pull apart in embedding space; the English variant is the
	// only query that finds the second one.
	const index = makeIndex(paperA, [
		{ page: 2, text: "Sandbars were mapped along the reach.", embedding: [1, 0] },
		{ page: 4, text: "The Axis Q1645 LE camera recorded the site.", embedding: [0, 1] },
	]);
	const embedCalls: string[][] = [];
	const embed = async (texts: string[]) => {
		embedCalls.push([...texts]);
		return texts.map((text) => (text.startsWith("what") ? [0, 1] : [1, 0]));
	};
	const result = await retrieve({
		queries: ["welche kameras benutzen sie?"],
		indexes: [index],
		perQueryK: 1,
		cap: 8,
		embed,
		translate: async () => "what cameras do they use?",
	});
	// ONE embed call carrying both variants; each variant contributed its
	// top chunk to the union.
	assert.equal(embedCalls.length, 1);
	assert.deepEqual(embedCalls[0], ["welche kameras benutzen sie?", "what cameras do they use?"]);
	assert.deepEqual(result.chunks.map((chunk) => [chunk.id, chunk.page]), [[1, 2], [2, 4]]);
	assert.deepEqual(result.variants.map((variant) => variant.kind), ["original", "english"]);
	assert.deepEqual(result.lexical_terms, []); // no salient term in the question
	assert.equal(result.lexical_added, 0);
}
{
	// Lexical guarantee: the chunk naming the exact model number is NOT an
	// embedding hit but must end up in the prompt, flagged and appended.
	const index = makeIndex(paperA, [
		{ page: 1, text: "General introduction to the study reach.", embedding: [1, 0] },
		{ page: 2, text: "Methods overview and data sources.", embedding: [0.95, 0.05] },
		{ page: 4, text: "The Axis Q1645 LE camera recorded the site.", embedding: [0.05, 1] },
	]);
	const embed = async (texts: string[]) => texts.map(() => [1, 0]);
	const result = await retrieve({
		queries: ['ist die "Q1645" verbaut?'],
		indexes: [index],
		perQueryK: 2,
		cap: 2,
		embed,
		translate: null,
	});
	assert.deepEqual(result.lexical_terms, ["Q1645"]);
	assert.equal(result.lexical_added, 1);
	assert.equal(result.chunks.length, 2); // cap holds, lexical slot reserved
	assert.deepEqual(result.chunks.map((chunk) => [chunk.id, chunk.page, chunk.lexical ?? false]), [
		[1, 1, false],
		[2, 4, true], // appended by the lexical layer, renumbered
	]);
	assert.deepEqual(result.chunks[1].terms, ["Q1645"]);
	assert.ok(result.chunks[1].score > 0); // honest cosine score for the trail
}
{
	// Overlap: when the lexical hit already is an embedding hit it keeps its
	// rank and is merely flagged; the run then carries fewer chunks than cap
	// (reserved slot unused -- honest, never padded).
	const index = makeIndex(paperA, [
		{ page: 4, text: "The Axis Q1645 LE camera recorded the site.", embedding: [1, 0] },
		{ page: 1, text: "General introduction to the study reach.", embedding: [0.9, 0.1] },
	]);
	const embed = async (texts: string[]) => texts.map(() => [1, 0]);
	const result = await retrieve({
		queries: ['ist die "Q1645" verbaut?'],
		indexes: [index],
		perQueryK: 2,
		cap: 2,
		embed,
		translate: null,
	});
	assert.equal(result.lexical_added, 0);
	assert.deepEqual(result.chunks.map((chunk) => [chunk.id, chunk.page, chunk.lexical ?? false]), [[1, 4, true]]);
}
{
	// Empty queries are a caller bug, loudly.
	await assert.rejects(
		() => retrieve({ queries: ["  "], indexes: [], perQueryK: 1, cap: 1, embed: async () => [] }),
		/no retrieval queries/,
	);
}

console.log("retrieve tests passed");
