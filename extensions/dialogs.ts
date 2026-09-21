/**
 * The wizard dialog shared by all three adapters (runWizard) plus the
 * chat-language observer. The look follows Claude-Code-style question
 * dialogs: one overlay with a tab bar, checkboxes, choices, text and form
 * steps, a review page. All decisions live in the pure reducer
 * src/dialog-state.ts; this file only mounts UI.
 *
 * Mode ladder (the guard is ctx.mode === "tui", NOT hasUI -- in RPC mode
 * hasUI is true but ctx.ui.custom() returns undefined):
 *   tui       ctx.ui.custom overlay (bottom-anchored) with pi-tui key
 *             matching; pi-tui is imported lazily and any import/mount
 *             failure falls back one rung
 *   rpc/other a ctx.ui.select LOOP per step: [x]/[ ] rows + select-all +
 *             an explicit done row; every pick toggles and reopens
 *   headless  callers must pass parameters; runWizard throws
 *
 * Cancel is always null -- callers abort the WHOLE run before any LLM call.
 */

import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	animateEllipsis,
	type CheckboxItem,
	checkboxTypingRow,
	choiceFieldRow,
	detectDialogLang,
	DIALOG_TEXT,
	type DialogLang,
	initWizard,
	maxWizardRows,
	parseQuestionLines,
	pasteText,
	reduceWizard,
	type WizardAnswers,
	type WizardEvent,
	type WizardItemLoader,
	type WizardOptions,
	type WizardResult,
	type WizardStepDef,
	type WizardView,
	withQueryNumbers,
	wizardAnswers,
	wizardResult,
	wizardView,
	wrapLine,
} from "../src/dialog-state.ts";

/** The few adapter-owned strings, per dialog language (dialogs follow
 * the chat's language; English is the default). */
const ADAPTER_TEXT: Record<DialogLang, {
	checkboxHint: string;
	doneRow: string;
	backRow: string;
	nothingSelected: string;
	firstOf: (shown: number, total: number) => string;
	formDoneRow: string;
	formOff: string;
}> = {
	de: {
		checkboxHint: "Space auswählen · Enter übernehmen · Esc abbrechen · ↑/↓ navigieren",
		doneRow: "Fertig -- Auswahl übernehmen",
		backRow: "← Zurück",
		nothingSelected: "Nichts ausgewählt -- mindestens einen Eintrag wählen oder mit Esc abbrechen.",
		firstOf: (shown, total) => `(erste ${shown} von ${total})`,
		formDoneRow: "Weiter -- Eingaben übernehmen",
		formOff: "(aus)",
	},
	en: {
		checkboxHint: "Space selects · Enter confirms · Esc cancels · ↑/↓ navigate",
		doneRow: "Done -- apply selection",
		backRow: "← Back",
		nothingSelected: "Nothing selected -- pick at least one entry or cancel with Esc.",
		firstOf: (shown, total) => `(first ${shown} of ${total})`,
		formDoneRow: "Continue -- apply entries",
		formOff: "(off)",
	},
};

/** Fallback list cap of the select loop. */
const FALLBACK_MAX_ITEMS = 25;

interface CheckboxListOptions {
	title: string;
	items: CheckboxItem[];
	/** Label of the derived summary row, e.g. "Select all". */
	selectAllLabel: string;
	/** Head-row label while everything is checked (exclusion lists). */
	allSelectedLabel?: string;
	/** Ids to preselect (e.g. the session's sticky scope). */
	preselected?: string[];
	lang?: DialogLang;
	signal?: AbortSignal;
}

/** Mandatory non-TUI path: a numbered select that toggles and reopens.
 * With backRow set it can also resolve to "back" (wizard navigation). */
