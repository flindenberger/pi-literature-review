/**
 * Selection engine: deterministic PDF download behind pi-literature-selection.
 *
 * Input is a list of identifiers (DOIs / arXiv IDs); a language model only
 * ever transports them, it never chooses, produces or repairs a download
 * link. The access level comes from the saved search (OpenAlex open-access
 * status), else from a live OpenAlex lookup: restricted papers and
 * conference abstracts are reported, not tried. Every other identifier runs
 * through a fixed resolver chain -- pdf_url from the saved search records
 * (lit-search/*.json), every open PDF location OpenAlex lists, Unpaywall
 * (index of legal open-access copies; needs a contact email), the
 * citation_pdf_url of the article page (only where the publisher's
 * robots.txt allows it), then the arXiv PDF endpoint -- and the first
 * source answering with real PDF bytes (%PDF magic check) is saved to the
 * lit-selection/ library, one file per paper, keyed like dedupe so the
 * same paper is never stored twice. Papers that do not download are listed
 * with a browser link, never fetched from gray sources. Per-paper report,
 * nothing fails silently. Shared by the pi tool/command and the CLI.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityKey } from "./pipeline.ts";
import { outputRoot } from "./output.ts";
import { type AccessInfo, lookupAccessByDoi } from "./sources/openalex.ts";
import { asciiPart, contactMailto, errorName, firstAuthorLastName, userAgent } from "./types.ts";

const DOWNLOAD_TIMEOUT_MS = 30_000; // per GET request
const FETCH_PAUSE_MS = 300; // between papers; stay polite to the free servers

/* ------------------------------------------------------------------ *
 * Identifier parsing -- pure                                          *
 * ------------------------------------------------------------------ */

export type IdentifierKind = "doi" | "arxiv" | "unknown";

export interface FetchTarget {
	/** The identifier exactly as the caller wrote it. */
	raw: string;
	kind: IdentifierKind;
	/** Cleaned identifier (prefixes like doi.org/ or arxiv: stripped). */
	id: string;
	/** Version-tolerant identity key (same scheme as dedupe), null if unknown. */
	key: string | null;
}

/**
 * Accepts the spellings people and digest lines actually use: bare DOIs,
 * doi:/https://doi.org/ prefixes, arXiv:2401.16393(v2), bare new-style
 * arXiv IDs (2401.16393) and old-style ones (cs/0112017). Anything else is
 * kind "unknown" -- reported, never guessed at.
 */
export function parseIdentifier(raw: string): FetchTarget {
	const cleaned = raw.trim().replace(/[.,;]+$/, "");
	let rest = cleaned
		.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
		.replace(/^doi:\s*/i, "");
	if (/^10\.\d{4,9}\/\S+$/.test(rest)) {
		return { raw, kind: "doi", id: rest, key: identityKey({ doi: rest, arxiv_id: "" }) };
	}
	rest = cleaned
		.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "")
		.replace(/^arxiv:\s*/i, "")
		.replace(/\.pdf$/i, "");
	if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(rest) || /^[a-z][a-z.-]+\/\d{7}(v\d+)?$/i.test(rest)) {
		return { raw, kind: "arxiv", id: rest, key: identityKey({ doi: "", arxiv_id: rest }) };
	}
	return { raw, kind: "unknown", id: cleaned, key: null };
}

/** Deterministic library filename (without extension): DOI slashes and
 * other unsafe characters become underscores; arXiv IDs get an arxiv_
 * prefix so the two namespaces cannot collide. */
export function identifierSlug(target: FetchTarget): string {
	const safe = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
	return target.kind === "arxiv" ? `arxiv_${safe(target.id)}` : safe(target.id);
}

/** Total length cap for the human-readable base name (without ".pdf"). */
const FILENAME_MAX_BASE = 80;

/**
 * Human-readable library filename: "2021_Kryniecka_et_al_Application_of_
 * Satellite_Sentinel_2_Images" -- year, first author's last name, et_al
 * when there are co-authors, then title words until the cap. All parts
 * come from the saved search records (API data); when year, author or
 * title is missing the deterministic identifier slug is used instead.
 */
