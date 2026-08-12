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
 * Second subcommand -- deterministic PDF retrieval into the lit-selection/ library:
 *
 *     node src/cli.ts selection <DOI-or-arXiv-ID> [more ...]
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
import { runChatReport, runReport, runRound } from "./synthesis.ts";
import { configPath, llmConfig } from "./config.ts";
import { ensureIndexed, matchLibrary, realCorpusDeps, unmatchedGroups } from "./corpus.ts";
import { chunkPages, cleanPageText, extractPdfPages, isExtractionUsable } from "./extract.ts";
import { renderFetchReport, runSelection } from "./selection.ts";
import { createBackend } from "./llm.ts";
import { runSynthesis, type SynthesisOptions } from "./synthesis.ts";
import { renderChatDigest, renderChatReportDigest, renderDigest, renderReportDigest, renderSynthesisDigest } from "./digest.ts";
import { runSearch, SEARCHERS, type SearchOptions } from "./search.ts";
import { parseGroupTerms } from "./intake.ts";
import { writeNetworkPage } from "./network.ts";
import { outputRoot, writeRunOutputs } from "./output.ts";
import { readCurrentScope } from "./protocol.ts";
import { resolvePiSessionId } from "./pisession.ts";
import type { ResultFilters, SortKey } from "./pipeline.ts";
import { renderHtml, renderPaperChatReportHtml, renderReviewHtml, renderSynthReportHtml } from "./render.ts";
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
	warn("       --html without FILE writes to lit-search/<date>_<query>.html in the working directory");
	warn("       (the full JSON payload is always written next to the HTML, same basename)");
	warn("       --variant adds an alternative phrasing; results are deduplicated across variants");
	warn("       --digest prints the agent-facing digest instead of JSON (combine with --html for real paths)");
	warn(`available sources: ${Object.keys(SEARCHERS).join(", ")}`);
	warn("or:    node src/cli.ts selection <DOI-or-arXiv-ID> [more ...]");
	warn("       downloads legal open-access PDFs into lit-selection/ in the working directory");
	warn("or:    node src/cli.ts llm-check");
	warn("       resolves the LLM backend config and round-trips embed + generate");
	warn("or:    node src/cli.ts extract <file.pdf>");
	warn("       shows pages, the usability gate and the chunking for one PDF");
	warn("or:    node src/cli.ts index [--reindex]");
	warn("       matches lit-selection/ against the saved searches and updates the embedding index");
	warn('or:    node src/cli.ts synthesis "<question>" [--paper <file.pdf>] [--session ID] [--model M]');
	warn("       [--embed-model E] [--top-k N] [--language L] [--reindex] [--digest]");
	warn("       one grounded chat round about ONE paper (page-exact citations; sticky paper");
	warn("       of the session when --paper is omitted); recorded in lit-synthesis/protocols/<date>_<paper>.json");
	warn('or:    node src/cli.ts synthesis --report [--papers "a.pdf,b.pdf" | --all | --paper X]');
	warn('       [--questions "q1;q2"] [--summary bullets|prose] [--detail-mode per-paper|cross-paper]');
	warn("       [--review] [--session ID] [--model M] [--embed-model E] [--top-k N] [--language L]");
	warn("       [--ui-language de|en] [--reindex] [--html [FILE]] [--digest]");
	warn("       composable report: per-paper summaries, detail questions (mode A per paper /");
	warn("       mode B cross-paper), optional review synthesis; writes lit-synthesis/<date>_Report_...html");
	warn('or:    node src/cli.ts synthesis --session-report [--paper <file.pdf>] ["<focus>"] [--session ID]');
	warn("       [--html [FILE]] [--digest]");
	warn("       grounded summary of ONE pi session's chat rounds (the classic session report)");
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
	// Name the config file first -- "where does this setting come from?" is
	// the question every failed check raises (2026-08-11 user find). Each
	// role prints ITS backend (they may be split since 2026-08-11).
	warn(`config   ${configPath()} (env PI_LITERATURE_REVIEW_* overrides)`);
	warn(`embed    ${cfg.embedModel} (${cfg.embedApi ?? cfg.api} at ${cfg.embedBaseUrl || cfg.baseUrl})`);
	warn(`generate ${cfg.generateModel} (${cfg.generateApi ?? cfg.api} at ${cfg.generateBaseUrl || cfg.baseUrl})`);
	warn("note     inside the pi agent, chat and summaries run on the model selected there; llm.generateModel (when set) handles the review genres -- any capable chat model works, see the README");
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

if (["synthesize", "chat", "synth"].includes(process.argv[2] ?? "")) {
	warn(`the "${process.argv[2]}" subcommand is now "synthesis" (v31; "synthesize"/"chat" merged in v25) -- see usage`);
	usage();
}

