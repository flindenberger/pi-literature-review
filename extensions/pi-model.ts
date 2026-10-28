/**
 * Model calls on the model currently selected in pi: one completion
 * helper (the search wizard's query-variant suggestions, the synthesis
 * backend's generate half) and the session provider the web interface
 * runs on. The calls are text-shaping only: nothing they return may ever
 * become bibliographic data.
 *
 * The call goes through pi's model registry (ctx.modelRegistry.streamSimple,
 * the documented extension path), which resolves credentials, base URL and
 * provider environment at request time -- so a /model switch in pi is
 * picked up by the next call. Thinking is off with a hard output cap
 * (hidden reasoning would eat the whole budget invisibly). Throws on a
 * missing model, error/aborted stops and empty answer text -- the caller
 * decides how to degrade.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configuredGenerateModel, llmConfig } from "../src/config.ts";
import { createBackend, type LlmBackend } from "../src/llm.ts";
import { OUTPUT_RESERVE_TOKENS } from "../src/synthesis.ts";
import type { GenerateCall, ModelProvider } from "../src/provider.ts";

export async function completeWithPiModel(ctx: ExtensionContext, options: GenerateCall): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("no model selected in pi");
	const response = await ctx.modelRegistry.streamSimple(model, {
		systemPrompt: options.system,
		messages: [{ role: "user", content: options.user, timestamp: Date.now() }],
	}, {
		temperature: options.temperature,
		// No `reasoning` level: pi-ai then sends no reasoning effort, which
		// disables template thinking (enable_thinking: false) -- a capped
		// call must not spend its budget on hidden reasoning.
		maxTokens: options.maxTokens ?? 512,
		signal: options.signal,
	}).result();
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `generation ${response.stopReason}`);
	}
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
	if (!text.trim()) {
		const thought = response.content.some((part) => part.type === "thinking");
		throw new Error(
			`the model returned no answer text (stop reason: ${response.stopReason}`
			+ `${thought ? "; it produced only hidden reasoning" : ""}) -- ask again, `
			+ "rephrase, or select a non-thinking model in pi",
		);
	}
	return text;
}

/**
 * Generator = the model currently selected in pi; embeddings stay on the
 * configured local backend. Review-genre units (mode B + review synthesis)
 * run on the pi model too; only an EXPLICITLY configured llm.generateModel
 * routes them to the local generator -- this backend dispatches on the
 * model name per call, localModels empty when nothing is configured.
 * ctx is read at call time, so a /model switch applies to the next call.
 */
export function piModelBackend(ctx: ExtensionContext, local: LlmBackend, localModels: string[]): LlmBackend {
	return {
		label: "model selected in pi",
		embed: (texts, signal) => local.embed(texts, signal),
		generate: async (system, user, options, signal) => {
			if (options?.model && localModels.includes(options.model)) {
				return local.generate(system, user, options, signal);
			}
			return completeWithPiModel(ctx, {
				system,
				user,
				temperature: options?.temperature,
				// Hard output cap as before: the answer budget the engines reserve.
				maxTokens: options?.maxTokens ?? OUTPUT_RESERVE_TOKENS,
				signal,
			});
		},
	};
}

/** The pi session as the web interface's model provider. Every status
 * read and every call looks at ctx.model afresh (pi resolves context
 * values at access time), so the page always shows the current model. */
export function piSessionProvider(ctx: ExtensionContext): ModelProvider {
	const cfg = llmConfig();
	const local = createBackend(cfg);
	const localReview = configuredGenerateModel();
	const backend = piModelBackend(ctx, local, localReview ? [localReview] : []);
	const piName = () => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null);
	return {
		status: () => {
			const model = ctx.model;
			const baseUrl = model?.baseUrl ?? "";
			const localUrl = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(baseUrl);
			return {
				kind: "pi",
				model: piName(),
				via: "via pi",
				embeddings: cfg.embedModel,
				embeddingsVia: `${cfg.embedApi ?? cfg.api} at ${cfg.embedBaseUrl || cfg.baseUrl}`,
				remote: model ? !localUrl : null,
				baseUrl: baseUrl || null,
				embeddingsBaseUrl: cfg.embedBaseUrl || cfg.baseUrl || null,
			};
		},
		hasModel: () => Boolean(ctx.model),
		generate: (call) => completeWithPiModel(ctx, call),
		wiring: () => {
			const name = piName() ?? cfg.generateModel;
			return { backend, explainModel: name, reviewModel: localReview || name };
		},
	};
}
