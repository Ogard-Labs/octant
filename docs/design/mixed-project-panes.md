# Threads from several Projects in one window

Status: Draft. Not approved: nothing here is a current rule, and the current
rule (one visible tree belongs to one authority context) stays in force until a
maintainer approves this design.
Size: Full: it changes what a window's authority is, which every server check
that reads a window's Project consumes, plus the workspace contract, domain
policy, and the pane presentation.
Owner: a maintainer · Started: 2026-11-14 · Approved: not yet
Working assumptions: the open questions in section 8 are answered with the
recommendation given there; each is marked where it shapes the design.

A person dragged a thread from one Code Project into a window showing a thread
from another, to work on both at once, and was refused: "This surface belongs to
a different Project. Open it in a new window to keep its authority." Two threads
from the same Project, or two Chat threads, split fine. A maintainer chose to let
one window hold threads from several Projects in its split panes, with each pane
keeping its own Project's authority, over the smaller alternative of opening the
other thread in a separate window placed beside this one.

## 1. Requirements

### Sources

| ID  | Location                                                                                                                        | What it contributes                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| S1  | Maintainer request, 2026-11-14                                                                                                  | Threads from several Projects side by side in one window's panes; plan before building; authority stays server-enforced     |
| S2  | [Workspace: Panes and content navigation](workspace.md#panes-and-content-navigation)                                            | "One visible tree belongs to one authority context (host, mode, Project, and bound root)"; drop and Show side by side rules |
| S3  | [Decisions: Panes, tabs and previews](decisions.md#panes-tabs-and-previews)                                                     | The same rule as a Built decision; layout persists per window, mode and Project context                                     |
| S4  | [Architecture: Security and authority](../architecture.md#security-and-authority)                                               | A turn keeps its checkout; app-managed tools follow the window's standing authority when each call runs                     |
| S5  | [Architecture: Modes](../architecture.md#modes-chat-work-and-code) and [principles](../architecture.md#overview-and-principles) | Modes and Project binding are server-enforced; a thread keeps its kind; Chat has no filesystem or shell authority           |
| S6  | [Architecture: Extensions and skills](../architecture.md#extensions-and-skills)                                                 | Installation, trust and enablement stay separate; discovery grants nothing                                                  |
| S7  | Code, read on 2026-11-14 at `188c6977f` (section 3, "Today")                                                                    | Where the one-Project rule lives and every server check that reads it                                                       |
| S8  | AGENTS.md, [Building Within The Product Rules](../../AGENTS.md#building-within-the-product-rules)                               | Never move an authority decision into the renderer; never widen a thread's authority                                        |

### Requirements

| ID    | Requirement                                                                                                                                                                                            | Priority    | Acceptance criterion                                                                                                                                                                      | Sources |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| FR-1  | A person can place a thread from another Project of the same mode and host into a pane of this window by dragging it to a pane edge or centre, or by Show side by side                                 | Must        | Given a Code window showing a Project A thread, when the person drops a Project B Code thread on a pane edge, then the window shows both threads in two panes and no refusal is announced | S1      |
| FR-2  | Each pane acts only with its own Project's authority                                                                                                                                                   | Must        | Given panes for A and B, a turn in the A pane that asks for B's terminal, board, sibling transcript or a device approval is refused `unauthorized`; the same call from A for A succeeds   | S1, S4  |
| FR-3  | The server alone decides which Projects a window may reach; the renderer's claim of a pane's Project is never trusted                                                                                  | Must        | A layout operation whose surface claims Project B while naming a thread of Project C records C (or refuses), never B                                                                      | S5, S8  |
| FR-4  | Mode and host mixing stay refused                                                                                                                                                                      | Must        | Dropping a Work thread into a Code layout, or a thread on another host into this layout, is refused with today's messages and new-window offer                                            | S2, S5  |
| FR-5  | Every pane names its Project at every pane width                                                                                                                                                       | Must        | In a window with panes from two Projects, each pane's title row shows its Project's mark and name in a 360px-wide pane; assistive technology reads "Project B, thread title"              | S1      |
| FR-6  | The dock, bottom panel and their tools follow the active pane's Project                                                                                                                                | Must        | Activating the B pane shows B's Files, terminal and Browser in the dock; nothing from A stays on screen in a B tool                                                                       | S1, S2  |
| FR-7  | Approvals and questions name the Project they belong to                                                                                                                                                | Must        | An approval raised by the B pane's turn shows B's name on its card and in Needs you, while the A pane is active                                                                           | S4      |
| FR-8  | Removing the last pane of a Project ends the window's reach to it                                                                                                                                      | Must        | After the B pane closes, attaching to B's Project terminal from this window is refused, and a still-running B turn's window-held calls refuse as after a rebind today                     | S4      |
| FR-9  | A mixed layout survives reload and restart, and reconciles against Projects that were archived or relinked meanwhile                                                                                   | Must        | After B is archived, the restored window shows B's pane as the mode welcome and no longer reaches B                                                                                       | S3      |
| FR-10 | Windows that show one Project behave exactly as today                                                                                                                                                  | Must        | The existing shell policy, workspace, Code access and Browser authority suites pass unchanged                                                                                             | S2, S3  |
| FR-11 | Plugin and skill enablement resolve on the pane's own Project                                                                                                                                          | Must        | A plugin enabled for A only contributes its dock tool to the A pane and not to the B pane                                                                                                 | S6      |
| FR-12 | Attaching a thread from another Project as context to a composer                                                                                                                                       | Must? (Q-2) | Per Q-2: either refused with "This thread is in another Project", or attached as a bounded reference                                                                                      | S2      |
| FR-13 | Chat Projects can mix in one window                                                                                                                                                                    | Could (Q-1) | Decided by Q-1                                                                                                                                                                            | S1      |
| NFR-1 | A window reaches a bounded number of Projects per mode                                                                                                                                                 | Must        | A fifth Project dropped into a window that already reaches four in this mode is refused with "This window already shows four Projects" (Q-4)                                              | S1      |
| NFR-2 | The admission check adds no measurable cost to a request                                                                                                                                               | Should      | `windowAdmitsProject` over a 64-pane layout runs in under 50 µs in the domain test                                                                                                        | S7      |
| CON-1 | Authority checks run on the server before effects; the renderer's refusal is a courtesy                                                                                                                | Must        | Every new check has a server-side test                                                                                                                                                    | S8      |
| CON-2 | Installation, trust and enablement stay separate steps; mixing Projects never enables a plugin, skill or MCP server                                                                                    | Must        | FR-11 test                                                                                                                                                                                | S6      |
| CON-3 | Server (SSH) Projects keep their exact window, registry and binding checks                                                                                                                             | Must        | A server Project thread dropped into a mixed window is refused until Q-5 says otherwise                                                                                                   | S7      |
| ASM-1 | A paired device and a local window already hold equal reach by maintainer decision (2026-11-12), and a device scope already reaches every active Code Project; so a multi-Project principal is not new | —           | —                                                                                                                                                                                         | S4      |

### Traceability

| Source statement                                                        | Disposition                     |
| ----------------------------------------------------------------------- | ------------------------------- |
| "threads from several Projects in one window's panes" (S1)              | FR-1, FR-13 (Chat, Q-1)         |
| "per-pane capability, per-thread checks on the server" (S1)             | FR-2, FR-3, D-1, D-2            |
| "terminal/browser/approvals/file access" (S1)                           | FR-2, FR-6, FR-7, section 4     |
| "the dock and title band showing which Project a pane belongs to" (S1)  | FR-5, FR-6                      |
| "what breaks or must be refused (mode and host mixing, Chat/Work/Code)" | FR-4, CON-3, section 4 refusals |
| "keep installation, trust and enablement rules intact" (S1, S6)         | FR-11, CON-2                    |
| "authority server-enforced, never in React only" (S1, S8)               | FR-3, CON-1                     |
| "One visible tree belongs to one authority context" (S2, S3)            | Replaced by D-1 on approval     |

## 2. Scope

- In: FR-1 to FR-11, NFR-1, NFR-2, CON-1 to CON-3, for Code Projects first and
  then Work Projects (Q-1).
- Out: mixing modes in one visible tree; mixing hosts; converting a thread's
  kind or moving it between Projects (unchanged `move-*-thread` commands); any
  change to paired devices, remote web clients, or desktop window registration
  (a maintainer, 2026-11-14, by choosing per-pane authority within one window).
- Later: Chat Projects (FR-13, Q-1); server Projects (CON-3, Q-5);
  cross-Project context attach if Q-2 allows it.

## 3. Conceptual design

### Purpose

Let a person keep threads from two to four Projects of one mode on screen in one
window, each pane working exactly as it would alone in its own window. The window
does not gain a merged authority: it holds a small set of Project admissions, and
each thread, terminal, Browser page and approval still acts only for its own
Project. It does not mix modes or hosts, and it does not let one Project's turn
reach another Project's services.

### Today

- **Where the rule lives.** The persisted `WindowWorkspace`
  ([contracts shell.ts:1361](../../packages/contracts/src/shell.ts)) holds one
  `WorkspaceContextKey` per mode in `contextByMode` (host, mode, Project, bound
  root), one layout per mode, and up to twelve `stowedLayouts` for other
  Projects. The pure policy `resolveWorkspaceContext`
  ([shellPolicy.ts:1122](../../packages/domain/src/shellPolicy.ts)) runs on every
  `open-surface`, `replace-pane-surface` and `split-pane`, binds an unbound mode
  context, and throws `WorkspaceContextRejected` for a surface of another
  Project. The renderer repeats it first as a courtesy
  (`isDifferentProject` and `refuseCrossAuthority`,
  [useShellController.ts:2198](../../apps/web/src/shell/useShellController.ts)),
  and a sidebar row drag of another Project is rerouted to the ordinary open
  path, which switches the window's Project and stows the old layout
  ([App.tsx:1522](../../apps/web/src/App.tsx)).
- **What a window holds.** Desktop registers a window ID with a capability and
  renderer identity and nothing about Projects
  ([projectRootPicker.ts:132](../../apps/desktop/src/projectRootPicker.ts)); the
  Project lives only in the server's persisted workspace. So desktop needs no
  change.
- **Where the server reads it.** About twenty sites, all of the form
  "`contextByMode[mode].projectId` equals the thread's Project":
  `windowCanAccessCodeProject` and `windowCanAccessWorkProject`
  ([windowCodeProjectAccess.ts](../../apps/server/src/windowCodeProjectAccess.ts)),
  `CodeProjectAccess.canAccessProject` and `standingAuthority`
  ([codeProjectAccess.ts](../../apps/server/src/codeProjectAccess.ts)), the
  Browser authority resolver
  ([browserAuthorityResolver.ts](../../apps/server/src/browser/browserAuthorityResolver.ts)),
  child-run creation and pending child requests
  (`authorizeAgentRunCreation.ts`, `childPendingRequests.ts`, `wiring/agentRuns.ts`),
  Canvas and preview routes, Work tooling and server Work Project actions
  (`wiring/codeTooling.ts`, `serverWorkProjectActions.ts`), the workspace
  wiring, context inspection (`wiring/context.ts`), usage scope, and the shell
  service's restore reconciliation (`shellService.ts`).
- **What the one-Project rule silently guarantees.** Because a window binds one
  Project per mode and a turn can only start in a window bound to its thread's
  Project, "the window's Project" and "the turn's thread's Project" are the same
  thing today. The window's standing authority (terminals the window holds, the
  planner board, device-effect approvals, a sibling thread's transcript through
  a `#thread` read) is therefore confined to the turn's own Project without any
  check saying so. A multi-Project window breaks that silent guarantee; closing
  it is the core of this design (D-2).

### Context map

```
 Person ──drag/drop, typing, approvals──▶ Renderer (apps/web)          [no authority]
                                             │ window capability + layout op
                                             ▼
 ╔═════════════════ trust boundary: bridge secret / window capability ════════════╗
 ║ Host server                                                                    ║
 ║   Workspace policy ──▶ Window admissions {A, B} per mode (derived, D-1)        ║
 ║        │                                                                       ║
 ║   Request checks: window admits P?          Turn checks: P == turn's Project? ║
 ║        │                                          (D-2)                        ║
 ║   Project services: terminals, board, Git, Browser, Canvas, previews, approvals║
 ╚════════════════════════════════════════════════════════════════════════════════╝
            │ turn of Project A                         │ turn of Project B
            ▼                                           ▼
   Provider runtime, confined to A's checkout   Provider runtime, confined to B's
```

Threats at the window boundary: **elevation** (a turn in A reaching B's
services through the shared window), **spoofing** (a renderer naming B for a
pane that holds C, or adding B without a person's gesture), **disclosure** (B's
transcript, terminal output or Browser page shown in A's dock), and
**tampering by confusion** (a person approving or typing for the wrong Project
because the panes look alike).

### Capabilities

| Capability                                                        | FRs                      |
| ----------------------------------------------------------------- | ------------------------ |
| Admit another Project's surface into a pane of this window        | FR-1, FR-3, FR-4, NFR-1  |
| Judge every request and every turn call against the right Project | FR-2, FR-8, FR-11, CON-1 |
| Show which Project each pane, tool and request belongs to         | FR-5, FR-6, FR-7         |
| Persist and reconcile a mixed layout                              | FR-9, FR-10              |

### Components

| Component                                 | Responsibility                                                                                                      | Requirements                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Workspace contract (`packages/contracts`) | Each pane carries its own context key; the window's per-mode context stays the lead Project                         | FR-1, FR-9, NFR-1              |
| Workspace policy (`packages/domain`)      | Resolves a pane's context from its surface, admits or refuses, derives the window's admission set                   | FR-1, FR-3, FR-4, NFR-1, NFR-2 |
| Window admission check (`apps/server`)    | One helper, `windowAdmitsProject`, replacing every equality site                                                    | FR-2, FR-8, FR-10              |
| Turn standing authority (`apps/server`)   | A turn's window-held calls are judged on the window's admission and on the turn's own Project                       | FR-2, FR-8                     |
| Pane presentation (`apps/web`)            | Project mark in every pane title, dock and bottom panel per active pane, approvals labelled, drag no longer refused | FR-5, FR-6, FR-7, FR-11        |

### Domain concepts

- **Lead Project:** the window's `contextByMode[mode]` Project. It is the key a
  layout is stowed under and the default for a new thread's composer. Nothing
  about authority is special to it.
- **Pane context:** the host, mode, Project and bound root of one pane, resolved
  by the server from the pane's surface.
- **Admission set:** for one mode, the lead Project plus every pane context's
  Project in that mode's layout. It is derived, never stored on its own.
- **Turn's own Project:** the Project of the thread the turn runs in, captured
  when the turn starts (as the checkout already is).

## 4. Logical design

### Component contracts

- **Workspace policy** provides `resolvePaneContext(surface, resolves)` (sync,
  pure): the context the host resolves for a surface, or a refusal;
  `admissionSet(workspace, mode)`; and `windowAdmitsProject(workspace, mode,
projectId)`. It guarantees: a pane's Project comes from the server-side
  resolver, never from the operation's own fields; a pane of another mode or host
  is refused; an admission set never exceeds the cap (NFR-1).
- **Window admission check** provides `windowCanAccessCodeProject` and
  `windowCanAccessWorkProject` with unchanged signatures, now answering
  membership in the admission set instead of equality with the lead Project. Every
  other site in "Today" moves to `windowAdmitsProject`. For a one-Project window
  the answer is identical (FR-10).
- **Turn standing authority** changes `CodeProjectAccess.standingAuthority(read)`
  to `standingAuthority(turnProjectId, read)`: inside it,
  `canAccessProject(scope, P)` is true only when the window is live, admits `P`,
  and `P` is the turn's own Project. The Work turn path and the Browser authority
  resolver get the same narrowing. It guarantees a turn never reaches another
  pane's Project, whatever the window admits (D-2).
- **Pane presentation** reads pane contexts from the bootstrap and change feed;
  it may refuse early for speed but never admits on its own.

### Domain model

```
WindowWorkspace
  contextByMode[mode]: WorkspaceContextKey       -- lead Project (unchanged)
  layouts[mode]: split tree
     pane { paneId, surface, context?: WorkspaceContextKey }   -- new, optional
  stowedLayouts[]: { context (lead), layout, activePaneId }    -- unchanged shape
```

Invariants: a pane's `context.mode` equals its layout's mode and `context.host`
equals the lead's host; a pane whose surface carries a Project has a context
whose Project equals what the resolver returns for that surface; context-free
surfaces (welcome, Settings, Side Chat) have no context; a root-backed surface
with no Project of its own (Files) takes the context of the pane it opens in;
the admission set has at most four Projects (Q-4). An absent `context` means the
lead's, so every workspace persisted today decodes unchanged.

### Data ownership

| Datum                              | Owner                                            | Readers                                   |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| Pane context                       | Workspace policy, journaled by the shell service | Every server check, the renderer          |
| Admission set                      | Derived by the workspace policy on read          | Window admission check                    |
| Turn's own Project                 | The turn (captured at start with its checkout)   | Turn standing authority                   |
| Project terminal, board, approvals | Their existing services, keyed by Project        | Unchanged; asked through the checks above |

### Integration

The renderer sends the same `split-pane`, `replace-pane-surface` and
`pin-in-pane` operations; the server resolves and journals the pane context and
returns the workspace. Approval routing ("every local window that may drive
that thread") and Needs you read `windowAdmitsProject`, so a mixed window
receives both Projects' requests. The change feed already publishes workspace
versions; the renderer redraws pane marks from them.

### Scenario walkthroughs

**W1, drop B into A's window (FR-1, FR-3, FR-4, FR-5, NFR-1).**

1. Person drags a B Code thread row onto the right edge of the A pane.
2. Renderer sends `split-pane` with the B thread surface (no longer refused or
   rerouted for another Project of the same mode and host).
3. Shell service calls `resolveWorkspaceContext`: the resolver reads the B thread
   from the journal, gets context (local, code, B, B's root), checks mode and
   host, checks the cap, and writes it on the new pane.
4. Shell service journals the workspace; the lead stays A.
5. Renderer shows two panes, each with its Project mark.

**W2, a turn in A reaches for B (FR-2, the riskiest path).**

1. A's turn calls the app-managed `#thread` read naming a B thread.
2. The Code runtime runs the call in `standingAuthority(A, …)`.
3. `canAccessProject(window, B)`: the window is live and admits B, but B is not
   the turn's Project, so it refuses `unauthorized`. The read returns the
   ordinary refusal; nothing of B is read.
4. The same holds for B's Project terminal, board and device approvals.

**W3, B pane closes while B's turn runs (FR-8).**

1. Person closes the B pane; the admission set becomes {A}.
2. B's turn keeps its captured checkout (unchanged rule) and its file and
   process tools keep working until it ends.
3. B's next window-held call (terminal, board) refuses, exactly as a rebind or
   closed window does today. Its next turn needs a window that admits B.

**W4, restore after B was archived (FR-9).**

1. Host restarts; shell service restores the window.
2. Reconciliation visits each pane: B is not an active Project, so the pane
   becomes the mode welcome and loses its context; B's terminals already ended
   `authority-revoked` when B was archived.

**W5, an approval from B while A is active (FR-7, FR-6).**

1. B's turn raises a site approval; routing finds this window admits B.
2. Needs you and the B pane's composer card name B; the dock still shows A's
   tools because A is active. Answering is keyed by B's thread, as today.

### What must still be refused

| Placement                                                    | Today   | With this design        | Why                                                                        |
| ------------------------------------------------------------ | ------- | ----------------------- | -------------------------------------------------------------------------- |
| Another Project, same mode and host (Code, then Work)        | Refused | Admitted, up to the cap | The request                                                                |
| Another mode (Chat, Work or Code into another mode's layout) | Refused | Refused                 | Each mode has its own layout, tools and authority; a thread keeps its kind |
| Another host                                                 | Refused | Refused                 | One layout talks to one host's transport and journal                       |
| A Chat Project into a layout showing another Chat Project    | Refused | Refused until Q-1       | Chat context reads and memory follow the window's one Chat context         |
| A server (SSH) Project                                       | Refused | Refused until Q-5       | Its exact window, registry and binding checks are their own                |
| A fifth Project                                              | n/a     | Refused                 | NFR-1                                                                      |
| A thread of another Project dropped on a composer as context | Refused | Refused until Q-2       | It would carry B's content into A's turn                                   |

### Security risks and how each is closed

| Risk                                                                                                        | Closed by                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 A turn in A reaches B's terminal, board, sibling transcript or device approval through the shared window | D-2: turn checks require the turn's own Project. Slice 1 ships this before any window can mix                                                                         |
| R2 A renderer names B for a pane whose surface belongs to C, or adds a Project without a gesture            | FR-3: the server resolves every pane's context from the journal; operation fields naming a Project are hints only. Layout operations still need the window capability |
| R3 B's content shows in A's dock or bottom panel                                                            | FR-6: tools already resolve against the active pane and never show another pane's content; the tests add a mixed-window case                                          |
| R4 The person approves or types for the wrong Project                                                       | FR-5 and FR-7: Project mark in every pane title at every width, Project name on approval cards and Needs you rows, terminal tabs named by Project                     |
| R5 Reach lingers after B's pane is gone                                                                     | FR-8: the admission set is derived from the current layout on every check; nothing is cached                                                                          |
| R6 A plugin enabled for A acts in B                                                                         | FR-11, CON-2: dock contributions and tool selection resolve on the pane's Project; mixing never enables anything                                                      |
| R7 Admission grows without bound                                                                            | NFR-1: cap of four Projects per mode per window; the existing 64-pane and 512 KiB limits still apply                                                                  |
| R8 A restored layout revives reach to an archived or relinked Project                                       | FR-9: per-pane reconciliation on restore, as previews already get                                                                                                     |
| R9 A missed equality site keeps the old rule and refuses, or a new site trusts the lead only                | One helper (`windowAdmitsProject`) and a style check in slice 2 that refuses `contextByMode[...].projectId` comparisons outside the domain helper                     |

### NFR mechanisms

| NFR   | Mechanism                           | Arithmetic                                                                                        | Numeric |
| ----- | ----------------------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| NFR-1 | Cap in the workspace policy         | 4 Projects × 64 panes max; each admission adds one context key (under 200 bytes) to the workspace | Yes     |
| NFR-2 | Linear walk over the layout, no I/O | At most 64 leaves, one string compare each: well under 50 µs                                      | Yes     |

### Risk register

- **A missed site.** About twenty places compare the window's one Project today;
  missing one either refuses a legitimate mixed pane (safe, annoying) or, if a
  site is widened without D-2's narrowing, opens R1. Mitigation: slice 1 lands
  D-2 alone; slice 2 replaces every site through one helper with a check.
- **ASM-1** leans on device scopes already reaching every active Code Project. If
  a maintainer reads the window binding as a deliberate extra guard beyond that,
  D-1 needs revisiting.
- **Presentation confusion** is the residual risk no server check removes; FR-5
  and FR-7 get rendered QA, not only unit tests.

## 5. Decisions

### D-1: A window admits a derived set of Projects; panes carry their own context (Proposed, 2026-11-14)

Context: the window must reach several Projects without a new stored grant that
could drift from what is on screen. Options: (a) store an explicit Project list
on the window; (b) derive the set from the panes, keeping the lead context;
(c) give each pane its own window-like capability. Choice: (b). What is on screen
is what is admitted, closing a pane ends reach, and every persisted workspace
decodes unchanged. (c) would need desktop and transport changes for no added
safety, because the server already resolves every pane.
Consequences: every equality check becomes a membership check; the Workspace and
Decisions rule "one visible tree belongs to one authority context" is rewritten
to "one visible tree belongs to one host and one mode; each pane keeps its own
Project's authority".

### D-2: A turn's window-held calls are judged on the turn's own Project (Proposed, 2026-11-14)

Context: today the window's Project and the turn's Project are always the same,
so window standing authority confines a turn by accident. Options: (a) judge on
the window's admission set; (b) judge on the admission set and the turn's own
Project. Choice: (b). It changes nothing for a one-Project window and is the one
thing that keeps a mixed window from becoming a bridge between Projects.
Consequences: `standingAuthority` takes the turn's Project; the Work turn path
and Browser resolver narrow the same way; this ships first, on its own.

### D-3: Mixing is a deliberate gesture; a sidebar click still moves the window (Proposed, 2026-11-14)

Context: a single click on another Project's thread switches the window's
Project today, stowing the layout. Options: (a) keep that, and mix only by drag,
Show side by side, or a new "Open beside" row action; (b) open the click in the
active pane, which would mix the window on every browse. Choice: (a), pending
Q-3. Consequences: no surprise growth of the admission set while browsing.

## 6. Coverage

| Requirement                    | Capability   | Component                                 | Slice |
| ------------------------------ | ------------ | ----------------------------------------- | ----- |
| FR-2, FR-8                     | Judge        | Turn standing authority                   | 1     |
| FR-1, FR-3, FR-4, NFR-1, NFR-2 | Admit        | Workspace contract and policy             | 2     |
| FR-9, FR-10                    | Persist      | Workspace policy, shell service           | 2     |
| FR-11, CON-2                   | Judge        | Window admission check, pane presentation | 2     |
| FR-5, FR-6, FR-7               | Show         | Pane presentation                         | 3     |
| Work Projects                  | all          | all                                       | 4     |
| FR-12, FR-13                   | per Q-1, Q-2 | —                                         | Later |

## 7. Build plan

| Slice | What it delivers                                                                                                                                                                                     | Requirement IDs                                    | Status  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------- |
| 1     | Turn standing authority narrows to the turn's own Project (Code turns, Work turns, Browser resolver). No visible change; mixing still refused. The riskiest contract, proven before anything can mix | FR-2, FR-8, FR-10                                  | Planned |
| 2     | Pane context in the contract, policy admission for Code, `windowAdmitsProject` at every site, cap, restore reconciliation, renderer stops refusing same-mode Code drops                              | FR-1, FR-3, FR-4, FR-9, FR-11, NFR-1, NFR-2, CON-3 | Planned |
| 3     | Presentation: Project mark in every pane title, Project-named approvals, Needs you rows and terminal tabs; rendered QA at split widths; Workspace, Architecture and Decisions updated                | FR-5, FR-6, FR-7                                   | Planned |
| 4     | The same for Work Projects                                                                                                                                                                           | FR-1 to FR-11 for Work                             | Planned |

Slices 2 and 3 should land together or 3 directly after 2, because a mixed window
without the Project marks is the R4 risk. Slice 1 is safe to land alone.

### Acceptance tests

| Test                                                                                                                                         | Level                                    | Slice |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----- |
| A Code turn's `#thread` read, terminal read and board call for a Project other than its own refuse `unauthorized` under standing authority   | Server (codeProjectAccess, Code runtime) | 1     |
| The same calls for its own Project succeed in a one-Project window, unchanged                                                                | Server                                   | 1     |
| A Work turn and a Browser call get the same narrowing                                                                                        | Server                                   | 1     |
| `split-pane` of a B Code thread into an A Code window is admitted; the pane records B's context; the lead stays A                            | Domain (shellPolicy)                     | 2     |
| A surface claiming B but naming a C thread records C, or refuses when C is not active                                                        | Domain                                   | 2     |
| Cross-mode, cross-host, server Project and fifth-Project placements refuse with their messages                                               | Domain                                   | 2     |
| `windowAdmitsProject` is true for A and B, false for C; false for B once B's pane closes; B's Project terminal attach refuses                | Server                                   | 2     |
| A workspace persisted today decodes and behaves unchanged                                                                                    | Contracts, server                        | 2     |
| After B is archived, restore turns B's pane into the welcome and drops B from the set                                                        | Server (shellService)                    | 2     |
| A plugin enabled for A contributes no tool to the B pane                                                                                     | Web integration                          | 2     |
| Dropping a B thread on an A pane edge shows two panes with no refusal                                                                        | Web integration                          | 2     |
| Each pane shows its Project mark at 360px; the B approval card and Needs you row name B while A is active; terminal tabs carry their Project | Web integration + rendered QA            | 3     |
| The dock shows only the active pane's Project's tools when switching panes                                                                   | Web integration + rendered QA            | 3     |

## 8. Open questions

| ID  | Question                                                                                                                               | Recommendation                                      | Blocks         | Asked of    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------- | ----------- |
| Q-1 | Which modes mix: Code only, Code then Work, or Chat Projects too?                                                                      | Code first, Work next; Chat Projects later          | Slice 4, FR-13 | Maintainers |
| Q-2 | May a person attach a thread from another Project as context to a composer (drag onto the composer, `#` mention)?                      | Refuse at first; it moves B's content into A's turn | FR-12          | Maintainers |
| Q-3 | Does a sidebar click on another Project's thread keep moving the window, with mixing only by drag, Show side by side or "Open beside"? | Yes (D-3)                                           | Slice 2        | Maintainers |
| Q-4 | How many Projects per mode may one window reach?                                                                                       | Four, matching the 2×2 Show side by side            | NFR-1          | Maintainers |
| Q-5 | Do server (SSH) Projects mix with local ones?                                                                                          | Not at first                                        | CON-3          | Maintainers |

## 9. Codebase deltas and change log

### Codebase deltas

| Where code and this design differ                                                                 | Ruling                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `resolveWorkspaceContext` refuses another Project of the same mode                                | Code migrates in slice 2                                                  |
| Renderer `refuseCrossAuthority` and the sidebar drag reroute refuse or switch for another Project | Code migrates in slice 2; mode and host refusals stay                     |
| Server sites compare `contextByMode[mode].projectId` for equality                                 | Code migrates to `windowAdmitsProject` in slice 2                         |
| `standingAuthority` judges only the window                                                        | Code migrates in slice 1                                                  |
| Workspace and Decisions state "one visible tree belongs to one authority context"                 | Specs change with slice 2; this doc stays a Draft proposal until approved |

### Change log

- 2026-11-14: First draft for maintainer review.
