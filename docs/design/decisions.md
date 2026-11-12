# Decisions and requirements

This is the one list of every current Octant product and architecture decision.
Each entry states the rule, the requirements a contributor must keep, whether it
is built, and the specification section that owns its detail. The detailed
specifications ([architecture](../architecture.md), [DESIGN.md](../../DESIGN.md),
and the topic specifications indexed in [Current design](README.md)) stay the
place for the full rule, its rationale, and its verification; where an owner
states more detail than an entry here, the owner's detail applies.

How to read an entry:

- **Status** is one of Built (in the product today), Partly built (some
  requirements are built; the bullets marked "not built yet" are not), or
  Designed, not built (decided, with no code reaching it yet). A built feature
  whose live or maintainer check is still owed says so in a bullet.
- **Since** is the date of the maintainer decision when the owning specification
  states one.
- A requirement marked _Here only._ is in force but not yet repeated in its
  owning specification. It was carried over from the former decision archive
  on 2026-10-31 so no rule still in force is lost; this document is its home
  until the owner absorbs it.

A change to a decision updates its owning specification and its entry here in
the same pull request ([Changing the design](README.md#changing-the-design)).
The former decision archive is history in `docs/legacy/` and has no authority.

## Summary

| Area                                                                                  | Decisions | Built   | Partly built | Designed, not built |
| ------------------------------------------------------------------------------------- | --------- | ------- | ------------ | ------------------- |
| [Principles and hard lines](#principles-and-hard-lines)                               | 7         | 5       | 1            | 1                   |
| [Guardrails and review](#guardrails-and-review)                                       | 9         | 3       | 6            | 0                   |
| [Key providers](#key-providers)                                                       | 1         | 0       | 1            | 0                   |
| [Release scope](#release-scope)                                                       | 7         | 1       | 5            | 1                   |
| [Process topology and local trust](#process-topology-and-local-trust)                 | 7         | 5       | 2            | 0                   |
| [App-managed tools](#app-managed-tools)                                               | 5         | 4       | 1            | 0                   |
| [Canvas authority](#canvas-authority)                                                 | 2         | 0       | 2            | 0                   |
| [Device transport](#device-transport)                                                 | 3         | 3       | 0            | 0                   |
| [Modes, Projects and authority](#modes-projects-and-authority)                        | 16        | 12      | 4            | 0                   |
| [Agents and delegation](#agents-and-delegation)                                       | 5         | 2       | 3            | 0                   |
| [Boards, pull requests and delivery](#boards-pull-requests-and-delivery)              | 6         | 2       | 3            | 1                   |
| [Routines and timed turns](#routines-and-timed-turns)                                 | 4         | 1       | 3            | 0                   |
| [Transcript records](#transcript-records)                                             | 1         | 0       | 1            | 0                   |
| [Persistence](#persistence)                                                           | 12        | 7       | 5            | 0                   |
| [Providers](#providers)                                                               | 7         | 5       | 2            | 0                   |
| [Context and usage](#context-and-usage)                                               | 9         | 7       | 2            | 0                   |
| [Native harness](#native-harness)                                                     | 6         | 4       | 2            | 0                   |
| [Extensions](#extensions)                                                             | 8         | 5       | 3            | 0                   |
| [Authority and approvals](#authority-and-approvals)                                   | 7         | 6       | 1            | 0                   |
| [Sandbox and confinement](#sandbox-and-confinement)                                   | 14        | 11      | 2            | 1                   |
| [Terminals, browsers and side surfaces](#terminals-browsers-and-side-surfaces)        | 9         | 8       | 1            | 0                   |
| [Remote access and pairing](#remote-access-and-pairing)                               | 9         | 5       | 4            | 0                   |
| [Credentials and sign-in](#credentials-and-sign-in)                                   | 5         | 4       | 1            | 0                   |
| [Updates and development](#updates-and-development)                                   | 4         | 4       | 0            | 0                   |
| [Design system](#design-system)                                                       | 11        | 10      | 1            | 0                   |
| [Workspace](#workspace)                                                               | 16        | 14      | 2            | 0                   |
| [Start screen](#start-screen)                                                         | 3         | 3       | 0            | 0                   |
| [Canvas](#canvas)                                                                     | 11        | 7       | 4            | 0                   |
| [Artifact sync](#artifact-sync)                                                       | 5         | 5       | 0            | 0                   |
| [Browser](#browser)                                                                   | 6         | 3       | 3            | 0                   |
| [Provider runtimes](#provider-runtimes)                                               | 6         | 5       | 1            | 0                   |
| [Model endpoints and organization sign-in](#model-endpoints-and-organization-sign-in) | 6         | 4       | 2            | 0                   |
| [Outside provider drivers](#outside-provider-drivers)                                 | 3         | 2       | 1            | 0                   |
| [Device workbench and mobile](#device-workbench-and-mobile)                           | 8         | 4       | 4            | 0                   |
| [Hubs and Nightly](#hubs-and-nightly)                                                 | 5         | 1       | 4            | 0                   |
| [Code tooling](#code-tooling)                                                         | 2         | 0       | 2            | 0                   |
| [Disposable desktops](#disposable-desktops)                                           | 4         | 0       | 4            | 0                   |
| [Bots](#bots)                                                                         | 1         | 0       | 0            | 1                   |
| **All areas**                                                                         | **250**   | **162** | **83**       | **5**               |

## Principles and hard lines

### Six product principles

Every product rule is measured against six principles; a rule that protects none of them is a default a person can change, not a law.

- The person's ecosystem is the person's call: their explicit choice beats Octant's caution.
- Privacy and no telemetry are not adjustable: nothing leaves the machine unless the person sent it or configured where it goes, and no usage data is sent without opt-in.
- Guardrails are on by default and a person can lower them to Full access per Project, per thread, or globally; the choice is visible and journaled.
- Key providers run as themselves: Octant adds to their native tools, subagents, skills, hooks and sandboxes and does not remove them.
- Honesty never softens: Octant always says what a provider or tool can and cannot do, and records what happened.
- Octant is never stricter than a key provider's own app: anything a person can allow there, they can allow in Octant with the same or fewer steps.
- The specifications are measured against these principles today; the rules they call for that are marked "not built yet" in the entries below (guardrail levels, the Full access rule, Octant Shield, key providers' native features) are not built yet.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### Hard lines no level turns off

A short list of rules holds at every guardrail level, Full access included, and no setting or reviewer turns them off.

- No telemetry, no usage data and no Octant cloud.
- Octant stores no forge token, never journals a secret value, and redacts secrets from logs, the journal and exports; credentials reach a provider only through the credential broker.
- Updates are signed and verified; anything unverifiable is refused.
- Authority is checked on the host before any side effect; a phone or web client never exceeds what the person allowed on the host.
- Providers report capabilities honestly and fail closed.
- The journal records every lowered guardrail, every merge and every force-push, with who allowed it.
- An agent never merges or force-pushes on its own initiative, never marks a thread Done, and never exceeds a spend ceiling the person set.
- Plan mode is read-only by definition: an agent in Plan may look and propose and changes nothing in the workspace, on the host or in the outside world. It may read the page already open in its thread's Browser and propose what a person confirms (a side task, a routine); the one thing it writes is its thread's own Canvas (`create` and `revise`), while publishing, sharing, the artifact mirror and replica sync stay refused.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### The Full access rule

At Full access, in Work and Code, nothing prompts, nothing expires into a refusal, and nothing is refused because the thread read outside content, except the closed list of eight exceptions below (maintainer request, 2026-11-12). A rule anywhere that asks at Full access and is not on the list is wrong, and the list wins. Adding an ask at Full access means adding it to the list in the owning specification in the same change, with its reason.

- Every hard line: no telemetry, secrets never journaled, signed updates, authority checked on the host, the journal, Plan read-only, spend ceilings, and an agent never marking a thread Done.
- Merge, plain force-push and push to the default branch, which follow the pull-request merge rules and the Project's "Agents may merge" switch.
- Computer use: the first action in each application asks, once per thread, because it drives the person's real desktop.
- The Browser on a signed-in profile: a site approval per origin and profile, which the person can remember or widen to "Allow all sites in this profile". A Private page needs none.
- Paying, buying, or sending a message as the person through the Browser or Computer (an email, a chat, a social post, a form that sends a message). A pull-request comment or review reply is not such a send and follows the pull-request rules.
- Billed or off-machine desktops: the spend cap is mandatory, and inside it the confirmation of each billed or off-machine lease and each transfer to a cloud desktop is a setting, on by default.
- Who may choose Full access: a local window, or an owner device the person marked. No other paired device and no agent grant raises a thread to it.
- The one-time warning when a machine or a Project first picks Full access.
- Unattended work: at every level a wait is the safe state, so an unanswered approval or question waits in Needs you until a person answers it and never turns into a refusal by timing out. A time, count or size limit is a default the person can change in Settings unless it protects a hard line or the integrity of stored data; a fixed constant states its reason beside it.
- Not built yet: the rules this replaces still ask, expire or refuse today, and the limits are still constants; each entry below marks its own.

Status: Designed, not built. Since: 2026-11-12. Detail: [Architecture: Security and authority, Guardrail levels](../architecture.md#security-and-authority).

### Local-first with a closed list of outside calls

Everything a person cares about stays on the host; Octant makes only a short, switchable list of host-initiated calls.

- No Octant account, relay, or telemetry is required; artifact sync uses only a store the person owns.
- The outside calls are signed update checks, managed device-tool update checks, marketplace fetches the person starts, public Canvas link calls, and a hub's own push delivery when its person turns it on; each has an off switch.
- Traffic among a person's own devices on their private network is not a third-party call, but it is always authenticated and encrypted.
- Adding telemetry, an external call, credential exposure or a cloud dependency needs an explicit request and a documented boundary in the owning specification.

Status: Built. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### Desktop-owned broker cleanup

A desktop-owned launch retains acquired native resources through failure and
shutdown. The Browser runtime broker shares one close completion for failed
listen and ordinary shutdown, attempts every acquired cleanup stage even after
an earlier failure, awaits its HTTP listener and closes held connections.
Startup and cleanup failures are reported without widening the existing quit
deadline or taking ownership of borrowed hosts. The desktop gives the host it
spawned 60 seconds to open its store. A start-up failure is logged and its
launch released before anything is shown, and is then shown in a window that
does not block quitting, never a native alert without a parent: on macOS that
alert runs a nested modal loop that a signal cannot interrupt (observed in a
packaged build, which stayed alive twenty seconds after SIGTERM). Signals, the
Quit menu item, closing the window and its Quit button all end the app once.

Status: Built. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Server authority, an authoritative journal, and strict host reads

The server decides every authority question, the event journal is the record, and the host reads every input strictly.

- Every authority check (mode, Project, thread, provider, approval, remote principal, spend ceiling) runs in the server before a side effect; renderers only show what the server allows.
- Commands append versioned events; read models are idempotent projections rebuildable from the journal.
- Startup verifies only journal rows after a disposable watermark (sequence plus a fingerprint of the exact server build, the registry's names and versions, and the schema head); the first start of a new build, a source run, a migration, or rewrite or delete of a journal row forces a full scan ([Architecture: Persistence](../architecture.md#persistence)).
- Contracts are schema-only and domain code is pure; dependencies point inward and provider payloads stop at the adapter.
- The host refuses unknown fields in everything it decodes; a client drops unknown fields in a host answer, except inside asks a person decides on, which stay strict.

Status: Built. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles).

### Plugin-shaped growth

New providers, tools and capabilities reach the system only through the published seams and take no shortcut a third-party plugin could not take.

- Shipping in-tree is allowed; wiring a provider or tool into server internals, or widening a seam for one vendor, is not.
- A capability a seam cannot express is a reason to extend the seam in its own change.
- Core capabilities (browser and computer use, tests, Apple validation, approvals, memory, subagents) are app-managed and provider-neutral, and are added beside a key provider's own tools, never instead of them.

Status: Built. Detail: [Architecture: Overview and principles](../architecture.md#overview-and-principles) and [Plugin boundaries](../architecture.md#plugin-boundaries-and-remaining-extraction).

## Guardrails and review

### Guardrail levels

One setting says how much a thread's tool calls are guarded, with four levels: Ask first (Guarded), Accept edits, Auto (Reviewed), and Full access.

- Ask first: the person approves anything with effects, under Octant's OS confinement plus the provider's own sandbox.
- Accept edits: as Ask first, except file edits inside the folder go through.
- Auto (Reviewed): a reviewer the person chooses, the provider's own or Octant Shield, answers prompts and escalates to the person what it will not allow.
- Full access means no sandbox and no prompts, as in the providers' own apps, with protected files guarded by Octant's own tools and redaction only, so a shell command can read them; outside content is only recorded and marked, and every hard line still holds.
- Any level can be set globally, per Project and per thread; the narrowest scope wins, and Full access shows a one-time warning the first time a machine or Project picks it.
- Lowering is journaled with who, when, from which level and at which scope; the thread header shows the level in force and where it came from.
- Plan is an overlay on any level and always read-only; subagents start at their parent's level and never exceed it; a routine runs at the level its creator picked.
- A retired level recorded before these four existed replays as Full access.
- Built in Code: Ask first, Accept edits, Auto with the key CLI providers' own reviewers, Plan, and Full access with no sandbox and no prompts for every runtime, with a first-run default, a Settings › Code › Access default, a Project override, and the one-time warning.
- Built in Work: Auto, Ask first, Accept edits and Full access, set from Settings › Work and the composer, with the one-time warning; Work has no Plan.
- Built in both: a Work Project and a Code Project can override the mode new threads start in; the first-run answer sets the default for new Work threads as well as Code; the thread header shows the level in force and the scope it came from; every level lowered at the global, Project or thread scope is journaled with who, when, from which level (absent when a Project override replaced the default it followed) and which scope.
- `octant agent --access <mode>` starts a new Work or Code thread at the asked-for level from the terminal, on hosts with or without a desktop window: `full-access` on a Code thread is remembered for the Project through the same `change-code-project-access` command `octant project access` sends, and a Work thread takes the level through `change-work-thread-access`. `octant settings access <mode> [--work]` sets the global default new threads start at, through `update-code-settings` / `update-work-settings`.
- Full access can be opted into a sandbox per thread (`fullAccessSandbox` on the Code or Work thread, `octant agent --access full-access --sandbox`): no prompts, but the confinement the guarded levels have. Built for Codex (kept inside Octant's profile and told the sandbox is external), Claude Code (its command sandbox with no unsandboxed retry and Octant's Project-path gate for file tools), Pi (launched inside the Accept edits wall with its approvals off), OpenCode (its server inside the Accept edits wall under Full access's permission rules), ACP agents (launched inside the Accept edits wall in their own Full access mode, with every request answered allow), and the Octant Harness (confined shell); a runtime Octant does not know refuses a sandboxed thread rather than run it open. Network limits to approved hosts apply behind the Network limits switch, which ships on: Codex, Claude Code, Pi, OpenCode and ACP agents ask for the runtime proxy with the Accept edits posture their wall has, and Harness commands run on their own proxy. Helpers of a sandboxed thread run at Accept edits. The choice is dropped below Full access and replays as off on older journals. Rationale: Full access's no-sandbox rule (2026-10-31) stays the default; the choice adds containment for people who want no prompts without giving up the wall. Live Codex turn under the mapping: maintainer check. The choice has a Project default and a Settings default (Code and Work), is set in the app from the thread's mode picker, Settings, and a Project's default mode, and from the terminal with `octant settings sandbox on|off [--work]`.
- The shared Work/Code indicator's Access details reads host facts under existing thread-read authority: selected/effective level and running/session limit, current default match, reviewer/account/model and observed runtime limits. Unknowns remain explicit; failed or superseded reads retain no old account assertion. Recovery uses existing actions and never changes authority or recommends a protected-file bypass. A current default match is not historical provenance. Server-backed Work reads reuse the server catalog's exact thread binding and global Work default, without a local Project substitute.
- Computer use keeps its ask at the first action in each application, once per thread, at every level, Full access included. The Browser asks at Full access only for a site on a signed-in profile, and a Private page needs no site approval there. Both are items of the closed list in [The Full access rule](#the-full-access-rule), which names everything that still asks at Full access (maintainer request, 2026-11-12). Not built yet: today the Browser asks for each new origin on a Private page at Full access too, and Computer asks again on every action once the thread has read outside content.
- Built in Code: Mistral Vibe's auto-approve mode, the one ACP profile that declares its own reviewer. Every other ACP agent reports no reviewer of its own, and its capability report says so; a profile gains one by declaring the mode that answers its prompts.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Guardrail levels](../architecture.md#security-and-authority).

### Secrets are guarded, softly at Full access

Below Full access, secret files stay out of every agent's reach by an operating-system rule, with as little friction as the person's normal tools. Full access is full access: there the guard is soft and a shell command can read a protected file.

- One operating-system deny list covers SSH private keys, cloud and tool credentials, keychain and password-manager files, browser login stores, Octant's own secrets, and other runtimes' sign-ins; SSH config, known_hosts, public keys and the login keychain stay readable, and a runtime keeps its own sign-in.
- Below Full access (Ask first, Accept edits, Auto, Plan) the list joins every confined launch after its grants. At Full access no launch is wrapped for any runtime, so Swift packages and headless Chrome work without flags.
- At Full access Octant's own file tools still refuse protected paths with the same plain message, Octant Shield's Watcher flags a call that names a protected path and the Octant Harness's secret-then-network commands are tagged, both journaled and never blocking, and redaction stays on.
- SSH works through the person's SSH agent, Git over HTTPS through the system credential helper, and keys through the credential broker, so agents use credentials without reading them.
- The person adds paths in Settings › Permissions › Protected files; removing a built-in group needs an explicit confirm and is journaled.
- A refused read by Octant's or Claude Code's file tools names the rule and the channel to use, at every level. Native broad-root search refusals identify the search root, state that no results were returned and offer an ordinary unprotected subfolder. Relative roots and Glob escapes receive the same resolved-path check; no exclusion or partial-result claim is invented.
- Known key formats and broker-issued values are redacted from runtime output, transcripts, the journal, exports and the service log, at every level.
- Octant Shield's Judge sends a command that reaches a secret file to the person and refuses one that reads secrets then sends something off the computer; it reads the person's protected list beside its own patterns.
- Built: the Watcher's `secret-path-read` label on every call of Octant's own tools that names a protected path, refused or not; the Watcher's `secret-env-print` label on a call of Octant's own shell that prints an environment variable whose name says it holds a secret, by the name alone; the Judge reading the list in force; a journaled `reads-secrets-then-egress` tag on an Octant Harness command at Full access.
- Built: the AWS command line in Octant's own shell gets a one-hour session the broker makes with AWS STS from a key pair the person pointed at a linked store; the pair never leaves the broker.
- Built: the Google Cloud `gcloud` command line in Octant's own shell receives a command-owned access-token file and private configuration after the person confirms an exact linked service account and OAuth scopes. The broker alone reads the reusable signing key; clearing the selection blocks pending and future commands, not tokens already given to running commands.
- Azure uses the fixed broker-owned Resource Manager subscriptions GET with one-use consent, a complete approved URL and no redirects or response export. Azure CLI credentials remain unavailable; its tested same-origin redirect behavior does not preserve an exact authenticated path. Google ADC, `gsutil`, `bq`, delegated subjects, and impersonation are outside the bounded `gcloud` adapter.
- Parked (maintainer request, 2026-11-12): the Linux access-time mediation described in the six bullets that follow keeps its text, its candidate is unselected with zero production coverage, and no further work on it is scheduled until [The Full access rule](#the-full-access-rule) is built.
- Linux absent-file and later companion/alias enforcement still needs access-time mediation alongside Bubblewrap. The replacement preserves live allowed files, durable writes, hardlinks, native watches and exact own-account exceptions. An original kernel admission core is confined to a disposable networkless guest and reports zero production coverage until namespace/pre-effect ordering, complete policy/data routes and the real production launch matrix pass. Stock modern pre-access covers the measured new mapping case but permits pending and future reads after listener loss; that lifecycle is insufficient. Existing admitted reads/mappings need not be erased. See the owning [Secret guard](../architecture.md#secret-guard) boundary.
- The disposable Linux mediation candidate has an owned preparation/launch port: the real shared Bubblewrap builder and exact host protected-file configuration stay in an owned worker, actual device/policy readiness precedes creation, and a durable actual PID/birth receipt precedes exec. Separate stdio is backpressured and bounded; accepted write failures are uncertain rather than replayed. Caller cancellation/deadline and owner-channel loss retire admission before finite owned-process cleanup, which reports uncertainty rather than treating relay exit as proof of all descendants. The port remains unselected, root-only device eligibility and full lifecycle/native proof remain unfinished, and production coverage stays zero. Detail: [Secret guard](../architecture.md#secret-guard).
- Mediated workloads cannot destructively remove/move a companion or ancestor when the actual operation/source/destination and current epoch show that doing so would declassify still-existing protected content. Public-key content reads/writes, new public-key creation, unrelated aliases and permitted namespace changes remain allowed; host/unconfined changes and Full access are unchanged. No sticky protection floor or external-writer freeze substitutes for the live policy. Own-account exceptions retain their enrolled forms rather than following later symlink replacement. This boundary remains part of the unfinished Linux production implementation.
- Metadata includes the protected link inode and its target, including dangling link text. Its blocking preflight is paired with exactly one user operation before inode locks; final context/epoch/native-identity checks consume the decision without I/O. Every return clears unused state, fork/clone/exec inherit none, and unprepared paths in the current restricted context refuse pending native compatibility proof. Production coverage remains zero.
- Audited creation entries bind the actual parent, copied name and held hardlink source before locks, then consume one task/context/epoch-bound scope at the filesystem effect. Every return and delegation retry retires it. Filesystem Unix socket binding uses that scope; failed-bind rollback separately admits UNLINK outside the parent lock and removes only the exact retained created socket. Only this rollback may wait through a pending signal within the existing two-second admission ceiling; broker loss, refusal, identity/epoch changes and unused-approval cleanup remain enforced. Other waits stay interruptible. Scoped native socket/rollback, lifecycle and runtime acceptance passes; full compatibility and production integration remain unfinished. The candidate stays unselected with production coverage zero. Detail: [Secret guard](../architecture.md#secret-guard).
- The disposable candidate scopes ordinary mode/owner/time/truncate entries before inode locks and compares the write decision immediately before `notify_change`. Delegation retries clear before waiting and freshly prepare. Its ordinary filesystem-attribute setters prepare only in three audited user entry points, after copied values and mount-write acquisition; automatic cleanup precedes mount-write release on every result. Three ordinary attribute-read entries prepare READ and clear their scopes before copyout; the exported getter consumes only READ. A private setter-only getter inspects the same exact prepared WRITE without consuming it, then the final setter consumes once. Both preserve native checks and never wait for the broker; ordinary reads cannot select the private purpose or borrow WRITE. Failed inspection exits through unlock and outer cleanup without retry/reuse. Native acceptance requires private read refusal with output unchanged, NODUMP refusal with independently unchanged flags/metadata, and successful public toggle/readback/restoration and permitted writes. This is not global `inode_setattr` or ioctl coverage: other attribute routes, internal privilege clearing, other filesystem ioctls, stacked mutations and kernel credential overrides still need audited lifetimes and native proof; production coverage stays zero.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Secret guard](../architecture.md#secret-guard).

### Optional first-task capability discovery

Your first task includes an optional Explore capabilities card for Browser,
Computer use, helper agents and person memory. Current host facts and existing
Settings own their state; examples are static, dismissal changes no settings,
and the card adds no counted onboarding step. Computer use shares Settings’
explicit guided setup, saves pending progress across relaunch and reports working
only after a successful local test. After onboarding has been answered, pending
Computer use setup reopens Settings once on launch without changing that outcome. Paired clients acquire
no local settings authority.

Status: Built. Detail: [Start screen: Optional capability card](start-screen.md#optional-capability-card-in-your-first-task).

### First run asks which mode new threads start in

The first run asks once which mode new threads start in, with Auto pre-selected and marked Recommended, and never pre-selects Full access.

- The picker lists Auto, Ask first, Accept edits, Plan and Full access, in that order.
- Where no reviewer can run for a thread, that thread falls back to Ask first and the picker says why.
- The answer is the default for new Work and Code threads; Settings › Work and Settings › Code change it, a Project may override it, and the composer switches a thread's mode in one click.
- Built for Code: the answer is stored as the Code default, Settings › Code › Access changes it, and a Code Project may override it; a Project that remembered Full access before Project modes existed starts its threads in Full access.
- Work takes the same modes without Plan; a new Work thread starts in its Project's mode, else the default the first-run answer or Settings › Work set, and its composer switches a thread's mode.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Guardrail levels](../architecture.md#security-and-authority).

### Work and Code share one capability set and differ in focus

Work and Code run under the same guardrail levels with the same capabilities; they differ in what they show and which tools a thread starts with.

- Shell, local command-line tools, SSH to the person's own machines, file reads and writes, Git, provider-native tools, subagents, routines and Full access are governed identically in both.
- Work is for documents, artifacts and local tasks, keeps its board and Done by a person, and hides developer surfaces until the person turns them on for that Project.
- Code is for coding, shows checkouts and worktrees, and keeps its objective delivery target.
- A thread keeps the kind it was created with; moving work between Work and Code is the person's choice.
- Work's Developer tools switch is set per Project by a person; no agent, routine or import sets it.
- Built: every driver starts a Work session with its shell and Git at the thread's level, Work launches get Code's confinement at the same level, Work threads reach Full access, and each Work turn records shell and Git at its level.
- Built: the Developer tools switch, set from a window on this host and journaled with who and when; it shows a Work Project's terminal and actions.
- Built: an ACP agent whose shell runs in-process without a protocol request is refused as unsupported below Full access; no shipped profile has such a shell.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Modes](../architecture.md#modes-chat-work-and-code) and [Overview and principles](../architecture.md#overview-and-principles).

### Reviewed level: the provider's reviewer or Octant Shield

At the Reviewed level a reviewer stands in for the person's click: the provider's own reviewer where it has one, otherwise Octant Shield.

- The person chooses the reviewer in Settings › Code › Access with a Project override; the provider's own is the default where it exists (built for Code in Settings › Code › Access and on a Code Project's overview).
- A verdict the provider reports is journaled with the provider as approver and shown like a person's approval, with the call it covered. Built in Code: Codex reports approvals and denials, Claude Code only denials; Mistral Vibe's auto-approve mode reports none over ACP. The capability report says which (`reviewVerdicts`), and the host never infers a verdict from a call that ran.
- Taint withdraws the provider's own reviewer for irreversible, publish and new-egress classes.
- Built in Code for the two key CLI providers and for Mistral Vibe's auto-approve mode.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Reviewed](../architecture.md#security-and-authority).

### Octant Shield

Octant Shield is Octant's own automatic approval reviewer for every runtime that routes approvals through Octant, made of a Watcher that reads outside content and a Judge that answers approvals, which never share input.

- The Judge passes each prompt through hard lines and deny rules, then fast allow rules with no model call, then model judgment that sees only the person's messages, the pending call, the root, the level, taint state and the Watcher's labels, never tool results or fetched content.
- A malformed answer, timeout or unreachable model means ask: Shield fails closed to the person.
- Malicious-call classes (secret reads followed by egress, download piped to a shell, obfuscated commands, persistence, credential and keychain access, mass deletion, rewriting shared history, disabling security settings) go to the person or are refused, never allowed by Shield.
- Shield grants per call only, never a standing rule, and never widens the OS sandbox; on a tainted thread it cannot allow irreversible, publish or new-egress classes; after 3 denials in a row or 20 in a thread it pauses.
- The Watcher can only raise: it marks the thread tainted, marks the tool row and tells the Judge; at Full access it only records and marks.
- Shield uses the thread's own provider account and its smallest model by default, or another configured endpoint, sends no telemetry, counts against spend ceilings, and journals every decision.
- A release with Shield requires measuring its false-allow rate on a fixture set of known-safe and known-unsafe calls.
- Build order: the native harness, every runtime's approval path, the picker and Settings, the Watcher, safe networks, then the server registry and SSH.
- Automatic model calls (the Judge and person memory's distilling) share one Settings surface, Settings › Providers & Models › Automatic model calls, set from a local window only. Each job keeps the default (the thread's provider, its smallest model) or uses one account and model the person picks, API-key accounts included; the surface says plainly that what the job reads goes to that provider. Account selection is fully manual: a chosen account that is removed, off, not ready or at its limit sends the Judge's decision to the person (never allowed on its own) and makes distilling wait for a later pass; nothing rotates or fails over. Each decision and usage row names the account that was used. Built. Not folded in: the Octant Harness's advisor review, which is routed by its own slots.
- Built: the Judge (rules, fast allow rules that read a command exactly as written, the model stage, fail-closed, brakes, per-call grants, taint limits, spend reservations with the review's usage recorded under the thread), answering the approvals of the Octant Harness, Claude Code, Codex, OpenCode, ACP agents and Pi on a Code thread or a Work thread in Auto where Shield is the reviewer, and their subagents', each decision journaled and shown on the transcript (on a Work thread, a review row among the turn's tool steps, the Octant Harness's included, which an older client reads as an ordinary step); Auto offered in the picker wherever a reviewer can run; Settings › Code › Access Auto reviewer with a Code Project override of the reviewer, and the Judge's model under Settings › Providers & Models › Automatic model calls; the fixture set with a test of the rule stages and a false-allow measurement script.
- Built: the Watcher, deterministic detectors with no model, over every app-managed tool result and plugin MCP result before the model reads it; each label is journaled as an outside-content source that marks the thread, reaches the Judge as a kind, tags the Code tool row (quietly at Full access) and marks the Code board card; where an adapter sees what a runtime's own web search or fetch returned (an ACP agent's content items, Codex's standalone search results, OpenCode's web tool text items), the Watcher reads that text too, and Chat and Work tool rows carry the same tag as Code's.
- Built: the server registry in Settings › Permissions › Servers (alias, user, Read-only, Operate or Admin profile, described deploys, runbook path), journaled and replayed, local window only; the Judge's SSH rules (a plain ssh call to a registered server as its user passes within its profile, an unregistered host, a key path, a tunnelling option, a lock-out or destructive remote command, or a remote secret read goes to the person or is refused) checked on a real-world command set; every Octant Harness `ssh` command journaled with host and exit status at every level; the person's SSH agent socket handed to harness shells; runbooks given to harness turns as notes that grant nothing.
- Built: the secret guard's list handed to the Watcher and the Judge, and a journaled tag for a secret-then-network command at Full access.
- Not readable: a web search Codex's model provider runs itself reports no results, so it is marked but not read.
- Built: the Judge's fast allow for egress to a safe network, for a call that names its destinations (never a shell command), only while Network limits are on and only on an untainted thread.
- Not built yet: the false-allow rate of a real model is unmeasured.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Octant Shield](../architecture.md#octant-shield).

### Safe networks

The person names trusted places (hosts, domains, address ranges, private-network tags) whose egress passes by rule.

- Set in Settings › Permissions as an account default with a Project override; only a person at a local window changes them, and each list is journaled whole and replayed at startup.
- Egress to anywhere else goes to the Judge at Reviewed and to the person at Guarded; each decision is journaled per host.
- Network limits are a host setting in Settings › Permissions, on by default, journaled (`safe-networks.limits-set@1`), changed only at a local window, replayed at startup, and read at each runtime launch, so a change applies to the next launch. They apply only to sandboxed runtimes (the guarded levels, and Full access that keeps the sandbox); Full access without the sandbox stays open. A recorded choice replays over the default, so a host that turned limits off stays off. A refusal a person can lift says to trust the host under Recently refused in Settings › Permissions › Safe networks. Safe networks stay editable either way, and the page says whether limits are on. Rationale: maintainer request, 2026-11-09 ("network limits on by default — only if sandbox is enabled though"). Live Codex and Claude turns with limits on, and measuring which hosts an ordinary Code turn needs: maintainer checks.
- With limits on, every sandboxed provider runtime (below Full access, and at Full access when the thread keeps the sandbox) runs on its own egress proxy and reaches only its provider's endpoints, its Project's egress rules and these places; Claude's command sandbox sends its network to the same proxy. Full access without the sandbox stays open network, and so does every runtime while limits are off. The same switch lets Octant Harness commands, which always run on their own proxy, also reach these places and, on an untainted thread at Auto, Octant Shield's allow for an unlisted host; for commands, limits on is wider than off.
- A refused host is refused with the host named and listed under Recently refused, where the person can trust it.
- No place or range may reach a link-local address, and a name nothing lists is refused before any lookup.
- Built on macOS and Linux for provider runtimes, Claude's own process (Plan, its probes and its in-process web fetch) included, and for Octant Harness commands, behind the Network limits switch (on by default). A Linux capsule reaches its listener through a Unix socket and its tool bridges through the forwarder's loopback relay; OpenCode keeps open network on Linux because the host connects into its server. Taint suspends places for a harness command as it suspends standing rules, and for a runtime launch that names its thread (Claude's own process and sandbox) while that thread is marked; a launch no thread holds keeps them.
- With limits on, Octant Shield reviews an unlisted host where it is the thread's reviewer at Auto: for Claude's own process and sandbox, and for harness commands, whose allowance is one call rule. Anything else goes to the person. The Judge also allows by rule a call whose every named destination is a trusted place, on an untainted thread.
- Outside Plan Claude's own process is not wrapped, so only its proxy variables route it. No real runtime turn has run on its proxy yet.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Provider runtime network](../architecture.md#provider-runtime-network) and [Octant Shield](../architecture.md#octant-shield).

### Server SSH profiles

- Built: Settings › Remote access distinguishes host control, registered-server commands and server-folder work, shows where each runs and routes to the existing setup without starting work. Read-only connection checks distinguish host readiness, fresh SSH trust/authentication, directory access and supported server runtime, without accepting keys or restarting uncertain commands. Saved server actions remain a separate outcome. Detail: [Server Projects: Setup entry](server-projects.md#setup-entry).

The person registers their own servers with an action profile, and SSH to a registered server is judged by that profile in Work and Code alike.

- A server is a host alias from the person's SSH config, a user, and a profile: Read-only, Operate, or Admin.
- Keys stay out of the agent: the SSH session gets the person's SSH agent or the credential broker, and Shield refuses reads of key paths.
- The credential broker for SSH makes an Ed25519 key per server the person chose it for, keeps it in a namespace of its own, gives out only its public line, and signs only an SSH login request for that key; no route returns the key.
- SSH to an unregistered host goes to the person; destructive or lock-out actions go to the person at every level below Full access.
- Every remote command and its exit status is journaled with the host, remote output passes through the Watcher, and a per-server runbook is context, never authority.
- Built: the server registry in Settings › Permissions › Servers with a Project's own list replacing the account list for its threads; the Judge's rules by profile for `ssh`, `scp`, and `rsync` (a download reads, an upload is Admin, a deleting sync is a lock-out action); every remote command journaled with its host, and its exit status where the runtime reports it (the Octant Harness and Codex); remote output through the Watcher (harness and Codex); runbooks given to every runtime's Work and Code turns as notes that grant nothing; at Guarded the first connection to each host in a thread asks, naming the host, and no remembered approval covers it.
- Built on macOS and Linux: below Full access a harness command that is one plain `ssh`, `scp`, or `rsync` call reaches only the registered servers it names, through per-command relays (loopback ports Seatbelt opens on macOS; on Linux sockets the capsule's forwarder carries a port inside the capsule to) and an agent socket the host owns that only lists keys and signs; the key files stay unreadable and the secret guard's list is unchanged. Octant carries no SSH protocol of its own.
- Built: the credential broker for SSH. A server can sign in with a key Octant keeps instead of the person's agent; Settings › Permissions › Servers shows its public line for the person to add to the server, and a confined command's login for that server goes through an agent socket of its own that only the broker signs for, never falling back to the person's agent.
- Built: a provider runtime's own commands (Codex, OpenCode, ACP agents, Pi, Claude Code) reach the Project's registered servers below Full access, outside Plan, through a read-only folder the launch gets (an SSH config, known hosts, and wrappers first on `PATH`) and an agent socket that signs a login only on a connection bound to a registered server's recorded host key, as its registered user; reaching the address is the runtime's own network, so with Network limits on its `ssh` reaches no server, and a runtime's own sandbox still applies on top.
- Not built yet: a command record (with exit status) for runtimes that do not name their commands (OpenCode, ACP agents, Pi), which keep Shield's journaled decision as their record.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Octant Shield](../architecture.md#octant-shield) and [Modes](../architecture.md#modes-chat-work-and-code).

## Key providers

### Key providers run as themselves

The key providers run inside Octant as they run on their own, with their native subagents, web tools, skills, home configuration, and a trusted Project's hooks, MCP servers and plugins, plus Octant's journal and views.

- Where a native feature reaches beyond Octant's view, the level decides its default: off until the person turns it on at Guarded and Reviewed, on at Full access, in Work and Code alike.
- Plan stays read-only and Chat's filesystem and shell stay withheld at every level.
- Turning a native feature on never turns on a provider's own memory, telemetry or self-update. The provider's own memory has a setting of its own per key provider account, off by default; telemetry and self-update stay off (maintainer request, 2026-11-12). Not built yet: today no such setting exists and provider memory stays off.
- Octant still journals a native child run, marks outside content a native web tool read, and reports each capability honestly.
- Every other provider keeps the deny rules for Project code and skills until it is promoted the same way.
- A person turns it on for a key provider account (Run as itself) or trusts a Work or Code Project for a key provider (Trusted providers), only from a window on the host; both are journaled and the host resolves them for every session it starts or resumes.
- A Project's own settings, hooks, MCP servers and plugins load only in a Project the person trusted for that provider, at every level.
- A thread may turn a key provider's own setup on or off for itself (Account default, On, Off), only from a window on the host and journaled; Off beats Full access, and On never grants a Project's code, which still needs the Project's trust (built for all four key providers).
- Claude Code loads its own subagents (each shown as a child run, every call through the parent's gate), web search and fetch (asking below Full access, marking the thread), home skills, settings and hooks, and a trusted Project's settings, hooks, skills, MCP servers and plugins; its account's MCP servers start only with a trusted Project's.
- Codex keeps its Project skills and, in Chat, the person's tool servers and plugins; its own subagents run at every level, each shown as a child run, with their approvals and app-tool calls answered through the parent's approval path and their web searches marking the thread.
- OpenCode loads its own skills, the MCP servers in the person's own configuration, and the permission rules they wrote (over the level, under Plan's denials and the outside-directory refusal; a catch-all rule is ignored), follows each session its `task` tool delegates to as a child run with its requests answered through the parent, and answers a remembered 2.x approval `always`, saying the grant lives in OpenCode's own store; Octant Shield answers its approvals at Auto like every other runtime's.
- OpenCode reports file changes and compacts its own session on request only from the 2.x release whose server was read for them (2.2.0); an older 2.x release reports no file changes and compaction `unavailable`, 1.x reports compaction `unavailable` and reports no file changes (not built yet), and a change no edit grant names still fails the turn. A compaction request is held open until the run that carried it ends, so the closing idle is never read as a completed turn. Rationale: the narrower choice trusts only a release that was read, since routes and events differ between 2.x releases and the claim adds no authority.
- Mistral Vibe loads its own skills and Project context, the account's MCP servers, connectors and hooks, and a trusted Project's `.vibe` tools, MCP servers, hooks, plugins and agents under its own folder trust; its own subagents run only at Full access in Work and Code, shown as child runs, because a subagent's permission request names nothing Octant could show; it stays on the ACP bridge, because its `vibe-app-server` is an unversioned surface that ships with its own client; reading usage and context from verified `vibe-acp` 3.0.3 is built ([Provider runtimes](provider-runtimes.md#mistral-vibe-surface)). Supplementary file-review reads have a bounded same-task resume/read/close candidate and a current Changes consumer; production capability declaration remains off pending signed-in 3.0.3 read and cold-resume evidence. Requested native compaction has a separate bounded SDK/ACP candidate requiring a correlated structured completion; its production allowlist remains empty pending signed-in nonempty compaction and same-task cold-resume proof. Session-form questionnaires have a bounded adapter and Chat, Work and Code integration, but remain unavailable in production until exact 3.0.3 signed-in question, answer and cancel verification passes (the verified-version allowlist is empty). Native review is not built.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Providers](../architecture.md#providers) and [Provider runtimes: Key providers](provider-runtimes.md#key-providers).

## Release scope

### Technical preview boundary

The first release is the technical preview for Apple-silicon Macs with the provider-neutral plugin and skill marketplace; signing, notarization and self-update ship as one deliverable, because an updater on an unsigned app is an unauthenticated code-delivery channel.

- The first-install download is a disk image (`Octant-<version>-darwin-arm64.dmg`) beside the zip: app, Applications link and a committed Finder layout template, built with `hdiutil` and no Finder automation, signed and notarized exactly when the app is. The update feed keeps listing only the zip. Octant Nightly has no disk image. Owner: [architecture, Current Release Boundary](../architecture.md#current-release-boundary).
- The first release counts as shipped when a maintainer approves the first stable version (a `vMAJOR.MINOR.PATCH` tag, approved in the `stable` environment); daily builds stay previews. That release is the Apple Silicon build, and Linux is not part of it.
- A local package built without signing credentials a maintainer holds is unsigned.
- macOS Swift helpers use explicit deployment targets independent of the compiler host ([packaging](../architecture.md#development-loop)).
- Connectors, a Code thread's own Git and pull-request work, a person's merge from any of their clients, host-local routines, the guardrail levels and the key providers' native features are in scope; Octant Shield is in scope and designed.
- An agent merge or force-push on its own initiative, cloud scheduling, and an Octant-operated hosted service are out of scope.
- Physical phones and tablets, and app-store upload, submission and release, are out of scope (maintainer decision, 2026-10-29); Octant drives the simulator only.
- Public Canvas links are in scope through the self-hostable reference app at `apps/share`; Ogard Labs operates no share-service instance (maintainer decision, 2026-11-07).

Status: Partly built. Since: —. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Native Windows QA packaging

A matching Windows x64 host may build a portable desktop QA archive and check
its native dependencies inside packaged Electron. The archive includes the
source-built private native owner and credential helper at fixed resource paths;
QA-only readers are excluded. Packaging does not acquire a native profile.
This does not enable native
host admission, credentials, Work/Code, an installer, or a signed-update channel.

Status: Partly built. Since: —. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### External user guide and maintainer-owned publication

The VitePress guide lives in `Ogard-Labs/octant-site/docs`, outside the application monorepo, and builds independently for `https://octant.sh/docs/`. Application changes update the guide through companion PRs linked in both descriptions. The site repository runs its docs gates and uploads a static artifact named for the commit. The application repository retains internal specifications and exports semantic theme defaults for the guide; its CI refuses tracked files under the former `apps/docs` path to prevent a second guide source. The maintainer configures and releases that artifact on their VPS; no workflow deploys it or treats an artifact upload as a live publication. Missing pages use the supported VitePress layout slot, and links retain the `/docs/` base.

Status: Built. Since: 2026-11-07. Detail: [Documentation build and VPS handoff](../docs-deployment.md).

### First-preview tracks are design-first

Everything on the work board is in scope for the first proper preview release (maintainer decision, 2026-11-06; there is no separate post-preview track). That covers mobile maturity, language services and a debugger, enterprise identity, disposable desktops, outside provider drivers, the terms and privacy documentation for MIT self-hosted distribution (final legal publication review remains required), and the hub-and-spoke topology, each built only once its specification documents its boundaries.

- The authorization covers design and implementation; creating an account, spending money, submitting to a store, deploying a hosted service, or weakening an invariant each needs a separate maintainer action.
- Remote SSH development environments are in scope; a Code or Work Project on a registered server is built ([Server Projects](server-projects.md)).
- Release-scope choices (public store distribution, the Windows sequence, the full language-services companion) are the maintainers' to schedule and protect no invariant by themselves.

Status: Partly built. Since: 2026-10-26; scope widened to the first preview 2026-11-06. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### One desktop app, Linux next, Windows later

Desktop is one product on macOS, Linux and Windows, and platform differences are fail-closed posture, never a second app.

- The sequence is the Linux desktop shell, then the Linux AppImage with its signed feed, then Windows.
- Windows packaging, installer, feed and packaging CI work may start now (maintainer decision, 2026-11-06, lifting the 2026-10-16 ordering gate on the macOS preview and a Linux self-update); a Windows feed is not trusted before the Linux signed-feed path has been exercised on a real image.
- Work and Code run at Full access on Windows, since Full access uses no sandbox; the guarded levels (Ask first, Accept edits, Auto and Plan) stay refused there until an approved Windows confinement design is documented (maintainer request, 2026-11-12). Not built yet: today Work and Code are unavailable on Windows at every level, and the building blocks below admit neither.
- The independent native owner/control prerequisite uses an in-process Node-API binding, scoped private runtime ACLs, a local first-instance pipe and native PID/birth receipts. Process-lifetime guards preserve refusal of live or unknown writers after endpoint, GC or environment loss. Ordinary Windows host-path/startup admission remains unavailable; native Bun, Node and Electron evidence is required for the prerequisite, not inferred from packaging or credentials.
- Its dependent persistent-profile consumer uses only the current user's native LocalAppData known folder and closed Octant/Nightly test-data mappings. Persistent directories inherit exact owner-plus-SYSTEM DACLs; transient control directories retain non-inheriting DACLs. A private physical-directory-bound UUID selects the control scope, not the remote signing identity. Unsupported external data/log path overrides, unsafe or transplanted records and reparse/alias directories refuse; no Windows startup, migration/restore or Work/Code admission follows.
- Persistent profile creation requires the process token's default owner to be its own user SID before any mutation; an elevated group-default owner refuses because correct DACL inheritance alone cannot make ordinary descendants user-owned. Production never rewrites a host/account token to satisfy this prerequisite.
- Packaged stable desktop consumes the native physical profile UUID and authenticated owner discovery without claiming the child server's owner. Positive absence alone permits launch; native policy and a stable matching host-info/bridge generation protect attachment. Only the child owner publishes/clears projections, no POSIX path override or generic linked-state broker is started, and closing an attached desktop preserves the separately managed host. Native packaged startup/attachment/stop evidence remains required; ordinary Nightly window registration and Work/Code confinement stay separate.

- The Windows credential-store building block uses a scoped native Credential Manager helper and private pipes. Its atomic protected blob accepts at most 2,560 UTF-8 bytes and refuses overflow before mutation; the broker transport bound remains 12 KiB. It supplies the seven existing desktop auxiliary ports through distinct closed purpose namespaces, preserving provider target names and family/store isolation. Oversized auxiliary values are refused without mutation, not split or stored elsewhere. A fixed native per-user mutex serializes all purposes/families/stores across processes; exact User/SYSTEM ownership/access and bounded waits refuse unsafe, blocked or abandoned coordination before mutation, without retry. It does not admit host startup or Chat or remove the Work/Code gate.
- The separate desktop identity service has a closed native Windows CNG/Credential Manager backend: a random32-byte secret, SHA256(raw-secret) fingerprint, HMAC-SHA256 signature, non-exporting ensure/sign/rotate/recovery API, and selected-store/family isolation outside all generic credential purposes. Malformed blobs refuse ensure/sign; explicit atomic rotation recovers them. The existing16KiB request bound remains separate from the2560-byte credential blob cap. This is neither the server/member/roster P-256 identity nor owner unlock/profile identity, and admits no Windows startup or Work/Code. Mac and existing Linux behavior remain unchanged.
- The simulator, the Apple development workbench and window vibrancy stay macOS-only.

Status: Partly built. Since: 2026-10-16; ordering gate lifted 2026-11-06. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Person-controlled update install

An update installs only after its feed signature and artifact hash verify, and only on a relaunch the person starts.

- The release must be strictly newer and name this app (Octant or Octant Nightly), platform, architecture and ring; a release for the other app is refused as the wrong app.
- Anything unverifiable is refused, never downgraded; macOS adds the platform code-signature check, and a Linux AppImage replaces only the image it was launched from.
- Rings are stable, preview and candidate. Octant follows stable or, by the person's in-app choice, candidate (shown as Preview or, with the Nightly install row, Nightly); the Octant Nightly app follows preview.
- Install waits while agents are active; automatic checks default to off until the person opts in, including stores that never recorded a choice. First run asks once whether to check for updates (maintainer request, 2026-11-12); not built yet: today no first-run question is asked. A check carries only version, platform and architecture.

Status: Partly built. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Scope hold until the Full access rule is built

Bots, the Nightly shared-host client, public Canvas links, Browser upload and download manifests, and Windows building blocks beyond running Work and Code at Full access take no new scope until [The Full access rule](#the-full-access-rule) is built (maintainer request, 2026-11-12).

- The hold adds no rule to those features and removes none: their entries keep their current text and status.
- The hosted relay is not held: it was canceled on 2026-10-30, and its specification, code and decision entry are removed.

Status: Designed, not built. Since: 2026-11-12. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

## Process topology and local trust

### Desktop, server and renderer roles

- Crash recovery retains desktop lifetime through replacement-window preparation;
  last-window quit must not race it. Explicit quit wins and recovery is bounded
  to two replacements per minute.
- Stale-owner receipt quarantine is atomic on the data filesystem, separate from
  socket/secret quarantine on the runtime filesystem; identity and receipt-first
  recovery checks remain required. Detail: [Process topology](../architecture.md#process-topology).

The desktop main process owns native windows, menus, the system keychain and all native pickers. The server is the single authority that resolves a client principal for every request and journals every mutation. The renderer holds no authority of its own.

- A picker hands the server the chosen path under the desktop bridge secret and gives the renderer only a single-use receipt bound to its window.
- The server listens on one canonical loopback endpoint, and every mutation goes through services that append to the journal.
- A paired browser mounts the remote shell; the desktop's window-bound sidebar, dock and Settings are not served remotely.
- Process-local approvals and grants expire on the process authority clock (wall time once at start, then suspend-aware elapsed time), so a wall clock set back cannot extend one, and a host restart discards them. A stored grant that must outlive a restart, such as a paired device's expiry, stays on wall time. No persisted local-authority epoch or wall-clock value may block local startup. Detail: [Security and authority, Which clock an expiry runs on](../architecture.md#security-and-authority).
- Browser tool approvals, session grants and credential use are process-local but still read wall time (not built yet).
- Shared product state is host-owned; window bounds, panes, focus, scroll and unsaved drafts stay client-context state. _Here only._

Status: Partly built. Since: —. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Local client context and loopback trust

The local trust class is "holds a secret only the host's OS user can read", not "is on loopback". Loopback plus an admitted origin proves nothing about the caller.

- A browser gets a session only through a one-time launch token that expires after five minutes and is bound to the renderer origin it was minted for.
- Every CLI command and every desktop window presents the desktop bridge secret; a launcher sends it only to the host named by the user's owner-only host receipt.
- The listener admits only its own loopback origin, the packaged renderer and the named development origin; a page on any other loopback port is refused and gets no CORS grant.
- A launch address that is plain HTTP to a non-loopback host is refused, and requests that carry the window capability refuse redirects.

Status: Built. Since: —. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Mobile app and remote clients

The phone app is a remote-control client under the host's authority. Threads are host-owned; the phone stores only device keys, a host registry and session material.

- The phone creates Chat, Work and Code threads and sends follow-up turns under each thread's own authority; approvals, folder binding, file edits and shell stay host-only.
- Attached photos and files go through the mode's own attachment route, and the host strips image metadata from every paired upload.
- Internal mobile beta distribution grants the phone no new authority; public store distribution, external tester groups and store listing stay closed until a separate maintainer action.
- A build counts only after the device pass in the runbook, not when the build service finishes processing it.

Status: Built. Since: —. Detail: [Architecture: Process topology](../architecture.md#process-topology) and [Mobile maturity](mobile-maturity.md#phase-e-public-store-distribution).

### Desktop menu bar and context menus

The menu bar is the closed-window fleet roster, read from the host rather than from open windows. Native context menus carry presentation and opaque action IDs only.

- The roster has three sections, Needs you, Working and Done since you looked, with at most six rows each; a row names the thread title, mode and Project.
- The menu bar raises no notifications, and thread titles never enter the public health response or redacted diagnostics.
- A context-menu contribution cannot supply roles, callbacks, paths, URLs or native commands; the chosen ID returns to the same window, which runs its ordinary action under server authority.
- Chromium's developer tools are hidden in a packaged stable release and kept in development, Preview and candidate builds (2026-11-06).

Status: Built. Since: —. Detail: [Architecture: Desktop menu bar](../architecture.md#desktop-menu-bar) and [Architecture: Desktop context menus](../architecture.md#desktop-context-menus).

### Language services and the debugger

Code editor language services and the debugger run as confined children the server launches per checkout. Agents read the same servers through two read-only tools.

- Explicit checkout references use actual initialized support and current acknowledged draft identity, stay bounded and read-only, and never start or retarget a server. Cancelled queries may retain only an exact late document acknowledgement; a genuinely lost reply offers a distinct person-controlled language-document reload, never an implicit restart from Recheck. Unknown/unsupported support has an explicit external-editor fallback; rename and command-free quick fixes prepare bounded reviewed text changes through that same acknowledgement, and apply through existing per-file save authority with digest, identity and unsaved-draft checks. Cross-file saves stop on conflict and report partial completion.
- The bundled language server can be switched off in Settings; a person can add a static server from a local folder, which installs untrusted and disabled until reviewed and switched on.
- A repository-tooling server starts only after a local-window approval, never in Plan or for a paired device, and agents never start one. The agent's code tool may read through one that is already approved and running (maintainer request, 2026-11-12); not built yet: today agents never read through one.
- An agent may start, control and read a debug session: unasked at Full access, approval-gated per configuration below it, and refused in Plan; a paired device that is not an owner device stays refused (maintainer request, 2026-11-12). Not built yet: today debugger routes are local-window only with no remote action and no agent tool. Nothing a session shows is journaled. Breakpoint configuration alone is saved in device-local renderer storage per endpoint/window/thread/checkout; restored locations are unresolved until an authorized exact file check, changed locations require explicit acceptance, and restoration never starts or attaches a session.
- A debug session ends at once when its thread, posture, checkout, confirmation or Project goes.

Status: Partly built. Since: 2026-10-26. Detail: [Architecture: Process topology](../architecture.md#process-topology) and [Language services](language-services.md#debugger-session-rules).

### Host memory pressure

The host watches its own size and the system's memory pressure and eases itself without stopping a running turn.

- It samples every 15 seconds (every 5 under pressure); a reading the platform cannot give is unknown, never normal.
- Relief runs in a fixed order: log the reading, stop idle provider runtimes and parked sessions, then trim caches it rebuilds on demand.
- The size at which the host counts as low or very low is the Memory limits setting in Settings > Host: Automatic (the built-in pair, scaled down on a small machine) or Custom (two sizes in GB, applied as entered). It is journaled with who, when and the old and new values, applies without a restart, and only a local window can change it.
- The report carries counts and levels only, never a provider, thread or path, and nothing leaves the machine.
- Only a clean shutdown marks the host's memory record clean, so the next start reports an unexpected stop without claiming a cause.

Status: Built. Since: —. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Other agents start work through the local CLI

Another agent on the host's machine starts and follows Octant threads through `octant agent mcp`, a stdio MCP server, or the `octant agent` command line. Both are ordinary local clients under the bridge secret, so the host keeps every authority decision.

- `start_work` takes a prompt and an absolute folder or a Project name; the folder's Project decides Code or Work, and none means Chat. `send_message`, `read_thread`, `answer_question`, `stop_turn`, `list_projects`, `add_project`, `list_threads` and `list_waiting` (everything on the person's Needs you list) follow and continue the work.
- The caller is not the person: the server never answers an approval or other request listed for the person, never starts a thread at Full access, and adds a folder as a Project only when the call says the person asked to work there.
- Each tool call opens its own window authority and revokes it when the call ends; a Chat send keeps its window until the send answers, and a turn keeps running after the window that started it is gone.
- `octant agent --detach` starts a Work or Code turn and returns once the host lists it; `octant agent status <thread>` reads where it got to and what waits on the person.
- Remote callers have no path here; a scoped grant for a bot on another machine would be its own decision.

Status: Built. Since: 2026-11-11. Detail: [Architecture: Native harness, scripted callers and other agents](../architecture.md#native-harness).

## App-managed tools

### Tool families and transport

App-owned tools are capability families: one tool per object with an operation enum and an on-demand help operation. Every runtime receives the same definitions through the transport its adapter verified, and no transport edits a person's provider configuration.

- A family whose grant or capability is off is omitted rather than advertised and refused; help never reaches the family's executor. Where the runtime keeps its own tool list, omission is per session: a Claude Code session lists a tool from the first turn that offers it and refuses it in turns that do not, so the list only grows and the cached prefix changes only when a new tool arrives.
- A runtime connection binds its tool catalogue before it sends its prompt and accepts only the expected in-process server and offered tool names. A catalogue change cannot overlap a running tool-enabled turn. _Here only._
- Late, duplicate or cancelled tool answers are refused, and per-request cancellation reaches the executor even while it waits for approval. _Here only._
- Browser read-page accepts an optional CSS selector or snapshot ref. Screenshots reach the provider through its image-result channel, not as encoded bytes in text, and origin approval and task authority apply before capture. _Here only._
- A missing, malformed or oversized capture is refused.

Status: Built. Since: —. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### Browser and Computer as tools

Browser and Computer are tools, not mentions. The host offers them on every eligible turn, and authority comes from the person's approval at the moment of action.

- Browser is offered in Work and Code when the provider carries app-managed tools, never in Chat; Plan admits only the operations that read the page already open in the thread's own Browser (snapshot, read-page, screenshot, diagnostics, audit, tab-list, wait, flow-list, help, a batch of those) and stop, under every other gate, and refuses the rest, a recording included; a recording already running when Plan begins is stopped and discarded. One table of operations, with the two the host issues for a recording, decides it, so a new operation takes a row before it compiles.
- Computer is offered only when the plugin is enabled, a screen bridge or leased desktop exists, the tool is not constrained out and the turn is not in Plan.
- The first Computer action on each application asks once, even under Full access, and the grant lasts the thread with no five-minute expiry; a setting can remember it for the Project. Below Full access every Computer action asks again once outside content has entered the thread; at Full access it does not (maintainer request, 2026-11-12). Not built yet: today the re-ask after outside content applies at Full access too, a grant held for an action expires after five minutes, and no setting remembers a grant for the Project.
- Only the person at this Mac approves control of this Mac; a paired device may read session state but cannot approve or stop it.
- "Always allow" remembers an origin only through the approval answer, covers Private pages only, and a Project or Personal profile remembers the (origin, profile) pair. At Full access a Private page needs no site approval and may navigate across origins; a profile page keeps its site approval, which the person can remember or widen to "Allow all sites in this profile" (maintainer request, 2026-11-12). Not built yet: today a Private page asks for each new origin at Full access and no profile-wide allow exists.

Status: Partly built. Since: —. Detail: [Architecture: Process topology](../architecture.md#process-topology).

### GitHub reads for Code agents

A Code thread's agent reads its Project's delivery repository through one read-only family, `octant_github`: lists of issues, pull requests and projects, one issue or pull request in detail, and a search of issues and pull requests.

- The host fixes the repository to the thread's delivery target; no input names a repository, host, endpoint or flag, and a field an operation does not take is refused. A search keeps only `author:` and `#number` qualifiers and always carries the server's own `repo:`.
- Every call re-checks the thread's binding, its tool constraints and the read's GitHub capability on a fresh snapshot, and changes nothing on GitHub.
- Pages hold 1 to 30 rows; a size outside that is refused, not clamped. An issue's body is cut to 8 KB and each comment to 2 KB, only the newest ten comments come back, and every cut is stated (`bodyTruncated`, `truncated`, `commentsOmitted`).
- A successful read is journaled as outside content before the model sees it, and withheld when it cannot be.

Status: Built. Since: —. Detail: [Architecture: Reading GitHub](../architecture.md#modes-chat-work-and-code).

### Zen assistant tool

Zen's assistant arranges its window's Zen space through one family, `octant_zen`, offered only to the Chat thread bound as that space's assistant.

- `get-space` returns the space's version and each element's id and layout, never element content, so a model can make its first change.
- Every change names the version it applies to; an out-of-date one changes nothing and the conflict carries the current version.
- `create-widget` offers only the kinds it creates (Notes, Checklist, Timer); a recipe widget exists only after the person confirms a preview.
- Labels journaled under the seven tools it replaced (`octant_zen_*`) still read.
- The tool exists only while the bundled Zen plugin is on; switching the plugin off withholds it and refuses the Zen routes without deleting any Zen data.

Status: Built. Since: —. Detail: [Architecture: Zen assistant tool](../architecture.md#zen-assistant-tool).

### One web search

Octant has one web search definition, `web-search`, offered to every Chat provider while the thread's research is on and its route searches through SearXNG, and by the native harness in every mode where its research or network grant allows.

- A harness Chat thread gets it once, from the harness; the turn adds no second copy.
- A missing, empty or over-long query is invalid and searches nothing; no other text stands in for it.
- A successful result marks the thread as having read outside content. The harness's tainted-query refusal applies to harness threads, as before, and not to a Chat thread on another provider.

Status: Built. Since: —. Detail: [Architecture: Web search](../architecture.md#web-search).

## Canvas authority

### Canvas ownership and tiers

A Canvas belongs to its thread's Project, or for a Chat thread in no Project to the thread alone. Finished work comes in three tiers (typed blocks, static frames, running frames), and each new block kind is gated by a schema version.

- A thread-owned Canvas holds no file, shell, Git or network authority, takes images only from its own thread, and is never mirrored or published to a replica. A Chat Canvas outside a Project can be shared through the export destinations (maintainer request, 2026-11-12); not built yet: today it is never shared.
- Plan keeps `create` and `revise`, because a Canvas changes only the thread's own document; the agent tool has no publish or share, and the mirror and replica sync write nothing for a Plan thread.
- An older runtime refuses a document of a newer schema version rather than misreading it.
- A person's change is journaled as a new head version with a host-stamped actor, and a renderer never authors as an agent.
- `describe` reads no Project data and creates no artifact; `preview` renders with the network off and no server address or credential.

Status: Partly built. Since: —. Detail: [Architecture: Canvas documents, designs, and prototypes](../architecture.md#canvas-documents-designs-and-prototypes).

### Canvas frame safety, import and sharing

Frames run nothing unless a design declares script, and a running design never runs where it could reach the network unless the person turned on that Canvas's "Allow network" switch.

- A static frame never gets script permission, and no frame has both script and same-origin permission.
- On desktop a running design runs in a prototype host process with no network route and no resolver; if that closure cannot be verified, the prototype does not run. A design or prototype has a per-Canvas "Allow network" switch that only the person sets, off by default (maintainer request, 2026-11-12). Not built yet: today no such switch exists and a running design never has a network route.
- A remote browser cannot network-contain a running frame; that exposure is accepted and the Run control says so.
- Import HTML is a create like any other, bounded to 256 KiB; nothing it references is fetched, and a paired device may not import.
- A share carries a design only with the sharer's acknowledgement. A public link is off by default and published only from a local approval card, never by an agent.

Status: Partly built. Since: —. Detail: [Architecture: Canvas documents, designs, and prototypes](../architecture.md#canvas-documents-designs-and-prototypes) and [Canvas public links](canvas-public-links.md).

## Device transport

### Apple and Android scope

Apple development is simulator-only. Physical devices and store upload, submission and release are out of scope, and `octant_apple` offers no device or distribution operation.

- The host runs no device-control tool, signs nothing for a device and serves no device or distribution route; an agent that needs one uses its own provider tools under the ordinary sandbox and approvals.
- Journals with earlier device or distribution validation events replay unchanged; leftover files and the stored store key are left in place and nothing reads them.
- Apple discovery is derived and refreshable from the checkout; Octant never rewrites projects, schemes, build settings or manifests to make discovery pass. _Here only._
- A test run preserves its result bundle and logs as evidence and reports a structured verdict. If parsing fails it keeps the raw artifact and reports the verdict incomplete. _Here only._
- A build's derived data is private to its action and removed when the action ends; a test run's result bundle is kept as its artifact first, and the host clears any leftover derived data at start (maintainer request, 2026-11-10). _Here only._
- After a restart, ambiguous device work is waiting or inconclusive, never verified. _Here only._

Status: Built. Since: 2026-10-29. Detail: [Architecture: Device transport and evidence](../architecture.md#device-transport-and-evidence) and [Device workbench](device-workbench.md).

### Device destinations and ownership

A simulator, emulator, local-Mac or computer-use destination has a stable host-local identity and an exclusive owner or lease. The screen is streamed through the host, authorized like a screenshot, and never stored.

- No other thread may reset, erase, shut down or take over a destination another workflow owns. _Here only._
- Erase, content reset or runtime installation is never an implicit recovery step, and Octant stops only a process it owns and never kills by broad name. _Here only._
- Device activity, evidence and cancellation are scoped to the requesting task, checkout and authority; an action id alone grants no access. _Here only._
- Replaying a completed input needs current authorization and an exact request fingerprint; reusing an action id with changed input or while running is refused. Device artifacts keep task and checkout ownership on disk. _Here only._
- Closing a tab does not shut the destination down, and a raw capture lands in a host-private directory only its own launch may read.

Status: Built. Since: —. Detail: [Architecture: Device transport and evidence](../architecture.md#device-transport-and-evidence).

### Device input and agent device tools

Input rides the workbench control channel with actor attribution. Agent device tools follow the thread's posture per operation rather than a Full-access gate on the whole tool.

- Reads (discover, status, screenshot, logs, Android's describe-ui, opening an already booted destination) run under every posture, Plan included; every other operation is an effect that Plan refuses, Full access sends, and other postures ask for.
- An agent reads a device as text: Android describe-ui lists labelled on-screen elements with centres in tap pixels, an Android tap may name an element matched exactly by resource-id, then content-desc, then text (none or several matches are refused with the count), and both tools' logs return a bounded tail kept from the newest end, with crashes on request. The text returns in the tool result and is kept as a log artifact; evidence keeps only a note. iOS describe-ui and tap by element are not built: they need the native device helper. Checks on a real emulator and a real Mac are still owed.
- Allow input opens a destination to input for fifteen minutes for that window, thread and destination, and only a delivered input renews it. _Here only._
- The grant lives in host memory, so a restart asks again. It ends with the window's authority, a successful shutdown or a discovery that finds the destination no longer booted. It never covers boot, shutdown, Open URL or Rotate. _Here only._
- Open URL and Rotate are effects confirmed on their own; an input whose delivery is unknown is reported interrupted, and an off-screen point is refused, never clamped.
- An explicit successful screenshot may deliver one PNG through the provider image channel, read through thread and checkout authority; oversized, unavailable or non-PNG output is refused, never resized. Boot, run, open, input and discovery never send screen images. _Here only._
- `octant_terminal` follows the thread's level: Plan refuses it, Full access runs it, and below that each command the agent types asks the person with the command shown.

Status: Built. Since: —. Detail: [Architecture: Device transport and evidence](../architecture.md#device-transport-and-evidence).

## Modes, Projects and authority

### Modes

Modes are server-enforced domain policy, not renderer flags. The shell shows two modes, Work and Code, and Work presents the Chat and Work domains together.

- Chat and Work can be switched off in Settings; Code is always available, and disabling a mode never deletes its data.
- A new-thread composer chooses Chat (no folder) or In a folder (a Work thread bound to a Project root). The choice only selects the create command, and nothing converts a thread between Chat and Work.
- The mode switcher is the Work and Code icon pair at the top of the sidebar, not in the title band; each mode's name is its tooltip and accessible name (maintainer request, 2026-11-09). Detail: [DESIGN.md: Shell and layout](../../DESIGN.md#shell-and-layout).
- Chat binds a virtual, memory-scoped Project or none; Work binds exactly one OS-confined root; Code binds exactly one directory and selects a checkout inside it.
- Project memory is scoped to one Project and keeps source, kind, timestamps and supersession; moving it across Projects or modes is explicit and keeps provenance. Person memory, beside it, crosses Projects ([Person memory across Projects](#person-memory-across-projects)). _Here only._
- Every Chat, Work and Code turn in a Project carries its active Project memory. Agents read it and write to it through `octant_memory`. At Full access an agent's write is accepted without a confirmation, marked agent-written with its thread and shown in the thread; below Full access a Project setting "Agents may write Project memory without asking" (off by default) does the same, and otherwise the write waits for the person's confirmation in the thread with no answer remembered. Plan refuses writes (maintainer request, 2026-11-12). Not built yet: today every write waits for the person's confirmation at every level, the path built 2026-11-08 ([Architecture: Project memory](../architecture.md#project-memory)).
- Move to Project: a No-project Chat can be filed into a Chat Project, and a Work or Code thread into another Project of its own mode. The thread keeps its kind, history and guardrail level and gains no filesystem reach: a Work or Code thread moves only into an active Project whose folder is its own folder or contains it, and is refused while a turn runs or the thread waits on the person. A Code thread also needs its checkout to stay valid, so only a Project bound to the same repository folder is accepted. The server checks authority before the move, only a person can make it, and it is journaled with who and when.

Status: Partly built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Projects pinned to the icon rail

A person can pin a Project to the icon rail, and a pinned Project is a tile that opens it.

- Pin and unpin are in the Project's own menu in the sidebar ("Pin to rail", "Unpin from rail") and in the context menu of the pinned tile; More never lists them, because it holds only the destinations the rail does not.
- Pins are a saved shell preference stored and synced like the sidebar destinations, by Project id, in the order pinned. Settings saved before pins decode to none; a pin for a Project that no longer exists draws nothing and is dropped the next time pins are saved, but only once the Project list is loaded and complete; two quick pin actions both land.
- A pinned tile shows in both rail placements, after the divider under the destinations. In the collapsed rail the pinned Projects come first and the automatic list fills what is left of six tiles without repeating one; the rail draws at most six pinned tiles so Settings and the usage rings stay in the window, and Pin to rail is disabled with its reason once six are pinned.
- Opening a pinned tile is the same action as opening that Project anywhere else; pinning grants nothing.

Status: Built. Since: 2026-11-11. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Project icons

A Project shows the favicon or app icon found inside its own folder wherever Projects are listed, and keeps its letter tile or folder glyph when there is none.

- The host owns the read, over a short fixed list of well-known relative paths with the first valid file winning; there is no directory walk, no pattern search and no network fetch. The renderer never reads disk.
- A file counts only when no component of its path below the Project's folder is a symbolic link (the host opens it anchored to the folder with a no-follow open on macOS and Linux, and finds no icon on other platforms, so a link swapped in during the lookup cannot lead outside; an icon reached through any link, even inside the folder, is not used), it is a regular file of at most 256 KB, and its first bytes match its extension; a Chat Project, which has no folder, has no icon.
- It is served on the authenticated Project API (a window capability, or a paired device's read of the host) with `nosniff`, a script-forbidding content security policy and an ETag; a missing icon is a plain 404, not a logged error.
- The renderer draws it as an `<img>` at the icon scale, fetched once per Project per session, so the polled navigation model never causes a request.

Status: Built. Since: 2026-11-11. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Code starting posture and Plan

Code starts in the mode the person picked at first run (Auto pre-selected where the provider has a reviewer, else Ask first), changed in Settings › Code › Access or per Project. Plan mode is always read-only.

- A Project that remembered Full access before Project modes existed starts its threads in Full access.
- Creating a Code Project may explicitly initialize Git in the folder; if that fails, creation is refused and no Project is journaled.

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Chat has no filesystem or shell authority

Chat's missing file and shell authority is withheld by rule, not only in today's build. A Chat session runs on its per-thread scratch directory and every provider approval request is declined.

- Provider runtimes launch confined with exec and fork denied or with no execution environment, and a sandbox that only blocks writes is not enough because reads never escalate.
- Octant-managed tools (research, Canvas) are unaffected because they run on the host.
- A person's own tool servers stay off in Chat until the person lets the provider run as itself for the account (built for Codex), or for one thread with its own-setup choice.
- Provider-owned memory stays off in every mode unless the person turns it on, because a provider's global memory follows its own rules into every Project, outside Octant's controls: a setting per key provider account, off by default, turns that provider's own memory on (maintainer request, 2026-11-12). Not built yet: today no such setting exists and it stays off. Octant's own person memory is the cross-Project layer.

Status: Partly built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Person memory across Projects

Octant keeps a memory of the person beside Project memory: after a thread ends it learns preferences, how the person works and what they did, and every new Chat, Work and Code thread on every provider starts with it. It is on by default with no per-entry prompt, and the person can turn it off.

- Distilled once per thread the person put away after memory began, from the thread's title and the person's own messages only, never agent answers, tool output or files; secrets are redacted before the model call and before storage, and an entry naming a protected path is dropped.
- One tool-less model call per ended thread on the thread's provider and its smallest model unless Settings › Providers & Models › Automatic model calls picks another account (one that is off, not ready or at its limit makes the thread wait for a later pass, never another account), recorded as a `person-memory` usage row naming the account, behind the one seam `personMemoryDistillationAllowed`. Open risk: whether background calls on subscription sign-ins fit each provider's terms is being checked.
- The block is placed after Octant's instructions, holds only entries older than the thread so its text is stable for prompt caching, is capped at 2,000 characters and is framed as data, not instructions.
- `octant_past_threads` searches remembered digests and entries only and returns at most five excerpts with their source; it reads no transcript or file and grants no authority.
- Settings › Memory: one switch for everything, one for searching past threads, Projects kept out (not learned from, not shown, no block or tool in them), threads that leave no trace (set from the thread menu), each entry editable and deletable with its sources, and Forget everything. Deleting erases the events from the journal; a thread purge removes what came only from it.
- Only a turn a window on this host started gets the block or the tool: not a paired device, a routine or other host-started turn, or a subagent. Memory is never synced to a hub, spoke or peer host. First run explains memory and where to change it without assuming it is on; the optional Your first task card reports the current host setting.
- Export my data carries person memory: a `person-memory` page with every entry and the threads it came from. Built.

Status: Built. Since: 2026-11-01. Detail: [Architecture: Person memory](../architecture.md#person-memory).

### Default Projects

A Work or Code thread started without a chosen Project lands in the mode's default Project, provisioned under the default folder on first use.

- The default folder is `~/Octant` unless changed, always inside the user's home, and stored by its real path. Its wire value preserves native POSIX or Windows drive-absolute spelling; drive-relative, UNC/device and NUL values refuse. Host-native canonical and inside-home checks remain required, independent of path decoding.
- Work always offers its default Project; Code offers one only when the Git requirement ("Code needs a Git repository") is off.
- With the requirement off, a Code thread may start in a plain folder, and every Git-backed feature reports itself unavailable there.

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### SSH and remote machines

An agent reaches a remote machine with `ssh` through the thread's shell, in Work and Code alike. Octant stores no SSH key, writes no SSH config and adds no SSH transport.

- At Guarded, the first connection to each host in a thread asks the person, naming the host.
- Network egress for shell commands follows the level: Project rules at Guarded and Reviewed, open at Full access.
- A Code Project may be bound to a folder on a registered server, in a catalog of its own; the connection uses this host's `ssh` and the person's agent, forwards nothing, refuses an unknown host key, shares one connection per server through a private control socket, and fails closed with no local fallback. Built: the catalog, the connection, the folder check, Octant Harness Code threads with files, commands and Git on the server at every level (a remembered approval never covers a command there), thread terminals and the Project terminal as logins on the server, the Git tab and the dock's Review tool with Git on the server (Plan changes nothing there), the Files panel, file editor and Tests panel reading, saving and running on the server (saves checked by digest, no folder watch), and a thread's own worktree made with Git on the server and its pull request by repository and branch name (Plan makes no worktree there). A Work Project may be bound there too (`mode: "work"`; a Code Project's record is unchanged), whose Work threads run on the Octant Harness with file tools and commands on the server and no tool of this host (built, with its Work sidebar, composer, thread view and read-only Files listing of server names and sizes with Refresh; no previews, editing, watching or output attribution; [Server Projects](server-projects.md)). Its tests ran against a throwaway local `sshd` only, never a real server, and pull requests against a stand-in for `gh`, never GitHub.
- A local person can open an owned loopback dev-server preview for a server Project. Dedicated SSH stdio streams carry HTTP and WebSockets without changing the ordinary command connection; stop, connection loss, revocation and explicit same-endpoint reconnect are visible. Stop/reopen and shutdown await retained resource receipts and pending starts, with bounded failure if cleanup is unconfirmed ([Server Projects](server-projects.md#person-operated-dev-server-previews)).
- On a server, no login shell parses a call: the script and arguments travel encoded for `sh` alone, so any login shell (`fish` and the `csh` family included) reads them unchanged. Octant's file tools, Files panel, and search there refuse the secret guard's one list at every level, the person's changes included; a shell command there can still read what the login user can, gated only by the level. At Reviewed the server's action profile caps a Project's own calls and this host's safe places and protected paths judge nothing there; Shield treats a server thread as having read outside content, and the Watcher marks one it finds steering text in. A server with bound Projects cannot change its alias or user (built; [Server Projects](server-projects.md)).
- The earlier SSH target binding was removed and old journals still replay; its `remote-root` threads keep refusing every operation.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Repositories, checkouts and file services

A repository is identified by an opaque digest of its canonical Git common directory, not a path. File, terminal, test and Git operations are server-owned services; panes are clients, never owners.

- Managed worktrees live under a sibling root that needs its own confirmed grant and receive an ownership receipt before use; they are never silently reset or reused. _Here only._
- Archiving a Code thread removes its managed worktree only when it has no uncommitted changes, its commit is pushed or merged, and no turn of the thread is still in progress; the branch stays. Settings › Code › Worktrees lists what archiving kept, with sizes, and Remove asks once, refuses uncommitted changes or a turn still in progress, and keeps the branch. Only a local window lists or removes them (maintainer request, 2026-11-11). _Here only._
- The host reads a worktree's changes without running anything the repository configured: fsmonitor off, no optional locks, submodules compared by commit, and a repository whose own config sets a filter command is not read. _Here only._
- Settings › Code › Worktrees on this computer finds other tools' and agents' worktrees by a bounded walk of the home folder plus the Code Projects' repositories, then `git worktree list` per repository, on macOS, Linux and Windows; Spotlight does not index `.git` files. Remove refuses the main checkout, locked, Octant-owned, relinked, dirty and filter-setting worktrees, asks to confirm commits only its branch has and use in the last 15 minutes, refuses a detached HEAD's own commits, keeps the branch, and for a gone folder removes only that worktree's record, refusing a detached one whose commits only that record keeps. Bulk removal asks once first. Settings › Code › Xcode builds lists DerivedData folders whose workspace is gone or unused for 30 days. Local window only; nothing is journaled (maintainer request, 2026-11-11). _Here only._
- Operations use checkout-relative targets, symlink and identity verification, atomic writes, bounded output and structured verdicts. _Here only._
- Rebinding a Code Project leaves old threads unavailable until a person explicitly rebinds them; a session grant of Full access does not survive, and a thread with its own worktree is refused.
- Repository tests stay cancellable during command discovery.

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Forks, checkpoints and restore

A fork is a managed-worktree creation the host resolves itself from a finished turn. A checkpoint is a user-marked point that copies no thread state, and restoring one still forks. Chat, Work and Code threads rewind and fork instead of editing a sent message (maintainer decision, 2026-11-01): a thread can now move back in place.

- A fork starts approval-gated with no inherited profile, running turn or session grant, and is refused when its text handoff cannot be built.
- Every Chat, Work and Code message offers Fork from here (a reply forks through itself, a person's message through the reply before it) and Rewind to here, with a choice of conversation, files, or both, asked once with a preview of what changes. A Work fork is a new Work thread carrying the messages through that point as text; a Chat fork is the Chat branch.
- Chat has no edit: the control and its command are gone. Chat has no files, so its rewind covers the conversation only, gives the thread no filesystem or shell authority, and returns the removed message to the composer. It is journaled as `chat.thread-rewound@1` and marks the removed turns; journals that hold earlier edits still replay and display as before. Built.
- A rewind journals what it removed; every conversation read, handoff, context plan and replay leave those turns out, and the person's message comes back to the composer. Files come back from Octant's own checkpoints as an ordinary undoable restore that runs first. Server-Project Code threads, Plan threads and Work threads rewind the conversation only and say why.
- The phone offers Fork from here and Rewind to here on every message of a thread it can open, through the same host routes (built). It offers the files part of a Code rewind only under Full access, where the host asks no approval, shows the same preview and confirmation, and otherwise rewinds the conversation only and says why: approvals are taken only at a window on the computer.
- A rewind is refused while the thread's turn runs; its files part also while another thread has a live writing turn on the same checkout root.
- Removed turns stop reaching the model: in Work and Code a provider reporting `sessionRollback` (the Octant Harness) continues its own session cut back at the last kept turn; every other provider reports it unsupported and starts a fresh session with a disclosed text handoff of the kept turns. Chat uses the handoff, or the host's rebuild, for every provider.
- A checkpoint is journaled on its own aggregate (marked, forgotten, restored). Chat branches through the marked turn; Code creates a thread on its own worktree at the recorded revision with a fresh delivery branch. The origin is untouched. _Here only._
- A Code checkpoint is refused when the host never caught a revision. Forgetting retires the marker and leaves it readable. _Here only._
- An in-place Git restore keeps its own name, is never presented as the same gesture, and is refused as a conflict while another thread has a live writing turn on the same checkout root.
- Discard takes the same live-writer conflict check and checkout-root serialization immediately before mutation, after approval, and also refuses during its own starting or live turn. Its state-token and tracked-path checks remain required. No route reaches the Git service's commit revert today; a route added for it must take the same check.

Status: Partly built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Outside content marks follow the content

A thread that reads outside content is marked, and the mark follows the content into any thread, Canvas or message that carries it.

- Forks, Chat branches, follow-ups, side tasks, planner-confirmed threads, `#thread` mentions, Side Chats, delivered agent messages and Canvas reads and writes mark the new or reading thread.
- The mark and the thread commit in one journal unit, and a mark that cannot be recorded refuses the creation or withholds the text.
- A source a person cleared passes on nothing, and a Work-to-Code promotion starts unmarked because no agent-written text crosses.

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Work promotion and the status file

Work never silently becomes Code. A promotion proposal is an offer, and only explicit user approval creates the linked Code thread.

- A promotion moves focus and tooling, not authority; the new thread takes the level of its own Project, never one carried over from Work.
- A thread never moves from Code to Work (maintainer decision, 2026-11-01): Code can do everything Work can, so a person forks the thread or starts a new one.
- A Work Project may opt into a `STATUS.md` in its folder, off by default and refused for the default-folder Project.
- A turn updates `STATUS.md` only when it changes where the work stands; a stale status makes a task take stock on its first turn unless the request is a greeting or unrelated to the work.
- Octant never writes an agent brief into a user folder, and a Work turn does not read an existing one.

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Records of what a turn changed

A turn records an observation of what changed while it ran, never an attribution.

- A Work turn watches its bound folder from before the provider starts until the turn settles and records relative paths only, reading no file. An unnameable or refused path marks the record truncated, and a host that cannot watch records nothing. _Here only._
- A Code turn compares the checkout tree-to-tree at start and settle and journals at most 32 paths with lines added and removed and a binary flag. Renames are both paths. _Here only._
- A Code turn with no starting capture (Plan, unreadable checkout) or no change records nothing, and recording never fails or delays the turn. _Here only._

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Thread plans

A thread's plan is its own journaled aggregate of ordered steps, with at most one live plan per thread, proposed and approved as a whole.

- Approval names the exact revision read; rewriting the steps mints a new revision and returns the plan to proposed. _Here only._
- Changing the access level, leaving Plan mode included, never approves a plan. _Here only._
- Steps become work only once the plan is approved; before then the host refuses to start, finish or drop one, and a proposal cannot claim progress. _Here only._

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Project scaffolds

A project scaffold is a curated catalog entry with a pinned generator, run as an ordinary approval-gated Code operation.

- A moving version fails to decode, and the host composes the command line from the catalog record and one directory name; an entry cannot contribute a flag, path or shell fragment. _Here only._
- The directory is one path segment with no separators, traversal, leading dot or leading "-", and an existing name refuses the run. _Here only._
- Plan refuses a scaffold. It runs confined with network egress allowed and caches redirected to a private directory, installs no dependencies, and a run that does not exit cleanly is never reported as a created project. _Here only._

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Projects with several folders

A Work or Code Project has one main folder plus extra folders the person adds; each gets the same access at the task's level. New tasks choose a server-issued working-folder identity and relative subdirectory at creation. Code Git and checkouts retain their own root.

- Only a person adds or removes an extra folder, through a folder-picker receipt; each change is journaled with who and when and replays, and a Project made before the field existed has none.
- An extra folder is never the home folder or above it, a system or credential folder, the main folder, or inside or around the main folder or another extra folder; a Project has at most 16.
- The OS profiles, the provider sandboxes and approval scopes, the Octant Harness file tools and Octant Shield's fast read and edit rules grant an extra folder exactly what they grant the main folder; Plan reads it without writing, and Full access stays unwrapped.
- Each Work and Code turn names the extra folders to the agent.
- Worktrees, checkouts and Git stay in the main folder; an extra folder is a plain folder. A Project terminal and a saved Project action start in the main folder by default and in any folder the Project lists when the person picks one; the host refuses any other path, and the terminal binds every listed folder like the main one. A Code thread's terminal binds the same folders, and its start command may name a listed folder to start in.
- Language services, debug sessions and repository tests cover an extra folder as a plain folder: a file there is named by absolute path, the host places it in one of the Project's current extra folders or refuses it, and a server, session or test run takes the folder as its own bound root.
- A path relative to the main folder is always the main folder's; a file in an extra folder is named by its absolute path, which the host honours only inside one of the Project's current extra folders. The Work Files listing and a turn's record of changed files cover every folder, and the Work overview lists each extra folder's top level by its last component, with no host path.
- Dropped local desktop folders become editable absolute references in all four Work/Code composers after host metadata-only validation against current roots; they grant nothing, read no contents, and change no working directory. Remote client paths and future managed checkouts refuse explicitly.
- The `@file` picker (Work and Code) lists and reads a file in an extra folder by its absolute path, only inside one of the Project's current extra folders; Code search covers the extra folders and marks each match with its folder; the harness shell and the ACP client file and terminal tools reach every Project folder.
- The Code editor and the Files explorer open, read and save a file in an extra folder, named by its absolute path and placed by the same root authority; each extra folder is its own tree beneath the checkout's, and a search match there opens.
- A new task's approved folder identity binds the current Project binding and folder-add revision; it cannot be changed in place. Provider, terminal defaults, saved actions and new Work artifacts use it. Revocation or loss cancels running work and refuses new effects without redirecting output. Existing threads retain their earlier interpretation.
- Work artifact records keep that identity and their relative destination through revise, rename, conversion, export and preview, including replay and removed/re-added root negatives. Unscoped and legacy artifacts stay in the main folder. An extra working folder is shared; Code Git, PR, changed files and Review remain checkout-only and say so.
- A terminal folder change names the destination and explains process termination before an explicit restart; Cancel preserves the running shell and New terminal remains a deliberate alternative.
- The explorer watches the checkout and all sixteen extra roots over one authenticated stream shared by duplicate views; the host shares physical watchers. Notices identify the root, reconnect/truncation reconciles every visible tree, and removed/relinked folders terminate the stream. Extra-root language services watch changes and reconcile open documents after a dropped watch. Only exact current roots can be watched. The Terminal tab can start in a listed extra folder.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Projects with several folders](../architecture.md#projects-with-several-folders).

## Agents and delegation

### Child agent runs

A child run starts only when the thread's agent delegates through `octant_agents`, the one child-run tool every runtime is offered, an Octant Harness lead included. Every child uses the same host admission, routing, workspace and lifecycle services.

- `octant_agents` operations are `capabilities`, `delegate`, `status`, `wait`, `cancel` and `follow-up`; a thread is never offered a second child-run tool, and a Side Chat and a server Project thread are offered none.
- Delegation is refused while subagents are off or its harness session is paused. Once the thread has read outside content, delegation at Full access is not refused and the mark follows into the child; below Full access the person (or the reviewer at Auto) is asked once per thread instead of a refusal. A child's reply that `wait` hands back marks the parent only when the child itself was marked (maintainer request, 2026-11-12). Not built yet: today delegation is refused once the thread has read outside content, and every reply `wait` hands back marks the parent first, as a delivered reply does.
- The harness's retired `delegate` tool name stays readable in journaled turn records and approvals, so old journals replay.
- Subagent creation is one setting with two values, Off and Automatic. Only the thread's agent starts a child, and the parent and child hierarchy is the only subagent surface. _Here only._
- The host prepares the child's workspace (research-only for Chat, the Project root for Work, an isolated managed worktree for Code); no client supplies a path, and wider-than-parent grants are refused.
- Children default to committed revision. The person may explicitly review and select a stable current-edits checkpoint for children from a parent task; each child records its base/snapshot and preserves staging independently. Incomplete or stale snapshots refuse before admission; copies are never silently reapplied. Provider-owned hidden subagents stay disabled.
- Opt-in parent context preserves up to eight original user inputs (32 MiB total) through a purgeable immutable manifest. Unsupported, missing, changed or revoked inputs refuse delivery; explicit text-only context records omissions, including bounded counts for unlisted originals and an honest unavailable-metadata marker. The child can inspect its source input manifest separately from its brief and report.
- Concurrency is the person's setting (defaults 4 per thread and 8 per host, at most 16); a turn defaults to 120 working minutes, person-selectable from 1–240 before the next attempt, and may have no limit at Full access (maintainer request, 2026-11-12); not built yet: today the default is 30 working minutes and a limit is always set. Retry/Resume start fresh; approval and answer waits pause the clock, and independent two-minute acquisition/startup bounds remain. Recorded attempt and cumulative working time use the existing result evidence and label gaps.
- Cancelling a child tree proceeds leaves-up and completes only after each process is confirmed stopped; an ambiguous outcome becomes waiting, failed or interrupted, never completed. _Here only._

Status: Partly built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Child approvals and results

A child approval permits only that request, and a child result implies no delivery, review, merge or deployment.

- A child approval never creates or consumes a remembered lead-session grant and cannot approve an opaque provider action in Plan. The parent composer answers authoritative child request IDs inline without replacing the parent's own request; stale/disconnected views cannot answer. A paired device may answer only the managed requests owned by its own execution scope, once or deny, with live authority checked; reads and restart never claim ownership.
- Child results, routine runs and usage-limit resumes run as the host under a per-process scope, never through a window.
- Reviewing a run measures its branch against its confirmed delivery base, remote-tracking ref first; mergeability is asked of Git, and an unknown answer is refused. Comparing attempts states facts and ranks nothing. _Here only._
- Merging a run into the Project's checkout is explicit, approval-gated and journaled. The host refuses when branch, base or reviewed head changed, the checkout is unreadable, dirty or on another branch, or Git reports conflicts. The merge uses `--no-ff`, and an incomplete merge is aborted. _Here only._

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Messaging and sibling threads

Agent-to-agent messaging is a host-delivered channel, and seeing sibling threads is its read-only companion. Both are operations of one tool, `octant_threads` (maintainer decision, 2026-11-05): Work and Code turns see the other open threads of their own Project and may message them; today only Code turns message.

- A refusal reveals nothing about whether another thread exists, and sending grants no authority and returns no reply.
- A message wakes an idle recipient only when a person turned on its Wake when a message arrives switch (off by default), or under the coordinator cases in [Coordinator threads](#coordinator-threads): one `agent`-initiated turn under the thread's own posture, one at a time, at most 30 an hour, and none past 10 rounds of agents answering each other (maintainer request, 2026-11-07). Both bounds are defaults a person can change, per coordinator for a coordinator's threads (maintainer request, 2026-11-12); not built yet: today they are fixed at six an hour and three rounds. Built on one host; across a hub it stays designed.
- Message bodies never enter the journal; delivery marks the recipient as having read outside content, and delivery is at least once.
- A tagged Code thread may message a tagged Code thread on another hub member under that member's Message peer-grant item; each host keeps its own end's rules and the receiver keeps the final say (maintainer request, 2026-11-07). _Designed, not built._ Detail: [Hub and spokes: messaging between members](hub-and-spokes.md#messaging-between-members).
- A source turn may make at most three `octant_ask_thread` calls by default, a count a person can change (maintainer request, 2026-11-12); not built yet: today the count is fixed. A target turn started by that tool is never offered the tool. _Here only._
- Every operation names a thread by one reference, `<thread id>@<project id>`; a reference whose Project is not the caller's refuses like an unknown one, `send` included. A `send` with more than four recipients, a malformed reference, or one of another Project is refused whole; it never reaches a subset.
- `list`, `read` and `wait` change nothing outside the caller's record and are offered in Plan; a `list` or `read` marks the caller, and a turn may make 8 reads and 4 waits by default, counts a person can change (maintainer request, 2026-11-12); not built yet: today the counts are fixed. In Work they see only Work threads, and in Code only Code threads.
- A Work thread may message a sibling Work thread (maintainer request, 2026-11-12). Not built yet: today `send`, `acknowledge` and `receipts` are Code to Code only and Work threads neither send nor receive, because only Code turns carry messages; extending messaging to Work needs a rule for how a Work turn carries one.
- New queued messages have an explicit 24-hour deadline; expiry is journaled before body cleanup and a separate receipt, never inferred for older records or counted as delivery.
- The current recipient can explicitly report receipt of its exact delivered message; the host rechecks both Code threads and their same-Project authority. Sender `receipts` read only its own metadata, and the person sees bounded recent receipts in Agents. Acknowledgement means reported receipt, never understanding or action; delivery and turn completion do not auto-acknowledge.
- Plan leaves the messaging operations out of the enum, excluded profiles and cancelled turns refuse every messaging call, and receipt retries are idempotent for the same durable ID. Retrying a send creates a new message. Queued-message expiry has no recorded deadline and remains unimplemented; no receipt infers Expired from age.
- A non-empty profile allowlist names each operation group: `octant_threads` for the reads, `octant_threads.send` for messaging, `octant_threads.board` for the planner's board, so folding the former tools together widens no existing allowlist.

Status: Partly built. Since: 2026-10-12. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Mentions and Side Chat

A `#thread` mention is a bounded, read-only view of a thread the sender can already open. Side Chat is a Chat-mode sidecar about exactly one source thread.

- `@file` completes only a path inside the thread's bound root, and the host refuses an outside path before reading.
- An `@` or `/` picker chip never installs, trusts, enables or elevates anything; the host re-resolves it at send.
- A Side Chat has no inherited Work or Code authority and no agent path that messages, approves, steers or appends to its source.
- A person may return one finished reply to its linked source’s editable unsent draft. Append preserves existing text/caret and busy work; it never sends, queues, steers or approves.
- Typed reply/digest/source references persist with the draft and ordinary send, queue delivery, retry and resume revalidate them and inherit outside-content provenance before provider reads. Missing or corrupt provenance refuses admission; clearing the entire draft is explicit recovery.
- New replies retain a bounded receipt of actual host source-read versions/context digest, independent read range and omissions; older replies honestly say the original snapshot was not recorded.
- In Chat, an explicit mention of a Chat thread also offers `octant_ask_thread`, which sends one instruction to the mentioned Chat thread and waits for its reply, one hop, failing closed. A turn whose mentions name no Chat thread is not offered it.

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Coordinator threads

A person may make a Code thread a coordinator: a long-lived thread that starts worker threads without asking, talks to them, and brings their requests to the person (maintainer request, 2026-11-10). A person can restrict starting to proposals for the whole host or for one Project.

- Only a person makes or stops a coordinator, from a local window; up to four per Code Project. The role, lineage and switches are fields on the thread, journaled as `code.thread-updated@1`; a creation command may not carry them. A coordinator's proposals use the planner's proposal path. The designated planner reads as a coordinator whose starts always need approval, counted toward the four; designation refuses a worker or a fifth coordinator.
- A coordinator's own file, shell and Git actions take Plan's read-only gate whatever its level; it has no delivery target, no board card, no pull request of its own, and is never Done. Each turn carries a host-written roster of its workers with no agent-written text.
- `octant_threads` `start` is offered only to a current coordinator, outside Plan, and to a profile allowlist naming `octant_threads.start`. It creates an ordinary Code thread in the same Project on a new managed worktree, with an `agent`-initiated first turn, so every approval waits for a person. Workers are never coordinators and never offered `start`.
- Settings › Code › Coordinators › Starting workers is Start without asking (default) or Propose for approval, with a per-Project override; only a person changes it, and the host reads it at every call.
- The person may fix the workers' level when creating the coordinator at a local window, Full access included, and a mark on the coordinator does not lower it; without that choice a worker's level is at most the coordinator's (maintainer request, 2026-11-12). Not built yet: today a worker's level is at most the coordinator's, and never Full access from a marked coordinator. A marked coordinator's worker starts marked (label `coordinator-start`); a mark that cannot be journaled refuses the start.
- At most six open workers per coordinator by default (person-set, 1–16) and 60 starts per hour by default, a per-coordinator setting (maintainer request, 2026-11-12); not built yet: today starts are fixed at twelve per hour. Ordinary turn admission, capacity and spend ceilings apply.
- A worker wakes for its own coordinator's messages unless a person turns that off; making a coordinator turns its own wake switch on. The host sends a coordinator closed-set state notices (turn ended, waiting for a person, Done) that do not mark it. The coordinator's wake and round bounds apply: per-coordinator settings with defaults of 30 wakes an hour and 10 rounds (maintainer request, 2026-11-12); not built yet: today they are fixed at six wakes an hour and three rounds.
- A worker's approvals and questions are listed in its coordinator's composer; only the person answers them, never the coordinator agent. Needs you rows name the coordinator, pending proposals show as a card in the coordinator thread, and the board can be filtered by coordinator ([Workspace: Coordinators](workspace.md#coordinators)).
- The wake switches (never the role) may also be set from an owner device through the owner routes and the owner access recovery screen on the phone and in a browser, each change under its own fresh unlock and journaled as that device.
- A coordinator proposal's review starts on the requested provider, model and level and offers no higher level; paired browsers and phones show pending proposals read-only, and approval stays at a local window.
- Not yet run against a real provider or on the desktop app; the live checks are on the maintainer live-smoke list.
- Wake, start and hop counts are kept in a host store (forward-only migration), so the hourly bounds and the hop count hold across a restart; the start count never reads fewer than the workers created in the last hour.
- Work coordinators wait for a rule that lets a Work turn carry a message.
- A coordinator's Agents dock lists its workers and draws each worker's subagents under it. A window that holds a current coordinator may read its workers' child runs as facts (task, state, route, effort, ordering links), never a reply, result, recovery text or control; every other caller is refused before a run is read, and the agent is offered none of it (maintainer request, 2026-11-11).

Status: Partly built. Since: 2026-11-10. Detail: [Coordinator threads](coordinator-threads.md).

## Boards, pull requests and delivery

### Thread boards and Done

Threads form one real hierarchy, and Work and Code have server-derived boards; Chat has none. An agent can never mark any thread Done.

- The boards are the bundled Board plugin. Switching it off hides the Work and Code board views and every way to open them in the renderer; the host-owned status policy and the server board projections and routes stay, because thread rows, the dock overview, the planner board read, sibling-thread tools and side tasks read them. Nothing is deleted. Owner: [Workspace](workspace.md#boards-and-integrations).
- A Code thread is Done when its user-confirmed delivery target is objectively satisfied, or when a person marks it Done whatever its delivery target says, recorded as the person's override (maintainer request, 2026-11-12). Not built yet: today no person's mark overrides ambiguous state.
- A Work thread is Done when a person marks it; the mark needs no confirmation and no evidence text, and Reopen undoes it in one click (maintainer request, 2026-11-12). Not built yet: today the mark is final.
- The Work mark locks the thread on the host until it is reopened (today, until it is archived and reactivated): queued messages hold, child results wait, and a due resume ends as invalidated.

Status: Partly built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Pull requests from a Code thread

A Code thread may push its own branch and open, update and stack pull requests from it. Every forge change goes through one journaled Octant pull-request tool.

- Only the repository the Project binds is touched, and a thread never acts on another thread's branch.
- Plan mode and revoked forge access refuse every action; the tool's `help`, which returns its usage text and reaches no forge, is not an action. Force-with-lease on the thread's own branch is the default, a plain force-push needs the person's approval for that one act, which Full access does not stand in for, and a push to the default branch follows a Project setting (maintainer request, 2026-11-12); not built yet: today a push to the default branch also needs the person's approval for that one act.
- Each action journals the actor, repository, number and head SHA, and Octant stores no forge token.
- Built: push, amend with force-with-lease, plain force-push on approval, open (ready, draft, stacked), edit, labels of existing labels only, comments and review replies, close and reopen, an agent's merge on request or on a stored Project or routine choice, and a watch on its own pull request (see Merge when ready and Auto-fix). Comments and review replies do not ask at Full access; below it a Project switch "Agents may comment on pull requests" stands in for the per-post ask, and watching a pull request needs no approval at any level (maintainer request, 2026-11-12). Not built yet: today each comment, each review reply and each watch is approved one by one at every level.
- The review pane carries the person's own label, comment, review-reply, approve, request-changes, close and reopen controls; the labels and review threads they name are read through a desktop-window-only query, and a label the repository lacks is never offered. A review is recorded on the head the person read and refused when it moved; no agent, routine or paired device reviews.
- Built: every push, merge and pull-request change Octant reads in a shell command is journaled under the thread (`shield-forge-changes.observed@1`) with who ran it and what happened; at Full access an Octant Harness command that merges, force-pushes plainly, forces or deletes a branch other than the thread's own, or pushes to another thread's branch is refused before it runs, and a provider runtime's command, seen only as it starts, is recorded with the hard line it crossed. A target behind an expansion is recorded as unreadable.
- At Guarded and Reviewed, recognizable pushes and pull-request writes are refused before Octant's Harness shell runs them, and before Octant answers a provider's pending approval call, with or without Shield. Generic shell consent does not bind repository, revision or checks; the agent uses the structured tools. Shield's forge hard lines use the same command reader and still ask the person.
- A provider reviewer answers internally and gives Octant no pending call to intercept; Full access tool-start observations arrive after execution starts. Those paths are recorded, never represented as pre-action enforcement. Arbitrary scripts and hidden targets remain unsupported for complete forge enforcement. An unreadable branch-ownership lookup refuses a Full access Harness push rather than dropping its other-thread check.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Pull-request merge

A person merges one open pull request from its review in a local window. A Code thread may merge, enable auto-merge or merge a stack only when the person allowed it.

- Built: the review enables Merge only for a fresh, mergeable observation, opens an inline confirmation naming the reviewed head, and the server re-reads state and refuses a stale head.
- Octant uses the host's forge command-line login and strips ambient tokens; every attempt journals the actor, repository, number, method, approved head SHA and result.
- A paired phone or web client may merge one pull request or a whole stack, but only with `confirmed: true` for the head it reviewed; the server then requires the repository's required checks to pass and refuses when they fail, are pending or cannot be read. A stack merges bottom first, each child retargeted to the branch the stack lands on before it merges, and is refused whole unless it is one chain. A review reply is posted only after the thread is read back and found on the named pull request.
- An agent merges on the person's request only after the person approves that one merge in the thread, at every guardrail level; no routine, plugin or hub or peer host reaches it.
- Merge when ready from a paired phone or web client needs the same confirmation of the reviewed head, and the phone panel offers Merge and Merge when ready after re-reading the pull request from GitHub.
- An agent merges without asking for each act when a Code Project's Agents may merge switch, or a Code routine's Merge the pull requests it opens choice, allows it. Each is its own stored choice, set only from a window on this host; the host reads the choice again at the merge, enforces the reviewed head and the required checks as for any merge, and refuses when the choice has been switched off. A routine's choice reaches only the thread one of its runs created, while the routine is enabled.
- Built: a host switch, Owner unlock before a phone or browser merges, off by default and set only from a window on that host, makes a paired client's merge, stack merge and Merge when ready (turning on) need a fresh unlock on one of the host's owner devices. The owner route issues the challenge for the merge route's own method, path and body hash to an owner on the host's own list; the host checks the proof against that list, refuses a missing or failed proof with a plain reason before anything merges, and journals the owner. The phone signs with its biometric-gated key and the browser with its passkey for the page's own host.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Merge when ready and Auto-fix

A Code thread's pull request review carries two switches the person turns on: Merge when ready, which turns on the forge's own auto-merge, and Auto-fix, which wakes one linked Code thread to fix failed required checks, unresolved review threads and base conflicts. Beside them, a thread's agent may ask to watch its own pull request, so it is woken instead of polling (maintainer decision, 2026-11-05).

- Only a local window turns Auto-fix on. A paired phone or web client may turn Merge when ready on with `confirmed: true` for the head it reviewed, and off without it; the forge still waits for the required checks and reviews. No provider, agent tool, plugin or routine reaches these routes.
- A watch goes through the pull-request tool (`watch`, `unwatch`). The host resolves the thread's own open linked pull request; a watch needs no approval at any level (maintainer request, 2026-11-12), not built yet: today the person approves each watch at every level; Plan and a turn the host started on its own (`automation-recursion`) refuse it; stopping it never asks. Its enabled and disabled are journaled as the thread's agent. The Code runtime reaches it only through a watch port the composition root binds to the switch service, because GitHub is a separable integration.
- A watch shares Auto-fix's pass, pauses, outside-content mark (label `pull-request-watch`) and wake path, but fixes nothing: it wakes the thread when checks on the head settle (passed or failed), the review decision changes, a new review or comment arrives, or a conflict appears, coalescing one pass into one turn, and never for what its journaled baseline already held.
- A watch ends when the pull request merges or closes, the thread is gone, the Project loses the repository, the agent unwatches, after ten started wakes, or after three days. Its vouching window is not journaled, so after a restart it stays quiet until a window shows the pull request or the agent asks again.
- Merge when ready uses the forge's auto-merge matched to the head the person saw, never a loop of Octant's own, and answers unsupported when the repository does not allow auto-merge.
- Auto-fix wakes the thread with one turn through the routine follow-up path, under the thread's own level and approvals; it marks the thread as having read outside content first, and sends no turn if that mark is refused.
- Auto-fix states Octant's rules to the agent first: never force-push, never rewrite pushed history, merge the base branch instead of rebasing.
- At most three attempts per failure; Auto-fix stops when the pull request merges or closes, the thread is archived or gone, the Project loses the repository, or the person turns it off.
- Every switch change, every watch change and every wake is journaled.

Status: Partly built. Since: 2026-10-31. Detail: [Architecture: Modes, Merge when ready and Auto-fix](../architecture.md#modes-chat-work-and-code).

### Delivery to targets the person owns

Octant operates no deployment infrastructure and offers no ship target of its own. Every target is an account, cluster, registry or store the person owns.

- A ship integration never receives a secret; it names a credential reference and the host hands it a bounded, purpose-scoped handle at use. _Here only._
- Delivery is dormant: the ship service exists, but the host wires no target source, build observer or per-act approval bound to target, revision and build.
- Delivery stays absent from the interface until all three exist; a standing grant never replaces the per-act approval.

Status: Designed, not built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Project planner thread

A Code Project may designate one of its own threads as its planner, whose agent proposes new Code threads for a person to accept in the Project overview. [Coordinator threads](#coordinator-threads) are meant to replace this role; that carry-over is not built, so this entry is still the built behavior, and a coordinator's proposals use the same proposal path.

- Only a person confirms or declines a proposal; a proposal executes nothing and the planner has no creation authority of its own.
- The planner reads its board through `octant_threads` (`board`) and proposes through `octant_offer_side_task` (target `board`); both are offered only to the designated thread and re-resolve the designation on every call. The side-task schema states the proposal's bounds, and the planner service keeps its cap of ten waiting proposals.
- The Code Project overview designates a same-Project thread and lists versioned proposals with approve/decline and resulting tasks. Phone and CLI mutation surfaces are not added.
- Approval reviews ordinary provider, checkout and access controls with the proposal intent fixed; only confirmed creation proceeds to the normal first-message path. Stale, refused or uncertain decisions never start work or retry automatically.
- The host journals one submitted creation identity before awaiting creation; cross-window and restarted attempts cannot replace it. The window retains that identity through reload. Missing task data never releases uncertainty; only confirmed creation or a newer host-proven precreation failure permits progress. Unknown/post-boundary failures remain reserved for inspection.

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

## Routines and timed turns

### Routines

A routine is a host-owned, Project-bound definition that starts an ordinary Work or Code thread on a trigger. It can do nothing the thread it creates could not do.

- The dispatcher revalidates host, Project, binding, profile, provider, model and authority at every occurrence, and a stale definition never adopts replacement authority.
- A routine runs as the host, so it works with no window open; automation-origin execution cannot create, edit, run, pause or archive a routine.
- An agent can only propose a routine; a person confirms, and the host builds the definition from the thread's live facts with an approval-gated profile. When the person's own message asked for the routine, the agent sets `requestedByPerson` and the host creates it at once, paused, through the same draft and create path with no card; a self-suggested routine, a follow-up, and a turn in Plan still wait for the card. Either way the call's tool step keeps a receipt that every client draws as a **Created automation** card in the thread, and the thread's Environment lists the routine. A paired phone reads this thread's routines through the remote Automation list (a Project overview read, forwarded for the device's own host) and shows them read-only as a Scheduled list on the thread screen; resuming or editing one stays with a window.
- A turn in Plan may propose, as it may offer a side task, and a thread in Plan does not refuse the confirm; a turn the host runs (a routine's run, a usage-limit resume) is still refused. The routine takes none of the thread's posture: it asks first, never runs in Plan, and the card's confirm is unchanged.
- Built: a Work or Code thread's agent may list and read its Project's routines of the same mode with their recent runs, and ask the person to pause or archive a routine that is its thread's own (proposed or created from the thread, or whose run started it). The request waits as a card like a proposal and only the person's confirmation, as their own principal at the version the agent saw, changes it. Plan and every host-run turn, the routine's own run included, are refused: nobody is there to confirm. Resume, edit, run now and cancel stay the person's.
- Built: the turn the dispatcher started for a run, named by the run identity the dispatcher passes in host-only start options, may report the run's result once (succeeded, nothing-to-do, needs-attention or failed, with a summary of at most 1 KB). It is journaled on the run, shown in Automation Center beside the run's status, and never changes the run's lifecycle or reaches a push notification.
- The scheduler is an in-process timer; nothing runs in a cloud, and a self-hosted wake service on a person's hub can wake a spoke for a routine (built; run only between hosts on loopback with a fake socket).
- A Work run observes the exact retained first-turn request and captured receipt/thread/Project/host/binding/provider/model. Proven terminal status is journaled before the active slot is reused; missing/mismatched evidence stays active, edits do not replace the run snapshot, and replay or notification failure never redelivers the provider call. First-turn completion does not prove child/process quiescence.
- A Chat routine keeps Chat's authority: it binds an active Chat Project, grants no folder, shell, Git or subagents, has no level and no follow-up target, and each run sends one turn into a new Chat thread. No agent proposes one.

- A new file trigger is Work or Code/new-thread only, under the main local Project root, using the existing Secret guard and confined reads. The existing journal owns its baseline, deterministic batch and finite automatic-start budget (default 8, selectable 1–32); no restart or quiet reset. Hidden/linked/protected input is excluded, unsupported or incomplete scans block, and filesystem hints never identify writers.
- File changes during the known routine/child/process activity window are held for explicit current-authority Review/Re-arm, with the held batch preserved. Offline recovery sees net surviving final-state changes only. The run-first source/claim ledger repairs without a second run or budget debit.
- A transient unavailable/oversized source preserves an existing required review in the same durable cursor. After recovery or restart, neither missed-run policy may silently re-arm or dispatch input that still requires the person's decision.
- Native canonical root/directory identities remain bound through the final synchronous journal and provider-send fences, including awaits for provider session startup. Missing native-current evidence refuses new file admission; a timed-out run-input proof is invalidated and never automatically resubmitted.
- The local-window file editor discloses the finite allowance, ignored baseline, busy-input review and offline limits before enable. Status separates saved/arming/watching/held/unavailable. Review binds the displayed definition/source/observation/batch; a lost response requires explicit refresh, without an automatic resend. Input paths use bounded framed external data in the ordinary Work context plan; the person's task stays fixed and file contents are read only under normal task authority.
- Work file-input recovery requires the original exact turn/authority and host-journaled framed-input reference/digest before any fresh source read or mark. Missing legacy or mismatched evidence stays unconfirmed without automatic resend; the receipt records acceptance, not provider delivery/completion.
- The retained activity window is bounded at 64 owned runs. Overflow remains unknown across replay; finish and review Project tasks/cleanup, archive the old routine and explicitly configure a new one. Quiet, Resume and Save do not discard that ownership.
- A Code run copies its exact observed batch into its own managed checkout under `octant-routine-inputs/<run-id>`, without replacing existing different content. A stale source refuses admission, a matching partial copy can recover, and an already recorded turn never rereads the source. Copied inputs are ordinary checkout files to review before commit or push.
- Built: local-window integration-event setup selects a read-only contributed source, filters, task and authority. The existing scheduler polls at 1–60 minutes with at most two observations in flight. GitHub binds the selected account/repository and distinguishes run attempts within its latest-100 completed-run window; Linear binds the viewer/workspace and detects observed absent-to-present assignments from a complete bounded set. No hosted scheduler or webhook is added.
- Integration source cursors and run-first occurrence claims are journaled. A failed observation preserves the last complete coverage time; bounded pre-filter CI window identities retain overlap evidence independently of matching events, and a lost full window requires explicit review. Quiet baselines, visible offline gaps, skip/newest-once catch-up, finite 1–32-start allowances, busy/output holds and explicit local Review/Re-arm bound duplicates and feedback. Re-arm skips held events and establishes a fresh baseline; a lost response stays unconfirmed. Event payloads are framed external data, never permission grants.
- A stopped run has a per-run Retry that creates a new manual run with its retained input and original-run link, without resetting the automatic allowance. An edited definition, active run or same-thread follow-up cannot be retried this way. The manual CI-failure card shows branch-correlated routine work and its source CI link before another fix is drafted; its marker remains read-only.
- **Remaining:** native/filesystem/provider acceptance evidence. Controlled fixtures prove source/journal/normal-dispatch and protected review composition; they do not establish native watcher behavior or a live provider workflow.

Status: Partly built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Routine authority level

A routine runs at the guardrail level the person picks when creating it, Full access included, and never at a lower level than its creator chose.

- A Code routine may merge the pull requests it opens when the person allowed that at creation; an agent proposing a routine never picks either for the person.
- Built: a person at a local window may pick a level on the routine itself (Ask first, Accept edits, Auto or Full access). It is the highest a run may use: a run takes the lower of the pick and its Project's level, so a pick lowers a run and never raises it above what the person allowed. A paired device and a routine an agent proposed cannot set it, and a Chat routine has none.
- Built: a person at a local window may opt a routine into its Project's level, journaled on the definition and copied into each run; each run then takes the level the Project's new threads start at, Full access included. Without it a routine asks first, and a Full access profile stays ineligible.
- A Work routine captures the shell and Git like a Code routine; the catalog offers them with an ordinary approval-gated Work profile. One saved without them does not run until a person saves it again.
- The editor saves Ask first explicitly for Work and Code. Existing definitions with no picked level retain their dispatch behavior until saved; Chat has no level.
- Built: a person at a local window may let a Code routine merge the pull requests it opens (the routine's Merge the pull requests it opens choice); it reaches only the thread one of its runs created, while the routine is enabled, and a routine an agent proposed cannot set it.

Status: Built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Follow-ups in the same thread

A follow-up is a one-shot routine that sends one scheduled turn into the thread it came from.

- The host re-checks the thread at fire time and refuses with a typed reason rather than adapting; a follow-up due while the thread is busy runs after the running turn (maintainer request, 2026-11-12). Not built yet: today a busy thread is skipped, not waited on.
- A follow-up missed while the host was asleep runs once on return if at most 24 hours late, and otherwise fails without sending.
- Its turn runs as the host under the same ceilings as any routine run, and a person widening the thread never widens the follow-up.
- Chat threads cannot have a follow-up.

Status: Partly built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

### Usage limits and stalled turns

A turn stopped by an explicit provider usage-limit signal carries a provider-neutral fact, and resuming at the reset is the person's per-thread opt-in.

- Only a protocol signal produces the fact, never message-text matching; an unknown reset stays unknown, and a billing stop gets no reset line or resume.
- The reset timer is an in-process host timer that continues through the ordinary turn-admission path, with no cloud wake and no billing automation.
- A stale recovery settles as invalidated rather than firing against newer state.
- Chat, Work and Code each cut a turn off after the stalled-turn limit passes without a provider event: a setting in Settings › Providers & Models, 30 minutes by default, that may be turned off. A provider tool call the runtime reports as running pauses the clock as an app-managed call does, because a long tool call can leave a provider silent (maintainer request, 2026-11-12). Not built yet: today the limit is a fixed five minutes and only an app-managed call pauses it. _Here only._
- A provider whose sessions each own a process offers Force stop in Chat, Work and Code ten seconds after a Stop that did not end the turn. It kills that attempt's process and nothing else, leaves the thread usable and resumable, and is refused for a provider that shares one process across threads (built for Claude). Work requires the exact stopped request/thread/turn; Code requires the original stopped turn operation. Neither accepts a PID or kills a replacement attempt. Code's ordinary Stop names its turn when the client knows it, and a Stop naming a turn no longer current is refused, leaving the newer turn running. A Chat Stop reads Cancelled only once the runtime confirms; on a shared-process provider an unconfirmed Stop is recorded as interrupted with "Stop was not confirmed" after ten seconds, and a forced kill that does not take reports an error.
- Stop is bounded under load. A Code Stop waits at most ten seconds for the runtime to confirm, then says "Stop was not confirmed"; the turn keeps its thread until the runtime itself reports how it ended, and that report is its only terminal outcome. Chat, Work and Code turns yield the event loop after 10 ms of provider events, and a streamed burst is bounded in size, so a flooding provider cannot queue Stop behind its own deltas.

Status: Partly built. Since: —. Detail: [Architecture: Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code).

## Transcript records

### Agent task display and tool-call records

The agent's plan panel and tool-call groups are projections of journaled state, never renderer-owned plans.

- Providers that report their own task plans emit task events; each restatement names the ids the plan now holds (at most 64), so a dropped step leaves the panel.
- An Octant Harness lead's `todo-write` list reaches the same panel: the loop reports each list the runner accepted as the same task events. Settings reports task progress supported for a Harness endpoint once one of its models passes Verify tools; the driver's own probe keeps `taskProgress` unsupported, because conformance requires a claimed capability's events in every scripted turn.
- Chat and Work record each tool call as id, name, state and a redacted message of at most 2,048 bytes, with at most 512 steps per turn by default, a limit a person can change (maintainer request, 2026-11-12); not built yet: today the limit is a fixed 64.
- Chat and Work tool calls keep bounded input and output in purgeable storage, behind a setting that is on by default (maintainer request, 2026-11-12). Not built yet: today no tool input and no tool output is captured, except a page a call published outside the host. Purging the thread removes the records.
- Workspace navigation, panes, tabs and dock tools are owned by the workspace specification, with visual treatment in the design system.

Status: Partly built. Since: —. Detail: [Architecture: Tool calls in Chat and Work](../architecture.md#tool-calls-in-chat-and-work) and [Architecture: Agent task display](../architecture.md#agent-task-display).

## Persistence

### Event journal and projections

The event journal is the authoritative record, and projections are rebuildable and idempotent. One local database file under the data directory is created with owner-only permissions.

- A command targets one aggregate and carries the expected aggregate version; a stale version returns a typed concurrency conflict and writes nothing. _Here only._
- Every event carries a versioned envelope. A projection checkpoint may trail the journal head but never lead it. _Here only._
- The store runs in WAL mode with full sync, and streamed deltas of a Chat reply and of a Code turn batch into one commit per short burst, so a power loss loses at most the open burst. Projecting a streamed Chat delta writes one row of its own, not the whole attempt and turn, so its cost does not grow with the reply; reads and the next whole attempt fold those rows in.
- Purgeable bulk content such as terminal transcripts and test output lives outside the journal and is referenced from it. _Here only._
- A projection whose state is only in memory replays from the start of the journal at every host start.
- A turn's streamed text and reasoning are bounded at 32 MiB: past it the turn keeps what was journaled, ends with a truncation marker, and stops. A write that fails on a full disk commits nothing and tells the person the disk is full.

Status: Built. Since: —. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Quarantine and migrations

Unreadable events and unsafe migrations fail closed. Octant never skips an undecodable event and reports current.

- A malformed, contract-invalid, unsupported-version or unapplicable event is quarantined: its projection keeps its last valid state and readiness becomes recovery-required with a typed reason that discloses no payload. _Here only._
- A projection is authoritative unless it declares itself a derived view that no command or authority check reads (today only diagnostics exports). An authoritative projection that fails rolls back the whole append; a derived view that fails is quarantined and held alone, its lag reported, while the append commits and readiness stays current. `db:rebuild` repairs it and reports one that still fails.
- Only a successful projection rebuild retires quarantine: an explicit one, or the one bounded rebuild a start runs over a journal that decodes and passes its integrity check ([startup repair](../architecture.md#persistence)); startup never clears it otherwise. Ambiguous recovery state resolves to waiting or recovery-required, never done or healthy.
- Migrations are ordered, forward-only and checksum-verified, applied in transactions before the server reports ready, with a store backup first.
- A changed checksum or an unknown newer migration fails closed.

Status: Built. Since: —. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Recovery after a restart

A restart recovers what the journal can prove and never guesses that an ambiguous outcome succeeded.

- Orphaned running Code turns become Waiting and orphaned Work turns settle as Interrupted; settled turns stay settled and repeated startup appends no duplicate recovery events. Other running Code work that reaches a remote (a push or pull request step) becomes ambiguous and keeps its thread Waiting; local Code work becomes interrupted. The next look at the checkout settles an unconfirmed push from the remote branch, and the next look at the pull request settles an unconfirmed creation, comment or review reply; an unreadable remote never settles it by guess. An unconfirmed update or merge stays unconfirmed. A turn a restart cut off continues by itself, once, as the host, on by default with a per-mode Continue after restart setting and a per-thread switch; a turn whose last effect is uncertain still waits for the person (maintainer request, 2026-11-12). Built for Code ([Continuing a turn a restart cut off](#continuing-a-turn-a-restart-cut-off)).
- The host does not wait for those looks: after restart reconciliation it settles every active thread's unconfirmed push and pull request steps once, in the background, as the host, with the same reads and through the thread's own checkout, remote, and recorded pull request. Start-up never waits on it; it reads a few threads at a time, bounds each step's reads, skips archived threads and checkouts recorded as gone, and leaves a step unconfirmed on any unreachable remote, timeout, or failure. A person's look or retry on that thread waits for its pass.
- A push whose failure Git did not attribute to the remote's refusal (a dropped connection, an unconfirmed remote update, a timeout) is ambiguous, not failed. A comment retried while an earlier attempt at the same text is unconfirmed is looked for among the person's own comments on the pull request that attempt recorded, and refused when that cannot be read. An attempt counts as landed only when more of the person's comments carry its text than did just before it was sent, so an older identical comment never stands in for it; a comment record without its pull request and prior count stays unconfirmed. Concurrent submissions of one push or pull request step with the same operation id run once. A pull request creation's `idempotencyKey` is optional and ignored; the operation id is what dedupes.
- Outstanding approvals are recovered, but a parked provider question settles the attempt interrupted because the session that would consume the answer died.
- Clients catch up from the authoritative snapshot, keep retrying while the host is unreachable, and renew a remote session from the device key rather than re-pairing.
- A Machine change cursor names the host process (epoch) it came from; a cursor from an earlier process is answered with a snapshot, never resumed, and the renderer's retries are jittered.
- Removing a host on the phone sends nothing to the host, so it does not revoke the device.

Status: Partly built. Since: —. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Recovering after a crash without the terminal

After a crash or reboot the host repairs what it safely can and says what is wrong, and nothing needs the `db:*` commands.

- Damage confined to projections over a journal that decodes and passes SQLite's integrity check rebuilds from the journal at startup, at most once per start; journal damage still refuses the start and leaves the journal unchanged.
- A refused start opens a desktop recovery screen, not an error dialog and quit. It explains the refusal in plain words and offers only what that refusal allows: rebuild from the journal and restore the last verified backup for a damaged store (the restore only after a separate confirmation), otherwise start again or quit. Both repairs run the server's own offline store maintenance. An unfinished local data removal offers neither.
- Error copy names only commands that exist.
- Settings offers "Keep Octant running in the background" (the per-user LaunchAgent or systemd unit `octant` manages, pointed at the app's own windowless host) and, on macOS, "Open Octant at login". Both are off by default, each shows what the operating system reports, and only Octant's own desktop windows can change them, never a paired device or a Nightly client. A real install and uninstall on a Mac is a maintainer check.
- Not built yet: exporting a support bundle from the recovery screen; a local crash record (crash dumps kept on the device with upload off, in a support bundle only by choice, named in the next start's notice); one-click restart of terminals, dev servers and extensions a restart ended.

Status: Partly built. Since: 2026-11-12. Detail: [Architecture: Process topology](../architecture.md#process-topology) and [Persistence](../architecture.md#persistence).

### Continuing a turn a restart cut off

After a crash, a force quit or a reboot, the host continues each turn the restart cut off, once, as the host, so nobody has to type "continue" into each thread. Maintainers decided on 2026-11-12 that this is on by default, with a setting and a per-thread opt-out, and that a thread whose external action may have been in flight waits for its person.

- Only a turn the previous host was still running qualifies: a turn its person stopped, a turn that failed and a turn already waiting before the restart do not. A clean shutdown, as a reboot performs, leaves its turns as a crash would.
- The continuation is the same message a person's Resume sends: inspect first, do not repeat what may already have taken effect, ask again for approvals and answers.
- Each mode has its own switch: Settings › Chat, Settings › Work and Settings › Code › Continue after restart, each on by default, because each mode already keeps its own settings record. Every thread's menu carries its own switch. Both are changed only at a window on this computer.
- The thread waits for its person instead when Continue after restart is off in Settings or for the thread, when it holds a push or pull request step whose outcome the restart left unknown (Code: Chat and Work journal no such step), when its own automatic continuation was cut off by a restart twice, or when its provider cannot resume the session the turn ran in. A turn that never reached its provider waits too, so the person's message is sent again rather than lost.
- Each recovery identity is continued at most once, and the crash-loop count survives the restart it counts.
- Dispatch needs no window: it runs under the host's own scope and rechecks authority, posture and the spend ceiling through ordinary turn admission at that moment. Messages queued behind the cut-off turn follow the continuation; a queue its person paused stays paused.
- Each start reports the threads it continued and the ones that wait, with links, in a notice: "Octant restarted. Continued N threads; M need you."
- Built for Code, Chat and Work. A Chat answer the start interrupts and a Work turn the start settles as cut off are continued through each mode's ordinary send, so a person's own "continue" and the host's take the same path. A Chat answer already waiting on a question or approval at the restart is still settled interrupted when it is answered; asking it again is not built. Subagent runs, coordinator wakes, goal loops and settling lost remote steps at start are not built yet. A packaged-app `kill -9` smoke is a maintainer live check still owed.

Status: Partly built. Since: 2026-11-12. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Snapshot-first thread reads

A thread paints from an authoritative snapshot before auxiliary observations begin, and reads stay off the full journal.

- Files, Git, Browser, Computer Use and other auxiliary observations wait for the primary transcript or an explicit open. _Here only._
- The host reports separate latency classes (navigation, thread snapshots, conversation evidence, environment observation) and returns Server-Timing on measured API responses without identifiers. _Here only._
- Threads open on their newest turns through a windowed read; the journal and projection stay complete, and totals read the whole thread.
- A running turn's latest step is held in memory only, redacted at the adapter and again on observation, and is never journaled.

Status: Built. Since: —. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Outside-content taint

Browser observations, tool results and imported content append a journaled mark with bounded source labels and never raw bodies. The mark lasts the thread's lifetime.

- Irreversible or authority-bearing actions on a marked thread need fresh confirmation, even after replay; the closed tool catalogue flags each such entry.
- At Full access in Work and Code the mark is recorded only and never prompts or blocks; a person turns it down for one thread, or a Project's new threads, by setting that scope's level.
- A provider runtime's own web tools mark the thread when the adapter first reports the call, and a mark that cannot be recorded stops the turn.
- A key provider's own web tools are offered when the person allows them and still mark the thread (built for Claude Code, whose web reads ask below Full access; the other key providers' web tools were never switched off).

Status: Partly built. Since: —. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Clearing a taint mark

Only a person at a local window may clear a thread's mark, recording that they reviewed what the thread read.

- The clear route is loopback-only; no tool, command, model output, agent message or host-run turn (routine, goal loop, resume, child delivery) can clear.
- A clear removes the mark only: nothing leaves the model's context, and the next ingestion marks the thread again.
- A clear is refused while a turn is running or queued, and a stale version is refused.
- An approval on a marked thread says that the mark is why it asks and what marked the thread.

Status: Built. Since: —. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Data lifecycle, exports and diagnostics

Reset, remove, delete-host, retention and purge are explicit, reported per scope, and never run implicitly. A retention window never deletes by itself.

- Only a confirmed purge erases a thread's bulk content, Canvases, sessions and worktree; usage records are de-linked, not erased, and a tombstone stops a rebuild from resurrecting the transcript.
- A remote principal can neither set a retention window nor purge.
- Startup journal compaction and the completed-thread archive sweep are the only self-applying exceptions. The sweep works in batches that yield to the event loop between them.
- A thread bundle or host export is a local-owner read that never contains secrets, filesystem paths or raw provider payloads, and names what it leaves out.
- A diagnostics export carries counts and kind names only, with no payload, identifier or thread or Project name.

Status: Built. Since: —. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Artifact mirror and replicas

The mirror writes plain files for people and tools and never pushes to Git. Replicas are append-only, signed, write-once logs in a store the user owns.

- The first mirror command a person issues journals the effective fallback (the default folder's Artifacts subfolder), so setting one override never quietly turns mirrored files off. _Here only._
- Optional auto-commit is off by default, commits only the files it just wrote, refuses when other work is staged, and the mirror route refuses a paired device.
- Each host writes only its own entries; an import adds versions with provenance and never adopts another journal or overwrites a version.
- Divergent heads are shown and a person picks or merges; nothing is silently chosen. Entries are readable, not encrypted, and credentials and absolute paths never leave.
- With sync off, no store chosen, or Plan mode, no store call is made.

Status: Built. Since: —. Detail: [Architecture: Persistence](../architecture.md#persistence) and [Artifact replica sync](artifact-replica-sync.md).

### Composer drafts and the message queue

Unsent drafts stay on the client that typed them. Messages submitted while a turn runs go into a host-owned ordered queue shared by Chat, Work and Code.

- Drafts are not journaled, not in diagnostics and not sent to a provider until the user sends; deleting or purging the thread removes them.
- Queue metadata and ordering are journaled; prompt bodies and attachments stay in purgeable private storage, and thread purge removes them.
- Every dispatch rechecks the current Project, provider, model, checkout, access and context policy through ordinary turn admission.
- Changed authority, uncertain delivery, the person's own cancel and a Work Done mark hold the queue until an authenticated user resumes it. After an ordinary provider failure or a clean restart the queue continues by itself once, with no review of the queued messages first, and a second failure in a row holds it (maintainer request, 2026-11-12). Not built yet: today any cancellation, failure or restart also holds the queue. The one exception built today is a Chat, Work or Code thread the host continues after a restart cut its turn off: its restart hold lifts under the host's scope, so its messages follow the continuation and still hold if that continuation fails or is cancelled ([Continuing a turn a restart cut off](#continuing-a-turn-a-restart-cut-off)).
- A paired device may queue a message (maintainer request, 2026-11-12). Not built yet: today paired remote queue commands stay unavailable until dispatch can revalidate the originating device's grants.

Status: Partly built. Since: —. Detail: [Architecture: Persistence](../architecture.md#persistence).

### Local diagnostics export

A person can export a local diagnostics bundle to share by their own choice; Octant sends nothing by itself and keeps no telemetry.

- The bundle is written locally and leaves the machine only when the person sends it.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Persistence](../architecture.md#persistence).

## Providers

### Provider layer and honest capability

Every provider reaches Octant through the provider SDK, and every driver reports what it can do per mode and model. The server disables what is unsupported instead of emulating it.

- A driver exposes probe, acquire and a connection, and passes the shared conformance harness before it is selectable.
- Provider-specific wire payloads stop at the adapter; the rest of the system sees only normalized runtime events.
- Every capability starts unavailable until negotiation or evidence proves it, and a broken installation is never shown as a permanent lack of a feature. _Here only._
- Provider permission callbacks are signals, not a sandbox. An adapter may narrow Octant's session authority but never widen it, and a driver that cannot represent the authority reports degradation or blocks. _Here only._
- A managed-process driver runs one supervised process group per active session from an absolute executable path with a minimal sanitized environment, and reports incompatible when it cannot separate authentication storage. A driver family without resume, identity or attestation guarantees stays unselectable. _Here only._
- Each subscriber to a provider connection gets its own subscription and sees every event; callers subscribe before they send, and a driver that returns a lazily subscribing stream fails conformance. _Here only._
- A composer reads the same probe before offering an app-managed tool, and a runtime that does not carry Octant's tools is offered neither Browser nor Computer.
- Bounded provider subprocesses run under a deny-default OS sandbox, and a missing sandbox backend fails closed as incompatible.

Status: Built. Since: —. Detail: [Architecture: Providers](../architecture.md#providers).

### Provider-hosted Code jobs

A local Code thread can associate a separate immutable text-only remote job
with an independently opted-in endpoint. Exact input and cost/execution consent
are required for each submission; local checkout/tools and thread authority
remain unchanged. The first public SDK and outside-driver protocol is the same
closed OpenAI Agents codec. Unknown submissions are not automatically retried,
known remote identities recover by read, cancellation is only requested, and
every actual create records unknown usage. Required spend ceilings refuse.

Local synthetic and rendered checks do not prove account eligibility, provider
sandbox enforcement or billing. Other wire protocols and automatic file/patch
transfer are not implemented.

Status: Partly built. Since: 2026-11-04. Detail:
[Architecture: Provider cloud jobs](../architecture.md#provider-cloud-jobs)
and [Provider runtimes: Provider cloud sessions](provider-runtimes.md#provider-cloud-sessions).

### Provider instances and accounts

Providers are multi-instance, and a thread stays on the instance it started with. There is no automatic failover, rotation or load-balancing between accounts.

- A selected model is a host, provider instance and model id, and the model picker is provider-first.
- Extra accounts use Octant-assigned state directories. Removing an account leaves its directory in place, and deleting it is the person's step.
- Two instances of the same driver cannot share one effective state directory.
- Plan-usage readings come only from the provider's own process, are kept per account, and a failed refresh keeps the last snapshot with its age.
- Octant never calls a vendor usage endpoint itself for the first-class providers and never reads their token or credential files.

Status: Built. Since: —. Detail: [Architecture: Providers](../architecture.md#providers).

### Provider credentials and sign-in

API keys live in the host credential store and are reached only through the loopback credential broker by opaque reference. Octant never reads, stores or injects a CLI provider's own credentials.

- Secrets never reach the renderer, journal, logs or diagnostics. A key pool cools a key that a provider refused for quota, credit or rate limit; cooldowns are host memory only.
- A host with no usable secret store reports it unavailable and stores nothing: no encrypted-file, plaintext-file or in-memory fallback at any flag. _Here only._
- Provider sign-in is delegated (tokens stay with the provider runtime) or host-driven (tokens stay in the broker as opaque references). An API-key path stays available beside every sign-in.
- Changing an endpoint's base URL, or switching its key and sign-in binding, deletes the stored credential before the change is journaled.
- Directory sign-in and cloud request signing run through the broker. The server never holds a signing key, and the broker signs only inside the scope stored at sign-in.
- A person may link a secret store they already use, and the broker resolves it at use by opaque reference; Octant keeps only the store name and item address.
- The AWS command line's key pair may point at two items in a linked store; Octant's own shell then gets only a short-lived session the broker makes from it.
- The Google Cloud command line may point at one service-account JSON item with an exact expected email and explicit scopes. The fixed-endpoint broker exchange keeps the signing key out of the server; local-window consent is journaled before dispatch and a lost reply remains unconfirmed. Account IAM roles may span cloud Projects. Each command owns its token/configuration files, and receipt recovery must be confirmed before stale-resource cleanup; failure leaves those files untouched and disables only this channel.

Status: Built. Since: 2026-10-26. Detail: [Architecture: Providers](../architecture.md#providers) and [Enterprise provider identity](enterprise-provider-identity.md).

### Provider catalog, discovery and outside drivers

The provider catalog lists only bundled driver manifests under a closed schema, and discovery registers runtimes without installing or changing anything. Outside drivers are admitted only through their own quarantined lifecycle.

- A catalog entry makes no install, trust, enable, credential or capability claim. Opening the catalog starts nothing; scan, connect, enable and connection check run only from their button.
- Discovery keeps one provider per driver family and never installs, updates or toggles an existing instance. An update runs only on the person's click.
- First-run enablement of the two key CLI providers is decided once per scan from durable host state: only while first-run onboarding is pending and no instance was ever recorded. Later auto-registers stay disabled. _Here only._
- Discovery may recover a single-token executable alias only by reading named shell startup files, byte-bounded, through the discovery filesystem port. The files are never sourced or executed. _Here only._
- Outside drivers are installed held from a local folder, trusted at a digest, and run in a confined process on macOS only. A publisher key is pinned at first trust.
- A bundled driver can be withheld: the driver is not admitted, no instance or process is created, and stored instances and threads are kept (maintainer decision, 2026-10-29). None is withheld; fx is offered again (maintainer decision, 2026-10-31).

Status: Built. Since: 2026-10-26. Detail: [Architecture: Providers](../architecture.md#providers) and [Outside provider drivers](outside-provider-drivers.md).

### Project provider policy and data tags

A Project allows all providers, an explicit list of instances, or an EU or zero-retention tag policy. The host checks it before every Work and Code turn and handoff, including child runs.

- Either the `eu` or `zdr` tag satisfies the tag policy, and the policy does not by itself guarantee zero retention.
- Provider and model data tags are person-maintained labels, not verified residency or retention. _Here only._
- Renderer filtering of providers is advisory and cannot grant what the host refused, and an unavailable provider cannot start a turn even when listed or tagged. _Here only._

Status: Built. Since: —. Detail: [Architecture: Providers](../architecture.md#providers).

### Image generation and voice

Image generation is a journaled job with exactly one profile, and voice is an app-managed capability that rides one enabled compatible-endpoint instance. Neither grants Chat filesystem authority.

- A safety refusal ends a job and is never retried elsewhere. The journal holds attachment references and a prompt hash, never image bytes or prompt text.
- Image profiles are never selectable as Chat, Work or Code turn drivers, and image drivers reach the host only through capability-scoped SDK ports.
- A provider credential goes only over HTTPS to hosts the driver declares, or to the origin of a base URL the person configured.
- A custom image source is a provider, model and label from a bounded list. A request is accepted only for an exact listed pair, and a removed or disabled instance fails with a reason, never falling back. _Here only._
- An image driver that cannot honour a requested image count or reference images fails closed as invalid configuration. A per-image safety failure turns the whole result into a refusal with no partial success. _Here only._
- An agent generates an image in Chat, Work and Code only through a card in its thread: the person picks the profile and model, lets the agent draw it as SVG instead, or cancels, and may tell the thread not to ask again; that choice is journaled per Project and survives a restart, and a routine in that Project may use it. At Full access the card is skipped when the Project holds that choice or exactly one image profile is ready (maintainer request, 2026-11-12). Not built yet: today every call asks at every level, the choice lives in host memory until a restart and the tool is never offered in a routine's turn. The tool is offered only while an image profile is ready, never in Plan or a Side Chat, and every provider is told to call it for a picture instead of drawing one (maintainer decision, 2026-11-07). A call waits up to two minutes for the image and hands the finished image to a model that reads images; the thread shows each image after the turn that made it. In Work and Code the agent can save a finished image as a new file under the folder its turn works in, at the turn's level, confined and never overwriting.
- Voice persists nothing. A paired device reaches transcription but never synthesis.

Status: Partly built. Since: —; agent images in every mode 2026-11-07. Detail: [Architecture: Providers](../architecture.md#providers).

## Context and usage

### Context planning and model windows

Every request passes through one Octant-owned context planner before it reaches a model, and a model's window is found without asking the person.

- Each subsystem registers attributed entries in the turn's context manifest, and an adapter never appends unaccounted context. _Here only._
- A turn is not sent when planned input exceeds the safe input budget (window minus response budget, reasoning reserve, framing estimate, observed-variance reserve and safety margin). _Here only._
- Reduction runs in a fixed order: duplicates, stale optional context, lazy tool schemas, large results as summaries, durable summaries, older resolved ranges, narrowed memory, then a question. Safety, authority, approvals, the current request and pinned content are never removed silently; if they cannot fit, the turn is blocked with remedies. _Here only._
- An absent service limit is unavailable, never unlimited; conflicting trustworthy limits resolve to the most conservative value. A pin or exclusion applies to the next turn only and never bypasses the budget. _Here only._
- A window comes from the person's override, provider metadata, a learned refusal, then a shipped profile catalogue, which is never fetched at runtime. A fallback estimate is never shown as the model's real window.
- Context commands and inspection are refused as unauthorized unless the calling local window can open the thread or Project, and a paired device never reaches the command route.

Status: Built. Since: —. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Provider capacity

One in-memory scheduler admits every Chat turn, managed child, automation and compaction against each provider instance's limits. Only a capacity answer backs a provider off.

- A refused request, rejected credential, unreachable endpoint or spent usage limit is not a capacity answer; the turn fails with its own cause.
- A managed child that finds the provider full waits for at most 30 minutes by default, a limit a person can change (maintainer request, 2026-11-12); not built yet: today the wait is a fixed five minutes. It holds no run slot, provider slot or session while it waits.
- When a slot frees, the host re-reads the parent. A helper whose parent drifted in authority ends Interrupted and never starts.
- Person-started turns keep a short head start over helpers, not strict precedence.

Status: Partly built. Since: —. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Turn metrics and spend ceilings

Every runner feeds provider events to one pure policy that times turns and journals full usage, and optional Project and thread spend ceilings gate admission.

- Precision is typed (exact, approximate, unavailable). Octant never shows a zero or a rate it did not measure.
- Ceilings cover tokens, turns, run time and money. The server refuses at admission, and money is checked between turns, not reserved.
- Cost is fixed when usage is journaled, from the provider's figure or the checked-in price table. Projections never price, so a later price change does not re-price history.
- Unpriced usage refuses a money ceiling as unknown-spend. A provider that never reports usage is left out and shown as Not measured.
- Child run spend counts against its parent thread's ceiling and that thread's current Project ceiling.

Status: Built. Since: —. Detail: [Architecture: Stop reasons](../architecture.md#stop-reasons) and [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Local usage history

Local provider history is a read capability of the provider SDK, and quota windows are a separate provider-reported snapshot.

- History is read without a model session or provider process, only from bounded, recognized usage files under the adapter's documented roots. It keeps accounting facts only, and malformed input makes coverage partial, never a false zero. _Here only._
- The accounting checkpoint is a versioned, bounded, rebuildable cache apart from the journal and usage ledger; opaque identities prevent double counting. _Here only._
- History reaches Usage only through a local authenticated endpoint returning bounded aggregates, not through model tools or to remote clients. A quota reset is never assumed to refill. _Here only._
- An earlier stored reading may answer only when the caller asks; the answer says it is earlier and carries its range, coverage and time, and the surface reads again at once. _Here only._

Status: Built. Since: —. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Compact session

Compact session replaces what the model sees with a summary and a recent tail, when the person asks or a rule they set asks for them, and always outside a turn. It never deletes or rewrites the journal.

- Who compacts follows who owns the conversation: the host for host-planned history, the runtime where its adapter claims support. Octant refuses where the runtime cannot compact.
- The command needs a local window that can open the thread, uses the thread's own provider and model, and needs no tool approval. A paired device is refused, and Plan stays allowed and read-only.
- A compaction never clears taint, costs tokens that count against the Project's ceilings, and never starts a replacement provider session behind the person's back.
- Automatic compactions are journaled as receipts, and a receipt never guesses a figure.
- No compaction has been run against a real runtime yet, and two runtimes declare no support.

Status: Partly built. Since: —. Detail: [Architecture: Context and usage accounting](../architecture.md#context-and-usage-accounting).

### Automatic compaction rules

Octant compacts a thread on its own only by a rule the person set in Settings: the window filling past a share, the thread going quiet, or its provider's account limit getting close. Each rule runs the same compaction a window's Compact session does.

- A rule asks as `host-policy` and meets every refusal a window meets; a refused rule leaves nothing behind. A Code thread is compacted only under the window whose turn crossed the rule.
- By default Octant compacts the threads it keeps (Octant Harness, and Chat and Work on a direct endpoint) at 85% of the window, and leaves runtimes that compact by themselves to their own point.
- Every rule-started compaction records its cause, and the timeline says which rule ran and how full the window was.
- A rule never switches a thread to another provider; the person picks the next model.
- The limit rule (off by default) compacts a thread once per account-limit period and first writes a summary with the thread's own provider that a switch to another provider leads with. The thread then says it is ready to move, with **Switch model**.
- The shares also reach inside a turn: Claude Code and Codex get them as a per-session setting (never in the person's files), and Octant Harness summarizes earlier turns once a step passes its share. Settings shows each runtime's own setting beside Octant's.
- Built: every rule above. Not verified yet: each on a live runtime.

Status: Built. Since: 2026-11-07. Detail: [Automatic compaction](automatic-compaction.md).

### Held standing context and resume

A provider that keeps its own conversation is sent standing context once, and resume is bound to a durable identity.

- Standing blocks the session already holds are not resent. The record keeps provider session ids and digests, never text, a compaction or failed restatement drops it, and a failed turn that sent a newer version of a keyed block drops that key.
- Standing text never varies by turn: a one-turn instruction is its own block kind that is never held, and a re-read file is a keyed block whose newer version is appended without restating anything else.
- A rule about an app tool names the tool, and a session that cannot call it never receives the rule; Codex keeps its thread's starting tools in the resume cursor for this.
- An offered tool that replaces a runtime's own path (Simulator.app, an emulator window, a backgrounded shell, `gh`, native subagents) gets one short routing line, and only that.
- Octant's instructions open with a fixed orientation per mode (inside Octant, rendered replies, the mode's purpose, self-describing tools, refusals reported, how reply blocks appear), then follow one order in every mode: orientation, reply formats, the mode's rules, tool notes, and the current turn's instructions.
- Where the runtime offers a channel beside the message (Codex additional context, the Claude Code prompt hook), Octant's context goes there and the message is only what the person typed; context is never moved into a system prompt or tool list, so earlier turns keep their cached prefix. Octant's own instructions may take Codex's developer channel; skills and material keep user-level authority. A restatement always replaces the material entry, so context withdrawn and then selected again is delivered again. The Claude Code prompt hook carries context only where it is known to run, and a turn whose hook context was never confirmed delivered is not counted as holding it.
- Resume refuses as stale-resume when its binding names another instance, session, Project root, mode or native id. At most one process owns a native session per instance.
- A retained provider runtime after a settled turn is reused only for an identical task, instance, executable, home, root, mode, model, policy, auth mode and tool catalogue. Any mismatch closes it and cold-resumes. _Here only._
- Resume of a native file needs a header matching session and root; a missing, ambiguous or cross-Project history refuses before input. _Here only._
- A follow-up on another model resumes the native session only when the driver reports model switching. Otherwise a fresh session starts with a disclosed handoff.

Status: Built. Since: —. Detail: [Architecture: Held standing context](../architecture.md#held-standing-context) and [Architecture: Stop reasons](../architecture.md#stop-reasons).

### Handoffs between providers, forks and branches

When a conversation moves to a new session, the new provider gets a bounded, disclosed text handoff. It never resumes the old session.

- The handoff is journaled before the prompt is sent, with counts, taint and omissions. Hidden reasoning, tool activity and the previous native session never transfer.
- A Chat or Work turn needs a text handoff only when the destination provider keeps its own session. Original user inputs are preserved separately on provider changes, rewind, supported forks or branches and Code fork merge-back, including host-rebuilt conversation. Exact source bytes, current scope and target modality are checked; an explicit text-only choice records omissions. Chat gains no filesystem or shell authority.
- Purgeable destination-owned manifests freeze the admitted input identity across retries and restart. A missing, changed, unsupported or revoked original refuses the send; native fork/rewind state is not duplicated as attachment inputs.
- A switch that cannot hand over refuses before the provider starts, with a named reason.
- Continue elsewhere reuses provider changes and existing paired-screen transport, identifies execution host separately from controlling screen, and discloses retained state and omissions. A task link selects the same existing task after authentication and never clones a writer or sends a draft. The explicit next-continuation text-only choice survives reload/queueing; the receiving thread can read its exact admitted input manifest.
- Merging a fork's conversation back is explicit and approval-free and adds context only. File changes reach the source only through Git review, and outside content the fork took in taints the source.

Status: Built. Since: —. Detail: [Architecture: Stop reasons](../architecture.md#stop-reasons).

### Stop reasons

A completed event carries a stop reason only when the runtime says why the turn ended.

- Absence is never guessed into a reason.
- A turn cut off at the output limit shows a note with Continue, which drafts a follow-up and sends nothing until the person does.

Status: Built. Since: —. Detail: [Architecture: Stop reasons](../architecture.md#stop-reasons).

## Native harness

### Harness loop and endpoint port

Direct-endpoint providers run under the native harness, which owns the agent loop and the conversation. Drivers supply only a transport through the provider SDK endpoint port.

- A local model endpoint must be a loopback origin, and every request names its context window.
- A model is offered Octant's tools only after tool verification passed for that model. Verification runs automatically the first time the model is used, as a capability probe and not a grant, and the manual Verify tools button stays (maintainer request, 2026-11-12). Not built yet: today it runs only when a person runs Verify tools on that model. Only the host-run command writes the record, and a tool call in a turn widens nothing.
- GPT-6 Luna function-tool requests through Chat Completions use its supported `none` reasoning mode, for both verification and real turns. Other models and plain-text requests keep their defaults.
- The conversation is journaled step by step. Resume closes interrupted calls as safe or unsafe to replay, and nothing is silently re-run.
- When a request outgrows the endpoint, the loop first compacts earlier turns tool-less on the session's own endpoint, then trims. The lead can read cut exchanges back through a read-only journal lookup.
- Every lead request ends with a note from Octant on how full the window is, worked out the same way as the compaction point. The note is never kept in the conversation, so the cached prefix holds. With automatic compaction off the note still shows the fill and says Octant summarizes only when a request no longer fits. A model whose window nothing names, or a turn on a fallback model, gets no figure.
- The harness never parses prose as a tool call. An unknown tool name, version, id or argument, or an unoffered capability, fails closed, and an ambiguously accepted call becomes waiting or failed rather than an unsafe replay. _Here only._
- After any context reduction or summary, the goal, its acceptance criteria and the recently edited files are restored to the request. Reduction changes only the assembled request, never the journal. _Here only._
- The harness's standing instructions include one fixed About Octant block, the same in every mode: the modes and what each may touch, Projects and the board, that an agent never marks a thread Done, access levels and read-only Plan mode, Project memory, skills, Canvas and helper agents, each tool named only as "when offered".

Status: Partly built. Since: —. Detail: [Architecture: Native harness](../architecture.md#native-harness).

### Harness tool authority and taint

Every harness tool call is authorized under the thread's current authority before any port runs, and outside content taints the thread.

- The offered tools follow the mode. A call is judged by the narrower of the thread's stored posture and the running turn's posture, so a turn narrowed to Plan refuses writes and commands.
- A tool that runs commands for the lead, such as Code's typecheck-and-lint `diagnostics`, authorizes and runs each command as a shell call, so it is never looser than the shell.
- A direct-endpoint request goes only to the configured base URL and follows no redirect. Web fetches refuse private destinations and carry no credential.
- Only harness results that bring in outside content taint the thread. On a tainted thread, shell, edit, write, check and web-fetch need a single-use confirmation, and remembered approvals stop covering them.
- A tainted thread's search query is refused when it looks like it carries data, before any request leaves; it is a guard the person lowers with the outside-content gate, so at Full access in Work and Code the refusal does not apply.
- At Full access in Code a tainted thread records the taint and asks no confirmation.
- An `edit` call may make several replacements across files. It is one call under one approval that names every file, and it is all or nothing: every replacement is checked first, a refusal names the one that failed and changes nothing, and a write that fails afterwards puts the call's earlier writes back.
- Every tool result is hard-capped with a truncation marker and paging, and nothing variable enters the stable request prefix. _Here only._
- `read` hands the model a PNG, JPEG, GIF or WebP image, recognized by its bytes and capped at one tool image, only when the session's model takes image input, and otherwise refuses with the reason. Word, PowerPoint and PDF files read as their text and Excel workbooks as rows, through the preview parsers and under their limits, and such a read does not count as the read an edit needs; any other binary file is refused.
- A lead's `skill` tool lists and loads only the skills effective for its thread under the activation ladder, refuses any other, and never installs, trusts, enables or activates one; it only reads, so Plan keeps it.

Status: Built. Since: —. Detail: [Architecture: Native harness](../architecture.md#native-harness), [On-demand skills](../architecture.md#extensions-and-skills), and [Search queries on a tainted thread](search-query-taint.md).

### Harness retries, routing and fallback

Direct-endpoint requests follow one retry policy, and models are chosen by routing slot.

- A request goes out at most five times and is retried only while nothing has streamed. A spent allowance, rejected credential or malformed event is never retried.
- When retries are spent, the lead falls back once per other ready model, and a failure after output streamed never moves the turn.
- Child runs take their model from the role's slot through one admission path; the lead runs on the thread's chosen model.
- Routing is by slot (default, plan, slow, task, smol, vision, advisor, reviewer, plus custom), and every harness model call names one. An unconfigured slot resolves to default with a visible warning, except the advisor, which stays off. _Here only._
- The advisor reviews compact turn digests and may cancel, redirect or pause, but never executes tools, edits files or grants approvals. _Here only._

Status: Built. Since: —. Detail: [Architecture: Native harness](../architecture.md#native-harness).

### Harness sessions, goals and steering

One journaled session per thread is the only state, and every surface reads and changes it through one route. A person redirects running work only through ordered steering notes and version-checked goal revisions.

- After a restart, a session with an open turn or pending approval is recovery-required and admits nothing until a person resumes it, unless the host lifts it to continue a turn a restart cut off ([Continuing a turn a restart cut off](#continuing-a-turn-a-restart-cut-off), on by default); a turn whose last effect is uncertain still waits for a person (maintainer request, 2026-11-12). Lost turns and dead approvals are journaled.
- The lead's approvals and questions block until any surface answers, do not expire, and are capped at 32 waiting (maintainer request, 2026-11-12); not built yet: today they expire after ten minutes. A pending one marks the thread as needing the person.
- Built: the provider-neutral app-owned `ask-user` tool can collect up to four related single-choice or multiple-choice questions inline in Chat, Work and Code, with selection limits, unselected recommendations, written alternatives and an optional comment. It creates no Canvas and grants no permissions.
- Unsent questionnaire choices and comments remain in memory on their source screen across navigation and deferral. They do not transfer to another window, survive a screen reload, or carry into a changed, settled, cancelled or recovered request; restoring them sends nothing.
- The host validates the complete questionnaire response against the journaled ask before accepting it once. Another window's answer withdraws the pending card, and the originating thread retains an expandable submitted-answer summary after reopening. [Workspace: Inline questionnaires](workspace.md#inline-questionnaires) owns the presentation and answer contract.
- A goal completes only on evidence from a criterion check or a person; a model saying it is done completes nothing.
- A goal loop's budgets are its stopping condition. A loop that would exceed a token, time or turn ceiling does not start the next iteration and moves to budget-limited, which only a person resumes. _Here only._
- A person sets, raises or clears a goal's turn, time and token budgets when revising it; a revision's budget replaces the whole budget. A loop refuses to start on a goal with none. _Here only._
- An unattended iteration runs under a ceiling declared at loop start, clamped to the thread's authority, which can only narrow. An effect needing an approval no person can give suspends the loop and is never auto-approved. _Here only._
- Harness parity with the first-class runtimes is claimed only while every checklist item holds in Chat, Work and Code.
- Built: the terminal starts like a coding CLI. `octant` alone at a terminal, `octant --<agent flag>`, or `octant "<prompt>"` opens `octant agent` on the folder's thread, a bare prompt being the first message of a session that stays open (`--prompt` still runs one turn and exits). Inside a Git checkout no Project holds, a person at the terminal is asked whether to add its root as a Code Project, through the same bind-and-create as `octant project add`; nothing is asked without a terminal or with `--json`, and a no adds nothing.

Status: Partly built. Since: —. Detail: [Architecture: Native harness](../architecture.md#native-harness).

### Follow-up suggestions and side tasks

Follow-up suggestions and offered side tasks are journaled offers that grant nothing. Both come from every provider, not only the harness.

- A confirmed follow-up is created through the mode's ordinary creation command, and the prompt is never sent on the person's behalf.
- A reply may also predict the person's next message, one line in their words. The empty follow-up composer shows it as its placeholder and Tab puts it in the draft; it is never sent for them, and a turn starting on the thread spends it. It comes from the same in-reply block on every provider, so it costs no extra request.
- A side task is offered for out-of-scope work, for a split the person asked for, or for a real next step the reply recommends. It appears inline in the transcript after the offering turn, as a card asking whether to start it in a new thread or do it here.
- Every answer is the person's click: a new thread (fresh, or forked from the conversation through the offering turn), do it here (the prompt goes to this thread now, or queued behind the running turn), or dismiss. The prompt is sent only on that click, and a Code thread still starts approval-gated.
- A fork waits for the offering turn to finish. Chat, Code and Work each fork through their own command; a Work fork carries the conversation as a text handoff.
- Do it here records a durable unconfirmed claim before dispatch. A known refusal reopens the offer; an uncertain delivery or failed receipt stays visibly unconfirmed across restart and is never retried automatically.
- A Code Project's designated planner offers work to its board with the same tool and target `board`; that records a pending planner proposal, which only a person confirms.

Status: Built. Since: —. Detail: [Architecture: Native harness](../architecture.md#native-harness).

### Harness tool egress rules

A harness command on an approval-gated or auto-accept-edits Code thread reaches exactly the destinations a person allowed for that thread, through a per-launch host proxy, and nothing else.

- The `proxied` level never falls back to open network. A launch whose listener cannot bind, or whose start or summary cannot be journaled, never runs or reports unavailable.
- The proxy refuses any destination that resolves to a private address under every rule, and a rule cannot name an IP literal or a single-label name.
- Every rule expires, a child uses its parent's live rules, and rules never leave the host.
- Rules arise only from answering a network-access approval, never from a model call, tool result or repository configuration. Project rules need a person at a local window.
- Taint suspends standing rules, and bytes a proxied command receives from outside taint the thread. Learn mode turns refusals into proposals that grant nothing.
- Provider runtimes that run their own tools in-process run on a proxy of their own, decided by provider endpoints, Project rules and safe networks rather than thread rules.
- With Network limits on, Octant Shield answers a command's per-call network prompt on an untainted thread it reviews at Auto; its allow is one call rule for that launch, granted by the reviewer.

Status: Built. Since: 2026-10-13. Detail: [Architecture: Harness tool egress rules](../architecture.md#harness-tool-egress-rules).

## Extensions

### Activation ladder and executable components

A component is active only when its package is installed, its source trusted, the master and component switches on, compatibility passes and policy allows. Any other state contributes nothing.

- Install, trust and enable stay three steps by default. Installing and trusting in one confirmed step is built for a new install (Install and trust), journaled as both, and enabling stays its own switch.
- A selection carries the catalog epoch it was resolved under, and the host re-resolves it on send, replay, resume and handoff. Any difference blocks it as stale.
- Executable components stay quarantined until reviewed, then run in supervised sandboxed processes. Only macOS starts them, since there is no Linux confinement.
- A structured mention cannot install, trust, enable or elevate anything.
- A curated workspace preset may name skills, and naming is all it does. The host reports each named skill's state (in use, installed but not enabled, not installed). _Here only._
- Marketplace network access happens only on user action, and opening Settings fetches no catalog.
- An author writes a plugin without a running host: `octant plugin create` writes a starter Agent Plugins folder and `octant plugin check` reads a folder by the host's folder-import rules and shared loader. Neither installs, trusts or enables anything, and neither reaches the network (2026-11-07).

Status: Built. Since: —. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Skill discovery and Project code denial

Octant discovers skills only from the closed Project allow-list, the user-global folder, and the provider and added folders a person turns on, never from the home folder's own tool-configuration folder on its own. A runtime that loads Project code by itself is switched off or denied.

- A discovered skill is never trusted or active because of where it was found. When two skills share a name the Project's copy is used, with a notice (maintainer request, 2026-11-12); not built yet: today same-named skills that share a thread are both turned off until the person chooses.
- A runtime that loads Project skills, MCP servers, hooks or plugins by itself runs with a proven switch or is denied the file in the OS profile. Instruction files stay readable.
- Two runtimes are refused at start in a Project holding their settings entries, because their loaders fail on a denied file.
- Skills from Claude Code's and Codex's own folders, turned on one by one, and folders a person adds in Settings are discoverable roots under the same ladder; Octant adds none on its own.
- Desktop offers a window-owned purpose receipt folder picker alongside manual paths; it records only the existing skill-folder setting and grants no trust or enablement. Chosen-root diagnostics explain zero discovery. Bounded selected-root/package watching covers later creation and package changes; committed-setting reconciliation works without a mounted Settings view, and host teardown prevents late watcher restart.

Status: Partly built. Since: —. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### MCP tool approvals

Below Full access every MCP tool call waits for an approval in the turn's window unless a remembered approval covers it; at Full access a tool of a trusted and enabled server runs without asking, on a thread that has taken in outside content too (maintainer request, 2026-11-12). At most 32 approvals wait at once host-wide.

- Not built yet: today an MCP tool call asks at Full access as at every other level.
- A paired device answers only prompts its own turns raised, and an unanswered approval waits in Needs you until a person answers it (maintainer request, 2026-11-12); not built yet: today it expires after five minutes.
- A turn the host runs with no window (a routine, a goal loop) waits in Needs you for its approval instead of being refused (maintainer request, 2026-11-12); not built yet: today such a call is refused.
- A remembered approval covers one tool in one Project, bound to a digest of its listing. The person can also allow all tools of one server at once, and a Chat thread outside a Project can remember a grant for the account (maintainer request, 2026-11-12); not built yet: today a grant covers one tool in one Project and nothing wider. It grows only through the local window answering its own turn's prompt, and any mismatch asks again.
- Below Full access, on a thread that has taken in outside content, a remembered grant holds only for a local stdio server; a network server asks every call.
- Uninstall, withdrawn trust and rollback revoke grants, and installing again restores nothing.

Status: Partly built. Since: —. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Connectors and user-added servers

A person connects an MCP server from Settings in a local window only. It becomes an ordinary package installed, trusted and enabled as one act, under the same activation ladder and approvals.

- A secret value goes to the credential broker and never into the package. Listing servers found on the computer is read-only, and nothing is imported until the person clicks that item.
- The Connectors view is a bundled first-party catalog that fetches nothing to render. The host accepts a connector id only at that entry's own address. Doop joined on 2026-11-01 after a bare request to its address answered 401 with resource metadata, and its authorization server published PKCE S256 and dynamic client registration. Dropbox, monday.com, ClickUp, Miro, GitLab, Buildkite, Amplitude, Calendly, Pipedrive and Klaviyo joined on 2026-11-07 after the same probe passed for each. Every entry names the vendor's own setup page and search keywords, both shown or matched in the Connectors view and the Library. `bun run connectors:probe` re-checks each address against its auth kind and each setup page; it runs weekly and on demand in CI, outside pull-request checks and never in the app, and an entry that fails it is fixed or removed in the catalog, not patched in the UI. Google's preview servers answer `initialize` without a credential and ask at the tool call, so the probe accepts that answer for a sign-in entry when its well-known resource metadata holds up, and says so.
- The Library is the first view in Settings › Skills & Extensions: one searchable list over connectors, plugins, skills and MCP servers, built only from the bundled list, the installed snapshot, results already searched for and the local look at Claude Code and Codex. It fetches nothing and ignores the Marketplace fetches switch because it never reaches the network. Each item shows its source, provider, state on the install, trust, on ladder, what it can do and an authority level from its declared capabilities. Trust and turning on are separate one-click commands; a generated MCP server added directly installs, trusts and turns on as one confirmed act. Rationale: a person judging an extension needs state and cost in one place, and a combined view must not widen what any one install flow may do. The Library groups by installed state, then a hand-picked Featured group from the bundled list and the catalog's categories (each of those closed until opened, and open while a search or filter is on), and finishes the job in place: Connect… (opens the detail, which holds the one confirming press, the key field and the sign-in, over one function shared with Connectors) and Review then Install for a Marketplace plugin, which installs only and leaves Trust and Turn on as separate clicks; reading a plugin stays under the Marketplace fetches switch and every check stays on the server. The Featured set is fixed: a connected connector stays in it and shows its state on its card (and also stays under Installed), so the group never has a hole. Each item is one compact row of one height (mark, name, source, authority dots, and its state or next step at the trailing edge; two columns when the card is wide, with the source then left to the detail); the name opens the detail, which carries a skill's own description (and no line when the host gives none). A row says its next step rather than a repeated state. A list of more than ten items that are not installed shows its first eight with "Show all N"; everything installed, switched on or off, is always drawn, and an item that awaits a decision (blocked, awaiting trust, or a server that is not connecting) leads. Bundled CC0 Simple Icons marks (source recorded beside each, noticed in the logos licence file) show for the connectors that have one; the rest keep a two-letter tile. The shared Settings titlebar lost its bottom rule on every page, because the strip it bounded is empty and read as a bar.
- Long Settings pages stay short by drawing long lists as compact rows and folding reference sections (Skills & Extensions and Permissions first; maintainer request, 2026-11-11). A compact row is one line of one height: the name (which opens the row's own detail: paths, permissions, secondary actions), a short state in the meta ink, and the one main control at the trailing edge. A section folds only when it is reference material or empty, its label is then a button with `aria-expanded` and its closed line says what it holds (a count, a state); what is switched on, trusted, protected or allowed stays readable closed, and a section holding any remembered approval, refusal or removed protection opens by itself. Nothing is removed and no behaviour changes: Settings search and deep links open the fold that holds their row and focus it. Built in Settings › Skills & Extensions › Library and Settings › Permissions (Protected files, Servers, Remembered websites and tool approvals, Safe networks, Bind a folder); other long pages may adopt it.
- Atlassian's v2 HTTP and Airtable's HTTP connectors reuse public MCP PKCE/DCR and the existing broker; manual app setup remains separate from consent. Airtable has a distinct scoped PAT entry and an exact transport-to-origin resource alias; no generic resource equality is weakened. Vendor consent, selected bases, account permissions and admin restrictions remain authoritative; setup does not prove live tool access ([Architecture: Connectors catalog](../architecture.md#extensions-and-skills)).
- HubSpot uses its exact vendor HTTP endpoint through the existing registered-client setup and broker. The person creates an MCP connector, registers the retained callback, and links its confidential client secret before separate consent. PKCE S256 and advertised POST client authentication apply; no fixed scopes, shared secret, or hosted service are invented. Permissions and tools depend on account consent and vendor eligibility; setup is not authenticated acceptance ([Architecture: Connectors catalog](../architecture.md#extensions-and-skills)).
- Box uses its exact vendor HTTP endpoint through the same registered-client setup: its authorization server publishes PKCE S256 and client-secret token authentication but no dynamic registration, so a Box admin enables the Box MCP Server integration and the person links its client ID and secret before separate consent. No fixed scopes are invented; the integration sets them. Setup is not authenticated acceptance ([Architecture: Connectors catalog](../architecture.md#extensions-and-skills)).
- Paper has a local Library setup through the existing generated MCP package route, separate from hosted connectors and OAuth. It uses the documented loopback HTTP fallback without widening stdio confinement or claiming CLI compatibility. The host validates its exact address and generated-package identity; installation never claims Desktop/file readiness, and normal activation and task tool approvals remain in force.
- HTTP MCP session loss removes stale tools and waits for later authoritative task reconciliation to initialize/list a replacement. A failed call is never replayed, since a lost response may follow a completed write. Application-level refusals retain healthy sessions, withdrawn authority blocks reconnection, and a late old call cannot evict the replacement. Transport recovery preserves the task/draft; new or changed definitions for a fixed-tool provider require explicit fresh-session conversation text-handoff continuation.
- Hosted-server sign-in follows the protocol's authorization flow with PKCE, and the grant lives in the broker. A paired device can read the state and nothing more. Application registration is separate from account consent: the existing local sign-in RPC accepts pre-registered clients or an advertised HTTPS metadata-document identity, with an exact loopback callback retained across restart. Confidential clients reference a broker-held MCP secret bound to the configured token endpoint; no shared secret ships in the app. Dynamic public registration and GitHub PAT access remain available. A closed Slack user-token dialect pins the exact MCP transport, distinct origin resource, issuer and dedicated endpoints, requires advertised client_secret_post and the single search:read.public permission, and retains its Bearer interpretation on refresh. Its non-featured catalog entry opens shared client setup on explicit Connect before separate consent; list/status reads do not discover endpoints or probe tools. Bounded endpoint-reported workspace/user IDs and permissions remain last-reported facts, with Not reported for omissions; known identity changes or explicitly missing public-search permission durably require reconnect without an old bearer. Actual capabilities come from authorized task discovery and approval. Slack sign-in requires an explicit retained localhost callback choice; the broker owns both exact loopback families at its fixed port and refuses partial/busy binds. Legacy registrations are not silently rewritten. Broker status reads have a ten-second client/service bound and the renderer MCP sign-in fetch/body has a separate thirty-second caller bound. Unknown status retains pending ownership for explicit Check/Cancel recovery; background polling does not disable cancellation, and expired/older reads cannot restore a late sign-in state. An unknown save response is checked by reopening setup rather than assuming it failed. A protected broker cancellation seam binds a retained MCP attempt to its recorded actor and descriptor, closes listeners, and prevents late exchange or pending-write orphan grants; unavailable cleanup retains ownership in broker memory for explicit retry, without crash-recovery claims. The shared setup view displays and saves the selected localhost callback only after the shown-binding recheck and selects the only advertised confidential method. Explicit pending cancellation retains retry ownership on failure; owned generated-server uninstall confirms pending cancellation before lifecycle removal, with a scoped Begin gate released in finally and no early folder deletion or established-grant revocation. Public-none compatibility and live vendor acceptance are unproven. The shared Client setup control explicitly prepares the copyable retained callback, saves public or advertised metadata identities without consent, and links a confidential client to an item in an already linked secret store using the existing broker namespace. Saving rechecks the shown issuer/resource/token endpoint/callback and refuses changed bindings; paired devices cannot prepare or save setup. Secret references are durably reserved before pointing; unknown point or deletion outcomes stay reserved across restart under a 256-reference owned/reserved budget. Point and retirement stages each wait at most ten seconds, with quiescent operator recovery for unresolved references. Broker waits never hold the shared state commit queue, and setup cannot change while any component of the same resource awaits consent. Completed grant sign-out keeps a durable unusable cleanup owner on broker failure or a ten-second cleanup-stage timeout, offers Finish signing out, and preserves application registration; failed intent persistence does not claim restart durability. Owned generated-package removal refuses a pending completed sign-out, preserving that retry control; its existing gate blocks a new sign-out during admitted removal without early grant revocation or changed uninstall ordering. Grant replacement, sign-out intent and proven revocation retire the existing manager's targeted authentication generation and cached tool index synchronously, with ten-second bounded transport close. Per-call, late-initialize and exact session/connection identity fences preserve unrelated components and reject stale completion without replay. A later authoritative task reconciliation discovers tools with current authentication. Approved calls on host-owned HTTP OAuth sessions perform bounded expiry-aware access/refresh against the captured grant owner; changed authorization retires tools before dispatch and requires normal authoritative reconciliation. Actual401 marks only that owner for later refresh and never replays the failed call. MCP completed cleanup uses existing runtime retirement to deny access/refresh, join an in-flight refresh/write and then delete, retaining unknown cleanup ownership for retry. Application edits do not replace the consented grant binding; siblings and other dialect sign-out remain unchanged. Fixed-catalogue providers now report new or changed definitions through the provider SDK, backed by persisted per-definition SHA-256 fingerprints. Chat/Work refuse before accepting a changed-catalogue draft; Code parks its recorded unsent turn and restores the draft. The person explicitly chooses Continue with updated tools to send the draft in a fresh session through the existing bounded, journaled conversation text handoff. Native session, full task history and ordinary tool authority remain preserved; omissions are disclosed, hidden reasoning/tool activity do not transfer, and failed calls are never replayed. Withdrawn-only tools retain the session and host refusal policy; legacy cursors need explicit continuation before nonempty tools. Vendor-specific setup and eligibility are separate from this shared foundation. The separate GitHub OAuth App read entry retains the PAT path and distinct generated-package ownership at the same URL. Its exact GitHub.com profile requires person-owned client_secret_post credentials, S256, retained 127.0.0.1 callback with issuer response, and only read:user plus offline_access. Every exchange/rotation requires expiry and new refresh material, then a bounded fixed broker /user identity read with required User-Agent/API version; only safe numeric user ID and reported scopes survive. Known identity change, broader/missing read permission or failed rotation identity requires reconnect without an old bearer. Private repository/email/write and GitHub App installation authority are excluded; token success alone does not establish MCP tool support, which remains a live acceptance gate. The separate GitHub repositories preset explicitly requests repo+read:user+offline_access, disclosing broad public/private read/write and related organization reach before Save/consent. Only a host-owned reserved generated-source/configuration/current-package receipt selects it, retained across discovery/secret waits and rechecked inside the existing commit queue. A closed profile persists through both broker projections, grant/restart/refresh and pre-bearer comparison; absence always retains old profile-read. Shared OAuth App vendor permissions may couple, so renewed broader old-read tokens require reconnect without fallback. PAT/read local identities remain separate and no existing grant is silently upgraded; fine-grained GitHub App installations and public_repo-only setup remain optional/unselected, not blockers to the explicit repo preset.
- Gmail, Google Drive and Google Calendar are three separate read-only preview connections to Google's own MCP endpoints. Each asks its own consent for only that service's read scopes, never the advertised scope union, and none can send, draft, edit, share, delete or reply. They use the person's own agentic Desktop app public client with PKCE S256, a retained loopback callback and `access_type=offline`; no client secret, hosted Octant service or second token store. A missing, expired or revoked refresh grant asks for sign-in again and keeps the task and draft. The live enrolled-account check is still owed, and public distribution stays held until Google permits it or announces general availability; scope verification and any restricted-data review are separate gates.
- A host-private GitHub Actions source reader binds the selected registered repository OAuth component, grant/app, numeric account and prepared repository IDs. Fresh binding and subsequent reads additionally require a host-supplied current effective-component witness; missing/disabled/untrusted authority refuses before API reads, and late activation-retired work cannot publish. This source-only check does not gate application configuration or account consent. The existing broker alone builds fixed read-only identity/repository/completed-run requests, with bounded bodies/pagination/deadlines, original owner/generation checks and existing refresh/retirement ownership; no arbitrary URL/header, token output or gh/PAT fallback. Rate-limit403/429 stays retryable without invalidating a healthy source; known permission/account/repository changes refuse it. Latest observed completed attempts are metadata, not proof of unseen rerun history. Automatic routine occurrences, durable catch-up/gap/loop composition and live Actions acceptance remain unbuilt in this reader boundary; existing manual CI-follow-up does not start work.
- Installed opens with Server connections: each installed MCP server and connector with its transport, state (Off, Needs sign-in, Connected, Connecting, Not connecting, Blocked, Ready), last error sentence and last-seen time, composed on the host from retained facts only; reading it never connects, signs in or lists tools. Connectors rows and Library cards flag a connected server that needs attention. Signed out counts as Needs sign-in only for a catalog connector that signs in, because a server that takes a key or nothing reports it too; the listing reads sign-in status without polling a pending attempt. Reconnect, from a local window only, clears the component's sessions and failures in every task scope so the next authorized task connects fresh; it connects nothing itself and never replays a failed call. A paired device reads the states only. Rationale: a Settings connect would discover tools outside a task's authority ([Architecture: Connectors and user-added MCP servers](../architecture.md#extensions-and-skills)).
- A Project pin offers a plugin on every turn in a Project but grants nothing; every tool call still asks where [MCP tool approvals](#mcp-tool-approvals) asks.
- A person may add or remove an MCP server, a plugin marketplace, or a plugin on one Claude Code or Codex account from Settings › Skills & Extensions › Library › Claude and Codex, by Octant running that program's own commands against the account's own folder; Octant never writes those files itself. Rationale: the provider's commands are the supported way to change its files, and a shown command with one confirmation keeps the person in charge of what runs.
- The exact command is shown first (the account's folder variable and a `<secret>` placeholder included) and runs only after the person chooses Run this command once, as the plan that was shown, within ten minutes, from the window that asked, and only if the account has not changed.
- It is refused on a paired device and unreachable to an agent, since every step needs the local window's capability. The program is started with an argument list and no shell; every value is validated; Claude Code commands name the user scope.
- A secret is never an argument. Claude Code's OAuth client secret goes through the credential broker to the child's environment; Codex takes only the name of a bearer-token variable; a plain setting or address that looks like a key is refused on a best-effort check. A secret held for a shown command is deleted when the person cancels or the command expires.
- Each change is journaled (`provider.tooling-applied@1`) with the provider, account, command kind, name and outcome, and no value or secret. A version of the program without a command says so and Octant offers nothing for it.
- A tool added this way reaches an Octant thread only while the account runs as itself or at Full access, and the panel says so and links to that switch.

Status: Built. Since: 2026-10-20 (Connectors); 2026-11-01 (Claude and Codex tools). Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Computer use and device tools

Core capabilities (browser and computer use, tests, Apple validation, approvals, memory, subagents) are app-managed and provider-neutral. None depends on an optional extension.

- Computer use needs an approval at the first action in each application, once per thread and with no five-minute expiry; a setting can remember it for the Project (maintainer request, 2026-11-12). Not built yet: today the approval lasts five minutes per application. It treats application content as untrusted, fails closed if evidence recording fails, and is refused in Plan.
- Onboarding and Settings share optional setup with separate macOS permission actions and a local, explicitly approved capture-and-click test of a temporary owned window. Verification expires on permission loss, disablement or driver restart. Existing standalone installations remain untouched; agent control of Octant stays refused.
- The computer-use driver is a bundled, pinned, publisher-verified copy. It is accepted on the same contract minor, and updates only when the person turns on automatic updates.
- Driver startup verifies the driver-reported host bundle identity and protocol and binary versions, and a failed check refuses admission. _Here only._
- A screenshot alone never authorizes input; revalidation must resolve that exact window first. Interrupted work cancels pending approval and input. _Here only._
- Managed device tools are pinned, integrity-verified releases run with an allowlisted environment and a device-scoped native sandbox; auto-update is off by default, and no upstream installer script runs. The sandbox grants device state, SDK and runtime files, private transient state and the native services the tool needs, never a Project or provider account. macOS limits networking to loopback; Linux retains the host network for its shared adb server and browser listeners. A missing sandbox keeps the existing native device fallback instead of launching the npm tool unconfined. Detail: [Managed device tools](device-workbench.md#managed-device-tools).

Status: Partly built. Since: —. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Canvas export

A Canvas export reaches a destination only after the person approves a card showing the exact payload and destination.

- A call without confirmation never overwrites an existing file; it writes a numbered copy beside it.
- The rendered document passes a secret-and-path filter, and one that fails is refused rather than published.
- Saving or copying the HTML file is not a destination: it needs no approval and journals nothing, and the file loads nothing.

- Local destination packages declare one module and exact HTTPS origins. Examples bundle the public SDK with their entry; workers resolve no SDK from the host checkout and inherit no host endpoint configuration or keys. A supervised worker runs the portable protocol; only an approved export gets bounded mediated network requests. Description is offline and bounded; changed activation or package identity invalidates approval. Linux and Windows execution stays unavailable pending verified native confinement.

Status: Built. Since: —. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Composer window capture

In the macOS desktop app the person can attach a picture of one open window from the composer; it is the person's action, never an agent tool.

- Listing reads window titles only, with no pixels; the screen-recording permission is asked only after the composer explains it and the person continues.
- A capture reads exactly the one window the list returned, in a hidden network-free page, and a window that closed is reported, never retargeted.
- The picture goes through the ordinary image attachment path and its authority checks; the shell keeps no copy and sends no telemetry.
- Web and phone clients do not offer it, and other desktop platforms omit it until their permission model is designed.

Status: Built. Since: —. Detail: [Architecture: Extensions and skills](../architecture.md#extensions-and-skills).

### Plugin boundaries

New providers and tools reach the system through the published SDK, API and host seams. They take no shortcut a third-party plugin could not take.

- Plugin ports carry no raw filesystem, shell or credential handles, and plugin state holds only opaque references.
- Installed Code tools may declare bounded existing credential-operation or saved-command ids in `extensions.octant.codeTools`. The public turn-scoped port exposes declaration-scoped names and request/run-saved actions, never commands, paths, credentials or host services. Code-only selection and the activation ladder remain separate from person approval; changed package/catalog/task authority invalidates pending use before effects. The core credential family uses that same public port/composer with its existing name, help, schema and host policy; its additional task-owned command presentation remains private to the server adapter.
- Maintainers decided on 2026-11-07 that GitHub, thread boards and Zen are bundled first-party plugins a person can switch off and on, each on by default. Usage, diagnostics, Navigator, the automations UI, browser and computer use, agent hierarchy, remote and mobile access, the Apple workbench, and the marketplace and plugin registry stay integrated core features and are no longer extraction candidates.
- The first-party manifests have one definition that the server and the renderer share.
- A bundled plugin's switch is journaled on its own aggregate, apart from the installed-package lifecycle, with a rebuildable projection; a plugin nobody switched is on.
- The extension snapshot carries one host-written row per switchable bundled plugin. Only its switch may change it, under the same expected-version rule and local-window authority as an installed package; every other package command on it is refused.
- Bundled plugins are left out of a scope's effective state, so they are never addressed, selected, pinned or given tools, and the Library does not list them.
- Disabling a plugin preserves its data and selections and drains running executables. Deleting credentials needs its own explicit confirmation.
- Each feature follows its switch on the host and in the renderer: GitHub's account, repository, clone, issue, read-tool and Gist surfaces; the Work and Code boards and every way to open them; and Zen's routes, tool and window. Git and pull requests stay core, and the board's data and the tools that read it stay available.

Status: Built. Since: 2026-11-07. Detail: [Architecture: Plugin boundaries and remaining extraction](../architecture.md#plugin-boundaries-and-remaining-extraction).

## Authority and approvals

### Local authority

Nothing reachable on loopback grants window authority by itself. Local clients must present a secret only the host's OS user can read.

- The desktop app and the CLI present the desktop bridge secret from the owner-only runtime directory; a browser presents a one-time launch token minted with it and bound to its origin.
- Another OS user, an ssh port forward, or a proxy that rewrites `Host` reaches the listener but gets no capability.
- Paired remote clients keep their own device-session path, unchanged.
- An owner device the person marked can hold window authority on a host that lists it, for a signed request or a short administration window; it is built, and its real-device check is owed ([Hub and spokes: owner devices](hub-and-spokes.md#owner-devices)).

Status: Built. Since: —. Detail: [Architecture: Security and authority, Local authority needs the bridge secret](../architecture.md#security-and-authority).

### Server-side tool-call policy

A tool call from a model is a petition, not a grant. The server resolves every call before anything runs, and tool results are data, never instructions.

- Every call resolves through the closed tool catalog, the mode's capability matrix, the thread's elevation state and the actor's authority.
- A Code turn acts on the checkout it started on until it ends; Octant's tools and the provider's built-ins use the captured root, confinement and identity, not the window's later binding.
- App-managed tools that reach Project-scoped services (a window-held terminal, the planner board, a sibling thread's transcript) follow the window's live binding and liveness when the call runs.
- Octant's own tools always re-check the live execution policy, so a thread put in Plan mid-turn refuses writes and process launches on the next call.
- An allowed approval of a native harness tool is authorized again when it resolves; the call runs only if the thread's authority, posture and taint then still allow it without a different approval.
- A provider's built-in tools keep the posture they launched with; lowering the grant reaches them on the next turn or when the person stops the turn. Answering their approval requests does not reread the grant.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Server-side tool-call policy](../architecture.md#security-and-authority).

### Approval categories and postures

Approvals are independent categories, and grants are scoped and journaled. Plan mode is read-only at every level.

- Categories are project file writes, shell commands, network access, external application control, destructive actions, credential access, access outside the bound root, and privilege or sandbox changes.
- Auto-accept-edits waives only project file writes; a Work thread's access is set by the host, not the renderer, and stays confined to the Project root.
- Full access is chosen only in an Octant window on this host, or on an owner device the person marked at a local window, and journaled on the thread; any other paired device may lower a thread but cannot raise one to Full access or start one there, no agent grant raises one, and session-only Full access is gone (maintainer request, 2026-11-12). Not built yet: today an owner device raises a thread to Full access only through owner posture recovery under its own fresh unlock ([Hub failover and owner devices](#hub-failover-and-owner-devices)) and cannot start one there.
- The terminal CLI sends Full access exactly when the Project remembers it.
- Three provider tool requests denied in one Code turn end it as interrupted, with the reason journaled, so a provider cannot loop a person's refusals.
- A pending approval records the thread's posture when it is asked (mode, who answers prompts, the Full access sandbox, how long grants last, the coordinator gate). An allow answered after that posture changed is refused before anything is delivered ("This thread's permissions changed since this was asked, so it asks again."), and the same approval stays pending under the current posture; a denial is always delivered. This covers Code provider and app-managed tool approvals, Work requests and native-harness approvals, a child's included. A native-harness "always" grant records the posture it was granted under and stops answering (the class asks again) while the thread holds any other posture. Rationale: an approval granted under a wider posture must not take effect after the person narrowed it.
- A refusal that fails closed on authority names a recovery a person can perform (a user action, a restart or elapsed time), shown where the person is; recovery never widens automatic admission.
- New Code threads start in the mode chosen at first run, which Settings and a Code Project can change; Work threads take the same levels, set by the host.

Status: Partly built. Since: —. Detail: [Architecture: Security and authority, Approvals](../architecture.md#security-and-authority).

### Provider auto-review

A thread's `autoApprove` flag says who answers a prompt, not what is permitted.

- Both prompting postures (approval-gated and auto-accept-edits) delegate to the provider's reviewer when `autoApprove` is set and the provider reports `harnessAutoReview: "supported"`; taint and capability clamp delegation off (unknown taint counts as ingested).
- Categories, the sandbox, egress and credential reach stay Octant's whatever the provider reviewer answers; an auto-accept-edits waiver outranks the delegation.
- On one provider runtime, approval-gated honours permission grants the person saved in that runtime for the same repository; Octant's denies still win and Octant never writes such a grant.
- Octant Shield answers these prompts on a Code thread or a Work thread where it is the reviewer, on every runtime that routes them to Octant.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Approvals](../architecture.md#security-and-authority).

### Goal-loop round authority

A Work goal-loop round runs as the host under the same per-process host scope a routine runs under, never through a window.

- A round runs with no window open, its turn is journaled as the host's `system` actor, and the Work turn path still rechecks the thread, its Work Project and the round's authority.
- A loop pauses while Work is turned off, and a round's turn rechecks the switch at admission.
- A round with no checkpoint runs only when its effective authority is approval-gated; under auto-accept-edits or Plan it pauses as `checkpoint-unavailable`.
- An approval a round raises is offered, like a routine's, to the local windows bound to its Project.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Approvals](../architecture.md#security-and-authority).

### Pending requests, fleet activity and turn decisions

Reads that gather what needs the person add no authority; each mode lists only what its existing answer command would admit for that window.

- Pending requests list approvals, questions and turn decisions oldest first (at most 128); fleet activity lists threads that need the person and running threads (at most 64).
- Both reads are local-window only: outside every forwarded prefix, no remote action, and a paired device's principal is refused.
- A child agent's or lead's approval or question appears as a row without options or an answer handle; answering goes through the thread's own approval card.
- A Work or Code turn that needs a choice ends with one `octant-decision` block (one ask, one to four options, one recommended); Chat is not asked.
- A decision is parsed by the host from the normalized reply, derived on read and never journaled, and answered as the thread's ordinary next turn; an option performs no host action.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Pending requests across modes](../architecture.md#security-and-authority).

### Desktop authority confirmations

A desktop authority confirmation is decided only in an isolated approval view owned by the main process, not by the ordinary renderer.

- The approval view is sandboxed with a restrictive content policy, no external resources and no ordinary host bridge; only that live view can decide its challenge. _Here only._
- The ordinary renderer may only report geometry, palette or cancel. Cancel is the default; expiry, teardown or a late decision fails closed. _Here only._
- A window holds at most eight pending confirmations per composer owner, and navigation never extends the five-minute expiry. _Here only._

Status: Built. Since: —. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

## Sandbox and confinement

### Process confinement

Every launch that could affect the machine goes through one shared confinement port, with no unconfined fallback. A missing backend fails closed.

- Git, terminals, test runners, extension executables, version reads and provider runtimes launch through the port, except where the runtime matrix names an unwrapped runtime.
- macOS uses deny-default sandbox profiles; Linux uses a namespace sandbox with a private `/tmp`, bound roots, `--unshare-all` and the network only when egress resolves to allow.
- Every confined Linux launch drops all capabilities and binds `/proc/sys` read-only; Full access's deny-only bind refuses a setuid sandbox helper as incompatible.
- Plan and Chat on Linux also load a seccomp filter that denies process creation, and fail closed as incompatible where it cannot be loaded.
- Path checks alone are never the boundary: confined reads open a handle and verify identity against what containment resolved.
- Escape probes are part of the test suite, and a confinement release gate is that they fail closed. The macOS CI job runs the darwin-gated Seatbelt probes, the Linux client-trust job proves under real Bubblewrap that a provider runtime cannot read the person's credentials, and the packaged Work confinement gate runs in its own macOS workflow on every push that touches the gate ([Security and authority, Escape probes run where the sandbox ships](../architecture.md#security-and-authority)).
- A Plan launch's temporary directory is made for that launch alone, removed when it exits or is refused, and never the shared temp root; a temp root inside the checkout is refused. _Here only._
- A terminal launch may read metadata, never data, on each exact ancestor of its own shell-state directory, so other threads' histories stay unreadable. _Here only._
- A macOS launch whose egress is allow may reach the system trust daemon and system keychain roots so TLS clients verify certificates; user keychains and offline launches stay denied. _Here only._
- An fx launch below Full access on macOS may read the one file `/Library/Keychains/System.keychain`, emitted after the Keychain and built-in secret-file denials so neither overrides it (a path the person protects still does); no write, no other keychain path, no other runtime, and `/var/db/SystemKey` stays denied (maintainer decision, 2026-10-31).

Status: Built. Since: —. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Version reads and discovery

A version read launches confined, with no root, no home, no network and one throwaway scratch directory.

- Its environment is an allowlist, so provider credentials and config-home variables are dropped, and its process group is killed when the read settles.
- A version read may exec and fork because launchers start the real program; the child inherits the profile and its read roots are the program's install tree, dropping any computed root that is the home folder or an ancestor. _Here only._
- Discovery re-allowances name exact literal nodes, use the weakest verb that works, and form a closed set that rides only the launch that needs it.
- Credential-reading status probes use the shared confinement builder with their actual account files, a private working directory and no network. Codex reads its auth/config files; Claude reads its status/config files and on macOS the login Keychain through its security service; Oh My Pi reads its isolated account directory with tools, skills, extensions and sessions disabled. Missing confinement refuses the probe; an incomplete discovery check reports unknown, never inferred sign-out.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Provider runtime confinement matrix

A provider runtime launch is wrapped when the process carries exactly one thread's authority. The matrix states the accepted exceptions instead of promising a boundary Octant does not draw.

- ACP agents and several other provider runtimes are wrapped in Plan and the prompting postures; an app-server runtime is wrapped too, with a lease keyed by root, mode and posture.
- One key provider's runtime is wrapped in Plan but keeps its own sandbox outside Plan; closing that gap is not an open goal.
- A runtime used only for a readiness probe is wrapped with its account-read boundary and starts no turn.
- At Full access Octant wraps no provider runtime, so only the operating system's own protections remain; Plan's read-only enforcement is the same at every level.
- A runtime that makes its own API call resolves provider-endpoints-only below Full access. On macOS and Linux, with Network limits on (they ship on), the runtime then runs on its own egress proxy, reaching its provider's endpoints, its Project's rules and the person's safe networks; OpenCode on Linux still materializes it as plain network allow.
- A new module may not launch a provider process without the shared confinement builder unless the matrix names it.
- Runtimes get no reusable cloud credential the person did not configure for that account; shared-config and default-chain cloud sign-in is refused.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Work shell at the shared access level

A Work thread launches exactly as a Code thread at the same level would, shell included. A driver that cannot do this reports it and keeps the withheld shell.

- It never runs commands under a weaker guard than the level names.
- Each provider runs a Work session as it runs a Code session: prompts to the person at Guarded, a reviewer at Reviewed, no prompts at Full access.
- Built: Claude Code, Codex, OpenCode, Pi and ACP agents start Work sessions with their shell and Git at the thread's level, and the Octant Harness has the shell port a Code harness thread has, under the same harness authority.
- Built: an ACP agent whose shell runs in-process, with no protocol request, cannot be asked per command and reports unsupported at Guarded and Reviewed; its profile says so, and no shipped profile does.

Status: Built. Since: —. Detail: [Architecture: Modes, Work shell and Git](../architecture.md#modes-chat-work-and-code) and [Security and authority, Sandbox](../architecture.md#security-and-authority).

### Provider capability matrix

Four key providers are first-class, each promised full native capability; every other provider has a documented degraded form or reports the capability unsupported and fails closed.

- Nothing in code makes providers match; the conformance harness checks that a driver reports its own capabilities honestly, not that drivers agree.
- A capability only some providers have still reaches the others through the published SDK and plugin seams; no seam is widened for one vendor.
- Outside harness endpoint drivers are held to the bundled endpoints' declared ceiling and reach Octant's tools only for models the host itself verified.
- A test pins the matrix against the drivers' static capability blocks and the catalog's per-mode columns.
- The remaining gaps of the key providers that are not yet fully native are not built yet. Mistral Vibe stays on the ACP bridge ([Provider runtimes](provider-runtimes.md#mistral-vibe-surface)): its usage and context over ACP are read for the verified 3.0.3 release after a signed-in probe; reading its compaction, review and question messages over ACP is allowed, and each needs its own signed-in runtime evidence first.

Status: Partly built. Since: —. Detail: [Architecture: Security and authority, Provider capability matrix ("degraded on")](../architecture.md#security-and-authority).

### App-server runtime confinement

A key provider's app-server runtime runs inside Octant's sandbox, not its own, in every posture below Full access.

- Each turn tells the runtime its sandbox is external, and both prompting postures run `untrusted`, so approving a command no longer lifts any sandbox.
- A command cannot read the home folder outside the root and the account home, and cannot write the account home's configuration, rules, skills, hooks, plugins or instructions.
- The launch environment carries no cloud profile, shared-config location or IAM key at any posture; a cloud sign-in that reads shared config or general-purpose keys is refused as incompatible.
- At Full access its commands reach the whole disk.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Provider runtime telemetry guards

Each non-essential channel of a key provider's runtime is kept off by its own switch on every launch, version read included, rather than by one blanket switch.

- Guarded channels are usage metrics, error reports, self-update, bug and feedback upload, the session survey, auto-memory, built-in agents and marketplace auto-install. Auto-memory alone has a setting per key provider account, off by default, that turns the provider's own memory on; telemetry and self-update stay off (maintainer request, 2026-11-12). Not built yet: today no such setting exists and auto-memory is always guarded.
- The query opens with no setting sources, plugins, skills, agents or MCP servers, and strict MCP configuration keeps the account's hosted connectors out.
- A host that exports its own non-essential-traffic or telemetry opt-out keeps it on every launch; the person's own opt-out always wins.
- Octant never reads, stores or injects the runtime's subscription tokens; a leftover helper-token envelope is deleted on upgrade.

Status: Partly built. Since: 2026-10-20. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Hosted artifact publishing

Publishing a Work or Code file to the provider's hosted service is a person-authorized external publish and an opt-in telemetry exception. It is off by default.

- The account must enable the choice from a window on this host, and each thread then chooses hosted artifacts instead of Canvas for itself; Canvas stays the default.
- Only such a thread's session outside Plan launches with the tool and with usage telemetry on; every other guard stays on and a host opt-out keeps all of them.
- Every publish asks below Full access, and an approved publish passes the gate again before the runtime continues; an answer is never reused for a later publish. At Full access nothing asks, publishing included; the path checks still refuse a file outside the Project.
- The file must be inside the bound Project and outside the login keychain folder; the host keeps the page link, title and a bounded snapshot of what the person approved.
- Plan never offers the tool, Chat never publishes, agent-run child sessions are never offered it, and paired devices cannot choose it.

Status: Built. Since: 2026-10-27. Detail: [Architecture: Security and authority, Hosted artifact publishing](../architecture.md#security-and-authority).

### Plan launch writes and sign-in

A confined Plan launch of one key provider's runtime writes only what its own session needs, so it cannot plant what a later session outside the sandbox would load.

- It writes only `sessions/`, its own session transcript and session folder, and the launch temporary directory; settings, hooks, MCP config, skills, plugins, agents, commands and any memory folder stay read-only.
- A subscription login kept in a file may also be written so the runtime can save a refreshed login (decided 2026-10-14); Plan can then replace the stored login.
- Subscription sign-in uses the unmodified CLI and a minimal grant (the keychain tool, fork, the login keychain file and two security lookups), and the profile refuses the keychain tool and file to every other process.
- A Code Plan turn on macOS may run a closed list of read-only commands whose network and writes stay with the runtime and the launch temporary directory; Linux Plan offers no Bash tool.
- Live check owed: no real turn has yet run under the narrower session grant.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Subscription sign-in inside the provider's terms

Octant would not mint, store or inject a provider setup or OAuth token. Subscription sign-in would stay wholly in the provider's own flow, launched from a provider-owned config directory.

- The rule is proposed, not accepted: it needs the provider's commercial terms or an explicit exception.
- Until then the rules in the architecture describe the build as it ships.

Status: Designed, not built. Since: —. Detail: [Architecture: Security and authority, Proposed, not accepted](../architecture.md#security-and-authority).

### Confined Git

Confined Git reads no configuration from the person's home and sees only the repository metadata it needs.

- Every launch sets the global config to `/dev/null` and disables system config; a commit takes its author from the host's recorded identity when the checkout names none.
- In a linked worktree Git may read only the metadata its own worktree names, and only when the reciprocal record (backlink and common directory) verifies through an identity-checked open.
- Write on that metadata is requested per launch and only by a non-Plan mutation launch; observation stays read-only for every caller.
- Mergeability runs against a quarantined object directory that reads the real objects through an alternate.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Sandbox](../architecture.md#security-and-authority).

### Host reads of a bound root

Every read, listing and search the host makes in a Code checkout or Work folder, and every Work write, runs one confinement sequence that survives an ancestor being swapped for a link.

- The sequence is lstat, link check, realpath, containment check, then an open that itself lands on the canonical path with the handle's device and inode verified.
- Linux requires the handle's kernel path to equal the canonical path; macOS opens with `O_NOFOLLOW_ANY`; other platforms refuse the open.
- Mirror writes, removals and re-imports, Canvas refresh and purge removals are held inside the destination root the same way, relative to folders held open from the root down.
- Work renames and deletes, and native harness writes and edits, act relative to a directory proved at its canonical path or through Work's confined write; a Work rename stays within its directory.
- A mirror or export folder is stored by its real path, and a root that no longer resolves to exactly that path is refused before anything is written or removed.
- An entry the host cannot open is not listed; hard links are not refused.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Host reads of a bound root](../architecture.md#security-and-authority).

### ACP client capabilities

ACP client file and terminal effects are executed by Octant inside the Code confinement, with bounded reads, writes, lifetimes and output.

- Execution posture is re-checked for every write and terminal creation, and the effects are refused in Plan mode.
- Provider terminal overlays cannot replace `TMPDIR`, `PATH` or `HOME`.
- The effects are journaled as app-managed tool events; the provider gains no second permission prompt or path outside the bound checkout.

Status: Built. Since: —. Detail: [Architecture: Security and authority, ACP client capabilities](../architecture.md#security-and-authority).

### ACP agents keep their credential-file block at Full access

At Full access an ACP agent launches outside Octant's sandbox with no OS-level denials of host credential files or extension folders, as the provider's own app does; Octant's own file tools still refuse protected paths and secrets are redacted from what it records.

- Credentials reach providers only through the credential broker; below Full access the sandbox also denies the credential files and unapproved extension folders.

Status: Built. Since: 2026-10-31. Detail: [Architecture: Security and authority, Approvals](../architecture.md#security-and-authority).

## Terminals, browsers and side surfaces

### Project terminals

A Project terminal is the person's shell, not an agent's. No provider, tool call, agent run or thread can address it, read its output or type into it.

- Only a person at a local window whose workspace holds the Work or Code Project may start, attach to, type into, resize or stop it; a paired device is refused.
- It runs at the Project's bound root through the same confinement as a thread terminal, with no credential references; Plan never applies.
- Its lifecycle is journaled on its own aggregate, its output is never journaled, and archiving the Project or relinking its root ends it as `authority-revoked`.
- A Work Project shows a terminal only after its Developer tools are turned on; Chat has none.
- A server Work Project exposes that person-operated SSH shell only in its bound local Settings row, with the real user/alias/folder and Full remote access visible before launch. Its window, Work enablement, exact binding/registry and Developer tools are rechecked before dispatch, after acquisition and for the session lifetime. Closing/hiding/switching/revocation cancels only its owned session, including pending acquisition; unknown replies never replay. Saved Work actions retain closed stdin and reject interactive writes even without a task context. Closing SSH does not prove remote programs ended; see [Server Projects](server-projects.md#threads).

Status: Built. Since: —. Detail: [Architecture: Security and authority, Project terminals](../architecture.md#security-and-authority).

### Terminal output paths

A Code thread terminal's output reaches a window by two paths so latency and durability do not share one setting.

- The record path writes to the evidence store and operation journal, coalesced to one write per 50 ms per terminal; the journal stays authoritative for reload and export.
- The live path is a read-only stream fed from the in-memory transcript, never journaled, with the same redaction and credential-prefix hold-back.
- The stream is authorized like a state read, re-proven every second, and ended when the window's capability is revoked or the shell stops.
- A minimised Terminal card is a second reader of the thread's one shell: it reads the shell's state and follows this stream within its limits, never attaches (a journaled operation), starts, writes to or resizes it, and stops the stream when the card goes away. A stream that ends or is refused is read again with a bounded back-off and a "Preview ended" when it gives up.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Terminal output paths](../architecture.md#security-and-authority).

### Project browsing contexts and profiles

A Project browser is the person's browser, never an agent's. A page is Private unless the person puts it in a profile.

- A Project context is isolated and ephemeral, registered under an owner id derived from the Project, so no thread surface can attach and no thread approval carries into it.
- Only the person at a local window may open, read or close it; a paired device is refused.
- Profile pages open only in the desktop app's native Browser, and an agent acts on an origin there only after a site approval naming the profile.
- Browser extensions install only at a local window, from an unpacked folder or from a copy of an extension the person picks in another Chromium-family browser on this Mac (never loaded in place; Manifest V2 and native-messaging extensions are listed as unsupported), start disabled, are enabled per profile, and never load into a Private page.
- Octant never opens another browser's profile in place.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Project browsing contexts](../architecture.md#security-and-authority) and [Browser profiles and extensions](../architecture.md#security-and-authority).

### Side Chat reads

A Side Chat may read its source thread's transcript, state and files but never inherits the source's Work or Code execution authority.

- It gains only list, search and read file tools, re-checked per call against the sidecar link and the window's right to open the source.
- The host tools an ordinary Chat is offered (side tasks, images, Canvas, past threads, Computer, the `#thread` dialogue and child agents) are withheld from it.
- Paths are relative and confined, results are bounded and recorded as external content, and it has no write, shell, Git or network tool.
- The `#thread` dialogue tool is refused for a sidecar in both directions.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Side Chat reads](../architecture.md#security-and-authority).

### Subagent authority

Child runs receive equal-or-narrower authority than the parent, clamped server-side.

- Code children require a verified isolated worktree receipt, and a managed child's Canvas tools are bound to the workspace and Project the host resolved, never a path the model names.
- A provider transport that cannot carry app-managed tools fails the start with a typed reason rather than dropping the tool.
- A source turn may send at most three thread messages, and a target turn started by that tool is never offered the tool. _Here only._
- Native subagents of the key providers are journaled and use the parent's approval path; a provider whose children would bypass it gets them only at Full access (built for Claude Code, for Codex, whose subagents' requests are answered through the parent's session, for OpenCode, whose delegated sessions are followed as child runs, and for Mistral Vibe at Full access only, because its subagents' requests name nothing Octant could show).

Status: Built. Since: —. Detail: [Architecture: Security and authority, Subagents](../architecture.md#security-and-authority).

### Canvas design images

A design frame never loads anything itself. The server resolves the images a design declares on every read.

- Resolution runs through the authorized Canvas read under the version's mode, Project and thread; Chat reaches only images generated in its own Project or thread, and Work and Code files pass the Work confinement sequence.
- Only sniffed raster images within per-image and per-design budgets are returned, and the renderer inlines them as `data:` images.
- The journal holds references only.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Canvas design images](../architecture.md#security-and-authority).

### Product feedback notes

A local person can point at an exposed Code or Work Browser element, inspect a bounded static crop and DOM/style context, then save a comment on that immutable capture.

- The host resolves the element under the original window/task/page authority. Renderer point/request correlation cannot supply authoritative element data or create a Browser grant.
- Pending notes can be amended, removed or excluded. Only an explicit person message consumes exact selected versions once; automatic continuations leave them pending. Saving or choosing notes never sends, queues, steers or approves work.
- Comments are person-authored; captured page material has outside-content provenance and taints the task. Missing or unsafe crops have explicit omissions and preserve the comment.
- Preview count, memory and lifetime are bounded across the host. Crop, outside-content marking and committed note are atomic; late revoked reads never publish fresh evidence.
- Local Browser capture/preview/note delivery is implemented; native Electron runtime acceptance remains required.

Status: Partly built. Detail: [Browser: Pointed-at product feedback](browser-agent-tool.md#pointed-at-product-feedback).

### Project actions

- Work and Code Projects save up to twelve named one-line commands and relative directories through the existing versioned events. Saving and launching remain local-person actions. Suggestions from root scripts and build targets are read-only until confirmed. A Work Project shows actions only when its Developer tools are on.
- The host previews the folder and branch. A Code thread defaults to its active checkout; the Project and approved extra folders stay explicit choices. Current binding, checkout, policy and command are rechecked before launch; Plan refuses.
- Each action gets a fresh tracked command process with output, exit status and cancellation, and never receives input through an existing busy shell. Its journaled identity precedes launch and cannot launch twice after restart.
- Results stay beside the task; Open terminal is an explicit Zen handoff. The window retains the run identity for reattachment; unknown replies and host restart never automatically repeat side effects.
- Code and Work server Projects save their own versioned actions and read suggestions only through the bounded remote file reader. Settings offers the existing Project-open transition before suggestions or runs outside this window's binding for that Project's mode; manual editing does not open or read the Project. Review shows the actual server/profile, canonical folder and task policy, explicitly without OS confinement. Server registration, action revision, directory identity, Git state and the real current task authority bind the placement; dedicated SSH runs never type into an existing terminal. Work's separately journaled local-person Developer tools choice is default-off and reveals actions plus the person's Project terminal in the window's bound Settings row, without changing task/credential authority or enabling a general tools pane. Hiding it retires only the person's SSH terminal; existing saved-action authority stays separate. Stop, transport loss and unconfirmed start preserve uncertainty and never replay; see [Server Projects](server-projects.md#threads).

Status: Built. Since: —. Detail: [Architecture: Security and authority, Project actions](../architecture.md#security-and-authority).

### Worktree setup

- A Code Project can mark one reviewed saved action as its optional preparation recipe. New managed worktrees record that recipe separately from Git readiness.
- The first task waits for setup or the person's explicit Skip. Setup uses admitted task access and the existing confined process lifecycle, with bounded output, a ten minute timeout, cancellation and no parent environment or secret copying. Plan refuses execution.
- Failure needs an explicit Retry or Skip. Host restart reconciles owned processes and exposes interruption without replay; uncertain cleanup refuses a new execution.
- Worktrees → Setup stays beside the task and can inspect its child checkouts. Existing worktrees keep their recorded recipe when Project actions change.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Worktree setup](../architecture.md#security-and-authority).

## Remote access and pairing

### Remote clients

Pairing issues a revocable device key, and the private listener is HTTPS on a LAN or private-mesh address with a host-owned identity. A remote principal never exceeds host, mode, provider, Project or thread authority.

- Remote requests are classified fail-closed by an admission policy and route classifier, cannot mint local receipts, and every remote mutation is journaled with its principal.
- The listener, pairing tickets and decisions, and the device inventory are administered only over the host's loopback administration channel; the private listener forwards none of those routes.
- The listener serves HTTPS only on one person-selected private address and explicit port; wildcard, public and ambiguous binds are rejected and certificate validation is never bypassed. _Here only._
- Enabling or retargeting the listener needs a local confirmation showing address, port, origin, certificate identity and exposure class. _Here only._
- Every state-changing remote request carries a device-key proof, replay nonce, CSRF value and exact-origin check; a cookie alone authorizes nothing. _Here only._
- Sessions have idle and absolute lifetimes and rotate; revoking a device drops its sessions and streams before the response completes. _Here only._
- Approvals are classified remote-approvable or local-host-required: pairing, listener and device management, root binding, extension trust and install, provider credentials and native-only actions are local-host-required, and an unknown action defaults to local-host-required or unavailable. _Here only._
- Remote clients never queue authority-bearing mutations offline; disconnected data is stale and read-only. _Here only._
- An owner device the person marked at a local window may raise a thread to Full access or start one there and answer profile site approvals. Its approval answers ride the five-minute unlock session by default, and per-answer unlock is a setting; other paired devices are unchanged (maintainer request, 2026-11-12). Not built yet: today an owner device raises a thread's level only through owner posture recovery, starts none at Full access, answers no site approval, and unlocks for each runtime approval answer ([Hub failover and owner devices](#hub-failover-and-owner-devices)).

Status: Partly built. Since: —. Detail: [Architecture: Security and authority, Remote clients](../architecture.md#security-and-authority).

### Remote reach into thread surfaces

Each thread surface (conversation, host browser, terminal output, simulator screenshot, canvas, file preview) names one action that reads it and a separate action that acts on it.

- A companion client derives each surface's reach (unavailable, read-only or interactive) from the host's catalog and never declares it. _Here only._
- Observing and in-page gestures (click, press, scroll) are remote-approvable; opening, navigating, typing, closing a tab and terminal writes are local-host-required, except that an owner device the person marked at a local window may navigate and type in the host's agent Browser and write to a thread terminal (maintainer request, 2026-11-12); not built yet: today they are local-host-required for every paired device. _Here only._
- A companion says when its picture is stale and offers only surfaces it can fill. _Here only._
- A paired client that is not an owner device may click, hover, scroll and press keys in the host's agent browser and list its tabs, but may not navigate, type, choose a list option, drag, upload, or open, switch or close a tab, and cannot take it to a new origin.

Status: Partly built. Since: —. Detail: [Architecture: Security and authority, Remote clients](../architecture.md#security-and-authority).

### Host identity on every connection

Every client verifies a signed host hello before it pairs or signs in, and refuses a host whose identity changed.

- Each hello request names a fresh client nonce; the hello carries the host key, its fingerprint, that nonce, an expiry and a signature, and the client checks all of them.
- The client records the proven fingerprint at pairing and requires the same host id and fingerprint on every later hello.
- A host built before these checks is refused as incompatible, and no refusal deletes the device key.
- First contact is trust on first use over TLS; a relay that passes the live hello through is closed only by certificate pinning.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Host identity on every connection](../architecture.md#security-and-authority).

### Listener certificate and client pinning

The listener serves a pasted certificate or a self-made one, and a client pins a self-made certificate by its public-key hash and never accepts it any other way.

- The self-made certificate uses its own P-256 key, not the host identity key; the key is owner-only, refused if another user can open it, and never appears in any response, log or journal.
- Renewal and a moved address never change the pin; disabling the listener keeps the key and complete data removal deletes it.
- A pinned origin passes only on the public-key hash; an unpinned origin passes only on platform validation, so it never accepts a self-made certificate.
- A client sends nothing unless every address the origin resolves to, and the connected peer, is private LAN or private mesh; a public answer refuses the whole name.
- Desktop and phone pin through a main-process or native channel that applies one shared rule; the desktop window never connects to a paired computer itself.
- Local CLI preparation signs the host, exact origin, old/new pins and fixed seven-day window with the old TLS key; trusted hello responses stage it durably in desktop main and phone secure storage. Explicit activation names the displayed new pin and restarts the listener without rotating host identity or revoking devices. Missed or expired windows require re-pairing, never an unknown-pin fallback.
- Cancellation withdraws only an unactivated stage; offline copies retain their original deadline. Activation refuses an enabled hub or joined spoke, preserving signed roster authority; explicit detach/rejoin is required. Roster trust migration is not built.
- Built for paired apps; roster trust migration remains unbuilt.

Status: Partly built. Since: —. Detail: [Architecture: Security and authority, Listener certificate](../architecture.md#security-and-authority).

### App pairing code and one-step pairing

A self-made listener pairs apps through a single-use, five-minute pairing code (shown as text and a QR code) that carries the listener origin and pin, not a browser link.

- A reader accepts only the exact text the builder makes, and refuses a newer code version, a damaged code or a non-private origin before sending anything.
- A browser pairs only with a pasted certificate, because it cannot check a self-made one.
- The one-line server install or start with `--pair` enables the listener and prints the code, polling claims until the ticket ends, using only the loopback administration calls the separate commands use.
- Approval needs a typed yes on the host after comparing device label, key fingerprint and comparison code.
- Key rotation for one-step pairing is planned (not built yet).

Status: Partly built. Since: —. Detail: [Architecture: Security and authority, Adding a computer in one step](../architecture.md#security-and-authority).

### Pairing abuse limits

Pairing is rate-limited and cleans up after itself.

- Hello and claim share ten requests per source per minute and sixty per host; a waiting window's status polls draw on a bucket of their own, so a flood from other addresses cannot starve it.
- A paired browser that is rate limited on reload is told to wait and resumes after the host's `Retry-After`; it is never shown as a failed pairing and keeps its device key.
- An approved device that never signs in is revoked as `pairing-abandoned` after its ticket would have expired (or 30 seconds after approval), and a device that has signed in is never removed this way.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Pairing budgets](../architecture.md#security-and-authority).

### Hosts never trust each other

Multi-host views merge read models client-side without transferring authority. Federation shares no credentials; the explicit [Shared sign-ins](hub-and-spokes.md#shared-sign-ins) API-key copy requires a fresh own-unlock on each host and a one-use receiving ticket. Subscription sign-ins refuse copying.

- Conflicting facts stay under their owning host; create and mutation routing name one destination and refuse when that host is not routable, and nothing queues offline work. An agent message to another hub member is not offline work: it waits on the sender until that member answers, and the receiver admits it afresh.
- An all-hosts list keeps every registered host; an unreachable host's cached items stay listed as stale and read-only.
- A host is shown as an environment under the person's name for it, and the host a window runs on is always "Local". _Here only._
- A row names its environment only when it is not this one; filtering and ordering by environment are client view state, and "All environments" includes hosts that connect later. _Here only._
- A hub acting on a spoke is a remote principal on that host, held to the grant that host's person chose, and can never approve, read credentials or loosen confinement there.
- The host's platform reaches only a window on the host itself; server-written copy says "this computer" and never follows the platform.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Hosts never trust each other](../architecture.md#security-and-authority).

### Dev server proxy grants

A paired device may ask for a grant to open one dev server from its own computer, under a proxy session that is separate from its product session.

- The proxy session lives in host memory, uses its own cookie and routes, and never reaches product routes; a host restart ends every proxy session.
- The host gathers every fact itself and rechecks the grant, device, thread and owning process before every relayed request, closing the grant on any lost check.
- Opening and closing are journaled with the grant, device, thread and port, never the endpoint; revoking the device, archiving the thread or disabling the listener closes the grant.
- Only the desktop app opens a page live, through a loopback forwarder that holds no key and relays only what the window signs.
- A paired device may stop only a server Octant owns, and a server outside active Code Project roots gets no row and no health probe.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Proxy sessions and server grants](../architecture.md#security-and-authority) and [Local servers and Running services](../architecture.md#security-and-authority).

### Agents on other machines reach Octant through an agent grant

An agent on another machine on the person's own network starts and follows work in Octant as its own principal, held to an agent grant the person creates. It is never listed as a paired device and never the person; product routes see it as a paired-device principal with the grant's own scope id, so every device clamp applies.

- A grant names its Projects, modes, highest access level (never Full access), tools, models, spend limits and expiry, inside every paired-device clamp; it is created or widened only from a local window or the loopback CLI, and a paired device may view and revoke it.
- The only route it reaches is `POST /api/agent-access/mcp` on its own listener surface, LAN-private and Tailscale sources only; the tools run in process under the principal.
- The recommended connection is a bridge, `octant agent mcp --connection`, with a key pair made on the agent's machine, signed requests and pinned TLS; a bearer agent key over the listener's Tailscale certificate is opt-in per grant.
- It never adds Projects or answers approvals; its prompts are outside content, so its threads are marked from the first turn; approvals wait in Needs you named after the agent, and every turn it sent says so under its prompt.
- Revocation voids its credentials at once and ends its sessions and in-flight requests; running turns continue unless the person also stops them.
- Reach stays on the person's own network (maintainer decision, 2026-11-11); hosted bots on the public internet are not supported, and nothing Octant operates is involved.

Status: Built. Since: 2026-11-11. Detail: [Agent access from other machines](agent-access.md) and [Architecture: Security and authority, Remote clients](../architecture.md#security-and-authority).

## Credentials and sign-in

### Provider keys on a host without the desktop app

A provider API key is entered only through the desktop renderer or the host-local `octant provider key` command, never through a browser.

- The key is read without echo from a terminal or from standard input with `--stdin`, and is never accepted as an argument, flag or environment variable.
- The command sends the key once over the loopback administration session; the server requires the bridge secret and a window capability and refuses any request with an `Origin` header.
- Storage uses the host credential store; a locked, absent or unreachable store fails as `credential-store-unavailable` with no fallback to a file, the data directory or an environment variable.
- `set` on an existing key needs `--replace`, a pool of several keys refuses a replace, and `remove` never widens authority.
- Each store, replace or remove is journaled before and after as a request and outcome with no key, length, prefix or hash, and unsettled requests are cleared at host start.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Provider keys on a host without the desktop app](../architecture.md#security-and-authority).

### Host-driven provider sign-in and cloud signing

The host, not a provider child and not the renderer, owns provider sign-in flows, and tokens stay in the credential broker.

- A local principal may start a PKCE or device-code sign-in; state and the code verifier are checked, the redirect is one-shot, and an unanswered consent times out.
- The journal records the terms acknowledgment and public sign-in state, never a token, authorization code or verifier; a remote principal cannot acknowledge terms, start the flow or refresh.
- A device-code sign-in on a host without the desktop app appears only in the terminal that asked for it, through loopback administration routes the private listener never forwards.
- The broker signs cloud requests itself with the platform's crypto and no cloud SDK, only within the scope stored at sign-in; portal sessions, refresh tokens and role secret keys never leave it.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Host-driven provider sign-in](../architecture.md#security-and-authority).

### One-use credential cards

A local person can enter a token or select a linked 1Password field reference in a conversation card for one fixed integration operation without sending it to the model or saving a sign-in.

- Integrations register fixed operations through the public host port. The host supplies their purpose, destination and action; an agent cannot choose an arbitrary URL or command.
- Submission consumes the request once, checks current thread and window authority, and sends no response content or raw error to the agent.
- The compact card shows the destination and one-use scope, with masked input, an explicit reveal control and right-aligned actions. Accepted submissions stay disabled until the host settles them.
- Expiry, decline, cancellation and restart prevent future use. The host cannot recall a token already transmitted.
- Card consumers are the read-only Linear account check and a fixed Azure Resource Manager subscriptions GET in Code. GET has no body; the complete URL appears in consent and redirects are refused. Status-only operations cancel the response body rather than parsing large lists; JSON checks retain their bounded parsing. Linked-store selection resolves only the submitted reference, refuses a changed store link, and retains no reusable credential slot. Azure CLI credentials and administrator authentication remain separate and unavailable through cards.
- Agents reach cards and saved commands through one Code tool, `octant_credential` (`help`, `list`, `request`, `run-saved`). Each operation keeps its own authority, approval, Plan and local-window rules; `list` returns names and descriptions only; the tool is offered only when a registered operation or a command saved for the Project exists when the turn's tools are composed. It is not a general command runner.
- Separate named command bindings are built for normal local Code tasks: Settings fixes the Project, recipient/CLI digests, arguments, directory, account and immutable references; the person approves every run through the same service used by the provider tool. Ask for approvals and Auto-accept edits retain ordinary command approvals/Shield and confine the recipient while the credential tool authenticates outside. Plan refuses; Full access remains unrestricted.
- Command approval IDs are one-use and never restored. Preparation replay is memory-scoped; a newly prepared request always needs fresh approval and cannot establish that an earlier process stopped. Below Full access the recipient's OS and per-command network rules remain enforced; vendor output concealment is not protection from disclosure to allowed destinations. See the owning linked-store rules for custody, invalidation and cancellation limits.

Status: Partly built. Since: 2026-11-03. Detail: [Architecture: Security and authority](../architecture.md#security-and-authority).

### Account usage reads

Plan limits for providers that report them only from an account endpoint are read with the sign-in the provider's own CLI saved.

- The host reads the saved key only for an enabled instance of that provider, sends it nowhere else, follows no redirect, and never writes, copies or stores it.
- Only a refresh the person asks for waits on the endpoint; every other caller gets the last reading and at most one background read starts per five minutes.
- Failures carry a fixed message, a changed response shape keeps the last reading, and the key stays out of logs, journal, snapshots and errors.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Account usage endpoints](../architecture.md#security-and-authority).

### Artifact replica membership

Each artifact replica entry is signed by a per-host device signing key, and membership is derived from signed approvals chained back to a founder the host pinned.

- The signing key lives in a credential namespace provider credentials cannot reach, and is not a paired client's device key; an entry whose signature or key does not verify is journaled as unreadable.
- A new computer joins by a signed request that a member in good standing approves by name; only a computer that brought another in can revoke it, and a member leaves by signing a left record.
- Store setup, joining, revoking and leaving happen on the host, never from a paired phone; store credentials live in the host credential store.
- A bucket endpoint must be `https` with no path, query or user info and must not be link-local; loopback and private ranges stay allowed.
- The storage provider can read synced content, and Settings and the guide say so before sync is turned on; a replica import appends versions only and delegates no host authority.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Artifact replica membership](../architecture.md#security-and-authority).

## Updates and development

### Signed update feeds

The desktop updater verifies a feed's Ed25519 signature against the compiled-in keys of the ring the signed release names, before any other field is believed.

- Stable trusts only the stable key; preview and candidate trust the preview key and the stable key, so unreviewed preview builds cannot sign a stable feed.
- The release wizard mints a ring's key only when the app ships none for it, because replacing a deployed key strands every install that trusts it.
- Each ring's feed is a fixed mailbox release on the forge; signature and artifact hash checks never depend on the host that served the bytes.
- Update responses are streamed under size and time bounds. Redirects are manually bounded, stay HTTPS, and may widen from an explicitly configured or signed origin only to a connect-time-pinned globally reachable address.
- Whoever can write feed files can withhold a ring's updates, never install something no trusted key signed.
- A Linux AppImage update verifies signature and hash before use, replaces the image atomically, and fails closed with the reason shown in Settings.

Status: Built. Since: —. Detail: [Architecture: Security and authority, Update feed signing keys are per ring](../architecture.md#security-and-authority).

### What's New after an update

Release notes show once after an update the person chose finishes applying, and only on the desktop.

- Settings > General > Updates links the notes for the running build. _Here only._
- First-run setup never shows release notes, and opening What's New is never counted or reported. _Here only._
- When the notes are due, the full sidebar shows a What's new card at its foot (version, the notes' first line, the next paragraph, and a button that opens the notes); the collapsed icon rail neither draws nor acknowledges it. A release may bundle one to five announcements (`whats-new-announcement.json`: version 2 is `{ schemaVersion, announcements: [...] }`, version 1 is one entry and stays valid; strict, at most 16,384 characters, each entry within its own field limits, with optional pictures beside it whose names cannot leave the folder); they show in a row, one at a time with Back, Next and an "n of m" position, as one dialog instead of the card. A file invalid as a whole shows nothing; an invalid entry in a valid version 2 file is skipped and the first five valid ones show. Dismissing the card, closing the dialog at any step or finishing it, or opening the notes acknowledges the update once, for the whole set. Pictures are read only for entries that will be shown and cross to the renderer together. Nothing here contacts a network, and a browser or remote client shows neither. _Here only._

Status: Built. Since: —. Detail: [Architecture: Current Release Boundary](../architecture.md#current-release-boundary).

### Package dependency direction

Dependencies point inward: no package imports an app, and `contracts` imports nothing first-party.

- Contracts hold schemas only; domain holds pure policy; the host runtime is shared by desktop and CLI and owns the credential broker and bridge secret.
- The web renderer, mobile client and server depend on packages, never on each other's internals.

Status: Built. Since: —. Detail: [Architecture: Package map](../architecture.md#package-map).

### Development loop and Linux hosts

Development and QA run against the canonical host and never create an implicit profile.

- `octant web --dev` swaps only the renderer; destructive tests use an explicit `OCTANT_DATA_DIR`.
- The server composition root has no late-assigned values; forward references are capped by `bun run wiring:check`, which can fall but never rise.
- `bun run verify` is the full local check, and `git diff --check` runs before every pull request.
- A Linux host requires the namespace sandbox tool and Git 2.36 or newer, or Work and Code fail closed; without an unlocked secret service the host runs but reports its secret store unavailable.
- The Linux AppImage never adds `--no-sandbox` and lets the browser engine refuse when the host cannot establish its sandbox; Windows stays out.

Status: Built. Since: —. Detail: [Architecture: Development loop](../architecture.md#development-loop).

## Design system

### Visual character, voice and colour

Octant looks like a calm, colourful workbench. Colour is the default (2026-11-02) and grey is a choice called Mono. Every surface uses the same words, face and hierarchy.

- Colour is the default and applies to everyone: a blue accent, amber warning, red failure, green success, coloured count tiles, board marks and connector marks. Colour never stands alone: a state also has a shape or a word. The Mono style draws the grey look; plain empty, loading and informational messages stay neutral in both.
- The four count destinations keep one mark each wherever they show: icons in the rail, tiles when a wide window has no rail, and plain rows at 960px and narrower, the rail's own breakpoint. Icons in the rail and the rows stay in the sidebar ink in every style; only a tile's face carries its hue. The title band and the rail are both 44px.
- Hierarchy comes from size, then weight, then colour. Text is sentence case, nothing is uppercase, and only the large title is bold. A title is never the size and the weight of the text it heads: a dialog's title is 17px at weight 600, and a reply's markdown headings are 20/17/15/14 at weight 600 with more room above than below. Names in navigation are the interface size at regular weight, a group label is a quiet 12px caption, and a thread's activity line is the text's size in the muted ink.
- Depth is one material in five levels, each a step lighter than the one under it, and every surface takes a fill, a rim that is brighter along its top edge and a shadow that seats it: the ground (the window frame, with the sidebar's rows on it and no panel), a pane (the thread stage, each dock tool tile, the bottom panel and the dock's overview: square, touching each other and the window's edges, with one 1px line between two neighbours and none of the rim or seat shadow), a card on a pane (a tool card, an approval card, a user bubble, a Settings group), a control (a filled button, a chip, the selected row, a switch's thumb and the composer's box, raised; a well cut in for a switch's track or a command block) and a floating surface (a menu, popover, hover card, toast, dialog and the Settings sheet, frosted over page content). The window is a frame and a grid of panes rather than one sheet or loose panels: panes in a grid that is dragged, aligned and resized share edges, and a corner and a gap on each made the grid read as loose cards. A divider's hit area is 8px, centred on the shared line, and a tile is square and flat at every width: a window of 960px or less shows the dock as a floating sheet (12px corner) holding one tool, and that tool's tile has no corner, rim, seat shadow or gap there either. Glass tints the panes instead of blurring the desktop, which a packaged window's native material does not allow. Increased contrast drops the gradients and sheens and keeps the rims; ghost buttons and plain rows stay flat until pointed at. What sits on a floating surface takes its fills from that surface (maintainer request, 2026-11-12).
- Everything that opens over the window arrives and leaves one way, declared once: it fades in over 150ms and out over 100ms, a popup and a dialog settle from 98%, and Settings' sheet rises 8px. Nothing behind an overlay is laid out again. Reduced motion, from the system or from the setting, removes the transition. A dialog a feature renders only while open is held through its exit with the last content it showed (`OctantDialogPresence`): every confirmation, the command palette, the Code file search, the Navigator, the narrow dock, first run and the other dialogs mounted on demand. A dialog or Settings' sheet that is leaving takes no press and no key, focus returns to the opener as the exit starts, and focus the person has moved since is left alone. A dialog with an `open` of its own keeps that apart from its words; one whose words come from the state closing clears is rendered only while that state exists. A dialog removed together with its owner still leaves at once, and so does one closed in a window nobody can see.
- Edges and gaps agree across surfaces: the title band's icon buttons are 28px and 4px apart with an 8px inset at both ends, a tile bar ends on that inset with 24px controls and one 14px glyph, the icon rail's first face is centred on the title rail, a dock never clips at its minimum width, a card's inset is exactly 16px, and a row's height is a whole number of pixels (maintainer request, 2026-11-12).
- A list a person picks from draws one row from shared tokens: 28px for one line, its words 8px in, the rows 4px in from the popup's edge. Menus, context menus, selects, comboboxes, the command palette, typeaheads and picker rows all take it; a described row grows to two lines.
- There is one scrollbar, declared once: a thin thumb and no painted track, in a pane, a menu, a popup and a sheet alike. A feature may reserve its strip or hide it on a named sideways strip, and never recolours or widens it.
- The code editor and the terminal draw their own scrollbars to the measure of every other pane's: a thin thumb with round ends in the same theme role, no painted track, no shadow at the scroll edge, and no strip beside a comparison. Their thumb cannot widen under the pointer and changes colour there instead, and the terminal's hides at rest even where the system keeps scrollbars on screen.
- Text uses three greys only: primary, secondary and muted. An accent swatch is the person's choice and never recolours status; Mono is a swatch that sets the Mono style. Swatches cover chromatic hues and neutrals (Steel, Slate, Silver, Graphite, Carbon, White); a swatch that cannot be seen on one mode's page writes a mode-only override with a silver for that mode.
- Counts and token figures use English separators whatever the system locale; dates and times follow the locale.
- Copy about where something runs says "this Mac" only when the host reports macOS, and uses neutral words ("this computer", "credential store") otherwise. The window's own platform never decides it.
- The phone app reads as a native app, not a web page: a bottom tab bar for its top places, large titles on tab roots, a centred nav bar on pushed screens, inset grouped lists, the system segmented control and sheets with a grabber. It uses the product radius scale with one 20px sheet, three count tiles that take the desktop tiles' hues and marks, and the transcript recipe: bare prose replies and a control-fill bubble for the person's message.

Status: Built. Since: —. Detail: [DESIGN.md: Product character](../../DESIGN.md#product-character), [Voice](../../DESIGN.md#voice), [Motion and interaction](../../DESIGN.md#motion-and-interaction), [shadcn/Base recipes](../../DESIGN.md#shadcnbase-recipes), [Accessibility and reliability](../../DESIGN.md#accessibility-and-reliability), and the [mobile design system](../../apps/mobile/design-system/README.md).

### One theme authority and shared controls

There is one runtime theme authority and one owned control layer. Feature code places and sizes shared controls but never repaints them.

- Feature stylesheets add no raw colour, radius, shadow or control recipe. A repository checker enforces this and ratchets existing violations against a baseline.
- Shared recipes space in pixels on the 4px scale: the theme sets Tailwind's spacing step to `--spacing: 4px`, so `px-2` is 8px at every interface size, while type and control heights still follow the interface size. A recipe names a step on the scale and never a half step, and a field, select and combobox share the default button's 28px height. A contract test scans every class string. Detail: [DESIGN.md: Spacing, shapes, and depth](../../DESIGN.md#spacing-shapes-and-depth).
- Every in-page menu is one row: 28px (44px with a second line), a 16px icon column and 8px gap, the Menu option type, group labels in the Navigation group label role, and one separator as wide as the rows. A menu where any row has an icon reserves the column for all of them. Natively drawn desktop menus are unchanged. Detail: [DESIGN.md: Spacing, shapes, and depth](../../DESIGN.md#spacing-shapes-and-depth).
- Feature code composes controls only through the Octant adapters; direct imports of the recipe or primitive libraries are blocked by a repository check.
- There is one interaction primitive backend. A recipe style's own palette is never adopted; the `--octant-*` roles stay the theme source. A style variant for a primitive state is checked against the attribute the primitive actually writes. _Here only._
- Desktop context and dropdown menus use native OS menus through one shared adapter. Browser clients keep accessible renderer menus.
- Removing an existing repaint is a separate batch per pull request with before and after screenshots, and the maintainer approves the visual change (burn-down still in progress).
- A development-only component gallery draws every shared adapter under the shipped stylesheets, and a new adapter must appear in it (a test enforces this).

Status: Built. Since: —. Detail: [DESIGN.md: Source of truth and CSS layers](../../DESIGN.md#source-of-truth-and-css-layers), [Component gallery](../../DESIGN.md#component-gallery) and [Current exceptions and known migration edges](../../DESIGN.md#current-exceptions-and-known-migration-edges).

### Portable design tokens

The design system can be reused outside the app from one generated token set, never from values copied by hand.

- `packages/theme/tokens/tokens.css` and `tokens.json` are generated from the renderer's stylesheets and checked against the theme package's colour defaults; they keep the app's own names, and are never edited.
- A repository check fails when the generated files are stale and names the command that regenerates them.
- The minimum recipes (`recipes.css`) are built from the tokens only: no colour literal, a few tints mixed from exported colour tokens, and a test refuses a raw colour or an undefined token there.

Status: Built. Since: 2026-11-12. Detail: [Design tokens and the app feel](design-tokens.md).

### Page shell and Settings organisation

Every list, board, reader and preference page is one `Surface`. Settings groups its pages by what they change.

- A setting lives on the page of the thing it changes, and a moved setting keeps answering links to its old page.
- In a wide window Settings is a sheet over the app, which stays mounted and drawn behind a light scrim, so a change to how the app looks is seen as it is made. It closes from its own corner, with Escape, or with a press outside it, and it leaves the way it arrived. In a narrow window it covers the window and offers Back to app.
- A page names its scope once, under its title. A page header holds one creation action and Back; filters sit in the toolbar.
- A destination opens on one toolbar row at the Settings page title's size, pinned while the body scrolls, with an icon Back at the leading edge that does not move on press. It carries no description; its one line of detail is only a fact that changes and that a person needs. An empty page is the empty state alone, centred, with search and filters back once there is something to search.
- A destination page and Settings show their own outline while they load (a title bar and rows; a rail and a page), not a line of text, so nothing changes place when they arrive. The words stay for assistive technology, and the skeleton's sheen stops under reduced motion.
- Background refresh preserves loaded controls and active drafts; status slots are bounded so a changed status never pushes the form below it.

Status: Built. Since: —. Detail: [DESIGN.md: Page shell](../../DESIGN.md#page-shell) and [Settings stability](../../DESIGN.md#settings-stability).

### User profile

The user profile (optional name, email, accent and avatar) authenticates and authorizes nothing.

- An avatar image is inlined in settings, downscaled to 128 px and at most 96 KB encoded. _Here only._
- The avatar lookup by email hash is the one part that leaves the Mac. It runs only on a button press, says it sends a hash, and copies the result so the host never contacts the service again by itself. _Here only._

Status: Built. Since: —. Detail: [DESIGN.md: Optional Settings details](../../DESIGN.md#optional-settings-details).

### Approvals and confirmations

Approval and confirmation dialogs default to the safe answer, and the host decides whether an action may proceed, never the card.

- The safe action receives initial focus. Escape, Cancel and backdrop dismissal never change data, and closing restores focus to the opener.
- Destructive actions opt into the danger treatment explicitly; ordinary confirmations use the standard action treatment.
- An extension tool request names the plugin, its server and the tool. "Always allow in this Project" appears only when the host marks the call rememberable and the window is local.
- A browser request from a CLI in a Code thread's terminal says a program in the terminal asked, not the thread's agent.
- Native Code approvals are isolated host documents. Shared renderer components never grant Code authority, and Enter never implicitly grants access.

Status: Built. Since: —. Detail: [DESIGN.md: Confirmation and dialog behavior](../../DESIGN.md#confirmation-and-dialog-behavior).

### Accessibility baseline

Accessibility is a baseline for every changed surface, not a late pass.

- Text contrast targets 4.5:1 (3:1 for large text and non-text marks). State always uses text, shape or label in addition to colour.
- Keyboard focus draws one neutral inset edge on `:focus-visible` only. Feature CSS never suppresses, recolours or doubles it.
- No surface is a keyboard trap. The terminal sends every key to its shell and has a documented chord to move focus out.
- Theme, typography, density, translucency, contrast and reduced-motion settings persist through the server-authoritative journal; renderer state is presentation only.
- A refused server command is never a silent no-op, and loading, stale, denied, empty and error states keep stable geometry.

Status: Built. Since: —. Detail: [DESIGN.md: Accessibility and reliability](../../DESIGN.md#accessibility-and-reliability).

### Guarded quit

Quitting the desktop app is guarded so that open provider sessions are never dropped silently.

- Ordinary Quit and Fully quit share one shutdown that confirms when provider sessions remain open or the desktop cannot tell what the host is running.
- When a window can show the quit notice, the quit keyboard shortcut needs a second press within 1.5 seconds; that double-press guard is a setting (maintainer request, 2026-11-12), not built yet: today it is always on. With no window able to show it, the first press enters guarded shutdown. Pointer quits, OS shutdown and updater restarts stay immediate.
- Once confirmed, quitting never waits on a person; a fixed deadline ends the app.

Status: Partly built. Since: —. Detail: [DESIGN.md: Accessibility and reliability](../../DESIGN.md#accessibility-and-reliability).

### Window defaults, ground and drafts

A new window, its background and its drafts behave predictably.

- Without a saved show or hide choice, a wide window starts with the right dock open and a narrow window starts with it closed, subject to the active pane having an eligible dock subject. The bottom panel starts closed. An explicit show or hide is restored per window later.
- A photo ground comes from the host's background image library (8 MiB, 4096x4096, PNG, JPEG or WebP). The host refuses to delete a photo while it is showing, and ground settings are kept across kinds. _Here only._
- While an everywhere background covers the sidebar, the sidebar's own background is not drawn and its controls are disabled with a note; saved sidebar values are kept. _Here only._
- A new-task composer keeps its identity while its Project changes. A refused binding keeps the prior authorized Project and the draft.
- If first-turn startup fails after the task opens, the provisional prompt is withdrawn and its text returns to the composer with the refusal reason. _Here only._

Status: Built. Since: —. Detail: [DESIGN.md: Shell and layout](../../DESIGN.md#shell-and-layout), [Shapes and depth](../../DESIGN.md#shapes-and-depth), [Welcome and composer](../../DESIGN.md#welcome-and-composer) and [Draft continuity and composer notices](../../DESIGN.md#draft-continuity-and-composer-notices).

### Usage reading and provider marks

The Usage page reports what was measured and shows each provider with a bundled mark.

- Local provider history and Octant records are separate sources; their totals are never added.
- Unknown prices and missing quota measurements are unavailable, never zero. A period change cancels the previous read and cannot render a late result.
- Provider logos are locally bundled and licensed, never fetched at runtime, and never drawn approximately. Unknown providers get a truthful fallback.
- Interface icons use four sizes (12, 14, 16, 20) and one stroke (1.5), set once for the app; a contract test refuses any other.

Status: Built. Since: —. Detail: [DESIGN.md: Usage surface ownership](../../DESIGN.md#usage-surface-ownership) and [Iconography and provider marks](../../DESIGN.md#iconography-and-provider-marks).

### Reply detail

Reply detail chooses how much of a turn's thinking and tool calls the transcript shows open: Low, Medium or High. The Appearance setting is the default every thread starts at, Low unless changed; a thread may set its own level, which stays with it.

- Low keeps thinking shut and folds a settled turn's tool calls behind "N tool calls"; Medium keeps thinking shut with its first line beside the name and leaves the tool calls listed; High opens thinking, the tool calls and each row's recorded summary, including while a reply streams.
- It is presentation only: it never changes what a model is asked or what a client fetches, shows nothing the transcript does not already hold, and leaves Stream replies in charge of the partial answer.
- A thread's own level wins over the default, survives a reload, and is drawn alike by every window, the phone and a paired browser; changing the default never moves a thread that chose. Use default returns a thread to following the default.
- The default and the threads' own levels live in the host's shell settings, written only through the shell route from a window on the host, kept out of thread journals and host export. Settings saved without either field read as Low with no thread levels.
- Purging a Chat, Work or Code thread, alone, with its Project or by retention, removes its own level in the same pass; the 500-entry bound (oldest dropped first) stays as a backstop.
- Another open window picks up a changed level when it regains focus, re-reading shell settings behind any edit still being saved.
- The phone and a paired browser read only these two fields through `GET /api/reply-detail`, a read-only, authenticated route classified `settings.read-non-secret`; neither can change a level, and both draw Low until the host answers.
- The thread menu, the palette and the remappable `reply-detail-cycle` chord (Mod+Shift+D by default, chosen clear of every other default, the desktop menus and system chords) change the thread in front, and only one on screen: behind Settings, Review or another covering page the chord is left to the browser and the palette offers only the default's commands. The chord announces the new level in a status toast. Keybinding overrides saved before the action existed read unchanged.
- A disclosure opened or closed by hand keeps that state while its turn stays mounted and the thread's level is unchanged; a change of that level resets every disclosure to the new level.
- The thinking preview is hidden from assistive technology so it is never read twice, and every disclosure keeps `open` and `aria-expanded` in step.

Status: Built. Since: —. Detail: [DESIGN.md: Transcript](../../DESIGN.md#transcript).

## Workspace

### Responsive in-thread Find

Find keeps viewport virtualization. A first nonempty query indexes the actual
rendered text in cancellable batches, retains no off-window DOM, and reuses
its text index for later queries. Only the current match is additionally mounted
for navigation. Closing Find releases the index; changed rows refresh in rotating
batches without starving later rows during streaming.

Status: Built. Since: 2026-11-10. Detail: [Find in a thread](workspace.md#find-in-a-thread-and-a-new-thread-from-a-selection).

### Mode-first navigation and Projects

The window is mode-first: a persistent sidebar, a central workspace and an optional right dock. Mode changes alter content, authority and density, never the navigation grammar.

- Home closes any reader and puts the active pane back on its mode's start screen.
- Each active thread appears once in the Project tree, under its Project or under No Project. No Project creates no Project and grants no filesystem authority.
- Sidebar reads are projection-only. Inactive modes and hidden windows pause their refreshes, and the sidebar timer never walks the checkout tree.

Status: Built. Since: —. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Developer tools switch on Work Projects

A Work Project's Developer tools switch is presentation, off by default and set only by a person. A Work thread has the same shell, Git and tools as a Code thread at the same level either way.

- The switch changes what the Project shows, not what its threads may do. Code Projects have no such row.
- Today it shows the Project terminal and Project actions; Work has no Git, pull request or worktree panels yet for it to show.

Status: Built. Since: —. Detail: [Workspace: Navigation and Projects](workspace.md#navigation-and-projects).

### Sidebar status and next waiting thread

The sidebar speaks about what a thread is doing now with one fixed vocabulary, and a shortcut jumps to the next thread that needs the person.

- The vocabulary is Working, Needs attention, Snooze ended and New activity, owned by the domain package. Nothing to report is no status, and a failure is never inferred from silence.
- The jump goes by strength of reason (approval, then question, then unreviewed finished turn), wraps, and adds no host read.

Status: Built. Since: —. Detail: [Workspace: Sidebar thread status](workspace.md#sidebar-thread-status) and [Jump to the next waiting thread](workspace.md#jump-to-the-next-waiting-thread).

### Resuming after a host restart

A turn cut off by a host restart continues by itself unless its thread is held ([Continuing a turn a restart cut off](#continuing-a-turn-a-restart-cut-off)); a held thread shows a notice with an explicit Resume (maintainer request, 2026-11-12).

- Resume queues one host-written continuation in the same thread, after re-checking window, provider and Project authority.
- A second window, repeated click or lost response cannot queue a second continuation.
- Resume is not an exact replay: a tool may have taken effect before the crash, and Octant promises neither undo nor deduplication.

Status: Partly built. Since: 2026-10-28. Detail: [Workspace: Continuing after a restart](workspace.md#continuing-after-a-restart).

### Putting away and snoozing threads

A thread can be put away (completed, manual only) or snoozed. Both are overlays on the thread, not lifecycle values.

- Put away is refused while a turn runs or the thread waits on the person. A host sweep archives only put-away threads after a configurable delay (default seven days).
- A running thread may be snoozed, a thread waiting on the person may not, and the wake time must be ahead. Putting a thread away drops its pin and any snooze. _Here only._
- A snooze wakes early when the agent needs the person. A person sending a turn reopens the thread.
- Answerable pending questions have a separate attention deferral in Home, Inbox and Review. The condensed row remains discoverable, can return early, and never changes the thread, draft, answer or execution authority. Approvals and find-only questions are excluded.

Status: Built. Since: —. Detail: [Workspace: Thread visibility and completion](workspace.md#thread-visibility-and-completion).

### Panes, tabs and previews

The central workspace is one recursive split tree with one surface per leaf, and all layout operations are server-authoritative.

- One visible tree belongs to one authority context. A cross-Project, cross-mode or cross-host placement is refused or offered in a new window.
- Kept content references and order persist locally per endpoint/window/pane and exact authority context; temporary thread previews are omitted. Restoration reuses the authoritative selected surface and performs no open or side effect; every later activation is authorized by the host. Tabs add no persisted layout or authority. Dropping a sidebar thread on a composer attaches it as bounded context; nothing is sent and the source is not moved.
- Layout persists per client window, mode and Project context and restores after restart. A mode preset applies only when no saved layout exists or the person restores it. _Here only._
- File and artifact previews are host-authorized and read-only. The renderer never receives a host path, every open is re-authorized, scripts, remote resources, macros and formulas are disabled, and a missing source restores as a placeholder, never another file. _Here only._

Status: Built. Since: —. Detail: [Workspace: Panes and content navigation](workspace.md#panes-and-content-navigation).

### Thread info

What is true about a thread but is not part of its conversation has one home, a panel opened from the row under the follow-up composer.

- Its rows are the access level in force with Access details, Reply detail, document delivery, Provider tools, Credential commands, Provider cloud sessions and Continue elsewhere, each only where it applies. The row under the composer's card keeps only what changes from one message to the next. Nothing else about the thread is drawn on the thread page outside the transcript and the composer.
- Rows stay mounted while the panel is closed, and a row that waits for the person marks the panel's button.
- The button is Thread info: Work's Project control where the Project is named, otherwise a small icon after it. The row under the composer's card is one row, also in a split pane, and two at a phone's width, and the panel opens from its leading edge and is never wider than that row.
- The panel is a menu drawn like the line's other menus: full-width 30px rows, each its name leading with its value and arrow trailing, headed by the level in force.

Status: Built. Since: —. Detail: [Workspace: Thread info](workspace.md#thread-info).

### Right dock and thread tools

The dock is contextual: it follows the active pane's thread and Project, and never shows another pane's content.

- Each thread keeps its own open tools and selected tool; a tool with no valid subject shows an explicit unavailable state. _Here only._
- The dock may show several open tools together as tiles, each live, beside a thread: at most two columns of three tiles, one Browser tile whose page is the chosen Browser tab, the focused tile's tab always selected, a tile that cannot be described for the active pane saying so in its tile, and the narrow modal drawing only the focused tile. A layout is window-local presentation, never reaches the bottom panel, and moves nothing about what an agent may do. Tile changes apply to the tools on screen, a column is never narrower than 280px while there is room, and two columns let the dock take what the thread's own minimum leaves. A tile clips its tool, and the Browser returns to the page last shown.
- With two or more tiles each has one bar, the tool's own header (the Browser's bar is its row of pages), 32px high everywhere; the dock has no strip: a tool that is open but not shown is marked on its button in the title band's tool row. A tile's bar ends with an Arrange menu (Move left, Move right, Move up, Move down where the caps allow, Show alone, Hide from view) and Close, which closes the tool as pressing its button again does. A move keeps every tool mounted. A divider is a hairline, in the quiet strong-divider role while hovered or held, with no accent line after a click. A page stacked four bars and named the tool three times.
- A tool's button in the title band shows its tool with the focused tile when pressed, offers Show below, Show alone, Hide from view, the possible moves, New Terminal or New Browser page, and Close on its context menu (right click, menu key, Shift+F10), and is the drag source for the dock's drop zones. The dock's own tab strip, Add tool, Show another tool and quick tools are gone; the bottom panel keeps its strip and Add tool.
- A row of tool buttons in the title band, before the bottom-panel and dock toggles (961px and wider), opens each tool as a tile beside the focused one and closes it on the next press; More tools lists the rest and the pull requests the thread is about. At 960px and under the same row stands in the drawer's header and a press replaces the tool shown. Detail: [Workspace](workspace.md).
- A thread's Browser and Terminal can be minimised into small live cards on a shelf at the foot of the dock, replacing the floating Browser preview, which covered the thread's text and could not show a shell. A tool is minimised whole (one Browser card, one Terminal card), a minimised tab is open but in no tile and never selected, and the state is window-local presentation that never reaches the bottom panel. A card reads only what the tool itself could show this window, never starts a process, writes to the journal or sends input, and is never what "the Browser is in sight" means. Minimising is the tile's Arrange menu item **Minimise to card** or the same item on the Browser and Terminal buttons' context menus in the title band's tool row, or pressing a pressed Browser or Terminal button, never a tile-bar button; a minimised tool's button is not pressed, shows the open dot and reads "Minimised to a card", and pressing it shows the tool. Show on a card returns the tool as a tile of its own, to its remembered place while that place exists and else as the last tile, never over a shown tool's tile. Its X hides the card and closes or stops nothing, and the tool's button then reads open but not shown; closing a tool stays the tile bar's close and **Close** on its button's menu. A new live session leaves a Browser the person minimised minimised. The agent's live Browser is a card while out of sight, and the closed dock's toggle carries one quiet dot saying so.
- Opening a dock tool leaves the bottom panel open; a tool the panel already shows is the only one that leaves it. A tool is on screen in one region at a time.
- A new Code task's pane starts with the dock closed until the person opens it there; that choice belongs to the draft and is never saved as the window's.
- A saved layout never starts a new shell. Restoring a Terminal tab may reattach to an existing process; otherwise it offers Start terminal.
- Git History stays read-only in every posture, Plan included. Browsing or refreshing it never fetches, checks out, stages, reverts or resets. _Here only._
- Current Code Review selects exact staged or unstaged text hunks through retained host comparison identities; stage and unstage preserve unrelated changes, and reversal confirms selected unstaged loss under the existing root writer guard and approval policy. Stale, unsupported and captured views never silently become whole-file mutations.
- Hand off is authorized exactly as export is. An unreadable thread is refused identically, and a paired device may hand off only threads it may read. _Here only._
- The Files tool lists the whole bound folder. A listed file opens through a host-minted target id and opaque reference, never a path; a forgotten or cross-Project token resolves to nothing. _Here only._
- Vitals shows load on the host the thread works on: CPU history, memory, network and disk throughput, disk space, GPU and battery, each only when that host can read it, never drawn as zero. History lives in the window for five minutes and is stored nowhere. The extra readings are sampled only for a caller that asks for them, and a server Project's server is read over its SSH connection by a local window only, never a paired device, on Linux servers only. _Here only._

- Code Review turns a person-selected captured diff line into a local finding without execution approval, and selected findings into an editable unsent draft in the owning thread. Checkout/revision/side identity and outside-content references survive ordinary send and queue; missing provenance refuses, and only the person resolves a finding. Receipt links never infer a missing checkout or retarget after rebind. [Workspace](workspace.md) owns the detailed rule.
- Running Code turns expose bounded versioned comparisons from their recorded starting tree after typed edit activity. Captured Review stays on an exact immutable version while newer/final captures are announced, preserves view preferences, and keeps original note anchors. Passive reads never capture; current authority, cancellation, unavailable source and final-capture failure remain explicit. [Workspace](workspace.md) owns the lifecycle and view-only whitespace rule.

Status: Built. Since: —. Detail: [Workspace: Tool lifecycles](workspace.md#tool-lifecycles) and [DESIGN.md: Shell and layout](../../DESIGN.md#shell-and-layout).

### Canvas in the thread

An agent-authored Canvas is drawn read-only inline or offered in the dock, and it belongs to the thread's own resolved scope.

- An inline Canvas gets no layout, plan, comment or action runtime, so nothing drawn there writes a version.
- A prototype starts only when the person presses Run. Octant never moves focus into a running prototype.
- A thread whose binding the host cannot resolve is refused rather than given an assumed scope.

Status: Built. Since: —. Detail: [Workspace: Tool lifecycles](workspace.md#tool-lifecycles) and [Canvas: Presentation and schema versions](canvas.md#presentation-and-schema-versions).

### Device panes and disposable desktops

Device panes offer only actions the host supports, and input is a separate explicit approval.

- Allow input is a per-destination native approval. Clicking the screen or a key button cannot grant it.
- Closing a pane does not shut down its device. When several devices run and none was chosen, the pane asks.
- A disposable desktop tab never reconnects on its own after a reload; the host holds no view across a restart.

Status: Built. Since: —. Detail: [Workspace: Tool lifecycles](workspace.md#tool-lifecycles).

### Routines and subagents

Agents may propose routines and delegate work, but a routine exists only through a person's confirmation or request (created paused, so it runs only once the person enables it), and only the thread's agent starts a subagent.

- A proposed routine or follow-up waits as a suggestion chip; dismissing it declines. A routine's runs get at most the creating thread's access.
- An agent's request to pause or archive its thread's routine (cancel, for a follow-up) waits as the same kind of card with the agent's reason; dismissing it keeps the routine. What a run's agent reported is shown beside that run in Automation Center.
- The Agents dock shows and controls subagents without starting them. A provider-observed child is labelled observation-only and has no managed controls.
- The Agents dock draws a thread's subagents as a list or as a graph of which runs each one waits for; a graph card opens the page a list row opens, and the host names a dependency only when the window may read that run.

Status: Built. Since: —. Detail: [Workspace: Routines](workspace.md#routines) and [Subagents](workspace.md#subagents).

### Boards and pull requests

Work and Code have server-authoritative boards. Chat has none, and an agent cannot mark any thread Done.

- Cards cannot be dragged between columns. A person marks a Work thread Done with no confirmation, and Reopen undoes it in one click; a Code thread reaches Done when its delivery target is satisfied or a person marks it Done as their own override (maintainer request, 2026-11-12). Not built yet: today marking Work Done asks for a confirmation, and a Code thread reaches Done only when its delivery target is satisfied.
- A Code card may show one plan-progress count computed at read time. It is absent with no live plan and never shown on Work cards. _Here only._
- The pull request list is a cached host-local snapshot, and board queries never call the forge. A card's summary says fresh, stale or unavailable. The forge is reached only by explicit refresh or a per-Project opt-in cadence (off by default, floored at 30 seconds).
- The Pull requests page lists pull requests as a flat, sortable list that can be grouped by repository: two-line rows with one attention word, a 720px measure, and sort, grouping and filters remembered in the window. The Auto-refresh and Agents may merge switches keep their labels, setters and server enforcement and move into the repository group's menu, or the page's Repository settings menu when the list is not grouped. The list offers Newest, Oldest and a "mine" filter (maintainer request, 2026-11-12); not built yet: today they are not offered, because the snapshot has no creation time and no signed-in login. Where agents may merge is on, the group header shows a quiet chip and the Repository settings button a dot. The Issues place shares the row, group head and Sort menu.

Status: Partly built. Since: —. Detail: [Workspace: Boards and integrations](workspace.md#boards-and-integrations).

### Threads from issues and repositories

A thread or Project can start from a forge issue, a tracker issue or a cloned repository, without write-back.

- Creating from an issue attaches only its identity. The server reauthorizes, frames redacted text as external content and journals the ingestion. There is no write-back.
- A local window may start a Work or Code thread with a labeled text handoff from a Claude Code or Codex session in its Project's canonical root, subfolders or verified managed Code worktrees. The server resolves scopes, rechecks canonical provenance and refuses foreign folders and symlink escapes; clients supply no paths. It retains only bounded visible user/assistant words, marks outside content before creation and shows the exact original folder and explicit omissions. Native adoption is refused while historical account binding, runtime compatibility and exclusive ownership cannot be proved; the current adapters cannot supply that proof. The new thread never clones the unverified native writer. A paired device cannot start one, and an issue and session cannot be combined. Nothing is written back to the tool's files.
- Cloning verifies identity and origin before materializing, promotes atomically without overwriting, and issues a one-time binding receipt.

Status: Built. Since: —. Detail: [Workspace: Boards and integrations](workspace.md#boards-and-integrations).

### Thread usage figures

Every thread shows what it used, worded by one shared module, in its Thread info panel and not under the composer.

- An unreported figure is absent. A cost says "est." unless the provider reported it, and a cache hit is never rounded up.
- The figures are one compact block at the top of the Thread info panel, with a Turn details link, and have no hide control and no setting; the stored `showThreadStats` value stays in the schema so saved settings decode, and nothing reads it. Under the composer, with the row and a card, they read as four stacked layers. In a split workspace only the active pane shows them.

Status: Built. Since: —. Detail: [Workspace: Context and usage](workspace.md#context-and-usage).

### Local-server stop authority

Octant stops a local server only when it can prove the server belongs to a live terminal it tracks.

- An exited shell, a reused PID or missing evidence leaves the listener classified as a leftover that needs confirmation.
- Editor provenance labels alone never grant stop authority.

Status: Built. Since: —. Detail: [Workspace: Local-server ownership](workspace.md#local-server-ownership).

## Start screen

### Start-screen cards

Every start screen shows one question and its composer. Code Home adds one card area, and cards add no authority.

- The composer paints first. Cards mount after the first commit, read only what the window's own authority returns, and are never mounted when off or unavailable.
- Answers, Open, Stop and Start a fix go through the commands the open thread already uses. An option is words sent as the next turn; Start a fix only opens a draft.
- An empty card shows one quiet line, never fake rows. Customize is stored in one shell setting and ignores unknown card ids.
- A composer's box holds only attach, the prompt, the microphone and send, on a start screen and under a thread alike, and is one line tall until the person types more. How the thread runs is one row under the box on the box's own columns: the Project's icon in a cell as wide as attach and its name where the prompt's text starts, then right-aligned the model's name (no chevron), the mode as one button with an icon per mode and a name and tooltip "Mode: …" (Full access alone keeps its words, in the warning ink), and the context ring in a cell as wide as send, 28px high and 4px under the box everywhere. The thread's own actions (Mark done, document delivery) are a group of the add menu, not an overflow button. Where a new thread runs is one row of chips above it. Both rows stand on the page with no frame, so the box is the composer's one raised surface; it is the glass surface over a ground, and takes the control tint under Window glass. The working folder is one of the chips above the box, and opens its fields over the page. The composer is the box and one quiet row under it, and with nothing pending nothing else stands there. That a thread has read outside content is a standing fact about access, so it is a chip in the row directly after the access control (a globe and "Outside content" in the warning ink, no fill or edge at rest, shown for as long as it applies), whose popover holds the full sentence and the Review action; in a narrow row it keeps the globe and drops the words. The turn figures live in the Thread info panel, not under the composer. A card above the box is only for something the person must read or act on that stays until resolved (a refusal, a failure, an offer with an action, the Project offer, a failed dictation): the callout's compact form (12px meta step, tight padding, its tone tint, its own 12px corner), the box's width, 8px above it, the most severe first, and the same glass as the box over a ground or under Window glass. Only what a surface marks as passing by itself (sending, a response streaming, a provider check, compacting, a first turn being prepared, a keyboard hint) is one quiet meta-ink line above the group that takes no layout room, never a card, so the transcript never jumps; a plain note that stays until the person acts (a saved-draft sentence, a locked task, an access or handoff note, what a newly picked provider will not carry over, a receipt) is a wrapping card of its own, never cut to a line. One always-mounted polite status region is the prompt's description and receives the words of every line; refusal and offer cards are alerts and are part of the prompt's description while pending. A tinted bar inside the box fought its corners, and a card as heavy as the box plus two rows under it read as four stacked layers.
- Radius is two numbers and a round exception: a control's outline (a button of any size or variant, a field, a tab, a menu row, a chip, a capsule that only groups controls, the composer's attach and send) is `--oct-radius-sm`, 4px; a container (a card, a menu, a popover, a dialog, the Settings sheet, the composer) is `--oct-radius-md`, 12px; only what is inherently round (a switch, an avatar, a dot, a count, a meter, a slider thumb) takes the pill token. A part inside a control takes the control radius less the padding between them, never below 2px. The recipes' `rounded-md` and `rounded-lg` resolve to the control token and `rounded-xl` to the container token, so no recipe class is rewritten. A contract test fails when a control rule reaches for the pill token.
- Suggestions sit directly under the composer, and everything below ends on the composer's edges.

Status: Built. Since: —. Detail: [Workspace: Start-screen cards](workspace.md#start-screen-cards) and [Start screen: Card registry](start-screen.md#card-registry).

### Needs you across surfaces

Waiting requests appear on several surfaces from one host list, at a local window only.

- The start screen, board cards, palette, Inbox and Review page read the same list and answer through the mode's own command.
- The Inbox page is raised cards in one 980px column, with its state in one line beside the title; see [Inbox page](workspace.md#inbox-page).
- A remote window has no source. The desktop menu bar lists waiting threads but only opens them.

Status: Built. Since: —. Detail: [Start screen: Needs you across surfaces](start-screen.md#needs-you-across-surfaces).

### Code agent home

Under the Code composer, the start screen is an agent home of work to pick up.

- Picking an item fills the prompt and attaches the issue as the thread's Create-from context.

Status: Built. Since: —. Detail: [Start screen: Code agent home](start-screen.md#code-agent-home).

## Canvas

### Canvas delivery and the closed block catalogue

An agent delivers anything the person will keep, share or return to as a Canvas, built from a closed, version-gated block catalogue.

- The delivery test is the answer, not the verb. When in doubt the agent makes the Canvas rather than asking.
- A document that declares an older schema version but carries a newer block is refused as a future version.
- A diagram holds at most 512 nodes and 1,024 edges, re-checked by domain policy before it persists or renders. Boards embed no third-party canvas engine and run no markup or script. _Here only._
- A bounded subset of Mermaid is translated into typed blocks. A diagram outside that subset renders with a bundled renderer inside the existing sandboxed no-network frame, and raw source shows only when rendering fails (maintainer request, 2026-11-12). Not built yet: today Mermaid is never rendered and a diagram outside the subset is refused with a typed reason.

Status: Partly built. Since: —. Detail: [Canvas: Agent tool and recipes](canvas.md#agent-tool-and-recipes) and [Presentation and schema versions](canvas.md#presentation-and-schema-versions).

### Canvas preview

The agent's `preview` returns typed layout warnings and a picture drawn in a no-network headless browser.

- A model that accepts no images, or a host with no browser, still gets the warnings and a plain sentence saying no picture was taken and why.
- A Canvas read or previewed by another thread carries its outside-content mark to the reader.

Status: Built. Since: —. Detail: [Canvas: Preview and placement in the thread](canvas.md#preview-and-placement-in-the-thread).

### Designs and prototypes

A design is the author's own markup in sandboxed frames. A design that runs script is a prototype with no route out unless the person allows the network for that Canvas.

- A static frame never gets `allow-scripts`, and no frame has both `allow-scripts` and `allow-same-origin`.
- Design markup refuses remote images, stylesheets and fonts, embedded documents and any link that is not a fragment.
- A running design runs only on Run, with the network blocked on desktop unless the person turned on that Canvas's "Allow network" switch, which only the person sets and is off by default (maintainer request, 2026-11-12); not built yet: today the network is always blocked on desktop. In a browser the prototype is not network-contained and says so.
- Sharing design markup needs the person's acknowledgement that it leaves as written.

Status: Partly built. Since: —. Detail: [Canvas: Design block](canvas.md#design-block).

### Boards and comments

Diagram and flow boards are editable by a local person, and comments are journaled facts the host stamps itself.

- A drag or nudge is journaled as a new immutable version with the host's own actor; a stale drag is refused.
- Only a window on this host edits boards or comments. A paired browser reads them.
- Inline diagrams follow their drawing's proportions without gaining layout-editing authority; document workspaces keep the fixed board frame. Retry loops use visible return lanes with shape-aware ports and space before neighbouring automatic-layout nodes. [Canvas visuals: Inline diagram proportions and retry loops](canvas-visuals.md#inline-diagram-proportions-and-retry-loops) owns the layout rule.
- Send to agent queues a turn under the thread's own authority and creates no new authority.
- The workspace tab's tool rail (Select, Hand, Comment, Area, Pen, Text) only chooses what the pointer does and which anchor a comment gets. It journals nothing and adds no command or authority.
- An area comment is a `region` anchor in percent of its block's drawn box. A board takes none, because its picture moves under its box.
- A drawn mark (an area, a pen line, a pinned note) is a comment's anchor and never an object of its own, so it follows the comment rules and adds no aggregate, command or route. A pen line is a `stroke` anchor of 2 to 128 points bounded to the block's box; a note is a `region` of no size. A build older than the `stroke` kind cannot read a comment that carries one.

Status: Built. Since: —. Detail: [Canvas: Diagram boards and comments](canvas.md#diagram-boards-and-comments).

### Choices answered in a Canvas

A `choice` block asks the person a question inside a Canvas; their answer goes to the Canvas's own thread as their own ordinary message.

- The block takes the inline questionnaire's question shape and bounds (one to four questions), carries no answer, and is decoded strictly on the host.
- Choosing edits a local draft; only an explicit Send enqueues one message on the owning thread through its message queue from the person's window, so it runs or waits like a composer send under the thread's existing authority. It is never a host-initiated turn or an approval.
- The message is host-framed text naming the Canvas, the block, and the chosen labels or written answer.
- Where no thread can take the answer (no message queue in the window, a paired client, no host scope for the Canvas, an older version, the thread's own inline view, a shared snapshot or public share page, an export) the block reads only with a reason. A share never offers sending.
- HTML design frames gain no submission ability.

Status: Built. Since: 2026-11-11. Detail: [Canvas: Choice block](canvas.md#choice-block).

### Canvas shares and exports

A share names its Project and is judged against it. A Canvas owned by a Chat thread outside every Project is shared only through the export destinations (maintainer request, 2026-11-12); not built yet: today it is not shared.

- Share versions are independent of Canvas versions. A share that declares an older version but carries a newer block is refused.
- Action blocks and source ids never leave. Exports carry no tags.

Status: Partly built. Since: —. Detail: [Canvas: Shares](canvas.md#shares).

### Artifact library and tags

The Artifacts library is host-wide across Projects. It is the deliberate exception to per-window Project read scoping.

- The server decides the library's scope. A paired device is clamped to the Projects its catalog allows.
- Tags are the person's own labels, kept host-local. They never enter a Canvas version, a share, an export or sync.
- Only a window on this host changes tags.

Status: Built. Since: —. Detail: [Canvas: Artifact library and tags](canvas.md#artifact-library-and-tags).

### HTML import

A person can bring one HTML page into a new Canvas. The import adds no authority and no network egress.

- It runs under the create path's authority and is a local-window action only; a paired device cannot import.
- Scripts, remote assets, external links and form destinations are taken out and reported. The page is at most 256 KiB.
- The Canvas is marked outside content for every later reader, and the title is what the person typed, never the page's own.

Status: Built. Since: —. Detail: [Canvas: HTML import](canvas.md#html-import).

### Canvas visual system

Charts, tables, mockups, designs and flow boards share one visual system.

- Hue lives on the mark and never on the chrome. Every mark pairs hue with a second channel. A block that cannot be drawn falls back to its plain reading and a disclosed table.
- Series hues follow a fixed order so a series keeps its colour across charts.
- A mockup is inert and uses neutral ink. A design's inside is never restyled by Octant.
- A flow board's hotspot is the only live control, and a list reaches every screen without the board.

Status: Built. Since: —. Detail: [Canvas visuals: Data visualisation](canvas-visuals.md#data-visualisation), [Mockups and designs](canvas-visuals.md#mockups-and-designs) and [Flow boards](canvas-visuals.md#flow-boards).

### Project design systems

A Work or Code Project's design system is a `DESIGN.md` in its folder. Octant lists, draws, edits, and creates these files, every Work and Code turn follows the governing one, Canvas designs draw with its tokens, typed Canvas blocks take its colours, and a person can swap the design system a Project or a single Canvas follows (maintainer requests, 2026-11-10 and 2026-11-11).

- The file is the source of its content, never copied onto the Project record or journaled. Which file is the Project's own is the person's choice (any `DESIGN.md`, or none), journaled as `project.design-system-changed@1`; without one, the top-level file, else the only one. A chosen file that is gone leaves the Project with none. The nearest `DESIGN.md` above a file governs it.
- Front-matter colours, typography, radii, and spacing become Canvas brand tokens under the design brand rule; each is reported carried, adjusted (a font stack without web faces), or refused with its reason. At most 32 are carried.
- Every Work and Code turn carries the rule to follow it and the Project's own file as keyed standing context, read from the folder each turn (a Code turn from its worktree). Nothing is added for a server Project's remote folder.
- Canvas `describe` returns the design system's tokens for every design kind (documents, decks, sites, screens, UI kits, flows); a running design copies the values into its own stylesheet. Tokens from `DESIGN.md` take the place of the brand kit.
- A Canvas may follow a design system (Canvas schema version 28): its charts, tables, metrics, treemaps, and diagrams take their series colours (the `chart-1` to `chart-6` palette, else primary and secondary) and accent from it on screen, in Present, and in the HTML export; tones and text keep the reader's theme. A Canvas an agent creates in the Project follows it.
- A person switches a Canvas to another of its Project's design systems, or none, from its More menu; the host reads the file under the Canvas's own Project and journals the switch as a version that also redraws brand designs. Not admitted for a paired device.
- Only a window on this host may list, read, create, or save one; a save replaces only the revision it opened; no read or write follows a link; files over 256 KiB are left to the editor.

Status: Built. Since: 2026-11-10. Detail: [Project design systems](design-systems.md).

### Public links

A public Canvas link is off by default and exists only through the person's explicit act in a local window.

- Settings holds the switch, off by default. While off, no request reaches the service. Turning it off keeps existing links revocable.
- A link is published only through the export approval card. No agent tool reaches the flow, and a paired device cannot publish.
- Paired Chat, Work and Code readers can open an existing Canvas and copy its public links. Their Canvas read grant is thread read authority: the device reads a Canvas when it may open the Canvas's thread, still filed in that Project and mode, never by switching the host's Project. A refusal does not reveal whether the Canvas exists. The shared reader omits creation, editing, export and owner update/revoke controls, which stay refused to a device; every read still travels through the device session.
- The payload is a frozen copy with no host, Project, thread or source ids, no file contents and no declared images. A Canvas has at most one active link (30-day default expiry, optional password).
- The service has no accounts. A per-share owner secret lives in the credential broker, separate from provider credentials, and never in the journal.
- A first-party create commits that secret and a non-secret ownership intent before uploading a document. Owned-create binds a random id, owner and exact approved terms; identical retries do not mutate, conflicting retries refuse, and uncertain publication is withdrawn through durable restart/listing recovery. A host never falls back to legacy create. Key-bound ids and durable authenticated cancellation tombstones fence delayed creates; unauthorized/not-found responses never settle ownership.
- The service logs no IP address and serves design frames from a separate user-content origin.
- The reference service lives at `apps/share` in this repository and is self-hosted by each user (Bun or Docker); no service address is set by default, and Ogard Labs operates no instance.

Status: Partly built. Since: 2026-10-20. Detail: [Canvas public links](canvas-public-links.md#off-until-the-person-turns-it-on) and [Publishing is the person's act](canvas-public-links.md#publishing-is-the-persons-act).

## Artifact sync

### Signed append-only replica entries

Artifact sync writes one signed, write-once entry per committed version or deletion, and reconciliation never overwrites.

- A bad or missing signature, an unknown or revoked writer, or a content-hash mismatch is refused.
- Two computers revising the same parent keep both heads. A deletion is a tombstone that stays in the history.
- A store offers list, get and put-if-absent. The folder store writes only under `Octant Sync/`, and the bucket store refuses plaintext endpoints.

Status: Built. Since: —. Detail: [Artifact replica sync: Entries](artifact-replica-sync.md#entries) and [Store](artifact-replica-sync.md#store).

### Replica membership

Membership is a pure function of the pinned founder and the valid signed membership records.

- Only a strict ancestor can revoke a computer. A revoked computer's entries count up to its cut.
- Two computers that hold the same records derive the same members.

Status: Built. Since: —. Detail: [Artifact replica sync: Membership, as wired today](artifact-replica-sync.md#membership-as-wired-today).

### Leaving a replica

A computer may leave a replica, including the founder.

- The founder may leave. The computers it approved directly can then never be revoked, and no computer can take over as founder.
- Leaving needs the store to be reachable, unless the person confirms leaving without it.

Status: Built. Since: 2026-10-14. Detail: [Artifact replica sync: Membership, as wired today](artifact-replica-sync.md#membership-as-wired-today).

### Artifact publish and pull

Every committed Canvas version is queued for publish through the share filter, and nothing is called while sync is off.

- Nothing is queued without sync or a replica identity, nor for a Code thread under Plan mode. An imported entry is never republished.
- Historical local versions require a reviewed destination and eligibility preview, explicit selection and consent; durable publication progress can stop and resume after restart without duplicating entries. Separate batches preserve known ancestry; a newly pulled deletion stops uploads, and only a published explicit Restore of the reviewed deletion slots permits resuming them. Nothing backfills automatically.
- Synchronized deletion is a separate confirmed tombstone action over known versions, preserving local history. A local erase never publishes it and removes queued historical bundles locally. A deletion beside a concurrent revision stays visible until explicitly resolved.

Status: Built. Since: —. Detail: [Artifact replica sync: Artifact sync: publish and pull](artifact-replica-sync.md#artifact-sync-publish-and-pull).

### Store selection

Choosing the sync store is a local-window act that is journaled and starts with sync off.

- Choosing or changing the store turns sync off. A member of a replica cannot change the store's kind or location.
- Bucket keys live in the credential store and are never journaled. A key pair is never sent to a server it was not entered for.

Status: Built. Since: —. Detail: [Artifact replica sync: Store selection](artifact-replica-sync.md#store-selection).

## Browser

### Browser captures

Only an explicit screenshot is kept, and it stays with the thread.

- The agent's screenshot operation and the person's Screenshot control keep a capture. A paired device, the thread-less Project browser and a terminal CLI keep nothing.
- The agent may also keep a recording: `record: true` on one `steps` or `flow-run` call keeps an animated PNG of its page while that call runs (at most 30 seconds, a frame every 250 ms, 120 frames, 800 pixels on the longer side, 2 MiB), taken from the page's own screencast in the desktop and the headless Browser and joined without decoding or a new dependency. It is admitted like a screenshot, except that Plan refuses it because the thread keeps it as an artifact (a recorded call in Plan answers `recording-refused` and runs nothing, and one already running when Plan begins is stopped and discarded), keeps no frame of a page that shows a credential field or cannot be checked, nor of a page off the thread's approved origins or with no web origin, ends with its call or when another tab comes to the front (kept under the recorded tab's address, `tab-changed`), and is kept, retained, listed, exported, and saved for a pull request as a capture; the strip shows it still with a play mark until the person opens it.
- Bytes live under the data directory, never a Project. The journal records metadata and a hash, never bytes.
- A thread keeps its newest 200 captures by default, a limit a person can change (maintainer request, 2026-11-12); not built yet: today it keeps a fixed 32. Captures leave the host only in the local owner's thread or data export.
- At most 8 of those captures are recordings: keeping a ninth drops the thread's oldest recording, never a screenshot. It is the same journal-derived rule as the capture limit (no drop event; listing, reads, export and recovery all apply it, and purge erases everything as before), and it bounds a thread's recordings at about 16 MiB instead of about 64 MiB.
- A thread also keeps the agent's last 50 Browser steps (operation, element role and name, page origin and path, the one-line result or failure category; never typed text, a field value, or a secret query value) on the same journal rules as captures. Beside its captures they are the thread's "Browser proof".
- The person can draw on a kept capture and add it to the thread's message: "Draw on page" keeps a capture through the Screenshot route and draws on that picture only, then "Add to chat" hands a PNG to the thread's composer as an ordinary image attachment. It sends nothing, stores nothing beside the capture, and is offered only in a Work or Code thread's Browser.
- Proof reaches a pull request only when the person chooses "Include Browser proof" in the Code pull-request form: a "Browser check" section of numbered steps. Screenshots are saved to a folder the person picks on a local window, never uploaded. A paired device reads, attaches, and saves none of it.

Status: Partly built. Since: —. Detail: [Browser captures: What is kept](browser-captures.md#what-is-kept), [Retention](browser-captures.md#retention), [Marking up a capture](browser-captures.md#marking-up-a-capture), [Proof](browser-captures.md#proof) and [Recordings](browser-captures.md#recordings).

### Browser for agents

- The Browser toolbar is one row under the tile bar: plain icon buttons for back, forward and reload, then the address field in the control corner (never a pill) holding at most the connection mark of a loaded page, then trailing icon-only buttons in this order: status (only when it has something to say), Take over or Hand back, extensions, profile, and a More menu for everything else. No more than three trail the field besides More; the left-most fold into More first, and again to keep the address at least 120px. A signed-in profile names itself beside its icon; Reclaim locally replaces Take over while a remote owner holds the page. The row takes the tile bar's insets and gaps and never wraps. Owner: [Design system](../../DESIGN.md) and [Workspace](workspace.md).
- Idle Browser panes and thread docks report the same server availability decision as tool composition, with a specific omission/remedy or Unknown. Plan reads as read-only; the status is a mark whose name and tooltip carry the sentence, and its recovery action is a More menu item. This does not grant a site approval or change Take over/Hand back.

The agent's Browser tool reads a page as an outline with element refs and acts by ref, with every operation admitted on the server and the same tool for every provider.

- A snapshot lists headings, text, and controls with refs, states, and values. A credential field reads protected with no value, and a page that holds one shows no field values.
- The snapshot and every ref action reach into frames and open shadow roots, with the credential check in every frame. A Private page's frames are read whatever their origin; a signed-in page reads a frame on another origin only when the context's approved origins include it.
- Refs are kept and resolved on the server. A ref the latest snapshot did not list, or whose element no longer has the recorded role and name, is refused as stale before the action runs.
- An action answers with the address, title, revision, and one line on what changed. Page text, a picture, or an outline come back only when the call includes them, and the runtime takes no picture an agent did not ask for. The person's activity preview keeps its picture through the host's peek.
- The agent may hover, choose a list option, drag, press key chords, and open, list, switch and close tabs; a new tab reaches its page through the same origin admission as a navigation. At Full access a Private page needs no site approval and may navigate across origins; below Full access a site approval waits for the person rather than expiring (maintainer request, 2026-11-12). Not built yet: today a Private page asks for each new origin at Full access, and an unanswered site approval expires.
- Ordinary uploads use the thread's workspace and relative plain-file paths (at most five files of 25 MiB, Settings defaults rather than constants). At Full access an upload does not ask and the path checks still hold; below Full access it asks, and the answer can be remembered per site (maintainer request, 2026-11-12). Not built yet: today an upload takes a one-use answer at every access level and the limits are constants. A local person may separately review a fixed-content routine upload manifest from one current approved Project folder, with exact routine/model/authority/profile/site, file identities, types, byte/count quotas and expiry. Account access remains separate; children, terminals and ordinary turns inherit no recurring file permission. Changed files/root, expiry or revocation refuse, close affected contexts and release retained copies. Quota is journaled before effect and is not automatically refunded. Restart restores none. See [Recurring upload manifests](browser-agent-tool.md#recurring-upload-manifests).
- Agent downloads are on by default at Full access; below it they are blocked unless the person turns on "Let agents download files" (off by default, set only from a local window, journaled with shell settings) (maintainer request, 2026-11-12). Not built yet: today they are blocked at every level until the person turns that on. Then a download an agent action starts is held outside the workspace (at most 25 MB, 5 per page, Settings defaults rather than constants; not built yet: today constants), reported by name, size and sniffed type, with an optional completed-native HTTPS-origin redirect-chain receipt stripped of paths/query values/fragments. Per-file review names the requesting page separately from that source, or says source unverified when proof is absent; a page origin grants no download provenance. Ordinary `download-save` does not ask at Full access, where the path checks still hold, and below Full access asks the person, with an answer that can be remembered per site, before saving it as a new file in `downloads/` of the thread's workspace; not built yet: today it asks every time, at every access level. Programs, installers and scripts are refused only below Full access (not built yet: today at every level), a symbolic link is refused, and a paired device, a terminal grant and Plan cannot save. A download the person starts in the Browser pane saves to the Downloads folder at every level; not built yet: today a person's own download in the pane stays blocked. Headless downloads enforce the in-flight size cap even when concurrent arrivals cannot be attributed: all ambiguous candidates are cancelled when a candidate file exceeds the cap; already attributed downloads stay independent. A cancelled download cannot become held through a late completion. Saving pins the destination as a physically verified working directory and creates only an exclusive relative basename; a directory/link swap cannot redirect the write or cleanup. Unsupported save platforms refuse. The trusted internal selected-destination port accepts either an approved main or extra Project root and an existing reviewed relative directory, with mandatory device/inode identity and currentness; it never falls back to a checkout. The native writer verifies that exact held identity and physical path, bypassing a cached cwd. Final synchronous source/authority/quota admission follows byte reads and read-only target proofs, refusing a changed sniffed prefix before using its type facts; even default folder creation waits until dispatch. Ordinary production saves still use workspace downloads and their existing receipts; selected receipts explicitly identify their approved root and keep their path relative to it. A separate local-person recurring-download manifest binds the current routine/model/authority/profile, exact page and attested source-origin set, approved folder/directory identities, sniffed types, count/byte limits and expiry. Account permission stays separate. An eligible routine can omit the manifest id on a save to discover only its own current-profile scopes without saving or consuming quota, then explicitly retry with a matching returned id. Final synchronous quota admission precedes exclusive native dispatch; uncertain effects are never refunded, held ids are one-use, selected-root receipts stay distinct from legacy workspace receipts, and restart restores no grant. See [Recurring download manifests](browser-agent-tool.md#recurring-download-manifests).
- `steps` runs up to 10 operations in one call, each admitted by the server on its own, stopping at the first failure. A batch cannot nest, upload, download-save, sign in, run or save a flow, stop, or open a signed-in page. `record: true` on `steps` or `flow-run` keeps an animated recording of that one call as a thread capture; the model gets its id and length, never the animation, and the runtime records nothing an agent did not ask for.
- A local person can review and start a saved fixed flow in an existing idle Work/Code task, using its current model and authority. Run-specific type text and explicitly reviewed expected titles stay in memory; operations, targets and paths remain fixed. Exclusive Browser custody, explicit Resume of unexecuted human-held steps, version/profile/site-approval revalidation and a 15-minute lifetime prevent overlapping or stale replay. Settings grants no authority; server Projects and Plan refuse this local runner. Detail: [Flows](browser-agent-tool.md#flows).
- Waits take text, an address, a load state, or an element's state, all or any, and one wait may last up to 10 minutes (maintainer request, 2026-11-12); not built yet: today a wait has a hard limit of 30 seconds. Actions wait for the page to settle (load, then 250 ms unchanged, at most 2 seconds). The agent can answer a page's dialog (accept, dismiss, or text for a prompt); a dialog the agent does not answer is answered by a fixed rule (alert and leave-page accepted, confirm and prompt dismissed) and reported (maintainer request, 2026-11-12). Not built yet: today every dialog takes the fixed rule. `resize` sets the agent's own page to a size (320-3840 by 320-2160) or one of four device presets (`phone`, `phone-landscape`, `tablet`, `desktop`, each with a pixel ratio and mobile flag), and can turn touch emulation and a light or dark color scheme on or off; with no field it restores all of them. It touches only the agent's own page, never the person's window or another context, and a page whose developer tools someone else attached keeps its touch and color scheme.
- `sign-in` hands the page to the person: a card with Continue and Cancel, the Browser brought forward, every other agent Browser call held, and a fresh snapshot on Continue. A person leaving the page on an unapproved site is told so; no origin approval widens. It is never remembered and is refused on routine, subagent, terminal-grant and paired-device turns.
- Off-origin refusals say stop then navigate for a new site's approval, or sign-in in the app for the person's SSO. Expired pages report context-expired and the former profile under the same window, thread, authority and model binding; the bounded hint keeps no page content and never reopens the page. Session deadlines are unchanged.
- `flow-save` keeps the agent's successful operations since the page opened (at most 50; refs as role and name, expected path and title per step) as a named flow in the thread's Project, and `flow-run` replays it with no model turn, every step admitted like a call and the replay stopping at the first step that fails, is refused, finds not exactly one element, or ends on a different path or title. A step that needs the person, or an address with a secret in it, ends what can be saved. A paired device cannot save or run, a routine may run but not save, and the person lists and deletes flows in Settings. Flows are journaled per Project, erased with it, and in no export or replica sync.
- The person's keys and clicks reach the page while the agent acts and are never dropped. They drop the snapshot's refs, the agent's next answer says in one line that the person used the page, and an agent click or keystroke is refused as stale until it takes a snapshot, so it never overwrites what the person is typing.
- **Take over** holds every agent Browser call on the page (the sign-in hold, refused as `browser-person-took-over`) until **Hand back**, which answers the agent's next acting call with a fresh snapshot. It is the person's, at a window of this computer, checked on the server; a paired device, routine, subagent or terminal CLI cannot, and it is not journaled.
- Browser lifetime uses each caller’s existing idle interval, renewed by meaningful admitted Browser work or person input, never passive renderer polling or refused/held/queued calls. Active authorized work may last beyond ten minutes without a new absolute cap; creation and unresponsive actions remain bounded, late completion/input cannot revive expiry, and existing eleven-minute handoff/two-minute release windows remain separate. Stop/revocation/host close and all caller/profile exclusions remain unchanged; no persistent owner or new grant is added.
- A separate enrolled-owner control path uses a fresh target-bound unlock for at most 60 seconds on an already-open visible native Code Private page. It shows exact thread/site/controller metadata, volatile person-only frames and fixed tap/scroll/key/text input. Stop/expiry/disconnect keep the person hold and local reclaim remains available. Its strict audit retains the owner petitioner without page content. Work, stored profiles, embedded/headless/dedicated pages and ordinary paired callers remain unsupported. Beyond that path, an owner device the person marked at a local window may navigate and type in the host's agent Browser and answer profile site approvals (maintainer request, 2026-11-12); not built yet. Detail: [Owner control](browser-agent-tool.md#owner-control-of-an-open-code-page).
- No password saving. The separate bounded synchronous script operation is offered to Work as well as Code at Full access (maintainer request, 2026-11-12); it is built for an existing local native Code page at Full access and not yet for Work, with server authorization, native execution/result bounds, independent credential-custody exclusion and truthful possible-effect/cancellation receipts. Scripts have ordinary DOM/account authority and callbacks may persist; fixed-reader redaction does not promise arbitrary-script password non-observation. Page main-world CSP does not constrain isolated-world evaluation.
- Below Full access, a local Code task asks for one exact-source permission bound to its HTTPS origin, selected profile, task/model and current page. The prompt explicitly grants page account authority even with unknown sign-in state. It never becomes a remembered origin grant or widens host confinement. Plan, credential fields, incomplete frame/shadow coverage and stale bindings refuse. Work and other excluded callers remain refused.
- Diagnostics report console errors, failed requests, and 4xx and 5xx responses (address, method, status; never a body or header), console warnings on request, each numbered, read after a `since` cursor without clearing.
- `audit` reads the open page and never navigates, reloads, or changes it, and is admitted exactly where `diagnostics` is (Plan admits both). `accessibility` runs fixed checks in the shared page reader (images without text alternatives, unnamed buttons, links and fields, missing title or lang, skipped heading levels, duplicate ids that labels or aria point at, WCAG AA text contrast over known solid backgrounds, focusable elements inside aria-hidden, and crowded touch targets under 24 by 24 pixels while touch is emulated), naming each finding by the latest snapshot's ref or a selector, at most 10 per rule and 25 in all with every rule's count. `performance` reads the browser's own record of the document's load (TTFB, FCP, LCP, CLS, TBT rated by the published boundaries, long tasks, requests by type, the largest resources with addresses redacted as diagnostics redact them, and the page's DOM nodes and heap) and lists what it could not measure; INP is never measured. Results stay on this computer.
- Download-source review preserves every attested origin. Code refuses a review that cannot fit its complete approval-summary byte limit; it never approves a truncated chain.
- Threads of a Project drive their own pages at the same time without waiting on each other. An agent's action reaches only its own thread's context, checked on the server by thread as well as authority. The Project browser dock lists each thread's live page by title or host, owner thread, and an "Agent active" mark, as names only: a selected page shows its thread's own picture read-only, and a paired device sees a stored-profile page by its existence alone.

Status: Partly built. Since: 2026-11-01. Detail: [Browser for agents: Page snapshot](browser-agent-tool.md#page-snapshot), [Results](browser-agent-tool.md#results), [Page lifetime](browser-agent-tool.md#page-lifetime), [Actions](browser-agent-tool.md#actions), [Steps](browser-agent-tool.md#steps), [Flows](browser-agent-tool.md#flows), [Waiting, dialogs, and viewport](browser-agent-tool.md#waiting-dialogs-and-viewport), [Asking the person to sign in](browser-agent-tool.md#asking-the-person-to-sign-in), [Person and agent together](browser-agent-tool.md#person-and-agent-together), [Diagnostics](browser-agent-tool.md#diagnostics), [Page audits](browser-agent-tool.md#page-audits), [Download](browser-agent-tool.md#download), [Parallel threads](browser-agent-tool.md#parallel-threads), and [Bounded page scripts](browser-agent-tool.md#bounded-page-scripts).

### Browser profiles and extensions

The shared Browser tool contract advertises bounded named-account selectors
(`account:<id>`) alongside the existing profile choices. This includes terminal
MCP discovery; execution still requires the caller's separate current profile
and site permission.

Browser pages may keep sign-in in a Project or Personal profile. Private is the initial default, and extensions are enabled only per profile.

- Private is the initial default. A local person may journal a Work or Code task’s default Browser profile; it is a default, not a pin or an approval grant. Explicit agent profile requests still follow existing policy, and excluded callers never silently substitute Private.
- Routine account delegation supplements the ordinary Private remembered-origin path. Explicit profile switching closes the earlier context and withholds its pending observations; refused or expired stored access never falls back to Private.
- Switching a task’s shared page stages a fresh context and makes one final synchronous task/page/authority check with the durable write, pending identity binding and shared-context promotion. Failure keeps the old page and choice; task, conversation and composer draft remain open. Unsaved page forms do not carry over.
- Work and Code revalidate the fresh binding before agent reads/actions, including a valid remembered site/profile grant for the same model/authority. A different model or authority still asks. Named accounts and idle lifecycle are separate from this default/binding contract.
- On a profile page the agent needs a site approval for each origin and profile, for reading too, at every level, Full access included; the person can remember it or widen it to "Allow all sites in this profile" (maintainer request, 2026-11-12). Not built yet: today no profile-wide allow exists. Credential fields stay protected.
- One persistent grant, "this routine or child may use profile X on sites Y", survives a host restart and an app update and replaces the review that lapsed on every restart; upload and download manifests and owner control get no new scope (maintainer request, 2026-11-12). Not built yet: today the session permission described next restores no authority on restart and a host restart requires review again. A local person may review a bounded session permission for one same-Project managed child, execution host, current run/model/workspace authority, stored profile and exact HTTPS sites. It expires, is revocable, restores no authority on restart and authorizes no transfers, sign-in, credential use or scripts. The child owns its context and uses an available native owner window; no parent page or authority is lent. Queued/waiting review does not execute or resume the child. Work keeps ambient network access off; its explicit site-limited Browser permission does not change other tools or process authority. Named enabled local Work/Code routines may receive a seven-day permission (explicit maximum 30 days), bound to the definition, model, authority and Project binding. Each dispatcher-proven run owns a separate context and proves its own Code checkout against the target policy, reviewed origin thread where applicable, current thread and repository; changing or ending that run withholds observations. Host restart requires review again; audit replay never revives authority. A running terminal may receive a separate profile/site permission bound to its exact transport grant and current Code task/model/authority. It owns its context and ends with the terminal; stale reads never fall back to Private. Paired devices retain their refusal. See [Delegated sessions](browser-profiles.md#delegated-sessions).
- An extension is installed and enabled only by a person at a local window. Install never enables, and no agent, plugin or skill can install or enable.
- Background native ownership is a default-off local host preference. Only newly reviewed managed-child or dispatcher-proven local routine permissions bind that owner's exact generation; each execution has its own native lease with current grant/task/model/authority/profile/sites/expiry checks. Last-window close may retain those opted-in pages in the same native process/store. Switch-off, cancellation, expiry, revocation, generation change and accepted Quit end their authority; restart or reconnect restores none. Window provenance never becomes an execution principal, and no headless fallback, renderer attach, human/script/credential or transfer authority is lent. Production broker/runtime fixtures are covered; packaged acceptance in the approved native test Space remains pending. See [Background native ownership](browser-profiles.md#background-native-ownership).
- Profiles, their stores, site approvals, refusals, sign out, extension install, per-profile enablement, and popups are built. A popup, an options page, and an extension's background worker get `chrome.tabs` (query, get, create, update, sendMessage) for the profile's own pages in the window only, and an extension with no popup page gets `chrome.action.onClicked`. An extension opens a page only to an origin the page already admits, and sees tab addresses only with the `tabs` permission.

Browser selected-item permission records an explicitly reviewed account/vault/
item and exact HTTPS top-frame/profile/Project-or-task scope. It is a
host-session permission snapshot with an eight-hour maximum, distinct from
store unlock, OAuth identity and cookies. Each brokered fill needs a fresh
held-page form review and explicit approval; submit is separate. Values stay
between the private host consumer and native form. Pending observations are
excluded by reservation epochs. Native commit-start receipts distinguish no,
possible and completed effect without undo; fill does not mean authenticated.
Approved SSO hops are temporary, exact-view/top-frame and keep the task/profile
without widening agent origins. The website can retain/reflect credentials;
MFA/CAPTCHA and uncertain results remain manual. No iframe or arbitrary script
execution is added. Detail: [Browser sign-in](browser-agent-tool.md#asking-the-person-to-sign-in)
and [the credential boundary](../architecture.md#linked-secret-stores).

Status: Partly built. Since: 2026-10-31. Detail: [Browser profiles and extensions: Profiles](browser-profiles.md#profiles) and [The agent on a signed-in page](browser-profiles.md#the-agent-on-a-signed-in-page).

### Terminal Browser grant

A person can lend a Code thread's Browser to a CLI in that thread's terminal, with no new authority.

- The grant is off by default, switched on per terminal by a local-window person. It applies to Code threads only, and serves only the Browser family.
- Calls run as the thread under the existing Browser policy and approvals. A paired device, routine or agent cannot ask. Stored profiles need a separate local-person session permission; they use an independent context, not the managed turn's page. Changed task authority invalidates it, and ending the terminal closes it.
- The grant is held in memory and ends on switch-off, terminal close, thread completion, archive, purge, window revoke or host stop. The token is never journaled.

Status: Built. Since: —. Detail: [Terminal Browser grant: Current behavior](terminal-browser-grant.md#current-behavior) and [Lifecycle](terminal-browser-grant.md#lifecycle).

### Search queries on a tainted thread

On a tainted thread the harness refuses a web search query that looks like it carries data, before any request leaves.

- It applies to every `web-search` call the harness's tool-call policy decides, a harness Chat thread's included, since that thread's only search is the harness's own.
- Refused patterns include long text, URLs, email addresses, long hex runs, escaped bytes, base64 and high-entropy tokens.
- It is a guard, not a privacy rule: the person lowers it with the outside-content gate by choosing Full access for a thread or a Project's new threads, so at Full access in Work and Code the query is not refused and the mark is only recorded.

Status: Built. Since: —. Detail: [Search queries on a tainted thread](search-query-taint.md#refused-patterns).

### Browser profiles with cookie import

Browser pages can keep sign-ins in named profiles, and a person may import cookies from another browser into a profile.

- Octant never opens another browser's profile in place; the person's explicit pick of a browser and one of its profiles is the only way its cookies reach a Project or Personal profile.
- The person may import every cookie in the chosen browser profile or only one site's and its parent domains'; the journal records only that the import was limited to a site.
- A Chromium-family browser's cookie key comes through the macOS Keychain prompt; a refusal imports nothing. Cookies are never logged, journaled, returned to a window, or sent off the Mac, and the journal records the source, the profile, and counts.

- Named account profiles have host-assigned identities, native local labels and separate persistent stores. A local person explicitly selects one; task defaults never grant site, Project or credential authority. Approval names come from the native registry, and origin grants/extensions remain isolated per identity. Unknown identities, paired/unattended callers and a missing native owner refuse. Stores and the name registry are not exported or synced; Private, Project and Personal retain their behavior.

Status: Built. Since: 2026-10-31. Detail: [Browser profiles and extensions: Cookie import](browser-profiles.md#cookie-import).

## Provider runtimes

### Key provider sandbox and approvals

Below Full access, a key provider's app-server runs inside Octant's own sandbox profile, and the provider is told the sandbox is outside it. Full access runs the provider unwrapped.

- A process carries one lease (a thread's root, mode and posture, or a catalog lease), and a different posture on the same connection is refused as unauthorized.
- Approval-gated and auto-accept-edits threads ask for each command not known to be read-only. An approval-gated thread also asks for every patch; on an auto-accept-edits thread the driver answers file changes itself.
- Plan and Chat never prompt; a write fails at the sandbox profile instead.
- Full access keeps the provider's full-access mode and an unwrapped process.

Status: Built. Since: —. Detail: [Provider runtimes: key provider sandbox](provider-runtimes.md#codex).

### Provider-published artifacts

A key provider's artifact publishing is off for every account until the person enables it on the host, and Canvas stays the default. The launch lifts exactly one telemetry guard, only for the sessions that need it.

- The switch is per account, changed only from the host's own window, and refused for API-key accounts and for hosts that export their own telemetry opt-out.
- Enabling shows a confirmation that says it also turns on the provider's usage telemetry; error reports and conversation uploads stay off.
- The launch offers the tool only in a Work or Code session outside Plan, on a subscription sign-in, for a thread that chose it. Every other launch keeps the full guard set.
- The person's own opt-out always wins over the setting, and a host-level umbrella opt-out is never removed.
- The environment is fixed when the runtime starts (once per turn), so turning either choice off takes effect on the next turn.
- Each publish asks below Full access, and at Full access nothing asks, publishing included ([Hosted artifact publishing](#hosted-artifact-publishing)). Plan never publishes, and published pages are reported as outside content.

Status: Built. Since: 2026-10-28. Detail: [Provider runtimes: artifact launch](provider-runtimes.md#claude-code) and [Model endpoints: provider artifacts](model-endpoints.md#claude-artifacts).

### Lightweight-runtime app tools

App-managed tools reach a lightweight-runtime session only for releases whose tool attestation, approval bridge and confinement Octant verified. Other releases list their models and report app tools unsupported.

- A newer release that attests the tool bridge needs no Octant release.
- A release below the floor, or one whose probe does not attest, refuses a session that offers tools and names the floor.
- A session runs on the model it was opened with; a resume that names another model is refused.

Status: Built. Since: —. Detail: [Provider runtimes: lightweight runtime](provider-runtimes.md#pi).

### ACP agents share one stack

Every ACP agent runs on one shared driver stack. A new agent is a profile row, a runtime profile, a logo and conformance evidence; it never adds its own transport, supervisor, protocol client or event mapper.

- Capabilities an ACP agent lacks (usage window, compaction request, history retention) are reported as unsupported, never imitated or estimated.
- Octant's tools reach an ACP session only through the session tool bridge, only when the agent advertises HTTP tool support, and only on macOS; otherwise a session offered tools is refused before it starts.
- A profile ships only after a live probe against a signed-in Apple Silicon install, recorded as a smoke test and a conformance case.
- One ACP process belongs to one Octant session and is never shared. An unknown required method, malformed frame, duplicate response id, uncorrelated approval, impossible ordering or contradictory outcome fails as a protocol error; unknown optional notifications never promote a capability; a version string alone proves nothing. _Here only._
- A permission request that carries only a tool-call id is shown with the latest description from that session, and this grants nothing. A Code thread journals the opaque provider session reference before its first prompt and resumes with only the new message, failing explicitly (never into a fresh session) when the reference is missing or rejected. _Here only._
- A configured provider CLI is always the provider-owned executable at its stored absolute path. Octant never copies, downloads, replaces or bundles a duplicate binary, stores no provider token and needs no second login. Reusing a host profile exposes only allowlisted profile paths, and roots, temp state, network, tool callbacks, approvals and confinement stay app-managed. _Here only._

Status: Built. Since: —. Detail: [Provider runtimes: ACP agents](provider-runtimes.md#acp-agents) and [probe rule](provider-runtimes.md#probe-before-a-profile-ships).

### Local-server provider adapter

A local-server provider adapter gives each acquired connection its own process and one live session. Below Full access, app tools reach it only when a process receipt proves outside tool sources cannot enter.

- Ordinary inherited configuration gives no such proof, so below Full access the adapter reports app tools unsupported. At Full access a runtime whose inherited configuration cannot prove tool exclusivity is still offered Octant's tools, labelled as mixed (maintainer request, 2026-11-12). Not built yet: today the adapter reports app tools unsupported at every level.
- The private endpoint binds calls to that connection's immutable session and exact offered tool catalogue.
- Process exit, stream failure, interruption and scope cleanup retire pending tool requests.

Status: Partly built. Since: —. Detail: [Provider runtimes: local-server adapter](provider-runtimes.md#local-server-provider-adapter).

### Runtime updates

Octant tells the person when a newer runtime release exists, and runs the runtime's own updater only when they click Update CLI. Discovery never installs or updates anything.

- Each lookup is one anonymous registry GET with no task, thread, Project, account or host identifier. A successful answer is cached for one day and a failed or refused lookup for one hour. The check is never made at discovery.
- The check follows the Marketplace fetches switch; with the switch off no request is made.
- Nothing updates by itself, and the runtime is probed again after the updater exits so a release that fails a floor shows its reason.
- Update CLI runs only the configured absolute binary's verified update subcommand, only when no active session uses it, on the owning host. The renderer never receives an updater command. _Here only._
- The updater is a documented exception to deny-default confinement (unwrapped, host environment, bounded output) and must exit before another session is admitted. Failures reach a client only as a bounded diagnostic, never raw output, arguments, environment or paths. _Here only._

Status: Built. Since: —. Detail: [Provider runtimes: runtime updates](provider-runtimes.md#runtime-updates).

## Model endpoints and organization sign-in

### Provider catalog

Settings lists every bundled provider driver, runtimes and model endpoints in separate sections. Bundled drivers need no install or trust step, and opening a catalog page runs nothing.

- An outside driver the person trusted appears in its own third section, labelled as an outside driver, never as bundled, and its provider is added off.
- A scan points a runtime whose saved binary no longer exists at the launcher it found for the same driver, and a runtime created from a scan saves that launcher rather than the versioned file behind it; neither ever turns the runtime on. A saved binary that exists but is incompatible is only offered a replacement, on the card's row.
- A browser can create an API-key profile but never supply the key; the key is set in the host terminal or the desktop app, and host-local credential authority is unchanged.

Status: Built. Since: —. Detail: [Model endpoints: provider catalog](model-endpoints.md#provider-catalog).

### Sign-in lifecycle in Settings

Opening Settings never starts a sign-in or acknowledges terms. Sign-in begins from an endpoint's detail page, and a sign-in that needs a device code begins only in a terminal on the host.

- Returning to Settings resumes the originating window's pending host attempt; repeated Begin requests reuse it, and attempts do not survive a host restart.
- Sign-out asks the provider to revoke first, then removes the local grant; if revocation fails it keeps the grant and offers an explicit local-only removal.
- Settings never begins a device-code sign-in or shows a code, because a code on a page someone else can reach enables phishing.
- An organization endpoint offers no key, and a key endpoint cannot become an organization endpoint; changing the client, scope, issuer binding or address signs the endpoint out.

Status: Built. Since: —. Detail: [Model endpoints: subscription sign-in lifecycle](model-endpoints.md#subscription-sign-in-lifecycle) and [cloud sign-in](model-endpoints.md#organization-sign-in-amazon-bedrock).

### Endpoint addresses, keys and model limits

A model endpoint's key belongs to the address it was entered for, and a model's limits come from the best source that names them.

- A saved address change deletes the stored key, and the address field says so before saving.
- A remote model endpoint must use HTTPS; plain HTTP is accepted only for a loopback address.
- A model's limits and capabilities come from the first source that names them: observed behaviour, runtime metadata, reviewed catalog metadata, user-supplied metadata, then unknown. User-supplied metadata can make a model selectable but never authorizes a side effect. _Here only._

Status: Built. Since: —. Detail: [Model endpoints: endpoint address and stored key](model-endpoints.md#endpoint-address-and-stored-key) and [endpoint list](model-endpoints.md#octant-harness-model-endpoints).

### Organization identity stays in the broker

An endpoint can sign in with an organization directory account or a cloud identity. Reusable identity material lives only in the credential broker, and the server sees at most one short-lived, audience-bound credential for one request.

- Refresh tokens, directory sessions, cloud keys and temporary cloud credentials never reach the server, a provider child process, the renderer, the journal, logs or exports.
- A missing, expired, revoked or mis-bound identity reads honestly in readiness and never falls back to another sign-in; an API-key path stays available.
- Remote principals cannot start a sign-in, refresh, sign out or change broker material; they may run turns on an already signed-in instance.
- A sign-in is bound to its tenant or issuer, client and endpoint origin, checked at sign-in, on configuration change, on each request and on probe. A mismatch is incompatible, and editing the binding drops the grant.
- The access token is resolved for each send, with one forced refresh on a 401; transient failures keep the grant, and sign-out deletes the local grant.
- Live checks against a real tenant, gateway and cloud account are owed by the maintainer.

Status: Built. Since: 2026-10-26. Detail: [Enterprise provider identity: authentication vocabulary](enterprise-provider-identity.md#authentication-vocabulary) and [binding](enterprise-provider-identity.md#tenant-audience-and-endpoint-binding).

### Organization sign-in flows

Each organization sign-in uses the narrowest flow that works. The organization registers its own client, and Octant needs no account of its own.

- The organization registers a public client in its own tenant and enters its client id; reusing another product's client id is refused.
- The desktop signs in with authorization code and PKCE on a loopback redirect; a device code is a per-instance opt-in for a host without the desktop app, and may be shown in a local desktop window, not only a terminal (maintainer request, 2026-11-12); not built yet: today it is shown only in a terminal.
- Continuous access evaluation is not requested.
- Cloud request signing uses the cloud's single sign-on device authorization held in the broker; stored long-lived access keys are refused, and the person's existing cloud profile is read only under the opt-in "Use my AWS profile"; not built yet: today reading the person's cloud profile files is refused.

Status: Partly built. Since: 2026-10-26. Detail: [Enterprise provider identity: maintainer decisions](enterprise-provider-identity.md#maintainer-decisions).

### Identity paths not offered

Two identity paths are deliberately not offered yet.

- A cloud sign-in whose bearer is valid across the whole account is deferred; the only acceptable shape is a broker-side relay that forwards to the bound host (not built yet).
- Runtimes that spawn a child keep their own delegated login and report organization identity kinds incompatible; a host relay for them needs its own design (not built yet).

Status: Partly built. Since: 2026-10-26. Detail: [Enterprise provider identity: maintainer decisions](enterprise-provider-identity.md#maintainer-decisions).

## Outside provider drivers

### Admission of an outside driver

An outside driver is a harness-endpoint transport only, installed from outside Octant. Review, install, trust and enable are one local-window flow, and each later step to use is a separate local-window action that the flow does not imply.

- Only harness endpoints are admitted; outside agent CLIs and managed processes are not.
- One "Install and trust" flow covers inspect, install, trust and enable; digest-bound trust and confinement are unchanged, and add provider, connection check and Verify tools stay separate actions (maintainer request, 2026-11-12). Not built yet: today inspect, install, trust and enable are four separate actions. Structured references, tool calls, routines and remote clients cannot perform them.
- A driver is a single ES module on the server's runtime, with no executables, native addons or install scripts.
- Outside harness endpoints work in Chat, Work and Code with verified-model tools, like bundled endpoints.
- The live loopback smoke on macOS is owed by the maintainer; on Linux every outside driver stays host-prohibited.

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
- A marketplace package carries a publisher signature, the key is pinned at first trust, and a version signed by another key is held until re-trusted.
- A driver comes from a local folder or from a signed npm package. The host checks the download against the integrity the registry published, the signature names the npm package, and nothing from the package runs when it is fetched.
- A package's identity is its registry and name, so a new version updates the same package. An update check asks the registry the package was installed from and installs nothing.
- Publishing the author kit to npm needs an npm organization and stays a maintainer action.

Status: Built. Since: 2026-10-26. Detail: [Outside provider drivers: provenance and updates](outside-provider-drivers.md#provenance-and-updates), [signature rules](outside-provider-drivers.md#signature-rules) and [npm source](outside-provider-drivers.md#npm-source).

## Device workbench and mobile

### Simulator pane and captures

The iOS Simulator pane shows the Simulator's screen streamed through the host as a live view, authorized like a screenshot and never stored. Without a live view it shows the latest host-held screenshot evidence.

- A raw screen capture lands in a host-private directory that the confinement profile denies to every launch except the capturing one.
- The desktop starts one native device helper per Simulator on first use, stops it when idle or late, and never lets it outlive the desktop. A Mac without the developer tools gets a refusal. _Here only._
- The host chooses live-view size, quality and frame rate. Frames are dropped under pressure, viewers share one stream, and frames are never journaled or put in model context. _Here only._
- Packaged-app and Android emulator device checks are owed.

Status: Built. Since: —. Detail: [Device workbench: device pane](device-workbench.md#device-pane) and [screen captures](device-workbench.md#screen-captures).

### Device input

Simulator input (tap, swipe, key, typed text) goes only through the native device helper. Octant never scripts the Simulator app, and without the helper input is unavailable.

- Typed text is sent only for plain ASCII on a supported QWERTY layout and is refused whole otherwise, so Octant never types the wrong text.
- Each action's evidence records who asked (Agent, You, Remote device, Octant) in a bounded recent list; evidence is not journaled as separate input events.
- Typed text and secure-field values never enter durable evidence verbatim (only redacted length or class markers), and post-input screenshots mask those regions. A finished input action id returns its recorded evidence without repeating the effect; one interrupted or unknown after restart refuses with a distinct status. _Here only._
- A swipe's duration is bounded to 50 to 5000 ms and carries the same authority, approval, attribution, booted-destination rule and Plan refusal as a tap. A sent swipe records both ends whether delivered or not, and one that never ran records why. _Here only._
- Pinch, multi-touch, long press and follow-the-finger drag are accepted non-goals; only taps and straight single-finger swipes reach the device.

Status: Built. Since: —. Detail: [Device workbench: input channel](device-workbench.md#input-channel), [typed text](device-workbench.md#native-device-helper-and-typed-text), [swipes](device-workbench.md#swipes) and [accepted limits](device-workbench.md#accepted-input-limits).

### Device effects

Open URL, Rotate, Record screen and Repair input are effects, not input. A person or an agent may request them, and Allow input never covers them (maintainer request, 2026-11-12).

- An agent's request is unasked at Full access and approval-gated below it; the host asking on its own is refused. Not built yet: today only a person may request them, an agent or the host asking is refused, and the agent tools do not offer these actions.
- Plan refuses them, Full access sends them unasked, and an approval-gated thread raises its own confirmation for each.
- Open URL accepts only a credential-free http or https address of at most 2,048 characters, in parsed form; other schemes are refused at the contract.
- Evidence for Open URL keeps only the origin, never the path or query.

Status: Partly built. Since: —. Detail: [Device workbench: Open URL](device-workbench.md#open-url).

### Managed device tools and the Android emulator

The streaming tools behind the device panes are vendored, pinned and integrity-verified, and run unconfined under Octant's signed identity with an allowlisted environment. The Android emulator is a separate dock destination and tool.

- Updates are off by default and activate only while idle after a smoke launch; a failed release keeps the previous one.
- The tools receive no provider keys, tokens or broker credentials.
- Octant installs only a checkout-relative APK and never stops the shared debug-bridge server.
- Emulators Octant boots cold boot with no snapshot by default, and snapshot boot is a setting (maintainer request, 2026-11-12); not built yet: today they always cold boot. Shutdown is approval-gated and counts as done only after the emulator stays off the bridge for 15 seconds.
- A confinement profile for the managed tools does not exist yet (not built yet).

Status: Partly built. Since: —. Detail: [Device workbench: managed device tools](device-workbench.md#managed-device-tools), [Android](device-workbench.md#android) and [boot](device-workbench.md#boot-from-the-android-pane).

### The phone is a remote client

The host is authoritative for mode, Project, thread, provider, approval and Done. The phone runs no agent loop, holds no checkout or provider credential, and every mutation is checked and journaled on the host.

- A notification is awareness, never authority; opening it lands on the thread under the ordinary session and biometric gate.
- A new phone capability is a new input or output on an existing route class, admitted by the fail-closed remote route classifier.
- Sensors are touched only on an explicit, visible user act.
- The app receives no over-the-air code updates; every build carries its own JavaScript.

Status: Built. Since: 2026-10-26. Detail: [Mobile maturity: the phone stays a remote client](mobile-maturity.md#the-phone-stays-a-remote-client).

### Phone push notifications

Push is off on the host and for every device until the person turns it on, and every notification is sealed so the delivery path learns nothing. Delivery goes through an Octant push gateway that stores nothing per device.

- The envelope carries only a fixed placeholder; the content is encrypted to the phone and the lock screen shows kind and computer label unless the person opts in to thread titles for that phone.
- The host cannot hold the platform credential, so the gateway issues delivery capabilities and accepts only requests signed by the host named in the capability.
- A person who builds the phone app from source can make their own hub the push gateway with their own credentials.
- The gateway issues a capability to any caller presenting a platform token, without app attestation, and limits deliveries per phone.
- The host side is built and verified against a local gateway; gateway deployment, platform credentials, the native phone pieces and live delivery are maintainer gates.
- A thread move held for an owner phone is its own notification kind with no thread in it and its own receipt, sent once per wait to the source's owner phones only (maintainer request, 2026-11-09).

Status: Partly built. Since: 2026-10-26. Detail: [Mobile maturity: delivery path](mobile-maturity.md#delivery-path), [what leaves the host](mobile-maturity.md#what-leaves-the-host) and [building the phone app yourself](mobile-maturity.md#building-the-phone-app-yourself).

### Phone capture and voice

The phone can attach a camera photo, library image or file, and dictate a prompt, with all processing on the host.

- The host strips location and other identifying metadata from every image a paired device uploads before it is stored or sent to a provider.
- Voice is transcribed on the host's Voice endpoint, never the phone's recognizer, in clips of at most 60 seconds, with no audio persisted.
- The phone requests no location access, and the microphone shows only while transcription is ready.
- Physical-device passes are owed.

Status: Built. Since: 2026-10-26. Detail: [Mobile maturity: capture](mobile-maturity.md#capture) and [voice](mobile-maturity.md#voice).

### Android builds and public stores

Android gets internal builds of the same remote client by link. Public store preparation is in preview scope; listing and submission remain separate maintainer actions.

- Internal distribution uses signed builds by link; the Android hardening adapters and workflow are in the repository, and the build and device pass wait on the maintainer.
- Public store distribution requires a clearly labelled offline demo and no Octant account. Fresh-install entry precedes the live session; sample interactions and preferences stay in memory, device effects remain unavailable, and leaving discards sample changes. The shared composer keeps its input and Send above the onscreen keyboard at standard and larger system text. Its Project/host context wraps and constrains long labels while preserving full accessible names and font scaling; the transcript remains scrollable above the composer. Native/store acceptance is separate from source implementation.

Status: Partly built. Since: 2026-10-26. Detail: [Mobile maturity: Android](mobile-maturity.md#phase-b-android-internal-builds-of-the-same-client) and [public stores](mobile-maturity.md#phase-e-public-store-distribution).

## Hubs and Nightly

### Hub and spokes

A person's own devices form a hub-and-spoke topology: a hub is an ordinary Octant host with a role, spokes are the person's other computers, and phones and browsers join as guests. Each host stays its own authority.

- A spoke's hub grant is a closed list chosen and changeable only on that spoke; the hub cannot read credentials, loosen sandbox or approval policy, or decide a risky action.
- Authority checks and the journal stay per host; the hub never acts on an owner's behalf.
- Members are the person's own devices over a private network only; there is no public internet path.
- A spoke accepts new members automatically as full members, every spoke and owner device alerts on each, and a setting can hold new members until an owner confirms.
- Browser guests reach each spoke directly at its own name, so the hub never sees spoke traffic.
- The hub runs as a boot service under the person's account and keeps its keys in an owner-only file on an encrypted disk.
- The Windows server/member P-256 identity prerequisite uses the native-held private profile root for two fixed identity records, preserves projected host identity and the existing non-exporting public signing contract, and refuses unsafe or malformed records without replacement. The dependent listener TLS store admits only its separate fixed key/certificate records through the same boundary. Exclusive key and first-use certificate creation (a concurrent first use adopts the winner) and native certificate replacement on renewal preserve the SPKI pin across renewal and restart; corrupt/exposed keys or unsafe file entries refuse without rotation or ordinary-file fallback; explicit listener key transitions refuse on the native store. The separate fixed native roster-key store preserves P-256/SPKI/P1363 and its immutable key across restarts and concurrent creation, refusing unsafe records or missing Windows storage before ordinary-file access. The existing hub, delegation and Tailscale-certificate authority stores use three closed native profile files with bounded chunk sessions, existing schemas/retention and explicit corrupt/unsafe refusal. Private atomic replacement requires the active claimed same-process/environment/profile owner and revalidates PID/birth at commit; retained readers do not block newer authority commits. A fully flushed private stage denies competing writers/deletion while allowing readers to coexist with its publisher during the atomic rename/close interval; this grants no file permissions. The foreground integration additionally admits the actual SQLite main handle before application SQL and releases its native guard only after connection close, preserving normal WAL and read-only consumers. Existing bounded backup labels and the fixed current-process restore stage receive native no-create family/alias inspection; backup verification uses actual-handle admission and ordinary VACUUM/atomic recovery retains the trusted local-owner boundary. Bun immediate close finalizes prepared statements before guard release. Four fixed boot projection/policy/log files reuse bounded native sessions with existing schema/limits and owner-only publish/removal; discovery reads do not claim ownership and only matching instance/bridge generations are cleared. Windows Work-turn and Code-command/operation entry points and provider process preparation explicitly refuse execution, including Full access and background calls, pending native confinement; Work and Code are to run at Full access on Windows (maintainer request, 2026-11-12), not built yet: that refusal still covers Full access today. Foreground composition consumes those native stores and fixed portable assets before server imports; loopback Chat readiness, authority negatives, verified backup and joined shutdown must be proved through the actual entrypoint for both profiles. Native stop waits for its exact authenticated connection's written-response/closed receipt, with bounded unresponsive-peer retirement; no unwritten or unrelated receipt dispatches the action. Work/Code, executable extensions and unadmitted linked-store state remain unavailable. Desktop/Nightly, disk-encryption setup and service integration keep separate gates. Detail: [boot-key storage](hub-and-spokes.md#the-hub-is-a-server-first).
- Live checks on real phones, passkeys, networks and providers are owed.

Status: Partly built. Since: 2026-10-28. Detail: [Hub and spokes: roles](hub-and-spokes.md#roles), [hub grant](hub-and-spokes.md#what-the-hub-may-do-on-a-spoke) and [decisions](hub-and-spokes.md#decisions).

### Hub failover and owner devices

One hub is active at a time, with a named standby that stands in only while the hub is down. An owner device acts on a spoke with a window's powers after a fresh unlock.

- Members fail over after five minutes without the hub by default; a standby that stands in may add and remove members, and removal wins when the hub returns.
- A standby promotes to hub for good only by a local action the person confirms.
- One unlock (biometrics, passcode or passkey) covers five minutes of administration; Full access, merge, credential copy, owner changes, a thread move's ticket and private approval reads need their own. Runtime approval answers ride the five-minute unlock session by default, and per-answer unlock is a setting (maintainer request, 2026-11-12); not built yet: today each runtime approval answer needs its own unlock. An owner phone confirming a move a window holds unlocks once on its own device and answers the destination's challenge itself; only the ticket id reaches the source.
- Spokes honor owner devices by default, ticked at join and untickable.
- An owner device the person marked at a local window may raise a thread to Full access or start one there, navigate and type in the host's agent Browser, write to a thread terminal, and answer profile site approvals; other paired devices are unchanged (maintainer request, 2026-11-12). Not built yet: today an owner device changes a thread's level only through the posture recovery below, starts no thread at Full access, and has none of that Browser, terminal or site-approval reach.
- Code posture recovery is built through the existing owner route, synchronous Code/Project service transactions and Settings/phone controls. Its current-state token binds versions, binding and checkout identity; Full access needs its own fresh proof, and the journal names the owner device. Physical unlock remains a separate unrun check. The [recovery inventory](hub-and-spokes.md#recovery-inventory) separates posture recovery, bounded one-use runtime approval recovery, restores, action launches and browser/profile transfers; an owner unlock adds none of those grants implicitly.
- Local Work thread access recovery uses the same signed owner route, target/current-Project digest and fresh Full access proof, with the Work service journaling the owner principal. Its four levels remain distinct from Code Plan and persistence; neither a running turn nor a waiting approval is resumed or answered by the change. Server Projects retain their separate boundary.
- One-use owner recovery of local Code and Work runtime file and confined Shell approvals is built through separate fresh signed read and answer routes. Complete bounded Read/Write/Edit facts or the entire supported native Shell command and verified admitted-root working directory, plus exact owner/host/thread/Project/binding/callback/action digests, are mandatory; target change or replay refuses before effect. Runtime answers use once scope. Durable admission prevents retry after uncertainty and records owner attribution without private action contents. Unsupported Shell runtimes, Plan/Full access callbacks, background or sandbox-escape inputs, credentials, Browser/profile, publishing, structured Git administration and remembered grants remain excluded; missing complete facts stay unavailable. Existing paired-device Code answer authority is unchanged. See [owner runtime approval recovery](hub-and-spokes.md#owner-runtime-approval-recovery).

Status: Partly built. Since: 2026-10-28. Detail: [Hub and spokes: failover](hub-and-spokes.md#failover) and [owner devices](hub-and-spokes.md#owner-devices).

### Shared sign-ins, delegation and provisioning

Credentials and work move between spokes only by explicit, narrowed, journaled acts. The receiving spoke keeps the final say.

- Subscription sign-ins held by a provider's own app are never copied; the hub can ask a spoke to sign in itself, and the person finishes it there.
- An owner with a fresh unlock may copy an API key between hosts; both hosts journal the copy without the value.
- Delegated work is clamped to the smaller of the peer grant and the receiving spoke's own Project authority, and journaled with the requesting peer.
- Agent messages between members reach only Code threads a person tagged Reachable on both ends, under the receiver's Message item; they grant nothing there, and the only turn one can start is a bounded, `agent`-initiated wake turn on an idle recipient whose person left Wake when a message arrives on. _Designed, not built._
- Hub provisioning offers are data that land as proposals; auto-apply is per kind and off by default, and a routine always asks.
- The hub's wake service and push sender are each off until turned on; the hub forwards sealed notifications unchanged.

Status: Built. Since: 2026-10-28. Detail: [Hub and spokes: shared sign-ins](hub-and-spokes.md#shared-sign-ins), [delegation](hub-and-spokes.md#spoke-to-spoke-discovery-and-delegation) and [wake service](hub-and-spokes.md#wake-service).

### Moving a thread between members

Before shutting down or restarting a computer, a person can move a Chat, Work or Code thread to another of their computers and carry on there; a Code thread that cannot move hands over through its branch (maintainer request, 2026-11-07).

- Only planned moves: a computer that dies without warning hands nothing over.
- Only a person starts a move. The destination accepts it only with an owner device's own fresh unlock and its Move in peer-grant item, and the moved thread is the person's own thread there.
- The unlock comes from this Mac's Touch ID, or from an owner phone that confirms a move the window holds for it: the phone asks the destination for the ticket with its own fresh unlock there, bound to the ticket route and the body naming the source and the held threads, and hands the source only the ticket id under an administration-class unlock on the source. The source holds the move for five minutes in memory, freezes nothing until the phone confirms, and spends each confirmation once. Built. When a move starts waiting, the source tells its owner phones through the existing sealed phone notification path, once per wait (a batch for one destination is one), only to paired devices of guests on its own owner list whose Approval needed setting is on, saying only that a move waits and the destination's name; tapping it opens the phone's Moves waiting for you list, and with Notifications off nothing is sent (maintainer request, 2026-11-09). A browser passkey cannot confirm a move: a passkey belongs to one origin and every request that changes something stays same-origin, so it would need a cross-origin read and write to the source; not planned, since Touch ID and an owner phone cover the move.
- The source freezes the thread before anything is sent and erases its copy through the ordinary purge only after the destination commits, so one copy takes turns at a time unless the person chooses otherwise.
- History, attachments, original inputs, generated images, captures, owned Canvases and a Code thread's branch and uncommitted work travel with no size limit; credentials, the provider's session, Full access, grants, processes and ignored files never do. Each bulk part is re-homed under the new thread with new ids; one the source cannot read stays behind and the "Moved to" record names it, and one the destination cannot record refuses the arrival. The Secret guard reads a Code thread's checkout and a Work thread's folder files, not these parts.
- A Work thread brings the files of its own folder and works where they land on the destination (maintainer request, 2026-11-09). Which files one thread made in a shared folder cannot be told reliably (its shell and the provider's own tools write too), so only a folder the thread is the sole user of travels: the subfolder of the Project's main folder it was started in, with no other Work thread working in or below it and no Project's folder in it. A thread in the Project folder itself or in an extra folder moves only itself. Ignored files, `.git`, links, special files, files the Secret guard refuses and anything past 10,000 entries stay behind; the rest travel as one `work-files` part with each file's size, digest and permission bits (`mode & 0o777`, never setuid, setgid or sticky) in the thread bundle, counted in the move's size, and land with those bits, created with them and never wider first; the folder's own bits and those of every folder inside it travel and land the same way (made private while filled, then set exactly). Every file is read through a handle opened without following a link whose device and inode must match what the walk recorded, so a file or folder swapped for a link after the walk is never read; it stays behind and is named. The destination never writes into a path that holds anything: it lands in `<folder>-moved-<move>` instead, and refuses with `transfer-failed` when that is taken too. Files land through a staging folder renamed into place before the thread opens, so a retry finds its own landing and lands nothing twice. Packing and landing finish partial writes; zero-progress or failed writes never acknowledge arrival, and the destination verifies completed file sizes before acceptance. At erase the source deletes only what it has just proved travelled, never recursively: each travelled file is renamed into a set-aside folder beside the folder, named for the move, compared there, and deleted on a match or put back (as `-kept` beside a path taken again) otherwise, and folders go bottom-up with a plain remove that fails on anything left, so an editor's write during the clean-up survives; the start of the clean-up is recorded before the first file is set aside, a failed one records no outcome, and every clean-up first settles what an earlier, stopped one left set aside, reporting the folder removed only when nothing is left there or in it; when anything is left the folder stays in place and the "Moved to" record and tombstone name it and what stayed, with no remove action, and a repeated erase reports the same. Built.
- A Code thread that cannot move is committed to its branch with a generated note, pushed when it has a remote (never forced, never to the default branch), and continued elsewhere with the note as outside content. There is no file export. The source side, the agent's bounded summary turn (on by default, two minutes, tool-free in plan mode, the note goes without it when it fails), the notice, the Handovers card, Continue handover, the source's erase, and a branch found without a notice (continued on the destination's own default model, erased on the source only for the commit it made) are built.
- A thread's move starts only in its Environment tool, whose Computer card lists the person's other computers with each one's eligibility and opens a move sheet stating what moves, what stays and that the source is erased; Prepare to shut down is the one host-wide entry (maintainer request, 2026-11-08). The Computer card, the move sheet with its sizes and estimate and with Move after this turn and Stop and move, their notices, the frozen bar and the pane tombstone are built. Open there opens the moved thread on the destination's own web app in the default browser, through the continue link its paired-browser screen reads, so that page admits the browser as it already would and this computer grants nothing; the desktop builds the page from the host's answer for the thread and opens only https on a Tailscale name, and a destination with no web app gets the copied link with a sentence saying this window can't open it (maintainer request, 2026-11-09). Built; a view of another member's thread inside this window is not built.
- A moved thread's pane on the source shows its tombstone, also when reopened after the purge from an old link, a notification, or a search (the shell opens only that thread's own pane for a recorded departure, binding no Project and granting no thread authority), and a kept worktree's files with Remove worktree: a person's act at a local desktop window showing that pane, naming the move rather than a folder, which removes only the linked worktree the move recorded (its branch and every remote stay), journals it once, and answers a second press the same (maintainer request, 2026-11-09).
- Prepare to shut down asks before anything moves: each thread starts on Move when the destination can take it (Move after this turn when busy) and on Leave here with its reason otherwise; a handover or Stop and move is never preselected, so the usual case is one press and one unlock per destination. The quit confirmation offers Move threads first when another member can take a thread (maintainer request, 2026-11-08). The dialog, the application menu and menu bar entries, the batch ticket, Move threads first, each row's size with the total's estimate (read per destination), Hand over and Stop and move as row choices, per-row destinations, one unlock per destination asked in turn, and the menu bar progress are built. A row's Hand over acts for the whole host, as the batch does, and hands over only a Code thread on this host, not delegated or waiting to move, that the head's destination cannot take, without the agent's summary turn; files it leaves out because they hold a secret are named on its row and in place of a plain Safe to shut down (resolved with its implementation, 2026-11-09).
- Before a move, the move sheet and Prepare to shut down show what it would send and an estimate that names its basis: the rate the latest full chunks to that member reached while the host runs, or an assumed 1 MiB a second. Measuring packs, freezes and writes nothing, and a size that cannot be read shows as unknown without blocking the move (maintainer request, 2026-11-09). The size counts the bulk parts a move would carry, from the byte sizes their stores record and each owned Canvas as the text its part holds, reading no part's bytes; an admitted input the scope-aware reader would refuse is not counted; the move sheet shows them as one What moves row, and a kind of part whose sizes cannot be read shows that row as Size unknown, is left out of the total, and leaves the rest measured (maintainer request, 2026-11-09). Built.
- Stop and move is only the person's choice in a window, checked per thread on the server: the destination's unlock is redeemed before anything stops, the thread's turn stops through its own mode's Stop and its child runs here and elsewhere are cancelled, and a turn still running two minutes later ends the move with `busy`. A thread with a child run or delegated child still going reads as busy (resolved with its implementation, 2026-11-09). Built.
- A move that cannot finish always ends in an explicit This thread can't move error with one journaled reason; the thread unfreezes and stays on the source, and Prepare to shut down never says Safe to shut down while a chosen thread failed (maintainer request, 2026-11-08).

Status: Partly built. Since: 2026-11-07. Detail: [Hub and spokes: moving a thread to another member](hub-and-spokes.md#moving-a-thread-to-another-member) and [Design system: shell and layout](../../DESIGN.md#shell-and-layout).

### Octant Nightly

Octant Nightly is a second desktop app that installs beside Octant, follows the preview ring (scheduled builds of `main`), and works on the same data. Octant's host alone owns the data folder. Octant itself is one binary whose in-app channel switch is Stable | Preview | Nightly (maintainer decision, 2026-11-05): Nightly keeps Octant on the candidate ring and adds the install row, and Octant never follows preview.

- By default Nightly connects to Octant's running host as a client and never runs a host on Octant's data; it needs Octant installed.
- For development and testing, a person can opt Nightly into its own host on separate test data, with its own port and Keychain service names; it never touches Octant's data or host.
- Nightly has its own bundle id, link scheme, command-line tool and window storage, and holds no thread or Project data.
- Both macOS desktop mains use sealed fixed entry roles. The same-version worker runtime keeps host/tool/extension Node execution under a distinct identity that native peer admission must refuse. Detail: [fixed entry](nightly-app.md#fixed-packaged-entry).
- Octant on the Nightly channel offers Nightly as an opt-in install, only on the person's action, after verifying the signed feed, the artifact hash and a Nightly-specific code-signature requirement.
- A build's flavor follows its ring (stable and candidate package as Octant, preview as Nightly), one app's update can never install the other, and Nightly is published only after an Octant build exists.
- A Nightly client reaches the host's native operations only through a distinct per-window native-main token, on a closed route allowlist and bound to the window lease; remote access, hubs, pairing, launch sessions, owner unlock and host identity stay Octant-only and are hidden in Nightly (maintainer decision, 2026-11-06). The per-channel classification, the hidden Octant-only screens, the host's token admission with its brokered feature list, and the pickers, file handoffs, provider keys and API key pools, and Code operation approvals that use it are built; a host without a feature is refused as needing a newer Octant. Detail: [native-main admission](nightly-app.md#native-main-admission).
- Every embedded Browser gap, accessibility included, blocks the first Nightly publication (maintainer decision, 2026-11-06). Page popups are built: Stable holds a select list, page dialog, link or image menu and file chooser in its hidden window and Nightly shows each natively over the existing presentation route, with single-use identities and no new authority; `window.open` keeps Stable's refusal. Fields are built too: email, number and rich text editors compose with a caret on its own line, a password field reaches Nightly as its identity alone while Nightly holds macOS secure input, and fields, composition, editing menus and popups work inside same-site and cross-site frames through Stable's own protocol attachment. Accessibility is built: while an assistive technology reads Nightly, Stable sends a bounded, schema-checked mirror of the page's accessibility tree (roles, names, values except a password field's, states, page bounds, order, focus and live regions, across frames) that Nightly renders as a transparent DOM subtree for VoiceOver, and its actions return as the person's own input, refused while an agent holds the page; the physical VoiceOver check is a maintainer item. Detail: [standard text composition](nightly-app.md#standard-text-composition), [page popups](nightly-app.md#page-popups) and [accessibility](nightly-app.md#accessibility).
- Windows Nightly uses the same explicit local-user trust floor as Linux through a native private-profile named pipe: kernel-held PID/creation, matching SID/logon/session, remote/restricting-SID/AppContainer refusal, fixed bounded status/window protocol and nonce-separated per-connection lease revocation. No executable, command line or caller identity attests signed application code; same-user unconfined code remains inside the stated trust floor. Desktop and ordinary client consume only fixed packaged native resources and native profile scope; actual native/packaged lifecycle acceptance remains required. A native owner-published fixed launcher record binds the current image and physical identity; bounded asynchronous validation holds the package against other-user writes before exact host-only process creation. No JS path/environment or launch receipt grants authority; publication failure remains nonfatal and fresh status/window admission remains required. Test-data, installation and Work/Code keep separate gates. Detail: [Windows client trust](nightly-app.md#windows-client-trust).
- Linux Nightly stays in scope with its own client trust (maintainer decision, 2026-11-06): packaged Octant listens on a `0600` path socket in the private per-user runtime folder, and each side admits the other only for the same user, a pidfd-held process incarnation, the same mount, user and PID namespaces and root, and a per-message kernel credential; executable paths and `$APPIMAGE` grant nothing, and Nightly registers no window while its renderers run unsandboxed. Both packaged Linux apps refuse launch flags outside the fixed roles and a closed list of display flags (Ozone platform, a few Wayland and video features, GPU off, scale factor). A closed Octant starts only from the launcher record its last packaged launch wrote, by descriptor, with the host-only role and a minimal environment. Nightly's Linux test data names its own Secret Service `service` values, and Remove clears them. The stated limit, that same-user unconfined code can pass, is accepted. Built; a packaged pair on a real Linux desktop is not yet exercised. Detail: [Linux client trust](nightly-app.md#linux-client-trust).
- `octant-nightly` is the same command-line source under Nightly's identity record. It attaches to Octant's host by default, or to Nightly's test host on port `13774` when the stored Data choice is test data (read with the desktop's rule, failing closed to Octant's data), never starts, stops, installs or migrates a host, refuses the commands that would, and reports "Needs a newer Octant" when the host lacks a route it needs. Packaged macOS Nightly runs it with its worker runtime from a fixed signed resource. Detail: [the `octant-nightly` command](nightly-app.md#the-octant-nightly-command).
- A synthetic Nightly client smoke runs on every pull request without secrets: the ordinary Nightly client against a development host that a synthetic Stable owns with Stable's own lease owner and client lifetime, standing in only for the signed native binding, and never packaged. It covers the renderer, a Chat turn with a brokered key, brokered pickers, keys and approvals, the embedded Browser, lease loss, host restart, two separate hosts, quit-one and quit-last; an unsigned packaged Nightly smoke runs locally, not in CI. Detail: [synthetic client smoke](nightly-app.md#synthetic-client-smoke).
- The signed feed names the app it is for, and each app refuses a feed for the other (maintainer decision, 2026-11-06). Built: current feeds live at app-named files, Octant builds once published on preview are never offered Nightly, and older candidate installs get an old-shape document. Detail: [which build is which](nightly-app.md#which-build-is-which).
- Rollback is a roll-forward: a dispatched run rebuilds a published Nightly tag on `main` under a strictly newer version, and the feed key stays in a job that never runs the built source. Each Octant release publishes an advisory, unsigned `octant-host-features.json` for the Nightly compatibility check. Built; not yet exercised on a published release. Detail: [Nightly's own updates](nightly-app.md#nightlys-own-updates).
- A Nightly run is built, signed and published only after its usable-client preflight passes, which replaces the early gate: two secret-free jobs check the channel table (every core channel answered by Nightly), the synthetic client smoke, an unsigned packaged Nightly (payload, development-build refusal, test-data host) and Linux client trust, and require the newest published Octant's `octant-host-features.json` to carry Nightly's protocol and every feature it needs; a signed Nightly is checked again after notarization (Developer ID, fuses, peer-status addon, link scheme, command, no harness). A dispatched Octant candidate skips it. Publishing still needs a maintainer's approval of the first scheduled publication. Built; not yet run on a scheduled release. Detail: [the usable-client preflight](nightly-app.md#the-usable-client-preflight).
- Identity, packaging, the 2026-11-05 channel split, authenticated window-bootstrap and validated Stable host-only launch and current-client retention foundations built; the Preview install row is built for packaged macOS Octant without a signed install yet exercised; Nightly's own test-data host built for macOS and Linux (Settings choice, relaunch, removal, Test data label, its own folder, port, logs and Keychain service names, packaged host payload and worker runtime) without a signed run yet exercised; every desktop channel classified for the Nightly client with Octant-only administration hidden; Nightly's local native surfaces built (application menu without developer tools when packaged, external links, notifications and Dock badge, `octant-nightly://` links, bounds reset, sidebar material, window capture, the Open in list and Browser proof saving); native-main token admission on the host's closed route allowlist with a brokered feature list built; the full `octant-nightly` command built (host selection, never a host, Needs a newer Octant, packaged worker-runtime resource) without a signed packaged run; Nightly's pickers, file handoffs, provider keys and API key pools, and Code operation approvals through it built; embedded Browser page popups (select lists, page dialogs, link and image menus, file chooser) and fields (email, number, password with secure input, rich editors, multiline caret, nested frames on either site) and accessibility (a bounded mirror VoiceOver reads and operates) built without a packaged Electron run or a physical VoiceOver check; the synthetic Nightly client smoke with quit-one, quit-last, lease-loss and host-restart reconnect and separate-host evidence built and in CI, and the unsigned packaged Nightly smoke built for local runs; remaining brokered Nightly flows (Canvas, tools, a second window), the app-named signed feed, roll-forward rollback dispatch and the published host feature list built; Linux client trust built (path socket, kernel peer checks, launcher record, test-data Secret Service family); the usable-client preflight in place of the early gate built; maintainer checks (signed pair, signed install, real-account sign-ins, physical IME and VoiceOver, an Octant candidate carrying the host feature list, approval of the first scheduled publication) and installation pending.

Status: Partly built. Since: 2026-11-05. Detail: [Octant Nightly: one host serves both](nightly-app.md#one-host-serves-both), [maintainer decisions](nightly-app.md#maintainer-decisions-2026-11-06), [what a client window offers](nightly-app.md#what-a-nightly-client-window-offers), [before Nightly publishes](nightly-app.md#before-nightly-publishes) and [getting Octant Nightly](nightly-app.md#getting-octant-nightly).

## Code tooling

### Language servers

A Code thread's editor gets diagnostics and go-to-definition from separately launched language servers that run under Code Project and thread authority. They are an executable component kind on the activation ladder.

- Language servers are Code only, quarantined until reviewed, and installing one never trusts or enables it.
- A `static` server reads the checkout read-only with no network and no exec, needs no approval, and serves Plan; a `repo-tooling` server runs confined like a terminal with per-checkout approval, proxied network, and is refused in Plan.
- The repository never chooses what runs; executable, arguments, environment and class come only from the enabled component.
- The bundled native language server is on by default for Code, with a Settings switch; a per-Project setting "Use the Project's own toolchain" uses the Project's own copy of that language toolchain instead (maintainer request, 2026-11-12); not built yet: today the Project's own copy is not used.
- Paired devices may read results; starting a `repo-tooling` server stays local-host only.
- Agents get one read-only tool, `octant_code`, with `diagnostics`, `definition` and `references` operations, available in Plan and asking nothing, that never starts a `repo-tooling` server and may read through one that is already approved and running (maintainer request, 2026-11-12); not built yet: today it never reads through one (real-provider smoke owed).
- `octant_code` is offered on a Code turn only when an effective `static` server covers a file a bounded scan finds in the turn's checkout or extra folders; `references` returns at most 200 places, `references` and `diagnostics` stop before their list passes 48 KiB so a result fits the provider's tool result budget, and each says when it was cut.
- The editor's acknowledged-document read seam also serves capability-checked completion, hover, signatures, symbols and formatting; replies contain bounded text and ranges, never server commands or edits to other files. Shared Work/Code editing, recovery, conflict comparison, reviewed replacements and selection-to-agent drafts follow [Workspace: File editing](workspace.md#file-editing).
- Octant hosts no other editor's extension API.

Status: Partly built. Since: 2026-10-26. Detail: [Language services: launch classes](language-services.md#launch-classes), [authority](language-services.md#authority) and [maintainer decisions](language-services.md#maintainer-decisions).

### Debugger

A person at a local window picks a debug configuration and starts a confined debug session, and an agent may start, control and read one: unasked at Full access, approval-gated per configuration below it, and refused in Plan. A paired device that is not an owner device stays refused (maintainer request, 2026-11-12). Not built yet: today no agent, tool, paired device or routine can start, control or read a session.

- Below Full access each start needs a confirmed configuration (the shell-command approval) that covers the current configuration and adapter package; at Full access a start is unasked. Not built yet: today each start is a person's act and Full access does not skip the confirmation.
- Configurations found in the repository are proposals that run only after the person confirms them.
- Plan refuses debugging, and the program is confined by the thread's posture as a terminal is.
- Sessions, seam and panel are built; the macOS confined-program smoke needs a Mac (not built yet).

Status: Partly built. Since: 2026-10-27. Detail: [Language services: debugger authority](language-services.md#debugger-authority) and [approval and starting](language-services.md#approval-and-starting).

## Disposable desktops

### Leases and authority

A Project owns at most one desktop recipe that only a person edits, and a thread leases a throwaway desktop from it. The server checks every lease command against the thread's current authority before any provider call.

- A lease belongs to one thread, a thread holds at most two by default, and only Work and Code threads may lease. The per-thread and per-host counts are recipe or Settings defaults (maintainer request, 2026-11-12); not built yet: today they are constants.
- Failures are named refusal values, never throws or hangs.
- Teardown runs on a host-owned path that stays authorized after thread archive, recipe removal or plugin disable, and can only release, verify and list.
- Any client that may open the thread may view and operate its desktop; the person's own input needs no approval and is journaled.

Status: Partly built. Since: 2026-10-26. Detail: [Disposable desktops: model](disposable-desktops.md#model) and [authority](disposable-desktops.md#authority).

### Desktop isolation and transfer

A desktop holds no host credential and no checkout. Host files enter only through an explicit, journaled transfer of one checkout-relative file; the separately approved preview carries only the named application’s HTTP/WebSocket traffic.

- A host-local desktop runs in a dedicated Linux sandbox with its own network namespace and no host loopback, and gets network through a filtered egress proxy that refuses loopback, private and host addresses (maintainer request, 2026-11-12). Not built yet: today it never has network, a recipe that asks for it is refused, and only a cloud recipe without a placement may allow network.
- A cloud desktop's key stays in the host credential store and never enters the desktop.
- Nothing is copied back except screenshots and recordings as host-held evidence.
- A transfer to a cloud desktop asks unless the person turned "Confirm each billed desktop" off, and Plan refuses transfers (maintainer request, 2026-11-12); not built yet: today it always asks, in every posture.
- A local person may review and grant one healthy Octant-owned dev-server port from the Code task's own worktree to its ready host-local Linux lease. The portable provider seam exposes only bounded HTTP/WebSocket operations; an authenticated exact-socket IPC exception preserves the guest's separate network namespace and denies other host ports. Permissions expire with the original lease, invalidate with authority/binding/window/provider loss, never restore after restart and block replacement grants while cleanup is unconfirmed. E2B and Cua report this capability unavailable. The actual production-launch namespace proof is mandatory before enabling the new path.
- The local adapter and grant path are covered by the required hosted production-launch namespace proof; packaged desktop GUI acceptance remains separate.

Status: Partly built. Since: 2026-10-26; host-local lease-bound preview 2026-11-07. Detail: [Disposable desktops: isolation](disposable-desktops.md#isolation), [artifact transfer](disposable-desktops.md#artifact-transfer), and [lease-bound dev-server preview](disposable-desktops.md#lease-bound-dev-server-preview).

### Desktop lifecycle and teardown

Every lease has a hard expiry, and ending a lease always destroys the desktop and verifies it is gone.

- A lease expires after 30 minutes and an idle lease is released after 15 minutes by default, both recipe or Settings defaults; a person may extend a lease to the recipe maximum of 4 hours, and an agent may extend a host-local lease up to the recipe's maximum, while a billed lease keeps a hard expiry (maintainer request, 2026-11-12). Not built yet: today the lease length and idle release are constants and an agent cannot extend.
- The host journals a lease before calling the provider and tags the resource, so a crash leaves something findable.
- On restart the host destroys every unreleased lease and orphaned tagged resource before admitting a new one.
- Release counts only when the provider confirms the resource is absent; otherwise the lease stays release-failed and blocks new leases on that provider.

Status: Partly built. Since: 2026-10-26. Detail: [Disposable desktops: lifecycle and teardown](disposable-desktops.md#lifecycle-and-teardown).

### Desktop providers and billed placements

Desktop providers are plugin contributions through the `desktop-provider` seam; the host owns leases, authority and teardown, and the driver only translates. Cloud desktops run only on the person's own account, and Octant operates no cloud.

- A billed or off-machine lease is confirmed by a person unless they turned the confirmation off. Inside the monthly cap the per-lease confirmation of a billed or off-machine lease, and of a transfer to a cloud desktop, is the setting "Confirm each billed desktop", on by default, and the cap stays mandatory (maintainer request, 2026-11-12); not built yet: today the confirmation cannot be switched off.
- Billed desktops are off until a person sets a monthly spend cap; each lease is estimated first, refused over the cap, and agents and paired devices cannot change the cap.
- A billed provider must set a provider-side expiry, or the host destroys the desktop.
- A daemon-backed placement is chosen per recipe; Octant stores no credential for the daemon and never installs or starts it.
- A desktop on this machine is a virtual machine with no network until a live check proves otherwise; the filtered egress proxy in [Desktop isolation and transfer](#desktop-isolation-and-transfer) is not built yet.
- The drivers are built against recorded and fake providers and are offered on every host (E2B everywhere, the Cua daemon driver on Linux); live smokes are owed.

Status: Partly built. Since: 2026-10-28. Detail: [Disposable desktops: provider seam](disposable-desktops.md#provider-seam), [authority](disposable-desktops.md#authority) and [billed placements](disposable-desktops.md#expiry-and-teardown-when-the-daemons-host-may-die).

## Bots

### Bots, with Navigator as the lead bot

A bot is a lasting, app-wide assistant on one host: a name, avatar, role, instructions, model and access level, a host-managed Work home, one conversation that never ends, its own memory and routines, and optionally its own sandboxed desktop. Navigator is the lead bot on every host. Threads and tasks keep their behavior.

- A bot is not a fourth mode: its conversation is a Work thread in its own home Project, so it has a Work thread's tools and authority, and routines a bot owns post into that conversation.
- Navigator moves to a Work conversation as the lead bot; it cannot be deleted, and it acts on its own within its access level.
- A new bot starts at Auto where its provider has its own reviewer (Claude Code, Codex) and at Ask first otherwise; it does not start at Full access by default, and the person may change that (maintainer request, 2026-11-12). At Auto, Octant Shield answers once a web page withdraws the provider's reviewer.
- Paying, buying, or sending a message as the person always asks, at every level and in routines, when the action is classified as such; inside a bot's own desktop there is no site approval and no first-action ask.
- The sidebar rail shows pinned bots with their status; All bots lists every bot from every connected host; the paired browser and the phone show the same bots, may create bots and may answer bot cards, except billed desktop starts and login grants.
- A bot desktop is kept between uses and runs in a Docker-compatible engine or Apple's container tool on this machine, or with E2B or Cua; it reaches the web only through a host proxy that refuses private and host addresses, and holds no host credential or checkout.
- A bot signs in with logins the person gave it, only on those logins' sites and without asking, also in routines; the host fills them into the bot's browser and the model never reads them. Ask me each time is a per-login choice.
- Bots ask each other by name and share rooms under the existing agent messaging limits; a person can call a bot by voice; a bot can carry on with a fallback model.

Status: Designed, not built. Since: 2026-11-08. Detail: [Bots](bots.md).
