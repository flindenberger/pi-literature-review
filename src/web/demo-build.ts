/**
 * Build of the browser demo: the unchanged web interface with its server
 * running in the visitor's browser (src/web/demo/). No bundler: every
 * package module the demo server reaches is copied with its types removed
 * (Node's stripTypeScriptTypes), `.ts` imports point at `.js`, and Node's
 * modules point at the stand-ins in demo/runtime/shims. The result is a
 * folder of plain files for any static web host.
 *
 *   node src/web/demo-build.ts <out-dir> [--pdf-cache <dir>]
 *
 * The example paper chat (demo/example/*.json, from capture.ts) goes to
 * examples/; its PDF is fetched from the publisher's address recorded in
 * the example (an openly licensed paper; never committed) and must match
 * the recorded SHA-256, else the build stops. --pdf-cache keeps the
 * download between builds.
 *
 * Layout of <out-dir>: index.html (the interface page, started by
 * runtime/boot.js), sw.js (the Service Worker, at the root so its scope is
 * the whole demo), static/ (the interface files and pdf.js), runtime/
 * (boot, worker entry, shims), app/src/ (the converted package modules).
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const ENTRY = join(HERE, "demo", "worker.ts");

/** Module names outside the package and the stand-in that answers them. */
const SHIMS: Record<string, string> = {
	"node:fs": "fs.js",
	"node:path": "path.js",
	"node:crypto": "crypto.js",
	"node:http": "http.js",
	"node:os": "small.js",
	"node:url": "small.js",
	"node:child_process": "small.js",
	"fast-xml-parser": "small.js",
	unpdf: "small.js",
};

/** Import specifiers of one module: import/export statements (from the
 * line start to `from "..."`), side-effect imports, dynamic import(). */
