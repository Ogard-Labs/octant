# 0048. Explicit Chat thread dialogue

**Status:** Accepted

## Context

0003 makes a `#thread` reference read-only so a prompt can borrow a bounded
transcript without silently steering another conversation. That remains the
safe default, but it does not support an explicit coordination request where
one Chat thread needs another Chat thread to perform a bounded piece of work
and return the result.

## Decision

- A Chat user may explicitly mention one or more target Chat threads in a turn.
  Mentioning a target is the user-visible grant that makes the coordination
  tool available for that turn; an unmentioned thread cannot be messaged.
- The source provider receives one provider-neutral app-managed tool,
  `octant_thread_message`. The tool accepts a target Chat thread id and a
  bounded message. The server re-checks that the target is active, readable by
  the source window, and one of the explicitly mentioned targets before it
  sends anything.
- The target receives an ordinary durable Chat turn through its own provider,
  Project, memory, approvals, and context policy. The target never inherits the
  source thread's filesystem, shell, Git, credentials, or provider session.
- The tool waits for the target turn to settle and returns a bounded typed
  result containing the target title and completed reply, or an explicit
  waiting/refused/failed result. The source provider may summarize or quote
  that reply in its own turn; no renderer-side transcript is fabricated.
- Coordination depth is one. A target turn started by this tool cannot receive
  the coordination tool, preventing agent-to-agent loops. The source may make
  at most three target sends in one turn.
- A target that is already running is not silently interrupted or duplicated;
  the tool returns `waiting` and the source must decide what to do next.
- Work and Code threads are not message targets in this first slice. Their
  existing read-only mention behavior, child AgentRun controls, approvals, and
  workspace authority remain unchanged.

This record supersedes the single `0003` consequence that all thread
references are read-only only for the explicit, mentioned Chat coordination
path above. Ordinary mentions remain read-only.

## Consequences

- The server remains the authority for target discovery, Open permission,
  lifecycle, active-turn admission, and result framing.
- A target's transcript shows the incoming turn and its own assistant reply;
  the source transcript shows the source provider's response, which can include
  the typed target reply returned by the tool.
- Provider capability is honest: if app-managed tools are unavailable, the
  source cannot coordinate and the existing mention remains read-only.
- Durable cross-thread dialogue history is not copied into either thread. The
  target owns its turn; the source owns the request and the provider response.

## Related

- 0002 Durable event journal
- 0003 Product modes and authority
- 0005 Provider drivers and capabilities
- 0012 Mixed-provider subagents and AgentRuns
- 0044 The dock hosts live thread-owned tools
