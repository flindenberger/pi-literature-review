/**
 * Offline tests for the LLM backend client: pure request builders and
 * response parsers for both wire dialects, and createBackend() with an
 * injected fetchJson (no network, no model, no server).
 */

import assert from "node:assert/strict";
process.env.PI_LITERATURE_REVIEW_THINKING = "off"; // the user config must not decide
import {
	createBackend,
	ollamaChatRequest,
	ollamaEmbedRequest,
	openaiChatRequest,
	openaiEmbedRequest,
	parseOllamaChatResponse,
	parseOllamaEmbedResponse,
	parseOpenaiChatResponse,
	parseOpenaiEmbedResponse,
	type LlmConfig,
} from "./llm.ts";

/* ---------------- request builders ---------------- */
{
	const embed = ollamaEmbedRequest("http://127.0.0.1:11434/", "nomic-embed-text", ["a", "b"]);
	assert.equal(embed.url, "http://127.0.0.1:11434/api/embed"); // trailing slash normalized
	assert.deepEqual(embed.body, { model: "nomic-embed-text", input: ["a", "b"] });

	const chat = ollamaChatRequest("http://host:1", "m", "SYS", "USER", {
		numCtx: 8192, temperature: 0.2, maxTokens: 16,
	});
	assert.equal(chat.url, "http://host:1/api/chat");
	assert.deepEqual(chat.body, {
		model: "m",
		messages: [
			{ role: "system", content: "SYS" },
			{ role: "user", content: "USER" },
		],
		stream: false,
		options: { num_ctx: 8192, temperature: 0.2, num_predict: 16 },
	});
	// No opts -> empty options object, nothing invented; in particular no
	// think field unless the caller sets one.
	assert.deepEqual(ollamaChatRequest("http://h", "m", "s", "u").body.options, {});
	assert.ok(!("think" in ollamaChatRequest("http://h", "m", "s", "u").body));
	// think rides top-level in the Ollama dialect (reasoning off for capped
	// helper calls like the query translation).
	assert.equal(ollamaChatRequest("http://h", "m", "s", "u", { think: false }).body.think, false);
	// Thinking setting: off -> think false, cap unchanged; on -> effort and
	// the output cap raised by the reasoning room.
	{
		const { withThinking, THINKING_TOKENS, openaiChatRequest: chat } = await import("./llm.ts");
		assert.deepEqual(withThinking({ maxTokens: 100 }, "off"), { maxTokens: 100, think: false, reasoning: undefined });
		assert.deepEqual(withThinking({ maxTokens: 100 }, "medium"), { maxTokens: 100 + THINKING_TOKENS.medium, think: true, reasoning: "medium" });
		assert.equal(withThinking({}, "high").maxTokens, undefined);
		// A local llama.cpp gets the template switch; a remote API only an effort when on.
		assert.deepEqual(chat("http://127.0.0.1:8080", "m", "s", "u", { think: false }).body.chat_template_kwargs, { enable_thinking: false });
		assert.deepEqual(chat("http://localhost:8080", "m", "s", "u", { think: true, reasoning: "low" }).body.chat_template_kwargs, { enable_thinking: true });
		const remoteOff = chat("https://api.example.com", "m", "s", "u", { think: false }).body;
		assert.ok(!("chat_template_kwargs" in remoteOff) && !("reasoning_effort" in remoteOff));
		assert.equal(chat("https://api.example.com", "m", "s", "u", { think: true, reasoning: "high" }).body.reasoning_effort, "high");
		assert.ok(!("chat_template_kwargs" in chat("http://h", "m", "s", "u").body));
	}
	{
		const { thinkingSetting } = await import("./config.ts");
		assert.equal(thinkingSetting({}, {}), "off");
		assert.equal(thinkingSetting({}, { thinking: "high" }), "high");
		assert.equal(thinkingSetting({ PI_LITERATURE_REVIEW_THINKING: "Low" }, { thinking: "high" }), "low");
		assert.equal(thinkingSetting({ PI_LITERATURE_REVIEW_THINKING: "max" }, {}), "off");
	}

	const oaiEmbed = openaiEmbedRequest("http://host:8080", "e", ["x"]);
	assert.equal(oaiEmbed.url, "http://host:8080/v1/embeddings");
	assert.deepEqual(oaiEmbed.body, { model: "e", input: ["x"] });

	const oaiChat = openaiChatRequest("http://host:8080", "m", "SYS", "USER", {
		numCtx: 8192, temperature: 0.1, maxTokens: 32,
	});
	assert.equal(oaiChat.url, "http://host:8080/v1/chat/completions");
	assert.equal(oaiChat.body.max_tokens, 32);
	assert.equal(oaiChat.body.temperature, 0.1);
	assert.equal("num_ctx" in oaiChat.body, false); // no such field in this dialect
	assert.equal("options" in oaiChat.body, false);
}

