---
description: Chat mode provides conversation threads in virtual Projects with scoped memory and no implicit filesystem authority.
---

# Chat

Chat is the conversation surface. In the app, Chat lives inside **Work**: pick
**Chat** in the switch above Work's composer to start a conversation that never
touches your files. Chat Projects are virtual containers with shared scoped memory and no implicit filesystem or shell access. Chat can be disabled in **Settings → General → Available modes**; a disabled Chat refuses new threads and turns but never deletes existing Chat data. Code is the mode that is always available.

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

An unfiled thread can still ask its agent for a document, deck, or dashboard: the Canvas it makes belongs to the thread itself rather than to a Project. It opens from the thread, stays with the thread if you later file it in a Project, is erased when you purge the thread, exports to the host's export folder, and is not mirrored, synced, shared, or listed in the Project-grouped library. See [Agent-authored documents and canvases](/advanced/files#agent-authored-documents-and-canvases).

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

See [Continuing after a restart](/guide/work#continuing-after-a-restart) if Octant
stopped while the agent was working.

## Unsent drafts

New-task text stays with its mode and pane while you visit Settings or switch
modes in the same window session. Choosing another Project preserves that text;
an explicit New task starts over. This temporary text does not survive an app
restart.

Each Chat thread keeps one unsent composer draft on this client. Leaving the
thread, switching tabs, closing the window, or restarting the app restores the
text and caret. Sending or clearing the composer removes it. Mentions that
are part of the typed text come back with the draft; staged attachments and
extra selections do not, and the composer says so if they were dropped.
Deleting or purging the thread removes its draft.

## Mentioning another thread

Type `#` in the composer to pick a thread you can already open. Octant inserts a `#[Title]` chip. You can also drag a thread from the sidebar onto the composer, or focus that row, open its menu, and choose **Attach as context**. Either way the mentioned thread is not interrupted and the draft is not sent: this turn receives a bounded, read-only excerpt of its title, filing, and recent messages. `@plugin` and `$skill` addressing is unchanged; an unmatched `#` or `@` stays ordinary text. Chat has no `@file` mention, because Chat Projects have no filesystem authority.

A chip you can no longer open is marked unavailable and contributes no content. Cross-mode mentions are read-only context, not mixed execution — mentioning a Work or Code thread from Chat does not grant that thread's filesystem or shell.

## Attaching a window capture

In the macOS desktop app, the composer's paperclip opens a menu: **Choose file…** or **Capture window…**. Capture window lists your open windows by title and attaches a picture of the one you choose, as an image like any other, so the model's image support and the per-turn image limits apply. The first time, Octant explains why macOS needs Screen Recording permission and asks only when you press **Continue**; if you turned it off, Octant opens System Settings instead. Octant reads a window only after you choose it. The web app and the phone app do not offer it.

## Side Chat

Side Chat is a separate Chat conversation about one source thread. Open the right sidebar and choose **Side Chat** while that thread is focused. It never replaces the source thread. Switching between visible threads restores each thread's own tools and Side Chat conversation.

Every Side Chat turn reads the source thread fresh: its newest 40 messages, and what it has done so far. For a Code thread that includes the branch, the uncommitted files Git sees, the files its turns changed, and the delivery target. For a Work thread it includes the Project folder. For every thread it includes the latest subagent results. About a Work or Code thread, Side Chat can also list and read the thread's files (and search them, for Code) when the model supports Octant's tools. Otherwise it says it cannot see the files.

Side Chat can only read. It cannot send the source thread messages, approve, steer, change criteria, or write anything. If the source thread is deleted or no longer openable, Side Chat refuses rather than inventing an empty conversation. A Side Chat about a thread marked as having read outside content is marked too, because it reads that thread's conversation; the same holds for any thread you mention with `#`.

## Turn actions

Edit, branch, checkpoint, and copy live in each turn's **More actions** menu
(the ⋯ control that appears when the turn is hovered or focused). The same
items are on the turn's context menu, so right-click is never the only route.
A branch or a restored thread made from a thread marked as having read
outside content starts marked too, because it carries the same conversation.
A thread whose mark you cleared makes an unmarked branch.
Retrying a failed or interrupted response stays on the turn itself; a
completed response carries a **Regenerate** control next to its timestamp and
copy control — asking for a different answer to the same message. The previous
answer stays in the transcript under a **Regenerated** mark, and the thread
carries the newest answer onward: later turns read the regenerated exchange,
not the replaced one.

While a reply waits on your answer to a question, or on your approval, the
thread is not running: its sidebar mark and the pane header say **Needs you**,
and the Inbox lists it as waiting for your answer or your approval, until you
answer or the turn ends.

A provider question left parked when the app restarts can no longer be
answered — the provider session that was waiting on it is gone. Answering the
restored card settles the turn as interrupted rather than leaving it parked,
so retrying asks the question again on a live session.

A reply's reasoning folds into a **Thinking** disclosure above the text: shut
by default, opened only if you want it, and still findable while closed. While
the reply is still streaming, you can expand the reasoning to watch it arrive.
It stays in the state you choose when the turn settles. A tool call a
reply made folds into its own disclosure the same way.

A checkpoint marker stays on the turn only when that point is marked. Restoring
it starts a second thread; it does not rewind this one. The restored thread's
sidebar row carries a fork mark — as does the thread it came from — so you can
see the origin chain and any direct forks and switch to one of them. If the
origin has been archived or deleted, the lineage says the origin is no longer
available rather than hiding that the thread is a fork.

## Put away and snooze threads

A thread you are done with can be put away without archiving it. Choose
**Put away** from the row's menu (right-click, or the ⋯ control on hover) and
the thread moves to the collapsed **Put away** shelf at the foot of the
sidebar. Everything about it stays. **Reopen** brings it back, and so does
sending it a new message. Octant refuses to put a thread away while an answer
is still running.

**Snooze** hides a thread until a time you pick, in its own collapsed shelf
with the time until it returns. It comes back early if the reply needs you, or if the answer that was running when you snoozed it finishes. When a snooze
ends the row reappears marked **Woke** until you open it; **Wake** ends a
snooze by hand.

Put-away threads move to the archive on their own after a week. Change that
window, or turn it off, under **Settings › General › Archive put-away
threads**. Archiving keeps every thread; only a confirmed purge deletes.

## Long threads

A long Chat thread opens on its newest messages, so it is ready to read and
reply to straight away. **Load earlier messages** at the top adds the messages
before the oldest one shown; the message you were reading stays where it is.
Opening a search result far back shows the messages around it, with **Load
later messages** and **Jump to latest** underneath; sending a message also
takes you back to the newest messages. Find in page searches the messages
loaded so far. Export and purge always cover the whole thread.

## Send a Canvas comment to the agent

Open a Canvas from a thread, open its comments, and choose **Send to agent** on
a comment. The thread's agent gets the comment, what it is on, and the Canvas,
and is asked to change only that part. The comment shows **Sent to agent**, then
**Addressed in vN** once a new version from the agent arrives. The button is
missing when the thread cannot be reached or when you are viewing an older
version of the Canvas. The turn follows the thread's own permissions.

## Export

These actions live in the thread header's **Thread actions** menu (the ⋯
button), alongside the canvas toggle.

