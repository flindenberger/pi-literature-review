/**
 * The chat dialog of the web interface as a pure state machine: which
 * question is open, what the assistant said, which answer chips are
 * offered, and what the server has to do next (ask the model for keyword
 * blocks, load journals, start a job). The order and wording of every
 * question live HERE in code; the model only proposes content (keyword
 * blocks, query variants) and, through the engines, writes grounded
 * answers. Free-text answers are read by fixed parsers (years, numbers,
 * "all", identifiers) -- nothing is guessed from them.
 *
 * reduce(state, event, ctx) returns the next state plus a list of
 * effects. The server runs the effects and feeds their outcomes back as
 * events; this module never touches the network, the disk or a model.
 * (src/dialog-state.ts is the terminal wizard's state and unrelated.)
 */

import { CODE_SEARCHERS } from "../codesearch.ts";
import { detectDialogLang, type DialogLang } from "../dialog-state.ts";
import {
	blocksForEditing,
	deriveGroupsFromQuery,
	isBlockExpression,
	parseGroupSpec,
	parsePerSource,
	parseYearRange,
	queryFromBlockAnswers,
	topicSlug,
	type VariantSuggestion,
} from "../intake.ts";
import { MAX_AUTHOR_WORKS_PER_SOURCE, MAX_PER_SOURCE } from "../search.ts";
import { type Candidate, parsePickAnswer, pickedIds } from "../pick.ts";
import type { AuthorMatch } from "../sources/openalex.ts";
import type { AnsweredQuestion, ChatAnswer } from "../synthesis.ts";
import type { Stage } from "./files.ts";
import type { SearchForm } from "./intake.ts";
import type { BlockMode } from "./blockcache.ts";
import type { JobInfo } from "./jobs.ts";
import { fallbackText, helpPrompt, HELP_SYSTEM, looksLikeQuestion, looksLikeSmallTalk, navigationChips, navigationIntent, STEP_ACCEPTS } from "./help.ts";

/* ------------------------------------------------------------------ *
 * Types                                                               *
 * ------------------------------------------------------------------ */

export type StepId =
	| "start" | "topic" | "blocks" | "code" | "codeSources" | "topics" | "period"
	| "journals" | "authors" | "authorScope" | "confirm" | "searching"
	| "pick" | "mailto" | "mailtoSave" | "download" | "downloading"
	| "pickPaper" | "pickPapers" | "questions" | "ask" | "answering"
	| "reportKind" | "reporting" | "finished" | "confirmRestart";

export interface Chip {
	id: string;
	label: string;
	primary?: boolean;
	/** Toggle chips are ticked on and off; the answer carries the ticked ids. */
	toggle?: boolean;
	on?: boolean;
	disabled?: boolean;
	title?: string;
}

export interface FileCard {
	kind: "file" | "folder";
	/** File name (file card) or folder name such as "lit-search/" (folder card). */
	name: string;
	/** Second line: "Search report, HTML · lit-search/" or the PDF count. */
	label: string;
	stage: Stage;
	/** Server address of the page (file cards only). */
	url?: string;
	/** Folder cards of a user folder: its full path (shown in the file manager by path). */
	path?: string;
}

export interface AnswerView {
	answer: ChatAnswer;
	hrefs: Array<string | null>;
	pdfUrls: Record<string, string>;
}

/** A vertical list of tickable items (journals, authors, topics, papers);
 * the answer carries the ticked ids as `toggles`. */
export interface ListBlock {
	items: Array<{ id: string; label: string; on: boolean }>;
	/** Radio behaviour: exactly one item. */
	single?: boolean;
	/** Shown expanded (short lists, pickers) or collapsed behind `summary`. */
	open: boolean;
	summary: string;
}

export interface Message {
	id: number;
	role: "assistant" | "user" | "working" | "answer" | "card" | "results" | "divider";
	/** Plain text; the browser renders **bold** and `code` only. */
	text?: string;
	/** Smaller second paragraph. */
	note?: string;
	chips?: Chip[];
	/** Editable keyword-block lines (one block per line). */
	editor?: string[];
	/** Toggle chips behave like radio buttons. */
	single?: boolean;
	list?: ListBlock;
	/** The step this message asked for; chips of older messages are spent. */
	step?: StepId;
	/** Working messages: the job whose progress lines the browser attaches. */
	job?: string;
	jobLabel?: string;
	jobState?: JobInfo["state"];
	card?: FileCard;
	/** Results messages: the search run whose cards the browser loads (GET /api/runs/cards). */
	run?: string;
	answer?: AnswerView;
	spent?: boolean;
	/** A help answer (question channel): written by the model over the
	 * step's help text, or the fixed help text itself. */
	help?: "model" | "fixed";
	/** Request question reopened after a stopped search: the request text the
	 * browser puts back into the box (its "+" options come from the answers). */
	prefill?: string;
	/** Stage-1 steps after a search (pick, contact, download, its progress
	 * and result): the browser handles them in a dialog window over the
	 * result list and keeps them out of the chat thread. */
	quiet?: boolean;
}

export interface JournalRow {
	id: string;
	name: string;
	works: number;
	score: number | null;
}

export interface AuthorRow {
	id: string;
	name: string;
	works: number;
	cites?: number;
	hIndex?: number;
}

export interface TopicRow {
	topic: string;
	lists: number | null;
}

export interface LibraryItem {
	base: string;
	title: string;
	year: string | null;
	authors: string[];
}

export type { Candidate } from "../pick.ts";

export interface SearchOutcome {
	name: string;
	htmlUrl: string;
	included: number;
	dropped: number;
	candidates: Candidate[];
}

export interface DownloadOutcome {
	downloaded: number;
	already: number;
	browser: Array<{ id: string; url: string }>;
	notFree: number;
	failed: number;
	libraryCount: number;
	/** The folder the PDFs went to. */
	folder?: string;
}

export interface ReportOutcome {
	name: string;
	htmlUrl: string;
	grounded: boolean;
	units: number;
}

/** The period button next to the request box. */
export type PeriodPreset = "5y" | "10y" | "20y" | "all";
const PERIOD_PRESETS: readonly string[] = ["5y", "10y", "20y", "all"];

export interface PeriodChoice {
	preset: PeriodPreset | "custom";
	yearFrom?: number;
	yearTo?: number;
}

export interface DialogAnswers {
	topic: string;
	blocks: string[];
	variants: VariantSuggestion[];
	useVariants: boolean;
	codeSources: string[];
	topics: TopicRow[];
	topicsOn: string[];
	/** "Add papers with code": the suggested list topics are taken without asking. */
	autoTopics: boolean;
	/** The code icon next to the request box: the first search runs with the code sources. */
	codeAtStart: boolean;
	/** The synonym button next to the request box: the model adds synonyms
	 * and the blocks are shown for editing before the search. Off, the
	 * blocks hold only the request's own words and the search starts at once. */
	synonyms: boolean;
	period: PeriodChoice;
	journals: JournalRow[];
	journalsOn: string[] | "all";
	authors: AuthorRow[];
	authorsOn: string[] | "all";
	authorMatches: AuthorMatch[];
	/** Authors picked by name or from the menu list: exact OpenAlex ids. */
	pickedAuthors: AuthorMatch[];
	authorScope: "query" | "all";
	/** "first": only papers with a picked author as first author. */
	authorPosition?: "first" | "any";
	perSource: number;
	minCites: number | null;
	search: SearchOutcome | null;
	pickIds: string[];
	mailto: string;
	saveMailto: boolean;
	withoutUnpaywall: boolean;
	/** Chat / report scope: library paper basenames or the whole library. */
	scope: string[] | "library";
	questions: string[];
	lastQuestion: string;
	/** A report was started in this conversation (names it in History). */
	reported?: boolean;
	/** The chat's report is being written (the parts asked for). */
	reportRequest?: ReportParts;
	/** Sent with a question: the report to write once the answer is in. */
	reportAfter?: ReportParts;
	/** The chat's ONE report: its HTML url, the parts it holds and how many
	 * questions it answers (a newer question or other parts = "Update"). */
	report?: { url: string; parts: ReportParts; questions: number; job?: string; at?: string };
	/** Older pages: the newest report of each button, as its HTML url. */
	reports?: Partial<Record<"summary" | "synthesis", string>>;
	/** The "+" menu's name for the scope ("01_Waterline", "3 papers"). */
	scopeLabel?: string;
	/** A chat on one PDF: the paper in short ("Lee and Kim 2021 · Title"),
	 * from its metadata; names the conversation in History. */
	paperLabel?: string;
}

export interface DialogState {
	step: StepId;
	answers: DialogAnswers;
	messages: Message[];
	/** Job id the dialog waits for, if any. */
	activeJob: string | null;
	/** Label of the effect the server is running (model call, lookup). */
	pending: string | null;
	/** Steps asked so far ("back" returns to the previous one). */
	trail: StepId[];
	counter: number;
	/** The parser's note while a help answer is pending (shown first). */
	helpNote?: string | null;
}

export type DialogEvent =
	/** `ask`: the text is a question for the helper, not an answer (question
	 * mode on the page, or a leading "?"). */
	| { kind: "answer"; text?: string; chip?: string; ids?: string[]; blocks?: string[]; toggles?: string[]; ask?: boolean; filters?: SearchAgainFilters; code?: boolean; synonyms?: boolean; period?: PeriodPreset; options?: SearchOptionsAnswer; folder?: string; chat?: ChatOptionsAnswer }
	/** A file the server wrote on the user's click (report from the list): shown as a card. */
	| { kind: "fileWritten"; card: FileCard; quiet?: boolean }
	| { kind: "helpAnswered"; text: string | null; error?: string }
	| { kind: "blocks"; variants: VariantSuggestion[] | null; error?: string }
	| { kind: "topics"; topics: TopicRow[]; error?: string }
	| { kind: "journals"; journals: JournalRow[]; error?: string }
	| { kind: "authors"; authors: AuthorRow[]; error?: string }
	| { kind: "authorLookup"; matches: AuthorMatch[]; error?: string }
	| { kind: "jobStarted"; job: JobInfo }
	| { kind: "job"; job: JobInfo; search?: SearchOutcome; download?: DownloadOutcome; answer?: AnswerView; report?: ReportOutcome; reply?: string }
	| { kind: "effectFailed"; effect: Effect["kind"]; error: string }
	/** `start`: open the new conversation at that stage's first question
	 * (the rail's "+ New search" / "+ New paper chat") instead of the start screen. */
	| { kind: "restart"; start?: StartStage; scope?: string[]; about?: string; label?: string };

export type StartStage = "search" | "synthesis";

/** "Search again with these filters" from the result list: the parts of
 * the list filters that change what the sources return. */
export interface SearchAgainFilters {
	/** Publication window start; `allYears` lifts the window. */
	yearFrom?: number;
	allYears?: boolean;
	minCites?: number;
}

export type Effect =
	/** `mode` "own": the request's own words only; "synonyms": with the
	 * model's synonyms. `fresh`: ask the model even when blocks are saved. */
	| { kind: "proposeBlocks"; query: string; mode: BlockMode; fresh?: boolean }
	| { kind: "loadTopics"; query: string }
	| { kind: "loadJournals"; query: string; yearFrom?: number; yearTo?: number }
	| { kind: "loadAuthors"; query: string; yearFrom?: number; yearTo?: number; sourceIds: string[] }
	| { kind: "lookupAuthor"; prefix: string }
	| { kind: "startSearch"; form: SearchForm }
	| { kind: "startSelection"; identifiers: string[]; mailto?: string; saveMailto?: boolean; withoutUnpaywall: boolean; folder?: string }
	| { kind: "startChat"; question: string; papers: string[] | "library" }
	/** `language`: the report's prose and page headings follow the language
	 * of the user's own questions (German or English, like the terminal
	 * wizard follows the chat); the chat itself stays English. */
	| { kind: "startReport"; papers: string[] | "library"; questions: string[]; summary: "bullets" | "none"; detailMode: "per-paper" | "cross-paper" | "both"; includeReview: boolean; language: DialogLang; answered?: AnsweredQuestion[]; letters?: Record<string, string> }
	| { kind: "newChatSession" }
	/** One model call over the step's help text; the reducer built both
	 * prompts, the server only runs the model. */
	| { kind: "helpAnswer"; step: StepId; question: string; system: string; user: string };

