/**
 * Deterministic output locations -- no LLM decides where files land.
 *
 * Query results are research data and never belong inside the extension
 * package (that folder is code and gets replaced on update). Default root:
 * <working directory>/pi-literature-review, overridable via the
 * PI_LITERATURE_REVIEW_HOME environment variable. HTML renderings go to
 * queries/<YYYY-MM-DD>_<query-slug>.html; a same-day rerun of the same
 * query gets _2, _3, ... appended instead of overwriting. The full JSON
 * payload lands next to the HTML as a .json sidecar with the same basename
 * (the agent model only receives a short digest, so the structured data has
 * to live on disk for follow-up steps and for the archive). PDF downloads
 * (Phase 3) will join as papers/, one shared library keyed by DOI/arXiv ID
 * so the same paper is never stored twice.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function outputRoot(): string {
	const home = (process.env.PI_LITERATURE_REVIEW_HOME || "").trim();
	return resolve(home || join(process.cwd(), "pi-literature-review"));
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

/** Pure path builder; collision policy: append _2, _3, ... */
export function htmlPathFor(
	root: string,
	generatedIso: string,
	query: string,
	exists: (path: string) => boolean,
): string {
	const date = generatedIso.slice(0, 10);
	const base = join(root, "queries", `${date}_${querySlug(query)}`);
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
 * created as needed.
 */
export function writeRunOutputs(
	html: string,
	payload: { query: string; generated: string },
	explicitHtmlPath?: string,
): { htmlPath: string; jsonPath: string } {
	const pairExists = (path: string) => existsSync(path) || existsSync(jsonPathFor(path));
	const htmlPath = explicitHtmlPath?.trim()
		? resolve(explicitHtmlPath.trim())
		: htmlPathFor(outputRoot(), payload.generated, payload.query, pairExists);
	const jsonPath = jsonPathFor(htmlPath);
	mkdirSync(dirname(htmlPath), { recursive: true });
	writeFileSync(htmlPath, html, "utf8");
	writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
	return { htmlPath, jsonPath };
}
