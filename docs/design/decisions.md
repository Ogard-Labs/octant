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
- A requirement marked _Here only._ is in force but not yet repeated in its
  owning specification; this document is its home until the owner absorbs it.

A change to a decision updates its owning specification and its entry here in
the same pull request ([Changing the design](README.md#changing-the-design)).
The former decision archive is history in `docs/legacy/` and has no authority.

## Summary

| Area                                                                                  | Decisions | Built   | Partly built | Designed, not built |
| ------------------------------------------------------------------------------------- | --------- | ------- | ------------ | ------------------- |
| [Principles and hard lines](#principles-and-hard-lines)                               | 7         | 5       | 2            | 0                   |
| [Guardrails and review](#guardrails-and-review)                                       | 9         | 4       | 5            | 0                   |
| [Key providers](#key-providers)                                                       | 21        | 12      | 9            | 0                   |
| [Release scope](#release-scope)                                                       | 8         | 4       | 3            | 1                   |
| [Process topology and local trust](#process-topology-and-local-trust)                 | 8         | 7       | 1            | 0                   |
| [App-managed tools](#app-managed-tools)                                               | 7         | 6       | 1            | 0                   |
| [Canvas authority](#canvas-authority)                                                 | 2         | 0       | 2            | 0                   |
| [Device transport](#device-transport)                                                 | 3         | 3       | 0            | 0                   |
| [Modes, Projects and authority](#modes-projects-and-authority)                        | 17        | 11      | 6            | 0                   |
| [Agents and delegation](#agents-and-delegation)                                       | 6         | 3       | 3            | 0                   |
| [Boards, pull requests and delivery](#boards-pull-requests-and-delivery)              | 7         | 3       | 4            | 0                   |
| [Routines and timed turns](#routines-and-timed-turns)                                 | 5         | 4       | 1            | 0                   |
| [Transcript records](#transcript-records)                                             | 1         | 0       | 1            | 0                   |
| [Persistence](#persistence)                                                           | 12        | 7       | 5            | 0                   |
| [Providers](#providers)                                                               | 12        | 9       | 3            | 0                   |
| [Context and usage](#context-and-usage)                                               | 11        | 9       | 2            | 0                   |
| [Native harness](#native-harness)                                                     | 7         | 6       | 1            | 0                   |
| [Extensions](#extensions)                                                             | 9         | 5       | 4            | 0                   |
| [Authority and approvals](#authority-and-approvals)                                   | 8         | 7       | 1            | 0                   |
| [Sandbox and confinement](#sandbox-and-confinement)                                   | 18        | 11      | 6            | 1                   |
| [Terminals, browsers and side surfaces](#terminals-browsers-and-side-surfaces)        | 10        | 7       | 3            | 0                   |
| [Remote access and pairing](#remote-access-and-pairing)                               | 14        | 8       | 6            | 0                   |
| [Credentials and sign-in](#credentials-and-sign-in)                                   | 8         | 5       | 3            | 0                   |
| [Updates and development](#updates-and-development)                                   | 5         | 5       | 0            | 0                   |
| [Design system](#design-system)                                                       | 12        | 12      | 0            | 0                   |
| [Workspace](#workspace)                                                               | 21        | 16      | 5            | 0                   |
| [Start screen](#start-screen)                                                         | 4         | 4       | 0            | 0                   |
| [Canvas](#canvas)                                                                     | 12        | 5       | 7            | 0                   |
| [Artifact sync](#artifact-sync)                                                       | 5         | 4       | 1            | 0                   |
| [Browser](#browser)                                                                   | 10        | 6       | 4            | 0                   |
| [Provider runtimes](#provider-runtimes)                                               | 7         | 4       | 2            | 1                   |
| [Model endpoints and organization sign-in](#model-endpoints-and-organization-sign-in) | 6         | 4       | 2            | 0                   |
| [Outside provider drivers](#outside-provider-drivers)                                 | 4         | 2       | 2            | 0                   |
| [Device workbench and mobile](#device-workbench-and-mobile)                           | 8         | 4       | 4            | 0                   |
| [Hubs and Nightly](#hubs-and-nightly)                                                 | 8         | 2       | 6            | 0                   |
| [Code tooling](#code-tooling)                                                         | 2         | 0       | 2            | 0                   |
| [Disposable desktops](#disposable-desktops)                                           | 4         | 1       | 3            | 0                   |
| [Bots](#bots)                                                                         | 1         | 0       | 0            | 1                   |
| [To-dos](#to-dos)                                                                     | 1         | 1       | 0            | 0                   |
| **All areas**                                                                         | **320**   | **206** | **110**      | **4**               |

## Principles and hard lines

### Six product principles

Every product rule is measured against six principles. A rule that protects none of them is a default a person can change, not a law.

- The person's ecosystem is the person's call: their explicit choice beats Octant's caution.
- Privacy and no telemetry are not adjustable. Nothing leaves the machine unless the person sent it or configured where it goes, and no usage data is sent without opt-in.
- Guardrails are on by default. A person can lower them to Full access per Project, per thread or globally, visibly and journaled.
- Key providers run as themselves. Octant supplements a provider and never replaces it: any workflow that works in the provider's own app (Claude Code first) works in Octant, with Octant's journal, views, approvals and guardrails on top. A workflow Octant cannot yet carry is a recorded gap, not a rule. (maintainer decision, 2026-11-14)
- Honesty never softens: Octant says what a provider or tool can and cannot do, and records what happened.
- Octant is never stricter than a key provider's own app: what a person can allow there, they can allow here in the same or fewer steps. It holds back only for the hard lines, the rule that a new thread never starts at Full access on first run, the protected provider-account credentials, and Chat, Octant's no-folder, no-shell mode.

Not built yet:

- What [Guardrail levels](#guardrail-levels), [The Full access rule](#the-full-access-rule), [Octant Shield](#octant-shield) and [Key providers run as themselves](#key-providers-run-as-themselves) mark not built: each gives its reason.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### Hard lines no level turns off

A short list of rules holds at every level, Full access included. No setting or reviewer turns them off.

- No telemetry, no usage data and no Octant cloud.
- Octant stores no forge token and never journals a secret value. It redacts secrets from logs, the journal and exports. Credentials reach a provider only through the credential broker.
- Updates are signed and verified; anything unverifiable is refused.
- Authority is checked on the host before any side effect. A phone or web client never exceeds what the person allowed on the host.
- Providers report capabilities honestly and fail closed.
- The journal records every lowered guardrail, every merge and every force-push, with who allowed it.
- An agent never merges or force-pushes on its own initiative, never marks a thread Done, and never exceeds a spend ceiling the person set.
- Plan is read-only: an agent in Plan looks and proposes, and changes nothing in the workspace, on the host or in the outside world. It may read the page already open in its thread's Browser and propose what a person confirms (a side task, a routine). The one thing it writes is its thread's own Canvas (`create` and `revise`); publishing, sharing, the artifact mirror and replica sync stay refused.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### The Full access rule

At Full access, in Work and Code, nothing prompts, nothing expires into a refusal, and nothing is refused because the thread read outside content, except the closed list below (maintainer request, 2026-11-12). A rule that asks at Full access and is not on the list is wrong. Adding an ask means adding it to the list in the owning specification in the same change, with its reason.

- The exceptions:
  - Every [hard line](#hard-lines-no-level-turns-off).
  - Merge, plain force-push and push to the default branch through Octant's own pull-request tool or Octant Harness, which follow [Pull-request merge](#pull-request-merge). A provider's own commands are not on the list outside Strict: they run unasked and journaled, and Octant Shield's forge hard lines judge them only under Strict ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).
  - Computer use under Strict: the first action in each application asks unless remembered for the Project. Outside Strict it needs no first-action approval. (maintainer decision, 2026-11-19)
  - The Browser on a signed-in profile: a site approval per origin and profile, which the person can remember or widen to "Allow all sites in this profile". A Private page needs none.
  - Paying, buying, or sending a message as the person through the Browser or Computer (an email, a chat, a social post, a form that sends a message). A pull-request comment or review reply is not such a send.
  - Billed or off-machine desktops: the spend cap is mandatory. Inside it, confirming each billed or off-machine lease and each transfer to a cloud desktop is a setting, on by default.
  - The one-time warning when a machine or a Project first picks Full access.
- Who asks is not an exception. A device the host's own person paired sets a thread, a Project or the default to Full access, and starts a thread there, as a local window does, with no owner device and no extra unlock; it is journaled as the actor. An agent grant runs at Full access when the person chose that level for it. (maintainer decision, 2026-11-12)
- Full access is refused to a device the host knows only through the hub's roster, an owner device included, which reaches it only through the hub's owner posture recovery (maintainer decision, 2026-11-13); to one whose approval the journal does not prove; and to one paired below the Full device access level ([Remote clients](#remote-clients); maintainer decision, 2026-11-22).
- An agent's routine is created and shown in the thread, active unless the person turned off "Start agent-created routines active at Full access" ([Octant's own limits become settings](#octants-own-limits-become-settings)).
- At every level a wait is the safe state: an unanswered approval or question waits in Needs you until a person answers, and never times out into a refusal (maintainer decision, 2026-11-13).
  - This covers Octant Harness approvals and questions, MCP tool approvals, Project memory and routine proposals, a routine's pause or archive ask, the image generation offer, the Browser sign-in card, a [thread secret](#thread-secrets)'s card, Browser site, upload, download and script approvals, and a Code thread's own tool asks.
  - Each ends with an answer, its turn stopping, its thread's archive, its window's revocation or the host stopping. What it holds (staged uploads, a held download) is released however it ends. The caps on how many may wait stay.
  - A page stays open while a question about it waits, and the question ends when the page closes. The first navigate's site approval ends with its call.
  - A Chat app-managed tool call's five-minute deadline stands still while its approval waits. No MCP session idles out while a call in its scope waits for approval; disabling, an authentication change or an authority reconciliation still closes it and withdraws its prompt ([Provider runtimes](provider-runtimes.md)).
  - Needs you lists every such ask, and each new one is told to the paired phones ([Pending requests, fleet activity and turn decisions](#pending-requests-fleet-activity-and-turn-decisions)).
  - Expiry stays only where a live secret or the host's own authority is at stake: pairing, sign-in and device-code flows, a [one-use credential request](#one-use-credential-cards) and the desktop authority confirmation. A benchmark cell's ten-minute park also stays, because the cell measures unattended work and holds a worktree and a place in its run.
- A time, count or size limit is a default the person can change in Settings, unless it protects a hard line or stored data. A fixed constant states its reason beside it.

Not built yet:

- Rules elsewhere that still ask, expire or refuse at Full access, and limits still fixed as constants: each entry marks its own.

Status: Partly built. Since: 2026-11-12. Detail: [Architecture: Security and authority, Guardrail levels](../architecture.md#security-and-authority).

### Local-first with a closed list of outside calls

Everything a person cares about stays on the host. Octant makes only a short, switchable list of host-initiated calls.

- No Octant account, relay or telemetry is required. Artifact sync uses only a store the person owns.
- There is no Octant relay (maintainer decision, 2026-11-14). The user guide documents a relay or tunnel the person runs themselves (a private network overlay, an SSH tunnel) in front of the listener; the product does not change for it.
- The outside calls are: signed update checks, managed device-tool update checks, marketplace fetches the person starts, public Canvas link calls, and a hub's own push delivery when its person turns it on. Each has an off switch.
- Optional [thread titles](model-endpoints.md#thread-titles) go only to the API or subscription endpoint and model the person selects for that job.
- Traffic among a person's own devices on their private network is not a third-party call, and it is always authenticated and encrypted.
- Adding telemetry, an external call, credential exposure or a cloud dependency needs an explicit request and a documented boundary in the owning specification.

Status: Built. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### Desktop-owned broker cleanup

A desktop-owned launch keeps hold of the native resources it acquired through failure and shutdown, and releases them once.

- The Browser runtime broker shares one close completion for a failed listen and an ordinary shutdown. It attempts every acquired cleanup stage even after an earlier one failed, awaits its HTTP listener and closes held connections.
- Startup and cleanup failures are reported without widening the quit deadline or taking ownership of borrowed hosts.
- The desktop gives the host it spawned 60 seconds to open its store.
- A start-up failure is logged and its launch released before anything is shown. It is then shown in a window that does not block quitting, never in a native alert without a parent: on macOS that alert runs a nested modal loop a signal cannot interrupt (a packaged build stayed alive twenty seconds after SIGTERM).
- Signals, the Quit menu item, closing the window and its Quit button each end the app once.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Server authority, an authoritative journal, and strict host reads

The server decides every authority question, the event journal is the record, and the host reads its own inputs strictly.

- Every authority check (mode, Project, thread, provider, approval, remote principal, spend ceiling) runs in the server before a side effect. Renderers only show what the server allows.
- Commands append versioned events. Read models are idempotent projections rebuildable from the journal.
- Startup and the status inspection verify only the journal rows after a disposable watermark (a sequence plus a fingerprint of the server build, the registry and the schema head) and skip SQLite's integrity check. A new build, a source run, a migration, a suspicious tail, a refused start, or a rewritten or deleted row forces a full scan ([Persistence](../architecture.md#persistence)).
- Contracts are schema-only and domain code is pure. Dependencies point inward, and provider payloads stop at the adapter.
- A provider's own program typed into a terminal tab bypasses Octant's approvals and the journal, so it is offered only as a person-operated terminal whose activity the thread does not claim ([Provider terminals](#provider-terminals); maintainer decision, 2026-11-21).
- The host refuses unknown fields from clients, the journal, projections, extension payloads and plugin manifests. A client drops unknown fields in a host answer, except inside asks a person decides on. Service offers list by envelope and decode strictly before their card shows, so one bad offer hides no other.
- What a provider runtime sends is read tolerantly: an unknown message, subtype, field or value is dropped and the turn continues (maintainer decision, 2026-11-25). Authority checks on its output stay fatal: another working directory, permission mode, tool server or tool; a call to a tool not offered; a write Plan disabled reported as made; a malformed approval or question (never answered allow); a corrupt transport ([Reading what a runtime sends](provider-runtimes.md#reading-what-a-runtime-sends)).

Status: Built. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### Plugin-shaped growth

New providers, tools and capabilities reach the system only through the published seams, and take no shortcut a third-party plugin could not take.

- Shipping in-tree is allowed. Wiring a provider or tool into server internals, or widening a seam for one vendor, is not.
- A capability a seam cannot express is a reason to extend the seam in its own change.
- Core capabilities (browser and computer use, tests, Apple validation, approvals, memory, subagents) are app-managed and provider-neutral. They are added beside a key provider's own tools, never instead of them.

Status: Built. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles) and [Plugin boundaries](../architecture.md#plugin-boundaries-and-remaining-extraction).

## Guardrails and review

### Guardrail levels

One setting says how much a thread's tool calls are guarded: Ask first, Accept edits, Auto or Full access. Plan is a read-only overlay on any level.

- Ask first: the person approves anything with effects. Outside Strict the provider's own sandbox and permission modes enforce it ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox); maintainer decision, 2026-11-21); under Strict Octant's OS confinement runs too.
- Accept edits: as Ask first, but file edits inside the folder go through.
- Auto: a reviewer answers prompts and escalates what it will not allow ([Auto: the provider's reviewer or Octant Shield](#auto-the-providers-reviewer-or-octant-shield)).
- Full access: no sandbox and no prompts, as in the providers' own apps. Outside content is only recorded and marked, protected files are guarded softly ([Secrets are guarded, softly at Full access](#secrets-are-guarded-softly-at-full-access)), and every hard line holds.
- Subagents start at their parent's level and never exceed it. A routine asks first unless the person opted it into its Project's level or picked a level, which is a ceiling under the Project's level ([Routine authority level](#routine-authority-level)).
- A level is set globally, per Project or per thread; the narrowest wins. The thread header shows the level in force and its scope. Defaults live in Settings › Code › Access and Settings › Chat & Work ([First run asks which mode new threads start in](#first-run-asks-which-mode-new-threads-start-in)).
- Every lowering is journaled with who, when, the scope and the old level (absent when a Project override replaced the default it followed).
- In Work, Plan is the thread's own level, picked from its mode picker or asked for by its agent, and may be a default (maintainer decision, 2026-11-21).
- A retired level recorded before these four existed replays as Full access.
- `octant agent --access <mode>` starts a Work or Code thread at that level, with or without a desktop window; on a Code thread `full-access` is remembered for the Project as `octant project access` does. `octant settings access <mode> [--work]` sets the global default.
- Full access may keep a sandbox (`fullAccessSandbox`; `--sandbox`; `octant settings sandbox on|off [--work]`): no prompts, but the guarded levels' confinement. It has thread, Project and Settings defaults, is dropped below Full access, and replays as off on older journals. Rationale: no sandbox stays the default; this gives containment without prompts.
  - Codex runs inside Octant's profile, told the sandbox is external. Claude Code runs its command sandbox with no unsandboxed retry and Octant's Project-path gate on file tools. Pi, OpenCode and ACP agents run inside the Accept edits wall with their own approvals off or answered allow. The Octant Harness uses its confined shell. A runtime Octant does not know refuses rather than run open.
  - Helpers of such a thread run at Accept edits. With [Network limits](#safe-networks) on, runtimes use the proxy with the wall's posture.
  - A live Codex turn under this mapping is a maintainer check still owed.
- Strict, a separate switch inherited thread → Project → Settings, restores Octant's own asks and sandbox ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox)).
- The Access details on the shared Work/Code indicator read host facts under thread-read authority: selected and effective level, running and session limit, default match, reviewer, account, model and observed runtime limits. Unknowns stay explicit, a failed read keeps no old account claim, recovery never changes authority or suggests a protected-file bypass, and a default match is not provenance. Server-backed Work reads use the server's thread binding and global Work default.
- Mistral Vibe's auto-approve mode is the one ACP profile with its own reviewer. Other ACP agents report none; a profile gains one by declaring the mode that answers its prompts.

Not built yet:

- Strict on Windows: it needs Octant's sandbox, which Windows does not have yet ([Windows below Full access](#windows-below-full-access)).

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Guardrail levels](../architecture.md#security-and-authority).

### Secrets are guarded, softly at Full access

Below Full access, secret files stay out of every agent's reach by an operating-system rule, with as little friction as the person's normal tools. At Full access the guard is soft: a shell command can read a protected file.

- One deny list covers SSH private keys, cloud and tool credentials, keychain and password-manager files, browser login stores, Octant's own secrets and other runtimes' sign-ins. It names desktop chat apps' session tokens (Slack and Discord Local Storage) but never a whole Application Support or `~/.config` folder (maintainer decision, 2026-11-13). SSH config, `known_hosts`, public keys and the login keychain stay readable, and a runtime keeps its own sign-in.
- Below Full access the list joins every confined launch after its grants. At Full access no launch is wrapped, so Swift packages and headless Chrome work without flags.
- At Full access the path refusals lift and secret values are still never journaled:
  - Claude Code's own file tools may read protected paths, as on their own (maintainer decision, 2026-11-14).
  - Octant's own file tools (Harness, ACP client, a server Project's) and OpenCode's refuse only the Provider sign-ins group (maintainer decision, 2026-11-15). Octant's own also refuse the [thread secrets](#thread-secrets) folder (maintainer decision, 2026-11-24).
  - The Watcher flags a call that names a protected path and the Harness tags a secret-then-network command (`reads-secrets-then-egress`); both are journaled and never block. Redaction stays on.
- A refused read (Octant's file tools or Claude Code's below Full access, a provider sign-in at Full access) names the rule and the channel to use. A refused broad search names its root, says nothing was returned and offers an unprotected subfolder. Relative roots and Glob escapes get the same resolved-path check, and a check that cannot finish refuses.
- Agents use credentials without reading them: the person's SSH agent, the system Git credential helper, and the credential broker.
- The person adds paths in Settings › Permissions › Protected files. Removing a built-in group needs a confirm and is journaled.
- On Windows the list names the Windows stores (Credential Manager, DPAPI and Vault, `AppData` vaults and browser profiles, `_netrc`, forge and Copilot sign-ins). Octant's file tools normalise drive-absolute paths and refuse share, device, drive-relative and driveless rooted paths and searches rooted at or above a protected location (maintainer decision, 2026-11-14).
- Known key formats and broker-issued values are redacted from runtime output, transcripts, the journal, exports and the service log, at every level.
- Shield's Judge reads the person's list. It sends a command that reaches a secret file to the person, and refuses one that reads secrets and then sends data off the computer. The Watcher labels `secret-path-read` and `secret-env-print` (by variable name alone).
- Brokered cloud command lines in Octant's own shell: AWS gets a one-hour STS session from a linked key pair; `gcloud` gets a command-owned token file after the person confirms the service account and scopes; Azure gets only the fixed Resource Manager subscriptions GET with one-use consent, and Azure CLI credentials stay unavailable. Google ADC, `gsutil`, `bq`, delegated subjects and impersonation are out of scope.
- Linux access-time mediation is an opt-in production preview for compatible custom-kernel hosts (maintainer approval, 2026-11-16). Octant installs no kernel. Selection needs `OCTANT_LINUX_MEDIATION_PREVIEW=1` and the relay's exact ABI and coverage checks; anything missing refuses before launch. It enforces read-only roots, protected and credential paths, late names, aliases, hardlinks, held descriptors and mappings, and fails closed on broker loss, cancellation or uncertain cleanup. Stock Bubblewrap keeps the rules it can enforce.
- Host-owned file tools (native harness, ACP client, OpenCode's ACP stack) and agent language diagnostics refuse same-filesystem rules that need object mediation; a subprocess backend's coverage is never claimed for them. Strict keeps the full guard at Full access.

Not built yet:

- The list as an operating-system rule on Windows: Windows has no confined launch yet.
- Provider and signed-package live checks of Linux mediation: they remain explicit maintainer acceptance.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Secret guard](../architecture.md#secret-guard).

### Optional first-task capability discovery

Your first task includes an optional Explore capabilities card for Browser, Computer use, helper agents and person memory.

- Current host facts and existing Settings own its state. Examples are static, dismissal changes no settings, and the card adds no counted onboarding step.
- Computer use shares Settings' guided setup, saves pending progress across relaunch, and reports working only after a successful local test.
- Once onboarding has been answered, pending Computer use setup reopens Settings once on launch without changing that outcome.
- Paired clients gain no local settings authority.

Status: Built. Detail: [Start screen: Optional capability card](start-screen.md#optional-capability-card-in-your-first-task).

### First run asks which mode new threads start in

The first run asks once which mode new threads start in, with Auto pre-selected and marked Recommended. It never pre-selects Full access.

- The picker lists Auto, Ask first, Accept edits, Plan and Full access, in that order.
- Where no reviewer can run for a thread, that thread falls back to Ask first and the picker says why.
- The answer is the default for new Work and Code threads. Settings › Chat & Work and Settings › Code › Access change it, a Project may override it, and the composer switches a thread's mode in one click.
- A new Work thread starts in its Project's mode, else the default, Plan included (maintainer decision, 2026-11-21). The host decides a new thread's level from these; nothing the renderer sends raises it.
- A Code Project that remembered Full access before Project modes existed starts its threads in Full access.
- A routine or benchmark run in a Project whose start mode is Plan still asks first, since Plan holds no level a run could use.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Guardrail levels](../architecture.md#security-and-authority).

### Work and Code share one capability set and differ in focus

Work and Code run under the same levels with the same capabilities. They differ in what they show and which tools a thread starts with.

- Shell, local command-line tools, SSH to the person's machines, files, Git, provider-native tools, subagents, routines and Full access are governed alike. Every driver starts a Work session with shell and Git at the thread's level and Code's confinement, and each Work turn records them.
- Work is for documents, artifacts and local tasks, with its board and Done by a person. It hides developer surfaces until the person turns on Developer tools for that Project.
- Code is for coding, with checkouts, worktrees and an objective delivery target.
- A thread keeps the kind it was created with. Moving work between them is the person's choice.
- Only a person sets Developer tools, per Project, from a window on this host or a device the host's own person paired (maintainer decision, 2026-11-12), journaled. No agent, routine or import sets it.
- An ACP agent whose shell runs in-process without a protocol request is refused below Full access. No shipped profile has one.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Modes](../architecture.md#modes-chat-work-and-code) and [Overview and principles](../architecture.md#overview-and-principles).

### Auto: the provider's reviewer or Octant Shield

At Auto a reviewer stands in for the person's click: the provider's own reviewer where it has one, otherwise Octant Shield.

- The person chooses the reviewer in Settings › Code › Access, with an override on a Code Project's overview. The provider's own is the default where it exists.
- The provider's own reviewer runs for Claude Code, Codex and Mistral Vibe's auto-approve mode.
- A verdict the provider reports is journaled with the provider as approver and shown like a person's approval, with the call it covered. Codex reports approvals and denials, Claude Code only denials, and Mistral Vibe's auto-approve mode none over ACP. The capability report says which (`reviewVerdicts`), and the host never infers a verdict from a call that ran.
- Under Strict, outside content withdraws the provider's own reviewer for irreversible, publish and new-egress classes. Outside Strict the reviewer stays and the thread is only marked ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).

Not built yet:

- The reviewer choice and the outside-content withdrawal outside Code: both are built only in Code's Settings, Code Projects and Code's Auto.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Reviewed](../architecture.md#security-and-authority).

### Octant Shield

Octant Shield is Octant's own automatic approval reviewer for every runtime that routes approvals through Octant. A Watcher reads outside content and a Judge answers approvals, and they never share input.

- The Judge runs hard lines and deny rules, then fast allow rules with no model call (reading a command exactly as written), then model judgment. The model sees only the person's messages, the pending call, the root, the level, the taint state and the Watcher's labels, never tool results or fetched content.
- A malformed answer, a timeout or an unreachable model means ask: Shield fails closed to the person.
- Malicious-call classes (secret reads then egress, a download piped to a shell, obfuscation, persistence, credential and keychain access, mass deletion, rewriting shared history, disabling security settings) go to the person or are refused, never allowed.
- Shield grants per call only, never a standing rule, and never widens the OS sandbox. On a tainted thread it cannot allow irreversible, publish or new-egress classes.
- It pauses after 3 denials in a row or 20 in a thread, both settings in Settings › Limits ([Octant's own limits become settings](#octants-own-limits-become-settings); maintainer decision, 2026-11-21).
- The Judge answers for the Octant Harness, Claude Code, Codex, OpenCode, ACP agents and Pi, and their subagents, on a Code thread or a Work thread at Auto where Shield is the reviewer. Each decision is journaled and shown in the transcript (on Work, as a review row among the tool steps).
- With Network limits on, the Judge allows by rule a call that names only [safe network](#safe-networks) destinations (never a shell command) on an untainted thread.
- The Watcher can only raise. Its deterministic detectors read every app-managed tool result and plugin MCP result before the model does. A label marks the thread, reaches the Judge as a kind, tags the tool row in every mode (quietly at Full access) and marks the Code board card. It also reads a runtime's own web results where the adapter sees them (ACP content items, Codex's standalone search, OpenCode's web text); a search Codex's model provider runs itself returns nothing to read, so it is only marked.
- Shield uses the thread's account and its smallest model by default, or another endpoint. It sends no telemetry, counts against spend ceilings, records its usage under the thread and journals every decision.
- Automatic model calls (the Judge, person memory's distilling, [thread titles](model-endpoints.md#thread-titles)) share Settings › Providers & Models › Automatic model calls, set from a local window or a device the host's own person paired (maintainer decision, 2026-11-12).
  - Each job keeps the default or uses one account and model the person picks, API-key accounts included, and says that what it reads goes to that provider.
  - Selection is manual: an unusable chosen account sends the Judge's decision to the person and makes distilling wait; nothing fails over. Each row names the account used.
  - The Octant Harness's advisor review is routed by its own slots, not here.
- Shield's SSH rules are in [Server SSH profiles](#server-ssh-profiles).
- A release with Shield requires measuring its false-allow rate on a fixture set of known-safe and known-unsafe calls; the fixtures and a measurement script exist.

Not built yet:

- The false-allow rate of a real model: not yet measured.
- Automatic model calls on a paired client: the server admits a person-paired device; the paired UI is a follow-up.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Octant Shield](../architecture.md#octant-shield).

### Safe networks

The person names trusted places (hosts, domains, address ranges, private-network tags) whose egress passes by rule.

- Places are an account default with a Project override in Settings › Permissions. Only a person changes them, at a local window or a device the host's own person paired (maintainer decision, 2026-11-12). Each list is journaled whole and replayed.
- Network limits, a host setting, are off by default (maintainer decision, 2026-11-14). Rationale: Octant never takes a provider's core features away, so open network is the default. The setting is journaled (`safe-networks.limits-set@1`), set like the places, and read at each launch.
- Limits apply only to sandboxed runtimes: the guarded levels, and Full access that keeps the sandbox. With limits off, Codex's sandbox is told it has network and Claude's allows every host.
- With limits on, each sandboxed runtime runs on its own egress proxy and reaches only its provider's endpoints, its Project's egress rules and these places. Octant Harness commands always run on their own proxy; limits on also opens these places to them, so for commands on is wider than off.
- Egress elsewhere goes to the Judge at Auto (for Claude's own process and sandbox and harness commands) and to the person otherwise, journaled per host.
- A refused host is named and listed under Recently refused, where the person can trust it.
- No place may reach a link-local address, and an unlisted name is refused before any lookup.
- This runs on macOS and Linux. OpenCode keeps open network on Linux, because the host connects into its server. Outside Plan only proxy variables route Claude's own process.
- Taint suspends places for harness commands and for launches that name a marked thread.
- Live Codex and Claude turns with limits on, and measuring the hosts an ordinary Code turn needs, are maintainer checks still owed.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Provider runtime network](../architecture.md#provider-runtime-network) and [Octant Shield](../architecture.md#octant-shield).

### Server SSH profiles

The person registers their own servers with an action profile, and SSH to a registered server is judged by that profile in Work and Code alike.

- A server is an SSH-config alias, a user and a profile (Read-only, Operate or Admin), with optional deploys and a runbook. The registry is in Settings › Permissions › Servers, journaled; a Project's list replaces the account list. A local window or a device the host's own person paired edits it.
- Keys stay out of the agent: the session gets the person's SSH agent or the credential broker, and Shield refuses reads of key paths.
- The broker can hold an Ed25519 key per server. It shows only the public line and signs only that server's login, through its own agent socket, never falling back to the person's agent.
- The Judge judges `ssh`, `scp` and `rsync` by profile: a download reads, an upload is Admin, a deleting sync is lock-out. An unregistered host, a key path, a tunnel, a destructive remote command or a remote secret read goes to the person or is refused.
- Destructive or lock-out actions go to the person at every level below Full access. At Ask first, the first connection to each host in a thread asks, and no remembered approval covers it.
- Every remote command is journaled with its host, and its exit status where the runtime reports one (Harness, Codex). Remote output passes through the Watcher. A runbook is a note that grants nothing.
- Below Full access on macOS and Linux, a harness `ssh`, `scp` or `rsync` call reaches only the servers it names, through per-command relays and a host-owned signing socket. Octant carries no SSH protocol of its own.
- A provider runtime's own commands reach registered servers below Full access, outside Plan, through a read-only SSH folder and a socket that signs only for a registered server's recorded host key. With Network limits on its `ssh` reaches no server.
- Settings › Remote access tells host control, registered-server commands and server-folder work apart, with private-routing guides and read-only connection checks that start nothing ([Server Projects: Setup entry](server-projects.md#setup-entry)).

Not built yet:

- A command record with exit status for OpenCode, ACP agents and Pi: they do not name their commands, so Shield's decision is their record.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Octant Shield](../architecture.md#octant-shield) and [Modes](../architecture.md#modes-chat-work-and-code).

## Key providers

### Key providers run as themselves

A key provider (Claude Code, Codex, OpenCode, Mistral Vibe and every ACP agent) runs inside Octant as it runs on its own: its native subagents, web tools, skills and home configuration, and the Project's hooks, MCP servers and plugins, plus Octant's journal and views. Octant adds capabilities and takes no core feature away.

- The person's own setup is on by default at every level. Each call still meets the thread's level: Ask first asks, Auto's reviewer decides, and Full access runs without asking.
- The person's home hooks run at Ask first and Auto outside Octant's approval cards, as in the provider's own app. Plan and Chat run none.
- Chat loads the person's MCP servers, skills and subagents, with no folder and no shell. Plan stays read-only.
- The person turns the setup off per account (Run as itself, stored as `nativeSetup: false`) or per thread (Account default, On, Off). Off beats Full access. A thread's On never grants a Project's code.
- Only the host's own person changes these switches, from a window on the host or a device they paired. Each change is journaled, and the host applies it to every session it starts or resumes.
- An account turned off keeps the runtime's own web search and fetch off in every mode and at every level. Claude Code never offers `WebSearch` or `WebFetch`, Codex starts with `web_search = "disabled"`, OpenCode denies `websearch` and `webfetch`, and Mistral Vibe launches with both disabled. Full access, a trusted Project and a thread's On turn the rest of the setup on, but not these two. (maintainer decision, 2026-11-15)
- Turning the setup on never turns on the provider's own memory, telemetry or self-update. Those follow their own settings ([A provider's own memory](#a-providers-own-memory), [Provider telemetry and self-update are the person's switches](#provider-telemetry-and-self-update-are-the-persons-switches)).
- A Project's own settings, hooks, MCP servers and plugins load in every Project the person added, at every level but Plan. Under Strict they load only where the person allowed the Project's code ([Adding a Project trusts it for every agent](#adding-a-project-trusts-it-for-every-agent)).
- Under Strict, a Work or Code thread shows one quiet notice per Project when its Project holds code for its key provider that the person has not allowed. The notice names the provider and what Strict holds, with Allow Project code (the Project trust command, listing every key provider) and Not now (hidden for that Project in this browser). The host reads only which of the files that each driver holds until trust exist at the Project root: Claude Code's, Codex's `.codex/config.toml`, Mistral Vibe's, OpenCode's `opencode.json(c)` at the root and in `.opencode` with the `.opencode` agents, commands, plugins and tools, and each other ACP agent's held Project entries. The next session or turn picks up the trust. (maintainer decision, 2026-11-18)
- Octant journals a native child run, marks the thread when a native web tool reads outside content, and reports each capability honestly.
- Accounts turned off before 2026-11-14 stored no value, so they read as on after upgrade. An older build cannot read `nativeSetup: false`, so downgrade is not supported.
- Each provider's own rules: [Claude Code decides with its own permission modes](#claude-code-decides-with-its-own-permission-modes), [Claude Code's full tool preset](#claude-codes-full-tool-preset), [Codex runs as itself](#codex-runs-as-itself), [OpenCode runs as itself](#opencode-runs-as-itself), [Mistral Vibe runs as itself](#mistral-vibe-runs-as-itself), [ACP agents run as themselves](#acp-agents-run-as-themselves).

Status: Built. Since: 2026-11-14. Detail: [Architecture: Providers](../architecture.md#providers) and [Provider runtimes: Key providers](provider-runtimes.md#key-providers).

### A provider's own memory

Each key provider account has its own memory setting, on by default in Work and Code outside Plan and stored only as the person's off (`ownMemory: false`).

- It applies to Claude Code's auto-memory and Codex's memories. OpenCode and Mistral Vibe keep no memory behind a switch Octant sets, so their accounts carry no setting.
- Only a person at a window on the host or a device they paired sets it (maintainer decision, 2026-11-12). The change is journaled.
- Run as itself, a trusted Project and Full access never turn memory back on once the person turned it off.
- In Plan and Chat, Claude Code's memory loads read-only on the same setting. Codex's follows the setting there outside Strict (maintainer decision, 2026-11-21) and stays off under Strict, because Codex writes memories in the background ([Plan and Chat tool parity](#plan-and-chat-tool-parity)).
- Accounts that turned memory off before 2026-11-14 stored no value, so memory reads as on for every Claude Code and Codex account after upgrade.
- A provider's global memory follows its own rules into every Project, outside Octant's controls, and the setting says so.

Status: Built. Since: 2026-11-14. Detail: [Provider runtimes: Key providers](provider-runtimes.md#key-providers).

### Claude Code decides with its own permission modes

Octant maps its levels onto Claude Code's native permission modes, and Claude Code's own permission engine and the person's Claude Code rules decide each tool call, as on its own (maintainer decision, 2026-11-15).

- Ask first maps to `default`, Accept edits to `acceptEdits`, Auto to `auto`, Full access to `bypassPermissions`, and Plan to `plan`.
- This applies outside Strict, in Work and Code outside Plan, for a session that reads the person's own Claude settings (`claudeOwnPermissions`). Claude's own rules decide every call Octant does not keep: the `PreToolUse` hook answers no decision, and `canUseTool` sees only Claude's asks. A session that reads no Claude settings keeps Octant's gate and sandbox, since that file holds the person's sandbox and permission rules.
- Octant keeps its own ask for a question, a publish, a wake-up, a `Workflow` start, a command leaving Claude's sandbox, a path outside the session's folders and a switch into a worktree outside them, and answers questions, wake-ups and level changes itself.
- A call that passed every Octant refusal is left to the person's own Claude permission rules, so `permissions.allow` (a trusted Project's committed `.claude/settings.json` included) runs it unasked, and only a real ask becomes an Octant approval or review. The command sandbox still asks for each command. (maintainer decision, 2026-11-14)
- When Claude Code asks, the ask reaches the person as an Octant approval, decided and journaled on the server.
- An approval the person keeps for the session goes back as Claude Code's own suggested allow rules at session scope, never written to the person's settings files. One-call and reviewer answers, Plan, Strict and Octant's per-call asks stay bare. (maintainer decision, 2026-11-25)
- Strict, Plan and Chat keep Octant's gate. Plan stays read-only and Chat has no shell.

Status: Built. Since: 2026-11-15. Detail: [Architecture: Security and authority, The provider's own permission system decides](../architecture.md#security-and-authority) and [Provider runtimes: Full built-in tool set](provider-runtimes.md#full-built-in-tool-set).

### Claude Code's full tool preset

Outside Strict, Plan and Chat, Octant offers Claude Code's full built-in tool preset with no Octant deny list (maintainer decision, 2026-11-15).

- A mode switch or wake-up tool the host does not answer is refused at the call with a reason the model reads. A feature the person turned off in their own Claude setup (subagents, web tools, skills) stays out, as their choice.
- Under Strict, Work and Code outside Plan hold the built-in set less a withheld list whose every entry would break a server rule (the mode switches and, by feature or session, other tools). A tool Octant has no rule for asks below Full access there, so a new Claude Code tool works on release and fails closed.
- A turn has no tool-call cap. Approvals, questions and pre-tool grants past their caps wait in line instead of failing the turn, so parallel subagents can each ask (maintainer decision, 2026-11-14).
- Claude Code loads its own subagents (each a child run, every call through the parent's gate), web search and fetch (asking below Full access, marking the thread), home skills, settings and hooks, the plugins the person enabled (their hooks following the hooks switch), and a trusted Project's settings, hooks, skills, MCP servers and plugins.
- Its account's MCP servers and claude.ai connectors start in every Project at every level but Plan, where only servers marked "Read-only — allowed in Plan" start ([Plan and Chat tool parity](#plan-and-chat-tool-parity)). A Project's `.mcp.json` stays held until the Project is trusted, by leaving the `project` setting source off.
- The claude.ai service tools follow these rules on the person's own account, each answer marking the thread as outside content. Session-internal tools with no side effect (`ToolSearch`, the checklist) run unasked at every level.
- `EnterWorktree`, `ExitWorktree` and `REPL` take the shell's approval rules; Plan withholds all three. `REPL`'s start is journaled as unsandboxed. A worktree switch is journaled with a notice that file views and diffs stay on the original checkout; a worktree outside the Project's folders is held only once its switch is allowed.
- Paths: at Full access Claude's file gate allows any path, protected files included. Below it, a path outside the Project's folders asks (Auto's reviewer decides), and every secret-path refusal stays. Plan refuses an outside path.
- Below Full access a command may leave Claude's sandbox (`dangerouslyDisableSandbox`). It asks at Ask first and Accept edits, goes to the reviewer at Auto, is never covered by a remembered answer, is journaled as unsandboxed, and is refused in Plan.
- A `cd` into a folder the session holds moves later calls' working directory there. Outside Strict, in Work and Code, an outside working directory is allowed at Full access and asks below it; the folder is held once the person keeps the allow (a one-call or reviewer's allow leaves the next call asking). Plan, Chat, Strict and a Full access thread that keeps its sandbox refuse it, and a shell call whose own `cwd` names an outside folder is refused (maintainer decision, 2026-11-25).
- Its `git push` and `gh` writes ask below Full access (Shield decides at Auto). A command its sandbox stopped is retried outside it only with Octant's ask, so git and `gh` read their credentials once approved. The checkout's git identity, every scope and `includeIf` file counted, is carried into sandboxed commits. Octant's pull-request tools stay an option.
- Its task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`) stay on. The task panel follows each result and restates the whole list, naming a running task in Claude's `activeForm` wording only while the turn runs (maintainer request, 2026-11-17). A resumed session's panel is rebuilt from the list Claude stored, read as untrusted input that fails closed to an empty list.
- Plan keeps its read-only list with the task tools added; Chat its explicit list with no filesystem or shell.
- Background tasks, `Workflow` and wake-ups: [Background tasks and turns a runtime starts](#background-tasks-and-turns-a-runtime-starts). Plan-mode tools: [Providers plan in Plan](#providers-plan-in-plan).
- Claude takes image input (maintainer decision, 2026-11-14): `nativeAttachments` is `supported` when a model takes images, and a turn's JPEG, PNG, GIF and WebP attachments go as image content blocks beside the message text; any other image type is refused before the turn is sent.

Status: Built. Since: 2026-11-15. Detail: [Provider runtimes: Full built-in tool set](provider-runtimes.md#full-built-in-tool-set).

### Background tasks and turns a runtime starts

Background commands (`run_in_background`) and `Monitor` command watches run outside Plan, and a Work or Code turn completes when the model's reply is done while its background tasks keep running (maintainer decision, 2026-11-14).

- The background tasks show as live tasks in the thread, and the host keeps the session. A kept Work session is held to the thread's level, provider, model, binding and folder, and journaled as the system's turn with the host's fixed prompt. (maintainer request, 2026-11-15)
- A turn the runtime starts by itself on the idle thread is opened by the host as a runtime-started turn at the thread's level that reattaches to the kept session, journaled with the runtime as its origin (`runtime-turn-started`). It answers no tool call until the host has attached it, and one it finishes before then is still read whole on attach.
- The kept session stops when its last task ends with no turn running (after a short wait for the runtime's turn); when the person stops the thread; when the person changes the thread's level, model, checkout or folder, or archives, moves or deletes it; when its Project is relinked, archived or loses a folder the session was granted; after the host's background work limit; when the runtime's turn cannot be opened or never takes the session up; and at shutdown.
- In child runs and single-use sessions, such a turn is held inside the person's turn that started the work, through the same gate and level. The person's stop ends it with every background task. Below Full access it is bounded by the person's runtime-turn count (default 256, none at Full access) and the stalled-turn limit.
- A held turn takes messages: one the person sends meanwhile is steered into it and answered there, or kept by the message queue when no turn is held.
- `Workflow` runs with subagents on. Its agents show as child runs under the `Workflow` call, through the same display and gate as `Agent`. Starting one asks below Full access, because its script runs in the runtime process. A remote run is refused. Its run is held inside the person's turn as a background task.
- `ScheduleWakeup`, `CronCreate`, `CronList` and `CronDelete` are answered from the thread's Octant-owned wake-ups and never run by the runtime, so nothing fires in a session Octant does not see ([Wake-ups the agent schedules](#wake-ups-the-agent-schedules)).

Not built yet:

- A separate origin marker in Chat and child runs: they fold the runtime's turn in without one.

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: Key providers](provider-runtimes.md#key-providers).

### Starting a thread from a provider's own session

An empty Work or Code thread can start from one of the person's own sessions of the same account and folder begun outside Octant, for Claude Code, Codex, OpenCode, Pi and ACP agents that list their sessions (maintainer decision, 2026-11-14).

- Only the person (a window here or the host's own paired device, over a Project the caller can open) adopts one. A session an Octant thread holds is never offered, and two threads never drive one session. The host's journal records which session a thread holds (any journaled resume cursor naming it; for OpenCode across every account, since they share one store), handed to drivers through the provider SDK's `ProviderSessionOwnership` port.
- The adoption is journaled (`native-session-adopted`, then the `provider-session-ready` whose cursor the next turn resumes). While it runs the thread refuses a message, and an admitted or running turn refuses the adoption. One the thread cannot record gives the provider's claim back.
- The thread is marked as carrying outside content from its start. The session's id shows in the thread's details; its title shows in the picker and is never journaled.
- In Work the folder is the one its turns run in. The adoption is recorded on the thread (`adoptedSession`) after the outside-content mark, and the first turn resumes it only on the provider, model, binding and folder it was adopted under (maintainer request, 2026-11-15).
- Codex sessions are listed with `thread/list` in the folder, leaving out threads an Octant thread holds and threads another Octant host started (its `originator`), read without loading, and resumed in place with `thread/resume`. An adopted Codex thread keeps Codex's own tools and none of Octant's, since Codex fixes a thread's tools at start (maintainer request, 2026-11-18).
- OpenCode's sessions are listed, taken up and forked through a server for the folder started outside any thread (maintainer request, 2026-11-18).
- A Code fork continues OpenCode's and Pi's own fork of the source session instead of a text handoff. OpenCode's turn anchors on its last assistant message and the fork uses OpenCode's fork route; Pi's anchors on the last entry Pi wrote and the fork copies the session file through it, recording `parentSession`. Each forks only for the source's folder and mode (Pi also its model); anything else gets the text handoff.
- A Code rewind on either continues the same copy cut at the last kept turn's anchor, and both report `sessionRollback` supported. OpenCode's revert route and Pi's in-place leaf move are not used: they change the source session, and OpenCode's also restores files beside Octant's checkpoints.
- The thread shows the session's earlier conversation, marked as imported: the person's messages and the agent's replies with each tool call named, read server-side through the SDK's optional `nativeSessions.history` (maintainer decision, 2026-11-20). It is bounded to the newest 200 messages within 256 KiB, each clipped to 8 KiB, with the left-out count shown. An ACP agent's replay keeps its newest message and tool-call updates and drops thoughts, plans and tool progress before they count, counting the earlier messages as left out.
- Imported history is journaled once in the adoption's unit under its own `native-session-history` aggregate, so replay and search read it; it is never sent back to the provider or billed. A runtime without readable history, an empty session or a failed read imports none, and the thread says which.

Not built yet:

- History import for OpenCode: its message shape is not one Octant reads.
- Carrying imported messages in a provider-switch handoff or a fork: not built.

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: OpenCode subagents, Strict and sessions](provider-runtimes.md#opencode-subagents-strict-and-sessions), [Provider runtimes: Codex](provider-runtimes.md#codex) and [Imported history](provider-runtimes.md#imported-history).

### Providers plan in Plan

A key provider plans in Plan as it does on its own (maintainer decision, 2026-11-14).

- Claude Code's Plan holds `ExitPlanMode`. Its plan becomes the reply under a **Proposed plan** heading and the call is refused, so the session never leaves Plan by itself.
- Codex's Plan runs in Codex's own Plan collaboration mode, its proposed plan becoming the reply the same way, with Plan's read-only profile and declined approvals unchanged. The person accepts a Codex plan by moving the thread out of Plan and sending the next message.
- In Code, Claude's `EnterPlanMode` (outside Plan) and `ExitPlanMode` (in Plan) are put to the person at every level as level-change approvals. The runtime never switches its own mode. An approval is journaled like any level change, ends the turn that asked, and applies from the next session, except entering Plan in place (below). An approved plan returns the thread to the level it left, never Full access.
- Work has the Plan level, with the same plan-mode approvals ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)). `EnterPlanMode` stays withheld outside Work and Code.
- When the person approves a plan from Claude Code's plan hand-over outside Strict, the host starts the follow-on turn at the returned level with a fixed prompt, resuming the same session, unless a turn of the person's is starting or running or the account refuses unattended host turns. Declining starts nothing. (maintainer decision, 2026-11-25)
- Entering Plan inside a running turn is applied in place through the runtime's `setPermissionMode("plan")`, before the agent hears the answer. The session's gate then judges every later call at Plan and refuses every write, every `Bash` call, every sandbox escape, every unmarked MCP server, every subagent or `Workflow` start and any tool a Plan session would not hold, since the launch profile is the old level's. A failed `setPermissionMode` ends the turn, the gate staying at Plan. (maintainer decision, 2026-11-18)
- Leaving Plan always ends the turn, because a Plan session holds neither the tools nor the sandbox of a wider level. Codex, which sets its policy per `turn/start`, and any provider whose driver reports no enforceable in-place change (the driver port's optional `changeLevelInPlace`) keep ending the turn.
- Which of the two happened is journaled on the answer (`levelChangeApplied`: `in-place` or `next-turn`; Code's `approval-answered`, Work's resolved request).

Not built yet:

- A continuation for Codex: its proposed plan is reply text with no card to approve.
- A provider-proposed thread plan: the thread plan is the person's structured proposal, and no provider has a path to it ([Provider runtimes: Native plan capture](provider-runtimes.md#native-plan-capture)).

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: Plan mode as level changes](provider-runtimes.md#plan-mode-as-level-changes) and [Native plan capture](provider-runtimes.md#native-plan-capture).

### Codex and OpenCode question forms

Codex's question form (`request_user_input`, offered in its Plan mode) and OpenCode's question forms reach the person through the questionnaire Claude Code's questions use, and both report `userQuestions: "supported"` (maintainer decision, 2026-11-14).

- Under Strict, a Codex question marked secret or asking for a password or key is refused with a message to the model and never shown. An OpenCode question form asking for one is refused the same way, never shown or journaled, at every Strict value.
- Outside Strict, a Codex secret question is shown as Codex shows it, in a Code, Work or Chat thread and in an Octant subagent of one (maintainer decisions, 2026-11-21). It is recorded marked `secret` and answered in a masked field the person may reveal.
- The answer travels in the surface's answer command itself (`secretAnswer`) to the Codex process in memory, never as evidence, an answer text or a resolution. The journal, evidence, projections, logs and transcript hold only that a secret answer was given.
- A subagent takes its parent thread's Strict value, so it is asked only while its parent resolves outside Strict.
- Only the person answers one (a window on this host or a device they paired, never an agent acting for them). A secret answer to any other question and an ordinary answer to a secret one are refused. Needs you and the Inbox list the question with no answer of its own, opening the thread.

Status: Built. Since: 2026-11-14. Detail: [Provider runtimes: Codex](provider-runtimes.md#codex) and [Provider runtimes: OpenCode](provider-runtimes.md#opencode).

### Codex runs as itself

Codex keeps its Project skills and, in Chat, the person's tool servers and plugins, and reads the Project's `AGENTS.md` in Work as in Code (maintainer decision, 2026-11-14).

- Codex's own subagents run at every level, each shown as a child run. Their approvals and app-tool calls are answered through the parent's approval path, and their web searches mark the thread.
- With Run as itself off for the account, Codex's subagents stay off: its app-server is leased with `features.multi_agent`, `features.multi_agent_v2` and `agents.enabled` set false, in Chat, Plan, Ask first, Accept edits and Auto alike. They come on if the thread's own choice is On, the Project lists Codex under Trusted providers, or the thread runs at Full access. A thread's Off keeps them off at every level.
- An approval the person keeps for the session is answered `acceptForSession` in Codex's own sandbox, outside Strict.
- Its own review, Project configuration and question form: [Codex's own review runs in Octant](#codexs-own-review-runs-in-octant), [Codex loads its own Project configuration](#codex-loads-its-own-project-configuration), [Codex and OpenCode question forms](#codex-and-opencode-question-forms).

Status: Built. Since: 2026-11-14. Detail: [Provider runtimes: Codex](provider-runtimes.md#codex).

### OpenCode runs as itself

Octant runs OpenCode 2 from 2.0.22 as it runs on its own: its skills, the MCP servers in the person's configuration, the permission rules they wrote, and a Project's own configuration (maintainer decisions, 2026-11-14 and 2026-11-25).

- 2.0.22 is the first release whose routes, permission events and question forms were read; OpenCode 1 does not run. An older install reports `incompatible` with the release found and "Provider runtime 2.0.22 or later is required."; a launch is refused with "This OpenCode is too old for Octant. Upgrade to OpenCode 2 (2.0.22 or later), then check the provider again." A thread whose stored session an older release made resumes as no longer available and starts a new one.
- A feature that needs a later release (file changes and compaction from 2.2.0; the person's own configuration and steering from 2.4.1) is off on an older supported release and never refuses the session.
- The person's permission rules apply over the level, under Plan's denials and Octant's outside-directory rule; a catch-all allow or ask is ignored.
- Their deny rules hold at every level, Full access included, since a deny only narrows (maintainer decision, 2026-11-25). A catch-all deny keeps its place among their rules, so an allowlist-style configuration refuses and allows in Octant what it does in OpenCode. Their deny of an outside folder is restated after the level's outside-folder rules, and a later allow of theirs gets only the level's answer. Their allow never opens an outside folder the level asks about or refuses. The `question` tool, the thread's attachments folder and Octant's own tools stay Octant's to decide.
- Subagents: [OpenCode's task subagents run outside Plan](#opencodes-task-subagents-run-outside-plan); each delegated session is a child run.
- A remembered approval in Work is answered `always`, saying the grant lives in OpenCode's own store. The host's admission of the files it covers is a ledger of the native process's generation, retired with it and failing closed past 1,024 names: a request whose names would not fit whole is answered `once`, and one the provider settles itself keeps a one-use admission.
- The tool catalogue a resume may reuse is bounded to 128 sessions held 30 minutes. Stale-resume denials last the host's life; an attempted 4,097th distinct retained denial refuses all resumes until restart, new sessions still allowed.
- Octant Shield answers its approvals at Auto.
- In a trusted Project outside Plan it loads the Project's own configuration (`OPENCODE_DISABLE_PROJECT_CONFIG` unset): `opencode.json(c)` and the `.opencode` agents, commands, plugins and tools, whose rules can override Octant's there, which the maintainer accepted. Plan, Chat and an untrusted Project keep the variable set. Such a launch is not attested isolated, and Octant's tools are offered beside the Project's ([why](provider-runtimes.md#key-providers)).
- From 2.4.1, outside Strict, a Work or Code session outside Plan with Run as itself on reads the person's own OpenCode configuration, cache, state and temporary locations, so their agents, commands, plugins, instructions and tool servers load as in a terminal. Octant adds only the level's permission rules, inline on every session of the thread, subagents included; a session that cannot be held to the level is aborted (maintainer decision, 2026-11-25). With tool servers off, an inline policy keeps every server but Octant's bridge off unless the person's own file allows one, which keeps the private configuration. Their MCP servers are read in both shapes OpenCode has written, their `skill` rules apply with skills on, and a message sent into a running turn is steered. Strict, a setup turned off, Chat, Plan, a kept or chosen sandbox, readiness checks and releases before 2.4.1 keep Octant's private configuration.
- Instruction files load as on its own: no launch sets `OPENCODE_DISABLE_CLAUDE_CODE` or `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`. It reads `<global config>/AGENTS.md` (`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`). Outside Strict a launch on the private configuration that runs as itself links the person's global `AGENTS.md` into its private config folder; below Full access the wall opens that one file, not when it is protected or a link. Under Strict nothing is linked. No launch opens anything in `~/.claude` for instructions. The text grants no authority, and `.claude` skills stay behind `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` and the person's setup. (maintainer request, 2026-11-18)
- It reads, finds, searches and lists inside the Project and its extra folders unasked at every level, Plan included. OpenCode's `.env` refusal and Octant's protected-file list in force stay (at Full access only provider sign-ins; maintainer decision, 2026-11-15), a name pattern refused as its whole folder.
- Outside folders: reached at Full access; below it the Project's extra folders are open and any other folder asks (`external_directory` `ask`, native and ACP launch); Plan refuses them.
- In Plan its other read-only tools (task list, code search, language server, web fetch and search) run unasked; a web read still marks the thread, and edits, shell, delegation and outside folders stay denied. Outside Strict, Ask first and Accept edits allow the same tools unasked (maintainer decision, 2026-11-25); under Strict they ask.
- On a release not proved exclusive, 2.4.1 included, a Work or Code thread outside Strict, Plan and Full access is offered Octant's tools at Ask first, Accept edits and Auto, labelled as mixed (`appManagedToolsOutsideStrict: "mixed"`; maintainer decision, 2026-11-25). The host reads the thread's Strict value with its level; the launch admits the tools wherever it runs with no Octant sandbox, whichever configuration it reads. A launch that does not admit them starts without them. Strict and Plan are unchanged.
- File changes and on-request compaction come only from 2.2.0, the release whose server was read for them; older releases report no file changes and compaction `unavailable`. A change no edit grant names fails the turn only under Strict; outside Strict it is recorded and the turn continues. A compaction request is held open until its run ends, so the closing idle is never read as a completed turn. Rationale: routes and events differ between 2.x releases, so a claim is trusted only for a release that was read.
- Octant's tools reach OpenCode on macOS, Linux and Windows ([Linux parity for provider tools](#linux-parity-for-provider-tools)), pinned to the measured releases. On Linux, Chat and Plan launches run in a read-only capsule with the always-failing `git` stand-in first on `PATH` (maintainer decision, 2026-11-16). On Windows it runs unconfined outside Strict in every mode ([Windows below Full access](#windows-below-full-access)). On any other host a Chat or Plan launch is refused with a sentence naming why, reported per mode (`turnModes`, `host-confinement`).

Not built yet:

- A notice when a launch withholds Octant's tools: the provider contract has no runtime event for it.
- Octant's tools for a Strict thread in a Project trusted for OpenCode: the launch admits them, but the host still reads `unsupported` ([detail](provider-runtimes.md#octants-tools-outside-strict)).
- A level change in place on the person's own configuration, and warm server reuse between turns: OpenCode starts a new server for every turn ([OpenCode 2 on the person's own configuration](provider-runtimes.md#opencode-2-on-the-persons-own-configuration)).

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: OpenCode](provider-runtimes.md#opencode) and [OpenCode subagents, Strict and sessions](provider-runtimes.md#opencode-subagents-strict-and-sessions).

### OpenCode's task subagents run outside Plan

OpenCode's `task` subagents start without asking outside Plan, at every level.

- This covers `subagent` and its older name `task`, in Work, Code and Chat.
- Plan denies both.
- A person's own OpenCode rule that denies `task` wins.
- Each child session's requests reach the person through the parent's approval path at the thread's level. Octant's server answers and journals them.

Status: Built. Since: 2026-11-15. Detail: [Provider runtimes: OpenCode subagents, Strict and sessions](provider-runtimes.md#opencode-subagents-strict-and-sessions) and [Architecture: Security and authority](../architecture.md#security-and-authority).

### Mistral Vibe runs as itself

Mistral Vibe loads its own skills and Project context, the account's MCP servers, connectors and hooks, and a trusted Project's `.vibe` tools, MCP servers, hooks, plugins and agents under its own folder trust (maintainer decision, 2026-11-14).

- Its own subagents run in Work and Code outside Plan, shown as child runs. Their requests name no tool, so each approval says so plainly, with Allow and Deny under the thread's level; the maintainer accepted that Vibe sends no tool details.
- A subagent runs as one of the person's own custom or installed agents at every level there and may approve its own tools, as in Vibe itself; the maintainer accepted that self-approval. Octant cannot see those calls, so each child run names the agent and says it may have approved them itself. A run as any agent but Vibe's read-only `explore` marks the thread as having read outside content.
- Registry skills follow the person's configuration with its skills. Its `accept-edits` mode runs at Accept edits in Work and Code.
- It stays on the ACP bridge, because its `vibe-app-server` is an unversioned surface that ships with its own client.
- Usage and context are read from verified `vibe-acp` 3.0.3 ([Provider runtimes: Mistral Vibe surface](provider-runtimes.md#mistral-vibe-surface)).
- Session-form questionnaires reach Chat, Work and Code on 3.0.3, the one verified release. Another release reports questions unavailable. The signed-in 3.0.3 question, answer and cancel check is a maintainer live check still owed.

Not built yet:

- Supplementary file-review reads: a bounded same-task resume/read/close candidate and a current Changes consumer exist, but the production capability stays off pending signed-in 3.0.3 read and cold-resume evidence.
- Requested native compaction: a bounded SDK/ACP candidate requires a correlated structured completion; its production allowlist stays empty pending signed-in nonempty compaction and same-task cold-resume proof.
- Native review: no path to it is built.

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: Mistral Vibe surface](provider-runtimes.md#mistral-vibe-surface).

### ACP agents run as themselves

Every ACP agent is a key provider: its account and thread switches work as the others' do, and outside Strict nothing of its own setup is held back (maintainer decisions, 2026-11-14 and 2026-11-21).

- A session that carries the person's setup denies none of the profile's Project or home entries, in every mode, as the agent loads them on its own (`acpLoadsAllOwnSetup`). Gemini CLI and Qwen Code start in every Project, and Grok Build's own trust list is readable.
- Under Strict, and outside it for an account or thread whose person turned the setup off, the Project's entries load only on the Project's allowed code and the home entries only with the person's own setup. Plan stays read-only through its OS wall.
- Kimi Code reads its home `AGENTS.md`, skills, MCP servers, plugins and hooks with the matching features, Kilo its own skills, and fx the Project's `AGENTS.md`. Each reports only those features.
- Kilo's and Devin's managed configuration stays, since it carries the level's permission and Octant's chosen agent or mode.
- Each agent's own subagents run in Work and Code outside Plan, at every level there, wherever the person's setup carries them. Plan and Chat run none. Octant releases Grok Build's `GROK_SUBAGENTS` and Devin's `subagents_enabled`.
- A permission request naming a call Octant never saw is shown as "A <agent> subagent asks to run a tool. <agent> doesn't say which." with Allow and Deny under the thread's level, instead of failing the turn.
- Only Mistral Vibe names child sessions. For any other agent, the first request naming a call Octant never saw journals a child run that says Octant cannot see its tool calls or when it ends, and marks the thread as having read outside content.
- Outside Strict an ACP agent runs on the person's real home where the session carries the person's setup, the launch has no Octant sandbox, and the agent's session store is the same place on both homes. (maintainer decision, 2026-11-25)
- An ACP agent whose `initialize` advertises image prompts, and a Pi model whose own listing names image input, take image attachments, reported as `nativeAttachments`. Others stay text only.

Not built yet:

- The person's real home for Devin, Goose, fx and added ACP agents: they keep the managed home on every launch, because nothing confirmed pins their session stores ([Provider runtimes: The home an ACP agent runs on](provider-runtimes.md#the-home-an-acp-agent-runs-on)).

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: ACP agents](provider-runtimes.md#acp-agents) and [Provider runtimes: Key providers](provider-runtimes.md#key-providers).

### Provider slash commands and the `@` menu

A provider's own slash commands are listed in every composer's `/` menu beside Octant's, labelled as the provider's, and choosing one sends `/name` to the runtime as the prompt (maintainer principle, 2026-11-14).

- Every mode forwards them, Chat and Plan included, and the Chat thread composer lists them too. The level's tool rules decide what a command may do ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)). (maintainer decision, 2026-11-16)
- Claude Code's come from its initialization list and `commands_changed`, the ACP agents' from `available_commands_update`, and OpenCode's from `GET /api/command`, run through `POST /api/session/{id}/command` rather than as text (read at 2.0.22 and 2.2.0).
- Kimi Code runs, in every mode, a leading slash only for a command its session listed, or its readiness check listed until the session lists any (`listedCommandsOnly`). No reviewed inventory refuses a release, whatever commands it lists ([Provider releases are ranges, not pins](#provider-releases-are-ranges-not-pins)). (maintainer decision, 2026-11-21)
- Codex lists `/review` ([Codex's own review runs in Octant](#codexs-own-review-runs-in-octant)) and no other command: its app-server lists skills, invoked by `$name`, and no prompts.
- Codex's own skills and installed plugins are listed in the composer's `@` menu after Octant's, labelled as Codex's. In a local Work or Code thread or draft whose launch loads Project skills (`nativeSetup.skills === true`), the folder's skills are read via `skills/list` and listed beside them labelled **Project**. Nothing shows, not even greyed rows, when Project skills are off, in Chat, or on a server Project. (maintainer requests, 2026-11-18 and 2026-11-19)
- Choosing one writes `$name` or `@name`. The driver sends each reference it resolves against Codex's own listing for the thread's folder as a `skill` or `mention` input item beside the text, never a Project skill Octant switched off for the thread nor a plugin on a thread whose plugins are off.

Status: Built. Since: 2026-11-14. Detail: [Provider runtimes](provider-runtimes.md) and [Architecture: the composer's `@` and `/`](../architecture.md#person-memory).

### Octant adds no restrictions of its own unless Strict is on

A person who moves from a provider's own CLI to Octant keeps every workflow that worked there; Octant restricts a provider no more than any other agent workspace does. Octant's extra protections are the opt-in Strict setting, and Full access adds nothing (maintainer decision, 2026-11-16).

- Strict is set per thread, as a Project's default, and as the Code and Work defaults in Settings; the host resolves it at each launch and call.
- Environment outside Strict: a provider gets the host's environment as the person's shell has it, less `OCTANT_*` and the variables that would sign it in as an account other than the one chosen in Octant (maintainer decision, 2026-11-26). `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, AWS keys, the Bedrock bearer token, other services' `*_API_KEY` and other model providers' keys cross. Kept out: the four Anthropic and Claude sign-in variables for Claude Code, the variable an ACP agent's Octant account key is passed in, and the host's Codex sign-in variables for an extra Codex account. The first Codex account, Pi and OpenCode sign in from the host's variables. This holds for every key provider, Pi and their provider terminals.
- Environment under Strict: a fixed list per provider (OpenCode's carries every model provider's key, since it signs in to any of them), plus the names the person adds in Settings › Providers & Models › Let through under Strict. Settings refuses an `OCTANT_*` variable, a model provider's key and a 65th name. A kept Strict session and a Strict Codex lease relaunch when their list changes. A provider terminal runs the person's shell startup files, which may set a credential again.
- Outside content marks and shows the thread. Outside Strict it withdraws neither provider web search nor the provider's own reviewer, and below Full access it makes no network MCP server or Computer action ask again, delegation ask once, or pull-request comment or review reply ask. Strict keeps all of these.
- A tainted thread's web search query that looks like it carries data (a URL, an address, a long hex or base64 run, long text) is refused only under Strict (maintainer decision, 2026-11-21; [Search queries on a tainted thread](#search-queries-on-a-tainted-thread)).
- A provider's own tools may use the files Octant protects, at every level; outside Strict Codex's sandbox and OpenCode's wall and rules refuse only other providers' sign-ins. The exception is Claude Code's own file tools: below Full access Octant's gate holds them to the protected list, with or without Strict (`claudeSecretGuardApplies`, `apps/server/src/providers/claudeDriver.ts`). Octant's own file tools refuse them below Full access. Strict refuses them for every tool.
- Denials go back to the model; no count of denials ends a Code turn.
- A provider's own git and `gh` commands, merge, force-push and push to the default branch included, follow its own permission mode and run unasked at Full access, journaled. Octant's pull-request tool and Octant Harness keep the merge rules, and Shield keeps its forge hard lines. Strict asks for the provider's commands too.
- Marketplace installs follow the person's provider settings. Wherever a provider has a per-launch switch, telemetry, error reports, `/bug` and `/feedback` stay off unless the person turns provider telemetry on, and self-update stays off unless they let providers update themselves; Strict keeps every guard set ([Provider telemetry and self-update are the person's switches](#provider-telemetry-and-self-update-are-the-persons-switches)).
- A provider's native approvals, plans and working directories stay native (maintainer decisions, 2026-11-25): a kept approval is the provider's own session grant, Claude Code may work outside the Project, and an approved Claude Code plan is carried out by a turn the host starts. A Codex approval reaching outside the Project asks below Full access and is accepted at Full access; a Codex file change outside the Project is journaled without a file-change record and the turn continues. Strict keeps each refusal ([Claude Code's full tool preset](#claude-codes-full-tool-preset), [Providers plan in Plan](#providers-plan-in-plan)).
- What a runtime sends is read tolerantly; an unknown message never ends a turn ([Server authority, an authoritative journal, and strict host reads](#server-authority-an-authoritative-journal-and-strict-host-reads)).
- Octant's own agents work unattended (maintainer decisions, 2026-11-25): a helper takes its parent's Strict value and, under a Work parent, its level; a coordinator's turn runs at its thread's level; a routine the person asked for starts active on a thread with no outside content; a missed wake-up runs on return. A turn's event budget and the outside-content interrupt under a provider's reviewer apply only under Strict ([Child agent runs](#child-agent-runs), [Coordinator threads](#coordinator-threads), [Routines](#routines), [Octant's own limits become settings](#octants-own-limits-become-settings)).
- Codex may sign in to Amazon Bedrock with an AWS profile or exported credentials; only a Strict session's lease refuses it, and the account stays ready.
- Slash commands run in every mode and level ([Provider slash commands and the `@` menu](#provider-slash-commands-and-the--menu)). Project trust: [Adding a Project trusts it for every agent](#adding-a-project-trusts-it-for-every-agent). A provider's own setup loads as on its own, and Strict keeps each hold-back ([ACP agents run as themselves](#acp-agents-run-as-themselves), [A provider's own memory](#a-providers-own-memory), [Skill discovery and Project code denial](#skill-discovery-and-project-code-denial)).
- Full access may be the default level, behind a one-time warning (Settings › Code's Default mode, Settings › Chat & Work's default access). New threads still start asking.
- Work has the Plan level, journaled and offered by the web and phone pickers. In it every Work tool family and Octant Harness refuse what changes something, provider launches use Code Plan's read-only profile and tools, and Claude's `EnterPlanMode` and `ExitPlanMode` become level-change requests (the plan carried whole) that Shield and a provider's reviewer never answer. An approved plan returns the thread to the level it left, never Full access. A paired phone answers with the desktop's Plan block (**Approve plan ·** the level, **Keep planning**; **Switch to Plan**, **Keep working**), approving only after its own confirmation, journaled as the device.
- The person's Project terminal, a Work Project's included, runs unconfined; Octant's sandbox applies to it only under Strict.
- At Full access with several image profiles ready and no kept choice, a default profile makes the image; "Ask again" brings the card back.
- A launch waiting on the host's resource queue keeps waiting; it is not refused after 30 minutes.
- Work below Full access gets Code's one-use Browser page-script permission, through the same function; under the thread's Strict, read at the call, it is refused.
- `octant agent --full-access` gives one run's thread Full access, journaled as `fullAccessRunFlag` and saving nothing on the Project. The host refuses it from anything but a window on this host, and, naming Strict, wherever the thread would resolve Strict on (its choice, else its Project's default, else Settings), read before anything is journaled. An agent's `octant agent mcp` call cannot choose it.
- An extra folder may be the home folder: the host answers with a warning and a single-use receipt for that folder and window, and only a confirmed resend adds it. Credential folders stay protected. Under the Project's Strict, read as it is added, the home folder is refused outright.
- The stalled-turn limit is Off at Full access and 30 minutes below it. Outside Strict it journals `turn-stall-noticed` and shows one quiet line with Stop; under Strict it stops the turn.
- Loop detection: 6 identical consecutive tool calls (canonical sorted-key JSON input, on providers whose events carry tool inputs) journal `turn-loop-noticed` and show one quiet line with Stop outside Strict. Under Strict they stop the turn, journal `turn-loop-stopped` and leave the thread ready. On Octant's own tools the 3rd identical call still runs and appends one informational sentence, never a refusal.
- An outside driver on Linux runs unconfined, labelled, and is `host-prohibited` under Strict ([Linux parity for provider tools](#linux-parity-for-provider-tools)). Windows: [Windows below Full access](#windows-below-full-access). Codex's own sandbox: [Providers run in their own sandbox](#providers-run-in-their-own-sandbox).
- Opt-in Blocked tools (Settings › Permissions), empty by default, journaled, changed only by the host's own person at a window or paired device, for Claude Code, Codex, OpenCode and Pi. Every launch carries it (`blockedTools` on start and resume), with or without Strict, through Claude Code's `disallowedTools`, OpenCode's permission deny, Codex's config switches (shell, image view, web search, an MCP server's `disabled_tools`) and Pi's tool list and bridge. A Codex name its config cannot switch off is refused when added.
- Each Strict launch journals what Strict kept (`strictKept`, from its Strict value, runtime family and sandbox); the thread shows "Strict kept: …" once, and again only when it changes.
- Kept at every Strict value: read-only Plan, Chat with no folder or shell, outside folders asking below Full access, refused secret questions and unjournaled secrets ([Codex and OpenCode question forms](#codex-and-opencode-question-forms)), Run as itself off keeping web tools off, and signing a provider in only as the account chosen in Octant.

Not built yet:

- The Let-through list for an OpenCode, ACP or Pi launch that keeps or chose a sandbox outside Strict, a version read, a provider's tooling commands and a runtime placed on a server: each builds its environment on a path the list is not wired into ([Architecture: Security and authority](../architecture.md#security-and-authority), the Environment rule).

Status: Built. Since: 2026-11-16. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Claude artifacts and Claude Design work as in Claude Code

With an account's Claude artifacts switch on, Claude's `Artifact` tool works as in Claude Code, so Claude Design's `/design` and `/slides` work in Octant (maintainer decision, 2026-11-16).

- Outside Strict the account switch alone decides the offer, in every mode. The thread's Canvas or artifacts choice only points Octant's delivery instructions. Strict keeps the thread's choice and the publish-only, Project-file rule.
- Every action works in Work and Code: `quickstart`, publishing from a type with no local file, `read`, `list` and updates. A publish naming a local file follows the thread's file rules, asking outside the session's folders below Full access.
- Chat and Plan offer the read-only actions and refuse publishing.
- With several Claude accounts, each is its own provider instance with its own sign-in, configuration folder and switch. A thread's calls reach only the claude.ai account it runs on, the publishing account is journaled with the page, and claude.ai decides whether a later account may update an earlier account's page.
- An API-key account never offers the tool.
- Each publish journals its account, thread and the Claude artifact type its call named, and the page appears in the Artifacts library ([Artifact library and tags](#artifact-library-and-tags)). A `read` or `list` answer journals no page.
- The launch's telemetry guard: [Provider-published artifacts](#provider-published-artifacts).

Status: Built. Since: 2026-11-16. Detail: [Provider runtimes: Claude Code](provider-runtimes.md#claude-code) and [Architecture: Security and authority](../architecture.md#security-and-authority).

### Codex's own review runs in Octant

Codex's built-in `/review` works in Octant as in Codex on its own: in every Work and Code mode, Plan and Strict included, Octant starts Codex's review run (`review/start`) on the thread's checkout and never refuses it there (maintainer decisions, 2026-11-16 and 2026-11-18).

- The review runs at the thread's level with no approvals, as Codex's own review agent does. Outside Octant's sandbox it runs in Codex's own read-only sandbox. Inside it (Strict, Plan, Full access that keeps the sandbox) it runs under Octant's sandbox, which keeps Plan read-only. Under Windows Strict at Full access it runs under the session's admitted Codex permissions profile, protected files denied (2026-11-22).
- A Work or Code turn opening with `/review` starts the review on an ephemeral thread of its own. Its findings show under a **Codex review** heading as a review result, not as edits or a plan, and reach the session's own thread so a follow-up turn sees them.
- What the turn carries (Octant's context, waiting messages, a handoff, attached images) reaches the session's thread before the review starts. A Codex release that cannot take it there still reviews, says so in the reply, and the driver sends it with the thread's next turn.
- Chat, which has no Project, does not start one. Only a release without `review/start` reports the review unsupported.

Status: Built. Since: 2026-11-16. Detail: [Provider runtimes: Codex](provider-runtimes.md#codex).

### Codex loads its own Project configuration

Codex loads its own Project configuration as on its own in every Project the person added, outside Plan; under Strict only once the person allowed the Project's code (maintainer decisions, 2026-11-16 and 2026-11-18).

- Octant reports `projectCode` supported for Codex. Every Work and Code thread outside Plan records the Project folder and each extra folder as trusted in the thread's own config, so Codex reads `AGENTS.md` and loads the file without Octant writing to Codex's `config.toml`.
- Plan records no trust: its read-only thread never trusts a folder by itself and still reads `AGENTS.md`.
- Codex's loader keeps refusing the keys it refuses from a Project (`PROJECT_LOCAL_CONFIG_DENYLIST`).
- Under Strict, a thread whose Project holds `.codex/config.toml` is refused before its thread starts until the person allows the Project's code; the Strict notice lists that file.
- Codex's app-server would trust a Project folder by itself, recording it in the account's `config.toml`, when a thread starts with a sandbox that can write the folder and no trust decision exists (codex-cli 0.169.0). With trust stated per thread it never needs to. Octant never marks a folder untrusted, which would also stop Codex reading `AGENTS.md`.

Status: Built. Since: 2026-11-16. Detail: [Provider runtimes: Codex](provider-runtimes.md#codex) and [Architecture: Providers](../architecture.md#providers).

### Adding a Project trusts it for every agent

Adding a Project, or adding an extra folder to a thread or Project, is the person's trust decision for every agent on that Project's threads (maintainer decision, 2026-11-18).

- `projectTrustsProvider` trusts every Work or Code Project outside Strict, and under Strict one that lists the provider under Trusted providers. That list alone still turns the setup on for an account the person turned off.
- Each provider is told the folder is trusted its own way at launch, by a per-launch override rather than a write to the person's provider configuration. A provider that only supports a configuration write gets the minimal trust entry, recorded in its owner.
- No Project folder is marked untrusted for any provider. A Project's instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and the like) are read in every mode, Strict and Plan included.
- No Octant trust card outside Strict. Strict keeps the Project's own configuration that can run code (settings, hooks, MCP servers, plugins, tools defined in the Project) out until the person allows it once per Project, and its Allow Project code lists every key provider at once. Plan stays read-only through the level.
- Folders outside any Project are unchanged and still ask below Full access.
- Codex: [Codex loads its own Project configuration](#codex-loads-its-own-project-configuration). Claude Code runs headless, where its folder-trust dialog is skipped, and reads its `CLAUDE.md` files whatever the trust. Gemini CLI and Qwen Code count every folder as trusted unless the person turned their folder trust on. fx and Mistral Vibe do not hold back the Project's `AGENTS.md` or project context.

Not built yet:

- Grok Build, Mistral Vibe, GitHub Copilot, Devin and Kimi Code keep their own folder-trust lists: Octant does not set them at launch, so their own list still decides what of the Project they load, and Grok Build reads a Project's instructions only in a folder its list trusts.

Status: Partly built. Since: 2026-11-18. Detail: [Architecture: Security and authority, Project trust](../architecture.md#security-and-authority), [Architecture: Providers](../architecture.md#providers) and [Provider runtimes: Codex](provider-runtimes.md#codex).

### Any ACP agent can be added

A person may add an agent from the public ACP registry or their own local command, through the plugin model (maintainer decision, 2026-11-16).

- Installation, trust and enablement stay separate steps, and discovering an agent grants it nothing.
- The launch policy lives in `@octant/plugin-host` (`decideAcpAgentLaunch`). An agent found in the registry, or added and not enabled, starts nothing. An enabled agent the person has not trusted starts in Octant's sandbox at every level, remembering nothing, with none of the person's own setup and none of Octant's tools. A trusted one gets a shipped profile's launch outside Strict below Full access.
- A custom agent runs on the shared ACP stack, on a generic profile that claims only what its `initialize` advertises and selects no mode.
- The host has one `acp-agent` driver kind whose instance holds the source, install record and trust. Settings' **Any ACP agent** section offers Add ACP agent, then Install, Trust, Turn on. The `add-acp-agent`, `install-acp-agent` and `set-acp-agent-trust` commands are each journaled and refused from a client that does not act as the host's own person. Enabling is refused until installed and trusted.
- A registry agent is named by id alone; its package, address and checksum are read from the host's listing. A managed install runs nothing it fetched: npm and uv at the exact release with scripts and builds off; an archive over HTTPS only, refused on a checksum mismatch and marked an unverified download when the registry lists none.
- Deferred package install scripts run on **Trust** with no further prompt (maintainer decision, 2026-11-19): natively outside Strict, and under Strict inside Octant's sandbox with writes limited to the agent's install folder. Each run is journaled as `provider.acp-agent-install-scripts-ran@1` with outcome, actor, timestamp and sandbox state, and a failure leaves the agent untrusted. Connection Check before Trust reports "This package needs its install script, which runs when you trust it."
- The probe-next agents Factory Droid, Junie, Amp, Auggie, Kiro, Trae and Muse are to become first-class profiles, each through the live probe. Those in the registry are listed for adding (`ACP_REGISTRY_AGENTS`, registry commit `131167e`, with each entry's macOS archive and checksum or npm release), each with why it has no profile yet: none has a signed-in probe on record, and their modes, sign-in folders and Project entries cannot be read from the registry entry alone. Trae is not in the registry.
- A probe-next agent may ship as an unverified profile without a live probe: it claims only what its `initialize` reply and sessions show, names no reviewed release, and its runtime card says it is unverified ([Provider releases are ranges, not pins](#provider-releases-are-ranges-not-pins)). (maintainer decision, 2026-11-21)
- Cursor's block is rechecked against its current release and lifted if its reason no longer holds. Its reason, that its compatibility probe never ran, still holds for a profile; Cursor is listed for adding as any ACP agent.
- Google Antigravity's profile: [Google Antigravity runs on the person's own sign-in](#google-antigravity-runs-on-the-persons-own-sign-in).

Not built yet:

- The other probe-next agents' profiles, shipped verified or unverified: none has a signed-in probe on record.
- Cursor's recheck: its compatibility probe has not run.

Status: Partly built. Since: 2026-11-16. Detail: [Provider runtimes: Any ACP agent](provider-runtimes.md#any-acp-agent), [Registry coverage](provider-runtimes.md#registry-coverage) and [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Google Antigravity runs on the person's own sign-in

Google Antigravity's profile (`antigravity`) runs the official `agy` CLI unmodified as `agy acp`, under the rules other ACP clients of the CLI apply (maintainer decision, 2026-11-20).

- In Work and Code outside Strict it starts with no Octant sandbox, network allowlist or held-back setup, at every level, its `default` mode asking Octant before each edit and command. Chat, Plan, Strict, an explicit sandbox and a readiness check stay sandboxed, where it may run `/usr/bin/security` and read `login.keychain-db` for the person's Google sign-in.
- It follows Google's ACP guide, FAQ and Antigravity Terms (read 2026-11-21): only `agy acp` with `--process-per-session` and `--disable-telemetry`; no spoofed identity or environment; no reading of the CLI's credentials; never `agy -p` (wrapping agy "is not supported under consumer plans", so account windows are not read); no automatic account rotation. `AGY_CLI_DISABLE_AUTO_UPDATE=1`, which Google does not document, only stops self-update, which the person's provider switch controls.
- Its turns tolerate stray updates other clients accept. It asks questions, its commands lead the prompt, it gets no client file writes, its process stays open between turns, a thread may start from its sessions, and turn usage is reported. A steered note goes as a second `session/prompt` (`steersMidTurn`).
- It stays inside Google's consumer-plan line: interactive use by one person on their own sign-in (maintainer decision, 2026-11-25). Only `antigravity` declares `personalSignIn` in `ACP_AGENT_PROFILES`, with independent optional restriction fields, so each limit changes in one line:
  - Due routines hold in `awaiting-confirmation` (`routineConfirmation: "prompt-human"`) without pausing the routine or launching `agy`; the person confirms with **Send now** (`confirm-automation-run`) or starts with **Run now** from their window. Restart recovery without a confirming window fails closed.
  - Every other turn no person sent is refused at admission: a waking message or wake-up, a coordinator's worker, Auto-fix, goal rounds, a usage-limit or restart continuation, a child's result, a peer's task, a benchmark cell, another Chat thread's message.
  - Background and single-shot model calls skip or refuse it (`refusesBackgroundModelCalls`: Shield Judge, Person Memory, Decision Review, Thread Titles, Pull Request Reviewers, Image Description, Thread Hand-Off synthesis, Git commit and PR drafting, `acpDriver` `singleUse` sessions). Automatic cross-model routing skips it without probing (`refusesAutomaticCrossModelRouting`: Chat multi-model pools, Chat provider fallback). Outside agents' grants are refused (`refusesOutsideAgents`).
  - `refusesManualCrossModelHandoff` and `refusesHelperRuns` stay unset, so interactive coding workflows keep working. Hub members are the person's own devices, so no other principal drives it.
- An added ACP agent that is Antigravity under another name (the registry's `antigravity-acp`, or a local `agy` or `agy.exe`) is refused when added or turned on, pointing to the built-in provider.
- Each instance chooses its sign-in (maintainer decision, 2026-11-22): the personal Google sign-in (the default, and what an earlier instance reads as); a Gemini API key from the host credential broker as `GEMINI_API_KEY`; or Agent Platform, a Google Cloud project and location as `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` with the host's Application Default Credentials.
- For the last two, every launch selects the method with ACP `authenticate` (`gemini-api-key`, `agent-platform`) and fails closed as not signed in when the CLI does not list it (`signInNotOffered` beside `authentication-required`, pointing at an update or another sign-in; the shared reason literal lets an older client still decode the catalog) or does not accept it (`authentication-required`).
- The personal-sign-in limits lift only for an instance configured with a Gemini API key or Agent Platform, read from its configuration, never from the agent: Google's terms forbid third-party software on the consumer OAuth sign-in, while API-key and Agent Platform access fall under Google's API and Cloud terms. A business browser sign-in stays limited, since cached credentials' method cannot be verified. Strict keeps its credential reach.
- Agent Platform's credentials sit under the protected `~/.config/gcloud` (maintainer decision, 2026-11-22). A sandboxed Agent Platform launch outside Strict, and its readiness check, may read exactly `~/.config/gcloud/application_default_credentials.json`, never write. Strict and a kept sandbox refuse the launch by name. The other sign-ins get no gcloud read.
- An Agent Platform instance is not a helper target; a child start or resume on it is refused by name. A Gemini API key instance is an ordinary target.
- An Agent Platform launch's egress also reaches the one regional host derived from its location (`runtimeHosts`), passed as named hosts and matched like every listed endpoint (host and subdomains), never patterns, so the network input carries no vendor field.
- Its signed-in live probe (keychain read under the sandbox, model and thinking ids, question and session-list shapes) is a maintainer check still owed.

Not built yet:

- An Agent Platform instance as a helper target outside Strict: the refusal dates from when every helper launched Strict, where a confined helper cannot read the credentials; helpers now take their parent's Strict value, and admitting it there is not built.

Status: Partly built. Since: 2026-11-20. Detail: [Provider runtimes: Any ACP agent](provider-runtimes.md#any-acp-agent) and [Registry coverage](provider-runtimes.md#registry-coverage).

## Release scope

### Technical preview boundary

The first release is the technical preview for Apple-silicon Macs, with the provider-neutral plugin and skill marketplace. Signing, notarization and self-update ship as one deliverable, because an updater on an unsigned app is an unauthenticated code-delivery channel.

- The release ships when a maintainer approves the first stable `vMAJOR.MINOR.PATCH` tag in the `stable` environment; daily builds stay previews. Linux is not part of it. A local package built without the maintainers' signing credentials is unsigned.
- The first install is a signed, notarized disk image (`Octant-<version>-darwin-arm64.dmg`) beside the zip, built with `hdiutil` from a committed layout. The feed lists only the zip; Nightly has no disk image.
- Only the final release job moves GitHub's latest release and its `releases/latest/download/Octant-darwin-arm64.dmg` link, after every build row published and the image checked. The newest Preview may be latest only until the first stable release exists (maintainer decision, 2026-11-22). A rerun for an older or superseded release leaves the link alone; Nightly and `feed-*` stay prereleases.
- Candidate and stable releases attach a signed headless build (darwin-arm64, linux-x64, linux-arm64; `octant-artifact.sig`) that carries the pinned Bun. `octant server install|upgrade` refuses one that does not verify unless the person passes `--self-built` (maintainer decision, 2026-11-19).
- The app's minimum is macOS 15.0, which the bundled Simulator tools need (maintainer decision, 2026-11-22). The feed has no guard, so a macOS 14 copy that updates past the last earlier version gets a build that will not launch; the guide and release notes say so. Swift helpers use explicit deployment targets ([packaging](../architecture.md#development-loop)).
- In scope: connectors, a Code thread's Git and pull-request work, a person's merge from any client, host-local routines, the guardrail levels, key providers' native features, Octant Shield, [provider terminals](#provider-terminals) (maintainer decision, 2026-11-21), and public Canvas links through the self-hostable `apps/share`, with no instance run by Ogard Labs (maintainer decision, 2026-11-07).
- An agent merges only as [Pull-request merge](#pull-request-merge) allows: on the person's request with that merge's approval, or under the Project's Agents may merge switch or a routine's merge choice. An agent merge or force-push on its own initiative is out of scope.
- Out of scope: cloud scheduling, an Octant-operated hosted service, physical phones and tablets, and app-store upload, submission and release (maintainer decision, 2026-10-29). Octant drives the simulator only.
- An unauthenticated download of the latest link, and the first release run that signs a headless build, are maintainer checks still owed.

Status: Built. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Native Windows QA packaging

A matching Windows x64 host may build a portable desktop QA archive and check its native dependencies inside packaged Electron.

- The archive includes the source-built private native owner and credential helper at fixed resource paths. QA-only readers are excluded.
- Packaging acquires no native profile.
- The archive by itself enables no native host admission, credentials, Work or Code, installer, or signed-update channel.

Not built yet:

- Native host admission and an update channel for this archive: the archive is for QA only; the signed installer and feed are step 5 of the [Windows sequence](#one-desktop-app-linux-next-windows-later).

Status: Partly built. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### External user guide and maintainer-owned publication

The VitePress guide lives in `Ogard-Labs/octant-site/docs`, outside the application monorepo, and builds on its own for `https://octant.sh/docs/`.

- Application changes update the guide through companion PRs linked in both descriptions.
- The site repository runs its docs gates and uploads a static artifact named for the commit. The maintainer configures and releases that artifact on their VPS; no workflow deploys it or treats an upload as a live publication.
- The application repository keeps the internal specifications and exports semantic theme defaults for the guide. Its CI refuses tracked files under the former `apps/docs` path, so there is no second guide source.
- Missing pages use the supported VitePress layout slot, and links keep the `/docs/` base.

Status: Built. Since: 2026-11-07. Detail: [Documentation build and VPS handoff](../docs-deployment.md).

### First-preview tracks are design-first

Everything on the work board is in scope for the first proper preview release (maintainer decision, 2026-11-06). There is no separate post-preview track.

- That covers mobile maturity, language services and a debugger, enterprise identity, disposable desktops, outside provider drivers, the terms and privacy documentation for MIT self-hosted distribution (a final legal publication review is still required), and the hub-and-spoke topology. Each is built only once its specification documents its boundaries.
- Remote SSH development environments are in scope. A Code or Work Project on a registered server is built ([Server Projects](server-projects.md)).
- The authorization covers design and implementation. Creating an account, spending money, submitting to a store, deploying a hosted service or weakening an invariant each needs a separate maintainer action.
- Release-scope choices (public store distribution, the Windows sequence, the full language-services companion) are the maintainers' to schedule and protect no invariant by themselves.

Not built yet:

- The tracks whose entries mark them not built: each is built only once its specification documents its boundaries.

Status: Partly built. Since: 2026-10-26. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### One desktop app, Linux next, Windows later

Desktop is one product on macOS, Linux and Windows. Platform differences are fail-closed posture, never a second app.

- The sequence is the Linux desktop shell, then the Linux AppImage with its signed feed, then Windows. Windows packaging and CI work may proceed now (maintainer decision, 2026-11-06), but a Windows feed is not trusted before the Linux signed feed has run on a real image.
- The simulator, the Apple workbench and window vibrancy stay macOS-only.
- Windows follows [the Windows sequence](../architecture.md#current-release-boundary) (maintainer decision, 2026-11-14):
  - Step 2: the confinement design, with its launcher built dormant ([Windows confinement for confined launches](#windows-confinement-for-confined-launches)). It admits no launch.
  - Step 3: Work and Code at Full access with the sandbox off (maintainer request, 2026-11-15), and below it as [Windows below Full access](#windows-below-full-access) says. Terminals and the harness shell use the shell Settings › Code › Terminal shell names (Windows PowerShell by default, never a guessed POSIX shell). Every stop ends the whole tree with `taskkill /T /F`. A read that serves no one thread (Codex's catalog, a readiness check) runs unconfined only while new threads run with no Octant sandbox.
  - Step 4, the CLI (maintainer request, 2026-11-15): it opens the shared native profile, opens links through `rundll32` with no shell, and keeps its service as a per-user Run value whose stop ends the owner's process tree. Settings reads that value but does not change it.
  - Step 5 (maintainer request, 2026-11-15): a per-user NSIS installer with no elevation, at a fixed `%LOCALAPPDATA%\Programs\<product>`, whose uninstaller removes only its own files and keeps data. Every program, the uninstaller and the installer are Authenticode-signed through Azure Artifact Signing, failing closed. The `win32-x64` feed is signed, and the unsigned QA zip is never published.
- The native building blocks each admit no Windows startup, migration, Chat, Work or Code by themselves:
  - The native owner uses a Node-API binding, private runtime ACLs, a first-instance pipe and PID and birth receipts, and refuses live or unknown writers. Its evidence must be native, not inferred from packaging.
  - The persistent profile lives only in the user's LocalAppData known folder, with exact owner-plus-SYSTEM DACLs. It refuses path overrides, unsafe records, reparse directories, and a token whose default owner is not the user's own SID; production never rewrites a token.
  - Packaged stable desktop attaches to the host by profile UUID and authenticated owner discovery without claiming the child server's owner, and closing it keeps the host.
  - The credential store is a scoped Credential Manager helper: one blob of at most 2,560 UTF-8 bytes, refused whole beyond that, purposes kept apart, and one per-user mutex that refuses unsafe or abandoned coordination.
  - The desktop identity service is a non-exporting CNG and Credential Manager key (HMAC-SHA256), separate from the server's P-256 identity and the owner unlock.

Not built yet:

- The packaged app reading the Windows feed and running the installer hand-off: waiting on the Linux signed feed on a real image.
- Ordinary Windows startup admission: it needs native packaged startup, attachment and stop evidence.
- Strict on Windows: the confinement launcher is dormant.
- The first signed release with Azure federation, and the CLI on a machine without an administrator token: maintainer checks still owed.

Status: Partly built. Since: 2026-10-16. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Person-controlled update install

An update installs only after its feed signature and artifact hash verify, and only on a relaunch the person starts.

- The release must be strictly newer and name this app (Octant or Octant Nightly), platform, architecture and ring. A release for the other app is refused as the wrong app.
- Anything unverifiable is refused, never downgraded. macOS adds the platform code-signature check, and a Linux AppImage replaces only the image it was launched from.
- A Windows copy at the installer's own location runs a verified installer only after its Authenticode signature is valid and names exactly Octant's publisher. This is not wired in yet, so Windows still refuses updates ([Windows installer and signing](../architecture.md#current-release-boundary)).
- Rings are stable, preview and candidate. Octant follows stable or, by the person's in-app choice, candidate (shown as Preview, or as Nightly with the Nightly install row). The Octant Nightly app follows preview.
- Install waits while agents are active.
- Automatic checks are off until the person opts in, including stores that never recorded a choice. First run asks once whether to check for updates (maintainer request, 2026-11-12). A check carries only version, platform and architecture.

Status: Built. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Scope hold until the Full access rule is built

Bots, the Nightly shared-host client, public Canvas links, and Browser upload and download manifests take no new scope until [The Full access rule](#the-full-access-rule) is built (maintainer request, 2026-11-12).

- The hold adds no rule to those features and removes none: their entries keep their own text and status.
- Windows work is not held (maintainer decision, 2026-11-14). It follows [One desktop app, Linux next, Windows later](#one-desktop-app-linux-next-windows-later) and [Windows below Full access](#windows-below-full-access).
- There is no hosted relay to hold: it was canceled on 2026-10-30.

Status: Designed, not built. Since: 2026-11-12. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Windows below Full access

On Windows outside Strict, every level below Full access runs with the provider's own approvals, and with its own sandbox where it has one. Octant claims no sandbox there. Strict works on Windows only at Full access with Codex ([Windows Strict, phase 1](#windows-strict-phase-1)); everywhere else it is refused.

- The mode picker and the thread say that the provider's own approvals decide and that Octant's sandbox does not run here.
- The server answers and journals every ask.
- Strict below Full access and a kept sandbox are refused by name ("Windows Strict currently works only at Full access with Codex…", `WINDOWS_STRICT_REFUSAL`). The server refuses them, and so does each launch, judged from its own mode, level and Strict value.
- Claude Code, Codex, OpenCode, Pi and the ACP agents start unconfined. Each is stopped with its whole process tree and keeps its launch's ownership receipt. Codex keeps its own sandbox below Full access. A Strict session never reuses a process started outside Strict.
- An npm `.cmd` shim starts the program it names, never through a shell. If it can't, it is refused with a message naming the `.exe` to point Settings at.
- Plan stays read-only through the provider's own plan mode. Octant's own tools keep their refusals.
- Chat runs on any provider that can be told natively to have no folder and no shell:
  - Codex, with no execution environment
  - Pi, with no built-in tool
  - Claude Code, with no file or shell tool
  - OpenCode, with its own deny-everything ruleset that leaves open only Octant's tool bridge and `question`
  - ACP agents, under their own permission handling
    Provider cards and Settings name whose rules keep tools off.
- These run unconfined outside Strict, with the level's own asks, each ended with its whole process tree: Octant's thread and Project terminals, the harness shell, Project actions (in the shell Settings › Code names), repository tests and scaffolds, language servers, and debug sessions. Each one is refused, with the reason, under Strict or a kept sandbox.
- App-managed tools reach OpenCode and the ACP agents through the loopback tool bridge.
- Below Full access, an ACP launch whose person turned the agent's own setup off is refused before its version is read, wherever its profile holds setup back. Windows has no sandbox to hold that setup back: unwrapped Kimi Code started a trusted Project's `.mcp.json` server unasked. (maintainer decision, 2026-11-22)
- A live turn on a person's Windows machine is a maintainer check still owed. CI runs fake Pi and Kilo ACP runtimes built for Windows.

Status: Built. Since: 2026-11-16. Detail: [Architecture: Current Release Boundary, Windows below Full access](../architecture.md#current-release-boundary).

## Process topology and local trust

### Desktop, server and renderer roles

The desktop main process owns native windows, menus, the system keychain and all native pickers. The server is the single authority: it resolves a client principal for every request and journals every mutation. The renderer holds no authority of its own.

- A picker hands the server the chosen path under the desktop bridge secret, and the renderer gets only a single-use receipt bound to its window.
- The server listens on one canonical loopback endpoint, and every mutation goes through services that append to the journal.
- A paired browser mounts the remote shell. The window-bound sidebar, dock and Settings are not served remotely.
- Process-local approvals and grants expire on the process authority clock (wall time once, then suspend-aware elapsed time), so setting the clock back cannot extend one, and a restart discards them. A Browser approval that waits for an answer expires on no clock. A stored grant that outlives a restart, such as a paired device's expiry, uses wall time. No persisted epoch or wall-clock value may block local startup ([Which clock an expiry runs on](../architecture.md#security-and-authority)).
- Shared product state is host-owned. Window bounds, panes, focus, scroll and unsaved drafts stay client-context state. _Here only._
- Canvas role setup finishes before Electron is ready; page startup waits for ready without blocking. Chat navigation keeps one in-flight read and one pending refresh, pauses hidden windows and cancels obsolete reads. Workspace styles load with their views, and sandbox restrictions share one visible-only poll per client and scope.
- The renderer's first load stays within an exact byte budget, and CI refuses growth. A package module the window imports must do no work at import time.
- Crash recovery keeps the desktop alive while it prepares a replacement window, without racing last-window quit. An explicit quit wins, and recovery is bounded to two replacements a minute.
- A stale owner's receipt is quarantined atomically on the data filesystem, apart from socket and secret quarantine on the runtime filesystem, with identity and receipt-first checks.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Local client context and loopback trust

The local trust class is "holds a secret only the host's OS user can read", not "is on loopback". Loopback plus an admitted origin proves nothing about the caller.

- A browser gets a session only through a one-time launch token that expires after five minutes and is bound to the renderer origin it was minted for.
- Every CLI command and every desktop window presents the desktop bridge secret. A launcher sends it only to the host named by the user's owner-only host receipt.
- The listener admits only its own loopback origin, the packaged renderer and the named development origin. A page on any other loopback port is refused and gets no CORS grant.
- A launch address that is plain HTTP to a non-loopback host is refused, and requests that carry the window capability refuse redirects.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Mobile app and remote clients

The phone app is a remote-control client under the host's authority. Threads are host-owned; the phone stores only device keys, a host registry and session material.

- The phone creates Chat, Work and Code threads and sends turns under each thread's authority. A Code thread's approvals, folder binding and file edits stay host-only. What it may answer and open on a Work thread is listed in [Paired devices act as the person](#paired-devices-act-as-the-person).
- Attachments go through the mode's own route, and the host strips image metadata from every paired upload.
- Side panes (Environment, Review, Context & usage, Agents) are read-only on the phone, using reads the listener already forwards. Per-run subagent detail stays with a local window (maintainer request, 2026-11-14).
- Internal beta distribution grants no new authority. Public store distribution, external testers and a listing need a separate maintainer action.
- A build counts only after the runbook's device pass.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology) and [Mobile maturity](mobile-maturity.md#phase-e-public-store-distribution).

### Desktop menu bar and context menus

The menu bar is the closed-window fleet roster, read from the host rather than from open windows. Context menus carry presentation and opaque action IDs only.

- The roster has three sections, Needs you, Working and Done since you looked, with at most six rows each. A row names the thread title, mode and Project.
- The menu bar raises no notifications. Thread titles never enter the public health response or redacted diagnostics.
- The renderer draws every context menu except the code editor's text-editing one, never the system (maintainer decision, 2026-11-15).
- A context-menu contribution cannot supply roles, callbacks, paths, URLs or native commands. The chosen ID returns to the same window, which runs its ordinary action under server authority.
- Chromium's developer tools are hidden in a packaged stable release and kept in development, Preview and candidate builds.

Status: Built. Detail: [Architecture: Desktop menu bar](../architecture.md#desktop-menu-bar) and [Architecture: Desktop context menus](../architecture.md#desktop-context-menus).

### Language services and the debugger

Code editor language services and the debugger run as confined children the server launches per checkout. Agents read the same servers through two read-only tools.

- Checkout references use the server's actual initialized support and the current acknowledged draft. They stay bounded and read-only and never start or retarget a server.
- A cancelled query keeps only an exact late acknowledgement. A lost reply offers a person-controlled document reload, never an implicit restart from Recheck. Unsupported support falls back to the external editor.
- Rename and command-free quick fixes prepare bounded, reviewed edits and apply them through per-file save authority with digest, identity and unsaved-draft checks. Cross-file saves stop on conflict and report partial completion.
- The bundled server can be switched off. A static server added from a local folder installs untrusted and off until reviewed.
- A repository-tooling server starts only after a local-window approval, never in Plan or for a paired device, and never by an agent. The agent's code tool may read through one already running, outside Plan, and marks what it reads as outside content (maintainer request, 2026-11-12).
- A debug session ends at once when its thread, posture, checkout, confirmation or Project goes.

Not built yet:

- The external editor from a paired device: `code.open-external-editor` is still local-host only.
- The bounded `window/logMessage` log, lifecycle counts under Diagnostics, and removing a cache with its checkout or component: not started.
- Starting from the Run and debug panel at Full access without one confirmation: the panel still needs a confirmed configuration.

Status: Partly built. Since: 2026-10-26. Detail: [Architecture: Process topology](../architecture.md#process-topology) and [Language services](language-services.md#debugger-session-rules).

### Host memory pressure

The host watches its own size and the system's memory pressure, and eases itself without stopping a running turn.

- It samples every 15 seconds (every 5 under pressure). A reading the platform cannot give is unknown, never normal.
- Relief runs in order: log the reading, stop idle provider runtimes and parked sessions, then trim caches it rebuilds on demand.
- Memory limits in Settings › Host is Automatic (scaled down on a small machine) or Custom (two sizes in GB). A local window or a device the host's own person paired changes it (maintainer decision, 2026-11-12); it is journaled with the old and new values and applies without a restart.
- The report carries counts and levels only, and nothing leaves the machine.
- Only a clean shutdown marks the memory record clean, so the next start reports an unexpected stop without claiming a cause.
- Settings › Host › Computer resources separately limits new local work (Automatic, manual ceilings, Pause), set the same way. Managed commands share worker slots, managed helpers obey the ceiling, and Claude and Codex inherit cooperative worker defaults. Native delegation and outside processes have no hard quota. A queued launch waits past 30 minutes, as long as its operation allows ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on); [local work resource limits](../architecture.md#local-work-resource-limits)).

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Keep the computer awake while agents work

While agent work runs, the desktop app holds a `prevent-app-suspension` assertion so idle system sleep does not cut off work. It never prevents display sleep, and the renderer holds none.

- The desktop polls the loopback, desktop-only `GET /api/desktop/agent-work` every 5 seconds for counts by kind (active turns, child runs, coordinator workers) and the earliest enabled routine `nextDueAt`, with no titles or paths.
- It holds the assertion while any of those runs or a routine is due within 5 minutes, and releases it 10 seconds after work ends, or at once on quit, host stop, `Never`, or battery under `While on power`.
- Settings › Host › Computer resources › Keep the computer awake while agents work offers `While on power` (default), `Always` and `Never`, in the journaled host resource policy. Only a local window or a device the host's own person paired changes it.
- `While on power` follows Electron's battery state and events, and reads an unknown state as on power. If the blocker does not start, status says `unavailable` and the desktop retries only when work next starts.
- Status lines show counts only (`Kept awake: 2 turns running`), never titles.
- A live macOS `pmset -g assertions` smoke is a maintainer check still owed.

Status: Built. Since: 2026-11-19. Detail: [Architecture: Keeping the computer awake while agents work](../architecture.md#keeping-the-computer-awake-while-agents-work) and [Settings](settings.md#groups-and-pages).

### Other agents start work through the local CLI

Another agent on the host's machine starts and follows Octant threads through `octant agent mcp`, a stdio MCP server, or the `octant agent` command line. Both are local clients under the bridge secret, so the host keeps every authority decision.

- `start_work` takes a prompt and an absolute folder or Project name; the folder's Project decides Code or Work, and none means Chat. `send_message`, `read_thread`, `answer_question`, `stop_turn`, `list_projects`, `add_project`, `list_threads` and `list_waiting` follow the work.
- The caller is not the person. The server never answers a request listed for the person, never starts a thread at Full access, and adds a folder as a Project only when the call says the person asked. The person's own `octant agent --full-access` flag does start at Full access ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).
- Each tool call opens its own window authority and revokes it at the end; a Chat send keeps it until the send answers. A turn keeps running after its window is gone.
- `octant agent --detach` returns once the host lists the turn; `octant agent status <thread>` reads its progress and what waits on the person.
- Remote callers have no path here.

Status: Built. Since: 2026-11-11. Detail: [Architecture: Native harness, scripted callers and other agents](../architecture.md#native-harness).

## App-managed tools

### Tool families and transport

App-owned tools are capability families: one tool per object, with an operation enum and a help operation. Every runtime gets the same definitions through the transport its adapter verified, and no transport edits a person's provider configuration.

- A family whose grant or capability is off is omitted, not advertised and refused. Help never reaches the executor.
- Where a runtime keeps its own tool list, omission is per session: a Claude Code session lists a tool from the first turn that offers it and refuses it in turns that do not, so the cached prefix changes only when a tool arrives.
- A connection binds its catalogue before its prompt and accepts only the expected in-process server and tool names. A catalogue change cannot overlap a running tool turn. _Here only._
- Late, duplicate or cancelled answers are refused, and cancellation reaches the executor even while it waits for approval. _Here only._
- Browser read-page takes an optional CSS selector or snapshot ref. Screenshots go through the provider's image channel, after origin approval and task authority. _Here only._ A missing, malformed or oversized capture is refused.
- Every runtime is told, in one line per offered first-party tool from one shared source, when to use it (maintainer request, 2026-11-17). The line says when, not how, promises no level-dependent approval and stays fixed while offered. A coordinator's `octant_threads` has its own line, and the Harness describes each tool once. Tools not offered, plugin tools and MCP tools get none. A first-party tool without a line or stated reason fails the build ([Agent tools](agent-tools.md#how-tools-reach-a-model)).

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Browser and Computer as tools

Browser and Computer are tools, not mentions. The host offers them on every eligible turn, and authority comes from the person's approval at the moment of action.

- Browser is offered in Work and Code when the provider carries app-managed tools, never in Chat.
- In Plan, Browser admits only reads of the page already open in the thread's Browser (snapshot, read-page, screenshot, diagnostics, audit, tab-list, wait, flow-list, help, a batch of those) and stop. It refuses the rest, a recording included, and stops and discards a running recording. One table of operations decides this, so a new operation needs a row before it compiles.
- Computer is offered only when its plugin is on, a screen bridge or leased desktop exists, the tool is not constrained out, and the turn is not in Plan.
- Outside Strict, Full access needs no first-action Computer approval (maintainer decision, 2026-11-19). Otherwise the first action in each application asks once; the grant lasts until the thread stops, is archived or loses authority, or the host restarts. The card offers Remember for this Project, journaled per Project and application and forgettable in Settings › Computer use.
- Under Strict below Full access, outside content makes every Computer action ask again and withholds remembering. Outside Strict the mark adds no ask ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).
- The person approves and stops control of this Mac at a local window or a device the host's own person paired (`actsAsHostPerson`), journaled. A hub-introduced or restricted device is refused.
- The Browser asks only for a site on a signed-in profile, at every level; the person can remember it or widen it to "Allow all sites in this profile" (maintainer request, 2026-11-12). A Private page needs no site approval and may cross origins (maintainer decision, 2026-11-17). "Always allow" remembers the (origin, profile) pair, only through the approval answer.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### GitHub reads for Code agents

A Code thread's agent reads its Project's delivery repository through one read-only family, `octant_github`: lists of issues, pull requests and projects, one issue or pull request in detail, and a search of issues and pull requests.

- The host fixes the repository to the thread's delivery target. No input names a repository, host, endpoint or flag, and a field an operation does not take is refused. A search keeps only `author:` and `#number` qualifiers and always carries the server's own `repo:`.
- Every call re-checks the thread's binding, its tool constraints and the read's GitHub capability on a fresh snapshot, and changes nothing on GitHub.
- Pages hold 1 to 30 rows; a size outside that is refused, not clamped. An issue's body is cut to 8 KB and each comment to 2 KB, only the newest ten comments come back, and every cut is stated (`bodyTruncated`, `truncated`, `commentsOmitted`).
- A successful read is journaled as outside content before the model sees it, and withheld when it cannot be.

Status: Built. Detail: [Architecture: Reading GitHub](../architecture.md#modes-chat-work-and-code).

### Linear Project mapping and reads for Code agents

A Work or Code Project may bind a Linear team, and optionally a Linear project, on the host. The binding scopes the Linear issue browser, the `Create from…` picker, Start issue auto-selection, and the Code agent's read-only tool `octant_linear` (maintainer decision, 2026-11-24).

- Only a local window on the host sets or clears a Project's Linear binding (`change-project-linear-target`, journaled as `project.linear-target-changed@1`). Chat and archived Projects refuse it.
- `octant_linear` (`list`, `get`, `search`, `help`) is offered only to Code threads whose Project holds a Linear binding while the Linear integration is effective. It never writes to Linear or asks for a new OAuth scope.
- Every call re-checks thread authority, profile allowlists and Linear capability state on a fresh snapshot. It pins list and search queries to the bound team and Linear project, refuses `get` for an issue outside that scope, redacts secret shapes, bounds body and comments, and journals `thread.external-content-ingested@1` before returning data.

Status: Built. Since: 2026-11-24. Detail: [Host reads and commands: Linear issues](host-reads-and-commands.md#linear-issues).

### Zen assistant tool

Zen's assistant arranges its window's Zen space through one family, `octant_zen`, offered only to the Chat thread bound as that space's assistant.

- `get-space` returns the space's version and each element's id and layout, never element content, so a model can make its first change.
- Every change names the version it applies to. An out-of-date one changes nothing, and the conflict carries the current version.
- `create-widget` offers only the kinds it creates (Notes, Checklist, Timer). A recipe widget exists only after the person confirms a preview.
- Labels journaled under the seven older `octant_zen_*` tools still read.
- The tool exists only while the bundled Zen plugin is on. Switching the plugin off withholds it and refuses the Zen routes without deleting any Zen data.

Status: Built. Detail: [Architecture: Zen assistant tool](../architecture.md#zen-assistant-tool).

### One web search

Octant has one web search definition, `web-search`. It is offered to every Chat provider while the thread's research is on and its route searches through Octant's own backends, and by the native harness in every mode where its research or network grant allows.

- A harness Chat thread gets it once, from the harness; the turn adds no second copy.
- A missing, empty or over-long query is invalid and searches nothing; no other text stands in for it.
- A successful result marks the thread as having read outside content. The harness's tainted-query refusal applies to harness threads, not to a Chat thread on another provider.
- Automatic research routing prefers the provider's own search when the provider has one and falls back to SearXNG, so a fresh install can search with no endpoint configured (maintainer request, 2026-11-14).

Status: Built. Detail: [Architecture: Web search](../architecture.md#web-search).

### Web search backends and data policy

Octant's own `web-search` searches an ordered list of backends the person sets up, filtered by one host data policy (Any, ZDR only, EU only, EU and ZDR), so a person under a zero data retention agreement or an EU data boundary can search (maintainer request, 2026-11-14).

- The policy governs only Octant's own backends. A provider's own search, in the harness or a vendor runtime, behaves as it does on its own (maintainer decision, 2026-11-15).
- The tool's name, schema and result shape do not change and never name a backend. The answering backend is journaled, not shown to the model.
- A backend is eligible only when the person states ZDR or EU processing for it and its vendor offers that. With none eligible the tool is not offered.
- A query moves on only when a backend did not answer, within 20 seconds; an empty result does not move on.
- Only a local window or a device the host's own person paired changes the policy, journaled. An organization-set policy is outside the release boundary.
- The native harness offers a provider's own search only on Anthropic's and OpenAI's own APIs: one search per request, withheld from a tainted thread below Full access, decided again on fallback, and marking the thread. Chat's Automatic route uses the provider's search first.
- A vendor runtime's `webTools` follow its native setup, and each key provider launches with its own search off wherever `webTools` is off. Chat's research route keeps its `searxng` value, shown as "Octant web search".
- A stored SearXNG address migrates to the first entry under Any.

Not built yet:

- Switching off a generic ACP agent's own search: the protocol gives Octant no switch for it.

Status: Partly built. Since: 2026-11-14. Detail: [Web search backends and data policy](web-search-backends.md).

## Canvas authority

### Canvas ownership and tiers

A Canvas belongs to its thread's Project, or, for a Chat thread in no Project, to the thread alone. Finished work comes in three tiers (typed blocks, static frames, running frames), and each new block kind is gated by a schema version.

- A thread-owned Canvas holds no file, shell, Git or network authority, takes images only from its own thread, and is never mirrored or published to a replica. A Chat Canvas outside a Project can be shared through the export destinations (maintainer request, 2026-11-12).
- Plan keeps `create` and `revise`, because a Canvas changes only the thread's own document. The agent tool has no publish or share, and the mirror and replica sync write nothing for a Plan thread.
- An older runtime refuses a document of a newer schema version rather than misread it.
- A person's change is journaled as a new head version with a host-stamped actor. A renderer never authors as an agent.
- `describe` reads no Project data and creates no artifact. `preview` renders with the network off and with no server address or credential.

Not built yet:

- A paired device's plain create of a Canvas: the paired browser has no create panel yet ([Architecture: Canvas](../architecture.md#canvas-documents-designs-and-prototypes)).

Status: Partly built. Detail: [Architecture: Canvas documents, designs, and prototypes](../architecture.md#canvas-documents-designs-and-prototypes).

### Canvas frame safety, import and sharing

Frames run nothing unless a design declares script. A running design never reaches the network unless the person turned on that Canvas's Allow network switch.

- A static frame never gets script permission, and no frame has both script and same-origin permission.
- On desktop a running design runs in a prototype host with no network route and no resolver. If that cannot be verified, it does not run.
- Allow network is per Canvas, off by default and journaled. Only the person sets it, at a local window or a device the host's own person paired (maintainer decision, 2026-11-12).
- While it is on, the page reaches the network only through the host's filtering proxy, on desktop and in a browser on the host's machine (maintainer decision, 2026-11-13). The proxy refuses loopback, private, link-local and overlay addresses and the host's listeners, pins the address, re-checks redirects and sends no credential. It allows `GET`, a JSON `POST` of at most 256 KiB, and images and fonts of the declared type; the host sets every header, and there is no WebSocket or media. The page's one-hour token is renewed only by the window that ran it, revoked when the switch goes off, and carried by no share or link.
- A remote browser cannot network-contain a running frame. That is accepted, and the Run control says so.
- Import HTML is a create, bounded to 256 KiB, and fetches nothing it references. A device the host's own person paired imports into the Project its request names, journaled as the device (maintainer decision, 2026-11-12).
- A share carries a design only with the sharer's acknowledgement. A public link is off by default and published only from the person's approval card, at a local window or a device the host's own person paired, never by an agent (maintainer decision, 2026-11-12).

Not built yet:

- Every other Canvas write, share and Settings change from a paired device: [Canvas public links](canvas-public-links.md) records them as still holding the window rule.

Status: Partly built. Detail: [Architecture: Canvas documents, designs, and prototypes](../architecture.md#canvas-documents-designs-and-prototypes) and [Canvas public links](canvas-public-links.md).

## Device transport

### Apple and Android scope

Apple development is simulator-only. Physical devices and store upload, submission and release are out of scope, and `octant_apple` offers no device or distribution operation.

- The host runs no device-control tool, signs nothing for a device and serves no device or distribution route. An agent that needs one uses its own provider tools under the ordinary sandbox and approvals.
- Journals with earlier device or distribution events replay unchanged. Leftover files and the stored store key stay in place, unread.
- Apple discovery is derived from the checkout. Octant never rewrites projects, schemes, build settings or manifests to make it pass. _Here only._
- A test run keeps its result bundle and logs as evidence and reports a structured verdict, or the raw artifact and an incomplete verdict if parsing fails. _Here only._
- A build's derived data is private to its action and removed when it ends, after a test's result bundle is kept; the host clears leftovers at start (maintainer request, 2026-11-10). _Here only._
- After a restart, ambiguous device work is waiting or inconclusive, never verified. _Here only._

Status: Built. Since: 2026-10-29. Detail: [Architecture: Device transport and evidence](../architecture.md#device-transport-and-evidence) and [Device workbench](device-workbench.md).

### Device destinations and ownership

A simulator, emulator, local-Mac or computer-use destination has a stable host-local identity and an exclusive owner or lease. The screen is streamed through the host, authorized like a screenshot, and never stored.

- No other thread may reset, erase, shut down or take over a destination another workflow owns. _Here only._
- Erase, content reset or runtime installation is never an implicit recovery step. Octant stops only a process it owns and never kills by broad name. _Here only._
- Device activity, evidence and cancellation are scoped to the requesting task, checkout and authority; an action id alone grants no access. _Here only._
- Replaying a completed input needs current authorization and an exact request fingerprint. Reusing an action id with changed input or while running is refused. Device artifacts keep task and checkout ownership on disk. _Here only._
- Closing a tab does not shut the destination down. A raw capture lands in a host-private directory only its own launch may read.

Status: Built. Detail: [Architecture: Device transport and evidence](../architecture.md#device-transport-and-evidence).

### Device input and agent device tools

Input rides the workbench control channel with actor attribution. Agent device tools follow the thread's level per operation, not one Full access gate on the whole tool.

- Reads (discover, status, screenshot, logs, Android describe-ui, opening an already booted destination) run at every level, Plan included. Every other operation is an effect: Plan refuses it, Full access sends it, other levels ask.
- An agent reads a device as text. Android describe-ui lists labelled elements with centres in tap pixels, and a tap may name an element matched exactly by resource-id, then content-desc, then text; zero or several matches are refused with the count. Logs return a bounded newest-first tail, crashes on request, kept as a log artifact with only a note in evidence.
- Allow input opens a destination for fifteen minutes for that window, thread and destination; only a delivered input renews it. The grant lives in host memory, ends with the window's authority, a shutdown or the destination no longer booted, and never covers boot, shutdown, Open URL or Rotate. _Here only._
- Open URL and Rotate are confirmed on their own. An input of unknown delivery is reported interrupted, and an off-screen point is refused, never clamped.
- An explicit screenshot may deliver one PNG through the provider image channel, under thread and checkout authority; anything else is refused, never resized. No other operation sends screen images. _Here only._
- `octant_terminal` follows the level: Plan refuses it, Full access runs it, and below that each command asks with the command shown.
- Checks on a real emulator and a real Mac are maintainer checks still owed.

Not built yet:

- iOS describe-ui and tap by element: they need the native device helper.

Status: Built. Detail: [Architecture: Device transport and evidence](../architecture.md#device-transport-and-evidence).

## Modes, Projects and authority

### Modes

Modes are server-enforced domain policy, not renderer flags. The shell shows Work and Code; Work presents the Chat and Work domains together.

- Chat and Work can be switched off in Settings; Code is always on. Turning a mode off deletes no data.
- A new-thread composer chooses Chat (no folder) or In a folder (a Work thread bound to a Project root). The choice only selects the create command; nothing converts a thread between Chat and Work.
- The mode switcher is the Work and Code icon pair at the top of the sidebar, each named by its tooltip and accessible name (maintainer request, 2026-11-09; [Workspace: Sidebar](workspace.md#sidebar)). The Status, Projects and Activity arrangements are the first group of the thread list's filter menu (maintainer request, 2026-11-16).
- The phone's tab bar has Work and Code; Work lists Chat and Work threads together, and each tab offers the three arrangements (maintainer request, 2026-11-14; [Mobile maturity](mobile-maturity.md#exists-today)).
- Chat binds a virtual, memory-scoped Project or none; Work binds one root; Code binds one directory and selects a checkout in it. Reaching outside the root asks below Full access, runs at Full access, and is refused in Plan (maintainer decision, 2026-11-14). Octant's sandbox holds commands to the root in Chat, Plan and Strict; otherwise the provider's own sandbox holds the level ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox)).
- Project memory belongs to one Project and keeps source, kind, timestamps and supersession; moving it across Projects or modes is explicit and keeps provenance. [Person memory](#person-memory-across-projects) crosses Projects. _Here only._
- Every turn in a Project carries its active Project memory, read and written through `octant_memory`; Plan refuses writes (maintainer request, 2026-11-12). At Full access, or below it with the Project setting "Agents may write Project memory without asking" (off by default), a write is accepted unconfirmed, marked agent-written with its thread, and shown. Otherwise it waits for the person's confirmation in the thread, never remembered. Only a local window or a person-paired device sets that switch, journaled with the device as actor (maintainer decision, 2026-11-12).
- Move to Project files a No-project Chat into a Chat Project, or a Work or Code thread into another active Project of its mode whose folder is or contains its own; a Code thread also needs the same repository folder. The thread keeps kind, history and level and gains no reach. Only a person moves, the server checks authority first, and the move is journaled. It is refused while a turn runs or the thread waits on the person.
- While a turn runs the dialog offers Move after this turn, a renderer-held intent for that thread and turn that dispatches once on settle, drops on dismissal, resolves the request it replaces, refuses rather than follow a newer turn, and is revalidated by the host; or Stop and move now, which interrupts only a turn the window started and refuses otherwise (maintainer request, 2026-11-19). The sidebar row menu and the Environment's Project row open the one dialog; the row acts whenever another active Code Project exists, so each refusal reason is readable.

Not built yet:

- The Project memory confirmation card on a paired device's turn: today that write is refused like a host-started turn's ([Architecture: Project memory](../architecture.md#project-memory)).

Status: Partly built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Projects pinned to the icon rail

A person can pin a Project to the icon rail as a tile that opens it.

- Pin and unpin are in the Project's sidebar menu ("Pin to rail", "Unpin from rail") and the tile's context menu, never in More, which holds only what the rail does not.
- Pins are a saved shell preference, synced like the sidebar destinations, by Project id in pin order. Settings saved before pins decode to none. A pin for a missing Project draws nothing and is dropped at the next save, only once the Project list is complete. Two quick pin actions both land.
- Tiles show in both rail placements, after the divider under the destinations. In the collapsed rail pins come first and the automatic list fills the rest of six tiles without repeats. At most six pins are drawn; Pin to rail is then disabled with its reason.
- Opening a pinned tile opens the Project as anywhere else; pinning grants nothing.

Status: Built. Since: 2026-11-11. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Project icons

A Project shows the icon a person chose, else the favicon or app icon in its own folder, else its letter tile or folder glyph, wherever Projects are listed.

- The host reads a short fixed list of relative paths, first valid file winning, with no walk, pattern or network; the renderer never reads disk. After the root paths it tries `apps/` or `packages/` with `web`, `app`, `site`, `www`, `docs`, `frontend` or `desktop`, each `public/favicon.svg`, `.png` or `.ico`; a root icon wins.
- A found file counts only when no path component below the Project folder is a symbolic link, even one inside it (opened anchored with no-follow on macOS and Linux; no found icon elsewhere), and it is a regular file of at most 256 KB whose first bytes match its extension. A Chat Project has no found icon.
- A person picks one from the Project page's actions menu ("Change icon…", "Use found icon", "Remove custom icon"): a PNG, SVG or ICO of at most 256 KB from the desktop's native picker. The host validates it like a found icon, keeps its own copy in `project-icons/` (one file per Project, written atomically) and never reads the path again. A browser has no picker, so the item is disabled with its reason. Only a window on this host that can reach the Project sets or removes it; a paired device only reads. A refused file shows the host's reason.
- Served order: chosen, folder's, nothing. The chosen icon is a host asset keyed by Project id, not a journal fact.
- It is served on the authenticated Project API with `nosniff`, a script-forbidding CSP and an ETag; a missing icon is a plain 404, not a logged error. `PUT` and `DELETE` set and drop the chosen icon, and responses say which icon is served.
- The renderer draws an `<img>` fetched once per Project per session, so polling causes no request. A change on the Project page refetches every mark, keeping the old picture until the new one arrives. Replacing the window host or credential, or unmounting the provider, cancels pending requests and releases object URLs, late answers included.

Status: Built. Since: 2026-11-11. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Code starting posture and Plan

Code starts at the level picked at first run (Auto pre-selected where the provider has a reviewer, else Ask first), changed in Settings › Code › Access or per Project. Plan is always read-only.

- A Project that remembered Full access before Project modes existed starts its threads in Full access.
- Creating a Code Project may initialize Git in the folder; if that fails, creation is refused and nothing is journaled.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Chat has no filesystem or shell authority

Chat has no file or shell authority by rule. A Chat session runs on its per-thread scratch directory, and every provider approval request is declined.

- Runtimes launch with exec and fork denied, or with no execution environment; a write-only sandbox is not enough, because reads never escalate.
- Octant-managed tools (research, Canvas) run on the host and are unaffected.
- Chat loads the person's tool servers, skills and subagents when the provider [runs as itself](#key-providers-run-as-themselves), with no folder and no shell (maintainer decision, 2026-11-14).
- A provider's own memory in Chat follows [Plan and Chat tool parity](#plan-and-chat-tool-parity). Octant's person memory is the cross-Project layer.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Person memory across Projects

Octant keeps a memory of the person beside Project memory: it learns preferences, ways of working and past work from threads, and every new thread on every provider starts with it. It is on by default with no per-entry prompt; the person can turn it off.

- It learns from a thread the person settled after memory began (after a reopen, only from newer messages), and from an open thread with no running turn that has been still 30 minutes since its last activity, has new person text since memory began, and was last learned from over 6 hours ago. It reads only the title and the person's messages, never answers, tool output or files. Secrets are redacted before the call and before storage; an entry naming a protected path is dropped.
- A pass makes at most 10 model calls, counted only when made, settled threads first, cheap facts checked before a thread is read; a failed call retries on a later pass on the same account, and a later digest replaces the earlier (maintainer decision, 2026-11-25). Each call is tool-less, on the thread's provider and smallest model unless Settings › Providers & Models › Automatic model calls picks another account, and passes the Project's provider rule and spend ceilings like a Shield review. An account that is off, not ready or at its limit makes the thread wait, never another account. Each call is a `person-memory` usage row naming the account, behind the seam `personMemoryDistillationAllowed`.
- The block follows Octant's instructions, is capped at 2,000 characters, is framed as data, and holds entries older than the thread's cut-off. The cut-off is the thread's creation, moved by a finished compaction, the harness compacting, or a turn that starts a non-resuming provider session, at one journaled instant shared with later turns, so text stays stable for prompt caching.
- `octant_past_threads` searches remembered digests and entries only, returns at most five excerpts with sources, reads no transcript or file and grants nothing.
- "Remember that I prefer X" is kept at once through `octant_remember_person` (maintainer decision, 2026-11-16): a redacted quotation of at most 400 characters from a message the person typed in the tool's own turn, matched ignoring whitespace and case, through the sweep's caps and merge. A message counts only when the host holds its `person-memory.turn-typed@1` mark, recorded only from the person's own routes (maintainer decision, 2026-11-25). Outside content can never create an entry this way.
- It is offered to a turn a local window or paired device started, in Chat (with or without a Project), Work and Code, under the block's participation rules; never to a routine, another host-started turn or a subagent. The entry names the open thread, is journaled as `person-memory.entry-saved@1`, leaves the thread unremembered for the sweep, is erased by delete, Forget everything, Leave no trace and purge, and is not in its own thread's block.
- Settings › Memory: a master switch, past-thread search, Projects kept out (not learned from, not shown, no block or tool), threads that leave no trace (set from the thread menu), editable and deletable entries with sources, and Forget everything. Deleting erases the events from the journal; a thread purge removes what came only from it.
- Readers, under the thread's participation rules (memory on, Project not kept out, thread not Leave no trace): a local window, a device paired at Full by the host's own person, a routine's run, another host-started turn (resume, delivered child result, goal round) and a subagent. A subagent inherits its originating turn's scope restriction, gets its lead's block once on start (not on continuation) and `octant_past_threads` scoped to its lead when its authority and provider allow tools, so it never sees more than its lead.
- Not readers: a hub-roster device or one paired below Full, a peer-delegated Work turn, any subagent either spawns, and a turn with no scope (such as a benchmark runner's Chat turn). Only turns with the person's own typed message write ([what counts as the person's words](../architecture.md#what-counts-as-the-persons-words)).
- Memory is never synced to a hub, spoke or peer. First run explains it and where to change it without assuming it is on; the optional Your first task card reports the host setting. Export my data carries a `person-memory` page with every entry and its source threads.

Not built yet:

- Background calls on subscription sign-ins: whether they fit each provider's terms is still being checked.

Status: Partly built. Since: 2026-11-01. Detail: [Architecture: Person memory](../architecture.md#person-memory).

### Default Projects

A Work or Code thread started without a chosen Project lands in the mode's default Project, provisioned under the default folder on first use.

- The default folder is `~/Octant` unless changed, always inside home, stored by real path. Its wire value keeps native POSIX or Windows drive-absolute spelling; drive-relative, UNC/device and NUL values are refused. Host-native canonical and inside-home checks stay required whatever the decoding.
- Work always offers its default Project; Code only when "Code needs a Git repository" is off, and then a Code thread may start in a plain folder where every Git feature reports itself unavailable.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### SSH and remote machines

An agent reaches a remote machine with `ssh` through the thread's shell, in Work and Code. Octant stores no SSH key, writes no SSH config and adds no SSH transport.

- At Ask first, a thread's first connection to each host asks, naming the host, even where a remembered approval would cover the command.
- Shell egress follows [Network limits](../architecture.md#provider-runtime-network), which ship off; with them on, Ask first and Auto follow the Project's egress rules and Full access is open.
- The earlier SSH target binding is removed; old journals replay, and its `remote-root` threads refuse every operation.
- A Code or Work Project may bind a folder on a registered server, in its own catalog (a Work record carries `mode: "work"`). The connection uses this host's `ssh` and the person's agent, forwards nothing, refuses an unknown host key, shares one connection per server through a private control socket, and fails closed with no local fallback. A server with bound Projects cannot change its alias or user.
- No login shell parses a call: script and arguments travel encoded for `sh`, so any login shell (`fish`, the `csh` family) reads them unchanged.
- A server Code Project runs Octant Harness files, commands and Git on the server at every level, never under a remembered approval; thread and Project terminals are server logins; the Git tab and Review run Git there (Plan changes nothing); Files, editor and Tests read, save and run there (saves checked by digest, no watch); a thread's worktree is made there and its pull request named by repository and branch (Plan makes none).
- A server Work Project's threads run on the Octant Harness with server file tools and commands and no tool of this host, with the Work sidebar, composer, thread view and a read-only Files listing of names and sizes with Refresh; no previews, editing, watching or output attribution ([Server Projects](server-projects.md)).
- On a server Octant's file tools, Files and search refuse the secret guard's one list at every level, the person's changes included; a shell command reads what the login can, gated by the level. At Auto the server's action profile caps a Project's calls and this host's safe places and protected paths judge nothing. Shield treats a server thread as having read outside content; the Watcher marks one it finds steering text in.
- A runtime reporting server placement (Codex, Claude Code) runs a server Code Project's turns on the server with no Octant there, on the server login's sign-in and the provider's sandbox at the thread's level. Strict refuses it, Octant claims no sandbox, and the composer says so once per server and provider (maintainer decisions, 2026-11-19 and 2026-11-20).
- Placed Claude Code reads none of this host's Claude account, instruction files or task list, resumes after finding its transcript on the server (else the text handoff), runs Plan with no shell, and its gate judges server paths by name.
- At Ask first and Accept edits, placed Codex's sandbox denies the other providers' sign-ins resolved for the login's home (the Provider sign-ins group); a Codex too old for a permissions profile is refused there, and Plan refuses Codex on a server.
- Before a turn the provider's status command runs there (`codex login status`, `claude auth status --json`); not signed in refuses the turn, naming the server; a signed-in answer is held five minutes per server and provider.
- Every placed program is recorded under the login's `~/.octant/server-runtimes/` with PID and start identity, tagged by this host. After a dropped connection and at the next call to that login, a sweep stops a recorded program this host no longer holds, only while its PID keeps the recorded start identity.
- A local person can open an owned loopback preview of a server Project's dev server over dedicated SSH stdio streams for HTTP and WebSockets, apart from the command connection. Stop, loss, revocation and same-endpoint reconnect are visible; stop, reopen and shutdown await resource receipts and pending starts, with a bounded failure if cleanup is unconfirmed.
- The panel lists the login's own listening processes in the Project folder (via `lsof` or `ss`: port, bound address, short name, no command line), offers Preview only for a socket answering on `127.0.0.1`, says when neither tool exists, and is read only by a window on this computer. It says the raw TCP forward is reachable by a Full access thread or an unproxied provider, not by guarded commands without a `localServices` grant (maintainer decision, 2026-11-20; [Server Projects](server-projects.md#person-operated-dev-server-previews)).
- Tests ran only against a throwaway local `sshd`, stand-in `ssh`, `codex` and `claude` (Claude through the real Agent SDK), and a stand-in `gh`, never a real server or GitHub.

Not built yet:

- Running Claude Code or Codex itself on the server as the real CLI signed in there, over a long-lived pipe on the Project's connection, with its own sandbox and plan mode, Strict refusing it, and OpenCode, Pi and ACP agents still refused (maintainer decision, 2026-11-19): designed, not built ([Server Projects: Providers running on the server](server-projects.md#providers-running-on-the-server)).
- Stopping a child a recorded server program leaves behind: the sweep stops only the recorded program.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Repositories, checkouts and file services

A repository is identified by an opaque digest of its canonical Git common directory, not a path. File, terminal, test and Git operations are server-owned services; panes are clients.

- Managed worktrees live under a sibling root that needs its own confirmed grant, get an ownership receipt before use, and are never silently reset or reused. _Here only._
- Operations use checkout-relative targets, symlink and identity checks, atomic writes, bounded output and structured verdicts. _Here only._
- Reading a worktree's changes runs nothing the repository configured: fsmonitor off, no optional locks, submodules by commit, and a repository whose config sets a filter command is not read. _Here only._
- Rebinding a Code Project leaves old threads unavailable until a person rebinds them; a session Full access grant does not survive, and a thread with its own worktree is refused.
- Repository tests stay cancellable during command discovery.
- A new Code thread's start screen shows a quiet chip beside the Project chip naming the branch or "New worktree · from main" (maintainer decision, 2026-11-17). Its menu "Where this thread works" has 28px rows: This checkout (path as tooltip) or New worktree; Branch (a fact) or Start from › (base branches); Subfolder › (a pop-out field that keeps its text); Remember for this Project; and Worktree options… (fetch source and the branch name the host will create). Choosing creates nothing until the thread is created. A running thread's checkout card names its worktree, branch and location.
- Starting in an existing worktree is not offered; the host's new-thread workspace has no such value (maintainer decision, 2026-11-14).
- Every popup is one fixed frame: it opens at its final size, never resizes or moves for data or choices (fixed size, scrolling lists, skeleton and reserved rows), and reads its content before opening (maintainer decision, 2026-11-14).
- A new worktree's branch is a configurable prefix (`octant/`) plus a short id or words from the person's prompt, derived locally (maintainer decision, 2026-11-25). Words drop everything after a word announcing a secret, URLs, paths, emails, hosts, `name=value` settings, odd letter-digit words and Windows reserved names, falling back to the id. The name is numbered against local branches, remote branches without the remote prefix, and tags (a bounded names-only read); the host refuses a taken name rather than choose another, and the name shown is the name sent. A model words it only on Suggest name, using the composer's model under the Project's provider rules and spend ceilings with only the reduced draft (at most 2,000 characters); a refused, failed or stale answer keeps the local name. What a suggestion uses is recorded under the Code Project.
- An idle Code thread switches its checkout to another existing local branch from its Environment (maintainer request, 2026-11-19): a person's `switch-git-branch` under the overwrite rules, exact local refs only, no branch another worktree holds, no run while a turn runs or starts, admission re-checked inside the Git queue before mutating. The dialog observes status entries and state token once, shows them before any dirty choice, and sends that token with refuse and stash; a stale answer re-reads and asks again. Gated levels approve the exact command; a decline sends nothing; Plan keeps the row off. A dirty checkout offers Commit (the Git pane's reviewed form), Stash (`git stash push --include-untracked`, never a pop; a failed switch says the changes stayed stashed) or Cancel; nothing commits or stashes by itself. A detached HEAD may switch onto a branch. The head is journaled on the checkout's own identity, never via the Project root. The switch grants no branch deletion on archive, and no agent path exists. _Here only._
- Archiving a Code thread removes its managed worktree only when clean, pushed or merged, and no turn is in progress; the branch stays, and the cleanup can be turned off in Settings › Code › Worktrees, which lists what was kept with sizes. Remove asks once, refuses uncommitted changes or a live turn, and keeps the branch. _Here only._
- That page on this computer also finds other tools' worktrees by a bounded home-folder walk plus the Code Projects' repositories, then `git worktree list` per repository, on macOS, Linux and Windows (Spotlight does not index `.git` files). Remove refuses the main checkout and locked, Octant-owned, relinked, dirty and filter-setting worktrees; confirms commits only its branch has and use in the last 15 minutes; refuses a detached HEAD's own commits; keeps the branch; and for a gone folder removes only its record, refusing a detached one whose commits only that record keeps. Bulk removal asks once. Settings › Code › Xcode builds lists DerivedData folders whose workspace is gone or 30 days unused. Nothing is journaled. A local window or a person-paired device does this, never a hub-introduced device (maintainer decision, 2026-11-12). _Here only._
- A managed worktree folder is removed restorably only on the person's opt-in (inactivity days, or merged, which needs a commit of the branch's own), and only when it is Octant's receipt, clean, idle, unlocked, verified against repository, branch and commit, and has no untracked, ignored or empty-folder content, skip-worktree file, sparse checkout, submodule or operation under way, while nothing tracked for the thread works (turn, child run, debug session, Project shell, the thread's terminal, queued message, wake-up) (maintainer decision, 2026-11-25). A default install removes nothing new.
- Branch, thread and checkpoint refs stay, and the receipt records branch and commit. The thread says it was cleaned up, holds sending, and offers Restore worktree to a window or person-paired device (others see the sentence). Restore refuses a moved branch, naming the recorded one, runs no hook, and counts as activity.
- However a cleanup or restore is cut short, the person gets a working thread or a Restore that finishes it, and nothing off the recorded branch is deleted: a killed removal finishes only on fresh proof or is handed back whole; a killed `git worktree add` is discarded only if the folder holds only the recorded commit's files; a folder a restore did not make on another branch or commit is kept. Git calls under a receipt's lock are bounded, the lock frees only after the child's process group is gone, and a receipt changes one step at a time.

Not built yet:

- Unnamed: the entry is Partly built but names no unbuilt part (open question for the maintainer).

Status: Partly built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Forks, checkpoints and restore

A fork is a managed-worktree creation the host resolves from a finished turn. A checkpoint is a marked point that copies no thread state; restoring one forks. Threads rewind and fork rather than edit a sent message, and can move back in place (maintainer decision, 2026-11-01).

- A fork starts approval-gated with no inherited profile, running turn or session grant, and is refused when its text handoff cannot be built.
- Every message offers Fork from here (a person's message forks through the reply before it) and Rewind to here, choosing conversation, files or both, asked once with a preview. A Work fork is a new Work thread carrying the messages as text; a Chat fork is the Chat branch.
- Chat has no edit control or command. Its rewind covers the conversation only, grants nothing, returns the removed message to the composer, and is journaled as `chat.thread-rewound@1`; journals with earlier edits still replay and display.
- A rewind journals what it removed; reads, handoffs, context plans and replay leave those turns out. Files return only from Octant's checkpoints, as an undoable restore that runs first. Server-Project Code, Plan and Work threads rewind the conversation only and say why.
- The phone offers both on every message of a thread it can open, through the same routes, and the files part of a Code rewind only at Full access, with the same preview; otherwise it rewinds the conversation and says approvals are taken only at a window on the computer.
- A rewind is refused while the thread's turn runs, and its files part while another thread has a live writing turn on the checkout root.
- Removed turns stop reaching the model. A provider reporting `sessionRollback` (Octant Harness; Claude Code, Codex from 0.143.0, OpenCode and Pi in Code) cuts its own session back at the last kept turn; others start a fresh session with a disclosed text handoff. Chat uses the handoff or the host's rebuild for every provider.
- Fork and rewind use the provider's own session copy where its runtime offers one (maintainer principle, 2026-11-14): completion journals the turn's session point (`nativeAnchor`, additive), and `forkSession` copies there before the prompt. Claude Code copies through the turn's last assistant message, only into the source's own folder. Codex uses `thread/fork` with `lastTurnId` from 0.143.0 on a short-lived process that closes before the copy is resumed, since another app-server refuses a thread still loaded (maintainer decision, 2026-11-19); its preview promises a copy only for the same folder and mode with a journaled anchor ([Provider runtimes: Codex](provider-runtimes.md#codex)). Anything else uses the text handoff.
- A checkpoint is journaled on its own aggregate (marked, forgotten, restored). Chat branches through the marked turn; Code creates a thread on its own worktree at the recorded revision with a fresh delivery branch; the origin is untouched. A Code checkpoint is refused when the host caught no revision. Forgetting retires the marker and leaves it readable. _Here only._
- An in-place Git restore keeps its own name, is never shown as the same gesture, and is refused while another thread writes on the checkout root. Discard takes the same check and checkout-root serialization right before mutating, after approval, refuses during its own starting or live turn, and keeps its state-token and tracked-path checks. A route added for the Git service's commit revert, which none reaches today, must take the same check.

Not built yet:

- Unnamed: the entry is Partly built but names no unbuilt part (open question for the maintainer).

Status: Partly built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Outside content marks follow the content

A thread that reads outside content is marked, and the mark follows the content into any thread, Canvas or message that carries it.

- Forks, Chat branches, follow-ups, side tasks, planner-confirmed threads, `#thread` mentions, Side Chats, delivered agent messages and Canvas reads and writes mark the new or reading thread.
- The mark and the thread commit in one journal unit; a mark that cannot be recorded refuses the creation or withholds the text.
- A source the person cleared passes nothing on. A Work-to-Code promotion starts unmarked, since no agent text crosses.
- A marked thread shows "Outside content · read N times" in its Environment panel and, below Full access, a warning globe before the mode control; both open one review dialog, not a chip popover (maintainer choice, 2026-11-14; [Thread view](thread-view.md#outside-content-on-tool-rows)).

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Work promotion and the status file

Work never silently becomes Code: a promotion proposal is an offer, and only the person's approval creates the linked Code thread.

- A promotion moves focus and tooling, not authority; the new thread takes its own Project's level.
- A thread never moves from Code to Work; a person forks or starts a new one (maintainer decision, 2026-11-01).
- A Work Project may opt into a `STATUS.md` in its folder, off by default and refused for the default-folder Project. A turn updates it only when where the work stands changes; a stale status makes a task take stock on its first turn unless the request is a greeting or unrelated.
- Octant never writes an agent brief into a user folder. A Claude Work turn reads the global and Project `CLAUDE.md` as text with no authority ([Provider runtime telemetry guards](#provider-runtime-telemetry-guards)); a Codex Work thread reads the Project's `AGENTS.md` as Code does (maintainer decisions, 2026-11-14).

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Records of what a turn changed

A turn records an observation of what changed while it ran, never an attribution.

- A Work turn watches its folder from before the provider starts until it settles and records relative paths only, reading no file; an unnameable or refused path marks the record truncated, and a host that cannot watch records nothing. _Here only._
- A Code turn compares the checkout tree-to-tree at start and settle and journals at most 32 paths with lines added and removed and a binary flag; a rename is both paths. With no starting capture (Plan, unreadable checkout) or no change it records nothing. Recording never fails or delays a turn. _Here only._
- From a Code turn's change view the person may leave notes on changed lines, keep them pending, and send them as one follow-up message (maintainer decision, 2026-11-14; [Workspace](workspace.md#tool-lifecycles)).

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Thread plans

A thread's plan is its own journaled aggregate of ordered steps, at most one live per thread, proposed and approved whole.

- Approval names the exact revision read; rewriting steps mints a new revision and returns the plan to proposed. _Here only._
- Changing the level, leaving Plan included, never approves a plan. _Here only._
- Steps become work only after approval; before then the host refuses to start, finish or drop one, and a proposal claims no progress. _Here only._

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Project scaffolds

A project scaffold is a curated catalog entry with a pinned generator, run as an ordinary approval-gated Code operation.

- A moving version fails to decode. The host composes the command line from the catalog record and one directory name; an entry adds no flag, path or shell fragment. _Here only._
- The directory is one segment with no separators, traversal, leading dot or leading "-"; an existing name refuses the run. _Here only._
- Plan refuses a scaffold. It runs confined with network allowed and caches in a private directory, installs no dependencies, and is never reported created unless it exits cleanly. _Here only._

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Projects with several folders

A Work or Code Project has one main folder plus extra folders the person adds, each with the same access at the task's level. A new task picks a server-issued working-folder identity and relative subdirectory at creation. Code Git and checkouts keep their own root.

- Only a person adds or removes an extra folder, through a folder-picker receipt, journaled with who and when; a Project from before the field has none. At most 16.
- An extra folder may be home only after the person confirms its warning (credential folders stay protected, [Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)); never a folder above home, a system or credential folder, the main folder, or inside or around the main or another extra folder (confirmed home may hold them).
- OS profiles, provider sandboxes and approval scopes, Harness file tools and Shield's fast read and edit rules grant an extra folder what they grant the main one; Plan reads without writing; Full access stays unwrapped. Each turn names the extra folders to the agent.
- Worktrees, checkouts and Git stay in the main folder; an extra folder is plain. A relative path is the main folder's; an extra-folder file is named by absolute path, honoured only inside a current extra folder.
- Project terminals and saved actions start in the main folder or any listed folder the person picks, and the host refuses other paths; a Project or Code thread terminal binds every listed folder, and its start command may name one. A folder change names the destination and warns the process ends before an explicit restart; Cancel keeps the shell, and New terminal stays an alternative.
- Language services, debug sessions and tests treat an extra folder as plain: the host places an absolute path in a current extra folder or refuses it, and the server, session or run binds that folder.
- Work Files and a turn's changed-file record cover every folder; the Work overview lists each extra folder's top level by last component, with no host path.
- Dropped local desktop folders become editable absolute references in all four Work and Code composers after metadata-only host validation against current roots; they grant nothing, read nothing and change no working directory. Remote client paths and future managed checkouts are refused.
- The `@file` picker reads extra-folder files by absolute path inside current extra folders; Code search covers them, marking each match's folder; the harness shell and ACP file and terminal tools reach every folder. The editor and Files explorer open, read and save them under the same root authority, each folder its own tree, matches opening.
- The explorer watches the checkout and all extra roots over one authenticated stream shared by duplicate views, with shared physical watchers; notices name the root, reconnect or truncation reconciles every visible tree, a removed or relinked folder ends the stream, and only exact current roots are watched. Extra-root language services reconcile open documents after a dropped watch.
- A task's folder identity binds the current Project binding and folder-add revision and cannot change in place; provider, terminal defaults, saved actions and new Work artifacts use it. Revocation or loss cancels running work and refuses new effects without redirecting output; existing threads keep their earlier reading.
- Work artifacts keep that identity and relative destination through revise, rename, conversion, export, preview and replay, and refuse after a root is removed and re-added; unscoped and legacy artifacts stay in the main folder. Code Git, pull requests, changed files and Review stay checkout-only and say so.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Projects with several folders](../architecture.md#projects-with-several-folders).

### Plan and Chat tool parity

Plan writes nothing and Chat has no folder; inside them a provider keeps what it offers on its own: the person's read-only MCP servers, its memory read-only, processes on Linux, and attachments of any kind (maintainer decision, 2026-11-16).

- A person may mark one of a provider's own MCP servers "Read-only — allowed in Plan", per server and host, from Settings › MCP servers at a window on this computer or a device they paired (others refused), journaled with who. In Plan only marked servers start, under the thread's ask rules, for Claude Code, Codex and OpenCode; where Plan's sandbox starts no program (OpenCode on macOS) a local server cannot start, and Settings says so.
- A server's `readOnlyHint` is never trusted and may only pre-suggest the mark. Octant never connects to a provider's own servers, so it reads none of their listings. Servers Octant connects to (MCP extensions, connectors) carry no mark; in Plan each call goes to the person ([MCP tool approvals](#mcp-tool-approvals)).
- Outside Strict a provider's memory loads in Plan and Chat on the account's setting (maintainer decision, 2026-11-21). Under Strict only a memory the session's tools write loads there, read-only: Claude Code yes, Codex (which writes `~/.codex/memories` itself after a turn, outside any gate) off. The rule is `providerOwnMemoryLaunches`; providers with no Octant memory switch are unchanged.
- Claude Code's memory there is the account's `CLAUDE.md` (Chat's only instruction file) and auto-memory. Plan has no write tool and binds the account folder read-only; in Chat and Plan Octant's gate refuses writes into that `CLAUDE.md` or a `projects/<folder>/memory/` folder, links resolved, which Claude Code's own check would allow.
- A Linux Chat or Plan launch that must start processes runs in the same Bubblewrap capsule with the process-denying seccomp filter off: bound folders read-only, only a private temp and the runtime's state folders writable, the launch's network rule, all capabilities dropped, no new privileges; every other rule stays, an unbuildable capsule is refused, and a launch needing no process keeps the filter. OpenCode 2 runs Chat and Plan this way with shell and delegation denied and the `git` stand-in first on `PATH`.
- Claude Code's Bash in Plan on Linux runs each command in a Bubblewrap capsule nested in the runtime's: system and Project folders read-only, no network, home, account folder or sign-in file, secrets cleared, only the private temp writable, no new privileges. A host that cannot nest offers Plan no shell; a failed capsule fails the command.
- Any file can be attached in every mode. Staged attachments show file-type glyphs, thumbnails where available ([Thread view](thread-view.md#composer-behavior)).
- In Work and Code an attachment goes to an Octant-owned per-thread folder under the host's data directory, never the Project, journaled like an image under the same limits; the folder exists before launch and is readable, read-only, at every level including Plan. It is sent natively where the provider takes it, else by path, from web composers and a paired phone, for Claude Code, Codex, OpenCode, Pi and ACP agents (an ACP agent with embedded context gets a `resource` block).
- A server-Project thread copies a by-path file over SSH, digest-checked, into its read-only attachments folder on the server; a failed copy refuses the turn. Deleting, purging or Leave no trace removes `~/.octant/thread-attachments/<thread>/` there with safe-path guards; when unreachable, local deletion succeeds and journals `server-attachment-cleanup.pending@1`, settled (`server-attachment-cleanup.settled@1`) on the next connection, and removing the whole Project succeeds with a notice naming the folder left (maintainer decision, 2026-11-19).
- Chat sends natively what the model takes, puts text files and the text of Word, PowerPoint, Excel and PDF files in the message (bounded per turn), and refuses anything else before the turn, naming Work or Code (maintainer request, 2026-11-18). When Octant rebuilds Chat history it carries earlier finalized text and document attachments from the confined, digest-verified store within the 400,000-character limit, newest first, cut cleanly, degrading cleanly on missing, purged, binary or unreadable files, and honoring `text-only` boundaries.

Not built yet:

- The `readOnlyHint` pre-suggestion: it has nowhere to appear, since Octant reads no provider server's annotations and its own servers carry no mark. It becomes buildable only with a read-only mark for servers Octant connects to, or a provider reporting annotations to Octant.

Status: Partly built. Since: 2026-11-16. Detail: [Architecture: Security and authority, Plan and Chat tool parity](../architecture.md#security-and-authority) and [Provider runtimes: Key providers](provider-runtimes.md#key-providers).

## Agents and delegation

### Child agent runs

A child run starts only when the thread's agent delegates through `octant_agents`, the one child-run tool offered to every runtime, an Octant Harness lead included. Every child uses the same host admission, routing, workspace and lifecycle services.

- Operations: `capabilities`, `delegate`, `status`, `wait`, `cancel`, `follow-up`. No second child-run tool is offered; Side Chats and server Project threads get none. The harness's retired `delegate` name stays readable so old journals replay.
- Subagent creation is one setting, Off or Automatic. Only the thread's agent starts a child, and the parent-child hierarchy is the only subagent surface. _Here only._
- Delegation is refused while subagents are off or the harness session is paused. A marked thread's mark follows into the child. Outside Strict reading outside content adds no ask ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)); at Full access a marked thread keeps delegating and keeps waiting helpers; Plan refuses.
- Under Strict below Full access a marked thread asks once per thread (maintainer decision, 2026-11-13): Code in its tool approval at the turn's level, Chat and Work through the host's single-use card (maintainer request, 2026-11-15). At Auto the person answers, not the reviewer; a Work routine run, which nobody can answer, refuses. The yes is the journaled `delegation` standing answer (`thread.standing-answer-recorded@1`), surviving restart, erased with the thread, letting later helpers start unasked.
- Under Strict a reply `wait` hands back marks the parent only when the child was marked, an unreadable mark counting as marked (maintainer request, 2026-11-22); outside Strict it always marks. A delivered or steered reply always marks.
- `capabilities` advertises only targets whose model carries Octant's tools, as admission requires, and names each other enabled provider with its first exclusion (`not-ready`, `tools-unsupported`, `project-policy`). `wait` takes `runIds` and answers on the first or on all; `delegate` may give siblings one journaled `compareGroup`, shown side by side unranked in the Agents dock (maintainer request, 2026-11-15).
- The host prepares the workspace: research-only for Chat, the Project root for Work, an isolated managed worktree for Code. No client supplies a path; wider-than-parent grants are refused.
- A helper starts and resumes with its parent's Strict value, and its grant and answers follow [Subagent authority](#subagent-authority) (maintainer decision, 2026-11-25).
- Children default to the committed revision. The person may select a reviewed, stable current-edits checkpoint for a parent's children; each child records its base and keeps staging separately; incomplete or stale snapshots refuse before admission, and copies are never silently reapplied. A provider's native subagents are not these children: they [run as the provider does](#key-providers-run-as-themselves), each shown as a child run.
- Opt-in parent context keeps up to eight original user inputs (32 MiB) in a purgeable immutable manifest; unsupported, missing, changed or revoked inputs refuse delivery; text-only context records omissions, with bounded counts for unlisted originals and an honest unavailable-metadata marker. The child can inspect its input manifest apart from its brief and report.
- Concurrency is a setting (4 per thread, 8 per host, at most 16), bounded by the [host resource policy](../architecture.md#local-work-resource-limits). A turn defaults to 120 working minutes (1 to 240, set before the next attempt); a Full access thread's children have no limit by default, which the Helper agents setting turns back on, and under Strict the limit stays unless lifted (maintainer decision, 2026-11-25). A helper's turn has no event budget of its own.
- Retry and Resume start fresh; approval and answer waits pause the clock; two-minute acquisition and startup bounds remain; attempt and cumulative time come from result evidence, gaps labelled.
- Cancelling a child tree goes leaves-up and completes only once each process is confirmed stopped; an ambiguous outcome becomes waiting, failed or interrupted, never completed. _Here only._

Not built yet:

- Unnamed: the entry is Partly built but names no unbuilt part (open question for the maintainer).

Status: Partly built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Choosing a subagent's route in a prompt

A person can name a subagent's exact route in the prompt: the `@model` row of the `@` menu picks a configured provider instance's model that runs Octant's tools, then a reasoning value it advertises, shown as an inline chip (maintainer decision, 2026-11-23).

- The prompt holds it as plain text, `@model(<provider instance id>/<model id>, reasoning=<value>)`, so copy keeps it and paste restores the chip; no reasoning means the provider's default.
- The parent keeps its own model; the tag only qualifies the subagent asked for.
- The launch resolves the exact instance and model and accepts only an advertised reasoning value. An explicit route never falls back; the parent agent is told to report an unavailable route, not pick another.
- An unavailable chip says which choice needs attention before sending; sending is not blocked.
- Every composer's prompt is an editable element keeping a text field's value, caret, paste, copy, undo and label behavior.
- A live check is owed: a maintainer runs one tagged subagent on a real provider and confirms the child's row names its provider, model and reasoning.

Status: Built. Since: 2026-11-23. Detail: [Thread view: Choosing a subagent model in a prompt](thread-view.md#choosing-a-subagent-model-in-a-prompt).

### Child approvals and results

A child approval permits only that request, and a child result implies no delivery, review, merge or deployment.

- A child approval never creates or consumes a remembered lead-session grant and cannot approve an opaque provider action in Plan. The parent composer answers authoritative child request IDs inline without replacing its own request; stale or disconnected views cannot answer. A paired device answers only managed requests of its own execution scope, once or deny, with live authority checked; reads and restart claim no ownership.
- Child results, routine runs and usage-limit resumes run as the host under a per-process scope, never through a window.
- A finished child's result is steered into the parent's running turn when the runtime steers and it fits the note limit, after marking the parent; otherwise it waits for a delivery turn. A Code turn under the provider's own reviewer is never steered. A steered result is journaled (`agent.result-steered@1`) and shows the child-result card labelled "Delivered into the running turn" (maintainer request, 2026-11-15).
- Reviewing a run measures its branch against its confirmed delivery base, remote-tracking ref first; mergeability is asked of Git and an unknown answer refused; comparing attempts ranks nothing. _Here only._
- Merging a run into the checkout is explicit, approval-gated and journaled, uses `--no-ff`, aborts an incomplete merge, and is refused when branch, base or reviewed head changed, the checkout is unreadable, dirty or on another branch, or Git reports conflicts. _Here only._

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Messaging and sibling threads

Agent-to-agent messaging is a host-delivered channel, and seeing sibling threads is its read-only companion, both in one tool, `octant_threads` (maintainer decision, 2026-11-05). Work and Code turns see their own Project's other open threads and may message them.

- A thread is named `<thread id>@<project id>`; another Project's reference refuses like an unknown one. A `send` to more than four recipients, or with a malformed or foreign reference, is refused whole. A refusal reveals nothing about another thread; sending grants nothing and returns no reply.
- `send`, `acknowledge` and `receipts` run Code to Code or Work to Work, never across modes (maintainer request, 2026-11-12). `list`, `read` and `wait` see only the caller's mode, change nothing outside the caller's record, are offered in Plan, and a `list` or `read` marks the caller.
- Under Strict a turn may make 8 reads, 4 waits and 3 `octant_ask_thread` calls by default, settings in Settings › Limits; outside Strict none is capped (maintainer decision, 2026-11-19). A target turn started by `octant_ask_thread` is never offered it. _Here only._
- Bodies never enter the journal. Delivery is at least once, marks the recipient, frames the message as data, and is journaled once the provider has it.
- A message wakes an idle recipient only when a person at a local window turned on its Wake when a message arrives switch (off by default), or as [Coordinator threads](#coordinator-threads) say: one `agent`-initiated turn at a time through ordinary admission at the thread's level, at most 30 an hour and none past 10 rounds (maintainer requests, 2026-11-07 and 2026-11-13). A coordinator's threads take its own bounds; others take Settings › Limits ([Octant's own limits become settings](#octants-own-limits-become-settings)).
- A new queued message has no deadline: it waits until carried, refused or purged, bounded by the body store's disk budget (maintainer decision, 2026-11-21). A deadline an earlier host recorded still expires its message, journaled before body cleanup as a receipt, never as delivery.
- The current recipient can report receipt of its exact message; the host rechecks both threads, mode and Project. Sender `receipts` read only their own metadata, and Agents shows bounded recent receipts. Acknowledgement means reported receipt only; delivery and completion never acknowledge.
- Plan leaves messaging out of the enum; excluded profiles and cancelled turns refuse every messaging call; receipt retries are idempotent per durable ID; a retried send is a new message; no receipt infers Expired from age.
- A non-empty profile allowlist names groups `octant_threads` (reads), `octant_threads.send` and `octant_threads.board` (the planner's board), so merging the former tools widens no allowlist.
- Work-to-Work messaging and wakes have not run against a real provider.

Not built yet:

- Messaging and wakes across a hub: built on one host only.
- A tagged Code thread messaging one on another hub member under that member's Message peer-grant item, each end keeping its rules and the receiver the final say (maintainer request, 2026-11-07): designed, not built ([Hub and spokes: messaging between members](hub-and-spokes.md#messaging-between-members)).

Status: Partly built. Since: 2026-10-12. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Mentions and Side Chat

A `#thread` mention is a bounded, read-only view of a thread the sender can already open. Side Chat is a Chat-mode sidecar about exactly one source thread.

- A mention is one inline chip whose card is the sidebar row's, with what the turn reads and Open thread, Side Chat and Remove; there is no chip row, and the text stays `#[Title]` (maintainer decision, 2026-11-25). The card reads only threads the window lists; a refused thread shows only its reason.
- A turn in every mode stores only the mentioned threads' ids, so chips survive reload, replay and a fork copy (maintainer decision, 2026-11-25). An id the window does not list stays the typed text.
- `@file` completes only paths inside the bound root; the host refuses an outside path before reading. An `@` or `/` chip never installs, trusts, enables or elevates anything, and the host re-resolves it at send.
- A Side Chat has no inherited Work or Code authority and no agent path that messages, approves, steers or appends to its source. A person may return one finished reply to the source's unsent draft, keeping its text, caret and busy work; it never sends, queues, steers or approves.
- Typed reply, digest and source references persist with the draft; send, queue delivery, retry and resume revalidate them and inherit outside-content provenance before provider reads. Missing or corrupt provenance refuses admission; clearing the draft is explicit recovery.
- New replies keep a bounded receipt of the source-read versions or context digest, read range and omissions; older replies say no snapshot was recorded.
- In Chat, a mention of a Chat thread also offers `octant_ask_thread`: one instruction to that thread and a wait for its reply, one hop, failing closed. Turns mentioning no Chat thread do not get it.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Coordinator threads

A person may make a Code thread a coordinator: a long-lived thread that starts worker threads without asking, talks to them, and brings their requests to the person (maintainer request, 2026-11-10). Starting can be restricted to proposals for the host or one Project.

- Only a person makes or stops a coordinator, at a local window or a person-paired device (maintainer decision, 2026-11-12), up to Settings › Limits › Coordinators per Project (default 4; [Octant's own limits become settings](#octants-own-limits-become-settings)). Role, lineage and switches are thread fields journaled as `code.thread-updated@1`, never carried by a creation command. Proposals use the planner's path; the designated planner counts as a coordinator whose starts always need approval, and designation refuses a worker or one past the limit.
- Outside Strict a coordinator's own file, shell and Git actions follow its thread's level (maintainer decision, 2026-11-25); under Strict they keep Plan's gate at every level. It has no delivery target, board card or pull request and is never Done. Each turn carries a host-written roster of workers with no agent text.
- `octant_threads` `start` is offered only to a current coordinator outside Plan, or to an allowlist naming `octant_threads.start`. It creates an ordinary Code thread in the Project on a new managed worktree with an `agent`-initiated first turn, so approvals wait for a person. Workers are never coordinators or offered `start`.
- Settings › Code › Coordinators › Starting workers: Start without asking (default) or Propose for approval, with a Project override, changed only by a person and read at every call. A proposal's review starts on the requested provider, model and level and offers no higher level; a person-paired device approves or declines as asked, journaled as the device, while another provider, checkout or lower level stays at a window (maintainer decision, 2026-11-12).
- The person may fix the workers' level, Full access included, when creating the coordinator at a window or person-paired device; it is journaled, never changes, and a mark does not lower it (maintainer decisions, 2026-11-12 and 2026-11-13). Otherwise a worker's level is at most the coordinator's, and a marked coordinator's worker takes Full access only outside Strict (maintainer decision, 2026-11-25). A marked coordinator's worker starts marked (`coordinator-start`); an unjournaled mark refuses the start.
- Defaults: six open workers per coordinator (1 to 16) and 60 starts an hour (1 to 600) (maintainer request, 2026-11-12), plus ordinary admission, capacity and spend ceilings.
- A worker wakes for its coordinator's messages unless a person turns that off; making a coordinator turns its own wake switch on. The host sends closed-set state notices (turn ended, waiting for a person, Done) that do not mark. Wake and round bounds are per coordinator (30 an hour, 10 rounds). The three bounds are journaled on the coordinator and set only by a person at a window or person-paired device, as the device; hub-introduced or restricted devices are refused; older coordinators take the defaults. Wake, start and hop counts persist in a host store (forward-only migration) across restarts, and the start count never reads below the last hour's creations.
- Wake switches (never the role) may also be set from a person-paired device, journaled as it, without owner unlock (maintainer decision, 2026-11-12); a hub-roster device sets them only as an owner device through the owner routes and recovery screen, each change under a fresh unlock.
- The New coordinator draft puts the composer first with one line of settings and defaults beneath; Change… opens the Coordinator limits dialog plus the workers' level, each bound named for what it limits (check-ins an hour, back-and-forths, new workers an hour) (maintainer decision, 2026-11-15). Coordinator limits changes a running coordinator's bounds; Make coordinator offers the workers' level.
- A worker's approvals and questions are listed in the coordinator's composer and as one row each, naming the worker, at the end of its thread view (maintainer decision, 2026-11-14), answered only by the person through the worker's own path; a row whose request leaves reads its outcome. Needs you rows name the coordinator, and pending proposals show as a card ([Workspace: Coordinators](workspace.md#coordinators)).
- Workers live inside their coordinator (maintainer decision, 2026-11-15): the sidebar lists only the coordinator row, counting working and needs-you workers, and the board shows no worker cards or Coordinator filter; Needs you, Inbox and Search are unchanged. A Workers panel in the pane header (Needs you, Working, In review, Done folded), worker cards in its transcript, and a "Worker of <coordinator>" header with Back to coordinator reach them; the pair wears a mark. Settings › Code › Coordinators › Show workers (In the sidebar, On the board; off by default, Project choice winning) lists them again and enables the board's coordinator filter. It is a view preference changed by a person at a local window, granting nothing.
- The coordinator's Agents dock lists workers with their subagents. A window holding a current coordinator may read workers' child runs as facts (task, state, route, effort, ordering), never reply, result, recovery text or control; other callers are refused before any read, and the agent gets none of it (maintainer request, 2026-11-11).
- A worker's model comes from the model roles once Builder has one (maintainer decision, 2026-11-15): `start` names `task` and `size` (or a `role` or role-card handle with a `why`), and raw ids are refused; with no roles, workers use the coordinator's model. `chooseWorkerModel` skips models turned off, signed out, down, at a usage limit (until reset), barred by Project policy or data rules, without proven tools, or blind when images are needed and Sees images cannot describe one (then the builder gets `look` and described attachments). It walks fallbacks, borrows the next tier, climbs a tier on retry, never drops, keeps reviews off the reviewed provider, and journals `coordinatorChoice` (no prompt). An ask-first role proposes even under Start without asking, offering Use Builder instead; a first request failing for availability restarts on the next model. Each turn carries a role card that does not mark.
- A running worker stopped by a usage limit or outage continues on its role's next eligible model while Continue on the fallback if the model stops is on (default; Project first) (maintainer decision, 2026-11-15): the host switches provider or model with disclosure, journals `continued-on-fallback`, and runs one host turn under ordinary admission naming old and new model, account and reason, only for the stopped turn on its model and never after a person's turn or model change. The reason is on the hand-off record and in the transcript either way; the row shows "fallback: <reason>" and the coordinator gets a non-marking notice. Propose for approval does not stop a move; Ask before using does. The walk goes forward only, at most once; at its end or with the box off the worker pauses. Person-started threads, coordinators, workers on a person's model or usage-limit hand-off, resting threads, and roles that ask first are never moved.
- A person may set a "done when" condition on a coordinator (maintainer decision, 2026-11-21): up to 16 unique items, each a pull request merged, its required checks green, or an active non-coordinator, non-planner Code thread in the Project Done. Setting and clearing are journaled (`coordinatorDoneWhen` on `code.thread-updated@1`, optional for older journals) and allowed only from a window or person-paired device. The host checks on a per-coordinator backoff (30 seconds to 15 minutes), coalesces pull request reads, reads Done from manual marks or fresh read-only Git and pull request evidence, wakes the coordinator through its wake path and bounds with only closed-set unmet facts, never starts workers, survives restart by replay with satisfaction persisted (re-evaluating recovered wakes live), and stops once all hold or it is cleared or the coordinator stops or is archived. The pane header's Done when button and the Coordinator limits dialog view, edit and clear it.
- Coordinators have not run on a real provider or the desktop app; those live checks are on the maintainer live-smoke list. The draft and dialog are rendered in a harness page at desktop and phone width, the submenu is component-tested, and the workers' view is rendered against mocked threads.

Not built yet:

- Work coordinators: a Work thread can message a sibling and be woken by one (maintainer decision, 2026-11-13), but the coordinator role, `start` and state notices are Code's.

Status: Partly built. Since: 2026-11-10. Detail: [Coordinator threads](coordinator-threads.md).

## Boards, pull requests and delivery

### Thread boards and Done

Threads form one real hierarchy. Work and Code have server-derived boards; Chat has none. An agent never marks any thread Done.

- The boards are the bundled Board plugin. Off hides every board view; the status policy and board projections and routes stay, because other surfaces read them. Owner: [Workspace](workspace.md#boards-and-integrations).
- A Code thread is Done when its confirmed delivery target is objectively met, or when a person marks it Done anyway, journaled as an override that Reopen clears. A Work thread is Done when a person marks it, with no confirmation or evidence; the mark locks the thread on the host (queued messages hold, child results wait, a due resume is invalidated) until Reopen. (maintainer request, 2026-11-12)
- A Work or Code lead outside Plan, never in Chat or a child run, may call `octant_report_finished` with a summary (at most 1,000 characters) and up to 12 checks (at most 200 characters each). (maintainer decision, 2026-11-19)
- The host runs each check and goal-criterion check once in the thread's checkout at the thread's level, marks unchecked criteria `claimed`, and records diff counts. A failure records nothing and returns each failed check's last 2,000 characters in the same turn; outside Strict there is no retry limit, and Octant starts no turn.
- A pass journals `thread.finished-receipt-recorded@1`, shows a "Finished, with proof" card in the turn and on the Review page, and marks the board card "Finished" without moving it. A later file change makes it `stale`. Done over a fresh receipt records it as completion evidence (`completionReceiptId`).
- Replayable run cases derive idempotently from receipts, newest 200 kept; Leave no trace and purged threads give none. `bun run replay:run-cases` is maintainer-only, never in tests or CI. (maintainer decision, 2026-11-19)

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Pull requests from a Code thread

A Code thread may push its own branch and open, update and stack pull requests from it, through one journaled Octant pull-request tool.

- Only the Project's bound repository is touched, never another thread's branch. Plan and revoked forge access refuse every action; `help` is not an action.
- Force-with-lease on the thread's own branch is the default; a plain force-push needs a one-act approval Full access does not replace. (maintainer request, 2026-11-12)
- A push to the default branch needs a one-act approval unless the Project switch "Agents may push to the default branch" (off by default) is on; a force onto it always does. That switch and "Agents may comment on pull requests" are set from a local window or a host-person-paired device, journaled, and reread at every act. (maintainer decision, 2026-11-12)
- Each action journals actor, repository, number and head SHA. Octant stores no forge token.
- The tool pushes, amends, opens (ready, draft, stacked), edits, sets existing labels, comments, replies, closes, reopens, merges ([Pull-request merge](#pull-request-merge)) and watches ([Merge when ready and Auto-fix](#merge-when-ready-and-auto-fix)). A watch needs no approval. (maintainer request, 2026-11-12)
- Comments and replies do not ask at Full access; below it the comment switch stands in for the per-post ask, except under Strict on a thread that read outside content.
- `github.com` links record the pull request and base repository node IDs; owner/name and number are display fields. `PullRequestLinkService` alone owns forge identity and every reader goes through it: it backfills IDs once, follows renames and transfers, and merges duplicate links into the earlier one, keeping a switch on only if on in both, with a notice. A missing ID refuses nothing; a mismatched one fails a head check.
- The thread's Environment lists its pull requests under Changes from the host's cache, never a window's forge call: the three newest with state, checks, line counts and merge-queue state. (maintainer request, 2026-11-16; [Workspace](workspace.md))
- The review pane carries the person's label, comment, reply, approve, request-changes, close and reopen controls; a review is recorded on the head they read. No agent, routine or paired device reviews.
- Every forge change Octant reads in a shell command is journaled (`shield-forge-changes.observed@1`). At Full access a Harness command that merges, plain-force-pushes, or touches another branch is refused before it runs; a provider runtime's is recorded with the hard line it crossed.
- At Ask first and Auto, recognizable pushes and pull-request writes are refused before the Harness shell runs them. A provider runtime's own push or `gh` write is an ordinary ask, which Octant Shield decides at Auto. (maintainer decision, 2026-11-14)
- Paths Octant only observes after the act are recorded, never presented as enforcement.

Not built yet:

- Complete forge enforcement for arbitrary scripts and hidden targets: a shell command's real target cannot always be read.
- The default-branch push switch in the interface: hidden until an agent push path to the default branch exists; the server field and rule stay.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Pull-request merge

A person merges an open pull request from its review. A Code thread's agent merges only with the person's approval for that one merge, at every level, or under a stored choice the person made.

- Merge is enabled only for a fresh, mergeable observation; the confirmation names the reviewed head, and the server refuses a stale one.
- Octant uses the host's forge CLI login and strips ambient tokens. Every attempt journals actor, repository, number, method, approved head and result.
- A paired phone or web client merges one pull request or a stack only with `confirmed: true` for the reviewed head, and only when the required checks pass. No owner unlock is needed: the authenticated device is the person. (maintainer decision, 2026-11-12)
- A stack merges bottom first, each child retargeted first; one that is not a single chain is refused whole. Merge stack rereads every layer and stops before anything merges on a draft, conflicting, closed, stale or rebased layer; a layer counts merged only when the forge says so. Higher layers keep their own Merge. (maintainer decision, 2026-11-25)
- A review reply posts only after the thread is read back on that pull request.
- An agent merges on the person's request only after the person approves that one merge in the thread, Full access included (`merge-pull-request`).
- An agent merges without a per-act ask only under the Project's Agents may merge switch or the routine's Merge the pull requests it opens choice, each set from a window on this host or a host-person-paired device. The host rereads the choice at the merge (`standingMergeAllowanceFor`), enforces head and checks, and refuses once it is off. A routine's choice reaches only a thread its enabled run created. (maintainer decision, 2026-11-12)
- An agent never merges on its own initiative. No plugin, hub or peer host merges.

Not built yet:

- Stack merge on the phone: only the web renderer offers it.
- Owner unlock (a host switch, off by default, set from a window on the host): decided, no code yet. When on, a hub-introduced client's merge, a stack merge and turning Merge when ready on need a fresh owner-device unlock bound to the merge request.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Merge when ready and Auto-fix

A Code thread's pull request review carries two switches the person turns on: Merge when ready turns on the forge's auto-merge, and Auto-fix wakes one linked Code thread to fix failed required checks, unresolved review threads and base conflicts. A thread's agent may also watch its own pull request to be woken instead of polling. (maintainer decision, 2026-11-05)

- Auto-fix is turned on from a local window or a host-person-paired device. A paired client turns Merge when ready on only with `confirmed: true` for the reviewed head. No provider, agent tool, plugin or routine reaches these routes. (maintainer decision, 2026-11-12)
- Merge when ready is the forge's auto-merge matched to the head the person saw, never an Octant loop; it answers unsupported where the repository forbids it.
- A watch binds the thread's own open linked pull request with no approval at any level; Plan and host-started turns refuse it. It shares Auto-fix's pass and outside-content mark but fixes nothing, waking one turn per pass on settled checks, review changes, new comments or a conflict, never for its baseline. It ends with the pull request, the thread or the repository, on unwatch, or after ten wakes or three days ([Octant's own limits become settings](#octants-own-limits-become-settings)). After a restart it stays quiet until a window shows the pull request or the agent asks again. (maintainer request, 2026-11-12)
- Auto-fix wakes the thread with one turn through the routine follow-up path, at the thread's own level, after marking it as having read outside content (a refused mark sends nothing). It tells the agent: never force-push, never rewrite pushed history, merge the base instead of rebasing.
- `/babysit` and the Pull requests list start it per pull request and thread. After a restart a local window or a host-person-paired session reauthorizes it. Spent feedback turns or two quiet observations of the same repair hand it back; a ready pull request gets a separately confirmed merge pinned to its commit.
- At most three attempts per failure unless Settings › Limits says otherwise. It stops when the pull request merges or closes, the thread is archived or gone, the repository is lost, or the person turns it off.
- Every switch change, watch change and wake is journaled.

Not built yet:

- An item this entry does not name: it was Partly built with no unbuilt item stated (question for the maintainer).

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Modes, Merge when ready and Auto-fix](../architecture.md#modes-chat-work-and-code).

### Second-model pull request reviewer

A bundled, switchable first-party plugin (`octant/second-model-pull-request-reviewer`) reviews pushed heads of linked Code threads' pull requests, only through the `pull-request-reviewer` seam and the host's review port.

- Off by default; enabled per Code Project with a per-thread override. The route picks provider, model and effort; the picker suggests a provider other than the worker's, and review stays off until a model is picked.
- **Post findings as a PR comment** (per Project) and **Send blocking findings to the worker** (per PR) are opt-ins, off by default. Settings change only from a local window or a host-person-paired device (`principalActsAsHostPerson`), journaled.
- It runs at most once per pushed head, after the worker turn settles, at Plan's read-only gate (`executionPolicy: "plan"`) whatever the thread's level. A head that moves mid-run records `stale` and publishes nothing.
- Findings are `CodeReviewFinding` with agent authorship, reviewer provenance, severity and a diff anchor; stale anchors show as stale and feed the correction-request composer.
- With comments on, it posts at most one plain comment per head through the person's `gh` login and never approves or requests changes. With hand-back on, it marks the thread (`pull-request-review`) and wakes the worker through Auto-fix's path; under Strict hand-backs stop at Auto-fix's attempt limit, outside Strict there is no cap.
- It counts toward the parent's spend ceiling, ledger and metrics at input plus output tokens. When unavailable it shows the reason (`no-route-configured`, `no-account`, `route-refused`, `capacity`, `spend-ceiling`, `not-effective`) and never falls back to another model.
- A live maintainer smoke against a real repository with two signed-in providers is owed.

Status: Built. Since: 2026-11-20. Detail: [Architecture: Modes, Merge when ready and Auto-fix](../architecture.md#modes-chat-work-and-code).

### Delivery to targets the person owns

Octant runs no deployment infrastructure and offers no ship target of its own. Every target is an account, cluster, registry or store the person owns.

- A ship integration never receives a secret: it names a credential reference, and the host hands it a bounded, purpose-scoped handle at use. _Here only._
- A standing grant never replaces the per-act approval.
- A target may be a machine Octant creates in the person's own cloud account through a credential reference in the broker. It appears as a Server Project the person suspends and resumes. An Octant-operated hosted service stays out of scope. (maintainer decision, 2026-11-14)
- A cloud machine target is a plugin contribution, offered once installed, trusted and enabled. Create, bind, refresh, suspend, resume and destroy are a person's acts at a local window, journaled. Destroy needs one host-issued confirmation, and a machine is recorded destroyed only when its provider reports it gone.
- The host pins the host keys reported at creation. A suspended machine's Project refuses turns and calls by name. Hourly cost shows only when the provider reports it.

Not built yet:

- Delivery itself: the ship service exists, but no target source, build observer or per-act approval bound to target, revision and build is wired, and delivery stays out of the interface until all three are.
- A cloud machine target plugin, a per-machine key and wake-on-open: not written yet ([Server Projects: Machines in the person's cloud account](server-projects.md#machines-in-the-persons-cloud-account)).

Status: Partly built. Since: 2026-11-14 (cloud machines). Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Project planner thread

A Code Project may name one of its threads its planner, whose agent proposes new Code threads for a person to accept in the Project overview. [Coordinator threads](#coordinator-threads) are meant to take over this role; until then this is the built behavior, and a coordinator's proposals use the same path.

- Only a person confirms or declines. A proposal executes nothing; the planner has no creation authority.
- The planner reads its board through `octant_threads` (`board`) and proposes through `octant_offer_side_task` (target `board`), both offered only to the named thread and re-resolved on every call. The schema bounds a proposal; at most ten wait.
- The overview names the planner and lists versioned proposals with approve, decline and resulting tasks. There is no phone or CLI mutation.
- Approval reviews the ordinary provider, checkout and access controls with the intent fixed; only confirmed creation reaches the first-message path. A stale, refused or uncertain decision never starts or retries by itself.
- The host journals one creation identity before awaiting creation; no window or restart replaces it, and the window keeps it through reload. Only confirmed creation or a newer host-proven failure before creation releases it; unknown later failures stay reserved for inspection.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

## Routines and timed turns

### Routines

A routine is a host-owned, Project-bound definition that starts an ordinary thread or turn on a trigger. It can do nothing the thread it creates could not do.

- The dispatcher revalidates host, Project, binding, profile, provider, model and authority at every occurrence; a stale definition never adopts replacement authority.
- A routine runs as the host, with no window, on an in-process timer; nothing runs in a cloud. A self-hosted wake service on a hub can wake a spoke (tested only on loopback with a fake socket). An automation-origin turn cannot create, edit, run, pause or archive a routine.
- An agent only proposes; a person confirms, and the host builds the definition from the thread's live facts with an approval-gated profile. A Plan turn may propose; host-run turns cannot. The routine takes none of the thread's posture: it asks first and never runs in Plan.
- When the person's own message asked for it (`requestedByPerson`), the host creates it at once with no card at every level outside Plan, active outside Strict and paused under it. On a thread that read outside content the agent's word is not believed. (maintainer decision, 2026-11-25)
- An agent's own suggestion waits for the card below Full access; at Full access it is created at once, active unless "Start agent-created routines active at Full access" is off. The level is the turn's: Work's running access; for Code, the stricter of posture and journaled level. Follow-ups and Plan turns always wait for the card. (maintainer decision, 2026-11-12)
- Each created routine leaves a **Created automation** card and appears in the thread's Environment; the phone shows a thread's routines read-only.
- A Work or Code agent may read its Project's same-mode routines and runs, and ask to pause or archive its thread's own; only the person's confirmation, at the version the agent saw, changes it. Plan and host-run turns are refused. Resume, edit, run now and cancel stay the person's.
- The turn started for a run may report its result once (succeeded, nothing-to-do, needs-attention, failed; at most 1 KB). It shows beside the run's status and never changes the lifecycle or sends a push notification.
- A Work or Code routine may target a Project on a registered server; this host schedules it and the turn runs there at the same levels and approvals. Revalidation refuses by name a removed Project, a departed server or a changed mode or binding; an unreachable server fails the run before any thread exists. The editor offers server Projects only to the host's own person, with Octant Harness models only, and refuses file triggers there ([Server Projects: Routines](server-projects.md#routines)). (maintainer decision, 2026-11-14)
- A Work run observes its exact first-turn request and captured facts. Terminal status is journaled before the slot is reused; missing evidence stays active; edits never replace the run snapshot; a replay or notification failure never redelivers the call.
- A Chat routine keeps Chat's authority (an active Chat Project; no folder, shell, Git, subagents or level) and sends one turn into a new Chat thread, or for a follow-up into its own. Its run finishes when the turn sent under its submission identity settles.
- File triggers are Work or Code, new-thread only, under the main local root, with the Secret guard and confined reads. The journal owns the baseline, batch and start budget (default 8, 1–32). Hidden, linked and protected input is excluded; incomplete scans block. Changes during known routine activity, and input still awaiting the person, are held for an explicit Review or Re-arm; nothing re-arms by itself. Native identities stay bound through the send; timed-out proofs are never resubmitted. Input goes as framed external data with the task fixed. The activity window holds 64 runs by default, up to 1,024 ([Octant's own limits become settings](#octants-own-limits-become-settings)). A Code run copies its batch into `octant-routine-inputs/<run-id>` in its checkout, never overwriting other content.
- Integration-event triggers, set at a local window or a host-person-paired device, poll a read-only contributed source every 1–60 minutes (at most two in flight): GitHub runs within its latest 100, Linear assignments from a complete bounded set. No hosted scheduler or webhook. Cursors and claims are journaled; gaps and lost windows need review; allowances are 1–32 starts; Re-arm skips held events. Payloads are framed external data, never grants. (maintainer decision, 2026-11-13)
- A stopped run's Retry makes a new manual run with its input, leaving the allowance alone; not for an edited definition, active run or follow-up. The manual CI-failure card shows branch-correlated routine work first.
- Native watcher, filesystem and live provider acceptance evidence is owed; controlled fixtures prove the rest.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Routine authority level

A Work or Code routine asks first unless the person opts it into its Project's level, Full access included, or picks a level on it, which is a ceiling: each run takes the lower of the pick and its Project's level.

- The stored execution profile is never Full access: dispatch blocks one as `full-access-ineligible` (`revalidateAutomationAuthority`). A run reaches Full access only through the opt-in or a pick, read at dispatch.
- The opt-in (`projectLevel: "opted-in"`) and the pick (`runLevel`: Ask first, Accept edits, Auto, Full access) are journaled on the definition and copied into each run; a routine has at most one. A Code run's thread takes the Project level, or the lower of pick and Project level (`runLevelMode`); a Work run's turn takes the pick as ceiling (`clampWorkAccess`).
- With neither, a Code run's thread is approval-gated, and a Work run's first turn asks first unless the captured authority is itself Accept edits.
- A Code routine may merge the pull requests it opens when the person allowed it ([Pull-request merge](#pull-request-merge)).
- Only the host's own person sets the opt-in, pick and merge choice, at a local window or a device they paired; an agent-proposed routine never has them. A Chat routine has no level. (maintainer decision, 2026-11-12)
- A Work routine captures shell and Git as a Code routine does, with an approval-gated Work profile; one saved without them does not run until saved again.
- The editor saves Ask first explicitly for Work and Code; definitions with no level keep their behavior until saved.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Follow-ups in the same thread

A follow-up is a one-shot routine that sends one scheduled turn into the thread it came from.

- The host re-checks the thread at fire time and refuses with a typed reason rather than adapt. One due on a busy thread runs after the running turn; it never runs twice or after archive or cancel, and survives a restart. (maintainer request, 2026-11-12)
- One missed or held runs once if within the lateness limit (Settings › Limits, 24 hours by default, up to 30 days), else fails without sending. (maintainer decision, 2026-11-21)
- Its turn runs as the host under routine ceilings; widening the thread never widens it.
- A Chat thread in a Chat Project may have one, set from its Routines row or proposed by its agent through the same confirmation chip; only the person's confirmation creates it. Chat gets no other routine tool. It runs with Chat's authority on the thread's model, taking only the Canvas where the session's tool catalog has it. (maintainer decision, 2026-11-21)
- The follow-up leaves the Routines row once its turn starts.

Status: Built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Usage limits and stalled turns

A turn stopped by an explicit provider usage-limit signal carries a provider-neutral fact. Resuming at the reset is the person's per-thread opt-in.

- Only a protocol signal makes the fact, never text matching. An unknown reset stays unknown; a billing stop gets no reset or resume. The reset timer is in-process, through ordinary admission; a stale recovery settles invalidated.
- Silence past the stalled-turn limit (Settings › Providers & Models, 30 minutes by default, may be off; at Full access outside Strict a second setting, Off by default, per [Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)) journals `turn-stall-noticed` with a quiet Stop line outside Strict and cuts the turn off under Strict. Six identical tool calls in a row follow the same rule.
- A provider tool call reported running pauses the clock (maintainer request, 2026-11-12); one with a start and no finish pauses it at most two hours by default, a setting that may be off. (maintainer decision, 2026-11-12)
- These settings are journaled, changed at a local window or a host-person-paired device, and apply from the next turn. (maintainer decision, 2026-11-13)
- A provider whose sessions each own a process offers Force stop ten seconds after an unfinished Stop, killing only that attempt's process and leaving the thread resumable; it never takes a PID or kills a replacement. A Stop naming a superseded turn is refused.
- A Stop the runtime does not confirm within ten seconds says "Stop was not confirmed"; the runtime's own report stays the turn's only outcome. Turns yield the event loop after 10 ms of provider events, so Stop never queues behind deltas.

Not built yet:

- Force stop on per-session-process providers other than Claude Code: only Claude's driver offers it so far.

Status: Partly built. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Wake-ups the agent schedules

A wake-up a thread's agent asks for (Claude Code's `ScheduleWakeup` and `CronCreate`) is Octant's from the moment it is asked for; the runtime's scheduler never holds it, so nothing fires in a session Octant does not see. (maintainer decision, 2026-11-14)

- The driver answers wake-up calls from the thread's schedule after the gate (asking below Full access); the runtime runs none and writes no `.claude/scheduled_tasks.json`. List and delete reach only the thread's own.
- Each is journaled on a `thread-wakeup` aggregate and shown above the composer with its next time and Cancel, which a local window that can open the thread or a host-person-paired device uses, journaled with the device.
- At its time the host starts a turn as the host through ordinary admission at the thread's level, under a host heading; the journaled `fired` change records its origin. A busy thread holds it.
- One due while the host was down or asleep, or more than two minutes late, runs once on return. With "Run missed wake-ups on return" off it shows as missed, and only Run now starts it. (maintainer decision, 2026-11-25)
- Bounds, unless Settings › Limits says otherwise ([Octant's own limits become settings](#octants-own-limits-become-settings)): 8 waiting per thread, first fire at least a minute away, delays of one minute to one hour, recurrence as often as every minute for at most 7 days. Archive, delete or purge ends them.
- Work and Code outside Plan only; Chat runs Claude in Plan and is never offered the tools.

Status: Built. Since: 2026-11-14. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code) and [Provider runtimes: Wake-ups the model schedules](provider-runtimes.md#wake-ups-the-model-schedules).

## Transcript records

### Agent task display and tool-call records

The agent's plan panel and tool-call groups are projections of journaled state, never renderer-owned plans.

- A provider's own task plan arrives as task events; each restatement names the ids the plan holds (at most 64), so a dropped step leaves the panel.
- An Octant Harness lead's `todo-write` lists reach the same panel as the same events. Settings reports task progress for a Harness endpoint once one of its models passes Verify tools; the driver's probe keeps `taskProgress` unsupported, since conformance needs the events in every scripted turn.
- Chat and Work record each tool call as id, name, state and a redacted message of at most 2,048 bytes, up to the tool-step limit (maintainer decision, 2026-11-13): by default 64 a turn below Full access and off at Full access, where the spend ceiling bounds it; 1 to 4,096 for either, read at the level the turn runs at, the same in Code. A step is journaled and streamed alone (`chat.attempt-tool-step@1`; Work's `turn-tool-step`), never the whole list.
- The turn's event budget is 64 runtime events per kept step, so 4,096 by default and none when the limit is off (maintainer decision, 2026-11-14). It stops a Chat turn, and a Work or Code turn only under Strict; outside Strict the turn runs on and nothing is journaled (maintainer decision, 2026-11-25).
- Answered-request ids and Code's carried tool names forget their oldest settled entries past 4,096.
- Chat and Work tool calls keep bounded input and output in purgeable storage, on by default (maintainer request, 2026-11-12), for Claude's own tools and every tool Octant runs: 16 KiB input and 64 KiB output a call, cuts marked, 16 MiB a thread oldest-first. Records are redacted before storage, never journaled, and nothing is added to the journaled step. Withholding fails closed: output is kept only when the whole input was judged during the call and named no protected file; a cut, unread, over-count or missing input withholds it.
- Purge and delete remove the records; thread export and Export my data carry them in each thread's bundle. A local window or person-paired device reads them; hub-introduced devices keep remote-device limits (maintainer decision, 2026-11-12). An Octant Harness call has a row, keyed by its request id, that opens its record (maintainer decision, 2026-11-13).
- Workspace navigation, panes, tabs and dock tools belong to the workspace specification, with visuals in the design system.

Not built yet:

- Records for Codex, ACP, OpenCode and Pi's own tools: those runtimes report no input or output.
- The paired-device screen for reading records: a follow-up; the server policy is in place.

Status: Partly built. Detail: [Architecture: Tool calls in Chat and Work](../architecture.md#tool-calls-in-chat-and-work) and [Architecture: Agent task display](../architecture.md#agent-task-display).

## Persistence

### Event journal and projections

The event journal is the authoritative record; projections are rebuildable and idempotent. One local database file under the data directory is created owner-only.

- A command targets one aggregate with its expected version; a stale version returns a typed conflict and writes nothing. _Here only._
- Every event has a versioned envelope. A projection checkpoint may trail the journal head, never lead it. _Here only._
- The store runs WAL with normal sync: every commit survives a process crash; an OS crash may lose commits since the last checkpoint, never tear one. Full sync stalled the control plane on every append. (maintainer decision, 2026-11-14)
- Streamed Chat and Code deltas batch into one commit per short burst. A Chat delta writes its own row, so cost does not grow with the reply; reads and the next whole attempt fold them in.
- Purgeable bulk content (terminal transcripts, test output) lives outside the journal, referenced from it. _Here only._
- An in-memory projection replays from the journal's start at every host start.
- A turn's streamed text and reasoning, and a Work reply (journaled once at settle), are bounded at 32 MiB; past it the turn keeps what was journaled, ends with a truncation marker, and stops. (maintainer decision, 2026-11-14)
- A write failing on a full disk commits nothing and says the disk is full.

Status: Built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Quarantine and migrations

Unreadable events and unsafe migrations fail closed. Octant never skips an undecodable event and reports current.

- A malformed, contract-invalid, unsupported-version or unapplicable event is quarantined: its projection keeps its last valid state, and readiness becomes recovery-required with a typed reason disclosing no payload. _Here only._
- A projection is authoritative unless it declares itself a derived view no command or authority check reads (today only diagnostics exports). A failing authoritative projection rolls back the append. A failing derived view is quarantined alone with its lag reported, while the append commits and readiness stays current; `db:rebuild` repairs it.
- Only a successful rebuild retires quarantine: an explicit one, or the one bounded rebuild a start runs over a journal that decodes and passes its integrity check ([startup repair](../architecture.md#persistence)). Ambiguous recovery state resolves to waiting or recovery-required, never healthy.
- Migrations are ordered, forward-only, checksum-verified, and applied in transactions after a store backup, before ready. A changed checksum or unknown newer migration fails closed.

Status: Built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Recovery after a restart

A restart recovers what the journal can prove and never guesses that an ambiguous outcome succeeded.

- Orphaned running Code turns become Waiting; orphaned Work turns settle Interrupted; repeated starts append no duplicate recovery events. Cut-off turns continue under [Continuing a turn a restart cut off](#continuing-a-turn-a-restart-cut-off).
- Running Code work that reaches a remote becomes ambiguous and keeps the thread Waiting; local work becomes interrupted. A push failure Git did not attribute to the remote's refusal is ambiguous, not failed.
- After reconciliation the host settles unconfirmed push and pull request steps once in the background, through each thread's own checkout, remote and pull request, a few threads at a time, never blocking start-up; any unreachable remote or failure leaves a step unconfirmed, never settled by guess.
- An unconfirmed update or merge stays so until the person at a local window marks it resolved from its board card, a journaled command checked against Project access; no agent or paired device can. (maintainer request, 2026-11-13)
- A retried comment counts as landed only when more of the person's comments carry its text than before it was sent, and is refused when that cannot be read. Concurrent submissions with one operation id run once.
- Outstanding approvals are recovered; a parked provider question settles interrupted, since its session died.
- Clients catch up from the authoritative snapshot, keep retrying, and renew a remote session from the device key. A change cursor from an earlier host process (epoch) gets a snapshot; renderer retries are jittered.
- Removing a host on the phone sends nothing to the host, so it does not revoke the device.

Not built yet:

- An item this entry does not name: it was Partly built with no unbuilt item stated (question for the maintainer).

Status: Partly built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Recovering after a crash without the terminal

After a crash or reboot the host repairs what it safely can and says what is wrong. Nothing needs the `db:*` commands.

- Projection-only damage over a sound journal rebuilds at startup, at most once per start. Journal damage refuses the start and leaves the journal unchanged.
- A refused start opens a desktop recovery screen offering only what the refusal allows: rebuild, or restore the last verified backup after a separate confirmation, or start again or quit. Error copy names only commands that exist.
- "Keep Octant running in the background" and, on macOS, "Open Octant at login" are off by default, show what the OS reports, and change only from Octant's desktop windows. A real Mac install and uninstall is a maintainer check still owed.
- A terminal, debug session, Project action run or Browser page a restart ended offers a one-click restart or **Reopen page**, each an ordinary start checked against current authority, with no grant the old process held. Browser pages are journaled by start and end only, with no address or content ([Browser profiles](browser-profiles.md#reopening-a-page-a-restart-took)). (maintainer decision, 2026-11-25)
- Extensions get no restart button; a button must never stand in for install, trust and enable.
- An unexpected host exit leaves a local, redacted crash record; the newest 20 stay on the device and leave only in a support bundle the person saves. Native crash dumps are never collected: their memory cannot be redacted.
- The server and desktop share one last-resort process error net (`@octant/host-runtime/process-error-net`) that logs a redacted cause and exits non-zero; `bun run style:check` refuses any other unhandled-error handler.

Status: Built. Since: 2026-11-12. Detail: [Architecture: Process topology](../architecture.md#process-topology) and [Persistence](../architecture.md#persistence).

### Continuing a turn a restart cut off

After a crash, force quit or reboot, the host continues each turn the restart cut off, once, as the host. It is on by default with a setting and a per-thread opt-out, and a thread whose external action may have been in flight waits for its person. (maintainer decision, 2026-11-12)

- Only a turn the previous host was still running qualifies. A clean shutdown counts as a crash.
- The continuation is Resume's message: inspect first, do not repeat what may have taken effect, ask again for approvals and answers.
- Continue after restart is a per-mode switch, on by default (Settings › Chat & Work for Chat and Work, Settings › Code), plus one per thread, changed at a window on this computer or a device its person paired; hub-introduced devices and agent grants are refused. (maintainer decision, 2026-11-12)
- The thread waits instead when the switch is off, a Code push or pull request step's outcome is unknown, a may-change tool call has no recorded finish, two continuations were cut off, the provider cannot resume, or the turn never reached its provider.
- A tool call is recorded before it takes effect and when its outcome is known, naming thread, turn, call, tool and whether it only reads, never arguments or results. Only declared read-only tools count as read-only. The host never reruns a call. (maintainer decision, 2026-11-12)
- Host-run tools are recorded before they start; a runtime's own tools when the host reads their start, as may-change. Child runs keep their own record, and a parent waits for a child's unfinished call. (maintainer decision, 2026-11-13)
- A tool only waiting for approval does not hold: records precede entry, the wait and the answer. This covers harness, MCP, Browser, routine, memory, image and question prompts, and a runtime's approval request naming a call whose start the host read; an unmatched request holds. Browser downloads, later operations of a batch or replay, and unrecorded runtime requests keep the hold. (maintainer request, 2026-11-22)
- A runtime's start report for a host tool the turn offers it is not recorded (OpenCode's spelling unchecked live; ACP only when paired with one open call naming Octant and the tool). (maintainer decision, 2026-11-13)
- Clients read an unknown hold reason as another kind. Minimum compatible client: Octant 0.1.0-preview.20261114.3; older clients refuse a tool-call hold status. (maintainer decision, 2026-11-13)
- After a deliberate quit nothing continues; threads wait with `quit` and the notice says how many. The desktop reports the quit on a bridge-secret loopback route; the host keeps a one-start marker. A system restart, shutdown, session end or the Dock's Quit continues. (maintainer decision, 2026-11-12)
- Each recovery identity continues at most once; the crash-loop count survives restarts. Dispatch needs no window and rechecks authority, posture and spend through ordinary admission. Queued messages follow; a paused queue stays paused. Each start's notice reads "Octant restarted. Continued N threads; M need you."
- It covers Code, Chat, Work, Work goal loops ([Architecture: Work restart recovery](../architecture.md#persistence)), subagent runs under the parent's live grant ([Architecture: subagent restart recovery](../architecture.md#persistence)) and pending coordinator wakes, each through its ordinary path.
- A packaged-app `kill -9`, quit, system restart and Windows session end are maintainer live checks still owed.

Not built yet:

- A runtime's own tool whose start the host had not read: unprovable either way, so the turn continues.
- A terminal-started Browser session and a saved Browser flow's run: they sit outside any turn and write no record.
- Asking again a Chat answer waiting on a question or approval at the restart: it is still settled interrupted when answered.

Status: Partly built. Since: 2026-11-12. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Snapshot-first thread reads

A thread paints from an authoritative snapshot before auxiliary observations begin, and reads stay off the full journal.

- Files, Git, Browser, Computer Use and other auxiliary observations wait for the transcript or an explicit open. _Here only._
- The host reports latency classes (navigation, thread snapshots, conversation evidence, environment observation) and returns Server-Timing on measured responses, without identifiers. _Here only._
- Threads open on their newest turns through a windowed read; the journal stays complete, and totals read the whole thread.
- Chat publishes reply deltas and their cursor on a 50 ms beat, flushes on completion, and cancels pending publication when the view or thread changes; stale teardown cannot drop the new thread's update.
- A running turn's latest step is memory-only, redacted at the adapter and on observation, never journaled.

Status: Built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Outside-content taint

Browser observations, tool results and imported content append a journaled mark with bounded source labels, never raw bodies. The mark lasts the thread's lifetime.

- Irreversible or authority-bearing actions on a marked thread need fresh confirmation, even after replay; the closed tool catalogue flags them.
- At Full access in Work and Code the mark is recorded only. A person turns it down per thread or per Project's new threads by setting that level.
- A provider runtime's own web tools mark the thread when first reported; a mark that cannot be recorded stops the turn.
- A key provider's own web tools are offered when the person allows them and still mark; Claude Code's web reads ask below Full access.

Not built yet:

- Showing the mark on a paired device: only a local window draws it today ([Architecture: Persistence](../architecture.md#persistence)).

Status: Partly built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Clearing a taint mark

Only a person, at a local window or a device the host's own person paired, clears a thread's mark, recording that they reviewed what it read. (maintainer decision, 2026-11-12)

- The clear route is loopback-only. No tool, command, model output, agent message or host-run turn can clear.
- A clear removes the mark only; nothing leaves the model's context, and the next ingestion marks again.
- It is refused while a turn runs or is queued, and at a stale version.
- An approval on a marked thread says the mark is why it asks, and what marked it.

Status: Built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Data lifecycle, exports and diagnostics

Reset, remove, delete-host, retention and purge are explicit, reported per scope, and never implicit. A retention window never deletes by itself.

- Only a confirmed purge erases a thread's bulk content, Canvases, sessions and worktree. Usage records are de-linked, and a tombstone stops a rebuild from restoring the transcript.
- A host-person-paired device sets retention and purges as a local window does; a hub, peer host or agent grant cannot. (maintainer decision, 2026-11-12)
- Startup journal compaction and the completed-thread archive sweep, which yields between batches, are the only self-applying exceptions.
- A thread bundle or host export is a local-owner read with no secrets, filesystem paths or raw provider payloads, and names what it omits.
- A diagnostics export carries counts and kind names only.

Status: Built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Artifact mirror and replicas

The mirror writes plain files for people and tools and never pushes to Git. Replicas are append-only, signed, write-once logs in a store the user owns.

- The first mirror command journals the effective fallback (the default folder's Artifacts subfolder), so one override never quietly turns mirroring off. _Here only._
- Optional auto-commit is off by default, commits only the files it wrote, and refuses when other work is staged.
- The mirror route answers a local window or a host-person-paired device and refuses others. (maintainer decision, 2026-11-12)
- Each host writes only its own entries. An import adds versions with provenance and never adopts another journal or overwrites a version.
- Divergent heads are shown for a person to pick or merge. Entries are readable, not encrypted; credentials and absolute paths never leave.
- With sync off, no store, or Plan, no store call is made.

Not built yet:

- The mirror in paired clients: the server admits a paired device, but no paired client offers it yet.

Status: Partly built. Detail: [Architecture: Persistence](../architecture.md#persistence) and [Artifact replica sync](artifact-replica-sync.md).

### Composer drafts and the message queue

Unsent drafts stay on the client that typed them. Messages sent while a turn runs go into a host-owned ordered queue shared by Chat, Work and Code; in Work and Code it steers them into the running turn where the runtime steers.

- Drafts are not journaled, not in diagnostics, and not sent until the person sends; deleting or purging the thread removes them.
- The desktop and web composer stash and restore full content in every mode; a move consumes the stash only once the destination draft is recoverable. Saved drafts survive archiving and are purged only by confirmed purges ([Thread view](thread-view.md#saved-drafts)).
- Queue metadata and order are journaled; bodies and attachments stay in purgeable private storage. Every dispatch rechecks Project, provider, model, checkout, access and context policy through ordinary admission.
- Changed authority, uncertain delivery, the person's cancel and a Work Done mark hold the queue until an authenticated user resumes it.
- After an ordinary failure (recorded failed, not stopped, cut off or unconfirmed) or a clean restart the queue continues once by itself; a second failure in a row holds it. A clean restart's hold lifts when each message's window or device is live again; a thread the host continues after a cut-off releases under the host's scope ([Continuing a turn a restart cut off](#continuing-a-turn-a-restart-cut-off)). (maintainer request, 2026-11-12)
- A paired device queues on a thread it may send to and edits or removes its own, rechecked at every change and dispatch; Read only can read the queue. (maintainer request, 2026-11-12) A device the host's own person paired at Full manages the whole queue as a local window does, journaled as the device. (maintainer decision, 2026-11-13)
- A text-only message typed into a running Work or Code turn steers it: the queue offers it to the turn's `steer`, and a taken one settles `steered`, is journaled on the turn (`thread.message-steered@1`), and shows as "Sent while the turn ran". Codex, Pi, the Octant Harness and steering ACP profiles take it; Claude Code does not, so its messages wait. (maintainer decision, 2026-11-21)
- Not offered: messages with attachments, mentions, selections or other parts, `/` commands, messages under a paired device or the host's scope, and Chat. A refused steer waits for the next turn. Only the offered message is locked (`steering`), and the runtime is asked outside the queue lock.
- Every transcript view, export, handoff, compaction summary, mention, search and fork carries a steered message as a user message of its turn.

Not built yet:

- The queue in paired clients' composer: the server accepts their queue commands, but the clients do not offer it yet.

Status: Partly built. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Local diagnostics export

A person can export a local diagnostics bundle to share by their own choice. Octant sends nothing by itself and keeps no telemetry.

- The bundle is written locally and leaves the machine only when the person sends it.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Persistence](../architecture.md#persistence).

## Providers

### Provider layer and honest capability

Every provider reaches Octant through the provider SDK, and every driver reports what it can do per mode and model. The server disables what is unsupported instead of emulating it.

- A driver exposes probe, acquire and a connection, and passes the shared conformance harness before it is selectable. Provider wire payloads stop at the adapter.
- Every capability starts unavailable until negotiation or evidence proves it. A broken installation never shows as a permanent lack of a feature. _Here only._
- Provider permission callbacks are signals, not a sandbox. An adapter may narrow Octant's session authority, never widen it; a driver that cannot represent the authority reports degradation or blocks. _Here only._
- A managed-process driver runs one supervised process group per active session, from an absolute executable path with a minimal sanitized environment, and reports incompatible when it cannot separate authentication storage. A driver family without resume, identity or attestation guarantees stays unselectable. _Here only._
- Each subscriber to a connection gets its own subscription and every event. Callers subscribe before they send; a lazily subscribing stream fails conformance. _Here only._
- A composer reads the same probe before offering an app-managed tool. A runtime that does not carry Octant's tools is offered neither Browser nor Computer.
- Bounded provider subprocesses run under a deny-default OS sandbox. A missing sandbox backend fails closed as incompatible.

Status: Built. Detail: [Architecture: Providers](../architecture.md#providers).

### Provider-hosted Code jobs

A local Code thread can associate a separate, immutable, text-only remote job with an endpoint opted in on its own. Local checkout, tools and thread authority stay unchanged.

- Each submission needs consent to its exact input and to its cost and execution.
- The first public SDK and outside-driver protocol is the closed OpenAI Agents codec.
- An unknown submission is never retried automatically, a known remote identity recovers by read, and cancellation is only requested. Every actual create records unknown usage. Required spend ceilings refuse.

Not built yet:

- Other wire protocols and automatic file or patch transfer: not implemented.
- Proof of account eligibility, provider sandbox enforcement and billing: needs a live check; local synthetic and rendered checks do not prove them.

Status: Partly built. Since: 2026-11-04. Detail: [Architecture: Provider cloud jobs](../architecture.md#provider-cloud-jobs) and [Provider runtimes: Provider cloud sessions](provider-runtimes.md#provider-cloud-sessions).

### Provider instances and accounts

Providers are multi-instance. A thread stays on its instance until the person moves it, now or through their per-thread usage-limit opt-in. A thread a person started never moves on its own: no silent, unchosen or open-ended failover, rotation or load-balancing between accounts (maintainer decision, 2026-11-14).

- The host moves only a coordinator's worker, down its role's list, which the person ordered: one whose first request failed for availability before any work, or a running one whose model stopped on a usage limit or outage while **Continue on the fallback if the model stops** is on. Each move is a disclosed provider change recorded as the host, walks the list forward at most once, and never leaves the roles (maintainer decision, 2026-11-15; [Coordinator threads](#coordinator-threads)).
- A selected model is a host, a provider instance and a model id. The model picker is provider-first: one fixed 360×376 float 4px from its trigger, with icon tabs, the shared filled search, 28px rows (a check marks the chosen model, never a fill), a ⌘1–⌘9 hint live only while open, "Show more" for a long list, and always-present Reasoning and service-tier rows with segments sized to their words, disabled with a reason when the model lacks them (maintainer request, 2026-11-16; [Thread view](thread-view.md#model-picker)).
- Extra accounts use state directories Octant assigns; two instances of one driver never share one. Removing an account leaves its directory, and deleting it is the person's step.
- A Claude Code subscription or Codex account signs in with its provider's unmodified CLI command under its directory, run by the host from the Settings card or by the person with `octant account` (maintainer request, 2026-11-17). Octant reads only the sign-in address the CLI prints and relays a pasted code; it never reads, stores or injects the login. Octant's own terminals carry no `octant account`.
- Adding an account is one in-place wizard for every agent runtime (provider, sign-in, details, connect, done) in a fixed 560×520 dialog. Only the details step creates the account; connect shows the host's sign-in command and Check connection inline (maintainer request, 2026-11-14; [Additional CLI accounts](model-endpoints.md#additional-cli-accounts)).
- Plan usage comes only from the provider's own process, per account; a failed refresh keeps the last snapshot with its age. Octant never calls a first-class provider's usage endpoint itself or reads its credential files ([Account usage reads](#account-usage-reads) covers the others).
- Plan usage shows as one ring per account above the rail's account face (the three with least left; the account menu lists all, and stands in where no rail shows), in the start screen's composer line and in Settings, never on the Inbox or beside or inside a thread (maintainer requests, 2026-11-18 and 2026-11-25). The stored `usageBars` field stays only so old rows decode.
- **Move to account:** the person moves a Chat, Work or Code thread to another account of its provider, keeping its model; every same-provider account change takes this path (maintainer decision, 2026-11-17). The new account's driver copies exactly that one session's files in the host through the provider SDK's `nativeSessions.carry` port, refusing links, non-UUID ids, outside paths and a differing file, and resumes it, journaled with `nativeSessionTransferred: true`. Only Claude Code sessions are carried; a Codex move, a refused copy and a cross-provider move carry the [disclosed handoff](#handoffs-between-providers-forks-and-branches) with the reason. The host refuses the move from anyone but the person, while a turn runs, and while the model pool is on.
- **On usage limit, hand off to:** a journaled per-thread opt-in naming one account, set only by the person and not while a model pool is on. A turn stopped on a provider-reported usage limit moves there by the same path, at most once per stopped turn, with both accounts and the reason recorded; an unusable target stops the move with the reason.

Status: Built. Since: 2026-11-14. Detail: [Architecture: Providers](../architecture.md#providers).

### Provider credentials and sign-in

API keys live in the host credential store and are reached only through the loopback credential broker by opaque reference. Octant never reads, stores or injects a CLI provider's own credentials.

- Secrets never reach the renderer, journal, logs or diagnostics. A key pool cools a key refused for quota, credit or rate limit, in host memory only.
- A host with no usable secret store reports it unavailable and stores nothing, with no file or in-memory fallback at any flag. _Here only._
- Sign-in is delegated (tokens stay with the provider runtime) or host-driven (tokens stay in the broker; [Host-driven provider sign-in and cloud signing](#host-driven-provider-sign-in-and-cloud-signing)). An API-key path stays beside every sign-in.
- Changing an endpoint's base URL, or switching it between a key and a sign-in, deletes the stored credential before the change is journaled.
- Directory sign-in and cloud request signing run through the broker, which signs only inside the scope stored at sign-in. The server never holds a signing key.
- A person may link a secret store they already use; the broker resolves it at use, and Octant keeps only the store name and item address.
- The AWS command line's key pair may point at two linked-store items; Octant's shell then gets only a short-lived session the broker makes.
- The Google Cloud command line may point at one service-account JSON item with an exact expected email and explicit scopes. The broker's fixed-endpoint exchange keeps the signing key from the server; local-window consent is journaled before dispatch, and a lost reply stays unconfirmed. IAM roles may span cloud Projects. Each command owns its token and configuration files; receipt recovery is confirmed before stale cleanup, and a failure leaves the files untouched and disables only this channel.

Status: Built. Since: 2026-10-26. Detail: [Architecture: Providers](../architecture.md#providers) and [Enterprise provider identity](enterprise-provider-identity.md).

### Provider catalog, discovery and outside drivers

The provider catalog lists only bundled driver manifests under a closed schema. Discovery registers runtimes without installing or changing anything. Outside drivers enter only through their own quarantined lifecycle.

- A catalog entry claims no install, trust, enablement, credential or capability. Opening the catalog starts nothing; scan, connect, enable and connection check run only from their button.
- Discovery keeps one provider per driver family and never installs, updates or toggles an existing instance. An update runs only on the person's click.
- First-run enablement of the two key CLI providers is decided once per scan from durable host state, only while onboarding is pending and no instance was ever recorded. Later auto-registers stay disabled. _Here only._
- Discovery may recover a single-token executable alias only by reading named shell startup files, byte-bounded, through the discovery filesystem port, never sourcing or executing them. _Here only._
- Outside drivers are installed held from a local folder and trusted at a digest, with the publisher key pinned at first trust. Where they run: [Linux parity for provider tools](#linux-parity-for-provider-tools).
- An account named exactly "Codex CLI" (codex) or "OpenCode CLI" (opencode) is renamed "Codex" or "OpenCode" once at host start, unless its journal holds a rename or the new name is taken (maintainer decision, 2026-11-14).
- A bundled driver can be withheld: not admitted, no instance or process, stored instances and threads kept (maintainer decision, 2026-10-29). None is withheld (maintainer decision, 2026-10-31).

Status: Built. Since: 2026-10-26. Detail: [Architecture: Providers](../architecture.md#providers) and [Outside provider drivers](outside-provider-drivers.md).

### Project provider policy and data tags

A Project allows all providers, a list of instances, or an EU or zero-retention tag policy. The host checks it before every Work and Code turn and handoff, child runs included.

- Either `eu` or `zdr` satisfies the tag policy, which does not by itself guarantee zero retention.
- Data tags are labels the person maintains, not verified residency or retention. _Here only._
- Renderer filtering is advisory and cannot grant what the host refused. An unavailable provider never starts a turn, listed or tagged. _Here only._

Status: Built. Detail: [Architecture: Providers](../architecture.md#providers).

### Image generation and voice

Image generation is a journaled job with exactly one profile. Voice is an app-managed capability riding one enabled compatible-endpoint instance. Neither grants Chat filesystem authority.

- Offers for paid outside calls share one host-held card, visible and answerable only at the local window or person-paired device whose turn asked, checked for thread access and kind before one answer is taken. Offers do not survive restart. Needs you, the Inbox and fleet activity find the thread without granting answer authority.

Images:

- An agent generates an image in Chat, Work and Code only through a card: the person picks profile and model, lets the agent draw SVG instead, or cancels, and may say not to ask again. That choice is journaled per Project, survives restart, and serves the Project's routines; outside a Project a Chat thread keeps it in host memory.
- At Full access the card is skipped when the Project holds a choice or one image profile is ready (on its default model); with several ready, the profile Settings › Voice & images names for Full access, else the first ready (maintainer request, 2026-11-12; [Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).
- A kept choice the host can no longer run is dropped and asked again, at Full access too. Project Overview names it and takes it back with "Ask again" (maintainer decision, 2026-11-12).
- The tool is offered only while a profile is ready, never in Plan or a Side Chat, and in a host-run turn only where the Project holds a choice. Every provider is told to call it rather than draw (maintainer decision, 2026-11-07). A call waits up to two minutes and hands the image to a model that reads images; the thread shows it after the turn.
- Reference images reach the provider only after the person confirms the named sources on that request, even at Full access or with a kept choice. The card flags signed-in Browser screenshots; the host reads no reference bytes before confirmation, Chat reaches no files, and only a reference-capable model runs.
- A safety refusal ends the job and is never retried elsewhere; one per-image safety failure refuses the whole result. A driver that cannot honour the image count or references fails closed as invalid configuration. _Here only._
- The journal holds attachment references and a prompt hash, never image bytes or prompt text.
- Image profiles never drive Chat, Work or Code turns, and image drivers reach the host only through capability-scoped SDK ports. A credential goes only over HTTPS to hosts the driver declares or the origin of a configured base URL.
- A custom image source is a provider, model and label from a bounded list, accepted only as an exact listed pair; a removed or disabled instance fails with a reason, never falling back. _Here only._
- An image job's usage row carries only the token counts the provider's response states, and no provider-recorded cost.
- Save to Project creates a new file under the Work folder or the Code thread's checkout, never overwriting and never from a Code thread in Plan.
- In Work and Code the agent can save a finished image as a new confined file, or as an app icon or favicon set checked all or nothing, at the turn's level. Off macOS the resize runs in pure JavaScript, an exception to native-first host tools recorded in [Agent tools](agent-tools.md) (maintainer decisions, 2026-11-22 and 2026-11-23).
- A person-paired browser can view and download images from threads it can open, which grants no image library or file-write access.

Voice:

- Settings › Voice & images › **Transcribe with** picks Off or an enabled OpenAI-compatible endpoint and model, or **Other model…**. **Test microphone** plays at most ten seconds back locally and sends it only on Transcribe it. **Microphone** is kept in this computer's browser storage, not journaled settings, and falls back to the system default when missing (maintainer requests, 2026-11-24).
- The remappable `dictate` chord (Mod+Shift+M by default) acts on the focused composer: a tap starts and the next tap stops; a hold of 300 ms or more records until release, even when only the modifier's release is reported. It never sends, does nothing while transcription is not ready, and one composer records at a time (maintainer request, 2026-11-24).
- Dictation **Language** (Automatic or a BCP-47 tag) and **Your dictionary** (up to 100 terms of 64 characters) apply to every transcription the host makes; a language the request names wins. An older host cannot read settings holding them (maintainer approval, 2026-11-24).
- **Apple Speech on this Mac** (macOS 26 or later desktop host) dictates in the Mac's own windows on Apple's on-device model and calls no endpoint for anyone, so paired clients and agents get no transcription. Its model downloads only on Download, named in the host data map (maintainer request, 2026-11-25).
- Dictation and read-aloud persist nothing. A paired device reaches transcription; `/api/speech/synthesis` stays host-only, but a paired device can confirm a narration offer in its thread, so the host synthesizes and writes the file without streaming audio to it.
- In attended Work and Code outside Plan, after a shared offer, an agent may transcribe a confined recording, or narrate up to 4,096 characters into a new confined audio file with `octant_narrate`. Remembering covers only the same thread, endpoint, model and voice, in host memory; narration skips the card only at Accept edits and Full access. A transcript enters as outside content. Agent calls leave a slot for local dictation and read-aloud.

Not built yet:

- "Ask again" from a paired device: today only a window on the host takes a kept image choice back.

Status: Partly built. Since: 2026-11-07. Detail: [Architecture: Providers](../architecture.md#providers).

### Video generation

Short clips run as a journaled job through provider-neutral video driver plugins on the person's own keys, following the image rule for asking, with the price on the card (maintainer decision, 2026-11-22).

- Drivers plug into the `videoGeneration` seam of `@octant/provider-sdk` through the plugin-host activation ladder and its conformance harness. Each model declares its durations, resolutions, aspect ratios, audio, inputs, price basis, cancel, removal and resume window, and the host builds card, price, limits, spend, storage, recovery and viewing from them for every provider alike.
- First-party drivers are Google Gemini API, Runway and fal, bundled as plugins configured in Settings; other providers are left to plugins (maintainer decision, 2026-11-22).
- A runtime's own native media output shows in the thread with no Octant gate.
- `octant_create_video` is offered in Chat, Work and Code with its card on desktop, web and phone, never in Plan or Side Chats. The card offers only declared options, shows the declared-price estimate before Generate, says what Stop does and how long the provider keeps a clip, and offers "Don't ask again", kept per Project by media kind. Full access, routines and paired devices behave as for images.
- A priced model is offered only at combinations it has a rate for; a missing rate is refused before "Don't ask again" can be kept.
- Discovery before offering or queuing is limited to 30 seconds, and Stop or shutdown interrupts it before spend is reserved.
- The host bounds only stored size (1 GB), job time (30 minutes) and queued jobs (16 per host), running two at a time beside the image queue. Thread and Project spend ceilings apply, settled from reported usage or charges, else the estimate; a rate limit or confirmed connection failure releases the reservation.
- A job out of time settles and frees its slot at once; the provider is asked to stop for at most 15 seconds, then its copy is removed.
- Clips are stored beside images and exported and deleted with their thread; the provider's copy is removed once kept, where the driver can. After a restart a job with a provider id resumes within its window, else settles at its estimate.
- Clip bytes are served on a ten-minute ticket that rechecks thread authority and the paired device's session on every request. A phone discards a clip when access is lost.
- Real-provider runs, physical phone playback and packaged download are maintainer live checks still owed.

Status: Built. Since: 2026-11-22. Detail: [Video generation](video-generation.md).

### Provider reach Octant no longer narrows

Octant does not narrow provider reach the provider itself allows (maintainer decision, 2026-11-16).

- **Ollama:** a local-network or hosted address is allowed, and plain HTTP to a private-network address with a warning in Add endpoint. A public address needs HTTPS. The host judges the literal host (loopback, a private or overlay range, an mDNS `.local` name).
- **Bedrock signing:** "Use my AWS profile" and long-lived access keys (behind a warning) are offered at a local window or a device the host's own person paired, refusing hub-introduced and restricted devices. The server stores only the pointer and journals only the reference.
  - The broker reads a named profile in place as the AWS CLI does, assumed and chained roles, metadata and web-identity sources included (maintainer requests, 2026-11-18 and 2026-11-19; sources in [Model endpoints: Amazon Bedrock](model-endpoints.md#organization-sign-in-amazon-bedrock)). An unreachable metadata source answers "This profile reads credentials from EC2/ECS metadata, which this computer can't reach." after one second.
  - A role with `mfa_serial` asks for a six-digit code in the sign-in panel at connect and on expiry. Assumed credentials stay in broker memory only, never in the Keychain or journal.
  - Outside Strict, runtimes on Bedrock (Claude Code, Codex) read the person's AWS profile and environment directly; Octant does not resolve, copy or replace their credentials.
- **Releases:** judged as [Provider releases are ranges, not pins](#provider-releases-are-ranges-not-pins) says.

Status: Built. Since: 2026-11-16. Detail: [Architecture: Security and authority, Provider reach Octant no longer narrows](../architecture.md#security-and-authority), [Native harness](../architecture.md#native-harness) and [Model endpoints: Amazon Bedrock](model-endpoints.md#organization-sign-in-amazon-bedrock).

### Provider releases are ranges, not pins

A provider's compatibility is a range that refuses only known-broken releases. No live probe has to precede an agent shipping (maintainer decision, 2026-11-21).

- A feature reviewed on named releases (an ACP profile's usage, forms, compaction, file review, warm reuse, unadvertised HTTP tools) is kept at every level on them and every later release (`acpReleaseClaim`); a later unreviewed release keeps it unverified, and the runtime card says so. An older release, or one whose version cannot be read, does not keep it. Compaction and file review stay limited to Mistral Vibe.
- A reviewed command inventory refuses no release: Kimi Code runs any command its session lists, at every level.
- A profile's `brokenVersions` (empty today) refuses a listed release with a sentence naming it. Nothing else refuses a release at or above the floor.
- A floor stays only where it is the earliest probed release or a protocol requirement (Mistral Vibe 2.24.1, Pi 1.1.0's `+name` tool list, OpenCode 2.0.22 and its 2.2.0 and 2.4.1 routes). Pi's tools and warm reuse run from 0.85.1, unverified below 1.1.0 ([Pi runs as itself](#pi-runs-as-itself)). OpenCode's isolation attestation proves launch confinement and keeps its exact releases.
- Capabilities carry no separate Full access value. OpenCode's `appManagedToolsAtFullAccess` and `appManagedToolsOutsideStrict` (`mixed`) stay, since they answer tool exclusivity.

Status: Built. Since: 2026-11-21. Detail: [Provider runtimes: Probe before a profile ships](provider-runtimes.md#probe-before-a-profile-ships) and [Architecture: Security and authority](../architecture.md#security-and-authority).

### Linux parity for provider tools

Octant's tools reach OpenCode and ACP agents on Linux as on macOS, and outside provider drivers run on Linux (maintainer decision, 2026-11-16).

- A Linux launch reaches the tool bridge on the shared host network, or, when Network limits proxy it, through the egress forwarder's loopback relay for the bridge's port alone. Windows launches reach the loopback bridge directly ([Windows below Full access](#windows-below-full-access)).
- An outside driver runs confined on macOS. On Linux it takes the same install, trust and enablement steps and, until Linux extension-process confinement exists, runs unconfined with the same fixed environment; its row reads "Runs without confinement". Windows stays `host-prohibited`.
- Strict keeps an outside driver `host-prohibited` on Linux. The host's Strict decides (the Code or Work default, as a Chat thread reads it), read at each listing, admission and use; a running driver is refused at its next use, and a start decides again after its files are verified.

Status: Built. Since: 2026-11-16. Detail: [Provider runtimes: What an ACP agent cannot do](provider-runtimes.md#what-an-acp-agent-cannot-do), [Provider runtimes: Codex](provider-runtimes.md#codex) and [Outside provider drivers: Maintainer decisions](outside-provider-drivers.md#maintainer-decisions).

### Pi runs as itself

Pi, which is not a key provider, runs as it does on its own by default (maintainer decision, 2026-11-14).

- Work and Code load the person's own Pi skills, prompt templates and context files at every level, and their extensions outside Plan. Plan keeps `read`, `grep`, `find` and `ls`, and Chat keeps no tools.
- Outside Strict, in Work and Code outside Plan with no Octant sandbox, Pi runs on the person's real home and agent folder with its own discovery on (`piRunsOnOwnHome`), so it loads its extensions, skills, prompt templates, themes, context files and the packages its own settings list, as in the person's terminal. Its sessions stay in Octant's Pi session folder. (maintainer decision, 2026-11-25)
- Strict, Chat, Plan and a kept or chosen sandbox keep the managed home, where Pi's own discovery is off and the person's resources are named by path; packages its settings list do not load there.
- The tools their extensions register are offered on a release that takes `+name` tool additions (1.1.0 on), and Octant's approval bridge asks, by the thread's level, for every tool but the known reads and Octant's own. An older release keeps the built-in allowlist.
- A Pi model whose own listing names image input takes image attachments, reported as `nativeAttachments` ([ACP agents run as themselves](#acp-agents-run-as-themselves)).

Not built yet:

- An account or thread switch for Pi: it needs Pi in the key provider contract.

Status: Partly built. Since: 2026-11-14. Detail: [Provider runtimes: Pi](provider-runtimes.md#pi).

## Context and usage

### Context planning and model windows

Every request passes through one Octant-owned context planner before it reaches a model, and a model's window is found without asking the person.

- Each subsystem registers attributed entries in the turn's context manifest; an adapter never appends unaccounted context. _Here only._
- A turn is not sent when planned input exceeds the safe budget: window minus response budget, reasoning reserve, framing estimate, variance reserve and safety margin. _Here only._
- Reduction runs in order: duplicates, stale optional context, lazy tool schemas, large results as summaries, durable summaries, older resolved ranges, narrowed memory, then a question. Safety, authority, approvals, the current request and pinned content are never removed silently; if they cannot fit, the turn is blocked with remedies. _Here only._
- An absent service limit is unavailable, never unlimited; conflicting trusted limits take the most conservative. A pin or exclusion applies to the next turn only and never bypasses the budget. _Here only._
- A window comes from the person's override, provider metadata, a learned refusal, then a shipped catalogue never fetched at runtime. A fallback estimate is never shown as the real window.
- Context commands and inspection need a local window that can open the thread or Project, or a host-person-paired device under the same rule. (maintainer decision, 2026-11-12)

Status: Built. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Provider capacity

One in-memory scheduler admits every Chat turn, managed child, automation and compaction against each provider instance's limits. Only a capacity answer backs a provider off.

- A refused request, rejected credential, unreachable endpoint or spent usage limit is not a capacity answer; the turn fails with its own cause.
- A child that finds the provider full waits at most 30 minutes by default (1–240 in Helper agents settings), holding no run slot, provider slot or session. (maintainer request, 2026-11-12)
- When a slot frees the host rereads the parent; a helper whose parent drifted in authority ends Interrupted.
- Person-started turns keep a short head start over helpers, not strict precedence.

Status: Built. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Turn metrics and spend ceilings

Every runner feeds provider events to one pure policy that times turns and journals full usage. Optional Project and thread spend ceilings gate admission.

- Precision is typed (exact, approximate, unavailable). Octant never shows a zero or rate it did not measure.
- Ceilings cover tokens, turns, run time and money, refused at admission; model turns check money between turns. Child spend counts against the parent thread's and its Project's ceilings.
- Billed image generation reserves estimated cost against money ceilings before dispatch (`countsAsTurn: false`), fails closed with `unknown-spend` when no rate is known, records settled cost whenever billed images return, and abandons the reservation otherwise (`ImageJobService`, `SpendCeilingService`). (maintainer decision, 2026-11-21)
- Cost is fixed when usage is journaled; projections never price, so history is never re-priced. Unpriced usage refuses a money ceiling as unknown-spend; a provider that never reports usage shows Not measured.
- An ACP release newer than the reviewed one counts as measuring at every level, and a turn with no usage report refuses as unknown spend. The ledger records no level; the upgrade that dropped the Full access column keeps the ids of earlier unreported turns, which stay left out while the release's usage reading is unverified. (maintainer decision, 2026-11-21)
- Every turn or image job that reached its provider leaves one ledger row with all it reported, however it ended; one that never reached it leaves none.
- Spend ceiling rows show only when Show spend ceiling is on (off by default) or a ceiling is set.

Not built yet:

- An item this entry does not name: it was Partly built with no unbuilt item stated (question for the maintainer).

Status: Partly built. Detail: [Architecture: Stop reasons](../architecture.md#stop-reasons) and [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Local usage history

Local provider history is a read capability of the provider SDK; quota windows are a separate provider-reported snapshot.

- History is read without a session or provider process, only from bounded, recognized usage files under the adapter's documented roots, keeping accounting facts only. Malformed input makes coverage partial, never a false zero. _Here only._
- The accounting checkpoint is a versioned, bounded, rebuildable cache apart from the journal and ledger; opaque identities prevent double counting. _Here only._
- History reaches Usage only through a local authenticated endpoint returning bounded aggregates, never model tools or remote clients. A quota reset is never assumed to refill. _Here only._
- An earlier stored reading answers only when asked, saying it is earlier with its range, coverage and time, and the surface reads again at once. _Here only._

Status: Built. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Compact session

Compact session replaces what the model sees with a summary and a recent tail, when the person asks or a rule they set asks, always outside a turn. It never deletes or rewrites the journal.

- The conversation's owner compacts: the host for host-planned history, the runtime where its adapter claims support. Octant refuses where the runtime cannot; two runtimes declare no support.
- The command needs a local window that can open the thread or a host-person-paired device, uses the thread's own provider and model, and needs no tool approval. Plan stays allowed and read-only. (maintainer decision, 2026-11-12)
- A compaction never clears taint, counts its tokens against the Project's ceilings, and never starts a replacement session behind the person's back.
- Automatic compactions are journaled as receipts that never guess a figure.
- A compaction against a real runtime is a live check still owed.

Not built yet:

- Compacting a server thread's conversation: the Code runtime opens no compaction session for a `remote-root` checkout ([Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting)).

Status: Partly built. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Automatic compaction rules

Octant compacts a thread by itself only under a rule the person set in Settings: the window past a share, the thread gone quiet, or the provider's account limit near. Each runs the same compaction as Compact session.

- A rule asks as `host-policy` and meets every refusal a window meets; a refused rule leaves nothing behind. A Code thread is compacted only under the window whose turn crossed the rule.
- By default Octant compacts the threads it keeps (Octant Harness, and Chat and Work on a direct endpoint) at 85% of the window, and leaves self-compacting runtimes to their own point.
- Each rule-started compaction records its cause; the timeline names the rule and how full the window was.
- A rule never switches provider; the person picks the next model.
- The limit rule (off by default) compacts once per account-limit period, first writing with the thread's provider a summary a provider switch leads with; the thread then offers **Switch model**.
- The shares reach inside a turn: Claude Code and Codex get them as a per-session setting, never in the person's files, and Octant Harness summarizes earlier turns past its share. Settings shows each runtime's own setting beside Octant's.
- Each rule on a live runtime is a check still owed.

Status: Built. Since: 2026-11-07. Detail: [Automatic compaction](automatic-compaction.md).

### Held standing context and resume

A provider that keeps its own conversation is sent standing context once, and resume is bound to a durable identity.

- Blocks the session holds are not resent. The record keeps session ids and digests, never text; a compaction or failed restatement drops it, and a failed turn drops the newer keyed block it sent.
- Standing text never varies by turn: a one-turn instruction is its own never-held kind, and a re-read file is a keyed block appended alone. A restatement replaces the material entry, so reselected context is delivered again.
- A rule about an app tool reaches only a session that can call it (Codex keeps its starting tools in the resume cursor). A tool replacing a runtime's own path (Simulator.app, an emulator, a backgrounded shell, `gh`, native subagents) gets one short routing line.
- Octant's instructions open with a fixed per-mode orientation, then reply formats, the mode's rules, tool notes and the turn's instructions, in that order in every mode.
- Where a runtime offers a side channel (Codex additional context, the Claude Code prompt hook), context goes there and the message is only what the person typed; context never moves into a system prompt or tool list, so cached prefixes hold. Octant's instructions may take Codex's developer channel; skills and material keep user-level authority. Hook context counts as held only once confirmed delivered.
- Resume refuses as stale-resume when its binding names another instance, session, Project root, mode or native id. One process at most owns a native session per instance. A session moved to another account resumes under the new account's binding.
- A retained runtime is reused only for an identical task, instance, executable, home, root, mode, model, policy, auth mode and tool catalogue; any mismatch cold-resumes. _Here only._
- Resuming a native file needs a header matching session and root; a missing, ambiguous or cross-Project history refuses before input. _Here only._
- A follow-up on another model resumes the native session only when the driver reports model switching; otherwise a fresh session starts with a disclosed handoff.

Status: Built. Detail: [Architecture: Held standing context](../architecture.md#held-standing-context) and [Architecture: Stop reasons](../architecture.md#stop-reasons).

### Handoffs between providers, forks and branches

When a conversation moves to a new session, the new provider gets a bounded, disclosed text handoff and never resumes the old session. The exception is a move to another account of the same provider that can carry the session ([Provider instances and accounts](#provider-instances-and-accounts)): that turn resumes the provider's session in the new account, recorded as `nativeSessionTransferred: true`.

- The handoff is journaled before the prompt, with counts, taint and omissions. Hidden reasoning, tool activity and the old native session never transfer. Chat and Work need one only when the destination keeps its own session.
- Original user inputs are kept apart and checked (bytes, scope, modality) across provider changes, rewind, forks, branches and merge-back; an explicit text-only choice records omissions. Destination manifests freeze the admitted inputs across retries and restart; a missing, changed or revoked original refuses the send. Chat gains no filesystem or shell authority.
- A switch that cannot hand over refuses before the provider starts, naming why.
- Continue elsewhere reuses provider changes and the paired-screen transport, separates execution host from controlling screen, and discloses what is kept. A task link opens the same task after authentication and never clones a writer or sends a draft.
- Merging a fork back is explicit, approval-free and context-only; file changes reach the source only through Git review, and the fork's outside content taints the source.
- Every mode and client renders one shared hairline boundary (`TranscriptHandoff`) on a switch, with models, provider marks and the host's disclosure note.

Status: Built. Detail: [Architecture: Stop reasons](../architecture.md#stop-reasons) and [Thread view: Context handoffs](thread-view.md#context-handoffs).

### Stop reasons

A completed event carries a stop reason only when the runtime says why the turn ended.

- Absence is never guessed into a reason.
- A turn cut off at the output limit shows a note with Continue, which drafts a follow-up and sends nothing until the person does.

Status: Built. Detail: [Architecture: Stop reasons](../architecture.md#stop-reasons).

### Octant instructions

A person writes instructions for Octant itself, beside each provider's own instruction files: one for the person, an optional one per Project, and an orchestration text for coordinator threads. (maintainer request, 2026-11-14)

- They cover only what Octant knows: which provider or model takes which job, how a coordinator splits and returns work, and when to use Octant's features. On how a provider works, its own files (`CLAUDE.md`, `AGENTS.md`) come first.
- Octant never writes them into a file a provider reads or replaces a provider's system prompt. They travel as standing context after Octant's instructions and before person memory, on every turn, routines' and coordinators' workers included.
- They grant no authority. Only a person at a local window or a host-person-paired device changes them, each change journaled, and they stay on this host.

Status: Built. Since: 2026-11-14. Detail: [Octant instructions](octant-instructions.md).

### Provider instruction files

Claude Code reads the person's and the Project's `CLAUDE.md` files in Work and Code, Strict included, either by itself or through Octant (maintainer decision, 2026-11-14).

- Claude always reads the person's global `CLAUDE.md` and the Project's (root `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, `CLAUDE.local.md`, and their `@path` imports) in Work and Code, Strict included (maintainer decision, 2026-11-14). Where the `user` or `project` setting source is off, Octant reads them as text with no authority and appends them to Claude Code's own system prompt (every launch sends the `claude_code` preset, Octant's additions only in `append`); where it is on, Claude Code loads them and Octant adds nothing.
- The files are bounded (64 KiB each, 256 KiB in all), text only, never read through a symlink or import outside their folder. Below Full access a file or import the secret guard protects is skipped, and at every level the account's own sign-in files (`.credentials.json` and the like) are; a skipped file's reason is logged.
- Under Strict the Project's settings, hooks and `.mcp.json` wait until the person allows the Project's code ([Adding a Project trusts it for every agent](#adding-a-project-trusts-it-for-every-agent)).
- Where Octant reads a `CLAUDE.md` itself it expands `@path` imports as Claude Code does, within the Project's and config folders, bounded, with no symbolic-link escape (maintainer decision, 2026-11-14).

Status: Built. Since: 2026-11-14. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

## Native harness

### Harness loop and endpoint port

Direct-endpoint providers run under the native harness, which owns the agent loop and the conversation. Drivers supply only a transport, through the provider SDK endpoint port.

- A local model endpoint must be a loopback origin, and every request names its context window.
- A model is offered Octant's tools only after tool verification passed for it. Verification is a probe, not a grant; it runs automatically at first use, and Verify tools stays (maintainer request, 2026-11-12). It never blocks the turn: a failed or toolless answer runs the turn without tools and the model row says why; it is retried at most once per turn start. Only the host-run check writes the record.
- GPT-6 Luna function-tool requests through Chat Completions use its `none` reasoning mode. The OpenCode Go endpoint gets the harness user agent and one stable session header per conversation; each Verify tools check has its own.
- The conversation is journaled step by step. Resume closes interrupted calls as safe or unsafe to replay; nothing is silently re-run.
- A request that outgrows the endpoint first compacts earlier turns, tool-less, on the session's endpoint, then trims. The lead can read cut exchanges back through a read-only journal lookup.
- Every lead request ends with an uncached note on how full the window is, computed as the compaction point is; with compaction off it says Octant summarizes only when a request no longer fits. A model with no named window, or a fallback turn, gets no figure.
- The harness never parses prose as a tool call. An unknown tool name, version, id or argument, or an unoffered capability, fails closed; an ambiguously accepted call becomes waiting or failed, never an unsafe replay. _Here only._
- After any context reduction, the goal, its acceptance criteria and recently edited files are restored to the request. Reduction never changes the journal. _Here only._
- Standing instructions include one fixed About Octant block in every mode: modes and what each may touch, Projects and the board, that an agent never marks Done, access levels and Plan, Project memory, skills, Canvas and helper agents, each tool named "when offered".

Status: Built. Detail: [Architecture: Native harness](../architecture.md#native-harness).

### Harness tool authority and taint

Every harness tool call is authorized under the thread's current authority before any port runs, and outside content taints the thread.

- Offered tools follow the mode. A call is judged by the narrower of the thread's stored posture and the turn's, so a turn narrowed to Plan refuses writes and commands.
- A tool that runs commands for the lead (Code's `diagnostics`) authorizes each as a shell call.
- A direct-endpoint request goes only to the configured base URL, with no redirect. Web fetches refuse private destinations and carry no credential.
- Only results that bring in outside content taint. On a tainted thread, shell, edit, write, check and web-fetch need single-use confirmation and remembered approvals stop covering them; at Full access in Code the taint is recorded and nothing asked.
- Under Strict, a tainted thread's search query that looks like it carries data is refused before it leaves, except at Full access in Work and Code; outside Strict it goes and the mark stays (maintainer decision, 2026-11-21).
- An `edit` call may replace across files under one approval naming every file, all or nothing: each replacement is checked first, a refusal names the failing one, and a later write failure restores the earlier writes.
- Every tool result is hard-capped with a truncation marker and paging; nothing variable enters the stable request prefix. _Here only._
- `read` hands over a PNG, JPEG, GIF or WebP image (by its bytes, one per call) only when the model takes images, else refuses. Word, PowerPoint and PDF read as text and Excel as rows, through the preview parsers, and do not count as the read an edit needs. Other binaries are refused.
- The lead's `skill` tool lists and loads only skills effective under the activation ladder, never installs, trusts, enables or activates one, and only reads, so Plan keeps it.

Status: Built. Detail: [Architecture: Native harness](../architecture.md#native-harness), [On-demand skills](../architecture.md#extensions-and-skills) and [Search queries on a tainted thread](search-query-taint.md).

### Harness retries, routing and fallback

Direct-endpoint requests follow one retry policy, and models are chosen by routing slot.

- A request goes out at most five times and retries only while nothing has streamed; a spent allowance, rejected credential or malformed event never retries. Spent retries fall back once per other ready model; a failure after output streamed never moves the turn.
- Child runs take their model from the role's slot through one admission path; the lead runs on the thread's model.
- Every harness model call names a slot (default, plan, slow, task, smol, vision, advisor, quick, deep, reviewer, custom). An unconfigured slot resolves to default with a visible warning, except the advisor and Sees images, which stay off. _Here only._
- Settings shows the server-resolved slots as roles: Scout (task), Quick edit (quick), Builder (default), Hard problems (deep), Reviewer (slow), Sees images (vision), and Advisor and custom slots under Other roles. Each is an ordered main model and up to 15 fallbacks, with a reasoning level each. Unresolved slots and jobs (`plan`, `smol`, `planner`, `explorer`, `title`, `summary`, `compaction`) stay in the schema so saved routing decodes, hidden unless a live job binds `plan` or `smol` (maintainer decisions, 2026-11-15 and 2026-11-19).
- A role may hold any enabled provider's model, since coordinator workers are ordinary Code threads; the harness skips one it cannot run as `not-harness-runnable` (maintainer decision, 2026-11-15).
- **Suggest roles** and per-row **Suggest** propose from a shipped tier table checked against connected providers, previewed with **Use these** and **Cancel**, saved only by a person; a Project suggests only from Settings' list (maintainer decision, 2026-11-15). [Benchmark results](model-benchmarks.md#suggestions-from-your-benchmarks) can also suggest, by pass bar, cost per pass, median time and freshness; nothing changes without acceptance.
- Each role is global with a per-Project override: **Use Settings** (default) or **Choose for this Project**, limited to models Settings lists, with **Add in Settings too**. Only a person changes either, journaled (maintainer decision, 2026-11-15).
- A role carries **Ask before using** (off) and **Continue on the fallback if the model stops** (on). An ask-first role turns a worker's start into a proposal, and a stopped worker continues on the next model while the box is on ([Coordinator threads](#coordinator-threads); maintainer decision, 2026-11-15).
- The advisor reviews compact turn digests and may cancel, redirect or pause, never running tools, editing files or granting approvals. _Here only._

Not built yet:

- The harness resolver reading **Ask before using** and **Continue on the fallback if the model stops**: they are stored values only, and harness helper runs keep their own fallback.

Status: Partly built. Since: 2026-11-15. Detail: [Architecture: Native harness](../architecture.md#native-harness) and [Model endpoints: Model roles](model-endpoints.md#model-roles).

### Sees images

The Sees images role describes an image in words for a thread whose model cannot read images, and the host decides where an image may go (maintainer decision, 2026-11-15).

- The `image-understanding` job resolves through the routing, the Project's list before Settings', main model first. It skips a model that is signed out, down, at a usage limit, outside the Project's provider policy or data rules, or on a connection taking no image, and names which and why when it refuses. An empty Sees images is off, never falling back to the Builder.
- Each describe is one tool-less request in a scratch folder, input at most 10 MB, description at most 4,000 characters; an answer that read outside content is dropped. It is admitted under thread and Project spend ceilings before the image is sent and recorded as `image-description` usage.
- In Chat, Work and Code, an attachment the model cannot take is described instead of refused: the model gets "[Image <name> (attachment <id>), described by <model> (<provider>)]: <description>" and the transcript says who described it. With no eligible model the turn is refused with "<model> can't read images. Set a model that sees images in Model roles." Stop or a revoked admission sends no further image. The words stay durable for history and compaction. A person's own image adds no outside-content mark.
- `octant_look` is offered only while the thread cannot take an image and Sees images can describe one: a thread attachment, or in Work and Code a confined folder file, with an optional question. A marked thread stays marked. It composes through the public media tool port (`@octant/plugin-api/media-tools`, `@octant/plugin-host/media-tools`); attachments, confinement and routing stay host-owned.
- OpenAI- and Anthropic-style endpoints send images in the user message and claim attachments when a model reads images; other attachment types are refused at admission. Amazon Bedrock claims none.
- `GET /api/native-harness/routing/sees-images` refuses a window that may not see the named Project.
- A run against a real provider is a maintainer live check still owed.

Status: Built. Since: 2026-11-15. Detail: [Architecture: Sees images](../architecture.md#sees-images), [Agent tools](agent-tools.md) and [Model endpoints: Model roles](model-endpoints.md#model-roles).

### Harness sessions, goals and steering

One journaled session per thread is the only state, read and changed by every surface through one route. A person redirects running work only through ordered steering notes and version-checked goal revisions.

- After a restart, a session with an open turn or pending approval is recovery-required and admits nothing until a person resumes it, unless the host [continues a turn a restart cut off](#continuing-a-turn-a-restart-cut-off); a turn whose last effect is uncertain still waits (maintainer request, 2026-11-12). Lost turns and dead approvals are journaled.
- The lead's approvals and questions wait, without expiry, for an answer, the turn's stop, or the thread's archive or deletion, and mark the thread as needing the person.
- At most 32 harness approvals and 32 harness questions wait at once across the host (`MAX_WAITING_NATIVE_HARNESS_APPROVALS`, `MAX_WAITING_NATIVE_HARNESS_QUESTIONS`); past that a call is refused at once and nothing journaled (maintainer request, 2026-11-12). This is not the MCP cap [Octant's own limits become settings](#octants-own-limits-become-settings) removed.
- The app-owned `ask-user` tool asks up to four related single- or multiple-choice questions inline in every mode, with selection limits, unselected recommendations, written alternatives and an optional comment. It creates no Canvas and grants nothing.
- Unsent choices stay in memory on their screen across navigation, never moving windows, surviving reload, or carrying into a changed, settled, cancelled or recovered request.
- A pending question or approval docks above the composer, outside the transcript; options are numbered and 1–9 pick without sending, and the card keeps its own answer field (maintainer decision, 2026-11-24). The host validates the whole response against the journaled ask and accepts it once; another window's answer withdraws the card. [Workspace: Inline questionnaires](workspace.md#inline-questionnaires) owns presentation.
- A goal completes only on a criterion check's evidence or a person. A model saying it is done completes nothing.
- A loop's token, time and turn budgets are its stopping condition: one that would exceed a ceiling moves to budget-limited, which only a person resumes. A revision's budget replaces the whole budget, and a loop refuses to start on a goal with none. _Here only._
- An unattended iteration runs under a ceiling declared at loop start, clamped to the thread's authority. An effect needing an approval no person can give suspends the loop, never auto-approved. _Here only._
- Harness parity with first-class runtimes is claimed only while every checklist item holds in Chat, Work and Code.
- Terminal: `octant` or `octant "<prompt>"` opens `octant agent` on the folder's thread, and offers to add an unheld Git checkout as a Code Project only at an interactive terminal. It shares host model defaults, creates Work access atomically under the access-change rule, uses each mode's versioned commands, and shows side panels at 100 and 140 columns. `/diff` attributes nothing to the thread.
- Work questionnaires are answered in the full-screen terminal and submitted once with `resolve-work-request`; a secret goes through a masked entry sent only as `secretAnswer` (maintainer decisions, 2026-11-22). A level-changing approval shows its plan and target level above the y/n line.
- The terminal has fake-provider coverage. A real signed-in provider flow, and the live evidence real-provider parity needs, are maintainer live checks still owed.

Status: Built. Detail: [Architecture: Native harness](../architecture.md#native-harness).

### Follow-up suggestions and side tasks

Follow-up suggestions and side tasks are journaled offers that grant nothing, from every provider.

- A confirmed follow-up goes through the mode's ordinary creation command; the prompt is never sent for the person.
- A reply may predict the person's next message in one line. The empty composer shows it as placeholder and Tab puts it in the draft; a starting turn spends it. It comes from the same in-reply block on every provider at no extra request, asked for as required because that measured far more reliable.
- Settings › General › Composer › Suggest my next message turns it off or limits it to chosen modes (default on in all three), read each turn; off, nothing is asked or kept.
- A side task is offered for out-of-scope work, a split the person asked for, or a recommended next step, as an inline card after the turn. The person's click starts a new thread (fresh, or forked through the offering turn), does it here (now, or queued), or dismisses. A Code thread still starts approval-gated.
- A side-task thread nests under its offering thread in the follow-up lineage. The receipt shows the child's live state from the sidebar's facts, nothing for an unreadable child, and never enters the parent's context. A fork waits for the offering turn; Work forks as a text handoff.
- Do it here records a durable unconfirmed claim before dispatch. A known refusal reopens the offer; an uncertain delivery stays visibly unconfirmed across restart, never retried.
- A Code Project's planner offers board work with target `board`, recording a proposal only a person confirms.
- Every turn ending in a side-task child is owed to the parent as a host report (the reply, honestly truncated, or the outcome alone), unless the person stopped reporting. Reports arrive only as queued `side-task-report` turns, recorded as outside content when the parent takes them, coalesced up to a batch bound, surviving restart, never duplicated or dropped.
- A report waits while its parent could still take it. A gone parent's are refused with the reason journaled; a purge erases them, and a deleted child's are never delivered.

Status: Built. Detail: [Architecture: Native harness](../architecture.md#native-harness).

### Harness tool egress rules

A harness command on an approval-gated or auto-accept-edits Code thread reaches exactly the destinations a person allowed for that thread, through a per-launch host proxy.

- `proxied` never falls back to open network. A launch whose listener cannot bind, or whose start or summary cannot be journaled, never runs or reports unavailable.
- The proxy refuses any destination resolving to a private address under every rule. A rule cannot name an IP literal or a single-label name.
- Rules expire, a child uses its parent's live rules, and rules never leave the host.
- Rules arise only from answering a network-access approval, never from a model call, tool result or repository configuration. Project rules need a person at a local window.
- Taint suspends standing rules, and bytes received from outside taint the thread. Learn mode turns refusals into proposals that grant nothing.
- Runtimes that run their own tools in-process get their own proxy, decided by provider endpoints, Project rules and safe networks.
- With Network limits on, Octant Shield answers a per-call network prompt on an untainted Auto thread with one call rule for that launch.

Status: Built. Since: 2026-10-13. Detail: [Architecture: Harness tool egress rules](../architecture.md#harness-tool-egress-rules).

## Extensions

### Activation ladder and executable components

A component is active only when its package is installed, its source trusted, the master and component switches on, compatibility passes and policy allows. Any other state contributes nothing.

- Install, trust and enable are three steps, each journaled. `enable` without `trust` is refused, a refused trust turns nothing on, a switch never lifts a hold for review or admission, and Trust and Turn on stay separate commands.
- For a new install, one confirmation may cover install and trust, or install, trust and turning on a plugin or connector and each of its components (maintainer decision, 2026-11-12). It also covers a skill or server the person adds directly; Add only keeps the steps apart (maintainer decision, 2026-11-13).
- The host verifies a signature on every package kind that can carry one (Agent Plugin, Codex plugin, language server, debug adapter, Canvas export target, provider driver), refuses one that does not verify, pins the key at first trust, and holds a version the pin did not sign (maintainer decision, 2026-11-13). A standalone skill and a server the person adds carry no signature.
- An update signed by the same key keeps trust and remembered tool approvals; a new or missing key asks again (maintainer decision, 2026-11-12).
- An unsigned plugin's update from the source the person trusted (same folder, catalog entry or npm package) keeps trust and remembered approvals, shows an Updated notice saying what changed and when, and rolls back in one press, trusted and on as before; a roll back ends the remembered approvals (maintainer decision, 2026-11-13). Accepted risk: whoever controls that source can publish an update that runs under approvals already given; the notice, the roll back and the asks no grant spares bound it.
- An untrusted package, a wider update, a signed package and a provider driver ask again. The first signed update of a package trusted unsigned loses trust and its switch until the person trusts it with the key shown, which pins that key.
- A selection carries the catalog epoch it was resolved under; the host re-resolves it on send, replay, resume and handoff and blocks any difference as stale.
- Executable components stay quarantined until reviewed, then run in supervised sandboxed processes.
- A structured mention cannot install, trust, enable or elevate anything.
- A curated workspace preset may name skills, and naming is all it does; the host reports each named skill's state (in use, installed but not enabled, not installed). _Here only._
- Marketplace network access happens only on user action; opening Settings fetches no catalog.
- `octant plugin create` writes a starter Agent Plugins folder and `octant plugin check` reads one by the host's folder-import rules and shared loader. Neither installs, trusts, enables or reaches the network (2026-11-07).

Not built yet:

- Executable components on Linux and Windows: only macOS starts them, because their confinement there is not built.

Status: Partly built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Skill discovery and Project code denial

Octant's own skill index discovers skills only from the closed Project allow-list, the user-global folder, and provider and added folders the person turns on, never from the home folder's tool-configuration folder on its own. A key provider loads its own skills natively ([Key providers run as themselves](#key-providers-run-as-themselves)).

- A discovered skill is never trusted or active because of where it was found.
- When two skills that are on share a name and a thread, the Project's copy wins over a shared one, with a notice, unless the person turned the shared one on later by hand (maintainer request, 2026-11-12). Any other same-named pair is off until the person chooses.
- Outside Strict, adding a Project trusts it for every runtime ([Adding a Project trusts it for every agent](#adding-a-project-trusts-it-for-every-agent)).
- Under Strict, a runtime that loads Project skills, MCP servers, hooks or plugins by itself loads them only in a Project the person allowed for it; elsewhere it runs with a proven switch or is denied the file in the OS profile. Instruction files stay readable.
- Under Strict, Gemini CLI and Qwen Code are refused at start in a Project holding their settings entries that the person has not allowed, because their loaders fail on a denied file; an allowed Project starts them with those entries readable. Outside Strict they start in every Project and mode with the entries readable, unless the person turned their setup off (maintainer decision, 2026-11-21).
- Claude Code's and Codex's own skill folders, turned on one by one, and folders added in Settings are discoverable roots under the same ladder. Octant adds none itself.
- Desktop offers a window-owned purpose receipt folder picker beside manual paths; it records only the skill-folder setting and grants no trust or enablement. Chosen-root diagnostics explain zero discovery.
- Bounded watching of selected roots and packages picks up later creation and changes. Reconciling a committed setting needs no mounted Settings view, and host teardown prevents a late watcher restart.

Status: Built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### MCP tool approvals

Below Full access every MCP tool call waits for an approval in the turn's window unless a remembered approval covers it. At Full access a trusted, enabled server's tool runs without asking, on a thread that has taken in outside content too (maintainer request, 2026-11-12).

- At Full access a Work or Code thread runs an MCP tool unasked, with or without a window, and records no grant. A Plan turn on it still asks.
- No host-wide count limits waiting approvals (maintainer decision, 2026-11-21): a call waits for its answer before its turn makes the next, so running turns bound them.
- An approval has no expiry. It ends only with an answer, its turn stopping, its thread's archive or its window's revocation. Needs you lists it, with its input, to whoever may answer, and each new one is told to the paired phones (maintainer decision, 2026-11-13).
- A device the host's own person paired answers any prompt on a thread it may drive. Any other device session (a hub-introduced device, an agent grant) answers only prompts its own turns raised (maintainer request, 2026-11-12).
- A turn the host runs with no window (a routine, a goal loop) waits in Needs you instead of being refused (maintainer request, 2026-11-12). Its prompt goes to every local window that may drive the thread (any local window for Chat) and the person's paired devices, and any one answers it once. A windowless Chat turn (a usage-limit retry) runs its calls under the host's scope, so none is refused for want of a scope.
- Below Full access a server asks once: the first approval of any tool of an MCP or connector server is kept for all its tools in the Project, bound to the package version and digest (maintainer decision, 2026-11-12). The card can narrow it to the one tool, and a tool's approval is bound to a digest of its listing, so a changed listing asks again. A Chat thread outside a Project keeps the answer for the account (maintainer request, 2026-11-12).
- A grant grows only through a person's answer: a local window answering its own turn's prompt, or a device the host's own person paired answering a prompt whose thread still stands in its Project, journaled as the device (maintainer decision, 2026-11-12). A Plan turn asks for every call. A host-owned turn's or hub-introduced device's turn's prompt covers one call and records nothing.
- The mobile approval card shows the choices the host says an approval covers, as the web card does (maintainer decision, 2026-11-13).
- A package update signed by the same key keeps trust and remembered approvals, for a tool or a whole server, for every signable package kind, MCP plugins included. A new or missing key or an update that widens what the package may do asks again (maintainer decision, 2026-11-12).
- An unsigned update from the trusted source keeps remembered approvals (tool, server or marked thread); any other unsigned update asks again (maintainer decision, 2026-11-13).
- Under Strict, below Full access, after a thread takes in outside content, a remembered grant holds for a local stdio server, and a network server asks once per thread and server, then runs for the rest of that thread (maintainer decision, 2026-11-12). That answer covers no other thread, ends on uninstall, rollback or withdrawn trust, is journaled so a restart does not ask again, and is not listed among remembered approvals (maintainer decision, 2026-11-13). Outside Strict the mark adds no ask ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).
- Streamable HTTP sends POST and session cleanup only to the configured address and follows no redirect.
- A server's JSON-RPC application error is bounded, watched, framed and recorded as outside content before the provider reads it. Host validation, transport, authentication, cancellation and timeout errors do not taint the thread.
- A tool with an invalid input schema, a schema unsafe for bounded synchronous validation, an unsupported advertised dialect or a duplicated name is not offered. Draft-07, 2019-09 and 2020-12 use their own validator; no advertised dialect means 2020-12. Each call must satisfy the listed schema before approval, a remembered grant, credential resolution or dispatch, and validation never changes its arguments.
- Uninstall, withdrawn trust and rollback revoke grants; installing again restores nothing.

Not built yet:

- None recorded: the entry names nothing unbuilt; whether it is Built is a question for the maintainer.

Status: Partly built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Connectors and user-added servers

A person connects an MCP server from Settings, in a local window or on a device the host's own person paired (maintainer decision, 2026-11-12). It becomes an ordinary package, installed, trusted and enabled as one act, under the same ladder and approvals.

- A secret value goes to the credential broker, never into the package. Listing servers found on the computer is read-only; nothing is imported until the person clicks that item.
- The Connectors view is a bundled first-party catalog that fetches nothing to render, and the host accepts a connector id only at that entry's own address. An entry joins after a bare request answers 401 with resource metadata and its authorization server publishes PKCE S256 and dynamic client registration (Doop, 2026-11-01; Dropbox, monday.com, ClickUp, Miro, GitLab, Buildkite, Amplitude, Calendly, Pipedrive and Klaviyo, 2026-11-07). Each entry names the vendor's setup page and search keywords, shown or matched in Connectors and the Library.
- `bun run connectors:probe` re-checks each address against its auth kind and each setup page, weekly and on demand in CI, never in pull-request checks or the app. A failing entry is fixed or removed in the catalog, not patched in the UI. Google's preview servers answer `initialize` without a credential and ask at the tool call, so the probe accepts that for a sign-in entry whose well-known resource metadata holds up, and says so.
- The Library, first in Settings › Skills & Extensions, is one searchable list over connectors, plugins, skills and MCP servers, built only from the bundled list, the installed snapshot, results already searched and the local look at Claude Code and Codex. It never reaches the network, so it ignores the Marketplace fetches switch. Each item shows source, provider, state on the install, trust, on ladder, what it can do, and an authority level from its declared capabilities. Rationale: a person judging an extension needs state and cost in one place, and a combined view must not widen what any install flow may do.
- Trust and turning on are separate one-click commands. A generated MCP server added directly installs, trusts and turns on as one confirmed act through the one-step install; Add only leaves trust and the switch to the person (maintainer decision, 2026-11-13).
- The Library groups by installed state, then a fixed hand-picked Featured group and the catalog's categories, each closed until opened and open during a search or filter. A connected connector stays in Featured showing its state, and also under Installed. It finishes the job in place: Connect… opens the detail (the one confirming press, key field and sign-in, over one function shared with Connectors); a Marketplace plugin offers Review, then Install, trust and turn on under one confirmation, or Install only. Reading a plugin stays under the Marketplace fetches switch, and every check stays on the server.
- Each item is one compact row of one height (mark, name, source, authority dots, and its state or next step at the trailing edge), in two columns on a wide card with the source left to the detail. A row says its next step, not a repeated state. The name opens the detail, which carries a skill's own description, or no line when the host gives none. More than ten uninstalled items show the first eight with "Show all N"; everything installed is always drawn, and items awaiting a decision (blocked, awaiting trust, not connecting) lead. Bundled CC0 Simple Icons marks show where a connector has one (source recorded beside each, noticed in the logos licence file); the rest keep a two-letter tile.
- The shared Settings titlebar has no bottom rule, because the strip it bounded is empty and read as a bar.
- Long Settings pages draw long lists as compact rows and fold reference sections (maintainer request, 2026-11-11). A compact row is one line: the name (opening the row's detail: paths, permissions, secondary actions), a short state in the meta ink, and the one main control trailing. Only reference or empty sections fold; the label is then a button with `aria-expanded`, and the closed line says what it holds. What is on, trusted, protected or allowed stays readable closed, and a section holding a remembered approval, refusal or removed protection opens by itself. Search and deep links open the fold holding their row and focus it. Used in Skills & Extensions › Library and in Permissions (Protected files, Servers, Remembered websites and tool approvals, Safe networks, Bind a folder).
- Installed opens with Server connections: each MCP server and connector with transport, state (Off, Needs sign-in, Connected, Connecting, Not connecting, Blocked, Ready), last error sentence and last-seen time, composed on the host from kept facts; reading it never connects, signs in or lists tools. Connectors rows and Library cards flag a connected server that needs attention. Signed out counts as Needs sign-in only for a catalog connector that signs in, and the listing reads sign-in status without polling a pending attempt.
- Reconnect, from a local window or a device the host's own person paired (maintainer decision, 2026-11-12), clears the component's sessions and failures in every task scope so the next authorized task connects fresh; it connects nothing and never replays a failed call. Other device sessions read the states only. Rationale: a Settings connect would discover tools outside a task's authority.
- A thread whose next turn would get a server that needs sign-in shows a notice with the same sign-in control. The host names the servers from the Project's pins and the next turn's selections, through the turn's activation checks and without connecting; only a local window or a device the host's own person paired may ask ([Thread view: Server sign-in](thread-view.md#server-sign-in)).
- A Project pin offers a plugin on every turn in a Project but grants nothing; calls still ask per [MCP tool approvals](#mcp-tool-approvals).
- HTTP MCP session loss removes stale tools and waits for a later authoritative task reconciliation to list a replacement. A failed call is never replayed, since a lost response may follow a completed write. Application refusals keep healthy sessions, withdrawn authority blocks reconnection, a late old call cannot evict the replacement, and transport recovery keeps the task and draft.
- A fixed-catalogue provider reports new or changed definitions through the provider SDK, from persisted per-definition SHA-256 fingerprints. Chat and Work refuse a changed-catalogue draft before accepting it; Code parks its unsent turn and restores the draft. Continue with updated tools sends it in a fresh session through the bounded, journaled conversation text handoff: native session, history and tool authority kept, omissions disclosed, hidden reasoning and tool activity not carried, failed calls never replayed. Withdrawn-only tools keep the session and host refusal policy; legacy cursors need explicit continuation before nonempty tools.
- Hosted-server sign-in uses the protocol's authorization flow with PKCE, and the grant lives in the broker. A person-paired device starts and finishes one as a local window does (maintainer decision, 2026-11-12; [Connector sign-in finished from a paired device](#connector-sign-in-finished-from-a-paired-device)).
- Application registration is separate from consent. The local sign-in RPC accepts pre-registered clients or an advertised HTTPS metadata-document identity, with an exact loopback callback kept across restart; dynamic public registration and GitHub PAT access remain. Confidential clients reference a broker-held secret bound to the configured token endpoint, and no shared secret ships. Legacy registrations are not silently rewritten.
- Client setup prepares the copyable callback, saves public or metadata identities without consent, links a confidential client to an item in an already linked secret store, and selects the only advertised confidential method. Saving rechecks the shown issuer, resource, token endpoint and callback and refuses changed bindings. Paired devices cannot prepare or save setup, and setup cannot change while a component of the same resource awaits consent.
- Secret references are durably reserved before pointing; unknown point or deletion outcomes stay reserved across restart under a 256-reference budget. Point and retirement stages each wait at most ten seconds, with quiescent operator recovery. Broker waits never hold the shared commit queue.
- Broker status reads are bounded at ten seconds and the renderer's sign-in fetch at thirty. Unknown status keeps pending ownership for explicit Check or Cancel; polling never disables cancellation; expired or older reads cannot restore a late sign-in state; an unknown save is checked by reopening setup. A protected cancellation seam binds a pending attempt to its actor and descriptor, closes listeners, and prevents a late exchange or orphan grant; unavailable cleanup keeps ownership in broker memory for retry, with no crash-recovery claim.
- Uninstalling an owned generated server confirms pending cancellation before removal, behind a scoped Begin gate released in `finally`, with no early folder deletion or grant revocation. It refuses while a completed sign-out is pending, and its gate blocks a new sign-out during removal.
- Sign-out keeps a durable unusable cleanup owner on broker failure or a ten-second timeout, offers Finish signing out, and keeps the registration. Grant replacement, sign-out intent and proven revocation retire the authentication generation and cached tool index at once, with a ten-second bounded close. Per-call, late-initialize and session and connection fences reject stale completion without replay; a later task reconciliation discovers tools with current authentication.
- Approved calls on host-owned OAuth sessions do bounded expiry-aware access and refresh against the captured grant owner; changed authorization retires tools before dispatch; a 401 marks only that owner for refresh and never replays the call. Completed cleanup denies access and refresh, joins an in-flight refresh or write, then deletes. Application edits never replace the consented grant binding.
- The broker owns both exact loopback families at its fixed port and refuses partial or busy binds.
- Atlassian v2 and Airtable reuse public PKCE and DCR. Airtable also has a scoped PAT entry and an exact transport-to-origin resource alias; no generic resource equality is weakened. HubSpot and Box use their exact vendor endpoints through registered-client setup: the person (for Box, after an admin enables the Box MCP Server integration) links the client secret before consent, with PKCE S256 and the advertised client authentication, and no scopes, shared secret or hosted service invented. Vendor consent, permissions and admin restrictions stay authoritative, and setup is not authenticated acceptance ([Architecture: Connectors catalog](../architecture.md#extensions-and-skills)).
- Paper has a local Library setup through the generated MCP package route, using its documented loopback HTTP fallback without widening stdio confinement or claiming CLI compatibility. The host validates its exact address and package identity; installing never claims Desktop or file readiness.
- Slack uses a closed user-token dialect: exact transport, origin resource, issuer and endpoints, advertised `client_secret_post`, only `search:read.public`, Bearer kept on refresh, and an explicit kept localhost callback. Its non-featured entry opens client setup on Connect; list and status reads discover no endpoints and probe no tools. Reported workspace and user IDs and permissions are bounded last-reported facts (Not reported when omitted); a known identity change or missing public-search permission requires reconnect without the old bearer.
- The GitHub OAuth App read entry keeps the PAT path and separate package ownership at the same URL. It requires person-owned `client_secret_post` credentials, S256, a kept 127.0.0.1 callback with issuer response, and only `read:user` and `offline_access`. Every exchange requires expiry and new refresh material, then a bounded broker `/user` read; only the numeric user ID and scopes are kept. Identity change, wrong scope or failed rotation identity requires reconnect without the old bearer. Private repository, email, write and App installation authority are excluded.
- The GitHub repositories preset requests `repo`, `read:user` and `offline_access`, disclosing broad public and private read and write and organization reach before Save. Only a host-owned reserved receipt for the generated source, configuration and package selects it, rechecked inside the commit queue. Its profile persists through both broker projections, refresh and pre-bearer comparison; absence keeps the read profile. A renewed broader token on the read profile requires reconnect. No grant is silently upgraded; fine-grained App installations and `public_repo`-only setup stay optional.
- Gmail, Google Drive and Google Calendar are three separate read-only preview connections to Google's MCP endpoints, each consenting only to its own read scopes; none can send, draft, edit, share, delete or reply. They use the person's own Desktop app public client with PKCE S256, a kept loopback callback and `access_type=offline`, with no client secret, hosted service or second token store. A missing or revoked refresh grant asks for sign-in again and keeps the task and draft.
- A host-private GitHub Actions source reader binds the registered repository OAuth component, grant, app, numeric account and repository IDs, and each read also needs a host-supplied current effective-component witness; missing, disabled or untrusted authority refuses before any API read, and work retired by activation cannot publish. Only the broker builds its fixed read-only requests, bounded, with owner and generation checks, and with no arbitrary URL, token output or `gh` or PAT fallback. A 403 or 429 rate limit stays retryable; known permission, account or repository changes refuse. Observed completed attempts are metadata, not proof of rerun history. The manual CI follow-up starts no work.
- A person may add or remove an MCP server, a plugin marketplace or a plugin on one Claude Code or Codex account from Library › Claude and Codex. Octant runs that program's own commands against the account's folder and never writes those files. Rationale: the provider's commands are the supported way to change its files, and one confirmed shown command keeps the person in charge.
- The exact command is shown first (with the folder variable and a `<secret>` placeholder) and runs once, as shown, from the window that asked, only if the account has not changed, within the person's time to run a shown command (default ten minutes, up to a day in Settings › Limits; maintainer decision, 2026-11-21).
- It is refused on a paired device and unreachable to an agent. The program starts with an argument list and no shell, every value is validated, and Claude Code commands name the user scope.
- A secret is never an argument: Claude Code's OAuth client secret goes through the broker into the child's environment, Codex takes only a bearer-token variable's name, and a plain value that looks like a key is refused on a best-effort check. A held secret is deleted on cancel or expiry.
- Each change is journaled (`provider.tooling-applied@1`) with provider, account, command kind, name and outcome, never a value or secret. A program version without a command says so, and Octant offers nothing for it.
- A tool added this way reaches an Octant thread only while the account runs as itself or at Full access; the panel says so and links to that switch.

Not built yet:

- Google's Gmail, Drive and Calendar for everyone: the enrolled-account live check is owed, public distribution waits for Google's permission or general availability, and scope verification and any restricted-data review are separate gates.
- Live vendor acceptance of the shared sign-in foundation, public-none compatibility, and GitHub MCP tool support: not yet run.
- Automatic routine occurrences, durable catch-up, gap and loop composition, and live acceptance in the GitHub Actions reader: not built in that reader.

Status: Partly built. Since: 2026-10-20 (Connectors); 2026-11-01 (Claude and Codex tools). Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Computer use and device tools

Core capabilities (browser and computer use, tests, Apple validation, approvals, memory, subagents) are app-managed and provider-neutral; none depends on an optional extension.

- Outside Strict, Computer use at Full access needs no first-action approval (maintainer decision, 2026-11-19).
- Below Full access, and under Strict, it asks at the first action in each application, once per thread, with no expiry. The card offers **Remember for this Project**, journaled per Project and application with actor and timestamp and forgettable in Settings › Computer use (maintainer request, 2026-11-12).
- A file an agent sends into the thread's desktop on this machine does not ask at Full access, even on a thread that has read outside content. Below Full access it asks once per thread, journaled for the thread (maintainer decision, 2026-11-13). Its card's **Remember for this Project** is journaled per Project with actor and timestamp, covers the Project's threads' files into desktops on this machine and never a cloud desktop, and is forgettable in Settings › Computer use.
- Under Strict an answer or Project remember from before the thread read outside content does not cover it afterwards, for first actions and files; outside Strict it keeps covering the thread (maintainer decision, 2026-11-22).
- Computer use treats application content as untrusted, fails closed if evidence recording fails, and is refused in Plan.
- A directly paired person can watch and take control of the host Mac's primary display from an active Code thread; the [paired Mac display](disposable-desktops.md#paired-mac-display) defines handoff and lifetime.
- A device the host's own person paired lists and stops every Computer use session on the host, recorded as the person's stop from that device; a hub-introduced device is refused (maintainer decision, 2026-11-16; [Paired devices act as the person](#paired-devices-act-as-the-person)).
- Onboarding and Settings share optional setup with separate macOS permission actions and a local, explicitly approved capture-and-click test of a temporary owned window. Verification expires on permission loss, disablement or driver restart. Existing standalone installations stay untouched, and agent control of Octant stays refused.
- The computer-use driver is a bundled, pinned, publisher-verified copy accepted on the same contract minor. It updates itself daily unless the person turned automatic updates off; a store saved while updates were off by default reads as on (maintainer decision, 2026-11-26). The check reads a release's contract before downloading and says when upstream's newest needs a newer Octant; a downloaded driver runs only while newer than the bundled one; a weekly job moves the pin on one draft pull request.
- Driver startup verifies the driver-reported host bundle identity and protocol and binary versions; a failed check refuses admission. _Here only._
- A screenshot alone never authorizes input; revalidation must resolve that exact window first. Interrupted work cancels pending approval and input. _Here only._
- Managed device tools are pinned, integrity-verified releases with an allowlisted environment and a device-scoped native sandbox; auto-update is off by default and no upstream installer script runs. The sandbox grants device state, SDK and runtime files, private transient state and needed native services, never a Project or provider account. macOS limits networking to loopback; Linux keeps the host network for its shared adb server and browser listeners. A missing sandbox keeps the native device fallback rather than launching the npm tool unconfined ([Managed device tools](device-workbench.md#managed-device-tools)).

Not built yet:

- None recorded: the entry names nothing unbuilt; whether it is Built is a question for the maintainer.

Status: Partly built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Canvas export

A Canvas export reaches a destination only after the person approves a card showing the exact payload and destination.

- A call without confirmation never overwrites a file; it writes a numbered copy beside it.
- The rendered document passes a secret-and-path filter; one that fails is refused, not published.
- Saving or copying the HTML file is not a destination: no approval, nothing journaled, and the file loads nothing.
- An approved export journals its intent before calling the destination; an intent that cannot be journaled sends nothing. Startup settles an intent with no outcome as unconfirmed, never delivered or failed, and never resends it. The export panel says so until a later recorded export to that destination, or the person's journaled Dismiss from a local window, retires it; a paired device cannot dismiss it.
- In-app sharing needs no intent: a share is one journal append that sends nothing off the host.
- Local destination packages declare one module and exact HTTPS origins. Examples bundle the public SDK; workers resolve no SDK from the host checkout and inherit no host endpoint configuration or keys. A supervised worker runs the portable protocol, and only an approved export gets bounded mediated network requests. Description is offline and bounded. Changed activation or package identity invalidates approval.
- Linux and Windows run no destination worker until their native confinement is verified.

Status: Built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Composer window capture

In the macOS desktop app the person can attach a picture of one open window from the composer. It is the person's action, never an agent tool.

- Listing reads window titles only, no pixels. The screen-recording permission is asked only after the composer explains it and the person continues.
- A capture reads exactly the one listed window, in a hidden network-free page; a window that closed is reported, never retargeted.
- The picture takes the ordinary image attachment path and its authority checks. The shell keeps no copy and sends no telemetry.
- Web and phone clients do not offer it; other desktop platforms omit it until their permission model is designed.

Status: Built. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Plugin boundaries

New providers and tools reach the system through the published SDK, API and host seams, taking no shortcut a third-party plugin could not take.

- Plugin ports carry no raw filesystem, shell or credential handles; plugin state holds only opaque references.
- Pull request reviewers use a Code-only seam (`pull-request-reviewer` in `@octant/plugin-api/pull-request-reviewer` and `@octant/plugin-host/pull-request-reviewers`), with a pure activation gate, a host registry and the bundled second-model reviewer. A reviewer is offered only while installed, trusted and enabled, with colliding ids withheld; stored external reviewer packages stay host-prohibited until a confined worker class exists.
- The reviewer's scoped port checks effectiveness and PR head currency before and after every await, keeps model review turns at Plan's read-only gate with no silent fallback, and verifies run and finding ownership. Forge publication is at most one summary comment behind a default-off opt-in (no formal forge reviews), and handing blocking findings back to the worker is behind another.
- Installed Code tools may declare bounded credential-operation or saved-command ids in `extensions.octant.codeTools`. The public turn-scoped port exposes declaration-scoped names and request or run-saved actions, never commands, paths, credentials or host services. Selection and the ladder stay separate from person approval, and changed package, catalog or task authority invalidates pending use before effects. The core credential family uses the same port with its own name, help, schema and policy; its command presentation stays private to the server adapter.
- GitHub, thread boards and Zen are bundled first-party plugins, each on by default and switchable (maintainer decision, 2026-11-07). Usage, diagnostics, Navigator, the automations UI, browser and computer use, agent hierarchy, remote and mobile access, the Apple workbench, and the marketplace and plugin registry are core, not extraction candidates.
- Host media tools (`octant_look`, `octant_narrate`, `octant_transcribe`, `octant_create_image`) compose through the public media tool port (`@octant/plugin-api/media-tools`, `@octant/plugin-host/media-tools`). Path confinement, raw bytes and magic-byte sniffing, provider credentials and routing, paid offers, concurrency gates, outside-content tainting (fail-closed for third-party plugins, their error results included), and mode, window and thread admission stay host-owned in the server adapter.
- First-party manifests have one definition shared by server and renderer.
- A bundled plugin's switch is journaled on its own aggregate with a rebuildable projection; a plugin nobody switched is on. The extension snapshot holds one host-written row per switchable bundled plugin, changed only by its switch under the expected-version rule and local-window authority; any other package command on it is refused.
- Bundled plugins are left out of a scope's effective state, so they are never addressed, selected, pinned or given tools, and the Library does not list them.
- Disabling a plugin keeps its data and selections and drains running executables. Deleting credentials needs its own confirmation.
- Each feature follows its switch on host and renderer: GitHub's account, repository, clone, issue, read-tool and Gist surfaces; the Work and Code boards and every way to open them; Zen's routes, tool and window. Git and pull requests stay core, and board data and the tools reading it stay available.

Not built yet:

- Loading installed third-party media tool packages in `server.ts`: deferred until media-tool manifest contributions are enabled.

Status: Built. Since: 2026-11-07. Detail: [Architecture: Plugin boundaries and remaining extraction](../architecture.md#plugin-boundaries-and-remaining-extraction).

### Themes as plugin contributions

A plugin may contribute a theme as data only, validated by `@octant/theme` before it is listed (maintainer decision, 2026-11-14).

- A contribution is a semantic theme schema document with no renderer code, stylesheet, script or asset loader; one that fails validation is refused whole.
- The one runtime theme authority applies it as it applies a built-in preset. Installation, trust and enablement stay separate.
- The server checks colour overrides against the selected theme, an effective plugin theme included, and against the default when that plugin is off.
- A plugin may contribute a character ground as a data-only `ground` component (a set, and optionally density, speed and pattern), listed in the Customize starter menu only while effective; a pick is copied into the person's ground (maintainer request, 2026-11-18).
- A contributed theme is listed only while its plugin is installed, trusted and enabled. Switching the plugin off removes it; a stored choice of it draws the default and is kept for the plugin's return.

Status: Built. Since: 2026-11-14. Detail: [Architecture: Plugin boundaries](../architecture.md#plugin-boundaries-and-remaining-extraction).

## Authority and approvals

### Local authority

Nothing reachable on loopback grants window authority by itself. Local clients present a secret only the host's OS user can read.

- The desktop app and the CLI present the desktop bridge secret from the owner-only runtime directory. A browser presents a one-time launch token minted with it and bound to its origin.
- Another OS user, an ssh port forward, or a proxy rewriting `Host` reaches the listener but gets no capability.
- Paired clients keep their own device-session path; a device the host's own person paired holds what a local window holds ([Paired devices act as the person](#paired-devices-act-as-the-person)).
- On a host that knows a device only through the hub's roster, only an owner device the person marked holds window authority, for a signed request or a short administration window ([Hub and spokes: owner devices](hub-and-spokes.md#owner-devices)). Its real-device check is a maintainer live check still owed.

Status: Built. Detail: [Architecture: Security and authority, Local authority needs the bridge secret](../architecture.md#security-and-authority).

### Server-side tool-call policy

A model's tool call is a petition, not a grant. The server resolves every call before anything runs, and tool results are data, never instructions.

- Every call resolves through the closed tool catalog, the mode's capability matrix, the thread's elevation state and the actor's authority.
- A Code turn acts on the checkout it started on: Octant's tools and the provider's built-ins use the captured root, confinement and identity.
- App-managed tools reaching Project-scoped services (a window-held terminal, the planner board, a sibling transcript) follow the window's live binding when the call runs.
- Octant's own tools re-check the live execution policy on every call, so a thread put in Plan mid-turn refuses writes and launches next call.
- An allowed native-harness approval is authorized again when it resolves, and runs only if authority, posture and taint still allow it.
- A provider's built-in tools keep their launch posture; a lowered grant reaches them next turn or when the person stops the turn. Answering their requests does not reread the grant.

Status: Built. Detail: [Architecture: Security and authority, Server-side tool-call policy](../architecture.md#security-and-authority).

### Approval categories and postures

Approvals are independent categories, and grants are scoped and journaled. Plan is read-only at every level.

- Categories: project file writes, shell commands, network access, external application control, destructive actions, credential access, access outside the bound root, and privilege or sandbox changes. Auto-accept-edits waives only project file writes.
- The host sets a Work or Code thread's access, never the renderer. Project folders are open by default; access outside them asks below Full access, is allowed at Full access, and is refused in Plan (maintainer decision, 2026-11-14).
- Full access is chosen as [The Full access rule](#the-full-access-rule) says, journaled with the device as actor when a device chose it. A device known only through the hub's roster, an owner device included, may lower a thread but never raise one to or start one at Full access, with no per-command unlock; it raises only through owner posture recovery (maintainer decision, 2026-11-13; [Hub failover and owner devices](#hub-failover-and-owner-devices)).
- An agent grant reaches Full access only when the person chose that level for it. There is no session-only Full access (maintainer request, 2026-11-12). The terminal CLI sends Full access exactly when the Project remembers it.
- A pending approval records the posture it was asked under (mode, who answers, the Full access sandbox, grant duration, the coordinator gate). An allow after that posture changed is refused undelivered ("This thread's permissions changed since this was asked, so it asks again.") and stays pending; a denial is always delivered. This covers Code provider and app-managed tool approvals, Work requests and native-harness approvals, a child's included.
- A native-harness "always" grant answers only while the thread holds the posture it was granted under. A running Code turn keeps its starting grant persistence: a persistence change alone does not ask again, and the allow covers that one call.
- Every refused answer names its reason, and a delivered one is journaled as `approval-answered`, so a re-read turn no longer offers it.
- A refusal that fails closed on authority names a recovery the person can perform (an action, a restart, elapsed time) where they are. Recovery never widens automatic admission.
- New Code threads start in the mode chosen at first run, changeable in Settings and per Code Project. Work threads take the same levels, host-set.

Not built yet:

- Unnamed: the record that set Partly built names no unbuilt item, and the code check found none; the status stays until the maintainer answers.

Status: Partly built. Detail: [Architecture: Security and authority, Approvals](../architecture.md#security-and-authority).

### Provider auto-review

A thread's `autoApprove` flag says who answers a prompt, not what is permitted.

- Approval-gated and auto-accept-edits delegate to the provider's reviewer when `autoApprove` is set and the provider reports `harnessAutoReview: "supported"`. Taint and capability clamp delegation off; unknown taint counts as ingested.
- Categories, sandbox, egress and credential reach stay Octant's whatever the reviewer answers. An auto-accept-edits waiver outranks delegation.
- On one runtime, approval-gated honours grants the person saved there for the same repository; Octant's denies still win, and Octant never writes such a grant.
- Octant Shield answers these prompts on a Code thread, or a Work thread where it reviews, on every runtime that routes them to Octant.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Approvals](../architecture.md#security-and-authority).

### Goal-loop round authority

A Work goal-loop round runs as the host, under the per-process host scope a routine runs under, never through a window.

- A round needs no window. Its turn is journaled as the host's `system` actor, and the Work turn path rechecks the thread, its Work Project and the round's authority.
- A loop pauses while Work is off, and a round's turn rechecks the switch at admission.
- A round with no checkpoint runs only at approval-gated authority; under auto-accept-edits or Plan it pauses as `checkpoint-unavailable`.
- A round's approval is offered, like a routine's, to the local windows bound to its Project.

Status: Built. Detail: [Architecture: Security and authority, Approvals](../architecture.md#security-and-authority).

### Pending requests, fleet activity and turn decisions

Reads that gather what needs the person add no authority. Each mode lists only what its answer command would admit for that window.

- Pending requests list approvals, questions and turn decisions oldest first (at most 128); fleet activity lists threads needing the person and running threads (at most 64). Both answer a local window or a device the host's own person paired, under its own scope, and refuse every other session (maintainer decision, 2026-11-12). A device sees a waiting subagent only where the harness session route would let it answer.
- Pending requests also list every other waiting ask, in a separate optional field older clients ignore: MCP and connector tool approvals, memory and routine proposals, image offers, Browser approvals and the sign-in card, host-run turns' included (maintainer decision, 2026-11-13). Each names its thread and what is asked. A row is answerable in place only if it holds everything its card shows; none does today, so each opens its thread. A Browser row names the profile, and whether a terminal rather than the agent asks.
- The Inbox puts memory and routine proposals under Decide and other asks under Stuck, one count per thread (maintainer request, 2026-11-13). Paired phones are notified through the sealed push path and list every ask; the board and palette list requests only.
- A child's or lead's approval or question shows as a row without options or answer handle; it is answered on the thread's card.
- A Work or Code turn needing a choice ends with one `octant-decision` block (one ask, one to four options, one recommended); Chat is not asked. The host derives it from the normalized reply on read, never journals it, and takes the answer as the next turn; an option performs no host action.

Status: Built. Detail: [Architecture: Security and authority, Pending requests across modes](../architecture.md#security-and-authority).

### Desktop authority confirmations

A desktop authority confirmation is decided only in an isolated approval view owned by the main process.

- The view is sandboxed with a restrictive content policy, no external resources and no ordinary host bridge; only that live view decides its challenge. _Here only._
- The ordinary renderer may only report geometry, palette, a covering overlay, or cancel. Cancel is the default, and expiry, teardown or a late decision fails closed. Under an overlay the view leaves and refuses Allow. Escape cancels; focus starts on Cancel. _Here only._
- A window holds at most eight pending confirmations per composer owner, and navigation never extends the five-minute expiry. _Here only._

Status: Built. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Octant's own limits become settings

Octant's fixed limits that protect no hard line are settings with their former values as defaults, apply only under Strict, or are gone (maintainer decision, 2026-11-16). This entry owns which limits apply only under Strict.

Settings at every level, in Settings › Limits, journaled with the host's settings, changed at a local window or a device the host's own person paired, read where each applies (`ShellSettings`, `packages/contracts/src/shell.ts`):

- Agent wake-ups recur as often as every minute. Waiting wake-ups per thread (8) and missed-run catch-up (on; maintainer decision, 2026-11-25).
- Message wakes for a thread outside a coordinator: 30 an hour, 10 rounds. One wake turn at a time holds, as a thread runs one turn at a time.
- Coordinators per Code Project, the planner included (4).
- A pull-request watch's ten wakes and three days; Auto-fix's three attempts per failure.
- A child run's `wait`: 120 seconds, up to an hour.
- Octant Shield's brakes: 3 denials in a row, 20 in a thread. A follow-up's lateness (24 hours, up to 30 days). A shown provider command's run window (ten minutes, up to a day) (maintainer decision, 2026-11-21).
- "Start agent-created routines active at Full access" (on): a routine an agent suggests at Full access starts enabled; off, paused (maintainer decision, 2026-11-25).

Only under Strict, as settings with these defaults; no limit outside Strict (maintainer decision, 2026-11-19):

- A turn's three thread messages (`threadMessagesPerTurn`, read by `ThreadDialogueService`).
- A turn's eight sibling-thread reads and four waits (`siblingThreadReadsPerTurn`, `siblingThreadWaitsPerTurn`, judged by `decideSiblingThreadCall`).
- A Browser wait's 10 minutes, up to an hour (`browserWaitLimitMinutes`, judged by `decideBrowserWaitLimit`).
- A Work or Code turn's event budget ([Agent task display and tool-call records](#agent-task-display-and-tool-call-records); maintainer decision, 2026-11-25).
- A coordinator's own file, shell and Git actions keep Plan's gate at every level under its thread's Strict, and follow the thread's level outside it (maintainer decision, 2026-11-25).

Other limits:

- A helper's working-time limit is off by default under a Full access parent ([Child agent runs](#child-agent-runs); maintainer decision, 2026-11-25).
- A file routine's 64-run activity window is raised (to 1,024) or cleared on the routine's detail, by the person, journaled with the whole checkpoint so replay rebuilds it. A clear is refused while a held or current run is active.
- Removed, because they protected nothing a person would tune and refused real work (maintainer decision, 2026-11-21): the host-wide cap of 32 waiting MCP tool approvals (running turns bound them) and the 24-hour deadline on a queued thread message (the body store's disk budget bounds them). The harness's own cap stays ([Harness sessions, goals and steering](#harness-sessions-goals-and-steering)).

Status: Built. Since: 2026-11-16. Detail: [Architecture: Security and authority, Octant's own limits become settings](../architecture.md#security-and-authority).

## Sandbox and confinement

### Process confinement

Every launch Octant confines goes through one shared confinement port. A launch that needs confinement and finds no backend fails closed; it never falls back to running unconfined.

- Git, terminals, test runners, extension executables, version reads and provider runtimes launch through the port. Which provider runtimes Octant wraps is in [Provider runtime confinement matrix](#provider-runtime-confinement-matrix); outside Strict, providers run in their own sandbox ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox)), the person's Project terminal runs unconfined ([Project terminals](#project-terminals)), and Windows follows [Windows below Full access](#windows-below-full-access).
- macOS uses deny-default sandbox profiles. Linux uses a namespace sandbox with a private `/tmp`, bound roots, `--unshare-all`, and the network only when egress resolves to allow.
- Every confined Linux launch drops all capabilities and binds `/proc/sys` read-only. Full access's deny-only bind refuses a setuid sandbox helper as incompatible.
- Plan and Chat on Linux also load a seccomp filter that denies process creation, and fail closed as incompatible where it cannot load.
- Path checks alone are never the boundary: confined reads open a handle and verify its identity against what containment resolved.
- Escape probes are in the test suite, and a release gate is that they fail closed. The macOS CI job runs the darwin-gated Seatbelt probes, the Linux client-trust job proves under real Bubblewrap that a provider runtime cannot read the person's credentials, and the packaged Work confinement gate runs in its own macOS workflow on every push that touches it ([Security and authority, Escape probes run where the sandbox ships](../architecture.md#security-and-authority)).
- A Plan launch's temporary directory is its own, removed when it exits or is refused, never the shared temp root; a temp root inside the checkout is refused. _Here only._
- A terminal launch may read metadata, never data, on each exact ancestor of its own shell-state directory, so other threads' histories stay unreadable. _Here only._
- A macOS launch whose egress is allow may reach the system trust daemon and system keychain roots so TLS verifies; user keychains and offline launches stay denied. _Here only._
- An fx launch below Full access on macOS may read only `/Library/Keychains/System.keychain`, emitted after the Keychain and built-in secret-file denials so neither overrides it (a path the person protects still does); no write, no other keychain path or runtime, and `/var/db/SystemKey` stays denied (maintainer decision, 2026-10-31).
- Strict is set apart from the level, inherited thread → Project → Settings. Saved configuration stays inactive outside Strict. Earlier Full-access-only and custom-policy choices keep equivalent legacy behaviour until replaced, and the UI names the difference; Full access Strict choices keep their Full-access-only compatibility fields for older readers, and an explicit Off clears them. Canonical Strict gets fresh immutable admission even without a custom save. Active protection and pending changes stay separate through verified cleanup and a newly admitted run.
- Under Strict, Claude uses its native command sandbox without an incompatible outer wall. Every native escape asks the person, Full access included, bypasses automatic reviewers and remembered answers, and discloses what that command leaves unconfined. Its read boundary discloses public toolchain, loader and resolver reads; its Linux lifetime root handles merged-`/usr` aliases and pins admitted folder objects. Native vendor-runtime tests pair allowed writes with outside denials and unrestricted controls.
- Claude Strict withholds native startup hooks, MCP servers and Project startup code outside its command sandbox, and native web tools when tool networking is filtered. It uses an explicit tool list without REPL or Workflow scripts, worktree startup or unreviewed native executors, and needs a standalone native CLI outside writable roots.
- Linux native launches pin mount-source objects and close inherited descriptors before loading the workload. macOS uses GUI launchd resource coalitions with private durable receipts to revoke and recover detached descendants; enrollment needs the installed helper and a GUI session. OpenCode Linux control uses an authenticated fixed-port bridge with pinned socket identity. Exact loopback service grants use authenticated scoped proxies and disclose the service's own effects.
- Personal terminals own an admitted policy and a scoped network broker; Work terminals also inherit their thread's ceiling. Settings and Project views aggregate running policies and disclose mixed states and pending changes.
- Fixed credential commands borrow the active policy or own a new command scope; Strict confines their recipient at Full access, and consent records that boundary.
- On opted-in custom-kernel Linux hosts, access-time mediation enforces same-filesystem read-only roots, protected paths, credential isolation, aliases and late-created names; a stock-kernel launch refuses those requirements ([Secrets are guarded, softly at Full access](#secrets-are-guarded-softly-at-full-access)). Windows Strict stays unsupported.
- These limitations are not completion evidence. The [security specification](../architecture.md#security-and-authority) owns backend coverage, authority, migration and rollout.

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Version reads and discovery

A version read launches confined, with no root, no home, no network and one throwaway scratch directory.

- Its environment is an allowlist that drops provider credentials and config-home variables, and its process group is killed when the read settles.
- It may exec and fork, because launchers start the real program; the child inherits the profile, and its read roots are the program's install tree, dropping any computed root that is the home folder or an ancestor. _Here only._
- Discovery re-allowances name exact literal nodes, use the weakest verb that works, and form a closed set that rides only the launch needing it.
- Credential-reading status probes use the shared builder with their real account files, a private working directory and no network: Codex its auth and config files; Claude its status and config files and, on macOS, the login Keychain through its security service; Oh My Pi its isolated account directory with tools, skills, extensions and sessions off. Missing confinement refuses the probe; an incomplete check reports unknown, never sign-out.

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Provider runtime confinement matrix

Octant wraps a provider runtime launch only where the process carries exactly one thread's authority and Octant's sandbox applies. The matrix names the exceptions instead of promising a boundary Octant does not draw.

- Outside Strict, a Work or Code launch below Full access outside Plan, with no kept sandbox, no chosen sandbox policy and not a readiness check, runs with no Octant sandbox (`providerHoldsLevelWithoutSandbox`, `packages/domain/src/guardrailPolicy.ts`); the cases per provider are in [Providers run in their own sandbox](#providers-run-in-their-own-sandbox).
- ACP agents, OpenCode, Pi and the app-server runtime are wrapped in Chat, in Plan, under Strict, where the thread kept its sandbox or chose a sandbox policy, and for readiness checks. The app-server lease is keyed by root, mode, level and Strict.
- Claude Code is wrapped in Plan. Outside Plan it runs in its own sandbox, which Octant configures only under Strict, for a kept sandbox, or for a chosen policy in a session that reads none of the person's settings; closing that gap is not a goal.
- A readiness-probe runtime is wrapped with its account-read boundary and starts no turn.
- At Full access Octant wraps no provider runtime unless the thread keeps its sandbox; only the operating system's own protections remain. Plan's read-only enforcement is the same at every level.
- A wrapped runtime that makes its own API call resolves provider-endpoints-only below Full access. On macOS and Linux with Network limits on (they ship off) it runs on its own egress proxy, reaching its provider's endpoints, its Project's rules and the person's safe networks; OpenCode on Linux materializes it as plain network allow. An unwrapped launch takes no egress proxy.
- A new module may not launch a provider process without the shared confinement builder unless the matrix names it.
- Runtimes get no reusable cloud credential the person did not configure for that account; shared-config and default-chain cloud sign-in is refused.

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Providers run in their own sandbox

Below Full access, outside Strict, a provider runs as on its own: in its own sandbox where it has one, with its own approvals holding the level. Octant's sandbox applies under Strict, in Chat and Plan, where a thread keeps it or chooses a sandbox policy, and for readiness checks (maintainer decisions, 2026-11-15 and 2026-11-21).

- One rule decides it for every driver (`providerHoldsLevelWithoutSandbox`, `packages/domain/src/guardrailPolicy.ts`): a Work or Code launch outside Plan and Strict, with no sandbox kept at Full access, no chosen sandbox policy, and not a readiness check, starts with no Octant sandbox at every level, as on Windows. The provider's own sandbox and permission modes hold the level, and Octant's approval gate answers what they ask.
- Where Octant configures a native sandbox it does not wrap it: writable roots are the Project's folders, network follows Network limits, and Octant's protected paths become the provider's deny rules where it supports them. A native sandbox replaces Octant's profile only where it keeps other providers' sign-ins unreadable. Accepted trade-off: it may allow reads outside the Project, the person's other credentials included, as the provider does on its own.
- A provider's request to run one command outside its sandbox reaches the person as an Octant approval (the reviewer at Auto). Approved runs that one command; denied or unanswered stays refused; nothing is remembered for later.
- Strict is set per thread, as a Project default and in Settings, where the sandbox kept at Full access is set, and resolved at each launch and call: the thread's choice, else the Project's, else Settings', else off. A hub-introduced device or an agent grant may turn it on, never off. Under Strict the provider runs inside Octant's profile with no native escalation, and provider sign-ins, `~/.ssh` and cloud keys stay unreadable.
- Codex outside Strict (`codexRunsNativeSandbox`, `codexExecutionSettings`): a Work or Code thread at Ask first, Accept edits or Auto runs Codex's workspace-write sandbox, with the Project's folders writable and network open unless Network limits hold it. Ask first runs `untrusted`; Accept edits `on-request`, so Codex decides when to ask, as in its CLI (maintainer decision, 2026-11-21); Auto `on-request` with Codex's reviewer. Its escalation reaches the person or Auto's reviewer, for that one command, never the session. Plan and Chat keep Octant's read-only profile, and the lease is keyed on Strict, so Strict and non-Strict sessions never share a process.
- From Codex 0.169.0, outside Windows, that sandbox is a named Codex permissions profile carrying Octant's protected paths as deny rules (other providers' sign-ins, less the account's own Codex home). An earlier release runs the built-in workspace-write policy, which has no deny field, without them.
- Claude Code outside Strict: Octant passes its sandbox no settings (no writable roots, network, read or deny rules, or auto-allow change), so it runs as the person's own Claude Code settings configure it, with its own permission modes and Octant's gate, even in a launch that reads none of those settings. Plan keeps its read-only confinement (`claudeOctantConfiguresSandbox`).
- Claude Code under Strict: macOS refuses nested Seatbelt, so Octant configures Claude's own sandbox: reads and writes held to the Project's folders, network per Network limits, `autoAllowBashIfSandboxed: false`, and Claude's request to run one command outside it asks every time (maintainer decision, 2026-11-16).
- ACP agents, Mistral Vibe included, outside Strict: a Work or Code launch below Full access starts with no Octant sandbox, and the agent's `session/request_permission` asks hold the level (maintainer decision, 2026-11-21; `acpStartsUnconfinedBelowFullAccess`). An agent keeps Octant's sandbox when its shell never asks, when it is an added agent the person has not trusted (it starts under Strict), and when the person turned its setup off and its profile holds setup back, so that setup stays held back as [the setup-off rule](#key-providers-run-as-themselves) requires; Windows refuses that last launch below Full access ([Windows below Full access](#windows-below-full-access)).
- OpenCode and Pi outside Strict: a Work or Code launch below Full access on macOS and Linux starts with no Octant sandbox, and their own approvals hold the level (maintainer decision, 2026-11-21). OpenCode's permission rules ask, as the level says, before an edit, shell command or outside folder; Pi's approval bridge before every `bash`, `edit` and `write`. Pi's `read`, `grep`, `find` and `ls` ask nothing inside the launch's folders and, unwrapped, ask before any other path, links resolved, so another provider's sign-in is never read unasked ([detail](provider-runtimes.md#opencode-and-pi-without-octants-sandbox)).
- Under Strict, Gemini CLI, Qwen Code, GitHub Copilot, Cursor and Grok Build stay on Octant's profile, because their own sandboxes cannot hide other providers' sign-ins. Gemini CLI 0.68.0's tool sandbox takes no deny list Octant can write and can widen reads to any path per command. Every Qwen Code 0.27.4 Seatbelt profile allows all reads, and a custom one is read only from the Project's `.qwen`. Copilot CLI 1.0.112's one-session flag is not in its help, and whether its bypass reaches an ACP client needs a signed-in probe. No Cursor release is probed. Grok Build 1.0.77 launches with `GROK_SANDBOX=off`, since macOS refuses its Seatbelt inside Octant's; its named profiles run unenforced with a warning where the kernel cannot apply them and write only its start folder, and its fail-closed custom profiles live only in a `sandbox.toml` of the person or Project.
- Unchanged: server-side approval authority and journaling, read-only Plan and no shell in Chat, the paired-device and routine rules, signing a provider in as the account chosen for it (never with a key the host's environment holds for it), and marking outside content. Octant's other additions are under Strict ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).
- Not part of this rule: a host-side command executor, and restarting a session at wider authority.

Not built yet:

- Octant configuring the native sandbox of Gemini CLI, Qwen Code, GitHub Copilot, Cursor and Grok Build: their checked releases cannot hide other providers' sign-ins; Copilot and Cursor wait for checks of their ACP releases, Grok Build for a check of why it launches with `GROK_SANDBOX=off`.

Status: Partly built. Since: 2026-11-15. Detail: [Architecture: Security and authority, Providers run in their own sandbox](../architecture.md#security-and-authority).

### Work shell at the shared access level

A Work thread launches exactly as a Code thread at the same level would, shell included. A driver that cannot reports it and keeps the shell withheld.

- It never runs commands under a weaker guard than the level names: asks to the person at Ask first, a reviewer at Auto, none at Full access.
- Claude Code, Codex, OpenCode, Pi and ACP agents start Work sessions with their shell and Git at the thread's level; the Octant Harness has the Code harness's shell port under the same authority.
- An ACP agent whose shell runs in-process, with no protocol request, cannot be asked per command and reports unsupported at Ask first and Auto. Its profile says so; no shipped profile does.

Status: Built. Detail: [Architecture: Modes, Work shell and Git](../architecture.md#modes-chat-work-and-code) and [Security and authority, Sandbox](../architecture.md#security-and-authority).

### Provider capability matrix

Claude Code, Codex, OpenCode and Mistral Vibe are first-class key providers, each promised full native capability. The other ACP agents are key providers for their own setup only (maintainer decision, 2026-11-14). Every other provider has a documented degraded form or reports the capability unsupported and fails closed.

- Nothing makes providers match. The conformance harness checks that a driver reports its own capabilities honestly, not that drivers agree.
- A capability only some providers have reaches the others through the published SDK and plugin seams; no seam is widened for one vendor.
- Outside harness endpoint drivers are held to the bundled endpoints' declared ceiling and reach Octant's tools only for models the host verified.
- A test pins the matrix against the drivers' static capability blocks and the catalog's per-mode columns.
- Mistral Vibe stays on the ACP bridge ([Provider runtimes](provider-runtimes.md#mistral-vibe-surface)); its usage and context over ACP are read for the verified 3.0.3 release after a signed-in probe.

Not built yet:

- Mistral Vibe's compaction, review and question messages over ACP: allowed, but each needs its own signed-in runtime evidence first.

Status: Partly built. Detail: [Architecture: Security and authority, Provider capability matrix ("degraded on")](../architecture.md#security-and-authority).

### App-server runtime confinement

Under Strict, and in Plan and Chat, a key provider's app-server runtime runs inside Octant's sandbox at every level below Full access. Outside Strict a Codex Work or Code thread runs Codex's own sandbox ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox)).

- Inside Octant's sandbox each turn tells the runtime its sandbox is external, so approving a command never lifts a sandbox. Codex's Ask first and Accept edits run `untrusted` there. Auto runs as Codex's own Auto, `on-request` with its reviewer (maintainer decision, 2026-11-14): commands run unasked inside Octant's wall, and what Codex still prompts for (a command it flags as dangerous, a patch outside the root) goes to the reviewer ([Provider runtimes: Codex](provider-runtimes.md#codex)).
- Under Strict a Codex command that must leave Octant's wall fails there: Codex prompts for `require_escalated` only under a restricted sandbox, allows it unasked under an external one, and never retries a denied command unsandboxed under `on-request` (codex-rs `exec_policy.rs` and `orchestrator.rs`, rust-v0.169.0).
- A command cannot read the home folder outside the root and the account home, and cannot write the account home's configuration, rules, skills, hooks, plugins or instructions.
- Under Strict the launch environment carries no cloud profile, shared-config location or IAM key at any level, and a cloud sign-in that reads shared config or general-purpose keys is refused as incompatible.
- At Full access its commands reach the whole disk.

Not built yet:

- None recorded: the entry names nothing unbuilt; whether it is Built is a question for the maintainer.

Status: Partly built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Provider telemetry and self-update are the person's switches

Whether a provider sends its own telemetry and whether it updates itself are two person-level switches in Settings › Providers & Models, not hard lines: **Let providers send their own telemetry** and **Let providers update themselves** (maintainer decision, 2026-11-21).

- Both are off by default, a store saved before they existed included (maintainer decision, 2026-11-21). Off means Octant sets the provider's guard wherever the provider has a documented switch a launch can set; it does not mean telemetry is off for every provider (maintainer decision, 2026-11-25).
- With telemetry off, every launch outside Strict carries the provider's telemetry guards as Strict does; on, launches outside Strict drop them and the provider's settings decide. Self-update is off by default because Octant installs and updates provider CLIs itself; on, launches outside Strict drop the self-update guards.
- Octant sets no telemetry off-switch for Cline, GLM Agent, Devin, fx, Oh My Pi and added ACP agents (no documented or confirmed switch), OpenCode (no telemetry of its own found), GitHub Copilot before 1.0.100, or GitHub's server-side collection. Every provider's model requests carry the conversation and cannot be stopped.
- Strict keeps every telemetry and self-update guard whatever the switches say, and so does a launch outside Strict for a thread that keeps its sandbox at Full access or chose a sandbox policy (Claude Code and every ACP agent). The version read always keeps them. A host that exports its own telemetry or non-essential-traffic opt-out keeps it either way.
- A provider terminal reads both switches by the same rule when its program starts, sandbox cases included, for Claude Code and an ACP agent's environment guards ([Provider terminals](#provider-terminals)).
- Each switch is read at every session start and resume and applies from the next launch; a running process keeps its guards. Octant's own **Update CLI** flow is unaffected.
- One table in [Provider runtimes: Provider channel switches](provider-runtimes.md#provider-channel-switches) gives, per provider, what it may send, what Octant sets, what each switch changes, what Octant cannot stop, what a person can do, and each fact's source. It covers Goose's and Qwen Code's telemetry guards, GitHub Copilot's `--disable-client-telemetry` on 1.0.100 and later and its self-update guard, Cline's self-update guard, Devin's `auto_update` following the self-update switch, Grok Build's configuration overlay following the telemetry switch, and Codex's `analytics.enabled=false` on the app-server, whose lease is keyed on the telemetry switch (maintainer decision, 2026-11-25).
- With telemetry off outside Strict, a thread that chose Claude artifacts lifts only `DISABLE_TELEMETRY`, as under Strict ([Provider-published artifacts](#provider-published-artifacts)).

Not built yet:

- A telemetry off-switch for Gemini CLI: it has settings only, no per-launch switch exists, and Octant does not write the person's provider configuration.
- Overrides for the interactive `codex` in a provider terminal: not wired.

Status: Built. Since: 2026-11-21. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority), [Settings: Provider channels](settings.md#provider-channels) and [Provider runtimes: provider channel switches](provider-runtimes.md#provider-channel-switches).

### Provider runtime telemetry guards

Each non-essential channel of a key provider's runtime is kept off by its own switch on every launch, version read included, not by one blanket switch.

- Guarded channels: usage metrics, error reports, self-update, bug and feedback upload, the session survey, auto-memory, built-in agents and marketplace auto-install. Strict guards all of them; outside Strict telemetry and self-update follow [the person's two provider switches](#provider-telemetry-and-self-update-are-the-persons-switches).
- Auto-memory has a per-account setting for each key provider, on by default, that the person turns off (maintainer decision, 2026-11-14). A Work or Code launch outside Plan on an account with it on drops the auto-memory guard; Plan, Chat and the version read keep it, since Plan and Chat keep the provider's memory off.
- The built-in agents guard is dropped whenever the person's own subagents are on, the default ([Key providers run as themselves](#key-providers-run-as-themselves)).
- Only where the person turned their own setup off for the account or thread does the query open with no setting sources, plugins, skills, agents or MCP servers, with strict MCP configuration keeping the account's hosted connectors out; by default it loads them.
- A host's own exported non-essential-traffic or telemetry opt-out holds on every launch; the person's own opt-out always wins.
- Octant never reads, stores or injects the runtime's subscription tokens; a leftover helper-token envelope is deleted on upgrade.

Not built yet:

- None recorded: the entry names nothing unbuilt; whether it is Built is a question for the maintainer.

Status: Partly built. Since: 2026-10-20. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Hosted artifact publishing

Publishing a Work or Code file to the provider's hosted service is a person-authorized external publish and an opt-in telemetry exception, off by default.

- The account enables the choice from a window on this host or a paired device (maintainer decision, 2026-11-12); each thread then chooses hosted artifacts over Canvas for itself, and Canvas stays the default.
- Only such a thread's session outside Plan launches with the tool and usage telemetry on; every other guard stays on, and a host opt-out keeps them all.
- Every publish asks below Full access, and an approved publish passes the gate again before the runtime continues; no answer is reused. At Full access nothing asks, and the path checks still refuse a file outside the Project.
- The file must be inside the bound Project and outside the login keychain folder. The host keeps the page link, title and a bounded snapshot of what was approved.
- Plan never offers the tool, Chat never publishes, and agent-run child sessions are never offered it.
- A paired device chooses it as a local window does (maintainer decision, 2026-11-12): server policy admits a person-paired device and refuses hub-introduced ones.

Not built yet:

- Enabling the account's choice from a paired device: today only a window on this host can.
- The paired-device UI for the thread's choice: a follow-up to the server policy.

Status: Partly built. Since: 2026-10-27. Detail: [Architecture: Security and authority, Hosted artifact publishing](../architecture.md#security-and-authority).

### Plan launch writes and sign-in

A confined Plan launch of one key provider's runtime writes only what its own session needs, so it cannot plant what a later unsandboxed session would load.

- It writes only `sessions/`, its own session transcript and folder, and the launch temporary directory. Settings, hooks, MCP config, skills, plugins, agents, commands and any memory folder stay read-only.
- A subscription login kept in a file may also be written so the runtime can save a refreshed login (2026-10-14); Plan can then replace the stored login.
- Subscription sign-in uses the unmodified CLI and a minimal grant (the keychain tool, fork, the login keychain file and two security lookups); the profile refuses the keychain tool and file to every other process.
- A Code Plan turn on macOS may run a closed list of read-only commands whose network and writes stay with the runtime and the launch temporary directory. On Linux each runs in a capsule nested in the runtime's, under the same rules; a host that cannot nest one offers Plan no Bash tool ([Plan and Chat tool parity](#plan-and-chat-tool-parity)).
- A live check is owed: no real turn has yet run under the narrower session grant.

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Subscription sign-in inside the provider's terms

Octant would not mint, store or inject a provider setup or OAuth token; subscription sign-in would stay wholly in the provider's own flow, launched from a provider-owned config directory.

- The rule is proposed, not accepted: it needs the provider's commercial terms or an explicit exception. Until then the architecture describes the build as it ships.

Status: Designed, not built. Detail: [Architecture: Security and authority, Proposed, not accepted](../architecture.md#security-and-authority).

### Confined Git

Confined Git reads no configuration from the person's home and sees only the repository metadata it needs.

- Every launch sets the global config to `/dev/null` and disables system config. A commit takes its author from the host's recorded identity when the checkout names none.
- In a linked worktree Git reads only the metadata its own worktree names, and only when the reciprocal record (backlink and common directory) verifies through an identity-checked open.
- Write on that metadata is requested per launch, only by a non-Plan mutation launch; observation stays read-only for every caller.
- Mergeability runs against a quarantined object directory that reads the real objects through an alternate.

Status: Built. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Host reads of a bound root

Every read, listing and search the host makes in a Code checkout or Work folder, and every Work write, runs one confinement sequence that survives an ancestor being swapped for a link.

- The sequence is lstat, link check, realpath, containment check, then an open that lands on the canonical path with the handle's device and inode verified. Linux requires the handle's kernel path to equal the canonical path; macOS opens with `O_NOFOLLOW_ANY`; other platforms refuse.
- Mirror writes, removals and re-imports, Canvas refresh and purge removals are held inside the destination root the same way, relative to folders held open from the root down.
- Work renames and deletes, and native harness writes and edits, act relative to a directory proved at its canonical path or through Work's confined write; a Work rename stays in its directory.
- A mirror or export folder is stored by its real path; a root that no longer resolves to exactly that path is refused before anything is written or removed.
- An entry the host cannot open is not listed. Hard links are not refused.

Status: Built. Detail: [Architecture: Security and authority, Host reads of a bound root](../architecture.md#security-and-authority).

### ACP client capabilities

Octant executes ACP client file and terminal effects inside the Code confinement, with bounded reads, writes, lifetimes and output.

- Execution posture is re-checked for every write and terminal creation; the effects are refused in Plan.
- Provider terminal overlays cannot replace `TMPDIR`, `PATH` or `HOME`.
- The effects are journaled as app-managed tool events; the provider gains no second permission prompt and no path outside the bound checkout.

Status: Built. Detail: [Architecture: Security and authority, ACP client capabilities](../architecture.md#security-and-authority).

### ACP agents keep their credential-file block at Full access

At Full access an ACP agent launches outside Octant's sandbox with no OS-level denials of host credential files or extension folders, as the provider's own app does. Octant's own file tools refuse only provider sign-ins there, and secrets are redacted from what Octant records.

- Credentials reach providers only through the credential broker. Where Octant's sandbox wraps an ACP agent ([Provider runtime confinement matrix](#provider-runtime-confinement-matrix)), it also denies credential files and unapproved extension folders.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Approvals](../architecture.md#security-and-authority).

### Windows confinement for confined launches

A confined Windows launch runs in a fresh AppContainer with ACL grants and a kill-on-close job, applied by a fixed native launcher (maintainer decision, 2026-11-15). It confines only Codex catalog reads under Strict; every other confined Windows launch is refused until it has run a real provider on a person's Windows machine.

- The container is deny-by-default. Grants name only the bound root and extra folders, the temporary directory and write roots, read roots and the program's folder; a grant ALL APPLICATION PACKAGES already holds writes nothing. A grant whose path passes through a junction or link at any component is refused, with each component held open during the edit. One session lock serializes grants and removals across launchers, and each removes only its own SID's entries.
- A read-only bound root beneath a writable grant, a grant beneath an isolated root, and a writable grant beneath an extra write denial are refused, except the launch's own write roots, which the shared port re-allows past both.
- The secret guard holds as an OS rule: no grant at, inside or above a protected location (a runtime's own account home excepted from inside it); a grant that is or sits inside a pattern match is refused; a launch is refused when a grant already holds a pattern match or a carve-out falls inside a grant (a deny entry was measured unable to carve a file out of a grant); every path the guard cannot spell is refused, 8.3 short names included.
- Plan and Chat get an active-process limit of one. The job ends the whole tree when the launcher ends, which is the Windows process-tree stop.
- `none` has no capability and `allow` the client capabilities; `proxied`, the relays, read-everywhere, Seatbelt rules and a non-`.exe` program are refused as incompatible, not dropped. Full access is the job object alone, with no container or grants.
- The launcher (`octant-windows-confine.exe`) ships with Windows desktop builds and is wired through `windowsConfinement` for Codex catalog reads under [Windows Strict, phase 1](#windows-strict-phase-1), with durable pre-ACL lease records and idempotent `--recover` cleanup. A Windows Strict Codex thread does not run in it: Codex's own elevated sandbox confines that thread's commands (2026-11-22). Strict off runs unconfined, with the tree stop in place of a container.
- Hosted Windows CI covers the mechanism, the recovery sweep and a native Codex smoke on an administrator runner.

Not built yet:

- Every other Windows Strict launch: refused by name until its runtime is verified.
- Standard-user Windows 11 desktop verification (Gate 5), ACL propagation cost on a large checkout, terminals and other providers: not yet verified.

Status: Partly built. Since: 2026-11-15. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Windows Strict, phase 1

Native Windows accepts the one shared Strict control for Work and Code at Full access on a verified Codex runtime (maintainer decision, 2026-11-21). Codex's own elevated Windows sandbox confines the commands Codex runs, with the thread's folders as its only writable roots and every protected store denied; the Codex process itself runs outside any Octant wall (maintainer decision, 2026-11-22).

- Two postures: outside Strict the provider holds the level with no Octant sandbox; Strict is Octant's confinement at every level. Phase 1 adds no Windows-only label, switch or preference, and Strict keeps its thread, Project and Settings resolution and explicit Off.
- The legacy Full-access-only sandbox preference never returns as a Windows control: a saved or inherited choice without Strict keeps refusing by name and is never read as or migrated into Strict.
- Every other Windows Strict case refuses by name until its runtime is verified, one at a time: Chat, Plan and every level below Full access, every other provider, proxy-only or blocked-network policies (`network: "deny"` until model traffic has a separate verified path), and Octant's own file, terminal and command operations.
- Rationale: an Octant wall around the Codex process forced shared `CODEX_HOME` writes (rollouts in shared date folders, thread writer locks, rollout compression), so a confined command could change or delete other threads' history. Codex never gives its sandboxed commands write access to `CODEX_HOME`, and the process keeps its home, sign-in and follow-up turns. Only the elevated backend enforces deny-read; the unelevated one refuses deny-read paths, so it is not used.
- Exception to the no-administrator rule: the elevated backend's one-time setup asks an administrator to approve it, as Codex's own setup, never requested by Octant. When setup is not done, or this Codex cannot report it (`windowsSandbox/readiness`), Windows Strict refuses Codex by name before a thread starts; Codex still works with Strict off.
- These keep refusing: a writable folder overlapping `CODEX_HOME`, a profile-root `CODEX_HOME`, a read-only folder beneath a writable one (the profile carries only writable roots and denials), a writable folder whose name Codex reads as a pattern, a `CODEX_HOME` inside a location Strict denies to everyone, custom protected-path rules and isolated credentials. A store Codex's globs cannot name refuses the thread rather than staying readable. Nothing retries unconfined.
- Limit: Codex's workspace profile keeps `.git` read-only, so a Strict thread cannot stage or commit; a writable `.git` would let a confined command plant hooks the person's own Git later runs.
- A live check is owed: Gate 5, a real Codex turn under Windows Strict on a standard Windows 11 account after Codex's elevated setup, and the refusal when that setup is missing.

Status: Built. Since: 2026-11-21. Detail: [Architecture: Windows Strict, phase 1](../architecture.md#windows-strict-phase-1).

## Terminals, browsers and side surfaces

### Project terminals

A Project terminal is the person's shell, not an agent's. No provider, tool call, agent run or thread can address it, read its output or type into it.

- Only a person, at a local window whose workspace holds the Work or Code Project or at a paired device that reaches it, may start, attach to, type into, resize or stop it (maintainer decision, 2026-11-12). A device the host's own person paired runs its own shell in a local Project, journaled as the device and ended when the device is revoked or silent for a minute.
- It runs at the Project's bound root with no credential references. Outside Strict it runs unconfined, a Work Project's included; under Strict it runs through a thread terminal's confinement. Strict is read at each start from the task's or the Project's value ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)). Plan never applies; a terminal on a Plan checkout stays read-only.
- Its lifecycle is journaled on its own aggregate; its output never is. Archiving the Project or relinking its root ends it as `authority-revoked`.
- A Work Project shows a terminal only after its Developer tools are on; Chat has none. One opened for a Work task may run that task's provider's own program ([Provider terminals](#provider-terminals)) and stays a person-only Project terminal.
- A server Work Project exposes its person-operated SSH shell only in its bound local Settings row, showing the real user, alias and folder and Full remote access before launch. Window, Work enablement, binding and registry, and Developer tools are rechecked before dispatch, after acquisition and for the session's life. Closing, hiding, switching or revocation cancels only its owned session, pending acquisition included; unknown replies never replay. Saved Work actions keep closed stdin and reject interactive writes even without a task context. Closing SSH does not prove remote programs ended ([Server Projects](server-projects.md#threads)).

Not built yet:

- Saved actions, worktree setup and a server Project's shell from a paired device: they stay at a window.

Status: Partly built. Detail: [Architecture: Security and authority, Project terminals](../architecture.md#security-and-authority).

### Provider terminals

A person can run a thread's provider's own command-line program, in its own interface, in a terminal tab of that thread (maintainer decision, 2026-11-21). Its keystrokes reach the provider directly, past Octant's approvals, so the thread claims nothing that happens in it.

- **Open <provider> terminal** sits beside New terminal in a Code thread's terminal actions and beside Stop terminal on a Work task's Project terminal card in Zen, for Claude Code, Codex, and ACP agents whose profile names `interactiveArgs` (Google Antigravity's `agy` and Gemini CLI's `gemini`, run bare, as the repository's sign-in guidance does). A Work task's opens as a Project terminal for that task, in its folder.
- The host resolves the program by the rules the provider's own launch uses: the account's binary, its folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and launch environment, with telemetry and self-update guards following [the person's two provider switches](#provider-telemetry-and-self-update-are-the-persons-switches) as its turns do.
- For an ACP agent it uses the environment the driver builds (`sanitizeAcpEnvironment`: Strict's passthrough list and guards, or the person's own outside Strict), the home a turn of that thread runs on (the person's real home outside Strict where the agent's sessions stay in one place, else its managed home; maintainer decision, 2026-11-25), and its host sign-in folder's variables. It drops only guards that keep the piped ACP stream clean (`NO_COLOR`, the only one any profile sets), since the terminal is a TTY; every self-update, telemetry and configuration guard of its turns holds. Antigravity's `--disable-telemetry` is a launch argument the bare program does not take.
- The command names none of these. Plan, a server Project and a provider with no such program are refused, and the terminal lends no Browser.
- It runs as the thread's turns do (maintainer decision, 2026-11-21), by `providerHoldsLevelWithoutSandbox` (mode `code` or `work`; a Work task's at the task's own level, not the Full access a plain Project terminal takes outside Strict). Outside Strict and Plan, with no kept Full-access sandbox and no chosen sandbox policy, it starts in the thread's folder with no wall or egress proxy, on the provider's own approvals.
- Under Strict, a kept sandbox or a turn's chosen sandbox policy, it starts under an ordinary Code terminal's confinement at the thread's level, not widened. An account folder outside the thread's folders stays unwritable (unmounted on Linux), so a program that must write there can fail to sign in.
- On Windows, which has no Octant terminal sandbox, a provider terminal that would start confined is refused: under Strict (Codex at Full access included, though its turns run there) and for a thread that kept its sandbox.
- Only the person opens or types into one, from their own window or a device they paired; the host refuses every agent and other remote principal, whatever an approval would allow.
- Its output stays out of the thread's transcript and usage; the tab says the provider's session is outside Octant's record.
- A Work task's Project terminal journals `program: "provider"` on start (optional; without it, a shell). Its Zen card records the same and the program's name from the host's answer at pinning, fixed for the card's life, so the notice names that program and not whichever provider the window's Work task uses later. Restarting the card asks again, and the host decides afresh.
- It carries no secret: an account that signs in through its folder starts signed in; an API-key or gateway account's key is not passed, so the program asks for its own sign-in.

Not built yet:

- The other ACP agents, an added ACP agent and the other providers with a program: the repository does not yet record their CLI's interactive mode.

Status: Partly built. Since: 2026-11-21. Detail: [Workspace: provider terminal](workspace.md).

### Terminal output paths

A Code thread terminal's output reaches a window by two paths, so latency and durability do not share one setting.

- The record path writes to the evidence store and operation journal, coalesced to one write per 50 ms per terminal; the journal stays authoritative for reload and export.
- The live path is a read-only stream from the in-memory transcript, never journaled, with the same redaction and credential-prefix hold-back. It is authorized like a state read, re-proven every second, and ended when the window's capability is revoked or the shell stops.
- A minimised Terminal card is a second reader of the thread's one shell: it reads its state and follows the stream within its limits, never attaches (a journaled operation), starts, writes or resizes, and stops the stream when the card goes. A stream that ends or is refused is retried with bounded back-off, then shows "Preview ended".

Status: Built. Detail: [Architecture: Security and authority, Terminal output paths](../architecture.md#security-and-authority).

### Project browsing contexts and profiles

A Project browser is the person's browser, never an agent's. A page is Private unless the person puts it in a profile.

- A Project context is isolated and ephemeral, registered under an owner id derived from the Project, so no thread surface can attach and no thread approval carries into it.
- Only the person, at a local window or a paired device, may open, read or close it (maintainer decision, 2026-11-12). A device the host's own person paired opens its own Private page, which closes when the device is revoked or expires.
- Profile pages open only in the desktop app's native Browser; an agent acts on an origin there only after a site approval naming the profile.
- Browser extensions install at a local window (the folder picker is native), from an unpacked folder or a copy of one the person picks in another Chromium-family browser on this Mac, never loaded in place; Manifest V2 and native-messaging extensions are listed as unsupported. They start disabled, are enabled per profile, and never load into a Private page.
- Octant never opens another browser's profile in place.

Not built yet:

- A profile page from a paired device: profile pages open only at a window.

Status: Partly built. Detail: [Architecture: Security and authority, Project browsing contexts](../architecture.md#security-and-authority) and [Browser profiles and extensions](../architecture.md#security-and-authority).

### Side Chat reads

A Side Chat may read its source thread's transcript, state and files but never inherits the source's Work or Code execution authority.

- It gains only list, search and read file tools, re-checked per call against the sidecar link and the window's right to open the source.
- The host tools an ordinary Chat gets (side tasks, images, Canvas, past threads, Computer, the `#thread` dialogue, child agents) are withheld.
- Paths are relative and confined, results are bounded and recorded as external content, and it has no write, shell, Git or network tool.
- The `#thread` dialogue tool is refused for a sidecar in both directions.

Status: Built. Detail: [Architecture: Security and authority, Side Chat reads](../architecture.md#security-and-authority).

### Subagent authority

Child runs receive equal-or-narrower authority than the parent, clamped server-side.

- Code children require a verified isolated worktree receipt. A managed child's Canvas tools are bound to the workspace and Project the host resolved, never a path the model names.
- A provider transport that cannot carry app-managed tools fails the start with a typed reason rather than dropping the tool.
- Under Strict a source turn sends at most three thread messages, a count Settings › Limits changes; outside Strict there is no limit ([Octant's own limits become settings](#octants-own-limits-become-settings); `decideThreadDialogueAsk`, `packages/domain/src/threadMentionPolicy.ts`). A target turn started by that tool is never offered it. _Here only._
- Key providers' native subagents are journaled and use the parent's approval path; a provider whose children would bypass it gets them only at Full access. This holds for Claude Code; Codex, whose subagents' requests are answered through the parent's session; OpenCode, whose delegated sessions are followed as child runs; and Mistral Vibe in Work and Code outside Plan, whose subagents' requests name no tool and are shown through the parent's approval path saying so (maintainer decision, 2026-11-14).
- Outside Strict a helper runs as its thread's own provider does. A Work parent's grant follows the Work thread's level as a Code parent's does: shell, Git and network outside Plan, read-only under a Plan parent, Accept edits under a Full access thread that keeps its sandbox; the level is the lower of the running turn's and the thread's stored level. The person's answer to a helper's request is kept as the parent's persistence setting says; a reviewer's allow holds for one call (maintainer decision, 2026-11-25).
- Under Strict a helper keeps every Strict protection: a Work parent's helpers stay approval-gated with no shell, Git or network, and every answer holds for one call.

Status: Built. Detail: [Architecture: Security and authority, Subagents](../architecture.md#security-and-authority).

### Canvas design images

A design frame never loads anything itself. The server resolves the images a design declares on every read.

- Resolution runs through the authorized Canvas read under the version's mode, Project and thread. Chat reaches only images generated in its own Project or thread; Work and Code files pass the Work confinement sequence.
- Only sniffed raster images within per-image and per-design budgets are returned, and the renderer inlines them as `data:` images. The journal holds references only.
- An image block may draw a generated image (`generatedImageId`, Canvas version 30), resolved through the same read as a design's `generated-image` asset, with "Image unavailable" when gone or out of reach. It is written into the saved HTML under its image budget, travels with a share, and leaves Markdown and other destination exports as its description.

Status: Built. Detail: [Architecture: Security and authority, Canvas design images](../architecture.md#security-and-authority); [Canvas: Image block](canvas.md#image-block).

### Product feedback notes

A local person can point at an exposed Code or Work Browser element, inspect a bounded static crop and DOM and style context, and save a comment on that immutable capture.

- The host resolves the element under the original window, task and page authority; renderer point and request correlation cannot supply authoritative element data or create a Browser grant.
- Pending notes can be amended, removed or excluded. Only an explicit person message consumes the exact selected versions, once; automatic continuations leave them pending. Saving or choosing notes never sends, queues, steers or approves work.
- Comments are person-authored; captured page material has outside-content provenance and taints the task. Missing or unsafe crops are explicit omissions and keep the comment.
- Preview count, memory and lifetime are bounded across the host. Crop, outside-content marking and committed note are atomic, and late revoked reads never publish fresh evidence.
- A live check is owed: native Electron runtime acceptance of capture, preview and note delivery.

Status: Built. Detail: [Browser: Pointed-at product feedback](browser-agent-tool.md#pointed-at-product-feedback).

### Project actions

Work and Code Projects save named one-line commands that only the person saves and launches.

- A Project saves up to twelve named one-line commands and relative directories through versioned events. Suggestions from root scripts and build targets are read-only until confirmed. A Work Project shows actions only when its Developer tools are on.
- The host previews folder and branch. A Code thread defaults to its active checkout; the Project and approved extra folders are explicit choices. Binding, checkout, policy and command are rechecked before launch, and Plan refuses.
- Each action gets a fresh tracked command process with output, exit status and cancellation, never input through a busy shell. Its journaled identity precedes launch and cannot launch twice after restart.
- Results stay beside the task; Open terminal is an explicit Zen handoff. The window keeps the run identity for reattachment, and unknown replies or a host restart never repeat side effects.
- Server Projects save their own versioned actions and read suggestions only through the bounded remote file reader. Settings offers the Project-open transition before suggestions or runs outside this window's binding for that mode; manual editing neither opens nor reads the Project. Review shows the actual server and profile, canonical folder and task policy, saying there is no OS confinement. Server registration, action revision, directory identity, Git state and current task authority bind the placement, and dedicated SSH runs never type into an existing terminal.
- Work's journaled local-person Developer tools choice is off by default. It reveals actions and the person's Project terminal in the bound Settings row, without changing task or credential authority or enabling a general tools pane; hiding it retires only the person's SSH terminal, and saved-action authority stays separate.
- Stop, transport loss and an unconfirmed start keep the uncertainty and never replay ([Server Projects](server-projects.md#threads)).

Status: Built. Detail: [Architecture: Security and authority, Project actions](../architecture.md#security-and-authority).

### Worktree setup

A Code Project can prepare each new managed worktree with one reviewed saved action.

- The Project marks one reviewed saved action as its optional preparation recipe; new managed worktrees record it separately from Git readiness.
- The first task waits for setup or the person's explicit Skip. Setup uses admitted task access and the confined process lifecycle, with bounded output, a ten-minute timeout, cancellation, and no parent environment or secret copying. Plan refuses it.
- Failure needs an explicit Retry or Skip. Host restart reconciles owned processes and shows the interruption without replay; uncertain cleanup refuses a new run.
- Worktrees › Setup stays beside the task and can inspect its child checkouts. Existing worktrees keep their recorded recipe when Project actions change.
- A local managed-worktree launch shows source, checkout, recipe and first-agent progress inline; Setup details opens the same Worktrees dialog, and a running recipe can be cancelled inline ([Thread view](thread-view.md#draft-continuity-and-composer-notices)).

Status: Built. Detail: [Architecture: Security and authority, Worktree setup](../architecture.md#security-and-authority).

## Remote access and pairing

### Remote clients

Pairing issues a revocable device key. The private listener serves HTTPS on a LAN or private-mesh address with a host-owned identity. What each device may do is set in [Paired devices act as the person](#paired-devices-act-as-the-person).

- A remote principal never exceeds host, mode, provider, Project or thread authority.
- An admission policy and a route classifier classify remote requests fail-closed. No remote request mints a local receipt, and an unknown action is refused.
- Every remote change is journaled under the device's own id, a restricted device's included (maintainer decision, 2026-11-13): harness run steering, provider, connector and cloud sign-out, memory limits, and a sign-in completed after a restart (named for the device that began it). The Browser profile, extension, flow and capture services journal the actor the route hands them.
- A Code operation's events name whoever started it, output streamed after the start included; a Stop's marker and an approval's answer name whoever sent them. What the host starts or settles by itself (a routine, a recovery, after a restart) is the system's.
- Cancelling a waiting connector sign-in names whoever cancelled it. Adopting an outside session journals the adoption, the imported conversation and Code's session-ready record as whoever adopted it, payloads unchanged.
- A device-code or cloud sign-in begins only at the host's terminal and is the local person's.
- **Pause remote access** refuses every paired device's session and request and every outside agent's claim and call with a reason the client shows, and ends agents' in-flight calls and milestone streams. It keeps every device record, key and grant, survives a restart, and leaves only the hub's member-to-member routes working. A local window or `octant auth resume` on the host turns it on or off; a Full device may only turn it on. Each change is journaled (maintainer decision, 2026-11-22).
- **Sign out all other devices** revokes every other device's key and sessions and keeps the asking device; at a window it is Revoke all (maintainer decision, 2026-11-22).
- The listener, pairing tickets and decisions, and the device inventory are administered by a local window over the loopback administration channel or by a Full device over its session. A party the host already trusts approves every new device (maintainer decision, 2026-11-12).
- The listener serves HTTPS only on one person-selected private address and explicit port. Wildcard, public and ambiguous binds are rejected; certificate validation is never bypassed. _Here only._
- Enabling or retargeting the listener needs the person's confirmation showing address, port, origin, certificate identity and exposure class. _Here only._
- Every state-changing remote request carries a device-key proof, a replay nonce, a CSRF value and an exact-origin check; a cookie alone authorizes nothing. _Here only._
- Sessions have idle and absolute lifetimes and rotate. Revoking a device drops its sessions and streams before the response completes. _Here only._
- Approvals are remote-approvable or local-host-required. A Full device passes the local-host-required class but never becomes a local window; an action that needs a native control of the host is unavailable where that control is absent (maintainer decision, 2026-11-12). _Here only._
- Remote clients never queue authority-bearing mutations offline. Disconnected data is stale and read-only. _Here only._
- An agent drives a debug session through the plugin-shaped `octant_debug` tool: unasked at Full access, one approval per session below it, refused in Plan (maintainer decisions, 2026-11-12 and 2026-11-13). A Full device lists, confirms, starts, controls and reads one as a window does; every other device is refused. Nothing a session shows is journaled.
- Breakpoints alone are saved, in device-local renderer storage per endpoint, window, thread and checkout. Restored ones stay unresolved until an authorized exact file check, changed ones need acceptance, and restoring never starts or attaches a session.

Not built yet:

- Administering the listener from a device: the private listener forwards none of its routes.

Status: Partly built. Detail: [Architecture: Security and authority, Remote clients](../architecture.md#security-and-authority).

### Remote reach into thread surfaces

Each thread surface (conversation, host browser, terminal output, simulator screenshot, canvas, file preview) names one action that reads it and a separate action that acts on it.

- A companion derives each surface's reach (unavailable, read-only or interactive) from the host's catalog and never declares it. _Here only._
- A companion says when its picture is stale and offers only surfaces it can fill. _Here only._
- A Full device raises a thread to Full access or starts one there, and answers every approval of a thread it can open, Browser approvals included, with no owner-device requirement or unlock; the first answer settles it (maintainer decision, 2026-11-12). Approve and steer answers only its own turn's prompt, once; Read only answers none. The phone draws each Browser approval with site, profile, direction, files and reason, offering only the answers the host keeps.
- An owner device known only through the hub's roster is not the person there: no per-action unlock (maintainer decision, 2026-11-13), and a thread's level rises only through owner posture recovery. Its answers ride the five-minute unlock session; per-answer unlock is a setting (maintainer request, 2026-11-12). See [Hub failover and owner devices](#hub-failover-and-owner-devices).
- A device that is not the person may click, hover, scroll, press keys in and list the tabs of the host's agent browser, but not navigate, type, choose an option, drag, upload, or open, switch or close a tab. Navigation guards and site approvals apply to every device as to a window.

Not built yet:

- The entry does not record which part is unbuilt: question for the maintainer.

Status: Partly built. Detail: [Architecture: Security and authority, Remote clients](../architecture.md#security-and-authority).

### Host identity on every connection

Every client verifies a signed host hello before it pairs or signs in, and refuses a host whose identity changed.

- Each hello request names a fresh client nonce. The hello carries the host key, its fingerprint, that nonce, an expiry and a signature, and the client checks all of them.
- The client records the proven fingerprint at pairing and requires the same host id and fingerprint on every later hello.
- A host built before these checks is refused as incompatible. No refusal deletes the device key.
- First contact is trust on first use over TLS. A relay that passes the live hello through is closed only by certificate pinning.

Status: Built. Detail: [Architecture: Security and authority, Host identity on every connection](../architecture.md#security-and-authority).

### Listener certificate and client pinning

The listener serves a pasted certificate or a self-made one. A client pins a self-made certificate by its public-key hash and accepts it no other way.

- The self-made certificate has its own owner-only P-256 key, not the host identity key, refused if another user can open it, and never in a response, log or journal. Renewal and a moved address keep the pin; disabling the listener keeps the key; complete data removal deletes it.
- A pinned origin passes only on the hash; an unpinned one only on platform validation.
- A client sends nothing unless every resolved address and the connected peer are private LAN or private mesh; one public answer refuses the name.
- Desktop and phone pin through a main-process or native channel with one shared rule; the desktop window never connects to a paired computer itself.
- Rotating: the local CLI signs host, origin, old and new pins and a fixed seven-day window with the old TLS key; trusted hellos stage it durably on desktop and phone. Activation names the new pin and restarts the listener without rotating host identity or revoking devices. A missed window needs re-pairing, never an unknown-pin fallback. Cancelling withdraws only an unactivated stage. Activation refuses an enabled hub or joined spoke; detach and rejoin first.

Not built yet:

- Roster trust migration: activation refuses hubs and spokes instead.

Status: Partly built. Detail: [Architecture: Security and authority, Listener certificate](../architecture.md#security-and-authority).

### App pairing code and one-step pairing

A self-made listener pairs apps through a single-use, five-minute pairing code (text and QR) that carries the listener origin and pin, not a browser link.

- A reader accepts only the builder's exact text and refuses a newer version, a damaged code or a non-private origin before sending anything.
- A browser pairs only with a pasted certificate, since it cannot check a self-made one.
- `--pair` on the one-line server install or start enables the listener, prints the code and polls claims until the ticket ends, over the same loopback administration calls.
- Approval needs a typed yes on the host after comparing label, key fingerprint and comparison code.
- A Full device lists, renames and revokes devices (one or all, itself included), makes codes, and approves or denies requests over `/api/remote/`, journaled as it; a device it approves is the person's. It never approves its own key. Hub-introduced devices and agent grants do none of this (maintainer decision, 2026-11-12).

Not built yet:

- Key rotation for one-step pairing: planned.

Status: Partly built. Detail: [Architecture: Security and authority, Adding a computer in one step](../architecture.md#security-and-authority).

### How long a paired device stays paired

The person chooses how long a pairing lasts: 7 days, 30 days (the default), 90 days, 1 year or Never expires (maintainer decision, 2026-11-13).

- Registrations recorded before the setting existed have the 30-day deadline.
- It is a host shell setting a window or a Full device changes, journaled with its actor; other devices are refused.
- The deadline is pairing time plus length; use never moves it. Sign-in and every signed request refuse an expired device before reconciling, and it must pair again. Revoke ends any pairing, and is the only end under Never expires.
- A change re-times every current pairing in the same journal transaction as the setting, per device as the person. Shorter can expire devices at once; longer or Never lifts the deadline; an expired or revoked pairing never revives.
- With the listener on, a passed deadline expires the device within a minute, ending its sessions and streams as Revoke does.
- Session lifetimes are separate.

Status: Built. Since: 2026-11-13. Detail: [Architecture: Security and authority, How long a pairing lasts](../architecture.md#security-and-authority).

### Pairing abuse limits

Pairing is rate-limited and cleans up after itself.

- Hello and claim share ten requests per source per minute and sixty per host. A waiting window's status polls draw on their own bucket, so a flood from other addresses cannot starve it.
- A paired browser rate limited on reload is told to wait and resumes after the host's `Retry-After`. It is never shown as a failed pairing and keeps its device key.
- An approved device that never signs in is revoked as `pairing-abandoned` once its ticket would have expired (or 30 seconds after approval). A device that has signed in is never removed this way.

Status: Built. Detail: [Architecture: Security and authority, Pairing budgets](../architecture.md#security-and-authority).

### Hosts never trust each other

Multi-host views merge read models in the client without transferring authority. Federation shares no credentials: the [Shared sign-ins](hub-and-spokes.md#shared-sign-ins) API-key copy needs a fresh own-unlock on each host and a one-use receiving ticket, and subscription sign-ins refuse copying.

- Conflicting facts stay with their owning host. A create or mutation names one destination and is refused when it is not routable; nothing queues offline. An agent message to another member waits on the sender until that member answers, and the receiver admits it afresh.
- An all-hosts list keeps every host; an unreachable host's cached items stay listed as stale and read-only.
- A host shows as an environment under the person's name for it; the window's own host is always "Local". _Here only._
- A row names its environment only when it is not this one. Filtering and ordering by environment are client view state; "All environments" includes hosts that connect later. _Here only._
- A hub acting on a spoke is a remote principal held to that host's grant, and never approves, reads credentials or loosens confinement there.
- The host's platform reaches only a window on the host; server copy says "this computer".

Status: Built. Detail: [Architecture: Security and authority, Hosts never trust each other](../architecture.md#security-and-authority).

### Dev server proxy grants

A paired device may ask for a grant to open one dev server from its own computer, under a proxy session separate from its product session.

- The proxy session lives in host memory with its own cookie and routes, never reaches product routes, and ends at host restart.
- The host gathers every fact itself and rechecks grant, device, thread and owning process before every relayed request, closing the grant on any lost check. Revoking the device, archiving the thread or disabling the listener closes it. Opening and closing are journaled with grant, device, thread and port, never the endpoint.
- Only the desktop app opens a page live, through a keyless loopback forwarder that relays only what the window signs.
- A followed Code thread on a paired computer lists its servers and opens one the same way, only for a server Octant started in its own worktree; the page stays out of this window's Browser tabs (maintainer decision, 2026-11-20).
- A Full device may forward one host loopback port to its own `127.0.0.1` as raw TCP for an hour, journaled with device and port; the row says anything on that computer can reach it (maintainer decision, 2026-11-20). It is offered on Running services of a computer the window is narrowed to.
- Under the Act item, a hub-introduced device may forward only a running server's port of a thread in the Projects Act names. The request names the server; the host takes the port from its own listing and rechecks Act and ownership at opening and every connection. It stays private, lasts an hour and is journaled with thread and Project. Other ports are refused; an agent grant forwards none (maintainer decision, 2026-11-21).
- A server Project's SSH port forward is a window's alone: one `ssh -W` stream per connection, at most eight, ending after an hour, at stop and at restart, journaled with Project and ports (transport decision, 2026-11-20). It is **Forward a port** in Settings › Permissions › Servers ([Server Projects](server-projects.md#person-operated-port-forwards)).
- A Full device stops a server as a window does, a leftover Octant does not own included; a hub-introduced device stops only Octant's own (maintainer decision, 2026-11-12). A server outside active Code Project roots gets no row and no probe.

Not built yet:

- Forward port in a paired computer's thread view, which offers Open only: no UI yet.
- The paired screen for confirming and stopping a leftover server: the server admits it.

Status: Partly built. Detail: [Architecture: Security and authority, Proxy sessions and server grants](../architecture.md#security-and-authority) and [Local servers and Running services](../architecture.md#security-and-authority).

### Agents on other machines reach Octant through an agent grant

An agent on another machine on the person's own network starts and follows work as its own principal, held to an agent grant the person creates. It is never a paired device and never the person; product routes give it every device clamp under the grant's scope id.

- A grant names Projects, modes, a highest level, tools, models, spend limits and expiry, inside a restricted device's clamps and its own closed route list.
- A grant may reach Full access, behind the one-time warning (maintainer decision, 2026-11-12); `start_work` gives an explicit Full access to the thread alone, never the Project (maintainer decision, 2026-11-13). Its prompts stay marked as outside content.
- A window, the loopback CLI or a Full device (over `/api/agent-grants/commands`, with Agent access in the paired browser's Host settings) creates or widens a grant (maintainer decision, 2026-11-12). Other devices may view and revoke it.
- It reaches only `POST /api/agent-access/mcp` on its own listener surface, from LAN-private and Tailscale sources, plus loopback for a local client ([Local MCP clients use an agent grant](#local-mcp-clients-use-an-agent-grant)).
- The recommended connection is the `octant agent mcp --connection` bridge with a key made on the agent's machine, signed requests and pinned TLS. A bearer key over the Tailscale certificate is opt-in per grant.
- It never adds Projects or answers approvals. Its threads are marked from the first turn, its approvals wait in Needs you under its name, and each turn says it sent it.
- Revocation voids its credentials and ends its sessions and requests at once; running turns continue unless stopped.
- Reach stays on the person's network (maintainer decision, 2026-11-11); no public bots, nothing Octant operates.
- A grant that reads a thread can follow its metadata-only milestones over MCP Events, by poll or push. Webhooks need host-side HTTPS origin approval and receiver verification; an older webhook profile can be enabled. See [Milestone subscriptions](agent-access.md#milestone-subscriptions).
- Hosted and vendor-client receipt of milestones is a live check still owed.

Status: Built. Since: 2026-11-11. Detail: [Agent access from other machines](agent-access.md) and [Architecture: Security and authority, Remote clients](../architecture.md#security-and-authority).

### Local MCP clients use an agent grant

An MCP client on the host's own computer may use Octant as an MCP server under an agent grant, enrolled, scoped and confirmed as a bridge grant is (maintainer decision, 2026-11-14).

- It runs `octant agent mcp --connection <file> --local`, sending the bridge's signed requests to the loopback server's `POST /api/agent-access/mcp`. The claim stays on the private listener, which must be on.
- Loopback grants nothing extra: the same credential, grant and remote checks, the same `unauthorized` for an ungranted key, `tools/list` limited to the grant's tools, prompts as outside content, approvals in Needs you.
- The bridge never reads or sends the host's bridge secret; the local `octant agent mcp` path under that secret is unchanged.

Status: Built. Since: 2026-11-14. Detail: [Agent access: Ways to connect](agent-access.md#ways-to-connect).

### Paired devices act as the person

A device the host's own person paired at Full is that person. The server admits it wherever it admits a local window and journals its acts with the device as the actor (maintainer decisions, 2026-11-12, 2026-11-16 and 2026-11-22). Every other device session is held to the remote action catalogue. Other entries link here instead of restating this.

- The host decides from its own record, never the client. A device is the person (`person-paired-device`) only when the host's person approved its pairing, at a local window or from a device that already acts as the person, and its level is Full or unrecorded. Every other session is `remote-device`: a narrower level, a hub-roster device, an agent grant, an unproved pairing. The host reports `actsAsHostPerson`; a client reads anything else, an unread answer included, as restricted.
- Each directly paired device has a level, chosen at approval and changed in Settings: **Full** (default), **Approve and steer** (the catalogue without the hub's Act item) or **Read only** (the catalogue's reads, shown as watching only) (maintainer decision, 2026-11-22). The host stores it and enforces it per request before any side effect, so a device below Full never raises itself. A local window or a Full device sets it; each change is journaled with who and the levels before and after, and the device's open requests end. Hub-introduced devices and agent grants have no level.
- On the phone, Read only keeps existing threads openable and disables starting threads. The phone and paired browser refresh the computer's standing in the foreground.
- Stays with a local window, for every device (maintainer decision, 2026-11-19): a window's own shell (bootstrap, workspace commands, local sessions), the desktop bridge and `/api/desktop/*`, local receipts, `/api/secret-stores/*`, native file and folder pickers (a skill folder, a runtime's executable), Keychain cookie import, `/api/browser/credential-use` (a site login permission), Finder and external-editor Preview handoff, read-aloud on the host's speakers, desktop Browser pane mouse input, saving to a chosen path, and a server Project's SSH port forward, which listens on the host's loopback.
- A restricted device, an agent grant and a caller with no session are refused every person-only route before anything is journaled or connected.
- Admitted for a Full device, each journaled as the device, its pairing re-read on the host where a window's capability would be: shell settings; Browser session, upload and download permissions for every active Work or Code Project; skills; design systems; usage history and ledger; a server-hosted Work thread's files and a server's catalog and load; provider command scan; server Projects and cloud jobs ([Paired devices in cloud jobs and server Projects](#paired-devices-in-cloud-jobs-and-server-projects)); file and event routines; extensions, outside drivers included; Full access; person memory on its turns; stopping any Computer use session ([Computer use and device tools](#computer-use-and-device-tools)); Project switches (memory writes, default-branch push, pull request comments, toolchain, image generation); wake-ups; Safe networks and Network limits; resource limits and Agents settings; growing an MCP grant ([MCP tool approvals](#mcp-tool-approvals)); its own Project terminal, ended on revoke or a quiet minute ([Project terminals](#project-terminals)); a Private page ([Project browsing contexts and profiles](#project-browsing-contexts-and-profiles)); agent grants; a coordinator's proposed worker ([Coordinator threads](#coordinator-threads)); Canvas HTML import ([HTML import](#html-import)); Settings › Permissions › Servers, worktree and Xcode cleanup, leftover servers, desktop spend cap, recipe machines, disposable desktop previews, routine notifications and push gateway; Canvas controls (Allow network, answers, boards, comments, design systems, refresh, actions, share, export, public links, export notices); Artifact library, tags, Claude page copy, mirror and synced routes; thread export with captures; Preview text editing; the Browser's profiles, extensions, flows, captures, downloads, Take over and signed-in pages ([A paired device holds a Browser page](#a-paired-device-holds-a-browser-page)); provider OAuth, Cloud IAM, tooling and integration sign-in; live tasks and session adoption; memory proposals; replica store and membership; connector sign-in ([Connector sign-in finished from a paired device](#connector-sign-in-finished-from-a-paired-device)); diagnostics export, journal growth and the support bundle.
- The paired browser shows these to a person session only: Host settings › **Permissions** and › Diagnostics; Claude and Codex tool setup; a Canvas's Allow network, public link review, export approval, comments and design-system switch; a thread's Browser captures and prompts, answered with no live pane; each Project's switches beside its default mode (no default-branch push switch, as in a window). Work and Code's **Project tools** lists the device's terminal and Private page (a profile choice there is refused with the host's sentence). A Chat thread's Canvas tools hold **Import HTML…** alone, since a device's plain create is not built.
- The phone offers the same Project tools in Views and panes (a **Terminal** of plain output lines, a line to run and Control-C, ended when the sheet closes; a **Private page** with address, picture, title, Refresh and Close page), **Import HTML…** in Chat, and every Work request a window answers (the Plan block, **Provider approval**, questions, questionnaires with **Dismiss**), each answered with the version read; a tool or plan approval asks for the phone's own confirmation (maintainer request, 2026-11-18). A Code thread's asks stay at a window.
- Each owning entry keeps its own UI follow-up until finished.
- A device the host's own person paired changes Reply detail (the default and a thread's own level) through the shell settings route, as a window does through the shell route (maintainer decision, 2026-11-13). The phone and other paired browsers only read it, through `GET /api/reply-detail`.
- A person-paired device may read a Linux server Project's Vitals over its SSH connection; a hub-introduced device is refused (maintainer decision, 2026-11-12).
- A person-paired device may start a Work or Code thread from a session text handoff; a hub-introduced device is refused (maintainer decision, 2026-11-12).
- A device the host's own person did not pair at Full may not unlink a pull request from a thread (maintainer decision, 2026-11-25).
- In the Active work read, a device only the hub introduced is not told of Code Projects outside the Act item, and an agent grant's session is refused.
- The host's memory and routine decision routes take an answer only from a device the host's own person paired.

Not built yet:

- Paired screens for the other surfaces the server admits: UI follow-ups.
- The listener's controls, the whole host's export, removing a provider with its key in one step, and a server's port list for previews: the 2026-11-12 decision reaches them, but the server still refuses every device.

Status: Partly built. Since: 2026-11-16. Detail: [Architecture: Security and authority, Paired devices act as the person](../architecture.md#security-and-authority).

### Paired devices in cloud jobs and server Projects

A Full device submits and manages provider cloud jobs and binds, changes and operates server Projects as a window does, and its records carry a versioned device principal (maintainer request, 2026-11-18).

- Only a `person-paired-device` principal is admitted beside a window; every other caller is refused before anything is journaled or connected. An agent grant never spends a cloud account.
- A device's act writes `principal` `{ kind: "person-paired-device", credentialGeneration }` with the device id on the `remote-device` actor, resolved from the authenticated principal, as a version 2 event (`provider-cloud.job-changed@2`, `provider-cloud.opt-in-changed@2`, `server-projects.*@2`, `server-projects.preview-outcome@2`, and the `cloud-machines` events' version 2). A window's act keeps writing version 1, so a journal no device changed stays readable by an older build.
- A device's cloud submission gets the same review, rechecks and spend ceilings, with its session and credential generation held current. A key needing an unlock at the host is refused `credential-unlock-needs-this-computer` before the create permit is spent. Watchdog, recovery and terminal observations are the system's.
- A device's setup check, terminal, saved-action run and preview belong to its session on the shared SSH connection and end on revoke, session end or a quiet minute. A server key needing confirmation at the host fails with a sentence. Previews use the private listener's relay route, never a loopback listener.

Status: Built. Since: 2026-11-18. Detail: [Architecture: Paired devices and cloud jobs](../architecture.md#provider-cloud-jobs) and [Server Projects: Paired devices](server-projects.md#paired-devices).

### Access activity and change notices

The person sees who changed access to this computer, and is told in the app when a paired device or an agent raised it (maintainer decision, 2026-11-22).

- Settings › Remote access lists devices added, removed and re-levelled, newest first, with time, label and actor, refreshed as changes are journaled. A window and a Full device read it; others are refused.
- A notice appears when a device or agent grant raised a thread's level strictly up the order, or added or replaced a provider key; never for a window's own change, a lowering, or a move between Auto and Accept edits. It names the device or agent, thread or provider, and time, and carries no key.
- Notices show on windows and Full devices other than the one that made the change. Dismissal is journaled and holds everywhere.
- Undo restores the previous level through the thread's level command, or removes exactly the added key, as whoever pressed it, and is refused once things changed again. A replaced key has no Undo, and the notice says so. **Revoke that device** revokes the device or ends the grant through the existing paths. At a window both keep the bar of the routes they stand in for, the desktop bridge secret, after a fresh read shows the notice current; a window capability alone is refused.
- In the app only: no push and no email.
- Shown on windows, browsers paired at Full and the phone's Settings per computer (Undo, Revoke or End access, Dismiss; a revoke asks first), to person sessions only. The phone reads them in the foreground.

Status: Built. Since: 2026-11-22. Detail: [Architecture: Security and authority, Remote clients](../architecture.md#security-and-authority) and [Settings: Remote access](settings.md).

## Credentials and sign-in

### Provider keys on a host without the desktop app

A provider API key is entered through the desktop renderer, the host-local `octant provider key` command, or a device the host's own person paired, a paired browser included (maintainer decision, 2026-11-12). It goes straight to the credential broker and is never journaled, logged or returned. An unpaired browser never supplies one.

- The command reads the key without echo, or from standard input with `--stdin`, never from an argument, flag or environment variable, and sends it once over the loopback administration session. The server requires the bridge secret and a window capability and refuses any `Origin` header.
- A locked, absent or unreachable store fails as `credential-store-unavailable`, with no fallback.
- `set` on an existing key needs `--replace`; a pool of several keys refuses a replace; `remove` never widens authority.
- Each store, replace or remove is journaled before and after with no key, length, prefix or hash. Unsettled requests clear at host start.
- A person-paired device reads status, sets, replaces and removes a key, and edits a key pool under `/api/providers/credentials/` (`providerCredentialRoutes.ts`), from Settings › Providers; the routes refuse a hub-introduced device, an unproved pairing, an agent grant, a local window and the bridge secret. The key travels only in the request body, and the journal names the device. Removing a provider with its key is not offered to a device (maintainer decision, 2026-11-12).
- A browser without credential authority can create an API-key profile without its key, with guidance to set it in the host terminal or the desktop app.

Status: Built. Detail: [Architecture: Security and authority, Provider keys on a host without the desktop app](../architecture.md#security-and-authority).

### Host-driven provider sign-in and cloud signing

The host, not a provider child and not the renderer, owns provider sign-in flows, and tokens stay in the credential broker.

- A local principal or a device the host's own person paired acknowledges terms and starts a PKCE sign-in, journaled as the device ([Paired devices act as the person](#paired-devices-act-as-the-person); maintainer decision, 2026-11-12). No other remote principal acknowledges terms, starts a flow or refreshes. Where a device code may begin and show: [Organization sign-in flows](#organization-sign-in-flows).
- State and the code verifier are checked, the redirect is one-shot, and unanswered consent times out. The journal holds the terms acknowledgment and public state, never a token, code or verifier.
- A sign-in completed after a restart is attributed to the device that began it (maintainer decision, 2026-11-13).
- The broker signs cloud requests itself, with platform crypto and no cloud SDK, only within the stored scope. Portal sessions, refresh tokens and role secret keys never leave it.

Not built yet:

- A paired device starting a device-code or single sign-on portal sign-in (maintainer decision, 2026-11-12): the host-local routes are not forwarded to paired devices yet.

Status: Partly built. Detail: [Architecture: Security and authority, Host-driven provider sign-in](../architecture.md#security-and-authority).

### Connector sign-in finished from a paired device

A device the host's own person paired finishes a connector sign-in whose callback is this host's loopback, with no token, verifier or device code leaving the broker (maintainer request, 2026-11-18).

- Device authorization (RFC 8628) is used where the issuer advertises it and the dialect allows it (not the GitHub OAuth App, Google Desktop app or Slack profiles). The device sees only the `https` verification address on the issuer's host, the user code and the issuer's host name; the broker polls. This is the connector's own flow, not a provider endpoint's device code ([Organization sign-in flows](#organization-sign-in-flows)).
- Otherwise the device relays its callback address once to `POST /api/extensions/mcp-sign-in/relay` over its signed session. The host accepts it only for an attempt the same device, session and credential generation began, at the registered callback, with matching `state` (and `iss` where required), within ten minutes and the attempt's timeout. The broker exchanges it with the verifier only it holds.
- The first accepted callback, loopback or relay, settles the attempt; a failing relay is refused without settling, at most three times. Address, code and state are never logged or journaled; start, outcome and cancellation are journaled naming device and flow.
- Hub-introduced devices, agent grants and callers without a session are refused. A local window still finishes any attempt at the loopback.
- A real paired phone against a hosted issuer is a maintainer live check still owed.

Status: Built. Since: 2026-11-18. Detail: [Architecture: Extensions and skills, Finishing a connector sign-in from a paired device](../architecture.md#extensions-and-skills).

### One-use credential cards

A person can enter a token, or pick a linked 1Password field reference, in a conversation card for one fixed integration operation, without sending it to the model or saving a sign-in.

- Integrations register fixed operations through the public host port, and the host supplies purpose, destination and action; an agent picks no URL or command.
- The card is answered at the owning local window, or a paired device that can open the thread (maintainer decision, 2026-11-12). Submission consumes the request once, checks thread and window authority, and returns no response content or raw error to the agent.
- The card shows destination and one-use scope with masked input. Expiry, decline, cancellation and restart end it; a token already sent cannot be recalled.
- Consumers are the read-only Linear account check and a fixed Azure Resource Manager GET in Code, with the full URL in consent and redirects refused. Linked-store selection resolves only the submitted reference and keeps no reusable slot. Azure CLI credentials and administrator authentication stay outside cards.
- Agents reach cards and saved commands through one Code tool, `octant_credential` (`help`, `list`, `request`, `run-saved`, and the [thread secrets](#thread-secrets) operations), each keeping its own authority, approval, Plan and window rules; `list` returns names and descriptions only. Where thread secrets are not offered, it is offered only if a registered operation or saved Project command exists when tools are composed. It is not a general command runner.
- Named command bindings serve local Code tasks: Settings fixes Project, recipient and CLI digests, arguments, directory, account and immutable references, and the person approves every run, at the originating local window or paired device. Ask first and Accept edits keep ordinary command approvals and Octant Shield and confine the recipient while the credential tool authenticates outside. Plan refuses; Full access is unrestricted.
- Command approval ids are one-use and never restored; a newly prepared request always needs fresh approval and proves nothing about an earlier process. Below Full access the recipient's OS and per-command network rules hold. Vendor output concealment does not stop disclosure to allowed destinations.

Not built yet:

- Answering a card or approving a saved-command run from a paired device: today only the owning local window can.

Status: Partly built. Since: 2026-11-03. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Thread secrets

An agent in a Code or Work thread can ask the person for a secret in a private card, kept as long as the person chooses (maintainer decisions, 2026-11-24).

- The card is answered at the window that raised it, a phone this host's person paired at Full, or, for a phone's card, a window that could drive its thread. A phone takes a typed or remembered value, never a 1Password item. The item picker lists names and addresses only while a card waits.
- The tool is offered wherever a person can answer, with one definition in and out of Plan, never deferred. Code and Work only; Chat is refused. The card never expires, follows the Unattended work rule, and shows in Needs you and on the phone.
- A value is entered only in the card: an agent cannot pass one, and one pasted in chat is ignored. Asking again for an active secret reuses it within its lifetime.
- Lifetimes: this command, this turn, one hour, 24 hours, until archived, or Remember. Strict offers neither 24 hours nor Remember; an account password never offers Remember. Fresh each use reads a linked item each time and keeps no copy; Remember keeps a typed value in its own credential namespace, or a linked item's address. Settings lists active and remembered secrets.
- `run-with-secret` runs one command under the thread's level, remembered answers, Octant Shield and sandbox, with secrets as variables nothing else sees, and redacts its output. Plan and server Projects refuse it.
- A handle is used once by a registered consumer, never by a command, and is refused before anyone is asked while none is registered. Authority is read before and after the value.
- A file is written only where the thread's commands run outside an Octant sandbox; every confined launch is denied the folder by a rule the person cannot remove, and Octant's file tools refuse it at every level, their one Full access exception beside the sign-ins.
- Nothing is usable before its journal record, which holds no value or free text. Expiry, revocation, the turn's end, archive, the host's stop and the next start remove the file and end every use.
- Active values are redacted with their common encodings, and ended ones until the host stops; the specification lists what redaction does not cover.
- Computer use filling a password prompt from a handle is a separate, later decision.

Status: Built. Since: 2026-11-24. Detail: [Architecture: Thread secrets](../architecture.md#thread-secrets), [Thread view: Secret cards](thread-view.md#secret-cards) and [Settings: Secret stores](settings.md#secret-stores).

### Account usage reads

Plan limits that a provider reports only from an account endpoint are read with a credential already on the host for that instance: Devin and OpenCode Go from their CLI's saved sign-in, Mistral Vibe from the Mistral API key Settings holds (maintainer decision, 2026-11-25).

- The host reads the key only for an enabled instance, sends it nowhere else, follows no redirect, and never writes, copies or stores it; it stays out of logs, journal, snapshots and errors.
- Only a refresh the person asks for waits on the endpoint; others get the last reading, with at most one background read per five minutes. Failures carry a fixed message, and a changed response shape keeps the last reading.
- Vibe never reads its Keychain item or `~/.vibe/.env` and never scrapes `admin.mistral.ai`. A missing allowance or a key without usage permission reads as unavailable or not applying, never 0% used. A spent included window with pay-as-you-go on is no limit; pay-as-you-go off at 100% is.

Status: Built. Detail: [Architecture: Security and authority, Account usage endpoints](../architecture.md#security-and-authority).

### Claude gateway accounts

A Claude account may sign in through a gateway: an address in the account's configuration and a token in the host credential store, kept as an API key is (maintainer decision, 2026-11-18). Its launch gets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in its own account directory, with every other ambient Anthropic and Claude credential stripped.

- The token uses the API key's broker and routes ([Provider keys on a host without the desktop app](#provider-keys-on-a-host-without-the-desktop-app)). A browser without credential authority creates the account tokenless, with host-terminal guidance, and a token it types is refused before creation.
- The address is HTTPS, or plain HTTP on this computer or a private network under the Ollama rule and warning ([Provider reach Octant no longer narrows](#provider-reach-octant-no-longer-narrows)), with no credentials, query or fragment. Changing it, or switching to Anthropic's own API, deletes the stored token or key.
- No account gets another's address or token, and credentials never appear in process arguments.
- Settings offers the host's `ANTHROPIC_BASE_URL` as an address prefill only on the person's choice, and tells only whether `ANTHROPIC_AUTH_TOKEN` is set.
- The connection check reads the gateway's models. Claude artifacts and plan limits are not offered, as for an API-key account.

Status: Built. Since: 2026-11-18. Detail: [Model endpoints: Claude gateway accounts](model-endpoints.md#claude-gateway-accounts).

### Artifact replica membership

Each artifact replica entry is signed by a per-host device signing key, and membership derives from signed approvals chained to a founder the host pinned.

- The signing key lives in a namespace provider credentials cannot reach and is not a paired client's device key. An entry that does not verify is journaled as unreadable.
- A computer joins by a signed request a member in good standing approves by name. Only the computer that brought another in can revoke it; a member leaves by signing a left record.
- Store setup, joining, revoking and leaving are the person's, at a local window or a paired device; server policy admits a person-paired device and refuses hub-introduced ones (maintainer decision, 2026-11-12). Store credentials live in the host credential store.
- A bucket endpoint is `https` with no path, query or user info, and not link-local; loopback and private ranges are allowed.
- The storage provider can read synced content, and Settings and the guide say so first. A replica import appends versions only and delegates no host authority.

Not built yet:

- The paired-device interface for store setup, joining, revoking and leaving: a follow-up; server policy already admits the device.

Status: Partly built. Detail: [Architecture: Security and authority, Artifact replica membership](../architecture.md#security-and-authority).

## Updates and development

### Signed update feeds

The desktop updater verifies a feed's Ed25519 signature against the compiled-in keys of the ring the signed release names, before it believes any other field.

- Stable trusts only the stable key; preview and candidate trust the preview and stable keys, so preview builds cannot sign a stable feed.
- The release wizard mints a ring's key only when the app ships none, since replacing a deployed key strands its installs.
- Each ring's feed is a fixed mailbox release on the forge; checks never depend on the serving host.
- Responses stream under size and time bounds. Redirects are bounded, stay HTTPS, and widen from a configured or signed origin only to a connect-time-pinned public address.
- Whoever writes feed files can withhold updates, never install something unsigned.
- A Linux AppImage update checks signature and hash, replaces the image atomically, and fails closed with the reason in Settings.
- Each mailbox lists the release's headless builds (`<ring>/<target>.octant-headless.json`: version, target, ring, URL, digest), signed with the ring's feed key by the signing job. A host installing a server over SSH believes nothing before the signature verifies, uses the updater's transport, and adds no host or key (maintainer decision, 2026-11-19).
- The first release run that publishes a headless build listing is still owed.

Status: Built. Detail: [Architecture: Security and authority, Update feed signing keys are per ring](../architecture.md#security-and-authority).

### A guided tour on the first start

A five-step tour points at the real controls once, on the first start after first-run setup, and can be retaken from the account menu.

- The steps are New chat or New task, the Projects list, the thread header's Tools buttons, the composer and Settings. A step whose control is off screen is skipped and not counted. _Here only._
- Only a fresh installation gets it: due while setup is unanswered, opened once setup is answered and the window is quiet. A person who finished setup before the tour existed never sees it. _Here only._
- It never covers a dialog, a menu, Settings, Project create, a What's new announcement, Zen or a non-empty Inbox, and closes when a dialog opens. _Here only._
- Showing it records it as seen in renderer-local storage; no host setting, network call or count. _Here only._
- The card is a floating surface with an accent ring on the control. Escape closes, arrows move, focus returns, reduced motion removes the fade.

Status: Built. Detail: [Workspace: Guided tour](workspace.md#guided-tour).

### What's New after an update

Release notes show once after an update the person chose finishes applying, and only on the desktop.

- Settings > General > Updates links the running build's notes. First-run setup never shows them, and opening them is never counted or reported. _Here only._
- When due, the full sidebar shows a What's new card at its foot (version, first line, next paragraph, a button to the notes); the collapsed rail neither draws nor acknowledges it. _Here only._
- A release may bundle one to five announcements in `whats-new-announcement.json` (version 2 `{ schemaVersion, announcements: [...] }`; version 1, one entry, stays valid), strict, at most 16,384 characters, with optional pictures whose names cannot leave the folder. They show as one dialog in place of the card, with Back, Next and "n of m". An invalid file shows nothing; an invalid entry is skipped and the first five valid ones show. _Here only._
- Dismissing the card, closing or finishing the dialog, or opening the notes acknowledges the whole set once. _Here only._
- Pictures are read only for entries that will show. Nothing contacts a network, and browsers and remote clients show neither. _Here only._

Status: Built. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Package dependency direction

Dependencies point inward: no package imports an app, and `contracts` imports nothing first-party.

- Contracts hold schemas only, and domain holds pure policy. The host runtime is shared by desktop and CLI and owns the credential broker and bridge secret.
- The web renderer, mobile client and server depend on packages, never on each other's internals.

Status: Built. Detail: [Architecture: Package map](../architecture.md#package-map).

### Development loop and Linux hosts

Development and QA run against the canonical host and never create an implicit profile.

- `octant web --dev` swaps only the renderer. Destructive tests use an explicit `OCTANT_DATA_DIR`.
- The server composition root has no late-assigned values. Forward references are capped by `bun run wiring:check`, which can fall but never rise.
- `bun run verify` is the full local check, and `git diff --check` runs before every pull request.
- A Linux host needs the namespace sandbox tool and Git 2.36 or newer, or Work and Code fail closed. Without an unlocked secret service the host runs but reports its secret store unavailable.
- The Linux AppImage never adds `--no-sandbox`, and lets the browser engine refuse when the host cannot set up its sandbox. Windows stays out.

Status: Built. Detail: [Architecture: Development loop](../architecture.md#development-loop).

## Design system

### Visual character, voice and colour

Octant looks like a calm, colourful workbench. Colour is the default and grey is a choice called Mono. Every surface uses the same words, face and hierarchy.

- Colour applies to everyone: a blue accent, amber warning, red failure, green success, coloured count tiles, board marks and connector marks. A state also has a shape or a word. Plain empty, loading and informational messages stay neutral in both styles.
- Text uses three greys: primary, secondary and muted. An accent swatch is the person's choice and never recolours status; Mono is a swatch. Swatches cover chromatic hues and neutrals (Steel, Slate, Silver, Graphite, Carbon, White). A swatch that cannot be seen on one mode's page writes a mode-only override with a silver for that mode.
- The four count destinations keep one mark each: tiles when a wide window has no rail, plain rows at 960px and narrower. Rail and row icons stay in the sidebar ink; only a tile's face carries its hue.
- The rail lists places only: the Inbox with its count and the Board (Running, To review and Done today). Its foot is one plan usage ring per account above the person's account face, which opens the account menu that leads with Settings (maintainer request, 2026-11-25). The Activity feed is a list arrangement, not a rail place.
- Hierarchy comes from size, then weight, then colour. Text is sentence case, nothing is uppercase, and only the large title is bold. A title is never the size and weight of the text it heads (reply headings 20/17/15/14 at weight 600). Names in navigation and list rows take medium weight.
- The default interface size is 14px; a size a person chose stays. Editor and terminal sizes follow their own settings. A saved row with no smoothing choice reads its 13 as 14; a 13 saved with a smoothing choice stays.
- Interface text is smooth by default: grayscale smoothing with the weights stepped up. Settings › Text › Smooth text off returns the fuller strokes. The switch is hidden off a Mac, and a stored off stays off.
- The interface reads like a native Mac window: per-size tracking, native chrome lines, a dragged pane width saved and drawn whole, no underline on hover in chrome.
- Icons come from one module (`apps/web/src/ui/icons`) of Lucide line icons in four sizes (12, 14, 16, 20); a contract test refuses any other size (maintainer decision, 2026-11-17). Glyphs that read alike get distinct silhouettes.
- Radius is four tokens and a round exception: a control's outline `--oct-radius-sm`, a container `--oct-radius-md`, a floating surface `--oct-radius-lg`, a dialog or sheet `--oct-radius-xl`. Only what is inherently round, and the composer's round buttons, takes the pill token, and a contract test refuses a control rule that reaches for it otherwise (maintainer request, 2026-11-14).
- The interface is soft and flat. A surface at rest has a flat fill and at most one hairline; no bevel, gradient, inset or drop shadow. Hover and press change the fill alone. Only what floats over content casts a shadow. What sits on a floating surface takes its fills from it.
- In the desktop app, whose transparent window draws no backdrop filter, text never sits on a fill that only a blur makes readable: every float other than a modal sheet or dialog is a dense fill with no blur. A browser keeps frosted floats on an opaque window.
- Under glass the window is one coat of the workspace colour at the Glass level's alpha (`GLASS_TINT_DEFAULTS` in `packages/contracts/src/theme.ts`). A chosen Tint is clamped when painted to a floor; the saved value is untouched. On a thin coat the muted ink takes the secondary ink. Increased contrast and reduced transparency make every surface opaque.
- A modal surface shows the window's coat, never the content behind it. A person's message, a glass card and a card over the application ground are near opaque with no blur.
- Over the application ground, every surface that holds running text keeps most of its own colour (`--octant-reading-surface-keep`), and a tool's pane is solid, so text never stands on the ground's glyphs or cells. Other empty areas keep the ground whole, with no blur. Owner: [Application ground](application-ground.md).
- The sidebar and the stage sit in one outlined panel under the title band. The sidebar slides open and closed. At 680px and below the frame has no panel. At 960px or less the dock is a floating sheet holding one tool.
- Pointing, focusing and pressing answer in the same frame, with no transition; motion tokens belong to movement and arrival.
- Everything that opens over the window arrives and leaves one way, declared once. Nothing behind an overlay is laid out again. Reduced motion, from the system or the setting, removes the transition.
- A dialog rendered only while open is held through its exit with its last content (`OctantDialogPresence`). A leaving dialog or sheet takes no press and no key. Focus returns to the opener as the exit starts, unless the person moved it since. A dialog removed with its owner, or closed in a window nobody can see, leaves at once.
- A placeholder stays in the same box until its content is ready to paint. A first read is never drawn as an empty section, and a later read keeps what is drawn until the fresh answer lands.
- Edges and gaps agree across surfaces: a card's inset is 16px, and a row's height is a whole number of pixels.
- A list a person picks from draws one row from shared tokens: menus, context menus, selects, comboboxes, the command palette, typeaheads and picker rows.
- There is one scrollbar, declared once: a thin thumb, no painted track. A feature may reserve its strip or hide it on a named sideways strip, never recolour or widen it. The code editor and the terminal draw theirs to the same measure; the terminal's hides at rest.
- A notice is a small floating glass card whose tone icon is its only colour. The shared callout rule draws every notice.
- Appearance offers Comfortable and Compact density (controls stay 28px), and a Custom preset per mode from Ground, Ink, Accent and a Contrast step. A preset whose text cannot stay readable is refused with the failing role named.
- An empty Code thread shows one composed start block: its title and a one-line hint over one quiet card of workspace presets, with the templates as one row that opens a menu.
- Counts and token figures use English separators; dates and times follow the locale.
- A sentence says what the person waits for, what happened or what to do next, never the mechanism: no "authoritative", no type names from the code, no "target", and a loading state is its title alone. A contract test holds those words out (maintainer request, 2026-11-25).
- Copy says "this Mac" only when the host reports macOS, and neutral words ("this computer", "credential store") otherwise. The window's own platform never decides it.
- The phone app reads as a native app: a bottom tab bar, large titles on tab roots, a centred nav bar on pushed screens, inset grouped lists, the system segmented control and sheets with a grabber. It uses the product radius scale with one 20px sheet, three count tiles in the desktop hues, and the transcript recipe.

Status: Built. Detail: [DESIGN.md: Product character](../../DESIGN.md#product-character), [Voice](../../DESIGN.md#voice), [Type](../../DESIGN.md#type), [Scale](../../DESIGN.md#scale), [Icons](../../DESIGN.md#icons), [Depth and material](../../DESIGN.md#depth-and-material), [Translucency](../../DESIGN.md#translucency), [Window frame](../../DESIGN.md#window-frame), [Motion](../../DESIGN.md#motion), [Components](../../DESIGN.md#components), [Accessibility](../../DESIGN.md#accessibility), [Application ground](application-ground.md), and the [mobile design system](../../apps/mobile/design-system/README.md).

### The composer

A composer's box holds only attach, the prompt, the microphone and send, on a start screen and under a thread alike. It is one line tall until the person types more and is the composer's one raised surface.

- The box is a pill at one line; its attach, microphone, send and stop are round buttons.
- How the next message runs is one row under the box on its columns. In a thread it holds only the model, the mode and the context ring; on a start screen it starts with the Project. The mode is one button with an icon per mode; Full access alone keeps its words, in the warning ink.
- The thread's Project, branch, folder and pull requests are in the Environment panel; its info and plan proposal are in the + menu. The thread's own actions (Mark done, document delivery) are a group of the add menu. The turn figures are in [Thread info](#thread-info).
- Where a new thread runs is one row of chips above the box, the working folder among them.
- That a thread has read outside content is a chip after the access control, shown while it applies, whose popover holds the sentence and the Review action.
- A card above the box is only for something the person must read or act on that stays until resolved (a refusal, a failure, an offer with an action, the Project offer, a failed dictation), most severe first.
- What passes by itself (sending, streaming, a provider check, compacting, a first turn being prepared, a keyboard hint) is one quiet line that takes no layout room, so the transcript never jumps. A note that stays until the person acts is a wrapping card, never cut to a line.
- One always-mounted polite status region is the prompt's description and receives every line's words. Refusal and offer cards are alerts and part of that description while pending.

Status: Built. Detail: [DESIGN.md: Composer row](../../DESIGN.md#composer-row) and [Thread view: Draft continuity and composer notices](thread-view.md#draft-continuity-and-composer-notices).

### One theme authority and shared controls

There is one runtime theme authority and one owned control layer. Feature code places and sizes shared controls but never repaints them.

- Feature stylesheets add no raw colour, radius, shadow or control recipe. A repository checker ratchets existing violations against a baseline.
- Removing an existing repaint is its own batch per pull request, with before and after screenshots, and the maintainer approves the visual change.
- Shared recipes space in pixels on the 4px scale (`--spacing: 4px`), never a half step; type and control heights follow the interface size. A field, select and combobox share the default button's height. A contract test scans every class string.
- Every in-page menu draws one row recipe (icon column, check at the end, a destructive row in the danger ink), reserves the icon column for all rows when any has one, scrolls instead of running off the window, and is at most 360px wide (maintainer request, 2026-11-16).
- Desktop context and dropdown menus are native OS menus through one shared adapter. Browser clients keep accessible renderer menus.
- Feature code composes controls only through the Octant adapters; a repository check blocks direct imports of the recipe or primitive libraries.
- There is one interaction primitive backend. A recipe style's own palette is never adopted; the `--octant-*` roles stay the theme source. A style variant for a primitive state is checked against the attribute the primitive writes. _Here only._
- A development-only component gallery draws every shared adapter under the shipped stylesheets; a test requires every new adapter there.
- The spinner, the keyboard hint and the status dot are one adapter each. The spinner turns slowly under reduced motion, since a frozen one reads as a hung app; the dot always stands beside the word for its state. A contract test refuses a second spin keyframe, a hand-drawn `kbd` and a migrated dot redrawn by its page (maintainer request, 2026-11-25).
- A page that lists things with several facts each (Agents, Artifacts, Automations) draws one shared table. Each row is one press named for its item, with its other cells as its description and controls beside the press. Unreported figures are blank, and figure columns give way first. A contract test refuses a page that redraws the head or the rail (maintainer request, 2026-11-25).
- A visual check draws the key screens in a pinned Chromium in CI and fails a pull request that changes one visibly. The `design change` label passes the run and uploads the new pictures, which a person commits; CI never pushes (maintainer request, 2026-11-18).

Status: Built. Detail: [DESIGN.md: Source of truth and CSS layers](../../DESIGN.md#source-of-truth-and-css-layers), [Enforcement](../../DESIGN.md#enforcement), [Spacing](../../DESIGN.md#spacing), [Menus](../../DESIGN.md#menus), [Components](../../DESIGN.md#components), [Lists and rows](../../DESIGN.md#lists-and-rows), [Component gallery](../../DESIGN.md#component-gallery) and [Current exceptions and known migration edges](../../DESIGN.md#current-exceptions-and-known-migration-edges).

### Portable design tokens

The design system can be reused outside the app from one generated token set, never from values copied by hand.

- `packages/theme/tokens/tokens.css` and `tokens.json` are generated from the renderer's stylesheets, checked against the theme package's colour defaults, keep the app's names, and are never edited by hand.
- A repository check fails when they are stale and names the command that regenerates them.
- `recipes.css` is built from the tokens only; a test refuses a raw colour or an undefined token there.

Status: Built. Since: 2026-11-12. Detail: [Design tokens and the app feel](design-tokens.md).

### Page shell and Settings organisation

Every list, board, reader and preference page is one `Surface`. Settings groups its pages by what they change.

- A setting lives on the page of the thing it changes. A moved setting, and a folded page, keep answering links to the old page, and the command palette finds a page by the name of one it took in.
- A page holds the settings of one question: at most thirty, and a page of one to three folds into the page that asks the same question (maintainer decisions, 2026-11-25 and 2026-11-26). Chat & Work, Computer use (Device tools), Integrations (Web search, GitHub, Linear; a plugin's section is gone while it is off), Data & storage (To-dos), Limits (the counts and waits that bound unattended work), Host (Computer resources), Appearance (colours and glass), Background and Text. Keybindings and Usage stay pages.
- In a wide window Settings is a sheet over the app, which stays mounted and is blurred behind it, on every page and in every window (maintainer decision, 2026-11-26). Reduced transparency and increased contrast draw no blur. It closes from its corner, with Escape or a press outside, and leaves the way it arrived. In a narrow window it covers the window and offers Back to app.
- A page names its scope once, under its title. A header holds one creation action and Back; filters sit in the toolbar.
- A destination opens on one pinned header row in the large page title, with an icon Back that does not move on press, and no description; its one line of detail is only a changing fact a person needs. An empty page is the empty state alone; search and filters return once there is something to search.
- A page is laid out on one grid with its header on the content's edges, and sibling destinations end on one right edge (maintainer request, 2026-11-15).
- A toolbar holds what is used often and one Filter menu the rest, with its count in its name and Reset filters at the end. Agents keeps Save as Canvas in a "…" menu and shows a run's Open thread on hover or focus. Automations has one "New automation" button offering Describe with Octant and Create manually (maintainer request, 2026-11-16).
- The Automations table shows kind, name and schedule, the last seven runs, the next run, an on switch and a "…" menu under the 30-day totals; the list query carries the runs and totals (maintainer request, 2026-11-17).
- A destination page and Settings show their own outline while they load, never a line of text, so nothing moves when they arrive. The words stay for assistive technology, and the sheen stops under reduced motion.
- Background refresh preserves loaded controls and active drafts. Status slots are bounded, so a changed status never pushes the form below it.

Status: Built. Detail: [DESIGN.md: Page shell](../../DESIGN.md#page-shell), [Settings layout](../../DESIGN.md#settings-layout), [Empty, loading, and whole-window states](../../DESIGN.md#empty-loading-and-whole-window-states), [Workspace](workspace.md), [Settings: Settings sheet](settings.md#settings-sheet), [Groups and pages](settings.md#groups-and-pages) and [Settings stability](settings.md#settings-stability).

### User profile

The user profile (optional name, email, accent and avatar) authenticates and authorizes nothing.

- An avatar image is inlined in settings, downscaled to 128 px and at most 96 KB encoded. _Here only._
- The avatar lookup by email hash is the one part that leaves the Mac. It runs only on a button press, says it sends a hash, and copies the result so the host never contacts the service again by itself. _Here only._

Status: Built. Detail: [Settings: Optional Settings details](settings.md#optional-settings-details).

### Approvals and confirmations

Approval and confirmation dialogs default to the safe answer, and the host decides whether an action may proceed, never the card.

- The safe action receives initial focus. Escape, Cancel and backdrop dismissal never change data; closing restores focus to the opener.
- Destructive actions opt into the danger treatment explicitly.
- An extension tool request names the plugin, its server and the tool. Its choices follow what the host says an approval covers: "Allow all tools of this server" where the approval is kept for the Project (for the account outside a Project), with "Allow only this tool" beside it in a local window; "Allow this server in this thread" for a network server on a thread that has read outside content; "Approve once" otherwise (maintainer decision, 2026-11-12).
- A browser request from a CLI in a Code thread's terminal says a program in the terminal asked, not the agent.
- Native Code approvals are isolated host documents. Shared renderer components never grant Code authority, and Enter never implicitly grants access.

Status: Built. Detail: [DESIGN.md: Dialogs and sheets](../../DESIGN.md#dialogs-and-sheets), [OctantConfirmDialog](../../DESIGN.md#octantconfirmdialog), [Settings: Permissions](settings.md#permissions), and [Thread view: Native Code approvals](thread-view.md#native-code-approvals).

### Accessibility baseline

Accessibility is a baseline for every changed surface, not a late pass.

- Text contrast targets 4.5:1 (3:1 for large text and non-text marks). State always uses text, shape or label besides colour.
- Keyboard focus draws one neutral inset edge on `:focus-visible` only. Feature CSS never suppresses, recolours or doubles it.
- No surface is a keyboard trap. The terminal sends every key to its shell and has a documented chord to move focus out.
- With several terminals open for a thread, remappable chords (Mod+Shift+ArrowDown and Mod+Shift+ArrowUp by default) move the caret to the next or previous one, bringing a session behind a tab forward, and never leave the thread's open, visible terminals (maintainer request, 2026-11-25). See [Workspace: Cycling between terminals](workspace.md#cycling-between-terminals).
- Settings › Keybindings marks a shortcut as not running only when another action that answers in the same place keeps its chord; the action listed first keeps it. Undo, redo, clipboard and Select All follow [Reserved keybindings](#reserved-keybindings).
- Theme, typography, density, translucency, contrast and reduced-motion settings persist through the server-authoritative journal; renderer state is presentation only.
- A refused server command is never a silent no-op. Loading, stale, denied, empty and error states keep stable geometry.

Status: Built. Detail: [DESIGN.md: Accessibility](../../DESIGN.md#accessibility) and [Workspace: Keybinding conflicts](workspace.md#keybinding-conflicts).

### Guarded quit

Quitting the desktop app is guarded so that open provider sessions are never dropped silently.

- Quit and Fully quit share one shutdown that confirms when provider sessions remain open or the desktop cannot tell what the host is running.
- Explicit Quit, from the macOS Dock too, checks every window for unsaved Code Files edits before closing any; Cancel stops it. System shutdown, updater restarts and forced exits do not wait for that check.
- Where a window can show the quit notice, the quit shortcut needs a second press within 1.5 seconds; that guard is a setting, on by default (maintainer request, 2026-11-12). With no such window, the first press enters guarded shutdown. Pointer quits skip only the second-press guard.
- Once confirmed, quitting never waits on a person; a fixed deadline ends the app.

Status: Built. Detail: [Workspace: Quitting](workspace.md#quitting), [DESIGN.md: Accessibility](../../DESIGN.md#accessibility).

### Window defaults, ground and drafts

A new window, its background and its drafts behave predictably.

- Without a saved choice, a wide window starts with the right dock open where the active pane has a dock subject, and a narrow one with it closed. The bottom panel starts closed. An explicit show or hide is restored per window.
- A picture ground prints as it is, pixelated, dithered or in ASCII, always still. The desktop and the phone read one glyph table and keep their own choice.
- A start screen's ground fades to the stage's colour over its lower part, and under Glass keeps the window's glass under it, so it looks the same behind start screens only or behind every page.
- A photo ground comes from the host's background image library (8 MiB, 4096x4096, PNG, JPEG or WebP). The host refuses to delete a photo while it is showing. Ground settings are kept across kinds. _Here only._
- Settings › Background shows the library as one row of thumbnails: the photo in use wears a ring and has no Remove; a hovered tile offers Remove, confirmed over the same tile; adding says "Photo added.". The row holds its height from the first paint, so nothing late moves it. _Here only._
- Settings › Background › Customize sets the ASCII field's pattern, characters (1 to 64 code points; no controls, bidi, combining marks, emoji or whitespace), density and speed (0 to 100, default 50; 0 holds one frame). Edits preview live and save on release or leaving the field. Rows without these values draw the default field. _Here only._
- The field's average ink is no heavier than the default field at the default density, whatever the set and density, and its peak ink is never above 15%. _Here only._
- Importing a theme file whose photo this computer lacks leaves the photo out and says so in one line in Settings. _Here only._
- Plugins offer character grounds as data only (a set, and optionally density, speed and pattern), listed under "From plugins" while the plugin is installed, trusted and enabled. A pick copies the values and saves once, so turning the plugin off leaves the copy. _Here only._
- The pixel ground is an alternative to the ASCII field, which stays the default: a generated scene or a photo in the theme's ink plus the accent as one glow. A pixel ground saved with no scene draws Drift. _Here only._
- While an everywhere background covers the sidebar, the sidebar's own background is not drawn and its controls are disabled with a note; saved sidebar values are kept. _Here only._
- A new-task composer keeps its identity while its Project changes. A refused binding keeps the prior authorized Project and the draft.
- A new Chat's first-run composer stages attachments before the thread exists and sends them with the first message.
- If first-turn startup fails after the task opens, the provisional prompt is withdrawn and its text returns to the composer with the refusal reason. _Here only._
- Closing a file tab, the Files tool, its Code thread or the desktop window checks for affected unsaved Code Files edits, even when Files is hidden. Save must succeed to continue; Don't save discards; Cancel keeps it open. Closing one of two views of a file does not ask. If the window cannot answer, only an explicit native confirmation closes it unchecked, and a window closed anyway takes no input until the close or quit resolves. A window already asking is brought forward and Quit waits. See [Workspace: File editing](workspace.md#file-editing).

Status: Built. Detail: [Workspace: Right dock and bottom panel](workspace.md#right-dock-and-bottom-panel), [Application ground](application-ground.md), [Custom grounds](custom-grounds.md), [DESIGN.md: Depth and material](../../DESIGN.md#depth-and-material), [Composer row](../../DESIGN.md#composer-row) and [Draft continuity and composer notices](thread-view.md#draft-continuity-and-composer-notices).

### Usage reading and provider marks

The Usage page reports what was measured and shows each provider with a bundled mark.

- Local provider history and Octant records are separate sources; their totals are never added.
- Unknown prices and missing quota measurements are unavailable, never zero. A period change cancels the previous read and cannot render a late result.
- Provider logos are bundled and licensed, never fetched at runtime and never drawn approximately. Unknown providers get a truthful fallback.
- Interface icons follow [Visual character, voice and colour](#visual-character-voice-and-colour).

Status: Built. Detail: [Settings: Usage](settings.md#usage) and [DESIGN.md: Icons](../../DESIGN.md#icons).

### Reply detail

Reply detail chooses how much of a turn's thinking and tool calls the transcript shows open: Low, Medium or High. Settings › Text sets the default, Low unless changed; a thread may set its own level, which stays with it.

- Low keeps thinking shut and folds a settled turn's tool calls; Medium shows thinking's first line and lists the tool calls; High opens thinking, the tool calls and their summaries, also while a reply streams.
- It is presentation only: it never changes what a model is asked or what a client fetches, shows nothing the transcript does not hold, and leaves Stream replies in charge of the partial answer.
- A thread's own level wins over the default, survives a reload, and is drawn alike in every window, on the phone and in a paired browser. Changing the default never moves a thread that chose; Use default returns it.
- The levels live in the host's shell settings, out of thread journals and host export. A window writes them through the shell route, and a device paired by the host's own person through the shell settings route ([Paired devices act as the person](#paired-devices-act-as-the-person); maintainer decision, 2026-11-13). Settings saved without them read as Low with no thread levels.
- Clients that cannot read shell settings read the two fields through `GET /api/reply-detail`, authenticated and classified `settings.read-non-secret`. The route changes nothing, and those clients draw Low until the host answers.
- Purging a thread, alone, with its Project or by retention, removes its level in the same pass; a 500-entry bound (oldest first) is the backstop.
- Another window picks up a changed level when it regains focus.
- The thread menu, the palette and the remappable `reply-detail-cycle` chord (Mod+Shift+D by default) change only the thread in front, on screen; behind a covering page the chord is left to the browser. The chord announces the new level. Overrides saved before the action existed read unchanged.
- A disclosure toggled by hand keeps its state while its turn stays mounted and the level is unchanged; a level change resets every disclosure.
- The thinking preview is hidden from assistive technology, and every disclosure keeps `open` and `aria-expanded` in step.
- A streaming answer is revealed at the pace its text arrives, never in bursts, and as it arrives under reduced motion ([Thread view: Streaming and earlier messages](thread-view.md#streaming-and-earlier-messages)).
- A running turn ends with "Working · 12s · step" under its reply, and its header holds no status meanwhile; a turn waiting on the person keeps its status in the header (maintainer decision, 2026-11-24). Only a change of step is announced, never the clock.
- Consecutive read, search and list calls draw as one row ("Read 4 files, searched 2 times"). A settled turn's fold leads with its duration; the header shows a duration only when there is no fold.
- A turn's durations are journaled host facts, never renderer guesses. The host journals a cumulative reasoning total as each span ends and stamps a completed tool call's span, with any person-facing approval wait clipped to it, which the renderer subtracts ("waited 4m · ran 2s"). A turn whose reasoning text was not kept still shows its total.
- A running call, a call whose bounds are missing, malformed, batch-stamped or distorted by an unattributable wait, and every turn journaled before durations were recorded show no time. Chat's auto-answered approvals and Work's automated or system settles are never person wait. Only a journaled person answer ends a Work wait; an answer the agent refused, which Code puts back, does not end a Code wait. Owner: [Thread view](thread-view.md#turn-activity-rows).

Status: Built. Detail: [Thread view: Reply detail](thread-view.md#reply-detail) and [Transcript](thread-view.md#transcript).

## Workspace

### Responsive in-thread Find

Find keeps viewport virtualization. A first nonempty query indexes the rendered text in cancellable batches, retains no off-window DOM, and reuses its index for later queries.

- Only the current match is additionally mounted. Closing Find releases the index. Changed rows refresh in rotating batches without starving later rows while streaming.

Status: Built. Since: 2026-11-10. Detail: [Find in a thread](workspace.md#find-in-a-thread-and-a-new-thread-from-a-selection).

### Message search in every mode

Each mode has one host read that matches message text in its threads, on the desktop and the phone (maintainer request, 2026-11-14).

- Each read covers exactly the threads its sidebar and Archived group list, applies that authority on the host before the hit cap, and never searches a deleted thread or a turn a rewind removed.
- A hit names the turn that holds it (the operation, for a Code provider turn). Queries, hit counts and snippets share one set of bounds, and LIKE wildcards are text.
- The reads are GETs a paired device reaches under the overview read grant. Code and Work text is searched in rebuildable projections of their journals.
- A hit opens its thread at the matched turn, loading earlier pages as needed (a detached range for an unloaded Chat hit on the desktop; on the phone, a Code hit opens the page ending at it, with Jump to latest).
- The phone offers a waiting Code turn's usage resume; the Code conversation read carries the usage limit it stopped at.

Status: Built. Since: 2026-11-14. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects) and [Host reads and commands](host-reads-and-commands.md).

### Search across modes

Thread Search looks in Chat, Work and Code at once through one host read, `GET /api/search`, matching titles, prompts, replies and what tools did (maintainer request, 2026-11-14).

- Every word must appear in the turn or title, in any order, ignoring case; quoted text must appear as written. A turn shows once. Title matches come first, then messages, then tools, newest thread first.
- Only the threads each mode lists for the caller are searched, before the hit cap, so neither a hit nor `truncated` reveals a thread the caller could not open. A mode that cannot list is reported unavailable. The read is a GET a paired device reaches under the overview read grant.
- Tool text is each step's name and summary, the files a Work turn wrote, and a Code terminal's newest output (bounded per turn). A Chat attachment's file name counts, not its contents. A Canvas's title and text are found under the thread that made it; the desktop opens the Canvas, the phone its thread.
- A full-text index rebuilt from the journal holds it; a streamed piece is written once.
- A hit opens its thread at its turn, in every mode. The desktop filters All, Chat, Work and Code. The phone asks each paired computer and falls back to [Message search in every mode](#message-search-in-every-mode) on a host without this read.

Status: Built. Since: 2026-11-14. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects) and [Host reads and commands: Search across modes](host-reads-and-commands.md#search-across-modes).

### Mode-first navigation and Projects

The window is mode-first: a persistent sidebar, a central workspace and an optional right dock. Mode changes alter content, authority and density, never the navigation grammar.

- Home closes any reader and puts the active pane back on its mode's start screen.
- Each active thread appears once in the Project tree, under its Project or under No Project. No Project creates no Project and grants no filesystem authority.
- Sidebar reads are projection-only. Inactive modes and hidden windows pause their refreshes, and the sidebar timer never walks the checkout tree.

Status: Built. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Developer tools switch on Work Projects

A Work Project's Developer tools switch is presentation, off by default and set only by a person. A Work thread has the same shell, Git and tools as a Code thread at the same level either way.

- The switch changes what the Project shows (the Project terminal and Project actions), not what its threads may do. Code Projects have no such row.

Status: Built. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Sidebar status and next waiting thread

The sidebar speaks about what a thread is doing now with one fixed vocabulary, and a shortcut jumps to the next thread that needs the person.

- The vocabulary is Working, Needs attention, Snooze ended and New activity, owned by the domain package. Nothing to report is no status; a failure is never inferred from silence.
- The jump goes by strength of reason (approval, question, unreviewed finished turn), wraps, and adds no host read.
- Every view shows a short age by default (at most three characters) in a fixed slot. A row ends title, slot, provider mark; hover, focus and an open menu never move the mark or the title's truncation (maintainer request, 2026-11-15). A saved record equal to the old Activity default reads as never chosen and moves to the new default once.
- The Code title band shows no uncommitted-changes count: it is Environment's Uncommitted changes row, and Worktrees setup is in Environment's Changes group (maintainer request, 2026-11-16).

Status: Built. Detail: [Workspace: Sidebar thread status](workspace.md#sidebar-thread-status) and [Jump to the next waiting thread](workspace.md#jump-to-the-next-waiting-thread).

### Resuming after a host restart

A turn cut off by a host restart continues by itself unless its thread is held ([Continuing a turn a restart cut off](#continuing-a-turn-a-restart-cut-off)). A held thread shows a notice with an explicit Resume (maintainer request, 2026-11-12).

- Resume re-checks window, provider and Project authority, then queues one host-written continuation in the same thread, ahead of queued messages, with no review of them.
- A second window, a repeated click or a lost response cannot queue a second continuation.
- Resume is not an exact replay: a tool may have taken effect before the crash, and Octant promises neither undo nor deduplication.

Not built yet:

- Nothing is named, here or in the owner; the status is kept until the maintainer confirms it.

Status: Partly built. Since: 2026-10-28. Detail: [Workspace: Continuing after a restart](workspace.md#continuing-after-a-restart).

### Settling and snoozing threads

A thread can be settled (completed) or snoozed; both are overlays, not lifecycle values. **Settled** is the only name people see, and Un-settle reopens (maintainer request, 2026-11-24).

- Settling is refused, in every mode and by every path, while a turn runs, the thread waits on the person, a side task it started works, needs the person or owes it a report, or a child run runs (maintainer decision, 2026-11-25). A refused Settle names that work; Mark done marks without settling; the host's own passes leave the thread alone. An archived, deleted or purged child, an unstarted offer and a report the parent's state keeps out never hold it.
- A host sweep archives only settled threads, after a configurable delay (default seven days).
- A running thread may be snoozed; one waiting on the person may not; the wake time must be ahead. Settling drops the pin and any snooze. _Here only._
- A snooze wakes early when the agent needs the person, and a person's turn reopens the thread. A side task's report runs its turn under a snooze, which it ends early only by failing or needing the person, and brings a settled thread back (maintainer decision, 2026-11-25).
- Under **Settle threads when they're done** (on by default; maintainer request, 2026-11-24): a person's Mark done on Work or Code settles in the same update; the host as `system` settles a Work or Code thread once the turn that filed a passing `octant_report_finished` completes, matched by turn id, once, so Un-settle sticks; and it settles a Code thread once a pull request it delivers merged (delivery repository and branch, or Octant's own pull-request operations; never one its tool calls only touched), from cached evidence, never a new GitHub call.
- Nothing else settles a thread, and nothing settles a coordinator, a thread with unfinished child work, or one whose finished turn left a decision for the person. The host never marks a thread Done.
- The host records each merged pull request it accounted for (at most 32, across a repository rename), so after Un-settle or a new message only an unrecorded merge settles again. It skips a thread whose turn runs or waits on the person, a restart-surviving approval included, until a later pass.
- In the Status and Activity feed arrangements, **Working** and **Settled** sit at the foot in sight; a thread waiting on an approval or answer stays at the top under **Needs you** or **Priority**; each thread is listed once. A settled thread shows "Settled 19m ago · Un-settle" above its composer; a row's hover slot offers Settle or Un-settle.
- The command palette offers the thread in front its row's own Pin or Unpin (Code), Settle, Un-settle or Reopen, Wake and Snooze, adding no authority (maintainer request, 2026-11-25). Drafts, covered workspaces and threads without a row offer none.
- Answerable pending questions have a separate attention deferral in Home, Inbox and Review that stays discoverable, can return early, and never changes the thread, draft, answer or execution authority. Approvals and find-only questions are excluded.

Status: Built. Detail: [Workspace: Thread visibility and completion](workspace.md#thread-visibility-and-completion).

### Panes, tabs and previews

The central workspace is one recursive split tree with one surface per leaf, and every layout operation is server-authoritative.

- One visible tree belongs to one host and one mode. Each pane keeps its own Project's authority, resolved by the host from its surface (maintainer decision, 2026-11-14). A turn reaches only its own Project, and a window only the Projects its visible panes show. A cross-mode or cross-host placement, or a preview or Canvas of another Project, is refused or offered in a new window.
- In a window showing several Projects every pane names its Project, a `#` mention or dropped thread reaches nothing a single-Project window would not, and a click on a thread of a stowed mixed layout brings it back. Detail: [Threads from several Projects in one window](mixed-project-panes.md).
- A pane keeps one conversation; a thread opened in it takes its place. Tabs are only for files, previews and canvases opened over it, and add no persisted layout or authority (maintainer request, 2026-11-16).
- Kept content references persist locally per endpoint, window, pane and exact authority context, without temporary previews. Restoring reuses the authoritative selected surface with no open or side effect; every later activation is host-authorized.
- Dropping a sidebar thread on a composer attaches it as bounded context; nothing is sent or moved.
- Returning to a loaded Code thread draws its conversation in the first frame from what the window kept of its last eight threads, with nothing running behind them. The next controller reads the journal again, and nothing treats the kept text as current before that.
- Layout persists per window, mode and Project context across restart. A mode preset applies only with no saved layout or when the person restores it. _Here only._
- A new task takes the whole window: from a split, it closes the other panes in the same server step, and their threads stay listed (maintainer request, 2026-11-16). Every other open changes one pane.
- File and artifact previews are host-authorized and read-only. The renderer never receives a host path, every open is re-authorized, scripts, remote resources, macros and formulas are off, and a missing source restores as a placeholder, never another file. _Here only._

Status: Built. Detail: [Workspace: Panes and content navigation](workspace.md#panes-and-content-navigation).

### Thread info

What is true about a thread but is not part of its conversation has one home: a panel opened from the row under the follow-up composer.

- Its rows, each only where it applies, are the level in force with Access details, Reply detail, document delivery, Provider tools, Credential commands, Provider cloud sessions and Continue elsewhere. The row under the composer keeps only what changes per message, and nothing else about the thread is drawn outside the transcript and composer.
- Rows stay mounted while the panel is closed; a row waiting for the person marks the button.
- The button is Work's Project control where the Project is named, otherwise a small icon after it. The row under the composer is one row, also in a split pane, and two at a phone's width; the panel opens from its leading edge and is never wider than the row.
- The panel is a menu like the line's other menus, headed by the level in force.

Status: Built. Detail: [Workspace: Thread info](workspace.md#thread-info).

### Right dock and thread tools

The dock is contextual: it follows the active pane's thread and Project, and never shows another pane's content.

- Each thread keeps its own open and selected tools. A tool with no valid subject shows an explicit unavailable state. _Here only._
- A start screen (the welcome screen, or a new task before its thread exists) has no dock, bottom panel, tool row or uncommitted-changes count, even with a Project chosen, and nothing opens them; a request made there is dropped. They return once the task has a thread, and the window's saved dock choice is neither shown nor changed there (maintainer request, 2026-11-18).
- Environment is the thread's own surface continued to the right: a static full-height section at the dock's leading edge that is never a tile, never dragged, never a place, and never moved or resized by a tool opening or closing. Other tools open in columns to its right. _Here only._
- Environment is a flat list under section labels, each foldable to one summary row, the choice kept per window and mode. A Context section shows only the context use the host or provider reported (maintainer request, 2026-11-16). _Here only._
- Tools are fixed (Environment, panel tools) or flexible (Browser, Terminal, Review, Canvas, Document, Files, devices, Desktop; resizable, 840px for two columns).
- Open tools show as live tiles beside the thread, at most two columns of three, with one Browser tile showing the chosen Browser tab. The narrow modal draws only the focused tile. A layout is window-local presentation, never reaches the bottom panel, and changes nothing an agent may do. A move keeps every tool mounted.
- The thread keeps its minimum width whatever is open; the tool columns share what is left. A second column is the person's own arrangement and stands side by side only where there is room; when space runs short the thread gives before the sidebar, and Environment gives way while a tool is shown, its button saying why.
- Every pane has one bar, the same alone or tiled: the tool's name or tabs, its controls, then Minimise (Browser, Terminal) and Close. A top pane's bar stands in the title band (maintainer request, 2026-11-16). A tool draws no header or second title of its own under a bar.
- When a bar's controls do not fit they fold into one More menu before any state the tool reports, and a folded state stays readable as its first row with a badge on the More button. A control the tool draws itself never folds.
- Arrange is the bar's context menu (right click, menu key, Shift+F10, or Enter or Space on the bar), never a button. The bottom panel's bar is the same bar and keeps its tab strip and Add tool; the dock has neither, and a tool open but not shown is marked on its button.
- A Browser tab is named for its page's title, else its host, and reads "New tab" only with no page. A page opened from a new tab stays that tab; its session's announcement opens no second tab.
- A pane is arranged by dragging its bar, never a control in it, after 6px of travel, without a platform drag-and-drop session, so a desktop window, a browser and a test behave alike. Nothing moves before the drop; Escape or a drop outside cancels. The Arrange menu is the keyboard route through the same model (maintainer request, 2026-11-16).
- A row of tool buttons at the end of the title band opens each tool as a tile beside the focused one and closes it on the next press; More tools lists the rest and the thread's pull requests. It is the window's one row, for the focused thread, and nothing moves it (maintainer request, 2026-11-16). A split's other thread panes draw their own row at rest, where a press focuses the pane. Closing the last tool closes the dock. In a narrow window it is one Tools menu, and at 960px and under a press replaces the tool shown.
- A tool's button has a context menu with Show below, Show alone, Hide from view, the moves, New Terminal or New Browser page, and Close, and is the drag source for the dock's drop zones.
- Opening a dock tool leaves the bottom panel open; only a tool the panel already shows leaves it. A tool is on screen in one region at a time.
- A thread's Browser and Terminal can be minimised whole into live cards after the Environment section's last list section (or at the foot of the dock body where no Environment section is drawn); minimising opens a closed Environment section. A minimised tab is open but in no tile and never selected. The state is window-local and never reaches the bottom panel. The narrow modal dock draws no cards.
- A card reads only what the tool could show this window, never starts a process, writes to the journal or sends input, and is never what "the Browser is in sight" means.
- A tool is minimised by its bar's Minimise, by **Minimise to card** in the Arrange or button menus, or by pressing its pressed button. A minimised tool's button is not pressed, shows the open dot and reads "Minimised to a card"; pressing it shows the tool.
- A card's head holds the icon, title, a menu of the tool's pages or sessions (which changes only what the card shows), Show, and Close or Hide; its picture is also Show (maintainer request, 2026-11-16). Show returns the tool as its own tile, to its remembered place if it still exists, never over a shown tile.
- The Terminal card's X hides the card and stops nothing. The Browser card's X is **Close Browser** and closes the page it shows.
- A new live session leaves a minimised Browser minimised. The agent's live Browser is a card while out of sight. A closed dock shows no sign: the window has no dock toggle.
- A tool pane with nothing to show, or unavailable or failed as a whole, shows one centred state (mark, line, reason, one way out) and nothing beside it. Files and Review without a readable checkout, Run and debug with no adapter, an unreachable host, Agents with no subagents and a Browser with no thread or host Browser are that state. A thread whose folder cannot be opened gives one reason in the person's words. A Pull requests pane of a Project not on GitHub shows it with no refresh status.
- The provider's task list is drawn in the turn that recorded it, in every mode. A Tasks tool, opened only from More tools, keeps the newest list in view from the thread's own view, not the host (maintainer decision, 2026-11-24). A reopened Code thread shows no past task lists, since its conversation read carries none ([Thread view: Plans and task lists](thread-view.md#plans-and-task-lists)).
- A saved layout never starts a new shell. Restoring a Terminal tab may reattach to an existing process; otherwise it offers Start terminal.
- Git History stays read-only at every level, Plan included: browsing or refreshing it never fetches, checks out, stages, reverts or resets. _Here only._
- Code Review selects exact staged or unstaged hunks through retained host comparison identities. Stage and unstage preserve unrelated changes, and reversal confirms selected unstaged loss under the root writer guard and approval policy. Stale, unsupported and captured views never silently become whole-file mutations.
- Code Review turns a person-selected captured diff line into a local finding without execution approval, and selected findings into an editable unsent draft in the owning thread. Checkout, revision and side identity and outside-content references survive send and queue. Missing provenance refuses, and only the person resolves a finding. Receipt links never infer a missing checkout or retarget after rebind.
- Running Code turns expose bounded versioned comparisons from their recorded starting tree after typed edit activity. Captured Review stays on an exact immutable version while newer captures are announced, keeps view preferences and note anchors, and passive reads never capture. Authority, cancellation, an unavailable source and final-capture failure stay explicit.
- Hand off is authorized exactly as export is. An unreadable thread is refused identically, and a paired device may hand off only threads it may read. _Here only._
- The Files tool lists the whole bound folder. A file opens through a host-minted target id and opaque reference, never a path; a forgotten or cross-Project token resolves to nothing. _Here only._
- Vitals shows load on the thread's host (CPU history, memory, network and disk throughput, disk space, GPU, battery), each only where the host can read it, never as zero. History lives in the window for five minutes. Extra readings are sampled only for a caller that asks. A Linux server Project's server is read over its SSH connection for a local window or a device [Paired devices act as the person](#paired-devices-act-as-the-person) admits (maintainer decision, 2026-11-12). _Here only._
- Artifacts lists the thread's Project's artifacts, scoped by the host as the Artifacts page is, and opens a Canvas by `canvasId` in the dock. Chat has no Project to list, and a server Project's thread is not offered it (maintainer request, 2026-11-13). _Here only._

Not built yet:

- Vitals of a server Project in a paired device's interface: the server policy is built; the paired client's view is a follow-up.

Status: Partly built. Detail: [Workspace: Tool lifecycles](workspace.md#tool-lifecycles) and [Workspace: Tool tiles](workspace.md#tool-tiles).

### Canvas in the thread

An agent-authored Canvas is drawn read-only inline or offered in the dock, and it belongs to the thread's own resolved scope.

- An inline Canvas gets no layout, plan, comment or action runtime, so nothing drawn there writes a version.
- A prototype starts only when the person presses Run. Octant never moves focus into a running prototype.
- A thread whose binding the host cannot resolve is refused rather than given an assumed scope.
- A turn's Canvases sit inside its last reply, between its tool rows and its text. An inline Canvas shows whole up to 1,200 px, then fades into Show the whole Canvas (maintainer request, 2026-11-23).

Status: Built. Detail: [Workspace: Tool lifecycles](workspace.md#tool-lifecycles) and [Canvas: Presentation and schema versions](canvas.md#presentation-and-schema-versions).

### Device panes and disposable desktops

Device panes offer only actions the host supports, and input is a separate explicit approval.

- Allow input is a per-destination native approval. Clicking the screen or a key button cannot grant it.
- Closing a pane does not shut down its device. When several devices run and none was chosen, the pane asks.
- A disposable desktop tab never reconnects on its own after a reload; the host holds no view across a restart.

Status: Built. Detail: [Workspace: Tool lifecycles](workspace.md#tool-lifecycles).

### Routines and subagents

Agents may propose routines and delegate work, but only the thread's agent starts a subagent. A routine exists only through a person's confirmation, on the person's own request (active outside Strict on an unmarked thread, paused under Strict), or at Full access on the agent's own suggestion (maintainer decision, 2026-11-12), active unless the person's Settings keep it paused (maintainer decision, 2026-11-25; [Routines](#routines), [Octant's own limits become settings](#octants-own-limits-become-settings)).

- A proposed follow-up, and below Full access a proposed routine, waits as a suggestion chip; dismissing it declines. A routine's runs get at most the creating thread's access.
- An agent's request to pause or archive its routine (cancel, for a follow-up) waits as the same kind of card with its reason; dismissing keeps the routine. What a run's agent reported shows beside the run in Automation Center.
- The Agents dock shows and controls subagents without starting them. Every subagent, started by Octant or the provider runtime, is a row in one list and graph naming its provider and model. A provider-started one reads "Started by <provider>", nests under its parent, and has no managed controls (maintainer request, 2026-11-15).
- A provider-started subagent offers Stop only while the running turn can stop that one alone; the reported state stays until the provider reports it finished.
- Its model, final summary and token usage show only where the runtime reports them, a missing value as unknown, never zero. The summary reaches the person, never the parent's context.
- The graph shows which runs each waits for; a graph card opens what a list row opens, and a dependency is named only where the window may read that run.
- The transcript lists each subagent under the turn that was running when it started, as one tool-like row that opens the child in Agents; the rows and the composer's card read one summary per pane (maintainer request, 2026-11-17; [Thread view](thread-view.md#subagents-in-a-thread)).
- Run time counts from request or first sight to last update. A folded card whose children work with nothing waiting reads "Waiting on <A>, <B> and N others", each name a link. A delivered result reads "<Role> subagent finished · worked 48s" with Show result; a stopped or failed child keeps the full card (maintainer request, 2026-11-18).
- Every subagent row leads with its provider's logo and names the model as the picker does; a run that reports none shows neither, never its parent's.
- The Environment Subagents row opens by itself while a subagent works, one compact row per running run (at most five) and an "N finished" line, with no Stop (maintainer request, 2026-11-16).
- At rest Environment hides rows that say nothing: Local servers and Computer use while none exist, Pull requests off GitHub; an empty Subagents row is not a button. The spend ceiling is one row with a popover. Branch and Project rows carry Switch branch…, New task on another branch…, Worktrees and Move to Project; Changes keeps New task in this Project in a "…" menu; Routines keeps Follow up later and New routine in a "+" menu.

Not built yet:

- Stop for a provider-started subagent on Codex and ACP agents: those runtimes report it unsupported; Claude and OpenCode have it.

Status: Partly built. Detail: [Workspace: Routines](workspace.md#routines) and [Subagents](workspace.md#subagents).

### Boards and pull requests

Work and Code have server-authoritative boards. Chat has none, and an agent cannot mark any thread Done.

- Cards cannot be dragged between columns. A person marks a Work thread Done with no confirmation, and Reopen undoes it in one click. A Code thread reaches Done when its delivery target is satisfied or a person marks it Done as their own override (maintainer request, 2026-11-12).
- A Code card may show one plan-progress count computed at read time, absent with no live plan, never on Work cards. _Here only._
- The pull request list is a cached host-local snapshot; board queries never call the forge. A card says fresh, stale or unavailable. The forge is reached only by explicit refresh or a per-Project opt-in cadence (off by default, floored at 30 seconds).
- The Pull requests page is a flat, sortable list, groupable by repository, beside a reading pane with Summary, Changes and Timeline tabs. Sort, grouping and filters are remembered in the window. Sort offers Newest and Oldest by creation time from the same read; a row without it goes last (maintainer request, 2026-11-12; maintainer decision, 2026-11-21).
- The Auto-refresh and Agents may merge switches keep their labels, setters and server enforcement, in the repository group's menu or the Repository settings menu. Where agents may merge, the group header shows a chip and the settings button a dot.
- An Involvement filter (involving me, review requested, authored by me, which is "Mine") shows while the GitHub login is known. A multi-select Repository control, shared with Issues, is remembered in the window. Involvement, Review and Checks last for the visit only.
- Issues share the row, sorting, Repository control, status chips and reading pane, and render markdown. A closed issue says why (completed, not planned, duplicate, or plain Closed), and Closed narrows to Completed or Not planned. Issues read no GitHub Project status and ask for no further GitHub access.
- Pull-request state colours are named tokens (`--oct-pr-open`, `--oct-pr-merged`, `--oct-pr-closed`, `--oct-pr-draft`, `--oct-link`, each with a fill) behind one shared state mapping (glyph, words, token) used by the review panes, lists, chips and Inbox's GitHub rows. Mono greys open, merged and links, and keeps closed red and every glyph. Owner: [Workspace: Pull requests and issues](workspace.md#pull-requests-and-issues).
- A sidebar row and its details card list every pull request the thread worked on (maintainer decisions, 2026-11-23): up to 50 in the navigation entry (3 on a board card), in flight, then merged, then closed, newest first. The card shows one line each and scrolls past ten, Environment folds past ten, and the row counts the rest (#327 open +15). The model shows beside the provider.
- A pull request a thread's tool calls created, merged or reviewed links the thread as its delivery branch does, offering babysitting and line notes; linking alone starts nothing. Every GitHub and Linear issue a thread's tool calls touched is listed in Environment and, at most five, in the card; the row shows no issue count. Only a write counts, only by an exact identity the call gave, read by one shared provider-sdk parser (proposal approved 2026-11-24).
- In Environment each open pull request ends with its one next step: Resolve or Fix (on GitHub), or Merge, whose own Merge confirms the method (maintainer decision, 2026-11-24).
- A pull request chosen there opens as a tab of the pane in the reading view, whose More actions offers Unlink from this thread. A person's journaled unlink wins over all linking evidence, across a rename, until the thread touches it again; the thread keeps its newest 50 unlinks (maintainer decision, 2026-11-24). A routine and an agent grant may not unlink; a device may as [Paired devices act as the person](#paired-devices-act-as-the-person) allows (maintainer decision, 2026-11-25).
- Open pull requests of one repository that each build on the one before show as one stack, bottom first, with "2 of 4", in the hover card, Environment and the Pull requests list (maintainer decision, 2026-11-25). It is derived from the cached snapshot and never asks the forge. A fork's pull request, a shared head branch, and a base several share make none. The Merge shortcut is the bottom layer's alone.
- Line notes work on a pull request's diff (maintainer decision, 2026-11-21): a window-local note per line, sent with **Send notes** to a linked Code thread (the first by default; disabled with none linked) as one ordinary follow-up through `start-provider-turn`. Nothing is posted to GitHub.
- Before that turn the host compares the pull request's author with the signed-in `gh` login. If they differ or either is unreadable, the thread is marked as having read outside content, as Auto-fix does; if they match, the notes are plain person text.

Not built yet:

- Pull request and issue references from the OpenCode, ACP and Pi adapters: only the Claude and Codex adapters report them.
- The host in the details card: deferred.
- Stacks on the phone, on board cards and in the Project's list in Environment: deferred.

Status: Partly built. Detail: [Workspace: Boards and integrations](workspace.md#boards-and-integrations), [Pull requests and issues](workspace.md#pull-requests-and-issues) and [Sidebar](workspace.md#sidebar).

### Active work across computers

The Agents page opens on everything not Done on every computer the window already reaches, in the Board's words (maintainer request, 2026-11-25). Bots are not part of it (maintainer decision, 2026-11-25).

- One host read lists threads, coordinators, subagents and routine runs with their computer, Project, repository, branch or worktree, and linked pull requests and issues, each only when the host already holds it. One builder makes every row, its state the thread board's derivation.
- A host answers only for itself, with threads the asking window or device already lists there, under [Paired devices act as the person](#paired-devices-act-as-the-person). A subagent's task is named only where the window may read that run.
- A client merges the answers. A computer that does not answer is named unreachable with when it was last connected, with no rows; no host or hub makes a row for another. The list follows the sidebar's Environments filter (maintainer decision, 2026-11-26).
- A row opens as its sidebar row does. A paired computer's Work and Chat threads are listed but not opened from another window.
- Reads run in parallel over sessions already held, on the change feed and each paired-computer refresh, with no timer and no journal event. A paired browser lists its one host; the phone has no list.

Status: Built. Detail: [Workspace: Active work](workspace.md#active-work) and [Architecture: Security and authority](../architecture.md#security-and-authority).

### Threads from issues and repositories

A thread or Project can start from a forge issue, a tracker issue or a cloned repository, without write-back.

- Creating from an issue attaches only its identity. The server reauthorizes, frames redacted text as external content and journals the ingestion.
- A local window, or a device [Paired devices act as the person](#paired-devices-act-as-the-person) admits, may start a Work or Code thread with a labeled text handoff from a Claude Code or Codex session in its Project's root, subfolders or verified managed worktrees (maintainer decision, 2026-11-12). The server resolves scopes and provenance and refuses foreign folders and symlink escapes; clients supply no paths. It keeps only bounded visible words, marks outside content, and shows the original folder and omissions.
- This import never adopts natively and never clones the unverified native writer, since it cannot prove account binding, runtime compatibility and exclusive ownership. Native adoption is the separate path an empty Code thread offers ([Key providers run as themselves](#key-providers-run-as-themselves)). An issue and a session cannot be combined.
- Cloning verifies identity and origin, promotes atomically without overwriting, and issues a one-time binding receipt.

Not built yet:

- Starting a session handoff in a paired device's interface: the server policy is built; the paired client's control is a follow-up.

Status: Partly built. Detail: [Workspace: Boards and integrations](workspace.md#boards-and-integrations).

### Thread usage figures

Every thread shows what it used, worded by one shared module, at the top of its [Thread info](#thread-info) panel, never under the composer.

- An unreported figure is absent. A cost says "est." unless the provider reported it, and a cache hit is never rounded up.
- The figures are one block with a Turn details link, with no hide control and no setting. In a split only the active pane shows them.
- The stored `showThreadStats` value stays in the schema so saved settings decode; nothing reads it.

Status: Built. Detail: [Workspace: Context and usage](workspace.md#context-and-usage).

### Local-server stop authority

Octant stops a local server only when it can prove the server belongs to a live terminal it tracks.

- An exited shell, a reused PID or missing evidence leaves the listener a leftover that needs confirmation.
- Editor provenance labels alone never grant stop authority.

Status: Built. Detail: [Workspace: Local-server ownership](workspace.md#local-server-ownership).

### Thread recaps and notes

A thread has a person-visible recap of what it asked, did and left open, and the person may keep notes on it (maintainer decision, 2026-11-14).

- The host reads the recap on request from the newest transcript window, under the thread's open authority. It quotes the thread, names the last message it read and says when older ones fell outside. No model writes it, so it goes to no provider.
- Notes are the person's text, journaled and rebuilt from the journal. The host refuses a note from an agent or itself. A note reaches the agent only when the person inserts it into a message. Purging the thread erases its notes.
- Neither changes the thread's authority, level or Done.

Status: Built. Since: 2026-11-14. Detail: [Thread view: Thread recap and notes](thread-view.md#thread-recap-and-notes).

### Reserved keybindings

A remapped shortcut never runs alongside, or instead of, undo, redo, the clipboard or Select All.

- No global action may take Mod+Z, Mod+Shift+Z, Mod+Y, Mod+Shift+Y, Mod+X, Mod+C, Mod+V or Mod+A. Settings › Keybindings refuses it and names the command; a saved override on one is reported and the default applies. Review-page and terminal actions keep their own chord rules.
- Zen's default chord is Mod+Shift+E (maintainer decision, 2026-11-24). A chord already saved on another action keeps working.

Status: Built. Since: 2026-11-24. Detail: [Workspace: Reserved keybindings](workspace.md#reserved-keybindings).

## Start screen

### Start-screen cards

Every start screen shows one question, its composer, and one calm list under them (Needs you, In progress, Your pull requests, Continue, Open issues). Rows and cards add no authority.

- Each item shows once, at most five rows per section with See all, no card behind a row, and a quiet line with a next step when a section is empty, never fake rows.
- The composer paints first. Cards mount after the first commit, read only what the window's own authority returns, and are never mounted when off or unavailable.
- Answers, Open, Stop and Start a fix use the commands the open thread uses. An option is words sent as the next turn; Start a fix only opens a draft.
- Customize is one shell setting and ignores unknown card ids.
- Chat, Work and Code share one top-anchored start screen: the question, the [composer](#the-composer), then the mode's suggestions and list. A New task is Home with its Project named, so New task, choosing a Project or switching mode moves nothing. The composer docks at the foot once a thread exists (maintainer request, 2026-11-16).
- Suggestions sit under the composer on its edges. Code Home's four are cards that keep their room while the person types.
- The list is laid out from its first frame and nothing above a section moves while it loads: one fixed row height, the last settled answer per host and Project painted first and replaced in place, skeleton rows on a first start (maintainer request, 2026-11-15).
- A start screen has no dock ([Right dock and thread tools](#right-dock-and-thread-tools)); its ground follows [Window defaults, ground and drafts](#window-defaults-ground-and-drafts).

Status: Built. Detail: [Workspace: Start-screen cards](workspace.md#start-screen-cards), [Start screen: The list](start-screen.md#the-list) and [Card registry](start-screen.md#card-registry).

### Needs you across surfaces

Waiting requests appear on several surfaces from one host list, at a local window or on a device the host's own person paired (maintainer decision, 2026-11-12). The start-screen card, the Inbox and the phone list every waiting ask (maintainer decision, 2026-11-13; maintainer request, 2026-11-22).

- A paired browser reads the same list under its own scope.
- The start screen, board cards, palette, Inbox and Review page read the same list and answer through the mode's own command.
- The phone lists each item with its kind and the host's one line, and opens its thread, whose own card answers it. A kind this app cannot read shows as Waiting on you on its thread and never hides other rows. A thread the mode bootstrap did not list is listed from the ask's thread title.
- The phone's thread screen answers a Project memory proposal and a routine proposal or pause or archive ask on the host's memory and routine decision routes, confirming before a Save or Create; the card withdraws once answered (maintainer request, 2026-11-22). Those routes take an answer only from a device [Paired devices act as the person](#paired-devices-act-as-the-person) covers; any other session sees "Answer this on the computer" and no buttons.
- The Inbox page is raised cards in one column, its state in one line beside the title; see [Inbox page](workspace.md#inbox-page).
- The desktop menu bar lists waiting threads but only opens them.
- A waiting service offer opens in the local window whose turn raised it, never in a substitute window.

Status: Built. Detail: [Start screen: Needs you across surfaces](start-screen.md#needs-you-across-surfaces).

### Code agent home

Under the Code composer, the start screen is an agent home of work to pick up.

- Picking an item fills the prompt and attaches the issue as the thread's Create-from context.
- Code Home alone has an activity panel: four cards count merged pull requests, closed issues, published releases and finished runs over a shared or pinned per-device timeframe, against the previous stretch, from journaled facts through an authorized read or the signed-in GitHub account's bounded history. Runs always read the journal.
- Every card names its source and opens a drill-down of its records, paged at most 25 against a frozen snapshot. It compares to the previous stretch only for a complete read and says when its read is partial.
- GitHub cards read per connected repository by date. A release counts when that account created it and published it in the range. A card is partial only when a repository could not be read or a range outgrows the walk (200 matches per repository per card). Detail: [Start screen: Activity timeframes](start-screen.md#activity-timeframes).

Status: Built. Detail: [Start screen: Code agent home](start-screen.md#code-agent-home).

### First-run provider folder scan

On first run, the Project step lists folders the person already used with Claude Code, Codex, OpenCode and Pi, through a bounded host-side read-only scan, and imports the ticked ones as Code Projects in one click through the existing Project create path and folder receipts.

- The scan reads registered provider homes and extra account directories (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `~/.claude-accounts/*`, `~/.codex-accounts/*`, OpenCode data directories, Pi session directories), writes to no provider's files, and sends nothing off the machine.
- It reports credential-free `owner/name` labels (or safe single-segment folder names), providers, session counts and last activity; groups clones of one remote; excludes linked worktrees and `Downloads`; sends the renderer only opaque window-bound IDs; and says when its bounds stopped it early.
- Discovery grants no authority. Importing creates Code Projects at the first-run access level via folder receipts. Strict hides the scan and refuses import, on the server and in the UI.

Status: Built. Since: 2026-11-21. Detail: [Start screen: First-run provider folder scan](start-screen.md#first-run-provider-folder-scan).

## Canvas

### Canvas delivery and the closed block catalogue

An agent delivers anything the person will keep, share or return to as a Canvas, built from a closed, version-gated block catalogue.

- The delivery test is the answer, not the verb. When in doubt the agent makes the Canvas rather than asking.
- Findings with numbers, a trend or a comparison lead with an inline Canvas summary above the reply, and the reply adds only what the summary does not say. The tool description, the delivery instructions, the routing line and the inline result say so in the same words, held by tests. The inline form stays typed blocks and static designs, never agent-written HTML with script or network (maintainer request, 2026-11-23).
- A document that declares an older schema version but carries a newer block is refused as a future version.
- A diagram holds at most 512 nodes and 1,024 edges, re-checked by domain policy before it persists or renders. Boards embed no third-party canvas engine and run no markup or script. _Here only._
- A bounded subset of Mermaid is translated into typed blocks, with no new dependency and no Mermaid renderer. A diagram outside the subset is refused with a typed reason and keeps its raw source as a code block (maintainer decision, 2026-11-12).
- The subset covers the constructs models use most: flowchart directions, shapes, links and nested subgraphs; sequence arrows, the activation shorthand and nested activations; state descriptions.
- Styling is dropped and the diagram still imports, because Canvas applies its own theme: `%%{…}%%` directives, and in flowcharts and state diagrams `classDef`, `class`, `style`, `linkStyle` and a node's `:::class` suffix (maintainer decision, 2026-11-13).
- With no block schema change (maintainer decision, 2026-11-13): flowchart hexagon, subroutine and parallelogram nodes become a process node whose detail names the shape; `<-->` becomes one arrow each way; `click` lines are dropped. In a sequence, `loop`, `alt`/`else`, `opt` and `par`/`and` are flattened, with a note on the first message of each part and on the last message of the fragment; `Note over A,B` is a note naming no participant; `rect` is dropped as colour; `box` is a note naming its participants.
- Still refused: class diagrams, `critical`, `break`, and a fragment part with no message.

Not built yet:

- Unnamed: the entry is marked Partly built but names no missing piece (see the maintainer question).

Status: Partly built. Detail: [Canvas: Agent tool and recipes](canvas.md#agent-tool-and-recipes) and [Presentation and schema versions](canvas.md#presentation-and-schema-versions).

### Canvas preview

The agent's `preview` returns typed layout warnings and a picture drawn in a no-network headless browser.

- A model that accepts no images, or a host with no browser, still gets the warnings and a plain sentence saying no picture was taken and why.
- A Canvas read or previewed by another thread carries its outside-content mark to the reader.
- An inline preview draws at the thread's default 760 px column and warns `inline-past-cap` past the 1,200 px the thread shows whole. The tool step keeps a reference to the version it drew, never the picture, and the opened row draws that version under the window's own Canvas authority (maintainer request, 2026-11-23).

Status: Built. Detail: [Canvas: Preview and placement in the thread](canvas.md#preview-and-placement-in-the-thread).

### Designs and prototypes

A design is the author's own markup in sandboxed frames. A design that runs script is a prototype with no route out unless the person allows the network for that Canvas.

- A static frame never gets `allow-scripts`, and no frame has both `allow-scripts` and `allow-same-origin`.
- Design markup refuses remote images, stylesheets and fonts, embedded documents, and any link that is not a fragment.
- A running design runs only on Run. On desktop its network is blocked unless the person turned on that Canvas's "Allow network" switch, which is off by default and only the person sets (maintainer decision, 2026-11-12). Who may set it from a paired device follows [Paired devices act as the person](#paired-devices-act-as-the-person).
- With the switch on, on desktop and in a browser on the host's machine, a page reaches public addresses only through the host's filtering proxy: a script's `GET` and JSON `POST`, images and fonts, under a token that lives one hour and is renewed while the page is open (maintainer decision, 2026-11-13).
- In a browser on another machine the prototype is not network-contained, and says so.
- Sharing design markup needs the person's acknowledgement that it leaves as written.

Not built yet:

- The Allow network switch on the phone: the phone has no screen for it yet.

Status: Partly built. Detail: [Canvas: Design block](canvas.md#design-block) and [Canvas: Allow network](canvas.md#allow-network).

### Boards and comments

Diagram and flow boards are editable by a local person, and comments are journaled facts the host stamps itself.

- A drag or nudge is journaled as a new immutable version with the host's own actor; a stale drag is refused.
- A window on this host or a device the host's own person paired edits boards and comments; a hub-introduced device is refused (maintainer decision, 2026-11-12; [Paired devices act as the person](#paired-devices-act-as-the-person)).
- Inline diagrams follow their drawing's proportions without gaining layout-editing authority; document workspaces keep the fixed board frame. Retry loops use visible return lanes, shape-aware ports and space before neighbouring automatic-layout nodes; [Canvas visuals: Inline diagram proportions and retry loops](canvas-visuals.md#inline-diagram-proportions-and-retry-loops) owns the layout rule.
- Send to agent queues a turn under the thread's own authority and creates no new authority.
- The workspace tab's tool rail (Select, Hand, Comment, Area, Pen, Text) only chooses what the pointer does and which anchor a comment gets. It journals nothing and adds no command or authority.
- An area comment is a `region` anchor in percent of its block's drawn box. A board takes none, because its picture moves under its box.
- A drawn mark (an area, a pen line, a pinned note) is a comment's anchor, never an object of its own: it follows the comment rules and adds no aggregate, command or route. A pen line is a `stroke` anchor of 2 to 128 points bounded to the block's box; a note is a `region` of no size.
- A build older than the `stroke` kind cannot read a comment that carries one.

Not built yet:

- Board editing in the paired browser and phone: the server admits it, the paired screens are a UI follow-up.

Status: Partly built. Detail: [Canvas: Diagram boards and comments](canvas.md#diagram-boards-and-comments).

### Choices answered in a Canvas

A `choice` block asks the person a question inside a Canvas, and their answer goes to the Canvas's own thread as their own ordinary message.

- The block takes the inline questionnaire's per-question shape and bounds (a prompt, single or multiple selection, one to eight options), carries no answer, and is decoded strictly on the host.
- The block has no limit on how many questions it holds. Only the inline `ask-user` questionnaire keeps its four-question ceiling; the two have separate schemas.
- Agents are told to use a choice block whenever they need more than four answers: in the block's `describe` text, the Canvas tool description and `ask-user`.
- Choosing edits a local draft. Only an explicit Send enqueues one message on the owning thread through its message queue from the person's window, so it runs or waits like a composer send under the thread's existing authority. It is never a host-initiated turn or an approval.
- The message is host-framed text naming the Canvas, the block, and the chosen labels or written answer.
- Where no thread can take the answer (no message queue in the window, a paired client, no host scope for the Canvas, an older version, the thread's own inline view, a shared snapshot or public share page, an export), the block reads only, with a reason. A share never offers sending.
- HTML design frames gain no submission ability.

Status: Built. Since: 2026-11-11. Detail: [Canvas: Choice block](canvas.md#choice-block).

### Decision forms in a Canvas

A `choice` block is also how an agent asks for many decisions at once: sections, a note on each question, answers saved on the Canvas as they are made, a progress count, an action that accepts the agent's recommendations, and a `read` that returns the answers.

- The form follows [Choices answered in a Canvas](#choices-answered-in-a-canvas) for its question limit and when agents use it. Its answer has no count or size ceiling.
- Sections, per-question notes and `allowNote` arrive with Canvas schema version 29. A block that carries none of them keeps its document shape.
- Answers are journaled facts of a `canvas-choice-answers` aggregate per Canvas, not document versions. The host stamps the `local-user` author, no agent operation writes an answer, and a paired client reads and cannot write.
- A question an agent revised keeps its answer only when its fingerprint is unchanged.
- Each pick saves as made. Send answers is the explicit act that wakes the agent, through the thread's message queue under its existing authority, and is never an approval.
- _Accept every recommendation not yet answered_ answers only questions with an unambiguous recommendation, never replaces an answer, and marks what it made.
- The owning thread's `read` returns the answers; a question reworded after it was answered reads `stale`.
- Shares, public links and exports never carry answers or notes. Artifact sync carries saved answers, notes and clears across the person's own computers, for Canvases the replica carries under the share filter and the comment entry's ordering rules.
- Owed checks: rendered QA of a 24-question form, and a real-provider smoke of an agent building and reading one.

Status: Built. Since: 2026-11-12. Detail: [Canvas: Decision forms](canvas.md#decision-forms).

### Canvas shares and exports

A share names its Project and is judged against it.

- A Canvas owned by a Chat thread outside every Project is shared only through the export destinations. A window in Chat is offered the same destinations for it as for any Canvas, and a link destination publishes it once the person approves the card (maintainer request, 2026-11-12).
- Share versions are independent of Canvas versions. A share that declares an older version but carries a newer block is refused.
- Action blocks and source ids never leave. Exports carry no tags.

Status: Built. Detail: [Canvas: Shares](canvas.md#shares).

### Artifact library and tags

The Artifacts library is host-wide across Projects: the deliberate exception to per-window Project read scoping.

- The server decides the library's scope. A paired device is clamped to the Projects its catalog allows.
- Tags are the person's own labels, kept host-local. They never enter a Canvas version, a share, an export or sync.
- Who changes tags, reads a Claude page snapshot or copies one into a Canvas from a paired device follows [Paired devices act as the person](#paired-devices-act-as-the-person) (maintainer decision, 2026-11-12). The server admits a device the host's own person paired on each of these routes.
- The library lists every page a thread published through Claude's `Artifact` tool, in one view across the person's Claude accounts, built from the journal alone, so only pages published from Octant appear (maintainer decision, 2026-11-16).
- The listing covers each Work turn's and Code thread's published steps, scoped by the thread's Project and clamped for a paired device. It has Source, kind (Claude's types beside Canvas's kinds) and account filters, versions for updated pages, Open on claude.ai, and the dock's Artifacts tool.
- The snapshot is read through the publishing thread's own read check.
- Copy into Canvas creates the Canvas in the publishing thread's own Project and mode, with that thread as its origin, reads the snapshot on the host under that thread's read check, and runs it through [HTML import](#html-import).

Not built yet:

- Tag changes, snapshot reads and Copy into Canvas in the paired browser and phone: the server admits them, the paired screens are a UI follow-up.

Status: Partly built. Detail: [Canvas: Artifact library and tags](canvas.md#artifact-library-and-tags).

### HTML import

A person can bring one HTML page into a new Canvas. The import adds no authority and no network egress.

- It runs under the create path's authority, from a local window or a device the host's own person paired (maintainer decision, 2026-11-12).
- A paired device has no window context, so its request's workspace scope names the mode and Project. The host checks that the Project is active and of that mode before the create is journaled as the device. A Chat thread's own Canvas in no Project stays owned by the thread it names.
- The paired browser offers **Import HTML…** in a Chat thread's Canvas tools, and the phone in a Chat thread's Views and panes.
- The artifact library's Copy into Canvas imports a Claude page's kept HTML snapshot through this import, in the publishing thread's Project ([Artifact library and tags](#artifact-library-and-tags)).
- Scripts, remote assets, external links and form destinations are taken out and reported. The page is at most 256 KiB.
- The Canvas is marked outside content for every later reader. Its title is what the person typed, never the page's own.

Not built yet:

- A paired device's plain Canvas create: not built, so **Import HTML…** stands alone in the paired Canvas tools.

Status: Partly built. Detail: [Canvas: HTML import](canvas.md#html-import).

### Canvas visual system

Charts, tables, mockups, designs and flow boards share one visual system.

- Hue lives on the mark, never on the chrome. Every mark pairs hue with a second channel.
- A block that cannot be drawn falls back to its plain reading and a disclosed table.
- Series hues follow a fixed order, so a series keeps its colour across charts.
- A mockup is inert and uses neutral ink. Octant never restyles a design's inside.
- A flow board's hotspot is its only live control, and a list reaches every screen without the board.

Status: Built. Detail: [Canvas visuals: Data visualisation](canvas-visuals.md#data-visualisation), [Mockups and designs](canvas-visuals.md#mockups-and-designs) and [Flow boards](canvas-visuals.md#flow-boards).

### Project design systems

A Work or Code Project's design system is a `DESIGN.md` in its folder. Octant lists, draws, edits and creates these files; every Work and Code turn follows the governing one; Canvas designs draw with its tokens; typed Canvas blocks take its colours; and a person can swap the design system a Project or a single Canvas follows (maintainer requests, 2026-11-10 and 2026-11-11).

- The file is the source of its content, never copied onto the Project record or journaled.
- Which file is the Project's own is the person's choice (any `DESIGN.md`, or none), journaled as `project.design-system-changed@1`. Without a choice it is the top-level file, else the only one. A chosen file that is gone leaves the Project with none. The nearest `DESIGN.md` above a file governs it.
- Front-matter colours, typography, radii and spacing become Canvas brand tokens under the design brand rule. Each is reported carried, adjusted (a font stack without web faces) or refused with its reason. At most 32 are carried.
- Every Work and Code turn carries the rule to follow it and the Project's own file as keyed standing context, read from the folder each turn (a Code turn from its worktree). Nothing is added for a server Project's remote folder.
- Canvas `describe` returns the design system's tokens for every design kind (documents, decks, sites, screens, UI kits, flows). A running design copies the values into its own stylesheet. Tokens from `DESIGN.md` take the place of the brand kit.
- A Canvas may follow a design system (Canvas schema version 28). Its charts, tables, metrics, treemaps and diagrams take their series colours (the `chart-1` to `chart-6` palette, else primary and secondary) and accent from it on screen, in Present and in the HTML export. Tones and text keep the reader's theme. A Canvas an agent creates in the Project follows it.
- A person switches a Canvas to another of its Project's design systems, or none, from its More menu. The host reads the file under the Canvas's own Project and journals the switch as a version that also redraws brand designs. A device the host's own person paired may switch it as a window does; a hub-introduced or restricted device is refused.
- A window on this host or a device the host's own person paired may list, read, create or save a design system file, and every other device session is refused (maintainer decision, 2026-11-12). A save replaces only the revision it opened. No read or write follows a link. Files over 256 KiB are left to the editor.

Not built yet:

- Unnamed: the entry is marked Partly built but names no missing piece (see the maintainer question).

Status: Partly built. Since: 2026-11-10. Detail: [Project design systems](design-systems.md).

### Public links

A public Canvas link is off by default and exists only through the person's explicit act.

- Settings holds the switch, off by default. While it is off no request reaches the service; turning it off keeps existing links revocable.
- A link is published only through the export approval card, which no agent tool reaches. A paired device publishes as [Paired devices act as the person](#paired-devices-act-as-the-person) says; the paired browser offers the card to a device the host's own person paired (maintainer decision, 2026-11-12).
- Paired Chat, Work and Code readers can open an existing Canvas and copy its public links. The read grant is thread read authority: the device reads a Canvas when it may open its thread, still filed in that Project and mode, never by switching the host's Project. A refusal does not reveal whether the Canvas exists. The shared reader omits creation, editing, export and owner update and revoke controls, which stay refused to a device.
- The payload is a frozen copy with no host, Project, thread or source ids and no file contents. A Canvas has at most one active link (30-day default expiry, optional password).
- A share, public or authenticated, carries every image the document displays and nothing else: image blocks' generated images and every image a design declares (generated images, Project files, Browser captures), resolved under the version's own authority, sniffed as rasters, at most 3 MiB each and 4 MiB together, named only by the share's own references (maintainer decision, 2026-11-22).
- There is no placeholder or extra acknowledgement: the approval card shows each image and the approved digest covers it. The authenticated share panel shows each image a snapshot copies, and the host refuses a request whose digests would copy any other.
- An authenticated snapshot's journal record names images by SHA-256 only. The bytes are stored per snapshot in the host's managed store before it is recorded, checked against the digest on every read, and removed on revoke or Canvas purge; bytes a stopped host left unnamed go at the next start.
- The public service serves each image once at its own content-addressed address under the link's checks, and an image request reads only that image's byte range and the share's head; an earlier service version reads the file whole ([Stored shares](canvas-public-links.md#stored-shares)).
- Which images a design shows comes from a best-effort reading of its markup, not a parser, with its known limits accepted; the card lists every image before it leaves (maintainer decision, 2026-11-22).
- Share schema version 18 and the public share service must be deployed before a release publishes it.
- The service has no accounts. A per-share owner secret lives in the credential broker, apart from provider credentials, never in the journal.
- A first-party create commits that secret and a non-secret ownership intent before uploading. Owned-create binds a random id, the owner and the approved terms: identical retries change nothing, conflicting retries refuse, and an uncertain publication is withdrawn through durable restart and listing recovery. A host never falls back to legacy create. Key-bound ids and authenticated cancellation tombstones fence delayed creates, and an unauthorized or not-found answer never settles ownership.
- The service logs no IP address and serves design frames from a separate user-content origin.
- The reference service is `apps/share` in this repository, self-hosted by each user (Bun or Docker), with a Compose guide in Public links Settings. No service address is set by default, and Ogard Labs operates no instance.

Not built yet:

- Unnamed: the entry is marked Partly built but names no missing piece beyond the deployment gate above (see the maintainer question).

Status: Partly built. Since: 2026-10-20. Detail: [Canvas public links](canvas-public-links.md#off-until-the-person-turns-it-on) and [Publishing is the person's act](canvas-public-links.md#publishing-is-the-persons-act).

## Artifact sync

### Signed append-only replica entries

Artifact sync writes one signed, write-once entry per committed version or deletion, and reconciliation never overwrites.

- A bad or missing signature, an unknown or revoked writer, or a content-hash mismatch is refused.
- Two computers revising the same parent keep both heads. A deletion is a tombstone that stays in the history.
- A store offers list, get and put-if-absent. The folder store writes only under `Octant Sync/`, and the bucket store refuses plaintext endpoints.

Status: Built. Detail: [Artifact replica sync: Entries](artifact-replica-sync.md#entries) and [Store](artifact-replica-sync.md#store).

### Replica membership

Membership is a pure function of the pinned founder and the valid signed membership records.

- Only a strict ancestor can revoke a computer. A revoked computer's entries count up to its cut.
- Two computers that hold the same records derive the same members.
- A Full device manages membership as a local window does ([Paired devices act as the person](#paired-devices-act-as-the-person)).

Status: Built. Detail: [Artifact replica sync: Membership, as wired today](artifact-replica-sync.md#membership-as-wired-today).

### Leaving a replica

A computer may leave a replica, the founder included.

- When the founder leaves, the computers it approved directly can never be revoked, and no computer can take over as founder.
- Leaving needs the store to be reachable, unless the person confirms leaving without it.

Status: Built. Since: 2026-10-14. Detail: [Artifact replica sync: Membership, as wired today](artifact-replica-sync.md#membership-as-wired-today).

### Artifact publish and pull

Every committed Canvas version is queued for publish through the share filter, and nothing is called while sync is off.

- Nothing is queued without sync or a replica identity, or for a Code thread in Plan. An imported entry is never republished.
- Historical versions need a reviewed destination, an eligibility preview, explicit selection and consent. Progress survives a restart without duplicates, and batches keep known ancestry. A newly pulled deletion stops uploads until a published, explicit Restore of the reviewed deletion slots. Nothing backfills on its own.
- Synchronized deletion is a separate, confirmed tombstone over known versions that keeps local history. A local erase never publishes one and drops queued historical bundles. A deletion beside a concurrent revision stays visible until resolved.
- For carried Canvases, comments (`canvas-comment`) and decision-form answers and clears (`canvas-choice-answer`) use the same signed, write-once, share-filtered queue and `after`-ordered reconciliation. Concurrent answers settle deterministically; stale fingerprints stay stale.

Status: Built. Detail: [Artifact replica sync: Artifact sync: publish and pull](artifact-replica-sync.md#artifact-sync-publish-and-pull).

### Store selection

Choosing the sync store is the person's act, at a local window or a Full device ([Paired devices act as the person](#paired-devices-act-as-the-person)); it is journaled and starts with sync off (maintainer decision, 2026-11-12).

- Choosing or changing the store turns sync off. A member of a replica cannot change the store's kind or location.
- Bucket keys live in the credential store and are never journaled. A key pair is never sent to a server it was not entered for.

Not built yet:

- A paired screen for choosing the store: the server admits a Full device; the screen is a follow-up.

Status: Partly built. Detail: [Artifact replica sync: Store selection](artifact-replica-sync.md#store-selection).

## Browser

### Browser captures

Only an explicit screenshot or recording is kept, and it stays with the thread.

- The agent's screenshot and the person's Screenshot control keep a capture, at a window or a Full device. Other devices, the thread-less Project browser and a terminal CLI keep nothing. Whoever opens the thread as the person reads its captures and steps.
- `record: true` on one `steps` or `flow-run` call keeps an animated PNG of that call (at most 30 seconds, 250 ms frames, 120 frames, 800 px, 2 MiB) from the page's own screencast, with no decoding or new dependency. Plan refuses it (`recording-refused`, nothing runs; one running when Plan begins is discarded). It skips pages with a credential field, unchecked pages, pages off the approved origins and pages with no web origin, and ends with its call or when another tab comes forward (`tab-changed`). It is otherwise a capture; the strip shows it still with a play mark until opened.
- Bytes live under the data directory, never a Project. The journal records metadata and a hash.
- A thread keeps its newest 200 captures; the person sets 1 to 500 in Settings › Permissions › Browser captures (maintainer request, 2026-11-12). A capture is listed only while its bytes are held. At most 8 are recordings: a ninth drops the oldest recording, never a screenshot, by the same journal-derived rule. Captures leave the host only in the owner's thread or data export.
- The thread keeps the agent's last 50 Browser steps (operation, element role and name, origin and path, result or failure category; never typed text, field values or secret query values). Steps and captures are its "Browser proof".
- "Draw on page" keeps a capture and draws on it; "Add to chat" hands a PNG to the composer as an image attachment. It sends and stores nothing else, in a Work or Code thread's Browser only.
- The pane ends in one fixed 44px band: a pill toolbar of round icon buttons (Pick element, Point at something, Draw, Box and Text on page, Refresh notes, Cancel), each absent where it cannot be offered, with the armed tool's status and the notes' count, so a live page never resizes (maintainer request, 2026-11-16). See [Workspace](workspace.md).
- "Pick element" adds one element's selector, tag, address, a few computed styles and outer HTML to the draft, without form values, editable text, scripts, inline styles, handlers or addresses, cut at 4,096 characters (maintainer decision, 2026-11-14). The host refuses where a note's element read refuses, marks the thread as holding outside content, and keeps nothing.
- Proof reaches a pull request only when the person chooses "Include Browser proof": a "Browser check" section of numbered steps. Screenshots are saved to a folder picked at a local window, never uploaded.

Not built yet:

- The entry does not record which part is unbuilt: question for the maintainer.

Status: Partly built. Detail: [Browser captures: What is kept](browser-captures.md#what-is-kept), [Retention](browser-captures.md#retention), [Marking up a capture](browser-captures.md#marking-up-a-capture), [Proof](browser-captures.md#proof), [Recordings](browser-captures.md#recordings), [Draw on page toolbar](browser-captures.md#draw-on-page-toolbar), and [Picking an element](browser-captures.md#picking-an-element).

### Browser for agents

The agent's Browser tool reads a page as an outline with element refs and acts by ref. The server admits every operation, and every provider gets the same tool.

- A snapshot lists headings, text and controls with refs, states and values, through frames and open shadow roots. A credential field reads protected with no value, and a page that holds one shows no field values. A Private page reads every frame; a signed-in page reads another origin's frame only when that origin is approved.
- Refs live on the server. A ref the latest snapshot did not list, or whose element lost its role and name, is refused as stale before the action runs.
- An action answers with address, title, revision and one line on what changed; text, a picture or an outline only when asked. The activity preview keeps its picture through the host's peek.
- The agent hovers, chooses options, drags, presses key chords, and opens, lists, switches and closes tabs; a new tab is admitted as a navigation.
- A Private page needs no site approval at any level and goes to any site, local ones included (maintainer decision, 2026-11-17). A profile page's site approval waits for the person on no clock (maintainer request, 2026-11-12).
- A Full device acts on every Browser surface as a window does (maintainer decision, 2026-11-12; [A paired device holds a Browser page](#a-paired-device-holds-a-browser-page)). _Here only._
- `steps` runs up to 10 separately admitted operations, stopping at the first failure. It cannot nest, upload, download-save, sign in, run or save a flow, stop, or open a signed-in page.
- Waits take text, an address, a load state or an element state, all or any. Outside Strict they have no limit; under Strict, 10 minutes or the Settings › Limits value up to an hour (maintainer decision, 2026-11-19; [Octant's own limits become settings](#octants-own-limits-become-settings)). The page is kept for the wait and 30 seconds more. Actions wait for load, then 250 ms unchanged, at most 2 seconds.
- The agent answers a dialog as `dialog` on the call that raises it; no dialog waits for a model turn. Otherwise a fixed rule answers (alert and leave-page accepted, confirm and prompt dismissed), and the report says which (maintainer request, 2026-11-12). A credential prompt's text is withheld. Flows keep no dialog answer.
- `resize` sets only the agent's page to 320–3840 by 320–2160 or a preset (`phone`, `phone-landscape`, `tablet`, `desktop`), with touch emulation and color scheme; no field restores all. A page with someone else's developer tools attached keeps its touch and color scheme.
- `sign-in` hands the page to the person: a card with Continue and Cancel, the Browser forward, other agent calls held, a fresh snapshot on Continue. It has no expiry; stopping the turn, archiving, revoking the window, stopping the host, or closing the page ends it. No origin approval widens, and it is never remembered. A Full device's turn offers and answers it; routine, subagent, terminal-grant and restricted device turns are refused.
- Off-origin refusals tell the agent to stop and navigate for approval, or to sign in in the app for SSO. An expired page reports `context-expired` with its former profile and a bounded hint that keeps no content and never reopens the page.
- `flow-save` keeps up to 50 successful operations (refs as role and name, expected path and title) as a named Project flow; `flow-run` replays it without a model turn, each step admitted, stopping at a failure, refusal, ambiguous element, or wrong path or title. A step needing the person, or an address with a secret, ends what can be saved. A window or Full device manages flows; a routine may run but not save. Flows are journaled per Project, erased with it, and never exported or synced.
- The person can start a saved fixed flow in an idle Work or Code task with its current model and authority. Typed text and reviewed titles stay in memory; operations, targets and paths stay fixed. Exclusive custody, explicit Resume, revalidation and a 15-minute lifetime prevent stale replay. Server Projects and Plan refuse it. See [Flows](browser-agent-tool.md#flows).
- The person's input reaches the page while the agent acts and is never dropped. It drops the refs, the agent is told in one line, and its next click or keystroke is stale until it takes a snapshot.
- **Take over** gives the person the page until **Hand back** or the agent's next call (maintainer decision, 2026-11-17), which gets a fresh snapshot. A terminal CLI, a flow's steps, a page under a device lease, a sign-in ask and a paired owner device's control are not taken back; such a call is refused `browser-person-took-over`. Only the person, at a window or a Full device, takes over. A window's take-over is not journaled; a device's hold is.
- An owner device on a roster-only host has no Browser reach and is refused `remote-control-not-person`.
- A page lives on its caller's idle interval, renewed only by admitted work or person input. Active work has no absolute cap; creation and unresponsive actions stay bounded; an expired page never revives. The eleven-minute handoff and two-minute release windows stay separate.
- No password saving.
- The bounded synchronous script operation runs in Work and Code at Full access (maintainer request, 2026-11-12) on an existing local native page, with server authorization, native bounds, credential-custody exclusion and truthful effect and cancellation receipts. Scripts have ordinary page and account authority; redaction does not promise a script cannot see a password; main-world CSP does not bind isolated-world evaluation.
- Below Full access, a local Code task asks for one exact-source script permission bound to its HTTPS origin, profile, task, model and page. It grants page account authority, is never remembered, and never widens confinement. Plan, credential fields, incomplete frame coverage and stale bindings refuse.
- An address the person types at a window is their own browsing: the desktop Browser follows its redirects, a site off the approved origins shows only to the person, and the agent gains nothing from it. A typed address's redirect never reaches this computer or its network unless the person typed it there. A paired device's navigation keeps the approved-origin rule. The headless Browser holds the typed site (maintainer decision, 2026-11-17).
- Both Browsers refuse a page-started navigation onto this computer or its network before checking the allowlist or grants; the [Browser rule](browser-agent-tool.md) defines the check. An agent load keeps top-level redirects under the allowlist; a person load keeps local redirects within the typed origin. A local document opened explicitly by exact origin keeps moves on that scheme, host and port in its tab (on the desktop only from its main frame). The headless Browser judges frames and popups outside the tab's guard by the same rule. Nothing carries to another tab or a reopened page.
- A refusal's recovery text is the agent's alone; the pane tells the person which site the address leads to and that typing it opens it.
- A thread's first Browser page is the agent's shared page; one opened while it is live gets its own context.
- Diagnostics report console errors, failed requests and 4xx and 5xx responses (address, method, status; no body or header), and warnings on request, numbered and read after a `since` cursor.
- `audit` reads the open page without changing it, admitted where `diagnostics` is (Plan included). `accessibility` runs fixed checks (text alternatives, unnamed controls, title and lang, heading levels, referenced duplicate ids, AA contrast on solid backgrounds, focusables in aria-hidden, targets under 24 px while touch is emulated), at most 10 per rule and 25 in all. `performance` reads the load record (TTFB, FCP, LCP, CLS, TBT, long tasks, requests, redacted largest resources, DOM nodes, heap) and names what it could not measure; INP never. Results stay on this computer.
- Download-source review keeps every attested origin; Code refuses a review that cannot fit its approval-summary byte limit.
- A Project's threads drive their own pages at once, each reaching only its own context, checked on the server. The Project dock lists live pages by name only; a selected page shows its picture read-only, and a paired device sees a stored-profile page only as existing.
- The toolbar is one row under the tile bar: back, forward, reload, the address field (never a pill, holding at most a connection mark), then status (when it has something to say), Take over or Hand back, extensions, profile and More. At most three trail the field besides More; the left-most fold first, and again to keep the address 120 px wide. A signed-in profile names itself; Reclaim locally replaces Take over while a remote owner holds the page. The row never wraps. Owner: [Design system](../../DESIGN.md) and [Workspace](workspace.md).
- Idle panes and docks show the server's availability decision with a remedy, or Unknown; Plan reads as read-only. The status mark's tooltip carries the sentence, and its recovery is a More item. It grants nothing.
- Tabs, card heads and Recent rows show the page's 16 px favicon or the globe. The desktop host fetches it once through the page's session (5 seconds, 64 KB, image sniff, no redirects, one per tab, one a second) and holds it in memory. Only the preview read's `faviconDataUrl` and the window's tab-icons delta read reach the person, never an agent. A kept icon survives sleep, dimmed; the read never wakes or fetches; navigation clears it. The strip read refuses agent-owned contexts ([Architecture: process topology](../architecture.md#process-topology)).

Not built yet:

- A script permission for Work below Full access: Work is refused until it gets Code's permission under [Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on); designed, not built.

Status: Partly built. Since: 2026-11-01. Detail: [Browser for agents: Page snapshot](browser-agent-tool.md#page-snapshot), [Results](browser-agent-tool.md#results), [Page lifetime](browser-agent-tool.md#page-lifetime), [Actions](browser-agent-tool.md#actions), [Steps](browser-agent-tool.md#steps), [Flows](browser-agent-tool.md#flows), [Waiting, dialogs, and viewport](browser-agent-tool.md#waiting-dialogs-and-viewport), [Asking the person to sign in](browser-agent-tool.md#asking-the-person-to-sign-in), [Person and agent together](browser-agent-tool.md#person-and-agent-together), [Diagnostics](browser-agent-tool.md#diagnostics), [Page audits](browser-agent-tool.md#page-audits), [Download](browser-agent-tool.md#download), [Parallel threads](browser-agent-tool.md#parallel-threads), and [Bounded page scripts](browser-agent-tool.md#bounded-page-scripts), and [Workspace: Browser toolbar](workspace.md#browser-toolbar).

### Agent downloads

At Full access an agent's download is saved into `downloads/` of the thread's workspace as the action that started it answers. Below Full access it is held outside the workspace and saved only on the person's answer, unless the person turned on "Let agents download files".

- Agent downloads are on by default at Full access. Below it they are blocked unless the person turns on "Let agents download files", off by default, set from a local window or a device the host's own person paired and journaled with shell settings (maintainer request, 2026-11-12).
- At Full access a download is not held for a second call. It is saved into `downloads/` of the thread's workspace and reported as saved or refused. The temporary copy, the size cap, the link checks and the journal record stay, since none of them is a review (maintainer decision, 2026-11-13).
- Below Full access a download an agent action starts is held outside the workspace (at most 25 MB and 5 per page, Settings defaults rather than constants) and reported by name, size and sniffed type, with an optional completed-native HTTPS-origin redirect-chain receipt stripped of paths, query values and fragments.
- Per-file review names the requesting page separately from that source, or says source unverified when proof is absent. A page origin grants no download provenance.
- `download-save` does not ask at Full access, where the path checks still hold. Below Full access it asks the person before saving a new file in `downloads/` of the thread's workspace. "Always allow" is remembered per site, workspace folder and profile, in Work and in Code alike (maintainer decisions, 2026-11-12 and 2026-11-13). An unanswered ask waits for its answer and never expires into a refusal.
- Programs, installers and scripts are refused only below Full access. A symbolic link is refused. A terminal grant and Plan cannot save. A device the host's own person paired saves as a local window does; a hub-introduced device is refused (maintainer decision, 2026-11-12).
- A download the person starts in the Browser pane saves to the Downloads folder at every level. The desktop pane counts a download as the person's when they were the last to drive it.
- Headless downloads enforce the in-flight size cap even when concurrent arrivals cannot be attributed: every ambiguous candidate is cancelled when a candidate file exceeds the cap, and already attributed downloads stay independent. A cancelled download cannot become held through a late completion.
- Saving pins the destination as a physically verified working directory and creates only an exclusive relative basename, so a directory or link swap cannot redirect the write or cleanup. Unsupported save platforms refuse.
- The trusted internal selected-destination port accepts an approved main or extra Project root and an existing reviewed relative directory, with mandatory device and inode identity and currentness, and never falls back to a checkout. The native writer verifies that exact held identity and physical path, bypassing a cached working directory.
- Final synchronous source, authority and quota admission follows byte reads and read-only target proofs, refusing a changed sniffed prefix before using its type facts. Even default folder creation waits until dispatch.
- Ordinary production saves use workspace downloads and their existing receipts. Selected receipts identify their approved root and keep their path relative to it.
- A separate local-person recurring-download manifest binds the current routine, model, authority and profile, the exact page and attested source-origin set, approved folder and directory identities, sniffed types, count and byte limits, and expiry. Account permission stays separate.
- An eligible routine can omit the manifest id on a save to discover only its own current-profile scopes, without saving or consuming quota, then retry with a matching returned id. Final synchronous quota admission precedes exclusive native dispatch. Uncertain effects are never refunded, held ids are one-use, selected-root receipts stay distinct from workspace receipts, and restart restores no grant.

Not built yet:

- Downloads in the paired browser and phone: the server admits a person-paired device, the paired screens are a UI follow-up.
- A person's Browser pane download in a packaged window: not yet run.

Status: Partly built. Since: 2026-11-12. Detail: [Browser for agents: Download](browser-agent-tool.md#download) and [Recurring download manifests](browser-agent-tool.md#recurring-download-manifests).

### Agent uploads

An agent uploads only plain files from the thread's workspace by relative path. At Full access an upload does not ask; below it, it asks.

- Ordinary uploads use the thread's workspace and relative plain-file paths: at most five files of 25 MiB each, both Settings defaults rather than constants (Largest file, and Files per upload, 1 to 50) (maintainer decision, 2026-11-13).
- At Full access an upload does not ask and the path checks still hold. Below Full access it asks, and "Always allow" is remembered per site, workspace folder and Browser profile, in Work and in Code, which ask on the same Browser approval card through one function (maintainer decisions, 2026-11-12 and 2026-11-13).
- An answer remembered before the page was recorded keeps covering the site and folder on every page, as when it was given, until the person forgets it. An answer given on a Private page covers Private pages alone (maintainer decision, 2026-11-13).
- An unanswered ask waits for its answer and never expires into a refusal ([the Full access rule](#the-full-access-rule)).
- A device the host's own person paired has its "Always allow" remembered as a window's is, journaled as that device. A restricted or hub-introduced device's answer covers one transfer only.
- A local person may separately review a fixed-content routine upload manifest from one current approved Project folder, with the exact routine, model, authority, profile and site, file identities, types, byte and count quotas, and expiry. Account access stays separate. Children, terminals and ordinary turns inherit no recurring file permission.
- Changed files or root, expiry or revocation refuse, close affected contexts and release retained copies. Quota is journaled before effect and not automatically refunded. Restart restores none.

Status: Built. Since: 2026-11-12. Detail: [Recurring upload manifests](browser-agent-tool.md#recurring-upload-manifests).

### Browser profiles and extensions

Browser pages may keep sign-in in a Project or Personal profile. Private is the initial default, and extensions are enabled only per profile.

- A local person may journal a Work or Code task's default profile: a default, not a pin or grant. Excluded callers never silently get Private.
- The tool contract advertises named-account selectors (`account:<id>`), terminal MCP discovery included; using one still needs the caller's own profile and site permission.
- Switching profile closes the earlier context and withholds its observations; refused or expired stored access never falls back to Private. A switch stages a fresh context with one final task, page and authority check; a failure keeps the old page, task and draft. Unsaved forms do not carry over.
- Work and Code revalidate the binding before agent reads and actions; a remembered grant holds for the same model and authority, and a different one asks.
- On a profile page the agent needs a site approval per origin and profile, for reading too, at every level, Full access included. The person may remember it or allow all sites in the profile (maintainer request, 2026-11-12). Credential fields stay protected.
- A persistent grant, "this routine or child may use profile X on sites Y", survives restarts and updates (maintainer request, 2026-11-12) only when a clean close journaled it live, its expiry has not passed, and its caller, model, authority, definition and profile are unchanged. A crash, an unsaved revocation or an unreadable record restores nothing. An audit record alone never revives authority. Transfer manifests and owner control get no new scope.
- The person may grant one same-Project managed child a bounded, expiring, revocable session permission for a stored profile and exact HTTPS sites. It allows no transfers, sign-in, credential use or scripts; the child owns its context and borrows no parent page. A waiting review runs nothing.
- Work keeps ambient network off; a site-limited Browser permission changes no other tool.
- A named, enabled local routine may get a seven-day permission (at most 30), bound to its definition, model, authority and Project. Each dispatcher-proven run owns its context and proves its checkout; changing or ending the run withholds observations.
- A running terminal may get its own profile and site permission, bound to its transport grant and current Code task, model and authority, ending with the terminal.
- The person reviews session permissions at a window or a Full device; other devices are refused. See [Delegated sessions](browser-profiles.md#delegated-sessions).
- Only the person installs and enables extensions, at a window or a Full device (installing from a folder needs the native picker, so it stays at a window); any other device may list them. Install never enables; no agent, plugin or skill installs or enables.
- Background native ownership is a default-off host preference. Only newly reviewed child or routine permissions bind its exact generation, each run under its own checked lease. Last-window close may keep those pages; switch-off, cancel, expiry, revocation, a generation change or Quit ends them, and restart restores none. No window, headless fallback or other authority is lent.
- An execution page idle five minutes, or past four live execution contexts, hibernates: views close, context, lease and tabs stay, and the next action reopens them (maintainer request, 2026-11-14). Packaged acceptance in the native test Space is a check still owed. See [Background native ownership](browser-profiles.md#background-native-ownership).
- Extensions get `chrome.tabs` (query, get, create, update, sendMessage) for their profile's pages in the window, and `chrome.action.onClicked` without a popup. They open pages only to origins the page admits, and see addresses only with `tabs`.
- A selected-item permission records a reviewed account, vault and item and an exact HTTPS top-frame, profile and scope, for at most eight hours, apart from store unlock, OAuth and cookies. Each fill needs a fresh form review and approval; submit is separate. Values stay between the host consumer and the native form, and receipts say no, possible or completed effect. A fill does not mean signed in.
- Approved SSO hops are temporary and bound to the view, keeping task and profile without widening agent origins. MFA, CAPTCHA and uncertain results stay manual. No iframe or script execution is added. See [Browser sign-in](browser-agent-tool.md#asking-the-person-to-sign-in) and [the credential boundary](../architecture.md#linked-secret-stores).

Not built yet:

- A restored persistent grant takes no lease on the background native owner, so it runs only while a window holding its Project is open: not wired yet.

Status: Partly built. Since: 2026-10-31. Detail: [Browser profiles and extensions: Profiles](browser-profiles.md#profiles) and [The agent on a signed-in page](browser-profiles.md#the-agent-on-a-signed-in-page).

### Terminal Browser grant

A person can lend a Code thread's Browser to a CLI in that thread's terminal, with no new authority.

- The grant is off by default and switched on per terminal by the person, at a window or a Full device. It applies to Code threads only and serves only the Browser family. Another device, a routine or an agent cannot ask.
- Calls run as the thread under the existing Browser policy and approvals. Stored profiles need a separate session permission ([Browser profiles and extensions](#browser-profiles-and-extensions)) in an independent context, invalidated by changed task authority and closed with the terminal.
- The grant lives in memory and ends on switch-off, terminal close, thread completion, archive, purge, window revoke or host stop. The token is never journaled.
- The paired client shows no switch yet; the host admits a Full device's request.

Status: Built. Detail: [Terminal Browser grant: Current behavior](terminal-browser-grant.md#current-behavior) and [Lifecycle](terminal-browser-grant.md#lifecycle).

### Search queries on a tainted thread

Under Strict, on a tainted thread the harness refuses a web search query that looks like it carries data, before any request leaves. Outside Strict Octant adds no such filter: the query goes to the person's configured endpoint and the thread keeps its mark (maintainer decision, 2026-11-21).

- It covers every `web-search` call the harness's tool-call policy decides, a harness Chat thread's included. Chat reads Strict as the host does: Strict when it is the Code or Work default.
- Refused patterns include long text, URLs, email addresses, long hex runs, escaped bytes, base64 and high-entropy tokens.
- It is a guard, not a privacy rule: under Strict, choosing Full access for a thread or a Project's new threads lifts it, and the mark is only recorded. A caller that cannot say whether Strict is on keeps the refusal.
- Rationale: it refused ordinary searches naming a URL, an address or a long phrase, and the query reaches only the person's own endpoint ([Octant adds no restrictions of its own unless Strict is on](#octant-adds-no-restrictions-of-its-own-unless-strict-is-on)).

Status: Built. Since: 2026-11-21. Detail: [Search queries on a tainted thread](search-query-taint.md#refused-patterns).

### Browser profiles with cookie import

Browser pages can keep sign-ins in named profiles, and the person may import cookies from another browser into a profile.

- Octant never opens another browser's profile in place; only the person's explicit pick of a browser and profile brings its cookies into a Project or Personal profile.
- The person imports every cookie or one site's and its parent domains'; the journal records only that it was limited to a site.
- A Chromium-family key comes through the macOS Keychain prompt, so import stays at a local window; a refusal imports nothing. Cookies are never logged, journaled, returned to a window or sent off the Mac; the journal records source, profile and counts.
- Named account profiles have host-assigned identities, native labels and separate stores. The person selects one, at a window or a Full device; task defaults grant nothing. Approval names come from the native registry, and grants and extensions stay per identity. Unknown identities, other devices, unattended callers and a missing native owner are refused. Stores and the registry are never exported or synced.

Status: Built. Since: 2026-10-31. Detail: [Browser profiles and extensions: Cookie import](browser-profiles.md#cookie-import).

### A paired device holds a Browser page

A Full device takes over, drives and hands back a page of the desktop's native Browser, answers `sign-in`, uses profile pages, and runs flows, as a window does (maintainer request, 2026-11-18). Who counts is set in [Paired devices act as the person](#paired-devices-act-as-the-person).

- Take over opens a lease bound to the thread, context, tab, top document, profile, origin policy version and the device's id, session and credential generation: one controller per page, one page per device, four leases per host. Local input at the Mac reclaims the page at once.
- The device sends only touch, touch-scroll, key, text and IME events, never a URL, selector, script, clipboard read, path or credential operation. They go through debugger commands that bypass the local input gate, so anything the gate sees is the person at the Mac. No hover or right-click. A pointer event aimed at a stale frame is dropped (`stale-frame`).
- Frames are person-only JPEGs (1920 by 1200, 4 MiB, ten a second), never in observations, captures, the journal, exports or logs, and withheld during brokered fill, script custody and native prompts.
- The host's clipboard never reaches a device; a paste is text. A file chooser takes only a device upload (10 MiB). No saved-password autofill. Input is never journaled, logged or shown to the agent, which is paused for the lease.
- The lease ends after 30 seconds without the frame stream, 60 idle, revocation, session end, page or thread end, or restart; without Hand back the agent's next call takes the page back. Limits: 60 events a request, 240 a second, 4,096 typed characters a minute, one stream, 429 past a limit.
- Holds are journaled (`browser.remote-hold-started@1`, `browser.remote-hold-ended@1`) with the device, context, tab, profile kind, first origin, end reason and counts. A device sees a profile page only while its pane shows it or holds its lease.
- The schema-only `@octant/contracts/paired-browser-control` rides the signed device session: take-over and hand-back, `POST /api/browser/remote-control/input` (increasing sequence numbers), `/file` and one NDJSON `/stream`; no WebSocket. A hub-roster device, an agent grant and a caller with no session are refused `remote-control-not-person`.
- A live real-device smoke in the packaged app is still owed.

Status: Built. Since: 2026-11-18. Detail: [Browser for agents: A paired device holds the page](browser-agent-tool.md#a-paired-device-holds-the-page) and [Browser profiles: What a paired device sees of a signed-in page](browser-profiles.md#what-a-paired-device-sees-of-a-signed-in-page).

### Page-declared tools

The Browser agent tool reads the tools a page declares for agents and calls them on that page (maintainer decision, 2026-11-14).

- Octant reads the declarative WebMCP form (a `<form>` with `toolname` and `tooldescription`), not the imperative registry, which neither Browser enables.
- A declaration is outside content: listing one marks the thread (`browser-page`). It is bounded, framed as evidence, and adds no tool by itself.
- A call fills the form, and submits only when the page declared `toolautosubmit`, under the same runtime, site approval and credential rules; a form with a credential field is never listed or called.
- Below Full access each call asks, naming site, tool and arguments, never remembered. At Full access it runs unasked unless [The Full access rule](#the-full-access-rule)'s pay, buy or send-as-the-person entry covers it.
- It runs on the server and the headless Browser, with a real-Chromium test. The desktop path is wired; running it in the app is a check still owed.

Status: Built. Since: 2026-11-14. Detail: [Browser for agents: Page-declared tools](browser-agent-tool.md#page-declared-tools).

## Provider runtimes

### Key provider sandbox and approvals

Under Strict or retained legacy confinement, a key provider's app-server runs inside Octant's own sandbox profile and is told the sandbox is external. Explicit Strict off uses the provider's own confinement and approvals. Full access outside Strict runs the provider unwrapped.

- Explicit Strict off uses the native sandbox and approval policy, with workspace-write or Plan read-only restated on every turn and resume ([Providers run in their own sandbox](#providers-run-in-their-own-sandbox)). Windows launches below Full access run without an Octant sandbox claim ([Windows below Full access](#windows-below-full-access)).
- Metadata catalogs use independent native leases regardless of thread defaults.
- A process carries one lease (a thread's root, mode, posture, Strict and policy scope, or a catalog lease), and a different authority on the same connection is refused as unauthorized.
- Under Octant's sandbox, Ask first and Accept edits ask for each command not known to be read-only. Ask first also asks for every patch; at Accept edits the driver answers file changes itself.
- Plan and Chat never prompt; a write fails at the sandbox profile instead.
- Full access keeps the provider's full-access mode and an unwrapped process.

Status: Built. Detail: [Provider runtimes: key provider sandbox](provider-runtimes.md#codex).

### Provider-published artifacts

A key provider's artifact publishing is off for every account until the person enables it on the host, and Canvas stays the default.

- The switch is per account, changed from the host's own window or a paired device (maintainer decision, 2026-11-12). It is refused for API-key and gateway accounts and for hosts that export their own telemetry opt-out.
- Enabling shows a confirmation that says it also turns on the provider's usage telemetry. Error reports and conversation uploads stay off.
- Outside Strict the offer follows [Claude artifacts and Claude Design work as in Claude Code](#claude-artifacts-and-claude-design-work-as-in-claude-code). Under Strict the launch offers the tool only in a Work or Code session outside Plan, on a subscription sign-in, for a thread that chose it; every other launch keeps the full guard set.
- The launch lifts exactly one telemetry guard, `DISABLE_TELEMETRY`, only for the sessions that need it: under Strict, and outside Strict while the person's provider telemetry switch is off (the default). With that switch on, the launch carries no telemetry guard of Octant's to lift.
- The person's own opt-out always wins over the setting, and a host-level umbrella opt-out is never removed.
- The environment is fixed when the runtime starts (once per turn), so turning either choice off takes effect on the next turn.
- Each publish asks below Full access; at Full access nothing asks, publishing included ([Hosted artifact publishing](#hosted-artifact-publishing)). Plan never publishes, and published pages are reported as outside content.

Not built yet:

- Changing the switch from a paired device: today only the host's own window changes it.

Status: Partly built. Since: 2026-10-28. Detail: [Provider runtimes: artifact launch](provider-runtimes.md#claude-code) and [Model endpoints: provider artifacts](model-endpoints.md#claude-artifacts).

### Claude Code's Code Mode is a recorded gap

Claude Code's Code Mode is a workflow Octant does not carry yet, recorded as a gap to close (maintainer decision, 2026-11-14): it runs only in an interactive terminal session and refuses to start while `DISABLE_TELEMETRY` is set.

- Octant adds no terminal mode for it.
- Outside Strict telemetry is the person's choice: with **Let providers send their own telemetry** on (off by default), a launch carries no `DISABLE_TELEMETRY` of Octant's ([Provider telemetry and self-update are the person's switches](#provider-telemetry-and-self-update-are-the-persons-switches)). Strict keeps it set.
- A [provider terminal](#provider-terminals) opens Claude Code's own interface in a Code thread with the environment that thread's turns launch with (maintainer decision, 2026-11-21). Under Strict Code Mode does not start there. Outside Strict the terminal follows the telemetry switch as the thread's turns do, except for a thread that keeps or chose a sandbox.
- Once the Agent SDK supports Code Mode, Octant offers it under the thread's level like Claude's other tools. The `REPL` tool is offered outside Plan under the shell's rules.

Not built yet:

- Code Mode in Octant's sessions: the Agent SDK does not support it yet.

Status: Designed, not built. Since: 2026-11-14. Detail: [Provider runtimes: Code Mode](provider-runtimes.md#code-mode).

### Lightweight-runtime app tools

App-managed tools reach a lightweight-runtime session from 0.85.1, the earliest release whose tool attestation, approval bridge and confinement Octant verified, when its probe attests the tool bridge. A release between 0.85.1 and 1.1.0 keeps them unverified ([Provider releases are ranges, not pins](#provider-releases-are-ranges-not-pins)).

- A newer release that attests the tool bridge needs no Octant release.
- A release older than 0.85.1, or one whose probe does not attest, refuses a session that offers tools and names 0.85.1.
- A session runs on the model it was opened with; a resume that names another model is refused.

Status: Built. Detail: [Provider runtimes: lightweight runtime](provider-runtimes.md#pi).

### ACP agents share one stack

Every ACP agent runs on one shared driver stack. A new agent is a profile row, a runtime profile, a logo and conformance evidence; it never adds its own transport, supervisor, protocol client or event mapper.

- Capabilities an agent lacks (compaction request, history retention) are reported unsupported, never imitated or estimated.
- Every agent records usage (maintainer decision, 2026-11-20). A profile naming a reviewed reading (Mistral Vibe 3.0.3) keeps it from that release on, unverified on a later one. Every other agent, added ones included, reads ACP's standard usage and declares it supported: the prompt reply's tokens reconciled against `totalTokens`, a `usage_update`'s context, `thoughtTokens` as reasoning, and a US-dollar cumulative cost's growth since the last settled turn (or the cost reported while loading a session). A turn with no new cost update is unpriced, not zero, and so is the next, whose growth spans the estimated turn; exact charging resumes after that. Usage observed before a turn fails is kept (a pinned reading only once a snapshot arrived after the turn began) ([Usage an ACP agent reports](provider-runtimes.md#usage-an-acp-agent-reports)).
- Each built-in profile's usage reply shape is a live-probe check still owed.
- Octant's tools reach an ACP session only through the session tool bridge, only when the agent advertises HTTP tool support, on macOS, Linux and Windows (`appToolBridgeReachesLaunchOn`; [Linux parity for provider tools](#linux-parity-for-provider-tools), [Windows below Full access](#windows-below-full-access)). Otherwise a session offered tools is refused before it starts.
- A profile is reviewed after a live probe against a signed-in Apple Silicon install, recorded as a smoke test and a conformance case; it may ship before that as an unverified profile ([Any ACP agent can be added](#any-acp-agent-can-be-added)). A release newer than the reviewed ones keeps their features at every level, unverified ([Provider releases are ranges, not pins](#provider-releases-are-ranges-not-pins)).
- A session-kept approval chooses the agent's own `allow_always`, never for a one-call answer (an automatic reviewer's, or a child run's under Strict) or under persistence `project-default` (maintainer decision, 2026-11-21). A Code thread whose own persistence is `project-default` answers for one call whatever the host default; a driver given no persistence treats it as `project-default`. Offered only `allow_always`, any other approval is refused and nothing is sent. In a helper run under Strict such a request is denied on arrival.
- For every provider, a Code thread set to `current-session` under a `project-default` host default carries its persistence on each allow (`ProviderApprovalAnswer.persistence`), remembered for the session where the driver can hold it there (ACP `allow_always`; Codex `acceptForSession`, from its own sandbox outside Strict only; Claude Code's gate). OpenCode and Pi keep asking. `scope: "once"` wins, and an allow from anyone but the host's own person carries it. A Codex process or retained ACP session that may hold session answers never serves the thread's next turn once it is set to `project-default` ([The thread's own persistence](provider-runtimes.md#the-threads-own-persistence)).
- A profile whose agent folds a second `session/prompt` into the running turn (`steersMidTurn`) offers the SDK's `steer` as another prompt on the session; the turn ends when the last open prompt answers. Other agents offer no `steer` and refuse a prompt sent mid-turn.
- A turn's 15-minute silence budget restarts with each agent message and when the last running tool call settles, stands still while the agent waits on Octant or a tool call or subagent it started, and is a hard cut-off in every mode (maintainer decision, 2026-11-22). A non-select config option is left out instead of failing the reply, and audio goes as an `audio` block where advertised.
- One ACP process belongs to one Octant session and is never shared. An unknown required method, malformed frame, duplicate response id, uncorrelated approval, impossible ordering or contradictory outcome is a protocol error; unknown optional notifications never promote a capability; a version string alone proves nothing. _Here only._
- A permission request carrying only a tool-call id shows the latest description from that session and grants nothing. A Code thread journals the opaque provider session reference before its first prompt and resumes with only the new message, failing explicitly (never into a fresh session) when the reference is missing or rejected. _Here only._
- A configured provider CLI is always the provider-owned executable at its stored absolute path. Octant never copies, downloads, replaces or bundles a duplicate binary, stores no provider token and needs no second login; the exception is a registry agent the person's own Install step puts in Octant's managed folder. Reusing a host profile exposes only allowlisted profile paths; roots, temp state, network, tool callbacks, approvals and confinement stay app-managed. _Here only._

Status: Built. Detail: [Provider runtimes: ACP agents](provider-runtimes.md#acp-agents) and [probe rule](provider-runtimes.md#probe-before-a-profile-ships).

### Local-server provider adapter

A local-server provider adapter gives each acquired connection its own process and one live session. Under Strict below Full access, app tools reach it only when a process receipt proves outside tool sources cannot enter.

- Ordinary inherited configuration gives no such proof, so under Strict below Full access the adapter reports app tools unsupported. Outside Strict a Work or Code thread below Full access is offered them labelled as mixed ([OpenCode runs as itself](#opencode-runs-as-itself)).
- At Full access a runtime whose inherited configuration cannot prove tool exclusivity is still offered Octant's tools, labelled as mixed (maintainer request, 2026-11-12). The adapter reports `appManagedToolsAtFullAccess: "mixed"` for a Work or Code thread's own turns where the connection check saw the runtime accept the tool endpoint, and the thread's access details show the label.
- A child agent session, a routine's own Browser target and a saved flow follow the level the turn runs at, as a thread's own turns do (maintainer decision, 2026-11-13).
- The private endpoint binds calls to that connection's immutable session and exact offered tool catalogue.
- Process exit, stream failure, interruption and scope cleanup retire pending tool requests.

Not built yet:

- Mixed tools at Full access beyond a Work or Code thread's own turns on macOS and Linux: the original entry claims only that scope as built and names no other gap (see the maintainer question).

Status: Partly built. Detail: [Provider runtimes: local-server adapter](provider-runtimes.md#local-server-provider-adapter).

### Runtime updates

Octant tells the person when a newer runtime release exists, and runs the runtime's own updater only when they click Update CLI. Discovery never installs or updates anything.

- Each lookup is one anonymous registry GET with no task, thread, Project, account or host identifier. A successful answer is cached for one day and a failed or refused lookup for one hour. The check is never made at discovery.
- The check follows the Marketplace fetches switch; with the switch off no request is made.
- Nothing updates by itself, and the runtime is probed again after the updater exits so a release that fails a floor shows its reason.
- Update CLI runs only the configured absolute binary's verified update subcommand, only when no active session uses it, on the owning host. The renderer never receives an updater command. _Here only._
- The updater is a documented exception to deny-default confinement (unwrapped, host environment, bounded output) and must exit before another session is admitted. Failures reach a client only as a bounded diagnostic, never raw output, arguments, environment or paths. _Here only._

Status: Built. Detail: [Provider runtimes: runtime updates](provider-runtimes.md#runtime-updates).

## Model endpoints and organization sign-in

### Provider catalog

Settings lists bundled provider drivers, runtimes and model endpoints in separate sections. Bundled drivers need no install or trust step, and opening a catalog page runs nothing ([Provider catalog, discovery and outside drivers](#provider-catalog-discovery-and-outside-drivers)).

- A trusted outside driver appears in its own third section, labelled as outside, and its provider is added off.
- A scan points a runtime whose saved binary is gone at the launcher it found for the same driver, and a scan-created runtime saves that launcher, not the versioned file; neither turns the runtime on. An existing but incompatible binary is only offered a replacement, on the card's row.
- Who may supply an API key: [Provider keys on a host without the desktop app](#provider-keys-on-a-host-without-the-desktop-app).

Status: Built. Detail: [Model endpoints: provider catalog](model-endpoints.md#provider-catalog).

### Sign-in lifecycle in Settings

Opening Settings never starts a sign-in or acknowledges terms. Sign-in begins from an endpoint's detail page.

- Returning to Settings resumes the originating window's pending host attempt; repeated Begin requests reuse it. Attempts do not survive a host restart.
- Sign-out asks the provider to revoke, then removes the local grant; if revocation fails it keeps the grant and offers an explicit local-only removal.
- Settings begins a device-code sign-in and shows its code only in a local desktop window ([Organization sign-in flows](#organization-sign-in-flows)).
- An organization endpoint offers no key, and a key endpoint cannot become one. Changing the client, scope, issuer binding or address signs the endpoint out.

Status: Built. Detail: [Model endpoints: subscription sign-in lifecycle](model-endpoints.md#subscription-sign-in-lifecycle) and [cloud sign-in](model-endpoints.md#organization-sign-in-amazon-bedrock).

### Endpoint addresses, keys and model limits

A model endpoint's key belongs to the address it was entered for, and a model's limits come from the best source that names them.

- A saved address change deletes the stored key, and the field says so before saving.
- A remote endpoint uses HTTPS; plain HTTP only for loopback, and for Ollama on a private network as [Provider reach Octant no longer narrows](#provider-reach-octant-no-longer-narrows) says.
- Limits and capabilities come from the first source naming them: observed behaviour, runtime metadata, reviewed catalog metadata, user-supplied metadata, then unknown. User-supplied metadata can make a model selectable but never authorizes a side effect. _Here only._

Status: Built. Detail: [Model endpoints: endpoint address and stored key](model-endpoints.md#endpoint-address-and-stored-key) and [endpoint list](model-endpoints.md#octant-harness-model-endpoints).

### Organization identity stays in the broker

An endpoint can sign in with an organization directory account or a cloud identity. Reusable identity material lives only in the credential broker, and the server sees at most one short-lived, audience-bound credential per request.

- Refresh tokens, directory sessions, cloud keys and temporary cloud credentials never reach the server, a provider child, the renderer, the journal, logs or exports.
- A missing, expired, revoked or mis-bound identity reads honestly in readiness and never falls back to another sign-in. An API-key path stays available.
- A remote principal other than a person-paired device never starts a sign-in, refreshes, signs out or changes broker material ([Host-driven provider sign-in and cloud signing](#host-driven-provider-sign-in-and-cloud-signing)); it may run turns on a signed-in instance.
- A sign-in binds to its tenant or issuer, client and endpoint origin, checked at sign-in, on configuration change, per request and on probe. A mismatch is incompatible, and editing the binding drops the grant.
- The access token is resolved per send, with one forced refresh on a 401. Transient failures keep the grant; sign-out deletes it.
- Live checks against a real tenant, gateway and cloud account are maintainer live checks still owed.

Status: Built. Since: 2026-10-26. Detail: [Enterprise provider identity: authentication vocabulary](enterprise-provider-identity.md#authentication-vocabulary) and [binding](enterprise-provider-identity.md#tenant-audience-and-endpoint-binding).

### Organization sign-in flows

Each organization sign-in uses the narrowest flow that works. The organization registers its own public client and enters its client id; Octant needs no account of its own, and another product's client id is refused.

- The desktop signs in with authorization code and PKCE on a loopback redirect; a gateway signs in only that way. Continuous access evaluation is not requested.
- A device code is Azure AI Foundry's per-instance opt-in and Amazon Bedrock's single sign-on portal flow. It begins only through the host-local `/api/desktop/provider-sign-in/begin` and `/poll` routes, which the private listener never forwards, and its code shows only on the host: in the terminal that ran `octant provider sign-in`, or in a local desktop window whose main process calls those routes with the bridge secret (maintainer request, 2026-11-12; `providerDeviceSignInRoutes.ts`, `apps/desktop/src/providerDeviceSignInControls.ts`). No unauthenticated page, remote browser, hub, peer or agent grant begins one or sees a code, since a code on a page someone else can reach is how device-code phishing works.
- Cloud request signing uses the cloud's single sign-on device authorization, held in the broker, or "Use my AWS profile" (off by default) or long-lived access keys with a warning ([Provider reach Octant no longer narrows](#provider-reach-octant-no-longer-narrows)).

Not built yet:

- A paired device beginning a device-code sign-in over its authenticated session (maintainer decision, 2026-11-12): the host-local routes are not forwarded to paired devices yet, so today none can.

Status: Partly built. Since: 2026-10-26. Detail: [Enterprise provider identity: maintainer decisions](enterprise-provider-identity.md#maintainer-decisions).

### Identity paths not offered

Two identity paths are deliberately not offered.

Not built yet:

- A cloud sign-in whose bearer is valid across the whole account (Google Vertex): deferred until an organization needs it; the only acceptable shape is a broker-side relay forwarding to the bound host.
- Organization identity for runtimes that spawn a child: they keep their own delegated login and report organization identity kinds incompatible; a host relay needs its own design.

Status: Partly built. Since: 2026-10-26. Detail: [Enterprise provider identity: maintainer decisions](enterprise-provider-identity.md#maintainer-decisions).

## Outside provider drivers

### Admission of an outside driver

An outside driver is a harness-endpoint transport or a media generator ([Outside media generation drivers](#outside-media-generation-drivers)), installed from outside Octant. Harness endpoints and media generators are admitted; outside agent CLIs and managed processes are not.

- One "Install and trust" flow covers inspect, install, trust and enable, as for any plugin or connector (maintainer request, 2026-11-12). The package review is the one confirmation; the host runs the steps in order through each separate action's own lifecycle method, and a refused step stops the flow with the earlier steps standing and is named to the person. Each step stays available on its own.
- Digest-bound trust and confinement are unchanged. Add provider, connection check and Verify tools stay separate actions that the flow does not imply.
- Only the host's own person runs these steps, at a local window or a device they paired, journaled with that device as actor (maintainer decision, 2026-11-12). Structured references, tool calls, routines, hubs, peer hosts, agent grants and a device the hub's roster introduced cannot.
- A driver is a single ES module on the server's runtime, with no executables, native addons or install scripts.
- Outside harness endpoints work in Chat, Work and Code with verified-model tools, like bundled endpoints.
- On Linux an outside driver is admitted under the same steps and runs without confinement, labelled ([Linux parity for provider tools](#linux-parity-for-provider-tools)).
- The live loopback smoke on macOS is a maintainer check still owed.

Not built yet:

- The one flow for a package that holds no provider driver: the host refuses it today.

Status: Partly built. Since: 2026-10-26. Detail: [Outside provider drivers: admission lifecycle](outside-provider-drivers.md#admission-lifecycle) and [first use case](outside-provider-drivers.md#first-use-case-an-outside-harness-endpoint).

### Outside driver confinement and credentials

Each outside driver instance runs in its own confined process with no network, no filesystem beyond its package and no credential. The host does the network call.

- The environment is a fixed minimal set; no provider keys, broker coordinates or Project paths.
- The host leases a key for that instance only, refuses any URL outside the configured base-URL origin, and follows no redirect off it.
- Model traffic therefore reaches only the address the person entered.

Status: Built. Since: 2026-10-26. Detail: [Outside provider drivers: driver process](outside-provider-drivers.md#driver-process-and-confinement) and [credentials and egress](outside-provider-drivers.md#credentials-and-egress).

### Outside driver provenance and updates

Updates are never automatic, and trust binds a content digest. Marketplace packages must be signed; local folders are unsigned developer input.

- A new digest arrives held and untrusted; the instances stop until the person trusts it, and trusting clears their Verify tools records.
- An update the pinned publisher key signed keeps the trust and the on switch the package had, both journaled again after the update. A new key, a missing signature, a package with no pin, and an update that widens what the package may do ask again (maintainer decision, 2026-11-12).
- A marketplace package carries a publisher signature, the key is pinned at first trust, and a version signed by another key is held until re-trusted.
- A driver comes from a local folder or from a signed npm package. The host checks the download against the integrity the registry published, the signature names the npm package, and nothing from the package runs when it is fetched.
- A package's identity is its registry and name, so a new version updates the same package. An update check asks the registry the package was installed from and installs nothing.
- Publishing the author kit to npm needs an npm organization and stays a maintainer action.

Status: Built. Since: 2026-10-26. Detail: [Outside provider drivers: provenance and updates](outside-provider-drivers.md#provenance-and-updates), [signature rules](outside-provider-drivers.md#signature-rules) and [npm source](outside-provider-drivers.md#npm-source).

### Outside media generation drivers

An outside package can provide an image or video generation driver, installed, trusted and enabled like any other plugin, and Octant's media tools use it as they use a bundled driver: the same card, price, spend limits, storage and restart rules (maintainer approval, 2026-11-22).

- The package declares its models and published prices as manifest data. The host reads a price only there, at the digest the profile binds, reserves before dispatch, never settles above the reservation, and refuses an unpriced model under a spend limit.
- The driver runs in the same confined process and reaches its provider only through the brokered call to the configured origin. The host checks the images and clips it returns and fetches an address only when the provider's own answer named it.
- A driver that is not installed, trusted and enabled at its digest is not offered, and its jobs are refused before anything is reserved.
- What an outside video clip may have cost is decided from what the host saw leave and come back, never from what the driver says. A start the provider did not refuse outright, and an accepted clip whose end the driver cannot state readably, settle at the estimate. A driver names counts, never amounts, and a clip never settles above its reservation.
- A brokered `PUT` or `DELETE` may serve only a video driver's own call, and every request of a video driver names the call it serves.

Not built yet:

- The Settings form that changes an outside media profile's address or models: not built yet; image and video generation themselves are built.

Status: Partly built. Since: 2026-11-22. Detail: [Outside provider drivers: outside media generation drivers](outside-provider-drivers.md#outside-media-generation-drivers).

## Device workbench and mobile

### Simulator pane and captures

The iOS Simulator pane shows the Simulator's screen streamed through the host as a live view, authorized like a screenshot and never stored. Without a live view it shows the latest host-held screenshot evidence.

- A raw screen capture lands in a host-private directory that the confinement profile denies to every launch except the capturing one.
- The desktop starts one native device helper per Simulator on first use, stops it when idle or late, and never lets it outlive the desktop. A Mac without the developer tools gets a refusal. _Here only._
- The host chooses live-view size, quality and frame rate. Frames are dropped under pressure, viewers share one stream, and frames are never journaled or put in model context. _Here only._
- Owed checks: a packaged-app device check and an Android emulator device check.

Status: Built. Detail: [Device workbench: device pane](device-workbench.md#device-pane) and [screen captures](device-workbench.md#screen-captures).

### Device input

Simulator input (tap, swipe, key, typed text) goes only through the native device helper. Octant never scripts the Simulator app, and without the helper input is unavailable.

- Typed text is sent only for plain ASCII on a supported QWERTY layout and is refused whole otherwise, so Octant never types the wrong text.
- Each action's evidence records who asked (Agent, You, Remote device, Octant) in a bounded recent list. Evidence is not journaled as separate input events.
- Typed text and secure-field values never enter durable evidence verbatim, only redacted length or class markers, and post-input screenshots mask those regions. _Here only._
- A finished input action id returns its recorded evidence without repeating the effect. One interrupted or unknown after restart refuses with a distinct status. _Here only._
- A swipe lasts 50 to 5,000 ms and carries the same authority, approval, attribution, booted-destination rule and Plan refusal as a tap. A sent swipe records both ends whether delivered or not; one that never ran records why. _Here only._
- Pinch, multi-touch, long press and follow-the-finger drag are accepted non-goals. Only taps and straight single-finger swipes reach the device.

Status: Built. Detail: [Device workbench: input channel](device-workbench.md#input-channel), [typed text](device-workbench.md#native-device-helper-and-typed-text), [swipes](device-workbench.md#swipes) and [accepted limits](device-workbench.md#accepted-input-limits).

### Device effects

Open URL, Rotate and Record screen are effects, not input. A person or an agent may request them, and Allow input never covers them (maintainer request, 2026-11-12).

- Repair input is input: a live Allow input grant covers it whoever asks (maintainer decision, 2026-11-12). The agent's Simulator tool offers it as `repair-input` under the same check (maintainer decision, 2026-11-13).
- `octant_apple` and `octant_android` offer the effects as `open-url`, `rotate`, `start-recording` and `stop-recording`.
- Plan refuses them. At Full access an agent's request is sent unasked; below it, the thread raises its own confirmation for each. The host asking on its own is refused.
- Open URL accepts only a credential-free http or https address of at most 2,048 characters, in parsed form. Other schemes are refused at the contract.
- Evidence for Open URL keeps only the origin, never the path or query.
- Owed checks: the effects on a real Simulator and a real emulator.

Status: Built. Detail: [Device workbench: Open URL](device-workbench.md#open-url).

### Managed device tools and the Android emulator

The streaming tools behind the device panes are vendored, pinned and integrity-verified, and run unconfined under Octant's signed identity with an allowlisted environment. The Android emulator is a separate dock destination and tool.

- Updates are off by default and activate only while idle, after a smoke launch. A failed release keeps the previous one.
- The tools receive no provider keys, tokens or broker credentials.
- Octant installs only a checkout-relative APK and never stops the shared debug-bridge server.
- Emulators Octant boots cold boot with no snapshot by default. Snapshot boot is the setting Android snapshot boot in Settings › Code › Devices (maintainer request, 2026-11-12).
- Shutdown is approval-gated and counts as done only after the emulator stays off the bridge for 15 seconds.

Not built yet:

- A confinement profile for the managed tools: not written yet, so they run unconfined.

Status: Partly built. Detail: [Device workbench: managed device tools](device-workbench.md#managed-device-tools), [Android](device-workbench.md#android) and [boot](device-workbench.md#boot-from-the-android-pane).

### The phone is a remote client

The host is authoritative for mode, Project, thread, provider, approval and Done. The phone runs no agent loop and holds no checkout or provider credential, and the host checks and journals every mutation.

- A notification is awareness, never authority. Opening it lands on the thread under the ordinary session and biometric gate.
- A new phone capability is a new input or output on an existing route class, admitted by the fail-closed remote route classifier.
- On a host whose own person paired it, the phone sets a thread's mode, the open thread's Project mode and the default for new threads, Full access included, with the one-time warning kept per host and no owner unlock. It offers Always allow in this Project on a rememberable tool prompt (maintainer decision, 2026-11-12). A restricted session sees neither.
- Sensors are touched only on an explicit, visible act of the person.
- The app receives no over-the-air code updates. Every build carries its own JavaScript.

Not built yet:

- Phone screens for the rest of what the host accepts from such a device (packages, providers and keys, paired devices, host controls): not designed for the phone yet.

Status: Partly built. Since: 2026-10-26. Detail: [Mobile maturity: the phone stays a remote client](mobile-maturity.md#the-phone-stays-a-remote-client).

### Phone push notifications

Push is off on the host and for every device until the person turns it on, and every notification is sealed so the delivery path learns nothing. Delivery goes through an Octant push gateway that stores nothing per device.

- The envelope carries only a fixed placeholder. The content is encrypted to the phone, and the lock screen shows kind and computer label unless the person opts in to thread titles for that phone.
- The host cannot hold the platform credential, so the gateway issues delivery capabilities and accepts only requests signed by the host named in the capability.
- The gateway issues a capability to any caller presenting a platform token, without app attestation, and limits deliveries per phone.
- A person who builds the phone app from source can make their own hub the push gateway with their own credentials.
- A thread move held for an owner phone is its own notification kind, with no thread in it and its own receipt, sent once per wait to the source's owner phones only (maintainer request, 2026-11-09).
- The host side is built and verified against a local gateway.

Not built yet:

- Gateway deployment, platform credentials, the native phone pieces and live delivery: maintainer gates.

Status: Partly built. Since: 2026-10-26. Detail: [Mobile maturity: delivery path](mobile-maturity.md#delivery-path), [what leaves the host](mobile-maturity.md#what-leaves-the-host) and [building the phone app yourself](mobile-maturity.md#building-the-phone-app-yourself).

### Phone capture and voice

The phone can attach a camera photo, library image or file, and dictate a prompt, with all processing on the host.

- The host strips location and other identifying metadata from every image a paired device uploads, before it is stored or sent to a provider.
- Voice is transcribed on the host's Voice endpoint, never the phone's recognizer, in clips of at most 60 seconds, with no audio kept.
- The phone requests no location access, and the microphone shows only while transcription is ready.
- Owed checks: physical-device passes.

Status: Built. Since: 2026-10-26. Detail: [Mobile maturity: capture](mobile-maturity.md#capture) and [voice](mobile-maturity.md#voice).

### Android builds and public stores

Android gets internal builds of the same remote client by link. Public store preparation is in preview scope; listing and submission are separate maintainer actions.

- Internal distribution uses signed builds by link. The Android hardening adapters and workflow are in the repository.
- Public store distribution requires a clearly labelled offline demo and no Octant account. Fresh-install entry comes before the live session. Sample interactions and preferences stay in memory, device effects stay unavailable, and leaving discards sample changes.
- The shared composer keeps its input and Send above the onscreen keyboard at standard and larger system text. Its Project and host context wraps and constrains long labels while keeping full accessible names and font scaling. The transcript stays scrollable above the composer.
- Native and store acceptance is separate from the source implementation.

Not built yet:

- The Android build and device pass: waiting on the maintainer.
- Store listing and submission: separate maintainer actions.

Status: Partly built. Since: 2026-10-26. Detail: [Mobile maturity: Android](mobile-maturity.md#phase-b-android-internal-builds-of-the-same-client) and [public stores](mobile-maturity.md#phase-e-public-store-distribution).

## Hubs and Nightly

### Hub and spokes

A person's own devices form a hub-and-spoke topology: a hub is an ordinary Octant host with a role, spokes are the person's other computers, and phones and browsers join as guests. Each host stays its own authority.

- A spoke's hub grant is a closed list chosen and changed only on that spoke. The hub cannot read credentials, loosen sandbox or approval policy, or decide a risky action.
- Authority checks and the journal stay per host. The hub never acts on an owner's behalf.
- Members are the person's own devices over a private network only. There is no public internet path.
- A spoke accepts new members automatically as full members, and every spoke and owner device alerts on each. A setting holds new members until an owner confirms.
- Browser guests reach each spoke directly at its own name, so the hub never sees spoke traffic.
- The hub runs as a boot service under the person's account and keeps its keys in an owner-only file on an encrypted disk.
- A registered SSH server can be made a member from Settings: [Adding a computer over SSH](#adding-a-computer-over-ssh).
- Work and Code turns on Windows follow [Windows below Full access](#windows-below-full-access).
- Owed checks: real phones, passkeys, networks and providers.

Status: Built. Since: 2026-10-28. Detail: [Hub and spokes: roles](hub-and-spokes.md#roles), [hub grant](hub-and-spokes.md#what-the-hub-may-do-on-a-spoke) and [decisions](hub-and-spokes.md#decisions).

### Windows host storage and the foreground host

On Windows the server and member keep their identity, listener, roster and authority stores in the native-held private profile, and refuse an unsafe or malformed record rather than replace it or fall back to an ordinary file.

- Two fixed records hold the P-256 server and member identity, keeping the projected host identity and the non-exporting public signing contract.
- The listener TLS store admits only its own fixed key and certificate records. Key creation is exclusive (a concurrent first use adopts the winner), renewal keeps the SPKI pin across restarts, a corrupt or exposed key refuses without rotation, and explicit listener key transitions refuse on the native store.
- The roster-key store keeps P-256, SPKI and P1363 and its immutable key across restarts and concurrent creation, refusing before ordinary-file access when storage is unsafe or missing.
- The hub, delegation and Tailscale-certificate authority stores use three closed native profile files with bounded chunk sessions and their existing schemas and retention.
- Atomic replacement requires the active claimed owner (process, environment, profile) and revalidates PID and birth at commit; retained readers do not block newer commits. A flushed private stage denies competing writers and deletion while readers coexist, and grants no file permissions.
- The foreground host admits the actual SQLite main handle before application SQL and releases its native guard only after close (Bun finalizes prepared statements first), keeping WAL and read-only consumers. Backup labels and the restore stage get native no-create family and alias inspection; backup verification uses actual-handle admission, and VACUUM and atomic recovery keep the trusted local-owner boundary.
- Four fixed boot projection, policy and log files reuse bounded native sessions with owner-only publish and removal. Discovery reads claim no ownership, and only matching instance and bridge generations are cleared.
- Foreground composition consumes these stores and the fixed portable assets before server imports.
- Native stop waits for its exact authenticated connection's written-response or closed receipt, retiring an unresponsive peer within a bound. No unwritten or unrelated receipt dispatches the action.

Not built yet:

- Proof through the actual entrypoint, for both profiles, of loopback Chat readiness, authority negatives, verified backup and joined shutdown: owed before foreground admission.
- Executable extensions and unadmitted linked-store state: unavailable until they have native private admission.
- Desktop and Nightly bootstrap, disk-encryption setup and service integration: separate gates.

Status: Partly built. Since: 2026-10-28. Detail: [Hub and spokes: boot-key storage](hub-and-spokes.md#the-hub-is-a-server-first).

### Adding a computer over SSH

A registered SSH server becomes an Octant member from Settings without visiting it: the signed headless build, carrying its own runtime, is installed over SSH as a user service after one confirmation, and is updated or removed the same way (maintainer decisions, 2026-11-19).

- A window, or a device the host's own person paired, opens one sheet naming the server, its login and `uname -sm`, the build's version and signature check, the install location in the login's data folder, the user service, the one administrator command for starting at boot (Octant never runs sudo), the private listening address, and the hub it joins.
- Confirming installs and starts the build, turns on its listener and joins the hub. The join code goes in the same SSH session on standard input, never an argument; a CLI that cannot read it there fails the join step. The hub approves that one ticket only when the comparison code read over SSH matches.
- Agents, routines and hub-introduced devices are refused. The request and each step are journaled on the server registry with the actor and no join code, ticket or secret. No credential is copied.
- A server registered with a key Octant keeps is reached with that key alone, through an agent socket offering only it, never the person's agent. With no key held, nothing runs.
- With no suitable build in the data folder's `headless-builds` (none for the target, or none newer for an update), the host downloads one from its ring through the updater's feed, checking the signed listing `<ring>/<target>.octant-headless.json`, then the digest, then the build's release signature. The download lives only while a sheet reads it (cancelled 30 seconds after the last one closes) and keeps nothing; a hand-placed build is kept, and an unreachable or empty ring makes the sheet say where to place one.
- A final release outranks its candidate. An archive unpacking past 2 GiB is refused. A retry resumes past an install this hub's earlier attempt left as the exact confirmed build at the same login and host.
- Update checks the newest newer signed build as install does, then drains as the person chose (maintainer decision, 2026-11-19). **Wait up to N minutes** (1 to 60, default 10) runs `octant server drain --wait N`: new Chat, Work and Code turns and routine runs are refused while running turns finish, until none runs or the bound passes; a turn refused before its provider starts stops counting, and a refused Work wake-up waits for the drain to lift. **Stop now** does not wait.
- Update then stops the member (restart continuation resumes cut-off turns), runs `octant server upgrade`, and reads its signed hello over the hub's pinned connection. A failed drain or stop rolls back and lifts the drain. A missing hello, a wrong signer or version, or a protocol range that does not cover this computer rolls back to the previous `current` version, and the sheet says why.
- A migrating update leaves the owner running for the upgrade's backup and graceful stop. A plan whose starting version is no longer current is refused at confirmation. A same-store swap whose new service did not start rolls back.
- Update needs the hub role on and the running hub listing the member, checked at read and at confirmation, since no hello is believed while the role is off.
- Remove Octant leaves the hub (or the hub removes the member by its join identity, never its listener address), removes the user service (`octant server disable --remove-service`), and deletes the install, keeping the data folder unless ticked; logs inside it go with it, logs outside stay, and the sheet says so. Removal is refused up front for a CLI without `--remove-service`, and while the hub role is off and the kept roster still lists the member. After the person cleared a stale roster entry, a `not-a-spoke` answer counts as left.
- Editing a server's alias or login ends its standing as an Octant computer.
- Tested against a stand-in `ssh`, signed build, hello and release host. A real machine is a maintainer check.

Not built yet:

- A join from a member's window, pairing with no hub, and starting a Mac at boot without a login: not designed yet.
- Offering Wait only where the installed CLI can drain: an older one fails the Drain step and is rolled back.
- Refusing a Chat Retry, a compaction or a helper agent while draining: not wired to the drain.
- Rolling back a confirmed swap that migrated the store: the person restores the backup.
- Reading the hello again after a roll-back: not built.

Status: Partly built. Since: 2026-11-19. Detail: [Hub and spokes: adding a computer over SSH](hub-and-spokes.md#adding-a-computer-over-ssh).

### Hub failover and owner devices

One hub is active at a time, with a named standby that stands in only while the hub is down. A device the host's own person paired acts on that host with a window's powers and no unlock; owner devices matter only where a hub's own rules need a named owner (maintainer decision, 2026-11-12).

- Members fail over after five minutes without the hub by default. A standby that stands in may add and remove members, and removal wins when the hub returns.
- A standby promotes to hub for good only by a local action the person confirms.
- The owner unlock gates only what the hub's rules reserve to a named owner: owner changes and a thread move's ticket. Full access, merge, runtime approval answers, private approval reads and administration need no unlock from a device the host's own person paired (maintainer decision, 2026-11-12).
- On a spoke that knows a device only through the hub's roster, only an owner device acts with a window's powers, after a fresh unlock. One unlock (biometrics, passcode or passkey) covers five minutes of administration. Full access, merge, credential copy, owner changes and a thread move's ticket each need their own. Private approval reads and runtime approval answers ride the five-minute session by default; per-answer unlock is a setting a window on the host sets (maintainer request, 2026-11-12).
- An owner phone confirming a move a window holds unlocks once on its own device and answers the destination's challenge itself. Only the ticket id reaches the source.
- Local Work thread access recovery uses the same signed owner route, a target and current-Project digest, and fresh Full access proof, with the Work service journaling the owner principal. Its four levels stay distinct from Code Plan and persistence. The change neither resumes a running turn nor answers a waiting approval. Server Projects keep their separate boundary.
- One-use owner recovery of local Code and Work runtime file and confined Shell approvals goes through separate signed read and answer routes, which ride the open session by default. It requires complete bounded Read, Write and Edit facts, or the whole supported native Shell command and a verified admitted-root working directory, plus exact owner, host, thread, Project, binding, callback and action digests. A changed target or a replay refuses before effect.
- Recovered runtime answers use once scope. Durable admission prevents a retry after uncertainty and records owner attribution without private action contents.
- Excluded from recovery: unsupported Shell runtimes, Plan and Full access callbacks, background or sandbox-escape inputs, credentials, Browser and profile, publishing, structured Git administration and remembered grants. Without complete facts an approval stays unavailable. Paired-device Code answer authority is unchanged.

Status: Built. Since: 2026-10-28. Detail: [Hub and spokes: failover](hub-and-spokes.md#failover), [owner devices](hub-and-spokes.md#owner-devices) and [owner runtime approval recovery](hub-and-spokes.md#owner-runtime-approval-recovery).

### Shared sign-ins, delegation and provisioning

Credentials and work move between spokes only by explicit, narrowed, journaled acts. The receiving spoke keeps the final say.

- Subscription sign-ins held by a provider's own app are never copied. The hub can ask a spoke to sign in itself, and the person finishes it there.
- An owner with a fresh unlock may copy an API key between hosts. Both hosts journal the copy without the value.
- Delegated work is clamped to the smaller of the peer grant and the receiving spoke's own Project authority, and journaled with the requesting peer.
- Handing work to another spoke or peer host after the thread has read outside content follows the rule for helpers on the same computer: Full access does not refuse it, below Full access the thread needs its person's one `delegation` standing answer (the same answer that covers a helper on this host), and Plan refuses it (maintainer decision, 2026-11-13). The delegating spoke's parent check enforces it; a Work thread below Full access asks through the host's approval card before the hand-off, and a Work routine run refuses.
- A member takes delegated Code work only into a Code Project its person marked as accepting it, with the delivery target they confirmed (maintainer decision, 2026-11-19). The mark is a `project.code-delegated-code-changed@1` event the person sets from the Project overview (Remote, Base branch, what a delegated thread delivers); a device the hub introduced is refused.
- The receiving Code thread is a managed thread on `octant/delegated/<slug>-<request id>` from the marked target, approval-gated at most, marked as outside content from its first turn, on the first turned-on provider and model the Project's provider policy allows, with a pull-request outcome based on the repository the marked remote names. Admission is checked again just before the turn starts. A delegated Code thread never moves between computers.
- The delegating agent lists members and their accepting Projects through `POST /api/hub/peer/delegations/projects`, signed by the asking member. Each member answers only Projects open for delegated work within the grant it gave that member, by id and a bounded name, never a path. The agent's `capabilities` answer lists them by member only after marking the thread as having read outside content.
- A Code thread in a Code Project sends Code work approval-gated. A person's Stop on it cancels its remote children.
- Hub provisioning offers are data that land as proposals. Auto-apply is per kind and off by default, and a routine always asks.
- The hub's wake service and push sender are each off until turned on. The hub forwards sealed notifications unchanged.

Not built yet:

- Agent messages between members: designed, not built. They reach only Code threads a person tagged Reachable on both ends, under the receiver's Message item, and grant nothing there. The only turn one can start is a bounded, `agent`-initiated wake turn on an idle recipient whose person left Wake when a message arrives on.
- The three-host loopback smoke for a Code delegation: not yet exercised. A real-provider run is a maintainer gate.

Status: Partly built. Since: 2026-10-28. Detail: [Hub and spokes: shared sign-ins](hub-and-spokes.md#shared-sign-ins), [delegation](hub-and-spokes.md#spoke-to-spoke-discovery-and-delegation) and [wake service](hub-and-spokes.md#wake-service).

### Moving a thread between members

Before shutting down or restarting a computer, a person can move a Chat, Work or Code thread to another of their computers and carry on there. A Code thread that cannot move hands over through its branch (maintainer request, 2026-11-07).

- Only planned moves: a computer that dies without warning hands nothing over.
- Only a person starts a move. The destination accepts it only with an owner device's own fresh unlock and its Move in peer-grant item, and the thread is the person's own there.
- The unlock is this Mac's Touch ID, or an owner phone confirming a move the window holds: the phone gets the ticket from the destination with its own fresh unlock, bound to the ticket route and a body naming the source and held threads, and hands the source only the ticket id under an administration-class unlock there. The source holds the move in memory for five minutes, freezes nothing until the phone confirms, and spends each confirmation once.
- A waiting move tells the source's owner phones once per wait (one per destination batch) through the sealed notification path, only to paired devices of guests on its owner list with Approval needed on, naming only the destination. Tapping opens Moves waiting for you; with Notifications off nothing is sent (maintainer request, 2026-11-09).
- A browser passkey cannot confirm a move: it belongs to one origin, and confirming would need a cross-origin read and write to the source. Not planned.
- The source freezes the thread before sending and erases its copy through the ordinary purge only after the destination commits, so one copy takes turns at a time unless the person chooses otherwise.
- History, attachments, original inputs, generated images, captures, owned Canvases, and a Code thread's branch and uncommitted work travel with no size limit. Credentials, the provider's session, Full access, grants, processes and ignored files never do.
- Bulk parts are re-homed with new ids. One the source cannot read stays behind, named in the "Moved to" record; one the destination cannot record refuses the arrival. The Secret guard reads a Code thread's checkout and a Work thread's folder files, not these parts.
- A Work thread brings its own folder's files only when it is the folder's sole user: the subfolder of the Project's main folder it started in, with no other Work thread in or below it and no Project folder in it, since which files a thread made in a shared folder cannot be told. A thread in the Project folder or an extra folder moves only itself (maintainer request, 2026-11-09).
- Ignored files, `.git`, links, special files, files the Secret guard refuses and anything past 10,000 entries stay behind. The rest travel as one `work-files` part, each file with its size, digest and `mode & 0o777` bits (never setuid, setgid or sticky), counted in the move's size.
- Files and folders land with their bits, never wider first (folders private while filled, then set exactly). Each file is read through a no-follow handle whose device and inode must match the walk; a file swapped for a link is never read, stays behind and is named.
- The destination never writes into an occupied path: it lands in `<folder>-moved-<move>`, or refuses `transfer-failed` when that is taken. Files land in a staging folder renamed into place before the thread opens, so a retry lands nothing twice. Partial writes are finished; a failed or zero-progress write never acknowledges arrival, and file sizes are verified before acceptance.
- At erase the source deletes only what it just proved travelled, never recursively: each file is set aside in a folder named for the move, compared, and deleted on a match or put back (as `-kept` beside a retaken path); folders go bottom-up with a plain remove, so an editor's write survives. The clean-up's start is recorded first, a failed one records no outcome, each clean-up first settles an earlier stopped one, and the folder is reported removed only when empty. Otherwise the "Moved to" record and tombstone name what stayed, with no remove action, and a repeated erase reports the same.
- A Code thread that cannot move is committed to its branch with a generated note, pushed when it has a remote (never forced, never to the default branch), and continued elsewhere with the note as outside content. There is no file export. The agent's summary turn is on by default, lasts two minutes, runs tool-free in plan mode, and the note goes without it when it fails. A branch found without a notice continues on the destination's default model and is erased on the source only for the commit it made.
- A move starts only in the thread's Environment tool: its Computer card lists the other computers with their eligibility and opens a move sheet saying what moves, what stays, and that the source is erased, with Move after this turn and Stop and move. Prepare to shut down is the one host-wide entry (maintainer request, 2026-11-08).
- Open there opens the moved thread in the destination's own web app in the default browser, through the continue link its paired-browser screen reads, so this computer grants nothing. The desktop opens only https on a Tailscale name; a destination with no web app gets the copied link and a sentence (maintainer request, 2026-11-09).
- The source pane shows the thread's tombstone, also after the purge from an old link, notification or search, opening only that pane and granting no authority. It offers Remove worktree for a kept worktree: a person's act at a local window, naming the move, removing only the recorded linked worktree (branch and remotes stay), journaled once, idempotent (maintainer request, 2026-11-09).
- Prepare to shut down asks before anything moves. Each row starts on Move when the destination can take it (Move after this turn when busy), else Leave here with its reason; Hand over and Stop and move are never preselected, so the usual case is one press and one unlock per destination (maintainer request, 2026-11-08). It is reached from the application menu, the menu bar and the quit confirmation's Move threads first, with per-row destinations and sizes, one unlock per destination in turn, and menu bar progress.
- A row's Hand over acts for the whole host and hands over only a Code thread on this host, not delegated or waiting to move, that the destination cannot take, without the summary turn. Files left out for holding a secret are named on its row in place of a plain Safe to shut down.
- The move sheet and Prepare to shut down show what would be sent and an estimate naming its basis: the rate of the latest full chunks to that member, or an assumed 1 MiB a second. Measuring packs, freezes and writes nothing, and reads no part's bytes: sizes come from what stores record, an owned Canvas counts as its text, and an input the scope-aware reader would refuse is not counted. A part kind whose sizes cannot be read shows Size unknown, is left out of the total, and blocks nothing (maintainer request, 2026-11-09).
- Stop and move is only the person's choice in a window, checked per thread on the server: the destination's unlock is redeemed first, the turn stops through its mode's Stop, and child runs here and elsewhere are cancelled. A turn still running two minutes later ends the move with `busy`; a thread with a child run or delegated child still going reads as busy.
- A move that cannot finish ends in an explicit This thread can't move error with one journaled reason. The thread unfreezes and stays on the source, and Prepare to shut down never says Safe to shut down while a chosen thread failed (maintainer request, 2026-11-08).

Not built yet:

- A view of another member's thread inside this window: not built; Open there uses the destination's web app.

Status: Partly built. Since: 2026-11-07. Detail: [Hub and spokes: moving a thread to another member](hub-and-spokes.md#moving-a-thread-to-another-member) and [Hub and spokes: moving a thread, screens](hub-and-spokes.md#moving-a-thread-screens).

### Coding sessions on any connected computer

A person starts and manages a coding session on whichever of their computers they choose, from any window, phone or browser connected through Octant. The hub coordinates, and each computer runs and authorizes its own work (maintainer request, 2026-11-19).

- The hub is the front door (a device paired with it reaches every member), the directory, and the owner of the shared services a specification places on it. It carries no session traffic, and two computers can pair directly with no hub. Guests and a desktop window on a member or the hub reach each spoke directly.
- A start-screen computer picker makes the thread on the computer it names, with that computer's Project, providers, models and defaults. A create the window cannot route is refused with a sentence and never runs on this one.
- For a directly paired computer, or a spoke the hub introduced, the Code start screen shows that computer's Code surface over its session. The paired-computer channel carries the Code routes (`:id` matching only a lowercase UUID), and an open thread's events are read with `wait=0` at the phone's pace. A thread started there gets the same create and workspace default as a local start, with the first model the Project's provider policy allows, and the chosen computer stays chosen while it reconnects.
- A device its own person paired may make a folder on that computer a Code Project there; a hub-introduced device is refused.
- The Code sidebar lists every directly paired computer's active threads, and the Needs you card what they hold for the person, stale and not openable while a computer is disconnected.
- A device only the hub introduced acts on a member within that member's Act hub-grant item, which names Projects and allows starting threads, answering approvals and questions, Stop, and forwarding a running server ([Dev server proxy grants](#dev-server-proxy-grants)), each checked against the item at every request. A device the member's own person paired acts as that person. Each member issues such a device its own credential; unticking Act refuses its next act and ends its sessions there (maintainer decision, 2026-11-20).
- Under Act: answers cover Code operations, Work requests, harness cards, MCP tool and Browser prompts; a Code or Work fork is refused while the host is in a hub; the member lists only the Projects the item names (Projects bootstrap and search) and holds checkout preparation, remote read and every Code turn, the first message included, to it. The start form shows only those Projects, starting at Ask first where the Project's default is Full access. A local window, a person-paired device, an agent grant and a host in no hub never read the item. A refusal names the refused action (maintainer decision, 2026-11-21).
- A desktop window on a member or the hub lists the hub's spokes as its computers, as a guest each spoke admits directly, pinned from its host's roster. The hub is listed too, labelled hub and Through the hub, but not in its own window.
- A member's window is listed on the hub without a second approval, and every spoke raises the new-member alert for it with the address it was admitted over (maintainer decision, 2026-11-21). The hub raises the direct-pairing alert for a window's first device on the hub and pushes a phone paired with it. After a listener moves, the window's next ask gets a new device and the old one is revoked; a revoked device stays refused.
- The hub admits only a window guest a member asked it to list, held to the hub's own Act list (Projects a member's window may work in, in Hub settings), read at each request; with none ticked it offers nothing to start (maintainer decision, 2026-11-21). The list is set only from a window on the hub and journaled without its Projects. The window's device is revoked with its roster entry, its member, a newer window, or the hub role turned off.
- A computer can be added as a member over SSH: [Adding a computer over SSH](#adding-a-computer-over-ssh).
- Every device connected to a hub or host is told when a new device joins or pairs: the alert names it, its private-network IP address, role and key fingerprint, offers Remove, shows in each window and app, and reaches a phone as a sealed `device-joined` push when push is on, a kind on by default with a New devices setting (maintainer request and decision, 2026-11-19). The address lives only in the alert, never in the journal. Remove stays with a window on the host and an owner device. `GET /api/new-device-alerts` serves every connected device; direct-pairing alerts are journaled as `remote.device-alert-changed@1`.
- Each member reports a load level, light, busy or heavy (busy from two live turns or elevated memory, heavy from five or critical memory), read every 30 seconds and reported once a new level has held for two minutes. The hub's status read and the member's Project list carry it, so a delegating agent's `capabilities` answer shows it.
- A window's "Take delegated work from other members" switch refuses every new request while off (`not-accepting`), including one still preparing, and lists the member as not accepting. Running work carries on, and a retried request whose acceptance was lost gets its original answer.
- A person can bootstrap a local Code Project onto another computer where the window acts as its own person (maintainer decision, 2026-11-24): clone URLs are derived from `origin` (refusing `file://`, `ext::` and other unsafe protocols); the clone runs non-interactively over the direct paired session, never the hub, with hooks and templates suppressed and strict host-key checking, refusing a non-empty folder; a one-time receipt binds it as a Code Project there. Only plain gitignored files the person ticked (none by default) are copied after; ignored directories, OS junk, symlinks, `.git/**` and special mode bits are excluded, secret-guard matches are badged, and a partial copy keeps the clone and names failed paths. Hub-introduced devices without host-person standing and agent grants are refused. A two-machine smoke is an owed maintainer check.

Not built yet:

- The rest of hub coordination, beyond guests and windows reaching spokes directly: designed, not built.
- Image attachments in a session on another computer: not built.
- Holding a Work turn in an existing thread, and Chat threads, to the Act item: not built.
- The hub telling its own window about a spoke or standby it added: not built. A real phone is a maintainer check.
- The load level beside the roster in a window: not built.

Status: Partly built. Since: 2026-11-19. Detail: [Hub and spokes: the hub coordinates](hub-and-spokes.md#the-hub-coordinates-each-member-runs-its-own-work) and [decisions](hub-and-spokes.md#decisions).

### Octant Nightly

Octant Nightly is a second desktop app that installs beside Octant, follows the preview ring (scheduled builds of `main`), and works on the same data, whose folder Octant's host alone owns. Octant is one binary with the in-app channel switch Stable | Preview | Nightly: Nightly keeps Octant on the candidate ring and adds the install row, and Octant never follows preview (maintainer decision, 2026-11-05).

- By default Nightly is a client of Octant's running host and never runs a host on Octant's data; it needs Octant installed. It retries its first window while Octant is slow to start, starting no attempt after 15 seconds and none after a refused identity. Each app validates its own signed identity once per process and its peer's on every exchange.
- For development and testing Nightly can run its own host on separate test data, with its own folder, port, logs and Keychain service names, never touching Octant's data or host.
- Nightly has its own bundle id, link scheme, command-line tool and window storage, and holds no thread or Project data.
- Both macOS desktop mains use sealed fixed entry roles. The worker runtime runs host, tool and extension Node code under a distinct identity that native peer admission refuses.
- Octant on the Nightly channel offers Nightly as an opt-in install, only on the person's action, after verifying the signed feed, the artifact hash and a Nightly-specific code-signature requirement.
- Stable and candidate builds package as Octant, preview as Nightly. One app's update never installs the other, Nightly publishes only after an Octant build exists, and each app refuses a feed signed for the other, at app-named feed files (maintainer decision, 2026-11-06). Octant builds published on preview are never offered Nightly; older candidate installs get an old-shape document.
- A Nightly client reaches native operations only with a per-window native-main token on a closed route allowlist, bound to the window lease: pickers, file handoffs, provider keys and API key pools, Code operation approvals. Remote access, hubs, pairing, launch sessions, owner unlock and host identity stay Octant-only and hidden (maintainer decision, 2026-11-06). A host lacking a feature is refused as needing a newer Octant.
- Every embedded Browser gap, accessibility included, blocks the first Nightly publication (maintainer decision, 2026-11-06). Stable holds select lists, page dialogs, link and image menus and file choosers in its hidden window, and Nightly shows each natively with single-use identities and no new authority; `window.open` keeps Stable's refusal. Email, number and rich text fields compose with a caret on its own line, in same-site and cross-site frames. A password field reaches Nightly only as its identity, while Nightly holds macOS secure input.
- While an assistive technology reads Nightly, Stable sends a bounded, schema-checked mirror of the page's accessibility tree (roles, names, values except a password's, states, bounds, order, focus, live regions, across frames), rendered as a transparent DOM subtree for VoiceOver. Its actions return as the person's own input, refused while an agent holds the page.
- Windows Nightly keeps the local-user trust floor through a native private-profile named pipe: kernel-held PID and creation time, matching SID, logon and session, refusal of remote, restricting-SID and AppContainer callers, a fixed bounded protocol, and per-connection lease revocation. Nothing attests signed code; same-user unconfined code is inside the floor. The client uses only fixed packaged resources and native profile scope. An owner-published launcher record binds the current image, and bounded validation holds the package against other-user writes before exact host-only process creation. No JS path, environment or launch receipt grants authority, and fresh admission is still required.
- Linux Nightly stays in scope (maintainer decision, 2026-11-06). Packaged Octant listens on a `0600` socket in the private runtime folder, and each side admits the other only for the same user, a pidfd-held process, the same mount, user and PID namespaces and root, and a per-message kernel credential. Paths and `$APPIMAGE` grant nothing; Nightly registers no window while its renderers run unsandboxed. Both apps refuse launch flags outside their fixed roles and a closed display-flag list (Ozone platform, a few Wayland and video features, GPU off, scale factor). A closed Octant starts only from its last packaged launch's launcher record, by descriptor, host-only, with a minimal environment. Test data has its own Secret Service `service` values, cleared on Remove. That same-user unconfined code can pass is accepted.
- `octant-nightly` is the same CLI under Nightly's identity. It attaches to Octant's host, or to Nightly's test host on port `13774` when the stored Data choice is test data (failing closed to Octant's data). It never starts, stops, installs or migrates a host, and reports "Needs a newer Octant" for a missing route. Packaged macOS Nightly runs it from a fixed signed resource.
- A synthetic Nightly client smoke runs on every pull request without secrets, against a development host a synthetic Stable owns, standing in only for the signed native binding. It covers the renderer, a brokered-key Chat turn, brokered pickers, keys and approvals, the Browser, lease loss, host restart, two hosts, quit-one and quit-last. An unsigned packaged smoke runs locally, not in CI.
- Rollback is a roll-forward: a dispatched run rebuilds a published Nightly tag under a strictly newer version, and the feed key stays in a job that never runs built source. Each Octant release publishes an advisory, unsigned `octant-host-features.json`.
- Nightly publishes only after its usable-client preflight: two secret-free jobs check the channel table, the synthetic smoke, an unsigned packaged Nightly (payload, development-build refusal, test-data host) and Linux client trust, and require the newest Octant's host features to cover Nightly's protocol and needs. A signed Nightly is checked again after notarization (Developer ID, fuses, peer-status addon, link scheme, command, no harness). A dispatched Octant candidate skips it. A maintainer approves the first scheduled publication.

Not built yet:

- A signed Nightly installation: waiting on the maintainer checks below.
- Maintainer checks owed: a signed pair and signed install (the Preview install row included), a signed test-data host and `octant-nightly` run, real-account sign-ins, a packaged Electron run with physical IME and VoiceOver, an Octant candidate carrying the host feature list, roll-forward on a published release, the preflight on a scheduled release, a packaged Linux pair on a real desktop, packaged Windows lifecycle acceptance, and approval of the first scheduled publication.
- Windows Nightly test data, installation, and Work and Code: separate gates.

Status: Partly built. Since: 2026-11-05. Detail: [Octant Nightly: one host serves both](nightly-app.md#one-host-serves-both), [maintainer decisions](nightly-app.md#maintainer-decisions-2026-11-06), [what a client window offers](nightly-app.md#what-a-nightly-client-window-offers), [before Nightly publishes](nightly-app.md#before-nightly-publishes), [getting Octant Nightly](nightly-app.md#getting-octant-nightly), [reconnecting](nightly-app.md#reconnecting-after-host-loss), [fixed entry](nightly-app.md#fixed-packaged-entry), [native-main admission](nightly-app.md#native-main-admission), [standard text composition](nightly-app.md#standard-text-composition), [page popups](nightly-app.md#page-popups), [accessibility](nightly-app.md#accessibility), [Windows client trust](nightly-app.md#windows-client-trust), [Linux client trust](nightly-app.md#linux-client-trust), [the `octant-nightly` command](nightly-app.md#the-octant-nightly-command), [synthetic client smoke](nightly-app.md#synthetic-client-smoke), [which build is which](nightly-app.md#which-build-is-which), [Nightly's own updates](nightly-app.md#nightlys-own-updates) and [the usable-client preflight](nightly-app.md#the-usable-client-preflight).

## Code tooling

### Language servers

A Code thread's editor gets diagnostics and go-to-definition from separately launched language servers that run under Code Project and thread authority. They are an executable component kind on the activation ladder.

- Language servers are Code only, quarantined until reviewed, and installing one never trusts or enables it.
- A `static` server reads the checkout read-only with no network and no exec, needs no approval, and serves Plan.
- A `repo-tooling` server runs confined like a terminal, with per-checkout approval and proxied network, and is refused in Plan. At Full access it starts with no approval, judged from the level the turn runs at ([the Full access rule](#the-full-access-rule)).
- The repository never chooses what runs. Executable, arguments, environment and class come only from the enabled component.
- The editor's acknowledged-document read seam also serves capability-checked completion, hover, signatures, symbols and formatting. Replies contain bounded text and ranges, never server commands or edits to other files. Shared Work and Code editing, recovery, conflict comparison, reviewed replacements and selection-to-agent drafts follow [Workspace: File editing](workspace.md#file-editing).
- Octant hosts no other editor's extension API.
- On Windows a server runs as [Windows below Full access](#windows-below-full-access) says.
- Octant Harness `write`, `edit` and `editFiles` in Code threads attach language-server errors: errors only, the first 5 as `path:line:col message`, messages cut at 200 characters, then `and N more`, or `No errors in <file>`. They wait at most 3.5 seconds, shared across `editFiles`, return nothing extra on timeout or when no server is eligible, and never block for approval below Full access. `repo-tooling` answers stay marked as outside content (maintainer decision, 2026-11-19).
- Claude Code and Codex edit with their own tools, so Octant adds nothing to their edit results; they read diagnostics through `octant_code`.

Not built yet:

- The bounded `window/logMessage` log and lifecycle counts under Diagnostics, and removing a cache when its checkout is removed or its component uninstalled: not built.

Status: Partly built. Since: 2026-10-26. Detail: [Language services: launch classes](language-services.md#launch-classes), [authority](language-services.md#authority) and [maintainer decisions](language-services.md#maintainer-decisions).

### Debugger

A person, at a local window or on a device they paired, picks a debug configuration and starts a confined debug session. An agent starts, controls, reads and stops one through the plugin-shaped `octant_debug` tool: unasked at Full access, approval-gated below it, and refused in Plan (maintainer decision, 2026-11-12).

- The agent's tool has a closed set of operations (list, start, breakpoints, continue, step, pause, read state, threads, stack, scopes and variables, evaluate, stop). It starts only a configuration the Project already holds, and is offered only outside Plan where a debug adapter is effective.
- Below Full access an agent's start needs one answer in the thread per session and nothing else. The card shows the configuration (program, arguments, working directory, and the names of its environment variables, never their values), so a configuration nobody confirmed, the repository's proposal included, starts on that answer. The answer covers controlling and reading the session and every expression evaluated in it, also after the thread has read outside content (maintainer decision, 2026-11-13).
- Below Full access a person's start needs a confirmed configuration (the shell-command approval) covering the current configuration and adapter package. At Full access a start is unasked, and the host starts and keeps a session with no confirmation on record.
- Configurations found in the repository are proposals that run only after the person confirms them, or answers an agent's ask whose card shows one.
- An agent may attach to a running process, by process id, or by loopback port where the adapter's package declares it, at Full access only and unasked there. Below Full access attach is refused, not asked, because an attached process cannot be put in the session's capsule as a launched program is. Plan refuses it. At every level the host refuses Octant's own processes, another user's process, and a process whose program does not live in the thread's checkout or extra folders (maintainer decision, 2026-11-13).
- What a session shows reaches the agent bounded, redacted and marked as outside content. The person sees and can stop the agent's session in the Run and debug panel.
- Plan refuses debugging, and the program is confined by the thread's posture as a terminal is.
- On Windows a session runs as [Windows below Full access](#windows-below-full-access) says.

Not built yet:

- Attach: the tool offers no attach yet.
- An unconfirmed start from the Run and debug panel at Full access: the panel still offers Start only on a confirmed configuration.
- The macOS confined-program smoke: needs a Mac.

Status: Partly built. Since: 2026-10-27. Detail: [Language services: debugger authority](language-services.md#debugger-authority), [agent debug tool rules](language-services.md#agent-debug-tool-rules) and [approval and starting](language-services.md#approval-and-starting).

## Disposable desktops

### Leases and authority

A Project owns at most one desktop recipe, which only a person edits, and a thread leases a throwaway desktop from it. The server checks every lease command against the thread's current authority before any provider call.

- A lease belongs to one thread. Only Work and Code threads may lease.
- A thread holds at most two leases by default. The per-thread and per-host counts are Settings defaults, each from one to eight, that a person changes at a local window or a device the host's own person paired; a hub-introduced device is refused (maintainer decision and request, 2026-11-12).
- Failures are named refusal values, never throws or hangs.
- Teardown runs on a host-owned path that stays authorized after thread archive, recipe removal or plugin disable, and can only release, verify and list.
- Any client that may open the thread may view and operate its disposable desktop. The person's own input needs no approval and is journaled. A remote Code thread opens the existing Desktop pane over the paired session.

Not built yet:

- Work-mode leasing: only Code turns carry a desktop destination today.
- Setting or removing a recipe from a paired device, and the recipe editor on a paired client: the Project route still refuses the command from a paired device, and no paired surface shows Project settings.

Status: Partly built. Since: 2026-10-26. Detail: [Disposable desktops: model](disposable-desktops.md#model) and [authority](disposable-desktops.md#authority).

### Desktop isolation and transfer

A desktop holds no host credential and no checkout. Host files enter only through an explicit, journaled transfer of one checkout-relative file, and the separately approved preview carries only the named application's HTTP and WebSocket traffic.

- A host-local desktop runs in a dedicated Linux sandbox with its own network namespace and no host loopback, and gets network through a filtered egress proxy that refuses loopback, private and host addresses (maintainer request, 2026-11-12).
- A cloud desktop's key stays in the host credential store and never enters the desktop.
- Nothing is copied back except screenshots and recordings, as host-held evidence.
- A transfer to a cloud desktop asks unless the person turned "Confirm each billed desktop" off. Plan refuses transfers (maintainer request, 2026-11-12).
- An agent's transfer to a desktop on this machine does not ask at Full access, whether or not the thread has read outside content. Below Full access it asks once per thread, with the answer journaled for the thread (maintainer decision, 2026-11-13).
- Under Strict, that answer is withdrawn once the thread reads outside content. Outside Strict it keeps covering the thread (maintainer decision, 2026-11-22).
- The card also offers **Remember for this Project**, which covers the Project's threads' transfers into desktops on this machine until forgotten in Settings › Computer use. It never covers a cloud desktop, whose ask does not offer it, even with "Confirm each billed desktop" off. Under Strict it is withheld from a thread that has read outside content.
- The Code approval carries the offer inside the strict ask, so the minimum compatible phone or CLI client is the first release built with it. A client of 0.1.0-preview.20261122.11 or earlier cannot read a Code thread that has asked it.
- A local person may review and grant one healthy Octant-owned dev-server port from the Code task's own worktree to its ready host-local Linux lease. The portable provider seam exposes only bounded HTTP and WebSocket operations. An authenticated exact-socket IPC exception keeps the guest's separate network namespace and denies other host ports.
- Preview permissions expire with the original lease, are invalidated by authority, binding, window or provider loss, never restore after restart, and block replacement grants while cleanup is unconfirmed. E2B and Cua report this capability unavailable.
- The production-launch namespace proof is mandatory before the preview path is enabled, and the required hosted proof covers the local adapter and grant path. Packaged desktop GUI acceptance is separate.

Not built yet:

- Network for a host-local desktop through the filtered egress proxy: not built, so today a host-local desktop never has network and a recipe that asks for it is refused. Only a cloud recipe without a placement may allow network.

Status: Partly built. Since: 2026-10-26. Detail: [Disposable desktops: isolation](disposable-desktops.md#isolation), [artifact transfer](disposable-desktops.md#artifact-transfer) and [lease-bound dev-server preview](disposable-desktops.md#lease-bound-dev-server-preview).

### Desktop lifecycle and teardown

Every lease has a hard expiry, and ending a lease always destroys the desktop and verifies it is gone.

- A lease expires after 30 minutes and an idle lease is released after 15 minutes by default, both recipe defaults a person changes. A person may extend a lease to the recipe maximum of 4 hours (maintainer request, 2026-11-12).
- An agent may extend a host-local lease up to the recipe's maximum under the rules acquiring one follows, never a lease that bills or runs off this machine. A billed lease keeps a hard expiry.
- The host journals a lease before calling the provider and tags the resource, so a crash leaves something findable.
- On restart the host destroys every unreleased lease and orphaned tagged resource before admitting a new one.
- Release counts only when the provider confirms the resource is absent. Otherwise the lease stays release-failed and blocks new leases on that provider.

Status: Built. Since: 2026-10-26. Detail: [Disposable desktops: lifecycle and teardown](disposable-desktops.md#lifecycle-and-teardown).

### Desktop providers and billed placements

Desktop providers are plugin contributions through the `desktop-provider` seam: the host owns leases, authority and teardown, and the driver only translates. Cloud desktops run only on the person's own account, and Octant operates no cloud.

- A person confirms each billed or off-machine lease, and each transfer to a cloud desktop, unless they turned off "Confirm each billed desktop". That setting is on by default, applies inside the monthly cap, and is changed only by a person at a local window or a device the host's own person paired, journaled as that person or device, with "Desktops per thread" and "Desktops on this host" beside it (maintainer decisions, 2026-11-12 and 2026-11-13).
- Billed desktops are off until a person sets a monthly spend cap, and the cap stays mandatory (maintainer request, 2026-11-12). Each lease is estimated first and refused over the cap. Agents cannot change the cap. A device the host's own person paired sets it as a local window does, journaled as that device; a hub-introduced device is refused (maintainer decision, 2026-11-12).
- A billed provider must set a provider-side expiry, or the host destroys the desktop.
- A daemon-backed placement is chosen per recipe. Octant stores no credential for the daemon and never installs or starts it.
- A desktop on this machine is a virtual machine with no network until a live check proves otherwise ([Desktop isolation and transfer](#desktop-isolation-and-transfer)).
- The drivers are built against recorded and fake providers and offered on every host: E2B everywhere, the Cua daemon driver on Linux.

Not built yet:

- The spend cap in the paired browser and phone: the server admits it, the paired screens are a UI follow-up.
- Live smokes of each driver: owed.

Status: Partly built. Since: 2026-10-28. Detail: [Disposable desktops: provider seam](disposable-desktops.md#provider-seam), [authority](disposable-desktops.md#authority) and [billed placements](disposable-desktops.md#expiry-and-teardown-when-the-daemons-host-may-die).

## Bots

### Bots, with Navigator as the lead bot

A bot is a lasting, app-wide assistant on one host: a name, avatar, role, instructions, model and access level, a host-managed Work home, one conversation that never ends, its own memory and routines, and optionally its own sandboxed desktop. Navigator is the lead bot on every host. Threads and tasks keep their behavior.

- A bot is not a fourth mode. Its conversation is a Work thread in its own home Project, so it has a Work thread's tools and authority, and routines a bot owns post into that conversation.
- Navigator becomes a Work conversation as the lead bot. It cannot be deleted, and it acts on its own within its access level.
- A new bot starts at Auto where its provider has its own reviewer (Claude Code, Codex) and at Ask first otherwise. It does not start at Full access by default, and the person may change that (maintainer request, 2026-11-12). At Auto, Octant Shield answers once a web page withdraws the provider's reviewer.
- Paying, buying, or sending a message as the person always asks, at every level and in routines, when the action is classified as such. Inside a bot's own desktop there is no site approval and no first-action ask.
- The sidebar rail shows pinned bots with their status, and All bots lists every bot from every connected host. The paired browser and the phone show the same bots, may create bots, and may answer bot cards, except billed desktop starts and login grants.
- A bot desktop is kept between uses and runs in a Docker-compatible engine or Apple's container tool on this machine, or with E2B or Cua. It reaches the web only through a host proxy that refuses private and host addresses, and holds no host credential or checkout.
- A bot signs in with logins the person gave it, only on those logins' sites and without asking, also in routines. The host fills them into the bot's browser, and the model never reads them. Ask me each time is a per-login choice.
- Bots ask each other by name and share rooms under the existing agent messaging limits. A person can call a bot by voice. A bot can carry on with a fallback model.

Status: Designed, not built. Since: 2026-11-08. Detail: [Bots](bots.md).

## To-dos

### The person's to-do list

A person keeps their own to-dos in one list that every device and computer they connected shows, tags each to Projects and their own tags, filters them, and starts a thread from one when ready.

- The list lives on one list host: the hub when the host belongs to one, otherwise the host itself, or a paired computer the person names. Only that host journals and projects to-dos.
- The person chooses the list host in Settings › Data & storage, journaled on this host and refused once this host keeps a to-do. An empty spoke records its hub as the default, without overriding an explicit choice or hiding an existing local list, and the choice survives a loss of hub membership.
- A window reaching a list on a paired computer reads it, with unsent drafts while it cannot be reached.
- A local window and the person's paired devices may change the list. Agents, routines, delegated runs and peer hosts are refused.
- A phone reads only the selected computer's existing to-do route. After the principal check it resolves the effective list host and returns a local view or the existing `kept-elsewhere` refusal; it does not return the host-choice payload or forward the read. A refused phone read shows as unavailable, not empty. Its quick-add draft survives explicit host changes and is never sent automatically.
- Thread badges merge only the thread hosts' existing authorized navigation rows, keyed by host id. The list host does not project remote thread state.
- Edits to the title or notes are version-checked and refused as changed elsewhere when stale. There is no merge.
- An unreachable list host shows a stale, read-only list, and quick add keeps an unsent draft the person sends. Nothing is queued as offline work.
- A to-do's Project and thread links carry no authority. Start opens that Project's ordinary new-thread draft on its own host (this host's or a paired computer's Projects, and Chat), whose own creation checks decide. The mode follows the Project, and nothing starts until the person sends. A refused create writes no link, and the link answer precedes the first turn.
- Only the person ticks a to-do off. An agent never changes a to-do.
- The destination and every name in code and copy are To-dos, never Tasks.
- The To-dos page has quick add, one toolbar (the state switch and a Filter menu; an empty list shows the empty state instead), editing in place, reordering, the sidebar row and its badge, New to-do in the command palette and on a shortcut, Start, and the thread state on a row. The list host's own windows update live, and paired windows follow bounded list-change notices with epoch and cursor recovery.
- The phone shows the list with quick add, Tick off and Start.
- Owed checks: physical hub verification, and physical two-computer verification.

Status: Built. Since: 2026-11-14. Detail: [To-dos](todos.md).
