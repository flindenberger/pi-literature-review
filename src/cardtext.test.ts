/**
 * Tests for the deterministic card-text formatting (bold segments +
 * bullet lines), mirroring render.ts strongHtml/bulletsHtml semantics.
 * Run: node src/cardtext.test.ts
 */

import assert from "node:assert/strict";
import { cardLine, cardSegments, hyperlinksSupported, linkFileUrl, piTuiHyperlinks } from "./cardtext.ts";

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
assert.equal(cardLine("[1] 2026 | 10.5194/hess-30-797-2026 | Title (p. 4)").prefix, "");
assert.equal(cardLine("*").prefix, "");

// linkFileUrl: the file:// URL becomes an OSC 8 link whose text is the
// decoded basename (page anchor kept); the rest of the line is untouched;
// lines without a file:// URL pass through.
{
	const url = "file:///home/u/lit-synthesis/2026-09-24_synthesis_report_Blanch.html";
	assert.equal(linkFileUrl(`HTML-Report: ${url}`),
		`HTML-Report: \x1b]8;;${url}\x072026-09-24_synthesis_report_Blanch.html\x1b]8;;\x07`);
	const page = "file:///home/u/lit-selection/2025_Blanch_%C3%A4.pdf#page=4";
	assert.equal(linkFileUrl(`  [1] p. 4: ${page}`),
		`  [1] p. 4: \x1b]8;;${page}\x072025_Blanch_ä.pdf#page=4\x1b]8;;\x07`);
	assert.equal(linkFileUrl("no link here"), "no link here");
	// Without link support the full URL stays (clickable or copyable).
	assert.equal(linkFileUrl(`HTML-Report: ${url}`, false), `HTML-Report: ${url}`);
}

// hyperlinksSupported: pi's override first, then pi-tui's detection, then
// VTE (GNOME Terminal & co., not in pi-tui's list) outside tmux/screen;
// the legacy Windows console and unknown terminals get the plain URL.
{
	assert.equal(hyperlinksSupported({ WT_SESSION: "x" }, true), true); // Windows Terminal via pi-tui
	assert.equal(hyperlinksSupported({}, false), false); // legacy console, unknown
	assert.equal(hyperlinksSupported({ VTE_VERSION: "8400", TERM: "xterm-256color" }, false), true);
	assert.equal(hyperlinksSupported({ VTE_VERSION: "4800" }, false), false); // before VTE 0.50
	assert.equal(hyperlinksSupported({ VTE_VERSION: "8400", TMUX: "/tmp/tmux" }, false), false);
	assert.equal(hyperlinksSupported({ VTE_VERSION: "8400", TERM: "screen-256color" }, false), false);
	assert.equal(hyperlinksSupported({ PI_HYPERLINKS: "1" }, false), true);
	assert.equal(hyperlinksSupported({ PI_HYPERLINKS: "0", VTE_VERSION: "8400" }, true), false);
	assert.equal(piTuiHyperlinks({ getCapabilities: () => ({ hyperlinks: true }) }), true);
	assert.equal(piTuiHyperlinks({ getCapabilities: () => ({ hyperlinks: false }) }), false);
	assert.equal(piTuiHyperlinks({}), false);
	assert.equal(piTuiHyperlinks({ getCapabilities: () => { throw new Error("x"); } }), false);
}

console.log("cardtext.test.ts: all assertions passed");
