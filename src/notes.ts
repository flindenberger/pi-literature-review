/**
 * Paper notes on disk: one folder per library paper under <store>/notes/,
 * holding notes.md (front matter + Markdown, see notemd.ts) and the
 * note's images in img/.
 *
 * A folder is named after the paper's library base. When the PDF is
 * renamed (new base), the note is found again by the DOI in its front
 * matter and its folder renamed.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Block, blocksToHtml, escapeHtml, type NoteBackground, NOTE_BACKGROUNDS, noteToMarkdown, parseNote } from "./notemd.ts";

export const NOTES_FILE = "notes.md";
export const NOTE_IMAGE_DIR = "img";
/** Largest notes.md accepted from the page (images are separate files). */
export const NOTE_MAX_BYTES = 2_000_000;
/** Largest single image accepted from the page. */
export const NOTE_IMAGE_MAX_BYTES = 15_000_000;
/** File names of note images: p<page>-<n>.png, pasted-<n>.png/.jpg/... */
export const NOTE_IMAGE_NAME = /^(p\d{1,5}|pasted)-\d{1,5}\.(png|jpe?g|gif|webp)$/;

export interface PaperRef {
	base: string;
	doi?: string;
	title?: string;
}

export interface StoredNote {
	/** Folder name below notes/. */
	dir: string;
	/** The Markdown body without the front matter. */
	markdown: string;
	background: NoteBackground;
	updated: string | null;
}

export function notesRoot(store: string): string {
	return join(store, "notes");
}

/** Folder name for a base: the base itself when it is a safe name, else a
 * cleaned name plus a short hash (unique per base). */
export function noteDirName(base: string): string {
	const clean = base.replace(/[^\p{L}\p{N} ._()-]+/gu, "_").replace(/^[ .]+|[ .]+$/g, "").slice(0, 120);
	if (clean && clean === base) return clean;
	const hash = createHash("sha1").update(base).digest("hex").slice(0, 8);
	return `${clean || "paper"}-${hash}`;
}

function readMeta(dir: string): Record<string, string> {
	try {
		return parseNote(readFileSync(join(dir, NOTES_FILE), "utf8")).meta;
	} catch {
		return {};
	}
}

/** The note folder of a paper, or null when it has no note yet. A note
 * left behind under an older base is moved to the current name when its
 * DOI matches (and no other paper holds that base). */
export function findNoteDir(store: string, paper: PaperRef, liveBases?: Set<string>): string | null {
	const root = notesRoot(store);
	const name = noteDirName(paper.base);
	if (existsSync(join(root, name, NOTES_FILE))) return name;
	const doi = (paper.doi ?? "").toLowerCase();
	if (!doi || !existsSync(root)) return null;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === name) continue;
		const meta = readMeta(join(root, entry.name));
		if ((meta.doi ?? "").toLowerCase() !== doi) continue;
		if (meta.paper && liveBases?.has(meta.paper)) continue;
		if (existsSync(join(root, name))) return null;
		renameSync(join(root, entry.name), join(root, name));
		// The note now belongs to the new base.
		const file = join(root, name, NOTES_FILE);
		const note = parseNote(readFileSync(file, "utf8"));
		writeFileSync(file, noteToMarkdown({ ...note.meta, paper: paper.base }, note.blocks));
		return name;
	}
	return null;
}

export function readNote(store: string, paper: PaperRef, liveBases?: Set<string>): StoredNote | null {
	const dir = findNoteDir(store, paper, liveBases);
	if (!dir) return null;
	const text = readFileSync(join(notesRoot(store), dir, NOTES_FILE), "utf8");
	const { meta, blocks } = parseNote(text);
	const background = NOTE_BACKGROUNDS.includes(meta.background as NoteBackground) ? meta.background as NoteBackground : "blank";
	return { dir, markdown: noteToMarkdown({}, blocks), background, updated: meta.updated || null };
}

