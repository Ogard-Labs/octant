---
description: Projects organize work across modes with scoped authority, memory, and binding rules.
---

# Projects

Projects are the primary organizational unit in Octant. A Project determines the mode, authority, and workspace binding for every thread it contains. The mode is server-enforced and cannot be changed after creation.

Open **Projects** in primary navigation to search and filter the Project list.
Select a Project to open its overview in the same content area. Choose **Projects**
again to return to the list. The main navigation sidebar stays the same width.

## Project types

| Mode | Binding                      | Authority                             |
| ---- | ---------------------------- | ------------------------------------- |
| Chat | Virtual (no filesystem root) | Scoped memory only, no shell or files |
| Work | One OS-confined folder       | Confined filesystem within the root   |
| Code | One folder, sandboxed        | Git, shell, and tools within the root |

Planned: Work and Code get the same authority under the same guardrail level; Work differs by hiding developer tools until you turn them on. Not built yet.

Chat Projects are virtual, memory-scoped containers with no implicit filesystem or shell authority. Work Projects bind one selected directory. Code Projects bind one selected directory; Git features light up when that directory is a repository.

## Creating a Project

1. Open **Projects** in primary navigation, then click **Add Project** in the directory.
2. Select the mode (Chat, Work, or Code).
3. For Work and Code, use the native picker to select a directory.
4. Name the Project.

The native selection stays in Electron main. The renderer receives an opaque, single-use receipt rather than the selected path. Paths that are not directories are denied before creation.

When a host has no native picker, the host folder browser lists the folders it can reach. A folder the host cannot read in time is listed as a plain folder, and a browse that fails shows an error you can retry without losing the folder or search you were on.

## Project operations

Projects support the following operations:

- **Rename**: change the Project display name.
- **Pin/Order**: pin a Project to the sidebar and reorder pinned Projects.
- **Archive/Restore**: archive a Project to reduce sidebar clutter. Archived Projects retain all data and can be restored.
- **Search**: click the magnifier at the top of the sidebar to open **Filter
  threads**, then type to filter the current mode's threads by title or by their
  Project, Recents, or Unfiled label. Press Enter to search every thread instead,
  or Escape to close it. **Settings ›
  Sidebar › Thread filter** can keep the field always shown.
- **Relink**: when a bound root becomes unavailable (moved or removed), the Project shows `Relink required`. Use audited relink to point to the new location. Root availability is observed at bootstrap and is not journaled, so relinking does not rewrite durable history.
- **Default mode** (Code Projects): under **Access and limits** in the Project overview, choose the mode this Project's new threads start in, or **Same as Settings**. `octant project access <name> full-access` on the host still sets Full access for the Project (and `approval-gated` returns it to Settings); a Code thread `octant agent` starts in that Project follows the same choice.

## Several folders

A Work or Code Project has one main folder and can have extra folders beside it, for example a notes folder next to a repository. Open the Project overview and select **Add folder…** on the folders card; on the desktop app this opens the folder picker. **Remove** next to a folder takes it out of the Project and leaves the folder itself untouched.

- An extra folder gets the same access as the main folder at each thread's level: at Ask first, writes there ask as they do in the main folder; in Plan it is read-only; at Full access nothing is confined.
- Checkouts and Git stay in the main folder. An extra folder is a plain folder: Octant manages no checkout or worktree in it.
- Language services, [Run and debug](/advanced/debugging) and the Tests tool cover an extra folder. A file there is named by its full path. The Tests tool lists each extra folder's `test` scripts and `.octant/tests.json` tests, named after the folder, and runs them in that folder.
- A Project terminal and your saved actions start in the main folder. Once the Project has an extra folder, the action buttons in the window header show a **Run in** menu, and the Code start screen's quick tools list **Terminal in** each extra folder. The terminal can reach every folder of the Project.
- Agents are told the extra folders' paths at the start of each turn. A folder added or removed applies from the next turn.
- The Files tool of a Work thread and the Overview's folder list include the extra folders. A file there shows its own name, with its folder's full path beside it, and opens like any other file. The `@file` picker in Work and Code offers files from the extra folders by their full path, and Code search lists matches there with the folder's name in front. The Code editor opens files of the main checkout only, so choose such a match from your own editor.
- Octant refuses your home folder itself, any folder above it, system folders, and folders that hold keys or credentials (such as `~/.ssh` or `~/.aws`), as well as a folder inside or around the main folder or another extra folder. A Project can have up to 16 extra folders.

Only you add or remove folders; an agent cannot. Each change is recorded with who made it and when.

## Brand kit

Every Project, Chat, Work or Code, can hold a **brand kit**: your colours, fonts, corner radius, and page gutter, set once. Open the Project overview, choose **Manage** next to **Brand kit**, fill in the values you care about, and select **Save brand kit**. **Clear** removes the kit.

