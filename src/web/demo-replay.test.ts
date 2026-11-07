/**
 * The browser demo's playback (src/web/demo/worker.ts) over the committed
 * example: placeholder placement, question matching, the report cut to
 * what was asked. Offline; the server itself is not started.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { placeExample, replayReport, sameQuestion, type DemoExample } from "./demo/worker.ts";

const raw = JSON.parse(readFileSync(new URL("./demo/example/blanch-2026.json", import.meta.url), "utf8")) as DemoExample;

// The capture left no machine path and no contact address behind.
const text = JSON.stringify(raw);
assert.doesNotMatch(text, /\/home\/|\/Users\/|[A-Z]:\\\\|mailto:/);
assert.ok(text.includes("{PDF}"));
assert.equal(raw.pdf.license, "CC BY 4.0");
assert.match(raw.pdf.sha256, /^[0-9a-f]{64}$/);
assert.equal(raw.questions.length, raw.answers.length);

// Placed: every placeholder becomes the demo's PDF path.
const placed = placeExample(raw, "/demo/papers/x.pdf");
assert.ok(!JSON.stringify(placed).includes("{PDF}"));
assert.ok(placed.answers.every((answer) => answer.papers.every((paper) => paper.pdf_path === "/demo/papers/x.pdf")));
// Every recorded answer is grounded and cites its passages.
assert.ok(placed.answers.every((answer) => answer.grounded && answer.sites.length > 0));

// Questions match without case, spacing or the closing mark.
assert.ok(sameQuestion("Which cameras were used and where were they installed?", "  which cameras were used and  where were they installed "));
assert.ok(!sameQuestion("Which cameras were used?", "Which cameras were used and where were they installed?"));

// The report holds the summary when asked for, and exactly the asked
// questions' recorded answers, in the asked order.
const one = replayReport(placed.report, { summary: "bullets", questions: [raw.questions[0].toUpperCase()] });
assert.deepEqual(one.units.map((unit) => unit.kind), ["summary", "detail-cross"]);
assert.deepEqual(one.questions, [raw.questions[0].toUpperCase()]);
const none = replayReport(placed.report, { summary: "none", questions: ["What is the meaning of life?"] });
assert.deepEqual(none.units, []);
const all = replayReport(placed.report, { summary: "bullets", questions: raw.questions });
assert.equal(all.units.filter((unit) => unit.kind === "detail-cross").length, raw.questions.length);
// The recorded report answers are the chat answers (the report reused them).
for (const answer of placed.answers) {
	const unit = all.units.find((entry) => entry.kind === "detail-cross" && sameQuestion(entry.question ?? "", answer.question));
	assert.equal(unit?.prose, answer.prose);
}

console.log("demo-replay.test.ts: all assertions passed");
