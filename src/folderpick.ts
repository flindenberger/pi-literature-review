/**
 * The system's own "choose a folder" window, opened from the local server
 * or the terminal (a web page may not learn a folder path on disk):
 *   Linux    zenity (GNOME and most desktops), else kdialog (KDE)
 *   macOS    osascript "choose folder"
 *   Windows  PowerShell with the .NET folder dialog
 * No shell anywhere: every launcher gets its arguments as a list. Without a
 * desktop (SSH, a server) no window exists; callers then ask for a typed
 * path. Pure command building is exported for tests.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface PickCommand {
	command: string;
	args: string[];
}

/** The launcher for this platform, or null when none is available. The
 * `has` check is injectable (tests). */
export function pickCommand(
	title: string,
	start: string,
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
	has: (command: string) => boolean = onPath,
): PickCommand | null {
	if (platform === "darwin") {
		const prompt = title.replace(/["\\]/g, "");
		const location = start && existsSync(start) ? ` default location POSIX file "${start.replace(/["\\]/g, "")}"` : "";
		return { command: "osascript", args: ["-e", `POSIX path of (choose folder with prompt "${prompt}"${location})`] };
	}
	if (platform === "win32") {
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms;",
			"$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
			`$d.Description = '${title.replace(/'/g, "''")}';`,
			start ? `$d.SelectedPath = '${start.replace(/'/g, "''")}';` : "",
			"if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
		].join(" ");
		return { command: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", script] };
	}
	// Linux and the other Unixes: only with a graphical session.
	if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
	if (has("zenity")) {
		return { command: "zenity", args: ["--file-selection", "--directory", `--title=${title}`, ...(start ? [`--filename=${start.replace(/\/?$/, "/")}`] : [])] };
	}
	if (has("kdialog")) {
		return { command: "kdialog", args: ["--getexistingdirectory", start || process.env.HOME || "/", "--title", title] };
	}
	return null;
}

function onPath(command: string): boolean {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir && existsSync(join(dir, command))) return true;
	}
	return false;
}

/** True when a folder window can be opened here. */
export function canPickFolder(): boolean {
	return pickCommand("x", "") !== null;
}

/** Open the window and wait for the answer: the chosen folder, or null
 * when the user cancelled. Throws when no window is available. */
export function pickFolder(title: string, start = ""): Promise<string | null> {
	const command = pickCommand(title, start);
	if (!command) return Promise.reject(new Error("no folder window available on this system (type the path instead)"));
	return new Promise((resolve, reject) => {
		execFile(command.command, command.args, { encoding: "utf8", windowsHide: false, timeout: 10 * 60_000 }, (error, stdout) => {
			const path = String(stdout ?? "").trim().replace(/[\\/]$/, "") || null;
			// Cancel ends the launchers with exit code 1 (zenity, kdialog,
			// osascript "User canceled") and no output.
			if (error && !path) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") reject(new Error(`${command.command} not found`));
				else resolve(null);
				return;
			}
			resolve(path);
		});
	});
}
