---
description: Work mode binds one OS-confined folder for local knowledge work with documents, artifacts, research, and citations.
---

# Work

Work is local knowledge work for documents, presentations, spreadsheets, reports, PDFs, images, and artifacts. Each Work Project binds exactly one OS-confined project root selected through the native directory picker.

## Work Projects

Create a Work Project from the sidebar:

1. Select **Work** as the mode.
2. Use the native picker to choose a directory.
3. Name the Project.

The selected directory becomes the confined root. Work threads cannot access paths outside this root. The renderer receives an opaque receipt rather than the raw path.

## Authority and confinement

Work threads operate within the bound Project root. Filesystem operations, artifact mutations, and tool access are confined to that directory. The server enforces confinement; renderer focus cannot extend authority.

Capability-aware workspace surfaces available in Work include:

- Confined Files/Explorer
- Artifact Review and preview surfaces
- Browser surfaces (host-owned, policy-gated)
- Side Chat, a Chat-mode lane that can ask about the focused thread without interrupting it or inheriting this Project's filesystem
- Research with citations and provenance
- Scoped memory and child agents

The active Work thread's composer shows a circular context-usage meter. Opening
it shows the authoritative used-versus-available breakdown for that thread.
Project memory lives on the Work Project Overview. Navigator opens from the
bottom-left profile and Settings control without changing the active Project
or thread. The right sidebar is a compact launcher when empty and a tool strip
when open. It can host Side Chat, Browser, Files, Canvas, or Plan when this
thread has a current plan artifact, instead of replacing the Work thread. The
sidebar follows the pane that last received pointer or keyboard input and
restores that thread's open tools and selected tool when you return to it.

The sidebar **Thread board** is a server-derived view of Work threads as Ready, In Progress, Waiting, and Done. Status comes from turn, request, artifact, citation, child-run, recovery, and delivery evidence; a thread is Done only when its confirmed delivery target is objectively satisfied. Cards are not dragged between columns. Opening a card activates that Work Project and thread. Chat has no board.

Work does not expose Code Git/terminal authority. When Work work becomes software engineering, use a [promotion](/guide/promotions) to start a linked Code thread with explicit user approval.

## Unsent drafts

Each Work thread keeps one unsent composer draft on this client. Leaving the
thread or restarting the app restores the text and caret. Sending or clearing
the composer removes it. Mentions that are part of the typed text persist;
staged attachments do not. Deleting or purging the thread removes its draft.

## Export

**Export thread** downloads a portable JSON cut of this Work thread: the
transcript, Canvas artifacts it originated, completion evidence when you have
confirmed delivery, and provenance. The file says when it was cut. Secrets
and filesystem paths never appear.

## Research workflow

Work supports a research workflow with citations and provenance. Research threads can produce briefs, sources, evidence, claims, and reports. Citations link back to verified sources within the confined root or approved external references.

## Artifacts and previews

Work threads can create, edit, and preview artifacts within the bound root. Preview surfaces are authenticated and cancelable. Split-view previews render through the shared renderer with server-authoritative policy.

## Attaching images

Paste or attach a PNG, JPEG, WebP, or GIF in the Work composer to send it with a provider turn. The image uploads to the host, and the turn names only the identifier the host answered with, so the provider receives bytes the host itself accepted.

A turn carries at most eight images, each up to 10 MB, alongside a written message. If the selected model does not read images, the composer says so at the paste instead of taking the file. The host checks the thread's own model again at send, so a turn never reaches a model with its pictures quietly dropped. Removing a chip before sending keeps that image off the turn.

Type `#` in the composer to mention another thread as read-only context, the same bounded excerpt Chat uses. Type `@` to complete a path inside this Project's bound folder; the host refuses a path outside that root before reading it. Chat has no `@file` mention, because Chat Projects have no filesystem authority.

## Thread board

Work has a server-authoritative [Thread board](/advanced/work-board) that
derives Ready, In progress, Waiting, and Done from turn, request, artifact,
citation, child-run, recovery, and delivery evidence. Done requires your
confirmed delivery target and objective evidence. Opening a card activates
that Project and thread. Chat has no board.

## Next steps

- [Work Thread Board](/advanced/work-board) for derived status, grouping, and delivery confirmation
- [Promotions](/guide/promotions) for escalating Work work to a Code thread
- [Projects](/guide/projects) for managing Work Projects
- [Code](/guide/code) for repository engineering
