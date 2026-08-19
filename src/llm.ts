/**
 * Minimal HTTP client for the embedding / generation backend -- the place
 * in the package that talks to a language-model server (the pi adapter
 * additionally routes generation to the model selected in pi). Used by the
 * synthesis stage for two operations: embedding text chunks and generating
 * prose. Two wire dialects are supported, selected by config:
 *
 *   "ollama"  Ollama's native API      POST /api/embed, /api/chat
 *   "openai"  OpenAI-compatible JSON   POST /v1/embeddings, /v1/chat/completions
 *             (the de-facto standard format that llama.cpp's llama-server
 *             and most other local servers implement -- nothing is sent to
 *             OpenAI; the base URL always points at the user's machine)
 *
 * Design rules, matching the rest of the package:
 *  - request builders and response parsers are pure functions, exported for
 *    offline tests; the network step is an injectable fetchJson
 *  - honest failures: unreachable server / bad response shapes throw with a
 *    message naming the URL, never return fabricated data
 *  - AbortSignal is threaded into every request and combined with a hard
 *    timeout (generation on a local 8B model is legitimately slow, so its
 *    timeout is generous)
 *
 * THE ONE INVIOLABLE RULE lives one layer above: whatever generate()
 * returns is untrusted prose -- citation enforcement in synthesis.ts only
 * ever accepts bracketed chunk numbers from it, never bibliographic text.
 */

export interface LlmConfig {
	/** Server base URL without trailing slash, e.g. http://127.0.0.1:11434 */
	baseUrl: string;
	api: "ollama" | "openai";
	/** Model that writes the synthesis prose. */
	generateModel: string;
	/** Model that turns text into embedding vectors. */
	embedModel: string;
	/**
	 * Optional bearer token, sent as "Authorization: Bearer <key>" when set:
	 * opens the openai dialect to REMOTE OpenAI-compatible APIs (e.g.
	 * api.openai.com embeddings), so synthesis can run without any local
	 * server. Local servers ignore it. Local stays the default and the
	 * documented first choice -- with an API backend the paper text leaves
	 * the machine, which the README discloses.
	 */
	apiKey?: string;
	/**
	 * Optional per-role backend split: embeddings and generation may live
	 * on DIFFERENT servers -- e.g. two llama.cpp llama-server instances
	 * (one embedding GGUF, one chat GGUF; a llama-server holds exactly one
	 * model), or embeddings on Ollama plus generation elsewhere. Unset
	 * fields fall back to the shared baseUrl/api, so an all-Ollama setup
	 * needs nothing new.
	 */
	embedBaseUrl?: string;
	embedApi?: "ollama" | "openai";
	generateBaseUrl?: string;
	generateApi?: "ollama" | "openai";
}

export interface GenerateOptions {
	model?: string;
	/**
	 * Context window in tokens. Ollama silently defaults to ~4k regardless
	 * of the model card, so the caller must set this explicitly. The OpenAI
	 * dialect has no such field (llama-server fixes the context at startup
	 * via -c); it is ignored there.
	 */
	numCtx?: number;
	temperature?: number;
	/** Cap on generated tokens (Ollama num_predict / OpenAI max_tokens). */
	maxTokens?: number;
	/**
	 * Ollama dialect only: turn hidden reasoning on/off (top-level "think"
	 * field; models without a thinking mode accept and ignore it). Needed
	 * because a thinking model otherwise spends a capped call's entire
	 * budget on reasoning and returns empty content. The OpenAI dialect
	 * ignores it: thinking control lives in the server/provider config
	 * there (pi's models.json thinkingFormat).
	 */
	think?: boolean;
}

export interface LlmBackend {
	/** Human-readable origin for reports (e.g. "ollama at http://..." or
	 * "the model selected in pi"); engines fall back to their config line. */
	label?: string;
	embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
	generate(system: string, user: string, opts?: GenerateOptions, signal?: AbortSignal): Promise<string>;
}

export const EMBED_TIMEOUT_MS = 60_000;
/** A long prompt on a local 8B model can take minutes; be generous. */
export const GENERATE_TIMEOUT_MS = 600_000;

export interface JsonRequest {
	url: string;
	body: Record<string, unknown>;
}

/* ---------------- pure request builders / response parsers ---------------- */

function base(url: string): string {
	return url.replace(/\/+$/, "");
}

export function ollamaEmbedRequest(baseUrl: string, model: string, texts: string[]): JsonRequest {
	return { url: `${base(baseUrl)}/api/embed`, body: { model, input: texts } };
}

export function parseOllamaEmbedResponse(json: unknown, expected: number): number[][] {
	const embeddings = (json as { embeddings?: unknown })?.embeddings;
	if (!Array.isArray(embeddings) || embeddings.length !== expected
		|| !embeddings.every((v) => Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "number"))) {
		throw new Error(`unexpected /api/embed response shape (expected ${expected} embeddings)`);
	}
	return embeddings as number[][];
}

export function ollamaChatRequest(
	baseUrl: string,
	model: string,
	system: string,
	user: string,
	opts: GenerateOptions = {},
): JsonRequest {
	const options: Record<string, unknown> = {};
	if (opts.numCtx !== undefined) options.num_ctx = opts.numCtx;
	if (opts.temperature !== undefined) options.temperature = opts.temperature;
	if (opts.maxTokens !== undefined) options.num_predict = opts.maxTokens;
	const body: Record<string, unknown> = {
		model,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		stream: false,
		options,
	};
	if (opts.think !== undefined) body.think = opts.think;
	return { url: `${base(baseUrl)}/api/chat`, body };
}

export function parseOllamaChatResponse(json: unknown): string {
	const content = (json as { message?: { content?: unknown } })?.message?.content;
	if (typeof content !== "string") throw new Error("unexpected /api/chat response shape");
	return content;
}

