/* The notepad: one note per library paper, written in place of the chat
   while the paper's PDF stays open in the panel. The editor is a
   contenteditable area; its content is read into blocks and saved as
   Markdown (notemd.mjs, the same rules the server uses), images as files
   next to the note. Lists, quotes, tables, lines and figures are built by
   this script (the browser's own commands nest them unpredictably), so it
   keeps its own undo history too. app.js loads this module on first use
   and passes the few things it shares (createNotes(app)). */

const query = new URL(import.meta.url).search;
const { blocksToHtml, MAX_LEVEL, noteToMarkdown, parseNote, safeHref } = await import(`./notemd.mjs${query}`);

const SAVE_DELAY_MS = 800;
/** Typing within this time is one undo step. */
const UNDO_GROUP_MS = 700;
const UNDO_LIMIT = 200;
/** Zero-width space: holds the caret just after inline code. */
const ZWSP = "​";

const svg = (body, width = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const BACKGROUNDS = [
	["blank", "Blank page", svg('<rect x="5" y="3.5" width="14" height="17" rx="1.5"/>', 1.6)],
	["lined", "Lined page", svg('<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M8 8.5h8M8 12h8M8 15.5h8"/>', 1.6)],
	["grid", "Grid page", svg('<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M5 9h14M5 15h14M9.7 3.5v17M14.3 3.5v17"/>', 1.4)],
];
/** Toolbar: [command, label (HTML), tooltip]; "|" separates groups. */
const TOOLS = [
	["undo", svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'), "Undo (Ctrl+Z)"],
	["redo", svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'), "Redo (Ctrl+Shift+Z)"],
	["|"],
	["p", '<span class="tp">T</span>', "Normal text"],
	["h1", '<span class="th1">H1</span>', "Heading (type # and a space)"],
	["h2", '<span class="th2">H2</span>', "Subheading (##)"],
	["h3", '<span class="th3">H3</span>', "Small heading (###)"],
	["|"],
	["bold", '<span class="tb">B</span>', "Bold (Ctrl+B)"],
	["italic", '<span class="ti">I</span>', "Italic (Ctrl+I)"],
	["code", '<span class="mono">&lt;/&gt;</span>', "Code: marks the selected text; pressed again inside code, it goes on writing after it"],
	["|"],
	["ul", svg('<path d="M10 7h10M10 12h10M10 17h10"/><circle cx="5" cy="7" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="17" r="1" fill="currentColor"/>'), "List (- and a space; Enter twice ends it)"],
	["ol", svg('<path d="M10 7h10M10 12h10M10 17h10"/><path d="M4 5.5l1.2-.7v4M3.8 13.3c.4-.6 1.9-.7 1.9.4 0 .8-1.9 1.6-1.9 2.3h2" stroke-width="1.3"/>'), "Numbered list (1. and a space; Enter twice ends it)"],
	["outdent", svg('<path d="M11 6h9M11 12h9M11 18h9M7 9l-3 3 3 3"/>'), "Outdent (Shift+Tab)"],
	["indent", svg('<path d="M11 6h9M11 12h9M11 18h9M4 9l3 3-3 3"/>'), "Indent (Tab); in a list it nests the item"],
	["table", svg('<rect x="3.5" y="5" width="17" height="14" rx="1"/><path d="M3.5 10h17M3.5 14.5h17M9.5 5v14M15 5v14"/>', 1.6), "Table tools"],
	["hr", svg('<path d="M4 12h16"/>'), "Divider line"],
	["|"],
	["clip", svg('<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.3l1.5-2.2h7.4L17.2 7h2.3A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.4"/>'), "Clip from the PDF: drag a rectangle over the page (Esc cancels)"],
	["cite", svg('<path d="M7 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6"/>'), "Quote the text selected in the PDF, with its page"],
	["facts", svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M5.5 16c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4M14 9.5h4.5M14 12.5h4.5M14 15.5h3"/>', 1.6), "Insert the paper's details: title, authors, year, journal, DOI, citations"],
];
/** Shown while the caret is in a table. */
const TABLE_TOOLS = [
	["tableInsert", svg('<rect x="3.5" y="5" width="13" height="11" rx="1"/><path d="M3.5 9.5h13M8 5v11M12.5 5v11M19 15v6M16 18h6"/>', 1.6), "Insert a table (Tab moves to the next cell, a new row at the end)"],
	["|"],
	["rowBelow", svg('<rect x="4" y="4" width="16" height="9" rx="1"/><path d="M12 15v6M9 18h6"/>', 1.6), "Insert a row below"],
	["colRight", svg('<rect x="4" y="4" width="9" height="16" rx="1"/><path d="M15 12h6M18 9v6"/>', 1.6), "Insert a column right"],
	["|"],
	["rowDelete", svg('<rect x="4" y="8" width="16" height="8" rx="1"/><path d="M9.5 10.5l5 3M14.5 10.5l-5 3"/>', 1.6), "Delete this row"],
	["colDelete", svg('<rect x="8" y="4" width="8" height="16" rx="1"/><path d="M10.5 9.5l3 5M13.5 9.5l-3 5"/>', 1.6), "Delete this column"],
	["|"],
	["tableDelete", svg('<rect x="3.5" y="5" width="17" height="14" rx="1"/><path d="M3.5 10h17M9.5 5v14M13 13l5 5M18 13l-5 5"/>', 1.6), "Delete the table"],
];
const BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "UL", "OL", "LI", "FIGURE", "TABLE", "HR", "PRE"]);

export function createNotes(app) {
	const $ = (id) => document.getElementById(id);
	const section = $("notes");
	const paper = $("notes-paper");
	const esc = app.esc;
	const note = { base: null, dir: null, background: "blank", dirty: false, timer: 0, saving: null, loadSeq: 0 };
	/** The table row of the toolbar, opened by the table button. */
	let tableRowOpen = false;

	/* ---------------- toolbar ---------------- */
	const buttons = (list) => list.map(([command, label, tip]) => command === "|" ? '<span class="sep"></span>' : `<button type="button" data-cmd="${command}" title="${esc(tip)}" aria-label="${esc(tip)}">${label}</button>`).join("");
	$("notes-tools").innerHTML = buttons(TOOLS);
	$("notes-tabletools").innerHTML = buttons(TABLE_TOOLS);
	$("notes-bg").innerHTML = BACKGROUNDS.map(([name, tip, icon]) => `<button type="button" data-bg="${name}" title="${esc(tip)}" aria-label="${esc(tip)}">${icon}</button>`).join("");
	// Toolbar buttons must not take the caret out of the page.
	for (const bar of [section.querySelector(".notes-bar"), $("notes-bg")]) bar.addEventListener("mousedown", (event) => { if (event.target.closest("button")) event.preventDefault(); });
	section.querySelector(".notes-bar").addEventListener("click", (event) => {
		const button = event.target.closest("[data-cmd]");
		if (!button || !note.base) return;
		const name = button.dataset.cmd;
		if (name === "undo") return undo(-1);
		if (name === "redo") return undo(1);
		if (name === "clip") return clip();
		if (name === "table") { tableRowOpen = !tableRowOpen; syncTools(); return; }
		if (name === "cite") return citeSelection();
		if (name === "facts") return insertFacts();
		if (!paper.contains(getSelection().anchorNode)) placeCaret(paper.lastElementChild || paper, true);
		paper.focus();
		commit();
		command(name);
		changed();
		commit();
		syncTools();
	});
	$("notes-bg").addEventListener("click", (event) => {
		const button = event.target.closest("[data-bg]");
		if (!button) return;
		setBackground(button.dataset.bg);
		try { localStorage.setItem("plr-notes-bg", note.background); } catch { /* private window */ }
		changed();
	});
	function setBackground(name) {
		note.background = BACKGROUNDS.some(([value]) => value === name) ? name : "blank";
		paper.dataset.bg = note.background;
		for (const button of $("notes-bg").querySelectorAll("[data-bg]")) button.classList.toggle("on", button.dataset.bg === note.background);
	}
	/** Pressed buttons follow the caret: block kind, bold, italic, code, table. */
	function syncTools() {
		const selection = getSelection();
		const inside = note.base && selection.rangeCount && paper.contains(selection.anchorNode);
		const node = inside ? (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement) : null;
		const block = inside ? currentBlock() : null;
		const on = {
			p: Boolean(block && block.tagName === "P" && !block.closest("blockquote, li, td, th")),
			h1: Boolean(node && node.closest("h1")),
			h2: Boolean(node && node.closest("h2")),
			h3: Boolean(node && node.closest("h3")),
			bold: Boolean(inside && !(node && node.closest("h1, h2, h3, th")) && document.queryCommandState("bold")),
			italic: Boolean(inside && document.queryCommandState("italic")),
			code: Boolean(node && node.closest("code")),
			ul: Boolean(node && node.closest("ul")),
			ol: Boolean(node && node.closest("ol")),
		};
		for (const button of $("notes-tools").querySelectorAll("[data-cmd]")) button.classList.toggle("on", Boolean(on[button.dataset.cmd]));
		const table = node && node.closest("table");
		const showTable = Boolean(table) || tableRowOpen;
		$("notes-tabletools").hidden = !showTable;
		$("notes-tools").querySelector('[data-cmd="table"]').classList.toggle("on", showTable);
		for (const button of $("notes-tabletools").querySelectorAll("[data-cmd]")) if (button.dataset.cmd !== "tableInsert") button.disabled = !table;
		const [back, forward] = [history.index > 0 || note.pending, history.index < history.steps.length - 1];
		$("notes-tools").querySelector('[data-cmd="undo"]').disabled = !back;
		$("notes-tools").querySelector('[data-cmd="redo"]').disabled = !forward;
	}
	document.addEventListener("selectionchange", () => { if (!section.hidden) { syncTools(); placeAiButton(); } });

	/* ---------------- export ---------------- */
	const exportMenu = $("notes-export-menu");
	const setExportMenu = (open) => {
		exportMenu.hidden = !open;
		$("btn-notes-export").setAttribute("aria-expanded", String(open));
	};
	$("btn-notes-export").addEventListener("click", (event) => {
		event.stopPropagation();
		const folder = exportMenu.querySelector('[data-export="folder"]');
		folder.hidden = Boolean(app.demo && app.demo());
		setExportMenu(exportMenu.hidden);
	});
	document.addEventListener("click", (event) => { if (!exportMenu.hidden && !event.target.closest(".notes-export")) setExportMenu(false); });
	document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !exportMenu.hidden) setExportMenu(false); });
	exportMenu.addEventListener("click", async (event) => {
		const item = event.target.closest("[data-export]");
		if (!item || !note.base) return;
		setExportMenu(false);
		commit();
		note.dirty = note.dirty || note.pending;
		await save();
		const kind = item.dataset.export;
		const address = (format, inline = false) => `${app.BASE}/api/notes/export?base=${encodeURIComponent(note.base)}&format=${format}${inline ? "&inline=1" : ""}`;
		if (kind === "md" || kind === "html") {
			const link = document.createElement("a");
			link.href = address(kind);
			link.download = "";
			document.body.appendChild(link);
			link.click();
			link.remove();
		} else if (kind === "pdf") {
			// The browser's print window; "Save as PDF" there writes the file.
			const view = window.open(address("html", true), "_blank");
			if (!view) { app.toast("The print view was blocked: allow pop-ups for this page."); return; }
			view.addEventListener("load", () => setTimeout(() => view.print(), 150));
		} else if (kind === "folder") {
			try {
				await app.post(`${app.BASE}/api/reveal`, { path: note.folder });
			} catch (error) { app.toast(error.message); }
		}
	});

	/* ---------------- commands ---------------- */
	function command(name) {
		document.execCommand("styleWithCSS", false, false);
		wrapLoose();
		if (["p", "h1", "h2", "h3"].includes(name)) setBlockKind(name);
		else if (name === "bold" || name === "italic") document.execCommand(name);
		else if (name === "code") toggleCode();
		else if (name === "ul" || name === "ol") makeList(name);
		else if (name === "quote") toggleQuote();
		else if (name === "indent" || name === "outdent") shiftLevel(name === "indent" ? 1 : -1);
		else if (name === "tableInsert") {
			const row = (tag) => `<tr>${`<${tag}><br></${tag}>`.repeat(3)}</tr>`;
			const table = document.createElement("table");
			table.innerHTML = `<thead>${row("th")}</thead><tbody>${row("td")}${row("td")}</tbody>`;
			insertBlock(table);
			placeCaret(table.querySelector("th"));
		} else if (name === "hr") insertBlock(document.createElement("hr"));
		else if (TABLE_TOOLS.some(([tool]) => tool === name)) tableCommand(name);
	}
	/** The block element (paragraph, heading, list item ...) holding the caret. */
	function currentBlock() {
		const selection = getSelection();
		let node = selection.rangeCount ? selection.getRangeAt(0).startContainer : null;
		while (node && node !== paper) {
			if (node.nodeType === 1 && BLOCK_TAGS.has(node.tagName)) return node;
			node = node.parentNode;
		}
		return null;
	}
	/** The child of the page that holds `node` (null outside the page). */
	function topBlock(node) {
		while (node && node.parentNode !== paper) node = node.parentNode;
		return node && node.parentNode === paper ? node : null;
	}
	function placeCaret(element, atEnd = false) {
		if (!element) return;
		const range = document.createRange();
		range.selectNodeContents(element);
		range.collapse(!atEnd);
		const selection = getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
	}
	/** Replace an element by a new one of `tag` holding the same content
	 * (nested lists stay out: listItems lists them on their own). */
	function retag(element, tag) {
		const next = document.createElement(tag);
		next.append(...[...element.childNodes].filter((child) => child.nodeName !== "UL" && child.nodeName !== "OL"));
		if (tag === "p" && element.tagName === "P" && element.dataset.indent) next.dataset.indent = element.dataset.indent;
		if (!next.firstChild) next.innerHTML = "<br>";
		element.replaceWith(next);
		return next;
	}
	/** The lines of the selection (top blocks) from first to last. */
	function selectedTops() {
		const selection = getSelection();
		if (!selection.rangeCount) return [];
		const range = selection.getRangeAt(0);
		const onPaper = (container, offset) => (container === paper ? paper.children[Math.min(offset, paper.children.length - 1)] || null : topBlock(container));
		const first = onPaper(range.startContainer, range.startOffset);
		const last = onPaper(range.endContainer, range.endOffset) || first;
		if (!first) return [];
		const out = [first];
		for (let node = first; node !== last && node.nextElementSibling; ) { node = node.nextElementSibling; out.push(node); }
		return out;
	}
	/** Run a change that rebuilds blocks; the caret stays where it was
	 * (an empty marker element moves along with the content). */
	function keepCaret(change) {
		const selection = getSelection();
		let marker = null;
		if (selection.rangeCount && paper.contains(selection.anchorNode)) {
			marker = document.createElement("span");
			marker.dataset.caret = "1";
			const range = selection.getRangeAt(0).cloneRange();
			range.collapse(true);
			range.insertNode(marker);
		}
		try { change(); } finally {
			if (marker && marker.isConnected) {
				const range = document.createRange();
				range.setStartBefore(marker);
				range.collapse(true);
				const parent = marker.parentNode;
				marker.remove();
				parent.normalize();
				if (parent.nodeType === 1 && !parent.textContent && !parent.querySelector("br, img")) parent.innerHTML = "<br>";
				selection.removeAllRanges();
				if (parent.isConnected && range.startContainer.isConnected) selection.addRange(range);
				else placeCaret(paper.lastElementChild || paper, true);
			}
			for (const left of paper.querySelectorAll("span[data-caret]")) left.remove();
		}
	}
	/** Text or a heading for the selected lines (list items and quotes
	 * become plain lines of that kind). */
	function setBlockKind(tag) {
		keepCaret(() => setBlockKindNow(tag));
	}
	function setBlockKindNow(tag) {
		for (const top of selectedTops()) {
			if (top.tagName === "UL" || top.tagName === "OL") {
				for (const { li, level } of listItems(top)) {
					const line = retag(li, tag);
					if (tag === "p" && level) line.dataset.indent = String(level);
					top.before(line);
				}
				top.remove();
			} else if (["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"].includes(top.tagName)) retag(top, tag);
		}
	}
	/** Every item of a (nested) list in reading order, with its level. */
	function listItems(list, level = 0, out = []) {
		for (const child of [...list.children]) {
			if (child.tagName === "LI") {
				out.push({ li: child, level });
				for (const nested of child.querySelectorAll(":scope > ul, :scope > ol")) listItems(nested, level + 1, out);
			} else if (child.tagName === "UL" || child.tagName === "OL") listItems(child, level + 1, out);
		}
		return out;
	}
	/** Indent (+1) or outdent (-1): list items nest under the item before
	 * them or move out of their sublist (out of the list at the top);
	 * lines get up to MAX_LEVEL steps of indent. */
	function shiftLevel(step) {
		const node = getSelection().anchorNode;
		const li = node && (node.nodeType === 1 ? node : node.parentElement).closest("li");
		if (li && paper.contains(li)) {
			keepCaret(() => {
				const list = li.parentElement;
				if (step > 0) {
					const prev = li.previousElementSibling;
					let depth = 0;
					for (let up = list; up && up !== paper; up = up.parentElement) if (up.tagName === "UL" || up.tagName === "OL") depth += 1;
					if (!prev || depth > MAX_LEVEL) return;
					let sub = [...prev.children].reverse().find((child) => child.tagName === "UL" || child.tagName === "OL");
					if (!sub) { sub = document.createElement(list.tagName.toLowerCase()); prev.appendChild(sub); }
					sub.appendChild(li);
					// Its own sublist comes along one level deeper already.
				} else {
					const parentLi = list.parentElement && list.parentElement.closest("li");
					// The items after it become its children (they stay below it).
					const after = [];
					for (let next = li.nextElementSibling; next; next = next.nextElementSibling) after.push(next);
					if (after.length) {
						let sub = [...li.children].reverse().find((child) => child.tagName === "UL" || child.tagName === "OL");
						if (!sub) { sub = document.createElement(list.tagName.toLowerCase()); li.appendChild(sub); }
						sub.append(...after);
					}
					if (parentLi && paper.contains(parentLi)) parentLi.after(li);
					else {
						// Out of the list at the top: a plain line (its sublist after it).
						const line = retag(li, "p");
						const nested = [...li.children].filter((child) => child.tagName === "UL" || child.tagName === "OL");
						list.after(line);
						let anchor = line;
						for (const sub of nested) { anchor.after(sub); anchor = sub; }
					}
					if (!list.children.length) list.remove();
				}
			});
			return;
		}
		for (const top of selectedTops()) {
			if (top.tagName !== "P" && top.tagName !== "DIV") continue;
			const level = Math.max(0, Math.min(MAX_LEVEL, Number(top.dataset.indent || 0) + step));
			if (level) top.dataset.indent = String(level); else delete top.dataset.indent;
		}
	}
	/** Text, line breaks and inline marks written right into the page (a
	 * browser does so after everything was deleted) go into a paragraph,
	 * so every command finds its line. */
	function wrapLoose() {
		const loose = [...paper.childNodes].filter((node) => node.nodeType === 3 ? node.textContent.length > 0 : node.nodeType === 1 && !BLOCK_TAGS.has(node.tagName) && node.tagName !== "IMG");
		if (!loose.length) return;
		keepCaret(() => {
			let line = null;
			for (const node of [...paper.childNodes]) {
				const inline = node.nodeType === 3 || (node.nodeType === 1 && !BLOCK_TAGS.has(node.tagName));
				if (!inline) { line = null; continue; }
				if (!line) { line = document.createElement("p"); node.before(line); }
				line.appendChild(node);
			}
			for (const p of paper.querySelectorAll(":scope > p")) if (p.lastChild && p.lastChild.nodeName === "BR" && p.childNodes.length > 1 && p.textContent) p.lastChild.remove();
		});
	}
	function toggleQuote() {
		const tops = selectedTops();
		if (tops.length && tops.every((top) => top.tagName === "BLOCKQUOTE")) return setBlockKind("p");
		keepCaret(() => {
			const quote = document.createElement("blockquote");
			let first = true;
			for (const top of tops) {
				if (!["P", "DIV", "H1", "H2", "H3", "BLOCKQUOTE"].includes(top.tagName)) continue;
				if (!first) quote.appendChild(document.createElement("br"));
				quote.append(...top.childNodes);
				first = false;
				if (top !== tops[0]) top.remove();
			}
			if (first) return;
			while (quote.lastChild && quote.lastChild.nodeName === "BR" && quote.childNodes.length > 1) quote.lastChild.remove();
			if (!quote.firstChild) quote.innerHTML = "<br>";
			tops[0].replaceWith(quote);
		});
	}
	/** Lines of the selection as a list, or a list back to lines (when the
	 * selection is already that kind of list). */
	function makeList(tag) {
		const tops = selectedTops();
		if (!tops.length) return;
		const kind = tag.toUpperCase();
		if (tops.every((block) => block.tagName === kind)) return setBlockKind("p");
		keepCaret(() => {
			const list = document.createElement(tag);
			for (const block of tops) {
				if (block.tagName === "UL" || block.tagName === "OL") {
					for (const li of [...block.children]) list.appendChild(li);
				} else if (["P", "DIV", "H1", "H2", "H3", "BLOCKQUOTE"].includes(block.tagName)) {
					const li = document.createElement("li");
					li.append(...block.childNodes);
					if (!li.firstChild) li.innerHTML = "<br>";
					list.appendChild(li);
				}
			}
			if (!list.children.length) return;
			tops[0].before(list);
			for (const block of tops) if (!["TABLE", "HR", "FIGURE"].includes(block.tagName)) block.remove();
		});
	}
	/** Inline code: marks the selection; with the caret inside code, the
	 * caret moves just after it (to go on writing plain text); a selection
	 * inside code is unmarked. */
	function toggleCode() {
		const selection = getSelection();
		if (!selection.rangeCount) return;
		const node = selection.anchorNode;
		const inside = node && (node.nodeType === 1 ? node : node.parentElement).closest("code");
		if (inside && selection.isCollapsed) {
			const after = document.createTextNode(ZWSP);
			inside.after(after);
			const range = document.createRange();
			range.setStart(after, 1);
			range.collapse(true);
			selection.removeAllRanges();
			selection.addRange(range);
			return;
		}
		if (inside) {
			inside.replaceWith(document.createTextNode(inside.textContent));
			return;
		}
		const text = selection.toString();
		if (text) { document.execCommand("insertHTML", false, `<code>${esc(text)}</code>${ZWSP}`); return; }
		// No selection: what is typed next is code (the button again ends it).
		const code = document.createElement("code");
		code.textContent = ZWSP;
		const range = selection.getRangeAt(0);
		const block = currentBlock();
		const br = block && block.lastChild && block.lastChild.nodeName === "BR" && !block.textContent ? block.lastChild : null;
		if (br) br.replaceWith(code); else range.insertNode(code);
		const caret = document.createRange();
		caret.setStart(code.firstChild, 1);
		caret.collapse(true);
		selection.removeAllRanges();
		selection.addRange(caret);
	}
	/** Put a whole block (table, line, figure) at the caret's line: in
	 * place of an empty line, else after it; a line to go on writing
	 * follows. The caret goes to that line. */
	function insertBlock(element) {
		const selection = getSelection();
		const top = selection.rangeCount ? topBlock(selection.getRangeAt(0).startContainer) : null;
		if (top && top.tagName === "P" && !top.textContent.replace(ZWSP, "").trim() && !top.querySelector("img")) top.replaceWith(element);
		else if (top) top.after(element);
		else paper.appendChild(element);
		let next = element.nextElementSibling;
		if (!next || next.tagName !== "P") {
			next = document.createElement("p");
			next.innerHTML = "<br>";
			element.after(next);
		}
		placeCaret(next);
	}

	/* ---------------- tables ---------------- */
	function caretCell() {
		const node = getSelection().anchorNode;
		const cell = node && (node.nodeType === 1 ? node : node.parentElement).closest("td, th");
		return cell && paper.contains(cell) ? cell : null;
	}
	function tableCommand(name) {
		const cell = caretCell();
		if (!cell) return;
		const table = cell.closest("table");
		const row = cell.closest("tr");
		const column = [...row.children].indexOf(cell);
		const rows = [...table.querySelectorAll("tr")];
		const blankRow = () => {
			const tr = document.createElement("tr");
			tr.innerHTML = "<td><br></td>".repeat(row.children.length);
			return tr;
		};
		if (name === "rowBelow") {
			const tr = blankRow();
			// Below the header row: the first row of the body.
			if (row.parentElement.tagName === "THEAD") (table.tBodies[0] || table.appendChild(document.createElement("tbody"))).prepend(tr);
			else row.after(tr);
			placeCaret(tr.children[column]);
		} else if (name === "colRight") {
			for (const tr of rows) {
				const fresh = document.createElement(tr.parentElement.tagName === "THEAD" ? "th" : "td");
				fresh.innerHTML = "<br>";
				const at = tr.children[column];
				if (at) at.after(fresh); else tr.appendChild(fresh);
			}
			placeCaret(row.children[column + 1]);
		} else if (name === "rowDelete") {
			if (row.parentElement.tagName === "THEAD" || rows.length <= 1) return deleteTable(table);
			const next = row.nextElementSibling || row.previousElementSibling;
			row.remove();
			placeCaret(next && next.children[Math.min(column, next.children.length - 1)]);
		} else if (name === "colDelete") {
			if (row.children.length <= 1) return deleteTable(table);
			for (const tr of rows) if (tr.children[column]) tr.children[column].remove();
			placeCaret(row.children[Math.min(column, row.children.length - 1)]);
		} else if (name === "tableDelete") deleteTable(table);
	}
	function deleteTable(table) {
		const line = document.createElement("p");
		line.innerHTML = "<br>";
		const next = table.nextElementSibling;
		if (next && next.tagName === "P" && !next.textContent.trim()) { table.remove(); placeCaret(next); return; }
		table.replaceWith(line);
		placeCaret(line);
	}

	/* ---------------- typing aids ---------------- */
	// Markdown habits: "# ", "## ", "### ", "- ", "* ", "1. ", "> " at the
	// start of an empty line turn it into that block.
	const MARKERS = { "#": "h1", "##": "h2", "###": "h3", "-": "ul", "*": "ul", "1.": "ol", ">": "quote" };
	paper.addEventListener("keydown", (event) => {
		const mod = event.ctrlKey || event.metaKey;
		// Undo and redo: this editor's own history.
		if (mod && !event.altKey && (event.key === "z" || event.key === "Z" || event.key === "y")) {
			event.preventDefault();
			undo(event.key === "y" || event.shiftKey ? 1 : -1);
			return;
		}
		if (event.key === " " && !mod && !event.altKey) {
			const block = currentBlock();
			const marker = block && ["P", "DIV"].includes(block.tagName) && !block.closest("li, td, th, blockquote") ? block.textContent.replace(ZWSP, "") : "";
			const kind = Object.prototype.hasOwnProperty.call(MARKERS, marker) ? MARKERS[marker] : null;
			if (kind && getSelection().isCollapsed) {
				event.preventDefault();
				commit();
				block.innerHTML = "<br>";
				placeCaret(block);
				command(kind);
				changed();
				commit();
				return;
			}
		}
		// Enter in a quote: see enterInQuote.
		const quote = event.key === "Enter" && !event.shiftKey ? currentBlock()?.closest("blockquote") : null;
		if (quote) {
			event.preventDefault();
			commit();
			enterInQuote(quote);
			changed();
			return;
		}
		// A selected table or picture: Backspace or Delete removes it, any
		// other key lets it go.
		if (picked) {
			if (event.key === "Backspace" || event.key === "Delete") {
				event.preventDefault();
				removePicked();
				return;
			}
			if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) pick(null);
		}
		// Backspace at the start of the line after a table, picture or line
		// selects that block (Delete at the end of the line before one); the
		// next press removes it.
		if ((event.key === "Backspace" || event.key === "Delete") && getSelection().isCollapsed) {
			const block = currentBlock();
			const top = block && topBlock(block);
			const back = event.key === "Backspace";
			const neighbour = top && (back ? top.previousElementSibling : top.nextElementSibling);
			const atEdge = top && (back ? caretTextOffsetIn(top) === 0 : caretTextOffsetIn(top) >= top.textContent.length);
			if (neighbour && atEdge && ["TABLE", "FIGURE", "HR"].includes(neighbour.tagName) && !block.closest("td, th, li")) {
				event.preventDefault();
				if (neighbour.tagName === "HR") { commit(); neighbour.remove(); changed(); commit(); return; }
				pick(neighbour);
				return;
			}
		}
		// Tab in a table: the next cell; after the last cell a new row.
		// Elsewhere Tab indents and Shift+Tab outdents.
		if (event.key === "Tab" && !mod && !event.altKey) {
			const cell = caretCell();
			if (!cell) {
				event.preventDefault();
				commit();
				wrapLoose();
				shiftLevel(event.shiftKey ? -1 : 1);
				changed();
				commit();
				return;
			}
			event.preventDefault();
			const cells = [...cell.closest("table").querySelectorAll("th, td")];
			let next = cells[cells.indexOf(cell) + (event.shiftKey ? -1 : 1)];
			if (!next && !event.shiftKey) {
				commit();
				placeCaret(cell);
				tableCommand("rowBelow");
				changed();
				return;
			}
			if (next) placeCaret(next);
		}
		if (event.key === "Escape" && clipping) cancelClip();
	});
	/** Enter in a quote: a new line inside it; on an empty last line (or
	 * in an empty quote) the quote ends and a plain line follows. */
	function enterInQuote(quote) {
		const selection = getSelection();
		const rest = document.createRange();
		rest.setStart(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
		rest.setEnd(quote, quote.childNodes.length);
		const atEnd = !rest.toString().replace(ZWSP, "") && !rest.cloneContents().querySelector("img, figure");
		const emptyLast = /(<br>\s*){2}$/.test(quote.innerHTML) || /<p>(<br>)?<\/p>\s*$/.test(quote.innerHTML);
		if (!quote.textContent.trim() || (atEnd && emptyLast)) {
			quote.innerHTML = quote.innerHTML.replace(/(<p>(<br>)?<\/p>\s*|<br>\s*)+$/, "");
			const line = document.createElement("p");
			line.innerHTML = "<br>";
			quote.after(line);
			if (!quote.textContent.trim()) quote.remove();
			placeCaret(line);
		} else document.execCommand("insertLineBreak");
	}
	paper.addEventListener("input", () => { wrapLoose(); changed(true); });

	// Paste: images become files of the note; formatted text keeps only what
	// a note can hold (blocks of notemd), nothing else from the source page.
	paper.addEventListener("paste", (event) => {
		const data = event.clipboardData;
		if (!data) return;
		const image = [...data.items].find((item) => item.kind === "file" && /^image\/(png|jpeg|gif|webp)$/.test(item.type));
		if (image) {
			event.preventDefault();
			insertImage(image.getAsFile(), null, "");
			return;
		}
		const html = data.getData("text/html");
		event.preventDefault();
		commit();
		if (html) {
			// An inert document: nothing in the pasted page runs or loads
			// (an element of this page would fire e.g. <img onerror>).
			const holder = new DOMParser().parseFromString(html, "text/html").body;
			holder.querySelectorAll("script, style, meta, link, title").forEach((node) => node.remove());
			// Text from a PDF comes as lines (spans and line breaks only): it
			// is joined like plain text below; real structure is kept.
			// (PDF viewers wrap their lines in div and span elements.)
			const structured = !holder.querySelector(".textLayer, .page, [data-page-number]") && holder.querySelector("p, h1, h2, h3, h4, h5, h6, li, table, blockquote, figure, pre, b, strong, i, em, a");
			const blocks = structured ? readBlocks(holder, true) : [];
			if (blocks.length) {
				document.execCommand("insertHTML", false, blocksToHtml(blocks, imageUrl));
				changed();
				return;
			}
		}
		const paragraphs = joinLines(data.getData("text/plain"));
		if (paragraphs.length === 1) document.execCommand("insertText", false, paragraphs[0]);
		else if (paragraphs.length) document.execCommand("insertHTML", false, paragraphs.map((text) => `<p>${esc(text).replace(/\n/g, "<br>")}</p>`).join(""));
		changed();
	});
	/** Pasted text as paragraphs: blank lines separate them; the lines of
	 * one paragraph (a PDF breaks at every printed line) are joined, a word
	 * split by a hyphen at a line end is joined again. Lines that are list
	 * items keep their breaks. */
	function joinLines(text) {
		const out = [];
		// PDF ligatures (ﬁ, ﬂ, ﬀ ...) as plain letters.
		const clean = text.replace(/[\ufb00-\ufb06]/g, (char) => char.normalize("NFKC")).replace(/\r\n?/g, "\n");
		for (const block of clean.split(/\n[ \t]*\n/)) {
			const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
			if (!lines.length) continue;
			const listy = lines.length > 1 && lines.filter((line) => /^([-•*–]|\d+[.)])\s/.test(line)).length >= lines.length / 2;
			if (listy) { out.push(lines.join("\n")); continue; }
			// Without blank lines a paragraph ends at a clearly short line
			// that closes a sentence (the printed paragraph's last line).
			const lengths = lines.map((line) => line.length).sort((a, b) => a - b);
			const typical = lengths[Math.floor(lengths.length * 0.75)] || 0;
			let joined = lines[0];
			lines.forEach((line, index) => {
				if (index === 0) return;
				const previous = lines[index - 1];
				const ends = lines.length >= 4 && /[.!?:]["”’)]?$/.test(previous) && previous.length < typical * 0.8;
				if (ends) { out.push(joined.replace(/\s{2,}/g, " ")); joined = line; return; }
				joined = /\p{L}-$/u.test(joined) && /^\p{Ll}/u.test(line) ? joined.slice(0, -1) + line : `${joined} ${line}`;
			});
			out.push(joined.replace(/\s{2,}/g, " "));
		}
		return out;
	}
	// Links: a page link jumps in the PDF; others open with Ctrl/Cmd+click.
	paper.addEventListener("click", (event) => {
		const link = event.target.closest("a[href]");
		if (!link) return;
		event.preventDefault();
		const href = link.getAttribute("href");
		const page = /^#page=(\d+)$/.exec(href);
		if (page) app.showPage(note.base, Number(page[1]));
		else if ((event.ctrlKey || event.metaKey) && safeHref(href)) window.open(href, "_blank", "noopener");
	});

	/* ---------------- picking a whole table or picture ---------------- */
	let picked = null;
	function pick(element) {
		if (picked) picked.classList.remove("sel");
		picked = element;
		if (picked) picked.classList.add("sel");
	}
	function removePicked() {
		if (!picked) return;
		const gone = picked;
		pick(null);
		commit();
		const next = gone.nextElementSibling;
		const prev = gone.previousElementSibling;
		gone.remove();
		if (!paper.firstElementChild) paper.innerHTML = "<p><br></p>";
		if (next && next.parentNode === paper && next.tagName === "P") placeCaret(next);
		else if (prev && prev.parentNode === paper) placeCaret(prev, true);
		else placeCaret(paper.firstElementChild);
		changed();
		commit();
	}
	// A click on a picture selects it; a click elsewhere lets it go.
	paper.addEventListener("mousedown", (event) => {
		const figure = event.target.closest("figure");
		if (figure && !event.target.closest("a")) {
			event.preventDefault();
			pick(figure);
			paper.focus();
			placeCaret(figure.nextElementSibling || paper, false);
			return;
		}
		pick(null);
	});

	/* ---------------- undo ---------------- */
	// Steps are snapshots of the page (HTML + caret as a text offset).
	// Typing is grouped into one step per pause; every command is a step.
	const history = { steps: [], index: -1 };
	function snapshot() {
		return { html: paper.innerHTML, caret: caretTextOffset() };
	}
	function resetHistory() {
		history.steps = [snapshot()];
		history.index = 0;
		note.pending = false;
	}
	/** Close the current typing group as an undo step. */
	function commit() {
		clearTimeout(note.groupTimer);
		if (!note.pending || !note.base) return;
		note.pending = false;
		const step = snapshot();
		if (history.steps[history.index] && history.steps[history.index].html === step.html) return;
		history.steps = history.steps.slice(0, history.index + 1);
		history.steps.push(step);
		if (history.steps.length > UNDO_LIMIT) history.steps.shift();
		history.index = history.steps.length - 1;
		syncTools();
	}
	function undo(direction) {
		commit();
		const target = history.index + direction;
		if (target < 0 || target >= history.steps.length) return;
		history.index = target;
		const step = history.steps[target];
		paper.innerHTML = step.html;
		lockFigures();
		paper.focus();
		restoreCaret(step.caret);
		note.dirty = true;
		setSaveState("dirty");
		clearTimeout(note.timer);
		note.timer = setTimeout(() => save(), SAVE_DELAY_MS);
		syncTools();
	}
	/** Caret as the number of characters before it in the page. */
	function caretTextOffset() {
		const selection = getSelection();
		if (!selection.rangeCount || !paper.contains(selection.anchorNode)) return null;
		return caretTextOffsetIn(paper);
	}
	function caretTextOffsetIn(element) {
		const selection = getSelection();
		if (!selection.rangeCount) return 0;
		const range = document.createRange();
		range.setStart(element, 0);
		range.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
		return range.toString().length;
	}
	function restoreCaret(offset) {
		if (offset === null || offset === undefined) { placeCaret(paper.lastElementChild || paper, true); return; }
		const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT);
		let left = offset;
		let last = null;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			last = node;
			if (left <= node.length) {
				const range = document.createRange();
				range.setStart(node, left);
				range.collapse(true);
				getSelection().removeAllRanges();
				getSelection().addRange(range);
				return;
			}
			left -= node.length;
		}
		if (last) placeCaret(last.parentElement, true);
		else placeCaret(paper.firstElementChild || paper);
	}

	/* ---------------- images, clips and quotes from the PDF ---------------- */
	function imageUrl(src) {
		const name = /^img\/([^/]+)$/.exec(src);
		return name && note.dir ? `${app.BASE}/notes/${encodeURIComponent(note.dir)}/img/${encodeURIComponent(name[1])}` : src;
	}
	/** Store an image (a PDF clip with its page, or a pasted picture) and
	 * put it at the caret, with its caption. */
	async function insertImage(blob, page, caption, at = null) {
		if (!note.base) return;
		const base = note.base;
		try {
			const response = await fetch(`${app.BASE}/api/notes/image?base=${encodeURIComponent(base)}${page ? `&page=${page}` : ""}`, { method: "POST", headers: { "content-type": blob.type || "image/png" }, body: blob });
			const body = await response.json();
			if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
			if (note.base !== base) return;
			note.dir = body.dir;
			const holder = document.createElement("div");
			holder.innerHTML = blocksToHtml([{ t: "img", src: body.src, alt: caption, ...(page ? { page } : {}) }], imageUrl);
			commit();
			paper.focus();
			if (at !== null) restoreCaret(at);
			if (!paper.contains(getSelection().anchorNode)) placeCaret(paper.lastElementChild || paper, true);
			insertBlock(holder.firstElementChild);
			lockFigures();
			changed();
			commit();
		} catch (error) {
			app.toast(`The image was not saved: ${error.message}`);
		}
	}
	/** Figures are whole pieces: selected and deleted as one, not edited inside. */
	function lockFigures() {
		for (const figure of paper.querySelectorAll("figure")) figure.contentEditable = "false";
	}
	let clipping = false;
	/** Clip mode in the PDF viewer: the dragged rectangle comes back as a
	 * PNG and is placed where the caret was, with "Author Year, p. N". */
	async function clip() {
		if (clipping) return cancelClip();
		const viewer = app.viewer(note.base);
		if (!viewer) { app.toast("Open this paper's PDF on the right first."); return; }
		const at = caretTextOffset();
		clipping = true;
		$("notes-tools").querySelector('[data-cmd="clip"]').classList.add("armed");
		try {
			const result = await viewer.clip();
			if (result) await insertImage(result.blob, result.page, `${app.citeLabel(note.base)}, p. ${result.page}`, at);
		} catch (error) {
			app.toast(`The clip did not work: ${error.message}`);
		} finally {
			clipping = false;
			$("notes-tools").querySelector('[data-cmd="clip"]').classList.remove("armed");
		}
	}
	function cancelClip() {
		const viewer = app.viewer(note.base);
		if (viewer) viewer.cancelClip();
	}
	document.addEventListener("keydown", (event) => { if (event.key === "Escape" && clipping) cancelClip(); });
	/** The text selected in the PDF as a quote with its page link. */
	function citeSelection() {
		const viewer = app.viewer(note.base);
		const picked = viewer ? viewer.selection() : null;
		if (!picked || !picked.text) { app.toast("Select some text in the PDF first."); return; }
		if (!paper.contains(getSelection().anchorNode)) placeCaret(paper.lastElementChild || paper, true);
		paper.focus();
		commit();
		const quote = document.createElement("blockquote");
		const link = document.createElement("a");
		link.href = `#page=${picked.page}`;
		link.textContent = `${app.citeLabel(note.base)}, p. ${picked.page}`;
		quote.append(document.createTextNode(`${picked.text} (`), link, document.createTextNode(")"));
		insertBlock(quote);
		changed();
		commit();
	}

	/** The paper's details as written in its info window (library record,
	 * OpenAlex for journal and citations): one paragraph, a line each. */
	async function insertFacts() {
		const base = note.base;
		const at = caretTextOffset();
		let data;
		try { data = await app.get(`${app.BASE}/api/paper?base=${encodeURIComponent(base)}`); } catch (error) { app.toast(error.message); return; }
		if (note.base !== base) return;
		const p = data.paper;
		const oa = data.openalex;
		const line = document.createElement("p");
		const add = (label, ...nodes) => {
			if (!nodes.length || nodes.every((node) => !node || (typeof node === "string" && !node.trim()))) return;
			if (line.firstChild) line.appendChild(document.createElement("br"));
			const name = document.createElement("b");
			name.textContent = `${label}: `;
			line.append(name, ...nodes.filter(Boolean));
		};
		const link = (href, text) => { const a = document.createElement("a"); a.href = href; a.textContent = text; return a; };
		const title = document.createElement("b");
		title.textContent = p.title || p.base;
		line.appendChild(title);
		add("Authors", (p.authors || []).join("; "));
		add("Year", p.year ? String(p.year) : "");
		add("Journal", oa && oa.venue ? oa.venue : "");
		if (p.doi) add("DOI", link(`https://doi.org/${p.doi}`, p.doi));
		else if (p.arxiv_id) add("arXiv", link(`https://arxiv.org/abs/${p.arxiv_id}`, p.arxiv_id));
		if (oa && oa.cited_by !== null && oa.cited_by !== undefined) add("Citations", `${oa.cited_by} (OpenAlex, as of ${String(data.checked || new Date().toISOString()).slice(0, 10)})`);
		paper.focus();
		if (at !== null) restoreCaret(at);
		if (!paper.contains(getSelection().anchorNode)) placeCaret(paper.lastElementChild || paper, true);
		commit();
		insertBlock(line);
		changed();
		commit();
	}

	/* ---------------- AI corrector ---------------- */
	// Selected text gets a small button; the model corrects spelling and
	// grammar (proofread.ts on the server refuses anything more), a window
	// shows the changes, "Apply" writes them into the text nodes one by
	// one, so bold, links and other marks stay. Quotes, links, code and
	// captions are never changed (they cite the paper).
	// Two buttons beside the selection: spelling only, or wording too.
	const aiBar = document.createElement("div");
	aiBar.className = "notes-ai";
	aiBar.hidden = true;
	aiBar.innerHTML = `<button type="button" data-ai="spelling" title="AI corrector: spelling, grammar and punctuation of the selected text" aria-label="Correct spelling">${svg('<path d="M4 18l4-11 4 11M5.5 14h5"/><path d="M14 14l2.5 2.5L21 11"/>', 1.7)}</button><button type="button" data-ai="wording" title="AI wording: alternative phrasing of the selected text (numbers, names and citations stay)" aria-label="Alternative wording">${svg('<path d="M4 20l9.5-9.5M15.5 4.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6zM19.5 10.5l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4zM9 3.5l.4 1.1 1.1.4-1.1.4L9 6.5l-.4-1.1-1.1-.4 1.1-.4z"/>', 1.6)}</button>`;
	document.body.appendChild(aiBar);
	aiBar.addEventListener("mousedown", (event) => event.preventDefault());
	section.querySelector(".notes-scroll").addEventListener("scroll", () => placeAiButton());
	let aiBusy = false;
	function placeAiButton() {
		if (aiBusy) return;
		const selection = getSelection();
		const show = !section.hidden && note.base && !clipping && selection.rangeCount && !selection.isCollapsed && paper.contains(selection.anchorNode) && paper.contains(selection.focusNode) && selection.toString().trim().length >= 2;
		aiBar.hidden = !show;
		if (!show) return;
		// The live demo has no model: greyed, a click explains the installation.
		const demo = Boolean(app.demo && app.demo());
		if (aiBar.classList.contains("demo") !== demo) {
			aiBar.classList.toggle("demo", demo);
			for (const button of aiBar.querySelectorAll("[data-ai]")) {
				button.title = demo ? "AI corrector: in the installed version, with your own AI model" : button.dataset.ai === "spelling" ? "AI corrector: spelling, grammar and punctuation of the selected text" : "AI wording: alternative phrasing of the selected text (numbers, names and citations stay)";
			}
		}
		const rect = selection.getRangeAt(0).getBoundingClientRect();
		const area = section.querySelector(".notes-scroll").getBoundingClientRect();
		const top = Math.max(area.top + 4, Math.min(rect.top - 38, area.bottom - 44));
		const left = Math.max(area.left + 4, Math.min(rect.right - 30, area.right - 80));
		aiBar.style.top = `${top}px`;
		aiBar.style.left = `${left}px`;
	}
	/** The selected text as segments: text node pieces (with their place in
	 * the node) and line breaks between lines; protected pieces may be
	 * read by the model but are never changed. */
	function selectionSegments(range) {
		const segments = [];
		let text = "";
		let lastBlock = null;
		const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!range.intersectsNode(node)) continue;
			if (node.nodeType === 1) {
				// A line break inside a paragraph is sent as a space: the
				// model may join the lines (the break goes when that space
				// is replaced).
				if (node.tagName === "BR" && text && !text.endsWith("\n") && node.nextSibling) { segments.push({ br: node, start: text.length, end: text.length + 1 }); text += " "; }
				continue;
			}
			let from = 0;
			let to = node.length;
			if (node === range.startContainer) from = range.startOffset;
			if (node === range.endContainer) to = range.endOffset;
			if (to <= from) continue;
			const block = node.parentElement.closest("p, li, h1, h2, h3, td, th, blockquote, figcaption, div");
			if (lastBlock && block !== lastBlock && text && !text.endsWith("\n")) { segments.push({ start: text.length, end: text.length + 1, newline: true }); text += "\n"; }
			lastBlock = block;
			const piece = node.data.slice(from, to).replace(/\u200b/g, " ");
			const protect = Boolean(node.parentElement.closest("a, code, blockquote, figure"));
			segments.push({ node, offset: from, start: text.length, end: text.length + piece.length, protect });
			text += piece;
		}
		return { text, segments };
	}
	/** The diff as edits on the original text: {from, to, insert}. */
	function editsFrom(diff) {
		const edits = [];
		let pos = 0;
		let open = null;
		for (const part of diff) {
			if (part.op === "=") { if (open) { edits.push(open); open = null; } pos += part.text.length; continue; }
			if (!open) open = { from: pos, to: pos, insert: "" };
			if (part.op === "-") { pos += part.text.length; open.to = pos; } else open.insert += part.text;
		}
		if (open) edits.push(open);
		return edits;
	}
	/** Edits that touch only free text of one line (none in a quote, link,
	 * code, caption or across a line break). */
	function allowedEdits(edits, segments) {
		return edits.filter((edit) => {
			const touched = segments.filter((seg) => (edit.to > edit.from ? seg.start < edit.to && seg.end > edit.from : seg.start <= edit.from && seg.end >= edit.from));
			return touched.length > 0 && touched.every((seg) => !seg.newline && !seg.protect);
		});
	}
	function applyEdits(edits, segments) {
		for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
			const touched = segments.filter((seg) => !seg.newline && (edit.to > edit.from ? seg.start < edit.to && seg.end > edit.from : seg.start <= edit.from && seg.end >= edit.from));
			// A line break whose space is replaced goes; the inserted text
			// then needs a text piece of its own when no text is touched.
			for (const seg of touched.filter((piece) => piece.br)) {
				if (edit.from <= seg.start && edit.to >= seg.end) {
					if (!touched.some((piece) => piece.node)) seg.br.before(document.createTextNode(edit.insert));
					seg.br.remove();
				}
			}
			touched.filter((piece) => piece.node).forEach((seg, index) => {
				const a = seg.offset + Math.max(0, edit.from - seg.start);
				const b = seg.offset + Math.min(seg.end, edit.to) - seg.start;
				const data = seg.node.data;
				seg.node.data = data.slice(0, a) + (index === 0 ? edit.insert : "") + data.slice(Math.max(a, b));
			});
		}
	}
	/* The corrector's window opens at once and always says how it went:
	   working, the changes to apply, nothing to change, or why nothing is
	   offered. */
	let proofDialog = null;
	const MODE_TITLE = { spelling: "AI corrector", wording: "AI wording" };
	function proofWindow(mode, body, actions) {
		if (!proofDialog) {
			proofDialog = document.createElement("dialog");
			proofDialog.className = "modal notes-proof";
			document.body.appendChild(proofDialog);
		}
		proofDialog.innerHTML = `<h3>${MODE_TITLE[mode]}</h3>${body}<div class="modal-actions">${actions}</div>`;
		if (!proofDialog.open) proofDialog.showModal();
		return proofDialog;
	}
	function diffHtml(original, edits) {
		let html = "";
		let pos = 0;
		for (const edit of edits) {
			html += esc(original.slice(pos, edit.from));
			if (edit.to > edit.from) html += `<del>${esc(original.slice(edit.from, edit.to))}</del>`;
			if (edit.insert) html += `<ins>${esc(edit.insert)}</ins>`;
			pos = edit.to;
		}
		return (html + esc(original.slice(pos))).replace(/\n/g, "<br>");
	}
	const CLOSE = '<button type="button" class="primary" data-proof="close">Close</button>';
	function waitChoice(dialog) {
		return new Promise((resolve) => {
			dialog.onclick = (event) => {
				const choice = event.target.closest("[data-proof]");
				if (!choice && event.target !== dialog) return;
				dialog.close();
				resolve(choice ? choice.dataset.proof : "close");
			};
			dialog.oncancel = () => resolve("close");
		});
	}
	aiBar.addEventListener("click", async (event) => {
		const button = event.target.closest("[data-ai]");
		if (!button) return;
		const mode = button.dataset.ai;
		if (app.demo && app.demo()) { app.install("The AI corrector needs a model", "Installed, pi-literature-review corrects spelling and improves wording of your notes with the AI model you run; you see every change before it is applied."); return; }
		const selection = getSelection();
		if (!selection.rangeCount || selection.isCollapsed) return;
		const { text, segments } = selectionSegments(selection.getRangeAt(0));
		if (!text.trim()) return;
		const before = paper.innerHTML;
		// The selection comes back when the window closes without changes,
		// with the buttons beside it.
		const saved = selection.getRangeAt(0).cloneRange();
		let applied = false;
		try {
			await runCorrector(mode, text, segments, before, () => { applied = true; });
		} finally {
			aiBusy = false;
			if (!applied && saved.startContainer.isConnected && saved.endContainer.isConnected) {
				paper.focus();
				const again = getSelection();
				again.removeAllRanges();
				again.addRange(saved);
			}
			placeAiButton();
		}
	});
	async function runCorrector(mode, text, segments, before, onApply) {
		aiBusy = true;
		aiBar.hidden = true;
		const dialog = proofWindow(mode, '<p class="proofstate"><span class="dot busy"></span>Checking the selected text ...</p>', '<button type="button" data-proof="close">Cancel</button>');
		const choice = waitChoice(dialog);
		let result = null;
		let failure = "";
		const request = app.post(`${app.BASE}/api/notes/proofread`, { text, mode }).then((value) => { result = value; }, (error) => { failure = error.message; });
		const first = await Promise.race([request.then(() => "done"), choice]);
		if (first !== "done") return;
		if (failure) { await waitChoice(proofWindow(mode, `<p class="proofstate">The model did not answer: ${esc(failure)}</p>`, CLOSE)); return; }
		if (!result.ok) { await waitChoice(proofWindow(mode, `<p class="proofstate">Nothing to apply: ${esc(result.reason)}. Your text stays as it is.</p>`, CLOSE)); return; }
		const all = editsFrom(result.diff);
		const edits = allowedEdits(all, segments);
		if (!edits.length) {
			const note = all.length ? "Only quotes, links, code or captions would change; they stay as they are." : mode === "wording" ? "The model suggests no other wording." : "No spelling or grammar mistakes found.";
			await waitChoice(proofWindow(mode, `<p class="proofstate ok">${note}</p>`, CLOSE));
			return;
		}
		const kept = all.length > edits.length ? '<p class="proofnote">Quotes, links, code and captions stay as they are.</p>' : "";
		proofWindow(mode, `<div class="proofdiff">${diffHtml(text, edits)}</div>${kept}`, `<button type="button" data-proof="discard">Discard</button><button type="button" class="primary" data-proof="apply">Apply ${edits.length === 1 ? "1 change" : `${edits.length} changes`}</button>`);
		if ((await waitChoice(proofDialog)) !== "apply") return;
		if (paper.innerHTML !== before) { await waitChoice(proofWindow(mode, '<p class="proofstate">The text changed meanwhile: select it and check again.</p>', CLOSE)); return; }
		onApply();
		commit();
		applyEdits(edits, segments);
		changed();
		commit();
	}

	/* ---------------- page -> blocks ---------------- */
	function inlineRuns(node, format, out) {
		if (node.nodeType === 3) {
			const text = node.textContent.replace(/​/g, "").replace(/ /g, " ").replace(/[\t\n\r ]+/g, " ");
			if (text) out.push({ text, ...format });
			return out;
		}
		if (node.nodeType !== 1) return out;
		const tag = node.tagName;
		if (tag === "BR") { out.push({ text: "\n", ...format }); return out; }
		if (tag === "IMG" || tag === "UL" || tag === "OL" || tag === "TABLE") return out;
		const next = { ...format };
		const weight = node.style && node.style.fontWeight;
		if (tag === "B" || tag === "STRONG" || weight === "bold" || Number(weight) >= 600) next.b = true;
		if (tag === "I" || tag === "EM" || (node.style && node.style.fontStyle === "italic")) next.i = true;
		if (tag === "CODE" || tag === "KBD" || tag === "SAMP") next.code = true;
		if (tag === "A") {
			const href = safeHref(node.getAttribute("href") || "");
			if (href) next.href = href;
		}
		for (const child of node.childNodes) inlineRuns(child, next, out);
		if ((tag === "P" || tag === "DIV") && node.nextSibling) out.push({ text: "\n", ...format });
		return out;
	}
	/** Runs of one block, outer spaces and line breaks trimmed. */
	function runsOf(node) {
		const runs = inlineRuns(node, {}, []);
		while (runs.length && /^[\s\n]*$/.test(runs[0].text)) runs.shift();
		while (runs.length && /^[\s\n]*$/.test(runs[runs.length - 1].text)) runs.pop();
		if (runs.length) {
			runs[0] = { ...runs[0], text: runs[0].text.replace(/^[ \n]+/, "") };
			const last = runs.length - 1;
			runs[last] = { ...runs[last], text: runs[last].text.replace(/[ \n]+$/, "") };
		}
		return runs.filter((run) => run.text);
	}
	function figureBlock(figure) {
		const img = figure.tagName === "IMG" ? figure : figure.querySelector("img");
		if (!img) return null;
		let src = figure.dataset.src || img.dataset.src || "";
		if (!src) {
			const own = /\/notes\/[^/]+\/img\/([^/?#]+)$/.exec(img.getAttribute("src") || "");
			if (own) src = `img/${decodeURIComponent(own[1])}`;
		}
		// Pictures from elsewhere (a pasted web page) are not stored.
		if (!/^img\/[^/]+$/.test(src)) return null;
		const caption = figure.querySelector && figure.querySelector("figcaption");
		const page = Number(figure.dataset.page || 0);
		return { t: "img", src, alt: (caption ? caption.textContent : img.getAttribute("alt") || "").trim(), ...(page > 0 ? { page } : {}) };
	}
	/** The blocks of a container (the page, or pasted HTML). */
	function readBlocks(root, pasted = false) {
		const blocks = [];
		let loose = [];
		const flushLoose = () => {
			const holder = document.createElement("p");
			for (const node of loose) holder.appendChild(node.cloneNode(true));
			loose = [];
			const runs = runsOf(holder);
			if (runs.length) blocks.push({ t: "p", c: runs });
		};
		const list = (element) => {
			const items = [];
			const levels = [];
			const walk = (container, level) => {
				for (const child of container.children) {
					if (child.tagName === "UL" || child.tagName === "OL") { walk(child, level + 1); continue; }
					if (child.tagName !== "LI") continue;
					const runs = runsOf(child);
					if (runs.length) { items.push(runs); levels.push(Math.min(level, MAX_LEVEL, (levels[levels.length - 1] ?? -1) + 1)); }
					for (const nested of child.querySelectorAll(":scope > ul, :scope > ol")) walk(nested, level + 1);
				}
			};
			walk(element, 0);
			if (items.length) blocks.push({ t: element.tagName === "OL" ? "ol" : "ul", items, ...(levels.some((level) => level > 0) ? { levels } : {}) });
		};
		const visit = (container) => {
			for (const node of container.childNodes) {
				const tag = node.nodeType === 1 ? node.tagName : "";
				if (!tag || !BLOCK_TAGS.has(tag) && tag !== "IMG") {
					loose.push(node);
					continue;
				}
				flushLoose();
				if (tag === "P" || tag === "DIV") {
					if ([...node.children].some((child) => BLOCK_TAGS.has(child.tagName) || child.tagName === "IMG")) visit(node);
					else {
						const runs = runsOf(node);
						const indent = Math.min(MAX_LEVEL, Number(node.dataset && node.dataset.indent) || 0);
						if (runs.length) blocks.push({ t: "p", c: runs, ...(indent ? { indent } : {}) });
					}
				} else if (/^H[1-6]$/.test(tag)) {
					const runs = runsOf(node);
					if (runs.length) blocks.push({ t: "h", level: Math.min(3, Number(tag[1])), c: runs.map((run) => ({ ...run, text: run.text.replace(/\n/g, " ") })) });
				} else if (tag === "BLOCKQUOTE") {
					const runs = runsOf(node);
					if (runs.length) blocks.push({ t: "quote", c: runs });
				} else if (tag === "UL" || tag === "OL") list(node);
				else if (tag === "LI") list({ tagName: "UL", children: [node] });
				else if (tag === "FIGURE" || tag === "IMG") {
					const block = figureBlock(node);
					if (block && !pasted) blocks.push(block);
				} else if (tag === "TABLE") {
					const rows = [...node.querySelectorAll("tr")].map((tr) => [...tr.children].filter((cell) => cell.tagName === "TD" || cell.tagName === "TH").map((cell) => runsOf(cell).map((run) => ({ ...run, text: run.text.replace(/\n/g, " ") }))));
					if (rows.length) blocks.push({ t: "table", rows });
				} else if (tag === "HR") blocks.push({ t: "hr" });
				else if (tag === "PRE") {
					const text = node.textContent.replace(/\n+$/, "");
					if (text) blocks.push({ t: "p", c: [{ text, code: true }] });
				}
			}
			flushLoose();
		};
		visit(root);
		return blocks;
	}

	/* ---------------- load and save ---------------- */
	/** A change of the page: saved after a pause; typing (`typed`) is
	 * grouped into one undo step until a short pause. */
	function changed(typed = false) {
		if (!note.base) return;
		note.dirty = true;
		note.pending = true;
		setSaveState("dirty");
		clearTimeout(note.timer);
		note.timer = setTimeout(() => save(), SAVE_DELAY_MS);
		clearTimeout(note.groupTimer);
		if (typed) note.groupTimer = setTimeout(commit, UNDO_GROUP_MS);
		syncTools();
	}
	function setSaveState(kind, message = "") {
		const mark = $("notes-state");
		mark.className = `notes-state ${kind}`;
		mark.title = kind === "saved" ? "Saved" : kind === "error" ? `Not saved: ${message}` : "Saving ...";
	}
	function payload() {
		return { base: note.base, markdown: noteToMarkdown({}, readBlocks(paper)), background: note.background };
	}
	async function save() {
		clearTimeout(note.timer);
		if (!note.base || !note.dirty) return note.saving;
		const body = payload();
		note.dirty = false;
		const run = (async () => {
			try {
				const response = await fetch(`${app.BASE}/api/notes`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
				const result = await response.json();
				if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
				if (note.base === body.base) {
					note.dir = result.dir;
					if (!note.dirty) setSaveState("saved");
				}
				app.noted(body.base);
			} catch (error) {
				if (note.base === body.base) { note.dirty = true; setSaveState("error", error.message); }
			}
		})();
		note.saving = run;
		await run;
		return run;
	}
	// Leaving the page: the last keystrokes still go out.
	window.addEventListener("pagehide", () => {
		if (!note.base || !note.dirty) return;
		fetch(`${app.BASE}/api/notes`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()), keepalive: true });
	});

	async function open(base, label) {
		if (note.base && note.base !== base) { commit(); await save(); }
		section.hidden = false;
		app.shell.classList.add("notes-open");
		$("notes-title").textContent = label || base;
		$("notes-title").title = label || base;
		if (note.base === base) { paper.focus(); return; }
		const seq = ++note.loadSeq;
		note.base = base;
		note.dirty = false;
		paper.innerHTML = "";
		paper.contentEditable = "false";
		try {
			const data = await app.get(`${app.BASE}/api/notes?base=${encodeURIComponent(base)}`);
			if (seq !== note.loadSeq) return;
			note.dir = data.dir;
			note.folder = data.folder;
			const blocks = data.note ? parseNote(data.note.markdown).blocks : [];
			setBackground(data.note ? data.note.background : localDefault());
			pick(null);
			tableRowOpen = false;
			paper.innerHTML = blocks.length ? blocksToHtml(blocks, imageUrl) : "<p><br></p>";
			lockFigures();
			setSaveState("saved");
			paper.contentEditable = "true";
			document.execCommand("defaultParagraphSeparator", false, "p");
			paper.focus();
			if (!blocks.length) placeCaret(paper.firstElementChild);
			resetHistory();
			syncTools();
		} catch (error) {
			if (seq !== note.loadSeq) return;
			note.base = null;
			paper.innerHTML = `<p>${esc(error.message)}</p>`;
		}
	}
	// A new note starts with the background last picked in this browser.
	function localDefault() {
		try { return localStorage.getItem("plr-notes-bg") || "blank"; } catch { return "blank"; }
	}

	async function close() {
		aiBar.hidden = true;
		if (clipping) cancelClip();
		commit();
		await save();
		section.hidden = true;
		app.shell.classList.remove("notes-open");
	}

	return {
		open,
		close,
		isOpen: () => !section.hidden,
		base: () => (section.hidden ? null : note.base),
		insertImage,
		save,
	};
}
