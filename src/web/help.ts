/**
 * The question channel of the chat dialog: fixed help per step, written
 * here in code. The dialog is a state machine whose open question only
 * accepts answers in a known shape; when the user asks something instead
 * ("can I change the keywords?"), the helper answers from the step's help
 * text and a summary of the dialog's state, and the question stays open.
 * The model may tailor the help text to the question; without a model
 * (or when it fails) the help text itself is shown. The helper never
 * advances the state machine and never produces chips: navigation chips
 * come from `navigationChips` below.
 */

import type { Chip, DialogContext, DialogState, StepId } from "./dialog.ts";

/** What the open step's input box accepts: typed text, chips only, or
 * nothing while a job runs. The page greys the box out on choice steps
 * (typing there is only possible in question mode). */
export const STEP_ACCEPTS: Record<StepId, "text" | "choice" | "job"> = {
	start: "text",
	topic: "text",
	blocks: "text",
	code: "choice",
	codeSources: "choice",
	topics: "text",
	period: "text",
	journals: "text",
	authors: "text",
	authorScope: "choice",
	confirm: "text",
	searching: "job",
	pick: "text",
	mailto: "text",
	mailtoSave: "choice",
	download: "choice",
	downloading: "job",
	pickPaper: "text",
	pickPapers: "text",
	questions: "text",
	ask: "text",
	answering: "job",
	reportKind: "choice",
	reporting: "job",
	finished: "text",
	confirmRestart: "choice",
};

interface StepHelp {
	/** Mode line above the input box. */
	mode: string;
	/** What the question means. */
	means: string;
	/** Which inputs the step accepts. */
	inputs: string;
	/** Example inputs offered under the question (text steps). */
	examples: string[];
	/** What the chips do. */
	chips: string;
	/** Limits: what cannot be done here. */
	limits: string;
}

const COMMON_GO = "The keyword blocks and the request can be changed at any later step: type `back` until that question, or click Edit keyword blocks under a help answer; the search then runs again with the new blocks. Typing `back` returns to the previous question with the earlier answers kept; `start over` clears the conversation (files on disk stay). The two stages in the left rail switch within the same conversation; their + buttons start a new one.";

