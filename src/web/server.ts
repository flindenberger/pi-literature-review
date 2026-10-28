/**
 * The web interface server: a small node:http server on 127.0.0.1 that
 * serves the single-page interface, runs the three stages through the
 * SAME engines the terminal commands use (search, selection, synthesis),
 * streams progress over SSE and hands out the reports from the output
 * folders. No framework, no new dependency.
 *
 * Protection: the server binds to the loopback address only; every
 * request needs the random token -- as the first visit's ?token= query
 * (answered with an HttpOnly, SameSite=Strict cookie and a redirect) or
 * as a bearer header; the Host header must name the loopback address
 * (DNS rebinding); API answers carry Cache-Control: no-store. One job at a
 * time, each with its own abort switch (jobs.ts).
 *
 * The one inviolable rule holds here as everywhere: the server passes
 * citation data from the engines through unchanged and never rewrites it.
 * Every engine call is injectable (deps) so the routes test offline.
 */

import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CODE_SEARCHERS } from "../codesearch.ts";
import {
	configPath,
	configuredGenerateModel,
	isPlausibleMailto,
	llmConfig,
	s2ApiKey,
	storedConfigView,
	updateStoredConfig,
} from "../config.ts";
import { chatPool, ensureLibrary, runChatReport, runReport, runRound, type ChatAnswer, type ChatDeps, type ChatReport, type ChatReportOptions, type ChatOptions, type ReportOptions, type SynthReport } from "../synthesis.ts";
import { ensureIndexed, type LibraryMatch, type LibraryPaper, matchLibrary, realCorpusDeps } from "../corpus.ts";
import { checkEmbedModel, type DoctorState, pullEmbedModel } from "../doctor.ts";
import { renderDigest, renderReportDigest } from "../digest.ts";
import { fetchAuthorMetrics, fetchJournalScores } from "../enrich.ts";
import {
	arxivVariantPrompt,
	isProseQuery,
	parseArxivSuggestion,
	parseTopicLines,
	parseVariantSuggestions,
	queryBlocks,
	TOPIC_SYSTEM_PROMPT,
	topicPrompt,
	VARIANT_SYSTEM_PROMPT,
	variantPrompt,
	type VariantSuggestion,
} from "../intake.ts";
import { writeNetworkPage } from "../network.ts";
import { outputRoot, synthReportName, writeRunOutputs } from "../output.ts";
import { sanitizeTermGroups } from "../pipeline.ts";
import type { ModelProvider, ProviderStatus } from "../provider.ts";
import { clearConversations, deleteConversation, historyDir, listConversations, loadConversation, newConversationId, saveConversation } from "./history.ts";
import { renderHtml, renderPaperChatReportHtml, renderSynthReportHtml, webPdfHref } from "../render.ts";
import { keyRequirement, runSearch, SEARCHERS, type SearchOptions, type SearchPayload } from "../search.ts";
import { parseIdentifier, renderFetchReport, runSelection, type SelectionRunOptions } from "../selection.ts";
import { listsForTopic } from "../sources/ecosystems.ts";
import { type AuthorMatch, autocompleteAuthors, authorFacets, type FacetPage, type FacetScope, journalFacets } from "../sources/openalex.ts";
import { contactMailto } from "../types.ts";
import {
	type AnswerView,
	type Candidate,
	type DialogContext,
	type DialogEvent,
	type DialogState,
	type DownloadOutcome,
	type Effect,
	FACET_LIMIT,
	initialDialog,
	reduce,
	type ReportOutcome,
	type SearchOutcome,
	stageOfStep,
} from "./dialog.ts";
import { FILE_TYPES, listLibrary, listReports, listSearchRuns, listSessions, pdfFile, safeName, searchCandidates, stageFile, stageOf } from "./files.ts";
import { revealFolder } from "./open.ts";
import { intakeFromForm, QUERY_BLOCK_MAX, QUERY_BLOCK_MIN, type SearchForm } from "./intake.ts";
import { JobBusyError, type JobInfo, JobRunner } from "./jobs.ts";
import { openSse, type SseConnection } from "./sse.ts";

/** Engine calls the routes make; every one replaceable for offline tests. */
export interface WebDeps {
	runSearch: (options: SearchOptions) => Promise<SearchPayload>;
	writeSearch: (payload: SearchPayload) => { htmlPath: string; jsonPath: string };
	runSelection: (options: SelectionRunOptions) => ReturnType<typeof runSelection>;
	ensureLibrary: (root: string, onWarn: (message: string) => void, signal?: AbortSignal) => Promise<LibraryMatch>;
	matchLibrary: (root: string) => LibraryMatch;
	ensureIndexed: (papers: LibraryPaper[], indexDir: string, embedModel: string, embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>, options: { force?: boolean; onProgress: (message: string) => void; signal: AbortSignal }) => Promise<{ indexed: number; failures: Array<{ file: string; reason: string }> }>;
	runReport: (options: ReportOptions, deps?: ChatDeps) => Promise<SynthReport>;
	writeReport: (report: SynthReport) => { htmlPath: string; jsonPath: string };
	runRound: (options: ChatOptions, deps?: ChatDeps) => Promise<ChatAnswer>;
	runChatReport: (options: ChatReportOptions, deps?: ChatDeps) => Promise<ChatReport>;
	writeChatReport: (report: ChatReport) => { htmlPath: string; jsonPath: string };
	journalFacets: (query: string, limit: number, scope: FacetScope) => Promise<FacetPage>;
	journalScores: (ids: string[]) => Promise<Map<string, number>>;
	authorFacets: (query: string, limit: number, scope: FacetScope) => Promise<FacetPage>;
	authorMetrics: (ids: string[]) => Promise<Map<string, { cites?: number; works?: number; hIndex?: number; topics?: string[] }>>;
	autocompleteAuthors: (prefix: string, signal: AbortSignal) => Promise<AuthorMatch[]>;
	listsForTopic: (topic: string, signal: AbortSignal) => Promise<{ lists: number; names: string[] } | null>;
	checkEmbedModel: (signal?: AbortSignal) => Promise<DoctorState>;
	pullEmbedModel: (onProgress: (line: string) => void, signal: AbortSignal) => Promise<void>;
	/** True when an HTTP server answers at the address (any status), false
	 * on a network error (nothing listening, timeout). */
	probe: (baseUrl: string, signal: AbortSignal) => Promise<boolean>;
}

export interface WebServerOptions {
	/** Data root (lit-search/ ... live here); default outputRoot(). */
	root?: string;
	/** Working directory for the loose-PDF folder chain; default process.cwd(). */
	cwd?: string;
	/** Folder of the conversation history; default historyDir() (next to the configuration file). */
	historyDir?: string;
	/** 0 (default) = any free port. */
	port?: number;
	token?: string;
	provider: ModelProvider;
	deps?: Partial<WebDeps>;
	/** Called after /api/stop closed the server (the pi command clears its handle). */
	onStop?: () => void;
}

export interface WebServer {
	url: string;
	port: number;
	token: string;
	root: string;
	close(): Promise<void>;
}