export function openaiEmbedRequest(baseUrl: string, model: string, texts: string[]): JsonRequest {
	return { url: `${base(baseUrl)}/v1/embeddings`, body: { model, input: texts } };
}

export function parseOpenaiEmbedResponse(json: unknown, expected: number): number[][] {
	const data = (json as { data?: unknown })?.data;
	if (!Array.isArray(data) || data.length !== expected) {
		throw new Error(`unexpected /v1/embeddings response shape (expected ${expected} embeddings)`);
	}
	const rows: number[][] = new Array(expected);
	for (const item of data) {
		const { index, embedding } = (item ?? {}) as { index?: unknown; embedding?: unknown };
		if (typeof index !== "number" || index < 0 || index >= expected || rows[index] !== undefined
			|| !Array.isArray(embedding) || embedding.length === 0
			|| !embedding.every((n) => typeof n === "number")) {
			throw new Error("unexpected /v1/embeddings response shape");
		}
		rows[index] = embedding as number[];
	}
	return rows;
}

export function openaiChatRequest(
	baseUrl: string,
	model: string,
	system: string,
	user: string,
	opts: GenerateOptions = {},
): JsonRequest {
	const body: Record<string, unknown> = {
		model,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		stream: false,
	};
	if (opts.temperature !== undefined) body.temperature = opts.temperature;
	if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
	// numCtx intentionally ignored: no field for it in this dialect.
	return { url: `${base(baseUrl)}/v1/chat/completions`, body };
}

export function parseOpenaiChatResponse(json: unknown): string {
	const choices = (json as { choices?: unknown })?.choices;
	const content = Array.isArray(choices)
		? (choices[0] as { message?: { content?: unknown } })?.message?.content
		: undefined;
	if (typeof content !== "string") throw new Error("unexpected /v1/chat/completions response shape");
	return content;
}

/* ---------------- backend ---------------- */

export type FetchJson = (
	url: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
	headers?: Record<string, string>,
) => Promise<unknown>;

/** Default network step; separated so tests can inject a fake. */
async function fetchJsonHttp(
	url: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
	headers?: Record<string, string>,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		if (signal.aborted) throw error; // cancellation/timeout: report as-is
		// Role-neutral on purpose: createBackend wraps this with the role
		// ("embedding model ... unavailable") -- a bare "LLM server" here
		// misleads users whose chat LLM is visibly running in pi.
		throw new Error(`no server reachable at ${url} -- is it running?`, { cause: error });
	}
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 300);
		throw new Error(`LLM server at ${url} answered ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	return response.json();
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function createBackend(cfg: LlmConfig, fetchJson: FetchJson = fetchJsonHttp): LlmBackend {
	// Per-role backend resolution: split fields win, else the shared pair.
	const embedOpenai = (cfg.embedApi ?? cfg.api) === "openai";
	const embedBase = cfg.embedBaseUrl || cfg.baseUrl;
	const generateOpenai = (cfg.generateApi ?? cfg.api) === "openai";
	const generateBase = cfg.generateBaseUrl || cfg.baseUrl;
	// Bearer auth: set only when the user configured an apiKey -- requests
	// to local servers stay byte-identical without one.
	const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined;
	// Role-specific failure framing: a bare "no LLM server reachable" reads
	// as nonsense to someone whose CHAT model is visibly running in pi --
	// the embedding model is a SEPARATE small model on a separate backend,
	// and only the error message can teach that at the moment it matters.
	// User cancellations pass unchanged.
	const failure = (role: "embedding" | "generation", model: string, error: unknown): Error => {
		const message = error instanceof Error ? error.message : String(error);
		const fix = role === "embedding"
			? ` This is not the LLM chat model selected in the pi agent, but a separate embedding model; the IP address in this message is where the llm config points (nothing configured = the local default). Equal options to run one: llama.cpp's llama-server serving an embedding GGUF (--embedding); or Ollama (ollama.com) with \`ollama pull ${model}\`; or a remote OpenAI-compatible API via llm.apiKey (paper content will be submitted to the external provider -- please check permissions and licensing). See the README's Configuration section.`
			: ` This model is served by the configured backend, not by the pi agent.`;
		return new Error(
			`the ${role} model "${model}" is unavailable: ${message} --${fix} Diagnose with \`node src/cli.ts llm-check\` (prints config path and backend).`,
			{ cause: error },
		);
	};
	return {
		async embed(texts, signal) {
			if (!texts.length) return [];
			const request = embedOpenai
				? openaiEmbedRequest(embedBase, cfg.embedModel, texts)
				: ollamaEmbedRequest(embedBase, cfg.embedModel, texts);
			let json: unknown;
			try {
				json = await fetchJson(request.url, request.body, combinedSignal(EMBED_TIMEOUT_MS, signal), headers);
			} catch (error) {
				if (signal?.aborted) throw error;
				throw failure("embedding", cfg.embedModel, error);
			}
			return embedOpenai
				? parseOpenaiEmbedResponse(json, texts.length)
				: parseOllamaEmbedResponse(json, texts.length);
		},
		async generate(system, user, opts = {}, signal) {
			const model = opts.model || cfg.generateModel;
			const request = generateOpenai
				? openaiChatRequest(generateBase, model, system, user, opts)
				: ollamaChatRequest(generateBase, model, system, user, opts);
			let json: unknown;
			try {
				json = await fetchJson(request.url, request.body, combinedSignal(GENERATE_TIMEOUT_MS, signal), headers);
			} catch (error) {
				if (signal?.aborted) throw error;
				throw failure("generation", model, error);
			}
			return generateOpenai ? parseOpenaiChatResponse(json) : parseOllamaChatResponse(json);
		},
	};
}
