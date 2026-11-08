# Configuration

No configuration file is needed for the default setup:

- Embeddings: `bge-m3` on a local Ollama, fetched at the first `/lit-synthesis`.
- LLM: the model selected in Pi.

The file is for everything else: llama.cpp, a remote API, a separate generation model, API keys, a contact email. Most entries can also be set in the browser's Settings ([Browser interface](web.md#settings-and-keys)).

## Config file

| Platform | Path |
|---|---|
| Linux, macOS | `~/.config/pi-literature-review/config.json` (`$XDG_CONFIG_HOME` respected) |
| Windows | `%APPDATA%\pi-literature-review\config.json` |

- `node src/cli.ts llm-check` prints the resolved path as its first line.
- Plain JSON, file mode 0600.
- Kept outside the package folder and `~/.pi`: Pi may replace those on updates.
- Environment variables override the file.

## Keys and contact data

| Key in config.json | Environment variable | Meaning |
|---|---|---|
| `mailto` | `PI_LITERATURE_REVIEW_MAILTO` | Contact email. Sent in the User-Agent of every API request except DataCite and ORCID; also as a URL parameter to CrossRef and OpenAlex (`mailto`) and Unpaywall (`email`, required there). Asked at the first download. |
| `openAlexApiKey` | `PI_LITERATURE_REVIEW_OPENALEX_API_KEY` | Free key (openalex.org/settings/api-key). Without it, all machines behind one IP address share one daily credit budget; the results page notes when a run used it. Sent as `Authorization: Bearer` header, never in a URL. A refused key fails the OpenAlex part with a message naming this setting. `network.html` queries OpenAlex from the browser without a key. |
| `s2ApiKey` | `PI_LITERATURE_REVIEW_S2_API_KEY` | Free Semantic Scholar key (semanticscholar.org/product/api). Enables Semantic Scholar as fourth search source and second abstract source. Without it Semantic Scholar is not queried; the results page says so. |
| `githubToken` | `PI_LITERATURE_REVIEW_GITHUB_TOKEN` | Raises the GitHub search limit from 10 to 30 requests per minute for the code sources `github-readme` and `gee-github`. |
| `codeListTopics` | `PI_LITERATURE_REVIEW_CODE_LIST_TOPICS` | GitHub topics whose awesome lists the `awesome-lists` code source reads (env: comma list). See below. |

`codeListTopics`:

- Terminal wizard and CLI: unset = `remote-sensing`, `satellite-imagery`, `earth-observation`. In the wizard they are the first rows under "Awesome lists"; the model adds field topics for the query; every row can be unticked.
- Browser: the stored topics plus the model's suggestions. Unset = no built-in topics offered.
- Topics are research fields (`bioinformatics`, `robotics`, `gis`), not query words.

Keys (`githubToken`, `openAlexApiKey`, `s2ApiKey`, `llm.apiKey`) are entered in the file or in the browser's Settings. No dialog asks for a key; no key is copied from Pi's configuration.

## Models and backends

| Key in config.json | Environment variable | Meaning |
|---|---|---|
| `llm.baseUrl` | `PI_LITERATURE_REVIEW_LLM_URL` | Shared backend address. Default `http://127.0.0.1:11434` (Ollama). |
| `llm.api` | `PI_LITERATURE_REVIEW_LLM_API` | `ollama` (default) or `openai` (llama.cpp `llama-server`, vLLM, any OpenAI-compatible server). |
| `llm.embedModel` | `PI_LITERATURE_REVIEW_EMBED_MODEL` | Embedding model. Default `bge-m3`. A change rebuilds the index. |
| `llm.chatModel` | `PI_LITERATURE_REVIEW_CHAT_MODEL` | Standalone: the LLM role (keyword blocks, help, chat answers, summaries, per-paper units). Unset = `generateModel`. Inside Pi the Pi model takes this role. |
| `llm.generateModel` | `PI_LITERATURE_REVIEW_LLM_MODEL` | The generation role: cross-paper question units and synthesis. Inside Pi: unset = the Pi model. Standalone: default `openscholar-8b`. |
| `llm.chatBaseUrl`, `llm.chatApi` | `PI_LITERATURE_REVIEW_CHAT_URL`, `PI_LITERATURE_REVIEW_CHAT_API` | Separate server for `chatModel`. Unset = the generation backend. |
| `llm.generateBaseUrl`, `llm.generateApi` | `PI_LITERATURE_REVIEW_GENERATE_URL`, `PI_LITERATURE_REVIEW_GENERATE_API` | Separate server for generation. Unset = `baseUrl` / `api`. |
| `llm.embedBaseUrl`, `llm.embedApi` | `PI_LITERATURE_REVIEW_EMBED_URL`, `PI_LITERATURE_REVIEW_EMBED_API` | Separate server for embeddings. Unset = `baseUrl` / `api`. |
| `llm.apiKey` | `PI_LITERATURE_REVIEW_LLM_API_KEY` | Bearer token on every LLM-backend request. Needed for remote `openai` providers. |
| `browserModel` | -- | Inside Pi: the browser's own LLM among Pi's models (`provider/id`). Unset = follow the Pi model. Never changes Pi's model; the terminal ignores it. |
| `thinking` | `PI_LITERATURE_REVIEW_THINKING` | Thinking for the LLM role: `off` (default), `low`, `medium`, `high`. |
| `generateThinking` | `PI_LITERATURE_REVIEW_GENERATE_THINKING` | Thinking for the generation role. Unset = `thinking`. |

