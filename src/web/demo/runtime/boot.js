/* Browser demo, page start: register the Service Worker, start the server
   in a (shared) Web Worker, connect the two, then load the unchanged interface
   (static/app.js). A Service Worker that restarted asks for a new port. */

// The build puts this script in a folder named after the build's content
// hash (v/<hash>/runtime/) and names the interface script with the same
// hash: a new build is always fetched fresh and starts its own server.
const BOOT_SCRIPT = document.currentScript;

(async () => {
	const here = new URL(".", location.href);
	const own = BOOT_SCRIPT ? new URL(".", BOOT_SCRIPT.src) : new URL("runtime/", here);
	const appScript = (BOOT_SCRIPT && BOOT_SCRIPT.dataset.app) || "static/app.js";
	const basePath = here.pathname.replace(/\/$/, "");
	const fail = (text) => {
		const box = document.getElementById("status");
		if (box) box.textContent = text;
		console.error(text);
	};
	if (!("serviceWorker" in navigator)) return fail("This browser cannot run the demo (no Service Worker support).");

	await navigator.serviceWorker.register(new URL("sw.js", here), { scope: here.pathname });
	if (!navigator.serviceWorker.controller) {
		await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
	}

	// One server for every tab of the demo (SharedWorker); a dedicated
	// Worker where the browser has none.
	const script = new URL("worker-boot.js", own);
	const shared = typeof SharedWorker === "function";
	const worker = shared ? new SharedWorker(script, { type: "module", name: "pi-literature-review-demo" }) : new Worker(script, { type: "module" });
	const line = shared ? worker.port : worker;
	try {
		await new Promise((resolve, reject) => {
			line.onmessage = (event) => {
				if (event.data.type === "ready") resolve();
				if (event.data.type === "error") reject(new Error(event.data.message));
			};
			worker.onerror = (event) => reject(new Error(event.message || "the demo server failed to load"));
			if (shared) worker.port.start();
			line.postMessage({ type: "start", basePath });
		});
	} catch (error) {
		return fail(`The demo server did not start: ${error.message}`);
	}

	const connect = () => {
		const channel = new MessageChannel();
		line.postMessage({ type: "port" }, [channel.port1]);
		navigator.serviceWorker.controller.postMessage({ type: "server-port" }, [channel.port2]);
	};
	connect();
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data && event.data.type === "need-server-port") connect();
	});

	const app = document.createElement("script");
	app.src = appScript;
	document.body.appendChild(app);
})();
