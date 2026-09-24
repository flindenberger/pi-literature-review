/**
 * Selection stage adapter for pi: registers the pi-literature-selection tool
 * and the /lit-selection command. Both download papers as PDFs into the
 * lit-selection/ library; a model's only job is to transport identifiers
 * (DOIs / arXiv IDs) -- from the pasted "Download these papers: ..."
 * sentence, from digest lines or from the JSON sidecar. Resolution and
 * download are deterministic code (src/selection.ts): access gate, then
 * record link -> OpenAlex locations -> Unpaywall -> article page -> arXiv,
 * %PDF magic check, per-paper report. No LLM ever
 * chooses, produces or repairs a download link.
 *
 * Three code gates before any network request: the identifier dialog
 * (passed identifiers are prefill, editable), the Unpaywall email question
 * (only while none is configured) and the consent dialog listing exactly
 * what would be downloaded (titles from the saved searches, not from the
 * model).
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

/** Identifier dialog strings per dialog language. */
const FETCH_TEXT: Record<DialogLang, {
	/** Line above the tab bar: which dialog this is. */
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
 * intake; skipSubmit -- one Enter finishes). It opens on EVERY interactive
 * run: passed identifiers arrive as PREFILL, editable, never silently
 * skipped past the user. Null on cancel. */
async function identifiersDialog(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	prefill?: string,
): Promise<string[] | null> {
	const lang = chatLangDefault();
	const text = FETCH_TEXT[lang];
	const steps: WizardStepDef[] = [{
		kind: "text",
		id: "identifiers",
		tab: text.idTab,
		title: text.idTitle,
		placeholder: text.idPlaceholder,
		...(prefill?.trim() ? { initial: prefill.trim() } : {}),
		// Identifiers are no questions -- no "N question(s)" counter.
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
 * download run asks -- with an explanation of WHY the email exists at all, and
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
		"misbehaves. Once set, the address goes with every API request of this",
		"package (as contact in the User-Agent). Without it, downloads still work through the",
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
		// Unpaywall" path below (RPC web clients report an empty submit as
		// cancelled; aborting the whole download over the optional email
		// would be out of proportion either way).
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
		`Library:  ${root}/lit-selection`,
		"Sources:  record link, OpenAlex, Unpaywall, article page, arXiv (legal open access only)",
		...shown,
	]);
	try {
		const choice = await ctx.ui.select("pi-literature-selection: download these PDFs?", [
			"Download",
			"Cancel",
		], { signal });
		if (choice === undefined || choice === "Cancel") {
			diagnostics.push("consent dialog: cancelled by the user");
			return false;
		}
		diagnostics.push("consent dialog: confirmed by the user");
		return true;
	} finally {
		ctx.ui.setWidget(SELECTION_WIDGET, undefined);
	}
}

/** Outcome of the gated run shared by the tool and the command. */
type SelectionOutcome =
	| { status: "cancelled"; where: "Unpaywall email" | "confirmation" }
	| { status: "aborted" }
	| { status: "done"; report: string };

/**
 * The gates and the download, shared by the tool and the /lit-selection
 * command: Unpaywall email (while none is configured), consent dialog,
 * abort check, then runSelection. Headless callers (no UI) skip the
 * dialogs. The caller turns the outcome into its own wording.
 */
async function gatedSelection(
	ctx: ExtensionContext,
	identifiers: string[],
	diagnostics: string[],
	signal: AbortSignal | undefined,
	onWarn: (message: string) => void,
): Promise<SelectionOutcome> {
	let runMailto: string | undefined;
	if (ctx.hasUI && !contactMailto()) {
		const answer = await mailtoDialog(ctx, diagnostics, signal);
		if (answer === null) return { status: "cancelled", where: "Unpaywall email" };
		runMailto = answer;
	}
	if (ctx.hasUI) {
		if (!(await fetchConsentDialog(ctx, identifiers, diagnostics, signal))) {
			return { status: "cancelled", where: "confirmation" };
		}
	} else {
		diagnostics.push("consent dialog: skipped (no interactive UI)");
	}
	if (signal?.aborted) {
		diagnostics.push("run aborted before any download started");
		return { status: "aborted" };
	}
	const { results, papersDir } = await runSelection({ identifiers, mailto: runMailto, onWarn, signal });
	return { status: "done", report: renderFetchReport(results, papersDir) };
}

