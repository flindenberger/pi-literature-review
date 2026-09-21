/**
 * The one test that loads pdf.js: extracts src/fixtures/ligatures.pdf
 * (raw Type 1 font, LaTeX-style encoding, no ToUnicode map -- the shape of
 * real paper PDFs) through the real modules and pins that ligatures
 * survive and that pdf.js stays silent. This guards the dependency, not
 * our code: a pdf.js build that needs a newer runtime feature than the
 * installed Node offers fails its font parser and silently drops every
 * "fi" from the text (Math.sumPrecise, unpdf 1.8.0 on Node 24).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPdfPages } from "./extract.ts";
import { viewerFindsPhrase, viewerPageTexts } from "./pdfjs-find.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ligatures.pdf");
const bytes = new Uint8Array(readFileSync(fixture));

// pdf.js reports font trouble through console.log("Warning: ...") and
// console.warn; a silent run is part of the contract.
const printed: string[] = [];
const original = { log: console.log, warn: console.warn };
console.log = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
console.warn = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
let pages: string[];
let viewer: string[];
try {
	pages = await extractPdfPages(bytes);
	viewer = await viewerPageTexts(bytes);
} finally {
	console.log = original.log;
	console.warn = original.warn;
}

assert.equal(pages.length, 1);
const text = pages[0].replace(/\s+/g, " ");
for (const word of ["classification", "efficient", "workflow", "fits", "official", "specifications"]) {
	assert.ok(text.includes(word), `ligature lost: "${word}" missing in ${JSON.stringify(text)}`);
}
assert.ok(!/classi cation|ef cient|work ow/.test(text), `broken ligatures in ${JSON.stringify(text)}`);
assert.deepEqual(printed.filter((line) => /warning|error/i.test(line)), [], "pdf.js printed warnings");

// The viewer replica sees the same repaired text, so a highlight phrase
// built from the extraction really matches what a browser searches.
assert.equal(viewer.length, 1);
assert.ok(viewerFindsPhrase("river classification at sub-meter resolution is efficient", viewer[0]));

console.log("extract-pdf.test.ts: all assertions passed");
