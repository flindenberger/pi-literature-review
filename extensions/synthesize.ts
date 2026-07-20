/**
 * pi-literature-review Pi extension: the pi-literature-synthesize tool.
 *
 * Grounded synthesis over the local, verified PDF library (papers/): the
 * engine (src/synthesize.ts) retrieves the most relevant text excerpts,
 * has a LOCAL generator model write prose that may cite ONLY by excerpt
 * number, and then builds the reference list with fixed code from the
 * HTTP-verified search records. The agent model driving Pi never sees the
 * excerpts or writes the review -- it only transports the question; the
 * generator is a separate, config-pinned model slot (default
 * openscholar-8b via Ollama).
 *
 * Like search and fetch, the human consent step is CODE, not instruction:
 * every call opens a blocking terminal dialog summarizing question, corpus,
 * model and retrieval depth BEFORE any LLM call runs. Esc anywhere cancels
 * the whole run.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { llmConfig } from "../src/config.ts";
import { matchLibrary } from "../src/corpus.ts";
import { renderSynthesisDigest } from "../src/digest.ts";
import { parsePerSource } from "../src/intake.ts";
import { outputRoot, writeRunOutputs } from "../src/output.ts";
import { renderReviewHtml } from "../src/render.ts";
import {
	DEFAULT_TOP_K,
	MAX_TOP_K,
	runSynthesize,
	type SynthesizeOptions,
} from "../src/synthesize.ts";

const SYNTH_WIDGET = "pi-literature-review-synthesize";

/** Same widget discipline as fetch: no scrolling exists, so cap the list
 * and clip each line; the full picture is in the HTML report afterwards. */
const WIDGET_MAX_PAPERS = 10;
const WIDGET_MAX_LINE = 110;

function clip(line: string): string {
	return line.length > WIDGET_MAX_LINE ? `${line.slice(0, WIDGET_MAX_LINE - 3)}...` : line;
}

/** The user-adjustable subset of a synthesis call. */
interface SynthIntakeValues {
	question: string;
	papers: string[] | undefined;
	model: string;
	topK: number;
}

/**
 * Code-enforced intake, the search-tool grammar: summary widget, "Run as
 * proposed" / "Adjust parameters" with prefilled editors, Esc/Ctrl+C in any
 * step cancels the whole run BEFORE any LLM call. Returns null on cancel,
 * or "switch-to-ask" when the user picks the single-paper chat instead
 * (user decision 2026-07-16: an ambiguous opening may land in EITHER
 * tool, so BOTH dialogs offer the fork in code).
 */
async function synthIntakeDialog(
	ctx: ExtensionContext,
	proposed: SynthIntakeValues,
	corpusLines: string[],
	embedModel: string,
	backendLine: string,
	diagnostics: string[],
	signal: AbortSignal | undefined,
): Promise<SynthIntakeValues | null | "switch-to-ask"> {
	const values = { ...proposed };
	ctx.ui.setWidget(SYNTH_WIDGET, [
		"Grounded synthesis from the local PDF library",
		`Question:  ${clip(values.question)}`,
		...corpusLines,
		`Generator: ${values.model} (${backendLine}; embeddings: ${embedModel})`,
		`Retrieval: top ${values.topK} excerpts across the corpus`,
		"The generator may cite only by excerpt number; references are inserted",
		"by fixed code from the verified search records.",
	]);
	try {
		const choice = await ctx.ui.select("pi-literature-synthesize: run this synthesis?", [
			"Run as proposed",
			"Adjust parameters",
			"Chat about ONE paper instead (pi-literature-chat)",
		], { signal });
		if (choice === undefined) {
			diagnostics.push("synthesis dialog: cancelled by the user");
			return null;
		}
		if (choice === "Chat about ONE paper instead (pi-literature-chat)") {
			diagnostics.push("synthesis dialog: user switched to the single-paper chat");
			return "switch-to-ask";
		}
		if (choice === "Run as proposed") {
			diagnostics.push("synthesis dialog: confirmed as proposed");
			return values;
		}

		const cancelled = () => {
			diagnostics.push("synthesis dialog: cancelled by the user during adjustment");
			return null;
		};

		const question = await ctx.ui.editor(
			"Research question the review should answer (empty keeps the proposal, Esc cancels the run)",
			values.question,
			{ signal },
		);
		if (question === undefined) return cancelled();
		if (question.trim()) values.question = question.trim();

		const papersPrompt =
			"Papers to use: comma-separated PDF filenames from papers/, or 'all' for the whole "
			+ "library (empty keeps the proposal, Esc cancels the run)";
		const papersSpec = await ctx.ui.editor(
			papersPrompt,
			values.papers?.length ? values.papers.join(", ") : "all",
			{ signal },
		);
		if (papersSpec === undefined) return cancelled();
		if (papersSpec.trim()) {
			values.papers = papersSpec.trim().toLowerCase() === "all"
				? undefined
				: papersSpec.split(",").map((s) => s.trim()).filter(Boolean);
		}

		const model = await ctx.ui.editor(
			"Generator model (any local Ollama model name; empty keeps the proposal, Esc cancels the run)",
			values.model,
			{ signal },
		);
		if (model === undefined) return cancelled();
		if (model.trim()) values.model = model.trim();

		const topKSpec = await ctx.ui.editor(
			`Excerpts to retrieve (top-k, 1-${MAX_TOP_K}; empty keeps the proposal, Esc cancels the run)`,
			String(values.topK),
			{ signal },
		);
		if (topKSpec === undefined) return cancelled();
		if (topKSpec.trim()) {
			const topK = parsePerSource(topKSpec, MAX_TOP_K);
			if (topK === null) {
				ctx.ui.notify(`Count "${topKSpec.trim()}" not understood; keeping the proposal`, "warning");
			} else {
				if (String(topK) !== topKSpec.trim()) {
					ctx.ui.notify(`Capped at ${MAX_TOP_K} excerpts (context window budget)`, "info");
				}
				values.topK = topK;
			}
		}

		diagnostics.push("synthesis dialog: parameters adjusted by the user");
		return values;
	} finally {
		ctx.ui.setWidget(SYNTH_WIDGET, undefined);
	}
}

