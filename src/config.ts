/**
 * Tiny user-level config -- currently a single setting: the contact email
 * for Unpaywall lookups. The fetch dialog asks while no email is configured
 * and offers to store it here (the user may also choose per-run entry, then
 * nothing is persisted and the dialog simply asks again next time). Stored
 * as plain JSON, file mode 0600, in the platform's standard config location:
 *
 *   Linux/macOS:  $XDG_CONFIG_HOME or ~/.config/pi-literature-review/config.json
 *   Windows:      %APPDATA%\pi-literature-review\config.json
 *
 * Deliberately NOT ~/.pi/agent (that is Pi's own config domain and rebranded
 * distributions rename it) and NOT the package folder (replaced on update).
 * The PI_LITERATURE_REVIEW_MAILTO environment variable always overrides the
 * stored value (see types.ts). The email is sent only to api.unpaywall.org
 * (and as polite-pool contact in the User-Agent); it never leaves the
 * machine otherwise.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Pure and injectable for tests; defaults describe the running machine. */
export function configPath(
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const base = platform === "win32"
		? env.APPDATA || join(home, "AppData", "Roaming")
		: env.XDG_CONFIG_HOME || join(home, ".config");
	return join(base, "pi-literature-review", "config.json");
}

/** Loose plausibility check -- catches typos, not RFC edge cases. */
export function isPlausibleMailto(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

interface StoredConfig {
	mailto?: string;
}

let cache: StoredConfig | null = null;

function loadStoredConfig(): StoredConfig {
	if (cache !== null) return cache;
	try {
		cache = JSON.parse(readFileSync(configPath(), "utf8")) as StoredConfig;
	} catch {
		cache = {}; // no config yet (or unreadable) -- both mean "not decided"
	}
	return cache;
}

export function storedMailto(): string {
	return (loadStoredConfig().mailto ?? "").trim();
}

/** Persist the email; returns the config file path for the confirmation.
 * Mode 0600: only the owning account reads it (ignored on Windows, where
 * the user-profile ACL protects %APPDATA%). */
export function storeMailto(mailto: string): string {
	const path = configPath();
	const config: StoredConfig = { ...loadStoredConfig(), mailto: mailto.trim() };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	cache = config;
	return path;
}
