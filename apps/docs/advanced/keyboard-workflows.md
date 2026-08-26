---
description: Command palette, thread search, remappable shortcuts, Settings search, and the Zen focus workspace.
---

# Keyboard Workflows

Octant supports keyboard-driven navigation for the surfaces that matter.
The command palette, current-mode thread Search, and remappable chords
are available now. A searchable command and shortcut registry is not yet
built.

## Command palette

**⌘/Ctrl+K** opens the command palette — Command on Apple hardware,
Control elsewhere. The chord is remappable in Settings. On macOS,
Control+K stays with Cocoa text editing (delete to end of line) inside
every text field; the palette never takes that chord there.

The palette searches the commands this host offers right now. Up, Down,
Home, and End move the active row, Enter runs it, and Escape dismisses.
Focus returns to the control that had it when the chord fired. The
palette is inert while Zen is active. Every command still runs through
its ordinary authority check.

It can switch mode, start a new thread in the current mode, open thread
Search, open a thread or Project the host has already listed, select an
agent profile, open Settings, and open the Apple workbench for a
`.xcodeproj` or `.xcworkspace` at the checkout root. Skill references
stay in the composer `/` list, because the palette has no draft to write
into.

## Thread search

Sidebar **Search** opens a current-mode thread overlay. It filters titles
among the threads the host has already listed for this window — live and
archived — and never mixes Chat, Work, and Code. Project names, Recents,
and Unfiled print as folder words on a hit, not as filters. Up, Down,
Home, and End move, Enter opens, and Escape dismisses.

The palette command **Search Chat threads**, **Search Work threads**, or
**Search Code threads** opens the same overlay.

## Mode switcher

The sidebar mode switcher selects **Chat**, **Work**, or **Code**. In
Appearance it can present as compact buttons or a dropdown; both use the same
authoritative command. Chat and Work can be disabled in Settings, while
Code is always available.

## Context usage

**⌘/Ctrl+Shift+U** opens the active thread composer's context-usage popover.
The chord is remappable in Settings. Opening the popover does not make a
further provider or network call.

## Settings search

Settings search is a keyboard-navigable result list that deep-links to the
focused control. Press Enter to activate a result and land on the setting it
points to.

## Keyboard shortcuts

**Settings → Keyboard shortcuts** remaps the chords that reach Octant's
global surfaces. Press a row to record a new chord, or edit the JSON to
move a set between machines. The list always shows what is in effect.

The remappable set:

- **Open the command palette** — **⌘/Ctrl+K**
- **Show context usage** — **⌘/Ctrl+Shift+U**
- **Toggle Zen mode** — **⌘/Ctrl+Shift+Z**
- **Show the next focus space** — **⌘/Ctrl+Alt+]**
- **Show the previous focus space** — **⌘/Ctrl+Alt+[**
- **Find a file by name** — **⌘/Ctrl+P**, in the active Code thread
- **Find text across the repository** — **⌘/Ctrl+Shift+F**, in the active
  Code thread

If two actions share a chord, the first keeps it and the other is marked as
sharing it and will not run. **Reset** restores one action to its default;
**Reset all to defaults** restores every action. A chord that would swallow
ordinary typing — a bare letter, Shift alone, Tab, Escape, or Enter — is
refused. Keybindings are a preference about this client's keyboard, stored
locally; they change which panel a key opens, not what the server will
authorize.

Code file and content search open the same dialog in different scopes, and
are inert while Zen is active or no Code thread is in view.

## Zen focus workspace

The Zen workspace is a pressure-focus surface for deep work. Keyboard
behavior:

- **⌘/Ctrl+Shift+Z** enters and exits Zen. The chord is remappable in
  Settings, and still exits when a pinned card or other Zen element has
  focus, except while a text field has focus.
- Bare **Escape** exits Zen when the Zen background or floating bar owns
  focus.
- Inside Zen, **Arrow** keys move the active element and **Alt+Arrow**
  resizes it.
- **⌘/Ctrl+Alt+]** and **⌘/Ctrl+Alt+[** show the next and previous focus
  space, wrapping at both ends.

## Focus spaces

A window's Zen surface holds up to eight named spaces and shows one at a
time, so you can keep separate arrangements of pinned work without unpinning
anything. The strip at the top of the surface lists them:

- Click a space to show it; double-click its name to rename it.
- **+** adds a space and shows it; **×** removes one. A window always keeps
  its last space.
- The arrow keys step through the strip when it has focus.

Switching space changes nothing about what is pinned to either one, and
grants nothing: every pinned element still acts under its own source
context.

A pinned Chat or Work thread is a live card: its transcript and composer
run inside the card, so you can follow and answer that thread without leaving
Zen. Each card acts only for the thread it was pinned to. A few cards stream
at a time — the one you have selected first, then the ones nearest the front —
and a card that is minimized, panned out of view, or waiting its turn pauses
and says so instead of showing a stale conversation as if it were live. Bring
it back into view or select it to resume. **Continue** still opens the thread
in the main workspace. Code threads stay a read-only card for now.

A Code thread's terminal can be pinned into a space from the terminal itself
— **Pin to focus zone** on the terminal tab — so you can watch a build while
you work on something else. The pinned shell is a second window onto the same
terminal, not a copy: what you type reaches it under the same thread and
checkout as the workspace tab, under the same approval policy, and a thread
that is planning stays read-only. A pinned shell is never started or
restarted from the card; that stays with the Code thread. A pinned shell
spends the same live-card budget a pinned conversation does, so it pauses on
the same terms and picks the shell back up where it is when you return.

When Zen state cannot be decoded, a **Recover Zen** path restores the main
workspace instead of trapping you. Zen rebuilds from the event journal after
a restart or reconnect.

## Not yet built

A searchable **command and shortcut registry** — one list you can search
that names every command together with its shortcut — is not yet built.
Remapping, collision detection, and restore-default already live in
Keyboard shortcuts; they are not waiting on that registry.

## Next steps

- [Themes and appearance](/advanced/themes) for layout and mode-switcher settings
- [Apple Development Workbench](/advanced/apple-workbench) for the palette's
  workbench command
- [Recovery and troubleshooting](/advanced/recovery) for Zen recovery
- [Remote access](/advanced/remote-access) for the same keyboard workflows on a remote client