/** What the server knows at reduce time; read fresh on every event. */
export interface DialogContext {
	thisYear: number;
	hasModel: boolean;
	/** "qwen3:8b via Ollama" -- shown in the opening line. */
	modelLabel: string | null;
	/** How to pick a model when none is selected (pi vs standalone). */
	noModelHint: string;
	mailtoSet: boolean;
	library: LibraryItem[];
	/** Text search sources that run (key-free). */
	sources: string[];
	/** Sources that need a key the user has not set. */
	sourcesSkipped: string[];
	storedTopics: string[];
}

export interface ReduceResult {
	state: DialogState;
	effects: Effect[];
}

/* ------------------------------------------------------------------ *
 * Fixed texts and defaults                                            *
 * ------------------------------------------------------------------ */

export const DEFAULT_PER_SOURCE_WEB = 30;
/** How many journals / authors the facet lookups should load. */
export const FACET_LIMIT = 30;

export const CODE_SOURCE_LABELS: Record<string, string> = {
	"hf-papers": "Hugging Face Papers",
	"github-readme": "GitHub README search",
	"awesome-lists": "Awesome lists (awesome.ecosyste.ms)",
	"gee-github": "Google Earth Engine (GitHub)",
};

const TEXT = {
	start: "What would you like to do today?",
	topic: "What are you looking for? A sentence or keywords are both fine.",
	blocks: "Is it ok if I split your request into these keyword blocks? A paper must match **every** block; the words inside a block are alternatives.",
	blocksSynonyms: "The model added synonyms to your keyword blocks. Change, add or remove terms, then search. A paper must match **every** block; the words inside a block are alternatives.",
	blocksDerived: "No model is selected, so the blocks were derived word by word from your text.",
	blocksModelFailed: "The model gave no usable proposal, so the blocks were derived word by word from your text.",
	code: "Do you also want **papers with code**? I can additionally search code repositories and add the papers they cite: Hugging Face Papers, GitHub README search, awesome lists, Google Earth Engine repositories. Adds up to about 40 s.",
	codeSources: "Which code sources?",
	topics: "For the awesome lists I would look at these GitHub topics. Keep them, add one (type a word), or skip the lists?",
	period: "Which publication period?",
	periodUnclear: "I did not understand the years. Type a range such as 2015-2024, 2015- or 2020, or pick a button.",
	journals: "These journals publish most on your topic (OpenAlex). Search all of them or only some?",
	journalsNone: "OpenAlex listed no journals for these blocks, so every journal stays in.",
	authors: "Authors with the most works on this topic (OpenAlex). Search all authors or focus on some?",
	authorsNone: "OpenAlex listed no authors for these blocks, so every author stays in.",
	authorScope: "Also include this author's works outside your topic?",
	confirmSearch: "Search",
	searching: "Searching ...",
	pick: "Which papers do you want as PDFs? Tick them in the list above, or type row numbers (1, 4, 7), DOIs or arXiv ids. `all` takes every on-target paper, `code` every paper with a code or data link.",
	pickNoTicks: "Nothing is ticked yet. Tick papers in the list above, or type row numbers or identifiers.",
	pickUnclear: "I did not recognise that as row numbers, DOIs or arXiv ids. Example: 1, 4, 7 or 10.3390/rs13081505.",
	mailto: "Unpaywall needs a contact email (its policy). Type it, or continue without Unpaywall.",
	mailtoBad: "That does not look like an email address. Type one, or continue without Unpaywall.",
	mailtoSave: "Save this address in the configuration for next time, or use it for this run only?",
	ask: "Ask anything. Responses rely solely on passages retrieved from your sources and include exact citations.",
	askNoModel: "No model is selected, so I cannot answer questions right now.",
	pickPaper: "Which PDF do you want to talk about?",
	pickPapers: "Which papers should the report cover? Tick them, or take the whole library.",
	questions: "Which questions should the report answer for every paper? One per line, or choose summaries only.",
	reportKind: "Which report?",
	finished: "Ask another question, or start a new search.",
	wait: "Please wait for the running job, or press Stop.",
	confirmRestart: "Start over? The conversation is cleared; files on disk stay.",
	noLibrary: "no PDFs yet: search first, add a PDF folder, or drop PDFs onto the page",
	emptyLibraryDownload: "Nothing could be downloaded, and the library is empty.",
};

/* ------------------------------------------------------------------ *
 * Parsers (exported for the tests)                                    *
 * ------------------------------------------------------------------ */

/** Period answer: a preset chip id or a typed year range. Null = unclear. */
export function parsePeriodAnswer(text: string, thisYear: number): PeriodChoice | null {
	const t = text.trim().toLowerCase();
	if (!t) return null;
	if (/^(all|all years|any|no limit)$/.test(t)) return { preset: "all" };
	const years = /^(?:last\s+)?(\d{1,2})\s*(?:years?|y)$/.exec(t);
	if (years) {
		const n = Number(years[1]);
		if (n === 5 || n === 10 || n === 20) return { preset: `${n}y` as PeriodChoice["preset"], yearFrom: thisYear - (n - 1) };
		return { preset: "custom", yearFrom: thisYear - (n - 1) };
	}
	const range = parseYearRange(t);
	if (!range) return null;
	if (range.yearFrom === undefined && range.yearTo === undefined) return { preset: "all" };
	return { preset: "custom", ...range };
}

/** Year range of a period choice (for the facet lookups and the form). */
export function periodYears(period: PeriodChoice, thisYear: number): { yearFrom?: number; yearTo?: number } {
	if (period.preset === "all") return {};
	if (period.preset === "custom") return { yearFrom: period.yearFrom, yearTo: period.yearTo };
	const back = { "5y": 4, "10y": 9, "20y": 19 }[period.preset];
	return { yearFrom: thisYear - back };
}

export type ListAnswer = { kind: "all" } | { kind: "picked"; indexes: number[] } | { kind: "none" };

/** A typed answer against a numbered list: "all", numbers ("1, 3, 7"),
 * or a name fragment matched against the labels. "none" = no match. */
export function parseListAnswer(text: string, labels: string[]): ListAnswer {
	const t = text.trim().toLowerCase();
	if (!t) return { kind: "none" };
	if (/^(all|every|everything|no filter|any)$/.test(t)) return { kind: "all" };
	if (/^\d+(\s*[,;\s]\s*\d+)*$/.test(t)) {
		const indexes = [...new Set(t.split(/[^\d]+/).filter(Boolean).map(Number))]
			.filter((n) => n >= 1 && n <= labels.length)
			.map((n) => n - 1);
		return indexes.length ? { kind: "picked", indexes } : { kind: "none" };
	}
	const indexes = labels.map((label, index) => (label.toLowerCase().includes(t) ? index : -1)).filter((index) => index >= 0);
	return indexes.length ? { kind: "picked", indexes } : { kind: "none" };
}

/** Block lines typed as text: one block per line, or one line joined
 * with AND. Empty lines dropped; [] when nothing parses. */
export function parseBlockLines(text: string): string[] {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const source = lines.length > 1 ? lines : lines.length === 1 && /(^|\s)AND(\s|$)/.test(lines[0]) ? parseGroupSpec(lines[0]).map((group) => group.join(" OR ")) : lines;
	return source.map((line) => line.replace(/^\(|\)$/g, "").trim()).filter(Boolean);
}

export { parsePickAnswer, type PickAnswer } from "../pick.ts";

export type Tweak = { kind: "count"; value: number } | { kind: "cites"; value: number } | { kind: "code"; on: boolean } | null;

/** The short commands the summary card accepts. */
export function parseTweak(text: string): Tweak {
	const t = text.trim().toLowerCase();
	let match = /^(?:count|records?|per source)\s+(\d{1,3})$/.exec(t);
	if (match) {
		const value = parsePerSource(match[1], MAX_PER_SOURCE);
		return value === null ? null : { kind: "count", value };
	}
	match = /^(?:cites|citations|min cites)\s+(\d{1,6})$/.exec(t);
	if (match) return { kind: "cites", value: Number(match[1]) };
	match = /^code\s+(on|off)$/.exec(t);
	if (match) return { kind: "code", on: match[1] === "on" };
	return null;
}

/** Report questions typed as text: one per line; a single line holding
 * several questions is split at the question marks. */
export function parseQuestions(text: string): string[] {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length !== 1) return lines;
	const parts = lines[0].split(/\?\s+/).map((part) => part.trim()).filter(Boolean);
	if (parts.length <= 1) return lines;
	return parts.map((part) => (part.endsWith("?") ? part : `${part}?`));
}

/** Is a typed answer one of the global commands? */
export function globalCommand(text: string): "restart" | "back" | null {
	const t = text.trim().toLowerCase();
	if (/^(start over|restart|reset|new search)$/.test(t)) return "restart";
	if (/^(back|undo)$/.test(t)) return "back";
	return null;
}

/* ------------------------------------------------------------------ *
 * The search form from the answers                                    *
 * ------------------------------------------------------------------ */

export function formFromAnswers(answers: DialogAnswers, thisYear: number): SearchForm {
	const years = periodYears(answers.period, thisYear);
	const form: SearchForm = {
		blocks: answers.blocks,
		variants: answers.useVariants ? answers.variants.filter((variant) => variant.role !== "plus1").map((variant) => variant.text) : [],
		period: answers.period.preset === "custom" ? "custom" : answers.period.preset,
		yearFrom: years.yearFrom,
		yearTo: years.yearTo,
		perSource: answers.perSource,
		codeSources: answers.codeSources,
		codeTopics: answers.codeSources.includes("awesome-lists") ? answers.topicsOn : [],
		minCites: answers.minCites ?? undefined,
	};
	if (answers.journalsOn !== "all" && answers.journalsOn.length) {
		const names = answers.journals.filter((row) => (answers.journalsOn as string[]).includes(row.id)).map((row) => row.name);
		form.journals = names;
		form.journalsListed = answers.journals.map((row) => row.name);
		form.journalsOther = false;
	}
	const pickedAuthors = answers.pickedAuthors ?? [];
	if (pickedAuthors.length) {
		form.pickedAuthors = pickedAuthors.map((author) => ({ id: author.id, name: author.name }));
		form.authorScope = answers.authorScope;
		if (answers.authorPosition === "first") form.authorPosition = "first";
	} else if (answers.authorsOn !== "all" && answers.authorsOn.length) {
		form.authors = answers.authors.filter((row) => (answers.authorsOn as string[]).includes(row.id)).map((row) => row.name);
		form.authorsListed = answers.authors.map((row) => row.name);
		form.authorsOther = false;
	}
	return form;
}

/** The composed query shown in the summary and sent to the facets. */
export function composedQuery(answers: DialogAnswers): string {
	return queryFromBlockAnswers(answers.blocks, "").query;
}

/* ------------------------------------------------------------------ *
 * State construction                                                  *
 * ------------------------------------------------------------------ */

function emptyAnswers(): DialogAnswers {
	return {
		topic: "",
		blocks: [],
		variants: [],
		useVariants: false,
		codeSources: [],
		topics: [],
		topicsOn: [],
		autoTopics: false,
		codeAtStart: false,
		synonyms: false,
		period: { preset: "10y" },
		journals: [],
		journalsOn: "all",
		authors: [],
		authorsOn: "all",
		authorMatches: [],
		pickedAuthors: [],
		authorScope: "query",
		perSource: DEFAULT_PER_SOURCE_WEB,
		minCites: null,
		search: null,
		pickIds: [],
		mailto: "",
		saveMailto: false,
		withoutUnpaywall: false,
		scope: "library",
		questions: [],
		lastQuestion: "",
	};
}

export function initialDialog(ctx: DialogContext, start?: StartStage, scope?: string[], about?: string, label?: string): DialogState {
	const state: DialogState = { step: "start", answers: emptyAnswers(), messages: [], activeJob: null, pending: null, trail: [], counter: 0 };
	// "+ New search" / "+ New paper chat": the conversation holds only that
	// stage's first question, no start screen and no echoed stage name.
	if (start === "search") return askTopic(state);
	// PDFs dropped onto the page: a chat over exactly these.
	if (start === "synthesis" && scope && scope.length) return askAsk(withAnswers(state, { scope, ...(label ? { paperLabel: label } : {}) }), ctx, undefined, about);
	if (start === "synthesis") return ctx.library.length ? askAsk(withAnswers(state, { scope: "library" }), ctx) : askNoLibrary(state);
	return ask(state, "start", startMessage(ctx));
}

/** The synthesis stage without PDFs: one line and the way to the search. */
function askNoLibrary(state: DialogState): DialogState {
	return ask(state, "start", { text: "The library holds no PDFs yet. Search first, add a PDF folder (PDF library, + Add folder), or drop PDFs onto the page.", chips: [{ id: "goSearch", label: "Search literature", primary: true }] });
}

