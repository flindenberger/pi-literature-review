/**
 * Tiny user-level config -- two settings: the contact email for Unpaywall
 * lookups and the local LLM backend for the synthesis stage. The fetch
 * dialog asks while no email is configured and offers to store it here (the
 * user may also choose per-run entry, then nothing is persisted and the
 * dialog simply asks again next time). Stored as plain JSON, file mode
 * 0600, in the platform's standard config location:
 *
 *   Linux/macOS:  $XDG_CONFIG_HOME or ~/.config/pi-literature-review/config.json
 *   Windows:      %APPDATA%\pi-literature-review\config.json
 *
 * Deliberately NOT ~/.pi/agent (that is Pi's own config domain and rebranded
 * distributions rename it) and NOT the package folder (replaced on update).
 * The PI_LITERATURE_REVIEW_MAILTO environment variable always overrides the
 * stored value (see types.ts). The email is sent only to api.unpaywall.org
 * (and as polite-pool contact in the User-Agent); it never leaves the
 * machine otherwise.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { LlmConfig } from "./llm.ts";

/** Pure and injectable for tests; defaults describe the running machine. */
export function configPath(
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const base = platform === "win32"
		? env.APPDATA || join(home, "AppData", "Roaming")
		: env.XDG_CONFIG_HOME || join(home, ".config");
	return join(base, "pi-literature-review", "config.json");
}

/** Loose plausibility check -- catches typos, not RFC edge cases. */
export function isPlausibleMailto(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

interface StoredConfig {
	mailto?: string;
	/** Local LLM backend for the synthesis/chat stages; unset fields use
	 * defaults. chatModel is the paper-chat generator (see chatModel()). */
	llm?: Partial<LlmConfig> & { chatModel?: string };
}

let cache: StoredConfig | null = null;

function loadStoredConfig(): StoredConfig {
	if (cache !== null) return cache;
	try {
		cache = JSON.parse(readFileSync(configPath(), "utf8")) as StoredConfig;
	} catch {
		cache = {}; // no config yet (or unreadable) -- both mean "not decided"
	}
	return cache;
}

export function storedMailto(): string {
	return (loadStoredConfig().mailto ?? "").trim();
}

/** Persist the email; returns the config file path for the confirmation.
 * Mode 0600: only the owning account reads it (ignored on Windows, where
 * the user-profile ACL protects %APPDATA%). */
export function storeMailto(mailto: string): string {
	const path = configPath();
	const config: StoredConfig = { ...loadStoredConfig(), mailto: mailto.trim() };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	cache = config;
	return path;
}

/* ---------------- LLM backend (synthesis stage) ---------------- */

/**
 * Defaults describe the intended local setup: Ollama on its standard port,
 * OpenScholar-8B (imported as an Ollama model named "openscholar-8b") for
 * generation, nomic-embed-text for embeddings. Every value can be changed
 * in config.json ("llm" block) or per environment variable; a switch to
 * llama.cpp's llama-server is just baseUrl + api: "openai".
 */
export const LLM_DEFAULTS: LlmConfig = {
	baseUrl: "http://127.0.0.1:11434",
	api: "ollama",
	generateModel: "openscholar-8b",
	embedModel: "nomic-embed-text",
};

function normalizeApi(value: string | undefined): "ollama" | "openai" | undefined {
	const trimmed = (value ?? "").trim().toLowerCase();
	return trimmed === "ollama" || trimmed === "openai" ? trimmed : undefined;
}

function pick(...values: Array<string | undefined>): string {
	for (const value of values) {
		const trimmed = (value ?? "").trim();
		if (trimmed) return trimmed;
	}
	return "";
}

/**
 * Resolved LLM backend settings: environment variable wins, then the stored
 * config, then the default (same precedence as the mailto). Pure and
 * injectable for tests; defaults describe the running machine. An invalid
 * api value falls through to the next source rather than crashing -- the
 * server answering (or not) is the real gate.
 */
export function llmConfig(
	env: Record<string, string | undefined> = process.env,
	stored: Partial<LlmConfig> = loadStoredConfig().llm ?? {},
): LlmConfig {
	return {
		baseUrl: pick(env.PI_LITERATURE_REVIEW_LLM_URL, stored.baseUrl, LLM_DEFAULTS.baseUrl),
		api: normalizeApi(env.PI_LITERATURE_REVIEW_LLM_API) ?? normalizeApi(stored.api) ?? LLM_DEFAULTS.api,
		generateModel: pick(env.PI_LITERATURE_REVIEW_LLM_MODEL, stored.generateModel, LLM_DEFAULTS.generateModel),
		embedModel: pick(env.PI_LITERATURE_REVIEW_EMBED_MODEL, stored.embedModel, LLM_DEFAULTS.embedModel),
	};
}

/**
 * Generator model for the paper-chat stage (pi-literature-chat). Its own
 * slot because the two stages want different tones: OpenScholar-8B is
 * tuned for terse synthesis prose, while the chat wants an explanatory
 * instruct model (e.g. "llama3.1:8b-instruct" via `"llm": {"chatModel":
 * ...}` in config.json). Falls back to the resolved generateModel, so
 * nothing changes until the user opts in. Same precedence as everything
 * here: environment variable, then stored config, then the fallback.
 */
export function chatModel(
	env: Record<string, string | undefined> = process.env,
	stored: Partial<LlmConfig> & { chatModel?: string } = loadStoredConfig().llm ?? {},
): string {
	return pick(env.PI_LITERATURE_REVIEW_CHAT_MODEL, stored.chatModel, llmConfig(env, stored).generateModel);
}
