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
import { type CheckboxItem, type WizardStepDef } from "../src/dialog-state.ts";
import { matchLibrary } from "../src/corpus.ts";
import { renderChatDigest, renderReportDigest } from "../src/digest.ts";
import { createBackend, type LlmBackend } from "../src/llm.ts";
import { outputRoot, writeRunOutputs } from "../src/output.ts";
import { readCurrentScope, writeCurrentScope } from "../src/protocol.ts";
import { renderSynthReportHtml } from "../src/render.ts";
import {
	type ChatAnswer,
	type ChatDeps,
	chatPool,
	DEFAULT_TOP_K,
	MAX_TOP_K,
	OUTPUT_RESERVE_TOKENS,
	type ReportOptions,
	runReport,
	runRound,
} from "../src/synthesize.ts";
import { questionList, runWizard } from "./dialogs.ts";

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

function answerWidgetLines(answer: ChatAnswer, scopeLabel: string): string[] {
	const referenceLines = answer.references.map((reference) => {
		const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}` : reference.key);
		return clip(`[${reference.n}] ${reference.year ?? "n.d."} | ${id} | ${reference.title} (S. ${reference.pages.join(", ")})`);
	});
	const lines = [
		answer.grounded
			? `Validated answer (code-checked) -- ${scopeLabel}`
			: `UNGROUNDED DRAFT (not usable as an answer) -- ${scopeLabel}`,
		...wrapText(answer.prose),
		...referenceLines,
	];
	return lines.length > WIDGET_MAX_LINES
		? [...lines.slice(0, WIDGET_MAX_LINES - 1), "... (the full validated answer is in the session protocol)"]
		: lines;
}

function formatAnswerText(answer: ChatAnswer): string {
	const refs = answer.references.map((reference) => {
		const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}` : reference.key);
		return `[${reference.n}] ${reference.year ?? "n.d."} | ${id} | ${reference.title} (S. ${reference.pages.join(", ")})`;
	});
	return `${answer.prose}${refs.length ? `\n\n${refs.join("\n")}` : ""}`;
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

/** The report-menu wizard (after the questions editor): summary format,
 * detail mode (only with >= 2 papers and >= 1 question), review synthesis
 * (recommended on the library scope, weakness note otherwise), HTML. */
