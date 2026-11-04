#!/usr/bin/env node
/**
 * Command-line entry for an npm install (`npx pi-literature-review web`).
 * Node refuses to strip TypeScript types from files under node_modules, so
 * this plain JavaScript file registers a load hook that strips them with
 * Node's own stripTypeScriptTypes for this package's .ts files only, then
 * runs src/cli.ts. Needs Node 22.19 or newer (the same as pi).
 */
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

const packageRoot = new URL("../", import.meta.url).href;

// stripTypeScriptTypes is marked experimental; its one-time warning would
// only confuse users of this command.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
	const text = typeof warning === "string" ? warning : warning?.message ?? "";
	if (/stripTypeScriptTypes|Type Stripping/i.test(text)) return;
	return emitWarning.call(process, warning, ...rest);
};

registerHooks({
	load(url, context, nextLoad) {
		const own = url.startsWith(packageRoot) && !url.slice(packageRoot.length).includes("node_modules/");
		if (own && url.endsWith(".ts")) {
			const source = readFileSync(new URL(url), "utf8");
			return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});

await import("../src/cli.ts");
