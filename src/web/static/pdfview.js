/**
 * The interface's own PDF viewer: pages and their text layer drawn with
 * the pdf.js build the package already ships (unpdf), so a cited passage
 * is highlighted the same way in every browser -- Chromium's built-in
 * viewer ignores #search. Address: pdfview.html?file=/pdf/<name>#page=N
 * &search=<phrase>; a changed fragment moves to the page and highlights
 * in place. The passage is found with the engine's own matching rules
 * (pdfjs-find.mjs, generated from src/pdfjs-find.ts).
 */

import * as pdfjs from "./pdfjs.mjs";
import { pdfjsNormalizeMapped, pdfjsQueryRegExp, sumPrecise } from "./pdfjs-find.mjs";

// pdf.js parses fonts with Math.sumPrecise; older browsers lack it.
if (typeof Math.sumPrecise !== "function") Math.sumPrecise = sumPrecise;

const $ = (id) => document.getElementById(id);
const scroller = $("scroller"), pagesBox = $("pages");
const file = new URLSearchParams(location.search).get("file") || "";
/** The interface's mount path ("" at the root, the demo's folder below one). */
const BASE = location.pathname.replace(/\/static\/[^/]*$/, "");
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const state = { doc: null, pages: [], fit: true, zoom: 1, base: 1, marked: [] };

function hashParams() {
	const out = new URLSearchParams(location.hash.slice(1));
	return { page: Math.max(1, Number.parseInt(out.get("page") || "1", 10) || 1), search: out.get("search") || "" };
}

function message(text) {
	pagesBox.innerHTML = "";
	const box = document.createElement("div");
	box.className = "msg";
	box.textContent = text;
	pagesBox.appendChild(box);
}

/** Scale of the page boxes: the width fit times the zoom. */
function scale() {
	return state.base * state.zoom;
}

function fitBase() {
	const first = state.pages[0];
	if (!first) return 1;
	const width = Math.max(200, scroller.clientWidth - 24);
	return width / first.width;
}

function sizePages() {
	const s = scale();
	for (const page of state.pages) {
		page.div.style.width = `${Math.floor(page.width * s)}px`;
		page.div.style.height = `${Math.floor(page.height * s)}px`;
		page.div.style.setProperty("--scale-factor", String(s));
		if (page.scale !== s) { page.scale = 0; page.rendered = null; page.div.replaceChildren(); }
	}
	$("zoom").textContent = `${Math.round(state.zoom * 100)}%`;
	// Pages already in view report again and are drawn at the new scale.
	for (const page of state.pages) { observer.unobserve(page.div); observer.observe(page.div); }
}

