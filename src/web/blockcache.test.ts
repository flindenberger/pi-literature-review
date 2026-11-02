// Saved keyword blocks: path next to the configuration, env override, key normalization, mode in the key, clear.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blockCacheKey, blockCachePath, cachedBlocks, clearBlockCache, saveBlocks } from "./blockcache.ts";

assert.equal(blockCachePath("linux", {}, "/home/u"), "/home/u/.config/pi-literature-review/keyword-blocks.json");
assert.equal(blockCachePath("linux", { PI_LITERATURE_REVIEW_BLOCK_CACHE: "/x/b.json" }, "/home/u"), "/x/b.json");
assert.equal(blockCacheKey("own", "  Flood   Mapping "), "own:flood mapping");

const dir = mkdtempSync(join(tmpdir(), "plr-blocks-"));
const file = join(dir, "keyword-blocks.json");
assert.equal(cachedBlocks(file, "own", "flood mapping"), null);
saveBlocks(file, "own", "Flood mapping", [{ role: "plus1", text: "(flood mapping) AND (river)" }]);
assert.deepEqual(cachedBlocks(file, "own", "flood  MAPPING"), [{ role: "plus1", text: "(flood mapping) AND (river)" }]);
assert.equal(cachedBlocks(file, "synonyms", "flood mapping"), null); // mode is part of the key
saveBlocks(file, "own", "flood mapping", [{ role: "plus1", text: "(flood mapping)" }]);
assert.deepEqual(cachedBlocks(file, "own", "flood mapping"), [{ role: "plus1", text: "(flood mapping)" }]); // replaced
assert.equal(clearBlockCache(file), 1);
assert.equal(existsSync(file), false);
rmSync(dir, { recursive: true, force: true });

console.log("blockcache.test.ts: all assertions passed");
