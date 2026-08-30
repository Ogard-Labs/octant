# 0008. Context budget, provider limits, and capacity scheduling

**Status:** Accepted

## Context

Agent harnesses grow context invisibly: instructions, memory, skills, tool
schemas, MCP servers, attachments, tool results, and subagent output all
append to a prompt until a provider rejects it or silently truncates. Token
limits also arrive from many sources of varying trust, and concurrent threads
and subagents against one provider can create retry storms. Octant needs one
provider-neutral place where context is composed, budgeted, explained, and
scheduled.

## Decision

- Every Chat, Work, Code, tool, MCP, memory, attachment, and subagent request
  passes through one Octant-owned context planner before it reaches a model.
  Provider adapters report facts and usage; they cannot append unaccounted
  context or bypass planning.
- Before each turn Octant builds a `ContextManifest`: every contributing
  subsystem registers attributed entries (instructions, conversation,
  summaries, files, memory, skills, tools, MCP, tool results, artifacts,
  subagent output) instead of appending opaque text.
- Estimates distinguish exact provider usage, tokenizer estimates,
  conservative heuristics, and unknown overhead. After the provider reports
  actual usage, a `UsageReconciliation` compares plan and reality and updates
  the variance reserve for that instance, model, adapter, and request shape.
- Model limits (`ModelContextLimits`) and live service limits
  (`ProviderServiceLimits`) are separate profiles with source, confidence, and
  freshness. Conflicting trustworthy sources resolve to the most conservative
  value and expose the conflict. An absent service limit is `unavailable`,
  never `unlimited`. User-supplied limits for generic endpoints stay visibly
  user-supplied.
- Provider runtime rate-limit windows are retained as bounded, process-local
  evidence on `ProviderServiceLimits`. A window may report utilization and a
  reset instant without an absolute quota; Octant keeps those facts separate
  and does not derive a numeric limit or remaining count from a percentage.
- Hosts may expose provider service-limit facts through an authenticated,
  loopback-only usage-limits read and an explicit refresh command. Refreshes
  are coalesced, bounded by cancellation-aware timeouts, and honor provider
  retry windows. A failed refresh preserves the last successful limits as
  visibly stale; drivers without `contextFacts.observeServiceLimits` report
  `unavailable` when no independently observed runtime evidence exists rather
  than causing a guessed network request. Normalized runtime rate-limit
  windows are valid evidence on their own and remain visibly scoped to those
  windows. The surface never stores cookies, credentials, raw provider
  payloads, or account data.
- Safe input budget is the context window minus reserved response budget,
  reasoning reserve where applicable, provider framing estimate,
  observed-variance reserve, and safety margin. No turn is sent when planned
  input exceeds it; reducing the response budget is an explicit remedy.
- Preventive reduction follows a fixed order: exact duplicates; superseded
  snapshots and stale optional context; load only relevant tool and MCP
  schemas; replace large results with structured summaries plus artifact
  references; reuse durable summaries; summarize older resolved ranges;
  narrow memory and secondary Project context; finally ask the user. Active
  safety and mode policy, effective authority and unresolved approvals, the
  current request, required task state, pinned content, and explicitly
  selected critical material are never removed silently; if they cannot fit
  the turn is blocked with concrete remedies.
- Users can pin or exclude entries for the next turn and inspect the manifest
  before sending. Pins do not bypass the budget; overrides are turn-scoped.
- One central capacity scheduler owns per-instance request and token buckets,
  concurrency limits, estimated reservations for queued and running work,
  retry-after and jittered backoff, reconciliation with actual usage, and
  release on cancellation or timeout. Every turn and managed child passes
  through it. Where a provider CLI hides its network requests, Octant limits
  observable concurrent turns and labels fine-grained enforcement unavailable.
- Tool and MCP schemas load lazily by relevance; large results are stored as
  local artifacts and summarized into context.
- The status bar exposes the focused thread's context composition, headroom,
  model limits, and live service limits.
- The journal-backed usage ledger feeds a local-first usage dashboard by
  provider, model, Project, thread, mode, extension, tool, and context source.
  Provider-reported usage is preferred; estimates and unknowns stay visibly
  distinct; unknown usage or price is never rendered as zero; monetary
  figures appear only from reviewed pricing metadata or explicit user
  configuration. The dashboard stores no prompt bodies, transcript text,
  credentials, or raw provider payloads.

## Consequences

- Overflow becomes a planned, explained refusal instead of a provider error;
  users can see what is in context and why.
- Every subsystem that contributes context must register through the manifest,
  which is a small tax on new tools and a large gain in attribution.
- Concurrency across threads and subagents is bounded by observed provider
  capacity, so a burst degrades to queueing rather than to rejections.
- Estimates will be conservative early for new providers; reconciliation
  narrows them over time without hiding uncertainty.

## Related

- 0005 Provider SDK contract
- 0007 Direct API providers and the native agent harness
- 0012 Mixed-provider subagents
- 0044 The dock hosts live thread-owned tools
- 0069 Native harness context overflow (amends one reduction-order step)
