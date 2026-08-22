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

## Scoped memory

Chat Projects support shared scoped memory that persists across threads within the same Project. Memory entries include decisions, facts, preferences, summaries, and outcomes. See [Shared Memory](/guide/memory) for details on managing and transferring memory entries.

## Unfiled threads

A Chat thread not assigned to a Project uses an explicit unfiled Chat context. It does not inherit a filesystem, repository, or another Project's authority.

## Cross-Project boundaries

When you drag or drop a Chat thread into another workspace, the server resolves the action against the context key (host, mode, Project, bound root). A cross-Project drop does not silently change authority; it offers to open the thread in a new window instead.

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

Side Chat is a separate Chat conversation about one source thread. Open the right sidebar, use **Add utility tab**, and choose **Side Chat** while that thread is focused. It never replaces the source thread. Switching between visible threads restores each thread's own sidebar tabs and Side Chat conversation. Side Chat can answer questions using the same bounded excerpt; it cannot approve, steer, change criteria, or write to the source thread. If the source thread is deleted or no longer openable, Side Chat refuses rather than inventing an empty conversation.

## Turn actions

Edit, branch, checkpoint, and copy live in each turn's **More actions** menu
(the ⋯ control that appears when the turn is hovered or focused). The same
items are on the turn's context menu, so right-click is never the only route.
Retrying a failed or interrupted response stays on the turn itself.

A checkpoint marker stays on the turn only when that point is marked. Restoring
it starts a second thread; it does not rewind this one.

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
