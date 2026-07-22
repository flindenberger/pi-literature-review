/**
 * pi-literature-review -- single extension entry point.
 *
 * package.json points pi.extensions at THIS file (the package root), not at
 * the extensions/ directory. Two reasons:
 *   1. A directory entry makes pi list one line per file (chat.ts, fetch.ts,
 *      ...); a single-file entry collapses the package to one entry.
 *   2. For a path-installed package pi labels that entry with the entry
 *      file's PARENT directory name. At the package root that name is
 *      "pi-literature-review" -- the label we want -- whereas an aggregator
 *      inside extensions/ would show the generic "extensions".
 * Each pipeline stage still lives in its own module under extensions/; this
 * file only fans the pi API out to their registrars, in pipeline order.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import literatureSearch from "./extensions/search.ts";
import literatureFetch from "./extensions/fetch.ts";
import literatureSynthesize from "./extensions/synthesize.ts";
import literatureChat from "./extensions/chat.ts";
import { registerDialogDemo } from "./extensions/dialogs.ts";

export default async function literatureReview(pi: ExtensionAPI) {
	literatureSearch(pi);
	literatureFetch(pi);
	literatureSynthesize(pi);
	// Awaited: literatureChat lazily imports pi-tui to register a transcript
	// renderer; pi awaits this factory before startup completes.
	await literatureChat(pi);
	// TEMPORARY (v25 E2c gate): /lit-dialogs demo; removed when the E2e
	// wizard wires the dialogs for real.
	registerDialogDemo(pi);
}