const SPECIFIERS = [
	/^(\s*(?:import|export)\s[^;]*?\sfrom\s*)(["'])([^"']+)\2/gm,
	/^(\s*import\s*)(["'])([^"']+)\2/gm,
	/(\bimport\s*\(\s*)(["'])([^"']+)\2(?=\s*\))/g,
];

/** Every package module the entry reaches (relative imports only). */
export function moduleGraph(entry: string): string[] {
	const seen = new Set<string>();
	const visit = (file: string): void => {
		if (seen.has(file)) return;
		seen.add(file);
		const code = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
		for (const pattern of SPECIFIERS) {
			for (const match of code.matchAll(pattern)) {
				const name = match[3];
				if (name.startsWith(".")) visit(resolve(dirname(file), name));
			}
		}
	};
	visit(entry);
	return [...seen].sort();
}

/** One module for the browser: types removed, imports pointed at `.js`
 * files and stand-ins. `shimDir` is where the stand-ins lie relative to
 * the converted file. */
export function convertModule(code: string, shimDir: string): string {
	const plain = stripTypeScriptTypes(code, { mode: "strip" })
		// pdf.js is served as a static file in the demo; the server only
		// names it at start-up.
		.replace(/import\.meta\.resolve\(\s*["']unpdf\/pdfjs["']\s*\)/g, '"file:///static/pdfjs.mjs"');
	return SPECIFIERS.reduce((text, pattern) => text.replace(pattern, (whole, lead: string, quote: string, name: string) => {
		if (name.startsWith(".")) return `${lead}${quote}${name.replace(/\.ts$/, ".js")}${quote}`;
		if (name.startsWith(shimDir)) return whole;
		const shim = SHIMS[name];
		if (!shim) throw new Error(`no browser stand-in for "${name}"`);
		return `${lead}${quote}${shimDir}/${shim}${quote}`;
	}), plain);
}

/** The example's PDF: from the cache when its checksum fits, else
 * downloaded (no contact data sent) and checked. */
export async function examplePdf(example: { pdf: { name: string; url: string; sha256: string } }, cache: string | null): Promise<Buffer> {
	const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
	const cached = cache ? join(cache, example.pdf.name) : null;
	if (cached && existsSync(cached)) {
		const bytes = readFileSync(cached);
		if (sha(bytes) === example.pdf.sha256) return bytes;
	}
	const response = await fetch(example.pdf.url, { headers: { "User-Agent": "pi-literature-review demo build" } });
	if (!response.ok) throw new Error(`example PDF ${example.pdf.url}: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (sha(bytes) !== example.pdf.sha256) throw new Error(`example PDF ${example.pdf.url} changed (SHA-256 differs from the recording); record the example again`);
	if (cached) {
		mkdirSync(dirname(cached), { recursive: true });
		writeFileSync(cached, bytes);
	}
	return bytes;
}

/** Hex digest over the given texts: the build's version name. */
function contentHash(texts: string[]): string {
	const hash = createHash("sha256");
	for (const text of texts) hash.update(text).update("\0");
	return hash.digest("hex").slice(0, 12);
}

export async function buildDemo(out: string, pdfCache: string | null = null): Promise<{ modules: number; version: string }> {
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const runtime = join(HERE, "demo", "runtime");
	const modules = moduleGraph(ENTRY);
	const sources = modules.map((file) => readFileSync(file, "utf8"));
	const runtimeFiles = readdirSync(runtime, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
	// Code that changes per build lives below v/<hash>/ and the interface
	// files carry ?v=<hash>: GitHub Pages lets browsers keep files for ten
	// minutes, and a new build must never mix with an old one.
	const version = contentHash([...sources, ...runtimeFiles.map((file) => readFileSync(file, "utf8")), readFileSync(join(HERE, "static", "app.js"), "utf8"), readFileSync(join(HERE, "static", "style.css"), "utf8")]);
	const versioned = join(out, "v", version);
	for (const [i, file] of modules.entries()) {
		const target = join(versioned, "app", "src", relative(SRC, file)).replace(/\.ts$/, ".js");
		mkdirSync(dirname(target), { recursive: true });
		let shimDir = relative(dirname(target), join(versioned, "runtime", "shims")).split("\\").join("/");
		if (!shimDir.startsWith(".")) shimDir = `./${shimDir}`;
		writeFileSync(target, convertModule(sources[i], shimDir));
	}
	cpSync(join(HERE, "static"), join(out, "static"), { recursive: true });
	cpSync(fileURLToPath(import.meta.resolve("unpdf/pdfjs")), join(out, "static", "pdfjs.mjs"));
	cpSync(runtime, join(versioned, "runtime"), { recursive: true });
	rmSync(join(versioned, "runtime", "sw.js"));
	// The Service Worker stays at the root: its folder is its scope.
	cpSync(join(runtime, "sw.js"), join(out, "sw.js"));
	const page = readFileSync(join(HERE, "static", "index.html"), "utf8");
	const app = '<script src="static/app.js"></script>';
	const style = 'href="static/style.css"';
	if (!page.includes(app) || !page.includes(style)) throw new Error("static/index.html no longer loads static/app.js and static/style.css as expected");
	writeFileSync(join(out, "index.html"), page
		.replace(app, `<script src="v/${version}/runtime/boot.js" data-app="static/app.js?v=${version}"></script>`)
		.replace(style, `href="static/style.css?v=${version}"`));
	// The example paper chat and its PDF.
	const examples = join(HERE, "demo", "example");
	mkdirSync(join(out, "examples"), { recursive: true });
	for (const name of readdirSync(examples).filter((file) => file.endsWith(".json"))) {
		const text = readFileSync(join(examples, name), "utf8");
		writeFileSync(join(out, "examples", name), text);
		const example = JSON.parse(text) as { pdf: { name: string; url: string; sha256: string } };
		writeFileSync(join(out, "examples", example.pdf.name), await examplePdf(example, pdfCache));
	}
	// GitHub Pages: serve the files as they are (no Jekyll processing).
	writeFileSync(join(out, ".nojekyll"), "");
	return { modules: modules.length, version };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const out = process.argv[2];
	const cacheAt = process.argv.indexOf("--pdf-cache");
	if (!out || out.startsWith("--")) {
		process.stderr.write("usage: node src/web/demo-build.ts <out-dir> [--pdf-cache <dir>]\n");
		process.exit(2);
	}
	const { modules, version } = await buildDemo(resolve(out), cacheAt > 0 && process.argv[cacheAt + 1] ? resolve(process.argv[cacheAt + 1]) : null);
	const files = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((n, entry) => n + (entry.isDirectory() ? files(join(dir, entry.name)) : 1), 0);
	process.stdout.write(`demo built in ${resolve(out)}: ${modules} package modules, version ${version}, ${existsSync(out) ? files(resolve(out)) : 0} files\n`);
}
