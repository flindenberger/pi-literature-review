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
 * a blocking intake wizard with the user (see intakeWizard below; since
 * v29.1 the same rpiv-style one-overlay dialog as /lit-synth, opened on its
 * submit page so one Enter runs the proposal; a BARE /lit-search opens the
 * same wizard on its empty query tab instead -- the command owns the
 * dialog, no agent handoff) -- models reliably skip "ask the user first"
 * instructions, but they cannot skip a dialog that the tool itself puts
 * between them and the search.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { detectDialogLang, type DialogLang, type WizardStepDef } from "../src/dialog-state.ts";
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
import { chatLangDefault, installChatLangObserver, runWizard } from "./dialogs.ts";

const THOROUGH_PER_SOURCE = 15;
const INTAKE_WIDGET = "pi-literature-review-intake";

/** The user-adjustable subset of a discovery call. */
interface IntakeValues {
	query: string;
	groupTerms: string[][] | undefined;
	yearFrom: number | undefined;
	yearTo: number | undefined;
	perSource: number | undefined;
}

/** Intake wizard strings per dialog language (the dialogs follow the
 * chat's language, v27; shared observer in dialogs.ts). */
const SEARCH_TEXT: Record<DialogLang, {
	queryTab: string;
	queryTitle: string;
	groupTab: string;
	groupTitle: string;
	groupPlaceholder: string;
	yearTab: string;
	yearTitle: string;
	yearPlaceholder: string;
	depthTab: string;
	depthTitle: string;
	depthQuick: string;
	depthThorough: string;
	depthExhaustive: string;
	depthCustom: string;
	countTab: string;
	countTitle: string;
	countDisabled: string;
	note: (sources: string[], variants: number) => string;
	badYears: (spec: string) => string;
	badCount: (spec: string) => string;
	capped: string;
	noQuery: string;
}> = {
	de: {
		queryTab: "Suchanfrage",
		queryTitle: "Wonach suchen? (geht wörtlich an die Datenbanken; leeren = ursprüngliche Anfrage behalten)",
		groupTab: "Gruppierung",
		groupTitle: "Gruppierung: Gruppen mit AND, Begriffe darin mit OR -- markiert Treffer nur als on_target/adjacent, filtert nicht. Leer = ungruppiert.",
		groupPlaceholder: "z. B. (river OR fluvial) AND (sandbar)",
		yearTab: "Jahre",
		yearTitle: "Erscheinungsjahre (2015-2024, 2015- oder 2024). Leer = alle.",
		yearPlaceholder: "leer = alle Jahre",
		depthTab: "Tiefe",
		depthTitle: "Suchtiefe: Treffer je Quelle?",
		depthQuick: `Schnell (${DEFAULT_PER_SOURCE} je Quelle)`,
		depthThorough: `Gründlich (${THOROUGH_PER_SOURCE} je Quelle)`,
		depthExhaustive: `Erschöpfend (${MAX_PER_SOURCE} je Quelle)`,
		depthCustom: "Eigene Anzahl (nächster Reiter)",
		countTab: "Anzahl",
		countTitle: `Treffer je Quelle (1-${MAX_PER_SOURCE}; die Obergrenze ist Höflichkeit gegenüber den freien APIs)`,
		countDisabled: "Nur bei Tiefe 'Eigene Anzahl' relevant.",
		note: (sources, variants) =>
			`Quellen: ${sources.join(", ")}${variants ? ` · +${variants} Suchvariante(n) des Agenten` : ""}`,
		badYears: (spec) => `Jahresangabe "${spec}" nicht verstanden -- Vorschlag bleibt`,
		badCount: (spec) => `Anzahl "${spec}" nicht verstanden -- Vorschlag bleibt`,
		capped: `Auf ${MAX_PER_SOURCE} je Quelle gekappt (Höflichkeit gegenüber den freien APIs)`,
		noQuery: "Ohne Suchanfrage keine Suche -- nichts wurde gesucht.",
	},
	en: {
		queryTab: "Query",
		queryTitle: "What to search for? (sent to the databases verbatim; clear it to keep the original query)",
		groupTab: "Grouping",
		groupTitle: "Grouping: groups AND-linked, terms within a group OR-linked -- only LABELS results on_target/adjacent, does not narrow the search. Empty = ungrouped.",
		groupPlaceholder: "e.g. (river OR fluvial) AND (sandbar)",
		yearTab: "Years",
		yearTitle: "Publication years (2015-2024, 2015- or 2024). Empty = all.",
		yearPlaceholder: "empty = all years",
		depthTab: "Depth",
		depthTitle: "Search depth: results per source?",
		depthQuick: `Quick scan (${DEFAULT_PER_SOURCE} per source)`,
		depthThorough: `Thorough (${THOROUGH_PER_SOURCE} per source)`,
		depthExhaustive: `Exhaustive (${MAX_PER_SOURCE} per source)`,
		depthCustom: "Custom count (next tab)",
		countTab: "Count",
		countTitle: `Results per source (1-${MAX_PER_SOURCE}; the cap is politeness towards the free APIs)`,
		countDisabled: "Only applies with depth 'Custom count'.",
		note: (sources, variants) =>
			`Sources: ${sources.join(", ")}${variants ? ` · +${variants} agent query variant(s)` : ""}`,
		badYears: (spec) => `Year range "${spec}" not understood -- keeping the proposal`,
		badCount: (spec) => `Count "${spec}" not understood -- keeping the proposal`,
		capped: `Capped at ${MAX_PER_SOURCE} per source (politeness towards the free APIs)`,
		noQuery: "No query, no search -- nothing was searched.",
	},
};

