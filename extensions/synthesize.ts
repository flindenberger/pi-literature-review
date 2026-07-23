/**
 * pi-literature-review Pi extension: the ONE fused stage tool
 * pi-literature-synthesize + the /lit-synth command (v25 E2e).
 *
 * The former pi-literature-chat and pi-literature-synthesize tools merged
 * into one: SCOPE (one paper | a selection | the whole library) and the
 * report menu are settled by CODE dialogs -- the Claude-Code-style wizard
 * from extensions/dialogs.ts -- never by chat questions. Grounded Q&A
 * rounds, the composable report (summaries, detail questions in mode A/B,
 * review synthesis) and the classic session report all run the same fused
 * engine in src/synthesize.ts with the same citation gate.
 *
 * Dialog policy: NO consent dialog per chat question (it would kill the
 * conversation loop) -- the gate sits at the scope/report intake. Esc in
 * any dialog cancels the whole run before any LLM call.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { llmConfig } from "../src/config.ts";
import {
	type CheckboxItem,
	parseQuestionLines,
	type WizardAnswers,
	type WizardResult,
	type WizardStepDef,
} from "../src/dialog-state.ts";
import { matchLibrary } from "../src/corpus.ts";
import { renderChatDigest, renderReportDigest } from "../src/digest.ts";
import { createBackend, type LlmBackend } from "../src/llm.ts";
import { outputRoot, writeRunOutputs } from "../src/output.ts";
import { loadRounds, readCurrentScope, realProtocolDeps, writeCurrentScope } from "../src/protocol.ts";
import { renderSynthReportHtml } from "../src/render.ts";
import {
	type ChatAnswer,
	type ChatDeps,
	chatPool,
	DEFAULT_TOP_K,
	MAX_TOP_K,
	OUTPUT_RESERVE_TOKENS,
	type ReferenceEntry,
	type ReportOptions,
	runReport,
	runRound,
	scopeProtocolId,
	type SynthReport,
} from "../src/synthesize.ts";
import { runWizard } from "./dialogs.ts";

const SYNTH_WIDGET = "pi-literature-review-synth";
const ANSWER_ENTRY = "pi-literature-chat-answer";

/** Wizard warning threshold: a mode-A report runs P x Q generation calls,
 * each minutes on a local GPU (v25 risk note). */
export const UNIT_WARN_THRESHOLD = 15;

/** True once the pi-tui entry renderer is registered (see the default
 * export); validated answers then render as full transcript entries. */
let answerEntryReady = false;

const MAX_LINE = 110;

function clip(line: string): string {
	return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 3)}...` : line;
}

function wrapText(text: string, width = MAX_LINE): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let current = "";
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			if (current && current.length + 1 + word.length > width) {
				lines.push(current);
				current = word;
			} else {
				current = current ? `${current} ${word}` : word;
			}
		}
		if (current) lines.push(current);
	}
	return lines;
}

const WIDGET_MAX_LINES = 15;

/** The one deterministic reference-line format shared by widget, cards and
 * digests -- built exclusively from verified record fields. */
function referenceLine(reference: ReferenceEntry): string {
	const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}` : reference.key);
	return `[${reference.n}] ${reference.year ?? "n.d."} | ${id} | ${reference.title} (S. ${reference.pages.join(", ")})`;
}

function answerWidgetLines(answer: ChatAnswer, scopeLabel: string): string[] {
	const lines = [
		answer.grounded
			? `Validated answer (code-checked) -- ${scopeLabel}`
			: `UNGROUNDED DRAFT (not usable as an answer) -- ${scopeLabel}`,
		...wrapText(answer.prose),
		...answer.references.map((reference) => clip(referenceLine(reference))),
	];
	return lines.length > WIDGET_MAX_LINES
		? [...lines.slice(0, WIDGET_MAX_LINES - 1), "... (the full validated answer is in the session protocol)"]
		: lines;
}

function formatAnswerText(answer: ChatAnswer): string {
	const refs = answer.references.map(referenceLine);
	return `${answer.prose}${refs.length ? `\n\n${refs.join("\n")}` : ""}`;
}

/** Report body for the transcript card: unit headings + validated prose,
 * then the GLOBAL reference lines and the HTML path when one was written.
 * The card is the durable answer in the chat (v27 field fix: the report
 * lived only in a truncated, transient widget). */
function formatReportText(report: SynthReport, htmlPath: string | null): string {
	const parts = report.units.map((unit) => {
		const heading = unit.kind === "summary" ? `Zusammenfassung ${unit.paper_base}.pdf`
			: unit.kind === "review" ? "Review-Synthese"
			: unit.paper_base ? `${unit.question} -- ${unit.paper_base}.pdf`
			: unit.question ?? "";
		return `${heading}\n\n${unit.prose}`;
	});
	return [
		parts.join("\n\n----\n\n"),
		report.references.map(referenceLine).join("\n"),
		htmlPath ? `HTML-Report: ${htmlPath}` : "",
	].filter(Boolean).join("\n\n");
}

/** Scope label for widgets/cards: "x.pdf" or "3 Dokumente" or "Bibliothek". */
function scopeLabelOf(answer: ChatAnswer): string {
	if (answer.scope === "library") return `Bibliothek (${answer.papers.length} PDFs)`;
	return answer.papers.length === 1 ? `${answer.paper.base}.pdf` : `${answer.papers.length} Dokumente`;
}

/** Show the validated answer as a scrollable transcript entry (anti-
 * paraphrase ground truth; not in the LLM context), else the capped widget. */
function showAnswer(pi: ExtensionAPI, ctx: ExtensionContext, answer: ChatAnswer): void {
	const label = scopeLabelOf(answer);
	if (answerEntryReady) {
		pi.appendEntry(ANSWER_ENTRY, {
			paper: label,
			grounded: answer.grounded,
			text: formatAnswerText(answer),
		});
		if (ctx.hasUI) ctx.ui.setWidget(SYNTH_WIDGET, undefined);
	} else if (ctx.hasUI) {
		ctx.ui.setWidget(SYNTH_WIDGET, answerWidgetLines(answer, label));
	}
}

