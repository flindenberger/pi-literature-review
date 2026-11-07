/* Browser demo: the part of Node's Buffer the server uses -- bytes with
   utf8 / hex / base64 text conversion, concat, from, alloc. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Buffer extends Uint8Array {
	static from(value, encoding) {
		if (typeof value === "string") {
			if (encoding === "hex") {
				const out = new Buffer(value.length >> 1);
				for (let i = 0; i < out.length; i++) out[i] = parseInt(value.substr(i * 2, 2), 16);
				return out;
			}
			if (encoding === "base64") {
				const raw = atob(value);
				const out = new Buffer(raw.length);
				for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
				return out;
			}
			const bytes = encoder.encode(value);
			const out = new Buffer(bytes.length);
			out.set(bytes);
			return out;
		}
		if (value instanceof ArrayBuffer) return new Buffer(value);
		if (ArrayBuffer.isView(value)) {
			const out = new Buffer(value.byteLength);
			out.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
			return out;
		}
		if (Array.isArray(value)) return new Buffer(value);
		throw new TypeError("Buffer.from: unsupported value");
	}

	static alloc(size) {
		return new Buffer(size);
	}

	static isBuffer(value) {
		return value instanceof Buffer;
	}

	static byteLength(value) {
		return typeof value === "string" ? encoder.encode(value).length : value.byteLength;
	}

	static concat(list) {
		const size = list.reduce((sum, item) => sum + item.byteLength, 0);
		const out = new Buffer(size);
		let at = 0;
		for (const item of list) {
			out.set(item instanceof Uint8Array ? item : new Uint8Array(item), at);
			at += item.byteLength;
		}
		return out;
	}

	toString(encoding = "utf8") {
		if (encoding === "hex") return [...this].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		if (encoding === "base64") {
			let raw = "";
			for (let i = 0; i < this.length; i += 0x8000) raw += String.fromCharCode(...this.subarray(i, i + 0x8000));
			return btoa(raw);
		}
		return decoder.decode(this);
	}

	equals(other) {
		if (other.byteLength !== this.byteLength) return false;
		for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
		return true;
	}
}
