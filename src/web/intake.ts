/**
 * The web search form as engine input: the browser posts the form's
 * values as plain JSON, this module turns them into SearchOptions +
 * filters with the same rules the terminal wizard applies (block query
 * composition, period presets, source caps, opt-in filters). Pure; every
 * rejected value is reported as a warning, never silently applied.
 */

import { CODE_SEARCHERS } from "../codesearch.ts";
import {
	type BlockFormQuery,
	parsePerSource,
	parseYearRange,
	queryFromBlockAnswers,
	topicSlug,
} from "../intake.ts";
import type { ResultFilters } from "../pipeline.ts";
import { DEFAULT_PER_SOURCE, MAX_AUTHOR_WORKS_PER_SOURCE, MAX_PER_SOURCE, SEARCHERS, type SearchOptions } from "../search.ts";

/** Concept blocks the query form offers by default and at most. */
export const QUERY_BLOCK_MIN = 5;
export const QUERY_BLOCK_MAX = 8;

/** What the browser posts. Every field optional; unknown fields ignored. */
export interface SearchForm {
	blocks?: string[];
	freeText?: string;
	variants?: string[];
	/** "all" | "5y" | "10y" | "20y" | "custom" */
	period?: string;
	yearFrom?: string | number;
	yearTo?: string | number;
	perSource?: string | number;
	sources?: string[];
	codeSources?: string[];
	codeTopics?: string[];
	minCites?: string | number;
	journals?: string[];
	journalsOther?: boolean;
	journalsListed?: string[];
	authors?: string[];
	authorsOther?: boolean;
	authorsListed?: string[];
	pickedAuthors?: Array<{ id: string; name: string }>;
	authorPosition?: "first" | "contributing" | "any";
	authorScope?: "query" | "all";
}

export interface IntakeResult {
	options: SearchOptions;
	warnings: string[];
	/** The composed query, for the response and the file name. */
	query: BlockFormQuery;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** Resolve the period choice into a year range (same presets as the
 * wizard: last 5/10/20 years = this year minus 4/9/19). Null = the custom
 * range did not parse. */
export function periodRange(form: SearchForm, thisYear = new Date().getFullYear()): { yearFrom?: number; yearTo?: number } | null {
	const period = text(form.period) || "all";
	const lastYears: Record<string, number> = { "5y": 4, "10y": 9, "20y": 19 };
	if (period in lastYears) return { yearFrom: thisYear - lastYears[period] };
	if (period === "all") return {};
	const from = text(form.yearFrom);
	const to = text(form.yearTo);
	if (!from && !to) return {};
	return parseYearRange(from && to ? `${from}-${to}` : from ? `${from}-` : `-${to}`);
}

export function intakeFromForm(form: SearchForm, thisYear = new Date().getFullYear()): IntakeResult {
	const warnings: string[] = [];
	const query = queryFromBlockAnswers(strings(form.blocks).slice(0, QUERY_BLOCK_MAX), text(form.freeText));
	const filters: ResultFilters = {};

	const range = periodRange(form, thisYear);
	if (range === null) {
		warnings.push("year range not understood -- searching all years");
	} else {
		filters.yearFrom = range.yearFrom;
		filters.yearTo = range.yearTo;
	}

	let perSource: number | undefined;
	const countSpec = text(form.perSource);
	// A search of picked authors' works without a query may ask for more.
	const authorsOnly = !query.query && form.authorScope === "all" && Array.isArray(form.pickedAuthors) && form.pickedAuthors.length > 0;
	const cap = authorsOnly ? MAX_AUTHOR_WORKS_PER_SOURCE : MAX_PER_SOURCE;
	if (countSpec) {
		const parsed = parsePerSource(countSpec, cap);
		if (parsed === null) warnings.push(`records per source "${countSpec}" not understood -- using ${DEFAULT_PER_SOURCE}`);
		else {
			if (String(parsed) !== countSpec) warnings.push(`capped at ${cap} records per source (consideration for the free APIs)`);
			perSource = parsed;
		}
	}

	const sources = strings(form.sources).filter((source) => source in SEARCHERS);
	const codeSources = strings(form.codeSources).filter((source) => source in CODE_SEARCHERS);
	const codeTopics = [...new Set(strings(form.codeTopics).map(topicSlug).filter(Boolean))];

	const minCitesSpec = text(form.minCites);
	if (minCitesSpec) {
		if (/^\d+$/.test(minCitesSpec)) filters.minCites = Number(minCitesSpec);
		else warnings.push(`minimum citations "${minCitesSpec}" not understood -- filter stays off`);
	}

	// Journals: ticked names; the "other" row means everything outside the
	// listed head passes too. Every row ticked = no filter.
	const journals = strings(form.journals);
	const journalsListed = strings(form.journalsListed);
	const journalsOther = form.journalsOther === true;
	if (journals.length && !(journalsOther && journals.length >= journalsListed.length)) {
		filters.venues = journals;
		filters.venuesExact = true;
		if (journalsOther && journalsListed.length) {
			filters.venuesOther = true;
			filters.venuesListed = journalsListed;
		}
	}

	// Authors: picked from the lookup (exact ids) win over the listed rows.
	const picked = Array.isArray(form.pickedAuthors)
		? form.pickedAuthors.filter((entry) => entry && typeof entry.id === "string" && typeof entry.name === "string" && /^A\d+$/.test(entry.id.trim()))
			.map((entry) => ({ id: entry.id.trim(), name: entry.name.trim() }))
			.filter((entry) => entry.name)
		: [];
	let authorIds: string[] | undefined;
	let authorScope: "query" | "all" | undefined;
	if (picked.length) {
		filters.pickedAuthors = picked.map((entry) => entry.name);
		authorIds = picked.map((entry) => entry.id);
		if (form.authorPosition === "first" || form.authorPosition === "contributing") filters.authorPosition = form.authorPosition;
		if (form.authorScope === "all") authorScope = "all";
	} else {
		const authors = strings(form.authors);
		const authorsListed = strings(form.authorsListed);
		const authorsOther = form.authorsOther === true;
		if (authors.length && !(authorsOther && authors.length >= authorsListed.length)) {
			filters.authors = authors;
			if (authorsOther && authorsListed.length) {
				filters.authorsOther = true;
				filters.authorsListed = authorsListed;
			}
		}
	}

	const variants = strings(form.variants).filter((variant) => variant.toLowerCase() !== query.query.toLowerCase());
	const options: SearchOptions = {
		query: query.query,
		queryVariants: variants.length ? variants : undefined,
		perSource,
		sources: sources.length ? sources : undefined,
		// No groupTerms: the engine derives every query's blocks itself (the
		// block expression round-trips), exactly as the wizard's base query.
		filters,
		codeSources: codeSources.length ? codeSources : undefined,
		codeListTopics: codeSources.includes("awesome-lists") && codeTopics.length ? codeTopics : undefined,
		authorIds,
		authorScope,
		enrich: true,
	};
	return { options, warnings, query };
}
