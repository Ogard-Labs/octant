# 0053. Computer-use destinations

**Status:** Proposed

## Context

Computer use today is a macOS Accessibility adapter that throws if the host is
not Darwin. A headless Linux host can build software and never see it run.
0014 defined destination identity, ownership, leases, structured actions, and
host-held evidence for Simulators and the local Mac. 0043 later superseded
0014's workbench placement, not those destination rules. 0031 already offers a
host only for capabilities it reports. 0009 already requires computer-use
allowlists, session expiry, a visible stop, and process ownership. 0048's
execution capsules isolate Code work; they are not a screen.

Folding a disposable Linux desktop into Station or capsule machinery would mix
a graphical destination with a confinement boundary. Treating computer use as
"the Mac" would keep Linux hosts throwing or hanging instead of refusing.

## Decision

- A **computer-use destination** is a screen with stable identity and an
  exclusive owner or lease. Concurrent threads cannot reset or take over one
  another workflow owns. These are 0014's destination rules applied beyond
  Apple-local surfaces; 0043 remains the Simulator placement decision.
- Destination kinds are bound to host capability. The local Mac is one kind.
  A future disposable Linux desktop is another, leased by one thread from a
  Project recipe, holding no host credentials and no checkout. It is not a
  Station and not an execution capsule (0048).
- **"Is there a screen" is host capability reporting. "How do I click" is an
  adapter.** The runtime's observe / execute / cleanup seam stays. Policy,
  approvals, sensitive-field protection, and evidence sit above it. A host
  with no computer-use destination reports the capability **absent** and
  **refuses** actions as a value (`status` / `kind`: refused, failed, or
  unavailable). "No provider configured" is a value, not a throw.
- Providers sit behind a plugin-shaped seam. E2B may later ship in-tree as
  the first disposable-desktop provider; wiring a vendor into server internals
  is not allowed. A core capability must not require a specific vendor.
  Shipping a provider SDK with the host is a capability, not installing a
  runtime on the user's machine; provisioning still needs the user's key and
  explicit opt-in.
- A Desktop pane, if added, is one more 0015 pane kind. This record does not
  add it.

## Consequences

- Non-macOS hosts fail closed until a destination exists, instead of throwing
  inside the macOS adapter or hanging on a missing screen.
- Later lease acquire/release and a live Desktop pane are separate changes.
  Cost and duration stay user-visible; `maxSessionDurationMs` already caps a
  session.
- 0015's layout aggregate can host a Desktop pane later without a new
  architecture. 0010 remains the read-only preview model; a live desktop is
  an interactive surface like a terminal.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0014 Apple development destination mechanics (superseded for placement by 0043)
- 0015 Workspace shell model
- 0031 Hosts as environments
- 0043 Simulator follows the active thread
- 0048 Linux Stations and execution capsules
