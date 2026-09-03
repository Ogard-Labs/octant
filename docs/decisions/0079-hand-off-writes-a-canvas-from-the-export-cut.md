# 0079. Hand off writes a Canvas from the export cut

**Status:** Accepted

## Context

A person leaving a thread — for a colleague, for tomorrow, for another
provider — has the transcript and the export bundle (0036), neither of which
says what the work was for, what is done, what is left, or how to continue.
Writing that document by hand means re-reading the thread. The thread's own
provider already holds the context, and the host already knows how to cut the
thread, how to run one bounded provider request outside a turn (context
maintenance), and how to keep an authored document as a Canvas (0010).

## Decision

- **Hand off is a server command.** `POST /api/threads/hand-off` takes the
  same `{ mode, threadId }` as export and is authenticated the same way. The
  renderer never assembles the document.
- **Who may hand off is who may export.** The command starts from the export
  cut, so a missing or unreadable thread is refused identically and a paired
  device may hand off exactly the threads it may read.
- **The cut decides readiness.** A cut that names an in-progress turn is
  refused as `turn-running`; a thread outside a Project is refused as
  `project-required`; an empty transcript as `empty-thread`. A provider the
  host does not observe as `ready` is refused as `provider-unavailable`. Every
  refusal is an ordinary answer the person can act on, not an HTTP failure.
- **The thread's own provider writes it.** One tool-free, read-only session on
  the thread's provider instance and model, in a private scratch root, with
  the transcript from the cut and a fixed instruction naming six sections:
  objective, workspace and context, what was done, what is left, decisions and
  risks, how to continue. The request carries no tools and no authority over
  the thread's workspace, and is bounded by a deadline.
- **The document is a Canvas of the thread.** The provider's Markdown becomes
  headings and paragraphs of the closed block catalog and is created through
  the ordinary Canvas create path, scoped from the thread the way an authoring
  agent's Canvas is. It therefore appears in the thread's cards, in later
  export bundles as evidence, and in the artifact mirror where one is
  configured. No new persistence path exists.
- **It opens beside the transcript.** The renderer treats the handed-off Canvas
  as a document the thread wrote (0044): the dock's Canvas tool opens on it
  once, without moving focus, and stays closed once the person closes it.

## Consequences

- Chat, Work, and Code threads share one Hand off action in the thread's
  menus; the receipt names why a refused hand-off did not happen.
- A hand-off is journaled evidence of the thread, not a file the renderer
  minted, so it survives restart and travels with the thread's export.
- The Canvas renders text as written: the provider is asked for plain
  Markdown, and inline emphasis is dropped rather than shown as markup.

## Related

- 0010 Secure file preview and canvas artifacts
- 0036 Thread export
- 0044 The dock hosts live thread-owned tools
