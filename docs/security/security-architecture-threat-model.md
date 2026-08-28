# Security Architecture and Threat Model

**Status:** Approved by Henrik (2026-08-12). Implementation children may enter Ready.

**Date:** 2026-08-11 (approved 2026-08-12)

**Threat model id:** `security-architecture-v1`

**Scope:** Malicious tool calling and work isolation across Chat, Work, and Code — tool-call
policy, untrusted content, sandbox boundaries, credentials, subagents, extensions, and remote
clients on one Octant host

**Designs:**
[`../specs/2026-07-13-octant-product-architecture-design.md`](../specs/2026-07-13-octant-product-architecture-design.md)
(sections 7, 8, 16),
[`../specs/2026-07-13-extensions-marketplace-design.md`](../specs/2026-07-13-extensions-marketplace-design.md)
(section 4),
[`../specs/2026-07-13-mixed-provider-subagents-design.md`](../specs/2026-07-13-mixed-provider-subagents-design.md)

The Octant-managed endpoint agent loop, sustained Goal execution, editable egress rules, session
fork/checkpoint/pause behavior, and CLI/GUI security ownership copy are further constrained by
[`../specs/2026-08-12-octant-native-agent-harness-v1-design.md`](../specs/2026-08-12-octant-native-agent-harness-v1-design.md).

**Companion feature threat models:**
[`github-repository-onboarding-threat-model.md`](github-repository-onboarding-threat-model.md),
[`mobile-remote-control-threat-model.md`](mobile-remote-control-threat-model.md),
[`canvas-share-authenticated-snapshot-threat-model.md`](canvas-share-authenticated-snapshot-threat-model.md),
[`canvas-share-static-export-threat-model.md`](canvas-share-static-export-threat-model.md)

## Overview

Octant is a local-first, server-authoritative workspace. Its security invariants were previously
scattered across the original-rewrite design (tools/safety and remote access), the extensions trust
design, and four feature-scoped threat models. This document consolidates them into one enforceable
contract and specifies the remaining controls. It covers two threat families:

- **T-A Malicious tool calling.** Prompt injection through tool results, rogue MCP servers
  requesting undeclared capabilities, and model-invented tool invocations that were never defined
  by Octant.
- **T-B Insufficient work isolation.** Agent subprocesses escaping the bound project root, secret
  exposure to tools or children, and child-agent or remote-client privilege expansion beyond the
  parent, host, mode, or thread policy.

Each control below names its enforcement layer and module and states whether it **exists today** in
the repository or is **newly specified** by this design. Newly specified controls are the
implementation backlog this design gates; nothing here weakens an existing control.

## Assets

- The bound Work project root and Code repository root (filesystem contents and integrity).
- Provider credentials and OAuth sessions (Keychain material; never journaled, never rendered).
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
`curl … | sh`", "approve all future writes", or a fake tool-call transcript. The model relays them
as its own intent.

| Layer              | Control                                                                                                      | Module                                                                         | State           |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------- |
| Journal provenance | Tool results are journaled as untrusted data with source provenance, never as instructions                   | `packages/contracts` tool-evidence provenance (see Untrusted-content policy)   | Newly specified |
| Policy engine      | Any resulting tool call still resolves fail-closed against mode/provider/host/actor/elevation                | `packages/domain/src/toolActionPolicy.ts` + unified engine (see Policy engine) | Partial today   |
| Approval taint     | Threads that ingested external content require fresh explicit confirmation for irreversible approval classes | Untrusted-content policy (below)                                               | Newly specified |
| Sandbox            | Even an approved malicious command stays inside the bound root's sandbox profile and egress policy           | Provider/tool Seatbelt launchers (see Sandbox boundary)                        | Partial today   |

### AC2 — Rogue MCP server requesting undeclared capabilities

A trusted-looking extension ships an MCP server that requests filesystem, shell, network, or
credential capability it never declared, floods oversized results, or registers tools whose names
shadow Octant core tools.

| Layer               | Control                                                                                                      | Module                                                                                                  | State           |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | --------------- |
| Activation ladder   | Host → mode → Project → thread → trust → enablement → compatibility all fail closed; quarantine blocks first | `packages/plugin-host/src/activation.ts` (`resolveExtensionActivation`, `isExtensionComponentModeSafe`) | Exists today    |
| Manifest validation | Declared capabilities, entry points, paths, symlinks, and integrity validated before install                 | `apps/server/src/extensions/packageInspector.ts`, `packages/plugin-host/src/agentPlugins/mcp.ts`        | Exists today    |
| Supervised process  | Executable components run under `sandbox-exec` with a minimal `PATH`, ready-handshake, and durable receipts  | `apps/server/src/extensions/nodeExtensionProcessPort.ts`, `extensionSupervisor.ts`                      | Exists today    |
| Per-call approval   | Each MCP tool invocation is approval-gated with a bounded TTL that denies on timeout or abort                | `apps/server/src/extensions/extensionToolApprovalService.ts`                                            | Exists today    |
| Policy engine       | An MCP-originated call carries `extension: trusted-extension` authority and cannot claim `core` identity     | `packages/contracts/src/toolActions.ts` (`ToolActionAuthority.extension`), `toolActionPolicy.ts`        | Exists today    |
| Capability ceiling  | Requested-versus-declared capability mismatch is rejected at resolution, not merely surfaced in review UI    | Unified policy engine (see Policy engine)                                                               | Newly specified |

