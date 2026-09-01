# 0074. One Machine has one canonical host and store

**Status:** Accepted

## Context

Octant currently lets the desktop reserve a new port, requires a launch-session
capability before a browser can open the product, and makes `octant web --dev`
silently select a `Development` data directory. A browser, Electron window, and
development renderer on one computer can therefore show different Projects and
threads even though they are Devices controlling the same Machine.

The persisted local-authority clock compounds that split. All capabilities it
protects are process-local, yet a durable wall-clock discontinuity can refuse
local window issuance forever. Closing a Machine for days or months must not
make its local product unavailable.

## Decision

- A Machine has one canonical identity, host process, data directory, event
  journal, Project catalog, and thread hierarchy. Device type and renderer mode
  never select a different Machine or store.
- The canonical local host uses the stable loopback endpoint
  `http://127.0.0.1:13773`. Electron attaches to that host or starts it; the
  host is independently runnable and serves the same web application and API.
- Opening the canonical URL locally reaches the product directly. A local
  launch-session URL and a time-bounded window capability are not prerequisites
  for local startup. A client identifier may scope presentation state, but it
  is not authority and never partitions Projects, threads, or history.
- Development mode selects the renderer only. An isolated store is allowed only
  through an explicit data-directory or isolated-profile option and must be
  visibly named as isolated.
- Process-local approvals and grants use process-monotonic elapsed time. A host
  restart discards them; no persisted local-authority epoch may block startup.
- Shared product state is Machine-owned and live across Electron, browsers, and
  other authenticated Devices. Window bounds, panes, focus, scroll positions,
  and unsaved drafts remain client-context state.
- Loopback local access and remote access are separate trust classes. Remote
  access remains opt-in, authenticated, and private-network scoped; remote
  failure never changes local host readiness.
- A browser page actually served from a loopback origin belongs to the local
  trust class regardless of its port. Non-loopback web origins cannot mint
  local context. This intentionally trusts processes running as the local OS
  user, which can already replace or delete the Machine's files; it does not
  grant their provider or tool subprocesses broader product authority.
- Provider and tool subprocesses remain constrained by 0009. Simplifying local
  human access does not widen mode, Project, root, Plan, approval, or sandbox
  authority.

This record partially supersedes 0013 for its local launch-session,
`local-window` capability, and exact-local-renderer-origin requirements. Its
authenticated remote-device rules remain in force. It replaces the recovery
direction proposed by 0032 because the persisted local-authority clock is
removed rather than recoverable.

## Consequences

- Electron becomes one client of the canonical host instead of defining the
  Machine's identity, port, store, or availability.
- Browser and Electron sessions always see the same Projects, threads, settings,
  and journal updates; simultaneous clients may keep independent presentation.
- Tests that need destructive isolation must choose it explicitly. Ordinary
  browser QA uses the canonical Machine and cannot silently create another one.
- Existing `local_authority_clock_guard` rows become inert compatibility data;
  no manual database surgery is required to open an affected Machine.
- Remote authentication can evolve independently without reintroducing a local
  startup dependency.

## Related

- 0002 — durable event journal and rebuildable projections
- 0003 — product modes and authority
- 0009 — sandbox confinement, approvals, and Plan mode
- 0013 — remote access, paired devices, and mobile
- 0032 — the superseded local-clock recovery proposal
- 0054 — the credential broker is a host capability