const HELP: Record<StepId, StepHelp> = {
	start: {
		mode: "Choosing what to do",
		means: "This is a literature tool, not a general chat: stage 1 searches and selects papers (open sources, verified records, open-access PDFs into the library), stage 2 summarizes and synthesizes PDFs with page-exact citations. Questions about your PDFs are answered in stage 2 from their text.",
		inputs: "Pick a chip, or type what you are looking for to start a search right away.",
		examples: ["satellite-derived bathymetry of rivers"],
		chips: "Search and select papers starts the search questions; Chat about one PDF and Report over several PDFs need PDFs in the library (your PDF folders, PDFs dropped onto the page, or downloads).",
		limits: "Nothing is searched until the search summary is confirmed.",
	},
	topic: {
		mode: "Answering: what you are looking for",
		means: "The research request. The model splits it into keyword blocks and the search starts at once (last 10 years, 30 records per source, no code sources); the blocks can be edited under the results. Without a model, the request is searched word by word (every word must occur).",
		inputs: "A sentence or a few keywords, in any language.",
		examples: ["water level of rivers from satellite images", "sandbar detection Sentinel-1 Sentinel-2"],
		chips: "None here.",
		limits: "Papers are never searched by the sentence itself: the keyword blocks of the next step are the query (OR inside a block, AND between blocks).",
	},
	blocks: {
		mode: "Answering: confirm or edit the keyword blocks",
		means: "Block search: a paper must match every block; the words inside a block are alternatives. The model proposed the blocks; the variant row adds one synonym per block.",
		inputs: "Edit the lines above (one block per line, alternatives separated by OR or commas), or type new lines, then confirm.",
		examples: ["river OR stream\nwater level OR stage\nsatellite OR Sentinel"],
		chips: "Yes, search with these starts the search; the variant chip adds the model's synonyms; Propose again requests a new proposal; More options opens the questions on code sources, period, journals and authors before the search.",
		limits: "Blocks cannot be widened by a sentence; edit the lines. At least one block needs a term.",
	},
	code: {
		mode: "Choosing: papers with code",
		means: "Whether to add repository-first sources (Hugging Face Papers, GitHub README search, awesome lists, Google Earth Engine) that find code repositories and resolve the papers they cite.",
		inputs: "Pick Yes, No, or Some (then tick sources).",
		examples: [],
		chips: "Yes takes all four sources (up to about 40 s more); No searches papers only; Some lets you tick sources.",
		limits: "Code and data links named in abstracts or publisher records are shown in the report either way.",
	},
	codeSources: {
		mode: "Choosing: which code sources",
		means: "The four repository-first sources, each a toggle.",
		inputs: "Tick sources, then Continue.",
		examples: [],
		chips: "Toggles tick a source on or off; Continue keeps the ticked ones; none ticked means no code sources.",
		limits: "Sources need no key; GitHub search is paced (10 requests per minute without a token).",
	},
	topics: {
		mode: "Answering: GitHub list topics",
		means: "Awesome lists are found by GitHub topic on awesome.ecosyste.ms; the numbers in brackets are lists found per topic.",
		inputs: "Tick topics, type one word to add a topic, or skip the lists.",
		examples: ["remote-sensing", "hydrology"],
		chips: "Use these keeps the ticked topics; Skip the lists leaves awesome lists out of this search.",
		limits: "A topic is one GitHub slug (letters, digits, dashes), not a sentence.",
	},
	period: {
		mode: "Answering: publication period",
		means: "The year range of the papers to search.",
		inputs: "Pick a preset, or type a range.",
		examples: ["2015-2024", "2020-", "last 5 years"],
		chips: "The presets count back from this year; All years sets no limit.",
		limits: "Years apply to the paper's publication date as the sources report it.",
	},
	journals: {
		mode: "Answering: which journals",
		means: "OpenAlex lists the journals with the most works on the keyword blocks; the search can be limited to some of them.",
		inputs: "Tick journals, type numbers or a journal name, or `all`.",
		examples: ["1, 3", "Remote Sensing", "all"],
		chips: "All journals keeps every journal; Use the ticked limits the search to them.",
		limits: "Only listed journals can be ticked; typing a name matches the list, it does not look up others.",
	},
	authors: {
		mode: "Answering: which authors",
		means: "OpenAlex lists the authors with the most works on the keyword blocks (ranked by matching works, not by citations).",
		inputs: "Tick authors, type numbers or a name (3 letters or more look up anyone in OpenAlex), or `all`.",
		examples: ["1, 2", "Tarpanelli", "all"],
		chips: "All authors keeps everyone; Use the ticked limits the search; a looked-up match asks whether to include that author's works outside the topic.",
		limits: "Author filters narrow the search; they do not add papers.",
	},
	authorScope: {
		mode: "Choosing: author scope",
		means: "Whether the picked author's works outside the keyword blocks are included too.",
		inputs: "Pick a chip.",
		examples: [],
		chips: "Yes includes all of that author's works; No keeps only works matching the blocks.",
		limits: "One picked author at a time.",
	},
	confirm: {
		mode: "Answering: confirm the search",
		means: "The summary of the search about to run: blocks, variants, code sources, period, journals, authors, results per source, minimum citations.",
		inputs: "Search, or a tweak: `count N` (results per source), `cites N` (minimum citations), `code on` / `code off`.",
		examples: ["count 30", "cites 5", "code off"],
		chips: "Search runs it; the Change ... chips return to one question with the earlier answers kept.",
		limits: "Sources are fixed (arXiv, CrossRef, OpenAlex; Semantic Scholar only with a free key in the configuration).",
	},
	searching: {
		mode: "Searching ...",
		means: "The search job runs; its progress lines show in the dark box.",
		inputs: "Nothing while it runs; Stop in the progress box cancels it.",
		examples: [],
		chips: "None until the search has finished.",
		limits: "A second job cannot start while one runs.",
	},
	pick: {
		mode: "Answering: which papers to download",
		means: "The results stand as cards above (filter them with the funnel icon); the papers ticked there, or typed here, are downloaded as PDFs into a folder you choose in the download window. Reports from the filtered list (HTML report, PRISMA diagram) are written on click.",
		inputs: "Tick papers in the list above, or type row numbers, DOIs or arXiv ids; `all` takes every on-target paper, `code` every paper with a code or data link.",
		examples: ["1, 4, 7", "all", "code", "10.3390/rs13081505"],
		chips: "Use the ticked papers reads the ticks in the list; All papers with a code link and All on-target papers take those groups; Skip goes on without downloading; Edit blocks reopens the keyword blocks and the search runs again; Add papers with code searches again with the code sources on.",
		limits: "Papers outside this report cannot be added here; a new search finds them. Restricted papers are reported, not downloaded.",
	},
	mailto: {
		mode: "Answering: contact email for Unpaywall",
		means: "Unpaywall (free copies of paywalled papers) requires a contact email by its policy; the address goes only to Unpaywall and the OpenAlex polite pool.",
		inputs: "An email address, or continue without Unpaywall.",
		examples: ["name@example.org"],
		chips: "Continue without Unpaywall tries only OpenAlex, publisher pages and arXiv.",
		limits: "No account is created anywhere.",
	},
	mailtoSave: {
		mode: "Choosing: save the address",
		means: "Whether the address is stored in the configuration file for next time.",
		inputs: "Pick a chip.",
		examples: [],
		chips: "Save stores it in ~/.config/pi-literature-review/config.json; This run only forgets it afterwards.",
		limits: "The address is never sent anywhere else.",
	},
	download: {
		mode: "Choosing: start the download",
		means: "The list of papers to download is complete; the download runs as a job.",
		inputs: "Pick a chip.",
		examples: [],
		chips: "Download starts it; Change the list returns to the paper choice.",
		limits: "Only open-access copies are fetched (OpenAlex, Unpaywall, publisher page, arXiv); restricted papers are listed with a browser link.",
	},
	downloading: {
		mode: "Downloading ...",
		means: "The download job runs; one line per paper in the dark box.",
		inputs: "Nothing while it runs; Stop cancels it (saved PDFs stay).",
		examples: [],
		chips: "None until it has finished.",
		limits: "A second job cannot start while one runs.",
	},
	pickPaper: {
		mode: "Answering: which PDF to talk about",
		means: "A chat answers from one paper's passages (precise), or from the whole library.",
		inputs: "Tick one paper, type its number, or choose the whole library.",
		examples: ["1", "all"],
		chips: "Whole library sets the scope to every PDF.",
		limits: "Papers must be in the library (your PDF folders, PDFs dropped onto the page, or downloads); the search report alone is not enough.",
	},
	pickPapers: {
		mode: "Answering: which papers the report covers",
		means: "The synthesis report is written over the chosen PDFs.",
		inputs: "Tick papers, type numbers, or take the whole library.",
		examples: ["1, 2", "all"],
		chips: "Whole library covers every PDF.",
		limits: "Only PDFs in the library can be covered.",
	},
	questions: {
		mode: "Answering: the report's questions",
		means: "Each question is answered per paper from retrieved passages, with page citations; summaries only skips the questions.",
		inputs: "One question per line, each ending with a question mark.",
		examples: ["Which sensors were used?\nHow was accuracy assessed?"],
		chips: "Summaries only writes the report without questions.",
		limits: "The report quotes passages; it cannot answer beyond the PDFs' text.",
	},
	ask: {
		mode: "Asking the PDFs",
		means: "A question about the chosen PDFs: passages are retrieved locally, the model writes prose over them, citations and page links are inserted by code.",
		inputs: "A question in any language.",
		examples: ["Which satellite data were used?", "How was the water level validated?"],
		chips: "Write a report starts the synthesis report; One paper / Whole library change the scope; New search starts a search.",
		limits: "Answers come only from retrieved passages; a question the PDFs do not cover gets no answer.",
	},
	answering: {
		mode: "Answering ...",
		means: "Passages are being retrieved and the model is writing.",
		inputs: "Nothing while it runs.",
		examples: [],
		chips: "None until the answer is there.",
		limits: "The first question also builds the index (one-time per PDF).",
	},
	reportKind: {
		mode: "Choosing: which report",
		means: "Per-paper detail (one section per paper) or cross-paper synthesis; the review adds a critical section.",
		inputs: "Pick a chip.",
		examples: [],
		chips: "The chips choose the report kind; the report runs as a job and opens on the right.",
		limits: "The report's language follows the language of your questions.",
	},
	reporting: {
		mode: "Writing the report ...",
		means: "The report job runs (retrieval, model prose, citation checks).",
		inputs: "Nothing while it runs; Stop cancels it.",
		examples: [],
		chips: "None until it has finished.",
		limits: "A second job cannot start while one runs.",
	},
	finished: {
		mode: "Asking the PDFs",
		means: "The report is written; more questions, another report, or a new search are possible.",
		inputs: "A question about the PDFs.",
		examples: ["What are the main limitations reported?"],
		chips: "Another report starts a new one; New search starts a search.",
		limits: "Answers come only from retrieved passages.",
	},
	confirmRestart: {
		mode: "Choosing: start over?",
		means: "Clearing the conversation; files on disk and the saved history stay.",
		inputs: "Pick a chip.",
		examples: [],
		chips: "Yes clears the conversation; No continues where you were.",
		limits: "",
	},
};

