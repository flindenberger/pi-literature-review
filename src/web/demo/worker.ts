/**
 * The browser demo's server: the unchanged web server (server.ts) started
 * inside a Web Worker of the visitor's browser. The demo build replaces
 * Node's modules with small stand-ins (runtime/shims: files in memory, a
 * request hand-over instead of a network port); the Service Worker
 * (runtime/sw.js) hands the page's requests to it. There is no model:
 * the search needs none; the paper chat plays back ONE recorded chat over
 * an example paper (example/*.json, made by capture.ts from a real run of
 * the installed version), and every other question asks for the
 * installation.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { LibraryMatch, LibraryPaper } from "../../corpus.ts";
import { endpointProvider, type ModelProvider } from "../../provider.ts";
import type { ChatAnswer, SynthReport } from "../../synthesis.ts";
import { startWebServer, type WebServer } from "../server.ts";

export const DEMO_TOKEN = "demo";
const NO_MODEL = "no model in the browser demo";
const STORE = "/demo/store";
const PAPERS = "/demo/papers";
/** The example the demo plays back, below the demo's folder. */
export const EXAMPLE_FILE = "examples/blanch-2026.json";
const PLACEHOLDER = "{PDF}";
/** A played-back answer arrives after this pause, not instantly. */
const REPLAY_PAUSE_MS = 900;

export const OWN_QUESTION = "Your own questions need a model: install pi-literature-review to ask anything about your PDFs.";

/** The recording as capture.ts wrote it. */
export interface DemoExample {
	recordedWith: string;
	recordedAt: string;
	pdf: { name: string; url: string; sha256: string; bytes: number; license: string };
	paper: { base: string; key: string; entry: LibraryPaper["entry"] };
	index: Record<string, unknown> & { paper: unknown; chunks: unknown[] };
	questions: string[];
	answers: ChatAnswer[];
	report: SynthReport;
}

/** The provider of a browser without a model: status says so, every
 * model call refuses. */
export function demoProvider(): ModelProvider {
	const base = endpointProvider({ baseUrl: "", api: "ollama", generateModel: "", embedModel: "" });
	return {
		...base,
		status: () => ({ kind: "endpoint", model: null, via: NO_MODEL, embeddings: "", embeddingsVia: NO_MODEL, remote: null, baseUrl: null, embeddingsBaseUrl: null }),
		hasModel: () => false,
		generate: async () => {
			throw new Error(NO_MODEL);
		},
	};
}

/** Questions compare without case, spacing and a closing question mark. */
export const sameQuestion = (a: string, b: string): boolean => {
	const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/, "").trim();
	return norm(a) === norm(b);
};

/** The recording with the placeholder replaced by the demo's PDF path. */
export function placeExample(example: DemoExample, pdfPath: string): DemoExample {
	return JSON.parse(JSON.stringify(example).split(PLACEHOLDER).join(pdfPath)) as DemoExample;
}

/** The recorded report cut to what was asked for: the summary when
 * requested, the recorded answers of the requested questions. */
export function replayReport(report: SynthReport, options: { summary?: string; questions?: string[] }): SynthReport {
	const questions = (options.questions ?? []).filter((question) => report.units.some((unit) => unit.kind === "detail-cross" && unit.question && sameQuestion(unit.question, question)));
	const units = report.units.filter((unit) => (unit.kind === "summary" ? options.summary !== "none" : unit.kind === "detail-cross" && questions.some((question) => sameQuestion(question, unit.question ?? ""))));
	return { ...report, generated: new Date().toISOString(), questions, units };
}

/** "Blanch et al., 2026" from the record (surname of the first author). */
export function paperCitation(paper: Pick<LibraryPaper, "entry">): string {
	const authors = paper.entry.authors ?? [];
	const surname = (authors[0] ?? "").trim().split(/\s+/).pop() ?? "";
	const who = authors.length > 2 ? `${surname} et al.` : authors.length === 2 ? `${surname} and ${(authors[1] ?? "").trim().split(/\s+/).pop()}` : surname;
	return [who, paper.entry.year].filter(Boolean).join(", ");
}

const pause = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	const timer = setTimeout(resolve, REPLAY_PAUSE_MS);
	signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
});

/** Start the server for the demo page mounted at `basePath`. */
export async function startDemoServer(basePath: string): Promise<WebServer> {
	const response = await fetch(`${basePath}/${EXAMPLE_FILE}`);
	if (!response.ok) throw new Error(`the demo's example is missing (${EXAMPLE_FILE}: HTTP ${response.status})`);
	const pdfPath = `${PAPERS}/${((await response.clone().json()) as DemoExample).pdf.name}`;
	const example = placeExample((await response.json()) as DemoExample, pdfPath);
	const paper: LibraryPaper = { file: pdfPath, base: example.paper.base, key: example.paper.key, entry: example.paper.entry };
	const library: LibraryMatch = { matched: [paper], unmatched: [], papersDir: PAPERS, dirs: [PAPERS] };
	// The library list reads the index file for "indexed" and the keywords.
	mkdirSync(`${STORE}/lit-synthesis/index`, { recursive: true });
	writeFileSync(`${STORE}/lit-synthesis/index/${paper.base}.json`, JSON.stringify(example.index));

	return startWebServer({
		provider: demoProvider(),
		root: STORE,
		cwd: "/demo",
		historyDir: "/demo/history",
		blockCacheFile: "/demo/keyword-blocks.json",
		token: DEMO_TOKEN,
		basePath,
		demo: true,
		chatReplay: { questions: example.questions, recordedWith: example.recordedWith, paper: { base: paper.base, label: paperCitation(paper) } },
		deps: {
			// No local servers to probe, no folder windows, no programs.
			probe: async () => false,
			canPickFolder: () => false,
			pickFolder: async () => null,
			pickFiles: async () => [],
			// The example paper is the library, already indexed.
			matchLibrary: () => library,
			ensureLibrary: async () => library,
			checkEmbedModel: async () => ({ state: "ok" }),
			// Recorded answers; any other question asks for the installation.
			runRound: async (options) => {
				const recorded = example.answers.find((answer) => sameQuestion(answer.question, options.question));
				if (!recorded) throw new Error(OWN_QUESTION);
				await pause(options.signal);
				return { ...recorded, asked: new Date().toISOString(), scope: options.papers ?? recorded.scope };
			},
			runReport: async (options) => {
				await pause(options.signal);
				return replayReport(example.report, { summary: options.summary, questions: options.questions });
			},
		},
	});
}
