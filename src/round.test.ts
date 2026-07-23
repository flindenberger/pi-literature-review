/**
 * Offline tests for the round & session-report half of the fused engine
 * (formerly src/chat.ts; absorbed into synthesize.ts in v25 E2d). Centerpieces: the single-paper
 * confinement (a two-paper library must never leak chunks of the other
 * paper into the prompt) and the citation trust gate on the didactic
 * answer. No filesystem, no network, no models.
 */

import assert from "node:assert/strict";
import {
	type ChatDeps,
	buildChatPrompt,
	chatPool,
	DEFAULT_REPORT_QUESTION,
	DEFAULT_REVIEW_QUESTION,
	ensureLibrary,
	runReport,
	runRound,
	runChatReport,
	scopeProtocolId,
	selectPaper,
	SUMMARY_FACETS,
	summarySystemPrompt,
} from "./synthesize.ts";
import type { CorpusDeps, LibraryMatch, PaperIndex } from "./corpus.ts";
import type { GenerateOptions } from "./llm.ts";
import { querySlug } from "./output.ts";
import { type Protocol, PROTOCOL_SCHEMA, type ProtocolDeps, type Round } from "./protocol.ts";
import { type RetrievedChunk, TRANSLATE_SYSTEM_PROMPT, unionChunks } from "./retrieve.ts";

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
	schema: 1, sha256: "hash-a", embedding_model: "fake-embed", paper: paperA,
	chunks: [
		{ id: 0, page: 2, text: "Sandbars were mapped with Sentinel-2 imagery.", embedding: [1, 0] },
		{ id: 1, page: 5, text: "Alternate bars appear along the Vistula reach.", embedding: [0.9, 0.1] },
	],
};
const indexB: PaperIndex = {
	schema: 1, sha256: "hash-b", embedding_model: "fake-embed", paper: paperB,
	chunks: [
		// Deliberately the best global match for the test question vector:
		// if retrieval were corpus-wide, THIS chunk would win.
		{ id: 0, page: 1, text: "Rio Negro water surfaces contracted during the drought.", embedding: [1, 0.05] },
	],
};
// A PDF without a verified record, indexed under its filename identity.
const indexC: PaperIndex = {
	schema: 1, sha256: "hash-c", embedding_model: "fake-embed",
	paper: { key: "file:c", title: "", authors: [], year: null, doi: "", arxiv_id: "" },
	chunks: [{ id: 0, page: 3, text: "Filename-only content about cameras.", embedding: [1, 0] }],
};

const library: LibraryMatch = {
	matched: [
		{ file: "/papers/a.pdf", base: "a", key: paperA.key, entry: {
			title: paperA.title, pdf_url: "", doi: paperA.doi, arxiv_id: "", authors: paperA.authors, year: paperA.year,
		} },
		{ file: "/papers/b.pdf", base: "b", key: paperB.key, entry: {
			title: paperB.title, pdf_url: "", doi: "", arxiv_id: paperB.arxiv_id, authors: paperB.authors, year: paperB.year,
		} },
	],
	unmatched: [],
	papersDir: "/papers",
};

/** Corpus deps serving the prebuilt indexes from "cache" -- extraction
 * must never run; readPdf/sha256 cooperate so the hashes match per file. */
function fakeCorpus(): CorpusDeps {
	const indexByFile = new Map([["/index/a.json", indexA], ["/index/b.json", indexB], ["/index/c.json", indexC]]);
	return {
		readPdf: (path) => new TextEncoder().encode(path),
		sha256: (bytes) => {
			const path = new TextDecoder().decode(bytes);
			return path.endsWith("a.pdf") ? "hash-a" : path.endsWith("b.pdf") ? "hash-b" : "hash-c";
		},
		extract: async () => {
			throw new Error("extract must not run when the cache is valid");
		},
		embed: async (texts) => texts.map(() => [1, 0.05]), // the question vector
		loadIndex: (file) => indexByFile.get(file) ?? null,
		saveIndex: () => {},
	};
}

/** In-memory chat log: a Map of absolute path -> file text. */
function memoryChatLog(): { chatLog: ProtocolDeps; files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		chatLog: {
			read: (path) => files.get(path) ?? null,
			write: (path, text) => {
				files.set(path, text);
			},
			exists: (path) => files.has(path),
			list: (dir) => [...files.keys()]
				.filter((path) => path.startsWith(`${dir}/`))
				.map((path) => path.slice(dir.length + 1)),
		},
	};
}

