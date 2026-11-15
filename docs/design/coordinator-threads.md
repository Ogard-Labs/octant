# Coordinator threads

This topic specification owns coordinator threads: long-lived Code threads whose
agent splits a Project's work into worker threads, starts them, talks to them,
and brings their questions back to the person, so the person can talk to one
thread per line of work instead of tracking many. It covers what makes a
coordinator different from an ordinary thread, the `start` operation and the
setting that restricts it, how a coordinator and its workers reach each other,
and its bounds. Architecture owns the boundaries it extends:
[modes and thread authority](../architecture.md#modes-chat-work-and-code)
(the Project planner, `octant_threads`, agent-to-agent messaging and its wake),
[outside-content marks](../architecture.md#persistence), and
[security and authority](../architecture.md#security-and-authority). The
sidebar and board presentation is in
[Workspace: Coordinators](workspace.md#coordinators).

**Status: approved design 2026-11-10 (maintainer request); built.** The host
side, the workspace surfaces recorded in
[Workspace: Coordinators](workspace.md#coordinators), the planner carry-over,
the proposal card in the coordinator thread, workers' requests in the
coordinator's composer and as rows in its thread view, the coordinator named on
Needs you rows, the owner
device's routes and screens for the wake switches, the proposal review
prefilled from the request, the read-only proposal card on paired clients, and
counts that survive a restart are built. None of it has run against a real
provider or on the desktop app; whether each runtime's own tools honour the
read-only gate is a maintainer live check.

## What a coordinator is

- **A role on a Code thread.** A person makes a coordinator either with
  **New coordinator** in a Code Project's sidebar menu, which creates a thread
  that is one from the start, or with **Make coordinator** in an existing
  thread's header or row menu. **Stop coordinating** in the same menus makes it
  an ordinary thread again. Only a person does any of this, from a local window
  on the host or a device the host's own person paired (maintainer decision, 2026-11-12); an agent, a routine, or a peer cannot. The role
  is a field on the thread's own record: each change is journaled as
  `code.thread-updated@1` under the thread's expected version (commands
  `set-code-thread-coordinator`, `set-code-thread-coordinator-bounds`,
  `set-code-thread-message-wake`, and `set-code-thread-coordinator-wake`), a
  stale version is refused, and the Code commands route refuses all four from
  anything but a local window or a device the host's own person paired. A new
  thread's creation command may not carry the role, lineage, switches, bounds,
  or workers' level.
- **Several per Project.** A Code Project may have up to four coordinators at
  once, for separate lines of work (one for the backlog, one for a dependency
  audit). Each coordinator has its own workers.
- **It replaces the planner role.** The Project's designated planner reads as a
  coordinator whose starts always need approval, derived from the designation
  with no journal change: it takes the read-only gate and the roster, its
  `start` always proposes whatever the start setting, its pending proposals
  stay pending, and it counts toward the four per Project. Designating a worker
  or a fifth coordinator is refused (`thread-is-worker`,
  `coordinator-limit-reached`). Its role follows the designation, so **Make
  coordinator** and **Stop coordinating** are not offered on it; removing the
  designation ends it. Designation does not turn on its **Wake when a message
  arrives** switch. The planner's `board` read and board offers keep working;
  since the board leaves coordinators out, that read no longer lists the
  planner's own card.
- **Code only.** A Work thread may message a sibling (maintainer request,
  2026-11-12), a Work turn carries the messages left for it, and a message
  wakes an idle Work thread whose **Wake when a message arrives** switch is
  on, under the same bounds as Code (maintainer decision, 2026-11-13;
  [Architecture: modes](../architecture.md#modes-chat-work-and-code)). That
  removes what kept a Work coordinator from hearing back while idle. The
  role itself (`start`, the roster, the read-only gate, state notices) is
  still Code's: Work coordinators are not built.

Rationale: a role on an existing thread, rather than a fourth thread kind, keeps
the mode's authority and the thread's posture exactly as they were, which
architecture requires of every thread, and lets a person promote the thread
where the planning conversation already happened. The planner was the same idea
limited to proposals; keeping two roles that differ only in whether a person
approves each start would split one feature into two.

## How a coordinator differs from an ordinary thread

An ordinary thread does one task and finishes. A coordinator stays open for as
long as its line of work lasts, and its job is to direct workers rather than to
make changes itself.

- **It reads; its workers write.** A coordinator's own file, shell, and Git
  actions go through the same read-only gate Plan mode applies, whatever its
  guardrail level. Reading the checkout, GitHub reads, Canvas, `ask-user`,
  Project memory, and the coordinator operations below stay offered, and child
  runs it delegates take the same read-only gate. Its guardrail level does not govern its own actions; it is the
  ceiling for the workers it starts. It opens no pull request of its own
  (`octant_pull_request` is not offered).
- **No delivery target and no Done.** A coordinator has no delivery target,
  never appears as a board card, and is never Done. A person stops it with
  **Stop coordinating**, or puts it away or archives it like any thread.
- **Its context is built for a long life.** Every coordinator turn carries a
  host-written roster of its workers: each worker's reference, state, and when
  the state last changed, at most 32 rows with the most recently changed first
  and truncation stated. The roster names no titles, since a title is text an
  agent wrote, so it does not mark the coordinator. The host writes it again at
  every turn, so compaction never loses it. What the coordinator learns belongs
  in Project memory, as for any thread. It also carries the person's
  Orchestration text, which no ordinary thread gets; the text guides when and
  how it starts workers and grants nothing
  ([Octant instructions](octant-instructions.md)).
- **It is set apart in the workspace.** A coordinator sits in its own section
  at the top of its Project, with its workers folded under it
  ([Workspace: Coordinators](workspace.md#coordinators)).

Rationale: a thread that may start other threads without asking, whose context
keeps growing and keeps reading what its workers wrote, is the worst place to
also hold write authority over the checkout. Keeping its own actions read-only
means every change happens in a worker that has its own worktree, delivery
target, review, and Done, which the person already knows how to check.

## Starting workers

A coordinator starts a worker with the `start` operation of `octant_threads`.

- **Offered to coordinators only.** `start` is offered only to a thread that is
  currently a coordinator, and the host decides the role again on every call,
  so **Stop coordinating** takes effect mid-turn. A worker is never a
  coordinator and is never offered `start`, so workers do not start workers;
  they keep `octant_agents` for their own child runs. `start` is left out in
  Plan, and a non-empty profile allowlist must name `octant_threads.start`.
- **Input.** A title (at most 80 characters), the worker's opening prompt (at
  most 4,000 characters), and optionally a guardrail level. Once model roles
  are set up (Builder has a model), the call also names `task` (`small-fix`,
  `feature`, `ui`, `tests`, `docs` or `review`) and `size` (`quick`, `normal`
  or `hard`), and may name `retries` and `reviews` (a worker of its own, by
  reference), `risk: high`, `needsImages`, and an override: `role`
  (`quick-edit`, `builder`, `hard-problems`, `reviewer`) or `model` (a handle
  from the role card), each with `why` (at most 200 characters). With roles set
  up, a raw provider or model id is refused (`policy`); the host chooses
  ([Choosing the worker's model](#choosing-the-workers-model)). With no roles
  set up, the call may name a provider and model as before, and `role` and
  `model` are refused. The model supplies no Project, path, checkout, or
  window.
- **What it creates.** An ordinary Code thread in the coordinator's own
  Project, through the ordinary Code creation command, on a new managed worktree
  from the Project's main directory at its committed revision. The worker's
  opening prompt is its first message, sent through the normal first-message
  path. Its first turn has the `agent` initiator with the kind
  `coordinator-start`, the way a routine's turn starts, so every approval waits
  for a person. With roles set up it runs on the model the host chose from
  them. With none, and no provider named, it runs on the coordinator's own
  provider and model; a named provider the host does not know refuses
  `provider-unavailable`, a provider or model the Project's policy disallows
  is refused by the ordinary creation command, and nothing falls back to
  another model.
- **Authority.** The person may fix the workers' level when creating the
  coordinator at a local window or a device the host's own person paired
  (built for that device, journaled as it; maintainer decision, 2026-11-13),
  Full access included; every
  worker then
  starts at that level, and a mark on the coordinator does not lower it
  ([the Full access rule](../architecture.md#security-and-authority);
  maintainer request, 2026-11-12). With no fixed level, the worker's guardrail
  level is the one named, or the coordinator's level when none is named, and
  never higher than the coordinator's, and a worker started by a marked
  coordinator never starts at Full access. The person picks the fixed level
  in the New coordinator draft (**Workers start at**); the host accepts it
  only on the command that makes the thread a coordinator, journals it on the
  thread (`coordinatorWorkerLevel`), refuses a later change to it, and drops
  it at **Stop coordinating**. With a fixed level a level named in the call
  is not read, and a proposal carries the fixed level. **Make coordinator**
  offers the same choice in a submenu (this thread's level or lower, or
  always one named level), sent on the same command (maintainer decision,
  2026-11-13). After creation
  the worker's level is the person's to change, as on any thread.
- **Lineage.** A worker belongs to the coordinator that started it. The host
  records that on the worker at creation and never changes it. When the
  coordinator stops coordinating, is archived, or is deleted, its workers stay
  as ordinary threads; they keep the lineage as history, and nothing wakes them
  for that coordinator any more.
- **Journal.** An admitted start is journaled as the worker's own
  `code.thread-created@1`, whose thread record carries the coordinator, the
  provider, model, and level, and, when the roles chose the model, how
  (`coordinatorChoice`: the role, where the model sits in its list, the
  host's reason, and the coordinator's `why`), never the prompt. The prompt
  lives where any first message lives. No wire command carries the choice; a
  later model change by anyone but the host's own restart on the next model
  records it as a person's pick.
- **Refusals.** A refused call returns one closed reason: `unauthorized` (the
  caller is not a coordinator), `policy` (Plan, a profile without the operation,
  a malformed input, a level above the ceiling, a raw id or a missing `task` or `size` with
  roles set up, an override without `why`, a retry below the tier it must
  climb to), `limit-reached` (the open-worker
  bound), `rate-limited` (the hourly bound), `provider-unavailable`,
  `model-not-eligible` (the named handle cannot start now), `no-eligible-model`
  (nothing in the role or the roles it may borrow can), or `unavailable` (the
  host could not create or journal the worker). A refusal creates nothing. A
  refusal about models lists each model's reason and the role card, so the
  next call can be right.

### Choosing the worker's model

Workers take their model from the [model roles](model-endpoints.md#model-roles)
in Settings, which a Project may choose per role (maintainer decision,
2026-11-15). One pure policy, `chooseWorkerModel`, decides on the host at
every `start`; the renderer and the agent decide nothing.

1. **Role.** `role` when named; else one tier above the `retries` worker
   (Quick edit → Builder → Hard problems; Reviewer and Hard problems retry as
   Hard problems), never lower than `size` picks; else `size`: `quick` → Quick
   edit, `normal` → Builder, `hard` → Hard problems. A `review` goes to
   Reviewer, or to Hard problems with `risk: high`. A retry never goes down: a
   `role`, or a `model` handle listed only in roles below the tier the retry
   starts in (Builder when that role is empty), is refused. An empty role uses
   Builder's list and says so.
2. **Models.** The role's list as the Project chose it, else as Settings has
   it: the main model first, then the fallbacks.
3. **Hard rules.** A model is passed over when its provider is turned off,
   signed out or down (its check failed, or its last request failed with an
   availability error within 5 minutes), the model is not offered, the account
   is at a usage limit (a failed request's own limit signal, or the host's
   plan-usage reading of a window the provider flagged exhausted or at 100%,
   a quota flagged exhausted with no window, or a request or token bucket
   with nothing left, until its reset; a reading below the limit never
   filters), the Project's
   policy or data rules disallow it, an endpoint Octant runs has not proven its
   tools, or `needsImages` is set and it cannot read images while Sees images
   cannot describe one for this Project. With Sees images able to (a model in
   the role the Project's rules allow, ready, and on a connection that takes
   images from Octant), image work may go to a builder that cannot read
   images: the builder is offered `look`, and an image attached to its turn
   is described for it ([Architecture: Sees images](../architecture.md#sees-images)). A review passes over models on the reviewed worker's provider
   while one on another provider is left.
4. **Answer.** The first model left starts. The host records whether it was
   the main model or the n-th fallback, and why ("main Opus 5.5 at usage limit
   until 14:00 UTC").
5. **Borrowing.** When every model of the role is passed over, the role
   borrows the next tier's list: Quick edit → Builder → Hard problems, Reviewer
   → Builder → Hard problems, Hard problems → Builder, recorded as "lower tier:
   all Hard problems models unavailable". Nothing left anywhere refuses
   `no-eligible-model`.
6. **A named model.** `model` names a handle from the role card; it starts
   only if it passes the same rules, the review's independence included,
   else `model-not-eligible` with its reasons. It never reaches a model
   outside the roles.

The availability marks are host memory, fed by the runtime-event tap every
driver's turns pass through: a failed request whose failure is `unavailable`
or an overload marks its provider down for 5 minutes, a usage limit marks it
until its reset (5 minutes when the provider named none), and a completed
request clears both. A restart forgets them.

- **The first request fails.** When a worker's first turn fails with an
  availability error before any text, reasoning or tool call, and it has done
  no other work, the host marks the provider down, moves the worker to the
  next eligible model of its role (the ordinary provider change, with its
  disclosed hand-off, journaled as the host), records that choice with "first
  request on <model> failed before any work", and sends the same opening
  prompt again. This is still the start. It moves again if that model's first
  request fails the same way, and stops once every listed model has failed
  once; a worker a person archived, marked Done or moved to another model
  meanwhile is left alone, and the model they chose is not marked down for
  the earlier failure. The host knows a turn failed before any output only when the
  provider recorded a session for it; a turn whose provider never got that far
  is left as it is, and the coordinator hears of it as a state notice. A next
  model that would ask a person first, or none at all, leaves the worker too.
  The prompt is kept in memory for up to 15 minutes for this, never journaled.
- **Ask before using.** A start whose role has **Ask before using** becomes a
  proposal through the proposal path below, even under Start without asking,
  and a retry that climbs into such a role asks too; a named model asks when a
  role listing it asks. The proposal carries the role, the model and its
  name, the choice, and the request's filters (needs images, the provider a
  review avoids); its card reads "Hard problems · Opus 5.5 · <why>" and
  offers **Use Builder instead** beside approve and decline, which runs the
  choice again in Builder with those filters and keeps the proposal pending on that model, under
  the proposal's version. Approving on the proposed model journals the host's
  choice on the worker; approving on another model records the person's pick.
- **The role card.** Every coordinator turn with roles set up carries a
  host-written role card right after the roster: per worker role (Builder,
  Quick edit, Hard problems, Reviewer) its models by handle (`b1`…), each with
  its name, provider, context size when known, images yes or no, and ready,
  at limit until, down, not signed in, turned off, not allowed or tools not
  verified; whether the role asks first; Sees images; and a track record per
  handle from this coordinator's own last 20 workers (started, Done, closed
  without Done). Cost tiers are not shown, since no provider reports one. The
  card holds only host facts, provider-reported model names and names the
  person chose, so it never marks the coordinator.

Not in this slice: continuing a running worker on a fallback (**Continue on
the fallback if the model stops** is stored and not read), and an `escalate`
reply. Rationale: fallback happens only at the start, so a running worker
keeps its model, as threads do; the person's fallback order is the consent for
moving a worker that has done nothing yet.

### The start setting

Coordinators start workers without asking by default. A person who wants to
restrict that can do it for the whole host or for one Project.

- **Settings › Code › Coordinators** has **Starting workers**, with two values:
  **Start without asking** (the default) and **Propose for approval**.
- A Code Project's overview has the same choice with a third value, **Use
  Settings**, which is that Project's default. A Project choice wins over
  Settings.
- Only a person changes either, from a local window on the host or a device the host's own person paired (maintainer decision, 2026-11-12); an agent, a routine, or a peer cannot. Each change is journaled with
  its
  principal. The host reads the setting at every `start` call, so a change
  applies to the next call, a running turn included.
- Under **Propose for approval**, `start` creates nothing. It journals a pending
  proposal with the title, the prompt as its intent, and the requested provider,
  model, and level, through the planner's proposal path, with its bound of ten
  waiting proposals per Project; the proposal keeps the provider and model the
  call named or the roles chose (with the choice), and the level it resolved, and approving it cannot start the
  worker above that level (`creation-above-proposed-level`). The coordinator is
  told `proposed`. A person approves or declines it from a card above the
  coordinator's composer or from the Project overview, with the same **Review
  and approve** and versioned decline; an
  approved proposal creates the worker exactly as an unasked start would,
  recorded as that coordinator's worker. The review states the request, starts
  on the requested provider and model when the window can select them, starts
  its mode at the requested level, and offers no mode above it. A paired browser
  or phone reviews and answers the same proposals as a window does (maintainer
  decision, 2026-11-12). Built on the server: the proposal routes take an answer from a local window or a device the host's own person paired. Not built yet: a paired browser or phone still shows them read-only (title, intent, requested level) with "Approve at a window on this computer", through the planner read the remote session already has.

Rationale: the person who enables a coordinator asked for work to happen without
a click per thread, and a worker can do nothing a person could not have started
under the coordinator's own level: its first turn's approvals wait for a person,
its spend counts against the Project ceiling, and its changes stay on its own
worktree until it delivers. People who run coordinators on a shared or billed
account, or who want to see each task before it starts, keep the planner's
approval flow with one switch.

### Bounds

- **Open workers.** A coordinator may have at most six open workers (neither
  Done, put away, archived, nor deleted) by default. A person sets this from 1 to
  16 in Settings › Code › Coordinators; an agent cannot.
- **Starts per hour.** At most 60 `start` calls per coordinator in any hour by
  default, admitted or proposed. A person sets the bound per coordinator, from
  1 to 600; an agent cannot (maintainer request, 2026-11-12). It is one of the
  coordinator's three bounds, with the wakes per hour and the rounds in
  [Talking to workers](#talking-to-workers): the command
  `set-code-thread-coordinator-bounds` replaces all three, a bound left out
  returns to its default, and they are journaled on the coordinator's own
  record (`coordinatorBounds`) and dropped at **Stop coordinating**. A
  coordinator journaled before the bounds existed has none stored and takes the
  defaults. The New coordinator draft sets them, and **Coordinator limits…**
  in a coordinator's row menu and pane header menu opens the three numbers
  for a running coordinator and saves them with that command (maintainer
  decision, 2026-11-13); a bound left at its default is not sent. The
  designated planner holds no bounds of its own and is not offered the item.
  The host records each call in its own store, beside the
  wake turns and each thread's latest host turn with its hop, so the count holds
  across a restart; it never reads fewer than the workers the coordinator's
  lineage shows created in that hour, so starts made before the record existed
  still count.

  Rationale: the count is not derived from workers' creation times alone,
  because a start that proposed or that the host failed to create leaves no
  worker. These counts are host-local bounds, not facts other surfaces read,
  so they live in a small store (migration `create_coordinator_count_store`)
  rather than as journal events; a row older than an hour bounds nothing and is
  pruned, and a purged thread's rows go with it.

- **Ordinary gates.** Each worker's turns take ordinary turn admission: capacity
  gating, spend ceilings, usage limits, and the Done lock all apply unchanged.

### Outside content

A worker started by a marked coordinator starts marked, by the rule that already
marks follow-ups and planner proposals (label `coordinator-start`, content
reference `coordinator-start-<coordinator thread>-<worker thread>`). The host
reads the coordinator's mark at the start and hands it to the Code creation as
the same host-only input; a mark that cannot be journaled refuses the start and
creates nothing. Under **Propose for approval**, the mark is read again at the
confirm, as for a planner proposal.

Rationale: a coordinator is marked almost all the time, because reading a
worker's transcript or a delivered message marks it. Child runs refuse to start
from a marked parent, but applying that rule here would stop a coordinator after
its first read. Carrying the mark instead keeps the protection where it acts:
the marked worker asks for single-use confirmation on risky actions, and the
Full access cap keeps that confirmation from being switched off at the start.
A level the person fixed for the workers is the person's own choice and is not
capped ([Starting workers](#starting-workers)).

## Talking to workers

- **Coordinator to worker.** The coordinator uses `send`, as any Code thread
  does, with the messaging rules unchanged. A worker wakes for a message from its
  own coordinator without the person turning on its **Wake when a message
  arrives** switch: turning on starting workers is the person's consent for a
  coordinator to drive the threads it starts. A message from any other thread
  wakes the worker only when its switch is on. A person can stop a worker from
  waking for its coordinator with **Wake for coordinator** in the worker's
  row menu or pane header menu, journaled with its principal.
- **From a paired device.** A device the host's own person paired sets these switches as a local window does (maintainer decision, 2026-11-12; built on the server). A device the host knows only through the hub's roster sets them only as an owner device, which may set **Wake when a message
  arrives** and **Wake for coordinator** (never the coordinator role) through
  the owner routes `code-threads/wake/read` and `code-threads/wake/change`. Each
  change needs its own fresh unlock, is checked against a digest of the current
  thread and Project, and is journaled as the owner device; refusals are
  `not-found`, `not-a-worker`, `wake-stale`, and `refused`. A roster member that is not an owner device cannot set them, and an agent never can. The owner access recovery
  screen
  on the phone and in a browser's owner section shows them for a chosen Code
  thread: **Read wake switches** (covered by an open administration session),
  then a Turn on or Turn off per switch, each asking for its own unlock, after
  which the reading is dropped and each refusal is stated in words.
- **Worker to coordinator.** A worker uses `send` to its coordinator. Making a
  thread a coordinator turns on its **Wake when a message arrives** switch, as
  part of the person's journaled change; the person can turn it off as on any
  thread.
- **State notices.** When a worker's turn ends, when it starts waiting for a
  person (an approval, a question, or a usage-limit pause), and when it becomes
  Done, the host queues a notice for its coordinator: the worker's reference,
  the new state from a closed set, and the time. A notice carries no text an
  agent wrote, so it does not mark the coordinator. At most one notice waits per
  worker; a newer state replaces it. Notices reach the coordinator's next turn
  beside its roster and wake it when it is idle, under the wake bounds below.
- **Bounds on waking.** Wake turns keep the messaging bounds: one at a time per
  thread, an hourly count per thread, and the hop count. The hourly count and
  the rounds are settings a person changes per coordinator, with defaults of
  30 wakes per thread in any hour and 10 rounds; an agent cannot change them
  (maintainer request, 2026-11-12). A person sets the wakes from 1 to 600 and
  the rounds from 1 to 100 ([Bounds](#bounds)). A coordinator's bounds apply
  to its own wakes and to its workers' while it holds the role; every other
  thread, a worker whose coordinator stopped included, takes the defaults. A
  state notice
  takes the hop count of the worker turn that caused it, so a coordinator and a
  worker answering each other stop waking each other after the round bound and
  continue when a person runs a turn on either. The wake turns and hops are
  recorded in host storage, so a restart neither resets the hourly bound nor
  lets a round past the bound wake; pending state notices stay in memory, since the
  first sweep after a restart reads every worker's state again. Each wake is
  journaled when it is decided and when its turn starts or it is dropped, with
  only the worker change a notice wake was decided on, so a restart continues
  or holds a wake that never started its turn
  ([Architecture: coordinator wake restart recovery](../architecture.md#persistence)).

Rationale: without notices, a coordinator learns that a worker finished only by
polling with `wait`, which spends its turn budget and its context. A closed set
of states is enough to decide whether to read the worker, and it keeps the
coordinator unmarked until it chooses to read.

## Questions and approvals

The main signal moves from "a thread finished" to "something needs you", and it
reaches the person through the coordinator they are already talking to.

- **In the coordinator's composer.** A worker's pending approvals and questions
  are listed in its coordinator's composer, the way a child run's requests are
  listed in its parent's, with the worker named and an Open worker action. The
  person answers them there or in the worker; both answer the same request.
- **In the coordinator's thread view** (maintainer decision, 2026-11-14). Each
  pending ask also shows as a request row at the end of the coordinator's
  transcript, oldest first, naming the worker (which opens it) with the same
  answers the composer offers. It is the same request through the same answer
  path, so answering it anywhere settles every copy. A row whose request
  leaves the list stays until the thread view closes and reads its outcome:
  what the person chose, when they answered in that row, or that it is no
  longer waiting, since the list does not say whether it was answered
  elsewhere or its turn ended. At most 12 settled rows stay, the oldest leaving
  first. The coordinator agent is never offered a way to answer it.
- **The person answers, not the coordinator.** A coordinator agent never answers
  a worker's approval or question. It can read the worker, ask the person with
  `ask-user`, and `send` the worker what the person decided, but a pending
  approval stays the person's.
- **Needs you.** A worker's request stays a Needs you row naming the worker,
  with "via" its coordinator beside it, in Needs you and the Inbox. The board's
  and Review's embedded rows show no thread title, and a board card names the
  coordinator itself.
- **Where the composer's list and the rows come from.** The window's existing
  pending-requests read, filtered to the coordinator's workers in the window's
  thread list, so a window sees no request it could not already see. The
  composer shows one request at a time with a choice between them; the thread
  view shows every one as its own row. A finished turn's decision
  stays in Needs you and the worker, since it is not the worker waiting.

## Seeing workers' subagents

A coordinator's Agents dock lists its workers and, in Graph, draws each
worker's subagents under it ([Workspace: Coordinators](workspace.md#coordinators)).

- **The workers come from the window.** The rows are the workers in the
  window's own thread list, with the state that list shows, so the dock names no
  thread the sidebar does not.
- **Their subagents come from one host read.** `GET
/api/agent-runs/coordinator-graph` answers for one coordinator: per worker,
  that worker's child runs as facts (task, role, state, the route that ran it,
  effort, the runs it waits for, the run that started it, and the times it was
  requested and last changed), at most 24 runs per worker with the newest kept
  and truncation stated, for the roster's workers that are recorded in the
  coordinator's own Project, under the roster's bound. A worker with no runs is
  left out.
- **Who may read it.** A window that holds the coordinator on its Project, by
  the rule every read of a thread's child runs takes, and only while that thread
  reads as a coordinator. A window that does not hold it, a thread that is not a
  coordinator, and a thread that stopped coordinating are refused alike, with
  one message and before any worker's run is read.
- **What it never carries.** A run's reply, its result packets, its recovery
  text, its live conversation, and the version a control needs. Those stay with
  the worker thread's own reads, which a window gets only by holding that
  worker, so a card opens the worker and offers no control. The host does not
  load a reply to build the answer.
- **The agent sees none of it.** The read serves a person's window. It is not a
  tool, it is not offered to the coordinator agent, and it adds nothing to a
  turn, so it cannot mark the coordinator.

Rationale: a child run's summary carries its full reply, which is why a window
may read one only for a thread it holds. Workers are almost never open beside
their coordinator, so that rule alone leaves the coordinator's picture empty
below the workers. The task of a run is text its worker's agent wrote, as a
worker's title is, and the window already lists that; what the worker found
stays behind the worker. Reading facts through the coordinator is the smallest
widening that shows the orchestration (maintainer request, 2026-11-11).

## Model roles

Workers pick their model from the model roles in Settings, which a Project
may override per role (maintainer decision, 2026-11-15; see
[Model endpoints: Model roles](model-endpoints.md#model-roles)): Planner,
Scout, Quick edit, Builder, Hard problems, Reviewer, Sees images and Small
jobs, each a list with a main model and fallbacks, and two choices per role,
**Ask before using** and **Continue on the fallback if the model stops**.
Choosing by task and size, falling back at the start, borrowing the next
tier, and asking before a role are built
([Choosing the worker's model](#choosing-the-workers-model)). Continuing a
running worker on the fallback, and describing images for a model that cannot
see, are designed, not built.

## Not in this design

- A coordinator cannot stop, steer mid-turn, complete, put away, archive, or
  delete a worker; it has `send`, and the person has the ordinary controls.
- Coordinators in Work, coordinators across a hub's members, and phone or CLI
  surfaces for the role or the start setting.
- A Canvas that collects a person's choice and returns it to the thread; inline
  questionnaires through `ask-user` cover choices in the thread.

## Verification

When this is built, the tests that matter are the authority edges: `start`
refused for a non-coordinator, a worker, Plan, and a profile without
`octant_threads.start`; the level ceiling and the Full access cap for a marked
coordinator; **Propose for approval** creating nothing until a person confirms;
the start setting and the role refused from an agent, a routine, and a paired
device; a marked coordinator's worker starting marked, and a mark that cannot be
journaled refusing the start; the open-worker and hourly bounds; state notices
not marking the coordinator; the hop count stopping a coordinator and worker
after the round bound; and a coordinator's own write, shell, and Git actions
refused by the read-only gate. For the model choice: every hard rule, the size
map, an empty role using Builder, a Project's role beating Settings, a retry
climbing and never dropping, borrowing and the lower-tier flag, a review
avoiding the reviewed provider, an override without `why` refused, a named
model refused with its reasons, nothing outside the roles ever returned, raw
ids refused once roles exist and today's model with none, an ask-first role
proposing under Start without asking, the choice journaled without the
prompt, a usage-limited main model starting the fallback with its reason, a
first request that failed before any work moving the worker, the marks
expiring after 5 minutes, and the role card not marking. For the workers' subagents: the graph read
refused for a window that does not hold the coordinator and for a thread that is
not a coordinator, before any run is read; and its answer carrying no reply,
result, recovery text or version. Rendered checks cover the sidebar section, the
folded workers, the composer's worker requests, the worker request rows in the
thread view, and the dock's worker rows and
graphs.
