/**
 * Offline tests of the chat dialog state machine: the parsers, the full
 * search -> pick -> download -> ask -> report walk-through, the two direct
 * ways into the PDFs, the no-model fallbacks, facet failures, the mailto
 * paths, job failure and cancel, restart and back. No network, no disk.
 * Run: node src/web/dialog.test.ts
 */

import assert from "node:assert/strict";

import {
	type DialogContext,
	type DialogEvent,
	type DialogState,
	type Effect,
	formFromAnswers,
	globalCommand,
	initialDialog,
	isHandBuilt,
	parseBlockLines,
	parseListAnswer,
	parsePeriodAnswer,
	parsePickAnswer,
	parseQuestions,
	parseTweak,
	periodYears,
	reduce,
	stageOfStep,
} from "./dialog.ts";
import type { JobInfo } from "./jobs.ts";

const library = [
	{ base: "2016_Legleiter", title: "Inferring river bathymetry", year: "2016", authors: ["Carl J. Legleiter"] },
	{ base: "2022_Salavitabar", title: "Mapping underwater bathymetry", year: "2022", authors: ["Shayan Salavitabar", "S. Samuel Li"] },
];

function context(patch: Partial<DialogContext> = {}): DialogContext {
	return {
		thisYear: 2026,
		hasModel: true,
		modelLabel: "stub via test",
		noModelHint: "choose one with /model in pi",
		mailtoSet: false,
		library,
		sources: ["arXiv", "CrossRef", "OpenAlex"],
		sourcesSkipped: ["Semantic Scholar"],
		storedTopics: [],
		...patch,
	};
}

/** Apply one event; returns the new state and effects. */
function step(state: DialogState, event: DialogEvent, ctx = context()): { state: DialogState; effects: Effect[] } {
	return reduce(state, event, ctx);
}

function last(state: DialogState) {
	return state.messages[state.messages.length - 1];
}

function chipIds(state: DialogState): string[] {
	return (last(state).chips ?? []).map((chip) => chip.id);
}

function job(kind: JobInfo["kind"], id: string, state: JobInfo["state"] = "running", error?: string): JobInfo {
	return { id, kind, label: `${kind} job`, state, started: "2026-10-19T10:00:00Z", ...(error ? { error } : {}) };
}

// ---- parsers ----
{
	assert.deepEqual(parsePeriodAnswer("all", 2026), { preset: "all" });
	assert.deepEqual(parsePeriodAnswer("last 5 years", 2026), { preset: "5y", yearFrom: 2022 });
	assert.deepEqual(parsePeriodAnswer("7 years", 2026), { preset: "custom", yearFrom: 2020 });
	assert.deepEqual(parsePeriodAnswer("2015-2024", 2026), { preset: "custom", yearFrom: 2015, yearTo: 2024 });
	assert.deepEqual(parsePeriodAnswer("2015-", 2026), { preset: "custom", yearFrom: 2015 });
	assert.deepEqual(parsePeriodAnswer("2020", 2026), { preset: "custom", yearFrom: 2020, yearTo: 2020 });
	assert.equal(parsePeriodAnswer("whenever", 2026), null);
	assert.deepEqual(periodYears({ preset: "10y" }, 2026), { yearFrom: 2017 });
	assert.deepEqual(periodYears({ preset: "all" }, 2026), {});

	const labels = ["Water Resources Research", "Remote Sensing", "Geosciences"];
	assert.deepEqual(parseListAnswer("all", labels), { kind: "all" });
	assert.deepEqual(parseListAnswer("1, 3", labels), { kind: "picked", indexes: [0, 2] });
	assert.deepEqual(parseListAnswer("3 1 3", labels), { kind: "picked", indexes: [2, 0] });
	assert.deepEqual(parseListAnswer("9", labels), { kind: "none" });
	assert.deepEqual(parseListAnswer("remote", labels), { kind: "picked", indexes: [1] });
	assert.deepEqual(parseListAnswer("nature", labels), { kind: "none" });

	assert.deepEqual(parseBlockLines("satellite OR remote sensing\nbathymetry\n\nriver"), ["satellite OR remote sensing", "bathymetry", "river"]);
	assert.deepEqual(parseBlockLines("(satellite OR sensing) AND (river)"), ["satellite OR sensing", "river"]);
	assert.deepEqual(parseBlockLines("  "), []);

	const candidates = [
		{ id: "10.1000/a", title: "A", year: "2020", access: "free", group: "on_target", dropped: false, inLibrary: false, code: true },
		{ id: "10.1000/b", title: "B", year: "2021", access: "restricted", group: "adjacent", dropped: false, inLibrary: false, code: false },
		{ id: "arXiv:2401.00001", title: "C", year: "2024", access: null, group: null, dropped: true, inLibrary: false, code: false },
	];
	assert.deepEqual(parsePickAnswer("all", candidates), { kind: "all" });
	assert.deepEqual(parsePickAnswer("code", candidates), { kind: "code" });
	assert.deepEqual(parsePickAnswer("1, 2", candidates), { kind: "ids", ids: ["10.1000/a", "10.1000/b"] });
	assert.deepEqual(parsePickAnswer("3", candidates), { kind: "none" }); // dropped rows are not numbered
	assert.deepEqual(parsePickAnswer("10.3390/rs13081505 arXiv:2401.00001v2", candidates), { kind: "ids", ids: ["10.3390/rs13081505", "arXiv:2401.00001v2"] });
	assert.deepEqual(parsePickAnswer("Download these papers: doi:10.1000/x", candidates), { kind: "ids", ids: ["10.1000/x"] });
	assert.deepEqual(parsePickAnswer("hello", candidates), { kind: "none" });

	assert.deepEqual(parseTweak("count 30"), { kind: "count", value: 30 });
	assert.deepEqual(parseTweak("count 500"), { kind: "count", value: 50 });
	assert.deepEqual(parseTweak("cites 5"), { kind: "cites", value: 5 });
	assert.deepEqual(parseTweak("code off"), { kind: "code", on: false });
	assert.equal(parseTweak("hello"), null);

	assert.deepEqual(parseQuestions("Which sensors?\nIs code published?"), ["Which sensors?", "Is code published?"]);
	assert.deepEqual(parseQuestions("Which sensors? Is code published?"), ["Which sensors?", "Is code published?"]);
	assert.deepEqual(parseQuestions("One question only"), ["One question only"]);
	assert.equal(globalCommand("Start over"), "restart");
	assert.equal(globalCommand("back"), "back");
	assert.equal(globalCommand("river"), null);
	assert.ok(isHandBuilt("(river OR stream) AND (depth)"));
	assert.ok(isHandBuilt("river,stream;depth"));
	assert.ok(!isHandBuilt("methods using satellite imagery (Sentinel 2) to classify water"));
	assert.deepEqual(stageOfStep("pick"), { stage: 1, label: "choose papers" });
	assert.deepEqual(stageOfStep("ask"), { stage: 2, label: "questions + report" });
	assert.deepEqual(stageOfStep("reporting"), { stage: 2, label: "writing the report" });
}

