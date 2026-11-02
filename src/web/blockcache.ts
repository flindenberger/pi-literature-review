/**
 * Saved keyword blocks of the web interface: the blocks the model built
 * for a request text, so the same text always searches with the same
 * blocks (a model answers differently from call to call, even at
 * temperature 0 across reloads). One JSON file next to the configuration
 * (~/.config/pi-literature-review/keyword-blocks.json; the
 * PI_LITERATURE_REVIEW_BLOCK_CACHE variable overrides the path). Key =
 * mode + the request text normalized (lowercase, single spaces). Writes go
 * through a temporary file and a rename. Holds query words only, never
 * bibliographic data.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { configPath } from "../config.ts";
import type { VariantSuggestion } from "../intake.ts";

/** "own": the request's own words only (the default); "synonyms": the
 * model's proposal with one synonym per block (the synonym button). */
export type BlockMode = "own" | "synonyms";

/** Oldest entries go first beyond this many. */
const MAX_ENTRIES = 500;

/** Pure and injectable for tests; defaults describe the running machine. */
export function blockCachePath(
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	return env.PI_LITERATURE_REVIEW_BLOCK_CACHE || join(dirname(configPath(platform, env, home)), "keyword-blocks.json");
}

export function blockCacheKey(mode: BlockMode, request: string): string {
	return `${mode}:${request.trim().replace(/\s+/g, " ").toLowerCase()}`;
}

function readAll(file: string): Record<string, VariantSuggestion[]> {
	if (!existsSync(file)) return {};
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, VariantSuggestion[]> : {};
	} catch {
		return {};
	}
}

/** The saved proposal for this request (the rows the model gave, "plus1"
 * first), or null. */
export function cachedBlocks(file: string, mode: BlockMode, request: string): VariantSuggestion[] | null {
	const rows = readAll(file)[blockCacheKey(mode, request)];
	const valid = Array.isArray(rows) && rows.length > 0
		&& rows.every((row) => row && typeof row.text === "string" && ["plus1", "plus2", "arxiv"].includes(row.role));
	return valid ? rows : null;
}

/** Save the proposal for this request (replaces an older entry). */
export function saveBlocks(file: string, mode: BlockMode, request: string, rows: VariantSuggestion[]): void {
	const all = readAll(file);
	const key = blockCacheKey(mode, request);
	delete all[key];
	all[key] = rows;
	const keys = Object.keys(all);
	for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[old];
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(all, null, 1));
	renameSync(temp, file);
}

/** How many requests have saved blocks. */
export function blockCacheSize(file: string): number {
	return Object.keys(readAll(file)).length;
}

/** Forget every saved block set; returns how many there were. */
export function clearBlockCache(file: string): number {
	const count = Object.keys(readAll(file)).length;
	rmSync(file, { force: true });
	return count;
}
