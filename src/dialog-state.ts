/**
 * Pure state machine for the wizard dialogs -- no pi imports, fully
 * testable offline. The adapter in extensions/dialogs.ts only translates
 * key strokes to reducer events and view rows to themed output; every
 * decision lives here: step kinds (checkbox, choice, text, form), cursor
 * movement, typing, lazy item lists, the review page and the finish guard.
 *
 * Checkbox steps carry a "select all" row on top of the items whose check
 * mark is DERIVED from the items and never stored, so items and the summary
 * row can never disagree.
 */

export interface CheckboxItem {
	/** Stable identity returned by selection() (e.g. the PDF basename). */
	id: string;
	label: string;
	/** Optional dim metadata line under the label (the
	 * documents tab keeps the filename as the selectable row and shows
	 * year/author/title/DOI in grey below it). View-only -- the cursor
	 * walks the items, never these lines. */
	description?: string;
	/** Always selected, toggle is a no-op (the query-variants
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

/** True when every item is selected (the select-all row's derived mark). */
export function allSelected(state: CheckboxState): boolean {
	return state.items.length > 0 && state.items.every((item) => state.selected.has(item.id));
}

export interface CheckboxLine {
	text: string;
	/** True for the cursor row (the adapter highlights it). */
	active: boolean;
	/** True for an item's description line (the adapter dims it). */
	dim?: boolean;
}

/** Deterministic row texts: a select-all summary row on
 * top, then numbered items -- "❯ 1. [✔] label". Pure, so the exact wording
 * is pinned by offline tests; the adapters only add colors. */
export function checkboxLines(
	state: CheckboxState,
	selectAllLabel: string,
	spaced = false,
	allSelectedLabel?: string,
): CheckboxLine[] {
	const mark = (checked: boolean): string => (checked ? "[✔]" : "[ ]");
	const width = String(state.items.length).length;
	const all = allSelected(state);
	const lines: CheckboxLine[] = [{
		text: `${state.cursor === 0 ? "❯ " : "  "}   ${mark(all)} ${all && allSelectedLabel ? allSelectedLabel : selectAllLabel}`,
		active: state.cursor === 0,
	}];
	state.items.forEach((item, i) => {
		const active = state.cursor === i + 1;
		if (spaced) lines.push({ text: "", active: false });
		lines.push({
			text: `${active ? "❯ " : "  "}${String(i + 1).padStart(width)}. ${mark(state.selected.has(item.id) || item.locked === true)} ${item.label}`,
			active,
		});
		// Dim metadata line, indented to the label column; never a
		// cursor stop -- the item above stays the selectable row.
		if (item.description !== undefined) {
			lines.push({ text: `${" ".repeat(width + 8)}${item.description}`, active: false, dim: true });
		}
	});
	return lines;
}

/* ------------------------------------------------------------------ *
 * Wizard -- ONE questionnaire over several steps                       *
 * ------------------------------------------------------------------ */

/**
 * ONE dialog holds every question as a tab (a chain of separate dialogs
 * would jump around the screen, have no way back, and let Enter commit a
 * multi-select prematurely):
 *   - Tab/RIGHT and Shift-Tab/LEFT move between steps (wrapping); answers
 *     are kept, so going back is free.
 *   - In a checkbox step, Space AND Enter toggle the focused row; the step
 *     commits only on the explicit next-row.
 *   - A choice step answers with Enter and auto-advances.
 *   - Finishing (advancing past the LAST step) is guarded: an unanswered
 *     choice or an empty required checkbox selection jumps there instead.
 *   - Esc cancels the whole wizard, from any step.
 * The adapter keeps the overlay footprint constant via maxWizardRows.
 */

export interface WizardChoiceOption {
	value: string;
	/** Main row text. A function receives the live answers (the
	 * grouping variants show the derived EXPRESSION as the main row, the
	 * variant name as the dim line below). */
	label: string | ((answers: WizardAnswers) => string);
	/** Explanation line under the label, dim by
	 * default. A function receives the live answers -- the grouping
	 * variants show the expression derived from the CURRENT query text. */
	description?: string | ((answers: WizardAnswers) => string);
	/** render the description in normal (white) text instead of dim
	 * -- for lines carrying substance (the grouping expressions), not mere
	 * explanation. */
	descriptionPlain?: boolean;
	/** Free-entry option: the row carries an inline text input right
	 * after the label; Enter answers the step with the TYPED text instead
	 * of `value` (empty input does not answer). */
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
		/** Exclusion-list steps (defaultAll): the head row's label while
		 * EVERYTHING is checked ("All journals included (Enter: deselect
		 * all)"); selectAllLabel shows otherwise. */
		allSelectedLabel?: string;
		/** Label of the explicit commit row ("Weiter"/"Fertig"). */
		nextLabel: string;
		preselected?: string[];
		/** EXCLUSION list: items arrive CHECKED (the journal/author
		 * filters -- everything is in, unticking excludes). setItems keeps
		 * a memory of unticked ids (excludedIds) so a reload -- including
		 * the empty loading swap -- never re-checks what the user removed;
		 * new rows arrive checked. A preselect (agent proposal) still wins
		 * on the first load: only the proposed rows are checked. The step
		 * counts as answered only while SOME rows are unticked; all or
		 * none checked both read "all (no filter)" in the review. */
		defaultAll?: boolean;
		/** Unticked ids remembered across setItems (defaultAll only);
		 * maintained by the reducer. */
		excludedIds?: string[];
		/** an EMPTY selection is a valid answer (the journal filter:
		 * nothing picked = no filter) -- the step never blocks the finish
		 * and the review shows "(none)" instead of "(open)". */
		optional?: boolean;
		/** dim line shown while items is EMPTY (lazily loaded lists:
		 * "fetching...", "no journals found", ...); replaced together with
		 * the items via the setItems event. */
		emptyNote?: string;
		/** While a loader is in flight the tab renders ONLY the pulsing
		 * emptyNote --
		 * no select-all, no items, no input rows -- so the load is
		 * unmistakable. Set/cleared exclusively via the setItems event
		 * (every dispatch without the flag clears it). Enter still advances
		 * (the tab never blocks on the model); cursor math is untouched so
		 * the cursor role survives the loading phase. */
		loading?: boolean;
		/** Query-variants tab: setItems APPENDS checked rows that
		 * the new item list no longer carries (with their old label/flags)
		 * instead of pruning them -- picked suggestions survive a
		 * regeneration. Steps without the flag keep the pruning. */
		keepSelected?: boolean;
		/** an inline free-text row between the items and the Next
		 * row (the query-variants steering line). The DRAFT lives in
		 * texts[tab]; Enter on the row COMMITS it (committedTexts + inputSeq
		 * bump) and stays -- rawAnswers exports only the committed value (as
		 * `<id>` plus `<id>_seq`), so an itemLoader keyed on it reloads once
		 * per Enter, never per keystroke. */
		input?: { id: string; label: string };
		/** Query-variants tab: an inline free-text row between the items and the
		 * steering row. Enter ADDS the trimmed draft as a CHECKED item
		 * (case-insensitive dedupe against existing ids just checks the
		 * existing row) and clears the draft; with keepSelected the added
		 * row survives regenerations like any checked pick. The draft lives
		 * in addTexts[tab]. */
		addInput?: { id: string; label: string };
		/** One blank rendered line before every item and before each input
		 * row -- air between wide, wrapping rows (the query-variants tab).
		 * Rendered lines only, never cursor stops; single-line lists stay
		 * compact without it. */
		spaced?: boolean;
		/** start (and re-anchor after setItems) the cursor on the
		 * Next row -- Enter-through must not toggle select-all on a list of
		 * generated suggestions. */
		cursorStart?: "next";
		/** Step applies only while this holds over the current answers (* the detail-mode tab applies only with >= 2 documents AND >= 1
		 * question). a disabled step STAYS in the tab bar greyed out
		 * (a tab's visibility must not change while navigating) and can be
		 * visited -- it shows disabledNote instead of its rows -- but it
		 * never blocks the finish and is absent from summary and result. */
		enabledIf?: (answers: WizardAnswers) => boolean;
		/** One-line reason shown when the step is disabled (grey out
		 * with a reason instead of hiding). Falls back to a generic line. */
		disabledNote?: string;
	}
	| {
		kind: "choice";
		id: string;
		tab: string;
		title: string;
		options: WizardChoiceOption[];
		/** prefill for the freeText option, computed live from the
		 * other answers while the user has not typed there (the custom
		 * grouping expression follows the query). A typed edit owns it. */
		customSeed?: (answers: WizardAnswers) => string;
		/** RECOMMENDED option: the cursor starts here, but the step counts
		 * as answered only after an explicit Enter (a recommendation must
		 * never silently be an answer). */
		initial?: string;
		/** Opt-out of the rule above: the initial IS the answer.
		 * For proposal-confirm intakes (the search wizard opens on its
		 * submit page; every step already carries the proposed value, and
		 * one Enter runs it -- the old "Run as proposed" ergonomics). */
		initialIsAnswer?: boolean;
		enabledIf?: (answers: WizardAnswers) => boolean;
		disabledNote?: string;
	}
	| {
		/** Single-line free-text input (the questions intake joined the
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
		/** while the user has not edited THIS step, its text is computed
		 * live from the other steps' answers (the search wizard derives the
		 * grouping from the query). A provided initial or any keystroke here
		 * makes the user's text permanent -- including clearing it. */
		derive?: (answers: WizardAnswers) => string;
		/** plain single-line value (query, years, grouping) -- no
		 * question splitting/counting in the info line and summaries. */
		plain?: boolean;
		enabledIf?: (answers: WizardAnswers) => boolean;
		disabledNote?: string;
	}
	| {
		/** several labeled single-line fields in ONE tab (the search
		 * wizard's optional filters). Up/Down moves between fields, typing
		 * edits the focused one, Enter advances field-wise then leaves the
		 * step. Every field is optional; empty = not set. Field ids join the
		 * wizard result directly, so they must be unique across steps. */
		kind: "form";
		id: string;
		tab: string;
		title: string;
		fields: Array<{ id: string; label: string; initial?: string }>;
		/** Dynamically GROWING labeled fields BEFORE the static fields (the
		 * search wizard's keyword blocks): ids `${idPrefix}_1..n`, labels via
		 * label(n). An explicit ADD row sits under the grow fields (label =
		 * addLabel); Enter there appends the next empty field, up to max --
		 * the row hides at the cap. Grow-only: emptied fields never collapse
		 * mid-edit, they drop out at serialization. When static fields
		 * follow, a blank separator line divides them from the grow section
		 * (the separator is never a cursor stop; the add row is one while
		 * shown). */
		grow?: {
			idPrefix: string;
			label: (n: number) => string;
			/** The add row's visible label ("+ Add keyword block"). */
			addLabel: string;
			/** Grow fields visible at start (before any initial seeding). */
			min: number;
			/** Hard cap; also the height budget for maxWizardRows. */
			max: number;
			/** Prefill, one value per grow field (agent block proposal). */
			initial?: string[];
		};
		/** Status line under the fields, pure over the live field values;
		 * warn renders yellow. The row is height-reserved whenever note is
		 * defined and is never a cursor stop. */
		note?: (values: string[]) => { text: string; warn?: boolean } | null;
		/** Review-page value line over the live field values (the composed
		 * query); without it the fields join as "Label value · ...". */
		summary?: (values: string[]) => string;
		enabledIf?: (answers: WizardAnswers) => boolean;
		disabledNote?: string;
	};

export interface WizardState {
	steps: WizardStepDef[];
	/** Current tab index; steps.length is the final SUBMIT tab (summary +
	 * the submit / cancel review page). */
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
	 * row; the draft stays in texts[] until Enter commits. */
	committedTexts: string[];
	/** Per-step draft of a checkbox step's ADD row ("type your own query
	 * variant"); Enter turns it into a checked item and clears. */
	addTexts: string[];
	/** Per-step commit counter of the steering row -- exported to the
	 * answers as `<id>_seq`, so re-committing the SAME text still changes
	 * the loader key (explicit re-roll of the suggestions). */
	inputSeq: number[];
	/** Steps whose inline text the user owns: true once edited there
	 * or seeded via initial -- derive()/customSeed() stop applying then.
	 * Applies to text steps and to choice steps with a freeText option. */
	dirty: boolean[];
	/** Optional computed line on the submit page (e.g. "~6 Modellaufrufe");
	 * pure function of the answers, injected by the caller. */
	submitNote?: (answers: WizardAnswers) => string | null;
	/** True: advancing past the last step finishes DIRECTLY (no submit
	 * page). For lightweight gates like the per-question confirm --
	 * the finish guard still jumps to incomplete steps first. */
	skipSubmit?: boolean;
	/** Dialog language of the pure-layer strings; default "en". */
	lang: DialogLang;
}

export interface WizardOptions {
	/** One line above the tab bar naming the dialog you are in.
	 * Adapter-rendered; the RPC fallback prefixes its step titles with it. */
	header?: string;
	submitNote?: (answers: WizardAnswers) => string | null;
	skipSubmit?: boolean;
	/** "submit": open ON the review page (proposal-confirm intakes -- one
	 * Enter runs the proposal, arrows walk into the tabs to adjust).
	 * Pair with initialIsAnswer on choice steps, else the finish guard
	 * jumps to the unanswered step. */
	startTab?: "submit";
	/** Dialog language; default "en" (follow the chat's language;
	 * with no chat observed, the default is English). */
	lang?: DialogLang;
	/** Adapter hook: lazily load checkbox steps' items when the user
	 * reaches their tab. The PURE layer ignores this field entirely;
	 * extensions/dialogs.ts fetches and dispatches setItems. a LIST
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
	/** ids to precheck in the loaded list while the selection is
	 * still empty (e.g. items matching an agent venues proposal). */
	preselect?: (items: CheckboxItem[]) => string[];
	loadingNote: string;
	idleNote: string;
	emptyNote: string;
	failedNote: (message: string) => string;
}

/**
 * Dialog language (the dialogs follow the CHAT's
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
	/** Exclusion-list review values: nothing excluded / the excluded rows. */
	allKept: string;
	excluded: (labels: string[]) => string;
	/** Yellow warning on the review page listing still-open steps (shown
	 * up front instead of only jumping on Enter). */
	answerRemaining: (tabs: string[]) => string;
	questionsDetected: (n: number) => string;
	/** Overflow note of the multiline question window. */
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
		allKept: "alle (kein Filter)",
		excluded: (labels) => `ausgeschlossen: ${labels.join(", ")}`,
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
		allKept: "all (no filter)",
		excluded: (labels) => `excluded: ${labels.join(", ")}`,
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
 * (default: English, the international default; German chats flip
 * everything to German via the observer). Pure. */
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

export type WizardEvent =
	| "up" | "down" | "left" | "right" | "toggle" | "confirm" | "cancel"
	/** Backspace in a text step (ignored elsewhere). */
	| "backspace"
	/** Typed/pasted characters for a text step (ignored elsewhere). */
	| { kind: "input"; chars: string }
	/** replace a checkbox step's items at runtime (lazily loaded
	 * lists -- the adapter fetches, the reducer stays pure). Selections
	 * not in the new items are pruned; the cursor is clamped. preselect
	 * seeds the selection ONLY while it is empty (an agent venues
	 * proposal becomes visible check marks, never overriding the user). */
	| { kind: "setItems"; step: string; items: CheckboxItem[]; emptyNote?: string; preselect?: string[]; loading?: boolean };

export interface WizardStep {
	state: WizardState;
	done?: "confirmed" | "cancelled";
}

/** Answers by step id: checkbox steps map to id arrays, choices to values. */
export type WizardResult = Record<string, string[] | string>;

/** A choice initial that matches no option is a CUSTOM value: it lands in
 * the freeText option's input (agent path with a non-preset count). */
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
			if (step.defaultAll && !step.preselected?.length) return new Set(known);
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
		formTexts: steps.map((step) => {
			if (step.kind !== "form") return [];
			const staticInit = step.fields.map((field) => field.initial ?? "");
			if (!step.grow) return staticInit;
			// Grow seeding: initial values (capped), padded to min empty
			// fields -- further fields come only through the add row.
			const seeded = (step.grow.initial ?? []).slice(0, step.grow.max);
			while (seeded.length < step.grow.min) seeded.push("");
			return [...seeded, ...staticInit];
		}),
		committedTexts: steps.map(() => ""),
		addTexts: steps.map(() => ""),
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

/** Visible line window of a multiline question step: with more
 * lines the view shows the TAIL (the cursor lives on the last line) plus
 * an overflow note counting the lines above. */
const MAX_TEXT_ROWS = 8;

function rowCount(step: WizardStepDef): number {
	return step.kind === "checkbox"
		? step.items.length + step.items.filter((item) => item.description !== undefined).length
			+ (step.input ? 1 : 0) + (step.addInput ? 1 : 0) + 2
			// Spaced lists: a blank line per item and per input row.
			+ (step.spaced ? step.items.length + (step.input ? 1 : 0) + (step.addInput ? 1 : 0) : 0)
			// A non-empty status note is an EXTRA dim line while items are
			// present (reload visibility); on an empty list it
			// replaces the select-all row instead -- no extra height there.
			+ (step.items.length && step.emptyNote ? 1 : 0)
		// Plain: input + placeholder line. Multiline questions: the
		// line window, a possible overflow note and the count line.
		: step.kind === "text" ? (step.plain ? 2 : MAX_TEXT_ROWS + 2)
		// A grow form budgets its WORST CASE (all grow fields added, plus
		// the add-row slot and the blank separator before static fields) so
		// the overlay height never changes while fields are added; the note
		// row is height-reserved whenever defined.
		: step.kind === "form"
			? (step.grow ? step.grow.max + 1 + (step.fields.length ? 1 : 0) : 0)
				+ step.fields.length + (step.note ? 1 : 0)
		// A description adds a dim explanation row under its option.
		: step.options.length + step.options.filter((option) => option.description !== undefined).length;
}

/** The CURRENT labeled fields of a form step: grow fields first
 * (`${idPrefix}_1..n` from the live value count), then the static fields.
 * The single source for ids/labels -- answers, result, view, review line
 * and the RPC menu all build on it, so their indexes can never diverge. */
export function formFieldDefs(
	step: Extract<WizardStepDef, { kind: "form" }>,
	values: string[],
): Array<{ id: string; label: string }> {
	if (!step.grow) return step.fields;
	const grown = Math.max(0, values.length - step.fields.length);
	const grow = step.grow;
	return [
		...Array.from({ length: grown }, (_, n) => ({
			id: `${grow.idPrefix}_${n + 1}`,
			label: grow.label(n + 1),
		})),
		...step.fields,
	];
}

/** Cursor row of a grow form's ADD row -- right under the grow fields,
 * before the static ones; -1 without grow or at the cap (the row hides). */
function formAddRow(step: Extract<WizardStepDef, { kind: "form" }>, values: string[]): number {
	if (!step.grow) return -1;
	const grown = values.length - step.fields.length;
	return grown < step.grow.max ? grown : -1;
}

/** Cursor stops of a form step: one per field plus the add row while
 * shown. The blank separator and the note row are rendered lines only. */
function formNavRows(step: Extract<WizardStepDef, { kind: "form" }>, values: string[]): number {
	return values.length + (formAddRow(step, values) >= 0 ? 1 : 0);
}

/** The formTexts index a form cursor row edits; -1 on the add row (typing
 * is inert there, Enter adds a field). */
function formFieldIndex(
	step: Extract<WizardStepDef, { kind: "form" }>,
	values: string[],
	cursor: number,
): number {
	const addRow = formAddRow(step, values);
	if (addRow < 0 || cursor < addRow) return cursor;
	return cursor === addRow ? -1 : cursor - 1;
}

/** CURSOR stops of a checkbox step -- distinct from rowCount, which counts
 * RENDERED lines (incl. dim description lines) for the overlay height.
 * Using rowCount as the cursor range was a latent bug: items
 * with description lines produced dead cursor rows and an out-of-range
 * items[cursor-1] on Enter. Layout: select-all, items, optional ADD row
 *, optional steering input row, Next. While items is EMPTY
 * the select-all row is skipped in the view but keeps cursor slot 0 (the
 * view renders the emptyNote there); the remaining rows follow. */
function checkboxNavRows(step: WizardStepDef & { kind: "checkbox" }): number {
	return 1 + step.items.length + (step.addInput ? 1 : 0) + (step.input ? 1 : 0) + 1;
}

/** Cursor row of the steering input row, -1 without one. */
function checkboxInputRow(step: WizardStepDef & { kind: "checkbox" }): number {
	return step.input ? checkboxNavRows(step) - 2 : -1;
}

/** Cursor row of the ADD row ("type your own variant"), -1 without one.
 * Sits between the items and the steering row. */
export function checkboxAddRow(step: WizardStepDef & { kind: "checkbox" }): number {
	return step.addInput ? checkboxNavRows(step) - 2 - (step.input ? 1 : 0) : -1;
}

/** Whether the cursor sits on a TYPING row of a checkbox step (steering or
 * add row) -- the adapter routes printable input there instead of treating
 * Space as toggle (exported: the adapter must not re-derive row indexes,
 * that would break when the add row shifts the steering row). */
export function checkboxTypingRow(step: WizardStepDef, cursor: number): boolean {
	if (step.kind !== "checkbox" || step.loading) return false;
	return (step.input !== undefined && cursor === checkboxInputRow(step))
		|| (step.addInput !== undefined && cursor === checkboxAddRow(step));
}

/** Rendered body rows of the submit tab: two lines per
 * step ("● Tab" + "→ value"), an optional note line, a reserved warning
 * slot, a blank separator, then the two actionable rows. */
function submitRowCount(state: WizardState): number {
	return state.steps.length * 2 + (state.submitNote ? 1 : 0) + 4;
}

/** Worst-case row count across all tabs (submit tab included) -- the
 * adapter pads every render to this so the overlay never changes height
 * (so the box never jumps while navigating). */
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
			formFieldDefs(step, state.formTexts[i]).forEach((field, f) => {
				answers[field.id] = state.formTexts[i][f] ?? "";
			});
		} else {
			answers[step.id] = state.chosen[i];
		}
	});
	return answers;
}

