/**
 * Search stage adapter for pi: registers the pi-literature-search tool and
 * the /lit-search command. Both run the SAME intake wizard (query, query
 * variants, period, count, journals, authors, filters) and then the
 * deterministic engine (src/search.ts); the only model call here is the
 * query-variant suggestion in the wizard, and it only shapes queries.
 *
 * The tool result is deliberately NOT the full payload: full citation JSON
 * in a small model's context gets re-typed and fabricated. The model
 * receives a short digest (counts, HTML path, one copyable line per record);
 * the full data goes to disk as HTML plus a JSON sidecar.
 *
 * Parameter confirmation is code, not instruction: every interactive call
 * opens the blocking wizard -- models skip "ask the user first"
 * instructions, but they cannot skip a dialog the tool itself puts between
 * them and the search. The wizard always starts on the query tab -- a
 * keyword-block form (one concept per growing field, free text below); a
 * proposed query arrives as prefill, a bare /lit-search starts empty.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type CheckboxItem,
	detectDialogLang,
	type DialogLang,
	type WizardAnswers,
	type WizardStepDef,
} from "../src/dialog-state.ts";
import { renderDigest } from "../src/digest.ts";
import { DEFAULT_PER_SOURCE, MAX_PER_SOURCE, runSearch, SEARCHERS, type SearchOptions, type SearchPayload } from "../src/search.ts";
import { CODE_SEARCHERS } from "../src/codesearch.ts";
import { codeListTopics } from "../src/config.ts";
import { listsForTopic } from "../src/sources/ecosystems.ts";
import { type AuthorMatch, autocompleteAuthors } from "../src/sources/openalex.ts";
import type { ResultFilters } from "../src/pipeline.ts";
import {
	type BlockFormQuery,
	blocksForEditing,
	formatGroupExpression,
	isProseQuery,
	parsePerSource,
	parseTopicLines,
	parseVariantSuggestions,
	type VariantSuggestion,
	parseYearRange,
	queryBlocks,
	queryFromBlockAnswers,
	TOPIC_SYSTEM_PROMPT,
	topicPrompt,
	topicSlug,
	VARIANT_SYSTEM_PROMPT,
	variantPrompt,
	yearRangeToSpec,
} from "../src/intake.ts";
import { writeRunOutputs } from "../src/output.ts";
import { renderHtml } from "../src/render.ts";
import { writeNetworkPage } from "../src/network.ts";
import { type AuthorMetrics, fetchAuthorMetrics, fetchJournalScores } from "../src/enrich.ts";
import { authorFacets, type FacetScope, journalFacets } from "../src/sources/openalex.ts";
import { chatLangDefault, installChatLangObserver, runWizard } from "./dialogs.ts";
import { completeWithPiModel } from "./pi-model.ts";

const THOROUGH_PER_SOURCE = 15;
/** How many journals the in-tab list shows (the facet query returns up to
 * 200; a wizard tab wants the meaningful head, footprint-friendly).
 * Declared before SEARCH_TEXT, whose strings quote it. */
const JOURNAL_PICK_LIMIT = 12;
/** Sentinel id of the catch-all row under the listed journals. Journal ids
 * are their NAMES, so this cannot collide with one; the row's visible label
 * comes from SEARCH_TEXT.journalOther. */
const JOURNAL_OTHER_ID = "__other_journals__";
/** The same for the author list: the top authors carrying results for this
 * query, with a catch-all row underneath. */
const AUTHOR_PICK_LIMIT = 12;
const AUTHOR_OTHER_ID = "__other_authors__";
/** Author tab rows: the typing row, the position boxes, the scope box,
 * the loaded author list (group at the top) and the lookup match group
 * (under the typing row). */
const AUTHOR_TYPING_ID = "author_search";
const AUTHOR_POS_FIRST = "__author_first__";
const AUTHOR_POS_CONTRIB = "__author_contributing__";
const AUTHOR_SCOPE_ALL = "__author_scope_all__";
const AUTHOR_LIST_GROUP = "author_list";
const AUTHOR_MATCH_GROUP = "author_matches";
/** Typed letters before the lookup fires, and the pause after the last
 * keystroke (OpenAlex's autocomplete endpoint is built for this pace). */
const AUTHOR_LOOKUP_MIN_CHARS = 3;
const AUTHOR_LOOKUP_DEBOUNCE_MS = 400;
const AUTHOR_MATCH_LIMIT = 6;
const AUTHOR_LOOKUP_TIMEOUT_MS = 8_000;
/** Sentinel id of the LOCKED base-query row in the variants tab; variant
 * ids are the query strings themselves, so this cannot collide with one. */
const VARIANT_BASE_ID = "__base_query__";
/** How many LLM suggestions the variants tab asks for per generation:
 * four (1-2 close to the base query, 1-2 wider, one arXiv/CS phrasing)
 * keep the tab readable -- block expressions are wide rows -- and the
 * steering row regenerates for more while checked rows survive. */
const VARIANT_SUGGESTION_LIMIT = 4;
/** The code source whose topic rows the code tab lists underneath. */
const CODE_LIST_SOURCE = "awesome-lists";
/** Field topics asked of the model for the curated-lists rows. */
const CODE_TOPIC_SUGGESTION_LIMIT = 5;
/** Per-topic wait for the list count in the tab (the run itself keeps the
 * client's default timeout); one failure stops further probing. */
const CODE_TOPIC_CHECK_TIMEOUT_MS = 8_000;
// VARIANT_SYSTEM_PROMPT and variantPrompt live in src/intake.ts (pure
// string builders, pinned offline); the prompt turns block-faithful by
// itself when the base query is a block expression.
/** The query tab's keyword-block form: five fields shown by default (an
 * add row appends more, up to QUERY_BLOCK_MAX -- SLR practice caps useful
 * AND chains well below that; more blocks dilute every search) plus the
 * free-text field. */
const QUERY_BLOCK_MIN = 5;
const QUERY_BLOCK_MAX = 8;
/** The LIVE query composed from the query tab's form answers: block
 * fields query_block_1..max plus the free-text field (a filled free text
 * wins). The single source of truth -- the loader keys, the base row, the
 * facet requests and the submit mapping all read the query through it. */
function composedQuery(answers: Record<string, unknown>): BlockFormQuery {
	return queryFromBlockAnswers(
		Array.from({ length: QUERY_BLOCK_MAX }, (_, n) => String(answers[`query_block_${n + 1}`] ?? "")),
		String(answers.query_free ?? ""),
	);
}
/** The same composition over the form step's raw value array (grow fields
 * first, the free-text field last) -- what the step's note and summary
 * callbacks receive. */
function queryFromValues(values: string[]): BlockFormQuery {
	return queryFromBlockAnswers(values.slice(0, -1), values[values.length - 1] ?? "");
}
/** The locked base-query row of the variants tab, built from the LIVE
 * query text: label + suffix, the derived concept-block chain (or an
 * explicit status note) as the dim line. */
function variantBaseRow(
	liveQuery: string,
	text: (typeof SEARCH_TEXT)[DialogLang],
	note?: string,
): CheckboxItem {
	const baseChain = formatGroupExpression(queryBlocks(liveQuery));
	return {
		id: VARIANT_BASE_ID,
		label: `${liveQuery} ${text.variantsBaseSuffix}`,
		locked: true,
		...(note !== undefined ? { description: note }
			: baseChain ? { description: baseChain } : {}),
	};
}

const INTAKE_WIDGET = "pi-literature-review-intake";
/** Transcript entry type for the /lit-search digest card (entries scroll,
 * widgets do not -- a capped widget truncates real result lists). */
const DIGEST_ENTRY = "pi-literature-search-digest";
let digestEntryReady = false;
/** pi-tui's Text component, captured at startup (pi runtime only): the
 * post-submit ticker paints its pulsing dots in the accent color. */
let tuiText: (new (text: string) => unknown) | null = null;

/** Agent-facing framing on the TUI command-path digest message (card +
 * brief chat answer): the card above the agent's reply IS the full result;
 * the agent adds a short conversational summary so the run also leaves a
 * real chat answer. Titles, identifiers and paths are FORBIDDEN in the
 * reply -- agents re-type and fabricate both; the card already carries the
 * reference lines and the clickable HTML link deterministically. Costs one
 * LLM call per TUI command run. */
function searchTurnNote(): string {
	return "[/lit-search result -- deterministic, agent-free; the user already sees it IN FULL as a card "
		+ "above your reply, including every reference line and the clickable HTML link. Reply NOW with a "
		+ "BRIEF summary (2-4 sentences): how many records, how many on_target, and anything notable about "
		+ "sources, filters or dropped records -- drawn ONLY from the digest below, no other knowledge, no "
		+ "tools. Do NOT list, re-type or complete titles, authors or identifiers; do NOT mention any file "
		+ "path or URL. Reply in the language of the user's conversation.]";
}

