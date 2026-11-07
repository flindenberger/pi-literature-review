/**
 * Privacy guard of the browser demo: every web address written in the code
 * the demo ships must be on a fixed list, sorted by what happens with it.
 * A new address (an analytics snippet, a font or script service, a new API)
 * fails this test until it is added here on purpose -- the demo promises
 * "no tracking, nothing collected", and this keeps the promise checkable.
 * Also: no page loads a script, style or font from another site.
 *
 * Scanned: every package module the demo server reaches, the demo runtime,
 * and the interface files. Not scanned: pdf.js (static/pdfjs.mjs, copied
 * from the unpdf package at build time), which reads only the PDF it is
 * given; its text holds XML namespace names, not requests.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleGraph } from "./demo-build.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** Services the demo itself asks, from the visitor's browser. */
const REQUESTED = new Set([
	"api.openalex.org", // search, enrichment, author and journal lists
	"api.crossref.org", // search, code/data relations
	"api.datacite.org", // code/data relations of DataCite DOIs
	"doi.org", // DOI check through the handle API (and DOI links)
	"api.github.com", // papers with code: repository search
	"raw.githubusercontent.com", // papers with code: README text
	"huggingface.co", // papers with code: Hugging Face Papers
	"awesome.ecosyste.ms", // papers with code: awesome lists
	"repos.ecosyste.ms", // papers with code: repository dates
	"pub.orcid.org", // author window: current employment
]);

/** In the shared code, never asked by the demo: arXiv sends no header
 * that lets a web page read it (skipped in a browser), Semantic Scholar
 * runs only with a key, Unpaywall only for downloads (installed version). */
const INSTALLED_ONLY = new Set(["export.arxiv.org", "api.semanticscholar.org", "api.unpaywall.org"]);

/** Links shown to the reader, opened only by a click. */
const LINKS = new Set([
	"github.com", "arxiv.org", "openalex.org", "orcid.org", "www.semanticscholar.org",
	"www.npmjs.com", "nodejs.org", "pi.dev", "en.wikipedia.org",
]);

/** Not network addresses: local model servers in settings text, examples
 * in comments, the SVG namespace. */
const NOT_REQUESTS = new Set(["127.0.0.1", "localhost", "example.com", "foo.bar", "www.w3.org"]);

const files = [
	...moduleGraph(join(HERE, "demo", "worker.ts")),
	...readdirSync(join(HERE, "demo", "runtime"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name)),
	...readdirSync(join(HERE, "static")).filter((name) => name !== "pdfjs.mjs").map((name) => join(HERE, "static", name)),
];
assert.ok(files.length > 50, "the scan reaches the demo's modules");

const unknown = new Map<string, string>();
for (const file of files) {
	const text = readFileSync(file, "utf8");
	for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+[a-z0-9])/gi)) {
		const host = match[1].toLowerCase();
		if (REQUESTED.has(host) || INSTALLED_ONLY.has(host) || LINKS.has(host) || NOT_REQUESTS.has(host)) continue;
		if (!unknown.has(host)) unknown.set(host, file.slice(file.indexOf("src/")));
	}
	// No page pulls code, styles or fonts from elsewhere.
	if (/\.html$/.test(file)) {
		assert.doesNotMatch(text, /<script[^>]+src=["']https?:/i, `${file}: external script`);
		assert.doesNotMatch(text, /<link[^>]+href=["']https?:/i, `${file}: external stylesheet or font`);
		assert.doesNotMatch(text, /@import\s+url\(["']?https?:/i, `${file}: external import`);
	}
}
assert.deepEqual([...unknown.entries()].map(([host, file]) => `${host} (${file})`), [], "an address the demo's privacy list does not know: add it on purpose, or remove it");

console.log("demo-hosts.test.ts: all assertions passed");
