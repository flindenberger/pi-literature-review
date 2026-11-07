/* Browser demo: Node's node:fs over files held in memory. The server
   writes its history, search runs and reports here exactly as on disk;
   nothing leaves the visitor's browser. Files below /demo are mirrored
   into the browser's IndexedDB, so History survives a reload; they stay
   on this browser only. Only the calls the package uses. */

import { Buffer } from "./buffer.js";
import { dirname, normalize, resolve } from "./path.js";

/** path -> { dir: true } | { data: Buffer, mtime: number } */
const nodes = new Map([["/", { dir: true, mtime: Date.now() }]]);

function fsError(code, syscall, path) {
	const error = new Error(`${code}: ${syscall} '${path}'`);
	error.code = code;
	error.syscall = syscall;
	error.path = path;
	return error;
}

const key = (path) => normalize(resolve(String(path)));

/* ---- mirror into IndexedDB (one record per file below PERSIST_ROOT) ---- */
const PERSIST_ROOT = "/demo/";
const DB_NAME = "pi-literature-review-demo";
const STORE = "files";
let db = null;
const dirty = new Set();
let flushTimer = 0;

function openDb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function markDirty(path) {
	if (!db || !path.startsWith(PERSIST_ROOT)) return;
	dirty.add(path);
	clearTimeout(flushTimer);
	flushTimer = setTimeout(flush, 300);
}

function flush() {
	if (!db || !dirty.size) return;
	const paths = [...dirty];
	dirty.clear();
	const store = db.transaction(STORE, "readwrite").objectStore(STORE);
	for (const path of paths) {
		const node = nodes.get(path);
		if (node && !node.dir) store.put({ data: node.data, mtime: node.mtime }, path);
		else store.delete(path);
	}
}

/** Load the files kept from earlier visits (call once, before the server
 * starts); afterwards every change is mirrored. Without IndexedDB (a
 * private window that refuses it) the demo simply forgets on reload. */
export async function loadPersisted() {
	try {
		db = await openDb();
	} catch {
		db = null;
		return 0;
	}
	const entries = await new Promise((resolve, reject) => {
		const out = [];
		const request = db.transaction(STORE).objectStore(STORE).openCursor();
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return resolve(out);
			out.push([cursor.key, cursor.value]);
			cursor.continue();
		};
		request.onerror = () => reject(request.error);
	});
	for (const [path, value] of entries) {
		mkdirSync(dirname(path), { recursive: true });
		nodes.set(path, { data: Buffer.from(value.data), mtime: value.mtime });
	}
	return entries.length;
}

function ensureParent(path, syscall) {
	const parent = nodes.get(dirname(path));
	if (!parent) throw fsError("ENOENT", syscall, path);
	if (!parent.dir) throw fsError("ENOTDIR", syscall, path);
}

export function existsSync(path) {
	return nodes.has(key(path));
}

export function mkdirSync(path, options = {}) {
	const target = key(path);
	if (nodes.has(target)) {
		if (options.recursive) return undefined;
		throw fsError("EEXIST", "mkdir", target);
	}
	if (options.recursive) {
		let at = "";
		for (const part of target.split("/").filter(Boolean)) {
			at += `/${part}`;
			if (!nodes.has(at)) nodes.set(at, { dir: true, mtime: Date.now() });
		}
		return target;
	}
	ensureParent(target, "mkdir");
	nodes.set(target, { dir: true, mtime: Date.now() });
	return undefined;
}

export function mkdtempSync(prefix) {
	const path = `${key(prefix)}${Math.random().toString(36).slice(2, 8)}`;
	mkdirSync(path, { recursive: true });
	return path;
}

export function writeFileSync(path, data) {
	const target = key(path);
	ensureParent(target, "open");
	const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
	nodes.set(target, { data: bytes, mtime: Date.now() });
	markDirty(target);
}

export function readFileSync(path, options) {
	const target = key(path);
	const node = nodes.get(target);
	if (!node) throw fsError("ENOENT", "open", target);
	if (node.dir) throw fsError("EISDIR", "read", target);
	const encoding = typeof options === "string" ? options : options?.encoding;
	return encoding ? node.data.toString(encoding) : Buffer.from(node.data);
}

class Dirent {
	constructor(name, node) { this.name = name; this.node = node; }
	isFile() { return !this.node.dir; }
	isDirectory() { return Boolean(this.node.dir); }
	isSymbolicLink() { return false; }
}

export function readdirSync(path, options = {}) {
	const target = key(path);
	const node = nodes.get(target);
	if (!node) throw fsError("ENOENT", "scandir", target);
	if (!node.dir) throw fsError("ENOTDIR", "scandir", target);
	const prefix = target === "/" ? "/" : `${target}/`;
	const out = [];
	for (const [entry, child] of nodes) {
		if (entry === target || !entry.startsWith(prefix)) continue;
		const name = entry.slice(prefix.length);
		if (name.includes("/")) continue;
		out.push(options.withFileTypes ? new Dirent(name, child) : name);
	}
	return out.sort((a, b) => String(a.name ?? a).localeCompare(String(b.name ?? b)));
}

export function statSync(path, options = {}) {
	const target = key(path);
	const node = nodes.get(target);
	if (!node) {
		if (options.throwIfNoEntry === false) return undefined;
		throw fsError("ENOENT", "stat", target);
	}
	return {
		size: node.dir ? 0 : node.data.byteLength,
		mtimeMs: node.mtime,
		mtime: new Date(node.mtime),
		isFile: () => !node.dir,
		isDirectory: () => Boolean(node.dir),
		isSymbolicLink: () => false,
	};
}

export const lstatSync = statSync;

export function renameSync(from, to) {
	const source = key(from);
	const target = key(to);
	if (!nodes.has(source)) throw fsError("ENOENT", "rename", source);
	ensureParent(target, "rename");
	for (const [entry, node] of [...nodes]) {
		if (entry === source || entry.startsWith(`${source}/`)) {
			nodes.delete(entry);
			nodes.set(target + entry.slice(source.length), node);
			markDirty(entry);
			markDirty(target + entry.slice(source.length));
		}
	}
}

export function rmSync(path, options = {}) {
	const target = key(path);
	const node = nodes.get(target);
	if (!node) {
		if (options.force) return;
		throw fsError("ENOENT", "rm", target);
	}
	if (node.dir && !options.recursive && readdirSync(target).length) throw fsError("ENOTEMPTY", "rm", target);
	for (const entry of [...nodes.keys()]) {
		if (entry === target || entry.startsWith(`${target}/`)) {
			nodes.delete(entry);
			markDirty(entry);
		}
	}
}

export const unlinkSync = (path) => rmSync(path);

export function symlinkSync() {
	throw fsError("ENOSYS", "symlink", "");
}

/** Enough of a read stream for `createReadStream(file).pipe(res)`. */
export function createReadStream(path) {
	const data = readFileSync(path);
	return {
		pipe(destination) {
			destination.end(data);
			return destination;
		},
	};
}

export default { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, renameSync, rmSync, unlinkSync, symlinkSync, createReadStream };