export function paperFilename(target: FetchTarget, entry?: SidecarEntry): string {
	const year = entry?.year && /^\d{4}$/.test(entry.year) ? entry.year : "";
	const lastName = asciiPart(firstAuthorLastName(entry?.authors ?? []));
	const title = (entry?.title ?? "").trim();
	if (!year || !lastName || !title) return identifierSlug(target);
	const etAl = (entry?.authors?.length ?? 0) > 1 ? "_et_al" : "";
	let base = `${year}_${lastName}${etAl}`;
	let added = false;
	for (const word of title.split(/\s+/)) {
		const part = asciiPart(word);
		if (!part) continue;
		if (base.length + 1 + part.length > FILENAME_MAX_BASE) {
			// Never leave the name title-less: clip the first word if needed.
			if (!added) base += `_${part.slice(0, Math.max(1, FILENAME_MAX_BASE - base.length - 1))}`;
			break;
		}
		base += `_${part}`;
		added = true;
	}
	return base;
}

/** A file is a PDF exactly when it starts with the %PDF magic bytes. */
export function isPdfBytes(bytes: Uint8Array): boolean {
	return bytes.length >= 4
		&& bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/* ------------------------------------------------------------------ *
 * Sidecar index -- pure core, thin IO loader                          *
 * ------------------------------------------------------------------ */

export interface SidecarEntry {
	title: string;
	pdf_url: string;
	doi: string;
	arxiv_id: string;
	/** From the saved search records; used for the human-readable filename. */
	authors?: string[];
	year?: string | null;
	/** Access level and open PDF locations (OpenAlex), when the saved search
	 * carries them. */
	access?: AccessInfo;
}

/** The records of one saved search: the results table, then the dropped
 * table (its rows are tickable in the report too). */
function payloadRecords(payload: unknown): unknown[] {
	const { results, dropped } = (payload ?? {}) as { results?: unknown; dropped?: unknown };
	return [
		...(Array.isArray(results) ? results : []),
		...(Array.isArray(dropped) ? dropped.map((entry) => (entry as { record?: unknown })?.record) : []),
	];
}

/**
 * Index every record of the saved searches (results and dropped table) by
 * its identity key. Later records only fill gaps (first title wins, missing
 * pdf_url is completed) -- values are copied from the API-sourced records,
 * never rewritten.
 */
export function buildSidecarIndex(payloads: unknown[]): Map<string, SidecarEntry> {
	const index = new Map<string, SidecarEntry>();
	for (const payload of payloads) {
		for (const record of payloadRecords(payload)) {
			const { title, pdf_url, doi, arxiv_id, authors, year, access } = (record ?? {}) as Partial<SidecarEntry>;
			const cleanAuthors = Array.isArray(authors)
				? authors.filter((a): a is string => typeof a === "string")
				: [];
			const key = identityKey({ doi: doi ?? "", arxiv_id: arxiv_id ?? "" });
			if (key === null) continue;
			const known = index.get(key);
			if (!known) {
				index.set(key, {
					title: title ?? "",
					pdf_url: pdf_url ?? "",
					doi: doi ?? "",
					arxiv_id: arxiv_id ?? "",
					authors: cleanAuthors,
					year: typeof year === "string" ? year : null,
					...(access?.level ? { access } : {}),
				});
			} else {
				if (!known.title && title) known.title = title;
				if (!known.pdf_url && pdf_url) known.pdf_url = pdf_url;
				if (!known.arxiv_id && arxiv_id) known.arxiv_id = arxiv_id;
				if (!known.doi && doi) known.doi = doi;
				if (!known.authors?.length && cleanAuthors.length) known.authors = cleanAuthors;
				if (!known.year && typeof year === "string") known.year = year;
				if (!known.access && access?.level) known.access = access;
			}
		}
	}
	return index;
}

/** Read every lit-search/*.json sidecar under the root. Unreadable files are
 * warned about and skipped -- they never abort a fetch run. */
export function loadSidecarIndex(root: string, onWarn: (message: string) => void): Map<string, SidecarEntry> {
	const dir = join(root, "lit-search");
	const payloads: unknown[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".json"));
	} catch {
		return new Map(); // no saved searches yet -- fine, everything is just "unknown"
	}
	for (const name of names) {
		try {
			payloads.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
		} catch (error) {
			onWarn(`sidecar ${name} unreadable, skipped: ${error instanceof Error ? error.message : error}`);
		}
	}
	return buildSidecarIndex(payloads);
}

/* ------------------------------------------------------------------ *
 * Per-paper metadata twin -- makes the library self-describing        *
 * ------------------------------------------------------------------ */