// ---- the search walk-through ----
{
	let state = initialDialog(context());
	assert.equal(state.step, "start");
	assert.deepEqual(chipIds(state), ["search", "pdfChat", "pdfReport"]);
	assert.match(last(state).note ?? "", /2 PDFs/);

	// Typing at the start counts as the topic; a prose topic asks the model.
	let out = step(state, { kind: "answer", text: "Which methods estimate river bathymetry from satellite images?" });
	state = out.state;
	assert.equal(state.pending, "asking the model for keyword blocks");
	assert.deepEqual(out.effects, [{ kind: "proposeBlocks", query: "Which methods estimate river bathymetry from satellite images?" }]);
	assert.equal(last(state).role, "user");

	// Answers while an effect is pending are refused.
	out = step(state, { kind: "answer", text: "hurry" });
	assert.match(last(out.state).text ?? "", /Still working/);

	// The model's proposal: plus1 row becomes the editable blocks.
	out = step(state, { kind: "blocks", variants: [
		{ role: "plus1", text: "(satellite OR remote sensing) AND (bathymetry OR water depth) AND (river OR fluvial)" },
		{ role: "plus2", text: "(satellite OR remote sensing OR Sentinel) AND (bathymetry OR water depth OR depth) AND (river OR fluvial OR stream)" },
		{ role: "arxiv", text: "(satellite OR SAR) AND (depth) AND (river)" },
	] });
	state = out.state;
	assert.equal(state.step, "blocks");
	assert.equal(state.pending, null);
	assert.deepEqual(last(state).editor, ["satellite OR remote sensing", "bathymetry OR water depth", "river OR fluvial"]);
	assert.deepEqual(chipIds(state), ["use", "useVariants", "again"]);

	// Edited lines win; the code question follows.
	out = step(state, { kind: "answer", chip: "use", blocks: ["satellite OR remote sensing", "bathymetry", "river"] });
	state = out.state;
	assert.equal(state.step, "code");
	assert.deepEqual(state.answers.blocks, ["satellite OR remote sensing", "bathymetry", "river"]);
	assert.ok(state.messages.filter((message) => message.role === "assistant" && message.spent).length >= 1, "older chips are spent");

	// Yes to code -> topics are suggested for the awesome lists.
	out = step(state, { kind: "answer", chip: "yes" });
	state = out.state;
	assert.deepEqual(out.effects, [{ kind: "loadTopics", query: "(satellite OR remote sensing) AND (bathymetry) AND (river)" }]);
	assert.equal(state.answers.codeSources.length, 4);
	out = step(state, { kind: "topics", topics: [{ topic: "remote-sensing", lists: 8 }, { topic: "hydrology", lists: 2 }, { topic: "nothing-here", lists: 0 }] });
	state = out.state;
	assert.equal(state.step, "topics");
	assert.deepEqual(chipIds(state), ["use", "skip"]);
	assert.deepEqual(last(state).list?.items.map((item) => item.id), ["remote-sensing", "hydrology"]); // zero-list topics hidden
	assert.equal(last(state).list?.open, true);
	// A typed word adds a topic and keeps the question open.
	out = step(state, { kind: "answer", text: "Bathymetry", toggles: ["remote-sensing"] });
	state = out.state;
	assert.equal(state.step, "topics");
	assert.deepEqual(state.answers.topicsOn, ["remote-sensing", "bathymetry"]);
	out = step(state, { kind: "answer", chip: "use", toggles: ["remote-sensing", "bathymetry"] });
	state = out.state;
	assert.equal(state.step, "period");

	// Period typed as a range -> journals are looked up with that range.
	out = step(state, { kind: "answer", text: "2015-2024" });
	state = out.state;
	assert.deepEqual(out.effects, [{ kind: "loadJournals", query: "(satellite OR remote sensing) AND (bathymetry) AND (river)", yearFrom: 2015, yearTo: 2024 }]);
	const journals = Array.from({ length: 14 }, (_, i) => ({ id: `S${i}`, name: `Journal ${i + 1}`, works: 20 - i, score: null }));
	out = step(state, { kind: "journals", journals });
	state = out.state;
	assert.equal(state.step, "journals");
	assert.deepEqual(chipIds(state), ["all", "use"]); // actions first, items in the list below
	assert.equal(last(state).list?.items.length, 14);
	assert.equal(last(state).list?.open, false);
	assert.match(last(state).list?.summary ?? "", /14 journals/);
	// Numbers refer to the list's own numbering.
	out = step(state, { kind: "answer", text: "1, 3" });
	state = out.state;
	assert.deepEqual(state.answers.journalsOn, ["S0", "S2"]);
	assert.deepEqual(out.effects, [{ kind: "loadAuthors", query: "(satellite OR remote sensing) AND (bathymetry) AND (river)", yearFrom: 2015, yearTo: 2024, sourceIds: ["S0", "S2"] }]);

	// Authors: a typed name triggers the lookup, a pick asks for the scope.
	out = step(state, { kind: "authors", authors: [{ id: "A1", name: "Carl J. Legleiter", works: 9 }, { id: "A2", name: "Shayan Salavitabar", works: 3 }] });
	state = out.state;
	assert.equal(state.step, "authors");
	out = step(state, { kind: "answer", text: "Tarpanelli" });
	state = out.state;
	assert.deepEqual(out.effects, [{ kind: "lookupAuthor", prefix: "Tarpanelli" }]);
	out = step(state, { kind: "authorLookup", matches: [{ id: "A9", name: "Angelica Tarpanelli", hint: "CNR IRPI, Italy", works: 80, cites: 2000, orcid: "" }] });
	state = out.state;
	assert.ok(chipIds(state).includes("pick:A9"));
	out = step(state, { kind: "answer", chip: "pick:A9" });
	state = out.state;
	assert.equal(state.step, "authorScope");
	assert.equal(state.answers.pickedAuthor?.id, "A9");
	out = step(state, { kind: "answer", chip: "all" });
	state = out.state;
	assert.equal(state.step, "confirm");
	assert.match(last(state).text ?? "", /Angelica Tarpanelli \(all their works\)/);
	assert.match(last(state).text ?? "", /Period: 2015-2024/);
	assert.match(last(state).text ?? "", /topics remote-sensing, bathymetry/);
	assert.match(last(state).note ?? "", /15 records per source/);

	// Tweaks re-render the summary; the form carries everything.
	out = step(state, { kind: "answer", text: "count 30" });
	state = out.state;
	assert.equal(state.answers.perSource, 30);
	assert.match(last(state).note ?? "", /30 records per source/);
	out = step(state, { kind: "answer", text: "cites 5" });
	state = out.state;
	assert.equal(state.answers.minCites, 5);
	const form = formFromAnswers(state.answers, 2026);
	assert.deepEqual(form.blocks, ["satellite OR remote sensing", "bathymetry", "river"]);
	assert.equal(form.period, "custom");
	assert.equal(form.yearFrom, 2015);
	assert.equal(form.yearTo, 2024);
	assert.equal(form.perSource, 30);
	assert.equal(form.minCites, 5);
	assert.deepEqual(form.codeTopics, ["remote-sensing", "bathymetry"]);
	assert.deepEqual(form.journals, ["Journal 1", "Journal 3"]);
	assert.equal(form.journalsOther, false);
	assert.deepEqual(form.pickedAuthors, [{ id: "A9", name: "Angelica Tarpanelli" }]);
	assert.equal(form.authorScope, "all");
	assert.deepEqual(form.variants, []);

	// Search.
	out = step(state, { kind: "answer", chip: "search" });
	state = out.state;
	assert.equal(out.effects[0].kind, "startSearch");
	out = step(state, { kind: "jobStarted", job: job("search", "search-1") });
	state = out.state;
	assert.equal(state.step, "searching");
	assert.equal(state.activeJob, "search-1");
	assert.equal(last(state).role, "working");
	// Answers during a job are refused; foreign job events are ignored.
	out = step(state, { kind: "answer", text: "status?" });
	assert.match(last(out.state).text ?? "", /Please wait/);
	out = step(state, { kind: "job", job: job("search", "other-7", "done") });
	assert.equal(out.state.activeJob, "search-1");
	const candidates = [
		{ id: "10.1000/a", title: "A", year: "2020", access: "free", group: "on_target", dropped: false, inLibrary: false, code: true },
		{ id: "10.1000/b", title: "B", year: "2021", access: "restricted", group: "on_target", dropped: false, inLibrary: false, code: false },
		{ id: "10.1000/c", title: "C", year: "2022", access: "abstract_only", group: "adjacent", dropped: false, inLibrary: true, code: false },
	];
	out = step(state, { kind: "job", job: job("search", "search-1", "done"), search: { name: "2026-10-19_run", htmlUrl: "/files/lit-search/2026-10-19_run.html", included: 3, dropped: 2, candidates } });
	state = out.state;
	assert.equal(state.step, "pick");
	assert.equal(state.activeJob, null);
	const cardMessage = state.messages.find((message) => message.role === "card");
	assert.equal(cardMessage?.card?.name, "2026-10-19_run.html");
	assert.equal(cardMessage?.card?.url, "/files/lit-search/2026-10-19_run.html");
	assert.deepEqual(chipIds(state), ["ticked", "code", "all", "skip"]);
	assert.match((last(state).chips ?? [])[2].label, /\(2\)/); // two on-target rows not in the library

	// Ticked without ticks -> re-ask; row numbers -> mailto (none configured).
	out = step(state, { kind: "answer", chip: "ticked", ids: [] });
	assert.match(last(out.state).note ?? "", /Nothing is ticked/);
	out = step(state, { kind: "answer", text: "1, 2" });
	state = out.state;
	assert.deepEqual(state.answers.pickIds, ["10.1000/a", "10.1000/b"]);
	assert.equal(state.step, "mailto");
	out = step(state, { kind: "answer", text: "not an email" });
	assert.equal(out.state.step, "mailto");
	assert.match(last(out.state).text ?? "", /does not look like an email/);
	out = step(state, { kind: "answer", text: "me@example.org" });
	state = out.state;
	assert.equal(state.step, "mailtoSave");
	out = step(state, { kind: "answer", chip: "save" });
	state = out.state;
	assert.equal(state.step, "download");
	assert.match(last(state).text ?? "", /Download \*\*2 papers\*\*/);
	assert.match(last(state).text ?? "", /1 restricted/);
	out = step(state, { kind: "answer", chip: "download" });
	state = out.state;
	assert.deepEqual(out.effects, [{ kind: "startSelection", identifiers: ["10.1000/a", "10.1000/b"], mailto: "me@example.org", saveMailto: true, withoutUnpaywall: false }]);
	out = step(state, { kind: "jobStarted", job: job("selection", "selection-2") });
	state = out.state;
	assert.equal(state.step, "downloading");
	out = step(state, { kind: "job", job: job("selection", "selection-2", "done"), download: { downloaded: 1, already: 0, browser: [{ id: "10.1000/b", url: "https://doi.org/10.1000/b" }], notFree: 0, failed: 0, libraryCount: 3 } });
	state = out.state;
	assert.equal(state.step, "ask");
	assert.equal(state.answers.scope, "library");
	const folder = state.messages.find((message) => message.card?.kind === "folder");
	assert.equal(folder?.card?.name, "lit-selection/");
	assert.match(folder?.card?.label ?? "", /1 PDF added, 3 in the library/);
	assert.match(state.messages.find((message) => message.note?.includes("Only in the browser"))?.note ?? "", /10\.1000\/b: https:\/\/doi\.org\/10\.1000\/b/);

	// A question runs a chat job; the answer lands as an answer message.
	out = step(state, { kind: "answer", text: "Which sensors are used?" });
	state = out.state;
	assert.deepEqual(out.effects, [{ kind: "startChat", question: "Which sensors are used?", papers: "library" }]);
	out = step(state, { kind: "jobStarted", job: job("chat", "chat-3") });
	state = out.state;
	assert.equal(state.step, "answering");
	const answer = { question: "Which sensors are used?", prose: "Optical [1].", grounded: true, sites: [], references: [], papers: [], chunks: [] } as never;
	out = step(state, { kind: "job", job: job("chat", "chat-3", "done"), answer: { answer, hrefs: [], pdfUrls: {} } });
	state = out.state;
	assert.equal(state.step, "ask");
	assert.equal(state.messages.filter((message) => message.role === "answer").length, 1);
	assert.deepEqual(state.answers.questions, ["Which sensors are used?"]);

	// Build a report over the library: pick papers, then questions, then the kind.
	out = step(state, { kind: "answer", chip: "report" });
	state = out.state;
	assert.equal(state.step, "pickPapers");
	out = step(state, { kind: "answer", chip: "use", toggles: ["2016_Legleiter", "2022_Salavitabar"] });
	state = out.state;
	assert.equal(state.step, "questions");
	out = step(state, { kind: "answer", text: "Which sensors? Is code published?" });
	state = out.state;
	assert.equal(state.step, "reportKind");
	assert.deepEqual(state.answers.questions, ["Which sensors?", "Is code published?"]);
	out = step(state, { kind: "answer", chip: "crossPaper" });
	state = out.state;
	assert.deepEqual(out.effects, [{ kind: "startReport", papers: ["2016_Legleiter", "2022_Salavitabar"], questions: ["Which sensors?", "Is code published?"], summary: "none", detailMode: "cross-paper", includeReview: false, language: "en" }]);
	out = step(state, { kind: "jobStarted", job: job("report", "report-4") });
	state = out.state;
	assert.equal(state.step, "reporting");
	out = step(state, { kind: "job", job: job("report", "report-4", "done"), report: { name: "2026-10-19_synthesis_report_x", htmlUrl: "/files/lit-synthesis/2026-10-19_synthesis_report_x.html", grounded: true, units: 4 } });
	state = out.state;
	assert.equal(state.step, "finished");
	assert.equal(state.messages.filter((message) => message.card?.kind === "file").length, 2);
	assert.match(last(state).text ?? "", /Ask another question/);

	// Restart asks first, then resets and opens a new chat session.
	out = step(state, { kind: "answer", text: "start over" });
	state = out.state;
	assert.equal(state.step, "confirmRestart");
	out = step(state, { kind: "answer", chip: "no" });
	assert.equal(out.state.step, "finished");
	out = step(state, { kind: "answer", chip: "yes" });
	assert.equal(out.state.step, "start");
	assert.equal(out.state.messages.length, 1);
	assert.deepEqual(out.effects, [{ kind: "newChatSession" }]);
}

