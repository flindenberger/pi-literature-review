/* Browser demo: POSIX paths (Node's node:path) for the in-memory files. */

export const sep = "/";
export const delimiter = ":";
const CWD = "/demo";

export function normalize(path) {
	const absolute = path.startsWith("/");
	const out = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!absolute) out.push(".."); continue; }
		out.push(part);
	}
	const joined = out.join("/");
	return absolute ? `/${joined}` : joined || ".";
}

export function join(...parts) {
	return normalize(parts.filter((part) => part !== "").join("/"));
}

export function resolve(...parts) {
	let path = "";
	for (let i = parts.length - 1; i >= 0 && !path.startsWith("/"); i--) path = path ? `${parts[i]}/${path}` : parts[i];
	if (!path.startsWith("/")) path = `${CWD}/${path}`;
	return normalize(path);
}

export function isAbsolute(path) {
	return path.startsWith("/");
}

export function dirname(path) {
	const trimmed = path.replace(/\/+$/, "");
	const cut = trimmed.lastIndexOf("/");
	if (cut < 0) return ".";
	return cut === 0 ? "/" : trimmed.slice(0, cut);
}

export function basename(path, extension) {
	const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
	return extension && name.endsWith(extension) ? name.slice(0, -extension.length) : name;
}

export function extname(path) {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot) : "";
}

export function relative(from, to) {
	const a = resolve(from).split("/").filter(Boolean);
	const b = resolve(to).split("/").filter(Boolean);
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

export const posix = { sep, delimiter, normalize, join, resolve, isAbsolute, dirname, basename, extname, relative };
export default posix;
