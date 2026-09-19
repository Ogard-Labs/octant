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
  The command palette lists only `.xcodeproj` and `.xcworkspace` at the
  checkout root. The `octant_apple` tool can name a `Package.swift` path, but
  Swift-package discovery is not available yet: the host passes that file to
  `xcodebuild -packagePath`, which expects the package directory, so
  discovery fails as incomplete. Test plans are not discovered yet.
- **Build** against the workspace's first reported scheme.
- **Test** against that same scheme. The workbench Test action names no
  Simulator. A non-macOS test without a matching destination is refused as an
  invalid destination, so Simulator tests are not available from the
  workbench yet. An `octant_apple` test can include a matching `platform` and
  `simulatorId`; a macOS test needs no Simulator.
- **Run** on a selected Simulator — build, install, and launch (a launch
  also terminates any already-running copy of that app). The workbench sends
  the first discovered Simulator's platform with the selected destination's
  ID, so Run succeeds only when that destination is on the same platform; a
  different-platform selection is refused as an invalid destination.
  Separate install, terminate, and relaunch controls are not yet built.
- Simulator **Boot** and **Shut down** as explicit actions from the workbench
  destination list — never as a side effect of Build or Test. Boot waits until
  the destination is ready. Erase is not yet a workbench action.
- **Capture screen** of a booted Simulator, stored as a screenshot artifact.

macOS app staging, stopping only owned processes, launch and focus, unified
logs and crashes, and handoff to Xcode or an external editor are not yet
workbench actions. Tests that reach `xcodebuild test` run the scheme (Swift
Testing and XCTest as the scheme defines them). `xcodebuild` is given a
result-bundle path; that `.xcresult` is not retained as a host artifact, and
the evidence reference does not currently resolve to stored bytes. Logs, and
screenshots from captures, are retained. Focused target, suite, test, tag,
and test-plan selection, accessibility audits, flake investigation, and a
navigable parse of `.xcresult` into build errors, warnings, test
hierarchies, attachments, and coverage are not yet built.

## Workbench surface

The workbench appears as a Code workspace tab titled **Apple workbench** and
shows the project path, the "Apple development" eyebrow, Xcode version,
scheme, revision, SDK count, Simulator count, **Actions**, **Simulator
destinations**, **Current progress**, and **Validation evidence**.

The iOS Simulator dock tab shows a live frame bound to the owning Code thread
and checkout. Its states are setup, unavailable, booting, live, interrupted,
and stale after a host restart. Under the Octant desktop app a live frame
shows the Simulator's screen as it changes, so you see what a tap or an
agent's action did without capturing in between. Frames are sent only when the
screen changes, and they are never stored: nothing of the live view is written
to disk, to the journal, or into a model's context. **Capture screen** is
still how a screen becomes validation evidence. When the host has no live
view, the frame shows the latest captured still instead. Remote, Linux, and headless clients
say the native frame is not attachable instead of hanging or inventing a
picture. Closing the tab unmounts the view only; it does not shut down,
erase, or transfer the destination.

Orientation, accessibility hierarchy, and recording are not part of this
surface yet. Typed input, tap, and hardware keys ride the same workbench
control channel as Boot and Capture screen: the renderer posts structured
requests, and the Octant desktop app delivers them to the Simulator through a
small native helper it ships. Nothing comes to the foreground and no macOS
Accessibility permission is needed. A tap lands on the point you click on the
captured screen. **Type** sends letters, digits, spaces, and new lines; text
with any other character is refused whole rather than typed wrong, because a
Simulator maps key positions with its own keyboard language. For the same
reason typing works on a Simulator whose keyboard language uses a QWERTY
layout — English, the Nordic languages, Dutch, Spanish, Portuguese — and is
refused on others, such as French or German, with
`keyboard-layout-unsupported` in the evidence. **Return**,
**Escape**, Home, and Lock are keys and buttons. Input needs Xcode 27 or
later. When the host cannot deliver an input action, the evidence names the
host's refusal rather than reading as interrupted. Remote, Linux, and
headless clients stay read-only. Typed characters never land in durable
evidence, and neither does the reason a type-text action failed, since it can
quote the script. Destination actions remain on the workbench list: each
Simulator offers only what its reported state can perform.

States also include loading the toolchain, waiting for Apple evidence,
toolchain unavailable, action interrupted, and action failed, with **Retry**.
Outcome labels are **Succeeded**, **Failed**, **Cancelled**, **Timed out**,
**Interrupted**, **Unavailable**, **Unauthorized**, **Invalid destination**,
and **Process died**.

## Running actions

**Build** and **Test** run against the workspace scheme and name no
Simulator. Each Simulator destination offers only what its reported state
can do: a shut-down Simulator offers **Boot**; a booted one offers **Run**,
**Capture screen**, and **Shut down**. A live attachable frame also accepts
**tap**, typed text, and hardware keys. **Run** is limited to destinations
whose platform matches the first discovered Simulator. Anything already
running can be **Cancel**led from **Current progress**.

An approval-gated Code thread asks for confirmation before each of these, the
same confirmation the rest of Code uses. **Capture screen** does not: reading
a booted Simulator's screen changes nothing, so it works under Plan mode too.
A capture is recorded as a **screenshot** artifact in **Validation evidence**
— a durable reference to a local file, never image bytes copied into the
conversation.

Open the workbench from the command palette: **Open Apple workbench for
&lt;project&gt;** appears for each `.xcodeproj` or `.xcworkspace` the host
finds at the root of the Code thread's checkout. A checkout with none offers
no such command. `Package.swift` is not listed.

A Code thread on **Full access** also reaches these actions through the
app-managed `octant_apple` tool, so an agent can discover the toolchain, read
Simulator state, build, test, run, boot, shut down, capture the screen, and
inject tap, typed text, and hardware keys. Pane-driven input journals as
`local-user`; tool-driven input journals as `agent`. The host binds both to
the same thread and checkout and refuses them with the same policy; the tool
is unavailable under Plan and approval-gated postures. The workbench never
treats Boot as a side effect of Run: a shut-down Simulator only offers
**Boot**. The tool's `run` operation currently boots a named Simulator that
is shut down, then installs and launches; that is today's toolchain behavior,
not a workbench control.

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

- [Browser and computer use](/advanced/browser-and-computer-use) for the host-owned computer-use surface
- [Plugins and skills](/advanced/plugins-and-skills) for optional extension content
- [Release compatibility](/advanced/release-compatibility) for preview boundaries
