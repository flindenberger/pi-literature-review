/**
 * Paper notes as a small block model and its Markdown form.
 *
 * The notepad editor in the browser reads its content into blocks
 * (headings, paragraphs, lists, quotes, images, tables) and back; this
 * module turns blocks into Markdown for the notes.md file and parses that
 * file again. It has no imports, so the browser loads a generated copy
 * (static/notemd.mjs, see src/web/static-gen.ts) and both sides follow the
 * same rules.
 *
 * Supported Markdown: front matter, # to ### headings, paragraphs,
 * **bold**, *italic*, `code`, [links](href), > quotes, - and 1. lists
 * (nested up to MAX_LEVEL), ![images](src "page N"), GFM tables, ---.
 * An indented paragraph starts with two em spaces (U+2003) per level:
 * plain text that other Markdown readers show indented too.
 */

export type Inline = { text: string; b?: boolean; i?: boolean; code?: boolean; href?: string };

export type Block =
	| { t: "p"; c: Inline[]; indent?: number }
	| { t: "h"; level: 1 | 2 | 3; c: Inline[] }
	| { t: "quote"; c: Inline[] }
	| { t: "ul" | "ol"; items: Inline[][]; levels?: number[] }
	| { t: "img"; src: string; alt: string; page?: number }
	| { t: "table"; rows: Inline[][][] }
	| { t: "hr" };

export type NoteMeta = Record<string, string>;

/** Deepest list nesting and paragraph indent (0 = none). */
export const MAX_LEVEL = 3;
const INDENT = "\u2003\u2003";
const clampLevel = (value: number) => Math.max(0, Math.min(MAX_LEVEL, Math.floor(value)));

export type NoteBackground = "blank" | "lined" | "grid";
export const NOTE_BACKGROUNDS: NoteBackground[] = ["blank", "lined", "grid"];

/* ---------------- inline runs ---------------- */

const sameFormat = (a: Inline, b: Inline) => Boolean(a.b) === Boolean(b.b) && Boolean(a.i) === Boolean(b.i) && Boolean(a.code) === Boolean(b.code) && (a.href ?? "") === (b.href ?? "");

/** Adjacent runs with the same format joined, empty runs dropped. */
export function normalizeInlines(runs: Inline[]): Inline[] {
	const out: Inline[] = [];
	for (const run of runs) {
		if (!run.text) continue;
		const clean: Inline = { text: run.text };
		if (run.code) clean.code = true;
		else {
			if (run.b) clean.b = true;
			if (run.i) clean.i = true;
		}
		if (run.href) clean.href = run.href;
		const last = out[out.length - 1];
		if (last && sameFormat(last, clean)) last.text += clean.text;
		else out.push(clean);
	}
	return out;
}

