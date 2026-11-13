/**
 * The notepad's AI corrector, two modes on a piece of the user's own text:
 * "spelling" corrects spelling, grammar and punctuation; "wording" also
 * improves the phrasing. Fixed code compares the answer word by word and
 * rejects what the mode does not allow (spelling: anything beyond a
 * correction; wording: lost or new numbers, names and abbreviations,
 * changed lines, a much longer or shorter text). The page shows the
 * changes and applies them only on the user's click.
 */

export type ProofreadMode = "spelling" | "wording";

/** Longest text sent at once (characters). */
export const PROOFREAD_MAX_CHARS = 3000;
export const PROOFREAD_TIMEOUT_MS = 60_000;

export const PROOFREAD_SYSTEM = [
	"You correct spelling, grammar and punctuation in the user's text.",
	"Keep its language, wording, meaning, style and line breaks. Do not translate, rephrase, shorten, extend, summarise or comment.",
	"Leave names, numbers, units, abbreviations, DOIs and citations exactly as they are.",
	"If nothing needs correcting, return the text unchanged.",
	"Reply with the corrected text only: no introduction, no quotation marks, no explanation.",
].join(" ");

export const WORDING_SYSTEM = [
	"You improve the wording of the user's text for clear, concise academic writing: grammar, flow, word choice, sentence structure.",
	"Keep its language (never translate), meaning, facts and line breaks. Do not add claims, examples or content, and do not drop any.",
	"Keep every number, unit, name, abbreviation, DOI and citation exactly as written.",
	"Reply with the improved text only: no introduction, no quotation marks, no explanation.",
].join(" ");

const STOPWORDS: Record<string, string[]> = {
	English: ["the", "and", "is", "are", "was", "were", "of", "to", "in", "with", "that", "this", "for", "on", "it", "be", "by", "which", "at"],
	German: ["der", "die", "das", "und", "ist", "sind", "war", "wurde", "wurden", "mit", "von", "zu", "den", "dem", "ein", "eine", "nicht", "auf", "für", "seit", "auch", "sich"],
	Spanish: ["el", "la", "los", "las", "y", "es", "son", "de", "del", "con", "que", "en", "por", "para", "una", "un"],
	Catalan: ["el", "la", "els", "les", "i", "és", "són", "de", "del", "amb", "que", "en", "per", "una", "un"],
};
/** The text's language by its common small words (null when unsure). */
export function detectLanguage(text: string): string | null {
	const list = (text.toLowerCase().match(/\p{L}+/gu) ?? []);
	let best: string | null = null;
	let bestScore = 0;
	let second = 0;
	for (const [language, words] of Object.entries(STOPWORDS)) {
		const set = new Set(words);
		const score = list.filter((word) => set.has(word)).length;
		if (score > bestScore) { second = bestScore; bestScore = score; best = language; } else if (score > second) second = score;
	}
	return bestScore >= 2 && bestScore > second ? best : null;
}

export function proofreadPrompt(text: string, mode: ProofreadMode = "spelling"): string {
	const language = detectLanguage(text);
	const keep = language ? ` The text is in ${language}; reply in ${language}.` : "";
	return `${mode === "wording" ? "Improve the wording of" : "Correct"} this text.${keep}\n\n${text}`;
}

export function systemFor(mode: ProofreadMode): string {
	return mode === "wording" ? WORDING_SYSTEM : PROOFREAD_SYSTEM;
}

/** Tokens a rewording must keep: numbers, abbreviations, names with
 * inner capitals or digits (MAE, Sentinel-2, GoPro). */
function fixedTokens(text: string): string[] {
	return tokens(text).filter((token) => /\d/.test(token) || /^\p{Lu}{2,}$/u.test(token) || /^\p{L}+\p{Lu}/u.test(token));
}
function missing(from: string[], within: string[]): string[] {
	const left = new Map<string, number>();
	for (const token of within) left.set(token, (left.get(token) ?? 0) + 1);
	const out: string[] = [];
	for (const token of from) {
		const count = left.get(token) ?? 0;
		if (count > 0) left.set(token, count - 1); else out.push(token);
	}
	return out;
}

/** The model's reply without wrappers it tends to add (code fences,
 * quotes around the whole text, a "Corrected text:" label). */
