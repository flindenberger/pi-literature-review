/**
 * Offline tests for the pure dialog state machine. The adapters
 * only translate keys and colors; everything decidable is decided -- and
 * pinned -- here.
 */

import assert from "node:assert/strict";
import {
	animateEllipsis,
	type CheckboxState,
	checkboxTypingRow,
	detectDialogLang,
	DIALOG_TEXT,
	initWizard,
	maxWizardRows,
	parseQuestionLines,
	pasteText,
	reduceWizard,
	type WizardState,
	type WizardStepDef,
	wizardAnswers,
	wizardResult,
	wizardView,
	wrapLine,
} from "./dialog-state.ts";

/** "Tab: value" lines of the review page, read off wizardView at the submit tab. */
function summaryLines(state: WizardState): string[] {
	const rows = wizardView({ ...state, tab: state.steps.length }).rows;
	const lines: string[] = [];
	for (let i = 0; i + 1 < rows.length; i++) {
		const tab = rows[i].text.match(/^ {2}● (.*)$/);
		const value = rows[i + 1].text.match(/^ {4}→ (.*)$/);
		if (tab && value) lines.push(`${tab[1]}: ${value[1]}`);
	}
	return lines;
}

const items = [
	{ id: "a", label: "2021_Kryniecka_Vistula.pdf" },
	{ id: "b", label: "2024_Wagner_Amazon.pdf" },
	{ id: "c", label: "2026_Blanch_Water_Level.pdf" },
];

/* ---------------- wrapLine ---------------- */
{
	// Short lines pass through; long lines wrap at word boundaries with a
	// hanging indent (leading whitespace + 4).
	assert.deepEqual(wrapLine("short", 40), ["short"]);
	assert.deepEqual(wrapLine("", 40), [""]);
	const wrapped = wrapLine(" 2. [ ] (satellite OR Landsat) AND (water body OR surface water)", 40);
	assert.ok(wrapped.length > 1);
	assert.ok(wrapped.every((line) => line.length <= 40), "every line fits the width");
	assert.ok(wrapped.slice(1).every((line) => line.startsWith("     ")), "hanging indent = lead + 4");
	// No content lost, no words torn at the seams (a mid-token cut would
	// re-join with a stray space and fail the comparison).
	assert.equal(wrapped.map((line) => line.trim()).join(" "), "2. [ ] (satellite OR Landsat) AND (water body OR surface water)");
	// A token longer than the room is cut hard instead of looping.
	const monster = wrapLine(`x ${"y".repeat(100)}`, 20);
	assert.ok(monster.length > 1);
	assert.ok(monster.every((line) => line.length <= 20));
	// Very narrow widths fall back to the hard clip.
	assert.deepEqual(wrapLine("abcdefghijkl", 8), ["abcdefg…"]);
	assert.deepEqual(wrapLine("abc", 8), ["abc"]);
}

/* ---------------- parseQuestionLines ---------------- */
{
	assert.deepEqual(
		parseQuestionLines("Welche Kamera?\n\n- Wo installiert?\n* Seit wann?\n2. Warum?\n   \n10) Wie teuer?"),
		["Welche Kamera?", "Wo installiert?", "Seit wann?", "Warum?", "Wie teuer?"],
	);
	assert.deepEqual(parseQuestionLines("   \n\n"), []);
	// A lone bullet line carries no question.
	assert.deepEqual(parseQuestionLines("- "), []);
	// v27: SEMICOLON separates too (the terminal-input separator); mixing
	// with newlines stays legal for the CLI habit.
	assert.deepEqual(
		parseQuestionLines("Welche Kamera?; Wo installiert? ;\nSeit wann?"),
		["Welche Kamera?", "Wo installiert?", "Seit wann?"],
	);
	assert.deepEqual(parseQuestionLines(" ; ;; "), []);
}

/* ---------------- wizard: one dialog over several steps ---------------- */

const wizardSteps: WizardStepDef[] = [
	{
		kind: "checkbox", id: "papers", tab: "Dokumente", title: "Über welche Dokumente möchtest du sprechen?",
		items, selectAllLabel: "Alle auswählen", nextLabel: "Weiter", preselected: ["c"],
	},
	{
		kind: "choice", id: "summary", tab: "Zusammenfassung", title: "Zusammenfassen?",
		options: [{ value: "none", label: "Nein" }, { value: "bullets", label: "Bulletpoints" }, { value: "prose", label: "Fließtext" }],
		initial: "bullets",
	},
	{
		kind: "choice", id: "save", tab: "HTML", title: "Als HTML speichern?",
		options: [{ value: "yes", label: "Ja" }, { value: "no", label: "Nein" }],
	},
];

function drive(
	state: WizardState,
	events: Array<string | { kind: "input"; chars: string }>,
): { state: WizardState; done?: string } {
	let done: string | undefined;
	for (const event of events) {
		const step = reduceWizard(state, event as never);
		state = step.state;
		done = step.done;
	}
	return { state, done };
}

{
	const state = initWizard(wizardSteps);
	assert.equal(state.tab, 0);
	assert.equal(state.cursors[1], 1); // choice cursor starts on the initial option
	assert.deepEqual([...state.selected[0]], ["c"]); // sticky preselection
	// Stable footprint: the submit page (3 steps x 2 review lines + warning
	// slot + blank + 2 action rows) is the tallest tab.
	assert.equal(maxWizardRows(state), 10);
}

{
	// Enter on a checkbox ROW toggles (it must NOT
	// commit); only the next-row commits and advances. (lang "de": this
	// block pins the German wording; the default is English since v30.)
	let { state } = drive(initWizard(wizardSteps, { lang: "de" }), ["down", "confirm"]);
	assert.deepEqual([...state.selected[0]].sort(), ["a", "c"]);
	assert.equal(state.tab, 0); // still on the checkbox step
	// Down to the next-row (select-all, 3 items, next = row 4) and commit.
	({ state } = drive(state, ["down", "down", "down", "confirm"]));
	assert.equal(state.tab, 1);
	// Choice: Enter picks the focused option and auto-advances.
	const picked = drive(state, ["down", "confirm"]); // cursor 1 -> 2 = "prose"
	assert.equal(picked.state.tab, 2);
	assert.equal(picked.state.chosen[1], "prose");
	// Last step answers -> the SUBMIT page, never straight to done.
	const reviewed = drive(picked.state, ["confirm"]);
	assert.equal(reviewed.done, undefined);
	assert.equal(reviewed.state.tab, 3);
	// Enter on Absenden finishes; the review shows every answer as a
	// "● Tab" + "→ value" pair, no warning line.
	const view = wizardView(reviewed.state);
	assert.ok(view.rows.some((row) => row.text.includes("● Zusammenfassung") && row.dim));
	assert.ok(view.rows.some((row) => row.text.includes("→ Fließtext")));
	assert.ok(view.rows.some((row) => row.text.includes("→ Ja")));
	assert.ok(!view.rows.some((row) => row.warn));
	assert.ok(view.rows.at(-2)?.active && view.rows.at(-2)?.text.includes("1. Absenden"));
	const finished = drive(reviewed.state, ["confirm"]);
	assert.equal(finished.done, "confirmed");
	assert.deepEqual(wizardResult(finished.state), {
		papers: ["a", "c"],
		summary: "prose",
		save: "yes",
	});
	// Abbrechen on the submit page cancels.
	assert.equal(drive(reviewed.state, ["down", "confirm"]).done, "cancelled");
}

