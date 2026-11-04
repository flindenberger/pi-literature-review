/**
 * Model provider for the web interface: where the writing model comes
 * from and how the synthesis engines reach it. Two implementations --
 * the endpoint provider here (Ollama, llama.cpp or any OpenAI-compatible
 * address from the llm config, the standalone way) and the pi session
 * provider in extensions/pi-model.ts (the model selected in the running
 * pi session). Embeddings always stay on the configured local backend;
 * only the writing model differs.
 *
 * A provider shapes queries and writes prose over retrieved passages;
 * nothing it returns ever becomes bibliographic data (the one inviolable
 * rule lives in the engines).
 */

import { configuredGenerateModel, llmConfig } from "./config.ts";
import { createBackend, type LlmBackend } from "./llm.ts";

export interface GenerateCall {
	system: string;
	user: string;
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	/** Without thinking whatever the setting (short helper calls). */
	noThinking?: boolean;
}

/** What the interface shows about the model in use. */
export interface ProviderStatus {
	/** "pi" = the running pi session, "endpoint" = a configured server. */
	kind: "pi" | "endpoint";
	/** Writing model name, or null when none is selected. */
	model: string | null;
	/** Short origin, e.g. "via pi" or "ollama at http://127.0.0.1:11434". */
	via: string;
	/** Embedding model name (always local / configured). */
	embeddings: string;
	/** Where the embedding model runs. */
	embeddingsVia: string;
	/** True when the writing model runs on a remote service (data leaves
	 * the machine) -- the interface discloses it. Null when unknown. */
	remote: boolean | null;
	/** Address of the writing model's server, null when unknown; the web
	 * interface probes local addresses so the page shows a server that is
	 * not running. */
	baseUrl: string | null;
	/** Address of the embedding server. */
	embeddingsBaseUrl: string | null;
}

export interface EngineWiring {
	backend: LlmBackend;
	/** Explain-genre model name (summaries, per-paper answers, chat). */
	explainModel: string;
	/** Review-genre model name (cross-paper answers, review synthesis). */
	reviewModel: string;
}

export interface ModelProvider {
	status(): ProviderStatus;
	/** One text-shaping completion on the writing model (query variants,
	 * topic suggestions). Throws when no model is available. */
	generate(call: GenerateCall): Promise<string>;
	/** True when generate() can be called at all. */
	hasModel(): boolean;
	/** Backend + model names for runRound / runReport / runChatReport. */
	wiring(): EngineWiring;
}

/** The configured llm backend as the provider (standalone way, and the
 * CLI): generation and embeddings from config.json / environment. */
export function endpointProvider(cfg = llmConfig()): ModelProvider {
	const backend = createBackend(cfg);
	const generateApi = cfg.generateApi ?? cfg.api;
	const generateBase = cfg.generateBaseUrl || cfg.baseUrl;
	const embedBase = cfg.embedBaseUrl || cfg.baseUrl;
	const local = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
	return {
		status: () => ({
			kind: "endpoint",
			model: cfg.generateModel,
			via: `${generateApi} at ${generateBase}`,
			embeddings: cfg.embedModel,
			embeddingsVia: `${cfg.embedApi ?? cfg.api} at ${embedBase}`,
			remote: !local(generateBase),
			baseUrl: generateBase || null,
			embeddingsBaseUrl: embedBase || null,
		}),
		hasModel: () => Boolean(cfg.generateModel),
		generate: async (call) => backend.generate(call.system, call.user, {
			temperature: call.temperature,
			maxTokens: call.maxTokens,
			noThinking: call.noThinking,
		}, call.signal),
		wiring: () => ({
			backend,
			explainModel: cfg.generateModel,
			reviewModel: configuredGenerateModel() || cfg.generateModel,
		}),
	};
}
