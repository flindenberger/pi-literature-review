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
	parseSearchOptions,
	parseChatOptions,
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
	authorsOnlyLabel,
	isAuthorsOnly,
} from "./dialog.ts";
import type { JobInfo } from "./jobs.ts";
import type { AnswerView } from "./dialog.ts";

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
	assert.deepEqual(out.effects, [{ kind: "proposeBlocks", query: "Which methods estimate river bathymetry from satellite images?", mode: "own" }]);
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
	// A usable proposal searches at once: the plus1 row is the query, defaults apply.
	assert.equal(out.effects[0]?.kind, "startSearch");
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.deepEqual(out.effects[0].form.blocks, ["satellite OR remote sensing", "bathymetry OR water depth", "river OR fluvial"]);
	assert.equal(out.effects[0].form.perSource, 30);
	assert.equal(out.effects[0].form.period, "10y");
	assert.equal(state.pending, "starting the search");
	// After the search, "Edit blocks" under the pick question reopens the editable blocks.
	state = step(state, { kind: "jobStarted", job: job("search", "search-0") }).state;
	state = step(state, { kind: "job", job: job("search", "search-0", "done"), search: { name: "first", htmlUrl: "/files/lit-search/first.html", included: 0, dropped: 0, candidates: [] } }).state;
	assert.equal(state.step, "pick");
	state = step(state, { kind: "answer", chip: "goBlocks" }).state;
	assert.equal(state.step, "blocks");
	assert.equal(state.pending, null);
	assert.deepEqual(last(state).editor, ["satellite OR remote sensing", "bathymetry OR water depth", "river OR fluvial"]);
	assert.deepEqual(chipIds(state), ["use", "useVariants", "again", "more"]);

	// Confirming searches at once with the edited lines and the defaults.
	const fast = step(state, { kind: "answer", chip: "use", blocks: ["satellite OR remote sensing", "bathymetry", "river"] });
	assert.equal(fast.effects[0]?.kind, "startSearch");
	assert.equal(fast.state.pending, "starting the search");
	assert.ok(fast.effects[0]?.kind === "startSearch");
	assert.deepEqual(fast.effects[0].form.blocks, ["satellite OR remote sensing", "bathymetry", "river"]);
	assert.equal(fast.effects[0].form.perSource, 30);
	assert.equal(fast.effects[0].form.period, "10y");
	assert.deepEqual(fast.effects[0].form.codeSources ?? [], []);

	// "More options" keeps the edited lines and opens the question chain.
	out = step(state, { kind: "answer", chip: "more", blocks: ["satellite OR remote sensing", "bathymetry", "river"] });
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
	assert.equal(state.answers.pickedAuthors[0]?.id, "A9");
	out = step(state, { kind: "answer", chip: "all" });
	state = out.state;
	assert.equal(state.step, "confirm");
	assert.match(last(state).text ?? "", /Angelica Tarpanelli \(all their works\)/);
	assert.match(last(state).text ?? "", /Period: 2015-2024/);
	assert.match(last(state).text ?? "", /topics remote-sensing, bathymetry/);
	assert.match(last(state).note ?? "", /30 records per source/);

	// Tweaks re-render the summary; the form carries everything.
	out = step(state, { kind: "answer", text: "count 40" });
	state = out.state;
	assert.equal(state.answers.perSource, 40);
	assert.match(last(state).note ?? "", /40 records per source/);
	out = step(state, { kind: "answer", text: "cites 5" });
	state = out.state;
	assert.equal(state.answers.minCites, 5);
	const form = formFromAnswers(state.answers, 2026);
	assert.deepEqual(form.blocks, ["satellite OR remote sensing", "bathymetry", "river"]);
	assert.equal(form.period, "custom");
	assert.equal(form.yearFrom, 2015);
	assert.equal(form.yearTo, 2024);
	assert.equal(form.perSource, 40);
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
	// The run stands as a results message (the browser loads its cards); no report file yet.
	const resultsMessage = [...state.messages].reverse().find((message) => message.role === "results");
	assert.equal(resultsMessage?.run, "2026-10-19_run");
	assert.equal(state.messages.some((message) => message.role === "card"), false);
	assert.deepEqual(chipIds(state), ["ticked", "code", "all", "skip", "goBlocks"]); // code sources ran: no "Add papers with code"
	// A report written on click arrives as a file card.
	const withReport = step(state, { kind: "fileWritten", card: { kind: "file", name: "2026-10-19_run.html", label: "Search report, HTML · lit-search/", stage: "lit-search", url: "/files/lit-search/2026-10-19_run.html" } }).state;
	assert.equal(last(withReport).card?.name, "2026-10-19_run.html");
	assert.equal(withReport.step, "pick");
	assert.match(last(state).note ?? "", /Searched: \(satellite OR remote sensing\) AND \(bathymetry\) AND \(river\)/);
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
	// The folder chosen in the download window goes with the effect.
	assert.deepEqual(step(state, { kind: "answer", chip: "download", folder: "/home/me/Papers" }).effects[0], { kind: "startSelection", identifiers: ["10.1000/a", "10.1000/b"], mailto: "me@example.org", saveMailto: true, withoutUnpaywall: false, folder: "/home/me/Papers" });
	out = step(state, { kind: "answer", chip: "download" });
	state = out.state;
	assert.deepEqual(out.effects, [{ kind: "startSelection", identifiers: ["10.1000/a", "10.1000/b"], mailto: "me@example.org", saveMailto: true, withoutUnpaywall: false }]);
	out = step(state, { kind: "jobStarted", job: job("selection", "selection-2") });
	state = out.state;
	assert.equal(state.step, "downloading");
	out = step(state, { kind: "job", job: job("selection", "selection-2", "done"), download: { downloaded: 1, already: 0, browser: [{ id: "10.1000/b", url: "https://doi.org/10.1000/b" }], notFree: 0, failed: 0, libraryCount: 3, folder: "/home/me/Papers" } });
	state = out.state;
	// Stage 1 ends with the list: the download's messages are quiet (the browser's window shows them), the pick stays open.
	assert.equal(state.step, "pick");
	assert.equal(state.answers.scope, "library");
	const folder = state.messages.find((message) => message.card?.kind === "folder");
	assert.equal(folder?.card?.name, "Papers/");
	assert.equal(folder?.card?.path, "/home/me/Papers");
	assert.equal(folder?.quiet, true);
	assert.match(folder?.card?.label ?? "", /1 PDF added, 3 in the library/);
	assert.match(state.messages.find((message) => message.note?.includes("Only in the browser"))?.note ?? "", /10\.1000\/b: https:\/\/doi\.org\/10\.1000\/b/);
	assert.ok(state.messages.filter((message) => message.step === "pick" || message.step === "mailto" || message.step === "download").every((message) => message.quiet));
	assert.ok(state.messages.filter((message) => message.role === "working" && message.jobLabel?.startsWith("selection")).every((message) => message.quiet));
	assert.match(last(state).note ?? "", /3 PDFs in the library/);
	assert.ok(chipIds(state).includes("skip"));
	// The library chat is one chip away.
	state = step(state, { kind: "answer", chip: "skip" }).state;
	assert.equal(state.step, "ask");

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
	assert.equal(state.step, "ask"); // back to the question box, no chips
	assert.equal(state.messages.filter((message) => message.card?.kind === "file").length, 1); // only the synthesis report; search runs are cards in the chat, their reports are written on click
	assert.equal(last(state).card?.kind, "file");

	// Restart asks first, then resets and opens a new chat session.
	out = step(state, { kind: "answer", text: "start over" });
	state = out.state;
	assert.equal(state.step, "confirmRestart");
	out = step(state, { kind: "answer", chip: "no" });
	assert.equal(out.state.step, "ask");
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
	// The user's own structure needs no model and searches at once.
	assert.equal(out.effects[0]?.kind, "startSearch");
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.deepEqual(out.effects[0].form.blocks, ["river OR stream", "bathymetry"]);
	assert.deepEqual(state.answers.blocks, ["river OR stream", "bathymetry"]);
	// After the search, "Edit blocks" under the pick question reopens the lines.
	state = step(state, { kind: "jobStarted", job: job("search", "s-hb") }).state;
	state = step(state, { kind: "job", job: job("search", "s-hb", "done"), search: { name: "hb", htmlUrl: "/files/lit-search/hb.html", included: 0, dropped: 0, candidates: [] } }).state;
	assert.equal(state.step, "pick");
	assert.ok(chipIds(state).includes("goBlocks"));
	state = step(state, { kind: "answer", chip: "goBlocks" }).state;
	assert.equal(state.step, "blocks");
	assert.deepEqual(last(state).editor, ["river OR stream", "bathymetry"]);
	// A typed replacement of the blocks as lines searches again at once.
	out = step(state, { kind: "answer", text: "river\nwater depth OR bathymetry" });
	assert.deepEqual(out.state.answers.blocks, ["river", "water depth OR bathymetry"]);
	assert.equal(out.effects[0]?.kind, "startSearch");
	// "More options" with the lines opens the code question; "back" returns to the blocks with the lines kept.
	out = step(state, { kind: "answer", chip: "more", blocks: ["river", "water depth OR bathymetry"] });
	state = out.state;
	assert.deepEqual(state.answers.blocks, ["river", "water depth OR bathymetry"]);
	assert.equal(state.step, "code");
	out = step(state, { kind: "answer", text: "back" });
	state = out.state;
	assert.equal(state.step, "blocks");
	assert.deepEqual(last(state).editor, ["river", "water depth OR bathymetry"]);
	out = step(state, { kind: "answer", chip: "more" });
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
	// No usable proposal -> word-by-word blocks are shown first; "More options" opens the question chain.
	state = step(state, { kind: "answer", text: "river depth" }).state;
	state = step(state, { kind: "blocks", variants: null }).state;
	state = step(state, { kind: "answer", chip: "more" }).state;
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
	state = step(state, { kind: "answer", text: "river depth" }, ctx).state;
	state = step(state, { kind: "blocks", variants: null }, ctx).state;
	state = step(state, { kind: "answer", chip: "more" }, ctx).state; // the question chain; "use" would search at once
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
	assert.deepEqual(chipIds(out.state), ["search", "editSearch"]);
	// Edit search: the request question alone, with the request to put back in the box.
	{
		const edit = step(out.state, { kind: "answer", chip: "editSearch" }, ctx);
		assert.equal(edit.state.step, "topic");
		assert.equal(edit.state.messages.length, 1);
		assert.equal(edit.state.messages[0].prefill, state.answers.topic);
		assert.ok(state.answers.topic);
	}
	assert.equal(out.state.messages.find((message) => message.role === "working")?.jobState, "failed");
	// Cancel reads as Stopped.
	out = step(state, { kind: "job", job: job("search", "search-1", "cancelled") }, ctx);
	assert.match(last(out.state).text ?? "", /Stopped\./);
	// Success with a configured mailto: pick goes straight to the download question.
	const candidates = [{ id: "10.1000/a", title: "A", year: "2020", access: "free", group: "on_target", dropped: false, inLibrary: false, code: false }];
	out = step(state, { kind: "job", job: job("search", "search-1", "done"), search: { name: "run", htmlUrl: "/files/lit-search/run.html", included: 1, dropped: 0, candidates } }, ctx);
	state = out.state;
	assert.deepEqual(chipIds(state), ["ticked", "all", "addCode", "goBlocks"]); // no code rows, no library -> no skip chip; code sources off -> add-on offered
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
	s = step(step(r.state, { kind: "helpAnswered", text: "Edit the lines." }).state, { kind: "answer", chip: "more" }).state;
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