if (process.argv[2] === "synthesis") {
	// The fused stage (v25): one grounded round, the composable report
	// (--report) or the classic session report (--session-report).
	const argv = process.argv.slice(3);
	let question = "";
	let paper: string | undefined;
	let papers: string[] | undefined;
	let all = false;
	let questionsArg: string[] = [];
	let summary: "bullets" | "prose" | undefined;
	let detailMode: "per-paper" | "cross-paper" | undefined;
	let review = false;
	let session: string | undefined;
	let model: string | undefined;
	let embedModel: string | undefined;
	let topK: number | undefined;
	let language: string | undefined;
	let uiLanguage: string | undefined;
	let report = false;
	let sessionReport = false;
	let reindex = false;
	let htmlArg: string | undefined;
	let digest = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--paper") {
			paper = (argv[++i] ?? "").trim() || undefined;
			if (!paper) usage();
		} else if (arg === "--papers") {
			papers = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			if (!papers.length) usage();
		} else if (arg === "--all") {
			all = true;
		} else if (arg === "--questions") {
			questionsArg = (argv[++i] ?? "").split(";").map((s) => s.trim()).filter(Boolean);
		} else if (arg === "--summary") {
			const value = (argv[++i] ?? "").trim();
			if (value !== "bullets" && value !== "prose") usage();
			summary = value;
		} else if (arg === "--detail-mode") {
			const value = (argv[++i] ?? "").trim();
			if (value !== "per-paper" && value !== "cross-paper") usage();
			detailMode = value;
		} else if (arg === "--review") {
			review = true;
		} else if (arg === "--session") {
			session = (argv[++i] ?? "").trim() || undefined;
			if (!session) usage();
		} else if (arg === "--model") {
			model = (argv[++i] ?? "").trim() || undefined;
		} else if (arg === "--embed-model") {
			embedModel = (argv[++i] ?? "").trim() || undefined;
		} else if (arg === "--top-k") {
			topK = parseIntArg(argv[++i]);
		} else if (arg === "--language") {
			language = (argv[++i] ?? "").trim() || undefined;
		} else if (arg === "--ui-language") {
			uiLanguage = (argv[++i] ?? "").trim() || undefined;
		} else if (arg === "--report") {
			report = true;
		} else if (arg === "--session-report") {
			sessionReport = true;
		} else if (arg === "--reindex") {
			reindex = true;
		} else if (arg === "--html") {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				htmlArg = next.trim();
				i++;
				if (!htmlArg) usage();
			} else {
				htmlArg = "";
			}
		} else if (arg === "--digest") {
			digest = true;
		} else if (!question && !arg.startsWith("-")) {
			question = arg;
		} else {
			usage();
		}
	}

	// Session scoping (v23): sticky scope and session rounds belong to ONE
	// pi session; the CLI resolves the newest session of this folder.
	if (!session) {
		session = resolvePiSessionId(process.cwd()) ?? undefined;
		warn(session
			? `scoping to the newest pi session of this folder: ${session} (--session overrides)`
			: "no pi session found for this folder -- no sticky scope; reports cover no prior rounds");
	}

	if (sessionReport) {
		const result = await runChatReport({
			question: question.trim() || undefined,
			paper, session, model, embedModel, language, reindex, onWarn: warn,
		});
		const written = writeRunOutputs(renderPaperChatReportHtml(result), result, htmlArg || undefined, "lit-synthesis");
		warn(`wrote HTML report to ${written.htmlPath}`);
		warn(`wrote JSON copy to ${written.jsonPath}`);
		process.stdout.write(`${renderChatReportDigest(result, written.htmlPath)}\n`);
		process.exit(0);
	}

	if (report) {
		// Scope: --all > --papers > --paper > the session's sticky scope.
		let scope: string[] | "library" | undefined = all ? "library" : papers ?? (paper ? [paper] : undefined);
		if (!scope) {
			const sticky = readCurrentScope(outputRoot(), session ?? null);
			if (sticky) {
				scope = sticky.papers;
				warn(`using the session's sticky scope: ${scope === "library" ? "whole library" : scope.join(", ")}`);
			}
		}
		if (!scope) {
			warn("no scope -- pass --papers, --paper or --all (no sticky scope in this session)");
			usage();
		}
		const result = await runReport({
			papers: scope,
			questions: questionsArg.length ? questionsArg : question.trim() ? [question.trim()] : [],
			summary,
			detailMode,
			includeReview: review,
			session, model, embedModel, topK, language, uiLanguage, reindex,
			onWarn: warn,
			onProgress: warn,
		});
		const written = writeRunOutputs(renderSynthReportHtml(result), result, htmlArg || undefined, "lit-synthesis");
		warn(`wrote HTML report to ${written.htmlPath}`);
		warn(`wrote JSON copy to ${written.jsonPath}`);
		process.stdout.write(`${renderReportDigest(result, written.htmlPath)}\n`);
		process.exit(0);
	}

	if (!question.trim()) usage();
	const answer = await runRound({
		question, paper, session, model, embedModel, topK, language, reindex, onWarn: warn,
	});
	if (digest) {
		process.stdout.write(`${renderChatDigest(answer)}\n`);
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
	warn(`papers found in ${(match.dirs ?? [match.papersDir]).join(", ")}`);
	// Loose PDFs get an adoption attempt (identifier from the PDF text,
	// verified API lookup) before anything is declared unmatched.
	if (match.unmatched.length) {
		const adoptions: Awaited<ReturnType<typeof adoptUnmatched>> = [];
		for (const group of unmatchedGroups(match)) {
			adoptions.push(...await adoptUnmatched(group.files, group.dir, realAdoptDeps(), warn));
		}
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
	const indexDir = join(root, "lit-synthesis", "index");
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

if (process.argv[2] === "selection" || process.argv[2] === "fetch") {
	// Identifiers may arrive comma-separated (pasted chat sentence) or as
	// separate arguments; both spellings end up as one clean list.
	const identifiers = process.argv.slice(3)
		.flatMap((chunk) => chunk.split(","))
		.map((s) => s.trim())
		.filter(Boolean);
	if (!identifiers.length) usage();
	const { results, papersDir } = await runSelection({ identifiers, onWarn: warn });
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
	const written = writeRunOutputs(renderHtml(payload, { network: true }), payload, args.htmlFile || undefined);
	htmlPath = written.htmlPath;
	writeNetworkPage(written.htmlPath);
	warn(`wrote HTML rendering to ${written.htmlPath}`);
	warn(`wrote JSON copy to ${written.jsonPath}`);
}
process.stdout.write(
	args.digest ? `${renderDigest(payload, htmlPath)}\n` : `${JSON.stringify(payload, null, 2)}\n`,
);
