# 0004. Monorepo layering and dependency direction

**Status:** Accepted

## Context

Octant ships a desktop host, a server, a shared React renderer, a CLI, a
mobile client, and a set of packages from one repository. Without a stated
dependency direction, provider payloads leak into contracts, React components
start deciding authority, and pure policy grows filesystem and process
dependencies that make it untestable. The layering below is the rule every
new package and feature follows.

## Decision

- Applications consume packages; packages never import applications.
  - `apps/desktop`: Electron lifecycle, native windows, Keychain and the
    credential broker, macOS sandbox processes, local server management,
    packaging boundary.
  - `apps/server`: commands, journal, projections, providers, tools, Git,
    terminals, remote listener, recovery. The only process that resolves
    binaries, spawns provider or tool processes, or holds provider SDK clients.
  - `apps/web`: the shared renderer for desktop and authenticated remote
    clients. It issues typed commands and renders projections; it holds no
    authoritative local storage fallback.
  - `apps/mobile`: native remote-control client built on the same contracts,
    domain, and client runtime.
  - `packages/cli`: terminal presentation and local-host attachment; it never
    opens its own store or embeds a second server owner.
- `packages/contracts` is schema-only: branded ids, commands, events, RPC and
  wire shapes, versioned envelopes, typed public failures. Contracts use
  Effect Schema, reject excess properties, and contain no SQLite, filesystem,
  service, or runtime logic. Provider-specific payloads never cross this
  boundary.
- `packages/domain` is pure: mode policy, capability and authority
  comparison, delivery and status transitions, activation ladders, layout
  operations, recovery classification. It has no filesystem, process, network,
  persistence, React, Electron, or provider SDK dependency.
- `packages/provider-sdk` owns driver interfaces, the normalized runtime event
  and capability vocabulary, typed adapter failures, and the conformance
  harness. It imports no React, Electron, persistence, or vendor SDK; a driver
  contract must be understandable without reading any adapter.
- `packages/client-runtime` owns authenticated transport, reconnect and
  sequence-based replay, optimistic version handling, and query
  synchronization shared by web, desktop, CLI, mobile, and remote clients.
  React is never the transport owner.
- `packages/theme`, `packages/extensions` (plugin host), and
  `packages/host-runtime` are narrow, purpose-named packages with explicit
  subpath exports; there is no grab-bag utility package.
- Adapters live at the edges: provider adapters in the server map vendor
  protocols into normalized events; renderer adapters wrap UI primitives.
  Vendor identifiers stay confined to adapters, configuration, and factual
  documentation.
- Authority checks run on the server before side effects. Renderer controls
  are explanatory. The event journal is authoritative; projections are
  rebuildable and idempotent.
- Effect is used where lifecycle, concurrency, resource safety, typed failure,
  or service composition materially benefits: server runtime composition,
  connection lifetime, process supervision. Pure or simple synchronous
  behavior stays direct TypeScript. SQL transactions stay explicit and small.
- Deep modules sit behind small server-owned interfaces that accept ports
  (inference, tool dispatch, persistence, clock, audit) and return decisions
  and events rather than writing databases, files, or UI state directly.
- New first-party names use `@octant/*`, `OCTANT_*`, and Octant identifiers.
  Third-party code enters only as an approved dependency with a compatible
  license and explicit architectural fit; no other product's source, assets,
  schemas, copy, or distinctive structure is imported.

## Consequences

- Most logic is testable without a database, process, or browser; the server
  is where integration risk concentrates and where integration tests belong.
- Adding a provider, tool, or surface means adding contracts and domain policy
  first, then server wiring, then UI; skipping the first two is a review
  failure.
- The renderer cannot be trusted with secrets, paths, or process handles, so
  every host capability needs a typed server route or desktop bridge.
- Extracting the agent runtime or the client runtime into separate
  repositories later is possible because they already depend only on
  contracts, domain, and ports.

## Related

- 0002 Durable event journal
- 0005 Provider SDK contract
- 0016 Component foundation and theme