// "+ New search" / "+ New paper chat": the conversation opens at the stage's
// first question, alone (no start screen, no echoed stage name).
{
	const search = initialDialog(context(), "search");
	assert.equal(search.step, "topic");
	assert.equal(search.messages.length, 1);
	assert.equal(search.messages[0].role, "assistant");
	const restarted = step(search, { kind: "restart", start: "search" }).state;
	assert.equal(restarted.step, "topic");
	assert.equal(restarted.messages.length, 1);
	const chat = initialDialog(context(), "synthesis");
	assert.equal(chat.step, "ask");
	assert.equal(chat.messages.length, 1);
	assert.equal(chat.answers.scope, "library");
	const empty = initialDialog(context({ library: [] }), "synthesis");
	assert.equal(empty.step, "start");
	assert.equal(empty.messages.length, 1);
	assert.deepEqual(chipIds(empty), ["goSearch"]);
	const viaChip = step(empty, { kind: "answer", chip: "goSearch" }, context({ library: [] })).state;
	assert.equal(viaChip.step, "topic");
	const plain = initialDialog(context());
	assert.equal(plain.step, "start");
	assert.ok(chipIds(plain).includes("search"));
}
console.log("dialog start-stage tests ok");

// Typed wishes to change the keywords reopen the blocks question, kept
// away from the helper model (the model once answered "you cannot").
{
	let state = initialDialog(context(), "search");
	state = step(state, { kind: "answer", text: "waterline detection in rivers using satellite imagery" }).state;
	state = step(state, { kind: "blocks", variants: [{ role: "plus1", text: "(waterline detection OR water edge detection) AND (rivers OR fluvial systems) AND (satellite imagery OR satellite remote sensing)" }] }).state;
	// The proposal searched at once; after the run, "Edit blocks" reopens the blocks, "More options" the chain.
	assert.equal(state.pending, "starting the search");
	state = step(state, { kind: "jobStarted", job: job("search", "s-nav") }).state;
	state = step(state, { kind: "job", job: job("search", "s-nav", "done"), search: { name: "nav", htmlUrl: "/files/lit-search/nav.html", included: 0, dropped: 0, candidates: [] } }).state;
	state = step(state, { kind: "answer", chip: "goBlocks" }).state;
	assert.equal(state.step, "blocks");
	state = step(state, { kind: "answer", chip: "more" }).state;
	assert.equal(state.step, "code");
	const out = step(state, { kind: "answer", text: "i want to change the keywords" });
	assert.equal(out.state.step, "blocks");
	assert.deepEqual(out.effects, []);
	assert.equal(out.state.pending, null);
	assert.deepEqual(last(out.state).editor, ["waterline detection OR water edge detection", "rivers OR fluvial systems", "satellite imagery OR satellite remote sensing"]);
	// German works the same; a real question on the code step still goes to the helper.
	const de = step(state, { kind: "answer", text: "Ich will die Schlagwörter ändern" });
	assert.equal(de.state.step, "blocks");
	const help = step(state, { kind: "answer", text: "Is unpaywall free?" });
	assert.equal(help.state.pending, "looking up the help");
	assert.equal(help.effects[0]?.kind, "helpAnswer");
	// On the blocks question itself, typed lines stay block edits.
	const lines = step(out.state, { kind: "answer", text: "waterline OR shoreline\nrivers\nsatellite" });
	assert.notEqual(lines.state.step, "topic");
}
console.log("dialog keyword-navigation tests ok");