// ---- block expression typed directly, code "no", period chip, "back", variants on ----
{
	let state = initialDialog(context());
	let out = step(state, { kind: "answer", chip: "search" });
	state = out.state;
	assert.equal(state.step, "topic");
	out = step(state, { kind: "answer", text: "(river OR stream) AND (bathymetry)" });
	state = out.state;
	assert.equal(state.step, "blocks");
	assert.deepEqual(out.effects, []); // the user's own structure needs no model
	assert.deepEqual(last(state).editor, ["river OR stream", "bathymetry"]);
	// A typed replacement of the blocks as lines.
	out = step(state, { kind: "answer", text: "river\nwater depth OR bathymetry" });
	state = out.state;
	assert.deepEqual(state.answers.blocks, ["river", "water depth OR bathymetry"]);
	assert.equal(state.step, "code");
	// "back" returns to the blocks question with the lines kept.
	out = step(state, { kind: "answer", text: "back" });
	state = out.state;
	assert.equal(state.step, "blocks");
	assert.deepEqual(last(state).editor, ["river", "water depth OR bathymetry"]);
	out = step(state, { kind: "answer", chip: "use" });
	state = out.state;
	out = step(state, { kind: "answer", text: "no" });
	state = out.state;
	assert.equal(state.step, "period");
	assert.deepEqual(state.answers.codeSources, []);
	out = step(state, { kind: "answer", chip: "5y" });
	state = out.state;
	assert.deepEqual(out.effects, [{ kind: "loadJournals", query: "(river) AND (water depth OR bathymetry)", yearFrom: 2022 }]);
	// Facet failure: note, then straight on to the authors.
	out = step(state, { kind: "journals", journals: [], error: "HTTP 429" });
	state = out.state;
	assert.equal(out.effects[0].kind, "loadAuthors");
	assert.match(state.messages[state.messages.length - 1].text ?? "", /Journals could not be loaded \(HTTP 429\)/);
	out = step(state, { kind: "authors", authors: [] });
	state = out.state;
	assert.equal(state.step, "confirm");
	assert.match(last(state).text ?? "", /Journals: all · Authors: all/);
	assert.match(last(state).text ?? "", /Papers with code: off/);
	// "code on" from the summary with no model and no stored topics skips the topics question.
	out = step(state, { kind: "answer", text: "code on" }, context({ hasModel: false }));
	state = out.state;
	assert.equal(state.step, "period");
	assert.equal(state.answers.codeSources.length, 4);
}

