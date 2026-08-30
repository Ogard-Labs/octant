# 0067. Native harness turn loop, advisor, and follow-up suggestions

**Status:** Proposed

## Context

0007 gives the native harness an Octant-owned agent loop but fixes neither the
loop's efficiency obligations nor how supervision and turn-end follow-ups work.
Token spend and latency are product qualities of a first-party harness: prompt
caches are invalidated by a single unstable byte in the request prefix, bulky
stale tool results crowd out working context, and supervision designs that
review every turn double model cost. These constraints shape contracts and
must be decided before implementation, not tuned after.

## Decision

- The turn loop is a single append-only message history per session. Requests
  are assembled deterministically — a stable system prompt, tool definitions
  serialized in a fixed order, per-turn dynamic context appended as message
  content at the end — so provider prefix caches stay warm across turns. The
  system prompt including tool definitions stays small (on the order of one
  thousand tokens); capability detail loads lazily on use.
- Every tool result is hard-capped with an explicit truncation marker and
  paging the model can act on; truncation is never silent. Read-only tools
  that are safe to run concurrently execute in parallel, and all of a turn's
  tool results return in one message, ordered by the original tool-call order
  with stable serialization — completion order never changes request bytes.
- Context reduction prunes stale bulky tool results mechanically before any
  further shrink, per the 0008 ladder as amended by 0068. When the window is
  still full, hard cutover, evidence-bound notes, and journal lookup follow
  0068; model-written summary is last resort and runs on `smol` (0066).
  Pruning and cutover change only the assembled request, never the durable
  journaled history. After every cutover or last-resort summary the goal, its
  acceptance criteria, and recently-edited files are restored to context.
- Meta work — titles, summaries, compaction — never runs on the lead's slot;
  it runs on `smol` (0066). An unconfigured `smol` resolving to the `default`
  chain is 0066's warning case to fix, not a sanctioned routing.
- The advisor is a supervising role on the `advisor` slot. It may cancel the
  lead's in-flight turn, inject a redirect the lead must read before its next
  turn, and pause the run for the user. It never executes tools, edits files,
  or grants approvals — supervision carries no side-effect authority. This
  constrains the advisor only: the lead writes within its own run, and
  delegated children keep writing inside their own isolated worktrees per 0012. The advisor
  reviews compact turn digests and boundary artifacts (an approved plan, a
  diff about to be committed), not full transcripts, and the lead may consult
  it on demand as a second opinion. Every intervention is journaled.
- At turn end the lead may attach up to three structured follow-up
  suggestions, each with a title, a standalone prompt, and a target: continue
  in this thread, a new thread, or a new thread on its own worktree. Surfaces
  render them as actions; activating one previews exactly what would be
  created and requires explicit confirmation. Suggestions carry no authority
  and create nothing by themselves.
- Efficiency is verified, not assumed: a standing integration test repeats a
  request with an unchanged stable prefix and a changed dynamic suffix and
  asserts the provider reports cache reads covering that prefix — not merely
  a nonzero count, which a partial hit could satisfy. A fixed benchmark
  suite records tokens, turns, and wall-clock per release so regressions are
  visible as trends.

## Consequences

- Cache-stable assembly constrains everything that composes requests: nothing
  may interpolate timestamps, identities, or mode flags into the prefix, and
  per-mode behavior is expressed as message content rather than swapped tool
  sets.
- Digest-and-boundary supervision keeps the advisor's cost a small fraction of
  the lead's instead of doubling it, at the price of the advisor seeing less
  than a full transcript.
- A no-writing supervisor keeps runs attributable and debuggable even when
  the advisor intervenes: every write traces to the lead or to one delegated
  child's worktree, never to the reviewer.
- Follow-up suggestions make next steps one confirmation away without granting
  the model any power to spawn work, matching the rule that structured
  references never install, enable, or elevate.

## Related

- 0007 Direct API providers and the native agent harness
- 0008 Context budget and capacity scheduling
- 0025 Long-running goal loops
- 0066 Native harness model role slots
- 0068 Native harness context overflow (amends overflow and summarization)
