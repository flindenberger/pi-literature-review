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

/**
 * Partial answers DURING a run, fed to enabledIf and the submit note:
 * checkbox -> current selection (item order), choice -> chosen value or
 * null while unanswered, text -> current text.
 */
export type WizardAnswers = Record<string, string[] | string | null>;

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
		/** Step applies only while this holds over the current answers (v27:
		 * the detail-mode tab applies only with >= 2 documents AND >= 1
		 * question). v29: a disabled step STAYS in the tab bar greyed out
		 * (a tab's visibility must not change while navigating) and can be
		 * visited -- it shows disabledNote instead of its rows -- but it
		 * never blocks the finish and is absent from summary and result. */
		enabledIf?: (answers: WizardAnswers) => boolean;
		/** One-line reason shown when the step is disabled (v29: grey out
		 * with a reason instead of hiding). Falls back to a generic line. */
		disabledNote?: string;
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
		/** Opt-out of the rule above (v29.1): the initial IS the answer.
		 * For proposal-confirm intakes (the search wizard opens on its
		 * submit page; every step already carries the proposed value, and
		 * one Enter runs it -- the old "Run as proposed" ergonomics). */
		initialIsAnswer?: boolean;
		enabledIf?: (answers: WizardAnswers) => boolean;
		disabledNote?: string;
	}
	| {
		/** Single-line free-text input (v27: the questions intake joined the
		 * ONE wizard). Typing appends, backspace deletes, Enter commits --
		 * an EMPTY text is a valid answer (= "no questions"). Pasted
		 * newlines become semicolons (the question separator). */
		kind: "text";
		id: string;
		tab: string;
		title: string;
		/** Shown dim under the input while it is empty. */
		placeholder?: string;
		initial?: string;
		enabledIf?: (answers: WizardAnswers) => boolean;
		disabledNote?: string;
	};

export interface WizardState {
	steps: WizardStepDef[];
	/** Current tab index; steps.length is the final SUBMIT tab (summary +
	 * Absenden/Abbrechen, the rpiv review page). */
	tab: number;
	/** Per-tab cursor rows (the submit tab's cursor is 0 or 1). */
	cursors: number[];
	/** Per-step checkbox selections (empty sets on other steps). */
	selected: Array<Set<string>>;
	/** Per-step choice answers (null on non-choice steps and while unanswered). */
	chosen: Array<string | null>;
	/** Per-step text values ("" on non-text steps). */
	texts: string[];
	/** Optional computed line on the submit page (e.g. "~6 Modellaufrufe");
	 * pure function of the answers, injected by the caller. */
	submitNote?: (answers: WizardAnswers) => string | null;
	/** True: advancing past the last step finishes DIRECTLY (no submit
	 * page). For lightweight gates like the per-question confirm (v27) --
	 * the finish guard still jumps to incomplete steps first. */
	skipSubmit?: boolean;
	/** Dialog language of the pure-layer strings; default "de". */
	lang: DialogLang;
}

export interface WizardOptions {
	submitNote?: (answers: WizardAnswers) => string | null;
	skipSubmit?: boolean;
	/** "submit": open ON the review page (v29.1 proposal-confirm intakes --
	 * one Enter runs the proposal, arrows walk into the tabs to adjust).
	 * Pair with initialIsAnswer on choice steps, else the finish guard
	 * jumps to the unanswered step. */
	startTab?: "submit";
	/** Dialog language; default "de" (v27: follow the chat's language). */
	lang?: DialogLang;
}

/**
 * Dialog language (v27 user decision: the dialogs follow the CHAT's
 * language instead of always speaking German). Two languages by design --
 * German default, English for English chats; any other named language
 * gets the international default.
 */
export type DialogLang = "de" | "en";

/** Every string the pure dialog layer renders, per language; the adapters
 * source their own few strings from the same principle. */
