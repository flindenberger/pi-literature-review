/**
 * Selection stage adapter for pi: registers the pi-literature-selection tool
 * and the /lit-selection command. Both download papers as PDFs into a
 * folder the user chooses; a model's only job is to transport identifiers
 * (DOIs / arXiv IDs) -- from the pasted "Download these papers: ..."
 * sentence, from digest lines or from the JSON sidecar. Resolution and
 * download are deterministic code (src/selection.ts): access gate, then
 * record link -> OpenAlex locations -> Unpaywall -> article page -> arXiv,
 * %PDF magic check, per-paper report. No LLM ever
 * chooses, produces or repairs a download link.
 *
 * Four code gates before any network request: the identifier dialog
 * (passed identifiers are prefill, editable), the Unpaywall email question
 * (only while none is configured), the download folder (asked on every
 * run, the last folder first; a folder the agent passes is only offered)
 * and the consent dialog listing exactly what would be downloaded (titles
 * from the saved searches, not from the model).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { configPath, isPlausibleMailto, lastDownloadDir, pdfFolders, rememberDownloadDir, storeMailto } from "../src/config.ts";
import { canPickFolder, pickFolder } from "../src/folderpick.ts";
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
	folder: string,
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
		`Folder:   ${folder}`,
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

/** A typed folder as an absolute path ("~" is the home folder); null when
 * it is relative or cannot be created/used as a folder. */
function usableFolder(typed: string): string | null {
	const text = typed.trim();
	if (!text) return null;
	const expanded = text === "~" ? homedir() : text.startsWith("~/") ? join(homedir(), text.slice(2)) : text;
	if (!isAbsolute(expanded)) return null;
	const path = resolve(expanded);
	try {
		if (existsSync(path)) return statSync(path).isDirectory() ? path : null;
		mkdirSync(path, { recursive: true });
		return path;
	} catch {
		return null;
	}
}

/**
 * Where the PDFs go, asked on every interactive run: the last download
 * folder first (one Enter keeps it), the other PDF folders, the system's
 * folder window (only with a desktop), or a typed path. A folder the agent
 * passed is offered first, never used silently. Null on cancel.
 */
async function folderDialog(
	ctx: ExtensionContext,
	diagnostics: string[],
	signal: AbortSignal | undefined,
	suggested?: string,
): Promise<string | null> {
	const last = lastDownloadDir();
	const known = [...new Set([suggested ? resolve(suggested) : "", last, ...pdfFolders()].filter(Boolean))];
	const WINDOW = "Choose in a folder window ...";
	const TYPE = "Type a path ...";
	const CANCEL = "Cancel";
	const labelOf = (folder: string) => `${folder}${folder === last ? "   (last used)" : suggested && folder === resolve(suggested) ? "   (suggested)" : "   (PDF folder)"}`;
	for (;;) {
		const options = [...known.map(labelOf), ...(canPickFolder() ? [WINDOW] : []), TYPE, CANCEL];
		const choice = await ctx.ui.select("pi-literature-selection: where should the PDFs go?", options, { signal });
		if (choice === undefined || choice === CANCEL) {
			diagnostics.push("folder dialog: cancelled by the user");
			return null;
		}
		let folder: string | null = null;
		if (choice === WINDOW) {
			try {
				const picked = await pickFolder("Where should the PDFs go?", last);
				if (!picked) continue; // closed the window: ask again
				folder = usableFolder(picked);
			} catch (error) {
				ctx.ui.notify(`${error instanceof Error ? error.message : error}`, "warning");
				continue;
			}
		} else if (choice === TYPE) {
			const typed = await ctx.ui.input("Download folder (full path, ~ = your home folder)", last || join(homedir(), "Papers"), { signal });
			if (typed === undefined) continue;
			folder = usableFolder(typed);
			if (!folder) {
				ctx.ui.notify(`"${typed}" is not a usable folder: give a full path (it is created when missing).`, "warning");
				continue;
			}
		} else {
			folder = usableFolder(known[options.indexOf(choice)] ?? "");
		}
		if (folder) {
			diagnostics.push(`folder dialog: ${folder}`);
			return folder;
		}
		ctx.ui.notify("That folder cannot be used; choose another one.", "warning");
	}
}

