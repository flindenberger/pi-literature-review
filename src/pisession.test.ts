/**
 * Offline tests for the pi session resolver (the CLI's source of the
 * session id that scopes sticky paper and chat reports). No filesystem.
 */

import assert from "node:assert/strict";
import { piSessionsDir, type PiSessionDeps, resolvePiSessionId } from "./pisession.ts";

function fakeDeps(byDir: Record<string, Array<{ name: string; mtimeMs: number }>>): PiSessionDeps {
	return {
		entries: (dir) => byDir[dir] ?? [],
		home: () => "/home/u",
	};
}

/* ---------------- piSessionsDir: the cwd mangling pi uses ---------------- */
{
	assert.equal(
		piSessionsDir("/home/u/project", "/home/u"),
		"/home/u/.pi/agent/sessions/--home-u-project--",
	);
	// Spaces survive; only slashes are replaced (layout verified live).
	assert.equal(
		piSessionsDir("/mnt/x/Stage 1 - Query/sub", "/home/u"),
		"/home/u/.pi/agent/sessions/--mnt-x-Stage 1 - Query-sub--",
	);
}

/* ---------------- resolvePiSessionId ---------------- */
{
	const dir = "/home/u/.pi/agent/sessions/--home-u-project--";
	// The most recently WRITTEN session wins -- mtime, not the filename
	// timestamp (/resume appends to an old file).
	const deps = fakeDeps({
		[dir]: [
			{ name: "2026-07-15T13-49-40-384Z_019f660a-52a0-7229-b5a7-835b0236c09d.jsonl", mtimeMs: 500 },
			{ name: "2026-07-20T09-00-00-000Z_ffff0000-1111-2222-3333-444455556666.jsonl", mtimeMs: 100 },
			{ name: "notes.txt", mtimeMs: 999 }, // not a session file
		],
	});
	assert.equal(resolvePiSessionId("/home/u/project", deps), "019f660a-52a0-7229-b5a7-835b0236c09d");
	// No directory / no session files -> null, session scoping simply off.
	assert.equal(resolvePiSessionId("/somewhere/else", deps), null);
	assert.equal(resolvePiSessionId("/home/u/project", fakeDeps({ [dir]: [{ name: "junk.jsonl", mtimeMs: 1 }] })), null);
}

console.log("pisession.test.ts: all assertions passed");