- Colours are hex values (`#0a7d5a`) or `rgb()`, `hsl()`, `oklch()`, or `oklab()` functions.
- Fonts are system faces or generic families, such as `georgia, serif`. Octant never downloads a font.
- Radius and gutter are lengths in `px`, `rem`, `em`, or `%`.

When an agent makes a design in a Project that has a kit, it is told the kit exists and draws the design with it, so every screen, slide, and page looks like your product. The design then looks the same in the Canvas, Present, Play, a share, and an HTML export, in light and dark workspaces alike. A kit grants no access to files or the shell. A Chat thread outside a Chat Project has no kit.

## Project quick start

Chat and Work Project overviews can start a thread directly. Their model pickers offer the selected model's declared reasoning or effort levels. The chosen level is applied before the first message and remains part of that thread's model settings. Choosing **Default** leaves the provider default in effect; changing the provider or model restores its last supported quick-start reasoning choice, or the provider default when none was remembered.

## Project hierarchy

The sidebar displays a mode-aware Project hierarchy. Each mode group lists its Projects, and the active Project is highlighted. Threads belong to exactly one Project. A cross-Project tab drop does not silently change authority; it offers to open the thread in a new window instead.

## Count tiles and the thread list

Four tiles at the top of the sidebar count what matters right now: **Inbox**
(approvals, questions, due follow-ups and subagent requests waiting on you),
**Running**, **To review** (finished turns you have
not opened yet), and **Done today**. Click a tile to go there: Running opens
the Board (the Activity feed in Chat), To review opens the Review page, and
Done today opens the Put away shelf. Turn the tiles off in **Settings ›
Sidebar › Count tiles** to get the plain Inbox and Board rows back.

## Review finished threads

**To review** opens the Review page: every finished thread you have not opened
yet, oldest first. The list on the left shows each thread's Project, how many
files and lines it changed, and whether its checks passed. The panel on the
right shows the agent's last reply, the checks, the changed files, and the diff
of the file you pick. Code threads show all of it; Chat threads show the
reply. Work threads do not carry an unread mark yet, so they do not appear.

Work through the list with single keys: **J** and **K** move, **Enter** opens
the thread, **C** completes it, **S** sends it back with a one-line follow-up
that becomes its next turn, **Z** snoozes it, and **E** marks it seen. The keys
work while the page has focus; after clicking elsewhere, click the page to use
them again. The page never merges, approves, or comments on a pull request, and nothing on it
deletes work. You can also open it from the command palette with **Review
finished threads**.

A narrow rail of icons stands to the left of the sidebar: **Home** (back to
the start screen, **⌘/Ctrl+Shift+H**), Inbox, Running, To
review and Done with their counts, your other places (Board, Pull requests and
so on), the Activity feed, Projects, **More** (the places you set to Menu only,
and Customize sidebar), and Settings. **Settings › Sidebar › Sidebar
destinations** decides which places the rail shows and in what order. Above Settings, a ring for each
provider that reports plan limits shows how much of its week (outer) and five
hours (inner) is left; hover it for every window and when it resets. The rings
are still there after you restart Octant, and the card says when the reading was
last made if it is several hours old. **Hide sidebar** (or
**⌘\**) shrinks the sidebar down to that rail, which then also shows the
modes, New thread, Search, and your Projects as letter tiles. Click **Show
sidebar** at the top of the rail, or press *_⌘\*_ again, to bring it back. **Back** and **Forward** in the title band step through the pages and
threads you opened in this window. In
**Settings › Sidebar › Icon rail**, choose **When hidden** to show the rail
only while the sidebar is hidden, or **Never** to hide everything.

The switch beside the Project view picker chooses how threads are listed:
**Projects** groups them under their Project, **Activity** lists them by
recency.

## What a thread row shows

Sidebar thread rows can carry the Project a thread belongs to, its branch, its linked pull request, when it was last updated, and its status mark. **Settings › Sidebar › Thread rows** turns each of those on or off for the view you choose, and the Project view filter menu's **Property visibility** submenu edits the view you are looking at, with **Hide all** clearing it in one action. A row that does not carry a property omits it rather than leaving a gap.

The sidebar opens on **Status**: your threads grouped as Pinned, Needs input, Ready for review, Working, and Idle, with a count on each heading. Click a heading to fold or unfold its threads; the window remembers which you folded. The switch beside the Project view picker changes to the Projects tree or the Activity feed, and each mode remembers your choice. Before your first thread, the sidebar says so and points you to the composer to start one. A ✓ after a pull request number means its checks pass.

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

Long sidebar lists scroll above the account control, keeping the last Project and
thread reachable when extra row properties are shown.