Which unit runs on which role: [Synthesis -> Models](synthesis.md#models).

## Folders and storage

| Key in config.json | Environment variable | Meaning |
|---|---|---|
| `pdfFolders` | `PI_LITERATURE_REVIEW_PDF_FOLDERS` | Your PDF folders, read recursively, never written to. The variable (separator `:`, Windows `;`) replaces the stored list; while it is set, a download does not add its folder. |
| `lastDownloadDir` | -- | Folder of the last download, preselected next time. |
| `ignoredFolders` | -- | Legacy places (`lit-selection/`, loose PDFs in the working directory) taken out of the library. |
| -- | `PI_LITERATURE_REVIEW_HOME` | Moves the store (default: the config file's folder; `.` = the working directory). |
| -- | `PI_LITERATURE_REVIEW_HISTORY` | Folder of the browser's conversation history. Default `history/` next to the config file. |
| -- | `PI_LITERATURE_REVIEW_BLOCK_CACHE` | File of the saved keyword blocks. Default `keyword-blocks.json` next to the config file. |

## Where files live

The same for terminal and browser.

**Store** (default: the config file's folder; moved by `PI_LITERATURE_REVIEW_HOME`):

| Path | Content |
|---|---|
| `lit-search/` | Search runs: JSON, HTML, `network.html`, list reports, PRISMA diagrams |
| `lit-synthesis/` | Reports, `index/`, `protocols/` |
| `meta/` | Metadata twin of every PDF, named by a hash of its path |
| `inbox/` | PDFs dropped onto the browser page |

**Next to the config file** (do not move with `PI_LITERATURE_REVIEW_HOME`): `config.json`, `history/`, `keyword-blocks.json`.

**Your PDF folders** (`pdfFolders`):

- Any folders, read recursively (own folders, Zotero `storage/`, Citavi attachments).
- Hidden folders skipped, links not followed. Caps: 8 levels deep, 50,000 entries per folder.
- Nothing is written into them; metadata lives in `meta/`.

**Downloads** go to a folder chosen on every run (browser: download window; terminal: `/lit-selection` folder question). The folder becomes a PDF folder.

**Legacy layouts** are still read, flat: `lit-selection/` in the store or the working directory, loose PDFs in the working directory. A twin `.json` next to a PDF is still used. Read order: [Synthesis -> Corpus](synthesis.md#corpus).

## Examples

Separate generation model, everything else default:

```json
{ "llm": { "generateModel": "openscholar-8b" } }
```

Pure llama.cpp (one `llama-server` holds one model):

```json
{ "llm": {
    "embedApi": "openai", "embedBaseUrl": "http://127.0.0.1:9090", "embedModel": "bge-m3",
    "generateApi": "openai", "generateBaseUrl": "http://127.0.0.1:8080", "generateModel": "qwen"
} }
```

with `llama-server --embedding -m bge-m3.gguf --port 9090` for embeddings.

Remote embeddings, no local server:

```json
{ "llm": { "api": "openai", "baseUrl": "https://api.openai.com",
           "embedModel": "text-embedding-3-small", "apiKey": "sk-..." } }
```

**Disclosure:** with a remote LLM or embedding API, text from your PDFs is sent to that provider. Check the permissions and licences of your documents first. The local setup is the default.

## Thinking

Levels and roles: [Synthesis -> Thinking](synthesis.md#thinking). Independent of Pi's thinking level.

| Backend | Sent |
|---|---|
| Ollama dialect | `think` |
| Local OpenAI-compatible server (llama.cpp) | `chat_template_kwargs.enable_thinking` |
| Remote OpenAI-compatible API | `reasoning_effort`, only when on |
| Through Pi | the level, to Pi's model layer |

A llama.cpp model served through Pi needs a `models.json` provider with `compat.thinkingFormat` (e.g. `qwen-chat-template`). The quick form `provider=URL` registers it without, and thinking cannot be switched.

## Terminal links

| Environment variable | Meaning |
|---|---|
| `PI_HYPERLINKS` | Pi's override for clickable links on the cards: `1` = short linked file names, `0` = full URLs. Unset = detected from the terminal. |

## Error messages

- An unreachable backend names the role and model: `the embedding model "bge-m3" is unavailable: ...`.
- For embeddings it adds that this is a separate model, not the LLM selected in Pi, and lists the options: llama.cpp, Ollama, remote API.
- `node src/cli.ts llm-check` diagnoses the setup.
