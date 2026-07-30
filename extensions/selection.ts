/**
 * pi-literature-review Pi extension: the pi-literature-selection tool.
 *
 * Downloads selected papers as PDFs into the shared lit-selection/ library. The
 * model's only job is to transport identifiers (DOIs / arXiv IDs) -- from
 * the user's pasted "Download these papers: ..." sentence, from digest
 * lines or from the JSON sidecar -- to this tool. Resolution and download
 * are deterministic code (src/fetch.ts): record link -> Unpaywall -> arXiv,
 * %PDF magic check, honest per-paper report. No LLM ever chooses, produces
 * or repairs a download link.
 *
 * Like the search tool, the human consent step is CODE, not instruction:
 * every call opens a blocking terminal dialog listing exactly what would be
 * downloaded (titles from the saved searches, not from the model) before
 * any network request fires.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configPath, isPlausibleMailto, storeMailto } from "../src/config.ts";
import { type DialogLang, type WizardStepDef } from "../src/dialog-state.ts";
import {
	loadSidecarIndex,
	parseIdentifier,
	renderFetchReport,
	runSelection,
} from "../src/selection.ts";
import { outputRoot } from "../src/output.ts";
import { contactMailto } from "../src/types.ts";
import { chatLangDefault, installChatLangObserver, runWizard } from "./dialogs.ts";

const SELECTION_WIDGET = "pi-literature-review-selection";

/** The bare-command identifier intake (v29.1: every bare command opens its
 * dialog directly; the agent handoff is gone). */
const FETCH_TEXT: Record<DialogLang, {
	/** Line above the tab bar: which dialog this is (v30.12). */
	header: string;
	idTab: string;
	idTitle: string;
	idPlaceholder: string;
	noIds: string;
}> = {
	de: {
		header: "/lit-selection -- Paper/Artikel herunterladen (Esc bricht ab)",
		idTab: "Artikel",
		idTitle: "Welche Paper/Artikel herunterladen? DOIs / arXiv-IDs, durch Leerzeichen oder Komma getrennt -- "
			+ "oder die Zeile \"Download these papers: ...\" von der Suchseite einfügen.",
		idPlaceholder: "z. B. 10.3390/rs13081505 arXiv:2401.16393",
		noIds: "Keine Identifier angegeben -- nichts wurde heruntergeladen.",
	},
	en: {
		header: "/lit-selection -- download papers (Esc cancels)",
		idTab: "Papers",
		idTitle: "Which papers to download? DOIs / arXiv IDs separated by spaces or commas -- "
			+ "or paste the \"Download these papers: ...\" line from the search page.",
		idPlaceholder: "e.g. 10.3390/rs13081505 arXiv:2401.16393",
		noIds: "No identifiers given -- nothing was downloaded.",
	},
};

/** Split pasted identifier text; tolerates the search page's copy sentence
 * and the semicolons a text step makes of pasted newlines. */
