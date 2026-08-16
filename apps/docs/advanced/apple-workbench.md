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

The workbench covers **local iOS and iPadOS Simulator development** and
**local macOS development** (Xcode and Swift Package Manager):

- Toolchain, project, and destination discovery (Xcode, `xcode-select`, SDKs,
  Simulator runtimes, workspaces, projects, `Package.swift`, schemes, test
  plans, destinations) — non-mutating, with setup guidance
- Build, install, launch, terminate, and relaunch on an explicitly allocated
  Simulator
- Simulator boot, wait, shut down, and erase as explicit ownership-protected
  actions — never implicit
- macOS app build and staging, stopping only owned processes, launch and
  focus, unified logs and crashes, and handoff to Xcode or an external editor
- Tests via Swift Testing and XCTest — unit, integration, and UI — with
  focused target, suite, test, tag, and test-plan selection, accessibility
  audits, flake investigation, and `.xcresult` evidence parsed into navigable
  build errors, warnings, test hierarchies, attachments, and coverage

## Workbench surface

The workbench appears as a Code workspace tab and shows the project path, the
"Apple development" eyebrow, Xcode version, scheme, revision, SDK count,
**Simulator destinations**, **Current progress**, and **Validation
evidence**. The Simulator is a first-class persistent split-tree pane with a
live frame, orientation, accessibility hierarchy, and screenshot, recording,
and log surfaces.

States include loading the toolchain, waiting for Apple evidence, toolchain
unavailable, action interrupted, and action failed, with **Retry**. Outcome
labels are **Succeeded**, **Failed**, **Cancelled**, **Timed out**,
**Interrupted**, **Unavailable**, **Unauthorized**, **Invalid destination**,
and **Process died**.

## Honest verification

A coding agent may claim verification only when the surface was actually
exercised:

- Compilation is not launch proof.
- Launch is not UI-workflow proof.
- Simulator is not physical-device proof.
- A passing unit suite is not a passing UI or accessibility workflow.

Evidence is stored as local artifact files with durable references, not
copied wholesale into model context. Code mode includes a **Review changes**
action that inspects the diff and evidence, produces durable inline findings
with severity, and supports accept, dismiss, and fix — it never auto-merges
or mutates a remote PR in V1.

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