function startMessage(ctx: DialogContext): Omit<Message, "id" | "role" | "step"> {
	const n = ctx.library.length;
	const where = ctx.modelLabel ? `Everything runs on your own machine with ${ctx.modelLabel}.` : `No model is selected yet (${ctx.noModelHint}); searching works without one, answers over PDFs need one.`;
	return {
		text: TEXT.start,
		note: `${n ? `Your library holds ${n} PDF${n === 1 ? "" : "s"}.` : "Your library holds no PDFs yet."} ${where}`,
		chips: [
			{ id: "search", label: "Search and select papers", primary: true },
			{ id: "pdfChat", label: "Chat about one PDF", disabled: n === 0, title: n === 0 ? TEXT.noLibrary : undefined },
			{ id: "pdfReport", label: "Report over several PDFs", disabled: n === 0, title: n === 0 ? TEXT.noLibrary : undefined },
		],
	};
}

/* ------------------------------------------------------------------ *
 * Message helpers                                                     *
 * ------------------------------------------------------------------ */

function push(state: DialogState, message: Omit<Message, "id">): DialogState {
	const id = state.counter + 1;
	return { ...state, counter: id, messages: [...state.messages, { ...message, id }] };
}

/** Spend the chips of every earlier assistant message. */
function spend(state: DialogState): DialogState {
	return { ...state, messages: state.messages.map((message) => (message.chips || message.editor || message.list) && !message.spent ? { ...message, spent: true } : message) };
}

/** Open a question: record the step, spend older chips, add the message. */
function ask(state: DialogState, step: StepId, message: Omit<Message, "id" | "role" | "step">): DialogState {
	const trail = state.trail[state.trail.length - 1] === step ? state.trail : [...state.trail, step];
	return push({ ...spend(state), step, trail, pending: null }, { role: "assistant", step, ...message });
}

function say(state: DialogState, text: string, note?: string): DialogState {
	return push(state, { role: "assistant", text, ...(note ? { note } : {}) });
}

const QUIET_STEPS = new Set<StepId>(["pick", "mailto", "mailtoSave", "download", "downloading"]);

function userSaid(state: DialogState, text: string): DialogState {
	return push(spend(state), { role: "user", text, ...(QUIET_STEPS.has(state.step) ? { quiet: true } : {}) });
}

/** A quiet card (a report from the result list, shown in a window over the
 * list) is kept in the conversation but never enters the thread. */
function card(state: DialogState, card: FileCard, quiet = false): DialogState {
	return push(state, { role: "card", card, ...(quiet ? { quiet: true } : {}) });
}

function pending(state: DialogState, label: string): DialogState {
	return { ...state, pending: label };
}

function withAnswers(state: DialogState, patch: Partial<DialogAnswers>): DialogState {
	return { ...state, answers: { ...state.answers, ...patch } };
}

function result(state: DialogState, ...effects: Effect[]): ReduceResult {
	return { state, effects };
}

/* ------------------------------------------------------------------ *
 * Questions                                                           *
 * ------------------------------------------------------------------ */

function askTopic(state: DialogState, prefill?: string): DialogState {
	return ask(state, "topic", { text: TEXT.topic, ...(prefill ? { prefill } : {}) });
}

function askBlocks(state: DialogState, ctx: DialogContext, note?: string, text: string = TEXT.blocks): DialogState {
	const { answers } = state;
	const broader = answers.variants.some((variant) => variant.role !== "plus1");
	const chips: Chip[] = [{ id: "use", label: answers.synonyms ? "Search with these blocks" : "Yes, search with these", primary: true }];
	if (broader) chips.push({ id: "useVariants", label: "Yes, plus two broader variants", title: answers.variants.filter((variant) => variant.role !== "plus1").map((variant) => variant.text).join("\n") });
	if (ctx.hasModel) chips.push({ id: "again", label: "Propose again" });
	chips.push({ id: "more", label: "More options", title: "Code sources, period, journals and authors before the search" });
	return ask(state, "blocks", { text, editor: answers.blocks, ...(note ? { note } : {}), chips });
}

function askCode(state: DialogState): DialogState {
	return ask(state, "code", {
		text: TEXT.code,
		chips: [
			{ id: "yes", label: "Yes, papers with code too", primary: true },
			{ id: "no", label: "No, publications only" },
			{ id: "some", label: "Only some sources" },
		],
	});
}

function askCodeSources(state: DialogState): DialogState {
	const on = state.answers.codeSources.length ? state.answers.codeSources : Object.keys(CODE_SEARCHERS);
	return ask(state, "codeSources", {
		text: TEXT.codeSources,
		chips: [
			...Object.keys(CODE_SEARCHERS).map((id) => ({ id, label: CODE_SOURCE_LABELS[id] ?? id, toggle: true, on: on.includes(id) })),
			{ id: "use", label: "Use ticked", primary: true },
		],
	});
}

function askTopics(state: DialogState, note?: string): DialogState {
	const { answers } = state;
	return ask(state, "topics", {
		text: TEXT.topics,
		...(note ? { note } : {}),
		chips: [
			{ id: "use", label: "Use these", primary: true },
			{ id: "skip", label: "Skip the lists" },
		],
		list: {
			items: answers.topics.map((row) => ({ id: row.topic, label: row.lists === null ? row.topic : `${row.topic} (${row.lists} list${row.lists === 1 ? "" : "s"})`, on: answers.topicsOn.includes(row.topic) })),
			open: true,
			summary: `${answers.topics.length} topic${answers.topics.length === 1 ? "" : "s"}`,
		},
	});
}

function askPeriod(state: DialogState, note?: string): DialogState {
	return ask(state, "period", {
		text: TEXT.period,
		...(note ? { note } : {}),
		chips: [
			{ id: "5y", label: "Last 5 years" },
			{ id: "10y", label: "Last 10 years", primary: true },
			{ id: "20y", label: "Last 20 years" },
			{ id: "all", label: "All years" },
		],
	});
}

/** Action chips of a list question: the "all" answer first, then "use
 * ticked"; the items themselves sit in a vertical list below. */
function listActions(on: string[] | "all", allLabel: string): Chip[] {
	return [
		{ id: "all", label: allLabel, primary: on === "all" || !on.length },
		{ id: "use", label: "Use ticked", primary: on !== "all" && on.length > 0 },
	];
}

function listBlock(rows: Array<{ id: string; label: string }>, on: string[] | "all", noun: string, open: boolean): ListBlock {
	return {
		items: rows.map((row, index) => ({ id: row.id, label: `${index + 1}. ${row.label}`, on: on !== "all" && on.includes(row.id) })),
		open,
		summary: `Show the ${rows.length} ${noun}`,
	};
}

function askJournals(state: DialogState, note?: string): DialogState {
	const { answers } = state;
	const rows = answers.journals.map((row) => ({ id: row.id, label: `${row.name} (${row.works})` }));
	return ask(state, "journals", { text: TEXT.journals, ...(note ? { note } : {}), chips: listActions(answers.journalsOn, "All journals"), list: listBlock(rows, answers.journalsOn, "journals", false) });
}

function askAuthors(state: DialogState, note?: string): DialogState {
	const { answers } = state;
	const rows = answers.authors.map((row) => ({ id: row.id, label: `${row.name} (${row.works})` }));
	const chips = listActions(answers.authorsOn, "All authors");
	for (const match of answers.authorMatches) {
		chips.push({ id: `pick:${match.id}`, label: `Pick ${match.name}${match.hint ? ` (${match.hint})` : ""}` });
	}
	return ask(state, "authors", { text: TEXT.authors, ...(note ? { note } : {}), chips, list: listBlock(rows, answers.authorsOn, "authors", false) });
}

function askAuthorScope(state: DialogState): DialogState {
	return ask(state, "authorScope", {
		text: TEXT.authorScope,
		chips: [
			{ id: "query", label: "No, only on the topic", primary: true },
			{ id: "all", label: "Yes, all their works" },
		],
	});
}

function summaryText(state: DialogState, ctx: DialogContext): { text: string; note: string } {
	const { answers } = state;
	const years = periodYears(answers.period, ctx.thisYear);
	const period = answers.period.preset === "all" ? "all years" : `${years.yearFrom ?? "..."}-${years.yearTo ?? ctx.thisYear}`;
	const code = answers.codeSources.length
		? answers.codeSources.map((id) => CODE_SOURCE_LABELS[id] ?? id).join(", ") + (answers.codeSources.includes("awesome-lists") && answers.topicsOn.length ? ` (topics ${answers.topicsOn.join(", ")})` : "")
		: "off";
	const journals = answers.journalsOn === "all" || !answers.journalsOn.length ? "all" : answers.journals.filter((row) => (answers.journalsOn as string[]).includes(row.id)).map((row) => row.name).join(", ");
	const authors = answers.pickedAuthors?.length
		? `${answers.pickedAuthors.map((author) => author.name).join(", ")}${answers.authorScope === "all" ? " (all their works)" : " (on the topic)"}`
		: answers.authorsOn === "all" || !answers.authorsOn.length ? "all" : answers.authors.filter((row) => (answers.authorsOn as string[]).includes(row.id)).map((row) => row.name).join(", ");
	const variants = answers.useVariants ? ` plus ${answers.variants.filter((variant) => variant.role !== "plus1").length} broader variant(s)` : "";
	const text = `**Ready.** Query: \`${composedQuery(answers)}\`${variants}\nPapers with code: ${code}\nPeriod: ${period} · Journals: ${journals} · Authors: ${authors}`;
	const skipped = ctx.sourcesSkipped.length ? ` (${ctx.sourcesSkipped.join(", ")}: not queried, optional, needs a free API key)` : "";
	const note = `Defaults: ${answers.perSource} records per source and query, sources ${ctx.sources.join(", ")}${skipped}${answers.minCites !== null ? `, at least ${answers.minCites} citations` : ""}. Change with \`count 30\`, \`cites 5\`, \`code on\` or \`code off\`.`;
	return { text, note };
}

function askConfirm(state: DialogState, ctx: DialogContext): DialogState {
	const { text, note } = summaryText(state, ctx);
	return ask(state, "confirm", {
		text,
		note,
		chips: [
			{ id: "search", label: TEXT.confirmSearch, primary: true },
			{ id: "changeCode", label: "Change code sources" },
			{ id: "changePeriod", label: "Change period" },
			{ id: "changeJournals", label: "Change journals" },
			{ id: "changeAuthors", label: "Change authors" },
			{ id: "changeBlocks", label: "Change blocks" },
		],
	});
}

function askPick(state: DialogState, ctx: DialogContext, note?: string): DialogState {
	const search = state.answers.search;
	const candidates = search?.candidates ?? [];
	const code = candidates.filter((candidate) => candidate.code && !candidate.inLibrary).length;
	const onTarget = candidates.filter((candidate) => candidate.group === "on_target" && !candidate.inLibrary).length;
	const chips: Chip[] = [{ id: "ticked", label: "Use the ticked papers", primary: true }];
	if (code) chips.push({ id: "code", label: `All papers with a code link (${code})` });
	if (onTarget) chips.push({ id: "all", label: `All on-target papers (${onTarget})` });
	if (ctx.library.length) chips.push({ id: "skip", label: "Skip to the library chat" });
	if (!state.answers.codeSources.length) chips.push({ id: "addCode", label: "Add papers with code", title: "Search again with the code sources on (about 20 s more); their list topics are chosen automatically" });
	chips.push({ id: "goBlocks", label: "Edit keywords", title: "Change the keywords; the search runs again" });
	const searched = `Searched: ${composedQuery(state.answers)}`;
	return ask(state, "pick", { text: TEXT.pick, note: note ? `${note} ${searched}` : searched, chips, quiet: true });
}

function askMailto(state: DialogState, note?: string): DialogState {
	return ask(state, "mailto", { text: note ?? TEXT.mailto, chips: [{ id: "without", label: "Continue without Unpaywall" }], quiet: true });
}

function askMailtoSave(state: DialogState): DialogState {
	return ask(state, "mailtoSave", { text: TEXT.mailtoSave, chips: [{ id: "save", label: "Save it", primary: true }, { id: "once", label: "This run only" }], quiet: true });
}

