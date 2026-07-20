/**
 * Offline tests for the user-level config helpers: platform-specific config
 * paths (pure, injected platform/env/home) and the email plausibility
 * check. Storage IO is deliberately not exercised here -- it would write
 * into the developer's real config directory.
 */

import assert from "node:assert/strict";
import { askModel, configPath, isPlausibleMailto, LLM_DEFAULTS, llmConfig } from "./config.ts";

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

/* ---------------- askModel ---------------- */
{
	// Environment beats stored config beats the resolved generateModel.
	assert.equal(askModel({ PI_LITERATURE_REVIEW_ASK_MODEL: "env-chat" }, { askModel: "cfg-chat" }), "env-chat");
	assert.equal(askModel({}, { askModel: "cfg-chat", generateModel: "cfg-gen" }), "cfg-chat");
	assert.equal(askModel({}, { generateModel: "cfg-gen" }), "cfg-gen");
	assert.equal(askModel({}, {}), LLM_DEFAULTS.generateModel);
	// The generateModel fallback itself honors ITS environment variable.
	assert.equal(askModel({ PI_LITERATURE_REVIEW_LLM_MODEL: "env-gen" }, {}), "env-gen");
	// Whitespace-only values fall through.
	assert.equal(askModel({ PI_LITERATURE_REVIEW_ASK_MODEL: "  " }, { askModel: " cfg-chat " }), "cfg-chat");
}

console.log("config.test.ts: all assertions passed");
