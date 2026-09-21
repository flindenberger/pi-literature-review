# Requirements

| Stage            | Requirements                                                                             | LLM / embedding model                                                        |
| ---------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/lit-search`    | Internet access to the public APIs.                                                      | Optional — the LLM selected in Pi is only used for query-variant generation. |
| `/lit-selection` | Internet access. A contact email for Unpaywall is optional and requested in a dialog.    | No                                                                           |
| `/lit-synthesis` | A chat model selected in Pi and a small local **embedding** model (`bge-m3` by default). | Yes — chat LLM + embedding model                                             |

The package itself requires no accounts, API keys, or paid services. A free
Semantic Scholar key adds it as a fourth search source (without one it is
not queried: its anonymous access is almost always overloaded); a GitHub
token raises the code-search rate limits. Both go into `config.json` — see
[Configuration](configuration.md).


## The embedding model

Pi's model API is completion-only, so PDF-synthesis needs a separate small
model for retrieval (RAG). The default is `bge-m3` (multilingual, ~1.2 GB)
served by [Ollama](https://ollama.com).

Nothing has to be set up in advance: the first `/lit-synthesis` checks
whether the model is present and offers to fetch it right there -- a
one-time download that stays on your machine. If no backend is reachable,
the same dialog names three equal options:

- install and start Ollama
- run llama.cpp's `llama-server --embedding` with an embedding GGUF
- point the config at a remote OpenAI-compatible API (paper text then
  leaves your machine)

`node src/cli.ts llm-check` prints the config path and round-trips embed
and generate.

## The chat model (LLM)

Query variants, answers, summaries, and synthesis all run on the LLM selected
in Pi. Optionally, llm.generateModel can route synthesis tasks to a
dedicated model.

A 9B model is the minimum recommended size for the agent side. In testing,
smaller models sometimes skipped tool calls or rephrased questions instead of
executing them, especially when tools were invoked through free-text
extension calls. Using slash commands to execute tools helped in these cases.

## Tested setup

- Ubuntu Linux, NVIDIA RTX 5060 (8 GB VRAM)
- Pi with `unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL` on llama.cpp's
  `llama-server` (32k context) as agent and generator
- Ollama with `bge-m3` for embeddings; optionally [openscholar-8b](https://github.com/akariasai/openscholar)
  (imported GGUF) for the synthesis
- Firefox for the PDF highlight links -- Chromium opens the page but
  ignores the passage search

Windows and macOS paths are implemented (`%APPDATA%`, `~/.config`) but not
field-tested. Web UI like [Pi Tau Web Server](https://github.com/milanglacier/pi-tau-web-server) (Pi's RPC mode) are supported with a
modal-dialog fallback -- see
[Development](development.md#web--rpc-clients).
