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
	runSynthesize,
	type SynthesizeDeps,
	topKChunks,
} from "./synthesize.ts";

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
		{ id: 0, page: 2, text: "Sandbars were mapped with Sentinel-2 imagery.", embedding: [1, 0] },
		{ id: 1, page: 5, text: "Alternate bars appear along the Vistula reach.", embedding: [0.9, 0.1] },
	],
};
const indexB: PaperIndex = {
	schema: INDEX_SCHEMA, chunking: CHUNK_SIGNATURE, sha256: "hash-b", embedding_model: "fake-embed", paper: paperB,
	chunks: [
		{ id: 0, page: 1, text: "Rio Negro water surfaces contracted during the drought.", embedding: [0, 1] },
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

/* ---------------- runSynthesize with fake deps ---------------- */

const library: LibraryMatch = {
	matched: [
		{ file: "/papers/a.pdf", base: "a", key: paperA.key, entry: {
			title: paperA.title, pdf_url: "", doi: paperA.doi, arxiv_id: "", authors: paperA.authors, year: paperA.year,
		} },
		{ file: "/papers/b.pdf", base: "b", key: paperB.key, entry: {
			title: paperB.title, pdf_url: "", doi: "", arxiv_id: paperB.arxiv_id, authors: paperB.authors, year: paperB.year,
		} },
	],
	unmatched: ["alien_scan.pdf"],
	papersDir: "/papers",
};

/** Corpus deps that serve the prebuilt indexes from "cache" -- extraction
 * must never run; readPdf/sha256 cooperate so the hashes match per file. */
function fakeCorpus(): CorpusDeps {
	const indexByFile = new Map([["/index/a.json", indexA], ["/index/b.json", indexB]]);
	return {
		readPdf: (path) => new TextEncoder().encode(path),
		sha256: (bytes) => (new TextDecoder().decode(bytes).endsWith("a.pdf") ? "hash-a" : "hash-b"),
		extract: async () => {
			throw new Error("extract must not run when the cache is valid");
		},
		embed: async (texts) => texts.map(() => [1, 0.05]), // the question vector
		loadIndex: (file) => indexByFile.get(file) ?? null,
		saveIndex: () => {},
	};
}

function makeDeps(generatorOutput: string): {
	deps: SynthesizeDeps;
	generateCalls: Array<{ system: string; user: string; opts?: GenerateOptions }>;
} {
	const corpus = fakeCorpus();
	const generateCalls: Array<{ system: string; user: string; opts?: GenerateOptions }> = [];
	return {
		deps: {
			corpus,
			library: () => library,
			// Default adoption fake: the alien PDF has no identifier.
			adopt: async (files) => files.map((file) => ({
				file,
				status: "no_identifier" as const,
				detail: "no DOI or arXiv ID found on the first 2 pages",
			})),
			backend: {
				embed: corpus.embed,
				generate: async (system, user, opts) => {
					generateCalls.push({ system, user, opts });
					return generatorOutput;
				},
			},
			// The English query variant is off in the orchestration tests --
			// the fake generator would otherwise answer the translation call
			// too. buildQueryVariants/retrieve are covered in retrieve.test.ts.
			translate: null,
		},
		generateCalls,
	};
}

// Grounded run: only verified data in the references, invalid marker gone.
{
	const { deps, generateCalls } = makeDeps(
		"Sandbars show up in Sentinel-2 [1]. The Amazon contracted [3]. Both matter [1, 3]. Fabricated [9].",
	);
	const warnings: string[] = [];
	const result = await runSynthesize({
		question: "How are river sandbars detected?",
		root: "/",
		model: "fake-gen",
		embedModel: "fake-embed",
		onWarn: (m) => warnings.push(m),
	}, deps);

	assert.equal(result.grounded, true);
	assert.equal(result.model, "fake-gen");
	assert.equal(result.top_k, 8);
	assert.equal(result.chunks.length, 3); // whole corpus, never padded
	assert.equal(generateCalls.length, 1);
	// Excerpt-grounded synthesis runs with hidden reasoning off (Ollama dialect).
	assert.equal(generateCalls[0].opts?.think, false);
	assert.ok(generateCalls[0].user.includes("Question: How are river sandbars detected?"));
	// References: verbatim verified records, paper-level numbering.
	assert.equal(result.references.length, 2);
	assert.equal(result.references[0].title, "Vistula sandbars");
	assert.equal(result.references[0].doi, "10.3390/rs13081505");
	assert.equal(result.references[1].arxiv_id, "2401.16393");
	assert.ok(result.prose.includes("[1]") && result.prose.includes("[2]"));
	assert.ok(!result.prose.includes("[9]"));
	assert.deepEqual(result.invalid_markers, ["[9]"]);
	assert.equal(result.papers_matched, 2);
	assert.equal(result.papers_cited, 2);
	assert.deepEqual(result.papers_uncited, []);
	assert.deepEqual(result.unmatched_pdfs, ["alien_scan.pdf"]);
	assert.deepEqual(result.adopted_pdfs, []);
	assert.deepEqual(result.adoption_failures, [
		{ file: "alien_scan.pdf", reason: "no DOI or arXiv ID found on the first 2 pages" },
	]);
	assert.ok(warnings.some((m) => m.includes("attempting adoption")));
	assert.ok(warnings.some((m) => m.includes("could not adopt alien_scan.pdf")));
	assert.ok(warnings.some((m) => m.includes("stripped 1 invalid citation marker")));
	assert.ok(!Number.isNaN(Date.parse(result.generated)));
	assert.equal(result.raw_output.includes("[9]"), true); // raw kept for inspection
}

// Ungrounded run: zero valid citations -> honest failure flag, no references.
{
	const { deps } = makeDeps("A fluent, confident answer without a single citation.");
	const result = await runSynthesize({
		question: "How are river sandbars detected?",
		root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	assert.equal(result.grounded, false);
	assert.deepEqual(result.references, []);
	assert.equal(result.papers_cited, 0);
	assert.deepEqual(result.papers_uncited.sort(), [paperA.key, paperB.key].sort());
}

// Paper filter: unknown names warn, an empty selection is an honest error.
{
	const { deps } = makeDeps("Answer [1].");
	const warnings: string[] = [];
	const result = await runSynthesize({
		question: "q", root: "/", model: "g", embedModel: "fake-embed",
		papers: ["a.pdf", "missing.pdf"],
		onWarn: (m) => warnings.push(m),
	}, deps);
	assert.equal(result.papers_matched, 1);
	assert.ok(warnings.some((m) => m.includes("missing.pdf")));
	await assert.rejects(
		() => runSynthesize({ question: "q", root: "/", papers: ["missing.pdf"], embedModel: "fake-embed" }, deps),
		/no papers with verified metadata/,
	);
}

// Successful adoption: the loose PDF gains its identity, the re-match picks
// it up, and the run proceeds over the full corpus.
{
	const { deps } = makeDeps("Answer [1][3].");
	let scans = 0;
	const adoptCalls: Array<{ files: string[]; dir: string }> = [];
	deps.library = () => {
		scans++;
		return scans === 1
			? { matched: [library.matched[0]], unmatched: ["b.pdf"], papersDir: "/papers" }
			: { matched: library.matched, unmatched: [], papersDir: "/papers" };
	};
	deps.adopt = async (files, dir) => {
		adoptCalls.push({ files, dir });
		return [{ file: "b.pdf", status: "adopted", detail: "identity arXiv:2401.16393 verified by API lookup" }];
	};
	const result = await runSynthesize({
		question: "q", root: "/", model: "g", embedModel: "fake-embed",
	}, deps);
	assert.deepEqual(adoptCalls, [{ files: ["b.pdf"], dir: "/papers" }]);
	assert.equal(scans, 2); // re-matched after the twin was written
	assert.deepEqual(result.adopted_pdfs, ["b.pdf"]);
	assert.deepEqual(result.adoption_failures, []);
	assert.equal(result.papers_matched, 2);
	assert.deepEqual(result.unmatched_pdfs, []);
}

// Abort before generation throws instead of returning a partial result.
{
	const { deps } = makeDeps("never reached");
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => runSynthesize({ question: "q", root: "/", embedModel: "fake-embed", signal: controller.signal }, deps),
		/aborted/,
	);
}

console.log("synthesize.test.ts: all assertions passed");