/** Display names of the text search sources (the dialog's summary). */
const SOURCE_LABELS: Record<string, string> = { arxiv: "arXiv", crossref: "CrossRef", openalex: "OpenAlex", semanticscholar: "Semantic Scholar" };

const JOURNAL_LIMIT = 12;
const AUTHOR_LIMIT = 12;
const AUTHOR_MATCH_LIMIT = 6;
const CODE_TOPIC_LIMIT = 5;
const LOOKUP_TIMEOUT_MS = 8_000;
const COOKIE = "plr_token";
const STATIC_DIR = fileURLToPath(new URL("./static/", import.meta.url));
const PDF_ROUTE = "/pdf";

export function realWebDeps(): WebDeps {
	return {
		runSearch,
		writeSearch: (payload) => {
			const written = writeRunOutputs(renderHtml(payload, { network: true }), payload);
			writeNetworkPage(written.htmlPath);
			return written;
		},
		runSelection,
		ensureLibrary: async (root, onWarn, signal) => (await ensureLibrary(root, onWarn, { signal })).match,
		matchLibrary: (root) => matchLibrary(root, () => {}),
		ensureIndexed: async (papers, indexDir, embedModel, embed, options) => {
			const { indexes, failures } = await ensureIndexed(papers, indexDir, embedModel, realCorpusDeps(embed), options);
			return { indexed: indexes.length, failures };
		},
		runReport,
		writeReport: (report) => writeRunOutputs(renderSynthReportHtml(report), report, undefined, "lit-synthesis", synthReportName(report.papers)),
		runRound,
		runChatReport,
		writeChatReport: (report) => writeRunOutputs(renderPaperChatReportHtml(report), report, undefined, "lit-synthesis"),
		journalFacets,
		journalScores: (ids) => fetchJournalScores(ids, () => {}),
		authorFacets,
		authorMetrics: (ids) => fetchAuthorMetrics(ids, () => {}),
		autocompleteAuthors,
		listsForTopic: async (topic, signal) => {
			const lists = await listsForTopic(topic, signal);
			return { lists: lists.length, names: lists.slice(0, 2).map((list) => list.slug.split("/")[1] ?? list.slug) };
		},
		checkEmbedModel: (signal) => checkEmbedModel(llmConfig(), fetch, signal),
		pullEmbedModel: (onProgress, signal) => pullEmbedModel(llmConfig(), onProgress, fetch, signal),
		probe: probeServer,
	};
}

/** Is a server listening at a model address? One GET of `<base>/models`
 * (OpenAI-compatible servers, llama.cpp and Ollama all answer it); any
 * HTTP status counts as alive, only a network error as down. */
async function probeServer(baseUrl: string, signal: AbortSignal): Promise<boolean> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal });
		await response.body?.cancel();
		return true;
	} catch {
		return false;
	}
}

/** Addresses on this machine: probed for the rail's status dots. */
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i;

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 2_000_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new HttpError(413, "request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text.trim()) return resolve({});
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(new HttpError(400, "request body is not JSON"));
			}
		});
		req.on("error", reject);
	});
}

