/**
 * Pure state machine for the Claude-Code-style dialogs (v25 E2c) -- no pi
 * imports, fully testable offline. The TUI/RPC adapters in
 * extensions/dialogs.ts only translate key strokes to reducer events and
 * lines to themed output; every decision lives here.
 *
 * The checkbox list is the document-scope intake (design 2026-07-21): a
 * "select all" row on top of the PDF list -- checking one paper means the
 * one-paper scope, several the selection, all of them the library. The
 * select-all row's own check mark is DERIVED from the items and never
 * stored, so items and the summary row can never disagree.
 */

export interface CheckboxItem {
	/** Stable identity returned by selection() (e.g. the PDF basename). */
	id: string;
	label: string;
}

export interface CheckboxState {
	items: CheckboxItem[];
	/** Cursor row: 0 = the select-all row, item i sits at row i + 1. */
	cursor: number;
	/** Selected item ids. */
	selected: ReadonlySet<string>;
}

export type CheckboxEvent = "up" | "down" | "toggle" | "confirm" | "cancel";

export interface CheckboxStep {
	state: CheckboxState;
	/** Set when the dialog is finished; absent while it stays open. */
	done?: "confirmed" | "cancelled";
}

export function initCheckbox(items: CheckboxItem[], preselected: string[] = []): CheckboxState {
	const known = new Set(items.map((item) => item.id));
	return {
		items,
		cursor: 0,
		selected: new Set(preselected.filter((id) => known.has(id))),
	};
}

export function allSelected(state: CheckboxState): boolean {
	return state.items.length > 0 && state.items.every((item) => state.selected.has(item.id));
}

/** Selected ids in ITEM order (never insertion order). */
export function selection(state: CheckboxState): string[] {
	return state.items.filter((item) => state.selected.has(item.id)).map((item) => item.id);
}

/**
 * One key stroke. Cursor wraps; space toggles (on the select-all row: all
 * on, or all off when everything was on); enter confirms -- but an EMPTY
 * selection is not confirmable (the stroke is ignored; the scope dialog
 * has no meaningful "nothing"); escape cancels.
 */
export function reduceCheckbox(state: CheckboxState, event: CheckboxEvent): CheckboxStep {
	const rows = state.items.length + 1;
	switch (event) {
		case "up":
			return { state: { ...state, cursor: (state.cursor + rows - 1) % rows } };
		case "down":
			return { state: { ...state, cursor: (state.cursor + 1) % rows } };
		case "toggle": {
			const selected = new Set(state.selected);
			if (state.cursor === 0) {
				if (allSelected(state)) selected.clear();
				else for (const item of state.items) selected.add(item.id);
			} else {
				const id = state.items[state.cursor - 1].id;
				if (selected.has(id)) selected.delete(id);
				else selected.add(id);
			}
			return { state: { ...state, selected } };
		}
		case "confirm":
			return state.selected.size ? { state, done: "confirmed" } : { state };
		case "cancel":
			return { state, done: "cancelled" };
	}
}

export interface CheckboxLine {
	text: string;
	/** True for the cursor row (the adapter highlights it). */
	active: boolean;
}

/** Deterministic row texts in the rpiv look: a select-all summary row on
 * top, then numbered items -- "❯ 1. [✔] label". Pure, so the exact wording
 * is pinned by offline tests; the adapters only add colors. */
export function checkboxLines(state: CheckboxState, selectAllLabel: string): CheckboxLine[] {
	const mark = (checked: boolean): string => (checked ? "[✔]" : "[ ]");
	const width = String(state.items.length).length;
	const lines: CheckboxLine[] = [{
		text: `${state.cursor === 0 ? "❯ " : "  "}   ${mark(allSelected(state))} ${selectAllLabel}`,
		active: state.cursor === 0,
	}];
	state.items.forEach((item, i) => {
		const active = state.cursor === i + 1;
		lines.push({
			text: `${active ? "❯ " : "  "}${String(i + 1).padStart(width)}. ${mark(state.selected.has(item.id))} ${item.label}`,
			active,
		});
	});
	return lines;
}

/* ------------------------------------------------------------------ *
 * Wizard -- ONE questionnaire over several steps (rpiv semantics)      *
 * ------------------------------------------------------------------ */