async function checkboxSelectLoop(
	ctx: ExtensionContext,
	options: CheckboxListOptions & { backRow?: boolean; allowEmpty?: boolean },
): Promise<string[] | "back" | null> {
	const shown = options.items.slice(0, FALLBACK_MAX_ITEMS);
	const known = new Set(shown.map((item) => item.id));
	// Locked rows (the variants tab's base query) are always selected --
	// seeded here, never removable below.
	const selected = new Set([
		...(options.preselected ?? []).filter((id) => known.has(id)),
		...shown.filter((item) => item.locked).map((item) => item.id),
	]);
	const adapterText = ADAPTER_TEXT[options.lang ?? "en"];
	const doneRow = adapterText.doneRow;
	const backRow = adapterText.backRow;
	for (;;) {
		const all = shown.length > 0 && shown.every((item) => selected.has(item.id));
		const rows = [
			`[${all ? "x" : " "}] ${all && options.allSelectedLabel ? options.allSelectedLabel : options.selectAllLabel}`,
			// The select-loop has no dim second line; the description joins
			// the row so the metadata survives the fallback.
			...shown.map((item) =>
				`[${selected.has(item.id) ? "x" : " "}] ${item.label}${item.description !== undefined ? ` -- ${item.description}` : ""}`),
			doneRow,
			...(options.backRow ? [backRow] : []),
		];
		const title = options.items.length > shown.length
			? `${options.title} ${adapterText.firstOf(shown.length, options.items.length)}`
			: options.title;
		const picked = await ctx.ui.select(title, rows, { signal: options.signal });
		if (picked === undefined) return null;
		if (picked === backRow) return "back";
		const index = rows.indexOf(picked);
		if (index === 0) {
			// Select-all "off" keeps locked rows -- they are not optional.
			if (all) {
				for (const item of shown) {
					if (!item.locked) selected.delete(item.id);
				}
			} else for (const item of shown) selected.add(item.id);
			continue;
		}
		if (picked === doneRow) {
			if (!selected.size) {
				// Optional steps: empty is a valid answer.
				if (options.allowEmpty) return [];
				ctx.ui.notify(adapterText.nothingSelected, "warning");
				continue;
			}
			return shown.filter((item) => selected.has(item.id)).map((item) => item.id);
		}
		const item = shown[index - 1];
		if (item.locked) continue; // always selected, not toggleable
		if (selected.has(item.id)) selected.delete(item.id);
		else selected.add(item.id);
	}
}

/* ------------------------------------------------------------------ *
 * Wizard -- ONE dialog over several steps (rpiv semantics)             *
 * ------------------------------------------------------------------ */

/**
 * The whole intake as ONE dialog (a chain of separate dialogs jumps
 * around and has no way back). TUI: one bottom-anchored overlay with a tab
 * bar, Tab/arrow navigation between steps, and a CONSTANT footprint
 * (padded to the tallest step, so the box never jumps). Text steps type
 * inline; steps with enabledIf are greyed out while their condition fails.
 * Fallback: one select (or editor) per step with an explicit back row.
 * Null on cancel -- callers abort before any LLM call. Options: submitNote
 * renders one computed line on the submit page (e.g. the expected
 * model-call count); skipSubmit finishes directly after the last step
 * (one-step gates).
 */
export async function runWizard(
	ctx: ExtensionContext,
	steps: WizardStepDef[],
	signal?: AbortSignal,
	options?: WizardOptions,
): Promise<WizardResult | null> {
	if (!ctx.hasUI) throw new Error("runWizard needs a UI -- headless callers must pass parameters");
	if (ctx.mode === "tui") {
		try {
			const result = await wizardOverlay(ctx, steps, options);
			if (result !== undefined) return result;
		} catch {
			// pi-tui unavailable or the overlay failed -- fall through.
		}
	}
	return wizardSelectLoop(ctx, steps, signal, options);
}

