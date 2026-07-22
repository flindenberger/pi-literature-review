/**
 * Offline tests for the protocol/sticky-scope layer (extracted from
 * chat.ts, v25 E2a). Centerpieces: the append quarantine (corrupt or
 * foreign files are never overwritten), session-scoped round loading, the
 * generalized sticky scope with its legacy current-paper fallback, and
 * schema 2 reading schema 1. No filesystem, no network.
 */

import assert from "node:assert/strict";
import {
	appendRound,
	type CurrentScope,
	currentScopePath,
	legacyCurrentPaperPath,
	loadRounds,
	type PaperIdentity,
	type Protocol,
	PROTOCOL_SCHEMA,
	type ProtocolDeps,
	protocolLogPath,
	readCurrentScope,
	type Round,
	singlePaperOf,
	writeCurrentScope,
} from "./protocol.ts";

/* ---------------- fixtures ---------------- */

const paperA: PaperIdentity = {
	base: "a", key: "doi:10.3390/rs13081505", title: "Vistula sandbars",
	authors: ["Anna Kryniecka", "A. Magnuszewski"], year: "2021", doi: "10.3390/rs13081505", arxiv_id: "",
};

/** In-memory persistence: a Map of absolute path -> file text. */
function memoryDeps(): { deps: ProtocolDeps; files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		deps: {
			read: (path) => files.get(path) ?? null,
			write: (path, text) => {
				files.set(path, text);
			},
			exists: (path) => files.has(path),
			list: (dir) => [...files.keys()]
				.filter((path) => path.startsWith(`${dir}/`))
				.map((path) => path.slice(dir.length + 1)),
		},
	};
}

function makeRound(question: string, session: string | null = null): Round {
	return {
		asked: "2026-07-16T10:00:00.000Z", question, language: null, model: "fake-gen", session,
		top_k: 8, grounded: true, prose: "Antwort [1].",
		references: [{
			n: 1, key: paperA.key, title: paperA.title, authors: paperA.authors, year: paperA.year,
			doi: paperA.doi, arxiv_id: "", pages: [2], chunk_ids: [1],
		}],
		cited_chunks: [{ id: 1, page: 2, score: 0.9, text: "Sandbars were mapped with Sentinel-2 imagery." }],
		invalid_markers: [], unmarked_sentences: 0, stripped_reference_section: false,
	};
}

const protocolOf = (date: string, rounds: Round[], key = paperA.key): string => JSON.stringify({
	schema: PROTOCOL_SCHEMA, base: "a", date,
	paper: { key, title: paperA.title, authors: paperA.authors, year: paperA.year, doi: paperA.doi, arxiv_id: "" },
	rounds,
} satisfies Protocol);

/* ---------------- protocolLogPath naming ---------------- */
{
	assert.equal(protocolLogPath("/root", "2026-07-16", "a"), "/root/chats/2026-07-16_a.json");
	assert.equal(protocolLogPath("/root", "2026-07-16", "a", 2), "/root/chats/2026-07-16_a_2.json");
	assert.equal(protocolLogPath("/root", "2026-07-16", "arxiv_2401.16393", 5), "/root/chats/2026-07-16_arxiv_2401.16393_5.json");
}

/* ---------------- appendRound: create, append, schema ---------------- */
{
	const { deps, files } = memoryDeps();
	const first = appendRound("/", paperA, makeRound("Frage eins?"), deps, () => {});
	assert.equal(first.path, "/chats/2026-07-16_a.json");
	assert.equal(first.roundNumber, 1);
	const second = appendRound("/", paperA, makeRound("Frage zwei?"), deps, () => {});
	assert.equal(second.path, first.path); // same day -> same file
	assert.equal(second.roundNumber, 2);
	const protocol = JSON.parse(files.get(first.path)!) as Protocol;
	assert.equal(protocol.schema, PROTOCOL_SCHEMA); // new files are schema 2
	assert.equal(protocol.paper.key, paperA.key);
	assert.deepEqual(protocol.rounds.map((round) => round.question), ["Frage eins?", "Frage zwei?"]);
}
{
	// A schema-1 file (pre-v25) is still readable and appendable; it keeps
	// its schema on append -- the new fields are additive, a bump would
	// quarantine every existing protocol.
	const { deps, files } = memoryDeps();
	const legacy = JSON.parse(protocolOf("2026-07-16", [makeRound("alt")])) as Protocol;
	legacy.schema = 1;
	files.set("/chats/2026-07-16_a.json", JSON.stringify(legacy));
	const appended = appendRound("/", paperA, makeRound("neu"), deps, () => {});
	assert.equal(appended.path, "/chats/2026-07-16_a.json"); // NOT quarantined
	assert.equal(appended.roundNumber, 2);
	assert.equal((JSON.parse(files.get(appended.path)!) as Protocol).schema, 1);
}

