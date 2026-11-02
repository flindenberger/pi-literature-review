/**
 * Offline tests of the library sources and the twin store: recursive PDF
 * folders, the inbox, legacy places, twins in the store (never in the
 * user's folder), duplicate names, the store root. Temp folders only.
 * Run: node src/library.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "plr-library-"));
process.env.XDG_CONFIG_HOME = join(tmp, "config-home");
process.env.APPDATA = join(tmp, "config-home");
delete process.env.PI_LITERATURE_REVIEW_HOME;

const { flatPdfs, inboxDir, metaPath, readTwin, twinSaver, walkPdfs, writeTwin } = await import("./library.ts");
const { libraryFiles, matchLibrary } = await import("./corpus.ts");
const { outputRoot } = await import("./output.ts");
const { pdfFolders, addPdfFolder, removePdfFolder, rememberDownloadDir, lastDownloadDir } = await import("./config.ts");

const pdf = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "%PDF-1.4 test"); };

// The store: next to the user config by default, PI_LITERATURE_REVIEW_HOME moves it.
assert.equal(outputRoot({ XDG_CONFIG_HOME: "/x/cfg" }, "linux"), "/x/cfg/pi-literature-review");
assert.equal(outputRoot({ XDG_CONFIG_HOME: "/x/cfg", PI_LITERATURE_REVIEW_HOME: "/data" }, "linux"), "/data");

// A parent folder is read recursively with its sub-structure; hidden folders,
// links and other files are left out.
const papers = join(tmp, "Papers");
pdf(join(papers, "Rivers", "2020_Smith_Rivers.pdf"));
pdf(join(papers, "Rivers", "Deltas", "2021_Lee_Deltas.pdf"));
pdf(join(papers, "zotero", "storage", "ABCD1234", "Doe - 2019 - Bars.pdf"));
pdf(join(papers, ".hidden", "secret.pdf"));
writeFileSync(join(papers, "notes.txt"), "x");
try { symlinkSync(join(papers, "Rivers"), join(papers, "link")); } catch { /* filesystems without links */ }
const walk = walkPdfs(papers);
assert.deepEqual(walk.files.map((file) => file.slice(papers.length + 1)), [
	join("Rivers", "2020_Smith_Rivers.pdf"),
	join("Rivers", "Deltas", "2021_Lee_Deltas.pdf"),
	join("zotero", "storage", "ABCD1234", "Doe - 2019 - Bars.pdf"),
]);
assert.equal(walk.truncated, false);
assert.equal(walkPdfs(papers, 1).truncated, true); // depth cap
assert.equal(walkPdfs(papers, 8, 2).truncated, true); // entry cap
assert.deepEqual(walkPdfs(join(tmp, "missing")).files, []);
assert.deepEqual(flatPdfs(join(papers, "Rivers")).length, 1);

// Twins: written to the store only, read from next to the PDF first.
const root = join(tmp, "store");
const file = join(papers, "Rivers", "2020_Smith_Rivers.pdf");
writeTwin(root, file, { title: "Rivers", doi: "10.1/a", authors: ["Smith"], year: "2020" });
assert.ok(existsSync(metaPath(root, file)));
assert.deepEqual(readdirSync(join(papers, "Rivers")).sort(), ["2020_Smith_Rivers.pdf", "Deltas"]); // nothing written there
assert.equal(readTwin(root, file)?.doi, "10.1/a");
assert.equal(readTwin(root, file)?.pdf_path, file);
twinSaver(root)(join(papers, "Rivers", "Deltas", "2021_Lee_Deltas.json"), { title: "Deltas", doi: "10.1/b", authors: ["Lee"], year: "2021" });
assert.equal(readTwin(root, join(papers, "Rivers", "Deltas", "2021_Lee_Deltas.pdf"))?.doi, "10.1/b");
assert.equal(existsSync(join(papers, "Rivers", "Deltas", "2021_Lee_Deltas.json")), false);
const legacy = join(tmp, "legacy");
pdf(join(legacy, "lit-selection", "old.pdf"));
writeFileSync(join(legacy, "lit-selection", "old.json"), JSON.stringify({ title: "Old", doi: "10.1/old", authors: [], year: "2018" }));
assert.equal(readTwin(root, join(legacy, "lit-selection", "old.pdf"))?.doi, "10.1/old");

