/**
 * Offline tests for PDF text cleanup and chunking (pure functions only --
 * extractPdfPages needs a real PDF and is exercised by the CLI probe and
 * the live acceptance run, not here).
 */

import assert from "node:assert/strict";
import {
	CHUNK_MIN_CHARS,
	CHUNK_OVERLAP_CHARS,
	CHUNK_TARGET_CHARS,
	chunkPages,
	cleanPageText,
	isExtractionUsable,
	PHRASE_MIN_WORDS,
	phraseOf,
	stripBibliography,
	verifiedPhraseWords,
} from "./extract.ts";
import { pdfjsNormalize } from "./pdfjs-find.ts";

/* ---------------- cleanPageText ---------------- */
{
	// Hyphenated line break with lowercase continuation joins the word.
	assert.equal(cleanPageText("was demon-\nstrated in"), "was demonstrated in");
	// Uppercase/digit continuation keeps the hyphen (name/code hyphens).
	assert.equal(cleanPageText("using Sentinel-\n2 imagery"), "using Sentinel-2 imagery");
	// Plain line breaks and whitespace runs collapse to single spaces.
	assert.equal(cleanPageText("one\ntwo   three\n four"), "one two three four");
	// Bare page-number lines are furniture and disappear.
	assert.equal(cleanPageText("text before\n2\ntext after"), "text before text after");
	// Numbers inside a sentence line are content, not furniture.
	assert.equal(cleanPageText("reduced to 68.1% of\n2 rivers"), "reduced to 68.1% of 2 rivers");
	assert.equal(cleanPageText("  \n \n"), "");
}

/* ---------------- isExtractionUsable ---------------- */
{
	assert.equal(isExtractionUsable([]), false);
	assert.equal(isExtractionUsable(["", ""]), false);
	// Scanned PDF: a stray watermark word per page is not a text layer.
	assert.equal(isExtractionUsable(Array(10).fill("draft")), false);
	// Normal paper: plenty of letters per page.
	assert.equal(isExtractionUsable(Array(3).fill("word ".repeat(100))), true);
	// Total gate: one short page alone is below 200 letters.
	assert.equal(isExtractionUsable(["only a few words here"]), false);
}

/* ---------------- chunkPages ---------------- */
{
	// Tiny page: one chunk, correct 1-based page attribution.
	const tiny = chunkPages(["First sentence. Second sentence."]);
	assert.equal(tiny.length, 1);
	assert.deepEqual(tiny[0], { page: 1, text: "First sentence. Second sentence." });

	// Empty pages produce no chunks but keep later page numbers exact.
	const sparse = chunkPages(["", "Content on page two."]);
	assert.equal(sparse.length, 1);
	assert.equal(sparse[0].page, 2);

	// Long page: chunks respect the target size and overlap.
	const sentence = "The river sandbar was observed in the Sentinel-2 scene from March. ";
	const longPage = sentence.repeat(60).trim(); // ~4000 chars
	const chunks = chunkPages([longPage]);
	assert.ok(chunks.length >= 2);
	for (const chunk of chunks) {
		assert.equal(chunk.page, 1);
		// Target plus one overlap tail is the hard ceiling.
		assert.ok(chunk.text.length <= CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS + 1);
	}
	// Overlap: the start of chunk 2 repeats the tail of chunk 1.
	const head = chunks[1].text.slice(0, 30);
	assert.ok(chunks[0].text.includes(head));
	// Nothing lost: every original sentence occurrence is covered.
	const combined = chunks.map((c) => c.text).join(" ");
	assert.ok(combined.includes(sentence.trim()));

	// Trailing fragment below the minimum merges into the previous chunk
	// instead of becoming a runt.
	const runt = chunkPages([`${"A long leading sentence that fills space. ".repeat(40).trim()} Tiny tail.`]);
	assert.ok(runt.every((c) => c.text.length >= CHUNK_MIN_CHARS || runt.length === 1));
	assert.ok(runt[runt.length - 1].text.endsWith("Tiny tail."));

	// Chunks never span pages: two half-full pages stay two chunks.
	const twoPages = chunkPages(["Page one text. ".repeat(20).trim(), "Page two text. ".repeat(20).trim()]);
	assert.deepEqual(twoPages.map((c) => c.page), [1, 2]);

	// Custom options are honored (small target forces many chunks).
	const small = chunkPages([longPage], { targetChars: 200, minChars: 50, overlapChars: 30 });
	assert.ok(small.length > chunks.length);
}

