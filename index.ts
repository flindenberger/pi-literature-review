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
import literatureSelection from "./extensions/selection.ts";
import literatureSynthesis from "./extensions/synthesis.ts";

export default async function literatureReview(pi: ExtensionAPI) {
	literatureSearch(pi);
	literatureSelection(pi);
	// Awaited: the fused synthesize adapter lazily imports pi-tui to register
	// its transcript renderer; pi awaits this factory before startup.
	await literatureSynthesis(pi);
}
