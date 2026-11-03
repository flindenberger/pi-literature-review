/**
 * Conversation history of the web interface: one JSON snapshot per
 * conversation, kept next to the configuration file
 * (~/.config/pi-literature-review/history/ on Linux and macOS,
 * %APPDATA%\pi-literature-review\history\ on Windows;
 * PI_LITERATURE_REVIEW_HISTORY overrides the folder). Bundled with the
 * configuration on purpose: one place for everything the package keeps
 * outside the data folders, like pi keeps everything under ~/.pi/agent;
 * the files are small (tens of kilobytes each).
 *
 * A snapshot of the dialog state, not an event log: the dialog's answers
 * depend on the context at the time (library size, enabled sources, the
 * model's proposals), so replaying events later could take a different
 * path. Each save writes a temporary file and renames it, so a crash
 * never leaves a half-written conversation behind. Nothing here is
 * bibliographic data; the snapshot holds what the page showed.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { configPath } from "../config.ts";
import type { DialogState } from "./dialog.ts";

export interface StoredConversation {
	version: 1;
	id: string;
	/** ISO timestamps: when the conversation began, when it last changed. */
	started: string;
	updated: string;
	/** When its last search or report was computed; the rail sorts by this
	 * (falling back to `started`), so opening or answering never moves an
	 * entry, a new computation does. */
	computed?: string;
	/** Data folder the conversation's reports and PDFs belong to. */
	root: string;
	chatSession: string;
	title: string;
	dialog: DialogState;
}

/** What the rail lists per conversation (no dialog payload). */
export interface ConversationSummary {
	id: string;
	title: string;
	started: string;
	updated: string;
	computed?: string;
	root: string;
	/** Questions answered so far. */
	steps: number;
	/** The newest search run of the conversation (its result list), if any. */
	run?: string;
	/** The newest synthesis or chat report written in it, if any. */
	report?: { name: string; url: string };
	/** A chat on one PDF: that PDF's base name. */
	paper?: string;
}

/** What a conversation produced: its newest result list and its newest
 * synthesis/chat report (file cards of the lit-synthesis stage). Pure. */
export function conversationFiles(dialog: DialogState): { run?: string; report?: { name: string; url: string }; paper?: string } {
	const out: { run?: string; report?: { name: string; url: string }; paper?: string } = {};
	const scope = dialog.answers?.scope;
	if (Array.isArray(scope) && scope.length === 1) out.paper = scope[0];
	for (const message of dialog.messages) {
		if (message.role === "results" && message.run) out.run = message.run;
		if (message.role === "card" && message.card && message.card.kind === "file" && message.card.stage === "lit-synthesis" && message.card.url) {
			out.report = { name: message.card.name, url: message.card.url };
		}
	}
	// Reports of the paper chat's buttons leave no card: the newest one counts.
	const buttons = dialog.answers?.reports;
	const url = buttons?.synthesis ?? buttons?.summary;
	if (!out.report && url) out.report = { name: decodeURIComponent(url.replace(/[?#].*$/, "").split("/").pop() ?? url), url };
	return out;
}

/** Pure and injectable for tests; defaults describe the running machine. */
export function historyDir(
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	return env.PI_LITERATURE_REVIEW_HISTORY || join(dirname(configPath(platform, env, home)), "history");
}

/** Readable, sortable, unique: "2026-10-28T11-32-05_k3f9". */
export function newConversationId(now: Date = new Date()): string {
	return `${now.toISOString().slice(0, 19).replace(/:/g, "-")}_${randomBytes(2).toString("hex")}`;
}

/** Ids are file names: letters, digits, dash, underscore -- never a path. */
const ID = /^[A-Za-z0-9_-]{1,80}$/;

function fileOf(dir: string, id: string): string | null {
	return ID.test(id) ? join(dir, `${id}.json`) : null;
}

/** Write the snapshot (temporary file + rename); returns the file path. */
export function saveConversation(dir: string, entry: StoredConversation): string {
	const file = fileOf(dir, entry.id);
	if (!file) throw new Error(`invalid conversation id: ${entry.id}`);
	mkdirSync(dir, { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(entry));
	renameSync(temp, file);
	return file;
}

/** Parse one file; null when it is not a version-1 conversation. */
function parse(text: string): StoredConversation | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	const entry = data as Partial<StoredConversation> | null;
	if (!entry || typeof entry !== "object" || entry.version !== 1) return null;
	if (typeof entry.id !== "string" || !ID.test(entry.id)) return null;
	if (typeof entry.started !== "string" || typeof entry.updated !== "string" || typeof entry.root !== "string") return null;
	if (typeof entry.title !== "string" || typeof entry.chatSession !== "string") return null;
	const dialog = entry.dialog as Partial<DialogState> | undefined;
	if (!dialog || typeof dialog !== "object" || typeof dialog.step !== "string" || !Array.isArray(dialog.messages) || !Array.isArray(dialog.trail)) return null;
	return entry as StoredConversation;
}

/** Every readable conversation, newest computation first; `skipped` counts
 * files that are not conversations (left in place, never deleted). */
export function listConversations(dir: string): { conversations: ConversationSummary[]; skipped: number } {
	if (!existsSync(dir)) return { conversations: [], skipped: 0 };
	const conversations: ConversationSummary[] = [];
	let skipped = 0;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const entry = loadConversation(dir, name.slice(0, -5));
		if (!entry) {
			skipped++;
			continue;
		}
		conversations.push({ id: entry.id, title: entry.title, started: entry.started, updated: entry.updated, ...(typeof entry.computed === "string" ? { computed: entry.computed } : {}), root: entry.root, steps: entry.dialog.trail.length, ...conversationFiles(entry.dialog) });
	}
	// Newest computation first; a conversation without one sorts by its start.
	const key = (entry: ConversationSummary) => entry.computed ?? entry.started;
	conversations.sort((a, b) => key(b).localeCompare(key(a)) || b.started.localeCompare(a.started));
	return { conversations, skipped };
}

export function loadConversation(dir: string, id: string): StoredConversation | null {
	const file = fileOf(dir, id);
	if (!file || !existsSync(file)) return null;
	try {
		const entry = parse(readFileSync(file, "utf8"));
		return entry && entry.id === id ? entry : null;
	} catch {
		return null;
	}
}

/** True when a file was removed. */
export function deleteConversation(dir: string, id: string): boolean {
	const file = fileOf(dir, id);
	if (!file || !existsSync(file)) return false;
	rmSync(file);
	return true;
}

/** Remove every conversation file; returns how many. Other files stay. */
export function clearConversations(dir: string): number {
	if (!existsSync(dir)) return 0;
	let removed = 0;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
		rmSync(join(dir, name));
		removed++;
	}
	return removed;
}
