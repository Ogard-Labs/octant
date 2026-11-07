# Legal drafts

Draft legal and privacy positions for counsel review. They are **not**
published notices, signed agreements, or certifications of GDPR compliance.

## User-facing privacy drafts (published in the guide, with draft banners)

These live with the product docs at `apps/docs/advanced/` because they describe
current product behavior for operators:

- [`privacy-notice.md`](../../apps/docs/advanced/privacy-notice.md) — what data exists, where it lives, what leaves the machine, and the export and purge rights that ship
- [`privacy-and-security.md`](../../apps/docs/advanced/privacy-and-security.md) — the operational security model: storage, credentials, approvals, confinement, host-initiated network
- [`sub-processors.md`](../../apps/docs/advanced/sub-processors.md) — BYO providers are the user's processors, not Octant's
- [`data-residency.md`](../../apps/docs/advanced/data-residency.md) — the host is the region

## Drafts in this directory (not published until counsel signs off)

| Draft                                                         | Topic                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Shared-host controller footing](./shared-host-controller.md) | When one host holds several principals' data: who is controller for the journal, logs, and audit export; alignment with collaboration design; shipped export and purge surfaces |
| [DPA template](./dpa-template.md)                             | **Not in force** stub: no Ogard-operated hosted component exists; what would trigger a DPA if one ever ships                                                                    |
| [SCC position](./scc-position.md)                             | **No SCCs exist** stub: BYO and the self-hosted share service are the customer's own relationships; what would trigger transfer tools                                           |
| [EULA placeholders](./eula-placeholders.md)                   | Governing-law and venue blanks for the EULA counsel will deliver — the one live contract deliverable                                                                            |

## Standard values drafted from the existing Ogard Labs setup

- **Licensor entity:** Ogard Labs, organisation number 996 198 510,
  Stavanger, Norway; contact `hello@octant.sh`. Ogard Labs licenses the
  software; it operates **no** share or hosting service for Octant content.
- **Public Canvas share service:** there is no Ogard-operated instance. The
  reference app lives in this repository at `apps/share` and each user runs it
  on their own host (or uses another service they choose). The privacy notice,
  public-links guide, sub-processors, data residency, and SCC position all
  describe that user-operated model; the DPA template is not in force.
- **EULA proposal:** Norwegian law, Stavanger District Court as agreed
  venue, no arbitration, notices to `hello@octant.sh`, English controlling
  (mirrors the terms already published for Ogard Labs' other products).

## Remaining counsel decisions

- **EULA placeholders:** confirm or amend the proposed values (Norwegian law,
  Stavanger venue, `hello@octant.sh`, English controlling) and deliver the
  full license text for the preview.
- **DPA template:** dormant — no Ogard-operated hosted component exists, so no
  DPA is in force. Revisit only if a future hosted component ships.
- **Update-check default:** changed to off-by-default (a store that never
  recorded the preference decodes to off); the privacy notice and installation
  guide describe the new default.
- **Shared-host controller footing:** confirm or rewrite the default
  "host owner is controller" sentence, and decide the joint-controller and
  processor forms a recorded controller fact needs.

## Rules for edits

- Mark every page as draft pending legal review.
- Ground claims in shipped behavior and accepted or proposed decision records.
- Do not put tracker identifiers in these files.
- Do not present a draft as a published notice or as legal advice.
