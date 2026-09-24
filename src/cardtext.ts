/**
 * Deterministic inline formatting for transcript cards (TUI).
 *
 * Models habitually write **bold** and "* " bullet lines; the HTML report
 * already renders both (render.ts strongHtml/bulletsHtml) while the card
 * showed the literal asterisks. This module mirrors exactly those two
 * rules as pure string parsing -- no model touches the text, the theme
 * styling itself stays in the adapter (extensions/synthesis.ts). It also
 * turns file:// URLs into clickable terminal links (linkFileUrl), shared
 * by the search and synthesis cards.
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

/**
 * Whether the terminal renders OSC 8 hyperlinks. pi's own override
 * PI_HYPERLINKS=1/0 wins; then pi-tui's detection (`piTuiSays`: Windows
 * Terminal, VS Code, kitty, WezTerm, iTerm2, ...). pi-tui does not list VTE
 * terminals (GNOME Terminal, Ptyxis, Tilix), which render OSC 8 since VTE
 * 0.50 -- they count via VTE_VERSION, except inside tmux or screen, which
 * only forward links when pi-tui confirmed it. Everything else (the legacy
 * Windows console, JetBrains, unknown terminals) gets the plain URL: a
 * swallowed OSC 8 would leave the bare file name, neither clickable nor
 * copyable. Pure.
 */
export function hyperlinksSupported(env: Record<string, string | undefined>, piTuiSays: boolean): boolean {
	if (env.PI_HYPERLINKS === "1") return true;
	if (env.PI_HYPERLINKS === "0") return false;
	if (piTuiSays) return true;
	const term = (env.TERM ?? "").toLowerCase();
	if (env.TMUX || term.startsWith("tmux") || term.startsWith("screen")) return false;
	const vte = Number.parseInt(env.VTE_VERSION ?? "", 10);
	return Number.isFinite(vte) && vte >= 5000;
}

/**
 * A raw file:// URL WRAPS across card lines in narrow terminals and the
 * click target breaks. Display-only fix: where the terminal renders links
 * (`links`, see hyperlinksSupported), the first file:// URL of a line
 * becomes an OSC 8 hyperlink whose visible text is the short, decoded
 * basename (a page anchor such as "#page=4" stays part of it) -- short text
 * never wraps. pi-tui supports OSC 8 (visibleWidth strips it, the wrap
 * tracker re-opens it per line); BEL terminator because some terminals
 * only click BEL-terminated links. Without link support, and on lines
 * without a file:// URL, the line comes back unchanged. The text stored in
 * the session (LLM context, protocols) keeps the plain URL; only the card
 * rendering calls this. Pure.
 */
export function linkFileUrl(line: string, links = true): string {
	if (!links) return line;
	const match = line.match(/file:\/\/\S+/);
	if (!match) return line;
	const url = match[0];
	let label = url.split("/").pop() || url;
	try {
		label = decodeURIComponent(label);
	} catch {
		// keep the raw basename
	}
	return line.replace(url, `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`);
}

/** pi-tui's own hyperlink detection, read from the module pi loaded; false
 * when that pi-tui version has no capability API. Never throws. */
export function piTuiHyperlinks(tui: unknown): boolean {
	try {
		const get = (tui as { getCapabilities?: () => { hyperlinks?: unknown } }).getCapabilities;
		return typeof get === "function" && get().hyperlinks === true;
	} catch {
		return false;
	}
}
