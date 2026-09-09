# 0100. Task authority confirmations use a trusted inline surface

**Status:** Accepted

## Context

A separate native confirmation obscures the conversation and exposes internal
identifiers before the action the person must decide. Moving Full access into
ordinary renderer-controlled HTML would remove an existing trust boundary:
that renderer can request a desktop challenge but cannot confirm it itself.

## Decision

- Octant-owned task confirmations appear beside the owning composer, revealing
  upward from behind its message surface without dimming the application.
  The action and scope lead; identifiers and effect/context digests remain
  available in a details disclosure. System-owned permission dialogs remain
  system dialogs.
- Desktop authority confirmations use an isolated, sandboxed approval view
  owned by the main process. Its static content has a restrictive CSP, no
  external resources or navigation, and a dedicated preload without the
  ordinary host bridge or desktop secret.
- Only the exact live approval view may decide its challenge. Main validates
  sender, challenge, per-view token, owning window/capability, and requesting
  thread or draft Project. Receipt issuance remains on the existing desktop
  challenge/confirmation routes, with server-side context and effect checks.
- The ordinary renderer may report bounded composer geometry or cancel. It
  receives neither confirmation authority nor a general approval endpoint.
  Background requests cannot appear over an unrelated task's composer.
- Cancel is the default. Enter never grants authority. Expiry, cancellation,
  owner teardown, missing valid anchor, and late or duplicate decisions fail
  closed. No hidden or stale view can issue a receipt.
- Non-authority notices may use the ordinary shared composer notice slot.
  They do not gain access to the trusted approval view's decision channel.
- Existing provider and app-tool approvals retain their server-authoritative
  request/answer semantics while adopting the same composer placement. The
  presentation does not widen mode, Project, filesystem, network, or browser
  authority.

## Consequences

A task keeps its conversation visible while a person decides. Desktop receipts
retain an independent confirmation surface instead of becoming renderer-owned.
Native and rendered verification must cover existing threads, new-task drafts,
split-pane ownership, narrow layouts, keyboard cancellation, and teardown.

This extends 0009's presentation without weakening its authority and taint
requirements. It does not turn OS permission prompts into app controls.
