/**
 * Session protocol and sticky scope -- the code-validated record of a
 * reading session, shared by chat rounds, multi-paper reports and library
 * reviews.
 *
 * Everything in a protocol file has passed the citation gate; nothing
 * comes from the pi chat transcript. Files are per paper (or scope) and
 * day under lit-synthesis/protocols/; a file that is corrupt or records a
 * different paper identity is never overwritten (quarantine to _2/_3
 * suffixes). The sticky marker current-scope.json remembers the session's
 * document selection (one paper, several, or the whole library) and only
 * counts inside the pi session that wrote it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ReferenceEntry } from "./synthesis.ts";

/** Schema 2: rounds MAY carry a scope and citation sites. Files written
 * under schema 1 are still read; the fields are additive. */
export const PROTOCOL_SCHEMA = 2;

/** Where one citation marker in the prose points: the exact chunk behind
 * it, resolved by code (never by the model). Drives the clickable PDF
 * superscripts. */
export interface CitationSite {
	/** Paper-level reference number the marker shows ([n]). */
	ref: number;
	/** Prompt excerpt number the claim rests on. */
	chunk_id: number;
	paper_key: string;
	page: number;
	/** Phrase for the PDF text highlight; null when no safe phrase exists
	 * (the link then opens the page without a highlight). */
	snippet: string | null;
}

/** The session's document selection: named PDF basenames or the whole
 * library. */
export type ScopeSelection = string[] | "library";

/** One validated question round as persisted. */
export interface Round {
	/** ISO timestamp of the question. */
	asked: string;
	question: string;
	language: string | null;
	model: string;
	/** Pi session the round belongs to (null: recorded without a session,
	 * e.g. by a CLI run outside any pi session or before session scoping). */
	session: string | null;
	/** Document scope of the round; absent for classic one-paper rounds
	 * (the protocol file's paper IS the scope). */
	scope?: ScopeSelection;
	top_k: number;
	grounded: boolean;
	prose: string;
	references: ReferenceEntry[];
	/** Per-marker chunk provenance in document order (schema 2). */
	sites?: CitationSite[];
	/** Only the excerpts the answer actually cites (bounds file growth;
	 * a report re-retrieves, so nothing is lost). */
	cited_chunks: Array<{ id: number; page: number; score: number; text: string; lexical?: boolean }>;
	invalid_markers: string[];
	unmarked_sentences: number;
	stripped_reference_section: boolean;
}

/** Bibliographic identity a protocol file is bound to -- always from the
 * verified record (or the honest filename identity for unverified PDFs). */
export interface PaperIdentity {
	base: string;
	key: string;
	title: string;
	authors: string[];
	year: string | null;
	doi: string;
	arxiv_id: string;
}

/** On-disk shape -- never a bare array, so the schema can evolve. */
export interface Protocol {
	schema: number;
	base: string;
	paper: Omit<PaperIdentity, "base">;
	/** UTC date the file is named after. */
	date: string;
	rounds: Round[];
}

/** Injectable persistence; everything tests offline through this. */
export interface ProtocolDeps {
	read(path: string): string | null;
	write(path: string, text: string): void;
	exists(path: string): boolean;
	list(dir: string): string[];
}

export function realProtocolDeps(): ProtocolDeps {
	return {
		read: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
		write: (path, text) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text, "utf8");
		},
		exists: (path) => existsSync(path),
		list: (dir) => {
			try {
				return readdirSync(dir);
			} catch {
				return [];
			}
		},
	};
}

/** Protocol file for a paper on a given day. Dates are UTC (the ISO date
 * of the round's timestamp), matching writeRunOutputs' date handling. */
export function protocolLogPath(root: string, dateIso10: string, base: string, suffix = 0): string {
	const name = suffix > 1 ? `${dateIso10}_${base}_${suffix}.json` : `${dateIso10}_${base}.json`;
	return join(root, "lit-synthesis", "protocols", name);
}

/* ------------------------------------------------------------------ *
 * Sticky scope -- the session's document selection                    *
 * ------------------------------------------------------------------ */

/** Marker file remembering the session's current scope. The date-anchored
 * protocol filename pattern never matches it. */
export function currentScopePath(root: string): string {
	return join(root, "lit-synthesis", "protocols", "current-scope.json");
}

export interface CurrentScope {
	papers: ScopeSelection;
}

function validScope(value: unknown): ScopeSelection | null {
	if (value === "library") return "library";
	if (Array.isArray(value)) {
		const papers = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
			.map((entry) => entry.trim());
		if (papers.length && papers.length === value.length) return papers;
	}
	return null;
}

/**
 * The sticky selection: set after every successful round (and by the
 * wizard), used whenever a call names no documents -- a weak agent model
 * then only has to transport the user's question. SESSION-SCOPED: the
 * marker only counts inside the pi session that wrote it. Null when unset,
 * unreadable, or written by a different session.
 */
