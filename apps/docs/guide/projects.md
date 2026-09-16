---
description: Projects organize work across modes with scoped authority, memory, and binding rules.
---

# Projects

Projects are the primary organizational unit in Octant. A Project determines the mode, authority, and workspace binding for every thread it contains. The mode is server-enforced and cannot be changed after creation.

## Project types

| Mode | Binding                      | Authority                             |
| ---- | ---------------------------- | ------------------------------------- |
| Chat | Virtual (no filesystem root) | Scoped memory only, no shell or files |
| Work | One OS-confined folder       | Confined filesystem within the root   |
| Code | One OS-confined folder       | Git, shell, and tools within the root |

Chat Projects are virtual, memory-scoped containers with no implicit filesystem or shell authority. Work Projects bind one selected directory. Code Projects bind one selected directory; Git features light up when that directory is a repository.

## Creating a Project

1. Click **New Project** in the sidebar.
2. Select the mode (Chat, Work, or Code).
3. For Work and Code, use the native picker to select a directory.
4. Name the Project.

The native selection stays in Electron main. The renderer receives an opaque, single-use receipt rather than the selected path. Paths that are not directories are denied before creation.

## Project operations

Projects support the following operations:

- **Rename**: change the Project display name.
- **Pin/Order**: pin a Project to the sidebar and reorder pinned Projects.
- **Archive/Restore**: archive a Project to reduce sidebar clutter. Archived Projects retain all data and can be restored.
- **Search**: filter the current mode's sidebar threads by title or by their
  Project, Recents, or Unfiled label.
- **Relink**: when a bound root becomes unavailable (moved or removed), the Project shows `Relink required`. Use audited relink to point to the new location. Root availability is observed at bootstrap and is not journaled, so relinking does not rewrite durable history.

## Project hierarchy

The sidebar displays a mode-aware Project hierarchy. Each mode group lists its Projects, and the active Project is highlighted. Threads belong to exactly one Project. A cross-Project tab drop does not silently change authority; it offers to open the thread in a new window instead.

## What a thread row shows

Sidebar thread rows can carry the Project a thread belongs to, its branch, its linked pull request, when it was last updated, and its status mark. **Settings › Appearance › Sidebar thread rows** turns each of those on or off for the view you choose, and the Project view filter menu's **Property visibility** submenu edits the view you are looking at, with **Hide all** clearing it in one action. A row that does not carry a property omits it rather than leaving a gap.

The choice belongs to the view you are looking at. The Projects tree and the Activity feed each keep their own switches: by default the tree shows the branch, pull request, age, and status mark, while the feed shows the Project name and status mark alone. Hiding pull requests in the tree leaves the feed as it was, and the reverse.

The choice is saved with your other appearance settings on the host, so it survives restarts and reaches every window that reads that host.

## Bound root lifecycle

When a Work or Code Project root becomes unavailable:

1. The Project displays an actionable unavailable state.
2. Layout and thread identity are preserved.
3. Tools that require the root show a recovery prompt.
4. Relink restores authority to the new location.

The server does not retarget tools to a different Project or root.

## Next steps

- [Shared Memory](/guide/memory) for Project-scoped memory management
- [Chat](/guide/chat), [Work](/guide/work), and [Code](/guide/code) for mode-specific details

Activity rows use the same thread-details hover card as the Projects tree.
Thread rows grow to fit enabled properties in both views, keeping branch and
Project details inside their own row rather than overlapping the next thread.
When Branch is enabled, both existing repository checkouts and managed worktrees
show their recorded branch. Plain folders have no branch label. Linked pull
requests use state colors (open green, merged purple, closed red); their separate
control opens Review without switching threads. Cmd-click or Ctrl-click opens
GitHub when that destination is available. Hover details show the full cached
PR list and its available destinations without refreshing GitHub.
