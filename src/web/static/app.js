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

	const state = {
		dialog: null,
		/** Progress lines per job id (from the SSE stream). */
		lines: new Map(),
		job: null,
		info: null,
		report: { url: null, name: null },
		panelClosedByUser: false,
		renderedKey: "",
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

	function editorHtml(message) {
		if (!message.editor) return "";
		return `<div class="blocks">${message.editor.map((line, index) => `${index ? '<div class="and">and</div>' : ""}<input type="text" value="${esc(line)}" ${message.spent ? "disabled" : ""}>`).join("")}</div>`;
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

	function answerHtml(view) {
		const round = view.answer;
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
		return `<div class="answer ${round.grounded ? "" : "ungrounded"}">${round.grounded ? "" : '<p class="hint error">UNGROUNDED DRAFT -- the model produced no verifiable citations. Do not use this text as an answer.</p>'}<div class="prose">${proseHtml(round.prose, sites, view.hrefs)}</div>
${cites ? `<p class="trail">Cited passages, numbered as in the text; the page link opens the PDF at the passage in the panel.</p><ul class="cites">${cites}</ul>` : ""}
${refs ? `<p class="trail">Papers (verified records):<br>${refs}</p>` : ""}
<p class="trail">Prose by the model over the retrieved passages; citation numbers and page links inserted by code.${round.model ? ` Model ${esc(round.model)}.` : ""}</p></div>`;
	}

	function cardHtml(message) {
		const card = message.card;
		const folderButton = `<button type="button" class="folder" data-folder="${esc(card.stage)}" title="Show ${esc(card.stage)}/ in the file manager">${ICON_FOLDER}</button>`;
		if (card.kind === "folder") {
			return `<div class="filecard">${ICON_FOLDER_BIG}<div class="txt"><span class="name plain">${esc(card.name)}</span><small>${esc(card.label)}</small></div>${folderButton}</div>`;
		}
		return `<div class="filecard">${ICON_DOC}<div class="txt"><a href="${esc(card.url || "#")}" class="card-open" data-url="${esc(card.url || "")}" data-name="${esc(card.name)}" title="Open on the right">${esc(card.name)}</a><small>${esc(card.label)}</small></div>${folderButton}</div>`;
	}

	function workingHtml(message) {
		const lines = state.lines.get(message.job) || [];
		const running = message.jobState === "running";
		const title = running ? `Working ... ${esc(message.jobLabel)}` : `${message.jobState === "done" ? "Done" : message.jobState === "cancelled" ? "Stopped" : "Failed"}: ${esc(message.jobLabel)}`;
		return `<details class="working" data-job="${esc(message.job)}" ${running ? "open" : ""}><summary><span class="dot ${running ? "busy" : message.jobState === "done" ? "" : "bad"}"></span>${title}${running ? '<button type="button" class="stop-job">Stop</button>' : ""}</summary><pre>${lines.slice(-200).map(lineHtml).join("") || '<span class="dim">waiting for the first progress line ...</span>'}</pre></details>`;
	}

	function messageHtml(message) {
		switch (message.role) {
			case "user":
				return `<div class="msg user" data-id="${message.id}"><div class="bubble">${esc(message.text)}</div></div>`;
			case "working":
				return workingHtml(message);
			case "card":
				return `<div class="msg card" data-id="${message.id}">${cardHtml(message)}</div>`;
			case "answer":
				return `<div class="msg assistant ${message.spent ? "spent" : ""}" data-id="${message.id}" data-step="${esc(message.step || "")}">${answerHtml(message.answer)}${chipsHtml(message)}</div>`;
			default:
				return `<div class="msg assistant ${message.spent ? "spent" : ""}" data-id="${message.id}" data-step="${esc(message.step || "")}" ${message.single ? 'data-single="1"' : ""}>${message.text ? `<p>${markup(message.text)}</p>` : ""}${editorHtml(message)}${message.note ? `<p class="small">${markup(message.note)}</p>` : ""}${listHtml(message)}${chipsHtml(message)}</div>`;
		}
	}

	/** The input box says what the open step expects. */
	function placeholderFor(step) {
		switch (step) {
			case "ask": case "finished": return "Ask a question about the PDFs ...";
			case "topic": return "Describe what you are looking for ...";
			case "blocks": return "Confirm or edit the blocks above, or type new lines ...";
			case "period": return "Pick a period, or type a range such as 2015-2024 ...";
			case "journals": return "Tick journals above, or type numbers, a name, or \"all\" ...";
			case "authors": return "Tick authors above, type numbers, a name, or \"all\" ...";
			case "pick": return "Tick papers in the report, or type row numbers, DOIs, \"all\" or \"code\" ...";
			case "mailto": return "Your email address, or continue without Unpaywall ...";
			case "questions": return "Your questions, each ending with a question mark ...";
			case "confirm": return "Search, or type count 30 / cites 5 / code on / code off ...";
			default: return "Type your answer or question ...";
		}
	}

	function render() {
		const view = state.dialog;
		if (!view) return;
		const thread = $("thread");
		const parts = view.messages.map(messageHtml);
		if (view.pending) parts.push(`<div class="msg pending"><span class="dot busy"></span>${esc(view.pending)} ...</div>`);
		thread.innerHTML = parts.join("");
		// Every dialog change follows an answer or finishes a wait: show it.
		thread.scrollTop = thread.scrollHeight;
		renderStages(view);
		const busy = Boolean(view.activeJob) || Boolean(view.pending);
		$("input").disabled = busy;
		$("btn-send").disabled = busy;
		$("input").placeholder = view.activeJob ? "Please wait, or stop the job ..." : view.pending ? "One moment ..." : placeholderFor(view.step);
		if (!busy) $("input").focus();
		// A fresh file card opens the panel (unless the user closed it for this card already).
		const cards = view.messages.filter((message) => message.role === "card" && message.card.url);
		const latest = cards[cards.length - 1];
		if (latest && latest.card.url !== state.report.url) {
			state.panelClosedByUser = false;
			showReport(latest.card.url, latest.card.name);
			setPopup(true); // a fresh report opens large first; Esc or the shrink icon puts it beside the chat
		}
	}

	/** Update only the progress lines of a working bubble (cheap, frequent). */
	function renderWorking(jobId) {
		const details = document.querySelector(`.working[data-job="${CSS.escape(jobId)}"] pre`);
		if (!details) return;
		const lines = state.lines.get(jobId) || [];
		details.innerHTML = lines.slice(-200).map(lineHtml).join("");
		details.scrollTop = details.scrollHeight;
		const thread = $("thread");
		thread.scrollTop = thread.scrollHeight;
	}

	function renderStages(view) {
		const current = view.stage ? view.stage.stage : 1;
		const skipped = current === 3 && !(view.answers && view.answers.search);
		for (const n of [1, 2, 3]) {
			const el = $(`stage-${n}`);
			el.classList.remove("active", "done", "skipped");
			if (n < current) el.classList.add(skipped ? "skipped" : "done");
			if (n === current) el.classList.add("active");
			const label = $(`stage-${n}-label`);
			if (n === current) label.textContent = view.stage.label;
			else if (n < current) label.textContent = skipped ? "skipped" : "done";
			else label.textContent = n === 2 ? "PDF download" : n === 3 ? "questions + report" : "asking";
		}
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
		const blocks = Array.from(node.querySelectorAll(".blocks input")).map((input) => input.value.trim()).filter(Boolean);
		if (blocks.length) body.blocks = blocks;
		if (node.dataset.step === "pick") body.ids = tickedInReport();
		return body;
	}

	async function answer(body) {
		try {
			state.dialog = await post("/api/dialog/answer", body);
			render();
		} catch (error) {
			if (error.status === 409) toast("A job is still running. Wait for it, or press Stop in its progress box.");
			else toast(error.message);
		}
	}

	$("composer").addEventListener("submit", (event) => {
		event.preventDefault();
		const text = $("input").value.trim();
		if (!text) return;
		$("input").value = "";
		answer({ text, ...collect(currentQuestion()) });
	});

	$("thread").addEventListener("click", (event) => {
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
			post("/api/reveal", { stage: folder.dataset.folder }).then((r) => toast(`Opened ${r.opened} in the file manager.`)).catch((error) => toast(error.message));
			return;
		}
		const stop = event.target.closest(".stop-job");
		if (stop) {
			event.preventDefault();
			post("/api/jobs/cancel").catch(() => {});
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
		$("ticked").textContent = "";
		if (!state.panelClosedByUser) shell.classList.remove("no-report");
	}
	/** A PDF at a page: the viewer inside the frame follows the fragment
	 * (#page=..&search=..); a fragment-only change navigates in place. */
	function showPdf(rawHref) {
		// pagemode=none keeps the viewer's sidebar (thumbnails, outline)
		// closed, so the page itself gets the width; viewers without the
		// parameter ignore it.
		const href = /pagemode=/.test(rawHref) ? rawHref : `${rawHref}${rawHref.includes("#") ? "&" : "#"}pagemode=none`;
		const name = decodeURIComponent(href.replace(/^\/pdf\//, "").replace(/#.*$/, ""));
		const current = (frame.getAttribute("src") || "").replace(/#.*$/, "");
		const next = href.replace(/#.*$/, "");
		state.report = { url: href, name };
		frame.hidden = false;
		$("report-empty").hidden = true;
		$("report-name").textContent = name;
		$("ticked").textContent = "";
		if (current === next) {
			try { frame.contentWindow.location.replace(href); } catch { frame.src = href; }
		} else {
			frame.src = href;
		}
		shell.classList.remove("no-report");
		setPopup(false);
	}
	function setPopup(on) {
		reportBox.classList.toggle("popup", on);
		$("backdrop").hidden = !on;
		$("btn-enlarge").title = on ? "Shrink beside the chat (Esc)" : "Enlarge over the page";
		if (on) shell.classList.remove("no-report");
	}
	$("btn-enlarge").addEventListener("click", () => setPopup(!reportBox.classList.contains("popup")));
	$("backdrop").addEventListener("click", () => setPopup(false));
	document.addEventListener("keydown", (event) => { if (event.key === "Escape" && reportBox.classList.contains("popup")) setPopup(false); });
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
		// A local server that does not answer turns its dot red (the server
		// probes 127.0.0.1 addresses on every state read); remote services
		// are not probed.
		const dot = (reachable) => `<span class="dot ${reachable === false ? "bad" : ""}"></span>`;
		const down = (reachable, what) => (reachable === false ? ` <span class="down">-- not running: start ${what} first</span>` : "");
		$("status").innerHTML = p.model
			? `${dot(p.modelReachable)}model <b>${esc(p.model)}</b> ${esc(p.via)}${p.remote ? " (remote service)" : p.remote === false ? ", local" : ""}${down(p.modelReachable, "the model server")}<br>${dot(p.embeddingsReachable)}embeddings <b>${esc(p.embeddings)}</b>, ${esc(p.embeddingsVia)}${down(p.embeddingsReachable, "the embedding server")}`
			: `<span class="dot bad"></span>no model selected ${p.kind === "pi" ? "(choose one with /model in pi)" : "(set the generation model in Settings)"}<br>${dot(p.embeddingsReachable)}embeddings <b>${esc(p.embeddings)}</b>${down(p.embeddingsReachable, "the embedding server")}`;
		$("cnt-reports").textContent = String(info.counts.runs + info.counts.reports);
		$("cnt-pdfs").textContent = String(info.counts.pdfs);
	}

	async function loadReports() {
		const box = $("rail-reports-list");
		try {
			const data = await get("/api/runs");
			const short = (name) => name.replace(/^(\d{4})-(\d{2})-(\d{2})_/, "$2-$3 ").replace(/_/g, " ");
			const runs = data.runs.filter((run) => run.htmlUrl).map((run) => `<a class="item" data-url="${esc(run.htmlUrl)}" data-name="${esc(run.name)}.html" title="${esc(run.query)} · ${run.included} included">${esc(short(run.name))}</a>`).join("");
			const reports = data.reports.filter((report) => report.htmlUrl).map((report) => `<a class="item" data-url="${esc(report.htmlUrl)}" data-name="${esc(report.name)}.html" title="${esc(report.kind)}">${esc(short(report.name))}</a>`).join("");
			box.innerHTML = `<div class="sub">lit-search/</div>${runs || '<div class="rail-note">no search reports yet</div>'}<div class="sub">lit-synthesis/</div>${reports || '<div class="rail-note">no synthesis reports yet</div>'}`;
		} catch (error) {
			box.innerHTML = `<div class="rail-note">${esc(error.message)}</div>`;
		}
	}

	async function loadLibrary() {
		const box = $("rail-library-list");
		try {
			const data = await get("/api/library");
			$("rail-library-dirs").textContent = `${(data.dirs || []).join(", ") || "lit-selection/"} · rescanned on open`;
			box.innerHTML = data.papers.map((paper) => `<a class="item" data-url="${esc(paper.pdfUrl)}" data-name="${esc(paper.base)}.pdf" title="${esc(paper.title || paper.base)}${paper.index ? ` · indexed (${paper.index.chunks} passages)` : " · not indexed yet"}">${esc(paper.year || "n.d.")} ${esc(authorsShort(paper.authors))}${paper.authors && paper.authors.length ? " · " : ""}${esc(paper.title || paper.base)}</a>`).join("")
				|| '<div class="rail-note">no PDFs yet</div>';
			$("cnt-pdfs").textContent = String(data.papers.length);
		} catch (error) {
			box.innerHTML = `<div class="rail-note">${esc(error.message)}</div>`;
		}
	}
	/** Saved conversations (JSON files in the history folder, see
	 * src/web/history.ts): this data folder first, other folders collapsed.
	 * Name from the request or question ("Search: ...", "Report: ...",
	 * "Chat: ..."), the start time small below; the current one is marked. */
	async function loadHistory() {
		const box = $("rail-history-list");
		try {
			const data = await get("/api/history");
			$("cnt-history").textContent = data.history.length ? String(data.history.length) : "";
			const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); };
			const trash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
			const item = (entry) => `<a class="item past ${entry.current ? "current" : ""}" data-history="${esc(entry.id)}" title="${entry.current ? "the current conversation" : "click to continue this conversation"} · ${entry.steps} step${entry.steps === 1 ? "" : "s"}${entry.here ? "" : ` · data folder ${esc(entry.root)}`}"><span>${esc(entry.title)}</span><small>${esc(when(entry.started))}</small><button type="button" class="trash" data-del="${esc(entry.id)}" title="Delete this conversation" aria-label="Delete">${trash}</button></a>`;
			const here = data.history.filter((entry) => entry.here);
			const other = data.history.filter((entry) => !entry.here);
			box.innerHTML = (here.map(item).join("") || '<div class="rail-note">no saved conversations for this data folder</div>')
				+ (other.length ? `<details class="other"><summary>other data folders (${other.length})</summary>${other.map(item).join("")}</details>` : "")
				+ (data.skipped ? `<div class="rail-note">${data.skipped} unreadable file${data.skipped === 1 ? "" : "s"} skipped in ${esc(data.dir)}</div>` : "");
		} catch (error) {
			box.innerHTML = `<div class="rail-note">${esc(error.message)}</div>`;
		}
	}
	$("rail-history").addEventListener("toggle", () => { if ($("rail-history").open) loadHistory(); });
	$("rail-reports").addEventListener("toggle", () => { if ($("rail-reports").open) loadReports(); });
	$("rail-library").addEventListener("toggle", () => { if ($("rail-library").open) loadLibrary(); });
	document.querySelector(".rail").addEventListener("click", async (event) => {
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
				if (view.otherRoot) toast(`This conversation belongs to another data folder: ${view.otherRoot}. Its reports and PDFs are there.`);
			} catch (error) { toast(error.message); }
			return;
		}
		const item = event.target.closest("a.item[data-url]");
		if (!item) return;
		event.preventDefault();
		state.panelClosedByUser = false;
		if (/^\/pdf\//.test(item.dataset.url)) showPdf(item.dataset.url);
		else showReport(item.dataset.url, item.dataset.name);
	});

	// The stages are buttons: switch within the same conversation.
	for (const [n, chip] of [[1, "goSearch"], [2, "goSelection"], [3, "goSynthesis"]]) {
		const el = $(`stage-${n}`);
		el.title = `Switch to ${el.querySelector("div").firstChild.textContent.trim()}`;
		el.addEventListener("click", () => answer({ chip }));
	}
	// "+": the current conversation moves to History, an empty one starts.
	$("btn-new").addEventListener("click", async () => {
		try { state.dialog = await post("/api/dialog/new"); render(); loadHistory(); } catch (error) { toast(error.message); }
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
			if (job.state !== "running") { loadState(); if ($("rail-library").open) loadLibrary(); if ($("rail-reports").open) loadReports(); }
		});
		source.addEventListener("dialog", (event) => {
			state.dialog = JSON.parse(event.data);
			render();
			if ($("rail-history").open) loadHistory();
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
	$("btn-settings").addEventListener("click", async () => { $("set-error").textContent = ""; await loadSettings(); $("settings").showModal(); });
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
	$("btn-settings-save").addEventListener("click", async () => {
		$("set-error").textContent = "";
		try {
			await post("/api/settings", {
				mailto: $("set-mailto").value,
				codeListTopics: $("set-topics").value.split(",").map((t) => t.trim()).filter(Boolean),
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
	};

	/* ---------------- start ---------------- */
	(async () => {
		await loadState();
		loadHistory();
		try { state.dialog = await get("/api/dialog"); render(); } catch (error) { toast(error.message); }
		setTimeout(connectEvents, 50);
	})();
})();
