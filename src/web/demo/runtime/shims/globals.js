/* Browser demo: the Node globals the server reads (process, Buffer) and
   timers with unref(), installed in the demo's Web Worker before the
   server modules load. The page itself never sees them. */

import { Buffer } from "./buffer.js";

globalThis.Buffer = Buffer;

globalThis.process = {
	// The store (outputRoot) is the folder the demo server reads too.
	env: { HOME: "/demo", PI_LITERATURE_REVIEW_HOME: "/demo/store" },
	platform: "linux",
	argv: [],
	pid: 1,
	versions: { node: "22.19.0" },
	cwd: () => "/demo",
	on: () => globalThis.process,
	off: () => globalThis.process,
	exit: () => {},
	stderr: { write: (text) => { console.warn(String(text).trimEnd()); return true; } },
	stdout: { write: (text) => { console.log(String(text).trimEnd()); return true; }, isTTY: false },
};

// Node timers return an object with unref(); the browser returns a number.
// A Number object keeps both: clearTimeout() reads its numeric value.
for (const name of ["setTimeout", "setInterval"]) {
	const original = globalThis[name].bind(globalThis);
	globalThis[name] = (...args) => {
		const handle = Object(original(...args));
		handle.unref = () => handle;
		handle.ref = () => handle;
		handle.hasRef = () => false;
		return handle;
	};
}
