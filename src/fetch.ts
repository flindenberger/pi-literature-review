/**
 * Deterministic PDF retrieval -- the Phase 3 engine behind pi-literature-fetch.
 *
 * Input is a list of identifiers (DOIs / arXiv IDs); the model only ever
 * transports them, it never chooses, produces or repairs a download link.
 * Each identifier runs through a fixed resolver chain -- pdf_url from the
 * saved search records (JSON sidecars), then Unpaywall (OurResearch's index
 * of legal open-access copies; requires PI_LITERATURE_REVIEW_MAILTO), then
 * the arXiv PDF endpoint -- and the first source that answers with real PDF
 * bytes (%PDF magic check) is saved to the shared papers/ library, one file
 * per paper, keyed like dedupe so the same paper is never stored twice.
 * Whatever has no free copy is reported with its publisher link ("obtain via
 * authorized access"), never fetched from gray sources. Honest per-paper
 * report, nothing fails silently.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityKey } from "./pipeline.ts";
import { outputRoot } from "./output.ts";
import { contactMailto, firstAuthorLastName, userAgent } from "./types.ts";

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

/** ASCII-safe filename fragment: German umlauts transliterated, other
 * diacritics stripped, everything else collapsed to underscores. */
function asciiPart(value: string): string {
	return value
		.replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue")
		.replaceAll("Ä", "Ae").replaceAll("Ö", "Oe").replaceAll("Ü", "Ue")
		.replaceAll("ß", "ss")
		.normalize("NFD").replace(/[̀-ͯ]/g, "")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
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
}

/**
 * Index every record of the saved searches by its identity key. Later
 * payloads only fill gaps (first title wins, missing pdf_url is completed)
 * -- values are copied from the API-sourced records, never rewritten.
 */
export function buildSidecarIndex(payloads: unknown[]): Map<string, SidecarEntry> {
	const index = new Map<string, SidecarEntry>();
	for (const payload of payloads) {
		const results = (payload as { results?: unknown })?.results;
		if (!Array.isArray(results)) continue;
		for (const record of results) {
			const { title, pdf_url, doi, arxiv_id, authors, year } = (record ?? {}) as Partial<SidecarEntry>;
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
				});
			} else {
				if (!known.title && title) known.title = title;
				if (!known.pdf_url && pdf_url) known.pdf_url = pdf_url;
				if (!known.arxiv_id && arxiv_id) known.arxiv_id = arxiv_id;
				if (!known.doi && doi) known.doi = doi;
				if (!known.authors?.length && cleanAuthors.length) known.authors = cleanAuthors;
				if (!known.year && typeof year === "string") known.year = year;
			}
		}
	}
	return index;
}

/** Read every queries/*.json sidecar under the root. Unreadable files are
 * warned about and skipped -- they never abort a fetch run. */