export function readCurrentScope(
	root: string,
	session: string | null | undefined,
	deps: ProtocolDeps = realProtocolDeps(),
): CurrentScope | null {
	if (!session) return null;
	const raw = deps.read(currentScopePath(root));
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as { papers?: unknown; session?: unknown } | null;
		const papers = validScope(parsed?.papers);
		return papers && parsed?.session === session ? { papers } : null;
	} catch {
		return null;
	}
}

/** The scope's single paper, when it is exactly one (the session report
 * covers exactly one paper). */
export function singlePaperOf(scope: CurrentScope | null): string | null {
	if (!scope || scope.papers === "library") return null;
	return scope.papers.length === 1 ? scope.papers[0] : null;
}

/** Best-effort: failure to remember the scope must never break a run. */
export function writeCurrentScope(
	root: string,
	scope: CurrentScope,
	session: string | null | undefined,
	deps: ProtocolDeps = realProtocolDeps(),
	onWarn: (message: string) => void = () => {},
): void {
	try {
		deps.write(
			currentScopePath(root),
			JSON.stringify({ papers: scope.papers, session: session ?? null }, null, 2) + "\n",
		);
	} catch (error) {
		onWarn(`could not remember the current scope: ${error instanceof Error ? error.message : error}`);
	}
}

/* ------------------------------------------------------------------ *
 * Protocol files -- append with quarantine, session-scoped loading    *
 * ------------------------------------------------------------------ */

function parseProtocol(text: string | null): Protocol | null {
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text) as Protocol;
		if (parsed && (parsed.schema === PROTOCOL_SCHEMA || parsed.schema === 1) && typeof parsed.base === "string"
			&& parsed.paper && typeof parsed.paper.key === "string" && Array.isArray(parsed.rounds)) {
			return parsed;
		}
	} catch {
		// fall through -- caller treats null as unreadable
	}
	return null;
}

/**
 * Append one validated round to the paper's protocol of the day. A file
 * that is corrupt or records a DIFFERENT paper identity (renamed PDF) is
 * never overwritten: it stays untouched with a warning and the round goes
 * to the next _2/_3 file -- the same quarantine policy as the output
 * collision suffixes. A schema-1 file keeps its schema on append (the new
 * fields are additive). Writing is not atomic; a crash mid-write corrupts
 * at most one day file, which this fallback then quarantines.
 */
export function appendRound(
	root: string,
	paper: PaperIdentity,
	round: Round,
	deps: ProtocolDeps,
	onWarn: (message: string) => void,
): { path: string; roundNumber: number } {
	const date = round.asked.slice(0, 10);
	for (let suffix = 0; ; suffix = suffix < 2 ? 2 : suffix + 1) {
		const path = protocolLogPath(root, date, paper.base, suffix);
		if (!deps.exists(path)) {
			const protocol: Protocol = {
				schema: PROTOCOL_SCHEMA,
				base: paper.base,
				paper: {
					key: paper.key,
					title: paper.title,
					authors: paper.authors,
					year: paper.year,
					doi: paper.doi,
					arxiv_id: paper.arxiv_id,
				},
				date,
				rounds: [round],
			};
			deps.write(path, JSON.stringify(protocol, null, 2) + "\n");
			return { path, roundNumber: 1 };
		}
		const existing = parseProtocol(deps.read(path));
		if (existing && existing.paper.key === paper.key) {
			existing.rounds.push(round);
			deps.write(path, JSON.stringify(existing, null, 2) + "\n");
			return { path, roundNumber: existing.rounds.length };
		}
		onWarn(`chat protocol ${path} is ${existing ? "for a different paper" : "not readable"}`
			+ " -- keeping it untouched, continuing in a new file");
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The protocol rounds of ONE pi session for this paper (reports cover only
 * the current session; earlier sessions stay on disk as ground truth but
 * are never re-surfaced). The scan still spans
 * all day files -- /resume keeps the session id, so "chat on Tuesday, report
 * on Wednesday" works within the resumed session. Filenames are matched with
 * an anchored pattern so report sidecars and other papers sharing a name
 * prefix are never ingested; files recording a different paper identity are
 * skipped with a warning. Without a session id nothing matches.
 */
export function loadRounds(
	root: string,
	base: string,
	paperKey: string,
	session: string | null,
	deps: ProtocolDeps,
	onWarn: (message: string) => void,
): { rounds: Round[]; files: string[] } {
	if (!session) return { rounds: [], files: [] };
	const dir = join(root, "lit-synthesis", "protocols");
	const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}_${escapeRegExp(base)}(_\\d+)?\\.json$`);
	const names = deps.list(dir).filter((name) => pattern.test(name)).sort();
	const rounds: Round[] = [];
	const files: string[] = [];
	for (const name of names) {
		const path = join(dir, name);
		const protocol = parseProtocol(deps.read(path));
		if (!protocol) {
			onWarn(`skipping unreadable chat protocol ${path}`);
			continue;
		}
		if (protocol.paper.key !== paperKey) {
			onWarn(`skipping ${path}: it records a different paper identity`);
			continue;
		}
		const ofSession = protocol.rounds.filter((round) => round.session === session);
		if (!ofSession.length) continue;
		rounds.push(...ofSession);
		files.push(path);
	}
	return { rounds, files };
}
