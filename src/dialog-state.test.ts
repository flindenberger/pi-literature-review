/**
 * Offline tests for the pure dialog state machine (v25 E2c). The adapters
 * only translate keys and colors; everything decidable is decided -- and
 * pinned -- here.
 */

import assert from "node:assert/strict";
import {
	allSelected,
	type CheckboxState,
	checkboxLines,
	detectDialogLang,
	DIALOG_TEXT,
	initCheckbox,
	initWizard,
	langFromName,
	maxWizardRows,
	parseQuestionLines,
	reduceCheckbox,
	reduceWizard,
	selection,
	type WizardState,
	type WizardStepDef,
	wizardResult,
	wizardSummaryLines,
	wizardView,
} from "./dialog-state.ts";

const items = [
	{ id: "a", label: "2021_Kryniecka_Vistula.pdf" },
	{ id: "b", label: "2024_Wagner_Amazon.pdf" },
	{ id: "c", label: "2026_Blanch_Water_Level.pdf" },
];

/* ---------------- init + preselection ---------------- */
{
	const state = initCheckbox(items);
	assert.equal(state.cursor, 0);
	assert.deepEqual(selection(state), []);
	assert.equal(allSelected(state), false);
	// Preselection (e.g. the sticky scope) keeps only known ids.
	const sticky = initCheckbox(items, ["c", "ghost"]);
	assert.deepEqual(selection(sticky), ["c"]);
	// selection() reports ITEM order, not click order.
	const ordered = initCheckbox(items, ["c", "a"]);
	assert.deepEqual(selection(ordered), ["a", "c"]);
	// An empty library can never report all-selected.
	assert.equal(allSelected(initCheckbox([])), false);
}

/* ---------------- cursor movement wraps ---------------- */
{
	let state = initCheckbox(items);
	state = reduceCheckbox(state, "up").state;
	assert.equal(state.cursor, 3); // wraps to the last item row
	state = reduceCheckbox(state, "down").state;
	assert.equal(state.cursor, 0);
	state = reduceCheckbox(state, "down").state;
	assert.equal(state.cursor, 1);
}

/* ---------------- toggling: items and the derived select-all row ---------------- */
{
	let state = initCheckbox(items);
	// Toggle item 2 (cursor row 2).
	state = reduceCheckbox(state, "down").state;
	state = reduceCheckbox(state, "down").state;
	state = reduceCheckbox(state, "toggle").state;
	assert.deepEqual(selection(state), ["b"]);
	// Back up to the select-all row: toggle selects ALL...
	state = { ...state, cursor: 0 };
	state = reduceCheckbox(state, "toggle").state;
	assert.deepEqual(selection(state), ["a", "b", "c"]);
	assert.equal(allSelected(state), true);
	// ...and toggling again clears everything (including b).
	state = reduceCheckbox(state, "toggle").state;
	assert.deepEqual(selection(state), []);
	// Toggling the last missing item flips the DERIVED all-mark on.
	state = { ...state, selected: new Set(["a", "b"]), cursor: 3 };
	assert.equal(allSelected(state), false);
	state = reduceCheckbox(state, "toggle").state;
	assert.equal(allSelected(state), true);
}

/* ---------------- confirm and cancel ---------------- */
{
	let state = initCheckbox(items, ["a"]);
	const confirmed = reduceCheckbox(state, "confirm");
	assert.equal(confirmed.done, "confirmed");
	assert.deepEqual(selection(confirmed.state), ["a"]);
	// An empty selection is not confirmable -- the stroke is ignored.
	const empty = reduceCheckbox(initCheckbox(items), "confirm");
	assert.equal(empty.done, undefined);
	// Escape always cancels, selection or not.
	assert.equal(reduceCheckbox(state, "cancel").done, "cancelled");
}

