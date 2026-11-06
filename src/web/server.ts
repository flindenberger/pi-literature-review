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
 * (DNS rebinding); API answers carry Cache-Control: no-store. Several
 * jobs run side by side, each with its own abort switch (jobs.ts); every
 * job the dialog starts belongs to its conversation, and a conversation
 * left while busy is parked until its outcome has arrived.
 *
 * The one inviolable rule holds here as everywhere: the server passes
 * citation data from the engines through unchanged and never rewrites it.
 * Every engine call is injectable (deps) so the routes test offline.
 */

import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CODE_SEARCHERS } from "../codesearch.ts";
import {
	addPdfFolder,
	configPath,
	configuredGenerateModel,
	isPlausibleMailto,
	lastDownloadDir,
	llmConfig,
	pdfFolders,
	rememberDownloadDir,
	removePdfFolder,
	s2ApiKey,
	storedConfigView,
	THINKING_SETTINGS,
	thinkingFor,
	thinkingSetting,
	type ThinkingSetting,
	updateStoredConfig,
} from "../config.ts";
import { canPickFolder, pickFiles, pickFolder } from "../folderpick.ts";
import { listServerModels } from "../llm.ts";
import { type AuthorFacts, lookupAuthorFacts, lookupTopWorkDoi, lookupWorkAuthors, lookupWorkFacts, type WorkFacts } from "../sources/openalex.ts";
import { type Employment, lookupOrcidByDoi, lookupOrcidEmployments, type OrcidPerson } from "../sources/orcid.ts";
import { EXAMPLES_SYSTEM, type ExamplePaper, examplePaperName, examplesPrompt, parseExamples } from "./examples.ts";
import { chatPool, ensureLibrary, runChatReport, runReport, runRound, type AnsweredQuestion, type ChatAnswer, type ChatDeps, type ChatReport, type ChatReportOptions, type ChatOptions, type ReportOptions, type SynthReport } from "../synthesis.ts";
import { ensureIndexed, libraryFiles, type LibraryMatch, type LibraryPaper, matchLibrary, realCorpusDeps } from "../corpus.ts";
import { inboxDir, pdfBase } from "../library.ts";
import { checkEmbedModel, type DoctorState, pullEmbedModel } from "../doctor.ts";
import { renderDigest, renderReportDigest } from "../digest.ts";
import { fetchAuthorMetrics, fetchJournalScores } from "../enrich.ts";
import {
	arxivVariantPrompt,
	blocksForEditing,
	deriveGroupsFromQuery,
	formatGroupExpression,
	isBlockExpression,
	isProseQuery,
	parseGroupSpec,
	needsTranslation,
	ownBlocksPrompt,
	parseArxivSuggestion,
	parseOwnBlocks,
	parseTopicLines,
	parseVariantSuggestions,
	queryBlocks,
	TOPIC_SYSTEM_PROMPT,
	topicPrompt,
	VARIANT_SYSTEM_PROMPT,
	variantPrompt,
	type VariantSuggestion,
} from "../intake.ts";
import { NETWORK_PAGE_NAME, renderNetworkHtml, writeNetworkPage } from "../network.ts";
import { htmlPathFor, jsonPathFor, outputRoot, synthReportName, writeRunOutputs } from "../output.ts";
import { sameAuthorName, sanitizeTermGroups } from "../pipeline.ts";
import type { ModelProvider, ProviderStatus } from "../provider.ts";
import { type BlockMode, blockCachePath, blockCacheSize, cachedBlocks, clearBlockCache, saveBlocks } from "./blockcache.ts";
import { clearConversations, conversationFiles, deleteConversation, historyDir, listConversations, loadConversation, newConversationId, saveConversation } from "./history.ts";
import { candidatesFromRecords, type CandidateRecord } from "../pick.ts";
import { parseSocialReply, SOCIAL_SYSTEM, socialCandidate, STEP_ACCEPTS } from "./help.ts";
import { describeFilters, prismaSvgFor, renderHtml, searchLabel, renderPaperChatReportHtml, renderSynthReportHtml, webPdfHref } from "../render.ts";
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
	type FileCard,
	parseSearchOptions,
	parseChatOptions,
	type PeriodPreset,
	type SearchAgainFilters,
	FACET_LIMIT,
	initialDialog,
	isAuthorsOnly,
	isHandBuilt,
	authorsOnlyLabel,
	reduce,
	type ReportOutcome,
	type SearchOutcome,
	stageOfStep,
	type StartStage,
} from "./dialog.ts";
import { Indexer } from "./indexer.ts";
import { FILE_TYPES, indexSummary, listLibrary, listReports, listSearchRuns, listSessions, pdfFile, readRunPayload, safeName, searchCandidates, stageFile, stageOf } from "./files.ts";
import { applyCardFilters, cardRows, describeCardFilters, hasCardFilters, parseCardFilters } from "./results.ts";
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
	authorMetrics: (ids: string[]) => Promise<Map<string, { cites?: number; works?: number; hIndex?: number; topics?: string[]; institution?: string }>>;
	/** DOI of an author's most cited work (the ORCID fallback without a card). */
	topWorkDoi: (authorId: string, signal?: AbortSignal) => Promise<string>;
	autocompleteAuthors: (prefix: string, signal: AbortSignal) => Promise<AuthorMatch[]>;
	listsForTopic: (topic: string, signal: AbortSignal) => Promise<{ lists: number; names: string[] } | null>;
	checkEmbedModel: (signal?: AbortSignal) => Promise<DoctorState>;
	pullEmbedModel: (onProgress: (line: string) => void, signal: AbortSignal) => Promise<void>;
	/** True when an HTTP server answers at the address (any status), false
	 * on a network error (nothing listening, timeout). */
	probe: (baseUrl: string, signal: AbortSignal) => Promise<boolean>;
	/** The system's folder window: the chosen folder, null on cancel;
	 * throws when no window exists here (canPick false). */
	pickFolder: (title: string, start: string) => Promise<string | null>;
	/** The system's "open PDF files" window: the chosen paths ([] = cancelled). */
	pickFiles: (title: string, start: string) => Promise<string[]>;
	/** OpenAlex facts of one work by DOI (citations, venue, access, abstract). */
	workFacts: (doi: string, signal?: AbortSignal) => Promise<WorkFacts | null>;
	/** The authors of one work by DOI (OpenAlex ids and names). */
	workAuthors: (doi: string, signal?: AbortSignal) => Promise<Array<{ id: string; name: string; raw: string }>>;
	/** One OpenAlex author record. */
	authorFacts: (id: string, signal?: AbortSignal) => Promise<AuthorFacts | null>;
	/** Current employments from the public ORCID record. */
	orcidEmployments: (orcid: string, signal?: AbortSignal) => Promise<Employment[]>;
	/** ORCID records that list a DOI among their own works. */
	orcidByDoi: (doi: string, signal?: AbortSignal) => Promise<OrcidPerson[]>;
	canPickFolder: () => boolean;
	/** Keep the download folder for next time and read it as a PDF folder. */
	rememberDownloadDir: (folder: string) => void;
}

