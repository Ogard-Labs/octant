# 0026. Shipping to a user-owned target

**Status:** Accepted

## Context

Octant can take a project from nothing to a reviewed, merged change. It cannot
put the result anywhere. The last step — publish this site, push this container,
submit this build — is the one the person leaves the tool to do, and it is the
step where the temptation to add hosted infrastructure is strongest.

That temptation is the thing to refuse. A hosted deploy relay would mean
Octant holding credentials for services it does not own, proxying artifacts on
the user's behalf, and becoming an outage in someone else's release. It would
also invert the product: a local-first workspace whose most valuable step runs
on someone else's machine.

Deploy integrations are outside the first release boundary. This record states
the shape so the credential broker, plugin seams, and approval machinery already
in the repository compose into it later rather than being widened for it.

## Decision

- **Every target is user-owned.** Octant ships to an account, cluster, registry,
  or store the person already has. Octant operates no deployment infrastructure,
  holds no service accounts, and offers no target of its own. There is no
  fallback target and no "Octant-hosted" option to fall back to.
- **There is no hosted relay.** Bytes go from the user's machine to the user's
  target. Nothing routes through infrastructure Octant runs, and a target that
  can only be reached through such a relay is not a target Octant supports.
- **A ship path is a plugin, not a core feature.** Targets arrive as marketplace
  integrations through the published seams (`@octant/plugin-api`,
  `@octant/plugin-host`), taking no shortcut a third-party plugin could not
  take. Shipping one in-tree is allowed; wiring one into server internals, or
  widening a seam for one vendor, is not.
- **Credentials stay behind the broker.** A ship integration never receives a
  secret. It names a credential reference; the host resolves it through the
  existing credential broker at the moment of use and hands the integration a
  bounded, purpose-scoped handle. A plugin that asks for the value itself is
  refused, and a stored credential is revocable and purgeable through the same
  path provider credentials already are.
- **Shipping is its own approval class**, not a variation on push. It is
  outward-facing and frequently irreversible: it makes something visible to
  people who are not in the room, and no local checkpoint undoes that. It is
  therefore approved per act, names the target it is about to reach, and is
  never covered by a standing grant given for repository writes.
- **A ship is refused on unproven work.** The host states what it is about to
  publish — the revision, the artifact, and the target — and refuses when the
  revision is not the one reviewed, the checkout is dirty, or the artifact was
  not produced by a run the host can point at. The same evidence rule that ends
  a goal applies here: a ship claims a build happened only when the host
  observed it.
- **Installing a ship integration grants nothing.** Discovery, install, trust,
  enablement, and credential binding stay four separate decisions, exactly as
  0011 requires. An installed target reaches nothing until a person has bound a
  credential to it and approved an act.
- **Every ship is journaled** with its target, revision, artifact digest, and
  approval, so what was published and by whose decision is answerable after the
  fact rather than reconstructed from a provider's transcript.

## Consequences

- Octant stays a workspace rather than a platform: no accounts to run, no
  artifacts to store, no relay to keep up, and no credential of a user's that it
  is holding on their behalf.
- Coverage is bounded by what plugins exist. That is the accepted cost of the
  seam rule — a target nobody has written an integration for is not reachable,
  and the answer is to write one, not to special-case it in the server.
- Per-act approval will feel repetitive for someone deploying often. That is
  deliberate: the alternative is a standing grant that publishes without asking,
  which is the failure this record exists to prevent.
- Requiring the host to have observed the build means a hand-made artifact
  cannot be shipped through this path. Shipping it is an ordinary terminal
  command the person runs themselves, with no claim from Octant about it.
- The target model, the per-act approval rule, the evidence rule, the
  credential-handle boundary, the `publish-to-target` approval class, and the
  journaled receipt for every outcome are implemented, and one destination kind
  exists: a branch on a Git remote the user already has. Two of the facts a
  publication rests on are not yet observable by the host — the build it watched
  being produced, and a per-act approval receipt — so a publication is **refused
  until they are**. That is the evidence rule working rather than a gap papered
  over: a host that cannot prove a build happened must not claim one did.
  Connector/OAuth marketplace work stays outside the first release boundary.

## Related

- 0001 Plugin architecture
- 0009 Sandbox confinement, approvals, and Plan mode
- 0011 Extensions and skills: the activation ladder
- 0023 Bringing a run home
- 0044 The dock hosts live thread-owned tools
