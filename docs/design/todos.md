# To-dos

This topic specification owns the person's own to-do list: what a to-do holds,
where the list lives and who may change it, how every device and computer the
person connected sees the same list, how tags and Projects attach to a to-do,
how a to-do is handed to an agent, and the To-dos destination. Architecture
owns the boundaries it builds on: the journal and projections
([Persistence](../architecture.md#persistence)), the rule that hosts never
trust each other and that mutations name one destination
([Security and authority](../architecture.md#security-and-authority)), modes
and Projects ([Modes](../architecture.md#modes-chat-work-and-code)), and release
scope ([Current Release Boundary](../architecture.md#current-release-boundary)).
[Hub and spokes](hub-and-spokes.md) owns the hub, owner devices and the
roster; [Workspace](workspace.md) owns the icon rail and pages.

**Status: approved design 2026-11-14 (maintainer decision); partly built.**
The list on one host is built: its events, the list rebuilt from them, the
`/api/todos` read and command routes, version-checked edits, and the refusals
for every caller but the person. Not built yet: the To-dos destination, Start,
the list host setting, reaching a list on another host, live updates to other
clients, and the phone screen. [Delivery plan](#delivery-plan) lists the order
of work.

## Outcome

A person keeps the things they mean to do in one place, beside their threads.

1. They add a to-do in a few seconds from any window, phone or browser.
2. They attach it to one or more Projects and give it their own tags.
3. They filter the list by Project, tag and state.
4. When they are ready, they press Start: the to-do becomes a thread in the
   right Project and mode, and the to-do shows that thread's state.
5. Every device and computer they connected shows the same list.

**Not in scope:** sharing a list with other people, syncing to-dos with an
issue tracker or forge (GitHub and Linear keep their own surfaces), due dates
and reminders, and any Octant-operated service.

## Terms

| Term      | Meaning                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| To-do     | One item the person wrote: a title, optional notes, Projects, tags, a state, and links to the threads started from it |
| List host | The one host whose journal holds the person's to-dos. Every device and window reads and changes the list there        |
| Started   | A to-do with at least one linked thread that the person has not yet ticked off                                        |

"Task" already names a thread in Work and Code (New task), the agent's own
list in a thread's Tasks panel, and side tasks an agent offers. The person's
list is called **To-dos** everywhere, in copy, routes, events and code, so the
two never meet in one word.

## What a to-do holds

- **Title:** the person's text, at most 280 characters, one line.
- **Notes:** optional, at most 8,000 characters, plain text.
- **Projects:** zero to eight links, each `{ hostId, projectId }` plus the
  Project's name as last seen, so the row reads when that host is
  unreachable. A link is a pointer; it grants nothing on that host.
- **Tags:** zero to twelve, each at most 40 characters, exact labels as
  Canvas tags are: trimmed, and two tags that differ only in case are two
  tags. A repeated tag is kept once. Tags belong to to-dos only; Projects get
  no tags.
- **State:** `open`, `done` or `dropped`. Started is derived (open with a
  linked thread), not stored.
- **Thread links:** each thread started from the to-do, as
  `{ hostId, threadId, mode }`, newest last.
- **Order:** a rank the person sets by dragging; new to-dos go on top. A
  move takes the rank halfway between its new neighbours; once repeated moves
  into one gap leave no number between them, every to-do is renumbered in
  the new order.

One list holds at most 5,000 to-dos, done and dropped included; adding past
that is refused as `list-full`.

To-do text is the person's own typing and is treated like a message they
type: the journal's secret redaction applies before it is appended, and it is
never sent to a model except as the prompt of a thread the person starts.
Person memory does not read to-dos.

## Where the list lives

Every person has one **list host**.

- **Default.** A host that belongs to a hub uses the hub as its list host; a
  phone or browser that joined a hub as a guest uses the hub. A host in no hub
  uses itself, and a phone paired with it uses that host.
- **Choosing.** Settings › To-dos › Keep the list on names the list host: this
  host, the hub, or a computer this host is paired with. In the first version
  the choice can change only while this host's own list is empty; moving a
  list from one host to another is later work.
- **Journal.** The list host journals aggregate type `todo` with
  `todo.created@1`, `todo.edited@1` (title or notes), `todo.state-changed@1`,
  `todo.projects-set@1`, `todo.tags-set@1`, `todo.order-changed@1`,
  `todo.thread-linked@1` and `todo.deleted@1`. Each event carries its
  principal (a local window or the paired device). The list is held in
  memory and rebuilt from those events at every start, as person memory is;
  no table holds it. The client names a new to-do's id, so a draft sent twice
  is added once, and a draft for a deleted to-do does not bring it back.
- **Who may change it.** A window on the list host, and a device the list
  host's own person paired, which acts as the person. Both read
  `GET /api/todos` and send changes to `POST /api/todos/commands`; the
  private listener forwards both, and every other caller is refused, a read
  included. A window on another
  computer reaches the list as such a paired device, through the paired
  computer channel, or as an owner device after a fresh unlock
  ([Owner devices](hub-and-spokes.md#owner-devices); not built yet). Agents, routines,
  delegated runs and peer hosts are refused: a peer grant has no to-do item.

## Sync, conflicts and offline

- **One copy.** Only the list host keeps the list. Other hosts keep no copy;
  their windows read it the way they read any other host, through the host
  federation registry, and changes stream to every connected client.
- **Conflicts.** There is one journal, so nothing is merged. An edit to the
  title or notes carries the version it was made on; when the title or notes
  changed after that version it is refused as `changed-elsewhere` (a tick or a
  tag does not make an edit stale), and the client shows the current
  text while keeping the person's own text to apply again. State, Projects,
  tags and order apply in the order they arrive.
- **Unreachable list host.** The page shows the last list it read, marked
  stale and read-only, as for any unreachable host. Quick add still accepts
  text but keeps it as an unsent draft on that device with a Send button; it
  is never sent on its own, because a mutation names one destination and
  is never queued as offline work.
- **Hub down.** A standby hub holds no copy of the list. While the hub is
  unreachable the list is read-only and drafts wait for the person to send
  them.

Rationale: a list a person keeps is small, and a second writer would need a
merge rule for every field. One list host keeps the existing rule that each
host owns its facts, needs no new trust between hosts, and reaches phones and
browsers through the hub that already serves them. A copy on every computer
through the person's own replica store
([Artifact replica sync](artifact-replica-sync.md)) was considered: it would
let two offline computers both add to-dos, at the cost of a new entry kind,
per-field merge rules and a store the person must set up. It stays a later
option.

## Tags and Projects

- A to-do may name Projects on any host. The Project picker lists the
  Projects every connected host reports; an unreachable host's Projects show
  under its name, read-only.
- Filters combine: state (Open, Started, Done; Dropped behind a "Show
  dropped" choice), Project (any of the chosen, or No Project), and tag (any of
  the chosen). The filter is a per-device view choice, not journaled.
- A Project that is deleted or archived keeps its link, shown as "Project
  removed"; Start offers only Projects that still exist.

## Starting a thread from a to-do

1. **Start.** Each open to-do row has Start. With more than one Project the
   person picks one; with none, Start offers Chat or a Project.
2. **The draft.** Start opens the ordinary new-thread draft for that Project
   on that Project's host, with the to-do's title (and notes, under it) in the
   prompt and the to-do named as the draft's source, the way an issue is
   attached as Create from context. The mode follows the Project (a Code
   Project starts a Code thread, a Work Project a Work thread, no Project a
   Chat thread); provider, model, access level, checkout and worktree are the
   draft's usual choices. Nothing starts until the person sends.
3. **Authority.** The thread is created by that host's existing create
   command, so its checks run there before any side effect: Project access,
   mode, provider and guardrail level. The list host takes no part in
   creating the thread and gains nothing on the Project's host.
4. **The link.** When the thread exists, the client sends
   `todo.thread-linked@1` to the list host. If the list host refuses or cannot
   be reached, the row says "Thread started, not linked" with a Link button;
   the thread itself is unaffected.
5. **State.** The row shows the newest linked thread's state (Running,
   Waiting on you, PR #n, Done) by joining the link to that host's read model
   in the client. No host projects another host's threads.
6. **Done.** Only the person ticks a to-do off. When its newest thread is
   Done the row offers Tick off. An agent never changes a to-do, as it never
   marks a thread Done.

A to-do may be started again; each start adds a link.

## The To-dos destination

- **Rail and sidebar.** To-dos is a sidebar destination like Board or Inbox,
  shown or hidden by Settings › Sidebar › Sidebar destinations. Its mark is a
  circle with a check; the count badge is the number of open to-dos that are
  not started.
- **Page.** Laid out like the [Inbox page](workspace.md#inbox-page): a
  display title "To-dos", one sentence of state in the meta ink ("4 open, 1
  started"), and one column at a 980px measure.
- **Quick add.** A single line at the top of the list. Enter adds the to-do on
  top. `#word` adds a tag and `@name` picks a Project by name; both show as
  chips before the to-do is added and can be removed.
- **Filters.** Quiet chips for state, then a Project picker and a tag picker,
  on one row under quick add.
- **Rows.** A round check, the title, Project chips, tags, and the linked
  thread's state badge; Start and a more menu (Edit, Drop, Delete) appear on
  hover and keyboard focus. Selecting a row opens it in place for notes,
  Projects and tags. Rows drag to reorder.
- **Everywhere else.** The command palette offers New to-do, with a keyboard
  shortcut, and opens quick add over the current page. The phone app shows the
  list with quick add, Tick off and Start.
- **Empty.** One sentence: what goes here and that a to-do can be handed to
  an agent.

## Constraints

- The list host's server decides every change; clients render what it
  returns.
- A to-do never carries authority: neither a Project link nor a thread link
  lets anyone act on the linked host.
- No to-do text leaves the person's own devices; there is no Octant service
  and no telemetry.
- Agents have no to-do tool in this design. Letting an agent read the list, or
  offer a to-do the person accepts, is a separate decision.

## Delivery plan

1. This specification and its entry in
   [Decisions and requirements](decisions.md).
2. Contracts, domain transitions and the list host's server: events,
   projection, routes, version-checked edits, and refusals for agents,
   routines and peer hosts.
3. The To-dos destination in the web app: list, filters, quick add, command
   palette.
4. Start: the draft with its source, the link, and the thread state badge.
5. Other devices and computers: the list host setting, reading and writing
   through federation and the paired computer channel, stale and read-only
   display, unsent drafts, and the phone screen.

Later, each its own decision: an Inbox card, a Project page section, an
agent's offer of a to-do, moving a list to another host, replica-store sync,
and due dates.

## Verification

- **Server:** each event replays into the same projection; an edit on an old
  version is refused as `changed-elsewhere`; an agent, a routine and a peer
  host are refused on every to-do route; a paired device's change is journaled
  with its principal.
- **Start:** a to-do started into a Project the person cannot reach is refused
  by that Project's host, and no link is written.
- **Web:** quick add with `#` and `@`, each filter, reorder, Start, and the
  stale read-only list, at desktop and phone width.
- **Multi-host:** a phone guest and a spoke window add, edit and tick the
  same to-do on the hub, and both see the change.