/** The text a text step SHOWS and submits (WYSIWYG): the user's own text,
 * or the live derived value while the step is untouched. */
export function effectiveText(state: WizardState, index: number): string {
	const step = state.steps[index];
	if (step.kind !== "text") return "";
	if (step.derive && !state.dirty[index]) return step.derive(rawAnswers(state));
	return state.texts[index];
}

/** The freeText option's inline value on a choice step: the user's
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

/** Whether the tab bar marks the step with a check (a mark
 * means "this carries a value that will run", NOT "this would not block" --
 * before, every text tab was checked from the start). */
export function stepAnswered(state: WizardState, index: number): boolean {
	const step = state.steps[index];
	return step.kind === "checkbox"
		? (step.defaultAll
			// Exclusion list: all or none checked = no filter = no value.
			? state.selected[index].size > 0 && state.selected[index].size < step.items.length
			: state.selected[index].size > 0)
		: step.kind === "text" ? effectiveText(state, index).trim() !== ""
		: step.kind === "form" ? state.formTexts[index].some((value) => value.trim() !== "")
		: state.chosen[index] !== null;
}

/** Next tab in the given direction. disabled steps stay VISITABLE
 * (they render their reason line) -- only advance() skips them, so the
 * Enter-through flow never stops on one. */
function movedTab(state: WizardState, dir: 1 | -1): number {
	return wrap(state.tab + dir, state.steps.length + 1);
}

