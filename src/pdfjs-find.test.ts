/**
 * Offline tests for the pdf.js find replica (viewerPageTexts needs a real
 * PDF and is exercised by the live check, not here). Every expectation was
 * confirmed against the shipped viewer of Firefox 152 on 2026-07-27.
 */

import assert from "node:assert/strict";
import { NFKC_NORMALIZE_CHARS, pdfjsNormalize, pdfjsQueryRegExp, viewerFindsPhrase } from "./pdfjs-find.ts";

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

	// THE LIGATURE CASE (the 2026-07-27 field bug): the NFKC replacement of
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

console.log("pdfjs-find.test.ts: all assertions passed");