/**
 * Written as lit-selection/<basename>.json next to every downloaded PDF. All
 * bibliographic fields are copied VERBATIM from the saved search records
 * (API-sourced); fetched/via describe the download event. The synthesis
 * stage reads this twin first and only falls back to recomputing filenames
 * against lit-search/*.json for PDFs downloaded before this existed.
 */
export interface PaperMeta {
	title: string;
	authors: string[];
	year: string | null;
	doi: string;
	arxiv_id: string;
	/** PDF link from the saved record (not necessarily the URL that worked). */
	pdf_url: string;
	/** ISO timestamp of the download (or of the adoption, see src/adopt.ts). */
	fetched: string;
	/** Which resolver produced the PDF (record link, OpenAlex location,
	 * Unpaywall, article page, arXiv) -- or "adopted": the PDF was already
	 * on disk and its identity came from an identifier found in the PDF
	 * text, verified by an API lookup. */
	via: PdfSource | "adopted";
}

/** Pure assembly; identifiers fall back to the parsed target so even a
 * paper outside every saved search keeps its citable identity. */
export function buildPaperMeta(
	target: FetchTarget,
	entry: SidecarEntry | undefined,
	via: PaperMeta["via"],
	fetchedIso: string,
): PaperMeta {
	return {
		title: entry?.title ?? "",
		authors: entry?.authors ?? [],
		year: entry?.year ?? null,
		doi: entry?.doi || (target.kind === "doi" ? target.id : ""),
		arxiv_id: entry?.arxiv_id || (target.kind === "arxiv" ? target.id : ""),
		pdf_url: entry?.pdf_url ?? "",
		fetched: fetchedIso,
		via,
	};
}

/* ------------------------------------------------------------------ *
 * Per-paper fetch -- injectable deps so the chain logic tests offline *
 * ------------------------------------------------------------------ */

/** The resolvers of the chain, in order. */
export type PdfSource = "record" | "openalex" | "unpaywall" | "landing" | "arxiv";

/** browser: free to read, but no automatic download worked (publisher
 * blocks programs, or no link answered with a PDF). restricted: not open
 * access, not tried. abstract_only: a conference abstract, no PDF exists. */
export type FetchStatus =
	| "downloaded" | "already" | "browser" | "restricted" | "abstract_only" | "not_free" | "dead_link" | "invalid";

export interface FetchResult {
	raw: string;
	id: string;
	kind: IdentifierKind;
	/** Title from the saved searches; empty when the identifier is unknown. */
	title: string;
	/** True when the identifier appeared in a saved search. */
	known: boolean;
	status: FetchStatus;
	/** Plain-language outcome, including the publisher link for not_free. */
	detail: string;
	/** Library path of the PDF (downloaded / already). */
	path?: string;
	/** Which resolver produced the PDF. */
	source?: PdfSource;
	/** Where to open the paper in a browser when it did not download. */
	browserUrl?: string;
	/** Diagnostics collected along the chain (skips, non-PDF answers, ...). */
	notes: string[];
}

export interface FetchDeps {
	fileExists(path: string): boolean;
	saveFile(path: string, bytes: Uint8Array): void;
	/** Write the metadata twin next to a freshly downloaded PDF. */
	saveMeta(path: string, meta: PaperMeta): void;
	/** GET the url; ok=false carries a plain-language reason and, for HTTP
	 * failures, the status code (403 marks publisher bot-blocking). */
	downloadPdf(url: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string; status?: number }>;
	/** Unpaywall lookup; url=null means no free copy (note says why/skipped). */
	unpaywallPdfUrl(doi: string): Promise<{ url: string | null; note?: string }>;
	/** Live OpenAlex access lookup for identifiers without a saved access
	 * level; access=null when OpenAlex does not list the DOI or failed. */
	openAlexAccess(doi: string): Promise<{ access: AccessInfo | null; note?: string }>;
	/** citation_pdf_url of the article page behind the DOI; url=null when
	 * robots.txt forbids it, the page refuses or names no PDF (note says which). */
	landingPdfUrl(doi: string): Promise<{ url: string | null; note?: string }>;
}

