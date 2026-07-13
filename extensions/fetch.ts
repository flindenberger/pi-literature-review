/**
 * pi-literature-review Pi extension: the pi-literature-fetch tool.
 *
 * Downloads selected papers as PDFs into the shared papers/ library. The
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
import {
	loadSidecarIndex,
	parseIdentifier,
	renderFetchReport,
	runFetch,
} from "../src/fetch.ts";
import { outputRoot } from "../src/output.ts";
import { contactMailto } from "../src/types.ts";

const FETCH_WIDGET = "pi-literature-review-fetch";

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
	ctx.ui.setWidget(FETCH_WIDGET, [
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
		const email = await ctx.ui.input("Contact email (e.g. name@example.org)", undefined, { signal });
		if (email === undefined) {
			diagnostics.push("unpaywall email dialog: cancelled by the user");
			return null;
		}
		const trimmed = email.trim();
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
		ctx.ui.setWidget(FETCH_WIDGET, undefined);
	}
}

export default function literatureFetch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi-literature-fetch",
		label: "Literature Fetch",
		description:
			"Download papers as PDFs into the local papers/ library. Use this tool WHENEVER the user asks to " +
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
			"Download selected papers as verified PDFs into the papers/ library; returns a short per-paper report",
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
				ctx.ui.setWidget(FETCH_WIDGET, [
					`Download ${identifiers.length} paper(s) as PDF`,
					`Library:  ${root}/papers`,
					"Sources:  record link, Unpaywall, arXiv (legal open access only)",
					...shown,
				]);
				try {
					const choice = await ctx.ui.select("pi-literature-fetch: download these PDFs?", [
						"Download",
						"Cancel",
					], { signal });
					if (choice === undefined || choice === "Cancel") {
						diagnostics.push("fetch dialog: cancelled by the user");
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
					diagnostics.push("fetch dialog: confirmed by the user");
				} finally {
					ctx.ui.setWidget(FETCH_WIDGET, undefined);
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

			const { results, papersDir } = await runFetch({
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
}
