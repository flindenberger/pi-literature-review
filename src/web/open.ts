/**
 * Open a URL in the platform browser without a shell (cmd.exe would
 * re-parse metacharacters in a URL). Launch failures are ignored: the
 * caller prints the address either way. Same approach as pi's own
 * open-browser utility; pi-free so the CLI can use it.
 */

import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
	const [command, args] = process.platform === "darwin"
		? ["open", [url]]
		: process.platform === "win32"
			? ["rundll32", ["url.dll,FileProtocolHandler", url]]
			: ["xdg-open", [url]];
	try {
		spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
	} catch {
		// best effort only
	}
}

/**
 * Show a folder in the platform file manager (the "open folder" button of
 * a file card). Same launchers as the browser; a path, never a URL, and
 * no shell. Best effort: a missing launcher is ignored.
 */
export function revealFolder(path: string): void {
	const [command, args] = process.platform === "darwin"
		? ["open", [path]]
		: process.platform === "win32"
			? ["explorer", [path]]
			: ["xdg-open", [path]];
	try {
		spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
	} catch {
		// best effort only
	}
}
