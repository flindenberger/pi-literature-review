/**
 * Offline tests for PDF adoption: the fixed-pattern identifier scan and
 * adoptUnmatched with fake IO/lookup deps. No filesystem, no network.
 */

import assert from "node:assert/strict";
import { type AdoptDeps, adoptUnmatched, findIdentifier, titleOnPages } from "./adopt.ts";
import type { SidecarEntry } from "./selection.ts";

/* ---------------- findIdentifier ---------------- */
{
	// arXiv watermark (as unpdf delivers it on page 1).
	assert.deepEqual(
		findIdentifier(["arXiv:2401.16393v1 [cs.CV] 26 Jan 2024 AMAZON'S 2023 DROUGHT ..."]),
		{ kind: "arxiv", id: "2401.16393v1" },
	);
	// DOI in a header/footer line; trailing punctuation stripped.
	assert.deepEqual(
		findIdentifier(["Remote Sens. 2021, 13, 1505. https://doi.org/10.3390/rs13081505."]),
		{ kind: "doi", id: "10.3390/rs13081505" },
	);
	// The arXiv watermark wins over a DOI on the same page (it is
	// unambiguously the paper's OWN identity).
	assert.deepEqual(
		findIdentifier(["arXiv:2401.16393 also cites doi 10.1234/other"]),
		{ kind: "arxiv", id: "2401.16393" },
	);
	// Page 2 is scanned when page 1 has nothing.
	assert.deepEqual(
		findIdentifier(["Title page without identifiers", "DOI: 10.1029/2020WR027786, published 2021"]),
		{ kind: "doi", id: "10.1029/2020WR027786" },
	);
	// Page 3+ is reference-list territory and deliberately ignored.
	assert.equal(findIdentifier(["clean", "clean", "10.1234/from-the-references"]), null);
	assert.equal(findIdentifier(["no identifiers here at all"]), null);
	assert.equal(findIdentifier([]), null);
	// Older Elsevier DOIs carry parentheses; the whole DOI is kept.
	assert.deepEqual(
		findIdentifier(["Journal of Hydrology 278 (2003) 17-38 doi:10.1016/S0022-1694(03)00129-X"]),
		{ kind: "doi", id: "10.1016/S0022-1694(03)00129-X" },
	);
	// A DOI printed inside parentheses keeps the closing bracket out.
	assert.deepEqual(
		findIdentifier(["(https://doi.org/10.1029/2020WR027786)."]),
		{ kind: "doi", id: "10.1029/2020WR027786" },
	);
}

/* ---------------- titleOnPages ---------------- */
{
	const pages = ["Evaluating the potential for measuring river dis-\ncharge from space David M. Bjerklie"];
	assert.equal(titleOnPages("Evaluating the potential for measuring river discharge from space", pages), true);
	assert.equal(titleOnPages("Chemical denudation and silicate weathering in Himalayan glacier basins", pages), false);
	// Most words present (formula in the title broke the exact match).
	assert.equal(titleOnPages("Evaluating the potential for measuring river discharge (Q) from space", pages), true);
	assert.equal(titleOnPages("", pages), false);
	// Page 3+ is not used for the check either.
	assert.equal(titleOnPages("Hidden title", ["a", "b", "Hidden title"]), false);
}

/* ---------------- adoptUnmatched ---------------- */

const vistulaEntry: SidecarEntry = {
	title: "Application of Satellite Sentinel-2 Images", pdf_url: "",
	doi: "10.3390/rs13081505", arxiv_id: "", authors: ["Anna Kryniecka"], year: "2021",
};