// ---- no model: blocks derived word by word, questions refused ----
{
	const ctx = context({ hasModel: false, modelLabel: null });
	let state = initialDialog(ctx);
	assert.match(last(state).note ?? "", /No model is selected yet/);
	let out = step(state, { kind: "answer", text: "sandbar detection rivers Sentinel-2" }, ctx);
	state = out.state;
	assert.equal(state.step, "blocks");
	assert.deepEqual(out.effects, []);
	assert.deepEqual(last(state).editor, ["sandbar", "detection", "rivers", "sentinel-2"]);
	assert.match(last(state).note ?? "", /No model is selected/);
	assert.ok(!chipIds(state).includes("again"));
	// The model failing to propose falls back the same way.
	let s2 = initialDialog(context());
	s2 = step(s2, { kind: "answer", text: "prose request about rivers and depth" }).state;
	s2 = step(s2, { kind: "effectFailed", effect: "proposeBlocks", error: "timeout" }).state;
	assert.equal(s2.step, "blocks");
	assert.match(last(s2).note ?? "", /timeout/);
	s2 = step(s2, { kind: "blocks", variants: null, error: "empty answer" }).state; // late event after a fallback is harmless
	assert.equal(s2.step, "blocks");
	// Direct way: chat about one PDF, single pick, then a question without a model is refused.
	let s3 = initialDialog(ctx);
	s3 = step(s3, { kind: "answer", chip: "pdfChat" }, ctx).state;
	assert.equal(s3.step, "pickPaper");
	assert.equal(last(s3).list?.single, true);
	assert.equal(last(s3).list?.items.length, 2);
	s3 = step(s3, { kind: "answer", chip: "use", toggles: ["2022_Salavitabar"] }, ctx).state;
	assert.equal(s3.step, "ask");
	assert.deepEqual(s3.answers.scope, ["2022_Salavitabar"]);
	assert.match(last(s3).text ?? "", /cannot answer questions right now/);
	out = step(s3, { kind: "answer", text: "What depth range?" }, ctx);
	assert.deepEqual(out.effects, []);
	assert.equal(out.state.step, "ask");
}

