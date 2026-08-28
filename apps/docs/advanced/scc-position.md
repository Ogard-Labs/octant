---
description: Draft Standard Contractual Clauses position for BYO-key use versus any Octant-operated hosted surface.
---

# SCC position

::: warning Draft pending legal review
This page is a **draft** transfer position. It is **not** executed Standard
Contractual Clauses, **not** legal advice, and **not** a determination that a
restricted transfer exists. Counsel must decide which module, if any, applies
before publication or customer use.
:::

## Summary

| Surface | Who sends personal data | Who receives it | Draft SCC posture |
| --- | --- | --- | --- |
| On-device journal | Stays on the host | No Octant cloud recipient | No Octant SCC. Controllership sits with the host owner. |
| BYO-key / BYO-subscription inference | Customer's host | Customer's chosen provider | Any SCCs or other transfer tools are between the customer and that provider. Ogard Labs is not on the inference path and is not the exporter for that turn. |
| Update checks | Desktop app, when enabled or manual | Feed host (default under `https://octant.sh/updates`, or a base the user sets) | Limited request metadata only. Assess as its own relationship; not a journal transfer. |
| Marketplace fetches | Host, when the user searches skills, inspects, or installs | skills.sh, npm registry, and/or GitHub as contacted | User-initiated catalog traffic. Assess separately; not a journal transfer. |
| Future Octant-hosted component that processes personal data | Customer or end user, if such a component ships | Ogard Labs or its listed sub-processors | If counsel finds a restricted transfer, execute the appropriate SCC module(s) with Ogard Labs as exporter or importer as the facts require. Use the [DPA template](/advanced/dpa-template). |

Hosted relay and multi-region Octant cloud stores are outside the technical
preview. This draft does not invent them.

## On-device journal

Personal data in Projects, threads, memory, and related projections never
leaves the host through an Octant sync channel. There is no telemetry,
analytics, or crash-reporting upload of journal content. Standard Contractual
Clauses between a customer and Ogard Labs are therefore the wrong instrument
for "where is my journal." Residency is the machine's location. See
[Data residency](/advanced/data-residency).

On a future shared host the team controls, the named controller of that
store is still that team's controller record, not Ogard Labs by default.

## Bring-your-own key and subscription

A Chat, Work, or Code turn is sent from the customer's host to the endpoint
or runtime the customer configured. Connection Check does not send a prompt.

If that provider processes data outside the EEA/UK, the customer evaluates
transfer tools under **their** contract with the provider. Ogard Labs does
not receive the prompt or completion in order to forward it, does not host
a required model API, and does not list those providers as Octant
sub-processors. See [Sub-processors](/advanced/sub-processors).

This draft therefore states: **no Octant-to-provider SCC** for BYO inference.
Counsel may still want customer-facing wording that points buyers at their
provider DPAs and SCCs.

## Octant-operated surfaces that exist today

These are not substitutes for a journal hosting service.

**Update checks.** A GET carries running version, platform, and architecture.
The feed operator can see IP address and release ring. Automatic checks are
switchable. This path does not include Projects, threads, credentials, or
prompts. Counsel decides whether the feed relationship needs contractual
transfer language; product fact: it is not an SCC covering customer journal
content.

**Marketplace fetches.** Skill search, inspect, and install contact
third-party registries with the query and ordinary HTTP metadata. They do
not send the journal. Same counsel question as above, same product boundary.

**Gravatar.** Only if the user presses the profile button after typing an
address. One hash lookup; image copied locally.

## If an Octant-hosted processing component ships

Before any such component processes personal data on a customer's behalf:

1. Confirm controller/processor roles in the [DPA template](/advanced/dpa-template).
2. Map categories that actually enter the component. Do not copy journal
   categories by habit.
3. If a transfer from the EEA/UK to a third country lacks adequacy, counsel
   selects the SCC module that matches the roles (controller-to-processor,
   processor-to-processor, and so on).
4. Complete Annexes for technical measures and sub-processors that Ogard Labs
   engages for that component.
5. Keep BYO providers out of the Octant sub-processor list unless Ogard Labs
   truly engages them on the customer's behalf, which BYO does not do today.

Until those steps happen, do not publish customer-facing SCCs that imply
Ogard Labs hosts or relays journal content.

## What this draft refuses to claim

- That Octant already operates an EU or US data region.
- That update checks or marketplace fetches are "telemetry products" covered
  by a blanket SCC.
- That BYO providers are Octant sub-processors requiring Octant SCCs.
- That this text is an executed Module 2 or Module 3 SCC.

## Next steps

- [DPA template](/advanced/dpa-template) for processor clauses if a hosted component ships
- [EULA placeholders](/advanced/eula-placeholders) for governing law and venue
- [Sub-processors](/advanced/sub-processors) for BYO relationships
- [Privacy notice](/advanced/privacy-notice) for what leaves the machine today
