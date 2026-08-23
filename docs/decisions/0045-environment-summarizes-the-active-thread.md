# 0045. Environment summarizes the active thread

**Status:** Accepted

## Context

0042 made Environment a transient thread summary and deliberately kept Agents
in the right dock. Dogfooding showed that this division concealed the most
important operational fact: whether the active thread has delegated work still
running, and what completed children returned. Opening the full Agents tool to
answer that small question made Environment less useful as a control-room
glance.

The distinction is not between environment facts and agents as product areas.
It is between a compact summary of the active thread and the full tools used to
control or inspect it.

## Decision

Environment remains a transient, renderer-owned disclosure for the active
thread. It may summarize thread-owned child AgentRuns alongside checkout and
runtime facts.

- The title-bar toggle, transient open state, dismissal rules, and lack of
  persisted presentation state from 0042 remain unchanged.
- A compact Subagents section reports active and completed counts. Each row
  names the task, lifecycle state, and resolved model when the server exposes
  it.
- Expanding a completed row may show its retained final response and whether
  that response was truncated. Expanding an active row says when live response
  text is unavailable; the renderer never invents a transcript from partial
  lifecycle data.
- The summary reads only the active thread's server-authored hierarchy. Moving
  focus to another pane rebinds it to that pane's thread rather than leaking a
  prior thread's runs.
- Creating, stopping, acknowledging, filtering, and deeply inspecting AgentRuns
  remain in the thread-aware Agents dock. Environment links there instead of
  duplicating those controls.
- Checkout, changes, local servers, working folder, pull-request identity, and
  sources stay compact disclosures. Environment does not become a second dock
  or a stack of permanent cards.

## Consequences

- A glance now answers both what the thread is working in and what it delegated
  without displacing the transcript.
- Completed child output can be inspected without opening a full tool when the
  host retained it.
- Live partial child conversation requires an explicit server contract before
  the UI can promise it; lifecycle state and final retained output are not a
  substitute.
- 0042 is superseded only where it excluded Agents from Environment. Its
  transient presentation, renderer-only open state, and compactness rules are
  preserved here.

## Related

- 0012 defines mixed-provider subagents and server-authoritative AgentRuns.
- 0041 makes utility context follow the active pane.
- 0044 owns the full Agents tool in the right dock.
