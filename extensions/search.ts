/**
 * pi-literature-review Pi extension.
 *
 * Registers the pi-literature-search tool: deterministic literature discovery
 * (search -> filter -> dedupe -> verify -> group) over arXiv, CrossRef and
 * OpenAlex. Contains no LLM call of any kind: the agent may shape the query
 * and propose grouping word lists, but every record field traces to a
 * search-API response, and every DOI/arXiv ID is HTTP-verified before it is
 * shown as verified.
 *
 * The tool result is deliberately NOT the full payload: a 2026-07-10 field
 * test with a small local model showed that full citation JSON in context
 * gets re-typed, "completed" and outright fabricated. The model receives a
 * short plain-text digest (counts, file paths, one copyable line per record);
 * the full data goes to disk as an HTML rendering plus a JSON sidecar.
 *
 * Parameter confirmation is likewise code, not instruction: every call opens
 * a blocking ctx.ui intake dialog with the user (see intakeDialog below) --
 * models reliably skip "ask the user first" instructions, but they cannot
 * skip a dialog that the tool itself puts between them and the search.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderDigest } from "../src/digest.ts";
import { DEFAULT_PER_SOURCE, MAX_PER_SOURCE, runSearch, SEARCHERS } from "../src/search.ts";
import {
	formatGroupExpression,
	parseGroupSpec,
	parsePerSource,
	parseYearRange,
	yearRangeToSpec,
} from "../src/intake.ts";
import { writeRunOutputs } from "../src/output.ts";
import { renderHtml } from "../src/render.ts";

const THOROUGH_PER_SOURCE = 15;
const INTAKE_WIDGET = "pi-literature-review-intake";

/** The user-adjustable subset of a discovery call. */
interface IntakeValues {
	groupTerms: string[][] | undefined;
	yearFrom: number | undefined;
	yearTo: number | undefined;
	perSource: number | undefined;
}

/**
 * Code-enforced intake: a blocking terminal dialog the MODEL cannot skip or
 * answer. Three field tests (2x Granite, 1x Gemini, 2026-07-10) proved that a
 * description-level instruction to ask intake questions gets ignored or
 * rationalized away; this gate runs on EVERY call (user decision). Returns
 * null when the user cancels the run.
 */