/** Advance from the current step; the last enabled step leads to the
 * SUBMIT tab (never straight to done -- the user reviews first) --
 * unless skipSubmit is set (lightweight gates),
 * where it finishes directly through the same completeness guard. */
function advance(state: WizardState): WizardStep {
	let tab = state.tab;
	do {
		tab++;
	} while (tab < state.steps.length && !stepEnabled(state, tab));
	if (tab === state.steps.length && state.skipSubmit) return finish(state);
	return { state: { ...state, tab } };
}

/** Finishing (Enter on the submit row): an incomplete ENABLED step wins over the
 * submit -- the wizard jumps there instead. */
function finish(state: WizardState): WizardStep {
	for (let i = 0; i < state.steps.length; i++) {
		if (stepInvalid(state, i)) return { state: { ...state, tab: i } };
	}
	return { state, done: "confirmed" };
}

/** Control characters never enter a text value. Single-line inputs turn
 * pasted newlines into the question separator; MULTILINE question steps
 * keep them -- one question per line. */
/**
 * Unwrap a bracketed-paste chunk (pastes never
 * reached the dialogs). Terminals wrap pastes as \x1b[200~<text>\x1b[201~;
 * the installed pi-tui aggregates split stdin chunks upstream
 * (stdin-buffer.js) and re-wraps the COMPLETE paste into ONE handleInput
 * call (terminal.js), so both markers always arrive together here.
 * Returns the inner text with tabs as spaces (the control strip in
 * sanitizeInput would delete tabs and glue the words together); \r
 * newlines need no handling here -- sanitizeInput normalizes them per
 * step kind. Null when the chunk is not a paste or the paste is empty.
 */
