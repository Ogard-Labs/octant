# 0151. Native resume keeps a durable identity

**Status:** Accepted

## Context

An opaque native session ID alone cannot recover an ACP or Pi conversation
when the host loses its adapter-local identity map. Reconstructing visible
messages in a replacement CLI session loses native history and tool state.
A resumed turn can also have a different allowed tool catalogue.

## Decision

- Extend the provider-neutral resume cursor with an optional durable binding:
  provider instance, Octant session, normalized Project root, mode, and model.
  The server persists the returned cursor before submitting user input. No
  transcript, credential, or tool execution grant belongs in the binding.
- ACP and Pi verify that binding against the acquired task before launching.
  An old cursor without a binding can use its existing adapter-local identity;
  without either, resume refuses. No fabricated binding repairs missing history.
- This partially supersedes 0006's process-local identity limitation for ACP
  and Pi. Its exact-session, confinement, authentication, and fail-closed rules
  remain unchanged. A provider returning a different native ID is refused.
- Resume accepts the current allowed app-tool catalogue through the SDK. ACP
  attaches it through its native load/resume protocol. Removing a selection
  removes that tool on resume; historical tool records remain provider-owned.
  Catalogue presence never substitutes for current server authorization.
- When the ACP runtime advertises native `session/resume`, use it rather than
  `session/load` to avoid replaying the provider transcript into the host on each
  follow-up. Existing profile-specific resume support remains compatible with
  older runtimes; load-only runtimes continue to use native load. Neither path
  creates a replacement conversation or replays user input into a new session.
- Clarify 0113's task-scoped computer grant lifetime: normal turn completion
  closes its tool handle while retaining the app grant until its original expiry.
  Interrupted work cancels pending approval and native input; a changed owner or
  authority revokes the session. This extends lifecycle handling without changing
  0113's consent, expiry, disable, and native confinement requirements.
- Computer driver startup verifies the driver-reported host bundle identity as
  well as protocol and binary versions. A missing or failed identity check closes
  the child and refuses admission. Source-run Electron is not the packaged Octant
  identity and must not substitute its grants for Octant's.
- A computer-use window whose native accessibility surface cannot be resolved
  returns an explicit window-unavailable refusal. A screenshot alone does not
  authorize input; revalidation must still resolve that exact window before acting.
  Tool guidance distinguishes app/window lookup arguments from observation-bound
  action arguments; actions retain the strict schema and cannot retarget a saved
  observation by supplying another app or window.
- Browser context approval belongs to the host-owned task context, not a
  single turn's tool handle. Subsequent turns reuse a still-active context only
  with the same model and effective authority; expiry, stop, or changed authority
  requires fresh approval.
- Pi permits only one live or starting process owner per native session and provider instance in
  the runtime registry, including when the configured driver is recreated. Competing scoped connections refuse before spawning; an
  idle or terminal process closes before its replacement starts. Failed startup and
  completed cleanup release ownership without changing the native history.
  Starting reservations exclude CLI updates before the process becomes active;
  a stale release cannot revoke a newer reservation.
- Pi resumes an existing native file whose header matches both session and
  root. The create-if-missing session-ID flag is only used for session creation.
  Missing, ambiguous, malformed, or cross-Project histories refuse before input.
- The SDK identifies provider-owned conversations explicitly. Chat and Work follow-ups
  reuse the persisted native session and omit prior transcript contributions;
  host-owned API conversations retain their planned history. Both modes journal the
  resume cursor before input and refuses incompatible provider, model, or folder
  bindings without editing earlier turns. Chat retries append an attempt in the
  same native session; they do not create a replacement conversation. Host-side
  transcript compaction is not run for provider-owned conversations.
- Native Chat keeps its confined scratch contents between turns so resuming
  does not remove files referenced by the native session. Explicit task purge
  still removes them. Stateless API scratch behavior is unchanged.
- The SDK does not provide native history rollback. Earlier-message editing
  therefore refuses for provider-owned Chat, with an instruction to append a
  correction. It must not fabricate an edited history in a fresh CLI session;
  host-owned API editing continues to use its explicit superseding-turn model.
