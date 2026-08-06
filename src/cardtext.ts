/**
 * Deterministic inline formatting for transcript cards (TUI).
 *
 * Models habitually write **bold** and "* " bullet lines; the HTML report
 * already renders both (render.ts strongHtml/bulletsHtml) while the card
 * showed the literal asterisks. This module mirrors exactly those two
 * rules as pure string parsing -- no model touches the text, the theme
 * styling itself stays in the adapter (extensions/synthesis.ts).
 */

export interface CardSegment {
	text: string;
	bold: boolean;
}

export interface CardLine {
	/** Prefix printed unstyled before the segments ("- " on bullet lines). */
	prefix: string;
	segments: CardSegment[];
}

/** Split a line into bold/plain segments. Only the double-asterisk pair is
 * interpreted -- the same pattern as strongHtml; everything else stays
 * literal. */
export function cardSegments(text: string): CardSegment[] {
	const segments: CardSegment[] = [];
	let last = 0;
	for (const match of text.matchAll(/\*\*([^*\n][^*]*?)\*\*/g)) {
		const start = match.index ?? 0;
		if (start > last) segments.push({ text: text.slice(last, start), bold: false });
		segments.push({ text: match[1], bold: true });
		last = start + match[0].length;
	}
	if (last < text.length || !segments.length) segments.push({ text: text.slice(last), bold: false });
	return segments;
}

/** One card line: "- "/"* " bullet lines keep their indentation and get a
 * uniform "- " marker (bulletsHtml's line pattern); everything else passes
 * through with bold segments split out. */
export function cardLine(raw: string): CardLine {
	const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
	if (bullet) return { prefix: `${bullet[1]}- `, segments: cardSegments(bullet[2]) };
	return { prefix: "", segments: cardSegments(raw) };
}