function makeDeps(generatorOutput: string): {
	deps: ChatDeps;
	generateCalls: Array<{ system: string; user: string; opts?: GenerateOptions }>;
	embedCalls: string[][];
	files: Map<string, string>;
} {
	const corpus = fakeCorpus();
	const embedCalls: string[][] = [];
	const baseEmbed = corpus.embed;
	corpus.embed = async (texts, signal) => {
		embedCalls.push([...texts]);
		return baseEmbed(texts, signal);
	};
	const generateCalls: Array<{ system: string; user: string; opts?: GenerateOptions }> = [];
	const { chatLog, files } = memoryChatLog();
	return {
		deps: {
			corpus,
			library: () => library,
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
			protocol: chatLog,
			// The English query variant is off in the orchestration tests --
			// the fake generator would otherwise answer the translation call
			// too. buildQueryVariants/retrieve are covered in retrieve.test.ts.
			translate: null,
			now: () => new Date("2026-07-16T10:00:00Z"),
		},
		generateCalls,
		embedCalls,
		files,
	};
}

function makeRound(question: string, session: string | null = null): Round {
	return {
		asked: "2026-07-16T10:00:00.000Z", question, language: null, model: "fake-gen", session,
		top_k: 8, grounded: true, prose: `Antwort [1].`,
		references: [{
			n: 1, key: paperA.key, title: paperA.title, authors: paperA.authors, year: paperA.year,
			doi: paperA.doi, arxiv_id: "", pages: [2], chunk_ids: [1],
		}],
		cited_chunks: [{ id: 1, page: 2, score: 0.9, text: "Sandbars were mapped with Sentinel-2 imagery." }],
		invalid_markers: [], unmarked_sentences: 0, stripped_reference_section: false,
	};
}

/* ---------------- buildChatPrompt ---------------- */
{
	const chunks: RetrievedChunk[] = [
		{ id: 1, paper: paperA, page: 2, score: 0.9, text: "Excerpt one." },
		{ id: 2, paper: paperA, page: 5, score: 0.5, text: "Excerpt two." },
	];
	const prompt = buildChatPrompt("Wie werden Sandbaenke erkannt?", chunks);
	assert.ok(prompt.user.includes("Question: Wie werden Sandbaenke erkannt?"));
	assert.ok(prompt.user.includes("[1] (source 1)\nExcerpt one."));
	assert.ok(prompt.user.includes("[2] (source 2)\nExcerpt two."));
	assert.ok(prompt.system.includes("understand ONE scientific paper"));
	assert.ok(prompt.system.includes("plain, accessible language"));
	assert.ok(prompt.system.includes("NEVER write author names"));
	assert.ok(prompt.system.includes("the language of the question"));
	assert.ok(buildChatPrompt("q", chunks, "German").system.includes("Write in German"));
	assert.ok(buildChatPrompt("q", chunks, "  ").system.includes("the language of the question"));
}

/* ---------------- selectPaper ---------------- */
{
	assert.equal(selectPaper(library.matched, "a.pdf").base, "a");
	assert.equal(selectPaper(library.matched, "a").base, "a");
	assert.equal(selectPaper(library.matched, "A.PDF").base, "a");
	assert.throws(() => selectPaper(library.matched, "missing.pdf"), (error: Error) => {
		assert.ok(error.message.includes("missing.pdf"));
		assert.ok(error.message.includes("a.pdf, b.pdf")); // lists what IS available
		return true;
	});
	assert.throws(() => selectPaper(library.matched, "  "), /no paper selected/);
	assert.throws(() => selectPaper([], "x"), /available: \(none\)/);
}

