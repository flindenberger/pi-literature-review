/**
 * Pure helpers for the intake dialog (parameter confirmation).
 *
 * Three field tests (2x Granite 4.1, 1x Gemini, all 2026-07-10) proved that an
 * instruction in the tool description cannot make a model ask the user intake
 * questions before searching. The confirmation therefore moved into CODE: the
 * Pi extension shows blocking terminal dialogs (ctx.ui) on every call. This
 * module holds the deterministic, UI-free pieces of that gate so they stay
 * testable and reusable by the CLI; nothing here imports Pi.
 */

/**
 * Human-readable view of the grouping rules and their logic:
 * groups are AND-linked, terms within a group are OR-linked.
 * [["river","fluvial"],["sandbar"]] -> "(river OR fluvial) AND (sandbar)"
 */
export function formatGroupExpression(groups: string[][]): string {
	return groups
		.filter((group) => group.length)
		.map((group) => `(${group.join(" OR ")})`)
		.join(" AND ");
}

/**
 * Parse the compact grouping syntax "a,b;c,d": groups separated by ';',
 * terms within a group by ','. Empty/blank input -> [] (ungrouped run).
 */
export function parseGroupTerms(spec: string): string[][] {
	return spec
		.split(";")
		.map((groupPart) => groupPart.split(",").map((term) => term.trim()).filter(Boolean))
		.filter((group) => group.length);
}

/**
 * Parse a publication-year range. Accepted forms: "2015-2024", "2015-",
 * "-2024", "2020" (single year = from and to), "" (no limit -> {}).
 * Returns null when the input is not parseable, so the dialog can fall back
 * to the proposed values instead of guessing.
 */
export function parseYearRange(spec: string): { yearFrom?: number; yearTo?: number } | null {
	const trimmed = spec.trim();
	if (!trimmed) return {};
	const match = /^(\d{4})?\s*-\s*(\d{4})?$|^(\d{4})$/.exec(trimmed);
	if (!match) return null;
	if (match[3]) {
		const year = Number(match[3]);
		return { yearFrom: year, yearTo: year };
	}
	if (!match[1] && !match[2]) return null; // bare "-"
	const range: { yearFrom?: number; yearTo?: number } = {};
	if (match[1]) range.yearFrom = Number(match[1]);
	if (match[2]) range.yearTo = Number(match[2]);
	if (range.yearFrom !== undefined && range.yearTo !== undefined && range.yearFrom > range.yearTo) {
		return null;
	}
	return range;
}

/**
 * Parse the grouping input from the intake dialog. Primary form is the same
 * expression the dialog displays, edited in place by the user:
 * "(river OR fluvial) AND (sandbar OR bar)" -- AND separates groups, OR (or
 * a comma) separates terms, parentheses are optional, keywords are
 * case-insensitive. The compact "a,b;c,d" syntax stays accepted as fallback.
 * Multi-word terms are fine ("remote sensing"); a term that itself contains
 * the word AND/OR surrounded by spaces cannot be expressed here.
 */
export function parseGroupSpec(spec: string): string[][] {
	const trimmed = spec.trim();
	if (!trimmed) return [];
	if (!/[()]/.test(trimmed) && !/\s(AND|OR)\s/i.test(trimmed)) return parseGroupTerms(trimmed);
	return trimmed
		.split(/\s+AND\s+/i)
		.map((part) =>
			part
				.replace(/[()]/g, " ")
				.split(/\s+OR\s+|,/i)
				.map((term) => term.trim())
				.filter(Boolean),
		)
		.filter((group) => group.length);
}

/** Function words that never form a useful term group of their own --
 * whole-word matching would satisfy them in every abstract. English and
 * German, since queries arrive in both. Shared with the arXiv query
 * builder (v30.1 field finding: an AND clause over an everyday word like
 * "using" makes arXiv's search backend time out or 429 -- measured with
 * the same expression minus the word answering in seconds). */