{
	// Back navigation keeps answers; tabs wrap in both directions.
	let { state } = drive(initWizard(wizardSteps), ["confirm"]); // commit? no: cursor 0 = select-all -> toggles all
	assert.deepEqual([...state.selected[0]].sort(), ["a", "b", "c"]);
	({ state } = drive(state, ["left"]));
	assert.equal(state.tab, 3); // wraps backwards onto the submit tab
	({ state } = drive(state, ["right", "right", "right"]));
	assert.equal(state.tab, 2);
	({ state } = drive(state, ["left", "left"]));
	assert.equal(state.tab, 0);
	assert.deepEqual([...state.selected[0]].sort(), ["a", "b", "c"]); // answers survived the round trip
}

{
	// Finish guard: submitting cannot succeed while a required step is
	// incomplete -- the wizard jumps there instead of finishing. The summary
	// step's initial is only a RECOMMENDATION, so it counts as open here.
	let { state, done } = drive(initWizard(wizardSteps), ["right", "right", "up", "confirm", "confirm"]);
	// (save answered "Nein" -> submit page -> Absenden -> jump to summary)
	assert.equal(done, undefined);
	assert.equal(state.tab, 1);
	// Answering it (Enter on the recommended option) unblocks the submit.
	({ state, done } = drive(state, ["confirm", "right", "confirm"]));
	assert.equal(done, "confirmed");
	assert.equal(wizardResult(state).summary, "bullets");
	assert.equal(wizardResult(state).save, "no");
	// Now WITHOUT preselection: the empty checkbox blocks the submit.
	const bare = wizardSteps.map((step) => (step.kind === "checkbox" ? { ...step, preselected: [] } : step));
	({ state, done } = drive(initWizard(bare, { lang: "de" }), ["right", "right", "right", "confirm"]));
	assert.equal(done, undefined);
	assert.equal(state.tab, 0); // jumped from the submit page to the incomplete step
	const review = wizardView({ ...state, tab: 3 });
	assert.ok(review.rows.some((row) => row.text.includes("(offen)"))); // the review is honest about it
	// ...and warns UP FRONT which steps are still open .
	assert.ok(review.rows.some((row) => row.warn && row.text.includes("⚠") && row.text.includes("Dokumente")));
	// Esc cancels from anywhere.
	assert.equal(reduceWizard(initWizard(wizardSteps), "cancel").done, "cancelled");
	// Enter on the next-row with an EMPTY selection commits nothing.
	const stuck = drive(initWizard(bare, { lang: "de" }), ["up", "confirm"]); // cursor wraps to the next-row
	assert.equal(stuck.done, undefined);
	assert.equal(stuck.state.tab, 0);
}

{
	// View: tab bar, active row marker, chosen mark, per-kind hint.
	let { state } = drive(initWizard(wizardSteps, { lang: "de" }), ["down"]);
	let view = wizardView(state);
	// Answered tabs carry a FILLED square, open ones an empty square, the
	// review tab a check : papers is preselected (a REAL
	// prior answer -- the sticky scope); the summary's initial is only a
	// cursor recommendation and stays open, like the save step.
	assert.deepEqual(view.tabs.map((tab) => [tab.label, tab.active]), [
		["■ Dokumente", true], ["□ Zusammenfassung", false], ["□ HTML", false], ["✓ Bestätigen", false],
	]);
	assert.equal(view.rows.length, 5);
	assert.ok(view.rows[1].active && view.rows[1].text.startsWith("❯ 1. "));
	assert.ok(view.rows[4].text.includes("Weiter"));
	assert.ok(view.hint.includes("Weiter-Zeile"));
	({ state } = drive(state, ["right"]));
	view = wizardView(state);
	assert.ok(view.rows[1].active); // cursor starts on the recommendation...
	assert.ok(!view.rows[1].text.includes("✔")); // ...but nothing is chosen yet
	assert.ok(view.hint.includes("Enter wählt"));
	({ state } = drive(state, ["confirm", "left"]));
	assert.ok(wizardView(state).rows[1].text.includes("Bulletpoints ✔")); // now explicitly chosen
}

/* ---------------- wizard: text step ---------------- */
{
	const steps: WizardStepDef[] = [
		{
			kind: "text", id: "questions", tab: "Fragen", title: "Welche Frage(n)?",
			placeholder: "leer = chatten",
		},
		wizardSteps[2], // the save choice
	];
	// Typing appends; control chars are stripped; pasted newlines STAY
	// newlines on the multiline question step; backspace deletes.
	let { state } = drive(initWizard(steps, { lang: "de" }), [
		{ kind: "input", chars: "Welche Kamera?" },
		{ kind: "input", chars: "\nWo installiert??" },
		"backspace",
	]);
	assert.equal(state.texts[0], "Welche Kamera?\nWo installiert?");
	let view = wizardView(state);
	// One question per line: earlier lines plain, the LAST line carries the
	// cursor; the count line follows; the hint explains the Enter semantics.
	assert.equal(view.rows[0].text, "  Welche Kamera?");
	assert.ok(view.rows[1].text.startsWith("❯ Wo installiert?"));
	assert.ok(view.rows[2].text.includes("2 Frage(n) erkannt"));
	assert.ok(view.hint.includes("neue Zeile"));
	// Enter on a filled last line opens a NEW line; Enter on the blank line
	// trims it and advances (two strokes leave a filled tab).
	({ state } = drive(state, ["confirm"]));
	assert.equal(state.texts[0], "Welche Kamera?\nWo installiert?\n");
	assert.equal(drive(state, []).state.tab, 0); // still on the questions tab
	({ state } = drive(state, ["confirm"])); // blank line -> trim + advance
	assert.equal(state.texts[0], "Welche Kamera?\nWo installiert?");
	({ state } = drive(state, ["confirm", "confirm"])); // save "yes" -> submit Absenden
	const finished = drive(state, []);
	assert.deepEqual(wizardResult(finished.state), {
		questions: "Welche Kamera?\nWo installiert?",
		save: "yes",
	});
	// With more lines than the window the view shows the tail plus an
	// overflow note counting the hidden lines above.
	const many = drive(initWizard(steps, { lang: "de" }), [
		{ kind: "input", chars: Array.from({ length: 10 }, (_, i) => `Frage ${i + 1}?`).join("\n") },
	]);
	const tall = wizardView(many.state);
	assert.ok(tall.rows[0].text.includes("2 weitere Zeile(n) oben"));
	assert.equal(tall.rows[1].text, "  Frage 3?");
	assert.ok(tall.rows[8].text.startsWith("❯ Frage 10?"));
	// An EMPTY text is a valid answer (= no questions): finish succeeds.
	const empty = drive(initWizard(steps, { lang: "de" }), ["confirm", "confirm", "confirm"]);
	assert.equal(empty.done, "confirmed");
	assert.equal(wizardResult(empty.state).questions, "");
	// The placeholder shows while empty; the summary says "(keine)".
	view = wizardView(initWizard(steps, { lang: "de" }));
	assert.ok(view.rows[1].text.includes("leer = chatten"));
	const emptyReview = wizardView({ ...empty.state, tab: 2 }).rows;
	assert.ok(emptyReview.some((row) => row.text.includes("● Fragen")));
	assert.ok(emptyReview.some((row) => row.text.includes("→ (keine)")));
	// Typed input outside a text step is ignored.
	const noText = drive(initWizard(wizardSteps), [{ kind: "input", chars: "x" }, "backspace"]);
	assert.equal(noText.state.texts[0], "");
	assert.deepEqual([...noText.state.selected[0]], ["c"]);
}

