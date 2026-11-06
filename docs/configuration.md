# Configuration (optional config.json file)

The default setup does not require a configuration file. It uses a local Ollama instance and bge-m3 for embeddings, which are fetched automatically when the first /lit-synthesis request is made. Text generation uses the LLM model selected in Pi.

The configuration file is only needed if you want to customize the setup, for example to use llama.cpp, a remote API, a dedicated review model, API keys, or an email address for Unpaywall for extensive PDF downloading.

## Where the file lives

- Linux/macOS: `~/.config/pi-literature-review/config.json` (respects
  `$XDG_CONFIG_HOME`)
- Windows: `%APPDATA%\pi-literature-review\config.json`

`node src/cli.ts llm-check` prints the resolved path as its first line.

The file is intentionally kept outside the package directory and ~/.pi: Pi
may reset these directories during updates, and secrets should not be stored
alongside version-controlled code.


## Keys and contact data

| Key in config.json | Environment variable | Meaning |
|---|---|---|
| `mailto` | `PI_LITERATURE_REVIEW_MAILTO` | Contact email for Unpaywall (required by their policy) and the CrossRef/OpenAlex polite pools. Once set, it is sent with every API request of the package (User-Agent). |
| `openAlexApiKey` | `PI_LITERATURE_REVIEW_OPENALEX_API_KEY` | Free OpenAlex key (openalex.org/settings/api-key). Without one, OpenAlex gives every machine behind the same IP address ONE small daily budget together (about 100 searches a day; a university network shares it), and the results page notes that the run used it. With a key you get your own budget (about ten times as much). It is sent as an `Authorization: Bearer` header, never in a URL; a key OpenAlex refuses fails the OpenAlex part of the run with a message naming this setting. The citation graph page (`network.html`) asks OpenAlex from your browser and stays without a key. |
| `s2ApiKey` | `PI_LITERATURE_REVIEW_S2_API_KEY` | Free Semantic Scholar key (apply at semanticscholar.org/product/api; approval can take a few days). Enables Semantic Scholar as the fourth search source and as a second abstract source. Without a key it is not queried -- its anonymous pool is saturated nearly all the time -- and the results page says so next to the sources. |
| `githubToken` | `PI_LITERATURE_REVIEW_GITHUB_TOKEN` | Raises the GitHub repository search limit from 10 to 30 per minute for the code-first sources (GitHub README search, Google Earth Engine). |
| `codeListTopics` | `PI_LITERATURE_REVIEW_CODE_LIST_TOPICS` | GitHub topics of your research field whose awesome lists the `awesome-lists` code source reads (default `remote-sensing`, `satellite-imagery`, `earth-observation`, the package's home field; the env variable is a comma list). In the `/lit-search` wizard these are the first topic rows under "Curated lists", where the model adds the field topics of the current query and every row can be unticked; on the command line and in web clients they are the topics read. Awesome lists are filed by field: `bioinformatics`, `finance`, `robotics`, `nlp`, `neuroscience`, `gis` each carry dozens of lists, query words like `flood` carry none. |

The `githubToken`, `openAlexApiKey`, `s2ApiKey` and `llm.apiKey` entries are
manual entries or set in the browser's Settings -- no dialog ever asks for a key, and the package never
copies a provider key from Pi's own configuration.




## Models and backends

| Key in config.json | Environment variable | Meaning |
|---|---|---|
| `llm.baseUrl` | `PI_LITERATURE_REVIEW_LLM_URL` | LLM backend address (default `http://127.0.0.1:11434`, Ollama). |
| `llm.api` | `PI_LITERATURE_REVIEW_LLM_API` | `ollama` (default) or `openai` for any OpenAI-compatible server (llama.cpp's llama-server, vLLM, ...). |
| `llm.embedModel` | `PI_LITERATURE_REVIEW_EMBED_MODEL` | Embedding model (default `bge-m3`, multilingual). Changing it re-embeds the index automatically. |
| `llm.generateModel` | `PI_LITERATURE_REVIEW_LLM_MODEL` | Optional dedicated model for the review genres inside Pi (unset = the model selected in Pi runs everything). Headless/CLI runs use it for all generation (default `openscholar-8b`). |
| `llm.chatModel` | `PI_LITERATURE_REVIEW_CHAT_MODEL` | The LLM role without pi (keyword blocks, help, chat answers, summaries); falls back to `generateModel`. Inside pi the model selected there takes this role. |
| `llm.chatBaseUrl`, `llm.chatApi` | `PI_LITERATURE_REVIEW_CHAT_URL`, `_CHAT_API` | Per-role split: a separate server for `chatModel` (a llama-server holds one model). Unset = the generation backend. |
| `llm.embedBaseUrl`, `llm.embedApi` | `PI_LITERATURE_REVIEW_EMBED_URL`, `_EMBED_API` | Per-role split: a separate backend for embeddings. |
| `llm.generateBaseUrl`, `llm.generateApi` | `PI_LITERATURE_REVIEW_GENERATE_URL`, `_GENERATE_API` | Per-role split: a separate backend for generation. Unset roles use the shared `baseUrl`/`api`. |
| `llm.apiKey` | `PI_LITERATURE_REVIEW_LLM_API_KEY` | Bearer token sent on every LLM-backend request; opens the `openai` dialect to REMOTE providers. |
| `thinking` | `PI_LITERATURE_REVIEW_THINKING` | Hidden reasoning for the LLM role (every model call except the synthesis units): `off` (default), `low`, `medium`, `high`. Independent of pi's own thinking level; see [Thinking](#thinking). |
| `browserModel` | -- | Inside pi: the browser interface's own LLM among pi's models (`provider/id`); unset = follow the model selected in pi. Never changes pi's session model; the terminal tools ignore it. |
| `generateThinking` | `PI_LITERATURE_REVIEW_GENERATE_THINKING` | Hidden reasoning for the generation role (the cross-paper synthesis and review units of a report); unset = the value of `thinking`. |
| `pdfFolders` | `PI_LITERATURE_REVIEW_PDF_FOLDERS` | Your PDF folders, read with all their subfolders, never written to (see below). The variable (separated by `:`, on Windows `;`) replaces the stored list. |
| `lastDownloadDir` | -- | The folder of the last download, preselected next time. |
| `ignoredFolders` | -- | Folders the library would read on its own (an older `lit-selection/`, loose PDFs where pi was started) that you took out of the library. |
| -- | `PI_LITERATURE_REVIEW_HOME` | The store for search runs, reports, index and dropped PDFs (default: the folder of the configuration file; `.` = the working directory). |
| -- | `PI_LITERATURE_REVIEW_HISTORY` | Folder of the web interface's conversation history (default: `history/` next to the configuration file). |
| -- | `PI_LITERATURE_REVIEW_BLOCK_CACHE` | File of the saved keyword blocks (default: `keyword-blocks.json` next to the configuration file). |

## Where files live

Two kinds of folders, the same for the terminal and the browser:

- **The store** (default `~/.config/pi-literature-review/`, Windows
  `%APPDATA%\pi-literature-review\`; `PI_LITERATURE_REVIEW_HOME` moves it):
  `lit-search/` (search runs: JSON, HTML, `network.html`, list reports,
  PRISMA diagrams), `lit-synthesis/` (reports, `index/`, `protocols/`),
  `meta/` (the metadata twin of every PDF, named by a hash of its path),
  `inbox/` (PDFs dropped onto the browser page), `history/`,
  `keyword-blocks.json`, `config.json`.
- **Your PDF folders** (`pdfFolders`): any folders, read recursively with
  their structure (own folders, Zotero `storage/`, Citavi attachments).
  Hidden folders are skipped, links are not followed, depth (8 levels) and
  size (50,000 entries per folder) are capped. Nothing is written into
  them: titles, authors and DOIs of a PDF live in the store's `meta/`.
- **Downloads** go into the folder you choose on every run (browser: the
  download window; terminal: the `/lit-selection` folder question); that
  folder becomes a PDF folder.
- Older layouts keep working: a `lit-selection/` in the store or in the
  working directory, and loose PDFs in the working directory, are still
  read (flat), and a twin `.json` next to a PDF is still used.

## Examples

A dedicated review model, everything else default:

```json
{ "llm": { "generateModel": "openscholar-8b" } }
```

Pure llama.cpp -- one `llama-server` instance holds exactly one model:

```json
{ "llm": {
    "embedApi": "openai", "embedBaseUrl": "http://127.0.0.1:9090", "embedModel": "bge-m3",
    "generateApi": "openai", "generateBaseUrl": "http://127.0.0.1:8080", "generateModel": "qwen"
} }
```

with `llama-server --embedding -m bge-m3.gguf --port 9090` for the
embedding side.

Remote embeddings without any local server:

```json
{ "llm": { "api": "openai", "baseUrl": "https://api.openai.com",
           "embedModel": "text-embedding-3-small", "apiKey": "sk-..." } }
```

**Disclosure:** If you use a cloud LLM with Pi, the text of your PDFs is sent
to that provider. Check the permissions and licensing of your documents
before doing so. The local-LLM setup is the default and preferred option of
this package, keeping your documents on your machine.

## Thinking

The package has its own thinking settings, one per model role:
`thinking` for the LLM role and `generateThinking` for the synthesis
units (unset = the same as `thinking`); in the browser's Settings each
sits under its model (Off / Low / Medium / High), default **off**.
They apply inside pi and standalone alike, and is independent of pi's own thinking level (your
other pi work keeps its setting). When on, each call gets extra output
room for the hidden reasoning (2k / 4k / 8k tokens). On the wire: the
Ollama dialect sends `think`; a local OpenAI-compatible server
(llama.cpp) gets `chat_template_kwargs.enable_thinking`; a remote
OpenAI-compatible API gets `reasoning_effort` only when thinking is on;
through pi the level goes to pi's model layer. A llama.cpp model served
through Pi requires a models.json provider with compat.thinkingFormat so
that thinking can be switched. See
[Synthesis -- Thinking](synthesis.md#thinking).

## Error messages

When the embedding backend is unreachable, the error message identifies the
role explicitly: "the embedding model 'bge-m3' is unavailable ...". It also
makes clear that this is not the chat model selected in Pi, but a separate,
small embedding model. The message includes the configured backend address
and lists the available ways to run it: llama.cpp, Ollama, or a remote API.
`node src/cli.ts llm-check` can be used to diagnose the setup. 
