/**
 * pi-literature-review Pi extension: the ONE fused stage tool
 * pi-literature-synthesis + the /lit-synthesis command (v25 E2e).
 *
 * The former pi-literature-chat and pi-literature-synthesize tools merged
 * into one. Grounded Q&A rounds, the composable report (summaries, detail
 * questions in mode A/B, review synthesis) and the classic session report
 * all run the same fused engine in src/synthesize.ts with the same
 * citation gate.
 *
 * Dialog policy (v29, user decision 2026-07-28): the wizard belongs to the
 * /lit-synthesis COMMAND; the agent-called TOOL runs dialog-free. A chat call
 * with a settled scope answers immediately (the card shows the verbatim
 * executed question and, via terminate, has the last word); an unsettled
 * scope hands a REAL file list back to the agent (single-PDF libraries
 * resolve themselves); report-flavoured calls hand back to /lit-synthesis --
 * dialog-free AND expensive don't mix. The one dialog that can still open
 * from an agent turn is the HTML-write gate, which ASKS whether to build
 * the deterministic report instead of the agent's hand-written file.
 */

import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { llmConfig } from "../src/config.ts";
import {
	type CheckboxItem,
	detectDialogLang,
	type DialogLang,
	parseQuestionLines,
	type WizardAnswers,
	type WizardResult,
	type WizardStepDef,
} from "../src/dialog-state.ts";
import { type LibraryPaper, matchLibrary } from "../src/corpus.ts";
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
} from "../src/synthesis.ts";
import { chatLangDefault, installChatLangObserver, runWizard } from "./dialogs.ts";

const SYNTHESIS_WIDGET = "pi-literature-review-synthesis";
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
		clip(executedQuestionLine(answer.question)),
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

/** The verbatim question the engine actually ran, shown on every answer
 * card (v29: dialog-free chat calls make agent rephrasing VISIBLE instead
 * of preventing it -- /lit-synthesis <question> is the verbatim fallback). */
function executedQuestionLine(question: string): string {
	return detectDialogLang([question], chatLangDefault()) === "en"
		? `Question, as executed: ${question}`
		: `Frage, so ausgeführt: ${question}`;
}

/** Report body for the transcript card: unit headings + validated prose,
 * then the GLOBAL reference lines and the HTML path when one was written.
 * The card is the durable answer in the chat (v27 field fix: the report
 * lived only in a truncated, transient widget). */
