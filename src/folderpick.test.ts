/**
 * Offline tests of the folder window launchers: the command per platform,
 * no window without a desktop. Nothing is started. Run: node src/folderpick.test.ts
 */

import assert from "node:assert/strict";

import { pickCommand } from "./folderpick.ts";

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

console.log("folderpick tests passed");
