# Release-boundary holds: connector marketplace and full LSP

This note restates two holds already named by the Current Release Boundary in
`AGENTS.md`. It does not authorize implementation. Opening either item still
needs its own decision records, published seams, and an explicit maintainer
request.

The first release remains the Apple Silicon technical preview with the
provider-neutral plugin and skill marketplace (see also
[architecture Current Release Boundary](architecture.md#current-release-boundary)
and [roadmap Later](roadmap.md#later)). Cross-platform desktop sequencing lives
in [0058](decisions/0058-cross-platform-desktop.md) and does not reopen these
holds.

## Connector / OAuth marketplace

**Hold.** Catalogued third-party connectors with OAuth, revocation, publisher
trust, and outbound data boundaries stay Later. That is larger than distributing
plugins and skills. A first-party Integration plugin (Linear through the
Integration kind) is not a connector marketplace; [0001](decisions/0001-plugin-architecture.md)
already draws that line, and [0026](decisions/0026-shipping-to-a-user-owned-target.md)
keeps ship integrations on the same plugin seams without opening a marketplace.

**Start gates.** Work may leave Backlog only when all of the following are true:

1. Accepted or Proposed decision records cover OAuth and token revocation,
   publisher trust, what data may leave the host, and how a connector catalog
   relates to the existing plugin and skill marketplace without collapsing
   install, trust, and enablement ([0011](decisions/0011-extensions-activation-ladder.md)).
2. Connectors reach the system only through published seams
   (`@octant/plugin-api`, `@octant/plugin-host`, Integration kind) and the
   credential broker ([0054](decisions/0054-headless-host-credential-store.md)).
   No connector may widen a host shortcut a third-party plugin could not take.
3. An explicit maintainer request authorizes the scoped work against those
   records.

## Full LSP / extension host / debugger

**Hold.** A full language-server stack, IDE-style extension host, and debugger
companion stay Later. Monaco editing and explicit external-editor handoff remain
primary for Code.

**Start gates.** Work may leave Backlog only when all of the following are true:

1. Accepted or Proposed decision records cover the companion process model
   (separately launched, not an in-process Monaco expansion), how LSP and debug
   children sit under Code Project and thread authority
   ([0003](decisions/0003-product-modes-and-authority.md),
   [0009](decisions/0009-sandbox-confinement-and-approvals.md)), and whether any
   language-tooling extension model is the existing plugin ladder or a distinct
   host ([0001](decisions/0001-plugin-architecture.md),
   [0011](decisions/0011-extensions-activation-ladder.md)).
2. Language services and debugger actions cannot escalate mode, Project, or thread
   authority, and they take no path around sandbox and approval policy.
3. An explicit maintainer request authorizes the scoped work against those
   records.
