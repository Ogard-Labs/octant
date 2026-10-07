---
description: Start here for the Octant guide. Learn to install, configure, and work across Chat, Work, and Code.
---

# Guide

Welcome to the Octant guide. Use these pages to install the app, configure providers, and work across the three modes.

## Getting started

- [Installation](/guide/installation) — system requirements, source build, packaging, and what an update check sends
- [First Run](/guide/first-run) — configure a provider, create a Project, start a thread

## Working with modes

- [Chat](/guide/chat) — conversations in virtual Projects with scoped memory
- [Work](/guide/work) — local knowledge work with a bound folder
- [Code](/guide/code) — repository engineering with Git authority

## Projects and context

- [Projects](/guide/projects) — create, manage, and organize Projects across modes
- [Shared Memory](/guide/memory) — persist decisions, facts, and context across threads
- [Promotions](/guide/promotions) — escalate Work work to a linked Code thread
- [Sync artifacts across your computers](/guide/sync-artifacts) — what leaves this computer, where it goes, and how to turn sync off
- [Export a Canvas or artifact](/guide/export) — write a readable Markdown or HTML copy into a folder you choose, or publish it as a GitHub Gist

## Concepts

- [Modes](/concepts/) — the Chat, Work, and Code mode boundaries

## Workspace shell

The window is mode-first: Chat, Work, and Code in the sidebar, a central
workspace, and an optional right dock. A workspace pane holds one surface —
the thread you are reading, a Project overview, a board, or a welcome — and
the sidebar selects tasks. Files, previews, canvases, and image creation open in
closable tabs beside the conversation. Switching back keeps an image draft in
place; closing the image tab does not cancel a running generation job. Use its
Cancel action to stop the job. Open tabs last for the current app session.
Same-authority threads can be pinned or dropped
into split panes; the active pane is marked, and the right dock follows that
pane's thread and Project. Work and Code have server-derived thread boards;
Chat has no board.

### Home cards

Under the composer on a new Work or Code task, a few cards show what is
happening now. **Working now** lists what is running across your Projects:
each row has the provider mark, the thread's title, a line saying what it is
doing, and a time. A command or tool shows as it runs, such as `Command: bun run
test`, or the row says it is waiting for your approval or an answer. The time is
how long the turn has been running. Paths and anything that looks like a secret
are removed from the line before it leaves the host. When the window
is showing another computer's work, the row names that computer. Up to five rows
show, then **+N more** opens Running. Choose a row to open its thread. When
nothing is running, the card says so in one line.

**Running services** lists the dev servers running in your Code Projects: the
port, the Project and the branch or thread, what is running (`vite`, `node`,
`bun`), and whether it is answering. A server Octant does not own is marked
**Not owned by Octant**: it may be one left from an earlier session, or one you
started yourself in a terminal or with another tool, and Octant cannot tell
which. **Open** shows the page in a Browser tab for that thread, or in your own
browser; **Stop** stops it. A server Octant owns can stop at once; one it does
not own asks you to confirm first, and from a paired device it can only be
stopped at the computer itself.
A server an editor such as VS Code started is not listed, and neither is
anything outside your Code Projects. Up to five show, then **+N more
listening**. The card refreshes about every five seconds while the window is
showing, and not at all when it is hidden or turned off. When the window shows
another computer's work, the row names that computer.

