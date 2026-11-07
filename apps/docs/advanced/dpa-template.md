---
description: Draft data processing agreement template for any future Octant-operated processing, grounded in local-first controllership of the on-device journal.
---

# DPA template

::: warning Draft pending legal review
This page is a **draft** template. It is **not** a signed data processing
agreement, **not** legal advice, and **not** a claim that Ogard Labs currently
processes personal data as a processor for customers. Qualified counsel must
review and complete every bracketed field before anyone treats this as an
executable contract.
:::

## When this template would apply

Octant is local-first software. The event journal, projections, threads,
memory, layouts, and credential references live on a host the customer
controls. For that on-device store:

- The **host owner** is the controller of personal data in the journal.
- Ogard Labs does **not** receive a copy of the journal, does not sync it to
  an Octant cloud, and does not operate a telemetry or analytics pipeline
  over customer content.
- Bring-your-own-key and bring-your-own-subscription providers process prompts
  under the customer's own contract with that provider. They are not Octant
  sub-processors. See [Sub-processors](/advanced/sub-processors).

A data processing agreement with Ogard Labs is therefore **not** the ordinary
document for single-machine use of the technical preview. This template
exists for the narrower case where Ogard Labs processes personal data
**on behalf of** a customer in connection with an Octant-operated hosted
component. The public Canvas share service (below) is that component and is
in the current release boundary, so this DPA is its instrument from launch;
hosted relay remains outside the release boundary. Until counsel signs it,
this page remains a draft, not a live contract.

A later shared-host design would still place controllership with the team
that runs the host, not with Ogard Labs by default. That design is not the
current preview.

### The first hosted component in the release scope: public Canvas links

The public Canvas share service (`https://canvas.octant.sh`, in the
`octant-webapp` repository) is the one Octant-operated component in the
current release boundary. It is off by default, and nothing reaches it
until a person turns Public links on and approves a publish. When it does:

- The **publisher stays controller** of the Canvas content they publish.
  The payload is a frozen, filtered copy: no host, Project, thread, or
  Canvas ids, no file contents, and a Canvas holding an action block is
  refused outright.
- **Ogard Labs operates the service**, stores the payload, and can read it
  to draw the page and link previews — so for that published content Ogard
  Labs is the **processor** acting on the publisher's documented
  instruction (the approved publish card), and this DPA is the instrument
  for it. Annex A below carries the service's current values; counsel
  confirms them at sign-off.
- The service is hosted in **Norway (EEA)** on Gigahost AS, with encrypted
  offsite backups on Hetzner in Finland (EU), so no transfer tool is needed
  while it stays EEA-hosted; see the [SCC position](/advanced/scc-position).
  Moving it outside the EEA/UK requires the controller-to-processor SCC
  module before that traffic starts.
- The service writes no IP or user-agent logs and keeps an aggregate view
  count; revoke, expiry, or deleting the Canvas deletes the content, with a
  content-free tombstone kept 90 days. See
  [Share a Canvas with a public link](/guide/public-links).

## Parties and roles

| Field                 | Value                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Controller (customer) | `[CUSTOMER LEGAL NAME]`                                                                                            |
| Controller contact    | `[CUSTOMER DPO / PRIVACY CONTACT]`                                                                                 |
| Processor             | Ogard Labs, organisation number 996 198 510, Stavanger, Norway (proposed; counsel confirms the contracting entity) |
| Processor contact     | `hello@octant.sh` (proposed; counsel confirms)                                                                     |
| Effective date        | `[YYYY-MM-DD]`                                                                                                     |
| Governing agreement   | `[MASTER AGREEMENT / ORDER / EULA REFERENCE]`                                                                      |

**Roles for the on-device journal.** Even when this DPA is in force for a
hosted component, the customer (or the named host-owner controller on a
shared host) remains controller of the journal that sits on infrastructure
they operate. This DPA does not transfer that controllership to Ogard Labs.

## Subject matter and duration

**Subject matter.** Processing of personal data that the customer submits to,
or that is generated in, an Octant-operated hosted component that counsel
has confirmed is in scope. The on-device journal is out of scope unless a
future product change makes Ogard Labs a processor of that store, which
current architecture does not.

**Nature and purpose.** Only the purposes listed in Annex A for that hosted
component. Do not invent analytics, product telemetry, model training, or
advertising uses. Octant does not ship those channels today.

**Duration.** From the effective date until the hosted component relationship
ends, plus any retention period counsel records in Annex A that is strictly
required for legal or security obligations.

## Categories of data and subjects

Complete only for personal data that actually enters the hosted component.

| Annex field              | Placeholder                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| Data subjects            | `[e.g. customer's staff, end users of customer's Projects]`                                    |
| Personal data categories | `[e.g. account identifiers, IP addresses seen by the hosted surface, support ticket contents]` |
| Special categories       | `[NONE, or counsel-approved description]`                                                      |
| Processing operations    | `[storage, transmission, support access; list only what the component does]`                   |

