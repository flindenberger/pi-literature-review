/**
 * Example questions for the paper chat's box, written by the model from
 * the chosen papers' names, titles and author keywords only (never their
 * text), then checked by fixed rules: a question of 4-16 words ("et al."
 * not counted), and every
 * number and every capitalized word after the first must occur in what
 * the model was given -- so an example can only ask, never introduce a
 * name, a sensor or a figure of its own. A failed check returns null and
 * the page keeps its fixed templates. Placeholder text only: nothing here
 * reaches an answer, a report or a citation.
 */

import { firstAuthorLastName } from "../types.ts";

/** "Luo et al. 2021", "Lee and Kim 2021" or "Smith 2021" from the record;
 * the file's base name when it has neither authors nor a year. */
export function examplePaperName(authors: string[], year: string | null, base: string): string {
	const who = authors.length
		? `${firstAuthorLastName(authors)}${authors.length > 2 ? " et al." : authors.length === 2 ? ` and ${firstAuthorLastName(authors.slice(1))}` : ""}`
		: "";
	return [who, year].filter(Boolean).join(" ") || base;
}

export interface ExamplePaper {
	/** "Luo et al. 2021" */
	name: string;
	title: string;
	keywords: string[];
}

export const EXAMPLES_SYSTEM = [
	"You write example questions that a researcher could type into a chat over scientific papers.",
	"Use only the paper names, titles and keywords you are given. Do not state facts, results, numbers or methods that are not in them.",
	"Write exactly three questions in English, one per line, each at most 14 words and ending with a question mark.",
	"No numbering, no quotes, no other text.",
].join(" ");

/** Papers shown to the model; a larger choice is described by its shared keywords. */
const MAX_LISTED = 8;

export function examplesPrompt(papers: ExamplePaper[], single: boolean): string {
	if (single) {
		const paper = papers[0];
		return [
			"The chat is about one paper; call it \"it\" or \"this paper\".",
			`Title: ${paper.title || "(unknown)"}`,
			`Keywords: ${paper.keywords.join("; ") || "(none)"}`,
		].join("\n");
	}
	const lines = [`The chat is about these ${papers.length} papers.`];
	if (papers.length <= 3) lines.push("At least one question may compare them by name.");
	else lines.push(`Refer to them as "these ${papers.length} papers", not by name.`);
	for (const paper of papers.slice(0, MAX_LISTED)) {
		lines.push(`- ${paper.name}: ${paper.title || "(no title)"}${paper.keywords.length ? ` [keywords: ${paper.keywords.join("; ")}]` : ""}`);
	}
	if (papers.length > MAX_LISTED) {
		const shared = sharedKeywords(papers).slice(0, 10);
		if (shared.length) lines.push(`Keywords shared by several of them: ${shared.join("; ")}`);
	}
	return lines.join("\n");
}

/** Keywords that occur in two or more papers, most frequent first. */
export function sharedKeywords(papers: ExamplePaper[]): string[] {
	const counts = new Map<string, { term: string; n: number }>();
	for (const paper of papers) {
		for (const term of new Set(paper.keywords.map((k) => k.toLowerCase()))) {
			const entry = counts.get(term);
			if (entry) entry.n++;
			else counts.set(term, { term: paper.keywords.find((k) => k.toLowerCase() === term) ?? term, n: 1 });
		}
	}
	return [...counts.values()].filter((entry) => entry.n > 1).sort((a, b) => b.n - a.n || a.term.localeCompare(b.term)).map((entry) => entry.term);
}

/** The model's lines that pass the checks (at most three), or null when
 * fewer than two pass. */
export function parseExamples(raw: string, papers: ExamplePaper[], single: boolean): string[] | null {
	const given = [
		...papers.flatMap((paper) => [paper.name, paper.title, ...paper.keywords]),
		...(single ? [] : sharedKeywords(papers)),
		// "these 5 papers" is the prompt's own wording.
		...(single ? [] : [String(papers.length)]),
	].join(" ").toLowerCase();
	const words = new Set(given.split(/[^\p{L}\p{N}-]+/u).filter(Boolean));
	const out: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const text = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["'“]+|["'”]+$/g, "").trim();
		if (!text.endsWith("?")) continue;
		// The keyword list is the model's input, not a topic of the papers.
		if (/\bkeywords?\b/i.test(text)) continue;
		const tokens = text.slice(0, -1).split(/\s+/).filter(Boolean);
		// "et al." belongs to a name and does not count as words.
		const counted = tokens.filter((token) => !/^(?:et|al\.?,?)$/i.test(token)).length;
		if (counted < 4 || counted > 16) continue;
		const foreign = tokens.slice(1).some((token) => {
			const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
			if (!word) return false;
			const marked = /\d/.test(word) || /\p{Lu}/u.test(word);
			if (!marked) return false;
			const lower = word.toLowerCase();
			return !words.has(lower) && !lower.split("-").every((part) => words.has(part)) && !COMMON_CAPS.has(lower);
		});
		if (foreign) continue;
		if (!out.some((known) => known.toLowerCase() === text.toLowerCase())) out.push(text);
		if (out.length === 3) break;
	}
	return out.length >= 2 ? out : null;
}

/** Capitalized words a question may carry without the input naming them. */
const COMMON_CAPS = new Set(["i", "et", "al", "english"]);
