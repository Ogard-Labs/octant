# 0005. Provider SDK contract, registry, and honest capabilities

**Status:** Accepted

## Context

Octant must work with many AI backends: installed coding CLIs and agent
runtimes (Codex, Claude, OpenCode, Kilo Code, Pi, Devin, Mistral Vibe, Kimi
Code, Cursor), local model servers (Ollama), and direct HTTP endpoints
(OpenAI-compatible, Anthropic-compatible, Azure AI Foundry, Bedrock). These
differ in transport, authentication, session model, permission semantics, and
what they can honestly report. Without a shared contract each integration
would invent its own events, readiness states, and authority shortcuts, and
the product would quietly depend on one vendor's features.

## Decision

- Every backend is a driver behind one provider-neutral contract in
  `packages/provider-sdk`: non-mutating readiness probe; model and option
  discovery; start and resume session; send input and stream output; interrupt
  and stop; answer approval and user-input requests when supported; normalized
  usage and terminal state; normalized reasoning, tool, task, diff, file-change,
  and child-agent activity; and classification of provider, process, protocol,
  authority, and stale-resume failures.
- A shared conformance harness exercises every driver against that contract.
  Driver-specific facts stay private to the adapter unless promoted into a
  versioned provider-neutral contract.
- Providers use a durable multi-instance registry. An instance records a
  stable Octant id, display name, driver kind, binary path or endpoint
  configuration, enabled state, environment policy, and indirect credential
  references. Multiple instances of one driver kind are valid. Registry
  changes are journaled; managed process state is never persisted as if it
  survived restart.
- Installed version, authentication readiness, models, capabilities, health,
  and process state are observed facts refreshed by non-mutating probes and
  invalidated on process exit or configuration change. Readiness is one of
  `ready`, `unavailable`, `unauthenticated`, `incompatible`, `degraded`,
  `checking`.
- Capabilities are reported honestly per instance, model, mode, and runtime as
  `supported`, `unsupported`, or `unavailable`. Every capability begins
  `unavailable` until negotiation or evidence proves otherwise. A broken
  installation is never shown as a permanent lack of a feature. When a required
  capability cannot be confirmed, Octant fails closed and states why.
- No core capability may require a specific provider. Provider-native features
  may optimize behavior but never become the only route to core functionality.
- Octant owns session authority: `full-access`, `approval-gated` (provider
  permission requests become normalized approval events), and `plan`
  (read-only, writes rejected). An adapter may narrow authority to match
  provider limits but never widen it; if a provider cannot represent the
  required semantics safely, the driver reports degradation or blocks rather
  than approximating. Provider permission callbacks are signals, not a sandbox.
- Authentication stays provider-native. Subscription and OAuth flows are
  delegated to the provider's documented protocol or its own login surface;
  Octant never reads, stores, renders, refreshes, exports, or journals OAuth
  tokens. Explicit API-key modes use the host Keychain through a write-only
  broker; the renderer never receives a stored secret. Modes never fall back
  to one another silently. Octant detects binaries, versions, and readiness
  but never installs or updates provider runtimes.
- Managed process drivers use one supervised process group per active
  session, a configured absolute executable path, a minimal sanitized
  environment, provider telemetry/updates/background survival/native
  plugins disabled where supported, bounded I/O and timeouts, and exact
  process-group termination. If a runtime cannot separate its authentication
  storage from unmanaged executable configuration, it reports `incompatible`.
- Discovery may auto-register a disabled instance for a detected installed
  runtime; enablement and authority remain explicit and fail-closed.
- A driver family becomes selectable only after its driver exists and the
  configured runtime passes compatibility and readiness gates. A family whose
  official runtime lacks the resume, identity, or attestation guarantees the
  contract requires stays reserved but unselectable.
- Routine diagnostics exclude prompts, responses, credentials, account
  identity, tool arguments and results, repository contents, and raw frames.

## Consequences

- Adding a provider means implementing one interface and passing one harness;
  the UI, board, subagent, context, and remote surfaces need no per-vendor code.
- Users see the same readiness and capability vocabulary everywhere, at the
  cost of occasionally seeing `unavailable` where a vendor UI would guess.
- Missing credentials or a missing optional runtime do not erase a merged
  driver, but they do keep the runtime from being advertised as usable.
- Provider-native permission systems are not trusted as confinement; the OS
  sandbox in 0009 remains authoritative.

## Related

- 0006 ACP agent drivers as one generic stack
- 0007 Direct API providers and the native agent harness
- 0009 Sandbox confinement, approvals, and Plan mode
