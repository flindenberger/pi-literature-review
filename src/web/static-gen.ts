/**
 * Generated browser copies of package modules the web pages share with the
 * engine. static/pdfjs-find.mjs is src/pdfjs-find.ts with its types
 * stripped, so the PDF viewer matches a cited passage with exactly the
 * rules the engine checked it against. web.test.ts fails when the copy is
 * stale; `node src/web/static-gen.ts` rewrites it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PDFJS_FIND_SOURCE = join(HERE, "..", "pdfjs-find.ts");
export const PDFJS_FIND_COPY = join(HERE, "static", "pdfjs-find.mjs");

/** The browser copy as it should read. */
export function pdfjsFindModule(): string {
	const stripped = stripTypeScriptTypes(readFileSync(PDFJS_FIND_SOURCE, "utf8"), { mode: "strip" });
	return `// GENERATED from src/pdfjs-find.ts by src/web/static-gen.ts -- do not edit.\n${stripped}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	writeFileSync(PDFJS_FIND_COPY, pdfjsFindModule());
	console.log(`wrote ${PDFJS_FIND_COPY}`);
}