// ---- all suggested topics without lists: the awesome lists are left out ----
{
	let state = initialDialog(context());
	state = step(state, { kind: "answer", text: "(river) AND (depth)" }).state;
	state = step(state, { kind: "answer", chip: "use" }).state;
	state = step(state, { kind: "answer", chip: "yes" }).state;
	const out = step(state, { kind: "topics", topics: [{ topic: "a", lists: 0 }, { topic: "b", lists: 0 }] });
	assert.equal(out.state.step, "period");
	assert.ok(!out.state.answers.codeSources.includes("awesome-lists"));
	assert.equal(out.state.answers.codeSources.length, 3);
	assert.match(out.state.messages[out.state.messages.length - 2].text ?? "", /left out of this search/);
	// A prose request with parentheses asks the model instead of being taken as blocks.
	let s2 = initialDialog(context());
	const prose = step(s2, { kind: "answer", text: "I want to look for methods using satellite imagery (Sentinel 2) to classify water" });
	assert.deepEqual(prose.effects.map((effect) => effect.kind), ["proposeBlocks"]);
}

// ---- empty library: PDF ways disabled; mailto configured skips the question; job failure and cancel ----
{
	const ctx = context({ library: [], mailtoSet: true });
	let state = initialDialog(ctx);
	assert.equal((last(state).chips ?? [])[1].disabled, true);
	assert.match(last(state).note ?? "", /no PDFs yet/);
	state = step(state, { kind: "answer", text: "(river) AND (depth)" }, ctx).state;
	state = step(state, { kind: "answer", chip: "use" }, ctx).state;
	state = step(state, { kind: "answer", chip: "no" }, ctx).state;
	state = step(state, { kind: "answer", chip: "all" }, ctx).state;
	state = step(state, { kind: "journals", journals: [] }, ctx).state;
	state = step(state, { kind: "authors", authors: [] }, ctx).state;
	assert.equal(state.step, "confirm");
	let out = step(state, { kind: "answer", chip: "search" }, ctx);
	state = step(out.state, { kind: "jobStarted", job: job("search", "search-1") }, ctx).state;
	// Failure: the summary comes back with Try again.
	out = step(state, { kind: "job", job: job("search", "search-1", "failed", "OpenAlex unreachable") }, ctx);
	assert.equal(out.state.step, "confirm");
	assert.match(last(out.state).text ?? "", /Failed: OpenAlex unreachable/);
	assert.deepEqual(chipIds(out.state), ["search", "changeBlocks", "restart"]);
	assert.equal(out.state.messages.find((message) => message.role === "working")?.jobState, "failed");
	// Cancel reads as Stopped.
	out = step(state, { kind: "job", job: job("search", "search-1", "cancelled") }, ctx);
	assert.match(last(out.state).text ?? "", /Stopped\./);
	// Success with a configured mailto: pick goes straight to the download question.
	const candidates = [{ id: "10.1000/a", title: "A", year: "2020", access: "free", group: "on_target", dropped: false, inLibrary: false, code: false }];
	out = step(state, { kind: "job", job: job("search", "search-1", "done"), search: { name: "run", htmlUrl: "/files/lit-search/run.html", included: 1, dropped: 0, candidates } }, ctx);
	state = out.state;
	assert.deepEqual(chipIds(state), ["ticked", "all"]); // no code rows, no library -> no skip chip
	state = step(state, { kind: "answer", chip: "all" }, ctx).state;
	assert.equal(state.step, "download");
	out = step(state, { kind: "answer", chip: "download" }, ctx);
	assert.deepEqual(out.effects, [{ kind: "startSelection", identifiers: ["10.1000/a"], mailto: undefined, saveMailto: undefined, withoutUnpaywall: false }]);
	state = step(out.state, { kind: "jobStarted", job: job("selection", "selection-2") }, ctx).state;
	// Nothing downloaded and the library still empty -> back to the pick with a note.
	out = step(state, { kind: "job", job: job("selection", "selection-2", "done"), download: { downloaded: 0, already: 0, browser: [], notFree: 1, failed: 0, libraryCount: 0 } }, ctx);
	assert.equal(out.state.step, "pick");
	assert.match(out.state.messages.map((message) => message.text ?? "").join("\n"), /Nothing could be downloaded/);
	// Effect failure (409 busy, for instance) returns to the question.
	out = step(state, { kind: "effectFailed", effect: "startSelection", error: "a job is already running" }, ctx);
	assert.equal(out.state.step, "download");
	assert.match(out.state.messages[out.state.messages.length - 2].text ?? "", /could not start/);
}

