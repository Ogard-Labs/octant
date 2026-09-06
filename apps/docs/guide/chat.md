---
description: Chat mode provides conversation threads in virtual Projects with scoped memory and no implicit filesystem authority.
---

# Chat

Chat is the conversation surface. Chat Projects are virtual containers with shared scoped memory and no implicit filesystem or shell access. Chat is always available; disabling it in Settings never deletes existing Chat data.

## Chat Projects

A Chat Project is a virtual, memory-scoped container. Unlike Work and Code Projects, it binds no OS directory or repository root. Threads within a Chat Project share the Project's scoped memory but cannot access the filesystem, shell, or Git tools.

Create a Chat Project from the sidebar by selecting Chat as the mode. No native picker is required.

## Thread authority

Chat threads receive no filesystem, shell, or repository authority. The composer and thread controls reflect only Chat-valid surfaces:

- Conversation and streaming responses
- Attachments and sources
- Scoped memory entries
- Child agents within the same Chat context

Chat does not expose Terminal, Files, Diff, or Git surfaces. The server enforces this boundary; renderer focus cannot grant authority.

The active Chat thread's composer shows a circular context-usage meter. Opening it shows the authoritative used-versus-available breakdown for that thread.

## Scoped memory

Chat Projects support shared scoped memory that persists across threads within the same Project. Memory entries include decisions, facts, preferences, summaries, and outcomes. The Chat Project Overview is where you add, replace, retract, or transfer them. See [Shared Memory](/guide/memory) for details.

## Unfiled threads

A Chat thread not assigned to a Project uses an explicit unfiled Chat context. It does not inherit a filesystem, repository, or another Project's authority.

## Cross-Project boundaries

When you drag or drop a Chat thread into another workspace, the server resolves the action against the context key (host, mode, Project, bound root). A cross-Project drop does not silently change authority; it offers to open the thread in a new window instead.

## Sending while a response is running

The composer stays open while a response is streaming. Press Enter and the
message is sent: it leaves the composer, joins the transcript at the end, and
runs as soon as the response in progress stops — nothing to release, discard,
or re-send by hand. A response that is cancelled or fails has also stopped, so
the message runs then too.

Only one message waits at a time. Anything typed after it stays in the
composer as an ordinary draft. If the host refuses the message, its words come
back to the composer — unless you have already typed something newer, which is
kept instead. The waiting message lives on this client only; a restart drops it
rather than sending it behind your back.

## Unsent drafts

Each Chat thread keeps one unsent composer draft on this client. Leaving the
thread, switching tabs, closing the window, or restarting the app restores the
text and caret. Sending or clearing the composer removes it. Mentions that
are part of the typed text come back with the draft; staged attachments and
extra selections do not, and the composer says so if they were dropped.
Deleting or purging the thread removes its draft.

## Mentioning another thread

Type `#` in the composer to pick a thread you can already open. Octant inserts a `#[Title]` chip. The mentioned thread is not interrupted: this turn receives a bounded, read-only excerpt of its title, filing, and recent messages. `@plugin` and `$skill` addressing is unchanged; an unmatched `#` or `@` stays ordinary text. Chat has no `@file` mention, because Chat Projects have no filesystem authority.

A chip you can no longer open is marked unavailable and contributes no content. Cross-mode mentions are read-only context, not mixed execution — mentioning a Work or Code thread from Chat does not grant that thread's filesystem or shell.

## Side Chat

Side Chat is a separate Chat conversation about one source thread. Open the right sidebar and choose **Side Chat** while that thread is focused. It never replaces the source thread. Switching between visible threads restores each thread's own tools and Side Chat conversation. Side Chat can answer questions using the same bounded excerpt; it cannot approve, steer, change criteria, or write to the source thread. If the source thread is deleted or no longer openable, Side Chat refuses rather than inventing an empty conversation.

## Turn actions

Edit, branch, checkpoint, and copy live in each turn's **More actions** menu
(the ⋯ control that appears when the turn is hovered or focused). The same
items are on the turn's context menu, so right-click is never the only route.
Retrying a failed or interrupted response stays on the turn itself.

A checkpoint marker stays on the turn only when that point is marked. Restoring
it starts a second thread; it does not rewind this one. The restored thread's
sidebar row carries a fork mark — as does the thread it came from — so you can
see the origin chain and any direct forks and switch to one of them. If the
origin has been archived or deleted, the lineage says the origin is no longer
available rather than hiding that the thread is a fork.

## Complete and snooze threads

A thread you are done with can be put away without archiving it. Choose
**Complete** from the row's menu (right-click, or the ⋯ control on hover) and
the thread moves to the collapsed **Completed** shelf at the foot of the
sidebar. Everything about it stays. **Reopen** brings it back, and so does
sending it a new message. Octant refuses to complete a thread while an answer
is still running.

**Snooze** hides a thread until a time you pick, in its own collapsed shelf
with the time until it returns. It comes back early if the answer that was running when you snoozed it finishes. When a snooze
ends the row reappears marked **Woke** until you open it; **Wake** ends a
snooze by hand.

Completed threads move to the archive on their own after a week. Change that
window, or turn it off, under **Settings › General › Archive completed
threads**. Archiving keeps every thread; only a confirmed purge deletes.

## Export

These actions live in the thread header's **Thread actions** menu (the ⋯
button), alongside the canvas toggle.

**Export…** downloads a portable JSON cut of what the host holds for
this conversation: the active transcript, Canvas artifacts it originated,
attachment names, citations, and provenance. The file says when it was cut.
Attachment file bytes stay off the export and are listed as omissions.
Secrets, credentials, and provider payloads never appear.

**Copy conversation** and **Save as Markdown** remain a convenience for
reading the prose. They are assembled from what this window last saw and are
not the authoritative cut.

A paired device can export a thread it can already open. It cannot dump the
host.

## Next steps

- [Work](/guide/work) for local knowledge work with a bound folder
- [Code](/guide/code) for repository engineering with Git authority
- [Projects](/guide/projects) for managing Projects across modes