/* ---------------- runRound: confinement + trust gate ---------------- */
{
	const { deps, generateCalls } = makeDeps(
		"Die Methode nutzt Sentinel-2 [1]. Wechselbaenke treten auf [2]. Erfunden [9].",
	);
	const warnings: string[] = [];
	const result = await runRound({
		question: "Wie funktioniert die Methode?",
		paper: "a.pdf",
		root: "/",
		model: "fake-gen",
		embedModel: "fake-embed",
		onWarn: (m) => warnings.push(m),
	}, deps);

	assert.equal(result.grounded, true);
	assert.equal(result.model, "fake-gen");
	assert.equal(generateCalls.length, 1);
	// Excerpt-grounded answers run with hidden reasoning off (Ollama dialect).
	assert.equal(generateCalls[0].opts?.think, false);
	// Confinement: paper B's chunk is the best GLOBAL match for the question
	// vector, but retrieval ran only over paper A.
	assert.equal(result.chunks.length, 2);
	for (const chunk of result.chunks) {
		assert.ok(indexA.chunks.some((c) => c.text === chunk.text));
		assert.ok(!chunk.text.includes("Rio Negro"));
	}
	assert.ok(!generateCalls[0].user.includes("Rio Negro"));
	// Single paper -> exactly one reference, verbatim from the record.
	assert.equal(result.references.length, 1);
	assert.equal(result.references[0].title, "Vistula sandbars");
	assert.equal(result.references[0].doi, "10.3390/rs13081505");
	assert.deepEqual(result.references[0].pages, [2, 5]);
	// Paper-level renumbering: every marker becomes [1].
	assert.equal(result.prose, "Die Methode nutzt Sentinel-2 [1]. Wechselbaenke treten auf [1]. Erfunden.");
	assert.deepEqual(result.invalid_markers, ["[9]"]);
	assert.ok(warnings.some((m) => m.includes("stripped 1 invalid citation marker")));
	// The paper identity in the result comes from the verified record.
	assert.equal(result.paper.base, "a");
	assert.equal(result.paper.key, paperA.key);
	assert.equal(result.paper.title, "Vistula sandbars");
	assert.equal(result.paper.pdf_path, "/papers/a.pdf");
	// The validated round went to the protocol file of the day.
	assert.equal(result.protocol_path, "/chats/2026-07-16_a.json");
	assert.equal(result.round, 1);
	assert.equal(result.generated, "2026-07-16T10:00:00.000Z"); // injected clock
	assert.equal(result.raw_output.includes("[9]"), true); // raw kept for inspection
}

