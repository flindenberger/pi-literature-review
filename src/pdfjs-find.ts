/**
 * What a PDF viewer's "find" actually searches -- a faithful port of
 * pdf.js web/pdf_find_controller.js, read out of the RUNNING browser
 * (snap Firefox 152: omni.ja -> chrome/pdfjs/content/web/viewer.mjs), not
 * transcribed from upstream docs.
 *
 * WHY THIS EXISTS. A citation superscript carries a search phrase so the
 * viewer highlights the cited passage. The phrase must therefore be
 * checked against the text the viewer will search -- which is neither the
 * PDF's raw text layer nor our cleaned chunk text:
 *
 *   - the find controller fetches text with disableNormalization: true,
 *     joins the items with NOTHING and appends "\n" for every item with
 *     hasEOL, then runs normalize() over the result;
 *   - normalize() decomposes to NFD, maps typographic characters, applies
 *     NFKC to a fixed character set (LIGATURES among them), repairs
 *     hyphenated line breaks, and turns every remaining "\n" into a space;
 *   - the query is normalized the same way and then converted to a regex
 *     in which whitespace becomes "[ ]+" and punctuation runs may be
 *     surrounded by "[ ]*".
 *
 * Two lessons are baked in here. (1) Approximating this was not good
 * enough: our own extraction resolves the ligature "fi" early, so we
 * cannot see that "of<fi>-\ncial" stays BROKEN for the viewer -- the NFKC
 * replacement of the ligature consumes the letter the hyphen repair needs,
 * and the passage becomes "offi- cial". Six of 344 excerpts silently lost
 * their highlight that way. (2) Do not hand-copy constants from a bundle:
 * a mistyped range in NFKC_NORMALIZE_CHARS once swallowed every lowercase
 * letter and "proved" a bug that did not exist.
 *
 * To refresh after a browser update:
 *   unzip -o /snap/firefox/current/usr/lib/firefox/omni.ja \
 *     'chrome/pdfjs/content/web/viewer.mjs' -d /tmp/pdfjs
 *   node -e 'const s=require("fs").readFileSync("/tmp/pdfjs/chrome/pdfjs/content/web/viewer.mjs","utf8");
 *            console.log(JSON.stringify(s.match(/NormalizeWithNFKC \|\|= `([\s\S]*?)`;/)[1]))'
 * and paste the result as NFKC_NORMALIZE_CHARS.
 *
 * A mismatch here is never dangerous: a phrase the viewer cannot find
 * simply is not highlighted, and the page anchor still takes the reader to
 * the right page.
 */

/** Typographic characters pdf.js maps before matching. */
const CHARACTERS_TO_NORMALIZE: Record<string, string> = {
	"‐": "-",
	"‘": "'",
	"’": "'",
	"‚": "'",
	"‛": "'",
	"“": '"',
	"”": '"',
	"„": '"',
	"‟": '"',
	"¼": "1/4",
	"½": "1/2",
	"¾": "3/4",
};

/** The character set pdf.js runs through NFKC (ligatures, super/subscripts,
 * enclosed forms, ...). Copied verbatim from the shipped viewer -- see the
 * refresh recipe above; never retype it. */
