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
	/** Optional dim metadata line under the label (v31.2 user wish: the
	 * documents tab keeps the filename as the selectable row and shows
	 * year/author/title/DOI in grey below it). View-only -- the cursor
	 * walks the items, never these lines. */
	description?: string;
	/** Always selected, toggle is a no-op (2026-08-06: the query-variants
	 * tab pins the main query as its first row -- it always runs). Locked
	 * ids live in the selection like normal picks; init and setItems keep
	 * that invariant. */
	locked?: boolean;
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
		selected: new Set([
			...preselected.filter((id) => known.has(id)),
			...items.filter((item) => item.locked).map((item) => item.id),
		]),
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
				// Select-all "off" keeps locked rows -- they are not optional.
				if (allSelected(state)) {
					for (const item of state.items) {
						if (!item.locked) selected.delete(item.id);
					}
				} else for (const item of state.items) selected.add(item.id);
			} else {
				const item = state.items[state.cursor - 1];
				if (item.locked) return { state };
				if (selected.has(item.id)) selected.delete(item.id);
				else selected.add(item.id);
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
	/** True for an item's description line (the adapter dims it). */
	dim?: boolean;
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
			text: `${active ? "❯ " : "  "}${String(i + 1).padStart(width)}. ${mark(state.selected.has(item.id) || item.locked === true)} ${item.label}`,
			active,
		});
		// Dim metadata line, indented to the label column (v31.2); never a
		// cursor stop -- the item above stays the selectable row.
		if (item.description !== undefined) {
			lines.push({ text: `${" ".repeat(width + 8)}${item.description}`, active: false, dim: true });
		}
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
	/** Main row text. A function receives the live answers (v30.5: the
	 * grouping variants show the derived EXPRESSION as the main row, the
	 * variant name as the dim line below). */
	label: string | ((answers: WizardAnswers) => string);
	/** Explanation line under the label (v30.2, the rpiv look), dim by
	 * default. A function receives the live answers -- the grouping
	 * variants show the expression derived from the CURRENT query text. */
	description?: string | ((answers: WizardAnswers) => string);
	/** v30.4: render the description in normal (white) text instead of dim
	 * -- for lines carrying substance (the grouping expressions), not mere
	 * explanation. */
	descriptionPlain?: boolean;
	/** Free-entry option (v30): the row carries an inline text input right
	 * after the label; Enter answers the step with the TYPED text instead
	 * of `value` (empty input does not answer). Replaces the v29 pattern of
	 * a separate greyed-out tab for the custom count. */
	freeText?: boolean;
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
		/** v30.7: an EMPTY selection is a valid answer (the journal filter:
		 * nothing picked = no filter) -- the step never blocks the finish
		 * and the review shows "(none)" instead of "(open)". */
		optional?: boolean;
		/** v30.7: dim line shown while items is EMPTY (lazily loaded lists:
		 * "fetching...", "no journals found", ...); replaced together with
		 * the items via the setItems event. */
		emptyNote?: string;
		/** 2026-08-06 (query-variants tab): setItems APPENDS checked rows that
		 * the new item list no longer carries (with their old label/flags)
		 * instead of pruning them -- picked suggestions survive a
		 * regeneration. Steps without the flag keep the pruning. */
		keepSelected?: boolean;
		/** 2026-08-06: an inline free-text row between the items and the Next
		 * row (the query-variants steering line). The DRAFT lives in
		 * texts[tab]; Enter on the row COMMITS it (committedTexts + inputSeq
		 * bump) and stays -- rawAnswers exports only the committed value (as
		 * `<id>` plus `<id>_seq`), so an itemLoader keyed on it reloads once
		 * per Enter, never per keystroke. */
		input?: { id: string; label: string };
		/** 2026-08-06: start (and re-anchor after setItems) the cursor on the
		 * Next row -- Enter-through must not toggle select-all on a list of
		 * generated suggestions. */
		cursorStart?: "next";
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
		/** v30.2: prefill for the freeText option, computed live from the
		 * other answers while the user has not typed there (the custom
		 * grouping expression follows the query). A typed edit owns it. */
		customSeed?: (answers: WizardAnswers) => string;
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
		/** v30: while the user has not edited THIS step, its text is computed
		 * live from the other steps' answers (the search wizard derives the
		 * grouping from the query). A provided initial or any keystroke here
		 * makes the user's text permanent -- including clearing it. */
		derive?: (answers: WizardAnswers) => string;
		/** v30: plain single-line value (query, years, grouping) -- no
		 * question splitting/counting in the info line and summaries. */
		plain?: boolean;
		enabledIf?: (answers: WizardAnswers) => boolean;
		disabledNote?: string;
	}
	| {
		/** v30: several labeled single-line fields in ONE tab (the search
		 * wizard's optional filters). Up/Down moves between fields, typing
		 * edits the focused one, Enter advances field-wise then leaves the
		 * step. Every field is optional; empty = not set. Field ids join the
		 * wizard result directly, so they must be unique across steps. */
		kind: "form";
		id: string;
		tab: string;
		title: string;
		fields: Array<{ id: string; label: string; initial?: string }>;
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
	/** Per-step text values ("" on non-text steps; on a choice step with a
	 * freeText option this holds that option's typed value). */
	texts: string[];
	/** Per-step form field values (empty arrays on non-form steps). */
	formTexts: string[][];
	/** Per-step COMMITTED inline-input value of a checkbox step's steering
	 * row (2026-08-06); the draft stays in texts[] until Enter commits. */
	committedTexts: string[];
	/** Per-step commit counter of the steering row -- exported to the
	 * answers as `<id>_seq`, so re-committing the SAME text still changes
	 * the loader key (explicit re-roll of the suggestions). */
	inputSeq: number[];
	/** Steps whose inline text the user owns (v30): true once edited there
	 * or seeded via initial -- derive()/customSeed() stop applying then.
	 * Applies to text steps and to choice steps with a freeText option. */
	dirty: boolean[];
	/** Optional computed line on the submit page (e.g. "~6 Modellaufrufe");
	 * pure function of the answers, injected by the caller. */
	submitNote?: (answers: WizardAnswers) => string | null;
	/** True: advancing past the last step finishes DIRECTLY (no submit
	 * page). For lightweight gates like the per-question confirm (v27) --
	 * the finish guard still jumps to incomplete steps first. */
	skipSubmit?: boolean;
	/** Dialog language of the pure-layer strings; default "en" (v30). */
	lang: DialogLang;
}