function escapeText(text: string): string {
	return text.replace(/[\\`*_[\]<]/g, (char) => `\\${char}`);
}

/** One run as Markdown; spaces at the run's edges stay outside the markers
 * (CommonMark does not open emphasis next to a space). */
function inlineToMd(run: Inline): string {
	if (run.code) {
		const ticks = run.text.includes("`") ? "``" : "`";
		const pad = run.text.startsWith("`") || run.text.endsWith("`") ? " " : "";
		const body = `${ticks}${pad}${run.text}${pad}${ticks}`;
		return run.href ? `[${body}](${escapeHref(run.href)})` : body;
	}
	const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text) as RegExpExecArray;
	const [, lead, core, tail] = match;
	if (!core) return run.text;
	let body = escapeText(core);
	if (run.b && run.i) body = `***${body}***`;
	else if (run.b) body = `**${body}**`;
	else if (run.i) body = `*${body}*`;
	if (run.href) body = `[${body}](${escapeHref(run.href)})`;
	return `${lead}${body}${tail}`;
}

function escapeHref(href: string): string {
	return href.replace(/[\s()<>]/g, (char) => encodeURIComponent(char));
}

export function inlinesToMd(runs: Inline[]): string {
	return normalizeInlines(runs).map(inlineToMd).join("");
}

/** Markdown inline text to runs (the subset written by inlinesToMd). */
export function parseInlines(source: string): Inline[] {
	const out: Inline[] = [];
	const state = { b: false, i: false, href: "" };
	let text = "";
	const flush = () => {
		if (!text) return;
		out.push({ text, ...(state.b ? { b: true } : {}), ...(state.i ? { i: true } : {}), ...(state.href ? { href: state.href } : {}) });
		text = "";
	};
	let pos = 0;
	// True while the text of a link is parsed (links do not nest).
	let linkOpen = false;
	while (pos < source.length) {
		const char = source[pos];
		if (char === "\\" && pos + 1 < source.length && /[\\`*_[\]<>#|\-+.!()]/.test(source[pos + 1])) {
			text += source[pos + 1];
			pos += 2;
			continue;
		}
		if (char === "`") {
			const ticks = source.startsWith("``", pos) ? "``" : "`";
			const end = source.indexOf(ticks, pos + ticks.length);
			if (end > pos) {
				flush();
				let body = source.slice(pos + ticks.length, end);
				if (body.length > 1 && body.startsWith(" ") && body.endsWith(" ")) body = body.slice(1, -1);
				out.push({ text: body, code: true, ...(state.href ? { href: state.href } : {}) });
				pos = end + ticks.length;
				continue;
			}
		}
		if (char === "[" && !linkOpen) {
			const close = findLinkEnd(source, pos);
			if (close) {
				flush();
				linkOpen = true;
				state.href = close.href;
				const inner = parseInlines(source.slice(pos + 1, close.textEnd));
				for (const run of inner) {
					out.push({ ...run, ...(state.b ? { b: true } : {}), ...(state.i ? { i: true } : {}), href: close.href });
				}
				state.href = "";
				linkOpen = false;
				pos = close.end;
				continue;
			}
		}
		if (char === "*" || char === "_") {
			let count = 1;
			while (source[pos + count] === char && count < 3) count += 1;
			const before = source[pos - 1] ?? " ";
			const after = source[pos + count] ?? " ";
			// Underscores inside a word stay text (snake_case).
			if (char === "_" && /\w/.test(before) && /\w/.test(after)) {
				text += source.slice(pos, pos + count);
				pos += count;
				continue;
			}
			const opens = !/\s/.test(after);
			const closes = !/\s/.test(before);
			if (opens || closes) {
				flush();
				if (count === 3) { state.b = !state.b; state.i = !state.i; }
				else if (count === 2) state.b = !state.b;
				else state.i = !state.i;
				pos += count;
				continue;
			}
		}
		text += char;
		pos += 1;
	}
	flush();
	return normalizeInlines(out);
}

/** "[text](href)" starting at `open`: where the text ends and the href. */
function findLinkEnd(source: string, open: number): { textEnd: number; href: string; end: number } | null {
	let depth = 0;
	for (let pos = open; pos < source.length; pos += 1) {
		const char = source[pos];
		if (char === "\\") { pos += 1; continue; }
		if (char === "[") depth += 1;
		if (char === "]") {
			depth -= 1;
			if (depth === 0) {
				if (source[pos + 1] !== "(") return null;
				const close = source.indexOf(")", pos + 2);
				if (close < 0) return null;
				const raw = source.slice(pos + 2, close).trim();
				let href = raw;
				try { href = decodeURIComponent(raw); } catch { /* keep raw */ }
				return { textEnd: pos, href, end: close + 1 };
			}
		}
	}
	return null;
}

/* ---------------- blocks ---------------- */

function escapeLineStart(line: string): string {
	return line.replace(/^(\s*)(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|---|\|)/, (_all, space: string, mark: string) => `${space}\\${mark}`);
}

/** A cell in a table row: backslash and "|" escaped for the row (splitRow
 * undoes exactly this before the cell's inline Markdown is read). */
function tableCell(runs: Inline[]): string {
	return inlinesToMd(runs).replace(/[\\|]/g, (char) => `\\${char}`).replace(/\n/g, " ");
}

function blockToMd(block: Block): string {
	switch (block.t) {
		case "p": return INDENT.repeat(clampLevel(block.indent ?? 0)) + inlinesToMd(block.c).split("\n").map(escapeLineStart).join("  \n");
		case "h": return `${"#".repeat(block.level)} ${inlinesToMd(block.c).replace(/\n/g, " ")}`;
		case "quote": return inlinesToMd(block.c).split("\n").map((line) => `> ${escapeLineStart(line)}`.trimEnd()).join("  \n");
		case "ul":
		case "ol": {
			// Nested items: two spaces per level under "-", three under "1.";
			// numbers count per level and start again under a new parent.
			const counters = [0, 0, 0, 0];
			return block.items.map((item, index) => {
				const level = clampLevel(block.levels?.[index] ?? 0);
				counters[level] += 1;
				for (let deeper = level + 1; deeper < counters.length; deeper += 1) counters[deeper] = 0;
				const text = escapeLineStart(inlinesToMd(item).replace(/\n/g, " "));
				return block.t === "ul" ? `${"  ".repeat(level)}- ${text}` : `${"   ".repeat(level)}${counters[level]}. ${text}`;
			}).join("\n");
		}
		case "img": {
			const alt = block.alt.replace(/[[\]\\]/g, (char) => `\\${char}`).replace(/\n/g, " ");
			const title = block.page ? ` "page ${block.page}"` : "";
			return `![${alt}](${escapeHref(block.src)}${title})`;
		}
		case "table": {
			const width = Math.max(1, ...block.rows.map((row) => row.length));
			const line = (row: Inline[][]) => `| ${Array.from({ length: width }, (_, index) => tableCell(row[index] ?? [])).join(" | ")} |`;
			const [head = [], ...body] = block.rows;
			return [line(head), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
		}
		case "hr": return "---";
	}
}

/** The note as Markdown: front matter, then the blocks, one blank line apart. */
export function noteToMarkdown(meta: NoteMeta, blocks: Block[]): string {
	const keys = Object.keys(meta).filter((key) => /^[a-z][a-z0-9_]*$/.test(key) && meta[key] !== "");
	const front = keys.length ? `---\n${keys.map((key) => `${key}: ${JSON.stringify(String(meta[key]))}`).join("\n")}\n---\n\n` : "";
	const body = blocks.map(blockToMd).filter((text) => text !== "").join("\n\n");
	return `${front}${body}\n`;
}

const LIST_ITEM = /^\s{0,3}([-+*]|\d+[.)])\s+(.*)$/;
const NESTED_ITEM = /^( {0,12})([-+*]|\d+[.)])\s+(.*)$/;