export const NFKC_NORMALIZE_CHARS = " ¨ª¯²-µ¸-º¼-¾Ĳ-ĳĿ-ŀŉſǄ-ǌǱ-ǳʰ-ʸ˘-˝ˠ-ˤʹͺ;΄-΅·ϐ-ϖϰ-ϲϴ-ϵϹևٵ-ٸक़-य़ড়-ঢ়য়ਲ਼ਸ਼ਖ਼-ਜ਼ਫ਼ଡ଼-ଢ଼ำຳໜ-ໝ༌གྷཌྷདྷབྷཛྷཀྵჼᴬ-ᴮᴰ-ᴺᴼ-ᵍᵏ-ᵪᵸᶛ-ᶿẚ-ẛάέήίόύώΆ᾽-῁ΈΉ῍-῏ΐΊ῝-῟ΰΎ῭-`ΌΏ´-῾ - ‑‗․-… ″-‴‶-‷‼‾⁇-⁉⁗ ⁰-ⁱ⁴-₎ₐ-ₜ₨℀-℃℅-ℇ℉-ℓℕ-№ℙ-ℝ℠-™ℤΩℨK-ℭℯ-ℱℳ-ℹ℻-⅀ⅅ-ⅉ⅐-ⅿ↉∬-∭∯-∰〈-〉①-⓪⨌⩴-⩶⫝̸ⱼ-ⱽⵯ⺟⻳⼀-⿕　〶〸-〺゛-゜ゟヿㄱ-ㆎ㆒-㆟㈀-㈞㈠-㉇㉐-㉾㊀-㏿ꚜ-ꚝꝰ꟱-ꟴꟸ-ꟹꭜ-ꭟꭩ豈-嗀塚晴凞-羽蘒諸逸-都飯-舘並-龎ﬀ-ﬆﬓ-ﬗיִײַ-זּטּ-לּמּנּ-סּףּ-פּצּ-ﮱﯓ-ﴽﵐ-ﶏﶒ-ﷇﷰ-﷼︐-︙︰-﹄﹇-﹒﹔-﹦﹨-﹫ﹰ-ﹲﹴﹶ-ﻼ！-ﾾￂ-ￇￊ-ￏￒ-ￗￚ-ￜ￠-￦";

const CJK = "(?:\\p{Ideographic}|[\\u3040-\\u30FF])";
const HK_DIACRITICS = "(?:\\u3099|\\u309A)";
/** A hyphen at a line break between letters marks a broken word. */
const BROKEN_WORD = "\\p{Ll}-\\n(?=\\p{Ll})|\\p{Lu}-\\n(?=\\p{L})";

const NORMALIZATION_REGEXP = new RegExp([
	`[${Object.keys(CHARACTERS_TO_NORMALIZE).join("")}]`,
	`[${NFKC_NORMALIZE_CHARS}]`,
	`${HK_DIACRITICS}\\n`,
	"\\p{M}+(?:-\\n)?",
	BROKEN_WORD,
	"\\S-\\n",
	`${CJK}\\n`,
	"\\n",
].map((part) => `(${part})`).join("|"), "gum");

/**
 * pdf.js normalize(), text result only (the viewer additionally tracks
 * character positions to place the highlight; we only need the string).
 * Alternation order matters and is preserved: an NFKC character wins over
 * the broken-word repair, which is exactly the ligature case above.
 */
export function pdfjsNormalize(text: string): string {
	return text.normalize("NFD").replace(NORMALIZATION_REGEXP,
		(match, p1: string, p2: string, p3: string, p4: string, p5: string, p6: string, p7: string, p8: string) => {
			if (p1) return CHARACTERS_TO_NORMALIZE[p1];
			if (p2) return p2.normalize("NFKC");
			if (p3) return p3.charAt(0);
			if (p4) return p4.endsWith("\n") ? p4.slice(0, p4.length - 2) : p4;
			if (p5) return p5.slice(0, -2); // broken word: hyphen and EOL drop out
			if (p6) return p6.slice(0, -1); // other dash before EOL: dash stays
			if (p7) return p7.slice(0, -1);
			if (p8) return " "; // end of line reads as a space
			return match;
		});
}

const SPECIAL_CHARS_REGEXP = /([+^$|])|(\p{P}+)|(\s+)|(\p{M})|(\p{L})/gu;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * pdf.js #convertToRegExpString for the URL-hash case, where the viewer
 * hardcodes caseSensitive false, entireWord false and matchDiacritics
 * true. Punctuation runs tolerate surrounding spaces, whitespace matches
 * one or more spaces.
 */