/**
 * Code-enforced intake: a blocking dialog the MODEL cannot skip or answer.
 * Three field tests (2x Granite, 1x Gemini, 2026-07-10) proved that a
 * description-level instruction to ask intake questions gets ignored or
 * rationalized away; this gate runs on EVERY call (user decision). Since
 * v29.1 it is the ONE rpiv-style wizard (same look as /lit-synth): with a
 * proposed query it opens ON its submit page -- the review lists query,
 * grouping, years and depth, one Enter runs the proposal (the old "Run as
 * proposed" ergonomics), arrow keys walk into the tabs to adjust, the
 * QUERY itself is editable there too. WITHOUT a query (bare /lit-search)
 * it opens on the empty query tab; a still-empty query at submit cancels
 * honestly. Esc cancels the run before any network call. Values are
 * WYSIWYG: what a tab shows at submit time is what runs (clearing the
 * grouping means ungrouped, clearing the years means all years).
 */
async function intakeWizard(
	ctx: ExtensionContext,
	query: string,
	queryVariants: string[] | undefined,
	sources: string[],
	proposed: Omit<IntakeValues, "query">,
	diagnostics: string[],
	signal: AbortSignal | undefined,
): Promise<IntakeValues | null> {
	const lang = detectDialogLang([query], chatLangDefault());
	const text = SEARCH_TEXT[lang];
	const proposedDepth = proposed.perSource ?? DEFAULT_PER_SOURCE;
	const depthInitial = proposed.perSource === undefined || proposed.perSource === DEFAULT_PER_SOURCE ? "quick"
		: proposed.perSource === THOROUGH_PER_SOURCE ? "thorough"
		: proposed.perSource === MAX_PER_SOURCE ? "exhaustive"
		: "custom";
	const yearInitial = yearRangeToSpec(proposed.yearFrom, proposed.yearTo);
	const steps: WizardStepDef[] = [
		{ kind: "text", id: "query", tab: text.queryTab, title: text.queryTitle, initial: query },
		{
			kind: "text", id: "groups", tab: text.groupTab, title: text.groupTitle,
			placeholder: text.groupPlaceholder,
			...(proposed.groupTerms?.length ? { initial: formatGroupExpression(proposed.groupTerms) } : {}),
		},
		{
			kind: "text", id: "years", tab: text.yearTab, title: text.yearTitle,
			placeholder: text.yearPlaceholder,
			...(yearInitial ? { initial: yearInitial } : {}),
		},
		{
			kind: "choice", id: "depth", tab: text.depthTab, title: text.depthTitle,
			options: [
				{ value: "quick", label: text.depthQuick },
				{ value: "thorough", label: text.depthThorough },
				{ value: "exhaustive", label: text.depthExhaustive },
				{ value: "custom", label: text.depthCustom },
			],
			initial: depthInitial,
			// The proposal IS the answer here -- the wizard opens on the
			// submit page and one Enter must run it (old dialog parity).
			initialIsAnswer: true,
		},
		{
			kind: "text", id: "count", tab: text.countTab, title: text.countTitle,
			initial: String(proposedDepth),
			enabledIf: (answers) => answers.depth === "custom",
			disabledNote: text.countDisabled,
		},
	];
	const result = await runWizard(ctx, steps, signal, {
		lang,
		// A proposed query is CONFIRMED (review page first, one Enter runs
		// it); a bare call has nothing to confirm and starts on the query tab.
		...(query.trim() ? { startTab: "submit" as const } : {}),
		submitNote: () => text.note(sources, queryVariants?.length ?? 0),
	});
	if (result === null) {
		diagnostics.push("intake dialog: cancelled by the user");
		return null;
	}
	const values: IntakeValues = { ...proposed, query };
	const editedQuery = typeof result.query === "string" ? result.query.trim() : "";
	if (editedQuery) values.query = editedQuery;
	if (!values.query.trim()) {
		// Bare call submitted without typing a query: nothing to search.
		ctx.ui.notify(text.noQuery, "warning");
		diagnostics.push("intake dialog: submitted without a query");
		return null;
	}
	const groupSpec = typeof result.groups === "string" ? result.groups.trim() : "";
	const groups = !groupSpec || groupSpec.toLowerCase() === "none" ? [] : parseGroupSpec(groupSpec);
	values.groupTerms = groups.length ? groups : undefined;
	const yearSpec = typeof result.years === "string" ? result.years.trim() : "";
	if (!yearSpec || ["all", "alle"].includes(yearSpec.toLowerCase())) {
		values.yearFrom = undefined;
		values.yearTo = undefined;
	} else {
		const range = parseYearRange(yearSpec);
		if (range === null) {
			ctx.ui.notify(text.badYears(yearSpec), "warning");
		} else {
			values.yearFrom = range.yearFrom;
			values.yearTo = range.yearTo;
		}
	}
	if (result.depth === "quick") values.perSource = DEFAULT_PER_SOURCE;
	else if (result.depth === "thorough") values.perSource = THOROUGH_PER_SOURCE;
	else if (result.depth === "exhaustive") values.perSource = MAX_PER_SOURCE;
	else if (result.depth === "custom") {
		const countSpec = typeof result.count === "string" ? result.count.trim() : "";
		const count = parsePerSource(countSpec, MAX_PER_SOURCE);
		if (count === null) {
			ctx.ui.notify(text.badCount(countSpec), "warning");
		} else {
			if (String(count) !== countSpec) ctx.ui.notify(text.capped, "info");
			values.perSource = count;
		}
	}
	diagnostics.push(
		values.query === query
			? "intake dialog: confirmed"
			: "intake dialog: confirmed, query edited by the user",
	);
	return values;
}