/* ---------------- wizard: enabledIf skips steps ---------------- */
{
	const steps: WizardStepDef[] = [
		{
			kind: "text", id: "questions", tab: "Fragen", title: "Welche Frage(n)?",
		},
		{
			kind: "choice", id: "detail", tab: "Fragen-Modus", title: "Modus?",
			options: [{ value: "per-paper", label: "A" }, { value: "cross-paper", label: "B" }],
			initial: "per-paper",
			enabledIf: (answers) => parseQuestionLines(String(answers.questions ?? "")).length > 0,
		},
		{
			kind: "choice", id: "save", tab: "HTML", title: "Als HTML speichern?",
			options: [{ value: "yes", label: "Ja" }, { value: "no", label: "Nein" }],
		},
	];
	// Without questions the detail tab is DISABLED: it STAYS in the tab bar
	// greyed out (visibility never changes while navigating), never
	// blocks the finish and is absent from the result; the Enter-through
	// flow still skips it.
	let { state } = drive(initWizard(steps, { lang: "de" }), ["confirm"]); // empty text -> next enabled = save
	assert.equal(state.tab, 2);
	// (a filled square means "carries a value" -- the empty text step
	// is valid but stays an empty square)
	assert.deepEqual(wizardView(state).tabs.map((tab) => [tab.label.trim(), tab.disabled ?? false]), [
		["□ Fragen", false],
		["□ Fragen-Modus", true],
		["□ HTML", false],
		["✓ Bestätigen", false],
	]);
	// Back VISITS the disabled step: it shows a reason line, nothing else.
	({ state } = drive(state, ["left"]));
	assert.equal(state.tab, 1);
	const disabledView = wizardView(state);
	assert.ok(disabledView.rows[0].text.includes(DIALOG_TEXT.de.disabledDefault));
	assert.equal(disabledView.hint, DIALOG_TEXT.de.hintDisabled);
	// v31.3: the reason renders as a WARNING row (yellow, ⚠) -- same look
	// as the submit page's "answer remaining" line.
	assert.ok(disabledView.rows[0].text.includes("⚠ "));
	assert.equal(disabledView.rows[0].warn, true);
	// Everything but navigation is inert there...
	const idle = drive(state, [{ kind: "input", chars: "x" }, "toggle", "up", "backspace"]);
	assert.equal(idle.state, state);
	// ...and Enter advances PAST it to the next enabled step.
	assert.equal(drive(state, ["confirm"]).state.tab, 2);
	({ state } = drive(state, ["left"]));
	assert.equal(state.tab, 0);
	const finished = drive(state, ["confirm", "confirm", "confirm"]); // save "yes" -> submit -> Absenden
	assert.equal(finished.done, "confirmed");
	assert.deepEqual(wizardResult(finished.state), { questions: "", save: "yes" });
	// WITH a question the step exists again and gates the finish (
	// the filled multiline tab needs Enter twice -- new line, then advance).
	let withQ = drive(initWizard(steps, { lang: "de" }), [{ kind: "input", chars: "Welche Kamera?" }, "confirm", "confirm"]);
	assert.equal(withQ.state.tab, 1);
	withQ = drive(withQ.state, ["right", "confirm", "confirm"]); // skip detail, answer save, Absenden
	assert.equal(withQ.done, undefined);
	assert.equal(withQ.state.tab, 1); // the finish guard jumped to the open detail step
	withQ = drive(withQ.state, ["confirm", "confirm", "confirm"]); // answer detail -> save answered? save already yes -> submit -> Absenden
	assert.equal(withQ.done, "confirmed");
	assert.equal(wizardResult(withQ.state).detail, "per-paper");
	// A step-specific disabledNote wins over the generic reason.
	const noted = initWizard([steps[0], { ...steps[1], disabledNote: "Braucht eine Frage." }, steps[2]], { lang: "de" });
	assert.ok(wizardView({ ...noted, tab: 1 }).rows[0].text.includes("Braucht eine Frage."));
}

/* -------- wizard: startTab submit + initialIsAnswer -------- */
{
	// The search intake pattern: open ON the review page, every step
	// pre-answered -- ONE Enter runs the proposal (old dialog parity).
	const steps: WizardStepDef[] = [
		{ kind: "text", id: "query", tab: "Suchanfrage", title: "Wonach suchen?", initial: "sandbar detection", plain: true },
		{
			kind: "choice", id: "depth", tab: "Tiefe", title: "Suchtiefe?",
			options: [{ value: "quick", label: "Schnell" }, { value: "custom", label: "Eigene Anzahl" }],
			initial: "quick", initialIsAnswer: true,
		},
		{
			kind: "text", id: "count", tab: "Anzahl", title: "Treffer je Quelle",
			initial: "5", plain: true,
			enabledIf: (answers) => answers.depth === "custom",
			disabledNote: "Nur bei eigener Anzahl relevant.",
		},
	];
	const opened = initWizard(steps, { startTab: "submit" });
	assert.equal(opened.tab, steps.length); // review page first
	const confirmed = drive(opened, ["confirm"]);
	assert.equal(confirmed.done, "confirmed");
	// The disabled count step is absent; the pre-answered choice is in.
	assert.deepEqual(wizardResult(confirmed.state), { query: "sandbar detection", depth: "quick" });
	// The review page shows the pre-answered choice, not "(offen)".
	assert.ok(summaryLines(opened).some((line) => line.includes("Tiefe: Schnell")));
	// Walking left from the review lands on the last step; adjusting to
	// "custom" enables the count tab, and the result carries it.
	let { state } = drive(opened, ["left"]); // -> count tab (disabled, visitable)
	assert.equal(state.tab, 2);
	({ state } = drive(state, ["left", "down", "confirm"])); // depth -> custom (advance lands on count)
	assert.equal(state.tab, 2);
	const custom = drive(state, [{ kind: "input", chars: "0" }, "confirm", "confirm"]); // count "50" -> submit -> Absenden
	assert.equal(custom.done, "confirmed");
	assert.deepEqual(wizardResult(custom.state), { query: "sandbar detection", depth: "custom", count: "50" });
	// WITHOUT initialIsAnswer the finish guard still protects: an
	// unanswered choice pulls the wizard back from the review page.
	const strict = initWizard([
		{ kind: "choice", id: "depth", tab: "Tiefe", title: "?", options: [{ value: "a", label: "A" }], initial: "a" },
	], { startTab: "submit" });
	const guarded = drive(strict, ["confirm"]);
	assert.equal(guarded.done, undefined);
	assert.equal(guarded.state.tab, 0);
}

/* ---------------- wizard: submit note ---------------- */
{
	const note = (answers: Record<string, unknown>): string | null =>
		typeof answers.summary === "string" ? `~${answers.summary === "none" ? 0 : 3} Modellaufruf(e)` : null;
	const state = initWizard(wizardSteps, { submitNote: note as never });
	// Unanswered summary -> no note line yet.
	assert.ok(!wizardView({ ...state, tab: 3 }).rows.some((row) => row.text.includes("Modellaufruf")));
	const answered = drive(state, ["up", "confirm", "confirm", "confirm"]); // commit docs, summary bullets, save yes -> submit
	assert.equal(answered.state.tab, 3);
	assert.ok(wizardView(answered.state).rows.some((row) => row.text.includes("~3 Modellaufruf(e)")));
	// The note counts one extra row in the constant footprint (layout:
	// 3 steps x 2 + note + warning slot + blank + 2 actions).
	assert.equal(maxWizardRows(state), 11);
}

