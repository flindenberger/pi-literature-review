# Requirements

| Stage | Needs | Runs with no model selected? |
|---|---|---|
| `/lit-search` | Internet access to the public APIs. The query-variants tab makes one suggestion call on the model selected in Pi. | Yes -- the tab then offers only your main query. |
| `/lit-selection` | Internet access; optionally a contact email for Unpaywall (asked in a dialog, never required). | Yes. |
| `/lit-synthesis` | A chat model selected in Pi and one small local **embedding** model. | No. |

No accounts, no API keys, no paid services. Optional keys (Semantic
Scholar, GitHub) only raise rate limits -- see [Configuration](configuration.md).

## The embedding model

Pi's model API is completion-only, so synthesis needs a separate small
model for retrieval. The default is `bge-m3` (multilingual, ~1.2 GB) served
by [Ollama](https://ollama.com). You do not have to set anything up in
advance: the first `/lit-synthesis` checks whether the model is present and
offers to fetch it right there (one-time download, stays on your machine).
If no backend is reachable, the same dialog names the equal options --
install and start Ollama, run llama.cpp's `llama-server --embedding` with
an embedding GGUF, or point the config at a remote OpenAI-compatible API
(paper text then leaves your machine).

`node src/cli.ts llm-check` prints the config path and round-trips embed
and generate.

## The chat model

Everything generative -- query variants, answers, summaries, reviews --
runs on the model selected in Pi. A 9B-class instruct model is the
practical minimum for the agent side (smaller models were seen to skip
tool calls and rephrase questions; the code gates exist for that reason,
and every stage also has an agent-free slash command). Optionally
`llm.generateModel` routes the review genres to a dedicated model.

## Tested setup

- Ubuntu Linux, NVIDIA RTX 5060 (8 GB VRAM)
- Pi with `unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL` on llama.cpp's
  `llama-server` (32k context) as agent and generator
- Ollama with `bge-m3` for embeddings; optionally `openscholar-8b`
  (imported GGUF) for the review genres
- Firefox for the PDF highlight links (Chromium opens the page, ignores
  the passage search)

Windows and macOS paths are implemented (`%APPDATA%`, `~/.config`) but
not field-tested. Web frontends (Pi's RPC mode) are supported with a
modal-dialog fallback -- see [Development](development.md#web--rpc-clients).