export const DIALOG_TEXT: Record<DialogLang, {
	submitTab: string;
	submitTitle: string;
	submitRow: string;
	submitCancelRow: string;
	unanswered: string;
	noQuestions: string;
	questionsDetected: (n: number) => string;
	hintSubmit: string;
	hintCheckbox: string;
	hintText: string;
	hintChoice: string;
	disabledDefault: string;
	hintDisabled: string;
}> = {
	de: {
		submitTab: "Bestätigen",
		submitTitle: "Bereit zum Absenden?",
		submitRow: "Absenden",
		submitCancelRow: "Abbrechen",
		unanswered: "(offen)",
		noQuestions: "(keine)",
		questionsDetected: (n) => `${n} Frage(n) erkannt`,
		hintSubmit: "Enter bestätigt · ←/→ Schritt · Esc abbrechen",
		hintCheckbox: "Space/Enter auswählen · Enter auf der Weiter-Zeile bestätigt · ←/→ Schritt · Esc abbrechen",
		hintText: "Tippen · Semikolon trennt Fragen · Enter übernimmt · ←/→ Schritt · Esc abbrechen",
		hintChoice: "Enter wählt und geht weiter · ←/→ Schritt · Esc abbrechen",
		disabledDefault: "Dieser Schritt ist bei den aktuellen Antworten nicht relevant.",
		hintDisabled: "Enter geht weiter · ←/→ Schritt · Esc abbrechen",
	},
	en: {
		submitTab: "Confirm",
		submitTitle: "Ready to submit?",
		submitRow: "Submit",
		submitCancelRow: "Cancel",
		unanswered: "(open)",
		noQuestions: "(none)",
		questionsDetected: (n) => `${n} question(s) recognized`,
		hintSubmit: "Enter confirms · ←/→ step · Esc cancels",
		hintCheckbox: "Space/Enter selects · Enter on the Next row confirms · ←/→ step · Esc cancels",
		hintText: "Type · semicolons separate questions · Enter confirms · ←/→ step · Esc cancels",
		hintChoice: "Enter picks and advances · ←/→ step · Esc cancels",
		disabledDefault: "This step does not apply with the current answers.",
		hintDisabled: "Enter advances · ←/→ step · Esc cancels",
	},
};

/** German/English detection over free chat text -- deterministic stopword
 * scoring, umlauts decide instantly; empty or tied input falls back
 * (default: German, the project's home language). Pure. */
export function detectDialogLang(texts: Array<string | undefined>, fallback: DialogLang = "de"): DialogLang {
	const joined = texts.filter(Boolean).join(" ").toLowerCase();
	if (!joined.trim()) return fallback;
	if (/[äöüß]/.test(joined)) return "de";
	const german = new Set([
		"der", "die", "das", "und", "oder", "nicht", "ein", "eine", "ist", "sind", "wurde", "wurden",
		"werden", "wie", "wo", "wer", "welche", "welcher", "welches", "mit", "von", "im", "am", "zum",
		"zur", "bei", "aus", "auch", "bitte", "mir", "mal", "noch", "gibt", "es", "sie", "ich", "wir",
		"dazu", "diese", "dieses", "kannst", "mich", "gerne", "gern",
	]);
	const english = new Set([
		"the", "and", "or", "not", "a", "an", "is", "are", "was", "were", "be", "how", "where", "what",
		"who", "which", "for", "with", "of", "in", "on", "at", "about", "from", "do", "does", "did",
		"they", "you", "we", "it", "this", "that", "use", "used", "please", "me", "can", "could", "tell",
	]);
	let germanHits = 0;
	let englishHits = 0;
	for (const word of joined.split(/[^a-z]+/).filter(Boolean)) {
		if (german.has(word)) germanHits++;
		if (english.has(word)) englishHits++;
	}
	if (germanHits === englishHits) return fallback;
	return germanHits > englishHits ? "de" : "en";
}

/** Map an explicit language name (the tool's `language` param, e.g.
 * "German", "english", "de") to a dialog language; undefined when nothing
 * was named. Unknown named languages get the international default. */
export function langFromName(value: string | undefined): DialogLang | undefined {
	const token = value?.trim().toLowerCase();
	if (!token) return undefined;
	if (["de", "deutsch", "german"].includes(token)) return "de";
	return "en";
}

/** Labels of the synthetic submit tab -- the GERMAN defaults, kept as
 * named constants for existing callers/tests; language-aware code reads
 * DIALOG_TEXT instead. */
