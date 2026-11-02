/**
 * Deterministic output locations -- no LLM decides where files land.
 *
 * Results are research data and never live inside the extension package
 * (that folder is code and gets replaced on update). Default root: the
 * store next to the user config (~/.config/pi-literature-review/, Windows
 * %APPDATA%), shared by the terminal tools and the browser; the
 * PI_LITERATURE_REVIEW_HOME environment variable moves it (e.g. "." for a
 * per-project layout in the working directory). The user's PDFs live in
 * their own folders (config pdfFolders), never here. HTML renderings go to
 * <stage>/<YYYY-MM-DD>_<query-slug>.html; a same-day rerun of the same
 * query gets _2, _3, ... appended instead of overwriting. The full JSON
 * payload lands next to the HTML as a .json sidecar with the same basename
 * (the agent model only receives a short digest, so the structured data
 * lives on disk for follow-up steps and for the archive).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { configPath } from "./config.ts";
import { asciiPart, firstAuthorLastName } from "./types.ts";

/** Data root (the store): PI_LITERATURE_REVIEW_HOME when set, else the
 * folder of the user config. Pure via injection for tests. */
export function outputRoot(
	env: Record<string, string | undefined> = process.env,
	platform: string = process.platform,
): string {
	const home = (env.PI_LITERATURE_REVIEW_HOME || "").trim();
	return resolve(home || dirname(configPath(platform, env)));
}

/** "sandbar detection Sentinel-1" -> "sandbar_detection_Sentinel-1". */
export function querySlug(query: string): string {
	const slug = query
		.replace(/[^A-Za-z0-9-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80)
		.replace(/_+$/g, "");
	return slug || "query";
}

/** How many first authors a synthesis report's file name lists. */
const REPORT_NAME_AUTHORS = 3;

/**
 * File-name core of a synthesis report: "synthesis_report_Li_Moortgat_Chen"
 * -- the LAST NAMES of the scope papers' first authors, in scope order, at
 * most REPORT_NAME_AUTHORS of them plus "_et_al" when more papers follow.
 * The names come from the verified records (API data), never from a model;
 * a paper without author data contributes nothing, and when no paper
 * carries a name at all the caller's question slug stands (null).
 */
export function synthReportName(papers: Array<{ authors: string[] }>): string | null {
	const names: string[] = [];
	for (const paper of papers) {
		const name = asciiPart(firstAuthorLastName(paper.authors));
		if (name && !names.includes(name)) names.push(name);
		if (names.length === REPORT_NAME_AUTHORS) break;
	}
	if (!names.length) return null;
	const etAl = papers.length > names.length ? "_et_al" : "";
	return `synthesis_report_${names.join("_")}${etAl}`;
}

/** Pure path builder; collision policy: append _2, _3, ... The subdir
 * separates the pipeline stages (lit-search/, lit-synthesis/) -- same
 * naming and collision rules everywhere. */
export function htmlPathFor(
	root: string,
	generatedIso: string,
	query: string,
	exists: (path: string) => boolean,
	subdir = "lit-search",
): string {
	const date = generatedIso.slice(0, 10);
	const base = join(root, subdir, `${date}_${querySlug(query)}`);
	let candidate = `${base}.html`;
	for (let suffix = 2; exists(candidate); suffix++) {
		candidate = `${base}_${suffix}.html`;
	}
	return candidate;
}

/** Pure: the JSON sidecar always shares the HTML path's basename. */
export function jsonPathFor(htmlPath: string): string {
	return htmlPath.replace(/\.html?$/i, "") + ".json";
}

/**
 * Write the HTML rendering plus the full JSON payload as a sidecar with the
 * same basename, and return both paths. Without an explicit override the
 * deterministic default location is used; the collision policy (_2, _3, ...)
 * considers both files so the pair always shares one suffix. Directories are
 * created as needed. nameOverride replaces the query/question as the file
 * name's core (synthesis reports name their papers' first authors).
 */
export function writeRunOutputs(
	html: string,
	payload: { query?: string; question?: string; generated: string },
	explicitHtmlPath?: string,
	subdir = "lit-search",
	nameOverride?: string | null,
): { htmlPath: string; jsonPath: string } {
	const pairExists = (path: string) => existsSync(path) || existsSync(jsonPathFor(path));
	const name = nameOverride || payload.query || payload.question || "output";
	const htmlPath = explicitHtmlPath?.trim()
		? resolve(explicitHtmlPath.trim())
		: htmlPathFor(outputRoot(), payload.generated, name, pairExists, subdir);
	const jsonPath = jsonPathFor(htmlPath);
	mkdirSync(dirname(htmlPath), { recursive: true });
	writeFileSync(htmlPath, html, "utf8");
	writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
	return { htmlPath, jsonPath };
}