// From the result list: "Add papers with code" and "Search again with these filters".
{
	const ctx = context({ storedTopics: ["hydrology"] });
	let state = initialDialog(ctx, "search");
	state = step(state, { kind: "answer", text: "(waterline) AND (river)" }, ctx).state;
	state = step(state, { kind: "jobStarted", job: job("search", "s-a") }, ctx).state;
	state = step(state, { kind: "job", job: job("search", "s-a", "done"), search: { name: "a", htmlUrl: "/files/lit-search/a.html", included: 2, dropped: 0, candidates: [] } }, ctx).state;
	assert.equal(state.step, "pick");
	assert.ok(chipIds(state).includes("addCode"));
	// Add papers with code: topics are suggested, the best three taken without a question, the search starts.
	let out = step(state, { kind: "answer", chip: "addCode" }, ctx);
	assert.equal(out.state.pending, "suggesting list topics");
	assert.deepEqual(out.effects, [{ kind: "loadTopics", query: "(waterline) AND (river)" }]);
	assert.equal(out.state.answers.codeSources.length, 4);
	out = step(out.state, { kind: "topics", topics: [{ topic: "remote-sensing", lists: 8 }, { topic: "rivers", lists: 1 }, { topic: "hydrology", lists: 5 }, { topic: "none", lists: 0 }, { topic: "gis", lists: 3 }] }, ctx);
	assert.equal(out.effects[0]?.kind, "startSearch");
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.deepEqual(out.effects[0].form.codeTopics, ["remote-sensing", "hydrology", "gis"]);
	assert.equal(out.effects[0].form.codeSources?.length, 4);
	assert.equal(out.state.answers.autoTopics, false);
	// No topics at all: the awesome lists are left out, the search still starts.
	let none = step(state, { kind: "answer", chip: "addCode" }, ctx).state;
	out = step(none, { kind: "topics", topics: [] }, ctx);
	assert.equal(out.effects[0]?.kind, "startSearch");
	assert.ok(!out.state.answers.codeSources.includes("awesome-lists"));
	// Topic lookup failed: stored topics, the search still starts.
	none = step(state, { kind: "answer", chip: "addCode" }, ctx).state;
	out = step(none, { kind: "effectFailed", effect: "loadTopics", error: "HTTP 500" }, ctx);
	assert.equal(out.effects[0]?.kind, "startSearch");
	assert.deepEqual(out.state.answers.topicsOn, ["hydrology"]);
	// Without a model: no suggestion round, stored topics, straight to the search.
	const noModel = context({ hasModel: false, storedTopics: ["hydrology"] });
	out = step(state, { kind: "answer", chip: "addCode" }, noModel);
	assert.equal(out.effects[0]?.kind, "startSearch");
	// Search again with the list filters that change the query: period and citation floor.
	out = step(state, { kind: "answer", chip: "searchAgain", filters: { yearFrom: 2007, minCites: 10 } }, ctx);
	assert.equal(out.effects[0]?.kind, "startSearch");
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.equal(out.effects[0].form.yearFrom, 2007);
	assert.equal(out.effects[0].form.minCites, 10);
	out = step(state, { kind: "answer", chip: "searchAgain", filters: { allYears: true, minCites: 0 } }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.equal(out.effects[0].form.period, "all");
	assert.equal(out.effects[0].form.minCites ?? null, null);
}

// The code icon next to the request box: the first search takes the code sources.
{
	const ctx = context({ storedTopics: ["hydrology"] });
	let out = step(initialDialog(ctx, "search"), { kind: "answer", text: "(waterline) AND (river)", code: true }, ctx);
	assert.equal(out.state.pending, "suggesting list topics");
	assert.equal(out.state.answers.codeSources.length, 4);
	assert.equal(out.state.answers.codeAtStart, false);
	out = step(out.state, { kind: "topics", topics: [{ topic: "rivers", lists: 2 }] }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.equal(out.effects[0].form.codeSources?.length, 4);
	assert.deepEqual(out.effects[0].form.codeTopics, ["rivers"]);
	// Without the icon the search starts at once, code sources off.
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: "(waterline) AND (river)" }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.equal(out.effects[0].form.codeSources?.length ?? 0, 0);
	// A report from the result list is a quiet card (a window over the list, not a chat message).
	const quiet = step(out.state, { kind: "fileWritten", card: { kind: "file", name: "a.html", label: "Search report, HTML", stage: "lit-search", url: "/files/lit-search/a.html" }, quiet: true }, ctx).state;
	assert.equal(quiet.messages[quiet.messages.length - 1]?.quiet, true);
}
{
	// A stopped follow-up search returns to the existing list.
	const ctx = context();
	let state = initialDialog(ctx, "search");
	state = step(state, { kind: "answer", text: "(waterline) AND (river)" }, ctx).state;
	state = step(state, { kind: "jobStarted", job: job("search", "s-1") }, ctx).state;
	state = step(state, { kind: "job", job: job("search", "s-1", "done"), search: { name: "a", htmlUrl: "/files/lit-search/a.html", included: 2, dropped: 0, candidates: [] } }, ctx).state;
	state = step(state, { kind: "answer", chip: "searchAgain", filters: { allYears: true, minCites: 0 } }, ctx).state;
	state = step(state, { kind: "jobStarted", job: job("search", "s-2") }, ctx).state;
	state = step(state, { kind: "job", job: job("search", "s-2", "cancelled") }, ctx).state;
	assert.equal(state.step, "pick");
	assert.equal(state.answers.search?.name, "a");
}
console.log("dialog code-at-start tests ok");

// The synonym and period buttons next to the request box.
{
	const ctx = context();
	const request = "flood mapping in rivers with Sentinel-1";
	// Default: own-words blocks, the search starts once they arrive.
	let out = step(initialDialog(ctx, "search"), { kind: "answer", text: request, period: "5y" }, ctx);
	assert.deepEqual(out.effects, [{ kind: "proposeBlocks", query: request, mode: "own" }]);
	assert.equal(out.state.answers.period.preset, "5y");
	out = step(out.state, { kind: "blocks", variants: [{ role: "plus1", text: "(flood mapping) AND (rivers) AND (Sentinel-1)" }] }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.equal(out.effects[0].form.period, "5y");
	assert.deepEqual(out.effects[0].form.blocks, ["flood mapping", "rivers", "Sentinel-1"]);
	// An unknown period value is ignored (10 years stays).
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: request, period: "7y" as never }, ctx);
	assert.equal(out.state.answers.period.preset, "10y");
	// Synonym button: the model's synonyms are shown for editing first.
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: request, synonyms: true }, ctx);
	assert.deepEqual(out.effects, [{ kind: "proposeBlocks", query: request, mode: "synonyms" }]);
	out = step(out.state, { kind: "blocks", variants: [{ role: "plus1", text: "(flood mapping OR inundation mapping) AND (river OR fluvial) AND (Sentinel-1 OR SAR)" }] }, ctx);
	assert.equal(out.effects.length, 0);
	assert.equal(out.state.step, "blocks");
	assert.equal(out.state.pending, null);
	assert.match(out.state.messages[out.state.messages.length - 1].text ?? "", /added synonyms/);
	assert.deepEqual(out.state.messages[out.state.messages.length - 1].editor, ["flood mapping OR inundation mapping", "river OR fluvial", "Sentinel-1 OR SAR"]);
	const blocksState = out.state;
	// "Propose again" asks the model afresh (the saved proposal is skipped).
	out = step(blocksState, { kind: "answer", chip: "again" }, ctx);
	assert.deepEqual(out.effects, [{ kind: "proposeBlocks", query: request, mode: "synonyms", fresh: true }]);
	// A changed request in the box: new blocks for the new text.
	out = step(blocksState, { kind: "answer", chip: "retopic", text: "glacier velocity" }, ctx);
	assert.deepEqual(out.effects, [{ kind: "proposeBlocks", query: "glacier velocity", mode: "synonyms" }]);
	// Search with the edited blocks and a period changed while the blocks were open.
	out = step(blocksState, { kind: "answer", chip: "use", blocks: ["flood mapping OR inundation", "river"], period: "all" }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.deepEqual(out.effects[0].form.blocks, ["flood mapping OR inundation", "river"]);
	assert.equal(out.effects[0].form.period, "all");
	// A hand-built expression with the synonym button still asks the model.
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: "(waterline) AND (river)", synonyms: true }, ctx);
	assert.equal(out.effects[0]?.kind, "proposeBlocks");
}
console.log("dialog synonym-button tests ok");