export default function literatureSearch(pi: ExtensionAPI) {
	// Shared chat-language observer (dialogs.ts): the intake wizard opens
	// in the language of the user's recent plain chat input.
	installChatLangObserver(pi);
	pi.registerTool({
		name: "pi-literature-search",
		label: "Literature Search",
		description:
			"Search academic literature (arXiv, CrossRef, OpenAlex): clean, deduplicated, HTTP-verified results, " +
			"written to disk by fixed code. " +
			"This tool DISCOVERS NEW papers in online databases. It is NOT for papers already on disk: when the " +
			"user wants to chat about, ask about or understand ONE local PDF ('zu einem Paper chatten', 'Frage zum " +
			"Paper'), use pi-literature-chat; for a summary or review across the local PDF library, use " +
			"pi-literature-synthesize; for downloading found papers, use pi-literature-fetch. " +
			"Call this tool DIRECTLY; do NOT ask intake or clarification questions in chat first. On every call the " +
			"tool itself shows the user a terminal wizard summarizing the proposed query (editable there -- the " +
			"user's wording wins), grouping logic, year range and search depth, where the user confirms or adjusts " +
			"everything before the search runs. Your job is only to propose sensible parameters. If the result says " +
			"the user cancelled the dialog, ask what they want to change; do not retry unchanged. " +
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
				query: params.query,
				groupTerms: params.group_terms,
				yearFrom: params.year_from,
				yearTo: params.year_to,
				perSource: params.per_source,
			};
			if (ctx.hasUI) {
				const sources = params.sources?.length ? params.sources : Object.keys(SEARCHERS);
				const result = await intakeWizard(
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
				query: confirmed.query,
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

	// /lit-search -- the agent-free path. Runs the SAME intake wizard and
	// deterministic pipeline as the tool, with no agent model deciding
	// whether or how to search. Bare /lit-search opens the wizard on its
	// empty query tab (v29.1 user decision: the command owns the dialog --
	// the earlier agent handoff is gone); with a query it opens on the
	// review page, one Enter runs.
	pi.registerCommand("lit-search", {
		description:
			"Discover literature online: /lit-search [query] opens the intake wizard (query, grouping, "
			+ "years, depth) and runs the pipeline agent-free (verified HTML/JSON, digest).",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const query = (args ?? "").trim();
			const diagnostics: string[] = [];
			const progress = (message: string) => ctx.ui.notify(message, "info");
			const sources = Object.keys(SEARCHERS);
			const confirmed = await intakeWizard(
				ctx,
				query,
				undefined,
				sources,
				{ groupTerms: undefined, yearFrom: undefined, yearTo: undefined, perSource: undefined },
				diagnostics,
				ctx.signal,
			);
			if (confirmed === null) {
				ctx.ui.notify("Search cancelled -- nothing was searched.", "info");
				return;
			}
			if (ctx.signal?.aborted) return;
			try {
				const payload = await runSearch({
					query: confirmed.query,
					perSource: confirmed.perSource,
					groupTerms: confirmed.groupTerms,
					filters: { yearFrom: confirmed.yearFrom, yearTo: confirmed.yearTo },
					onWarn: progress,
					signal: ctx.signal,
				});
				let htmlPath: string | null = null;
				try {
					({ htmlPath } = writeRunOutputs(renderHtml(payload), payload, undefined));
				} catch (error) {
					ctx.ui.notify(
						`writing the output files failed: ${error instanceof Error ? error.message : error}`,
						"warning",
					);
				}
				if (htmlPath) ctx.ui.notify(`Results written to ${htmlPath}`, "info");
				// Show the digest in the widget: reliable and immediate. (An earlier
				// version used sendMessage with deliverAs:"nextTurn", which only
				// QUEUES the text for the next prompt, so it never rendered.) The
				// full results are in the HTML file the notify points at.
				const digestLines = renderDigest(payload, htmlPath).split("\n");
				ctx.ui.setWidget(INTAKE_WIDGET, digestLines.length > 16
					? [...digestLines.slice(0, 15), `... (${digestLines.length - 15} more lines -- full results in the HTML)`]
					: digestLines);
			} catch (error) {
				ctx.ui.notify(`Search failed: ${error instanceof Error ? error.message : error}`, "error");
			}
		},
	});
}