export function pdfjsQueryRegExp(rawQuery: string): RegExp | null {
	const query = pdfjsNormalize(rawQuery);
	const addExtraWhitespaces = (original: string, fixed: string): string => {
		if (original === query) return fixed;
		if (query.startsWith(original)) return `${fixed}[ ]*`;
		if (query.endsWith(original)) return `[ ]*${fixed}`;
		return `[ ]*${fixed}[ ]*`;
	};
	let pattern = query.replaceAll(SPECIAL_CHARS_REGEXP,
		(match, p1: string, p2: string, p3: string, p4: string, p5: string) => {
			if (p1) return addExtraWhitespaces(p1, escapeRegExp(p1));
			if (p2) return addExtraWhitespaces(p2, escapeRegExp(p2));
			if (p3) return "[ ]+";
			return p4 || p5 || match; // matchDiacritics: true -- kept as they are
		});
	if (pattern.endsWith("[ ]*")) pattern = pattern.slice(0, -"[ ]*".length);
	if (!pattern) return null;
	try {
		return new RegExp(pattern, "gui");
	} catch {
		return null; // a pattern we mis-built must never crash indexing
	}
}

/** True when the viewer's find would locate this phrase on this page.
 * `page` must be pdfjsNormalize()d viewer text (viewerPageTexts). */
export function viewerFindsPhrase(phrase: string, page: string): boolean {
	if (!phrase || !page) return false;
	const regexp = pdfjsQueryRegExp(phrase);
	return regexp ? regexp.test(page) : false;
}

/**
 * Math.sumPrecise as the TC39 proposal specifies it (Neumaier-compensated
 * summation; -0 for an empty list). The pdf.js build bundled in unpdf
 * calls Math.sumPrecise while parsing fonts and ships no polyfill; Node
 * versions without it (24 and older) leave every font sanitizer failing,
 * and a failed font drops its ligature glyphs from the text layer: "fi"
 * vanishes and "classification" is extracted as "classi cation". The
 * loss is silent for our own pipeline -- the viewer replica sees the same
 * broken text, so a highlight phrase "verifies" and then never matches in
 * a real browser -- so the polyfill is installed before pdf.js loads.
 * pdf.js only sums byte sizes here (integers, exact under any method);
 * the compensated form keeps the function honest for other callers.
 */
export function sumPrecise(values: Iterable<number>): number {
	let sum = 0;
	let compensation = 0;
	let count = 0;
	for (const value of values) {
		if (typeof value !== "number") throw new TypeError("sumPrecise: values must be numbers");
		const next = sum + value;
		compensation += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
		sum = next;
		count++;
	}
	return count === 0 ? -0 : sum + compensation;
}

/**
 * Options for every pdf.js document this package opens. verbosity 0 =
 * errors only: pdf.js otherwise prints font-repair notes such as "Warning:
 * TT: undefined function: 3" (a TrueType hinting program calling an
 * undefined function; pdf.js drops the hinting and carries on) through
 * console.warn, which pi does not capture -- the line lands in the middle
 * of the TUI. Hinting only affects on-screen glyph rendering; the
 * extracted text is identical either way (measured on the affected paper,
 * same page texts byte for byte). Real failures still throw.
 */
export const PDFJS_OPTIONS = { verbosity: 0 } as const;

/** Installs the Math.sumPrecise polyfill when the runtime lacks it (never
 * over a native one) and returns the unpdf module. The ONE entry point for
 * pdf.js in this package: both the text extraction and the viewer replica
 * load it here, so no code path can parse a PDF without the fix. */
export async function loadUnpdf(): Promise<typeof import("unpdf")> {
	const math = Math as unknown as { sumPrecise?: (values: Iterable<number>) => number };
	if (typeof math.sumPrecise !== "function") math.sumPrecise = sumPrecise;
	return import("unpdf");
}

/**
 * The searchable text of every page, assembled exactly as the find
 * controller does it. Dynamically imported like the rest of the PDF path
 * so offline code never loads pdfjs.
 */
export async function viewerPageTexts(bytes: Uint8Array): Promise<string[]> {
	const { getDocumentProxy } = await loadUnpdf();
	const document = await getDocumentProxy(new Uint8Array(bytes), PDFJS_OPTIONS);
	const pages: string[] = [];
	for (let number = 1; number <= document.numPages; number++) {
		const page = await document.getPage(number);
		const content = await page.getTextContent({ disableNormalization: true });
		const parts: string[] = [];
		for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
			if (typeof item.str !== "string") continue; // marked-content items
			parts.push(item.str);
			if (item.hasEOL) parts.push("\n");
		}
		pages.push(pdfjsNormalize(parts.join("")));
	}
	return pages;
}
