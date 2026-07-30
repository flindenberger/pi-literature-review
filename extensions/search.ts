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
 * v29.1 the same rpiv-style one-overlay dialog as /lit-synthesis; since
 * 2026-07-30 it ALWAYS starts on the query tab -- a proposal arrives as
 * prefill and the user walks the tabs; a BARE /lit-search starts there
 * with an empty query -- the command owns the dialog, no agent handoff)
 * -- models reliably skip "ask the user first" instructions, but they
 * cannot skip a dialog that the tool itself puts between them and the
 * search.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { detectDialogLang, type DialogLang, type WizardAnswers, type WizardStepDef } from "../src/dialog-state.ts";
import { renderDigest } from "../src/digest.ts";
import { DEFAULT_PER_SOURCE, MAX_PER_SOURCE, runSearch, SEARCHERS } from "../src/search.ts";
import {
	deriveCoreGroupsFromQuery,
	deriveGroupsFromQuery,
	formatGroupExpression,
	parseGroupSpec,
	parsePerSource,
	parseYearRange,
	yearRangeToSpec,
} from "../src/intake.ts";
import { writeRunOutputs } from "../src/output.ts";
import { renderHtml } from "../src/render.ts";
import { fetchAuthorMetrics, fetchJournalScores } from "../src/enrich.ts";
import { authorFacets, type FacetScope, journalFacets } from "../src/sources/openalex.ts";
import { chatLangDefault, installChatLangObserver, runWizard } from "./dialogs.ts";

const THOROUGH_PER_SOURCE = 15;
/** How many journals the in-tab list shows (the facet query returns up to
 * 200; a wizard tab wants the meaningful head, footprint-friendly).
 * Declared before SEARCH_TEXT, whose strings quote it. */
const JOURNAL_PICK_LIMIT = 12;
/** Sentinel id of the catch-all row under the listed journals (v30.11).
 * Journal ids are their NAMES, so this cannot collide with one; the row's
 * visible label comes from SEARCH_TEXT.journalOther. */
const JOURNAL_OTHER_ID = "__other_journals__";
/** The same for the author list (v30.11): the top authors carrying results
 * for this query, with a catch-all row underneath. */
const AUTHOR_PICK_LIMIT = 12;
const AUTHOR_OTHER_ID = "__other_authors__";
const INTAKE_WIDGET = "pi-literature-review-intake";
/** Transcript entry type for the /lit-search digest card (v30.3: the
 * 16-line widget truncated real result lists in the field -- the same
 * lesson as the v27 report cards; entries scroll, widgets do not). */
const DIGEST_ENTRY = "pi-literature-search-digest";
let digestEntryReady = false;

/** The user-adjustable subset of a discovery call. */
interface IntakeValues {
	query: string;
	groupTerms: string[][] | undefined;
	/** on_target needs only this many groups (undefined: all) -- the wide
	 * "concept pairs" variant (v30.3). */
	groupRequire?: number | undefined;
	yearFrom: number | undefined;
	yearTo: number | undefined;
	perSource: number | undefined;
	minCites: number | undefined;
	minJournalScore: number | undefined;
	venues: string[] | undefined;
	/** v30.11: the "Other journals/sources" row of the picker was checked --
	 * journals outside the listed head pass too (see ResultFilters). */
	venuesOther?: boolean;
	/** The journal names the picker listed, so "other" knows what it is
	 * other THAN. Only meaningful together with venuesOther. */
	venuesListed?: string[];
	authors: string[] | undefined;
	/** v30.11: the author picker's "other authors" row was checked. */
	authorsOther?: boolean;
	/** The author names the picker listed (see venuesListed). */
	authorsListed?: string[];
}

/** Intake wizard strings per dialog language (the dialogs follow the
 * chat's language, v27; shared observer in dialogs.ts; English default
 * v30). Wording is deliberately sober -- scholarly tool, no chattiness. */