// The "+" menu: count, citations, journals, authors reach the search form;
// untrusted values are cleaned (clamped numbers, ticks limited to listed rows).
{
	const ctx = context();
	const options = parseSearchOptions({
		perSource: 500, minCites: 10,
		journals: { rows: [{ id: "S1", name: "Remote Sensing", works: 48, score: 5.4 }, { id: "S2", name: "Geomorphology", works: 19 }, { bad: true }], on: ["S1", "S9"] },
		authors: { rows: [{ id: "A1", name: "Ann Example", works: 9 }], on: [] },
		authorScope: "all", extra: "ignored",
	});
	assert.deepEqual(options, {
		perSource: 50, minCites: 10,
		journals: { rows: [{ id: "S1", name: "Remote Sensing", works: 48, score: 5.4 }, { id: "S2", name: "Geomorphology", works: 19, score: null }], on: ["S1"] },
		authorScope: "all",
	});
	assert.equal(parseSearchOptions("nonsense"), undefined);
	assert.equal(parseSearchOptions({ minCites: 0 })?.minCites, null);
	let out = step(initialDialog(ctx, "search"), { kind: "answer", text: "(sandbar) AND (river)", options }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.equal(out.effects[0].form.perSource, 50);
	assert.equal(out.effects[0].form.minCites, 10);
	assert.deepEqual(out.effects[0].form.journals, ["Remote Sensing"]);
	assert.deepEqual(out.effects[0].form.journalsListed, ["Remote Sensing", "Geomorphology"]);
	// A picked author (name lookup) with its scope.
	const picked = parseSearchOptions({ pickedAuthor: { id: "A5", name: "Carl Example", hint: "Somewhere", works: 3 }, authorScope: "query" });
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: "(sandbar) AND (river)", options: picked }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.deepEqual(out.effects[0].form.pickedAuthors, [{ id: "A5", name: "Carl Example" }]);
	assert.equal(out.effects[0].form.authorScope, "query");
	// Several authors (name lookup + list ticks) share one scope; bad ids and duplicates go.
	const several = parseSearchOptions({ pickedAuthors: [{ id: "A5", name: "Carl Example" }, { id: "A7", name: "Ana Listed" }, { id: "A5", name: "Carl Example" }, { id: "x", name: "Bad" }], authorScope: "all" });
	assert.deepEqual(several?.pickedAuthors?.map((author) => author.id), ["A5", "A7"]);
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: "(sandbar) AND (river)", options: several }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.deepEqual(out.effects[0].form.pickedAuthors, [{ id: "A5", name: "Carl Example" }, { id: "A7", name: "Ana Listed" }]);
	assert.equal(out.effects[0].form.authorScope, "all");
	// An empty request with picked authors searches all their work at once
	// (no blocks, no model), whatever scope the menu showed.
	const alone = parseSearchOptions({ pickedAuthors: [{ id: "A5", name: "Carl Example" }, { id: "A7", name: "Ana Listed" }], authorScope: "query" });
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: "", options: alone, code: true }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.deepEqual(out.effects[0].form.blocks, []);
	assert.deepEqual(out.effects[0].form.codeSources, []);
	assert.equal(out.effects[0].form.authorScope, "all");
	assert.equal(out.effects[0].form.period, "all");
	assert.equal(out.effects[0].form.perSource, 200);
	assert.equal(out.effects[0].form.authorPosition, undefined);
	assert.ok(isAuthorsOnly(out.state.answers));
	assert.equal(out.state.messages.filter((message) => message.role === "user").pop()?.text, "Works by Carl Example and Ana Listed");
	assert.equal(authorsOnlyLabel([{ name: "A" }, { name: "B" }, { name: "C" }]), "Works by A, B and C");
	// "first author" travels as the author position.
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: "", options: parseSearchOptions({ pickedAuthors: [{ id: "A5", name: "Carl Example" }], firstAuthor: true }) }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.equal(out.effects[0].form.authorPosition, "first");
	assert.equal(out.state.messages.filter((message) => message.role === "user").pop()?.text, "Works by Carl Example as first author");
	// Without authors an empty request still just asks again.
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: "" }, ctx);
	assert.equal(out.effects.length, 0);
	// Under the synonym drop-down, settings changed in the menu arrive with "use".
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: "flood mapping", synonyms: true }, ctx);
	out = step(out.state, { kind: "blocks", variants: [{ role: "plus1", text: "(flood mapping OR inundation) AND (river)" }] }, ctx);
	out = step(out.state, { kind: "answer", chip: "use", blocks: ["flood mapping", "river"], options: { minCites: 5 }, code: false }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.equal(out.effects[0].form.minCites, 5);
}
// Synonym blocks checked and edited in the "+" menu: the search starts at once with them.
{
	const ctx = context();
	let out = step(initialDialog(ctx, "search"), { kind: "answer", text: "flood mapping in rivers", synonyms: true, blocks: ["flood mapping OR inundation", " ", "river OR stream", "SAR"] }, ctx);
	assert.ok(out.effects[0]?.kind === "startSearch");
	assert.deepEqual(out.effects[0].form.blocks, ["flood mapping OR inundation", "river OR stream", "SAR"]);
	// Blocks without the synonym switch are ignored (the own-words path runs).
	out = step(initialDialog(ctx, "search"), { kind: "answer", text: "flood mapping in rivers", blocks: ["x"] }, ctx);
	assert.deepEqual(out.effects, [{ kind: "proposeBlocks", query: "flood mapping in rivers", mode: "own" }]);
}
console.log("dialog plus-menu tests ok");
console.log("dialog add-on tests ok");

