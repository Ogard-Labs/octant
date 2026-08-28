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
under the [DPA template](/advanced/dpa-template).

## Placeholders

Copy these into the counsel-drafted EULA. Replace every bracketed token.

```text
Governing law. This Agreement is governed by the laws of
[GOVERNING LAW JURISDICTION, e.g. COUNTRY / STATE], excluding its
conflict-of-law rules, except that mandatory consumer-protection rules of
the licensee's country of habitual residence continue to apply where they
cannot be waived.

Exclusive jurisdiction. The courts of [VENUE, CITY / COURTS]
have exclusive jurisdiction over disputes arising out of or relating to
this Agreement, subject to mandatory consumer venue rights that cannot be
waived and subject to any arbitration clause counsel adds below.

Arbitration (optional). [ARBITRATION RULES / SEAT / LANGUAGE, or "None"].

Notices. Legal notices to Ogard Labs go to [LEGAL NOTICE ADDRESS / EMAIL].
Legal notices to the licensee go to the contact on file or, for software
used without an Octant account, to the contact the licensee provides when
making a claim.

Language. The controlling language of this Agreement is [LANGUAGE].
```

## Consumer and B2B forks

Counsel should decide whether one EULA covers both prosumer and small-team
use or whether B2B orders incorporate different venue rules. Do not silently
apply an exclusive business-court clause to consumers who retain mandatory
protections.

## Interaction with privacy drafts

- Controllership of the on-device journal is described in the
  [privacy notice](/advanced/privacy-notice) and
  [DPA template](/advanced/dpa-template). Choice of law in the EULA does not
  move that journal into an Octant data center.
- Transfer tools for any future hosted processing sit in the
  [SCC position](/advanced/scc-position), not in these placeholders.
- BYO providers remain under the customer's contracts with those providers
  ([Sub-processors](/advanced/sub-processors)).

## Next steps

- [DPA template](/advanced/dpa-template)
- [SCC position](/advanced/scc-position)
- [Privacy notice](/advanced/privacy-notice)
- [Data residency](/advanced/data-residency)
