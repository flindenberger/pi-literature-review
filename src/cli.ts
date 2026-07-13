/**
 * Standalone CLI for testing and oracle comparison. Mirrors the Python
 * oracle's contract:
 *
 *     node src/cli.ts "<query>" [-n PER_SOURCE] [-s SOURCES] [-g GROUPS]
 *
 * GROUPS are the deterministic grouping rules: term groups separated by
 * ';', terms within a group by ','. Example (the WP1 sandbar rules):
 *
 *     -g "river,fluvial;sandbar,bar;sentinel,s-1,s-2"
 *
 * Clean JSON to stdout; warnings and diagnostics to stderr. A failing
 * source degrades gracefully and never crashes the run.
 *
 * Second subcommand -- deterministic PDF retrieval into the papers/ library:
 *
 *     node src/cli.ts fetch <DOI-or-arXiv-ID> [more ...]
 */

import { renderFetchReport, runFetch } from "./fetch.ts";
import { renderDigest } from "./digest.ts";
import { runSearch, SEARCHERS, type SearchOptions } from "./search.ts";
import { parseGroupTerms } from "./intake.ts";
import { writeRunOutputs } from "./output.ts";
import type { ResultFilters, SortKey } from "./pipeline.ts";
import { renderHtml } from "./render.ts";
import { warn } from "./types.ts";

interface CliArgs {
	query: string;
	variants: string[];
	perSource: number | undefined;
	sources: string[] | undefined;
	groupTerms: string[][] | undefined;
	filters: ResultFilters;
	sort: SortKey | undefined;
	htmlFile: string | undefined;
	enrich: boolean;
	digest: boolean;
}

function usage(): never {
	warn('usage: node src/cli.ts "<query>" [-n PER_SOURCE] [-s SOURCES] [-g "a,b;c,d"]');
	warn("       [--min-cites N] [--year-from YYYY] [--year-to YYYY] [--venues \"a,b\"]");
	warn("       [--require-pdf] [--verified-only] [--sort cites|year] [--html [FILE]] [--no-enrich]");
	warn("       [--variant \"...\" (repeatable)] [--digest]");
	warn("       --html without FILE writes to pi-literature-review/queries/<date>_<query>.html");
	warn("       (the full JSON payload is always written next to the HTML, same basename)");
	warn("       --variant adds an alternative phrasing; results are deduplicated across variants");
	warn("       --digest prints the agent-facing digest instead of JSON (combine with --html for real paths)");
	warn(`available sources: ${Object.keys(SEARCHERS).join(", ")}`);
	warn("or:    node src/cli.ts fetch <DOI-or-arXiv-ID> [more ...]");
	warn("       downloads legal open-access PDFs into pi-literature-review/papers/");
	process.exit(2);
}

function parseIntArg(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "", 10);
	if (!Number.isInteger(parsed) || parsed < 0) usage();
	return parsed;
}

function parseArgs(argv: string[]): CliArgs {
	let query = "";
	const variants: string[] = [];
	let perSource: number | undefined;
	let sources: string[] | undefined;
	let groupTerms: string[][] | undefined;
	let sort: SortKey | undefined;
	let htmlFile: string | undefined;
	let enrich = true;
	let digest = false;
	const filters: ResultFilters = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-n" || arg === "--per-source") {
			perSource = parseIntArg(argv[++i]);
			if (perSource < 1) usage();
		} else if (arg === "-s" || arg === "--sources") {
			sources = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			if (!sources.length) usage();
		} else if (arg === "-g" || arg === "--group-terms") {
			groupTerms = parseGroupTerms(argv[++i] ?? "");
			if (!groupTerms.length) usage();
		} else if (arg === "--min-cites") {
			filters.minCites = parseIntArg(argv[++i]);
		} else if (arg === "--year-from") {
			filters.yearFrom = parseIntArg(argv[++i]);
		} else if (arg === "--year-to") {
			filters.yearTo = parseIntArg(argv[++i]);
		} else if (arg === "--venues") {
			filters.venues = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			if (!filters.venues.length) usage();
		} else if (arg === "--require-pdf") {
			filters.requirePdf = true;
		} else if (arg === "--verified-only") {
			filters.verifiedOnly = true;
		} else if (arg === "--sort") {
			const value = argv[++i];
			if (value !== "cites" && value !== "year") usage();
			sort = value;
		} else if (arg === "--html") {
			// Optional FILE: without one (or followed by another flag), the
			// deterministic default location is used.
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				htmlFile = next.trim();
				i++;
				if (!htmlFile) usage();
			} else {
				htmlFile = "";
			}
		} else if (arg === "--variant") {
			const variant = (argv[++i] ?? "").trim();
			if (!variant) usage();
			variants.push(variant);
		} else if (arg === "--no-enrich") {
			enrich = false;
		} else if (arg === "--digest") {
			digest = true;
		} else if (!query && !arg.startsWith("-")) {
			query = arg;
		} else {
			usage();
		}
	}
	if (!query) usage();
	return { query, variants, perSource, sources, groupTerms, filters, sort, htmlFile, enrich, digest };
}

if (process.argv[2] === "fetch") {
	// Identifiers may arrive comma-separated (pasted chat sentence) or as
	// separate arguments; both spellings end up as one clean list.
	const identifiers = process.argv.slice(3)
		.flatMap((chunk) => chunk.split(","))
		.map((s) => s.trim())
		.filter(Boolean);
	if (!identifiers.length) usage();
	const { results, papersDir } = await runFetch({ identifiers, onWarn: warn });
	process.stdout.write(`${renderFetchReport(results, papersDir)}\n`);
	process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const options: SearchOptions = {
	query: args.query,
	queryVariants: args.variants,
	perSource: args.perSource,
	sources: args.sources,
	groupTerms: args.groupTerms,
	filters: args.filters,
	sort: args.sort,
	enrich: args.enrich,
	onWarn: warn,
};
const payload = await runSearch(options);
let htmlPath: string | null = null;
if (args.htmlFile !== undefined) {
	const written = writeRunOutputs(renderHtml(payload), payload, args.htmlFile || undefined);
	htmlPath = written.htmlPath;
	warn(`wrote HTML rendering to ${written.htmlPath}`);
	warn(`wrote JSON copy to ${written.jsonPath}`);
}
process.stdout.write(
	args.digest ? `${renderDigest(payload, htmlPath)}\n` : `${JSON.stringify(payload, null, 2)}\n`,
);