/* ---------------- response parsers: happy paths ---------------- */
{
	assert.deepEqual(
		parseOllamaEmbedResponse({ embeddings: [[1, 2], [3, 4]] }, 2),
		[[1, 2], [3, 4]],
	);
	assert.equal(parseOllamaChatResponse({ message: { content: "hi" } }), "hi");

	// OpenAI embeddings arrive with explicit indices; order is restored.
	assert.deepEqual(
		parseOpenaiEmbedResponse({
			data: [
				{ index: 1, embedding: [3, 4] },
				{ index: 0, embedding: [1, 2] },
			],
		}, 2),
		[[1, 2], [3, 4]],
	);
	assert.equal(
		parseOpenaiChatResponse({ choices: [{ message: { content: "hello" } }] }),
		"hello",
	);
}

/* ---------------- response parsers: honest failures ---------------- */
{
	assert.throws(() => parseOllamaEmbedResponse({}, 1), /api\/embed/);
	assert.throws(() => parseOllamaEmbedResponse({ embeddings: [[1]] }, 2), /expected 2/);
	assert.throws(() => parseOllamaEmbedResponse({ embeddings: [[]] }, 1), /api\/embed/);
	assert.throws(() => parseOllamaEmbedResponse({ embeddings: [["x"]] }, 1), /api\/embed/);
	assert.throws(() => parseOllamaChatResponse({ message: {} }), /api\/chat/);
	assert.throws(() => parseOpenaiEmbedResponse({ data: [] }, 1), /expected 1/);
	assert.throws(() => parseOpenaiEmbedResponse({ data: [{ index: 2, embedding: [1] }] }, 1), /embeddings/);
	assert.throws( // duplicate index must not silently drop a row
		() => parseOpenaiEmbedResponse({
			data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }],
		}, 2),
		/embeddings/,
	);
	assert.throws(() => parseOpenaiChatResponse({ choices: [] }), /chat\/completions/);
}

/* ---------------- createBackend with injected fetchJson ---------------- */
{
	const cfg: LlmConfig = {
		baseUrl: "http://127.0.0.1:11434",
		api: "ollama",
		generateModel: "gen-model",
		embedModel: "embed-model",
	};
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

	const backend = createBackend(cfg, async (url, body, signal) => {
		assert.ok(signal instanceof AbortSignal); // timeout signal is always attached
		calls.push({ url, body });
		if (url.endsWith("/api/embed")) return { embeddings: [[0.1, 0.2]] };
		return { message: { content: "prose [1]" } };
	});

	const vectors = await backend.embed(["chunk text"]);
	assert.deepEqual(vectors, [[0.1, 0.2]]);
	assert.equal(calls[0].url, "http://127.0.0.1:11434/api/embed");
	assert.equal((calls[0].body as { model?: string }).model, "embed-model");

	// Empty input never hits the network.
	assert.deepEqual(await backend.embed([]), []);
	assert.equal(calls.length, 1);

	const text = await backend.generate("SYS", "USER", { numCtx: 8192, model: "override" });
	assert.equal(text, "prose [1]");
	assert.equal(calls[1].url, "http://127.0.0.1:11434/api/chat");
	assert.equal((calls[1].body as { model?: string }).model, "override"); // per-call override wins
	const noOverride = await backend.generate("SYS", "USER");
	assert.equal(noOverride, "prose [1]");
	assert.equal((calls[2].body as { model?: string }).model, "gen-model");
}

