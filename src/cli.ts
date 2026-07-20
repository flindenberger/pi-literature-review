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
 *
 * Diagnostic subcommands for the synthesis stage -- llm-check resolves the
 * LLM backend config, then round-trips one embedding and a tiny generation
 * against the local server (the only CLI path that talks to a language
 * model); extract shows what the mechanical PDF-to-text step sees:
 *
 *     node src/cli.ts llm-check
 *     node src/cli.ts extract <file.pdf>
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { adoptUnmatched, realAdoptDeps } from "./adopt.ts";
import { runAsk, runAskReport } from "./ask.ts";
import { llmConfig } from "./config.ts";
import { ensureIndexed, matchLibrary, realCorpusDeps } from "./corpus.ts";
import { chunkPages, cleanPageText, extractPdfPages, isExtractionUsable } from "./extract.ts";
import { renderFetchReport, runFetch } from "./fetch.ts";
import { createBackend } from "./llm.ts";
import { runSynthesize, type SynthesizeOptions } from "./synthesize.ts";
import { renderAskDigest, renderAskReportDigest, renderDigest, renderSynthesisDigest } from "./digest.ts";
import { runSearch, SEARCHERS, type SearchOptions } from "./search.ts";
import { parseGroupTerms } from "./intake.ts";
import { outputRoot, writeRunOutputs } from "./output.ts";
import type { ResultFilters, SortKey } from "./pipeline.ts";
import { renderHtml, renderPaperChatReportHtml, renderReviewHtml } from "./render.ts";
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
	warn("or:    node src/cli.ts llm-check");
	warn("       resolves the LLM backend config and round-trips embed + generate");
	warn("or:    node src/cli.ts extract <file.pdf>");
	warn("       shows pages, the usability gate and the chunking for one PDF");
	warn("or:    node src/cli.ts index [--reindex]");
	warn("       matches papers/ against the saved searches and updates the embedding index");
	warn('or:    node src/cli.ts synthesize "<question>" [--papers "a.pdf,b.pdf"] [--model M]');
	warn("       [--embed-model E] [--top-k N] [--language L] [--reindex] [--html [FILE]] [--digest]");
	warn("       grounded synthesis over the local PDF library (citations from verified records);");
	warn("       --html writes pi-literature-review/reviews/<date>_<question>.html + JSON sidecar");
	warn('or:    node src/cli.ts ask "<question>" [--paper <file.pdf>] [--model M] [--embed-model E]');
	warn("       [--top-k N] [--language L] [--reindex] [--digest]");
	warn("       paper chat: answers ONE question about ONE paper with page-exact citations;");
	warn("       --paper omitted = the session's current paper (remembered after each round);");
	warn("       every validated round is appended to pi-literature-review/chats/<date>_<paper>.json");
	warn('or:    node src/cli.ts ask --report --paper <file.pdf> ["<focus>"] [--html [FILE]] [--digest]');
	warn("       grounded summary report built from the session's questions; writes");
	warn("       pi-literature-review/chats/<date>_Paper_chat_report_<paper>.html + JSON sidecar");
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

