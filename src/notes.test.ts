/** Offline tests for src/notes.ts (paper notes on disk). */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNoteDir, imageType, notedBases, noteDirName, noteImagePath, readNote, saveNoteImage, writeNote } from "./notes.ts";

const store = mkdtempSync(join(tmpdir(), "plr-notes-"));
try {
	const paper = { base: "Blanch_2026_hess-30-797-2026", doi: "10.5194/hess-30-797-2026", title: "AI image-based method" };
	assert.equal(readNote(store, paper), null);
	assert.deepEqual(notedBases(store), []);

	// Saved in the canonical form; front matter from the library, not the page.
	const saved = writeNote(store, paper, "---\npaper: \"forged\"\n---\n# Method\n\nCameras *four*\n", "grid");
	assert.equal(saved.dir, paper.base);
	const file = readFileSync(join(store, "notes", paper.base, "notes.md"), "utf8");
	assert.match(file, /^---\npaper: "Blanch_2026_hess-30-797-2026"\ndoi: "10\.5194\/hess-30-797-2026"\ntitle: "AI image-based method"\nbackground: "grid"\nupdated: "/);
	assert.match(file, /\n# Method\n\nCameras \*four\*\n$/);
	const note = readNote(store, paper);
	assert.equal(note?.markdown, "# Method\n\nCameras *four*\n");
	assert.equal(note?.background, "grid");
	assert.deepEqual(notedBases(store), [paper.base]);

	// Images: checked by their bytes, numbered per page.
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
	assert.equal(saveNoteImage(store, paper, png, 4).src, "img/p4-1.png");
	assert.equal(saveNoteImage(store, paper, png, 4).src, "img/p4-2.png");
	assert.equal(saveNoteImage(store, paper, png, null).src, "img/pasted-1.png");
	assert.throws(() => saveNoteImage(store, paper, Buffer.from("<svg onload=alert(1)>............"), 1), /not a PNG/);
	assert.equal(imageType(Buffer.from("GIF89a..........")), "gif");
	assert.ok(noteImagePath(store, paper.base, "p4-1.png"));
	assert.equal(noteImagePath(store, paper.base, "../notes.md"), null);
	assert.equal(noteImagePath(store, "..", "p4-1.png"), null);
	assert.equal(noteImagePath(store, paper.base, "p9-1.png"), null);

	// Renamed PDF: the note follows by DOI, its folder is renamed.
	const renamed = { ...paper, base: "Blanch et al 2026" };
	assert.equal(findNoteDir(store, renamed, new Set([renamed.base])), "Blanch et al 2026");
	assert.ok(!existsSync(join(store, "notes", paper.base)));
	assert.equal(readNote(store, renamed)?.markdown, "# Method\n\nCameras *four*\n");
	// ... but not while another live paper still holds the old base.
	const twin = { base: "copy", doi: paper.doi };
	assert.equal(findNoteDir(store, twin, new Set(["Blanch et al 2026", "copy"])), null);

	// Unsafe base names get a cleaned folder name plus a hash.
	assert.equal(noteDirName("plain name (2024)"), "plain name (2024)");
	assert.match(noteDirName("a/b:c"), /^a_b_c-[0-9a-f]{8}$/);
	assert.notEqual(noteDirName("a/b"), noteDirName("a:b"));
} finally {
	rmSync(store, { recursive: true, force: true });
}
console.log("notes ok");
