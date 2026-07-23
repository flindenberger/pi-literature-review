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
	decisiveDialogLang,
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
	// Stable footprint: the submit page (3 summary lines + blank + 2 rows)
	// is the tallest tab here.
	assert.equal(maxWizardRows(state), 6);
}

{
	// Enter on a checkbox ROW toggles (the E2c field complaint: it must NOT
	// commit); only the next-row commits and advances.
	let { state } = drive(initWizard(wizardSteps), ["down", "confirm"]);
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
	// Enter on Absenden finishes; the summary shows every answer.
	const view = wizardView(reviewed.state);
	assert.ok(view.rows.some((row) => row.text.includes("Zusammenfassung: Fließtext")));
	assert.ok(view.rows.some((row) => row.text.includes("HTML: Ja")));
	assert.ok(view.rows.at(-2)?.active && view.rows.at(-2)?.text.includes("Absenden"));
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
	({ state, done } = drive(initWizard(bare), ["right", "right", "right", "confirm"]));
	assert.equal(done, undefined);
	assert.equal(state.tab, 0); // jumped from the submit page to the incomplete step
	assert.ok(wizardView({ ...state, tab: 3 }).rows[0].text.includes("(offen)")); // the summary is honest about it
	// Esc cancels from anywhere.
	assert.equal(reduceWizard(initWizard(wizardSteps), "cancel").done, "cancelled");
	// Enter on the next-row with an EMPTY selection commits nothing.
	const stuck = drive(initWizard(bare), ["up", "confirm"]); // cursor wraps to the next-row
	assert.equal(stuck.done, undefined);
	assert.equal(stuck.state.tab, 0);
}

{
	// View: tab bar, active row marker, chosen mark, per-kind hint.
	let { state } = drive(initWizard(wizardSteps), ["down"]);
	let view = wizardView(state);
	// Answered tabs carry a check mark: papers is preselected (a REAL prior
	// answer -- the sticky scope); the summary's initial is only a cursor
	// recommendation and stays open, like the save step.
	assert.deepEqual(view.tabs.map((tab) => [tab.label, tab.active]), [
		["Dokumente ✔", true], ["Zusammenfassung", false], ["HTML", false], ["Bestätigen", false],
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
	let { state } = drive(initWizard(steps), [
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
	const empty = drive(initWizard(steps), ["confirm", "confirm", "confirm"]);
	assert.equal(empty.done, "confirmed");
	assert.equal(wizardResult(empty.state).questions, "");
	// The placeholder shows while empty; the summary says "(keine)".
	view = wizardView(initWizard(steps));
	assert.ok(view.rows[1].text.includes("leer = chatten"));
	assert.ok(wizardView({ ...empty.state, tab: 2 }).rows[0].text.includes("Fragen: (keine)"));
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
	// Without questions the detail tab is skipped in BOTH directions, leaves
	// the tab bar, never blocks the finish and is absent from the result.
	let { state } = drive(initWizard(steps), ["confirm"]); // empty text -> next enabled = save
	assert.equal(state.tab, 2);
	// (a text step is always answered -- empty is valid -- hence its mark)
	assert.deepEqual(wizardView(state).tabs.map((tab) => tab.label.trim()), ["Fragen ✔", "HTML", "Bestätigen"]);
	({ state } = drive(state, ["left"]));
	assert.equal(state.tab, 0); // back skips the disabled step too
	const finished = drive(state, ["confirm", "confirm", "confirm"]); // save "yes" -> submit -> Absenden
	assert.equal(finished.done, "confirmed");
	assert.deepEqual(wizardResult(finished.state), { questions: "", save: "yes" });
	// WITH a question the step exists again and gates the finish.
	let withQ = drive(initWizard(steps), [{ kind: "input", chars: "Welche Kamera?" }, "confirm"]);
	assert.equal(withQ.state.tab, 1);
	withQ = drive(withQ.state, ["right", "confirm", "confirm"]); // skip detail, answer save, Absenden
	assert.equal(withQ.done, undefined);
	assert.equal(withQ.state.tab, 1); // the finish guard jumped to the open detail step
	withQ = drive(withQ.state, ["confirm", "confirm", "confirm"]); // answer detail -> save answered? save already yes -> submit -> Absenden
	assert.equal(withQ.done, "confirmed");
	assert.equal(wizardResult(withQ.state).detail, "per-paper");
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
	// The note counts one extra row in the constant footprint.
	assert.equal(maxWizardRows(state), 7);
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
	// empty or tied input falls back (default German).
	assert.equal(detectDialogLang(["welche kameras wurden verwendet?"]), "de");
	assert.equal(detectDialogLang(["which cameras did they use?"]), "en");
	assert.equal(detectDialogLang(["über die Kalibrierung"]), "de");
	assert.equal(detectDialogLang(["what about the calibration of the sensors?"]), "en");
	assert.equal(detectDialogLang([""]), "de");
	assert.equal(detectDialogLang([undefined], "en"), "en");
	// Umlauts are strong evidence, not an instant verdict (field sentence
	// v27: an English sentence with one German word stays English).
	assert.equal(detectDialogLang(["he dödel, i want to chat abot a paper"]), "en");
	assert.equal(detectDialogLang(["he ich würde gern über ein paper reden"]), "de");
	// Decisive detection: real signal or null (the session walker skips
	// neutral lines like "ok").
	assert.equal(decisiveDialogLang("welche kameras wurden verwendet?"), "de");
	assert.equal(decisiveDialogLang("i want to chat about a paper"), "en");
	assert.equal(decisiveDialogLang("ok"), null);
	assert.equal(decisiveDialogLang("quiero hablar de un paper"), null);
	// Explicit language names win over detection (the caller checks first).
	assert.equal(langFromName("German"), "de");
	assert.equal(langFromName("deutsch"), "de");
	assert.equal(langFromName("English"), "en");
	assert.equal(langFromName("French"), "en"); // dialog set has de/en only
	assert.equal(langFromName(undefined), undefined);
	// English wizard chrome: submit tab, hints and marks switch.
	const en = initWizard(wizardSteps, { lang: "en" });
	assert.equal(wizardView(en).hint, DIALOG_TEXT.en.hintCheckbox);
	assert.ok(wizardView(en).tabs.at(-1)?.label === "Confirm");
	const enSubmit = wizardView({ ...en, tab: 3 });
	assert.equal(enSubmit.title, "Ready to submit?");
	assert.ok(enSubmit.rows.some((row) => row.text.includes("(open)")));
	assert.ok(enSubmit.rows.at(-2)?.text.includes("Submit"));
	// Default stays German (existing tests above pin the wording).
	assert.equal(initWizard(wizardSteps).lang, "de");
}

console.log("dialog-state tests passed");
