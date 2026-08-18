# 0006. ACP agent drivers as one generic stack with per-provider profiles

**Status:** Accepted

## Context

Several installed coding agents (Kimi Code, Kilo Code, Devin CLI, Mistral
Vibe, Grok Build, and, when its runtime qualifies, Cursor) expose the Agent Client
Protocol: JSON-RPC over stdio with initialize, authenticate, session create,
load and resume, prompt, cancel, mode and configuration options, session
update notifications, permission requests, and client filesystem or terminal
callbacks. They differ in authentication, which optional methods exist,
whether tools execute inside the agent process, and how modes map to Octant
authority. Designing and shipping each as an unrelated driver duplicated
framing, correlation, cancellation, and cleanup code and invited drift.

## Decision

- Octant treats ACP-compatible agents as one generic driver stack. A single
  shared ACP transport owns JSON-RPC framing, request identity and
  correlation, cancellation, protocol negotiation helpers, bounded
  diagnostics, and process cleanup. Provider-specific code is reduced to a
  profile: executable and version floor, authentication kind and readiness
  probe, mode-to-authority mapping, capability observation, event
  normalization quirks, and the sanitized environment or managed home the
  runtime needs.
- One ACP process belongs to one Octant session. Processes are never shared
  across unrelated Projects or threads.
- Authentication is provider-owned. Profiles support subscription or OAuth
  through a documented ACP authenticate request or the provider's own login
  flow, and explicit write-only API keys where the runtime supports them.
  Octant may keep a dedicated managed profile directory so provider-native
  login state exists without exposing the user's general configuration; it
  stores no token or account identity and never falls back between modes.
- Connection Check negotiates the protocol, verifies authentication readiness,
  and observes models and capabilities without sending a prompt or mutating a
  Project.
- Filesystem callbacks obey the thread's effective root; terminal callbacks
  cross Octant's tool and approval boundary. Agents that execute tools inside
  their own process remain confined by the OS sandbox. A session starts only
  when the server can prove the requested mode's filesystem and process
  authority; otherwise that mode is unavailable for the provider.
- Provider-native MCP servers, plugins, skills, hooks, schedules, and child
  agents are disabled or statically denied inside managed processes unless a
  narrow reviewed exception is recorded; provider-native delegation is
  reported as unsupported and Octant-managed subagents are attributed
  separately.
- Unknown required methods, malformed frames, duplicate response ids,
  uncorrelated approvals, impossible ordering, or contradictory terminal
  outcomes fail as `protocol`. Unknown optional notifications stay bounded and
  cannot promote capabilities. Protocol support is observed at runtime; a
  version string alone proves nothing.
- Only an opaque provider session reference needed for resume is persisted.
  Ambiguous resume becomes Waiting, never Done.
- Non-ACP managed-process agents (Pi over its line-delimited RPC, Codex over its
  app-server protocol, Claude through its agent SDK, OpenCode through its
  managed local server) are separate drivers, but they follow the same
  isolation, authentication, capability, and failure rules from 0005 and reuse
  the same permission-bridge pattern: the server computes effective authority
  before the process starts and again before answering any request.

## Consequences

- A new ACP agent is a profile plus conformance evidence, not a new transport;
  transport fixes land once for every ACP provider.
- Provider quirks are visible in one place per provider, which keeps honest
  capability reporting reviewable.
- Some agents cannot meet the contract (no stable resume, no separable
  authentication, tools executing unconfined). Those stay reserved and
  unselectable rather than being approximated.
- The five shipped ACP providers are profiles over one driver, process,
  protocol, and event-mapper module; the conformance suite runs once per
  profile.

## Related

- 0005 Provider SDK contract
- 0009 Sandbox confinement, approvals, and Plan mode
- 0012 Mixed-provider subagents