export function cleanReply(raw: string, original: string): string {
	let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\r\n?/g, "\n").trim();
	const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
	if (fence) text = fence[1];
	text = text.replace(/^(corrected( text)?|korrigierte?r? text|correction)\s*:\s*\n?/i, "");
	const quoted = /^(["“„«'])([\s\S]*)(["”“»'])$/.exec(text);
	if (quoted && !/^["“„«']/.test(original.trim())) text = quoted[2];
	// The original's outer spaces and line breaks stay.
	const lead = /^\s*/.exec(original)?.[0] ?? "";
	const tail = /\s*$/.exec(original)?.[0] ?? "";
	return lead + text.trim() + tail;
}

export type DiffOp = { op: "=" | "-" | "+"; text: string };

/** Words, single punctuation marks and runs of white space. */
export function tokens(text: string): string[] {
	return text.match(/\s+|[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}\p{M}]/gu) ?? [];
}

/** Token diff of two texts (longest common subsequence), adjacent ops of
 * one kind joined. */
export function diffTokens(before: string, after: string): DiffOp[] {
	const a = tokens(before);
	const b = tokens(after);
	const rows = a.length + 1;
	const cols = b.length + 1;
	const table = new Uint32Array(rows * cols);
	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
		}
	}
	const out: DiffOp[] = [];
	const push = (op: DiffOp["op"], text: string) => {
		const last = out[out.length - 1];
		if (last && last.op === op) last.text += text;
		else out.push({ op, text });
	};
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) { push("=", a[i]); i += 1; j += 1; }
		else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { push("-", a[i]); i += 1; }
		else { push("+", b[j]); j += 1; }
	}
	while (i < a.length) { push("-", a[i]); i += 1; }
	while (j < b.length) { push("+", b[j]); j += 1; }
	return out;
}

const words = (text: string) => tokens(text).filter((token) => /[\p{L}\p{N}]/u.test(token));

export type ProofreadResult =
	| { ok: true; corrected: string; diff: DiffOp[]; changes: number }
	| { ok: false; reason: string };

/** Accept the model's text only as a correction of the original: same
 * line breaks, similar length, few changed words. */
export function checkCorrection(original: string, reply: string, mode: ProofreadMode = "spelling"): ProofreadResult {
	const corrected = cleanReply(reply, original);
	if (!corrected.trim()) return { ok: false, reason: "the model returned no text" };
	if (corrected === original) return { ok: true, corrected, diff: [{ op: "=", text: original }], changes: 0 };
	if ((original.match(/\n/g) ?? []).length !== (corrected.match(/\n/g) ?? []).length) return { ok: false, reason: "the model changed the lines" };
	const ratio = corrected.length / Math.max(1, original.length);
	const diff = diffTokens(original, corrected);
	if (mode === "wording") {
		if (ratio < 0.5 || ratio > 2) return { ok: false, reason: "the model changed the length too much" };
		const language = detectLanguage(original);
		const replyLanguage = detectLanguage(corrected);
		if (language && replyLanguage && language !== replyLanguage) return { ok: false, reason: `the model answered in ${replyLanguage}` };
		// A translation keeps almost none of the words.
		const own = words(original).filter((word) => word.length > 2).map((word) => word.toLowerCase());
		const kept = new Set(words(corrected).map((word) => word.toLowerCase()));
		if (own.length >= 5 && own.filter((word) => kept.has(word)).length / own.length < 0.25) return { ok: false, reason: "the model replaced nearly all words" };
		const lost = missing(fixedTokens(original), tokens(corrected));
		if (lost.length) return { ok: false, reason: `the model dropped or changed ${lost.slice(0, 3).join(", ")}` };
		const added = missing(fixedTokens(corrected), tokens(original));
		if (added.length) return { ok: false, reason: `the model added ${added.slice(0, 3).join(", ")}` };
		return { ok: true, corrected, diff, changes: diff.filter((part) => part.op !== "=").length };
	}
	if (ratio < 0.7 || ratio > 1.4) return { ok: false, reason: "the model rewrote the text" };
	const changedWords = diff.filter((part) => part.op === "-").reduce((sum, part) => sum + words(part.text).length, 0);
	const addedWords = diff.filter((part) => part.op === "+").reduce((sum, part) => sum + words(part.text).length, 0);
	const total = words(original).length;
	const limit = Math.max(3, Math.ceil(total * 0.3));
	if (changedWords > limit || addedWords > limit + 1) return { ok: false, reason: "the model changed more than spelling and grammar" };
	const changes = diff.filter((part) => part.op !== "=").length;
	return { ok: true, corrected, diff, changes };
}
