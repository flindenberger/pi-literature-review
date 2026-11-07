/**
 * Capture of the browser demo's example paper chat: turns ONE real paper
 * chat of the installed version (store + conversation snapshot) into the
 * file the demo plays back (example/<name>.json). Nothing is generated
 * here: answers, citation sites and the report are taken as the engine
 * wrote them; only machine paths are replaced by the placeholder {PDF}.
 *
 *   XDG_CONFIG_HOME=<rec>/xdg PI_LITERATURE_REVIEW_HOME=<rec>/store \
 *     node src/web/demo/capture.ts <conversation.json> <report.json> <out.json> <pdf-url> "<recorded with ...>"
 *
 * The recording itself runs in the normal interface (library chat over
 * the example PDF, the questions, then Report -> Summary).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchLibrary } from "../../corpus.ts";
import { outputRoot } from "../../output.ts";

export const PDF_PLACEHOLDER = "{PDF}";

/** Every string equal to or starting with the PDF's path -> placeholder. */
export function replacePath<T>(value: T, path: string): T {
	return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "string" && item.startsWith(path) ? PDF_PLACEHOLDER + item.slice(path.length) : item)));
}

if (process.argv[1] && process.argv[1].endsWith("capture.ts")) {
	const [conversationFile, reportFile, outFile, pdfUrl, recordedWith] = process.argv.slice(2);
	if (!recordedWith) {
		process.stderr.write("usage: node src/web/demo/capture.ts <conversation.json> <report.json> <out.json> <pdf-url> \"<recorded with>\"\n");
		process.exit(2);
	}
	const root = outputRoot();
	const match = matchLibrary(root, () => {}, { cwd: root });
	if (match.matched.length !== 1) throw new Error(`the recording library must hold exactly one verified paper (found ${match.matched.length})`);
	const paper = match.matched[0];
	const bytes = readFileSync(paper.file);
	const index = JSON.parse(readFileSync(join(root, "lit-synthesis", "index", `${paper.base}.json`), "utf8"));
	const conversation = JSON.parse(readFileSync(conversationFile, "utf8"));
	const answers = (conversation.dialog.messages as Array<Record<string, any>>)
		.filter((message) => message.role === "answer" && message.answer?.answer?.grounded)
		.map((message) => ({ ...message.answer.answer, protocol_path: null, round: 0 }));
	const report = JSON.parse(readFileSync(reportFile, "utf8"));
	const example = replacePath({
		recordedWith,
		recordedAt: report.generated,
		pdf: {
			name: `${paper.base}.pdf`,
			url: pdfUrl,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
			license: "CC BY 4.0",
		},
		paper: { base: paper.base, key: paper.key, entry: paper.entry },
		// What the library list reads from an index: model, size, and the
		// first pages' text for the author keywords; no vectors.
		index: {
			schema: index.schema,
			sha256: index.sha256,
			embedding_model: index.embedding_model,
			chunking: index.chunking,
			paper: index.paper,
			chunks: (index.chunks as Array<Record<string, any>>).map((chunk) => (Number(chunk.page) <= 2 ? { page: chunk.page, text: chunk.text } : { page: chunk.page })),
		},
		questions: answers.map((answer) => answer.question),
		answers,
		report,
	}, paper.file);
	writeFileSync(outFile, `${JSON.stringify(example, null, 1)}\n`);
	process.stdout.write(`captured ${answers.length} answers and the report (${report.units.length} units) into ${outFile}\n`);
}