export default function literatureSynthesize(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi-literature-synthesize",
		label: "Literature Synthesis",
		description:
			"Write a grounded literature synthesis / summary / review from the PDF papers on disk (the papers/ " +
			"library or the current folder). Use this tool WHENEVER the user asks to synthesize, summarize, review " +
			"or get an overview of the papers, the literature, the PDFs or 'the folder' -- including German " +
			"requests like 'zusammenfassen', 'Zusammenfassung', 'Synthese', 'Literatur zusammenfassen'. " +
			"For a question about ONE specific paper (understanding, explaining, chatting), use pi-literature-chat " +
			"instead. " +
			"Call this tool DIRECTLY and IMMEDIATELY; do NOT ask clarification questions in chat first, do NOT ask " +
			"for a paper list, and do NOT ask for a research question: if the user named none, pass a sensible " +
			"generic one such as 'What are the main findings and methods of the papers in this library?'. On " +
			"every call the tool itself shows the user a terminal dialog summarizing question, corpus, generator " +
			"model and retrieval depth, where the user confirms or ADJUSTS EVERYTHING (including the question) " +
			"before anything runs -- that dialog replaces all chat questions. If the result says the user " +
			"cancelled, ask what they want to change; do not retry unchanged. " +
			"The synthesis is written by a separate LOCAL generator model (not you) that only sees numbered text " +
			"excerpts from the PDFs; fixed code validates its citation markers and inserts the reference list from " +
			"HTTP-verified search records. You never see the excerpts and never write or edit the review. " +
			"The tool result is a short digest: counts, the HTML file path, and one reference line per cited paper. " +
			"The HTML file contains the full review (prose, references, evidence excerpts, method notes); tell the " +
			"user its path -- do NOT quote, summarize, extend or 'improve' the review prose, and never re-type " +
			"titles, authors or identifiers: copy digest reference lines EXACTLY when referring to them. " +
			"If the digest says the synthesis FAILED to ground, relay that verbatim; the draft must not be " +
			"presented as a review. Loose PDFs that never went through search+fetch are adopted automatically " +
			"when their own DOI or arXiv ID can be extracted from the PDF text and verified by an API lookup; " +
			"PDFs without a findable identifier and scanned PDFs are excluded and listed honestly -- never work " +
			"around an exclusion, and never supply metadata for a PDF yourself.",
		promptSnippet:
			"Synthesize/summarize the local PDF papers into a grounded review; citations inserted by fixed code from verified records",
		parameters: Type.Object({
			question: Type.String({
				description: "The research question the synthesis should answer, in the user's words (the review is written in the question's language unless language says otherwise). If the user asked for a general summary without a question, propose one covering the corpus -- the user can edit it in the dialog.",
			}),
			papers: Type.Optional(Type.Array(Type.String(), {
				description: "Restrict the corpus to these PDF filenames from papers/ (as shown in fetch reports). Omit to use the whole library.",
			})),
			model: Type.Optional(Type.String({
				description: "Generator model override (a local Ollama model name). Default: the configured generator (openscholar-8b unless changed).",
			})),
			top_k: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: MAX_TOP_K,
				description: `Excerpts to retrieve as context, default ${DEFAULT_TOP_K}, capped at ${MAX_TOP_K} (context window budget).`,
			})),
			language: Type.Optional(Type.String({
				description: "Output language of the review prose, e.g. \"English\" or \"German\". Default: the language of the question.",
			})),
			reindex: Type.Optional(Type.Boolean({
				description: "Force re-extraction and re-embedding of every paper (default: cached per content hash and embedding model).",
			})),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const diagnostics: string[] = [];
			const report = (message: string) => {
				diagnostics.push(message);
				onUpdate?.({ content: [{ type: "text", text: message }] });
			};
			const cfg = llmConfig();
			let values: SynthIntakeValues = {
				question: params.question.trim(),
				papers: params.papers?.map((s) => s.trim()).filter(Boolean),
				model: params.model?.trim() || cfg.generateModel,
				topK: Math.max(1, Math.min(params.top_k ?? DEFAULT_TOP_K, MAX_TOP_K)),
			};
			if (!values.question) {
				return {
					content: [{ type: "text", text: "No research question was given; nothing to synthesize." }],
					details: { diagnostics },
				};
			}

			if (ctx.hasUI) {
				// Corpus preview BEFORE consent: matching is cheap (filenames +
				// twin JSONs); extraction and embedding only run after the user
				// confirms. Index freshness is revalidated by content hash later.
				const root = outputRoot();
				const { matched, unmatched, papersDir } = matchLibrary(root, (message) => diagnostics.push(message));
				const corpusLines = [
					clip(`Corpus:    ${matched.length} paper(s) with verified metadata in ${papersDir}`),
				];
				for (const paper of matched.slice(0, WIDGET_MAX_PAPERS)) {
					corpusLines.push(clip(`  ${paper.base}.pdf  ${paper.entry.title || "(title unknown)"}`));
				}
				if (matched.length > WIDGET_MAX_PAPERS) {
					corpusLines.push(`  ... and ${matched.length - WIDGET_MAX_PAPERS} more`);
				}
				if (unmatched.length) {
					// Adoption (network) deliberately runs only AFTER consent.
					corpusLines.push(
						`  ${unmatched.length} PDF(s) without metadata yet -- adoption (identifier found in the`,
						"  PDF, verified API lookup) runs after you confirm; failures are excluded and listed.",
					);
					for (const file of unmatched.slice(0, 3)) corpusLines.push(clip(`    ${file}`));
					if (unmatched.length > 3) corpusLines.push(`    ... and ${unmatched.length - 3} more`);
				}

				const result = await synthIntakeDialog(
					ctx,
					values,
					corpusLines,
					cfg.embedModel,
					`${cfg.api} at ${cfg.baseUrl}`,
					diagnostics,
					signal,
				);
				if (result === null) {
					return {
						content: [{
							type: "text",
							text:
								"The user cancelled this synthesis run in the intake dialog. Nothing was generated. " +
								"Ask the user what they want to change before synthesizing again.",
						}],
						details: { diagnostics },
					};
				}
				if (result === "switch-to-ask") {
					return {
						content: [{
							type: "text",
							text:
								"The user wants to chat about ONE paper instead of a corpus synthesis. Call " +
								"pi-literature-chat now (omit question if you only know the topic; the user picks " +
								"the paper in its dialog).",
						}],
						details: { diagnostics },
					};
				}
				values = result;
			} else {
				diagnostics.push("synthesis dialog: skipped (no interactive UI)");
			}
			if (signal?.aborted) {
				diagnostics.push("run aborted before the synthesis started");
				return {
					content: [{ type: "text", text: "The synthesis run was aborted before anything was generated." }],
					details: { diagnostics },
				};
			}

			const options: SynthesizeOptions = {
				question: values.question,
				papers: values.papers,
				model: values.model,
				topK: values.topK,
				language: params.language,
				reindex: params.reindex,
				onWarn: report,
				signal,
			};
			try {
				if (ctx.hasUI) {
					ctx.ui.setWidget(SYNTH_WIDGET, [
						`Synthesizing: ${clip(values.question)}`,
						`Generator: ${values.model} -- indexing and generation progress appears below.`,
					]);
				}
				// The engine wires its own real deps (filesystem, hashing, the
				// configured LLM backend); the extension only transports options.
				const result = await runSynthesize(options);
				let htmlPath: string | null = null;
				try {
					const written = writeRunOutputs(renderReviewHtml(result), result, undefined, "reviews");
					htmlPath = written.htmlPath;
					diagnostics.push(`wrote HTML review to ${written.htmlPath} and JSON copy to ${written.jsonPath}`);
				} catch (error) {
					diagnostics.push(`writing the output files failed: ${error instanceof Error ? error.message : error}`);
				}
				// Digest only -- never the review prose (same anti-fabrication
				// structure as the search digest; the review lives in the HTML).
				return {
					content: [{ type: "text", text: renderSynthesisDigest(result, htmlPath) }],
					details: { diagnostics },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.push(`synthesis failed: ${message}`);
				return {
					content: [{
						type: "text",
						text:
							`The synthesis run failed: ${message} -- nothing was written. Report this to the user ` +
							"verbatim. If it names an unreachable LLM server, Ollama is probably not running; the " +
							"user can verify the backend with: node src/cli.ts llm-check",
					}],
					details: { diagnostics },
				};
			} finally {
				if (ctx.hasUI) ctx.ui.setWidget(SYNTH_WIDGET, undefined);
			}
		},
	});

	// /lit-synthesize -- the agent-free path (companion to /lit-chat,
	// /lit-search, /lit-fetch). Runs the SAME intake dialog, corpus adoption
	// and grounded generation as the tool, with no agent model in the loop.
	// Bare /lit-synthesize proposes a generic question the user edits in the
	// dialog. The digest lands in the transcript (display:true) so it reaches
	// both the user and the agent's later-turn context, without triggering one.
	pi.registerCommand("lit-synthesize", {
		description:
			"Grounded synthesis over the local PDF library, agent-free: /lit-synthesize <question>. "
			+ "Bare /lit-synthesize proposes a generic question you can edit in the dialog.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const cfg = llmConfig();
			const question = (args ?? "").trim()
				|| "What are the main findings and methods of the papers in this library?";
			const diagnostics: string[] = [];
			const progress = (message: string) => ctx.ui.notify(message, "info");
			let values: SynthIntakeValues = {
				question,
				papers: undefined,
				model: cfg.generateModel,
				topK: DEFAULT_TOP_K,
			};
			// Corpus preview BEFORE consent: matching is cheap (filenames + twin
			// JSONs); extraction, embedding and adoption only run after confirm.
			const root = outputRoot();
			const { matched, unmatched, papersDir } = matchLibrary(root, (message) => diagnostics.push(message));
			const corpusLines = [
				clip(`Corpus:    ${matched.length} paper(s) with verified metadata in ${papersDir}`),
			];
			for (const paper of matched.slice(0, WIDGET_MAX_PAPERS)) {
				corpusLines.push(clip(`  ${paper.base}.pdf  ${paper.entry.title || "(title unknown)"}`));
			}
			if (matched.length > WIDGET_MAX_PAPERS) {
				corpusLines.push(`  ... and ${matched.length - WIDGET_MAX_PAPERS} more`);
			}
			if (unmatched.length) {
				corpusLines.push(
					`  ${unmatched.length} PDF(s) without metadata yet -- adoption (identifier found in the`,
					"  PDF, verified API lookup) runs after you confirm; failures are excluded and listed.",
				);
				for (const file of unmatched.slice(0, 3)) corpusLines.push(clip(`    ${file}`));
				if (unmatched.length > 3) corpusLines.push(`    ... and ${unmatched.length - 3} more`);
			}

			const result = await synthIntakeDialog(
				ctx,
				values,
				corpusLines,
				cfg.embedModel,
				`${cfg.api} at ${cfg.baseUrl}`,
				diagnostics,
				ctx.signal,
			);
			if (result === null) {
				ctx.ui.notify("Synthesis cancelled -- nothing was generated.", "info");
				return;
			}
			if (result === "switch-to-ask") {
				ctx.ui.notify("To chat about ONE paper use /lit-chat <question> instead.", "info");
				return;
			}
			values = result;
			if (ctx.signal?.aborted) return;
			try {
				ctx.ui.setWidget(SYNTH_WIDGET, [
					`Synthesizing: ${clip(values.question)}`,
					`Generator: ${values.model} -- indexing and generation progress appears below.`,
				]);
				const synth = await runSynthesize({
					question: values.question,
					papers: values.papers,
					model: values.model,
					topK: values.topK,
					onWarn: progress,
					signal: ctx.signal,
				});
				let htmlPath: string | null = null;
				try {
					const written = writeRunOutputs(renderReviewHtml(synth), synth, undefined, "reviews");
					htmlPath = written.htmlPath;
				} catch (error) {
					ctx.ui.notify(
						`writing the output files failed: ${error instanceof Error ? error.message : error}`,
						"warning",
					);
				}
				if (htmlPath) ctx.ui.notify(`Review written to ${htmlPath}`, "info");
				// Show the digest in the widget: reliable and immediate. (sendMessage
				// with deliverAs:"nextTurn" only queues it for the next prompt, so it
				// never rendered.) The full review is in the HTML file.
				const digestLines = renderSynthesisDigest(synth, htmlPath).split("\n");
				ctx.ui.setWidget(SYNTH_WIDGET, digestLines.length > 16
					? [...digestLines.slice(0, 15), `... (${digestLines.length - 15} more lines -- full review in the HTML)`]
					: digestLines);
			} catch (error) {
				ctx.ui.setWidget(SYNTH_WIDGET, undefined);
				ctx.ui.notify(`Synthesis failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		},
	});
}
