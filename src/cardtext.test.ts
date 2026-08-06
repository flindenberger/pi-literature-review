/**
 * Tests for the deterministic card-text formatting (bold segments +
 * bullet lines), mirroring render.ts strongHtml/bulletsHtml semantics.
 * Run: node src/cardtext.test.ts
 */

import assert from "node:assert/strict";
import { cardLine, cardSegments } from "./cardtext.ts";

// Plain text stays one plain segment.
assert.deepEqual(cardSegments("no markup here"), [{ text: "no markup here", bold: false }]);

// An empty line stays a single empty plain segment (the card keeps blank lines).
assert.deepEqual(cardSegments(""), [{ text: "", bold: false }]);

// **bold** splits into segments; surrounding text keeps its place.
assert.deepEqual(cardSegments("a **b** c"), [
	{ text: "a ", bold: false },
	{ text: "b", bold: true },
	{ text: " c", bold: false },
]);

// Multiple pairs in one line, including a trailing bold segment.
assert.deepEqual(cardSegments("**Ziel** und **Ansatz**"), [
	{ text: "Ziel", bold: true },
	{ text: " und ", bold: false },
	{ text: "Ansatz", bold: true },
]);

// A line that IS one bold pair (the typical **heading** line).
assert.deepEqual(cardSegments("**Validierung und Genauigkeit**"), [
	{ text: "Validierung und Genauigkeit", bold: true },
]);

// Unpaired/odd asterisks stay literal -- same as strongHtml.
assert.deepEqual(cardSegments("2 ** 3 stays"), [{ text: "2 ** 3 stays", bold: false }]);
assert.deepEqual(cardSegments("**unclosed"), [{ text: "**unclosed", bold: false }]);

// "* " and "- " bullet lines get the uniform "- " marker, indentation kept.
assert.deepEqual(cardLine("* Nachtsituationen [1]."), {
	prefix: "- ",
	segments: [{ text: "Nachtsituationen [1].", bold: false }],
});
assert.deepEqual(cardLine("- schon ein Bullet"), {
	prefix: "- ",
	segments: [{ text: "schon ein Bullet", bold: false }],
});
assert.deepEqual(cardLine("  * eingerückt"), {
	prefix: "  - ",
	segments: [{ text: "eingerückt", bold: false }],
});

// Bold inside a bullet line still splits.
assert.deepEqual(cardLine("* An der Station **NEU** wurde"), {
	prefix: "- ",
	segments: [
		{ text: "An der Station ", bold: false },
		{ text: "NEU", bold: true },
		{ text: " wurde", bold: false },
	],
});

// NOT bullets: the report separator, a bold line starting with **, a
// reference line, a lone asterisk without trailing text.
assert.deepEqual(cardLine("----"), { prefix: "", segments: [{ text: "----", bold: false }] });
assert.equal(cardLine("**Ziel und Ansatz**").prefix, "");
assert.equal(cardLine("[1] 2026 | 10.5194/hess-30-797-2026 | Title (S. 4)").prefix, "");
assert.equal(cardLine("*").prefix, "");

console.log("cardtext.test.ts: all assertions passed");
