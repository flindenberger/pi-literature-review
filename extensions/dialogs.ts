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
	type WizardOptions,
	type WizardResult,
	type WizardStepDef,
	wizardAnswers,
	wizardResult,
	wizardView,
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
			`[${all ? "x" : " "}] ${options.selectAllLabel}`,
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
			const loadingNotes = new Map<string, string>();
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
						for (const [stepId, note] of loadingNotes) {
							state = reduceWizard(state, {
								kind: "setItems", step: stepId, items: [], loading: true,
								emptyNote: animateEllipsis(note, loadTick),
							}).state;
						}
						tui.requestRender();
					}, 400);
				} else if (!loadingNotes.size && loadTimer !== undefined) {
					clearInterval(loadTimer);
					loadTimer = undefined;
				}
			};
			const maybeLoadItems = (): void => {
				for (const loader of options?.itemLoaders ?? []) {
					const index = state.steps.findIndex((step) => step.id === loader.step);
					if (index < 0 || state.tab !== index) continue;
					const answers = wizardAnswers(state);
					const key = loader.key(answers);
					if (key === loadedKeys.get(loader.step)) continue;
					loadedKeys.set(loader.step, key);
					if (!key) {
						loadingNotes.delete(loader.step);
						syncLoadTimer();
						state = reduceWizard(state, { kind: "setItems", step: loader.step, items: [], emptyNote: loader.idleNote }).state;
						continue;
					}
					state = reduceWizard(state, {
						kind: "setItems", step: loader.step, items: [], loading: true,
						emptyNote: animateEllipsis(loader.loadingNote, loadTick),
					}).state;
					loadingNotes.set(loader.step, loader.loadingNote);
					syncLoadTimer();
					loader.load(answers).then((items) => {
						// The stale-guard also protects loadingNotes: an OLD
						// promise resolving after a re-keyed load must not stop
						// the pulse of the load still in flight.
						if (finished || loadedKeys.get(loader.step) !== key) return;
						loadingNotes.delete(loader.step);
						syncLoadTimer();
						state = reduceWizard(state, {
							kind: "setItems", step: loader.step, items,
							emptyNote: items.length ? "" : loader.emptyNote,
							...(loader.preselect ? { preselect: loader.preselect(items) } : {}),
						}).state;
						tui.requestRender();
					}).catch((error) => {
						if (finished || loadedKeys.get(loader.step) !== key) return;
						loadingNotes.delete(loader.step);
						syncLoadTimer();
						state = reduceWizard(state, {
							kind: "setItems", step: loader.step, items: [],
							emptyNote: loader.failedNote(error instanceof Error ? error.message : String(error)),
						}).state;
						tui.requestRender();
					});
				}
			};
			maybeLoadItems();
			return {
				render(width: number): string[] {
					// Recomputed per render: lazily loaded items can grow the
					// tallest step after mount.
					const bodyRows = maxWizardRows(state);
					const clip = (line: string): string => (width > 1 && line.length > width ? `${line.slice(0, width - 1)}…` : line);
					const view = wizardView(state);
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
					const lines: string[] = options?.header
						? [paint("accent", clip(options.header)), rule, tabBar, "", paint("accent", clip(view.title))]
						: [rule, tabBar, "", paint("accent", clip(view.title))];
					for (const row of view.rows) {
						lines.push(row.active ? paint("accent", clip(row.text))
							: row.warn ? paint("warning", clip(row.text))
							: row.dim ? paint("dim", clip(row.text))
							: clip(row.text));
					}
					// Constant footprint: pad to the tallest step so the box
					// never changes height while navigating.
					for (let i = view.rows.length; i < bodyRows; i++) lines.push("");
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
						syncLoadTimer();
						done(wizardResult(state));
					} else if (step.done === "cancelled") {
						finished = true;
						loadingNotes.clear();
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
		if (step.kind === "form") {
			for (const field of step.fields) {
				if (field.initial !== undefined) answers[field.id] = field.initial;
			}
		}
	}
	const liveAnswers = (): WizardAnswers => {
		const live: WizardAnswers = {};
		for (const step of steps) {
			if (step.kind === "form") {
				for (const field of step.fields) {
					const value = answers[field.id];
					live[field.id] = typeof value === "string" ? value : "";
				}
				continue;
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
					const labels = step.items.filter((item) => ids.includes(item.id)).map((item) => item.label);
					return `${step.tab}: ${labels.length ? labels.join(", ") : text.unanswered}`;
				}
				if (step.kind === "text") {
					const raw = typeof value === "string" ? value : "";
					if (step.plain) return `${step.tab}: ${raw.trim() ? raw.trim() : text.noQuestions}`;
					const questions = parseQuestionLines(raw);
					return `${step.tab}: ${questions.length ? questions.join(" · ") : text.noQuestions}`;
				}
				if (step.kind === "form") {
					const set = step.fields
						.map((field) => ({ field, value: typeof answers[field.id] === "string" ? (answers[field.id] as string).trim() : "" }))
						.filter((entry) => entry.value !== "")
						.map((entry) => `${entry.field.label} ${entry.value}`);
					return `${step.tab}: ${set.length ? set.join(" · ") : text.noQuestions}`;
				}
				const option = step.options.find((entry) => entry.value === value);
				// Labels can be functions over the live answers; the review
				// must resolve them like the step rows do (else the function
				// source leaks into the title).
				const optionLabel = option === undefined ? undefined
					: typeof option.label === "function" ? option.label(liveAnswers()) : option.label;
				// A free-entry answer matches no option: show the typed value.
				return `${step.tab}: ${optionLabel ?? (typeof value === "string" ? value : text.unanswered)}`;
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
			let items = step.items;
			const loader = options?.itemLoaders?.find((entry) => entry.step === step.id);
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
			const preselected = Array.isArray(answers[step.id]) ? (answers[step.id] as string[])
				: loaderPreselect ?? step.preselected;
			const picked = await checkboxSelectLoop(ctx, {
				title: stepTitle,
				items,
				selectAllLabel: step.selectAllLabel,
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
				const rows = step.fields.map((field) => {
					const value = typeof answers[field.id] === "string" ? (answers[field.id] as string).trim() : "";
					return `${field.label}: ${value !== "" ? value : adapterText.formOff}`;
				});
				rows.push(adapterText.formDoneRow);
				if (index > 0) rows.push(backRow);
				const picked = await ctx.ui.select(stepTitle, rows, { signal });
				if (picked === undefined) return null; // select cancel stays a wizard cancel
				if (picked === backRow) {
					formResult = "back";
					break;
				}
				if (picked === adapterText.formDoneRow) {
					formResult = "advance";
					break;
				}
				const field = step.fields[rows.indexOf(picked)];
				if (!field) continue;
				const current = typeof answers[field.id] === "string" ? (answers[field.id] as string) : field.initial ?? "";
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
		if (index > 0) rows.push(backRow);
		const picked = await ctx.ui.select(stepTitle, rows, { signal });
		if (picked === undefined) return null;
		if (picked === backRow) {
			index--;
			direction = -1;
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
		} else {
			delete answers[step.id];
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