/** Outcome of the gated run shared by the tool and the commands. */
export type SelectionOutcome =
	| { status: "cancelled"; where: "Unpaywall email" | "folder" | "confirmation" }
	| { status: "aborted" }
	| { status: "done"; report: string };

/**
 * The gates and the download, shared by the tool, the /lit-selection
 * command and the download part of /lit-search: Unpaywall email (while none is configured), consent dialog,
 * abort check, then runSelection. Headless callers (no UI) skip the
 * dialogs. The caller turns the outcome into its own wording.
 */
export async function gatedSelection(
	ctx: ExtensionContext,
	identifiers: string[],
	diagnostics: string[],
	signal: AbortSignal | undefined,
	onWarn: (message: string) => void,
	suggestedFolder?: string,
): Promise<SelectionOutcome> {
	let runMailto: string | undefined;
	if (ctx.hasUI && !contactMailto()) {
		const answer = await mailtoDialog(ctx, diagnostics, signal);
		if (answer === null) return { status: "cancelled", where: "Unpaywall email" };
		runMailto = answer;
	}
	let folder: string | undefined;
	if (ctx.hasUI) {
		const chosen = await folderDialog(ctx, diagnostics, signal, suggestedFolder);
		if (chosen === null) return { status: "cancelled", where: "folder" };
		folder = chosen;
		if (!(await fetchConsentDialog(ctx, identifiers, diagnostics, signal, folder))) {
			return { status: "cancelled", where: "confirmation" };
		}
	} else {
		diagnostics.push("consent dialog: skipped (no interactive UI)");
	}
	if (signal?.aborted) {
		diagnostics.push("run aborted before any download started");
		return { status: "aborted" };
	}
	const { results, papersDir } = await runSelection({ identifiers, mailto: runMailto, onWarn, signal, ...(folder ? { dir: folder } : {}) });
	if (folder) rememberDownloadDir(folder);
	return { status: "done", report: renderFetchReport(results, papersDir) };
}

/** The per-paper report in the widget, capped (widgets do not scroll):
 * the summary line and the "Open in your browser" list come first, the
 * per-paper lines after. */
export function showSelectionReport(ctx: ExtensionContext, report: string): void {
	const lines = report.split("\n");
	const browserAt = lines.findIndex((line) => line.startsWith("Open in your browser ("));
	const ordered = browserAt > 0 ? [...lines.slice(0, 3), ...lines.slice(browserAt), "", ...lines.slice(3, browserAt)] : lines;
	ctx.ui.setWidget(SELECTION_WIDGET, ordered.length > 18
		? [...ordered.slice(0, 17), `... (${ordered.length - 17} more lines)`]
		: ordered);
}

export default function literatureSelection(pi: ExtensionAPI) {
	// Shared chat-language observer (dialogs.ts): the identifier dialog
	// opens in the language of the user's recent plain chat input.
	installChatLangObserver(pi);
	pi.registerTool({
		name: "pi-literature-selection",
		label: "Literature Selection",
		description:
			"Download papers as PDFs into a folder the user chooses (asked in a dialog on every run). Use this tool WHENEVER the user asks to " +
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
			"Download selected papers as verified PDFs into a folder the user chooses; returns a short per-paper report",
		parameters: Type.Object({
			identifiers: Type.Array(Type.String(), {
				minItems: 1,
				description:
					"DOIs and/or arXiv IDs to download, copied EXACTLY from the user's message, digest lines or the JSON sidecar (e.g. [\"10.3390/rs13081505\", \"arXiv:2401.16393\"]).",
			}),
			folder: Type.Optional(Type.String({
				description: "Only when the user named a target folder: its full path. It is offered in the folder dialog, never used without the user's choice.",
			})),
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
			const outcome = await gatedSelection(ctx, identifiers, diagnostics, signal, report, params.folder?.trim() || undefined);
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
				showSelectionReport(ctx, outcome.report);
			} catch (error) {
				ctx.ui.notify(`Download failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		},
	});
}
