/**
 * The web interface command for pi: /pi-literature-review starts a local
 * server inside the pi process (127.0.0.1, random token), opens the
 * browser and runs every stage there, as a guided chat, on the model
 * selected in pi. The
 * server lives until pi quits, the session changes (/new, /resume, /fork,
 * /reload -- pi's session_shutdown) or `/pi-literature-review stop`.
 *
 *   /pi-literature-review               start (or show the address again)
 *   /pi-literature-review stop          stop the server
 *   /pi-literature-review --port 8765   fixed port; --no-open skips the browser
 *
 * The terminal wizards stay untouched: this is a second front end over
 * the same engines (src/web/server.ts), not a replacement.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openBrowser } from "../src/web/open.ts";
import { startWebServer, type WebServer } from "../src/web/server.ts";
import { piSessionProvider } from "./pi-model.ts";

/** Parse the command's arguments. Pure; exported for the test. */
export function parseWebArgs(raw: string): { stop: boolean; port: number | undefined; open: boolean; error?: string } {
	const words = raw.trim().split(/\s+/).filter(Boolean);
	let stop = false;
	let port: number | undefined;
	let open = true;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word === "stop") stop = true;
		else if (word === "--no-open") open = false;
		else if (word === "--port") {
			const value = Number(words[++i]);
			if (!Number.isInteger(value) || value < 0 || value > 65535) return { stop, port, open, error: `--port needs a number between 0 and 65535, got "${words[i] ?? ""}"` };
			port = value;
		} else return { stop, port, open, error: `unknown argument "${word}" (use: stop, --port N, --no-open)` };
	}
	return { stop, port, open };
}

export default function literatureWeb(pi: ExtensionAPI) {
	let server: WebServer | null = null;
	let starting: Promise<WebServer> | null = null;

	const stop = async (): Promise<boolean> => {
		const running = server ?? (starting ? await starting.catch(() => null) : null);
		server = null;
		starting = null;
		if (!running) return false;
		await running.close();
		return true;
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	pi.registerCommand("pi-literature-review", {
		description: "Open the literature review in the browser: a chat that walks through search, selection and synthesis on a local server.",
		handler: async (args, ctx) => {
			const parsed = parseWebArgs(args ?? "");
			if (parsed.error) {
				notify(ctx, parsed.error, "warning");
				return;
			}
			if (parsed.stop) {
				notify(ctx, (await stop()) ? "Web interface stopped." : "No web server is running.");
				return;
			}
			if (server) {
				notify(ctx, `Web interface already running: ${server.url}`);
				if (parsed.open) openBrowser(server.url);
				return;
			}
			try {
				starting = startWebServer({
					port: parsed.port,
					provider: piSessionProvider(ctx),
					cwd: ctx.cwd,
					backgroundIndex: true,
					onStop: () => {
						server = null;
					},
				});
				server = await starting;
				starting = null;
			} catch (error) {
				starting = null;
				notify(ctx, `Web interface could not start: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (parsed.open) openBrowser(server.url);
			notify(ctx,
				`Web interface: ${server.url}\n`
				+ `Data folder: ${server.root}\n`
				+ "Runs until pi quits or the session changes (/new); /pi-literature-review stop ends it.");
		},
	});

	// pi fires session_shutdown on quit, /new, /resume, /fork and /reload
	// (also on SIGTERM/SIGHUP); the handler is repeatable.
	pi.on("session_shutdown", async () => {
		await stop();
	});
}
