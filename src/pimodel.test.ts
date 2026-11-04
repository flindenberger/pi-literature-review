/**
 * The browser's own LLM inside pi (extensions/pi-model.ts
 * piSessionProvider): pi's models are offered, the stored choice is used
 * per call without touching pi's session model, an empty choice follows
 * pi. Offline: a fake pi context, a private config folder.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "plr-pimodel-"));
process.env.XDG_CONFIG_HOME = dir;
mkdirSync(join(dir, "pi-literature-review"), { recursive: true });
writeFileSync(join(dir, "pi-literature-review", "config.json"), JSON.stringify({ browserModel: "ollama/qwen3:8b" }));

const { piSessionProvider } = await import("../extensions/pi-model.ts");

const piModel = { provider: "llama-server", id: "unsloth/Qwen3.5-9B", name: "Qwen 9B", baseUrl: "http://127.0.0.1:8080/v1" };
const other = { provider: "ollama", id: "qwen3:8b", name: "qwen3:8b", baseUrl: "http://127.0.0.1:11434/v1" };
const remote = { provider: "anthropic", id: "claude-x", name: "Claude X", baseUrl: "https://api.example.com" };
const used: string[] = [];
let setModelCalls = 0;
const ctx = {
	model: piModel,
	setModel: async () => { setModelCalls++; return true; },
	modelRegistry: {
		getAvailable: () => [piModel, other, remote],
		find: (provider: string, id: string) => [piModel, other, remote].find((m) => m.provider === provider && m.id === id),
		streamSimple: (model: { provider: string; id: string }) => {
			used.push(`${model.provider}/${model.id}`);
			return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "ok" }] }) };
		},
	},
} as never;

const provider = piSessionProvider(ctx);
assert.deepEqual(provider.choices?.().map((choice) => [choice.id, choice.local]), [
	["llama-server/unsloth/Qwen3.5-9B", true], ["ollama/qwen3:8b", true], ["anthropic/claude-x", false],
]);
// The stored choice runs the call; pi keeps its model.
const status = provider.status();
assert.equal(status.model, "ollama/qwen3:8b");
assert.equal(status.piModel, "llama-server/unsloth/Qwen3.5-9B");
assert.equal(status.follows, false);
assert.equal(await provider.generate({ system: "s", user: "u" }), "ok");
assert.deepEqual(used, ["ollama/qwen3:8b"]);
assert.equal(setModelCalls, 0);
assert.equal((ctx as { model: unknown }).model, piModel);

// An empty choice follows pi again.
const { updateStoredConfig } = await import("./config.ts");
updateStoredConfig({ browserModel: undefined });
assert.equal(provider.status().model, "llama-server/unsloth/Qwen3.5-9B");
assert.equal(provider.status().follows, true);
await provider.generate({ system: "s", user: "u" });
assert.deepEqual(used, ["ollama/qwen3:8b", "llama-server/unsloth/Qwen3.5-9B"]);

console.log("pimodel.test.ts: all assertions passed");
