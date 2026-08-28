# Legal drafts

Draft legal and privacy positions for counsel review. They are **not**
published notices, signed agreements, or certifications of GDPR compliance.

## User-facing privacy drafts

These live with the product docs because they describe current product
behavior for operators:

- [`apps/docs/advanced/privacy-notice.md`](../../apps/docs/advanced/privacy-notice.md)
- [`apps/docs/advanced/sub-processors.md`](../../apps/docs/advanced/sub-processors.md)
- [`apps/docs/advanced/data-residency.md`](../../apps/docs/advanced/data-residency.md)
- [`apps/docs/advanced/privacy-and-security.md`](../../apps/docs/advanced/privacy-and-security.md)

Sibling GDPR package drafts under `apps/docs/advanced/` (for example a DPA
template, SCC position, or EULA placeholders) belong with that set once they
land. This directory holds positions that need a quiet home away from those
concurrent user-guide edits, or that counsel will review before any
VitePress publication.

## Drafts in this directory

| Draft | Topic |
| ----- | ----- |
| [Shared-host controller footing](./shared-host-controller.md) | When one host holds several principals' data: who is controller for the journal, logs, and audit export; alignment with collaboration design; shipped export and purge surfaces |

## Rules for edits

- Mark every page as draft pending legal review.
- Ground claims in shipped behavior and accepted or proposed decision records.
- Do not put tracker identifiers in these files.
- Do not present a draft as a published notice or as legal advice.