// A chat opened on one PDF of the library: the question names the paper.
{
	const ctx = context();
	const state = initialDialog(ctx, "synthesis", ["2017_Gorelick"], "“Google Earth Engine” (Gorelick et al., 2017)");
	assert.equal(state.step, "ask");
	assert.deepEqual(state.answers.scope, ["2017_Gorelick"]);
	assert.equal(state.messages[0].text, "What would you like to know about “Google Earth Engine” (Gorelick et al., 2017)?");
	assert.equal(state.messages[0].note, undefined);
	assert.equal(initialDialog(ctx, "synthesis", ["2017_Gorelick"], "x", "Gorelick et al. 2017 · Google Earth Engine").answers.paperLabel, "Gorelick et al. 2017 · Google Earth Engine");
	// "cool, thanks" in the chat: a chat job like any question (the server
	// asks the model whether it is small talk); a social reply is said in the
	// chat and is no question for a later report.
	let thanks = step(state, { kind: "answer", text: "cool, thanks" }, ctx);
	assert.equal(thanks.effects[0]?.kind, "startChat");
	thanks = step(thanks.state, { kind: "jobStarted", job: job("chat", "chat-9") }, ctx);
	thanks = step(thanks.state, { kind: "job", job: job("chat", "chat-9", "done"), reply: "Gern! Frag ruhig weiter." }, ctx);
	assert.equal(last(thanks.state).text, "Gern! Frag ruhig weiter.");
	assert.equal(thanks.state.step, "ask");
	assert.equal(thanks.state.pending, null);
	assert.deepEqual(thanks.state.answers.questions, []);
	assert.equal(step(state, { kind: "answer", text: "ok thanks, who is the author?" }, ctx).effects[0]?.kind, "startChat");
	// A failed answer in a one-PDF chat: the reason, no scope/report chips.
	let failed = step(state, { kind: "answer", text: "what data?" }, ctx);
	failed = step(failed.state, { kind: "jobStarted", job: job("chat", "chat-10") }, ctx);
	failed = step(failed.state, { kind: "job", job: job("chat", "chat-10", "failed", "no answer text") }, ctx);
	assert.equal(failed.state.step, "ask");
	assert.match(last(failed.state).text ?? "", /^Failed: no answer text/);
	assert.equal(last(failed.state).chips, undefined);
	console.log("dialog paper-chat tests ok");
}