/* ---------------- wizard: skipSubmit gates ---------------- */
{
	// A one-step question gate: Enter finishes DIRECTLY, no review page.
	const gate: WizardStepDef[] = [{
		kind: "text", id: "question", tab: "Frage", title: "Frage prüfen",
		initial: "welche kameras wurden verwendet?", plain: true,
	}];
	const confirmed = drive(initWizard(gate, { skipSubmit: true }), ["confirm"]);
	assert.equal(confirmed.done, "confirmed");
	assert.equal(wizardResult(confirmed.state).question, "welche kameras wurden verwendet?");
	// Editing before Enter: backspace + typing land in the result.
	const edited = drive(initWizard(gate, { skipSubmit: true }), [
		...Array.from({ length: "welche kameras wurden verwendet?".length }, () => "backspace"),
		{ kind: "input", chars: "welche kamera nutzen sie?" },
		"confirm",
	]);
	assert.equal(wizardResult(edited.state).question, "welche kamera nutzen sie?");
	// Esc still cancels; an empty gate still confirms (empty = valid).
	assert.equal(drive(initWizard(gate, { skipSubmit: true }), ["cancel"]).done, "cancelled");
	// skipSubmit still guards required steps: an empty checkbox jumps back
	// instead of finishing.
	const scoped: WizardStepDef[] = [
		{ kind: "checkbox", id: "papers", tab: "Dokumente", title: "Welche?", items, selectAllLabel: "Alle", nextLabel: "Weiter" },
		gate[0],
	];
	const guarded = drive(initWizard(scoped, { skipSubmit: true }), ["right", "confirm"]); // skip to question, Enter
	assert.equal(guarded.done, undefined);
	assert.equal(guarded.state.tab, 0); // jumped to the empty scope step
	const through = drive(guarded.state, ["confirm", "up", "confirm", "confirm"]); // select-all, Weiter, Enter on question
	assert.equal(through.done, "confirmed");
	assert.deepEqual(wizardResult(through.state).papers, ["a", "b", "c"]);
}

/* ---------------- wizard: dialog language ---------------- */

/* -------- wizard: derived text, free-entry choice, form step -------- */
{
	// derive: the grouping follows the query LIVE until the user edits the
	// grouping themselves; then their text wins, even cleared.
	const steps: WizardStepDef[] = [
		{ kind: "text", id: "query", tab: "Query", title: "Query?", plain: true },
		{
			kind: "text", id: "groups", tab: "Grouping", title: "Groups?", plain: true,
			derive: (answers) => String(answers.query ?? "").split(" ").filter(Boolean).map((word) => `(${word})`).join(" AND "),
		},
	];
	let { state } = drive(initWizard(steps), [{ kind: "input", chars: "sandbar rivers" }]);
	assert.equal(wizardView({ ...state, tab: 1 }).rows[0].text, "❯ (sandbar) AND (rivers)_");
	assert.equal(wizardResult(state).groups, "(sandbar) AND (rivers)");
	// More typing on the query updates the derived grouping.
	({ state } = drive(state, [{ kind: "input", chars: " sentinel" }]));
	assert.equal(wizardResult(state).groups, "(sandbar) AND (rivers) AND (sentinel)");
	// The summary (plain) shows the derived value verbatim.
	assert.ok(summaryLines(state).some((line) => line === "Grouping: (sandbar) AND (rivers) AND (sentinel)"));
	// Editing the grouping takes ownership...
	({ state } = drive(state, ["right", "backspace"]));
	assert.equal(wizardResult(state).groups, "(sandbar) AND (rivers) AND (sentinel");
	({ state } = drive(state, [{ kind: "input", chars: " OR s-2)" }]));
	// ...and later query edits no longer touch it.
	({ state } = drive(state, ["left", { kind: "input", chars: " xyz" }]));
	assert.equal(wizardResult(state).groups, "(sandbar) AND (rivers) AND (sentinel OR s-2)");
	// Clearing an owned grouping stays cleared (= ungrouped), not re-derived.
	const cleared = drive(initWizard(steps), [
		{ kind: "input", chars: "a b" }, "right", "backspace", "backspace", "backspace",
		"backspace", "backspace", "backspace", "backspace", "backspace", "backspace", "backspace", "backspace",
	]);
	assert.equal(wizardResult(cleared.state).groups, "");
	// A provided initial counts as ownership from the start (agent proposal).
	const proposed = initWizard([steps[0], { ...(steps[1] as WizardStepDef & { kind: "text" }), initial: "(x)" }]);
	assert.equal(wizardResult(drive(proposed, [{ kind: "input", chars: "q" }]).state).groups, "(x)");
	// plain text steps: no question counter, placeholder only while empty.
	const plainView = wizardView(drive(initWizard(steps), [{ kind: "input", chars: "a; b" }]).state);
	assert.ok(!plainView.rows[1].text.includes("recognized"));
}

{
	// Free-entry choice option: presets answer with their value, the custom
	// row answers with its TYPED text; empty custom input answers nothing.
	const steps: WizardStepDef[] = [{
		kind: "choice", id: "count", tab: "Count", title: "How many?",
		options: [
			{ value: "5", label: "5 (default)" },
			{ value: "50", label: "50 (maximum)" },
			{ value: "custom", label: "Custom count:", freeText: true },
		],
	}];
	// Preset: unchanged behavior.
	const preset = drive(initWizard(steps), ["confirm", "confirm"]);
	assert.equal(preset.done, "confirmed");
	assert.equal(wizardResult(preset.state).count, "5");
	// Custom: cursor onto the row, type, Enter answers with the text.
	const custom = drive(initWizard(steps), ["down", "down", { kind: "input", chars: "23" }, "confirm", "confirm"]);
	assert.equal(custom.done, "confirmed");
	assert.equal(wizardResult(custom.state).count, "23");
	// The row renders label + inline input; the summary shows the raw value.
	const typing = drive(initWizard(steps), ["down", "down", { kind: "input", chars: "23" }]).state;
	assert.ok(wizardView(typing).rows[2].text.includes("Custom count: 23_"));
	assert.ok(summaryLines(custom.state).some((line) => line === "Count: 23"));
	// Empty custom input does not answer -- the finish guard keeps holding.
	const refused = drive(initWizard(steps), ["down", "down", "confirm"]);
	assert.equal(refused.done, undefined);
	assert.equal(refused.state.chosen[0], null);
	// An initial matching NO preset seeds the custom row (agent proposal 23).
	const seeded = initWizard([{ ...(steps[0] as WizardStepDef & { kind: "choice" }), initial: "23", initialIsAnswer: true }], { startTab: "submit" });
	assert.equal(seeded.texts[0], "23");
	assert.equal(seeded.cursors[0], 2); // cursor on the custom row
	const confirmed = drive(seeded, ["confirm"]);
	assert.equal(confirmed.done, "confirmed");
	assert.equal(wizardResult(confirmed.state).count, "23");
}

