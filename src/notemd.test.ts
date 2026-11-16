/** Offline tests for src/notemd.ts (paper notes as blocks and Markdown). */
import assert from "node:assert/strict";
import { type Block, blocksToHtml, inlinesToMd, noteToMarkdown, parseInlines, parseNote, safeHref } from "./notemd.ts";

// A note with every block kind survives Markdown and back unchanged.
const blocks: Block[] = [
	{ t: "h", level: 1, c: [{ text: "Method" }] },
	{ t: "p", c: [{ text: "Cameras at " }, { text: "four", b: true }, { text: " gauges, " }, { text: "every 15 min", i: true }, { text: "; model " }, { text: "U-Net", code: true }, { text: "." }] },
	{ t: "p", c: [{ text: "Line one\nline two with a_b and 3 * 4 and [x] and #1" }] },
	{ t: "h", level: 2, c: [{ text: "Accuracy" }] },
	{ t: "ul", items: [[{ text: "MAE 0.96 cm" }], [{ text: "both", b: true, i: true }]] },
	{ t: "ol", items: [[{ text: "first" }], [{ text: "second" }]] },
	{ t: "quote", c: [{ text: "Acquisition has operated continuously since late 2021. " }, { text: "Blanch et al. 2026, p. 4", href: "#page=4" }] },
	{ t: "img", src: "img/p4-1.png", alt: "Blanch et al. 2026, p. 4 [Fig. 2]", page: 4 },
	{ t: "img", src: "img/pasted 1.png", alt: "pasted" },
	{ t: "table", rows: [[[{ text: "Site" }], [{ text: "MAE" }]], [[{ text: "ELB" }], [{ text: "0.96 | cm" }]], [[{ text: "LAU" }], []], [[{ text: "a\\|b \\" }], [{ text: "x\\|y | z\\", code: true }]]] },
	{ t: "hr" },
	{ t: "p", c: [{ text: "See " }, { text: "the paper", href: "https://doi.org/10.5194/hess-30-797-2026" }, { text: " - done" }] },
	{ t: "p", c: [{ text: "- not a list, # not a heading" }] },
	{ t: "ul", items: [[{ text: "top" }], [{ text: "nested" }], [{ text: "deeper" }], [{ text: "back" }]], levels: [0, 1, 2, 0] },
	{ t: "ol", items: [[{ text: "one" }], [{ text: "one.a" }], [{ text: "one.b" }], [{ text: "two" }]], levels: [0, 1, 1, 0] },
	{ t: "p", c: [{ text: "indented twice" }], indent: 2 },
];
const meta = { paper: "Blanch_2026", doi: "10.5194/hess-30-797-2026", title: "AI image-based \"method\"", background: "grid" };
const markdown = noteToMarkdown(meta, blocks);
const parsed = parseNote(markdown);
assert.deepEqual(parsed.meta, meta);
assert.deepEqual(parsed.blocks, blocks);
// Writing again gives the same text (stable files, clean diffs).
assert.equal(noteToMarkdown(parsed.meta, parsed.blocks), markdown);
assert.match(markdown, /^---\npaper: "Blanch_2026"\n/);
assert.match(markdown, /\n!\[Blanch et al\. 2026, p\. 4 \\\[Fig\. 2\\\]\]\(img\/p4-1\.png "page 4"\)\n/);
assert.match(markdown, /\| ELB \| 0\.96 \\\| cm \|/);

// Nested lists and indents as written.
assert.match(markdown, /\n- top\n  - nested\n    - deeper\n- back\n/);
assert.match(markdown, /\n1\. one\n   1\. one\.a\n   2\. one\.b\n2\. two\n/);
assert.match(markdown, /\n\u2003\u2003\u2003\u2003indented twice\n$/);
assert.match(blocksToHtml([{ t: "ul", items: [[{ text: "a" }], [{ text: "b" }], [{ text: "c" }]], levels: [0, 1, 0] }]), /^<ul><li>a<ul><li>b<\/li><\/ul><\/li><li>c<\/li><\/ul>$/);
// A level never jumps more than one below the item before it.
assert.deepEqual(parseNote("- a\n      - b\n").blocks, [{ t: "ul", items: [[{ text: "a" }], [{ text: "b" }]], levels: [0, 1] }]);

// Spaces at a run's edge stay outside the emphasis markers.
assert.equal(inlinesToMd([{ text: "a " }, { text: " bold ", b: true }, { text: "b" }]), "a  **bold** b");

// Markdown written elsewhere (Obsidian, by hand) in the same subset.
const hand = parseNote("# Title\n\nSome *it* and __strong__ text\ncontinues here.\n\n* one\n* two\n\n> quoted\n> more\n\n1) a\n2) b\n");
assert.deepEqual(hand.meta, {});
assert.deepEqual(hand.blocks, [
	{ t: "h", level: 1, c: [{ text: "Title" }] },
	{ t: "p", c: [{ text: "Some " }, { text: "it", i: true }, { text: " and " }, { text: "strong", b: true }, { text: " text continues here." }] },
	{ t: "ul", items: [[{ text: "one" }], [{ text: "two" }]] },
	{ t: "quote", c: [{ text: "quoted more" }] },
	{ t: "ol", items: [[{ text: "a" }], [{ text: "b" }]] },
]);
// snake_case words keep their underscores.
assert.deepEqual(parseInlines("wl_opt and wl_ref"), [{ text: "wl_opt and wl_ref" }]);
// An empty note is an empty file body.
assert.equal(noteToMarkdown({}, []), "\n");
assert.deepEqual(parseNote("").blocks, []);

// HTML: escaped text, only safe links, figure with a page link.
const html = blocksToHtml([
	{ t: "p", c: [{ text: "<b>x</b>" }, { text: "bad", href: "javascript:alert(1)" }] },
	{ t: "img", src: "img/p4-1.png", alt: "Blanch et al. 2026, p. 4", page: 4 },
], (src) => `/notes/Blanch/${src}`);
assert.match(html, /<p>&lt;b&gt;x&lt;\/b&gt;bad<\/p>/);
assert.match(html, /<img src="\/notes\/Blanch\/img\/p4-1\.png"/);
assert.match(html, /<figcaption><a href="#page=4">Blanch et al\. 2026, p\. 4<\/a><\/figcaption>/);
assert.equal(safeHref("javascript:alert(1)"), null);
assert.equal(safeHref("#page=12"), "#page=12");

console.log("notemd ok");