async function intakeDialog(
	ctx: ExtensionContext,
	query: string,
	queryVariants: string[] | undefined,
	sources: string[],
	proposed: IntakeValues,
	diagnostics: string[],
	signal: AbortSignal | undefined,
): Promise<IntakeValues | null> {
	const values = { ...proposed };
	const summary = [
		`Query:    ${query}`,
		...(queryVariants ?? []).map((variant, i) => `Variant:  Q${i + 2}: ${variant}`),
		`Grouping: ${values.groupTerms?.length ? formatGroupExpression(values.groupTerms) : "none (results ungrouped)"}`,
		"          groups AND-linked, terms within a group OR-linked;",
		"          grouping only LABELS results on_target/adjacent, it does not narrow the search",
		`Years:    ${yearRangeToSpec(values.yearFrom, values.yearTo) || "all"}`,
		`Depth:    ${values.perSource ?? DEFAULT_PER_SOURCE} results per source (${sources.join(", ")})`,
	];
	ctx.ui.setWidget(INTAKE_WIDGET, summary);
	try {
		const choice = await ctx.ui.select("pi-literature-search: run this search?", [
			"Run as proposed",
			"Adjust parameters",
		], { signal });
		if (choice === undefined) {
			diagnostics.push("intake dialog: cancelled by the user");
			return null;
		}
		if (choice === "Run as proposed") {
			diagnostics.push("intake dialog: confirmed as proposed");
			return values;
		}

		// Adjust: three prefilled steps. Escape/Ctrl+C in ANY step cancels the
		// whole run (both keys map to the same dialog cancel; a field is kept
		// unchanged by submitting it as-is or leaving the input empty).
		const cancelled = () => {
			diagnostics.push("intake dialog: cancelled by the user during adjustment");
			return null;
		};

		const groupPrompt =
			"Grouping: groups AND-linked, terms within a group OR-linked (labels results only, does " +
			"not narrow the search). Edit the expression directly - 'none' = ungrouped, empty keeps " +
			"the proposal, Esc cancels the run";
		// editor() works in TUI and RPC alike (pi docs); headless never gets
		// here because the ctx.hasUI gate skips the whole dialog.
		const groupSpec = await ctx.ui.editor(
			groupPrompt,
			formatGroupExpression(values.groupTerms ?? []),
			{ signal },
		);
		if (groupSpec === undefined) return cancelled();
		if (groupSpec.trim()) {
			values.groupTerms = groupSpec.trim().toLowerCase() === "none" ? undefined : parseGroupSpec(groupSpec);
		}

		const yearPrompt =
			"Publication years: 2015-2024, 2015- or 2024 - 'all' = no limit, empty keeps the " +
			"proposal, Esc cancels the run";
		const yearSpec = await ctx.ui.editor(
			yearPrompt,
			yearRangeToSpec(values.yearFrom, values.yearTo),
			{ signal },
		);
		if (yearSpec === undefined) return cancelled();
		if (yearSpec.trim()) {
			if (yearSpec.trim().toLowerCase() === "all") {
				values.yearFrom = undefined;
				values.yearTo = undefined;
			} else {
				const range = parseYearRange(yearSpec);
				if (range === null) {
					ctx.ui.notify(`Year range "${yearSpec.trim()}" not understood; keeping the proposal`, "warning");
				} else {
					values.yearFrom = range.yearFrom;
					values.yearTo = range.yearTo;
				}
			}
		}

		const proposedDepth = values.perSource ?? DEFAULT_PER_SOURCE;
		const depth = await ctx.ui.select("Search depth (results per source)", [
			`Keep proposed (${proposedDepth} per source)`,
			`Quick scan (${DEFAULT_PER_SOURCE} per source)`,
			`Thorough (${THOROUGH_PER_SOURCE} per source)`,
			`Exhaustive (${MAX_PER_SOURCE} per source)`,
			"Custom count...",
		], { signal });
		if (depth === undefined) return cancelled();
		if (depth.startsWith("Quick")) values.perSource = DEFAULT_PER_SOURCE;
		else if (depth.startsWith("Thorough")) values.perSource = THOROUGH_PER_SOURCE;
		else if (depth.startsWith("Exhaustive")) values.perSource = MAX_PER_SOURCE;
		else if (depth.startsWith("Custom")) {
			const countPrompt = `Results per source (1-${MAX_PER_SOURCE}; the cap is politeness towards the free APIs)`;
			const countSpec = await ctx.ui.editor(countPrompt, String(proposedDepth), { signal });
			if (countSpec === undefined) return cancelled();
			if (countSpec.trim()) {
				const count = parsePerSource(countSpec, MAX_PER_SOURCE);
				if (count === null) {
					ctx.ui.notify(`Count "${countSpec.trim()}" not understood; keeping the proposal`, "warning");
				} else {
					if (String(count) !== countSpec.trim()) {
						ctx.ui.notify(`Capped at ${MAX_PER_SOURCE} per source (politeness towards the free APIs)`, "info");
					}
					values.perSource = count;
				}
			}
		}

		diagnostics.push("intake dialog: parameters adjusted by the user");
		return values;
	} finally {
		ctx.ui.setWidget(INTAKE_WIDGET, undefined);
	}
}

