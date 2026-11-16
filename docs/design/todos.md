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

**Status: approved design 2026-11-14 (maintainer decision); built for paired devices.**
The list on one host is built: its events, the list rebuilt from them, the
`/api/todos` read and command routes, version-checked edits, and the refusals
for every caller but the person. The To-dos destination is built on that host:
the page, quick add, filters, editing in place, reordering, the sidebar row and
its badge, and New to-do in the command palette and on a shortcut. Start is
built for this host's and paired computers' Projects and Chat: the draft with its source, the link,
Link again, the thread state on a row, and Tick off. Every window on the list
host follows changes as they happen: each change publishes the host's `todos`
change topic, and a window reads the list again on it (and every 30 seconds
while visible, for a feed that is reconnecting). Settings › To-dos › Keep the
list on is built: this host, or a computer this window is paired with, saved
on this host and refused once this host keeps a to-do. A window reaches a list
on another computer through its own pairing with it, shows the last list
read-only when that computer cannot be reached, and keeps quick adds as
unsent drafts on the device. An empty spoke records its hub as the default list
host. Windows on paired computers follow bounded, cursor-based list-change
notices; reconnecting or a restarted host triggers a fresh read. Start uses the
ordinary draft composer with the Project host's own clients and creation checks.
Physical two-computer and hub runs remain maintainer live checks. The phone
screen is built: Inbox › To-dos lists the connected computer's open and done
to-dos, adds one with quick add, ticks one off or opens it again, and starts a
thread from one.
[Delivery plan](#delivery-plan) lists the order of work.

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
  unreachable. A link is a pointer; it grants nothing on that host. The
  host id is the host's stable id, the one the hub and paired devices know it
  by; the list carries its own host's id so a window links that host's
  Projects by it.
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
  the new order, in one journal transaction.

One list holds at most 5,000 to-dos, done and dropped included; adding past
that is refused as `list-full`.

To-do text is the person's own typing and is treated like a message they
type: the journal's secret redaction applies to the title, notes, tags and
Project names before they are appended, and it is
never sent to a model except as the prompt of a thread the person starts.
Person memory does not read to-dos.

## Where the list lives

Every person has one **list host**.

- **Default.** A host that belongs to a hub uses the hub as its list host; a
  phone or browser that joined a hub as a guest uses the hub. A host in no hub
  uses itself, and a phone paired with it uses that host. An
  empty spoke records its hub as the default when first read or changed; a
  host that already keeps to-dos stays on itself, and an explicit choice wins.
  A window reaches that hub through its own pairing. The default is journaled
  once as a system choice, so losing membership or the hub becoming unreachable
  never silently switches back to a new local list. Moving a populated list is
  separate work; an existing list stays visible on its current host.
- **Choosing.** Settings › To-dos › Keep the list on names the list host: this
  host, the hub, or a computer this host is paired with. In the first version
  the choice can change only while this host's own list is empty; moving a
  list from one host to another is later work. The choice is journaled on this
  host (`todo.list-host-chosen@1`, aggregate `todo-list-host`) and served at
  `/api/todos/list-host` to this host's own windows only: the private listener
  does not forward it. The host refuses a move to another host as
  `list-not-empty` while it holds any to-do, done and dropped included; coming
  back to this host is always allowed. While another host keeps the list,
  this host refuses every change to its own list as `kept-elsewhere`, so a
  stale window or a phone paired here cannot add a to-do nobody is shown. A
  window that cannot read the choice shows no list rather than this host's.
  The choice names the other host by its
  stable id and last-seen name and grants nothing there: a window reaches it
  through its own pairing (the desktop's paired-computer channel admits
  `GET /api/todos` and `POST /api/todos/commands`), where the to-do routes
  accept only a device that host's own person paired. A thread or Project of
  this host is linked by this host's id, wherever the list lives.
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
  computer channel. A hub membership or owner mark alone grants no access;
  the window still needs its own pairing (the product-route distinction in
  [Owner devices](hub-and-spokes.md#owner-devices)). Agents, routines,
  delegated runs and peer hosts are refused: a peer grant has no to-do item.

## Sync, conflicts and offline

- **One copy.** Only the list host keeps the list. Other hosts keep no copy;
  their windows read it the way they read any other host, through the host
  federation registry, and changes reach every connected client. A paired
  desktop window waits at `GET /api/todos/changes` with a process epoch and
  sequence cursor. Each wait ends at a to-do change or after 20 seconds,
  below the paired channel's request timeout; an invalidated cursor requires
  a fresh read. The endpoint applies the list's own-person check, including
  on its first read. It carries invalidations only; the list is read through
  its ordinary route.
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
  is never queued as offline work. A draft keeps the id it was made with, so
  sending it twice adds it once. A window that is not paired with the list
  host says so and shows no list.
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
   on that Project's host (in a paired-computer dialog for another host), with the to-do's title (and notes, under it) in the
   prompt and the to-do named as the draft's source: a "From to-do" label
   beside Create from, which the person can remove to leave an ordinary
   draft. Opening any other new-thread draft drops it too. The window keeps
   the source; the host's create command carries nothing about it. The mode
   follows the Project (a Code
   Project starts a Code thread, a Work Project a Work thread, no Project a
   Chat thread); provider, model, access level, checkout and worktree are the
   draft's usual choices. Nothing starts until the person sends.
3. **Authority.** The thread is created by that host's existing create
   command, so its checks run there before any side effect: Project access,
   mode, provider and guardrail level. The list host takes no part in
   creating the thread and gains nothing on the Project's host.
4. **The link.** When the thread exists, the client sends
   `todo.thread-linked@1` to the list host. The link is made where the create
   command answered with the thread, before its first turn starts, so a turn
   that fails to start still leaves a linked thread. If the list host refuses or cannot
   be reached, the row says "Thread started, not linked" with a Link button;
   the thread itself is unaffected.
5. **State.** The row shows the newest linked thread's state (Running,
   Waiting on you, PR #n, Done) by joining the link to that host's read model
   in the client. No host projects another host's threads. Done wins, then a
   running turn, then a wait on the person, then the first pull request of a
   Code thread; otherwise the row says Started. The state opens the thread; a
   thread this window does not list reads Started.
6. **Done.** Only the person ticks a to-do off. When its newest thread is
   Done the row offers Tick off. An agent never changes a to-do, as it never
   marks a thread Done.

A to-do may be started again; each start adds a link.

## The To-dos destination

- **Rail and sidebar.** To-dos is a sidebar destination like Board or Inbox,
  shown or hidden by Settings › Sidebar › Sidebar destinations, after Inbox
  in the canonical order. Its mark is a circle with a check that runs out past
  it; the count badge on the sidebar row and on the rail icon is the number of
  open to-dos that are not started.
- **Page.** Laid out like the [Inbox page](workspace.md#inbox-page): a
  display title "To-dos", one sentence of state in the meta ink ("4 open, 1
  started"), and one column at a 980px measure.
- **Quick add.** A single line at the top of the list. Enter adds the to-do on
  top. `#word` adds a tag and `@name` picks a Project by name: the Project
  whose name, without spaces and ignoring case, is the word, or the only one
  that starts with it. A word that names no Project or several stays in the
  title. Both show as chips before the to-do is added, and removing a chip
  removes its word.
- **Filters.** Quiet chips for state (All, Open, Started, Done, with counts;
  Open, the default, includes started to-dos), then a Project picker, a tag
  picker shown once the list has a tag, and Show dropped, on one row under
  quick add. The filter is held by the open page and starts at Open.
- **Rows.** A round check, the title, Project chips, tags, and the linked
  thread's state badge; Start and a more menu (Edit, Move up, Move down, Drop
  or Bring back, Delete) appear on hover and keyboard focus. Selecting a row
  opens it in place for the title, notes, tags and this host's Projects; a
  link to another host's Project is kept as it is. Rows drag to reorder, and
  Move up and Move down do the same from the keyboard. Delete asks first and
  removes the to-do from every device; Drop keeps it out of the list.
- **Everywhere else.** The command palette offers New to-do and Open To-dos.
  New to-do, also on Mod+Shift+L (Settings › Keybindings), opens quick
  add in a dialog over the current page. The phone app shows the
  list with quick add, Tick off and Start. Built on the phone: Inbox ›
  To-dos, from the computer the phone is connected to, with the open to-dos,
  then those done, a quick add line (title only), and a tap that ticks one
  off or opens it again; dropped to-dos stay off the phone. The phone reads
  the list again every 30 seconds while it is in front. A long press on an
  open to-do offers Start: it opens the Inbox's new-thread sheet with the
  title and notes as the prompt and a removable "From to-do" label, in the
  to-do's first Project on the computer new threads go to (its type is the
  mode), or Chat when none is there. When the computer answers with the
  thread, the phone links it; a link the list did not take reads "Thread
  started, not linked" on the row, and the same long press offers Link.
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