/** Draw one page (canvas + text layer) at the current scale, once. */
function renderPage(page) {
	const s = scale();
	if (page.rendered && page.scale === s) return page.rendered;
	page.scale = s;
	page.rendered = (async () => {
		const proxy = await state.doc.getPage(page.number);
		const viewport = proxy.getViewport({ scale: s });
		const ratio = window.devicePixelRatio || 1;
		const canvas = document.createElement("canvas");
		canvas.width = Math.floor(viewport.width * ratio);
		canvas.height = Math.floor(viewport.height * ratio);
		const layer = document.createElement("div");
		layer.className = "textLayer";
		page.div.replaceChildren(canvas, layer);
		await proxy.render({ canvasContext: canvas.getContext("2d"), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise;
		// The same text the passage was checked against: not normalized,
		// joined without separators, a line break per hasEOL item.
		const content = await proxy.getTextContent({ disableNormalization: true });
		const textLayer = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
		await textLayer.render();
		page.items = content.items.filter((item) => typeof item.str === "string");
		page.divs = textLayer.textDivs;
		return page;
	})().catch((error) => { page.rendered = null; throw error; });
	return page.rendered;
}

const observer = new IntersectionObserver((entries) => {
	for (const entry of entries) {
		if (!entry.isIntersecting) continue;
		const page = state.pages[Number(entry.target.dataset.number) - 1];
		if (page) renderPage(page).catch(() => {});
	}
}, { root: scroller, rootMargin: "800px 0px" });

function clearMarks() {
	for (const { div, text } of state.marked) div.textContent = text;
	state.marked = [];
}

/** Highlight the phrase on one page; returns the first marked element. */
async function markOnPage(number, phrase) {
	const page = state.pages[number - 1];
	if (!page || !phrase) return null;
	await renderPage(page);
	const starts = [];
	let raw = "";
	page.items.forEach((item) => {
		starts.push(raw.length);
		raw += item.str;
		if (item.hasEOL) raw += "\n";
	});
	const { text, source } = pdfjsNormalizeMapped(raw);
	const regexp = pdfjsQueryRegExp(phrase);
	if (!regexp) return null;
	regexp.lastIndex = 0;
	const match = regexp.exec(text);
	if (!match || !match[0].length) return null;
	const from = source[match.index];
	const to = source[match.index + match[0].length - 1] + 1;
	let first = null;
	page.items.forEach((item, index) => {
		const start = starts[index], end = start + item.str.length;
		if (end <= from || start >= to || !item.str) return;
		const div = page.divs[index];
		if (!div) return;
		const a = Math.max(0, from - start), b = Math.min(item.str.length, to - start);
		state.marked.push({ div, text: item.str });
		const mark = document.createElement("span");
		mark.className = "hl";
		mark.textContent = item.str.slice(a, b);
		div.replaceChildren(document.createTextNode(item.str.slice(0, a)), mark, document.createTextNode(item.str.slice(b)));
		first = first || mark;
	});
	return first;
}

/** Follow the fragment: go to the page, highlight the passage on it. */
async function follow() {
	if (!state.doc) return;
	const { page, search } = hashParams();
	const number = Math.min(page, state.pages.length);
	clearMarks();
	const target = state.pages[number - 1];
	if (!target) return;
	scroller.scrollTop = target.div.offsetTop - 8;
	$("page").value = String(number);
	let mark = null;
	try { mark = await markOnPage(number, search); } catch { mark = null; }
	// No grey hint lines in the interface: the page field says it.
	$("page").title = search && !mark ? "The cited passage was not found on this page; the page is shown." : "";
	if (mark) {
		const box = mark.getBoundingClientRect(), view = scroller.getBoundingClientRect();
		scroller.scrollTop += box.top - view.top - view.height / 3;
	}
}

function currentPage() {
	const top = scroller.scrollTop + scroller.clientHeight / 3;
	let current = 1;
	for (const page of state.pages) if (page.div.offsetTop <= top) current = page.number;
	return current;
}

function rescale(apply) {
	const keep = currentPage();
	const offset = scroller.scrollTop - (state.pages[keep - 1]?.div.offsetTop ?? 0);
	const before = scale();
	apply();
	clearMarks();
	sizePages();
	const after = scale();
	scroller.scrollTop = (state.pages[keep - 1]?.div.offsetTop ?? 0) + offset * (after / before);
	// The highlight comes back with the page's new text layer.
	const { page, search } = hashParams();
	if (search && state.pages[page - 1]) markOnPage(page, search).catch(() => {});
}

async function open() {
	if (!/^\/pdf\//.test(BASE && file.startsWith(`${BASE}/`) ? file.slice(BASE.length) : file)) { message("No PDF given."); return; }
	try {
		state.doc = await pdfjs.getDocument({ url: file, verbosity: 0 }).promise;
	} catch (error) {
		message(`This PDF could not be opened (${error && error.message ? error.message : error}).`);
		return;
	}
	document.title = decodeURIComponent(file.split("/").pop() || "PDF");
	pagesBox.replaceChildren();
	for (let number = 1; number <= state.doc.numPages; number++) {
		const proxy = await state.doc.getPage(number);
		const view = proxy.getViewport({ scale: 1 });
		const div = document.createElement("div");
		div.className = "page";
		div.dataset.number = String(number);
		pagesBox.appendChild(div);
		state.pages.push({ number, div, width: view.width, height: view.height, scale: 0, rendered: null, items: [], divs: [] });
		observer.observe(div);
	}
	$("of").textContent = `/ ${state.doc.numPages}`;
	state.base = fitBase();
	sizePages();
	await follow();
}

addEventListener("hashchange", () => { follow(); });
let resizeTimer = 0;
addEventListener("resize", () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(() => { if (state.fit && state.doc) rescale(() => { state.base = fitBase(); }); }, 150);
});
scroller.addEventListener("scroll", () => { if (document.activeElement !== $("page")) $("page").value = String(currentPage()); });
const step = (direction) => {
	const index = ZOOMS.findIndex((value) => value >= state.zoom - 0.001);
	const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (index < 0 ? ZOOMS.length - 1 : index) + direction))];
	rescale(() => { state.zoom = next; });
};
$("zoom-in").addEventListener("click", () => step(1));
$("zoom-out").addEventListener("click", () => step(-1));
$("zoom-fit").addEventListener("click", () => rescale(() => { state.zoom = 1; state.fit = true; state.base = fitBase(); }));
$("page").addEventListener("keydown", (event) => {
	if (event.key !== "Enter") return;
	const number = Math.min(state.pages.length, Math.max(1, Number.parseInt($("page").value, 10) || 1));
	const page = state.pages[number - 1];
	if (page) scroller.scrollTop = page.div.offsetTop - 8;
	$("page").blur();
});

