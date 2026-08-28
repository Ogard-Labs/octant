# Shared-host controller footing

**Status:** Draft pending legal review

> **Not legal advice.** This note records the product and architecture footing
> for small teams that share one Octant host. It is not a published privacy
> notice, not a data processing agreement, and not a certification of GDPR
> compliance. Qualified counsel must review it before anyone treats it as a
> published legal position.

## Audience and scope

Octant's audience includes prosumers and small teams who work together on
infrastructure they control. Collaboration is designed as sharing a host or a
git remote they own. Never an Octant account, never an Octant-operated store,
and never host-to-host trust. See
[`docs/decisions/0040-share-a-host-or-a-git-remote.md`](../decisions/0040-share-a-host-or-a-git-remote.md).

This draft covers **layer 2 of that design**: one headless host, several
paired principals, one journal. The shared team host is not the current
technical preview. The preview already ships single-owner hosts, paired
remote devices of that owner, thread export, confirmed purge, diagnostics
export, and a Settings data map. Those surfaces are the footing the shared
host must keep when it ships.

## The position

When a shared host holds several principals' personal data in one journal:

1. **The host owner is the controller** of personal data in that host's
   event journal, projections, host logs, diagnostics packets, and audit
   export surfaces that cut from those stores.
2. **Ogard Labs is not the controller** of that store. Octant does not sync
   the journal to an Octant cloud, does not operate a multi-tenant SaaS of
   team workspaces, and does not receive teammate transcripts in order to
   host them.
3. **Teammates are distinct principals and data subjects** on that host.
   Pairing uses distinct device keys. Display names authenticate nothing.
4. **BYO AI providers remain the user's processors** for inference the host
   sends under each principal's provider use grants. They are not Octant
   sub-processors. See
   [`apps/docs/advanced/sub-processors.md`](../../apps/docs/advanced/sub-processors.md).

"Host owner" here means the principal who enrolled the host and holds
local-host-required administration (listener enablement, pairing approval,
credential administration, and the other local-only actions already fixed
for remote access). That person decides where the machine sits, who may
pair, and who may read which Projects.

### Controller of record vs machine ownership

Decision 0040 records GDPR controllership as a **journaled fact**, not as
something derived only from who owns the hardware. Controller, processor,
and joint-controller relationships are representable so a team can name a
different legal controller when counsel requires it.

The **default small-team footing** is still: the host owner is controller
for that host's journal, logs, and audit export unless a recorded
controller fact says otherwise. Operators should not assume that giving
someone a Project grant, or seating the VM in a particular region, silently
moves controllership. Residency remains "this machine, this region"; see
[`apps/docs/advanced/data-residency.md`](../../apps/docs/advanced/data-residency.md).

Counsel must decide how to state joint-controller or processor arrangements
in published documents. This draft does not invent those forms.

## What the controller is responsible for on that host

For personal data in the shared store, the host-owner controller is the
party who must be able to answer ordinary controller questions about:

| Surface | What it is today |
| ------- | ---------------- |
| Event journal and projections | Authoritative store of Projects, threads, layouts, memory, grants, and actor envelopes |
| Host logs | Files under the host logs directory |
| Diagnostics export | Local redacted evidence packet; not an upload channel |
| Thread export | Host-authoritative `octant.thread-bundle/1` cut of one thread the caller may already open |
| Thread retention and purge | Explicit, confirmed erasure of named threads, including journal events and derived projections |
| Settings → Host data map | Read-only map of what this host stores and where |

Audit for collaboration is the journal itself: mutations carry a
principal-bearing actor. Layer 2 requires those actors to name a principal
so two teammates are distinguishable. Until that ships, today's remote
devices are devices of the single host owner, not separate teammate
principals.

## Rights surfaces that already ship

These are product behavior on the current host, and they remain the base
the shared-host layer must not weaken.

**Export one thread.** Export is a server cut of one thread the caller can
already open. The JSON bundle carries transcript, evidence, and provenance,
and names the cut time. Secrets, raw provider payloads, resume cursors, and
filesystem paths are unrepresentable. Bulk content outside the journal is
listed as omissions. A paired device may export only a thread it can
already read. This is not a host-wide dump. See decision 0036 and
[`apps/docs/advanced/privacy-notice.md`](../../apps/docs/advanced/privacy-notice.md).

**Retain and purge.** Retention windows never delete on their own. A
confirmed purge deletes purgeable bulk content, removes derived
projections, physically deletes that thread's journal events, and appends
a tombstone. A remote principal cannot set a window or purge. SQLite free
pages may retain bytes until vacuum; that residual is reported. See
decision 0035.

**Data map.** Settings → Host shows a read-only map of journal, projections,
artifacts, credential references (never values), caches, and outbound
categories. It does not purge or export; those actions stay on retention
and thread export.

**Diagnostics.** Local, redacted, operator-initiated. Not telemetry.

Layer 2 of decision 0040 additionally requires, before the shared host
ships as a product: per-principal export, and controller-confirmed erasure
of that principal's bulk content with a tombstone that the removal
happened. Those are not claimed as shipped here.

## Processor and non-processor lines

| Party | Footing on a shared host |
| ----- | ------------------------ |
| Host owner | Default controller of the host store |
| Teammate principals | Data subjects (and may be controllers of their own devices' local pairing material only) |
| Ogard Labs | Not controller of the shared journal; ships software |
| BYO providers | Customer's processors under the customer's own contract |
| Update feed / marketplace registries | Separate traffic; not the journal path; see the privacy notice |
| Git remotes the team chooses | Team-controlled transport for artifact bundles; Octant does not push |

Credential bytes stay in the host OS secret store. Invoking a provider
consumes a credential only when the acting principal holds a
server-enforced use grant. Sharing a thread does not share credential
bytes to another device.

## Non-goals

This footing does **not** authorize or imply:

- A multi-tenant Octant cloud or Octant-operated team workspace region
- Hosted relay
- Host-to-host trust or host-to-host credential replication
- Org SSO as a core pairing dependency (SSO may arrive later only as a
  plugin that asserts a name to an already-admitted principal)
- Live co-presence as a prerequisite of shared-host controllership
- Treating git-mediated async sharing (layer 1) as creating a shared
  journal; each host keeps its own journal and imports bundles locally
- Publishing this draft as a customer-facing legal notice without counsel

## Relationship to single-owner preview hosts

Today's technical preview is the degenerate case of layer 2: one principal,
the host owner, whose local windows and paired devices all belong to them.
For that case the same sentence holds without teammates: the host owner is
controller of the journal on their machine. The privacy notice, sub-processor
position, and data-residency drafts already describe that single-owner
truth.

## Next steps for counsel

1. Confirm or rewrite the default "host owner is controller" sentence for
   published notices.
2. Decide how joint-controller and processor templates should look when a
   team records a controller fact that is not the machine owner.
3. Align published language with the DPA / SCC / EULA drafts once those
   exist beside the privacy notice set.
4. Gate any customer-facing publication on the parent GDPR compliance
   package review.

## Related product docs

- [Privacy notice](../../apps/docs/advanced/privacy-notice.md)
- [Sub-processors](../../apps/docs/advanced/sub-processors.md)
- [Data residency](../../apps/docs/advanced/data-residency.md)
- [Privacy and security](../../apps/docs/advanced/privacy-and-security.md)
- [Remote access](../../apps/docs/advanced/remote-access.md)
- Decision 0040 (collaboration), 0035 (purge), 0036 (export), 0013 (remote)
