/**
 * The author keywords of a paper, read by fixed rules from the text of its
 * first pages (the "Keywords:" / "Index Terms" line most journals print).
 * Used only for the example questions typed into the paper chat's box --
 * never as metadata or in a citation. Lists separated by ";" or "," are
 * taken; a list separated by spaces only (where a term ends cannot be
 * told) gives nothing. Pure.
 */

const LABEL = /\b(?:key\s?words?|index\s+terms)\b\s*[:—–-]?\s*/i;
/** Where the keyword line ends: the next section or block of the page. */
const STOP = /\s(?:\d\.\s*)?introduction\b|\sabstract\b|a\s?b\s?s\s?t\s?r\s?a\s?c\s?t|\sarticle\s+history\b|\s(?:I|1)\.\s+[A-Z]|\scorresponding\s+author\b|\sreceived\s+\d/i;
const MAX_TERMS = 6;

export function paperKeywords(text: string): string[] {
	const match = LABEL.exec(text);
	if (!match) return [];
	let rest = text.slice(match.index + match[0].length, match.index + match[0].length + 300);
	const stop = STOP.exec(rest);
	if (stop) rest = rest.slice(0, stop.index);
	if (!/[;,]/.test(rest)) return [];
	const terms: string[] = [];
	for (const raw of rest.split(/[;,·•]/)) {
		const term = tidy(raw);
		if (!term) continue;
		if (!terms.some((known) => known.toLowerCase() === term.toLowerCase())) terms.push(term);
		if (terms.length >= MAX_TERMS) break;
	}
	return terms;
}

/** One term: trimmed, without a closing period; a capital only at the start
 * of an otherwise lower-case term ("Remote sensing") is lowered, names and
 * acronyms ("Google Earth Engine", "SAR", "Sentinel-2") stay. */
function tidy(raw: string): string {
	const term = raw.replace(/\s+/g, " ").trim().replace(/[.:]+$/, "").trim();
	const words = term.split(" ");
	if (term.length < 3 || words.length > 5 || !/\p{L}/u.test(term)) return "";
	const first = words[0];
	const plain = /^\p{Lu}\p{Ll}+$/u.test(first) && words.slice(1).every((word) => !/\p{Lu}|\d/u.test(word));
	return plain ? first.toLowerCase() + term.slice(first.length) : term;
}