// ---- rail stages switch within the conversation ----
{
	let state = initialDialog(context());
	state = step(state, { kind: "answer", chip: "pdfChat" }).state;
	state = step(state, { kind: "answer", chip: "library" }).state;
	assert.equal(state.step, "ask");
	let out = step(state, { kind: "answer", chip: "goSelection" });
	assert.equal(out.state.step, "start");
	assert.match(last(out.state).text ?? "", /No search report in this conversation yet/);
	out = step(state, { kind: "answer", chip: "goSearch" });
	assert.equal(out.state.step, "topic");
	assert.equal(out.state.messages.filter((message) => message.role === "user").slice(-1)[0].text, "1 Search");
	out = step(state, { kind: "answer", chip: "goSynthesis" }, context({ library: [] }));
	assert.match(last(out.state).text ?? "", /no PDFs yet/);
}

// ---- direct way: synthesis report over several papers, whole library, summaries only ----
{
	let state = initialDialog(context());
	state = step(state, { kind: "answer", chip: "pdfReport" }).state;
	assert.equal(state.step, "pickPapers");
	state = step(state, { kind: "answer", chip: "library" }).state;
	assert.equal(state.step, "questions");
	state = step(state, { kind: "answer", chip: "none" }).state;
	assert.equal(state.step, "reportKind");
	let out = step(state, { kind: "answer", chip: "crossPaper" });
	assert.equal(out.state.step, "questions"); // cross-paper answers need a question
	out = step(state, { kind: "answer", chip: "bullets" });
	assert.deepEqual(out.effects, [{ kind: "startReport", papers: "library", questions: [], summary: "bullets", detailMode: "per-paper", includeReview: false, language: "en" }]);
	out = step(state, { kind: "answer", chip: "review" });
	assert.equal((out.effects[0] as { includeReview: boolean }).includeReview, true);
	// German questions -> German report (prose and page headings), the chat itself stays English.
	let german = initialDialog(context());
	german = step(german, { kind: "answer", chip: "pdfReport" }).state;
	german = step(german, { kind: "answer", chip: "library" }).state;
	german = step(german, { kind: "answer", text: "Welche Sensoren wurden genutzt? Gibt es veröffentlichten Code?" }).state;
	assert.equal(german.step, "reportKind");
	out = step(german, { kind: "answer", chip: "perPaper" });
	assert.equal((out.effects[0] as { language: string }).language, "de");
	// Typed numbers pick papers too.
	let s2 = initialDialog(context());
	s2 = step(s2, { kind: "answer", chip: "pdfReport" }).state;
	s2 = step(s2, { kind: "answer", text: "2" }).state;
	assert.deepEqual(s2.answers.scope, ["2022_Salavitabar"]);
}

