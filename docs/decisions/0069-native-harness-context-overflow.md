# 0069. Native harness context overflow: hard cutover, evidence notes, and journal lookup

**Status:** Accepted

## Context

When the assembled request fills the model window, the harness must shrink it
without lying about what the model still knows and without rewriting durable
history. 0008 owns `ContextManifest` composition and refuses silent drops of
safety and authority. 0067 prunes bulky tool results mechanically before any
model-written summary, restores goal, acceptance criteria, and recently-edited
files after a reduction, and leaves the durable journal intact. 0066 keeps
overflow off the failure fallback chain and routes titles, summaries, and
compaction to `smol`. Chat still asks a maintenance model to "Summarize the
conversation excerpts" for dropped material. 0039's "compaction" is SQLite
cleanup of identical checkout observations, not LLM context work.

Vendor-managed compaction is not an answer here. OpenAI's documented
Responses path offers `/responses/compact` and
`context_management.compact_threshold`, which emit opaque encrypted compaction
items: vendor-bound, uninspectable, cache-hostile, and against 0007's
provider-neutral harness. Octant already has a lossless journal (0002),
attributed manifests (0008), and mechanical prune first (0067). What is missing
is the overflow contract itself.

This record amends only the overflow and summarization rules of 0067. Advisor,
follow-ups, cache-stable assembly, and tool-result caps there stand. It is a
scoped exception to one step of 0008's preventive reduction order: "summarize
older resolved ranges" becomes last resort after hard cutover, not the step
that always runs once mechanical prune is done. Every other 0008 rule stands.

## Decision

- **Hard cutover is the default when the window is full.** After mechanical
  prune (0067 / 0008), if the assembled request still exceeds the safe input
  budget, the planner drops older messages from the assembled request only, at
  a complete turn or a complete tool-call/result group. It never rewrites,
  deletes, or replaces durable journal events. After the cut the model honestly
  does not have the dropped turns; the product must not pretend otherwise.
- **Model-written summary is last resort, not the routine step.** 0008's
  "summarize older resolved ranges" runs only when hard cutover alone cannot
  fit the turn even with retained required material, or when an explicit path
  asks for a summary of a cut range. A `smol` summary is never the source of
  truth after a cut; the journal remains authoritative, and any summary is
  attributed continuation material the lead may distrust and re-fetch.
- **Goal-less threads summarize by design.** Evidence-bound notes need a plan
  step, Goal evidence, or artifacts; a Chat thread typically has none. For
  threads without such anchors the last-resort summary is the expected path —
  still on `smol`, still attributed and distrustable, cut still disclosed.
  "Last resort" describes goal-driven Work and Code runs, not a promise that
  Chat never summarizes.
- **Notes that survive a cut are evidence-bound.** Claims carried forward must
  point at a plan step (0027), a test result or other `ThreadGoalEvidenceRef`
  (0025), an artifact id, or a file content hash. Prose like "we fixed auth"
  without such a pointer does not cross the cut. Restoring goal, acceptance
  criteria, and recently-edited files (0067) stays mandatory after every
  cutover or last-resort summary.
- **Bounded journal transcript lookup.** The lead may call a harness tool that
  reads older turns, ranges, or artifact refs from the lossless journal for the
  same thread, within that thread's authority only. Results are bounded by
  entry count and byte size; truncation, complete, stale, and unavailable are
  explicit, in the same honesty spirit as 0050. Lookup never widens mode,
  Project, or parent authority.
- **Cache cost is paid once per cut, honestly.** A cutover drops the oldest
  turns of the mutable history, which invalidates the provider prefix cache
  for everything after the cut point; only the system-prompt and tool prefix
  (0067) survives a cut. Cuts are therefore chunky and infrequent — one cut
  frees a meaningful fraction of the window rather than trickling — and the
  one-time re-paid prefix write is part of the journaled cutover decision.
  Between cuts, assembly stays append-only so the rebuilt cache holds.
  Journal lookup results append as ordinary tool results under the usual caps.
- **Still not the failure chain.** This record defines the inside of 0066's
  "context reduction" step: prune, then cutover, then last-resort summary all
  run before 0066's promotion, and promotion to a larger-context model remains
  the step after all of them still leave the request over budget. Overflow
  never walks the slot failure list.
- **Out of scope.** OpenAI `/responses/compact` and opaque compaction items are
  not Octant truth. There is no separate swarm or team memory surface; 0012's
  hierarchy is the product.
- **Implementation sequence** (design only until Accepted): (1) planner teaches
  the cutover boundary, post-prune cutover-before-summarize order, and
  evidence-note assembly from plan, goal, artifact, and file refs already on
  the subject; (2) tools add the bounded journal lookup on the native harness
  surface with count and byte caps and explicit complete, stale, and
  unavailable, registering its schema through the ContextManifest; (3) UI
  honesty surfaces cutovers in the context inspector and composer capacity
  disclosure: what left the request, what evidence notes remain, and that the
  journal still holds the full transcript. It never renders a `smol` summary as
  if it replaced history.

## Consequences

- Long runs keep a warm prefix cache and an honest working set instead of
  paying for opaque vendor compaction the host cannot inspect or replay.
- Evidence-bound notes and journal lookup make "the model forgot" a recoverable
  read, not a silent rewrite of truth.
- Chat's maintenance summarize path survives as the goal-less last resort but
  must adopt this record's attribution and disclosure once Accepted; that is
  implementation work gated on acceptance, not part of this documentation
  change.
- Promotion to a larger-context model (0066) remains available after cutover and
  last-resort summary still leave the request over budget.

## Related

- 0002 Durable event journal and rebuildable projections
- 0007 Direct API providers and the native agent harness
- 0008 Context budget and capacity scheduling (one reduction-order step amended)
- 0012 Mixed-provider subagents and agent runs
- 0025 Long-running goal loops
- 0027 Plans as journaled artifacts
- 0050 Bounded live child conversation
- 0066 Native harness model role slots
- 0067 Native harness turn loop, advisor, and follow-up suggestions
