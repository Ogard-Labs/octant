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
