# 0043. Simulator follows the active thread in the right sidebar

**Status:** Accepted

## Context

0014 made the Apple Development Workbench a first-class split-tree pane. 0041
later removed tab groups and made the left sidebar the only switcher for main
workspace panes. Using that main-workspace path for the utility launcher's iOS
Simulator action would hide the conversation that owns the checkout, while
opening it in another split would leave the window with two competing work
regions and an ambiguous right-dock subject.

The right sidebar already follows the active thread and hosts Browser,
Terminal, Files, Changes, Tests, and Side Chat without changing the main pane.
Simulator has the same relationship to a Code thread: it acts on that thread's
checkout and host-owned destination, and it must not replace the thread.

## Decision

- The utility launcher's iOS Simulator action opens a thread-scoped
  right-sidebar tab outside the split tree and never replaces a main workspace
  pane. Deliberately opening the full Apple Development Workbench through its
  existing project command remains a separate main-workspace action.
- The tab is offered for Code threads. When the checkout reports no Xcode
  project or workspace, or the host exposes no Apple toolchain client, it opens
  an explicit unavailable state and performs no action.
- The tab renders the existing provider-neutral Apple Development Workbench.
  Discovery, destination identity, ownership, leases, approvals, structured
  actions, evidence, and cancellation remain exactly as 0014 defined them.
- Each visible Code thread owns its Simulator tab state. Activating another pane
  shows that thread's tabs; returning restores the previous thread's Simulator
  tab and host-owned runtime state.
- Closing the tab or the whole right sidebar unmounts the view only. It never
  shuts down, erases, resets, or transfers a Simulator destination and never
  stops an Apple action implicitly.
- Pointer activity or keyboard input in a main pane chooses the active thread.
  Programmatic focus changes do not retarget the Simulator.
- The sidebar grants no authority. Read-only Simulator observations remain
  approval-free, and build, run, boot, shutdown, and test actions keep the Code
  thread's ordinary approval policy.
- The first-release boundary remains Simulator and local macOS development on
  Apple Silicon. Physical devices, signing, provisioning, TestFlight, App Store
  submission, and notarization remain outside this decision.

## Consequences

- A developer can watch and control Simulator without losing the conversation
  and composer that own the work.
- Two visible Code threads cannot display each other's Simulator state when
  focus changes; the tab set and Apple workbench binding move together.
- The utility launcher no longer needs to mint or replace a split-tree surface,
  while the full Apple Development Workbench and the Apple toolchain evidence
  contracts remain unchanged.

## Related

- 0014 defined the app-managed Apple capability this record supersedes.
- 0015 defines the Right Utility Dock outside the split tree.
- 0041 makes the active pane the right sidebar's thread subject.
