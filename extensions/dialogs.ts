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

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CheckboxEvent,
	type CheckboxItem,
	checkboxLines,
	initCheckbox,
	initWizard,
	maxWizardRows,
	parseQuestionLines,
	reduceCheckbox,
	reduceWizard,
	selection,
	SUBMIT_CANCEL_ROW,
	SUBMIT_ROW,
	SUBMIT_TITLE,
	UNANSWERED_MARK,
	type WizardAnswers,
	type WizardEvent,
	type WizardOptions,
	type WizardResult,
	type WizardStepDef,
	wizardResult,
	wizardView,
} from "../src/dialog-state.ts";

/** Fallback list cap -- the select loop reuses today's picker convention. */
export const FALLBACK_MAX_ITEMS = 25;

export interface CheckboxListOptions {
	title: string;
	items: CheckboxItem[];
	/** Label of the derived summary row, e.g. "Alle auswählen". */
	selectAllLabel: string;
	/** Ids to preselect (e.g. the session's sticky scope). */
	preselected?: string[];
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
						lines.push(row.active ? paint("accent", clip(row.text)) : clip(row.text));
					}
					lines.push(paint("dim", clip("Space auswählen · Enter übernehmen · Esc abbrechen · ↑/↓ navigieren")));
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
	options: CheckboxListOptions & { backRow?: boolean },
): Promise<string[] | "back" | null> {
	const shown = options.items.slice(0, FALLBACK_MAX_ITEMS);
	const known = new Set(shown.map((item) => item.id));
	const selected = new Set((options.preselected ?? []).filter((id) => known.has(id)));
	const doneRow = "Fertig -- Auswahl übernehmen";
	const backRow = "← Zurück";
	for (;;) {
		const all = shown.length > 0 && shown.every((item) => selected.has(item.id));
		const rows = [
			`[${all ? "x" : " "}] ${options.selectAllLabel}`,
			...shown.map((item) => `[${selected.has(item.id) ? "x" : " "}] ${item.label}`),
			doneRow,
			...(options.backRow ? [backRow] : []),
		];
		const title = options.items.length > shown.length
			? `${options.title} (erste ${shown.length} von ${options.items.length})`
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
				ctx.ui.notify("Nichts ausgewählt -- mindestens einen Eintrag wählen oder mit Esc abbrechen.", "warning");
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
			const bodyRows = maxWizardRows(state);
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
					const view = wizardView(state);
					const rule = paint("borderAccent", "─".repeat(Math.max(1, width)));
					const tabBar = view.tabs
						.map((tab) => (tab.active ? paint("accent", `[ ${tab.label} ]`) : paint("dim", `  ${tab.label}  `)))
						.join(" ");
					const lines: string[] = [rule, clip(tabBar), "", paint("accent", clip(view.title))];
					for (const row of view.rows) {
						lines.push(row.active ? paint("accent", clip(row.text)) : clip(row.text));
					}
					// Constant footprint: pad to the tallest step so the box
					// never changes height while navigating (E2c layout fix).
					for (let i = view.rows.length; i < bodyRows; i++) lines.push("");
					lines.push(rule, paint("dim", clip(view.hint)));
					return lines;
				},
				invalidate(): void {},
				handleInput(data: string): void {
					// On a text step, unmatched printable input TYPES (space
					// included); everywhere else space toggles and other
					// unmatched input is ignored.
					const onText = state.tab < state.steps.length && state.steps[state.tab].kind === "text";
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
					if (step.done === "confirmed") done(wizardResult(state));
					else if (step.done === "cancelled") done(null);
					else tui.requestRender();
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
	const backRow = "← Zurück";
	const answers: WizardResult = {};
	const liveAnswers = (): WizardAnswers => {
		const live: WizardAnswers = {};
		for (const step of steps) {
			const value = answers[step.id];
			live[step.id] = step.kind === "checkbox" ? (Array.isArray(value) ? value : [])
				: step.kind === "text" ? (typeof value === "string" ? value : "")
				: typeof value === "string" ? value : null;
		}
		return live;
	};
	const enabled = (i: number): boolean => steps[i].enabledIf?.(liveAnswers()) ?? true;
	let index = 0;
	let direction: 1 | -1 = 1;
	for (;;) {
		while (index >= 0 && index < steps.length && !enabled(index)) index += direction;
		if (index < 0) {
			index = 0;
			direction = 1;
			continue;
		}
		if (index >= steps.length) {
			if (options?.skipSubmit) {
				// Lightweight gate: every enabled step was just answered in
				// order -- finish without the summary page.
				for (const [i, step] of steps.entries()) {
					if (!enabled(i)) delete answers[step.id];
				}
				return answers;
			}
			// The review page (rpiv submit tab): summary + note + explicit submit.
			const summary = steps.filter((_, i) => enabled(i)).map((step) => {
				const value = answers[step.id];
				if (step.kind === "checkbox") {
					const ids = Array.isArray(value) ? value : [];
					const labels = step.items.filter((item) => ids.includes(item.id)).map((item) => item.label);
					return `${step.tab}: ${labels.length ? labels.join(", ") : UNANSWERED_MARK}`;
				}
				if (step.kind === "text") {
					const questions = parseQuestionLines(typeof value === "string" ? value : "");
					return `${step.tab}: ${questions.length ? questions.join(" · ") : "(keine)"}`;
				}
				const option = step.options.find((entry) => entry.value === value);
				return `${step.tab}: ${option ? option.label : UNANSWERED_MARK}`;
			});
			const note = options?.submitNote?.(liveAnswers()) ?? null;
			const picked = await ctx.ui.select(
				`${SUBMIT_TITLE} -- ${summary.join(" | ")}${note ? ` -- ${note}` : ""}`,
				[SUBMIT_ROW, backRow, SUBMIT_CANCEL_ROW],
				{ signal },
			);
			if (picked === undefined || picked === SUBMIT_CANCEL_ROW) return null;
			if (picked === backRow) {
				index = steps.length - 1;
				direction = -1;
				continue;
			}
			// Drop answers of steps that ended up disabled (overlay parity).
			for (const [i, step] of steps.entries()) {
				if (!enabled(i)) delete answers[step.id];
			}
			return answers;
		}
		const step = steps[index];
		const stepTitle = `(${index + 1}/${steps.length}) ${step.title}`;
		if (step.kind === "checkbox") {
			const preselected = Array.isArray(answers[step.id]) ? (answers[step.id] as string[]) : step.preselected;
			const picked = await checkboxSelectLoop(ctx, {
				title: stepTitle,
				items: step.items,
				selectAllLabel: step.selectAllLabel,
				preselected,
				signal,
				backRow: index > 0,
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
			const current = typeof answers[step.id] === "string" ? (answers[step.id] as string) : step.initial ?? "";
			const text = await ctx.ui.editor(stepTitle, current, { signal });
			if (text === undefined) return null; // editor cancel = wizard cancel
			answers[step.id] = text;
			index++;
			direction = 1;
			continue;
		}
		const current = typeof answers[step.id] === "string" ? (answers[step.id] as string) : step.initial;
		const rows = step.options.map((option) => `${option.label}${option.value === current ? " ✔" : ""}`);
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
		answers[step.id] = option.value;
		index++;
		direction = 1;
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