// Library sources: legacy places flat, the inbox, then the folders; a
// duplicate file name keeps the earlier one.
pdf(join(inboxDir(root), "dropped.pdf"));
pdf(join(papers, "zotero", "old.pdf")); // same name as the legacy one
const sources = libraryFiles(root, { cwd: legacy, folders: [papers] });
assert.deepEqual(sources.dirs, [join(legacy, "lit-selection"), inboxDir(root), papers]);
assert.equal(sources.files.length, 6);
const warnings: string[] = [];
const match = matchLibrary(root, (message) => warnings.push(message), { cwd: legacy, folders: [papers] });
assert.deepEqual(match.matched.map((paper) => paper.base).sort(), ["2020_Smith_Rivers", "2021_Lee_Deltas", "old"]);
assert.equal(match.matched.find((paper) => paper.base === "old")?.file, join(legacy, "lit-selection", "old.pdf"));
assert.equal(match.matched.find((paper) => paper.base === "2021_Lee_Deltas")?.file, join(papers, "Rivers", "Deltas", "2021_Lee_Deltas.pdf"));
assert.deepEqual(match.unmatched.sort(), ["Doe - 2019 - Bars.pdf", "dropped.pdf"]);
assert.deepEqual(match.unmatchedByDir?.map((group) => group.dir), [inboxDir(root), join(papers, "zotero", "storage", "ABCD1234")]);
assert.ok(warnings.some((message) => /skipped 1 PDF/.test(message)));

// Configured folders: add, no duplicates, remove; a download folder is
// remembered and becomes a PDF folder; the environment replaces the list.
delete process.env.PI_LITERATURE_REVIEW_PDF_FOLDERS;
assert.deepEqual(pdfFolders(), []);
addPdfFolder(papers);
addPdfFolder(papers);
assert.deepEqual(pdfFolders(), [papers]);
rememberDownloadDir(join(tmp, "Downloads"));
assert.equal(lastDownloadDir(), join(tmp, "Downloads"));
assert.deepEqual(pdfFolders(), [papers, join(tmp, "Downloads")]);
removePdfFolder(papers);
assert.deepEqual(pdfFolders(), [join(tmp, "Downloads")]);
assert.deepEqual(pdfFolders({ PI_LITERATURE_REVIEW_PDF_FOLDERS: "" }), []);
assert.deepEqual(pdfFolders({ PI_LITERATURE_REVIEW_PDF_FOLDERS: `${papers}${process.platform === "win32" ? ";" : ":"}${papers}` }), [papers]);

// A folder the library reads on its own (lit-selection/ where pi was
// started) can be taken out; adding it by hand brings it back.
removePdfFolder(join(legacy, "lit-selection"));
assert.deepEqual(libraryFiles(root, { cwd: legacy, folders: [] }).dirs, [inboxDir(root)]);
addPdfFolder(join(legacy, "lit-selection"));
assert.ok(libraryFiles(root, { cwd: legacy, folders: [] }).dirs.includes(join(legacy, "lit-selection")));

// A chat over some papers adopts (looks up) only those, not the whole library.
{
	const { ensureLibrary } = await import("./synthesis.ts");
	const tried: string[] = [];
	const library = () => ({ matched: [], unmatched: ["a.pdf", "b.pdf", "c.pdf"], unmatchedByDir: [{ dir: "/x", files: ["a.pdf", "b.pdf"] }, { dir: "/y", files: ["c.pdf"] }], papersDir: "/x" });
	const adopt = async (files: string[]) => { tried.push(...files); return files.map((file) => ({ file, status: "no_identifier" as const, detail: "-" })); };
	await ensureLibrary("/root", () => {}, { library, adopt, only: ["b"] });
	assert.deepEqual(tried, ["b.pdf"]);
	tried.length = 0;
	await ensureLibrary("/root", () => {}, { library, adopt });
	assert.deepEqual(tried, ["a.pdf", "b.pdf", "c.pdf"]);
}

console.log("library tests passed");