export async function fetchOne(
	target: FetchTarget,
	entry: SidecarEntry | undefined,
	papersDir: string,
	deps: FetchDeps,
): Promise<FetchResult> {
	const result: FetchResult = {
		raw: target.raw,
		id: target.id,
		kind: target.kind,
		title: entry?.title ?? "",
		known: entry !== undefined,
		status: "invalid",
		detail: "",
		notes: [],
	};
	if (target.kind === "unknown") {
		result.detail = "not a DOI or arXiv ID; nothing was downloaded";
		return result;
	}
	if (!result.known) result.notes.push("not part of any saved search");

	const path = join(papersDir, `${paperFilename(target, entry)}.pdf`);
	// Legacy check: papers fetched before the human-readable naming keep
	// their identifier-slug filename; the library stays duplicate-free.
	const legacyPath = join(papersDir, `${identifierSlug(target)}.pdf`);
	const existing = deps.fileExists(path) ? path : deps.fileExists(legacyPath) ? legacyPath : null;
	if (existing) {
		result.status = "already";
		result.detail = "already in the library, not downloaded again";
		result.path = existing;
		return result;
	}

	// Access level: from the saved search, else looked up live (older
	// searches, identifiers typed by hand).
	let access = entry?.access ?? null;
	if (!access && target.kind === "doi") {
		const answer = await deps.openAlexAccess(target.id);
		if (answer.note) result.notes.push(answer.note);
		access = answer.access;
	}
	const arxivId = target.kind === "arxiv" ? target.id : entry?.arxiv_id ?? "";
	const doiLink = target.kind === "doi" ? `https://doi.org/${target.id}` : "";
	// Not tried: no automatic route leads to these (an arXiv copy would,
	// but such records are "free" by definition).
	if (!arxivId && access?.level === "abstract_only") {
		result.status = "abstract_only";
		result.detail = `only an abstract exists (conference abstract), no PDF to download: ${doiLink}`;
		return result;
	}
	if (!arxivId && access?.level === "restricted") {
		result.status = "restricted";
		result.detail = `restricted access (subscription) -- open in your browser, e.g. in your university network: ${doiLink}`;
		result.browserUrl = doiLink;
		return result;
	}

	// Fixed resolver chain; the first source answering with real PDF bytes
	// wins. Each step is asked only when the steps before it failed.
	const noteOf = (answer: { url: string | null; note?: string }) => {
		if (answer.note) result.notes.push(answer.note);
		return answer.url ? [answer.url] : [];
	};
	const steps: Array<{ source: PdfSource; urls: () => Promise<string[]> }> = [
		{ source: "record", urls: async () => (entry?.pdf_url ? [entry.pdf_url] : []) },
		{ source: "openalex", urls: async () => access?.pdf_urls ?? [] },
		{ source: "unpaywall", urls: async () => (target.kind === "doi" ? noteOf(await deps.unpaywallPdfUrl(target.id)) : []) },
		{ source: "landing", urls: async () => (target.kind === "doi" ? noteOf(await deps.landingPdfUrl(target.id)) : []) },
		{ source: "arxiv", urls: async () => (arxivId ? [`https://arxiv.org/pdf/${arxivId}`] : []) },
	];

	const tried = new Set<string>();
	let blockedUrl = "";
	for (const step of steps) {
		for (const url of await step.urls()) {
			if (tried.has(url)) continue;
			tried.add(url);
			const answer = await deps.downloadPdf(url);
			if (!answer.ok) {
				result.notes.push(`${step.source}: ${answer.reason}`);
				// 403 on an OA link = the publisher refuses automated clients
				// (bot detection); a normal browser gets the same file fine.
				if (answer.status === 403 && !blockedUrl) blockedUrl = url;
				continue;
			}
			if (!isPdfBytes(answer.bytes)) {
				result.notes.push(`${step.source}: link did not return a PDF`);
				continue;
			}
			deps.saveFile(path, answer.bytes);
			// Metadata twin: written only for fresh downloads; "already" papers
			// from before this existed are matched by filename recomputation.
			deps.saveMeta(
				path.replace(/\.pdf$/, ".json"),
				buildPaperMeta(target, entry, step.source, new Date().toISOString()),
			);
			result.status = "downloaded";
			result.detail = `downloaded via ${step.source}`;
			result.path = path;
			result.source = step.source;
			return result;
		}
	}

	const fallbackLink = doiLink || (arxivId ? `https://arxiv.org/abs/${arxivId}` : "");
	if (blockedUrl || access?.level === "free") {
		result.status = "browser";
		result.browserUrl = blockedUrl || fallbackLink;
		result.detail = blockedUrl
			? `free, but the publisher blocks automated downloads -- open in your browser: ${result.browserUrl}`
			: `free, but no link returned a PDF (${tried.size} tried) -- open in your browser: ${result.browserUrl}`;
	} else if (tried.size === 0) {
		result.status = "not_free";
		result.browserUrl = doiLink || undefined;
		result.detail = target.kind === "doi"
			? `not freely available -- obtain via authorized access: ${doiLink}`
			: "no download source known for this identifier";
	} else {
		result.status = "dead_link";
		result.browserUrl = doiLink || undefined;
		result.detail = target.kind === "doi"
			? `no working free link (${tried.size} tried) -- obtain via authorized access: ${doiLink}`
			: `no working free link (${tried.size} tried)`;
	}
	return result;
}