/** Show the finished report as a transcript entry too (v27: the durable
 * answer in the chat, HTML export or not), else the capped widget. Returns
 * true when the fallback WIDGET carries the report (caller must not clear
 * it). */
function showReport(pi: ExtensionAPI, ctx: ExtensionContext, report: SynthReport, htmlPath: string | null): boolean {
	const label = report.scope.library
		? `Bibliothek (${report.scope.papers.length} PDFs)`
		: report.scope.papers.length === 1
			? `${report.scope.papers[0]}.pdf`
			: `${report.scope.papers.length} Dokumente`;
	const text = formatReportText(report, htmlPath);
	if (answerEntryReady) {
		pi.appendEntry(ANSWER_ENTRY, {
			paper: label,
			grounded: report.grounded,
			heading: report.grounded
				? `Report -- ${label} (code-validated)`
				: `Report -- ${label} (UNGROUNDED DRAFT)`,
			text,
		});
		return false;
	}
	if (ctx.hasUI) {
		const lines = wrapText(text);
		ctx.ui.setWidget(SYNTH_WIDGET, lines.length > WIDGET_MAX_LINES
			? [...lines.slice(0, WIDGET_MAX_LINES - 1), "... (voller Report im HTML- bzw. JSON-Sidecar)"]
			: lines);
		return true;
	}
	return false;
}

/** Sign of life during a long, non-streaming engine call (pi's native
 * working indicator exists only while the AGENT streams). */
function startElapsedTicker(update: (line: string) => void): () => void {
	const started = Date.now();
	const interval = setInterval(() => {
		const seconds = Math.round((Date.now() - started) / 1000);
		update(`working -- ${seconds}s elapsed (embedding and generation do not stream; a run with many units can take minutes)`);
	}, 5000);
	return () => clearInterval(interval);
}

/**
 * Generator = the model currently selected in pi, called in a SEPARATE,
 * excerpts-only completion; embeddings stay on the configured local
 * embedding server. In runReport the review-genre units (mode B + review
 * synthesis) still route to the CONFIGURED generator (openscholar, v24
 * decision) -- this backend dispatches on the model name per call.
 */
function piModelBackend(ctx: ExtensionContext, local: LlmBackend, localModels: string[]): LlmBackend {
	const model = ctx.model!;
	return {
		label: `model selected in pi (${model.api} at ${model.baseUrl})`,
		embed: (texts, signal) => local.embed(texts, signal),
		generate: async (system, user, options, signal) => {
			// Review-genre calls name a configured local model -- run them there.
			if (options?.model && localModels.includes(options.model)) {
				return local.generate(system, user, options, signal);
			}
			// pi's extension loader provides this package at runtime; imported
			// lazily so the file stays loadable outside pi (smoke tests).
			const { completeSimple } = await import("@earendil-works/pi-ai");
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(`no credentials for ${model.provider}/${model.id}: ${auth.error}`);
			const response = await completeSimple(model, {
				systemPrompt: system,
				messages: [{ role: "user", content: user, timestamp: Date.now() }],
			}, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				temperature: options?.temperature,
				// Thinking OFF and a hard output cap (field failure 2026-07-20:
				// hidden reasoning ate the whole budget invisibly).
				reasoning: "off",
				maxTokens: options?.maxTokens ?? OUTPUT_RESERVE_TOKENS,
				signal,
			});
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				throw new Error(response.errorMessage || `generation ${response.stopReason}`);
			}
			const text = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
			if (!text.trim()) {
				const thought = response.content.some((part) => part.type === "thinking");
				throw new Error(
					`the model returned no answer text (stop reason: ${response.stopReason}`
					+ `${thought ? "; it produced only hidden reasoning" : ""}) -- ask again, `
					+ "rephrase, or select a non-thinking model in pi",
				);
			}
			return text;
		},
	};
}

/** The pi session id scopes the sticky scope and the protocol rounds;
 * fetched fresh per call (/new switches it mid-process). */
function sessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId() || undefined;
	} catch {
		return undefined;
	}
}

/* ------------------------------------------------------------------ *
 * Wizard steps                                                        *
 * ------------------------------------------------------------------ */

interface ScopeItems {
	items: CheckboxItem[];
	papersDir: string;
	unmatchedCount: number;
}

/** Checkbox items for the scope step: EVERY PDF in the folder, verified
 * papers with year+title, the rest honestly as filename-only. */
function scopeItems(diagnostics: string[]): ScopeItems {
	const match = matchLibrary(outputRoot(), (message) => diagnostics.push(message));
	const items: CheckboxItem[] = [
		...match.matched.map((paper) => ({
			id: paper.base,
			label: clip(`${paper.base}.pdf -- ${paper.entry.year ?? "n.d."}  ${paper.entry.title || "(title unknown)"}`),
		})),
		...match.unmatched.map((file) => ({
			id: file.replace(/\.pdf$/i, ""),
			label: clip(`${file} -- (no metadata yet; adoption is attempted, else cited by filename)`),
		})),
	];
	return { items, papersDir: match.papersDir, unmatchedCount: match.unmatched.length };
}

/** The scope step alone (bare chat entry): checkbox with select-all. A
 * full selection means the LIBRARY scope (grows with new PDFs). */
async function pickScope(
	ctx: ExtensionContext,
	diagnostics: string[],
	preselected: string[] | undefined,
	signal: AbortSignal | undefined,
): Promise<string[] | "library" | "empty" | null> {
	const { items } = scopeItems(diagnostics);
	if (!items.length) return "empty";
	const answers = await runWizard(ctx, [scopeStep(items, preselected)], signal);
	if (answers === null) return null;
	const picked = answers.papers as string[];
	return picked.length === items.length ? "library" : picked;
}

function scopeStep(items: CheckboxItem[], preselected?: string[]): WizardStepDef {
	return {
		kind: "checkbox",
		id: "papers",
		tab: "Dokumente",
		title: "Über welche Dokumente möchtest du sprechen?",
		items,
		selectAllLabel: "Alle auswählen (ganze Bibliothek)",
		nextLabel: "Weiter",
		preselected,
	};
}

interface ReportChoices {
	summary: "none" | "bullets" | "prose";
	detailMode: "per-paper" | "cross-paper";
	includeReview: boolean;
	saveHtml: boolean;
}