export const SUBMIT_TAB_LABEL = DIALOG_TEXT.de.submitTab;
export const SUBMIT_TITLE = DIALOG_TEXT.de.submitTitle;
export const SUBMIT_ROW = DIALOG_TEXT.de.submitRow;
export const SUBMIT_CANCEL_ROW = DIALOG_TEXT.de.submitCancelRow;
export const UNANSWERED_MARK = DIALOG_TEXT.de.unanswered;

export type WizardEvent =
	| "up" | "down" | "left" | "right" | "toggle" | "confirm" | "cancel"
	/** Backspace in a text step (ignored elsewhere). */
	| "backspace"
	/** Typed/pasted characters for a text step (ignored elsewhere). */
	| { kind: "input"; chars: string };

export interface WizardStep {
	state: WizardState;
	done?: "confirmed" | "cancelled";
}

/** Answers by step id: checkbox steps map to id arrays, choices to values. */
export type WizardResult = Record<string, string[] | string>;

export function initWizard(steps: WizardStepDef[], options?: WizardOptions): WizardState {
	if (!steps.length) throw new Error("wizard needs at least one step");
	return {
		steps,
		tab: options?.startTab === "submit" ? steps.length : 0,
		cursors: [...steps.map((step) => step.kind === "choice"
			? Math.max(0, step.options.findIndex((option) => option.value === step.initial))
			: 0), 0],
		selected: steps.map((step) => {
			if (step.kind !== "checkbox") return new Set<string>();
			const known = new Set(step.items.map((item) => item.id));
			return new Set((step.preselected ?? []).filter((id) => known.has(id)));
		}),
		// initial is a cursor recommendation, never a pre-answer -- unless
		// the step opts out via initialIsAnswer (proposal-confirm intakes).
		chosen: steps.map((step) =>
			(step.kind === "choice" && step.initialIsAnswer && step.initial !== undefined ? step.initial : null)),
		texts: steps.map((step) => (step.kind === "text" ? step.initial ?? "" : "")),
		...(options?.submitNote ? { submitNote: options.submitNote } : {}),
		...(options?.skipSubmit ? { skipSubmit: true } : {}),
		lang: options?.lang ?? "de",
	};
}

function rowCount(step: WizardStepDef): number {
	return step.kind === "checkbox" ? step.items.length + 2
		: step.kind === "text" ? 2 // input line + count/placeholder line
		: step.options.length;
}

/** Rendered body rows of the submit tab: one summary line per step, an
 * optional note line, a blank separator, then the two actionable rows. */
