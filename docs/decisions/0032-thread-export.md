# 0032. Thread export

**Status:** Accepted

## Context

A thread's transcript, evidence, and provenance already live in the journal.
Until now the only user-facing copy of a conversation was a Chat Markdown
file the renderer assembled from whatever it last saw. That is not an
authoritative cut, does not cover Work or Code, and cannot be the
data-subject export that later host-wide rights rest on.

0028 and 0029 already settled how a journal-derived thing travels as a
portable bundle: a versioned `octant.*-bundle` header, identity beside
content, a stated cut time, no filesystem path, and a paired device that
sees only what it may already read. Thread export is the same idea for one
thread, not a second library.

## Decision

- **The host cuts one thread.** Export is a server command. The renderer
  never assembles the portable record from a local cache, and never claims
  a disconnected view is current.
- **The unit is one thread the caller may already Open.** Chat, Work, and
  Code share one request and one bundle shape. A missing or unreadable
  thread is refused the same way, so the export does not disclose that a
  hidden thread exists. A paired device may export exactly the threads it
  may already read; it cannot dump the host.
- **The format is `octant.thread-bundle/1`.** A JSON object carries an
  `octant` header (format, thread, mode, title, Project, host, version,
  journal sequence, `generatedAt`) beside `transcript`, `evidence`, and
  `provenance`. Keys are written in a fixed order with stable indentation,
  like an artifact bundle, so a person or another tool can inspect it.
- **The journal is the source.** The transcript is the active conversation
  as the mode's own projection holds it. Evidence is what that thread
  journaled: Canvas artifacts it originated (identity plus current
  definition, the same facts an artifact bundle would carry), attachment
  metadata, citations, and Work completion evidence. Provenance is origin,
  provider and model ids, timestamps, and branch or fork parent — never a
  path.
- **Secrets never appear.** Provider credentials, OAuth tokens, raw
  provider payloads, resume cursors, session secrets, and host filesystem
  paths are unrepresentable. Attachment bytes, terminal transcripts, and
  other purgeable bulk content live outside the journal and are named as
  omissions rather than inlined. Every gap the cut left is listed, so a
  partial bundle never reads as the whole thread.
- **This is not a host-wide dump** and not a legal document package. Those
  remain their own work. Import of a thread bundle is not defined here.

## Consequences

- A person can take a portable, inspectable copy of a thread they can
  already read, including from a paired device, without widening
  authority.
- Chat Markdown remains a convenience for copying prose; it is not the
  authoritative export.
- A later host-wide data-subject export can compose this command per
  thread rather than invent a second format.

## Related

- 0002 Durable event journal and rebuildable projections
- 0013 Remote access: single host, paired devices, and mobile
- 0028 The artifact library
- 0029 The artifact storage mirror