export interface WebServerOptions {
	/** Data root (lit-search/ ... live here); default outputRoot(). */
	root?: string;
	/** Working directory for the loose-PDF folder chain; default process.cwd(). */
	cwd?: string;
	/** Folder of the conversation history; default historyDir() (next to the configuration file). */
	historyDir?: string;
	/** File of the saved keyword blocks; default blockCachePath() (next to the configuration file). */
	blockCacheFile?: string;
	/** 0 (default) = any free port. */
	port?: number;
	token?: string;
	provider: ModelProvider;
	deps?: Partial<WebDeps>;
	/** Called after /api/stop closed the server (the pi command clears its handle). */
	onStop?: () => void;
	/** Index the library's PDFs in the background (server start, folder
	 * added, upload, download). Off by default (tests); the CLI and the pi
	 * command turn it on. */
	backgroundIndex?: boolean;
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
/** Sampling temperature of "Propose again": the first proposal for a
 * request runs at 0 (repeatable), a new one must be able to differ. */
const FRESH_TEMPERATURE = 0.8;
const AUTHOR_LIMIT = 12;
const AUTHOR_MATCH_LIMIT = 6;
const CODE_TOPIC_LIMIT = 5;
const LOOKUP_TIMEOUT_MS = 8_000;
const COOKIE = "plr_token";
/** Hides the terminal hand-off (tick column, copy steps) in search reports
 * opened in the browser; the file on disk keeps it for the terminal. */
const BROWSER_REPORT_STYLE = `<style>.selectsteps, td.pickcell > *, th[title^="Select rows"] > * { display: none !important; }
table col:first-child { width: 0 !important; }
td.pickcell, th[title^="Select rows"] { padding: 0 !important; border-left: 0 !important; border-right: 0 !important; }</style>`;
const STATIC_DIR = fileURLToPath(new URL("./static/", import.meta.url));
const PDF_ROUTE = "/pdf";

export function realWebDeps(): WebDeps {
	return {
		runSearch,
		// The browser shows the run as cards from the JSON; the HTML report
		// is written on the user's click (POST /api/runs/report), so only the
		// sidecar and the network page land here. htmlPath names the file a
		// click would write.
		writeSearch: (payload) => {
			const htmlPath = htmlPathFor(outputRoot(), payload.generated, searchLabel(payload).replace(/ \(no query\)$/, ""), (path) => existsSync(path) || existsSync(jsonPathFor(path)));
			const jsonPath = jsonPathFor(htmlPath);
			mkdirSync(dirname(htmlPath), { recursive: true });
			writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
			writeNetworkPage(htmlPath);
			return { htmlPath, jsonPath };
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
		pickFolder,
		pickFiles,
		workFacts: lookupWorkFacts,
		workAuthors: lookupWorkAuthors,
		authorFacts: lookupAuthorFacts,
		orcidEmployments: lookupOrcidEmployments,
		orcidByDoi: lookupOrcidByDoi,
		topWorkDoi: lookupTopWorkDoi,
		canPickFolder,
		rememberDownloadDir,
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

/** The raw request body (an uploaded PDF), up to `limit` bytes. */
function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new HttpError(413, `file larger than ${Math.round(limit / 1_000_000)} MB`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** A library paper in words: "“Title” (Smith et al., 2021)" from its
 * metadata; "this PDF" when it has none (a file name reads badly). Pure. */
/** The short form for History: "Lee and Kim 2021 · Title"; null without
 * metadata (the first question names the chat then). Pure. */
export function paperShortLabel(paper: { title: string; authors: string[]; year: string | null }): string | null {
	if (!paper.title) return null;
	const last = (name: string) => name.trim().split(/\s+/).pop() ?? name;
	const who = paper.authors.length ? `${last(paper.authors[0])}${paper.authors.length > 2 ? " et al." : paper.authors.length === 2 ? ` and ${last(paper.authors[1])}` : ""}` : "";
	return `${[who, paper.year].filter(Boolean).join(" ")}${who || paper.year ? " · " : ""}${paper.title}`;
}

export function paperLabel(paper: { base: string; title: string; authors: string[]; year: string | null }): string {
	if (!paper.title) return "this PDF";
	const last = (name: string) => name.trim().split(/\s+/).pop() ?? name;
	const who = paper.authors.length ? `${last(paper.authors[0])}${paper.authors.length > 2 ? " et al." : paper.authors.length === 2 ? ` and ${last(paper.authors[1])}` : ""}` : "";
	const meta = [who, paper.year].filter(Boolean).join(", ");
	return `“${paper.title}”${meta ? ` (${meta})` : ""}`;
}

/** Cap for the model's example questions (a warm model needs 1-2 s). */
const EXAMPLES_TIMEOUT_MS = 6_000;

/** Largest PDF accepted by drag and drop. */
const UPLOAD_LIMIT = 200_000_000;

/** The library file with exactly these bytes, if any (only files of the
 * same size are read). */
export function samePdf(files: string[], bytes: Buffer): string | undefined {
	for (const file of files) {
		try {
			if (statSync(file).size === bytes.length && readFileSync(file).equals(bytes)) return file;
		} catch {
			// A file that vanished or cannot be read is no match.
		}
	}
	return undefined;
}

/** A dropped file's name made safe for the inbox: letters, digits and a
 * few marks kept, everything else "_", ".pdf" at the end. Pure. */
/** PDFs in a folder and its subfolders, as the library would read it
 * (hidden folders skipped, depth and count capped). */
export function countPdfs(folder: string, depth = 6, cap = 5000): number {
	let count = 0;
	const walk = (dir: string, level: number): void => {
		if (count >= cap || level > depth) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.isDirectory()) walk(join(dir, entry.name), level + 1);
			else if (/\.pdf$/i.test(entry.name) && ++count >= cap) return;
		}
	};
	walk(folder, 0);
	return count;
}

export function uploadName(name: string): string {
	const stem = name.replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N} ._()-]+/gu, "_").replace(/\s+/g, " ").replace(/^[ ._]+|[ ._]+$/g, "").slice(0, 120);
	return `${stem || "dropped"}.pdf`;
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

	/** Conversation id per job the dialog started: the outcome goes to that
	 * conversation, open or parked (see applyTo below). */
	const jobOwner = new Map<string, string>();
	jobs.subscribe((event) => {
		for (const connection of connections) connection.send(event.type, event);
		if (event.type === "job" && event.job.state !== "running") {
			const owner = jobOwner.get(event.job.id);
			jobOwner.delete(event.job.id);
			if (owner !== undefined) applyTo(owner, jobOutcome(event.job));
			broadcastHistory();
			// New PDFs from a download: index them in the background.
			if (event.job.kind === "selection" && event.job.state === "done") kickIndex();
		}
	});

	/** Starting a job answers 409 when the runner refuses it (a single
	 * kind already running, or the cap of parallel jobs reached). */
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

	/* Background indexing: every PDF of the library without an index gets
	 * one, while no chat or report runs; progress goes to the page as SSE
	 * event "index" and into GET /api/library. */
	const indexDir = join(root, "lit-synthesis", "index");
	/** A job that reads or writes indexes (the background pass waits for it). */
	const readsIndexes = (): boolean => jobs.snapshot().running.some((job) => job.kind === "chat" || job.kind === "report" || job.kind === "chat-report" || job.kind === "index" || job.kind === "selection");
	const indexer = new Indexer({
		ready: requireEmbedding,
		pool: async (signal) => chatPool(await deps.ensureLibrary(root, () => {}, signal)),
		isIndexed: (paper) => {
			const summary = indexSummary(join(indexDir, `${paper.base}.json`));
			return Boolean(summary && summary.key === paper.key && summary.model === llmConfig().embedModel);
		},
		indexOne: async (paper, signal) => {
			const wiring = provider.wiring();
			const outcome = await deps.ensureIndexed([paper], indexDir, llmConfig().embedModel, (texts, s) => wiring.backend.embed(texts, s), { onProgress: () => {}, signal });
			return outcome.failures[0]?.reason ?? null;
		},
		busy: () => readsIndexes(),
		fileStamp: (file) => {
			try {
				const info = statSync(file);
				return `${info.size}:${info.mtimeMs}`;
			} catch {
				return "";
			}
		},
		sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
	});
	indexer.subscribe((status) => {
		for (const connection of connections) connection.send("index", status);
	});
	/** Number and total size of the index files (Settings, "Saved data"). */
	const indexUsage = (): { dir: string; count: number; bytes: number } => {
		let count = 0;
		let bytes = 0;
		try {
			for (const name of readdirSync(indexDir)) {
				if (!name.endsWith(".json")) continue;
				count++;
				bytes += statSync(join(indexDir, name)).size;
			}
		} catch {
			// no index folder yet
		}
		return { dir: indexDir, count, bytes };
	};
	/** Start (or queue) a background pass; a no-op without the option. */
	const kickIndex = (): void => {
		if (options.backgroundIndex) indexer.kick();
	};

	/** Copy one PDF into the inbox ("Added Documents"). A PDF the library already
	 * holds (byte for byte, in any folder or the inbox) is not copied
	 * again: the existing paper is used. The name must not clash with a PDF
	 * already in the library (the earlier folder would win and hide it). */
	const importPdf = (bytes: Buffer, wantedName: string): { base: string; file: string; existing?: boolean } => {
		if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(400, "not a PDF file");
		const inbox = inboxDir(root);
		mkdirSync(inbox, { recursive: true });
		const files = libraryFiles(root, { cwd }).files;
		const same = samePdf(files, bytes);
		if (same) return { base: pdfBase(same), file: same, existing: true };
		const taken = new Set(files.map((file) => pdfBase(file).toLowerCase()));
		let name = uploadName(wantedName);
		const stem = name.slice(0, -4);
		for (let n = 2; taken.has(name.slice(0, -4).toLowerCase()) || existsSync(join(inbox, name)); n++) name = `${stem}_${n}.pdf`;
		writeFileSync(join(inbox, name), bytes);
		return { base: name.slice(0, -4), file: join(inbox, name) };
	};
	/** Files chosen in the system's file window (only these may be imported). */
	const exampleCache = new Map<string, string[] | null>();
	const workFactsCache = new Map<string, { at: number; facts: WorkFacts | null }>();
	const authorCache = new Map<string, { at: number; body: Record<string, unknown> }>();
	const pickedFiles = new Set<string>();
	let lastPickDir = "";

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
	const proposeVariants = async (query: string, hint: string, prose = isProseQuery(query), temperature = 0): Promise<{ variants: VariantSuggestion[]; note: string | null }> => {
		const signal = AbortSignal.timeout(60_000);
		const raw = await provider.generate({ system: VARIANT_SYSTEM_PROMPT, user: variantPrompt(query, hint, prose), maxTokens: 500, temperature, signal });
		const suggestions: VariantSuggestion[] = parseVariantSuggestions(raw, query);
		let note: string | null = null;
		if (!suggestions.some((entry) => entry.role === "arxiv")) {
			try {
				const retry = await provider.generate({ system: VARIANT_SYSTEM_PROMPT, user: arxivVariantPrompt(query, hint), maxTokens: 200, temperature, signal });
				const arxiv = parseArxivSuggestion(retry, query, suggestions.map((entry) => entry.text));
				if (arxiv) suggestions.push({ text: arxiv, role: "arxiv" });
				else note = "the model gave no arXiv variant";
			} catch (error) {
				note = `arXiv variant failed: ${errorMessage(error)}`;
			}
		}
		return { variants: suggestions, note };
	};