/** Parse a notes.md file (or any Markdown in the supported subset). */
export function parseNote(markdown: string): { meta: NoteMeta; blocks: Block[] } {
	const meta: NoteMeta = {};
	let text = markdown.replace(/\r\n?/g, "\n");
	const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	if (front) {
		for (const line of front[1].split("\n")) {
			const match = /^([a-z][a-z0-9_]*):\s*(.*)$/.exec(line);
			if (!match) continue;
			let value = match[2].trim();
			if (value.startsWith("\"")) { try { value = JSON.parse(value); } catch { /* keep as written */ } }
			meta[match[1]] = value;
		}
		text = text.slice(front[0].length);
	}
	const lines = text.split("\n");
	const blocks: Block[] = [];
	let index = 0;
	const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
	const isRule = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes("|");
	const startsBlock = (line: string) => /^\s*$/.test(line) || /^#{1,3}\s/.test(line) || /^\s*>/.test(line) || LIST_ITEM.test(line) || /^\s*!\[/.test(line) || /^\s*(-{3,}|\*{3,})\s*$/.test(line) || isTableRow(line);
	while (index < lines.length) {
		const line = lines[index];
		if (/^\s*$/.test(line)) { index += 1; continue; }
		const heading = /^(#{1,3})\s+(.*)$/.exec(line);
		if (heading) {
			blocks.push({ t: "h", level: heading[1].length as 1 | 2 | 3, c: parseInlines(heading[2].trim()) });
			index += 1;
			continue;
		}
		if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push({ t: "hr" }); index += 1; continue; }
		const image = /^\s*!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/.exec(line);
		if (image) {
			let src = image[2];
			try { src = decodeURIComponent(src); } catch { /* keep */ }
			const page = /^page (\d+)$/.exec(image[3] ?? "");
			blocks.push({ t: "img", src, alt: image[1].replace(/\\(.)/g, "$1"), ...(page ? { page: Number(page[1]) } : {}) });
			index += 1;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const parts: string[] = [];
			while (index < lines.length && /^\s*>/.test(lines[index])) {
				parts.push(lines[index].replace(/^\s*>\s?/, ""));
				index += 1;
			}
			blocks.push({ t: "quote", c: parseInlines(joinHardBreaks(parts)) });
			continue;
		}
		const item = LIST_ITEM.exec(line);
		if (item) {
			const ordered = /\d/.test(item[1]);
			const items: Inline[][] = [];
			const levels: number[] = [];
			while (index < lines.length) {
				const next = NESTED_ITEM.exec(lines[index]);
				if (!next) break;
				const nextOrdered = /\d/.test(next[2]);
				const level = clampLevel(next[1].length / (nextOrdered ? 3 : 2));
				// A list of the other kind at the top starts a new list.
				if (level === 0 && nextOrdered !== ordered) break;
				items.push(parseInlines(next[3]));
				levels.push(Math.min(level, (levels[levels.length - 1] ?? -1) + 1));
				index += 1;
			}
			blocks.push({ t: ordered ? "ol" : "ul", items, ...(levels.some((level) => level > 0) ? { levels } : {}) });
			continue;
		}
		if (isTableRow(line) && index + 1 < lines.length && isRule(lines[index + 1])) {
			const rows: Inline[][][] = [splitRow(line)];
			index += 2;
			while (index < lines.length && isTableRow(lines[index])) {
				rows.push(splitRow(lines[index]));
				index += 1;
			}
			blocks.push({ t: "table", rows });
			continue;
		}
		const parts: string[] = [line];
		index += 1;
		while (index < lines.length && !startsBlock(lines[index])) {
			parts.push(lines[index]);
			index += 1;
		}
		const lead = /^((?:\u2003\u2003)+)/.exec(parts[0]);
		const indent = lead ? clampLevel(lead[1].length / 2) : 0;
		if (lead) parts[0] = parts[0].slice(lead[1].length);
		blocks.push({ t: "p", c: parseInlines(joinHardBreaks(parts)), ...(indent ? { indent } : {}) });
	}
	return { meta, blocks };
}

