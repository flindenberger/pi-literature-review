/**
 * pi-literature-review Pi extension: the pi-literature-chat tool ("Paper
 * Chat").
 *
 * Grounded Q&A about ONE paper from the local, verified PDF library: the
 * engine (src/ask.ts) retrieves the most relevant excerpts of that single
 * paper, has a LOCAL generator model write a didactic answer that may cite
 * ONLY by excerpt number, and validates every marker with fixed code. The
 * agent model driving Pi transports the question and relays the validated
 * answer verbatim; every round is persisted to a protocol file, from which
 * report mode builds a grounded summary HTML.
 *
 * Dialog policy (deliberate deviation from the synthesize adapter): there
 * is NO consent dialog per question -- a confirm on every chat turn would
 * kill the conversation loop. The code gate sits at the SCOPE choice
 * instead: when no paper is named, a blocking terminal picker lists the
 * library, offers the whole-library synthesis as the first option (user
 * decision 2026-07-16: the one-paper vs. library fork is code, not
 * instruction), and Esc cancels the run.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type ChatAnswer,
	type ChatDeps,
	chatPool,
	readCurrentPaper,
	runChat,
	runChatReport,
	writeCurrentPaper,
} from "../src/chat.ts";
import { llmConfig } from "../src/config.ts";
import { type LibraryMatch, matchLibrary } from "../src/corpus.ts";
import { renderChatDigest, renderChatReportDigest } from "../src/digest.ts";
import { createBackend, type LlmBackend } from "../src/llm.ts";
import { outputRoot, writeRunOutputs } from "../src/output.ts";
import { renderPaperChatReportHtml } from "../src/render.ts";
import { DEFAULT_TOP_K, MAX_TOP_K } from "../src/synthesize.ts";

const CHAT_WIDGET = "pi-literature-review-chat";
const MODE_WIDGET = "pi-literature-review-chat-mode";

/**
 * Persistent paper-chat mode (user request 2026-07-20). A slash command is a
 * one-shot; the recurring pain was re-typing /lit-chat before every question.
 * While this holds a paper base, the `input` event handler routes EVERY plain
 * (non-command) line to that paper's chat engine and marks it handled -- the
 * agent is bypassed entirely, a true REPL over one PDF. Toggled on by the
 * /lit-chat command (after the paper is picked) and off by typing "exit".
 * Session-scoped module state: one active paper chat per pi process.
 */
let chatModeBase: string | null = null;

/** True once the pi-tui entry renderer is registered (see literatureChat).
 * When true, validated answers render as full, scrollable transcript entries;
 * otherwise they fall back to the capped CHAT_WIDGET. */
let answerEntryReady = false;

/** Same widget/select discipline as the sibling tools: no scrolling
 * exists, so cap the list and clip each line. */
const PICKER_MAX_PAPERS = 25;
const PICKER_MAX_LINE = 110;

function clip(line: string): string {
	return line.length > PICKER_MAX_LINE ? `${line.slice(0, PICKER_MAX_LINE - 3)}...` : line;
}

/** Answer widget: the code-validated answer stays visible in the terminal
 * even when the agent model paraphrases it (field finding 2026-07-16). */
const WIDGET_MAX_LINES = 15;