- Code startup reads the newest session binding and at most two turn markers
  through a SQLite expression index derived from the journal. It never scans
  message/tool history to decide whether to resume. The index is rebuildable;
  journal payloads remain unchanged.
- Code usage preserves optional provider cache-read and cache-write counters
  through the journal, conversation projection, and renderer. Unreported stays
  unknown. Codex thread totals are normalized to a turn's running usage; old
  native turns and repeated notifications must not be charged again. Late usage
  notifications for another turn in the same native thread are ignored without
  changing the active turn totals or outcome. Cross-thread messages and
  actionable events retain strict correlation checks. New Claude
  runtime usage includes uncached input, cache reads, and cache writes in total
  input; the provider reports these as disjoint counters. Unsafe aggregate totals
  refuse before event emission. Historical journal usage is not rewritten.
  Renderer cache totals remain unknown when any usage-reporting turn omits that
  counter. Coverage records measured turns and tokens separately for reads and
  writes; an explicit zero is measured, while an omitted counter is unknown.
  This coverage describes reported turns, not turns with no usage event.
- The usage dashboard labels its existing reads/(reads+writes) statistic as
  cache traffic read share, not a prompt-cache hit rate. Uncached input is not
  part of that denominator. Missing counters remain unknown and prevent a
  complete traffic ratio; they are never substituted with zero. Historical
  ledger records remain unchanged. A true prompt-cache hit rate requires a
  verified total-input basis and is not inferred from these legacy counters.

- Browser read-page accepts an optional CSS selector to read a specific element,
  such as `h1`, without inferring document structure from flattened body text.
  Omitting it preserves the body read. Desktop and standalone browser runtimes
  use the same action target; origin and credential protections still apply.

- Browser screenshots use the existing provider image-result channel in Chat,
  Work, and Code. Encoded image bytes are not duplicated in JSON text. Missing,
  malformed, and oversized captures refuse; origin approvals and task authority
  still apply before capture.

- If first-turn startup fails after opening the task, withdraw its provisional
  transcript prompt and restore the text to that task’s composer. Restoration
  waits for controller readiness so initial loading cannot erase the draft or
  its refusal reason. Both reach the open task together.

## Consequences

- Restart recovery needs no transcript rewriting or provider history import.
- ACP and Pi follow the SDK subscription contract: each established subscriber
  receives the connection events independently, including output published before
  that subscriber begins reading. Callers subscribe before submitting input or
  invoking tools; a later subscriber does not replay earlier events.
- Older sessions without provable identity remain explicitly unrecoverable;
  their histories are preserved.
- A reconnect may change available tools while retaining the native session.
  Exact-prefix cache reuse still depends on the provider and current authority.

Local latency diagnostics distinguish registry runtime starts from acquisitions
that reuse an existing registry entry. Reuse includes waiting for an in-flight
startup; it is not a claim of a warm process or a model prompt-cache hit. These
bounded measurements retain counts and latency samples, not conversation data.
Drivers that do not use the shared runtime registry are outside these counts.

## Verification

The opt-in Pi native smoke uses a temporary managed session, restarts the host
runtime, resumes the same identity, and asks the provider to recall prior input
and invoke a newly added Octant tool. Run it with `OCTANT_PI_SMOKE=1`,
`OCTANT_PI_BINARY` pointing to the installed CLI, and `OCTANT_PI_MODEL` naming the
exact discovered `provider/model` being verified:

```sh
bun run --cwd apps/server test:evidence src/providers/piSmoke.integration.test.ts
```

This verifies native continuity and tool-result delivery for the selected model.
It does not establish browser approvals, native device input, or support across
all models exposed by the same CLI.

## Related

- 0002 Durable event journal and rebuildable projections
- 0005 Provider SDK contract
- 0006 ACP agent drivers

The local provider-history view can report input cache hit rate because 0102
already normalizes its input denominator to include cache reads and writes.
Compute the ratio from aggregate token counts only when every recorded request
has cache-read coverage and input is positive and consistent. Missing counters
remain unavailable; no historical conversation or journal is rewritten to infer
that denominator. Partial source coverage continues to bound the reading.
