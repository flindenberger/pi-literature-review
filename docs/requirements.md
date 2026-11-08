# Requirements

## Minimum requirements

| Component | Requirement |
|---|---|
| Node.js | 22.19 or newer |
| Pi coding agent | Only for the Pi extension (tested with Pi 1.2). The standalone browser version runs without it. |
| Network | Internet access to the public scholarly APIs |
| Search & select | No model needed. With an LLM, the request is grouped into keyword blocks and synonyms are proposed. |
| Summarize & synthesize | An LLM and an embedding model, see below |
| Accounts | None |

## LLM (chat model)

Writes answers, summaries and synthesis sections over retrieved passages. Never touches paper metadata or citations.

| Interface | Model used |
|---|---|
| Pi, terminal | The model selected in Pi |
| Pi, browser | The model selected in Pi, or its own choice under Settings (Pi's model stays untouched) |
| Standalone | Any server under Settings: llama.cpp (`llama-server`), Ollama, or any OpenAI-compatible API |

- **API dialects:** `openai` (`/v1/chat/completions`, llama.cpp, vLLM, remote providers) or `ollama` (native API)
- **Size:** 9B or larger recommended. Inside Pi, smaller models skipped tool calls or rephrased questions; slash commands avoid this.
- **Context:** tested with 32k tokens
- **Generation model (optional):** a separate model for the cross-paper synthesis sections of a report (`llm.generateModel`)
- **Thinking:** off by default, configurable per role. On modest hardware, thinking can make answers break off.
- **Remote APIs:** excerpts of your PDFs are sent to the provider

## Embedding model (RAG)

Embeds PDF passages for retrieval. Required for chat and reports.

- **Default:** `bge-m3` (multilingual, ~1.2 GB) on [Ollama](https://ollama.com)
- **Setup:** none in advance. The first `/lit-synthesis` offers to pull the model; in the browser: Settings → Embedding → Fetch.
- **Alternatives:** llama.cpp `llama-server --embedding` with an embedding GGUF, or a remote OpenAI-compatible `/v1/embeddings` API (paper text then leaves your machine)
- **Model change:** the index is rebuilt automatically
- **Check:** `npx pi-literature-review llm-check` prints the config path and round-trips both models

## Optional keys

All free. Set them in the browser under Settings or in `config.json` ([Configuration](configuration.md)).

| Key | Effect |
|---|---|
| Semantic Scholar API key | Adds Semantic Scholar as a fourth source. Without a key it is not queried (the anonymous pool is almost always overloaded). |
| OpenAlex API key | Own daily credit budget instead of the one shared per IP address. Sent as a header; an invalid key fails with HTTP 401. |
| GitHub token | Higher rate limits for the code sources |
| Contact email | Polite-pool access and Unpaywall lookups. Asked at the first download. |

## Tested setup

| Component | Version |
|---|---|
| OS | Ubuntu Linux |
| GPU | NVIDIA RTX 5060, 8 GB VRAM |
| LLM | `unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL` on `llama-server`, 32k context, in Pi and in the browser |
| Generation model (optional) | [openscholar-8b](https://github.com/akariasai/openscholar), imported GGUF on Ollama |
| Embedding model | `bge-m3` on Ollama |
| Browsers | Firefox, Chromium. HTML reports opened as local files highlight the cited passage in Firefox only. |

## Platforms

| Platform | Status |
|---|---|
| Linux | Tested |
| Windows, macOS | Implemented, not yet tested |
| Pi web clients (RPC mode, e.g. [Pi Tau Web Server](https://github.com/milanglacier/pi-tau-web-server)) | Supported with a modal-dialog fallback, see [Development](development.md#web--rpc-clients) |
