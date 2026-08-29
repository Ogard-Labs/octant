# 0064. Native harness model role slots

**Status:** Proposed

## Context

The native agent harness (0007) makes many kinds of model calls: lead turns,
planning, delegated tasks, titles and summaries, image understanding, and
supervision. Each wants a different model, and every call needs continuity when
an endpoint degrades. 0012 sketched per-job "role cards" (Research,
Implementation, Review) with one explicit fallback each; that rule was never
implemented, couples routing configuration to job names that multiply as
delegation grows, and answers nothing for non-delegation calls or for context
overflow. The multi-model pool contract already models ordered candidates,
rejection reasons, and journaled route receipts.

## Decision

- Model routing is configured by **slot**, not by job. Built-in slots are
  `default`, `plan`, `slow`, `task`, `smol`, `vision`, and `advisor`; users may
  define custom slots. Every model call the harness makes names a slot.
- A slot is an ordered candidate list built on the multi-model pool contract.
  Each entry names a provider instance, a model id, and an optional reasoning
  level. The first entry is the primary; the rest are fallbacks.
- Jobs resolve to slots through an editable mapping. Defaults: Lead and
  Implementer to `default`, Planner to `plan`, Reviewer to `slow`, Explorer and
  Researcher to `task`, titles, summaries, and compaction to `smol`, image
  understanding to `vision`, supervision to `advisor`. New jobs reuse existing
  slots rather than growing the configuration.
- Configuration is server-authoritative: one host default plus optional
  per-Project overrides, editable from Settings and the CLI, journaled like
  other settings. Project overrides follow 0012's clamp rules — they may
  narrow but never exceed global ceilings or parent authority.
- An unconfigured slot resolves to the `default` slot's list with a visible
  warning. No slot ever resolves to a hardcoded vendor priority list.
- Failure fallback and context overflow are separate mechanisms and never mix:
  - The failure chain fires on rate limiting, endpoint outage, authentication
    failure, server errors, and timeouts. It walks the slot's list with a
    per-endpoint cooldown, reverts to the primary when the cooldown expires,
    and a circuit breaker stops cascading retry loops.
  - Context overflow never walks the failure chain, because same-sized
    siblings fail identically. Overflow first triggers context reduction
    (0008); if the request still exceeds the window, the call promotes to an
    explicitly configured larger-context model and says so.
- Every routing decision — fallback, revert, promotion, unconfigured-slot
  resolution — is journaled with a reason and surfaced in the UI. A model
  switch is never silent, and automatic routing never selects a more expensive
  model than configured, per 0012.

This record supersedes one rule of 0012, which otherwise stands: mixed-vendor
role cards for Research, Implementation, and Review with an explicit fallback
per role are replaced by slot configuration. A child inherits its model by
resolving its job's slot; all other 0012 rules — authority clamps, bounds,
journaling, capacity scheduling — are unchanged.

## Consequences

- One configuration change fixes every job that uses the slot; the slot
  vocabulary stays small and stable while jobs multiply freely.
- Small-model delegation becomes systematic: meta work is routed to `smol` by
  configuration, not by per-call-site judgment.
- A mid-conversation model switch discards provider prompt caches and re-pays
  the prefix; cooldown-and-revert plus journaled switches keep that cost
  visible and bounded rather than hidden.
- Separating overflow promotion from failure fallback adds one more configured
  concept, but avoids the known failure mode where an oversized request walks
  a same-sized chain and fails at full price on every entry.

## Related

- 0007 Direct API providers and the native agent harness
- 0008 Context budget and capacity scheduling
- 0012 Mixed-provider subagents (one rule superseded, see above)
- 0065 Native harness turn loop, advisor, and follow-up suggestions
