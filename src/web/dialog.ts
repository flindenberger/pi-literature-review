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
import { MAX_PER_SOURCE } from "../search.ts";
import { parseIdentifier } from "../selection.ts";
import type { AuthorMatch } from "../sources/openalex.ts";
import type { ChatAnswer } from "../synthesis.ts";
import type { Stage } from "./files.ts";
import type { SearchForm } from "./intake.ts";
import type { JobInfo } from "./jobs.ts";

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
	role: "assistant" | "user" | "working" | "answer" | "card";
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
	answer?: AnswerView;
	spent?: boolean;
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

export interface Candidate {
	id: string;
	title: string;
	year: string | null;
	access: string | null;
	group: string | null;
	dropped: boolean;
	inLibrary: boolean;
	/** The record carries a code repository or a publisher data link. */
	code: boolean;
}

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
}

export interface ReportOutcome {
	name: string;
	htmlUrl: string;
	grounded: boolean;
	units: number;
}

export interface PeriodChoice {
	preset: "5y" | "10y" | "20y" | "all" | "custom";
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
	period: PeriodChoice;
	journals: JournalRow[];
	journalsOn: string[] | "all";
	authors: AuthorRow[];
	authorsOn: string[] | "all";
	authorMatches: AuthorMatch[];
	pickedAuthor: AuthorMatch | null;
	authorScope: "query" | "all";
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
}

export type DialogEvent =
	| { kind: "answer"; text?: string; chip?: string; ids?: string[]; blocks?: string[]; toggles?: string[] }
	| { kind: "blocks"; variants: VariantSuggestion[] | null; error?: string }
	| { kind: "topics"; topics: TopicRow[]; error?: string }
	| { kind: "journals"; journals: JournalRow[]; error?: string }
	| { kind: "authors"; authors: AuthorRow[]; error?: string }
	| { kind: "authorLookup"; matches: AuthorMatch[]; error?: string }
	| { kind: "jobStarted"; job: JobInfo }
	| { kind: "job"; job: JobInfo; search?: SearchOutcome; download?: DownloadOutcome; answer?: AnswerView; report?: ReportOutcome }
	| { kind: "effectFailed"; effect: Effect["kind"]; error: string }
	| { kind: "restart" };

export type Effect =
	| { kind: "proposeBlocks"; query: string }
	| { kind: "loadTopics"; query: string }
	| { kind: "loadJournals"; query: string; yearFrom?: number; yearTo?: number }
	| { kind: "loadAuthors"; query: string; yearFrom?: number; yearTo?: number; sourceIds: string[] }
	| { kind: "lookupAuthor"; prefix: string }
	| { kind: "startSearch"; form: SearchForm }
	| { kind: "startSelection"; identifiers: string[]; mailto?: string; saveMailto?: boolean; withoutUnpaywall: boolean }
	| { kind: "startChat"; question: string; papers: string[] | "library" }
	/** `language`: the report's prose and page headings follow the language
	 * of the user's own questions (German or English, like the terminal
	 * wizard follows the chat); the chat itself stays English. */
	| { kind: "startReport"; papers: string[] | "library"; questions: string[]; summary: "bullets" | "none"; detailMode: "per-paper" | "cross-paper"; includeReview: boolean; language: DialogLang }
	| { kind: "newChatSession" };

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