function askDownload(state: DialogState): DialogState {
	const { answers } = state;
	const byId = new Map((answers.search?.candidates ?? []).map((candidate) => [candidate.id.toLowerCase(), candidate]));
	const picked = answers.pickIds.map((id) => byId.get(id.toLowerCase()) ?? null);
	const restricted = picked.filter((candidate) => candidate?.access === "restricted").length;
	const abstractOnly = picked.filter((candidate) => candidate?.access === "abstract_only").length;
	const inLibrary = picked.filter((candidate) => candidate?.inLibrary).length;
	const n = answers.pickIds.length;
	const parts: string[] = [];
	if (restricted) parts.push(`${restricted} restricted (listed with a browser link, not tried)`);
	if (abstractOnly) parts.push(`${abstractOnly} abstract only (not tried)`);
	if (inLibrary) parts.push(`${inLibrary} already in the library`);
	const text = `Download **${n} paper${n === 1 ? "" : "s"}**?${parts.length ? ` ${parts.join(", ")}.` : ""}`;
	const note = answers.withoutUnpaywall ? "Without Unpaywall for this run." : answers.mailto ? `Unpaywall contact: ${answers.mailto}.` : undefined;
	return ask(state, "download", { text, ...(note ? { note } : {}), chips: [{ id: "download", label: "Download", primary: true }, { id: "change", label: "Change the list" }], quiet: true });
}

function askPickPaper(state: DialogState, ctx: DialogContext): DialogState {
	return ask(state, "pickPaper", {
		text: TEXT.pickPaper,
		chips: [
			{ id: "use", label: "Use the ticked paper", primary: true },
			{ id: "library", label: "Whole library instead" },
		],
		list: { items: ctx.library.map((paper, index) => ({ id: paper.base, label: `${index + 1}. ${libraryLabel(paper)}`, on: false })), single: true, open: true, summary: `${ctx.library.length} PDFs` },
	});
}

function askPickPapers(state: DialogState, ctx: DialogContext): DialogState {
	return ask(state, "pickPapers", {
		text: TEXT.pickPapers,
		chips: [
			{ id: "use", label: "Use ticked", primary: true },
			{ id: "library", label: `Whole library (${ctx.library.length})` },
		],
		list: { items: ctx.library.map((paper, index) => ({ id: paper.base, label: `${index + 1}. ${libraryLabel(paper)}`, on: false })), open: true, summary: `${ctx.library.length} PDFs` },
	});
}

function askQuestions(state: DialogState): DialogState {
	return ask(state, "questions", { text: TEXT.questions, chips: [{ id: "none", label: "Summaries only" }] });
}

/** The actions offered while questions are open (below the instruction
 * and below every answer). */
/** A chat on ONE PDF (opened from the library or by dropping it): just
 * questions about it, no report or scope buttons. */
function onePaper(state: DialogState): boolean {
	// One paper picked in the page's "+" menu carries a scope label: a
	// library chat narrowed to it, with the usual actions.
	return Array.isArray(state.answers.scope) && state.answers.scope.length === 1 && !state.answers.scopeLabel;
}

/** `about`: the paper's own words (title, first author, year from its
 * metadata) for a chat opened on one PDF: the question names it. */
function askAsk(state: DialogState, ctx: DialogContext, intro?: string, about?: string): DialogState {
	if (about && ctx.hasModel) return ask(state, "ask", { text: `What would you like to know about ${about}?` });
	// Scope and reports live in the page's "+" menu: the question stands alone.
	const text = intro ? `${intro}\n${ctx.hasModel ? TEXT.ask : TEXT.askNoModel}` : ctx.hasModel ? TEXT.ask : TEXT.askNoModel;
	return ask(state, "ask", { text, ...(ctx.hasModel ? {} : { note: ctx.noModelHint }) });
}

function askReportKind(state: DialogState): DialogState {
	return ask(state, "reportKind", {
		text: TEXT.reportKind,
		chips: [
			{ id: "bullets", label: "Summarize each paper" },
			{ id: "perPaper", label: "Answer my questions paper by paper", primary: true },
			{ id: "crossPaper", label: "Answer my questions across all papers" },
			{ id: "review", label: "Write a literature review" },
		],
	});
}

function libraryLabel(paper: LibraryItem): string {
	const author = paper.authors[0] ? paper.authors[0].split(/\s+/).pop() ?? "" : "";
	const head = [paper.year ?? "", author].filter(Boolean).join(" ");
	return `${head ? `${head} · ` : ""}${paper.title || paper.base}`;
}

/* ------------------------------------------------------------------ *
 * The reducer                                                         *
 * ------------------------------------------------------------------ */

export function reduce(state: DialogState, event: DialogEvent, ctx: DialogContext): ReduceResult {
	switch (event.kind) {
		case "restart":
			return result(initialDialog(ctx, event.start, event.scope, event.about, event.label), { kind: "newChatSession" });
		case "answer":
			return onAnswer(state, event, ctx);
		case "blocks":
			return onBlocksProposed(state, event, ctx);
		case "fileWritten":
			return result(card(state, event.card, event.quiet === true));
		case "topics": {
			// Topics without a single list are useless to the source: not shown.
			const topics = event.topics.filter((row) => row.lists !== 0);
			const next = withAnswers(state, { topics, topicsOn: topics.map((row) => row.topic) });
			// "Add papers with code": the best three topics are taken without asking.
			if (state.answers.autoTopics) {
				const picked = [...topics].sort((a, b) => (b.lists ?? 0) - (a.lists ?? 0)).slice(0, 3).map((row) => row.topic);
				const sources = picked.length ? next.answers.codeSources : next.answers.codeSources.filter((id) => id !== "awesome-lists");
				return startSearch(withAnswers(next, { topicsOn: picked, codeSources: sources, autoTopics: false }), ctx);
			}
			if (!topics.length) {
				const without = withAnswers(next, { codeSources: next.answers.codeSources.filter((id) => id !== "awesome-lists"), topicsOn: [] });
				return result(askPeriod(say(without, event.error ? `List topics could not be loaded (${event.error}); the awesome lists are left out of this search.` : "No awesome lists exist for the suggested topics, so the awesome lists are left out of this search.")));
			}
			return result(askTopics(next, event.error ? event.error : undefined));
		}
		case "journals": {
			const next = withAnswers(state, { journals: event.journals, journalsOn: "all" });
			if (!event.journals.length) {
				const told = say(next, event.error ? `Journals could not be loaded (${event.error}); every journal stays in.` : TEXT.journalsNone);
				return loadAuthors(told, ctx);
			}
			return result(askJournals(next));
		}
		case "authors": {
			const next = withAnswers(state, { authors: event.authors, authorsOn: "all", authorMatches: [] });
			if (!event.authors.length) {
				return result(askConfirm(say(next, event.error ? `Authors could not be loaded (${event.error}); every author stays in.` : TEXT.authorsNone), ctx));
			}
			return result(askAuthors(next));
		}
		case "authorLookup": {
			const next = withAnswers(state, { authorMatches: event.matches });
			if (!event.matches.length) return result(askAuthors(next, event.error ? `Lookup failed (${event.error}).` : "No author of that name in OpenAlex."));
			return result(askAuthors(next, "Pick one of the matches, or tick listed authors."));
		}
		case "jobStarted": {
			const step: StepId = event.job.kind === "search" ? "searching" : event.job.kind === "selection" ? "downloading" : event.job.kind === "report" ? "reporting" : event.job.kind === "chat" ? "answering" : state.step;
			return result(push({ ...spend(state), step, activeJob: event.job.id, pending: null }, { role: "working", job: event.job.id, jobLabel: event.job.label, jobState: "running", ...(event.job.kind === "selection" ? { quiet: true } : {}) }));
		}
		case "job":
			return onJob(state, event, ctx);
		case "effectFailed":
			return onEffectFailed(state, event, ctx);
		case "helpAnswered":
			return result(helpMessage(state, event.text?.trim() ? "model" : "fixed", event.text?.trim() || fallbackText(state.step, state.helpNote ?? undefined), event.error));
		default:
			return result(state);
	}
}

/* ---- the question channel ---- */

/**
 * A question or wish typed while a wizard question is open: the helper
 * answers from the step's help text; the open question and the answers
 * stay untouched. With a model the answer is written over the help text
 * (effect); without one the help text itself is shown. `note` is what
 * the parser would have said (kept as the first sentence).
 */
function onHelp(state: DialogState, question: string, ctx: DialogContext, note?: string, fixedOnly = false): ReduceResult {
	if (!ctx.hasModel || fixedOnly) return result(helpMessage(state, "fixed", fallbackText(state.step, note, fixedOnly)));
	const user = helpPrompt(state.step, question, state, ctx, note);
	return result(pending({ ...state, helpNote: note ?? null }, "looking up the help"), { kind: "helpAnswer", step: state.step, question, system: HELP_SYSTEM, user });
}

function helpMessage(state: DialogState, help: "model" | "fixed", text: string, error?: string): DialogState {
	const note = help === "fixed" ? (error ? `Fixed help text (the model did not answer: ${error}).` : "Fixed help text.") : "Help, written by the model over the fixed help text.";
	return push({ ...state, pending: null, helpNote: null }, { role: "assistant", text, note, chips: navigationChips(state), help });
}

/** Parser miss on a text step: a question-like input goes to the helper
 * with the parser's note; anything else is re-asked as before. */
function unclear(state: DialogState, text: string, note: string, ctx: DialogContext, reask: () => DialogState): ReduceResult {
	if (looksLikeQuestion(text)) return onHelp(state, text, ctx, note);
	return result(reask());
}

/* ---- answers ---- */