export function pasteText(data: string): string | null {
	if (!data.startsWith("\x1b[200~")) return null;
	const end = data.indexOf("\x1b[201~");
	const inner = (end === -1 ? data.slice(6) : data.slice(6, end)).replace(/\t/g, " ");
	return inner.length ? inner : null;
}

/**
 * Animated ellipsis for loading notes (a running
 * fetch should LOOK alive): the note's final "..." becomes 1-2-3 dots
 * cycling with the tick. Notes without an ellipsis return unchanged.
 * Pure -- the adapter owns the timer and re-renders.
 */
export function animateEllipsis(note: string, tick: number): string {
	const at = note.lastIndexOf("...");
	if (at === -1) return note;
	return note.slice(0, at) + ".".repeat(1 + (tick % 3)) + note.slice(at + 3);
}

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
	// Choice step with the cursor on a free-entry option: typing edits
	// that option's inline value, stored in texts[tab].
	const onFreeText = current?.kind === "choice" && current.options[cursor]?.freeText === true;
	// Checkbox step with the cursor on the steering input row:
	// typing edits the DRAFT in texts[tab]; Enter commits it.
	const onCheckboxInput = current?.kind === "checkbox" && !current.loading
		&& current.input !== undefined && cursor === checkboxInputRow(current);
	// Checkbox step with the cursor on the ADD row: typing
	// edits the draft in addTexts[tab]; Enter adds it as a checked item.
	const onCheckboxAdd = current?.kind === "checkbox" && !current.loading
		&& current.addInput !== undefined && cursor === checkboxAddRow(current);
	// Editing a derive step (or a seeded freeText row) takes ownership: from
	// the first keystroke on (backspace included) the user's text wins over
	// the derived/seeded value.
	const withText = (value: string): WizardState => ({
		...state,
		texts: state.texts.map((prev, i) => (i === state.tab ? value : prev)),
		dirty: state.dirty.map((prev, i) => (i === state.tab ? true : prev)),
	});
	// The form cursor may sit on the ADD row (no field there): editing maps
	// through formFieldIndex, -1 means no edit target.
	const formIndex = current?.kind === "form"
		? formFieldIndex(current, state.formTexts[state.tab], cursor)
		: -1;
	const withFormText = (value: string): WizardState => ({
		...state,
		formTexts: state.formTexts.map((fields, i) =>
			(i === state.tab ? fields.map((prev, f) => (f === formIndex ? value : prev)) : fields)),
	});
	const withAddText = (value: string): WizardState => ({
		...state,
		addTexts: state.addTexts.map((prev, i) => (i === state.tab ? value : prev)),
	});
	const editedValue = onText ? effectiveText(state, state.tab)
		: onForm ? (formIndex >= 0 ? state.formTexts[state.tab][formIndex] ?? "" : null)
		: onFreeText ? effectiveChoiceText(state, state.tab)
		: onCheckboxAdd ? state.addTexts[state.tab]
		: onCheckboxInput ? state.texts[state.tab]
		: null;
	// Runtime item replacement (lazily loaded checkbox lists):
	// independent of the current tab; pruned selection, clamped cursor.
	if (typeof event === "object" && event.kind === "setItems") {
		const index = state.steps.findIndex((other) => other.id === event.step && other.kind === "checkbox");
		if (index < 0) return { state };
		const target = state.steps[index] as WizardStepDef & { kind: "checkbox" };
		const selectedOld = state.selected[index];
		// keepSelected: checked rows the new list no longer
		// carries are APPENDED with their old label/flags instead of pruned
		// -- picked query-variant suggestions survive a regeneration (and
		// stay visible during the loading dispatch's empty item list).
		const newKnown = new Set(event.items.map((item) => item.id));
		const orphans = target.keepSelected
			? target.items.filter((item) => selectedOld.has(item.id) && !newKnown.has(item.id))
			: [];
		const items = [...event.items, ...orphans];
		const known = new Set(items.map((item) => item.id));
		// Exclusion-list memory: every OLD row that is unticked joins it, a
		// re-checked row leaves it -- so the loading swap (empty items)
		// carries the user's removals over to the resolved list.
		const excluded = new Set(target.excludedIds ?? []);
		for (const item of target.items) {
			if (selectedOld.has(item.id)) excluded.delete(item.id);
			else excluded.add(item.id);
		}
		const steps = state.steps.map((other, i) => (i === index && other.kind === "checkbox"
			? {
				...other,
				items,
				...(other.defaultAll ? { excludedIds: [...excluded] } : {}),
				// Any dispatch without the flag CLEARS loading -- the
				// resolved/failed swaps need no extra bookkeeping.
				loading: event.loading === true,
				...(event.emptyNote !== undefined ? { emptyNote: event.emptyNote } : {}),
			}
			: other));
		const next = steps[index] as WizardStepDef & { kind: "checkbox" };
		// preselect seeds only while the PRE-union selection is empty (first
		// load); locked ids are unioned AFTERWARDS -- otherwise the locked
		// base row would make the selection permanently non-empty and an
		// agent proposal could never precheck.
		const seeded = [...(selectedOld.size ? [...selectedOld] : event.preselect ?? [])]
			.filter((id) => known.has(id));
		// defaultAll: a proposal (preselect) is a whitelist on the first
		// load; otherwise everything not remembered as unticked is checked.
		const selected = target.defaultAll && !(event.preselect?.length && !selectedOld.size && !excluded.size)
			? new Set(items.filter((item) => !excluded.has(item.id) || item.locked).map((item) => item.id))
			: new Set([...seeded, ...items.filter((item) => item.locked).map((item) => item.id)]);
		// Cursor follows its ROLE across the item swap: Next row
		// stays Next, the steering row stays the steering row -- an
		// Enter-through user parked on Next must not land mid-list when the
		// suggestions arrive.
		const oldCursor = state.cursors[index];
		const cursorRow = oldCursor === checkboxNavRows(target) - 1 ? checkboxNavRows(next) - 1
			: target.input && oldCursor === checkboxInputRow(target) ? checkboxInputRow(next)
			: target.addInput && oldCursor === checkboxAddRow(target) ? checkboxAddRow(next)
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
		return { state: onForm ? withFormText(value) : onCheckboxAdd ? withAddText(value) : withText(value) };
	}
	if (event === "backspace") {
		if (editedValue === null) return { state };
		const value = editedValue.slice(0, -1);
		return { state: onForm ? withFormText(value) : onCheckboxAdd ? withAddText(value) : withText(value) };
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
	// A visited DISABLED step: only navigation works; Enter advances
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
	// Cursor range: checkbox and form steps use their NAV rows (fields plus
	// the add row on grow forms; separator/note rows and the height budget
	// stay in rowCount -- else dim lines become dead cursor rows).
	const rows = step.kind === "checkbox" ? checkboxNavRows(step)
		: step.kind === "form" ? formNavRows(step, state.formTexts[state.tab])
		: rowCount(step);
	const withCursor = withCursorAt;
	const toggled = (): WizardState => {
		// Only the select-all row and real item rows carry check state --
		// the steering input row and the Next row do not. While loading,
		// nothing toggles (only the note is visible).
		if (step.kind !== "checkbox" || step.loading || cursor > step.items.length) return state;
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
				// While loading, the only visible row is the note -- Enter
				// advances so the Enter-through flow never waits on the
				// model.
				if (step.loading) return advance(state);
				// Enter on the steering row COMMITS the draft and stays
				//: the committed value + bumped counter reach the
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
				// Enter on the ADD row: the trimmed draft becomes
				// a CHECKED item (an existing id just gets checked -- case-
				// insensitive) and the draft clears; empty draft = no-op. With
				// keepSelected the added row survives regenerations.
				if (onCheckboxAdd) {
					const draft = state.addTexts[state.tab].trim();
					if (!draft) return { state };
					const existing = step.items.find((item) => item.id.toLowerCase() === draft.toLowerCase());
					const items = existing ? step.items : [...step.items, { id: draft, label: draft }];
					const id = existing ? existing.id : draft;
					const steps = state.steps.map((other, i) => (i === state.tab && other.kind === "checkbox"
						? { ...other, items }
						: other));
					const grown = steps[state.tab] as WizardStepDef & { kind: "checkbox" };
					return {
						state: {
							...state,
							steps,
							selected: state.selected.map((set, i) =>
								(i === state.tab ? new Set([...set, id]) : set)),
							addTexts: state.addTexts.map((prev, i) => (i === state.tab ? "" : prev)),
							// The list grew by one row -- the cursor FOLLOWS the
							// add row so the next variant can be typed directly.
							cursors: state.cursors.map((value, i) =>
								(i === state.tab ? checkboxAddRow(grown) : value)),
						},
					};
				}
				// An empty OPTIONAL list advances from any row (the
				// lazily loaded journal list must never stall Enter-through).
				if (step.items.length === 0 && step.optional) return advance(state);
				// Enter toggles like Space on real rows; only the explicit
				// next-row commits.
				// An OPTIONAL step commits empty (empty = "no filter").
				if (cursor < rows - 1) return { state: toggled() };
				if (state.selected[state.tab].size === 0 && !step.optional) return { state };
				return advance(state);
			}
			if (step.kind === "text") {
				// MULTILINE question steps: Enter opens a new line; Enter on a BLANK
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
				const values = state.formTexts[state.tab];
				const addRow = formAddRow(step, values);
				// Enter on the ADD row appends one empty grow field. It takes
				// the add row's spot (the row moves below, or hides at the
				// cap), so the unchanged cursor lands on the new field.
				if (cursor === addRow) {
					const grown = values.length - step.fields.length;
					return {
						state: {
							...state,
							formTexts: state.formTexts.map((fields, i) =>
								(i === state.tab
									? [...fields.slice(0, grown), "", ...fields.slice(grown)]
									: fields)),
						},
					};
				}
				// Enter on a FILLED field walks to the next one -- SKIPPING the
				// add row (Enter-through must never add a block by accident);
				// Enter on an empty field (or the last) leaves the step, so an
				// untouched tab passes with ONE stroke (every field is
				// optional, empty means "filter off").
				const index = formFieldIndex(step, values, cursor);
				const filled = (values[index] ?? "").trim() !== "";
				if (filled && cursor < rows - 1) {
					const next = cursor + 1 === addRow ? cursor + 2 : cursor + 1;
					if (next < rows) return { state: withCursor(next) };
				}
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
			formFieldDefs(step, state.formTexts[i]).forEach((field, f) => {
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
	/** Tab bar entries in step order; disabled tabs stay listed and
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
		if (step.defaultAll) {
			// Exclusion list: name what is OUT; all or none = no filter.
			const out = step.items.filter((item) => !state.selected[i].has(item.id));
			return chosen.length === 0 || all ? text.allKept : text.excluded(out.map((item) => item.label));
		}
		// Optional steps: empty is a decision, not an open question.
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
		// An injected summary (the composed query) beats the field join --
		// the review page must show what actually runs (WYSIWYG).
		if (step.summary) {
			const line = step.summary(state.formTexts[i]).trim();
			return line ? line : text.noQuestions;
		}
		const set = formFieldDefs(step, state.formTexts[i])
			.map((field, f) => ({ field, value: (state.formTexts[i][f] ?? "").trim() }))
			.filter((entry) => entry.value !== "")
			.map((entry) => `${entry.field.label} ${entry.value}`);
		return set.length ? set.join(" · ") : text.noQuestions;
	}
	const chosen = step.options.find((option) => option.value === state.chosen[i]);
	if (chosen && !chosen.freeText) {
		// Label and description together carry the full picture (a label
		// may be the substance and the description its explanation).
		const answers = wizardAnswers(state);
		const label = optionLabel(chosen, answers);
		const description = optionDescription(chosen, answers);
		return description ? `${label} -- ${description}` : label;
	}
	// A free-entry answer matches no option: show the typed value.
	return state.chosen[i] ?? text.unanswered;
}

/** Pure presentation of the current tab; the adapter only adds colors,
 * borders and the constant-height padding. */
export function wizardView(state: WizardState): WizardView {
	// Tab bar: steps carry a filled square once they HOLD A VALUE (a mark
	// meaning "would not block" would check every text tab from the
	// start), an
	// empty square while open; the review tab carries a check. Disabled
	// steps STAY in the bar greyed out (a tab's visibility must never
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
		// The review layout: "● Tab" + "→ value" per step, the note,
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
	// A visited disabled step shows its reason instead of its rows.
	// The reason is a WARNING row: yellow with the ⚠ sign,
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
			// The steering input row, form-style: label + draft.
			if (!step.input) return;
			if (step.spaced) rows.push({ text: "", active: false });
			const active = cursor === checkboxInputRow(step);
			const draft = state.texts[state.tab];
			rows.push({
				text: `${active ? "❯ " : "  "}   ${step.input.label}: ${draft}${active ? "_" : ""}`,
				active,
			});
		};
		const pushAddRow = (): void => {
			// The add row: type an own entry, Enter checks it in.
			if (!step.addInput) return;
			if (step.spaced) rows.push({ text: "", active: false });
			const active = cursor === checkboxAddRow(step);
			const draft = state.addTexts[state.tab];
			rows.push({
				text: `${active ? "❯ " : "  "}   ${step.addInput.label}: ${draft}${active ? "_" : ""}`,
				active,
			});
		};
		const nextActive = cursor === checkboxNavRows(step) - 1;
		if (step.loading) {
			// Loading: ONLY the pulsing note -- no
			// select-all, no rows, no inputs -- so the load is unmistakable.
			// Enter still advances (see the confirm guard); items/selection
			// live on untouched underneath and reappear with the swap.
			rows.push({ text: `     ${step.emptyNote ?? ""}`, active: false, dim: true });
		} else if (step.items.length === 0) {
			// Lazily loaded list before/without items: the note says
			// why it is empty; the next-row keeps Enter-through working.
			rows.push({ text: `     ${step.emptyNote ?? ""}`, active: false, dim: true });
			pushAddRow();
			pushInputRow();
			rows.push({ text: `${nextActive ? "❯ " : "  "}   ${step.nextLabel}`, active: nextActive });
		} else {
			// Reload status (a re-load after a query
			// edit was INVISIBLE -- kept checked rows fill the list and the
			// note only rendered on an empty one, so the user stared at stale
			// suggestions with no sign of work). A non-empty note now renders
			// as a dim status line with items present too -- ABOVE the list,
			// the same top position the empty-list note has; the resolved
			// setItems clears it ("" on success).
			if (step.emptyNote) rows.push({ text: `     ${step.emptyNote}`, active: false, dim: true });
			const checkboxState: CheckboxState = {
				items: step.items,
				cursor,
				selected: state.selected[state.tab],
			};
			rows.push(...checkboxLines(checkboxState, step.selectAllLabel, step.spaced === true, step.allSelectedLabel));
			pushAddRow();
			pushInputRow();
			rows.push({ text: `${nextActive ? "❯ " : "  "}   ${step.nextLabel}`, active: nextActive });
		}
	} else if (step.kind === "text") {
		const value = effectiveText(state, state.tab);
		if (step.plain) {
			rows.push({ text: `❯ ${value}_`, active: true });
			// Plain inputs (query, years, grouping) get no question counter --
			// only the placeholder while empty; the info line renders
			// dim (the example query in grey).
			rows.push({
				text: !value ? `     ${step.placeholder ?? ""}` : "",
				active: false,
				dim: true,
			});
		} else {
			// MULTILINE question step: one question per line, the
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
		const values = state.formTexts[state.tab];
		const defs = formFieldDefs(step, values);
		const grown = step.grow ? values.length - step.fields.length : 0;
		const addRow = formAddRow(step, values);
		const pushField = (i: number, row: number): void => {
			const active = cursor === row;
			rows.push({
				text: `${active ? "❯ " : "  "}${defs[i].label}: ${values[i] ?? ""}${active ? "_" : ""}`,
				active,
			});
		};
		for (let i = 0; i < grown; i++) pushField(i, i);
		if (step.grow) {
			// The explicit add row under the grow fields; hides at the cap.
			if (addRow >= 0) {
				const active = cursor === addRow;
				rows.push({
					text: `${active ? "❯ " : "  "}   ${step.grow.addLabel}`,
					active,
					...(active ? {} : { dim: true }),
				});
			}
			// Blank separator before the static fields (never a cursor stop).
			if (step.fields.length) rows.push({ text: "", active: false });
		}
		const offset = addRow >= 0 ? 1 : 0;
		for (let i = grown; i < defs.length; i++) pushField(i, i + offset);
		// Reserved status row under the fields (the both-filled warning):
		// present whenever note is defined so the footprint stays constant
		// while the warning toggles; never a cursor stop.
		if (step.note) {
			const note = step.note(values);
			rows.push(note
				? {
					text: `   ${note.warn ? "⚠ " : ""}${note.text}`,
					active: false,
					...(note.warn ? { warn: true } : { dim: true }),
				}
				: { text: "", active: false, dim: true });
		}
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
			// An explanation line under the label --
			// dim, unless the option marks it as substance (the
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
 * Width-aware word wrap for ONE dialog line: continuation lines carry a
 * hanging indent (the line's leading whitespace + 4, so wrapped query
 * variants read as one entry), words stay whole where possible (a token
 * longer than the room is cut hard). Very narrow widths fall back to a
 * hard "…" clip -- wrapping cannot help there. The overlay adapter wraps
 * every title/body row with this instead of clipping, so long block
 * expressions stay fully readable in narrow terminals.
 */
export function wrapLine(text: string, width: number): string[] {
	if (width <= 10) {
		return [width > 1 && text.length > width ? `${text.slice(0, width - 1)}…` : text];
	}
	if (text.length <= width) return [text];
	const lead = /^\s*/.exec(text)?.[0].length ?? 0;
	const indent = " ".repeat(Math.min(lead + 4, width - 10));
	const lines: string[] = [];
	let rest = text;
	let first = true;
	for (;;) {
		const room = first ? width : width - indent.length;
		if (rest.length <= room) {
			lines.push(first ? rest : indent + rest);
			break;
		}
		let cut = rest.lastIndexOf(" ", room);
		if (cut <= 0) cut = room;
		lines.push(first ? rest.slice(0, cut) : indent + rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^ +/, "");
		first = false;
	}
	return lines;
}

/**
 * Questions separated by SEMICOLON or newline ("one per
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