export const DEFAULT_PER_SOURCE_WEB = 15;
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
	topicNote: "Example: satellite-derived bathymetry of rivers",
	blocks: "Is it ok if I split your request into these keyword blocks? A paper must match **every** block; the words inside a block are alternatives.",
	blocksEdit: "Edit any line (one block per line, alternatives separated by OR or commas), then confirm.",
	blocksDerived: "No model is selected, so the blocks were derived word by word from your text.",
	blocksModelFailed: "The model gave no usable proposal, so the blocks were derived word by word from your text.",
	code: "Do you also want **papers with code**? I can additionally search code repositories and add the papers they cite: Hugging Face Papers, GitHub README search, awesome lists, Google Earth Engine repositories. Adds up to about 40 s.",
	codeNote: "Code and data links named in abstracts or publisher records are shown in the report anyway.",
	codeSources: "Which code sources?",
	topics: "For the awesome lists I would look at these GitHub topics. Keep them, add one (type a word), or skip the lists?",
	topicsNote: "Numbers in brackets: lists found for that topic on awesome.ecosyste.ms.",
	period: "Which publication period?",
	periodNote: "Or type a range such as 2015-2024.",
	periodUnclear: "I did not understand the years. Type a range such as 2015-2024, 2015- or 2020, or pick a button.",
	journals: "These journals publish most on your topic (OpenAlex). Search all of them or only some?",
	journalsNote: "Tick journals, or type numbers (1, 3) or a name. \"all\" keeps every journal.",
	journalsNone: "OpenAlex listed no journals for these blocks, so every journal stays in.",
	authors: "Authors with the most works on this topic (OpenAlex). Search all authors or focus on some?",
	authorsNote: "Tick authors, type numbers or a name (3 letters or more look up anyone else). \"all\" keeps every author.",
	authorsNone: "OpenAlex listed no authors for these blocks, so every author stays in.",
	authorScope: "Also include this author's works outside your topic?",
	confirmSearch: "Search",
	searching: "Searching ...",
	pick: "Which papers do you want as PDFs? Tick them in the report on the right, or type row numbers (1, 4, 7), DOIs or arXiv ids. `all` takes every on-target paper, `code` every paper with a code or data link.",
	pickNoTicks: "Nothing is ticked in the report yet. Tick papers on the right, or type row numbers or identifiers.",
	pickUnclear: "I did not recognise that as row numbers, DOIs or arXiv ids. Example: 1, 4, 7 or 10.3390/rs13081505.",
	mailto: "Unpaywall needs a contact email (its policy). Type it, or continue without Unpaywall.",
	mailtoNote: "Unpaywall finds legal free copies of papers behind a paywall. Without it, only OpenAlex, publisher pages and arXiv are tried.",
	mailtoBad: "That does not look like an email address. Type one, or continue without Unpaywall.",
	mailtoSave: "Save this address in the configuration for next time, or use it for this run only?",
	ask: "Ask your question about the PDFs. I answer only from retrieved passages, with page citations.",
	askNoModel: "No model is selected, so I cannot answer questions right now.",
	pickPaper: "Which PDF do you want to talk about?",
	pickPaperNote: "One paper at a time keeps the answers precise; the whole library is the other scope.",
	pickPapers: "Which papers should the report cover? Tick them, or take the whole library.",
	questions: "Which questions should the report answer for every paper? One per line, or choose summaries only.",
	reportKind: "Which report?",
	finished: "Ask another question, or start a new search.",
	wait: "Please wait for the running job, or press Stop.",
	confirmRestart: "Start over? The conversation is cleared; files on disk stay.",
	noLibrary: "no PDFs yet: search first, or put PDFs into the working folder",
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

export type PickAnswer = { kind: "all" } | { kind: "code" } | { kind: "ids"; ids: string[] } | { kind: "none" };

/** The paper-pick answer: "all" (on-target rows), "code" (rows with a
 * code or data link), row numbers of the results table, or identifiers. */