/** The mode line above the input box. */
export function modeLabel(step: StepId): string {
	return HELP[step].mode;
}

/** Example inputs for text steps (empty for choice steps). */
export function examplesFor(step: StepId): string[] {
	return STEP_ACCEPTS[step] === "text" ? HELP[step].examples : [];
}

/** The fixed help of a step as one text (what the helper answers from). */
export function helpText(step: StepId): string {
	const help = HELP[step];
	const lines = [
		`Open question: ${help.mode}.`,
		`What it means: ${help.means}`,
		`Accepted input: ${help.inputs}`,
		help.examples.length ? `Examples: ${help.examples.map((example) => example.replace(/\n/g, " / ")).join(" | ")}` : "",
		`Chips: ${help.chips}`,
		help.limits ? `Limits: ${help.limits}` : "",
		`Navigation: ${COMMON_GO}`,
	];
	return lines.filter(Boolean).join("\n");
}

/** Short state summary for the helper: what the dialog knows so far. Pure. */
export function stateSummary(state: DialogState, ctx: DialogContext): string {
	const a = state.answers;
	const lines: string[] = [];
	if (a.topic) lines.push(`Request: ${a.topic}`);
	if (a.blocks.length) lines.push(`Keyword blocks: ${a.blocks.join(" AND ")}`);
	if (a.codeSources.length) lines.push(`Code sources on: ${a.codeSources.join(", ")}`);
	if (a.search) lines.push(`Last search: ${a.search.included} papers included, ${a.search.candidates.filter((c) => c.code).length} with a code link; report ${a.search.name}`);
	if (a.pickIds.length) lines.push(`Papers picked for download: ${a.pickIds.length}`);
	lines.push(`PDF library: ${ctx.library.length} PDFs`);
	if (a.questions.length) lines.push(`Questions so far: ${a.questions.slice(0, 3).join(" / ")}`);
	lines.push(`Model: ${ctx.modelLabel ?? "none selected"}`);
	return lines.join("\n");
}

