/**
 * What the web interface lists and serves from the three output folders:
 * search runs (lit-search/), the PDF library with its index state
 * (lit-selection/, lit-synthesis/index/), synthesis and chat reports
 * (lit-synthesis/) and chat sessions (lit-synthesis/protocols/). Reading
 * only; every path handed out is code-constructed from a directory scan,
 * never from a request string. Request names are checked by safeName()
 * before they touch the filesystem.
 */

import { paperKeywords } from "./keywords.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { chatPool } from "../synthesis.ts";
import { libraryFiles, type LibraryMatch, matchLibrary } from "../corpus.ts";
import { readTwin } from "../library.ts";
import { NETWORK_PAGE_NAME } from "../network.ts";
import type { Round } from "../protocol.ts";

export const STAGES = ["lit-search", "lit-selection", "lit-synthesis"] as const;
export type Stage = (typeof STAGES)[number];

/** Files the /files route serves, by extension. */
export const FILE_TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	json: "application/json; charset=utf-8",
	pdf: "application/pdf",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	svg: "image/svg+xml",
};

/** A single path segment without traversal or separators; the extension
 * must be one the route serves. Null otherwise. Pure. */
export function safeName(name: string): string | null {
	if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
	if (name === "." || name === ".." || name.startsWith("..")) return null;
	const extension = name.toLowerCase().split(".").pop() ?? "";
	// A bare extension (".html") is no file name.
	if (!(extension in FILE_TYPES) || name.length <= extension.length + 1) return null;
	return name;
}

export function stageOf(value: string): Stage | null {
	return (STAGES as readonly string[]).includes(value) ? (value as Stage) : null;
}

/** The on-disk path of <root>/<stage>/<name>, or null when the name is
 * unsafe or the file does not exist. */
export function stageFile(root: string, stage: Stage, name: string): string | null {
	const safe = safeName(name);
	if (!safe) return null;
	const path = join(root, stage, safe);
	try {
		return statSync(path).isFile() ? path : null;
	} catch {
		return null;
	}
}

/** The PDF of that file name anywhere in the library (every source,
 * library.ts; the first one wins like in the corpus). The name only
 * selects among scanned files, it never becomes a path itself. */
