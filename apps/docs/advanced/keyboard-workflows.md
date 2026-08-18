---
description: Mode switching, keyboard navigation, Settings search, and the Zen focus workspace.
---

# Keyboard Workflows

Octant supports keyboard-driven navigation for the surfaces that matter,
with a planned command and shortcut registry for deeper customization.

## Mode switcher

The sidebar mode switcher selects **Chat**, **Work**, or **Code**. In
Appearance it can present as compact buttons or a dropdown; both use the same
authoritative command. Chat and Work can be disabled in Settings, while
Code is always available.

## Settings search

Settings search is a keyboard-navigable result list that deep-links to the
focused control. Press Enter to activate a result and land on the setting it
points to.

## Zen focus workspace

The Zen workspace is a pressure-focus surface for deep work. Keyboard
behavior:

- **⌘/Ctrl+Shift+Z** enters and exits Zen.
- A dedicated keyboard command handles **Exit Zen** above focused Zen
  elements.
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

An attached Chat or Work thread is a live card: its transcript and composer
run inside the card, so you can follow and answer that thread without leaving
Zen. Each card acts only for the thread it was attached to. A few cards stream
at a time — the one you have selected first, then the ones nearest the front —
and a card that is minimized, panned out of view, or waiting its turn pauses
and says so instead of showing a stale conversation as if it were live. Bring
it back into view or select it to resume. **Continue** still opens the thread
in the main workspace. Code threads stay a read-only card for now.

When Zen state cannot be decoded, a **Recover Zen** path restores the main
workspace instead of trapping you. Zen rebuilds from the event journal after
a restart or reconnect.

## Planned registry

A global Project and thread search, a **command palette**, and a searchable
**command and shortcut registry** with remapping, collision detection, and
restore-default are planned for the technical preview. Until the registry
ships, the shortcuts above are the documented set.

## Next steps

- [Themes and appearance](/advanced/themes) for layout and mode-switcher settings
- [Recovery and troubleshooting](/advanced/recovery) for Zen recovery
- [Remote access](/advanced/remote-access) for the same keyboard workflows on a remote client