const SEARCH_TEXT: Record<DialogLang, {
	/** Line above the tab bar: which dialog this is (v30.12). */
	header: string;
	queryTab: string;
	queryTitle: string;
	queryPlaceholder: string;
	groupTab: string;
	groupTitle: string;
	groupStrict: string;
	groupCore: string;
	groupPairs: string;
	groupPairsPrefix: string;
	groupAgent: string;
	groupCustom: string;
	groupEmpty: string;
	periodTab: string;
	periodTitle: string;
	periodLast: (n: number) => string;
	periodAll: string;
	periodCustom: string;
	countTab: string;
	countTitle: string;
	countDefault: string;
	countMax: string;
	countCustom: string;
	journalTab: string;
	journalTitle: string;
	journalSelectAll: string;
	journalNext: string;
	/** List entry suffix: hit count plus the OpenAlex 2-yr citedness when
	 * the journal has one (v30.8 user wish: the rate in parentheses; the
	 * rate arrives pre-formatted with one decimal -- "3.0", never "3"). */
	journalItem: (count: number, score: string | undefined) => string;
	/** The catch-all row under the listed journals (v30.11): everything the
	 * top-N list does not show, so checking every row = no filter. */
	journalOther: string;
	authorTab: string;
	authorTitle: string;
	authorSelectAll: string;
	/** List entry suffix: hits for THIS query plus the author's OpenAlex
	 * totals (citations, h-index) where the API has them (v30.11). */
	authorItem: (count: number, metrics: { cites?: number; hIndex?: number }) => string;
	authorOther: string;
	authorLoading: string;
	authorNoneFound: string;
	authorFetchFailed: (message: string) => string;
	journalLoading: string;
	journalIdle: string;
	journalNoneFound: string;
	journalFetchFailed: (message: string) => string;
	filterTab: string;
	filterTitle: string;
	minCitesLabel: string;
	authorsLabel: string;
	note: (sources: string[], variants: number) => string;
	badYears: (spec: string) => string;
	badCount: (spec: string) => string;
	badNumber: (label: string, spec: string) => string;
	capped: string;
	noQuery: string;
}> = {
	de: {
		header: "/lit-search -- Literatursuche (Esc bricht ab)",
		queryTab: "Suchanfrage",
		queryTitle: "Bitte formuliere eine Suchanfrage.",
		queryPlaceholder: "z. B. sandbar detection rivers Sentinel-2",
		groupTab: "Gruppierung",
		groupTitle: "Thematische Etikettierung der Treffer (on_target/adjacent) -- sie schränkt die Suche nicht ein. "
			+ "Gruppen sind AND-verknüpft, Synonyme innerhalb einer Gruppe mit OR.",
		groupStrict: "Volle Übereinstimmung (streng)",
		groupCore: "Kern-Übereinstimmung (breiter)",
		groupPairs: "Teil-Übereinstimmung (weit)",
		groupPairsPrefix: "mind. 2 gemeinsam von: ",
		groupAgent: "Vorschlag des Agenten",
		groupCustom: "Eigene Übereinstimmung:",
		groupEmpty: "(keine Begriffe ableitbar)",
		periodTab: "Suchzeitraum",
		periodTitle: "Erscheinungszeitraum?",
		periodLast: (n) => `Letzte ${n} Jahre`,
		periodAll: "Alle Jahre",
		periodCustom: "Eigener Zeitraum:",
		countTab: "Treffer",
		countTitle: "Wie viele Treffer je Quelle (arXiv, CrossRef, OpenAlex)?",
		countDefault: `${DEFAULT_PER_SOURCE} (Standard)`,
		countMax: `${MAX_PER_SOURCE} (Limit)`,
		countCustom: "Eigene Anzahl:",
		journalTab: "Journals",
		journalTitle: `Journal-Filter (optional): die Top-${JOURNAL_PICK_LIMIT}-Journals zu dieser Suchanfrage `
			+ "im gewählten Zeitraum (OpenAlex), darunter alle übrigen als eine Zeile. Nichts ausgewählt = "
			+ "kein Filter, alles ausgewählt = ebenfalls kein Filter.",
		journalSelectAll: "Alle auswählen (kein Filter)",
		journalNext: "Weiter",
		journalItem: (count, score) =>
			`(${count} Treffer${score !== undefined ? ` · 2-Jahres-Rate ${score}` : ""})`,
		journalOther: "Andere Journals/Quellen (hier nicht gelistet)",
		authorTab: "Autoren",
		authorTitle: `Autorenfilter (optional): die Top-${AUTHOR_PICK_LIMIT}-Autoren zu Suchanfrage, Zeitraum `
			+ "und Journal-Auswahl (OpenAlex), darunter alle übrigen als eine Zeile. Ausgewählte Namen fließen "
			+ "direkt in die Quellen-Suche ein (die Suche holt dann Papers DIESER Personen zum Thema). Zitationen "
			+ "und h-Index gelten für das GESAMTE Werk der Person, nicht für diese Treffer. Nichts oder alles "
			+ "ausgewählt = kein Filter.",
		authorSelectAll: "Alle auswählen (kein Filter)",
		authorItem: (count, metrics) =>
			`(${count} Treffer${metrics.cites !== undefined ? ` · ${metrics.cites} Zitationen` : ""}`
			+ `${metrics.hIndex !== undefined ? ` · h-Index ${metrics.hIndex}` : ""})`,
		authorOther: "Andere Autorinnen und Autoren (hier nicht gelistet)",
		authorLoading: "(hole Autorenliste von OpenAlex ...)",
		authorNoneFound: "(keine Autoren zu dieser Suchanfrage gefunden)",
		authorFetchFailed: (message) => `(Autorenliste nicht abrufbar: ${message})`,
		journalLoading: "(hole Journal-Liste von OpenAlex ...)",
		journalIdle: "(wartet auf eine Suchanfrage)",
		journalNoneFound: "(keine Journals zu dieser Suchanfrage gefunden)",
		journalFetchFailed: (message) => `(Journal-Liste nicht abrufbar: ${message})`,
		filterTab: "Filter",
		filterTitle: "Optionale Filter (leer = aus).",
		minCitesLabel: "Mindestzitationen",
		authorsLabel: "Autor (Name enthält)",
		note: (sources, variants) =>
			`Quellen: ${sources.join(", ")}${variants ? ` · +${variants} Suchvariante(n) des Agenten` : ""}`,
		badYears: (spec) => `Jahresangabe "${spec}" nicht verstanden -- Vorschlag bleibt`,
		badCount: (spec) => `Anzahl "${spec}" nicht verstanden -- Vorschlag bleibt`,
		badNumber: (label, spec) => `${label}: "${spec}" nicht verstanden -- Filter bleibt aus`,
		capped: `Auf ${MAX_PER_SOURCE} je Quelle gekappt (Rücksicht auf die freien APIs)`,
		noQuery: "Ohne Suchanfrage keine Suche -- nichts wurde gesucht.",
	},
	en: {
		header: "/lit-search -- literature search (Esc cancels)",
		queryTab: "Query",
		queryTitle: "Please formulate a search query.",
		queryPlaceholder: "e.g. sandbar detection rivers Sentinel-2",
		groupTab: "Grouping",
		groupTitle: "Thematic labeling of the results (on_target/adjacent) -- it does not narrow the search. "
			+ "Groups are AND-linked, synonyms within a group OR-linked.",
		groupStrict: "Full match (strict)",
		groupCore: "Core match (broader)",
		groupPairs: "Partial match (wide)",
		groupPairsPrefix: "any 2 together of: ",
		groupAgent: "Agent proposal",
		groupCustom: "Custom match:",
		groupEmpty: "(no terms derivable)",
		periodTab: "Search Period",
		periodTitle: "Publication period?",
		periodLast: (n) => `Last ${n} years`,
		periodAll: "All years",
		periodCustom: "Custom range:",
		countTab: "Records",
		countTitle: "How many records per source (arXiv, CrossRef, OpenAlex)?",
		countDefault: `${DEFAULT_PER_SOURCE} (default)`,
		countMax: `${MAX_PER_SOURCE} (limit)`,
		countCustom: "Custom count:",
		journalTab: "Journals",
		journalTitle: `Journal filter (optional): the top ${JOURNAL_PICK_LIMIT} journals for this query `
			+ "within the chosen period (OpenAlex), with everything else as one row below them. Nothing "
			+ "selected = no filter, everything selected = no filter either.",
		journalSelectAll: "Select all (no filter)",
		journalNext: "Next",
		journalItem: (count, score) =>
			`(${count} hits${score !== undefined ? ` · 2-yr rate ${score}` : ""})`,
		journalOther: "Other journals/sources (not listed here)",
		authorTab: "Authors",
		authorTitle: `Author filter (optional): the top ${AUTHOR_PICK_LIMIT} authors for this query, period `
			+ "and journal selection (OpenAlex), with everyone else as one row below them. Picked names feed "
			+ "directly into the source queries (the search then fetches THESE authors' papers on the topic). "
			+ "Citations and h-index cover the author's ENTIRE work, not these records. Nothing or everything "
			+ "selected = no filter.",
		authorSelectAll: "Select all (no filter)",
		authorItem: (count, metrics) =>
			`(${count} hits${metrics.cites !== undefined ? ` · ${metrics.cites} citations` : ""}`
			+ `${metrics.hIndex !== undefined ? ` · h-index ${metrics.hIndex}` : ""})`,
		authorOther: "Other authors (not listed here)",
		authorLoading: "(fetching author list from OpenAlex ...)",
		authorNoneFound: "(no authors found for this query)",
		authorFetchFailed: (message) => `(author list not reachable: ${message})`,
		journalLoading: "(fetching journal list from OpenAlex ...)",
		journalIdle: "(waiting for a search query)",
		journalNoneFound: "(no journals found for this query)",
		journalFetchFailed: (message) => `(journal list not reachable: ${message})`,
		filterTab: "Filters",
		filterTitle: "Optional filters (empty = off).",
		minCitesLabel: "Min. citations",
		authorsLabel: "Author name (substring)",
		note: (sources, variants) =>
			`Sources: ${sources.join(", ")}${variants ? ` · +${variants} agent query variant(s)` : ""}`,
		badYears: (spec) => `Year range "${spec}" not understood -- keeping the proposal`,
		badCount: (spec) => `Count "${spec}" not understood -- keeping the proposal`,
		badNumber: (label, spec) => `${label}: "${spec}" not understood -- filter stays off`,
		capped: `Capped at ${MAX_PER_SOURCE} per source (consideration for the free APIs)`,
		noQuery: "No query, no search -- nothing was searched.",
	},
};