/** Questions of the live wizard answers (semicolon-separated text step). */
function questionsOf(answers: WizardAnswers | WizardResult): string[] {
	const value = answers.questions;
	return parseQuestionLines(typeof value === "string" ? value : "");
}

/** The questions intake as a wizard tab (v27: joined the ONE wizard;
 * semicolon separates -- "one per line" made no sense in the terminal). */
function questionsStep(initial?: string): WizardStepDef {
	return {
		kind: "text",
		id: "questions",
		tab: "Fragen",
		title: "Welche Frage(n) interessieren dich? (mit Semikolon trennen; leer lassen zum Chatten oder für nur Zusammenfassung)",
		placeholder: "leer = chatten oder nur Zusammenfassung",
		...(initial ? { initial } : {}),
	};
}

/**
 * The report-menu steps of the ONE wizard: summary format, detail mode
 * (appears only with >= 2 documents AND >= 1 question), review synthesis,
 * HTML (appears only when anything would be generated). scopeSizeOf reads
 * the LIVE answers, so the same steps work with the scope step in the same
 * wizard (bare /lit-synth) and with a scope settled beforehand (tool path).
 */
function reportSteps(
	scopeSizeOf: (answers: WizardAnswers) => number,
	defaults: Partial<ReportChoices>,
): WizardStepDef[] {
	return [
		{
			kind: "choice", id: "summary", tab: "Zusammenfassung",
			title: "Strukturierte Zusammenfassung je Dokument?",
			options: [
				{ value: "none", label: "Nein" },
				{ value: "bullets", label: "Ja, als Bulletpoints" },
				{ value: "prose", label: "Ja, als Fließtext" },
			],
			initial: defaults.summary ?? "bullets",
		},
		{
			kind: "choice", id: "detail", tab: "Fragen-Modus",
			title: "Detailfragen: pro Dokument einzeln oder übergreifend?",
			options: [
				{ value: "per-paper", label: "Pro Dokument einzeln (Modus A -- deckt jedes Dokument ab, mehr Modellaufrufe)" },
				{ value: "cross-paper", label: "Übergreifend zusammengeführt (Modus B -- ein Aufruf je Frage)" },
			],
			initial: defaults.detailMode ?? "per-paper",
			enabledIf: (answers) => scopeSizeOf(answers) > 1 && questionsOf(answers).length > 0,
		},
		{
			kind: "choice", id: "review", tab: "Review",
			title: "Review-Synthese (Stand der Literatur) anhängen? (Empfohlen bei ganzer Bibliothek; bei kleiner Auswahl oft schwach.)",
			options: [
				{ value: "yes", label: "Ja" },
				{ value: "no", label: "Nein" },
			],
			initial: defaults.includeReview ? "yes" : "no",
		},
		{
			kind: "choice", id: "html", tab: "HTML",
			title: "Als HTML speichern?",
			options: [
				{ value: "yes", label: "Ja, HTML-Bericht schreiben" },
				{ value: "no", label: "Nein, nur Antwort im Chat" },
			],
			initial: defaults.saveHtml === false ? "no" : "yes",
			enabledIf: (answers) =>
				questionsOf(answers).length > 0 || answers.summary !== "none" || answers.review === "yes",
		},
	];
}

/**
 * Liberal normalization of agent-passed report tokens (v27 field failure:
 * the agent sent summary '"bullets"' -- WITH literal quotes -- and pi's
 * schema validation rejected the call in an endless retry loop before our
 * code ever ran). The schema now accepts any string; THIS code maps it,
 * and anything unrecognized counts as "not given" (settled in the wizard)
 * instead of a hard validation dead end.
 */