/** System instruction for the helper's model call. The model sees only
 * the help text and the state summary; it must not invent features or
 * name papers. */
export const HELP_SYSTEM = [
	"You are the help of a literature-review tool's chat. The user asked a question while a fixed wizard question is open.",
	"Answer ONLY from the HELP and STATE below, in at most three short sentences, in the language of the user's question.",
	"Say plainly what the user can do next (which input to type or which chip to click). Do not invent features, do not name papers, do not write citations.",
	"If the help does not cover the question, say so in one sentence and point to the accepted input.",
	"Earlier answers can always be changed: `back`, the Back chip, or Edit keyword blocks reopen them. Never say that something cannot be changed unless the HELP's limits say so.",
].join(" ");

/** The user turn of the helper's model call. */
export function helpPrompt(step: StepId, question: string, state: DialogState, ctx: DialogContext, note?: string): string {
	return [
		note ? `NOTE (say this first, briefly): ${note}` : "",
		`HELP:\n${helpText(step)}`,
		`STATE:\n${stateSummary(state, ctx)}`,
		`USER QUESTION: ${question}`,
	].filter(Boolean).join("\n\n");
}

/** What the page shows when no model answers: the help itself, short.
 * `brief` = meaning and accepted input only (small talk at the start). */
export function fallbackText(step: StepId, note?: string, brief = false): string {
	const help = HELP[step];
	const parts = brief
		? [note, help.means, `Accepted input: ${help.inputs}`]
		: [note, help.means, `Accepted input: ${help.inputs}`, `Chips: ${help.chips}`, COMMON_GO];
	return parts.filter(Boolean).join(" ");
}

