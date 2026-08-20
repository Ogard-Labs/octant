---
description: The provider-neutral Apple Development Workbench for Xcode, Simulator, build, run, test, and validation evidence.
---

# Apple Development Workbench

The Apple Development Workbench is a provider-neutral workbench inside the
Code workspace for local Apple development on Apple Silicon. It works with
every configured provider, including a local OpenAI-compatible one, and does
**not** depend on Codex, Claude, a particular plugin, or a provider-owned
computer-use implementation. Core Apple capability is app-managed and works
even when the Build iOS Apps extension is absent or disabled.

## Scope

The intended first-release boundary is **local iOS and iPadOS Simulator
development** and **local macOS development** (Xcode and Swift Package
Manager). What you can do today is a slice of that shape:

- Toolchain, project, and destination discovery (Xcode, `xcode-select`, SDKs,
  Simulator runtimes, workspaces, projects, schemes, configurations, targets,
  destinations) — non-mutating, with setup guidance when Xcode is missing.
  The `octant_apple` tool can name a `Package.swift` path; the command palette
  does not list Swift packages, and test plans are not discovered yet.
- **Build** and **Test** against the workspace's first reported scheme, and
  **Run** on an explicitly named Simulator — build, install, and launch (a
  launch also terminates any already-running copy of that app). Separate
  install, terminate, and relaunch controls are not yet built.
- Simulator **Boot** and **Shut down** as explicit actions from the workbench
  destination list — never as a side effect of Build or Test. Boot waits until
  the destination is ready. Erase is not yet a workbench action.
- **Capture screen** of a booted Simulator, stored as a screenshot artifact.

macOS app staging, stopping only owned processes, launch and focus, unified
logs and crashes, and handoff to Xcode or an external editor are not yet
workbench actions. Tests run the scheme through `xcodebuild test` (Swift
Testing and XCTest as the scheme defines them) and keep a `.xcresult` artifact
reference. Focused target, suite, test, tag, and test-plan selection,
accessibility audits, flake investigation, and a navigable parse of that
`.xcresult` into build errors, warnings, test hierarchies, attachments, and
coverage are not yet built.

## Workbench surface

The workbench appears as a Code workspace tab titled **Apple workbench** and
shows the project path, the "Apple development" eyebrow, Xcode version,
scheme, revision, SDK count, Simulator count, **Actions**, **Simulator
destinations**, **Current progress**, and **Validation evidence**.

An inline Simulator pane with a live frame, orientation, accessibility
hierarchy, screenshot, recording, and log surfaces is not yet built. Today
the Simulator is a destination list with the actions that destination can
perform.

States include loading the toolchain, waiting for Apple evidence, toolchain
unavailable, action interrupted, and action failed, with **Retry**. Outcome
labels are **Succeeded**, **Failed**, **Cancelled**, **Timed out**,
**Interrupted**, **Unavailable**, **Unauthorized**, **Invalid destination**,
and **Process died**.

## Running actions

**Build** and **Test** run against the workspace scheme. Each Simulator
destination offers only what its reported state can do: a shut-down Simulator
offers **Boot**; a booted one offers **Run**, **Capture screen**, and **Shut
down**. Anything already running can be **Cancel**led from **Current
progress**.

An approval-gated Code thread asks for confirmation before each of these, the
same confirmation the rest of Code uses. **Capture screen** does not: reading
a booted Simulator's screen changes nothing, so it works under Plan mode too.
A capture is recorded as a **screenshot** artifact in **Validation evidence**
— a durable reference to a local file, never image bytes copied into the
conversation.

Open the workbench from the command palette: **Open Apple workbench for
&lt;project&gt;** appears for each `.xcodeproj` or `.xcworkspace` the host
finds at the root of the Code thread's checkout. A checkout with none offers
no such command.

A Code thread on **Full access** also reaches the same actions through the
app-managed `octant_apple` tool, so an agent can discover the toolchain, read
Simulator state, build, test, run, boot, shut down, and capture the screen.
It sends the same requests the workbench sends and is refused by the same
policy; it is unavailable under Plan and approval-gated postures. The tool's
`run` operation will boot a named Simulator if it is not already up.

## Honest verification

A coding agent may claim verification only when the surface was actually
exercised:

- Compilation is not launch proof.
- Launch is not UI-workflow proof.
- Simulator is not physical-device proof.
- A passing unit suite is not a passing UI or accessibility workflow.

Evidence is stored as local artifact files with durable references, not
copied wholesale into model context. An automated **Review changes** pass
that inspects the diff and Apple evidence and produces durable inline
findings is not yet built; Code's local findings pane is a separate surface
and does not consume Simulator captures.

## Boundaries

Not in V1: physical devices, signing, provisioning, archive and export,
TestFlight, notarization, App Store submission, and release automation.
Octant never silently installs or updates Xcode, SDKs, or Simulator
runtimes. The Build iOS Apps extension is optional and contributes nothing to
the core Apple path.

## Next steps

- [Browser and computer use](/advanced/browser-and-computer-use) for the UI fallback
- [Plugins and skills](/advanced/plugins-and-skills) for optional extension content
- [Release compatibility](/advanced/release-compatibility) for preview boundaries