function submitRowCount(state: WizardState): number {
	return state.steps.length + 3 + (state.submitNote ? 1 : 0);
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

/** The current answers as enabledIf and the submit note see them. */
export function wizardAnswers(state: WizardState): WizardAnswers {
	const answers: WizardAnswers = {};
	state.steps.forEach((step, i) => {
		answers[step.id] = step.kind === "checkbox"
			? step.items.filter((item) => state.selected[i].has(item.id)).map((item) => item.id)
			: step.kind === "text" ? state.texts[i]
			: state.chosen[i];
	});
	return answers;
}

/** Whether the step currently exists (enabledIf over the live answers). */
export function stepEnabled(state: WizardState, index: number): boolean {
	const step = state.steps[index];
	return step.enabledIf ? step.enabledIf(wizardAnswers(state)) : true;
}

function stepInvalid(state: WizardState, index: number): boolean {
	const step = state.steps[index];
	if (!stepEnabled(state, index)) return false; // disabled steps never block
	return step.kind === "checkbox" ? state.selected[index].size === 0
		: step.kind === "text" ? false // empty text is a valid answer
		: state.chosen[index] === null;
}

/** Next tab in the given direction. v29: disabled steps stay VISITABLE
 * (they render their reason line) -- only advance() skips them, so the
 * Enter-through flow never stops on one. */
function movedTab(state: WizardState, dir: 1 | -1): number {
	return wrap(state.tab + dir, state.steps.length + 1);
}

/** Advance from the current step; the last enabled step leads to the
 * SUBMIT tab (never straight to done -- the user reviews first, field
 * wish 2026-07-22) -- unless skipSubmit is set (lightweight gates),
 * where it finishes directly through the same completeness guard. */
function advance(state: WizardState): WizardStep {
	let tab = state.tab;
	do {
		tab++;
	} while (tab < state.steps.length && !stepEnabled(state, tab));
	if (tab === state.steps.length && state.skipSubmit) return finish(state);
	return { state: { ...state, tab } };
}

/** Finishing (Enter on Absenden): an incomplete ENABLED step wins over the
 * submit -- the wizard jumps there instead. */
function finish(state: WizardState): WizardStep {
	for (let i = 0; i < state.steps.length; i++) {
		if (stepInvalid(state, i)) return { state: { ...state, tab: i } };
	}
	return { state, done: "confirmed" };
}

/** Control characters never enter a text value; pasted newlines become the
 * question separator. */
function sanitizeInput(chars: string): string {
	return chars.replace(/\r\n?|\n/g, ";").replace(/[\u0000-\u001f\u007f]/g, "");
}

export function reduceWizard(state: WizardState, event: WizardEvent): WizardStep {
	const cursor = state.cursors[state.tab];
	const withCursorAt = (next: number): WizardState => ({
		...state,
		cursors: state.cursors.map((value, i) => (i === state.tab ? next : value)),
	});
	const onText = state.tab < state.steps.length
		&& state.steps[state.tab].kind === "text"
		&& stepEnabled(state, state.tab);
	const withText = (value: string): WizardState => ({
		...state,
		texts: state.texts.map((prev, i) => (i === state.tab ? value : prev)),
	});
	// Typed characters and backspace only ever edit a text step.
	if (typeof event === "object") {
		if (!onText) return { state };
		const chars = sanitizeInput(event.chars);
		return chars ? { state: withText(state.texts[state.tab] + chars) } : { state };
	}
	if (event === "backspace") {
		return onText ? { state: withText(state.texts[state.tab].slice(0, -1)) } : { state };
	}
	// The synthetic submit tab: two actionable rows, Enter decides.
	if (state.tab === state.steps.length) {
		switch (event) {
			case "cancel":
				return { state, done: "cancelled" };
			case "left":
				return { state: { ...state, tab: movedTab(state, -1) } };
			case "right":
				return { state: { ...state, tab: movedTab(state, 1) } };
			case "up":
			case "down":
				return { state: withCursorAt(cursor === 0 ? 1 : 0) };
			case "toggle":
				return { state };
			case "confirm":
				return cursor === 0 ? finish(state) : { state, done: "cancelled" };
		}
	}
	// A visited DISABLED step (v29): only navigation works; Enter advances
	// through the same skip logic as everywhere else.
	if (!stepEnabled(state, state.tab)) {
		switch (event) {
			case "cancel":
				return { state, done: "cancelled" };
			case "left":
				return { state: { ...state, tab: movedTab(state, -1) } };
			case "right":
				return { state: { ...state, tab: movedTab(state, 1) } };
			case "confirm":
				return advance(state);
			default:
				return { state };
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
			return onText ? { state } : { state: withCursor(wrap(cursor - 1, rows)) };
		case "down":
			return onText ? { state } : { state: withCursor(wrap(cursor + 1, rows)) };
		case "left":
			return { state: { ...state, tab: movedTab(state, -1) } };
		case "right":
			return { state: { ...state, tab: movedTab(state, 1) } };
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
			if (step.kind === "text") {
				return advance(state); // empty text is a valid answer
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

/** Answers of the ENABLED steps only -- a step disabled at submit time
 * (e.g. the detail mode with one document) does not appear at all. */
export function wizardResult(state: WizardState): WizardResult {
	const result: WizardResult = {};
	state.steps.forEach((step, i) => {
		if (!stepEnabled(state, i)) return;
		if (step.kind === "checkbox") {
			result[step.id] = step.items.filter((item) => state.selected[i].has(item.id)).map((item) => item.id);
		} else if (step.kind === "text") {
			result[step.id] = state.texts[i];
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
	/** Tab bar entries in step order; disabled tabs stay listed (v29) and
	 * the adapter greys them out. */
	tabs: Array<{ label: string; active: boolean; disabled?: boolean }>;
	title: string;
	rows: WizardViewRow[];
	/** Key hint matching the current step kind. */
	hint: string;
}

/** One summary line per ENABLED step for the submit page -- also used by
 * the fallback loop. */
export function wizardSummaryLines(state: WizardState): string[] {
	const text = DIALOG_TEXT[state.lang];
	const lines: string[] = [];
	state.steps.forEach((step, i) => {
		if (!stepEnabled(state, i)) return;
		if (step.kind === "checkbox") {
			const chosen = step.items.filter((item) => state.selected[i].has(item.id));
			const all = chosen.length === step.items.length && step.items.length > 0;
			const value = chosen.length === 0 ? text.unanswered
				: all ? `${step.selectAllLabel} (${chosen.length})`
				: chosen.map((item) => item.label).join(", ");
			lines.push(`${step.tab}: ${value}`);
		} else if (step.kind === "text") {
			const questions = parseQuestionLines(state.texts[i]);
			lines.push(`${step.tab}: ${questions.length ? questions.join(" · ") : text.noQuestions}`);
		} else {
			const chosen = step.options.find((option) => option.value === state.chosen[i]);
			lines.push(`${step.tab}: ${chosen ? chosen.label : text.unanswered}`);
		}
	});
	return lines;
}

/** Pure presentation of the current tab; the adapter only adds colors,
 * borders and the constant-height padding. */
export function wizardView(state: WizardState): WizardView {
	// Answered steps carry a check mark in the tab bar (field wish
	// 2026-07-22); disabled steps STAY in the bar greyed out (v29: a tab's
	// visibility must never change while navigating); the submit tab itself
	// never carries a mark.
	const text = DIALOG_TEXT[state.lang];
	const tabs = [
		...state.steps.map((other, i) => {
			const enabled = stepEnabled(state, i);
			return {
				label: `${other.tab}${enabled && !stepInvalid(state, i) ? " ✔" : ""}`,
				active: i === state.tab,
				...(enabled ? {} : { disabled: true }),
			};
		}),
		{ label: text.submitTab, active: state.tab === state.steps.length },
	];
	if (state.tab === state.steps.length) {
		const cursor = state.cursors[state.tab];
		const note = state.submitNote ? state.submitNote(wizardAnswers(state)) : null;
		const rows: WizardViewRow[] = [
			...wizardSummaryLines(state).map((line) => ({ text: `     ${line}`, active: false })),
			...(note ? [{ text: `     ${note}`, active: false }] : []),
			{ text: "", active: false },
			{ text: `${cursor === 0 ? "❯ " : "  "}   ${text.submitRow}`, active: cursor === 0 },
			{ text: `${cursor === 1 ? "❯ " : "  "}   ${text.submitCancelRow}`, active: cursor === 1 },
		];
		return {
			tabs,
			title: text.submitTitle,
			rows,
			hint: text.hintSubmit,
		};
	}
	const step = state.steps[state.tab];
	// A visited disabled step shows its reason instead of its rows (v29).
	if (!stepEnabled(state, state.tab)) {
		return {
			tabs,
			title: step.title,
			rows: [{ text: `     ${step.disabledNote ?? text.disabledDefault}`, active: false }],
			hint: text.hintDisabled,
		};
	}
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
	} else if (step.kind === "text") {
		const value = state.texts[state.tab];
		const questions = parseQuestionLines(value);
		rows.push({ text: `❯ ${value}_`, active: true });
		rows.push({
			text: value
				? `     ${text.questionsDetected(questions.length)}`
				: `     ${step.placeholder ?? ""}`,
			active: false,
		});
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
		hint: step.kind === "checkbox" ? text.hintCheckbox
			: step.kind === "text" ? text.hintText
			: text.hintChoice,
	};
}

/**
 * Questions separated by SEMICOLON or newline (v27 field decision: "one per
 * line" made no sense in a single-line terminal input; the CLI's multiline
 * habit keeps working). Blank entries vanish; leading list bullets people
 * habitually type ("- ", "* ", "1. ") are stripped; order and wording stay
 * untouched otherwise.
 */
export function parseQuestionLines(text: string): string[] {
	return text
		.split(/[\n;]/)
		.map((line) => line.trim().replace(/^(?:[-*•]|\d{1,2}[.)])(?:\s+|$)/, "").trim())
		.filter(Boolean);
}