/* ---------------- appendRound: quarantine, never overwrite ---------------- */
{
	// Corrupt file: stays untouched, the round goes to _2.
	const { deps, files } = memoryDeps();
	files.set("/chats/2026-07-16_a.json", "{ not json");
	const warnings: string[] = [];
	const appended = appendRound("/", paperA, makeRound("q"), deps, (m) => warnings.push(m));
	assert.equal(appended.path, "/chats/2026-07-16_a_2.json");
	assert.equal(appended.roundNumber, 1);
	assert.equal(files.get("/chats/2026-07-16_a.json"), "{ not json"); // untouched
	assert.ok(warnings.some((m) => m.includes("not readable")));
}
{
	// Same path, different paper identity (renamed PDF): also quarantined.
	const { deps, files } = memoryDeps();
	files.set("/chats/2026-07-16_a.json", protocolOf("2026-07-16", [makeRound("old")], "doi:10.9999/other"));
	const warnings: string[] = [];
	const appended = appendRound("/", paperA, makeRound("new"), deps, (m) => warnings.push(m));
	assert.equal(appended.path, "/chats/2026-07-16_a_2.json");
	assert.equal((JSON.parse(files.get("/chats/2026-07-16_a.json")!) as Protocol).rounds[0].question, "old");
	assert.ok(warnings.some((m) => m.includes("different paper")));
}

/* ---------------- loadRounds: anchored matching, one session ---------------- */
{
	const { deps, files } = memoryDeps();
	// Multi-day within ONE session (/resume keeps the id) plus rounds of an
	// earlier session and legacy session-less rounds in the same files.
	files.set("/chats/2026-07-15_a.json", protocolOf("2026-07-15", [makeRound("Dienstag", "s1"), makeRound("fruehere Session", "s0")]));
	files.set("/chats/2026-07-16_a.json", protocolOf("2026-07-16", [makeRound("Mittwoch 1", "s1"), makeRound("Mittwoch 2", "s1"), makeRound("Altbestand ohne Session")]));
	files.set("/chats/2026-07-16_a_2.json", protocolOf("2026-07-16", [makeRound("Quarantaene-Nachfolger", "s1")]));
	files.set("/chats/2026-07-12_a.json", protocolOf("2026-07-12", [makeRound("nur fremde Session", "s0")]));
	files.set("/chats/2026-07-14_a.json", "{ corrupt");
	files.set("/chats/2026-07-13_a.json", protocolOf("2026-07-13", [makeRound("fremd", "s1")], "doi:10.9999/other"));
	files.set("/chats/2026-07-16_ab.json", protocolOf("2026-07-16", [makeRound("anderes Paper", "s1")])); // base "ab" != "a"
	files.set("/chats/2026-07-16_Paper_chat_report_a.json", "{}"); // report sidecar, never ingested
	const warnings: string[] = [];
	const { rounds, files: used } = loadRounds("/", "a", paperA.key, "s1", deps, (m) => warnings.push(m));
	assert.deepEqual(
		rounds.map((round) => round.question),
		["Dienstag", "Mittwoch 1", "Mittwoch 2", "Quarantaene-Nachfolger"],
	);
	// Only files contributing rounds of THIS session are listed.
	assert.deepEqual(used, [
		"/chats/2026-07-15_a.json",
		"/chats/2026-07-16_a.json",
		"/chats/2026-07-16_a_2.json",
	]);
	assert.ok(warnings.some((m) => m.includes("unreadable") && m.includes("2026-07-14_a.json")));
	assert.ok(warnings.some((m) => m.includes("different paper identity") && m.includes("2026-07-13_a.json")));
	// Without a session id nothing matches -- session scoping is never off.
	assert.deepEqual(loadRounds("/", "a", paperA.key, null, deps, () => {}).rounds, []);
	// The dotted arXiv base must not match its dot-as-wildcard lookalikes.
	const dotted = memoryDeps();
	dotted.files.set("/chats/2026-07-16_arxiv_2401x16393.json", protocolOf("2026-07-16", [makeRound("Falle", "s1")]));
	const none = loadRounds("/", "arxiv_2401.16393", paperA.key, "s1", dotted.deps, () => {});
	assert.deepEqual(none.rounds, []);
}