/* ---------------- rendered rows (rpiv look, pinned) ---------------- */
{
	let state = initCheckbox(items, ["b"]);
	state = { ...state, cursor: 2 };
	const lines = checkboxLines(state, "Alle auswählen");
	assert.deepEqual(lines.map((line) => line.text), [
		"     [ ] Alle auswählen",
		"  1. [ ] 2021_Kryniecka_Vistula.pdf",
		"❯ 2. [✔] 2024_Wagner_Amazon.pdf",
		"  3. [ ] 2026_Blanch_Water_Level.pdf",
	]);
	assert.deepEqual(lines.map((line) => line.active), [false, false, true, false]);
	// With everything selected the summary row shows the derived mark.
	const all = { ...state, selected: new Set(["a", "b", "c"]) } satisfies CheckboxState;
	assert.ok(checkboxLines(all, "Alle auswählen")[0].text.includes("[✔] Alle auswählen"));
	// Two-digit lists align their number column.
	const many = initCheckbox(Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, label: `p${i}.pdf` })));
	const wide = checkboxLines(many, "Alle");
	assert.ok(wide[1].text.startsWith("   1. "));
	assert.ok(wide[10].text.startsWith("  10. "));
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

/* ---------------- wizard: rpiv semantics over several steps ---------------- */

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
	// slot + blank + 2 action rows, v30.2 rpiv layout) is the tallest tab.
	assert.equal(maxWizardRows(state), 10);
}

