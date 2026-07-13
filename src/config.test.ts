/**
 * Offline tests for the user-level config helpers: platform-specific config
 * paths (pure, injected platform/env/home) and the email plausibility
 * check. Storage IO is deliberately not exercised here -- it would write
 * into the developer's real config directory.
 */

import assert from "node:assert/strict";
import { configPath, isPlausibleMailto } from "./config.ts";

/* ---------------- configPath ---------------- */
{
	assert.equal(
		configPath("linux", {}, "/home/user"),
		"/home/user/.config/pi-literature-review/config.json",
	);
	assert.equal(
		configPath("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/user"),
		"/xdg/pi-literature-review/config.json",
	);
	assert.equal(
		configPath("darwin", {}, "/Users/user"),
		"/Users/user/.config/pi-literature-review/config.json",
	);
	// Windows: APPDATA when set, the conventional fallback otherwise.
	// (join() uses the running platform's separator, so only the pieces are
	// asserted, not one exact separator style.)
	const win = configPath("win32", { APPDATA: "C:\\Users\\user\\AppData\\Roaming" }, "C:\\Users\\user");
	assert.ok(win.startsWith("C:\\Users\\user\\AppData\\Roaming"));
	assert.ok(win.includes("pi-literature-review"));
	assert.ok(win.endsWith("config.json"));
	const winFallback = configPath("win32", {}, "C:\\Users\\user");
	assert.ok(winFallback.includes("AppData"));
	assert.ok(!winFallback.includes(".config"));
}

/* ---------------- isPlausibleMailto ---------------- */
{
	assert.ok(isPlausibleMailto("name@example.org"));
	assert.ok(isPlausibleMailto("  first.last@sub.uni-muenchen.de  "));
	assert.ok(!isPlausibleMailto(""));
	assert.ok(!isPlausibleMailto("banana"));
	assert.ok(!isPlausibleMailto("name@"));
	assert.ok(!isPlausibleMailto("@example.org"));
	assert.ok(!isPlausibleMailto("name@nodot"));
	assert.ok(!isPlausibleMailto("two words@example.org"));
}

console.log("config.test.ts: all assertions passed");