/** The user-adjustable subset of a discovery call. */
interface IntakeValues {
	query: string;
	/** Additional query phrasings searched in the same run (the variants
	 * tab: checked rows minus the locked base row). */
	queryVariants?: string[] | undefined;
	groupTerms: string[][] | undefined;
	yearFrom: number | undefined;
	yearTo: number | undefined;
	perSource: number | undefined;
	minCites: number | undefined;
	minJournalScore: number | undefined;
	venues: string[] | undefined;
	/** The "Other journals/sources" row of the picker was checked --
	 * journals outside the listed head pass too (see ResultFilters). */
	venuesOther?: boolean;
	/** The journal names the picker listed, so "other" knows what it is
	 * other THAN. Only meaningful together with venuesOther. */
	venuesListed?: string[];
	authors: string[] | undefined;
	/** The author picker's "other authors" row was checked. */
	authorsOther?: boolean;
	/** The author names the picker listed (see venuesListed). */
	authorsListed?: string[];
	/** Authors picked in the tab's lookup: names (post-filter, CrossRef,
	 * arXiv) and OpenAlex ids (exact OpenAlex filter), same order. */
	pickedAuthors?: string[] | undefined;
	authorIds?: string[] | undefined;
	/** Required position of a picked author (both boxes = "any"). */
	authorPosition?: "first" | "contributing" | "any";
	/** "all" = the picked authors' works regardless of the query. */
	authorScope?: "query" | "all";
	/** Code-first sources (the Code tab): repositories first, papers
	 * resolved from what they cite. Empty/undefined = off. */
	codeSources?: string[] | undefined;
	/** GitHub topics whose curated lists the awesome-lists source reads
	 * (the topic rows under "Curated lists"). undefined = the config
	 * default (no rows were offered, e.g. the RPC fallback). */
	codeListTopics?: string[] | undefined;
}

/** Intake wizard strings per dialog language (the dialogs follow the
 * chat's language via the shared observer in dialogs.ts; English default).
 * Wording is deliberately sober -- scholarly tool, no chattiness. */