function onAnswer(state: DialogState, event: Extract<DialogEvent, { kind: "answer" }>, ctx: DialogContext): ReduceResult {
	const text = (event.text ?? "").trim();
	const chip = event.chip ?? "";
	if (state.activeJob) return result(say(state, TEXT.wait));
	if (state.pending) return result(say(state, `Still working: ${state.pending}.`));

	const command = text ? globalCommand(text) : chip === "restart" ? "restart" : null;
	if (command === "restart") {
		return result(ask(userSaid(state, text || "Start over"), "confirmRestart", { text: TEXT.confirmRestart, chips: [{ id: "yes", label: "Yes, start over", primary: true }, { id: "no", label: "No, continue" }] }));
	}
	if (command === "back") return goBack(userSaid(state, text), ctx);
	// A typed wish to change the keywords or the request reopens that
	// question (answers kept), decided here and not by the helper model.
	// Only once blocks exist, not on the request and blocks questions
	// themselves (there the text IS the answer), and not on the explicit
	// question channel (`ask`, leading "?"), which never moves the step.
	const navigable = text && !chip && !event.ask && !text.startsWith("?") && state.answers.blocks.length > 0 && state.step !== "topic" && state.step !== "blocks";
	const navigate = navigable ? navigationIntent(text) : null;
	if (navigate === "blocks") return result(askBlocks(userSaid(state, text), ctx));
	if (navigate === "topic") return result(askTopic(userSaid(state, text)));

	const shown = chip ? chipLabel(state, chip) ?? chip : text;
	const echoed = shown ? userSaid(state, shown) : spend(state);

	// The question channel: question mode on the page, a leading "?", or
	// typed text on a step that only takes chips (unless it names a chip).
	const asked = text.startsWith("?") ? text.slice(1).trim() : text;
	if ((event.ask || text.startsWith("?")) && asked) return onHelp(asked === text ? echoed : userSaid(spend(state), asked), asked, ctx);
	if (text && !chip && STEP_ACCEPTS[state.step] === "choice" && !chipByText(state, text)) return onHelp(echoed, text, ctx);
	// Navigation chips under a help answer.
	if (chip === "continue") return result(reask(echoed, state.step, ctx));
	if (chip === "goBlocks") return result(echoed.answers.blocks.length ? askBlocks(echoed, ctx) : askTopic(echoed));
	if (chip === "back") return goBack(echoed, ctx);

	// From the result list: the code sources as an add-on (a new run with
	// the same blocks, list topics taken automatically), and the list
	// filters sent to the sources as a new query.
	if (chip === "addCode" && state.answers.blocks.length) return addCodeSources(echoed, ctx);
	// The browser's "Edit keywords" window: new lines, searched at once.
	if (chip === "reblocks" && state.answers.blocks.length) {
		const blocks = (event.blocks ?? []).map((line) => line.trim()).filter(Boolean);
		if (!blocks.length || !composedQuery({ ...state.answers, blocks })) return result(askPick(say(echoed, "At least one block needs a term."), ctx));
		return startSearch(withAnswers(echoed, { blocks, useVariants: false }), ctx);
	}
	if (chip === "searchAgain" && (state.answers.blocks.length || isAuthorsOnly(state.answers))) {
		const filters = event.filters ?? {};
		let next = echoed;
		if (filters.allYears) next = withAnswers(next, { period: { preset: "all" } });
		else if (filters.yearFrom !== undefined) next = withAnswers(next, { period: { preset: "custom", yearFrom: filters.yearFrom } });
		if (filters.minCites !== undefined) next = withAnswers(next, { minCites: filters.minCites > 0 ? filters.minCites : null });
		return startSearch(next, ctx);
	}

	// The rail's stages switch within the same conversation.
	if (chip === "goSearch") return result(askTopic(echoed));
	if (chip === "goSelection") {
		if (echoed.answers.search) return result(askPick(echoed, ctx));
		return result(ask(echoed, "start", { text: "No search report in this conversation yet. Search first; the papers of that report can then be picked for download.", chips: [{ id: "goSearch", label: "Search literature", primary: true }] }));
	}
	if (chip === "goSynthesis") {
		if (ctx.library.length) return result(askAsk(withAnswers(echoed, { scope: "library" }), ctx));
		return result(askNoLibrary(echoed));
	}

	switch (state.step) {
		case "confirmRestart":
			if (chip === "yes" || /^(yes|y|ok)$/i.test(text)) return reduce(echoed, { kind: "restart" }, ctx);
			return resume(echoed, ctx);
		case "start":
			if (chip === "pdfChat" && ctx.library.length) return result(askPickPaper(echoed, ctx));
			if (chip === "pdfReport" && ctx.library.length) return result(askPickPapers(echoed, ctx));
			if (!text && !chip && authorsOnly(requestOptions(event)).length) return onAuthorsOnly(echoed, requestOptions(event), ctx);
			if (chip === "search" || !text) return result(askTopic(echoed));
			// "hello", "what can you do?": the tool says what it is (fixed text), it
			// does not chat. A question CAN be a research request, so only small
			// talk is caught here.
			if (looksLikeSmallTalk(text)) return onHelp(echoed, text, ctx, undefined, true);
			return onTopic(echoed, text, ctx, requestOptions(event));
		case "topic":
			if (!text && !chip && authorsOnly(requestOptions(event)).length) return onAuthorsOnly(echoed, requestOptions(event), ctx);
			if (!text) return result(say(echoed, TEXT.topic));
			return onTopic(echoed, text, ctx, requestOptions(event));
		case "blocks":
			return onBlocks(echoed, event, text, chip, ctx);
		case "code": {
			const yes = chip === "yes" || /^(yes|y|all|yes please)$/i.test(text);
			const no = chip === "no" || /^(no|n|none|off)$/i.test(text);
			if (chip === "some" || /^some$/i.test(text)) return result(askCodeSources(echoed));
			if (yes) return afterCodeSources(withAnswers(echoed, { codeSources: Object.keys(CODE_SEARCHERS) }), ctx);
			if (no) return result(askPeriod(withAnswers(echoed, { codeSources: [], topicsOn: [] })));
			// A typed source name list.
			const picked = Object.keys(CODE_SEARCHERS).filter((id) => text.toLowerCase().includes(id.split("-")[0]) || (CODE_SOURCE_LABELS[id] ?? "").toLowerCase().split(/\W+/).some((word) => word.length > 3 && text.toLowerCase().includes(word)));
			if (picked.length) return afterCodeSources(withAnswers(echoed, { codeSources: picked }), ctx);
			return result(askCode(say(echoed, "Please answer yes or no, or pick a button.")));
		}
		case "codeSources": {
			const toggles = (event.toggles ?? []).filter((id) => id in CODE_SEARCHERS);
			if (!toggles.length) return result(askPeriod(withAnswers(echoed, { codeSources: [], topicsOn: [] })));
			return afterCodeSources(withAnswers(echoed, { codeSources: toggles }), ctx);
		}
		case "topics": {
			if (chip === "skip") {
				const sources = echoed.answers.codeSources.filter((id) => id !== "awesome-lists");
				return result(askPeriod(withAnswers(echoed, { codeSources: sources, topicsOn: [] })));
			}
			if (chip === "use") {
				const on = (event.toggles ?? []).filter((id) => echoed.answers.topics.some((row) => row.topic === id));
				return result(askPeriod(withAnswers(echoed, { topicsOn: on })));
			}
			const slug = topicSlug(text);
			if (!slug) return unclear(echoed, text, "A topic is one GitHub slug such as remote-sensing.", ctx, () => askTopics(echoed));
			const on = [...new Set([...(event.toggles ?? echoed.answers.topicsOn), slug])];
			const topics = echoed.answers.topics.some((row) => row.topic === slug) ? echoed.answers.topics : [...echoed.answers.topics, { topic: slug, lists: null }];
			return result(askTopics(withAnswers(echoed, { topics, topicsOn: on }), `Added "${slug}".`));
		}
		case "period": {
			const preset = ["5y", "10y", "20y", "all"].includes(chip) ? chip as PeriodChoice["preset"] : null;
			const period = preset ? { preset } : parsePeriodAnswer(text, ctx.thisYear);
			if (!period) return unclear(echoed, text, TEXT.periodUnclear, ctx, () => askPeriod(echoed, TEXT.periodUnclear));
			return loadJournals(withAnswers(echoed, { period }), ctx);
		}
		case "journals":
			return onListStep(echoed, event, text, chip, ctx, "journals");
		case "authors":
			return onListStep(echoed, event, text, chip, ctx, "authors");
		case "authorScope":
			return result(askConfirm(withAnswers(echoed, { authorScope: chip === "all" || /^(yes|all|y)$/i.test(text) ? "all" : "query" }), ctx));
		case "confirm":
			return onConfirm(echoed, text, chip, ctx);
		case "pick":
			return onPick(echoed, event, text, chip, ctx);
		case "mailto": {
			if (chip === "without" || /^(without|skip|continue without unpaywall|no)$/i.test(text)) return result(askDownload(withAnswers(echoed, { mailto: "", withoutUnpaywall: true })));
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return unclear(echoed, text, TEXT.mailtoBad, ctx, () => askMailto(echoed, TEXT.mailtoBad));
			return result(askMailtoSave(withAnswers(echoed, { mailto: text, withoutUnpaywall: false })));
		}
		case "mailtoSave":
			return result(askDownload(withAnswers(echoed, { saveMailto: chip === "save" || /^(save|yes)$/i.test(text) })));
		case "download": {
			if (chip === "change" || /^(change|change the list|back)$/i.test(text)) return result(askPick(echoed, ctx));
			if (chip === "download" || /^(download|yes|ok|go)$/i.test(text)) {
				const { answers } = echoed;
				// The folder the user chose in the download window (the server checks it).
				return result(pending(echoed, "starting the download"), { kind: "startSelection", identifiers: answers.pickIds, mailto: answers.mailto || undefined, saveMailto: answers.saveMailto || undefined, withoutUnpaywall: answers.withoutUnpaywall, ...(event.folder ? { folder: event.folder } : {}) });
			}
			return result(askDownload(echoed));
		}
		case "pickPaper": {
			if (chip === "library") return result(askAsk(withAnswers(echoed, { scope: "library" }), ctx));
			const toggles = (event.toggles ?? []).filter((base) => ctx.library.some((paper) => paper.base === base));
			if (!toggles.length) {
				const typed = parseListAnswer(text, ctx.library.map(libraryLabel));
				if (typed.kind === "all") return result(askAsk(withAnswers(echoed, { scope: "library" }), ctx));
				if (typed.kind === "picked") return result(askAsk(withAnswers(echoed, { scope: [ctx.library[typed.indexes[0]].base] }), ctx));
				return unclear(echoed, text, "Tick one paper, or choose the whole library.", ctx, () => askPickPaper(say(echoed, "Tick one paper, or choose the whole library."), ctx));
			}
			return result(askAsk(withAnswers(echoed, { scope: [toggles[0]] }), ctx));
		}
		case "pickPapers": {
			if (chip === "library") return result(askQuestions(withAnswers(echoed, { scope: "library" })));
			const toggles = (event.toggles ?? []).filter((base) => ctx.library.some((paper) => paper.base === base));
			if (!toggles.length) {
				const typed = parseListAnswer(text, ctx.library.map(libraryLabel));
				if (typed.kind === "all") return result(askQuestions(withAnswers(echoed, { scope: "library" })));
				if (typed.kind === "picked") return result(askQuestions(withAnswers(echoed, { scope: typed.indexes.map((index) => ctx.library[index].base) })));
				return unclear(echoed, text, "Tick at least one paper, or choose the whole library.", ctx, () => askPickPapers(say(echoed, "Tick at least one paper, or choose the whole library."), ctx));
			}
			return result(askQuestions(withAnswers(echoed, { scope: toggles })));
		}
		case "questions": {
			const questions = chip === "none" ? [] : parseQuestions(text);
			return result(askReportKind(withAnswers(echoed, { questions })));
		}
		case "ask":
		case "finished":
			return onAsk(echoed, text, chip, ctx, event.chat);
		case "reportKind":
			return onReportKind(echoed, chip, text, ctx);
		case "searching":
		case "downloading":
		case "answering":
		case "reporting":
			return result(say(echoed, TEXT.wait));
		default:
			return result(echoed);
	}
}

const RAIL_LABELS: Record<string, string> = { goSearch: "1 Search", goSelection: "2 Selection", goSynthesis: "3 Synthesis" };

/** A typed text that names a chip of the open question (id or label,
 * case-insensitive) counts as that answer, also on choice steps. */
function chipByText(state: DialogState, text: string): boolean {
	const open = [...state.messages].reverse().find((message) => message.role === "assistant" && message.chips && !message.spent);
	const wanted = text.trim().toLowerCase();
	return (open?.chips ?? []).some((chip) => chip.id.toLowerCase() === wanted || chip.label.toLowerCase() === wanted) || /^(yes|y|no|n|ok)$/i.test(wanted);
}

function chipLabel(state: DialogState, chipId: string): string | null {
	if (chipId in RAIL_LABELS) return RAIL_LABELS[chipId];
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const chips = state.messages[i].chips;
		if (!chips) continue;
		const found = chips.find((chip) => chip.id === chipId);
		if (found) return found.label.replace(/^\d+\.\s/, "");
	}
	return null;
}

/** A request the user structured by hand: uppercase AND/OR or the compact
 * "a,b;c" spec. Parentheses alone do not count -- prose carries them too
 * ("imagery (Sentinel 2)"), and such a sentence still needs the model. */
export function isHandBuilt(text: string): boolean {
	return /(^|\s)(AND|OR)(\s|$)/.test(text) || /;/.test(text);
}

/** What the "+" menu of the request box sent along with it. */
interface RequestOptions {
	code: boolean;
	synonyms: boolean;
	period?: PeriodPreset;
	options?: SearchOptionsAnswer;
	/** Synonym blocks already checked and edited in the "+" menu. */
	blocks?: string[];
}

function requestOptions(event: Extract<DialogEvent, { kind: "answer" }>): RequestOptions {
	const blocks = (event.blocks ?? []).map((line) => line.trim()).filter(Boolean);
	return {
		code: event.code === true, synonyms: event.synonyms === true, ...periodOf(event),
		...(event.options ? { options: event.options } : {}),
		...(event.synonyms === true && blocks.length ? { blocks } : {}),
	};
}

/** The "+" menu's settings beyond code, synonyms and period: the same
 * choices the terminal wizard offers (count, citations, journals,
 * authors), made before the search. Journal and author rows are the
 * OpenAlex facet rows the menu showed; `on` holds the ticked ids. */
/** The paper chat's "+" menu: which PDFs, and whether Send writes a
 * report (and which kind) instead of answering in the chat. */
export type ReportKindId = "bullets" | "perPaper" | "crossPaper" | "review";
/** The optional parts of the paper chat's ONE report; the chat's
 * questions (answered across the papers) are always in it. */
export interface ReportParts {
	/** Summary: each paper on its own. */
	summary: boolean;
	/** Synthesis: all papers together. */
	synthesis: boolean;
}
export interface ChatOptionsAnswer {
	scope: string[] | "library";
	scopeLabel?: string;
	/** Build (or update) the chat's report with these parts. */
	build?: ReportParts;
}

/** Validate the chat menu's settings from the page (untrusted JSON).
 * Pure; the reducer keeps only basenames the library holds. */