export default function literatureSearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi-literature-search",
		label: "Literature Search",
		description:
			"Search academic literature (arXiv, CrossRef, OpenAlex): clean, deduplicated, HTTP-verified results, " +
			"written to disk by fixed code. " +
			"This tool DISCOVERS NEW papers in online databases. It is NOT for papers already on disk: when the " +
			"user wants to chat about, ask about or understand ONE local PDF ('zu einem Paper chatten', 'Frage zum " +
			"Paper'), use pi-literature-ask; for a summary or review across the local PDF library, use " +
			"pi-literature-synthesize; for downloading found papers, use pi-literature-fetch. " +
			"Call this tool DIRECTLY; do NOT ask intake or clarification questions in chat first. On every call the " +
			"tool itself shows the user a terminal dialog summarizing the proposed query, grouping logic, year range " +
			"and search depth, where the user confirms or adjusts them before the search runs. Your job is only to " +
			"propose sensible parameters. If the result says the user cancelled the dialog, ask what they want to " +
			"change; do not retry unchanged. " +
			"The tool result is a short digest only: counts, the HTML file path, and one reference line per record " +
			"(group flag, year, DOI/arXiv ID, title). Lines marked UNVERIFIED did not resolve at doi.org/arxiv.org; " +
			"treat them with suspicion and say so. Every run writes a deterministic HTML rendering (sortable table, " +
			"abstracts, links, dropped list) to pi-literature-review/queries/<date>_<query>.html in the working directory " +
			"(root overridable via PI_LITERATURE_REVIEW_HOME; exact path via html_file), plus a machine-readable .json " +
			"copy of the full results with the same basename - read that file for structured follow-up steps, but do " +
			"not mention its path to the user. The HTML file is where the user reviews and selects papers: tell them " +
			"its path. When you refer to a record, copy its digest line EXACTLY; never re-type, complete or invent " +
			"titles, authors, years or identifiers, never build your own results table, and never add key findings, " +
			"methodology advice, next steps or deliverables - this tool only discovers literature. Optional " +
			"group_terms sort results into on_target/adjacent by deterministic word rules: a record is on_target when " +
			"at least one term from EVERY group appears in its title or abstract. Derive the groups from the user's " +
			"research question, one group per required concept, e.g. for river sandbars via Sentinel: " +
			'[["river","fluvial"],["sandbar","bar"],["sentinel","s-1","s-2"]]. ' +
			"If results disappoint, refine group_terms or filters in a new call; NEVER pad the list with loosely " +
			"related papers to reach a count.",
		promptSnippet:
			"Search academic literature; writes verified results to an HTML/JSON pair and returns a short digest",
		parameters: Type.Object({
			query: Type.String({
				description: "Literature search query (topic keywords)",
			}),
			query_variants: Type.Optional(Type.Array(Type.String(), {
				description: "Alternative phrasings of the SAME question (synonyms, domain jargon like index names, broader/narrower wording), searched in the same run. Results are deduplicated across all variants by fixed code and each record notes which variants found it (found_by). Use for exhaustive sweeps instead of separate tool calls.",
			})),
			per_source: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: MAX_PER_SOURCE,
				description: `Results per source, default ${DEFAULT_PER_SOURCE}, capped at ${MAX_PER_SOURCE} (politeness towards the free APIs)`,
			})),
			sources: Type.Optional(Type.Array(Type.String(), {
				description: `Sources to query, default all of: ${Object.keys(SEARCHERS).join(", ")}`,
			})),
			group_terms: Type.Optional(Type.Array(Type.Array(Type.String()), {
				description: "Deterministic grouping rules: array of term groups (see tool description). Omit for ungrouped results.",
			})),
			min_cites: Type.Optional(Type.Integer({
				minimum: 0,
				description: "Keep only records with at least this many citations. Records with UNKNOWN counts (arXiv preprints) still pass, visible as cites: null. Note: penalizes very recent papers.",
			})),
			year_from: Type.Optional(Type.Integer({
				description: "Keep only records published in or after this year (records with unknown year are excluded, with a reason)",
			})),
			year_to: Type.Optional(Type.Integer({
				description: "Keep only records published in or before this year",
			})),
			venues: Type.Optional(Type.Array(Type.String(), {
				description: "Keep only records whose journal/venue name contains one of these strings (case-insensitive). Excludes venue-less preprints, with a reason.",
			})),
			require_pdf: Type.Optional(Type.Boolean({
				description: "Keep only records with a direct PDF link",
			})),
			verified_only: Type.Optional(Type.Boolean({
				description: "Keep only records whose DOI/arXiv ID resolved (verified: true)",
			})),
			sort: Type.Optional(Type.String({
				description: 'Sort results descending: "cites" (citation count, a rough impact proxy) or "year" (newest first). Unknown values sort last. Default: source order.',
			})),
			html_file: Type.Optional(Type.String({
				description: "Override for the HTML output path. Default (recommended): omit, and the deterministic location pi-literature-review/queries/<date>_<query>.html in the working directory is used. The page is generated from the JSON payload by fixed code, never by a model.",
			})),
			enrich: Type.Optional(Type.Boolean({
				description: "Fill missing citation counts / journal names via a deterministic OpenAlex identifier lookup (open API, no scraping). Filled fields are listed per record under 'enriched' and marked with * in the HTML. Default: true.",
			})),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const diagnostics: string[] = [];
			// Progress: every pipeline diagnostic doubles as a live status line
			// in the UI (per-source counts, verification, enrichment).
			const report = (message: string) => {
				diagnostics.push(message);
				onUpdate?.({ content: [{ type: "text", text: message }] });
			};
			let confirmed: IntakeValues = {
				groupTerms: params.group_terms,
				yearFrom: params.year_from,
				yearTo: params.year_to,
				perSource: params.per_source,
			};
			if (ctx.hasUI) {
				const sources = params.sources?.length ? params.sources : Object.keys(SEARCHERS);
				const result = await intakeDialog(
					ctx,
					params.query,
					params.query_variants,
					sources,
					confirmed,
					diagnostics,
					signal,
				);
				if (result === null) {
					return {
						content: [{
							type: "text",
							text:
								"The user cancelled this discovery run in the intake dialog. No search was " +
								"performed. Ask the user what they want to change before searching again.",
						}],
						details: { diagnostics },
					};
				}
				confirmed = result;
			} else {
				diagnostics.push("intake dialog: skipped (no interactive UI)");
			}
			if (signal?.aborted) {
				diagnostics.push("run aborted before the search started");
				return {
					content: [{
						type: "text",
						text: "The discovery run was aborted before any search was performed.",
					}],
					details: { diagnostics },
				};
			}
			const payload = await runSearch({
				query: params.query,
				queryVariants: params.query_variants,
				perSource: confirmed.perSource,
				sources: params.sources,
				groupTerms: confirmed.groupTerms,
				filters: {
					minCites: params.min_cites,
					yearFrom: confirmed.yearFrom,
					yearTo: confirmed.yearTo,
					venues: params.venues,
					requirePdf: params.require_pdf,
					verifiedOnly: params.verified_only,
				},
				sort: params.sort === "cites" || params.sort === "year" ? params.sort : undefined,
				enrich: params.enrich,
				onWarn: report,
				signal,
			});
			let htmlPath: string | null = null;
			let jsonPath: string | null = null;
			try {
				({ htmlPath, jsonPath } = writeRunOutputs(renderHtml(payload), payload, params.html_file));
				diagnostics.push(`wrote HTML rendering to ${htmlPath} and JSON copy to ${jsonPath}`);
			} catch (error) {
				diagnostics.push(`writing the output files failed: ${error instanceof Error ? error.message : error}`);
			}
			// Deliberately NOT the full payload: full citation JSON in a small
			// model's context gets re-typed and fabricated. Digest only; the
			// JSON sidecar path stays out of it too (field-tested: a small
			// model echoes it at the user, whom it does not concern).
			return {
				content: [{ type: "text", text: renderDigest(payload, htmlPath) }],
				details: { diagnostics },
			};
		},
	});
}