	/** The browser's default blocks: the request's own words grouped by
	 * the model (temperature 0), every term checked against the request in
	 * code (parseOwnBlocks). One row "plus1", or none when nothing usable
	 * came back. */
	const proposeOwnBlocks = async (query: string, temperature = 0): Promise<{ variants: VariantSuggestion[]; note: string | null }> => {
		const translate = needsTranslation(query);
		const raw = await provider.generate({ system: VARIANT_SYSTEM_PROMPT, user: ownBlocksPrompt(query, translate), maxTokens: 200, temperature, signal: AbortSignal.timeout(60_000) });
		const lines = parseOwnBlocks(raw, query, translate);
		if (!lines) return { variants: [], note: "no usable blocks from the request's own words" };
		return { variants: [{ role: "plus1", text: formatGroupExpression(lines.map((line) => queryBlocks(`(${line})`).flat())) }], note: null };
	};

	/** Keyword blocks for a request: the saved proposal when there is one
	 * (same text, same blocks), else a model call whose usable answer is
	 * saved. `fresh` ("Propose again") skips the saved one and lets the
	 * model vary (temperature FRESH_TEMPERATURE; at 0 it would repeat
	 * itself word for word); the new proposal replaces the saved one. */
	const proposeBlocksFor = async (query: string, mode: BlockMode, fresh: boolean): Promise<{ variants: VariantSuggestion[]; note: string | null; cached: boolean }> => {
		const saved = fresh ? null : cachedBlocks(blockCacheFile, mode, query);
		if (saved) return { variants: saved, note: null, cached: true };
		const temperature = fresh ? FRESH_TEMPERATURE : 0;
		const ask = () => (mode === "own" ? proposeOwnBlocks(query, temperature) : proposeVariants(query, "", true, temperature));
		let { variants, note } = await ask();
		// A varied answer can miss the format; one more try before falling back.
		if (fresh && !variants.some((variant) => variant.role === "plus1")) ({ variants, note } = await ask());
		if (variants.some((variant) => variant.role === "plus1")) {
			try {
				saveBlocks(blockCacheFile, mode, query, variants);
			} catch {
				// Not saved: the next identical request asks the model again.
			}
		}
		return { variants, note, cached: false };
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
	const candidatesOf = (payload: SearchPayload): Candidate[] =>
		candidatesFromRecords(payload.results as CandidateRecord[], payload.dropped as Array<{ record: CandidateRecord }>, listLibrary(root, cwd, deps.matchLibrary(root)).keys);

	/** "Search again with these filters" from the result list: the period and
	 * citation parts, read defensively. */
	const searchAgainFilters = (value: unknown): SearchAgainFilters | undefined => {
		if (!value || typeof value !== "object") return undefined;
		const body = value as Record<string, unknown>;
		const out: SearchAgainFilters = {};
		if (Number.isInteger(body.yearFrom) && (body.yearFrom as number) > 0) out.yearFrom = body.yearFrom as number;
		if (body.allYears === true) out.allYears = true;
		if (Number.isInteger(body.minCites) && (body.minCites as number) >= 0) out.minCites = body.minCites as number;
		return Object.keys(out).length ? out : undefined;
	};

	const startSearchJob = (form: SearchForm): { job: JobInfo; warnings: string[]; query: string } => {
		const intake = intakeFromForm(form);
		const byAuthors = !intake.options.query && intake.options.authorScope === "all" && Boolean(intake.options.filters?.pickedAuthors?.length);
		if (!intake.options.query && !byAuthors) throw new HttpError(400, "no query -- fill at least one concept block or the free text");
		const label = byAuthors ? authorsOnlyLabel((intake.options.filters?.pickedAuthors ?? []).map((name) => ({ name })), intake.options.filters?.authorPosition === "first") : intake.options.query;
		const job = startJob("search", `search: ${label}`, async ({ signal, log }) => {
			for (const warning of intake.warnings) log(`note: ${warning}`);
			const payload = await deps.runSearch({ ...intake.options, onWarn: log, signal });
			const written = deps.writeSearch(payload);
			log(`written ${written.jsonPath}`);
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
		// Target folder: the user's choice (absolute path; created when
		// missing), else the last download folder (runSelection's default).
		const folder = typeof body.folder === "string" && body.folder.trim() ? resolve(body.folder.trim()) : "";
		if (folder) {
			if (!isAbsolute(String(body.folder).trim())) throw new HttpError(400, "give the full path of the download folder");
			try { mkdirSync(folder, { recursive: true }); } catch (error) { throw new HttpError(400, `cannot use ${folder}: ${error instanceof Error ? error.message : error}`); }
		}
		const invalid = identifiers.filter((id) => parseIdentifier(id).kind === "unknown");
		return startJob("selection", `download ${identifiers.length} paper${identifiers.length === 1 ? "" : "s"}`, async ({ signal, log }) => {
			for (const id of invalid) log(`note: "${id}" is not a DOI or arXiv id`);
			const { results, papersDir } = await deps.runSelection({ identifiers, root, mailto, onWarn: log, signal, ...(folder ? { dir: folder } : {}) });
			if (folder) deps.rememberDownloadDir(folder);
			const count = (status: string) => results.filter((result) => result.status === status).length;
			const summary: DownloadOutcome = {
				downloaded: count("downloaded"),
				already: count("already"),
				browser: results.filter((result) => (result.status === "browser" || result.status === "restricted" || result.status === "not_free" || result.status === "dead_link") && result.browserUrl).map((result) => ({ id: result.id, url: result.browserUrl as string })),
				notFree: count("abstract_only") + results.filter((result) => (result.status === "not_free" || result.status === "dead_link") && !result.browserUrl).length,
				failed: count("invalid"),
				libraryCount: listLibrary(root, cwd, deps.matchLibrary(root)).papers.length,
				folder: papersDir,
			};
			return { results, papersDir, report: renderFetchReport(results, papersDir), summary };
		});
	};

	/** Reports from the chat follow the language of the user's questions
	 * (dialog effect); a direct POST without a language gets English,
	 * never the engine's German-preferred summary default (which would mix
	 * German summaries with answers in the question's language). */
	const WEB_REPORT_LANGUAGE = "English";

	/** `answered`: chat answers for reuse -- only from the conversation's own
	 * state (the dialog effect), never from a request body, so every
	 * citation in a report still comes from the engine. */
	const startReportJob = (body: Record<string, unknown>, answered: AnsweredQuestion[] = [], paperLetters: Record<string, string> = {}): JobInfo => {
		const papers: string[] | "library" = body.papers === "library"
			? "library"
			: Array.isArray(body.papers) ? body.papers.filter((name): name is string => typeof name === "string" && name.trim() !== "") : [];
		if (papers !== "library" && !papers.length) throw new HttpError(400, "select at least one document");
		const questions = Array.isArray(body.questions) ? body.questions.filter((q): q is string => typeof q === "string").map((q) => q.trim()).filter(Boolean) : [];
		const summary = body.summary === "bullets" || body.summary === "prose" ? body.summary : "none";
		const detailMode = body.detailMode === "cross-paper" || body.detailMode === "both" ? body.detailMode : "per-paper";
		const includeReview = body.includeReview === true;
		if (summary === "none" && !questions.length && !includeReview) throw new HttpError(400, "nothing to generate -- choose a summary, add a question or include the review");
		const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : WEB_REPORT_LANGUAGE;
		const uiLanguage = body.uiLanguage === "de" ? "de" : "en";
		const session = typeof body.session === "string" && body.session ? body.session : chatSession;
		return startJob("report", "report", async ({ signal, log }) => {
			await requireEmbedding(signal);
			const wiring = provider.wiring();
			const report = await deps.runReport({
				papers, questions, summary, detailMode, includeReview, language, uiLanguage,
				session, root, answered, paperLetters,
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
		const session = typeof body.session === "string" && body.session ? body.session : chatSession;
		return startJob("chat", `question: ${question.slice(0, 60)}`, async ({ signal, log }) => {
			// A short message without a question mark may be small talk: one
			// short model check first. Any doubt, failure or timeout looks the
			// message up in the papers as usual.
			if (body.social !== false && socialCandidate(question) && provider.hasModel()) {
				try {
					const raw = await provider.generate({ system: SOCIAL_SYSTEM, user: question, maxTokens: 120, temperature: 0.3, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
					const reply = parseSocialReply(raw);
					if (reply) return { session, reply };
				} catch (error) {
					if (signal.aborted) throw error;
					log(`small-talk check skipped: ${errorMessage(error)}`);
				}
			}
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
	/** The page reads what the open step accepts from here (one source of
	 * truth: help.ts); on chip-only steps its placeholder invites a question. */
	const dialogView = () => ({ ...dialog, stage: stageOfStep(dialog.step), chatSession, accepts: STEP_ACCEPTS[dialog.step] });
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
	const blockCacheFile = options.blockCacheFile ?? blockCachePath();
	let currentId = newConversationId();
	let dialogStarted = new Date().toISOString();
	/** When the conversation last started a search or a report (its date in the rail). */
	let dialogComputed: string | null = null;
	/** "Search: <request>", "Report: <first question>" or "Chat: <question>";
	 * null while the conversation has none of these. */
	const conversationTitle = (state: DialogState): string | null => {
		const a = state.answers;
		const clip = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 300);
		if (a.topic?.trim()) return `Search: ${clip(a.topic)}`;
		if (isAuthorsOnly(a)) return `Search: ${clip(authorsOnlyLabel(a.pickedAuthors, a.authorPosition === "first"))}`;
		// A chat on one PDF is named after the paper once it has a question.
		if (a.paperLabel && a.lastQuestion?.trim()) return clip(a.paperLabel);
		// A chat collects its questions too (as seed for a later report):
		// "Report" only once a report was asked for.
		const reported = a.reported || state.trail.includes("reportKind") || state.trail.includes("questions") || state.trail.includes("reporting");
		if (reported && a.questions?.length) return `Report: ${clip(a.questions[0])}`;
		if (reported) return `Report: summaries of ${clip(a.scope === "library" ? "the library" : a.scopeLabel || a.paperLabel || `${a.scope.length} papers`)}`;
		if (a.lastQuestion?.trim()) return `Chat: ${clip(a.lastQuestion)}`;
		if (a.questions?.length) return `Report: ${clip(a.questions[0])}`;
		return null;
	};
	/** Save the current conversation when it has a title. A failed write
	 * (read-only folder, full disk) must not break the chat: it is reported
	 * once per server run as a dialog note instead. */
	let saveFailureReported = false;
	/** A chat on one PDF opened before the library knew the paper (a dropped
	 * or hand-saved PDF is identified while its first question is answered)
	 * is named after it as soon as its metadata is there. */
	const labelOnePaper = (state: DialogState): DialogState => {
		const a = state.answers;
		if (a.paperLabel || a.scopeLabel || state.activeJob || !a.lastQuestion?.trim() || !Array.isArray(a.scope) || a.scope.length !== 1) return state;
		const base = a.scope[0];
		const paper = listLibrary(root, cwd, deps.matchLibrary(root)).papers.find((entry) => entry.base === base);
		const label = paper ? paperShortLabel(paper) : null;
		return label ? { ...state, answers: { ...a, paperLabel: label } } : state;
	};
	const persistCurrent = (): void => {
		dialog = labelOnePaper(dialog);
		const title = conversationTitle(dialog);
		if (title === null) return;
		try {
			saveConversation(historyRoot, { version: 1, id: currentId, started: dialogStarted, updated: new Date().toISOString(), ...(dialogComputed ? { computed: dialogComputed } : {}), root, chatSession, title, dialog });
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
			? [{ id: currentId, title, started: dialogStarted, updated: new Date().toISOString(), ...(dialogComputed ? { computed: dialogComputed } : {}), root, steps: dialog.trail.length }]
			: [];
		// The current conversation's files come from its live state (the
		// saved copy may lag behind by one change).
		const files = (entry: { id: string; run?: string; report?: { name: string; url: string }; paper?: string }) => (entry.id === currentId ? conversationFiles(dialog) : { run: entry.run, report: entry.report, paper: entry.paper });
		// Per search: whether its HTML report and PRISMA diagram exist yet
		// (a click writes a missing one); only for this data folder.
		const written = (run: string | undefined, home: string) => {
			if (!run) return undefined;
			const has = (file: string) => existsSync(join(root, "lit-search", file)) || existsSync(join(home, "lit-search", file));
			return { html: has(`${run}.html`), prisma: has(`${run}.prisma.svg`) };
		};
		return {
			history: [...live, ...conversations].map((entry) => {
				const here = entry.root === root;
				const { run, report, paper } = files(entry);
				return { ...entry, run, report, paper, written: written(run, entry.root), current: entry.id === currentId, here, kind: entry.title.startsWith("Search:") ? "search" : "synthesis", running: entry.id === currentId ? busy(dialog) : Boolean(parked.get(entry.id) && busy((parked.get(entry.id) as Parked).dialog)) };
			}),
			skipped,
			dir: historyRoot,
		};
	};
	/** Where files are looked for: the store first, then the data folders
	 * of older conversations (from before the store, when everything lived
	 * in the working folder) -- so they still open with their lists and
	 * reports. Only folders that exist. */
	const dataRoots = (): string[] => {
		const roots = [root];
		for (const entry of listConversations(historyRoot).conversations) {
			if (entry.root && !roots.includes(entry.root) && existsSync(join(entry.root, "lit-search"))) roots.push(entry.root);
		}
		return roots;
	};
	const runPayload = (name: string) => {
		for (const dir of dataRoots()) {
			const payload = readRunPayload(dir, name);
			if (payload) return payload;
		}
		return null;
	};
	const startFresh = (start?: StartStage, scope?: string[], about?: string, label?: string): void => {
		currentId = newConversationId();
		dialogStarted = new Date().toISOString();
		dialogComputed = null;
		applyDialog({ kind: "restart", start, ...(scope && scope.length ? { scope } : {}), ...(about ? { about } : {}), ...(label ? { label } : {}) });
	};
	/** A conversation left while its job or model call runs is parked: kept
	 * in memory (and saved), so the outcome lands in it and is saved; it
	 * leaves the park once idle, or when it is opened again. */
	interface Parked { dialog: DialogState; chatSession: string; started: string; computed: string | null }
	const parked = new Map<string, Parked>();
	const busy = (state: DialogState): boolean => Boolean(state.activeJob || state.pending);
	const parkCurrent = (): void => {
		persistCurrent();
		if (busy(dialog)) parked.set(currentId, { dialog, chatSession, started: dialogStarted, computed: dialogComputed });
	};
	const saveParked = (id: string, entry: Parked): void => {
		const title = conversationTitle(entry.dialog);
		if (title === null) return;
		try {
			saveConversation(historyRoot, { version: 1, id, started: entry.started, updated: new Date().toISOString(), ...(entry.computed ? { computed: entry.computed } : {}), root, chatSession: entry.chatSession, title, dialog: entry.dialog });
		} catch {
			// the open conversation reports save failures; a parked one stays in memory
		}
	};
	/** Stop the job of a conversation that is closed for good (deleted). */
	const stopJobOf = (state: DialogState): void => {
		if (state.activeJob) jobs.cancel(state.activeJob);
	};
	const broadcastHistory = (): void => {
		for (const connection of connections) connection.send("history", {});
	};

	/** Apply an event to the conversation it belongs to: the open one, or a
	 * parked one (reduced, saved, its effects run on its behalf). An event
	 * for a conversation that is neither (deleted meanwhile) is dropped. */
	const applyTo = (owner: string, event: DialogEvent): void => {
		if (owner === currentId) return applyDialog(event);
		const entry = parked.get(owner);
		if (!entry) return;
		const { state: next, effects } = reduce(entry.dialog, event, dialogContext());
		entry.dialog = next;
		saveParked(owner, entry);
		if (!busy(next) && !effects.length) parked.delete(owner);
		broadcastHistory();
		for (const effect of effects) void runEffect(effect, owner);
	};

	/** Apply one event, tell every tab, run the effects it asked for. */
	const applyDialog = (event: DialogEvent): void => {
		const { state: next, effects } = reduce(dialog, event, dialogContext());
		dialog = next;
		// A new chat session is set before the view goes out, so the page
		// sees one session per new conversation (not a second one after it).
		if (effects.some((effect) => effect.kind === "newChatSession")) chatSession = webSessionId();
		const view = dialogView();
		for (const connection of connections) connection.send("dialog", view);
		persistCurrent();
		for (const effect of effects) if (effect.kind !== "newChatSession") void runEffect(effect);
	};

	/** Translate a finished job into the dialog's event. */
	const jobOutcome = (job: JobInfo): DialogEvent => {
		const r = (job.result ?? {}) as Record<string, unknown>;
		switch (job.kind) {
			case "search": return { kind: "job", job, search: r.outcome as SearchOutcome | undefined };
			case "selection": return { kind: "job", job, download: r.summary as DownloadOutcome | undefined };
			case "chat": return { kind: "job", job, answer: r.answer ? { answer: r.answer, hrefs: r.hrefs, pdfUrls: r.pdfUrls } as AnswerView : undefined, ...(typeof r.reply === "string" ? { reply: r.reply } : {}) };
			case "report": return { kind: "job", job, report: typeof r.name === "string" ? { name: r.name, htmlUrl: String(r.htmlUrl), grounded: Boolean(r.grounded), units: Number(r.units ?? 0) } as ReportOutcome : undefined };
			default: return { kind: "job", job };
		}
	};

	/** Run an effect for the conversation that asked for it (`owner`); its
	 * events go back to that conversation even after the user switched. */
	const runEffect = async (effect: Effect, owner: string = currentId): Promise<void> => {
		const sessionOf = (): string => (owner === currentId ? chatSession : parked.get(owner)?.chatSession ?? chatSession);
		const markComputed = (): void => {
			const now = new Date().toISOString();
			if (owner === currentId) dialogComputed = now;
			else { const entry = parked.get(owner); if (entry) entry.computed = now; }
		};
		const started = (job: JobInfo): void => {
			jobOwner.set(job.id, owner);
			applyTo(owner, { kind: "jobStarted", job });
			broadcastHistory();
		};
		try {
			switch (effect.kind) {
				case "proposeBlocks": {
					const { variants, note } = await proposeBlocksFor(effect.query, effect.mode, effect.fresh === true);
					applyTo(owner, { kind: "blocks", variants, ...(note ? { error: note } : {}) });
					return;
				}
				// The helper: one short model call over the step's help text; any
				// failure (no answer, timeout) falls back to the fixed help text.
				case "helpAnswer": {
					try {
						const text = await provider.generate({ system: effect.system, user: effect.user, maxTokens: 300, temperature: 0.2, signal: AbortSignal.timeout(30_000) });
						applyTo(owner, { kind: "helpAnswered", text });
					} catch (error) {
						applyTo(owner, { kind: "helpAnswered", text: null, error: errorMessage(error) });
					}
					return;
				}
				case "loadTopics": {
					const { topics, note } = await codeTopics(effect.query);
					applyTo(owner, { kind: "topics", topics: topics.map((row) => ({ topic: row.topic, lists: row.lists })), ...(note ? { error: note } : {}) });
					return;
				}
				case "loadJournals": {
					const scope: FacetScope = { blocks: facetBlocks(effect.query) };
					if (effect.yearFrom !== undefined) scope.yearFrom = effect.yearFrom;
					if (effect.yearTo !== undefined) scope.yearTo = effect.yearTo;
					const page = await deps.journalFacets(effect.query, FACET_LIMIT, scope);
					const scores = await deps.journalScores(page.listed.map((facet) => facet.id));
					applyTo(owner, { kind: "journals", journals: page.listed.map((facet) => ({ id: facet.id, name: facet.name, works: facet.count, score: scores.get(facet.id) ?? null })) });
					return;
				}
				case "loadAuthors": {
					const scope: FacetScope = { blocks: facetBlocks(effect.query) };
					if (effect.yearFrom !== undefined) scope.yearFrom = effect.yearFrom;
					if (effect.yearTo !== undefined) scope.yearTo = effect.yearTo;
					if (effect.sourceIds.length) scope.sourceIds = effect.sourceIds;
					const page = await deps.authorFacets(effect.query, FACET_LIMIT, scope);
					const metrics = await deps.authorMetrics(page.listed.map((facet) => facet.id));
					applyTo(owner, { kind: "authors", authors: page.listed.map((facet) => ({ id: facet.id, name: facet.name, works: facet.count, ...(metrics.get(facet.id) ?? {}) })) });
					return;
				}
				case "lookupAuthor": {
					const matches = (await deps.autocompleteAuthors(effect.prefix, AbortSignal.timeout(LOOKUP_TIMEOUT_MS))).slice(0, AUTHOR_MATCH_LIMIT);
					applyTo(owner, { kind: "authorLookup", matches });
					return;
				}
				case "startSearch":
					markComputed();
					started(startSearchJob(effect.form).job);
					return;
				case "startSelection":
					started(startSelectionJob({ identifiers: effect.identifiers, confirmed: true, mailto: effect.mailto, saveMailto: effect.saveMailto, withoutUnpaywall: effect.withoutUnpaywall, folder: effect.folder }));
					return;
				case "startChat":
					started(startChatJob({ question: effect.question, papers: effect.papers, session: sessionOf() }));
					return;
				case "startReport":
					markComputed();
					started(startReportJob({
						papers: effect.papers, questions: effect.questions, summary: effect.summary, detailMode: effect.detailMode, includeReview: effect.includeReview,
						language: effect.language === "de" ? "German" : "English", uiLanguage: effect.language, session: sessionOf(),
					}, effect.answered ?? [], effect.letters ?? {}));
					return;
				case "newChatSession":
					if (owner === currentId) chatSession = webSessionId();
					else { const entry = parked.get(owner); if (entry) entry.chatSession = webSessionId(); }
					return;
				default:
					return;
			}
		} catch (error) {
			applyTo(owner, { kind: "effectFailed", effect: effect.kind, error: errorMessage(error) });
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

	/** The three model rows of the Settings: what runs each role, where,
	 * and whether a local server answers (null = remote, not probed). */
	const modelRows = async () => {
		const status = provider.status();
		const cfg = llmConfig();
		const check = async (url: string | null): Promise<boolean | null> => (url && LOCAL_URL.test(url) ? deps.probe(url, AbortSignal.timeout(1500)) : null);
		const generateBase = cfg.generateBaseUrl || cfg.baseUrl;
		const generation = configuredGenerateModel() || (status.kind === "endpoint" ? cfg.generateModel : "");
		const embedBase = cfg.embedBaseUrl || cfg.baseUrl;
		const [llmOk, generationOk, embedOk] = await Promise.all([
			check(status.model ? status.baseUrl : null),
			check(generation ? generateBase : null),
			check(embedBase),
		]);
		return {
			llm: { model: status.model, via: status.via, kind: status.kind, reachable: llmOk },
			generation: { model: generation || null, base: generateBase, reachable: generation ? generationOk : llmOk },
			embedding: { model: cfg.embedModel, base: embedBase, reachable: embedOk },
		};
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
			provider: { ...status, ...reachable, thinking: thinkingSetting(), generateThinking: thinkingFor("generation") },
			job: jobs.snapshot().current,
			chatSession,
			counts: {
				// Written reports only: a run whose report was not asked for is a card list, not a file.
				runs: runs.filter((run) => run.html).length,
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
			// The citation graph is one static page: served from this
			// version's code, so an older copy on disk never shows.
			if (stage === "lit-search" && name === NETWORK_PAGE_NAME) {
				res.writeHead(200, { "content-type": FILE_TYPES.html, "cache-control": "no-store" });
				res.end(renderNetworkHtml());
				return;
			}
			const home = stage && name ? dataRoots().find((dir) => stageFile(dir, stage, name)) : undefined;
			const file = stage && home ? stageFile(home, stage, name) : null;
			if (!file || !stage || !home) throw new HttpError(404, "no such file");
			if (stage === "lit-synthesis" && name.toLowerCase().endsWith(".html")) {
				const sidecar = stageFile(home, stage, name.replace(/\.html?$/i, ".json"));
				const rendered = sidecar ? renderSynthesisPage(sidecar) : null;
				if (rendered !== null) {
					res.writeHead(200, { "content-type": FILE_TYPES.html, "cache-control": "no-store" });
					res.end(rendered);
					return;
				}
			}
			// A search report in the browser: the tick column and the
			// "copy into the Pi chat" steps belong to the terminal flow (the
			// browser downloads from its result list), so they are hidden.
			if (stage === "lit-search" && /\.html?$/i.test(name)) {
				const html = readFileSync(file, "utf8").replace("</head>", `${BROWSER_REPORT_STYLE}</head>`);
				res.writeHead(200, { "content-type": FILE_TYPES.html, "cache-control": "no-store" });
				res.end(html);
				return;
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
		// One paper's facts for the info window: the library record, and from
		// OpenAlex (by DOI, an arXiv id as its DataCite DOI) citations, venue,
		// access and abstract, kept for six hours.
		// The author window: the author record behind a name on a result
		// card, found through the card's work (so a namesake never answers),
		// plus the current employment from ORCID when the record links one.
		if (route === "GET /api/author") {
			let id = (url.searchParams.get("id") ?? "").trim();
			const doi = (url.searchParams.get("doi") ?? "").trim();
			const name = (url.searchParams.get("name") ?? "").trim();
			if (!/^A\d+$/.test(id)) {
				if (!doi || !name) throw new HttpError(400, "an author id, or a DOI and a name, is needed");
				const authors = await deps.workAuthors(doi, AbortSignal.timeout(15_000));
				const match = authors.find((author) => sameAuthorName(author.name, name) || (author.raw && sameAuthorName(author.raw, name)));
				if (!match) throw new HttpError(404, `OpenAlex does not list ${name} for this paper`);
				id = match.id;
			}
			const cached = authorCache.get(id);
			if (cached && Date.now() - cached.at < 6 * 3600_000) return json(res, 200, cached.body);
			const facts = await deps.authorFacts(id, AbortSignal.timeout(15_000));
			if (!facts) throw new HttpError(404, "OpenAlex has no record of this author");
			let employments: Employment[] = [];
			let orcidError: string | null = null;
			// No ORCID iD at OpenAlex: the ORCID record that lists this paper
			// among its own works and carries the same name (exactly one).
			let orcidVia: "openalex" | "paper" | null = facts.orcid ? "openalex" : null;
			if (!facts.orcid) {
				try {
					// From the author list there is no card: the author's most cited work.
					const workDoi = doi || await deps.topWorkDoi(id, AbortSignal.timeout(8_000));
					const people = !workDoi ? [] : (await deps.orcidByDoi(workDoi, AbortSignal.timeout(8_000)))
						.filter((person) => person.names.some((form) => sameAuthorName(form, name) || sameAuthorName(form, facts.name)));
					if (people.length === 1) {
						facts.orcid = people[0].orcid;
						orcidVia = "paper";
					}
				} catch (failure) {
					orcidError = errorMessage(failure);
				}
			}
			if (facts.orcid) {
				try {
					employments = await deps.orcidEmployments(facts.orcid, AbortSignal.timeout(8_000));
				} catch (failure) {
					orcidError = errorMessage(failure);
				}
			}
			const body = { author: facts, employments, orcidVia, orcidError, checked: new Date().toISOString() };
			if (!orcidError) authorCache.set(id, { at: Date.now(), body });
			return json(res, 200, body);
		}
		if (route === "GET /api/paper") {
			const base = url.searchParams.get("base") ?? "";
			const paper = listLibrary(root, cwd, deps.matchLibrary(root)).papers.find((entry) => entry.base === base);
			if (!paper) throw new HttpError(404, "this PDF is not in the library");
			const doi = paper.doi || (paper.arxiv_id ? `10.48550/arxiv.${paper.arxiv_id}` : "");
			let openalex: WorkFacts | null = null;
			let checked: string | null = null;
			let error: string | null = null;
			if (doi) {
				const cached = workFactsCache.get(doi.toLowerCase());
				if (cached && Date.now() - cached.at < 6 * 3600_000) ({ facts: openalex } = cached);
				else {
					try {
						openalex = await deps.workFacts(doi, AbortSignal.timeout(15_000));
						workFactsCache.set(doi.toLowerCase(), { at: Date.now(), facts: openalex });
					} catch (failure) {
						error = errorMessage(failure);
					}
				}
				checked = new Date(workFactsCache.get(doi.toLowerCase())?.at ?? Date.now()).toISOString();
			}
			return json(res, 200, { paper: { ...paper, pdfUrl: pdfHref(paper.file) }, openalex, checked, error, embeddingModel: llmConfig().embedModel });
		}
		// Example questions for the paper chat's box: the model words them
		// from the chosen papers' names, titles and keywords (thinking off),
		// fixed rules check them (examples.ts); null keeps the page's templates.
		if (route === "POST /api/chat/examples") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const wanted = Array.isArray(body.bases) ? body.bases.filter((base): base is string => typeof base === "string").slice(0, 5000) : [];
			const single = body.single === true;
			if (!wanted.length || !provider.hasModel()) return json(res, 200, { examples: null });
			const key = `${single ? 1 : 0}:${[...wanted].sort().join("\n")}`;
			if (exampleCache.has(key)) return json(res, 200, { examples: exampleCache.get(key) });
			const set = new Set(wanted);
			const papers: ExamplePaper[] = listLibrary(root, cwd, deps.matchLibrary(root)).papers.filter((paper) => set.has(paper.base)).map((paper) => ({
				name: examplePaperName(paper.authors, paper.year, paper.base),
				title: paper.title,
				keywords: paper.keywords,
			}));
			if (!papers.length) return json(res, 200, { examples: null });
			// A warm local model answers in 1-2 s; a cold or busy one runs into
			// the short cap and the templates stay. Only a real answer (lines
			// that passed or failed the check) is cached, so a timeout is
			// tried again for the next selection or visit.
			let examples: string[] | null = null;
			try {
				const raw = await provider.generate({ system: EXAMPLES_SYSTEM, user: examplesPrompt(papers, single), maxTokens: 160, temperature: 0.5, noThinking: true, signal: AbortSignal.timeout(EXAMPLES_TIMEOUT_MS) });
				examples = parseExamples(raw, papers, single);
				if (exampleCache.size > 200) exampleCache.clear();
				exampleCache.set(key, examples);
			} catch {
				examples = null;
			}
			return json(res, 200, { examples });
		}
		if (route === "GET /api/library") {
			const library = listLibrary(root, cwd, deps.matchLibrary(root));
			return json(res, 200, {
				papers: library.papers.map((paper) => ({ ...paper, pdfUrl: pdfHref(paper.file) })),
				dirs: library.dirs,
				folders: pdfFolders(),
				store: root,
				embeddingModel: llmConfig().embedModel,
				indexing: indexer.snapshot(),
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
		// The keyword blocks of a request before the search (the "+" menu
		// shows the synonym blocks and counts its journal and author lists
		// over the own-words blocks): a typed block
		// expression as typed, else the model's own-words blocks (saved, so
		// the search that follows uses the same ones), else word by word.
		if (route === "POST /api/search/blocks") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const request = typeof body.request === "string" ? body.request.trim() : "";
			if (!request) throw new HttpError(400, "request is empty");
			// `mode` "synonyms": the model's blocks with one synonym each (the
			// menu shows them for editing); `fresh` asks the model again.
			const mode: BlockMode = body.mode === "synonyms" ? "synonyms" : "own";
			let lines = mode === "own" && isHandBuilt(request) && isBlockExpression(request) ? blocksForEditing(request) : null;
			let note: string | null = null;
			if (!lines && provider.hasModel()) {
				const proposal = await proposeBlocksFor(request, mode, body.fresh === true);
				const plus1 = proposal.variants.find((variant) => variant.role === "plus1");
				lines = plus1 ? blocksForEditing(plus1.text) : null;
				note = proposal.note;
			}
			if (!lines) lines = deriveGroupsFromQuery(request).map((group) => group.join(" OR "));
			const query = formatGroupExpression(lines.map((line) => parseGroupSpec(line).flat()));
			return json(res, 200, { blocks: lines, query, note });
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

		/* ---- result cards and reports from the list ---- */
		if (route === "GET /api/runs/cards") {
			const name = url.searchParams.get("name") ?? "";
			const payload = runPayload(name);
			if (!payload) throw new HttpError(404, "no such search run");
			const library = listLibrary(root, cwd, deps.matchLibrary(root));
			return json(res, 200, {
				name,
				query: payload.query,
				generated: payload.generated,
				flow: payload.flow ?? null,
				access_counts: payload.access_counts ?? null,
				sources_used: payload.sources_used ?? [],
				code_sources_used: payload.code_sources_used ?? null,
				per_source: payload.per_source ?? null,
				yearFrom: typeof payload.filters?.yearFrom === "number" ? payload.filters.yearFrom : null,
				thisYear: new Date().getFullYear(),
				rows: cardRows(payload as never, library.keys),
			});
		}
		// Provenance behind a flow diagram (the PRISMA viewer's Details):
		// request, date, raw hits per source, filters. A filtered diagram
		// reads its own sidecar when one exists, else the run's.
		if (route === "GET /api/runs/facts") {
			const name = url.searchParams.get("name") ?? "";
			const payload = runPayload(name) ?? runPayload(name.replace(/_filtered(_\d+)?$/, ""));
			if (!payload) throw new HttpError(404, "no such search run");
			const run = payload as unknown as SearchPayload & { list_filters?: string[] | null };
			return json(res, 200, {
				query: searchLabel(run),
				generated: run.generated,
				perSource: run.per_source,
				sources: (run.source_counts ?? []).map((entry) => ({ source: entry.source, query: entry.query, count: entry.count })),
				skipped: (run.sources_skipped ?? []).map((entry) => entry.source),
				failures: (run.source_failures ?? []).map((failure) => failure.source),
				filters: describeFilters(run.filters),
				listFilters: run.list_filters ?? null,
			});
		}
		// A report from the (filtered) list: the run's payload with the list
		// filters applied as a screening step, rendered by the unchanged
		// renderer; written next to the run, shown as a card in the chat.
		if (route === "POST /api/runs/report") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const name = typeof body.name === "string" ? body.name : "";
			const kind = body.kind === "prisma" ? "prisma" : "html";
			const payload = runPayload(name);
			if (!payload) throw new HttpError(404, "no such search run");
			const filters = parseCardFilters(body.filters);
			const thisYear = new Date().getFullYear();
			const active = hasCardFilters(filters);
			const filtered = applyCardFilters(payload as never, filters, thisYear) as unknown as SearchPayload & { list_filters: string[] | null };
			const dir = join(root, "lit-search");
			// A filtered report gets its own name next to the run; a second one
			// with other filters counts up. The HTML pair and the SVG count
			// separately, so the diagram of a list shares its report's name.
			let base = name;
			if (active) {
				const taken = (candidate: string) => kind === "prisma" ? existsSync(join(dir, `${candidate}.prisma.svg`)) : existsSync(join(dir, `${candidate}.html`)) || existsSync(join(dir, `${candidate}.json`));
				base = `${name}_filtered`;
				for (let suffix = 2; taken(base); suffix++) base = `${name}_filtered_${suffix}`;
			}
			const filterLabel = active ? ` · list filters: ${describeCardFilters(filters, thisYear).join("; ")}` : "";
			let card: FileCard;
			if (kind === "prisma") {
				const svg = prismaSvgFor(filtered);
				if (!svg) throw new HttpError(400, "this run has no screening-flow counts");
				const file = `${base}.prisma.svg`;
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, file), svg, "utf8");
				card = { kind: "file", name: file, label: `PRISMA-style flow diagram, SVG · lit-search/${filterLabel}`, stage: "lit-search", url: `/files/lit-search/${encodeURIComponent(file)}` };
			} else {
				const htmlPath = join(dir, `${base}.html`);
				const html = renderHtml(filtered, { network: true });
				if (active) writeRunOutputs(html, filtered, htmlPath, "lit-search");
				else { mkdirSync(dir, { recursive: true }); writeFileSync(htmlPath, html, "utf8"); }
				writeNetworkPage(htmlPath);
				card = { kind: "file", name: `${base}.html`, label: `Search report, HTML · lit-search/${filterLabel}`, stage: "lit-search", url: `/files/lit-search/${encodeURIComponent(base)}.html` };
			}
			// From the rail (History) the report belongs to that conversation's
			// run, not to the open one: no card in the open conversation.
			if (body.rail !== true) applyDialog({ kind: "fileWritten", card, quiet: true });
			return json(res, 200, { card });
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
			if (dialog.activeJob) throw new HttpError(409, "this conversation's job is still running -- wait for it or stop it");
			const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
			const options = parseSearchOptions(body.options);
			const chat = parseChatOptions(body.chat);
			applyDialog({
				kind: "answer",
				text: typeof body.text === "string" ? body.text : undefined,
				chip: typeof body.chip === "string" ? body.chip : undefined,
				ids: strings(body.ids),
				blocks: strings(body.blocks),
				toggles: strings(body.toggles),
				ask: body.ask === true,
				...(typeof body.code === "boolean" ? { code: body.code } : {}),
				...(typeof body.synonyms === "boolean" ? { synonyms: body.synonyms } : {}),
				...(typeof body.period === "string" && ["5y", "10y", "20y", "all"].includes(body.period) ? { period: body.period as PeriodPreset } : {}),
				...(options ? { options } : {}),
				...(chat ? { chat } : {}),
				...(typeof body.folder === "string" && body.folder.trim() ? { folder: body.folder.trim() } : {}),
				filters: searchAgainFilters(body.filters),
			});
			return json(res, 200, dialogView());
		}
		if (route === "POST /api/dialog/restart") {
			stopJobOf(dialog);
			applyDialog({ kind: "restart" });
			return json(res, 200, dialogView());
		}
		// "+ New search" / "+ New paper chat": the current conversation stays
		// saved, an empty one starts, optionally straight at that stage.
		if (route === "POST /api/dialog/new") {
			const body = (await readBody(req)) as Record<string, unknown>;
			// A running job or model call keeps going in the parked conversation.
			parkCurrent();
			const scope = Array.isArray(body.scope) ? body.scope.filter((base): base is string => typeof base === "string" && base.length > 0 && base.length < 300).slice(0, 50) : undefined;
			// One PDF: the question names it from its metadata (title, first
			// author, year), never from a model.
			let about: string | undefined;
			let label: string | undefined;
			if (body.start === "synthesis" && scope && scope.length === 1) {
				const paper = listLibrary(root, cwd, deps.matchLibrary(root)).papers.find((entry) => entry.base === scope[0]);
				if (paper) {
					about = paperLabel(paper);
					label = paperShortLabel(paper) ?? undefined;
				}
			}
			startFresh(body.start === "search" || body.start === "synthesis" ? body.start : undefined, body.start === "synthesis" ? scope : undefined, about, label);
			return json(res, 200, dialogView());
		}
		if (route === "GET /api/history") return json(res, 200, historyView());
		// Continue a saved conversation; the current one stays saved.
		if (route === "POST /api/history/open") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const id = typeof body.id === "string" ? body.id : "";
			if (id === currentId) return json(res, 200, { ...dialogView(), otherRoot: null });
			// A parked conversation comes back from memory (its newest state,
			// job still running); any other one from its file.
			const live = parked.get(id);
			const entry = live ? null : loadConversation(historyRoot, id);
			if (!live && !entry) throw new HttpError(404, "no such conversation");
			parkCurrent();
			if (live) {
				parked.delete(id);
				dialog = live.dialog;
				chatSession = live.chatSession;
				dialogStarted = live.started;
				dialogComputed = live.computed;
			} else if (entry) {
				dialog = entry.dialog;
				chatSession = entry.chatSession;
				dialogStarted = entry.started;
				dialogComputed = entry.computed ?? null;
			}
			currentId = id;
			// An older one-PDF chat whose paper is known by now gets its name.
			if (labelOnePaper(dialog) !== dialog) persistCurrent();
			broadcastDialog();
			broadcastHistory();
			return json(res, 200, { ...dialogView(), otherRoot: entry && entry.root !== root ? entry.root : null });
		}
		// Delete one conversation file; deleting the current one starts an empty conversation.
		if (route === "POST /api/history/delete") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const id = typeof body.id === "string" ? body.id : "";
			if (id === currentId) stopJobOf(dialog);
			const gone = parked.get(id);
			if (gone) { stopJobOf(gone.dialog); parked.delete(id); }
			const deleted = deleteConversation(historyRoot, id);
			if (id === currentId) startFresh();
			return json(res, 200, { deleted, dialog: dialogView() });
		}
		if (route === "POST /api/blocks/clear") {
			return json(res, 200, { deleted: clearBlockCache(blockCacheFile) });
		}
		if (route === "POST /api/history/clear") {
			// Every conversation goes, so every job of a conversation stops.
			stopJobOf(dialog);
			for (const entry of parked.values()) stopJobOf(entry.dialog);
			parked.clear();
			const deleted = clearConversations(historyRoot);
			startFresh();
			return json(res, 200, { deleted, dialog: dialogView() });
		}
		// Show a data folder in the file manager: one of the three stage
		// folders (the folder button of a file card) or the data root itself
		// (the folder icon in the rail). Nothing else.
		// Delete every index file; the PDFs stay and the background pass
		// builds the indexes again. Refused while a chat, report or index
		// job reads them.
		if (route === "POST /api/indexes/clear") {
			if (readsIndexes()) throw new HttpError(409, "a chat, report or indexing job is running -- try again when it has finished");
			indexer.stop();
			await indexer.idle();
			let deleted = 0;
			for (const name of existsSync(indexDir) ? readdirSync(indexDir) : []) {
				if (!name.endsWith(".json")) continue;
				rmSync(join(indexDir, name), { force: true });
				deleted++;
			}
			kickIndex();
			return json(res, 200, { deleted });
		}
		if (route === "POST /api/reveal") {
			const body = (await readBody(req)) as Record<string, unknown>;
			// A known folder by path: one of the PDF folders (or a folder in
			// one of them, from the library tree) or the last download folder.
			if (typeof body.path === "string" && body.path.trim()) {
				const wantedPath = resolve(body.path.trim());
				const known = [...pdfFolders(), lastDownloadDir(), root, dirname(configPath()), historyRoot, dirname(blockCacheFile)].filter(Boolean);
				if (!isAbsolute(body.path.trim()) || !known.some((folder) => wantedPath === folder || wantedPath.startsWith(`${folder}/`) || wantedPath.startsWith(`${folder}\\`))) throw new HttpError(400, "not one of your folders");
				if (!existsSync(wantedPath)) throw new HttpError(404, `${wantedPath} does not exist`);
				revealFolder(wantedPath);
				return json(res, 200, { opened: wantedPath });
			}
			const wanted = typeof body.stage === "string" ? body.stage.replace(/\/$/, "") : "";
			const stage = wanted === "root" ? "" : stageOf(wanted);
			if (stage === null) throw new HttpError(400, "unknown folder");
			const folder = stage ? join(root, stage) : root;
			if (!existsSync(folder)) throw new HttpError(404, `${stage}/ does not exist yet`);
			revealFolder(folder);
			return json(res, 200, { opened: folder });
		}

		/* ---- drag and drop: a PDF from the user's desktop into the inbox ---- */
		if (route === "POST /api/library/upload") {
			const bytes = await readRawBody(req, UPLOAD_LIMIT);
			const added = importPdf(bytes, url.searchParams.get("name") ?? "");
			kickIndex();
			return json(res, 200, added);
		}
		/* ---- the upload button: the system's file window, then the folder question ---- */
		if (route === "POST /api/library/pick-files") {
			const start = lastPickDir || pdfFolders()[0] || lastDownloadDir() || "";
			let chosen: string[];
			try {
				chosen = await deps.pickFiles("Add PDFs to the library", start);
			} catch (error) {
				throw new HttpError(501, error instanceof Error ? error.message : String(error));
			}
			const files = chosen.map((path) => resolve(path)).filter((path) => /\.pdf$/i.test(path) && existsSync(path));
			if (!files.length) return json(res, 200, { files: [] });
			for (const file of files) pickedFiles.add(file);
			const folder = dirname(files[0]);
			lastPickDir = folder;
			const inLibrary = new Set(libraryFiles(root, { cwd }).files.map((file) => resolve(file)));
			return json(res, 200, {
				files: files.map((file) => ({ path: file, base: pdfBase(file), inLibrary: inLibrary.has(file) })),
				// The folder question only when all files share one folder that
				// the library does not read yet.
				folder: files.every((file) => dirname(file) === folder) && !files.every((file) => inLibrary.has(file)) ? folder : null,
				folderPdfs: countPdfs(folder),
			});
		}
		if (route === "POST /api/library/import") {
			// Only files the user just chose in the file window are copied.
			const body = (await readBody(req)) as Record<string, unknown>;
			const wanted = Array.isArray(body.files) ? body.files.filter((path): path is string => typeof path === "string").map((path) => resolve(path)) : [];
			const added: Array<{ base: string; file: string; existing?: boolean }> = [];
			for (const file of wanted) {
				if (!pickedFiles.has(file)) throw new HttpError(400, `${file} was not chosen in the file window`);
				added.push(importPdf(readFileSync(file), basename(file)));
			}
			kickIndex();
			return json(res, 200, { added });
		}

		/* ---- folders: the user's PDF folders and the folder window ---- */
		if (route === "GET /api/folders") {
			return json(res, 200, { pdfFolders: pdfFolders(), lastDownloadDir: lastDownloadDir(), store: root, canPick: deps.canPickFolder() });
		}
		if (route === "POST /api/folders/pick") {
			// The window opens on this machine and waits for the user.
			const body = (await readBody(req)) as Record<string, unknown>;
			const title = body.purpose === "download" ? "Where should the PDFs go?" : "Choose a folder with PDFs";
			const start = typeof body.start === "string" && body.start.trim() ? body.start.trim() : lastDownloadDir() || pdfFolders()[0] || "";
			try {
				return json(res, 200, { path: await deps.pickFolder(title, start) });
			} catch (error) {
				throw new HttpError(501, error instanceof Error ? error.message : String(error));
			}
		}
		if (route === "POST /api/folders/add" || route === "POST /api/folders/remove") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const path = typeof body.path === "string" ? body.path.trim() : "";
			if (!path || !isAbsolute(path)) throw new HttpError(400, "give the full path of a folder");
			if (route === "POST /api/folders/add") {
				let isDir = false;
				try { isDir = statSync(path).isDirectory(); } catch { /* missing */ }
				if (!isDir) throw new HttpError(400, `${path} is not a folder`);
				const folders = addPdfFolder(path);
				kickIndex();
				return json(res, 200, { pdfFolders: folders });
			}
			return json(res, 200, { pdfFolders: removePdfFolder(path) });
		}

		/* ---- settings ---- */
		if (route === "GET /api/settings") {
			return json(res, 200, { ...storedConfigView(), path: configPath(), resolved: llmConfig(), models: await modelRows(), mailtoResolved: contactMailto(), embedState, historyDir: historyRoot, blockCacheDir: dirname(blockCacheFile), configDir: dirname(configPath()), indexes: indexUsage(), conversations: listConversations(historyRoot).conversations.length, savedBlocks: blockCacheSize(blockCacheFile) });
		}
		// The models a server offers, for the Settings' model lists: the
		// address and dialect as the page shows them (unsaved edits too);
		// inside pi also pi's own models for the browser's LLM choice.
		if (route === "GET /api/models") {
			const base = (url.searchParams.get("base") ?? "").trim();
			const api = url.searchParams.get("api") === "openai" ? "openai" : "ollama";
			const valid = /^https?:\/\/[^\s]+$/i.test(base);
			// The other dialect as a second try (a dialect left at its default).
			let models = valid ? await listServerModels(base, api) : [];
			if (valid && !models.length) models = await listServerModels(base, api === "openai" ? "ollama" : "openai");
			return json(res, 200, { models, ...(url.searchParams.get("pi") === "1" && provider.choices ? { pi: provider.choices() } : {}) });
		}
		if (route === "POST /api/settings") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const patch: Parameters<typeof updateStoredConfig>[0] = {};
			if (typeof body.mailto === "string") {
				const mailto = body.mailto.trim();
				if (mailto && !isPlausibleMailto(mailto)) throw new HttpError(400, `"${mailto}" does not look like an email address`);
				patch.mailto = mailto || undefined;
			}
			if (typeof body.thinking === "string") {
				if (!(THINKING_SETTINGS as readonly string[]).includes(body.thinking)) throw new HttpError(400, `thinking must be one of ${THINKING_SETTINGS.join(", ")}`);
				patch.thinking = body.thinking === "off" ? undefined : body.thinking as ThinkingSetting;
			}
			if (typeof body.browserModel === "string") {
				const id = body.browserModel.trim();
				if (id && !(provider.choices?.() ?? []).some((choice) => choice.id === id)) throw new HttpError(400, `"${id}" is not a model pi offers`);
				patch.browserModel = id || undefined;
			}
			if (typeof body.generateThinking === "string") {
				if (!(THINKING_SETTINGS as readonly string[]).includes(body.generateThinking)) throw new HttpError(400, `generateThinking must be one of ${THINKING_SETTINGS.join(", ")}`);
				patch.generateThinking = body.generateThinking as ThinkingSetting;
			}
			if (Array.isArray(body.codeListTopics)) {
				const topics = body.codeListTopics.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
				patch.codeListTopics = topics.length ? topics : undefined;
			}
			if (body.llm && typeof body.llm === "object") {
				const given = body.llm as Record<string, unknown>;
				const current = storedConfigView().llm;
				const llm: Record<string, unknown> = { ...current };
				for (const key of ["baseUrl", "api", "generateModel", "embedModel", "embedBaseUrl", "embedApi", "generateBaseUrl", "generateApi", "chatModel", "chatBaseUrl", "chatApi"]) {
					if (!(key in given)) continue;
					const value = typeof given[key] === "string" ? (given[key] as string).trim() : "";
					if (value) llm[key] = value;
					else delete llm[key];
				}
				// The api key has its own route (POST /api/settings/key); an
				// existing value survives every save of the other fields.
				const stored = (storedConfigView().keys.llmApiKey ? { apiKey: llmConfig().apiKey } : {});
				patch.llm = { ...llm, ...stored } as typeof patch.llm;
			}
			const written = updateStoredConfig(patch);
			embedState = null;
			return json(res, 200, { written, ...storedConfigView(), resolved: llmConfig(), mailtoResolved: contactMailto() });
		}
		// One key at a time: the page sends a value (empty = remove) and only
		// ever reads back set / not set, never the key itself.
		if (route === "POST /api/settings/key") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const value = typeof body.value === "string" ? body.value.trim() : "";
			if (/\s/.test(value)) throw new HttpError(400, "a key has no spaces");
			if (body.name === "s2ApiKey" || body.name === "githubToken") {
				updateStoredConfig({ [body.name]: value || undefined });
			} else if (body.name === "llmApiKey") {
				const llm: Record<string, unknown> = { ...storedConfigView().llm };
				if (value) llm.apiKey = value;
				updateStoredConfig({ llm: llm as Parameters<typeof updateStoredConfig>[0]["llm"] });
			} else {
				throw new HttpError(400, "unknown key");
			}
			return json(res, 200, { keys: storedConfigView().keys });
		}
		if (route === "POST /api/settings/pull-embed") {
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
	// The first background pass a moment after the start (the page loads first).
	if (options.backgroundIndex) setTimeout(kickIndex, 3_000).unref();

	let closed: Promise<void> | null = null;
	const close = (): Promise<void> => {
		if (closed) return closed;
		closed = new Promise<void>((resolve) => {
			indexer.stop();
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
