/**
 * Claude-Code-style dialogs for the pi adapters (v25 E2c) -- a minimal
 * in-package rebuild of the @juicesharp/rpiv-ask-user-question look (user
 * decision 2026-07-21: no extra install, no 4-option tool cap, real
 * select-all). All decisions live in the pure reducer src/dialog-state.ts;
 * this file only mounts UI.
 *
 * Mode ladder (the guard is ctx.mode === "tui", NOT hasUI -- in RPC mode
 * hasUI is true but ctx.ui.custom() returns undefined, pi docs/rpc.md):
 *   tui       ctx.ui.custom overlay (bottom-anchored, rpiv pattern) with
 *             pi-tui key matching; pi-tui is imported lazily and any
 *             import/mount failure falls back one rung
 *   rpc/other a ctx.ui.select LOOP: [x]/[ ] rows + select-all + an explicit
 *             done row; every pick toggles and reopens (mandatory fallback)
 *   headless  callers must pass parameters; these helpers throw
 *
 * Cancel is always null -- callers abort the WHOLE run before any LLM call.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CheckboxEvent,
	type CheckboxItem,
	checkboxLines,
	detectDialogLang,
	DIALOG_TEXT,
	type DialogLang,
	initCheckbox,
	initWizard,
	maxWizardRows,
	parseQuestionLines,
	reduceCheckbox,
	reduceWizard,
	selection,
	type WizardAnswers,
	type WizardEvent,
	type WizardOptions,
	type WizardResult,
	type WizardStepDef,
	wizardAnswers,
	wizardResult,
	wizardView,
} from "../src/dialog-state.ts";

/** The few adapter-owned strings, per dialog language (v27: dialogs
 * follow the chat's language; English is the default since v30). */
const ADAPTER_TEXT: Record<DialogLang, {
	checkboxHint: string;
	doneRow: string;
	backRow: string;
	nothingSelected: string;
	firstOf: (shown: number, total: number) => string;
}> = {
	de: {
		checkboxHint: "Space auswählen · Enter übernehmen · Esc abbrechen · ↑/↓ navigieren",
		doneRow: "Fertig -- Auswahl übernehmen",
		backRow: "← Zurück",
		nothingSelected: "Nichts ausgewählt -- mindestens einen Eintrag wählen oder mit Esc abbrechen.",
		firstOf: (shown, total) => `(erste ${shown} von ${total})`,
	},
	en: {
		checkboxHint: "Space selects · Enter confirms · Esc cancels · ↑/↓ navigate",
		doneRow: "Done -- apply selection",
		backRow: "← Back",
		nothingSelected: "Nothing selected -- pick at least one entry or cancel with Esc.",
		firstOf: (shown, total) => `(first ${shown} of ${total})`,
	},
};

/** Fallback list cap -- the select loop reuses today's picker convention. */
export const FALLBACK_MAX_ITEMS = 25;

export interface CheckboxListOptions {
	title: string;
	items: CheckboxItem[];
	/** Label of the derived summary row, e.g. "Alle auswählen". */
	selectAllLabel: string;
	/** Ids to preselect (e.g. the session's sticky scope). */
	preselected?: string[];
	/** Dialog language; default "de". */
	lang?: DialogLang;
	signal?: AbortSignal;
}

/**
 * Multi-select over the items; resolves to the selected ids in item order,
 * or null on cancel. Confirming an empty selection is impossible (reducer
 * rule); the fallback loop enforces the same with a warning.
 */
export async function checkboxList(ctx: ExtensionContext, options: CheckboxListOptions): Promise<string[] | null> {
	if (!ctx.hasUI) throw new Error("checkboxList needs a UI -- headless callers must pass parameters");
	if (!options.items.length) return null;
	if (ctx.mode === "tui") {
		try {
			const picked = await checkboxOverlay(ctx, options);
			if (picked !== undefined) return picked;
			// undefined: custom() unavailable despite tui mode -- fall through.
		} catch {
			// pi-tui unavailable or the overlay failed -- the select loop is
			// the mandatory fallback, never an error.
		}
	}
	const picked = await checkboxSelectLoop(ctx, options);
	return picked === "back" ? null : picked; // no back row outside the wizard
}

