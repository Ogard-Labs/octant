# DPA template

**Status: not in force — draft stub pending legal review.** Not legal advice, not a
signed agreement, not a claim that Ogard Labs processes personal data on anyone's
behalf.

## Why there is no DPA today

Ogard Labs operates **no** hosted component for Octant content: no share-service
instance, no relay, no cloud store. The event journal and all workspace data stay
on the host the customer controls; the public Canvas share service is self-hosted
by each user (reference app at `apps/share` in this repository), and BYO providers
process under the customer's own contract with them. There is no processing by
Ogard Labs on a customer's behalf, so no data processing agreement exists to sign.

## What would trigger one

Only an Ogard Labs-operated hosted component that processes personal data on a
customer's behalf — for example a hosted share-service instance Ogard Labs itself
ran. That is outside the current release boundary. If it ever ships, draft the DPA
then, with counsel, from the facts of that component: parties, subject matter,
duration, Annex A processing description, sub-processors, transfer tools, and the
operative clauses (instructions, confidentiality, security, assistance, incidents,
audit, deletion/return). Do not reuse this stub as a contract.

## Related

- [Shared-host controller footing](./shared-host-controller.md) — who is
  controller when a team shares one host
- [EULA placeholders](./eula-placeholders.md) — the license terms that do ship
- [Privacy notice](../apps/docs/advanced/privacy-notice.md) — what the product
  actually does with data