/**
 * The E2c field test verdict (2026-07-22) drove this layer: a CHAIN of
 * separate dialogs jumped around the screen, had no way back, and Enter
 * committed the multi-select prematurely. rpiv solves all three with ONE
 * dialog holding every question as a tab -- so does this wizard:
 *   - Tab/RIGHT and Shift-Tab/LEFT move between steps (wrapping); answers
 *     are kept, so going back is free.
 *   - In a checkbox step, Space AND Enter toggle the focused row; the step
 *     commits only on the explicit next-row (rpiv's "Next" sentinel).
 *   - A choice step answers with Enter and auto-advances.
 *   - Finishing (advancing past the LAST step) is guarded: an unanswered
 *     choice or an empty required checkbox selection jumps there instead.
 *   - Esc cancels the whole wizard, from any step.
 * The adapter keeps the overlay footprint constant via maxWizardRows.
 */

export interface WizardChoiceOption {
	value: string;
	label: string;
}

export type WizardStepDef =
	| {
		kind: "checkbox";
		id: string;
		/** Short label for the tab bar. */
		tab: string;
		title: string;
		items: CheckboxItem[];
		selectAllLabel: string;
		/** Label of the explicit commit row ("Weiter"/"Fertig"). */
		nextLabel: string;
		preselected?: string[];
	}
	| {
		kind: "choice";
		id: string;
		tab: string;
		title: string;
		options: WizardChoiceOption[];
		/** RECOMMENDED option: the cursor starts here, but the step counts
		 * as answered only after an explicit Enter (field decision
		 * 2026-07-22: a recommendation must never silently be an answer). */
		initial?: string;
	};

export interface WizardState {
	steps: WizardStepDef[];
	/** Current tab index; steps.length is the final SUBMIT tab (summary +
	 * Absenden/Abbrechen, the rpiv review page). */
	tab: number;
	/** Per-tab cursor rows (the submit tab's cursor is 0 or 1). */
	cursors: number[];
	/** Per-step checkbox selections (empty sets on choice steps). */
	selected: Array<Set<string>>;
	/** Per-step choice answers (null on checkbox steps and while unanswered). */
	chosen: Array<string | null>;
}

/** Labels of the synthetic submit tab -- exported so the fallback loop and
 * tests speak the same words. */
export const SUBMIT_TAB_LABEL = "Bestätigen";
export const SUBMIT_TITLE = "Bereit zum Absenden?";
export const SUBMIT_ROW = "Absenden";
export const SUBMIT_CANCEL_ROW = "Abbrechen";
export const UNANSWERED_MARK = "(offen)";

export type WizardEvent = "up" | "down" | "left" | "right" | "toggle" | "confirm" | "cancel";

export interface WizardStep {
	state: WizardState;
	done?: "confirmed" | "cancelled";
}

/** Answers by step id: checkbox steps map to id arrays, choices to values. */
export type WizardResult = Record<string, string[] | string>;

export function initWizard(steps: WizardStepDef[]): WizardState {
	if (!steps.length) throw new Error("wizard needs at least one step");
	return {
		steps,
		tab: 0,
		cursors: [...steps.map((step) => step.kind === "choice"
			? Math.max(0, step.options.findIndex((option) => option.value === step.initial))
			: 0), 0],
		selected: steps.map((step) => {
			if (step.kind !== "checkbox") return new Set<string>();
			const known = new Set(step.items.map((item) => item.id));
			return new Set((step.preselected ?? []).filter((id) => known.has(id)));
		}),
		// initial is a cursor recommendation, never a pre-answer.
		chosen: steps.map(() => null),
	};
}

function rowCount(step: WizardStepDef): number {
	return step.kind === "checkbox" ? step.items.length + 2 : step.options.length;
}

/** Rendered body rows of the submit tab: one summary line per step, a
 * blank separator, then the two actionable rows. */
function submitRowCount(state: WizardState): number {
	return state.steps.length + 3;
}

/** Worst-case row count across all tabs (submit tab included) -- the
 * adapter pads every render to this so the overlay never changes height
 * (the E2c layout-jump fix). */
