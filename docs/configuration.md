# Configuation (optional config.json file)

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
| `mailto` | `PI_LITERATURE_REVIEW_MAILTO` | Contact email for Unpaywall (required by their policy) and the CrossRef/OpenAlex polite pools. Sent only to those APIs. |
| `s2ApiKey` | `PI_LITERATURE_REVIEW_S2_API_KEY` | Free Semantic Scholar key (apply at semanticscholar.org/product/api; approval can take a few days). Enables Semantic Scholar as the fourth search source and as a second abstract source. Without a key it is not queried -- its anonymous pool is saturated nearly all the time -- and the results page says so next to the sources. |
| `githubToken` | `PI_LITERATURE_REVIEW_GITHUB_TOKEN` | Raises the GitHub repository search limit from 10 to 30 per minute for the code-first sources (GitHub README search, Google Earth Engine). |
| `codeListTopics` | `PI_LITERATURE_REVIEW_CODE_LIST_TOPICS` | GitHub topics of your research field whose awesome lists the `awesome-lists` code source reads (default `remote-sensing`, `satellite-imagery`, `earth-observation`, the package's home field; the env variable is a comma list). In the `/lit-search` wizard these are the first topic rows under "Curated lists", where the model adds the field topics of the current query and every row can be unticked; on the command line and in web clients they are the topics read. Awesome lists are filed by field: `bioinformatics`, `finance`, `robotics`, `nlp`, `neuroscience`, `gis` each carry dozens of lists, query words like `flood` carry none. |

The `githubToken`, `s2ApiKey` and `llm.apiKey` entries are deliberate
manual entries -- no dialog ever asks for a key, and the package never
copies a provider key from Pi's own configuration.




## Models and backends

| Key in config.json | Environment variable | Meaning |
|---|---|---|
| `llm.baseUrl` | `PI_LITERATURE_REVIEW_LLM_URL` | LLM backend address (default `http://127.0.0.1:11434`, Ollama). |
| `llm.api` | `PI_LITERATURE_REVIEW_LLM_API` | `ollama` (default) or `openai` for any OpenAI-compatible server (llama.cpp's llama-server, vLLM, ...). |
| `llm.embedModel` | `PI_LITERATURE_REVIEW_EMBED_MODEL` | Embedding model (default `bge-m3`, multilingual). Changing it re-embeds the index automatically. |
| `llm.generateModel` | `PI_LITERATURE_REVIEW_LLM_MODEL` | Optional dedicated model for the review genres inside Pi (unset = the model selected in Pi runs everything). Headless/CLI runs use it for all generation (default `openscholar-8b`). |
| `llm.chatModel` | `PI_LITERATURE_REVIEW_CHAT_MODEL` | CLI generator for chat answers and summaries; falls back to `generateModel`. |
| `llm.embedBaseUrl`, `llm.embedApi` | `PI_LITERATURE_REVIEW_EMBED_URL`, `_EMBED_API` | Per-role split: a separate backend for embeddings. |
| `llm.generateBaseUrl`, `llm.generateApi` | `PI_LITERATURE_REVIEW_GENERATE_URL`, `_GENERATE_API` | Per-role split: a separate backend for generation. Unset roles use the shared `baseUrl`/`api`. |
| `llm.apiKey` | `PI_LITERATURE_REVIEW_LLM_API_KEY` | Bearer token sent on every LLM-backend request; opens the `openai` dialect to REMOTE providers. |
| -- | `PI_LITERATURE_REVIEW_HOME` | Root folder for the `lit-*` output folders (default: the working directory). |

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

All model calls in the lit-synthesis and lit-search stages run with
hidden reasoning/thinking disabled and with an output limit. There is no
setting to enable it. The Ollama dialect sets think: false; a llama.cpp
model served through Pi requires a models.json provider with
compat.thinkingFormat so that Pi can disable thinking. See
[Synthesis -- Thinking is off](synthesis.md#thinking-is-off).

## Error messages

When the embedding backend is unreachable, the error message identifies the
role explicitly: "the embedding model 'bge-m3' is unavailable ...". It also
makes clear that this is not the chat model selected in Pi, but a separate,
small embedding model. The message includes the configured backend address
and lists the available ways to run it: llama.cpp, Ollama, or a remote API.
`node src/cli.ts llm-check` can be used to diagnose the setup. 