function wrapText(text: string, width = PICKER_MAX_LINE): string[] {
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

/** Widget lines for a validated answer (shared by the tool and the
 * /lit-chat command). Capped -- the full text is always in the digest
 * and the session protocol. */
function answerWidgetLines(answer: ChatAnswer, paperLabel: string): string[] {
	const referenceLines = answer.references.map((reference) => {
		const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}` : reference.key);
		return clip(`[${reference.n}] ${reference.year ?? "n.d."} | ${id} | ${reference.title} (S. ${reference.pages.join(", ")})`);
	});
	const lines = [
		answer.grounded
			? `Validated answer (code-checked) -- ${paperLabel}`
			: `UNGROUNDED DRAFT (not usable as an answer) -- ${paperLabel}`,
		...wrapText(answer.prose),
		...referenceLines,
	];
	return lines.length > WIDGET_MAX_LINES
		? [...lines.slice(0, WIDGET_MAX_LINES - 1), "... (the full validated answer is in the session protocol)"]
		: lines;
}

/** The full validated answer as plain text (verbatim, with [n] markers and
 * reference lines) for the scrollable transcript entry. */
function formatAnswerText(answer: ChatAnswer, paperLabel: string): string {
	const refs = answer.references.map((reference) => {
		const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}` : reference.key);
		return `[${reference.n}] ${reference.year ?? "n.d."} | ${id} | ${reference.title} (S. ${reference.pages.join(", ")})`;
	});
	return `${answer.prose}${refs.length ? `\n\n${refs.join("\n")}` : ""}`;
}

/** Show the validated answer: a full, scrollable transcript entry when the
 * pi-tui renderer is available (appendEntry), else the capped CHAT_WIDGET as a
 * fallback. The entry is the anti-paraphrase ground truth and does NOT enter
 * the LLM context. */
function showAnswer(pi: ExtensionAPI, ctx: ExtensionContext, paperLabel: string, answer: ChatAnswer): void {
	if (answerEntryReady) {
		pi.appendEntry("pi-literature-chat-answer", {
			paper: paperLabel,
			grounded: answer.grounded,
			text: formatAnswerText(answer, paperLabel),
		});
		if (ctx.hasUI) ctx.ui.setWidget(CHAT_WIDGET, undefined);
	} else if (ctx.hasUI) {
		ctx.ui.setWidget(CHAT_WIDGET, answerWidgetLines(answer, paperLabel));
	}
}

/**
 * Generator = the model currently selected in pi (user decision
 * 2026-07-16), called in a SEPARATE, excerpts-only completion -- the
 * citation gate stays exactly the same; only the model behind generate()
 * changes. Embeddings stay on the configured local embedding server (an
 * agent model cannot embed).
 */
function piModelBackend(ctx: ExtensionContext, embed: LlmBackend["embed"]): LlmBackend {
	const model = ctx.model!;
	return {
		label: `model selected in pi (${model.api} at ${model.baseUrl})`,
		embed,
		generate: async (system, user, options, signal) => {
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
				maxTokens: options?.maxTokens,
				signal,
			});
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				throw new Error(response.errorMessage || `generation ${response.stopReason}`);
			}
			return response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
		},
	};
}

/**
 * Run ONE grounded chat turn against `base` and show the validated answer in
 * the CHAT_WIDGET (answerWidgetLines) -- the same reliable rendering the tool
 * path uses. Shared by the /lit-chat command and the persistent-mode input
 * handler; both are agent-free, so the answer goes straight to the user.
 * (An earlier version used sendMessage(display:true, deliverAs:"nextTurn"),
 * but nextTurn QUEUES the message for the next prompt instead of showing it,
 * so the answer never appeared. The widget renders immediately.) Errors
 * surface as a notification; nothing about a paper is ever invented.
 */
async function answerInChat(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	base: string,
	question: string,
): Promise<void> {
	const progress = (message: string) => ctx.ui.notify(message, "info");
	const cfg = llmConfig();
	const engineDeps: ChatDeps | undefined = ctx.model
		? { backend: piModelBackend(ctx, (texts, signal) => createBackend(cfg).embed(texts, signal)) }
		: undefined;
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	ctx.ui.setWidget(CHAT_WIDGET, [
		`Paper chat: ${base}.pdf`,
		clip(`Question: ${question}`),
		`Generating with ${model ?? "the configured chat model"} -- no agent model involved.`,
	]);
	try {
		const answer = await runChat({
			question,
			paper: `${base}.pdf`,
			model,
			onWarn: progress,
			signal: ctx.signal,
		}, engineDeps);
		showAnswer(pi, ctx, `${base}.pdf`, answer);
	} catch (error) {
		ctx.ui.setWidget(CHAT_WIDGET, undefined);
		ctx.ui.notify(`paper chat failed: ${error instanceof Error ? error.message : error}`, "error");
	}
}