/* -------- wizard: option descriptions + seeded custom row -------- */
{
	// The grouping-variants pattern: descriptions render as dim lines under
	// each option and follow the LIVE answers; the freeText row is seeded
	// from the other answers until the user types there.
	const steps: WizardStepDef[] = [
		{ kind: "text", id: "query", tab: "Query", title: "Query?", plain: true },
		{
			kind: "choice", id: "groups", tab: "Grouping", title: "Label how?",
			options: [
				{ value: "strict", label: "All concepts", description: (a) => `strict(${a.query})` },
				{ value: "none", label: "No grouping", description: "results stay unlabeled" },
				{ value: "custom", label: "Custom:", freeText: true },
			],
			customSeed: (a) => `seed(${a.query})`,
		},
	];
	let { state } = drive(initWizard(steps), [{ kind: "input", chars: "water mask" }, "right"]);
	const view = wizardView(state);
	// Option row + dim description row, dynamic against the live query.
	assert.equal(view.rows[0].text, "❯ 1. All concepts");
	assert.equal(view.rows[1].text, "     strict(water mask)");
	assert.ok(view.rows[1].dim === true);
	assert.equal(view.rows[3].text, "     results stay unlabeled");
	// descriptionPlain renders the line white (substance, not
	// explanation).
	const plain = initWizard([{
		kind: "choice", id: "g", tab: "G", title: "?",
		options: [{ value: "a", label: "A", description: "expr", descriptionPlain: true }],
	}]);
	assert.ok(!wizardView(plain).rows[1].dim);
	assert.equal(wizardView(plain).rows[1].text, "     expr");
	// v30.5: labels can be LIVE too -- the grouping variants put the derived
	// expression on the main row and the variant name in the dim line; the
	// review shows both.
	const swapped = drive(initWizard([
		{ kind: "text", id: "query", tab: "Q", title: "?", plain: true },
		{
			kind: "choice", id: "g", tab: "G", title: "?",
			options: [{ value: "strict", label: (a) => `expr(${a.query})`, description: "Full match (strict)" }],
		},
	]), [{ kind: "input", chars: "water" }, "right"]);
	const swappedView = wizardView(swapped.state);
	assert.equal(swappedView.rows[0].text, "❯ 1. expr(water)");
	assert.ok(swappedView.rows[1].dim && swappedView.rows[1].text.includes("Full match (strict)"));
	const swappedDone = drive(swapped.state, ["confirm", "confirm"]);
	assert.ok(summaryLines(swappedDone.state).some((line) => line === "G: expr(water) -- Full match (strict)"));
	// The seeded custom row shows the live seed...
	assert.equal(view.rows[4].text, "  3. Custom: seed(water mask)");
	// ...and Enter on it answers with the SEED when untouched.
	const seeded = drive(state, ["down", "down", "confirm", "confirm"]);
	assert.equal(seeded.done, "confirmed");
	assert.equal(wizardResult(seeded.state).groups, "seed(water mask)");
	// Typing on the row takes ownership; later query edits stop updating it.
	({ state } = drive(state, ["down", "down", "backspace", { kind: "input", chars: ")x" }]));
	assert.ok(wizardView(state).rows[4].text.includes("Custom: seed(water mask)x_"));
	({ state } = drive(state, ["left", { kind: "input", chars: "s" }]));
	assert.ok(wizardView({ ...state, tab: 1 }).rows[4].text.includes("seed(water mask)x"));
	// A preset answer's review line carries its description (the substance).
	const strict = drive(initWizard(steps), [{ kind: "input", chars: "a" }, "confirm", "confirm"]);
	assert.ok(summaryLines(strict.state).some((line) => line === "Grouping: All concepts -- strict(a)"));
}

/* -------- wizard: optional checkbox + lazily loaded items -------- */
{
	// The journal-list pattern: an optional checkbox step starts EMPTY with
	// a dim note; empty selection is a valid answer (no filter) and never
	// blocks or stalls the Enter-through flow.
	const steps: WizardStepDef[] = [
		{ kind: "text", id: "query", tab: "Query", title: "?", plain: true },
		{
			kind: "checkbox", id: "journals", tab: "Journals", title: "?",
			items: [], selectAllLabel: "Select all", nextLabel: "Next",
			optional: true, emptyNote: "(fetching journal list ...)",
		},
	];
	let { state } = drive(initWizard(steps), [{ kind: "input", chars: "water" }, "confirm"]);
	assert.equal(state.tab, 1);
	// Empty list: the note shows dim, Enter advances from ANY row.
	let view = wizardView(state);
	assert.ok(view.rows[0].dim && view.rows[0].text.includes("(fetching journal list ...)"));
	const through = drive(state, ["confirm", "confirm"]); // -> submit -> finish
	assert.equal(through.done, "confirmed");
	assert.deepEqual(wizardResult(through.state).journals, []);
	// No warning for the empty OPTIONAL step; the review says "(none)".
	assert.ok(!wizardView(drive(state, ["confirm"]).state).rows.some((row) => row.warn));
	assert.ok(summaryLines(drive(state, ["confirm"]).state).some((line) => line === "Journals: (none)"));
	// setItems loads the fetched list: items appear, selection works.
	({ state } = drive(state, [
		{ kind: "setItems", step: "journals", items: [
			{ id: "Remote Sensing", label: "Remote Sensing (1739)" },
			{ id: "Water", label: "Water (91)" },
		], emptyNote: "" },
	] as never));
	view = wizardView(state);
	assert.ok(view.rows.some((row) => row.text.includes("Remote Sensing (1739)")));
	const picked = drive(state, ["down", "toggle", "down", "down", "confirm", "confirm"]); // select first item, Next, submit
	assert.equal(picked.done, "confirmed");
	assert.deepEqual(wizardResult(picked.state).journals, ["Remote Sensing"]);
	// Re-loading with OTHER items prunes a stale selection.
	const pruned = drive(drive(state, ["down", "toggle"]).state, [
		{ kind: "setItems", step: "journals", items: [{ id: "Water", label: "Water (91)" }] },
	] as never);
	assert.deepEqual(wizardResult(pruned.state).journals, []);
	// setItems for an unknown step id is a no-op.
	assert.equal(drive(state, [{ kind: "setItems", step: "ghost", items: [] }] as never).state.steps[1].kind, "checkbox");
}

{
	// Form step: several optional fields in one tab; Enter walks the fields
	// and leaves on the last; field ids join the result directly.
	const steps: WizardStepDef[] = [{
		kind: "form", id: "filters", tab: "Filters", title: "Optional filters",
		fields: [
			{ id: "min_cites", label: "Min. citations" },
			{ id: "min_score", label: "Min. journal score" },
			{ id: "venues", label: "Journals" },
		],
	}];
	// All empty: ONE Enter passes the whole tab (Enter on an empty field
	// leaves the step), filters stay off, no tab mark, summary honest.
	const empty = drive(initWizard(steps), ["confirm", "confirm"]);
	assert.equal(empty.done, "confirmed");
	assert.deepEqual(wizardResult(empty.state), { min_cites: "", min_score: "", venues: "" });
	assert.ok(wizardView(initWizard(steps)).tabs[0].label.startsWith("□"));
	assert.ok(summaryLines(empty.state).some((line) => line === "Filters: (none)"));
	// Typing edits the focused field; up/down move; the tab gains its mark.
	let { state } = drive(initWizard(steps), [{ kind: "input", chars: "10" }, "down", "down", { kind: "input", chars: "Remote Sensing" }]);
	assert.ok(wizardView(state).tabs[0].label.startsWith("■"));
	const rows = wizardView(state).rows;
	assert.equal(rows[0].text, "  Min. citations: 10");
	assert.equal(rows[2].text, "❯ Journals: Remote Sensing_");
	const done = drive(state, ["confirm", "confirm"]);
	assert.equal(done.done, "confirmed");
	assert.deepEqual(wizardResult(done.state), { min_cites: "10", min_score: "", venues: "Remote Sensing" });
	assert.ok(summaryLines(done.state).some((line) => line === "Filters: Min. citations 10 · Journals Remote Sensing"));
	// Enter on a FILLED non-last field moves down; on an empty one it leaves.
	const walked = drive(initWizard(steps), [{ kind: "input", chars: "3" }, "confirm"]);
	assert.equal(walked.state.tab, 0);
	assert.equal(walked.state.cursors[0], 1);
	const skipped = drive(walked.state, ["confirm"]); // field 2 empty -> out
	assert.equal(skipped.state.tab, 1);
}