export default function literatureSelection(pi: ExtensionAPI) {
	// Shared chat-language observer (dialogs.ts): the identifier dialog
	// opens in the language of the user's recent plain chat input.
	installChatLangObserver(pi);
	pi.registerTool({
		name: "pi-literature-selection",
		label: "Literature Selection",
		description:
			"Download papers as PDFs into the local lit-selection/ library. Use this tool WHENEVER the user asks to " +
			"download, fetch or save papers or PDFs -- including the pasted sentence \"Download these papers: ...\" " +
			"from the search result page. Never use generic web tools or shell commands for paper downloads. " +
			"Pass the identifiers (DOIs / arXiv IDs) EXACTLY as they appear in the user's message, in digest " +
			"reference lines or in the JSON sidecar; never invent, complete or correct an identifier. " +
			"Call directly; do not ask for confirmation in chat -- on every call the tool itself first shows the " +
			"user the identifiers in an editable dialog (your list is only the prefill; the user's edits win), " +
			"then a terminal dialog listing what would be downloaded, and nothing is fetched before they confirm. " +
			"If the result says the user cancelled, ask what they want to change; do not retry unchanged. " +
			"Resolution is deterministic code over legal open-access sources only (the record's own PDF link, " +
			"OpenAlex locations, Unpaywall, the article page where robots.txt allows it, arXiv); no gray sources. " +
			"The result is a short per-paper report: downloaded / already in the library / free, open in browser " +
			"and restricted (both with a link the user opens in their browser -- do NOT try to download those " +
			"another way) / abstract only (no PDF exists) / not freely available (with the publisher link). " +
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
				onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
			};
			const cancelled = (where: string) => ({
				content: [{
					type: "text" as const,
					text: `The user cancelled this download run in the ${where} dialog. Nothing was `
						+ "downloaded. Ask the user what they want to change before downloading again.",
				}],
				details: { diagnostics },
			});
			let identifiers = params.identifiers.map((s) => s.trim()).filter(Boolean);
			// The identifier dialog opens on EVERY interactive run (passed
			// identifiers are prefill, never a silent jump past the user);
			// headless callers keep the parameter-only path.
			if (ctx.hasUI) {
				const typed = await identifiersDialog(ctx, signal, identifiers.join(" "));
				if (typed === null) {
					diagnostics.push("identifier dialog: cancelled by the user");
					return cancelled("identifier");
				}
				identifiers = typed;
				diagnostics.push(`identifier dialog: confirmed (${identifiers.length} identifier(s))`);
			}
			if (!identifiers.length) {
				return {
					content: [{ type: "text", text: "No identifiers were given; nothing to download." }],
					details: { diagnostics },
				};
			}
			const outcome = await gatedSelection(ctx, identifiers, diagnostics, signal, report);
			if (outcome.status === "cancelled") return cancelled(outcome.where);
			if (outcome.status === "aborted") {
				return {
					content: [{ type: "text", text: "The download run was aborted before any download started." }],
					details: { diagnostics },
				};
			}
			return { content: [{ type: "text", text: outcome.report }], details: { diagnostics } };
		},
	});

	// /lit-selection -- the agent-free path. The user pastes identifiers, or
	// the whole "Download these papers: ..." sentence copied from the search
	// page; the identifier dialog opens on EVERY run with the pasted
	// identifiers prefilled. The SAME Unpaywall-email and consent dialogs
	// gate the download.
	pi.registerCommand("lit-selection", {
		// Palette one-liner (user wording 2026-09-02); details live in docs/selection.md.
		description: "Download academic literature as PDFs, e.g. the papers ticked in the HTML search report.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			// The dialog opens with or without args: pasted identifiers arrive
			// as prefill, editable before anything runs.
			const typed = await identifiersDialog(ctx, ctx.signal, splitIdentifiers(args ?? "").join(" "));
			if (typed === null) return; // cancelled
			if (!typed.length) {
				ctx.ui.notify(FETCH_TEXT[chatLangDefault()].noIds, "warning");
				return;
			}
			const diagnostics: string[] = [];
			const progress = (message: string) => ctx.ui.notify(message, "info");
			try {
				const outcome = await gatedSelection(ctx, typed, diagnostics, ctx.signal, progress);
				if (outcome.status === "cancelled") {
					ctx.ui.notify("Download cancelled -- nothing was downloaded.", "info");
					return;
				}
				if (outcome.status === "aborted") return;
				// Show the per-paper report in the widget (capped; the full
				// report is what the widget lines are cut from).
				const reportLines = outcome.report.split("\n");
				ctx.ui.setWidget(SELECTION_WIDGET, reportLines.length > 16
					? [...reportLines.slice(0, 15), `... (${reportLines.length - 15} more lines)`]
					: reportLines);
			} catch (error) {
				ctx.ui.notify(`Download failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		},
	});
}