export function parseChatOptions(value: unknown): ChatOptionsAnswer | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	let scope: string[] | "library";
	if (raw.scope === "library") scope = "library";
	else if (Array.isArray(raw.scope)) scope = [...new Set(raw.scope.filter((base): base is string => typeof base === "string" && base.trim() !== "").slice(0, 5000))];
	else return undefined;
	const out: ChatOptionsAnswer = { scope };
	if (typeof raw.scopeLabel === "string" && raw.scopeLabel.trim()) out.scopeLabel = raw.scopeLabel.trim().slice(0, 120);
	const build = raw.build;
	if (build && typeof build === "object" && !Array.isArray(build)) {
		const parts = build as Record<string, unknown>;
		out.build = { summary: parts.summary === true, synthesis: parts.synthesis === true };
	}
	return out;
}

export interface SearchOptionsAnswer {
	perSource?: number;
	minCites?: number | null;
	journals?: { rows: JournalRow[]; on: string[] };
	authors?: { rows: AuthorRow[]; on: string[] };
	pickedAuthors?: AuthorMatch[];
	authorScope?: "query" | "all";
	/** Only papers with a picked author as first author. */
	firstAuthor?: boolean;
}

/** Validate the menu's settings from the page (untrusted JSON): numbers
 * clamped, rows with string id + name only, ticks limited to listed ids.
 * Pure; undefined when nothing usable came. */
export function parseSearchOptions(value: unknown): SearchOptionsAnswer | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const out: SearchOptionsAnswer = {};
	const count = (n: unknown): number | undefined => typeof n === "number" && Number.isFinite(n) ? Math.round(n) : undefined;
	const per = count(raw.perSource);
	if (per !== undefined) out.perSource = Math.min(MAX_PER_SOURCE, Math.max(1, per));
	if (raw.minCites === null) out.minCites = null;
	else {
		const cites = count(raw.minCites);
		if (cites !== undefined) out.minCites = cites > 0 ? cites : null;
	}
	const rows = (list: unknown): Array<Record<string, unknown>> => Array.isArray(list)
		? list.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && typeof (row as Record<string, unknown>).id === "string" && typeof (row as Record<string, unknown>).name === "string").slice(0, 100)
		: [];
	const ticks = (on: unknown, listed: Array<{ id: string }>): string[] => Array.isArray(on)
		? on.filter((id): id is string => typeof id === "string" && listed.some((row) => row.id === id))
		: [];
	const facet = (entry: unknown) => (entry && typeof entry === "object" ? entry as Record<string, unknown> : {});
	const journals = facet(raw.journals);
	const journalRows: JournalRow[] = rows(journals.rows).map((row) => ({ id: row.id as string, name: row.name as string, works: count(row.works) ?? 0, score: typeof row.score === "number" ? row.score : null }));
	const journalsOn = ticks(journals.on, journalRows);
	if (journalsOn.length) out.journals = { rows: journalRows, on: journalsOn };
	const authors = facet(raw.authors);
	const authorRows: AuthorRow[] = rows(authors.rows).map((row) => ({ id: row.id as string, name: row.name as string, works: count(row.works) ?? 0 }));
	const authorsOn = ticks(authors.on, authorRows);
	if (authorsOn.length) out.authors = { rows: authorRows, on: authorsOn };
	// Picked authors (by name or ticked in the list): OpenAlex author ids
	// only, no duplicates; a single legacy `pickedAuthor` counts as one.
	const pickedRaw = Array.isArray(raw.pickedAuthors) ? raw.pickedAuthors : raw.pickedAuthor ? [raw.pickedAuthor] : [];
	const pickedAuthors: AuthorMatch[] = [];
	for (const entry of pickedRaw.slice(0, 50)) {
		const picked = facet(entry);
		if (typeof picked.id !== "string" || !/^A\d+$/.test(picked.id) || typeof picked.name !== "string" || !picked.name.trim()) continue;
		if (pickedAuthors.some((author) => author.id === picked.id)) continue;
		pickedAuthors.push({ id: picked.id, name: picked.name.trim(), hint: typeof picked.hint === "string" ? picked.hint : "", works: count(picked.works), cites: count(picked.cites), orcid: typeof picked.orcid === "string" ? picked.orcid : "" });
	}
	if (pickedAuthors.length) out.pickedAuthors = pickedAuthors;
	if (raw.authorScope === "query" || raw.authorScope === "all") out.authorScope = raw.authorScope;
	if (raw.firstAuthor === true && pickedAuthors.length) out.firstAuthor = true;
	return Object.keys(out).length ? out : undefined;
}

/** The menu settings as dialog answers (formFromAnswers reads these). */
function optionAnswers(options: SearchOptionsAnswer | undefined): Partial<DialogAnswers> {
	if (!options) return {};
	return {
		...(options.perSource !== undefined ? { perSource: options.perSource } : {}),
		...(options.minCites !== undefined ? { minCites: options.minCites } : {}),
		...(options.journals ? { journals: options.journals.rows, journalsOn: options.journals.on } : { journalsOn: "all" as const }),
		...(options.authors ? { authors: options.authors.rows, authorsOn: options.authors.on } : { authorsOn: "all" as const }),
		pickedAuthors: options.pickedAuthors ?? [],
		...(options.authorScope ? { authorScope: options.authorScope } : {}),
		authorPosition: options.firstAuthor ? "first" as const : "any" as const,
	};
}

function periodOf(event: Extract<DialogEvent, { kind: "answer" }>): { period?: PeriodPreset } {
	return event.period && PERIOD_PRESETS.includes(event.period) ? { period: event.period } : {};
}

function onTopic(state: DialogState, text: string, ctx: DialogContext, options: RequestOptions = { code: false, synonyms: false }): ReduceResult {
	const next = withAnswers(state, {
		topic: text, variants: [], useVariants: false, codeAtStart: options.code, synonyms: options.synonyms,
		...(options.period ? { period: { preset: options.period } } : {}),
		...optionAnswers(options.options),
	});
	// The browser searches first and lets the blocks be edited afterwards
	// ("Edit keywords" under the results): a hand-built block expression and
	// the model's own-words blocks start the search at once. With the
	// synonym button the model's synonyms are shown for editing first; so
	// are word-by-word blocks (no model, model failed).
	// Synonym blocks the user already saw and edited in the "+" menu: search with them.
	if (options.blocks && composedQuery({ ...next.answers, blocks: options.blocks })) {
		return startSearch(withAnswers(next, { blocks: options.blocks }), ctx);
	}
	if (!options.synonyms && isHandBuilt(text) && isBlockExpression(text)) {
		const lines = blocksForEditing(text);
		if (lines) return startSearch(withAnswers(next, { blocks: lines }), ctx);
	}
	if (!ctx.hasModel) {
		return result(askBlocks(withAnswers(next, { blocks: derivedBlocks(text) }), ctx, TEXT.blocksDerived));
	}
	return result(pending(next, PENDING_BLOCKS), proposeEffect(next.answers));
}

/** Authors picked in the "+" menu while the request box stayed empty. */
function authorsOnly(options: RequestOptions): AuthorMatch[] {
	return options.options?.pickedAuthors ?? [];
}

/** "Works by A", "Works by A and B", "Works by A, B and C" (plus "as
 * first author"). Pure. */