/* ---------------- clips and quotes for the notepad ---------------- */
// The notepad (notes.js, in the parent page) calls window.plrViewer:
// clip() waits for a rectangle dragged over one page and returns it as a
// PNG drawn anew from the PDF (sharp at any zoom); selection() returns the
// selected text and its page.
/** Pixels per PDF point of a clip (3 = 216 dpi), capped by CLIP_MAX_PX. */
const CLIP_SCALE = 3;
const CLIP_MAX_PX = 4000;
let clipJob = null;

function endClip(result) {
	if (!clipJob) return;
	const { resolve, box } = clipJob;
	clipJob = null;
	document.body.classList.remove("clipping");
	if (box) box.remove();
	resolve(result);
}

async function clipImage(page, x, y, width, height) {
	const s = page.scale || scale();
	const proxy = await state.doc.getPage(page.number);
	const factor = Math.min(CLIP_SCALE, CLIP_MAX_PX / (Math.max(width, height) / s));
	const viewport = proxy.getViewport({ scale: factor });
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round((width / s) * factor));
	canvas.height = Math.max(1, Math.round((height / s) * factor));
	const context = canvas.getContext("2d");
	context.fillStyle = "#fff";
	context.fillRect(0, 0, canvas.width, canvas.height);
	await proxy.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, -(x / s) * factor, -(y / s) * factor] }).promise;
	return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"));
}

pagesBox.addEventListener("pointerdown", (event) => {
	if (!clipJob || event.button !== 0) return;
	const div = event.target.closest(".page");
	if (!div) return;
	event.preventDefault();
	const page = state.pages[Number(div.dataset.number) - 1];
	const origin = div.getBoundingClientRect();
	const start = { x: event.clientX - origin.left, y: event.clientY - origin.top };
	const box = document.createElement("div");
	box.className = "cliprect";
	div.appendChild(box);
	clipJob.box = box;
	const clamp = (value, max) => Math.max(0, Math.min(max, value));
	let rect = { x: start.x, y: start.y, width: 0, height: 0 };
	const move = (moved) => {
		const x = clamp(moved.clientX - origin.left, origin.width), y = clamp(moved.clientY - origin.top, origin.height);
		rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
		Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
	};
	const up = async () => {
		removeEventListener("pointermove", move);
		removeEventListener("pointerup", up);
		if (!clipJob) return;
		// A click without a drag: try again.
		if (rect.width < 8 || rect.height < 8) { box.remove(); clipJob.box = null; return; }
		try {
			const blob = await clipImage(page, rect.x, rect.y, rect.width, rect.height);
			endClip({ blob, page: page.number });
		} catch (error) {
			const job = clipJob;
			endClip(null);
			if (job) job.reject(error);
		}
	};
	addEventListener("pointermove", move);
	addEventListener("pointerup", up);
});
addEventListener("keydown", (event) => { if (event.key === "Escape") endClip(null); });

window.plrViewer = {
	clip() {
		endClip(null);
		return new Promise((resolve, reject) => {
			clipJob = { resolve, reject, box: null };
			document.body.classList.add("clipping");
		});
	},
	cancelClip() { endClip(null); },
	selection() {
		const selected = getSelection();
		const text = selected ? selected.toString() : "";
		if (!text.trim() || !selected.anchorNode) return null;
		const anchor = selected.anchorNode.nodeType === 1 ? selected.anchorNode : selected.anchorNode.parentElement;
		const div = anchor && anchor.closest(".page");
		return {
			// Lines joined; a word split by a hyphen at a line end is joined again.
			text: text.replace(/-\s*\n\s*(?=\p{Ll})/gu, "").replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim(),
			page: div ? Number(div.dataset.number) : currentPage(),
		};
	},
};

open();
