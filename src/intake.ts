/**
 * Pure query-parsing helpers for the search intake: concept-block
 * expressions ("(river OR stream) AND (mask)"), block derivation from plain
 * keywords, year ranges, result counts, and the cleaning/ordering of
 * LLM-suggested query variants. Shared by the search wizard
 * (extensions/search.ts), the engine (queryBlocks) and the CLI; nothing
 * here imports pi, nothing here calls a model.
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
 * builder: an AND clause over an everyday word like "using" makes arXiv's
 * search backend time out or rate-limit. */
export const QUERY_STOPWORDS = new Set([
	"and", "or", "of", "the", "a", "an", "in", "on", "at", "for", "with", "to", "by", "from",
	"via", "using",
	// Sentence glue, for prose typed as a query.
	"as", "is", "are", "be", "based", "beyond", "into", "about", "between", "within",
	"through", "towards", "toward", "this", "that", "these", "those", "its", "their",
	"und", "oder", "der", "die", "das", "dem", "den", "des", "ein", "eine", "einer", "eines",
	"im", "mit", "für", "von", "vom", "zur", "zum", "auf", "bei", "aus", "über",
	"als", "ist", "sind", "basierend", "durch", "nach", "unter", "zwischen", "ohne",
	"sowie", "zu", "an", "am", "um", "beim", "einem", "einen",
]);

/**
 * Derive term groups from a plain search query, deterministically (no
 * LLM). Every content word becomes its own AND group; standalone single
 * characters bind to the neighbouring word as one phrase term ("sentinel
 * 2" stays one concept); function words drop out. A query carrying the
 * user's own boolean syntax or quotes derives nothing -- their expression
 * is not second-guessed. Synonyms (OR terms) are the user's or the
 * model's to add.
 */