/** Save a note from the page: its Markdown is parsed and written again in
 * the canonical form, with the front matter set here (paper, DOI and title
 * from the library, never from the page). Returns the folder name. */
export function writeNote(store: string, paper: PaperRef, markdown: string, background: NoteBackground, liveBases?: Set<string>): { dir: string; updated: string } {
	if (Buffer.byteLength(markdown) > NOTE_MAX_BYTES) throw new Error("note too large");
	const dir = findNoteDir(store, paper, liveBases) ?? noteDirName(paper.base);
	const folder = join(notesRoot(store), dir);
	mkdirSync(folder, { recursive: true });
	const { blocks } = parseNote(markdown);
	const updated = new Date().toISOString();
	const meta = { paper: paper.base, doi: paper.doi ?? "", title: paper.title ?? "", background, updated };
	const file = join(folder, NOTES_FILE);
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, noteToMarkdown(meta, blocks));
	renameSync(temp, file);
	return { dir, updated };
}

const IMAGE_TYPES: Array<[string, (bytes: Buffer) => boolean]> = [
	["png", (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
	["jpg", (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
	["gif", (bytes) => bytes.subarray(0, 4).toString("latin1") === "GIF8"],
	["webp", (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"],
];

/** The image type by its first bytes; null for anything else. */
export function imageType(bytes: Buffer): string | null {
	for (const [type, test] of IMAGE_TYPES) if (bytes.length > 12 && test(bytes)) return type;
	return null;
}

/** Store one image of a note (a PDF clip of `page`, or a pasted image
 * without page); the note folder is created when needed. Returns the path
 * the Markdown refers to ("img/p4-1.png"). */
export function saveNoteImage(store: string, paper: PaperRef, bytes: Buffer, page: number | null, liveBases?: Set<string>): { dir: string; src: string } {
	if (bytes.length > NOTE_IMAGE_MAX_BYTES) throw new Error("image too large");
	const type = imageType(bytes);
	if (!type) throw new Error("not a PNG, JPEG, GIF or WebP image");
	const dir = findNoteDir(store, paper, liveBases) ?? noteDirName(paper.base);
	const folder = join(notesRoot(store), dir, NOTE_IMAGE_DIR);
	mkdirSync(folder, { recursive: true });
	const stem = page && page > 0 ? `p${Math.floor(page)}` : "pasted";
	let n = 1;
	while (existsSync(join(folder, `${stem}-${n}.${type}`))) n += 1;
	const name = `${stem}-${n}.${type}`;
	writeFileSync(join(folder, name), bytes);
	return { dir, src: `${NOTE_IMAGE_DIR}/${name}` };
}

/** The bases that have a note (read from each note's front matter). */
export function notedBases(store: string): string[] {
	const root = notesRoot(store);
	if (!existsSync(root)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const meta = readMeta(join(root, entry.name));
		if (meta.paper) out.push(meta.paper);
	}
	return out;
}

/** Absolute path of a note image, or null when the names are not ones
 * this module writes (no path tricks). */
export function noteImagePath(store: string, dir: string, name: string): string | null {
	if (!NOTE_IMAGE_NAME.test(name) || dir.includes("/") || dir.includes("\\") || dir.startsWith(".") || !dir) return null;
	const file = join(notesRoot(store), dir, NOTE_IMAGE_DIR, name);
	return existsSync(file) ? file : null;
}

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** A note as one file to take away: Markdown or an HTML page, its images
 * inside as data URLs; page links ("#page=N") become plain text, since
 * the PDF is not there. Null when the paper has no note. */
export function exportNote(store: string, paper: PaperRef, format: "md" | "html", liveBases?: Set<string>): { name: string; type: string; body: string } | null {
	const dir = findNoteDir(store, paper, liveBases);
	if (!dir) return null;
	const folder = join(notesRoot(store), dir);
	const { meta, blocks } = parseNote(readFileSync(join(folder, NOTES_FILE), "utf8"));
	const inline = (src: string): string => {
		const name = /^img\/([^/]+)$/.exec(src);
		const file = name ? noteImagePath(store, dir, name[1]) : null;
		if (!file) return src;
		const type = IMAGE_MIME[file.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";
		return `data:${type};base64,${readFileSync(file).toString("base64")}`;
	};
	const plainPages = (list: Block[]): Block[] => list.map((block) => {
		const strip = (runs: Array<{ text: string; href?: string }>) => runs.map((run) => (run.href && /^#page=/.test(run.href) ? { ...run, href: undefined } : run));
		if (block.t === "p" || block.t === "h" || block.t === "quote") return { ...block, c: strip(block.c) };
		if (block.t === "ul" || block.t === "ol") return { ...block, items: block.items.map(strip) };
		if (block.t === "table") return { ...block, rows: block.rows.map((row) => row.map(strip)) };
		if (block.t === "img") return { ...block, page: undefined };
		return block;
	});
	const stem = dir.replace(/-[0-9a-f]{8}$/, "");
	if (format === "md") {
		const body = noteToMarkdown({ paper: meta.paper ?? "", doi: meta.doi ?? "", title: meta.title ?? "", updated: meta.updated ?? "" }, plainPages(blocks).map((block) => (block.t === "img" ? { ...block, src: inline(block.src) } : block)));
		return { name: `${stem} - notes.md`, type: "text/markdown; charset=utf-8", body };
	}
	const title = meta.title || paper.title || paper.base;
	const doi = meta.doi ? `<a href="https://doi.org/${escapeHtml(meta.doi)}">https://doi.org/${escapeHtml(meta.doi)}</a>` : "";
	const updated = meta.updated ? new Date(meta.updated).toISOString().slice(0, 10) : "";
	const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes: ${escapeHtml(title)}</title>
<style>
body { margin: 0; background: #fff; color: #1c1c1c; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 46rem; margin: 2.5rem auto; padding: 0 1.5rem; }
header { border-bottom: 1px solid #d9d9d4; margin-bottom: 1.6rem; padding-bottom: 0.8rem; }
header .kind { font-size: 0.8rem; letter-spacing: 0.06em; text-transform: uppercase; color: #6b6b6b; }
header h1.paper { font-size: 1.3rem; margin: 0.2rem 0 0.3rem; }
header .meta { font-size: 0.85rem; color: #6b6b6b; }
a { color: #1c1c1c; }
h1 { font-size: 1.45rem; } h2 { font-size: 1.2rem; } h3 { font-size: 1.02rem; }
p[data-indent="1"] { padding-left: 2rem; } p[data-indent="2"] { padding-left: 4rem; } p[data-indent="3"] { padding-left: 6rem; }
blockquote { margin: 1rem 0; padding-left: 0.9rem; border-left: 3px solid #c9c9c2; color: #3d3d3d; }
code { font-family: "DejaVu Sans Mono", Consolas, monospace; font-size: 0.88em; background: #f1f1ec; padding: 0 0.2em; }
table { border-collapse: collapse; margin: 1rem 0; } th, td { border: 1px solid #c9c9c2; padding: 0.15rem 0.55rem; text-align: left; vertical-align: top; } th { background: #f4f4f0; }
figure { margin: 1rem 0; } figure img { max-width: 100%; height: auto; border: 1px solid #e4e4de; } figcaption { font-size: 0.8rem; font-style: italic; color: #3d3d3d; }
figcaption:empty { display: none; }
hr { border: 0; border-top: 1px solid #c9c9c2; }
@media print { main { margin: 0 auto; max-width: none; } a { text-decoration: none; } figure, table { break-inside: avoid; } }
</style></head>
<body><main>
<header><div class="kind">Notes</div><h1 class="paper">${escapeHtml(title)}</h1><div class="meta">${[doi, updated ? `updated ${updated}` : ""].filter(Boolean).join(" · ")}</div></header>
${blocksToHtml(plainPages(blocks), inline)}
</main></body></html>
`;
	return { name: `${stem} - notes.html`, type: "text/html; charset=utf-8", body };
}