export function maxWizardRows(state: WizardState): number {
	return Math.max(...state.steps.map(rowCount), submitRowCount(state));
}

function wrap(value: number, total: number): number {
	return ((value % total) + total) % total;
}

function stepInvalid(state: WizardState, index: number): boolean {
	const step = state.steps[index];
	return step.kind === "checkbox" ? state.selected[index].size === 0 : state.chosen[index] === null;
}

/** Advance from the current step; the last step leads to the SUBMIT tab
 * (never straight to done -- the user reviews first, field wish
 * 2026-07-22). */
function advance(state: WizardState): WizardStep {
	return { state: { ...state, tab: state.tab + 1 } };
}

/** Finishing (Enter on Absenden): an incomplete step wins over the submit
 * -- the wizard jumps there instead. */
function finish(state: WizardState): WizardStep {
	for (let i = 0; i < state.steps.length; i++) {
		if (stepInvalid(state, i)) return { state: { ...state, tab: i } };
	}
	return { state, done: "confirmed" };
}

export function reduceWizard(state: WizardState, event: WizardEvent): WizardStep {
	const totalTabs = state.steps.length + 1;
	const cursor = state.cursors[state.tab];
	const withCursorAt = (next: number): WizardState => ({
		...state,
		cursors: state.cursors.map((value, i) => (i === state.tab ? next : value)),
	});
	// The synthetic submit tab: two actionable rows, Enter decides.
	if (state.tab === state.steps.length) {
		switch (event) {
			case "cancel":
				return { state, done: "cancelled" };
			case "left":
				return { state: { ...state, tab: wrap(state.tab - 1, totalTabs) } };
			case "right":
				return { state: { ...state, tab: wrap(state.tab + 1, totalTabs) } };
			case "up":
			case "down":
				return { state: withCursorAt(cursor === 0 ? 1 : 0) };
			case "toggle":
				return { state };
			case "confirm":
				return cursor === 0 ? finish(state) : { state, done: "cancelled" };
		}
	}
	const step = state.steps[state.tab];
	const rows = rowCount(step);
	const withCursor = withCursorAt;
	const toggled = (): WizardState => {
		if (step.kind !== "checkbox" || cursor === rows - 1) return state; // next row has no check state
		const selected = new Set(state.selected[state.tab]);
		if (cursor === 0) {
			if (step.items.every((item) => selected.has(item.id)) && step.items.length) selected.clear();
			else for (const item of step.items) selected.add(item.id);
		} else {
			const id = step.items[cursor - 1].id;
			if (selected.has(id)) selected.delete(id);
			else selected.add(id);
		}
		return { ...state, selected: state.selected.map((set, i) => (i === state.tab ? selected : set)) };
	};
	switch (event) {
		case "cancel":
			return { state, done: "cancelled" };
		case "up":
			return { state: withCursor(wrap(cursor - 1, rows)) };
		case "down":
			return { state: withCursor(wrap(cursor + 1, rows)) };
		case "left":
			return { state: { ...state, tab: wrap(state.tab - 1, totalTabs) } };
		case "right":
			return { state: { ...state, tab: wrap(state.tab + 1, totalTabs) } };
		case "toggle":
			return { state: toggled() };
		case "confirm": {
			if (step.kind === "checkbox") {
				// Enter toggles like Space on real rows; only the explicit
				// next-row commits (rpiv rule -- the E2c field complaint).
				if (cursor < rows - 1) return { state: toggled() };
				if (state.selected[state.tab].size === 0) return { state }; // nothing selected, nothing to commit
				return advance(state);
			}
			const value = step.options[cursor]?.value;
			if (value === undefined) return { state };
			return advance({
				...state,
				chosen: state.chosen.map((prev, i) => (i === state.tab ? value : prev)),
			});
		}
	}
}

export function wizardResult(state: WizardState): WizardResult {
	const result: WizardResult = {};
	state.steps.forEach((step, i) => {
		if (step.kind === "checkbox") {
			result[step.id] = step.items.filter((item) => state.selected[i].has(item.id)).map((item) => item.id);
		} else {
			// The finish guard means chosen is set on confirmed wizards; the
			// fallbacks only serve direct wizardResult calls in tests.
			result[step.id] = state.chosen[i] ?? step.initial ?? step.options[0].value;
		}
	});
	return result;
}