export function parsePickAnswer(text: string, candidates: Candidate[]): PickAnswer {
	const t = text.trim();
	if (!t) return { kind: "none" };
	const lower = t.toLowerCase();
	if (/^(all|all on-target|everything)$/.test(lower)) return { kind: "all" };
	if (/^(code|with code|papers with code)$/.test(lower)) return { kind: "code" };
	const results = candidates.filter((candidate) => !candidate.dropped);
	if (/^\d+(\s*[,;\s]\s*\d+)*$/.test(t)) {
		const ids = [...new Set(t.split(/[^\d]+/).filter(Boolean).map(Number))]
			.filter((n) => n >= 1 && n <= results.length)
			.map((n) => results[n - 1].id);
		return ids.length ? { kind: "ids", ids } : { kind: "none" };
	}
	const ids = t.replace(/^\s*download\s+these\s+papers\s*:?\s*/i, "").split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean)
		.map((part) => parseIdentifier(part))
		.filter((target) => target.kind !== "unknown")
		.map((target) => (target.kind === "arxiv" ? `arXiv:${target.id}` : target.id));
	return ids.length ? { kind: "ids", ids: [...new Set(ids)] } : { kind: "none" };
}

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
	if (answers.pickedAuthor) {
		form.pickedAuthors = [{ id: answers.pickedAuthor.id, name: answers.pickedAuthor.name }];
		form.authorScope = answers.authorScope;
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
		period: { preset: "10y" },
		journals: [],
		journalsOn: "all",
		authors: [],
		authorsOn: "all",
		authorMatches: [],
		pickedAuthor: null,
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

export function initialDialog(ctx: DialogContext): DialogState {
	const state: DialogState = { step: "start", answers: emptyAnswers(), messages: [], activeJob: null, pending: null, trail: [], counter: 0 };
	return ask(state, "start", startMessage(ctx));
}

function startMessage(ctx: DialogContext): Omit<Message, "id" | "role" | "step"> {
	const n = ctx.library.length;
	const where = ctx.modelLabel ? `Everything runs on your own machine with ${ctx.modelLabel}.` : `No model is selected yet (${ctx.noModelHint}); searching works without one, answers over PDFs need one.`;
	return {
		text: TEXT.start,
		note: `${n ? `Your library holds ${n} PDF${n === 1 ? "" : "s"}.` : "Your library holds no PDFs yet."} ${where}`,
		chips: [
			{ id: "search", label: "Search literature", primary: true },
			{ id: "pdfChat", label: "Chat about one PDF", disabled: n === 0, title: n === 0 ? TEXT.noLibrary : undefined },
			{ id: "pdfReport", label: "Synthesis report over several papers", disabled: n === 0, title: n === 0 ? TEXT.noLibrary : undefined },
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

function userSaid(state: DialogState, text: string): DialogState {
	return push(spend(state), { role: "user", text });
}

function card(state: DialogState, card: FileCard): DialogState {
	return push(state, { role: "card", card });
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

function askTopic(state: DialogState): DialogState {
	return ask(state, "topic", { text: TEXT.topic, note: TEXT.topicNote });
}

function askBlocks(state: DialogState, ctx: DialogContext, note?: string): DialogState {
	const { answers } = state;
	const broader = answers.variants.some((variant) => variant.role !== "plus1");
	const chips: Chip[] = [{ id: "use", label: "Yes, search with these", primary: true }];
	if (broader) chips.push({ id: "useVariants", label: "Yes, plus two broader variants", title: answers.variants.filter((variant) => variant.role !== "plus1").map((variant) => variant.text).join("\n") });
	if (ctx.hasModel) chips.push({ id: "again", label: "Propose again" });
	return ask(state, "blocks", { text: TEXT.blocks, editor: answers.blocks, note: note ? `${note} ${TEXT.blocksEdit}` : TEXT.blocksEdit, chips });
}

function askCode(state: DialogState): DialogState {
	return ask(state, "code", {
		text: TEXT.code,
		note: TEXT.codeNote,
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
		note: note ?? TEXT.topicsNote,
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
		note: note ?? TEXT.periodNote,
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
	return ask(state, "journals", { text: TEXT.journals, note: note ?? TEXT.journalsNote, chips: listActions(answers.journalsOn, "All journals"), list: listBlock(rows, answers.journalsOn, "journals", false) });
}

function askAuthors(state: DialogState, note?: string): DialogState {
	const { answers } = state;
	const rows = answers.authors.map((row) => ({ id: row.id, label: `${row.name} (${row.works})` }));
	const chips = listActions(answers.authorsOn, "All authors");
	for (const match of answers.authorMatches) {
		chips.push({ id: `pick:${match.id}`, label: `Pick ${match.name}${match.hint ? ` (${match.hint})` : ""}` });
	}
	return ask(state, "authors", { text: TEXT.authors, note: note ?? TEXT.authorsNote, chips, list: listBlock(rows, answers.authorsOn, "authors", false) });
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
	const authors = answers.pickedAuthor
		? `${answers.pickedAuthor.name}${answers.authorScope === "all" ? " (all their works)" : " (on the topic)"}`
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
	return ask(state, "pick", { text: TEXT.pick, ...(note ? { note } : {}), chips });
}

function askMailto(state: DialogState, note?: string): DialogState {
	return ask(state, "mailto", { text: note ?? TEXT.mailto, note: TEXT.mailtoNote, chips: [{ id: "without", label: "Continue without Unpaywall" }] });
}

function askMailtoSave(state: DialogState): DialogState {
	return ask(state, "mailtoSave", { text: TEXT.mailtoSave, chips: [{ id: "save", label: "Save it", primary: true }, { id: "once", label: "This run only" }] });
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
	const text = `Download **${n} paper${n === 1 ? "" : "s"}** into \`lit-selection/\`?${parts.length ? ` ${parts.join(", ")}.` : ""}`;
	const note = answers.withoutUnpaywall ? "Without Unpaywall for this run." : answers.mailto ? `Unpaywall contact: ${answers.mailto}.` : undefined;
	return ask(state, "download", { text, ...(note ? { note } : {}), chips: [{ id: "download", label: "Download", primary: true }, { id: "change", label: "Change the list" }] });
}

function askPickPaper(state: DialogState, ctx: DialogContext): DialogState {
	return ask(state, "pickPaper", {
		text: TEXT.pickPaper,
		note: TEXT.pickPaperNote,
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
function askChips(): Chip[] {
	return [
		{ id: "report", label: "Build a report" },
		{ id: "scopeOne", label: "Scope: one paper" },
		{ id: "scopeLibrary", label: "Scope: whole library" },
	];
}

function askAsk(state: DialogState, ctx: DialogContext, intro?: string): DialogState {
	const scopeLabel = state.answers.scope === "library" ? `whole library (${ctx.library.length})` : `${state.answers.scope.length} paper${state.answers.scope.length === 1 ? "" : "s"}`;
	const chips = askChips();
	const text = intro ? `${intro}\n${ctx.hasModel ? TEXT.ask : TEXT.askNoModel}` : ctx.hasModel ? TEXT.ask : TEXT.askNoModel;
	const note = ctx.hasModel ? `Scope: ${scopeLabel}.` : ctx.noModelHint;
	return ask(state, "ask", { text, note, chips });
}

function askReportKind(state: DialogState): DialogState {
	return ask(state, "reportKind", {
		text: TEXT.reportKind,
		chips: [
			{ id: "bullets", label: "Bullet summaries of every paper" },
			{ id: "perPaper", label: "Summaries + answers to my questions per paper", primary: true },
			{ id: "crossPaper", label: "Cross-paper answers to my questions" },
			{ id: "review", label: "Review synthesis" },
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
			return result(initialDialog(ctx), { kind: "newChatSession" });
		case "answer":
			return onAnswer(state, event, ctx);
		case "blocks":
			return onBlocksProposed(state, event, ctx);
		case "topics": {
			// Topics without a single list are useless to the source: not shown.
			const topics = event.topics.filter((row) => row.lists !== 0);
			const next = withAnswers(state, { topics, topicsOn: topics.map((row) => row.topic) });
			if (!topics.length) {
				const without = withAnswers(next, { codeSources: next.answers.codeSources.filter((id) => id !== "awesome-lists"), topicsOn: [] });
				return result(askPeriod(say(without, event.error ? `List topics could not be loaded (${event.error}); the awesome lists are left out of this search.` : "No awesome lists exist for the suggested topics, so the awesome lists are left out of this search.")));
			}
			return result(askTopics(next, event.error ? `${event.error}. ${TEXT.topicsNote}` : undefined));
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
			if (!event.matches.length) return result(askAuthors(next, event.error ? `Lookup failed (${event.error}). ${TEXT.authorsNote}` : `No author of that name in OpenAlex. ${TEXT.authorsNote}`));
			return result(askAuthors(next, "Pick one of the matches, or tick listed authors."));
		}
		case "jobStarted": {
			const step: StepId = event.job.kind === "search" ? "searching" : event.job.kind === "selection" ? "downloading" : event.job.kind === "report" ? "reporting" : event.job.kind === "chat" ? "answering" : state.step;
			return result(push({ ...spend(state), step, activeJob: event.job.id, pending: null }, { role: "working", job: event.job.id, jobLabel: event.job.label, jobState: "running" }));
		}
		case "job":
			return onJob(state, event, ctx);
		case "effectFailed":
			return onEffectFailed(state, event, ctx);
		default:
			return result(state);
	}
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

	const shown = chip ? chipLabel(state, chip) ?? chip : text;
	const echoed = shown ? userSaid(state, shown) : spend(state);

	// The rail's stages switch within the same conversation.
	if (chip === "goSearch") return result(askTopic(echoed));
	if (chip === "goSelection") {
		if (echoed.answers.search) return result(askPick(echoed, ctx));
		return result(ask(echoed, "start", { text: "No search report in this conversation yet. Search first; the papers of that report can then be picked for download.", chips: [{ id: "goSearch", label: "Search literature", primary: true }] }));
	}
	if (chip === "goSynthesis") {
		if (ctx.library.length) return result(askAsk(withAnswers(echoed, { scope: "library" }), ctx));
		return result(ask(echoed, "start", { text: `The library holds no PDFs yet (${TEXT.noLibrary}).`, chips: [{ id: "goSearch", label: "Search literature", primary: true }] }));
	}

	switch (state.step) {
		case "confirmRestart":
			if (chip === "yes" || /^(yes|y|ok)$/i.test(text)) return reduce(echoed, { kind: "restart" }, ctx);
			return resume(echoed, ctx);
		case "start":
			if (chip === "pdfChat" && ctx.library.length) return result(askPickPaper(echoed, ctx));
			if (chip === "pdfReport" && ctx.library.length) return result(askPickPapers(echoed, ctx));
			if (chip === "search" || !text) return result(askTopic(echoed));
			return onTopic(echoed, text, ctx);
		case "topic":
			if (!text) return result(say(echoed, TEXT.topic));
			return onTopic(echoed, text, ctx);
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
			if (!slug) return result(askTopics(echoed));
			const on = [...new Set([...(event.toggles ?? echoed.answers.topicsOn), slug])];
			const topics = echoed.answers.topics.some((row) => row.topic === slug) ? echoed.answers.topics : [...echoed.answers.topics, { topic: slug, lists: null }];
			return result(askTopics(withAnswers(echoed, { topics, topicsOn: on }), `Added "${slug}". ${TEXT.topicsNote}`));
		}
		case "period": {
			const preset = ["5y", "10y", "20y", "all"].includes(chip) ? chip as PeriodChoice["preset"] : null;
			const period = preset ? { preset } : parsePeriodAnswer(text, ctx.thisYear);
			if (!period) return result(askPeriod(echoed, TEXT.periodUnclear));
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
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return result(askMailto(echoed, TEXT.mailtoBad));
			return result(askMailtoSave(withAnswers(echoed, { mailto: text, withoutUnpaywall: false })));
		}
		case "mailtoSave":
			return result(askDownload(withAnswers(echoed, { saveMailto: chip === "save" || /^(save|yes)$/i.test(text) })));
		case "download": {
			if (chip === "change" || /^(change|change the list|back)$/i.test(text)) return result(askPick(echoed, ctx));
			if (chip === "download" || /^(download|yes|ok|go)$/i.test(text)) {
				const { answers } = echoed;
				return result(pending(echoed, "starting the download"), { kind: "startSelection", identifiers: answers.pickIds, mailto: answers.mailto || undefined, saveMailto: answers.saveMailto || undefined, withoutUnpaywall: answers.withoutUnpaywall });
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
				return result(askPickPaper(say(echoed, "Tick one paper, or choose the whole library."), ctx));
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
				return result(askPickPapers(say(echoed, "Tick at least one paper, or choose the whole library."), ctx));
			}
			return result(askQuestions(withAnswers(echoed, { scope: toggles })));
		}
		case "questions": {
			const questions = chip === "none" ? [] : parseQuestions(text);
			return result(askReportKind(withAnswers(echoed, { questions })));
		}
		case "ask":
		case "finished":
			return onAsk(echoed, text, chip, ctx);
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

function onTopic(state: DialogState, text: string, ctx: DialogContext): ReduceResult {
	const next = withAnswers(state, { topic: text, variants: [], useVariants: false });
	if (isHandBuilt(text) && isBlockExpression(text)) {
		const lines = blocksForEditing(text);
		if (lines) return result(askBlocks(withAnswers(next, { blocks: lines }), ctx));
	}
	if (!ctx.hasModel) {
		return result(askBlocks(withAnswers(next, { blocks: derivedBlocks(text) }), ctx, TEXT.blocksDerived));
	}
	return result(pending(next, "asking the model for keyword blocks"), { kind: "proposeBlocks", query: text });
}

function derivedBlocks(text: string): string[] {
	const groups = deriveGroupsFromQuery(text);
	return groups.length ? groups.map((group) => group.join(" OR ")) : [text];
}

function onBlocksProposed(state: DialogState, event: Extract<DialogEvent, { kind: "blocks" }>, ctx: DialogContext): ReduceResult {
	const variants = event.variants ?? [];
	const plus1 = variants.find((variant) => variant.role === "plus1");
	const lines = plus1 ? blocksForEditing(plus1.text) : null;
	if (!lines) {
		const note = event.error ? `${TEXT.blocksModelFailed} (${event.error})` : TEXT.blocksModelFailed;
		return result(askBlocks(withAnswers(state, { blocks: derivedBlocks(state.answers.topic), variants }), ctx, note));
	}
	return result(askBlocks(withAnswers(state, { blocks: lines, variants }), ctx));
}

function onBlocks(state: DialogState, event: Extract<DialogEvent, { kind: "answer" }>, text: string, chip: string, ctx: DialogContext): ReduceResult {
	if (chip === "again") {
		return result(pending(state, "asking the model for keyword blocks"), { kind: "proposeBlocks", query: state.answers.topic });
	}
	const edited = (event.blocks ?? []).map((line) => line.trim()).filter(Boolean);
	const typed = !chip && text ? parseBlockLines(text) : [];
	const blocks = edited.length ? edited : typed.length ? typed : state.answers.blocks;
	if (!blocks.length || !composedQuery({ ...state.answers, blocks })) {
		return result(askBlocks(say(state, "At least one block needs a term."), ctx));
	}
	return result(askCode(withAnswers(state, { blocks, useVariants: chip === "useVariants" })));
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

	if (chip === "all") return proceed(withAnswers(state, { [onKey]: "all", pickedAuthor: null }));
	if (chip === "use") {
		const on = (event.toggles ?? []).filter((id) => rows.some((row) => row.id === id));
		if (!on.length) return result(reask(say(state, `Nothing is ticked. Tick ${which}, type numbers, or choose all.`)));
		return proceed(withAnswers(state, { [onKey]: on, pickedAuthor: null }));
	}
	if (which === "authors" && chip.startsWith("pick:")) {
		const match = state.answers.authorMatches.find((entry) => `pick:${entry.id}` === chip);
		if (match) return result(askAuthorScope(withAnswers(state, { pickedAuthor: match, authorsOn: "all", authorMatches: [] })));
	}
	const typed = parseListAnswer(text, rows.map((row) => row.name));
	if (typed.kind === "all") return proceed(withAnswers(state, { [onKey]: "all", pickedAuthor: null }));
	if (typed.kind === "picked") return proceed(withAnswers(state, { [onKey]: typed.indexes.map((index) => rows[index].id), pickedAuthor: null }));
	if (which === "authors" && text.length >= 3 && /\p{L}/u.test(text)) {
		return result(pending(state, `looking up "${text}" on OpenAlex`), { kind: "lookupAuthor", prefix: text });
	}
	return result(reask(say(state, `I did not find "${text}" in the list.`)));
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
		default:
			break;
	}
	if (/^(search|go|yes|ok|start)$/i.test(text)) return startSearch(state, ctx);
	const tweak = parseTweak(text);
	if (!tweak) return result(askConfirm(say(state, "Pick a button, or type `count 30`, `cites 5`, `code on` or `code off`."), ctx));
	if (tweak.kind === "count") return result(askConfirm(withAnswers(state, { perSource: tweak.value }), ctx));
	if (tweak.kind === "cites") return result(askConfirm(withAnswers(state, { minCites: tweak.value }), ctx));
	if (!tweak.on) return result(askConfirm(withAnswers(state, { codeSources: [], topicsOn: [] }), ctx));
	return afterCodeSources(withAnswers(state, { codeSources: Object.keys(CODE_SEARCHERS) }), ctx);
}

function startSearch(state: DialogState, ctx: DialogContext): ReduceResult {
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
			if (!ids.length) return result(askPick(state, ctx, TEXT.pickUnclear));
		} else if (parsed.kind === "all") ids = candidates.filter((candidate) => candidate.group === "on_target" && !candidate.inLibrary).map((candidate) => candidate.id);
		else if (parsed.kind === "code") ids = candidates.filter((candidate) => candidate.code && !candidate.inLibrary).map((candidate) => candidate.id);
		else ids = parsed.ids;
	}
	if (!ids.length) return result(askPick(state, ctx, "That selection is empty (every matching paper is already in the library)."));
	const next = withAnswers(state, { pickIds: ids });
	if (!ctx.mailtoSet && !next.answers.mailto && !next.answers.withoutUnpaywall) return result(askMailto(next));
	return result(askDownload(next));
}

function onAsk(state: DialogState, text: string, chip: string, ctx: DialogContext): ReduceResult {
	if (chip === "report") {
		if (state.answers.scope === "library" && ctx.library.length > 1) return result(askPickPapers(state, ctx));
		return result(askQuestions(state));
	}
	if (chip === "scopeOne") return result(askPickPaper(state, ctx));
	if (chip === "scopeLibrary") return result(askAsk(withAnswers(state, { scope: "library" }), ctx));
	if (chip === "newSearch") return result(askTopic(state));
	if (!text) return result(askAsk(state, ctx));
	if (!ctx.hasModel) return result(askAsk(say(state, TEXT.askNoModel), ctx));
	const next = withAnswers(state, { lastQuestion: text, questions: [...new Set([...state.answers.questions, text])] });
	return result(pending(next, "retrieving passages and asking the model"), { kind: "startChat", question: text, papers: next.answers.scope });
}

function onReportKind(state: DialogState, chip: string, text: string, ctx: DialogContext): ReduceResult {
	const choice = chip || (/^(bullets?|summar)/i.test(text) ? "bullets" : /^cross/i.test(text) ? "crossPaper" : /^review/i.test(text) ? "review" : /^(per|summaries \+)/i.test(text) ? "perPaper" : "");
	if (!choice) return result(askReportKind(say(state, "Pick one of the report kinds.")));
	if (!ctx.hasModel) return result(askReportKind(say(state, TEXT.askNoModel)));
	const questions = state.answers.questions;
	// Every question typed so far (report questions and chat questions)
	// decides the language; a summary-only report without any question
	// falls back to the search request, then to English.
	const language = detectDialogLang([...questions, state.answers.lastQuestion, state.answers.topic]);
	const effect: Effect = choice === "bullets"
		? { kind: "startReport", papers: state.answers.scope, questions: [], summary: "bullets", detailMode: "per-paper", includeReview: false, language }
		: choice === "crossPaper"
			? { kind: "startReport", papers: state.answers.scope, questions, summary: "none", detailMode: "cross-paper", includeReview: false, language }
			: choice === "review"
				? { kind: "startReport", papers: state.answers.scope, questions, summary: "bullets", detailMode: "per-paper", includeReview: true, language }
				: { kind: "startReport", papers: state.answers.scope, questions, summary: "bullets", detailMode: "per-paper", includeReview: false, language };
	if (effect.kind === "startReport" && effect.summary === "none" && !effect.questions.length) {
		return result(askQuestions(say(state, "Cross-paper answers need at least one question.")));
	}
	return result(pending(state, "starting the report"), effect);
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
		const why = job.state === "cancelled" ? "Stopped." : `Failed: ${job.error ?? "unknown error"}`;
		switch (job.kind) {
			case "search":
				return result(ask(marked, "confirm", { text: `${why} The search did not finish.`, chips: [{ id: "search", label: "Try again", primary: true }, { id: "changeBlocks", label: "Change blocks" }, { id: "restart", label: "Start over" }] }));
			case "selection":
				return result(ask(marked, "download", { text: `${why} The download did not finish.`, chips: [{ id: "download", label: "Try again", primary: true }, { id: "change", label: "Change the list" }] }));
			case "chat":
				return result(askAsk(say(marked, `${why}`), ctx));
			case "report":
				return result(askReportKind(say(marked, `${why} The report was not written.`)));
			default:
				return result(say(marked, why));
		}
	}
	switch (job.kind) {
		case "search": {
			const outcome = event.search;
			if (!outcome) return result(say(marked, "The search finished, but its result is missing."));
			const code = outcome.candidates.filter((candidate) => candidate.code).length;
			const told = say(withAnswers(marked, { search: outcome, pickIds: [] }), `**Search finished:** ${outcome.included} included, ${outcome.dropped} dropped.${code ? ` ${code} paper${code === 1 ? " carries" : "s carry"} a code or data link.` : ""}`, "Click the card to enlarge the report (Esc closes).");
			const withCard = card(told, { kind: "file", name: `${outcome.name}.html`, label: "Search report, HTML · lit-search/", stage: "lit-search", url: outcome.htmlUrl });
			return result(askPick(withCard, ctx));
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
			let told = say(marked, `**Download finished:** ${parts.join(", ")}.`, links ? `Only in the browser (open the link, save the PDF into lit-selection/):\n${links}` : undefined);
			told = card(told, { kind: "folder", name: "lit-selection/", label: `${outcome.downloaded} PDF${outcome.downloaded === 1 ? "" : "s"} added, ${outcome.libraryCount} in the library`, stage: "lit-selection" });
			if (!outcome.libraryCount) {
				return result(askPick(say(told, TEXT.emptyLibraryDownload), ctx, "Pick other papers, or start over."));
			}
			return result(askAsk(withAnswers(told, { scope: "library" }), ctx));
		}
		case "chat": {
			const view = event.answer;
			if (!view) return result(askAsk(say(marked, "The answer is missing."), ctx));
			// No repeated instruction after an answer: the answer itself carries
			// the action chips, the input box invites the next question.
			const trail = marked.trail[marked.trail.length - 1] === "ask" ? marked.trail : [...marked.trail, "ask" as StepId];
			return result(push({ ...spend(marked), step: "ask", trail, pending: null }, { role: "answer", step: "ask", answer: view, chips: askChips() }));
		}
		case "report": {
			const outcome = event.report;
			if (!outcome) return result(say(marked, "The report finished, but its result is missing."));
			const told = say(marked, `**Report written** (${outcome.units} unit${outcome.units === 1 ? "" : "s"}${outcome.grounded ? ", every statement carries a page citation" : "; NOT grounded -- check the report"}).`);
			const withCard = card(told, { kind: "file", name: `${outcome.name}.html`, label: "Synthesis report, HTML · lit-synthesis/", stage: "lit-synthesis", url: outcome.htmlUrl });
			return result(ask(withCard, "finished", { text: TEXT.finished, chips: [{ id: "report", label: "Another report" }, { id: "scopeOne", label: "Scope: one paper" }, { id: "newSearch", label: "New search" }] }));
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
			return result(askPeriod(say(cleared, `List topics could not be loaded (${event.error}); the awesome lists run with the stored topics only.`)));
		case "loadJournals":
			return loadAuthors(say(cleared, `Journals could not be loaded (${event.error}); every journal stays in.`), ctx);
		case "loadAuthors":
			return result(askConfirm(say(cleared, `Authors could not be loaded (${event.error}); every author stays in.`), ctx));
		case "lookupAuthor":
			return result(askAuthors(cleared, `Lookup failed (${event.error}). ${TEXT.authorsNote}`));
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
		case "finished": return ask(state, "finished", { text: TEXT.finished, chips: [{ id: "report", label: "Another report" }, { id: "newSearch", label: "New search" }] });
		default: return ask(state, "start", startMessage(ctx));
	}
}

/** Convenience for the server: the stage the dialog is in (rail). */
export function stageOfStep(step: StepId): { stage: 1 | 2 | 3; label: string } {
	switch (step) {
		case "start": case "topic": case "blocks": case "code": case "codeSources": case "topics": case "period":
		case "journals": case "authors": case "authorScope": case "confirm": case "confirmRestart":
			return { stage: 1, label: "asking" };
		case "searching":
			return { stage: 1, label: "running" };
		case "pick": case "mailto": case "mailtoSave": case "download":
			return { stage: 2, label: "choose papers" };
		case "downloading":
			return { stage: 2, label: "running" };
		case "answering": case "reporting":
			return { stage: 3, label: "running" };
		default:
			return { stage: 3, label: "questions + report" };
	}
}
