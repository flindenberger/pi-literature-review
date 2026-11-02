/**
 * Where the PDF library comes from, and where the metadata of each PDF is
 * kept.
 *
 * Sources, in this order (the earlier one wins on a duplicate file name):
 *   1. the legacy places, read flat: <root>/lit-selection, <cwd>/lit-selection,
 *      <cwd>/pi-literature-review/lit-selection, loose PDFs in <cwd>
 *      (papersDirs in corpus.ts)
 *   2. <root>/inbox -- PDFs dropped onto the browser page
 *   3. the user's PDF folders (config pdfFolders), read RECURSIVELY with
 *      their sub-structure: own folders, Zotero storage/, Citavi
 *      attachments alike. Hidden folders are skipped, links are not
 *      followed, depth and file count are capped.
 * The user's folders are never written to: the metadata twin of a PDF
 * (title, authors, DOI ... from the APIs) lives in <root>/meta/, named by
 * a hash of the PDF's absolute path. A twin right next to a PDF (older
 * downloads into lit-selection/) is still read first.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Deepest folder level read below a PDF folder. */
export const MAX_DEPTH = 8;
/** Most directory entries looked at per PDF folder (a guard against a home
 * folder given by mistake). */
export const MAX_ENTRIES = 50_000;
/** Folders never descended into (program data, not papers). */
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "$RECYCLE.BIN", "System Volume Information"]);

export interface PdfWalk {
	/** Absolute paths of the PDFs, sorted. */
	files: string[];
	/** True when a cap stopped the walk early. */
	truncated: boolean;
}

/** Every PDF below a folder (recursive, capped). A missing folder gives
 * an empty walk. */
export function walkPdfs(dir: string, maxDepth = MAX_DEPTH, maxEntries = MAX_ENTRIES): PdfWalk {
	const files: string[] = [];
	let seen = 0;
	let truncated = false;
	const visit = (folder: string, depth: number) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(folder, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (++seen > maxEntries) { truncated = true; return; }
			if (entry.name.startsWith(".")) continue;
			const path = join(folder, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				if (depth >= maxDepth) { truncated = true; continue; }
				visit(path, depth + 1);
				if (seen > maxEntries) return;
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
				files.push(path);
			}
		}
	};
	visit(resolve(dir), 0);
	return { files: files.sort(), truncated };
}

/** PDFs directly in a folder (no recursion). */
export function flatPdfs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
			.map((entry) => join(dir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

/** The folder dropped PDFs land in. */
export function inboxDir(root: string): string {
	return join(root, "inbox");
}

/** The metadata store. */
export function metaDir(root: string): string {
	return join(root, "meta");
}

/** Twin file in the store for a PDF path. Pure. */
export function metaPath(root: string, pdfPath: string): string {
	const hash = createHash("sha1").update(resolve(pdfPath)).digest("hex").slice(0, 20);
	return join(metaDir(root), `${hash}.json`);
}

/** The PDF's metadata twin: next to the PDF first (older downloads), then
 * the store. Null when there is none (or it is unreadable). */
export function readTwin(root: string, pdfPath: string): Record<string, unknown> | null {
	for (const path of [pdfPath.replace(/\.pdf$/i, ".json"), metaPath(root, pdfPath)]) {
		try {
			const twin = JSON.parse(readFileSync(path, "utf8"));
			if (twin && typeof twin === "object") return twin as Record<string, unknown>;
		} catch {
			// next place
		}
	}
	return null;
}

/** Write a twin into the store (never next to the PDF). The PDF path is
 * kept in the twin for orientation. */
export function writeTwin(root: string, pdfPath: string, meta: object): string {
	const path = metaPath(root, pdfPath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ ...meta, pdf_path: resolve(pdfPath) }, null, 2) + "\n", "utf8");
	return path;
}

/** The store-writing twin saver for code that still names a twin by the
 * PDF's ".json" sibling path (fetch and adoption): the sibling name is
 * turned back into the PDF path, the twin goes to the store. */
export function twinSaver(root: string): (siblingJsonPath: string, meta: object) => void {
	return (siblingJsonPath, meta) => { writeTwin(root, siblingJsonPath.replace(/\.json$/i, ".pdf"), meta); };
}

/** A PDF's display base: its file name without ".pdf". */
export function pdfBase(path: string): string {
	return basename(path).replace(/\.pdf$/i, "");
}
