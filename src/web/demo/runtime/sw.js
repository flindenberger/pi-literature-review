/* Browser demo, Service Worker: the cable between the page and the server
   running in the page's Web Worker. Requests to the server's addresses
   (api/, files/, pdf/ below the demo's folder) go over a MessagePort to
   the worker; the answer streams back as a normal response, so the page,
   its frames and new tabs work as with the installed server. Everything
   else (the page, static/) comes from the network as usual. */

const SERVER_ROUTES = /^\/(api|files|pdf)\//;
const TOKEN = "demo";
const BODY_LIMIT = 20000000;
let serverPort = null;
let portWaiters = [];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "server-port" && event.ports[0]) {
		serverPort = event.ports[0];
		for (const resolve of portWaiters) resolve(serverPort);
		portWaiters = [];
	}
});

/** The port to the server; after a restart of this worker the page is
 * asked for a fresh one. */
async function port() {
	if (serverPort) return serverPort;
	const waiting = new Promise((resolve, reject) => {
		portWaiters.push(resolve);
		setTimeout(() => reject(new Error("the demo server did not answer")), 10000);
	});
	for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "need-server-port" });
	return waiting;
}

const scopePath = () => new URL(self.registration.scope).pathname.replace(/\/$/, "");

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;
	const base = scopePath();
	const path = base && url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : url.pathname;
	if (!SERVER_ROUTES.test(path)) return;
	// The example paper's PDF is a plain file next to the demo
	// (examples/<name>.pdf), fetched only when someone opens it.
	const pdf = /^\/pdf\/([^/?#]+\.pdf)$/i.exec(path);
	event.respondWith(pdf ? examplePdf(event.request, base, pdf[1], url) : forward(event.request, url.pathname + url.search));
});

async function examplePdf(request, base, name, url) {
	const file = await fetch(`${base}/examples/${name}`);
	return file.ok ? file : forward(request, url.pathname + url.search);
}

async function forward(request, address) {
	const target = await port();
	const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
	if (body && body.byteLength > BODY_LIMIT) return new Response(JSON.stringify({ error: "request too large" }), { status: 413 });
	const headers = { host: "127.0.0.1:8", authorization: `Bearer ${TOKEN}` };
	request.headers.forEach((value, name) => { if (name !== "host" && name !== "authorization" && name !== "cookie") headers[name] = value; });
	const channel = new MessageChannel();
	return new Promise((resolve) => {
		let controller = null;
		const stream = new ReadableStream({
			start(c) { controller = c; },
			cancel() { channel.port1.postMessage({ type: "cancel" }); },
		});
		channel.port1.onmessage = ({ data }) => {
			if (data.type === "head") {
				const empty = [101, 204, 205, 304].includes(data.status) || request.method === "HEAD";
				resolve(new Response(empty ? null : stream, { status: data.status, headers: data.headers }));
			} else if (data.type === "chunk") {
				try { controller.enqueue(new Uint8Array(data.data)); } catch { /* reader gone */ }
			} else if (data.type === "end") {
				try { controller.close(); } catch { /* already closed */ }
			}
		};
		target.postMessage({ type: "request", method: request.method, url: address, headers, body }, body ? [channel.port2, body] : [channel.port2]);
	});
}
