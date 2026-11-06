# Legal drafts

Draft legal and privacy positions for counsel review. They are **not**
published notices, signed agreements, or certifications of GDPR compliance.

## User-facing privacy drafts

These live with the product docs because they describe current product
behavior for operators:

- [`apps/docs/advanced/privacy-notice.md`](../../apps/docs/advanced/privacy-notice.md) — what data exists, where it lives, what leaves the machine, and the export and purge rights that ship
- [`apps/docs/advanced/privacy-and-security.md`](../../apps/docs/advanced/privacy-and-security.md) — the operational security model: storage, credentials, approvals, confinement, host-initiated network
- [`apps/docs/advanced/sub-processors.md`](../../apps/docs/advanced/sub-processors.md) — BYO providers are the user's processors, not Octant's
- [`apps/docs/advanced/data-residency.md`](../../apps/docs/advanced/data-residency.md) — the host is the region
- [`apps/docs/advanced/dpa-template.md`](../../apps/docs/advanced/dpa-template.md) — processor clauses for an Octant-operated hosted component
- [`apps/docs/advanced/scc-position.md`](../../apps/docs/advanced/scc-position.md) — transfer posture on BYO vs Octant-operated surfaces
- [`apps/docs/advanced/eula-placeholders.md`](../../apps/docs/advanced/eula-placeholders.md) — governing-law and venue blanks for a future EULA

This directory holds positions that need a quiet home away from those
concurrent user-guide edits, or that counsel will review before any
VitePress publication.

## Drafts in this directory

| Draft                                                         | Topic                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Shared-host controller footing](./shared-host-controller.md) | When one host holds several principals' data: who is controller for the journal, logs, and audit export; alignment with collaboration design; shipped export and purge surfaces |

## Standard values drafted from the existing Ogard Labs setup

These are filled into the drafts from the infrastructure and legal baseline
Ogard Labs already operates (prod01 on Gigahost AS in Norway, encrypted
offsite backups on Hetzner in Finland, entity registered in Stavanger):

- **Controller/operator entity:** Ogard Labs, organisation number
  996 198 510, Stavanger, Norway; contact `hello@octant.sh`.
- **Public Canvas share service hosting:** Norway (EEA) on Gigahost AS,
  backups in Finland (EU) — no restricted transfer while EEA-hosted, so no
  SCC today; the controller-to-processor module is required before any move
  outside the EEA/UK. Filled in the privacy notice, public-links guide,
  sub-processors, data residency, DPA Annex A, and SCC position.
- **EULA proposal:** Norwegian law, Stavanger District Court as agreed
  venue, no arbitration, notices to `hello@octant.sh`, English controlling
  (mirrors the terms already published for Ogard Labs' other products).

## Open items before any of these publish

- **Counsel sign-off** on every drafted value above; nothing here is a
  published notice yet, and the service itself does not go live in this
  change.
- **DPA template:** the remaining customer-side brackets — customer legal
  name and contact, effective date, governing agreement.
- **Update-check default:** changed to off-by-default (a store that never
  recorded the preference decodes to off) in the companion branch
  `fix/update-checks-default-off`; the privacy notice and installation guide
  describe the new default there.
- **Shared-host controller footing:** confirm or rewrite the default
  "host owner is controller" sentence, and decide the joint-controller and
  processor forms a recorded controller fact needs.

## Rules for edits

- Mark every page as draft pending legal review.
- Ground claims in shipped behavior and accepted or proposed decision records.
- Do not put tracker identifiers in these files.
- Do not present a draft as a published notice or as legal advice.
