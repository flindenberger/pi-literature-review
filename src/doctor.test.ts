import assert from "node:assert/strict";
import {
	checkEmbedModel,
	embedEndpoint,
	modelListed,
	ollamaPullRequest,
	ollamaTagsUrl,
	parsePullLine,
	pullEmbedModel,
	pullProgressLine,
} from "./doctor.ts";
import type { LlmConfig } from "./llm.ts";

const cfg: LlmConfig = {
	baseUrl: "http://127.0.0.1:11434/",
	api: "ollama",
	generateModel: "openscholar-8b",
	embedModel: "bge-m3",
};

// Request shapes: trailing slash stripped, pull streams.
assert.equal(ollamaTagsUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434/api/tags");
assert.deepEqual(ollamaPullRequest("http://h:1", "bge-m3"), {
	url: "http://h:1/api/pull",
	body: { model: "bge-m3", stream: true },
});

// Tag matching: implicit ":latest" both ways, explicit tags exact.
const tags = { models: [{ name: "bge-m3:latest" }, { name: "qwen3:8b" }, { model: "nomic-embed-text:latest" }] };
assert.equal(modelListed(tags, "bge-m3"), true);
assert.equal(modelListed(tags, "bge-m3:latest"), true);
assert.equal(modelListed(tags, "bge-m3:567m"), false);
assert.equal(modelListed(tags, "nomic-embed-text"), true, "model field accepted too");
assert.equal(modelListed(tags, "qwen3"), false, "qwen3 means qwen3:latest, not :8b");
assert.equal(modelListed({}, "bge-m3"), false);
assert.equal(modelListed(null, "bge-m3"), false);

// Pull stream lines.
assert.deepEqual(parsePullLine('{"status":"pulling manifest"}'), { status: "pulling manifest" });
assert.deepEqual(parsePullLine('{"status":"pulling abc","digest":"sha256:x","total":1200000000,"completed":516000000}'), {
	status: "pulling abc", total: 1200000000, completed: 516000000,
});
assert.deepEqual(parsePullLine('{"error":"pull model manifest: file does not exist"}'), {
	status: "", error: "pull model manifest: file does not exist",
});
assert.equal(parsePullLine(""), null);
assert.equal(parsePullLine("not json"), null);
assert.equal(pullProgressLine("bge-m3", { status: "pulling abc", total: 1200000000, completed: 516000000 }),
	"fetching bge-m3 -- 43% (516 MB / 1.2 GB)");
assert.equal(pullProgressLine("bge-m3", { status: "verifying sha256 digest" }), "fetching bge-m3 -- verifying sha256 digest");

// Endpoint resolution honours the per-role split.
assert.deepEqual(embedEndpoint(cfg), { api: "ollama", baseUrl: "http://127.0.0.1:11434/", model: "bge-m3" });
assert.deepEqual(embedEndpoint({ ...cfg, embedApi: "openai", embedBaseUrl: "http://127.0.0.1:9090" }),
	{ api: "openai", baseUrl: "http://127.0.0.1:9090", model: "bge-m3" });

// checkEmbedModel: the four states, never throws.
const jsonResponse = (body: unknown, status = 200) =>
	({ ok: status < 400, status, json: async () => body }) as unknown as Response;
{
	const seen: string[] = [];
	const okFetch = (async (url: string | URL | Request) => { seen.push(String(url)); return jsonResponse(tags); }) as typeof fetch;
	assert.deepEqual(await checkEmbedModel(cfg, okFetch), { state: "ok" });
	assert.deepEqual(seen, ["http://127.0.0.1:11434/api/tags"]);
	assert.deepEqual(await checkEmbedModel({ ...cfg, embedModel: "bge-m3:567m" }, okFetch),
		{ state: "missing", baseUrl: "http://127.0.0.1:11434/", model: "bge-m3:567m" });
	const downFetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
	assert.deepEqual(await checkEmbedModel(cfg, downFetch),
		{ state: "unreachable", baseUrl: "http://127.0.0.1:11434/", error: "connect ECONNREFUSED" });
	const httpFail = (async () => jsonResponse({}, 503)) as typeof fetch;
	assert.deepEqual(await checkEmbedModel(cfg, httpFail),
		{ state: "unreachable", baseUrl: "http://127.0.0.1:11434/", error: "HTTP 503" });
	let called = 0;
	const neverFetch = (async () => { called++; return jsonResponse(tags); }) as typeof fetch;
	assert.deepEqual(await checkEmbedModel({ ...cfg, api: "openai" }, neverFetch), { state: "not-ollama" });
	assert.deepEqual(await checkEmbedModel({ ...cfg, embedApi: "openai" }, neverFetch), { state: "not-ollama" });
	assert.equal(called, 0, "non-Ollama dialects are not probed");
}

// pullEmbedModel: streamed NDJSON -> deduplicated progress lines; error
// event throws; HTTP failure throws.
function streamResponse(chunks: string[], status = 200): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return { ok: status < 400, status, body } as unknown as Response;
}
{
	const lines: string[] = [];
	let posted: { url: string; body: string } | undefined;
	const pullFetch = (async (url: string | URL | Request, init?: RequestInit) => {
		posted = { url: String(url), body: String(init?.body) };
		// A line split across two chunks must still parse.
		return streamResponse([
			'{"status":"pulling manifest"}\n{"status":"pulling x","total":100,"comp',
			'leted":50}\n{"status":"pulling x","total":100,"completed":50}\n{"status":"success"}\n',
		]);
	}) as typeof fetch;
	await pullEmbedModel(cfg, (line) => lines.push(line), pullFetch);
	assert.equal(posted?.url, "http://127.0.0.1:11434/api/pull");
	assert.deepEqual(JSON.parse(posted?.body ?? "{}"), { model: "bge-m3", stream: true });
	assert.deepEqual(lines, [
		"fetching bge-m3 -- pulling manifest",
		"fetching bge-m3 -- 50% (0 kB / 0 kB)",
		"fetching bge-m3 -- success",
	]);
	const errFetch = (async () => streamResponse(['{"error":"no such model"}\n'])) as typeof fetch;
	await assert.rejects(() => pullEmbedModel(cfg, () => {}, errFetch), /no such model/);
	const httpFetch = (async () => streamResponse([], 404)) as typeof fetch;
	await assert.rejects(() => pullEmbedModel(cfg, () => {}, httpFetch), /HTTP 404/);
}

console.log("doctor.test.ts: all assertions passed");
