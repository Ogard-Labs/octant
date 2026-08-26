---
description: Advanced operations and safety guides for providers, tools, Git and worktrees, extensions, remote access, privacy, and troubleshooting.
---

# Advanced Guide

The advanced guide covers operations and safety topics beyond the primary
workflows in the [Guide](/guide/) and the mode boundaries in
[Concepts](/concepts/). Each page states what is available in the current
technical preview and what remains planned, so you can rely on the content
without over-trusting a surface that has not shipped.

## Providers, models, and context

- [Providers and models](/advanced/providers) — add and manage provider instances, choose models, and change provider or model mid-thread.
- [Context budgets and limits](/advanced/context-budgets) — how Octant plans each turn within provider context windows and what happens at the limits.
- [Subagents](/advanced/subagents) — child agent runs, their hierarchy, isolation, and recovery.

## Tools and editing

- [Files, previews, and selections](/advanced/files) — file authority by mode, secure read-only previews, and structured selections.
- [Editor and terminals](/advanced/editor-and-terminals) — the Monaco editor, external-editor handoff, and integrated terminals.

## Git, worktrees, and thread boards

- [Git and worktrees](/advanced/git-worktrees) — repository identity, managed worktrees, Git operations, and pull requests.
- [Code Thread Board](/advanced/code-board) — runtime-derived Code thread status and Project grouping.
- [Work Thread Board](/advanced/work-board) — runtime-derived Work thread status, confined root binding, and delivery confirmation.

## Browser, Apple, and extensions

- [Browser and computer use](/advanced/browser-and-computer-use) — isolated browser contexts and host-controlled computer use.
- [Apple Development Workbench](/advanced/apple-workbench) — provider-neutral Xcode, Simulator, and validation workflows.
- [Plugins and skills](/advanced/plugins-and-skills) — install, trust, enable, and use extension packages and standalone skills.

## Appearance and workflows

- [Themes and appearance](/advanced/themes) — semantic themes, presets, typography, and sidebar appearance.
- [Keyboard workflows](/advanced/keyboard-workflows) — command palette, remappable shortcuts, Zen, and keyboard navigation.

## Remote, privacy, and recovery

- [Remote access](/advanced/remote-access) — authenticated LAN and Tailscale access to one host.
- [Privacy and security](/advanced/privacy-and-security) — local-first storage, credentials, approvals, and confinement.
- [Recovery and troubleshooting](/advanced/recovery) — replay, rebuilds, conflict recovery, and diagnostic tooling.
- [Release compatibility](/advanced/release-compatibility) — technical-preview boundaries, data location, and migration notes.

## Technical-preview boundary

Octant is an Apple Silicon technical preview. Declared releases are signed,
notarized, and update themselves; a local package is unsigned because
signing needs maintainer credentials. Capabilities that are still in
progress or planned are labeled explicitly on each page. When a page
mentions a planned surface, treat it as direction, not a promise that the
workflow is available today.