if (process.argv[2] === "llm-check") {
	// Diagnostic round-trip so every later synthesis step can assume a
	// working backend. Honest failure: an unreachable server or a missing
	// model exits non-zero with the server's own message.
	const cfg = llmConfig();
	warn(`backend  ${cfg.api} at ${cfg.baseUrl}`);
	warn(`generate ${cfg.generateModel}`);
	warn(`embed    ${cfg.embedModel}`);
	const backend = createBackend(cfg);
	try {
		let started = Date.now();
		const [vector] = await backend.embed(["river sandbar detection with Sentinel-2 imagery"]);
		warn(`embed OK: ${vector.length} dimensions in ${Date.now() - started} ms`);
		started = Date.now();
		const reply = await backend.generate(
			"You are a connectivity test. Answer with a single short sentence.",
			"Say that the connection works.",
			{ numCtx: 2048, temperature: 0, maxTokens: 24 },
		);
		warn(`generate OK in ${Date.now() - started} ms: ${reply.trim().replace(/\s+/g, " ").slice(0, 120)}`);
		process.exit(0);
	} catch (error) {
		warn(`llm-check FAILED: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

if (process.argv[2] === "synthesize") {
	// Full pipeline: engine run, then reviews/<date>_<question>.html + JSON
	// sidecar (--html), console text or the agent-facing digest (--digest).
	const argv = process.argv.slice(3);
	const options: SynthesizeOptions = { question: "", onWarn: warn };
	let synthHtml: string | undefined;
	let synthDigest = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--html") {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				synthHtml = next.trim();
				i++;
				if (!synthHtml) usage();
			} else {
				synthHtml = "";
			}
		} else if (arg === "--digest") {
			synthDigest = true;
		} else if (arg === "--papers") {
			options.papers = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			if (!options.papers.length) usage();
		} else if (arg === "--model") {
			options.model = (argv[++i] ?? "").trim() || undefined;
		} else if (arg === "--embed-model") {
			options.embedModel = (argv[++i] ?? "").trim() || undefined;
		} else if (arg === "--top-k") {
			options.topK = parseIntArg(argv[++i]);
		} else if (arg === "--language") {
			options.language = (argv[++i] ?? "").trim() || undefined;
		} else if (arg === "--reindex") {
			options.reindex = true;
		} else if (!options.question && !arg.startsWith("-")) {
			options.question = arg;
		} else {
			usage();
		}
	}
	if (!options.question.trim()) usage();
	// The digest is the agent-facing view, and the tool always writes the
	// HTML/JSON pair -- so --digest implies --html (default location).
	if (synthDigest && synthHtml === undefined) synthHtml = "";
	const result = await runSynthesize(options);
	let htmlPath: string | null = null;
	if (synthHtml !== undefined) {
		const written = writeRunOutputs(renderReviewHtml(result), result, synthHtml || undefined, "reviews");
		htmlPath = written.htmlPath;
		warn(`wrote HTML review to ${written.htmlPath}`);
		warn(`wrote JSON copy to ${written.jsonPath}`);
	}
	if (synthDigest) {
		process.stdout.write(`${renderSynthesisDigest(result, htmlPath)}\n`);
		process.exit(0);
	}
	const lines: string[] = [];
	lines.push(result.grounded
		? `Synthesis grounded: ${result.references.length} reference(s) from ${result.papers_cited} paper(s).`
		: "Synthesis FAILED to ground: 0 valid citations. The draft below must not be used as a review.");
	lines.push("");
	lines.push(result.prose);
	if (result.references.length) {
		lines.push("");
		lines.push("References (verified records):");
		for (const reference of result.references) {
			const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}` : reference.key);
			lines.push(`[${reference.n}] ${reference.year ?? "n.d."} | ${id} | ${reference.title} (pages ${reference.pages.join(", ")})`);
		}
	}
	lines.push("");
	lines.push(`model ${result.model}; embeddings ${result.embedding_model}; top-k ${result.top_k}; `
		+ `${result.chunks.length} excerpt(s); ${result.invalid_markers.length} invalid marker(s) stripped; `
		+ `${result.unmarked_sentences} unmarked sentence(s); reference section cut: ${result.stripped_reference_section ? "yes" : "no"}`);
	if (result.unmatched_pdfs.length) lines.push(`excluded (no verified record): ${result.unmatched_pdfs.join(", ")}`);
	for (const failure of result.extraction_failures) lines.push(`excluded (${failure.reason}): ${failure.file}`);
	process.stdout.write(`${lines.join("\n")}\n`);
	process.exit(0);
}

if (process.argv[2] === "ask") {
	// Paper chat: one question about ONE paper; --report builds the grounded
	// session summary instead (and always writes the HTML pair into chats/).
	const argv = process.argv.slice(3);
	let question = "";
	let paper: string | undefined;
	let model: string | undefined;
	let embedModel: string | undefined;
	let topK: number | undefined;
	let language: string | undefined;
	let report = false;
	let reindex = false;
	let askHtml: string | undefined;
	let askDigest = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--paper") {
			paper = (argv[++i] ?? "").trim() || undefined;
			if (!paper) usage();
		} else if (arg === "--model") {
			model = (argv[++i] ?? "").trim() || undefined;
		} else if (arg === "--embed-model") {
			embedModel = (argv[++i] ?? "").trim() || undefined;
		} else if (arg === "--top-k") {
			topK = parseIntArg(argv[++i]);
		} else if (arg === "--language") {
			language = (argv[++i] ?? "").trim() || undefined;
		} else if (arg === "--report") {
			report = true;
		} else if (arg === "--reindex") {
			reindex = true;
		} else if (arg === "--html") {
			// Report mode only (question mode writes no files).
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				askHtml = next.trim();
				i++;
				if (!askHtml) usage();
			} else {
				askHtml = "";
			}
		} else if (arg === "--digest") {
			askDigest = true;
		} else if (!question && !arg.startsWith("-")) {
			question = arg;
		} else {
			usage();
		}
	}
	if (!report && !question.trim()) usage();

	if (report) {
		const result = await runAskReport({
			question: question.trim() || undefined,
			paper, model, embedModel, language, reindex, onWarn: warn,
		});
		const written = writeRunOutputs(renderPaperChatReportHtml(result), result, askHtml || undefined, "chats");
		warn(`wrote HTML report to ${written.htmlPath}`);
		warn(`wrote JSON copy to ${written.jsonPath}`);
		process.stdout.write(`${renderAskReportDigest(result, written.htmlPath)}\n`);
		process.exit(0);
	}

	const answer = await runAsk({
		question, paper, model, embedModel, topK, language, reindex, onWarn: warn,
	});
	if (askDigest) {
		process.stdout.write(`${renderAskDigest(answer)}\n`);
		process.exit(0);
	}
	const lines: string[] = [];
	lines.push(answer.grounded
		? `Answer grounded: ${answer.references.length} reference(s), ${answer.chunks.length} excerpt(s) from ${answer.paper.base}.pdf.`
		: "Answer FAILED to ground: 0 valid citations. The draft below must not be used as an answer.");
	lines.push("");
	lines.push(answer.prose);
	if (answer.references.length) {
		lines.push("");
		lines.push("References (verified records):");
		for (const reference of answer.references) {
			const id = reference.doi || (reference.arxiv_id ? `arXiv:${reference.arxiv_id}` : reference.key);
			lines.push(`[${reference.n}] ${reference.year ?? "n.d."} | ${id} | ${reference.title} (S. ${reference.pages.join(", ")})`);
		}
	}
	lines.push("");
	lines.push(`model ${answer.model}; embeddings ${answer.embedding_model}; top-k ${answer.top_k}; `
		+ `${answer.chunks.length} excerpt(s); ${answer.invalid_markers.length} invalid marker(s) stripped; `
		+ `${answer.unmarked_sentences} unmarked sentence(s); reference section cut: ${answer.stripped_reference_section ? "yes" : "no"}`);
	if (answer.protocol_path) warn(`chat round ${answer.round} recorded in ${answer.protocol_path}`);
	process.stdout.write(`${lines.join("\n")}\n`);
	process.exit(0);
}

