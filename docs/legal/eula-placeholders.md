---
description: Draft governing-law and jurisdiction placeholders for a future Octant end-user license agreement.
---

# EULA placeholders

::: warning Draft pending legal review
This page holds **placeholders only** for a future end-user license
agreement. It is **not** an EULA, **not** terms of service, **not** legal
advice, and **not** a choice of law that anyone should rely on. Counsel must
select governing law, venue, and related clauses before any license text is
published or shipped with the product.
:::

## Why these fields exist

The GDPR package needs a place for governing law and jurisdiction once an
EULA ships. The technical preview does not yet publish a full license
agreement in this guide. Until counsel delivers that agreement, keep the
fields below as explicit blanks rather than inventing a forum.

Local-first architecture does not pick a court. The journal still sits on
the customer's host; these placeholders only matter for disputes about the
software license and any Octant-operated hosted component that later falls
under the [DPA template](https://github.com/Ogard-Labs/octant/blob/main/docs/legal/dpa-template.md).

## Placeholders

Copy these into the counsel-drafted EULA. The proposed values below mirror
the standard already published for Ogard Labs' other products (Norwegian law,
Stavanger venue, `hello@octant.sh`); counsel confirms or amends them before
any EULA ships, and replaces the remaining bracketed tokens.

```text
Governing law. This Agreement is governed by the laws of Norway,
excluding its conflict-of-law rules, except that mandatory
consumer-protection rules of the licensee's country of habitual residence
continue to apply where they cannot be waived.

Exclusive jurisdiction. The parties agree that Stavanger District Court
(Stavanger tingrett) is the agreed venue, subject to mandatory consumer
venue rights that cannot be waived and subject to any arbitration clause
counsel adds below.

Arbitration (optional). None.

Notices. Legal notices to Ogard Labs (organisation number 996 198 510,
Stavanger, Norway) go to hello@octant.sh.
Legal notices to the licensee go to the contact on file or, for software
used without an Octant account, to the contact the licensee provides when
making a claim.

Language. The controlling language of this Agreement is English; a
Norwegian translation is provided for convenience and does not control.
```

## Consumer and B2B forks

Counsel should decide whether one EULA covers both prosumer and small-team
use or whether B2B orders incorporate different venue rules. Do not silently
apply an exclusive business-court clause to consumers who retain mandatory
protections.

## Interaction with privacy drafts

- Controllership of the on-device journal is described in the
  [privacy notice](https://github.com/Ogard-Labs/octant-site/blob/main/docs/advanced/privacy-notice.md) and
  [DPA template](https://github.com/Ogard-Labs/octant/blob/main/docs/legal/dpa-template.md). Choice of law in the EULA does not
  move that journal into an Octant data center.
- Transfer tools for any future hosted processing sit in the
  [SCC position](https://github.com/Ogard-Labs/octant/blob/main/docs/legal/scc-position.md), not in these placeholders.
- BYO providers remain under the customer's contracts with those providers
  ([Sub-processors](https://github.com/Ogard-Labs/octant-site/blob/main/docs/advanced/sub-processors.md)).

## Next steps

- [DPA template](https://github.com/Ogard-Labs/octant/blob/main/docs/legal/dpa-template.md)
- [SCC position](https://github.com/Ogard-Labs/octant/blob/main/docs/legal/scc-position.md)
- [Privacy notice](https://github.com/Ogard-Labs/octant-site/blob/main/docs/advanced/privacy-notice.md)
- [Data residency](https://github.com/Ogard-Labs/octant-site/blob/main/docs/advanced/data-residency.md)
