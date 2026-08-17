/**
 * Embedding-model doctor: the zero-config path for the synthesis stage.
 *
 * Search and selection need no model at all; synthesis needs one small
 * LOCAL embedding model, and that is the one thing a fresh install cannot
 * bring along (pi's model API is completion-only). Instead of sending the
 * user to a README paragraph ("install Ollama, pull bge-m3, edit
 * config.json"), the first synthesis call CHECKS -- is the embedding
 * backend reachable, is the configured model present? -- and, when the
 * backend is Ollama, can FETCH the model on request with visible progress.
 * llama.cpp has no pull API (a GGUF is downloaded by hand and served with
 * `llama-server --embedding`), so for that dialect and for remote APIs the
 * doctor only reports; the dialog names the options side by side.
 *
 * Pure parts (tag matching, NDJSON progress lines, the request shapes) are
 * separated from the two HTTP calls so the adapter's dialog and the tests
 * share exactly one logic. No model is involved anywhere here.
 */

import type { LlmConfig } from "./llm.ts";

/** Ollama's model list endpoint. */
export function ollamaTagsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/api/tags`;
}

/** Ollama's pull endpoint + body (streamed NDJSON progress). */
export function ollamaPullRequest(baseUrl: string, model: string): { url: string; body: Record<string, unknown> } {
	return { url: `${baseUrl.replace(/\/+$/, "")}/api/pull`, body: { model, stream: true } };
}

/** True when the /api/tags listing contains the model. Ollama names models
 * "<name>:<tag>" and defaults the tag to "latest", so a configured "bge-m3"
 * matches "bge-m3:latest" (and an explicit "bge-m3:567m" only itself). */
export function modelListed(tagsJson: unknown, model: string): boolean {
	const models = (tagsJson as { models?: unknown })?.models;
	if (!Array.isArray(models)) return false;
	const wanted = model.includes(":") ? model : `${model}:latest`;
	return models.some((entry) => {
		const name = (entry as { name?: unknown; model?: unknown })?.name
			?? (entry as { model?: unknown })?.model;
		if (typeof name !== "string") return false;
		const full = name.includes(":") ? name : `${name}:latest`;
		return full === wanted;
	});
}

export interface PullEvent {
	status: string;
	completed?: number;
	total?: number;
	error?: string;
}

/** One NDJSON line of the pull stream -> event; malformed lines are null. */
export function parsePullLine(line: string): PullEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let json: unknown;
	try {
		json = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!json || typeof json !== "object") return null;
	const record = json as Record<string, unknown>;
	const event: PullEvent = { status: typeof record.status === "string" ? record.status : "" };
	if (typeof record.completed === "number") event.completed = record.completed;
	if (typeof record.total === "number") event.total = record.total;
	if (typeof record.error === "string") event.error = record.error;
	return event;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
	return `${Math.round(bytes / 1e3)} kB`;
}

/** Human line for the progress widget: "fetching bge-m3 -- 43% (512 MB /
 * 1.2 GB)"; status-only events print their status. */
export function pullProgressLine(model: string, event: PullEvent): string {
	if (event.total && event.completed !== undefined && event.total > 0) {
		const pct = Math.min(100, Math.round((event.completed / event.total) * 100));
		return `fetching ${model} -- ${pct}% (${formatBytes(event.completed)} / ${formatBytes(event.total)})`;
	}
	return `fetching ${model} -- ${event.status || "..."}`;
}

export type DoctorState =
	| { state: "ok" }
	/** The embedding dialect is not Ollama: nothing to check or fetch
	 * automatically; the backend's own role-clear error covers failures. */
	| { state: "not-ollama" }
	| { state: "unreachable"; baseUrl: string; error: string }
	| { state: "missing"; baseUrl: string; model: string };

/** Resolve the embedding role's backend (split fields win). */
export function embedEndpoint(cfg: LlmConfig): { api: "ollama" | "openai"; baseUrl: string; model: string } {
	return {
		api: cfg.embedApi ?? cfg.api,
		baseUrl: cfg.embedBaseUrl || cfg.baseUrl,
		model: cfg.embedModel,
	};
}

/** ONE local GET against Ollama's model list. Never throws. */
export async function checkEmbedModel(
	cfg: LlmConfig,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<DoctorState> {
	const endpoint = embedEndpoint(cfg);
	if (endpoint.api !== "ollama") return { state: "not-ollama" };
	try {
		const response = await fetchImpl(ollamaTagsUrl(endpoint.baseUrl), {
			signal: signal ?? AbortSignal.timeout(5_000),
		});
		if (!response.ok) {
			return { state: "unreachable", baseUrl: endpoint.baseUrl, error: `HTTP ${response.status}` };
		}
		const json: unknown = await response.json();
		return modelListed(json, endpoint.model)
			? { state: "ok" }
			: { state: "missing", baseUrl: endpoint.baseUrl, model: endpoint.model };
	} catch (error) {
		return {
			state: "unreachable",
			baseUrl: endpoint.baseUrl,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Pull the configured embedding model through Ollama, streaming progress
 * events to onProgress. Resolves when the stream reports success; throws
 * on HTTP failure, an error event, or abort. */
export async function pullEmbedModel(
	cfg: LlmConfig,
	onProgress: (line: string) => void,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<void> {
	const endpoint = embedEndpoint(cfg);
	const request = ollamaPullRequest(endpoint.baseUrl, endpoint.model);
	const response = await fetchImpl(request.url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request.body),
		signal,
	});
	if (!response.ok || !response.body) {
		throw new Error(`Ollama pull failed: HTTP ${response.status}`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let lastLine = "";
	const handle = (line: string) => {
		const event = parsePullLine(line);
		if (!event) return;
		if (event.error) throw new Error(`Ollama pull failed: ${event.error}`);
		const text = pullProgressLine(endpoint.model, event);
		if (text !== lastLine) {
			lastLine = text;
			onProgress(text);
		}
	};
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			handle(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	}
	if (buffer.trim()) handle(buffer);
}