/* ---------------- createBackend routes the openai dialect ---------------- */
{
	const cfg: LlmConfig = {
		baseUrl: "http://127.0.0.1:8080",
		api: "openai",
		generateModel: "gen",
		embedModel: "emb",
	};
	const urls: string[] = [];
	const backend = createBackend(cfg, async (url) => {
		urls.push(url);
		if (url.endsWith("/v1/embeddings")) return { data: [{ index: 0, embedding: [1] }] };
		return { choices: [{ message: { content: "ok" } }] };
	});
	await backend.embed(["x"]);
	assert.equal(await backend.generate("s", "u"), "ok");
	assert.deepEqual(urls, [
		"http://127.0.0.1:8080/v1/embeddings",
		"http://127.0.0.1:8080/v1/chat/completions",
	]);
}

/* ---------------- per-role backend split ---------------- */
{
	// Embeddings and generation may live on DIFFERENT servers (llama.cpp
	// friendly: one llama-server holds exactly one model). Split fields
	// win per role; unset roles ride the shared baseUrl/api.
	const cfg: LlmConfig = {
		baseUrl: "http://127.0.0.1:11434", api: "ollama",
		generateModel: "gen", embedModel: "emb",
		embedBaseUrl: "http://127.0.0.1:9090", embedApi: "openai",
	};
	const urls: string[] = [];
	const backend = createBackend(cfg, async (url) => {
		urls.push(url);
		if (url.endsWith("/v1/embeddings")) return { data: [{ index: 0, embedding: [1] }] };
		return { message: { content: "ok" } };
	});
	await backend.embed(["x"]);
	assert.equal(await backend.generate("s", "u"), "ok");
	assert.deepEqual(urls, [
		"http://127.0.0.1:9090/v1/embeddings", // embed: split openai backend
		"http://127.0.0.1:11434/api/chat", // generate: shared ollama backend
	]);
}

/* ---------------- bearer auth rides only with an apiKey ---------------- */
{
	// With apiKey: every request carries the Authorization header (opens
	// the openai dialect to remote APIs, e.g. api.openai.com embeddings).
	// Without: headers stay absent -- local requests are byte-identical.
	const seen: Array<Record<string, string> | undefined> = [];
	const cfg: LlmConfig = {
		baseUrl: "http://127.0.0.1:8080", api: "openai",
		generateModel: "g", embedModel: "e", apiKey: "sk-test",
	};
	const answer = async (url: string, _b: Record<string, unknown>, _s: AbortSignal, headers?: Record<string, string>) => {
		seen.push(headers);
		if (url.endsWith("/v1/embeddings")) return { data: [{ index: 0, embedding: [1] }] };
		return { choices: [{ message: { content: "ok" } }] };
	};
	const withKey = createBackend(cfg, answer);
	await withKey.embed(["x"]);
	await withKey.generate("s", "u");
	assert.deepEqual(seen[0], { authorization: "Bearer sk-test" });
	assert.deepEqual(seen[1], { authorization: "Bearer sk-test" });
	const withoutKey = createBackend({ ...cfg, apiKey: undefined }, answer);
	await withoutKey.embed(["x"]);
	assert.equal(seen[2], undefined);
}