function makeDeps(pageByFile: Record<string, string[]>, overrides: Partial<AdoptDeps> = {}): {
	deps: AdoptDeps; twins: Array<{ path: string; doi: string; arxiv: string; via: string }>;
} {
	const twins: Array<{ path: string; doi: string; arxiv: string; via: string }> = [];
	const deps: AdoptDeps = {
		readPdf: (path) => new TextEncoder().encode(path),
		extract: async (bytes) => pageByFile[new TextDecoder().decode(bytes)] ?? [],
		lookupDoi: async (doi) => (doi === "10.3390/rs13081505" ? vistulaEntry : null),
		lookupArxiv: async (id) => (id.startsWith("2401.16393")
			? { title: "Amazon drought", pdf_url: "", doi: "", arxiv_id: "2401.16393v1", authors: ["F. Wagner"], year: "2024" }
			: null),
		saveMeta: (path, meta) => twins.push({ path, doi: meta.doi, arxiv: meta.arxiv_id, via: meta.via }),
		...overrides,
	};
	return { deps, twins };
}

// Success paths: DOI and arXiv PDFs both gain twins next to the PDF.
{
	const { deps, twins } = makeDeps({
		"/lib/vistula.pdf": ["header https://doi.org/10.3390/rs13081505 Application of Satellite Sentinel-2 Images"],
		"/lib/amazon.pdf": ["arXiv:2401.16393v1 [cs.CV] Amazon drought"],
	});
	const progress: string[] = [];
	const results = await adoptUnmatched(["vistula.pdf", "amazon.pdf"], "/lib", deps, (m) => progress.push(m));
	assert.deepEqual(results.map((r) => r.status), ["adopted", "adopted"]);
	assert.equal(twins.length, 2);
	assert.deepEqual(twins[0], { path: "/lib/vistula.json", doi: "10.3390/rs13081505", arxiv: "", via: "adopted" });
	assert.equal(twins[1].path, "/lib/amazon.json");
	assert.equal(twins[1].arxiv, "2401.16393v1"); // verbatim from the API record
	assert.ok(progress.some((m) => m.includes("found DOI 10.3390/rs13081505")));
}

// Honest failures: no identifier, unknown identifier, broken extraction.
{
	const { deps, twins } = makeDeps({
		"/lib/notes.pdf": ["personal notes, no identifiers"],
		"/lib/unknown.pdf": ["doi 10.9999/not-indexed-anywhere"],
	});
	const results = await adoptUnmatched(["notes.pdf", "unknown.pdf"], "/lib", deps);
	assert.equal(twins.length, 0);
	assert.equal(results[0].status, "no_identifier");
	assert.ok(results[0].detail.includes("first 2 pages"));
	assert.equal(results[1].status, "lookup_failed");
	assert.ok(results[1].detail.includes("not known to the OpenAlex API"));
}
{
	const { deps, twins } = makeDeps({}, {
		extract: async () => {
			throw new Error("bad xref");
		},
	});
	const results = await adoptUnmatched(["broken.pdf"], "/lib", deps);
	assert.equal(results[0].status, "no_identifier");
	assert.ok(results[0].detail.includes("bad xref"));
	assert.equal(twins.length, 0);
}

// A record whose title is not printed in the PDF is refused (an
// identifier that resolved to another work).
{
	const { deps, twins } = makeDeps({ "/lib/other.pdf": ["doi 10.3390/rs13081505 Some other paper entirely"] });
	const results = await adoptUnmatched(["other.pdf"], "/lib", deps);
	assert.equal(results[0].status, "lookup_failed");
	assert.ok(results[0].detail.includes("not printed in this PDF"));
	assert.equal(twins.length, 0);
}

// Lookup network errors are per-file failures, not run aborts; a user
// abort still throws.
{
	const { deps } = makeDeps({ "/lib/a.pdf": ["doi 10.3390/rs13081505"] }, {
		lookupDoi: async () => {
			throw new Error("OpenAlex answered HTTP 500");
		},
	});
	const results = await adoptUnmatched(["a.pdf"], "/lib", deps);
	assert.equal(results[0].status, "lookup_failed");
	assert.ok(results[0].detail.includes("HTTP 500"));
}
{
	const { deps } = makeDeps({});
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => adoptUnmatched(["a.pdf"], "/lib", deps, undefined, controller.signal),
		/aborted/,
	);
}

console.log("adopt.test.ts: all assertions passed");
