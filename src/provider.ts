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

import { chatModel, llmConfig, type ModelRole } from "./config.ts";
import { createBackend, type LlmBackend, type LlmConfig } from "./llm.ts";

export interface GenerateCall {
	system: string;
	user: string;
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	/** Without thinking whatever the setting (short helper calls). */
	noThinking?: boolean;
	/** The model role of the call (default the LLM); picks its thinking. */
	role?: ModelRole;
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
	/** Inside pi: the model selected in pi, and whether the browser
	 * follows it (false = the browser's own choice is in use). */
	piModel?: string | null;
	follows?: boolean;
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
	/** Inside pi: the models pi can use ("provider/id"), offered as the
	 * browser's own LLM choice. Absent for the endpoint provider. */
	choices?(): Array<{ id: string; label: string; local: boolean }>;
}

/** The configured llm backend as the provider (standalone way, and the
 * CLI): generation and embeddings from config.json / environment. */
export function endpointProvider(fixed?: LlmConfig): ModelProvider {
	// Read afresh on every use, so a change in the Settings applies to the
	// next call without a restart (a fixed config only in tests).
	const current = () => fixed ?? llmConfig();
	const local = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
	/** The LLM role: llm.chatModel on its own address, else generateModel. */
	const llm = (cfg: LlmConfig) => {
		const model = fixed ? cfg.chatModel || cfg.generateModel : chatModel();
		const onChat = Boolean(cfg.chatModel) && model === cfg.chatModel;
		const base = (onChat && cfg.chatBaseUrl) || cfg.generateBaseUrl || cfg.baseUrl;
		const api = (onChat && cfg.chatApi) || cfg.generateApi || cfg.api;
		return { model, base, api };
	};
	return {
		status: () => {
			const cfg = current();
			const role = llm(cfg);
			const embedBase = cfg.embedBaseUrl || cfg.baseUrl;
			return {
				kind: "endpoint",
				model: role.model,
				via: `${role.api} at ${role.base}`,
				embeddings: cfg.embedModel,
				embeddingsVia: `${cfg.embedApi ?? cfg.api} at ${embedBase}`,
				remote: !local(role.base),
				baseUrl: role.base || null,
				embeddingsBaseUrl: embedBase || null,
			};
		},
		hasModel: () => Boolean(llm(current()).model),
		generate: async (call) => {
			const cfg = current();
			return createBackend(cfg).generate(call.system, call.user, {
				model: llm(cfg).model,
				temperature: call.temperature,
				maxTokens: call.maxTokens,
				noThinking: call.noThinking,
			}, call.signal);
		},
		wiring: () => {
			const cfg = current();
			return { backend: createBackend(cfg), explainModel: llm(cfg).model, reviewModel: cfg.generateModel };
		},
	};
}