/* ---------------- runRound: ungrounded answer ---------------- */
{
	const { deps } = makeDeps("Eine fluessige Antwort ohne einen einzigen Beleg.");
	const result = await runRound({
		question: "Wie funktioniert die Methode?",
		paper: "a", root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	assert.equal(result.grounded, false);
	assert.deepEqual(result.references, []);
}

/* ---------------- runRound: honest errors ---------------- */
{
	const { deps } = makeDeps("never reached");
	// Missing paper: the error names the available files.
	await assert.rejects(
		() => runRound({ question: "q", root: "/", embedModel: "fake-embed" }, deps),
		/no paper selected.*a\.pdf, b\.pdf/,
	);
	// Empty question.
	await assert.rejects(
		() => runRound({ question: "  ", paper: "a", root: "/", embedModel: "fake-embed" }, deps),
		/empty question/,
	);
	// Abort before generation throws instead of returning a partial result.
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => runRound({ question: "q", paper: "a", root: "/", embedModel: "fake-embed", signal: controller.signal }, deps),
		/aborted/,
	);
	// Empty library.
	await assert.rejects(
		() => runRound({ question: "q", paper: "a", root: "/", embedModel: "fake-embed" }, {
			...deps,
			library: () => ({ matched: [], unmatched: [], papersDir: "/papers" }),
		}),
		/no PDFs in the library/,
	);
	// EMPTY generation is a backend failure, not a groundable answer (field
	// failure 2026-07-20: a thinking model returned zero answer text; the
	// empty string must not flow through the citation gate as an empty
	// "ungrounded draft").
	const { deps: emptyDeps } = makeDeps("  \n ");
	await assert.rejects(
		() => runRound({ question: "q", paper: "a", root: "/", model: "fake-gen", embedModel: "fake-embed" }, emptyDeps),
		/no answer text/,
	);
}

/* ---------------- ensureLibrary: adoption re-match ---------------- */
{
	let scans = 0;
	const adoptCalls: Array<{ files: string[]; dir: string }> = [];
	const warnings: string[] = [];
	const { match, adopted, adoptionFailures } = await ensureLibrary("/", (m) => warnings.push(m), {
		library: () => {
			scans++;
			return scans === 1
				? { matched: [library.matched[0]], unmatched: ["b.pdf"], papersDir: "/papers" }
				: { matched: library.matched, unmatched: [], papersDir: "/papers" };
		},
		adopt: async (files, dir) => {
			adoptCalls.push({ files, dir });
			return [{ file: "b.pdf", status: "adopted", detail: "identity arXiv:2401.16393 verified by API lookup" }];
		},
	});
	assert.deepEqual(adoptCalls, [{ files: ["b.pdf"], dir: "/papers" }]);
	assert.equal(scans, 2); // re-matched after the twin was written
	assert.deepEqual(adopted, ["b.pdf"]);
	assert.deepEqual(adoptionFailures, []);
	assert.equal(match.matched.length, 2);
	assert.ok(warnings.some((m) => m.includes("attempting adoption")));
	assert.ok(warnings.some((m) => m.includes("adopted b.pdf")));
}

/* ---------------- protocol: create, append, cited-only ---------------- */
{
	// Output cites only excerpt [1] -- the protocol must store only that chunk.
	const { deps, files } = makeDeps("Nur die erste Quelle [1].");
	const first = await runRound({
		question: "Frage eins?", paper: "a", root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	assert.equal(first.round, 1);
	assert.equal(first.protocol_path, "/chats/2026-07-16_a.json");
	const second = await runRound({
		question: "Frage zwei?", paper: "a", root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	assert.equal(second.round, 2);
	assert.equal(second.protocol_path, first.protocol_path); // same day -> same file
	// Two files: the protocol and the sticky current-scope marker.
	assert.equal(files.size, 2);
	assert.deepEqual(JSON.parse(files.get("/chats/current-scope.json")!), { papers: ["a"], session: null }); // no session passed
	const protocol = JSON.parse(files.get("/chats/2026-07-16_a.json")!) as Protocol;
	assert.equal(protocol.schema, PROTOCOL_SCHEMA);
	assert.equal(protocol.base, "a");
	assert.equal(protocol.paper.key, paperA.key);
	assert.equal(protocol.paper.title, "Vistula sandbars"); // verbatim record
	assert.equal(protocol.rounds.length, 2);
	assert.deepEqual(protocol.rounds.map((round) => round.question), ["Frage eins?", "Frage zwei?"]);
	// Two chunks were retrieved, but only the cited one is persisted.
	assert.equal(protocol.rounds[0].cited_chunks.length, 1);
	assert.equal(protocol.rounds[0].cited_chunks[0].id, 1);
	assert.equal(protocol.rounds[0].grounded, true);
	assert.equal(protocol.rounds[0].asked, "2026-07-16T10:00:00.000Z");
	assert.equal(protocol.rounds[0].session, null); // recorded session-less without a session option
}

/* ---------------- protocol: write failure never loses the answer ---------------- */
{
	const { deps } = makeDeps("Antwort [1].");
	deps.protocol = {
		read: () => null,
		write: () => {
			throw new Error("disk full");
		},
		exists: () => false,
		list: () => [],
	};
	const warnings: string[] = [];
	const result = await runRound({
		question: "q", paper: "a", root: "/", model: "fake-gen", embedModel: "fake-embed",
		onWarn: (m) => warnings.push(m),
	}, deps);
	assert.equal(result.grounded, true); // the answer is fully intact
	assert.equal(result.prose, "Antwort [1].");
	assert.equal(result.protocol_path, null);
	assert.equal(result.round, 0);
	assert.ok(warnings.some((m) => m.includes("could not persist") && m.includes("disk full")));
}

/* ---------------- sticky scope (session-scoped, legacy fallback) ---------------- */
{
	const { deps, files } = makeDeps("Antwort [1].");
	// Pre-v25 marker: with no current-scope.json yet, the legacy file still
	// resolves the paper (read for one more release).
	files.set("/chats/current-paper.json", JSON.stringify({ base: "a", session: "s1" }));
	// No paper option, SAME session: the sticky marker resolves it.
	const result = await runRound({ question: "q", root: "/", session: "s1", model: "fake-gen", embedModel: "fake-embed" }, deps);
	assert.equal(result.paper.base, "a");
	// A DIFFERENT session must not inherit the marker (bug 2026-07-21: the
	// selection survived pi restarts) -- nor may a session-less call.
	await assert.rejects(
		() => runRound({ question: "q", root: "/", session: "s2", model: "fake-gen", embedModel: "fake-embed" }, deps),
		/no paper selected/,
	);
	await assert.rejects(
		() => runRound({ question: "q", root: "/", model: "fake-gen", embedModel: "fake-embed" }, deps),
		/no paper selected/,
	);
	// An explicit paper wins over the marker and re-stamps the NEW scope
	// marker for ITS session (the legacy file is left behind, never re-read
	// once a scope file exists).
	const explicit = await runRound({ question: "q", paper: "b", root: "/", session: "s2", model: "fake-gen", embedModel: "fake-embed" }, deps);
	assert.equal(explicit.paper.base, "b");
	assert.deepEqual(JSON.parse(files.get("/chats/current-scope.json")!), { papers: ["b"], session: "s2" });
}
{
	// A legacy marker without a session field never matches (migration path).
	const { deps, files } = makeDeps("never reached");
	files.set("/chats/current-paper.json", JSON.stringify({ base: "a" }));
	await assert.rejects(
		() => runRound({ question: "q", root: "/", session: "s1", embedModel: "fake-embed" }, deps),
		/no paper selected/,
	);
}
{
	// A corrupt marker falls back to the honest missing-paper error.
	const { deps, files } = makeDeps("never reached");
	files.set("/chats/current-paper.json", "{ garbage");
	await assert.rejects(
		() => runRound({ question: "q", root: "/", session: "s1", embedModel: "fake-embed" }, deps),
		/no paper selected/,
	);
}

/* ---------------- unverified paper: filename-only citations ---------------- */
{
	// chatPool exposes unmatched PDFs under a file: identity.
	const pool = chatPool({ matched: [], unmatched: ["x y.pdf"], papersDir: "/p" });
	assert.deepEqual(pool.map((p) => [p.base, p.key, p.file]), [["x y", "file:x y", "/p/x y.pdf"]]);
	assert.equal(pool[0].entry.title, "");
}
{
	const { deps } = makeDeps("Kameras werden beschrieben [1].");
	deps.library = () => ({ matched: library.matched, unmatched: ["c.pdf"], papersDir: "/papers" });
	const warnings: string[] = [];
	const result = await runRound({
		question: "Welche Kameras?", paper: "c.pdf", root: "/", model: "fake-gen", embedModel: "fake-embed",
		onWarn: (m) => warnings.push(m),
	}, deps);
	// The paper works, but nothing bibliographic is invented.
	assert.equal(result.paper.verified, false);
	assert.equal(result.paper.key, "file:c");
	assert.equal(result.paper.title, "");
	assert.equal(result.grounded, true);
	assert.equal(result.references.length, 1);
	assert.equal(result.references[0].key, "file:c");
	assert.equal(result.references[0].doi, "");
	assert.equal(result.references[0].title, "");
	assert.deepEqual(result.references[0].pages, [3]);
	assert.ok(warnings.some((m) => m.includes("no verified bibliographic record")));
}

/* ---------------- unionChunks ---------------- */
{
	const c = (page: number, text: string, score: number): RetrievedChunk =>
		({ id: 0, paper: paperA, page, score, text });
	const union = unionChunks([
		[c(1, "alpha", 0.5), c(2, "beta", 0.4)],
		[c(1, "alpha", 0.9), c(3, "gamma", 0.4)],
	], 10);
	assert.deepEqual(union.map((x) => [x.id, x.page, x.text, x.score]), [
		[1, 1, "alpha", 0.9], // dedupe keeps the max score
		[2, 2, "beta", 0.4], // score tie -> page ascending
		[3, 3, "gamma", 0.4],
	]);
	// The same text on two pages is genuinely two excerpts; the cap trims
	// the tail after ranking.
	const twoPages = unionChunks([[c(1, "same", 0.9), c(2, "same", 0.8), c(3, "tail", 0.1)]], 2);
	assert.deepEqual(twoPages.map((x) => [x.id, x.page]), [[1, 1], [2, 2]]);
}

/* ---------------- default translation wiring ---------------- */
{
	// Without an injected translator the engine asks its own backend for the
	// English query variant (regression guard: the default must never come
	// unwired). The fake generator answers the translation call too, so its
	// output shows up as the disclosed english variant.
	const { deps, generateCalls, embedCalls } = makeDeps("Antwort [1].");
	const answer = await runRound({
		question: "welche kamera?", paper: "a.pdf", root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, { ...deps, translate: undefined });
	assert.equal(generateCalls.length, 2);
	assert.equal(generateCalls[0].system, TRANSLATE_SYSTEM_PROMPT);
	assert.equal(generateCalls[0].user, "welche kamera?");
	assert.deepEqual(answer.query_variants, [
		{ query: "welche kamera?", kind: "original" },
		{ query: "Antwort [1].", kind: "english" },
	]);
	assert.deepEqual(embedCalls[0], ["welche kamera?", "Antwort [1]."]);
}

/* ---------------- runChatReport: session questions drive retrieval ---------------- */
{
	const { deps, files, embedCalls, generateCalls } = makeDeps("Zusammenfassung [1][2].");
	const protocol: Protocol = {
		schema: PROTOCOL_SCHEMA, base: "a", date: "2026-07-15",
		paper: { key: paperA.key, title: paperA.title, authors: paperA.authors, year: paperA.year, doi: paperA.doi, arxiv_id: "" },
		// Rounds of an earlier session and legacy session-less rounds sit in
		// the SAME file -- the report must ignore them (bug 2026-07-21: old
		// questions resurfaced in every report).
		rounds: [
			makeRound("Frage eins?", "s1"), makeRound("Frage zwei?", "s1"), makeRound("Frage eins?", "s1"),
			makeRound("Alte Frage?", "s0"), makeRound("Uralte Frage ohne Session?"),
		],
	};
	files.set("/chats/2026-07-15_a.json", JSON.stringify(protocol));
	const report = await runChatReport({
		question: "Fokus: Validierung?", paper: "a.pdf", session: "s1", root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	// ONE embed call carrying the deduplicated CURRENT-session questions + focus.
	assert.equal(embedCalls.length, 1);
	assert.deepEqual(embedCalls[0], ["Frage eins?", "Frage zwei?", "Fokus: Validierung?"]);
	assert.deepEqual(report.session_questions, ["Frage eins?", "Frage zwei?"]);
	assert.equal(report.focus, "Fokus: Validierung?");
	// Union dedupe: 3 queries over the same 2 paper-A chunks -> 2 excerpts,
	// contiguous ids.
	assert.deepEqual(report.chunks.map((chunk) => chunk.id), [1, 2]);
	assert.equal(generateCalls.length, 1);
	assert.ok(generateCalls[0].user.includes("- Frage eins?"));
	assert.ok(generateCalls[0].user.includes("- Fokus: Validierung?"));
	assert.ok(generateCalls[0].system.includes("summary of ONE scientific paper"));
	assert.equal(report.grounded, true);
	assert.equal(report.references.length, 1); // single paper -> single reference
	// Naming invariant: the report's output slug can never collide with a
	// protocol filename.
	assert.equal(report.question, "Paper chat report: a.pdf");
	assert.ok(querySlug(report.question).startsWith("Paper_chat_report_"));
	// Appendix: only THIS session's rounds, verbatim; the report itself did
	// NOT append a round and the file keeps all 5.
	assert.equal(report.rounds.length, 3);
	assert.ok(report.rounds.every((round) => round.session === "s1"));
	assert.deepEqual(report.protocol_files, ["/chats/2026-07-15_a.json"]);
	assert.equal((JSON.parse(files.get("/chats/2026-07-15_a.json")!) as ChatProtocol).rounds.length, 5);
	// Determinism: an identical second run retrieves the identical excerpts.
	const again = await runChatReport({
		question: "Fokus: Validierung?", paper: "a.pdf", session: "s1", root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	assert.deepEqual(again.chunks, report.chunks);
}

/* ---------------- runChatReport: no session rounds, no focus ---------------- */
{
	// Without a session id, prior rounds are out of scope by design.
	const { deps, embedCalls } = makeDeps("Antwort [1].");
	const warnings: string[] = [];
	const report = await runChatReport({
		paper: "a", root: "/", model: "fake-gen", embedModel: "fake-embed",
		onWarn: (m) => warnings.push(m),
	}, deps);
	assert.deepEqual(embedCalls[0], [DEFAULT_REPORT_QUESTION]);
	assert.deepEqual(report.session_questions, []);
	assert.equal(report.focus, null);
	assert.deepEqual(report.protocol_files, []);
	assert.ok(warnings.some((m) => m.includes("no chat rounds recorded for this session")));
}
{
	// A session with no recorded rounds behaves the same (fresh session,
	// report as the first action).
	const { deps, files, embedCalls } = makeDeps("Antwort [1].");
	files.set("/chats/2026-07-15_a.json", JSON.stringify({
		schema: PROTOCOL_SCHEMA, base: "a", date: "2026-07-15",
		paper: { key: paperA.key, title: paperA.title, authors: paperA.authors, year: paperA.year, doi: paperA.doi, arxiv_id: "" },
		rounds: [makeRound("Alte Frage?", "s0")],
	} satisfies ChatProtocol));
	const warnings: string[] = [];
	const report = await runChatReport({
		paper: "a", session: "s1", root: "/", model: "fake-gen", embedModel: "fake-embed",
		onWarn: (m) => warnings.push(m),
	}, deps);
	assert.deepEqual(embedCalls[0], [DEFAULT_REPORT_QUESTION]);
	assert.deepEqual(report.session_questions, []);
	assert.deepEqual(report.rounds, []);
	assert.deepEqual(report.protocol_files, []);
	assert.ok(warnings.some((m) => m.includes("no chat rounds recorded for this session")));
}

/* ---------------- runRound: multi-paper and library scopes (v25 E2e) ---------------- */
{
	// A selection scope: retrieval across both papers, protocol under a
	// SCOPE identity, sticky remembers the full scope.
	const { deps, files, generateCalls } = makeDeps("Beide zeigen es [1][3].");
	const answer = await runRound({
		question: "Was zeigen die Paper?", papers: ["a", "b"], session: "s1",
		root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	assert.ok(generateCalls[0].system.includes("SET of scientific papers"));
	assert.equal(answer.papers.length, 2);
	assert.deepEqual(answer.scope, ["a", "b"]);
	assert.equal(answer.references.length, 2); // chunk 1 = paper A, chunk 3 = paper B
	assert.equal(answer.protocol_path, "/chats/2026-07-16_scope_a+b.json");
	const protocol = JSON.parse(files.get("/chats/2026-07-16_scope_a+b.json")!) as Protocol;
	assert.equal(protocol.paper.key, "scope:a+b");
	assert.deepEqual(protocol.rounds[0].scope, ["a", "b"]);
	assert.deepEqual(JSON.parse(files.get("/chats/current-scope.json")!), { papers: ["a", "b"], session: "s1" });
	// The next call of the SAME session without any scope reuses it.
	const followUp = await runRound({
		question: "Und die Methoden?", session: "s1", root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	assert.deepEqual(followUp.scope, ["a", "b"]);
}
{
	// The library scope covers the whole pool and is protocolled as such.
	const { deps, files } = makeDeps("Antwort [1].");
	const answer = await runRound({
		question: "Ueberblick?", papers: "library", session: "s1",
		root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	assert.equal(answer.scope, "library");
	assert.equal(answer.papers.length, 2);
	assert.equal(answer.protocol_path, "/chats/2026-07-16_library.json");
	assert.equal((JSON.parse(files.get("/chats/2026-07-16_library.json")!) as Protocol).paper.key, "scope:library");
	assert.deepEqual(JSON.parse(files.get("/chats/current-scope.json")!), { papers: "library", session: "s1" });
}

/* ---------------- runReport: the composable report (v25 E2d) ---------------- */
{
	// Full menu over the whole library: summaries + mode A + review.
	const { deps, files, generateCalls, embedCalls } = makeDeps("Antwort [1].");
	const progress: string[] = [];
	const report = await runReport({
		papers: "library",
		questions: ["Welche Kamera?", "Wo installiert?"],
		summary: "bullets",
		detailMode: "per-paper",
		includeReview: true,
		session: "s1",
		root: "/",
		model: "fake-gen",
		embedModel: "fake-embed",
		onProgress: (m) => progress.push(m),
	}, deps);
	// Unit count: 2 summaries + 2x2 mode A + 1 review = 7 generation calls
	// (translate is off in these deps, so no extra calls).
	assert.equal(generateCalls.length, 7);
	assert.equal(report.units.length, 7);
	assert.deepEqual(report.units.map((unit) => unit.kind), [
		"summary", "summary",
		"detail-per-paper", "detail-per-paper", "detail-per-paper", "detail-per-paper",
		"review",
	]);
	// Summaries: fixed rubric in the system prompt, six facet queries in ONE
	// embed call, confined to the unit's paper.
	assert.ok(generateCalls[0].system.includes("Forschungsziel"));
	assert.ok(generateCalls[0].system.includes("Zukunftsausblick"));
	assert.ok(generateCalls[0].system.includes('lines starting with "- "'));
	assert.deepEqual(embedCalls[0], [...SUMMARY_FACETS]);
	assert.equal(report.units[0].paper_base, "a");
	assert.ok(report.units[0].chunks.every((chunk) => chunk.paper_key === paperA.key));
	assert.equal(report.units[0].format, "bullets");
	// Mode A: didactic prompt, one call per paper x question, confined.
	assert.ok(generateCalls[2].system.includes("understand ONE scientific paper"));
	assert.ok(generateCalls[2].user.includes("Question: Welche Kamera?"));
	assert.equal(report.units[2].paper_base, "a");
	assert.ok(report.units[2].chunks.every((chunk) => chunk.paper_key === paperA.key));
	assert.equal(report.units[5].paper_base, "b");
	// Review: synthesis prompt over the whole scope with the default focus.
	assert.ok(generateCalls[6].system.includes("literature review"));
	assert.ok(generateCalls[6].user.includes(DEFAULT_REVIEW_QUESTION));
	assert.equal(report.units[6].paper_base, null);
	// Global numbering: unit 0 cites paper A -> [1]; unit 1 (summary of B)
	// cites paper B -> its marker was rewritten to the GLOBAL [2].
	assert.equal(report.units[0].prose, "Antwort [1].");
	assert.equal(report.units[1].prose, "Antwort [2].");
	assert.deepEqual(report.references.map((reference) => [reference.n, reference.key]), [
		[1, paperA.key], [2, paperB.key],
	]);
	assert.ok(report.references.every((reference) => reference.pdf_path));
	assert.equal(report.grounded, true);
	// Ticker: one progress line per unit, numbered.
	assert.equal(progress.length, 7);
	assert.ok(progress[0].startsWith("Unit 1/7: Summary"));
	assert.ok(progress[6].includes("Review synthesis"));
	// Scope + sticky: the library scope was remembered for the session.
	assert.deepEqual(report.scope, { papers: ["a", "b"], library: true });
	assert.deepEqual(JSON.parse(files.get("/chats/current-scope.json")!), { papers: "library", session: "s1" });
	assert.equal(report.ui_language, "de");
	assert.equal(report.question, "Report: library");
}

{
	// Mode B: ONE call per question across the whole scope; chunks may span
	// papers. Selection scope of both papers.
	const { deps, generateCalls } = makeDeps("Antwort [1][2].");
	const report = await runReport({
		papers: ["a", "b"],
		questions: ["Welche Methoden?"],
		detailMode: "cross-paper",
		root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	assert.equal(generateCalls.length, 1);
	assert.equal(report.units[0].kind, "detail-cross");
	assert.ok(generateCalls[0].system.includes("literature review")); // synthesis genre
	const cited = new Set(report.units[0].chunks.map((chunk) => chunk.paper_key));
	assert.ok(cited.size >= 1); // cross-paper retrieval ran over ALL indexes
	assert.equal(report.question, "Report: 2 Dokumente");
	assert.equal(report.detail_mode, "cross-paper");
}

{
	// Summary-only single paper; and the empty report is a loud error.
	const { deps, generateCalls } = makeDeps("- Ziel: klar [1].");
	const report = await runReport({
		papers: ["a"], summary: "prose", root: "/", model: "fake-gen", embedModel: "fake-embed",
	}, deps);
	assert.equal(generateCalls.length, 1);
	assert.ok(generateCalls[0].system.includes("one short prose paragraph"));
	assert.equal(report.question, "Report: a.pdf");
	assert.equal(report.summary, "prose");
	assert.equal(report.detail_mode, null);
	await assert.rejects(
		() => runReport({ papers: ["a"], root: "/", embedModel: "fake-embed" }, deps),
		/empty report/,
	);
}

{
	// The rubric prompt is pinned: bullets vs prose differ only in style.
	assert.ok(summarySystemPrompt("bullets", "German").includes("Untersuchungsort"));
	assert.ok(summarySystemPrompt("prose", "German").includes("Write in German"));
}

{
	// scopeProtocolId mirrors what runRound records (v27: the adapter uses
	// it to look up the session's questions as the report-wizard seed).
	const pool = [
		{ file: "/p/a.pdf", base: "a", key: "10.1/a", entry: { title: "A", pdf_url: "", doi: "10.1/a", arxiv_id: "", authors: [], year: null } },
		{ file: "/p/b.pdf", base: "b", key: "file:b", entry: { title: "", pdf_url: "", doi: "", arxiv_id: "", authors: [], year: null } },
	];
	assert.deepEqual(scopeProtocolId("library", pool), { base: "library", key: "scope:library" });
	assert.deepEqual(scopeProtocolId(["a"], pool), { base: "a", key: "10.1/a" });
	assert.equal(scopeProtocolId(["ghost"], pool), null);
	// Multi scope: sorted members, independent of the pool.
	assert.deepEqual(scopeProtocolId(["b", "a"], pool), { base: "scope_a+b", key: "scope:a+b" });
	// Overlong member lists collapse to the deterministic short form.
	const many = Array.from({ length: 12 }, (_, i) => `paper_number_${String(i).padStart(2, "0")}`);
	const long = scopeProtocolId(many, pool);
	assert.equal(long?.base, "scope_paper_number_00_and_11_more");
	assert.ok(long?.key.startsWith("scope:paper_number_00+"));
}

console.log("round/report engine tests passed");
