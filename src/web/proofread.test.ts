/** Offline tests for src/web/proofread.ts (the notepad's AI corrector gate). */
import assert from "node:assert/strict";
import { checkCorrection, cleanReply, detectLanguage, diffTokens, proofreadPrompt } from "./proofread.ts";

// A real correction passes, with a word diff.
const fixed = checkCorrection("The camras were instaled at four sites , every 15 min.", "The cameras were installed at four sites, every 15 min.");
assert.equal(fixed.ok, true);
if (fixed.ok) {
	assert.equal(fixed.corrected, "The cameras were installed at four sites, every 15 min.");
	assert.deepEqual(fixed.diff.filter((part) => part.op !== "=").map((part) => `${part.op}${part.text}`), ["-camras", "+cameras", "-instaled", "+installed", "- "]);
}
// German too; nothing to correct = no changes.
const same = checkCorrection("Die Kameras wurden an vier Pegeln installiert.", "Die Kameras wurden an vier Pegeln installiert.");
assert.deepEqual(same.ok && same.changes, 0);
// Wrappers the model adds are removed; the outer spaces stay.
assert.equal(cleanReply('```\n"Fixed text."\n```', " Fixd text. "), " Fixed text. ");
assert.equal(cleanReply("Corrected text: Fixed.", "Fixd."), "Fixed.");
// A rewrite, an addition, a translation or changed lines are refused.
assert.deepEqual(checkCorrection("Cameras at four gauges.", "The study installed surveillance cameras at four river gauges in Saxony to monitor water levels continuously.").ok, false);
assert.deepEqual(checkCorrection("Die Kameras wurden installiert und laufen seit 2021 ohne Ausfall.", "The cameras were installed and have been running since 2021 without failure.").ok, false);
assert.deepEqual(checkCorrection("line one\nline two", "line one line two").ok, false);
assert.deepEqual(checkCorrection("text", "").ok, false);
// The diff covers both texts.
const diff = diffTokens("a b c", "a x c");
assert.equal(diff.filter((part) => part.op !== "+").map((part) => part.text).join(""), "a b c");
assert.equal(diff.filter((part) => part.op !== "-").map((part) => part.text).join(""), "a x c");
// Wording: a rewrite passes when numbers, names and abbreviations stay.
const worded = checkCorrection("The cameras was put at four sites and the MAE were 0.96 cm at ELB.", "Cameras were installed at four sites; the MAE was 0.96 cm at ELB.", "wording");
assert.equal(worded.ok, true);
assert.deepEqual(checkCorrection("The MAE was 0.96 cm at ELB.", "The error was small at ELB.", "wording"), { ok: false, reason: "the model dropped or changed MAE, 0, 96" });
assert.equal(checkCorrection("Cameras at four sites.", "Cameras at four sites since 2021 with Sentinel-2.", "wording").ok, false);
// The same rewrite is refused as a spelling correction.
assert.equal(checkCorrection("The cameras was put at four sites and the MAE were 0.96 cm at ELB.", "Cameras were installed at four sites; the MAE was 0.96 cm at ELB.").ok, false);
// Wording must stay in the text's language.
assert.equal(detectLanguage("Die Kameras wurden an vier Pegeln aufgestellt und das funktioniert seit 2021."), "German");
assert.deepEqual(checkCorrection("Die Kameras wurden an vier Pegeln aufgestellt und das funktioniert seit 2021 eigentlich ziemlich gut.", "The cameras were installed at four levels and have functioned effectively since 2021.", "wording"), { ok: false, reason: "the model answered in English" });
assert.equal(checkCorrection("Die Kameras wurden an vier Pegeln aufgestellt und das funktioniert seit 2021 eigentlich ziemlich gut.", "Die Kameras wurden an vier Pegeln installiert und arbeiten seit 2021 zuverlässig.", "wording").ok, true);
assert.match(proofreadPrompt("Die Kameras wurden an vier Pegeln aufgestellt.", "wording"), /The text is in German; reply in German\./);
console.log("proofread ok");