// ---- paper chat "+" menu: scope and report from the request box ----
{
	const ctx = context();
	const state = initialDialog(ctx, "synthesis");
	assert.equal(state.step, "ask");
	// The question stands alone: no scope note, no chips.
	assert.equal(last(state).note, undefined);
	assert.equal(last(state).chips, undefined);

	// parseChatOptions shapes untrusted JSON.
	assert.equal(parseChatOptions(null), undefined);
	assert.equal(parseChatOptions({ scope: 3 }), undefined);
	assert.deepEqual(parseChatOptions({ scope: "library", report: "crossPaper" }), { scope: "library" });
	assert.deepEqual(parseChatOptions({ scope: ["a", "a", "", 4, "b"], scopeLabel: " 01_Waterline " }), { scope: ["a", "b"], scopeLabel: "01_Waterline" });
	assert.deepEqual(parseChatOptions({ scope: "library", build: { summary: true, synthesis: "yes" } }), { scope: "library", build: { summary: true, synthesis: false } });

	// A folder scope: the question runs over exactly its papers; unknown
	// basenames are dropped.
	let out = step(state, { kind: "answer", text: "Which sensors?", chat: { scope: ["2016_Legleiter", "9999_Unknown"], scopeLabel: "Rivers" } }, ctx);
	assert.deepEqual(out.effects, [{ kind: "startChat", question: "Which sensors?", papers: ["2016_Legleiter"] }]);
	assert.equal(out.state.answers.scopeLabel, "Rivers");
	// Nothing known left: the whole library.
	out = step(state, { kind: "answer", text: "Which sensors?", chat: { scope: ["9999_Unknown"] } }, ctx);
	assert.deepEqual(out.effects, [{ kind: "startChat", question: "Which sensors?", papers: "library" }]);

	// The chat's ONE report: nothing asked and nothing ticked -> a note, no job.
	out = step(state, { kind: "answer", text: "", chat: { scope: "library", build: { summary: false, synthesis: false } } }, ctx);
	assert.deepEqual(out.effects, []);
	assert.ok(out.state.messages.some((message) => /Nothing to write yet/.test(message.text ?? "")));
	// Summary alone needs no question.
	out = step(state, { kind: "answer", text: "", chat: { scope: ["2022_Salavitabar"], build: { summary: true, synthesis: false } } }, ctx);
	assert.deepEqual(out.effects, [{ kind: "startReport", papers: ["2022_Salavitabar"], questions: [], summary: "bullets", detailMode: "per-paper", includeReview: false, language: "en", answered: [], letters: {} }]);
	assert.equal(out.state.answers.reported, undefined); // History keeps the chat's title

	// A chat with one answered question: the report carries the question
	// across the papers and hands the chat's answer over for reuse.
	let rs = step(state, { kind: "answer", text: "Which sensors?", chat: { scope: "library" } }, ctx).state;
	rs = step(rs, { kind: "jobStarted", job: job("chat", "chat-1") }, ctx).state;
	const chatAnswer = { question: "Which sensors?", grounded: true, scope: "library", prose: "Sentinel-2 [1].", references: [], sites: [], chunks: [] } as unknown as AnswerView["answer"];
	rs = step(rs, { kind: "job", job: job("chat", "chat-1", "done"), answer: { answer: chatAnswer, hrefs: [], pdfUrls: {} } }, ctx).state;
	out = step(rs, { kind: "answer", text: "", chat: { scope: "library", build: { summary: false, synthesis: true } } }, ctx);
	assert.equal(out.effects.length, 1);
	const effect = out.effects[0] as Extract<Effect, { kind: "startReport" }>;
	assert.deepEqual(effect.questions, ["Which sensors?"]);
	assert.equal(effect.detailMode, "cross-paper");
	assert.equal(effect.includeReview, true);
	assert.equal(effect.summary, "none");
	assert.deepEqual(effect.answered?.map((answer) => answer.question), ["Which sensors?"]);
	assert.deepEqual(out.state.answers.reportRequest, { summary: false, synthesis: true });
	// Sources changed since the answer: it is not reused (asked anew).
	const other = step(rs, { kind: "answer", text: "", chat: { scope: ["2016_Legleiter"], build: { summary: false, synthesis: false } } }, ctx);
	assert.deepEqual((other.effects[0] as typeof effect).answered, []);
	// A question sent with a selected report: the answer first, then the
	// report starts on its own and holds the new question.
	let qa = step(rs, { kind: "answer", text: "Which methods?", chat: { scope: "library", build: { summary: true, synthesis: false } } }, ctx);
	assert.deepEqual(qa.effects, [{ kind: "startChat", question: "Which methods?", papers: "library" }]);
	qa = step(qa.state, { kind: "jobStarted", job: job("chat", "chat-2") }, ctx);
	qa = step(qa.state, { kind: "job", job: job("chat", "chat-2", "done"), answer: { answer: { ...chatAnswer, question: "Which methods?" }, hrefs: [], pdfUrls: {} } }, ctx);
	assert.equal(qa.effects.length, 1);
	const after = qa.effects[0] as Extract<Effect, { kind: "startReport" }>;
	assert.equal(after.kind, "startReport");
	assert.deepEqual(after.questions, ["Which sensors?", "Which methods?"]);
	assert.equal(after.summary, "bullets");
	assert.equal(qa.state.answers.reportAfter, undefined);
	assert.ok(qa.state.messages.some((message) => message.role === "answer" && message.answer?.answer.question === "Which methods?"));
	// Done: the one report is remembered with its parts; no card, no message.
	rs = step(out.state, { kind: "jobStarted", job: job("report", "report-9") }, ctx).state;
	const before = rs.messages.length;
	rs = step(rs, { kind: "job", job: job("report", "report-9", "done"), report: { name: "r", htmlUrl: "/files/lit-synthesis/r.html", grounded: true, units: 2 } }, ctx).state;
	assert.equal(rs.step, "ask");
	assert.deepEqual(rs.answers.report, { url: "/files/lit-synthesis/r.html", parts: { summary: false, synthesis: true }, questions: 1, job: "report-9", at: "2026-10-19T10:00:00Z" });
	assert.equal(rs.answers.reportRequest, undefined);
	assert.equal(rs.messages.length, before, "no card, no message");

	console.log("dialog chat-menu tests ok");
}