Do not list journal transcripts, Keychain secrets, or provider payloads as
Octant-processed categories unless the hosted component truly receives them.
In the technical preview those stay on the host or travel only to providers
the customer configured.

## Processor obligations (draft outline)

Counsel must turn this outline into operative clauses. The product facts
that constrain those clauses:

1. **Documented instructions.** Process only on documented customer
   instructions and applicable law. Refuse instructions that would invent
   telemetry or relocate the on-device journal into an Octant cloud.
2. **Confidentiality.** Persons authorized to process are bound to
   confidentiality.
3. **Security.** Apply measures appropriate to the hosted component's actual
   threat model. Owner-only host permissions and Keychain handling on the
   customer's machine remain the customer's responsibility for local data.
4. **Sub-processors.** Engage further processors only with prior notice and
   the customer's ability to object, under a written contract that imposes
   equivalent obligations. BYO providers the customer configures in Octant
   are not Ogard Labs sub-processors.
5. **Assistance.** Assist with data-subject requests, DPIAs, and breach
   notices to the extent the hosted component holds the relevant data.
   Thread export and purge on the customer's host remain host-authoritative
   product features; they are not performed by Ogard Labs against a cloud
   copy that does not exist.
6. **Deletion or return.** On end of the hosted service, delete or return
   personal data in that component as Annex A requires, and delete existing
   copies unless law requires retention.
7. **Audit.** Make available information necessary to demonstrate compliance
   with this DPA for the hosted component, under a reasonable audit
   procedure counsel defines.
8. **International transfers.** If the hosted component transfers personal
   data outside the EEA/UK, use a lawful transfer tool. See the
   [SCC position](/advanced/scc-position).

## Annex A: processing description

For the public Canvas share service (the one hosted component in the current
release scope), the current draft values are:

| Item                                          | Value                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted component name                         | Public Canvas share service (`https://canvas.octant.sh`; self-hosted URLs are the customer's own deployment, not an Ogard Labs component)                                                                                                                                                                                                                                      |
| Processing purposes                           | Store, serve, draw, and link-preview Canvas share documents the publisher approved; honour update, revoke, expiry, password, and abuse-report requests; count aggregate views                                                                                                                                                                                                  |
| Retention                                     | Until the link expires (default 30 days, at most 365, or no expiry if the publisher chooses it) or is revoked/deleted; then a content-free tombstone (id and time) for 90 days                                                                                                                                                                                                 |
| Sub-processors (Ogard Labs)                   | Gigahost AS — server hosting in Norway (EEA); Hetzner Online GmbH — encrypted offsite backups in Finland (EU)                                                                                                                                                                                                                                                                  |
| Transfer tools                                | None while hosted in the EEA. If the service is ever moved outside the EEA/UK or a third-country sub-processor is added, execute the matching SCC module before that processing starts (see [SCC position](/advanced/scc-position))                                                                                                                                            |
| Technical and organizational measures summary | TLS in front of two origins that must differ (public API/viewer and user-content frames); viewer CSP with no third-party loads; `noindex`, `no-referrer`; strict contract decoding; payload size caps; per-IP in-memory rate limits with no IP/user-agent logs; owner secret and password stored only as hashes; operator takedown via a loopback listener with a bearer token |

For any later hosted component, replace these rows with that component's real
values — `[NAME]`, `[LIST]`, `[DURATION / TRIGGER]`, `[LIST OR NONE]`,
`[SCC MODULES / ADEQUACY / NONE]`, `[POINTER TO SECURITY EXHIBIT]` — or write
`NONE: DPA NOT IN FORCE` when no such component exists.

## Annex B: relationship to local-first software

This annex is part of the draft so counsel does not have to rediscover the
architecture.

- Customer installs and runs Octant on a machine or headless host they
  control.
- The authoritative store is that host's event journal. Projections rebuild
  from it. There is no Octant-operated replica of that journal in the
  preview.
- Provider credentials are OS-held secrets on that host. They are not
  delivered to Ogard Labs.
- Network traffic Octant originates without a provider turn is limited to
  update checks, marketplace fetches the user initiates, and optional
  profile image lookup. Those paths are described in the
  [privacy notice](/advanced/privacy-notice). Whether any of them is
  "processing under this DPA" is for counsel; this template does not
  auto-include them.

## Next steps

- [SCC position](/advanced/scc-position) for transfers on BYO vs hosted surfaces
- [EULA placeholders](/advanced/eula-placeholders) for governing law and venue
- [Sub-processors](/advanced/sub-processors) for BYO provider relationships
- [Privacy notice](/advanced/privacy-notice) for what the host actually stores