export function authorsOnlyLabel(authors: Array<{ name: string }>, firstAuthor = false): string {
	const names = authors.map((author) => author.name);
	return `Works by ${names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`}${firstAuthor ? " as first author" : ""}`;
}

/** True for a search of the picked authors' works without a request. */
export function isAuthorsOnly(answers: Pick<DialogAnswers, "topic" | "pickedAuthors" | "authorScope">): boolean {
	return !answers.topic?.trim() && (answers.pickedAuthors?.length ?? 0) > 0 && answers.authorScope === "all";
}

/** No request, picked authors: all their works, searched at once (every
 * year, up to MAX_AUTHOR_WORKS_PER_SOURCE per source; no keyword blocks,
 * no code sources; every source then queries by author alone). */
function onAuthorsOnly(state: DialogState, options: RequestOptions, ctx: DialogContext): ReduceResult {
	const authors = authorsOnly(options);
	const next = withAnswers(userSaid(state, authorsOnlyLabel(authors, options.options?.firstAuthor === true)), {
		topic: "", blocks: [], variants: [], useVariants: false, codeAtStart: false, synonyms: false, codeSources: [], topicsOn: [],
		...optionAnswers(options.options),
		period: { preset: "all" },
		perSource: MAX_AUTHOR_WORKS_PER_SOURCE,
		authorScope: "all",
	});
	return startSearch(next, ctx);
}

const PENDING_BLOCKS = "asking the model for keyword blocks";

function proposeEffect(answers: DialogAnswers, fresh = false): Effect {
	return { kind: "proposeBlocks", query: answers.topic, mode: answers.synonyms ? "synonyms" : "own", ...(fresh ? { fresh: true } : {}) };
}

function derivedBlocks(text: string): string[] {
	const groups = deriveGroupsFromQuery(text);
	return groups.length ? groups.map((group) => group.join(" OR ")) : [text];
}

function onBlocksProposed(state: DialogState, event: Extract<DialogEvent, { kind: "blocks" }>, ctx: DialogContext): ReduceResult {
	const variants = event.variants ?? [];
	const plus1 = variants.find((variant) => variant.role === "plus1");
	const lines = plus1 ? blocksForEditing(plus1.text) : null;
	// A late proposal after a fallback or a started search is ignored.
	if (state.pending !== PENDING_BLOCKS) return result(state);
	if (!lines) {
		const note = event.error ? `${TEXT.blocksModelFailed} (${event.error})` : TEXT.blocksModelFailed;
		return result(askBlocks(withAnswers(state, { blocks: derivedBlocks(state.answers.topic), variants }), ctx, note));
	}
	const next = withAnswers(state, { blocks: lines, variants });
	if (state.answers.synonyms) return result(askBlocks(next, ctx, undefined, TEXT.blocksSynonyms));
	return startSearch(next, ctx);
}

function onBlocks(state: DialogState, event: Extract<DialogEvent, { kind: "answer" }>, text: string, chip: string, ctx: DialogContext): ReduceResult {
	if (chip === "again") return result(pending(state, PENDING_BLOCKS), proposeEffect(state.answers, true));
	// The request box above the synonym blocks was changed and sent again:
	// a new request, new blocks.
	if (chip === "retopic" && text) {
		return onTopic(state, text, ctx, {
			code: event.code ?? state.answers.codeAtStart,
			synonyms: event.synonyms ?? state.answers.synonyms,
			...periodOf(event),
			...(event.options ? { options: event.options } : {}),
		});
	}
	// Under the synonym drop-down the "+" menu still counts: its settings
	// arrive with the confirming answer.
	if (event.period && PERIOD_PRESETS.includes(event.period)) state = withAnswers(state, { period: { preset: event.period } });
	if (event.options) state = withAnswers(state, optionAnswers(event.options));
	if (typeof event.code === "boolean") state = withAnswers(state, { codeAtStart: event.code });
	const edited = (event.blocks ?? []).map((line) => line.trim()).filter(Boolean);
	if (!chip && !edited.length && text && looksLikeQuestion(text)) return onHelp(state, text, ctx);
	const typed = !chip && text ? parseBlockLines(text) : [];
	const blocks = edited.length ? edited : typed.length ? typed : state.answers.blocks;
	if (!blocks.length || !composedQuery({ ...state.answers, blocks })) {
		return result(askBlocks(say(state, "At least one block needs a term."), ctx));
	}
	// "More options" opens the question chain (code sources, period,
	// journals, authors, summary); everything else searches at once.
	if (chip === "more") return result(askCode(withAnswers(state, { blocks, useVariants: false, codeAtStart: false })));
	return startSearch(withAnswers(state, { blocks, useVariants: chip === "useVariants" }), ctx);
}

/** "Add papers with code": all four code sources on, list topics without
 * a question (model suggestion, stored topics, or the source defaults). */
function addCodeSources(state: DialogState, ctx: DialogContext): ReduceResult {
	const next = withAnswers(state, { codeSources: Object.keys(CODE_SEARCHERS), autoTopics: true });
	if (!ctx.hasModel) return startSearch(withAnswers(next, { autoTopics: false, topicsOn: ctx.storedTopics }), ctx);
	return result(pending(next, "suggesting list topics"), { kind: "loadTopics", query: composedQuery(next.answers) });
}

function afterCodeSources(state: DialogState, ctx: DialogContext): ReduceResult {
	if (!state.answers.codeSources.includes("awesome-lists")) return result(askPeriod(state));
	if (!ctx.hasModel && !ctx.storedTopics.length) {
		return result(askPeriod(say(state, "No model is selected and no list topics are stored, so the awesome lists run with their default topics.")));
	}
	return result(pending(state, "suggesting list topics"), { kind: "loadTopics", query: composedQuery(state.answers) });
}

function loadJournals(state: DialogState, ctx: DialogContext): ReduceResult {
	const years = periodYears(state.answers.period, ctx.thisYear);
	return result(pending(state, "looking up journals on OpenAlex"), { kind: "loadJournals", query: composedQuery(state.answers), ...years });
}

function loadAuthors(state: DialogState, ctx: DialogContext): ReduceResult {
	const years = periodYears(state.answers.period, ctx.thisYear);
	const sourceIds = state.answers.journalsOn === "all" ? [] : state.answers.journalsOn;
	return result(pending(state, "looking up authors on OpenAlex"), { kind: "loadAuthors", query: composedQuery(state.answers), ...years, sourceIds });
}

function onListStep(state: DialogState, event: Extract<DialogEvent, { kind: "answer" }>, text: string, chip: string, ctx: DialogContext, which: "journals" | "authors"): ReduceResult {
	const rows = which === "journals" ? state.answers.journals : state.answers.authors;
	const onKey = which === "journals" ? "journalsOn" : "authorsOn";
	const reask = which === "journals" ? askJournals : askAuthors;
	const proceed = (next: DialogState): ReduceResult => (which === "journals" ? loadAuthors(next, ctx) : result(askConfirm(next, ctx)));

	if (chip === "all") return proceed(withAnswers(state, { [onKey]: "all", pickedAuthors: [] }));
	if (chip === "use") {
		const on = (event.toggles ?? []).filter((id) => rows.some((row) => row.id === id));
		if (!on.length) return result(reask(say(state, `Nothing is ticked. Tick ${which}, type numbers, or choose all.`)));
		return proceed(withAnswers(state, { [onKey]: on, pickedAuthors: [] }));
	}
	if (which === "authors" && chip.startsWith("pick:")) {
		const match = state.answers.authorMatches.find((entry) => `pick:${entry.id}` === chip);
		if (match) return result(askAuthorScope(withAnswers(state, { pickedAuthors: [match], authorsOn: "all", authorMatches: [] })));
	}
	const typed = parseListAnswer(text, rows.map((row) => row.name));
	if (typed.kind === "all") return proceed(withAnswers(state, { [onKey]: "all", pickedAuthors: [] }));
	if (typed.kind === "picked") return proceed(withAnswers(state, { [onKey]: typed.indexes.map((index) => rows[index].id), pickedAuthors: [] }));
	if (which === "authors" && text.length >= 3 && /\p{L}/u.test(text)) {
		return result(pending(state, `looking up "${text}" on OpenAlex`), { kind: "lookupAuthor", prefix: text });
	}
	return unclear(state, text, `I did not find "${text}" in the list.`, ctx, () => reask(say(state, `I did not find "${text}" in the list.`)));
}

function onConfirm(state: DialogState, text: string, chip: string, ctx: DialogContext): ReduceResult {
	switch (chip) {
		case "search":
			return startSearch(state, ctx);
		case "changeCode":
			return result(askCode(state));
		case "changePeriod":
			return result(askPeriod(state));
		case "changeJournals":
			return state.answers.journals.length ? result(askJournals(state)) : loadJournals(state, ctx);
		case "changeAuthors":
			return state.answers.authors.length ? result(askAuthors(state)) : loadAuthors(state, ctx);
		case "changeBlocks":
			return result(askBlocks(state, ctx));
		case "editSearch":
			// Back to the request box alone, the request and its options kept
			// (the stopped attempt stays in the job log, not in the thread).
			return result(askTopic({ ...state, messages: [], trail: [] }, state.answers.topic));
		default:
			break;
	}
	if (/^(search|go|yes|ok|start)$/i.test(text)) return startSearch(state, ctx);
	const tweak = parseTweak(text);
	if (!tweak) return unclear(state, text, "Pick a button, or type `count 30`, `cites 5`, `code on` or `code off`.", ctx, () => askConfirm(say(state, "Pick a button, or type `count 30`, `cites 5`, `code on` or `code off`."), ctx));
	if (tweak.kind === "count") return result(askConfirm(withAnswers(state, { perSource: tweak.value }), ctx));
	if (tweak.kind === "cites") return result(askConfirm(withAnswers(state, { minCites: tweak.value }), ctx));
	if (!tweak.on) return result(askConfirm(withAnswers(state, { codeSources: [], topicsOn: [] }), ctx));
	return afterCodeSources(withAnswers(state, { codeSources: Object.keys(CODE_SEARCHERS) }), ctx);
}

function startSearch(state: DialogState, ctx: DialogContext): ReduceResult {
	// The code icon at the request: the first search takes the code sources
	// the way "Add papers with code" does (list topics without a question).
	if (state.answers.codeAtStart) return addCodeSources(withAnswers(state, { codeAtStart: false }), ctx);
	return result(pending(state, "starting the search"), { kind: "startSearch", form: formFromAnswers(state.answers, ctx.thisYear) });
}

function onPick(state: DialogState, event: Extract<DialogEvent, { kind: "answer" }>, text: string, chip: string, ctx: DialogContext): ReduceResult {
	const candidates = state.answers.search?.candidates ?? [];
	if (chip === "skip") return result(askAsk(withAnswers(state, { scope: "library" }), ctx));
	let ids: string[] = [];
	if (chip === "ticked") {
		ids = (event.ids ?? []).map((id) => id.trim()).filter(Boolean);
		if (!ids.length) return result(askPick(state, ctx, TEXT.pickNoTicks));
	} else if (chip === "code") {
		ids = candidates.filter((candidate) => candidate.code && !candidate.inLibrary).map((candidate) => candidate.id);
	} else if (chip === "all") {
		ids = candidates.filter((candidate) => candidate.group === "on_target" && !candidate.inLibrary).map((candidate) => candidate.id);
	} else {
		const parsed = parsePickAnswer(text, candidates);
		if (parsed.kind === "none") {
			// Ticks sent along with free text count too.
			ids = (event.ids ?? []).map((id) => id.trim()).filter(Boolean);
			if (!ids.length) return unclear(state, text, TEXT.pickUnclear, ctx, () => askPick(state, ctx, TEXT.pickUnclear));
		} else ids = pickedIds(parsed, candidates);
	}
	if (!ids.length) return result(askPick(state, ctx, "That selection is empty (every matching paper is already in the library)."));
	const next = withAnswers(state, { pickIds: ids });
	if (!ctx.mailtoSet && !next.answers.mailto && !next.answers.withoutUnpaywall) return result(askMailto(next));
	return result(askDownload(next));
}

function onAsk(input: DialogState, text: string, chip: string, ctx: DialogContext, chat?: ChatOptionsAnswer): ReduceResult {
	const state = chat ? withChatScope(input, chat, ctx) : input;
	// Send with a report selected: no question -> the report now; with a
	// question -> the answer first, then the report (it then holds it).
	if (chat?.build && !text) return onBuildReport(state, chat.build, ctx);
	if (chip === "report") {
		if (state.answers.scope === "library" && ctx.library.length > 1) return result(askPickPapers(state, ctx));
		return result(askQuestions(state));
	}
	if (chip === "scopeOne") return result(askPickPaper(state, ctx));
	if (chip === "scopeLibrary") return result(askAsk(withAnswers(state, { scope: "library" }), ctx));
	if (chip === "newSearch") return result(askTopic(state));
	if (!text) return result(askAsk(state, ctx));
	if (!ctx.hasModel) return result(askAsk(say(state, TEXT.askNoModel), ctx));
	const next = withAnswers(state, { lastQuestion: text, questions: [...new Set([...state.answers.questions, text])], reportAfter: chat?.build });
	return result(pending(next, "retrieving passages and asking the model"), { kind: "startChat", question: text, papers: next.answers.scope });
}

function onReportKind(state: DialogState, chip: string, text: string, ctx: DialogContext): ReduceResult {
	const choice = chip || (/^(bullets?|summar)/i.test(text) ? "bullets"
		: /^cross|across/i.test(text) ? "crossPaper"
			: /^review|literature review/i.test(text) ? "review"
				: /^(per|summaries \+)|paper by paper/i.test(text) ? "perPaper" : "");
	if (!choice) return result(askReportKind(say(state, "Pick one of the report kinds.")));
	if (!ctx.hasModel) return result(askReportKind(say(state, TEXT.askNoModel)));
	const effect = reportEffect(state, LEGACY_REPORT_PARTS[choice as ReportKindId], state.answers.questions);
	if (effect.kind === "startReport" && effect.summary === "none" && !effect.questions.length) {
		return result(askQuestions(say(state, "Cross-paper answers need at least one question.")));
	}
	return result(pending(withAnswers(state, { reported: true }), "starting the report"), effect);
}

/** The "+" menu's scope as the dialog's: only basenames the library holds;
 * an empty pick falls back to the whole library. */
function withChatScope(state: DialogState, chat: ChatOptionsAnswer, ctx: DialogContext): DialogState {
	const known = new Set(ctx.library.map((paper) => paper.base));
	const bases = chat.scope === "library" ? [] : chat.scope.filter((base) => known.has(base));
	const scope: string[] | "library" = bases.length ? bases : "library";
	const next = withAnswers(state, { scope, scopeLabel: scope === "library" ? undefined : chat.scopeLabel });
	// Sources changed after answers: a thin line in the thread marks from
	// where the new choice counts.
	const key = (value: string[] | "library"): string => value === "library" ? "library" : [...value].sort().join("\n");
	const answered = state.messages.some((message) => message.role === "answer");
	if (!answered || key(state.answers.scope) === key(scope)) return next;
	return push(next, { role: "divider", text: scope === "library" ? "now the whole library" : `now ${scope.length} PDF${scope.length === 1 ? "" : "s"}` });
}

/** The chat's report (the "Report" window): the chat's questions, each
 * answered across the papers -- answers given in the chat over the same
 * sources are taken as they stand -- plus the ticked parts. One report per
 * chat; building again updates it. */
function onBuildReport(state: DialogState, parts: ReportParts, ctx: DialogContext): ReduceResult {
	if (!ctx.hasModel) return result(askAsk(say(state, TEXT.askNoModel), ctx));
	const questions = state.answers.questions;
	if (!questions.length && !parts.summary && !parts.synthesis) {
		return result(askAsk(say(state, "Nothing to write yet: ask a question, or tick Summary or Synthesis."), ctx));
	}
	const next = withAnswers(state, { reportRequest: parts });
	return result(pending(next, "starting the report"), {
		...reportEffect(next, [...(parts.summary ? ["bullets" as const] : []), ...(questions.length ? ["crossPaper" as const] : []), ...(parts.synthesis ? ["review" as const] : [])], questions),
		answered: chatAnswers(state),
		letters: chatLetters(state),
	});
}

/** The chat's paper letters (A, B ... in first-citation order over the
 * conversation, as the page shows them); the report keeps them. */
function chatLetters(state: DialogState): Record<string, string> {
	const out: Record<string, string> = {};
	let n = 0;
	for (const message of state.messages) {
		const answer = message.role === "answer" ? message.answer?.answer : undefined;
		for (const site of answer?.sites ?? []) {
			if (site.paper_key in out) continue;
			out[site.paper_key] = n < 26 ? String.fromCharCode(65 + n) : `${String.fromCharCode(65 + Math.floor(n / 26) - 1)}${String.fromCharCode(65 + (n % 26))}`;
			n++;
		}
	}
	return out;
}

/** The chat's answers over the current sources (newest per question): a
 * report reuses them instead of asking the model again. */
function chatAnswers(state: DialogState): AnsweredQuestion[] {
	const key = (value: string[] | "library"): string => value === "library" ? "library" : [...value].sort().join("\n");
	const scope = key(state.answers.scope);
	const byQuestion = new Map<string, AnsweredQuestion>();
	for (const message of state.messages) {
		const answer = message.role === "answer" ? message.answer?.answer : undefined;
		if (!answer || !answer.grounded || key(answer.scope) !== scope) continue;
		byQuestion.set(answer.question.trim(), answer);
	}
	return [...byQuestion.values()];
}

/** The single-choice report question (chips) keeps its bundled kinds:
 * "paper by paper" includes the summaries, the review the answers too. */
const LEGACY_REPORT_PARTS: Record<ReportKindId, ReportKindId[]> = {
	bullets: ["bullets"],
	perPaper: ["bullets", "perPaper"],
	crossPaper: ["crossPaper"],
	review: ["bullets", "perPaper", "review"],
};

/** The ticked report parts as one report effect: summaries, answers per
 * paper and / or across papers, a review synthesis. */
function reportEffect(state: DialogState, kinds: ReportKindId[], questions: string[]): Extract<Effect, { kind: "startReport" }> {
	// Every question typed so far (report questions and chat questions)
	// decides the language; a summary-only report without any question
	// falls back to the search request, then to English.
	const language = detectDialogLang([...questions, state.answers.lastQuestion, state.answers.topic]);
	const per = kinds.includes("perPaper");
	const cross = kinds.includes("crossPaper");
	return {
		kind: "startReport",
		papers: state.answers.scope,
		questions: per || cross ? questions : [],
		summary: kinds.includes("bullets") ? "bullets" : "none",
		detailMode: per && cross ? "both" : cross ? "cross-paper" : "per-paper",
		includeReview: kinds.includes("review"),
		language,
	};
}

/* ---- jobs ---- */

function onJob(state: DialogState, event: Extract<DialogEvent, { kind: "job" }>, ctx: DialogContext): ReduceResult {
	const { job } = event;
	if (state.activeJob !== job.id) return result(state);
	if (job.state === "running") return result(state);
	const marked: DialogState = {
		...state,
		activeJob: null,
		messages: state.messages.map((message) => (message.role === "working" && message.job === job.id ? { ...message, jobState: job.state } : message)),
	};
	if (job.state !== "done") {
		// The engine's "(available: a.pdf, b.pdf, ...)" list helps on the
		// command line; in the chat it buries the reason.
		const why = job.state === "cancelled" ? "Stopped." : `Failed: ${(job.error ?? "unknown error").replace(/\s*\(available: [\s\S]*\)\s*$/, "")}`;
		switch (job.kind) {
			case "search":
				// A list is already there (add-on, search again, edited blocks):
				// back to it with its actions; the working line says "Stopped".
				if (state.answers.search) return result(askPick(marked, ctx, `${why} The new search did not finish; the list is the previous one.`));
				return result(ask(marked, "confirm", { text: `${why} The search did not finish.`, chips: [{ id: "search", label: "Search again", primary: true }, { id: "editSearch", label: "Edit search" }] }));
			case "selection":
				return result(ask(marked, "download", { text: `${why} The download did not finish.`, chips: [{ id: "download", label: "Try again", primary: true }, { id: "change", label: "Change the list" }] }));
			case "chat":
				// A chat on one PDF stays a plain chat: no scope or report chips.
				if (onePaper(marked)) return result(ask({ ...marked, pending: null }, "ask", { text: why }));
				if (marked.answers.reportAfter) return result(askAsk(say(withAnswers(marked, { reportAfter: undefined }), `${why} The report was not written.`), ctx));
				return result(askAsk(say(marked, `${why}`), ctx));
			case "report":
				return result(askAsk(say(withAnswers(marked, { reportRequest: undefined }), `${why} The report was not written.`), ctx));
			default:
				return result(say(marked, why));
		}
	}
	switch (job.kind) {
		case "search": {
			const outcome = event.search;
			if (!outcome) return result(say(marked, "The search finished, but its result is missing."));
			const code = outcome.candidates.filter((candidate) => candidate.code).length;
			const told = say(withAnswers(marked, { search: outcome, pickIds: [] }), `**Search finished:** ${outcome.included} included, ${outcome.dropped} dropped.${code ? ` ${code} paper${code === 1 ? " carries" : "s carry"} a code or data link.` : ""}`, "Tick papers in the list below; the filter icon narrows it; reports are written on click.");
			// The result cards stand in the chat (loaded by the browser from the
			// run's JSON); reports are written on click from the filtered list.
			const withResults = push(told, { role: "results", run: outcome.name });
			return result(askPick(withResults, ctx));
		}
		case "selection": {
			const outcome = event.download;
			if (!outcome) return result(say(marked, "The download finished, but its result is missing."));
			const parts = [`${outcome.downloaded} downloaded`];
			if (outcome.already) parts.push(`${outcome.already} already in the library`);
			if (outcome.browser.length) parts.push(`${outcome.browser.length} only in the browser`);
			if (outcome.notFree) parts.push(`${outcome.notFree} not free`);
			if (outcome.failed) parts.push(`${outcome.failed} failed`);
			const links = outcome.browser.map((entry) => `${entry.id}: ${entry.url}`).join("\n");
			// Both messages are quiet: the browser shows them in the download
			// window over the list; the list stays the result of stage 1. The
			// library chat is one chip away (skip) or the rail's stage 2.
			let told = push(marked, { role: "assistant", text: `**Download finished:** ${parts.join(", ")}.`, ...(links ? { note: `Only in the browser (open the link, save the PDF into your folder):\n${links}` } : {}), quiet: true });
			const folderName = outcome.folder ? `${outcome.folder.split(/[\\/]/).filter(Boolean).pop() ?? outcome.folder}/` : "lit-selection/";
			told = push(told, { role: "card", card: { kind: "folder", name: folderName, label: `${outcome.downloaded} PDF${outcome.downloaded === 1 ? "" : "s"} added, ${outcome.libraryCount} in the library`, stage: "lit-selection", ...(outcome.folder ? { path: outcome.folder } : {}) }, quiet: true });
			if (!outcome.libraryCount) {
				return result(askPick(say(told, TEXT.emptyLibraryDownload), ctx, "Pick other papers, or start over."));
			}
			return result(askPick(withAnswers(told, { scope: "library" }), { ...ctx, library: ctx.library.length ? ctx.library : [{ base: "", title: "", year: null, authors: [] }] }, `${outcome.libraryCount} PDF${outcome.libraryCount === 1 ? "" : "s"} in the library.`));
		}
		case "chat": {
			// A purely social message ("danke", "find ich gut"): the model's
			// short reply, no passages; it is no question for a later report.
			// A report selected with the question is written right after it.
			const after = marked.answers.reportAfter;
			const thenReport = (done: DialogState): ReduceResult => after ? onBuildReport(withAnswers(done, { reportAfter: undefined }), after, ctx) : result(done);
			if (event.reply) {
				const asked = marked.answers.lastQuestion;
				const kept = withAnswers(marked, { questions: marked.answers.questions.filter((question) => question !== asked) });
				return thenReport(say({ ...kept, step: "ask", pending: null }, event.reply));
			}
			const view = event.answer;
			if (!view) return result(askAsk(say(withAnswers(marked, { reportAfter: undefined }), "The answer is missing."), ctx));
			// No repeated instruction after an answer: the answer itself carries
			// the action chips, the input box invites the next question.
			const trail = marked.trail[marked.trail.length - 1] === "ask" ? marked.trail : [...marked.trail, "ask" as StepId];
			return thenReport(push({ ...spend(marked), step: "ask", trail, pending: null }, { role: "answer", step: "ask", answer: view }));
		}
		case "report": {
			const outcome = event.report;
			if (!outcome) return result(say(marked, "The report finished, but its result is missing."));
			// The chat's report opens as a tab on the page and its button
			// remembers it; nothing is added to the thread.
			const parts = marked.answers.reportRequest;
			if (parts) {
				const done = withAnswers(marked, { reportRequest: undefined, reports: undefined, report: { url: outcome.htmlUrl, parts, questions: marked.answers.questions.length, job: job.id, at: job.finished ?? job.started } });
				const trail = done.trail[done.trail.length - 1] === "ask" ? done.trail : [...done.trail, "ask" as StepId];
				return result({ ...spend(done), step: "ask", trail, pending: null });
			}
			const told = say(marked, `**Report written** (${outcome.units} unit${outcome.units === 1 ? "" : "s"}${outcome.grounded ? ", every statement carries a page citation" : "; NOT grounded -- check the report"}).`);
			const withCard = card(told, { kind: "file", name: `${outcome.name}.html`, label: "Paper report, HTML · lit-synthesis/", stage: "lit-synthesis", url: outcome.htmlUrl });
			// Back to the question box: the next question or report comes from there.
			const trail = withCard.trail[withCard.trail.length - 1] === "ask" ? withCard.trail : [...withCard.trail, "ask" as StepId];
			return result({ ...spend(withCard), step: "ask", trail, pending: null });
		}
		default:
			return result(marked);
	}
}

function onEffectFailed(state: DialogState, event: Extract<DialogEvent, { kind: "effectFailed" }>, ctx: DialogContext): ReduceResult {
	const cleared = { ...state, pending: null };
	switch (event.effect) {
		case "proposeBlocks":
			return result(askBlocks(withAnswers(cleared, { blocks: derivedBlocks(state.answers.topic) }), ctx, `${TEXT.blocksModelFailed} (${event.error})`));
		case "loadTopics":
			if (state.answers.autoTopics) return startSearch(say(withAnswers(cleared, { autoTopics: false, topicsOn: ctx.storedTopics }), `List topics could not be loaded (${event.error}); the awesome lists run with the stored topics only.`), ctx);
			return result(askPeriod(say(cleared, `List topics could not be loaded (${event.error}); the awesome lists run with the stored topics only.`)));
		case "loadJournals":
			return loadAuthors(say(cleared, `Journals could not be loaded (${event.error}); every journal stays in.`), ctx);
		case "loadAuthors":
			return result(askConfirm(say(cleared, `Authors could not be loaded (${event.error}); every author stays in.`), ctx));
		case "lookupAuthor":
			return result(askAuthors(cleared, `Lookup failed (${event.error}).`));
		case "startSearch":
			return result(askConfirm(say(cleared, `The search could not start: ${event.error}`), ctx));
		case "startSelection":
			return result(askDownload(say(cleared, `The download could not start: ${event.error}`)));
		case "startChat":
			return result(askAsk(say(cleared, `The question could not start: ${event.error}`), ctx));
		case "startReport":
			return result(askReportKind(say(cleared, `The report could not start: ${event.error}`)));
		default:
			return result(say(cleared, event.error));
	}
}

/* ---- back / resume ---- */

/** Re-ask the current step after a cancelled restart. */
function resume(state: DialogState, ctx: DialogContext): ReduceResult {
	const previous = [...state.trail].reverse().find((step) => step !== "confirmRestart") ?? "start";
	return result(reask({ ...state, trail: state.trail.filter((step) => step !== "confirmRestart") }, previous, ctx));
}

/** "back": re-ask the previous question (answers kept as prefills). */
function goBack(state: DialogState, ctx: DialogContext): ReduceResult {
	const trail = state.trail.filter((step) => step !== "confirmRestart");
	const target = trail.length >= 2 ? trail[trail.length - 2] : "start";
	return result(reask({ ...state, trail: trail.slice(0, Math.max(0, trail.length - 2)) }, target, ctx));
}

function reask(state: DialogState, step: StepId, ctx: DialogContext): DialogState {
	switch (step) {
		case "topic": return askTopic(state);
		case "blocks": return askBlocks(state, ctx);
		case "code": return askCode(state);
		case "codeSources": return askCodeSources(state);
		case "topics": return askTopics(state);
		case "period": return askPeriod(state);
		case "journals": return askJournals(state);
		case "authors": return askAuthors(state);
		case "authorScope": return askAuthorScope(state);
		case "confirm": return askConfirm(state, ctx);
		case "pick": return askPick(state, ctx);
		case "mailto": return askMailto(state);
		case "mailtoSave": return askMailtoSave(state);
		case "download": return askDownload(state);
		case "pickPaper": return askPickPaper(state, ctx);
		case "pickPapers": return askPickPapers(state, ctx);
		case "questions": return askQuestions(state);
		case "ask": return askAsk(state, ctx);
		case "reportKind": return askReportKind(state);
		case "finished": return askAsk(state, ctx);
		default: return ask(state, "start", startMessage(ctx));
	}
}

/** Convenience for the server: the stage the dialog is in (rail). */
export function stageOfStep(step: StepId): { stage: 1 | 2; label: string } {
	switch (step) {
		case "start": case "topic": case "blocks": case "code": case "codeSources": case "topics": case "period":
		case "journals": case "authors": case "authorScope": case "confirm": case "confirmRestart":
			return { stage: 1, label: "asking" };
		case "searching":
			return { stage: 1, label: "searching" };
		case "pick": case "mailto": case "mailtoSave": case "download":
			return { stage: 1, label: "choose papers" };
		case "downloading":
			return { stage: 1, label: "downloading" };
		case "answering":
			return { stage: 2, label: "answering" };
		case "reporting":
			return { stage: 2, label: "writing the report" };
		default:
			return { stage: 2, label: "questions + report" };
	}
}
