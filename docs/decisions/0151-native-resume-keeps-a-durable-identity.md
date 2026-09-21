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
- Pi resumes an existing native file whose header matches both session and
  root. The create-if-missing session-ID flag is only used for session creation.
  Missing, ambiguous, malformed, or cross-Project histories refuse before input.
- The SDK identifies provider-owned conversations explicitly. Work follow-ups
  reuse the persisted native session and omit prior transcript contributions;
  host-owned API conversations retain their planned history. Work journals the
  resume cursor before input and refuses incompatible provider, model, or folder
  bindings without editing earlier turns.
- Code startup reads the newest session binding and at most two turn markers
  through a SQLite expression index derived from the journal. It never scans
  message/tool history to decide whether to resume. The index is rebuildable;
  journal payloads remain unchanged.
- Code usage preserves optional provider cache-read and cache-write counters
  through the journal, conversation projection, and renderer. Unreported stays
  unknown. Codex thread totals are normalized to a turn's running usage; old
  native turns and repeated notifications must not be charged again.

## Consequences

- Restart recovery needs no transcript rewriting or provider history import.
- Older sessions without provable identity remain explicitly unrecoverable;
  their histories are preserved.
- A reconnect may change available tools while retaining the native session.
  Exact-prefix cache reuse still depends on the provider and current authority.

## Related

- 0002 Durable event journal and rebuildable projections
- 0005 Provider SDK contract
- 0006 ACP agent drivers