**Export…** downloads a portable JSON cut of what the host holds for
this conversation: the active transcript, Canvas artifacts it originated,
attachment names, citations, and provenance. The file says when it was cut.
Attachment file bytes stay off the export and are listed as omissions.
Secrets, credentials, and provider payloads never appear.

**Copy conversation** and **Save as Markdown** remain a convenience for
reading the prose. They read the whole conversation from the host first, even
when only its newest messages are loaded, and are not the authoritative cut.

A paired device can export a thread it can already open. It cannot dump the
host.

## Next steps

- [Work](/guide/work) for local knowledge work with a bound folder
- [Code](/guide/code) for repository engineering with Git authority
- [Projects](/guide/projects) for managing Projects across modes

Successful replies show their text without a Completed status label. Their duration
appears below the reply; hover over the reply to reveal its timestamp and actions. The timestamp hides
when the pointer leaves. Keyboard focus can still reveal the action buttons.
Chat and Code offer Copy and Fork below the reply; Chat also offers Regenerate.
Fork creates a new thread with history through the selected response and leaves
the original unchanged; a Code fork also gets its own worktree and branch with
the files as they were at that response. A Chat thread on a provider that keeps
the conversation in its own session (such as a CLI agent) can be forked too, but
the fork cannot share that session: its first message starts a new session and
Octant hands over the messages through the fork point as text. The reply says
how many messages were handed over and which were left out. Failures, interruptions, and requests for
input remain visible. Chat, Work, and Code share this history treatment and fold
inline reasoning into an expandable Thinking disclosure. Code also keeps its
provider-reported reasoning channel in the turn’s existing disclosure.

In Settings → Chat, turn off **Stream replies** to wait for the finished
answer in Chat, Work, and Code. Reasoning remains expandable during the turn;
approval requests and provider questions remain available immediately. Streaming
is enabled by default. This preference changes presentation, not provider execution.