/* ---------------- sticky scope: session semantics ---------------- */
{
	assert.equal(currentScopePath("/root"), "/root/chats/current-scope.json");
	assert.equal(legacyCurrentPaperPath("/root"), "/root/chats/current-paper.json");

	const { deps, files } = memoryDeps();
	// Round-trip; only the matching session reads it back.
	writeCurrentScope("/", { papers: ["a", "b"] }, "s1", deps);
	assert.deepEqual(JSON.parse(files.get("/chats/current-scope.json")!), { papers: ["a", "b"], session: "s1" });
	assert.deepEqual(readCurrentScope("/", "s1", deps), { papers: ["a", "b"] });
	assert.equal(readCurrentScope("/", "s2", deps), null); // other session
	assert.equal(readCurrentScope("/", null, deps), null); // no session, no sticky
	// The whole-library scope survives the round-trip.
	writeCurrentScope("/", { papers: "library" }, "s1", deps);
	assert.deepEqual(readCurrentScope("/", "s1", deps), { papers: "library" });
	// Corrupt or invalid scope files read as unset.
	files.set("/chats/current-scope.json", "{ garbage");
	assert.equal(readCurrentScope("/", "s1", deps), null);
	files.set("/chats/current-scope.json", JSON.stringify({ papers: [], session: "s1" }));
	assert.equal(readCurrentScope("/", "s1", deps), null); // empty selection is no selection
	// A write failure degrades to a warning, never an exception.
	const warnings: string[] = [];
	writeCurrentScope("/", { papers: ["a"] }, "s1", {
		...deps,
		write: () => {
			throw new Error("disk full");
		},
	}, (m) => warnings.push(m));
	assert.ok(warnings.some((m) => m.includes("could not remember") && m.includes("disk full")));
}
{
	// Legacy fallback: with NO current-scope.json, the pre-v25 marker is
	// still honored (one release), same session rule, one-paper scope.
	const { deps, files } = memoryDeps();
	files.set("/chats/current-paper.json", JSON.stringify({ base: "a", session: "s1" }));
	assert.deepEqual(readCurrentScope("/", "s1", deps), { papers: ["a"] });
	assert.equal(readCurrentScope("/", "s2", deps), null);
	// Once a scope file EXISTS, the legacy marker is never consulted again
	// (it is older by construction; resurrecting it would replay the v23
	// stale-selection bug).
	writeCurrentScope("/", { papers: ["b"] }, "s2", deps);
	assert.equal(readCurrentScope("/", "s1", deps), null);
	assert.deepEqual(readCurrentScope("/", "s2", deps), { papers: ["b"] });
	// Legacy marker without a session field never matches (migration path).
	const legacyOnly = memoryDeps();
	legacyOnly.files.set("/chats/current-paper.json", JSON.stringify({ base: "a" }));
	assert.equal(readCurrentScope("/", "s1", legacyOnly.deps), null);
}

/* ---------------- singlePaperOf ---------------- */
{
	assert.equal(singlePaperOf({ papers: ["a"] }), "a");
	assert.equal(singlePaperOf({ papers: ["a", "b"] }), null); // multi needs the fusion engine
	assert.equal(singlePaperOf({ papers: "library" } satisfies CurrentScope), null);
	assert.equal(singlePaperOf(null), null);
}

console.log("protocol tests passed");