/** Persistent mode indicator + exit hint; stays visible until the user types "exit". */
function showChatMode(ctx: ExtensionContext, base: string): void {
	ctx.ui.setWidget(MODE_WIDGET, [
		`Paper-chat mode: ${base}.pdf -- just type your questions (no /lit-chat needed).`,
		"/lit-chat switches paper  |  type 'exit' to leave",
	]);
}

const OPTION_LIBRARY = "Whole library: synthesis across ALL papers (pi-literature-synthesize)";
const OPTION_UNLISTED = "Another paper (not listed) -- I will name the PDF file in chat";

type PickerOutcome =
	| { kind: "paper"; base: string }
	| { kind: "library" }
	| { kind: "unlisted" }
	| { kind: "cancelled" }
	| { kind: "empty" };

/**
 * Blocking paper picker: the code-enforced fork between "chat about ONE
 * paper" and "synthesize the whole library". Runs on the first contact
 * (or on pick: true). EVERY PDF in the folder is listed -- papers without
 * metadata under their original filename (user decision 2026-07-16); the
 * engine attempts adoption on selection, and whatever stays unverified is
 * cited honestly by filename and page.
 */
async function pickPaper(
	ctx: ExtensionContext,
	questionDisplay: string,
	report: (message: string) => void,
	signal: AbortSignal | undefined,
): Promise<PickerOutcome> {
	const root = outputRoot();
	try {
		const match: LibraryMatch = matchLibrary(root, report);
		if (!match.matched.length && !match.unmatched.length) return { kind: "empty" };

		const byLabel = new Map<string, PickerOutcome>();
		const options: string[] = [];
		const add = (label: string, outcome: PickerOutcome) => {
			options.push(label);
			byLabel.set(label, outcome);
		};
		add(OPTION_LIBRARY, { kind: "library" });
		const entries: Array<{ label: string; base: string }> = [
			...match.matched.map((paper) => ({
				label: clip(`${paper.base}.pdf -- ${paper.entry.year ?? "n.d."}  ${paper.entry.title || "(title unknown)"}`),
				base: paper.base,
			})),
			...match.unmatched.map((file) => ({
				label: clip(`${file} -- (no metadata yet; adoption is attempted, else cited by filename)`),
				base: file.replace(/\.pdf$/i, ""),
			})),
		];
		for (const entry of entries.slice(0, PICKER_MAX_PAPERS)) {
			add(entry.label, { kind: "paper", base: entry.base });
		}
		if (entries.length > PICKER_MAX_PAPERS) add(OPTION_UNLISTED, { kind: "unlisted" });

		ctx.ui.setWidget(CHAT_WIDGET, [
			"Paper chat: pick the paper this conversation is about",
			`Question: ${clip(questionDisplay)}`,
			`Library:  ${entries.length} PDF(s) in ${match.papersDir}`
				+ (match.unmatched.length ? ` (${match.unmatched.length} without metadata yet)` : ""),
		]);
		const choice = await ctx.ui.select("pi-literature-chat: which paper is this about?", options, { signal });
		if (choice === undefined) return { kind: "cancelled" };
		return byLabel.get(choice) ?? { kind: "cancelled" };
	} finally {
		ctx.ui.setWidget(CHAT_WIDGET, undefined);
	}
}

