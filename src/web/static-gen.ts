/**
 * Generated browser copies of package modules the web pages share with the
 * engine. static/pdfjs-find.mjs is src/pdfjs-find.ts with its types
 * stripped, so the PDF viewer matches a cited passage with exactly the
 * rules the engine checked it against. static/notemd.mjs is src/notemd.ts
 * (paper notes as blocks and Markdown) for the notepad editor. web.test.ts
 * fails when a copy is stale; `node src/web/static-gen.ts` rewrites both.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PDFJS_FIND_SOURCE = join(HERE, "..", "pdfjs-find.ts");
export const PDFJS_FIND_COPY = join(HERE, "static", "pdfjs-find.mjs");

export const NOTEMD_SOURCE = join(HERE, "..", "notemd.ts");
export const NOTEMD_COPY = join(HERE, "static", "notemd.mjs");

/** The browser copy as it should read. */
export function pdfjsFindModule(): string {
	const stripped = stripTypeScriptTypes(readFileSync(PDFJS_FIND_SOURCE, "utf8"), { mode: "strip" });
	return `// GENERATED from src/pdfjs-find.ts by src/web/static-gen.ts -- do not edit.\n${stripped}`;
}

export function notemdModule(): string {
	const stripped = stripTypeScriptTypes(readFileSync(NOTEMD_SOURCE, "utf8"), { mode: "strip" });
	return `// GENERATED from src/notemd.ts by src/web/static-gen.ts -- do not edit.\n${stripped}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	writeFileSync(PDFJS_FIND_COPY, pdfjsFindModule());
	writeFileSync(NOTEMD_COPY, notemdModule());
	console.log(`wrote ${PDFJS_FIND_COPY} and ${NOTEMD_COPY}`);
}