{
	// Grow form (the query tab's keyword blocks): min fields at the start,
	// an explicit ADD row under them appends more (up to max, then it
	// hides), a blank separator divides grow and static fields; note row
	// reserved, summary wins the review line.
	const steps: WizardStepDef[] = [{
		kind: "form", id: "query", tab: "Query", title: "Query",
		grow: { idPrefix: "qb", label: (n) => `Block ${n}`, addLabel: "+ Add block", min: 2, max: 4 },
		fields: [{ id: "free", label: "Free text" }],
		note: (values) => (values[values.length - 1]?.trim() !== "" && values.slice(0, -1).some((value) => value.trim() !== "")
			? { text: "free text wins", warn: true }
			: null),
		summary: (values) => values.filter((value) => value.trim() !== "").join(" AND "),
	}];
	let state = initWizard(steps);
	// min grow fields plus the static field; ids follow the live count.
	assert.deepEqual(state.formTexts[0], ["", "", ""]);
	assert.deepEqual(wizardResult(state), { qb_1: "", qb_2: "", free: "" });
	let rows = wizardView(state).rows;
	assert.equal(rows[0].text, "❯ Block 1: _");
	assert.equal(rows[1].text, "  Block 2: ");
	assert.ok(rows[2].text.includes("+ Add block")); // the add row
	assert.ok(rows[2].dim); // dim while not focused
	assert.equal(rows[3].text, ""); // blank separator before the static field
	assert.equal(rows[4].text, "  Free text: ");
	// The note row is reserved (empty) while the warning is off.
	assert.equal(rows.length, 6);
	assert.equal(rows[5].text, "");
	// Height budget = WORST CASE (max grow + add slot + separator + static
	// + note), stable while fields are added (submit page: 1 step x 2 + 4
	// = 6 rows -- smaller).
	assert.equal(maxWizardRows(state), 8);
	// Typing fills the focused field; nothing spawns by itself.
	({ state } = drive(state, [{ kind: "input", chars: "satellite" }]));
	assert.deepEqual(state.formTexts[0], ["satellite", "", ""]);
	({ state } = drive(state, ["confirm"])); // filled -> next field
	assert.equal(state.cursors[0], 1);
	// Enter on a filled last grow field SKIPS the add row (Enter-through
	// must never add a block by accident) and lands on the free text.
	({ state } = drive(state, [{ kind: "input", chars: "fusion" }, "confirm"]));
	assert.equal(state.cursors[0], 3);
	assert.deepEqual(state.formTexts[0], ["satellite", "fusion", ""]);
	// The add row: typing is inert there; Enter appends one empty grow
	// field, which takes the add row's spot (cursor lands on it).
	({ state } = drive(state, ["up"])); // free text -> add row
	assert.equal(state.cursors[0], 2);
	({ state } = drive(state, [{ kind: "input", chars: "zzz" }]));
	assert.deepEqual(state.formTexts[0], ["satellite", "fusion", ""]); // inert
	({ state } = drive(state, ["confirm"]));
	assert.deepEqual(state.formTexts[0], ["satellite", "fusion", "", ""]);
	assert.equal(state.cursors[0], 2); // on the new Block 3
	assert.deepEqual(wizardResult(state), { qb_1: "satellite", qb_2: "fusion", qb_3: "", free: "" });
	assert.equal(maxWizardRows(state), 8); // unchanged by the add
	// At the cap the add row hides; emptied fields never collapse.
	({ state } = drive(state, [{ kind: "input", chars: "deep" }, "down", "confirm"])); // add Block 4 (max)
	assert.equal(state.formTexts[0].length, 5); // 4 grow + free
	assert.ok(!wizardView(state).rows.some((row) => row.text.includes("+ Add block")));
	({ state } = drive(state, ["confirm"])); // Enter on empty Block 4 leaves
	assert.equal(state.tab, 1);
	state = { ...state, tab: 0 }; // cursor still on Block 4
	({ state } = drive(state, [{ kind: "input", chars: "x" }, "backspace"])); // filled then emptied
	assert.equal(state.formTexts[0].length, 5);
	// The separator/note rows are no cursor stops: down from the free text
	// wraps to Block 1.
	({ state } = drive(state, ["down"])); // Block 4 -> free text
	assert.equal(state.cursors[0], 4);
	({ state } = drive(state, ["down"]));
	assert.equal(state.cursors[0], 0);
	// Both filled -> warn row; summary shows the injected composed line.
	({ state } = drive(state, ["down", "down", "down", "down", { kind: "input", chars: "a sentence" }]));
	rows = wizardView(state).rows;
	assert.ok(rows[rows.length - 1].warn);
	assert.ok(rows[rows.length - 1].text.includes("⚠ free text wins"));
	assert.ok(summaryLines(state).some((line) =>
		line === "Query: satellite AND fusion AND deep AND a sentence"));
	// Untouched tab passes with ONE Enter (empty first field leaves).
	const through = drive(initWizard(steps), ["confirm", "confirm"]);
	assert.equal(through.done, "confirmed");
	// grow.initial seeds the fields (padded to min; no extra empty field --
	// more blocks come through the add row).
	const seeded = initWizard([{
		...steps[0],
		grow: { idPrefix: "qb", label: (n) => `Block ${n}`, addLabel: "+ Add block", min: 2, max: 4, initial: ["a OR b", "c"] },
	} as WizardStepDef]);
	assert.deepEqual(seeded.formTexts[0], ["a OR b", "c", ""]);
	assert.deepEqual(wizardResult(seeded), { qb_1: "a OR b", qb_2: "c", free: "" });
}

/* -------- locked rows (the variants tab's base query) -------- */
{
	const lockedItems = [
		{ id: "base", label: "water mask (main query)", locked: true },
		{ id: "v1", label: "surface water extraction" },
	];
	// Wizard checkbox step: locked ids are selected from init, toggle on
	// them is a no-op, select-all "off" keeps them, the row renders checked.
	const lockedSteps: WizardStepDef[] = [{
		kind: "checkbox", id: "v", tab: "Variants", title: "?", items: lockedItems,
		selectAllLabel: "All", nextLabel: "Next",
	}];
	let { state } = drive(initWizard(lockedSteps), []);
	assert.deepEqual([...state.selected[0]], ["base"]);
	({ state } = drive(state, ["down", "toggle"])); // cursor on the locked row
	assert.deepEqual([...state.selected[0]], ["base"]); // still selected
	({ state } = drive(state, ["up", "toggle"])); // select-all row: all on
	assert.deepEqual([...state.selected[0]].sort(), ["base", "v1"]);
	({ state } = drive(state, ["toggle"])); // all "off" keeps locked
	assert.deepEqual([...state.selected[0]], ["base"]);
	assert.ok(wizardView(state).rows.some((row) => row.text.includes("[✔] water mask")));
}

/* ---- checkbox cursor vs description lines ---- */
{
	// rowCount counts dim description lines for the overlay HEIGHT, but the
	// cursor must not walk them: before the fix, items with descriptions
	// created dead cursor rows and Enter beyond the list crashed on
	// items[cursor-1]. Nav layout: select-all(0), items(1..n), Next(n+1).
	const steps: WizardStepDef[] = [{
		kind: "checkbox", id: "docs", tab: "Docs", title: "?",
		items: [
			{ id: "a", label: "a.pdf", description: "2021 - Kryniecka - Vistula" },
			{ id: "b", label: "b.pdf", description: "2026 - Blanch - Water level" },
		],
		selectAllLabel: "All", nextLabel: "Next",
	}];
	let { state } = drive(initWizard(steps), ["down", "down"]); // -> item b
	({ state } = drive(state, ["confirm"])); // Enter toggles item b, no crash
	assert.deepEqual([...state.selected[0]], ["b"]);
	({ state } = drive(state, ["down"])); // -> Next row (row 3, not a dead row)
	const committed = drive(state, ["confirm", "confirm"]);
	assert.equal(committed.done, "confirmed");
	assert.deepEqual(wizardResult(committed.state).docs, ["b"]);
	// Down from Next wraps straight back to select-all -- no dead rows.
	assert.equal(drive(state, ["down"]).state.cursors[0], 0);
}