/** Year inputs meaning "no limit" (the prefilled all-years wording in both
 * languages plus the short forms). */
const ALL_YEARS_TOKENS = new Set([
	"all", "alle", "all years", "alle jahre", "gesamter zeitraum", "entire period",
]);

/**
 * Resolve the period tab's answer (preset key, all-years wording or a
 * custom range) into a year range. Null means an unparseable custom spec:
 * the submit mapping warns and keeps the proposal; the facet loaders
 * silently scope by nothing. Shared so the pickers and the run itself
 * always agree on what the chosen period means (v30.13).
 */
function periodToRange(raw: unknown): { yearFrom?: number; yearTo?: number } | null {
	const spec = typeof raw === "string" ? raw.trim() : "";
	const thisYear = new Date().getFullYear();
	const lastYears: Record<string, number> = { "5y": 4, "10y": 9, "20y": 19 };
	if (spec in lastYears) return { yearFrom: thisYear - lastYears[spec] };
	if (!spec || spec === "all" || ALL_YEARS_TOKENS.has(spec.toLowerCase())) return {};
	return parseYearRange(spec);
}

/**
 * Code-enforced intake: a blocking dialog the MODEL cannot skip or answer.
 * Three field tests (2x Granite, 1x Gemini, 2026-07-10) proved that a
 * description-level instruction to ask intake questions gets ignored or
 * rationalized away; this gate runs on EVERY call (user decision). Since
 * v29.1 it is the ONE rpiv-style wizard (same look as /lit-synthesis). It
 * ALWAYS starts on the query tab (user decision 2026-07-30, revising the
 * v29.1 review-page-first ergonomics: the jump to the submit page
 * confused the first-time flow): a proposed query arrives as PREFILL,
 * the user walks the tabs to the submit page; bare /lit-search starts
 * the same way with an empty query. Esc cancels
 * the run before any network call. Values are WYSIWYG: what a tab shows
 * at submit time is what runs -- clearing the grouping means ungrouped,
 * clearing the years means all years, and an empty query at submit
 * cancels honestly on EVERY path (v30; the silent fallback to the
 * proposal is gone). The grouping tab derives its expression live from
 * the query (deriveGroupsFromQuery) until the user edits it; the count
 * tab carries the presets plus an inline custom row; the filter tab
 * (min citations, min journal score, journal names) is strictly opt-in.
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
	const yearInitial = yearRangeToSpec(proposed.yearFrom, proposed.yearTo);
	// Grouping variant expressions, derived from the LIVE query text (the
	// option descriptions and the custom seed re-render as the user types).
	const strictExpression = (answers: WizardAnswers): string =>
		formatGroupExpression(deriveGroupsFromQuery(String(answers.query ?? "")));
	const coreExpression = (answers: WizardAnswers): string =>
		formatGroupExpression(deriveCoreGroupsFromQuery(String(answers.query ?? "")));
	// The wide variant: on_target when any TWO core concepts co-occur.
	// Up to three concepts the description spells out the OR-of-pairs form
	// the user asked for; beyond that it stays readable as "any 2 of".
	const pairsExpression = (answers: WizardAnswers): string => {
		const names = deriveCoreGroupsFromQuery(String(answers.query ?? "")).map((group) => group[0]);
		if (names.length < 2) return "";
		if (names.length <= 3) {
			const pairs: string[] = [];
			for (let i = 0; i < names.length; i++) {
				for (let j = i + 1; j < names.length; j++) pairs.push(`(${names[i]} AND ${names[j]})`);
			}
			return pairs.join(" OR ");
		}
		return `${text.groupPairsPrefix}${names.join(" · ")}`;
	};
	const thisYear = new Date().getFullYear();
	// Filled by the journal itemLoader below; the submit mapping needs to
	// know which journals the list actually showed (v30.11), and the author
	// loader needs their OpenAlex source ids to scope its facet (v30.13).
	let listedJournals: string[] = [];
	let listedJournalIds = new Map<string, string>();
	let listedAuthors: string[] = [];
	// Facet scope from the LIVE answers (v30.13 field finding: lists built
	// from the query text alone showed journals/authors the configured run
	// could never return). Both parts feed the loader cache keys, so editing
	// the period or the journal picks re-fetches on the next tab visit.
	const liveYearScope = (answers: WizardAnswers): FacetScope => periodToRange(answers.period) ?? {};
	const livePickedSourceIds = (answers: WizardAnswers): string[] => {
		const picked = Array.isArray(answers.journals) ? (answers.journals as string[]) : [];
		// The "other journals" row means "these OR anything unlisted" -- that
		// is nearly everything, so it scopes nothing.
		if (!picked.length || picked.includes(JOURNAL_OTHER_ID)) return [];
		return picked
			.map((name) => listedJournalIds.get(name))
			.filter((id): id is string => !!id);
	};
	const scopeKey = (scope: FacetScope): string =>
		`${scope.yearFrom ?? ""}:${scope.yearTo ?? ""}:${(scope.sourceIds ?? []).join("|")}`;
	const steps: WizardStepDef[] = [
		{
			kind: "text", id: "query", tab: text.queryTab, title: text.queryTitle, plain: true,
			placeholder: text.queryPlaceholder,
			...(query.trim() ? { initial: query } : {}),
		},
		{
			// Grouping VARIANTS to pick from (v30.2 user wish), all derived
			// deterministically from the LIVE query text; the last row is a
			// custom expression, seeded with the strict derivation and owned
			// by the user from the first keystroke. An agent proposal joins
			// as its own option and is preselected.
			kind: "choice", id: "groups", tab: text.groupTab, title: text.groupTitle,
			// The EXPRESSION is the main (white) row, the variant name the
			// dim line below it (v30.5 user decision -- the expression is
			// what one actually picks between).
			options: [
				{
					value: "strict",
					label: (answers) => strictExpression(answers) || text.groupEmpty,
					description: text.groupStrict,
				},
				{
					value: "core",
					label: (answers) => coreExpression(answers) || text.groupEmpty,
					description: text.groupCore,
				},
				{
					value: "pairs",
					label: (answers) => pairsExpression(answers) || text.groupEmpty,
					description: text.groupPairs,
				},
				...(proposed.groupTerms?.length
					? [{
						value: "agent",
						label: formatGroupExpression(proposed.groupTerms),
						description: text.groupAgent,
					}]
					: []),
				{ value: "custom", label: text.groupCustom, freeText: true },
			],
			customSeed: (answers) => strictExpression(answers),
			initial: proposed.groupTerms?.length ? "agent" : "strict",
			...(query.trim() ? { initialIsAnswer: true } : {}),
		},
		{
			// Search period as a menu (v30.3 user wish): last 5/10/20 years
			// with the resolved range as the dim line, all years, or a custom
			// range (2015-2024, 2015- or 2024). Bare calls recommend "last 5
			// years"; the proposal path defaults to all years unless the
			// agent proposed a range (which seeds the custom row).
			kind: "choice", id: "period", tab: text.periodTab, title: text.periodTitle,
			options: [
				{ value: "5y", label: text.periodLast(5), description: `${thisYear - 4}-${thisYear}` },
				{ value: "10y", label: text.periodLast(10), description: `${thisYear - 9}-${thisYear}` },
				{ value: "20y", label: text.periodLast(20), description: `${thisYear - 19}-${thisYear}` },
				{ value: "all", label: text.periodAll, description: `≤ ${thisYear}` },
				{ value: "custom", label: text.periodCustom, freeText: true },
			],
			initial: yearInitial || (query.trim() ? "all" : "5y"),
			...(query.trim() ? { initialIsAnswer: true } : {}),
		},
		{
			kind: "choice", id: "count", tab: text.countTab, title: text.countTitle,
			options: [
				{ value: String(DEFAULT_PER_SOURCE), label: text.countDefault },
				{ value: String(THOROUGH_PER_SOURCE), label: String(THOROUGH_PER_SOURCE) },
				{ value: String(MAX_PER_SOURCE), label: text.countMax },
				{ value: "custom", label: text.countCustom, freeText: true },
			],
			initial: String(proposedDepth),
			// On the proposal-confirm path the proposal IS the answer (one
			// Enter runs it); a bare call starts genuinely unanswered (v30
			// field complaint: no pre-set check marks).
			...(query.trim() ? { initialIsAnswer: true } : {}),
		},
		{
			// Journal filter (v30.7): the top journals for this query load
			// INTO the tab (one OpenAlex facet query, fired by the adapter
			// when the tab is reached -- see itemLoader below); an empty
			// selection means no filter, so Enter-through stays one stroke.
			// Typed name substrings (and an agent venues proposal) live in
			// the filter form's journal-names field.
			kind: "checkbox", id: "journals", tab: text.journalTab, title: text.journalTitle,
			items: [], selectAllLabel: text.journalSelectAll, nextLabel: text.journalNext,
			optional: true, emptyNote: text.journalLoading,
		},
		{
			// Author filter (v30.11 user wish "neben dem Namen auch die Zahl
			// der Zitationen"): the same mechanics as the journal tab -- the
			// top authors for this query load into the tab, each row carrying
			// its hits plus the author's open OpenAlex metrics (total
			// citations, h-index). A typed name in the Filters tab still
			// works for anyone outside this head.
			kind: "checkbox", id: "author_pick", tab: text.authorTab, title: text.authorTitle,
			items: [], selectAllLabel: text.authorSelectAll, nextLabel: text.journalNext,
			optional: true, emptyNote: text.authorLoading,
		},
		{
			kind: "form", id: "filters", tab: text.filterTab, title: text.filterTitle,
			fields: [
				{
					id: "min_cites", label: text.minCitesLabel,
					...(proposed.minCites !== undefined ? { initial: String(proposed.minCites) } : {}),
				},
				{
					id: "authors", label: text.authorsLabel,
					...(proposed.authors?.length ? { initial: proposed.authors.join(", ") } : {}),
				},
			],
		},
	];
	const result = await runWizard(ctx, steps, signal, {
		lang,
		header: text.header,
		// The wizard ALWAYS starts on the query tab, proposal or not (user
		// decision 2026-07-30, revising v29.1's review-page-first: jumping
		// straight to the submit page confused the first-time flow; the
		// proposal stays as PREFILL, the user walks the tabs to submit).
		submitNote: () => text.note(sources, queryVariants?.length ?? 0),
		// The journal list loads when the tab is reached, keyed on the LIVE
		// query text (v30.7) -- one OpenAlex facet request plus one batched
		// score lookup (v30.8: hit count AND 2-yr citedness per entry),
		// adapter-driven. An agent venues proposal prechecks matching rows.
		itemLoaders: [{
			step: "journals",
			key: (answers) => `${String(answers.query ?? "").trim().toLowerCase()}|${scopeKey(liveYearScope(answers))}`,
			load: async (answers) => {
				const page = await journalFacets(
					String(answers.query ?? "").trim(), JOURNAL_PICK_LIMIT, liveYearScope(answers),
				);
				const scores = await fetchJournalScores(page.listed.map((facet) => facet.id), () => {});
				// Remember what the list SHOWED: the "other" row is defined
				// against exactly these names (v30.11); the ids scope the
				// author facet (v30.13).
				listedJournals = page.listed.map((facet) => facet.name);
				listedJournalIds = new Map(page.listed.map((facet) => [facet.name, facet.id]));
				const items = page.listed.map((facet) => {
					const score = scores.get(facet.id);
					// toFixed keeps the decimal on integers ("3.0", never "3").
					const rounded = score === undefined ? undefined : score.toFixed(1);
					return { id: facet.name, label: `${facet.name} ${text.journalItem(facet.count, rounded)}` };
				});
				// The catch-all row: checking everything is then genuinely "no
				// filter" (v30.11 user decision -- "all" must never exclude).
				return items.length
					? [...items, {
						id: JOURNAL_OTHER_ID,
						label: `${text.journalOther} ${text.journalItem(page.otherCount, undefined)}`,
					}]
					: items;
			},
			...(proposed.venues?.length
				? {
					preselect: (items: { id: string }[]) => items
						.filter((item) => proposed.venues?.some((venue) =>
							item.id.toLowerCase().includes(venue.trim().toLowerCase())))
						.map((item) => item.id),
				}
				: {}),
			loadingNote: text.journalLoading,
			idleNote: text.journalIdle,
			emptyNote: text.journalNoneFound,
			failedNote: text.journalFetchFailed,
		}, {
			// The author list (v30.11): one facet request over the query's
			// works plus one batched author lookup for the open metrics.
			// Scoped by the live period AND the picked journals (v30.13).
			step: "author_pick",
			key: (answers) => `${String(answers.query ?? "").trim().toLowerCase()}|${
				scopeKey({ ...liveYearScope(answers), sourceIds: livePickedSourceIds(answers) })}`,
			load: async (answers) => {
				const page = await authorFacets(String(answers.query ?? "").trim(), AUTHOR_PICK_LIMIT, {
					...liveYearScope(answers),
					sourceIds: livePickedSourceIds(answers),
				});
				const metrics = await fetchAuthorMetrics(page.listed.map((facet) => facet.id), () => {});
				listedAuthors = page.listed.map((facet) => facet.name);
				const items = page.listed.map((facet) => {
					const found = metrics.get(facet.id) ?? {};
					return {
						id: facet.name,
						label: `${facet.name} ${text.authorItem(facet.count, {
							...(found.cites !== undefined ? { cites: found.cites } : {}),
							...(found.hIndex !== undefined ? { hIndex: found.hIndex } : {}),
						})}`,
					};
				});
				return items.length
					? [...items, {
						id: AUTHOR_OTHER_ID,
						label: `${text.authorOther} ${text.authorItem(page.otherCount, {})}`,
					}]
					: items;
			},
			...(proposed.authors?.length
				? {
					preselect: (items: { id: string }[]) => items
						.filter((item) => proposed.authors?.some((author) =>
							item.id.toLowerCase().includes(author.trim().toLowerCase())))
						.map((item) => item.id),
				}
				: {}),
			loadingNote: text.authorLoading,
			idleNote: text.journalIdle,
			emptyNote: text.authorNoneFound,
			failedNote: text.authorFetchFailed,
		}],
	});
	if (result === null) {
		diagnostics.push("intake dialog: cancelled by the user");
		return null;
	}
	const values: IntakeValues = { ...proposed, query };
	// WYSIWYG (v30): the query the tab shows at submit is the query that
	// runs -- and an EMPTY query cancels honestly on every path (the old
	// silent fallback to the proposal is gone with its hint text).
	values.query = typeof result.query === "string" ? result.query.trim() : "";
	if (!values.query) {
		ctx.ui.notify(text.noQuery, "warning");
		diagnostics.push("intake dialog: submitted without a query");
		return null;
	}
	// The grouping step answers with a variant key or a custom expression
	// (v30.2). Variants are re-derived from the FINAL query text -- exactly
	// what the option description showed at submit time (WYSIWYG). "pairs"
	// (v30.3) keeps the core concepts but marks on_target when any TWO of
	// them co-occur (groupRequire).
	const groupSpec = typeof result.groups === "string" ? result.groups.trim() : "";
	const groups = groupSpec === "strict" ? deriveGroupsFromQuery(values.query)
		: groupSpec === "core" || groupSpec === "pairs" ? deriveCoreGroupsFromQuery(values.query)
		: groupSpec === "agent" ? proposed.groupTerms ?? []
		: !groupSpec || groupSpec.toLowerCase() === "none" ? []
		: parseGroupSpec(groupSpec);
	values.groupTerms = groups.length ? groups : undefined;
	values.groupRequire = groupSpec === "pairs" && groups.length > 2 ? 2 : undefined;
	// The period step answers with a preset key or a custom range spec; an
	// unparseable custom range keeps the proposal, loudly. Same resolution
	// the facet loaders used live (periodToRange), so the pickers and the
	// run agree on the period.
	const periodSpec = typeof result.period === "string" ? result.period.trim() : "";
	const range = periodToRange(periodSpec);
	if (range === null) {
		ctx.ui.notify(text.badYears(periodSpec), "warning");
	} else {
		values.yearFrom = range.yearFrom;
		values.yearTo = range.yearTo;
	}
	// The count step answers with a number string: a preset value or the
	// free-entry input of the "custom" row (v30 -- no separate count tab).
	const countSpec = typeof result.count === "string" ? result.count.trim() : "";
	if (countSpec) {
		const count = parsePerSource(countSpec, MAX_PER_SOURCE);
		if (count === null) {
			ctx.ui.notify(text.badCount(countSpec), "warning");
		} else {
			if (String(count) !== countSpec) ctx.ui.notify(text.capped, "info");
			values.perSource = count;
		}
	}
	// Optional filters, strictly opt-in: empty fields mean "no filter";
	// unparseable input stays off, loudly.
	const numberField = (raw: unknown, label: string, float: boolean): number | undefined => {
		const spec = typeof raw === "string" ? raw.trim() : "";
		if (!spec) return undefined;
		const pattern = float ? /^\d+(?:[.,]\d+)?$/ : /^\d+$/;
		if (!pattern.test(spec)) {
			ctx.ui.notify(text.badNumber(label, spec), "warning");
			return undefined;
		}
		return Number(spec.replace(",", "."));
	};
	values.minCites = numberField(result.min_cites, text.minCitesLabel, false);
	// The journal-score filter left the DIALOG in v30.9 (user decision);
	// WYSIWYG forbids silently applying an agent-passed value the wizard
	// never showed. The tool param keeps working on headless runs.
	values.minJournalScore = undefined;
	// Author filter (v30.9): any listed name substring may match any author.
	// v30.11: the Authors tab contributes picked names, plus its own
	// catch-all row -- typed names and picked names are the same kind of
	// wanted substring and simply merge (deduplicated, case-insensitive).
	const authorsSpec = typeof result.authors === "string" ? result.authors.trim() : "";
	const typedAuthors = authorsSpec.split(/[,;]/).map((name) => name.trim()).filter(Boolean);
	const pickedAuthorRows = Array.isArray(result.author_pick) ? (result.author_pick as string[]) : [];
	const pickedAuthorOther = pickedAuthorRows.includes(AUTHOR_OTHER_ID);
	const pickedAuthors = pickedAuthorRows.filter((name) => name !== AUTHOR_OTHER_ID);
	const wantedAuthors: string[] = [];
	for (const name of [...pickedAuthors, ...typedAuthors]) {
		if (!wantedAuthors.some((seen) => seen.toLowerCase() === name.toLowerCase())) wantedAuthors.push(name);
	}
	if (pickedAuthorOther && pickedAuthors.length >= listedAuthors.length && !typedAuthors.length) {
		// Every row checked -> no author filter at all.
		values.authors = undefined;
		values.authorsOther = undefined;
		values.authorsListed = undefined;
	} else if (pickedAuthorOther) {
		values.authors = wantedAuthors.length ? wantedAuthors : undefined;
		values.authorsOther = true;
		values.authorsListed = listedAuthors;
	} else {
		values.authors = wantedAuthors.length ? wantedAuthors : undefined;
		values.authorsOther = undefined;
		values.authorsListed = undefined;
	}
	// Journal filter: exactly what the tab shows checked (v30.8 -- the
	// typed-names form field is gone; an agent proposal arrives as
	// prechecked rows via the loader's preselect); empty = no filter.
	// v30.11: the list carries an explicit "other journals/sources" row --
	// with it checked, journals outside the list pass too, and checking
	// EVERY row is literally no filter (the select-all trap of v30.10 is
	// gone: "all" can no longer exclude anything).
	const pickedJournals = Array.isArray(result.journals) ? (result.journals as string[]) : [];
	const pickedOther = pickedJournals.includes(JOURNAL_OTHER_ID);
	const pickedNames = pickedJournals.filter((name) => name !== JOURNAL_OTHER_ID);
	if (pickedOther && pickedNames.length >= listedJournals.length) {
		// Everything checked -> no venue filter at all.
		values.venues = undefined;
		values.venuesOther = undefined;
		values.venuesListed = undefined;
	} else if (pickedOther) {
		values.venues = pickedNames.length ? pickedNames : undefined;
		values.venuesOther = true;
		values.venuesListed = listedJournals;
	} else {
		values.venues = pickedNames.length ? pickedNames : undefined;
		values.venuesOther = undefined;
		values.venuesListed = undefined;
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
	// Rich transcript rendering for the command-path digest (same pattern
	// as the synthesize answer cards). pi-tui exists only at pi runtime;
	// without it the capped widget stays the fallback.
	void (async () => {
		try {
			const { Box, Text } = await import("@earendil-works/pi-tui");
			pi.registerEntryRenderer(DIGEST_ENTRY, (entry, _state, theme) => {
				const data = entry.data as { heading: string; text: string };
				const box = new Box(1, 1, (line: string) => theme.bg("customMessageBg", line));
				box.addChild(new Text(theme.bold(data.heading)));
				for (const line of data.text.split("\n")) box.addChild(new Text(line));
				return box;
			});
			digestEntryReady = true;
		} catch {
			// pi-tui unavailable -> the capped widget fallback stays.
		}
	})();
	pi.registerTool({
		name: "pi-literature-search",
		label: "Literature Search",
		description:
			"Search academic literature (arXiv, CrossRef, OpenAlex): clean, deduplicated, HTTP-verified results, " +
			"written to disk by fixed code. " +
			"This tool DISCOVERS NEW papers in online databases. It is NOT for papers already on disk: when the " +
			"user wants to chat about, ask about or understand ONE local PDF ('zu einem Paper chatten', 'Frage zum " +
			"Paper'), use pi-literature-synthesis (chat mode); for a summary or review across the local PDF library, use " +
			"pi-literature-synthesis; for downloading found papers, use pi-literature-selection. " +
			"Call this tool DIRECTLY; do NOT ask intake or clarification questions in chat first. On every call the " +
			"tool itself shows the user a terminal wizard summarizing the proposed query (editable there -- the " +
			"user's wording wins), grouping logic, year range, result count and optional filters (min citations, " +
			"min journal score, journal names), where the user confirms or adjusts everything before the search " +
			"runs. Your job is only to propose sensible parameters. If the result says " +
			"the user cancelled the dialog, ask what they want to change; do not retry unchanged. " +
			"The tool result is a short digest only: counts, the HTML file path, and one reference line per record " +
			"(group flag, year, DOI/arXiv ID, title). Lines marked UNVERIFIED did not resolve at doi.org/arxiv.org; " +
			"treat them with suspicion and say so. Every run writes a deterministic HTML rendering (sortable table, " +
			"abstracts, links, dropped list) to pi-literature-review/lit-search/<date>_<query>.html in the working directory " +
			"(root overridable via PI_LITERATURE_REVIEW_HOME; exact path via html_file), plus a machine-readable .json " +
			"copy of the full results with the same basename - read that file for structured follow-up steps, but do " +
			"not mention its path to the user. The HTML file is where the user reviews and selects papers: tell them " +
			"its path. When you refer to a record, copy its digest line EXACTLY; never re-type, complete or invent " +
			"titles, authors, years or identifiers, never build your own results table, and never add key findings, " +
			"methodology advice, next steps or deliverables - this tool only discovers literature. " +
			"group_terms sort results into on_target/adjacent by deterministic word rules: a record is on_target when " +
			"at least one term from EVERY group appears in its title or abstract. PROPOSE group_terms on every call: " +
			"derive one group per required concept from the user's research question, each with OR synonyms, e.g. for " +
			'river sandbars via Sentinel: [["river","fluvial"],["sandbar","bar"],["sentinel","s-1","s-2"]]. The wizard ' +
			"shows your proposal as one selectable variant next to code-derived ones; the user picks. " +
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
			min_journal_score: Type.Optional(Type.Number({
				minimum: 0,
				description: "Keep only records whose journal 2-yr citedness (OpenAlex, an open JIF analog attached by enrichment) is at least this. Records WITHOUT a score (preprints, unmatched venues) still pass. Needs enrich (default on).",
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
			authors: Type.Optional(Type.Array(Type.String(), {
				description: "Fetch and keep only papers by these authors: the names are pushed into each source's author search field (arXiv au:, CrossRef query.author, OpenAlex raw_author_name.search), and a deterministic post-filter keeps only records where at least one author name contains one of these strings (case-insensitive). Use when the user asks for papers by a specific author or group.",
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
				description: "Override for the HTML output path. Default (recommended): omit, and the deterministic location pi-literature-review/lit-search/<date>_<query>.html in the working directory is used. The page is generated from the JSON payload by fixed code, never by a model.",
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
				minCites: params.min_cites,
				minJournalScore: params.min_journal_score,
				venues: params.venues,
				authors: params.authors,
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
				groupRequire: confirmed.groupRequire,
				filters: {
					minCites: confirmed.minCites,
					minJournalScore: confirmed.minJournalScore,
					yearFrom: confirmed.yearFrom,
					yearTo: confirmed.yearTo,
					venues: confirmed.venues,
					venuesOther: confirmed.venuesOther,
					venuesListed: confirmed.venuesListed,
					authors: confirmed.authors,
					authorsOther: confirmed.authorsOther,
					authorsListed: confirmed.authorsListed,
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
	// whether or how to search. The wizard always opens on the query tab
	// (v29.1: the command owns the dialog, no agent handoff; 2026-07-30:
	// a passed query is prefill, not a review-page jump).
	pi.registerCommand("lit-search", {
		description:
			"Discover literature online: /lit-search [query] opens the intake wizard (query, grouping, "
			+ "years, depth) and runs the pipeline agent-free (verified HTML/JSON, digest).",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const query = (args ?? "").trim();
			const diagnostics: string[] = [];
			// Non-TUI (web) clients render notifications as chat lines; the
			// per-record detail (dropped/enriched/filtered ...) would flood
			// the transcript there and is all in the HTML's dropped list
			// anyway -- only the summary milestones get through (webui-compat
			// round 3). The TUI keeps every line (transient status area).
			const progress = (message: string) => {
				if (ctx.mode !== "tui" && /^(dropped \[|enriched "|filtered: )/.test(message)) return;
				ctx.ui.notify(message, "info");
			};
			const sources = Object.keys(SEARCHERS);
			const confirmed = await intakeWizard(
				ctx,
				query,
				undefined,
				sources,
				{
					groupTerms: undefined, yearFrom: undefined, yearTo: undefined, perSource: undefined,
					minCites: undefined, minJournalScore: undefined, venues: undefined, authors: undefined,
				},
				diagnostics,
				ctx.signal,
			);
			if (confirmed === null) {
				ctx.ui.notify("Search cancelled -- nothing was searched.", "info");
				return;
			}
			if (ctx.signal?.aborted) return;
			// Sign of life (v30.9 field wish): pi's native working indicator
			// exists only while the AGENT streams (v22) -- the agent-free
			// command path shows an elapsed line in the widget instead.
			const startedAt = Date.now();
			const ticker = setInterval(() => {
				const seconds = Math.round((Date.now() - startedAt) / 1000);
				ctx.ui.setWidget(INTAKE_WIDGET, [`working -- ${seconds}s elapsed (searching, verifying, enriching)`]);
			}, 3000);
			try {
				const payload = await runSearch({
					query: confirmed.query,
					perSource: confirmed.perSource,
					groupTerms: confirmed.groupTerms,
					groupRequire: confirmed.groupRequire,
					filters: {
						yearFrom: confirmed.yearFrom,
						yearTo: confirmed.yearTo,
						minCites: confirmed.minCites,
						minJournalScore: confirmed.minJournalScore,
						venues: confirmed.venues,
						venuesOther: confirmed.venuesOther,
						venuesListed: confirmed.venuesListed,
						authors: confirmed.authors,
						authorsOther: confirmed.authorsOther,
						authorsListed: confirmed.authorsListed,
					},
					onWarn: progress,
					signal: ctx.signal,
				});
				clearInterval(ticker);
				ctx.ui.setWidget(INTAKE_WIDGET, undefined);
				let htmlPath: string | null = null;
				try {
					({ htmlPath } = writeRunOutputs(renderHtml(payload), payload, undefined));
				} catch (error) {
					ctx.ui.notify(
						`writing the output files failed: ${error instanceof Error ? error.message : error}`,
						"warning",
					);
				}
				if (htmlPath) {
					ctx.ui.notify(
						`Search finished: ${payload.results.length} record(s). Results written to ${htmlPath}`,
						"info",
					);
				}
				// Show the digest as a FULL transcript card (v30.3: the capped
				// widget truncated real result lists -- "widget truncated" was
				// a field complaint, not a policy; nothing is blocked). The
				// card scrolls with the chat and is not in the LLM context.
				// Widget fallback when pi-tui is unavailable. (An even earlier
				// version used sendMessage with deliverAs:"nextTurn", which
				// only QUEUES the text for the next prompt -- never rendered.)
				// Audience "user" (v30.13 field complaint: the card showed the
				// agent instructions "Tell the user to open the HTML ..." --
				// those belong in the tool result, not in front of the user).
				const digest = renderDigest(payload, htmlPath, "user");
				// The entry card renders via a pi-tui entry renderer -- that
				// exists only in TUI mode. RPC clients (web UIs) never paint
				// custom entries, so there the capped widget + the notify above
				// are the visible result (webui-compat, 2026-07-30).
				if (digestEntryReady && ctx.mode === "tui") {
					pi.appendEntry(DIGEST_ENTRY, {
						heading: `Literature search -- ${confirmed.query}`,
						text: digest,
					});
					ctx.ui.setWidget(INTAKE_WIDGET, undefined);
				} else {
					const digestLines = digest.split("\n");
					ctx.ui.setWidget(INTAKE_WIDGET, digestLines.length > 16
						? [...digestLines.slice(0, 15), `... (${digestLines.length - 15} more lines -- full results in the HTML)`]
						: digestLines);
					// Web clients render neither widgets nor entry cards, and
					// their notify toasts vanish after seconds -- but an AGENT
					// answer is a real session message that every client shows
					// and replays (fourth field round, the rpiv comparison:
					// its results reach the chat because they flow through an
					// agent TURN as tool results). So outside the TUI the
					// deterministic run ends by handing the finished digest to
					// the agent as its display layer. The SEARCH stays
					// agent-free; the agent only presents the result. (An OK
					// dialog tried before was rejected in the field as ugly.)
					// This deliberately does NOT run in TUI mode -- the entry
					// card is the display there, no LLM involved (v29.1).
					pi.sendMessage({
						customType: "pi-literature-search-command-result",
						content:
							"A deterministic /lit-search run just finished (agent-free; the user already "
							+ "confirmed every parameter in the dialog). Present this digest to the user as "
							+ "your answer NOW. Copy the reference lines EXACTLY as written -- never re-type, "
							+ "complete, reorder or invent titles, years or identifiers -- and tell the user "
							+ "the HTML path for review. Do not call any tools.\n\n" + digest,
						display: false,
					}, { triggerTurn: true });
				}
			} catch (error) {
				ctx.ui.notify(`Search failed: ${error instanceof Error ? error.message : error}`, "error");
			} finally {
				clearInterval(ticker); // idempotent; covers the failure path
			}
		},
	});
}