export function pdfFile(root: string, cwd: string, name: string): string | null {
	const safe = safeName(name);
	if (!safe || !safe.toLowerCase().endsWith(".pdf")) return null;
	const wanted = safe.toLowerCase();
	return libraryFiles(root, { cwd }).files.find((file) => file.split(/[\\/]/).pop()!.toLowerCase() === wanted) ?? null;
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** The few facts of a paper index the library list needs, cached by
 * file size and modification time: an index file holds every chunk and
 * its vector, too large to parse on every list request. */
export interface IndexSummary {
	chunks: number;
	model: string;
	key: string;
	/** Author keywords from the first two pages (example questions only). */
	keywords: string[];
}
const summaries = new Map<string, { stamp: string; summary: IndexSummary | null }>();

export function indexSummary(file: string): IndexSummary | null {
	let stamp: string;
	try {
		const info = statSync(file);
		stamp = `${info.size}:${info.mtimeMs}`;
	} catch {
		summaries.delete(file);
		return null;
	}
	const cached = summaries.get(file);
	if (cached && cached.stamp === stamp) return cached.summary;
	const index = readJson(file) as Record<string, any> | null;
	const summary = index && Array.isArray(index.chunks)
		? {
			chunks: index.chunks.length,
			model: typeof index.embedding_model === "string" ? index.embedding_model : "",
			key: index.paper && typeof index.paper.key === "string" ? index.paper.key : "",
			keywords: paperKeywords(index.chunks.filter((chunk: any) => chunk && Number(chunk.page) <= 2).map((chunk: any) => String(chunk.text ?? "")).join(" ")),
		}
		: null;
	summaries.set(file, { stamp, summary });
	return summary;
}

function listDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

export interface SearchRunEntry {
	/** Basename without extension (the HTML and JSON share it). */
	name: string;
	query: string;
	generated: string;
	included: number;
	dropped: number;
	onTarget: number;
	html: boolean;
	network: boolean;
}

/** Search runs, newest first. */
export function listSearchRuns(root: string): SearchRunEntry[] {
	const dir = join(root, "lit-search");
	const hasNetwork = existsSync(join(dir, NETWORK_PAGE_NAME));
	const entries: SearchRunEntry[] = [];
	for (const file of listDir(dir)) {
		if (!file.toLowerCase().endsWith(".json")) continue;
		const payload = readJson(join(dir, file)) as Record<string, any> | null;
		if (!payload || typeof payload.query !== "string" || !Array.isArray(payload.results)) continue;
		const results = payload.results as Array<Record<string, unknown>>;
		entries.push({
			name: file.replace(/\.json$/i, ""),
			query: payload.query,
			generated: typeof payload.generated === "string" ? payload.generated : "",
			included: results.length,
			dropped: Array.isArray(payload.dropped) ? payload.dropped.length : 0,
			onTarget: results.filter((record) => record.group === "on_target").length,
			html: existsSync(join(dir, `${file.replace(/\.json$/i, "")}.html`)),
			network: hasNetwork,
		});
	}
	return entries.sort((a, b) => b.generated.localeCompare(a.generated) || b.name.localeCompare(a.name));
}

export interface CandidateEntry {
	id: string;
	title: string;
	year: string | null;
	access: string | null;
	group: string | null;
	dropped: boolean;
	inLibrary: boolean;
}

/** The JSON sidecar of one saved search run, or null. */
export function readRunPayload(root: string, name: string): Record<string, any> | null {
	const path = stageFile(root, "lit-search", `${name}.json`);
	if (!path) return null;
	const payload = readJson(path) as Record<string, any> | null;
	return payload && Array.isArray(payload.results) ? payload : null;
}

/** The records of one saved search (results, then dropped table) as
 * tickable download candidates; identifiers exactly as the report's copy
 * sentence carries them. */
export function searchCandidates(root: string, name: string, libraryKeys: Set<string>): CandidateEntry[] | null {
	const path = stageFile(root, "lit-search", `${name}.json`);
	if (!path) return null;
	const payload = readJson(path) as Record<string, any> | null;
	if (!payload) return null;
	const rows: Array<{ record: Record<string, any>; dropped: boolean }> = [
		...((payload.results ?? []) as Array<Record<string, any>>).map((record) => ({ record, dropped: false })),
		...((payload.dropped ?? []) as Array<{ record?: Record<string, any> }>)
			.map((entry) => entry?.record)
			.filter((record): record is Record<string, any> => Boolean(record))
			.map((record) => ({ record, dropped: true })),
	];
	const out: CandidateEntry[] = [];
	for (const { record, dropped } of rows) {
		const doi = typeof record.doi === "string" ? record.doi : "";
		const arxiv = typeof record.arxiv_id === "string" ? record.arxiv_id : "";
		const id = doi || (arxiv ? `arXiv:${arxiv}` : "");
		if (!id) continue;
		const key = doi ? `doi:${doi.toLowerCase()}` : `arxiv:${arxiv.replace(/v\d+$/i, "").toLowerCase()}`;
		out.push({
			id,
			title: typeof record.title === "string" ? record.title : "",
			year: typeof record.year === "string" ? record.year : null,
			access: typeof record.access?.level === "string" ? record.access.level : null,
			group: typeof record.group === "string" ? record.group : null,
			dropped,
			inLibrary: libraryKeys.has(key),
		});
	}
	return out;
}

export interface LibraryEntry {
	base: string;
	file: string;
	dir: string;
	title: string;
	authors: string[];
	year: string | null;
	doi: string;
	arxiv_id: string;
	verified: boolean;
	via: string | null;
	/** Chunk count and embedding model of the cached index, or null. */
	index: { chunks: number; model: string } | null;
	/** Author keywords of the indexed PDF (empty when none or not indexed). */
	keywords: string[];
}

/** The PDF pool as the synthesis stage sees it (verified papers plus
 * filename-only entries), with the index state per paper. Offline: no
 * adoption here (that runs inside the index/report jobs). */
export function listLibrary(root: string, cwd: string, match?: LibraryMatch): { papers: LibraryEntry[]; dirs: string[]; keys: Set<string> } {
	const found = match ?? matchLibrary(root, () => {}, { cwd });
	const indexDir = join(root, "lit-synthesis", "index");
	const papers = chatPool(found).map((paper) => {
		const dir = paper.file.slice(0, paper.file.length - `${paper.base}.pdf`.length).replace(/[\\/]$/, "");
		const twin = readTwin(root, paper.file);
		const index = indexSummary(join(indexDir, `${paper.base}.json`));
		return {
			base: paper.base,
			file: paper.file,
			dir,
			title: paper.entry.title,
			authors: paper.entry.authors ?? [],
			year: paper.entry.year ?? null,
			doi: paper.entry.doi,
			arxiv_id: paper.entry.arxiv_id,
			verified: !paper.key.startsWith("file:"),
			via: typeof twin?.via === "string" ? twin.via : null,
			index: index && index.key === paper.key ? { chunks: index.chunks, model: index.model } : null,
			keywords: index && index.key === paper.key ? index.keywords : [],
		};
	});
	papers.sort((a, b) => (a.year ?? "").localeCompare(b.year ?? "") || a.base.localeCompare(b.base));
	const dirs = found.dirs ?? [found.papersDir];
	return { papers, dirs, keys: new Set(found.matched.map((paper) => paper.key)) };
}

export interface ReportEntry {
	name: string;
	kind: "synthesis" | "chat";
	generated: string;
	title: string;
	papers: number;
	content: string;
	html: boolean;
}

/** Synthesis reports and chat reports under lit-synthesis/, newest first. */
export function listReports(root: string): ReportEntry[] {
	const dir = join(root, "lit-synthesis");
	const entries: ReportEntry[] = [];
	for (const file of listDir(dir)) {
		if (!file.toLowerCase().endsWith(".json")) continue;
		const payload = readJson(join(dir, file)) as Record<string, any> | null;
		if (!payload || typeof payload.generated !== "string") continue;
		const name = file.replace(/\.json$/i, "");
		if (Array.isArray(payload.units) && Array.isArray(payload.papers)) {
			const parts: string[] = [];
			if (payload.summary) parts.push(`summary (${payload.summary})`);
			const questions = Array.isArray(payload.questions) ? payload.questions.length : 0;
			if (questions) parts.push(`${questions} question${questions === 1 ? "" : "s"}${payload.detail_mode === "cross-paper" ? " (mode B)" : payload.detail_mode === "both" ? " (modes A + B)" : " (mode A)"}`);
			if (payload.include_review) parts.push("review");
			entries.push({
				name, kind: "synthesis", generated: payload.generated,
				title: typeof payload.question === "string" ? payload.question : name,
				papers: payload.papers.length,
				content: parts.join(" + ") || "(empty)",
				html: existsSync(join(dir, `${name}.html`)),
			});
		} else if (Array.isArray(payload.rounds) && payload.paper) {
			entries.push({
				name, kind: "chat", generated: payload.generated,
				title: typeof payload.question === "string" ? payload.question : name,
				papers: 1,
				content: `${payload.rounds.length} round${payload.rounds.length === 1 ? "" : "s"}`,
				html: existsSync(join(dir, `${name}.html`)),
			});
		}
	}
	return entries.sort((a, b) => b.generated.localeCompare(a.generated));
}

export interface SessionRound extends Round {
	/** Protocol file base (the paper or scope identity the round was
	 * recorded under). */
	base: string;
	/** Identity key of the protocol file's paper. */
	paper_key: string;
}

export interface SessionEntry {
	session: string;
	rounds: SessionRound[];
	/** ISO time of the last round. */
	last: string;
	/** Scope of the last round (basenames, or "library"). */
	scope: string[] | "library";
}

/** Chat sessions reconstructed from the protocol files, newest first.
 * Everything in a protocol passed the citation gate when it was written. */
export function listSessions(root: string): SessionEntry[] {
	const dir = join(root, "lit-synthesis", "protocols");
	const bySession = new Map<string, SessionRound[]>();
	for (const file of listDir(dir)) {
		if (!/^\d{4}-\d{2}-\d{2}_.*\.json$/.test(file)) continue;
		const protocol = readJson(join(dir, file)) as Record<string, any> | null;
		if (!protocol || !Array.isArray(protocol.rounds) || typeof protocol.base !== "string") continue;
		for (const round of protocol.rounds as Round[]) {
			if (typeof round?.session !== "string" || !round.session) continue;
			const list = bySession.get(round.session) ?? [];
			list.push({ ...round, base: protocol.base, paper_key: typeof protocol.paper?.key === "string" ? protocol.paper.key : "" });
			bySession.set(round.session, list);
		}
	}
	const sessions: SessionEntry[] = [];
	for (const [session, rounds] of bySession) {
		rounds.sort((a, b) => a.asked.localeCompare(b.asked));
		const lastRound = rounds[rounds.length - 1];
		sessions.push({
			session,
			rounds,
			last: lastRound.asked,
			scope: lastRound.scope ?? [lastRound.base],
		});
	}
	return sessions.sort((a, b) => b.last.localeCompare(a.last));
}
