# Decisions and requirements

This is the one list of every current Octant product and architecture decision.
Each entry states the current rule once, the requirements a contributor must
keep, whether it is built, and the specification section that owns its detail.
The detailed specifications ([architecture](../architecture.md),
[DESIGN.md](../../DESIGN.md), and the topic specifications indexed in
[Current design](README.md)) stay the place for the full rule, its rationale,
and its verification; where an owner states more detail than an entry here, the
owner's detail applies.

How to read an entry:

- The first sentence is the rule, in present tense. The bullets are its
  requirements. A bullet decided on its own carries one dated clause
  ("maintainer decision, 2026-11-22"); earlier wording is in git history, not
  here.
- **Not built yet** lists what is not built, each with its reason. A Partly
  built entry always has it.
- **Status** is one of Built (in the product today), Partly built (the items
  under Not built yet are not built), or Designed, not built (decided, with no
  code reaching it yet). A built feature whose live or maintainer check is
  still owed is Built, with a bullet naming the check.
- **Since** is the date of the decision that set the current rule, when the
  owner states one.
- A rule lives in one entry, under the heading a reader would look under;
  other entries link to it.

A change to a decision updates its owning specification and its entry here in
the same pull request ([Changing the design](README.md#changing-the-design)).
The former decision archive is history in `docs/legacy/` and has no authority.

## Summary

| Area                                                                                  | Decisions | Built   | Partly built | Designed, not built |
| ------------------------------------------------------------------------------------- | --------- | ------- | ------------ | ------------------- |
| [Principles and hard lines](#principles-and-hard-lines)                               | 7         | 5       | 2            | 0                   |
| [Guardrails and review](#guardrails-and-review)                                       | 9         | 4       | 5            | 0                   |
| [Key providers](#key-providers)                                                       | 21        | 11      | 10           | 0                   |
| [Release scope](#release-scope)                                                       | 8         | 4       | 3            | 1                   |
| [Process topology and local trust](#process-topology-and-local-trust)                 | 8         | 7       | 1            | 0                   |
| [App-managed tools](#app-managed-tools)                                               | 7         | 6       | 1            | 0                   |
| [Canvas authority](#canvas-authority)                                                 | 2         | 1       | 1            | 0                   |
| [Device transport](#device-transport)                                                 | 3         | 2       | 1            | 0                   |
| [Modes, Projects and authority](#modes-projects-and-authority)                        | 17        | 14      | 3            | 0                   |
| [Agents and delegation](#agents-and-delegation)                                       | 6         | 4       | 2            | 0                   |
| [Boards, pull requests and delivery](#boards-pull-requests-and-delivery)              | 7         | 4       | 3            | 0                   |
| [Routines and timed turns](#routines-and-timed-turns)                                 | 5         | 4       | 1            | 0                   |
| [Transcript records](#transcript-records)                                             | 1         | 0       | 1            | 0                   |
| [Persistence](#persistence)                                                           | 12        | 7       | 5            | 0                   |
| [Providers](#providers)                                                               | 12        | 9       | 3            | 0                   |
| [Context and usage](#context-and-usage)                                               | 11        | 10      | 1            | 0                   |
| [Native harness](#native-harness)                                                     | 7         | 6       | 1            | 0                   |
| [Extensions](#extensions)                                                             | 9         | 6       | 3            | 0                   |
| [Authority and approvals](#authority-and-approvals)                                   | 8         | 8       | 0            | 0                   |
| [Sandbox and confinement](#sandbox-and-confinement)                                   | 18        | 12      | 5            | 1                   |
| [Terminals, browsers and side surfaces](#terminals-browsers-and-side-surfaces)        | 10        | 7       | 3            | 0                   |
| [Remote access and pairing](#remote-access-and-pairing)                               | 14        | 8       | 6            | 0                   |
| [Credentials and sign-in](#credentials-and-sign-in)                                   | 8         | 4       | 4            | 0                   |
| [Updates and development](#updates-and-development)                                   | 5         | 5       | 0            | 0                   |
| [Design system](#design-system)                                                       | 12        | 11      | 1            | 0                   |
| [Workspace](#workspace)                                                               | 21        | 17      | 4            | 0                   |
| [Start screen](#start-screen)                                                         | 4         | 4       | 0            | 0                   |
| [Canvas](#canvas)                                                                     | 12        | 7       | 5            | 0                   |
| [Artifact sync](#artifact-sync)                                                       | 5         | 3       | 2            | 0                   |
| [Browser](#browser)                                                                   | 10        | 5       | 5            | 0                   |
| [Provider runtimes](#provider-runtimes)                                               | 7         | 5       | 1            | 1                   |
| [Model endpoints and organization sign-in](#model-endpoints-and-organization-sign-in) | 6         | 4       | 2            | 0                   |
| [Outside provider drivers](#outside-provider-drivers)                                 | 4         | 2       | 2            | 0                   |
| [Device workbench and mobile](#device-workbench-and-mobile)                           | 8         | 4       | 4            | 0                   |
| [Hubs and Nightly](#hubs-and-nightly)                                                 | 8         | 2       | 6            | 0                   |
| [Code tooling](#code-tooling)                                                         | 2         | 0       | 2            | 0                   |
| [Disposable desktops](#disposable-desktops)                                           | 4         | 1       | 3            | 0                   |
| [Bots](#bots)                                                                         | 1         | 0       | 0            | 1                   |
| [To-dos](#to-dos)                                                                     | 1         | 1       | 0            | 0                   |
| **All areas**                                                                         | **320**   | **214** | **102**      | **4**               |

## Principles and hard lines

### Six product principles

Every product rule is measured against six principles. A rule that protects none of them is a default a person can change, not a law.

- The person's ecosystem is the person's call: their explicit choice beats Octant's caution.
- Privacy and no telemetry are not adjustable: nothing leaves the machine unless the person sent it or configured where it goes.
- Guardrails are on by default; a person lowers them to Full access per Project, thread or globally, visibly and journaled.
- Key providers run as themselves: any workflow that works in the provider's own app works in Octant, with Octant's journal, views and guardrails on top. A workflow Octant cannot yet carry is a recorded gap, not a rule (maintainer decision, 2026-11-14).
- Honesty never softens: Octant says what a provider or tool can and cannot do, and records what happened.
- Octant is never stricter than a key provider's own app. It holds back only for the hard lines, no Full access on first run, the protected provider-account credentials, and Chat.

Not built yet:

- What [Guardrail levels](#guardrail-levels), [The Full access rule](#the-full-access-rule), [Octant Shield](#octant-shield) and [Key providers run as themselves](#key-providers-run-as-themselves) mark not built: each gives its reason.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### Hard lines no level turns off

A short list of rules holds at every level, Full access included. No setting or reviewer turns them off.

- No telemetry, no usage data and no Octant cloud.
- Octant stores no forge token and never journals a secret value; credentials reach a provider only through the credential broker.
- Updates are signed and verified; anything unverifiable is refused.
- Authority is checked on the host before any side effect. A phone or web client never exceeds what the person allowed on the host.
- Providers report capabilities honestly and fail closed.
- The journal records every lowered guardrail, merge and force-push, with who allowed it.
- An agent never merges or force-pushes on its own initiative, never marks a thread Done, and never exceeds a spend ceiling the person set.
- Plan is read-only: it looks and proposes, and writes only its thread's own Canvas (`create`, `revise`); publishing, sharing, the mirror and replica sync stay refused.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### The Full access rule

At Full access, in Work and Code, nothing prompts, nothing expires into a refusal, and nothing is refused because the thread read outside content, except the closed list below (maintainer request, 2026-11-12). Adding an ask means adding it to the owner's list in the same change, with its reason.

- The exceptions: every [hard line](#hard-lines-no-level-turns-off); merge, plain force-push and default-branch push through Octant's own pull-request tool or the Harness ([Pull-request merge](#pull-request-merge)); Computer use's first action per application under Strict only (maintainer decision, 2026-11-19); a site approval on a signed-in Browser profile; paying, buying or sending a message as the person; the mandatory spend cap on billed or off-machine desktops; and the one-time warning when a machine or Project first picks Full access.
- A provider's own commands are not on the list outside Strict ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).
- A device the host's own person paired sets and starts Full access as a local window does, journaled as the actor (maintainer decision, 2026-11-12).
- Full access is refused to a device known only through the hub's roster (maintainer decision, 2026-11-13), to one whose approval the journal does not prove, and to one paired below Full device access (maintainer decision, 2026-11-22).
- At every level a wait is the safe state: an unanswered approval or question waits in Needs you and never times out into a refusal (maintainer decision, 2026-11-13). Expiry stays only where a live secret or the host's own authority is at stake.
- A time, count or size limit is a setting unless it protects a hard line or stored data; a fixed constant states its reason.

Not built yet:

- Rules elsewhere that still ask, expire or refuse at Full access, and limits still fixed as constants: each entry marks its own.

Status: Partly built. Since: 2026-11-12. Detail: [Architecture: Security and authority, Guardrail levels](../architecture.md#security-and-authority).

### Local-first with a closed list of outside calls

Everything a person cares about stays on the host. Octant makes only a short, switchable list of host-initiated calls.

- No Octant account, relay or telemetry is required; there is no Octant relay (maintainer decision, 2026-11-14).
- The outside calls (signed update checks, managed device-tool update checks, marketplace fetches the person starts, public Canvas link calls, a hub's push delivery) each have an off switch. Optional [thread titles](model-endpoints.md#thread-titles) go only to the endpoint the person selects.
- Traffic among a person's own devices is not a third-party call, and is always authenticated and encrypted.
- A new outside call, credential exposure or cloud dependency needs an explicit request and a documented boundary in the owner.

Status: Built. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### Desktop-owned broker cleanup

A desktop-owned launch keeps hold of the native resources it acquired through failure and shutdown, and releases them once.

- Every acquired cleanup stage is attempted even after an earlier one failed, without widening the quit deadline or taking ownership of borrowed hosts.
- A start-up failure is shown in a window that does not block quitting, never a parentless native alert.
- Signals, Quit, closing the window and its Quit button each end the app once.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Server authority, an authoritative journal, and strict host reads

The server decides every authority question, the event journal is the record, and the host reads its own inputs strictly.

- Every authority check runs in the server before a side effect; renderers only show what the server allows.
- Commands append versioned events; read models are idempotent projections rebuildable from the journal.
- Contracts are schema-only, domain code is pure, dependencies point inward, and provider payloads stop at the adapter.
- A provider's own program typed into a terminal tab is offered only as a person-operated terminal whose activity the thread does not claim (maintainer decision, 2026-11-21).
- The host refuses unknown fields from clients, the journal, projections, extensions and manifests.
- What a provider runtime sends is read tolerantly (maintainer decision, 2026-11-25), but authority checks on its output stay fatal ([Reading what a runtime sends](provider-runtimes.md#reading-what-a-runtime-sends)).

Status: Built. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### Plugin-shaped growth

New providers, tools and capabilities reach the system only through the published seams, and take no shortcut a third-party plugin could not take.

- Shipping in-tree is allowed; wiring into server internals or widening a seam for one vendor is not. A capability a seam cannot express extends the seam in its own change.
- Core capabilities are app-managed and provider-neutral, added beside a key provider's own tools, never instead of them.

Status: Built. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles) and [Plugin boundaries](../architecture.md#plugin-boundaries-and-remaining-extraction).

## Guardrails and review

### Guardrail levels

One setting says how much a thread's tool calls are guarded: Ask first, Accept edits, Auto or Full access. Plan is a read-only overlay on any level, and Strict is a separate switch.

- Ask first: the person approves anything with effects; outside Strict the provider's own sandbox and permission modes enforce it (maintainer decision, 2026-11-21), and under Strict Octant's OS confinement runs too.
- Accept edits: as Ask first, but file edits inside the folder go through.
- Auto: a reviewer answers prompts and escalates what it will not allow ([Auto: the provider's reviewer or Octant Shield](#auto-the-providers-reviewer-or-octant-shield)).
- Full access: no sandbox and no prompts; outside content is only marked, protected files are guarded softly, and every hard line holds. It may keep a sandbox (`fullAccessSandbox`) for containment without prompts; a runtime Octant cannot confine that way refuses rather than run open.
- Subagents never exceed their parent's level. A routine asks first unless the person chose otherwise ([Routine authority level](#routine-authority-level)).
- A level is set globally, per Project or per thread; the narrowest wins, and every lowering is journaled with who, when, scope and old level.
- In Work, Plan is the thread's own level and may be a default (maintainer decision, 2026-11-21).
- Strict, inherited thread, Project, Settings, restores Octant's own asks and sandbox ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox)).
- A live Codex turn under `fullAccessSandbox` is a maintainer check still owed.

Not built yet:

- Strict on Windows below Full access or with a provider other than Codex: it needs Octant's sandbox, which Windows does not have yet ([Windows Strict, phase 1](#windows-strict-phase-1)).

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Guardrail levels](../architecture.md#security-and-authority).

### Secrets are guarded, softly at Full access

Below Full access, secret files stay out of every agent's reach by an operating-system rule. At Full access the guard is soft: a shell command can read a protected file, and secret values are still never journaled.

- One deny list covers private keys, cloud and tool credentials, keychains, browser login stores, Octant's secrets and other runtimes' sign-ins, never a whole Application Support or `~/.config` folder (maintainer decision, 2026-11-13). The person adds paths in Settings; removing a built-in group needs a confirm and is journaled.
- At Full access Claude Code's own file tools read protected paths (maintainer decision, 2026-11-14); Octant's own file tools and OpenCode's refuse only the Provider sign-ins group (maintainer decision, 2026-11-15), and Octant's own also the [thread secrets](#thread-secrets) folder (maintainer decision, 2026-11-24). The Watcher flags and never blocks.
- A refused read names the rule and the channel to use; a check that cannot finish refuses.
- Agents use credentials without reading them: the SSH agent, the Git credential helper and the credential broker.
- Windows paths are normalised and share, device and drive-relative roots refused (maintainer decision, 2026-11-14).
- Known key formats and broker-issued values are redacted from output, transcripts, the journal, exports and logs at every level.
- Linux access-time mediation is an opt-in preview for compatible custom-kernel hosts (maintainer approval, 2026-11-16); anything missing refuses before launch. Strict keeps the full guard at Full access.

Not built yet:

- The list as an operating-system rule on Windows: Windows has no confined launch yet.
- Provider and signed-package live checks of Linux mediation: they remain explicit maintainer acceptance.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Secret guard](../architecture.md#secret-guard).

### Optional first-task capability discovery

Your first task includes an optional Explore capabilities card for Browser, Computer use, helper agents and person memory.

- Host facts and existing Settings own its state; dismissal changes no setting and adds no onboarding step.
- Computer use reports working only after a successful local test.
- Paired clients gain no local settings authority.

Status: Built. Detail: [Start screen: Optional capability card](start-screen.md#optional-capability-card-in-your-first-task).

### First run asks which mode new threads start in

The first run asks once which mode new threads start in, with Auto pre-selected and marked Recommended. It never pre-selects Full access.

- Where no reviewer can run, a thread falls back to Ask first and the picker says why.
- The answer is the default for new Work and Code threads; Settings, a Project override and the composer change it.
- The host decides a new thread's level; nothing the renderer sends raises it (maintainer decision, 2026-11-21).
- A routine or benchmark run in a Project whose start mode is Plan still asks first.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Guardrail levels](../architecture.md#security-and-authority).

### Work and Code share one capability set and differ in focus

Work and Code run under the same levels with the same capabilities. They differ in what they show and which tools a thread starts with.

- Shell, Git, files, SSH, provider-native tools, subagents, routines and Full access are governed alike.
- Work hides developer surfaces until the person turns on Developer tools for that Project. Only a person sets it, from a window on this host or a device the host's own person paired (maintainer decision, 2026-11-12); no agent, routine or import does.
- A thread keeps the kind it was created with.
- An ACP agent whose shell runs in-process without a protocol request is refused below Full access.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Modes](../architecture.md#modes-chat-work-and-code) and [Overview and principles](../architecture.md#overview-and-principles).

### Auto: the provider's reviewer or Octant Shield

At Auto a reviewer stands in for the person's click: the provider's own reviewer where it has one, otherwise Octant Shield.

- The provider's own is the default where it exists (Claude Code, Codex, Mistral Vibe's auto-approve mode).
- A verdict the provider reports is journaled with the provider as approver; the host never infers a verdict from a call that ran.
- Under Strict, outside content withdraws the provider's own reviewer for irreversible, publish and new-egress classes. Outside Strict the reviewer stays and the thread is only marked ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).

Not built yet:

- A reviewer choice and the outside-content withdrawal in Work: only Code's Settings and Code Projects carry `autoReviewer`, read by the Code service alone.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Reviewed](../architecture.md#security-and-authority).

### Octant Shield

Octant Shield is Octant's own automatic approval reviewer for every runtime that routes approvals through Octant. A Watcher reads outside content and a Judge answers approvals, and they never share input.

- The Judge never sees tool results or fetched content. A malformed answer, a timeout or an unreachable model means ask the person.
- Malicious-call classes go to the person or are refused, never allowed.
- Shield grants per call only, never a standing rule, and never widens the OS sandbox. On a marked thread it cannot allow irreversible, publish or new-egress classes.
- Its denial pause limits are settings (maintainer decision, 2026-11-21).
- The Watcher can only raise; its labels mark the thread and reach the Judge as kinds.
- Shield sends no telemetry, counts against spend ceilings and journals every decision.
- Automatic model calls are set from a local window or a device the host's own person paired (maintainer decision, 2026-11-12); selection is manual and never fails over.
- A release with Shield requires measuring its false-allow rate on the fixture set.

Not built yet:

- The false-allow rate of a real model: not yet measured.
- Automatic model calls on a paired client: the server admits a person-paired device; the paired UI is a follow-up.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Octant Shield](../architecture.md#octant-shield).

### Safe networks

The person names trusted places (hosts, domains, address ranges, private-network tags) whose egress passes by rule.

- Only a person changes the places and the Network limits switch, at a local window or a device the host's own person paired (maintainer decision, 2026-11-12); each change is journaled.
- Network limits are off by default, because Octant never takes a provider's core features away (maintainer decision, 2026-11-14). They apply only to sandboxed runtimes.
- With limits on, a sandboxed runtime reaches only its provider's endpoints, its Project's egress rules and these places; elsewhere goes to the Judge at Auto or the person, journaled per host.
- No place reaches a link-local address, and taint suspends places for a marked thread.
- Live Codex and Claude turns with limits on, and measuring an ordinary Code turn's hosts, are maintainer checks still owed.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Provider runtime network](../architecture.md#provider-runtime-network) and [Octant Shield](../architecture.md#octant-shield).

### Server SSH profiles

The person registers their own servers with an action profile (Read-only, Operate or Admin), and SSH to a registered server is judged by that profile in Work and Code alike.

- A local window or a device the host's own person paired edits the registry, journaled.
- Keys stay out of the agent: the session gets the SSH agent or the broker, which signs only that server's login.
- Destructive or lock-out actions go to the person at every level below Full access; at Ask first the first connection to each host in a thread asks.
- Every remote command is journaled with its host; remote output passes through the Watcher; a runbook grants nothing.

Not built yet:

- A command record with exit status for OpenCode, ACP agents and Pi: they do not name their commands, so Shield's decision is their record.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Octant Shield](../architecture.md#octant-shield) and [Modes](../architecture.md#modes-chat-work-and-code).

## Key providers

### Key providers run as themselves

A key provider (Claude Code, Codex, OpenCode, Mistral Vibe and every ACP agent) runs inside Octant as it runs on its own: its native subagents, web tools, skills and home configuration, and the Project's hooks, MCP servers and plugins, plus Octant's journal and views. Octant adds capabilities and takes no core feature away.

- The person's own setup is on by default at every level, and each call still meets the thread's level. Plan stays read-only and runs no home hooks; Chat has no folder and no shell.
- The person turns the setup off per account (Run as itself) or per thread (Account default, On, Off). Off beats Full access, and a thread's On never grants a Project's code. Only the host's own person changes these switches, journaled.
- An account turned off keeps the runtime's own web search and fetch off in every mode and at every level; nothing else turns them back on (maintainer decision, 2026-11-15).
- Turning the setup on never turns on the provider's own memory, telemetry or self-update ([A provider's own memory](#a-providers-own-memory), [Provider telemetry and self-update are the person's switches](#provider-telemetry-and-self-update-are-the-persons-switches)).
- A Project's own code loads in every Project the person added, outside Plan; under Strict only where the person allowed it, with one quiet notice per Project ([Adding a Project trusts it for every agent](#adding-a-project-trusts-it-for-every-agent); maintainer decision, 2026-11-18).
- Accounts turned off before 2026-11-14 read as on after upgrade, and downgrade is not supported.
- Each provider's own rules: [Claude Code decides with its own permission modes](#claude-code-decides-with-its-own-permission-modes), [Claude Code's full tool preset](#claude-codes-full-tool-preset), [Codex runs as itself](#codex-runs-as-itself), [OpenCode runs as itself](#opencode-runs-as-itself), [Mistral Vibe runs as itself](#mistral-vibe-runs-as-itself), [ACP agents run as themselves](#acp-agents-run-as-themselves).

Status: Built. Since: 2026-11-14. Detail: [Architecture: Providers](../architecture.md#providers) and [Provider runtimes: Key providers](provider-runtimes.md#key-providers).

### A provider's own memory

Each Claude Code and Codex account has its own memory setting, on by default in Work and Code outside Plan; OpenCode and Mistral Vibe carry none.

- Only the host's own person sets it, journaled (maintainer decision, 2026-11-12). Run as itself, a trusted Project and Full access never turn it back on.
- In Plan and Chat, Claude Code's memory loads read-only; Codex's follows the setting outside Strict (maintainer decision, 2026-11-21) and stays off under Strict, because Codex writes memories in the background.
- Accounts that turned memory off before 2026-11-14 read as on after upgrade.

Status: Built. Since: 2026-11-14. Detail: [Provider runtimes: Key providers](provider-runtimes.md#key-providers).

### Claude Code decides with its own permission modes

Outside Strict, in Work and Code outside Plan, Octant maps its levels onto Claude Code's native permission modes, and Claude Code's own engine and the person's Claude rules decide each tool call (maintainer decision, 2026-11-15).

- A session that reads no Claude settings keeps Octant's gate and sandbox.
- Octant keeps its own ask only for the calls its server must answer (questions, publishing, wake-ups, `Workflow`, leaving Claude's sandbox, paths and worktrees outside the session's folders).
- A call past every Octant refusal follows the person's own allow rules, a trusted Project's included; only a real ask becomes an Octant approval, decided and journaled on the server (maintainer decision, 2026-11-14).
- A session-kept approval goes back as Claude Code's own session rule, never written to the person's settings (maintainer decision, 2026-11-25).
- Strict, Plan and Chat keep Octant's gate.

Status: Built. Since: 2026-11-15. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority) and [Provider runtimes: Full built-in tool set](provider-runtimes.md#full-built-in-tool-set).

### Claude Code's full tool preset

Outside Strict, Plan and Chat, Octant offers Claude Code's full built-in tool preset with no Octant deny list (maintainer decision, 2026-11-15).

- Under Strict, Work and Code hold the set less a withheld list whose every entry would break a server rule; an unknown tool asks below Full access, so a new tool fails closed.
- A turn has no tool-call cap; asks past their caps wait in line (maintainer decision, 2026-11-14).
- A path, working directory or worktree outside the Project's folders asks below Full access and is refused in Plan, Chat and Strict; secret-path refusals stay (maintainer decision, 2026-11-25).
- Leaving Claude's sandbox asks below Full access, is never covered by a remembered answer, is journaled as unsandboxed, and is refused in Plan. `git push` and `gh` writes ask below Full access.
- Plan keeps its read-only list, and Chat its list with no filesystem or shell. Background work: [Background tasks and turns a runtime starts](#background-tasks-and-turns-a-runtime-starts); plan tools: [Providers plan in Plan](#providers-plan-in-plan).

Status: Built. Since: 2026-11-15. Detail: [Provider runtimes: Full built-in tool set](provider-runtimes.md#full-built-in-tool-set).

### Background tasks and turns a runtime starts

Background commands and command watches run outside Plan, and a Work or Code turn completes when the reply is done while its background tasks keep running as live tasks (maintainer decision, 2026-11-14).

- A turn the runtime starts on the idle thread runs at the thread's level, journaled with the runtime as its origin, and answers no tool call until the host attached it.
- The kept session is held to the thread's level, provider, model, binding and folder, and stops when its tasks end, when the person stops or changes the thread, or at the host's limits (maintainer request, 2026-11-15).
- In child runs and single-use sessions such a turn is held inside the person's turn, through the same gate.
- `Workflow` starts ask below Full access, and a remote run is refused. Scheduled wake-ups are answered from the thread's Octant-owned wake-ups, never run by the runtime ([Wake-ups the agent schedules](#wake-ups-the-agent-schedules)).

Not built yet:

- A separate origin marker in Chat and child runs: they fold the runtime's turn in without one.

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: Background commands and runtime-started turns](provider-runtimes.md#background-commands-and-runtime-started-turns).

### Starting a thread from a provider's own session

An empty Work or Code thread can start from one of the person's own sessions of the same account and folder begun outside Octant, for Claude Code, Codex, OpenCode, Pi and ACP agents that list their sessions (maintainer decision, 2026-11-14).

- Only the person adopts one. A session an Octant thread holds is never offered, and two threads never drive one session.
- The adoption is journaled, the thread is marked as carrying outside content from its start, and the first turn resumes only on the provider, model, binding and folder it was adopted under (maintainer request, 2026-11-15).
- A Code fork or rewind on OpenCode and Pi continues their own copy of the session, never changing the source.
- Imported earlier conversation is bounded, journaled once, marked as imported, and never sent back to the provider or billed (maintainer decision, 2026-11-20).

Not built yet:

- History import for OpenCode: its message shape is not one Octant reads.
- Carrying imported messages in a provider-switch handoff or a fork: not built.

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: Sessions started outside Octant](provider-runtimes.md#sessions-started-outside-octant), [Imported history](provider-runtimes.md#imported-history) and [OpenCode subagents, Strict and sessions](provider-runtimes.md#opencode-subagents-strict-and-sessions).

### Providers plan in Plan

A key provider plans in Plan as it does on its own, and its plan becomes the reply under a **Proposed plan** heading (maintainer decision, 2026-11-14).

- The runtime never switches its own mode: Claude Code's plan-mode calls become level-change approvals the person answers at every level, journaled. An approved plan returns the thread to the level it left, never Full access.
- Entering Plan inside a running turn applies in place, and the gate then refuses every write and shell call (maintainer decision, 2026-11-18). Leaving Plan always ends the turn.
- Outside Strict, an approved Claude Code plan is carried out by a turn the host starts; declining starts nothing (maintainer decision, 2026-11-25).

Not built yet:

- A continuation for Codex: its proposed plan is reply text with no card to approve.
- A provider-proposed thread plan: no provider has a path to the person's thread plan ([Provider runtimes: Native plan capture](provider-runtimes.md#native-plan-capture)).

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: Plan mode as level changes](provider-runtimes.md#plan-mode-as-level-changes) and [Native plan capture](provider-runtimes.md#native-plan-capture).

### Codex and OpenCode question forms

Codex's and OpenCode's question forms reach the person through Octant's questionnaire (maintainer decision, 2026-11-14).

- Under Strict, a question asking for a secret is refused with a message to the model and never shown.
- Outside Strict, a Codex secret question is shown, answered in a masked field, and the answer goes to the Codex process in memory only; the journal records only that one was given (maintainer decisions, 2026-11-21).
- Only the person answers, never an agent acting for them. A subagent takes its parent's Strict value.

Status: Built. Since: 2026-11-14. Detail: [Provider runtimes: Codex](provider-runtimes.md#codex) and [Provider runtimes: OpenCode](provider-runtimes.md#opencode).

### Codex runs as itself

Codex keeps its Project skills and, in Chat, the person's tool servers and plugins, and reads the Project's `AGENTS.md` in Work as in Code (maintainer decision, 2026-11-14).

- Its own subagents run at every level as child runs, answered through the parent's approval path. With Run as itself off they stay off unless the thread's On, the Project's trust or Full access turns them on; a thread's Off keeps them off.
- A session-kept approval is Codex's own session grant, outside Strict only.
- See also [Codex's own review runs in Octant](#codexs-own-review-runs-in-octant) and [Codex loads its own Project configuration](#codex-loads-its-own-project-configuration).

Status: Built. Since: 2026-11-14. Detail: [Provider runtimes: Codex](provider-runtimes.md#codex).

### OpenCode runs as itself

Octant runs OpenCode 2 from 2.0.22 as it runs on its own: its skills, the person's MCP servers and permission rules, and a Project's own configuration (maintainer decisions, 2026-11-14 and 2026-11-25).

- An older release is refused by name; a feature that needs a later release is off there and never refuses the session.
- The person's deny rules hold at every level, Full access included; their allow never opens an outside folder the level asks about or refuses (maintainer decision, 2026-11-25).
- From 2.4.1, outside Strict, Work and Code with Run as itself on read the person's own configuration, and Octant adds only the level's rules; a session that cannot be held to the level is aborted. Strict, Plan, Chat and a sandbox keep Octant's private configuration.
- Reads inside the Project run unasked at every level; protected files stay refused. Outside folders ask below Full access and are refused in Plan.
- Outside Strict, Plan and Full access, Octant's tools are offered labelled as mixed (maintainer decision, 2026-11-25). Subagents: [OpenCode's task subagents run outside Plan](#opencodes-task-subagents-run-outside-plan).

Not built yet:

- A notice when a launch withholds Octant's tools: the provider contract has no runtime event for it.
- Octant's tools for a Strict thread in a Project trusted for OpenCode: the launch admits them, but the host still reads `unsupported`.
- A level change in place on the person's own configuration, and warm server reuse between turns: OpenCode starts a new server for every turn.

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: OpenCode](provider-runtimes.md#opencode), [OpenCode 2 on the person's own configuration](provider-runtimes.md#opencode-2-on-the-persons-own-configuration) and [Octant's tools outside Strict](provider-runtimes.md#octants-tools-outside-strict).

### OpenCode's task subagents run outside Plan

OpenCode's `task` subagents start without asking outside Plan, at every level.

- This covers `subagent` and its older name `task`, in Work, Code and Chat.
- Plan denies both.
- A person's own OpenCode rule that denies `task` wins.
- Each child session's requests reach the person through the parent's approval path at the thread's level. Octant's server answers and journals them.

Status: Built. Since: 2026-11-15. Detail: [Provider runtimes: OpenCode subagents, Strict and sessions](provider-runtimes.md#opencode-subagents-strict-and-sessions) and [Architecture: Security and authority](../architecture.md#security-and-authority).

### Mistral Vibe runs as itself

Mistral Vibe loads its own skills and Project context, the account's MCP servers, connectors and hooks, and a trusted Project's `.vibe` setup under its own folder trust (maintainer decision, 2026-11-14).

- Its subagents run in Work and Code outside Plan as child runs. Their requests name no tool, and a subagent may approve its own tools, as in Vibe; the maintainer accepted both, and each child run says so.
- It stays on the ACP bridge. Questions and usage are claimed only for the verified 3.0.3 release; the signed-in 3.0.3 question check is a maintainer live check still owed.

Not built yet:

- Supplementary file-review reads: the capability stays off pending signed-in 3.0.3 read and cold-resume evidence.
- Requested native compaction: its allowlist stays empty pending signed-in compaction and cold-resume proof.
- Native review: no path to it is built.

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: Mistral Vibe surface](provider-runtimes.md#mistral-vibe-surface).

### ACP agents run as themselves

Every ACP agent is a key provider: its account and thread switches work as the others' do, and outside Strict nothing of its own setup is held back (maintainer decisions, 2026-11-14 and 2026-11-21).

- Under Strict, or with the setup turned off, the Project's entries load only on the Project's allowed code and the home entries only with the person's setup. Plan stays read-only.
- Each agent's own subagents run in Work and Code outside Plan. A request naming a call Octant never saw asks under the thread's level and marks the thread as having read outside content.
- Outside Strict an agent runs on the person's real home where its setup is carried, no Octant sandbox applies, and its session store is the same on both homes (maintainer decision, 2026-11-25).

Not built yet:

- The person's real home for Devin, Goose, fx and added ACP agents: nothing confirmed pins their session stores ([Provider runtimes: The home an ACP agent runs on](provider-runtimes.md#the-home-an-acp-agent-runs-on)).

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: ACP agents run as themselves](provider-runtimes.md#acp-agents-run-as-themselves).

### Provider slash commands and the `@` menu

A provider's own slash commands are listed in every composer's `/` menu beside Octant's, labelled as the provider's, and run in every mode, Chat and Plan included; the level's tool rules decide what a command may do (maintainer decisions, 2026-11-14 and 2026-11-16).

- Kimi Code runs only a command its session or readiness check listed; no reviewed inventory refuses a release (maintainer decision, 2026-11-21).
- Codex's own skills and plugins are listed in the `@` menu, never one Octant switched off for the thread (maintainer requests, 2026-11-18 and 2026-11-19).

Status: Built. Since: 2026-11-14. Detail: [Provider runtimes](provider-runtimes.md) and [Architecture: the composer's `@` and `/`](../architecture.md#person-memory).

### Octant adds no restrictions of its own unless Strict is on

A person who moves from a provider's own CLI to Octant keeps every workflow that worked there. Octant's extra protections are the opt-in Strict setting, and Full access adds nothing (maintainer decision, 2026-11-16).

- Strict is set per thread, as a Project's default, and as the Code and Work defaults; the host resolves it at each launch and call.
- Outside Strict a provider gets the person's environment less `OCTANT_*` and the variables that would sign it in as another account (maintainer decision, 2026-11-26). Under Strict it gets a fixed list plus the names the person lets through.
- Outside Strict, outside content marks the thread but withdraws nothing and adds no asks; a provider's own tools may use the files Octant protects, except Claude Code's file tools below Full access. Strict restores each guard.
- A provider's own git, `gh`, approvals, plans and working directories stay native; Octant's pull-request tools and Shield keep their merge and forge hard lines (maintainer decisions, 2026-11-25).
- Octant's own agents work unattended at their thread's level; turn budgets and stall and loop stops apply only under Strict, which otherwise only notice (maintainer decisions, 2026-11-25).
- `octant agent --full-access` and a home-folder extra folder are refused from anything but the host's own window, and under Strict.
- Opt-in Blocked tools apply with or without Strict, changed only by the host's own person. Each Strict launch journals what Strict kept.
- Kept at every Strict value: read-only Plan, Chat with no folder or shell, outside folders asking below Full access, refused secret questions, Run as itself off keeping web tools off, and signing in only as the account chosen in Octant.

Not built yet:

- The Let-through list for an OpenCode, ACP or Pi launch that keeps or chose a sandbox outside Strict, a version read, a provider's tooling commands and a runtime placed on a server: each builds its environment on a path the list is not wired into.

Status: Partly built. Since: 2026-11-16. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Claude artifacts and Claude Design work as in Claude Code

With an account's Claude artifacts switch on, Claude's `Artifact` tool works as in Claude Code, so Claude Design's `/design` and `/slides` work in Octant (maintainer decision, 2026-11-16).

- Outside Strict the account switch alone decides the offer. Strict keeps the thread's choice and the publish-only, Project-file rule.
- Work and Code get every action; a publish of a local file follows the thread's file rules. Chat and Plan get read-only actions.
- A thread's calls reach only the claude.ai account it runs on, and each publish journals its account. An API-key account never offers the tool.

Status: Built. Since: 2026-11-16. Detail: [Provider runtimes: Claude Code](provider-runtimes.md#claude-code) and [Architecture: Security and authority](../architecture.md#security-and-authority).

### Codex's own review runs in Octant

Codex's built-in `/review` runs in every Work and Code mode, Plan and Strict included, on the thread's checkout, and Octant never refuses it there (maintainer decisions, 2026-11-16 and 2026-11-18).

- It runs with no approvals in a read-only sandbox: Codex's own outside Octant's sandbox, Octant's inside it.
- Its findings show as a review result, not as edits, and reach the session's own thread. Chat does not start one.

Status: Built. Since: 2026-11-16. Detail: [Provider runtimes: Codex](provider-runtimes.md#codex).

### Codex loads its own Project configuration

Codex loads its own Project configuration in every Project the person added, outside Plan; under Strict only once the person allowed the Project's code (maintainer decisions, 2026-11-16 and 2026-11-18).

- Trust is stated per thread, never written to Codex's `config.toml`, and no folder is marked untrusted.
- Plan records no trust and still reads `AGENTS.md`. Codex's own denylist of Project keys stays.

Status: Built. Since: 2026-11-16. Detail: [Provider runtimes: Codex](provider-runtimes.md#codex) and [Architecture: Providers](../architecture.md#providers).

### Adding a Project trusts it for every agent

Adding a Project, or an extra folder to a thread or Project, is the person's trust decision for every agent on that Project's threads (maintainer decision, 2026-11-18).

- Outside Strict every Work or Code Project is trusted; under Strict only for the providers it lists, and Strict holds the Project's code until the person allows it once per Project.
- Each provider is told the folder is trusted per launch, never by a write to the person's configuration. No folder is marked untrusted, and instruction files are read in every mode.
- Folders outside any Project still ask below Full access.

Not built yet:

- Grok Build, Mistral Vibe, GitHub Copilot, Devin and Kimi Code keep their own folder-trust lists: Octant does not set them at launch.

Status: Partly built. Since: 2026-11-18. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority), [Architecture: Providers](../architecture.md#providers) and [Provider runtimes: Codex](provider-runtimes.md#codex).

### Any ACP agent can be added

A person may add an agent from the public ACP registry or their own local command, through the plugin model (maintainer decision, 2026-11-16).

- Installation, trust and enablement stay separate steps, each journaled and only the host's own person's; discovery grants nothing.
- An enabled agent the person has not trusted starts in Octant's sandbox with none of their setup and none of Octant's tools.
- A managed install runs nothing it fetched until **Trust**, which runs deferred install scripts, sandboxed under Strict (maintainer decision, 2026-11-19).
- A probe-next agent may ship as an unverified profile that claims only what its sessions show (maintainer decision, 2026-11-21). Google Antigravity: [Google Antigravity runs on the person's own sign-in](#google-antigravity-runs-on-the-persons-own-sign-in).

Not built yet:

- The other probe-next agents' profiles: none has a signed-in probe on record.
- Cursor's recheck: its compatibility probe has not run.

Status: Partly built. Since: 2026-11-16. Detail: [Provider runtimes: Any ACP agent](provider-runtimes.md#any-acp-agent), [Registry coverage](provider-runtimes.md#registry-coverage) and [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Google Antigravity runs on the person's own sign-in

Google Antigravity runs the official `agy` CLI unmodified as `agy acp`, under the rules Google sets for ACP clients (maintainer decision, 2026-11-20).

- Outside Strict, Work and Code start it unsandboxed at every level; Chat, Plan, Strict and an explicit sandbox stay sandboxed.
- Octant never spoofs identity, reads the CLI's credentials, rotates accounts or runs `agy -p`. On the personal sign-in, account windows come only from a reversible bridge on `agy`'s documented status-line hook that the person opts into.
- On the personal Google sign-in it stays inside Google's consumer-plan line, interactive use by one person (maintainer decision, 2026-11-25). Routines wait for the person's confirmation, every other turn no person sent is refused, and background model calls skip it.
- Those limits lift only for an instance configured with a Gemini API key or Agent Platform (maintainer decision, 2026-11-22).
- Its signed-in live probe is a maintainer check still owed.

Not built yet:

- An Agent Platform instance as a helper target outside Strict: helpers now take their parent's Strict value, and admitting it there is not built.

Status: Partly built. Since: 2026-11-20. Detail: [Provider runtimes: Google Antigravity](provider-runtimes.md#google-antigravity) and [Any ACP agent](provider-runtimes.md#any-acp-agent).

## Release scope

### Technical preview boundary

The first release is the technical preview for Apple-silicon Macs, with the provider-neutral plugin and skill marketplace. Signing, notarization and self-update ship as one deliverable, because an updater on an unsigned app is an unauthenticated code-delivery channel.

- It ships when a maintainer approves the first stable tag; daily builds stay previews and Linux is not part of it.
- The newest Preview may be the latest release only until the first stable one exists (maintainer decision, 2026-11-22).
- `octant server install|upgrade` refuses an unverified headless build unless the person passes `--self-built` (maintainer decision, 2026-11-19).
- The minimum is macOS 15.0, which the bundled Simulator tools need (maintainer decision, 2026-11-22).
- In scope: connectors, Code's Git and pull-request work, a person's merge from any client, host-local routines, the levels, key providers' native features, Shield, [provider terminals](#provider-terminals) (maintainer decision, 2026-11-21), and public Canvas links through the self-hostable `apps/share`, with no Ogard Labs instance (maintainer decision, 2026-11-07).
- An agent merges only as [Pull-request merge](#pull-request-merge) allows, never on its own initiative.
- Out of scope: cloud scheduling, an Octant-operated hosted service, physical phones and tablets, and store upload, submission and release (maintainer decision, 2026-10-29).
- An unauthenticated download of the latest link, and the first release run that signs a headless build, are maintainer checks still owed.

Status: Built. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Native Windows QA packaging

A matching Windows x64 host may build a portable desktop QA archive and check its native dependencies inside packaged Electron.

- The archive acquires no native profile and by itself enables no host admission, credentials, Work or Code, installer or update channel; those follow the [Windows sequence](#one-desktop-app-linux-next-windows-later).

Status: Built. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### External user guide and maintainer-owned publication

The guide lives in `Ogard-Labs/octant-site/docs`, outside the application monorepo, and builds on its own for `https://octant.sh/docs/`.

- Application changes update it through companion PRs linked in both descriptions.
- The maintainer releases the site artifact; no workflow deploys it.
- CI refuses tracked files under the former `apps/docs` path, so there is no second guide source.

Status: Built. Since: 2026-11-07. Detail: [Documentation build and VPS handoff](../docs-deployment.md).

### First-preview tracks are design-first

Everything on the work board is in scope for the first proper preview release (maintainer decision, 2026-11-06). There is no separate post-preview track.

- Each track is built only once its specification documents its boundaries. Remote SSH development environments are in scope ([Server Projects](server-projects.md)).
- Creating an account, spending money, submitting to a store, deploying a hosted service or weakening an invariant each needs a separate maintainer action.

Not built yet:

- The tracks whose entries mark them not built: each is built only once its specification documents its boundaries.

Status: Partly built. Since: 2026-10-26. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### One desktop app, Linux next, Windows later

Desktop is one product on macOS, Linux and Windows. Platform differences are fail-closed posture, never a second app.

- The sequence is the Linux shell, then the Linux AppImage with its signed feed, then Windows. Windows packaging and CI may proceed now (maintainer decision, 2026-11-06), but no Windows feed is trusted before the Linux signed feed has run on a real image.
- The simulator, the Apple workbench and window vibrancy stay macOS-only.
- Windows follows the steps in [the Windows sequence](../architecture.md#current-release-boundary) (maintainer decision, 2026-11-14): a dormant confinement launcher, Work and Code ([Windows below Full access](#windows-below-full-access); maintainer request, 2026-11-15), the CLI, and a per-user signed installer that fails closed (maintainer request, 2026-11-15).
- Each native building block admits no Windows startup, migration or thread by itself.

Not built yet:

- The packaged app reading the Windows feed and running the installer hand-off: waiting on the Linux signed feed on a real image.
- Ordinary Windows startup admission: it needs native packaged startup, attachment and stop evidence.
- Strict on Windows: the confinement launcher is dormant.
- The first signed release with Azure federation, and the CLI on a machine without an administrator token: maintainer checks still owed.

Status: Partly built. Since: 2026-10-16. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Person-controlled update install

An update installs only after its feed signature and artifact hash verify, and only on a relaunch the person starts.

- The release must be strictly newer and name this app, platform, architecture and ring; anything unverifiable is refused, never downgraded.
- Install waits while agents are active.
- Automatic checks are off until the person opts in; first run asks once (maintainer request, 2026-11-12). A check carries only version, platform and architecture.

Not built yet:

- Windows updates: the Authenticode-checked installer hand-off is not wired in, so Windows refuses updates.

Status: Partly built. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Scope hold until the Full access rule is built

Bots, the Nightly shared-host client, public Canvas links, and Browser upload and download manifests take no new scope until [The Full access rule](#the-full-access-rule) is built (maintainer request, 2026-11-12).

- The hold adds no rule to those features and removes none.
- Windows work is not held (maintainer decision, 2026-11-14).

Status: Designed, not built. Since: 2026-11-12. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Windows below Full access

On Windows outside Strict, every level below Full access runs with the provider's own approvals, and with its own sandbox where it has one. Octant claims no sandbox there. Strict works on Windows only at Full access with Codex ([Windows Strict, phase 1](#windows-strict-phase-1)); everywhere else it is refused.

- The mode picker and the thread say the provider's own approvals decide; the server answers and journals every ask.
- Strict below Full access and a kept sandbox are refused by name, by the server and by each launch.
- Every runtime starts unconfined, is stopped with its whole process tree and keeps its ownership receipt; a Strict session never reuses a process started outside Strict.
- An npm `.cmd` shim starts the program it names, never through a shell.
- Plan stays read-only through the provider's own plan mode. Chat runs on any provider that can natively be given no folder and no shell.
- Octant's terminals, the harness shell, Project actions, tests, language servers and debug sessions run unconfined outside Strict with the level's asks, and are refused under Strict or a kept sandbox.
- Below Full access, an ACP launch whose person turned the agent's own setup off is refused wherever its profile holds setup back (maintainer decision, 2026-11-22).
- A live turn on a person's Windows machine is a maintainer check still owed.

Status: Built. Since: 2026-11-16. Detail: [Architecture: Current Release Boundary, Windows below Full access](../architecture.md#current-release-boundary).

## Process topology and local trust

### Desktop, server and renderer roles

The desktop main process owns native windows, menus, the system keychain and all native pickers. The server is the single authority: it resolves a client principal for every request and journals every mutation. The renderer holds no authority of its own.

- A picker hands the server the path under the bridge secret; the renderer gets only a single-use receipt.
- A paired browser mounts the remote shell; the window-bound sidebar, dock and Settings are not served remotely.
- Process-local approvals and grants expire on the process authority clock, so a clock change cannot extend one and a restart discards them; no persisted clock value may block startup.
- Shared product state is host-owned; window layout and unsaved drafts stay client-context state.
- The renderer's first load stays within an exact byte budget that CI enforces.
- Crash recovery is bounded and an explicit quit wins.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Local client context and loopback trust

The local trust class is "holds a secret only the host's OS user can read", not "is on loopback". Loopback plus an admitted origin proves nothing about the caller.

- A browser gets a session only through a short-lived one-time launch token bound to its renderer origin.
- Every CLI command and desktop window presents the bridge secret, sent only to the host named by the owner-only host receipt.
- The listener admits only its own origins; any other loopback page is refused.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Mobile app and remote clients

The phone app is a remote-control client under the host's authority. Threads are host-owned; the phone stores only device keys, a host registry and session material.

- The phone creates threads and sends turns under each thread's authority. A Code thread's approvals, folder binding and file edits stay host-only; Work is as [Paired devices act as the person](#paired-devices-act-as-the-person) says.
- Side panes are read-only on the phone; per-run subagent detail stays with a local window (maintainer request, 2026-11-14).
- Internal beta distribution grants no authority; public store distribution needs a separate maintainer action.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology) and [Mobile maturity](mobile-maturity.md#phase-e-public-store-distribution).

### Desktop menu bar and context menus

The menu bar is the closed-window fleet roster, read from the host rather than from open windows. Context menus carry presentation and opaque action IDs only.

- The menu bar raises no notifications, and thread titles never enter the public health response or diagnostics.
- The renderer draws every context menu except the code editor's text-editing one (maintainer decision, 2026-11-15).
- A contribution cannot supply roles, callbacks, paths, URLs or native commands.

Status: Built. Detail: [Architecture: Desktop menu bar](../architecture.md#desktop-menu-bar) and [Architecture: Desktop context menus](../architecture.md#desktop-context-menus).

### Language services and the debugger

Code editor language services and the debugger run as confined children the server launches per checkout. Agents read the same servers through two read-only tools.

- Agent reads never start or retarget a server. Edits apply through per-file save authority.
- A static server added from a folder installs untrusted and off until reviewed.
- A repository-tooling server starts only after a local-window approval, never in Plan, for a paired device or by an agent; the agent reads through one already running and marks what it reads as outside content (maintainer request, 2026-11-12).

Not built yet:

- The external editor from a paired device: `code.open-external-editor` is still local-host only.
- The bounded `window/logMessage` log, lifecycle counts under Diagnostics, and removing a cache with its checkout or component: not started.
- Starting from the Run and debug panel at Full access without one confirmation: the panel still needs a confirmed configuration.

Status: Partly built. Since: 2026-10-26. Detail: [Architecture: Process topology](../architecture.md#process-topology) and [Language services](language-services.md#debugger-session-rules).

### Host memory pressure

The host watches its own size and the system's memory pressure, and eases itself without stopping a running turn.

- A reading the platform cannot give is unknown, never normal.
- Memory limits and Computer resources are changed from a local window or a device the host's own person paired (maintainer decision, 2026-11-12), journaled.
- The report carries counts and levels only, and nothing leaves the machine.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology) and [local work resource limits](../architecture.md#local-work-resource-limits).

### Keep the computer awake while agents work

While agent work runs, the desktop holds a `prevent-app-suspension` assertion so idle system sleep does not cut it off. It never prevents display sleep, and the renderer holds none.

- The desktop reads only counts and the next routine due time, never titles or paths.
- Only a local window or a device the host's own person paired changes the setting.
- A live macOS `pmset -g assertions` smoke is a maintainer check still owed.

Status: Built. Since: 2026-11-19. Detail: [Architecture: Keeping the computer awake while agents work](../architecture.md#keeping-the-computer-awake-while-agents-work) and [Settings](settings.md#groups-and-pages).

### Other agents start work through the local CLI

Another agent on the host's machine starts and follows Octant threads through `octant agent mcp` or the `octant agent` command line. Both are local clients under the bridge secret, so the host keeps every authority decision.

- The caller is not the person: the server never answers a request listed for the person, never starts a thread at Full access, and adds a Project only when the call says the person asked. The person's own `--full-access` flag does start at Full access.
- Each tool call opens its own window authority and revokes it at the end.
- Remote callers have no path here.

Status: Built. Since: 2026-11-11. Detail: [Architecture: Native harness, scripted callers and other agents](../architecture.md#native-harness).

## App-managed tools

### Tool families and transport

App-owned tools are capability families with one tool per object. Every runtime gets the same definitions through the transport its adapter verified, and no transport edits a person's provider configuration.

- A family whose grant or capability is off is omitted, not advertised and refused; help never reaches the executor.
- Where a runtime keeps its own tool list, omission is per session, so the cached prefix changes only when a tool arrives.
- Late, duplicate or cancelled answers are refused.
- Every runtime gets one line per offered first-party tool saying when to use it (maintainer request, 2026-11-17); a first-party tool without one fails the build ([Agent tools](agent-tools.md#how-tools-reach-a-model)).

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Browser and Computer as tools

Browser and Computer are tools, not mentions. The host offers them on every eligible turn, and authority comes from the person's approval at the moment of action.

- Browser is offered in Work and Code, never in Chat. In Plan it admits only reads of the page already open and stop.
- Computer is never offered in Plan. Outside Strict, Full access needs no first-action approval (maintainer decision, 2026-11-19); otherwise the first action in each application asks once.
- Under Strict below Full access, outside content makes every Computer action ask again; outside Strict the mark adds no ask.
- Only the person approves and stops control of this Mac, at a local window or a device the host's own person paired; a hub-introduced or restricted device is refused.
- The Browser asks only for a site on a signed-in profile (maintainer request, 2026-11-12); a Private page needs none (maintainer decision, 2026-11-17).

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### GitHub reads for Code agents

A Code thread's agent reads its Project's delivery repository through one family, `octant_github`, which writes only to the thread's linked issues.

- The host fixes the repository to the thread's delivery target; no input names a repository or host.
- Every call re-checks the thread's authority; reads change nothing on GitHub.
- On a thread linked to issues it may comment on and close a linked issue of the delivery repository. Plan refuses, below Full access it asks unless the Project's switch allows it on a thread that read no outside content, and a write fails closed without issue-write permission on the repository (maintainer decision, 2026-11-26).
- Every cut is stated, and a size outside bounds is refused, not clamped.
- A read is journaled as outside content before the model sees it, and withheld when it cannot be.

Status: Built. Detail: [Architecture: Reading GitHub](../architecture.md#modes-chat-work-and-code) and [Workspace: Boards and integrations](workspace.md#boards-and-integrations).

### Linear Project mapping and reads for Code agents

A Work or Code Project may bind a Linear team, and optionally a Linear project, on the host. The binding scopes the issue browser, the `Create from…` picker, Start issue and the Code agent's `octant_linear`, read-only except on the thread's linked issues (maintainer decision, 2026-11-24).

- Only a local window sets or clears the binding, journaled.
- `octant_linear` writes only to the thread's linked issues, stays inside the bound scope, and journals outside content before returning data.
- A Code thread is linked to the issue it was created from and to the issues the person links; links change only from a local window or a host-person-paired device (maintainer decision, 2026-11-26).
- Under the Project's Keep linked issues up to date switch, off by default, the host moves linked issues forward to In Progress, In Review and Done, never backwards, and host-started turns move nothing. Every write attempt is journaled, and a token without write access fails closed.
- A live check against a Linear workspace with write access and a real GitHub issue is a maintainer check still owed.

Status: Built. Since: 2026-11-24. Detail: [Host reads and commands: Linear issues](host-reads-and-commands.md#linear-issues) and [Workspace: Boards and integrations](workspace.md#boards-and-integrations).

### Zen assistant tool

Zen's assistant arranges its window's Zen space through one family, `octant_zen`, offered only to the Chat thread bound as that space's assistant.

- It reads layout, never element content, and every change names the version it applies to.
- A recipe widget exists only after the person confirms a preview.
- Switching the Zen plugin off withholds the tool without deleting Zen data.

Status: Built. Detail: [Architecture: Zen assistant tool](../architecture.md#zen-assistant-tool).

### One web search

Octant has one web search definition, `web-search`, offered to every Chat provider while research is on and by the native harness where its grant allows.

- A successful result marks the thread as having read outside content.
- Automatic routing prefers the provider's own search and falls back to SearXNG, so a fresh install can search (maintainer request, 2026-11-14).

Status: Built. Detail: [Architecture: Web search](../architecture.md#web-search).

### Web search backends and data policy

Octant's own `web-search` searches an ordered list of backends the person sets up, filtered by one host data policy (Any, ZDR only, EU only, EU and ZDR) (maintainer request, 2026-11-14).

- The policy governs only Octant's own backends; a provider's own search behaves as on its own (maintainer decision, 2026-11-15).
- The tool never names a backend; the answering backend is journaled.
- A backend is eligible only when the person states its ZDR or EU processing; with none eligible the tool is not offered.
- Only a local window or a device the host's own person paired changes the policy.
- Each key provider launches with its own search off wherever `webTools` is off.

Not built yet:

- Switching off a generic ACP agent's own search: the protocol gives Octant no switch for it.

Status: Partly built. Since: 2026-11-14. Detail: [Web search backends and data policy](web-search-backends.md).

## Canvas authority

### Canvas ownership and tiers

A Canvas belongs to its thread's Project, or, for a Chat thread in no Project, to the thread alone. Finished work comes in three tiers (typed blocks, static frames, running frames), each new block kind gated by a schema version.

- A thread-owned Canvas holds no file, shell, Git or network authority and is never mirrored or published to a replica; it can be shared through the export destinations (maintainer request, 2026-11-12).
- Plan keeps `create` and `revise`; the agent tool has no publish or share.
- An older runtime refuses a newer schema version rather than misread it.
- A person's change is a new head version with a host-stamped actor; a renderer never authors as an agent.
- `preview` renders with the network off and with no server address or credential.

Not built yet:

- A paired device's plain create of a Canvas: the create route resolves only a window's active Project, and the paired browser has no create panel yet.

Status: Partly built. Detail: [Architecture: Canvas documents, designs, and prototypes](../architecture.md#canvas-documents-designs-and-prototypes).

### Canvas frame safety, import and sharing

Frames run nothing unless a design declares script. A running design never reaches the network unless the person turned on that Canvas's Allow network switch.

- No frame has both script and same-origin permission. A running design that cannot be verified network-free does not run.
- Allow network is per Canvas, off by default and journaled; only the person sets it, at a local window or a device the host's own person paired (maintainer decision, 2026-11-12).
- While on, the page reaches the network only through the host's filtering proxy (maintainer decision, 2026-11-13), which refuses private addresses and the host's listeners and sends no credential.
- A remote browser cannot network-contain a running frame; the Run control says so.
- Import HTML fetches nothing it references; a device the host's own person paired imports into the Project it names (maintainer decision, 2026-11-12).
- A share carries a design only with the sharer's acknowledgement. A public link is off by default and published only from the person's approval card, never by an agent (maintainer decision, 2026-11-12).

Status: Built. Detail: [Architecture: Canvas documents, designs, and prototypes](../architecture.md#canvas-documents-designs-and-prototypes) and [Canvas public links](canvas-public-links.md).

## Device transport

### Apple and Android scope

Apple development is simulator-only. Physical devices and store upload, submission and release are out of scope, and `octant_apple` offers no device or distribution operation.

- The host runs no device-control tool, signs nothing for a device and serves no device or distribution route; an agent that needs one uses its own provider tools under the ordinary sandbox and approvals.
- Journals with earlier device or distribution events replay unchanged.
- Octant never rewrites a project to make Apple discovery pass.
- After a restart, ambiguous device work is waiting or inconclusive, never verified.

Status: Built. Since: 2026-10-29. Detail: [Architecture: Device transport and evidence](../architecture.md#device-transport-and-evidence) and [Device workbench](device-workbench.md).

### Device destinations and ownership

A simulator, emulator, local-Mac or computer-use destination has a stable host-local identity and an exclusive owner or lease. The screen is streamed through the host, authorized like a screenshot, and never stored.

- No other thread may reset, erase, shut down or take over a destination another workflow owns, and erase is never an implicit recovery step.
- Octant stops only a process it owns, never by broad name.
- Device activity, evidence and cancellation are scoped to the requesting task, checkout and authority; an action id alone grants no access.

Status: Built. Detail: [Architecture: Device transport and evidence](../architecture.md#device-transport-and-evidence).

### Device input and agent device tools

Input rides the workbench control channel with actor attribution. Agent device tools follow the thread's level per operation, not one Full access gate on the whole tool.

- Reads run at every level, Plan included. Every other operation is an effect: Plan refuses it, Full access sends it, other levels ask.
- Allow input is a short host-memory grant for one window, thread and destination, and never covers boot, shutdown, Open URL or Rotate, which are confirmed on their own.
- An input of unknown delivery is reported interrupted, and an off-screen point is refused, never clamped.
- Only an explicit screenshot sends a screen image to the model.
- `octant_terminal` follows the level: Plan refuses it, Full access runs it, below that each command asks.
- Checks on a real emulator and a real Mac are maintainer checks still owed.

Not built yet:

- iOS describe-ui and tap by element: they need the native device helper.

Status: Partly built. Detail: [Architecture: Device transport and evidence](../architecture.md#device-transport-and-evidence).

## Modes, Projects and authority

### Modes

Modes are server-enforced domain policy, not renderer flags. The shell shows Work and Code; Work presents the Chat and Work domains together, and nothing converts a thread between Chat and Work.

- Chat and Work can be switched off; Code is always on. Turning a mode off deletes no data.
- Chat binds a memory-scoped Project or none, Work one root, Code one directory and a checkout in it. Reaching outside the root asks below Full access, runs at Full access, and is refused in Plan (maintainer decision, 2026-11-14). Octant's sandbox holds commands to the root in Chat, Plan and Strict; otherwise the provider's own sandbox holds the level ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox)).
- Project memory belongs to one Project; moving it across Projects or modes is explicit and keeps provenance. [Person memory](#person-memory-across-projects) crosses Projects.
- Plan refuses Project memory writes. Below Full access, unless the Project's "Agents may write Project memory without asking" switch is on, a write waits for the person's confirmation in the thread; only a local window or a person-paired device sets that switch (maintainer decision, 2026-11-12).
- Only a person moves a thread to another Project of its mode whose folder is or contains its own; it keeps kind, history and level, gains no reach, is journaled, and is refused while a turn runs or the thread waits on the person.

Not built yet:

- The Project memory confirmation card on a paired device's turn: the device has no card for it, so the write is refused like a host-started turn's (`isPairedDeviceScope` in `projectMemoryAccess.ts`).

Status: Partly built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code) and [Project memory](../architecture.md#project-memory); [Workspace: Sidebar](workspace.md#sidebar).

### Projects pinned to the icon rail

A person can pin a Project to the icon rail as a tile that opens it, at most six.

- Pins are a saved shell preference by Project id; a pin for a missing Project is dropped only once the Project list is complete.
- Pinning grants nothing.

Status: Built. Since: 2026-11-11. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Project icons

A Project shows the icon a person chose, else the favicon or app icon in its own folder, else its letter tile or folder glyph.

- The host reads a short fixed list of paths with no walk, pattern or network; the renderer never reads disk. A found file counts only with no symbolic link below the Project folder, at most 256 KB, matching its extension.
- Only a window on this host that can reach the Project sets or removes a chosen icon; a paired device only reads. The host keeps its own copy and never reads the picked path again.
- The icon is served on the authenticated Project API with `nosniff` and a script-forbidding CSP.

Status: Built. Since: 2026-11-11. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Code starting posture and Plan

Code starts at the level picked at first run (Auto where the provider has a reviewer, else Ask first), changed in Settings › Code › Access or per Project. Plan is always read-only.

- Creating a Code Project may initialize Git; if that fails, creation is refused and nothing is journaled.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Chat has no filesystem or shell authority

Chat has no file or shell authority by rule. A Chat session runs on its per-thread scratch directory, and every provider approval request is declined.

- Runtimes launch with exec and fork denied, or with no execution environment; a write-only sandbox is not enough, because reads never escalate.
- Octant-managed tools (research, Canvas) run on the host and are unaffected.
- Chat loads the person's tool servers, skills and subagents when the provider [runs as itself](#key-providers-run-as-themselves), with no folder and no shell (maintainer decision, 2026-11-14). Its provider memory follows [Plan and Chat tool parity](#plan-and-chat-tool-parity).

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Person memory across Projects

Octant keeps a memory of the person beside Project memory, learned from threads and given to every new thread on every provider. It is on by default with no per-entry prompt; the person can turn it off.

- It reads only the title and the person's own messages, never answers, tool output or files; secrets are redacted before the call and before storage.
- Distillation calls are tool-less, on the thread's account unless Settings picks another, under the Project's provider rule and spend ceilings, and never fall over to another account (maintainer decision, 2026-11-25).
- `octant_remember_person` keeps only a quotation of a message the person typed in that turn, proven by the host's own mark; outside content can never create an entry (maintainer decisions, 2026-11-16 and 2026-11-25).
- Readers follow the thread's participation rules; a hub-roster device, a device paired below Full, and a peer-delegated turn never read it. Memory is never synced to a hub, spoke or peer.
- Settings › Memory lists, edits and deletes entries; deleting erases the events from the journal.
- Open risk: whether background calls on subscription sign-ins fit each provider's terms is unsettled; `personMemoryDistillationAllowed` is the seam where a per-provider answer lands, and it allows every provider today.

Status: Built. Since: 2026-11-01. Detail: [Architecture: Person memory](../architecture.md#person-memory).

### Default Projects

A Work or Code thread started without a chosen Project lands in the mode's default Project, provisioned under the default folder (`~/Octant` unless changed, always inside home) on first use.

- Host-native canonical and inside-home checks stay required whatever the wire spelling.
- Code offers its default Project only when "Code needs a Git repository" is off.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### SSH and remote machines

An agent reaches a remote machine with `ssh` through the thread's shell, in Work and Code. Octant stores none of the person's own SSH keys (it may keep a key it made for a server in the credential broker), writes no SSH config and adds no SSH transport.

- At Ask first, a thread's first connection to each host asks, naming the host, even where a remembered approval would cover the command.
- Shell egress follows [Network limits](../architecture.md#provider-runtime-network), which ship off.
- A Project may bind a folder on a registered server, in its own catalog. The connection refuses an unknown host key, forwards nothing, and fails closed with no local fallback.
- On a server no remembered approval covers a command, Octant claims no sandbox, and Octant's file tools refuse the secret guard's list at every level. Shield treats a server thread as having read outside content.
- A provider runtime placed on the server runs there on the server login's sign-in and the provider's sandbox; Strict refuses it (maintainer decisions, 2026-11-19 and 2026-11-20).
- The server dev-server panel is read only by a window on this computer (maintainer decision, 2026-11-20).

Not built yet:

- Running Claude Code or Codex itself on the server as the real CLI signed in there, with OpenCode, Pi and ACP agents still refused (maintainer decision, 2026-11-19): designed, not built ([Server Projects: Providers running on the server](server-projects.md#providers-running-on-the-server)).
- Stopping a child a recorded server program leaves behind: the sweep stops only the recorded program.

Status: Partly built. Since: 2026-10-31. Detail: [Server Projects](server-projects.md); [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Repositories, checkouts and file services

A repository is identified by a digest of its Git common directory, not a path. File, terminal, test and Git operations are server-owned services; panes are clients.

- Managed worktrees need their own confirmed grant and an ownership receipt, and are never silently reset or reused. Reading a worktree's changes runs nothing the repository configured.
- Rebinding a Code Project leaves old threads unavailable until a person rebinds them; a session Full access grant does not survive.
- A new Code thread's checkout choice creates nothing until the thread is created; starting in an existing worktree is not offered (maintainer decisions, 2026-11-14 and 2026-11-17). New branch names are derived locally; a model words one only on Suggest name, under the Project's provider rules (maintainer decision, 2026-11-25).
- Only a person switches an idle Code thread's branch, under the overwrite rules; nothing commits or stashes by itself, and no agent path exists (maintainer request, 2026-11-19).
- Archiving removes a managed worktree only when clean, delivered and idle; the branch always stays. Restorable cleanup is opt-in and deletes nothing off the recorded branch (maintainer decision, 2026-11-25).
- Removing other tools' worktrees is done by a local window or a person-paired device, never a hub-introduced device (maintainer decision, 2026-11-12).

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code); [Start screen](start-screen.md); [Workspace](workspace.md).

### Forks, checkpoints and restore

A fork is a managed-worktree creation the host resolves from a finished turn; a checkpoint is a marked point that copies no thread state, and restoring one forks. Threads rewind and fork rather than edit a sent message (maintainer decision, 2026-11-01).

- A fork starts approval-gated with no inherited profile, running turn or session grant, and is refused when its text handoff cannot be built.
- Chat has no edit control; its rewind covers the conversation only and grants nothing.
- Files return only from Octant's checkpoints, as an undoable restore. A rewind is refused while the thread's turn runs, and its files part while another thread writes on the checkout root.
- The phone rewinds files only at Full access; otherwise it rewinds the conversation only.
- Fork and rewind use the provider's own session copy where its runtime offers one, else a disclosed text handoff (maintainer principle, 2026-11-14).
- An in-place Git restore or discard is refused while another thread writes on the checkout root.
- A thread on its Project's shared checkout may move onto a managed worktree of its own, keeping its id and history and copying its uncommitted changes, which the source keeps (maintainer decision, 2026-11-26). The move revokes grants as a rebind does, refuses work a copy would leave behind, and an agent's request always asks the person from a local window; the next turn continues by a disclosed text handoff, and a one-click Discard of the copy in the source is not offered.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Outside content marks follow the content

A thread that reads outside content is marked, and the mark follows the content into any thread, Canvas or message that carries it.

- The mark and the thread commit in one journal unit; a mark that cannot be recorded refuses the creation or withholds the text.
- A source the person cleared passes nothing on. A Work-to-Code promotion starts unmarked, since no agent text crosses.
- A marked thread says so in its Environment panel and, below Full access, beside the mode control (maintainer choice, 2026-11-14; [Thread view](thread-view.md#outside-content-on-tool-rows)).

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Work promotion and the status file

Work never silently becomes Code: a promotion proposal is an offer, and only the person's approval creates the linked Code thread.

- A promotion moves focus and tooling, not authority; the new thread takes its own Project's level.
- A thread never moves from Code to Work; a person forks or starts a new one (maintainer decision, 2026-11-01).
- A Work Project may opt into a `STATUS.md`, off by default and refused for the default-folder Project.
- Octant never writes an agent brief into a user folder. Instruction files follow [Provider instruction files](#provider-instruction-files).

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Records of what a turn changed

A turn records an observation of what changed while it ran, never an attribution.

- Recording reads no file contents and never fails or delays a turn.
- The person may leave notes on a Code turn's changed lines and send them as one follow-up (maintainer decision, 2026-11-14; [Workspace](workspace.md#tool-lifecycles)).

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Thread plans

A thread's plan is its own journaled aggregate of ordered steps, at most one live per thread, proposed and approved whole.

- Approval names the exact revision read. Changing the level, leaving Plan included, never approves a plan.
- Steps become work only after approval.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Project scaffolds

A project scaffold is a curated catalog entry with a pinned generator, run as an ordinary approval-gated Code operation.

- The host composes the command line; an entry adds no flag, path or shell fragment. Plan refuses a scaffold.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Projects with several folders

A Work or Code Project has one main folder plus extra folders the person adds, each with the same access at the task's level. Code Git and checkouts keep the main folder.

- Only a person adds or removes an extra folder, through a folder-picker receipt, journaled; at most 16.
- An extra folder may be home only after the person confirms its warning; never a folder above home, a system or credential folder, or one nested in or around another root ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).
- Every sandbox, approval scope and tool grants an extra folder what it grants the main one; Plan reads without writing.
- The host honours an absolute path only inside a current extra folder; dropped folders are references that grant nothing.
- A task's folder identity cannot change in place; revocation cancels running work and refuses new effects without redirecting output.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Projects with several folders](../architecture.md#projects-with-several-folders).

### Plan and Chat tool parity

Plan writes nothing and Chat has no folder; inside them a provider keeps what it offers on its own: the person's read-only MCP servers, its memory read-only, processes on Linux, and attachments of any kind (maintainer decision, 2026-11-16).

- Only a person marks a provider's own MCP server "Read-only — allowed in Plan", from a window on this computer or a device they paired, journaled. A server's `readOnlyHint` is never trusted. Servers Octant connects to carry no mark; in Plan each call goes to the person ([MCP tool approvals](#mcp-tool-approvals)).
- Outside Strict a provider's memory loads in Plan and Chat on the account's setting; under Strict only a memory the session's tools write loads, read-only, so Codex's stays off (maintainer decision, 2026-11-21; `providerOwnMemoryLaunches`).
- Octant's gate refuses writes to Claude Code's memory files in Plan and Chat.
- A Linux Chat or Plan launch that starts processes keeps every confinement rule but the process filter; an unbuildable capsule is refused.
- Attachments go to an Octant-owned per-thread folder, never the Project, read-only at every level. Chat refuses a file it cannot carry before the turn (maintainer request, 2026-11-18).

Not built yet:

- The `readOnlyHint` pre-suggestion: Octant reads no provider server's annotations and its own servers carry no mark, so it has nowhere to appear.

Status: Partly built. Since: 2026-11-16. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority); [Provider runtimes: Key providers](provider-runtimes.md#key-providers); [Server Projects](server-projects.md).

## Agents and delegation

### Child agent runs

A child run starts only when the thread's agent delegates through `octant_agents`, the one child-run tool, and every child uses the same host admission, routing, workspace and lifecycle services.

- Subagent creation is one setting; the parent-child hierarchy is the only subagent surface. Delegation is refused while subagents are off or the session is paused, and Plan refuses it.
- Outside Strict reading outside content adds no ask ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)). Under Strict below Full access a marked thread asks once per thread; at Auto the person answers, not the reviewer, and a routine run refuses (maintainer decisions, 2026-11-13 and 2026-11-15).
- Under Strict a reply `wait` hands back marks the parent only when the child was marked; outside Strict, and for a delivered reply, it always marks (maintainer request, 2026-11-22).
- The host prepares the workspace; no client supplies a path, and wider-than-parent grants are refused.
- A helper takes its parent's Strict value, and its grant and answers follow [Subagent authority](#subagent-authority) (maintainer decision, 2026-11-25).
- A Full access thread's children have no time limit by default; under Strict the limit stays unless lifted (maintainer decision, 2026-11-25).
- Cancelling never reports completed until each process is confirmed stopped.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Choosing a subagent's route in a prompt

A person can name a subagent's exact route in the prompt with the `@model` chip of the `@` menu (maintainer decision, 2026-11-23).

- The tag only qualifies the subagent; the parent keeps its own model.
- An explicit route never falls back; the parent agent reports an unavailable route instead of picking another.
- A live check is owed: a maintainer runs one tagged subagent on a real provider and confirms the child's row names its provider, model and reasoning.

Status: Built. Since: 2026-11-23. Detail: [Thread view: Choosing a subagent model in a prompt](thread-view.md#choosing-a-subagent-model-in-a-prompt).

### Child approvals and results

A child approval permits only that request, and a child result implies no delivery, review, merge or deployment.

- A child approval never creates or consumes a remembered lead-session grant and cannot approve an opaque provider action in Plan. A paired device answers only managed requests of its own execution scope.
- Child results, routine runs and usage-limit resumes run as the host, never through a window.
- A steered result marks the parent first; a Code turn under the provider's own reviewer is never steered (maintainer request, 2026-11-15).
- Merging a run into the checkout is explicit, approval-gated and journaled, and refused when anything reviewed changed.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Messaging and sibling threads

Agent-to-agent messaging is a host-delivered channel, and seeing sibling threads its read-only companion, both in `octant_threads` (maintainer decision, 2026-11-05). Work and Code turns see their own Project's other open threads and may message them.

- Messaging never crosses modes or Projects (maintainer request, 2026-11-12); a refusal reveals nothing about another thread, and sending grants nothing.
- Reads mark the caller; delivery marks the recipient and frames the message as data. Bodies never enter the journal.
- Under Strict a turn's reads, waits and asks are capped by settings; outside Strict none is capped (maintainer decision, 2026-11-19).
- A message wakes an idle recipient only when a person at a local window turned its wake switch on, or as [Coordinator threads](#coordinator-threads) say, through ordinary admission within bounded rounds (maintainer requests, 2026-11-07 and 2026-11-13).
- Plan leaves messaging out. A non-empty profile allowlist must name `octant_threads.send` to send, so merging tools widens no allowlist.
- Work-to-Work messaging and wakes have not run against a real provider.

Not built yet:

- Messaging and wakes across a hub: built on one host only.
- A tagged Code thread messaging one on another hub member under that member's Message peer-grant item (maintainer request, 2026-11-07): designed, not built ([Hub and spokes: messaging between members](hub-and-spokes.md#messaging-between-members)).

Status: Partly built. Since: 2026-10-12. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Mentions and Side Chat

A `#thread` mention is a bounded, read-only view of a thread the sender can already open. Side Chat is a Chat-mode sidecar about exactly one source thread.

- A mention stores only thread ids, never titles, transcripts or authority (maintainer decision, 2026-11-25).
- `@file` completes only paths inside the bound root. An `@` or `/` chip never installs, trusts, enables or elevates anything, and the host re-resolves it at send.
- A Side Chat inherits no Work or Code authority and has no agent path to its source; a person may return a finished reply to the source's unsent draft, which never sends.
- Missing or corrupt provenance refuses admission.
- `octant_ask_thread` is offered only to a Chat turn that mentions a Chat thread, one hop, failing closed.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Coordinator threads

A person may make a Code thread a coordinator: a long-lived thread that starts worker threads, talks to them, and brings their requests to the person (maintainer request, 2026-11-10).

- Only a person makes or stops a coordinator, at a local window or a person-paired device, within Settings › Limits (maintainer decision, 2026-11-12).
- Outside Strict a coordinator's own actions follow its thread's level; under Strict they keep Plan's gate (maintainer decision, 2026-11-25). It is never Done.
- `start` is offered only to a current coordinator outside Plan; workers are never coordinators. Starting may be set to Propose for approval by a person.
- A worker's level is at most the coordinator's unless the person fixed it at creation; a marked coordinator's worker starts marked and takes Full access only outside Strict (maintainer decisions, 2026-11-12, 2026-11-13 and 2026-11-25).
- Bounds are journaled and set only by a person; hub-introduced or restricted devices are refused.
- A worker's approvals are answered only by the person through the worker's own path. The coordinator reads workers' child runs as facts only, and its agent gets none of them (maintainer request, 2026-11-11).
- Fallback moves a stopped worker to its role's next model at most once, with disclosure, and never moves person-started threads or a person's model choice (maintainer decision, 2026-11-15).
- Coordinators have not run on a real provider or the desktop app; those live checks are on the maintainer live-smoke list.

Not built yet:

- Work coordinators: a Work thread can message a sibling and be woken by one (maintainer decision, 2026-11-13), but the coordinator role, `start` and state notices are Code's.

Status: Partly built. Since: 2026-11-10. Detail: [Coordinator threads](coordinator-threads.md); [Workspace: Coordinators](workspace.md#coordinators).

## Boards, pull requests and delivery

### Thread boards and Done

Threads form one real hierarchy. Work and Code have server-derived boards; Chat has none. An agent never marks any thread Done.

- A Code thread is Done when its confirmed delivery target is met, or when a person marks it Done anyway (a journaled override Reopen clears). A Work thread is Done when a person marks it, which locks it on the host until Reopen. (maintainer request, 2026-11-12)
- A Work or Code lead outside Plan, never in Chat or a child run, may report itself finished with checks; the host runs them once at the thread's level and records a receipt only when they pass. Octant starts no turn and, outside Strict, sets no retry limit. (maintainer decision, 2026-11-19)
- A receipt marks the board card "Finished" without moving it; only a person's Done closes the thread.
- The boards are the bundled Board plugin; turning it off hides the views, while the status policy and projections stay.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code); [Workspace](workspace.md#boards-and-integrations).

### Pull requests from a Code thread

A Code thread may push its own branch and open, update and stack pull requests from it, through one journaled Octant pull-request tool.

- Only the Project's bound repository is touched, never another thread's branch. Plan and revoked forge access refuse every action. Octant stores no forge token.
- Force-with-lease on the thread's own branch is the default; a plain force-push needs a one-act approval that Full access does not replace. (maintainer request, 2026-11-12)
- A push to the default branch needs a one-act approval unless the Project's "Agents may push to the default branch" switch (off by default) is on; a force onto it always does. That switch and "Agents may comment on pull requests" are set only from a local window or a host-person-paired device and reread at every act. (maintainer decision, 2026-11-12)
- A watch needs no approval. Comments do not ask at Full access; below it the comment switch stands in for the per-post ask, except under Strict on a thread that read outside content.
- No agent or routine reviews a pull request; reviews are the person's, recorded on the head they read.
- At Full access a Harness command that merges, plain-force-pushes or touches another branch is refused before it runs. At Ask first and Auto, recognizable pushes and pull-request writes in the Harness shell are refused; a provider runtime's own push or `gh` write is an ordinary ask, which Octant Shield decides at Auto. (maintainer decision, 2026-11-14)
- What Octant only observes after the act is recorded, never presented as enforcement.
- A pull request the thread opens names each linked issue as fixed unless its body already does, and Merge when ready is only the person's to turn on (maintainer decision, 2026-11-26).
- The thread's agent reads its own pull request's failed CI logs without asking and reruns failed checks on the current head: a rerun asks below Full access, Plan refuses, and three reruns per workflow run on one head is the cap (maintainer decision, 2026-11-26). Neither reaches another thread's pull request.

Not built yet:

- Complete forge enforcement for arbitrary scripts and hidden targets: a shell command's real target cannot always be read.
- The default-branch push switch in the interface: hidden until an agent push path to the default branch exists; the server field and rule stay.
- The review pane's actions on a paired device: decided (2026-11-12), but the action-context read still answers 403 to a paired device.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Pull-request merge

A person merges an open pull request from its review. A Code thread's agent merges only with the person's approval for that one merge, at every level, or under a stored choice the person made.

- The server refuses a merge whose reviewed head is stale. Octant uses the host's forge CLI login and strips ambient tokens; every attempt is journaled.
- A paired phone or web client merges a pull request or a stack only with `confirmed: true` for the reviewed head and passing required checks; the authenticated device is the person. (maintainer decision, 2026-11-12)
- A stack merges bottom first and stops before anything merges when a layer is not mergeable; one that is not a single chain is refused whole. (maintainer decision, 2026-11-25)
- An agent skips the per-act ask only under the Project's Agents may merge switch or a routine's merge choice (reaching only threads its enabled run created), each set from a local window or a host-person-paired device and reread at the merge. (maintainer decision, 2026-11-12)
- An agent never merges on its own initiative. No plugin, hub or peer host merges.

Not built yet:

- Stack merge on the phone: only the web renderer offers it.
- Owner unlock (a host switch, off by default): decided, no code yet. When on, a hub-introduced client's merge, a stack merge and turning Merge when ready on need a fresh owner-device unlock.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Merge when ready and Auto-fix

A Code thread's pull request review carries two switches the person turns on: Merge when ready turns on the forge's auto-merge, and Auto-fix wakes one linked Code thread to fix failed required checks, unresolved review threads and base conflicts. A thread's agent may also watch its own pull request to be woken instead of polling. (maintainer decision, 2026-11-05)

- Only a local window or a host-person-paired device turns these on; a paired client turns Merge when ready on only with `confirmed: true` for the reviewed head. No provider, agent tool, plugin or routine reaches them. (maintainer decision, 2026-11-12)
- Merge when ready is the forge's own auto-merge on the head the person saw, never an Octant loop.
- Auto-fix wakes the thread through the routine follow-up path at the thread's own level, after marking it as having read outside content; a refused mark sends nothing. It never force-pushes or rewrites pushed history.
- A watch binds only the thread's own open linked pull request, needs no approval, fixes nothing, and is refused in Plan and host-started turns. (maintainer request, 2026-11-12)
- Attempts and wakes are bounded by [Octant's own limits](#octants-own-limits-become-settings); every switch change, watch change and wake is journaled.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Modes, Merge when ready and Auto-fix](../architecture.md#modes-chat-work-and-code).

### Second-model pull request reviewer

A bundled, switchable first-party plugin reviews pushed heads of linked Code threads' pull requests, only through the `pull-request-reviewer` seam and the host's review port.

- Off by default; enabled per Code Project with a per-thread override, and off until a model is picked. Its settings change only from a local window or a host-person-paired device.
- It runs at most once per pushed head at Plan's read-only gate, whatever the thread's level; a head that moves mid-run publishes nothing.
- Posting a comment and handing blocking findings to the worker are opt-ins, off by default. It never approves or requests changes. Under Strict hand-backs stop at Auto-fix's attempt limit; outside Strict there is no cap.
- It counts toward the parent's spend ceiling, and when unavailable it names the reason and never falls back to another model.
- A live maintainer smoke against a real repository with two signed-in providers is owed.

Status: Built. Since: 2026-11-20. Detail: [Architecture: Modes, Merge when ready and Auto-fix](../architecture.md#modes-chat-work-and-code).

### Delivery to targets the person owns

Octant runs no deployment infrastructure and offers no ship target of its own. Every target is an account, cluster, registry or store the person owns.

- A ship integration never receives a secret, only a purpose-scoped handle at use. A standing grant never replaces the per-act approval.
- A target may be a machine Octant creates in the person's own cloud account, shown as a Server Project the person suspends and resumes; an Octant-operated hosted service stays out of scope. (maintainer decision, 2026-11-14)
- A cloud machine target is a plugin contribution, offered once installed, trusted and enabled. Every machine act is the person's, at a local window, journaled; destroy needs one host-issued confirmation.

Not built yet:

- Delivery itself: no target source, build observer or per-act approval bound to target, revision and build is wired, so delivery stays out of the interface until all three are.
- A cloud machine target plugin, a per-machine key and wake-on-open: not written yet ([Server Projects](server-projects.md#machines-in-the-persons-cloud-account)).

Status: Partly built. Since: 2026-11-14 (cloud machines). Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Project planner thread

A Code Project may name one of its threads its planner, whose agent proposes new Code threads for a person to accept in the Project overview. [Coordinator threads](#coordinator-threads) are meant to take over this role; a coordinator's proposals use the same path.

- Only a person confirms or declines. A proposal executes nothing; the planner has no creation authority, and its tools are offered only to the named thread.
- A stale, refused or uncertain decision never starts or retries by itself, and one creation identity is journaled before creation so nothing is created twice.
- There is no phone or CLI mutation.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

## Routines and timed turns

### Routines

A routine is a host-owned, Project-bound definition that starts an ordinary thread or turn on a trigger. It can do nothing the thread it creates could not do.

- The dispatcher revalidates host, Project, binding, profile, provider, model and authority at every occurrence; a stale definition never adopts replacement authority.
- A routine runs as the host on an in-process timer; nothing runs in a cloud. An automation-origin turn cannot create, edit, run, pause or archive a routine.
- An agent only proposes; a person confirms. When the person's own message asked for the routine, the host creates it at once outside Plan, active outside Strict and paused under it; on a thread that read outside content the agent's word is not believed. (maintainer decision, 2026-11-25)
- An agent's own suggestion waits for the card below Full access; at Full access it is created at once, active unless the person turned that off. Follow-ups and Plan turns always wait. (maintainer decision, 2026-11-12)
- An agent may read its Project's routines and ask to pause or archive its thread's own; only the person's confirmation changes them. Resume, edit, run now and cancel stay the person's.
- A Work or Code routine may target a Project on a registered server at the same levels and approvals; only the host's own person sets that up. (maintainer decision, 2026-11-14)
- A Chat routine keeps Chat's authority and finishes when its turn settles.
- File and integration-event triggers deliver their input as framed external data, never as grants; held changes need the person's Review or Re-arm, and nothing re-arms by itself. Event triggers are set at a local window or a host-person-paired device. (maintainer decision, 2026-11-13)
- Native watcher, filesystem and live provider acceptance evidence is owed; controlled fixtures prove the rest.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Routine authority level

A Work or Code routine asks first unless the person opts it into its Project's level, Full access included, or picks a level on it, which is a ceiling: each run takes the lower of the pick and its Project's level.

- The stored execution profile is never Full access; a run reaches Full access only through the opt-in or a pick, read at dispatch.
- Only the host's own person sets the opt-in, pick and merge choice, at a local window or a device they paired; an agent-proposed routine never has them. A Chat routine has no level. (maintainer decision, 2026-11-12)
- A Code routine may merge the pull requests it opens when the person allowed it ([Pull-request merge](#pull-request-merge)).

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Follow-ups in the same thread

A follow-up is a one-shot routine that sends one scheduled turn into the thread it came from.

- The host re-checks the thread at fire time and refuses with a typed reason rather than adapt; it never runs twice or after archive or cancel, and survives a restart. (maintainer request, 2026-11-12)
- One missed or held runs once within the lateness limit (a setting), else fails without sending. (maintainer decision, 2026-11-21)
- Its turn runs as the host under routine ceilings; widening the thread never widens it.
- A Chat thread may have one, created only on the person's confirmation, with Chat's authority. (maintainer decision, 2026-11-21)

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Usage limits and stalled turns

A turn stopped by an explicit provider usage-limit signal carries a provider-neutral fact. Resuming at the reset is the person's per-thread opt-in, or their standing default (maintainer decision, 2026-11-26).

- Only a protocol signal makes the fact, never text matching; an unknown reset stays unknown, and a billing stop gets no resume or snooze.
- While the stop is the thread's latest turn, one strip above the composer names the provider, the limit and the reset, and offers Resume now, Resume at reset and Snooze until reset; no plan meters stand beside the composer (maintainer decision, 2026-11-26).
- The host settings Resume at reset by default and Snooze until reset by default are off by default. Each arms once per stopped turn, only for a reset still ahead on a turn the person sent from a local window or a device they paired; the resume still passes ordinary admission, and a cancelled default stays cancelled.
- A stalled or looping turn gets a quiet notice outside Strict and is cut off under Strict, per [Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on). Its settings change only at a local window or a host-person-paired device. (maintainer decision, 2026-11-13)
- Force stop kills only that attempt's process and leaves the thread resumable; a Stop naming a superseded turn is refused, and an unconfirmed Stop never invents an outcome.

Not built yet:

- Force stop on per-session-process providers other than Claude Code: Codex and OpenCode declare `forceStop: "unsupported"`.

Status: Partly built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Wake-ups the agent schedules

A wake-up a thread's agent asks for (Claude Code's `ScheduleWakeup` and `CronCreate`) is Octant's from the moment it is asked for; the runtime's scheduler never holds it, so nothing fires in a session Octant does not see. (maintainer decision, 2026-11-14)

- A wake-up call meets the gate (asking below Full access) and reaches only the thread's own wake-ups.
- At its time the host starts a turn as the host through ordinary admission at the thread's level; a busy thread holds it.
- A missed one runs once on return, unless the person turned that off. (maintainer decision, 2026-11-25)
- Cancel is the person's, from a local window or a host-person-paired device. Bounds follow [Octant's own limits](#octants-own-limits-become-settings).
- Work and Code outside Plan only; Chat is never offered the tools.

Status: Built. Since: 2026-11-14. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code) and [Provider runtimes: Wake-ups the model schedules](provider-runtimes.md#wake-ups-the-model-schedules).

## Transcript records

### Agent task display and tool-call records

The agent's plan panel and tool-call groups are projections of journaled state, never renderer-owned plans.

- Chat and Work record each tool call as a redacted step, never the whole list, up to the tool-step limit, which is a setting (maintainer decision, 2026-11-13).
- The event budget follows the tool-step limit and stops a Work or Code turn only under Strict (maintainer decisions, 2026-11-14 and 2026-11-25).
- Tool-call records are redacted before storage, never journaled, and fail closed: output is kept only when the whole input was judged and named no protected file (maintainer request, 2026-11-12).
- A local window or person-paired device reads records; hub-introduced devices keep remote-device limits (maintainer decision, 2026-11-12).

Not built yet:

- Records for Codex, ACP, OpenCode and Pi's own tools: those runtimes report no input or output.
- The paired-device screen for reading records: a follow-up; the server policy is in place.

Status: Partly built. Detail: [Architecture: Tool calls in Chat and Work](../architecture.md#tool-calls-in-chat-and-work) and [Architecture: Agent task display](../architecture.md#agent-task-display).

## Persistence

### Event journal and projections

The event journal is the authoritative record; projections are rebuildable and idempotent. One local database file under the data directory is created owner-only.

- A stale command writes nothing, and a projection never leads the journal.
- Every commit survives a process crash; an OS crash may lose the newest commits, never tear one. (maintainer decision, 2026-11-14)
- A turn's streamed output is bounded; past it the turn keeps what was journaled and ends with a truncation marker. (maintainer decision, 2026-11-14)
- A write failing on a full disk commits nothing and says the disk is full.

Status: Built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Quarantine and migrations

Unreadable events and unsafe migrations fail closed. Octant never skips an undecodable event and reports current.

- A failing authoritative projection rolls back the append; only a view nothing decides from may fail alone.
- Only a successful rebuild retires quarantine. Ambiguous recovery state resolves to waiting or recovery-required, never healthy.
- Migrations are ordered, forward-only, checksum-verified and applied after a store backup, before ready.

Status: Built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Recovery after a restart

A restart recovers what the journal can prove and never guesses that an ambiguous outcome succeeded.

- Work that may have reached a remote stays ambiguous and keeps the thread Waiting; unconfirmed steps settle only from the remote's own answer, never by guess.
- An unconfirmed update or merge stays so until the person at a local window marks it resolved; no agent or paired device can. (maintainer request, 2026-11-13)
- Outstanding approvals are recovered; a parked provider question settles interrupted.
- Removing a host on the phone sends nothing to the host, so it does not revoke the device.

Status: Built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Recovering after a crash without the terminal

After a crash or reboot the host repairs what it safely can and says what is wrong. Nothing needs the `db:*` commands.

- Projection-only damage over a sound journal rebuilds at startup, at most once per start. Journal damage refuses the start and leaves the journal unchanged.
- The desktop recovery screen offers only what the refusal allows; restoring a backup needs a separate confirmation.
- Running in the background and opening at login are off by default and change only from Octant's desktop windows.
- A process a restart ended offers a one-click restart, an ordinary start checked against current authority, with no grant the old process held. Extensions get no restart button. (maintainer decision, 2026-11-25)
- Crash records are local and redacted, and leave only in a support bundle the person saves; native crash dumps are never collected.
- A real Mac install and uninstall is a maintainer check still owed.

Status: Built. Since: 2026-11-12. Detail: [Architecture: Process topology](../architecture.md#process-topology) and [Persistence](../architecture.md#persistence).

### Continuing a turn a restart cut off

After a crash, force quit or reboot, the host continues each turn the restart cut off, once, as the host. It is on by default with a setting and a per-thread opt-out, and a thread whose external action may have been in flight waits for its person. (maintainer decision, 2026-11-12)

- The switches change only at a window on this computer or a device its person paired; hub-introduced devices and agent grants are refused. (maintainer decision, 2026-11-12)
- The thread waits instead when the outcome of a remote step or a may-change tool call is unknown, the provider cannot resume, or two continuations were cut off. The host never reruns a tool call. (maintainer decision, 2026-11-12)
- A tool only waiting for approval does not hold the thread. (maintainer request, 2026-11-22)
- After a deliberate quit nothing continues. Each continuation rechecks authority, posture and spend through ordinary admission. (maintainer decision, 2026-11-12)
- A packaged-app `kill -9`, quit, system restart and Windows session end are maintainer live checks still owed.

Not built yet:

- A runtime's own tool whose start the host had not read: unprovable either way, so the turn continues.
- A terminal-started Browser session and a saved Browser flow's run: they sit outside any turn and write no record.
- Asking again a Chat answer waiting on a question or approval at the restart: it is still settled interrupted when answered.

Status: Partly built. Since: 2026-11-12. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Snapshot-first thread reads

A thread paints from an authoritative snapshot before auxiliary observations begin, and reads stay off the full journal.

- Threads open on their newest turns; the journal stays complete, and totals read the whole thread.
- A running turn's latest step is memory-only and redacted, never journaled.

Status: Built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Outside-content taint

Browser observations, tool results and imported content append a journaled mark with bounded source labels, never raw bodies. The mark lasts the thread's lifetime.

- Irreversible or authority-bearing actions on a marked thread need fresh confirmation, even after replay.
- At Full access in Work and Code the mark is recorded only; a person turns it down per thread, or for a Project's new threads, by setting that level.
- A provider runtime's own web tools mark the thread; a mark that cannot be recorded stops the turn.

Not built yet:

- Showing the mark on a paired device: only a local window draws it today.

Status: Partly built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Clearing a taint mark

Only a person, at a local window or a device the host's own person paired, clears a thread's mark, recording that they reviewed what it read. (maintainer decision, 2026-11-12)

- The server refuses every other caller, the host's own scope included. No tool, command, model output, agent message or host-run turn can clear.
- A clear removes the mark only; nothing leaves the model's context, and the next ingestion marks again.
- It is refused while a turn runs or is queued, and at a stale version.

Not built yet:

- Clearing from a paired device's screen: the server admits a host-person-paired device, but no paired client shows the mark or offers the clear.

Status: Partly built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Data lifecycle, exports and diagnostics

Reset, remove, delete-host, retention and purge are explicit, reported per scope, and never implicit. A retention window never deletes by itself.

- Only a confirmed purge erases a thread's content; a tombstone stops a rebuild from restoring it.
- A host-person-paired device sets retention and purges as a local window does; a hub, peer host or agent grant cannot. (maintainer decision, 2026-11-12)
- Startup journal compaction and the completed-thread archive sweep are the only self-applying exceptions.
- Exports carry no secrets, filesystem paths or raw provider payloads, and name what they omit.

Status: Built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Artifact mirror and replicas

The mirror writes plain files for people and tools and never pushes to Git. Replicas are append-only, signed, write-once logs in a store the user owns.

- Optional auto-commit is off by default, commits only the files it wrote, and refuses when other work is staged.
- The mirror route answers a local window or a host-person-paired device and refuses others. (maintainer decision, 2026-11-12)
- Each host writes only its own entries; an import never adopts another journal or overwrites a version. Credentials and absolute paths never leave.
- With sync off, no store, or Plan, no store call is made.

Not built yet:

- The mirror in paired clients: the server admits a paired device, but no paired client offers it yet.

Status: Partly built. Detail: [Architecture: Persistence](../architecture.md#persistence) and [Artifact replica sync](artifact-replica-sync.md).

### Composer drafts and the message queue

Unsent drafts stay on the client that typed them. Messages sent while a turn runs go into a host-owned ordered queue shared by Chat, Work and Code; in Work and Code it steers them into the running turn where the runtime steers.

- Drafts are not journaled or sent until the person sends; deleting or purging the thread removes them.
- Every dispatch rechecks authority through ordinary admission. Changed authority, uncertain delivery, a cancel and a Work Done mark hold the queue until a person resumes it. (maintainer request, 2026-11-12)
- A paired device queues on a thread it may send to and edits its own; one the host's own person paired at Full manages the whole queue. (maintainer decision, 2026-11-13)
- A steered message is a user message of its turn everywhere it is carried. (maintainer decision, 2026-11-21)
- The phone's Work and Code composer queues a follow-up while a turn runs and lists, edits and removes waiting messages (maintainer request, 2026-11-26).
- A quote from a reply, a terminal or a file is one chip held as the prompt's own text, framed as reference, not instructions; only a quote Octant wrote in the window is a chip, and pasted quote-shaped text stays plain (maintainer decision, 2026-11-26).
- A large paste attaches as a text file where the composer takes files, and ⌘⇧V pastes it inline (maintainer decision, 2026-11-26). The Chat start screen keeps it as text, since a first Chat message needs words for its title.
- ArrowUp in an empty thread composer recalls the person's own sent prompts in that thread, newest first.
- On the Code start composer, ⌘↩ starts the thread in the background and keeps a fresh draft, and one prompt may start on up to four models, each an ordinary create in its own worktree (maintainer decision, 2026-11-26).

Not built yet:

- Send now in the phone's queue: the phone lists, edits and removes queued messages but does not offer it yet.
- Start and stay on the Chat and Work start composers: built for Code first.

Status: Partly built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Local diagnostics export

A person can export a local diagnostics bundle to share by their own choice. Octant sends nothing by itself and keeps no telemetry.

- The bundle is written locally and leaves the machine only when the person sends it.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Persistence](../architecture.md#persistence).

## Providers

### Provider layer and honest capability

Every provider reaches Octant through the provider SDK, and every driver reports what it can do per mode and model. The server disables what is unsupported instead of emulating it.

- A driver passes the shared conformance harness before it is selectable. Provider wire payloads stop at the adapter.
- Every capability starts unavailable until proven. An adapter may narrow Octant's session authority, never widen it; provider permission callbacks are signals, not a sandbox.
- A runtime that does not carry Octant's tools is offered neither Browser nor Computer.
- Bounded provider subprocesses run under a deny-default OS sandbox; a missing backend fails closed as incompatible.

Status: Built. Detail: [Architecture: Providers](../architecture.md#providers).

### Provider-hosted Code jobs

A local Code thread can associate a separate, immutable, text-only remote job with an endpoint opted in on its own. Local checkout, tools and thread authority stay unchanged.

- Each submission needs consent to its exact input and to its cost and execution.
- An unknown submission is never retried automatically, and cancellation is only requested. Required spend ceilings refuse.

Not built yet:

- Other wire protocols than the OpenAI Agents codec, and automatic file or patch transfer: not implemented.
- Proof of account eligibility, provider sandbox enforcement and billing: needs a live check; local synthetic and rendered checks do not prove them.

Status: Partly built. Since: 2026-11-04. Detail: [Architecture: Provider cloud jobs](../architecture.md#provider-cloud-jobs) and [Provider runtimes: Provider cloud sessions](provider-runtimes.md#provider-cloud-sessions).

### Provider instances and accounts

Providers are multi-instance. A thread stays on its instance until the person moves it, now or through their per-thread usage-limit opt-in. A thread a person started never moves on its own: no silent, unchosen or open-ended failover, rotation or load-balancing between accounts (maintainer decision, 2026-11-14).

- The host moves only a coordinator's worker, down the role's list the person ordered, at most once, as a disclosed provider change ([Coordinator threads](#coordinator-threads); maintainer decision, 2026-11-15).
- Two instances of one driver never share a state directory. Deleting a removed account's directory is the person's step.
- A Claude Code or Codex account signs in with its provider's unmodified CLI command; Octant never reads, stores or injects the login (maintainer request, 2026-11-17).
- Plan usage comes only from the provider's own process; Octant never calls a first-class provider's usage endpoint or reads its credential files ([Account usage reads](#account-usage-reads)).
- **Move to account** is the only path for a same-provider account change, and only the person takes it, never while a turn runs or the model pool is on (maintainer decision, 2026-11-17). **On usage limit, hand off to** is a per-thread opt-in only the person sets.
- The model picker, the add-account wizard and the usage rings are owned by [Thread view](thread-view.md#model-picker), [Additional CLI accounts](model-endpoints.md#additional-cli-accounts) and [Workspace](workspace.md) (maintainer requests, 2026-11-14 to 2026-11-25).

Status: Built. Since: 2026-11-14. Detail: [Architecture: Providers](../architecture.md#providers).

### Provider credentials and sign-in

API keys live in the host credential store and are reached only through the loopback credential broker by opaque reference. Octant never reads, stores or injects a CLI provider's own credentials.

- Secrets never reach the renderer, journal, logs or diagnostics. A host with no usable secret store stores nothing, with no fallback.
- Sign-in is delegated (tokens stay with the runtime) or host-driven (tokens stay in the broker). An API-key path stays beside every sign-in.
- Changing an endpoint's base URL, or switching between a key and a sign-in, deletes the stored credential first.
- The broker signs only inside the scope stored at sign-in; the server never holds a signing key. Linked secret stores are resolved at use, and Octant keeps only the store name and item address.

Status: Built. Since: 2026-10-26. Detail: [Architecture: Providers](../architecture.md#providers) and [Enterprise provider identity](enterprise-provider-identity.md).

### Provider catalog, discovery and outside drivers

The provider catalog lists only bundled driver manifests under a closed schema. Discovery registers runtimes without installing or changing anything. Outside drivers enter only through their own quarantined lifecycle.

- A catalog entry claims no install, trust, enablement, credential or capability; opening it starts nothing.
- Discovery never installs, updates or toggles an existing instance; an update runs only on the person's click.
- Outside drivers are installed held from a local folder and trusted at a digest, with the publisher key pinned at first trust ([Linux parity for provider tools](#linux-parity-for-provider-tools)).
- A bundled driver can be withheld (maintainer decision, 2026-10-29); none is (maintainer decision, 2026-10-31). Legacy "Codex CLI" and "OpenCode CLI" names are renamed once (maintainer decision, 2026-11-14).

Status: Built. Since: 2026-10-26. Detail: [Architecture: Providers](../architecture.md#providers) and [Outside provider drivers](outside-provider-drivers.md).

### Project provider policy and data tags

A Project allows all providers, a list of instances, or an EU or zero-retention tag policy. The host checks it before every Work and Code turn and handoff, child runs included.

- Data tags are labels the person maintains, not verified residency or retention.
- Renderer filtering is advisory and cannot grant what the host refused.

Status: Built. Detail: [Architecture: Providers](../architecture.md#providers).

### Image generation and voice

Image generation is a journaled job with exactly one profile. Voice is an app-managed capability riding one enabled compatible-endpoint instance. Neither grants Chat filesystem authority.

- Offers for paid outside calls share one host-held card, answerable only at the local window or person-paired device whose turn asked. Needs you and the Inbox find the thread without granting answer authority.
- An agent generates an image only through that card, never in Plan or a Side Chat (maintainer decision, 2026-11-07). A kept choice is journaled per Project. At Full access the card is skipped where the Project holds a choice or a profile is ready (maintainer request, 2026-11-12; [Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)). A kept choice the host can no longer run is asked again (maintainer decision, 2026-11-12).
- Reference images reach the provider only after the person confirms the named sources, even at Full access or with a kept choice.
- A safety refusal is never retried elsewhere. The journal holds attachment references and a prompt hash, never image bytes or prompt text. A credential goes only over HTTPS to hosts the driver declares.
- Saving an image never overwrites, and a Code thread in Plan saves none (maintainer decisions, 2026-11-22 and 2026-11-23).
- Dictation and read-aloud persist nothing. Speech synthesis stays host-only; a paired device can confirm a narration offer, so the host writes the file (maintainer requests, 2026-11-24 and 2026-11-25). An agent's transcript enters as outside content.

Not built yet:

- "Ask again" from a paired device: today only a window on the host takes a kept image choice back.

Status: Partly built. Since: 2026-11-07. Detail: [Architecture: Providers](../architecture.md#providers) and [Settings](settings.md).

### Video generation

Short clips run as a journaled job through provider-neutral video driver plugins on the person's own keys, following the image rule for asking, with the price on the card (maintainer decision, 2026-11-22).

- Drivers plug into the provider SDK's `videoGeneration` seam through the plugin-host activation ladder; the host builds card, price, limits, spend and storage from what each model declares. Other providers than the first-party three are left to plugins (maintainer decision, 2026-11-22).
- A runtime's own native media output shows with no Octant gate.
- Thread and Project spend ceilings apply, and a model is offered only at combinations it has a rate for.
- A clip Gemini reported usage for but that never arrives settles at that usage, else the estimate; a reported count that is not a finite amount of at least zero settles at the estimate (maintainer decision, 2026-11-26).
- Clip bytes are served on a ticket that rechecks thread authority and the device's session on every request.
- Real-provider runs, physical phone playback and packaged download are maintainer live checks still owed.

Status: Built. Since: 2026-11-22. Detail: [Video generation](video-generation.md).

### Provider reach Octant no longer narrows

Octant does not narrow provider reach the provider itself allows (maintainer decision, 2026-11-16).

- **Ollama:** a local-network or hosted address is allowed, plain HTTP only to a private-network address, with a warning.
- **Bedrock signing:** "Use my AWS profile" and long-lived access keys (behind a warning) are offered at a local window or a device the host's own person paired, never a hub-introduced or restricted device (maintainer requests, 2026-11-18 and 2026-11-19). Assumed credentials stay in broker memory only.
- Outside Strict, runtimes on Bedrock read the person's AWS profile and environment directly; Octant does not resolve, copy or replace them.
- **Releases:** [Provider releases are ranges, not pins](#provider-releases-are-ranges-not-pins).

Status: Built. Since: 2026-11-16. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority) and [Model endpoints: Amazon Bedrock](model-endpoints.md#organization-sign-in-amazon-bedrock).

### Provider releases are ranges, not pins

A provider's compatibility is a range that refuses only known-broken releases. No live probe has to precede an agent shipping (maintainer decision, 2026-11-21).

- A feature reviewed on named releases is kept on them and every later release, marked unverified on a later unreviewed one.
- Only a profile's listed broken releases are refused, with a sentence naming the release. A floor stays only where it is the earliest probed release or a protocol requirement.
- OpenCode's isolation attestation keeps its exact releases, since it proves launch confinement.

Status: Built. Since: 2026-11-21. Detail: [Provider runtimes: Probe before a profile ships](provider-runtimes.md#probe-before-a-profile-ships).

### Linux parity for provider tools

Octant's tools reach OpenCode and ACP agents on Linux as on macOS, and outside provider drivers run on Linux (maintainer decision, 2026-11-16).

- An outside driver on Linux takes the same install, trust and enablement steps and runs unconfined, labelled so, until Linux extension-process confinement exists. Windows stays `host-prohibited`.
- Strict keeps an outside driver `host-prohibited` on Linux, read at each listing, admission and use ([Windows below Full access](#windows-below-full-access)).

Status: Built. Since: 2026-11-16. Detail: [Provider runtimes: What an ACP agent cannot do](provider-runtimes.md#what-an-acp-agent-cannot-do) and [Outside provider drivers: Maintainer decisions](outside-provider-drivers.md#maintainer-decisions).

### Pi runs as itself

Pi, which is not a key provider, runs as it does on its own by default (maintainer decision, 2026-11-14).

- Work and Code load the person's own Pi skills, prompt templates and context files at every level, and their extensions outside Plan. Plan keeps read tools only, and Chat keeps no tools.
- Outside Strict, in Work and Code outside Plan with no Octant sandbox, Pi runs on the person's real home with its own discovery on (maintainer decision, 2026-11-25). Strict, Chat, Plan and a sandbox keep the managed home.
- Octant's approval bridge asks, by the thread's level, for every extension tool but the known reads and Octant's own.

Not built yet:

- An account or thread switch for Pi: it needs Pi in the key provider contract.

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: Pi](provider-runtimes.md#pi).

## Context and usage

### Context planning and model windows

Every request passes through one Octant-owned context planner before it reaches a model, and a model's window is found without asking the person.

- An adapter never appends unaccounted context, and a turn that does not fit the safe budget is not sent.
- Safety, authority, approvals, the current request and pinned content are never removed silently; if they cannot fit, the turn is blocked with remedies.
- An absent limit is unavailable, never unlimited, and a fallback estimate is never shown as the real window.
- Context commands and inspection need a local window that can open the thread or Project, or a host-person-paired device under the same rule. (maintainer decision, 2026-11-12)

Status: Built. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Provider capacity

One in-memory scheduler admits every Chat turn, managed child, automation and compaction against each provider instance's limits. Only a capacity answer backs a provider off.

- A refused request, rejected credential, unreachable endpoint or spent usage limit is not a capacity answer; the turn fails with its own cause.
- A waiting child holds no slot or session, and one whose parent drifted in authority ends Interrupted. (maintainer request, 2026-11-12)

Status: Built. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Turn metrics and spend ceilings

Every runner feeds provider events to one pure policy that times turns and journals full usage. Optional Project and thread spend ceilings gate admission.

- Octant never shows a zero or rate it did not measure.
- Ceilings are refused at admission, and child spend counts against the parent's ceilings.
- Unpriced usage refuses a money ceiling as unknown spend, and billed image generation reserves its cost first. (maintainer decision, 2026-11-21)
- Cost is fixed when usage is journaled, so history is never re-priced.

Status: Built. Detail: [Architecture: Stop reasons](../architecture.md#stop-reasons) and [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Local usage history

Local provider history is a read capability of the provider SDK; quota windows are a separate provider-reported snapshot.

- History never reaches model tools or remote clients, and malformed input makes coverage partial, never a false zero.

Status: Built. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Compact session

Compact session replaces what the model sees with a summary and a recent tail, when the person asks or a rule they set asks, always outside a turn. It never deletes or rewrites the journal.

- The conversation's owner compacts; Octant refuses where the runtime cannot.
- The command needs a local window that can open the thread or a host-person-paired device, and needs no tool approval. Plan stays allowed and read-only. (maintainer decision, 2026-11-12)
- A compaction never clears taint, counts against the Project's ceilings, and never starts a replacement session behind the person's back.
- A compaction against a real runtime is a live check still owed.

Not built yet:

- Compacting a server thread's conversation: the Code runtime opens no compaction session for a `remote-root` checkout.

Status: Partly built. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Automatic compaction rules

Octant compacts a thread by itself only under a rule the person set in Settings. Each runs the same compaction as Compact session.

- A rule meets every refusal a window meets; a refused rule leaves nothing behind.
- A rule never switches provider; the person picks the next model.
- Shares reach a runtime as a per-session setting, never in the person's files.
- Each rule on a live runtime is a check still owed.

Status: Built. Since: 2026-11-07. Detail: [Automatic compaction](automatic-compaction.md).

### Held standing context and resume

A provider that keeps its own conversation is sent standing context once, and resume is bound to a durable identity.

- Standing text never varies by turn, and context never moves into a system prompt or tool list, so cached prefixes hold.
- A rule about an app tool reaches only a session that can call it.
- Resume refuses as stale when its binding names another instance, session, Project root, mode or native id; one process at most owns a native session.

Status: Built. Detail: [Architecture: Held standing context](../architecture.md#held-standing-context) and [Architecture: Stop reasons](../architecture.md#stop-reasons).

### Handoffs between providers, forks and branches

When a conversation moves to a new session, the new provider gets a bounded, disclosed text handoff and never resumes the old session. The exception is a move to another account of the same provider that can carry the session ([Provider instances and accounts](#provider-instances-and-accounts)).

- The handoff is journaled before the prompt. Hidden reasoning, tool activity and the old native session never transfer.
- A missing, changed or revoked original input refuses the send; Chat gains no filesystem or shell authority.
- A switch that cannot hand over refuses before the provider starts, naming why.
- Merging a fork back is explicit and context-only; file changes reach the source only through Git review, and the fork's outside content taints the source.

Status: Built. Detail: [Architecture: Stop reasons](../architecture.md#stop-reasons) and [Thread view: Context handoffs](thread-view.md#context-handoffs).

### Stop reasons

A completed event carries a stop reason only when the runtime says why the turn ended.

- Absence is never guessed into a reason.
- A turn cut off at the output limit offers Continue, which sends nothing until the person does.

Status: Built. Detail: [Architecture: Stop reasons](../architecture.md#stop-reasons).

### Octant instructions

A person writes instructions for Octant itself, beside each provider's own instruction files: one for the person, an optional one per Project, and an orchestration text for coordinator threads. (maintainer request, 2026-11-14)

- On how a provider works, its own files come first.
- Octant never writes them into a file a provider reads or replaces a provider's system prompt.
- They grant no authority, stay on this host, and change only from a local window or a host-person-paired device.

Status: Built. Since: 2026-11-14. Detail: [Octant instructions](octant-instructions.md).

### Provider instruction files

Claude Code reads the person's and the Project's `CLAUDE.md` files in Work and Code, Strict included, either by itself or through Octant. (maintainer decision, 2026-11-14)

- Where a setting source is off, Octant reads them as text with no authority and appends them to Claude Code's own system prompt; where it is on, Claude Code loads them and Octant adds nothing.
- The files are bounded and never read through a symlink or import outside their folder. Secret-guarded files are skipped below Full access, and the account's own sign-in files at every level.
- Under Strict the Project's settings, hooks and `.mcp.json` wait until the person allows the Project's code ([Adding a Project trusts it for every agent](#adding-a-project-trusts-it-for-every-agent)).

Status: Built. Since: 2026-11-14. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

## Native harness

### Harness loop and endpoint port

Direct-endpoint providers run under the native harness, which owns the agent loop and the conversation. Drivers supply only a transport, through the provider SDK endpoint port.

- A model is offered Octant's tools only after tool verification passed; verification is a probe, not a grant, and never blocks the turn (maintainer request, 2026-11-12).
- The conversation is journaled step by step. Resume closes interrupted calls as safe or unsafe to replay; nothing is silently re-run.
- The harness never parses prose as a tool call; anything unknown or unoffered fails closed.
- Context reduction never changes the journal, and the goal and its criteria are restored after it.

Status: Built. Detail: [Architecture: Native harness](../architecture.md#native-harness).

### Harness tool authority and taint

Every harness tool call is authorized under the thread's current authority before any port runs, and outside content taints the thread.

- A call is judged by the narrower of the thread's stored posture and the turn's.
- A direct-endpoint request goes only to the configured base URL, with no redirect. Web fetches refuse private destinations and carry no credential.
- On a tainted thread, effectful tools need single-use confirmation and remembered approvals stop covering them; at Full access in Code the taint is recorded and nothing asked.
- Under Strict, a tainted thread's search query that looks like it carries data is refused, except at Full access in Work and Code; outside Strict it goes and the mark stays (maintainer decision, 2026-11-21).
- The lead's `skill` tool never installs, trusts, enables or activates a skill.

Status: Built. Detail: [Architecture: Native harness](../architecture.md#native-harness), [On-demand skills](../architecture.md#extensions-and-skills) and [Search queries on a tainted thread](search-query-taint.md).

### Harness retries, routing and fallback

Direct-endpoint requests follow one retry policy, and models are chosen by routing slot.

- A request retries only while nothing has streamed; a failure after output streamed never moves the turn.
- A role may hold any enabled provider's model; one the harness cannot run is skipped (maintainer decision, 2026-11-15).
- Suggestions never change a role without a person's acceptance, and only a person changes a role or its per-Project override, journaled (maintainer decisions, 2026-11-15 and 2026-11-19).
- The advisor may cancel, redirect or pause, never run tools, edit files or grant approvals.

Not built yet:

- The harness resolver reading **Ask before using** and **Continue on the fallback if the model stops**: they are stored values only, and harness helper runs keep their own fallback.

Status: Partly built. Since: 2026-11-15. Detail: [Architecture: Native harness](../architecture.md#native-harness) and [Model endpoints: Model roles](model-endpoints.md#model-roles).

### Sees images

The Sees images role describes an image in words for a thread whose model cannot read images, and the host decides where an image may go (maintainer decision, 2026-11-15).

- The job skips a model outside the Project's provider policy or data rules, and an empty role is off, never falling back to the Builder.
- Each describe is admitted under thread and Project spend ceilings before the image is sent; an answer that read outside content is dropped.
- A person's own image adds no outside-content mark; a marked thread stays marked.
- A run against a real provider is a maintainer live check still owed.

Status: Built. Since: 2026-11-15. Detail: [Architecture: Sees images](../architecture.md#sees-images) and [Model endpoints: Model roles](model-endpoints.md#model-roles).

### Harness sessions, goals and steering

One journaled session per thread is the only state, read and changed by every surface through one route. A person redirects running work only through ordered steering notes and version-checked goal revisions.

- After a restart, a session with an open turn or pending approval admits nothing until a person resumes it, unless the host [continues a turn a restart cut off](#continuing-a-turn-a-restart-cut-off) (maintainer request, 2026-11-12).
- The lead's approvals and questions wait, without expiry, for an answer, the turn's stop, or the thread's archive or deletion. Only under Strict, at most 32 approvals and 32 questions wait at once across the host, and a Strict thread's ask past that is refused at once; outside Strict nothing caps them (maintainer decision, 2026-11-26; [Octant's own limits become settings](#octants-own-limits-become-settings)).
- The host validates an answer against the journaled ask and accepts it once (maintainer decision, 2026-11-24).
- A goal completes only on a criterion check's evidence or a person. A loop over budget waits for a person, and an effect needing an approval no person can give suspends it, never auto-approved.
- The terminal flow (maintainer decisions, 2026-11-22) has fake-provider coverage. A real signed-in provider flow, and the live evidence real-provider parity needs, are maintainer live checks still owed.

Status: Built. Detail: [Architecture: Native harness](../architecture.md#native-harness) and [Workspace: Inline questionnaires](workspace.md#inline-questionnaires).

### Follow-up suggestions and side tasks

Follow-up suggestions and side tasks are journaled offers that grant nothing, from every provider.

- A confirmed follow-up goes through the mode's ordinary creation command; the prompt is never sent for the person.
- A side task starts only on the person's click; a Code thread still starts approval-gated. A planner's board offer is a proposal only a person confirms.
- An uncertain "Do it here" delivery stays visibly unconfirmed across restart, never retried.
- A side-task child's reports reach the parent only as queued turns recorded as outside content, never duplicated or dropped.

Status: Built. Detail: [Architecture: Native harness](../architecture.md#native-harness) and [Settings](settings.md).

### Harness tool egress rules

A harness command on an approval-gated or auto-accept-edits Code thread reaches exactly the destinations a person allowed for that thread, through a per-launch host proxy.

- `proxied` never falls back to open network, and the proxy refuses private destinations under every rule.
- Rules arise only from answering a network-access approval, never from a model, tool result or repository configuration. Project rules need a person at a local window. Rules never leave the host.
- Taint suspends standing rules. Learn mode turns refusals into proposals that grant nothing.

Status: Built. Since: 2026-10-13. Detail: [Architecture: Harness tool egress rules](../architecture.md#harness-tool-egress-rules).

## Extensions

### Activation ladder and executable components

A component is active only when its package is installed, its source trusted, the master and component switches on, compatibility passes and policy allows. Any other state contributes nothing.

- Install, trust and enable are three journaled steps: `enable` without `trust` is refused, a refused trust turns nothing on, and a switch never lifts a hold for review or admission.
- For a new install, one confirmation may cover install, trust and turning on a plugin or connector and its components, and a skill or server the person adds directly; Add only keeps the steps apart (maintainer decisions, 2026-11-12 and 2026-11-13).
- Every signable package kind is verified, its key pinned at first trust; a version the pin did not sign is held (maintainer decision, 2026-11-13). An update signed by the same key, or an unsigned update from the source the person trusted, keeps trust and remembered approvals; a new or missing key, a wider update and a first signed update of an unsigned package ask again (maintainer decisions, 2026-11-12 and 2026-11-13). Accepted risk: whoever controls a trusted unsigned source can publish under approvals already given; the Updated notice, one-press roll back and the asks no grant spares bound it.
- A selection carries its catalog epoch and is re-resolved on send, replay, resume and handoff; a difference blocks as stale.
- Executable components stay quarantined until reviewed, then run in supervised sandboxed processes.
- A structured mention or a workspace preset cannot install, trust, enable or elevate anything. Marketplace network access happens only on user action.
- `octant plugin create` and `octant plugin check` never install, trust, enable or reach the network.

Not built yet:

- Plugin MCP servers and Canvas export workers on Linux: the extension supervisor has only a macOS Seatbelt launch class and no Bubblewrap one, so they are refused there ("Extension process sandbox is unavailable on this host"). An outside provider driver runs on Linux unconfined and labelled (maintainer decision, 2026-11-16). Language servers and debug adapters use the shared confinement port, which confines them on Linux.
- Every extension process on Windows: no Windows extension confinement exists.

Status: Partly built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Skill discovery and Project code denial

Octant's own skill index discovers skills only from the closed Project allow-list, the user-global folder, and provider and added folders the person turns on, never from the home folder's tool-configuration folder on its own. A key provider loads its own skills natively ([Key providers run as themselves](#key-providers-run-as-themselves)).

- A discovered skill is never trusted or active because of where it was found. Of two same-named skills that are on in a thread, the Project's copy wins with a notice unless the person turned the shared one on later by hand (maintainer request, 2026-11-12); any other pair is off until the person chooses.
- Outside Strict, adding a Project trusts it for every runtime ([Adding a Project trusts it for every agent](#adding-a-project-trusts-it-for-every-agent)).
- Under Strict, a runtime that loads Project skills, MCP servers, hooks or plugins by itself loads them only in a Project the person allowed for it; elsewhere it runs with a proven switch or is denied the file. Instruction files stay readable.
- Under Strict, Gemini CLI and Qwen Code are refused at start in a Project holding their settings entries that the person has not allowed, because their loaders fail on a denied file; outside Strict they start everywhere with the entries readable unless their setup is off (maintainer decision, 2026-11-21).
- A folder picker or a watched root records only the skill-folder setting and grants no trust or enablement.

Status: Built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### MCP tool approvals

Below Full access every MCP tool call waits for an approval in the turn's window unless a remembered approval covers it. At Full access a trusted, enabled server's tool runs without asking, on a thread that has taken in outside content too, and records no grant; a Plan turn still asks (maintainer request, 2026-11-12).

- An approval has no expiry and no host-wide count limits waiting ones (maintainer decisions, 2026-11-13 and 2026-11-21). It ends only with an answer, its turn stopping, its thread's archive or its window's revocation.
- A device the host's own person paired answers any prompt on a thread it may drive; any other device session answers only prompts its own turns raised. A windowless host turn waits in Needs you (maintainer request, 2026-11-12).
- Below Full access the first approval of any tool of a server is kept for all its tools in the Project, bound to version and digest; a changed tool listing asks again (maintainer decision, 2026-11-12). A grant grows only through a person's answer; a Plan turn asks for every call, and a host-owned or hub-introduced device's turn's answer covers one call.
- Under Strict, below Full access, after a thread takes in outside content, a network server asks once per thread and server (maintainer decisions, 2026-11-12 and 2026-11-13). Outside Strict the mark adds no ask ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).
- A call must satisfy the tool's listed schema before approval, a remembered grant, credential resolution or dispatch; a server's application error is recorded as outside content before the provider reads it.
- Uninstall, withdrawn trust and rollback revoke grants; installing again restores nothing.

Status: Built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Connectors and user-added servers

A person connects an MCP server from Settings, in a local window or on a device the host's own person paired (maintainer decision, 2026-11-12). It becomes an ordinary package, installed, trusted and enabled as one act (Add only keeps trust and the switch to the person), under the same ladder and approvals.

- A secret value goes to the credential broker, never into the package. Listing servers found on the computer is read-only.
- The Connectors catalog is bundled and fetches nothing to render; the host accepts a connector id only at that entry's own address. The Library is one searchable list that never reaches the network.
- A server the person typed in by hand reads as Needs sign-in only when its refusal is the protocol's sign-in challenge; any other refusal reads as Not connecting.
- A thread whose next turn would get a server that needs sign-in offers the same sign-in control, and signing in reselects only that server's refused `@` names.
- Reading connection states never connects, signs in or lists tools. Reconnect clears sessions so the next authorized task connects fresh, and is the person's act from a local window or a person-paired device; a failed call is never replayed.
- A Project pin offers a plugin on every turn but grants nothing; calls still ask per [MCP tool approvals](#mcp-tool-approvals).
- Hosted-server sign-in uses the protocol's authorization flow with PKCE, and the grant lives in the broker; a person-paired device starts and finishes one as a local window does ([Connector sign-in finished from a paired device](#connector-sign-in-finished-from-a-paired-device)). Paired devices cannot prepare or save client setup. Vendor consent, permissions and admin restrictions stay authoritative, and no scope, shared secret or hosted service is invented.
- A person may add or remove a server, marketplace or plugin on one Claude Code or Codex account only by Octant running that program's own command, shown exactly first and run once from the window that asked (time limit in Settings › Limits; maintainer decision, 2026-11-21). It is refused on a paired device, unreachable to an agent, runs with no shell, and a secret is never an argument.

Not built yet:

- Google's Gmail, Drive and Calendar for everyone: the enrolled-account live check is owed, public distribution waits for Google's permission or general availability, and scope verification and any restricted-data review are separate gates.
- Live vendor acceptance of the shared sign-in foundation, public-none compatibility, and GitHub MCP tool support: not yet run.
- Automatic routine occurrences, durable catch-up, gap and loop composition, and live acceptance in the GitHub Actions reader: not built in that reader.

Status: Partly built. Since: 2026-10-20 (Connectors); 2026-11-01 (Claude and Codex tools). Detail: [Architecture: Connectors and the Connectors catalog](../architecture.md#extensions-and-skills); [DESIGN.md: Settings page](../../DESIGN.md#settings-page).

### Computer use and device tools

Core capabilities (browser and computer use, tests, Apple validation, approvals, memory, subagents) are app-managed and provider-neutral; none depends on an optional extension.

- Outside Strict, Computer use at Full access needs no first-action approval (maintainer decision, 2026-11-19). Below Full access, and under Strict, it asks at the first action in each application, once per thread, with **Remember for this Project** (maintainer request, 2026-11-12).
- A file sent into the thread's desktop on this machine does not ask at Full access; below it asks once per thread, and a Project remember never covers a cloud desktop (maintainer decision, 2026-11-13).
- Under Strict an answer from before the thread read outside content does not cover it afterwards; outside Strict it keeps covering (maintainer decision, 2026-11-22).
- Computer use treats application content as untrusted, fails closed if evidence recording fails, is refused in Plan, and never controls Octant itself.
- A device the host's own person paired lists and stops every Computer use session; a hub-introduced device is refused (maintainer decision, 2026-11-16; [Paired devices act as the person](#paired-devices-act-as-the-person)).
- The driver is a bundled, pinned, publisher-verified copy that updates itself daily unless the person turned that off (maintainer decision, 2026-11-26).
- Managed device tools run pinned, verified releases in a device-scoped native sandbox that never grants a Project or provider account; a missing sandbox keeps the native fallback rather than running the tool unconfined ([Managed device tools](device-workbench.md#managed-device-tools)).

Status: Built. Detail: [Architecture: Extensions and skills, Computer use plugin](../architecture.md#extensions-and-skills); [Paired Mac display](disposable-desktops.md#paired-mac-display).

### Canvas export

A Canvas export reaches a destination only after the person approves a card showing the exact payload and destination.

- A call without confirmation never overwrites a file. A rendered document that fails the secret-and-path filter is refused.
- Saving or copying the HTML file, and in-app sharing, are not destinations and send nothing off the host.
- An approved export journals its intent before calling the destination and is never resent; an intent with no outcome reads as unconfirmed until a later export or the person's Dismiss from a local window retires it.
- Destination workers inherit no host configuration or keys, and changed activation or package identity invalidates approval. Linux and Windows run no destination worker until their native confinement is verified.

Status: Built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Composer window capture

In the macOS desktop app the person can attach a picture of one open window from the composer. It is the person's action, never an agent tool.

- Listing reads window titles only; the screen-recording permission is asked only after the composer explains it. A capture reads exactly the listed window and is never retargeted.
- The picture takes the ordinary image attachment path; the shell keeps no copy and sends no telemetry. Web, phone and other desktop platforms do not offer it.

Status: Built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Plugin boundaries

New providers and tools reach the system through the published SDK, API and host seams, taking no shortcut a third-party plugin could not take.

- Plugin ports carry no raw filesystem, shell or credential handles; plugin state holds only opaque references.
- Pull request reviewers use a Code-only seam; stored external reviewer packages stay host-prohibited until a confined worker class exists, and forge publication and hand-back are default-off opt-ins.
- Code tools and host media tools reach plugins through public ports; confinement, credentials, admission and outside-content tainting stay host-owned.
- GitHub, thread boards and Zen are bundled first-party plugins, each on by default and switchable; Git, pull requests and the listed core features are not extraction candidates (maintainer decision, 2026-11-07).
- Disabling a plugin keeps its data and drains its executables; deleting credentials needs its own confirmation.

Not built yet:

- Loading installed third-party media tool packages: deferred until media-tool manifest contributions are enabled.

Status: Partly built. Since: 2026-11-07. Detail: [Architecture: Plugin boundaries and remaining extraction](../architecture.md#plugin-boundaries-and-remaining-extraction).

### Themes as plugin contributions

A plugin may contribute a theme, or a character ground, as data only, validated by `@octant/theme` before it is listed (maintainer decisions, 2026-11-14 and 2026-11-18).

- A contribution has no renderer code, stylesheet, script or asset loader; one that fails validation is refused whole.
- It is listed only while its plugin is installed, trusted and enabled; a stored choice of it draws the default while the plugin is off.

Status: Built. Since: 2026-11-14. Detail: [Architecture: Plugin boundaries](../architecture.md#plugin-boundaries-and-remaining-extraction).

## Authority and approvals

### Local authority

Nothing reachable on loopback grants window authority by itself. Local clients present a secret only the host's OS user can read.

- Another OS user, an ssh port forward, or a proxy rewriting `Host` reaches the listener but gets no capability.
- A device the host's own person paired holds what a local window holds ([Paired devices act as the person](#paired-devices-act-as-the-person)).
- On a host that knows a device only through the hub's roster, only an owner device the person marked holds window authority ([Hub and spokes: owner devices](hub-and-spokes.md#owner-devices)). Its real-device check is a maintainer live check still owed.

Status: Built. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Server-side tool-call policy

A model's tool call is a petition, not a grant. The server resolves every call before anything runs, and tool results are data, never instructions.

- A Code turn acts on the checkout it started on.
- Octant's own tools re-check the live execution policy on every call, so a thread put in Plan mid-turn refuses writes next call.
- A provider's built-in tools keep their launch posture; a lowered grant reaches them next turn or when the person stops the turn.

Status: Built. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Approval categories and postures

Approvals are independent categories, and grants are scoped and journaled. Plan is read-only at every level.

- The host sets a Work or Code thread's access, never the renderer. Access outside the Project folders asks below Full access and is refused in Plan (maintainer decision, 2026-11-14).
- Full access is chosen as [The Full access rule](#the-full-access-rule) says. A device known only through the hub's roster may lower a thread but never raise one to Full access (maintainer decision, 2026-11-13; [Hub failover and owner devices](#hub-failover-and-owner-devices)). There is no session-only Full access (maintainer request, 2026-11-12).
- An allow given after the thread's posture changed is refused undelivered and asks again; a denial is always delivered.
- Every refusal names its reason, and a recovery the person can perform. Recovery never widens automatic admission.

Status: Built. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Provider auto-review

A thread's `autoApprove` flag says who answers a prompt, not what is permitted.

- Delegation to the provider's reviewer needs the provider to report support; taint and capability clamp it off, and unknown taint counts as ingested.
- Categories, sandbox, egress and credential reach stay Octant's whatever the reviewer answers. Octant never writes a provider-side grant.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Goal-loop round authority

A Work goal-loop round runs as the host, under the per-process host scope a routine runs under, never through a window.

- Its turn is journaled as the host's `system` actor and rechecks the thread, its Project, the Work switch and the round's authority.
- A round with no checkpoint runs only at approval-gated authority.

Status: Built. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Pending requests, fleet activity and turn decisions

Reads that gather what needs the person add no authority. Each mode lists only what its answer command would admit for that window.

- Both reads answer a local window or a device the host's own person paired, and refuse every other session (maintainer decision, 2026-11-12). They list every waiting ask (maintainer decisions, 2026-11-13).
- A row is answerable in place only if it holds everything its card shows; otherwise it opens its thread.
- A turn decision's option performs no host action; the answer is the next turn.

Status: Built. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Desktop authority confirmations

A desktop authority confirmation is decided only in an isolated approval view owned by the main process.

- Only that live view decides its challenge. Cancel is the default, and expiry, teardown, a covering overlay or a late decision fails closed.

Status: Built. Detail: [Thread view](thread-view.md) and [Architecture: Security and authority](../architecture.md#security-and-authority).

### Octant's own limits become settings

Octant's fixed limits that protect no hard line are settings with their former values as defaults, apply only under Strict, or are gone (maintainer decision, 2026-11-16). This entry owns which limits apply only under Strict.

- Settings at every level, journaled, changed at a local window or a person-paired device: wake-ups and catch-up (maintainer decision, 2026-11-25), message wakes, coordinators per Project, pull-request watches and Auto-fix, a child run's `wait`, Octant Shield's brakes, follow-up lateness and a shown command's run window (maintainer decision, 2026-11-21), and starting agent-created routines active at Full access (maintainer decision, 2026-11-25).
- Only under Strict, with no limit outside it (maintainer decision, 2026-11-19): a turn's thread messages, sibling-thread reads and waits, a Browser wait, a Work or Code turn's event budget ([Agent task display and tool-call records](#agent-task-display-and-tool-call-records); maintainer decision, 2026-11-25), a coordinator's own actions keeping Plan's gate (maintainer decision, 2026-11-25), and the native harness's 32 waiting approvals and 32 waiting questions ([Harness sessions, goals and steering](#harness-sessions-goals-and-steering); maintainer decision, 2026-11-26).
- A helper's working-time limit is off by default under a Full access parent ([Child agent runs](#child-agent-runs); maintainer decision, 2026-11-25). A file routine's activity window is raised or cleared by the person.
- Removed (maintainer decision, 2026-11-21): the host-wide cap of 32 waiting MCP tool approvals and the 24-hour deadline on a queued thread message.

Status: Built. Since: 2026-11-16. Detail: [Architecture: Security and authority, Octant's own limits become settings](../architecture.md#security-and-authority).

## Sandbox and confinement

### Process confinement

Every launch Octant confines goes through one shared confinement port. A launch that needs confinement and finds no backend fails closed; it never falls back to running unconfined.

- Outside Strict, providers run in their own sandbox ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox)), the Project terminal runs unconfined ([Project terminals](#project-terminals)), and Windows follows [Windows below Full access](#windows-below-full-access).
- macOS uses deny-default Seatbelt profiles; Linux uses Bubblewrap with all capabilities dropped, and Plan and Chat on Linux fail closed where the no-process-creation filter cannot load.
- Path checks alone are never the boundary: confined reads verify the opened handle's identity.
- Escape probes fail closed as a release gate, on macOS, Linux and the packaged Work confinement gate.
- Strict is set apart from the level, inherited thread → Project → Settings. Under Strict, Claude's every native sandbox escape asks the person, Full access included, and bypasses reviewers and remembered answers.
- An fx launch below Full access on macOS may read only the system keychain file, never another keychain path (maintainer decision, 2026-10-31).
- Windows Strict is limited to [Windows Strict, phase 1](#windows-strict-phase-1).

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Version reads and discovery

A version read launches confined, with no root, no home, no network and one throwaway scratch directory.

- Its environment drops provider credentials and config-home variables, and its process group is killed when the read settles.
- Credential-reading status probes use the shared builder with their real account files and no network; missing confinement refuses the probe, and an incomplete check reports unknown, never sign-out.

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Provider runtime confinement matrix

Octant wraps a provider runtime launch only where the process carries exactly one thread's authority and Octant's sandbox applies. The matrix names the exceptions instead of promising a boundary Octant does not draw.

- Outside Strict, a Work or Code launch below Full access outside Plan (no kept sandbox, no chosen policy, not a readiness check) runs with no Octant sandbox ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox)).
- Otherwise runtimes are wrapped: in Chat, in Plan, under Strict, for a kept sandbox or chosen policy, and for readiness checks. Claude Code outside Plan runs in its own sandbox.
- At Full access Octant wraps no provider runtime unless the thread keeps its sandbox. Plan's read-only enforcement is the same at every level.
- A new module may not launch a provider process without the shared builder unless the matrix names it.
- Runtimes get no reusable cloud credential the person did not configure for that account.

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Providers run in their own sandbox

Below Full access, outside Strict, a provider runs as on its own: in its own sandbox where it has one, with its own approvals holding the level. Octant's sandbox applies under Strict, in Chat and Plan, where a thread keeps it or chooses a sandbox policy, and for readiness checks (maintainer decisions, 2026-11-15 and 2026-11-21).

- One rule decides it for every driver (`providerHoldsLevelWithoutSandbox`); Octant's approval gate answers what the provider asks.
- Where Octant configures a native sandbox, writable roots are the Project's folders and Octant's protected paths become deny rules where supported. Accepted trade-off: it may allow reads outside the Project, as the provider does on its own.
- A request to run one command outside the provider's sandbox reaches the person (the reviewer at Auto) for that one command; nothing is remembered.
- Strict resolves thread → Project → Settings → off at each launch. A hub-introduced device or an agent grant may turn it on, never off. Under Strict the provider runs inside Octant's profile with no native escalation, and other sign-ins, `~/.ssh` and cloud keys stay unreadable.
- Under Strict, Claude Code's own sandbox is configured instead, since macOS refuses nested Seatbelt, and its every escape asks (maintainer decision, 2026-11-16). Accept edits on Codex is `on-request`, as in its CLI (maintainer decision, 2026-11-21).
- ACP agents keep Octant's sandbox outside Strict when their shell never asks, when an added agent is untrusted, and when setup is off and the profile holds setup back ([Key providers run as themselves](#key-providers-run-as-themselves)).
- Unchanged: server-side approval authority and journaling, read-only Plan, no shell in Chat, signing a provider in as its chosen account, and marking outside content.

Not built yet:

- Octant configuring the native sandbox of Gemini CLI, Qwen Code, GitHub Copilot, Cursor and Grok Build: their checked releases cannot hide other providers' sign-ins; Copilot and Cursor wait for checks of their ACP releases, Grok Build for a check of why it launches with `GROK_SANDBOX=off`.

Status: Partly built. Since: 2026-11-15. Detail: [Architecture: Security and authority, Providers run in their own sandbox](../architecture.md#security-and-authority); [Provider runtimes](provider-runtimes.md#opencode-and-pi-without-octants-sandbox).

### Work shell at the shared access level

A Work thread launches exactly as a Code thread at the same level would, shell included. A driver that cannot reports it and keeps the shell withheld.

- It never runs commands under a weaker guard than the level names: asks at Ask first, a reviewer at Auto, none at Full access.
- An ACP agent whose shell cannot be asked per command reports unsupported at Ask first and Auto.

Status: Built. Detail: [Architecture: Modes, Work shell and Git](../architecture.md#modes-chat-work-and-code) and [Security and authority, Sandbox](../architecture.md#security-and-authority).

### Provider capability matrix

Claude Code, Codex, OpenCode and Mistral Vibe are first-class key providers, each promised full native capability. The other ACP agents are key providers for their own setup only (maintainer decision, 2026-11-14). Every other provider has a documented degraded form or reports the capability unsupported and fails closed.

- Nothing makes providers match; the conformance harness checks that each reports its own capabilities honestly.
- A capability only some providers have reaches the others through the published seams; no seam is widened for one vendor.

Not built yet:

- Mistral Vibe's compaction, review and question messages over ACP: allowed, but each needs its own signed-in runtime evidence first.

Status: Partly built. Detail: [Architecture: Security and authority, Provider capability matrix ("degraded on")](../architecture.md#security-and-authority).

### App-server runtime confinement

Under Strict, and in Plan and Chat, a key provider's app-server runtime runs inside Octant's sandbox at every level below Full access. Outside Strict a Codex Work or Code thread runs Codex's own sandbox ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox)).

- Inside Octant's sandbox each turn tells the runtime its sandbox is external, so approving a command never lifts a sandbox; Auto runs as Codex's own Auto with its reviewer (maintainer decision, 2026-11-14). Under Strict a command that must leave the wall fails.
- A command cannot read the home folder outside the root and the account home, or write the account home's configuration.
- Under Strict the launch carries no cloud profile, shared-config location or IAM key. At Full access its commands reach the whole disk.

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority); [Provider runtimes: Codex](provider-runtimes.md#codex).

### Provider telemetry and self-update are the person's switches

Whether a provider sends its own telemetry and whether it updates itself are two person-level switches in Settings › Providers & Models, not hard lines (maintainer decision, 2026-11-21).

- Both are off by default, an older store included. Off means Octant sets the provider's guard wherever it has a documented switch a launch can set, not that telemetry is off for every provider (maintainer decision, 2026-11-25). Every provider's model requests carry the conversation.
- Strict keeps every telemetry and self-update guard, and so does a thread that keeps its sandbox or chose a sandbox policy. The version read always keeps them, and a host's own opt-out holds either way.
- Each switch applies from the next launch, provider terminals included; Octant's own **Update CLI** flow is unaffected.

Not built yet:

- A telemetry off-switch for Gemini CLI: it has settings only, no per-launch switch exists, and Octant does not write the person's provider configuration.
- Overrides for the interactive `codex` in a provider terminal: not wired.

Status: Partly built. Since: 2026-11-21. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority), [Settings: Provider channels](settings.md#provider-channels) and [Provider runtimes: Provider channel switches](provider-runtimes.md#provider-channel-switches).

### Provider runtime telemetry guards

Each non-essential channel of a key provider's runtime is kept off by its own switch on every launch, version read included, not by one blanket switch.

- Strict guards every channel; outside Strict, telemetry and self-update follow [the person's two provider switches](#provider-telemetry-and-self-update-are-the-persons-switches).
- Auto-memory is a per-account setting, on by default (maintainer decision, 2026-11-14); Plan, Chat and the version read keep the provider's memory off. Built-in agents follow the person's own subagents.
- A host's own exported opt-out holds on every launch.
- Octant never reads, stores or injects the runtime's subscription tokens.

Status: Built. Since: 2026-10-20. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Hosted artifact publishing

Publishing a Work or Code file to the provider's hosted service is a person-authorized external publish and an opt-in telemetry exception, off by default.

- The account enables the choice; each thread then chooses hosted artifacts over Canvas, and Canvas stays the default (maintainer decision, 2026-11-12). Only such a thread's session outside Plan lifts the tool and usage telemetry guards.
- Every publish asks below Full access, and no answer is reused. The file must be inside the bound Project and outside the login keychain folder.
- Plan never offers the tool, Chat never publishes, and agent-run child sessions are never offered it. Server policy admits a person-paired device and refuses hub-introduced ones.

Not built yet:

- Enabling the account's choice from a paired device: today only a window on this host can.
- The paired-device UI for the thread's choice: a follow-up to the server policy.

Status: Partly built. Since: 2026-10-27. Detail: [Architecture: Security and authority, Hosted artifact publishing](../architecture.md#security-and-authority).

### Plan launch writes and sign-in

A confined Plan launch of one key provider's runtime writes only what its own session needs, so it cannot plant what a later unsandboxed session would load.

- Settings, hooks, MCP config, skills, plugins, agents, commands and memory stay read-only; a file-kept subscription login may be refreshed (2026-10-14).
- Subscription sign-in uses the unmodified CLI and a minimal grant that the profile refuses to every other process.
- A Code Plan turn may run a closed list of read-only commands; a Linux host that cannot nest their capsule offers Plan no Bash tool ([Plan and Chat tool parity](#plan-and-chat-tool-parity)).
- A live check is owed: no real turn has yet run under the narrower session grant.

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Subscription sign-in inside the provider's terms

Octant would not mint, store or inject a provider setup or OAuth token; subscription sign-in would stay wholly in the provider's own flow, launched from a provider-owned config directory.

- The rule is proposed, not accepted: it needs the provider's commercial terms or an explicit exception. Until then the architecture describes the build as it ships.

Status: Designed, not built. Detail: [Architecture: Security and authority, Proposed, not accepted](../architecture.md#security-and-authority).

### Confined Git

Confined Git reads no configuration from the person's home and sees only the repository metadata it needs.

- In a linked worktree it reads only the metadata its own worktree names, after the reciprocal record verifies; write on it is requested only by a non-Plan mutation launch.

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Host reads of a bound root

Every read, listing and search the host makes in a Code checkout or Work folder, and every Work write, runs one confinement sequence that survives an ancestor being swapped for a link.

- The open lands on the canonical path with the handle's identity verified; platforms that cannot verify it refuse.
- Mirror, export, Canvas and harness writes are held inside their root the same way; a root that no longer resolves to its stored real path is refused before anything is written.

Status: Built. Detail: [Architecture: Security and authority, Host reads of a bound root](../architecture.md#security-and-authority).

### ACP client capabilities

Octant executes ACP client file and terminal effects inside the Code confinement, with bounded reads, writes, lifetimes and output.

- Posture is re-checked for every write and terminal creation; the effects are refused in Plan and journaled as app-managed tool events, with no path outside the bound checkout.

Status: Built. Detail: [Architecture: Security and authority, ACP client capabilities](../architecture.md#security-and-authority).

### ACP agents keep their credential-file block at Full access

At Full access an ACP agent launches outside Octant's sandbox with no OS-level denials of host credential files or extension folders, as the provider's own app does. Octant's own file tools refuse only provider sign-ins there, and secrets are redacted from what Octant records.

- Credentials reach providers only through the credential broker. Where Octant's sandbox wraps an ACP agent ([Provider runtime confinement matrix](#provider-runtime-confinement-matrix)), it also denies credential files and unapproved extension folders.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Approvals](../architecture.md#security-and-authority).

### Windows confinement for confined launches

A confined Windows launch runs in a fresh AppContainer with ACL grants and a kill-on-close job, applied by a fixed native launcher (maintainer decision, 2026-11-15). It confines only Codex catalog reads under Strict; every other confined Windows launch is refused until it has run a real provider on a person's Windows machine.

- The container is deny-by-default, and the secret guard holds as an OS rule: a grant at, inside or above a protected location, or one the guard cannot spell, is refused.
- A policy the container cannot express is refused as incompatible, not dropped. Full access is the job object alone.
- A Windows Strict Codex thread does not run in it: Codex's own elevated sandbox confines that thread's commands (2026-11-22). Strict off runs unconfined, with the tree stop in place of a container.

Not built yet:

- Every other Windows Strict launch: refused by name until its runtime is verified.
- Standard-user Windows 11 desktop verification (Gate 5), ACL propagation cost on a large checkout, terminals and other providers: not yet verified.

Status: Partly built. Since: 2026-11-15. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Windows Strict, phase 1

Native Windows accepts the one shared Strict control for Work and Code at Full access on a verified Codex runtime (maintainer decision, 2026-11-21). Codex's own elevated Windows sandbox confines the commands Codex runs, with the thread's folders as its only writable roots and every protected store denied; the Codex process itself runs outside any Octant wall (maintainer decision, 2026-11-22).

- Phase 1 adds no Windows-only label, switch or preference; the legacy Full-access-only sandbox preference is never read as or migrated into Strict.
- Every other Windows Strict case refuses by name until its runtime is verified: Chat, Plan, every level below Full access, every other provider, proxy-only or blocked-network policies, and Octant's own file, terminal and command operations.
- Rationale: an Octant wall around the Codex process forced shared `CODEX_HOME` writes, so a confined command could change other threads' history.
- The elevated backend's one-time setup asks an administrator, as Codex's own setup, never requested by Octant; without it Windows Strict refuses Codex by name. Nothing retries unconfined.
- Limit: a Strict thread cannot stage or commit, because a writable `.git` would let a confined command plant hooks.
- A live check is owed: Gate 5, a real Codex turn under Windows Strict on a standard Windows 11 account after Codex's elevated setup, and the refusal when that setup is missing.

Status: Built. Since: 2026-11-21. Detail: [Architecture: Windows Strict, phase 1](../architecture.md#windows-strict-phase-1).

## Terminals, browsers and side surfaces

### Project terminals

A Project terminal is the person's shell, not an agent's. No provider, tool call, agent run or thread can address it, read its output or type into it.

- Only a person, at a local window whose workspace holds the Project or at a paired device that reaches it, may start, attach to, type into, resize or stop it (maintainer decision, 2026-11-12).
- Outside Strict it runs unconfined; under Strict it runs through a thread terminal's confinement ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)). It carries no credential references, and a Plan checkout stays read-only.
- Its lifecycle is journaled, its output never is. A Work Project shows one only after its Developer tools are on; Chat has none.

Not built yet:

- Saved actions, worktree setup and a server Project's shell from a paired device: they stay at a window.

Status: Partly built. Detail: [Architecture: Security and authority, Project terminals](../architecture.md#security-and-authority); [Server Projects](server-projects.md#threads).

### Provider terminals

A person can run a thread's provider's own command-line program, in its own interface, in a terminal tab of that thread (maintainer decision, 2026-11-21). Its keystrokes reach the provider directly, past Octant's approvals, so the thread claims nothing that happens in it.

- The host resolves the program, account folder and environment by the provider's own launch rules; telemetry and self-update guards follow [the person's two provider switches](#provider-telemetry-and-self-update-are-the-persons-switches).
- It runs as the thread's turns do (maintainer decision, 2026-11-21): outside Strict and Plan with no wall, on the provider's own approvals; under Strict or a kept sandbox, under a Code terminal's confinement at the thread's level. Windows refuses one that would start confined.
- Plan, a server Project and a provider with no such program are refused. Only the person opens or types into one; the host refuses every agent and other remote principal.
- Its output stays out of the thread's transcript and usage, and it carries no secret.

Not built yet:

- The other ACP agents, an added ACP agent and the other providers with a program: the repository does not yet record their CLI's interactive mode.

Status: Partly built. Since: 2026-11-21. Detail: [Workspace: provider terminal](workspace.md); [Architecture: Security and authority](../architecture.md#security-and-authority).

### Terminal output paths

A Code thread terminal's output reaches a window by two paths, so latency and durability do not share one setting.

- The record path is journaled and stays authoritative for reload and export. The live path is never journaled, redacts as the record does, and ends when the window's capability is revoked.
- A minimised Terminal card only reads; it never attaches, starts, writes or resizes.

Status: Built. Detail: [Architecture: Security and authority, Terminal output paths](../architecture.md#security-and-authority).

### Project browsing contexts and profiles

A Project browser is the person's browser, never an agent's. A page is Private unless the person puts it in a profile.

- A Project context is isolated and ephemeral; no thread surface can attach and no thread approval carries into it.
- Only the person, at a local window or a paired device, may open, read or close it (maintainer decision, 2026-11-12).
- An agent acts on an origin in a profile page only after a site approval naming the profile. Browser extensions install only at a local window, start disabled and never load into a Private page.
- Octant never opens another browser's profile in place.

Not built yet:

- A profile page from a paired device: profile pages open only at a window.

Status: Partly built. Detail: [Architecture: Security and authority, Project browsing contexts](../architecture.md#security-and-authority); [Browser profiles](browser-profiles.md).

### Side Chat reads

A Side Chat may read its source thread's transcript, state and files but never inherits the source's Work or Code execution authority.

- It gains only list, search and read file tools, re-checked per call; results are recorded as external content, and it has no write, shell, Git, network or `#thread` tool.

Status: Built. Detail: [Architecture: Security and authority, Side Chat reads](../architecture.md#security-and-authority).

### Subagent authority

Child runs receive equal-or-narrower authority than the parent, clamped server-side.

- Code children require a verified isolated worktree receipt. A transport that cannot carry app-managed tools fails the start rather than dropping the tool.
- Under Strict a source turn sends at most three thread messages, a count Settings › Limits changes; outside Strict there is no limit ([Octant's own limits become settings](#octants-own-limits-become-settings)).
- Key providers' native subagents are journaled and use the parent's approval path; a provider whose children would bypass it gets them only at Full access (maintainer decision, 2026-11-14).
- Outside Strict a helper runs at the lower of the running turn's and the thread's level, and the person's answer is kept as the parent's setting says; a reviewer's allow holds for one call (maintainer decision, 2026-11-25). Under Strict a helper keeps every Strict protection.

Status: Built. Detail: [Architecture: Security and authority, Subagents](../architecture.md#security-and-authority).

### Canvas design images

A design frame never loads anything itself. The server resolves the images a design declares on every read.

- Resolution runs through the authorized Canvas read; Chat reaches only images generated in its own Project or thread.
- Only sniffed raster images within budgets are returned and inlined; the journal holds references only.

Status: Built. Detail: [Architecture: Security and authority, Canvas design images](../architecture.md#security-and-authority); [Canvas: Image block](canvas.md#image-block).

### Product feedback notes

A local person can point at an exposed Code or Work Browser element, inspect a bounded static crop and DOM and style context, and save a comment on that immutable capture.

- The host resolves the element under the original authority; the renderer cannot supply element data or create a Browser grant.
- Only an explicit person message consumes the selected notes, once; saving notes never sends, queues, steers or approves work.
- Captured page material is outside content and taints the task.
- A live check is owed: native Electron runtime acceptance of capture, preview and note delivery.

Status: Built. Detail: [Browser: Pointed-at product feedback](browser-agent-tool.md#pointed-at-product-feedback).

### Project actions

Work and Code Projects save named one-line commands that only the person saves and launches.

- Suggestions are read-only until confirmed. Binding, checkout, policy and command are rechecked before launch, and Plan refuses.
- Each action gets a fresh tracked process; its journaled identity precedes launch, and unknown replies or a restart never repeat side effects.
- A server Project's review says there is no OS confinement. Work's Developer tools choice is off by default and changes no task or credential authority.

Status: Built. Detail: [Architecture: Security and authority, Project actions](../architecture.md#security-and-authority); [Server Projects](server-projects.md#threads).

### Worktree setup

A Code Project can prepare each new managed worktree with one reviewed saved action.

- The first task waits for setup or the person's explicit Skip; failure needs an explicit Retry or Skip, and Plan refuses it.
- Setup runs with admitted task access and the confined process lifecycle, with no parent environment or secret copying; a restart never replays it.

Status: Built. Detail: [Architecture: Security and authority, Worktree setup](../architecture.md#security-and-authority); [Thread view](thread-view.md#draft-continuity-and-composer-notices).

## Remote access and pairing

### Remote clients

Pairing issues a revocable device key; the private listener serves HTTPS on one LAN or private-mesh address with a host-owned identity. What each device may do is set in [Paired devices act as the person](#paired-devices-act-as-the-person).

- A remote principal never exceeds host, mode, provider, Project or thread authority. Remote requests are classified fail-closed; none mints a local receipt, and an unknown action is refused.
- Every remote change is journaled under the device's own id, a restricted device's included (maintainer decision, 2026-11-13). What the host starts or settles by itself is the system's.
- A device-code or cloud sign-in begins only at the host's terminal and is the local person's.
- **Pause remote access** refuses every device and outside agent until resumed, keeping records, keys and grants; a local window or `octant auth resume` turns it on or off, a Full device only on (maintainer decision, 2026-11-22). **Sign out all other devices** keeps only the asking device (maintainer decision, 2026-11-22).
- A party the host already trusts approves every new device (maintainer decision, 2026-11-12).
- The listener binds only a person-selected private address and port after the person confirms it, every state-changing request carries a device-key proof, and nothing authority-bearing queues offline.
- An agent's debug session (`octant_debug`) runs unasked at Full access, with one approval per session below it, and is refused in Plan (maintainer decisions, 2026-11-12 and 2026-11-13); a Full device drives one as a window does, other devices are refused.

Not built yet:

- Administering the listener from a device: the private listener forwards none of its routes.

Status: Partly built. Detail: [Architecture: Security and authority, Remote clients](../architecture.md#security-and-authority).

### Remote reach into thread surfaces

Each thread surface names one action that reads it and a separate action that acts on it; a companion derives its reach from the host's catalog.

- A Full device raises a thread to Full access or starts one there, and answers every approval of a thread it can open, with no owner-device requirement; the first answer settles it (maintainer decision, 2026-11-12). Approve and steer answers only its own turn's prompt; Read only answers none.
- An owner device known only through the hub's roster is not the person: no per-action unlock (maintainer decision, 2026-11-13), its answers ride the five-minute unlock session, and a thread's level rises only through owner posture recovery. See [Hub failover and owner devices](#hub-failover-and-owner-devices).
- A device that is not the person may click, hover, scroll, press keys in and list the tabs of the host's agent browser, and nothing more. Navigation guards and site approvals apply to every device.

Not built yet:

- Terminal, simulator, Canvas and file preview views on the phone: it fills only the conversation and the Browser (`threadSurfacePresentation.ts`), so it does not offer the others.

Status: Partly built. Detail: [Architecture: Security and authority, Remote clients](../architecture.md#security-and-authority).

### Host identity on every connection

Every client verifies a signed host hello, answering its own fresh nonce, before it pairs or signs in, and refuses a host whose identity changed.

- The proven fingerprint recorded at pairing must match on every later hello. A host built before these checks is refused as incompatible; no refusal deletes the device key.
- First contact is trust on first use over TLS; only certificate pinning closes a relay that passes the live hello through.

Status: Built. Detail: [Architecture: Security and authority, Host identity on every connection](../architecture.md#security-and-authority).

### Listener certificate and client pinning

The listener serves a pasted certificate or a self-made one, which a client pins by its public-key hash and accepts no other way.

- The self-made certificate has its own owner-only key, never the host identity key, and never in a response, log or journal.
- A client sends nothing unless every resolved address and the connected peer are private.
- Rotation is signed with the old key and staged by trusted hellos; a missed window needs re-pairing, never an unknown-pin fallback.

Not built yet:

- Roster trust migration: activation refuses an enabled hub or joined spoke instead.

Status: Partly built. Detail: [Architecture: Security and authority, Listener certificate](../architecture.md#security-and-authority).

### App pairing code and one-step pairing

A self-made listener pairs apps through a single-use, five-minute pairing code that carries the listener origin and pin; a browser pairs only with a pasted certificate.

- A reader refuses a newer, damaged or non-private code before sending anything. Approval at the host needs a typed yes after comparing label, fingerprint and comparison code.
- A Full device manages devices and pairing requests over `/api/remote/`, journaled as it, and never approves its own key; a device it approves is the person's. Hub-introduced devices and agent grants do none of this (maintainer decision, 2026-11-12).

Not built yet:

- Key rotation for one-step pairing: planned.

Status: Partly built. Detail: [Architecture: Security and authority, Adding a computer in one step](../architecture.md#security-and-authority).

### How long a paired device stays paired

The person chooses how long a pairing lasts: 7 days, 30 days (the default), 90 days, 1 year or Never expires (maintainer decision, 2026-11-13).

- A window or a Full device changes it, journaled; other devices are refused.
- The deadline is pairing time plus length, and use never moves it. An expired device must pair again; an expired or revoked pairing never revives. Revoke is the only end under Never expires.

Status: Built. Since: 2026-11-13. Detail: [Architecture: Security and authority, How long a pairing lasts](../architecture.md#security-and-authority).

### Pairing abuse limits

Pairing is rate-limited per source and per host, and cleans up after itself.

- A rate-limited paired browser waits and keeps its device key; it is never shown a failed pairing.
- An approved device that never signs in is revoked as `pairing-abandoned`; one that has signed in is never removed this way.

Status: Built. Detail: [Architecture: Security and authority, Pairing budgets](../architecture.md#security-and-authority).

### Hosts never trust each other

Multi-host views merge read models in the client without transferring authority, and federation shares no credentials beyond the [Shared sign-ins](hub-and-spokes.md#shared-sign-ins) API-key copy; subscription sign-ins refuse copying.

- Conflicting facts stay with their owning host. A create or mutation names one destination and is refused when it is not routable; nothing queues offline.
- An unreachable host's items stay listed as stale and read-only.
- A hub acting on a spoke is a remote principal held to that host's grant, and never approves, reads credentials or loosens confinement there.

Status: Built. Detail: [Architecture: Security and authority, Hosts never trust each other](../architecture.md#security-and-authority).

### Dev server proxy grants

A paired device may ask for a grant to open one dev server from its own computer, under a proxy session separate from its product session.

- The proxy session never reaches product routes and ends at host restart. The host rechecks grant, device, thread and owning process before every relayed request and closes the grant on any lost check.
- A Full device may forward one host loopback port to its own computer as raw TCP for an hour, journaled (maintainer decision, 2026-11-20). A hub-introduced device under the Act item forwards only a running server's port of a thread in the Projects Act names (maintainer decision, 2026-11-21). An agent grant forwards none.
- A server Project's SSH port forward is a window's alone (transport decision, 2026-11-20).
- A Full device stops any server as a window does; a hub-introduced device stops only Octant's own (maintainer decision, 2026-11-12).

Not built yet:

- Forward port in a paired computer's thread view, which offers Open only: no UI yet.
- The paired screen for confirming and stopping a leftover server: the server admits it.

Status: Partly built. Detail: [Architecture: Security and authority, Proxy sessions and server grants](../architecture.md#security-and-authority) and [Server Projects: Person-operated port forwards](server-projects.md#person-operated-port-forwards).

### Agents on other machines reach Octant through an agent grant

An agent on another machine on the person's own network works as its own principal, held to an agent grant the person creates. It is never a paired device and never the person.

- A grant names Projects, modes, a highest level, tools, models, spend limits and expiry, inside a restricted device's clamps. It may reach Full access behind the one-time warning (maintainer decision, 2026-11-12); `start_work` gives Full access to the thread alone (maintainer decision, 2026-11-13). Its prompts stay outside content.
- A window, the loopback CLI or a Full device creates or widens a grant (maintainer decision, 2026-11-12). Other devices may view and revoke it, a Read only one included, but a Read only device cannot stop the running turns with it (maintainer decision, 2026-11-26).
- It never adds Projects or answers approvals; its threads and turns are marked as its own.
- Revocation voids its credentials and ends its sessions and requests at once.
- Reach stays on the person's network (maintainer decision, 2026-11-11): no public bots, nothing Octant operates.
- Hosted and vendor-client receipt of milestones is a live check still owed.

Status: Built. Since: 2026-11-11. Detail: [Agent access from other machines](agent-access.md) and [Milestone subscriptions](agent-access.md#milestone-subscriptions).

### Local MCP clients use an agent grant

An MCP client on the host's own computer may use Octant as an MCP server under an agent grant, enrolled and scoped as a bridge grant is (maintainer decision, 2026-11-14).

- Loopback grants nothing extra: the same credential, grant and remote checks apply.
- The bridge never reads or sends the host's bridge secret.

Status: Built. Since: 2026-11-14. Detail: [Agent access: Ways to connect](agent-access.md#ways-to-connect).

### Paired devices act as the person

A device the host's own person paired at Full is that person: the server admits it wherever it admits a local window and journals its acts with the device as the actor (maintainer decisions, 2026-11-12, 2026-11-16 and 2026-11-22). Every other device session is held to the remote action catalogue. Other entries link here instead of restating this.

- The host decides from its own record, never the client. A device is the person only when the host's person approved its pairing (at a window or from a Full device) and its level is Full or unrecorded. A narrower level, a hub-roster device, an agent grant and an unproved pairing are not. A client reads anything but the host's plain yes as restricted.
- Each directly paired device has a level: **Full** (default), **Approve and steer** or **Read only** (maintainer decision, 2026-11-22). The host enforces it per request before any side effect, so a device never raises itself; a window or a Full device sets it, journaled.
- Stays with a local window, for every device (maintainer decision, 2026-11-19): a window's own shell, the desktop bridge and local receipts, secret stores, native pickers, Keychain cookie import, site login permissions (`/api/browser/credential-use`), Finder and external-editor handoff, read-aloud on the host's speakers, desktop Browser pane mouse input, saving to a chosen path, and a server Project's SSH port forward.
- A restricted device, an agent grant and a caller with no session are refused every person-only route before anything is journaled or connected. Among these: Reply detail changes, a Linux server's Vitals, a thread from a session text handoff (maintainer decisions, 2026-11-12 and 2026-11-13), unlinking a pull request (maintainer decision, 2026-11-25), and answering the memory and routine decision routes.
- The full list of admitted surfaces and their paired screens lives in the owner. Each owning entry keeps its own UI follow-up.

Not built yet:

- Paired screens for the other surfaces the server admits: UI follow-ups.
- The listener's controls, the whole host's export, removing a provider with its key in one step, and a server's port list for previews: the 2026-11-12 decision reaches them, but the server still refuses every device.

Status: Partly built. Since: 2026-11-16. Detail: [Architecture: Security and authority, Paired devices act as the person](../architecture.md#security-and-authority).

### Paired devices in cloud jobs and server Projects

A Full device submits and manages provider cloud jobs and binds, changes and operates server Projects as a window does (maintainer request, 2026-11-18).

- Every other caller is refused before anything is journaled or connected. An agent grant never spends a cloud account.
- A device's act is journaled with a versioned device principal; a window's act keeps the older event version, so an older build still reads a journal no device changed.
- A device's cloud submission gets the same review, rechecks and spend ceilings; a key needing an unlock at the host is refused.

Status: Built. Since: 2026-11-18. Detail: [Architecture: Paired devices and cloud jobs](../architecture.md#provider-cloud-jobs) and [Server Projects: Paired devices](server-projects.md#paired-devices).

### Access activity and change notices

The person sees who changed access to this computer, and is told in the app when a paired device or an agent raised it (maintainer decision, 2026-11-22).

- A window and a Full device read the activity list; others are refused.
- A notice appears when a device or agent grant raised a thread's level, or added or replaced a provider key, never for a window's own change. It carries no key.
- Undo and Revoke act as whoever pressed them, through the existing paths and their bars.
- In the app only: no push and no email.

Status: Built. Since: 2026-11-22. Detail: [Architecture: Security and authority, Remote clients](../architecture.md#security-and-authority) and [Settings: Remote access](settings.md).

## Credentials and sign-in

### Provider keys on a host without the desktop app

A provider API key is entered through the desktop renderer, the host-local `octant provider key` command, or a device the host's own person paired, a paired browser included (maintainer decision, 2026-11-12). It goes straight to the credential broker and is never journaled, logged or returned.

- The command never takes the key from an argument, flag or environment variable, and the server requires the bridge secret and a window capability.
- A locked or absent store fails with no fallback.
- The device routes refuse a hub-introduced device, an unproved pairing and an agent grant; the journal names the device. Removing a provider with its key is not offered to a device (maintainer decision, 2026-11-12).
- A browser without credential authority never supplies a key; it can create a profile without one.

Status: Built. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority) and [Model endpoints: Claude API-key profiles on a headless host](model-endpoints.md#claude-api-key-profiles-on-a-headless-host).

### Host-driven provider sign-in and cloud signing

The host, not a provider child and not the renderer, owns provider sign-in flows, and tokens stay in the credential broker.

- A local principal or a device the host's own person paired acknowledges terms and starts a PKCE sign-in, journaled as the device; no other remote principal does (maintainer decision, 2026-11-12). A sign-in completed after a restart is attributed to the device that began it (maintainer decision, 2026-11-13).
- The journal never holds a token, code or verifier. Portal sessions, refresh tokens and role secret keys never leave the broker.

Not built yet:

- A paired device starting a device-code or single sign-on portal sign-in (maintainer decision, 2026-11-12): the host-local routes are not forwarded to paired devices yet ([Organization sign-in flows](#organization-sign-in-flows)).

Status: Partly built. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Connector sign-in finished from a paired device

A device the host's own person paired finishes a connector sign-in whose callback is this host's loopback, with no token, verifier or device code leaving the broker (maintainer request, 2026-11-18).

- The device sees only the issuer's verification address and user code, or relays its callback once for an attempt the same device and session began. This is the connector's own flow, not a provider endpoint's device code.
- Hub-introduced devices, agent grants and callers without a session are refused.
- A real paired phone against a hosted issuer is a maintainer live check still owed.

Status: Built. Since: 2026-11-18. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### One-use credential cards

A person can enter a token, or pick a linked 1Password field reference, in a conversation card for one fixed integration operation, without sending it to the model or saving a sign-in.

- The host supplies purpose, destination and action; an agent picks no URL or command, and gets back no response content or raw error.
- A request is consumed once; a token already sent cannot be recalled.
- The person approves every named command binding run. Plan refuses; Full access is unrestricted. Approval ids are one-use and never restored.

Not built yet:

- Answering a card or approving a saved-command run from a paired device (maintainer decision, 2026-11-12): today only the owning local window can.

Status: Partly built. Since: 2026-11-03. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Thread secrets

An agent in a Code or Work thread can ask the person for a secret in a private card, kept as long as the person chooses (maintainer decisions, 2026-11-24).

- A value is entered only in the card: an agent cannot pass one, and one pasted in chat is ignored. Chat is refused.
- Strict offers neither 24 hours nor Remember, and an account password never offers Remember.
- A handle is used once by a registered consumer, never by a command. `run-with-secret` runs under the thread's level, Shield and sandbox; Plan refuses it.
- Every confined launch is denied the secrets folder by a rule the person cannot remove. Nothing is usable before its journal record, which holds no value.

Status: Built. Since: 2026-11-24. Detail: [Architecture: Thread secrets](../architecture.md#thread-secrets), [Thread view: Secret cards](thread-view.md#secret-cards) and [Settings: Secret stores](settings.md#secret-stores).

### Account usage reads

Plan limits that a provider reports only from an account endpoint are read with a credential already on the host for that instance (maintainer decision, 2026-11-25).

- The host reads the credential only for an enabled instance, sends it nowhere else, and never writes, copies or stores it.
- A missing allowance reads as unavailable, never 0% used.
- A hub reads a spoke's plan-limit readings only under the spoke's Usage hub grant item, off by default and checked on every read; a standby standing in may not read them (maintainer decision, 2026-11-26).
- Limits pools a provider's accounts on this computer as one bar per window with a segment per account, never an averaged share, pooling only accounts of one service (maintainer decision, 2026-11-26).

Not built yet:

- The hub's merged view of its spokes' readings, and the history totals the Usage item covers: the spoke's read is built, the hub side is not.
- Pooling accounts across paired computers: it waits on the cross-host read.

Status: Partly built. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority) and [Settings: Models, providers, and skills](settings.md#models-providers-and-skills).

### Claude gateway accounts

A Claude account may sign in through a gateway: an address in the account's configuration and a token in the host credential store, kept as an API key is (maintainer decision, 2026-11-18).

- The token uses the API key's broker and routes ([Provider keys on a host without the desktop app](#provider-keys-on-a-host-without-the-desktop-app)).
- Changing the address deletes the stored token. No account gets another's address or token, and credentials never appear in process arguments.

Status: Built. Since: 2026-11-18. Detail: [Model endpoints: Claude gateway accounts](model-endpoints.md#claude-gateway-accounts).

### Artifact replica membership

Each artifact replica entry is signed by a per-host device signing key, and membership derives from signed approvals chained to a founder the host pinned.

- The signing key lives where provider credentials cannot reach. An entry that does not verify is journaled as unreadable.
- Store setup, joining, revoking and leaving are the person's, at a local window or a person-paired device (maintainer decision, 2026-11-12).
- A replica import appends versions only and delegates no host authority.

Not built yet:

- The paired-device interface for store setup, joining, revoking and leaving: a follow-up; server policy already admits the device.

Status: Partly built. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority) and [Artifact replica sync](artifact-replica-sync.md).

## Updates and development

### Signed update feeds

The desktop updater verifies a feed's Ed25519 signature against the compiled-in keys of the ring the signed release names, before it believes any other field.

- Stable trusts only the stable key; preview and candidate trust the preview and stable keys, so preview builds cannot sign a stable feed.
- The release wizard mints a ring's key only when the app ships none, since replacing a deployed key strands its installs.
- Whoever writes feed files can withhold updates, never install something unsigned. A Linux AppImage update fails closed with the reason in Settings.
- A host installing a server over SSH believes a headless build listing only after its signature verifies, and adds no host or key (maintainer decision, 2026-11-19).
- The first release run that publishes a headless build listing is still owed.

Status: Built. Detail: [Architecture: Security and authority, Update feed signing keys are per ring](../architecture.md#security-and-authority).

### A guided tour on the first start

A five-step tour points at the real controls once, on the first start of a fresh installation after first-run setup, and can be retaken from the account menu.

- It never covers a dialog, a menu or Settings, and records only that it was seen, in renderer-local storage.

Status: Built. Detail: [Workspace: Guided tour](workspace.md#guided-tour).

### What's New after an update

Release notes show once after an update the person chose finishes applying, and only on the desktop.

- A release may bundle one to five announcements, shown as one dialog in place of the card; an invalid file shows nothing.
- Dismissing, closing or opening the notes acknowledges the whole set once. Nothing is counted or contacts a network, and browsers and remote clients show neither.

Status: Built. Detail: [Workspace: What's new card and announcement](workspace.md#whats-new-card-and-announcement) and [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Package dependency direction

Dependencies point inward: no package imports an app, and `contracts` imports nothing first-party.

- Contracts hold schemas only, and domain holds pure policy.
- The web renderer, mobile client and server depend on packages, never on each other's internals.

Status: Built. Detail: [Architecture: Package map](../architecture.md#package-map).

### Development loop and Linux hosts

Development and QA run against the canonical host and never create an implicit profile.

- Destructive tests use an explicit `OCTANT_DATA_DIR`.
- A Linux host needs the namespace sandbox tool and Git 2.36 or newer, or Work and Code fail closed. The AppImage never adds `--no-sandbox`.

Status: Built. Detail: [Architecture: Development loop](../architecture.md#development-loop).

## Design system

### Visual character, voice and colour

Octant looks like a calm, colourful workbench. Colour is the default and grey is a choice called Mono. Every surface uses the same words, face and hierarchy.

- Colour applies to everyone, and a state also has a shape or a word. An accent swatch is the person's choice and never recolours status. Plain empty, loading and informational messages stay neutral.
- Hierarchy comes from size, then weight, then colour: sentence case, nothing uppercase, only the large title bold. The default interface size is 14px, and a size a person chose stays. Interface text is smooth by default on a Mac.
- The rail lists places only (the Inbox and the Board), with one plan usage ring per account above the account face, whose menu leads with Settings (maintainer request, 2026-11-25).
- Icons are Lucide line icons from one module in four sizes, held by a contract test (maintainer decision, 2026-11-17). Radius is four tokens, and only what is round takes the pill token, held by a contract test (maintainer request, 2026-11-14).
- The interface is soft and flat: only what floats casts a shadow, and pointing, focusing and pressing answer in the same frame. In the desktop app no text sits on a fill that only a blur makes readable. Over the application ground, running text keeps its own surface ([Application ground](application-ground.md)).
- Under window Glass every floating surface draws a 1px lit line along its top inside edge; with Glass off, reduced transparency or increased contrast it draws none, and no pane, row, card or composer gains it (maintainer request, 2026-11-26).
- Everything that opens over the window arrives and leaves one way; reduced motion removes the transition. A leaving dialog takes no press or key, and focus returns to its opener.
- A placeholder holds its box until its content paints, and a later read keeps what is drawn until the fresh answer lands. There is one scrollbar and one picker-row recipe, declared once.
- A sentence says what the person waits for, what happened or what to do next, never the mechanism, held by a contract test (maintainer request, 2026-11-25). Copy says "this Mac" only when the host reports macOS.
- The phone app reads as a native app and shares the product's radius scale, count hues and transcript.

Not built yet:

- Forced colours in the code editor and the terminal: under forced colours a pane's scrollbar falls back to the system's, but the editor's and terminal's thumbs keep the theme's roles, because neither library offers a forced-colours option and no override rule exists in `styles/code.css`.

Status: Partly built. Detail: [DESIGN.md: Product character](../../DESIGN.md#product-character), [Voice](../../DESIGN.md#voice), [Type](../../DESIGN.md#type), [Icons](../../DESIGN.md#icons), [Depth and material](../../DESIGN.md#depth-and-material), [Translucency](../../DESIGN.md#translucency), [Window frame](../../DESIGN.md#window-frame), [Motion](../../DESIGN.md#motion), [Components](../../DESIGN.md#components), [Workspace: Code editor and terminal scrollbars](workspace.md#code-editor-and-terminal-scrollbars), [Application ground](application-ground.md) and the [mobile design system](../../apps/mobile/design-system/README.md).

### The composer

A composer's box holds only attach, the prompt, the microphone and send, on a start screen and under a thread alike. It is one line tall until the person types more and is the composer's one raised surface.

- How the next message runs is one row under the box (model, mode, context ring; the Project first on a start screen). Full access alone keeps its words, in the warning ink.
- A card above the box is only for something the person must read or act on that stays until resolved, most severe first. What passes by itself is one quiet line that takes no layout room, so the transcript never jumps.
- One always-mounted polite status region describes the prompt; refusal and offer cards are alerts.
- The thread's place, info and turn figures live in Environment and [Thread info](#thread-info), not in the composer.

Status: Built. Detail: [DESIGN.md: Composer row](../../DESIGN.md#composer-row) and [Thread view: Draft continuity and composer notices](thread-view.md#draft-continuity-and-composer-notices).

### One theme authority and shared controls

There is one runtime theme authority and one owned control layer. Feature code places and sizes shared controls but never repaints them.

- Feature stylesheets add no raw colour, radius, shadow or control recipe, and feature code composes controls only through the Octant adapters; repository checks hold both, ratcheting existing violations.
- Removing an existing repaint is its own batch per pull request, with before and after screenshots, and the maintainer approves the visual change.
- There is one interaction primitive backend, and the `--octant-*` roles stay the theme source.
- Menus share one row recipe and a 360px maximum (maintainer request, 2026-11-16); desktop context and dropdown menus are native.
- The spinner, keyboard hint and status dot are one adapter each, and list pages with several facts per row draw one shared table, each held by a contract test (maintainer requests, 2026-11-25).
- A visual check in CI fails a pull request that changes a key screen; the `design change` label passes it, and a person commits the new pictures; CI never pushes (maintainer request, 2026-11-18).

Status: Built. Detail: [DESIGN.md: Source of truth and CSS layers](../../DESIGN.md#source-of-truth-and-css-layers), [Enforcement](../../DESIGN.md#enforcement), [Spacing](../../DESIGN.md#spacing), [Menus](../../DESIGN.md#menus), [Components](../../DESIGN.md#components), [Lists and rows](../../DESIGN.md#lists-and-rows) and [Component gallery](../../DESIGN.md#component-gallery).

### Portable design tokens

The design system can be reused outside the app from one generated token set, never from values copied by hand.

- The token files are generated from the renderer's stylesheets, keep the app's names, and are never edited by hand; a repository check fails when they are stale.
- `recipes.css` is built from the tokens only.

Status: Built. Since: 2026-11-12. Detail: [Design tokens and the app feel](design-tokens.md).

### Page shell and Settings organisation

Every list, board, reader and preference page is one `Surface`. Settings groups its pages by what they change.

- A setting lives on the page of the thing it changes. A moved setting or folded page keeps answering links to the old page.
- A page holds the settings of one question, at most thirty, and a page of one to three folds into the page that asks the same question (maintainer decisions, 2026-11-25 and 2026-11-26).
- In a wide window Settings is a sheet over the app, which stays mounted and blurred behind it, on every page and in every window (maintainer decision, 2026-11-26). In a narrow window it covers the window.
- A destination page has one pinned header row and sibling pages end on one right edge (maintainer request, 2026-11-15); toolbars, Agents and Automations follow the page shell (maintainer requests, 2026-11-16 and 2026-11-17).
- A Settings row says what it does in one sentence, with the rest behind its More; a cost, data leaving this computer or an effect that cannot be undone stays in the sentence, and a value control names its default once the value differs (maintainer decisions, 2026-11-25).
- A page shows its own outline while it loads, and background refresh keeps loaded controls and drafts in place.

Status: Built. Detail: [DESIGN.md: Page shell](../../DESIGN.md#page-shell), [Settings layout](../../DESIGN.md#settings-layout), [Empty, loading, and whole-window states](../../DESIGN.md#empty-loading-and-whole-window-states), [Settings: Settings sheet](settings.md#settings-sheet), [Groups and pages](settings.md#groups-and-pages) and [Settings stability](settings.md#settings-stability).

### User profile

The user profile (optional name, email, accent and avatar) authenticates and authorizes nothing.

- The avatar lookup by email hash is the one part that leaves the computer, and runs only on a button press.

Status: Built. Detail: [Settings: Optional Settings details](settings.md#optional-settings-details).

### Approvals and confirmations

Approval and confirmation dialogs default to the safe answer, and the host decides whether an action may proceed, never the card.

- The safe action receives initial focus. Escape, Cancel and backdrop dismissal never change data. Destructive actions opt into the danger treatment.
- An extension tool request names the plugin, its server and the tool, and offers only the choices the host says an approval covers (maintainer decision, 2026-11-12).
- Native Code approvals are isolated host documents. Shared renderer components never grant Code authority, and Enter never implicitly grants access.

Status: Built. Detail: [DESIGN.md: Dialogs and sheets](../../DESIGN.md#dialogs-and-sheets), [OctantConfirmDialog](../../DESIGN.md#octantconfirmdialog), [Settings: Permissions](settings.md#permissions) and [Thread view: Native Code approvals](thread-view.md#native-code-approvals).

### Accessibility baseline

Accessibility is a baseline for every changed surface, not a late pass.

- Text contrast targets 4.5:1 (3:1 for large text and non-text marks), and state always has text, shape or a label besides colour.
- Keyboard focus draws one neutral edge on `:focus-visible` only; feature CSS never suppresses or recolours it.
- No surface is a keyboard trap; the terminal has a documented chord to move focus out, and remappable chords cycle a thread's visible terminals (maintainer request, 2026-11-25).
- Accessibility and appearance settings persist through the server-authoritative journal; renderer state is presentation only.
- A refused server command is never a silent no-op, and loading, denied, empty and error states keep stable geometry.

Status: Built. Detail: [DESIGN.md: Accessibility](../../DESIGN.md#accessibility), [Workspace: Keybinding conflicts](workspace.md#keybinding-conflicts) and [Cycling between terminals](workspace.md#cycling-between-terminals).

### Guarded quit

Quitting the desktop app is guarded so that open provider sessions are never dropped silently.

- Quit and Fully quit share one shutdown that confirms while provider sessions remain open or the host's state is unknown, and an explicit Quit checks every window for unsaved Code Files edits first.
- The quit shortcut needs a second press where a window can show the notice; the guard is a setting, on by default (maintainer request, 2026-11-12).
- Once confirmed, quitting never waits on a person; a fixed deadline ends the app.

Status: Built. Detail: [Workspace: Quitting](workspace.md#quitting).

### Window defaults, ground and drafts

A new window, its background and its drafts behave predictably.

- Without a saved choice, a wide window opens the right dock where the active pane has a dock subject; an explicit show or hide is restored per window.
- A ground is drawn as chosen and stays readable: the ASCII field stays the default, and no set or density inks heavier than it. A photo comes from the host's library, and the host refuses to delete one while it shows.
- Plugins offer character grounds as data only, while installed, trusted and enabled; a pick copies the values.
- A new-task composer keeps its identity while its Project changes; a refused binding keeps the prior authorized Project and the draft. A failed first turn returns its text to the composer with the reason.
- Closing a file tab, the Files tool, its thread or the window checks for unsaved Code Files edits, even when Files is hidden; Save must succeed to continue.

Status: Built. Detail: [Workspace: Right dock and bottom panel](workspace.md#right-dock-and-bottom-panel), [File editing](workspace.md#file-editing), [Application ground](application-ground.md), [Custom grounds](custom-grounds.md) and [Thread view: Draft continuity and composer notices](thread-view.md#draft-continuity-and-composer-notices).

### Usage reading and provider marks

The Usage page reports what was measured and shows each provider with a bundled mark.

- Local provider history and Octant records are separate sources; their totals are never added.
- Unknown prices and missing quota measurements are unavailable, never zero, and a late read never renders.
- Provider logos are bundled and licensed, never fetched at runtime.

Status: Built. Detail: [Settings: Usage](settings.md#usage) and [DESIGN.md: Icons](../../DESIGN.md#icons).

### Reply detail

Reply detail chooses how much of a turn's thinking and tool calls the transcript shows open: Low, Medium or High. Settings › Text sets the default, Low unless changed; a thread may set its own level, which stays with it.

- It is presentation only: it never changes what a model is asked or a client fetches, and shows nothing the transcript does not hold.
- A thread's own level wins over the default and is drawn alike in every window, on the phone and in a paired browser.
- The levels live in the host's shell settings, out of thread journals and export. A window, or a device paired by the host's own person, writes them ([Paired devices act as the person](#paired-devices-act-as-the-person); maintainer decision, 2026-11-13); other clients read them only. Purging a thread removes its level.
- A running turn ends with one working line under its reply, and only a change of step is announced (maintainer decision, 2026-11-24).
- A turn's durations are journaled host facts, never renderer guesses, and a call whose bounds cannot be trusted shows no time.

Status: Built. Detail: [Thread view: Reply detail](thread-view.md#reply-detail), [Turn activity rows](thread-view.md#turn-activity-rows) and [Workspace: Reply detail in the thread in front](workspace.md#reply-detail-in-the-thread-in-front).

## Workspace

### Responsive in-thread Find

Find keeps viewport virtualization: it indexes rendered text in cancellable batches, retains no off-window DOM, and mounts only the current match.

Status: Built. Since: 2026-11-10. Detail: [Find in a thread](workspace.md#find-in-a-thread-and-a-new-thread-from-a-selection).

### Message search in every mode

Each mode has one host read that matches message text in its threads, on the desktop and the phone (maintainer request, 2026-11-14).

- Each read covers exactly the threads its sidebar and Archived group list, applying that authority on the host before the hit cap, and never searches a deleted thread or a rewound turn.
- The reads are GETs a paired device reaches under the overview read grant.
- A hit opens its thread at the matched turn.

Status: Built. Since: 2026-11-14. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects) and [Host reads and commands](host-reads-and-commands.md).

### Search across modes

Thread Search looks in Chat, Work and Code at once through one host read, matching titles, prompts, replies and what tools did (maintainer request, 2026-11-14).

- Only the threads each mode lists for the caller are searched, before the hit cap, so neither a hit nor `truncated` reveals a thread the caller could not open. A paired device reaches it under the overview read grant.
- The index is rebuilt from the journal. The phone falls back to [Message search in every mode](#message-search-in-every-mode) on a host without this read.

Status: Built. Since: 2026-11-14. Detail: [Host reads and commands: Search across modes](host-reads-and-commands.md#search-across-modes).

### Mode-first navigation and Projects

The window is mode-first: a persistent sidebar, a central workspace and an optional right dock. Mode changes alter content, authority and density, never the navigation grammar.

- Each active thread appears once in the Project tree. No Project creates no Project and grants no filesystem authority.
- Sidebar reads are projection-only, and the sidebar timer never walks the checkout tree.

Status: Built. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Developer tools switch on Work Projects

A Work Project's Developer tools switch is presentation, off by default and set only by a person. A Work thread has the same shell, Git and tools as a Code thread at the same level either way.

Status: Built. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Sidebar status and next waiting thread

The sidebar speaks about what a thread is doing now with one fixed vocabulary, and a shortcut jumps to the next thread that needs the person.

- The vocabulary is owned by the domain package. Nothing to report is no status, and a failure is never inferred from silence.
- The jump adds no host read.
- A row's age slot and provider mark never move on hover, focus or an open menu (maintainer request, 2026-11-15); the uncommitted-changes count lives in Environment (maintainer request, 2026-11-16).

Status: Built. Detail: [Workspace: Sidebar thread status](workspace.md#sidebar-thread-status) and [Jump to the next waiting thread](workspace.md#jump-to-the-next-waiting-thread).

### Resuming after a host restart

A turn cut off by a host restart continues by itself unless its thread is held ([Continuing a turn a restart cut off](#continuing-a-turn-a-restart-cut-off)). A held thread shows a notice with an explicit Resume (maintainer request, 2026-11-12).

- Resume re-checks window, provider and Project authority, then queues one host-written continuation; a second window, repeated click or lost response cannot queue a second.
- Resume is not an exact replay: Octant promises neither undo nor deduplication of a tool that took effect before the crash.

Status: Built. Since: 2026-10-28. Detail: [Workspace: Continuing after a restart](workspace.md#continuing-after-a-restart).

### Settling and snoozing threads

A thread can be settled (completed) or snoozed; both are overlays, not lifecycle values. **Settled** is the only name people see, and Un-settle reopens (maintainer request, 2026-11-24).

- Settling is refused, in every mode and by every path, while a turn runs, the thread waits on the person, or its side tasks or child runs still work or owe a report (maintainer decision, 2026-11-25).
- Under **Settle threads when they're done** (on by default; maintainer request, 2026-11-24), a person's Mark done settles, and the host settles only after a passing finished report or a merged delivering pull request, read from cached evidence; Un-settle sticks.
- Nothing else settles a thread, nothing settles a coordinator or a thread with a decision left for the person, and the host never marks a thread Done.
- A host sweep archives only settled threads, after a configurable delay.
- A thread waiting on the person cannot be snoozed; a snooze wakes early when the agent needs the person (maintainer decision, 2026-11-25).
- The palette's settle and snooze commands add no authority (maintainer request, 2026-11-25). A deferred pending question never changes the thread, draft, answer or execution authority.
- Dragging a row onto or out of Pinned, Settled or Snoozed runs the row menu's own command, so the host decides; Snoozed is never a drop target (maintainer decision, 2026-11-26).
- Every sidebar state change the host accepts offers Undo for a moment, sent as a new person command, never a rewrite; Archive has none (maintainer decision, 2026-11-26).
- Files dropped on a thread row open the thread and go to its composer's own attach path (maintainer decision, 2026-11-26).

Status: Built. Detail: [Workspace: Thread visibility and completion](workspace.md#thread-visibility-and-completion).

### Panes, tabs and previews

The central workspace is one recursive split tree with one surface per leaf, and every layout operation is server-authoritative.

- One visible tree belongs to one host and one mode. Each pane keeps its own Project's authority, resolved by the host (maintainer decision, 2026-11-14); a turn reaches only its Project, and a cross-mode, cross-host or other-Project placement is refused or offered in a new window. Detail: [Threads from several Projects in one window](mixed-project-panes.md).
- A pane keeps one conversation; tabs are only for files, previews and canvases over it, and add no persisted layout or authority (maintainer request, 2026-11-16).
- Restoring kept references opens nothing and has no side effect; every later activation is host-authorized. A thread kept in memory is never treated as current before the journal is read again.
- A new task takes the whole window (maintainer request, 2026-11-16).
- File and artifact previews are host-authorized and read-only; the renderer never receives a host path, and active content is off.

Status: Built. Detail: [Workspace: Panes and content navigation](workspace.md#panes-and-content-navigation).

### Thread info

What is true about a thread but is not part of its conversation has one home: a panel opened from the row under the follow-up composer.

- The row under the composer keeps only what changes per message; nothing else about the thread is drawn outside the transcript and composer.
- Rows stay mounted while the panel is closed, and a row waiting for the person marks the button.

Status: Built. Detail: [Workspace: Thread info](workspace.md#thread-info).

### Right dock and thread tools

The dock is contextual: it follows the active pane's thread and Project, and never shows another pane's content.

- Each thread keeps its own open tools; a tool with no valid subject shows an unavailable state.
- A start screen has no dock, bottom panel or tool row, and a request made there is dropped (maintainer request, 2026-11-18).
- Environment is the thread's own surface continued to the right, never a tile; other tools open in columns beside it. A Context section shows only what the host or provider reported (maintainer request, 2026-11-16).
- A tool layout is window-local presentation and changes nothing an agent may do. Every pane has one bar; arranging is by dragging the bar or its Arrange menu, and the title band's tool row is the window's one row (maintainer requests, 2026-11-16).
- Minimised Browser and Terminal cards read only what the tool could show; a card never starts a process, writes to the journal or sends input (maintainer request, 2026-11-16). A closed dock shows no sign.
- The Tasks tool shows the newest task list from the thread's own view (maintainer decision, 2026-11-24).
- A saved layout never starts a new shell, and Git History stays read-only at every level, Plan included.
- Code Review stages, unstages and reverses only exact selected hunks; reversal confirms under the root writer guard, and a stale view never becomes a whole-file change. Review findings become an unsent draft, and only the person resolves a finding.
- Hand off is authorized exactly as export is. The Files tool opens files by host-minted reference, never a path.
- Vitals reads only what the host reports, never zero; a server Project's server is read for a local window or a device [Paired devices act as the person](#paired-devices-act-as-the-person) admits (maintainer decision, 2026-11-12).
- Artifacts lists the thread's Project's artifacts, scoped by the host (maintainer request, 2026-11-13).

Not built yet:

- Vitals of a server Project in a paired device's interface: the server answers the paired device; the paired client's view is a follow-up.

Status: Partly built. Detail: [Workspace: Right dock and bottom panel](workspace.md#right-dock-and-bottom-panel), [Tool lifecycles](workspace.md#tool-lifecycles), [Tool tiles](workspace.md#tool-tiles), [Minimised tools](workspace.md#minimised-tools) and [Environment tool](workspace.md#environment-tool).

### Canvas in the thread

An agent-authored Canvas is drawn read-only inline or offered in the dock, and it belongs to the thread's own resolved scope.

- An inline Canvas gets no layout, plan, comment or action runtime, so nothing drawn there writes a version.
- A prototype starts only when the person presses Run, and Octant never moves focus into it.
- A thread whose binding the host cannot resolve is refused rather than given an assumed scope.
- A turn's Canvases sit inside its last reply (maintainer request, 2026-11-23).

Status: Built. Detail: [Workspace: Tool lifecycles](workspace.md#tool-lifecycles) and [Canvas: Presentation and schema versions](canvas.md#presentation-and-schema-versions).

### Device panes and disposable desktops

Device panes offer only actions the host supports, and input is a separate explicit approval.

- Allow input is a per-destination native approval; clicking the screen or a key button cannot grant it.
- Closing a pane does not shut down its device. A disposable desktop tab never reconnects by itself after a reload.

Status: Built. Detail: [Workspace: Tool lifecycles](workspace.md#tool-lifecycles).

### Routines and subagents

Agents may propose routines and delegate work, but only the thread's agent starts a subagent. A routine exists only through a person's confirmation, on the person's own request (active outside Strict on an unmarked thread, paused under Strict), or at Full access on the agent's own suggestion (maintainer decision, 2026-11-12), active unless the person's Settings keep it paused (maintainer decision, 2026-11-25; [Routines](#routines), [Octant's own limits become settings](#octants-own-limits-become-settings)).

- A proposed follow-up, and below Full access a proposed routine, waits as a suggestion chip; dismissing declines. A routine's runs get at most the creating thread's access.
- An agent's request to pause or archive its routine waits as the same kind of card; dismissing keeps the routine.
- The Agents dock shows and controls subagents without starting them. A provider-started subagent reads "Started by <provider>" and has no managed controls (maintainer request, 2026-11-15); it offers Stop only while the running turn can stop that one alone.
- A subagent's model, summary and usage show only where the runtime reports them, never zero; the summary reaches the person, never the parent's context. A dependency is named only where the window may read that run.
- Subagents show in the transcript and Environment as one summary per pane (maintainer requests, 2026-11-16, 2026-11-17 and 2026-11-18).

Not built yet:

- Stop for a provider-started subagent on Codex and ACP agents: those drivers have no `stopChildAgent` and report it unsupported; Claude and OpenCode have it.

Status: Partly built. Detail: [Workspace: Routines](workspace.md#routines), [Subagents](workspace.md#subagents) and [Environment tool](workspace.md#environment-tool).

### Boards and pull requests

Work and Code have server-authoritative boards. Chat has none, and an agent cannot mark any thread Done.

- Cards cannot be dragged between columns. A person marks a Work thread Done and Reopen undoes it; a Code thread reaches Done by its delivery target or a person's override (maintainer request, 2026-11-12).
- The pull request list is a cached host-local snapshot; board queries never call the forge, which is reached only by explicit refresh or a per-Project opt-in cadence (off by default).
- The Pull requests and Issues pages share one list and reading pane (maintainer request, 2026-11-12; maintainer decision, 2026-11-21). The Auto-refresh and Agents may merge switches keep their server enforcement. Issues ask for no further GitHub access.
- A thread lists every pull request it worked on (maintainer decisions, 2026-11-23). A pull request or issue a thread's tool calls wrote links the thread, by exact identity only; linking starts nothing (approved 2026-11-24).
- An open pull request's next step is one action, and Merge confirms the method (maintainer decision, 2026-11-24).
- A person's journaled unlink wins over all linking evidence (maintainer decision, 2026-11-24). A routine and an agent grant may not unlink; a device may as [Paired devices act as the person](#paired-devices-act-as-the-person) allows (maintainer decision, 2026-11-25).
- Stacks are derived from the cached snapshot and never ask the forge (maintainer decision, 2026-11-25).
- Line notes are window-local and sent to a linked Code thread as one ordinary follow-up; nothing is posted to GitHub (maintainer decision, 2026-11-21). Notes on a pull request whose author is not the signed-in `gh` login, or is unreadable, mark the thread as having read outside content.

Not built yet:

- Pull request and issue references from the OpenCode, ACP and Pi adapters: only the Claude and Codex adapters report them.
- The host in the details card: deferred.
- Stacks on the phone, on board cards and in the Project's list in Environment: deferred.

Status: Partly built. Detail: [Workspace: Boards and integrations](workspace.md#boards-and-integrations), [Pull requests and issues](workspace.md#pull-requests-and-issues) and [Sidebar](workspace.md#sidebar).

### Active work across computers

The Agents page opens on everything not Done on every computer the window already reaches, in the Board's words (maintainer request, 2026-11-25). Bots are not part of it (maintainer decision, 2026-11-25).

- A host answers only for itself, with threads the asking window or device already lists there, under [Paired devices act as the person](#paired-devices-act-as-the-person). No host or hub makes a row for another.
- A computer that does not answer is named unreachable, with no rows. The list follows the sidebar's Environments filter (maintainer decision, 2026-11-26).
- Reads run over sessions already held, with no timer and no journal event.

Status: Built. Detail: [Workspace: Active work](workspace.md#active-work) and [Architecture: Security and authority](../architecture.md#security-and-authority).

### Threads from issues and repositories

A thread or Project can start from a forge issue, a tracker issue or a cloned repository. A Code thread is linked to its issue, and writes back only through [linked issues](#linear-project-mapping-and-reads-for-code-agents).

- Creating from an issue attaches its identity and writes nothing to the tracker; the server reauthorizes, frames redacted text as external content and journals the ingestion.
- A local window, or a device [Paired devices act as the person](#paired-devices-act-as-the-person) admits, may start a Work or Code thread with a labeled text handoff from a provider session in its Project (maintainer decision, 2026-11-12). The server resolves scopes and refuses foreign folders and symlink escapes; clients supply no paths.
- This import never adopts natively and never clones the unverified native writer ([Key providers run as themselves](#key-providers-run-as-themselves)).
- Cloning verifies identity and origin and never overwrites.

Not built yet:

- Starting a session handoff in a paired device's interface: the server policy is built; the paired client's control is a follow-up.

Status: Partly built. Detail: [Workspace: Boards and integrations](workspace.md#boards-and-integrations).

### Thread usage figures

Every thread shows what it used, worded by one shared module, at the top of its [Thread info](#thread-info) panel, never under the composer.

- An unreported figure is absent. A cost says "est." unless the provider reported it.

Status: Built. Detail: [Workspace: Context and usage](workspace.md#context-and-usage).

### Local-server stop authority

Octant stops a local server only when it can prove the server belongs to a live terminal it tracks.

- An exited shell, a reused PID or missing evidence leaves a leftover that needs confirmation. Editor provenance labels never grant stop authority.

Status: Built. Detail: [Workspace: Local-server ownership](workspace.md#local-server-ownership).

### Thread recaps and notes

A thread has a person-visible recap of what it asked, did and left open, and the person may keep notes on it (maintainer decision, 2026-11-14).

- The host reads the recap from the transcript under the thread's open authority; no model writes it, so it goes to no provider.
- Notes are the person's journaled text; the host refuses a note from an agent or itself, and a note reaches the agent only when the person inserts it.
- Neither changes the thread's authority, level or Done.

Status: Built. Since: 2026-11-14. Detail: [Thread view: Thread recap and notes](thread-view.md#thread-recap-and-notes).

### Reserved keybindings

A remapped shortcut never runs alongside, or instead of, undo, redo, the clipboard or Select All.

- Settings › Keybindings refuses a global action on those chords; a saved override on one is reported and the default applies.
- Zen's default chord is Mod+Shift+E (maintainer decision, 2026-11-24).

Status: Built. Since: 2026-11-24. Detail: [Workspace: Reserved keybindings](workspace.md#reserved-keybindings).

## Start screen

### Start-screen cards

Every start screen shows one question, its composer, and one calm list under them. Rows and cards add no authority.

- The composer paints first. Cards read only what the window's own authority returns, and never show fake rows.
- Answers, Open, Stop and Start a fix use the commands the open thread uses; Start a fix only opens a draft.
- Chat, Work and Code share one top-anchored start screen, so New task, choosing a Project or switching mode moves nothing (maintainer request, 2026-11-16).
- The list is laid out from its first frame and nothing above a section moves while it loads (maintainer request, 2026-11-15).
- A start screen has no dock ([Right dock and thread tools](#right-dock-and-thread-tools)).

Status: Built. Detail: [Workspace: Start-screen cards](workspace.md#start-screen-cards), [Start screen: The list](start-screen.md#the-list) and [Card registry](start-screen.md#card-registry).

### Needs you across surfaces

Waiting requests appear on several surfaces from one host list, at a local window or on a device the host's own person paired (maintainer decision, 2026-11-12). The start-screen card, the Inbox and the phone list every waiting ask (maintainer decision, 2026-11-13; maintainer request, 2026-11-22).

- Every surface answers through the mode's own command; the desktop menu bar only opens threads.
- The phone answers memory and routine asks only from a device [Paired devices act as the person](#paired-devices-act-as-the-person) covers (maintainer request, 2026-11-22); any other session sees no buttons.
- A waiting service offer opens in the local window whose turn raised it, never in a substitute window.

Status: Built. Detail: [Start screen: Needs you across surfaces](start-screen.md#needs-you-across-surfaces) and [Workspace: Inbox page](workspace.md#inbox-page).

### Code agent home

Under the Code composer, the start screen is an agent home of work to pick up.

- Picking an item fills the prompt and attaches the issue as the thread's Create-from context.
- Code Home's activity cards count from journaled facts or the signed-in GitHub account's bounded history, name their source, and say when a read is partial.

Status: Built. Detail: [Start screen: Code agent home](start-screen.md#code-agent-home) and [Activity timeframes](start-screen.md#activity-timeframes).

### First-run provider folder scan

On first run, the Project step lists folders the person already used with Claude Code, Codex, OpenCode and Pi, through a bounded host-side read-only scan, and imports the ticked ones as Code Projects in one click through the existing Project create path and folder receipts.

- The scan writes to no provider's files, sends nothing off the machine, and sends the renderer only opaque window-bound IDs and credential-free labels.
- Discovery grants no authority. Strict hides the scan and refuses import, on the server and in the UI.

Status: Built. Since: 2026-11-21. Detail: [Start screen: First-run provider folder scan](start-screen.md#first-run-provider-folder-scan).

## Canvas

### Canvas delivery and the closed block catalogue

An agent delivers anything the person will keep, share or return to as a Canvas, built from a closed, version-gated block catalogue.

- The delivery test is the answer, not the verb; when in doubt the agent makes the Canvas rather than asking.
- Findings with numbers, a trend or a comparison lead with an inline Canvas summary, which stays typed blocks and static designs, never agent-written HTML with script or network (maintainer request, 2026-11-23).
- A document that declares an older schema version but carries a newer block is refused as a future version.
- Diagrams are bounded and re-checked by domain policy before they persist or render; boards embed no third-party canvas engine and run no markup or script.
- A bounded Mermaid subset becomes typed blocks with no new dependency and no Mermaid renderer; styling is dropped, and a diagram outside the subset is refused with a typed reason and keeps its source as a code block (maintainer decisions, 2026-11-12 and 2026-11-13).

Status: Built. Detail: [Canvas: Agent tool and recipes](canvas.md#agent-tool-and-recipes), [Presentation and schema versions](canvas.md#presentation-and-schema-versions) and [Diagram boards and comments](canvas.md#diagram-boards-and-comments).

### Canvas preview

The agent's `preview` returns typed layout warnings and a picture drawn in a no-network headless browser.

- A model that accepts no images, or a host with no browser, still gets the warnings and a sentence saying why no picture was taken.
- A Canvas read or previewed by another thread carries its outside-content mark to the reader.
- The tool step keeps a reference to the version it drew, never the picture, and the opened row draws it under the window's own Canvas authority (maintainer request, 2026-11-23).

Status: Built. Detail: [Canvas: Preview and placement in the thread](canvas.md#preview-and-placement-in-the-thread).

### Designs and prototypes

A design is the author's own markup in sandboxed frames. A design that runs script is a prototype with no route out unless the person allows the network for that Canvas.

- No frame has both `allow-scripts` and `allow-same-origin`, and a static frame never gets `allow-scripts`. Design markup loads nothing remote and links only to fragments.
- A prototype runs only on Run. Allow network is off by default and only the person sets it, at a window or on a device the host's own person paired; agents, routines, hub-introduced and restricted devices are refused (maintainer decision, 2026-11-12).
- With it on, a page on the host's machine reaches public addresses only through the host's filtering proxy, under a short-lived renewed token (maintainer decision, 2026-11-13). In a browser on another machine the prototype is not network-contained, and says so.
- Sharing design markup needs the person's acknowledgement that it leaves as written.

Not built yet:

- The Allow network switch on the phone: the phone has no screen for it yet.

Status: Partly built. Detail: [Canvas: Design block](canvas.md#design-block) and [Canvas: Allow network](canvas.md#allow-network).

### Boards and comments

Diagram and flow boards are editable by a local person, and comments are journaled facts the host stamps itself.

- A drag or nudge is journaled as a new immutable version with the host's own actor; a stale drag is refused.
- A window on this host or a device the host's own person paired edits boards and comments; a hub-introduced device is refused (maintainer decision, 2026-11-12; [Paired devices act as the person](#paired-devices-act-as-the-person)).
- Send to agent queues a turn under the thread's own authority. The tool rail and drawn marks (areas, pen lines, notes) only choose a comment's anchor: they journal nothing and add no command, route or authority.

Not built yet:

- Board editing in the paired browser and phone: the server admits it, the paired screens are a UI follow-up.

Status: Partly built. Detail: [Canvas: Diagram boards and comments](canvas.md#diagram-boards-and-comments).

### Choices answered in a Canvas

A `choice` block asks the person a question inside a Canvas, and their answer goes to the Canvas's own thread as their own ordinary message.

- The block has no question limit; only the inline `ask-user` questionnaire keeps its four-question ceiling, and agents are told to use a choice block whenever they need more than four answers.
- Only an explicit Send enqueues the answer on the owning thread's message queue, under its existing authority. It is never a host-initiated turn or an approval.
- Where no thread can take the answer (a paired client, a share, an export, an older version and the like) the block reads only, with a reason. HTML design frames gain no submission ability.

Status: Built. Since: 2026-11-11. Detail: [Canvas: Choice block](canvas.md#choice-block).

### Decision forms in a Canvas

A `choice` block is also how an agent asks for many decisions at once: sections, notes, answers saved as they are made, an accept-recommendations action, and a `read` that returns the answers.

- It follows [Choices answered in a Canvas](#choices-answered-in-a-canvas) for when agents use it.
- Answers are journaled facts the host stamps as the local person, not document versions. No agent operation writes an answer, and a paired client reads and cannot write.
- Send answers wakes the agent through the thread's message queue and is never an approval. Accepting recommendations never replaces an answer.
- Shares, public links and exports never carry answers or notes; artifact sync carries them across the person's own computers.
- Owed checks: rendered QA of a 24-question form, and a real-provider smoke of an agent building and reading one.

Status: Built. Since: 2026-11-12. Detail: [Canvas: Decision forms](canvas.md#decision-forms).

### Canvas shares and exports

A share names its Project and is judged against it.

- A Chat thread's Canvas outside every Project is shared only through the export destinations, which a window in Chat is offered as for any Canvas (maintainer request, 2026-11-12).
- A share that declares an older version but carries a newer block is refused. Action blocks and source ids never leave, and exports carry no tags.

Status: Built. Detail: [Canvas: Shares](canvas.md#shares).

### Artifact library and tags

The Artifacts library is host-wide across Projects: the deliberate exception to per-window Project read scoping.

- The server decides the library's scope; a paired device is clamped to the Projects its catalog allows.
- Tags are the person's own host-local labels. They never enter a Canvas version, a share, an export or sync.
- A device the host's own person paired changes tags, reads a Claude page snapshot and copies one into a Canvas as a window does (maintainer decision, 2026-11-12; [Paired devices act as the person](#paired-devices-act-as-the-person)).
- The library lists the pages threads published through Claude's `Artifact` tool, built from the journal alone, so only pages published from Octant appear (maintainer decision, 2026-11-16).
- Snapshot reads and Copy into Canvas run under the publishing thread's own read check, in its Project and mode, through [HTML import](#html-import).

Not built yet:

- Tag changes, snapshot reads and Copy into Canvas in the paired browser and phone: the server admits them, the paired screens are a UI follow-up.

Status: Partly built. Detail: [Canvas: Artifact library and tags](canvas.md#artifact-library-and-tags).

### HTML import

A person can bring one HTML page into a new Canvas. The import adds no authority and no network egress.

- It runs under the create path's authority, from a local window or a device the host's own person paired (maintainer decision, 2026-11-12). The host checks a paired request's named mode and Project before journaling the create as the device.
- Scripts, remote assets, external links and form destinations are taken out and reported. The Canvas is marked outside content for every later reader, and its title is what the person typed.

Not built yet:

- A paired device's plain Canvas create: not built, so **Import HTML…** stands alone in the paired Canvas tools.

Status: Partly built. Detail: [Canvas: HTML import](canvas.md#html-import).

### Canvas visual system

Charts, tables, mockups, designs and flow boards share one visual system.

- Hue lives on the mark, never on the chrome, and every mark pairs hue with a second channel. A block that cannot be drawn falls back to a plain reading and a table.
- A mockup is inert. Octant never restyles a design's inside.

Status: Built. Detail: [Canvas visuals: Data visualisation](canvas-visuals.md#data-visualisation), [Mockups and designs](canvas-visuals.md#mockups-and-designs) and [Flow boards](canvas-visuals.md#flow-boards).

### Project design systems

A Work or Code Project's design system is a `DESIGN.md` in its folder. Every Work and Code turn follows the governing one, Canvas designs and typed blocks draw with its tokens, and a person can swap the design system a Project or a single Canvas follows (maintainer requests, 2026-11-10 and 2026-11-11).

- The file is the source of its content, never copied onto the Project record or journaled. Which file is the Project's own is the person's journaled choice.
- A window on this host or a device the host's own person paired may list, read, create, save or switch a design system; every other device session is refused (maintainer decision, 2026-11-12). A save replaces only the revision it opened, and no read or write follows a link.

Status: Built. Since: 2026-11-10. Detail: [Project design systems](design-systems.md).

### Public links

A public Canvas link is off by default and exists only through the person's explicit act.

- While the Settings switch is off no request reaches the service; turning it off keeps existing links revocable.
- A link is published only through the export approval card, which no agent tool reaches. A device the host's own person paired prepares, approves, updates and revokes as a window does; hub-introduced and restricted devices are refused (maintainer decision, 2026-11-12).
- A paired device reads a Canvas under thread read authority, never by switching the host's Project, and a refusal does not reveal whether the Canvas exists.
- The payload is a frozen copy with no host, Project, thread or source ids and no file contents, carrying only the images the document displays, each shown on the card (maintainer decision, 2026-11-22).
- The per-share owner secret lives in the credential broker, never in the journal. The service has no accounts and logs no IP address.
- The reference service is `apps/share`, self-hosted by each user; no service address is set by default and Ogard Labs operates no instance. Share schema version 18 and the service must be deployed before a release publishes it.

Not built yet:

- Publishing, updating and revoking a link from the phone: the phone has no screen for it (the paired browser offers them).

Status: Partly built. Since: 2026-10-20. Detail: [Canvas public links](canvas-public-links.md#off-until-the-person-turns-it-on) and [Publishing is the person's act](canvas-public-links.md#publishing-is-the-persons-act).

## Artifact sync

### Signed append-only replica entries

Artifact sync writes one signed, write-once entry per committed version or deletion, and reconciliation never overwrites.

- A bad signature, an unknown or revoked writer, or a content-hash mismatch is refused.
- Concurrent revisions keep both heads; a deletion is a tombstone that stays in the history.

Status: Built. Detail: [Artifact replica sync: Entries](artifact-replica-sync.md#entries) and [Store](artifact-replica-sync.md#store).

### Replica membership

Membership is a pure function of the pinned founder and the valid signed membership records.

- Only a strict ancestor can revoke a computer; a revoked computer's entries count up to its cut.
- A Full device may manage membership as a local window does ([Paired devices act as the person](#paired-devices-act-as-the-person)).

Not built yet:

- The membership route refuses a request whose host is not loopback before it authenticates, so a paired device does not reach it yet (`replicaMembershipRoutes.ts`): a follow-up.

Status: Partly built. Detail: [Artifact replica sync: Membership, as wired today](artifact-replica-sync.md#membership-as-wired-today).

### Leaving a replica

A computer may leave a replica, the founder included.

- When the founder leaves, the computers it approved directly can never be revoked, and no computer can take over as founder.
- Leaving needs a reachable store, unless the person confirms leaving without it.

Status: Built. Since: 2026-10-14. Detail: [Artifact replica sync: Membership, as wired today](artifact-replica-sync.md#membership-as-wired-today).

### Artifact publish and pull

Every committed Canvas version is queued for publish through the share filter, and nothing is called while sync is off.

- An imported entry is never republished, and nothing backfills on its own: historical versions need a reviewed destination, explicit selection and consent.
- A synchronized deletion is a separate, confirmed tombstone; a local erase never publishes one.
- Comments and decision-form answers on carried Canvases use the same signed, share-filtered queue.

Status: Built. Detail: [Artifact replica sync: Artifact sync: publish and pull](artifact-replica-sync.md#artifact-sync-publish-and-pull).

### Store selection

Choosing the sync store is the person's act, at a local window or a Full device ([Paired devices act as the person](#paired-devices-act-as-the-person)); it is journaled and starts with sync off (maintainer decision, 2026-11-12).

- Choosing or changing the store turns sync off. A member of a replica cannot change the store's kind or location.
- Bucket keys live in the credential store and are never journaled.

Not built yet:

- A paired device does not reach the store yet: the `/api/replica-store` routes answer only a loopback host name before authenticating (`replicaStoreSettingsRoutes.ts`), and there is no paired screen: a follow-up.

Status: Partly built. Detail: [Artifact replica sync: Store selection](artifact-replica-sync.md#store-selection).

## Browser

### Browser captures

Only an explicit screenshot or recording is kept, and it stays with the thread.

- A capture is kept at a window or a Full device; other devices, the thread-less Project browser and a terminal CLI keep nothing. Whoever opens the thread as the person reads its captures and steps.
- Plan refuses a recording. A recording skips credential, unchecked and off-origin pages.
- Bytes live under the data directory, never a Project; the journal holds metadata and a hash. The person sets how many a thread keeps (maintainer request, 2026-11-12). Captures leave the host only in the owner's thread or data export.
- Steps never keep typed text, field values or secret query values.
- "Pick element" keeps nothing, never reads form values or scripts, and marks the thread as holding outside content (maintainer decision, 2026-11-14).
- Proof reaches a pull request only when the person chooses "Include Browser proof". Screenshots are saved to a folder picked at a local window, never uploaded.

Not built yet:

- Attaching Browser proof from a paired device: the host reads the proof for a Full device, but the paired shell has no pull-request form.

Status: Partly built. Detail: [Browser captures](browser-captures.md): [What is kept](browser-captures.md#what-is-kept), [Retention](browser-captures.md#retention), [Proof](browser-captures.md#proof), [Recordings](browser-captures.md#recordings) and [Picking an element](browser-captures.md#picking-an-element).

### Browser for agents

The agent's Browser tool reads a page as an outline with element refs and acts by ref. The server admits every operation, and every provider gets the same tool.

- Refs live on the server; a stale ref is refused before the action runs. A credential field reads protected with no value.
- A Private page needs no site approval at any level and goes to any site, local ones included (maintainer decision, 2026-11-17). A profile page's site approval waits for the person on no clock (maintainer request, 2026-11-12).
- A Full device acts on every Browser surface as a window does (maintainer decision, 2026-11-12; [A paired device holds a Browser page](#a-paired-device-holds-a-browser-page)).
- Waits have no limit outside Strict; under Strict they take the Settings › Limits value (maintainer decision, 2026-11-19; [Octant's own limits become settings](#octants-own-limits-become-settings)). No dialog waits for a model turn (maintainer request, 2026-11-12).
- `sign-in` hands the page to the person with no expiry and widens no origin approval. Routine, subagent, terminal-grant and restricted device turns are refused it.
- A window or Full device manages flows; a routine may run but not save one. Flows are never exported or synced.
- The person's input reaches the page while the agent acts and is never dropped. **Take over** gives the person the page until **Hand back** or the agent's next call (maintainer decision, 2026-11-17).
- No password saving.
- The bounded script operation runs in Work and Code at Full access (maintainer request, 2026-11-12); below it a local Code task asks for one exact-source permission, never remembered. Plan and credential fields refuse.
- An address the person types, at a window or a Full device, is their own browsing: its redirects are followed, an off-origin site shows only to the person, and the agent gains nothing. A restricted or hub-introduced device's navigation keeps the approved-origin rule (maintainer decision, 2026-11-26). The headless Browser holds the typed site (maintainer decision, 2026-11-17).
- Both Browsers refuse a page-started navigation onto this computer or its network before checking the allowlist or grants.
- Audits read the open page without changing it, and their results stay on this computer.
- A Project's threads each reach only their own page context, checked on the server.

Not built yet:

- A script permission for Work below Full access: Work is refused until it gets Code's permission under [Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on); designed, not built.

Status: Partly built. Since: 2026-11-01. Detail: [Browser for agents](browser-agent-tool.md), from [Page snapshot](browser-agent-tool.md#page-snapshot) to [Bounded page scripts](browser-agent-tool.md#bounded-page-scripts), and [Workspace: Browser toolbar](workspace.md#browser-toolbar).

### Agent downloads

At Full access an agent's download is saved into `downloads/` of the thread's workspace as the action that started it answers. Below Full access it is held outside the workspace and saved only on the person's answer, unless the person turned on "Let agents download files".

- "Let agents download files" is off by default and set by the person (maintainer request, 2026-11-12). At Full access no download is held for a second call; the size cap, link checks and journal record stay, since none of them is a review (maintainer decision, 2026-11-13).
- Below Full access `download-save` asks; "Always allow" is remembered per site, workspace folder and profile, in Work and Code alike (maintainer decisions, 2026-11-12 and 2026-11-13). An unanswered ask never expires into a refusal.
- A page origin grants no download provenance; an unproved source reads as unverified.
- Programs, installers and scripts are refused only below Full access. A symbolic link is refused. A terminal grant and Plan cannot save. A Full device saves as a window does; a hub-introduced device is refused (maintainer decision, 2026-11-12).
- A download the person starts in the Browser pane saves to the Downloads folder at every level.
- A save creates only an exclusive name in a verified directory, so a swap cannot redirect it. A routine's recurring download needs the person's separate manifest; restart restores no grant.

Not built yet:

- Downloads in the paired browser and phone: the server admits a Full device, the paired screens are a UI follow-up.
- A person's Browser pane download in a packaged window: not yet run.

Status: Partly built. Since: 2026-11-12. Detail: [Browser for agents: Download](browser-agent-tool.md#download) and [Recurring download manifests](browser-agent-tool.md#recurring-download-manifests).

### Agent uploads

An agent uploads only plain files from the thread's workspace by relative path. At Full access an upload does not ask; below it, it asks.

- File size and count are Settings defaults, not constants (maintainer decision, 2026-11-13).
- "Always allow" is remembered per site, workspace folder and Browser profile, in Work and Code alike; one given on a Private page covers Private pages alone (maintainer decisions, 2026-11-12 and 2026-11-13). An unanswered ask never expires into a refusal ([the Full access rule](#the-full-access-rule)).
- A Full device's "Always allow" is remembered as a window's; a restricted or hub-introduced device's answer covers one transfer only.
- A routine's recurring upload needs the person's separate manifest; children, terminals and ordinary turns inherit none, and restart restores none.

Status: Built. Since: 2026-11-12. Detail: [Browser for agents: Recurring upload manifests](browser-agent-tool.md#recurring-upload-manifests).

### Browser profiles and extensions

Browser pages may keep sign-in in a Project or Personal profile. Private is the initial default, and extensions are enabled only per profile.

- A task's default profile is a default, not a grant. Refused or expired stored access never falls back to Private.
- On a profile page the agent needs a site approval per origin and profile, for reading too, at every level, Full access included (maintainer request, 2026-11-12). Credential fields stay protected.
- A persistent grant survives restarts only when a clean close journaled it and nothing it binds changed (maintainer request, 2026-11-12).
- A child, routine or terminal gets stored-profile access only through the person's bounded, expiring session permission; reviewed at a window or a Full device, refused to other devices.
- Only the person installs and enables extensions, at a window or a Full device (installing from a folder needs the native picker, so it stays at a window); any other device may list them. Install never enables; no agent, plugin or skill installs or enables.
- Background native ownership is a default-off host preference and lends no other authority. Idle execution pages hibernate (maintainer request, 2026-11-14); packaged acceptance in the native test Space is a check still owed.
- A selected-item permission lets the host fill one reviewed item; each fill needs a fresh review and approval, and values never reach the agent.

Not built yet:

- A restored persistent grant takes no lease on the background native owner, so it runs only while a window holding its Project is open: not wired yet.

Status: Partly built. Since: 2026-10-31. Detail: [Browser profiles and extensions: Profiles](browser-profiles.md#profiles), [Delegated sessions](browser-profiles.md#delegated-sessions) and [The agent on a signed-in page](browser-profiles.md#the-agent-on-a-signed-in-page).

### Terminal Browser grant

A person can lend a Code thread's Browser to a CLI in that thread's terminal, with no new authority.

- Off by default, switched on per terminal by the person, at a window or a Full device. Another device, a routine or an agent cannot ask.
- Calls run as the thread under the existing Browser policy and approvals; the grant lives in memory and its token is never journaled.

Not built yet:

- A switch in the paired client: the host admits a Full device's request, but the paired client shows no switch (UI follow-up).

Status: Partly built. Detail: [Terminal Browser grant: Current behavior](terminal-browser-grant.md#current-behavior) and [Lifecycle](terminal-browser-grant.md#lifecycle).

### Search queries on a tainted thread

Under Strict, on a tainted thread the harness refuses a web search query that looks like it carries data, before any request leaves. Outside Strict Octant adds no such filter: the query goes to the person's configured endpoint and the thread keeps its mark (maintainer decision, 2026-11-21).

- Under Strict, choosing Full access for a thread or a Project's new threads lifts it. A caller that cannot say whether Strict is on keeps the refusal.
- Rationale: it refused ordinary searches, and the query reaches only the person's own endpoint ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).

Status: Built. Since: 2026-11-21. Detail: [Search queries on a tainted thread](search-query-taint.md#refused-patterns).

### Browser profiles with cookie import

The person may import cookies from another browser into a Project or Personal profile.

- Octant never opens another browser's profile in place; only the person's explicit pick brings its cookies in.
- Import stays at a local window, since the Keychain prompt appears on the Mac (maintainer decision, 2026-11-19). Cookies are never logged, journaled, returned to a window or sent off the Mac.
- The person selects a named account profile at a window or a Full device; other devices and unattended callers are refused. Stores are never exported or synced.

Status: Built. Since: 2026-10-31. Detail: [Browser profiles and extensions: Cookie import](browser-profiles.md#cookie-import).

### A paired device holds a Browser page

A Full device takes over, drives and hands back a page of the desktop's native Browser, answers `sign-in`, uses profile pages, and runs flows, as a window does (maintainer request, 2026-11-18). Who counts is set in [Paired devices act as the person](#paired-devices-act-as-the-person).

- Take over opens a lease bound to the page and the device's session; local input at the Mac reclaims the page at once.
- The device sends only input events, never a URL, script, clipboard read, path or credential operation. The host's clipboard never reaches it.
- Frames and input are person-only: never in observations, captures, the journal or logs, and the agent is paused for the lease. Holds are journaled.
- A hub-roster device, an agent grant and a caller with no session are refused `remote-control-not-person`.
- A live real-device smoke in the packaged app is still owed.

Status: Built. Since: 2026-11-18. Detail: [Browser for agents: A paired device holds the page](browser-agent-tool.md#a-paired-device-holds-the-page) and [Browser profiles: What a paired device sees of a signed-in page](browser-profiles.md#what-a-paired-device-sees-of-a-signed-in-page).

### Page-declared tools

The Browser agent tool reads the tools a page declares for agents and calls them on that page (maintainer decision, 2026-11-14).

- A declaration is outside content: listing one marks the thread, and it adds no tool by itself. A form with a credential field is never listed or called.
- Below Full access each call asks, never remembered. At Full access it runs unasked unless [The Full access rule](#the-full-access-rule)'s pay, buy or send-as-the-person entry covers it.
- Running the desktop path in the app is a check still owed.

Status: Built. Since: 2026-11-14. Detail: [Browser for agents: Page-declared tools](browser-agent-tool.md#page-declared-tools).

## Provider runtimes

### Key provider sandbox and approvals

Under Strict, a key provider's app-server runs inside Octant's own sandbox profile and is told the sandbox is external; so does a launch given no Strict value. Strict off uses the provider's own confinement and approvals, and Full access outside Strict runs the provider unwrapped.

- A process carries one lease, and a different authority on the same connection is refused.
- Under Octant's sandbox, Ask first and Accept edits ask for each command not known to be read-only. Plan and Chat never prompt; a write fails at the sandbox.
- Windows: [Windows below Full access](#windows-below-full-access).

Status: Built. Detail: [Provider runtimes: Codex](provider-runtimes.md#codex).

### Provider-published artifacts

A key provider's artifact publishing is off for every account until the person enables it on the host, and Canvas stays the default.

- The switch is per account and the host's own person's (maintainer decision, 2026-11-12), refused for API-key and gateway accounts and where the host exports its own telemetry opt-out.
- Enabling says it also turns on the provider's usage telemetry; the launch lifts only that one guard, and the person's own opt-out always wins.
- Each publish asks below Full access. Plan never publishes, and published pages are outside content.

Not built yet:

- Changing the switch from a paired device: today only the host's own window changes it.

Status: Partly built. Since: 2026-10-28. Detail: [Provider runtimes: Claude Code](provider-runtimes.md#claude-code) and [Model endpoints: provider artifacts](model-endpoints.md#claude-artifacts).

### Claude Code's Code Mode is a recorded gap

Claude Code's Code Mode runs only in an interactive terminal session, so Octant's sessions do not carry it yet; it is recorded as a gap to close (maintainer decision, 2026-11-14).

- Octant adds no terminal mode for it. A provider terminal opens Claude Code's own interface with the thread's launch environment (maintainer decision, 2026-11-21).
- Once the Agent SDK supports Code Mode, Octant offers it under the thread's level.

Not built yet:

- Code Mode in Octant's sessions: the Agent SDK does not support it yet.

Status: Designed, not built. Since: 2026-11-14. Detail: [Provider runtimes: Code Mode](provider-runtimes.md#code-mode).

### Lightweight-runtime app tools

App-managed tools reach a lightweight-runtime session from 0.85.1 when its probe attests the tool bridge; a later attesting release needs no Octant release.

- An older or non-attesting release refuses a session that offers tools, naming 0.85.1.
- A resume that names another model is refused.

Status: Built. Detail: [Provider runtimes: Pi](provider-runtimes.md#pi).

### ACP agents share one stack

Every ACP agent runs on one shared driver stack. A new agent is a profile, a logo and conformance evidence, never its own transport, supervisor, protocol client or event mapper.

- A capability an agent lacks is reported unsupported, never imitated or estimated. One ACP process serves one Octant session, and malformed or contradictory protocol input is an error.
- Every agent records usage (maintainer decision, 2026-11-20); each built-in profile's usage reply shape is a live-probe check still owed.
- Octant's tools reach a session only through the session tool bridge, when the agent advertises HTTP tools; otherwise a session offered tools is refused.
- A session-kept approval uses the agent's own `allow_always`, never for a one-call answer or under `project-default` persistence (maintainer decision, 2026-11-21).
- A turn's silence budget is a hard cut-off in every mode (maintainer decision, 2026-11-22).

Status: Built. Detail: [Provider runtimes: ACP agents](provider-runtimes.md#acp-agents) and [Probe before a profile ships](provider-runtimes.md#probe-before-a-profile-ships).

### Local-server provider adapter

A local-server provider adapter gives each acquired connection its own process and one live session. Under Strict below Full access, app tools reach it only when a process receipt proves outside tool sources cannot enter.

- Outside Strict, and at Full access, a runtime that cannot prove exclusivity is offered Octant's tools labelled as mixed (maintainer request, 2026-11-12).
- Child sessions, a routine's Browser target and saved flows follow the level the turn runs at (maintainer decision, 2026-11-13).
- Calls bind to the connection's session and offered catalogue, and pending tool requests retire when the process or stream ends.

Status: Built. Detail: [Provider runtimes: Local-server provider adapter](provider-runtimes.md#local-server-provider-adapter).

### Runtime updates

Octant tells the person when a newer runtime release exists, and runs the runtime's own updater only when they click **Update CLI**. Discovery never installs or updates anything.

- The lookup is anonymous, follows the Marketplace fetches switch, and is never made at discovery.
- The updater runs only on the owning host when no session uses it; the renderer never receives an updater command, and a failure reaches a client only as a bounded diagnostic.

Status: Built. Detail: [Provider runtimes: Runtime updates](provider-runtimes.md#runtime-updates).

## Model endpoints and organization sign-in

### Provider catalog

Settings lists bundled provider drivers, runtimes and model endpoints in separate sections. Opening a catalog page runs nothing ([Provider catalog, discovery and outside drivers](#provider-catalog-discovery-and-outside-drivers)).

- A trusted outside driver's provider is added off. A scan never turns a runtime on.

Status: Built. Detail: [Model endpoints: provider catalog](model-endpoints.md#provider-catalog).

### Sign-in lifecycle in Settings

Opening Settings never starts a sign-in or acknowledges terms. Sign-in begins from an endpoint's detail page.

- Sign-out that fails to revoke keeps the grant and offers an explicit local-only removal.
- An organization endpoint offers no key, and changing its binding signs it out.

Status: Built. Detail: [Model endpoints: subscription sign-in lifecycle](model-endpoints.md#subscription-sign-in-lifecycle).

### Endpoint addresses, keys and model limits

A model endpoint's key belongs to the address it was entered for, and a model's limits come from the best source that names them.

- A saved address change deletes the stored key.
- User-supplied model metadata can make a model selectable but never authorizes a side effect.

Status: Built. Detail: [Model endpoints: endpoint address and stored key](model-endpoints.md#endpoint-address-and-stored-key).

### Organization identity stays in the broker

An endpoint can sign in with an organization directory account or a cloud identity. Reusable identity material lives only in the credential broker, and the server sees at most one short-lived, audience-bound credential per request.

- A missing, expired or mis-bound identity reads honestly and never falls back to another sign-in.
- A remote principal other than a person-paired device never starts a sign-in, refreshes, signs out or changes broker material; it may run turns on a signed-in instance.
- A sign-in binds to its tenant or issuer, client and endpoint origin.
- Live checks against a real tenant, gateway and cloud account are maintainer live checks still owed.

Status: Built. Since: 2026-10-26. Detail: [Enterprise provider identity](enterprise-provider-identity.md#authentication-vocabulary).

### Organization sign-in flows

Each organization sign-in uses the narrowest flow that works. The organization registers its own public client; Octant needs no account of its own, and another product's client id is refused.

- A provider device code begins and shows only on the host, in its terminal or a local desktop window (maintainer request, 2026-11-12). No unauthenticated page, remote browser, hub, peer or agent grant begins one or sees a code, since a code on a page someone else can reach is how device-code phishing works.

Not built yet:

- A paired device beginning a device-code sign-in over its authenticated session (maintainer decision, 2026-11-12): the host-local routes are not forwarded to paired devices yet.

Status: Partly built. Since: 2026-10-26. Detail: [Enterprise provider identity: maintainer decisions](enterprise-provider-identity.md#maintainer-decisions).

### Identity paths not offered

Two identity paths are deliberately not offered.

Not built yet:

- A cloud sign-in whose bearer is valid across the whole account (Google Vertex): deferred until an organization needs it; the only acceptable shape is a broker-side relay forwarding to the bound host.
- Organization identity for runtimes that spawn a child: they keep their own delegated login and report organization identity kinds incompatible; a host relay needs its own design.

Status: Partly built. Since: 2026-10-26. Detail: [Enterprise provider identity: maintainer decisions](enterprise-provider-identity.md#maintainer-decisions).

## Outside provider drivers

### Admission of an outside driver

An outside driver is a harness-endpoint transport or a media generator, installed from outside Octant; outside agent CLIs and managed processes are not admitted.

- One "Install and trust" flow runs inspect, install, trust and enable in order, and each step stays available on its own (maintainer request, 2026-11-12).
- Only the host's own person runs these steps, journaled (maintainer decision, 2026-11-12).
- A driver is a single ES module with no executables, native addons or install scripts.
- The live loopback smoke on macOS is a maintainer check still owed.

Not built yet:

- The one flow for a package that holds no provider driver: the host refuses it today.

Status: Partly built. Since: 2026-10-26. Detail: [Outside provider drivers: admission lifecycle](outside-provider-drivers.md#admission-lifecycle) and [first use case](outside-provider-drivers.md#first-use-case-an-outside-harness-endpoint).

### Outside driver confinement and credentials

Each outside driver instance runs in its own confined process with no network, no filesystem beyond its package and no credential; the host makes the network call.

- The host leases a key for that instance only and reaches only the base-URL origin the person entered.

Status: Built. Since: 2026-10-26. Detail: [Outside provider drivers: driver process](outside-provider-drivers.md#driver-process-and-confinement) and [credentials and egress](outside-provider-drivers.md#credentials-and-egress).

### Outside driver provenance and updates

Updates are never automatic, and trust binds a content digest. Marketplace packages must be signed; local folders are unsigned developer input.

- A new digest arrives held and untrusted. An update the pinned publisher key signed keeps its trust; anything else, or an update that widens what the package may do, asks again (maintainer decision, 2026-11-12).
- Nothing from a package runs when it is fetched.

Status: Built. Since: 2026-10-26. Detail: [Outside provider drivers: provenance and updates](outside-provider-drivers.md#provenance-and-updates), [signature rules](outside-provider-drivers.md#signature-rules) and [npm source](outside-provider-drivers.md#npm-source).

### Outside media generation drivers

An outside package can provide an image or video generation driver, admitted like any other plugin, and Octant's media tools use it as a bundled driver, under the same prices, spend limits and storage (maintainer approval, 2026-11-22).

- Prices come only from the manifest at the trusted digest; an unpriced model is refused under a spend limit, and nothing settles above its reservation.
- Cost is decided from what the host saw, never from what the driver says.

Not built yet:

- The Settings form that changes an outside media profile's address or models: not built yet.

Status: Partly built. Since: 2026-11-22. Detail: [Outside provider drivers: outside media generation drivers](outside-provider-drivers.md#outside-media-generation-drivers).

## Device workbench and mobile

### Simulator pane and captures

The iOS Simulator pane shows the Simulator's screen streamed through the host as a live view, authorized like a screenshot and never stored. Without a live view it shows the latest host-held screenshot evidence.

- A raw capture lands in a host-private directory the confinement profile denies to every launch but the capturing one.
- Live frames are never journaled or put in model context.
- Owed checks: a packaged-app device check and an Android emulator device check.

Status: Built. Detail: [Device workbench: device pane](device-workbench.md#device-pane) and [screen captures](device-workbench.md#screen-captures).

### Device input

Simulator input (tap, swipe, key, typed text) goes only through the native device helper. Octant never scripts the Simulator app, and without the helper input is unavailable.

- Typed text is refused whole unless Octant can type it exactly, so it never types the wrong text.
- Each action's evidence records who asked (Agent, You, Remote device, Octant). Typed and secure-field text never enters durable evidence verbatim.
- A swipe carries the same authority, approval and Plan refusal as a tap. Pinch, multi-touch, long press and follow-the-finger drag are accepted non-goals.

Status: Built. Detail: [Device workbench: input channel](device-workbench.md#input-channel), [typed text](device-workbench.md#native-device-helper-and-typed-text), [swipes](device-workbench.md#swipes) and [accepted limits](device-workbench.md#accepted-input-limits).

### Device effects

Open URL, Rotate and Record screen are effects, not input. A person or an agent may request them, and Allow input never covers them (maintainer request, 2026-11-12).

- Repair input is input: a live Allow input grant covers it whoever asks, also as the agent's `repair-input` (maintainer decisions, 2026-11-12 and 2026-11-13).
- Plan refuses effects. At Full access an agent's request is sent unasked; below it the thread confirms each. The host asking on its own is refused.
- Open URL accepts only a credential-free http or https address, and its evidence keeps only the origin.
- Owed checks: the effects on a real Simulator and a real emulator.

Status: Built. Detail: [Device workbench: Open URL](device-workbench.md#open-url).

### Managed device tools and the Android emulator

The streaming tools behind the device panes are vendored, pinned and integrity-verified, and run unconfined under Octant's signed identity with an allowlisted environment. The Android emulator is a separate dock destination and tool.

- Updates are off by default and activate only while idle, after a smoke launch; a failed release keeps the previous one.
- The tools receive no provider keys, tokens or broker credentials. Octant installs only a checkout-relative APK and never stops the shared debug-bridge server.
- Emulators cold boot by default; snapshot boot is a setting (maintainer request, 2026-11-12). Shutdown is approval-gated.

Not built yet:

- A confinement profile for the managed tools: not written yet, so they run unconfined.

Status: Partly built. Detail: [Device workbench: managed device tools](device-workbench.md#managed-device-tools), [Android](device-workbench.md#android) and [boot](device-workbench.md#boot-from-the-android-pane).

### The phone is a remote client

The host is authoritative for mode, Project, thread, provider, approval and Done. The phone runs no agent loop and holds no checkout or provider credential, and the host checks and journals every mutation.

- A notification is awareness, never authority.
- A new phone capability is a new input or output on an existing route class, admitted by the fail-closed remote route classifier.
- On a host whose own person paired it, the phone sets modes and levels (Full access included) with no owner unlock, and offers Always allow in this Project (maintainer decision, 2026-11-12). A restricted session sees neither.
- Sensors are touched only on an explicit, visible act. The app receives no over-the-air code updates.

Not built yet:

- Phone screens for the rest of what the host accepts from such a device (packages, providers and keys, paired devices, host controls): not designed for the phone yet.

Status: Partly built. Since: 2026-10-26. Detail: [Mobile maturity: the phone stays a remote client](mobile-maturity.md#the-phone-stays-a-remote-client).

### Phone push notifications

Push is off on the host and for every device until the person turns it on, and every notification is sealed so the delivery path learns nothing. Delivery goes through an Octant push gateway that stores nothing per device.

- The envelope carries only a fixed placeholder; the lock screen shows kind and computer label unless the person opts in to thread titles for that phone.
- The gateway issues delivery capabilities, accepts only requests signed by the host a capability names, and issues them without app attestation (accepted).
- A person who builds the phone app from source can make their own hub the gateway. A held thread move is its own notification kind (maintainer request, 2026-11-09).

Not built yet:

- Gateway deployment, platform credentials, the native phone pieces and live delivery: maintainer gates. The host side is verified against a local gateway.

Status: Partly built. Since: 2026-10-26. Detail: [Mobile maturity: delivery path](mobile-maturity.md#delivery-path), [what leaves the host](mobile-maturity.md#what-leaves-the-host) and [building the phone app yourself](mobile-maturity.md#building-the-phone-app-yourself).

### Phone capture and voice

The phone can attach a camera photo, library image or file, and dictate a prompt, with all processing on the host.

- The host strips location and identifying metadata from every uploaded image before it is stored or sent to a provider.
- Voice is transcribed on the host's Voice endpoint, never the phone's recognizer, with no audio kept. The phone requests no location access.
- Owed checks: physical-device passes.

Status: Built. Since: 2026-10-26. Detail: [Mobile maturity: capture](mobile-maturity.md#capture) and [voice](mobile-maturity.md#voice).

### Android builds and public stores

Android gets internal builds of the same remote client by link. Public store preparation is in preview scope; listing and submission are separate maintainer actions.

- Public store distribution requires a clearly labelled offline demo and no Octant account; sample changes stay in memory and device effects stay unavailable.
- Native and store acceptance is separate from the source implementation.

Not built yet:

- The Android build and device pass: waiting on the maintainer.
- Store listing and submission: separate maintainer actions.

Status: Partly built. Since: 2026-10-26. Detail: [Mobile maturity: Android](mobile-maturity.md#phase-b-android-internal-builds-of-the-same-client) and [public stores](mobile-maturity.md#phase-e-public-store-distribution).

## Hubs and Nightly

### Hub and spokes

A person's own devices form a hub-and-spoke topology: a hub is an ordinary Octant host with a role, spokes are the person's other computers, and phones and browsers join as guests. Each host stays its own authority.

- A spoke's hub grant is a closed list chosen and changed only on that spoke. The hub cannot read credentials, loosen sandbox or approval policy, or decide a risky action, and never acts on an owner's behalf.
- Authority checks and the journal stay per host. Members are the person's own devices over a private network only; there is no public internet path.
- A spoke accepts new members as full members by default and every spoke and owner device alerts on each; a setting holds them until an owner confirms.
- Browser guests reach each spoke directly, so the hub never sees spoke traffic.
- Work and Code turns on Windows follow [Windows below Full access](#windows-below-full-access).
- Owed checks: real phones, passkeys, networks and providers.

Status: Built. Since: 2026-10-28. Detail: [Hub and spokes: roles](hub-and-spokes.md#roles), [hub grant](hub-and-spokes.md#what-the-hub-may-do-on-a-spoke) and [decisions](hub-and-spokes.md#decisions).

### Windows host storage and the foreground host

On Windows the server and member keep their identity, listener, roster and authority stores in the native-held private profile, and refuse an unsafe or malformed record rather than replace it or fall back to an ordinary file.

- Keys are created exclusively and never silently rotated; only the active claimed owner commits a replacement.
- The foreground host composes these stores before server imports and starts the ordinary server on loopback.

Not built yet:

- Proof through the actual entrypoint, for both profiles, of loopback Chat readiness, authority negatives, verified backup and joined shutdown: owed before foreground admission.
- Executable extensions and unadmitted linked-store state: unavailable until they have native private admission.
- Desktop and Nightly bootstrap, disk-encryption setup and service integration: separate gates.

Status: Partly built. Since: 2026-10-28. Detail: [Hub and spokes: boot-key storage](hub-and-spokes.md#the-hub-is-a-server-first).

### Adding a computer over SSH

A registered SSH server becomes an Octant member from Settings without visiting it: the signed headless build is installed over SSH as a user service after one confirmation, and is updated or removed the same way (maintainer decisions, 2026-11-19).

- A window or a device the host's own person paired confirms one sheet naming everything that will happen; agents, routines and hub-introduced devices are refused.
- Octant never runs sudo and copies no credential. A key Octant keeps is offered alone, never the person's agent; with no key held, nothing runs.
- The join code never appears as an argument or in the journal, and the hub approves the ticket only when the comparison code read over SSH matches.
- Only a signed build is installed or updated to; a failed drain, stop or hello check rolls back and the sheet says why. Update drains as the person chose (maintainer decision, 2026-11-19).
- A real machine is a maintainer check.

Not built yet:

- A join from a member's window, pairing with no hub, and starting a Mac at boot without a login: not designed yet.
- Offering Wait only where the installed CLI can drain: an older one fails the Drain step and is rolled back.
- Refusing a Chat Retry, a compaction or a helper agent while draining: not wired to the drain.
- Rolling back a confirmed swap that migrated the store: the person restores the backup.
- Reading the hello again after a roll-back: not built.

Status: Partly built. Since: 2026-11-19. Detail: [Hub and spokes: adding a computer over SSH](hub-and-spokes.md#adding-a-computer-over-ssh).

### Hub failover and owner devices

One hub is active at a time, with a named standby that stands in only while the hub is down. A device the host's own person paired acts on that host with a window's powers and no unlock; owner devices matter only where a hub's own rules need a named owner (maintainer decision, 2026-11-12).

- A standby promotes to hub for good only by a local action the person confirms; removal wins when the hub returns.
- The owner unlock gates only owner changes and a thread move's ticket on a person-paired device.
- On a spoke that knows a device only through the hub's roster, only an owner device acts, after a fresh unlock. Full access, merge, credential copy, owner changes and a move ticket each need their own; approval reads and answers ride the administration session unless a window sets per-answer unlock (maintainer request, 2026-11-12).
- Owner recovery of a runtime approval is one-use, bound to exact digests, and refuses a changed target or replay before effect. It never covers Plan or Full access callbacks, credentials, Browser, publishing or remembered grants.

Status: Built. Since: 2026-10-28. Detail: [Hub and spokes: failover](hub-and-spokes.md#failover), [owner devices](hub-and-spokes.md#owner-devices) and [owner runtime approval recovery](hub-and-spokes.md#owner-runtime-approval-recovery).

### Shared sign-ins, delegation and provisioning

Credentials and work move between spokes only by explicit, narrowed, journaled acts. The receiving spoke keeps the final say.

- Subscription sign-ins are never copied; the hub can ask a spoke to sign in itself. An owner with a fresh unlock may copy an API key, journaled on both hosts without the value.
- Delegated work is clamped to the smaller of the peer grant and the receiving spoke's own Project authority.
- After a thread has read outside content, handing work to another computer follows the same-computer helper rule: Full access does not refuse it, below Full access it needs the person's one `delegation` standing answer, and Plan refuses it (maintainer decision, 2026-11-13).
- A member takes delegated Code work only into a Code Project its person marked as accepting it, with the delivery target they confirmed (maintainer decision, 2026-11-19). The receiving thread is approval-gated at most, outside content from its first turn, and never moves.
- Provisioning offers land as proposals, auto-apply is off by default, and a routine always asks. The wake service and push sender are each off until turned on.

Not built yet:

- Agent messages between members: designed, not built. They reach only Code threads tagged Reachable on both ends, grant nothing, and can start only a bounded wake turn the recipient's person allowed.
- The three-host loopback smoke for a Code delegation: not yet exercised. A real-provider run is a maintainer gate.

Status: Partly built. Since: 2026-10-28. Detail: [Hub and spokes: shared sign-ins](hub-and-spokes.md#shared-sign-ins), [delegation](hub-and-spokes.md#spoke-to-spoke-discovery-and-delegation) and [wake service](hub-and-spokes.md#wake-service).

### Moving a thread between members

Before shutting down or restarting a computer, a person can move a Chat, Work or Code thread to another of their computers and carry on there. A Code thread that cannot move hands over through its branch (maintainer request, 2026-11-07).

- Only planned moves, and only a person starts one. The destination accepts it only with an owner device's own fresh unlock and its Move in peer-grant item; a browser passkey cannot confirm a move.
- The source freezes the thread before sending and erases its copy only after the destination commits, deleting only what it proved travelled, so one copy takes turns at a time.
- History, attachments, owned Canvases and a Code thread's branch and work travel. Credentials, the provider's session, Full access, grants, processes and ignored files never do.
- A Work thread brings its folder's files only when it is that folder's sole user (maintainer request, 2026-11-09). The destination never writes into an occupied path or widens file permissions.
- A move starts in the thread's Environment tool or Prepare to shut down, which never preselects Hand over or Stop and move (maintainer request, 2026-11-08). Stop and move is the person's choice in a window, checked per thread on the server.
- A move that cannot finish names one journaled reason, leaves the thread on the source, and Prepare to shut down never says Safe to shut down (maintainer request, 2026-11-08).

Not built yet:

- A view of another member's thread inside this window: not built; Open there uses the destination's web app.

Status: Partly built. Since: 2026-11-07. Detail: [Hub and spokes: moving a thread to another member](hub-and-spokes.md#moving-a-thread-to-another-member) and [Hub and spokes: moving a thread, screens](hub-and-spokes.md#moving-a-thread-screens).

### Coding sessions on any connected computer

A person starts and manages a coding session on whichever of their computers they choose, from any window, phone or browser connected through Octant. The hub coordinates, and each computer runs and authorizes its own work (maintainer request, 2026-11-19).

- The hub is the front door and directory and carries no session traffic; two computers can pair directly with no hub.
- A create the window cannot route is refused with a sentence and never runs on this computer.
- A device the member's own person paired acts as that person there. A device only the hub introduced acts within that member's Act hub-grant item, checked at every request; unticking Act refuses its next act and ends its sessions (maintainer decisions, 2026-11-20 and 2026-11-21).
- The hub admits a member's window guest only to the Projects its own Act list names, set only from a window on the hub (maintainer decision, 2026-11-21).
- Every connected device is told when a new device joins or pairs, and Remove stays with a window on the host and an owner device (maintainer decision, 2026-11-19).
- A window acting as its own person can bootstrap a local Code Project onto another computer over the direct paired session, never the hub, copying only ignored files the person ticked (maintainer decision, 2026-11-24). A two-machine smoke is an owed maintainer check.

Not built yet:

- The rest of hub coordination, beyond guests and windows reaching spokes directly: designed, not built.
- Image attachments in a session on another computer: not built.
- Holding a Work turn in an existing thread, and Chat threads, to the Act item: not built.
- The hub telling its own window about a spoke or standby it added: not built. A real phone is a maintainer check.
- The load level beside the roster in a window: not built.

Status: Partly built. Since: 2026-11-19. Detail: [Hub and spokes: the hub coordinates](hub-and-spokes.md#the-hub-coordinates-each-member-runs-its-own-work) and [decisions](hub-and-spokes.md#decisions).

### Octant Nightly

Octant Nightly is a second desktop app that installs beside Octant, follows the preview ring, and works on the same data, whose folder Octant's host alone owns. Octant is one binary with the channel switch Stable | Preview | Nightly, and never follows preview itself (maintainer decision, 2026-11-05).

- By default Nightly is a client of Octant's running host and never runs a host on Octant's data. For testing it can run its own host on separate test data.
- Each app validates its own signed identity and its peer's on every exchange, refuses a feed signed for the other, and never installs the other through its update (maintainer decision, 2026-11-06).
- A Nightly client reaches native operations only through a closed, lease-bound allowlist. Remote access, hubs, pairing, owner unlock and host identity stay Octant-only (maintainer decision, 2026-11-06).
- Every embedded Browser gap, accessibility included, blocks the first Nightly publication, and Nightly's popups add no authority (maintainer decision, 2026-11-06).
- Windows and Linux Nightly keep the same-user trust floor through kernel-held peer checks; same-user unconfined code is inside the floor. Linux stays in scope (maintainer decision, 2026-11-06).
- Nightly publishes only after its usable-client preflight, and a maintainer approves the first scheduled publication.

Not built yet:

- A signed Nightly installation: waiting on the maintainer checks below.
- Maintainer checks owed: a signed pair and signed install (the Preview install row included), a signed test-data host and `octant-nightly` run, real-account sign-ins, a packaged Electron run with physical IME and VoiceOver, an Octant candidate carrying the host feature list, roll-forward on a published release, the preflight on a scheduled release, a packaged Linux pair on a real desktop, packaged Windows lifecycle acceptance, and approval of the first scheduled publication.
- Windows Nightly test data, installation, and Work and Code: separate gates.

Status: Partly built. Since: 2026-11-05. Detail: [Octant Nightly](nightly-app.md): [one host serves both](nightly-app.md#one-host-serves-both), [maintainer decisions](nightly-app.md#maintainer-decisions-2026-11-06), [native-main admission](nightly-app.md#native-main-admission), [Windows client trust](nightly-app.md#windows-client-trust), [Linux client trust](nightly-app.md#linux-client-trust) and [the usable-client preflight](nightly-app.md#the-usable-client-preflight).

## Code tooling

### Language servers

A Code thread's editor gets diagnostics and go-to-definition from separately launched language servers that run under Code Project and thread authority. They are an executable component kind on the activation ladder.

- Language servers are Code only, quarantined until reviewed, and installing one never trusts or enables it. The repository never chooses what runs.
- A `static` server reads the checkout read-only with no network and no exec, needs no approval, and serves Plan.
- A `repo-tooling` server runs confined like a terminal with per-checkout approval, is refused in Plan, and starts unasked at Full access ([the Full access rule](#the-full-access-rule)). Its answers stay marked as outside content.
- Replies carry bounded text and ranges, never server commands or edits to other files. Octant hosts no other editor's extension API.
- Octant Harness edit results attach bounded language-server errors and never block for approval (maintainer decision, 2026-11-19).
- On Windows a server runs as [Windows below Full access](#windows-below-full-access) says.

Not built yet:

- The bounded `window/logMessage` log and lifecycle counts under Diagnostics, and removing a cache when its checkout is removed or its component uninstalled: not built.

Status: Partly built. Since: 2026-10-26. Detail: [Language services: launch classes](language-services.md#launch-classes), [authority](language-services.md#authority) and [maintainer decisions](language-services.md#maintainer-decisions).

### Debugger

A person, at a local window or on a device they paired, picks a debug configuration and starts a confined debug session. An agent starts, controls, reads and stops one through the plugin-shaped `octant_debug` tool: unasked at Full access, approval-gated below it, and refused in Plan (maintainer decision, 2026-11-12).

- The agent starts only a configuration the Project holds. Below Full access one answer per session covers starting, controlling and evaluating in it, also after outside content; the card names environment variables, never their values (maintainer decision, 2026-11-13).
- Below Full access a person's start needs a confirmed configuration. Repository configurations are proposals until confirmed.
- Attach is Full access only, refused below it and in Plan, and never reaches Octant's own processes, another user's, or a program outside the thread's checkout (maintainer decision, 2026-11-13).
- What a session shows reaches the agent bounded, redacted and marked as outside content. The program is confined by the thread's posture as a terminal is.
- On Windows a session runs as [Windows below Full access](#windows-below-full-access) says.

Not built yet:

- Attach: the tool offers no attach yet.
- An unconfirmed start from the Run and debug panel at Full access: the panel still offers Start only on a confirmed configuration.
- The macOS confined-program smoke: needs a Mac.

Status: Partly built. Since: 2026-10-27. Detail: [Language services: debugger authority](language-services.md#debugger-authority), [agent debug tool rules](language-services.md#agent-debug-tool-rules) and [approval and starting](language-services.md#approval-and-starting).

## Disposable desktops

### Leases and authority

A Project owns at most one desktop recipe, which only a person edits, and a thread leases a throwaway desktop from it. The server checks every lease command against the thread's current authority before any provider call.

- A lease belongs to one Work or Code thread. Lease counts are Settings defaults a person changes at a local window or a person-paired device; a hub-introduced device is refused (maintainer decision and request, 2026-11-12).
- Failures are named refusal values, never throws or hangs.
- Teardown runs on a host-owned path that stays authorized after archive, recipe removal or plugin disable, and can only release, verify and list.
- Any client that may open the thread may view and operate its desktop; the person's own input needs no approval and is journaled.

Not built yet:

- Work-mode leasing: only Code turns carry a desktop destination today.
- Setting or removing a recipe from a paired device, and the recipe editor on a paired client: the Project route still refuses the command from a paired device, and no paired surface shows Project settings.

Status: Partly built. Since: 2026-10-26. Detail: [Disposable desktops: model](disposable-desktops.md#model) and [authority](disposable-desktops.md#authority).

### Desktop isolation and transfer

A desktop holds no host credential and no checkout. Host files enter only through an explicit, journaled transfer of one checkout-relative file, and the separately approved preview carries only the named application's HTTP and WebSocket traffic.

- A host-local desktop runs in a dedicated Linux sandbox with its own network namespace and no host loopback (maintainer request, 2026-11-12). A cloud desktop's key never enters the desktop.
- Nothing is copied back except screenshots and recordings, as host-held evidence.
- Plan refuses transfers. A transfer to a cloud desktop asks unless "Confirm each billed desktop" is off (maintainer request, 2026-11-12).
- A transfer to a desktop on this machine is unasked at Full access and asks once per thread below it (maintainer decision, 2026-11-13). Under Strict that answer, and Remember for this Project, are withdrawn once the thread reads outside content (maintainer decision, 2026-11-22). Remember never covers a cloud desktop.
- A dev-server preview is one person-granted port into a ready host-local lease, expiring with it and never restored after restart.

Not built yet:

- Network for a host-local desktop through the filtered egress proxy: not built, so today a host-local desktop never has network and a recipe that asks for it is refused. Only a cloud recipe without a placement may allow network.

Status: Partly built. Since: 2026-10-26. Detail: [Disposable desktops: isolation](disposable-desktops.md#isolation), [artifact transfer](disposable-desktops.md#artifact-transfer) and [lease-bound dev-server preview](disposable-desktops.md#lease-bound-dev-server-preview).

### Desktop lifecycle and teardown

Every lease has a hard expiry, and ending a lease always destroys the desktop and verifies it is gone.

- Expiry and idle release are recipe defaults a person changes, up to a recipe maximum (maintainer request, 2026-11-12). An agent may extend only a host-local lease; a billed lease keeps a hard expiry.
- The host journals a lease before calling the provider and tags the resource; on restart it destroys every unreleased lease and orphan before admitting a new one.
- Release counts only when the provider confirms the resource is absent; otherwise the lease stays release-failed and blocks that provider.

Status: Built. Since: 2026-10-26. Detail: [Disposable desktops: lifecycle and teardown](disposable-desktops.md#lifecycle-and-teardown).

### Desktop providers and billed placements

Desktop providers are plugin contributions through the `desktop-provider` seam: the host owns leases, authority and teardown, and the driver only translates. Cloud desktops run only on the person's own account, and Octant operates no cloud.

- A person confirms each billed or off-machine lease unless they turned off "Confirm each billed desktop", which is on by default and set only by a person at a local window or a person-paired device (maintainer decisions, 2026-11-12 and 2026-11-13).
- Billed desktops are off until a person sets a mandatory monthly spend cap; each lease is estimated and refused over it. Agents cannot change the cap, and a hub-introduced device is refused (maintainer request and decision, 2026-11-12).
- A billed provider must set a provider-side expiry, or the host destroys the desktop. Octant never installs, starts or stores a credential for a daemon.

Not built yet:

- The spend cap in the paired browser and phone: the server admits it, the paired screens are a UI follow-up.
- Live smokes of each driver: owed.

Status: Partly built. Since: 2026-10-28. Detail: [Disposable desktops: provider seam](disposable-desktops.md#provider-seam), [authority](disposable-desktops.md#authority) and [billed placements](disposable-desktops.md#expiry-and-teardown-when-the-daemons-host-may-die).

## Bots

### Bots, with Navigator as the lead bot

A bot is a lasting, app-wide assistant on one host with its own name, role, instructions, model, access level, Work home, never-ending conversation, memory, routines and optional sandboxed desktop. Navigator is the lead bot on every host.

- A bot is not a fourth mode: its conversation is a Work thread in its own home Project, with a Work thread's tools and authority.
- A new bot starts at Auto where its provider has its own reviewer and at Ask first otherwise, never at Full access by default (maintainer request, 2026-11-12).
- Paying, buying, or sending a message as the person always asks, at every level and in routines.
- A bot desktop reaches the web only through a host proxy that refuses private and host addresses, and holds no host credential or checkout.
- A bot signs in only with logins the person gave it, on those logins' sites; the model never reads them.
- Paired browsers and phones may create bots and answer their cards, except billed desktop starts and login grants.

Status: Designed, not built. Since: 2026-11-08. Detail: [Bots](bots.md).

## To-dos

### The person's to-do list

A person keeps their own to-dos in one list that every device and computer they connected shows, tags each to Projects and their own tags, filters them, and starts a thread from one when ready.

- The list lives on one list host (the hub, this host, or a paired computer the person names). Only that host journals to-dos.
- A local window and the person's paired devices may change the list. Agents, routines, delegated runs and peer hosts are refused; only the person ticks a to-do off.
- Stale edits are refused as changed elsewhere, never merged. An unreachable list host shows a stale, read-only list, and nothing is queued as offline work.
- A to-do's links carry no authority: Start opens an ordinary new-thread draft whose own creation checks decide, and nothing starts until the person sends.
- The destination and every name in code and copy are To-dos, never Tasks.
- Owed checks: physical hub verification, and physical two-computer verification.

Status: Built. Since: 2026-11-14. Detail: [To-dos](todos.md).