// ---- the question channel: asking instead of answering never moves the wizard ----
{
	// Question mode on a text step: pending + one helpAnswer effect, the step and answers untouched.
	let s = step(initialDialog(context()), { kind: "answer", chip: "goSearch" }).state;
	assert.equal(s.step, "topic");
	let r = step(s, { kind: "answer", text: "can i search in german?", ask: true });
	assert.equal(r.state.step, "topic");
	assert.equal(r.state.answers.topic, "");
	assert.equal(r.state.pending, "looking up the help");
	assert.equal(r.effects.length, 1);
	assert.equal(r.effects[0].kind, "helpAnswer");
	if (r.effects[0].kind === "helpAnswer") {
		assert.equal(r.effects[0].step, "topic");
		assert.ok(r.effects[0].user.includes("USER QUESTION: can i search in german?"));
		assert.ok(r.effects[0].user.includes("Open question: Answering: what you are looking for"));
	}
	assert.equal(last(r.state).role, "user");
	// The model's answer lands as a help message with navigation chips; "continue" re-asks the open question.
	s = step(r.state, { kind: "helpAnswered", text: "Yes, any language works." }).state;
	assert.equal(s.pending, null);
	assert.equal(last(s).help, "model");
	assert.equal(last(s).text, "Yes, any language works.");
	assert.deepEqual(chipIds(s), ["continue", "back", "restart"]);
	s = step(s, { kind: "answer", chip: "continue" }).state;
	assert.equal(s.step, "topic");
	assert.equal(last(s).text?.startsWith("What are you looking for?"), true);
	// No model: the fixed help text, no effect. A leading "?" is question mode too.
	r = step(s, { kind: "answer", text: "? how do I go back" }, context({ hasModel: false }));
	assert.equal(r.effects.length, 0);
	assert.equal(last(r.state).help, "fixed");
	assert.ok(last(r.state).text?.includes("Accepted input:"));
	assert.equal(r.state.messages[r.state.messages.length - 2].text, "how do I go back");
	// A failed model call also falls back to the fixed text, with the error in the note.
	r = step(s, { kind: "answer", text: "hello?", ask: true });
	s = step(r.state, { kind: "helpAnswered", text: null, error: "timeout" }).state;
	assert.equal(last(s).help, "fixed");
	assert.ok(last(s).note?.includes("timeout"));
	assert.equal(s.step, "topic");

	// Small talk at the start: the fixed text says what the tool is, no model call, the step stays.
	r = step(initialDialog(context()), { kind: "answer", text: "what can you do?" });
	assert.equal(r.effects.length, 0);
	assert.equal(r.state.step, "start");
	assert.equal(last(r.state).help, "fixed");
	assert.ok(last(r.state).text?.includes("literature tool"));
	// A parser miss on a text step: question-like input goes to the helper with the parser's note; a plain miss is re-asked as before.
	s = step(s, { kind: "answer", text: "river depth" }).state;
	s = step(s, { kind: "blocks", variants: null }).state;
	assert.equal(s.step, "blocks");
	r = step(s, { kind: "answer", text: "can i add synonyms?" });
	assert.equal(r.effects[0]?.kind, "helpAnswer");
	assert.deepEqual(r.state.answers.blocks, ["river", "depth"]);
	s = step(step(r.state, { kind: "helpAnswered", text: "Edit the lines." }).state, { kind: "answer", chip: "use" }).state;
	assert.equal(s.step, "code");
	// A choice step: typed text that names no chip is a question; "no" names a chip and answers.
	r = step(s, { kind: "answer", text: "what does this cost?" });
	assert.equal(r.effects[0]?.kind, "helpAnswer");
	assert.equal(r.state.step, "code");
	s = step(step(r.state, { kind: "helpAnswered", text: "Up to 40 s." }).state, { kind: "answer", text: "no" }).state;
	assert.equal(s.step, "period");
	// "Edit keyword blocks" from a help answer returns to the blocks.
	r = step(s, { kind: "answer", text: "which years make sense?" });
	assert.equal(r.effects[0]?.kind, "helpAnswer");
	assert.ok(r.effects[0]?.kind === "helpAnswer" && r.effects[0].user.includes("NOTE (say this first, briefly): I did not understand the years."));
	s = step(r.state, { kind: "helpAnswered", text: "Recent years." }).state;
	assert.ok(chipIds(s).includes("goBlocks"));
	assert.equal(step(s, { kind: "answer", chip: "goBlocks" }).state.step, "blocks");
	// A plain miss stays a plain miss.
	r = step(s, { kind: "answer", text: "whenever" });
	assert.equal(r.effects.length, 0);
	assert.equal(r.state.step, "period");
	assert.ok(last(r.state).note?.includes("I did not understand the years"));
}

console.log("dialog tests passed");