export interface WizardOptions {
	/** One line above the tab bar naming the dialog you are in (v30.12
	 * field wish: "wäre nett irgendwo zu lesen, dass ich jetzt in
	 * lit-search bin"). Adapter-rendered; the RPC fallback prefixes its
	 * step titles with it. */
	header?: string;
	submitNote?: (answers: WizardAnswers) => string | null;
	skipSubmit?: boolean;
	/** "submit": open ON the review page (v29.1 proposal-confirm intakes --
	 * one Enter runs the proposal, arrows walk into the tabs to adjust).
	 * Pair with initialIsAnswer on choice steps, else the finish guard
	 * jumps to the unanswered step. */
	startTab?: "submit";
	/** Dialog language; default "en" (v27: follow the chat's language;
	 * v30 user decision: with no chat observed, the default is English). */
	lang?: DialogLang;
	/** Adapter hook (v30.7): lazily load checkbox steps' items when the user
	 * reaches their tab. The PURE layer ignores this field entirely;
	 * extensions/dialogs.ts fetches and dispatches setItems. v30.11: a LIST
	 * -- the search wizard lazily loads journals AND authors. */
	itemLoaders?: WizardItemLoader[];
}

export interface WizardItemLoader {
	/** Step id of the lazily loaded checkbox step. */
	step: string;
	/** Cache key over the live answers (e.g. the query text); a changed
	 * key re-fetches on the next visit; empty key = nothing to load. */
	key: (answers: WizardAnswers) => string;
	load: (answers: WizardAnswers) => Promise<CheckboxItem[]>;
	/** v30.8: ids to precheck in the loaded list while the selection is
	 * still empty (e.g. items matching an agent venues proposal). */
	preselect?: (items: CheckboxItem[]) => string[];
	loadingNote: string;
	idleNote: string;
	emptyNote: string;
	failedNote: (message: string) => string;
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
	/** Yellow warning on the review page listing still-open steps (v30.2,
	 * the rpiv look -- shown up front instead of only jumping on Enter). */
	answerRemaining: (tabs: string[]) => string;
	questionsDetected: (n: number) => string;
	/** Overflow note of the multiline question window (v31.4). */
	linesAbove: (n: number) => string;
	hintSubmit: string;
	hintCheckbox: string;
	hintText: string;
	hintPlainText: string;
	hintForm: string;
	hintChoice: string;
	disabledDefault: string;
	hintDisabled: string;
}> = {
	de: {
		submitTab: "Bestätigen",
		submitTitle: "Antworten prüfen",
		submitRow: "Absenden",
		submitCancelRow: "Abbrechen",
		unanswered: "(offen)",
		noQuestions: "(keine)",
		answerRemaining: (tabs) => `⚠ Vor dem Absenden noch beantworten: ${tabs.join(", ")}`,
		questionsDetected: (n) => `${n} Frage(n) erkannt`,
		linesAbove: (n) => `(… ${n} weitere Zeile(n) oben)`,
		hintSubmit: "Enter bestätigt · ←/→ Schritt · Esc abbrechen",
		hintCheckbox: "Space/Enter auswählen · Enter auf der Weiter-Zeile bestätigt · ←/→ Schritt · Esc abbrechen",
		hintText: "Tippen · Enter: neue Zeile/Frage · Enter auf leerer Zeile oder →: weiter · Esc abbrechen",
		hintPlainText: "Tippen · Enter übernimmt · ←/→ Schritt · Esc abbrechen",
		hintForm: "Tippen · ↑/↓ Feld · Enter übernimmt · ←/→ Schritt · Esc abbrechen",
		hintChoice: "Enter wählt und geht weiter · ←/→ Schritt · Esc abbrechen",
		disabledDefault: "Dieser Schritt ist bei den aktuellen Antworten nicht relevant.",
		hintDisabled: "Enter geht weiter · ←/→ Schritt · Esc abbrechen",
	},
	en: {
		submitTab: "Confirm",
		submitTitle: "Review your answers",
		submitRow: "Submit",
		submitCancelRow: "Cancel",
		unanswered: "(open)",
		noQuestions: "(none)",
		answerRemaining: (tabs) => `⚠ Answer remaining questions before submitting: ${tabs.join(", ")}`,
		questionsDetected: (n) => `${n} question(s) recognized`,
		linesAbove: (n) => `(… ${n} more line(s) above)`,
		hintSubmit: "Enter confirms · ←/→ step · Esc cancels",
		hintCheckbox: "Space/Enter selects · Enter on the Next row confirms · ←/→ step · Esc cancels",
		hintText: "Type · Enter: new line/question · Enter on an empty line or →: continue · Esc cancels",
		hintPlainText: "Type · Enter confirms · ←/→ step · Esc cancels",
		hintForm: "Type · ↑/↓ field · Enter confirms · ←/→ step · Esc cancels",
		hintChoice: "Enter picks and advances · ←/→ step · Esc cancels",
		disabledDefault: "This step does not apply with the current answers.",
		hintDisabled: "Enter advances · ←/→ step · Esc cancels",
	},
};

