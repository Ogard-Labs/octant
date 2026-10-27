# Security Architecture and Threat Model

**Status:** Approved by Henrik (2026-08-12). Implementation children may enter Ready.

**Date:** 2026-08-11 (approved 2026-08-12)

**Threat model id:** `security-architecture-v1`

**Scope:** Malicious tool calling and work isolation across Chat, Work, and Code — tool-call
policy, untrusted content, sandbox boundaries, credentials, subagents, extensions, and remote
clients on one Octant host

**Designs:** the current owners are
[Architecture](../architecture.md): [security and authority](../architecture.md#security-and-authority),
including subagents, and [modes](../architecture.md#modes-chat-work-and-code); and
[extensions and skills](../architecture.md#extensions-and-skills).

The Octant-managed endpoint agent loop, sustained Goal execution, editable egress rules, session
fork/checkpoint/pause behavior, and CLI/GUI security ownership copy are further constrained by
the [native harness](../architecture.md#native-harness) rules in the architecture. (Earlier
revisions of this model cited design files under `docs/specs/` that no longer exist.)

**Companion feature threat models:**
[`github-repository-onboarding-threat-model.md`](github-repository-onboarding-threat-model.md),
[`mobile-remote-control-threat-model.md`](mobile-remote-control-threat-model.md),
[`canvas-share-authenticated-snapshot-threat-model.md`](canvas-share-authenticated-snapshot-threat-model.md),
[`canvas-share-static-export-threat-model.md`](canvas-share-static-export-threat-model.md),
[`canvas-html-frames-threat-model.md`](canvas-html-frames-threat-model.md),
[`agent-to-agent-messaging-threat-model.md`](agent-to-agent-messaging-threat-model.md)

## Overview

Octant is a local-first, server-authoritative workspace. Its security invariants were previously
scattered across the original-rewrite design (tools/safety and remote access), the extensions trust
design, and four feature-scoped threat models. This document gathers them into one threat summary.
It is not a separate authority: the effective rules live in the
[architecture](../architecture.md#security-and-authority), and where the two differ, the
architecture wins and this summary is corrected. It covers two threat families:

- **T-A Malicious tool calling.** Prompt injection through tool results, rogue MCP servers
  requesting undeclared capabilities, and model-invented tool invocations that were never defined
  by Octant.
- **T-B Insufficient work isolation.** Agent subprocesses escaping the bound project root, secret
  exposure to tools or children, and child-agent or remote-client privilege expansion beyond the
  parent, host, mode, or thread policy.

Each control below names its enforcement layer and module and states whether it **exists today** in
the repository or was **newly specified** here. A newly specified control becomes a rule only when
the architecture states it; until then it is a proposal tracked in Linear. Nothing here weakens an
existing control.

## Assets

- The bound Work project root and Code repository root (filesystem contents and integrity).
- Provider credentials and OAuth sessions (Keychain / secret-store material as
  opaque broker refs; never journaled, never rendered). Delegated provider-runtime
  OAuth stays out of Octant storage (0005). Octant never reads, stores, or
  injects a provider CLI's credentials, including Claude OAuth tokens.
  Host-driven `subscription-oauth`
  refresh and access live only as 0054 broker refs (0111).
- Host identity keys, remote device credentials, and pairing secrets.
- The append-only event journal: integrity of recorded tool calls, approvals, and authority
  transitions, and the guarantee that no secret or instruction-laundering content enters it as
  trusted data.
- Thread authority state: mode, Project binding, execution posture, elevation, delivery target.
- The user's standing approval grants (remembered Full access, session grants).
- The closed tool-definition catalog and the extension trust/enablement registry.
- Host resources outside any bound root: `~/`, other Projects' roots, other worktrees, network
  egress from the host.

## Actors and Trust Boundaries

### Actors and controlled inputs

- **Host user:** controls installs, Project bindings, trust decisions, approvals, elevation, and
  remote device authorization. The only actor who can widen authority.
- **Provider/agent (model output):** controls message text, tool-call requests, subagent requests,
  and proposed diffs. Untrusted with authority: a tool-call request is a _petition_, never a grant.
- **Tool results and ingested external content:** README files, web pages, MCP tool results,
  repository contents, browser observations. Attacker-influenced data; never instructions.
- **Extension packages and MCP servers:** third-party code and manifests. Installation never
  implies trust; executable components are quarantined until explicitly trusted, and trust never
  bypasses mode, sandbox, approval, or credential policy.
- **Remote client:** an authenticated paired browser or mobile device. A remote principal, never
  the host owner; it cannot exceed host, mode, provider, Project, or thread authority and cannot
  mint local receipts.
- **Child agents (subagents):** provider-native or Octant-managed. Receive equal-or-narrower
  authority than their parent; a child request is admitted only after server-side clamping.
- **Another local principal on the loopback path:** another OS user on the same machine, a local
  service account, an `ssh -L` forward, or a proxy that rewrites `Host`. It reaches the loopback
  listener and can send any `Host` and `Origin` header, but cannot read the host owner's files. It
  is not the host user and gets no window authority (AC5).
- **Local attacker with the same user account or kernel:** out of containment scope, as in the
  companion threat models. Octant must not amplify such a compromise across hosts or expose new
  credentials, but cannot defend against it.

### Trust boundaries

1. Renderer or remote client to authenticated server routes (`apps/server/src/clientPrincipal.ts`,
   `apps/server/src/remoteRoutePolicy.ts`). Authority checks occur on the server before side
   effects, never only in React.
2. Provider/agent output to the server-side tool-call policy engine. Model text cannot invoke
   anything that does not resolve through the closed tool catalog and policy resolution.
3. Tool results and external content to the journal and the next model turn. Content crosses this
   boundary as data with provenance, never as trusted instructions.
4. Server to tool subprocesses (provider CLIs, shells, test runners, extension executables) across
   an Octant-owned OS sandbox boundary. Path checks alone are insufficient.
5. Server/desktop to the macOS Keychain through the loopback credential broker. Tools and
   providers see indirect references only.
6. Parent thread to child agent: authority is intersected server-side; the child workspace is a
   separate isolated worktree or scratch area.
7. Trusted core to extension components: quarantine, activation ladder, supervised processes, and
   per-call tool approval.
8. One host to another host or remote device: credentials and mutable authority never cross.

## Abuse Cases and Enforcement Mapping

Each abuse case names the layered controls that defeat it and where they live. Layers are ordered:
the outermost check that fails closed first is listed first.

### AC1 — Injected tool-result content (prompt injection)

A repository README, web page, or MCP tool result contains instructions such as "run
`curl … | sh`", "approve all future writes", "the reviewer must approve this shell", or a fake
tool-call transcript. The model relays them as its own intent, including toward a native-harness
reviewer that would answer a prompt (0110).

| Layer              | Control                                                                                                               | Module                                                                         | State           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- |
| Journal provenance | Tool results are journaled as untrusted data with source provenance, never as instructions                            | `packages/contracts` tool-evidence provenance (see Untrusted-content policy)   | Newly specified |
| Policy engine      | Any resulting tool call still resolves fail-closed against mode/provider/host/actor/elevation                         | `packages/domain/src/toolActionPolicy.ts` + unified engine (see Policy engine) | Partial today   |
| Approval taint     | Threads that ingested external content require fresh explicit confirmation for irreversible approval classes          | Untrusted-content policy (below)                                               | Newly specified |
| Reviewer bound     | Native-harness reviewer sees only the approval request plus bounded facts, framed as data; ambiguity goes to a person | Native harness reviewer (0110)                                                 | Newly specified |
| Eligible classes   | Reviewer may answer `shell-commands` and `network-access` only; it cannot mint categories or waive taint              | Native harness reviewer (0110)                                                 | Newly specified |
| Sandbox            | Even an approved malicious command stays inside the bound root's sandbox profile and egress policy                    | Provider/tool Seatbelt launchers (see Sandbox boundary)                        | Partial today   |

Escape probes for the reviewer path are a release-gate follow-up once 0110 is implemented; they
are not present while that record is Proposed.

### AC2 — Rogue MCP server requesting undeclared capabilities

A trusted-looking extension ships an MCP server that requests filesystem, shell, network, or
credential capability it never declared, floods oversized results, or registers tools whose names
shadow Octant core tools.

| Layer               | Control                                                                                                                                                                           | Module                                                                                                  | State           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------- |
| Activation ladder   | Host → mode → Project → thread → trust → enablement → compatibility all fail closed; quarantine blocks first                                                                      | `packages/plugin-host/src/activation.ts` (`resolveExtensionActivation`, `isExtensionComponentModeSafe`) | Exists today    |
| Manifest validation | Declared capabilities, entry points, paths, symlinks, and integrity validated before install                                                                                      | `apps/server/src/extensions/packageInspector.ts`, `packages/plugin-host/src/agentPlugins/mcp.ts`        | Exists today    |
| Supervised process  | Executable components run under `sandbox-exec` with a minimal `PATH`, ready-handshake, and durable receipts                                                                       | `apps/server/src/extensions/nodeExtensionProcessPort.ts`, `extensionSupervisor.ts`                      | Exists today    |
| Per-call approval   | Each MCP tool invocation is approval-gated with a bounded TTL that denies on timeout or abort; a paired device answers only its own turns' prompts, once, and never remembers one | `apps/server/src/extensions/extensionToolApprovalService.ts`                                            | Exists today    |
| Policy engine       | An MCP-originated call carries `extension: trusted-extension` authority and cannot claim `core` identity                                                                          | `packages/contracts/src/toolActions.ts` (`ToolActionAuthority.extension`), `toolActionPolicy.ts`        | Exists today    |
| Capability ceiling  | Requested-versus-declared capability mismatch is rejected at resolution, not merely surfaced in review UI                                                                         | Unified policy engine (see Policy engine)                                                               | Newly specified |

### AC3 — Child agent widening scope

A parent agent (or the model inside it) requests a subagent with broader filesystem, shell, git, or
network authority, a more privileged execution policy, a persisted grant, deeper nesting, or a
workspace pointing at another Project's root.

| Layer              | Control                                                                                                                                                | Module                                                                                   | State        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------ |
| Authority clamp    | Requested authority is intersected with parent, Project, and global ceilings; any widening rejects fail-closed                                         | `packages/domain/src/agentRunPolicy.ts` (`clampAgentRunAuthority`, `authority-widening`) | Exists today |
| Mode ceiling       | Mode-derived maximum authority (Chat plan-only, Work no shell, Code approval-gated) caps every child                                                   | `packages/domain/src/agentRunAuthorityCeiling.ts`                                        | Exists today |
| Depth and capacity | Depth ≤ 2; ≤ 32 unfinished global, ≤ 16 per parent; running at once ≤ the person's setting (≤ 16); creation posture Off/Automatic enforced server-side | `agentRunPolicy.ts`, `apps/server/src/agentRun/agentRunSettingsStore.ts`                 | Exists today |
| Workspace receipt  | A Code child requires a verified isolated worktree receipt; Chat children get virtual scratch only                                                     | `agentRunWorkspacePolicy.ts` (`admitAgentRunWorkspace`), `agentRunWorkspaceService.ts`   | Exists today |
| Live parent grant  | Clamping against the parent thread's _live_ effective grant, not only the mode ceiling                                                                 | `agentRunLiveGrant.ts` / `clampAgentRunAuthorityAgainstLiveGrant` feeding admission      | Exists today |

The server prepares, confirms, and admits child workspaces through
`apps/server/src/agentRun/agentRunWorkspaceService.ts` and the domain
`admitAgentRunWorkspace` policy. Chat children receive virtual research workspaces;
Work children must match the current Project root and binding revision; Code children
require a confirmed, ready isolated worktree bound to the parent thread. Child
authority is clamped against both the mode ceiling and the parent thread's live grant.

### AC4 — Remote client exceeding host policy

A paired browser or mobile device attempts a local-only action (extension trust, credential write,
Project binding, device approval), replays a stale session, launders its principal into a local
window, or approves an action class the host policy reserves for the local user.

| Layer              | Control                                                                                                 | Module                                                                                                       | State        |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------ |
| Principal identity | Local-window versus remote-device principals resolved server-side; identity in payloads is rejected     | `apps/server/src/clientPrincipal.ts` (`resolveAuthenticatedPrincipal`, `assertNoPrincipalIdentityInPayload`) | Exists today |
| Action catalog     | Closed remote-approvable and local-host-required action sets; unknown actions fail closed               | `packages/domain/src/remoteAccessPolicy.ts` (`classifyRemoteAction`, `authorizePrincipalAction`)             | Exists today |
| Laundering denial  | A remote principal can never become local-window or mint native/local approval receipts                 | `remoteAccessPolicy.ts` (`remote-cannot-mint-local-receipt`, `principal-laundering`)                         | Exists today |
| Session lifecycle  | Pairing TTL and attempt limits, session idle/absolute expiry and rotation, device expiry and revocation | `remoteAccessPolicy.ts`, `apps/server/src/remoteCredentialLifecycleService.ts`                               | Exists today |
| Operation clamps   | Remote Code operations resolve to host-clamped decisions (`host-thread-credential-clamped` for push/PR) | `packages/domain/src/codePolicy.ts` (`authorizeCodeOperation`)                                               | Exists today |
| Route policy       | Per-route security policy and request-proof validation on remote transports                             | `apps/server/src/remoteRoutePolicy.ts`, `remoteRequestProofService.ts`                                       | Exists today |

### AC5 — Loopback caller claiming the local owner

Another OS user, a local service account, an `ssh -L` forward, or a proxy that rewrites `Host`
calls the loopback listener with the listener's own `Origin` and asks for a window capability,
which would read every thread, Project, and setting and could create provider endpoints.

| Layer             | Control                                                                                                                        | Module                                                                         | State        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------ |
| Owner-only secret | Window authority is minted only on `/api/desktop/*` routes that require the bridge secret, readable only by the host's OS user | `apps/server/src/launchSessionRoutes.ts`, `@octant/host-runtime` runtime paths | Exists today |
| No loopback mint  | `/api/shell/local-session` refreshes a capability the caller already holds and answers 401 otherwise                           | `apps/server/src/launchSessionRoutes.ts` (`handleLocalBootstrap`)              | Exists today |
| One-time token    | A browser launch token is single-use, expires in five minutes, and is bound to the renderer origin it was minted for           | `apps/server/src/launchSessionStore.ts`                                        | Exists today |
| Token hygiene     | The token rides in the URL fragment and the renderer strips it with a history replace before exchanging it                     | `apps/web/src/shell/useLaunchSession.ts`, `shellLaunch.ts`                     | Exists today |
| Origin pinning    | Only the listener's own origin, the packaged renderer, and `OCTANT_WEB_URL` are admitted; other loopback pages are refused     | `apps/server/src/shellRoutes.ts` (`isLocalRendererOrigin`)                     | Exists today |

Residual risk: the launcher passes the token URL to the system browser as a process argument, which
another OS user can read while that process runs, and the token is valid until the browser exchanges
it. A caller that wins that race gets one browser session and the person's browser shows the launch
guidance instead.

### AC6 — Rogue outside provider driver

A provider-driver package from outside Octant (malicious, compromised, or just broken) tries to
steal or misdirect the instance's key, reach another instance's key, claim tools, approvals, or
other capabilities its endpoint does not have, put its own text in Settings or a failure, or hang
and flood the host. The rules live in
[Outside provider drivers](../design/outside-provider-drivers.md).

| Layer                | Control                                                                                                                                                                     | Module                                                                                                        | State           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------- |
| Admission            | Installed quarantined from a local window only; until admission, an instance reports `driver-not-admitted` before any driver code runs                                      | `apps/server/src/extensions/outsideProviderDriverPackage.ts`, `providerService.ts`                            | Exists today    |
| Strict wire decoding | Every line is size-capped and decoded against strict schemas; an unreadable or unexpected one stops the driver as `driver-incompatible` with no models                      | `packages/contracts/src/outsideDriverProtocol.ts`, `apps/server/src/providers/outsideHarnessEndpointProxy.ts` | Exists today    |
| Closed failures      | A driver's failure is read only as a category and numbers; the host writes every message, and anything else becomes a fixed protocol failure                                | `outsideHarnessEndpointProxy.ts`                                                                              | Exists today    |
| Capability ceiling   | Probe claims are clamped to the bundled harness endpoints' column; tools reach only models the host verified; `admitTurn`, cancel, and release are answered by the host     | `apps/server/src/providers/outsideDriverCeiling.ts`, `outsideHarnessEndpointProxy.ts`                         | Exists today    |
| Brokered egress      | The host leases this instance's key, sends it only to the configured origin (checked before the key is read), follows no redirect, and strips the key header from the reply | `outsideHarnessEndpointProxy.ts`, `providerApiKeyPool.ts`                                                     | Exists today    |
| Confined process     | One deny-default Seatbelt process per instance with no network, no exec, and a minimal environment; Linux never launches one                                                | `apps/server/src/providers/outsideDriverProcess.ts`, `extensions/nodeExtensionProcessPort.ts`                 | Exists today    |
| Provenance           | Digest-bound trust, a publisher key pinned at first trust, quarantined updates that clear Verify tools                                                                      | Extension lifecycle and package store                                                                         | Newly specified |

The proxy's tests run the harness endpoint conformance kit against it with a misbehaving fixture
driver, and cover hostile failure text, over-claims, protocol violations, and the brokered call's
origin, lease, header, and redirect negatives. The confined process's escape tests
(`outsideDriverProcess.escape.test.ts`) try the network, files outside the package and its folder,
the home folder and its keychains, another program, and the host's environment from a real Seatbelt
process; they run on macOS only, and until they pass there the process control is built but not
accepted.

## Server-Side Tool-Call Policy Engine

### What exists today

- **Closed, schema-validated tool contract.** `packages/contracts/src/toolActions.ts` defines
  `ToolActionRequest` with strict Effect schemas (`onExcessProperty: "error"`), a bounded
  `ToolCapabilityId` token, a 4 KiB intent bound, and opaque evidence references that reject path
  separators. Browser, computer-use, Apple toolchain, and validation tools reuse the same
  authority shape.
- **Fail-closed authority comparison.** `packages/domain/src/toolActionPolicy.ts`
  (`authorizeToolAction`) rejects any mismatch between the requested and granted
  `ToolActionAuthority` across host, mode, Project, root, worktree, provider instance, and
  extension identity. Evidence and cancellation must match action, correlation, and authority.
- **Per-surface authority resolution.** Each tool surface currently resolves its own granted
  authority: `apps/server/src/browser/browserAuthorityResolver.ts` plus
  `packages/domain/src/browserAutomationPolicy.ts` (origin allowlist denies by default, isolated
  profile default, credential-field protection), `packages/domain/src/computerUsePolicy.ts`
  (allowlisted apps, visible stop, process ownership), `packages/domain/src/codePolicy.ts`
  (actor × posture × operation; `pr-mutation` denied unconditionally; Plan denies every mutation),
  `packages/domain/src/workConfinementPolicy.ts` with
  `apps/server/src/work/workMutationService.ts` (canonical relative paths, traversal and
  symlink-escape rejection, `/` root rejected), and
  `apps/server/src/threadWorkingDirectoryAuthority.ts` for working-directory authority.

### Newly specified

- **One resolution point.** A pure domain function — module `packages/domain/src/toolCallPolicy.ts`
  (new) — resolves every tool call in this fixed, fail-closed order, each step able to deny with a
  structured reason and no later step able to override an earlier denial:

  1. **Tool identity:** the requested capability must exist in the Octant-owned closed catalog
     (below) at a compatible version. Unknown or model-invented tool names fail closed before any
     argument is inspected.
  2. **Argument schema:** arguments decode against the tool's strict contract schema; excess
     properties, oversize payloads, and non-canonical paths reject.
  3. **Mode policy:** the capability matrix of the rewrite design section 8.1 (Chat: no
     filesystem/shell; Work: confined root, no coding surfaces; Code: approval-gated).
  4. **Provider capability:** the provider instance's honest capability report must include the
     capability; unsupported providers fail closed rather than downgrade silently.
  5. **Host policy:** host prohibitions (for example computer-use disabled, egress policy).
  6. **Remote actor:** if the commanding principal is remote, `authorizePrincipalAction` and the
     code-operation clamps apply before any approval is offered.
  7. **Thread elevation and approval class:** the thread's current execution posture
     (plan/approval-gated/full-access), the eight approval categories of design section 8.4, and
     the untrusted-content taint rule below decide allow/prompt/deny.

  The server dispatcher — `apps/server/src/toolCallAuthorityService.ts` (new) — is the single
  choke point that computes the granted `ToolActionAuthority` from live thread state and invokes
  the domain resolution before any tool port is reached. Existing per-surface resolvers become
  callers of this service rather than parallel authorities.

- **Closed tool catalog.** Tool definitions (name, capability id, version, argument schema,
  approval class, sandbox requirements) are Octant-owned code in `packages/contracts`.
  Providers, extensions, and prompts cannot add, rename, or shadow catalog entries. MCP tools are
  namespaced under their extension identity (`trusted-extension` authority) and can never resolve
  as `core`.
- **Declared-capability ceiling for extensions.** The engine intersects an MCP tool call with its
  component's manifest-declared capabilities; a request touching an undeclared capability class is
  denied at resolution (AC2), independent of what the per-call approval dialog would show.
- **Decision receipts.** Every resolution emits an audit event (see Journal audit events) whether
  allowed, prompted, or denied.

## Untrusted-Content Policy

### What exists today

- Tool evidence is recorded as bounded opaque references (`ToolEvidence.reference` rejects paths),
  and journaled events are versioned data with actor and correlation identity — the journal never
  replays content as commands.
- Work research already classifies source freshness and evidence leakage
  (`packages/domain/src/workResearchPolicy.ts`), and skill/plugin content contributes zero
  context unless explicitly selected and effectively enabled
  (`packages/plugin-host/src/activation.ts`, composer reference rules).

### Newly specified

- **Provenance marking.** Journaled tool results, ingested files, web content, and MCP responses
  carry a provenance field (`origin: tool-result | external-content | user | provider-text`) in
  their event payloads — module: `packages/contracts` tool/journal schemas. Context assembly
  (`apps/server/src/context/`) must present externally originated content to the model inside
  data-delimited framing, never merged into system or instruction sections.
- **Instructions never flow from results.** No component may parse a tool result or file content
  into a tool invocation, approval, trust change, or authority transition. The only path from
  content to action is the model proposing a tool call that then resolves through the full policy
  engine as if the user had never seen the content.
- **Thread taint and irreversible approvals.** A thread that has ingested external content is marked
  `external-content-ingested` (a projection over provenance events) for the **thread lifetime**
  (Henrik decision 2026-08-12: taint does not clear on session/turn boundaries). While marked,
  approval classes that are irreversible or authority-bearing — destructive or irreversible
  actions, credential/secret access, access outside the selected Project, and privilege expansion
  or sandbox changes (design section 8.4) — require a fresh explicit per-action confirmation.
  Standing session grants and remembered Full access do not silently satisfy these classes on a
  tainted thread. Enforcement: the policy engine's thread-elevation step,
  `resolveThreadElevation` in `packages/domain/src/toolCallPolicy.ts`, fed by the taint projection
  in `apps/server`. It asks afresh, under every posture that allows the tool at all (Plan refuses
  most of them outright), for each closed-catalog entry marked `irreversibleUnderTaint`, and a
  catalog test refuses an entry in any of the four classes without that flag. Today `mcp-tool`
  (privilege expansion) is the only entry in one of the four classes; the flag also covers
  `computer-use`, `web-fetch`, and the harness `bash`, `edit`, `write`, and `goal-check`. A Code Git action a person takes from a window (discard, restore, push, create a
  pull request, bring a run home) is that person's own per-action act, and no agent tool issues
  one. The prompt says the mark is why it asks and names the sources that marked the thread,
  with how often and when each was last read: the harness, MCP tool, and Computer use approvals
  carry `outsideContent`, which the host reads from the ingestion projection when it asks, bounded
  to eight labels plus a total and holding no content or content reference. Residual gap: a
  provider runtime's own tools sit outside this gate (below). In the native
  harness only results that bring in outside content mark the thread
  (`web-fetch`, `web-search`, a child's collected or delivered reply); local reads, searches, edits, and
  commands do not. On a tainted thread a harness "always" approval stops covering its class, and
  `web-fetch` itself needs the per-action confirmation because a GET can carry data out in its
  URL (Henrik decision 2026-10-09; detail in `docs/architecture.md`, Native harness). A tainted
  thread's `web-search` asks nobody, because it reaches only the search endpoint the person
  configured; instead the policy refuses a query that looks like it carries data — a URL, an email
  address, a long high-entropy token, a base64, hex, or percent-encoded run, or more than 200 characters — with a
  named reason (`search-query-refused-under-taint: …`) before any request leaves (Henrik decision
  2026-10-10). Residual risk: a short plain-word query can still leak a few words, but only to the
  endpoint the person chose. Revisit if a default hosted third-party search provider ships.
  A provider runtime's own built-in web search or page fetch, or a tool its provider hosts, appends
  `external-content-ingested` (labels `runtime-web-search`, `runtime-web-fetch`,
  `runtime-hosted-tool`, with an opaque hashed reference) when its adapter first sees the call. The
  runtime may already hold the result by then, and it can act on it before Octant's next gated call;
  what the mark changes is that call and every later turn. A Code turn whose approvals the runtime's own
  reviewer answers is stopped at the mark so the next approval goes to a person, and a mark that cannot be
  recorded stops the turn and refuses the thread's next turn until it is recorded (Henrik decision
  2026-10-14: track it). Residual risks: the mark's gate does not cover a tool the runtime executes
  itself; an owed mark lives in the host process and a restart forgets it; an ACP agent's web search
  reported under the `search` kind with a path-like input, or with no `query`, leaves the thread
  unmarked. Which calls each runtime exposes is listed in `docs/architecture.md`, Persistence,
  Provider runtimes' own web tools.
- **A person may clear the mark.** The mark keeps its thread lifetime, and a person at a local
  window may clear it after reviewing what the thread read (Henrik decision 2026-10-12). The clear
  is journaled with who and when (`thread.external-content-cleared@1`: the thread, the window, the
  cleared source labels, and the ingestion count, never content). It names the aggregate version the
  person was shown, so an ingestion they have not seen refuses it, and it is refused while the
  thread's turn is running, queued, or of unknown state. Only the local-only
  `POST /api/thread-external-content` clears: a paired device is refused at the private listener
  and at the handler, and the host's own scope, a tool, a command, model output, a structured
  reference, an agent message, and a host-run turn cannot. It removes the mark only and holds for
  nothing: the next ingestion marks the thread again, including content the thread had read before.
  Residual risk: a clear removes nothing from the model's context, so content the person reviewed
  can still steer the model, and every gate the mark was holding is open until the next ingestion.
  It also changes nothing about a provider runtime's own tools, which run under the runtime's own
  approvals and sandbox. Rules and replay in `docs/architecture.md`, Persistence.
- **Structured references stay inert.** `@plugin` and `$skill` references cannot install, trust,
  enable, or elevate (exists today, `packages/plugin-host/src/composer.ts`); injected text that
  imitates them remains ordinary text.

## Sandbox Boundary Design

### What exists today

- **Provider subprocess confinement.** Bounded provider executions on macOS launch under
  `/usr/bin/sandbox-exec` with a deny-default Seatbelt profile: read scoped to the bound root,
  provider home, binary/runtime directories and temp; write scoped to provider home and temp, plus
  the root only for non-plan, non-chat sessions; deny rules enumerate the rest of the user's home.
  A launch may stat the directories on the way into its own roots where those sit beneath a denied
  subtree — macOS resolves every temporary directory beneath `/private` — and nothing more: their
  listings and contents stay denied.
  Missing `sandbox-exec` fails closed as `incompatible` rather than running unconfined. Modules:
  `apps/server/src/providers/piProcess.ts`, `acpProcess.ts`, `openCodeProcess.ts`, and
  `claudeProcess.ts` on Plan — the runtimes whose process carries exactly one thread's root, mode,
  and execution policy. On Full access, 0009's user-selected unrestricted posture, OpenCode and Pi
  return the binary unwrapped. ACP drops the deny-default profile too, and a profile that carries
  0006's static MCP, skills, and hooks denials launches through an allow-default wrapper that adds
  only those. A bound root a launch may not write is denied in the profile rather than left
  ungranted, so a checkout beneath a write grant, such as the temp or a configuration directory,
  is not writable through it.
  `apps/server/src/childProcessEnvironment.ts` strips the broker URLs, broker tokens, and desktop
  bridge secret from every child, and argv carrying a provider credential is refused.
- **Unwrapped provider runtimes and what they leave exposed.** The Codex app-server is not
  wrapped, and neither is a Claude launch on the two postures that write, a scoped exception
  recorded in `docs/decisions/0143-confinement-wraps-a-runtime-that-carries-one-thread.md` and
  narrowed by `docs/decisions/0145-a-plan-turn-is-confined-by-octant.md`. Octant-owned tools those
  threads reach stay confined. What the runtime process itself is left holding:
  - _Provider sandbox by posture._ Codex sends a `sandbox` on every `thread/start`
    (`read-only` on Plan, `workspace-write` when approval-gated, `danger-full-access` on the
    user-selected Full access). Claude sends sandbox settings on approval-gated and
    auto-accept-edits turns, which is the whole of its remaining exception: a Claude Plan launch
    now carries Octant's own profile, so Plan's read-only boundary is the kernel's on that path
    rather than the runtime's `permissionMode` (0145).
  - _Environment._ Claude and Pi pass an allowlist (`PASSTHROUGH_VARIABLES`, `SAFE_ENVIRONMENT`).
    Pi's also admits all fifteen variables in `PROVIDER_CREDENTIALS` — `OPENAI_API_KEY`,
    `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and the rest — from the host whichever provider the
    thread uses, so an unrelated key reaches a Pi process. Seatbelt confines a wrapped Pi
    turn's files and network, not the environment it was started with, and Full access is
    unwrapped, so a model-generated command reads those keys either way.
    Codex's `sanitizeCodexEnvironment` is an allowlist too: host basics, locale, terminal and TLS
    variables, proxy variables, Codex's own `CODEX_*` and `OPENAI_*` configuration, and the
    credentials it names. A model provider's own credential crosses (`OPENAI_API_KEY`, the Bedrock
    bearer token); a general-purpose one — a GitHub token, AWS IAM access keys — does not cross
    _as a variable_. That is a statement about the environment only; see _Files_ below. Under
    API-key authentication `ANTHROPIC_API_KEY` is written into Claude's
    child environment at launch and deleted from the in-memory object when the scope closes.
    0009 reads two ways on that: it says provider credentials are stripped from every child, and
    that secrets reach a process only as named references resolved at launch. This record states
    the mechanism rather than settling which clause governs.
  - _Files._ 0009's wrapped profile enumerates the rest of the user's home as denied. An unwrapped
    runtime gets none of that. Both forward `HOME`. Codex no longer forwards the AWS locators
    (`AWS_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`), and a Codex Bedrock sign-in
    that would read the AWS shared config is refused as `incompatible` (see the architecture's
    confinement matrix), but the files themselves stay readable. So `~/.aws/credentials`,
    `~/.config/gh/hosts.yml`, `~/.ssh` and anything else the user can read is reachable by the
    runtime process, limited only by what the provider's own sandbox blocks. That is nothing on
    Full access for either runtime. A Claude Plan turn instead uses Octant's deny-default profile,
    which denies the rest of the user's home. Keeping a token out of the
    environment does not keep it from a model-generated command that reads its file.
  - _Consequence._ A model-generated shell command inside either runtime reads that environment
    and those files with no Octant-owned OS boundary in the way, and a write the runtime's own sandbox permits
    without announcing is not one Octant's approvals can prompt for.
- **A confined Claude subscription launch on macOS may fork, exec only `/usr/bin/security`, read the one login keychain
  file, and look up the security server.** The Claude runtime keeps its subscription credential in the macOS Keychain
  rather than in its provider home and reads it by running `security`. Measured on macOS 27.0.1 with Claude Code 2.1.296,
  the runtime is signed out unless the profile allows all of `(allow process-exec (literal "/usr/bin/security"))`,
  `(allow process-fork)`, read of the literal `~/Library/Keychains/login.keychain-db`, and the two security-server
  mach-lookups; it needs no shell, no Keychain write, and no other file in that folder, and gets none. `/bin/sh` and every
  other exec stay refused. Residual risk: `security` can return any item whose access list trusts that tool, and the
  confined runtime can read the encrypted login keychain file, which protects its items only as well as the login
  password does if a copy leaves the machine. Two things keep that grant from the model: the driver refuses a file tool
  that names the folder, and the launch has no shell to copy the file with. A launch on an API key takes none of this.
  Linux keeps the login in a file inside the account directory and takes no Seatbelt rule. A confined launch is preceded
  by a sign-in check that runs inside the same sandbox. Octant never reads, stores, or injects
  `CLAUDE_CODE_OAUTH_TOKEN`. A leftover helper-token envelope is deleted on upgrade.
- Vibe disables its keyring lookup in the confined launch and receives its Mistral API key through
  Octant's `api-key` authentication instead.
- **Version reads are confined; three readiness probes are not.** Every `--version` read prepares
  its launch through `prepareConfinedVersionProbe`
  (`apps/server/src/process/confinedVersionProbe.ts`), recorded in
  `docs/decisions/0146-a-version-read-launches-confined.md`: the six family reads
  (`probeAcpBinary`, Claude's `runProbe` at `kind: "version"`, `probeCodexBinary`, Oh My Pi's and
  Pi's `inspectVersion`, `probeOpenCodeBinary`) and `scanDescriptor` in
  `apps/server/src/providers/discoveryService.ts`. The read binds no project root and no managed
  home; one throwaway scratch directory is its working directory, `HOME`, `TMPDIR` and only
  writable path; egress is `none`; reads open the program's own install tree and nothing else
  beneath the user's home. Its environment is reduced to a fixed set of inherited names plus what
  the family computed from the scratch, so provider credentials, cloud keys and config-home
  variables never reach a replaced executable. A host that cannot confine refuses the read rather
  than running it, and it ends the read's whole process group when the read settles.
  Process exec and fork stay allowed, a scoped exception to 0122 that 0146 states, because a
  configured path is routinely a launcher that starts the program that answers; a child inherits
  the same profile. Three readiness launches stay unconfined, and 0122 expects each to retain
  confinement: `scanDescriptor`'s optional `authProbeArgs`, which reads the provider's credential
  state out of the user's home against a candidate found on `PATH`; Claude's `auth status --json`
  in `runProbe`; and the Oh My Pi connection check's RPC process in `ohMyPiProcess.ts`. Each bounds
  its timeout and output and sanitizes its environment. Giving them a home they can read is a
  readiness-probe question under 0122.
- **Extension executable quarantine.** Executable components are quarantined until explicit trust
  (`packages/plugin-host/src/activation.ts`), then run only in supervised processes launched under
  `sandbox-exec` with `PATH=/usr/bin:/bin`, an explicit ready-handshake, bounded handshake bytes,
  durable process receipts, and stop/drain semantics
  (`apps/server/src/extensions/nodeExtensionProcessPort.ts`, `extensionSupervisor.ts`).
- **Host credential broker.** Provider credentials live in the host's OS secret store:
  macOS Keychain (`apps/desktop/src/keychainCredentialStore.ts`) or Linux Secret Service through
  `secret-tool`. The desktop or CLI host exposes them only through a loopback-only HTTP broker
  with a random bearer token, a closed route set (has/resolve/purge), bounded bodies, and
  UUID-only credential references (`packages/host-runtime/src/credentialBroker.ts`). The CLI
  starts the broker only when Secret Service is available; otherwise the broker is absent.
  Tools and renderers see indirect references only; broker coordinates are stripped from child
  environments.
- **Worktree and workspace isolation.** Code children require a verified isolated worktree receipt
  (`AgentRunWorkspaceService`, `admitAgentRunWorkspace`); Chat tools use
  isolated scratch areas (`apps/server/src/chat/chatScratchStore.ts`).
  Work children must match the current Project root and binding revision.
- **Browser and computer-use confinement.** Per-thread isolated browser contexts with
  deny-by-default origin allowlists and credential-field protection
  (`packages/domain/src/browserAutomationPolicy.ts`); computer-use requires allowlisted
  applications, session expiry, visible stop, and process ownership
  (`packages/domain/src/computerUsePolicy.ts`).

### Newly specified

- **Sandbox profiles for every tool subprocess.** The Seatbelt launch pattern used for provider
  processes extends to every Octant-spawned tool subprocess that can execute arbitrary code:
  shell commands (`apps/server/src/shellService.ts`), the project-confined test runner
  (`apps/server/src/code/repositoryTestProcessPort.ts`), and Git helper invocations. Each profile
  confines writes to exactly one bound root (the thread's Work root, Code worktree, or scratch
  area) plus a private temp directory, and enumerates deny rules for the remainder of the user
  home, exactly as the provider profiles do. Module: a shared profile builder extracted to
  `apps/server/src/process/` so per-tool launchers cannot drift.
- **Per-thread network egress policy.** Today's profiles grant `(allow network*)` unconditionally.
  This design replaces that with a thread-resolved egress policy: `none` (default for Work
  document work and Plan mode), `provider-endpoints-only` (**default for Code approval-gated
  threads** — Henrik decision 2026-08-12), or `unrestricted` (Code full-access only, or an
  explicit network approval under section 8.4). The policy resolves in the tool-call policy engine
  and materializes in the Seatbelt profile at launch. V1 OS enforcement is two-level (`none` /
  `allow`) with broker-level host allowlists (Henrik decision 2026-08-12); a local egress proxy is
  deferred. Where Seatbelt cannot express a host allowlist, the finer host-level policy is
  enforced by the Octant-owned brokered tools (browser origin allowlist, research backends);
  this limitation is stated honestly rather than simulated. One consequence is an exception to
  decision 3 below: the output of a command launched under OS-level `allow` does not taint its
  thread, because the host cannot observe what the command received, so standing approvals stay
  active after it. The harness tool egress rules remove the exception for native-harness tool
  processes on `provider-endpoints-only` threads; it remains under `unrestricted`,
  where the person accepted open network.
- **Harness tool egress rules (approved 2026-10-13; built).** For native-harness tool processes
  on a `provider-endpoints-only` thread, a host-owned per-launch forward proxy replaces OS
  `allow` with a third OS level, `proxied`: Seatbelt opens only the proxy's loopback port and
  bubblewrap gives a private network namespace an in-capsule forwarder, so direct egress and DNS
  are denied and every connection is checked against per-host, per-thread or per-Project rules
  that always expire. Private and loopback destinations refuse under every rule, taint suspends
  standing rules, and learn mode only proposes. The design, its audit events, failure modes, and
  phased acceptance live in
  [`docs/architecture.md`, Harness tool egress rules](../architecture.md#harness-tool-egress-rules);
  its approval supersedes decision 4 below for those processes only. On a tainted thread a
  command's single-use confirmation lists the thread's and Project's hosts, and what the person
  ticks becomes `call` rules for that one launch; a child's command asks on its parent's thread
  with the parent's hosts and is granted nothing beyond them. The Linux native probes have not
  run; that and what is not wired are listed in that section.
- **Equal-or-narrower child sandboxes.** A child agent's sandbox profile derives from its clamped
  authority, never from its parent's raw profile: a child without `network` gets a no-egress
  profile even if the parent had egress; a child's write scope is its own isolated worktree, never
  the parent's checkout.
- **Executable extensions keep quarantine at runtime.** Extension processes never receive broker
  coordinates, provider credentials, or a bound-root write scope wider than their declared and
  approved capability; their sandbox profile is derived from declared capabilities the same way
  thread tools derive from authority.

### Consumer subscription OAuth delta (0111)

Directory and cloud-IAM identity have their own threat controls (E1–E8) in
[Enterprise provider identity](../design/enterprise-provider-identity.md#threat-model).
Host-driven `subscription-oauth` plumbing runs in the credential broker:
generic PKCE and device-code runners, broker-stored refresh, and a terms
acknowledgment gate. Direct endpoint drivers refresh through that host
service, and Settings offers Sign in beside the API key when a descriptor
offers OAuth. No new trust boundary moves refresh tokens into `apps/server`
or the renderer.

| ID  | Delta                              | Control                                                                                                                                                                                                                             |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Long-lived refresh tokens          | Broker-only opaque refs; never journaled, logged, exported, or renderer-visible. Host-local revoke invalidates Octant refs only — it does not revoke the IdP token. Residual risk is a still-valid refresh token until the IdP does |
| O2  | Confused-deputy spend              | Existing mode, Project, and approval gates stay in front; a remote principal cannot start the OAuth flow or rotate broker material (0013)                                                                                           |
| O3  | Account or tenant binding on probe | Instance config carries the expected binding; `subscription-oauth` `ProviderDriver.probe` reports `incompatible` on mismatch                                                                                                        |
| O4  | Refresh-token reuse / rotation     | Single-flight refresh with rotation safety; `refresh_token_reused` is terminal and invalidates the stored family; network and 5xx are transient                                                                                     |
| O5  | First-party `client_id` and ToS    | Explicit user acknowledgment before any first-party-client-ID flow; Octant originator / client metadata; API-key path always offered                                                                                                |

## Journal Audit Events

**Exists today:** every committed event envelope carries event, aggregate, sequence, correlation,
causation, actor, and timestamp identity (`packages/contracts/src/events.ts`); tool actions,
approvals, extension lifecycle, remote credential lifecycle, and AgentRun lifecycle are journaled
by their owning services.

**Newly specified:** a consolidated audit taxonomy so a reviewer can reconstruct every
authority-relevant decision from the journal alone:

- `tool-call-requested`, `tool-call-authorized`, `tool-call-denied` (with the structured denial
  reason and the resolution step that denied), correlated to the turn that proposed the call.
- `policy-decision-recorded` for engine resolutions that did not reach execution (for example a
  denied capability or taint-forced prompt).
- `approval-granted`, `approval-denied`, `approval-expired` with approval class, scope
  (action/session/project), TTL, and the prompting tool action id.
- `thread-elevation-changed` (posture transitions, remembered Full access changes,
  Plan-to-execution) and `authority-transition-recorded` (Project attach, worktree bind, child
  clamp results).
- Actor attribution: `EventActor` is extended with `remote-device` and agent-attribution kinds
  (Henrik decision 2026-08-12 — prefer an explicit union over payload-only fields). Audit events
  additionally record the acting principal (`local-window`, `remote-device` with device id) and, for
  agent-initiated petitions, the provider instance and thread identity, so a remote approval is
  never indistinguishable from a local one. Contract change in `packages/contracts/src/events.ts`
  (versioned, with consumer migration). Identity is server-resolved, never client-supplied
  (`assertNoPrincipalIdentityInPayload`).

Audit events follow the existing redaction rules: no secrets, no absolute private paths, no raw
tool output — bounded references only.

## Escape Suite

The escape suite is the adversarial regression suite feeding the "Escape suite fails closed" exit
gate (rewrite design section 18, Phase 8, and release criterion 3). It extends the existing
confinement tests (Work path containment, remote authentication negatives, extension activation
truth tables) with end-to-end adversarial fixtures. Every fixture must fail closed with a
structured denial and a journaled audit event; a fixture that succeeds in widening authority fails
the gate.

### Fixtures

| Fixture                      | Contents                                                                                                                                                                                                                                                                                                                                                                          | Drives abuse case |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `injected-readme`            | A repository/Work root whose `README.md`, file names, and embedded tool-result text contain instruction payloads: fake approval grants, `curl … \| sh`, invented tool-call transcripts, `@plugin`/`$skill` imitations                                                                                                                                                             | AC1               |
| `rogue-mcp-server`           | An installable extension whose MCP server declares read-only capability but requests shell/filesystem/credential tools, registers a tool named after a core tool, returns oversized and instruction-shaped results, and attempts writes outside its scope                                                                                                                         | AC2               |
| `scope-widening-child`       | AgentRun requests that ask for wider filesystem/shell/git/network authority than the parent, `full-access` under an approval-gated parent, `project-default` persistence under a session grant, depth 3, a foreign Project root as workspace, and a forged verified-worktree receipt                                                                                              | AC3               |
| `egress-rule-bypass`         | A fixture, not yet written, for harness tool egress rules: commands that connect directly, resolve names, reach another loopback port or the Octant server through the proxy, use an expired rule or another thread's rule, forge the launch token, rebind a name to a private address, mismatch the TLS server name, and retry a learn-mode refusal hoping it turns into a grant | AC1               |
| `overreaching-remote-client` | A paired remote principal replaying expired sessions and attempting local-only actions (extension trust, credential write, Project bind, device approval), principal-kind laundering, direct approval of local-confirmation classes, and push/PR without credential clamps                                                                                                        | AC4               |

### Suite composition

1. **Pure policy tests** (fastest, exhaustive): truth tables against
   `packages/domain/src/toolCallPolicy.ts` (new), `toolActionPolicy.ts`, `agentRunPolicy.ts`,
   `remoteAccessPolicy.ts`, `codePolicy.ts`, `workConfinementPolicy.ts`, and
   `packages/plugin-host/src/activation.ts`, asserting the exact structured denial per fixture row.
2. **Server integration tests**: fixtures driven through real routes and services
   (`apps/server/src`) asserting deny-before-side-effect, journal audit events, and that no
   filesystem, process, or network side effect occurred.
3. **Sandbox runtime probes** (macOS): tool subprocesses launched against the fixtures attempt
   writes outside the bound root, reads of `~/` and Keychain paths, and egress under a `none`
   policy; the probe asserts the OS denial, not only the policy denial. These are packaged/native
   evidence and follow the repository's native-validation rules where a Linux runner cannot
   execute them.

Fixture sources live under version control as inert data (for example
`apps/server/src/security/escapeSuite/fixtures/`); the rogue MCP server is a local supervised
process fixture, never a network dependency. The suite runs in CI for layers 1–2 and as a
pre-release native check for layer 3.

### Exit gate

"Escape suite fails closed" passes only when every fixture row produces its expected structured
denial, a correlated audit event, and zero observable side effects, on the exact release candidate.
Waived or skipped rows never count as passing (consistent with the Phase 4/16 evidence rules).

## Severity Calibration

### Critical

- A tool call executing outside the closed catalog or with arguments that bypassed schema
  validation, reaching filesystem, shell, network, or credential effect.
- A tool subprocess writing outside its bound root/worktree, or reading Keychain material or
  broker tokens.
- A secret (provider credential, OAuth token, broker token, pairing secret) in the journal,
  renderer, tool result, child environment, or export.
- A remote principal executing a local-host-required action or minting a local approval receipt.

### High

- A child agent obtaining any authority bit, execution policy, or persistence level above its
  clamped ceiling, or a child workspace bound to a root the parent did not own.
- An extension component executing while quarantined, untrusted, disabled, incompatible, or with a
  capability class it did not declare.
- An irreversible approval class auto-satisfied by a standing grant on a thread marked
  `external-content-ingested`.
- A thread's `external-content-ingested` mark cleared by anything other than a person at a local
  window.
- Network egress from a tool subprocess whose resolved egress policy was `none`.
- Under the harness tool egress rules, a connection from a `proxied` launch to a
  destination no live applicable rule covers, after its rule expired, or to a private address.
  Applicable means a `call` rule of that launch, a rule of that thread, a rule of its Project, or,
  for a child, its parent's live rules; none applies while the thread or its parent is tainted,
  except `call` rules a person confirmed for that launch.

### Medium

- A policy denial that fails to journal its audit event (decision correct, record missing).
- Oversized tool results or handshake floods causing resource exhaustion rather than bounded
  rejection.
- Provenance mislabeling that presents external content as user-authored without enabling an
  authority effect.

### Low

- Misleading but non-authorizing copy in approval prompts or review surfaces.
- Cosmetic gaps in audit payload detail where correlation identity still reconstructs the
  decision.

Severity is lower when exploitation requires an already fully compromised host user account and
cannot expand access, persist beyond it, cross hosts, or expose a new credential. It is higher when
model output, tool-result content, an extension, a child agent, or an authenticated remote client
crosses a server authority or sandbox boundary without additional local compromise.

## Exists-Today Versus Newly-Specified Summary

| Control                                                              | State           | Owner module(s)                                                                                |
| -------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| Strict tool contracts, closed capability tokens, bounded payloads    | Exists          | `packages/contracts/src/toolActions.ts` and sibling tool contracts                             |
| Fail-closed authority comparison per tool action                     | Exists          | `packages/domain/src/toolActionPolicy.ts`                                                      |
| Unified policy-engine resolution order and single server choke point | Newly specified | `packages/domain/src/toolCallPolicy.ts`, `apps/server/src/toolCallAuthorityService.ts` (new)   |
| Untrusted-content provenance, framing, and thread taint              | Newly specified | `packages/contracts` journal schemas, context assembly, policy engine step 7                   |
| Work/Code path confinement and working-directory authority           | Exists          | `workConfinementPolicy.ts`, `workMutationService.ts`, `threadWorkingDirectoryAuthority.ts`     |
| Provider subprocess Seatbelt profiles and env sanitization           | Exists          | `apps/server/src/providers/*Process.ts`, `childProcessEnvironment.ts`                          |
| Seatbelt profiles for shell/test/Git tool subprocesses               | Newly specified | shared builder in `apps/server/src/process/`                                                   |
| Per-thread network egress policy                                     | Newly specified | policy engine + Seatbelt profile materialization                                               |
| Keychain broker with indirect references                             | Exists          | `packages/host-runtime/src/credentialBroker.ts`, `apps/desktop/src/keychainCredentialStore.ts` |
| Child authority clamps, depth/capacity, workspace receipts           | Exists          | `packages/domain/src/agentRunPolicy.ts`, `agentRunAuthorityCeiling.ts`                         |
| Live-grant-derived child clamping and Code worktree children         | Exists today    | `agentRunLiveGrant.ts`, `clampAgentRunAuthorityAgainstLiveGrant`, Code receipt port            |
| Extension quarantine, activation ladder, supervised processes        | Exists          | `packages/plugin-host/src/activation.ts`, `apps/server/src/extensions/`                        |
| Declared-capability ceiling enforced at call resolution              | Newly specified | policy engine + extension manifest data                                                        |
| Outside driver proxy: strict decoding, closed failures, brokered key | Exists          | `apps/server/src/providers/outsideHarnessEndpointProxy.ts`, `outsideDriverCeiling.ts`          |
| Outside driver process confinement                                   | Exists          | `outsideDriverProcess.ts`, `nodeExtensionProcessPort.ts` (macOS escape acceptance pending)     |
| Remote principal separation, closed action catalog, clamps           | Exists          | `remoteAccessPolicy.ts`, `clientPrincipal.ts`, `remoteRoutePolicy.ts`, `codePolicy.ts`         |
| Consolidated audit taxonomy with principal attribution               | Newly specified | `packages/contracts/src/events.ts` or audit payload schemas + owning services                  |
| Escape suite fixtures and exit gate                                  | Newly specified | `apps/server/src/security/escapeSuite/` (new) + domain policy tests                            |

## Approved Decisions (Henrik, 2026-08-12)

1. **Egress policy default for Code approval-gated threads:** `provider-endpoints-only` (not
   prompt-per-first-egress). Work and Plan remain `none`; Full access / explicit network approval
   remain `unrestricted`.
2. **Actor attribution shape:** extend the `EventActor` union with `remote-device` and
   agent-attribution kinds (versioned contract migration), not payload-only fields.
3. **Taint scope:** thread lifetime once any external content was ingested (not per-session).
4. **Seatbelt host-level egress:** two-level OS enforcement (`none` / `allow`) with broker-level
   host allowlists for V1; no local egress proxy in this release.
   _Superseded for native-harness tool processes only by the harness tool egress rules, which the
   maintainer approved on 2026-10-13. Their decision, proxy, grants, and learn mode are built, but
   no command runs through the proxy yet, so this decision still describes what runs. It still
   governs every other process._

This document is **approved**.

## Implementation Slices

Implementation is cut into four slices:

1. **Policy engine choke point** — `packages/domain/src/toolCallPolicy.ts` +
   `apps/server/src/toolCallAuthorityService.ts`; closed catalog; declared-capability ceiling;
   decision receipts; existing per-surface resolvers become callers.
2. **Untrusted-content provenance + thread taint** — provenance on journaled payloads; data
   framing in context assembly; thread-lifetime `external-content-ingested` projection; irreversible
   approval classes require fresh confirmation on tainted threads (policy step 7).
3. **Shared Seatbelt builder + per-thread egress** — extract shared profile builder under
   `apps/server/src/process/`; apply to shell/test/Git tool subprocesses; two-level OS egress
   (`none`/`allow`) with broker allowlists; Code approval-gated default `provider-endpoints-only`.
4. **Audit taxonomy + escape-suite fixtures** — extend `EventActor` with `remote-device` and
   agent-attribution kinds; tool-call/policy/approval/elevation audit events; adversarial fixtures
   under `apps/server/src/security/escapeSuite/` feeding the fails-closed exit gate.