export interface WizardViewRow {
	text: string;
	active: boolean;
}

export interface WizardView {
	/** Tab bar entries in step order. */
	tabs: Array<{ label: string; active: boolean }>;
	title: string;
	rows: WizardViewRow[];
	/** Key hint matching the current step kind. */
	hint: string;
}

/** One summary line per step for the submit page -- also used by the
 * fallback loop. */
export function wizardSummaryLines(state: WizardState): string[] {
	return state.steps.map((step, i) => {
		if (step.kind === "checkbox") {
			const chosen = step.items.filter((item) => state.selected[i].has(item.id));
			const all = chosen.length === step.items.length && step.items.length > 0;
			const value = chosen.length === 0 ? UNANSWERED_MARK
				: all ? `${step.selectAllLabel} (${chosen.length})`
				: chosen.map((item) => item.label).join(", ");
			return `${step.tab}: ${value}`;
		}
		const chosen = step.options.find((option) => option.value === state.chosen[i]);
		return `${step.tab}: ${chosen ? chosen.label : UNANSWERED_MARK}`;
	});
}

/** Pure presentation of the current tab; the adapter only adds colors,
 * borders and the constant-height padding. */
export function wizardView(state: WizardState): WizardView {
	// Answered steps carry a check mark in the tab bar (field wish
	// 2026-07-22); the submit tab itself never does.
	const tabs = [
		...state.steps.map((other, i) => ({
			label: `${other.tab}${stepInvalid(state, i) ? "" : " ✔"}`,
			active: i === state.tab,
		})),
		{ label: SUBMIT_TAB_LABEL, active: state.tab === state.steps.length },
	];
	if (state.tab === state.steps.length) {
		const cursor = state.cursors[state.tab];
		const rows: WizardViewRow[] = [
			...wizardSummaryLines(state).map((line) => ({ text: `     ${line}`, active: false })),
			{ text: "", active: false },
			{ text: `${cursor === 0 ? "❯ " : "  "}   ${SUBMIT_ROW}`, active: cursor === 0 },
			{ text: `${cursor === 1 ? "❯ " : "  "}   ${SUBMIT_CANCEL_ROW}`, active: cursor === 1 },
		];
		return {
			tabs,
			title: SUBMIT_TITLE,
			rows,
			hint: "Enter bestätigt · ←/→ Schritt · Esc abbrechen",
		};
	}
	const step = state.steps[state.tab];
	const cursor = state.cursors[state.tab];
	const rows: WizardViewRow[] = [];
	if (step.kind === "checkbox") {
		const checkboxState: CheckboxState = {
			items: step.items,
			cursor,
			selected: state.selected[state.tab],
		};
		rows.push(...checkboxLines(checkboxState, step.selectAllLabel));
		const nextActive = cursor === step.items.length + 1;
		rows.push({ text: `${nextActive ? "❯ " : "  "}   ${step.nextLabel}`, active: nextActive });
	} else {
		const width = String(step.options.length).length;
		step.options.forEach((option, i) => {
			const active = cursor === i;
			const chosen = state.chosen[state.tab] === option.value ? " ✔" : "";
			rows.push({ text: `${active ? "❯ " : "  "}${String(i + 1).padStart(width)}. ${option.label}${chosen}`, active });
		});
	}
	return {
		tabs,
		title: step.title,
		rows,
		hint: step.kind === "checkbox"
			? "Space/Enter auswählen · Enter auf der Weiter-Zeile bestätigt · ←/→ Schritt · Esc abbrechen"
			: "Enter wählt und geht weiter · ←/→ Schritt · Esc abbrechen",
	};
}

/**
 * One question per line (the questions intake, v25). Blank lines vanish;
 * leading list bullets people habitually type ("- ", "* ", "1. ") are
 * stripped; order and wording stay untouched otherwise.
 */
export function parseQuestionLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim().replace(/^(?:[-*•]|\d{1,2}[.)])(?:\s+|$)/, "").trim())
		.filter(Boolean);
}