/** German/English detection over free chat text -- deterministic stopword
 * scoring, umlauts decide instantly; empty or tied input falls back
 * (default: English, the international default -- v30 user decision;
 * German chats flip everything to German via the observer). Pure. */
export function detectDialogLang(texts: Array<string | undefined>, fallback: DialogLang = "en"): DialogLang {
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
	| { kind: "input"; chars: string }
	/** v30.7: replace a checkbox step's items at runtime (lazily loaded
	 * lists -- the adapter fetches, the reducer stays pure). Selections
	 * not in the new items are pruned; the cursor is clamped. preselect
	 * (v30.8) seeds the selection ONLY while it is empty (an agent venues
	 * proposal becomes visible check marks, never overriding the user). */
	| { kind: "setItems"; step: string; items: CheckboxItem[]; emptyNote?: string; preselect?: string[] };

export interface WizardStep {
	state: WizardState;
	done?: "confirmed" | "cancelled";
}

/** Answers by step id: checkbox steps map to id arrays, choices to values. */
export type WizardResult = Record<string, string[] | string>;

/** A choice initial that matches no option is a CUSTOM value: it lands in
 * the freeText option's input (v30, agent path with a non-preset count). */
function choiceCursor(step: WizardStepDef & { kind: "choice" }): number {
	const match = step.options.findIndex((option) => option.value === step.initial);
	if (match >= 0 || step.initial === undefined) return Math.max(0, match);
	return Math.max(0, step.options.findIndex((option) => option.freeText));
}

export function initWizard(steps: WizardStepDef[], options?: WizardOptions): WizardState {
	if (!steps.length) throw new Error("wizard needs at least one step");
	return {
		steps,
		tab: options?.startTab === "submit" ? steps.length : 0,
		cursors: [...steps.map((step) => step.kind === "choice" ? choiceCursor(step)
			: step.kind === "checkbox" && step.cursorStart === "next" ? checkboxNavRows(step) - 1
			: 0), 0],
		selected: steps.map((step) => {
			if (step.kind !== "checkbox") return new Set<string>();
			const known = new Set(step.items.map((item) => item.id));
			return new Set([
				...(step.preselected ?? []).filter((id) => known.has(id)),
				...step.items.filter((item) => item.locked).map((item) => item.id),
			]);
		}),
		// initial is a cursor recommendation, never a pre-answer -- unless
		// the step opts out via initialIsAnswer (proposal-confirm intakes).
		chosen: steps.map((step) =>
			(step.kind === "choice" && step.initialIsAnswer && step.initial !== undefined ? step.initial : null)),
		texts: steps.map((step) => (step.kind === "text" ? step.initial ?? ""
			: step.kind === "choice" && step.initial !== undefined
				&& !step.options.some((option) => option.value === step.initial) ? step.initial
			: "")),
		formTexts: steps.map((step) =>
			(step.kind === "form" ? step.fields.map((field) => field.initial ?? "") : [])),
		committedTexts: steps.map(() => ""),
		inputSeq: steps.map(() => 0),
		dirty: steps.map((step) => (step.kind === "text" && step.initial !== undefined)
			// A non-preset choice initial seeds the freeText row as the
			// user's own value (agent proposal) -- customSeed must not
			// overwrite it.
			|| (step.kind === "choice" && step.initial !== undefined
				&& !step.options.some((option) => option.value === step.initial))),
		...(options?.submitNote ? { submitNote: options.submitNote } : {}),
		...(options?.skipSubmit ? { skipSubmit: true } : {}),
		lang: options?.lang ?? "en",
	};
}

/** Visible line window of a multiline question step (v31.4): with more
 * lines the view shows the TAIL (the cursor lives on the last line) plus
 * an overflow note counting the lines above. */
export const MAX_TEXT_ROWS = 8;

function rowCount(step: WizardStepDef): number {
	return step.kind === "checkbox"
		? step.items.length + step.items.filter((item) => item.description !== undefined).length
			+ (step.input ? 1 : 0) + 2
		// Plain: input + placeholder line. Multiline questions (v31.4): the
		// line window, a possible overflow note and the count line.
		: step.kind === "text" ? (step.plain ? 2 : MAX_TEXT_ROWS + 2)
		: step.kind === "form" ? step.fields.length
		// A description adds a dim explanation row under its option (v30.2).
		: step.options.length + step.options.filter((option) => option.description !== undefined).length;
}

/** CURSOR stops of a checkbox step -- distinct from rowCount, which counts
 * RENDERED lines (incl. dim description lines) for the overlay height.
 * Using rowCount as the cursor range was a latent bug (2026-08-06): items
 * with description lines produced dead cursor rows and an out-of-range
 * items[cursor-1] on Enter. Layout: select-all, items, optional steering
 * input row, Next. While items is EMPTY the select-all row is skipped in
 * the view but keeps cursor slot 0 (the view renders the emptyNote there);
 * input/Next follow at 1/2. */
function checkboxNavRows(step: WizardStepDef & { kind: "checkbox" }): number {
	return 1 + step.items.length + (step.input ? 1 : 0) + 1;
}

/** Cursor row of the steering input row, -1 without one. */
function checkboxInputRow(step: WizardStepDef & { kind: "checkbox" }): number {
	return step.input ? checkboxNavRows(step) - 2 : -1;
}

/** Rendered body rows of the submit tab (v30.2 rpiv layout): two lines per
 * step ("● Tab" + "→ value"), an optional note line, a reserved warning
 * slot, a blank separator, then the two actionable rows. */
function submitRowCount(state: WizardState): number {
	return state.steps.length * 2 + (state.submitNote ? 1 : 0) + 4;
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

/** Raw answers with texts AS STORED -- what derive() reads, so derive
 * steps can never recurse into each other's derived values. Form fields
 * join under their own ids. */
function rawAnswers(state: WizardState): WizardAnswers {
	const answers: WizardAnswers = {};
	state.steps.forEach((step, i) => {
		if (step.kind === "checkbox") {
			answers[step.id] = step.items.filter((item) => state.selected[i].has(item.id)).map((item) => item.id);
			// The steering row exports only its COMMITTED value plus the
			// commit counter -- itemLoader keys stay stable while typing.
			if (step.input) {
				answers[step.input.id] = state.committedTexts[i];
				answers[`${step.input.id}_seq`] = String(state.inputSeq[i]);
			}
		} else if (step.kind === "text") {
			answers[step.id] = state.texts[i];
		} else if (step.kind === "form") {
			step.fields.forEach((field, f) => {
				answers[field.id] = state.formTexts[i][f] ?? "";
			});
		} else {
			answers[step.id] = state.chosen[i];
		}
	});
	return answers;
}

/** The text a text step SHOWS and submits (WYSIWYG): the user's own text,
 * or the live derived value while the step is untouched (v30). */
export function effectiveText(state: WizardState, index: number): string {
	const step = state.steps[index];
	if (step.kind !== "text") return "";
	if (step.derive && !state.dirty[index]) return step.derive(rawAnswers(state));
	return state.texts[index];
}

/** The freeText option's inline value on a choice step (v30.2): the user's
 * own input, or the live customSeed while the row is untouched. */
export function effectiveChoiceText(state: WizardState, index: number): string {
	const step = state.steps[index];
	if (step.kind !== "choice") return "";
	if (step.customSeed && !state.dirty[index]) return step.customSeed(rawAnswers(state));
	return state.texts[index];
}

/** Resolve an option's description against the live answers. */
function optionDescription(
	option: WizardChoiceOption,
	answers: WizardAnswers,
): string | undefined {
	if (option.description === undefined) return undefined;
	return typeof option.description === "function" ? option.description(answers) : option.description;
}

/** Resolve an option's main-row label against the live answers. */
function optionLabel(option: WizardChoiceOption, answers: WizardAnswers): string {
	return typeof option.label === "function" ? option.label(answers) : option.label;
}

/** The current answers as enabledIf and the submit note see them. */
export function wizardAnswers(state: WizardState): WizardAnswers {
	const answers = rawAnswers(state);
	state.steps.forEach((step, i) => {
		if (step.kind === "text") answers[step.id] = effectiveText(state, i);
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
	return step.kind === "checkbox" ? state.selected[index].size === 0 && !step.optional
		: step.kind === "text" ? false // empty text is a valid answer
		: step.kind === "form" ? false // every field is optional
		: state.chosen[index] === null;
}

/** Whether the tab bar marks the step with a check (v30 field wish: a mark
 * means "this carries a value that will run", NOT "this would not block" --
 * before, every text tab was checked from the start). */
export function stepAnswered(state: WizardState, index: number): boolean {
	const step = state.steps[index];
	return step.kind === "checkbox" ? state.selected[index].size > 0
		: step.kind === "text" ? effectiveText(state, index).trim() !== ""
		: step.kind === "form" ? state.formTexts[index].some((value) => value.trim() !== "")
		: state.chosen[index] !== null;
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

/** Control characters never enter a text value. Single-line inputs turn
 * pasted newlines into the question separator; MULTILINE question steps
 * (v31.4) keep them -- one question per line. */
function sanitizeInput(chars: string, multiline = false): string {
	const normalized = chars.replace(/\r\n?|\n/g, multiline ? "\n" : ";");
	// \n itself is a control character -- the multiline strip must keep it.
	return multiline
		? normalized.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
		: normalized.replace(/[\u0000-\u001f\u007f]/g, "");
}

export function reduceWizard(state: WizardState, event: WizardEvent): WizardStep {
	const cursor = state.cursors[state.tab];
	const withCursorAt = (next: number): WizardState => ({
		...state,
		cursors: state.cursors.map((value, i) => (i === state.tab ? next : value)),
	});
	const current = state.tab < state.steps.length && stepEnabled(state, state.tab)
		? state.steps[state.tab]
		: undefined;
	const onText = current?.kind === "text";
	const onForm = current?.kind === "form";
	// Choice step with the cursor on a free-entry option (v30): typing edits
	// that option's inline value, stored in texts[tab].
	const onFreeText = current?.kind === "choice" && current.options[cursor]?.freeText === true;
	// Checkbox step with the cursor on the steering input row (2026-08-06):
	// typing edits the DRAFT in texts[tab]; Enter commits it.
	const onCheckboxInput = current?.kind === "checkbox" && current.input !== undefined
		&& cursor === checkboxInputRow(current);
	// Editing a derive step (or a seeded freeText row) takes ownership: from
	// the first keystroke on (backspace included) the user's text wins over
	// the derived/seeded value.
	const withText = (value: string): WizardState => ({
		...state,
		texts: state.texts.map((prev, i) => (i === state.tab ? value : prev)),
		dirty: state.dirty.map((prev, i) => (i === state.tab ? true : prev)),
	});
	const withFormText = (value: string): WizardState => ({
		...state,
		formTexts: state.formTexts.map((fields, i) =>
			(i === state.tab ? fields.map((prev, f) => (f === cursor ? value : prev)) : fields)),
	});
	const editedValue = onText ? effectiveText(state, state.tab)
		: onForm ? state.formTexts[state.tab][cursor] ?? ""
		: onFreeText ? effectiveChoiceText(state, state.tab)
		: onCheckboxInput ? state.texts[state.tab]
		: null;
	// Runtime item replacement (v30.7, lazily loaded checkbox lists):
	// independent of the current tab; pruned selection, clamped cursor.
	if (typeof event === "object" && event.kind === "setItems") {
		const index = state.steps.findIndex((other) => other.id === event.step && other.kind === "checkbox");
		if (index < 0) return { state };
		const target = state.steps[index] as WizardStepDef & { kind: "checkbox" };
		const selectedOld = state.selected[index];
		// keepSelected (2026-08-06): checked rows the new list no longer
		// carries are APPENDED with their old label/flags instead of pruned
		// -- picked query-variant suggestions survive a regeneration (and
		// stay visible during the loading dispatch's empty item list).
		const newKnown = new Set(event.items.map((item) => item.id));
		const orphans = target.keepSelected
			? target.items.filter((item) => selectedOld.has(item.id) && !newKnown.has(item.id))
			: [];
		const items = [...event.items, ...orphans];
		const known = new Set(items.map((item) => item.id));
		const steps = state.steps.map((other, i) => (i === index && other.kind === "checkbox"
			? {
				...other,
				items,
				...(event.emptyNote !== undefined ? { emptyNote: event.emptyNote } : {}),
			}
			: other));
		const next = steps[index] as WizardStepDef & { kind: "checkbox" };
		// preselect seeds only while the PRE-union selection is empty (first
		// load); locked ids are unioned AFTERWARDS -- otherwise the locked
		// base row would make the selection permanently non-empty and an
		// agent proposal could never precheck (v30.8 semantics preserved).
		const seeded = [...(selectedOld.size ? [...selectedOld] : event.preselect ?? [])]
			.filter((id) => known.has(id));
		const selected = new Set([...seeded, ...items.filter((item) => item.locked).map((item) => item.id)]);
		// Cursor follows its ROLE across the item swap (2026-08-06): Next row
		// stays Next, the steering row stays the steering row -- an
		// Enter-through user parked on Next must not land mid-list when the
		// suggestions arrive.
		const oldCursor = state.cursors[index];
		const cursorRow = oldCursor === checkboxNavRows(target) - 1 ? checkboxNavRows(next) - 1
			: target.input && oldCursor === checkboxInputRow(target) ? checkboxInputRow(next)
			: Math.min(oldCursor, Math.max(0, checkboxNavRows(next) - 1));
		return {
			state: {
				...state,
				steps,
				selected: state.selected.map((set, i) => (i === index ? selected : set)),
				cursors: state.cursors.map((value, i) => (i === index ? cursorRow : value)),
			},
		};
	}
	// Typed characters and backspace only ever edit an input context.
	if (typeof event === "object") {
		if (editedValue === null) return { state };
		// Only a non-plain text step (the questions tab) is multiline.
		const chars = sanitizeInput(event.chars, onText && current?.kind === "text" && !current.plain);
		if (!chars) return { state };
		const value = editedValue + chars;
		return { state: onForm ? withFormText(value) : withText(value) };
	}
	if (event === "backspace") {
		if (editedValue === null) return { state };
		const value = editedValue.slice(0, -1);
		return { state: onForm ? withFormText(value) : withText(value) };
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
	// Cursor range: checkbox steps use their NAV rows (description lines and
	// the height budget stay in rowCount -- the 2026-08-06 dead-cursor fix).
	const rows = step.kind === "checkbox" ? checkboxNavRows(step) : rowCount(step);
	const withCursor = withCursorAt;
	const toggled = (): WizardState => {
		// Only the select-all row and real item rows carry check state --
		// the steering input row and the Next row do not.
		if (step.kind !== "checkbox" || cursor > step.items.length) return state;
		const selected = new Set(state.selected[state.tab]);
		if (cursor === 0) {
			if (step.items.every((item) => selected.has(item.id)) && step.items.length) {
				// Select-all "off" keeps locked rows -- they are not optional.
				for (const item of step.items) {
					if (!item.locked) selected.delete(item.id);
				}
			} else for (const item of step.items) selected.add(item.id);
		} else {
			const item = step.items[cursor - 1];
			if (item === undefined || item.locked) return state;
			if (selected.has(item.id)) selected.delete(item.id);
			else selected.add(item.id);
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
				// Enter on the steering row COMMITS the draft and stays
				// (2026-08-06): the committed value + bumped counter reach the
				// answers, the itemLoader's changed key fires the regeneration
				// on the adapter's next tick. Same text again = explicit
				// re-roll. Checked before the empty-optional advance so
				// steering works even while the list is empty (loading).
				if (onCheckboxInput) {
					const committed = state.texts[state.tab].trim();
					return {
						state: {
							...state,
							committedTexts: state.committedTexts.map((prev, i) =>
								(i === state.tab ? committed : prev)),
							inputSeq: state.inputSeq.map((prev, i) => (i === state.tab ? prev + 1 : prev)),
						},
					};
				}
				// An empty OPTIONAL list advances from any row (v30.7: the
				// lazily loaded journal list must never stall Enter-through).
				if (step.items.length === 0 && step.optional) return advance(state);
				// Enter toggles like Space on real rows; only the explicit
				// next-row commits (rpiv rule -- the E2c field complaint).
				// An OPTIONAL step commits empty (empty = "no filter").
				if (cursor < rows - 1) return { state: toggled() };
				if (state.selected[state.tab].size === 0 && !step.optional) return { state };
				return advance(state);
			}
			if (step.kind === "text") {
				// MULTILINE question steps (v31.4 user wish "jede Frage in
				// einer Zeile"): Enter opens a new line; Enter on a BLANK
				// last line (or on an empty step) advances -- so an untouched
				// tab still passes with one stroke, a filled one with two.
				if (!step.plain) {
					const value = effectiveText(state, state.tab);
					if (value.trim() === "") return advance(state);
					const lines = value.split("\n");
					if (lines[lines.length - 1].trim() === "") {
						return advance(withText(lines.slice(0, -1).join("\n")));
					}
					return { state: withText(`${value}\n`) };
				}
				return advance(state); // empty text is a valid answer
			}
			if (step.kind === "form") {
				// Enter on a FILLED field walks to the next one; Enter on an
				// empty field (or the last) leaves the step -- so the
				// Enter-through flow passes an untouched filter tab with ONE
				// stroke (every field is optional, empty means "filter off").
				const filled = (state.formTexts[state.tab][cursor] ?? "").trim() !== "";
				if (filled && cursor < rows - 1) return { state: withCursor(cursor + 1) };
				return advance(state);
			}
			const option = step.options[cursor];
			if (option === undefined) return { state };
			// A free-entry option answers with its TYPED (or seeded) value;
			// empty input answers nothing (pick a preset or type a value).
			const value = option.freeText ? effectiveChoiceText(state, state.tab).trim() : option.value;
			if (!value) return { state };
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
			if (step.input) result[step.input.id] = state.committedTexts[i];
		} else if (step.kind === "text") {
			result[step.id] = effectiveText(state, i);
		} else if (step.kind === "form") {
			step.fields.forEach((field, f) => {
				result[field.id] = state.formTexts[i][f] ?? "";
			});
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
	/** Dim supporting line (option descriptions, review labels). */
	dim?: boolean;
	/** Warning line (the review page's open-steps notice). */
	warn?: boolean;
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

/** The review-page value of one step, as a single line. */
function stepValueLabel(state: WizardState, i: number): string {
	const text = DIALOG_TEXT[state.lang];
	const step = state.steps[i];
	if (step.kind === "checkbox") {
		const chosen = step.items.filter((item) => state.selected[i].has(item.id));
		const all = chosen.length === step.items.length && step.items.length > 0;
		// Optional steps (v30.7): empty is a decision, not an open question.
		return chosen.length === 0 ? (step.optional ? text.noQuestions : text.unanswered)
			: all ? `${step.selectAllLabel} (${chosen.length})`
			: chosen.map((item) => item.label).join(", ");
	}
	if (step.kind === "text") {
		const value = effectiveText(state, i);
		if (step.plain) return value.trim() ? value.trim() : text.noQuestions;
		const questions = parseQuestionLines(value);
		return questions.length ? questions.join(" · ") : text.noQuestions;
	}
	if (step.kind === "form") {
		const set = step.fields
			.map((field, f) => ({ field, value: (state.formTexts[i][f] ?? "").trim() }))
			.filter((entry) => entry.value !== "")
			.map((entry) => `${entry.field.label} ${entry.value}`);
		return set.length ? set.join(" · ") : text.noQuestions;
	}
	const chosen = step.options.find((option) => option.value === state.chosen[i]);
	if (chosen && !chosen.freeText) {
		// Label and description together carry the full picture (v30.2;
		// v30.5: for the grouping variants the label IS the expression and
		// the description names the variant).
		const answers = wizardAnswers(state);
		const label = optionLabel(chosen, answers);
		const description = optionDescription(chosen, answers);
		return description ? `${label} -- ${description}` : label;
	}
	// A free-entry answer matches no option: show the typed value.
	return state.chosen[i] ?? text.unanswered;
}

/** One summary line per ENABLED step for the submit page -- also used by
 * the fallback loop. */
export function wizardSummaryLines(state: WizardState): string[] {
	const lines: string[] = [];
	state.steps.forEach((step, i) => {
		if (!stepEnabled(state, i)) return;
		lines.push(`${step.tab}: ${stepValueLabel(state, i)}`);
	});
	return lines;
}

/** Pure presentation of the current tab; the adapter only adds colors,
 * borders and the constant-height padding. */
export function wizardView(state: WizardState): WizardView {
	// Tab bar in the rpiv look (v30.2): steps carry a filled square once
	// they HOLD A VALUE (v30: the old mark meant "would not block", so
	// every text tab was checked from the start -- field complaint), an
	// empty square while open; the review tab carries a check. Disabled
	// steps STAY in the bar greyed out (v29: a tab's visibility must never
	// change while navigating).
	const text = DIALOG_TEXT[state.lang];
	const tabs = [
		...state.steps.map((other, i) => {
			const enabled = stepEnabled(state, i);
			return {
				label: `${enabled && stepAnswered(state, i) ? "■" : "□"} ${other.tab}`,
				active: i === state.tab,
				...(enabled ? {} : { disabled: true }),
			};
		}),
		{ label: `✓ ${text.submitTab}`, active: state.tab === state.steps.length },
	];
	if (state.tab === state.steps.length) {
		const cursor = state.cursors[state.tab];
		const note = state.submitNote ? state.submitNote(wizardAnswers(state)) : null;
		// The rpiv review layout: "● Tab" + "→ value" per step, the note,
		// then a WARNING listing still-open steps up front (the jump on
		// Enter stays, but the user sees WHY before pressing it).
		const rows: WizardViewRow[] = [];
		state.steps.forEach((step, i) => {
			if (!stepEnabled(state, i)) return;
			rows.push({ text: `  ● ${step.tab}`, active: false, dim: true });
			rows.push({ text: `    → ${stepValueLabel(state, i)}`, active: false });
		});
		if (note) rows.push({ text: `  ${note}`, active: false, dim: true });
		const open = state.steps.filter((_, i) => stepInvalid(state, i)).map((step) => step.tab);
		rows.push(open.length
			? { text: text.answerRemaining(open), active: false, warn: true }
			: { text: "", active: false });
		rows.push({ text: "", active: false });
		rows.push({ text: `${cursor === 0 ? "❯ " : "  "}1. ${text.submitRow}`, active: cursor === 0 });
		rows.push({ text: `${cursor === 1 ? "❯ " : "  "}2. ${text.submitCancelRow}`, active: cursor === 1 });
		return {
			tabs,
			title: text.submitTitle,
			rows,
			hint: text.hintSubmit,
		};
	}
	const step = state.steps[state.tab];
	// A visited disabled step shows its reason instead of its rows (v29).
	// The reason is a WARNING row (v31.3 user wish): yellow with the ⚠ sign,
	// same look as the submit page's "answer remaining" line.
	if (!stepEnabled(state, state.tab)) {
		return {
			tabs,
			title: step.title,
			rows: [{ text: `   ⚠ ${step.disabledNote ?? text.disabledDefault}`, active: false, warn: true }],
			hint: text.hintDisabled,
		};
	}
	const cursor = state.cursors[state.tab];
	const rows: WizardViewRow[] = [];
	if (step.kind === "checkbox") {
		const pushInputRow = (): void => {
			// The steering input row (2026-08-06), form-style: label + draft.
			if (!step.input) return;
			const active = cursor === checkboxInputRow(step);
			const draft = state.texts[state.tab];
			rows.push({
				text: `${active ? "❯ " : "  "}   ${step.input.label}: ${draft}${active ? "_" : ""}`,
				active,
			});
		};
		const nextActive = cursor === checkboxNavRows(step) - 1;
		if (step.items.length === 0) {
			// Lazily loaded list before/without items (v30.7): the note says
			// why it is empty; the next-row keeps Enter-through working.
			rows.push({ text: `     ${step.emptyNote ?? ""}`, active: false, dim: true });
			pushInputRow();
			rows.push({ text: `${nextActive ? "❯ " : "  "}   ${step.nextLabel}`, active: nextActive });
		} else {
			const checkboxState: CheckboxState = {
				items: step.items,
				cursor,
				selected: state.selected[state.tab],
			};
			rows.push(...checkboxLines(checkboxState, step.selectAllLabel));
			pushInputRow();
			rows.push({ text: `${nextActive ? "❯ " : "  "}   ${step.nextLabel}`, active: nextActive });
		}
	} else if (step.kind === "text") {
		const value = effectiveText(state, state.tab);
		if (step.plain) {
			rows.push({ text: `❯ ${value}_`, active: true });
			// Plain inputs (query, years, grouping) get no question counter --
			// only the placeholder while empty (v30); the info line renders
			// dim (v30.3 user wish: the example query in grey).
			rows.push({
				text: !value ? `     ${step.placeholder ?? ""}` : "",
				active: false,
				dim: true,
			});
		} else {
			// MULTILINE question step (v31.4): one question per line, the
			// cursor always on the last line; with many lines a window shows
			// the tail and an overflow note counts the lines above it.
			const lines = value.split("\n");
			const visible = lines.slice(-MAX_TEXT_ROWS);
			const hidden = lines.length - visible.length;
			if (hidden > 0) {
				rows.push({ text: `     ${text.linesAbove(hidden)}`, active: false, dim: true });
			}
			visible.forEach((line, index) => {
				const last = index === visible.length - 1;
				rows.push(last ? { text: `❯ ${line}_`, active: true } : { text: `  ${line}`, active: false });
			});
			rows.push({
				text: !value ? `     ${step.placeholder ?? ""}`
					: `     ${text.questionsDetected(parseQuestionLines(value).length)}`,
				active: false,
				dim: true,
			});
		}
	} else if (step.kind === "form") {
		step.fields.forEach((field, i) => {
			const active = cursor === i;
			const value = state.formTexts[state.tab][i] ?? "";
			rows.push({
				text: `${active ? "❯ " : "  "}${field.label}: ${value}${active ? "_" : ""}`,
				active,
			});
		});
	} else {
		const width = String(step.options.length).length;
		const answers = wizardAnswers(state);
		step.options.forEach((option, i) => {
			const active = cursor === i;
			const label = optionLabel(option, answers);
			// A free-entry option renders its inline input (typed or seeded)
			// after the label; it is "chosen" when the answer equals it.
			const inline = option.freeText ? effectiveChoiceText(state, state.tab) : "";
			const value = option.freeText ? ` ${inline}${active ? "_" : ""}` : "";
			const chosenValue = option.freeText ? inline.trim() : option.value;
			const chosen = state.chosen[state.tab] !== null && state.chosen[state.tab] === chosenValue ? " ✔" : "";
			rows.push({ text: `${active ? "❯ " : "  "}${String(i + 1).padStart(width)}. ${label}${value}${chosen}`, active });
			// The rpiv look: an explanation line under the label (v30.2) --
			// dim, unless the option marks it as substance (v30.4: the
			// grouping expressions render white).
			const description = optionDescription(option, answers);
			if (description !== undefined) {
				rows.push({
					text: `${" ".repeat(width + 4)}${description}`,
					active: false,
					...(option.descriptionPlain ? {} : { dim: true }),
				});
			}
		});
	}
	return {
		tabs,
		title: step.title,
		rows,
		hint: step.kind === "checkbox" ? text.hintCheckbox
			: step.kind === "text" ? (step.plain ? text.hintPlainText : text.hintText)
			: step.kind === "form" ? text.hintForm
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