/* ---------------- backend failures name the ROLE (2026-08-11) ---------------- */
{
	// A bare "no LLM server reachable" reads as nonsense to a user whose
	// CHAT model is visibly running in pi -- the wrapped message must name
	// the embedding/generation role, keep the server's own message, and
	// point at the fix and llm-check.
	const cfg: LlmConfig = {
		baseUrl: "http://127.0.0.1:11434", api: "ollama",
		generateModel: "g", embedModel: "e",
	};
	const backend = createBackend(cfg, async () => {
		throw new Error("no LLM server reachable at http://127.0.0.1:11434/api/embed -- is it running?");
	});
	await assert.rejects(() => backend.embed(["x"]), (error: Error) => {
		assert.match(error.message, /embedding model "e" is unavailable/);
		assert.match(error.message, /no LLM server reachable/); // server message kept
		assert.match(error.message, /not the LLM chat model selected in the pi agent, but a separate embedding model/);
		assert.match(error.message, /IP address in this message/);
		assert.match(error.message, /ollama pull e/);
		assert.match(error.message, /llama-server/); // vendor-neutral: both local routes named
		assert.match(error.message, /check permissions and licensing/);
		assert.match(error.message, /llm-check/);
		return true;
	});
	await assert.rejects(() => backend.generate("s", "u"), (error: Error) => {
		assert.match(error.message, /generation model "g" is unavailable/);
		assert.match(error.message, /not by the pi agent/);
		return true;
	});
	// A user cancellation is NOT a config problem and passes unchanged.
	const aborter = new AbortController();
	const cancelled = createBackend(cfg, async () => {
		aborter.abort();
		throw new Error("aborted mid-flight");
	});
	await assert.rejects(() => cancelled.embed(["x"], aborter.signal), /^Error: aborted mid-flight$/);
}

/* ---------------- LLM model on its own server, thinking per role ---------------- */
{
	const cfg: LlmConfig = {
		baseUrl: "http://127.0.0.1:11434", api: "ollama", generateModel: "gen-model", embedModel: "embed-model",
		chatModel: "chat-model", chatBaseUrl: "http://127.0.0.1:8080", chatApi: "openai",
	};
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const roles: string[] = [];
	const backend = createBackend(cfg, async (url, body) => {
		calls.push({ url, body });
		return url.includes("/v1/") ? { choices: [{ message: { content: "chat" } }] } : { message: { content: "gen" } };
	}, (role) => { roles.push(role); return role === "generation" ? "low" : "off"; });
	assert.equal(await backend.generate("S", "U", { model: "chat-model" }), "chat");
	assert.equal(calls[0].url, "http://127.0.0.1:8080/v1/chat/completions");
	assert.equal(await backend.generate("S", "U", { model: "gen-model", role: "generation", maxTokens: 100 }), "gen");
	assert.equal(calls[1].url, "http://127.0.0.1:11434/api/chat");
	assert.deepEqual(roles, ["llm", "generation"]);
	assert.equal((calls[1].body as { think?: boolean }).think, true);
	assert.equal((calls[0].body as { chat_template_kwargs?: { enable_thinking?: boolean } }).chat_template_kwargs?.enable_thinking, false);
}

/* ---------------- model lists ---------------- */
{
	const { modelListUrl, parseModelList } = await import("./llm.ts");
	assert.equal(modelListUrl("http://127.0.0.1:11434/", "ollama"), "http://127.0.0.1:11434/api/tags");
	assert.equal(modelListUrl("http://127.0.0.1:8080", "openai"), "http://127.0.0.1:8080/v1/models");
	assert.deepEqual(parseModelList({ models: [{ name: "qwen3:8b" }, { name: "bge-m3:latest" }, { name: "qwen3:8b" }] }), ["bge-m3:latest", "qwen3:8b"]);
	assert.deepEqual(parseModelList({ object: "list", data: [{ id: "unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL" }] }), ["unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL"]);
	assert.deepEqual(parseModelList(null), []);
}

console.log("llm.test.ts: all assertions passed");
