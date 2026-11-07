/* Browser demo: node:http without a network. createServer() keeps the
   request handler; serveRequest() (called by the worker for each request
   the Service Worker hands over) builds a request and a response object
   with the parts of Node's API the server uses and streams the answer
   back as messages: head, chunks, end. */

import { Buffer } from "./buffer.js";

export const DEMO_PORT = 8;
let handler = null;

export function createServer(requestHandler) {
	handler = requestHandler;
	return {
		keepAliveTimeout: 0,
		listen(port, host, callback) { if (typeof callback === "function") setTimeout(callback, 0); return this; },
		address() { return { port: DEMO_PORT, address: "127.0.0.1", family: "IPv4" }; },
		once() { return this; },
		on() { return this; },
		off() { return this; },
		close(callback) { if (typeof callback === "function") setTimeout(callback, 0); },
		closeAllConnections() {},
	};
}

export function request() {
	throw new Error("outgoing http requests are not available in the browser demo");
}

class Emitter {
	constructor() { this.listeners = new Map(); }
	on(event, listener) {
		if (!this.listeners.has(event)) this.listeners.set(event, []);
		this.listeners.get(event).push(listener);
		return this;
	}
	once(event, listener) {
		const wrapped = (...args) => { this.off(event, wrapped); listener(...args); };
		return this.on(event, wrapped);
	}
	off(event, listener) {
		const list = this.listeners.get(event) || [];
		this.listeners.set(event, list.filter((entry) => entry !== listener));
		return this;
	}
	emit(event, ...args) {
		for (const listener of [...(this.listeners.get(event) || [])]) listener(...args);
	}
}

/** One request: `message` = { method, url, headers, body (ArrayBuffer|null) };
 * `port` = the channel the answer goes back on. */
export function serveRequest(message, port) {
	if (!handler) {
		port.postMessage({ type: "head", status: 503, headers: { "content-type": "text/plain" } });
		port.postMessage({ type: "chunk", data: new TextEncoder().encode("server not started") });
		port.postMessage({ type: "end" });
		return;
	}
	const body = message.body ? Buffer.from(message.body) : null;
	const req = new Emitter();
	req.method = message.method;
	req.url = message.url;
	req.headers = message.headers;
	req.destroy = () => {};
	// The body is delivered once the handler listens (it may read it after
	// a few awaits): data in a microtask, end in a later task.
	const on = req.on.bind(req);
	req.on = (event, listener) => {
		on(event, listener);
		if (event === "data" && body && body.length) queueMicrotask(() => listener(body));
		if (event === "end") setTimeout(() => listener(), 0);
		return req;
	};

	const res = new Emitter();
	res.statusCode = 200;
	res.headersSent = false;
	res.writableEnded = false;
	const headers = {};
	res.setHeader = (name, value) => { headers[String(name).toLowerCase()] = value; };
	res.getHeader = (name) => headers[String(name).toLowerCase()];
	res.removeHeader = (name) => { delete headers[String(name).toLowerCase()]; };
	const sendHead = () => {
		if (res.headersSent) return;
		res.headersSent = true;
		const out = {};
		for (const [name, value] of Object.entries(headers)) out[name] = Array.isArray(value) ? value.join(", ") : String(value);
		port.postMessage({ type: "head", status: res.statusCode, headers: out });
	};
	res.writeHead = (status, extra = {}) => {
		res.statusCode = status;
		for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
		return res;
	};
	const chunk = (data) => {
		if (data === undefined || data === null) return;
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
		if (bytes.length) port.postMessage({ type: "chunk", data: bytes }, [bytes.buffer]);
	};
	res.write = (data) => {
		if (res.writableEnded) return false;
		sendHead();
		chunk(typeof data === "string" ? data : Buffer.from(data));
		return true;
	};
	res.end = (data) => {
		if (res.writableEnded) return res;
		sendHead();
		chunk(typeof data === "string" || data === undefined || data === null ? data : Buffer.from(data));
		res.writableEnded = true;
		port.postMessage({ type: "end" });
		res.emit("finish");
		res.emit("close");
		return res;
	};
	res.destroy = () => res.end();
	// The page went away (an event stream closed): tell the server.
	port.onmessage = (event) => {
		if (event.data && event.data.type === "cancel") {
			res.writableEnded = true;
			req.emit("close");
			res.emit("close");
		}
	};
	handler(req, res);
}