/* ---------------- stripBibliography ---------------- */
{
	const body = "Methods and results of the study are described here in detail. ".repeat(20);
	const refs = "Smith, J. (2020). A paper title. Journal 1, 1-10.\n".repeat(20);

	// Plain case: heading on its own line in the back half -> list removed,
	// page count preserved so page numbers stay exact.
	const plain = stripBibliography([body, `${body}\nReferences\n${refs}`, refs]);
	assert.equal(plain.pages.length, 3);
	assert.equal(plain.page, 2);
	assert.ok(plain.removed > 0);
	assert.ok(plain.pages[1].includes("Methods and results"));
	assert.equal(plain.pages[1].includes("Smith, J."), false);
	assert.equal(plain.pages[2].trim(), "");
	assert.equal(plain.pages[0], body); // untouched before the heading

	// Uppercase, numbered and German headings are the same case.
	for (const heading of ["REFERENCES", "5 References", "5. References", "Literaturverzeichnis", "Bibliography"]) {
		const cut = stripBibliography([body, `${body}\n${heading}\n${refs}`]);
		assert.equal(cut.page, 2, `heading "${heading}" must be recognised`);
	}

	// An appendix behind the list is content again and survives.
	const withAppendix = stripBibliography([body, body, `References\n${refs}`, `Appendix A\n${body}`]);
	assert.equal(withAppendix.page, 3);
	assert.equal(withAppendix.pages[2].includes("Smith, J."), false);
	assert.ok(withAppendix.pages[3].includes("Methods and results"));

	// What must NOT trigger: the word inside a sentence, a heading in the
	// front matter (table of contents), and a paper without any list.
	assert.equal(stripBibliography([`${body} See the references at the end.\n${body}`]).page, null);
	assert.equal(stripBibliography([`Contents\nReferences\n${body}`, body, body]).page, null);
	assert.equal(stripBibliography([body, body]).page, null);
	assert.equal(stripBibliography([]).removed, 0);

	// Guard: a "heading" that would swallow most of the paper is ignored.
	const swallowed = stripBibliography([body, "References\n" + body.repeat(3)]);
	assert.equal(swallowed.page, null);
	assert.equal(swallowed.removed, 0);
}

/* ---------------- verifiedPhraseWords / phraseOf ---------------- */
{
	// The page argument is the VIEWER's rendering (pdfjs-find), our chunk
	// text is the cleaned one -- these tests pin where the two agree.
	const raw = "Three stations employ Axis Q1645 LE cameras\nwith zoom lenses to optimize coverage.";
	const clean = cleanPageText(raw);
	const view = pdfjsNormalize(raw);
	assert.equal(verifiedPhraseWords(clean, view), clean.split(/\s+/).length);
	assert.equal(phraseOf(clean, verifiedPhraseWords(clean, view)), clean);

	// Hyphenated line break: both sides repair it, so the phrase runs on.
	const hyphenRaw = "The method was demon-\nstrated on four rivers in Saxony.";
	const hyphenClean = cleanPageText(hyphenRaw);
	const hyphenWords = verifiedPhraseWords(hyphenClean, pdfjsNormalize(hyphenRaw));
	assert.equal(hyphenWords, hyphenClean.split(/\s+/).length);
	assert.equal(phraseOf(hyphenClean, hyphenWords), hyphenClean);

	// A LIGATURE before the break defeats the viewer's repair while our
	// cleanup joins the word -- the divergence that made 6 of 344 excerpts
	// silently lose their highlight before the check became faithful. The
	// phrase now stops in front of the affected word.
	const ligatureRaw = "the water level was validated against oﬃ-\ncial gauge records";
	const ligatureClean = cleanPageText(ligatureRaw);
	const ligatureWords = verifiedPhraseWords(ligatureClean, pdfjsNormalize(ligatureRaw));
	assert.equal(ligatureWords, 6);
	assert.equal(phraseOf(ligatureClean, ligatureWords), "the water level was validated against");

	// Same divergence inside the first three words: no highlight at all,
	// rather than a phrase the viewer would fail to find.
	assert.equal(verifiedPhraseWords(cleanPageText("oﬃ-\ncial gauge records"), pdfjsNormalize("oﬃ-\ncial gauge records")), 0);

	// Page furniture is the other limit: WE drop a bare page-number line,
	// the viewer keeps it, so a phrase spanning it is honestly cut short.
	const furnitureRaw = "results are shown below\n7\nin Table 4 for all stations";
	const furnitureClean = cleanPageText(furnitureRaw);
	assert.equal(verifiedPhraseWords(furnitureClean, pdfjsNormalize(furnitureRaw)), 4);
	assert.equal(phraseOf(furnitureClean, 4), "results are shown below");

	// Nothing in common, too short, or no page text: honest zero, and the
	// caller falls back to the page link alone.
	assert.equal(verifiedPhraseWords("completely unrelated wording here", "other text"), 0);
	assert.equal(verifiedPhraseWords("two words", "two words"), 0); // below PHRASE_MIN_WORDS
	assert.equal(verifiedPhraseWords("some text here", ""), 0);
	assert.equal(phraseOf("some text here", 0), null);
	assert.equal(phraseOf("some text here", undefined), null);
	assert.equal(phraseOf("some text here", PHRASE_MIN_WORDS), "some text here");

	// The cap is honored (a long page must not produce an endless phrase).
	const long = "word ".repeat(50).trim();
	assert.equal(verifiedPhraseWords(long, long, 10), 10);
}

console.log("extract.test.ts: all assertions passed");
