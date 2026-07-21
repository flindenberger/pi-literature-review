/**
 * Resolve the current pi session id for a working directory -- the CLI's
 * counterpart to ctx.sessionManager.getSessionId() inside the extension.
 *
 * pi stores sessions as
 *   ~/.pi/agent/sessions/--<cwd with / replaced by ->--/<timestamp>_<uuid>.jsonl
 * (documented in the pi session-format docs; layout verified live). The
 * most recently WRITTEN file is the session the user is in or just left --
 * mtime, not the filename timestamp, because /resume appends to an old
 * file. Returns null when no session exists for the directory; session
 * scoping then simply stays off (no sticky paper, report covers nothing).
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Injectable filesystem view; everything tests offline through this. */
export interface PiSessionDeps {
	entries(dir: string): Array<{ name: string; mtimeMs: number }>;
	home(): string;
}

export function realPiSessionDeps(): PiSessionDeps {
	return {
		entries: (dir) => {
			try {
				return readdirSync(dir).map((name) => {
					try {
						return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
					} catch {
						return { name, mtimeMs: 0 };
					}
				});
			} catch {
				return [];
			}
		},
		home: () => homedir(),
	};
}

/** The sessions directory pi uses for a working directory. Pure. */
export function piSessionsDir(cwd: string, home: string): string {
	const mangled = cwd.replace(/^\/+/, "").replace(/\//g, "-");
	return join(home, ".pi", "agent", "sessions", `--${mangled}--`);
}

const SESSION_FILE = /_([0-9a-f][0-9a-f-]*)\.jsonl$/i;

/** Session id (uuid from the filename) of the newest session file for this
 * cwd, or null when none exists. */
export function resolvePiSessionId(cwd: string, deps: PiSessionDeps = realPiSessionDeps()): string | null {
	const candidates = deps
		.entries(piSessionsDir(cwd, deps.home()))
		.filter((entry) => SESSION_FILE.test(entry.name))
		.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
	if (!candidates.length) return null;
	const newest = candidates[candidates.length - 1];
	return newest.name.match(SESSION_FILE)?.[1] ?? null;
}