export default async function literatureChat(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi-literature-chat",
		label: "Paper Chat",
		description:
			"Answer a question about ONE specific paper from the local PDF library (papers/ or the current folder) -- " +
			"a grounded paper chat for understanding a single paper, with page-exact citations. Use this tool WHENEVER " +
			"the user asks a question about a paper, wants a paper explained, or wants to chat, talk or discuss a " +
			"paper from a folder/directory on disk -- including German requests like 'zu einem Paper chatten', 'mit " +
			"dir ueber ein Paper reden', 'Paper aus diesem Ordner/Verzeichnis besprechen', 'erklaere mir das Paper', " +
			"'Frage zum Paper', 'was steht in dem Paper zu ...'. NOT this tool: searching ONLINE for new literature " +
			"(pi-literature-search) or summarizing SEVERAL papers (pi-literature-synthesize). " +
			"Call this tool DIRECTLY and IMMEDIATELY, even when the request contains no concrete question yet " +
			"('ich moechte ueber ein Paper chatten'): call without question -- the picker lets the user choose the " +
			"paper and the tool result then tells you to ask for their first question. Do NOT ask in chat which " +
			"paper is meant: when the paper parameter is missing, the tool itself shows a terminal picker where the " +
			"user chooses the paper -- or switches to the whole-library synthesis, in which case the tool result " +
			"tells you to call pi-literature-synthesize with the same question; do that. The tool REMEMBERS the " +
			"session's current paper: a call without paper automatically uses the last selection, so for follow-up " +
			"questions simply pass the user's question (rewritten to be self-contained -- the generator has no chat " +
			"memory); set pick: true when the user wants to switch to another paper. The picker lists EVERY PDF in " +
			"the folder, including those without metadata (cited honestly by filename and page then). " +
			"The answer is written in a SEPARATE, excerpts-only call (not by you in this conversation): the model " +
			"currently selected in pi receives ONLY numbered excerpts from that one paper and the question; fixed " +
			"code validates its citation markers and builds the reference from HTTP-verified records. The digest " +
			"carries the validated answer between '--- answer ---' delimiters: " +
			"output that text to the user EXACTLY as written, unchanged, including the [n] markers -- never " +
			"summarize, extend, translate or 'improve' it, and never re-type titles, authors or identifiers: copy " +
			"reference lines EXACTLY. If the digest says the answer FAILED to ground, relay the warning and the " +
			"draft verbatim and ask the user how to proceed. " +
			"Set report: true when the user wants a summary, report or wrap-up of the paper or of the chat session " +
			"(question then becomes an optional focus) -- AND whenever the user asks to save, print or export " +
			"answers to a file or HTML ('print that into an html', 'als HTML speichern'): NEVER write such a file " +
			"yourself with other tools; report mode produces the deterministic HTML with verified citations, " +
			"page-exact PDF links and the full Q&A protocol. The report is built from the code-validated session " +
			"protocol on disk -- never from this conversation -- and written as an HTML file; tell the user its path and do " +
			"not quote its prose. If the user cancelled the picker, ask which paper they want; do not retry " +
			"unchanged. Loose PDFs are adopted automatically when their own DOI or arXiv ID can be extracted from " +
			"the PDF text and verified by an API lookup; PDFs without a findable identifier and scanned PDFs are " +
			"excluded and listed honestly -- never work around an exclusion, and never supply metadata for a PDF " +
			"yourself.",
		promptSnippet:
			"Chat about ONE local PDF paper with page-exact, code-validated citations. EVERY follow-up question " +
			"about that paper goes through this tool again (pass paper from the digest); never answer from memory. " +
			"Report mode writes a grounded session summary.",
		parameters: Type.Object({
			question: Type.Optional(Type.String({
				description: "The user's question about the paper, self-contained (resolve pronouns and references to earlier answers yourself). Omit on an opening request without a concrete question ('I want to chat about a paper') -- the user then picks the paper and you ask for their question. With report it is an optional extra focus.",
			})),
			paper: Type.Optional(Type.String({
				description: "PDF filename from the library (as shown in the digest, e.g. \"arxiv_2401.16393.pdf\"). When omitted, the session's current paper is used (the tool remembers the last selection); on the very first contact the user picks in a terminal dialog.",
			})),
			pick: Type.Optional(Type.Boolean({
				description: "true: show the paper picker even though a current paper is remembered -- use when the user wants to switch to another paper.",
			})),
			report: Type.Optional(Type.Boolean({
				description: "true: write the grounded summary report of the chat session (HTML from the validated protocol) instead of answering a question.",
			})),
			model: Type.Optional(Type.String({
				description: "Generator model override (a model name on the configured local backend). Default: the model currently selected in pi. Only pass this when the user explicitly asks for a different model.",
			})),
			top_k: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: MAX_TOP_K,
				description: `Excerpts to retrieve as context, default ${DEFAULT_TOP_K}, capped at ${MAX_TOP_K} (context window budget).`,
			})),
			language: Type.Optional(Type.String({
				description: "Output language of the answer, e.g. \"German\". Default: the language of the question.",
			})),
			reindex: Type.Optional(Type.Boolean({
				description: "Force re-extraction and re-embedding of the paper (default: cached per content hash and embedding model).",
			})),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const diagnostics: string[] = [];
			const report = (message: string) => {
				diagnostics.push(message);
				onUpdate?.({ content: [{ type: "text", text: message }] });
			};
			const wantsReport = params.report === true;
			const question = params.question?.trim() ?? "";

			// The ONE paper: parameter > sticky current paper > picker. The
			// sticky selection (written by the engine after every successful
			// round) means a weak agent only has to transport the question --
			// pick: true forces the picker for switching papers. A missing
			// question is NOT an error here -- the opening move "I want to
			// chat about a paper" carries none; the picker still settles WHICH
			// paper, and the agent is then told to ask for the first question.
			const root = outputRoot();
			let paper = params.paper?.trim() || undefined;
			if (!paper && params.pick !== true) {
				const sticky = readCurrentPaper(root);
				if (sticky) {
					paper = `${sticky}.pdf`;
					report(`using the session's current paper: ${paper} (pick: true switches papers)`);
				}
			}
			if (!paper) {
				if (!ctx.hasUI) {
					const pool = chatPool(matchLibrary(root, (message) => diagnostics.push(message)));
					const available = pool.map((entry) => `${entry.base}.pdf`).join(", ") || "(none)";
					return {
						content: [{
							type: "text",
							text: `No paper was named and no interactive picker is available. Pass paper explicitly; papers in the library: ${available}`,
						}],
						details: { diagnostics },
					};
				}
				const questionDisplay = question
					|| (wantsReport ? "(report of the session)" : "(no question yet -- it follows after the paper is picked)");
				const picked = await pickPaper(ctx, questionDisplay, report, signal);
				if (picked.kind === "cancelled") {
					return {
						content: [{
							type: "text",
							text: "The user cancelled the paper selection. Nothing was generated. Ask which paper they want to discuss.",
						}],
						details: { diagnostics },
					};
				}
				if (picked.kind === "library") {
					return {
						content: [{
							type: "text",
							text:
								"The user chose the WHOLE LIBRARY instead of a single paper. Call pi-literature-synthesize now" +
								(question
									? ` with the same question ("${question}").`
									: " (propose a sensible research question; the user adjusts it in that tool's dialog)."),
						}],
						details: { diagnostics },
					};
				}
				if (picked.kind === "unlisted") {
					return {
						content: [{
							type: "text",
							text: "The paper the user wants is not in the shown list. Ask the user for the PDF filename and call again with paper set.",
						}],
						details: { diagnostics },
					};
				}
				if (picked.kind === "empty") {
					return {
						content: [{
							type: "text",
							text: "The library holds no PDFs at all -- run a literature search and fetch first (or start pi in the folder containing the PDFs).",
						}],
						details: { diagnostics },
					};
				}
				paper = `${picked.base}.pdf`;
				diagnostics.push(`paper picked in the dialog: ${paper}`);
				// Remember immediately: the opening move may end before any
				// engine run (question follows in the next call).
				writeCurrentPaper(root, picked.base, undefined, (message) => diagnostics.push(message));
			}
			if (!question && !wantsReport) {
				// Opening move complete: the paper is settled, the question is not.
				return {
					content: [{
						type: "text",
						text:
							`The user wants to chat about ${paper} (already selected -- do not ask again). ` +
							"Ask the user what they want to know about this paper, then call this tool again with " +
							`paper: "${paper}" and their question.`,
					}],
					details: { diagnostics },
				};
			}
			if (signal?.aborted) {
				diagnostics.push("run aborted before anything was generated");
				return {
					content: [{ type: "text", text: "The paper chat run was aborted before anything was generated." }],
					details: { diagnostics },
				};
			}

			const cfg = llmConfig();
			// Generator resolution (user decision 2026-07-16): explicit param >
			// the model currently selected in pi > the engine's config slot
			// (chatModel/generateModel; used headless or when pi has no model).
			const paramModel = params.model?.trim();
			let engineDeps: ChatDeps | undefined;
			let model = paramModel;
			let generatorLine = `Generator: ${model || "(config default)"} (${cfg.api} at ${cfg.baseUrl})`;
			if (!paramModel && ctx.model) {
				const embedBackend = createBackend(cfg);
				engineDeps = { backend: piModelBackend(ctx, (texts, signal) => embedBackend.embed(texts, signal)) };
				model = `${ctx.model.provider}/${ctx.model.id}`;
				generatorLine = `Generator: ${model} (the model selected in pi; embeddings: ${cfg.embedModel})`;
			}
			let keepWidget = false;
			try {
				if (ctx.hasUI) {
					ctx.ui.setWidget(CHAT_WIDGET, [
						wantsReport ? `Paper chat report: ${paper}` : `Paper chat: ${paper}`,
						...(question ? [clip(`Question: ${question}`)] : []),
						`${generatorLine} -- progress appears below.`,
					]);
				}
				// The engine wires its own real deps (filesystem, protocol file,
				// the configured LLM backend); the extension only transports
				// options and relays the digest.
				if (wantsReport) {
					const result = await runChatReport({
						question: question || undefined,
						paper,
						model,
						language: params.language,
						reindex: params.reindex,
						onWarn: report,
						signal,
					}, engineDeps);
					let htmlPath: string | null = null;
					try {
						const written = writeRunOutputs(renderPaperChatReportHtml(result), result, undefined, "chats");
						htmlPath = written.htmlPath;
						diagnostics.push(`wrote HTML report to ${written.htmlPath} and JSON copy to ${written.jsonPath}`);
					} catch (error) {
						diagnostics.push(`writing the output files failed: ${error instanceof Error ? error.message : error}`);
					}
					return {
						content: [{ type: "text", text: renderChatReportDigest(result, htmlPath) }],
						details: { diagnostics },
					};
				}
				const answer = await runChat({
					question,
					paper,
					model,
					topK: params.top_k,
					language: params.language,
					reindex: params.reindex,
					onWarn: report,
					signal,
				}, engineDeps);
				if (ctx.hasUI) {
					// The validated answer stays visible in the terminal, whatever
					// the agent model makes of the digest (field finding
					// 2026-07-16: a small agent paraphrased, dropped the markers
					// and invented a journal name).
					showAnswer(pi, ctx, paper, answer);
					keepWidget = true;
				}
				return {
					content: [{ type: "text", text: renderChatDigest(answer) }],
					details: { diagnostics },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.push(`paper chat failed: ${message}`);
				return {
					content: [{
						type: "text",
						text:
							`The paper chat run failed: ${message} -- nothing was generated. Report this to the user ` +
							"verbatim. If it names an unreachable LLM server, Ollama is probably not running; the " +
							"user can verify the backend with: node src/cli.ts llm-check",
					}],
					details: { diagnostics },
				};
			} finally {
				if (ctx.hasUI && !keepWidget) ctx.ui.setWidget(CHAT_WIDGET, undefined);
			}
		},
	});

	// /lit-chat -- the agent-free path (user decision 2026-07-16, after a
	// field test in which the agent model neither relayed answers verbatim
	// nor called the tool on follow-ups). The command runs the SAME engine
	// and citation gate; no agent model touches the flow. The validated
	// answer lands in the persistent widget, and a silent context note
	// informs the agent for later turns without triggering one.
	pi.registerCommand("lit-chat", {
		description:
			"Grounded chat about ONE local PDF, agent-free. /lit-chat <question> answers once; "
			+ "bare /lit-chat picks or switches the paper. Either way it enters a persistent chat mode: "
			+ "afterwards just type your questions directly (no /lit-chat needed); type 'exit' to leave.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const question = (args ?? "").trim();
			const root = outputRoot();
			const progress = (message: string) => ctx.ui.notify(message, "info");
			let base = readCurrentPaper(root);
			if (!question || !base) {
				// Bare invocation always offers the picker (that is how the
				// user switches papers without any agent involved).
				const picked = await pickPaper(
					ctx,
					question || "(picking the paper -- then just type your questions)",
					progress,
					ctx.signal,
				);
				if (picked.kind === "library") {
					ctx.ui.notify(
						"For a whole-library synthesis run /lit-synthesize <question> (agent-free),"
						+ " or just ask for a synthesis in chat.",
						"info",
					);
					return;
				}
				if (picked.kind === "empty") {
					ctx.ui.notify("No PDFs in the library -- run a search and fetch first, or start pi in the papers folder.", "warning");
					return;
				}
				if (picked.kind !== "paper") return; // cancelled / not listed
				base = picked.base;
				writeCurrentPaper(root, base);
			}
			// Enter (or refresh) persistent chat mode: from here every plain line
			// is a grounded question about THIS paper until the user types "exit".
			chatModeBase = base;
			showChatMode(ctx, base);
			if (!question) {
				ctx.ui.notify(
					`Paper-chat mode on: ${base}.pdf -- just type your questions (type 'exit' to leave).`,
					"info",
				);
				return;
			}
			await answerInChat(pi, ctx, base, question);
		},
	});

	// Persistent chat mode: while a paper is active, every plain (non-command)
	// line becomes a grounded question about it -- the agent is bypassed
	// (input event -> action: handled). Commands (/...) and blank lines pass
	// through. A bare "exit"/"quit" leaves the mode: Ctrl+C cannot, because pi
	// owns it (copy / clear editor / cancel picker) and emits no event to hook,
	// so a keybinding would only clobber those globally; a typed word stays out
	// of the command palette and never collides.
	pi.on("input", async (event, ctx) => {
		if (!chatModeBase) return; // not in chat mode -> normal agent flow
		if (event.source !== "interactive") return; // ignore rpc / injected input
		const text = event.text.trim();
		if (!text || text.startsWith("/")) return; // commands & blanks pass through
		if (/^(exit|quit)$/i.test(text)) {
			chatModeBase = null;
			ctx.ui.setWidget(MODE_WIDGET, undefined);
			ctx.ui.setWidget(CHAT_WIDGET, undefined);
			ctx.ui.notify("Left paper-chat mode -- back to the agent.", "info");
			return { action: "handled" };
		}
		await answerInChat(pi, ctx, chatModeBase, text);
		return { action: "handled" };
	});

	// Rich transcript rendering for validated answers: register a pi-tui entry
	// renderer so answers appear as full, scrollable cards (appendEntry) instead
	// of the capped widget. pi-tui exists only at pi runtime, so import it lazily
	// and fall back to the widget if unavailable (e.g. offline tooling). Entries
	// do NOT enter the LLM context.
	try {
		const { Box, Text } = await import("@earendil-works/pi-tui");
		pi.registerEntryRenderer("pi-literature-chat-answer", (entry, _state, theme) => {
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
		// pi-tui unavailable -> the capped CHAT_WIDGET fallback stays in effect.
	}
}
