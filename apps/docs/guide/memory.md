---
description: Project memory keeps decisions and facts inside one Project; person memory carries what Octant learns about you across every Project.
---

# Memory

Shared memory is a Project-scoped capability that lets threads within the same Project share persistent context. Memory entries survive thread completion, restart, and replay. It lives on every mode's Project Overview, where the Project that owns it is explicit. It is not a dock tab.

## Memory entry types

Projects support these memory entry types:

- **Decision**: a choice or conclusion reached during a thread.
- **Fact**: verified information relevant to the Project.
- **Preference**: user or Project-level preference that guides future threads.
- **Summary**: a condensed record of thread outcomes or research findings.
- **Outcome**: the result of a completed task or investigation.

## Active and history views

Memory has two views:

- **Active**: current, editable entries that threads can reference and update.
- **History**: immutable record of superseded or retracted entries, with provenance links to the entries that replaced them.

Entries in the active view can be superseded by newer entries, retracted when no longer valid, or transferred to another Project with a provenance-linked reference.

## Memory in Chat Projects

Chat Projects rely primarily on scoped memory, as they have no filesystem or shell authority. Memory is the mechanism for carrying context between Chat threads within the same Project.

## Memory in Work and Code Projects

Work and Code Projects use memory alongside their bound root. Memory entries can reference files, paths, and decisions within the confined root. A thread can query memory for prior decisions before acting on the filesystem.

## Transferring memory

When you archive a Project or promote work to a different mode, memory entries can be transferred with a provenance link. The source entry is retracted in the original Project and appears in the destination Project with a reference to its origin.

## Memory across Projects

Beside each Project's own memory, Octant keeps a memory of you. After you put a thread away, Octant reads what you wrote in it and notes your preferences, how you like to work, and what you worked on. Every new thread, in any Project, in Chat, Work, or Code, and on any provider, starts with these notes, so you do not have to explain yourself again. It is on from the start.

What it does and does not read:

- It reads only your own messages and the thread's title. It never reads the agent's answers, tool output, web pages, attachments, or files.
- Passwords, keys, and tokens are removed before anything is sent or kept, and a note that names a protected file is not kept.
- One short request to a small model runs once for each thread you put away, on that thread's own provider unless you pick another model. It shows in Usage as `person-memory`.
- Memory stays on this computer. It is not sent to a paired phone, another computer, or a routine.

Agents can also search past threads: asked "what did we do on the invoice export?", an agent gets a few short excerpts, each naming its thread, Project, and date. The search looks only at what memory already holds. It opens no files and no other Project's folder. Each search shows in the thread as a tool step, and the context panel lists the memory a thread was given.

### Your controls

Everything is in **Settings › Memory**:

- **Remember across threads** turns all of it on or off.
- **Search past threads** turns the search on or off on its own.
- **Model that writes memory** picks a different model than each thread's own provider.
- **Keep a Project out** stops Octant from learning from that Project and from showing what it learned there to other threads.
- **What Octant remembers** lists each note with the thread it came from. Edit or delete any of them.
- **Forget everything** erases every note and every remembered thread.

To keep one thread out, right-click it in the sidebar and choose **Leave no trace in memory**. Octant forgets what it learned from that thread and never learns from it. Undo it in Settings › Memory.

Deleting a note erases it for good. Purging a thread removes what was learned only from that thread.

New threads get these notes whatever provider they use, so something learned in a thread on one provider can reach a thread on another.

## Next steps

- [Projects](/guide/projects) for Project lifecycle management
- [Promotions](/guide/promotions) for escalating Work work to Code