{
	// Enter on a checkbox ROW toggles (the E2c field complaint: it must NOT
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
	// "● Tab" + "→ value" pair (v30.2 rpiv layout), no warning line.
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
	// ...and warns UP FRONT which steps are still open (v30.2 rpiv look).
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
	// review tab a check (v30.2 rpiv look): papers is preselected (a REAL
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

/* ---------------- wizard: text step (v27) ---------------- */
{
	const steps: WizardStepDef[] = [
		{
			kind: "text", id: "questions", tab: "Fragen", title: "Welche Frage(n)?",
			placeholder: "leer = chatten",
		},
		wizardSteps[2], // the save choice
	];
	// Typing appends; control chars are stripped; pasted newlines become
	// semicolons; backspace deletes.
	let { state } = drive(initWizard(steps, { lang: "de" }), [
		{ kind: "input", chars: "Welche Kamera?" },
		{ kind: "input", chars: "\nWo installiert??" },
		"backspace",
	]);
	assert.equal(state.texts[0], "Welche Kamera?;Wo installiert?");
	let view = wizardView(state);
	assert.ok(view.rows[0].text.startsWith("❯ Welche Kamera?;Wo installiert?"));
	assert.ok(view.rows[1].text.includes("2 Frage(n) erkannt"));
	assert.ok(view.hint.includes("Semikolon"));
	// Enter commits the text and advances; the summary carries the questions.
	({ state } = drive(state, ["confirm", "confirm", "confirm"])); // text -> save "yes" -> submit? no: save confirm advances to submit; last confirm = Absenden
	const finished = drive(state, []);
	assert.deepEqual(wizardResult(finished.state), {
		questions: "Welche Kamera?;Wo installiert?",
		save: "yes",
	});
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

/* ---------------- wizard: enabledIf skips steps (v27) ---------------- */
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
	// greyed out (v29: visibility never changes while navigating), never
	// blocks the finish and is absent from the result; the Enter-through
	// flow still skips it.
	let { state } = drive(initWizard(steps, { lang: "de" }), ["confirm"]); // empty text -> next enabled = save
	assert.equal(state.tab, 2);
	// (v30: a filled square means "carries a value" -- the empty text step
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
	// WITH a question the step exists again and gates the finish.
	let withQ = drive(initWizard(steps, { lang: "de" }), [{ kind: "input", chars: "Welche Kamera?" }, "confirm"]);
	assert.equal(withQ.state.tab, 1);
	withQ = drive(withQ.state, ["right", "confirm", "confirm"]); // skip detail, answer save, Absenden
	assert.equal(withQ.done, undefined);
	assert.equal(withQ.state.tab, 1); // the finish guard jumped to the open detail step
	withQ = drive(withQ.state, ["confirm", "confirm", "confirm"]); // answer detail -> save answered? save already yes -> submit -> Absenden
	assert.equal(withQ.done, "confirmed");
	assert.equal(wizardResult(withQ.state).detail, "per-paper");
	// A step-specific disabledNote wins over the generic reason (v29).
	const noted = initWizard([steps[0], { ...steps[1], disabledNote: "Braucht eine Frage." }, steps[2]], { lang: "de" });
	assert.ok(wizardView({ ...noted, tab: 1 }).rows[0].text.includes("Braucht eine Frage."));
}

/* -------- wizard: startTab submit + initialIsAnswer (v29.1) -------- */
{
	// The search intake pattern: open ON the review page, every step
	// pre-answered -- ONE Enter runs the proposal (old dialog parity).
	const steps: WizardStepDef[] = [
		{ kind: "text", id: "query", tab: "Suchanfrage", title: "Wonach suchen?", initial: "sandbar detection" },
		{
			kind: "choice", id: "depth", tab: "Tiefe", title: "Suchtiefe?",
			options: [{ value: "quick", label: "Schnell" }, { value: "custom", label: "Eigene Anzahl" }],
			initial: "quick", initialIsAnswer: true,
		},
		{
			kind: "text", id: "count", tab: "Anzahl", title: "Treffer je Quelle",
			initial: "5",
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
	assert.ok(wizardSummaryLines(opened).some((line) => line.includes("Tiefe: Schnell")));
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

/* ---------------- wizard: submit note (v27) ---------------- */
{
	const note = (answers: Record<string, unknown>): string | null =>
		typeof answers.summary === "string" ? `~${answers.summary === "none" ? 0 : 3} Modellaufruf(e)` : null;
	const state = initWizard(wizardSteps, { submitNote: note as never });
	// Unanswered summary -> no note line yet.
	assert.ok(!wizardView({ ...state, tab: 3 }).rows.some((row) => row.text.includes("Modellaufruf")));
	const answered = drive(state, ["up", "confirm", "confirm", "confirm"]); // commit docs, summary bullets, save yes -> submit
	assert.equal(answered.state.tab, 3);
	assert.ok(wizardView(answered.state).rows.some((row) => row.text.includes("~3 Modellaufruf(e)")));
	// The note counts one extra row in the constant footprint (v30.2
	// layout: 3 steps x 2 + note + warning slot + blank + 2 actions).
	assert.equal(maxWizardRows(state), 11);
}

/* ---------------- wizard: skipSubmit gates (v27) ---------------- */
{
	// A one-step question gate: Enter finishes DIRECTLY, no review page.
	const gate: WizardStepDef[] = [{
		kind: "text", id: "question", tab: "Frage", title: "Frage prüfen",
		initial: "welche kameras wurden verwendet?",
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

/* ---------------- wizard: dialog language (v27) ---------------- */
{
	// Detection: umlauts decide instantly; otherwise stopword scoring;
	// empty or tied input falls back (default ENGLISH since v30; German
	// callers pass their own fallback).
	assert.equal(detectDialogLang(["welche kameras wurden verwendet?"]), "de");
	assert.equal(detectDialogLang(["which cameras did they use?"]), "en");
	assert.equal(detectDialogLang(["über die Kalibrierung"]), "de");
	assert.equal(detectDialogLang(["what about the calibration of the sensors?"]), "en");
	assert.equal(detectDialogLang([""]), "en");
	assert.equal(detectDialogLang([""], "de"), "de");
	assert.equal(detectDialogLang([undefined], "en"), "en");
	// Explicit language names win over detection (the caller checks first).
	assert.equal(langFromName("German"), "de");
	assert.equal(langFromName("deutsch"), "de");
	assert.equal(langFromName("English"), "en");
	assert.equal(langFromName("French"), "en"); // dialog set has de/en only
	assert.equal(langFromName(undefined), undefined);
	// English wizard chrome: submit tab, hints and marks switch.
	const en = initWizard(wizardSteps, { lang: "en" });
	assert.equal(wizardView(en).hint, DIALOG_TEXT.en.hintCheckbox);
	assert.ok(wizardView(en).tabs.at(-1)?.label === "✓ Confirm");
	const enSubmit = wizardView({ ...en, tab: 3 });
	assert.equal(enSubmit.title, "Review your answers");
	assert.ok(enSubmit.rows.some((row) => row.text.includes("(open)")));
	assert.ok(enSubmit.rows.some((row) => row.warn && row.text.startsWith("⚠ Answer remaining")));
	assert.ok(enSubmit.rows.at(-2)?.text.includes("Submit"));
	// The default is ENGLISH (v30 user decision: no chat observed means
	// English dialogs); the German blocks above pass lang "de" explicitly.
	assert.equal(initWizard(wizardSteps).lang, "en");
}

/* -------- wizard: derived text, free-entry choice, form step (v30) -------- */
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
	assert.ok(wizardSummaryLines(state).some((line) => line === "Grouping: (sandbar) AND (rivers) AND (sentinel)"));
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
	const proposed = initWizard([steps[0], { ...steps[1], initial: "(x)" }]);
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
	assert.ok(wizardSummaryLines(custom.state).some((line) => line === "Count: 23"));
	// Empty custom input does not answer -- the finish guard keeps holding.
	const refused = drive(initWizard(steps), ["down", "down", "confirm"]);
	assert.equal(refused.done, undefined);
	assert.equal(refused.state.chosen[0], null);
	// An initial matching NO preset seeds the custom row (agent proposal 23).
	const seeded = initWizard([{ ...steps[0], initial: "23", initialIsAnswer: true }], { startTab: "submit" });
	assert.equal(seeded.texts[0], "23");
	assert.equal(seeded.cursors[0], 2); // cursor on the custom row
	const confirmed = drive(seeded, ["confirm"]);
	assert.equal(confirmed.done, "confirmed");
	assert.equal(wizardResult(confirmed.state).count, "23");
}

/* -------- wizard: option descriptions + seeded custom row (v30.2) -------- */
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
	// descriptionPlain renders the line white (v30.4: substance, not
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
	assert.ok(wizardSummaryLines(swappedDone.state).some((line) => line === "G: expr(water) -- Full match (strict)"));
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
	assert.ok(wizardSummaryLines(strict.state).some((line) => line === "Grouping: All concepts -- strict(a)"));
}

/* -------- wizard: optional checkbox + lazily loaded items (v30.7) -------- */
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
	assert.ok(wizardSummaryLines(drive(state, ["confirm"]).state).some((line) => line === "Journals: (none)"));
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
	assert.ok(wizardSummaryLines(empty.state).some((line) => line === "Filters: (none)"));
	// Typing edits the focused field; up/down move; the tab gains its mark.
	let { state } = drive(initWizard(steps), [{ kind: "input", chars: "10" }, "down", "down", { kind: "input", chars: "Remote Sensing" }]);
	assert.ok(wizardView(state).tabs[0].label.startsWith("■"));
	const rows = wizardView(state).rows;
	assert.equal(rows[0].text, "  Min. citations: 10");
	assert.equal(rows[2].text, "❯ Journals: Remote Sensing_");
	const done = drive(state, ["confirm", "confirm"]);
	assert.equal(done.done, "confirmed");
	assert.deepEqual(wizardResult(done.state), { min_cites: "10", min_score: "", venues: "Remote Sensing" });
	assert.ok(wizardSummaryLines(done.state).some((line) => line === "Filters: Min. citations 10 · Journals Remote Sensing"));
	// Enter on a FILLED non-last field moves down; on an empty one it leaves.
	const walked = drive(initWizard(steps), [{ kind: "input", chars: "3" }, "confirm"]);
	assert.equal(walked.state.tab, 0);
	assert.equal(walked.state.cursors[0], 1);
	const skipped = drive(walked.state, ["confirm"]); // field 2 empty -> out
	assert.equal(skipped.state.tab, 1);
}

console.log("dialog-state tests passed");
