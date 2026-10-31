# 0050. Bounded live child conversation is a server read

**Status:** Accepted

## Context

0045 lets Environment summarize the active thread's child AgentRuns and says
an expanded active row reports when live response text is unavailable. That
honest-unavailable rule remains the default. The host now supplies the missing
server contract, so Environment may render a compact preview of that contract
without inventing a transcript from lifecycle data.

## Decision

This is a scoped exception to 0045's rule that an expanded active row only
says live response text is unavailable. Every other 0045 rule still stands:
Environment stays a transient, renderer-owned disclosure; creating, stopping,
acknowledging, and deeply inspecting children remain in the Agents dock; the
summary never leaks another pane's or Project's runs.

- Live child conversation is a provider-neutral, server-authoritative **read**.
  The event journal stays the source of lifecycle truth; process-local
  transcript text is never journal authority and never a projection.
- Reads are bounded by entry count, entry characters, payload bytes, and a
  replay cursor. Truncation, stale, complete, and unavailable are explicit.
- Octant-managed children expose live text from the host-owned session.
  Provider-native children stay unavailable unless the host observed an
  equivalent transcript capability. A host-retained final reply remains
  readable after completion for both execution kinds.
- Environment may show a compact read-only preview of that snapshot. The
  Agents dock remains the full inspection and control surface.
- Parent-thread authorization is checked before the transient store is
  touched. A restart, cancel, malformed provider event, or purged reply is
  reported as stale or unavailable rather than reconstructed.

## Consequences

- An expanded active Environment row can show bounded live text when the
  server has it, and must still say so when it does not.
- Renderer polling and provider-specific payloads cannot become the
  conversation source of truth.
- Native live transcripts require a later capability evidence path; until
  then the host fails closed.

## Related

- 0002 Durable event journal and rebuildable projections
- 0012 Mixed-provider subagents and agent runs
- 0044 The dock hosts live thread-owned tools
- 0045 Environment summarizes the active thread
