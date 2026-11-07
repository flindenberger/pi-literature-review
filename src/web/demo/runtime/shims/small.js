/* Browser demo: small stand-ins for node:os, node:url, node:child_process
   and the two npm packages the search never needs in the browser
   (fast-xml-parser for arXiv, which allows no browser requests; unpdf for
   reading PDFs in the paper chat, played back from a recording). The
   build points each module name at its export list here. */

const unavailable = (what) => () => {
	throw new Error(`${what} is not available in the browser demo`);
};

/* node:os */
export const homedir = () => "/demo";
export const tmpdir = () => "/tmp";
export const platform = () => "linux";
export const EOL = "\n";

/* node:url */
export function fileURLToPath(url) {
	const parsed = typeof url === "string" ? new URL(url) : url;
	return decodeURIComponent(parsed.pathname);
}
export function pathToFileURL(path) {
	return new URL(`file://${encodeURI(path)}`);
}

/* node:child_process -- no programs to start in a browser */
export const execFile = (file, args, options, callback) => {
	const done = typeof options === "function" ? options : callback;
	const error = new Error("starting programs is not available in the browser demo");
	if (done) setTimeout(() => done(error, "", ""), 0);
	return { on() {}, kill() {} };
};
export const spawn = unavailable("starting programs");

/* fast-xml-parser */
export class XMLParser {
	parse() {
		throw new Error("arXiv cannot be queried from a browser");
	}
}

/* unpdf */
export const getDocumentProxy = unavailable("reading PDFs");
export const extractText = unavailable("reading PDFs");
export const definePDFJSModule = unavailable("reading PDFs");