Above the composer, two tabs sit on its top-left edge: **New task**, which is the
composer, and **Running**, with the number of threads running now (the same
number the sidebar's Running tile shows). Running lists every running row, not
just five, each with **Open** and **Stop**. Stop asks "Stop this turn?" first,
or "Stop this agent run?" on an agent run's row; choose **Stop** to end it or
**Keep running** to leave it. Switching tabs never
loses what you were typing: the draft, Project, and model are kept while you
look. The tabs work from the keyboard: arrow keys move between them, and Enter
chooses.

**Needs you** comes first and appears only while an agent is waiting on you. It
lists every approval and question across your Projects, oldest first: the
provider mark, the thread's title, how long it has waited, and what it asked.
Choose **Approve** or **Deny** on an approval. A question with choices has one
numbered button per choice (press the number while the row has focus), and
**Reply…** opens the thread so you can type your own answer. Answering works the
same as in the thread itself, with the same permissions. If the request changed
before your answer arrived (it was answered elsewhere, or the turn ended), the
row says so once and refreshes. Up to five rows show, then **+N more** opens the
Inbox. On Work this covers Chat and Work threads; on Code, Code threads. The
card is only available in a window on this computer.

**Pull requests**, on a new Code task, lists what is waiting on you across your
Code Projects. **Waiting on your review** is a review asked of you; **Yours**
is one you opened. A row shows the title, a short repository and number, and
the words for checks and review — passed, failed, running, or none, and
approved, changes requested, in review, or draft. Up to six rows show, then
**+N more** opens Pull requests. Choose a row to open that pull request. The
card is not shown at all without a connection, or when credential storage is
insecure. It reads the list the Pull requests page already keeps, so it does
not ask again on its own.

**CI failures**, on a new Code task, lists checks that failed on pull requests
you opened and on the branch a Code Project is on now. A row shows the check,
the repository or the branch, and how long ago it failed. A pull request from
a fork is listed only when you opened it, and offers no **Start a fix**, since
its branch is not in your Project. Up to five rows show. When nothing is failing, the card is not shown. **Start a fix** opens a
new Code task that starts a new worktree from the failing branch, with the
pull request and check already written in; you send it. The card is not shown without a connection, or when credential
storage is insecure. It reads the same list Pull requests keeps, so it does
not ask again on its own.

**Computers**, on a new Work or Code task, lists the computers this window is
connected to: this computer, and any paired computer, devbox, or server. Each
row says whether it is connected, reconnecting, or offline. When this window
may see that computer's load, the row shows how many cores and how much memory
it has, and small bars for processor, memory, and disk with a percentage. A
computer that is connected but which this window is not allowed to read shows
as connected with no bars. A computer that is offline shows when it was last
seen, and no bars. If the load cannot be read for a moment, the bars go away
until it can. For the computer this window was opened from, the number of agents
running there opens Running filtered to that computer; other computers do not
report it, so they show no number. Up to four computers show, then **+N more**. The card asks for
the load only while you are looking at it and the window is in front, about
every ten seconds, and stops when the window is hidden.

**Customize**, on the right under the composer, turns each card on or off and
reorders them: drag a card by its handle, or use the up and down buttons from the
keyboard. **Reset to default** puts them back. Your choices are kept on this
device. A card whose connection is missing is not shown at all, and the cards
appear just after the composer, so the screen is ready to type in first.

### Suggested follow-ups

Any model, on any provider and in every mode, may end a reply by suggesting
up to three next tasks. They appear as chips at the top of the thread's
composer; a later reply that suggests nothing clears them, and the × hides
them for now. Choosing one shows what it would do — put the prompt in this
composer, start a new thread in the same mode and Project, or, in Code,
start a thread on its own worktree — and nothing happens until you choose
**Start** (or **Use prompt**). The new thread opens on the same model with
the prompt waiting in its composer; sending it is still your move. A Code
follow-up starts approval-gated, because Full access is remembered per
thread.

### Side tasks

While it works, a model may notice something that belongs in its own thread —
a real bug, stale docs, missing tests — and offer it as a side task instead of
widening the current change. The offer appears as a card over the composer
with a title, one line on why, and the exact prompt behind a disclosure.
**Start in new worktree** (Code) or **Start in new thread** creates the thread
on the same model and sends the prompt, so the work begins right away; a Code
side task still asks before it edits or runs anything unless you gave it Full
access. × dismisses the offer. Side tasks need a provider that runs Octant's
app-managed tools; the others can still suggest follow-ups.

An approved later interaction model is recorded in the architecture decision
records and is **not** what the app renders today for remaining dock
placement: live thread-owned tools still replace the generic Thread panel.
Context usage already lives on the composer meter. Project memory already
lives in Project Overview. Navigator already opens as a host-wide popover
from the profile control. Until the remaining dock migration lands, the
pages in this guide describe the surfaces that are actually on screen.

## Current boundary

This documentation covers the Apple Silicon technical preview. Declared
releases are signed, notarized, and update themselves; a local package is
unsigned because signing needs maintainer credentials. It reflects
accurate current product behavior and does not claim that every workflow is
finalized. Capabilities that remain in progress are noted where relevant.
