/**
 * One completion call against the model currently selected in pi
 * (2026-08-06). Extracted from the generate-half of synthesis.ts's
 * piModelBackend so other adapters (the search wizard's query-variant
 * suggestions) can make a single LLM call without wiring a full backend.
 * The call is text-shaping only -- the citation-path doctrine stands:
 * nothing this returns may ever become bibliographic data.
 *
 * pi's extension loader provides @earendil-works/pi-ai at runtime; it is
 * imported lazily so this file stays loadable outside pi (smoke tests).
 * Thinking is OFF with a hard output cap (field failure 2026-07-20: hidden
 * reasoning ate the whole budget invisibly). Throws on missing model,
 * missing credentials, error/aborted stops and empty answer text -- the
 * caller decides how to degrade.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function completeWithPiModel(
	ctx: ExtensionContext,
	options: { system: string; user: string; maxTokens?: number; temperature?: number; signal?: AbortSignal },
): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("no model selected in pi");
	const { completeSimple } = await import("@earendil-works/pi-ai");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`no credentials for ${model.provider}/${model.id}: ${auth.error}`);
	const response = await completeSimple(model, {
		systemPrompt: options.system,
		messages: [{ role: "user", content: options.user, timestamp: Date.now() }],
	}, {
		apiKey: auth.apiKey,
		headers: auth.headers,
		temperature: options.temperature,
		reasoning: "off",
		maxTokens: options.maxTokens ?? 512,
		signal: options.signal,
	});
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
			+ `${thought ? "; it produced only hidden reasoning" : ""})`,
		);
	}
	return text;
}