/** Navigation chips under a help answer: all from code, step-aware. */
export function navigationChips(state: DialogState): Chip[] {
	const chips: Chip[] = [{ id: "continue", label: "Continue", primary: true, title: "Back to the open question" }];
	if (state.answers.blocks.length && state.step !== "blocks" && state.step !== "topic") {
		chips.push({ id: "goBlocks", label: "Edit keyword blocks", title: "Return to the keyword blocks; the search then runs again" });
	}
	if (state.trail.length >= 2) chips.push({ id: "back", label: "Back", title: "The previous question, answers kept" });
	chips.push({ id: "restart", label: "Start over" });
	return chips;
}

/** Small talk or a question about the tool itself, typed where a research
 * request is expected ("hello", "what can you do?"). A research request
 * may itself be a question ("Which methods estimate river depth?"), so a
 * question mark is no signal here: only greetings, thanks, "help" and
 * questions about the tool count. Pure. */
export function looksLikeSmallTalk(text: string): boolean {
	const t = text.trim().toLowerCase().replace(/[?!.]+$/, "");
	if (!t) return false;
	if (/^(hello|hi|hey|good (morning|afternoon|evening)|thanks|thank you|help|hallo|moin|servus|danke)\b/.test(t)) return true;
	return /^(what can you do|what (do|can) you|who are you|what is this|what are you|how does this work|how do you work|can you chat|are you an? )/.test(t);
}

/** Openings of a request about the paper ("summarize", "erklär", "which
 * ..."): such a message goes to the passages without the social check. */
// Follow-ups to the last answer ("more details", "weiter", "ja", "in
// einfachen Worten") count as requests too.
const PAPER_REQUEST = /^(what|which|who|whom|whose|when|where|why|how|is|are|does|do|did|can|could|should|would|will|list|name|give|show|tell|explain|summari[sz]e|describe|compare|define|translate|was|welche[rnms]?|wer|wen|wem|wann|wo|wor|wie|warum|wieso|weshalb|ist|sind|gibt|hat|haben|kann|nenne|nenn|zeig|zeige|erkl[äa]e?r|fass|beschreib|vergleich|liste|übersetz|uebersetz|more|again|continue|go|simpler|shorter|longer|yes|and|also|in|mehr|noch|nochmal|weiter|genauer|einfacher|kürzer|kuerzer|länger|laenger|ja|und|auch|bitte|please)(?![\p{L}])/iu;

/** A chat message that may be small talk rather than a request about the
 * paper: short (at most 8 words), no question mark, no question or
 * request opening. Only such a message costs the extra model check;
 * everything else goes straight to the passages. Pure. */
export function socialCandidate(text: string): boolean {
	const t = text.trim();
	if (!t || t.includes("?")) return false;
	const words = t.split(/\s+/).filter(Boolean);
	if (words.length > 8) return false;
	// "danke, und die Genauigkeit": thanks plus a topic is a request.
	if (/(?:^|[^\p{L}])(und|and|aber|but|oder|or|sowie|plus)(?![\p{L}])/iu.test(t)) return false;
	return !PAPER_REQUEST.test(t);
}

/** The model's check for a short chat message: the marker word for a
 * request about the paper, else a short natural reply. The reply cites
 * nothing and states nothing about the paper. */
