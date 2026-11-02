// The question channel's fixed help: every step covered, prompts and chips from code, question detection.
import assert from "node:assert/strict";

import type { DialogContext, DialogState, StepId } from "./dialog.ts";
import { examplesFor, fallbackText, helpPrompt, helpText, looksLikeQuestion, looksLikeSmallTalk, modeLabel, navigationChips, navigationIntent, stateSummary, STEP_ACCEPTS } from "./help.ts";

const steps = Object.keys(STEP_ACCEPTS) as StepId[];
assert.equal(steps.length, 26);

// Every step has a mode line and a help text with the fixed parts; text steps carry examples, choice and job steps none.
for (const step of steps) {
	assert.ok(modeLabel(step).length > 3, step);
	const text = helpText(step);
	for (const part of ["Open question:", "What it means:", "Accepted input:", "Chips:", "Navigation:"]) assert.ok(text.includes(part), `${step}: ${part}`);
	assert.ok(text.includes("`back`"), step);
	if (STEP_ACCEPTS[step] !== "text") assert.deepEqual(examplesFor(step), [], step);
}
assert.ok(examplesFor("pick").includes("all"));
assert.ok(examplesFor("period").includes("2015-2024"));
assert.equal(STEP_ACCEPTS.code, "choice");
assert.equal(STEP_ACCEPTS.searching, "job");

// Fallback: the parser's note comes first, then the fixed help.
const fallback = fallbackText("pick", "That was not row numbers.");
assert.ok(fallback.startsWith("That was not row numbers."));
assert.ok(fallback.includes("`all`"));

// The prompt carries note, help, state and the question; the state summary names what the dialog knows.
const ctx: DialogContext = { thisYear: 2026, hasModel: true, modelLabel: "stub", noModelHint: "", mailtoSet: false, library: [{ base: "a", title: "A", year: "2020", authors: [] }], sources: [], sourcesSkipped: [], storedTopics: [] };
const state = {
	step: "pick", trail: ["start", "topic", "blocks", "pick"], messages: [], activeJob: null, pending: null, counter: 0,
	answers: { topic: "river depth", blocks: ["river OR stream", "depth"], codeSources: ["hf-papers"], pickIds: ["10.1/x"], questions: [], search: { name: "2026-10-28_run", htmlUrl: "", included: 12, dropped: 3, candidates: [{ id: "10.1/x", title: "t", year: "2020", access: null, group: "on_target", dropped: false, inLibrary: false, code: true }] } },
} as unknown as DialogState;
const summary = stateSummary(state, ctx);
assert.ok(summary.includes("Request: river depth"));
assert.ok(summary.includes("river OR stream AND depth"));
assert.ok(summary.includes("12 papers included, 1 with a code link"));
assert.ok(summary.includes("PDF library: 1 PDFs"));
const prompt = helpPrompt("pick", "can i change the keywords?", state, ctx, "Not row numbers.");
assert.ok(prompt.startsWith("NOTE (say this first, briefly): Not row numbers."));
assert.ok(prompt.includes("HELP:\nOpen question: Answering: which papers to download."));
assert.ok(prompt.endsWith("USER QUESTION: can i change the keywords?"));

// Navigation chips: Continue always; Edit keyword blocks once blocks exist (not on the block steps); Back with a trail.
assert.deepEqual(navigationChips(state).map((chip) => chip.id), ["continue", "goBlocks", "back", "restart"]);
assert.deepEqual(navigationChips({ ...state, step: "blocks" }).map((chip) => chip.id), ["continue", "back", "restart"]);
assert.deepEqual(navigationChips({ ...state, trail: ["start"], answers: { ...state.answers, blocks: [] } }).map((chip) => chip.id), ["continue", "restart"]);

// Question detection: a question mark or an opener, never a word count (keyword blocks are long too).
for (const text of ["can i adopt the keywords?", "hello?", "i want to change keywords", "How do I go back", "please help", "Is unpaywall free"]) assert.ok(looksLikeQuestion(text), text);
for (const text of ["1, 4, 7", "all", "river OR stream, water level OR stage, satellite", "2015-2024", "count 30", "name@example.org", ""]) assert.ok(!looksLikeQuestion(text), text);

// Small talk at the request step: greetings and questions about the tool, never a research question.
for (const text of ["hello", "Hi!", "what can you do?", "Who are you", "help", "thanks", "hallo"]) assert.ok(looksLikeSmallTalk(text), text);
for (const text of ["Which methods estimate river bathymetry from satellite images?", "I want to conduct a literature review on water levels", "sandbar detection Sentinel-2", "how is water level measured from space?"]) assert.ok(!looksLikeSmallTalk(text), text);

console.log("help tests passed");

// Wishes to change earlier answers are navigation, decided in code.
for (const text of ["i want to change the keywords", "Can I edit the keyword blocks?", "go back to the search terms", "the query is wrong, change it", "please adjust block 2", "Ich möchte die Schlagwörter ändern", "Suchbegriffe anpassen", "kann ich die Stichwoerter noch korrigieren?"]) assert.equal(navigationIntent(text), "blocks", text);
for (const text of ["I want to change the request", "can i rephrase the topic? no, change the topic", "Anfrage ändern"]) assert.equal(navigationIntent(text), "topic", text);
for (const text of ["", "yes", "Is unpaywall free?", "river OR stream, water level", "2015-2024", "what does this step mean?", "change detection of river banks", "keyword blocks"]) assert.equal(navigationIntent(text), null, text);
console.log("navigation intent tests ok");

// Small talk in a chat: only short messages without a question mark or a
// request opening get the model check; any unclear output means "look it up".
{
	const { socialCandidate, parseSocialReply } = await import("./help.ts");
	for (const text of ["danke", "find ich gut", "cool, thanks", "schön", "ok", "super, das hilft mir"]) assert.equal(socialCandidate(text), true, text);
	for (const text of ["", "methods?", "wer ist der Autor", "Which sensors", "summarize the results", "erklär die Methode", "Wie genau ist das", "what about Landsat", "danke, und die Genauigkeit", "ok but the data", "mehr Details", "weiter", "ja", "in einfachen Worten", "a sentence with many words that goes on and on and on"]) assert.equal(socialCandidate(text), false, text);
	assert.equal(parseSocialReply("QUESTION"), null);
	assert.equal(parseSocialReply(" question. "), null);
	assert.equal(parseSocialReply("QUESTION\n\nThe paper uses Landsat."), null);
	assert.equal(parseSocialReply(""), null);
	assert.equal(parseSocialReply("<think>hmm</think>"), null);
	assert.equal(parseSocialReply("It uses Otsu thresholding [1]."), null);
	assert.equal(parseSocialReply("See page 4."), null);
	assert.equal(parseSocialReply("x".repeat(300)), null);
	assert.equal(parseSocialReply("<think>social</think>Freut mich! Frag gern weiter."), "Freut mich! Frag gern weiter.");
	assert.equal(parseSocialReply("You're welcome. Ask another question whenever you like."), "You're welcome. Ask another question whenever you like.");
	console.log("help small-talk tests ok");
}

