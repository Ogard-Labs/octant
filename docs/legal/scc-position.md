# SCC position

**Status: no SCCs exist — draft stub pending legal review.** Not executed
Standard Contractual Clauses, not legal advice, not a determination that a
restricted transfer exists.

## The position

No transfer tool from Ogard Labs is needed today, because Ogard Labs operates no
hosted component and receives no Octant content:

- The on-device journal never leaves the customer's host through an Octant
  channel — residency is the machine's location
  ([data residency](https://github.com/Ogard-Labs/octant-site/blob/main/docs/advanced/data-residency.md)).
- BYO provider turns go from the customer's host to the provider the customer
  configured, under the customer's own contract; any SCCs are between the
  customer and that provider, not Ogard Labs
  ([sub-processors](https://github.com/Ogard-Labs/octant-site/blob/main/docs/advanced/sub-processors.md)).
- A Canvas published as a public link goes to a share service the user runs or
  chooses — the reference app at `apps/share`, self-hosted — so the operator is
  that user or third party, not Ogard Labs.
- The remaining host-originated calls (update checks to `octant.sh`, which
  redirects to GitHub; marketplace fetches to npm/skills.sh/GitHub; an optional
  Gravatar lookup) are user-initiated and carry only request metadata, not
  journal content. Whether they need transfer wording or a DPF reliance noted in
  the privacy notice is counsel's call
  ([privacy notice](https://github.com/Ogard-Labs/octant-site/blob/main/docs/advanced/privacy-notice.md)).

## What would trigger an SCC

An Ogard Labs-operated hosted component that moves personal data from the EEA/UK
to a third country without adequacy. Outside the current release boundary; if it
ever ships, execute the module matching the roles (controller-to-processor,
processor-to-processor) before that traffic starts, with a transfer impact
assessment, and record it here.

## Related

- [DPA stub](./dpa-template.md) — not in force
- [EULA placeholders](./eula-placeholders.md)
- [Privacy notice](https://github.com/Ogard-Labs/octant-site/blob/main/docs/advanced/privacy-notice.md)