async function pickReportChoices(
	ctx: ExtensionContext,
	scopeSize: number,
	libraryScope: boolean,
	questionCount: number,
	defaults: Partial<ReportChoices>,
	signal: AbortSignal | undefined,
): Promise<ReportChoices | null> {
	const steps: WizardStepDef[] = [
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
		...(scopeSize > 1 && questionCount > 0
			? [{
				kind: "choice", id: "detail", tab: "Fragen-Modus",
				title: "Detailfragen: pro Dokument einzeln oder übergreifend?",
				options: [
					{ value: "per-paper", label: "Pro Dokument einzeln (Modus A -- deckt jedes Dokument ab, mehr Modellaufrufe)" },
					{ value: "cross-paper", label: "Übergreifend zusammengeführt (Modus B -- ein Aufruf je Frage)" },
				],
				initial: defaults.detailMode ?? "per-paper",
			} satisfies WizardStepDef]
			: []),
		{
			kind: "choice", id: "review", tab: "Review",
			title: libraryScope
				? "Review-Synthese (Stand der Literatur) anhängen?"
				: "Review-Synthese anhängen? (Bei kleiner Auswahl oft schwach.)",
			options: [
				{ value: "yes", label: "Ja" },
				{ value: "no", label: "Nein" },
			],
			initial: defaults.includeReview ?? libraryScope ? "yes" : "no",
		},
		{
			kind: "choice", id: "html", tab: "HTML",
			title: "Als HTML speichern?",
			options: [
				{ value: "yes", label: "Ja, HTML-Bericht schreiben" },
				{ value: "no", label: "Nein, nur Kurzfassung im Chat" },
			],
			initial: defaults.saveHtml === false ? "no" : "yes",
		},
	];
	const answers = await runWizard(ctx, steps, signal);
	if (answers === null) return null;
	return {
		summary: answers.summary as ReportChoices["summary"],
		detailMode: (answers.detail as ReportChoices["detailMode"] | undefined) ?? defaults.detailMode ?? "per-paper",
		includeReview: answers.review === "yes",
		saveHtml: answers.html === "yes",
	};
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

/** The composable report with ticker; returns the digest text. */
async function runReportWithUi(
	ctx: ExtensionContext,
	options: Omit<ReportOptions, "onWarn" | "onProgress" | "session" | "explainModel" | "reviewModel"> & { model?: string },
	saveHtml: boolean,
	onWarn: (message: string) => void,
	diagnostics: string[],
	signal: AbortSignal | undefined,
): Promise<{ digest: string } | { error: string }> {
	const wiring = wireEngine(ctx, options.model);
	let stopTicker = () => {};
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
		return { digest: renderReportDigest(result, htmlPath, !saveHtml) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		stopTicker();
		if (ctx.hasUI) ctx.ui.setWidget(SYNTH_WIDGET, undefined);
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
			"TWO MODES. (1) CHAT: pass question -> one grounded answer; the digest carries it between " +
			"'--- answer ---' delimiters: output that text EXACTLY as written, unchanged, including the [n] " +
			"markers -- never summarize, extend, translate or 'improve' it, and never re-type titles, authors or " +
			"identifiers: copy reference lines EXACTLY. If it FAILED to ground, relay the warning verbatim. " +
			"(2) REPORT: set report: true (or pass questions/summary/include_review) for the composable HTML " +
			"report -- per-paper structured summaries, detail questions, optional review synthesis. Report mode is " +
			"ALSO the only way to save/export/print anything from this chat ('mach mir eine html', 'save this'): " +
			"NEVER write an HTML or any other file about these papers yourself. Missing report choices are " +
			"settled in the tool's own wizard dialog; with complete parameters a compact consent dialog runs " +
			"instead. If the user cancelled a dialog, ask what they want to change; do not retry unchanged. " +
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
				description: "The user's question for ONE grounded chat answer, self-contained (resolve pronouns yourself). Omit on an opening move without a concrete question -- the user then picks the scope and you ask for their question.",
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
			summary: Type.Optional(Type.Union([
				Type.Literal("bullets"), Type.Literal("prose"), Type.Literal("none"),
			], {
				description: "Report mode: structured per-paper summary as bullet points, prose, or none.",
			})),
			detail_mode: Type.Optional(Type.Union([
				Type.Literal("per-paper"), Type.Literal("cross-paper"),
			], {
				description: "Report mode: answer detail questions per paper (mode A, covers every document) or merged across papers (mode B, one call per question).",
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
			const question = params.question?.trim() ?? "";
			const wantsReport = params.report === true
				|| params.questions !== undefined
				|| params.summary !== undefined
				|| params.include_review !== undefined
				|| params.save_html !== undefined;
			const root = outputRoot();

			// 1. Scope: params > sticky (unless pick) > wizard.
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
				// Remember immediately: the opening move may end before any run.
				writeCurrentScope(root, { papers: scope }, sessionId(ctx), undefined, (message) => diagnostics.push(message));
			}
			if (signal?.aborted) return reply("The run was aborted before anything was generated.");

			// 2. CHAT mode: one grounded round.
			if (!wantsReport) {
				if (!question) {
					const label = scope === "library" ? "the whole library" : scope.map((base) => `${base}.pdf`).join(", ");
					return reply(
						`The user selected ${label} for a grounded chat (already settled -- do not ask again). `
						+ "Ask the user what they want to know about these documents, then call this tool again "
						+ "with their question (the scope is remembered).",
					);
				}
				const outcome = await runRoundWithUi(pi, ctx, {
					question,
					papers: scope,
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

			// 3. REPORT mode: settle the menu (params > wizard), then run.
			const scopeSize = scope === "library"
				? chatPool(matchLibrary(root, () => {})).length
				: scope.length;
			let questions = params.questions?.map((entry) => entry.trim()).filter(Boolean);
			let choices: ReportChoices = {
				summary: params.summary ?? "bullets",
				detailMode: params.detail_mode ?? "per-paper",
				includeReview: params.include_review ?? scope === "library",
				saveHtml: params.save_html ?? true,
			};
			const fullySpecified = params.questions !== undefined && params.summary !== undefined && params.save_html !== undefined;
			if (ctx.hasUI && fullySpecified) {
				// Compact consent instead of the four wizard steps.
				const summaryLabel = choices.summary === "none" ? "keine" : choices.summary;
				const menu = `Zusammenfassung: ${summaryLabel} | Fragen: ${questions!.length} (${choices.detailMode}) | `
					+ `Review: ${choices.includeReview ? "ja" : "nein"} | HTML: ${choices.saveHtml ? "ja" : "nein"}`;
				const consent = await ctx.ui.select(
					`Report über ${scope === "library" ? "die ganze Bibliothek" : `${scopeSize} Dokument(e)`} -- ${menu}`,
					["Run as proposed", "Anpassen (Wizard)", "Abbrechen"],
					{ signal },
				);
				if (consent === undefined || consent === "Abbrechen") {
					return reply("The user cancelled the report consent dialog. Nothing was generated. Ask what they want to change.");
				}
				if (consent === "Anpassen (Wizard)") {
					const editedQuestions = await questionList(ctx, "Welche Frage(n) interessieren dich? (eine pro Zeile)", questions!.join("\n"), signal);
					if (editedQuestions === null) return reply("The user cancelled the report wizard. Nothing was generated.");
					questions = editedQuestions;
					const picked = await pickReportChoices(ctx, scopeSize, scope === "library", questions.length, choices, signal);
					if (picked === null) return reply("The user cancelled the report wizard. Nothing was generated.");
					choices = picked;
				}
			} else if (ctx.hasUI && !fullySpecified) {
				if (questions === undefined) {
					const asked = await questionList(ctx, "Welche Frage(n) interessieren dich? (eine pro Zeile; leer lassen für nur Zusammenfassung)", "", signal);
					if (asked === null) return reply("The user cancelled the question intake. Nothing was generated.");
					questions = asked;
				}
				const picked = await pickReportChoices(ctx, scopeSize, scope === "library", questions.length, {
					...choices,
					summary: params.summary ?? (questions.length ? "none" : "bullets"),
				}, signal);
				if (picked === null) return reply("The user cancelled the report wizard. Nothing was generated.");
				choices = picked;
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
			const unitCount = (choices.summary !== "none" ? scopeSize : 0)
				+ (questions.length ? (choices.detailMode === "per-paper" ? scopeSize * questions.length : questions.length) : 0)
				+ (choices.includeReview ? 1 : 0);
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

			const outcome = await runReportWithUi(ctx, {
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

	// /lit-synth -- ONE command for the whole stage. Bare: wizard (scope ->
	// questions -> report menu); a pure chat wish hands the loop to the agent
	// (v22 doctrine). With arguments: ONE agent-free grounded round.
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

			// Scope: sticky, else wizard (bare invocation ALWAYS re-offers the
			// picker so the user can switch without the agent).
			const sticky = readCurrentScope(root, session);
			let scope: string[] | "library" | null | "empty" = question && sticky ? sticky.papers : null;
			if (!scope) {
				scope = await pickScope(ctx, diagnostics, Array.isArray(sticky?.papers) ? sticky.papers : undefined, ctx.signal);
			}
			if (scope === null) return; // cancelled
			if (scope === "empty") {
				ctx.ui.notify("No PDFs in the library -- run a search and fetch first, or start pi in the papers folder.", "warning");
				return;
			}
			writeCurrentScope(root, { papers: scope }, session, undefined, (message) => diagnostics.push(message));

			if (question) {
				// Agent-free one-shot round.
				const outcome = await runRoundWithUi(pi, ctx, {
					question,
					papers: scope,
					onWarn: progress,
					signal: ctx.signal,
				});
				if ("error" in outcome) ctx.ui.notify(`chat failed: ${outcome.error}`, "error");
				return;
			}

			// Bare invocation: questions -> report menu -> report or handoff.
			const questions = await questionList(ctx, "Welche Frage(n) interessieren dich? (eine pro Zeile; leer lassen zum Chatten oder für nur Zusammenfassung)", "", ctx.signal);
			if (questions === null) return;
			const scopeSize = scope === "library" ? chatPool(matchLibrary(root, () => {})).length : scope.length;
			const choices = await pickReportChoices(ctx, scopeSize, scope === "library", questions.length, {
				summary: questions.length ? "none" : "bullets",
			}, ctx.signal);
			if (choices === null) return;

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

			const unitCount = (choices.summary !== "none" ? scopeSize : 0)
				+ (questions.length ? (choices.detailMode === "per-paper" ? scopeSize * questions.length : questions.length) : 0)
				+ (choices.includeReview ? 1 : 0);
			if (unitCount > UNIT_WARN_THRESHOLD) {
				const go = await ctx.ui.select(
					`Dieser Report braucht ${unitCount} Modellaufrufe (je etwa eine Minute lokal). Fortfahren?`,
					["Ja, ausführen", "Abbrechen"],
					{ signal: ctx.signal },
				);
				if (go !== "Ja, ausführen") return;
			}

			const outcome = await runReportWithUi(ctx, {
				papers: scope,
				questions,
				summary: choices.summary,
				detailMode: choices.detailMode,
				includeReview: choices.includeReview,
			}, choices.saveHtml, progress, diagnostics, ctx.signal);
			if ("error" in outcome) {
				ctx.ui.notify(`report failed: ${outcome.error}`, "error");
				return;
			}
			const digestLines = outcome.digest.split("\n");
			ctx.ui.setWidget(SYNTH_WIDGET, digestLines.length > 16
				? [...digestLines.slice(0, 15), `... (${digestLines.length - 15} more lines -- full report in the HTML)`]
				: digestLines);
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
			const data = entry.data as { paper: string; text: string; grounded: boolean };
			const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
			const heading = data.grounded
				? `Paper chat -- ${data.paper} (code-validated)`
				: `Paper chat -- ${data.paper} (UNGROUNDED DRAFT)`;
			box.addChild(new Text(theme.bold(heading)));
			for (const line of data.text.split("\n")) box.addChild(new Text(line));
			return box;
		});
		answerEntryReady = true;
	} catch {
		// pi-tui unavailable -> the capped widget fallback stays in effect.
	}
}
