/**
 * Offline tests for the user-level config helpers: platform-specific config
 * paths (pure, injected platform/env/home) and the email plausibility
 * check. Storage IO is deliberately not exercised here -- it would write
 * into the developer's real config directory.
 */

import assert from "node:assert/strict";
import { chatModel, configPath, configuredGenerateModel, isPlausibleMailto, LLM_DEFAULTS, llmConfig } from "./config.ts";

/* ---------------- configPath ---------------- */
{
	assert.equal(
		configPath("linux", {}, "/home/user"),
		"/home/user/.config/pi-literature-review/config.json",
	);
	assert.equal(
		configPath("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/user"),
		"/xdg/pi-literature-review/config.json",
	);
	assert.equal(
		configPath("darwin", {}, "/Users/user"),
		"/Users/user/.config/pi-literature-review/config.json",
	);
	// Windows: APPDATA when set, the conventional fallback otherwise.
	// (join() uses the running platform's separator, so only the pieces are
	// asserted, not one exact separator style.)
	const win = configPath("win32", { APPDATA: "C:\\Users\\user\\AppData\\Roaming" }, "C:\\Users\\user");
	assert.ok(win.startsWith("C:\\Users\\user\\AppData\\Roaming"));
	assert.ok(win.includes("pi-literature-review"));
	assert.ok(win.endsWith("config.json"));
	const winFallback = configPath("win32", {}, "C:\\Users\\user");
	assert.ok(winFallback.includes("AppData"));
	assert.ok(!winFallback.includes(".config"));
}

/* ---------------- isPlausibleMailto ---------------- */
{
	assert.ok(isPlausibleMailto("name@example.org"));
	assert.ok(isPlausibleMailto("  first.last@sub.uni-muenchen.de  "));
	assert.ok(!isPlausibleMailto(""));
	assert.ok(!isPlausibleMailto("banana"));
	assert.ok(!isPlausibleMailto("name@"));
	assert.ok(!isPlausibleMailto("@example.org"));
	assert.ok(!isPlausibleMailto("name@nodot"));
	assert.ok(!isPlausibleMailto("two words@example.org"));
}

/* ---------------- llmConfig ---------------- */
{
	// Nothing configured: the documented defaults.
	assert.deepEqual(llmConfig({}, {}), LLM_DEFAULTS);

	// Stored config wins over defaults.
	assert.equal(llmConfig({}, { generateModel: "gemma3" }).generateModel, "gemma3");
	assert.equal(llmConfig({}, { api: "openai" }).api, "openai");

	// Environment wins over stored config.
	const env = {
		PI_LITERATURE_REVIEW_LLM_URL: "http://127.0.0.1:8080",
		PI_LITERATURE_REVIEW_LLM_API: "openai",
		PI_LITERATURE_REVIEW_LLM_MODEL: "env-model",
		PI_LITERATURE_REVIEW_EMBED_MODEL: "env-embed",
	};
	const resolved = llmConfig(env, {
		baseUrl: "http://stored", api: "ollama",
		generateModel: "stored-model", embedModel: "stored-embed",
	});
	assert.deepEqual(resolved, {
		baseUrl: "http://127.0.0.1:8080",
		api: "openai",
		generateModel: "env-model",
		embedModel: "env-embed",
	});

	// Blank env values fall through to the next source; an invalid api value
	// falls through instead of crashing (case-insensitive when valid).
	assert.equal(llmConfig({ PI_LITERATURE_REVIEW_LLM_MODEL: "  " }, { generateModel: "s" }).generateModel, "s");
	assert.equal(llmConfig({ PI_LITERATURE_REVIEW_LLM_API: "banana" }, { api: "openai" }).api, "openai");
	assert.equal(llmConfig({ PI_LITERATURE_REVIEW_LLM_API: "OpenAI" }, {}).api, "openai");
	assert.equal(llmConfig({}, { api: "banana" as "ollama" }).api, "ollama");
}

/* ---------------- chatModel ---------------- */
{
	// Environment beats stored config beats the resolved generateModel.
	assert.equal(chatModel({ PI_LITERATURE_REVIEW_CHAT_MODEL: "env-chat" }, { chatModel: "cfg-chat" }), "env-chat");
	assert.equal(chatModel({}, { chatModel: "cfg-chat", generateModel: "cfg-gen" }), "cfg-chat");
	assert.equal(chatModel({}, { generateModel: "cfg-gen" }), "cfg-gen");
	assert.equal(chatModel({}, {}), LLM_DEFAULTS.generateModel);
	// The generateModel fallback itself honors ITS environment variable.
	assert.equal(chatModel({ PI_LITERATURE_REVIEW_LLM_MODEL: "env-gen" }, {}), "env-gen");
	// Whitespace-only values fall through.
	assert.equal(chatModel({ PI_LITERATURE_REVIEW_CHAT_MODEL: "  " }, { chatModel: " cfg-chat " }), "cfg-chat");
}

/* ---------------- configuredGenerateModel ---------------- */
{
	// Explicit config only -- NO default fallback: with pi present the
	// adapter runs everything on the pi model unless the user opted into a
	// local generator (the openscholar setup, now opt-in).
	assert.equal(configuredGenerateModel({}, {}), "");
	assert.equal(configuredGenerateModel({}, { generateModel: "openscholar-8b" }), "openscholar-8b");
	assert.equal(configuredGenerateModel({ PI_LITERATURE_REVIEW_LLM_MODEL: "env-gen" }, { generateModel: "cfg" }), "env-gen");
	assert.equal(configuredGenerateModel({ PI_LITERATURE_REVIEW_LLM_MODEL: "  " }, {}), "");
}

/* ---------------- per-role backend split ---------------- */
{
	// All four split fields are optional and ABSENT when unset (the
	// deepEqual-to-defaults pin above depends on that); env beats stored.
	assert.equal("embedBaseUrl" in llmConfig({}, {}), false);
	assert.equal("generateApi" in llmConfig({}, {}), false);
	const split = llmConfig({}, {
		embedBaseUrl: "http://127.0.0.1:9090",
		embedApi: "openai",
		generateBaseUrl: "http://127.0.0.1:9091",
		generateApi: "openai",
	});
	assert.equal(split.embedBaseUrl, "http://127.0.0.1:9090");
	assert.equal(split.embedApi, "openai");
	assert.equal(split.generateBaseUrl, "http://127.0.0.1:9091");
	assert.equal(split.generateApi, "openai");
	assert.equal(
		llmConfig({ PI_LITERATURE_REVIEW_EMBED_URL: "http://env:1" }, { embedBaseUrl: "http://cfg:2" }).embedBaseUrl,
		"http://env:1",
	);
	assert.equal(llmConfig({ PI_LITERATURE_REVIEW_GENERATE_API: "banana" }, {}).generateApi, undefined);
}

/* ---------------- llm apiKey ---------------- */
{
	// Absent entirely when unset (llmConfig({},{}) stays deepEqual to the
	// defaults above); env beats stored config.
	assert.equal("apiKey" in llmConfig({}, {}), false);
	assert.equal(llmConfig({}, { apiKey: "sk-stored" }).apiKey, "sk-stored");
	assert.equal(llmConfig({ PI_LITERATURE_REVIEW_LLM_API_KEY: "sk-env" }, { apiKey: "sk-stored" }).apiKey, "sk-env");
}

console.log("config.test.ts: all assertions passed");
