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
	initCheckbox,
	initWizard,
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

function drive(state: WizardState, events: string[]): { state: WizardState; done?: string } {
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
	// incomplete -- the wizard jumps there instead of finishing.
	let { state, done } = drive(initWizard(wizardSteps), ["right", "right", "up", "confirm", "confirm"]);
	// (save answered "Nein" -> submit page -> Absenden)
	assert.equal(done, "confirmed"); // papers preselected + summary initial + save answered -> valid
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
	// Answered tabs carry a check mark: papers is preselected, summary has
	// an initial; the save step is still open.
	assert.deepEqual(view.tabs.map((tab) => [tab.label, tab.active]), [
		["Dokumente ✔", true], ["Zusammenfassung ✔", false], ["HTML", false], ["Bestätigen", false],
	]);
	assert.equal(view.rows.length, 5);
	assert.ok(view.rows[1].active && view.rows[1].text.startsWith("❯ 1. "));
	assert.ok(view.rows[4].text.includes("Weiter"));
	assert.ok(view.hint.includes("Weiter-Zeile"));
	({ state } = drive(state, ["right"]));
	view = wizardView(state);
	assert.ok(view.rows[1].text.includes("Bulletpoints ✔")); // initial shown as chosen
	assert.ok(view.hint.includes("Enter wählt"));
}

console.log("dialog-state tests passed");