function normalizeToken(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const cleaned = value.trim().replace(/^["'„“‚‘\s]+|["'“”‘’\s]+$/g, "").toLowerCase();
	return cleaned || undefined;
}

function normalizeSummary(value: string | undefined, onWarn: (message: string) => void): ReportChoices["summary"] | undefined {
	const token = normalizeToken(value);
	if (token === undefined) return undefined;
	if (["bullets", "bulletpoints", "bullet", "stichpunkte", "liste"].includes(token)) return "bullets";
	if (["prose", "prosa", "fliesstext", "fließtext", "text"].includes(token)) return "prose";
	if (["none", "no", "nein", "keine", "false", "off"].includes(token)) return "none";
	onWarn(`unrecognized summary value ${JSON.stringify(value)} -- treating it as not given (the dialog settles it)`);
	return undefined;
}

function normalizeDetailMode(value: string | undefined, onWarn: (message: string) => void): ReportChoices["detailMode"] | undefined {
	const token = normalizeToken(value)?.replace(/[\s_]+/g, "-");
	if (token === undefined) return undefined;
	if (["per-paper", "perpaper", "paper", "a", "mode-a", "modus-a"].includes(token)) return "per-paper";
	if (["cross-paper", "crosspaper", "cross", "b", "mode-b", "modus-b", "merged"].includes(token)) return "cross-paper";
	onWarn(`unrecognized detail_mode value ${JSON.stringify(value)} -- treating it as not given (the dialog settles it)`);
	return undefined;
}

/** THIS session's asked questions for the scope, read from the protocol
 * on disk (deduplicated, order of first asking) -- the report wizard's
 * question seed ("fasse das zusammen" shows the chat's questions,
 * editable). Best-effort: any problem just means an empty seed. */
function sessionSeedQuestions(root: string, scope: string[] | "library", session: string | undefined): string[] {
	if (!session) return [];
	try {
		const pool = chatPool(matchLibrary(root, () => {}));
		const id = scopeProtocolId(scope, pool);
		if (!id) return [];
		const { rounds } = loadRounds(root, id.base, id.key, session, realProtocolDeps(), () => {});
		const questions: string[] = [];
		for (const round of rounds) {
			if (!questions.includes(round.question)) questions.push(round.question);
		}
		return questions;
	} catch {
		return [];
	}
}

/** ReportChoices from a confirmed wizard result; steps that were disabled
 * at submit time fall back to the defaults (they are irrelevant then). */
function choicesOf(result: WizardResult, defaults: Partial<ReportChoices>): ReportChoices {
	return {
		summary: (result.summary as ReportChoices["summary"] | undefined) ?? defaults.summary ?? "bullets",
		detailMode: (result.detail as ReportChoices["detailMode"] | undefined) ?? defaults.detailMode ?? "per-paper",
		includeReview: result.review !== undefined ? result.review === "yes" : defaults.includeReview ?? false,
		saveHtml: result.html !== undefined ? result.html === "yes" : defaults.saveHtml ?? true,
	};
}

/** Honest cost arithmetic: mode A multiplies papers x questions. */
function reportUnitCount(
	scopeSize: number,
	questionCount: number,
	choices: Pick<ReportChoices, "summary" | "detailMode" | "includeReview">,
): number {
	return (choices.summary !== "none" ? scopeSize : 0)
		+ (questionCount ? (choices.detailMode === "per-paper" ? scopeSize * questionCount : questionCount) : 0)
		+ (choices.includeReview ? 1 : 0);
}

/** The computed line on the wizard's submit page: expected model calls, or
 * the honest "this will be a chat" when nothing would be generated. */
function reportSubmitNote(scopeSizeOf: (answers: WizardAnswers) => number): (answers: WizardAnswers) => string | null {
	return (answers) => {
		const scopeSize = scopeSizeOf(answers);
		if (!scopeSize || typeof answers.summary !== "string" || typeof answers.review !== "string") return null;
		const questionCount = questionsOf(answers).length;
		if (!questionCount && answers.summary === "none" && answers.review === "no") {
			return "Nichts zu generieren -- das wird ein Chat.";
		}
		const units = reportUnitCount(scopeSize, questionCount, {
			summary: answers.summary as ReportChoices["summary"],
			detailMode: (answers.detail as ReportChoices["detailMode"] | null) ?? "per-paper",
			includeReview: answers.review === "yes",
		});
		return `~${units} Modellaufruf(e), je etwa eine Minute lokal`;
	};
}

/** The report intake over a SETTLED scope (tool path): questions + report
 * menu in ONE wizard. Null on cancel. */
async function reportWizard(
	ctx: ExtensionContext,
	scopeSize: number,
	seedQuestions: string[] | undefined,
	defaults: Partial<ReportChoices>,
	signal: AbortSignal | undefined,
): Promise<{ questions: string[]; choices: ReportChoices } | null> {
	const scopeSizeOf = (): number => scopeSize;
	const steps: WizardStepDef[] = [
		questionsStep(seedQuestions?.join("; ")),
		...reportSteps(scopeSizeOf, defaults),
	];
	const answers = await runWizard(ctx, steps, signal, { submitNote: reportSubmitNote(scopeSizeOf) });
	if (answers === null) return null;
	return { questions: questionsOf(answers), choices: choicesOf(answers, defaults) };
}

/**
 * The per-question gate (v27 field decision "festzurren"): every chat call
 * arriving THROUGH THE AGENT shows the question it wants to run -- the
 * user fixes agent rephrasing (the measured root cause of weaker answers)
 * or types their own, Enter starts, Esc cancels. When the scope is not
 * settled yet, the scope step joins the SAME dialog (one wizard, not a
 * chain). skipSubmit: one Enter, no review page. Returns the confirmed
 * question ("" = none: hand the conversation back), the scope actually
 * confirmed, or null on cancel.
 */
async function questionGate(
	ctx: ExtensionContext,
	scope: string[] | "library" | null,
	proposed: string,
	diagnostics: string[],
	signal: AbortSignal | undefined,
): Promise<{ question: string; scope: string[] | "library" } | "empty" | null> {
	const steps: WizardStepDef[] = [];
	let items: CheckboxItem[] = [];
	if (!scope) {
		({ items } = scopeItems(diagnostics));
		if (!items.length) return "empty";
		steps.push(scopeStep(items));
	}
	const label = scope === "library" ? "die ganze Bibliothek"
		: Array.isArray(scope) ? scope.map((base) => `${base}.pdf`).join(", ")
		: null;
	steps.push({
		kind: "text",
		id: "question",
		tab: "Frage",
		title: label
			? clip(`Frage an ${label} -- prüfen/anpassen, Enter startet`)
			: "Deine Frage -- prüfen/anpassen, Enter startet",
		placeholder: "leer lassen: die Frage erst im Chat besprechen",
		...(proposed ? { initial: proposed } : {}),
	});
	const answers = await runWizard(ctx, steps, signal, { skipSubmit: true });
	if (answers === null) return null;
	const confirmedScope: string[] | "library" = scope
		?? ((answers.papers as string[]).length === items.length ? "library" : answers.papers as string[]);
	return { question: String(answers.question ?? "").trim(), scope: confirmedScope };
}

/* ------------------------------------------------------------------ *
 * Shared run paths                                                    *
 * ------------------------------------------------------------------ */

interface EngineWiring {
	deps: ChatDeps | undefined;
	/** Explain-genre model name (undefined: engine config default). */
	explainModel: string | undefined;
	generatorLine: string;
}

/** Generator resolution: explicit param > the model selected in pi (with
 * review-genre calls still routed to the configured local generator) >
 * the engine's config slots. */
function wireEngine(ctx: ExtensionContext, paramModel: string | undefined): EngineWiring {
	const cfg = llmConfig();
	if (paramModel) {
		return { deps: undefined, explainModel: paramModel, generatorLine: `Generator: ${paramModel} (${cfg.api} at ${cfg.baseUrl})` };
	}
	if (ctx.model) {
		const local = createBackend(cfg);
		const piName = `${ctx.model.provider}/${ctx.model.id}`;
		return {
			deps: { backend: piModelBackend(ctx, local, [cfg.generateModel]) },
			explainModel: piName,
			generatorLine: `Generator: ${piName} (pi) + ${cfg.generateModel} für Review-Genres; embeddings: ${cfg.embedModel}`,
		};
	}
	return { deps: undefined, explainModel: undefined, generatorLine: `Generator: (config default) (${cfg.api} at ${cfg.baseUrl})` };
}

/** One grounded round over the given scope, with ticker + answer card. */
async function runRoundWithUi(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: {
		question: string;
		papers?: string[] | "library";
		paper?: string;
		model?: string;
		topK?: number;
		language?: string;
		reindex?: boolean;
		onWarn: (message: string) => void;
		signal?: AbortSignal;
	},
): Promise<{ answer: ChatAnswer } | { error: string }> {
	const wiring = wireEngine(ctx, options.model);
	let keepWidget = false;
	let stopTicker = () => {};
	try {
		if (ctx.hasUI) {
			const widgetLines = [
				"Grounded answer from the selected documents",
				clip(`Question: ${options.question}`),
				`${wiring.generatorLine} -- progress appears below.`,
			];
			ctx.ui.setWidget(SYNTH_WIDGET, widgetLines);
			stopTicker = startElapsedTicker((line) => ctx.ui.setWidget(SYNTH_WIDGET, [...widgetLines, line]));
		}
		const answer = await runRound({
			question: options.question,
			papers: options.papers,
			paper: options.paper,
			session: sessionId(ctx),
			model: wiring.explainModel,
			topK: options.topK,
			language: options.language,
			reindex: options.reindex,
			onWarn: options.onWarn,
			signal: options.signal,
		}, wiring.deps);
		if (ctx.hasUI) {
			showAnswer(pi, ctx, answer);
			keepWidget = true;
		}
		return { answer };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		stopTicker();
		if (ctx.hasUI && !keepWidget) ctx.ui.setWidget(SYNTH_WIDGET, undefined);
	}
}

/** The composable report with ticker + transcript card; returns the
 * digest text. */
async function runReportWithUi(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: Omit<ReportOptions, "onWarn" | "onProgress" | "session" | "explainModel" | "reviewModel"> & { model?: string },
	saveHtml: boolean,
	onWarn: (message: string) => void,
	diagnostics: string[],
	signal: AbortSignal | undefined,
): Promise<{ digest: string } | { error: string }> {
	const wiring = wireEngine(ctx, options.model);
	let stopTicker = () => {};
	let keepWidget = false;
	const progressLines: string[] = [];
	const baseLines = [
		"Composable report from the selected documents",
		`${wiring.generatorLine}`,
	];
	try {
		if (ctx.hasUI) {
			ctx.ui.setWidget(SYNTH_WIDGET, baseLines);
			stopTicker = startElapsedTicker((line) => ctx.ui.setWidget(SYNTH_WIDGET, [...baseLines, ...progressLines.slice(-3), line]));
		}
		const result = await runReport({
			...options,
			model: options.model,
			explainModel: wiring.explainModel,
			session: sessionId(ctx),
			onWarn,
			onProgress: (message) => {
				progressLines.push(clip(message));
				onWarn(message);
			},
			signal,
		}, wiring.deps);
		let htmlPath: string | null = null;
		if (saveHtml) {
			try {
				const written = writeRunOutputs(renderSynthReportHtml(result), result, undefined, "reports");
				htmlPath = written.htmlPath;
				diagnostics.push(`wrote HTML report to ${written.htmlPath} and JSON copy to ${written.jsonPath}`);
			} catch (error) {
				diagnostics.push(`writing the output files failed: ${error instanceof Error ? error.message : error}`);
			}
		}
		// The durable answer in the chat -- with or without an HTML export.
		if (ctx.hasUI) keepWidget = showReport(pi, ctx, result, htmlPath);
		return { digest: renderReportDigest(result, htmlPath, !saveHtml) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		stopTicker();
		if (ctx.hasUI && !keepWidget) ctx.ui.setWidget(SYNTH_WIDGET, undefined);
	}
}

/* ------------------------------------------------------------------ *
 * Registration                                                        *
 * ------------------------------------------------------------------ */

export default async function literatureSynthesize(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi-literature-synthesize",
		label: "Literature Synthesis",
		description:
			"Chat about and report on the LOCAL PDF papers (papers/ or the current folder): grounded answers with " +
			"page-exact, code-validated citations over ONE paper, a selection, or the whole library. Use this tool " +
			"WHENEVER the user wants to chat about, understand, question, summarize, review or report on local " +
			"papers/PDFs -- including German requests like 'zu einem Paper chatten', 'erklaere mir das Paper', " +
			"'Frage zum Paper', 'zusammenfassen', 'Bericht/Report erstellen'. NOT this tool: searching ONLINE for " +
			"new literature (pi-literature-search) or downloading PDFs (pi-literature-fetch). " +
			"Call this tool DIRECTLY and IMMEDIATELY, even without a concrete question ('ich moechte ueber ein " +
			"Paper chatten'): when the document scope is missing, the tool shows a terminal dialog where the user " +
			"picks the documents -- never ask in chat which paper is meant. The tool REMEMBERS the session's scope: " +
			"follow-up calls only need the question (self-contained -- the generator has no chat memory); set " +
			"pick: true when the user wants to switch documents. " +
			"TWO MODES. (1) CHAT: pass question -> one grounded answer. Pass the user's question VERBATIM, in " +
			"their language and wording -- retrieval is measurably sensitive to phrasing; only substitute a " +
			"pronoun's referent when the question alone would be ambiguous, never rephrase, expand or translate " +
			"it. The tool shows the question to the user in its own dialog for confirmation before the run, so " +
			"call the tool IMMEDIATELY instead of discussing the question in chat first. The digest carries the answer between " +
			"'--- answer ---' delimiters: output that text EXACTLY as written, unchanged, including the [n] " +
			"markers -- never summarize, extend, translate or 'improve' it, and never re-type titles, authors or " +
			"identifiers: copy reference lines EXACTLY. If it FAILED to ground, relay the warning verbatim. " +
			"(2) REPORT: set report: true (or pass questions/summary/include_review) for the composable HTML " +
			"report -- per-paper structured summaries, detail questions, optional review synthesis. Report mode is " +
			"ALSO the only way to save/export/print anything from this chat ('mach mir eine html', 'save this'): " +
			"NEVER write an HTML or any other file about these papers yourself. The report intake ALWAYS runs " +
			"in the tool's own wizard dialog: any parameters you pass and the questions already asked in this " +
			"session's chat merely PREFILL it, the user confirms. So for 'fasse das zusammen' just call " +
			"report: true without inventing questions. If the user cancelled a dialog, ask what they want to " +
			"change; do not retry unchanged. " +
			"The answers are written by a separate LOCAL generator in excerpts-only calls (not by you); fixed code " +
			"validates every citation marker and builds references from HTTP-verified records. Loose PDFs are " +
			"adopted automatically when their DOI/arXiv ID can be extracted and verified; unverified PDFs are " +
			"cited honestly by filename and page. Never supply metadata for a PDF yourself.",
		promptSnippet:
			"Chat about local PDFs with page-exact, code-validated citations; report mode writes the composable " +
			"HTML report. EVERY question about the papers goes through this tool (the scope is remembered); never " +
			"answer from memory, relay validated answers verbatim.",
		parameters: Type.Object({
			question: Type.Optional(Type.String({
				description: "The user's question for ONE grounded chat answer, VERBATIM in their wording and language (retrieval is sensitive to phrasing; only substitute a pronoun's referent when needed, never rephrase or translate). Omit on an opening move without a concrete question -- the user then picks the scope and you ask for their question.",
			})),
			papers: Type.Optional(Type.Array(Type.String(), {
				description: "Document scope: PDF filenames from the library. Omit to use the session's remembered scope (or let the user pick in the dialog).",
			})),
			library: Type.Optional(Type.Boolean({
				description: "true: the scope is the WHOLE library (every PDF in the folder).",
			})),
			pick: Type.Optional(Type.Boolean({
				description: "true: show the document picker even though a scope is remembered -- use when the user wants to switch documents.",
			})),
			report: Type.Optional(Type.Boolean({
				description: "true: build the composable HTML report instead of answering one question (missing choices are settled in the tool's wizard).",
			})),
			questions: Type.Optional(Type.Array(Type.String(), {
				description: "Report mode: the detail questions, one string each, in the user's words.",
			})),
			summary: Type.Optional(Type.String({
				description: "Report mode: structured per-paper summary -- \"bullets\", \"prose\" or \"none\" (free string; the tool normalizes and lets the user confirm in its dialog).",
			})),
			detail_mode: Type.Optional(Type.String({
				description: "Report mode: \"per-paper\" (mode A, covers every document) or \"cross-paper\" (mode B, one call per question). Free string; normalized by the tool.",
			})),
			include_review: Type.Optional(Type.Boolean({
				description: "Report mode: append a review synthesis (state of the literature) over the scope.",
			})),
			save_html: Type.Optional(Type.Boolean({
				description: "Report mode: write the HTML file (default true; false keeps the result in the digest only).",
			})),
			model: Type.Optional(Type.String({
				description: "Generator model override. Default: the model selected in pi for chat/summaries, the configured generator for review genres. Only pass when the user explicitly asks.",
			})),
			top_k: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: MAX_TOP_K,
				description: `Excerpts to retrieve as context per unit, default ${DEFAULT_TOP_K}, capped at ${MAX_TOP_K}.`,
			})),
			language: Type.Optional(Type.String({
				description: "Output language of the prose, e.g. \"German\". Default: the language of the question.",
			})),
			reindex: Type.Optional(Type.Boolean({
				description: "Force re-extraction and re-embedding (default: cached per content hash and embedding model).",
			})),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const diagnostics: string[] = [];
			const report = (message: string) => {
				diagnostics.push(message);
				onUpdate?.({ content: [{ type: "text", text: message }] });
			};
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: { diagnostics } });
			let question = params.question?.trim() ?? "";
			const wantsReport = params.report === true
				|| params.questions !== undefined
				|| params.summary !== undefined
				|| params.include_review !== undefined
				|| params.save_html !== undefined;
			const root = outputRoot();

			// 1. Scope: params > sticky (unless pick). The DIALOGS follow per
			// mode: chat runs the question gate (scope step included when the
			// scope is still open), report runs the scope picker + wizard.
			let scope: string[] | "library" | undefined = params.library === true
				? "library"
				: params.papers?.length ? params.papers.map((name) => name.trim().replace(/\.pdf$/i, "")) : undefined;
			if (!scope && params.pick !== true) {
				const sticky = readCurrentScope(root, sessionId(ctx));
				if (sticky) {
					scope = sticky.papers;
					report(`using the session's scope: ${scope === "library" ? "whole library" : scope.join(", ")} (pick: true switches)`);
				}
			}
			if (signal?.aborted) return reply("The run was aborted before anything was generated.");

			// 2. CHAT mode: the question gate (v27 "festzurren"), then one
			// grounded round. The gate shows the question the agent passed --
			// prefilled, editable -- because agents measurably rephrase the
			// user's words; the confirmed text is what the engine runs.
			if (!wantsReport) {
				let confirmedScope = scope;
				if (ctx.hasUI) {
					const gate = await questionGate(ctx, scope ?? null, question, diagnostics, signal);
					if (gate === null) {
						return reply("The user cancelled the question dialog. Nothing was generated. Ask what they want instead; do not retry unchanged.");
					}
					if (gate === "empty") {
						return reply("The library holds no PDFs at all -- run a literature search and fetch first (or start pi in the folder containing the PDFs).");
					}
					confirmedScope = gate.scope;
					if (!scope) {
						diagnostics.push(`scope picked in the dialog: ${confirmedScope === "library" ? "whole library" : confirmedScope.join(", ")}`);
					}
					// Remember immediately: the round may still end questionless.
					writeCurrentScope(root, { papers: confirmedScope }, sessionId(ctx), undefined, (message) => diagnostics.push(message));
					question = gate.question;
				} else if (!confirmedScope) {
					const pool = chatPool(matchLibrary(root, (message) => diagnostics.push(message)));
					const available = pool.map((entry) => `${entry.base}.pdf`).join(", ") || "(none)";
					return reply(`No scope was given and no interactive picker is available. Pass papers or library: true; PDFs in the library: ${available}`);
				}
				if (!question) {
					const label = confirmedScope === "library" ? "the whole library" : confirmedScope!.map((base) => `${base}.pdf`).join(", ");
					return reply(
						`The user selected ${label} for a grounded chat (already settled -- do not ask again) and `
						+ "left the question dialog empty. Ask the user what they want to know about these documents, "
						+ "then call this tool again with their question (the scope is remembered; the user confirms "
						+ "the final wording in the tool's own dialog).",
					);
				}
				const outcome = await runRoundWithUi(pi, ctx, {
					question,
					papers: confirmedScope,
					model: params.model?.trim() || undefined,
					topK: params.top_k,
					language: params.language,
					reindex: params.reindex,
					onWarn: report,
					signal,
				});
				if ("error" in outcome) {
					return reply(
						`The chat run failed: ${outcome.error} -- nothing was generated. Report this to the user `
						+ "verbatim. If it names an unreachable LLM server, Ollama is probably not running; the "
						+ "user can verify the backend with: node src/cli.ts llm-check",
					);
				}
				return reply(renderChatDigest(outcome.answer));
			}

			// REPORT mode: settle a missing scope in the picker first.
			if (!scope) {
				if (!ctx.hasUI) {
					const pool = chatPool(matchLibrary(root, (message) => diagnostics.push(message)));
					const available = pool.map((entry) => `${entry.base}.pdf`).join(", ") || "(none)";
					return reply(`No scope was given and no interactive picker is available. Pass papers or library: true; PDFs in the library: ${available}`);
				}
				const picked = await pickScope(ctx, diagnostics, undefined, signal);
				if (picked === null) {
					return reply("The user cancelled the document selection. Nothing was generated. Ask which documents they want to discuss.");
				}
				if (picked === "empty") {
					return reply("The library holds no PDFs at all -- run a literature search and fetch first (or start pi in the folder containing the PDFs).");
				}
				scope = picked;
				diagnostics.push(`scope picked in the dialog: ${scope === "library" ? "whole library" : scope.join(", ")}`);
				writeCurrentScope(root, { papers: scope }, sessionId(ctx), undefined, (message) => diagnostics.push(message));
			}

			// 3. REPORT mode: with a UI the wizard runs ALWAYS (v27 field
			// decision) -- agent parameters and THIS session's chat questions
			// only PREFILL it; the user confirms on the submit page. Headless
			// runs stay parameter-authoritative.
			const scopeSize = scope === "library"
				? chatPool(matchLibrary(root, () => {})).length
				: scope.length;
			let questions = params.questions?.map((entry) => entry.trim()).filter(Boolean);
			const summaryParam = normalizeSummary(params.summary, report);
			const detailParam = normalizeDetailMode(params.detail_mode, report);
			let choices: ReportChoices = {
				summary: summaryParam ?? "bullets",
				detailMode: detailParam ?? "per-paper",
				includeReview: params.include_review ?? scope === "library",
				saveHtml: params.save_html ?? true,
			};
			if (ctx.hasUI) {
				// Question seed: agent-passed questions, else what was actually
				// asked in this session's chat ("fasse das zusammen").
				const seed = questions?.length ? questions : sessionSeedQuestions(root, scope, sessionId(ctx));
				const intake = await reportWizard(ctx, scopeSize, seed, {
					...choices,
					summary: summaryParam ?? (seed.length ? "none" : "bullets"),
				}, signal);
				if (intake === null) return reply("The user cancelled the report wizard. Nothing was generated. Ask what they want to change; do not retry unchanged.");
				questions = intake.questions;
				choices = intake.choices;
			} else {
				questions = questions ?? [];
			}

			// Nothing to report -> this is a chat after all (handoff to the agent).
			if (!questions.length && choices.summary === "none" && !choices.includeReview) {
				return reply(
					"The user selected documents but chose no summary, no questions and no review -- they want to "
					+ "CHAT. Ask what they would like to know; route every question through this tool (the scope "
					+ "is remembered).",
				);
			}

			// Honest cost warning: mode A multiplies papers x questions.
			const unitCount = reportUnitCount(scopeSize, questions.length, choices);
			if (ctx.hasUI && unitCount > UNIT_WARN_THRESHOLD) {
				const go = await ctx.ui.select(
					`Dieser Report braucht ${unitCount} Modellaufrufe (je etwa eine Minute lokal). Fortfahren?`,
					["Ja, ausführen", "Abbrechen"],
					{ signal },
				);
				if (go !== "Ja, ausführen") {
					return reply(`The user cancelled: the report would need ${unitCount} generation calls. Suggest fewer questions, mode B, or a smaller scope.`);
				}
			}

			const outcome = await runReportWithUi(pi, ctx, {
				papers: scope,
				questions,
				summary: choices.summary,
				detailMode: choices.detailMode,
				includeReview: choices.includeReview,
				model: params.model?.trim() || undefined,
				topK: params.top_k,
				language: params.language,
				reindex: params.reindex,
			}, choices.saveHtml, report, diagnostics, signal);
			if ("error" in outcome) {
				return reply(
					`The report run failed: ${outcome.error} -- nothing was generated. Report this to the user `
					+ "verbatim. If it names an unreachable LLM server, Ollama is probably not running; the user "
					+ "can verify the backend with: node src/cli.ts llm-check",
				);
			}
			return reply(outcome.digest);
		},
	});

	// /lit-synth -- ONE command for the whole stage. Bare: ONE wizard
	// (documents -> questions -> report menu -> submit, v27); a pure chat
	// wish hands the loop to the agent (v22 doctrine). With arguments: ONE
	// agent-free grounded round.
	pi.registerCommand("lit-synth", {
		description:
			"Chat about and report on local PDFs with verified citations. Bare /lit-synth runs the wizard "
			+ "(documents, questions, report menu); /lit-synth <question> answers once, agent-free.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const question = (args ?? "").trim();
			const diagnostics: string[] = [];
			const progress = (message: string) => ctx.ui.notify(message, "info");
			const root = outputRoot();
			const session = sessionId(ctx);
			const sticky = readCurrentScope(root, session);

			if (question) {
				// Agent-free one-shot round: sticky scope, else the scope picker.
				let scope: string[] | "library" | null | "empty" = sticky ? sticky.papers : null;
				if (!scope) {
					scope = await pickScope(ctx, diagnostics, undefined, ctx.signal);
				}
				if (scope === null) return; // cancelled
				if (scope === "empty") {
					ctx.ui.notify("No PDFs in the library -- run a search and fetch first, or start pi in the papers folder.", "warning");
					return;
				}
				writeCurrentScope(root, { papers: scope }, session, undefined, (message) => diagnostics.push(message));
				const outcome = await runRoundWithUi(pi, ctx, {
					question,
					papers: scope,
					onWarn: progress,
					signal: ctx.signal,
				});
				if ("error" in outcome) ctx.ui.notify(`chat failed: ${outcome.error}`, "error");
				return;
			}

			// Bare invocation: EVERYTHING in ONE wizard (v27) -- the scope step
			// always re-offers the picker (preselected with the sticky scope)
			// so the user can switch documents without the agent.
			const { items } = scopeItems(diagnostics);
			if (!items.length) {
				ctx.ui.notify("No PDFs in the library -- run a search and fetch first, or start pi in the papers folder.", "warning");
				return;
			}
			const preselected = Array.isArray(sticky?.papers) ? sticky.papers
				: sticky?.papers === "library" ? items.map((item) => item.id)
				: undefined;
			const scopeSizeOf = (answers: WizardAnswers): number =>
				Array.isArray(answers.papers) ? answers.papers.length : 0;
			const steps: WizardStepDef[] = [
				scopeStep(items, preselected),
				questionsStep(),
				...reportSteps(scopeSizeOf, { summary: "bullets" }),
			];
			const answers = await runWizard(ctx, steps, ctx.signal, { submitNote: reportSubmitNote(scopeSizeOf) });
			if (answers === null) return; // cancelled
			const picked = answers.papers as string[];
			const scope: string[] | "library" = picked.length === items.length ? "library" : picked;
			writeCurrentScope(root, { papers: scope }, session, undefined, (message) => diagnostics.push(message));
			const questions = questionsOf(answers);
			const choices = choicesOf(answers, { summary: "bullets" });
			const scopeSize = scope === "library" ? chatPool(matchLibrary(root, () => {})).length : scope.length;

			if (!questions.length && choices.summary === "none" && !choices.includeReview) {
				// Chat wish: hand the loop to the agent (v22 pattern).
				const label = scope === "library" ? "the whole library" : scope.map((base) => `${base}.pdf`).join(", ");
				pi.sendMessage({
					customType: "pi-literature-synth-handoff",
					content:
						`The user picked ${label} for a grounded chat via /lit-synth. `
						+ "Ask them now, in ONE short sentence, what they would like to know -- mention that an "
						+ "overview, specific details, or bullet points are all fine, in German or English. Route "
						+ "EVERY question through the pi-literature-synthesize tool: pass only the question (the "
						+ "scope is remembered) and relay each validated answer verbatim. If they ask for a "
						+ "summary, an HTML, or to save/export anything, call the tool with report: true -- never "
						+ "write such a file yourself.",
					display: false,
				}, { triggerTurn: true });
				return;
			}

			const unitCount = reportUnitCount(scopeSize, questions.length, choices);
			if (unitCount > UNIT_WARN_THRESHOLD) {
				const go = await ctx.ui.select(
					`Dieser Report braucht ${unitCount} Modellaufrufe (je etwa eine Minute lokal). Fortfahren?`,
					["Ja, ausführen", "Abbrechen"],
					{ signal: ctx.signal },
				);
				if (go !== "Ja, ausführen") return;
			}

			const outcome = await runReportWithUi(pi, ctx, {
				papers: scope,
				questions,
				summary: choices.summary,
				detailMode: choices.detailMode,
				includeReview: choices.includeReview,
			}, choices.saveHtml, progress, diagnostics, ctx.signal);
			if ("error" in outcome) {
				ctx.ui.notify(`report failed: ${outcome.error}`, "error");
			}
			// The report itself is a transcript card (showReport); no widget
			// digest on top of it.
		},
	});

	// HTML-export gate (v23 field failure, moved here in E2e and now hanging
	// on the sticky SCOPE): while any document scope is active in THIS
	// session, an agent write/edit of an .html file opens a blocking dialog;
	// the default is to block and send the agent to report mode.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		// pi's write/edit accept file_path with path as a fallback alias.
		const input = event.input as { file_path?: unknown; path?: unknown } | undefined;
		const path = typeof input?.file_path === "string" ? input.file_path
			: typeof input?.path === "string" ? input.path : "";
		if (!/\.html?$/i.test(path)) return;
		const sticky = readCurrentScope(outputRoot(), sessionId(ctx));
		if (!sticky) return;
		const label = sticky.papers === "library" ? "the whole library" : sticky.papers.map((base) => `${base}.pdf`).join(", ");
		const blockReason =
			`Blocked by pi-literature-review: a grounded document chat (${label}) is active. HTML exports come `
			+ "from the pi-literature-synthesize tool with report: true (deterministic HTML with verified "
			+ "citations and page-exact PDF links). Call that tool now instead of writing a file yourself.";
		if (!ctx.hasUI) return { block: true, reason: blockReason };
		const OPTION_BLOCK = "Block it: generate the deterministic report instead (report: true)";
		const OPTION_ALLOW = "Allow this write: the file is unrelated to the document chat";
		const choice = await ctx.ui.select(
			`The agent wants to hand-write ${path} while a document chat (${label}) is active. `
			+ "Chat exports should be the code-validated report, never an agent-written file.",
			[OPTION_BLOCK, OPTION_ALLOW],
			{ signal: ctx.signal },
		);
		if (choice === OPTION_ALLOW) return;
		return { block: true, reason: blockReason }; // chosen block, Esc or abort
	});

	// Rich transcript rendering for validated answers (appendEntry cards).
	// pi-tui exists only at pi runtime; fall back to the capped widget.
	try {
		const { Box, Text } = await import("@earendil-works/pi-tui");
		pi.registerEntryRenderer(ANSWER_ENTRY, (entry, _state, theme) => {
			const data = entry.data as { paper: string; text: string; grounded: boolean; heading?: string };
			const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
			const heading = data.heading ?? (data.grounded
				? `Paper chat -- ${data.paper} (code-validated)`
				: `Paper chat -- ${data.paper} (UNGROUNDED DRAFT)`);
			box.addChild(new Text(theme.bold(heading)));
			for (const line of data.text.split("\n")) box.addChild(new Text(line));
			return box;
		});
		answerEntryReady = true;
	} catch {
		// pi-tui unavailable -> the capped widget fallback stays in effect.
	}
}
