# Configuration

Everything is optional; without a config file the package runs with its
defaults (local Ollama, no keys). All settings live in ONE file at the
OS-standard user-config location:

- Linux/macOS: `~/.config/pi-literature-review/config.json` (respects `$XDG_CONFIG_HOME`)
- Windows: `%APPDATA%\pi-literature-review\config.json`

`node src/cli.ts llm-check` prints the resolved path as its first line.
The file sits deliberately outside the package folder and outside `~/.pi`:
Pi resets and cleans its managed package folders on every update, and keys
must never live next to code that goes into version control. The selection
dialog can write the file for you (mode 0600); otherwise create it by hand.

Every field has an environment-variable override (`PI_LITERATURE_REVIEW_*`),
which wins per field.

| Key in config.json | Environment variable | Meaning |
|---|---|---|
| `mailto` | `PI_LITERATURE_REVIEW_MAILTO` | Contact email for Unpaywall (required by their policy) and the CrossRef/OpenAlex polite pools. Sent only to those APIs. |
| `s2ApiKey` | `PI_LITERATURE_REVIEW_S2_API_KEY` | Free Semantic Scholar key (semanticscholar.org/product/api): a dedicated 1 request/second instead of the often-saturated anonymous pool. |
| `githubToken` | `PI_LITERATURE_REVIEW_GITHUB_TOKEN` | Raises the code-link repository search limit from 10 to 30 per minute. |
| `llm.baseUrl` | `PI_LITERATURE_REVIEW_LLM_URL` | LLM backend address (default `http://127.0.0.1:11434`, Ollama). |
| `llm.api` | `PI_LITERATURE_REVIEW_LLM_API` | `ollama` (default) or `openai` for any OpenAI-compatible server (llama.cpp's llama-server, vLLM, ...). |
| `llm.embedModel` | `PI_LITERATURE_REVIEW_EMBED_MODEL` | Embedding model (default `nomic-embed-text`; recommended `bge-m3`, multilingual). Changing it re-embeds the index automatically. |
| `llm.generateModel` | `PI_LITERATURE_REVIEW_LLM_MODEL` | Optional dedicated model for the review genres inside Pi (unset = the model selected in Pi runs everything). Headless/CLI runs use it for all generation (default `openscholar-8b`). |
| `llm.chatModel` | `PI_LITERATURE_REVIEW_CHAT_MODEL` | CLI generator for chat answers and summaries; falls back to `generateModel`. |
| `llm.embedBaseUrl`, `llm.embedApi` | `PI_LITERATURE_REVIEW_EMBED_URL`, `_EMBED_API` | Per-role split: a separate backend for embeddings. |
| `llm.generateBaseUrl`, `llm.generateApi` | `PI_LITERATURE_REVIEW_GENERATE_URL`, `_GENERATE_API` | Per-role split: a separate backend for generation. Unset roles use the shared `baseUrl`/`api`. |
| `llm.apiKey` | `PI_LITERATURE_REVIEW_LLM_API_KEY` | Bearer token sent on every LLM-backend request; opens the `openai` dialect to REMOTE providers. |
| -- | `PI_LITERATURE_REVIEW_HOME` | Root folder for the `lit-*` output folders (default: the working directory). |

The `githubToken`, `s2ApiKey` and `llm.apiKey` entries are deliberate
manual entries -- no dialog ever asks for a key, and the package never
copies a provider key from Pi's own configuration.

## Examples

Recommended local setup (Ollama, everything on your machine):

```json
{ "llm": { "embedModel": "bge-m3" } }
```

With a dedicated review model:

```json
{ "llm": { "embedModel": "bge-m3", "generateModel": "openscholar-8b" } }
```

Pure llama.cpp (one `llama-server` instance holds exactly one model):

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

**Disclosure:** with a remote backend the text of your PDFs (chunks and
questions) is submitted to that provider -- check permissions and licensing
of your documents first. The local, key-free setup is the default and the
first choice of this package.

## Error messages

When the embedding backend is unreachable, the message names the ROLE
("the embedding model 'bge-m3' is unavailable ...") and states that this is
NOT the chat model selected in Pi but a separate small model, with the
address the config points to and the equal options to run one (llama.cpp,
Ollama, remote API). `node src/cli.ts llm-check` diagnoses the setup.