/** The rpiv-look overlay; undefined when ctx.ui.custom is not available. */
async function checkboxOverlay(ctx: ExtensionContext, options: CheckboxListOptions): Promise<string[] | null | undefined> {
	const { Key, matchesKey } = await import("@earendil-works/pi-tui");
	return await ctx.ui.custom<string[] | null>(
		(tui, theme, _keybindings, done) => {
			let state = initCheckbox(options.items, options.preselected);
			const paint = (color: string, text: string): string => {
				try {
					return theme.fg(color, text);
				} catch {
					return text;
				}
			};
			return {
				render(width: number): string[] {
					const clip = (line: string): string => (width > 1 && line.length > width ? `${line.slice(0, width - 1)}…` : line);
					const lines: string[] = [paint("accent", clip(options.title))];
					for (const row of checkboxLines(state, options.selectAllLabel)) {
						lines.push(row.active ? paint("accent", clip(row.text))
							: row.dim ? paint("dim", clip(row.text))
							: clip(row.text));
					}
					lines.push(paint("dim", clip(ADAPTER_TEXT[options.lang ?? "en"].checkboxHint)));
					return lines;
				},
				invalidate(): void {},
				handleInput(data: string): void {
					const event: CheckboxEvent | null = matchesKey(data, Key.up) ? "up"
						: matchesKey(data, Key.down) ? "down"
						: data === " " ? "toggle"
						: matchesKey(data, Key.enter) ? "confirm"
						: matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) ? "cancel"
						: null;
					if (!event) return;
					const step = reduceCheckbox(state, event);
					state = step.state;
					if (step.done === "confirmed") done(selection(state));
					else if (step.done === "cancelled") done(null);
					else tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%" } },
	);
}

/** Mandatory non-TUI path: a numbered select that toggles and reopens.
 * With backRow set it can also resolve to "back" (wizard navigation). */
async function checkboxSelectLoop(
	ctx: ExtensionContext,
	options: CheckboxListOptions & { backRow?: boolean; allowEmpty?: boolean },
): Promise<string[] | "back" | null> {
	const shown = options.items.slice(0, FALLBACK_MAX_ITEMS);
	const known = new Set(shown.map((item) => item.id));
	const selected = new Set((options.preselected ?? []).filter((id) => known.has(id)));
	const adapterText = ADAPTER_TEXT[options.lang ?? "en"];
	const doneRow = adapterText.doneRow;
	const backRow = adapterText.backRow;
	for (;;) {
		const all = shown.length > 0 && shown.every((item) => selected.has(item.id));
		const rows = [
			`[${all ? "x" : " "}] ${options.selectAllLabel}`,
			// The select-loop has no dim second line; the description joins
			// the row so the metadata survives the fallback (v31.2).
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
			if (all) selected.clear();
			else for (const item of shown) selected.add(item.id);
			continue;
		}
		if (picked === doneRow) {
			if (!selected.size) {
				// Optional steps (v30.7): empty is a valid answer.
				if (options.allowEmpty) return [];
				ctx.ui.notify(adapterText.nothingSelected, "warning");
				continue;
			}
			return shown.filter((item) => selected.has(item.id)).map((item) => item.id);
		}
		const item = shown[index - 1];
		if (selected.has(item.id)) selected.delete(item.id);
		else selected.add(item.id);
	}
}

/* ------------------------------------------------------------------ *
 * Wizard -- ONE dialog over several steps (rpiv semantics)             *
 * ------------------------------------------------------------------ */

/**
 * The whole intake as ONE dialog (E2c field verdict: a chain of separate
 * dialogs jumped around, had no way back, and Enter committed the
 * multi-select). TUI: one bottom-anchored overlay with a tab bar,
 * Tab/arrow navigation between steps, and a CONSTANT footprint (padded to
 * the tallest step, so the box never jumps). Text steps (v27) type inline;
 * steps with enabledIf appear only while their condition holds. Fallback:
 * one select (or editor) per step with an explicit back row. Null on
 * cancel -- callers abort before any LLM call. Options: submitNote
 * renders one computed line on the submit page (e.g. the expected
 * model-call count); skipSubmit finishes directly after the last step
 * (lightweight gates like the per-question confirm).
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
			const paint = (color: string, text: string): string => {
				try {
					return theme.fg(color, text);
				} catch {
					return text;
				}
			};
			// Lazily loaded checkbox items (v30.7, the journal list; v30.11
			// the author list joins it): when the user reaches a loader's
			// tab, fetch with the LIVE answers and dispatch setItems; a
			// changed key (edited query) re-fetches on the next visit. The
			// reducer stays pure -- all IO lives here.
			const loadedKeys = new Map<string, string>();
			const maybeLoadItems = (): void => {
				for (const loader of options?.itemLoaders ?? []) {
					const index = state.steps.findIndex((step) => step.id === loader.step);
					if (index < 0 || state.tab !== index) continue;
					const answers = wizardAnswers(state);
					const key = loader.key(answers);
					if (key === loadedKeys.get(loader.step)) continue;
					loadedKeys.set(loader.step, key);
					if (!key) {
						state = reduceWizard(state, { kind: "setItems", step: loader.step, items: [], emptyNote: loader.idleNote }).state;
						continue;
					}
					state = reduceWizard(state, { kind: "setItems", step: loader.step, items: [], emptyNote: loader.loadingNote }).state;
					loader.load(answers).then((items) => {
						if (finished || loadedKeys.get(loader.step) !== key) return;
						state = reduceWizard(state, {
							kind: "setItems", step: loader.step, items,
							emptyNote: items.length ? "" : loader.emptyNote,
							...(loader.preselect ? { preselect: loader.preselect(items) } : {}),
						}).state;
						tui.requestRender();
					}).catch((error) => {
						if (finished || loadedKeys.get(loader.step) !== key) return;
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
					// tallest step after mount (v30.7).
					const bodyRows = maxWizardRows(state);
					const clip = (line: string): string => (width > 1 && line.length > width ? `${line.slice(0, width - 1)}…` : line);
					const view = wizardView(state);
					const rule = paint("borderAccent", "─".repeat(Math.max(1, width)));
					// The rpiv tab bar (v30.2): arrows at both ends, the active
					// tab bracketed + accent, disabled tabs parenthesized + dim
					// (v29: grey out instead of hide; the reason shows on
					// visiting). NO raw ANSI here: a hand-rolled reverse-video
					// escape broke pi-tui's width accounting in the field
					// (v30.3 -- the tab bar became one white block). And the
					// bar is measured on its VISIBLE text (v30.4 field bug:
					// clip() on the painted string counted the color escape
					// bytes as characters and cut the bar after four tabs --
					// "More filters" and "✓ Confirm" vanished although the
					// terminal had room). A bar too wide for the terminal
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
					// tabBar is already width-safe on its VISIBLE length -- a
					// second clip() here re-counted the color escape bytes and
					// cut the painted bar mid-way (v30.5 field bug: the last
					// tabs vanished depending on terminal width).
					// Header line naming the dialog (v30.12): the overlay is
					// anchored to the bottom of the terminal, far from the
					// command the user typed -- so it says where you are.
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
					// never changes height while navigating (E2c layout fix).
					for (let i = view.rows.length; i < bodyRows; i++) lines.push("");
					lines.push(rule, paint("dim", clip(view.hint)));
					return lines;
				},
				invalidate(): void {},
				handleInput(data: string): void {
					// In an input context, unmatched printable input TYPES
					// (space included): text steps, form fields, and a choice
					// step whose cursor sits on a free-entry option (v30).
					// Everywhere else space toggles and other unmatched input
					// is ignored.
					const active = state.tab < state.steps.length ? state.steps[state.tab] : undefined;
					const onText = active !== undefined && (active.kind === "text" || active.kind === "form"
						|| (active.kind === "choice" && active.options[state.cursors[state.tab]]?.freeText === true));
					const event: WizardEvent | null = matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) ? "cancel"
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
						done(wizardResult(state));
					} else if (step.done === "cancelled") {
						finished = true;
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
 * over the current answers are skipped in the direction of travel. */
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
	// Overlay parity for derive steps (v30): while the user has not edited
	// the step, its value follows the other answers live.
	const textCurrent = (step: WizardStepDef & { kind: "text" }): string => {
		const value = answers[step.id];
		if (typeof value === "string") return value;
		if (step.derive) return step.derive(liveAnswers());
		return step.initial ?? "";
	};
	const enabled = (i: number): boolean => steps[i].enabledIf?.(liveAnswers()) ?? true;
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
			// Materialize unvisited derive steps (v30): what the review WOULD
			// show is what runs, visited or not.
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
				// A free-entry answer matches no option: show the typed value.
				return `${step.tab}: ${option ? option.label : typeof value === "string" ? value : text.unanswered}`;
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
		// name rides along in every step title (v30.12).
		const stepTitle = `${options?.header ? `${options.header} -- ` : ""}(${index + 1}/${steps.length}) ${step.title}`;
		if (step.kind === "checkbox") {
			// Lazily loaded items (v30.7): fetch here, right before the step
			// shows; failures/empty lists skip an optional step honestly.
			let items = step.items;
			const loader = options?.itemLoaders?.find((entry) => entry.step === step.id);
			if (loader) {
				const live = liveAnswers();
				const key = loader.key(live);
				if (key) {
					try {
						items = await loader.load(live);
					} catch {
						items = [];
					}
				} else {
					items = [];
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
			const edited = await ctx.ui.editor(stepTitle, textCurrent(step), { signal });
			if (edited === undefined) return null; // editor cancel = wizard cancel
			answers[step.id] = edited;
			index++;
			direction = 1;
			continue;
		}
		if (step.kind === "form") {
			// One editor per field, in order; empty keeps a field off.
			for (const field of step.fields) {
				const current = typeof answers[field.id] === "string" ? (answers[field.id] as string) : field.initial ?? "";
				const edited = await ctx.ui.editor(`${stepTitle} -- ${field.label}`, current, { signal });
				if (edited === undefined) return null; // editor cancel = wizard cancel
				answers[field.id] = edited;
			}
			index++;
			direction = 1;
			continue;
		}
		const current = typeof answers[step.id] === "string" ? (answers[step.id] as string) : step.initial;
		const isPreset = step.options.some((option) => option.value === current);
		const rows = step.options.map((option) => {
			// Labels can be live (v30.5: the grouping expressions);
			// descriptions join the row label (the overlay renders them as a
			// dim second line; a select row has only one).
			const label = typeof option.label === "function" ? option.label(liveAnswers()) : option.label;
			const description = typeof option.description === "function"
				? option.description(liveAnswers())
				: option.description;
			const suffix = description ? ` -- ${description}` : "";
			// A free-entry option shows the current custom value inline and is
			// checked when the answer is no preset (v30).
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
			// Seed the editor with the custom answer, else the live seed
			// (v30.2: the custom grouping expression follows the query).
			const seed = !isPreset && typeof current === "string" ? current
				: step.customSeed ? step.customSeed(liveAnswers())
				: "";
			const typed = await ctx.ui.editor(stepTitle, seed, { signal });
			if (typed === undefined) return null;
			if (!typed.trim()) continue; // empty custom value answers nothing
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

export interface ChoiceOption<T extends string> {
	value: T;
	label: string;
}

/** Single choice; null on cancel. Thin wrapper over ctx.ui.select so every
 * wizard step cancels the same way. */
export async function choice<T extends string>(
	ctx: ExtensionContext,
	title: string,
	options: Array<ChoiceOption<T>>,
	signal?: AbortSignal,
): Promise<T | null> {
	if (!ctx.hasUI) throw new Error("choice needs a UI -- headless callers must pass parameters");
	const picked = await ctx.ui.select(title, options.map((option) => option.label), { signal });
	if (picked === undefined) return null;
	return options.find((option) => option.label === picked)?.value ?? null;
}

/* ------------------------------------------------------------------ *
 * Shared chat-language observer                                        *
 * ------------------------------------------------------------------ */

/**
 * Language of the most recent PLAIN user input, observed passively via
 * pi.on("input") (v27 field finding: an opening move carries no question
 * text, so detection had nothing to read). Lives HERE since v29.1 so
 * every extension's dialogs follow the chat's language from the same
 * observation; the module instance is shared through the ESM cache.
 * Neutral lines (commands, bash, extension-injected) keep the previous
 * value; the input itself passes through untouched.
 */
let observedChatLang: DialogLang | null = null;
let observerInstalled = false;

/** Fallback chain tail: the observed chat language, else English (v30
 * user decision: with no prior chat, dialogs and outputs default to
 * English; the first German input flips everything to German). */
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

/** Yes/no; null on cancel (cancel is NOT no -- callers abort the run). */
export async function confirmDialog(
	ctx: ExtensionContext,
	title: string,
	yesLabel: string,
	noLabel: string,
	signal?: AbortSignal,
): Promise<boolean | null> {
	const picked = await choice(ctx, title, [
		{ value: "yes", label: yesLabel },
		{ value: "no", label: noLabel },
	], signal);
	return picked === null ? null : picked === "yes";
}

