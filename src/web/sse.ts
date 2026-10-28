/**
 * Server-Sent Events: the server pushes progress lines and job states to
 * every open browser tab over one long-lived response. Frame format per
 * the HTML standard: "event: <name>\ndata: <json>\n\n"; a comment line
 * every 25 s keeps proxies and browsers from closing an idle stream.
 */

import type { ServerResponse } from "node:http";

export const KEEPALIVE_MS = 25_000;

/** Encode one frame; exported so the test can assert the wire format. */
export function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface SseConnection {
	send(event: string, data: unknown): void;
	close(): void;
}

export function openSse(res: ServerResponse): SseConnection {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	res.write(": connected\n\n");
	const keepalive = setInterval(() => {
		if (!res.writableEnded) res.write(": keepalive\n\n");
	}, KEEPALIVE_MS);
	keepalive.unref();
	return {
		send: (event, data) => {
			if (!res.writableEnded) res.write(sseFrame(event, data));
		},
		close: () => {
			clearInterval(keepalive);
			if (!res.writableEnded) res.end();
		},
	};
}
