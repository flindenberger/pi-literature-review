# Web / RPC clients

Pi web frontends (e.g. pi-tau-web-server) drive Pi in RPC mode. There
the terminal overlay does not exist, so every wizard runs as a chain of
modal dialogs -- one select or editor per step, form tabs as a menu of
fields, a review page with Submit/Cancel. Everything the package does is
available; a few things look different:

- **Empty answers.** Some clients report an editor/input "Save" with EMPTY
  content as *cancelled* (pi-tau-web-server does); the protocol cannot
  distinguish the two. The dialog chain therefore never treats an editor
  cancel as a run abort: empty stays a legal answer (an empty query still
  cancels honestly at submit), and cancelling the run is the Cancel row of
  any select step or of the review page.
- **Result cards** are a terminal feature. In RPC mode a finished
  `/lit-search` or `/lit-synthesis` command run hands its text to the AGENT
  for one visible chat answer -- web clients only render agent messages
  persistently; the run itself stays agent-free, the model only presents
  the finished text and is instructed to copy it verbatim including
  reference lines. The verbatim result also lands in the LLM context, so
  follow-up chat is informed. The HTML/JSON files land on disk as usual; a
  "Search finished" notification carries the path.
- **Progress** ("working -- Ns elapsed") uses widgets and is invisible in
  clients that do not render them.
- **Notifications** may vanish after a few seconds in some clients; the
  files and the agent's answer are the durable record.

Nothing on the web-server side is patched by this package.
