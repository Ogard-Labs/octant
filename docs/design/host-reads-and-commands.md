# Host reads and commands

This file names the host routes, server commands, wire values, and integration
operations that workspace surfaces use, so the behavior specifications can state
their rules in product words. [Workspace](workspace.md) and
[Start screen](start-screen.md) own the behavior; the
[architecture](../architecture.md) owns authority, persistence, and the
contracts. When a route or command changes, update its row here and keep the
behavior rule where it lives.

## Sidebar navigation reads

Each mode keeps its sidebar current with a projection-only navigation read:
`GET /api/chat/navigation`, `GET /api/work/navigation`, and
`GET /api/code/navigation`. The behavior rule is in
[Workspace: navigation and Projects](workspace.md#navigation-and-projects).

## Pending requests

Every Needs you surface (the start-screen card, Board cards, the command
palette, the Inbox, and the Review page) reads one host list, the
`pendingRequests` read. The Board files a thread whose live turn waits on an
approval or question under Waiting with the `awaiting-input` reason, and a
thread whose latest finished turn closed with a decision under Waiting with the
`decision-pending` reason; `awaiting-input` keeps meaning a live request on an
open turn.

### Answering a waiting request

An answer goes through the mode's own command with the handle the host listed:

| Request                   | Command                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| Work approval or question | `resolve-work-request`                                                                       |
| Code approval             | `answer-provider-approval`                                                                   |
| Code question             | `answer-provider-input`, with the response kept as evidence first under a fresh operation id |
| Chat question             | `answer-chat-turn-question`                                                                  |
| Decision option (Code)    | `start-provider-turn`, with the words kept as prompt evidence                                |
| Decision option (Work)    | `start-work-thread-turn`, with the thread's current authority                                |

A waiting subagent's request has no row here: it is listed with no answer
handle, and its **Review request** action opens the parent thread's Agents tab,
where the child's own approval or question controls answer through the
harness session route.

The command palette's **Approve** and **Deny** commands use
`resolve-work-request` and `answer-provider-approval` without opening the
thread.

A Code answer counts as refused when the host says `operation-failed` or reports
the turn `failed`, or `interrupted` with a reason. A bare `interrupted` is the
third denial in one turn: the provider received that Deny and the host then
stopped the turn, so it counts as answered. The start-screen card, the command
palette, and the open Code thread all read Code answers this way.

## Stopping from the Running tab

A start screen has no thread open and the navigation rows carry no turn or
attempt identity, so the Running tab's Stop sends the command the mode's own
in-thread Stop uses. Chat and Work first read the thread's running turn and send
nothing when there is none. Code has no turn to name: its host cancels only the
turn it is running for that thread and answers a cancel it had no turn for with
a failed turn state and no reason, which counts as nothing running.

## Thread windows

A thread opens on its newest turns and loads earlier ones on request. Each
window read answers one contiguous run of whole turns, oldest first, with
`hasEarlier` and `hasLater`, as a new `version: 1` response with
`cache-control: no-store`. A request names at most one anchor turn; a client
walks back by asking for the page `before` its oldest loaded turn, so there is
no cursor field. An anchor the thread does not hold answers 409 with the
failure category `stale`, and the client drops its earlier pages and reads the
newest window again. Each read is a GET, runs the same authority check as the
whole-thread read beside it before reading anything, and is a
`project.overview.read` for a paired device.

| Mode | Route                                                 | Anchor                                                 | Page                                                                                                                                        |
| ---- | ----------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Work | `GET /api/work/turns/window/:threadId`                | `before=<requestId>` (or none)                         | `limit` 1 to 64 (the client asks 30), at most 2 MiB of encoded turns (a paired device's response is cut at 8 MiB), always at least one turn |
| Chat | `GET /api/chat/threads/:threadId/window`              | one of `before`, `after`, `through=<turnId>` (or none) | `limit` 1 to 50 (the client asks 30), at most 2 MiB of encoded turns with their bodies, always at least one turn                            |
| Code | `GET /api/code/threads/:threadId/conversation/window` | one of `before`, `through=<operationId>` (or none)     | `limit` 1 to 100 (the client asks 20), at most 2 MiB of encoded turns, always at least one turn                                             |

A Chat window answers `ChatThreadWindow`: the unchanged `ChatThreadView` shape
holding only the page, plus the bounds and `supersededTurnCount`. It pages over
the active conversation, so an anchor an edit has superseded is `stale` like
one the thread never held, and the revised-message count comes from the host
rather than from the loaded turns. The view's bodies, attachments, sources, and
route receipts are the page's own; the newest page also carries what belongs to
no turn yet, an attachment waiting for the next message and a route receipt
whose turn was never accepted, so a receipt for a turn on an unloaded page is
never mistaken for an orphan. `through` is the page that ends with the named
turn. Transcript search indexes only the active conversation: an edit drops the
revised turn and every turn after it from the index, so a hit always names a
turn this window can show, and an edited message is found by its current text.
A jump to a turn that is not loaded (a transcript search hit) reads that
page and shows it as one detached range in place of the newest turns, which
keep receiving live updates; **Load later messages** reads `after` its newest
turn and joins it to the newest turns once the two share a turn, and **Jump to
latest** leaves it. Sending a message leaves it first. A jump is spent once its
target is on screen, so a list that starts over later (after Jump to latest, or
on coming back to the thread) never jumps back to it; a run that joins the
newest turns keeps the reader's rows. The detached range is let go when a newest
read counts a different number of superseded turns than the range was last
known whole at. The client holds at most the newest run and one detached range,
never two runs with a gap shown as one.
Readers that need the whole thread read the unchanged whole-thread route: the
Markdown copy and save, and the thread's attachment, source, and turn counts
in the Environment panel while it is open.

A Code window answers `CodeConversationWindow`: the thread's own turns in the
forward page's turn shape, the bounds, and `earlierUsage`, the fold of every
turn of the thread older than the page's first, in the shape the client totals
usage in; the host and the client fold with the same domain function, so the
seed plus the loaded turns is the thread's whole total at every page. A turn
counts by the operation that started it, not by where its last usage report
landed in the journal. The newest window also carries `limits`, the newest
report per usage window among the thread's newest limit reports for the
provider the thread is on now, and `restoreUndo`, the way back from the newest
restore that ran (a rejected restore is passed over); earlier windows carry
neither. The read never scans the thread from its start: it reads the newest
turn starts below the anchor from the thread-kind index, each page turn's own
frames through its operation, and each older turn's last usage report; that
last read walks every usage report the thread holds through the thread-kind
index and decodes one per older turn. A turn is folded exactly as the forward
page folds it. `through` is the page that
ends with the named turn. A fork opens on its own newest turns; once those run
out, **Load earlier messages** reads its source `through` the fork point, then
`before` that page's first turn, and on up the lineage to at most 32 threads.
Inherited rows keep their source thread, and only the fork's own turns count
toward its usage. A new fork with fewer turns of its own than one page reads
its first inherited page when it opens. The forward conversation read
(`CodeConversationPage` version 3) is unchanged, and export, fork points,
hand-off, mentions, merge back, the phone, and the CLI still read it.

A host without a window route answers 404, and the client reads the thread's
whole-transcript route instead and shows it as fully loaded. A fresh newest
window joins what the client holds when its first turn is already loaded;
otherwise it replaces it, so the client never holds two runs with a gap
between them. Row keys name the turn and never its position, which keeps the
reader's row in place when an earlier page arrives above it. Find in page
searches the loaded turns only, with **Load earlier messages** in view.

## Hand off

Hand off is `POST /api/threads/hand-off`. The behavior rule is in
[Workspace: tool lifecycles](workspace.md#tool-lifecycles).

## Browser captures

A thread's kept Browser screenshots use three local-window routes:
`POST /api/browser/captures` (the retained list, newest first),
`POST /api/browser/captures/image` (one picture as an image data URL), and
`POST /api/browser/captures/take` (the Screenshot control). The behavior rule is
in [Browser captures](browser-captures.md).

## GitHub issues

The issue browser's catalogue reads stay on the existing `githubCatalogue`
union over `/api/github/catalogue/reads`: `kind: "issues"` includes optional
server-composed search, and `kind: "issue"` returns a bounded detail.

Create from an issue frames redacted issue text through
`apps/server/src/context/externalContentFraming.ts` and appends
`thread.external-content-ingested@1`.

## Linear issues

Browse goes through the Integration port operations `list-issues`, `get-issue`,
and `list-issue-filters` over Linear GraphQL. Create from a Linear issue frames
redacted issue text through the same `externalContentFraming.ts` and appends
`thread.external-content-ingested@1`.

The behavior rules for both integrations are in
[Workspace: boards and integrations](workspace.md#boards-and-integrations).
