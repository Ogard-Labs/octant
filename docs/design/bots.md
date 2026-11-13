# Bots

Status: Approved (2026-11-08, maintainer)
Size: Full — a new app-wide concept that crosses the server, web, mobile, the
desktop-provider seam, the Browser, routines, and the credential broker.
Owner: maintainer · Started: 2026-11-08 · Approved: 2026-11-08, maintainer
Working assumptions: ASM-1 to ASM-4 below; each is checked in the slice that
leans on it.

This document is the design for bots. It changes no rule by itself:
the owning specifications (Workspace, DESIGN.md, Architecture, Disposable
desktops, Browser for agents, Browser profiles) keep authority, and each built
slice moves its rules into them and into
[Decisions and requirements](decisions.md).

Scope hold: bots take no new scope until
[the Full access rule](../architecture.md#security-and-authority) is built
(maintainer request, 2026-11-12).

## 1. Requirements

### Sources

| ID  | Location                                                 | What it contributes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Maintainer, 2026-11-08 (first request)                   | "Transition into bots support"; "Navigator should be the main and default bot, but allow users to make additional ones"; "a good UI/UX for bots".                                                                                                                                                                                                                                                                                                                                                                                               |
| S2  | Maintainer, 2026-11-08 (second request)                  | Bots are app-wide like Navigator; persistent assistants that "own automations and scheduled tasks"; "Threads/Tasks stay as they are"; "Navigator can act on its own if instructed"; "the same capabilities as threads"; "ideally" reachable from every device in the same interface; a unified view of all bots across hosts; pinned bots on the outer-edge rail and an all-bots view like threads; Docker sandboxing so each bot gets its own desktop with a browser; act on the person's behalf; pass credentials safely.                     |
| S3  | Maintainer's competitive research, 2026-11-08 (chat)     | Patterns that work: a starred lead bot; one never-ending conversation per bot; creation from a one-sentence job description, templates, and saved defaults; per-bot memory and routines; status on every avatar; a per-bot computer with live view and take-over; sign-in cards instead of passwords in chat; letting a bot manage other bots is off by default. Anti-patterns: full access by default; several bots sharing one folder or one credential pool.                                                                                 |
| S4  | Current code and specifications on `main`                | Navigator is a hidden Chat thread whose only command is `send-message` (`apps/server/src/navigatorAssistant/navigatorAssistantService.ts`); [Disposable desktops](disposable-desktops.md); [Browser for agents](browser-agent-tool.md) sign-in hand-off and 1Password fill; [Browser profiles](browser-profiles.md); the client-side host federation (`packages/client-runtime/src/hostFederationRegistry.ts`); Project-bound routines ([Architecture](../architecture.md)); the icon rail (DESIGN.md); the remote shell and the mobile client. |
| S5  | [AGENTS.md](../../AGENTS.md) and Architecture principles | Server-enforced modes and authority; no fourth authority mode; a thread never changes kind; plugin-shaped providers; no Octant-operated cloud; detect binaries, never install them; honest capability reporting.                                                                                                                                                                                                                                                                                                                                |
| S6  | Maintainer, 2026-11-08 (answers to Q-1 to Q-7)           | Q-1: yes, bots are in the phone app too and cards can be answered there. Q-2: yes, unattended sign-in. Q-3: yes, the public web minus private ranges. Q-4: "ask first or auto-accept if available from provider like claude or codex". Q-5: yes, add Apple's container tool. Q-6: "payments and sending messages must have a confirmation". Q-7: yes, a paired device can create a bot.                                                                                                                                                         |
| S7  | Maintainer, 2026-11-08 (plan review)                     | Keep the review suggestions, but "we must have a product that matches other bots without unnecessary friction"; "we might still have too strict rules"; Octant must be able to edit AGENTS.md when the person asks.                                                                                                                                                                                                                                                                                                                             |

### Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                | Priority | Acceptance criterion                                                                                                                                                                                                                                                  | Sources    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| FR-1   | A bot has a name, an avatar, a role line, standing instructions, a provider and model, and an access level. A new bot starts at Auto when its provider has its own reviewer (Claude Code, Codex), and at Ask first otherwise (D-11).                                       | Must     | Creating a bot with each field set and reading it back returns the same values; a turn in its conversation runs on that model with those instructions; a new Claude Code bot starts at Auto and a new bot on a provider without its own reviewer starts at Ask first. | S1, S2     |
| FR-2   | Navigator is the default bot on every host: it exists without setup, is marked as the lead bot, can be renamed and given an avatar, and cannot be deleted.                                                                                                                 | Must     | A fresh host lists Navigator first; deleting it is refused; renaming it changes every place its name shows.                                                                                                                                                           | S1         |
| FR-3   | A person can create more bots three ways: describe the job in one sentence (Navigator drafts the bot for review), start from a template, or fill a blank form, from any client that can reach the host, the phone included. New bots start from defaults the person saves. | Must     | Each path creates a bot; the one-sentence path shows an editable draft card and creates nothing until confirmed; saved defaults pre-fill the form and the draft; a paired phone creates a bot on the host it chose.                                                   | S1, S3     |
| FR-4   | A person can delete a bot other than Navigator. The confirm dialog names what is removed: its conversation, routines, desktop, browser profile and grants.                                                                                                                 | Must     | After confirm, the bot, its routines, its desktop volume and its grants are gone and the journal records who deleted it; Cancel removes nothing.                                                                                                                      | S1         |
| FR-5   | Each bot has one conversation that never ends, shown with the same transcript as threads: streaming replies, tool activity, cards, Stop, a multi-line composer, attachments.                                                                                               | Must     | A reply streams while the turn runs; Stop interrupts it; an approval card and an image card render in a bot conversation.                                                                                                                                             | S2, S3, S4 |
| FR-6   | A bot's turns have the same capabilities as a Work thread: files in its own home folder, Browser, Canvas, images, child agents, side tasks, memory, web search, and the skills and connectors enabled for it.                                                              | Must     | A bot turn is offered the same tool set a Work thread on the same model is offered, minus tools the person turned off for that bot.                                                                                                                                   | S2         |
| FR-7   | A bot owns routines and scheduled tasks. A run posts into the bot's conversation as a turn marked "started by a routine", queued behind a running turn.                                                                                                                    | Must     | A weekly routine on a bot runs at its time, its turn appears in the bot's conversation with the routine marker, and a run that starts while a turn runs waits for it.                                                                                                 | S2, S3     |
| FR-8   | Each bot keeps its own memory, which the person can read and edit.                                                                                                                                                                                                         | Should   | A fact the bot saved shows on its Memory tab; deleting it there removes it from the next turn's context.                                                                                                                                                              | S3         |
| FR-9   | A bot can start and follow ordinary threads in Projects the person grants it. Those threads stay ordinary threads, labelled with the bot that started them.                                                                                                                | Should   | With a grant on Project P, the bot starts a Code thread in P that lists "Started by ‹bot›"; without a grant the tool refuses.                                                                                                                                         | S2         |
| FR-10  | Navigator acts on its own when instructed, within its access level: it opens views and threads, starts tasks and changes settings it has tools for, asking only where the level requires.                                                                                  | Must     | At Full access, "open the release thread" opens it with no card; at Ask first, starting a thread shows an approval card.                                                                                                                                              | S2         |
| FR-11  | Pinned bots sit on the sidebar's outer-edge icon rail as avatars with a status badge (working, needs you, unread, failed). Navigator is first.                                                                                                                             | Must     | Pinning a bot adds it to the rail; a bot waiting on an approval shows the needs-you badge on the rail and in its accessible name.                                                                                                                                     | S2         |
| FR-12  | An "All bots" rail button opens a bot list in the sidebar column, grouped and searchable like the thread list, with pin, hide and sections.                                                                                                                                | Must     | The list shows every bot under Needs you / Working / Idle; search filters by name and role; pin and hide work from the row menu.                                                                                                                                      | S2         |
| FR-13  | The rail and the bot list show bots from every connected host in one view. A bot shows its host when more than one is connected; an unreachable host's bots stay listed, read-only, marked stale.                                                                          | Must     | With two hosts connected, both hosts' bots appear in one list; disconnecting one keeps its bots listed as stale and refuses sending to them.                                                                                                                          | S2         |
| FR-14  | Bots are reachable from every client in the same interface: the remote web shell serves the rail bots, the bot list and bot conversations; the phone has a Bots tab with the same list and conversation.                                                                   | Must     | A paired browser and the phone list the same bots as the desktop window and can send a message to each.                                                                                                                                                               | S2         |
| FR-15  | A bot can have its own sandboxed desktop with a browser. It persists between turns and host restarts (files and browser profile), and the person can watch it live and take over.                                                                                          | Must     | Files and a site sign-in made on day 1 are still there on day 2 after a host restart; the Desktop tab shows the bot's screen and the person's input reaches it.                                                                                                       | S2, S3     |
| FR-16  | A bot desktop can run in a local container engine (Docker-compatible) on this machine, or with the existing E2B and Cua providers.                                                                                                                                         | Must     | With a Docker-compatible engine running, a bot desktop starts locally; with no engine the host reports why and offers the other providers.                                                                                                                            | S2, S4     |
| FR-17  | A bot's Browser tool and Computer tool act inside its own desktop, not on the person's computer.                                                                                                                                                                           | Must     | A bot's Browser `navigate` opens the page in its desktop browser (visible in the Desktop tab); nothing opens on the host.                                                                                                                                             | S2         |
| FR-18  | A bot can act on websites on the person's behalf (forms, posts, purchases) under its access level. In its own desktop no per-site approval is needed (D-16).                                                                                                               | Must     | At Ask first, submitting a form asks first; at Auto or Full access the bot's own browser acts on a new site with no site approval; a payment or a send still asks (FR-24).                                                                                            | S2, S7     |
| FR-19  | A person can give a bot logins: a login Octant keeps in the system credential store, or a 1Password item. Each is limited to its own sites. The bot signs in without ever reading the password.                                                                            | Must     | The bot signs in to the login's site; the model's input, the journal and the renderer never contain the password; the same login on another site is refused.                                                                                                          | S2, S4     |
| FR-20  | A login given to a bot is used on its own sites whenever the bot needs it, while the person watches or in routines, without asking. Per login, the person may choose Ask me each time. Every use is journaled and shown in the bot's activity.                             | Must     | With a login given, a routine run signs in with no card and the use shows in the bot's activity; with Ask me each time on, an attended turn shows a card and a routine run waits with Sign in needed.                                                                 | S2, S6, S7 |
| FR-21  | Without a usable login, the bot asks with a Sign in needed card; the person signs in through the Desktop tab and the session stays in the bot's browser profile.                                                                                                           | Must     | The card's Open goes to the bot's desktop; after Done the bot continues signed in; the next day the session is still valid.                                                                                                                                           | S3, S4     |
| FR-22  | Removing a login from a bot stops its use at once; deleting a bot or clearing its browser profile removes stored sessions.                                                                                                                                                 | Must     | After removal a fill is refused even in a running turn; after Clear browser data the next visit is signed out.                                                                                                                                                        | S2         |
| FR-23  | Quick ask: a shortcut opens a small composer to message any bot without leaving the current view, sharing that bot's conversation.                                                                                                                                         | Should   | A message sent from Quick ask appears in the bot's conversation tab.                                                                                                                                                                                                  | S3         |
| FR-24  | Paying, buying, or sending a message as the person (email, chat, social post, a form that sends a message) always asks the person first, at every access level and in routines; an unattended run waits for the answer.                                                    | Must     | At Full access, submitting a checkout or a send form shows a confirmation card and nothing is sent until it is approved; a routine run reaching one waits with a needs-you badge.                                                                                     | S6         |
| FR-25  | A paired device and the phone can answer every one of a bot's cards (approvals, questions, sign-in hand-offs, billed desktop starts and login grants), as a window on the host can (maintainer decision, 2026-11-12, which removes the two exceptions S6 kept).            | Must     | An approval, a billed start or a login grant answered on the phone lets the turn continue.                                                                                                                                                                            | S6         |
| FR-26  | On macOS 26 with Apple silicon, a bot desktop can run in Apple's container tool, one lightweight VM per desktop.                                                                                                                                                           | Should   | With the tool running, a bot desktop starts in it and passes the same isolation and network checks as a Docker-compatible one.                                                                                                                                        | S6         |
| FR-27  | Bots can ask each other for help by name and work together in shared rooms where one bot owns the task at a time and hands it on in a message.                                                                                                                             | Must     | A bot asks another bot by name and gets its answer in its own conversation; in a room with two bots and the person, a hand-off message moves ownership and the person sees who owns the task.                                                                         | S3, S7     |
| FR-28  | The person can talk to a bot by voice from the bot's conversation; the lead bot speaks first with what needs the person.                                                                                                                                                   | Should   | A voice call with Navigator opens with what is waiting for the person; a spoken request becomes an ordinary message in the bot's conversation.                                                                                                                        | S3, S7     |
| FR-29  | When a bot's provider runs out of usage or fails, the bot can carry on with a fallback model the person chose, and says so in the conversation.                                                                                                                            | Should   | With a fallback set, a usage-limit failure on the first model continues the turn on the fallback and the transcript names both.                                                                                                                                       | S3, S7     |
| FR-30  | Each bot has a details panel with Profile (name, avatar, role, instructions), Model and access, Tools, Routines, Memory, Computer, Logins and Projects; changes save as the person edits.                                                                                  | Must     | Renaming a bot in its Profile changes its name on the rail, the list, its tab and notifications; each tab reads and writes through the server.                                                                                                                        | S3, S7     |
| NFR-1  | Authority is checked on the bot's host before every side effect. A bot never gets more than its access level; a routine never gets more than its captured snapshot.                                                                                                        | Must     | Route and service tests: a paired device, another window, and a routine each get the refusals a Work thread gives them.                                                                                                                                               | S5         |
| NFR-2  | A bot desktop holds no host credential, checkout, home directory, SSH agent, or session bus, cannot reach the host's loopback or the Octant server, and runs unprivileged with all capabilities dropped.                                                                   | Must     | A conformance test inside the desktop fails to read the host home, to reach `127.0.0.1` on the host and the host's LAN address, and to gain a capability.                                                                                                             | S2, S4     |
| NFR-3  | A login's password, one-time code and session cookie values never reach a model, a provider runtime, the journal, a renderer, logs, or a file outside the bot's desktop.                                                                                                   | Must     | A test fills a canary password, then scans the turn's provider input, the journal, the host log and the transcript for it: none contain it.                                                                                                                           | S2         |
| NFR-4  | A bot desktop reaches the network only through a host-owned egress proxy that refuses private, link-local and host addresses. By default it allows the rest of the public web; an optional site list per bot narrows it.                                                   | Must     | From the desktop, a public site loads and `10.0.0.1`, `169.254.169.254`, `host.docker.internal` and the host's LAN address are refused.                                                                                                                               | S2         |
| NFR-5  | Running bot desktops are bounded: at most two running at once by default (adjustable), stopped after 15 minutes idle, each capped in memory and CPU.                                                                                                                       | Must     | A third start waits or is refused with the reason; an idle desktop stops after 15 minutes and starts again on the next use with its state.                                                                                                                            | S2         |
| NFR-6  | A warm bot desktop is usable within 20 seconds of a start; the first local image build finishes within 10 minutes on a typical laptop and shows progress.                                                                                                                  | Should   | Measured on an Apple silicon laptop and a Linux host; numbers recorded in this document.                                                                                                                                                                              | S2         |
| NFR-7  | The unified bot list stays usable when a host is slow: each host read times out after 5 seconds without blocking the others.                                                                                                                                               | Must     | With one host delayed 30 seconds, the other hosts' bots show within 1 second of their reads.                                                                                                                                                                          | S2         |
| NFR-8  | Status is never shown by colour alone; every rail avatar and row has an accessible name with the bot's name, host and status, and the rail is keyboard reachable.                                                                                                          | Must     | Rendered and screen-reader checks at desktop and narrow widths.                                                                                                                                                                                                       | S5         |
| NFR-9  | Bot definitions, grants, routines and conversations are journaled; projections rebuild from the journal.                                                                                                                                                                   | Must     | Deleting the bot projections and replaying the journal restores the same bots, grants and routines.                                                                                                                                                                   | S5         |
| NFR-10 | A billed cloud desktop for a bot keeps the existing monthly spend cap and asks before every start that bills.                                                                                                                                                              | Must     | A billed start asks in every access level and is refused past the cap.                                                                                                                                                                                                | S4         |
| CON-1  | Navigator and bots are app-wide, not inside a Project.                                                                                                                                                                                                                     | Must     |                                                                                                                                                                                                                                                                       | S2         |
| CON-2  | Threads and tasks keep their current behavior.                                                                                                                                                                                                                             | Must     |                                                                                                                                                                                                                                                                       | S2         |
| CON-3  | Local desktop sandboxing uses a Docker-compatible container engine.                                                                                                                                                                                                        | Must     |                                                                                                                                                                                                                                                                       | S2         |
| CON-4  | No fourth authority mode, no change of a thread's kind, server-side authority, plugin-shaped providers, no Octant-operated cloud, detect engines but never install them.                                                                                                   | Must     |                                                                                                                                                                                                                                                                       | S5         |
| ASM-1  | The host can create a Work Project bound to a folder it manages (a bot's home) without a person picking the folder.                                                                                                                                                        |          | Checked in slice 1.                                                                                                                                                                                                                                                   | S4         |
| ASM-2  | Docker Desktop, OrbStack, Colima and Podman expose a Docker Engine API socket; a desktop with a virtual display and Chromium runs in about 1.5 GB of memory.                                                                                                               |          | Checked in slice 4.                                                                                                                                                                                                                                                   | S2         |
| ASM-3  | The host can drive the desktop's Chromium over the DevTools protocol through a host-only channel, with nothing listening beyond the host.                                                                                                                                  |          | Checked in slice 5.                                                                                                                                                                                                                                                   | S4         |
| ASM-5  | Apple's container tool runs the same Linux desktop image in one lightweight VM per container, with a virtual display and Octant's stdio screen program inside (no VNC port) and no GPU; the host reaches it on its own address.                                            |          | Checked in slice 10.                                                                                                                                                                                                                                                  | S6         |
| ASM-4  | The phone client can render bot conversations with its existing transcript screens.                                                                                                                                                                                        |          | Checked in slice 8.                                                                                                                                                                                                                                                   | S4         |

### Traceability

| Source statement                                                  | Disposition                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| S1 "Navigator should be the main and default bot"                 | FR-2                                                                                |
| S1 "allow users to make additional ones"                          | FR-3, FR-4                                                                          |
| S1 "a good UI/UX for bots"                                        | FR-5, FR-11, FR-12, FR-23, NFR-8                                                    |
| S2 bots are app-wide like Navigator                               | CON-1, D-1                                                                          |
| S2 persistent assistants that own automations and scheduled tasks | FR-7, D-3                                                                           |
| S2 "Threads/Tasks stay as they are"                               | CON-2, FR-9                                                                         |
| S2 "Navigator can act on its own if instructed"                   | FR-10                                                                               |
| S2 "the same capabilities as threads"                             | FR-6, FR-9                                                                          |
| S2 "ideally" reachable from all devices in the same interface     | FR-14 (Must since S6 Q-1)                                                           |
| S2 unified view of all bots across hosts                          | FR-13, NFR-7                                                                        |
| S2 pinned bots on the outer-edge rail, view all bots like threads | FR-11, FR-12                                                                        |
| S2 Docker sandboxing, each bot its own desktop with a browser     | CON-3, FR-15, FR-16, FR-17, NFR-2                                                   |
| S2 act on the person's behalf                                     | FR-18, FR-24                                                                        |
| S6 Q-1 bots in the phone app, cards answered there                | FR-14, FR-25, D-13                                                                  |
| S6 Q-2 unattended sign-in                                         | FR-20, D-9                                                                          |
| S6 Q-3 public web minus private ranges                            | NFR-4, D-7                                                                          |
| S6 Q-4 Ask first, or Auto with the provider's own reviewer        | FR-1, D-11                                                                          |
| S6 Q-5 Apple's container tool                                     | FR-26, D-14                                                                         |
| S6 Q-6 payments and sending messages always confirm               | FR-24, D-12                                                                         |
| S6 Q-7 a paired device can create a bot                           | FR-3, D-13                                                                          |
| S7 match other bots without unnecessary friction                  | FR-18, FR-20, FR-27, FR-28, FR-29, FR-30, D-15 to D-23                              |
| S7 Octant can edit AGENTS.md when asked                           | Outside this design (Lessons from review and the Architecture rule on agent briefs) |
| S2 pass credentials safely                                        | FR-19, FR-20, FR-21, FR-22, NFR-3                                                   |
| S3 per-bot memory                                                 | FR-8                                                                                |
| S3 quick access from anywhere                                     | FR-23                                                                               |
| S3 bots asking each other, group rooms, voice calls               | FR-27, FR-28                                                                        |
| S3 a bot managing other bots, off by default                      | Later                                                                               |
| S3 fallback providers when usage runs out                         | FR-29                                                                               |
| S3 anti-pattern: full access by default                           | FR-1, D-11 (never Full access)                                                      |
| S3 anti-pattern: shared folder or credential pool                 | D-1 (own home), D-8 (per-bot grants)                                                |

### Dependencies and conflicts

- FR-15 to FR-22 depend on the bot core (FR-1, FR-5, FR-6).
- FR-17 needs FR-15. FR-19 to FR-21 need FR-17.
- **Conflict: local desktops.** [Disposable desktops](disposable-desktops.md#maintainer-decisions)
  decision 1 (2026-10-26) lists a host-local container provider as Not planned.
  S2 (2026-11-08) asks for Docker sandboxing. The later, direct request wins
  (AGENTS.md precedence); D-5 records the change and the owner is updated
  in slice 4.
- **Conflict: desktop network.** Disposable desktops decision 5 keeps a
  host-local desktop off the network. A bot that browses needs the web. D-7
  gives bot desktops a proxied network while thread leases keep decision 5.
- **Conflict: routines and sign-in.** Routine and subagent turns refuse
  Browser sign-in today (`sign-in-needs-a-person`). FR-20 asks for unattended
  use; D-9 limits it to logins the person allowed for that bot (accepted,
  S6).
- **Conflict: phone approvals.** The phone cannot answer approvals today
  (Architecture: Mobile). S6 asks for bots in the phone app with cards
  answered there; D-13 opens approvals to paired devices for bot
  conversations only, and the Mobile section is updated in slice 8.

- **Settled: Full access never prompts.** Architecture says nothing prompts
  at Full access outside a closed list. FR-24 (S6) makes paying and sending
  ask at every level; that is exception 5 of
  [the Full access rule](../architecture.md#security-and-authority), which
  D-20 records, so the two agree (maintainer request, 2026-11-12).
- **Conflict: Browser and Computer first asks.** Site approvals and the
  first-action ask per app apply at every level today. In a bot's own
  desktop, which holds nothing of the host's, D-16 waives both (S7).
- **Conflict: routine targets and levels.** File-arrival and
  integration-event routines accept only `new-thread`, and Full access
  routines need an opt-in. D-18 lets bot routines use every Work trigger and
  run at the bot's level.
- **Work has no Plan.** Bot conversations are Work threads, so bots have no
  Plan level; Plan rules in other specifications do not apply to them.
- **Work can be turned off.** Bots run whether or not the Work mode is shown
  (D-19).

## 2. Scope

- **In:** FR-1 to FR-30, NFR-1 to NFR-10, CON-1 to CON-4.
- **Out:** turning threads into bots or bots into threads (CON-2; maintainer,
  2026-11-08). An Octant-hosted cloud for bots (CON-4).
- **Later:** a bot that creates or changes other bots; a desktop-edge dock
  outside the main window.

## 3. Conceptual design

### Purpose

Bots give a person a small team of lasting assistants that live on their hosts
and are reached from any of their devices. A bot keeps its identity, its
conversation, its memory, its routines and, when given one, its own sandboxed
desktop and browser with the logins the person entrusted to it. Navigator is
the bot every host starts with. Bots use the same authority, tools and journal
as threads; they do not replace threads, and they are never a security
boundary wider than the access level the person chose.

### Context map

```mermaid
flowchart LR
  person([Person]) -->|messages, approvals, take-over| clients
  subgraph clients[Clients: desktop window, paired browser, phone]
    rail[Rail and bot list]
  end
  clients -->|federated reads; commands to the owning host| host
  subgraph host[One Octant host  ─ trust boundary A]
    bots[Bot registry]
    conv[Bot conversations\n(Work turns)]
    routines[Routines]
    grants[Login grants]
    broker[Credential broker]
    computers[Bot computers]
  end
  conv -->|prompts, tool results| providers[(Model providers)]
  broker -->|item lookup| op[(1Password, system keychain)]
  computers -->|engine API ─ boundary B| engine[(Container engine / E2B / Cua)]
  subgraph desktop[Bot desktop ─ boundary C]
    chromium[Browser]
  end
  engine --> desktop
  desktop -->|egress proxy ─ boundary D| web[(Websites)]
```

| Boundary                  | Crossing                           | Top threats and the answer                                                                                                                                                                            |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: client → host          | Commands, reads, approvals         | Spoofing a device: existing pairing and window capabilities. Elevation through a bot: every command is authorized like a thread command (NFR-1).                                                      |
| B: host → engine or cloud | Container lifecycle, frames, input | Tampering with the host through the engine socket: only the host talks to the engine, with a fixed container spec (D-6). Leaked billed desktops: existing journal-before-create and verified release. |
| C: host ↔ desktop         | Browser automation, fills, files   | Disclosure of a login: values move host → page only, after an origin check, never back (D-8). Escape to the host: unprivileged container, no host mounts, no host loopback (NFR-2).                   |
| D: desktop → web          | All desktop traffic                | Lateral movement into the person's network: the egress proxy refuses private and host ranges (NFR-4). Page content steering the bot: results taint the conversation as today.                         |

### Capabilities

| Capability                                   | FR IDs                                 |
| -------------------------------------------- | -------------------------------------- |
| Define, create and remove bots               | FR-1, FR-2, FR-3, FR-4                 |
| Converse with a bot with full thread tools   | FR-5, FR-6, FR-10, FR-23, FR-24, FR-25 |
| Give bots standing work and memory           | FR-7, FR-8                             |
| Delegate into the person's Projects          | FR-9                                   |
| Show every bot on every client               | FR-11, FR-12, FR-13, FR-14             |
| Give a bot its own computer and browser      | FR-15, FR-16, FR-17, FR-18, FR-26      |
| Entrust logins without revealing them        | FR-19, FR-20, FR-21, FR-22             |
| Cross-cutting: authority, isolation, journal | NFR-1 to NFR-10                        |

### Components

| Component        | Responsibility                                                                                                | Requirement IDs                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Bot registry     | Owns bot definitions, the lead bot, defaults for new bots, pins and sections; creates and removes bots.       | FR-1–FR-4, FR-11, FR-12, FR-30, NFR-9                                    |
| Bot conversation | Runs a bot's turns as an ordinary Work conversation in the bot's home, with the bot's tools turned on or off. | FR-5, FR-6, FR-8, FR-10, FR-23, FR-24, FR-25, FR-27, FR-28, FR-29, NFR-1 |
| Bot routines     | Routines owned by a bot whose runs post into its conversation.                                                | FR-7                                                                     |
| Project grants   | Records which of the person's Projects a bot may start threads in; checked by the thread-starting tools.      | FR-9                                                                     |
| Bot roster       | Client-side merged list of bots from every connected host, with status; rail, list and phone tab.             | FR-11–FR-14, NFR-7, NFR-8                                                |
| Bot computers    | Persistent desktops per bot through the desktop-provider seam, including the new container provider.          | FR-15–FR-17, FR-26, NFR-2, NFR-4–NFR-6, NFR-10                           |
| Login grants     | Which logins a bot may use, where, and whether unattended; performs fills through the credential broker.      | FR-18–FR-22, NFR-3                                                       |

### Domain concepts

- **Bot.** A lasting assistant on one host: identity, model, access level,
  home, conversation, memory, routines, and optionally a computer.
- **Lead bot.** The bot marked with a star; Navigator by default.
- **Home.** A Work Project the host creates for one bot, bound to a folder in
  the host's data directory. It is not listed among the person's Projects.
- **Bot conversation.** The bot's one Work thread in its home. It never ends;
  its context is summarized underneath and the visible history stays.
- **Bot computer.** A persistent desktop owned by one bot, unlike a thread's
  disposable desktop lease. It may be stopped and started; its files and
  browser profile live in a volume that only it mounts.
- **Login.** A username and secret the host can fill: a login kept in the
  system credential store, or a pointer to a 1Password item.
- **Login grant.** Permission for one bot to use one login on that login's
  sites, with an optional "use when nobody is watching".
- **Project grant.** Permission for one bot to start and follow threads in one
  of the person's Projects.

## 4. Logical design

### Component contracts

| Component        | Provides                                                                                                                                                                                                                                                                                        | Depends on                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Bot registry     | `create`, `update`, `delete`, `pin`, `set-lead` (Later), `set-defaults`, `list` (sync, journaled, exactly-once per command id). Guarantees Navigator exists on start and cannot be deleted; a delete runs teardown of the computer, routines and grants before the bot is journaled as deleted. | Work Projects, Bot computers, Bot routines, Login grants |
| Bot conversation | `send`, `stop`, `read` through the existing Work turn commands on the bot's thread; tool set = Work tools filtered by the bot's tool switches. Guarantees the same admission and refusals as any Work thread.                                                                                   | Work turn service, routines, Project memory              |
| Bot routines     | Routine definitions whose target is the bot conversation; at-least-once start per scheduled time, deduplicated by run id.                                                                                                                                                                       | Automation service, Bot conversation                     |
| Project grants   | `grant`, `revoke`, `check(botId, projectId)`; a local window or a paired device for grant.                                                                                                                                                                                                      | Bot registry, thread-creation paths                      |
| Bot roster       | Merged read across hosts; per-host timeout; stale marking. Read-only: every command goes to the owning host.                                                                                                                                                                                    | Host federation, each host's bot list read               |
| Bot computers    | `ensure-running`, `stop`, `screen`, `control`, `browser-channel`, `clear-browser-data`, `destroy` (async; journal before create; verified destroy).                                                                                                                                             | `desktop-provider` seam, container engine, egress proxy  |
| Login grants     | `add-login`, `grant`, `revoke`, `fill(botId, loginId, frame)`; fill is exactly-once per request and refused unless the page's top-frame origin matches the login's sites.                                                                                                                       | Credential broker, Bot computers (`browser-channel`)     |

### Domain model

- Bot `1 — 1` Home (Work Project, host-managed folder).
- Bot `1 — 1` Bot conversation (Work thread in the home; replaced only by a
  migration, D-2).
- Bot `1 — 0..1` Bot computer. Bot computer `1 — 1` volume.
- Bot `1 — *` Routine (Project-bound to the home).
- Bot `1 — *` Login grant `* — 1` Login.
- Bot `1 — *` Project grant `* — 1` Project.
- Bot lifecycle: `active → deleting → deleted`. Navigator never leaves
  `active`.
- Bot computer lifecycle: absent → creating → running ⇄ stopped →
  destroying → destroyed, with `failed` and `destroy-failed` (retried, as
  disposable desktops are).

Invariants:

- Exactly one lead bot per host while Navigator exists.
- A bot's conversation and home are never shared with another bot.
- A login grant names one bot; a fill for a bot uses only that bot's grants.
- A bot computer's volume is mounted by that bot's desktop only.

### Data ownership

| Datum                                        | Owner                                         | Readers                              |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| Bot definition, pins, sections, defaults     | Bot registry                                  | Bot roster, Bot conversation         |
| Bot conversation turns                       | Work turn service                             | Bot roster (status, unread), clients |
| Bot memory                                   | Project memory of the home                    | Bot conversation, Memory tab         |
| Routine definitions and runs                 | Automation service                            | Bot routines view                    |
| Project grants                               | Project grants                                | Thread-creation tools                |
| Bot computer record and lifecycle            | Bot computers                                 | Desktop tab, Bot roster              |
| Volume contents (files, browser profile)     | Bot computers (on disk, never journaled)      | The bot's desktop only               |
| Login metadata (label, sites, store pointer) | Login grants                                  | Settings, grant editor               |
| Login secret values                          | Credential broker (system store or 1Password) | Fill path only                       |
| Merged multi-host list                       | Bot roster (client memory)                    | Rail, list, phone tab                |

### Integration

| Link                             | Direction and family                                   | Authoritative                                       |
| -------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| Client → owning host             | Request/response commands; event stream for live turns | The owning host                                     |
| Client → every host              | Poll and stream reads, merged client-side              | Each host for its own bots                          |
| Bot registry → Work Projects     | In-process command                                     | Work Projects                                       |
| Automation → Bot conversation    | In-process event (run due) → turn command              | Automation service for the run                      |
| Bot computers → engine           | Request/response over the engine's local socket        | Engine for container state; host journal for intent |
| Host → desktop browser           | DevTools protocol over a host-only channel             | Host                                                |
| Login grants → credential broker | In-process request by opaque reference                 | Broker                                              |
| Desktop → web                    | Through the host's egress proxy                        | Proxy policy                                        |

### Scenario walkthroughs

**W1. Create a bot from one sentence** (FR-3, FR-1, FR-6)

1. The person types "a bot that watches our app-store reviews and drafts
   replies" into Navigator. Navigator calls its bot-draft tool.
2. Bot registry returns a draft (name, role, instructions, model from saved
   defaults, access level Ask first, computer: none) as a card in Navigator's
   conversation. Nothing is journaled.
3. The person edits the name and presses Create. The local window sends
   `create`; the registry authorizes the window, journals `bot.created`,
   asks Work Projects to create the home, and creates the conversation.
4. The roster refreshes; the new bot appears in the list, unpinned.

**W2. A routine signs in and works unattended** (FR-7, FR-15, FR-17, FR-19,
FR-20, NFR-2–NFR-5)

1. At 09:00 the automation service finds the bot's routine due and journals
   the run with its captured authority snapshot.
2. Bot routines queue a turn in the bot conversation marked "started by a
   routine".
3. The turn calls Browser `navigate`. Bot computers `ensure-running`: the
   container starts from the bot's volume (warm start ≤ 20 s, NFR-6) within
   the running cap (NFR-5).
4. The Browser tool reaches the desktop's browser through the host-only
   channel and loads the site through the egress proxy (NFR-4).
5. The page asks for a sign-in. The turn calls the Browser sign-in operation.
   Login grants find a grant for this bot and site (not set to Ask me each time),
   check the top-frame origin, read the secret through the broker, and fill
   it through the channel. The value never enters the turn (NFR-3). The fill
   is journaled as `login.used`.
6. The bot finishes and replies in its conversation. The rail shows unread.
7. After 15 minutes idle, Bot computers stop the container; the volume stays.

**W3. Sign in needed** (FR-21, FR-22)

1. A turn reaches a sign-in page with no usable grant. The Browser holds the
   page and posts a Sign in needed card.
2. The person presses Open: the Desktop tab opens on the bot's screen with
   take-over. They sign in, then press Done.
3. The page is the bot's again; the session cookie stays in the bot's
   browser profile in its volume. Clear browser data on the bot's Computer
   tab deletes it.

**W4. Every bot on the phone** (FR-13, FR-14, NFR-7)

1. The phone reads the bot list from each host in its host list, each read
   bounded at 5 seconds.
2. One host is asleep; its cached bots show as stale and read-only.
3. The person opens a bot on the reachable devbox and sends a message. The
   command goes to the devbox, which authorizes the paired device as it
   would for a thread turn.

**W5. Delete a bot with a running desktop** (FR-4, NFR-9)

1. The person confirms Delete. The registry journals `bot.deleting`.
2. Running turns are stopped; routines are removed; grants are revoked
   (fills refuse from this point).
3. Bot computers destroy the container and the volume and verify both are
   gone. A failure leaves the bot in `deleting` with a Retry, as a
   `release-failed` lease does.
4. The registry journals `bot.deleted`; the roster drops it.

### NFR mechanisms

| NFR    | Mechanism                                                                                                                                                                     | Sufficiency                                                                                                         | Numeric |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------- |
| NFR-1  | Bot turns are Work turns; bot commands reuse window and device authorization; routines keep their snapshot.                                                                   | No new admission path exists to get wrong; the existing refusal tests run against a bot thread.                     | No      |
| NFR-2  | Fixed container spec: non-root user, `cap-drop ALL`, `no-new-privileges`, default seccomp, read-only root, one volume, no host mounts, own network with no route to the host. | Each item closes one escape named in the threat column; a conformance test checks each from inside.                 | No      |
| NFR-3  | Fill moves values host → page through the channel; the agent's typing into credential fields is refused; redaction covers every broker value.                                 | Values have one path, outward; the canary test proves absence on every return path.                                 | No      |
| NFR-4  | The desktop's only route is the host egress proxy, which resolves names itself and refuses private, link-local, loopback and host addresses.                                  | Resolving in the proxy closes DNS-rebinding; the container network has no other gateway.                            | No      |
| NFR-5  | Running cap and idle stop in Bot computers; per-container memory and CPU limits.                                                                                              | 2 desktops × 1.5 GB = 3 GB on a 16 GB laptop; idle stop frees it after 15 minutes.                                  | Yes     |
| NFR-6  | Volume-backed warm start; locally built image cached by digest.                                                                                                               | Warm start is a container start plus a browser launch (measured in slice 4); the build runs once per image version. | Yes     |
| NFR-7  | Per-host read timeout and cached last result per host.                                                                                                                        | 5 s cap per host, reads in parallel: the slowest healthy host bounds the wait.                                      | Yes     |
| NFR-8  | Rail and list rows use the existing status vocabulary with text and icon.                                                                                                     | Checked by the rendered and screen-reader QA in slices 2 and 3.                                                     | No      |
| NFR-9  | Bot, grant and computer events on their own aggregates; projections registered like other aggregates.                                                                         | Replay test.                                                                                                        | No      |
| NFR-10 | Bot computers reuse the lease service's spend cap and billed confirmation.                                                                                                    | Same code path as thread leases.                                                                                    | No      |

### Risk register

| Risk                                                                                                                         | Response                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A container shares the kernel of the engine's VM (macOS) or the host (Linux); an escape reaches more than a VM escape would. | The hardening list in NFR-2; VM-backed providers (Cua, E2B, later Apple `container`) are offered as the stronger choice and said so in the picker.                                                                                            |
| ASM-1 fails: Work needs a person-picked binding.                                                                             | Slice 1 adds a host-managed binding kind for bot homes only.                                                                                                                                                                                  |
| A site's own scripts read a filled password from the page.                                                                   | Stated in the grant dialog, as the Browser spec already states for 1Password fills.                                                                                                                                                           |
| Unattended sign-in turns a prompt-injected page into account use.                                                            | A login works only on its own sites; the bot's access level still governs actions after sign-in; paying and sending always ask; every use is journaled and shown; Ask me each time is one switch away; removal takes effect at the next fill. |
| Engine variety (Docker Desktop, OrbStack, Colima, Podman) behaves differently on networking.                                 | The conformance test runs per engine; an engine that fails NFR-2 or NFR-4 is refused with the reason.                                                                                                                                         |
| Migrating Navigator from a Chat thread loses context.                                                                        | D-2: the old conversation stays readable and is summarized into the new one's memory.                                                                                                                                                         |
| A browsing bot loses its provider's reviewer after its first web page (injection gate).                                      | Octant Shield takes over at Auto (D-17); Shield still escalates irreversible, publish and new-egress actions to the person.                                                                                                                   |
| The pay-or-send classifier misses a send button, or asks too often.                                                          | Fixtures in English and Norwegian, misses reviewed as bugs; it asks only for actions it classifies (D-20).                                                                                                                                    |

## 5. Decisions

### D-1: A bot is an identity with its own Work home, not a fourth mode (Accepted, 2026-11-08)

Context: bots must have thread capabilities (FR-6) and be app-wide (CON-1);
AGENTS.md forbids a fourth authority mode and changing a thread's kind (CON-4).
Options: (a) a new "bot" thread kind; (b) a Chat thread per bot; (c) a Work
thread per bot in a host-managed home Project.
Choice: (c). Chat has no Browser, files or desktop, so (b) fails FR-6 and
FR-15; (a) is a fourth mode. A home Project gives each bot files, routines
(which are Project-bound) and memory (Project memory) with no new authority
model.
Consequences: the home Project must stay out of Project lists and pickers; a
bot's file tools reach only its home unless a Project grant (FR-9) lets it
start a thread elsewhere.

### D-2: Navigator becomes the lead bot through a new Work conversation (Accepted, 2026-11-08)

Context: Navigator is a hidden Chat thread today; it cannot change kind.
Options: (a) keep Navigator as a Chat thread with fewer tools than other
bots; (b) give Navigator a home and a new Work conversation, keeping the old
Chat conversation readable.
Choice: (b). The old conversation becomes "Earlier Navigator conversation"
on Navigator's Profile tab, and a summary of it seeds the new one's memory.
Zen's assistant rebinds to the new conversation.
Consequences: Zen's tools, contributed to Chat threads today, are contributed
to the Navigator Work conversation too (Codebase deltas).

### D-3: Bot routines post into the bot's conversation (Accepted, 2026-11-08)

Context: routines create a new thread per run; `same-thread` is a one-shot
follow-up only. A bot's standing work should land where its context is (FR-7).
Options: (a) a thread per run, listed under the bot; (b) a new target
`bot-conversation` that queues a marked turn in the bot's conversation.
Choice: (b) by default; a routine may still choose a new thread for long
jobs.
Consequences: the automation contract gains the target; a queued routine
turn waits behind a running turn and counts as a routine turn for authority.

### D-4: Bot computers extend the desktop-provider seam with kept desktops (Accepted, 2026-11-08)

Context: disposable desktops are thread-owned, expire within hours and are
destroyed on restart; a bot needs one that keeps its state (FR-15).
Options: (a) a separate bot-desktop system; (b) the existing seam with a
`kept` capability (stop, start, a volume) and a bot owner beside the thread
lease.
Choice: (b). One seam keeps one teardown, journal and spend path, and E2B and
Cua already offer pause and persistence.
Consequences: the seam gains `start`, `stop` and `destroyVolume`; a driver
that cannot keep state is offered for thread leases only.

### D-5: The first local provider for bot desktops uses a Docker-compatible engine (Accepted, 2026-11-08)

Context: CON-3; disposable desktops decision 1 marked a host-local container
provider Not planned.
Options: (a) Docker Engine API, which Docker Desktop, OrbStack, Colima and
Podman serve; (b) Apple `container` only; (c) the existing Linux Bubblewrap
provider.
Choice: (a). It runs on macOS and Linux, and one API covers four engines.
Octant detects a running engine and never installs one. Apple `container`
follows as a second driver (Q-5).
Consequences: this supersedes the "Not planned" line in disposable desktops
decision 1 when slice 4 lands; that owner is updated in the same PR.

### D-6: Octant builds its desktop image locally from its own recipe (Accepted, 2026-11-08)

Context: a desktop needs a virtual display, a window manager, a browser and
an input agent; Octant operates no registry (CON-4).
Options: (a) pull a third-party desktop image; (b) ship an Octant-owned
container recipe with a base image pinned by digest and build it on first
use.
Choice: (b). The contents are known and reviewed, nothing new is hosted, and
the image version follows the app version.
Consequences: a first build takes minutes and needs network (NFR-6); the
build runs through the engine, never as a host process.

### D-7: A bot desktop has a proxied network (Accepted, 2026-11-08)

Context: disposable desktops keep host-local desktops offline (decision 5);
a bot that browses needs the web (FR-17).
Options: (a) open egress; (b) egress only through a host proxy that refuses
private and host addresses, with an optional per-bot site list.
Choice: (b). Thread leases keep decision 5 unchanged.
Consequences: the proxy is host-owned and journaled per bot. By default it
allows the public web minus private, link-local and host addresses; a person
may narrow a bot to a site list (S6).

### D-8: Logins are filled by the host into the bot's browser; the bot never reads them (Accepted, 2026-11-08)

Context: FR-19, NFR-3. The Browser already fills 1Password items into
native pages with person approval per use.
Options: (a) give the secret to the bot as a tool result; (b) inject it as an
environment variable into the desktop; (c) the host fills the page's fields
through the browser channel after checking the top-frame origin.
Choice: (c). (a) and (b) put the value where a prompt-injected agent can
send it anywhere.
Consequences: logins may be kept in the system credential store as well as
1Password; the agent's own typing into credential fields stays refused; a
one-time code from 1Password is filled the same way.

### D-9: Unattended sign-in only through a per-login, per-bot grant (Superseded by D-15)

Context: routine turns refuse sign-in today; bots own routines (FR-7,
FR-20).
Options: (a) keep refusing; (b) allow it for logins the person marked "use
when nobody is watching" for that bot.
Choice: (b), off by default, set only by a person, at a local window or a paired
device (maintainer decision, 2026-11-12), every use journaled and listed.
Consequences: the Browser spec's `sign-in-needs-a-person` rule gains this one
exception (accepted, S6).

### D-10: The roster merges bots on the client; authority stays on each bot's host (Accepted, 2026-11-08)

Context: FR-13; the client already merges read models across hosts.
Options: (a) a hub host that owns every bot; (b) client-side merge, commands
routed to the owning host.
Choice: (b). It matches the host federation rule that hosts never trust each
other.
Consequences: creating a bot asks which host it runs on when more than one is
connected; a paired device may create one on any host it is paired with
(D-13).

### D-11: A new bot starts at Auto with its provider's own reviewer, otherwise Ask first (Superseded by D-17)

Context: S6 Q-4. Auto (Reviewed) lets the provider's own reviewer answer
approvals where the provider reports `harnessAutoReview` (Claude Code, Codex).
Options: (a) Ask first for every bot; (b) Auto where the provider has its own
reviewer, Ask first elsewhere; (c) Auto with Octant Shield everywhere.
Choice: (b), as the maintainer asked. A bot never starts at Full access.
Consequences: the existing injection gate still applies. Once a bot's
conversation is marked by outside content (any web page it reads), the
provider's reviewer is withdrawn and approvals go to the person, which FR-25
lets them answer from the phone. Q-9 asks whether Octant Shield should cover
that case.

### D-12: Payments and sending messages always ask (Superseded by D-20)

Context: S6 Q-6; FR-24. A bot acting on websites can pay, buy, or send as the
person.
Options: (a) leave it to the access level; (b) a closed set of actions that
ask at every level, Full access and routines included.
Choice: (b). The Browser classifies a submit as paying or sending when the
page is a checkout or payment step, or the form sends a message (email, chat,
post, comment), and when it cannot tell on a site the bot has not used before,
it asks. Computer-tool clicks on a send or pay control in a desktop app ask
the same way.
Consequences: an unattended routine reaching such a step waits with a
needs-you badge; the classifier errs toward asking, and each confirmation is
journaled as the person's.

### D-13: Paired devices create bots and answer bot cards (Accepted, 2026-11-08)

Context: S6 Q-1 and Q-7. Today a paired device cannot answer approvals or
bind folders.
Options: (a) keep bots local-window only; (b) let paired devices create bots
and answer a bot conversation's cards, keeping a short list local-window only.
Choice: (b). A bot's home is host-managed, so creating one binds no folder of
the person's. Billed desktop starts, login grants and unattended-use switches
were first kept local-window only, because they spend money or hand over an
account; that short list is removed (maintainer decision, 2026-11-12: an
authenticated paired device is the person), so a paired device does those too.
Consequences: remote route policy gains the bot create and card-answer routes
with the device's grant; the Mobile section of Architecture is updated in
slice 8; threads keep today's phone rules (CON-2).

### D-14: Apple's container tool is the second local engine (Superseded by D-24)

Context: S6 Q-5. On macOS 26 with Apple silicon, Apple's container tool runs
each Linux container in its own lightweight VM, a stronger boundary than
containers sharing one kernel.
Options: (a) Docker-compatible engines only; (b) add a driver for Apple's
tool through the same seam.
Choice: (b). It runs the same Octant desktop image: a virtual display, a
window manager, the browser and VNC inside the VM, since there is no host
display to share. It has no guest GPU, so the browser renders in software;
each container gets its own address the host reaches, on an isolated network
per bot.
Consequences: the picker lists it first on Macs where it runs, as the
stronger boundary; the egress proxy and the conformance checks apply
unchanged; image builds may need the engine's build network settings (ASM-5).

### D-15: A login given to a bot is used without asking on its own sites (Accepted, 2026-11-08)

Context: S7 asks for no unnecessary friction. D-9 kept unattended use off by
default, and a review suggestion had every attended fill ask.
Options: (a) ask on every fill; (b) unattended use as a separate switch, off
by default; (c) giving the login is the permission: the bot uses it on that
login's sites, attended or in routines, with Ask me each time per login.
Choice: (c). Giving one login to one bot for named sites is a deliberate act,
and the value never reaches the model either way.
Consequences: the Browser's per-use Login permission, Review login form and
Fill steps do not apply to a bot's own browser; routine turns may sign in
with a given login; adding and giving logins is the person's act, at a local
window or a paired device (D-13).

### D-16: No site approval and no first-action ask in a bot's own desktop (Accepted, 2026-11-08)

Context: S7. Site approvals and the per-app first-action ask protect the
person's own browser profiles and computer. A bot desktop holds no host
credential, checkout or profile of the person's.
Options: (a) keep both; (b) waive both inside a bot's own desktop.
Choice: (b). The bot's access level, the egress proxy, the outside-content
mark, and paying and sending (D-20) still apply. The person's own computer
and browser profiles keep every current rule.
Consequences: Browser for agents and Architecture's first-action rule gain
this scope; a bot that uses the person's Mac through `octant_computer` still
asks per app.

### D-17: Bots at Auto use their provider's reviewer, then Octant Shield (Accepted, 2026-11-08)

Context: S6 Q-4 chose Auto where the provider has its own reviewer and Ask
first elsewhere; Q-9 asked about the injection gate withdrawing that reviewer.
Options: (a) the person answers once the reviewer is withdrawn; (b) Octant
Shield takes over.
Choice: (b). A new bot starts at Auto when its provider has its own reviewer
(Claude Code, Codex), else at Ask first, and the person can pick Auto with
Octant Shield for any bot. When the provider's reviewer is withdrawn on a
marked conversation, Shield answers; it still escalates irreversible, publish
and new-egress actions to the person. A bot does not start at Full access by
default, and the person may change that (maintainer request, 2026-11-12).
Consequences: this matches Architecture's Reviewed level, where Shield may
answer on a marked thread within its limits.

### D-18: Bot routines run at the bot's level with every Work trigger (Accepted, 2026-11-08)

Context: S7. The routine contract limits file-arrival and integration-event
triggers to `new-thread` and needs an opt-in for Full access.
Choice: a routine whose target is `bot-conversation` accepts every Work
trigger and runs at the bot's access level, captured when the routine is
saved and never wider than the bot's level at run time. Setting a bot to
Full access is the person's opt-in for its routines.
Consequences: the automation contract and Architecture's routine authority
section change in slice 3.

### D-19: Bots do not depend on the Work mode being shown (Accepted, 2026-11-08)

Context: the Work mode can be turned off; bots run as Work conversations
(D-1).
Choice: bot homes and conversations work whether or not the Work mode is
shown, and bot conversations notify like any thread (Needs you, finished),
while staying out of Project and thread lists.
Consequences: the Work-off checks exempt bot homes; notifications include
bot conversations.

### D-20: Paying and sending ask, at every level, only when classified (Accepted, 2026-11-08)

Context: S6 Q-6 and S7. D-12 also asked whenever the classifier could not
place a submit on a site the bot had not used, which adds friction.
Choice: paying, buying, or sending a message as the person asks at every
level, Full access and routines included, when the Browser or Computer
classifies the action as such. Other actions follow the access level. The
card can be answered from the phone in one tap (D-13).
Consequences: this is exception 5 of
[the Full access rule](../architecture.md#security-and-authority), which
Architecture already carries (maintainer request, 2026-11-12).

### D-21: A local bot desktop starts without a card (Accepted, 2026-11-08)

Context: S7. Starting a container on this machine costs nothing and holds
nothing of the person's.
Choice: a bot's first Browser or Computer call starts its local desktop and
notes it in the conversation. A billed or off-machine desktop still asks
every time (NFR-10).

### D-22: Bots ask each other and share rooms under the existing messaging limits (Accepted, 2026-11-08)

Context: S3 and S7 ask for parity; Q-8 asked whether bot-to-bot requests need
the person.
Choice: a bot may message another bot on its host by name without asking the
person, under the existing agent messaging and wake limits (at most six
agent-started turns an hour per recipient, at most three rounds of agents
answering each other). A room is a shared conversation with one owner at a
time; a hand-off is a message. Each bot keeps its own level and tools.
Consequences: a bot's request never grants the recipient more than its own
level; the person sees every bot-to-bot message.

### D-23: Bot desktops get their own engine port (Accepted, 2026-11-08)

Context: the existing daemon port speaks gRPC-Web to one socket with small
bounds; the Docker Engine API needs long attach streams, image builds and
system sockets.
Choice: a new capability port for container engines, added to the
`desktop-provider` seam as its own step in slice 4, reaching only declared
sockets and API paths.
Consequences: container work for Code threads reuses it.

### D-24: Apple's container tool runs the same desktop with no VNC port (Accepted, 2026-11-08)

Context: D-14 said the desktop runs VNC inside the VM; the host-local desktop
already carries frames and input over stdio.
Choice: as D-14, except that the screen and input travel over the same stdio
program as the other local desktops, and no VNC port is opened.
Consequences: one screen protocol for every local engine.

## 6. Coverage

| Requirement                                      | Capability               | Component                       | Slice |
| ------------------------------------------------ | ------------------------ | ------------------------------- | ----- |
| FR-1, FR-2, NFR-9                                | Define bots              | Bot registry                    | 1     |
| FR-5, FR-6, FR-10                                | Converse                 | Bot conversation                | 1     |
| FR-3, FR-4                                       | Define bots              | Bot registry                    | 2     |
| FR-11, FR-12, FR-23, NFR-8                       | Show every bot           | Bot roster                      | 2     |
| FR-7, FR-8                                       | Standing work and memory | Bot routines, Bot conversation  | 3     |
| FR-15, FR-16, NFR-2, NFR-4, NFR-5, NFR-6, NFR-10 | Own computer             | Bot computers                   | 4     |
| FR-17, FR-18, FR-24                              | Own computer             | Bot computers, Bot conversation | 5     |
| FR-19–FR-22, NFR-3                               | Entrust logins           | Login grants                    | 6     |
| FR-13, FR-14 (web), FR-25 (web), NFR-7           | Show every bot           | Bot roster, Bot conversation    | 7     |
| FR-14 (phone), FR-25 (phone)                     | Show every bot           | Bot roster, Bot conversation    | 8     |
| FR-26                                            | Own computer             | Bot computers                   | 10    |
| FR-30                                            | Define bots              | Bot registry                    | 2     |
| FR-27                                            | Converse                 | Bot conversation                | 11    |
| FR-28                                            | Converse                 | Bot conversation                | 12    |
| FR-29                                            | Converse                 | Bot conversation                | 13    |
| FR-9                                             | Delegate                 | Project grants                  | 9     |
| NFR-1                                            | Cross-cutting            | All                             | every |

## 7. Build plan

Each slice may land as a short native stack of PRs. Maintainer checks are
named where a slice needs a person, a device or an account.

| Slice | What it delivers                                                                                                                                                                                                                                                                           | Requirement IDs                                  | Depends on                        | Status  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------- | ------- |
| 1     | Stack: (a) bot registry, home Projects, hiding, Navigator migration; (b) the bot conversation tab, the always-present Navigator entry, and `octant_app`.                                                                                                                                   | FR-1, FR-2, FR-5, FR-6, FR-10, NFR-1, NFR-9      | —                                 | Planned |
| 2     | Stack: (a) delete with a teardown-step registry; (b) the bot details panel (Profile, Model and access, Tools); (c) rail bots and All bots; (d) New bot (describe, templates, form, defaults); (e) Quick ask.                                                                               | FR-3, FR-4, FR-11, FR-12, FR-23, FR-30, NFR-8    | 1                                 | Planned |
| 3     | Bot routines into the conversation (every Work trigger, the bot's level); Routines and Memory tabs.                                                                                                                                                                                        | FR-7, FR-8                                       | 1, 2                              | Planned |
| 4     | Stack: (a) measured prototype; (b) the kept capability in the seam, with its fake; (c) the container engine port; (d) the Docker-compatible driver, the desktop image shipped with the app, and the egress proxy; (e) the bot computer record, caps, idle stop, Computer and Desktop tabs. | FR-15, FR-16, NFR-2, NFR-4, NFR-5, NFR-6, NFR-10 | 1, 2                              | Planned |
| 5     | A bot's Browser and Computer in its desktop, the Bot profile, no site approval or first-action ask there, paying and sending always ask.                                                                                                                                                   | FR-17, FR-18, FR-24                              | 3, 4                              | Planned |
| 6     | Logins and grants, fill without asking on the login's sites, Ask me each time, Sign in needed with take-over, Logins tab.                                                                                                                                                                  | FR-19, FR-20, FR-21, FR-22, NFR-3                | 5                                 | Planned |
| 7     | Every host's bots in one view; the paired browser; paired devices create and delete bots and answer bot cards.                                                                                                                                                                             | FR-13, FR-14 (web), FR-25 (web), NFR-7           | 2; 6 for the login-card criterion | Planned |
| 8     | Phone Bots tab, bot cards, bot creation, pushes. Maintainer check: pushes on a real phone.                                                                                                                                                                                                 | FR-3 (phone), FR-14 (phone), FR-25 (phone)       | 7                                 | Planned |
| 9     | Projects tab, and starting or following threads in granted Projects at the lower of the bot's level and the Project's default.                                                                                                                                                             | FR-9                                             | 2                                 | Planned |
| 10    | Apple's container tool driver. Maintainer check: a macOS 26 Apple silicon Mac.                                                                                                                                                                                                             | FR-26, ASM-5                                     | 4                                 | Planned |
| 11    | Bots ask each other by name; shared rooms with one task owner.                                                                                                                                                                                                                             | FR-27                                            | 2                                 | Planned |
| 12    | Voice call with a bot; the lead bot speaks first.                                                                                                                                                                                                                                          | FR-28                                            | 2                                 | Planned |
| 13    | Fallback model per bot when usage runs out or the provider fails.                                                                                                                                                                                                                          | FR-29                                            | 2                                 | Planned |

## 8. Open questions

Every question is answered. Q-1 to Q-7 were answered on 2026-11-08 (S6) and
are written into FR-1, FR-3, FR-14, FR-20, FR-24 to FR-26, NFR-4 and D-7,
D-9, D-11 to D-14. Q-8 is answered by D-22 and Q-9 by D-17 (S7).

## 11. Codebase deltas and change log

### Codebase deltas

| Where code and this design differ                                                                                                   | Ruling                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Navigator is a hidden Chat thread with only `send-message`, read after the turn ends, rendered as plain text in a dialog.           | Code migrates in slice 1 (D-2).                                                       |
| Zen's assistant tools are contributed to Chat threads only (`contributeChatTools` in `apps/server/src/wiring/zen.ts`).              | Code migrates in slice 1: contributed to the Navigator Work conversation too.         |
| Work Projects are bound to a folder a person picks.                                                                                 | Code migrates in slice 1: a host-managed binding for bot homes (ASM-1).               |
| Routines' `same-thread` target is one-shot only.                                                                                    | Code migrates in slice 3 (D-3).                                                       |
| Disposable desktops are thread-owned, expire, are destroyed on restart, and the host-local one is Linux Bubblewrap with no network. | The seam extends in slice 4 (D-4, D-5, D-7); thread leases keep their rules.          |
| Browser profiles are Private, Project and Personal Electron partitions.                                                             | Slice 5 adds a Bot profile that lives in the bot's volume.                            |
| Routine and subagent turns refuse sign-in (`sign-in-needs-a-person`); 1Password fill needs a person per use.                        | Slice 6 adds per-login grants (D-8, D-9).                                             |
| The remote web shell does not serve the desktop sidebar or rail.                                                                    | Slice 7 serves the rail bots and the list.                                            |
| The phone cannot answer approvals.                                                                                                  | Slices 7 and 8 let paired devices answer bot cards (D-13); threads keep today's rule. |
| Full access never prompts (Architecture, Guardrail levels).                                                                         | Already exception 5 of the Full access rule (D-20).                                   |
| Browser site approvals and the per-app first-action ask apply at every level.                                                       | Slice 5 waives both inside a bot's own desktop (D-16).                                |
| The Browser's attended login fill asks per use.                                                                                     | Slice 6: a bot's given login fills without asking on its sites (D-15).                |
| Routine targets limit file-arrival and integration-event triggers; Full access routines need an opt-in.                             | Slice 3 (D-18).                                                                       |
| The Work mode can be turned off, which hides Work.                                                                                  | Slice 1 exempts bot homes (D-19).                                                     |
| `DesktopDaemonPort` speaks gRPC-Web to one socket with small bounds.                                                                | Slice 4 adds an engine port (D-23).                                                   |

### Change log

- 2026-11-08: plan review (S7): less friction and parity. D-15 to D-24;
  D-9, D-11, D-12 and D-14 superseded; FR-27 to FR-30 and slices 11 to 13
  added; slice dependencies corrected and stacks named; Q-8 and Q-9 answered.

- 2026-11-08: approved with the maintainer's answers to Q-1 to Q-7 (S6):
  FR-24 to FR-26, D-11 to D-14, slice 10; FR-14 and FR-20 became Must;
  decisions D-1 to D-10 accepted; Q-9 added.

- 2026-11-08: first draft from the maintainer's two requests and the code on
  `main`.
