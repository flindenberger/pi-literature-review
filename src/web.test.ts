/**
 * Offline tests of the web interface server: protection (token, cookie,
 * host header, path traversal), the SSE frames, job start/cancel and the
 * stage routes with stubbed engines. Port 0, a temporary data root, no
 * network. Run: node src/web.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider } from "./provider.ts";
import { intakeFromForm, periodRange } from "./web/intake.ts";
import { JobBusyError, JobRunner } from "./web/jobs.ts";
import { safeName, listSearchRuns, listSessions, searchCandidates } from "./web/files.ts";
import { hostAllowed, paperLabel, paperShortLabel, startWebServer, webSessionId } from "./web/server.ts";
import { sseFrame } from "./web/sse.ts";
import { parseWebArgs } from "../extensions/web.ts";
import { webPdfHref } from "./render.ts";

// A library paper in words, from its metadata only.
assert.equal(paperLabel({ base: "x", title: "Google Earth Engine", authors: ["Noel Gorelick", "Matt Hancher", "Mike Dixon"], year: "2017" }), "“Google Earth Engine” (Gorelick et al., 2017)");
assert.equal(paperLabel({ base: "x", title: "Two", authors: ["Ann Lee", "Bo Kim"], year: null }), "“Two” (Lee and Kim)");
assert.equal(paperLabel({ base: "2026_IAHR_Full_Issue", title: "", authors: [], year: null }), "this PDF");
assert.equal(paperShortLabel({ title: "Google Earth Engine", authors: ["Noel Gorelick", "Matt Hancher", "Mike Dixon"], year: "2017" }), "Gorelick et al. 2017 · Google Earth Engine");
assert.equal(paperShortLabel({ title: "", authors: [], year: null }), null);

const root = mkdtempSync(join(tmpdir(), "plr-web-"));
// Never the user's own config (contact email, PDF folders): a private one.
process.env.XDG_CONFIG_HOME = join(root, "config-home");
process.env.APPDATA = join(root, "config-home");
process.env.PI_LITERATURE_REVIEW_PDF_FOLDERS = "";
delete process.env.PI_LITERATURE_REVIEW_MAILTO;
const HIST = join(root, "history-store");
const BLOCKS = join(root, "keyword-blocks.json");
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
	// Searches run side by side up to the cap; a single kind (download) never twice.
	const hold = (signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
	const second = runner.start("search", "second", async ({ signal }) => hold(signal));
	const download = runner.start("selection", "download", async ({ signal }) => hold(signal));
	assert.equal(runner.snapshot().running.length, 3);
	assert.throws(() => runner.start("search", "fourth", async () => null), JobBusyError);
	assert.ok(runner.cancel(download.id));
	await new Promise((resolve) => setTimeout(resolve, 10));
	const again = runner.start("selection", "download again", async ({ signal }) => hold(signal));
	assert.throws(() => runner.start("selection", "parallel download", async () => null), JobBusyError);
	assert.ok(runner.cancel(job.id));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(runner.snapshot().history.find((info) => info.id === job.id)?.state, "cancelled");
	assert.ok(runner.cancel()); // no id: every running job
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(runner.snapshot().current, null);
	assert.equal(runner.isRunning(second.id) || runner.isRunning(again.id), false);
	assert.ok(events.includes("line:one"));
	assert.ok(events.includes("job:cancelled"));
	release();
}

// ---- the server ----
const provider: ModelProvider = {
	status: () => ({ kind: "endpoint", model: "stub-model", via: "stub", embeddings: "stub-embed", embeddingsVia: "stub", remote: false, baseUrl: "http://127.0.0.1:9", embeddingsBaseUrl: "http://127.0.0.1:11434" }),
	hasModel: () => true,
	generate: async () => "(river OR stream) AND (bathymetry OR depth)\n(river OR stream OR channel) AND (bathymetry OR depth OR water depth)\narxiv: (river) AND (depth)",
	wiring: () => ({ backend: { embed: async (texts) => texts.map(() => [0.1, 0.2]), generate: async () => "ok" }, explainModel: "stub-model", reviewModel: "stub-model" }),
};
const seen: string[] = [];
const server = await startWebServer({ historyDir: HIST, blockCacheFile: BLOCKS,
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
				access_counts: { free: 1, abstract_only: 0, restricted: 0, unknown: 0 }, filters: { yearFrom: 2017 }, sort: null,
				results: [{ title: "River depth from space", authors: ["Carl J. Legleiter"], year: "2021", venue: "Remote Sensing", doi: "10.1000/abc", arxiv_id: "", pdf_url: "", url: "https://doi.org/10.1000/abc", cites: 9, source: "arxiv", sources: ["arxiv"], abstract: "Depth.", access: { level: "free", oa_status: "gold", pdf_urls: ["https://x/abc.pdf"] }, verified: true, group: "on_target" }],
				dropped: [],
			} as never;
		},
		// Like the real writer: the JSON sidecar only; the HTML report is written on click.
		writeSearch: (payload) => {
			writeFileSync(join(root, "lit-search", "2026-10-15_stub.json"), JSON.stringify(payload));
			return { htmlPath: join(root, "lit-search", "2026-10-15_stub.html"), jsonPath: join(root, "lit-search", "2026-10-15_stub.json") };
		},
		runSelection: async (options) => {
			seen.push(`selection:${options.identifiers.join(",")}:${options.mailto ?? "-"}${options.dir ? `:${options.dir}` : ""}`);
			options.onWarn?.("fetching 10.1000/abc (1/1)");
			return { results: [{ raw: "10.1000/abc", id: "10.1000/abc", kind: "doi", title: "River depth from space", known: true, status: "downloaded", detail: "ok", notes: [] }], papersDir: join(root, "lit-selection") };
		},
		matchLibrary: () => ({ matched: [], unmatched: [], papersDir: join(root, "lit-selection") }),
		checkEmbedModel: async () => ({ state: "ok" }),
		// The model server (port 9) is down, the embedding server answers.
		probe: async (url) => !url.includes(":9"),
		journalFacets: async () => ({ listed: [{ id: "S1", name: "Water Resources Research", count: 14 }, { id: "S2", name: "Remote Sensing", count: 11 }], otherCount: 30 }),
		journalScores: async () => new Map([["S1", 4.2]]),
		authorFacets: async (_query, _limit, scope) => { seen.push(`authors:${(scope.sourceIds ?? []).join(",")}`); return { listed: [{ id: "A1", name: "Carl J. Legleiter", count: 9 }], otherCount: 50 }; },
		authorMetrics: async () => new Map(),
		pickFolder: async (title) => { seen.push(`pick:${title}`); return join(root, "Picked"); },
		canPickFolder: () => true,
		rememberDownloadDir: (folder) => { seen.push(`remember:${folder}`); },
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
	assert.equal(state.provider.modelReachable, false);
	assert.equal(state.provider.embeddingsReachable, true);
	assert.equal(state.counts.runs, 1);
	// Example questions: no chosen paper of the library -> null (templates stay).
	for (const body of [{ bases: [] }, { bases: ["no-such-paper"] }]) {
		const reply = await (await fetch(`${base}/api/chat/examples`, { method: "POST", headers: { authorization: "Bearer t0ken", "content-type": "application/json" }, body: JSON.stringify(body) })).json();
		assert.equal(reply.examples, null);
	}
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
	// A chosen download folder reaches the engine and is remembered.
	const downloadsDir = join(root, "My Papers");
	const intoFolder = await fetch(`${base}/api/selection/run`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ identifiers: ["10.1000/abc"], confirmed: true, withoutUnpaywall: true, folder: downloadsDir }) });
	assert.equal(intoFolder.status, 202);
	await readUntil(/selection-3.*"state":"done"/);
	assert.ok(seen.includes(`selection:10.1000/abc:-:${downloadsDir}`));
	assert.ok(seen.includes(`remember:${downloadsDir}`));
	assert.ok(existsSync(downloadsDir)); // created when missing
	assert.equal((await fetch(`${base}/api/selection/run`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ identifiers: ["10.1000/abc"], confirmed: true, withoutUnpaywall: true, folder: "relative/path" }) })).status, 400);
	// PDF folders: list, folder window (stub), add (folders only), remove.
	const folders = await (await fetch(`${base}/api/folders`, { headers: auth })).json();
	assert.deepEqual(folders.pdfFolders, []);
	assert.equal(folders.store, root);
	assert.equal(folders.canPick, true);
	const picked = await (await fetch(`${base}/api/folders/pick`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ purpose: "download" }) })).json();
	assert.equal(picked.path, join(root, "Picked"));
	assert.ok(seen.includes("pick:Where should the PDFs go?"));
	const folderOps = (op: string, path: string) => fetch(`${base}/api/folders/${op}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ path }) });
	assert.equal((await folderOps("add", join(root, "missing-folder"))).status, 400);
	assert.equal((await folderOps("add", "relative")).status, 400);
	delete process.env.PI_LITERATURE_REVIEW_PDF_FOLDERS; // the stored list (private test config)
	assert.deepEqual((await (await folderOps("add", downloadsDir)).json()).pdfFolders, [downloadsDir]);
	assert.deepEqual((await (await folderOps("remove", downloadsDir)).json()).pdfFolders, []);
	process.env.PI_LITERATURE_REVIEW_PDF_FOLDERS = "";
	// Reveal by path: only the user's own folders (and inside them).
	assert.equal((await fetch(`${base}/api/reveal`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ path: "/etc" }) })).status, 400);
	assert.equal((await fetch(`${base}/api/reveal`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ path: `${root}/../../etc` }) })).status, 400);
	// Drag and drop: a PDF goes to the inbox (safe name, kept once), a non-PDF
	// is refused; a new conversation can open a chat over exactly that PDF.
	const upload = (name: string, body: string) => fetch(`${base}/api/library/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...auth, "content-type": "application/pdf" }, body });
	const dropped = await (await upload("../My paper?.pdf", "%PDF-1.4 dropped")).json();
	assert.equal(dropped.base, "My paper");
	assert.equal(dropped.file, join(root, "inbox", "My paper.pdf"));
	assert.equal((await (await upload("../My paper?.pdf", "%PDF-1.4 dropped")).json()).base, "My paper"); // same file: once
	assert.equal((await (await upload("../My paper?.pdf", "%PDF-1.4 other")).json()).base, "My paper_2"); // same name, other file
	const sameBytes = await (await upload("Renamed copy.pdf", "%PDF-1.4 dropped")).json(); // same bytes, other name: the existing paper
	assert.equal(sameBytes.base, "My paper");
	assert.equal(sameBytes.existing, true);
	assert.equal(existsSync(join(root, "inbox", "Renamed copy.pdf")), false);
	assert.equal((await upload("notes.pdf", "hello")).status, 400);
	const chat = await (await fetch(`${base}/api/dialog/new`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ start: "synthesis", scope: ["My paper"] }) })).json();
	assert.equal(chat.step, "ask");
	assert.deepEqual(chat.answers.scope, ["My paper"]);
	await fetch(`${base}/api/dialog/new`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" }); // back to the start screen
	rmSync(join(root, "inbox"), { recursive: true, force: true });
	// Missing confirmation / email are refused before any job starts.
	assert.equal((await fetch(`${base}/api/selection/run`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ identifiers: ["10.1000/abc"] }) })).status, 400);
	assert.equal((await fetch(`${base}/api/selection/run`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ identifiers: ["10.1000/abc"], confirmed: true }) })).status, 400);
	assert.equal((await fetch(`${base}/api/report`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ papers: [] }) })).status, 400);
	// Cancel: a report job whose stub waits on the signal.
	const cancelServer = await startWebServer({ historyDir: HIST, blockCacheFile: BLOCKS,
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
		// A second report runs beside the first (several jobs at once).
		assert.equal((await fetch(`${b2}/api/report`, { method: "POST", headers: h2, body: JSON.stringify({ papers: ["x"], summary: "bullets" }) })).status, 202);
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
	// The proposal searches at once (stub search); the pick question follows, "Edit blocks" reopens the blocks.
	view = await settled();
	await readUntil(/"step":"pick"/);
	view = await dialogGet();
	assert.equal(view.step, "pick");
	await dialogAnswer({ chip: "goBlocks" });
	view = await dialogGet();
	assert.equal(view.step, "blocks");
	// Default without the synonym button: only the request's own words survive the code gate.
	assert.deepEqual(view.messages[view.messages.length - 1].editor, ["river", "depth"]);
	// Saved: the same request again gets the same blocks without a model call.
	assert.deepEqual(JSON.parse(readFileSync(BLOCKS, "utf8"))["own:river depth from satellites"], [{ role: "plus1", text: "(river) AND (depth)" }]);
	// The "+" menu's lists: the request's blocks first (the saved own-words blocks), a typed expression as typed.
	const blocksRoute = async (request: string) => (await fetch(`${base}/api/search/blocks`, { method: "POST", headers, body: JSON.stringify({ request }) })).json();
	assert.deepEqual(await blocksRoute("river depth from satellites"), { blocks: ["river", "depth"], query: "(river) AND (depth)", note: null });
	assert.deepEqual((await blocksRoute("(sandbar OR bar) AND (river)")).blocks, ["sandbar OR bar", "river"]);
	// Synonym mode for the menu: the model's plus1 row (base terms first, one synonym each).
	const synRoute = await (await fetch(`${base}/api/search/blocks`, { method: "POST", headers, body: JSON.stringify({ request: "river depth from satellites", mode: "synonyms" }) })).json();
	assert.deepEqual(synRoute.blocks, ["river OR stream", "depth OR bathymetry"]);
	// "More options" keeps the question chain for this route test; "use" would search at once.
	await dialogAnswer({ chip: "more", blocks: ["river", "bathymetry"] });
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
	assert.equal(view.stage.stage, 1);
	assert.equal(view.activeJob, null);
	const working = view.messages.find((message: { role: string }) => message.role === "working");
	assert.equal(working.jobState, "done");
	// The run stands as a results message; the cards come from the run's JSON.
	assert.equal(view.messages.some((message: { role: string }) => message.role === "card"), false);
	const resultsMessage = view.messages.find((message: { role: string }) => message.role === "results");
	assert.equal(resultsMessage.run, "2026-10-15_stub");
	assert.ok(seen.includes("search:(river) AND (bathymetry)"));
	const cards = await (await fetch(`${base}/api/runs/cards?name=2026-10-15_stub`, { headers: auth })).json();
	assert.equal(cards.rows.length, 1);
	assert.equal(cards.rows[0].id, "10.1000/abc");
	assert.equal(cards.rows[0].n, 1);
	assert.equal(cards.rows[0].access, "free");
	assert.equal(cards.rows[0].pdf, "https://x/abc.pdf");
	assert.equal(cards.yearFrom, 2017);
	assert.equal((await fetch(`${base}/api/runs/cards?name=nope`, { headers: auth })).status, 404);
	assert.equal(existsSync(join(root, "lit-search", "2026-10-15_stub.html")), false); // no report until asked
	// Reports from the list: the plain HTML report takes the run's own name; a filtered one gets its own pair and a card in the chat.
	const plain = await (await fetch(`${base}/api/runs/report`, { method: "POST", headers, body: JSON.stringify({ name: "2026-10-15_stub", kind: "html" }) })).json();
	assert.equal(plain.card.url, "/files/lit-search/2026-10-15_stub.html");
	assert.ok(existsSync(join(root, "lit-search", "2026-10-15_stub.html")));
	assert.ok(existsSync(join(root, "lit-search", "network.html")));
	const filteredReport = await (await fetch(`${base}/api/runs/report`, { method: "POST", headers, body: JSON.stringify({ name: "2026-10-15_stub", kind: "html", filters: { yearFrom: 2024, access: ["free"] } }) })).json();
	assert.equal(filteredReport.card.name, "2026-10-15_stub_filtered.html");
	assert.match(filteredReport.card.label, /list filters: published 2024 or later/);
	const filteredJson = JSON.parse(readFileSync(join(root, "lit-search", "2026-10-15_stub_filtered.json"), "utf8"));
	assert.equal(filteredJson.results.length, 0);
	assert.equal(filteredJson.dropped.length, 1);
	assert.match(filteredJson.dropped[0].reason, /^filtered: published 2021, before requested 2024/);
	assert.equal(filteredJson.flow.excluded_by_filters, 1);
	const filteredHtml = readFileSync(join(root, "lit-search", "2026-10-15_stub_filtered.html"), "utf8");
	assert.match(filteredHtml, /List filters/);
	const prisma = await (await fetch(`${base}/api/runs/report`, { method: "POST", headers, body: JSON.stringify({ name: "2026-10-15_stub", kind: "prisma" }) })).json();
	assert.equal(prisma.card.name, "2026-10-15_stub.prisma.svg");
	const svgResponse = await fetch(`${base}${prisma.card.url}`, { headers: auth });
	assert.equal(svgResponse.status, 200);
	assert.match(svgResponse.headers.get("content-type") ?? "", /image\/svg\+xml/);
	assert.match(await svgResponse.text(), /<svg/);
	view = await dialogGet();
	assert.deepEqual(view.messages.filter((message: { role: string }) => message.role === "card").map((message: { card: { name: string } }) => message.card.name), ["2026-10-15_stub.html", "2026-10-15_stub_filtered.html", "2026-10-15_stub.prisma.svg"]);
	assert.equal(view.step, "pick");
	// From the rail (History): the file is written, no card enters the open
	// conversation; the history entry names its run and which files exist.
	await fetch(`${base}/api/runs/report`, { method: "POST", headers, body: JSON.stringify({ name: "2026-10-15_stub", kind: "prisma", rail: true }) });
	assert.equal((await dialogGet()).messages.filter((message: { role: string }) => message.role === "card").length, 3);
	const railEntry = (await (await fetch(`${base}/api/history`, { headers: auth })).json()).history.find((entry: { current: boolean }) => entry.current);
	assert.equal(railEntry.run, "2026-10-15_stub");
	assert.deepEqual(railEntry.written, { html: true, prisma: true });
	// An older conversation from a working folder (before the store): its run
	// and report are still found there, in the one History list.
	{
		const oldRoot = join(root, "old-project");
		mkdirSync(join(oldRoot, "lit-search"), { recursive: true });
		writeFileSync(join(oldRoot, "lit-search", "2026-10-01_old.json"), JSON.stringify({ query: "(old)", generated: "2026-10-01T10:00:00Z", results: [{ title: "Old paper", year: "2020", doi: "10.1000/old", arxiv_id: "" }], dropped: [] }));
		writeFileSync(join(oldRoot, "lit-search", "2026-10-01_old.html"), "<html>old</html>");
		const { saveConversation } = await import("./web/history.ts");
		saveConversation(HIST, { version: 1, id: "2026-10-01T10-00-00_0001", started: "2026-10-01T10:00:00Z", updated: "2026-10-01T10:00:00Z", root: oldRoot, chatSession: "s", title: "Search: old", dialog: { step: "pick", answers: {}, messages: [{ id: 1, role: "results", run: "2026-10-01_old" }], activeJob: null, pending: null, trail: [], counter: 1 } as never });
		assert.equal((await fetch(`${base}/api/runs/cards?name=2026-10-01_old`, { headers: auth })).status, 200);
		assert.equal(await (await fetch(`${base}/files/lit-search/2026-10-01_old.html`, { headers: auth })).text(), "<html>old</html>");
		const old = (await (await fetch(`${base}/api/history`, { headers: auth })).json()).history.find((entry: { title: string }) => entry.title === "Search: old");
		assert.equal(old.run, "2026-10-01_old");
		assert.deepEqual(old.written, { html: true, prisma: false });
		rmSync(join(HIST, "2026-10-01T10-00-00_0001.json"));
	}
	// Answers while a job runs are refused with 409 (the slow report stub below shows it on another server).
	// Reveal: only the three data folders and the root ("bogus" is refused; "root" resolves to the data folder).
	assert.equal((await fetch(`${base}/api/reveal`, { method: "POST", headers, body: JSON.stringify({ stage: "bogus" }) })).status, 400);
	assert.equal((await fetch(`${base}/api/reveal`, { method: "POST", headers, body: JSON.stringify({ stage: "../" }) })).status, 400);
	// "+" archives the conversation in History and starts an empty one;
	// opening the entry brings it back and lists nothing (the empty one
	// has no typed text, so it is not kept).
	// The conversation was saved as a JSON file once it had a title; the list shows it as current.
	const listed = (await (await fetch(`${base}/api/history`, { headers: auth })).json());
	assert.equal(listed.dir, HIST);
	assert.equal(listed.skipped, 0);
	assert.deepEqual(listed.history.map((entry: { title: string; current: boolean; here: boolean }) => [entry.title, entry.current, entry.here]), [["Search: river depth from satellites", true, true]]);
	assert.equal(readdirSync(HIST).length, 1);
	assert.match(readdirSync(HIST)[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_[0-9a-f]{4}\.json$/);
	const fresh = await (await fetch(`${base}/api/dialog/new`, { method: "POST", headers })).json();
	assert.equal(fresh.step, "start");
	assert.equal(fresh.messages.length, 1);
	// "+ New search" starts the next conversation straight at the request question.
	const freshSearch = await (await fetch(`${base}/api/dialog/new`, { method: "POST", headers, body: JSON.stringify({ start: "search" }) })).json();
	assert.equal(freshSearch.step, "topic");
	assert.equal(freshSearch.messages.length, 1);
	assert.equal(freshSearch.messages[0].role, "assistant");
	const past = (await (await fetch(`${base}/api/history`, { headers: auth })).json()).history;
	assert.equal(past.length, 1);
	assert.equal(past[0].title, "Search: river depth from satellites");
	assert.equal(past[0].current, false);
	assert.ok(past[0].steps > 1);
	assert.equal((await fetch(`${base}/api/history/open`, { method: "POST", headers, body: JSON.stringify({ id: "nope" }) })).status, 404);
	const reopened = await (await fetch(`${base}/api/history/open`, { method: "POST", headers, body: JSON.stringify({ id: past[0].id }) })).json();
	assert.equal(reopened.step, view.step);
	assert.equal(reopened.messages.length, view.messages.length);
	// The continued conversation is the current entry; the empty one left behind was never saved.
	const again = (await (await fetch(`${base}/api/history`, { headers: auth })).json()).history;
	assert.deepEqual(again.map((entry: { id: string; current: boolean; started: string }) => [entry.id, entry.current, entry.started]), [[past[0].id, true, past[0].started]]);
	// Delete the current one: file gone, an empty conversation starts; clear reports the count.
	const removed = await (await fetch(`${base}/api/history/delete`, { method: "POST", headers, body: JSON.stringify({ id: past[0].id }) })).json();
	assert.equal(removed.deleted, true);
	assert.equal(removed.dialog.step, "start");
	assert.deepEqual(readdirSync(HIST), []);
	const cleared = await (await fetch(`${base}/api/history/clear`, { method: "POST", headers })).json();
	assert.equal(cleared.deleted, 0);
	// The question channel over the route: ask:true never moves the step; the stub model's text becomes a help message.
	const beforeAsk = await dialogGet();
	const asked = await dialogAnswer({ text: "can i change the keywords?", ask: true });
	assert.equal(asked.status, 200);
	assert.equal(asked.body.step, beforeAsk.step);
	assert.equal(asked.body.accepts, "text");
	await settled();
	const helped = await dialogGet();
	const helpMessage = helped.messages[helped.messages.length - 1];
	assert.equal(helpMessage.help, "model");
	assert.ok(helpMessage.chips.some((chip: { id: string }) => chip.id === "continue"));
	assert.equal(helped.step, beforeAsk.step);
	// Restart clears the conversation.
	const restarted = await (await fetch(`${base}/api/dialog/restart`, { method: "POST", headers })).json();
	assert.equal(restarted.step, "start");
	assert.equal(restarted.messages.length, 1);
	// Background jobs: a search keeps running when the user starts a new
	// conversation; its outcome lands in its own (parked) conversation,
	// which History marks as running until then.
	{
		const BG = join(root, "history-bg");
		const releases: Array<() => void> = [];
		const bgServer = await startWebServer({ historyDir: BG, blockCacheFile: BLOCKS, root, cwd: root, provider, token: "t3",
			deps: {
				matchLibrary: () => ({ matched: [], unmatched: [], papersDir: join(root, "lit-selection") }),
				runSearch: async (options) => {
					await new Promise<void>((resolve) => { releases.push(resolve); });
					return { query: options.query, query_variants: null, generated: "2026-11-01T10:00:00Z", sources_used: ["arxiv"], per_source: 5, source_failures: null, sources_skipped: null, abstract_lookup_failures: null, arxiv_queries: null, openalex_queries: null, crossref_queries: null, semanticscholar_queries: null, code_sources_used: null, code_queries: null, author_scope: null, grouping: null, grouping_by_query: null, source_counts: null, flow: null, access_counts: null, filters: {}, sort: null, results: [], dropped: [] } as never;
				},
				writeSearch: () => ({ htmlPath: join(root, "lit-search", "2026-11-01_bg.html"), jsonPath: join(root, "lit-search", "2026-11-01_bg.json") }),
			},
		});
		try {
			const b3 = `http://127.0.0.1:${bgServer.port}`;
			const h3 = { cookie: "plr_token=t3", "content-type": "application/json" };
			const post3 = async (path: string, body: unknown = {}) => (await fetch(`${b3}${path}`, { method: "POST", headers: h3, body: JSON.stringify(body) })).json();
			// Keys: written one at a time, read back only as set / not set.
			assert.deepEqual((await post3("/api/settings/key", { name: "githubToken", value: " ghp_test123 " })).keys.githubToken, true);
			assert.ok(!JSON.stringify(await (await fetch(`${b3}/api/settings`, { headers: h3 })).json()).includes("ghp_test123"), "the key never leaves the server");
			assert.equal((await post3("/api/settings/key", { name: "llmApiKey", value: "sk-1" })).keys.llmApiKey, true);
			assert.equal((await post3("/api/settings/key", { name: "llmApiKey", value: "" })).keys.llmApiKey, false);
			assert.equal((await post3("/api/settings/key", { name: "githubToken", value: "" })).keys.githubToken, false);
			assert.equal((await fetch(`${b3}/api/settings/key`, { method: "POST", headers: h3, body: JSON.stringify({ name: "mailto", value: "x" }) })).status, 400);
			await post3("/api/dialog/new", { start: "search" });
			const first = await post3("/api/dialog/answer", { text: "(waterline) AND (river)" });
			await new Promise((resolve) => setTimeout(resolve, 30));
			const running = await (await fetch(`${b3}/api/dialog`, { headers: h3 })).json();
			assert.ok(running.activeJob, "the search runs");
			void first;
			// A new search while it runs: no 409, the old conversation is parked and marked running.
			const second = await fetch(`${b3}/api/dialog/new`, { method: "POST", headers: h3, body: JSON.stringify({ start: "search" }) });
			assert.equal(second.status, 200);
			let list = (await (await fetch(`${b3}/api/history`, { headers: h3 })).json()).history;
			const parkedEntry = list.find((entry: { current: boolean }) => !entry.current);
			assert.equal(parkedEntry.running, true);
			// The new conversation can search at the same time.
			assert.equal((await fetch(`${b3}/api/dialog/answer`, { method: "POST", headers: h3, body: JSON.stringify({ text: "(sandbar) AND (sentinel)" }) })).status, 200);
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal((await (await fetch(`${b3}/api/jobs`, { headers: h3 })).json()).running.length, 2);
			// Both finish.
			for (const release of releases) release();
			await new Promise((resolve) => setTimeout(resolve, 50));
			list = (await (await fetch(`${b3}/api/history`, { headers: h3 })).json()).history;
			const done = list.find((entry: { id: string }) => entry.id === parkedEntry.id);
			assert.equal(done.running, false);
			// Reopened, it holds its own result list.
			const reopened = await post3("/api/history/open", { id: parkedEntry.id });
			assert.equal(reopened.step, "pick");
			assert.equal(reopened.activeJob, null);
			assert.ok(reopened.messages.some((message: { role: string }) => message.role === "results"));
			assert.equal(reopened.answers.topic, "(waterline) AND (river)");
		} finally {
			await bgServer.close();
		}
	}
	// Background indexing: a server started with backgroundIndex indexes
	// the library's PDFs without an index and reports the progress.
	{
		const ixRoot = join(root, "ix");
		const libDir = join(ixRoot, "pdfs");
		mkdirSync(libDir, { recursive: true });
		writeFileSync(join(libDir, "a.pdf"), "%PDF-1.4 a");
		writeFileSync(join(libDir, "b.pdf"), "%PDF-1.4 b");
		const match = { matched: [], unmatched: ["a.pdf", "b.pdf"], unmatchedByDir: [{ dir: libDir, files: ["a.pdf", "b.pdf"] }], papersDir: libDir, dirs: [libDir] };
		const indexedBases: string[] = [];
		let workFactCalls = 0;
		const elsewhere = join(ixRoot, "elsewhere");
		mkdirSync(join(elsewhere, "sub"), { recursive: true });
		writeFileSync(join(elsewhere, "x.pdf"), "%PDF-1.4 x");
		writeFileSync(join(elsewhere, "sub", "y.pdf"), "%PDF-1.4 y");
		writeFileSync(join(elsewhere, "notes.txt"), "no pdf");
		const ixServer = await startWebServer({ historyDir: join(ixRoot, "hist"), blockCacheFile: BLOCKS, root: ixRoot, cwd: ixRoot, provider, token: "t4", backgroundIndex: true,
			deps: {
				checkEmbedModel: async () => ({ state: "ok" }) as never,
				pickFiles: async () => [join(elsewhere, "x.pdf"), join(elsewhere, "notes.txt")],
				workFacts: async () => { workFactCalls++; return null; },
				matchLibrary: () => match as never,
				ensureLibrary: async () => match as never,
				ensureIndexed: async (papers, indexDir, embedModel) => {
					for (const paper of papers) {
						indexedBases.push(paper.base);
						mkdirSync(indexDir, { recursive: true });
						writeFileSync(join(indexDir, `${paper.base}.json`), JSON.stringify({ chunks: [{}, {}], embedding_model: embedModel, paper: { key: paper.key } }));
					}
					return { indexed: papers.length, failures: [] };
				},
			},
		});
		try {
			const h4 = { cookie: "plr_token=t4" };
			let lib: { indexing: { running: boolean; done: number; total: number }; papers: Array<{ base: string; index: unknown }> } | null = null;
			for (let i = 0; i < 60; i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				lib = await (await fetch(`http://127.0.0.1:${ixServer.port}/api/library`, { headers: h4 })).json();
				if (lib && !lib.indexing.running && lib.indexing.done === 2) break;
			}
			assert.deepEqual(indexedBases.sort(), ["a", "b"]);
			assert.equal(lib?.indexing.total, 2);
			assert.equal(lib?.indexing.done, 2);
			assert.ok(lib?.papers.every((paper) => paper.index !== null));
			// The info window: the library record; no DOI, so no OpenAlex lookup.
			const info = await (await fetch(`http://127.0.0.1:${ixServer.port}/api/paper?base=a`, { headers: h4 })).json();
			assert.equal(info.paper.base, "a");
			assert.equal(info.openalex, null);
			assert.equal(workFactCalls, 0);
			assert.equal((await fetch(`http://127.0.0.1:${ixServer.port}/api/paper?base=nope`, { headers: h4 })).status, 404);
			// An upload starts another pass; the indexed PDFs are not indexed again.
			const before = indexedBases.length;
			await fetch(`http://127.0.0.1:${ixServer.port}/api/library/upload?name=c.pdf`, { method: "POST", headers: { ...h4, "content-type": "application/pdf" }, body: "%PDF-1.4 c" });
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(indexedBases.length, before);
			// The upload button: the file window's PDFs, the folder question
			// (all files in one folder outside the library), then a copy of
			// exactly the chosen files into the inbox.
			const ixPost = async (path: string, body: unknown) => fetch(`http://127.0.0.1:${ixServer.port}${path}`, { method: "POST", headers: { ...h4, "content-type": "application/json" }, body: JSON.stringify(body) });
			const picked = await (await ixPost("/api/library/pick-files", {})).json();
			assert.deepEqual(picked.files.map((file: { base: string }) => file.base), ["x"]);
			assert.equal(picked.folder, elsewhere);
			assert.equal(picked.folderPdfs, 2);
			const imported = await (await ixPost("/api/library/import", { files: [join(elsewhere, "x.pdf")] })).json();
			assert.equal(imported.added[0].base, "x");
			assert.ok(existsSync(join(ixRoot, "inbox", "x.pdf")));
			// A file that was not chosen in the window is refused.
			assert.equal((await ixPost("/api/library/import", { files: [join(elsewhere, "sub", "y.pdf")] })).status, 400);
		} finally {
			await ixServer.close();
		}
	}
	reader.cancel().catch(() => {});
} finally {
	await server.close();
	rmSync(root, { recursive: true, force: true });
}
console.log("web tests passed");