export const QUERY_STOPWORDS = new Set([
	"and", "or", "of", "the", "a", "an", "in", "on", "at", "for", "with", "to", "by", "from",
	"via", "using",
	// 2026-08-10 field find (prose sentence typed as query): sentence glue
	// survived into AND clauses ("all:based AND ... all:as AND ...").
	"as", "is", "are", "be", "based", "beyond", "into", "about", "between", "within",
	"through", "towards", "toward", "this", "that", "these", "those", "its", "their",
	"und", "oder", "der", "die", "das", "dem", "den", "des", "ein", "eine", "einer", "eines",
	"im", "mit", "für", "von", "vom", "zur", "zum", "auf", "bei", "aus", "über",
	"als", "ist", "sind", "basierend", "durch", "nach", "unter", "zwischen", "ohne",
	"sowie", "zu", "an", "am", "um", "beim", "einem", "einen",
]);

/**
 * Derive term groups from a plain search query, deterministically (v30:
 * the search wizard's grouping tab follows the query live -- no LLM on the
 * command path). Every content word becomes its own AND group; standalone
 * single characters bind to the neighbouring word as one phrase term (the
 * v18 arXiv tokenization rule -- "sentinel 2" stays one concept); function
 * words drop out. A query carrying the user's own boolean syntax or quotes
 * derives nothing -- their expression is not second-guessed. Synonyms
 * (OR terms) are the user's or the agent's to add.
 */
export function deriveGroupsFromQuery(query: string): string[][] {
	const trimmed = query.trim().replace(/\s+/g, " ");
	if (!trimmed) return [];
	if (/(^|\s)(AND|OR|NOT)(\s|$)/.test(trimmed) || trimmed.includes('"')) return [];
	// Punctuation glued to a word ("approach," / "(components") never
	// belongs to the term -- strip it at both ends, keep inner hyphens and
	// dots ("sentinel-2", "4.0") intact (2026-08-10 field find).
	const tokens = trimmed.toLowerCase().split(" ")
		.map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter(Boolean);
	const units: string[][] = [];
	let leading: string[] = []; // single chars with no word yet; bound to the next word
	for (const token of tokens) {
		if (QUERY_STOPWORDS.has(token)) continue;
		if (token.length === 1) {
			if (units.length) units[units.length - 1].push(token);
			else leading.push(token);
		} else {
			units.push([...leading, token]);
			leading = [];
		}
	}
	return units.map((unit) => [unit.join(" ")]);
}

/** Generic task/method words (v30.2): they describe WHAT IS DONE with the
 * subject, not the subject itself. The "core concepts" grouping variant
 * drops them, so on_target requires only the domain concepts -- a broader,
 * often more useful labeling than the strict all-words variant. English
 * and German. */
const GENERIC_TASK_WORDS = new Set([
	"detection", "extraction", "mapping", "monitoring", "classification", "segmentation",
	"estimation", "analysis", "assessment", "evaluation", "identification", "retrieval",
	"measurement", "observation", "prediction", "modeling", "modelling", "method", "methods",
	"approach", "approaches", "technique", "techniques", "study", "studies", "review", "comparison",
	"erkennung", "extraktion", "kartierung", "überwachung", "klassifikation", "klassifizierung",
	"segmentierung", "schätzung", "analyse", "bewertung", "auswertung", "identifikation",
	"messung", "beobachtung", "vorhersage", "modellierung", "methode", "methoden",
	"ansatz", "ansätze", "verfahren", "studie", "studien", "vergleich",
]);

/**
 * The broader grouping variant (v30.2): like deriveGroupsFromQuery, minus
 * generic task words -- "Water Mask Extraction Using Sentinel 2" keeps
 * (water) AND (mask) AND (sentinel 2). Falls back to [] when nothing
 * remains (all-task-word queries offer no core to anchor on).
 */
export function deriveCoreGroupsFromQuery(query: string): string[][] {
	return deriveGroupsFromQuery(query).filter((group) => !GENERIC_TASK_WORDS.has(group[0]));
}

/** Prefill for the year-range input: "2015-2024", "2015-", "" (no limit). */
export function yearRangeToSpec(yearFrom?: number, yearTo?: number): string {
	if (yearFrom === undefined && yearTo === undefined) return "";
	if (yearFrom !== undefined && yearTo !== undefined && yearFrom === yearTo) return String(yearFrom);
	return `${yearFrom ?? ""}-${yearTo ?? ""}`;
}

