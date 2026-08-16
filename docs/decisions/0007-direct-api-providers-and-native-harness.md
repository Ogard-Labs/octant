# 0007. Direct API providers and the native agent harness

**Status:** Accepted

## Context

Many users have an API key or a self-hosted, gateway, or local model but no
installed coding CLI. If mutating workflows required a CLI, API-only and local
models would be second-class and core tools would effectively be
provider-owned. Direct endpoints also raise identity problems: the same model
id exists on many hosts, gateways, and accounts, and tool support differs per
endpoint and protocol.

## Decision

- Direct HTTP endpoints are first-class provider instances with the same
  registry, readiness, enablement, and history lifecycle as CLI, SDK, ACP, and
  RPC providers. Protocol families are `openai-compatible-http` (Models plus
  Responses and Chat Completions with safe automatic detection and explicit
  override), `anthropic-compatible-http` (Models plus Messages), a constrained
  Azure AI Foundry profile over the OpenAI-compatible adapter, and Bedrock
  Mantle configured as an OpenAI-compatible instance. Protocol adapters are
  shared; provider instances are never merged by vendor or protocol.
- Ollama is a dedicated local driver over its native HTTP API: loopback-only
  endpoint validation, no authentication, no service or model management by
  Octant, per-model capability observation, and Octant-owned history and
  resume. Cloud, LAN, and tunnel variants are separate future decisions.
- Remote endpoints require HTTPS; plaintext HTTP is allowed only for loopback.
  Credentials are write-only Keychain items reached through the broker; there
  is no renderer-readable secret, arbitrary header editor, credential-bearing
  URL, or journaled token. Connection checks are non-generating and
  non-billable.
- The model picker is provider-first. A selected model is identified by
  `{ hostId, providerInstanceId, modelId }`; model ids are never globally
  unique. Model descriptors carry limits, reasoning, image, structured output,
  streaming, and tool-calling support with evidence source, confidence,
  protocol, and invalidation state. Evidence precedence is observed behavior
  against the configured endpoint, then runtime metadata, then reviewed
  catalog metadata, then user-supplied metadata, then unknown. User-supplied
  metadata can make a model selectable for inference but never authorizes
  side effects.
- Direct-endpoint drivers are inference transports only: discover models,
  negotiate wire protocol, stream normalized output, normalize structured tool
  requests and results, report usage, classify failures. They own no tools,
  sandbox, Goals, session trees, or child coordination.
- Octant provides one first-party native agent harness that runs direct and
  local endpoint models with an Octant-owned agent loop: context planning,
  normalized tool schemas, server-side authority before side effects, tool
  execution, structured results, journaled progress, and recovery. Prose is
  never parsed as a tool call; unknown names, versions, ids, arguments, or
  unoffered capabilities fail closed; ambiguous acceptance becomes Waiting or
  Failed rather than an unsafe replay.
- The harness appears as one group in the picker with each endpoint instance
  as a visible subgroup. External harness providers remain independent peers;
  the native harness never wraps or silently routes into them.
- The harness includes roles (Lead, Explorer, Researcher, Implementer,
  Reviewer, Custom), a durable Goal coordinator with an acceptance ledger,
  bounded managed subagent delegation through the shared agent-run hierarchy,
  side-chat and steering lanes, session trees with checkpoints and
  non-destructive forks, and pause, restart, and resume. Its runtime accepts
  ports and returns decisions and events; the server owns persistence,
  credentials, tools, sandbox, and capacity. Desktop, web, and CLI render the
  same projections; a CLI "session" is an ordinary thread.
- Unknown or unsupported tool capability degrades honestly to Chat and
  read-only analysis.

## Consequences

- API-only and local models become usable for coding without another
  application, and self-hosted deployments stay private.
- Capability evidence is per endpoint and per protocol, so the same model may
  show different tool support through different gateways; this is displayed
  rather than hidden.
- The harness concentrates agent-loop, tool, and security responsibility in
  Octant; provider CLIs remain optional integrations rather than prerequisites.
- Enterprise authentication (Entra ID, IAM, SigV4) is out of the first
  release and stays a separate decision.

## Related

- 0005 Provider SDK contract
- 0008 Context budget and capacity scheduling
- 0009 Sandbox confinement, approvals, and Plan mode
- 0012 Mixed-provider subagents
