/* The chat page of the web interface. Plain JavaScript, no build step.
   The conversation itself lives on the server (src/web/dialog.ts); this
   script renders the dialog state, sends answers, shows job progress from
   the SSE stream, and hosts the report panel, the rail lists and the
   Settings dialog. Everything shown as a citation or a file name comes
   from the server's data unchanged. */
(() => {
	"use strict";
	const $ = (id) => document.getElementById(id);
	const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

	/** pi.dev's three-colour logo is shown inside pi only once its use is
	 * confirmed with pi.dev (press kit names no terms); until then the plain
	 * Greek pi stands everywhere. */
	const PI_DEV_MARK_ALLOWED = false;

	const state = {
		dialog: null,
		/** Progress lines per job id (from the SSE stream). */
		lines: new Map(),
		/** Job ids whose log the user opened (survives the frequent re-renders). */
		workingOpen: new Set(),
		job: null,
		info: null,
		report: { url: null, name: null },
		panelClosedByUser: false,
		renderedKey: "",
		/** Stage whose rail block was opened last by the dialog (not by the user). */
		lastStage: null,
		/** Result lists by run name: rows from GET /api/runs/cards, the
		 * reader's filters, sort, ticks and panel state (browser memory only). */
		results: new Map(),
		/** The download window: whether to store a typed Unpaywall address, and the
		 * finished-download message the user already closed. */
		modal: { save: false, dismissed: 0, reloaded: 0, blocks: false },
	};

	/* ---------------- HTTP ---------------- */
	async function api(method, path, body) {
		const response = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
		let data = null;
		try { data = await response.json(); } catch { /* empty body */ }
		if (!response.ok) {
			const error = new Error((data && data.error) || `${response.status} ${response.statusText}`);
			error.status = response.status;
			throw error;
		}
		return data;
	}
	const get = (path) => api("GET", path);
	const post = (path, body) => api("POST", path, body || {});

	function toast(text) {
		const el = $("toast");
		el.textContent = text;
		el.hidden = false;
		clearTimeout(toast.timer);
		toast.timer = setTimeout(() => { el.hidden = true; }, 3200);
	}

	/* ---------------- inline markup ---------------- */
	/** Plain text with **bold** and `code` only; everything else escaped. */
	function markup(text) {
		return esc(text)
			.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
	}

	const ICON_DOC = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M6 2.8h8l4 4v14.4H6z"/><path d="M14 2.8v4h4"/><path d="M8.5 12h7M8.5 15.5h7M8.5 19h4" stroke-linecap="round"/></svg>';
	const ICON_FOLDER_BIG = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 6.5h6l2 2h10v10H3z"/></svg>';
	const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
	const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 6.5h6l2 2h10v10H3z"/></svg>';

	/* ---------------- rendering the conversation ---------------- */
	function lineHtml(line) {
		const time = line.time.slice(11, 19);
		let cls = "";
		if (/done$|^written |verified \d|index ready|OK/.test(line.text)) cls = "ok";
		else if (/failed|error|unreachable|cancel/i.test(line.text)) cls = "bad";
		else if (/dropped|note:|warning|skipped|not queried/i.test(line.text)) cls = "warn";
		return `<span class="dim">${esc(time)}</span> <span class="${cls}">${esc(line.text)}</span>\n`;
	}

	function chipsHtml(message) {
		if (!message.chips || !message.chips.length) return "";
		return `<div class="chips">${message.chips.map((chip) => {
			const classes = ["chip", chip.toggle ? "toggle" : "", chip.toggle && chip.on ? "on" : "", chip.primary ? "primary" : ""].filter(Boolean).join(" ");
			return `<button type="button" class="${classes}" data-chip="${esc(chip.id)}" ${chip.disabled ? "disabled" : ""} ${chip.title ? `title="${esc(chip.title)}"` : ""}>${esc(chip.label)}</button>`;
		}).join("")}</div>`;
	}

	function listHtml(message) {
		const list = message.list;
		if (!list) return "";
		const type = list.single ? "radio" : "checkbox";
		return `<details class="list" ${list.open ? "open" : ""}><summary>${esc(list.summary)}</summary><div class="items">${list.items.map((item) => `<label><input type="${type}" name="list-${message.id}" data-id="${esc(item.id)}" ${item.on ? "checked" : ""} ${message.spent ? "disabled" : ""}><span>${esc(item.label)}</span></label>`).join("")}</div></details>`;
	}

	/** The keyword blocks as rows of terms: one row per block (a paper must
	 * match every row), one small box per term (alternatives inside a row).
	 * "+" adds a term, "x" removes one, "+ Add block" a new row. */
	function termHtml(term, disabled) {
		return `<span class="term"><input type="text" value="${esc(term)}" size="${Math.max(3, term.length)}" ${disabled ? "disabled" : ""} aria-label="Term"><button type="button" class="ed" data-ed="rmterm" title="Remove this term" aria-label="Remove term">×</button></span>`;
	}
	function blockRowHtml(line, disabled) {
		const terms = String(line).split(/\s+OR\s+/).map((term) => term.trim()).filter(Boolean);
		return `<div class="brow">${(terms.length ? terms : [""]).map((term) => termHtml(term, disabled)).join("")}<button type="button" class="ed add" data-ed="addterm" title="Add a synonym to this block" aria-label="Add term">+</button><button type="button" class="ed rm" data-ed="rmblock" title="Remove this block" aria-label="Remove block">${ICON_TRASH}</button></div>`;
	}
	function editorHtml(message) {
		if (!message.editor) return "";
		const disabled = Boolean(message.spent);
		return `<div class="blocks">${message.editor.map((line, index) => `${index ? '<div class="and">and</div>' : ""}${blockRowHtml(line, disabled)}`).join("")}<button type="button" class="ed addblock" data-ed="addblock">+ Add block</button></div>`;
	}
	/** Edits inside a block editor change the page only; the rows are read
	 * when a chip is clicked (collect). */
	function editBlocks(event) {
		const button = event.target.closest("button[data-ed]");
		if (!button) return false;
		const blocks = button.closest(".blocks");
		const row = button.closest(".brow");
		const action = button.dataset.ed;
		if (action === "addterm") {
			button.insertAdjacentHTML("beforebegin", termHtml("", false));
			button.previousElementSibling.querySelector("input").focus();
		} else if (action === "rmterm") {
			const term = button.closest(".term");
			if (row.querySelectorAll(".term").length > 1) term.remove(); else term.querySelector("input").value = "";
		} else if (action === "rmblock") {
			if (blocks.querySelectorAll(".brow").length > 1) {
				const separator = row.previousElementSibling && row.previousElementSibling.classList.contains("and") ? row.previousElementSibling : row.nextElementSibling;
				if (separator && separator.classList.contains("and")) separator.remove();
				row.remove();
			}
		} else if (action === "addblock") {
			button.insertAdjacentHTML("beforebegin", `<div class="and">and</div>${blockRowHtml("", false)}`);
			button.previousElementSibling.querySelector("input").focus();
		}
		return true;
	}
	/** One "a OR b" line per block row, empty rows left out. */
	function blockLines(node) {
		return Array.from(node.querySelectorAll(".blocks .brow"))
			.map((row) => Array.from(row.querySelectorAll("input")).map((input) => input.value.trim()).filter(Boolean).join(" OR "))
			.filter(Boolean);
	}

	/** The engine's prose with its [n] markers turned into page links, and
	 * the model's light markdown (bold, bullet lines, bold-only heading
	 * lines) rendered. Everything is escaped first; links come from the
	 * server's hrefs only. */
	/** Passage numbers for the chat: the engine's markers are paper-level
	 * [n] (one paper = every marker [1]); here each cited PASSAGE gets its
	 * own number in order of first appearance, the same passage always the
	 * same number. Pure display over the engine's `sites` (chunk_id, page);
	 * the protocol and the HTML reports keep the paper numbering. */
	function passageNumbers(sites) {
		const numbers = new Map();
		for (const site of sites || []) {
			const key = `${site.paper_key}#${site.chunk_id}`;
			if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
		}
		return (site) => numbers.get(`${site.paper_key}#${site.chunk_id}`);
	}
	function proseHtml(prose, sites, hrefs) {
		let index = 0;
		const numberOf = passageNumbers(sites);
		const withMarkers = esc(prose).replace(/\[(\d+)\]/g, (match) => {
			const site = sites && sites[index];
			const href = hrefs && hrefs[index];
			index++;
			if (!site) return match;
			const n = numberOf(site);
			return href ? `<sup><a href="${esc(href)}" class="pdf-link" data-page="${esc(site.page)}" title="page ${esc(site.page)}">[${n}]</a></sup>` : `<sup>[${n}]</sup>`;
		});
		const inline = (text) => text.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, "$1<i>$2</i>");
		const out = [];
		let list = null;
		const flush = () => { if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; } };
		for (const raw of withMarkers.split(/\n/)) {
			const line = raw.trim();
			if (!line) { flush(); continue; }
			const bullet = /^(?:[*\-\u2022]|\d+[.)])\s+(.*)$/.exec(line);
			if (bullet) { (list = list || []).push(`<li>${inline(bullet[1])}</li>`); continue; }
			flush();
			const heading = /^(?:#{1,4}\s+(.*)|\*\*([^*]+)\*\*:?)$/.exec(line);
			if (heading) { out.push(`<p class="h">${inline(heading[1] || heading[2])}</p>`); continue; }
			out.push(`<p>${inline(line)}</p>`);
		}
		flush();
		return out.join("");
	}

	function authorsShort(authors) {
		if (!authors || !authors.length) return "";
		const first = String(authors[0]).split(/\s+/).pop();
		return authors.length > 2 ? `${first} et al.` : authors.length === 2 ? `${first} and ${String(authors[1]).split(/\s+/).pop()}` : first;
	}

	/** A chat on one PDF shows that PDF on the right (reopened from History);
	 * any other conversation closes the panel. */
	function showConversationPdf() {
		if (onePdfChat()) {
			state.panelClosedByUser = false;
			showPdf(`/pdf/${encodeURIComponent(state.dialog.answers.scope[0])}.pdf`, true);
		} else closePanel();
	}
	function closePanel() {
		setPopup(false);
		shell.classList.add("no-report");
	}
	/** The open conversation is a chat on ONE PDF (from the library, or dropped). */
	function onePdfChat(dialog = state.dialog) {
		// A single paper picked in the "+" menu carries a scope label: that is
		// a library chat narrowed to one paper, not a one-PDF chat.
		return Boolean(dialog && dialog.answers && Array.isArray(dialog.answers.scope) && dialog.answers.scope.length === 1 && !dialog.answers.scopeLabel);
	}
	// A reply without any cited passage (small talk, "thanks", a question
	// the PDF does not answer): shown as it is, marked quietly as not
	// backed by the PDF. The HTML reports keep their strong warning.
	const UNCITED_TAG = '<span class="uncited" title="The model cited no passage: nothing in this reply is backed by the PDF">no source cited</span>';
	function answerHtml(view) {
		const round = view.answer;
		// A chat on one PDF reads like a chat: the prose with its [n] links
		// (each opens the passage), nothing below it.
		if (onePdfChat()) {
			return `<div class="answer ${round.grounded ? "" : "ungrounded"}">${round.grounded ? "" : UNCITED_TAG}<div class="prose">${proseHtml(round.prose, round.sites || [], view.hrefs)}</div></div>`;
		}
		const sites = round.sites || [];
		const numberOf = passageNumbers(sites);
		// One line per passage (first occurrence), numbered like the markers.
		const seen = new Set();
		const cites = sites.map((site, index) => {
			const n = numberOf(site);
			if (seen.has(n)) return "";
			seen.add(n);
			const reference = (round.references || []).find((ref) => ref.n === site.ref);
			const who = reference ? `${esc(authorsShort(reference.authors) || reference.title || reference.key)} ${esc(reference.year || "")}` : esc(site.paper_key);
			const chunk = (round.chunks || []).find((c) => c.id === site.chunk_id);
			const quote = chunk ? `: "${esc(chunk.text.slice(0, 160))}${chunk.text.length > 160 ? " ..." : ""}"` : "";
			const link = view.hrefs && view.hrefs[index] ? `<a href="${esc(view.hrefs[index])}" class="pdf-link" data-page="${esc(site.page)}">p. ${esc(site.page)}</a>` : `p. ${esc(site.page)}`;
			return `<li><span class="n">[${n}]</span> ${who}, ${link}${quote}</li>`;
		}).join("");
		const refs = (round.references || []).map((ref) => `${esc(authorsShort(ref.authors) || "")} ${esc(ref.year || "n.d.")} · ${esc(ref.title || ref.key)}${ref.doi ? ` · <a href="https://doi.org/${esc(ref.doi)}" target="_blank" rel="noopener">${esc(ref.doi)}</a>` : ""}${view.pdfUrls && view.pdfUrls[ref.key] ? ` · <a href="${esc(view.pdfUrls[ref.key])}" class="pdf-link">PDF</a>` : ""}`).join("<br>");
		return `<div class="answer ${round.grounded ? "" : "ungrounded"}">${round.grounded ? "" : UNCITED_TAG}<div class="prose">${proseHtml(round.prose, sites, view.hrefs)}</div>
${cites ? `<p class="trail">Cited passages, numbered as in the text; the page link opens the PDF at the passage in the panel.</p><ul class="cites">${cites}</ul>` : ""}
${refs ? `<p class="trail">Papers (verified records):<br>${refs}</p>` : ""}
<p class="trail">Prose by the model over the retrieved passages; citation numbers and page links inserted by code.${round.model ? ` Model ${esc(round.model)}.` : ""}</p></div>`;
	}

	function cardHtml(message) {
		const card = message.card;
		const folderButton = `<button type="button" class="folder" data-folder="${esc(card.stage)}" ${card.path ? `data-path="${esc(card.path)}"` : ""} title="Show ${esc(card.path || `${card.stage}/`)} in the file manager">${ICON_FOLDER}</button>`;
		if (card.kind === "folder") {
			return `<div class="filecard">${ICON_FOLDER_BIG}<div class="txt"><span class="name plain">${esc(card.name)}</span><small>${esc(card.label)}</small></div>${folderButton}</div>`;
		}
		return `<div class="filecard">${ICON_DOC}<div class="txt"><a href="${esc(card.url || "#")}" class="card-open" data-url="${esc(card.url || "")}" data-name="${esc(card.name)}" title="Open on the right">${esc(card.name)}</a><small>${esc(card.label)}</small></div>${folderButton}</div>`;
	}

	/* ---------------- result cards ---------------- */

	const ACCESS_LABEL = { free: "full text free", abstract_only: "abstract only", restricted: "restricted", unknown: "unknown" };
	const ICON_FILTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>';
	const ICON_RELOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
	const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg>';
	const SORT_LABELS = { relevance: "Relevance", cites: "Most cited", year: "Newest" };
	const ICON_SORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h10M4 17h5"/></svg>';
	const ICON_GRAPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.2 7l7.4.8M7.5 8l3.5 8M16.8 10l-3.6 6"/></svg>';
	/** Reports written on click from the (filtered) list; further add-ons
	 * are one more entry here (the server route decides what it writes). */
	const REPORT_ACTIONS = [
		{ kind: "html", label: "HTML report", title: "The documented HTML report of this list (PRISMA-style flow, tables, BibTeX)", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l5 5v13H6z"/><path d="M14 3v6h6M9 13h6M9 17h6"/></svg>' },
		{ kind: "prisma", label: "PRISMA diagram", title: "The screening-flow diagram of this list as an SVG file", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="5"/><rect x="13" y="10" width="8" height="5"/><rect x="3" y="17" width="8" height="4"/><path d="M7 8v9M11 5.5h5v4.5M11 12.5h2"/></svg>' },
	];

	const freshFilters = () => ({ yearFrom: null, access: new Set(), minCites: null, sources: new Set(), links: new Set(), kinds: new Set(), venues: new Set(), authors: new Set() });
	const KIND_LABEL = { journal: "Journal article", review: "Review article", conference: "Conference paper", abstract: "Conference abstract", preprint: "Preprint", book: "Book or chapter", other: "Other", unknown: "Unknown" };
	function resultsEntry(name) {
		let entry = state.results.get(name);
		if (!entry) {
			entry = { data: null, loading: false, error: null, filters: freshFilters(), sort: "relevance", open: false, listOpen: null, narrow: "", ticked: new Set(), showDropped: false, defaulted: false };
			state.results.set(name, entry);
		}
		return entry;
	}

	/** Rows loaded once per run; the list is drawn from memory afterwards. */
	async function loadResults(name) {
		const entry = resultsEntry(name);
		if (entry.data || entry.loading) return;
		entry.loading = true;
		try {
			entry.data = await get(`/api/runs/cards?name=${encodeURIComponent(name)}`);
			// The period filter starts at the searched window, so the list shows what was searched.
			if (!entry.defaulted) { entry.filters.yearFrom = entry.data.yearFrom; entry.defaulted = true; }
		} catch (error) {
			entry.error = error.message;
		} finally {
			entry.loading = false;
		}
		document.querySelectorAll(`.msg.results[data-run="${CSS.escape(name)}"]`).forEach((node) => { node.innerHTML = resultsHtml(name); });
	}

	function mountResults() {
		document.querySelectorAll(".msg.results[data-run]").forEach((node) => loadResults(node.dataset.run));
	}

	/** The same rules as src/web/results.ts (cardFilterReason), for the instant list. */
	function keepRow(row, f) {
		if (f.yearFrom !== null && f.yearFrom !== undefined) {
			const year = row.year && /^\d{4}$/.test(row.year) ? Number(row.year) : null;
			if (year === null || year < f.yearFrom) return false;
		}
		if (f.access.size && !f.access.has(row.access || "unknown")) return false;
		if (f.minCites !== null && row.cites !== null && row.cites < f.minCites) return false;
		if (f.sources.size && !row.sources.some((source) => f.sources.has(source))) return false;
		if (f.links.size && !((f.links.has("code") && row.codeUrl) || (f.links.has("data") && row.dataLinks.length))) return false;
		if (f.kinds.size && !f.kinds.has(row.kind || "unknown")) return false;
		if (f.venues.size && !f.venues.has(row.venue)) return false;
		if (f.authors.size && !row.authors.some((author) => f.authors.has(author))) return false;
		return true;
	}

	/** The filters as the server route reads them (results.ts parseCardFilters). */
	function filterBody(f) {
		const body = {};
		if (f.yearFrom !== null && f.yearFrom !== undefined) body.yearFrom = f.yearFrom;
		if (f.access.size) body.access = [...f.access];
		if (f.minCites !== null) body.minCites = f.minCites;
		if (f.sources.size) body.sources = [...f.sources];
		if (f.links.size) body.links = [...f.links];
		if (f.kinds.size) body.kinds = [...f.kinds];
		if (f.venues.size) body.venues = [...f.venues];
		if (f.authors.size) body.authors = [...f.authors];
		return body;
	}

	function describeFilters(entry) {
		const f = entry.filters; const thisYear = entry.data.thisYear; const parts = [];
		if (f.yearFrom !== null && f.yearFrom !== undefined) parts.push(`last ${thisYear - f.yearFrom + 1} years`);
		if (f.access.size) parts.push([...f.access].map((a) => ACCESS_LABEL[a]).join(" or "));
		if (f.minCites !== null) parts.push(`${f.minCites}+ citations`);
		if (f.sources.size) parts.push([...f.sources].join(" or "));
		if (f.links.size) parts.push(`with ${[...f.links].join(" or ")}`);
		if (f.kinds.size) parts.push([...f.kinds].map((kind) => KIND_LABEL[kind]).join(" or "));
		if (f.venues.size) parts.push(`${f.venues.size} journal${f.venues.size === 1 ? "" : "s"}`);
		if (f.authors.size) parts.push(`${f.authors.size} author${f.authors.size === 1 ? "" : "s"}`);
		return parts;
	}

	function visibleRows(entry) {
		const rows = entry.data.rows.filter((row) => entry.showDropped || !row.dropped).filter((row) => keepRow(row, entry.filters));
		if (entry.sort === "cites") return [...rows].sort((a, b) => (b.cites ?? -1) - (a.cites ?? -1));
		if (entry.sort === "year") return [...rows].sort((a, b) => Number(b.year || 0) - Number(a.year || 0));
		return rows;
	}

	/** Names in the rows with their counts, most frequent first. */
	function nameCounts(rows, pick) {
		const counts = new Map();
		for (const row of rows) for (const name of pick(row)) if (name) counts.set(name, (counts.get(name) || 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	}
	/** A journal or author row: a button with the choice, under it (open)
	 * the names of the list to tick, with a box to narrow long lists. */
	function pickRowHtml(entry, key, rows, noun) {
		const set = entry.filters[key];
		const names = nameCounts(rows, key === "venues" ? (row) => [row.venue] : (row) => [...new Set(row.authors)]);
		const open = entry.listOpen === key;
		const label = set.size ? `${set.size} ${noun}${set.size === 1 ? "" : "s"}` : `All ${noun}s`;
		let body = `<button type="button" class="chip pickbtn ${set.size ? "on" : ""}" data-act="openlist" data-list="${key}" aria-expanded="${open}">${esc(label)} <span aria-hidden="true">${open ? "▾" : "›"}</span></button>`;
		if (set.size) body += `<button type="button" class="chip" data-act="clearlist" data-list="${key}" title="Back to all ${noun}s">×</button>`;
		if (open) {
			const narrow = entry.narrow.trim().toLowerCase();
			const shown = names.filter(([name]) => set.has(name) || !narrow || name.toLowerCase().includes(narrow));
			body += `<div class="picklist" data-list="${key}">${names.length > 12 ? `<input type="text" data-act="narrow" value="${esc(entry.narrow)}" placeholder="Find ..." aria-label="Find a name">` : ""}<div class="picks">${shown.map(([name, count]) => `<label><input type="checkbox" data-act="pickname" data-list="${key}" value="${esc(name)}" ${set.has(name) ? "checked" : ""}><span>${esc(name)}</span><small>${count}</small></label>`).join("")}</div></div>`;
		}
		return `<td class="pickcell">${body}</td>`;
	}
	/** The "+" menu's icon for an option, with a small arrow: this runs the search again. */
	function rerunIcon(key) {
		return `<span class="rerun">${optionIcon(key)}<span class="mini">${ICON_RELOAD}</span></span>`;
	}
	/** Small yes/no window (a confirmation before a new search). */
	function confirmBox(title, text, okLabel) {
		return new Promise((resolve) => {
			let box = document.getElementById("confirm");
			if (!box) { box = document.createElement("dialog"); box.id = "confirm"; box.className = "modal"; document.body.appendChild(box); }
			box.innerHTML = `<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="modal-actions"><button type="button" class="primary" data-ok="1">${esc(okLabel)}</button><button type="button" data-ok="0">Cancel</button></div>`;
			const done = (ok) => { box.close(); resolve(ok); };
			box.onclick = (event) => { const button = event.target.closest("[data-ok]"); if (button) done(button.dataset.ok === "1"); };
			box.oncancel = (event) => { event.preventDefault(); done(false); };
			box.showModal();
			box.querySelector("[data-ok=\"1\"]").focus();
		});
	}

	function periodChips(entry) {
		const thisYear = entry.data.thisYear; const window = entry.data.yearFrom; const f = entry.filters;
		const chips = [5, 10, 20].map((years) => ({ years, yearFrom: thisYear - years + 1 }));
		const html = chips.map(({ years, yearFrom }) => {
			const local = window === null || yearFrom >= window;
			const on = f.yearFrom === yearFrom;
			return `<button type="button" class="chip ${on ? "on" : ""}" data-act="period" data-year="${yearFrom}" data-local="${local ? 1 : 0}" title="${local ? `Papers published ${yearFrom} or later` : `The search covered ${window} onwards: this runs the search again with a ${years}-year window`}">Last ${years} years${local ? "" : " ↻"}</button>`;
		}).join("");
		const allLocal = window === null;
		return html + `<button type="button" class="chip ${f.yearFrom === null ? "on" : ""}" data-act="period" data-year="" data-local="${allLocal ? 1 : 0}" title="${allLocal ? "Every year" : `The search covered ${window} onwards: this runs the search again without a window`}">All${allLocal ? "" : " ↻"}</button>`;
	}

	function cardRowHtml(row, entry) {
		const access = row.access || "unknown";
		const authors = row.authors.slice(0, 3).join(", ") + (row.authors.length > 3 ? ` and ${row.authors.length - 3} more` : "");
		const links = [];
		if (row.doi) links.push(`<a href="https://doi.org/${esc(row.doi)}" target="_blank" rel="noopener">DOI</a>`);
		if (row.arxiv) links.push(`<a href="https://arxiv.org/abs/${esc(row.arxiv)}" target="_blank" rel="noopener">arXiv</a>`);
		if (row.pdf) links.push(`<a href="${esc(row.pdf)}" target="_blank" rel="noopener">PDF</a>`);
		if (row.codeUrl) links.push(`<a href="${esc(row.codeUrl)}" target="_blank" rel="noopener">Code</a>`);
		const seenArchives = new Set();
		for (const link of row.dataLinks) { if (seenArchives.has(link.archive)) continue; seenArchives.add(link.archive); links.push(`<a href="${esc(link.url)}" target="_blank" rel="noopener">Data${link.archive ? ` (${esc(link.archive)})` : ""}</a>`); }
		const graphHash = [row.doi ? `doi=${encodeURIComponent(row.doi)}` : "", `title=${encodeURIComponent(row.title)}`].filter(Boolean).join("&");
		links.push(`<a href="/files/lit-search/network.html#${graphHash}" class="graph" data-act="graph" data-title="${esc(row.title)}" title="Citation neighbourhood of this paper (fetched live from OpenAlex)">${ICON_GRAPH}Graph</a>`);
		const tick = row.id
			? `<input type="checkbox" data-act="tick" data-id="${esc(row.id)}" ${entry.ticked.has(row.id) ? "checked" : ""} title="Tick for download">`
			: `<span class="notick" title="No DOI or arXiv id: cannot be downloaded here"></span>`;
		const meta = [esc(row.year || "n.d."), row.venue ? `<b>${esc(row.venue)}</b>` : "venue not given", row.journalScore !== null ? `journal score ${Number(row.journalScore).toFixed(1)}` : ""].filter(Boolean).join(" · ");
		const flags = [row.inLibrary ? '<span class="flag">in library</span>' : "", row.group === "on_target" ? '<span class="flag">on target</span>' : "", row.dropped ? `<span class="flag dropped" title="${esc(row.reason || "")}">dropped: ${esc(row.reason || "")}</span>` : ""].join("");
		return `<div class="pcard ${row.dropped ? "isdropped" : ""}" data-n="${row.n}">${tick}
<div class="body"><div class="t">${row.url ? `<a href="${esc(row.url)}" target="_blank" rel="noopener">${esc(row.title)}</a>` : esc(row.title)}</div>
<div class="a">${esc(authors) || "authors not given"}</div><div class="v">${meta}</div>${flags ? `<div class="flags">${flags}</div>` : ""}</div>
<div class="right"><span class="badge ${esc(access)}">${ACCESS_LABEL[access]}</span><span class="cites"><b>${row.cites === null ? "–" : row.cites}</b> citations</span></div>
<div class="links">${links.join("")}<span class="src">${esc(row.sources.join(" + "))}</span></div>
${row.abstract ? `<details class="abs"><summary>Abstract</summary>${esc(row.abstract)}</details>` : ""}</div>`;
	}

	function resultsHtml(name) {
		const entry = resultsEntry(name);
		if (entry.error) return `<div class="rhead"><span class="rmeta">The result list could not be loaded: ${esc(entry.error)}</span></div>`;
		if (!entry.data) return `<div class="rhead"><span class="rmeta"><span class="dot busy"></span>loading the results ...</span></div>`;
		const data = entry.data; const f = entry.filters;
		const rows = visibleRows(entry);
		const total = data.rows.filter((row) => !row.dropped).length;
		// "show n dropped" counts the dropped records the active filters let through,
		// so showing them adds exactly that many cards.
		const droppedCount = data.rows.filter((row) => row.dropped && keepRow(row, f)).length;
		const free = rows.filter((row) => row.access === "free").length;
		const hidden = data.rows.filter((row) => entry.showDropped || !row.dropped).length - rows.length;
		const active = describeFilters(entry);
		// Download, add-on and "search again" act on the newest list only; older
		// lists keep their filters and the report buttons.
		const lists = state.dialog ? state.dialog.messages.filter((message) => message.role === "results") : [];
		const latest = lists.length && lists[lists.length - 1].run === name;
		const pickOpen = latest && state.dialog.step === "pick" && !state.dialog.activeJob && !state.dialog.pending;
		const sources = [...new Set(data.rows.flatMap((row) => row.sources))];
		// Choices of the type, code, journal and author rows come from the list itself.
		const pool = data.rows.filter((row) => entry.showDropped || !row.dropped);
		const kinds = nameCounts(pool, (row) => [row.kind || "unknown"]).sort((a, b) => Object.keys(KIND_LABEL).indexOf(a[0]) - Object.keys(KIND_LABEL).indexOf(b[0]));
		const codeOn = Boolean(data.code_sources_used && data.code_sources_used.length);
		const blocks = (state.dialog && state.dialog.answers && state.dialog.answers.blocks.length ? state.dialog.answers.blocks : String(data.query || "").split(" AND ").map((block) => block.replace(/^\(|\)$/g, ""))).map((block) => `(${block})`).join(" AND ");
		return `<div class="rhead"><span class="rcount"><b>${rows.length}</b> paper${rows.length === 1 ? "" : "s"} <span class="rsub">(${free} with free full text${hidden ? `, ${hidden} hidden by filters` : ""})</span></span>
</div>
<div class="rtools"><span class="sortwrap"><button type="button" class="ibtn ${entry.sortOpen ? "on" : ""}" data-act="sort" title="Sort the list" aria-haspopup="menu" aria-expanded="${entry.sortOpen ? "true" : "false"}">${ICON_SORT}${SORT_LABELS[entry.sort]}</button>${entry.sortOpen ? `<div class="sortmenu" role="menu">${Object.entries(SORT_LABELS).map(([key, label]) => `<button type="button" role="menuitemradio" aria-checked="${entry.sort === key}" class="${entry.sort === key ? "on" : ""}" data-act="sortby" data-sort="${key}">${label}</button>`).join("")}</div>` : ""}</span>
<button type="button" class="ibtn ${active.length ? "on" : ""}" data-act="filters" title="Filter the list">${ICON_FILTER}Filter${active.length ? ` (${active.length})` : ""}</button>
${latest ? `<span class="tsep" aria-hidden="true"></span><button type="button" class="ibtn" data-act="editblocks" title="Searched: ${esc(blocks)}. Change keywords or synonyms; a new search runs">${rerunIcon("synonyms")}Keywords &amp; synonyms</button>` : ""}${pickOpen && !codeOn ? `<button type="button" class="ibtn" data-act="addcode" title="A new search with the code sources on (about 20-60 s more); list topics chosen automatically">${rerunIcon("code")}Add papers with code</button>` : ""}</div>
<table class="rfilters" ${entry.open ? "" : "hidden"}><tbody>
<tr><th>Published</th><td class="chips">${periodChips(entry)}</td></tr>
<tr><th>Full text</th><td class="chips">${["free", "abstract_only", "restricted"].map((level) => `<button type="button" class="chip ${f.access.has(level) ? "on" : ""}" data-act="access" data-v="${level}">${ACCESS_LABEL[level]}</button>`).join("")}</td></tr>
<tr><th>Citations</th><td class="chips">${[1, 10, 50].map((n) => `<button type="button" class="chip ${f.minCites === n ? "on" : ""}" data-act="cites" data-v="${n}">${n}+</button>`).join("")}</td></tr>
<tr><th>Type</th><td class="chips">${kinds.map(([kind, count]) => `<button type="button" class="chip ${f.kinds.has(kind) ? "on" : ""}" data-act="kind" data-v="${kind}">${KIND_LABEL[kind]} <small>${count}</small></button>`).join("")}</td></tr>
<tr><th>Code / data</th><td class="chips"><button type="button" class="chip ${f.links.has("code") ? "on" : ""}" data-act="link" data-v="code" title="Papers with a code repository">Code <small>${pool.filter((row) => row.codeUrl).length}</small></button><button type="button" class="chip ${f.links.has("data") ? "on" : ""}" data-act="link" data-v="data" title="Papers with a data archive link">Data <small>${pool.filter((row) => row.dataLinks.length).length}</small></button></td></tr>
<tr><th>Journal</th>${pickRowHtml(entry, "venues", pool, "journal")}</tr>
<tr><th>Author</th>${pickRowHtml(entry, "authors", pool, "author")}</tr>
<tr><th>Source</th><td class="chips">${sources.map((source) => `<button type="button" class="chip ${f.sources.has(source) ? "on" : ""}" data-act="source" data-v="${esc(source)}">${esc(source)}</button>`).join("")}</td></tr>
<tr><th>Dropped</th><td class="chips"><button type="button" class="chip ${entry.showDropped ? "on" : ""}" data-act="dropped" title="Records the search set aside (no abstract, off topic, ...), each with its reason">Show dropped records <small>${data.rows.filter((row) => row.dropped).length}</small></button></td></tr>
<tr class="foot"><th></th><td><button type="button" class="chip" data-act="clear">Clear filters</button>${pickOpen ? `<button type="button" class="chip" data-act="again" title="Send the period and citation filters to the sources as a new query: more papers inside the filter">Search again with these filters</button>` : ""}</td></tr>
</tbody></table>
<div class="rlist">${rows.length ? rows.map((row) => cardRowHtml(row, entry)).join("") : '<div class="rempty">No paper matches these filters. Widen a filter, or search again with the filters sent to the sources.</div>'}</div>
<div class="ractions">${pickOpen ? `<button type="button" class="ibtn primary" data-act="download" ${entry.ticked.size ? "" : "disabled"}>Download ${entry.ticked.size} ticked PDF${entry.ticked.size === 1 ? "" : "s"}</button><span class="sep"></span>` : ""}<span class="lbl">Reports from this list:</span>${REPORT_ACTIONS.map((action) => `<button type="button" class="ibtn" data-act="report" data-kind="${action.kind}" title="${esc(action.title)}">${action.icon}${action.label}</button>`).join("")}</div>`;
	}

	function redrawResults(name) {
		document.querySelectorAll(`.msg.results[data-run="${CSS.escape(name)}"]`).forEach((node) => { node.innerHTML = resultsHtml(name); });
	}

	/** Ticks of the newest result list on the page (the pick step reads them). */
	function tickedInResults() {
		const nodes = document.querySelectorAll(".msg.results[data-run]");
		const last = nodes[nodes.length - 1];
		if (!last) return [];
		return [...resultsEntry(last.dataset.run).ticked];
	}

	$("thread").addEventListener("change", (event) => {
		const box = event.target.closest(".msg.results input[data-act=\"tick\"]");
		if (!box) return;
		const name = box.closest(".msg.results").dataset.run; const entry = resultsEntry(name);
		if (box.checked) entry.ticked.add(box.dataset.id); else entry.ticked.delete(box.dataset.id);
		const button = box.closest(".msg.results").querySelector('[data-act="download"]');
		if (button) { button.disabled = !entry.ticked.size; button.textContent = `Download ${entry.ticked.size} ticked PDF${entry.ticked.size === 1 ? "" : "s"}`; }
	});
	$("thread").addEventListener("input", (event) => {
		const input = event.target.closest(".msg.results input[data-act=\"narrow\"]");
		if (!input) return;
		const node = input.closest(".msg.results"); const entry = resultsEntry(node.dataset.run);
		entry.narrow = input.value;
		// Only the names under the box change, so the box keeps the focus.
		const list = input.closest(".picklist");
		const fresh = document.createElement("div");
		fresh.innerHTML = resultsHtml(node.dataset.run);
		const picks = fresh.querySelector(`.picklist[data-list="${list.dataset.list}"] .picks`);
		if (picks) list.querySelector(".picks").innerHTML = picks.innerHTML;
	});
	// A ticked journal or author narrows the list; the open name list keeps its scroll position.
	$("thread").addEventListener("change", (event) => {
		const box = event.target.closest(".msg.results input[data-act=\"pickname\"]");
		if (!box) return;
		const node = box.closest(".msg.results"); const name = node.dataset.run; const entry = resultsEntry(name);
		const set = entry.filters[box.dataset.list];
		if (box.checked) set.add(box.value); else set.delete(box.value);
		const scroll = node.querySelector(`.picklist[data-list="${box.dataset.list}"] .picks`);
		const top = scroll ? scroll.scrollTop : 0;
		redrawResults(name);
		const again = node.querySelector(`.picklist[data-list="${box.dataset.list}"] .picks`);
		if (again) again.scrollTop = top;
	});
	$("thread").addEventListener("click", async (event) => {
		const target = event.target.closest(".msg.results [data-act]");
		if (!target || ["tick", "narrow", "pickname"].includes(target.dataset.act)) return;
		const node = target.closest(".msg.results"); const name = node.dataset.run; const entry = resultsEntry(name); const f = entry.filters;
		const act = target.dataset.act;
		if (act === "graph") { event.preventDefault(); state.panelClosedByUser = false; showReport(target.getAttribute("href"), `Citation graph: ${target.dataset.title}`); setPopup(true); return; }
		if (act === "dropped") { event.preventDefault(); entry.showDropped = !entry.showDropped; redrawResults(name); return; }
		if (act === "filters") { entry.open = !entry.open; redrawResults(name); return; }
		if (act === "sort") { entry.sortOpen = !entry.sortOpen; redrawResults(name); return; }
		if (act === "sortby") { entry.sort = target.dataset.sort; entry.sortOpen = false; redrawResults(name); return; }
		if (act === "period") {
			const yearFrom = target.dataset.year === "" ? null : Number(target.dataset.year);
			if (target.dataset.local === "1") { f.yearFrom = yearFrom; redrawResults(name); return; }
			// Wider than the searched window: the sources are asked again, after a yes.
			const from = entry.data.yearFrom;
			const ok = await confirmBox("Start a new search?", `This list covers ${from} onwards. ${yearFrom === null ? "All years" : `Papers from ${yearFrom} on`} need a new search; this list is replaced.`, "Search");
			if (!ok) return;
			await answer({ chip: "searchAgain", filters: yearFrom === null ? { allYears: true } : { yearFrom } });
			return;
		}
		if (act === "access") { const v = target.dataset.v; f.access.has(v) ? f.access.delete(v) : f.access.add(v); redrawResults(name); return; }
		if (act === "cites") { const n = Number(target.dataset.v); f.minCites = f.minCites === n ? null : n; redrawResults(name); return; }
		if (act === "link" || act === "kind") { const set = act === "link" ? f.links : f.kinds; const v = target.dataset.v; set.has(v) ? set.delete(v) : set.add(v); redrawResults(name); return; }
		if (act === "openlist") { entry.listOpen = entry.listOpen === target.dataset.list ? null : target.dataset.list; entry.narrow = ""; redrawResults(name); return; }
		if (act === "clearlist") { f[target.dataset.list].clear(); redrawResults(name); return; }
		if (act === "source") { const v = target.dataset.v; f.sources.has(v) ? f.sources.delete(v) : f.sources.add(v); redrawResults(name); return; }
		if (act === "clear") { entry.filters = freshFilters(); entry.showDropped = false; redrawResults(name); return; }
		if (act === "again") {
			const filters = {};
			if (f.yearFrom !== null) filters.yearFrom = f.yearFrom; else filters.allYears = true;
			filters.minCites = f.minCites === null ? 0 : f.minCites;
			await answer({ chip: "searchAgain", filters });
			return;
		}
		if (act === "download") { state.modal.dismissed = 0; await answer({ chip: "ticked", ids: [...entry.ticked] }); return; }
		if (act === "editblocks") { openBlocksWindow(); return; }
		if (act === "addcode") {
			const ok = await confirmBox("Start a new search?", "The same keywords are searched again with the code sources added (about 20-60 s more); this list is replaced.", "Search");
			if (ok) await answer({ chip: "addCode" });
			return;
		}
		if (act === "report") {
			target.disabled = true;
			// The report opens as a window over the list; closing it leaves the list alone.
			try {
				const { card } = await post("/api/runs/report", { name, kind: target.dataset.kind, filters: filterBody(f) });
				state.panelClosedByUser = false;
				showReport(card.url, card.name);
				setPopup(true);
			} catch (error) { toast(error.message); } finally { target.disabled = false; }
			return;
		}
	});

	/* ---------------- the window over the list ---------------- */

	const ICON_FOLDER_SMALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

	function openWindow(html) {
		const modal = $("modal");
		$("modal-body").innerHTML = html;
		if (!modal.open) modal.showModal();
	}
	function closeWindow() {
		const modal = $("modal");
		if (modal.open) modal.close();
		$("modal-body").innerHTML = "";
	}

	/** What the window shows follows the dialog step: contact email, the
	 * download question, the running download, its result (until closed).
	 * Outside the results view the window stays closed (those steps then
	 * show as chat messages for the pi-style walk-through, which never
	 * happens in the browser now). */
	function renderModal(view, resultsView) {
		if (state.modal.blocks) return; // the edit-blocks window is open; it closes itself
		if (!resultsView) { closeWindow(); return; }
		const lastQuestion = [...view.messages].reverse().find((message) => message.role === "assistant" && message.step === view.step);
		if (view.step === "mailto") {
			const bad = lastQuestion && /does not look like/.test(lastQuestion.text || "");
			openWindow(`<h3>Contact email for Unpaywall</h3>
<p>${esc(lastQuestion ? lastQuestion.text : "Unpaywall needs a contact email (its policy).")}</p>
<p class="hint">${esc(lastQuestion ? lastQuestion.note || "" : "")}</p>
<form id="mailto-form"><label>Email address<input id="mailto-input" type="email" placeholder="name@example.org" autocomplete="email" ${bad ? 'aria-invalid="true"' : ""}></label>
<label class="check"><input id="mailto-save" type="checkbox" ${state.modal.save ? "checked" : ""}> Save it in the configuration for next time</label>
<div class="modal-actions"><button type="submit" class="primary">Use this address</button><button type="button" data-modal="without">Continue without Unpaywall</button><button type="button" data-modal="cancel">Cancel</button></div></form>`);
			const input = $("mailto-input");
			if (input && document.activeElement !== input) input.focus();
			return;
		}
		if (view.step === "mailtoSave") {
			// Answered from the checkbox of the previous screen.
			openWindow('<p><span class="dot busy"></span> One moment ...</p>');
			answer({ chip: state.modal.save ? "save" : "once" });
			return;
		}
		if (view.step === "download") {
			// Where the PDFs go: asked every time, the last folder preselected.
			if (state.modal.folderFor !== lastQuestion?.id) {
				state.modal.folderFor = lastQuestion?.id;
				state.modal.folder = "";
				get("/api/folders").then((data) => {
					state.modal.canPick = data.canPick;
					if (!state.modal.folder) state.modal.folder = data.lastDownloadDir || "";
					renderDownloadWindow(lastQuestion);
				}).catch(() => renderDownloadWindow(lastQuestion));
			}
			renderDownloadWindow(lastQuestion);
			return;
		}
		if (view.step === "downloading") {
			const working = [...view.messages].reverse().find((message) => message.role === "working" && message.job === view.activeJob);
			openWindow(`<h3>Downloading ...</h3>${working ? workingHtml(working) : ""}`);
			return;
		}
		// A finished download: its summary and the folder, until the user closes it.
		const finished = [...view.messages].reverse().find((message) => message.quiet && message.role === "assistant" && /Download finished/.test(message.text || ""));
		if (finished && finished.id !== state.modal.reloaded) {
			// The library changed: the newest list reloads its cards (library
			// badges) and drops its ticks.
			state.modal.reloaded = finished.id;
			const lists = view.messages.filter((message) => message.role === "results");
			const name = lists.length ? lists[lists.length - 1].run : null;
			if (name) { const entry = resultsEntry(name); entry.data = null; entry.ticked.clear(); loadResults(name); }
		}
		if (finished && finished.id !== state.modal.dismissed) {
			const folder = view.messages.find((message) => message.role === "card" && message.quiet && message.id > finished.id);
			openWindow(`<h3>Download finished</h3><p>${markup(finished.text.replace(/^\*\*Download finished:\*\*\s*/, ""))}</p>${finished.note ? `<p class="hint">${markup(finished.note)}</p>` : ""}
${folder ? `<p class="folderline">${ICON_FOLDER_SMALL}<b title="${esc(folder.card.path || "")}">${esc(folder.card.name)}</b> ${esc(folder.card.label)} <button type="button" class="chip" data-modal="folder" ${folder.card.path ? `data-path="${esc(folder.card.path)}"` : ""}>Show in the file manager</button></p>` : ""}
<div class="modal-actions"><button type="button" class="primary" data-modal="close" data-id="${finished.id}">Back to the list</button></div>`);
			return;
		}
		closeWindow();
	}

	/** The download window: what is downloaded, into which folder (choose
	 * in the system window, or type a path where there is none). */
	function renderDownloadWindow(question) {
		const folder = state.modal.folder || "";
		const typed = state.modal.canPick === false;
		openWindow(`<h3>Download</h3><p>${markup(question ? question.text : "Download the ticked papers?")}</p>${question && question.note ? `<p class="hint">${markup(question.note)}</p>` : ""}
<div class="dlfolder">${ICON_FOLDER_SMALL}${typed
			? `<input type="text" id="dl-folder-path" value="${esc(folder)}" placeholder="/full/path/to/a/folder" aria-label="Download folder">`
			: `<span class="path" title="${esc(folder)}">${esc(folder || "No folder chosen")}</span><button type="button" class="chip" data-modal="choosefolder">${folder ? "Change ..." : "Choose folder ..."}</button>`}</div>
<div class="modal-actions"><button type="button" class="primary" data-modal="download" ${folder || typed ? "" : "disabled"}>Download</button><button type="button" data-modal="cancel">Cancel</button></div>`);
	}

	/** "Edit keywords": the current blocks in a text box; confirming searches again. */
	function openBlocksWindow() {
		const blocks = state.dialog && state.dialog.answers ? state.dialog.answers.blocks : [];
		state.modal.blocks = true;
		openWindow(`<h3 class="wtitle">${optionIcon("synonyms")}Keywords &amp; synonyms</h3>
<form id="blocks-form"><div id="blocks-edit">${editorHtml({ editor: blocks.length ? blocks : [""] })}</div>
<button type="button" class="ibtn regen" data-modal="synonyms" title="Ask the model for synonyms of your request">${ICON_RELOAD}Propose synonyms</button>
<div class="modal-actions"><button type="submit" class="primary">Search</button><button type="button" data-modal="cancelblocks">Cancel</button></div></form>`);
	}

	$("modal").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (event.target.id === "mailto-form") {
			state.modal.save = $("mailto-save").checked;
			await answer({ text: $("mailto-input").value.trim() });
		}
		if (event.target.id === "blocks-form") {
			const blocks = blockLines($("blocks-edit"));
			if (!blocks.length) return;
			const ok = await confirmBox("Start a new search?", "The list is replaced by a search with these keywords.", "Search");
			if (!ok) return;
			state.modal.blocks = false;
			closeWindow();
			await answer({ chip: "reblocks", blocks });
		}
	});
	$("modal").addEventListener("click", async (event) => {
		if (editBlocks(event)) return;
		const button = event.target.closest("[data-modal]");
		if (!button) return;
		const what = button.dataset.modal;
		if (what === "without") { await answer({ chip: "without" }); return; }
		if (what === "cancel") { await answer(state.dialog && state.dialog.step === "download" ? { chip: "change" } : { text: "back" }); return; }
		if (what === "download") {
			const typed = $("dl-folder-path");
			const folder = typed ? typed.value.trim() : state.modal.folder;
			if (!folder) return;
			await answer({ chip: "download", folder });
			return;
		}
		if (what === "choosefolder") {
			button.disabled = true;
			try {
				const picked = await post("/api/folders/pick", { purpose: "download", start: state.modal.folder || "" });
				if (picked.path) state.modal.folder = picked.path;
			} catch (error) {
				state.modal.canPick = false; // no system window here: type the path
				toast(error.message);
			}
			const question = state.dialog ? [...state.dialog.messages].reverse().find((message) => message.role === "assistant" && message.step === "download") : null;
			renderDownloadWindow(question);
			return;
		}
		if (what === "folder") { post("/api/reveal", button.dataset.path ? { path: button.dataset.path } : { stage: "lit-selection" }).then((r) => toast(`Opened ${r.opened} in the file manager.`)).catch((error) => toast(error.message)); return; }
		if (what === "close") { state.modal.dismissed = Number(button.dataset.id); closeWindow(); return; }
		if (what === "cancelblocks") { state.modal.blocks = false; closeWindow(); return; }
		if (what === "synonyms") {
			// The same proposal as the synonym switch in the "+" menu, fresh each click.
			const topic = state.dialog && state.dialog.answers ? state.dialog.answers.topic : "";
			if (!topic) return;
			button.disabled = true;
			try {
				const data = await post("/api/search/blocks", { request: topic, mode: "synonyms", fresh: true });
				if (data.blocks && data.blocks.length && $("blocks-edit")) $("blocks-edit").innerHTML = editorHtml({ editor: data.blocks });
			} catch (error) { toast(error.message); }
			button.disabled = false;
			return;
		}
	});
	// Esc closes the window like "Cancel" (the dialog step is left as it is;
	// the next render reopens it if the step still wants an answer).
	$("modal").addEventListener("cancel", (event) => {
		event.preventDefault();
		if (state.modal.blocks) { state.modal.blocks = false; closeWindow(); return; }
		const step = state.dialog ? state.dialog.step : "";
		if (step === "download") answer({ chip: "change" });
		else if (step === "mailto") answer({ text: "back" });
		else if (step !== "downloading") { const finished = [...(state.dialog ? state.dialog.messages : [])].reverse().find((message) => message.quiet && /Download finished/.test(message.text || "")); if (finished) state.modal.dismissed = finished.id; closeWindow(); }
	});

	/** A job: one line with its dot and the current progress line; a click
	 * opens the full log (the dark block). */
	function workingStatus(message) {
		const lines = state.lines.get(message.job) || [];
		if (message.jobState === "running") return lines.length ? `${lines[lines.length - 1].text} ...` : `${message.jobLabel} ...`;
		return `${message.jobState === "done" ? "Done" : message.jobState === "cancelled" ? "Stopped" : "Failed"}: ${message.jobLabel}`;
	}
	function workingHtml(message) {
		const lines = state.lines.get(message.job) || [];
		const running = message.jobState === "running";
		const open = state.workingOpen.has(message.job);
		return `<details class="working" data-job="${esc(message.job)}" ${open ? "open" : ""}><summary title="Show what is happening"><span class="dot ${running ? "busy" : message.jobState === "done" ? "" : "bad"}"></span><span class="wstatus">${esc(workingStatus(message))}</span>${running ? '<button type="button" class="stop-job" title="Stop the job (Esc)">Stop</button>' : ""}</summary><pre>${lines.slice(-200).map(lineHtml).join("") || '<span class="dim">waiting for the first progress line ...</span>'}</pre></details>`;
	}

	function messageHtml(message) {
		switch (message.role) {
			case "user":
				return `<div class="msg user" data-id="${message.id}"><div class="bubble">${esc(message.text)}</div></div>`;
			case "working":
				return workingHtml(message);
			case "card":
				return `<div class="msg card" data-id="${message.id}">${cardHtml(message)}</div>`;
			case "results":
				return `<div class="msg results" data-id="${message.id}" data-run="${esc(message.run)}">${resultsHtml(message.run)}</div>`;
			case "answer":
				return `<div class="msg assistant ${message.spent ? "spent" : ""}" data-id="${message.id}" data-step="${esc(message.step || "")}">${answerHtml(message.answer)}${onePdfChat() ? "" : chipsHtml(message)}</div>`;
			default:
				return `<div class="msg assistant ${message.spent ? "spent" : ""} ${message.help ? "help" : ""}" data-id="${message.id}" data-step="${esc(message.step || "")}" ${message.single ? 'data-single="1"' : ""}>${message.text ? `<p>${markup(message.text)}</p>` : ""}${editorHtml(message)}${message.note ? `<p class="note">${markup(message.note)}</p>` : ""}${listHtml(message)}${chipsHtml(message)}</div>`;
		}
	}

	/** The input box says what the open step expects. */
	function placeholderFor(step) {
		switch (step) {
			case "ask": case "finished": return onePdfChat() ? "Ask another question about this PDF ..." : "Ask a question about the PDFs ...";
			case "start": case "topic": return "Describe what you are looking for ...";
			case "blocks": return "Confirm or edit the blocks above, or type new lines ...";
			case "period": return "Pick a period, or type a range such as 2015-2024 ...";
			case "journals": return "Tick journals above, or type numbers, a name, or \"all\" ...";
			case "authors": return "Tick authors above, type numbers, a name, or \"all\" ...";
			case "pick": return "Tick papers in the list above, or type row numbers, DOIs, \"all\" or \"code\" ...";
			case "mailto": return "Your email address, or continue without Unpaywall ...";
			case "questions": return "Your questions, each ending with a question mark ...";
			case "confirm": return "Search, or type count 30 / cites 5 / code on / code off ...";
			default: return "Type your answer or question ...";
		}
	}

	/** The start screen: the opening question and two tiles, nothing else. */
	/** The start screen (design/2026-10-28_startseite_entwuerfe, variant F
	 * "two groups"): three lines slide in one after another, the fourth is
	 * typed letter by letter in two colours -- sage up to "you run,", rosé
	 * for "even small, local ones." -- and settles to ink. Played once per
	 * browser session; reduced-motion users and later visits see the
	 * settled state at once. The wording never changes with the setup. */
	const HERO_LINES = ["Search the literature.", "Select the papers.", "Summarize and synthesize."];
	const HERO_LAST = [["Streamlined for small local AI models", "g1"]];
	// The same mark as the favicon and the rail (index.html): a white bold
	// italic serif pi on a disc, placed by its measured ink bounds. It stands
	// from the first frame; only the lines and tiles animate.
	const HERO_MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="currentColor"/><text x="15.72" y="22" text-anchor="middle" font-family="Georgia,serif" font-weight="700" font-style="italic" font-size="22" fill="#fff">&pi;</text></svg>';
	function heroHtml() {
		const stroke = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
		let played = false;
		try { played = sessionStorage.getItem("plr-hero-played") === "1"; } catch { /* storage blocked: animate every time */ }
		const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const animate = !played && !reduce;
		const last = animate ? "" : HERO_LAST.map(([text, group]) => `<i class="${group}">${esc(text)}</i>`).join("");
		return `<div class="hero ${animate ? "animate" : "settled"}">
<div class="hero-mark">${HERO_MARK}</div>
<h1>${HERO_LINES.map((line, i) => `<span class="fly" style="animation-delay: ${0.2 + i * 0.75}s">${esc(line)}</span>`).join("")}<span class="typed" id="hero-typed">${last}</span></h1>
<div class="tiles">
<button type="button" class="tile" data-start="search" title="Search papers, tick the ones you want, download the open-access PDFs"><svg viewBox="0 0 24 24" ${stroke}><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v6M8.3 11.3l2.2 2.2 2.2-2.2"/></svg><span>search &amp; select</span></button>
<button type="button" class="tile" data-start="synthesis" title="Chat about one PDF, or write a report over several"><svg viewBox="0 0 24 24" ${stroke}><path d="M7 3h8l4 4v6"/><path d="M15 3v4h4M7 3v18h6"/><path d="M20.5 12.5l-6 6-2.5.6.6-2.5 6-6a1.3 1.3 0 0 1 1.9 1.9z"/></svg><span>summarize &amp; synthesize</span></button>
</div>
</div>`;
	}

	/** Type the fourth line (two colour groups) after the first three stand. */
	function heroAnimate() {
		const el = $("hero-typed");
		const hero = el && el.closest(".hero.animate");
		if (!hero || hero.dataset.started) return;
		hero.dataset.started = "1";
		try { sessionStorage.setItem("plr-hero-played", "1"); } catch { /* fine */ }
		const chars = [];
		for (const [text, group] of HERO_LAST) for (const ch of text) chars.push([ch, group]);
		let k = 0;
		const step = () => {
			if (!document.body.contains(el)) return; // the conversation moved on
			const [ch, group] = chars[k++];
			const i = document.createElement("i");
			i.textContent = ch;
			i.className = group;
			el.appendChild(i);
			if (k < chars.length) { setTimeout(step, 34); return; }
			el.classList.remove("caret");
			hero.querySelector(".tiles").classList.add("in");
			setTimeout(() => hero.classList.add("settled"), 1600);
		};
		// Start typing when the third line has finished sliding in (its
		// animationend event), never on a fixed clock: browsers start CSS
		// animations late on a busy first paint, and the fourth line must
		// not overtake the third. A long fallback covers a missing event.
		let started = false;
		const begin = () => { if (started) return; started = true; el.classList.add("caret"); step(); };
		const lines = hero.querySelectorAll("h1 span.fly");
		const third = lines[lines.length - 1];
		if (third) third.addEventListener("animationend", () => setTimeout(begin, 250), { once: true });
		setTimeout(begin, 6000);
	}

	function render() {
		const view = state.dialog;
		if (!view) return;
		const thread = $("thread");
		const first = view.messages[0];
		const alone = view.messages.length === 1 && !view.pending && !view.activeJob;
		// The start screen replaces the opening question; a conversation that
		// holds only its first stage question (the rail's "+ New ..." rows) is
		// laid out as an entry: question and input box together in the middle.
		const fresh = alone && view.step === "start" && Boolean(first.chips && first.chips.some((chip) => chip.id === "search"));
		const entry = alone && !fresh && first.role === "assistant";
		document.querySelector(".chat").classList.toggle("entry", entry);
		// The start screen offers the two tiles only; no input box.
		document.querySelector(".chat").classList.toggle("startscreen", fresh);
		// A fresh start screen is not rebuilt while it is already showing
		// (dialog frames arrive during the build-up; a rebuild would restart it).
		if (fresh && thread.querySelector(".hero")) { renderStages(view); return; }
		// Stage 1 after a search is a results page, not a chat: the newest list
		// stands alone (a running search above it); download, contact and
		// edited blocks run in a window over it; the input box is away. The
		// quiet messages of those steps never enter the thread.
		const lists = view.messages.filter((message) => message.role === "results");
		const resultsView = !fresh && lists.length > 0 && view.stage && view.stage.stage === 1;
		document.querySelector(".chat").classList.toggle("resultsview", resultsView);
		// The synonym button: the model's blocks open as a drop-down under
		// the request box (the request stays in the box), edited there, then
		// searched. Also while the model is still proposing them.
		const asking = view.pending === "asking the model for keyword blocks";
		const dropMode = !fresh && !lists.length && Boolean(view.answers && view.answers.synonyms)
			&& (view.step === "blocks" || (asking && (view.step === "start" || view.step === "topic")));
		state.dropMode = dropMode;
		document.querySelector(".chat").classList.toggle("entry", entry || dropMode);
		document.querySelector(".chat").classList.toggle("dropmode", dropMode);
		renderDrop(view, dropMode);
		let parts;
		if (fresh) parts = [heroHtml()];
		else if (dropMode) {
			const question = view.messages.find((message) => message.role === "assistant" && message.step === "topic");
			parts = [`<div class="msg assistant"><p>${markup(question ? question.text : "What are you looking for?")}</p></div>`];
		} else if (resultsView) {
			// Above the list: the request in full and the search's own log
			// (collapsed once done, its dot green), then a running search.
			const lastList = lists[lists.length - 1];
			const index = view.messages.indexOf(lastList);
			const before = view.messages.slice(0, index);
			// One working line only: a follow-up search (add code, search
			// again) takes the place of the line of the search before it.
			const after = view.messages.slice(index + 1);
			const working = (message) => message.role === "working" && !message.quiet;
			const log = [...after].reverse().find(working) || [...before].reverse().find(working);
			const request = view.answers && view.answers.topic ? `<div class="msg user request"><div class="bubble">${esc(view.answers.topic)}</div></div>` : "";
			parts = [request, log ? messageHtml(log) : "", messageHtml(lastList)];
		} else {
			// The opening and request questions leave the thread once answered
			// (a user message follows them).
			const answered = (message, index) => (message.step === "topic" || message.step === "start") && message.role === "assistant" && view.messages.slice(index + 1).some((later) => later.role === "user");
			parts = view.messages.filter((message, index) => !message.quiet && !answered(message, index)).map(messageHtml);
		}
		if (view.pending && !dropMode) parts[resultsView ? "unshift" : "push"](`<div class="msg pending"><span class="dot busy"></span>${esc(view.pending)} ...</div>`);
		const keepTop = thread.scrollTop;
		thread.innerHTML = parts.join("");
		if (fresh) heroAnimate();
		mountResults();
		renderModal(view, resultsView);
		// A fresh answer while a PDF is open on the right: the PDF jumps to
		// the first cited passage, marked (a click on any [n] shows another).
		const answers = view.messages.filter((message) => message.role === "answer" && message.answer);
		const newest = answers[answers.length - 1];
		if (newest && state.autoCited !== newest.id) {
			const first = (newest.answer.hrefs || []).find(Boolean);
			const fresh = state.autoCited !== undefined; // answers present at page load are not replayed
			state.autoCited = newest.id;
			if (fresh && first && state.report && /^\/pdf\//.test(state.report.url || "") && !state.panelClosedByUser) showPdf(first);
		} else if (!newest && state.autoCited === undefined) state.autoCited = null;
		// Every dialog change follows an answer or finishes a wait: show it.
		// A results page keeps the reader's place; only a new list starts at its top.
		if (resultsView) {
			const run = lists[lists.length - 1].run;
			if (state.shownList !== run) { state.shownList = run; thread.scrollTop = 0; }
			else thread.scrollTop = keepTop;
		} else {
			state.shownList = null;
			thread.scrollTop = thread.scrollHeight;
		}
		renderStages(view);
		const busy = Boolean(view.activeJob) || Boolean(view.pending);
		$("input").disabled = busy;
		$("btn-send").disabled = busy;
		// The request box of a search says "Search" and carries the code,
		// synonym and period buttons.
		const request = (view.step === "start" && !fresh) || view.step === "topic" || dropMode;
		$("btn-send").textContent = request ? "Search" : "Send";
		// The paper chat's box carries its own "+": sources and reports.
		// A chat on one PDF stays a plain box.
		const chatMenu = !request && (view.step === "ask" || view.step === "finished") && !onePdfChat(view);
		if (chatMenu !== Boolean(state.chatMenu)) { setMenu(false); state.chatMenu = chatMenu; }
		$("plus-anchor").hidden = !request && !chatMenu;
		$("pills").hidden = !request && !chatMenu;
		$("btn-plus").disabled = busy;
		$("btn-plus").title = chatMenu ? "Sources and report" : "Search options";
		$("btn-plus").setAttribute("aria-label", $("btn-plus").title);
		if (!request && (setCount(state.options) || state.options.period !== "10y")) {
			state.options = freshOptions();
			if (!chatMenu) renderOptions(false);
		}
		if (chatMenu && state.chatKey !== view.chatSession) {
			state.chatKey = view.chatSession;
			state.chat = chatFromAnswers(view.answers);
			loadChatLib();
		}
		// "Edit search" after a stopped search: the request goes back into
		// the box and the "+" options are rebuilt from the answers, once.
		if (entry && first.prefill && state.prefilled !== first.id) {
			state.prefilled = first.id;
			$("input").value = first.prefill;
			state.options = optionsFromAnswers(view.answers || {}, first.prefill);
			renderOptions(false);
		}
		// One plain input box. On chip-only steps typed text is a question for
		// the helper (the server routes it); the placeholder says so.
		$("input").placeholder = view.activeJob ? "Please wait, or stop the job ..." : view.pending ? "One moment ..." : view.accepts === "choice" ? "Pick an answer above, or ask a question ..." : placeholderFor(view.step);
		if (entry && !dropMode) entryTyping(view.step, first.id); else stopEntryTyping();
		if (chatMenu) renderOptions(false);
		if (!busy && !resultsView) $("input").focus();
		// A fresh file card opens the panel (unless the user closed it for this card already).
		const cards = view.messages.filter((message) => message.role === "card" && message.card.url);
		const latest = cards[cards.length - 1];
		if (latest && latest.card.url !== state.report.url) {
			state.panelClosedByUser = false;
			showReport(latest.card.url, latest.card.name);
			setPopup(true); // a fresh report opens large first; Esc or the shrink icon puts it beside the chat
		}
	}

	/* ---------------- entry layout: typed example requests ---------------- */

	// Example inputs typed letter by letter into the (grey) placeholder of
	// the input box while a conversation shows only its first question.
	const ENTRY_EXAMPLES = {
		topic: [
			"I want to search articles about flood mapping using satellite imagery",
			"River water level estimation from Sentinel-1 altimetry, papers with code",
			"Glacier surface velocity from Sentinel-2 feature tracking since 2018",
		],
		ask: [
			"Which methods do these papers use to estimate water levels?",
			"What accuracy do the studies report, and against which reference data?",
		],
		// A chat on one PDF of the library.
		ask1: [
			"Which method does it use, and on which data?",
			"What are the main results and their limitations?",
		],
	};
	let entryTimer = null;
	let entryKey = "";
	let entryDismissed = ""; // the question whose examples the user waved off
	function stopEntryTyping() {
		if (entryTimer) clearTimeout(entryTimer);
		entryTimer = null;
		entryKey = "";
	}
	/** A click or a key in the box ends the examples for this question: the
	 * placeholder stays empty. (Bound to pointer and keys, not to focus: the
	 * page focuses the box itself after every step.) */
	function dismissEntryTyping() {
		if (!entryKey) return;
		entryDismissed = entryKey;
		stopEntryTyping();
		$("input").placeholder = "";
	}
	/** Type the examples of this step in a loop; a running loop for the same
	 * question is left alone (dialog frames re-render the page). While the
	 * user types, the placeholder is hidden anyway, so the loop just waits. */
	function entryTyping(step, messageId) {
		const single = step === "ask" && onePdfChat();
		const examples = ENTRY_EXAMPLES[single ? "ask1" : step];
		const key = `${step}:${messageId}`;
		if (!examples) { stopEntryTyping(); return; }
		if (entryKey === key) return;
		stopEntryTyping();
		const input = $("input");
		if (entryDismissed === key) { input.placeholder = ""; return; }
		entryKey = key;
		if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) { input.placeholder = examples[0]; return; }
		let which = 0;
		let pos = 0;
		const tick = () => {
			const text = examples[which];
			if (input.value) { entryTimer = setTimeout(tick, 600); return; }
			pos += 1;
			input.placeholder = text.slice(0, pos);
			if (pos < text.length) { entryTimer = setTimeout(tick, 38); return; }
			which = (which + 1) % examples.length;
			pos = 0;
			entryTimer = setTimeout(tick, 3400);
		};
		input.placeholder = "";
		entryTimer = setTimeout(tick, 450);
	}

	// Opening or closing a job's log is remembered per job ("toggle" does not bubble).
	document.addEventListener("toggle", (event) => {
		const node = event.target;
		if (!(node instanceof HTMLDetailsElement) || !node.classList.contains("working")) return;
		if (node.open) state.workingOpen.add(node.dataset.job); else state.workingOpen.delete(node.dataset.job);
	}, true);

	/** Update only the progress lines of a working bubble (cheap, frequent). */
	function renderWorking(jobId) {
		const details = document.querySelector(`.working[data-job="${CSS.escape(jobId)}"] pre`);
		if (!details) return;
		const lines = state.lines.get(jobId) || [];
		const message = state.dialog && state.dialog.messages.find((item) => item.role === "working" && item.job === jobId);
		document.querySelectorAll(`.working[data-job="${CSS.escape(jobId)}"] .wstatus`).forEach((node) => { if (message) node.textContent = workingStatus(message); });
		details.innerHTML = lines.slice(-200).map(lineHtml).join("");
		details.scrollTop = details.scrollHeight;
		// A chat follows its newest line; the results page stays where the
		// reader is (its working line sits above the list).
		if (!document.querySelector(".chat").classList.contains("resultsview")) {
			const thread = $("thread");
			thread.scrollTop = thread.scrollHeight;
		}
	}

	/** The rail shows no progress text; the block of a stage opens by itself
	 * once the conversation is inside that stage (never at the start). */
	function renderStages(view) {
		if (view.step === "start") return;
		const current = view.stage ? view.stage.stage : 1;
		if (state.lastStage !== current) { state.lastStage = current; $(`block-${current}`).open = true; }
	}

	/* ---------------- answering ---------------- */
	function tickedInReport() {
		try {
			const doc = $("frame").contentDocument;
			if (!doc || !state.report.url || !/\/files\/lit-search\//.test(state.report.url)) return [];
			return Array.from(doc.querySelectorAll("input.pick:checked")).map((box) => box.dataset.id).filter(Boolean);
		} catch {
			return [];
		}
	}

	function currentQuestion() {
		const nodes = Array.from(document.querySelectorAll(".msg.assistant[data-step]:not(.spent)"));
		return nodes[nodes.length - 1] || null;
	}

	function collect(node) {
		const body = {};
		if (!node) return body;
		const toggles = [
			...Array.from(node.querySelectorAll(".chips .toggle.on")).map((b) => b.dataset.chip),
			...Array.from(node.querySelectorAll(".list input:checked")).map((input) => input.dataset.id),
		];
		if (toggles.length) body.toggles = toggles;
		const blocks = blockLines(node);
		if (blocks.length) body.blocks = blocks;
		if (node.dataset.step === "pick") { const ticked = tickedInResults(); body.ids = ticked.length ? ticked : tickedInReport(); }
		return body;
	}

	async function answer(body) {
		// Under the synonym drop-down the "+" menu still counts.
		if (state.dropMode) body = { ...optionsPayload(), ...body };
		try {
			// Every change is also pushed over the event stream. A push that
			// arrived while this request ran is at least as new as its reply
			// (an instant answer, e.g. saved keyword blocks, overtakes it).
			const pushes = state.pushes || 0;
			const reply = await post("/api/dialog/answer", body);
			if ((state.pushes || 0) === pushes) state.dialog = reply;
			render();
		} catch (error) {
			if (error.status === 409) toast("This conversation is still working. Wait for it, press Stop (or Esc), or start a new search beside it.");
			else toast(error.message);
		}
	}

	/* ---------------- the "+" menu of the request box ---------------- */
	// The choices the terminal wizard offers, made before the search: kept
	// on the page until Search; pills under the box show what is set.
	const PER_SOURCE_DEFAULT = 30;
	const PER_SOURCE_MAX = 50;
	const freshFacet = () => ({ rows: null, on: new Set(), key: null, loading: false, open: false, error: "" });
	const freshOptions = () => ({ syn: { lines: null, key: null, loading: false, error: "", open: true }, synonyms: false, code: false, period: "10y", perSource: PER_SOURCE_DEFAULT, minCites: null, journals: freshFacet(), authors: { ...freshFacet(), matches: [], picked: new Map(), lookup: "", scope: "query" } });
	state.options = freshOptions();
	const OPTION_ICON = {
		synonyms: '<path d="M4 9.5c2.7-2.6 5.3-2.6 8 0s5.3 2.6 8 0M4 15.5c2.7-2.6 5.3-2.6 8 0s5.3 2.6 8 0"/>',
		code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16"/>',
		snowball: '<circle cx="12" cy="12" r="8"/><path d="M8 9.5a4.5 4.5 0 0 1 4-2.5M7.5 13.5a2 2 0 0 0 1.5 1.5"/>',
		period: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
		perSource: '<path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16"/>',
		minCites: '<path d="M7 7h4v4c0 3-1.5 5-4 6M15 7h4v4c0 3-1.5 5-4 6"/>',
		journals: '<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h11"/>',
		authors: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 3.8-6 7-6s6 2 7 6"/>',
	};
	const optionIcon = (key) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${OPTION_ICON[key]}</svg>`;
	const PERIOD_TEXT = { "5y": "last 5 years", "10y": "last 10 years", "20y": "last 20 years", all: "all years" };

	function periodYearFrom(preset) {
		const years = { "5y": 5, "10y": 10, "20y": 20 }[preset];
		return years ? new Date().getFullYear() - (years - 1) : undefined;
	}
	function setCount(o) {
		return [o.synonyms, o.code, o.perSource !== PER_SOURCE_DEFAULT, o.minCites !== null, o.journals.on.size > 0, authorCount(o) > 0].filter(Boolean).length;
	}
	/** Ticked authors: found by name plus ticked in the list. */
	function authorCount(o) {
		return pickedAuthors(o).length;
	}
	/** The ticked authors as OpenAlex matches (id + name), name finds first. */
	function pickedAuthors(o) {
		const rows = (o.authors.rows || []).filter((row) => o.authors.on.has(row.id) && !o.authors.picked.has(row.id));
		return [...o.authors.picked.values(), ...rows.map((row) => ({ id: row.id, name: row.name, hint: "", works: row.works }))];
	}
	/** The "+" options as the last search used them (dialog answers). */
	function optionsFromAnswers(a, text) {
		const o = freshOptions();
		if (a.period && PERIOD_TEXT[a.period.preset]) o.period = a.period.preset;
		o.code = Array.isArray(a.codeSources) && a.codeSources.length > 0;
		o.synonyms = Boolean(a.synonyms);
		if (o.synonyms && Array.isArray(a.blocks) && a.blocks.length) Object.assign(o.syn, { lines: a.blocks.slice(), key: text });
		if (typeof a.perSource === "number") o.perSource = a.perSource;
		if (typeof a.minCites === "number" && a.minCites > 0) o.minCites = a.minCites;
		if (Array.isArray(a.journalsOn) && a.journalsOn.length && Array.isArray(a.journals)) {
			Object.assign(o.journals, { rows: a.journals, on: new Set(a.journalsOn), key: `${text}\n${o.period}` });
		}
		for (const author of a.pickedAuthors || []) o.authors.picked.set(author.id, author);
		if (a.authorScope === "all") o.authors.scope = "all";
		return o;
	}
	function menuOpen() { return !$("plus-menu").hidden; }
	function setMenu(show) {
		$("plus-menu").hidden = !show;
		$("btn-plus").setAttribute("aria-expanded", show ? "true" : "false");
		if (show) $("plus-menu").innerHTML = state.chatMenu ? chatMenuHtml() : menuHtml();
	}
	/** Pills and the badge; the menu itself only when asked (a rebuild
	 * while typing in it would drop the focus). */
	function renderOptions(withMenu) {
		if (state.chatMenu) {
			if (withMenu && menuOpen()) {
				// Keep the paper list's scroll position across a rebuild.
				const list = $("plus-menu").querySelector("#chat-papers, .sub.tree");
				const top = list ? list.scrollTop : 0;
				const menuTop = $("plus-menu").scrollTop;
				$("plus-menu").innerHTML = chatMenuHtml();
				$("plus-menu").scrollTop = menuTop;
				const again = $("plus-menu").querySelector("#chat-papers, .sub.tree");
				if (again) again.scrollTop = top;
			}
			$("pills").innerHTML = chatPillsHtml();
			$("plus-badge").textContent = chatBadge() || "";
			chatSendLabel();
			return;
		}
		const o = state.options;
		if (withMenu && menuOpen()) $("plus-menu").innerHTML = menuHtml();
		$("pills").innerHTML = pillsHtml();
		$("plus-badge").textContent = setCount(o) || "";
		if (menuOpen()) {
			for (const kind of ["journals", "authors"]) {
				const value = $("plus-menu").querySelector(`[data-row="${kind}"] .val`);
				if (value) value.textContent = facetValue(kind);
			}
		}
	}
	function facetValue(kind) {
		const facet = state.options[kind];
		const size = kind === "authors" ? authorCount(state.options) : facet.on.size;
		return size ? `${size} chosen` : "all";
	}
	function facetHtml(kind) {
		const facet = state.options[kind];
		if (!facet.open) return "";
		let body;
		if (facet.loading) body = `<div class="wait"><span class="dot busy"></span>${kind === "journals" ? "Journals" : "Authors"} for your keywords ...</div>`;
		else if (facet.error) body = `<div class="wait bad">${esc(facet.error)}</div>`;
		else body = (facet.rows || []).map((row) => `<label><input type="checkbox" data-pick="${kind}" value="${esc(row.id)}" ${facet.on.has(row.id) ? "checked" : ""}><span>${esc(row.name)}</span><small>${row.works} paper${row.works === 1 ? "" : "s"}</small></label>`).join("");
		if (kind === "authors") {
			const o = state.options.authors;
			// One scope for every ticked author (found by name or in the
			// list); it shows as soon as one is ticked, above the lists.
			const scope = authorCount(state.options) ? `<div class="seg scope">${[["query", "on this topic"], ["all", "all their work"]].map(([id, label]) => `<button type="button" data-scope="${id}" class="${o.scope === id ? "on" : ""}">${label}</button>`).join("")}</div>` : "";
			body = `${scope}<input type="text" class="lookup" id="author-lookup" placeholder="Find an author by name ..." autocomplete="off" value="${esc(o.lookup)}"><div id="author-matches">${matchesHtml()}</div>${body}`;
		}
		return `<div class="sub">${body}</div>`;
	}
	function matchesHtml() {
		const o = state.options.authors;
		// Ticked name finds stay listed (untick to drop them), new finds below.
		const shown = [...o.picked.values(), ...o.matches.filter((match) => !o.picked.has(match.id))];
		return shown.map((match) => `<label><input type="checkbox" data-match="${esc(match.id)}" ${o.picked.has(match.id) ? "checked" : ""}><span>${esc(match.name)}</span><small>${esc(match.hint || "")}</small></label>`).join("");
	}
	function menuHtml() {
		const o = state.options;
		const text = $("input").value.trim().length > 0;
		const row = (key, name, control, title, extra = "", attrs = "") => `<div class="row ${extra}" data-row="${key}" title="${esc(title)}" ${attrs}>${optionIcon(key)}<span class="name">${name}</span>${control}</div>`;
		// A switch row flips on a click anywhere in the row.
		const toggleRow = (key, name, title) => row(key, name, `<span class="switch ${o[key] ? "on" : ""}" role="switch" aria-checked="${o[key]}" aria-label="${name}"></span>`, title, "click", `data-toggle="${key}"`);
		// The synonym row: only its switch switches; once on, a click on the
		// row folds the blocks under it open or shut.
		const synRow = () => {
			const shown = o.synonyms && text;
			const fold = shown ? `<span class="more" aria-hidden="true">${o.syn.open ? "▾" : "›"}</span>` : "";
			return row("synonyms", "Add synonyms", `<span class="switch ${o.synonyms ? "on" : ""}" role="switch" aria-checked="${o.synonyms}" aria-label="Add synonyms" data-toggle="synonyms"></span>${fold}`,
				"The model adds one synonym per keyword block; check and edit the blocks here", shown ? "click" : "", shown ? `data-synfold="1" role="button" aria-expanded="${o.syn.open}"` : "");
		};
		// A list row opens on a click anywhere in the row.
		const facetRow = (key, name, title) => text
			? `${row(key, name, `<span class="val">${esc(facetValue(key))}</span><span class="more" aria-hidden="true">${o[key].open ? "▾" : "›"}</span>`, title, "click", `data-open="${key}" role="button" aria-expanded="${o[key].open}"`)}${facetHtml(key)}`
			: row(key, name, '<span class="val">all</span>', "Type your request first: the list comes from its keywords", "off");
		return [
			synRow(),
			o.synonyms && text && o.syn.open ? synonymsHtml() : "",
			toggleRow("code", "Papers with code", "Also search Hugging Face Papers, GitHub README search, awesome lists, Google Earth Engine repositories (about 20-40 s more)"),
			row("snowball", "Snowball search", '<span class="soon">soon</span>', "Follow the references and citations of the hits (coming later)", "off"),
			'<div class="sep"></div>',
			row("period", "Published", `<span class="seg">${["5y", "10y", "20y", "all"].map((p) => `<button type="button" data-period="${p}" class="${o.period === p ? "on" : ""}">${p === "all" ? "all" : p.replace("y", " y")}</button>`).join("")}</span>`, "Publication years searched"),
			row("perSource", "Per source", `<span class="stepper"><button type="button" data-step="-10" aria-label="Fewer">-</button><input type="text" inputmode="numeric" data-num="perSource" value="${o.perSource}" aria-label="Papers per source"><button type="button" data-step="10" aria-label="More">+</button></span>`, "Papers asked from each source"),
			row("minCites", "Min. citations", `<span class="stepper"><input type="text" inputmode="numeric" data-num="minCites" value="${o.minCites ?? ""}" placeholder="any" aria-label="Minimum citations"></span>`, "Leave out papers cited fewer times than this; empty = no limit"),
			'<div class="sep"></div>',
			facetRow("journals", "Journals", "Only papers from the ticked journals"),
			facetRow("authors", "Authors", "Only papers by the ticked authors"),
		].join("");
	}
	/** The synonym blocks under their switch: one row per block, one box
	 * per term (the same editor as the drop-down), a new proposal on click. */
	function synonymsHtml() {
		const syn = state.options.syn;
		const again = (label) => `<button type="button" class="ibtn regen" data-act="regen" title="Ask the model for new synonyms">${ICON_RELOAD}${label}</button>`;
		if (syn.loading) return '<div class="sub syn"><div class="wait"><span class="dot busy"></span>Synonyms for your keywords ...</div></div>';
		if (syn.error) return `<div class="sub syn"><div class="wait bad">${esc(syn.error)}</div>${again("Propose again")}</div>`;
		if (!syn.lines || syn.key !== $("input").value.trim()) return `<div class="sub syn">${again("Propose synonyms")}</div>`;
		return `<div class="sub syn">${editorHtml({ editor: syn.lines })}${again("Propose again")}</div>`;
	}
	async function loadSynonyms(fresh) {
		const syn = state.options.syn;
		const text = $("input").value.trim();
		if (!text || (!fresh && syn.key === text && (syn.lines || syn.loading))) return;
		Object.assign(syn, { key: text, lines: null, loading: true, error: "" });
		renderOptions(true);
		try {
			const data = await post("/api/search/blocks", { request: text, mode: "synonyms", ...(fresh ? { fresh: true } : {}) });
			if (syn.key === text) syn.lines = data.blocks;
		} catch (error) {
			if (syn.key === text) syn.error = error.message;
		} finally {
			if (syn.key === text) { syn.loading = false; renderOptions(true); }
		}
	}
	/** Edits in the menu's block editor are kept in the options (a menu
	 * rebuild redraws them from there). */
	function syncSynonyms() {
		const box = $("plus-menu").querySelector(".sub.syn .blocks");
		if (box) state.options.syn.lines = blockLines(box.parentElement);
	}

	function pillsHtml() {
		const o = state.options;
		const pills = [`<span class="pill fixed" data-go="period">${optionIcon("period")}${PERIOD_TEXT[o.period]}</span>`];
		const add = (key, label) => pills.push(`<span class="pill" data-go="${key}">${optionIcon(key)}${esc(label)}<button type="button" class="x" data-clear="${key}" aria-label="Remove">×</button></span>`);
		if (o.synonyms) add("synonyms", "Synonyms");
		if (o.code) add("code", "Code");
		if (o.perSource !== PER_SOURCE_DEFAULT) add("perSource", `${o.perSource} per source`);
		if (o.minCites !== null) add("minCites", `≥ ${o.minCites} citations`);
		if (o.journals.on.size) add("journals", `Journals: ${o.journals.on.size}`);
		const authors = pickedAuthors(o);
		if (authors.length) add("authors", `${authors.length === 1 ? authors[0].name : `Authors: ${authors.length}`}${o.authors.scope === "all" ? " (all their work)" : ""}`);
		return pills.join("");
	}
	/** What the menu adds to the request answer. */
	function optionsPayload() {
		const o = state.options;
		const facet = (f) => (f.rows && f.on.size ? { rows: f.rows, on: [...f.on] } : undefined);
		const options = {
			perSource: o.perSource,
			minCites: o.minCites,
			...(facet(o.journals) ? { journals: facet(o.journals) } : {}),
			...(authorCount(o) ? { pickedAuthors: pickedAuthors(o), authorScope: o.authors.scope } : {}),
		};
		const lines = o.synonyms && o.syn.lines && o.syn.key === $("input").value.trim() ? o.syn.lines.filter(Boolean) : [];
		return { code: o.code, synonyms: o.synonyms, period: o.period, options, ...(lines.length ? { blocks: lines } : {}) };
	}
	/** Journal / author list for the request in the box: its keyword blocks
	 * (saved per request text, the search uses the same), then the OpenAlex
	 * counts within the chosen period. */
	async function loadFacet(kind) {
		const facet = state.options[kind];
		const text = $("input").value.trim();
		const key = `${text}\n${state.options.period}`;
		if (!text || (facet.key === key && (facet.rows || facet.loading))) return;
		Object.assign(facet, { key, rows: null, loading: true, error: "" });
		facet.on.clear();
		renderOptions(true);
		try {
			const blocks = await post("/api/search/blocks", { request: text });
			const yearFrom = periodYearFrom(state.options.period);
			const data = await post(`/api/search/${kind}`, { query: blocks.query, ...(yearFrom ? { yearFrom } : {}) });
			if (facet.key !== key) return;
			facet.rows = kind === "journals" ? data.journals : data.authors;
		} catch (error) {
			if (facet.key === key) facet.error = error.message;
		} finally {
			if (facet.key === key) { facet.loading = false; renderOptions(true); }
		}
	}
	/** A new request text or period makes the lists stale. */
	function staleFacets() {
		for (const kind of ["journals", "authors"]) {
			const facet = state.options[kind];
			if (!facet.key) continue;
			Object.assign(facet, { key: null, rows: null, error: "" });
			facet.on.clear();
			if (facet.open && menuOpen()) loadFacet(kind);
		}
	}

	$("btn-plus").addEventListener("click", (event) => {
		event.stopPropagation();
		setMenu(!menuOpen());
		if (state.chatMenu) return;
		for (const kind of ["journals", "authors"]) if (menuOpen() && state.options[kind].open) loadFacet(kind);
		if (menuOpen() && state.options.synonyms) loadSynonyms(false);
	});
	$("plus-menu").addEventListener("click", (event) => {
		event.stopPropagation();
		if (state.chatMenu) { chatMenuClick(event); return; }
		const o = state.options;
		if (editBlocks(event)) { syncSynonyms(); return; }
		if (event.target.closest('[data-act="regen"]')) { loadSynonyms(true); return; }
		const target = event.target.closest("[data-toggle],[data-period],[data-step],[data-open],[data-scope],[data-synfold]");
		if (!target) return;
		if (target.dataset.synfold) { syncSynonyms(); o.syn.open = !o.syn.open; }
		if (target.dataset.toggle) {
			o[target.dataset.toggle] = !o[target.dataset.toggle];
			if (target.dataset.toggle === "synonyms") {
				o.syn.open = o.synonyms;
				if (o.synonyms) loadSynonyms(false);
			}
		}
		if (target.dataset.period && o.period !== target.dataset.period) { o.period = target.dataset.period; staleFacets(); }
		if (target.dataset.step) o.perSource = Math.min(PER_SOURCE_MAX, Math.max(10, o.perSource + Number(target.dataset.step)));
		if (target.dataset.scope) o.authors.scope = target.dataset.scope;
		if (target.dataset.open) {
			const facet = o[target.dataset.open];
			facet.open = !facet.open;
			if (facet.open) loadFacet(target.dataset.open);
		}
		renderOptions(true);
	});
	$("plus-menu").addEventListener("change", (event) => {
		if (state.chatMenu) { chatMenuChange(event); return; }
		const o = state.options;
		const pick = event.target.closest("[data-pick]");
		if (pick) {
			const set = o[pick.dataset.pick].on;
			if (pick.checked) set.add(pick.value); else set.delete(pick.value);
			// The author scope appears or goes with the first / last tick.
			renderOptions(pick.dataset.pick === "authors");
			return;
		}
		const match = event.target.closest("[data-match]");
		if (match) {
			const id = match.dataset.match;
			if (!match.checked) o.authors.picked.delete(id);
			else {
				const found = o.authors.matches.find((entry) => entry.id === id);
				if (found) o.authors.picked.set(id, found);
			}
			renderOptions(true);
			return;
		}
		const num = event.target.closest("[data-num]");
		if (num) {
			const value = num.value.trim();
			if (num.dataset.num === "minCites") o.minCites = value === "" || !/^\d+$/.test(value) || Number(value) === 0 ? null : Number(value);
			else o.perSource = /^\d+$/.test(value) ? Math.min(PER_SOURCE_MAX, Math.max(1, Number(value))) : PER_SOURCE_DEFAULT;
			renderOptions(true);
		}
	});
	let lookupTimer = null;
	$("plus-menu").addEventListener("input", (event) => {
		if (state.chatMenu) {
			if (event.target.id !== "chat-find") return;
			state.chat.find = event.target.value;
			const box = document.getElementById("chat-papers");
			if (box) box.innerHTML = chatPapersHtml();
			return;
		}
		if (event.target.closest(".sub.syn")) { syncSynonyms(); return; }
		if (event.target.id !== "author-lookup") return;
		clearTimeout(lookupTimer);
		const prefix = event.target.value.trim();
		state.options.authors.lookup = event.target.value;
		lookupTimer = setTimeout(async () => {
			if (prefix.length < 3) { state.options.authors.matches = []; }
			else {
				try { state.options.authors.matches = (await post("/api/search/author-lookup", { q: prefix })).matches || []; } catch { state.options.authors.matches = []; }
			}
			const box = document.getElementById("author-matches");
			if (box) box.innerHTML = matchesHtml();
		}, 300);
	});
	// Enter inside the menu never sends the request (the menu sits in the form).
	$("plus-menu").addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		if (event.target.matches("[data-num]")) event.target.dispatchEvent(new Event("change", { bubbles: true }));
	});
	$("pills").addEventListener("click", (event) => {
		const o = state.options;
		const clear = event.target.closest("[data-clear]");
		if (state.chatMenu) {
			if (clear) {
				if (clear.dataset.clear === "scope") Object.assign(state.chat, { mode: "library", open: "", label: "" });
				if (clear.dataset.clear === "report") state.chat.report = false;
				renderOptions(true);
				return;
			}
			if (event.target.closest("[data-go]")) { event.stopPropagation(); setMenu(true); }
			return;
		}
		if (clear) {
			const key = clear.dataset.clear;
			if (key === "synonyms" || key === "code") o[key] = false;
			else if (key === "perSource") o.perSource = PER_SOURCE_DEFAULT;
			else if (key === "minCites") o.minCites = null;
			else if (key === "journals") o.journals.on.clear();
			else if (key === "authors") { o.authors.on.clear(); o.authors.picked.clear(); }
			renderOptions(true);
			return;
		}
		if (event.target.closest("[data-go]")) { event.stopPropagation(); setMenu(true); }
	});
	$("input").addEventListener("input", () => { if (!state.dropMode) staleFacets(); });
	document.addEventListener("click", (event) => { if (menuOpen() && !event.target.closest(".plusanchor")) setMenu(false); });
	document.addEventListener("keydown", (event) => { if (event.key === "Escape" && menuOpen()) setMenu(false); });
	renderOptions(false);

	/* ---------------- the "+" menu of the paper chat ---------------- */
	// Which PDFs the question or report covers (whole library, folders,
	// papers, an upload) and whether Send writes a report instead of
	// answering in the chat. One pill under the box names the sources.
	const freshChat = () => ({ mode: "library", folders: new Set(), papers: new Set(), open: "", find: "", report: false, kind: "perPaper", label: "" });
	state.chat = freshChat();
	const CHAT_ICON = {
		library: '<path d="M4 4.5h3.5v15H4zM9.5 4.5H13v15H9.5zM15 5.2l3.3-.9 3.2 14.5-3.3.9z"/>',
		folders: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
		papers: '<path d="M6 2.8h8l4 4v14.4H6z"/><path d="M14 2.8v4h4M8.5 12h7M8.5 15.5h7"/>',
		upload: '<path d="M12 16V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
		report: '<path d="M6 2.8h8l4 4v14.4H6z"/><path d="M14 2.8v4h4M9 17v-3M12 17v-6M15 17v-4"/>',
	};
	const chatIcon = (key) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${CHAT_ICON[key]}</svg>`;
	const REPORT_KIND_TEXT = { bullets: "Summaries", perPaper: "Per paper", crossPaper: "Cross-paper", review: "Review" };
	const REPORT_KIND_TITLE = {
		bullets: "Bullet summaries of every paper; no question needed",
		perPaper: "Summary plus answers to your questions, paper by paper",
		crossPaper: "Answers to your questions across all papers; needs a question",
		review: "Per-paper answers plus a review synthesis over all papers",
	};
	const isInside = (path, parent) => path.startsWith(parent + "/") || path.startsWith(parent + "\\");
	function chatLib() {
		return state.lib && Array.isArray(state.lib.papers) ? state.lib : { papers: [], dirs: [], store: "" };
	}
	async function loadChatLib() {
		try { state.lib = await get("/api/library"); } catch { /* the pill shows what is known */ }
		if (state.chatMenu) renderOptions(true);
	}
	/** Every folder of the library, depth-first, with its depth. */
	function folderNodes() {
		const lib = chatLib();
		const { tree, nameOf, order } = libraryTree(lib.papers, lib.dirs || [], lib.store || "");
		const out = [];
		const walk = (node, name, depth) => {
			out.push({ node, name, depth });
			for (const [part, child] of [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) walk(child, part, depth + 1);
		};
		for (const dir of order) walk(tree.get(dir), nameOf(dir), 0);
		return out;
	}
	function paperShort(base) {
		const paper = chatLib().papers.find((entry) => entry.base === base);
		if (!paper) return base;
		const lead = [authorsShort(paper.authors), paper.year].filter(Boolean).join(" ");
		return lead || paper.title || base;
	}
	/** The sources as the dialog takes them, with the pill's name. An empty
	 * folder or paper pick counts as the whole library. */
	function chatScope() {
		const c = state.chat;
		if (c.mode === "folders" && c.folders.size) {
			const nodes = folderNodes().filter((entry) => c.folders.has(entry.node.path));
			const bases = [...new Set(nodes.flatMap((entry) => papersUnder(entry.node).map((paper) => paper.base)))];
			if (bases.length) {
				const top = nodes.filter((entry) => !nodes.some((other) => other !== entry && isInside(entry.node.path, other.node.path)));
				return { scope: bases, label: c.label || (top.length === 1 ? top[0].name : `${top.length} folders`), count: bases.length };
			}
		}
		if (c.mode === "papers" && c.papers.size) {
			const bases = [...c.papers];
			return { scope: bases, label: c.label || (bases.length === 1 ? paperShort(bases[0]) : `${bases.length} papers`), count: bases.length };
		}
		return { scope: "library", label: "", count: chatLib().papers.length };
	}
	/** The menu as the conversation last used it (reopened from History). */
	function chatFromAnswers(answers) {
		const c = freshChat();
		if (answers && Array.isArray(answers.scope) && answers.scope.length) {
			c.mode = "papers";
			c.papers = new Set(answers.scope);
			c.label = answers.scopeLabel || "";
		}
		return c;
	}
	function chatPayload() {
		const { scope, label } = chatScope();
		const c = state.chat;
		return { chat: { scope, ...(label ? { scopeLabel: label } : {}), ...(c.report ? { report: c.kind } : {}) } };
	}
	const pdfCount = (n) => `${n} PDF${n === 1 ? "" : "s"}`;
	function chatPillsHtml() {
		const c = state.chat;
		const { label, count } = chatScope();
		const pills = [label
			? `<span class="pill" data-go="scope" title="${esc(label)}">${chatIcon(c.mode === "folders" ? "folders" : "papers")}${esc(label)} · ${pdfCount(count)}<button type="button" class="x" data-clear="scope" aria-label="Whole library">×</button></span>`
			: `<span class="pill fixed" data-go="scope" title="Whole library">${chatIcon("library")}${pdfCount(count)}</span>`];
		if (c.report) pills.push(`<span class="pill" data-go="report">${chatIcon("report")}Report: ${REPORT_KIND_TEXT[c.kind]}<button type="button" class="x" data-clear="report" aria-label="No report">×</button></span>`);
		return pills.join("");
	}
	function chatMenuHtml() {
		const c = state.chat;
		const lib = chatLib();
		const row = (key, name, control, title, attrs = "") => `<div class="row click" data-row="${key}" title="${esc(title)}" ${attrs}>${chatIcon(key)}<span class="name">${name}</span>${control}</div>`;
		const radio = (on) => `<span class="radio ${on ? "on" : ""}" aria-hidden="true"></span>`;
		const fold = (key) => `<span class="more" aria-hidden="true">${c.open === key ? "▾" : "›"}</span>`;
		const { count } = chatScope();
		const folderVal = c.mode === "folders" && c.folders.size ? pdfCount(count) : "";
		const paperVal = c.mode === "papers" && c.papers.size ? `${c.papers.size} chosen` : "";
		return [
			row("library", "Whole library", `<span class="val">${pdfCount(lib.papers.length)}</span>${radio(c.mode === "library")}`, "Every PDF in the library", 'data-cmode="library"'),
			row("folders", "Folders", `<span class="val">${folderVal}</span>${fold("folders")}${radio(c.mode === "folders")}`, "The PDFs in the ticked folders and their subfolders", `data-cmode="folders" role="button" aria-expanded="${c.open === "folders"}"`),
			c.open === "folders" ? chatFoldersHtml() : "",
			row("papers", "Papers", `<span class="val">${paperVal}</span>${fold("papers")}${radio(c.mode === "papers")}`, "Only the ticked papers", `data-cmode="papers" role="button" aria-expanded="${c.open === "papers"}"`),
			c.open === "papers" ? `<div class="sub">${lib.papers.length > 12 ? `<input type="text" class="lookup" id="chat-find" placeholder="Find a paper ..." autocomplete="off" value="${esc(c.find)}">` : ""}<div id="chat-papers">${chatPapersHtml()}</div></div>` : "",
			row("upload", "Upload PDF", "", "Add PDFs from your disk to the library and ask about them", 'data-cact="upload"'),
			'<div class="sep"></div>',
			row("report", "Write a report", `<span class="switch ${c.report ? "on" : ""}" role="switch" aria-checked="${c.report}" aria-label="Write a report"></span>`, "Send builds an HTML report over the sources; your text gives its questions", 'data-cact="report"'),
			c.report ? `<div class="row kinds"><span class="seg">${Object.keys(REPORT_KIND_TEXT).map((kind) => `<button type="button" data-ckind="${kind}" class="${c.kind === kind ? "on" : ""}" title="${esc(REPORT_KIND_TITLE[kind])}">${REPORT_KIND_TEXT[kind]}</button>`).join("")}</span></div>` : "",
		].join("");
	}
	function chatFoldersHtml() {
		const c = state.chat;
		const nodes = folderNodes();
		if (!nodes.length) return '<div class="sub"><div class="wait">No folders in the library.</div></div>';
		return `<div class="sub tree">${nodes.map((entry) => {
			const under = [...c.folders].some((path) => isInside(entry.node.path, path));
			const n = papersUnder(entry.node).length;
			return `<label style="padding-left:${entry.depth * 1.1}rem" title="${esc(entry.node.path)}"><input type="checkbox" data-cfolder="${esc(entry.node.path)}" ${c.folders.has(entry.node.path) || under ? "checked" : ""} ${under ? "disabled" : ""}><span>${esc(entry.name)}</span><small>${n}</small></label>`;
		}).join("")}</div>`;
	}
	function chatPapersHtml() {
		const c = state.chat;
		const needle = c.find.trim().toLowerCase();
		const papers = chatLib().papers.filter((paper) => !needle || `${paper.title || ""} ${(paper.authors || []).join(" ")} ${paper.year || ""} ${paper.base}`.toLowerCase().includes(needle));
		// Ticked papers first, so a pick stays in view.
		const sorted = [...papers.filter((paper) => c.papers.has(paper.base)), ...papers.filter((paper) => !c.papers.has(paper.base))];
		return sorted.map((paper) => {
			const lead = [paper.year, authorsShort(paper.authors)].filter(Boolean).join(" ");
			return `<label title="${esc(paper.title || paper.base)}"><input type="checkbox" data-cpaper="${esc(paper.base)}" ${c.papers.has(paper.base) ? "checked" : ""}><span>${lead ? `${esc(lead)} · ` : ""}${esc(paper.title || paper.base)}</span></label>`;
		}).join("");
	}
	function chatBadge() {
		return [chatScope().scope !== "library", state.chat.report].filter(Boolean).length;
	}
	/** Send names what it does; the box says what a report reads from it. */
	function chatSendLabel() {
		$("btn-send").textContent = state.chat.report ? "Build report" : "Send";
		const input = $("input");
		if (state.chat.report && !input.disabled) {
			stopEntryTyping();
			input.placeholder = state.chat.kind === "bullets" ? "Build report (no question needed) ..." : "Questions for the report ...";
			state.chatReportHint = true;
		} else if (state.chatReportHint) {
			input.placeholder = "";
			state.chatReportHint = false;
		}
	}
	function chatMenuClick(event) {
		const c = state.chat;
		const target = event.target.closest("[data-cmode],[data-cact],[data-ckind]");
		if (!target || event.target.closest("input")) return;
		if (target.dataset.cmode) {
			const mode = target.dataset.cmode;
			c.label = "";
			if (mode === "library") { c.mode = "library"; c.open = ""; }
			else { c.mode = mode; c.open = c.open === mode ? "" : mode; }
		}
		if (target.dataset.cact === "report") c.report = !c.report;
		if (target.dataset.cact === "upload") { chatFileInput().click(); return; }
		if (target.dataset.ckind) c.kind = target.dataset.ckind;
		renderOptions(true);
	}
	function chatMenuChange(event) {
		const c = state.chat;
		const folder = event.target.closest("[data-cfolder]");
		const paper = event.target.closest("[data-cpaper]");
		if (!folder && !paper) return;
		c.label = "";
		if (folder) {
			c.mode = "folders";
			if (folder.checked) c.folders.add(folder.dataset.cfolder); else c.folders.delete(folder.dataset.cfolder);
		} else {
			c.mode = "papers";
			if (paper.checked) c.papers.add(paper.dataset.cpaper); else c.papers.delete(paper.dataset.cpaper);
		}
		renderOptions(true);
	}
	let chatFile = null;
	/** One hidden file chooser for the menu's "Upload PDF". */
	function chatFileInput() {
		if (chatFile) return chatFile;
		chatFile = document.createElement("input");
		Object.assign(chatFile, { type: "file", accept: "application/pdf,.pdf", multiple: true, hidden: true });
		chatFile.addEventListener("change", async () => {
			const bases = await uploadPdfs([...chatFile.files]);
			chatFile.value = "";
			if (!bases.length) return;
			Object.assign(state.chat, { mode: "papers", papers: new Set(bases), open: "", label: "" });
			await loadChatLib();
			if ($("rail-library").open) loadLibrary();
		});
		document.body.appendChild(chatFile);
		return chatFile;
	}

	/** The drop-down under the request box: the proposed blocks (or the
	 * wait for them). The request text stays in the box above it. */
	function renderDrop(view, dropMode) {
		const drop = $("drop");
		drop.hidden = !dropMode;
		if (!dropMode) {
			if (state.dropTopic !== undefined && $("input").value === state.dropTopic) $("input").value = "";
			state.dropTopic = undefined;
			drop.innerHTML = "";
			return;
		}
		if (state.dropTopic !== view.answers.topic) { state.dropTopic = view.answers.topic; $("input").value = view.answers.topic; }
		if (view.pending) { drop.innerHTML = `<div class="msg pending"><span class="dot busy"></span>${esc(view.pending)} ...</div>`; return; }
		const message = [...view.messages].reverse().find((entry) => entry.role === "assistant" && entry.step === "blocks");
		drop.innerHTML = message ? messageHtml(message) : "";
	}

	$("composer").addEventListener("submit", (event) => {
		event.preventDefault();
		const text = $("input").value.trim();
		// A report over the chosen sources may start without a question.
		if (state.chatMenu && state.chat.report && state.dialog && !state.dialog.activeJob && !state.dialog.pending) {
			$("input").value = "";
			setMenu(false);
			const body = { text, ...chatPayload() };
			state.chat.report = false;
			renderOptions(false);
			answer(body);
			return;
		}
		if (!text) return;
		// Under the synonym drop-down the box still holds the request: the
		// same text searches with the edited blocks, a changed text asks for
		// new blocks.
		if (state.dropMode) {
			setMenu(false);
			const node = $("drop").querySelector(".msg.assistant[data-step]:not(.spent)");
			if (!node) return;
			if (text === state.dropTopic) answer({ chip: "use", ...collect(node) });
			else answer({ chip: "retopic", text });
			return;
		}
		// A leading "?" sends the text to the helper; otherwise the server
		// decides (parser answer, or a question when the step takes chips only
		// or the parser does not recognise a question-like text).
		const ask = text.startsWith("?");
		const request = !ask && state.dialog && (state.dialog.step === "start" || state.dialog.step === "topic");
		// The menu's settings are read while the box still holds the request
		// (its synonym blocks belong to that text).
		const extras = request ? optionsPayload() : state.chatMenu && !ask ? chatPayload() : {};
		$("input").value = "";
		setMenu(false);
		answer({ text: text.replace(/^\?\s*/, ""), ...(ask ? { ask: true } : collect(currentQuestion())), ...extras });
	});

	$("drop").addEventListener("click", (event) => {
		if (editBlocks(event)) return;
		const chip = event.target.closest(".chips button[data-chip]");
		if (!chip) return;
		const node = chip.closest(".msg");
		if (node.classList.contains("spent")) return;
		setMenu(false);
		answer({ chip: chip.dataset.chip, ...collect(node) });
	});
	// A term box grows with its text; Enter in it searches (the primary chip).
	document.addEventListener("input", (event) => {
		if (event.target.matches(".blocks .term input")) event.target.size = Math.max(3, event.target.value.length);
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" || !event.target.matches(".blocks .term input")) return;
		event.preventDefault();
		const message = event.target.closest(".msg");
		const primary = message && message.querySelector(".chips button.primary");
		if (primary) primary.click();
	});

	$("thread").addEventListener("click", (event) => {
		if (editBlocks(event)) return;
		// The start screen's tiles open a conversation at that stage's first
		// question, exactly like the rail's "+ New ..." rows.
		const tile = event.target.closest(".hero .tile[data-start]");
		if (tile && !tile.disabled) { startNew(tile.dataset.start); return; }
		const chip = event.target.closest(".chips button[data-chip]");
		if (chip) {
			const node = chip.closest(".msg");
			if (node.classList.contains("spent")) return;
			if (chip.classList.contains("toggle")) {
				if (node.dataset.single) node.querySelectorAll(".toggle.on").forEach((other) => { if (other !== chip) other.classList.remove("on"); });
				chip.classList.toggle("on");
				return;
			}
			answer({ chip: chip.dataset.chip, ...collect(node) });
			return;
		}
		const pdf = event.target.closest("a.pdf-link");
		if (pdf) {
			event.preventDefault();
			state.panelClosedByUser = false;
			showPdf(pdf.getAttribute("href"));
			return;
		}
		const open = event.target.closest(".card-open");
		if (open) {
			event.preventDefault();
			if (open.dataset.url) {
				state.panelClosedByUser = false;
				showReport(open.dataset.url, open.dataset.name);
				setPopup(true);
			}
			return;
		}
		const folder = event.target.closest(".folder[data-folder]");
		if (folder) {
			post("/api/reveal", folder.dataset.path ? { path: folder.dataset.path } : { stage: folder.dataset.folder }).then((r) => toast(`Opened ${r.opened} in the file manager.`)).catch((error) => toast(error.message));
			return;
		}
		// Stop and Esc reach only the job of this conversation; jobs of other
		// conversations keep running in the background.
		const stop = event.target.closest(".stop-job");
		if (stop) {
			event.preventDefault();
			const job = stop.closest(".working").dataset.job;
			post(`/api/jobs/${encodeURIComponent(job)}/cancel`).catch(() => {});
		}
	});

	/* ---------------- report panel ---------------- */
	const shell = $("shell"), frame = $("frame"), reportBox = $("report");
	function showReport(url, name) {
		state.report = { url, name };
		if (frame.getAttribute("src") !== url) frame.src = url;
		frame.hidden = false;
		$("report-empty").hidden = true;
		$("report-name").textContent = name || url;
		$("report-kind").textContent = /\.svg$/i.test(name || url) ? "Diagram" : "Report";
		$("ticked").textContent = "";
		if (!state.panelClosedByUser) shell.classList.remove("no-report");
	}
	/** A PDF at a page: the viewer inside the frame follows the fragment
	 * (#page=..&search=..); a fragment-only change navigates in place. */
	function showPdf(rawHref, fresh = false) {
		// pagemode=none keeps the viewer's sidebar (thumbnails, outline)
		// closed, so the page itself gets the width; viewers without the
		// parameter ignore it.
		const href = /pagemode=/.test(rawHref) ? rawHref : `${rawHref}${rawHref.includes("#") ? "&" : "#"}pagemode=none`;
		const path = (url) => url.replace(/[?#].*$/, "");
		const hash = href.includes("#") ? href.slice(href.indexOf("#")) : "";
		const name = decodeURIComponent(path(href).replace(/^\/pdf\//, ""));
		const loaded = frame.getAttribute("src") || "";
		state.report = { url: href, name };
		frame.hidden = false;
		$("report-empty").hidden = true;
		$("report-name").textContent = name;
		$("report-kind").textContent = "PDF";
		$("ticked").textContent = "";
		if (fresh) {
			// A new chat: the document loads anew, without the marks of the last one.
			frame.src = `${path(href)}?view=${Date.now()}${hash}`;
		} else if (path(loaded) === path(href)) {
			// Same document: only the fragment moves (page, marked passage).
			const target = `${loaded.replace(/#.*$/, "")}${hash}`;
			try { frame.contentWindow.location.replace(target); } catch { frame.src = target; }
		} else {
			frame.src = href;
		}
		shell.classList.remove("no-report");
		setPopup(document.querySelector(".chat").classList.contains("resultsview"));
	}
	function setPopup(on) {
		// On the results page the panel is only a window: closing it hides it.
		const listPage = document.querySelector(".chat").classList.contains("resultsview");
		reportBox.classList.toggle("popup", on);
		$("backdrop").hidden = !on;
		$("btn-enlarge").hidden = on && listPage;
		if (!on && listPage) shell.classList.add("no-report");
		$("btn-enlarge").title = on ? "Shrink beside the chat (Esc)" : "Enlarge over the page";
		if (on) shell.classList.remove("no-report");
	}
	$("btn-enlarge").addEventListener("click", () => setPopup(!reportBox.classList.contains("popup")));
	$("backdrop").addEventListener("click", () => setPopup(false));
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (reportBox.classList.contains("popup")) { setPopup(false); return; }
		if ($("modal").open || document.querySelector("dialog[open]")) return;
		if (state.dialog && state.dialog.activeJob) { event.preventDefault(); post(`/api/jobs/${encodeURIComponent(state.dialog.activeJob)}/cancel`).catch(() => {}); toast("Stopping the job ..."); }
	});
	$("btn-newtab").addEventListener("click", () => { if (state.report.url) window.open(state.report.url, "_blank"); });
	$("btn-close-panel").addEventListener("click", () => { setPopup(false); state.panelClosedByUser = true; shell.classList.add("no-report"); });
	frame.addEventListener("load", () => {
		const update = () => { const n = tickedInReport().length; $("ticked").textContent = n ? `${n} ticked` : ""; };
		try { frame.contentDocument.addEventListener("change", update); } catch { /* same origin always */ }
		update();
	});

	/* ---------------- rail ---------------- */
	async function loadState() {
		try { state.info = await get("/api/state"); } catch (error) { $("status").innerHTML = `<span class="dot bad"></span>${esc(error.message)}`; return; }
		const info = state.info;
		$("btn-folder").title = `Working folder: ${info.root}`;
		const p = info.provider;
		// The brand mark: a plain Greek pi everywhere until pi.dev's permission
		// for its logo is confirmed; then the logo inside pi, the glyph standalone.
		const piDevMark = PI_DEV_MARK_ALLOWED && p.kind === "pi";
		document.querySelector(".brand .mark-pi").hidden = !piDevMark;
		document.querySelector(".brand .mark-glyph").hidden = piDevMark;
		// A local server that does not answer turns its dot red (the server
		// probes 127.0.0.1 addresses on every state read); remote services
		// are not probed.
		const dot = (reachable) => `<span class="dot ${reachable === false ? "bad" : ""}"></span>`;
		const down = (reachable, what) => (reachable === false ? ` <span class="down">-- not running: start ${what} first</span>` : "");
		$("status").innerHTML = p.model
			? `${dot(p.modelReachable)}model <b>${esc(p.model)}</b> ${esc(p.via)}${p.remote ? " (remote service)" : p.remote === false ? ", local" : ""} · thinking: ${esc(p.thinking || "off")}${down(p.modelReachable, "the model server")}<br>${dot(p.embeddingsReachable)}embeddings <b>${esc(p.embeddings)}</b>, ${esc(p.embeddingsVia)}${down(p.embeddingsReachable, "the embedding server")}`
			: `<span class="dot bad"></span>no model selected ${p.kind === "pi" ? "(choose one with /model in pi)" : "(set the generation model in Settings)"}<br>${dot(p.embeddingsReachable)}embeddings <b>${esc(p.embeddings)}</b>${down(p.embeddingsReachable, "the embedding server")}`;
		$("cnt-pdfs").textContent = info.counts.pdfs ? String(info.counts.pdfs) : "";
	}

	const historyOpen = () => $("hist-1").open || $("hist-2").open;

	const ICON_REVEAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
	/** The library as folders: each source folder with its subfolders (the
	 * user's own structure), papers inside. */
	/** The library's folder tree: each source folder with its subfolders,
	 * papers in the folder that holds them. Shared by the rail and the chat
	 * menu. */
	/** The path separator a folder path uses (Windows paths carry "\\"). */
	const sep = (path) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
	function libraryTree(papers, dirs, store) {
		const split = (path) => path.split(/[\\/]/).filter(Boolean);
		const roots = [...dirs].sort((a, b) => b.length - a.length);
		const tree = new Map(dirs.map((dir) => [dir, { path: dir, children: new Map(), papers: [] }]));
		for (const paper of papers) {
			const root = roots.find((dir) => paper.dir === dir || paper.dir.startsWith(dir + sep(dir)));
			if (!root) continue;
			let node = tree.get(root);
			for (const part of split(paper.dir.slice(root.length))) {
				if (!node.children.has(part)) node.children.set(part, { path: node.path + sep(root) + part, children: new Map(), papers: [] });
				node = node.children.get(part);
			}
			node.papers.push(paper);
		}
		// PDFs added in the browser live in the store's inbox: "Uploads".
		const isInbox = (dir) => Boolean(store) && dir === `${store}${sep(store)}inbox`;
		const nameOf = (dir) => {
			if (isInbox(dir)) return "Uploads";
			const parts = split(dir);
			const last = parts[parts.length - 1] || dir;
			return last === "lit-selection" && parts.length > 1 ? `${parts[parts.length - 2]} / lit-selection` : last;
		};
		// The user's own folders first, the uploads last.
		const order = [...dirs.filter((dir) => !isInbox(dir)), ...dirs.filter(isInbox)];
		return { tree, nameOf, isInbox, order };
	}
	/** Every paper in a folder and its subfolders. */
	function papersUnder(node) {
		return [...node.papers, ...[...node.children.values()].flatMap(papersUnder)];
	}
	function libraryTreeHtml(papers, dirs, store, folders = []) {
		const { tree, nameOf, isInbox, order } = libraryTree(papers, dirs, store);
		const count = (node) => papersUnder(node).length;
		// Year and authors only where the metadata has them; else the file name.
		const item = (paper) => {
			const lead = [paper.year, authorsShort(paper.authors)].filter(Boolean).join(" ");
			return `<a class="item paper" data-url="${esc(paper.pdfUrl)}" data-name="${esc(paper.base)}.pdf" data-base="${esc(paper.base)}" title="${esc(paper.title || paper.base)}"><span>${lead ? `${esc(lead)} · ` : ""}${esc(paper.title || paper.base)}</span><button type="button" class="newchat" data-newchat="${esc(paper.base)}" title="New chat about this PDF" aria-label="New chat about this PDF">+</button></a>`;
		};
		const node = (entry, name, depth) => {
			const children = [...entry.children.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([part, child]) => node(child, part, depth + 1)).join("");
			return `<details class="lfolder" ${depth === 0 && dirs.length === 1 ? "open" : ""}><summary title="${esc(entry.path)}">${ICON_FOLDER_SMALL}<span class="lname">${esc(name)}</span><span class="cnt">${count(entry)}</span><button type="button" class="reveal" data-reveal="${esc(entry.path)}" title="Show in the file manager" aria-label="Show in the file manager">${ICON_REVEAL}</button>${depth === 0 && !isInbox(entry.path) ? `<button type="button" class="reveal" data-unlink="${esc(entry.path)}" title="Remove from the library (the files stay where they are)" aria-label="Remove from the library">${ICON_TRASH}</button>` : ""}</summary>${children}${entry.papers.map(item).join("")}</details>`;
		};
		return order.map((dir) => node(tree.get(dir), nameOf(dir), 0)).join("");
	}
	async function loadLibrary() {
		const box = $("rail-library-list");
		try {
			const data = await get("/api/library");
			state.lib = data;
			box.innerHTML = data.papers.length ? libraryTreeHtml(data.papers, data.dirs || [], data.store || "", data.folders || []) : "";
			$("cnt-pdfs").textContent = data.papers.length ? String(data.papers.length) : "";
		} catch (error) {
			box.innerHTML = `<div class="rail-note">${esc(error.message)}</div>`;
		}
	}
	/** Add a PDF folder: the system's folder window, else the typed path in Settings. */
	async function addFolder(path) {
		try {
			let chosen = path;
			if (!chosen) {
				const picked = await post("/api/folders/pick", { purpose: "pdf" });
				chosen = picked.path;
				if (!chosen) return false;
			}
			await post("/api/folders/add", { path: chosen });
			toast(`Added ${chosen}`);
			loadLibrary();
			return true;
		} catch (error) {
			if (/no folder window/.test(error.message)) { openSettingsAt("set-folder-path"); return false; }
			toast(error.message);
			return false;
		}
	}
	$("btn-add-folder").addEventListener("click", async () => { if (await addFolder()) $("rail-library").open = true; });
	$("rail-library-list").addEventListener("click", async (event) => {
		const unlink = event.target.closest("button[data-unlink]");
		if (unlink) {
			event.preventDefault();
			event.stopPropagation();
			const ok = await confirmBox("Remove from the library?", `${unlink.dataset.unlink} -- the folder and its PDFs stay on your disk; only the library stops reading it.`, "Remove from library");
			if (!ok) return;
			try { await post("/api/folders/remove", { path: unlink.dataset.unlink }); loadLibrary(); } catch (error) { toast(error.message); }
			return;
		}
		const reveal = event.target.closest("button.reveal[data-reveal]");
		if (!reveal) return;
		event.preventDefault();
		event.stopPropagation();
		post("/api/reveal", { path: reveal.dataset.reveal }).catch((error) => toast(error.message));
	});
	/** Saved conversations (JSON files in the history folder, see
	 * src/web/history.ts): one list per stage, newest first.
	 * Name from the request or question ("Search: ...", "Report: ...",
	 * "Chat: ..."), the start time small below; the current one is marked. */
	/** A conversation's own files, next to its trash: a search's HTML report
	 * and PRISMA diagram (written on the first click), a chat's or
	 * synthesis report. */
	function filesHtml(entry) {
		const icon = (kind) => REPORT_ACTIONS.find((action) => action.kind === kind).icon;
		if (entry.run) {
			return REPORT_ACTIONS.map((action) => `<button type="button" class="rep ${entry.written && entry.written[action.kind] ? "" : "new"}" data-rep-run="${esc(entry.run)}" data-rep-kind="${action.kind}" title="${esc(action.label)}${entry.written && entry.written[action.kind] ? "" : " (written on this click)"}" aria-label="${esc(action.label)}">${action.icon}</button>`).join("");
		}
		if (entry.report) return `<button type="button" class="rep" data-rep-url="${esc(entry.report.url)}" data-rep-name="${esc(entry.report.name)}" title="HTML report" aria-label="HTML report">${icon("html")}</button>`;
		return "";
	}
	async function loadHistory() {
		try {
			const data = await get("/api/history");
			const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); };
			const trash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
			// Under SEARCH & SELECT the "Search:" prefix says nothing; the
			// tooltip is the whole request (or question).
			const shown = (entry) => entry.title.replace(/^(Search|Chat):\s*/, "");
			const item = (entry) => `<a class="item past ${entry.current ? "current" : ""}" data-history="${esc(entry.id)}" title="${esc(shown(entry))}${entry.running ? " · still working" : ""}"><span>${entry.running ? '<i class="dot busy"></i>' : ""}${esc(shown(entry))}</span><small>${esc(when(entry.computed || entry.started))}</small><span class="acts">${filesHtml(entry)}<button type="button" class="trash" data-del="${esc(entry.id)}" title="Delete this conversation" aria-label="Delete">${trash}</button></span></a>`;
			// Search conversations under stage 1, chats and reports under stage 2.
			for (const [n, kind] of [[1, "search"], [2, "synthesis"]]) {
				// One list, newest first (older conversations from a working
				// folder included: their files are still found there).
				const mine = data.history.filter((entry) => entry.kind === kind);
				$(`hist-${n}-list`).innerHTML = mine.map(item).join("")
					+ (n === 1 && data.skipped ? `<div class="rail-note">${data.skipped} unreadable file${data.skipped === 1 ? "" : "s"} skipped in ${esc(data.dir)}</div>` : "");
				$(`cnt-hist-${n}`).textContent = mine.length ? String(mine.length) : "";
			}
		} catch (error) {
			$("hist-1-list").innerHTML = $("hist-2-list").innerHTML = `<div class="rail-note">${esc(error.message)}</div>`;
		}
	}
	for (const id of ["hist-1", "hist-2"]) $(id).addEventListener("toggle", () => { if ($(id).open) loadHistory(); });
	$("rail-library").addEventListener("toggle", () => { if ($("rail-library").open) loadLibrary(); });
	document.querySelector(".rail").addEventListener("click", async (event) => {
		// A conversation's report or diagram: open it as a window; a search's
		// missing file is written first (the run unfiltered).
		const rep = event.target.closest("button.rep");
		if (rep) {
			event.preventDefault();
			event.stopPropagation();
			state.panelClosedByUser = false;
			if (rep.dataset.repUrl) { showReport(rep.dataset.repUrl, rep.dataset.repName); setPopup(true); return; }
			const run = rep.dataset.repRun; const kind = rep.dataset.repKind;
			const file = kind === "prisma" ? `${run}.prisma.svg` : `${run}.html`;
			rep.disabled = true;
			try {
				if (rep.classList.contains("new")) {
					await post("/api/runs/report", { name: run, kind, rail: true });
					rep.classList.remove("new");
				}
				showReport(`/files/lit-search/${encodeURIComponent(file)}`, file);
				setPopup(true);
			} catch (error) { toast(error.message); } finally { rep.disabled = false; }
			return;
		}
		const del = event.target.closest("button.trash[data-del]");
		if (del) {
			event.preventDefault();
			event.stopPropagation();
			if (!confirm("Delete this conversation? Its reports and PDFs on disk stay.")) return;
			try {
				const result = await post("/api/history/delete", { id: del.dataset.del });
				state.dialog = result.dialog;
				render();
				loadHistory();
				toast(result.deleted ? "Conversation deleted." : "Nothing to delete.");
			} catch (error) { toast(error.message); }
			return;
		}
		const past = event.target.closest("a.item[data-history]");
		if (past) {
			event.preventDefault();
			try {
				const view = await post("/api/history/open", { id: past.dataset.history });
				state.dialog = view;
				render();
				loadHistory();
				showConversationPdf();
			} catch (error) { toast(error.message); }
			return;
		}
		const item = event.target.closest("a.item[data-url]");
		if (!item) return;
		event.preventDefault();
		state.panelClosedByUser = false;
		// The "+" (a new chat) loads the PDF anew, without the marks of the last chat.
		if (/^\/pdf\//.test(item.dataset.url)) showPdf(item.dataset.url, Boolean(event.target.closest("[data-newchat]")));
		else showReport(item.dataset.url, item.dataset.name);
		// A paper of the library: its last chat continues (the newest one in
		// History); the "+" on the row, or a paper without a chat, starts a new one.
		if (item.dataset.base) {
			entryDismissed = "";
			const fresh = Boolean(event.target.closest("[data-newchat]"));
			(async () => {
				try {
					const last = fresh ? null : ((await get("/api/history")).history || []).find((entry) => entry.paper === item.dataset.base && !entry.current);
					const current = !fresh && onePdfChat() && state.dialog.answers.scope[0] === item.dataset.base;
					if (current) return;
					state.dialog = last
						? await post("/api/history/open", { id: last.id })
						: await post("/api/dialog/new", { start: "synthesis", scope: [item.dataset.base] });
					render();
					loadHistory();
				} catch (error) { toast(error.message); }
			})();
		}
	});

	// A stage block opens on click (its +, History and HTML reports); the
	// block of the active stage opens by itself when the stage changes.
	// "+": the current conversation stays in History, a new one starts at that stage.
	const startNew = async (start) => {
		entryDismissed = ""; // a new conversation types its examples again
		// A running job keeps going in its own conversation (History marks it).
		// A new conversation starts without the PDF or report of the last one.
		try { state.dialog = await post("/api/dialog/new", { start }); closePanel(); render(); loadHistory(); } catch (error) { toast(error.message); }
	};
	/* The rail's width: drag its right edge (10-30 rem); kept per browser. */
	(() => {
		const handle = $("rail-resize");
		const apply = (px) => { shell.style.setProperty("--rail-w", `${Math.round(px)}px`); };
		try { const saved = Number(localStorage.getItem("plr-rail-w")); if (saved > 0) apply(saved); } catch { /* storage blocked */ }
		handle.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			handle.setPointerCapture(event.pointerId);
			handle.classList.add("on");
			const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
			const move = (e) => apply(Math.min(30 * rem, Math.max(10 * rem, e.clientX)));
			const up = () => {
				handle.classList.remove("on");
				handle.removeEventListener("pointermove", move);
				try { localStorage.setItem("plr-rail-w", String(parseFloat(shell.style.getPropertyValue("--rail-w")))); } catch { /* fine */ }
			};
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up, { once: true });
		});
		handle.addEventListener("dblclick", () => { shell.style.removeProperty("--rail-w"); try { localStorage.removeItem("plr-rail-w"); } catch { /* fine */ } });
	})();

	/* Drag and drop: PDFs from the desktop go to the inbox (next to the
	   history), then a chat over exactly these opens. */
	let dragDepth = 0;
	/** PDFs from the disk into the library's inbox; their basenames. */
	async function uploadPdfs(list) {
		const files = list.filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
		if (!files.length) { toast("Only PDF files can be added here."); return []; }
		const bases = [];
		for (const file of files) {
			toast(`Adding ${file.name} ...`);
			try {
				const response = await fetch(`/api/library/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": "application/pdf" }, body: file });
				const data = await response.json().catch(() => ({}));
				if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
				bases.push(data.base);
			} catch (error) {
				toast(`${file.name}: ${error.message}`);
			}
		}
		return bases;
	}
	const hasFiles = (event) => Boolean(event.dataTransfer && [...event.dataTransfer.types].includes("Files"));
	document.addEventListener("dragenter", (event) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth++; $("dropzone").hidden = false; });
	document.addEventListener("dragover", (event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
	document.addEventListener("dragleave", (event) => { if (!hasFiles(event)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("dropzone").hidden = true; });
	document.addEventListener("drop", async (event) => {
		if (!hasFiles(event)) return;
		event.preventDefault();
		dragDepth = 0;
		$("dropzone").hidden = true;
		const bases = await uploadPdfs([...event.dataTransfer.files]);
		if (!bases.length) return;
		entryDismissed = "";
		try {
			state.dialog = await post("/api/dialog/new", { start: "synthesis", scope: bases });
			render();
			loadHistory();
			showConversationPdf();
			if ($("rail-library").open) loadLibrary();
		} catch (error) {
			toast(error.message);
		}
	});
	$("input").addEventListener("pointerdown", dismissEntryTyping);
	$("input").addEventListener("keydown", dismissEntryTyping);
	$("btn-new-search").addEventListener("click", () => startNew("search"));
	$("btn-new-chat").addEventListener("click", () => startNew("synthesis"));
	// The package name returns to the start screen (a new conversation; the current one stays in History).
	$("brand-home").addEventListener("click", () => startNew());
	// Info: where the data goes and which sources are asked, from the server's state.
	$("btn-info").addEventListener("click", () => {
		const pop = $("info-pop");
		if (!pop.hidden) { pop.hidden = true; return; }
		const p = state.info && state.info.provider;
		const model = p && p.model ? `${esc(p.model)}${p.remote ? " (a remote service: the passages you ask about go there)" : " (local)"}` : "none selected yet";
		pop.innerHTML = `<p><b>Where your data goes.</b> Search queries go to arXiv, Crossref and OpenAlex (open, no account; Semantic Scholar only with a free key). Your PDFs stay on this machine. Writing model: ${model}. Embeddings: ${esc(p ? p.embeddings : "")}, local.</p><p><b>Citations</b> are inserted and checked by code, never written by the model.</p><p><b>Downloads</b> are legal open access only; restricted papers are listed with a browser link.</p>`;
		pop.hidden = false;
	});
	document.addEventListener("click", (event) => { if (!event.target.closest("#btn-info") && !event.target.closest("#info-pop")) $("info-pop").hidden = true; });
	// An open sort menu closes on a click anywhere else.
	document.addEventListener("click", (event) => {
		if (event.target.closest(".sortwrap")) return;
		for (const [name, entry] of state.results) if (entry.sortOpen) { entry.sortOpen = false; redrawResults(name); }
	});
	// Opens the data folder in the file manager (same launcher as the file cards).
	$("btn-folder").addEventListener("click", () => {
		post("/api/reveal", { stage: "root" }).then((r) => toast(`Opened ${r.opened} in the file manager.`)).catch((error) => toast(error.message));
	});

	/* ---------------- SSE ---------------- */
	function connectEvents() {
		const source = new EventSource("/api/events");
		source.addEventListener("snapshot", (event) => {
			const snapshot = JSON.parse(event.data);
			state.lines = new Map();
			for (const line of snapshot.lines || []) {
				if (!state.lines.has(line.job)) state.lines.set(line.job, []);
				state.lines.get(line.job).push(line);
			}
			state.job = snapshot.current;
			render();
		});
		source.addEventListener("line", (event) => {
			const line = JSON.parse(event.data);
			if (!state.lines.has(line.job)) state.lines.set(line.job, []);
			const list = state.lines.get(line.job);
			list.push(line);
			if (list.length > 500) list.splice(0, list.length - 500);
			renderWorking(line.job);
		});
		source.addEventListener("job", (event) => {
			const job = JSON.parse(event.data).job;
			state.job = job.state === "running" ? job : null;
			if (job.kind === "check" || job.kind === "pull") renderSettingsProgress();
			if (job.state !== "running") { loadState(); if ($("rail-library").open) loadLibrary(); if (historyOpen()) loadHistory(); }
		});
		// A conversation in the background changed (job started or finished).
		source.addEventListener("history", () => { loadHistory(); });
		source.addEventListener("dialog", (event) => {
			state.dialog = JSON.parse(event.data);
			state.pushes = (state.pushes || 0) + 1;
			render();
			if (historyOpen()) loadHistory();
		});
		source.onerror = () => {
			$("status").innerHTML = '<span class="dot bad"></span>connection to the server lost -- is pi still running?';
		};
	}

	/* ---------------- settings ---------------- */
	function renderSettingsProgress() {
		const lines = [...state.lines.entries()].filter(([job]) => /^(check|pull)-/.test(job)).flatMap(([, list]) => list).slice(-60);
		$("progress-settings").innerHTML = lines.map(lineHtml).join("");
	}
	async function loadSettings() {
		let data;
		try { data = await get("/api/settings"); } catch (error) { $("set-error").textContent = error.message; return; }
		state.settingsConversations = data.conversations || 0;
		loadFolders();
		state.settingsBlocks = data.savedBlocks || 0;
		$("set-blocks").textContent = `${data.savedBlocks || 0} request${data.savedBlocks === 1 ? "" : "s"} with saved keyword blocks. The same request text always searches with the same blocks; forget them to let the model build new ones.`;
		$("set-history").textContent = `${data.conversations || 0} saved conversation${data.conversations === 1 ? "" : "s"} in ${data.historyDir} (one JSON file each; PI_LITERATURE_REVIEW_HISTORY moves the folder).`;
		const info = state.info || {};
		const p = info.provider || {};
		$("set-path").textContent = `Configuration file: ${data.path}`;
		$("set-model").innerHTML = p.model ? `Writing model: <b>${esc(p.model)}</b> ${esc(p.via)}${p.remote ? " (remote service: your questions leave this machine)" : p.remote === false ? " (local)" : ""}` : "No writing model selected.";
		$("set-model-hint").textContent = p.kind === "pi"
			? "Inside pi the model is the one selected with /model; it takes effect on the next job. The fields below matter for the standalone server only."
			: "Standalone: the writing model is the generation model below, at the shared or the generation address.";
		const llm = data.llm || {};
		$("set-api").value = llm.api || "";
		$("set-base-url").value = llm.baseUrl || "";
		$("set-base-url").placeholder = data.resolved.baseUrl;
		$("set-generate-model").value = llm.generateModel || "";
		$("set-generate-url").value = llm.generateBaseUrl || "";
		$("set-embed-model").value = llm.embedModel || "";
		$("set-embed-model").placeholder = data.resolved.embedModel;
		$("set-embed-url").value = llm.embedBaseUrl || "";
		$("set-mailto").value = data.mailto || "";
		$("set-mailto-hint").textContent = data.mailtoResolved && !data.mailto ? `Set by the environment variable PI_LITERATURE_REVIEW_MAILTO: ${data.mailtoResolved}` : "Leave empty and the download step asks each run.";
		$("set-topics").value = (data.codeListTopics || []).join(", ");
		$("set-thinking").value = data.thinking || "off";
		showThinkingNote();
		const embed = data.embedState;
		$("set-embed-state").innerHTML = embed
			? (embed.state === "ok" ? `<span class="dot"></span>reachable · ${esc(data.resolved.embedModel)} present`
				: embed.state === "not-ollama" ? `<span class="dot"></span>${esc(data.resolved.embedApi || data.resolved.api)} dialect: no automatic check; Test setup tries one embedding call`
				: embed.state === "missing" ? `<span class="dot bad"></span>${esc(embed.model)} is not present at ${esc(embed.baseUrl)} -- fetch it below`
				: `<span class="dot bad"></span>${esc(embed.baseUrl)} unreachable: ${esc(embed.error)}`)
			: `<span class="dot idle"></span>not checked yet · resolved: ${esc(data.resolved.embedModel)} via ${esc(data.resolved.embedApi || data.resolved.api)} at ${esc(data.resolved.embedBaseUrl || data.resolved.baseUrl)}`;
		$("btn-pull-embed").disabled = (data.resolved.embedApi || data.resolved.api) !== "ollama" || Boolean(state.job);
		const keys = data.keys || {};
		$("set-keys").innerHTML = `<tr><td><code>s2ApiKey</code></td><td>${keys.s2ApiKey ? "set" : "not set"}</td><td>Semantic Scholar as fourth search source (free key)</td></tr>
<tr><td><code>githubToken</code></td><td>${keys.githubToken ? "set" : "not set"}</td><td>GitHub search limit 10 -> 30 per minute for the code sources</td></tr>
<tr><td><code>llm.apiKey</code></td><td>${keys.llmApiKey ? "set" : "not set"}</td><td>Bearer token for a remote LLM backend</td></tr>`;
		renderSettingsProgress();
	}
	$("btn-settings").addEventListener("click", () => openSettingsAt(null));
	async function openSettingsAt(focusId) {
		$("set-error").textContent = "";
		await loadSettings();
		if (!$("settings").open) $("settings").showModal();
		if (focusId && $(focusId)) { $(focusId).scrollIntoView({ block: "center" }); $(focusId).focus(); }
	}
	/** The PDF folders in Settings: each with its file-manager and remove buttons. */
	async function loadFolders() {
		try {
			const data = await get("/api/folders");
			$("set-folders").innerHTML = data.pdfFolders.length
				? data.pdfFolders.map((folder) => `<div class="folder"><span title="${esc(folder)}">${esc(folder)}</span><button type="button" class="ibtn" data-reveal-folder="${esc(folder)}" title="Show in the file manager" aria-label="Show in the file manager">${ICON_REVEAL}</button><button type="button" class="ibtn" data-remove-folder="${esc(folder)}" title="Stop reading this folder (its files stay where they are)" aria-label="Remove">×</button></div>`).join("")
				: "";
			$("btn-folder-pick").hidden = !data.canPick;
			$("set-store").innerHTML = `<div class="folder"><span title="${esc(data.store)}">${esc(data.store)}</span><button type="button" class="ibtn" data-reveal-folder="${esc(data.store)}" title="Show in the file manager" aria-label="Show in the file manager">${ICON_REVEAL}</button></div>`;
		} catch (error) {
			$("set-error").textContent = error.message;
		}
	}
	$("set-store").addEventListener("click", (event) => {
		const reveal = event.target.closest("[data-reveal-folder]");
		if (reveal) post("/api/reveal", { path: reveal.dataset.revealFolder }).catch((error) => toast(error.message));
	});
	$("set-folders").addEventListener("click", async (event) => {
		const reveal = event.target.closest("[data-reveal-folder]");
		if (reveal) { post("/api/reveal", { path: reveal.dataset.revealFolder }).catch((error) => toast(error.message)); return; }
		const remove = event.target.closest("[data-remove-folder]");
		if (!remove) return;
		try { await post("/api/folders/remove", { path: remove.dataset.removeFolder }); } catch (error) { $("set-error").textContent = error.message; }
		loadFolders();
		if ($("rail-library").open) loadLibrary();
	});
	$("btn-folder-pick").addEventListener("click", async () => { await addFolder(); loadFolders(); });
	const addTyped = async () => {
		const path = $("set-folder-path").value.trim();
		if (!path) return;
		if (await addFolder(path)) $("set-folder-path").value = "";
		loadFolders();
	};
	$("btn-folder-add").addEventListener("click", addTyped);
	$("set-folder-path").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addTyped(); } });
	/** A level above Off can cut answers off on modest hardware. */
	function showThinkingNote() { $("set-thinking-note").hidden = $("set-thinking").value === "off"; }
	$("set-thinking").addEventListener("change", showThinkingNote);
	$("btn-settings-close").addEventListener("click", () => $("settings").close());
	$("btn-history-clear").addEventListener("click", async () => {
		const n = state.settingsConversations || 0;
		if (!confirm(`Delete all ${n} saved conversation${n === 1 ? "" : "s"}? Reports and PDFs on disk stay.`)) return;
		try {
			const result = await post("/api/history/clear");
			state.dialog = result.dialog;
			render();
			loadHistory();
			await loadSettings();
			toast(`${result.deleted} conversation${result.deleted === 1 ? "" : "s"} deleted.`);
		} catch (error) { $("set-error").textContent = error.message; }
	});
	$("btn-blocks-clear").addEventListener("click", async () => {
		try {
			const result = await post("/api/blocks/clear");
			await loadSettings();
			toast(`${result.deleted} saved keyword block set${result.deleted === 1 ? "" : "s"} forgotten.`);
		} catch (error) { $("set-error").textContent = error.message; }
	});
	$("btn-settings-save").addEventListener("click", async () => {
		$("set-error").textContent = "";
		try {
			await post("/api/settings", {
				mailto: $("set-mailto").value,
				codeListTopics: $("set-topics").value.split(",").map((t) => t.trim()).filter(Boolean),
				thinking: $("set-thinking").value,
				llm: {
					api: $("set-api").value, baseUrl: $("set-base-url").value,
					generateModel: $("set-generate-model").value, generateBaseUrl: $("set-generate-url").value,
					embedBaseUrl: $("set-embed-url").value, embedModel: $("set-embed-model").value,
				},
			});
			await loadState();
			await loadSettings();
			$("progress-settings").innerHTML = `<span class="ok">saved to ${esc($("set-path").textContent.replace(/^Configuration file: /, ""))}</span>\n`;
		} catch (error) {
			$("set-error").textContent = error.message;
		}
	});
	$("btn-settings-test").addEventListener("click", async () => {
		$("set-error").textContent = "";
		try { await post("/api/settings/check"); } catch (error) { $("set-error").textContent = error.message; }
	});
	$("btn-pull-embed").addEventListener("click", async () => {
		$("set-error").textContent = "";
		try { await post("/api/settings/pull-embed"); } catch (error) { $("set-error").textContent = error.message; }
	});

	/* ---------------- scripted access (screenshots, tests) ---------------- */
	window.plr = {
		answer: (text) => answer({ text, ...collect(currentQuestion()) }),
		chip: (id) => answer({ chip: id, ...collect(currentQuestion()) }),
		state: () => state.dialog,
		options: () => state.options,
	};

	/* ---------------- start ---------------- */
	(async () => {
		await loadState();
		loadHistory();
		// A page load (or reload) always begins on the start screen: the
		// conversation so far stays in History. While a job or a model call
		// is running the server refuses (409) and the live conversation shows.
		try {
			state.dialog = await post("/api/dialog/new");
		} catch {
			try { state.dialog = await get("/api/dialog"); } catch (error) { toast(error.message); }
		}
		render();
		loadHistory();
		setTimeout(connectEvents, 50);
	})();
})();
