/**
 * General web search for the "web-search" code source: the user's OWN
 * search engine only -- a SearXNG instance they run (asked first) or an
 * Exa account (their API key). Without either the source is not queried
 * (keyRequirement in search.ts); there is no keyless fallback, because
 * the free keyless access of the commercial engines carries no terms
 * that allow a published tool to store and show what it returns.
 *
 * Both engines answer with a list of pages: address, title, a text
 * excerpt. Nothing here reads meaning into the text -- codesearch.ts only
 * pulls repository addresses and paper identifiers out of it with
 * regular expressions. No language model anywhere.
 *
 * Response shapes the parsers rely on:
 *   - SearXNG GET <base>/search?q=..&format=json -> {results: [{url, title,
 *     content}]} (JSON output must be enabled in the instance's settings;
 *     otherwise it answers HTTP 403).
 *   - Exa POST https://api.exa.ai/search {query, numResults, type,
 *     contents} with header x-api-key -> {results: [{url, title, text,
 *     highlights}]} (request body and result fields as Exa's own 402
 *     answer describes them, 2026-11-15; unmeasured with a key).
 */

import { exaApiKey, searxngUrl } from "../config.ts";
import { IN_BROWSER, userAgentHeader } from "../types.ts";
import { pacedClient } from "./polite.ts";

export interface WebHit {
	url: string;
	title: string;
	/** Text excerpt of the page as the engine returned it. */
	text: string;
}

export type WebEngine = "searxng" | "exa";

/** Results asked per request. */
export const WEB_RESULTS = 10;
/** Characters of page text kept per hit (Exa): enough for a README's
 * citation block, small enough to keep the answer light. */
const TEXT_CHARS = 4000;

const fetchSearxng = pacedClient({ label: "SearXNG", spacingMs: 1000 });
const fetchExa = pacedClient({
	label: "Exa",
	spacingMs: 300,
	statusHint: (status) => (status === 401 || status === 402 || status === 403
		? "Exa did not accept the API key; check exaApiKey in the configuration (or remove it)"
		: null),
});

/** Which engine runs in this configuration, or null when none is set up.
 * A SearXNG address wins over an Exa key (local and private first). The
 * browser demo has neither (no settings there). */
export function webEngine(
	env: Record<string, string | undefined> = process.env,
): WebEngine | null {
	if (IN_BROWSER) return null;
	if (searxngUrl(env)) return "searxng";
	if (exaApiKey(env)) return "exa";
	return null;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** SearXNG JSON -> hits. Pure. */
export function parseSearxngResults(data: unknown): WebHit[] {
	const results = (data as Record<string, any>)?.results;
	if (!Array.isArray(results)) return [];
	return results
		.filter((item) => /^https?:\/\//.test(text(item?.url)))
		.map((item) => ({ url: item.url, title: text(item.title), text: text(item.content) }));
}

/** Exa JSON -> hits; highlights are appended to the text. Pure. */
export function parseExaResults(data: unknown): WebHit[] {
	const results = (data as Record<string, any>)?.results;
	if (!Array.isArray(results)) return [];
	return results
		.filter((item) => /^https?:\/\//.test(text(item?.url)))
		.map((item) => {
			const highlights = Array.isArray(item.highlights) ? item.highlights.filter((h: unknown) => typeof h === "string") : [];
			return { url: item.url, title: text(item.title), text: [text(item.text), ...highlights].filter(Boolean).join("\n") };
		});
}

export async function searchSearxng(base: string, query: string, signal?: AbortSignal): Promise<WebHit[]> {
	const params = new URLSearchParams({ q: query, format: "json" });
	const response = await fetchSearxng(`${base}/search?${params}`, {
		headers: { Accept: "application/json", ...userAgentHeader(true) },
		...(signal ? { signal } : {}),
	});
	return parseSearxngResults(await response.json()).slice(0, WEB_RESULTS);
}

export async function searchExa(key: string, query: string, signal?: AbortSignal): Promise<WebHit[]> {
	const response = await fetchExa("https://api.exa.ai/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": key },
		body: JSON.stringify({ query, numResults: WEB_RESULTS, type: "auto", contents: { text: { maxCharacters: TEXT_CHARS } } }),
		...(signal ? { signal } : {}),
	});
	return parseExaResults(await response.json());
}

/** One query through the configured engine; throws when none is set up. */
export async function webSearch(query: string, signal?: AbortSignal): Promise<{ engine: WebEngine; hits: WebHit[] }> {
	const engine = webEngine();
	if (engine === "searxng") return { engine, hits: await searchSearxng(searxngUrl(), query, signal) };
	if (engine === "exa") return { engine, hits: await searchExa(exaApiKey(), query, signal) };
	throw new Error("no web search engine configured (exaApiKey or searxngUrl)");
}