/* ------------------------------------------------------------------ *
 * Report -- pure text rendering, digest philosophy                    *
 * ------------------------------------------------------------------ */

const STATUS_LABEL: Record<FetchStatus, string> = {
	downloaded: "downloaded",
	already: "already in library",
	browser: "free, open in browser",
	restricted: "restricted",
	abstract_only: "abstract only",
	not_free: "not freely available",
	dead_link: "no working free link",
	invalid: "invalid identifier",
};

export function renderFetchReport(results: FetchResult[], papersDir: string): string {
	const count = (status: FetchStatus) => results.filter((r) => r.status === status).length;
	const lines: string[] = [];
	lines.push(
		`Fetch complete: ${count("downloaded")} downloaded, ${count("already")} already in the library, `
		+ `${count("browser")} free but to open in your browser (automatic download failed), `
		+ `${count("restricted")} restricted (browser, e.g. in your university network), `
		+ `${count("abstract_only")} abstract only (no PDF exists), `
		+ `${count("not_free") + count("dead_link")} not freely available, ${count("invalid")} invalid.`,
	);
	lines.push(`PDF library: ${papersDir}`);
	lines.push("");
	results.forEach((result, i) => {
		const title = result.title ? ` | ${result.title}` : "";
		lines.push(`${i + 1}. [${STATUS_LABEL[result.status]}] ${result.raw}${title}`);
		lines.push(`   ${result.detail}`);
		for (const note of result.notes) lines.push(`   note: ${note}`);
	});
	// One list of everything that needs the browser, free papers first.
	const toOpen = [
		...results.filter((r) => r.status === "browser"),
		...results.filter((r) => r.status === "restricted"),
		...results.filter((r) => (r.status === "not_free" || r.status === "dead_link") && r.browserUrl),
	];
	if (toOpen.length) {
		lines.push("");
		lines.push(`Open in your browser (${toOpen.length}): save each PDF into ${papersDir} -- `
			+ "/lit-synthesis recognises it by the DOI or arXiv ID printed in the PDF.");
		for (const result of toOpen) {
			const title = result.title ? ` | ${result.title}` : "";
			lines.push(`- [${STATUS_LABEL[result.status]}] ${result.browserUrl}${title}`);
		}
	}
	return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Real network/filesystem deps and the run orchestrator               *
 * ------------------------------------------------------------------ */

/** Per-request timeout, combined with the agent's abort signal (Esc)
 * whenever one is supplied -- a running download dies with either. */
function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function downloadPdfReal(
	url: string,
	signal?: AbortSignal,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string; status?: number }> {
	try {
		const response = await fetch(url, {
			headers: { "User-Agent": userAgent() },
			redirect: "follow",
			signal: requestSignal(signal),
		});
		if (response.status !== 200) {
			return { ok: false, reason: `server answered ${response.status}`, status: response.status };
		}
		return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()) };
	} catch (error) {
		return { ok: false, reason: `network error: ${errorName(error)}` };
	}
}

/* ------------------------------------------------------------------ *
 * robots.txt and the article page -- pure parsers, thin IO           *
 * ------------------------------------------------------------------ */

/** Product token this tool uses to find its group in a robots.txt. */
const ROBOTS_AGENT = "pi-literature-review";

/** A robots.txt path pattern as a regular expression: "*" matches any
 * run of characters, a trailing "$" anchors the end (RFC 9309). */