/* -------- steering input row + keepSelected + cursorStart -------- */
{
	const variantsStep: WizardStepDef = {
		kind: "checkbox", id: "variants", tab: "Variants", title: "?",
		items: [], selectAllLabel: "All", nextLabel: "Next",
		optional: true, emptyNote: "(waiting)", keepSelected: true, cursorStart: "next",
		input: { id: "variants_hint", label: "Steer" },
	};
	const steps: WizardStepDef[] = [
		{ kind: "text", id: "query", tab: "Query", title: "?", plain: true },
		variantsStep,
	];
	// cursorStart "next": the empty tab starts on the Next row (emptyNote 0,
	// input row 1, Next 2) -- Enter-through never toggles select-all.
	let { state } = drive(initWizard(steps), [{ kind: "input", chars: "water" }, "confirm"]);
	assert.equal(state.tab, 1);
	assert.equal(state.cursors[1], 2);
	// The input row renders between the note and Next; the answers export
	// the COMMITTED steering value (empty) plus the commit counter.
	let view = wizardView(state);
	assert.ok(view.rows[1].text.includes("Steer: "));
	assert.equal(wizardAnswers(state).variants_hint, "");
	assert.equal(wizardAnswers(state).variants_hint_seq, "0");
	// Enter-through while empty+optional still passes with one stroke.
	const through = drive(state, ["confirm", "confirm"]);
	assert.equal(through.done, "confirmed");
	// setItems: the locked base row auto-selects; cursor stays on Next
	// (role-follow: old Next -> new Next, not a mid-list clamp).
	({ state } = drive(state, [
		{ kind: "setItems", step: "variants", items: [
			{ id: "__base__", label: "water (main query)", locked: true },
			{ id: "v1", label: "surface water extraction" },
			{ id: "v2", label: "water body segmentation" },
		], emptyNote: "" },
	] as never));
	assert.deepEqual([...state.selected[1]], ["__base__"]);
	assert.equal(state.cursors[1], 5); // 0 all, 1-3 items, 4 input, 5 Next
	// Toggle on the locked row is a no-op; select-all "off" keeps it.
	({ state } = drive(state, ["up", "up", "up", "up"])); // -> row 1 (base)
	({ state } = drive(state, ["toggle"]));
	assert.deepEqual([...state.selected[1]], ["__base__"]);
	({ state } = drive(state, ["up", "toggle"])); // select-all: all on
	assert.deepEqual([...state.selected[1]].sort(), ["__base__", "v1", "v2"]);
	({ state } = drive(state, ["toggle"])); // all "off" -> locked stays
	assert.deepEqual([...state.selected[1]], ["__base__"]);
	// Check v2, then type on the steering row: the draft edits, the ANSWERS
	// stay stable (no per-keystroke reload key changes) until Enter commits.
	({ state } = drive(state, ["down", "down", "down", "toggle"])); // row 3 = v2
	({ state } = drive(state, ["down"])); // row 4 = input row
	({ state } = drive(state, [{ kind: "input", chars: "focus deep learning" }]));
	assert.ok(wizardView(state).rows.some((row) => row.text.includes("Steer: focus deep learning_")));
	assert.equal(wizardAnswers(state).variants_hint, "");
	({ state } = drive(state, ["confirm"])); // commit: value + seq, stays put
	assert.equal(state.tab, 1);
	assert.equal(state.cursors[1], 4);
	assert.equal(wizardAnswers(state).variants_hint, "focus deep learning");
	assert.equal(wizardAnswers(state).variants_hint_seq, "1");
	({ state } = drive(state, ["confirm"])); // same text again = explicit re-roll
	assert.equal(wizardAnswers(state).variants_hint_seq, "2");
	// Regeneration dispatch: first the loading swap (empty items,
	// loading:true) -- checked and locked rows survive as appended orphans
	// (keepSelected)...
	({ state } = drive(state, [
		{ kind: "setItems", step: "variants", items: [], emptyNote: "(loading)", loading: true },
	] as never));
	assert.deepEqual([...state.selected[1]].sort(), ["__base__", "v2"]);
	assert.ok(state.steps[1].kind === "checkbox" && state.steps[1].items.some((item) => item.id === "v2"));
	// While loading, the view shows ONLY the pulsing note (2026-08-10 user
	// wish "zu Beginn nur die Ladezeile" -- no select-all, no rows, no
	// inputs); the resolved swap below clears it and the rows return.
	const loadingView = wizardView(state);
	assert.equal(loadingView.rows.length, 1);
	assert.ok(loadingView.rows[0].dim === true && loadingView.rows[0].text.includes("(loading)"));
	// ...then the new list arrives: v2 is not in it but stays, appended.
	({ state } = drive(state, [
		{ kind: "setItems", step: "variants", items: [
			{ id: "__base__", label: "water (main query)", locked: true },
			{ id: "v3", label: "open water mapping" },
		], emptyNote: "" },
	] as never));
	assert.deepEqual([...state.selected[1]].sort(), ["__base__", "v2"]);
	assert.ok(!wizardView(state).rows.some((row) => row.text.includes("(loading)")));
	const labels = (state.steps[1] as WizardStepDef & { kind: "checkbox" }).items.map((item) => item.id);
	assert.deepEqual(labels, ["__base__", "v3", "v2"]);
	// The cursor followed its role onto the input row across both swaps.
	assert.equal(state.cursors[1], 3 + 1); // 0 all, 1-3 items, 4 input
	// Result: checked ids plus the committed steering text.
	({ state } = drive(state, ["down", "confirm"])); // Next -> submit tab
	const finished = drive(state, ["confirm"]);
	assert.equal(finished.done, "confirmed");
	assert.deepEqual(finished.state.selected[1].size, 2);
	assert.deepEqual(wizardResult(finished.state).variants, ["__base__", "v2"]);
	assert.equal(wizardResult(finished.state).variants_hint, "focus deep learning");
	// The overlay height budget counts the input row.
	assert.ok(maxWizardRows(state) >= 7);
}

/* -------- loading semantics: note-only view, Enter-through -------- */
{
	const steps: WizardStepDef[] = [
		{
			kind: "checkbox", id: "variants", tab: "V", title: "?",
			items: [], selectAllLabel: "All", nextLabel: "Next",
			optional: true, keepSelected: true, cursorStart: "next",
			addInput: { id: "variants_own", label: "Own" },
			input: { id: "variants_hint", label: "Steer" },
		},
		{ kind: "text", id: "q", tab: "Q", title: "?", plain: true },
	];
	let { state } = drive(initWizard(steps), [
		{ kind: "setItems", step: "variants", items: [
			{ id: "__base__", label: "base", locked: true },
			{ id: "v1", label: "one" },
		], emptyNote: "", loading: true },
	] as never);
	// Note-only view although items exist underneath.
	assert.equal(wizardView(state).rows.length, 1);
	// Neither typing row is a typing target while loading.
	assert.equal(checkboxTypingRow(state.steps[0], 3), false);
	assert.equal(checkboxTypingRow(state.steps[0], 4), false);
	// Toggle is inert; Enter ADVANCES (the tab never waits on the model).
	state = { ...state, cursors: state.cursors.map(() => 1) };
	({ state } = drive(state, ["toggle"]));
	assert.deepEqual([...state.selected[0]], ["__base__"]); // locked only, unchanged
	({ state } = drive(state, ["confirm"]));
	assert.equal(state.tab, 1);
	// The resolved swap clears the flag: the full view returns.
	({ state } = drive(state, [
		"left",
		{ kind: "setItems", step: "variants", items: [
			{ id: "__base__", label: "base", locked: true },
			{ id: "v1", label: "one" },
		], emptyNote: "" },
	] as never));
	assert.ok(wizardView(state).rows.length > 1);
	assert.equal(checkboxTypingRow(state.steps[0], 4), true);
}

