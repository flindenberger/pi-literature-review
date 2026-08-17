# Requirements

## Per stage

| Stage | Needs | Works without a model? |
|---|---|---|
| `/lit-search` | Internet access to the public APIs. The query-variants tab uses the model selected in Pi for ONE suggestion call. | Yes -- without a model (or when the call fails) the tab degrades to the locked main query plus a note, and the run works as before. |
| `/lit-selection` | Internet access; optionally a contact email for Unpaywall (asked in a dialog, never required). | Yes -- no model anywhere in the download path. |
| `/lit-synthesis` | A local **embedding** model (see below) and a chat model selected in Pi. | No -- answers and reports are generated text; embeddings retrieve the passages. |

Nothing else: no accounts, no API keys, no paid services. Optional keys
(Semantic Scholar, GitHub) only raise rate limits and are never asked for
in a dialog -- see [Configuration](configuration.md).

## The embedding model (synthesis only)

Pi's model API is completion-only; embeddings need a separate small model
served locally. The one-line setup:

```
ollama pull bge-m3
```

and `"llm": {"embedModel": "bge-m3"}` in the config file. `bge-m3` is
multilingual (German questions over English papers rank correctly -- the
code default `nomic-embed-text` is English-centric and only kept for
backwards compatibility). Any Ollama embedding model or any
OpenAI-compatible embedding endpoint (llama.cpp's `llama-server
--embedding`, or a remote API -- with the privacy consequence named in
Configuration) works.

`node src/cli.ts llm-check` round-trips embed and generate against the
configured backend and prints the config path first.

## The chat model

Everything generative in Pi -- query variants, chat answers, summaries,
review synthesis -- runs on the model you selected in Pi (separate
excerpts-only calls, hidden reasoning switched off). Model quality matters
in two places:

- The **agent** side (routing your request to the right tool, passing your
  question verbatim). Small models (8B class, e.g. granite4.1:8b) were seen
  to skip tool calls, rephrase questions and invent follow-ups; the code
  gates (wizard, verbatim question card, paper-chat mode, HTML-write gate)
  exist for exactly that reason, and every stage also has an agent-free
  slash command.
- The **generator** side (grounded answers from numbered excerpts). The
  citation gate catches fabricated markers, but a weak model writes thinner
  prose.

Optionally, a dedicated model can take over the review genres
(`llm.generateModel`), e.g. a hand-imported OpenScholar-8B -- a quality
lever, never a requirement.

## Tested setup

Developed and field-tested on:

- Ubuntu Linux, NVIDIA RTX 5060 (8 GB VRAM), Node as installed by Pi
- Pi with `unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL` served by llama.cpp's
  `llama-server` (32k context) as the agent and generator -- the working
  baseline; a 9B-class instruct model is the practical minimum for the
  agent path
- Ollama serving `bge-m3` (1024 dimensions) for embeddings; optionally
  `openscholar-8b` (imported GGUF) for the review genres
- Firefox for the PDF highlight links (Chromium opens the page but ignores
  the passage search)

Windows and macOS: config paths and folder logic are implemented for both
(`%APPDATA%`, `~/.config`), but neither has been field-tested yet.

## Web frontends

Pi's RPC mode (web frontends such as pi-tau-web-server) is supported with
a modal-dialog fallback for every wizard; see
[Web / RPC clients](rpc-clients.md).