const SEARCH_TEXT: Record<DialogLang, {
	/** Line above the tab bar: which dialog this is. */
	header: string;
	queryTab: string;
	queryTitle: string;
	/** Confirm-page label for the query step: next to the variants list,
	 * plain "Query" was ambiguous -- the review calls it the main query. */
	queryReviewLabel: string;
	/** Label of the n-th keyword-block field on the query tab. */
	queryBlockLabel: (n: number) => string;
	/** The add row under the block fields (Enter appends the next one). */
	queryAddBlock: string;
	/** Label of the free-text field under the blocks. */
	queryFreeLabel: string;
	/** Warning while blocks AND free text are filled (free text wins). */
	queryBothFilled: string;
	/** Query-variants tab: locked base query on top, LLM suggestions as
	 * checkable rows, a steering input row at the bottom. */
	variantsTab: string;
	variantsTitle: string;
	variantsSelectAll: string;
	/** Suffix after the locked base row's query text. */
	variantsBaseSuffix: string;
	/** Label of the steering input row. */
	variantsSteerLabel: string;
	variantsOwnLabel: string;
	variantsLoading: string;
	variantsIdle: string;
	/** Dim note under the base row when the model returned no usable
	 * suggestions / no model is selected / the call failed -- the tab keeps
	 * working with the base query alone. */
	variantsNoneFound: string;
	variantsFailed: (message: string) => string;
	variantsNoModel: string;
	/** Dim note under the base row when the query reads like a prose
	 * sentence: the derived AND chain would be unsatisfiably strict; the
	 * first suggestion distills the sentence and arrives prechecked. */
	variantsProse: string;
	variantsArxiv: string;
	periodTab: string;
	periodTitle: string;
	periodLast: (n: number) => string;
	periodAll: string;
	periodCustom: string;
	countTab: string;
	countTitle: string;
	/** Code tab: head row, per-source labels and descriptions. */
	codeTab: string;
	codeTitle: string;
	codeHead: string;
	codeNext: string;
	codeSource: Record<string, [string, string]>;
	codeTopicOwn: string;
	codeTopicsLoading: string;
	codeTopicsNone: string;
	codeTopicsFailed: (message: string) => string;
	codeTopicCount: (lists: number, names: string[]) => string;
	codeTopicUnknown: string;
	countDefault: string;
	countMax: string;
	countCustom: string;
	journalTab: string;
	journalTitle: string;
	journalSelectAll: string;
	journalAllSelected: string;
	journalNext: string;
	/** List entry suffix: hit count plus the OpenAlex 2-yr citedness when
	 * the journal has one (pre-formatted with one decimal -- "3.0"). */
	journalItem: (count: number, score: string | undefined) => string;
	/** The catch-all row under the listed journals: everything the top-N
	 * list does not show, so checking every row = no filter. */
	journalOther: string;
	authorTab: string;
	authorTitle: string;
	authorSearchLabel: string;
	authorLookupIdle: string;
	authorLookupLoading: string;
	authorLookupNone: string;
	authorLookupFailed: (message: string) => string;
	/** Match row description: institution · works · citations · h-index · topics. */
	authorMatch: (match: AuthorMatch, metrics: Partial<AuthorMetrics>) => string;
	authorPosFirst: string;
	authorPosContrib: string;
	authorScopeAll: string;
	authorScopeNote: string;
	authorPickHeading: string;
	authorSelectAll: string;
	authorAllSelected: string;
	/** List entry suffix: hits for THIS query plus the author's OpenAlex
	 * totals (citations, h-index, topics) where the API has them. */
	authorItem: (count: number, metrics: Partial<AuthorMetrics>) => string;
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
		queryTitle: "Query-Keywords eingeben: ein Konzept pro Block "
			+ "(z. B. Block 1: satellite imagery, Block 2: data fusion).",
		queryReviewLabel: "Hauptanfrage",
		queryBlockLabel: (n) => `Keyword-Block ${n}`,
		queryAddBlock: "+ Keyword-Block hinzufügen (Enter)",
		queryFreeLabel: "Alternative: Freitext eingeben (Satz / eigene Syntax statt Blöcken)",
		queryBothFilled: "Freitext ist die Hauptanfrage -- die Keyword-Blöcke werden ignoriert",
		variantsTab: "Query-Varianten",
		variantsTitle: "Query-Varianten (optional): das Modell schlägt alternative Suchen vor (Synonyme mit OR, "
			+ "Konzepte mit AND). Angehakte Zeilen laufen zusätzlich zur Hauptanfrage; jeder Treffer zeigt, "
			+ "welche Suche ihn fand (Q1, Q2 ...).",
		variantsSelectAll: "Alle auswählen",
		variantsBaseSuffix: "(Hauptanfrage, läuft immer)",
		variantsSteerLabel: "↻ Neue Query-Varianten generieren (Enter drücken; optional Richtung eintippen)",
		variantsOwnLabel: "+ Eigene Variante eintippen (Enter fügt hinzu)",
		variantsLoading: "generiere Suchvorschläge ...",
		variantsIdle: "wartet auf eine Suchanfrage",
		variantsNoneFound: "keine brauchbaren Vorschläge -- Hauptanfrage läuft trotzdem",
		variantsFailed: (message) => `Vorschläge nicht abrufbar: ${message}`,
		variantsNoModel: "kein Modell in pi gewählt -- Vorschläge nicht verfügbar",
		variantsProse: "liest sich wie ein Satz -- der erste Vorschlag unten destilliert ihn in Konzeptblöcke und ist vorausgewählt",
		variantsArxiv: "arXiv/CS-Fassung: Methodenwörter statt Fachjargon -- die Zeile, die arXiv beantworten kann",
		periodTab: "Suchzeitraum",
		periodTitle: "Erscheinungszeitraum?",
		periodLast: (n) => `Letzte ${n} Jahre`,
		periodAll: "Alle Jahre",
		periodCustom: "Eigener Zeitraum:",
		countTab: "Treffer",
		countTitle: "Wie viele Treffer je Quelle (arXiv, CrossRef, OpenAlex, Semantic Scholar)?",
		codeTab: "Code",
		codeTitle: "Zusätzlich Code-Repositories durchsuchen und die Paper auflösen, die sie zitieren (Repository zuerst, Paper danach). Kostet je nach Auswahl etwa 30-90 s pro Lauf.",
		codeHead: "Paper mit Code suchen",
		codeNext: "Weiter",
		codeSource: {
			"hf-papers": ["Hugging Face Papers", "Suche bei Hugging Face, Paper-Daten von arXiv, GitHub-Link falls vorhanden"],
			"github-readme": ["GitHub README-Suche", "Repositories, deren README arxiv.org nennt; GitHub-Budget 10/min"],
			"awesome-lists": ["Kuratierte Listen (awesome.ecosyste.ms)", "Awesome-Listen nach Fachgebiet (GitHub-Topic), Einträge gegen die Blöcke geprüft; anhaken zeigt die Themen"],
			"gee-github": ["Google Earth Engine (GitHub)", "GEE-Repositories, deren README eine DOI nennt"],
		},
		codeTopicOwn: "+ Eigenes Listen-Thema für Kuratierte Listen (Enter fügt hinzu und hakt an)",
		codeTopicsLoading: "Listen-Themen für das Fachgebiet werden vorgeschlagen und geprüft ...",
		codeTopicsNone: "keine Listen-Themen",
		codeTopicsFailed: (message) => `Themenvorschlag fehlgeschlagen: ${message}; nur die konfigurierten Themen`,
		codeTopicCount: (lists, names) => (lists ? `${lists} Liste${lists === 1 ? "" : "n"} · ${names.join(", ")}` : "0 Listen (nichts zu lesen)"),
		codeTopicUnknown: "Anzahl nicht verfügbar (awesome.ecosyste.ms antwortet nicht)",
		countDefault: `${DEFAULT_PER_SOURCE} (Standard)`,
		countMax: `${MAX_PER_SOURCE} (Limit)`,
		countCustom: "Eigene Anzahl:",
		journalTab: "Journals",
		journalTitle: `Journals (optional): die ${JOURNAL_PICK_LIMIT} häufigsten Journals zu dieser Anfrage und `
			+ "diesem Zeitraum. Alle sind drin -- Haken entfernen schließt ein Journal aus.",
		journalSelectAll: "Alle auswählen",
		journalAllSelected: "Alle Journals drin (Enter: alle abwählen)",
		journalNext: "Weiter",
		journalItem: (count, score) =>
			`(${count} Treffer${score !== undefined ? ` · 2-Jahres-Rate ${score}` : ""})`,
		journalOther: "Andere Journals/Quellen (hier nicht gelistet)",
		authorTab: "Autoren",
		authorTitle: "Autoren zu dieser Anfrage, nach Zitationen sortiert",
		authorSearchLabel: "Autorenname tippen",
		authorLookupIdle: "",
		authorLookupLoading: "suche Autoren bei OpenAlex ...",
		authorLookupNone: "kein Autor zu diesem Namen gefunden",
		authorLookupFailed: (message) => `Autorensuche fehlgeschlagen: ${message}`,
		authorMatch: (match, metrics) => [
			match.hint,
			match.works !== undefined ? `${match.works} Werke` : "",
			match.cites !== undefined ? `${match.cites} Zitationen` : "",
			metrics.hIndex !== undefined ? `h-Index ${metrics.hIndex}` : "",
			metrics.topics?.length ? metrics.topics.join(", ") : "",
		].filter(Boolean).join(" · "),
		authorPosFirst: "als Erstautor (innerhalb der Suchanfrage)",
		authorPosContrib: "als Mitautor (innerhalb der Suchanfrage)",
		authorScopeAll: "alle Publikationen dieses Autors, Suchanfrage ignorieren",
		authorScopeNote: "ignoriert (alle Publikationen gewählt)",
		authorPickHeading: "Suche auf einen bestimmten Autor einschränken",
		authorSelectAll: "Alle auswählen",
		authorAllSelected: "Alle Autoren drin (Enter: alle abwählen)",
		authorItem: (count, metrics) =>
			`(${count} Treffer${metrics.cites !== undefined ? ` · ${metrics.cites} Zitationen` : ""}`
			+ `${metrics.hIndex !== undefined ? ` · h-Index ${metrics.hIndex}` : ""}`
			+ `${metrics.topics?.length ? ` · ${metrics.topics.join(", ")}` : ""})`,
		authorOther: "Andere Autorinnen und Autoren (hier nicht gelistet)",
		authorLoading: "hole Autorenliste von OpenAlex ...",
		authorNoneFound: "keine Autoren zu dieser Suchanfrage gefunden",
		authorFetchFailed: (message) => `Autorenliste nicht abrufbar: ${message}`,
		journalLoading: "hole Journal-Liste von OpenAlex ...",
		journalIdle: "wartet auf eine Suchanfrage",
		journalNoneFound: "keine Journals zu dieser Suchanfrage gefunden",
		journalFetchFailed: (message) => `Journal-Liste nicht abrufbar: ${message}`,
		filterTab: "Filter",
		filterTitle: "Optionale Filter (leer = aus).",
		minCitesLabel: "Mindestzitationen",
		note: (sources, variants) =>
			`Quellen: ${sources.join(", ")}${variants ? ` · +${variants} Query-Variante(n)` : ""}`,
		badYears: (spec) => `Jahresangabe "${spec}" nicht verstanden -- Vorschlag bleibt`,
		badCount: (spec) => `Anzahl "${spec}" nicht verstanden -- Vorschlag bleibt`,
		badNumber: (label, spec) => `${label}: "${spec}" nicht verstanden -- Filter bleibt aus`,
		capped: `Auf ${MAX_PER_SOURCE} je Quelle gekappt (Rücksicht auf die freien APIs)`,
		noQuery: "Ohne Suchanfrage keine Suche -- nichts wurde gesucht.",
	},
	en: {
		header: "/lit-search -- literature search (Esc cancels)",
		queryTab: "Query",
		queryTitle: "Enter query keywords: one concept per block "
			+ "(e.g. block 1: satellite imagery, block 2: data fusion).",
		queryReviewLabel: "Main query",
		queryBlockLabel: (n) => `Keyword block ${n}`,
		queryAddBlock: "+ Add keyword block (Enter)",
		queryFreeLabel: "Alternative: enter free text (sentence / own syntax instead of blocks)",
		queryBothFilled: "Free text set as main query, keyword blocks will be ignored",
		variantsTab: "Query variants",
		variantsTitle: "Query variants (optional): the model suggests alternative searches (synonyms with OR, "
			+ "concepts with AND). Checked rows are searched in addition to the main query; every result "
			+ "shows which search found it (Q1, Q2 ...).",
		variantsSelectAll: "Select all",
		variantsBaseSuffix: "(main query, always searched)",
		variantsSteerLabel: "↻ Generate new query variants (press Enter; optionally type a direction)",
		variantsOwnLabel: "+ Type your own variant (Enter adds)",
		variantsLoading: "generating search suggestions ...",
		variantsIdle: "waiting for a search query",
		variantsNoneFound: "no usable suggestions -- the main query still runs",
		variantsFailed: (message) => `suggestions not available: ${message}`,
		variantsNoModel: "no model selected in pi -- suggestions not available",
		variantsProse: "reads like a sentence -- the first suggestion below distills it into concept blocks and is prechecked",
		variantsArxiv: "arXiv/CS phrasing: method words instead of field jargon -- the row arXiv can answer",
		periodTab: "Search Period",
		periodTitle: "Publication period?",
		periodLast: (n) => `Last ${n} years`,
		periodAll: "All years",
		periodCustom: "Custom range:",
		countTab: "Records",
		countTitle: "How many records per source (arXiv, CrossRef, OpenAlex, Semantic Scholar)?",
		codeTab: "Code",
		codeTitle: "Additionally search code repositories and resolve the papers they cite (repository first, paper second). Adds roughly 30-90 s per run depending on the selection.",
		codeHead: "Search for papers with code",
		codeNext: "Next",
		codeSource: {
			"hf-papers": ["Hugging Face Papers", "Hugging Face search, paper details from arXiv, GitHub link if available"],
			"github-readme": ["GitHub README search", "repositories whose README cites arxiv.org; GitHub budget 10/min"],
			"awesome-lists": ["Curated lists (awesome.ecosyste.ms)", "awesome lists by field (GitHub topic), entries matched against the blocks; tick to see the topics"],
			"gee-github": ["Google Earth Engine (GitHub)", "GEE repositories whose README cites a DOI"],
		},
		codeTopicOwn: "+ Own list topic for Curated lists (Enter adds and checks it)",
		codeTopicsLoading: "suggesting and checking list topics for the field ...",
		codeTopicsNone: "no list topics",
		codeTopicsFailed: (message) => `topic suggestion failed: ${message}; configured topics only`,
		codeTopicCount: (lists, names) => (lists ? `${lists} list${lists === 1 ? "" : "s"} · ${names.join(", ")}` : "0 lists (nothing to read)"),
		codeTopicUnknown: "count unavailable (awesome.ecosyste.ms not answering)",
		countDefault: `${DEFAULT_PER_SOURCE} (default)`,
		countMax: `${MAX_PER_SOURCE} (limit)`,
		countCustom: "Custom count:",
		journalTab: "Journals",
		journalTitle: `Journals (optional): the ${JOURNAL_PICK_LIMIT} most frequent journals for this query and `
			+ "period. All are included -- untick a journal to exclude it.",
		journalSelectAll: "Select all",
		journalAllSelected: "All journals included (Enter: deselect all)",
		journalNext: "Next",
		journalItem: (count, score) =>
			`(${count} hits${score !== undefined ? ` · 2-yr rate ${score}` : ""})`,
		journalOther: "Other journals/sources (not listed here)",
		authorTab: "Authors",
		authorTitle: "Authors for this query, ranked by citations",
		authorSearchLabel: "Type author name",
		authorLookupIdle: "",
		authorLookupLoading: "looking up authors at OpenAlex ...",
		authorLookupNone: "no author found for this name",
		authorLookupFailed: (message) => `author lookup failed: ${message}`,
		authorMatch: (match, metrics) => [
			match.hint,
			match.works !== undefined ? `${match.works} works` : "",
			match.cites !== undefined ? `${match.cites} citations` : "",
			metrics.hIndex !== undefined ? `h-index ${metrics.hIndex}` : "",
			metrics.topics?.length ? metrics.topics.join(", ") : "",
		].filter(Boolean).join(" · "),
		authorPosFirst: "as first author (within the search query)",
		authorPosContrib: "as contributing author (within the search query)",
		authorScopeAll: "all publications of this author, ignoring the search query",
		authorScopeNote: "ignored (all publications selected)",
		authorPickHeading: "Limit the search to a specific author",
		authorSelectAll: "Select all",
		authorAllSelected: "All authors included (Enter: deselect all)",
		authorItem: (count, metrics) =>
			`(${count} hits${metrics.cites !== undefined ? ` · ${metrics.cites} citations` : ""}`
			+ `${metrics.hIndex !== undefined ? ` · h-index ${metrics.hIndex}` : ""}`
			+ `${metrics.topics?.length ? ` · ${metrics.topics.join(", ")}` : ""})`,
		authorOther: "Other authors (not listed here)",
		authorLoading: "fetching author list from OpenAlex ...",
		authorNoneFound: "no authors found for this query",
		authorFetchFailed: (message) => `author list not reachable: ${message}`,
		journalLoading: "fetching journal list from OpenAlex ...",
		journalIdle: "waiting for a search query",
		journalNoneFound: "no journals found for this query",
		journalFetchFailed: (message) => `journal list not reachable: ${message}`,
		filterTab: "Filters",
		filterTitle: "Optional filters (empty = off).",
		minCitesLabel: "Min. citations",
		note: (sources, variants) =>
			`Sources: ${sources.join(", ")}${variants ? ` · +${variants} query variant(s)` : ""}`,
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
 * always agree on what the chosen period means.
 */
function periodToRange(raw: unknown): { yearFrom?: number; yearTo?: number } | null {
	const spec = typeof raw === "string" ? raw.trim() : "";
	const thisYear = new Date().getFullYear();
	const lastYears: Record<string, number> = { "5y": 4, "10y": 9, "20y": 19 };
	if (spec in lastYears) return { yearFrom: thisYear - lastYears[spec] };
	if (!spec || spec === "all" || ALL_YEARS_TOKENS.has(spec.toLowerCase())) return {};
	return parseYearRange(spec);
}

/** Engine options shared by the tool and the command path: the confirmed
 * wizard values, minus the filters (see filtersFor). */
function searchOptionsFor(confirmed: IntakeValues): Pick<SearchOptions, "query" | "queryVariants" | "perSource" | "groupTerms" | "codeSources" | "codeListTopics" | "authorIds" | "authorScope"> {
	return {
		query: confirmed.query,
		queryVariants: confirmed.queryVariants,
		perSource: confirmed.perSource,
		groupTerms: confirmed.groupTerms,
		codeSources: confirmed.codeSources,
		codeListTopics: confirmed.codeListTopics,
		authorIds: confirmed.authorIds,
		authorScope: confirmed.authorScope,
	};
}

/** The confirmed wizard values as engine filters (the tool path adds its
 * headless-only params on top). */
function filtersFor(confirmed: IntakeValues): ResultFilters {
	return {
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
		pickedAuthors: confirmed.pickedAuthors,
		authorPosition: confirmed.authorPosition,
	};
}

/** Write the HTML page (with the Network column) + JSON sidecar and the
 * static network page beside them; the relative Graph links can never
 * dangle because both are written together. Throws on write failure. */
function writeSearchOutputs(payload: SearchPayload, htmlFile?: string): { htmlPath: string; jsonPath: string } {
	const written = writeRunOutputs(renderHtml(payload, { network: true }), payload, htmlFile);
	writeNetworkPage(written.htmlPath);
	return written;
}

/**
 * Code-enforced intake: a blocking wizard the MODEL cannot skip or answer,
 * run on EVERY interactive call (the same one-overlay wizard as
 * /lit-synthesis). It always starts on the query tab -- a keyword-block
 * FORM (growing concept fields, free text below; a proposed query arrives
 * as PREFILL, block expressions split into the fields) -- and the user
 * walks the tabs to the submit page; bare /lit-search starts the same way
 * empty. Esc cancels the run before any network call. Values are WYSIWYG:
 * what a tab shows at submit time is what runs -- clearing the years means
 * all years, and an empty query at submit cancels honestly on every path.
 * Tabs: query (block form); query
 * variants (locked base row, LLM concept-block suggestions loaded when
 * reached, steering row regenerates, checked rows run as additional
 * queries -- blocks drive the boolean fetch AND the labeling, derived per
 * query by the ENGINE, agent group_terms override the base query's
 * blocks); period; count (presets + custom row); journals and authors
 * (OpenAlex facet lists with an "other" row); filters (min citations,
 * author names -- strictly opt-in).
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
	// Agent-proposed query variants (tool param) become visible PREchecked
	// rows in the variants tab -- the user-confirmed checked list is what
	// runs, raw params never bypass the dialog. Deduplicated
	// case-insensitively.
	const agentVariants: string[] = [];
	for (const variant of queryVariants ?? []) {
		const trimmed = variant.trim();
		if (!trimmed) continue;
		if (!agentVariants.some((seen) => seen.toLowerCase() === trimmed.toLowerCase())) {
			agentVariants.push(trimmed);
		}
	}
	const thisYear = new Date().getFullYear();
	// Set by the variants loader when the base query reads like a prose
	// sentence: the first suggestion after the breadth sort -- the
	// distillation under the prompt's prose rule -- so preselect can check
	// it for the default run.
	let proseDistilled: string | null = null;
	// Filled by the journal itemLoader below; the submit mapping needs to
	// know which journals the list actually showed, and the author loader
	// needs their OpenAlex source ids to scope its facet.
	let listedJournals: string[] = [];
	let listedJournalIds = new Map<string, string>();
	let listedAuthors: string[] = [];
	// Author lookup (author tab): facts of every match the lookup ever
	// showed (id -> name + row), so picked rows survive later lookups and
	// the submit mapping knows the picked names.
	const authorFacts = new Map<string, { name: string; row: CheckboxItem }>();
	const pickedAuthorIds = (answers: WizardAnswers): string[] =>
		(Array.isArray(answers.author_pick) ? (answers.author_pick as string[]) : []).filter((id) => authorFacts.has(id));
	const hasPickedAuthor = (answers: WizardAnswers): boolean => pickedAuthorIds(answers).length > 0;
	// The position boxes need a picked author and apply within the query
	// only: the scope box ("all publications, ignoring the query") greys
	// them out with a note; before a pick they are grey without one.
	const scopeAllOn = (answers: WizardAnswers): boolean =>
		Array.isArray(answers.author_pick) && (answers.author_pick as string[]).includes(AUTHOR_SCOPE_ALL);
	const positionBoxOn = (answers: WizardAnswers): boolean => hasPickedAuthor(answers) && !scopeAllOn(answers);
	const positionBoxNote = (answers: WizardAnswers): string => (hasPickedAuthor(answers) ? text.authorScopeNote : "");
	// List-topic rows under "Curated lists" (code tab): ids the loader has
	// produced or verified, ids the user typed on the add row (kept in the
	// list even when unticked), and whether rows were offered at all -- the
	// submit mapping passes the ticked topics only when they were.
	const knownTopics = new Set<string>();
	const typedTopics: string[] = [];
	let topicsOffered = false;
	const topicSuggestions = new Map<string, Promise<string[]>>();
	const topicCounts = new Map<string, Promise<{ lists: number; names: string[] } | null>>();
	// Facet scope from the LIVE answers (lists built from the query text
	// alone would show journals/authors the configured run could never
	// return). Both parts feed the loader cache keys, so editing the period
	// or the journal picks re-fetches on the next tab visit.
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
	// Query prefill routing: a block expression splits into the block
	// fields (one "a OR b" line per block); plain keywords, prose and
	// hands-off syntax land in the free-text field verbatim.
	const prefillBlocks = query.trim() ? blocksForEditing(query) : null;
	const steps: WizardStepDef[] = [
		{
			// Query tab as a keyword-block form (the building-blocks method as
			// the PRIMARY input): grow fields hold one concept each, the add
			// row under them appends more; the free-text field below carries
			// sentences and hand syntax instead and wins when filled (the
			// note row warns while both are set). The composed query is
			// exactly what the tabs, sources and labeling see.
			kind: "form", id: "query", tab: text.queryTab, reviewLabel: text.queryReviewLabel, title: text.queryTitle,
			grow: {
				idPrefix: "query_block", label: text.queryBlockLabel, addLabel: text.queryAddBlock,
				min: QUERY_BLOCK_MIN, max: QUERY_BLOCK_MAX,
				...(prefillBlocks ? { initial: prefillBlocks } : {}),
			},
			fields: [{
				id: "query_free", label: text.queryFreeLabel,
				...(query.trim() && !prefillBlocks ? { initial: query.trim() } : {}),
			}],
			note: (values) =>
				(queryFromValues(values).bothFilled ? { text: text.queryBothFilled, warn: true } : null),
			// The review line carries the run's Q1 label -- the same wording
			// the variants rows and the HTML report use.
			summary: (values) => {
				const composed = queryFromValues(values).query;
				return composed ? `Q1: ${composed}` : composed;
			},
		},
		{
			// Query-variants tab: the locked base query on top, LLM phrasing
			// suggestions as checkable rows (loaded when the tab is reached --
			// see the variants itemLoader below), agent-proposed variants
			// prechecked, and a steering input row at the bottom whose Enter
			// regenerates the suggestions (checked rows survive via
			// keepSelected).
			kind: "checkbox", id: "variants", tab: text.variantsTab, title: text.variantsTitle,
			items: [], selectAllLabel: text.variantsSelectAll, nextLabel: text.journalNext,
			optional: true, emptyNote: text.variantsIdle, keepSelected: true, cursorStart: "next", spaced: true,
			// Rows carry the run's Q labels (base = Q1, checked rows Q2.. in
			// list order) -- the wording the HTML report uses.
			queryNumbers: true,
			// Own-variant row: typed text + Enter joins the list as a checked
			// row and runs like any confirmed variant.
			addInput: { id: "variants_own", label: text.variantsOwnLabel },
			input: { id: "variants_hint", label: text.variantsSteerLabel },
		},
		{
			// Search period as a menu: last 5/10/20 years with the resolved
			// range as the dim line, all years, or a custom range (2015-2024,
			// 2015- or 2024). Bare calls recommend "last 5 years"; the proposal
			// path defaults to all years unless the agent proposed a range
			// (which seeds the custom row).
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
			// On the proposal-confirm path the proposal IS the answer; a bare
			// call starts genuinely unanswered (no pre-set check marks).
			...(query.trim() ? { initialIsAnswer: true } : {}),
		},
		{
			// Code-first search: the four sources are always on screen,
			// unchecked; the head row "Search for papers with code" is a
			// master switch (checks all, else clears all), each source stays
			// individually untickable. Off by default (30-90 s per run); an
			// agent code_sources proposal arrives with those sources checked.
			kind: "checkbox", id: "code", tab: text.codeTab, title: text.codeTitle,
			items: Object.keys(CODE_SEARCHERS).map((id) => {
				const [label, description] = text.codeSource[id] ?? [id, ""];
				return { id, label, ...(description ? { description } : {}) };
			}),
			selectAllLabel: text.codeHead, nextLabel: text.codeNext, optional: true, masterRow: true,
			...(proposed.codeSources?.length ? { preselected: proposed.codeSources } : {}),
			// Own list topic: lands as a child row under "Curated lists",
			// checked; the topic loader below verifies it on its next pass.
			addInput: { id: "code_topic_own", label: text.codeTopicOwn, parent: CODE_LIST_SOURCE },
		},
		{
			// Journal filter: the top journals for this query load INTO the
			// tab (one OpenAlex facet query, fired when the tab is reached --
			// see itemLoader below) as an EXCLUSION list: every row arrives
			// checked, unticking excludes; all or none checked = no filter,
			// and the cursor starts on Next so Enter-through stays one
			// stroke. An agent venues proposal arrives as a checked whitelist.
			kind: "checkbox", id: "journals", tab: text.journalTab, title: text.journalTitle,
			items: [], selectAllLabel: text.journalSelectAll, allSelectedLabel: text.journalAllSelected,
			nextLabel: text.journalNext, optional: true, emptyNote: text.journalLoading,
			defaultAll: true, cursorStart: "next",
		},
		{
			// Author tab, two sections. (1) The top authors for this query
			// load as an EXCLUSION list at the top (group loader, rows arrive
			// ticked, "All authors included" head row over exactly these
			// rows); the list greys out once an author is picked below.
			// (2) Under its own heading, the typing row -- the lookup's
			// matches arrive as a group right under it, a ticked match is a
			// picked author and clears the draft; three boxes sit greyed out
			// (no note) until an author is picked, and the scope box greys
			// out the two position boxes with a note. No row numbers: they
			// would compete with the two headings.
			kind: "checkbox", id: "author_pick", tab: text.authorTab, title: text.authorTitle, unnumbered: true,
			items: [
				{
					id: AUTHOR_TYPING_ID, label: text.authorSearchLabel, headingBefore: text.authorPickHeading,
					typing: { clearOnPick: true, ...(proposed.authors?.[0] ? { initial: proposed.authors[0] } : {}) },
				},
				{ id: AUTHOR_POS_FIRST, label: text.authorPosFirst, enabledIf: positionBoxOn, disabledNote: positionBoxNote },
				{ id: AUTHOR_POS_CONTRIB, label: text.authorPosContrib, enabledIf: positionBoxOn, disabledNote: positionBoxNote },
				{ id: AUTHOR_SCOPE_ALL, label: text.authorScopeAll, enabledIf: hasPickedAuthor },
			],
			// Both position boxes start ticked (any position); an agent
			// proposal narrows them or ticks the scope box.
			preselected: [
				...(proposed.authorPosition === "contributing" ? [] : [AUTHOR_POS_FIRST]),
				...(proposed.authorPosition === "first" ? [] : [AUTHOR_POS_CONTRIB]),
				...(proposed.authorScope === "all" ? [AUTHOR_SCOPE_ALL] : []),
			],
			selectAllLabel: text.authorSelectAll, allSelectedLabel: text.authorAllSelected,
			nextLabel: text.journalNext, optional: true, cursorStart: "next",
		},
		{
			kind: "form", id: "filters", tab: text.filterTab, title: text.filterTitle,
			fields: [
				{
					id: "min_cites", label: text.minCitesLabel,
					...(proposed.minCites !== undefined ? { initial: String(proposed.minCites) } : {}),
				},
			],
		},
	];
	const result = await runWizard(ctx, steps, signal, {
		lang,
		header: text.header,
		// Live variant count on the review page: checked rows minus the
		// locked base row.
		submitNote: (answers) => text.note(sources, Array.isArray(answers.variants)
			? (answers.variants as string[]).filter((id) => id !== VARIANT_BASE_ID).length
			: 0),
		// Lazily loaded tabs: each loader fires when its tab is reached,
		// keyed on the LIVE answers it depends on (a changed key re-fetches
		// on the next visit).
		itemLoaders: [{
			// Query-variant suggestions: ONE call to the model selected in pi
			// when the tab is reached; the key carries the COMMITTED steering
			// text plus its commit counter, so Enter on the steering row
			// regenerates and typing never fires a call. load() never throws
			// -- every failure degrades to the locked base row with an
			// explaining dim line, and the tab stays passable with one Enter.
			step: "variants",
			key: (answers) => {
				const live = composedQuery(answers).query.toLowerCase();
				if (!live) return "";
				return `${live}|${String(answers.variants_hint ?? "")}|${String(answers.variants_hint_seq ?? "0")}`;
			},
			// The base row's dim line shows its concept blocks -- exactly what
			// the boolean sources receive and what labels its finds; a
			// failure/none note takes the line instead.
			load: async (answers) => {
				const liveQuery = composedQuery(answers).query;
				const hint = String(answers.variants_hint ?? "").trim();
				// Prose sentence as base: the prompt demands a faithful
				// distillation as the FIRST line; after the breadth sort the
				// closest-to-base suggestion sits first, which under that rule
				// IS the distillation -- preselect checks it so the default
				// Enter-through run carries a proper block query.
				const prose = isProseQuery(liveQuery);
				const agentItems: CheckboxItem[] = agentVariants
					.filter((variant) => variant.toLowerCase() !== liveQuery.toLowerCase())
					.map((variant) => ({ id: variant, label: variant }));
				const base = (note?: string): CheckboxItem => variantBaseRow(liveQuery, text, note);
				proseDistilled = null;
				if (!ctx.model) return [base(text.variantsNoModel), ...agentItems];
				try {
					const raw = await completeWithPiModel(ctx, {
						system: VARIANT_SYSTEM_PROMPT,
						user: variantPrompt(liveQuery, hint, VARIANT_SUGGESTION_LIMIT, prose),
						maxTokens: 500,
						...(signal ? { signal } : {}),
					});
					const suggestions = parseVariantSuggestions(raw, liveQuery, VARIANT_SUGGESTION_LIMIT)
						.filter((entry) => !agentVariants.some((seen) => seen.toLowerCase() === entry.text.toLowerCase()));
					proseDistilled = prose && suggestions.length ? (suggestions[0] as VariantSuggestion).text : null;
					return [
						base(suggestions.length
							? (prose ? text.variantsProse : undefined)
							: text.variantsNoneFound),
						...agentItems,
						...suggestions.map((entry) => ({
							id: entry.text,
							label: entry.text,
							// The model's arXiv/CS phrasing gets a dim tag line so
							// the user can spot it; no marker from the model = no tag.
							...(entry.arxiv ? { description: text.variantsArxiv } : {}),
						})),
					];
				} catch (error) {
					return [
						base(text.variantsFailed(error instanceof Error ? error.message : String(error))),
						...agentItems,
					];
				}
			},
			preselect: (items: { id: string }[]) => {
				const picked = items
					.filter((item) => agentVariants.some((seen) => seen.toLowerCase() === item.id.toLowerCase()))
					.map((item) => item.id);
				// The distillation of a prose base runs by default (set by the
				// load() above; preselect only ever applies while the user has
				// not checked anything yet -- their picks always win).
				if (proseDistilled !== null && !picked.includes(proseDistilled)
					&& items.some((item) => item.id === proseDistilled)) {
					picked.push(proseDistilled);
				}
				return picked;
			},
			loadingNote: text.variantsLoading,
			idleNote: text.variantsIdle,
			emptyNote: text.variantsNoneFound,
			failedNote: text.variantsFailed,
		}, {
			// List topics under "Curated lists" (child loader): the rows
			// appear once the source is ticked and vanish when it is unticked.
			// Rows = the configured topics, an agent proposal, up to five
			// FIELD topics named by the model selected in pi (awesome lists
			// are filed by field, measured 2026-09-13 -- block words find
			// nothing), and the user's own typed topics. Every row is checked
			// against awesome.ecosyste.ms and shows its list count; a model
			// topic without lists is not shown, the others keep an honest
			// "0 lists". Suggestions and counts are cached per process, so
			// leaving and re-entering the tab costs no second model call.
			step: "code",
			parent: CODE_LIST_SOURCE,
			key: (answers) => {
				const picked = Array.isArray(answers.code) ? (answers.code as string[]) : [];
				if (!picked.includes(CODE_LIST_SOURCE)) return "";
				// A ticked id the loader never produced = a freshly typed
				// topic -> one reload verifies it (then it is known).
				const fresh = picked.filter((id) => !(id in CODE_SEARCHERS) && !knownTopics.has(id)).sort();
				for (const id of fresh) {
					if (!typedTopics.includes(id)) typedTopics.push(id);
				}
				return `${composedQuery(answers).query.toLowerCase()}|${fresh.join(",")}`;
			},
			load: async (answers) => {
				topicsOffered = true;
				const liveQuery = composedQuery(answers).query;
				const configTopics = codeListTopics();
				const agentTopics = (proposed.codeListTopics ?? []).map(topicSlug).filter(Boolean);
				let modelTopics: string[] = [];
				if (ctx.model && liveQuery) {
					const cacheKey = liveQuery.toLowerCase();
					if (!topicSuggestions.has(cacheKey)) {
						topicSuggestions.set(cacheKey, completeWithPiModel(ctx, {
							system: TOPIC_SYSTEM_PROMPT,
							user: topicPrompt(liveQuery, queryBlocks(liveQuery), CODE_TOPIC_SUGGESTION_LIMIT),
							maxTokens: 200,
							...(signal ? { signal } : {}),
						}).then((raw) => parseTopicLines(raw, CODE_TOPIC_SUGGESTION_LIMIT)));
					}
					try {
						modelTopics = await topicSuggestions.get(cacheKey)!;
					} catch (error) {
						// The model failing is not a reason to hide the configured
						// rows; the status line says what happened.
						topicSuggestions.delete(cacheKey);
						ctx.ui.notify(text.codeTopicsFailed(error instanceof Error ? error.message : String(error)), "warning");
					}
				}
				const ordered: Array<{ id: string; fromModel: boolean }> = [];
				const push = (id: string, fromModel: boolean): void => {
					if (id && !ordered.some((entry) => entry.id === id)) ordered.push({ id, fromModel });
				};
				for (const id of configTopics) push(topicSlug(id), false);
				for (const id of agentTopics) push(id, false);
				for (const id of modelTopics) push(id, true);
				for (const id of typedTopics) push(id, false);
				// Verification at the index the run will read; a short timeout
				// per topic and ONE failure stops further probing (a down
				// index must not cost minutes).
				let indexDown = false;
				const items: CheckboxItem[] = [];
				for (const entry of ordered) {
					if (!topicCounts.has(entry.id) && !indexDown) {
						topicCounts.set(entry.id, listsForTopic(entry.id, AbortSignal.timeout(CODE_TOPIC_CHECK_TIMEOUT_MS))
							.then((lists) => ({ lists: lists.length, names: lists.slice(0, 2).map((list) => list.slug.split("/")[1] ?? list.slug) })));
					}
					let count: { lists: number; names: string[] } | null = null;
					if (topicCounts.has(entry.id)) {
						try {
							count = await topicCounts.get(entry.id)!;
						} catch {
							topicCounts.delete(entry.id);
							indexDown = true;
						}
					}
					if (entry.fromModel && count !== null && count.lists === 0) continue;
					knownTopics.add(entry.id);
					items.push({
						id: entry.id,
						label: entry.id,
						description: count === null ? text.codeTopicUnknown : text.codeTopicCount(count.lists, count.names),
					});
				}
				return items;
			},
			preselect: (items: { id: string }[]) => items.map((item) => item.id),
			loadingNote: text.codeTopicsLoading,
			idleNote: "",
			emptyNote: text.codeTopicsNone,
			failedNote: text.codeTopicsFailed,
		}, {
			step: "journals",
			key: (answers) => `${composedQuery(answers).query.toLowerCase()}|${scopeKey(liveYearScope(answers))}`,
			load: async (answers) => {
				const page = await journalFacets(
					composedQuery(answers).query, JOURNAL_PICK_LIMIT, liveYearScope(answers),
				);
				const scores = await fetchJournalScores(page.listed.map((facet) => facet.id), () => {});
				// Remember what the list SHOWED: the "other" row is defined
				// against exactly these names; the ids scope the author facet.
				listedJournals = page.listed.map((facet) => facet.name);
				listedJournalIds = new Map(page.listed.map((facet) => [facet.name, facet.id]));
				const items = page.listed.map((facet) => {
					const score = scores.get(facet.id);
					// toFixed keeps the decimal on integers ("3.0", never "3").
					const rounded = score === undefined ? undefined : score.toFixed(1);
					return { id: facet.name, label: `${facet.name} ${text.journalItem(facet.count, rounded)}` };
				});
				// The catch-all row: checking everything is then genuinely "no
				// filter" ("all" must never exclude).
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
			// Author lookup (group under the typing row): keyed on the LIVE
			// draft and the picked ids, debounced; picked rows are always part
			// of the result so they survive every later lookup. Metrics for
			// the matches come from the same batched author lookup the list
			// uses. A draft too short to look up returns the picked rows only.
			step: "author_pick",
			group: AUTHOR_MATCH_GROUP,
			after: AUTHOR_TYPING_ID,
			debounceMs: AUTHOR_LOOKUP_DEBOUNCE_MS,
			key: (answers) => {
				const draft = String(answers.author_search_draft ?? "").trim();
				const picked = pickedAuthorIds(answers).sort().join(",");
				const lookup = draft.length >= AUTHOR_LOOKUP_MIN_CHARS ? draft.toLowerCase() : "";
				return lookup || picked ? `${lookup}|${picked}` : "";
			},
			load: async (answers) => {
				const draft = String(answers.author_search_draft ?? "").trim();
				const picked = pickedAuthorIds(answers);
				const pickedRows = picked.map((id) => authorFacts.get(id)!.row);
				if (draft.length < AUTHOR_LOOKUP_MIN_CHARS) return pickedRows;
				const matches = (await autocompleteAuthors(draft, AbortSignal.timeout(AUTHOR_LOOKUP_TIMEOUT_MS)))
					.filter((match) => !picked.includes(match.id))
					.slice(0, AUTHOR_MATCH_LIMIT);
				let metrics = new Map<string, AuthorMetrics>();
				try {
					metrics = await fetchAuthorMetrics(matches.map((match) => match.id), () => {});
				} catch {
					// the rows then show the autocomplete facts only
				}
				const rows = matches.map((match) => {
					const row: CheckboxItem = { id: match.id, label: match.name, description: text.authorMatch(match, metrics.get(match.id) ?? {}) };
					authorFacts.set(match.id, { name: match.name, row });
					return row;
				});
				return [...pickedRows, ...rows];
			},
			loadingNote: text.authorLookupLoading,
			idleNote: text.authorLookupIdle,
			emptyNote: text.authorLookupNone,
			failedNote: text.authorLookupFailed,
		}, {
			// The author list at the top (group loader, loads when the tab is
			// reached): one facet request over the query's works plus one
			// batched author lookup for the open metrics, scoped by the live
			// period AND the picked journals. Rows arrive ticked (exclusion
			// list: unticking excludes), ranked by the author's total
			// citations (the title says so), and grey out once an author is
			// picked below -- a pick is a filter of its own, the list is moot.
			step: "author_pick",
			group: AUTHOR_LIST_GROUP,
			arriveChecked: true,
			key: (answers) => {
				const query = composedQuery(answers).query;
				if (!query) return "";
				return `${query.toLowerCase()}|${
					scopeKey({ ...liveYearScope(answers), sourceIds: livePickedSourceIds(answers) })}`;
			},
			load: async (answers) => {
				const page = await authorFacets(composedQuery(answers).query, AUTHOR_PICK_LIMIT, {
					...liveYearScope(answers),
					sourceIds: livePickedSourceIds(answers),
				});
				const metrics = await fetchAuthorMetrics(page.listed.map((facet) => facet.id), () => {});
				const ranked = [...page.listed].sort((a, b) =>
					(metrics.get(b.id)?.cites ?? -1) - (metrics.get(a.id)?.cites ?? -1) || b.count - a.count);
				listedAuthors = ranked.map((facet) => facet.name);
				const noPick = (live: WizardAnswers): boolean => !hasPickedAuthor(live);
				const items: CheckboxItem[] = ranked.map((facet) => ({
					id: facet.name,
					label: `${facet.name} ${text.authorItem(facet.count, metrics.get(facet.id) ?? {})}`,
					enabledIf: noPick,
				}));
				return items.length
					? [...items, {
						id: AUTHOR_OTHER_ID,
						label: `${text.authorOther} ${text.authorItem(page.otherCount, {})}`,
						enabledIf: noPick,
					}]
					: items;
			},
			loadingNote: text.authorLoading,
			idleNote: "",
			emptyNote: text.authorNoneFound,
			failedNote: text.authorFetchFailed,
		}],
	});
	if (result === null) {
		diagnostics.push("intake dialog: cancelled by the user");
		return null;
	}
	const values: IntakeValues = { ...proposed, query };
	// WYSIWYG: the query the tab shows at submit is the query that runs --
	// the same composition the loaders and the summary line used live (free
	// text wins, else the blocks serialize) -- and an EMPTY query cancels
	// honestly on every path.
	values.query = composedQuery(result).query;
	if (!values.query) {
		ctx.ui.notify(text.noQuery, "warning");
		diagnostics.push("intake dialog: submitted without a query");
		return null;
	}
	// Query variants: exactly the checked rows minus the locked base row --
	// the run searches base + checked variants. The engine dedupes against
	// the base query again (belt and braces).
	const pickedVariantRows = Array.isArray(result.variants) ? (result.variants as string[]) : [];
	const pickedVariants = pickedVariantRows.filter((id) =>
		id !== VARIANT_BASE_ID && id.trim().toLowerCase() !== values.query.toLowerCase());
	values.queryVariants = pickedVariants.length ? pickedVariants : undefined;
	// Blocks/grouping: the ENGINE derives every query's concept blocks
	// itself (expression parsed, plain keywords word-per-block) -- they
	// drive the boolean fetch AND the labeling. Only an agent group_terms
	// proposal overrides the BASE query's blocks.
	values.groupTerms = proposed.groupTerms?.length ? proposed.groupTerms : undefined;
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
	// free-entry input of the "custom" row.
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
	// Code tab: the checked sources while the head is on, else nothing
	// (the reducer exports an empty list for a closed head).
	const codeRows = Array.isArray(result.code) ? (result.code as string[]) : [];
	const codePicked = codeRows.filter((id) => id in CODE_SEARCHERS);
	values.codeSources = codePicked.length ? codePicked : undefined;
	// The ticked topic rows under "Curated lists" are what the source reads
	// -- exactly the rows shown, an empty tick set reads nothing. Without
	// offered rows (RPC fallback) the config default applies.
	const topicRows = codeRows.filter((id) => !(id in CODE_SEARCHERS)).map(topicSlug).filter(Boolean);
	values.codeListTopics = topicsOffered && codePicked.includes(CODE_LIST_SOURCE)
		? [...new Set(topicRows)]
		: undefined;
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
	// The journal-score filter is not shown in the dialog; WYSIWYG forbids
	// silently applying an agent-passed value the wizard never showed. The
	// tool param keeps working on headless runs.
	values.minJournalScore = undefined;
	// Author tab. (1) Picked authors from the lookup: names for the
	// post-filter/CrossRef/arXiv, OpenAlex ids for the exact filter; the
	// position boxes (both = any) and the scope box. (2) The list at the
	// top, only without a pick (its rows are greyed out and off the result
	// once an author is picked): ticked listed names plus the catch-all
	// row -- every row ticked means no exclusion at all.
	const authorRows = Array.isArray(result.author_pick) ? (result.author_pick as string[]) : [];
	const pickedIds = authorRows.filter((id) => authorFacts.has(id));
	values.authorIds = pickedIds.length ? pickedIds : undefined;
	values.pickedAuthors = pickedIds.length ? pickedIds.map((id) => authorFacts.get(id)!.name) : undefined;
	const first = authorRows.includes(AUTHOR_POS_FIRST);
	const contributing = authorRows.includes(AUTHOR_POS_CONTRIB);
	values.authorPosition = !pickedIds.length || first === contributing ? undefined : first ? "first" : "contributing";
	values.authorScope = pickedIds.length && authorRows.includes(AUTHOR_SCOPE_ALL) ? "all" : undefined;
	const listOn = !pickedIds.length && listedAuthors.length > 0;
	const listedRows = listOn ? authorRows.filter((id) => listedAuthors.includes(id)) : [];
	const listedOther = listOn && authorRows.includes(AUTHOR_OTHER_ID);
	// The agent's name proposal keeps its post-filter role only while no
	// author was picked (a pick is the more precise statement).
	const typedAuthors = pickedIds.length ? [] : (proposed.authors ?? []).map((name) => name.trim()).filter(Boolean);
	const wantedAuthors = [...listedRows, ...typedAuthors];
	if (!listOn || (listedOther && listedRows.length >= listedAuthors.length)) {
		values.authors = typedAuthors.length ? typedAuthors : undefined;
		values.authorsOther = undefined;
		values.authorsListed = undefined;
	} else if (listedOther) {
		values.authors = wantedAuthors.length ? wantedAuthors : undefined;
		values.authorsOther = true;
		values.authorsListed = listedAuthors;
	} else {
		values.authors = wantedAuthors.length ? wantedAuthors : undefined;
		values.authorsOther = undefined;
		values.authorsListed = undefined;
	}
	// Journal filter: exactly what the tab shows checked (an agent proposal
	// arrives as prechecked rows via the loader's preselect); empty = no
	// filter. The list carries an explicit "other journals/sources" row --
	// with it checked, journals outside the list pass too, and checking
	// EVERY row is literally no filter ("all" can never exclude anything).
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
	// "Edited" compares against the COMPOSED prefill: a block-expression
	// proposal is canonicalized on its way into the fields (uniform
	// parens/OR), so the raw param string would read as an edit.
	const prefillComposed = prefillBlocks
		? queryFromBlockAnswers(prefillBlocks, "").query
		: query.trim();
	diagnostics.push(
		values.query === prefillComposed
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
			tuiText = Text as unknown as new (text: string) => unknown;
			// A raw file:// URL WRAPS across card lines in narrow terminals and
			// the click target breaks. Display-only fix: the card renders the
			// URL as an OSC 8 hyperlink with the short basename as its text --
			// short text never wraps. pi-tui explicitly supports OSC 8
			// (visibleWidth strips it, the wrap tracker re-opens it per line;
			// BEL terminator because some terminals only click BEL-terminated
			// links). The digest STRING stays a plain URL (LLM context, widget
			// fallback, protocol).
			const linkified = (line: string): string => {
				const match = line.match(/file:\/\/\S+/);
				if (!match) return line;
				const url = match[0];
				let label = url.split("/").pop() || url;
				try {
					label = decodeURIComponent(label);
				} catch {
					// keep the raw basename
				}
				return line.replace(url, `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`);
			};
			const buildCard = (data: { heading: string; text: string }, theme: { bg(color: string, line: string): string; bold(text: string): string }) => {
				const box = new Box(1, 1, (line: string) => theme.bg("customMessageBg", line));
				box.addChild(new Text(theme.bold(data.heading)));
				for (const line of data.text.split("\n")) box.addChild(new Text(linkified(line)));
				return box;
			};
			pi.registerEntryRenderer(DIGEST_ENTRY, (entry, _state, theme) =>
				buildCard(entry.data as { heading: string; text: string }, theme));
			// The command-path digest travels as a custom MESSAGE (display,
			// LLM context and /resume persistence in one call); this renderer
			// draws the SAME card from message.details, so the user never sees
			// the agent-facing turn note in `content`.
			pi.registerMessageRenderer(DIGEST_ENTRY, (message, _options, theme) =>
				message.details ? buildCard(message.details as { heading: string; text: string }, theme) : undefined);
			digestEntryReady = true;
		} catch {
			// pi-tui unavailable -> the capped widget fallback stays.
		}
	})();
	pi.registerTool({
		name: "pi-literature-search",
		label: "Literature Search",
		description:
			"Search academic literature (arXiv, CrossRef, OpenAlex, Semantic Scholar): clean, deduplicated, HTTP-verified results, " +
			"written to disk by fixed code. " +
			"This tool DISCOVERS NEW papers in online databases. It is NOT for papers already on disk: when the " +
			"user wants to chat about, ask about or understand ONE local PDF ('zu einem Paper chatten', 'Frage zum " +
			"Paper'), use pi-literature-synthesis (chat mode); for a summary or review across the local PDF library, use " +
			"pi-literature-synthesis; for downloading found papers, use pi-literature-selection. " +
			"Call this tool DIRECTLY; do NOT ask intake or clarification questions in chat first. On every call the " +
			"tool itself shows the user a terminal wizard summarizing the proposed query (editable there -- the " +
			"user's wording wins), query variants, year range, result count and optional filters (min citations, " +
			"journal picks, author names), where the user confirms or adjusts everything before the search " +
			"runs. Your job is only to propose sensible parameters. If the result says " +
			"the user cancelled the dialog, ask what they want to change; do not retry unchanged. " +
			"The tool result is a short digest only: counts, the HTML file path, and one reference line per record " +
			"(group flag, year, DOI/arXiv ID, title). Lines marked UNVERIFIED did not resolve at doi.org/arxiv.org; " +
			"treat them with suspicion and say so. Every run writes a deterministic HTML rendering (sortable table, " +
			"abstracts, links, dropped list) to lit-search/<date>_<query>.html in the working directory " +
			"(root overridable via PI_LITERATURE_REVIEW_HOME; exact path via html_file), plus a machine-readable .json " +
			"copy of the full results with the same basename - read that file for structured follow-up steps, but do " +
			"not mention its path to the user. The HTML file is where the user reviews and selects papers: tell them " +
			"its path. When you refer to a record, copy its digest line EXACTLY; never re-type, complete or invent " +
			"titles, authors, years or identifiers, never build your own results table, and never add key findings, " +
			"methodology advice, next steps or deliverables - this tool only discovers literature. " +
			"group_terms sort results into on_target/adjacent by deterministic word rules: a record is on_target when " +
			"at least one term from EVERY group appears in its title or abstract. PROPOSE group_terms on every call: " +
			"derive one group per required concept from the user's research question, each with OR synonyms, e.g. for " +
			'river sandbars via Sentinel: [["river","fluvial"],["sandbar","bar"],["sentinel","s-1","s-2"]]. Your ' +
			"proposal is used as passed and becomes the BASE query's concept blocks: it labels on_target/adjacent " +
			"AND is sent as a boolean block search to sources that support it (arXiv, OpenAlex; CrossRef gets the " +
			"flat terms). Without one the blocks derive deterministically from the confirmed query. The wizard's " +
			"query tab shows the query as editable keyword-block fields (one concept per field, AND between them) " +
			"plus a free-text field; a block expression passed as query prefills the block fields, anything else " +
			"prefills the free text. " +
			"If results disappoint, refine group_terms or filters in a new call; NEVER pad the list with loosely " +
			"related papers to reach a count.",
		promptSnippet:
			"Search academic literature; writes verified results to an HTML/JSON pair and returns a short digest",
		parameters: Type.Object({
			query: Type.String({
				description: "Literature search query (topic keywords)",
			}),
			query_variants: Type.Optional(Type.Array(Type.String(), {
				description: "Alternative searches for the SAME information need, searched in the same run. Each variant may be a concept-block boolean expression like '(river OR stream) AND (water extraction OR water mapping)' -- boolean-capable sources (arXiv, OpenAlex) then receive it as a real boolean query and each record is labeled against the blocks of the variant that found it (found_by). Plain keyword variants work too. Results are deduplicated across all variants by fixed code. On interactive calls your variants appear as PREchecked rows in the wizard's query-variants tab and the user-confirmed list is what runs; headless calls use them directly. Use for exhaustive sweeps instead of separate tool calls.",
			})),
			per_source: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: MAX_PER_SOURCE,
				description: `Results per source, default ${DEFAULT_PER_SOURCE}, capped at ${MAX_PER_SOURCE} (politeness towards the free APIs)`,
			})),
			sources: Type.Optional(Type.Array(Type.String(), {
				description: `Sources to query, default all of: ${Object.keys(SEARCHERS).join(", ")}`,
			})),
			code_sources: Type.Optional(Type.Array(Type.String(), {
				description: `Code-first sources: search code repositories FIRST and resolve the papers they cite (repository link attached, metadata from arXiv/OpenAlex). Use when the user asks for papers WITH code / implementations. Any of: ${Object.keys(CODE_SEARCHERS).join(", ")}. Default: none (adds 30-90 s per run). In the wizard this only prefills the Code tab.`,
			})),
			code_list_topics: Type.Optional(Type.Array(Type.String(), {
				description: "GitHub topics of the research FIELD whose curated awesome lists the awesome-lists code source reads (e.g. remote-sensing, bioinformatics -- fields, not query words). Prefills the topic rows of the Code tab; default from the config.",
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
				description: "Papers by these authors (names): in the wizard the first name prefills the author lookup of the Authors tab (the user picks the exact person); headless the names go into each source's author search field (arXiv au:, CrossRef query.author, OpenAlex raw_author_name.search) plus a deterministic post-filter (author name contains the string, case-insensitive). Use when the user asks for papers by a specific author or group.",
			})),
			author_ids: Type.Optional(Type.Array(Type.String(), {
				description: "OpenAlex author ids (A5059343226) of the wanted authors, together with their names in `authors`: OpenAlex then filters by id (exact person). Headless only; the wizard resolves the person itself.",
			})),
			author_position: Type.Optional(Type.String({
				description: "Required position of the wanted author: \"first\", \"contributing\" (any position but the first) or \"any\" (default). Only with `authors`.",
			})),
			author_scope: Type.Optional(Type.String({
				description: "\"all\" = every publication of the wanted authors regardless of the query (OpenAlex by id citation-sorted, CrossRef/arXiv by name; Semantic Scholar is skipped and noted); default \"query\" = author AND query. Only with `authors`.",
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
				description: "Override for the HTML output path. Default (recommended): omit, and the deterministic location lit-search/<date>_<query>.html in the working directory is used. The page is generated from the JSON payload by fixed code, never by a model.",
			})),
			enrich: Type.Optional(Type.Boolean({
				description: "Fill missing citation counts / journal names via a deterministic OpenAlex identifier lookup (open API, no scraping), and attach code repository links (abstract URL, else a guarded GitHub search per arXiv id or DOI). Filled fields are listed per record under 'enriched' and marked with * in the HTML. Default: true.",
			})),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const diagnostics: string[] = [];
			// Progress: every pipeline diagnostic doubles as a live status line
			// in the UI (per-source counts, verification, enrichment).
			const report = (message: string) => {
				diagnostics.push(message);
				onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
			};
			let confirmed: IntakeValues = {
				query: params.query,
				queryVariants: params.query_variants,
				groupTerms: params.group_terms,
				yearFrom: params.year_from,
				yearTo: params.year_to,
				perSource: params.per_source,
				minCites: params.min_cites,
				minJournalScore: params.min_journal_score,
				venues: params.venues,
				authors: params.authors,
				// Headless author scope: the names double as the picked
				// authors (post-filter, CrossRef, arXiv), the ids drive
				// OpenAlex; unknown position/scope strings fall back to the
				// defaults (a strict enum would kill the call before this code).
				...(params.authors?.length && (params.author_ids?.length || params.author_position || params.author_scope)
					? {
						pickedAuthors: params.authors,
						authorIds: params.author_ids?.length ? params.author_ids : undefined,
						authorPosition: params.author_position === "first" || params.author_position === "contributing" ? params.author_position : undefined,
						authorScope: params.author_scope?.trim().toLowerCase() === "all" ? "all" as const : undefined,
					}
					: {}),
				codeSources: params.code_sources?.length ? params.code_sources : undefined,
				codeListTopics: params.code_list_topics?.length ? params.code_list_topics : undefined,
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
			// The wizard-confirmed values run -- not the raw agent params;
			// headless calls keep the params via the confirmed seed above.
			const payload = await runSearch({
				...searchOptionsFor(confirmed),
				sources: params.sources,
				filters: {
					...filtersFor(confirmed),
					requirePdf: params.require_pdf,
					verifiedOnly: params.verified_only,
				},
				sort: params.sort === "cites" || params.sort === "year" ? params.sort : undefined,
				enrich: params.enrich,
				onWarn: report,
				signal,
			});
			let htmlPath: string | null = null;
			try {
				const written = writeSearchOutputs(payload, params.html_file);
				htmlPath = written.htmlPath;
				diagnostics.push(`wrote HTML rendering to ${written.htmlPath} and JSON copy to ${written.jsonPath}`);
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
	// whether or how to search; a passed query is prefill on the query tab.
	pi.registerCommand("lit-search", {
		// Palette one-liner (user wording 2026-09-02); details live in docs/search.md.
		description: "Search for academic literature and generate an HTML report of the query results.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const query = (args ?? "").trim();
			const diagnostics: string[] = [];
			// Non-TUI (web) clients render notifications as chat lines; the
			// per-record detail (dropped/enriched/filtered ...) would flood
			// the transcript there and is all in the HTML's dropped list
			// anyway -- only the summary milestones get through. The TUI
			// keeps every line (transient status area).
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
			// Sign of life: pi's native working indicator exists only while
			// the AGENT streams -- the agent-free command path shows a pulsing
			// elapsed line in the widget instead (1s tick, dots building 1-2-3
			// at the END of the line).
			const startedAt = Date.now();
			const ticker = setInterval(() => {
				const seconds = Math.round((Date.now() - startedAt) / 1000);
				const dots = ".".repeat(1 + (seconds % 3));
				const base = `working -- ${seconds}s elapsed -- searching, verifying, enriching`;
				// Dim line, the building dots in the accent color (theme
				// colors only); plain text where pi-tui is unavailable.
				const TextComponent = tuiText;
				if (TextComponent && ctx.mode === "tui") {
					ctx.ui.setWidget(INTAKE_WIDGET, (_tui, theme) => {
						let painted = base + dots;
						try {
							const fg = (theme as { fg(color: string, text: string): string }).fg;
							painted = fg.call(theme, "dim", base) + fg.call(theme, "accent", dots);
						} catch {
							// unknown color key in a custom theme -> plain text
						}
						return new TextComponent(painted) as never;
					});
				} else {
					ctx.ui.setWidget(INTAKE_WIDGET, [base + dots]);
				}
			}, 1000);
			try {
				const payload = await runSearch({
					...searchOptionsFor(confirmed),
					filters: filtersFor(confirmed),
					onWarn: progress,
					signal: ctx.signal,
				});
				clearInterval(ticker);
				ctx.ui.setWidget(INTAKE_WIDGET, undefined);
				let htmlPath: string | null = null;
				try {
					htmlPath = writeSearchOutputs(payload).htmlPath;
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
				// The digest for the USER (no agent instructions on the card).
				const digest = renderDigest(payload, htmlPath, "user");
				// TUI: ONE custom message is display (the card renderer draws
				// details), verbatim LLM context and /resume persistence at
				// once; triggerTurn prompts ONE brief agent summary under the
				// card (the note forbids re-typing identifiers/paths).
				if (digestEntryReady && ctx.mode === "tui") {
					pi.sendMessage({
						customType: DIGEST_ENTRY,
						content: `${searchTurnNote()}\n\n${digest}`,
						display: true,
						details: {
							heading: `Literature search -- ${confirmed.query}`,
							text: digest,
						},
					}, { triggerTurn: true });
				} else {
					const digestLines = digest.split("\n");
					ctx.ui.setWidget(INTAKE_WIDGET, digestLines.length > 16
						? [...digestLines.slice(0, 15), `... (${digestLines.length - 15} more lines -- full results in the HTML)`]
						: digestLines);
					// Web/RPC clients render neither widgets nor entry cards,
					// and their notify toasts vanish after seconds -- but an
					// AGENT answer is a real session message every client
					// shows and replays. So outside the TUI the deterministic
					// run ends by handing the finished digest to the agent as
					// its display layer; the SEARCH stays agent-free, the
					// agent only presents the result.
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
