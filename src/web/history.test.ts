// Conversation history store: folder resolution, save/list/load/delete, bad files skipped.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DialogState } from "./dialog.ts";
import { clearConversations, deleteConversation, historyDir, listConversations, loadConversation, newConversationId, saveConversation, type StoredConversation } from "./history.ts";

// ---- folder: next to the configuration file, env override wins ----
assert.equal(historyDir("linux", {}, "/home/u"), "/home/u/.config/pi-literature-review/history");
assert.equal(historyDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/u"), "/cfg/pi-literature-review/history");
assert.equal(historyDir("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u"), join("C:\\Users\\u\\AppData\\Roaming", "pi-literature-review", "history"));
assert.equal(historyDir("linux", { PI_LITERATURE_REVIEW_HISTORY: "/elsewhere/h" }, "/home/u"), "/elsewhere/h");

// ---- ids: sortable, file-name safe ----
const id = newConversationId(new Date("2026-10-28T11:32:05.123Z"));
assert.match(id, /^2026-10-28T11-32-05_[0-9a-f]{4}$/);

const dir = mkdtempSync(join(tmpdir(), "plr-history-"));
try {
	const dialog = { step: "topic", answers: {}, messages: [{ id: 1, role: "assistant", text: "hi" }], activeJob: null, pending: null, trail: ["start"], counter: 1 } as unknown as DialogState;
	const entry = (over: Partial<StoredConversation>): StoredConversation => ({
		version: 1, id: "2026-10-28T11-32-05_aaaa", started: "2026-10-28T11:32:05.000Z", updated: "2026-10-28T11:40:00.000Z",
		root: "/data/one", chatSession: "web-2026-10-28-ab12", title: "Search: rivers", dialog, ...over,
	});

	// Empty folder lists nothing; a save creates the folder and the file, atomically (no .tmp left).
	assert.deepEqual(listConversations(join(dir, "missing")), { conversations: [], skipped: 0 });
	const file = saveConversation(dir, entry({}));
	assert.ok(existsSync(file));
	assert.deepEqual(readdirSync(dir), ["2026-10-28T11-32-05_aaaa.json"]);
	saveConversation(dir, entry({ id: "2026-10-28T12-00-00_bbbb", started: "2026-10-28T12:00:00.000Z", updated: "2026-10-28T12:05:00.000Z", root: "/data/two", title: "Chat: depth" }));
	// A newer save of the same id replaces the file.
	saveConversation(dir, entry({ updated: "2026-10-28T13:00:00.000Z", title: "Search: rivers and depth" }));
	assert.equal(readdirSync(dir).length, 2);

	// Listing: newest computation first (a conversation without one sorts by
	// its start; a later change alone moves nothing), summaries only;
	// unreadable files are counted, not deleted.
	writeFileSync(join(dir, "broken.json"), "{not json");
	writeFileSync(join(dir, "old.json"), JSON.stringify({ version: 0 }));
	writeFileSync(join(dir, "notes.txt"), "ignored");
	let listed = listConversations(dir);
	assert.equal(listed.skipped, 2);
	assert.deepEqual(listed.conversations.map((c) => [c.id, c.title, c.root, c.steps]), [
		["2026-10-28T12-00-00_bbbb", "Chat: depth", "/data/two", 1],
		["2026-10-28T11-32-05_aaaa", "Search: rivers and depth", "/data/one", 1],
	]);
	// A new computation stamps the older conversation and lifts it to the top.
	saveConversation(dir, entry({ updated: "2026-10-28T14:00:30.000Z", computed: "2026-10-28T14:00:00.000Z", title: "Search: rivers and depth" }));
	listed = listConversations(dir);
	assert.deepEqual(listed.conversations.map((c) => [c.id, c.computed ?? null]), [
		["2026-10-28T11-32-05_aaaa", "2026-10-28T14:00:00.000Z"],
		["2026-10-28T12-00-00_bbbb", null],
	]);
	assert.ok(existsSync(join(dir, "broken.json")));

	// Load: the whole snapshot; a foreign id or a path never resolves.
	assert.equal(loadConversation(dir, "2026-10-28T12-00-00_bbbb")?.dialog.step, "topic");
	assert.equal(loadConversation(dir, "nope"), null);
	assert.equal(loadConversation(dir, "../etc/passwd"), null);
	assert.equal(loadConversation(dir, "broken"), null);
	assert.throws(() => saveConversation(dir, entry({ id: "../x" })), /invalid conversation id/);

	// Delete one, then all; other files stay.
	assert.equal(deleteConversation(dir, "2026-10-28T12-00-00_bbbb"), true);
	assert.equal(deleteConversation(dir, "2026-10-28T12-00-00_bbbb"), false);
	assert.equal(deleteConversation(dir, "../x"), false);
	assert.equal(clearConversations(dir), 3);
	assert.deepEqual(readdirSync(dir).sort(), ["notes.txt"]);
	assert.equal(clearConversations(join(dir, "missing")), 0);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log("history tests passed");