if (process.argv[2] === "index") {
	// Library matching + embedding index, exactly as the synthesis tool will
	// run it. Real deps here; the engine logic itself is tested offline.
	const force = process.argv.includes("--reindex");
	const root = outputRoot();
	let match = matchLibrary(root, warn);
	warn(`papers found in ${match.papersDir}`);
	// Loose PDFs get an adoption attempt (identifier from the PDF text,
	// verified API lookup) before anything is declared unmatched.
	if (match.unmatched.length) {
		const adoptions = await adoptUnmatched(match.unmatched, match.papersDir, realAdoptDeps(), warn);
		for (const adoption of adoptions) {
			warn(`${adoption.status === "adopted" ? "adopted" : "not adopted"}: ${adoption.file} -- ${adoption.detail}`);
		}
		if (adoptions.some((adoption) => adoption.status === "adopted")) match = matchLibrary(root, warn);
	}
	const { matched, unmatched } = match;
	warn(`library: ${matched.length} paper(s) with verified metadata, ${unmatched.length} unmatched`);
	for (const file of unmatched) {
		warn(`unmatched (excluded from synthesis, no verified identity): ${file}`);
	}
	if (!matched.length) {
		warn("nothing to index");
		process.exit(0);
	}
	const cfg = llmConfig();
	const backend = createBackend(cfg);
	const indexDir = join(root, "index");
	mkdirSync(indexDir, { recursive: true });
	const deps = realCorpusDeps((texts, signal) => backend.embed(texts, signal));
	const { indexes, failures } = await ensureIndexed(matched, indexDir, cfg.embedModel, deps, {
		force,
		onProgress: warn,
	});
	for (const failure of failures) warn(`excluded: ${failure.file} -- ${failure.reason}`);
	const chunkCount = indexes.reduce((sum, index) => sum + index.chunks.length, 0);
	warn(`index ready: ${indexes.length} paper(s), ${chunkCount} chunks (${cfg.embedModel}) in ${indexDir}`);
	process.exit(0);
}

if (process.argv[2] === "extract") {
	// Diagnostic view of the mechanical PDF-to-text step: what the synthesis
	// stage would index for this file, or the honest no_text verdict.
	const file = (process.argv[3] ?? "").trim();
	if (!file) usage();
	const pages = (await extractPdfPages(readFileSync(file))).map(cleanPageText);
	const letters = pages.reduce((sum, page) => sum + (page.match(/\p{L}/gu) ?? []).length, 0);
	warn(`${pages.length} page(s), ${letters} letters after cleanup`);
	if (!isExtractionUsable(pages)) {
		warn("verdict: no_text -- no usable text layer (likely scanned); this paper would be excluded from synthesis");
		process.exit(1);
	}
	const chunks = chunkPages(pages);
	warn(`verdict: usable -- ${chunks.length} chunk(s)`);
	for (const [i, chunk] of chunks.slice(0, 3).entries()) {
		warn(`chunk ${i + 1} (page ${chunk.page}, ${chunk.text.length} chars): ${chunk.text.slice(0, 160)}...`);
	}
	process.exit(0);
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