async function wizardOverlay(
	ctx: ExtensionContext,
	steps: WizardStepDef[],
	options?: WizardOptions,
): Promise<WizardResult | null | undefined> {
	const { Key, matchesKey } = await import("@earendil-works/pi-tui");
	return await ctx.ui.custom<WizardResult | null>(
		(tui, theme, _keybindings, done) => {
			let state = initWizard(steps, options);
			let finished = false;
			const paint = (color: ThemeColor, text: string): string => {
				try {
					return theme.fg(color, text);
				} catch {
					return text;
				}
			};
			// Lazily loaded checkbox items (journal, author and variants
			// tabs): when the user reaches a loader's tab, fetch with the LIVE
			// answers and dispatch setItems; a changed key (edited query)
			// re-fetches on the next visit. The reducer stays pure -- all IO
			// lives here.
			const loadedKeys = new Map<string, string>();
			// Loading pulse: while a loader is in flight, the note's trailing
			// dots build up 1-2-3 on a timer. The timer lives HERE -- the
			// reducer stays pure and only ever sees complete setItems events;
			// it stops itself when nothing is loading or the overlay finished.
			// The dispatches carry loading:true, so the view shows ONLY the
			// pulsing note while a load runs.
			const loadingNotes = new Map<string, { loader: WizardItemLoader; note: string; keep: CheckboxItem[] }>();
			// setItems for a loader: parent loaders swap only that item's
			// child rows and put their status under the parent (the code
			// tab's list topics); group loaders swap their group (anchored
			// under `after`, exclusion rows arrive ticked); plain loaders
			// replace the whole list.
			const itemsEvent = (loader: WizardItemLoader, items: CheckboxItem[], note: string, extra: { loading?: boolean; preselect?: string[] } = {}) =>
				(loader.parent !== undefined
					? { kind: "setItems" as const, step: loader.step, parent: loader.parent, items, note, ...extra }
					: loader.group !== undefined
						? {
							kind: "setItems" as const, step: loader.step, group: loader.group, items, note, ...extra,
							...(loader.after !== undefined ? { after: loader.after } : {}),
							...(loader.arriveChecked ? { arriveChecked: true } : {}),
						}
						: { kind: "setItems" as const, step: loader.step, items, emptyNote: note, ...extra });
			// Debounced loaders (the author lookup keyed on the live typing):
			// the load starts only after a pause; a newer key cancels the
			// pending one. Keyed per loader (step + section).
			const loaderId = (loader: WizardItemLoader): string => `${loader.step}\u0000${loader.parent ?? ""}\u0000${loader.group ?? ""}`;
			const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
			let loadTick = 0;
			let loadTimer: ReturnType<typeof setInterval> | undefined;
			const syncLoadTimer = (): void => {
				if (loadingNotes.size && loadTimer === undefined) {
					loadTimer = setInterval(() => {
						if (finished || !loadingNotes.size) {
							clearInterval(loadTimer);
							loadTimer = undefined;
							return;
						}
						loadTick += 1;
						for (const [, entry] of loadingNotes) {
							state = reduceWizard(state, itemsEvent(entry.loader, entry.keep, animateEllipsis(entry.note, loadTick), { loading: true })).state;
						}
						tui.requestRender();
					}, 400);
				} else if (!loadingNotes.size && loadTimer !== undefined) {
					clearInterval(loadTimer);
					loadTimer = undefined;
				}
			};
			// Rows a group loader keeps on screen while it loads: the ticked
			// ones (a picked author must not blink away during the next
			// lookup). Whole-list and parent loaders clear their section.
			const keptRows = (loader: WizardItemLoader): CheckboxItem[] => {
				if (loader.group === undefined) return [];
				const index = state.steps.findIndex((step) => step.id === loader.step);
				const step = state.steps[index];
				if (!step || step.kind !== "checkbox") return [];
				return step.items.filter((item) => item.group === loader.group && state.selected[index].has(item.id));
			};
			const startLoad = (loader: WizardItemLoader, key: string, answers: WizardAnswers): void => {
				const id = loaderId(loader);
				state = reduceWizard(state, itemsEvent(loader, keptRows(loader), animateEllipsis(loader.loadingNote, loadTick), { loading: true })).state;
				loadingNotes.set(id, { loader, note: loader.loadingNote, keep: keptRows(loader) });
				syncLoadTimer();
				tui.requestRender();
				loader.load(answers).then((items) => {
					// The stale-guard also protects loadingNotes: an OLD
					// promise resolving after a re-keyed load must not stop
					// the pulse of the load still in flight.
					if (finished || loadedKeys.get(id) !== key) return;
					loadingNotes.delete(id);
					syncLoadTimer();
					state = reduceWizard(state, itemsEvent(loader, items, items.length ? "" : loader.emptyNote,
						loader.preselect ? { preselect: loader.preselect(items) } : {})).state;
					tui.requestRender();
				}).catch((error) => {
					if (finished || loadedKeys.get(id) !== key) return;
					loadingNotes.delete(id);
					syncLoadTimer();
					state = reduceWizard(state, itemsEvent(loader, keptRows(loader), loader.failedNote(error instanceof Error ? error.message : String(error)))).state;
					tui.requestRender();
				});
			};
			const maybeLoadItems = (): void => {
				for (const loader of options?.itemLoaders ?? []) {
					const index = state.steps.findIndex((step) => step.id === loader.step);
					if (index < 0 || state.tab !== index) continue;
					const id = loaderId(loader);
					const answers = wizardAnswers(state);
					const key = loader.key(answers);
					if (key === loadedKeys.get(id)) continue;
					loadedKeys.set(id, key);
					const pending = debounceTimers.get(id);
					if (pending !== undefined) {
						clearTimeout(pending);
						debounceTimers.delete(id);
					}
					if (!key) {
						loadingNotes.delete(id);
						syncLoadTimer();
						state = reduceWizard(state, itemsEvent(loader, keptRows(loader), loader.idleNote)).state;
						continue;
					}
					if (loader.debounceMs) {
						debounceTimers.set(id, setTimeout(() => {
							debounceTimers.delete(id);
							if (finished || loadedKeys.get(id) !== key) return;
							startLoad(loader, key, answers);
						}, loader.debounceMs));
						continue;
					}
					startLoad(loader, key, answers);
				}
			};
			maybeLoadItems();
			return {
				render(width: number): string[] {
					const clip = (line: string): string => (width > 1 && line.length > width ? `${line.slice(0, width - 1)}…` : line);
					const view = wizardView(state);
					// Long title/body rows WRAP instead of clipping (query
					// variants are wide block expressions -- a hard clip made
					// them unreadable in narrow terminals). The pad target is
					// the TALLEST tab's wrapped height at this width, floored by
					// the row budget, so the box never changes height while
					// navigating; it can still grow when loaded items or added
					// fields grow the content (recomputed per render).
					const measure = (v: WizardView): number =>
						wrapLine(v.title, width).length
						+ v.rows.reduce((n, row) => n + wrapLine(row.text, width).length, 0);
					let target = 1 + maxWizardRows(state);
					for (let t = 0; t <= state.steps.length; t++) {
						target = Math.max(target, measure(t === state.tab ? view : wizardView({ ...state, tab: t })));
					}
					const rule = paint("borderAccent", "─".repeat(Math.max(1, width)));
					// The tab bar: arrows at both ends, the active tab bracketed
					// + accent, disabled tabs parenthesized + dim (greyed out,
					// not hidden; the reason shows on visiting). NO raw ANSI
					// here: a hand-rolled escape breaks pi-tui's width
					// accounting. The bar is measured on its VISIBLE text
					// (clip() on the painted string would count color escape
					// bytes as characters); a bar too wide for the terminal
					// falls back to plain clipped text rather than lying.
					const tabParts = view.tabs.map((tab) => (tab.active
						? { plain: `[${tab.label}]`, painted: paint("accent", `[${tab.label}]`) }
						: tab.disabled
							? { plain: `(${tab.label})`, painted: paint("dim", `(${tab.label})`) }
							: { plain: ` ${tab.label} `, painted: paint("dim", ` ${tab.label} `) }));
					const plainBar = `← ${tabParts.map((part) => part.plain).join(" ")} →`;
					const tabBar = width > 1 && plainBar.length > width
						? clip(plainBar)
						: `${paint("dim", "←")} ${tabParts.map((part) => part.painted).join(" ")} ${paint("dim", "→")}`;
					// tabBar is already width-safe on its VISIBLE length -- never
					// clip() the painted string again. Header line naming the
					// dialog: the overlay is anchored to the bottom of the
					// terminal, far from the command the user typed -- so it
					// says where you are.
					const titleLines = wrapLine(view.title, width).map((line) => paint("accent", line));
					const lines: string[] = options?.header
						? [paint("accent", clip(options.header)), rule, tabBar, "", ...titleLines]
						: [rule, tabBar, "", ...titleLines];
					// Standalone uppercase boolean operators get their own
					// colors on PLAIN rows (query-tab field values, variant
					// expressions) so the surrounding terms read more easily:
					// AND green, OR blue (user choice 2026-09-02; "success" and
					// "mdLink" are the theme-defined green and blue), NOT keeps
					// the keyword color. Applied AFTER wrapping (adds only
					// zero-width SGR bytes, width accounting untouched) and only
					// on unpainted rows -- active/warn/dim rows keep their one
					// whole-row color as the state signal.
					const OP_COLORS: Record<string, ThemeColor> = { AND: "success", OR: "mdLink", NOT: "syntaxKeyword" };
					const colorOps = (line: string): string =>
						line.replace(/\b(AND|OR|NOT)\b/g, (op) => paint(OP_COLORS[op], op));
					let body = 0;
					// Loading status lines: dim text, the pulsing trailing dots in
					// the accent color (a grey pulse was easy to miss). Theme
					// colors only, applied per wrapped line -- the dots sit on the
					// last one.
					const pulseLine = (line: string): string => {
						const match = /^(.*?)(\.{1,3})$/.exec(line);
						return match ? paint("dim", match[1]) + paint("accent", match[2]) : paint("dim", line);
					};
					for (const row of view.rows) {
						for (const line of wrapLine(row.text, width)) {
							lines.push(row.active ? paint("accent", line)
								: row.warn ? paint("warning", line)
								: row.pulse ? pulseLine(line)
								: row.dim ? paint("dim", line)
								: colorOps(line));
							body += 1;
						}
					}
					// Constant footprint: pad to the tallest wrapped tab so the
					// box never changes height while navigating.
					for (let i = titleLines.length + body; i < target; i++) lines.push("");
					lines.push(rule, paint("dim", clip(view.hint)));
					return lines;
				},
				invalidate(): void {},
				handleInput(data: string): void {
					// In an input context, unmatched printable input TYPES
					// (space included): text steps, form fields, and a choice
					// step whose cursor sits on a free-entry option. Everywhere
					// else space toggles and other unmatched input is ignored.
					const active = state.tab < state.steps.length ? state.steps[state.tab] : undefined;
					const onText = active !== undefined && (active.kind === "text" || active.kind === "form"
						|| (active.kind === "choice" && active.options[state.cursors[state.tab]]?.freeText === true)
						// the companion field under a choice list types too
						|| choiceFieldRow(active, state.cursors[state.tab])
						// Checkbox typing rows (steering row, add row): Space must
						// TYPE there, not toggle. The row indexes live in the
						// pure layer (checkboxTypingRow), never re-derived here.
						|| checkboxTypingRow(active, state.cursors[state.tab]));
					// Bracketed paste: a paste arrives as ONE chunk wrapped in
					// \x1b[200~...\x1b[201~ (pi-tui aggregates split chunks and
					// re-wraps the complete paste before handleInput); without
					// unwrapping, the leading-ESC guard below would discard every
					// paste. Where typing types, the inner text feeds the reducer
					// (sanitizeInput handles pasted newlines per step kind);
					// everywhere else a paste stays ignored like unmatched input.
					const pasted = onText ? pasteText(data) : null;
					const event: WizardEvent | null = pasted !== null ? { kind: "input", chars: pasted }
						: matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) ? "cancel"
						: matchesKey(data, Key.enter) ? "confirm"
						: matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")) ? "left"
						: matchesKey(data, Key.right) || matchesKey(data, Key.tab) ? "right"
						: matchesKey(data, Key.up) ? "up"
						: matchesKey(data, Key.down) ? "down"
						: onText && (data === "\x7f" || data === "\b" || data === "\x08") ? "backspace"
						: onText && !data.startsWith("\x1b") ? { kind: "input", chars: data }
						: data === " " ? "toggle"
						: null;
					if (!event) return;
					const step = reduceWizard(state, event);
					state = step.state;
					if (step.done === "confirmed") {
						finished = true;
						loadingNotes.clear();
						for (const timer of debounceTimers.values()) clearTimeout(timer);
						syncLoadTimer();
						done(wizardResult(state));
					} else if (step.done === "cancelled") {
						finished = true;
						loadingNotes.clear();
						for (const timer of debounceTimers.values()) clearTimeout(timer);
						syncLoadTimer();
						done(null);
					} else {
						maybeLoadItems();
						tui.requestRender();
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: { left: 0, right: 0, bottom: 0 } },
		},
	);
}

/** Mandatory non-TUI path: one select (or editor, for text steps) per
 * step, with an explicit back row (answers are kept across steps,
 * mirroring the overlay's tab navigation). Steps whose enabledIf fails
 * over the current answers are skipped in the direction of travel.
 *
 * Editor-cancel semantics: RPC web clients report an EMPTY editor Save as
 * cancelled -- the protocol cannot distinguish "saved nothing" from
 * "cancel", and empty IS a legal answer for text steps and optional form
 * fields. So in THIS loop an editor cancel never aborts the wizard; it
 * keeps/clears the step value and moves on. Cancelling the run stays one
 * click away on every select (Cancel) and on the review page's cancel
 * row. (pi's editor takes no abort signal; the selects do.) */
async function wizardSelectLoop(
	ctx: ExtensionContext,
	steps: WizardStepDef[],
	signal?: AbortSignal,
	options?: WizardOptions,
): Promise<WizardResult | null> {
	const lang = options?.lang ?? "en";
	const text = DIALOG_TEXT[lang];
	const adapterText = ADAPTER_TEXT[lang];
	const backRow = adapterText.backRow;
	const answers: WizardResult = {};
	// Overlay parity: text initials, form field initials and pre-answered
	// choices (initialIsAnswer) count as answers from the start, so a
	// startTab "submit" review shows the proposal instead of "(offen)".
	for (const step of steps) {
		if (step.kind === "text" && step.initial !== undefined) answers[step.id] = step.initial;
		if (step.kind === "choice" && step.initialIsAnswer && step.initial !== undefined) answers[step.id] = step.initial;
		if (step.kind === "choice" && step.field?.initial !== undefined) answers[step.field.id] = step.field.initial;
		if (step.kind === "form") {
			for (const field of step.fields) {
				if (field.initial !== undefined) answers[field.id] = field.initial;
			}
			step.grow?.initial?.slice(0, step.grow.max).forEach((value, n) => {
				answers[`${step.grow!.idPrefix}_${n + 1}`] = value;
			});
		}
	}
	// The CURRENT labeled fields of a form step, grow fields resolved from
	// the answers so far (overlay parity with formFieldDefs): all filled
	// grow fields plus one empty trailing row -- editing that row and the
	// reopened menu showing the next empty one IS the growing affordance
	// here.
	const formFields = (
		step: WizardStepDef & { kind: "form" },
	): Array<{ id: string; label: string }> => {
		if (!step.grow) return step.fields;
		const grow = step.grow;
		let filled = 0;
		for (let n = grow.max; n >= 1; n--) {
			const value = answers[`${grow.idPrefix}_${n}`];
			if (typeof value === "string" && value.trim() !== "") {
				filled = n;
				break;
			}
		}
		const visible = Math.min(grow.max, Math.max(grow.min, filled + 1));
		return [
			...Array.from({ length: visible }, (_, n) => ({
				id: `${grow.idPrefix}_${n + 1}`,
				label: grow.label(n + 1),
			})),
			...step.fields,
		];
	};
	const formValues = (step: WizardStepDef & { kind: "form" }): string[] =>
		formFields(step).map((field) =>
			(typeof answers[field.id] === "string" ? (answers[field.id] as string) : ""));
	const liveAnswers = (): WizardAnswers => {
		const live: WizardAnswers = {};
		for (const step of steps) {
			if (step.kind === "form") {
				for (const field of formFields(step)) {
					const value = answers[field.id];
					live[field.id] = typeof value === "string" ? value : "";
				}
				continue;
			}
			if (step.kind === "choice" && step.field) {
				const fieldValue = answers[step.field.id];
				live[step.field.id] = typeof fieldValue === "string" ? fieldValue : "";
			}
			const value = answers[step.id];
			live[step.id] = step.kind === "checkbox" ? (Array.isArray(value) ? value : [])
				: step.kind === "text" ? (typeof value === "string" ? value : "")
				: typeof value === "string" ? value : null;
		}
		return live;
	};
	// Overlay parity for derive steps: while the user has not edited the
	// step, its value follows the other answers live.
	const textCurrent = (step: WizardStepDef & { kind: "text" }): string => {
		const value = answers[step.id];
		if (typeof value === "string") return value;
		if (step.derive) return step.derive(liveAnswers());
		return step.initial ?? "";
	};
	const enabled = (i: number): boolean => steps[i].enabledIf?.(liveAnswers()) ?? true;
	// Loader results per step id, keyed like the overlay's loadedKeys: a
	// revisit with the same key must not re-fetch.
	const loadedCache = new Map<string, { key: string; items: CheckboxItem[] }>();
	let index = options?.startTab === "submit" ? steps.length : 0;
	let direction: 1 | -1 = 1;
	for (;;) {
		while (index >= 0 && index < steps.length && !enabled(index)) index += direction;
		if (index < 0) {
			index = 0;
			direction = 1;
			continue;
		}
		if (index >= steps.length) {
			// Materialize unvisited derive steps: what the review WOULD show
			// is what runs, visited or not.
			for (const step of steps) {
				if (step.kind === "text" && typeof answers[step.id] !== "string") {
					answers[step.id] = textCurrent(step);
				}
			}
			if (options?.skipSubmit) {
				// Lightweight gate: every enabled step was just answered in
				// order -- finish without the summary page.
				dropDisabled(steps, answers, enabled);
				return answers;
			}
			// The review page (rpiv submit tab): summary + note + explicit submit.
			const summary = steps.filter((_, i) => enabled(i)).map((step) => {
				const value = answers[step.id];
				if (step.kind === "checkbox") {
					const ids = Array.isArray(value) ? value : [];
					// Locked rows (the always-searched main query) are not
					// answers, and queryNumbers steps carry the run's Q labels
					// -- review parity with the overlay.
					const items = step.queryNumbers ? withQueryNumbers(step.items, new Set(ids)) : step.items;
					const labels = items.filter((item) => !item.locked && ids.includes(item.id)).map((item) => item.label);
					return `${step.tab}: ${labels.length ? labels.join(", ") : text.unanswered}`;
				}
				if (step.kind === "text") {
					const raw = typeof value === "string" ? value : "";
					if (step.plain) return `${step.tab}: ${raw.trim() ? raw.trim() : text.noQuestions}`;
					const questions = parseQuestionLines(raw);
					return `${step.tab}: ${questions.length ? questions.join(" · ") : text.noQuestions}`;
				}
				if (step.kind === "form") {
					// An injected summary (the composed query) beats the field
					// join -- review parity with the overlay's stepValueLabel;
					// so does the review label ("Main query" over "Query").
					const formLabel = step.reviewLabel ?? step.tab;
					if (step.summary) {
						const line = step.summary(formValues(step)).trim();
						return `${formLabel}: ${line ? line : text.noQuestions}`;
					}
					const set = formFields(step)
						.map((field) => ({ field, value: typeof answers[field.id] === "string" ? (answers[field.id] as string).trim() : "" }))
						.filter((entry) => entry.value !== "")
						.map((entry) => `${entry.field.label} ${entry.value}`);
					return `${formLabel}: ${set.length ? set.join(" · ") : text.noQuestions}`;
				}
				const option = step.options.find((entry) => entry.value === value);
				// Labels can be functions over the live answers; the review
				// must resolve them like the step rows do (else the function
				// source leaks into the title).
				const optionLabel = option === undefined ? undefined
					: typeof option.label === "function" ? option.label(liveAnswers()) : option.label;
				// A free-entry answer matches no option: show the typed value.
				const fieldValue = step.field && typeof answers[step.field.id] === "string" ? (answers[step.field.id] as string).trim() : "";
				return `${step.tab}: ${optionLabel ?? (typeof value === "string" ? value : text.unanswered)}`
					+ (step.field && fieldValue ? ` · ${step.field.label} ${fieldValue}` : "");
			});
			const note = options?.submitNote?.(liveAnswers()) ?? null;
			const picked = await ctx.ui.select(
				`${text.submitTitle} -- ${summary.join(" | ")}${note ? ` -- ${note}` : ""}`,
				[text.submitRow, backRow, text.submitCancelRow],
				{ signal },
			);
			if (picked === undefined || picked === text.submitCancelRow) return null;
			if (picked === backRow) {
				index = steps.length - 1;
				direction = -1;
				continue;
			}
			dropDisabled(steps, answers, enabled);
			return answers;
		}
		const step = steps[index];
		// The fallback has no overlay to paint a header into, so the dialog
		// name rides along in every step title.
		const stepTitle = `${options?.header ? `${options.header} -- ` : ""}(${index + 1}/${steps.length}) ${step.title}`;
		if (step.kind === "checkbox") {
			// Lazily loaded items: fetch here, right before the step shows;
			// failures/empty lists skip an optional step honestly. Per-run
			// cache: revisiting a tab with an unchanged key reuses the fetched
			// list -- the variants loader makes an LLM call, which must not
			// repeat on every visit.
			// A typing row has no modal equivalent (no author lookup here);
			// the fallback shows the step's tickable rows only.
			let items = step.items.filter((item) => item.typing === undefined);
			// Parent loaders (child rows under one item) have no modal
			// equivalent: the fallback shows the step's static rows only.
			const loader = options?.itemLoaders?.find((entry) => entry.step === step.id && entry.parent === undefined && entry.group === undefined);
			if (loader) {
				const live = liveAnswers();
				const key = loader.key(live);
				const cached = loadedCache.get(step.id);
				if (cached && cached.key === key) {
					items = cached.items;
				} else if (key) {
					try {
						items = await loader.load(live);
					} catch {
						items = [];
					}
					loadedCache.set(step.id, { key, items });
				} else {
					items = [];
					loadedCache.set(step.id, { key, items });
				}
				if (!items.length && step.optional) {
					answers[step.id] = [];
					index++;
					direction = 1;
					continue;
				}
			}
			const loaderPreselect = loader?.preselect ? loader.preselect(items) : undefined;
			// Exclusion lists start fully checked (a proposal stays a whitelist).
			const preselected = Array.isArray(answers[step.id]) ? (answers[step.id] as string[])
				: loaderPreselect?.length ? loaderPreselect
				: step.defaultAll ? items.map((item) => item.id)
				: step.preselected;
			const picked = await checkboxSelectLoop(ctx, {
				title: stepTitle,
				items,
				selectAllLabel: step.selectAllLabel,
				...(step.allSelectedLabel ? { allSelectedLabel: step.allSelectedLabel } : {}),
				preselected,
				lang,
				signal,
				backRow: index > 0,
				allowEmpty: step.optional,
			});
			if (picked === null) return null;
			if (picked === "back") {
				index--;
				direction = -1;
				continue;
			}
			answers[step.id] = picked;
			index++;
			direction = 1;
			continue;
		}
		if (step.kind === "text") {
			const edited = await ctx.ui.editor(stepTitle, textCurrent(step));
			// Cancel/empty-save: an empty text answer is legal (empty query
			// cancels honestly at submit; empty questions mean chat handback),
			// so record it and continue instead of aborting the wizard.
			answers[step.id] = edited !== undefined ? edited
				: typeof answers[step.id] === "string" ? answers[step.id] : "";
			index++;
			direction = 1;
			continue;
		}
		if (step.kind === "form") {
			// One MENU per form step (an editor chain -- one editor per field
			// -- dies on the EMPTY-save-is-cancelled web quirk, and empty
			// fields are the NORMAL case for optional filters). Rows show the
			// live values; picking a row edits that one field, the done row
			// advances.
			let formResult: "advance" | "back" | null = null;
			for (;;) {
				// Grow forms rebuild their field list per menu round -- filling
				// the trailing empty row makes the next one appear on reopen.
				const fields = formFields(step);
				const rows = fields.map((field) => {
					const value = typeof answers[field.id] === "string" ? (answers[field.id] as string).trim() : "";
					return `${field.label}: ${value !== "" ? value : adapterText.formOff}`;
				});
				rows.push(adapterText.formDoneRow);
				if (index > 0) rows.push(backRow);
				// The status note (both-filled warning) rides in the menu title.
				const note = step.note?.(formValues(step)) ?? null;
				const picked = await ctx.ui.select(
					note ? `${stepTitle} -- ${note.text}` : stepTitle,
					rows,
					{ signal },
				);
				if (picked === undefined) return null; // select cancel stays a wizard cancel
				if (picked === backRow) {
					formResult = "back";
					break;
				}
				if (picked === adapterText.formDoneRow) {
					formResult = "advance";
					break;
				}
				const field = fields[rows.indexOf(picked)];
				if (!field) continue;
				// Field initials are already seeded into answers above, so the
				// stored value is the only source here (grow fields carry none).
				const current = typeof answers[field.id] === "string" ? (answers[field.id] as string) : "";
				const edited = await ctx.ui.editor(`${stepTitle} -- ${field.label}`, current);
				// Cancel/empty-save keeps the previous value (clearing a set
				// field: save whitespace -- consumers trim before parsing).
				if (edited !== undefined) answers[field.id] = edited;
			}
			if (formResult === "back") {
				index--;
				direction = -1;
				continue;
			}
			index++;
			direction = 1;
			continue;
		}
		const current = typeof answers[step.id] === "string" ? (answers[step.id] as string) : step.initial;
		const isPreset = step.options.some((option) => option.value === current);
		const rows = step.options.map((option) => {
			// Labels can be live; descriptions join the row label (the
			// overlay renders them as a dim second line; a select row has
			// only one).
			const label = typeof option.label === "function" ? option.label(liveAnswers()) : option.label;
			const description = typeof option.description === "function"
				? option.description(liveAnswers())
				: option.description;
			const suffix = description ? ` -- ${description}` : "";
			// A free-entry option shows the current custom value inline and is
			// checked when the answer is no preset.
			if (option.freeText) {
				const custom = !isPreset && typeof current === "string" ? ` ${current} ✔` : "";
				return `${label}${custom}${suffix}`;
			}
			return `${label}${option.value === current ? " ✔" : ""}${suffix}`;
		});
		// The companion field as one more row: picking it edits the value
		// and reopens the menu (the choice itself is still to be made).
		const fieldRow = step.field
			? `${step.field.label} ${typeof answers[step.field.id] === "string" && (answers[step.field.id] as string).trim()
				? (answers[step.field.id] as string).trim() : adapterText.formOff}`
			: null;
		if (fieldRow) rows.push(fieldRow);
		if (index > 0) rows.push(backRow);
		const picked = await ctx.ui.select(stepTitle, rows, { signal });
		if (picked === undefined) return null;
		if (picked === backRow) {
			index--;
			direction = -1;
			continue;
		}
		if (step.field && picked === fieldRow) {
			const currentField = typeof answers[step.field.id] === "string" ? (answers[step.field.id] as string) : "";
			const edited = await ctx.ui.editor(`${stepTitle} -- ${step.field.label}`, currentField);
			if (edited !== undefined) answers[step.field.id] = edited;
			continue;
		}
		const option = step.options[rows.indexOf(picked)];
		if (!option) continue;
		if (option.freeText) {
			// Seed the editor with the custom answer, else the live seed.
			const seed = !isPreset && typeof current === "string" ? current
				: step.customSeed ? step.customSeed(liveAnswers())
				: "";
			const typed = await ctx.ui.editor(stepTitle, seed);
			// Cancel/empty-save answers nothing -- stay on the step (an editor
			// cancel never aborts the whole wizard).
			if (typed === undefined || !typed.trim()) continue;
			answers[step.id] = typed.trim();
		} else {
			answers[step.id] = option.value;
		}
		index++;
		direction = 1;
	}
}

/** Drop answers of steps that ended up disabled (overlay parity); a form
 * step drops each of its field answers. */
function dropDisabled(
	steps: WizardStepDef[],
	answers: WizardResult,
	enabled: (i: number) => boolean,
): void {
	for (const [i, step] of steps.entries()) {
		if (enabled(i)) continue;
		if (step.kind === "form") {
			for (const field of step.fields) delete answers[field.id];
			if (step.grow) {
				for (let n = 1; n <= step.grow.max; n++) delete answers[`${step.grow.idPrefix}_${n}`];
			}
		} else {
			delete answers[step.id];
			if (step.kind === "choice" && step.field) delete answers[step.field.id];
		}
	}
}

/* ------------------------------------------------------------------ *
 * Shared chat-language observer                                        *
 * ------------------------------------------------------------------ */

/**
 * Language of the most recent PLAIN user input, observed passively via
 * pi.on("input") (an opening move carries no question text, so detection
 * would have nothing to read otherwise). Lives HERE so every extension's
 * dialogs follow the chat's language from the same observation; the
 * module instance is shared through the ESM cache. Neutral lines
 * (commands, bash, extension-injected) keep the previous value; the input
 * itself passes through untouched.
 */
let observedChatLang: DialogLang | null = null;
let observerInstalled = false;

/** Fallback chain tail: the observed chat language, else English (with no
 * prior chat, dialogs default to English; the first German input flips
 * them to German). */
export function chatLangDefault(): DialogLang {
	return observedChatLang ?? "en";
}

/** Idempotent: the first caller installs the listener, later calls no-op. */
export function installChatLangObserver(pi: ExtensionAPI): void {
	if (observerInstalled) return;
	observerInstalled = true;
	pi.on("input", (event) => {
		const text = event.text?.trim();
		if (!text || text.startsWith("/") || text.startsWith("!")) return;
		if (event.source === "extension") return;
		observedChatLang = detectDialogLang([text], chatLangDefault());
	});
}