export function deriveGroupsFromQuery(query: string): string[][] {
	const trimmed = query.trim().replace(/\s+/g, " ");
	if (!trimmed) return [];
	if (/(^|\s)(AND|OR|NOT)(\s|$)/.test(trimmed) || trimmed.includes('"')) return [];
	// Punctuation glued to a word ("approach," / "(components") never
	// belongs to the term -- strip it at both ends, keep inner hyphens and
	// dots ("sentinel-2", "4.0") intact.
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

/** Prefill for the year-range input: "2015-2024", "2015-", "" (no limit). */
export function yearRangeToSpec(yearFrom?: number, yearTo?: number): string {
	if (yearFrom === undefined && yearTo === undefined) return "";
	if (yearFrom !== undefined && yearTo !== undefined && yearFrom === yearTo) return String(yearFrom);
	return `${yearFrom ?? ""}-${yearTo ?? ""}`;
}

/**
 * Whether a query text is a concept-block EXPRESSION (hand- or LLM-written
 * boolean structure) rather than plain keywords: parentheses, semicolons
 * (the compact a,b;c,d spec) or UPPERCASE boolean operators mark it.
 * Lowercase and/or are everyday words and stay plain.
 */
export function isBlockExpression(text: string): boolean {
	return /[();]/.test(text) || /(^|\s)(AND|OR)(\s|$)/.test(text);
}

/**
 * The concept blocks of one query: the single structure that BOTH drives
 * the boolean source search (arXiv, OpenAlex, Semantic Scholar) AND labels
 * the results on_target/adjacent -- search and label cannot disagree. An
 * expression parses via parseGroupSpec ("(river OR stream) AND (mask)"),
 * plain keywords derive one block per content word ("sentinel 2" bindings
 * included). Queries carrying quotes or explicit arXiv field syntax
 * (all:/ti:/abs:/au:/cat:) are the user's own source syntax -- hands off,
 * no blocks (the sources then pass the text through unchanged).
 */
export function queryBlocks(text: string): string[][] {
	if (/"|(?:^|\s)(?:all|ti|abs|au|cat):/i.test(text)) return [];
	return isBlockExpression(text) ? parseGroupSpec(text) : deriveGroupsFromQuery(text);
}

/** Query composed from the wizard's block form; `bothFilled` flags the
 * conflicting state (free text AND blocks entered -- free text wins, the
 * dialog shows a warning). */
export interface BlockFormQuery {
	query: string;
	bothFilled: boolean;
}

/**
 * Compose the search query from the wizard's keyword-block form. A filled
 * free-text field IS the query (blocks ignored, bothFilled set when any
 * block is also filled); otherwise the non-empty block fields serialize to
 * "(b1) AND (b2) ...". Within one field, OR or commas separate synonyms
 * (a stray AND inside a field is read as synonyms too -- one field is one
 * concept by definition). The output is always parenthesized, so
 * queryBlocks() round-trips it to exactly the entered blocks: search and
 * labeling see what the tab showed. Everything empty -> "".
 */
export function queryFromBlockAnswers(blocks: string[], freeText: string): BlockFormQuery {
	const free = freeText.trim();
	const groups = blocks
		.map((field) => parseGroupSpec(field).flat())
		.filter((group) => group.length);
	if (free) return { query: free, bothFilled: groups.length > 0 };
	return { query: formatGroupExpression(groups), bothFilled: false };
}

/**
 * Split a query prefill (agent param, /lit-search argument) for the block
 * form: a block expression becomes one "a OR b" line per block; plain
 * keywords, prose and hands-off syntax (quotes, arXiv field prefixes)
 * return null and belong in the free-text field verbatim.
 */
export function blocksForEditing(query: string): string[] | null {
	if (/"|(?:^|\s)(?:all|ti|abs|au|cat):/i.test(query)) return null;
	if (!isBlockExpression(query)) return null;
	const lines = parseGroupSpec(query).map((group) => group.join(" OR "));
	return lines.length ? lines : null;
}

/** Whether a plain query reads like a PROSE SENTENCE rather than keywords
 * (a full sentence derives into an unsatisfiable many-block AND chain).
 * Deterministic: the user's own boolean/quote/field syntax is never
 * second-guessed; otherwise a derivation of PROSE_BLOCK_THRESHOLD or more
 * blocks marks prose. The wizard's variants tab reacts (distillation rule
 * in the prompt, first suggestion prechecked, warning under the base row). */
const PROSE_BLOCK_THRESHOLD = 6;
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
 * Reorder a variant's concept blocks to the BASE query's concept order, so
 * every suggestion reads in parallel ("Sentinel Water Detection" always
 * yields sensor block first, then water block, then task block) and what
 * the model built is comparable at a glance. AND blocks are commutative,
 * so this is display order only -- fetch and labeling are unchanged. A block is anchored to the FIRST base concept it shares a
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

/** Role of one suggestion in the variants tab. Every generation yields
 * at most one row per role, always in this order: "plus1" = the base
 * query's terms plus at most one synonym per concept block, "plus2" = plus
 * at most two, "arxiv" = the computer-science phrasing arXiv can answer. */
export type VariantRole = "plus1" | "plus2" | "arxiv";
export const VARIANT_ROLES: readonly VariantRole[] = ["plus1", "plus2", "arxiv"];

/** Synonyms a block of the plus1/plus2 rows may add to the base block's
 * own terms, and the fixed per-block term cap of the arXiv row (its terms
 * deliberately differ from the base query, so it has no base to add to). */
const ADDED_SYNONYMS = { plus1: 1, plus2: 2 } as const;
const ARXIV_BLOCK_TERMS = 3;

/** One parsed suggestion and its role. */
export interface VariantSuggestion {
	text: string;
	role: VariantRole;
}

/** Marker the prompt asks the model to put in front of its arXiv/CS
 * phrasing; stripped here and turned into the "arxiv" role. */
const ARXIV_MARKER = /^arxiv\s*:\s*/i;

/**
 * Cap the OR terms of every concept block of one suggestion, so the
 * role's breadth holds whatever the model emitted. plus1/plus2: a block
 * belongs to the first base block it shares a word with (else, with equal
 * block counts, the base block at the same position); that base block's
 * own terms move to the front and stay, then the first N model synonyms
 * follow (N = 1 or 2). A block matching no base block counts as one base
 * term. arxiv: the first ARXIV_BLOCK_TERMS terms per block. Lines without
 * block syntax and hands-off syntax (quotes, field prefixes) pass
 * through untouched. Pure.
 */
export function capVariantBlocks(line: string, baseBlocks: string[][], role: VariantRole): string {
	if (!isBlockExpression(line)) return line;
	const blocks = queryBlocks(line);
	if (!blocks.length) return line;
	const baseWords = baseBlocks.map(blockWords);
	const capped = blocks.map((block, position) => {
		if (role === "arxiv") return block.slice(0, ARXIV_BLOCK_TERMS);
		const words = blockWords(block);
		const anchor = baseWords.findIndex((base) =>
			base.some((baseWord) => words.some((word) => wordMatches(word, baseWord))));
		const baseBlock = anchor !== -1 ? baseBlocks[anchor]!
			: blocks.length === baseBlocks.length ? baseBlocks[position]! : [];
		const own = new Set(baseBlock.map((term) => term.toLowerCase()));
		const ordered = [
			...block.filter((term) => own.has(term.toLowerCase())),
			...block.filter((term) => !own.has(term.toLowerCase())),
		];
		return ordered.slice(0, Math.max(baseBlock.length, 1) + ADDED_SYNONYMS[role]);
	});
	return formatGroupExpression(capped);
}

/** One raw model line -> { arxiv, text }: bullets/numbering, the arXiv
 * marker and surrounding quotes stripped (models add them despite
 * instructions). Empty text = nothing usable on that line. */
function cleanVariantLine(line: string): { arxiv: boolean; text: string } {
	const unbulleted = line
		.trim()
		.replace(/^(?:[-*•]|\d{1,2}[.)])(?:\s+|$)/, "");
	const arxiv = ARXIV_MARKER.test(unbulleted);
	const text = unbulleted
		.replace(ARXIV_MARKER, "")
		.replace(/^["'„“`]+|["'“”`]+$/g, "")
		.trim();
	return { arxiv, text };
}

/**
 * Parse LLM-generated query-variant suggestions into the three role
 * slots: the arXiv-marked line fills "arxiv", the first unmarked line
 * "plus1", the next "plus2"; further lines are ignored. Each line is
 * aligned to the base query's concept order, capped to its role's breadth
 * (capVariantBlocks) and reprinted canonically; duplicates of the base
 * query and of earlier rows drop case-insensitively, and the next line
 * may take the freed slot. Output in role order plus1, plus2, arxiv, empty
 * slots left out. Pure -- the LLM only ever SHAPES queries here, the user
 * checks each one in the dialog before it runs.
 */
export function parseVariantSuggestions(raw: string, baseQuery: string): VariantSuggestion[] {
	const baseBlocks = queryBlocks(baseQuery.trim());
	const seen = new Set([baseQuery.trim().toLowerCase()]);
	const slots = new Map<VariantRole, string>();
	for (const line of raw.split("\n")) {
		const { arxiv, text } = cleanVariantLine(line);
		if (!text) continue;
		const role: VariantRole = arxiv ? "arxiv" : slots.has("plus1") ? "plus2" : "plus1";
		if (slots.has(role)) continue;
		const shaped = capVariantBlocks(alignVariantExpression(text, baseBlocks), baseBlocks, role);
		const key = shaped.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		slots.set(role, shaped);
	}
	return VARIANT_ROLES.flatMap((role) => {
		const text = slots.get(role);
		return text ? [{ text, role }] : [];
	});
}

/**
 * Parse the answer to the follow-up arXiv prompt (arxivVariantPrompt):
 * the first usable line is the arXiv row, marker optional, capped like
 * any arXiv row. null when nothing usable came back or the line repeats
 * the base query or one of `existing` (case-insensitive). Pure.
 */
export function parseArxivSuggestion(raw: string, baseQuery: string, existing: string[]): string | null {
	const baseBlocks = queryBlocks(baseQuery.trim());
	const taken = new Set([baseQuery, ...existing].map((text) => text.trim().toLowerCase()));
	for (const line of raw.split("\n")) {
		const { text } = cleanVariantLine(line);
		if (!text) continue;
		const shaped = capVariantBlocks(alignVariantExpression(text, baseBlocks), baseBlocks, "arxiv");
		return taken.has(shaped.toLowerCase()) ? null : shaped;
	}
	return null;
}
/* ------------------------------------------------------------------ *
 * Awesome-list topics (the code tab's "Curated lists" source)          *
 * ------------------------------------------------------------------ */

/** GitHub topics that name a whole technique or an "awesome" meta list
 * rather than a field: measured 2026-09-13, machine-learning carries 988
 * lists and deep-learning 744, single lists there hold up to 74 000
 * entries -- a run would read for minutes and match noise. Filtered out
 * of the model's suggestions; the user can still type one by hand. */
const GENERIC_LIST_TOPICS = new Set([
	"awesome", "awesome-list", "awesome-lists", "list", "lists", "machine-learning", "deep-learning",
	"artificial-intelligence", "ai", "ml", "python", "data-science", "research", "science", "papers",
	"paper", "github", "software", "tools", "resources",
]);

/** A GitHub topic slug out of free text: lowercase, spaces/underscores to
 * hyphens, anything but letters, digits and hyphens dropped, hyphens
 * collapsed and trimmed. "" when nothing usable remains. Pure. */
export function topicSlug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);
}

export const TOPIC_SYSTEM_PROMPT =
	"You name GitHub topics under which curated \"awesome\" link lists for a research FIELD are filed. "
	+ "You only shape a search; you never produce citations, paper titles, authors or any bibliographic data.";

/**
 * Prompt for the list-topic suggestions: the model sees the concept blocks
 * of the query and names the FIELD's GitHub topics (measured 2026-09-13:
 * awesome lists are filed by field -- remote-sensing, bioinformatics,
 * finance -- never by a research question; block words like "flood" or
 * "water body" find nothing). Pure.
 */
export function topicPrompt(query: string, blocks: string[][], count: number): string {
	const chain = blocks.length ? blocks.map((block) => `(${block.join(" OR ")})`).join(" AND ") : query;
	return [
		`Literature search: ${chain}`,
		"",
		`Name up to ${count} GitHub topics under which curated "awesome" lists for the research FIELD of this search are filed.`,
		"Rules: one topic per line, lowercase, words joined with hyphens (remote-sensing, computational-biology), nothing else on the line.",
		"Name the field or discipline and its established subfields, the way a GitHub list would be tagged -- not the words of the search itself, not a research question.",
		"Skip technique-only or catch-all topics (machine-learning, deep-learning, python, awesome): they hold thousands of unrelated entries.",
		"Order from the most specific field to the broadest.",
	].filter((line) => line !== "").join("\n");
}

/**
 * Topic slugs out of the model's answer: bullets/numbering/quotes/backticks
 * stripped, slugified, generic topics and duplicates dropped, capped.
 * Pure.
 */
export function parseTopicLines(raw: string, cap = 5): string[] {
	const topics: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const cleaned = line
			.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
			.replace(/[`"'„“”‚‘’]/g, "")
			.trim();
		if (!cleaned || /\s.*\s.*\s/.test(cleaned) && cleaned.length > 60) continue;
		const slug = topicSlug(cleaned);
		if (!slug || slug.length < 2 || GENERIC_LIST_TOPICS.has(slug) || topics.includes(slug)) continue;
		topics.push(slug);
		if (topics.length >= cap) break;
	}
	return topics;
}

/** The variant generator only SHAPES queries (the one allowed LLM
 * contribution besides word lists) -- prompts pinned here, English like all
 * model-facing chrome. The suggestions are CONCEPT-BLOCK boolean queries
 * (the systematic-review building-blocks method): OR-synonyms per concept,
 * AND between concepts -- sent as real boolean queries to the sources and
 * labeling their own finds. Every rule below exists because a model broke
 * it in the field; code enforces the structural ones afterwards (role
 * order, synonym caps, block order). */
export const VARIANT_SYSTEM_PROMPT =
	"You build concept-block search queries for academic literature databases (the systematic-review "
	+ "building-blocks method). You only shape search queries; you never produce citations, paper "
	+ "titles, authors or any bibliographic data.";

/** Rules on word choice shared by both variant prompts. Broad homonym
 * blocks ("channel"/"stream") both FETCH noise and LABEL it on_target,
 * so added synonyms must be unambiguous or anchored. */
const VARIANT_TERM_RULES = [
	"Keep the base query's technical SENSE: infer what ambiguous terms mean from the other concepts "
	+ "and stay in that sense (e.g. next to 'water body' and 'satellite', 'extraction' means extracting "
	+ "water surfaces from imagery, NOT water withdrawal or pumping).",
	"Silently correct obvious typos in the base query instead of copying them.",
	"Every added term must be unambiguous in this domain: words with other technical meanings (channel, "
	+ "stream, band, body alone) appear only as anchored phrases (river channel, stream network, water body).",
	"Prefer English terms (the databases index English metadata); if the base query is in another language, "
	+ "translate the concepts to English.",
	"Multi-word terms as plain words, NO quotation marks, no field prefixes.",
];

/** arXiv is a physics/CS/math preprint server: domain jargon yields
 * nothing there, the same need in computer-vision terms does. The row runs
 * against all sources like any other; its Q-label shows what arXiv
 * answered. */
const ARXIV_RULE =
	"The arXiv line is a computer-science / preprint-server phrasing of the same need, the way arXiv "
	+ "machine-learning and computer-vision papers describe it: generic method words (segmentation, "
	+ "classification, mapping, detection, deep learning, CNN) instead of field jargon, the object in plain "
	+ "words (water body, surface water), the sensor as plain sensor names (satellite, Sentinel, Landsat, "
	+ "SAR). At most 3 concept blocks and at most 3 terms per block, no multi-word specialist phrases, and "
	+ "do NOT reuse the base query's specialist terms in it.";

export function variantPrompt(query: string, hint: string, prose: boolean): string {
	// A base query that is itself a block expression is the user's (or the
	// agent's) own hand-built structure -- suggestions must preserve it and
	// vary only the synonyms. Mutually exclusive with `prose` by
	// construction (isProseQuery is false for block expressions).
	const baseBlocks = queryBlocks(query);
	const blockFaithful = isBlockExpression(query) && baseBlocks.length >= 1;
	return [
		`Base query: ${query}`,
		hint ? `User steering hint (follow it within the limits below): ${hint}` : "",
		"",
		"Suggest exactly THREE alternative searches for the same information need, each as a CONCEPT-BLOCK "
		+ "boolean query, one per line, in this order:",
		"Line 1: the base query's own terms plus exactly ONE synonym per concept block.",
		"Line 2: the base query's own terms plus at most TWO synonyms per concept block.",
		"Line 3: the arXiv phrasing described below, starting with the marker 'arXiv: ' (only that line carries a marker).",
		blockFaithful
			? `Format of lines 1 and 2: exactly ${baseBlocks.length} concept block(s) joined with AND; each block's terms joined with OR, in parentheses.`
			: "Format of lines 1 and 2: 2-4 concept blocks joined with AND; each block's terms joined with OR, in parentheses.",
		"Example for the base query 'satellite AND river AND water classification':",
		"(satellite OR remote sensing) AND (river OR river channel) AND (water classification OR water body mapping)",
		"(satellite OR remote sensing OR Sentinel) AND (river OR river channel OR fluvial) AND (water classification OR water body mapping OR water segmentation)",
		"arXiv: (satellite OR Sentinel OR SAR) AND (river OR surface water) AND (segmentation OR classification OR mapping)",
		"In lines 1 and 2, keep the base query's own terms first in every block and add close synonyms only -- "
		+ "no subtopics, no long term lists.",
		blockFaithful
			? "The base query is a hand-built block structure. Preserve it in lines 1 and 2: the SAME number "
			+ "of concept blocks, in the same order, each block covering the SAME concept as the corresponding "
			+ "base block and keeping its terms. Never add, drop, merge or split blocks and never move a "
			+ "concept between blocks. The arXiv line follows its own rule instead."
			: "",
		// Prose base: line 1 must DISTILL the sentence, not vary it -- it
		// arrives prechecked in the tab and carries the default run.
		prose
			? "The base query reads like a prose sentence, not a keyword query. Line 1 must be a faithful "
			+ "distillation of exactly that sentence into concept blocks: cover its core concepts, invent no "
			+ "new aspects, drop only filler words, at most one synonym per block."
			: "",
		// Parallel block order: code aligns afterwards wherever a block shares
		// a word with a base concept (alignBlocksToBase); this rule covers
		// pure-synonym blocks that carry no base word.
		"Order the blocks by the base query's concept order in lines 1 and 2: the block covering the base "
		+ "query's first concept comes first, and so on.",
		...VARIANT_TERM_RULES,
		ARXIV_RULE,
		"Output exactly three lines. No numbering, no bullets, no explanations.",
	].filter(Boolean).join("\n");
}

/** Follow-up prompt when the answer to variantPrompt carried no
 * arXiv-marked line: asks for that one line only. */
export function arxivVariantPrompt(query: string, hint: string): string {
	return [
		`Base query: ${query}`,
		hint ? `User steering hint (follow it within the limits below): ${hint}` : "",
		"",
		"Write ONE alternative search for the same information need as a CONCEPT-BLOCK boolean query: "
		+ "concept blocks joined with AND, each block's terms joined with OR, in parentheses.",
		"Example for the base query 'satellite AND river AND water classification':",
		"arXiv: (satellite OR Sentinel OR SAR) AND (river OR surface water) AND (segmentation OR classification OR mapping)",
		...VARIANT_TERM_RULES,
		ARXIV_RULE,
		"Output exactly one line, starting with 'arXiv: '. No explanations.",
	].filter(Boolean).join("\n");
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
