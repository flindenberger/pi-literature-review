/**
 * Tiny user-level config: the contact email for Unpaywall lookups, two
 * optional API keys (GitHub, Semantic Scholar) and the LLM backend for the
 * synthesis stage. The selection dialog asks while no email is configured
 * and offers to store it here (the user may also choose per-run entry, then
 * nothing is persisted and the dialog simply asks again next time). Stored
 * as plain JSON, file mode 0600, in the platform's standard config
 * location:
 *
 *   Linux/macOS:  $XDG_CONFIG_HOME or ~/.config/pi-literature-review/config.json
 *   Windows:      %APPDATA%\pi-literature-review\config.json
 *
 * Deliberately NOT ~/.pi/agent (that is Pi's own config domain and rebranded
 * distributions rename it) and NOT the package folder (replaced on update).
 * The PI_LITERATURE_REVIEW_MAILTO environment variable always overrides the
 * stored value (see types.ts). Once set, the email goes with every API
 * request of the package (contact in the User-Agent; CrossRef, OpenAlex and
 * Unpaywall also get it as a parameter).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

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

export interface StoredConfig {
	mailto?: string;
	/** Optional GitHub token for the code-link lookup: raises the search
	 * rate limit from 10 to 30 requests/min. Never required. */
	githubToken?: string;
	/** Optional Semantic Scholar API key: the anonymous shared pool is
	 * heavily contended; a free key gives a dedicated 1 request/second. */
	s2ApiKey?: string;
	/** GitHub topics whose awesome lists the code-first "awesome-lists"
	 * source reads (default: remote-sensing, satellite-imagery,
	 * earth-observation -- the tool is otherwise domain-neutral). */
	codeListTopics?: string[];
	/** LLM backend for the synthesis stage; unset fields use defaults.
	 * chatModel is the paper-chat generator (see chatModel()). */
	llm?: Partial<LlmConfig> & { chatModel?: string };
	/** The user's PDF folders: read (recursively), never written to. */
	pdfFolders?: string[];
	/** The folder of the last download (preselected next time). */
	lastDownloadDir?: string;
	/** Folders the library read on its own (a lit-selection/ or loose PDFs
	 * where pi was started) that the user took out of the library. */
	ignoredFolders?: string[];
	/** Hidden reasoning ("thinking") for every model call of this package,
	 * inside pi and standalone alike; default off. */
	thinking?: ThinkingSetting;
}

/** The package's own thinking setting, independent of pi's. */
export type ThinkingSetting = "off" | "low" | "medium" | "high";
export const THINKING_SETTINGS: readonly ThinkingSetting[] = ["off", "low", "medium", "high"];

/** The thinking setting in effect: PI_LITERATURE_REVIEW_THINKING > config
 * > "off". Read on every model call, so a change applies at once. */
export function thinkingSetting(
	env: Record<string, string | undefined> = process.env,
	stored: StoredConfig = loadStoredConfig(),
): ThinkingSetting {
	const value = (env.PI_LITERATURE_REVIEW_THINKING ?? stored.thinking ?? "off").trim().toLowerCase();
	return (THINKING_SETTINGS as readonly string[]).includes(value) ? value as ThinkingSetting : "off";
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
	return updateStoredConfig({ mailto: mailto.trim() });
}

/**
 * Merge a patch into the stored config and persist it (same file, same
 * mode); the in-memory cache follows, so every later read sees the new
 * values without a restart. Keys set to undefined are removed; an "llm"
 * patch replaces the whole llm block. Returns the config file path.
 */
