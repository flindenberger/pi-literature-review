/**
 * pi-literature-review -- single extension entry point.
 *
 * package.json points pi.extensions at THIS file (the package root), not at
 * the extensions/ directory. Two reasons:
 *   1. A directory entry makes pi list one line per file (search.ts,
 *      selection.ts, ...); a single-file entry collapses the package to
 *      ONE entry in pi's [Extensions] list.
 *   2. pi labels that entry with the entry file's PARENT directory name.
 *      Whatever the install route, the package sits in a folder named
 *      after it -- pi install <path> uses the checkout folder,
 *      pi install npm:pi-literature-review lands in
 *      ~/.pi/agent/npm/node_modules/pi-literature-review/, a git install
 *      in ~/.pi/agent/git/<host>/<owner>/pi-literature-review/ -- so an
 *      entry file at the package root is always labelled
 *      "pi-literature-review", whereas an aggregator inside extensions/
 *      would show the generic "extensions" everywhere.
 * pi owns that install folder (updates reset it), which is also why the
 * user configuration lives outside it (see src/config.ts).
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