export function loadSidecarIndex(root: string, onWarn: (message: string) => void): Map<string, SidecarEntry> {
	const dir = join(root, "queries");
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
 * Written as papers/<basename>.json next to every downloaded PDF. All
 * bibliographic fields are copied VERBATIM from the saved search records
 * (API-sourced); fetched/via describe the download event. The synthesis
 * stage reads this twin first and only falls back to recomputing filenames
 * against queries/*.json for PDFs downloaded before this existed.
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
	/** Which resolver produced the PDF (record link, Unpaywall, arXiv) --
	 * or "adopted": the PDF was already on disk and its identity came from
	 * an identifier found in the PDF text, verified by an API lookup. */
	via: "record" | "unpaywall" | "arxiv" | "adopted";
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

export type FetchStatus = "downloaded" | "already" | "not_free" | "dead_link" | "blocked" | "invalid";

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
	/** Which resolver produced the PDF: record link, Unpaywall or arXiv. */
	source?: "record" | "unpaywall" | "arxiv";
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

	// Fixed resolver chain; the first source answering with real PDF bytes wins.
	const candidates: Array<{ url: string; source: FetchResult["source"] }> = [];
	if (entry?.pdf_url) candidates.push({ url: entry.pdf_url, source: "record" });
	if (target.kind === "doi") {
		const { url, note } = await deps.unpaywallPdfUrl(target.id);
		if (note) result.notes.push(note);
		if (url) candidates.push({ url, source: "unpaywall" });
	}
	const arxivId = target.kind === "arxiv" ? target.id : entry?.arxiv_id ?? "";
	if (arxivId) candidates.push({ url: `https://arxiv.org/pdf/${arxivId}`, source: "arxiv" });

	const tried = new Set<string>();
	let blockedUrl = "";
	for (const candidate of candidates) {
		if (tried.has(candidate.url)) continue;
		tried.add(candidate.url);
		const answer = await deps.downloadPdf(candidate.url);
		if (!answer.ok) {
			result.notes.push(`${candidate.source}: ${answer.reason}`);
			// 403 on an OA link = the publisher refuses automated clients
			// (bot detection); a normal browser gets the same file fine.
			if (answer.status === 403 && !blockedUrl) blockedUrl = candidate.url;
			continue;
		}
		if (!isPdfBytes(answer.bytes)) {
			result.notes.push(`${candidate.source}: link did not return a PDF`);
			continue;
		}
		deps.saveFile(path, answer.bytes);
		// Metadata twin: written only for fresh downloads; "already" papers
		// from before this existed are matched by filename recomputation.
		deps.saveMeta(
			path.replace(/\.pdf$/, ".json"),
			buildPaperMeta(target, entry, candidate.source as PaperMeta["via"], new Date().toISOString()),
		);
		result.status = "downloaded";
		result.detail = `downloaded via ${candidate.source}`;
		result.path = path;
		result.source = candidate.source;
		return result;
	}

	if (blockedUrl) {
		result.status = "blocked";
		result.detail = `publisher blocks automated downloads -- open in your browser: ${blockedUrl}`;
	} else if (tried.size === 0) {
		result.status = "not_free";
		result.detail = target.kind === "doi"
			? `not freely available -- obtain via authorized access: https://doi.org/${target.id}`
			: "no download source known for this identifier";
	} else {
		result.status = "dead_link";
		result.detail = target.kind === "doi"
			? `no working free link (${tried.size} tried) -- obtain via authorized access: https://doi.org/${target.id}`
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
	not_free: "not freely available",
	dead_link: "no working free link",
	blocked: "blocked by publisher",
	invalid: "invalid identifier",
};

export function renderFetchReport(results: FetchResult[], papersDir: string): string {
	const count = (status: FetchStatus) => results.filter((r) => r.status === status).length;
	const lines: string[] = [];
	lines.push(
		`Fetch complete: ${count("downloaded")} downloaded, ${count("already")} already in the library, `
		+ `${count("blocked")} blocked by the publisher (browser link in the report), `
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
		const name = error instanceof Error ? (error.cause as Error)?.name ?? error.name : "unknown";
		return { ok: false, reason: `network error: ${name}` };
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
			note: "Unpaywall skipped: no contact email configured (the fetch dialog can store one; "
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
		const name = error instanceof Error ? (error.cause as Error)?.name ?? error.name : "unknown";
		return { url: null, note: `Unpaywall network error: ${name}` };
	}
}

export interface FetchRunOptions {
	identifiers: string[];
	/** Data root; defaults to outputRoot() (papers/ lands next to queries/). */
	root?: string;
	/** Contact email for Unpaywall, valid for THIS run only (the fetch
	 * dialog's "this run only" answer). Default: the configured email
	 * (env var, else the stored config value). */
	mailto?: string;
	onWarn?: (message: string) => void;
	/** Abort signal from the agent (Esc): stops between papers and kills the
	 * running request; already-saved PDFs stay (the library is append-only). */
	signal?: AbortSignal;
}

export async function runFetch(
	options: FetchRunOptions,
): Promise<{ results: FetchResult[]; papersDir: string }> {
	const warnTo = options.onWarn ?? (() => {});
	const root = options.root ?? outputRoot();
	const papersDir = join(root, "papers");
	mkdirSync(papersDir, { recursive: true });
	const index = loadSidecarIndex(root, warnTo);
	const mailto = options.mailto?.trim() || contactMailto();
	const deps: FetchDeps = {
		fileExists: existsSync,
		saveFile: (path, bytes) => writeFileSync(path, bytes),
		saveMeta: (path, meta) => writeFileSync(path, JSON.stringify(meta, null, 2) + "\n", "utf8"),
		downloadPdf: (url) => downloadPdfReal(url, options.signal),
		unpaywallPdfUrl: (doi) => unpaywallPdfUrlReal(doi, mailto, options.signal),
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