function robotsPattern(pattern: string): RegExp {
	const anchored = pattern.endsWith("$");
	const body = (anchored ? pattern.slice(0, -1) : pattern)
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/**
 * Whether a robots.txt allows `agent` to fetch `pathAndQuery` (RFC 9309):
 * the groups naming the agent's product token apply, else the "*" groups,
 * else everything is allowed; the longest matching rule wins, a tie goes
 * to Allow. Pure.
 */
export function robotsAllows(robotsTxt: string, agent: string, pathAndQuery: string): boolean {
	type Group = { agents: string[]; rules: Array<{ allow: boolean; pattern: string }> };
	const groups: Group[] = [];
	let current: Group | null = null;
	let lastWasAgent = false;
	for (const rawLine of robotsTxt.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const field = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (field === "user-agent") {
			if (!current || !lastWasAgent) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			lastWasAgent = true;
		} else if ((field === "allow" || field === "disallow") && current) {
			if (value) current.rules.push({ allow: field === "allow", pattern: value });
			lastWasAgent = false;
		} else {
			lastWasAgent = false;
		}
	}
	const token = agent.toLowerCase();
	let applicable = groups.filter((group) => group.agents.includes(token));
	if (!applicable.length) applicable = groups.filter((group) => group.agents.includes("*"));
	let best: { allow: boolean; length: number } | null = null;
	for (const rule of applicable.flatMap((group) => group.rules)) {
		if (!robotsPattern(rule.pattern).test(pathAndQuery)) continue;
		const length = rule.pattern.length;
		if (!best || length > best.length || (length === best.length && rule.allow)) {
			best = { allow: rule.allow, length };
		}
	}
	return best ? best.allow : true;
}

/** The citation_pdf_url meta tag of an article page (the Highwire tag
 * publishers set for Google Scholar), resolved against the page URL;
 * null when the page names none. Pure. */
export function citationPdfUrl(html: string, pageUrl: string): string | null {
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		if (!/\bname\s*=\s*["']citation_pdf_url["']/i.test(tag)) continue;
		const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
		if (!content) continue;
		try {
			return new URL(content.replace(/&amp;/g, "&").trim(), pageUrl).href;
		} catch {
			return null;
		}
	}
	return null;
}

/** robots.txt per origin for this run. "" = no rules (allow all), null =
 * unreachable (disallow all, RFC 9309: 5xx or network error). */
const robotsCache = new Map<string, Promise<string | null>>();

function robotsText(origin: string, signal?: AbortSignal): Promise<string | null> {
	let cached = robotsCache.get(origin);
	if (!cached) {
		cached = (async () => {
			try {
				const response = await fetch(`${origin}/robots.txt`, {
					headers: { "User-Agent": userAgent() },
					redirect: "follow",
					signal: requestSignal(signal),
				});
				if (response.status === 200) return await response.text();
				// 4xx: "unavailable" -- RFC 9309 allows access; 5xx: unreachable.
				return response.status >= 400 && response.status < 500 ? "" : null;
			} catch {
				return null;
			}
		})();
		robotsCache.set(origin, cached);
	}
	return cached;
}

async function robotsAllowedReal(url: string, signal?: AbortSignal): Promise<boolean> {
	const parsed = new URL(url);
	const text = await robotsText(parsed.origin, signal);
	return text !== null && robotsAllows(text, ROBOTS_AGENT, `${parsed.pathname}${parsed.search}`);
}

/** Redirect hops followed from doi.org to the article page. */
const MAX_REDIRECTS = 8;

/** Resolve the DOI hop by hop (every hop checked against its robots.txt),
 * then read the page's citation_pdf_url (checked as well). */
async function landingPdfUrlReal(
	doi: string,
	signal?: AbortSignal,
): Promise<{ url: string | null; note?: string }> {
	let url = `https://doi.org/${doi}`;
	try {
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			if (!(await robotsAllowedReal(url, signal))) {
				return { url: null, note: `article page: robots.txt of ${new URL(url).host} does not allow automated access` };
			}
			const response = await fetch(url, {
				headers: { "User-Agent": userAgent() },
				redirect: "manual",
				signal: requestSignal(signal),
			});
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				url = new URL(location, url).href;
				continue;
			}
			if (response.status !== 200) {
				return { url: null, note: `article page at ${new URL(url).host} answered ${response.status}` };
			}
			const pdf = citationPdfUrl(await response.text(), url);
			if (!pdf) return { url: null, note: `article page at ${new URL(url).host} names no PDF` };
			if (!(await robotsAllowedReal(pdf, signal))) {
				return { url: null, note: `article page: robots.txt of ${new URL(pdf).host} does not allow the PDF` };
			}
			return { url: pdf };
		}
		return { url: null, note: "article page: too many redirects" };
	} catch (error) {
		return { url: null, note: `article page network error: ${errorName(error)}` };
	}
}

