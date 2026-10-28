/**
 * Offline tests of the web interface server: protection (token, cookie,
 * host header, path traversal), the SSE frames, job start/cancel and the
 * stage routes with stubbed engines. Port 0, a temporary data root, no
 * network. Run: node src/web.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider } from "./provider.ts";
import { intakeFromForm, periodRange } from "./web/intake.ts";
import { JobBusyError, JobRunner } from "./web/jobs.ts";
import { safeName, listSearchRuns, listSessions, searchCandidates } from "./web/files.ts";
import { hostAllowed, startWebServer, webSessionId } from "./web/server.ts";
import { sseFrame } from "./web/sse.ts";
import { parseWebArgs } from "../extensions/web.ts";
import { webPdfHref } from "./render.ts";

const root = mkdtempSync(join(tmpdir(), "plr-web-"));
mkdirSync(join(root, "lit-search"), { recursive: true });
mkdirSync(join(root, "lit-selection"), { recursive: true });
mkdirSync(join(root, "lit-synthesis", "protocols"), { recursive: true });

// A saved search with one result and one dropped record.
writeFileSync(join(root, "lit-search", "2026-10-15_rivers.json"), JSON.stringify({
	query: "(river) AND (bathymetry)",
	generated: "2026-10-15T10:00:00Z",
	flow: { included: 1 },
	results: [{ title: "River depth from space", year: "2022", doi: "10.1000/abc", arxiv_id: "", group: "on_target", access: { level: "free" } }],
	dropped: [{ reason: "no abstract", record: { title: "Dropped one", year: "2020", doi: "", arxiv_id: "2401.00001v2" } }],
}));
writeFileSync(join(root, "lit-search", "2026-10-15_rivers.html"), "<html><body>report</body></html>");
// A protocol with two rounds of one web session.
writeFileSync(join(root, "lit-synthesis", "protocols", "2026-10-15_paper.json"), JSON.stringify({
	schema: 2, base: "paper", paper: { key: "doi:10.1000/abc", title: "River depth from space", authors: ["A. Author"], year: "2022", doi: "10.1000/abc", arxiv_id: "" }, date: "2026-10-15",
	rounds: [
		{ asked: "2026-10-15T10:00:00Z", question: "Q1?", language: null, model: "m", session: "web-2026-10-15-ab12", top_k: 8, grounded: true, prose: "A [1].", references: [], sites: [{ ref: 1, chunk_id: 1, paper_key: "doi:10.1000/abc", page: 3, snippet: null }], cited_chunks: [], invalid_markers: [], unmarked_sentences: 0, stripped_reference_section: false },
		{ asked: "2026-10-15T10:05:00Z", question: "Q2?", language: null, model: "m", session: "web-2026-10-15-ab12", top_k: 8, grounded: true, prose: "B.", references: [], sites: [], cited_chunks: [], invalid_markers: [], unmarked_sentences: 0, stripped_reference_section: false },
	],
}));

// ---- pure helpers ----
{
	assert.equal(safeName("report.html"), "report.html");
	assert.equal(safeName("../package.json"), null);
	assert.equal(safeName("a/b.html"), null);
	assert.equal(safeName("notes.txt"), null); // extension not served
	assert.equal(safeName(".html"), null);
	assert.ok(hostAllowed("127.0.0.1:8080", 8080));
	assert.ok(hostAllowed("localhost:8080", 8080));
	assert.ok(!hostAllowed("evil.example:8080", 8080));
	assert.ok(!hostAllowed("127.0.0.1:9999", 8080));
	assert.ok(!hostAllowed(undefined, 8080));
	assert.match(webSessionId(new Date("2026-10-15T12:00:00Z")), /^web-2026-10-15-[0-9a-f]{4}$/);
	assert.equal(sseFrame("line", { a: 1 }), 'event: line\ndata: {"a":1}\n\n');
	const href = webPdfHref("/pdf");
	assert.equal(href("/data/lit-selection/2016 - Legleiter.pdf", 4, "quantile transform"), "/pdf/2016%20-%20Legleiter.pdf#page=4&search=quantile%20transform&phrase=true");
	assert.equal(href("/data/x.pdf"), "/pdf/x.pdf");
	assert.deepEqual(parseWebArgs(""), { stop: false, port: undefined, open: true });
	assert.deepEqual(parseWebArgs("stop"), { stop: true, port: undefined, open: true });
	assert.deepEqual(parseWebArgs("--port 8765 --no-open"), { stop: false, port: 8765, open: false });
	assert.match(parseWebArgs("--port abc").error ?? "", /--port/);
	assert.match(parseWebArgs("bogus").error ?? "", /unknown argument/);
}

// ---- intake mapping ----
{
	const { options, warnings, query } = intakeFromForm({
		blocks: ["satellite, Sentinel-2", "bathymetry OR water depth", ""],
		variants: ["(satellite) AND (depth)"],
		period: "10y",
		perSource: "15",
		sources: ["arxiv", "openalex", "bogus"],
		codeSources: ["awesome-lists"],
		codeTopics: ["Remote Sensing", "hydrology"],
		minCites: "5",
		journals: ["Remote Sensing"],
		journalsListed: ["Remote Sensing", "Water"],
		journalsOther: true,
		pickedAuthors: [{ id: "A123", name: "Carl Legleiter" }, { id: "bad", name: "x" }],
		authorPosition: "first",
		authorScope: "all",
	}, 2026);
	assert.equal(query.query, "(satellite OR Sentinel-2) AND (bathymetry OR water depth)");
	assert.deepEqual(options.queryVariants, ["(satellite) AND (depth)"]);
	assert.equal(options.perSource, 15);
	assert.deepEqual(options.sources, ["arxiv", "openalex"]);
	assert.deepEqual(options.codeSources, ["awesome-lists"]);
	assert.deepEqual(options.codeListTopics, ["remote-sensing", "hydrology"]);
	assert.equal(options.filters?.yearFrom, 2017);
	assert.equal(options.filters?.minCites, 5);
	assert.deepEqual(options.filters?.venues, ["Remote Sensing"]);
	assert.equal(options.filters?.venuesOther, true);
	assert.deepEqual(options.filters?.pickedAuthors, ["Carl Legleiter"]);
	assert.deepEqual(options.authorIds, ["A123"]);
	assert.equal(options.filters?.authorPosition, "first");
	assert.equal(options.authorScope, "all");
	assert.deepEqual(warnings, []);

	const free = intakeFromForm({ blocks: ["a"], freeText: "river bathymetry from space", perSource: "500", minCites: "many", period: "custom", yearFrom: "2015", yearTo: "2020" }, 2026);
	assert.equal(free.options.query, "river bathymetry from space");
	assert.equal(free.options.perSource, 50);
	assert.equal(free.options.filters?.yearFrom, 2015);
	assert.equal(free.options.filters?.yearTo, 2020);
	assert.equal(free.options.filters?.minCites, undefined);
	assert.equal(free.warnings.length, 2);
	assert.deepEqual(periodRange({ period: "all" }), {});
	assert.deepEqual(periodRange({ period: "5y" }, 2026), { yearFrom: 2022 });
	// Every listed journal ticked plus "other" = no filter at all.
	const none = intakeFromForm({ blocks: ["a"], journals: ["X", "Y"], journalsListed: ["X", "Y"], journalsOther: true });
	assert.equal(none.options.filters?.venues, undefined);
}

// ---- listings ----
{
	const runs = listSearchRuns(root);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].name, "2026-10-15_rivers");
	assert.equal(runs[0].included, 1);
	assert.equal(runs[0].dropped, 1);
	assert.equal(runs[0].onTarget, 1);
	assert.ok(runs[0].html);
	const candidates = searchCandidates(root, "2026-10-15_rivers", new Set(["doi:10.1000/abc"]));
	assert.deepEqual(candidates?.map((c) => [c.id, c.dropped, c.inLibrary, c.access]), [["10.1000/abc", false, true, "free"], ["arXiv:2401.00001v2", true, false, null]]);
	assert.equal(searchCandidates(root, "../x", new Set()), null);
	const sessions = listSessions(root);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].session, "web-2026-10-15-ab12");
	assert.equal(sessions[0].rounds.length, 2);
	assert.deepEqual(sessions[0].scope, ["paper"]);
}

// ---- job runner ----
{
	const runner = new JobRunner();
	const events: string[] = [];
	runner.subscribe((event) => events.push(event.type === "line" ? `line:${event.text}` : `job:${event.job.state}`));
	let release: () => void = () => {};
	const job = runner.start("search", "s", async ({ log, signal }) => {
		log("one");
		await new Promise<void>((resolve) => { release = resolve; signal.addEventListener("abort", () => resolve()); });
		return { ok: true };
	});
	assert.equal(job.state, "running");
	assert.throws(() => runner.start("search", "second", async () => null), JobBusyError);
	assert.ok(runner.cancel(job.id));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(runner.snapshot().current, null);
	assert.equal(runner.snapshot().history[0].state, "cancelled");
	assert.ok(events.includes("line:one"));
	assert.ok(events.includes("job:cancelled"));
	release();
}

// ---- the server ----
const provider: ModelProvider = {
	status: () => ({ kind: "endpoint", model: "stub-model", via: "stub", embeddings: "stub-embed", embeddingsVia: "stub", remote: false }),
	hasModel: () => true,
	generate: async () => "(river OR stream) AND (bathymetry OR depth)\n(river OR stream OR channel) AND (bathymetry OR depth OR water depth)\narxiv: (river) AND (depth)",
	wiring: () => ({ backend: { embed: async (texts) => texts.map(() => [0.1, 0.2]), generate: async () => "ok" }, explainModel: "stub-model", reviewModel: "stub-model" }),
};
const seen: string[] = [];
const server = await startWebServer({
	root,
	cwd: root,
	provider,
	token: "t0ken",
	deps: {
		runSearch: async (options) => {
			options.onWarn?.("source 'arxiv': 1 record(s)");
			options.onWarn?.("verified 1/1 records");
			seen.push(`search:${options.query}`);
			return {
				query: options.query, query_variants: null, generated: "2026-10-15T11:00:00Z", sources_used: ["arxiv"], per_source: 5,
				source_failures: null, sources_skipped: null, abstract_lookup_failures: null, arxiv_queries: null, openalex_queries: null, crossref_queries: null, semanticscholar_queries: null,
				code_sources_used: null, code_queries: null, author_scope: null, grouping: null, grouping_by_query: null, source_counts: null,
				flow: { identified: 1, junk_removed: 0, duplicates_removed: 0, screened: 1, no_abstract_removed: 0, excluded_by_filters: 0, included: 1 },
				access_counts: null, filters: null, sort: null, results: [], dropped: [],
			} as never;
		},
		writeSearch: () => {
			writeFileSync(join(root, "lit-search", "2026-10-15_stub.html"), "<html>stub</html>");
			return { htmlPath: join(root, "lit-search", "2026-10-15_stub.html"), jsonPath: join(root, "lit-search", "2026-10-15_stub.json") };
		},
		runSelection: async (options) => {
			seen.push(`selection:${options.identifiers.join(",")}:${options.mailto ?? "-"}`);
			options.onWarn?.("fetching 10.1000/abc (1/1)");
			return { results: [{ raw: "10.1000/abc", id: "10.1000/abc", kind: "doi", title: "River depth from space", known: true, status: "downloaded", detail: "ok", notes: [] }], papersDir: join(root, "lit-selection") };
		},
		matchLibrary: () => ({ matched: [], unmatched: [], papersDir: join(root, "lit-selection") }),
		checkEmbedModel: async () => ({ state: "ok" }),
		journalFacets: async () => ({ listed: [{ id: "S1", name: "Water Resources Research", count: 14 }, { id: "S2", name: "Remote Sensing", count: 11 }], otherCount: 30 }),
		journalScores: async () => new Map([["S1", 4.2]]),
		authorFacets: async (_query, _limit, scope) => { seen.push(`authors:${(scope.sourceIds ?? []).join(",")}`); return { listed: [{ id: "A1", name: "Carl J. Legleiter", count: 9 }], otherCount: 50 }; },
		authorMetrics: async () => new Map(),
	},
});
const base = `http://127.0.0.1:${server.port}`;
const auth = { cookie: "plr_token=t0ken" };
try {
	// 401 without the token; 403 with a foreign host; cookie after ?token=.
	assert.equal((await fetch(`${base}/api/state`)).status, 401);
	// fetch() overrides the Host header; a raw request carries the foreign one.
	const foreignHost = await new Promise<number>((resolve, reject) => {
		request({ host: "127.0.0.1", port: server.port, path: "/api/state", headers: { host: "evil.example:1", cookie: "plr_token=t0ken" } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		}).on("error", reject).end();
	});
	assert.equal(foreignHost, 403);
	const first = await fetch(`${base}/?token=t0ken`, { redirect: "manual" });
	assert.equal(first.status, 302);
	assert.match(first.headers.get("set-cookie") ?? "", /plr_token=t0ken; HttpOnly; SameSite=Strict; Path=\//);
	assert.equal((await fetch(`${base}/?token=wrong`, { redirect: "manual" })).status, 401);
	const page = await fetch(`${base}/`, { headers: auth });
	assert.equal(page.status, 200);
	assert.match(await page.text(), /pi-literature-review/);
	assert.equal((await fetch(`${base}/static/app.js`, { headers: auth })).status, 200);
	// Bearer header works too (curl, tests).
	const state = await (await fetch(`${base}/api/state`, { headers: { authorization: "Bearer t0ken" } })).json();
	assert.equal(state.provider.model, "stub-model");
	assert.equal(state.counts.runs, 1);
	assert.equal(state.root, root);
	// Path traversal and unknown names are 404; the saved report is served.
	assert.equal((await fetch(`${base}/files/lit-search/..%2F..%2Fpackage.json`, { headers: auth })).status, 404);
	assert.equal((await fetch(`${base}/files/lit-search/nope.html`, { headers: auth })).status, 404);
	assert.equal((await fetch(`${base}/files/other/x.html`, { headers: auth })).status, 404);
	const report = await fetch(`${base}/files/lit-search/2026-10-15_rivers.html`, { headers: auth });
	assert.equal(report.status, 200);
	assert.equal(report.headers.get("cache-control"), "no-store");
	assert.equal((await fetch(`${base}/pdf/missing.pdf`, { headers: auth })).status, 404);
	assert.equal((await fetch(`${base}/pdf/..%2Fx.pdf`, { headers: auth })).status, 404);
	// Listings.
	const runs = await (await fetch(`${base}/api/runs`, { headers: auth })).json();
	assert.equal(runs.runs[0].htmlUrl, "/files/lit-search/2026-10-15_rivers.html");
	assert.equal(runs.sessions[0].rounds, 2);
	const candidates = await (await fetch(`${base}/api/selection/candidates?run=2026-10-15_rivers`, { headers: auth })).json();
	assert.equal(candidates.candidates.length, 2);
	// Variants through the provider.
	const variants = await (await fetch(`${base}/api/search/variants`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ query: "(river) AND (bathymetry)" }) })).json();
	assert.deepEqual(variants.variants.map((v: { role: string }) => v.role), ["plus1", "plus2", "arxiv"]);
	// SSE: open the stream, start a search job, expect line and job frames.
	const stream = await fetch(`${base}/api/events`, { headers: auth });
	assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
	const reader = stream.body!.getReader();
	const decoder = new TextDecoder();
	let received = "";
	const readUntil = async (pattern: RegExp) => {
		for (let i = 0; i < 50 && !pattern.test(received); i++) {
			const { value, done } = await reader.read();
			if (done) break;
			received += decoder.decode(value, { stream: true });
		}
	};
	await readUntil(/event: snapshot/);
	const started = await fetch(`${base}/api/search/run`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ blocks: ["river", "bathymetry"], period: "all" }) });
	assert.equal(started.status, 202);
	const job = (await started.json()).job;
	assert.equal(job.kind, "search");
	await readUntil(/"state":"done"/);
	assert.match(received, /event: line\ndata: \{"type":"line","job":"search-1".*source 'arxiv': 1 record\(s\)/);
	assert.match(received, /event: line\ndata: .*verified 1\/1 records/);
	assert.match(received, /event: job\ndata: .*"state":"done".*"htmlUrl":"\/files\/lit-search\/2026-10-15_stub.html"/);
	assert.deepEqual(seen, ["search:(river) AND (bathymetry)"]);
	// A second job while one runs answers 409; cancel aborts the signal.
	let abortedSeen = false;
	const slow = startWebServer; // (same server; use runSelection stub that waits for abort)
	void slow;
	const selectionStarted = await fetch(`${base}/api/selection/run`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ identifiers: ["10.1000/abc"], confirmed: true, withoutUnpaywall: true }) });
	assert.equal(selectionStarted.status, 202);
	await readUntil(/selection-2.*"state":"done"/);
	assert.ok(seen.includes("selection:10.1000/abc:-"));
	// Missing confirmation / email are refused before any job starts.
	assert.equal((await fetch(`${base}/api/selection/run`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ identifiers: ["10.1000/abc"] }) })).status, 400);
	assert.equal((await fetch(`${base}/api/selection/run`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ identifiers: ["10.1000/abc"], confirmed: true }) })).status, 400);
	assert.equal((await fetch(`${base}/api/report`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ papers: [] }) })).status, 400);
	// Cancel: a report job whose stub waits on the signal.
	const cancelServer = await startWebServer({
		root, cwd: root, provider, token: "t2",
		deps: {
			matchLibrary: () => ({ matched: [], unmatched: [], papersDir: join(root, "lit-selection") }),
			checkEmbedModel: async () => ({ state: "ok" }),
			runReport: (options) => new Promise((_resolve, reject) => {
				// The browser chat writes its reports in English unless told
				// otherwise (the engine's own default prefers German).
				assert.equal(options.language, "English");
				options.signal?.addEventListener("abort", () => { abortedSeen = true; reject(new Error("aborted")); });
			}),
		},
	});
	try {
		const b2 = `http://127.0.0.1:${cancelServer.port}`;
		const h2 = { cookie: "plr_token=t2", "content-type": "application/json" };
		const rep = await fetch(`${b2}/api/report`, { method: "POST", headers: h2, body: JSON.stringify({ papers: ["x"], summary: "bullets" }) });
		assert.equal(rep.status, 202);
		assert.equal((await fetch(`${b2}/api/report`, { method: "POST", headers: h2, body: JSON.stringify({ papers: ["x"], summary: "bullets" }) })).status, 409);
		const cancelled = await (await fetch(`${b2}/api/jobs/cancel`, { method: "POST", headers: h2 })).json();
		assert.equal(cancelled.cancelled, true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(abortedSeen);
		const jobs = await (await fetch(`${b2}/api/jobs`, { headers: h2 })).json();
		assert.equal(jobs.current, null);
		assert.equal(jobs.history[0].state, "cancelled");
	} finally {
		await cancelServer.close();
	}
	// ---- the chat dialog over the routes ----
	const headers = { ...auth, "content-type": "application/json" };
	const dialogGet = async () => (await fetch(`${base}/api/dialog`, { headers: auth })).json();
	const dialogAnswer = async (body: Record<string, unknown>) => {
		const response = await fetch(`${base}/api/dialog/answer`, { method: "POST", headers, body: JSON.stringify(body) });
		return { status: response.status, body: await response.json() };
	};
	/** Effects run after the answer; wait until no lookup or model call is pending. */
	const settled = async () => {
		for (let i = 0; i < 100; i++) {
			const view = await dialogGet();
			if (!view.pending && !view.activeJob) return view;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("dialog did not settle");
	};
	let view = await dialogGet();
	assert.equal(view.step, "start");
	assert.equal(view.stage.stage, 1);
	assert.deepEqual(view.messages[0].chips.map((chip: { id: string }) => chip.id), ["search", "pdfChat", "pdfReport"]);
	assert.equal(view.messages[0].chips[1].disabled, true); // empty library
	// A typed topic asks the stub model; its plus1 row becomes the blocks.
	let answered = await dialogAnswer({ text: "river depth from satellites" });
	assert.equal(answered.status, 200);
	assert.equal(answered.body.pending, "asking the model for keyword blocks");
	view = await settled();
	assert.equal(view.step, "blocks");
	assert.deepEqual(view.messages[view.messages.length - 1].editor, ["river OR stream", "depth OR bathymetry"]); // base term first (capVariantBlocks)
	await dialogAnswer({ chip: "use", blocks: ["river", "bathymetry"] });
	view = await dialogGet();
	assert.equal(view.step, "code");
	await dialogAnswer({ chip: "no" });
	await dialogAnswer({ chip: "all" });
	view = await settled();
	assert.equal(view.step, "journals");
	assert.deepEqual(view.messages[view.messages.length - 1].chips.map((chip: { id: string }) => chip.id), ["all", "use"]);
	assert.match(view.messages[view.messages.length - 1].list.items[0].label, /Water Resources Research \(14\)/);
	await dialogAnswer({ chip: "use", toggles: ["S2"] });
	view = await settled();
	assert.equal(view.step, "authors");
	assert.ok(seen.includes("authors:S2"), "ticked journals narrow the author lookup");
	await dialogAnswer({ text: "all" });
	view = await dialogGet();
	assert.equal(view.step, "confirm");
	assert.match(view.messages[view.messages.length - 1].text, /Query: `\(river\) AND \(bathymetry\)`/);
	assert.match(view.messages[view.messages.length - 1].text, /Journals: Remote Sensing/);
	// Search: the dialog starts the job, the SSE stream carries dialog frames, the outcome moves on to the pick.
	received = "";
	await dialogAnswer({ chip: "search" });
	await readUntil(/event: dialog\ndata: .*"step":"pick"/);
	view = await dialogGet();
	assert.equal(view.step, "pick");
	assert.equal(view.stage.stage, 2);
	assert.equal(view.activeJob, null);
	const working = view.messages.find((message: { role: string }) => message.role === "working");
	assert.equal(working.jobState, "done");
	const fileCard = view.messages.find((message: { role: string }) => message.role === "card");
	assert.equal(fileCard.card.url, "/files/lit-search/2026-10-15_stub.html");
	assert.ok(seen.includes("search:(river) AND (bathymetry)"));
	// Answers while a job runs are refused with 409 (the slow report stub below shows it on another server).
	// Reveal: only the three data folders.
	assert.equal((await fetch(`${base}/api/reveal`, { method: "POST", headers, body: JSON.stringify({ stage: "bogus" }) })).status, 400);
	// Restart clears the conversation.
	const restarted = await (await fetch(`${base}/api/dialog/restart`, { method: "POST", headers })).json();
	assert.equal(restarted.step, "start");
	assert.equal(restarted.messages.length, 1);
	reader.cancel().catch(() => {});
} finally {
	await server.close();
	rmSync(root, { recursive: true, force: true });
}
console.log("web tests passed");