function cookieValue(req: IncomingMessage, name: string): string | null {
	const header = req.headers.cookie;
	if (!header) return null;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

/** The loopback hosts a request may name (DNS-rebinding guard). Pure. */
export function hostAllowed(host: string | undefined, port: number): boolean {
	if (!host) return false;
	const normalized = host.trim().toLowerCase();
	return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}` || normalized === `[::1]:${port}`;
}

/** Session id for the browser's chat rounds: readable, unique per server
 * start, distinct from pi's UUIDs. */
export function webSessionId(now = new Date()): string {
	return `web-${now.toISOString().slice(0, 10)}-${randomBytes(2).toString("hex")}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
	const root = options.root ?? outputRoot();
	const cwd = options.cwd ?? process.cwd();
	const token = options.token ?? randomBytes(16).toString("hex");
	const provider = options.provider;
	const deps: WebDeps = { ...realWebDeps(), ...(options.deps ?? {}) };
	const jobs = new JobRunner();
	const connections = new Set<SseConnection>();
	let chatSession = webSessionId();
	let embedState: DoctorState | null = null;
	let server: Server;
	let port = 0;

	const pdfHref = webPdfHref(PDF_ROUTE);
	const fileUrl = (htmlPath: string): string => {
		const name = htmlPath.split(/[\\/]/).pop() ?? "";
		const stage = htmlPath.includes(`${join(root, "lit-synthesis")}`) ? "lit-synthesis" : "lit-search";
		return `/files/${stage}/${encodeURIComponent(name)}`;
	};

	jobs.subscribe((event) => {
		for (const connection of connections) connection.send(event.type, event);
		// The dialog waits for the job it started; its outcome moves the
		// conversation on (see jobOutcome below).
		if (event.type === "job" && event.job.state !== "running" && event.job.id === dialog.activeJob) applyDialog(jobOutcome(event.job));
	});

	const requireNoJob = (): void => {
		const { current } = jobs.snapshot();
		if (current) throw new HttpError(409, new JobBusyError(current).message);
	};

	/** Starting a job answers 409 while another runs (the page shows
	 * the running one and offers Cancel). */
	const startJob: JobRunner["start"] = (kind, label, work) => {
		try {
			return jobs.start(kind, label, work);
		} catch (error) {
			if (error instanceof JobBusyError) throw new HttpError(409, error.message);
			throw error;
		}
	};

	/** The embedding model must exist before index, report and chat jobs;
	 * the Settings page offers the pull. */
	const requireEmbedding = async (signal: AbortSignal): Promise<void> => {
		const state = await deps.checkEmbedModel(signal);
		embedState = state;
		if (state.state === "ok" || state.state === "not-ollama") return;
		if (state.state === "missing") {
			throw new Error(`embedding model ${state.model} is not available at ${state.baseUrl} -- fetch it on the Settings page (or run: ollama pull ${state.model})`);
		}
		throw new Error(`embedding server ${state.baseUrl} is unreachable (${state.error}) -- start it or change the address on the Settings page`);
	};

	const facetBlocks = (query: string): string[][] => sanitizeTermGroups(queryBlocks(query));
	const yearScope = (body: Record<string, unknown>): FacetScope => {
		const scope: FacetScope = {};
		if (typeof body.yearFrom === "number") scope.yearFrom = body.yearFrom;
		if (typeof body.yearTo === "number") scope.yearTo = body.yearTo;
		return scope;
	};

	/* ---------------- model helpers (routes and the dialog) ---------------- */

	/** Query variants from the writing model: three concept-block rows
	 * (plus1, plus2, arxiv), the arXiv row retried once when missing.
	 * `prose` switches the prompt's distillation rule on (the dialog does
	 * so for every request that is not a block expression: the plus1 row
	 * must cover the request's own concepts, not vary them). */
	const proposeVariants = async (query: string, hint: string, prose = isProseQuery(query)): Promise<{ variants: VariantSuggestion[]; note: string | null }> => {
		const signal = AbortSignal.timeout(60_000);
		const raw = await provider.generate({ system: VARIANT_SYSTEM_PROMPT, user: variantPrompt(query, hint, prose), maxTokens: 500, signal });
		const suggestions: VariantSuggestion[] = parseVariantSuggestions(raw, query);
		let note: string | null = null;
		if (!suggestions.some((entry) => entry.role === "arxiv")) {
			try {
				const retry = await provider.generate({ system: VARIANT_SYSTEM_PROMPT, user: arxivVariantPrompt(query, hint), maxTokens: 200, signal });
				const arxiv = parseArxivSuggestion(retry, query, suggestions.map((entry) => entry.text));
				if (arxiv) suggestions.push({ text: arxiv, role: "arxiv" });
				else note = "the model gave no arXiv variant";
			} catch (error) {
				note = `arXiv variant failed: ${errorMessage(error)}`;
			}
		}
		return { variants: suggestions, note };
	};

	/** GitHub list topics for the awesome-lists code source: the stored
	 * topics plus the model's suggestions, each checked for list counts. */
	const codeTopics = async (query: string): Promise<{ topics: Array<{ topic: string; lists: number | null; names: string[] }>; note: string | null }> => {
		const topics = new Set<string>(storedConfigView().codeListTopics ?? []);
		let note: string | null = null;
		if (provider.hasModel()) {
			try {
				const raw = await provider.generate({ system: TOPIC_SYSTEM_PROMPT, user: topicPrompt(query, facetBlocks(query), CODE_TOPIC_LIMIT), maxTokens: 200, signal: AbortSignal.timeout(60_000) });
				for (const topic of parseTopicLines(raw, CODE_TOPIC_LIMIT)) topics.add(topic);
			} catch (error) {
				note = `topic suggestions failed: ${errorMessage(error)}`;
			}
		} else {
			note = "no model selected -- only the configured topics are listed";
		}
		const rows = await Promise.all([...topics].map(async (topic) => {
			try {
				const found = await deps.listsForTopic(topic, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
				return { topic, lists: found?.lists ?? 0, names: found?.names ?? [] };
			} catch {
				return { topic, lists: null, names: [] };
			}
		}));
		return { topics: rows, note };
	};

	/* ---------------- job starts (routes and the dialog) ---------------- */

	/** The records of a finished search as pick candidates for the dialog
	 * (results first, dropped table after; code = repository or data link). */
	interface CandidateRecord {
		doi: string;
		arxiv_id: string;
		title: string;
		year: string;
		access?: { level: string };
		group?: string;
		code_url?: string;
		data_links?: unknown[];
	}
	const candidatesOf = (payload: SearchPayload): Candidate[] => {
		const keys = listLibrary(root, cwd, deps.matchLibrary(root)).keys;
		const rows: Array<{ record: CandidateRecord; dropped: boolean }> = [
			...(payload.results as CandidateRecord[]).map((record) => ({ record, dropped: false })),
			...(payload.dropped as Array<{ record: CandidateRecord }>).map((entry) => ({ record: entry.record, dropped: true })),
		];
		const out: Candidate[] = [];
		for (const { record, dropped } of rows) {
			const id = record.doi || (record.arxiv_id ? `arXiv:${record.arxiv_id}` : "");
			if (!id) continue;
			const key = record.doi ? `doi:${record.doi.toLowerCase()}` : `arxiv:${record.arxiv_id.replace(/v\d+$/i, "").toLowerCase()}`;
			out.push({
				id,
				title: record.title,
				year: record.year || null,
				access: record.access?.level ?? null,
				group: record.group ?? null,
				dropped,
				inLibrary: keys.has(key),
				code: Boolean(record.code_url || record.data_links?.length),
			});
		}
		return out;
	};

	const startSearchJob = (form: SearchForm): { job: JobInfo; warnings: string[]; query: string } => {
		const intake = intakeFromForm(form);
		if (!intake.options.query) throw new HttpError(400, "no query -- fill at least one concept block or the free text");
		requireNoJob();
		const job = startJob("search", `search: ${intake.options.query}`, async ({ signal, log }) => {
			for (const warning of intake.warnings) log(`note: ${warning}`);
			const payload = await deps.runSearch({ ...intake.options, onWarn: log, signal });
			const written = deps.writeSearch(payload);
			log(`written ${written.htmlPath}`);
			const name = (written.htmlPath.split(/[\\/]/).pop() ?? "").replace(/\.html$/i, "");
			const outcome: SearchOutcome = { name, htmlUrl: fileUrl(written.htmlPath), included: payload.results.length, dropped: payload.dropped.length, candidates: candidatesOf(payload) };
			return {
				htmlPath: written.htmlPath,
				htmlUrl: outcome.htmlUrl,
				name,
				digest: renderDigest(payload, written.htmlPath, "user"),
				flow: payload.flow,
				accessCounts: payload.access_counts,
				outcome,
			};
		});
		return { job, warnings: intake.warnings, query: intake.options.query };
	};

	const startSelectionJob = (body: Record<string, unknown>): JobInfo => {
		const identifiers = Array.isArray(body.identifiers)
			? body.identifiers.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)
			: [];
		if (!identifiers.length) throw new HttpError(400, "no identifiers");
		if (body.confirmed !== true) throw new HttpError(400, "confirm the download first");
		// Contact email for Unpaywall: configured, given for this run (and
		// optionally stored), or explicitly skipped for this run.
		let mailto: string | undefined;
		if (!contactMailto()) {
			const given = typeof body.mailto === "string" ? body.mailto.trim() : "";
			if (given) {
				if (!isPlausibleMailto(given)) throw new HttpError(400, `"${given}" does not look like an email address`);
				if (body.saveMailto === true) updateStoredConfig({ mailto: given });
				mailto = given;
			} else if (body.withoutUnpaywall !== true) {
				throw new HttpError(400, "give a contact email for Unpaywall or choose to continue without it");
			}
		}
		requireNoJob();
		const invalid = identifiers.filter((id) => parseIdentifier(id).kind === "unknown");
		return startJob("selection", `download ${identifiers.length} paper${identifiers.length === 1 ? "" : "s"}`, async ({ signal, log }) => {
			for (const id of invalid) log(`note: "${id}" is not a DOI or arXiv id`);
			const { results, papersDir } = await deps.runSelection({ identifiers, root, mailto, onWarn: log, signal });
			const count = (status: string) => results.filter((result) => result.status === status).length;
			const summary: DownloadOutcome = {
				downloaded: count("downloaded"),
				already: count("already"),
				browser: results.filter((result) => (result.status === "browser" || result.status === "restricted" || result.status === "not_free" || result.status === "dead_link") && result.browserUrl).map((result) => ({ id: result.id, url: result.browserUrl as string })),
				notFree: count("abstract_only") + results.filter((result) => (result.status === "not_free" || result.status === "dead_link") && !result.browserUrl).length,
				failed: count("invalid"),
				libraryCount: listLibrary(root, cwd, deps.matchLibrary(root)).papers.length,
			};
			return { results, papersDir, report: renderFetchReport(results, papersDir), summary };
		});
	};

	/** Reports from the chat follow the language of the user's questions
	 * (dialog effect); a direct POST without a language gets English,
	 * never the engine's German-preferred summary default (which would mix
	 * German summaries with answers in the question's language). */
	const WEB_REPORT_LANGUAGE = "English";

	const startReportJob = (body: Record<string, unknown>): JobInfo => {
		const papers: string[] | "library" = body.papers === "library"
			? "library"
			: Array.isArray(body.papers) ? body.papers.filter((name): name is string => typeof name === "string" && name.trim() !== "") : [];
		if (papers !== "library" && !papers.length) throw new HttpError(400, "select at least one document");
		const questions = Array.isArray(body.questions) ? body.questions.filter((q): q is string => typeof q === "string").map((q) => q.trim()).filter(Boolean) : [];
		const summary = body.summary === "bullets" || body.summary === "prose" ? body.summary : "none";
		const detailMode = body.detailMode === "cross-paper" ? "cross-paper" : "per-paper";
		const includeReview = body.includeReview === true;
		if (summary === "none" && !questions.length && !includeReview) throw new HttpError(400, "nothing to generate -- choose a summary, add a question or include the review");
		const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : WEB_REPORT_LANGUAGE;
		const uiLanguage = body.uiLanguage === "de" ? "de" : "en";
		requireNoJob();
		return startJob("report", "synthesis report", async ({ signal, log }) => {
			await requireEmbedding(signal);
			const wiring = provider.wiring();
			const report = await deps.runReport({
				papers, questions, summary, detailMode, includeReview, language, uiLanguage,
				session: chatSession, root,
				explainModel: wiring.explainModel, reviewModel: wiring.reviewModel,
				onWarn: log, onProgress: log, signal,
			}, { backend: wiring.backend });
			const written = deps.writeReport(report);
			log(`written ${written.htmlPath}`);
			const name = (written.htmlPath.split(/[\\/]/).pop() ?? "").replace(/\.html$/i, "");
			return {
				htmlPath: written.htmlPath,
				htmlUrl: fileUrl(written.htmlPath),
				name,
				digest: renderReportDigest(report, written.htmlPath),
				grounded: report.grounded,
				units: report.units.length,
			};
		});
	};

	const startChatJob = (body: Record<string, unknown>): JobInfo => {
		const question = typeof body.question === "string" ? body.question.trim() : "";
		if (!question) throw new HttpError(400, "empty question");
		const papers: string[] | "library" = body.papers === "library"
			? "library"
			: Array.isArray(body.papers) ? body.papers.filter((name): name is string => typeof name === "string" && name.trim() !== "") : [];
		if (papers !== "library" && !papers.length) throw new HttpError(400, "choose a document scope");
		const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : undefined;
		requireNoJob();
		const session = chatSession;
		return startJob("chat", `question: ${question.slice(0, 60)}`, async ({ signal, log }) => {
			await requireEmbedding(signal);
			const wiring = provider.wiring();
			const answer = await deps.runRound({ question, papers, session, language, root, model: wiring.explainModel, onWarn: log, signal }, { backend: wiring.backend });
			const pathByKey = new Map(answer.papers.map((paper) => [paper.key, paper.pdf_path]));
			// Links are built by code from the engine's citation sites; the
			// prose and references pass through untouched.
			return {
				session,
				answer,
				hrefs: answer.sites.map((site) => {
					const path = pathByKey.get(site.paper_key);
					return path ? pdfHref(path, site.page, site.snippet) : null;
				}),
				pdfUrls: Object.fromEntries(answer.papers.map((paper) => [paper.key, pdfHref(paper.pdf_path)])),
			};
		});
	};

	/* ---------------- the chat dialog ---------------- */

	const dialogContext = (): DialogContext => {
		const status = provider.status();
		const library = listLibrary(root, cwd, deps.matchLibrary(root)).papers.map((paper) => ({ base: paper.base, title: paper.title, year: paper.year, authors: paper.authors }));
		const ids = Object.keys(SEARCHERS);
		return {
			thisYear: new Date().getFullYear(),
			hasModel: provider.hasModel(),
			modelLabel: status.model ? `${status.model} ${status.via}` : null,
			noModelHint: status.kind === "pi" ? "choose one with /model in pi" : "set the generation model in Settings",
			mailtoSet: Boolean(contactMailto()),
			library,
			sources: ids.filter((id) => !keyRequirement(id)).map((id) => SOURCE_LABELS[id] ?? id),
			sourcesSkipped: ids.filter((id) => keyRequirement(id)).map((id) => SOURCE_LABELS[id] ?? id),
			storedTopics: storedConfigView().codeListTopics ?? [],
		};
	};

	let dialog: DialogState = initialDialog(dialogContext());
	const dialogView = () => ({ ...dialog, stage: stageOfStep(dialog.step), chatSession });
	const broadcastDialog = (): void => {
		const view = dialogView();
		for (const connection of connections) connection.send("dialog", view);
	};

	/* ---------------- conversation history ---------------- */

	/** Conversations live as JSON snapshots in the history folder
	 * (history.ts); the current one is the live `dialog`, saved after every
	 * change once it has a title. "+" starts an empty conversation under a
	 * new id; opening an entry loads its file. A conversation without a
	 * request or question (only chip clicks) has no title and is never
	 * saved. */
	const historyRoot = options.historyDir ?? historyDir();
	let currentId = newConversationId();
	let dialogStarted = new Date().toISOString();
	/** "Search: <request>", "Report: <first question>" or "Chat: <question>";
	 * null while the conversation has none of these. */
	const conversationTitle = (state: DialogState): string | null => {
		const a = state.answers;
		const clip = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 90);
		if (a.topic?.trim()) return `Search: ${clip(a.topic)}`;
		if (a.questions?.length) return `Report: ${clip(a.questions[0])}`;
		if (a.lastQuestion?.trim()) return `Chat: ${clip(a.lastQuestion)}`;
		return null;
	};
	/** Save the current conversation when it has a title. A failed write
	 * (read-only folder, full disk) must not break the chat: it is reported
	 * once per server run as a dialog note instead. */
	let saveFailureReported = false;
	const persistCurrent = (): void => {
		const title = conversationTitle(dialog);
		if (title === null) return;
		try {
			saveConversation(historyRoot, { version: 1, id: currentId, started: dialogStarted, updated: new Date().toISOString(), root, chatSession, title, dialog });
		} catch (error) {
			if (saveFailureReported) return;
			saveFailureReported = true;
			applyDialog({ kind: "effectFailed", effect: "newChatSession", error: `the conversation could not be saved to ${historyRoot}: ${errorMessage(error)}` });
		}
	};
	/** Every saved conversation plus the current one, newest change first;
	 * `here` = belongs to this data folder, `current` = the live one. */
	const historyView = () => {
		const { conversations, skipped } = listConversations(historyRoot);
		const title = conversationTitle(dialog);
		const live = title !== null && !conversations.some((entry) => entry.id === currentId)
			? [{ id: currentId, title, started: dialogStarted, updated: new Date().toISOString(), root, steps: dialog.trail.length }]
			: [];
		return {
			history: [...live, ...conversations].map((entry) => ({ ...entry, current: entry.id === currentId, here: entry.root === root })),
			skipped,
			dir: historyRoot,
		};
	};
	const startFresh = (): void => {
		currentId = newConversationId();
		dialogStarted = new Date().toISOString();
		chatSession = webSessionId();
		applyDialog({ kind: "restart" });
	};
	/** Swapping conversations while a job or a model call is in flight
	 * would deliver its outcome to the wrong conversation. */
	const requireIdle = (): void => {
		if (jobs.snapshot().current) throw new HttpError(409, "a job is running -- wait for it or stop it in its box");
		if (dialog.pending) throw new HttpError(409, "the model is still answering -- wait a moment");
	};

	/** Apply one event, tell every tab, run the effects it asked for. */
	const applyDialog = (event: DialogEvent): void => {
		const { state: next, effects } = reduce(dialog, event, dialogContext());
		dialog = next;
		const view = dialogView();
		for (const connection of connections) connection.send("dialog", view);
		persistCurrent();
		for (const effect of effects) void runEffect(effect);
	};

	/** Translate a finished job into the dialog's event. */
	const jobOutcome = (job: JobInfo): DialogEvent => {
		const r = (job.result ?? {}) as Record<string, unknown>;
		switch (job.kind) {
			case "search": return { kind: "job", job, search: r.outcome as SearchOutcome | undefined };
			case "selection": return { kind: "job", job, download: r.summary as DownloadOutcome | undefined };
			case "chat": return { kind: "job", job, answer: r.answer ? { answer: r.answer, hrefs: r.hrefs, pdfUrls: r.pdfUrls } as AnswerView : undefined };
			case "report": return { kind: "job", job, report: typeof r.name === "string" ? { name: r.name, htmlUrl: String(r.htmlUrl), grounded: Boolean(r.grounded), units: Number(r.units ?? 0) } as ReportOutcome : undefined };
			default: return { kind: "job", job };
		}
	};

	const runEffect = async (effect: Effect): Promise<void> => {
		try {
			switch (effect.kind) {
				case "proposeBlocks": {
					const { variants, note } = await proposeVariants(effect.query, "", true);
					applyDialog({ kind: "blocks", variants, ...(note ? { error: note } : {}) });
					return;
				}
				case "loadTopics": {
					const { topics, note } = await codeTopics(effect.query);
					applyDialog({ kind: "topics", topics: topics.map((row) => ({ topic: row.topic, lists: row.lists })), ...(note ? { error: note } : {}) });
					return;
				}
				case "loadJournals": {
					const scope: FacetScope = { blocks: facetBlocks(effect.query) };
					if (effect.yearFrom !== undefined) scope.yearFrom = effect.yearFrom;
					if (effect.yearTo !== undefined) scope.yearTo = effect.yearTo;
					const page = await deps.journalFacets(effect.query, FACET_LIMIT, scope);
					const scores = await deps.journalScores(page.listed.map((facet) => facet.id));
					applyDialog({ kind: "journals", journals: page.listed.map((facet) => ({ id: facet.id, name: facet.name, works: facet.count, score: scores.get(facet.id) ?? null })) });
					return;
				}
				case "loadAuthors": {
					const scope: FacetScope = { blocks: facetBlocks(effect.query) };
					if (effect.yearFrom !== undefined) scope.yearFrom = effect.yearFrom;
					if (effect.yearTo !== undefined) scope.yearTo = effect.yearTo;
					if (effect.sourceIds.length) scope.sourceIds = effect.sourceIds;
					const page = await deps.authorFacets(effect.query, FACET_LIMIT, scope);
					const metrics = await deps.authorMetrics(page.listed.map((facet) => facet.id));
					applyDialog({ kind: "authors", authors: page.listed.map((facet) => ({ id: facet.id, name: facet.name, works: facet.count, ...(metrics.get(facet.id) ?? {}) })) });
					return;
				}
				case "lookupAuthor": {
					const matches = (await deps.autocompleteAuthors(effect.prefix, AbortSignal.timeout(LOOKUP_TIMEOUT_MS))).slice(0, AUTHOR_MATCH_LIMIT);
					applyDialog({ kind: "authorLookup", matches });
					return;
				}
				case "startSearch":
					applyDialog({ kind: "jobStarted", job: startSearchJob(effect.form).job });
					return;
				case "startSelection":
					applyDialog({ kind: "jobStarted", job: startSelectionJob({ identifiers: effect.identifiers, confirmed: true, mailto: effect.mailto, saveMailto: effect.saveMailto, withoutUnpaywall: effect.withoutUnpaywall }) });
					return;
				case "startChat":
					applyDialog({ kind: "jobStarted", job: startChatJob({ question: effect.question, papers: effect.papers }) });
					return;
				case "startReport":
					applyDialog({ kind: "jobStarted", job: startReportJob({
						papers: effect.papers, questions: effect.questions, summary: effect.summary, detailMode: effect.detailMode, includeReview: effect.includeReview,
						language: effect.language === "de" ? "German" : "English", uiLanguage: effect.language,
					}) });
					return;
				case "newChatSession":
					chatSession = webSessionId();
					return;
				default:
					return;
			}
		} catch (error) {
			applyDialog({ kind: "effectFailed", effect: effect.kind, error: errorMessage(error) });
		}
	};

	/* ---------------- state and listings ---------------- */

	/** Local model servers are probed on every state read (1.5 s cap each)
	 * so the rail shows red when llama.cpp or Ollama is not running;
	 * remote services are not probed (null). */
	const reachability = async (status: ProviderStatus): Promise<{ modelReachable: boolean | null; embeddingsReachable: boolean | null }> => {
		const check = async (url: string | null): Promise<boolean | null> => {
			if (!url || !LOCAL_URL.test(url)) return null;
			return deps.probe(url, AbortSignal.timeout(1500));
		};
		const [modelReachable, embeddingsReachable] = await Promise.all([check(status.model ? status.baseUrl : null), check(status.embeddingsBaseUrl)]);
		return { modelReachable, embeddingsReachable };
	};

	const state = async () => {
		const status = provider.status();
		const reachable = await reachability(status);
		const runs = listSearchRuns(root);
		const library = listLibrary(root, cwd, deps.matchLibrary(root));
		const reports = listReports(root);
		const sessions = listSessions(root);
		const view = storedConfigView();
		const cfg = llmConfig();
		return {
			root,
			cwd,
			url: `http://127.0.0.1:${port}/`,
			provider: { ...status, ...reachable },
			job: jobs.snapshot().current,
			chatSession,
			counts: {
				runs: runs.length,
				pdfs: library.papers.length,
				reports: reports.filter((report) => report.kind === "synthesis").length,
				sessions: sessions.length,
			},
			recent: [
				...runs.slice(0, 6).map((run) => ({ kind: "search", name: run.name, label: run.query, date: run.generated.slice(0, 10), url: run.html ? `/files/lit-search/${encodeURIComponent(run.name)}.html` : null })),
				...reports.slice(0, 6).map((report) => ({ kind: report.kind === "chat" ? "chat report" : "report", name: report.name, label: report.name.replace(/^\d{4}-\d{2}-\d{2}_/, ""), date: report.generated.slice(0, 10), url: report.html ? `/files/lit-synthesis/${encodeURIComponent(report.name)}.html` : null })),
				...sessions.slice(0, 3).map((session) => ({ kind: "chat", name: session.session, label: `${session.session} · ${session.rounds.length} round${session.rounds.length === 1 ? "" : "s"}`, date: session.last.slice(0, 10), url: null })),
			].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8),
			library: library.papers.slice(0, 8).map((paper) => ({ base: paper.base, year: paper.year, title: paper.title, authors: paper.authors })),
			config: {
				path: configPath(),
				mailto: contactMailto(),
				mailtoStored: Boolean(view.mailto),
				keys: { ...view.keys, s2Active: Boolean(s2ApiKey()) },
				codeListTopics: view.codeListTopics,
				llm: cfg,
				generateModelConfigured: configuredGenerateModel(),
				embedState,
			},
			sources: Object.keys(SEARCHERS).map((id) => ({ id, keyNote: keyRequirement(id) })),
			codeSources: Object.keys(CODE_SEARCHERS),
			queryBlocks: { min: QUERY_BLOCK_MIN, max: QUERY_BLOCK_MAX },
		};
	};

	/* ---------------- routes ---------------- */

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		const path = url.pathname;
		const method = req.method ?? "GET";

		if (!hostAllowed(req.headers.host, port)) throw new HttpError(403, "unexpected Host header");

		// Token: first visit with ?token= sets the cookie and redirects to
		// the clean address; afterwards the cookie (or a bearer header) counts.
		const queryToken = url.searchParams.get("token");
		if (queryToken !== null) {
			if (queryToken !== token) throw new HttpError(401, "invalid token");
			res.writeHead(302, {
				"set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
				location: path === "/" ? "/" : path,
				"cache-control": "no-store",
			});
			res.end();
			return;
		}
		const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
		if (cookieValue(req, COOKIE) !== token && bearer !== token) {
			throw new HttpError(401, "not authorized -- open the address printed in pi (it carries the token)");
		}

		// Interface files.
		if (method === "GET" && (path === "/" || path === "/index.html")) return serveStatic(res, "index.html");
		if (method === "GET" && path.startsWith("/static/")) return serveStatic(res, path.slice("/static/".length));

		// Output files: reports and sidecars from the three stage folders;
		// synthesis pages re-rendered with server PDF links when the JSON
		// sidecar is there (the file on disk keeps its file:// links).
		if (method === "GET" && path.startsWith("/files/")) {
			const [stageName, ...rest] = path.slice("/files/".length).split("/");
			const stage = stageOf(stageName);
			const name = rest.length === 1 ? decodeURIComponent(rest[0]) : "";
			const file = stage && name ? stageFile(root, stage, name) : null;
			if (!file) throw new HttpError(404, "no such file");
			if (stage === "lit-synthesis" && name.toLowerCase().endsWith(".html")) {
				const sidecar = stageFile(root, stage, name.replace(/\.html?$/i, ".json"));
				const rendered = sidecar ? renderSynthesisPage(sidecar) : null;
				if (rendered !== null) {
					res.writeHead(200, { "content-type": FILE_TYPES.html, "cache-control": "no-store" });
					res.end(rendered);
					return;
				}
			}
			return serveFile(res, file);
		}
		if (method === "GET" && path.startsWith(`${PDF_ROUTE}/`)) {
			const name = decodeURIComponent(path.slice(PDF_ROUTE.length + 1));
			const file = pdfFile(root, cwd, name);
			if (!file) throw new HttpError(404, "no such PDF in the library");
			return serveFile(res, file);
		}

		if (!path.startsWith("/api/")) throw new HttpError(404, "not found");
		const route = `${method} ${path}`;

		if (route === "GET /api/state") return json(res, 200, await state());
		if (route === "GET /api/events") {
			const connection = openSse(res);
			connections.add(connection);
			const snapshot = jobs.snapshot();
			connection.send("snapshot", snapshot);
			connection.send("dialog", dialogView());
			req.on("close", () => {
				connections.delete(connection);
				connection.close();
			});
			return;
		}
		if (route === "GET /api/jobs") return json(res, 200, jobs.snapshot());
		if (method === "POST" && /^\/api\/jobs\/[^/]+\/cancel$/.test(path)) {
			const id = decodeURIComponent(path.split("/")[3]);
			return json(res, 200, { cancelled: jobs.cancel(id) });
		}
		if (route === "POST /api/jobs/cancel") return json(res, 200, { cancelled: jobs.cancel() });

		if (route === "GET /api/runs") {
			return json(res, 200, {
				runs: listSearchRuns(root).map((run) => ({
					...run,
					htmlUrl: run.html ? `/files/lit-search/${encodeURIComponent(run.name)}.html` : null,
					jsonUrl: `/files/lit-search/${encodeURIComponent(run.name)}.json`,
				})),
				reports: listReports(root).map((report) => ({
					...report,
					htmlUrl: report.html ? `/files/lit-synthesis/${encodeURIComponent(report.name)}.html` : null,
					jsonUrl: `/files/lit-synthesis/${encodeURIComponent(report.name)}.json`,
				})),
				sessions: listSessions(root).map((session) => ({
					session: session.session,
					rounds: session.rounds.length,
					last: session.last,
					scope: session.scope,
					lastQuestion: session.rounds[session.rounds.length - 1]?.question ?? "",
				})),
			});
		}
		if (route === "GET /api/library") {
			const library = listLibrary(root, cwd, deps.matchLibrary(root));
			return json(res, 200, {
				papers: library.papers.map((paper) => ({ ...paper, pdfUrl: pdfHref(paper.file) })),
				dirs: library.dirs,
				embeddingModel: llmConfig().embedModel,
			});
		}

		/* ---- search ---- */
		if (route === "POST /api/search/variants") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const query = typeof body.query === "string" ? body.query.trim() : "";
			if (!query) throw new HttpError(400, "query is empty");
			if (!provider.hasModel()) return json(res, 200, { model: null, variants: [], note: "no model selected -- variants need a model" });
			const hint = typeof body.hint === "string" ? body.hint.trim() : "";
			const { variants, note } = await proposeVariants(query, hint);
			return json(res, 200, { model: provider.status().model, variants, note });
		}
		if (route === "POST /api/search/journals") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const query = typeof body.query === "string" ? body.query.trim() : "";
			if (!query) throw new HttpError(400, "query is empty");
			const page = await deps.journalFacets(query, JOURNAL_LIMIT, { ...yearScope(body), blocks: facetBlocks(query) });
			const scores = await deps.journalScores(page.listed.map((facet) => facet.id));
			return json(res, 200, {
				journals: page.listed.map((facet) => ({ id: facet.id, name: facet.name, works: facet.count, score: scores.get(facet.id) ?? null })),
				otherCount: page.otherCount,
			});
		}
		if (route === "POST /api/search/authors") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const query = typeof body.query === "string" ? body.query.trim() : "";
			if (!query) throw new HttpError(400, "query is empty");
			const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.filter((id): id is string => typeof id === "string") : [];
			const page = await deps.authorFacets(query, AUTHOR_LIMIT, { ...yearScope(body), ...(sourceIds.length ? { sourceIds } : {}), blocks: facetBlocks(query) });
			const metrics = await deps.authorMetrics(page.listed.map((facet) => facet.id));
			return json(res, 200, {
				authors: page.listed.map((facet) => ({ id: facet.id, name: facet.name, works: facet.count, ...(metrics.get(facet.id) ?? {}) })),
				otherCount: page.otherCount,
			});
		}
		if (route === "POST /api/search/author-lookup") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const prefix = typeof body.q === "string" ? body.q.trim() : "";
			if (prefix.length < 3) return json(res, 200, { matches: [] });
			const matches = (await deps.autocompleteAuthors(prefix, AbortSignal.timeout(LOOKUP_TIMEOUT_MS))).slice(0, AUTHOR_MATCH_LIMIT);
			const metrics = await deps.authorMetrics(matches.map((match) => match.id));
			return json(res, 200, { matches: matches.map((match) => ({ ...match, ...(metrics.get(match.id) ?? {}) })) });
		}
		if (route === "POST /api/search/code-topics") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const query = typeof body.query === "string" ? body.query.trim() : "";
			if (!query) throw new HttpError(400, "query is empty");
			const { topics, note } = await codeTopics(query);
			return json(res, 200, { topics, note });
		}
		if (route === "POST /api/search/run") {
			const started = startSearchJob((await readBody(req)) as SearchForm);
			return json(res, 202, started);
		}

		/* ---- selection ---- */
		if (route === "GET /api/selection/candidates") {
			const run = url.searchParams.get("run") ?? "";
			const library = listLibrary(root, cwd, deps.matchLibrary(root));
			const candidates = searchCandidates(root, run, library.keys);
			if (!candidates) throw new HttpError(404, "no such search run");
			return json(res, 200, { candidates });
		}
		if (route === "POST /api/selection/run") {
			const job = startSelectionJob((await readBody(req)) as Record<string, unknown>);
			return json(res, 202, { job });
		}

		/* ---- synthesis ---- */
		if (route === "POST /api/index") {
			const body = (await readBody(req)) as Record<string, unknown>;
			requireNoJob();
			const force = body.reindex === true;
			const job = startJob("index", force ? "re-index the library" : "index the library", async ({ signal, log }) => {
				await requireEmbedding(signal);
				const match = await deps.ensureLibrary(root, log, signal);
				const pool = chatPool(match);
				if (!pool.length) throw new Error("no PDFs in the library -- download papers first (2 Selection) or start pi in the folder holding the PDFs");
				const wiring = provider.wiring();
				const cfg = llmConfig();
				const outcome = await deps.ensureIndexed(pool, join(root, "lit-synthesis", "index"), cfg.embedModel, (texts, s) => wiring.backend.embed(texts, s), { force, onProgress: log, signal });
				for (const failure of outcome.failures) log(`excluded: ${failure.file} -- ${failure.reason}`);
				log(`index ready: ${outcome.indexed} paper${outcome.indexed === 1 ? "" : "s"} (${cfg.embedModel})`);
				return outcome;
			});
			return json(res, 202, { job });
		}
		if (route === "POST /api/report") {
			const job = startReportJob((await readBody(req)) as Record<string, unknown>);
			return json(res, 202, { job });
		}

		/* ---- paper chat ---- */
		if (route === "GET /api/chat/sessions") {
			const library = listLibrary(root, cwd, deps.matchLibrary(root));
			const pathByKey = new Map(library.papers.map((paper) => [paper.verified ? (paper.doi ? `doi:${paper.doi.toLowerCase()}` : `arxiv:${paper.arxiv_id.replace(/v\d+$/i, "").toLowerCase()}`) : `file:${paper.base}`, paper.file]));
			const sessions = listSessions(root).map((session) => ({
				...session,
				current: session.session === chatSession,
				rounds: session.rounds.map((round) => ({
					...round,
					hrefs: (round.sites ?? []).map((site) => {
						const path = pathByKey.get(site.paper_key);
						return path ? pdfHref(path, site.page, site.snippet) : null;
					}),
				})),
			}));
			return json(res, 200, { current: chatSession, sessions });
		}
		if (route === "POST /api/chat/session") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const wanted = typeof body.session === "string" ? body.session.trim() : "";
			chatSession = wanted || webSessionId();
			return json(res, 200, { current: chatSession });
		}
		if (route === "POST /api/chat") {
			const job = startChatJob((await readBody(req)) as Record<string, unknown>);
			return json(res, 202, { job });
		}
		if (route === "POST /api/chat/report") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const paper = typeof body.paper === "string" ? body.paper.trim() : "";
			if (!paper) throw new HttpError(400, "the session report covers ONE paper -- choose it");
			const focus = typeof body.question === "string" && body.question.trim() ? body.question.trim() : undefined;
			const session = typeof body.session === "string" && body.session.trim() ? body.session.trim() : chatSession;
			requireNoJob();
			const job = startJob("chat-report", `session report: ${paper}`, async ({ signal, log }) => {
				await requireEmbedding(signal);
				const wiring = provider.wiring();
				const report = await deps.runChatReport({ paper, session, question: focus, root, model: wiring.explainModel, onWarn: log, signal }, { backend: wiring.backend });
				const written = deps.writeChatReport(report);
				log(`written ${written.htmlPath}`);
				return { htmlPath: written.htmlPath, htmlUrl: fileUrl(written.htmlPath), grounded: report.grounded };
			});
			return json(res, 202, { job });
		}

		/* ---- the chat dialog ---- */
		if (route === "GET /api/dialog") return json(res, 200, dialogView());
		if (route === "POST /api/dialog/answer") {
			const body = (await readBody(req)) as Record<string, unknown>;
			requireNoJob();
			const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
			applyDialog({
				kind: "answer",
				text: typeof body.text === "string" ? body.text : undefined,
				chip: typeof body.chip === "string" ? body.chip : undefined,
				ids: strings(body.ids),
				blocks: strings(body.blocks),
				toggles: strings(body.toggles),
			});
			return json(res, 200, dialogView());
		}
		if (route === "POST /api/dialog/restart") {
			jobs.cancel();
			applyDialog({ kind: "restart" });
			return json(res, 200, dialogView());
		}
		// "+" on the page: the current conversation stays saved, an empty one starts.
		if (route === "POST /api/dialog/new") {
			requireIdle();
			startFresh();
			return json(res, 200, dialogView());
		}
		if (route === "GET /api/history") return json(res, 200, historyView());
		// Continue a saved conversation; the current one stays saved.
		if (route === "POST /api/history/open") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const id = typeof body.id === "string" ? body.id : "";
			if (id === currentId) return json(res, 200, { ...dialogView(), otherRoot: null });
			requireIdle();
			const entry = loadConversation(historyRoot, id);
			if (!entry) throw new HttpError(404, "no such conversation");
			persistCurrent();
			dialog = entry.dialog;
			currentId = entry.id;
			chatSession = entry.chatSession;
			dialogStarted = entry.started;
			broadcastDialog();
			return json(res, 200, { ...dialogView(), otherRoot: entry.root === root ? null : entry.root });
		}
		// Delete one conversation file; deleting the current one starts an empty conversation.
		if (route === "POST /api/history/delete") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const id = typeof body.id === "string" ? body.id : "";
			if (id === currentId) requireIdle();
			const deleted = deleteConversation(historyRoot, id);
			if (id === currentId) startFresh();
			return json(res, 200, { deleted, dialog: dialogView() });
		}
		if (route === "POST /api/history/clear") {
			requireIdle();
			const deleted = clearConversations(historyRoot);
			startFresh();
			return json(res, 200, { deleted, dialog: dialogView() });
		}
		// Show a data folder in the file manager: one of the three stage
		// folders (the folder button of a file card) or the data root itself
		// (the folder icon in the rail). Nothing else.
		if (route === "POST /api/reveal") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const wanted = typeof body.stage === "string" ? body.stage.replace(/\/$/, "") : "";
			const stage = wanted === "root" ? "" : stageOf(wanted);
			if (stage === null) throw new HttpError(400, "unknown folder");
			const folder = stage ? join(root, stage) : root;
			if (!existsSync(folder)) throw new HttpError(404, `${stage}/ does not exist yet`);
			revealFolder(folder);
			return json(res, 200, { opened: folder });
		}

		/* ---- settings ---- */
		if (route === "GET /api/settings") {
			return json(res, 200, { ...storedConfigView(), path: configPath(), resolved: llmConfig(), mailtoResolved: contactMailto(), embedState, historyDir: historyRoot, conversations: listConversations(historyRoot).conversations.length });
		}
		if (route === "POST /api/settings") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const patch: Parameters<typeof updateStoredConfig>[0] = {};
			if (typeof body.mailto === "string") {
				const mailto = body.mailto.trim();
				if (mailto && !isPlausibleMailto(mailto)) throw new HttpError(400, `"${mailto}" does not look like an email address`);
				patch.mailto = mailto || undefined;
			}
			if (Array.isArray(body.codeListTopics)) {
				const topics = body.codeListTopics.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
				patch.codeListTopics = topics.length ? topics : undefined;
			}
			if (body.llm && typeof body.llm === "object") {
				const given = body.llm as Record<string, unknown>;
				const current = storedConfigView().llm;
				const llm: Record<string, unknown> = { ...current };
				for (const key of ["baseUrl", "api", "generateModel", "embedModel", "embedBaseUrl", "embedApi", "generateBaseUrl", "generateApi", "chatModel"]) {
					if (!(key in given)) continue;
					const value = typeof given[key] === "string" ? (given[key] as string).trim() : "";
					if (value) llm[key] = value;
					else delete llm[key];
				}
				// The api key never comes from a page: by design it is edited in
				// the file by hand; an existing value survives every save.
				const stored = (storedConfigView().keys.llmApiKey ? { apiKey: llmConfig().apiKey } : {});
				patch.llm = { ...llm, ...stored } as typeof patch.llm;
			}
			const written = updateStoredConfig(patch);
			embedState = null;
			return json(res, 200, { written, ...storedConfigView(), resolved: llmConfig(), mailtoResolved: contactMailto() });
		}
		if (route === "POST /api/settings/check") {
			requireNoJob();
			const job = startJob("check", "test the setup", async ({ signal, log }) => {
				const cfg = llmConfig();
				log(`config   ${configPath()}`);
				log(`embed    ${cfg.embedModel} (${cfg.embedApi ?? cfg.api} at ${cfg.embedBaseUrl || cfg.baseUrl})`);
				const status = provider.status();
				log(`model    ${status.model ?? "(none)"} ${status.via}`);
				embedState = await deps.checkEmbedModel(signal);
				log(`doctor   ${embedState.state}${"baseUrl" in embedState ? ` at ${embedState.baseUrl}` : ""}${"error" in embedState ? `: ${embedState.error}` : ""}`);
				const wiring = provider.wiring();
				let started = Date.now();
				const [vector] = await wiring.backend.embed(["river sandbar detection with Sentinel-2 imagery"], signal);
				log(`embed OK: ${vector.length} dimensions in ${Date.now() - started} ms`);
				started = Date.now();
				const reply = await provider.generate({ system: "You are a connectivity test. Answer with a single short sentence.", user: "Say that the connection works.", maxTokens: 24, temperature: 0, signal });
				log(`generate OK in ${Date.now() - started} ms: ${reply.trim().replace(/\s+/g, " ").slice(0, 120)}`);
				log(`mailto   ${contactMailto() ? "set" : "not set"} · s2ApiKey ${s2ApiKey() ? "set" : "not set (Semantic Scholar off)"}`);
				return { ok: true, embedState };
			});
			return json(res, 202, { job });
		}
		if (route === "POST /api/settings/pull-embed") {
			requireNoJob();
			const job = startJob("pull", `fetch the embedding model ${llmConfig().embedModel}`, async ({ signal, log }) => {
				await deps.pullEmbedModel(log, signal);
				embedState = await deps.checkEmbedModel(signal);
				return { embedState };
			});
			return json(res, 202, { job });
		}
		if (route === "POST /api/stop") {
			json(res, 200, { stopping: true });
			setTimeout(() => {
				void close().then(() => options.onStop?.());
			}, 50);
			return;
		}
		throw new HttpError(404, `no route ${route}`);
	};

	/** The synthesis page re-rendered from its JSON sidecar with /pdf/
	 * links (null when the sidecar is neither report kind). */
	const renderSynthesisPage = (sidecar: string): string | null => {
		let payload: Record<string, any>;
		try {
			payload = JSON.parse(readFileSync(sidecar, "utf8"));
		} catch {
			return null;
		}
		try {
			if (Array.isArray(payload?.units) && Array.isArray(payload?.papers)) {
				return renderSynthReportHtml(payload as SynthReport, { pdfHref });
			}
			if (Array.isArray(payload?.rounds) && payload?.paper?.pdf_path) {
				return renderPaperChatReportHtml(payload as ChatReport, { pdfHref });
			}
		} catch {
			return null;
		}
		return null;
	};

	const serveStatic = (res: ServerResponse, name: string): void => {
		const safe = safeName(name);
		if (!safe) throw new HttpError(404, "not found");
		serveFile(res, join(STATIC_DIR, safe));
	};

	const serveFile = (res: ServerResponse, file: string): void => {
		let size: number;
		try {
			size = statSync(file).size;
		} catch {
			throw new HttpError(404, "not found");
		}
		const extension = file.toLowerCase().split(".").pop() ?? "";
		res.writeHead(200, {
			"content-type": FILE_TYPES[extension] ?? "application/octet-stream",
			"content-length": size,
			"cache-control": "no-store",
		});
		createReadStream(file).pipe(res);
	};

	server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			const status = error instanceof HttpError ? error.status : 500;
			json(res, status, { error: errorMessage(error) });
		});
	});
	server.keepAliveTimeout = 5_000;

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	port = (server.address() as AddressInfo).port;

	let closed: Promise<void> | null = null;
	const close = (): Promise<void> => {
		if (closed) return closed;
		closed = new Promise<void>((resolve) => {
			jobs.cancel();
			for (const connection of connections) connection.close();
			connections.clear();
			server.close(() => resolve());
			server.closeAllConnections();
		});
		return closed;
	};

	return {
		url: `http://127.0.0.1:${port}/?token=${token}`,
		port,
		token,
		root,
		close,
	};
}