function formatReportText(report: SynthReport, htmlPath: string | null): string {
	const german = report.ui_language !== "en";
	const parts = report.units.map((unit) => {
		const heading = unit.kind === "summary" ? `${german ? "Zusammenfassung" : "Summary"} ${unit.paper_base}.pdf`
			: unit.kind === "review" ? (german ? "Review-Synthese" : "Review synthesis")
			: unit.paper_base ? `${unit.question} -- ${unit.paper_base}.pdf`
			: unit.question ?? "";
		return `${heading}\n\n${unit.prose}`;
	});
	return [
		parts.join("\n\n----\n\n"),
		report.references.map(referenceLine).join("\n"),
		// file:// URL (v31.5, same as the search card): terminals linkify
		// it, so right-click -> open lands in the browser.
		htmlPath ? `HTML-Report: ${pathToFileURL(htmlPath).href}` : "",
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
			text: `${executedQuestionLine(answer.question)}\n\n${formatAnswerText(answer)}`,
		});
		if (ctx.hasUI) ctx.ui.setWidget(SYNTHESIS_WIDGET, undefined);
	} else if (ctx.hasUI) {
		ctx.ui.setWidget(SYNTHESIS_WIDGET, answerWidgetLines(answer, label));
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
		ctx.ui.setWidget(SYNTHESIS_WIDGET, lines.length > WIDGET_MAX_LINES
			? [...lines.slice(0, WIDGET_MAX_LINES - 1), "... (full report in the HTML / JSON sidecar)"]
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

/** Adapter-owned dialog strings per language (v27 user decision: the
 * dialogs follow the CHAT's language -- resolved from the explicit
 * language param, else detected from the question texts; German is the
 * default and the bare-command language). */
const SYNTH_TEXT: Record<DialogLang, {
	/** Line above the tab bar: which dialog this is (v30.12). */
	header: string;
	scopeTitle: string;
	scopeTab: string;
	selectAll: string;
	next: string;
	questionsTab: string;
	questionsTitle: string;
	questionsPlaceholder: string;
	summaryTab: string;
	summaryTitle: string;
	optionNo: string;
	optionYes: string;
	summaryBullets: string;
	summaryProse: string;
	detailTab: string;
	detailTitle: string;
	detailPerPaper: string;
	detailCross: string;
	detailDisabled: string;
	reviewTab: string;
	reviewTitle: string;
	reviewDisabled: string;
	htmlTab: string;
	htmlTitle: string;
	htmlYes: string;
	htmlNo: string;
	htmlDisabled: string;
	nothingNote: string;
	unitNote: (n: number) => string;
	unitWarn: (n: number) => string;
	unitWarnYes: string;
	unitWarnCancel: string;
}> = {
	de: {
		header: "/lit-synthesis -- Literatur verstehen und zusammenfassen (Esc bricht ab)",
		scopeTitle: "Über welche Dokumente möchtest du sprechen?",
		scopeTab: "Dokumente",
		selectAll: "Alle auswählen (ganze Bibliothek)",
		next: "Weiter",
		questionsTab: "Fragen",
		questionsTitle: "Welche Frage(n) interessieren dich? (eine je Zeile -- Enter beginnt die nächste; leer lassen zum Chatten oder für nur Zusammenfassung)",
		questionsPlaceholder: "leer = chatten oder nur Zusammenfassung",
		summaryTab: "Zusammenfassung",
		summaryTitle: "Strukturierte Zusammenfassung je Dokument?",
		optionNo: "Nein",
		optionYes: "Ja",
		summaryBullets: "Ja, als Bulletpoints",
		summaryProse: "Ja, als Fließtext",
		detailTab: "Fragen-Modus",
		detailTitle: "Detailfragen: pro Dokument einzeln oder übergreifend?",
		detailPerPaper: "Pro Dokument einzeln (Modus A -- deckt jedes Dokument ab, mehr Modellaufrufe)",
		detailCross: "Übergreifend zusammengeführt (Modus B -- ein Aufruf je Frage)",
		detailDisabled: "Braucht mehrere Dokumente und mindestens eine Frage.",
		reviewTab: "Review",
		reviewTitle: "Review-Synthese (Stand der Literatur) anhängen? (Empfohlen bei ganzer Bibliothek; bei kleiner Auswahl oft schwach.)",
		reviewDisabled: "Braucht mindestens zwei Dokumente (über EINEM Artikel wäre das nur eine schwächere Zusammenfassung).",
		htmlTab: "HTML",
		htmlTitle: "Als HTML speichern?",
		htmlYes: "Ja, HTML-Bericht schreiben",
		htmlNo: "Nein, nur Antwort im Chat",
		htmlDisabled: "Nichts zu speichern -- erst eine Frage, Zusammenfassung oder Review wählen.",
		nothingNote: "Nichts zu generieren -- das wird ein Chat.",
		unitNote: (n) => `~${n} Modellaufruf(e), je etwa eine Minute lokal`,
		unitWarn: (n) => `Dieser Report braucht ${n} Modellaufrufe (je etwa eine Minute lokal). Fortfahren?`,
		unitWarnYes: "Ja, ausführen",
		unitWarnCancel: "Abbrechen",
	},
	en: {
		header: "/lit-synthesis -- understand and summarize literature (Esc cancels)",
		scopeTitle: "Which documents do you want to talk about?",
		scopeTab: "Documents",
		selectAll: "Select all (whole library)",
		next: "Next",
		questionsTab: "Questions",
		questionsTitle: "Which question(s) interest you? (one per line -- Enter starts the next; leave empty to chat or for a summary only)",
		questionsPlaceholder: "empty = chat or summary only",
		summaryTab: "Summary",
		summaryTitle: "Structured summary per document?",
		optionNo: "No",
		optionYes: "Yes",
		summaryBullets: "Yes, as bullet points",
		summaryProse: "Yes, as prose",
		detailTab: "Question mode",
		detailTitle: "Detail questions: per document or merged across documents?",
		detailPerPaper: "Per document (mode A -- covers every document, more model calls)",
		detailCross: "Merged across documents (mode B -- one call per question)",
		detailDisabled: "Needs several documents and at least one question.",
		reviewTab: "Review",
		reviewTitle: "Append a review synthesis (state of the literature)? (Recommended on the whole library; often weak on a small selection.)",
		reviewDisabled: "Needs at least two documents (over ONE paper it would just be a weaker summary).",
		htmlTab: "HTML",
		htmlTitle: "Save as HTML?",
		htmlYes: "Yes, write the HTML report",
		htmlNo: "No, answer in the chat only",
		htmlDisabled: "Nothing to save -- pick a question, summary or review first.",
		nothingNote: "Nothing to generate -- this will be a chat.",
		unitNote: (n) => `~${n} model call(s), about a minute each locally`,
		unitWarn: (n) => `This report needs ${n} model calls (about a minute each locally). Continue?`,
		unitWarnYes: "Yes, run it",
		unitWarnCancel: "Cancel",
	},
};

/** The HTML-write gate's question dialog (v29: the gate ASKS instead of
 * hard-blocking -- the wizard choice IS the report consent). */
const GATE_TEXT: Record<DialogLang, {
	title: (path: string, label: string) => string;
	wizard: string;
	allow: string;
	cancel: string;
}> = {
	de: {
		title: (path, label) =>
			`Der Agent will ${path} von Hand schreiben, während ein Dokument-Chat (${label}) läuft. `
			+ "Soll stattdessen ein richtiger Report entstehen (geprüfte Zitate, seitengenaue PDF-Links)?",
		wizard: "Report-Wizard öffnen (empfohlen)",
		allow: "Diesen Schreibvorgang erlauben -- die Datei hat mit dem Dokument-Chat nichts zu tun",
		cancel: "Abbrechen -- weder Agent-Datei noch Report",
	},
	en: {
		title: (path, label) =>
			`The agent wants to hand-write ${path} while a document chat (${label}) is active. `
			+ "Generate the real report instead (verified citations, page-exact PDF links)?",
		wizard: "Open the report wizard (recommended)",
		allow: "Allow this write -- the file is unrelated to the document chat",
		cancel: "Cancel -- neither the agent file nor a report",
	},
};

/** The dim metadata line under a document row (v31.2 user wish): year -
 * first author et al. - title - identifier; only what the record carries,
 * nothing invented. */
function paperMetaLine(entry: LibraryPaper["entry"]): string {
	const author = entry.authors[0]
		? `${entry.authors[0]}${entry.authors.length > 1 ? " et al." : ""}`
		: "";
	const id = entry.doi || (entry.arxiv_id ? `arXiv:${entry.arxiv_id}` : "");
	return [entry.year ?? "n.d.", author, entry.title, id].filter(Boolean).join(" - ");
}

/** Checkbox items for the scope step: EVERY PDF in the folder(s). The
 * FILENAME is the selectable row; the verified metadata sits dim below it
 * (v31.2 -- before, filename and title fought for one clipped line). PDFs
 * without a record honestly say so in their dim line. */
function scopeItems(diagnostics: string[]): ScopeItems {
	const match = matchLibrary(outputRoot(), (message) => diagnostics.push(message));
	// NOT pre-clipped (v31.2 field wish "später abschneiden"): the overlay
	// clips at the LIVE terminal width anyway, so a fixed MAX_LINE cap here
	// only threw away text that would have fit on a wide terminal.
	const items: CheckboxItem[] = [
		...match.matched.map((paper) => ({
			id: paper.base,
			label: `${paper.base}.pdf`,
			description: paperMetaLine(paper.entry),
		})),
		...match.unmatched.map((file) => ({
			id: file.replace(/\.pdf$/i, ""),
			label: file,
			description: "(no metadata yet; adoption is attempted, else cited by filename)",
		})),
	];
	return { items, papersDir: match.papersDir, unmatchedCount: match.unmatched.length };
}

function scopeStep(items: CheckboxItem[], preselected: string[] | undefined, lang: DialogLang = "de"): WizardStepDef {
	const text = SYNTH_TEXT[lang];
	return {
		kind: "checkbox",
		id: "papers",
		tab: text.scopeTab,
		title: text.scopeTitle,
		items,
		selectAllLabel: text.selectAll,
		nextLabel: text.next,
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
 * v31.4: MULTILINE -- one question per line, Enter opens the next;
 * semicolons still separate too, so pasted old-format lists keep working). */
function questionsStep(initial: string | undefined, lang: DialogLang = "de"): WizardStepDef {
	const text = SYNTH_TEXT[lang];
	return {
		kind: "text",
		id: "questions",
		tab: text.questionsTab,
		title: text.questionsTitle,
		placeholder: text.questionsPlaceholder,
		...(initial ? { initial } : {}),
	};
}

/**
 * The report-menu steps of the ONE wizard: summary format, detail mode
 * (appears only with >= 2 documents AND >= 1 question), review synthesis,
 * HTML (appears only when anything would be generated). scopeSizeOf reads
 * the LIVE answers, so the same steps work with the scope step in the same
 * wizard (bare /lit-synthesis) and with a scope settled beforehand (tool path).
 */
function reportSteps(
	scopeSizeOf: (answers: WizardAnswers) => number,
	defaults: Partial<ReportChoices>,
	lang: DialogLang = "de",
): WizardStepDef[] {
	const text = SYNTH_TEXT[lang];
	return [
		{
			kind: "choice", id: "summary", tab: text.summaryTab,
			title: text.summaryTitle,
			options: [
				{ value: "none", label: text.optionNo },
				{ value: "bullets", label: text.summaryBullets },
				{ value: "prose", label: text.summaryProse },
			],
			initial: defaults.summary ?? "bullets",
		},
		{
			kind: "choice", id: "detail", tab: text.detailTab,
			title: text.detailTitle,
			options: [
				{ value: "per-paper", label: text.detailPerPaper },
				{ value: "cross-paper", label: text.detailCross },
			],
			initial: defaults.detailMode ?? "per-paper",
			enabledIf: (answers) => scopeSizeOf(answers) > 1 && questionsOf(answers).length > 0,
			disabledNote: text.detailDisabled,
		},
		{
			kind: "choice", id: "review", tab: text.reviewTab,
			title: text.reviewTitle,
			options: [
				{ value: "yes", label: text.optionYes },
				{ value: "no", label: text.optionNo },
			],
			initial: defaults.includeReview ? "yes" : "no",
			// A "state of the literature" over ONE paper is just a weaker
			// summary (v27 user decision) -- the tab needs several documents.
			enabledIf: (answers) => scopeSizeOf(answers) > 1,
			disabledNote: text.reviewDisabled,
		},
		{
			kind: "choice", id: "html", tab: text.htmlTab,
			title: text.htmlTitle,
			options: [
				{ value: "yes", label: text.htmlYes },
				{ value: "no", label: text.htmlNo },
			],
			initial: defaults.saveHtml === false ? "no" : "yes",
			enabledIf: (answers) =>
				questionsOf(answers).length > 0 || answers.summary !== "none" || answers.review === "yes",
			disabledNote: text.htmlDisabled,
		},
	];
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
function reportSubmitNote(
	scopeSizeOf: (answers: WizardAnswers) => number,
	lang: DialogLang = "de",
): (answers: WizardAnswers) => string | null {
	const text = SYNTH_TEXT[lang];
	return (answers) => {
		const scopeSize = scopeSizeOf(answers);
		// The review tab only exists with several documents; with one, it
		// silently counts as "no".
		const review = scopeSize > 1 ? answers.review : "no";
		if (!scopeSize || typeof answers.summary !== "string" || typeof review !== "string") return null;
		const questionCount = questionsOf(answers).length;
		if (!questionCount && answers.summary === "none" && review === "no") {
			return text.nothingNote;
		}
		const units = reportUnitCount(scopeSize, questionCount, {
			summary: answers.summary as ReportChoices["summary"],
			detailMode: (answers.detail as ReportChoices["detailMode"] | null) ?? "per-paper",
			includeReview: review === "yes",
		});
		return text.unitNote(units);
	};
}

/**
 * THE one wizard (v27 user decision "immer der volle Dialog"): every
 * interactive intake -- chat call, report call, bare /lit-synthesis -- opens
 * the SAME full dialog. The scope step joins in when no scope is settled
 * yet; agent parameters, the passed question and the session's chat
 * questions only PREFILL. The submitted answers decide what runs (the
 * callers map the outcome: nothing = chat handback, exactly one question
 * with nothing else = a classic protocolled chat round, more = the
 * composable report). Null on cancel, "empty" on an empty library.
 */
interface SynthIntake {
	scope: string[] | "library";
	questions: string[];
	choices: ReportChoices;
}

async function synthWizard(
	ctx: ExtensionContext,
	scope: string[] | "library" | null,
	seedQuestions: string[] | undefined,
	defaults: Partial<ReportChoices>,
	lang: DialogLang,
	diagnostics: string[],
	signal: AbortSignal | undefined,
	preselected?: string[] | "library",
): Promise<SynthIntake | "empty" | null> {
	const steps: WizardStepDef[] = [];
	let items: CheckboxItem[] = [];
	if (!scope) {
		({ items } = scopeItems(diagnostics));
		if (!items.length) return "empty";
		const preselectedIds = preselected === "library" ? items.map((item) => item.id) : preselected;
		steps.push(scopeStep(items, preselectedIds, lang));
	}
	const staticSize = scope === null
		? null
		: scope === "library" ? chatPool(matchLibrary(outputRoot(), () => {})).length : scope.length;
	const scopeSizeOf = (answers: WizardAnswers): number =>
		staticSize ?? (Array.isArray(answers.papers) ? answers.papers.length : 0);
	// Seeds join with newlines (v31.4: the questions tab is multiline --
	// one question per line, exactly how the seeds should appear).
	steps.push(questionsStep(seedQuestions?.join("\n"), lang));
	steps.push(...reportSteps(scopeSizeOf, defaults, lang));
	const answers = await runWizard(ctx, steps, signal, { submitNote: reportSubmitNote(scopeSizeOf, lang), lang, header: SYNTH_TEXT[lang].header });
	if (answers === null) return null;
	const confirmedScope: string[] | "library" = scope
		?? ((answers.papers as string[]).length === items.length ? "library" : answers.papers as string[]);
	const choices = choicesOf(answers, defaults);
	// The hidden review tab decides: one document never gets a review
	// synthesis, even when an agent-passed default carried true.
	if (scopeSizeOf(answers) <= 1) choices.includeReview = false;
	return { scope: confirmedScope, questions: questionsOf(answers), choices };
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
			generatorLine: `Generator: ${piName} (pi) + ${cfg.generateModel} for review genres; embeddings: ${cfg.embedModel}`,
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
			ctx.ui.setWidget(SYNTHESIS_WIDGET, widgetLines);
			stopTicker = startElapsedTicker((line) => ctx.ui.setWidget(SYNTHESIS_WIDGET, [...widgetLines, line]));
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
		if (ctx.hasUI && !keepWidget) ctx.ui.setWidget(SYNTHESIS_WIDGET, undefined);
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
			ctx.ui.setWidget(SYNTHESIS_WIDGET, baseLines);
			stopTicker = startElapsedTicker((line) => ctx.ui.setWidget(SYNTHESIS_WIDGET, [...baseLines, ...progressLines.slice(-3), line]));
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
				const written = writeRunOutputs(renderSynthReportHtml(result), result, undefined, "lit-synthesis");
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
		if (ctx.hasUI && !keepWidget) ctx.ui.setWidget(SYNTHESIS_WIDGET, undefined);
	}
}

/* ------------------------------------------------------------------ *
 * Registration                                                        *
 * ------------------------------------------------------------------ */

/** Tool name -- also the setActiveTools identity (v29). */
const TOOL_NAME = "pi-literature-synthesis";

export default async function literatureSynthesis(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Literature Synthesis",
		description:
			"Chat about the LOCAL PDF papers (the lit-selection/ library AND loose PDFs in the current folder): grounded answers with page-exact, " +
			"code-validated citations over ONE paper, a selection, or the whole library. Use this tool WHENEVER " +
			"the user asks something about local papers/PDFs -- including German requests like 'zu einem Paper " +
			"chatten', 'erklaere mir das Paper', 'Frage zum Paper'. NOT this tool: searching ONLINE for new " +
			"literature (pi-literature-search) or downloading PDFs (pi-literature-selection). " +
			"The tool runs WITHOUT dialogs and REMEMBERS the session's document scope. Pass the user's question " +
			"VERBATIM, in their language and wording -- retrieval is measurably sensitive to phrasing; only " +
			"substitute a pronoun's referent when the question alone would be ambiguous, never rephrase, expand " +
			"or translate it. When no scope is set yet, the tool returns the REAL file list: show it to the " +
			"user, let them choose, and pass the EXACT filenames -- never guess or invent document names " +
			"(unknown names are rejected with the real list). A single-PDF library resolves itself. Set " +
			"pick: true when the user wants to switch documents. " +
			"The validated answer appears as a durable card in the transcript. When you relay the digest between " +
			"'--- answer ---' delimiters, output it EXACTLY as written, including the [n] markers -- never " +
			"summarize, extend, translate or 'improve' it, and never re-type titles, authors or identifiers: " +
			"copy reference lines EXACTLY. If it FAILED to ground, relay the warning verbatim. " +
			"REPORTS, SUMMARIES AND FILES ('fasse zusammen', 'Bericht erstellen', 'mach mir eine html', 'save " +
			"this'): this tool does NOT build them -- tell the user to run the /lit-synthesis command; its wizard " +
			"confirms documents, questions and format, prefilled with this session's chat questions. NEVER " +
			"write an HTML or any other file about these papers yourself. " +
			"The answers are written by a separate LOCAL generator in excerpts-only calls (not by you); fixed code " +
			"validates every citation marker and builds references from HTTP-verified records. Loose PDFs are " +
			"adopted automatically when their DOI/arXiv ID can be extracted and verified; unverified PDFs are " +
			"cited honestly by filename and page. Never supply metadata for a PDF yourself.",
		promptSnippet:
			"Chat about local PDFs with page-exact, code-validated citations. EVERY question about the papers " +
			"goes through this tool (the scope is remembered); never answer from memory, relay validated answers " +
			"verbatim. Reports and HTML exports are built only by the user's /lit-synthesis command -- never write " +
			"such files yourself.",
		parameters: Type.Object({
			question: Type.Optional(Type.String({
				description: "The user's question for ONE grounded chat answer, VERBATIM in their wording and language (retrieval is sensitive to phrasing; only substitute a pronoun's referent when needed, never rephrase or translate). Omit on an opening move without a concrete question -- the user then picks the scope and you ask for their question.",
			})),
			papers: Type.Optional(Type.Array(Type.String(), {
				description: "Document scope: PDF filenames from the library, EXACTLY as listed (unknown names are rejected and the real list is returned). Omit to use the session's remembered scope.",
			})),
			library: Type.Optional(Type.Boolean({
				description: "true: the scope is the WHOLE library (every PDF in the folder).",
			})),
			pick: Type.Optional(Type.Boolean({
				description: "true: the user wants to switch documents -- the tool returns the file list so they can choose.",
			})),
			report: Type.Optional(Type.Boolean({
				description: "Do not use: reports are built by the user's /lit-synthesis command; this call would only return that instruction.",
			})),
			questions: Type.Optional(Type.Array(Type.String(), {
				description: "Do not use (report parameter): reports run via the /lit-synthesis command only.",
			})),
			summary: Type.Optional(Type.String({
				description: "Do not use (report parameter): reports run via the /lit-synthesis command only.",
			})),
			detail_mode: Type.Optional(Type.String({
				description: "Do not use (report parameter): reports run via the /lit-synthesis command only.",
			})),
			include_review: Type.Optional(Type.Boolean({
				description: "Do not use (report parameter): reports run via the /lit-synthesis command only.",
			})),
			save_html: Type.Optional(Type.Boolean({
				description: "Do not use (report parameter): reports run via the /lit-synthesis command only.",
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
			const reply = (text: string, terminate = false) => ({
				content: [{ type: "text" as const, text }],
				details: { diagnostics },
				...(terminate ? { terminate: true } : {}),
			});
			const question = params.question?.trim() ?? "";
			const wantsReport = params.report === true
				|| params.questions !== undefined
				|| params.summary !== undefined
				|| params.detail_mode !== undefined
				|| params.include_review !== undefined
				|| params.save_html !== undefined;
			const root = outputRoot();

			// v29: reports, summaries and exports run ONLY via the /lit-synthesis
			// command -- its wizard is the consent. A dialog-free tool call
			// must never start a many-model-call run (dialog-free AND
			// expensive don't mix), so a report-flavoured call is a handback.
			if (wantsReport) {
				return reply(
					"Reports, summaries and HTML exports are built with the /lit-synthesis command only -- its "
					+ "wizard lets the user confirm documents, questions and format (this session's chat "
					+ "questions are prefilled there). Tell the user to run /lit-synthesis. Do not retry with "
					+ "report parameters, and NEVER write an HTML or any other file about the papers yourself.",
				);
			}

			// The library list is the ground truth: only real filenames are
			// accepted as scope -- an agent cannot invent documents (v29).
			const pool = chatPool(matchLibrary(root, (message) => diagnostics.push(message)));
			if (!pool.length) {
				return reply("The library holds no PDFs at all -- run a literature search and fetch first (or start pi in the folder containing the PDFs).");
			}
			const available = pool.map((entry) => `${entry.base}.pdf`).join(", ");

			// Scope: params > sticky. Everything still open is handed BACK to
			// the chat as a real file list (v29: no dialog on the tool path;
			// /lit-synthesis is the dialog path).
			let scope: string[] | "library" | undefined = params.library === true
				? "library"
				: params.papers?.length ? params.papers.map((name) => name.trim().replace(/\.pdf$/i, "")) : undefined;
			if (Array.isArray(scope)) {
				const known = new Map(pool.map((entry) => [entry.base.toLowerCase(), entry.base]));
				const unknown = scope.filter((base) => !known.has(base.toLowerCase()));
				if (unknown.length) {
					return reply(
						`Unknown document name(s): ${unknown.map((base) => `${base}.pdf`).join(", ")}. Only these `
						+ `PDFs exist: ${available}. Show the user this list, let them choose, and pass the exact `
						+ "filenames -- or point them to the /lit-synthesis command for the document dialog.",
					);
				}
				scope = scope.map((base) => known.get(base.toLowerCase()) as string);
			}
			if (params.pick === true) {
				return reply(
					"The user wants to switch documents. Show them this list and let them choose, then call "
					+ "again with the exact filenames in papers -- or point them to /lit-synthesis for the dialog. "
					+ `Available PDFs: ${available}`,
				);
			}
			if (!scope) {
				const sticky = readCurrentScope(root, sessionId(ctx));
				if (sticky) {
					scope = sticky.papers;
					report(`using the session's scope: ${scope === "library" ? "whole library" : scope.join(", ")} (pick: true switches)`);
				}
			}
			if (!scope) {
				if (pool.length === 1) {
					// Nothing to decide: a one-PDF library resolves itself
					// (v29); the card names the document.
					scope = [pool[0].base];
					report(`single PDF in the library -- scope resolves to ${pool[0].base}.pdf`);
				} else {
					return reply(
						"No document scope is set for this session. Do NOT guess or invent filenames: show the "
						+ "user this list, ask which document(s) they mean, then call again with the exact names "
						+ "in papers (the /lit-synthesis command offers the same choice as a dialog). Available "
						+ `PDFs: ${available}`,
					);
				}
			}
			if (!question) {
				// Opening move: the scope is settled, only the question is missing.
				const label = scope === "library" ? "the whole library" : scope.map((base) => `${base}.pdf`).join(", ");
				return reply(
					`The scope is ${label} (already settled -- do not ask about documents again). Ask the user `
					+ "what they want to know, then call this tool again with their question passed VERBATIM.",
				);
			}
			if (signal?.aborted) return reply("The run was aborted before anything was generated.");
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
			// v29: with the answer card on screen the agent has nothing to
			// add -- terminate makes the card the last word (no retelling).
			// Headless has no card, so the digest must still be relayed.
			return reply(renderChatDigest(outcome.answer), ctx.hasUI);
		},
	});

	// /lit-synthesis -- ONE command for the whole stage. Bare: ONE wizard
	// (documents -> questions -> report menu -> submit, v27); a pure chat
	// wish hands the loop to the agent (v22 doctrine). With arguments: ONE
	// agent-free grounded round.
	pi.registerCommand("lit-synthesis", {
		description:
			"Chat about and report on local PDFs with verified citations. Bare /lit-synthesis runs the wizard "
			+ "(documents, questions, report menu); /lit-synthesis <question> answers once, agent-free.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const question = (args ?? "").trim();
			const diagnostics: string[] = [];
			const progress = (message: string) => ctx.ui.notify(message, "info");
			const root = outputRoot();
			const session = sessionId(ctx);
			const sticky = readCurrentScope(root, session);

			if (question && sticky) {
				// /lit-synthesis <question> with a remembered scope: the
				// deterministic agent-free quick path, NO dialog (documented).
				const outcome = await runRoundWithUi(pi, ctx, {
					question,
					papers: sticky.papers,
					onWarn: progress,
					signal: ctx.signal,
				});
				if ("error" in outcome) ctx.ui.notify(`chat failed: ${outcome.error}`, "error");
				return;
			}

			// Everything else: the ONE full wizard (v27) -- scope step
			// preselected with the sticky scope, a typed question seeds the
			// questions tab; the submitted answers decide what runs.
			const wizardLang = question ? detectDialogLang([question], chatLangDefault()) : chatLangDefault();
			const intake = await synthWizard(
				ctx,
				null,
				question ? [question] : undefined,
				question ? { summary: "none", saveHtml: false } : { summary: "bullets" },
				wizardLang,
				diagnostics,
				ctx.signal,
				sticky?.papers === "library" ? "library" : sticky?.papers,
			);
			if (intake === null) return; // cancelled
			if (intake === "empty") {
				ctx.ui.notify("No PDFs in the library -- run a search and fetch first, or start pi in the papers folder.", "warning");
				return;
			}
			const { scope, questions, choices } = intake;
			writeCurrentScope(root, { papers: scope }, session, undefined, (message) => diagnostics.push(message));

			if (!questions.length && choices.summary === "none" && !choices.includeReview) {
				// Chat wish: hand the loop to the agent (v22 pattern).
				const label = scope === "library" ? "the whole library" : scope.map((base) => `${base}.pdf`).join(", ");
				pi.sendMessage({
					customType: "pi-literature-synthesis-handoff",
					content:
						`The user picked ${label} for a grounded chat via /lit-synthesis. `
						+ "Ask them now, in ONE short sentence, what they would like to know -- mention that an "
						+ "overview, specific details, or bullet points are all fine, in German or English. Route "
						+ "EVERY question through the pi-literature-synthesis tool: pass only the question (the "
						+ "scope is remembered) and relay each validated answer verbatim. If they ask for a "
						+ "summary, an HTML, or to save/export anything, tell them to run /lit-synthesis -- never "
						+ "write such a file yourself.",
					display: false,
				}, { triggerTurn: true });
				return;
			}

			// Exactly one question with nothing else: the classic chat round.
			if (questions.length === 1 && choices.summary === "none" && !choices.includeReview && !choices.saveHtml) {
				const outcome = await runRoundWithUi(pi, ctx, {
					question: questions[0],
					papers: scope,
					onWarn: progress,
					signal: ctx.signal,
				});
				if ("error" in outcome) ctx.ui.notify(`chat failed: ${outcome.error}`, "error");
				return;
			}

			const scopeSize = scope === "library" ? chatPool(matchLibrary(root, () => {})).length : scope.length;
			const unitCount = reportUnitCount(scopeSize, questions.length, choices);
			const reportLang = detectDialogLang(questions, wizardLang);
			if (unitCount > UNIT_WARN_THRESHOLD) {
				const warnText = SYNTH_TEXT[reportLang];
				const go = await ctx.ui.select(
					warnText.unitWarn(unitCount),
					[warnText.unitWarnYes, warnText.unitWarnCancel],
					{ signal: ctx.signal },
				);
				if (go !== warnText.unitWarnYes) return;
			}

			const outcome = await runReportWithUi(pi, ctx, {
				papers: scope,
				questions,
				summary: choices.summary,
				detailMode: choices.detailMode,
				includeReview: choices.includeReview,
				// ONE language for the whole report, following the chat.
				language: reportLang === "en" ? "English" : "German",
				uiLanguage: reportLang,
			}, choices.saveHtml, progress, diagnostics, ctx.signal);
			if ("error" in outcome) {
				ctx.ui.notify(`report failed: ${outcome.error}`, "error");
			}
			// The report itself is a transcript card (showReport); no widget
			// digest on top of it.
		},
	});

	// v29: with an EMPTY library the tool stays deactivated, so the agent
	// cannot stumble into it in unrelated chats (setActiveTools). Checked
	// on session start; while inactive, every input re-checks (a fetch may
	// have filled the library meanwhile). Best-effort: any doubt keeps the
	// tool available -- it still answers honestly on an empty library.
	const libraryHasPdfs = (): boolean => {
		try {
			return chatPool(matchLibrary(outputRoot(), () => {})).length > 0;
		} catch {
			return true;
		}
	};
	const syncToolActivation = (): void => {
		try {
			const active = pi.getActiveTools();
			const isActive = active.includes(TOOL_NAME);
			const shouldBe = libraryHasPdfs();
			if (shouldBe && !isActive) pi.setActiveTools([...active, TOOL_NAME]);
			else if (!shouldBe && isActive) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		} catch {
			// Activation sync must never break a session.
		}
	};
	pi.on("session_start", () => syncToolActivation());

	// The passive chat-language observer (v27) is shared package-wide since
	// v29.1 -- it lives in dialogs.ts; every extension's dialogs read the
	// same observation.
	installChatLangObserver(pi);

	pi.on("input", () => {
		// Cheap while active (one lookup); a real rescan only runs while the
		// tool is deactivated and might need waking up.
		try {
			if (!pi.getActiveTools().includes(TOOL_NAME)) syncToolActivation();
		} catch {
			// same best-effort rule as above
		}
	});

	// HTML-write gate (v23 field failure, REPURPOSED in v29): while any
	// document scope is active in THIS session, an agent write/edit of an
	// .html file is the classic hand-built-report failure ("baue mir eine
	// html"). The gate no longer just blocks -- it ASKS: the default choice
	// opens the report wizard right here (the dialog choice IS the consent
	// the wizard otherwise gets via /lit-synthesis), "allow" lets unrelated
	// HTML writes through, cancel/Esc blocks. Headless keeps the hard block.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		// pi's write/edit accept file_path with path as a fallback alias.
		const input = event.input as { file_path?: unknown; path?: unknown } | undefined;
		const path = typeof input?.file_path === "string" ? input.file_path
			: typeof input?.path === "string" ? input.path : "";
		if (!/\.html?$/i.test(path)) return;
		const root = outputRoot();
		const session = sessionId(ctx);
		const sticky = readCurrentScope(root, session);
		if (!sticky) return;
		const label = sticky.papers === "library" ? "the whole library" : sticky.papers.map((base) => `${base}.pdf`).join(", ");
		const blockReason =
			`Blocked by pi-literature-review: a grounded document chat (${label}) is active. HTML exports come `
			+ "from the deterministic report (verified citations, page-exact PDF links), which the user starts "
			+ "with the /lit-synthesis command. Suggest /lit-synthesis to the user; never write such a file yourself.";
		if (!ctx.hasUI) return { block: true, reason: blockReason };
		const lang = chatLangDefault();
		const text = GATE_TEXT[lang];
		const choice = await ctx.ui.select(
			text.title(path, label),
			[text.wizard, text.allow, text.cancel],
			{ signal: ctx.signal },
		);
		if (choice === text.allow) return;
		if (choice !== text.wizard) return { block: true, reason: blockReason }; // cancel, Esc or abort
		// Wizard chosen: configure and run the real report right here. The
		// scope is the sticky one; this session's chat questions seed the
		// questions tab ("fasse das zusammen" needs no invented questions).
		const quiet = (message: string) => ctx.ui.notify(message, "info");
		const diagnostics: string[] = [];
		const intake = await synthWizard(
			ctx,
			sticky.papers,
			sessionSeedQuestions(root, sticky.papers, session),
			{ summary: "bullets", saveHtml: true },
			lang,
			diagnostics,
			ctx.signal,
		);
		if (intake === null || intake === "empty") return { block: true, reason: blockReason };
		const { scope, questions, choices } = intake;
		if (!questions.length && choices.summary === "none" && !choices.includeReview) {
			return {
				block: true,
				reason: "Blocked: the user chose nothing to generate. Ask what they want instead; never write "
					+ "an HTML about the papers yourself (/lit-synthesis builds reports).",
			};
		}
		// Exactly one question and nothing else: a grounded chat round.
		if (questions.length === 1 && choices.summary === "none" && !choices.includeReview && !choices.saveHtml) {
			const outcome = await runRoundWithUi(pi, ctx, {
				question: questions[0],
				papers: scope,
				onWarn: quiet,
				signal: ctx.signal,
			});
			return {
				block: true,
				reason: "error" in outcome
					? `Blocked; the user ran a grounded chat round instead and it failed: ${outcome.error} -- report this verbatim.`
					: "Blocked: the user ran a grounded chat round instead; its validated answer is on screen "
						+ "as a card. Do not write an HTML yourself.",
			};
		}
		const scopeSize = scope === "library" ? chatPool(matchLibrary(root, () => {})).length : scope.length;
		const unitCount = reportUnitCount(scopeSize, questions.length, choices);
		if (unitCount > UNIT_WARN_THRESHOLD) {
			const warnText = SYNTH_TEXT[lang];
			const go = await ctx.ui.select(
				warnText.unitWarn(unitCount),
				[warnText.unitWarnYes, warnText.unitWarnCancel],
				{ signal: ctx.signal },
			);
			if (go !== warnText.unitWarnYes) return { block: true, reason: blockReason };
		}
		const outcome = await runReportWithUi(pi, ctx, {
			papers: scope,
			questions,
			summary: choices.summary,
			detailMode: choices.detailMode,
			includeReview: choices.includeReview,
			language: lang === "en" ? "English" : "German",
			uiLanguage: lang,
		}, choices.saveHtml, quiet, diagnostics, ctx.signal);
		return {
			block: true,
			reason: "error" in outcome
				? `Blocked; the deterministic report was attempted instead and failed: ${outcome.error} -- report this verbatim.`
				: "Blocked: the deterministic report was generated instead; the result card (and the HTML path, "
					+ "if saved) is on screen. Do not write an HTML yourself.",
		};
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