export const SOCIAL_SYSTEM = [
	"You sit in front of a chat about a scientific paper. You see one short message from the user.",
	"If the message asks for, or could possibly refer to, anything in the paper (a topic, a term, a method, a number, a request, a keyword, even without a question mark), answer with exactly one word: QUESTION.",
	"A follow-up to the previous answer is a request too: more details, again, simpler, shorter, continue, yes, go on, 'mehr Details', 'weiter', 'ja', 'in einfachen Worten' -> QUESTION.",
	"Thanks together with a topic ('danke, und die Genauigkeit') is a request -> QUESTION.",
	"Only when the message is purely social -- thanks, praise, greeting, goodbye, a reaction such as 'nice' or 'find ich gut' -- reply with one or two short friendly sentences and invite the next question.",
	"Reply in the language of the message: German words (danke, schön, gut, super) get a German reply, English words an English reply, other languages a reply in that language.",
	"Never state facts about the paper, never invent content. When unsure, answer QUESTION.",
].join(" ");

/** The model's output for the social check: a reply text for a purely
 * social message, null for a request about the paper. Anything unclear is
 * null, so the message is looked up in the paper (better once too often
 * than once too few). Pure. */
export function parseSocialReply(raw: string): string | null {
	const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().replace(/^["'\u201c\u201e]+|["'\u201d\u201c]+$/g, "").trim();
	if (!text) return null;
	// The marker word, alone or inside the output ("Ask another question"
	// in a reply is lower case and stays a reply).
	if (/\bQUESTION\b/.test(text) || /^question\W*$/i.test(text)) return null;
	if (text.length > 280) return null;
	// A reply never cites or points into the paper.
	if (/\[\d|\bpage\b|\bseite\b|\bp\.\s?\d/i.test(text)) return null;
	return text;
}

const NAV_CHANGE = "(change|edit|modify|adjust|alter|revise|redo|rewrite|fix|correct|update|refine|tweak|improve|go back to|back to|return to|revisit|[äa]e?ndern|anpassen|bearbeiten|korrigieren|[üu]e?berarbeiten|verbessern|zur[üu]e?ck zu)";
const NAV_BLOCKS = "(keyword|key word|key-word|block|search term|term|quer(y|ies)|synonym|schlagw[oö]e?rt|stichw[oö]e?rt|suchbegriff|suchw[oö]e?rt|begriff|bl[oö]e?ck)";
const NAV_TOPIC = "(request|topic|research question|search sentence|anfrage|thema|fragestellung|forschungsfrage)";
// Word edges written out: `\b` is ASCII-only in JavaScript and misses
// umlauts ("ändern"), so letters are tested with \p{L} under the u flag.
const EDGE = "(?:^|[^\\p{L}])";
const END = "(?![\\p{L}])";
const NAV_BLOCKS_RE = new RegExp(`${EDGE}${NAV_CHANGE}${END}[^.?!]{0,40}${EDGE}${NAV_BLOCKS}|${EDGE}${NAV_BLOCKS}\\p{L}*${END}[^.?!]{0,40}${EDGE}${NAV_CHANGE}${END}`, "iu");
const NAV_TOPIC_RE = new RegExp(`${EDGE}${NAV_CHANGE}${END}[^.?!]{0,40}${EDGE}${NAV_TOPIC}|${EDGE}${NAV_TOPIC}\\p{L}*${END}[^.?!]{0,40}${EDGE}${NAV_CHANGE}${END}`, "iu");

/** A typed wish to change the keyword blocks or the request ("I want to
 * change the keywords", "die Schlagwoerter aendern"): navigation decided
 * in code, never left to the helper model. Pure. */
export function navigationIntent(text: string): "blocks" | "topic" | null {
	const t = text.trim();
	if (!t) return null;
	if (NAV_BLOCKS_RE.test(t)) return "blocks";
	if (NAV_TOPIC_RE.test(t)) return "topic";
	return null;
}

/** A typed text that is a question or a wish rather than an answer:
 * ends with a question mark, or opens like one ("can i", "how", "i want",
 * "hello"). Word counts are not used: a keyword block has many words
 * too. Pure. */
export function looksLikeQuestion(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (t.endsWith("?")) return true;
	return /^(can|could|may|how|what|why|where|which|when|who|is|are|do|does|did|should|would|will|i want|i would|i'd|i need|i wish|please|help|hello|hi|hey|thanks|thank you)\b/i.test(t);
}