/**
 * Whether a query text is a concept-block EXPRESSION (hand- or LLM-written
 * boolean structure) rather than plain keywords (2026-08-06 block search):
 * parentheses, semicolons (the legacy a,b;c,d spec) or UPPERCASE boolean
 * operators mark it. Lowercase and/or are everyday words and stay plain.
 */
export function isBlockExpression(text: string): boolean {
	return /[();]/.test(text) || /(^|\s)(AND|OR)(\s|$)/.test(text);
}

/**
 * The concept blocks of one query (2026-08-06): the single structure that
 * BOTH drives the boolean source search (arXiv, OpenAlex) AND labels the
 * results on_target/adjacent -- search and label can no longer disagree.
 * An expression parses via parseGroupSpec ("(river OR stream) AND (mask)"),
 * plain keywords derive one block per content word (the v18/v30 rule,
 * "sentinel 2" bindings included). Queries carrying quotes or explicit
 * arXiv field syntax (all:/ti:/abs:/au:/cat:) are the user's own source
 * syntax -- hands off, no blocks (the sources then use their legacy
 * pass-through paths).
 */
export function queryBlocks(text: string): string[][] {
	if (/"|(?:^|\s)(?:all|ti|abs|au|cat):/i.test(text)) return [];
	return isBlockExpression(text) ? parseGroupSpec(text) : deriveGroupsFromQuery(text);
}

/** Whether a plain query reads like a PROSE SENTENCE rather than keywords
 * (2026-08-10 field find: a naive user typed a full sentence into the
 * query window; word-per-block derivation turned it into an unsatisfiable
 * many-block AND chain). Deterministic: the user's own boolean/quote/
 * field syntax is never second-guessed; otherwise a derivation of
 * PROSE_BLOCK_THRESHOLD or more blocks marks prose. The wizard's variants
 * tab reacts (distillation rule in the LLM prompt, first suggestion
 * prechecked, warning under the base row). */
export const PROSE_BLOCK_THRESHOLD = 6;
export function isProseQuery(query: string): boolean {
	if (/"|(?:^|\s)(?:all|ti|abs|au|cat):/i.test(query) || isBlockExpression(query)) return false;
	return deriveGroupsFromQuery(query).length >= PROSE_BLOCK_THRESHOLD;
}

/** All words of a block's terms, lowercased, hyphens as spaces -- the
 * word-level view alignBlocksToBase matches on. */
function blockWords(block: string[]): string[] {
	return block.flatMap((term) => term.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean));
}

/** Word-level mirror of the termMatches tolerances (plural-s and
 * consonant+y -> ies; hyphens are normalized away by blockWords): "river"
 * matches "rivers", "body" matches "bodies", nothing else fuzzes. */
function wordMatches(a: string, b: string): boolean {
	const canon = (word: string): string =>
		word.length > 3 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word;
	const ca = canon(a);
	const cb = canon(b);
	return ca === cb || `${ca}s` === cb || ca === `${cb}s`;
}

/**
 * Reorder a variant's concept blocks to the BASE query's concept order
 * (2026-08-07, user wish: parallel structure -- "Sentinel Water Detection"
 * should always yield sensor block first, then water block, then task
 * block, so what the model built is comparable at a glance). AND blocks
 * are commutative, so this is display order only -- fetch and labeling are
 * unchanged. A block is anchored to the FIRST base concept it shares a
 * word with (tolerances above); anchored blocks sort by that anchor among
 * themselves, blocks matching no base concept KEEP their position (pure
 * synonym blocks like "optical sensor OR multispectral" carry no base
 * word -- the model may have placed them correctly, never demote them).
 */
export function alignBlocksToBase(blocks: string[][], baseBlocks: string[][]): string[][] {
	const baseWords = baseBlocks.map(blockWords);
	const anchored = blocks
		.map((block, position) => ({
			position,
			anchor: baseWords.findIndex((base) =>
				base.some((baseWord) => blockWords(block).some((word) => wordMatches(word, baseWord)))),
		}))
		.filter((entry) => entry.anchor !== -1);
	const order = [...anchored].sort((a, b) => a.anchor - b.anchor || a.position - b.position);
	const result = blocks.slice();
	anchored.forEach((slot, rank) => { result[slot.position] = blocks[order[rank].position]; });
	return result;
}

/**
 * Canonical form of one variant suggestion: block expressions are parsed,
 * aligned to the base concept order and reprinted uniformly via
 * formatGroupExpression; plain-keyword lines and hands-off syntax
 * (quotes, field prefixes -- queryBlocks returns []) pass through
 * untouched.
 */
export function alignVariantExpression(line: string, baseBlocks: string[][]): string {
	if (!isBlockExpression(line)) return line;
	const blocks = queryBlocks(line);
	if (blocks.length < 2) return line;
	return formatGroupExpression(alignBlocksToBase(blocks, baseBlocks));
}

/**
 * Deterministic narrow-to-broad ordering of variant suggestions
 * (2026-08-10 user wish: the first rows stay close to the base query with
 * few synonyms, later rows grow freer). The prompt asks the model for this
 * staggering; this sort GUARANTEES the order regardless of what the model
 * emitted (code over instructions). Primary key: total term count across
 * the variant's blocks (fewer synonyms = narrower); secondary: number of
 * terms sharing no word with the base query (foreign terms = freer);
 * ties keep the model's order (stable). Hands-off lines (quotes / field
 * syntax -- queryBlocks returns []) score by their word count.
 */
export function sortVariantsByBreadth(variants: string[], baseBlocks: string[][]): string[] {
	const baseWords = baseBlocks.flatMap(blockWords);
	const scored = variants.map((variant, position) => {
		const blocks = queryBlocks(variant);
		const terms = blocks.length ? blocks.flat() : variant.split(/\s+/).filter(Boolean);
		const foreign = terms.filter((term) =>
			!term.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean)
				.some((word) => baseWords.some((baseWord) => wordMatches(word, baseWord)))).length;
		return { variant, position, terms: terms.length, foreign };
	});
	return scored
		.sort((a, b) => a.terms - b.terms || a.foreign - b.foreign || a.position - b.position)
		.map((entry) => entry.variant);
}

