# Release-boundary holds and the post-preview unlock

This note keeps the start gates for two deferrals once named by the
[Current Release Boundary in `AGENTS.md`](../AGENTS.md#current-release-boundary),
which is the one statement of release scope. Both holds are lifted; the gates
stay as the record of what each track must satisfy.

## Post-preview tracks authorized on 2026-10-26

The maintainer unlocked the previously parked tracks on 2026-10-26: mobile
maturity (Android internal builds, redacted push, capture and voice, public
store distribution), a ciphertext-only hosted relay, a full LSP / extension
host / debugger companion, enterprise directory OAuth and
cloud-IAM provider identity, disposable Linux desktops for headless hosts,
remote SSH development environments, third-party provider-driver plugins, and
the EU/GDPR compliance package (pending legal review).

They are authorized post-preview work, not part of the technical preview, and
design-first: each is built only once its owning specification documents its
authority, privacy, and release boundaries. The authorization covers design
and implementation. Creating an account, spending money, submitting to a
store, deploying a hosted service, or weakening any invariant each still needs
a separate explicit maintainer action. The
[architecture's release boundary](architecture.md#current-release-boundary)
owns the rule.

## Connector / OAuth marketplace

**Lifted on 2026-10-20.** The maintainer authorized connectors, and the
architecture's [Connectors and user-added MCP servers](architecture.md#extensions-and-skills)
rules now document the design: every connector is a user-added MCP server
package under the activation ladder, secrets live only in the credential
broker's own namespace, sign-in follows the MCP authorization flow with
revocation on sign-out, the catalog is bundled first-party data naming only a
vendor's own address, and nothing is imported, trusted or enabled without the
person's click. The gates below were the conditions; they are kept as the
record of what had to be true.

**Historical hold.** Catalogued third-party connectors with OAuth, revocation, publisher
trust, and outbound data boundaries stayed Later. That is larger than distributing
plugins and skills. A first-party Integration plugin (Linear through the
Integration kind) is not a connector marketplace; [0001](decisions/0001-plugin-architecture.md)
already draws that line, and [0026](decisions/0026-shipping-to-a-user-owned-target.md)
keeps ship integrations on the same plugin seams without opening a marketplace.

**Start gates.** Work could leave Backlog only when all of the following were true:

1. Current specifications document the approved design for OAuth and token revocation,
   publisher trust, what data may leave the host, and how a connector catalog
   relates to the existing plugin and skill marketplace without collapsing
   install, trust, and enablement ([0011](decisions/0011-extensions-activation-ladder.md)).
2. Connectors reach the system only through published seams
   (`@octant/plugin-api`, `@octant/plugin-host`, Integration kind) and the
   credential broker ([0054](decisions/0054-headless-host-credential-store.md)).
   No connector may widen a host shortcut a third-party plugin could not take.
3. An explicit maintainer request authorizes the scoped work against that
   design.

## Full LSP / extension host / debugger

**Authorized post-preview on 2026-10-26; design accepted.** The maintainer
request the third gate below asked for has been given, and the maintainer
accepted [Language services](design/language-services.md) on 2026-10-26, which
documents gates 1 and 2; its slices may start. Monaco editing and explicit
external-editor handoff remain primary for Code in the technical preview.

**Historical hold.** A full language-server stack, IDE-style extension host,
and debugger companion stayed Later.

**Start gates.** Work could leave Backlog only when all of the following were true:

1. Current specifications document the approved design for the companion process model
   (separately launched, not an in-process Monaco expansion), how LSP and debug
   children sit under Code Project and thread authority
   ([0003](decisions/0003-product-modes-and-authority.md),
   [0009](decisions/0009-sandbox-confinement-and-approvals.md)), and whether any
   language-tooling extension model is the existing plugin ladder or a distinct
   host ([0001](decisions/0001-plugin-architecture.md),
   [0011](decisions/0011-extensions-activation-ladder.md)).
2. Language services and debugger actions cannot escalate mode, Project, or thread
   authority, and they take no path around sandbox and approval policy.
3. An explicit maintainer request authorizes the scoped work against that
   design.
