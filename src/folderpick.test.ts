/**
 * Offline tests of the folder window launchers: the command per platform,
 * no window without a desktop. Nothing is started. Run: node src/folderpick.test.ts
 */

import assert from "node:assert/strict";

import { pickCommand, pickFilesCommand } from "./folderpick.ts";

const has = (list: string[]) => (command: string) => list.includes(command);
const desktop = { DISPLAY: ":0" };

assert.deepEqual(pickCommand("Where?", "/home/me/Papers", "linux", desktop, has(["zenity", "kdialog"])), {
	command: "zenity", args: ["--file-selection", "--directory", "--title=Where?", "--filename=/home/me/Papers/"],
});
assert.deepEqual(pickCommand("Where?", "", "linux", { WAYLAND_DISPLAY: "wayland-0" }, has(["kdialog"]))?.command, "kdialog");
assert.equal(pickCommand("Where?", "", "linux", {}, has(["zenity"])), null); // no desktop (SSH)
assert.equal(pickCommand("Where?", "", "linux", desktop, has([])), null); // no launcher
const mac = pickCommand('Say "hi"', "", "darwin", {}, has([]));
assert.equal(mac?.command, "osascript");
assert.equal(mac?.args[1], 'POSIX path of (choose folder with prompt "Say hi")');
const win = pickCommand("It's here", "C:\\Users\\me", "win32", {}, has([]));
assert.equal(win?.command, "powershell.exe");
assert.match(win?.args[3] ?? "", /Description = 'It''s here'/);
assert.match(win?.args[3] ?? "", /SelectedPath = 'C:\\Users\\me'/);

// The PDF files window: several files, one path per line on every platform.
assert.deepEqual(pickFilesCommand("Add PDFs", "/home/me/Papers", "linux", desktop, has(["zenity"])), {
	command: "zenity", args: ["--file-selection", "--multiple", "--separator=\n", "--title=Add PDFs", "--file-filter=PDF files | *.pdf *.PDF", "--filename=/home/me/Papers/"],
});
assert.deepEqual(pickFilesCommand("Add PDFs", "/home/me", "linux", desktop, has(["kdialog"]))?.args, ["--getopenfilename", "/home/me", "PDF files (*.pdf *.PDF)", "--multiple", "--separate-output", "--title", "Add PDFs"]);
assert.equal(pickFilesCommand("Add PDFs", "", "linux", {}, has(["zenity"])), null);
const macFiles = pickFilesCommand("Add PDFs", "", "darwin", {}, has([]));
assert.match(macFiles?.args[1] ?? "", /choose file with prompt "Add PDFs" of type \{"com.adobe.pdf"\} with multiple selections allowed/);
assert.ok(macFiles?.args.includes("set out to out & POSIX path of f & linefeed"));
const winFiles = pickFilesCommand("Add PDFs", "C:\\Papers", "win32", {}, has([]));
assert.match(winFiles?.args[3] ?? "", /OpenFileDialog/);
assert.match(winFiles?.args[3] ?? "", /Multiselect = \$true/);
assert.match(winFiles?.args[3] ?? "", /InitialDirectory = 'C:\\Papers'/);

console.log("folderpick tests passed");