/* -------- variants ADD row: type your own variant -------- */
{
	const steps: WizardStepDef[] = [{
		kind: "checkbox", id: "variants", tab: "V", title: "?",
		items: [], selectAllLabel: "All", nextLabel: "Next",
		optional: true, keepSelected: true, cursorStart: "next",
		addInput: { id: "variants_own", label: "Own variant" },
		input: { id: "variants_hint", label: "Steer" },
	}];
	let { state } = drive(initWizard(steps), [
		{ kind: "setItems", step: "variants", items: [
			{ id: "__base__", label: "water (main query)", locked: true },
			{ id: "v1", label: "surface water extraction" },
		], emptyNote: "" },
	] as never);
	// Rows: 0 all, 1-2 items, 3 add, 4 steer, 5 Next; cursorStart landed on
	// Next and role-followed it across the item swap.
	assert.equal(state.cursors[0], 5);
	// The adapter predicate marks BOTH typing rows, nothing else.
	assert.equal(checkboxTypingRow(state.steps[0], 3), true);
	assert.equal(checkboxTypingRow(state.steps[0], 4), true);
	assert.equal(checkboxTypingRow(state.steps[0], 2), false);
	assert.equal(checkboxTypingRow(state.steps[0], 5), false);
	// Type an own variant on the add row: Enter adds it CHECKED, clears the
	// draft and the cursor follows the add row (the list grew by one).
	state = { ...state, cursors: state.cursors.map(() => 3) };
	({ state } = drive(state, [{ kind: "input", chars: "river ice mapping" }]));
	assert.ok(wizardView(state).rows.some((row) => row.text.includes("Own variant: river ice mapping_")));
	({ state } = drive(state, ["confirm"]));
	let step = state.steps[0] as WizardStepDef & { kind: "checkbox" };
	assert.deepEqual(step.items.map((item) => item.id), ["__base__", "v1", "river ice mapping"]);
	assert.deepEqual([...state.selected[0]].sort(), ["__base__", "river ice mapping"]);
	assert.equal(state.cursors[0], 4); // the add row, shifted by the new item
	assert.ok(wizardView(state).rows.some((row) => row.text.includes("Own variant: _"))); // draft cleared
	// Enter with an EMPTY draft is a no-op.
	({ state } = drive(state, ["confirm"]));
	assert.equal((state.steps[0] as WizardStepDef & { kind: "checkbox" }).items.length, 3);
	// Typing an EXISTING id (case-insensitive) just checks the row.
	({ state } = drive(state, [{ kind: "input", chars: "V1" }, "confirm"]));
	step = state.steps[0] as WizardStepDef & { kind: "checkbox" };
	assert.equal(step.items.length, 3);
	assert.deepEqual([...state.selected[0]].sort(), ["__base__", "river ice mapping", "v1"]);
	// A regeneration keeps the added row (keepSelected orphan semantics).
	({ state } = drive(state, [
		{ kind: "setItems", step: "variants", items: [
			{ id: "__base__", label: "water (main query)", locked: true },
			{ id: "v9", label: "new suggestion" },
		], emptyNote: "" },
	] as never));
	step = state.steps[0] as WizardStepDef & { kind: "checkbox" };
	assert.deepEqual(step.items.map((item) => item.id), ["__base__", "v9", "v1", "river ice mapping"]);
	assert.deepEqual([...state.selected[0]].sort(), ["__base__", "river ice mapping", "v1"]);
}

/* -------- setItems preselect vs locked ordering -------- */
{
	const steps: WizardStepDef[] = [{
		kind: "checkbox", id: "variants", tab: "V", title: "?",
		items: [], selectAllLabel: "All", nextLabel: "Next", optional: true, keepSelected: true,
	}];
	// First load: the selection is empty BEFORE the locked union, so an
	// agent preselect seeds -- locked joins afterwards.
	let { state } = drive(initWizard(steps), [
		{ kind: "setItems", step: "variants", items: [
			{ id: "__base__", label: "base", locked: true },
			{ id: "agent1", label: "agent variant" },
		], preselect: ["agent1"] },
	] as never);
	assert.deepEqual([...state.selected[0]].sort(), ["__base__", "agent1"]);
	// Second load: selection is non-empty -- a new preselect must NOT seed.
	({ state } = drive(state, [
		{ kind: "setItems", step: "variants", items: [
			{ id: "__base__", label: "base", locked: true },
			{ id: "agent1", label: "agent variant" },
			{ id: "b2", label: "other" },
		], preselect: ["b2"] },
	] as never));
	assert.deepEqual([...state.selected[0]].sort(), ["__base__", "agent1"]);
}

// pasteText: bracketed-paste chunks unwrap to their inner
// text; anything else is null, so the adapter's key matching proceeds.
{
	// The normal case: one complete wrapped chunk (pi-tui's terminal.js
	// re-wraps aggregated pastes exactly like this).
	assert.equal(pasteText("\x1b[200~water mask sentinel\x1b[201~"), "water mask sentinel");
	// Pasted newlines survive -- sanitizeInput decides per step kind
	// whether they become semicolons or stay lines.
	assert.equal(pasteText("\x1b[200~q1\rq2\x1b[201~"), "q1\rq2");
	// Tabs become spaces (the control strip would glue the words).
	assert.equal(pasteText("\x1b[200~water\tmask\x1b[201~"), "water mask");
	// A defensive half: missing end marker still yields the inner text.
	assert.equal(pasteText("\x1b[200~doi:10.1234/x"), "doi:10.1234/x");
	// Not a paste: typed chars, escape sequences, empty paste -> null.
	assert.equal(pasteText("a"), null);
	assert.equal(pasteText("\x1b[A"), null);
	assert.equal(pasteText("\x1b[200~\x1b[201~"), null);
}

// animateEllipsis: the FINAL "..." of a loading note cycles
// 1-2-3 dots with the tick; notes without an ellipsis pass unchanged.
{
	const note = "generating search suggestions ...";
	assert.equal(animateEllipsis(note, 0), "generating search suggestions .");
	assert.equal(animateEllipsis(note, 1), "generating search suggestions ..");
	assert.equal(animateEllipsis(note, 2), "generating search suggestions ...");
	assert.equal(animateEllipsis(note, 3), "generating search suggestions .");
	// Only the LAST ellipsis animates (a note quoting dots mid-text keeps them).
	assert.equal(animateEllipsis("a ... b ...", 0), "a ... b .");
	// No ellipsis: unchanged at every tick.
	assert.equal(animateEllipsis("no journals found", 5), "no journals found");
}


/* -------- spaced checkbox list: blank lines are render-only -------- */
{
	const steps: WizardStepDef[] = [{
		kind: "checkbox", id: "variants", tab: "V", title: "?",
		items: [], selectAllLabel: "All", nextLabel: "Next",
		optional: true, keepSelected: true, cursorStart: "next", spaced: true,
		addInput: { id: "variants_own", label: "Own" },
		input: { id: "variants_hint", label: "Steer" },
	}];
	const { state } = drive(initWizard(steps), [
		{ kind: "setItems", step: "variants", items: [
			{ id: "__base__", label: "water (main query)", locked: true, description: "(water)" },
			{ id: "v1", label: "surface water extraction" },
		], emptyNote: "" },
	] as never);
	// Cursor rows are untouched by the spacing: 0 all, 1-2 items, 3 add,
	// 4 steer, 5 Next.
	assert.equal(state.cursors[0], 5);
	assert.equal(checkboxTypingRow(state.steps[0], 3), true);
	assert.equal(checkboxTypingRow(state.steps[0], 4), true);
	// Rendered: a blank line before every item and before each input row;
	// the description stays glued to its item; no blank is ever active.
	const texts = wizardView(state).rows.map((row) => row.text.trim());
	assert.deepEqual(texts, [
		"[ ] All",
		"", "1. [✔] water (main query)", "(water)",
		"", "2. [ ] surface water extraction",
		"", "Own:", "", "Steer:", "❯    Next",
	]);
	assert.ok(wizardView(state).rows.every((row) => row.text !== "" || !row.active));
	// Without the flag the same list renders compact.
	const compact = drive(initWizard([{ ...steps[0], spaced: false } as WizardStepDef]), [
		{ kind: "setItems", step: "variants", items: [{ id: "v1", label: "x" }], emptyNote: "" },
	] as never).state;
	assert.ok(wizardView(compact).rows.every((row) => row.text !== ""));
}

console.log("dialog-state tests passed");