async function openAlexAccessReal(doi: string): Promise<{ access: AccessInfo | null; note?: string }> {
	try {
		const access = (await lookupAccessByDoi([doi])).get(doi.toLowerCase()) ?? null;
		return access ? { access } : { access: null, note: "OpenAlex does not list this DOI (access unknown)" };
	} catch (error) {
		return { access: null, note: `OpenAlex access lookup failed: ${error instanceof Error ? error.message : error}` };
	}
}

async function unpaywallPdfUrlReal(
	doi: string,
	mailto: string,
	signal?: AbortSignal,
): Promise<{ url: string | null; note?: string }> {
	if (!mailto) {
		return {
			url: null,
			note: "Unpaywall skipped: no contact email configured (the /lit-selection dialog can store one; "
				+ "PI_LITERATURE_REVIEW_MAILTO also works)",
		};
	}
	try {
		const response = await fetch(
			`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(mailto)}`,
			{ headers: { "User-Agent": userAgent() }, signal: requestSignal(signal) },
		);
		if (response.status === 404) return { url: null, note: "Unpaywall: DOI not indexed" };
		if (response.status !== 200) return { url: null, note: `Unpaywall answered ${response.status}` };
		const body = await response.json() as {
			best_oa_location?: { url_for_pdf?: string | null } | null;
			oa_locations?: Array<{ url_for_pdf?: string | null }>;
		};
		const url = body.best_oa_location?.url_for_pdf
			?? body.oa_locations?.find((location) => location.url_for_pdf)?.url_for_pdf
			?? null;
		return url ? { url } : { url: null, note: "Unpaywall: no open copy listed" };
	} catch (error) {
		return { url: null, note: `Unpaywall network error: ${errorName(error)}` };
	}
}

export interface SelectionRunOptions {
	identifiers: string[];
	/** Data root; defaults to outputRoot() (lit-selection/ lands next to lit-search/). */
	root?: string;
	/** Contact email for Unpaywall, valid for THIS run only (the dialog's
	 * "this run only" answer). Default: the configured email (env var,
	 * else the stored config value). */
	mailto?: string;
	onWarn?: (message: string) => void;
	/** Abort signal from the agent (Esc): stops between papers and kills the
	 * running request; already-saved PDFs stay (the library is append-only). */
	signal?: AbortSignal;
}

export async function runSelection(
	options: SelectionRunOptions,
): Promise<{ results: FetchResult[]; papersDir: string }> {
	const warnTo = options.onWarn ?? (() => {});
	const root = options.root ?? outputRoot();
	const papersDir = join(root, "lit-selection");
	mkdirSync(papersDir, { recursive: true });
	const index = loadSidecarIndex(root, warnTo);
	const mailto = options.mailto?.trim() || contactMailto();
	const deps: FetchDeps = {
		fileExists: existsSync,
		saveFile: (path, bytes) => writeFileSync(path, bytes),
		saveMeta: (path, meta) => writeFileSync(path, JSON.stringify(meta, null, 2) + "\n", "utf8"),
		downloadPdf: (url) => downloadPdfReal(url, options.signal),
		unpaywallPdfUrl: (doi) => unpaywallPdfUrlReal(doi, mailto, options.signal),
		openAlexAccess: (doi) => openAlexAccessReal(doi),
		landingPdfUrl: (doi) => landingPdfUrlReal(doi, options.signal),
	};
	const results: FetchResult[] = [];
	const total = options.identifiers.length;
	for (const [i, raw] of options.identifiers.entries()) {
		if (options.signal?.aborted) {
			warnTo(`fetch aborted by the user after ${results.length} of ${total} paper(s)`);
			break;
		}
		const target = parseIdentifier(raw);
		const entry = target.key !== null ? index.get(target.key) : undefined;
		if (results.length) await new Promise((resolve) => setTimeout(resolve, FETCH_PAUSE_MS));
		warnTo(`fetching ${raw} (${i + 1}/${total})`);
		const result = await fetchOne(target, entry, papersDir, deps);
		warnTo(`${result.raw}: ${STATUS_LABEL[result.status]}`);
		results.push(result);
	}
	return { results, papersDir };
}
