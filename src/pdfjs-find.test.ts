/**
 * Offline tests for the pdf.js find replica (viewerPageTexts needs a real
 * PDF and is exercised by the live check, not here). Every expectation was
 * confirmed against the shipped viewer of Firefox 152.
 */

import assert from "node:assert/strict";
import { NFKC_NORMALIZE_CHARS, PDFJS_OPTIONS, pdfjsNormalize, pdfjsQueryRegExp, sumPrecise, viewerFindsPhrase } from "./pdfjs-find.ts";

/* ---------------- the character set ---------------- */
{
	// The guard against the transcription accident that once swallowed the
	// alphabet and produced a phantom bug.
	const set = new RegExp(`[${NFKC_NORMALIZE_CHARS}]`, "u");
	for (const letter of ["a", "s", "t", "z", "A", "Z", "0", "9", " ", "-"]) {
		assert.equal(set.test(letter), false, `plain "${letter}" must not be in the NFKC set`);
	}
	assert.ok(set.test(" ")); // non-breaking space is
	assert.ok(set.test("ﬁ")); // and so is the fi ligature
}

/* ---------------- normalize ---------------- */
{
	// End of line becomes a space.
	assert.equal(pdfjsNormalize("water\nlevel"), "water level");

	// A hyphen at a line break between lowercase letters joins the word.
	assert.equal(pdfjsNormalize("demon-\nstrated"), "demonstrated");
	assert.equal(pdfjsNormalize("Sta-\ntions"), "Stations");

	// THE LIGATURE CASE: the NFKC replacement of
	// "fi" is tried BEFORE the broken-word repair and consumes the letter
	// the repair needs -- so the word stays broken for the viewer, hyphen
	// and all. Our own extraction hides this by resolving the ligature
	// early, which is why the phrase check may not approximate this file.
	assert.equal(pdfjsNormalize("oﬃ-\ncial"), "offi- cial");

	// A dash before a line break that does NOT sit between letters keeps
	// the dash and loses only the break.
	assert.equal(pdfjsNormalize("Sentinel-\n2"), "Sentinel-2");

	// Typographic characters are mapped.
	assert.equal(pdfjsNormalize("“quoted”"), '"quoted"');
	assert.equal(pdfjsNormalize("½"), "1/2");
}

/* ---------------- query conversion ---------------- */
{
	// Whitespace matches one or more spaces; punctuation tolerates spaces
	// around it (that is what makes "offi- cial" findable as "offi- cial").
	assert.equal(pdfjsQueryRegExp("water level")!.source, "water[ ]+level");
	assert.ok(pdfjsQueryRegExp("wl_opt) and")!.source.includes("[ ]*"));
	assert.equal(pdfjsQueryRegExp(""), null);
	// Whitespace alone yields pdf.js's "any space" pattern rather than
	// nothing -- faithful to the original; phraseOf never emits such a
	// phrase, and viewerFindsPhrase rejects the empty string outright.
	assert.equal(pdfjsQueryRegExp("   ")!.source, "[ ]+");
}

/* ---------------- viewerFindsPhrase ---------------- */
{
	const page = pdfjsNormalize(
		"Three stations employ Axis Q1645 LE cameras\nwith zoom lenses to optimize\ncoverage of the river.",
	);
	// Crossing the line breaks is fine -- they are spaces to the viewer.
	assert.ok(viewerFindsPhrase("Axis Q1645 LE cameras with zoom lenses", page));
	// Whole page as one phrase.
	assert.ok(viewerFindsPhrase(page, page));
	// Case is ignored (the URL-hash search is case-insensitive).
	assert.ok(viewerFindsPhrase("THREE STATIONS EMPLOY", page));
	// Text that is not there stays not there.
	assert.equal(viewerFindsPhrase("Sentinel-2 imagery", page), false);
	assert.equal(viewerFindsPhrase("", page), false);
	assert.equal(viewerFindsPhrase("anything", ""), false);

	// A phrase our cleanup would produce from a ligature break is NOT
	// findable, while the viewer's own wording is -- the whole reason the
	// verification runs against viewer text.
	const ligature = pdfjsNormalize("validated against oﬃ-\ncial gauge records");
	assert.equal(viewerFindsPhrase("validated against official gauge records", ligature), false);
	assert.ok(viewerFindsPhrase("validated against offi- cial gauge records", ligature));
}

/* ---------------- Math.sumPrecise polyfill ---------------- */
{
	// pdf.js sums glyph byte sizes with it: integers must come back exact.
	assert.equal(sumPrecise([12, 40, 3, 1000]), 1055);
	assert.equal(sumPrecise(new Set([7])), 7);
	// Empty list is -0 as the proposal specifies (pdf.js may size an empty
	// glyph table with it; new ArrayBuffer(-0) is a zero-length buffer).
	assert.ok(Object.is(sumPrecise([]), -0));
	// Compensated: the naive float sum 0.1 + 0.2 + 0.3 is 0.6000000000000001.
	assert.equal(sumPrecise([0.1, 0.2, 0.3]), 0.6);
	assert.equal(sumPrecise([1e20, 1, -1e20]), 1);
	assert.throws(() => sumPrecise(["1" as unknown as number]), TypeError);
}

// pdf.js runs at "errors only": its font-repair warnings would otherwise
// print into pi's TUI (field case: "Warning: TT: undefined function: 3").
assert.equal(PDFJS_OPTIONS.verbosity, 0);

console.log("pdfjs-find.test.ts: all assertions passed");
