# 0062. Simulator frame input rides the Apple workbench channel

**Status:** Accepted

## Context

The live Simulator frame in the thread-aware dock (0043) shows host-held
screenshot evidence with honest setup, unavailable, booting, live,
interrupted, and stale-after-restart states. Remote, Linux, and headless
clients report `not-attachable` when
`liveSimulatorFrameSupported` is absent. The frame shipped without tap,
typed text, or hardware keys.

Input could mean a desktop-local, XCTest-less injector (simctl IO or
equivalent HID posting) that pokes the booted Simulator outside Apple
toolchain RPC. Or it could extend the workbench control channel that
already carries boot, shutdown, terminate, logs, and screenshot as
structured `AppleSimulatorRequest` actions for both the pane and the
`octant_apple` tool.

A side channel would break the invariants 0014 still owns after 0043 took
placement: one app-managed Apple tool, the same request for agent and user,
authority before side effects, and evidence that survives restart. Computer
use already journals `requestedBy: EventActor` so a local click is never
confused with an agent petition (0053 destination rules; contracts in
`computerUse.ts`).

## Decision

- **Transport is the Apple workbench control channel.** New structured
  Simulator input kinds join `AppleSimulatorActionKind` (and the matching
  workbench intents / `octant_apple` operations): tap or click, type text,
  and hardware key. The renderer posts requests; it never opens a Simulator
  IO pipe, posts HID events, or shells out to `simctl`. The host adapter
  behind `appleToolchainService` may use XCTest-less injection (`simctl`
  IO, Simulator-native input helpers, or a reviewed optional adapter) to
  execute those kinds. That adapter is an implementation detail of the
  channel, not a second path.
- **Reject a parallel host-only injector** that the dock could call while
  agents keep using tools, or that desktop could run while remote clients
  invent a different story. One request shape, one approval gate, one
  evidence record.
- **Tap, text, and keys are destination effects**, not observations.
  They follow ordinary Code approval like boot and shutdown. Screenshot and
  other reads stay approval-free. Prefer semantic targets (accessibility
  identifier or role) when the request carries one; coordinate taps are
  allowed when the live frame supplies them and no stable target is named.
  Darwin's default Accessibility fallback offsets those pixels from the
  Simulator window origin; it does not account for chrome or mismatched
  frame/window scale. Hosts that need accurate mapping supply
  `injectSimulatorInput`. Success is never assumed from a void return; the
  next screenshot, log, or assertion verifies, as 0014 already requires.
- **Renderer chrome is semantic accessibility for Octant controls**, not
  the Simulator's accessibility tree. Frame status, captions, and input
  affordances are labelled and keyboard-reachable in the web surface. The
  Simulator a11y hierarchy remains a separate structured read when that
  capability ships; this record does not add it.
- **Actor attribution matches computer use.** Every journaled input names
  `EventActor`: pane-driven input is `local-user` (or `remote-device` when a
  paired client is later allowed to petition); tool-driven input is `agent`
  with provider instance and thread. Authority and checkout binding stay on
  `ToolActionAuthority` as today. Different actors, same action kinds.
- **Remote and headless clients fail closed exactly as the live frame
  does.** Interactive input is offered only when the frame would be
  `attachable` and `live` on Darwin desktop. Otherwise the surface stays
  unavailable or read-only; no forged controls, no hanging injectors.

Non-goals: XCTest UI test runners as the input path, physical devices,
streaming video input, and computer-use takeover of the Simulator pane.

## Consequences

- Implementation is a contracts + domain + toolchain-service extension of
  the workbench channel, plus renderer affordances gated on attachability.
  No new desktop IPC family for Simulator HID.
- Agents and humans share one audit story. Attribution bugs show up as
  wrong `EventActor` kind, not as a missing side channel.
- 0014's interaction preference (semantic first, computer use as fallback)
  still stands; this record only names the control-plane transport for
  Simulator input. 0043's placement and fail-closed attach rules are
  unchanged.
- **Typed text never lands in durable evidence verbatim.** Input requests may
  carry text for execution; journaled `ValidationEvidenceRecord.detail` and
  diagnostic mirrors must exclude typed content and secure-field values, or
  store only redacted length/class markers with `redacted: true`. Post-input
  screenshots and assertion payloads that would show typed or secure-field
  values must mask, crop, or omit those regions before persistence — raw PNG
  bytes are not an exception to the redaction rule.
- **Completed input actions are not re-executed on retry.** A finished
  `actionId` returns the recorded evidence without repeating the tap, type, or
  hardware-key effect. Interrupted or unknown-after-restart actions refuse
  with a distinct status so callers must re-issue a new `actionId`. Tests must
  cover timeout and host-restart cases that would otherwise duplicate
  Simulator effects.

## Related

- 0014 Apple development destination and interaction rules
- 0043 Simulator follows the active thread
- 0053 Computer-use destinations and fail-closed hosts
