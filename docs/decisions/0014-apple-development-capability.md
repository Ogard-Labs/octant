# 0014. Apple development and validation as an app-managed capability

**Status:** Accepted

## Context

Building, running, inspecting, and testing iOS Simulator and local macOS
applications from an agent workspace is a core Octant use case. Two easy
routes were rejected: letting an installed extension own the workflow (so
disabling it removes a core capability) and letting each provider drive
`xcodebuild` and `simctl` through raw shell commands (poor discovery,
recovery, attribution, safety, and evidence). The capability must work with
every configured provider, including local models, and produce evidence that
survives restart.

## Decision

- Octant owns one provider-neutral Apple Development Workbench inside the Code
  workspace and the app-managed tool platform. Provider adapters and
  extensions call the same Octant tools; they cannot start their own untracked
  Simulator, build, test, or computer-use processes outside Octant's
  authority, lifecycle, and evidence model.
- Interfaces are used in a fixed preference order: Octant Apple tool
  contracts; native command-line tools (`xcodebuild`, `xcrun simctl`,
  `devicectl`, SwiftPM, macOS process and log services); XCTest, Swift
  Testing, `.xcresult`, and accessibility surfaces; a reviewed optional
  adapter only when it improves a supported action; Octant computer use for
  otherwise unavailable UI; coordinate-based interaction only when semantic
  targets are unavailable.
- Discovery is derived and refreshable: an `AppleWorkspaceProfile` records
  project or package path, selected Xcode and developer directory, schemes,
  configurations, test plans, targets, platforms, destinations, defaults, and
  the exact checkout and revision. Octant never rewrites projects, schemes,
  build settings, or manifests to make discovery pass; agents edit those files
  through ordinary Code authority.
- Destinations (Simulators and the local Mac) have stable host-local identity,
  state, capabilities, and an explicit Octant owner or lease. Concurrent
  threads cannot reset, erase, shut down, or take over a destination owned by
  another workflow. Erase, content reset, runtime installation, and other
  destructive destination changes are never implicit recovery steps.
- Build, run, install, launch, terminate, log capture, and crash capture are
  structured actions bound to a run configuration; Octant stops only the
  process it owns and never kills by broad name.
- The Simulator is a first-class pane in the split-tree workspace with live
  frame, accessibility hierarchy, screenshot, recording, logs, and validation
  state. Users can attach a selected element's crop, accessibility identity,
  and location to the composer as a structured reference.
- Interaction is semantic first: inspect the accessibility tree, target stable
  identifiers and roles, re-inspect after changes, and use typed gestures.
  Computer use is the fallback with observe/control modes, application
  allowlists, scoped approval, sensitive-field protection, and a visible stop.
  A tap is never assumed successful because the input returned; the next
  snapshot, screenshot, log event, or assertion verifies it.
- Tests (Swift Testing, XCTest, focused targets and plans, UI automation,
  accessibility audits, repeat runs) produce structured verdicts and preserve
  `.xcresult` and log artifacts as evidence. Parsing failure keeps the raw
  artifact and reports the verdict incomplete. Restart reconciliation labels
  ambiguous work Waiting or Inconclusive, never Verified.
- Commands run within the selected Code Project and exact checkout under
  ordinary sandbox and approval policy; secrets are indirect references and
  are redacted from logs, artifacts, previews, and model context.
- Extensions may contribute optional Apple skills and adapters through the
  ordinary trust and enablement ladder; core discovery, Simulator control,
  build, run, test, and evidence remain available with every extension absent
  or disabled.
- The first release boundary is Simulator and local macOS development on
  Apple Silicon. Physical devices, signing, provisioning, TestFlight, App Store
  submission, and notarization are explicit later decisions.

## Consequences

- Any provider, including a local model, can build and validate Apple software
  through the same tools and produce the same evidence.
- Ownership and lease rules make parallel threads safe at the cost of
  explicit destination allocation.
- Structured actions are more work than a shell string but give discovery,
  progress, cancellation, and honest verdicts.
- Optional adapters can improve specific actions without becoming a
  dependency; if one fails, native tools remain.

## Related

- 0003 Product modes and authority
- 0009 Sandbox confinement, approvals, and Plan mode
- 0011 Extensions and skills activation ladder
- 0015 Workspace shell model