/** Lines of one paragraph: "  " or "\" at a line end is a line break, a
 * plain newline a space. */
function joinHardBreaks(parts: string[]): string {
	return parts.map((part, index) => {
		if (index === parts.length - 1) return part;
		if (/ {2,}$/.test(part)) return `${part.replace(/ +$/, "")}\n`;
		if (/\\$/.test(part)) return `${part.slice(0, -1)}\n`;
		return `${part} `;
	}).join("");
}

function splitRow(line: string): Inline[][] {
	const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let cell = "";
	for (let pos = 0; pos < inner.length; pos += 1) {
		if (inner[pos] === "\\" && (inner[pos + 1] === "|" || inner[pos + 1] === "\\")) { cell += inner[pos + 1]; pos += 1; continue; }
		if (inner[pos] === "|") { cells.push(cell); cell = ""; continue; }
		cell += inner[pos];
	}
	cells.push(cell);
	return cells.map((text) => parseInlines(text.trim()));
}

/* ---------------- HTML (export and editor) ---------------- */

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] as string);
}

/** Links a note may hold: web pages, mail, and "#page=N" jumps into the paper. */
export function safeHref(href: string): string | null {
	return /^(https?:|mailto:|#page=\d+$)/i.test(href) ? href : null;
}

export function inlinesToHtml(runs: Inline[]): string {
	return normalizeInlines(runs).map((run) => {
		let html = escapeHtml(run.text).replace(/\n/g, "<br>");
		if (run.code) html = `<code>${html}</code>`;
		if (run.i) html = `<em>${html}</em>`;
		if (run.b) html = `<strong>${html}</strong>`;
		const href = run.href ? safeHref(run.href) : null;
		if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`;
		return html;
	}).join("");
}

/** A list with nested levels as nested HTML lists (an inner list sits
 * in the item before it). */
function listHtml(tag: "ul" | "ol", items: Inline[][], levels: number[] = []): string {
	let html = "";
	let depth = 0;
	items.forEach((item, index) => {
		const level = Math.min(clampLevel(levels[index] ?? 0), depth + (index ? 1 : 0));
		if (index === 0) html += `<${tag}>`;
		else if (level > depth) html += `<${tag}>`.repeat(level - depth);
		else {
			html += `</li>${`</${tag}></li>`.repeat(depth - level)}`;
		}
		depth = level;
		html += `<li>${inlinesToHtml(item)}`;
	});
	return items.length ? `${html}</li>${`</${tag}></li>`.repeat(depth)}</${tag}>` : "";
}

/** Blocks as HTML; `imageUrl` maps a note's image path to what the page loads. */
export function blocksToHtml(blocks: Block[], imageUrl: (src: string) => string = (src) => src): string {
	return blocks.map((block) => {
		switch (block.t) {
			case "p": return `<p${block.indent ? ` data-indent="${clampLevel(block.indent)}"` : ""}>${inlinesToHtml(block.c) || "<br>"}</p>`;
			case "h": return `<h${block.level}>${inlinesToHtml(block.c)}</h${block.level}>`;
			case "quote": return `<blockquote>${inlinesToHtml(block.c)}</blockquote>`;
			case "ul":
			case "ol": return listHtml(block.t, block.items, block.levels);
			case "img": {
				const caption = block.page ? `<a href="#page=${block.page}">${escapeHtml(block.alt)}</a>` : escapeHtml(block.alt);
				return `<figure data-src="${escapeHtml(block.src)}"${block.page ? ` data-page="${block.page}"` : ""}><img src="${escapeHtml(imageUrl(block.src))}" alt="${escapeHtml(block.alt)}"><figcaption>${caption}</figcaption></figure>`;
			}
			case "table": {
				const [head = [], ...body] = block.rows;
				const cells = (row: Inline[][], tag: string) => row.map((cell) => `<${tag}>${inlinesToHtml(cell)}</${tag}>`).join("");
				return `<table><thead><tr>${cells(head, "th")}</tr></thead><tbody>${body.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table>`;
			}
			case "hr": return "<hr>";
		}
	}).join("\n");
}