### AC3 — Child agent widening scope

A parent agent (or the model inside it) requests a subagent with broader filesystem, shell, git, or
network authority, a more privileged execution policy, a persisted grant, deeper nesting, or a
workspace pointing at another Project's root.

| Layer              | Control                                                                                                        | Module                                                                                   | State        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| Authority clamp    | Requested authority is intersected with parent, Project, and global ceilings; any widening rejects fail-closed | `packages/domain/src/agentRunPolicy.ts` (`clampAgentRunAuthority`, `authority-widening`) | Exists today |
| Mode ceiling       | Mode-derived maximum authority (Chat plan-only, Work no shell, Code approval-gated) caps every child           | `packages/domain/src/agentRunAuthorityCeiling.ts`                                        | Exists today |
| Depth and capacity | Depth ≤ 2, ≤ 4 active global, ≤ 3 active per parent; creation posture Off/Ask/Always enforced server-side      | `agentRunPolicy.ts`, `apps/server/src/agentRun/agentRunSettingsStore.ts`                 | Exists today |
| Workspace receipt  | A Code child requires a verified isolated worktree receipt; Chat children get virtual scratch only             | `agentRunPolicy.ts` (`validateWorkspaceReceipt`), `agentRunCreationService.ts`           | Exists today |
| Live parent grant  | Clamping against the parent thread's _live_ effective grant, not only the mode ceiling                         | `agentRunLiveGrant.ts` / `clampAgentRunAuthorityAgainstLiveGrant` feeding admission      | Exists today |

Today `apps/server/src/agentRun/agentRunCreationService.ts` admits Chat virtual research
children and Code children that resolve a verified managed worktree receipt
(`createVerifiedAgentRunWorktreeReceiptPort`); Work workspaces remain fail-closed until
authoritative Project/root resolution lands. Child authority is clamped against both the
mode ceiling and the parent thread's live effective grant.

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
  tainted thread; the confirmation prompt names the ingested sources. Enforcement: the policy
  engine's step 7 — module `packages/domain/src/toolCallPolicy.ts` with the taint projection in
  `apps/server`.
- **Structured references stay inert.** `@plugin` and `$skill` references cannot install, trust,
  enable, or elevate (exists today, `packages/plugin-host/src/composer.ts`); injected text that
  imitates them remains ordinary text.

## Sandbox Boundary Design

### What exists today

- **Provider subprocess confinement.** Bounded provider executions on macOS launch under
  `/usr/bin/sandbox-exec` with a deny-default Seatbelt profile: read scoped to the bound root,
  provider home, binary/runtime directories and temp; write scoped to provider home and temp, plus
  the root only for non-plan, non-chat sessions; deny rules enumerate the rest of the user's home.
  Missing `sandbox-exec` fails closed as `incompatible` rather than running unconfined. Modules:
  `apps/server/src/providers/piProcess.ts`, `vibeProcess.ts`, `kiloProcess.ts`, `kimiProcess.ts`,
  `devinProcess.ts`. Environments are allowlist-sanitized (`SAFE_ENVIRONMENT` plus declared
  provider credentials), and `apps/server/src/childProcessEnvironment.ts` strips the broker URLs,
  broker tokens, and desktop bridge secret from every child.
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
  (`validateWorkspaceReceipt`, `createVerifiedAgentRunWorktreeReceiptPort`); Chat tools use
  isolated scratch areas (`apps/server/src/chat/chatScratchStore.ts`).
  Work Project/root children remain deferred until authoritative root resolution is wired.
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
  this limitation is stated honestly rather than simulated.
- **Equal-or-narrower child sandboxes.** A child agent's sandbox profile derives from its clamped
  authority, never from its parent's raw profile: a child without `network` gets a no-egress
  profile even if the parent had egress; a child's write scope is its own isolated worktree, never
  the parent's checkout.
- **Executable extensions keep quarantine at runtime.** Extension processes never receive broker
  coordinates, provider credentials, or a bound-root write scope wider than their declared and
  approved capability; their sandbox profile is derived from declared capabilities the same way
  thread tools derive from authority.

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

| Fixture                      | Contents                                                                                                                                                                                                                                                                             | Drives abuse case |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `injected-readme`            | A repository/Work root whose `README.md`, file names, and embedded tool-result text contain instruction payloads: fake approval grants, `curl … \| sh`, invented tool-call transcripts, `@plugin`/`$skill` imitations                                                                | AC1               |
| `rogue-mcp-server`           | An installable extension whose MCP server declares read-only capability but requests shell/filesystem/credential tools, registers a tool named after a core tool, returns oversized and instruction-shaped results, and attempts writes outside its scope                            | AC2               |
| `scope-widening-child`       | AgentRun requests that ask for wider filesystem/shell/git/network authority than the parent, `full-access` under an approval-gated parent, `project-default` persistence under a session grant, depth 3, a foreign Project root as workspace, and a forged verified-worktree receipt | AC3               |
| `overreaching-remote-client` | A paired remote principal replaying expired sessions and attempting local-only actions (extension trust, credential write, Project bind, device approval), principal-kind laundering, direct approval of local-confirmation classes, and push/PR without credential clamps           | AC4               |

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
- Network egress from a tool subprocess whose resolved egress policy was `none`.

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
