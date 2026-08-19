/**
 * Main entry point for pi-literature-review.
 *
 * Located at the package root so pi shows a single extension entry named
 * "pi-literature-review" (pi labels the entry with the entry file's parent
 * directory).
 *
 * Delegates setup to the pipeline modules (search, selection, synthesis) under ./extensions/ in order.
 * User configuration is resolved by src/config.ts and lives outside the
 * package folder, which pi owns and resets on update.
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
