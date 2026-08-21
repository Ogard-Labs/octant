---
description: Shared memory lets Projects persist decisions, facts, and context across threads with active and history views.
---

# Shared Memory

Shared memory is a Project-scoped capability that lets threads within the same Project share persistent context. Memory entries survive thread completion, restart, and replay. In the current app it is reachable from Project surfaces and from a right-dock tab. The approved later placement is Project Overview only; it is not a dock tab.

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

## Next steps

- [Projects](/guide/projects) for Project lifecycle management
- [Promotions](/guide/promotions) for escalating Work work to Code
