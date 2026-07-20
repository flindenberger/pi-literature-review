/**
 * Offline tests for PDF text cleanup and chunking (pure functions only --
 * extractPdfPages needs a real PDF and is exercised by the CLI probe and
 * the live acceptance run, not here).
 */

import assert from "node:assert/strict";
import {
	CHUNK_OVERLAP_CHARS,
	CHUNK_TARGET_CHARS,
	chunkPages,
	cleanPageText,
	isExtractionUsable,
} from "./extract.ts";

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
	assert.ok(runt.every((c) => c.text.length >= 400 || runt.length === 1));
	assert.ok(runt[runt.length - 1].text.endsWith("Tiny tail."));

	// Chunks never span pages: two half-full pages stay two chunks.
	const twoPages = chunkPages(["Page one text. ".repeat(20).trim(), "Page two text. ".repeat(20).trim()]);
	assert.deepEqual(twoPages.map((c) => c.page), [1, 2]);

	// Custom options are honored (small target forces many chunks).
	const small = chunkPages([longPage], { targetChars: 200, minChars: 50, overlapChars: 30 });
	assert.ok(small.length > chunks.length);
}

console.log("extract.test.ts: all assertions passed");
