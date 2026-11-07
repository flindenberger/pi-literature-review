/* Browser demo, worker entry: install the Node globals first, load the
   files kept from earlier visits, then the server (the build put the
   converted package under app/), and answer the requests that arrive on
   the ports the pages hand over. Runs as a SharedWorker, so every tab of
   the demo talks to the same server (a dedicated Worker where the browser
   has no SharedWorker). */

import "./shims/globals.js";
import { loadPersisted } from "./shims/fs.js";
import { serveRequest } from "./shims/http.js";

let ready = null;

function start(basePath) {
	if (!ready) {
		ready = (async () => {
			await loadPersisted();
			const { startDemoServer } = await import("../app/src/web/demo/worker.js");
			await startDemoServer(basePath);
		})();
	}
	return ready;
}

/** One page's messages: "start" (answered with ready or error) and
 * "port" (a channel to the Service Worker; each message on it is one
 * request). */
function listen(source) {
	source.onmessage = async (event) => {
		const message = event.data || {};
		if (message.type === "start") {
			try {
				await start(message.basePath || "");
				source.postMessage({ type: "ready" });
			} catch (error) {
				source.postMessage({ type: "error", message: String(error && error.stack ? error.stack : error) });
			}
			return;
		}
		if (message.type === "port" && event.ports[0]) {
			const port = event.ports[0];
			port.onmessage = async (request) => {
				if (!request.data || request.data.type !== "request") return;
				await ready;
				serveRequest(request.data, request.ports[0]);
			};
		}
	};
}

if (typeof SharedWorkerGlobalScope !== "undefined" && self instanceof SharedWorkerGlobalScope) {
	self.onconnect = (event) => listen(event.ports[0]);
} else {
	listen(self);
}