export function updateStoredConfig(patch: Partial<StoredConfig>): string {
	const path = configPath();
	const merged: StoredConfig = { ...loadStoredConfig(), ...patch };
	for (const key of Object.keys(merged) as Array<keyof StoredConfig>) {
		if (merged[key] === undefined) delete merged[key];
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	cache = merged;
	return path;
}

/** The stored config as written (keys included only as set/unset flags
 * where they are secrets -- see storedConfigView). */
export function storedConfigView(): {
	mailto: string;
	codeListTopics: string[] | undefined;
	thinking: ThinkingSetting;
	llm: Partial<LlmConfig> & { chatModel?: string };
	keys: { s2ApiKey: boolean; githubToken: boolean; llmApiKey: boolean };
} {
	const stored = loadStoredConfig();
	const { apiKey, ...llm } = stored.llm ?? {};
	return {
		mailto: (stored.mailto ?? "").trim(),
		codeListTopics: stored.codeListTopics,
		thinking: thinkingSetting({}, stored),
		llm,
		keys: { s2ApiKey: Boolean(stored.s2ApiKey), githubToken: Boolean(stored.githubToken), llmApiKey: Boolean(apiKey) },
	};
}

/**
 * GitHub token for the code-link enrichment, optional: the lookup works
 * unauthenticated (10 searches/min); a token raises that to 30/min.
 * Environment variable wins, then config.json {"githubToken": ...}; empty
 * string = unauthenticated. Same precedence as the mailto.
 */
export function githubToken(
	env: Record<string, string | undefined> = process.env,
	stored: StoredConfig = loadStoredConfig(),
): string {
	return pick(env.PI_LITERATURE_REVIEW_GITHUB_TOKEN, stored.githubToken);
}

/**
 * Semantic Scholar API key, optional: without one the client shares an
 * anonymous pool that is often saturated; a free key from
 * semanticscholar.org/product/api gives a dedicated 1 request/second. Same
 * precedence as the mailto/githubToken; empty string = anonymous.
 */
/** Default GitHub topics for the awesome-lists code source. */
export const DEFAULT_CODE_LIST_TOPICS = ["remote-sensing", "satellite-imagery", "earth-observation"];

/** Topics for the awesome-lists code source: env (comma list) > config >
 * default. Pure given its inputs. */
export function codeListTopics(
	env: Record<string, string | undefined> = process.env,
	stored: StoredConfig = loadStoredConfig(),
): string[] {
	const fromEnv = (env.PI_LITERATURE_REVIEW_CODE_LIST_TOPICS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
	if (fromEnv.length) return fromEnv;
	const fromConfig = (stored.codeListTopics ?? []).map((t) => String(t).trim()).filter(Boolean);
	return fromConfig.length ? fromConfig : [...DEFAULT_CODE_LIST_TOPICS];
}

export function s2ApiKey(
	env: Record<string, string | undefined> = process.env,
	stored: StoredConfig = loadStoredConfig(),
): string {
	return pick(env.PI_LITERATURE_REVIEW_S2_API_KEY, stored.s2ApiKey);
}

/* ---------------- LLM backend (synthesis stage) ---------------- */

/**
 * Defaults describe the zero-config local setup: Ollama on its standard
 * port, bge-m3 for embeddings (multilingual -- German questions over
 * English papers rank correctly, measured; the embedding-model doctor
 * offers to fetch it on the first synthesis call), OpenScholar-8B
 * (imported as an Ollama model named "openscholar-8b") as the CLI's
 * generator -- inside pi, generation runs on the model selected there.
 * Every value can be changed in config.json ("llm" block) or per
 * environment variable; a switch to llama.cpp's llama-server is just
 * baseUrl + api: "openai" (per role if wanted). Earlier installs used
 * nomic-embed-text; an index built with it re-embeds itself once.
 */
export const LLM_DEFAULTS: LlmConfig = {
	baseUrl: "http://127.0.0.1:11434",
	api: "ollama",
	generateModel: "openscholar-8b",
	embedModel: "bge-m3",
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
	// Optional fields are ABSENT when unset (not undefined): a bearer token
	// only for remote OpenAI-compatible backends (local, key-free servers
	// stay the first choice), and the per-role backend split (embeddings
	// and generation on different servers, e.g. two llama-server instances
	// holding one model each; unset roles ride the shared baseUrl/api).
	const apiKey = pick(env.PI_LITERATURE_REVIEW_LLM_API_KEY, stored.apiKey);
	const embedBaseUrl = pick(env.PI_LITERATURE_REVIEW_EMBED_URL, stored.embedBaseUrl);
	const embedApi = normalizeApi(env.PI_LITERATURE_REVIEW_EMBED_API) ?? normalizeApi(stored.embedApi);
	const generateBaseUrl = pick(env.PI_LITERATURE_REVIEW_GENERATE_URL, stored.generateBaseUrl);
	const generateApi = normalizeApi(env.PI_LITERATURE_REVIEW_GENERATE_API) ?? normalizeApi(stored.generateApi);
	return {
		baseUrl: pick(env.PI_LITERATURE_REVIEW_LLM_URL, stored.baseUrl, LLM_DEFAULTS.baseUrl),
		api: normalizeApi(env.PI_LITERATURE_REVIEW_LLM_API) ?? normalizeApi(stored.api) ?? LLM_DEFAULTS.api,
		generateModel: pick(env.PI_LITERATURE_REVIEW_LLM_MODEL, stored.generateModel, LLM_DEFAULTS.generateModel),
		embedModel: pick(env.PI_LITERATURE_REVIEW_EMBED_MODEL, stored.embedModel, LLM_DEFAULTS.embedModel),
		...(apiKey ? { apiKey } : {}),
		...(embedBaseUrl ? { embedBaseUrl } : {}),
		...(embedApi ? { embedApi } : {}),
		...(generateBaseUrl ? { generateBaseUrl } : {}),
		...(generateApi ? { generateApi } : {}),
	};
}

/**
 * The generator model the user EXPLICITLY configured (env or config.json),
 * or "" when none is set. The synthesis adapter uses this to decide where
 * review genres run: with pi present, everything defaults to the model
 * selected in pi; only an explicit generateModel entry routes review genres
 * to the local generator (e.g. a hand-imported openscholar-8b). The
 * LLM_DEFAULTS fallback stays for headless/CLI runs, which have no pi model
 * to fall back to.
 */
export function configuredGenerateModel(
	env: Record<string, string | undefined> = process.env,
	stored: Partial<LlmConfig> = loadStoredConfig().llm ?? {},
): string {
	return pick(env.PI_LITERATURE_REVIEW_LLM_MODEL, stored.generateModel);
}

/**
 * Generator model for the paper-chat mode (pi-literature-synthesis). Its own
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

/* ---------------- folders ---------------- */

/** The user's PDF folders as absolute paths, without duplicates.
 * PI_LITERATURE_REVIEW_PDF_FOLDERS (path-delimiter separated, ":" or ";")
 * replaces the stored list when set. */
export function pdfFolders(
	env: Record<string, string | undefined> = process.env,
	stored: StoredConfig = loadStoredConfig(),
): string[] {
	const fromEnv = env.PI_LITERATURE_REVIEW_PDF_FOLDERS;
	const list = fromEnv !== undefined
		? fromEnv.split(delimiter)
		: Array.isArray(stored.pdfFolders) ? stored.pdfFolders : [];
	return [...new Set(list.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => resolve(entry.trim())))];
}

/** Add a folder to the stored PDF folders (no-op when it is there). */
export function addPdfFolder(folder: string): string[] {
	const path = resolve(folder);
	const list = pdfFolders({}, loadStoredConfig());
	if (!list.includes(path)) updateStoredConfig({ pdfFolders: [...list, path] });
	// Added again by hand: no longer ignored.
	if (ignoredFolders().includes(path)) updateStoredConfig({ ignoredFolders: ignoredFolders().filter((entry) => entry !== path) });
	return pdfFolders({}, loadStoredConfig());
}

/** Take a folder out of the library; its files stay untouched. A PDF
 * folder leaves the list; a folder the library read on its own (legacy
 * places) is remembered as ignored. */
export function removePdfFolder(folder: string): string[] {
	const path = resolve(folder);
	const list = pdfFolders({}, loadStoredConfig());
	if (list.includes(path)) updateStoredConfig({ pdfFolders: list.filter((entry) => entry !== path) });
	else updateStoredConfig({ ignoredFolders: [...new Set([...ignoredFolders(), path])] });
	return pdfFolders({}, loadStoredConfig());
}

/** Folders taken out of the library that it would otherwise read on its own. */
export function ignoredFolders(stored: StoredConfig = loadStoredConfig()): string[] {
	return Array.isArray(stored.ignoredFolders) ? stored.ignoredFolders.filter((entry) => typeof entry === "string").map((entry) => resolve(entry)) : [];
}

/** Folder of the last download, "" when none was chosen yet. */
export function lastDownloadDir(stored: StoredConfig = loadStoredConfig()): string {
	return typeof stored.lastDownloadDir === "string" ? stored.lastDownloadDir.trim() : "";
}

/** Remember the download folder and make it a PDF folder (so chat and
 * reports see the downloads). Skipped while PDF folders come from the
 * environment (tests, scripted runs). */
export function rememberDownloadDir(folder: string, env: Record<string, string | undefined> = process.env): void {
	if (env.PI_LITERATURE_REVIEW_PDF_FOLDERS !== undefined) return;
	const path = resolve(folder);
	updateStoredConfig({ lastDownloadDir: path });
	addPdfFolder(path);
}
