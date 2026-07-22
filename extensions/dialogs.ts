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
	type WizardEvent,
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
 * the tallest step, so the box never jumps). Fallback: one select per
 * step with an explicit back row. Null on cancel -- callers abort before
 * any LLM call.
 */
export async function runWizard(
	ctx: ExtensionContext,
	steps: WizardStepDef[],
	signal?: AbortSignal,
): Promise<WizardResult | null> {
	if (!ctx.hasUI) throw new Error("runWizard needs a UI -- headless callers must pass parameters");
	if (ctx.mode === "tui") {
		try {
			const result = await wizardOverlay(ctx, steps);
			if (result !== undefined) return result;
		} catch {
			// pi-tui unavailable or the overlay failed -- fall through.
		}
	}
	return wizardSelectLoop(ctx, steps, signal);
}

async function wizardOverlay(ctx: ExtensionContext, steps: WizardStepDef[]): Promise<WizardResult | null | undefined> {
	const { Key, matchesKey } = await import("@earendil-works/pi-tui");
	return await ctx.ui.custom<WizardResult | null>(
		(tui, theme, _keybindings, done) => {
			let state = initWizard(steps);
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
					const event: WizardEvent | null = matchesKey(data, Key.up) ? "up"
						: matchesKey(data, Key.down) ? "down"
						: matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")) ? "left"
						: matchesKey(data, Key.right) || matchesKey(data, Key.tab) ? "right"
						: data === " " ? "toggle"
						: matchesKey(data, Key.enter) ? "confirm"
						: matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) ? "cancel"
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

/** Mandatory non-TUI path: one select per step, with an explicit back row
 * (answers are kept across steps, mirroring the overlay's tab navigation). */
async function wizardSelectLoop(
	ctx: ExtensionContext,
	steps: WizardStepDef[],
	signal?: AbortSignal,
): Promise<WizardResult | null> {
	const backRow = "← Zurück";
	const answers: WizardResult = {};
	for (let index = 0; index >= 0;) {
		if (index === steps.length) {
			// The review page (rpiv submit tab): summary + explicit submit.
			const summary = steps.map((step) => {
				const value = answers[step.id];
				if (step.kind === "checkbox") {
					const ids = Array.isArray(value) ? value : [];
					const labels = step.items.filter((item) => ids.includes(item.id)).map((item) => item.label);
					return `${step.tab}: ${labels.length ? labels.join(", ") : UNANSWERED_MARK}`;
				}
				const option = step.options.find((entry) => entry.value === value);
				return `${step.tab}: ${option ? option.label : UNANSWERED_MARK}`;
			});
			const picked = await ctx.ui.select(
				`${SUBMIT_TITLE} -- ${summary.join(" | ")}`,
				[SUBMIT_ROW, backRow, SUBMIT_CANCEL_ROW],
				{ signal },
			);
			if (picked === undefined || picked === SUBMIT_CANCEL_ROW) return null;
			if (picked === backRow) {
				index--;
				continue;
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
				continue;
			}
			answers[step.id] = picked;
			index++;
			continue;
		}
		const current = typeof answers[step.id] === "string" ? (answers[step.id] as string) : step.initial;
		const rows = step.options.map((option) => `${option.label}${option.value === current ? " ✔" : ""}`);
		if (index > 0) rows.push(backRow);
		const picked = await ctx.ui.select(stepTitle, rows, { signal });
		if (picked === undefined) return null;
		if (picked === backRow) {
			index--;
			continue;
		}
		const option = step.options[rows.indexOf(picked)];
		if (!option) continue;
		answers[step.id] = option.value;
		index++;
	}
	return answers;
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

/** Question intake: an editor pre-seeded one-question-per-line; empty list
 * when the user submits nothing, null on cancel. */
export async function questionList(
	ctx: ExtensionContext,
	title: string,
	seed = "",
	signal?: AbortSignal,
): Promise<string[] | null> {
	if (!ctx.hasUI) throw new Error("questionList needs a UI -- headless callers must pass parameters");
	const text = await ctx.ui.editor(title, seed, { signal });
	if (text === undefined) return null;
	return parseQuestionLines(text);
}

/* ------------------------------------------------------------------ *
 * TEMPORARY field-test command (E2c gate) -- removed in E2e when the   *
 * wizard wires the dialogs for real                                    *
 * ------------------------------------------------------------------ */

/** /lit-dialogs walks the ONE-dialog wizard (checkbox + two choices),
 * then the questions editor; "/lit-dialogs fallback" forces the select-loop
 * path even in the TUI (the mandatory RPC fallback, exercised without RPC). */
export function registerDialogDemo(pi: ExtensionAPI): void {
	pi.registerCommand("lit-dialogs", {
		description: "TEMPORARY (v25 E2c): field-test the wizard dialog; arg 'fallback' forces the select-loop path",
		handler: async (args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			const forceFallback = (args ?? "").trim() === "fallback";
			const steps: WizardStepDef[] = [
				{
					kind: "checkbox", id: "papers", tab: "Dokumente",
					title: "Über welche Dokumente möchtest du sprechen?",
					items: [
						{ id: "a", label: "2021_Kryniecka_Vistula_sandbars.pdf" },
						{ id: "b", label: "2024_Wagner_Amazon_drought.pdf" },
						{ id: "c", label: "2026_Blanch_Water_Level_hess-30-797-2026.pdf" },
						{ id: "d", label: "2023_Truong_Graph_Neural_Networks_for_Pressure_Estimation_long_name.pdf" },
					],
					// No preselection: the demo mirrors a FRESH session. The real
					// wizard (E2e) preselects only from the session-scoped sticky
					// scope (v23 rule: a new pi session starts blank).
					selectAllLabel: "Alle auswählen", nextLabel: "Weiter",
				},
				{
					kind: "choice", id: "summary", tab: "Zusammenfassung", title: "Zusammenfassen?",
					options: [
						{ value: "none", label: "Nein" },
						{ value: "bullets", label: "Bulletpoints" },
						{ value: "prose", label: "Fließtext" },
					],
					initial: "bullets",
				},
				{
					kind: "choice", id: "save", tab: "HTML", title: "Als HTML speichern?",
					options: [{ value: "yes", label: "Ja, HTML speichern" }, { value: "no", label: "Nein" }],
				},
			];
			const answers = forceFallback
				? await wizardSelectLoop(ctx, steps, ctx.signal) // the non-TUI rung, forced
				: await runWizard(ctx, steps, ctx.signal);
			if (answers === null) {
				ctx.ui.notify("Wizard abgebrochen (Esc) -- Lauf würde hier enden.", "warning");
				return;
			}
			const questions = await questionList(ctx, "Welche Frage(n) interessieren dich? (eine pro Zeile)", "", ctx.signal);
			if (questions === null) {
				ctx.ui.notify("Fragen-Editor abgebrochen (Esc).", "warning");
				return;
			}
			ctx.ui.notify(
				`Auswahl: [${(answers.papers as string[]).join(", ")}] | Zusammenfassung: ${answers.summary} | HTML: ${answers.save}`
				+ ` | Fragen: ${questions.length ? questions.join(" / ") : "(keine)"}`,
				"info",
			);
		},
	});
}