function splitIdentifiers(raw: string): string[] {
	return raw
		.replace(/^\s*download\s+these\s+papers\s*:?\s*/i, "")
		.split(/[\s,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** One-step wizard asking for the identifiers (same look as every other
 * intake since v29.1; skipSubmit -- one Enter finishes). Null on cancel. */
async function identifiersDialog(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<string[] | null> {
	const lang = chatLangDefault();
	const text = FETCH_TEXT[lang];
	const steps: WizardStepDef[] = [{
		kind: "text",
		id: "identifiers",
		tab: text.idTab,
		title: text.idTitle,
		placeholder: text.idPlaceholder,
		// v30: identifiers are no questions -- no "N question(s)" counter.
		plain: true,
	}];
	const result = await runWizard(ctx, steps, signal, { lang, header: text.header, skipSubmit: true });
	if (result === null) return null;
	return splitIdentifiers(typeof result.identifiers === "string" ? result.identifiers : "");
}

/** Widgets have no documented height limit and no scrolling -- an oversized
 * list would push the chat off screen. Cap the paper list and clip each
 * line; the full list is always in the report afterwards. */
const WIDGET_MAX_PAPERS = 15;
const WIDGET_MAX_LINE = 110;

function clip(line: string): string {
	return line.length > WIDGET_MAX_LINE ? `${line.slice(0, WIDGET_MAX_LINE - 3)}...` : line;
}

/**
 * While no contact email is configured (env var or stored config), every
 * fetch run asks -- with an explanation of WHY the email exists at all, and
 * with per-run entry as a first-class choice (some users prefer typing it
 * each time over persisting it; choosing "without Unpaywall" is not
 * remembered either, so the question simply returns next run). Returns the
 * mailto for this run ("" = run without Unpaywall), or null when the user
 * cancelled the whole run (Esc, as in every other dialog).
 */
async function mailtoDialog(
	ctx: ExtensionContext,
	diagnostics: string[],
	signal: AbortSignal | undefined,
): Promise<string | null> {
	const savePath = configPath();
	ctx.ui.setWidget(SELECTION_WIDGET, [
		"Unpaywall setup (one question, only while no email is configured)",
		"",
		"Unpaywall (unpaywall.org, by the non-profit OurResearch) indexes legal",
		"free PDF copies of papers. Using its API requires a contact email --",
		"that is their usage policy, so they can reach out if a client",
		"misbehaves. The address is sent only to api.unpaywall.org and is not",
		"used for anything else. Without it, downloads still work through the",
		"record's own PDF link and arXiv; Unpaywall is what finds free copies",
		"beyond those.",
	]);
	try {
		const choice = await ctx.ui.select("Contact email for Unpaywall -- how do you want to proceed?", [
			"Enter email for this run only",
			`Enter email and save it to ${savePath}`,
			"Continue without Unpaywall (asks again next time)",
		], { signal });
		if (choice === undefined) {
			diagnostics.push("unpaywall email dialog: cancelled by the user");
			return null;
		}
		if (choice.startsWith("Continue")) {
			diagnostics.push("unpaywall email: skipped for this run (not remembered)");
			return "";
		}
		// Cancel/empty input falls through to the "continue without
		// Unpaywall" path below (webui-compat: RPC web clients report an
		// empty submit as cancelled; aborting the whole download over the
		// optional email would be out of proportion either way).
		const email = await ctx.ui.input("Contact email (e.g. name@example.org)", undefined, { signal });
		const trimmed = (email ?? "").trim();
		if (!trimmed || !isPlausibleMailto(trimmed)) {
			ctx.ui.notify(
				trimmed
					? `"${trimmed}" does not look like an email address; continuing without Unpaywall`
					: "No email entered; continuing without Unpaywall",
				"warning",
			);
			diagnostics.push("unpaywall email: invalid or empty, run continues without Unpaywall");
			return "";
		}
		if (choice.startsWith("Enter email and save")) {
			const written = storeMailto(trimmed);
			ctx.ui.notify(`Email stored in ${written}`, "info");
			diagnostics.push(`unpaywall email stored in ${written}`);
		} else {
			diagnostics.push("unpaywall email: provided for this run only");
		}
		return trimmed;
	} finally {
		ctx.ui.setWidget(SELECTION_WIDGET, undefined);
	}
}

/**
 * Code-enforced consent: list exactly what would be downloaded -- titles come
 * from the saved searches on disk, not from the model -- and ask before any
 * network request fires. Shared by the tool and the /lit-selection command.
 * Returns false when the user cancels (Esc or "Cancel").
 */
async function fetchConsentDialog(
	ctx: ExtensionContext,
	identifiers: string[],
	diagnostics: string[],
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const root = outputRoot();
	const index = loadSidecarIndex(root, (message) => diagnostics.push(message));
	const lines = identifiers.map((raw) => {
		const target = parseIdentifier(raw);
		if (target.kind === "unknown") return clip(`  ${raw}  -- NOT a DOI or arXiv ID`);
		const entry = target.key !== null ? index.get(target.key) : undefined;
		return clip(`  ${raw}  ${entry?.title ?? "(not from any saved search)"}`);
	});
	const shown = lines.slice(0, WIDGET_MAX_PAPERS);
	if (lines.length > shown.length) {
		shown.push(`  ... and ${lines.length - shown.length} more (all listed in the report afterwards)`);
	}
	ctx.ui.setWidget(SELECTION_WIDGET, [
		`Download ${identifiers.length} paper(s) as PDF`,
		`Library:  ${root}/papers`,
		"Sources:  record link, Unpaywall, arXiv (legal open access only)",
		...shown,
	]);
	try {
		const choice = await ctx.ui.select("pi-literature-selection: download these PDFs?", [
			"Download",
			"Cancel",
		], { signal });
		if (choice === undefined || choice === "Cancel") {
			diagnostics.push("fetch dialog: cancelled by the user");
			return false;
		}
		diagnostics.push("fetch dialog: confirmed by the user");
		return true;
	} finally {
		ctx.ui.setWidget(SELECTION_WIDGET, undefined);
	}
}

export default function literatureSelection(pi: ExtensionAPI) {
	// Shared chat-language observer (dialogs.ts): the identifier dialog
	// opens in the language of the user's recent plain chat input.
	installChatLangObserver(pi);
	pi.registerTool({
		name: "pi-literature-selection",
		label: "Literature Fetch",
		description:
			"Download papers as PDFs into the local lit-selection/ library. Use this tool WHENEVER the user asks to " +
			"download, fetch or save papers or PDFs -- including the pasted sentence \"Download these papers: ...\" " +
			"from the search result page. Never use generic web tools or shell commands for paper downloads. " +
			"Pass the identifiers (DOIs / arXiv IDs) EXACTLY as they appear in the user's message, in digest " +
			"reference lines or in the JSON sidecar; never invent, complete or correct an identifier. " +
			"Call directly; do not ask for confirmation in chat -- on every call the tool itself shows the user " +
			"a terminal dialog listing what would be downloaded, and nothing is fetched before they confirm. " +
			"If the result says the user cancelled, ask what they want to change; do not retry unchanged. " +
			"Resolution is deterministic code over legal open-access sources only (the record's own PDF link, " +
			"Unpaywall, arXiv); no gray sources. The result is a short per-paper report: downloaded / already in " +
			"the library / blocked by publisher (with a link the user opens in their browser -- do NOT try to " +
			"download those another way) / not freely available (with the publisher link for authorized access). " +
			"When referring to report lines, copy them EXACTLY; never re-type titles or identifiers from memory.",
		promptSnippet:
			"Download selected papers as verified PDFs into the lit-selection/ library; returns a short per-paper report",
		parameters: Type.Object({
			identifiers: Type.Array(Type.String(), {
				minItems: 1,
				description:
					"DOIs and/or arXiv IDs to download, copied EXACTLY from the user's message, digest lines or the JSON sidecar (e.g. [\"10.3390/rs13081505\", \"arXiv:2401.16393\"]).",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const diagnostics: string[] = [];
			// Progress: per-paper status lines ("fetching X (2/5)", outcome)
			// double as live updates in the UI during longer download runs.
			const report = (message: string) => {
				diagnostics.push(message);
				onUpdate?.({ content: [{ type: "text", text: message }] });
			};
			const identifiers = params.identifiers.map((s) => s.trim()).filter(Boolean);
			if (!identifiers.length) {
				return {
					content: [{ type: "text", text: "No identifiers were given; nothing to download." }],
					details: { diagnostics },
				};
			}

			// Unpaywall email: ask (with explanation) while none is configured.
			let runMailto: string | undefined;
			if (ctx.hasUI && !contactMailto()) {
				const answer = await mailtoDialog(ctx, diagnostics, signal);
				if (answer === null) {
					return {
						content: [{
							type: "text",
							text:
								"The user cancelled this fetch run in the Unpaywall email dialog. Nothing was " +
								"downloaded. Ask the user what they want to change before fetching again.",
						}],
						details: { diagnostics },
					};
				}
				runMailto = answer;
			}

			// Code-enforced consent: list exactly what would be downloaded --
			// titles come from the saved searches on disk, not from the model.
			if (ctx.hasUI) {
				if (!(await fetchConsentDialog(ctx, identifiers, diagnostics, signal))) {
					return {
						content: [{
							type: "text",
							text:
								"The user cancelled this fetch run in the confirmation dialog. Nothing was " +
								"downloaded. Ask the user what they want to change before fetching again.",
						}],
						details: { diagnostics },
					};
				}
			} else {
				diagnostics.push("fetch dialog: skipped (no interactive UI)");
			}
			if (signal?.aborted) {
				diagnostics.push("run aborted before any download started");
				return {
					content: [{ type: "text", text: "The fetch run was aborted before any download started." }],
					details: { diagnostics },
				};
			}

			const { results, papersDir } = await runSelection({
				identifiers,
				mailto: runMailto,
				onWarn: report,
				signal,
			});
			return {
				content: [{ type: "text", text: renderFetchReport(results, papersDir) }],
				details: { diagnostics },
			};
		},
	});

	// /lit-selection -- the agent-free path. The user pastes identifiers, or the
	// whole "Download these papers: ..." sentence copied from the search
	// page; bare /lit-selection opens the identifier dialog DIRECTLY (v29.1:
	// the command owns the dialog, the v22 agent handoff is gone). The SAME
	// Unpaywall-email and consent dialogs gate the download.
	pi.registerCommand("lit-selection", {
		description:
			"Download papers as PDFs: /lit-selection [DOIs / arXiv IDs] runs agent-free (or paste the "
			+ "\"Download these papers: ...\" line from the search page); bare /lit-selection asks for the "
			+ "identifiers in a dialog.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			let identifiers = splitIdentifiers(args ?? "");
			if (!identifiers.length) {
				const typed = await identifiersDialog(ctx, ctx.signal);
				if (typed === null) return; // cancelled
				if (!typed.length) {
					ctx.ui.notify(FETCH_TEXT[chatLangDefault()].noIds, "warning");
					return;
				}
				identifiers = typed;
			}
			const diagnostics: string[] = [];
			const progress = (message: string) => ctx.ui.notify(message, "info");
			// Unpaywall email: ask (with explanation) while none is configured.
			let runMailto: string | undefined;
			if (!contactMailto()) {
				const answer = await mailtoDialog(ctx, diagnostics, ctx.signal);
				if (answer === null) {
					ctx.ui.notify("Download cancelled.", "info");
					return;
				}
				runMailto = answer;
			}
			if (!(await fetchConsentDialog(ctx, identifiers, diagnostics, ctx.signal))) {
				ctx.ui.notify("Download cancelled -- nothing was downloaded.", "info");
				return;
			}
			if (ctx.signal?.aborted) return;
			try {
				const { results, papersDir } = await runSelection({
					identifiers,
					mailto: runMailto,
					onWarn: progress,
					signal: ctx.signal,
				});
				// Show the per-paper report in the widget: reliable and immediate.
				// (sendMessage with deliverAs:"nextTurn" only queues it for the next
				// prompt, so it never rendered.)
				const reportLines = renderFetchReport(results, papersDir).split("\n");
				ctx.ui.setWidget(SELECTION_WIDGET, reportLines.length > 16
					? [...reportLines.slice(0, 15), `... (${reportLines.length - 15} more lines)`]
					: reportLines);
			} catch (error) {
				ctx.ui.notify(`Fetch failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		},
	});
}