/**
 * Parse LLM-generated query-variant suggestions (2026-08-06): one query per
 * line; leading list bullets/numbering and surrounding quotes are stripped
 * (models habitually add both despite instructions); empties vanish;
 * block expressions are aligned to the base query's concept order
 * (2026-08-07) and reprinted canonically; duplicates of the base query and
 * of earlier lines drop case-insensitively; the list is capped and ordered
 * narrow-to-broad (2026-08-10, sortVariantsByBreadth). Pure -- the LLM
 * only ever SHAPES queries here, the user checks each one in the dialog
 * before it runs.
 */
export function parseVariantLines(raw: string, baseQuery: string, cap = 8): string[] {
	const baseBlocks = queryBlocks(baseQuery.trim());
	const seen = new Set([baseQuery.trim().toLowerCase()]);
	const variants: string[] = [];
	for (const line of raw.split("\n")) {
		const cleaned = line
			.trim()
			.replace(/^(?:[-*•]|\d{1,2}[.)])(?:\s+|$)/, "")
			.replace(/^["'„“`]+|["'“”`]+$/g, "")
			.trim();
		if (!cleaned) continue;
		const aligned = alignVariantExpression(cleaned, baseBlocks);
		const key = aligned.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		variants.push(aligned);
		if (variants.length >= cap) break;
	}
	return sortVariantsByBreadth(variants, baseBlocks);
}

/**
 * Parse a free-text results-per-source count from the intake dialog.
 * Returns the number clamped to [1, max] (max = politeness cap towards the
 * free APIs), or null when the input is not a whole number, so the dialog
 * can keep the proposed value instead of guessing.
 */
export function parsePerSource(spec: string, max: number): number | null {
	const trimmed = spec.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const count = Number(trimmed);
	if (count < 1) return null;
	return Math.min(count, max);
}
