# 0059. Multi-host federation completes without new host authority

**Status:** Proposed

## Context

0013 already chose the federation shape: every entity is `{ hostId, entityId }`,
clients hold independent connections per host, read models merge on the client,
and hosts never communicate with or trust each other. 0031 added the view
vocabulary — an environment is a connected host under the person's name for it,
"All" includes hosts that are not connected yet, and an unreachable environment
goes stale rather than vanishing. 0015 keeps one visible split tree on one
authority context, so a cross-host drop is refused.

The all-hosts sidebar, environment filter, and per-creation destination host
are already decided and largely landed. Linux Stations (0048) and disposable
computers change what kind of Machine can own work; they are not federation
contracts and must not be re-litigated here. Collaboration that needs a shared
store is share-a-host or a git remote (0040), never a mesh of trusting hosts.

What remains is program follow-through: make the all-hosts view honest when
hosts are unavailable, scale pairing and recovery across many Machines, and
state conflict handling without inventing authority 0013 already forbade.

## Decision

- **Federation stays a client registry and connection layer.** No host-to-host
  channel, no shared journal across hosts, no credential or filesystem
  authority that crosses a host boundary. Provider tokens, secrets, and
  mutable authority never leave the owning host. This record does not widen
  remote principals, remote-approvable actions, or local-host-required gates
  from 0013.
- **Wire identity is still `HostId`.** Device and Machine presentation (0048)
  labels registry entries the person already paired; they do not mint a second
  identity system or move ownership to the window.
- **All-hosts completeness.** Gathered lists include every registered Machine,
  connected or not. Unavailable hosts keep their place and counts; their items
  stay listed and marked stale. Filters that hide a host are view state and
  say so; they never delete. A destination is offered only when the client can
  fetch that host's facts and route the create command (0031).
- **Pairing UX at scale.** Pairing, reconnect, revoke, and remove stay the
  0013 gestures, surfaced for many hosts: durable host identity the person can
  recognize, recovery that renews from the device key rather than a new pair
  when the session merely expired, and revocation that drops sessions before
  the response completes. Inventory and host-key rotation remain
  local-host-required on each owning Machine.
- **Conflict is honesty, not arbitration.** When two hosts disagree, the client
  shows both truths under their owning host; it never picks a winner, merges
  journals, or lets one host's facts authorize action on another. Create and
  mutation routing always name one destination host first.
- **Out of scope here.** Hosted relay, public ingress, host-to-host trust,
  Station capsules, disposable desktops, and shared-team-host grants (0040
  layer 2) stay on their own records.

### Reviewable children

Implementation splits into three children under the post-preview federation
program. None invents host authority.

1. **All-hosts view completeness** — unavailable hosts, stale rows, honest
   environment filtering, and destination state only where create can succeed.
2. **Pairing UX at scale** — host identity, reconnect recovery, revocation,
   and remove across a multi-host registry without weakening 0013.
3. **Multi-host conflict and authority honesty** — fail-closed presentation
   and routing when hosts disagree or one is unreachable; no cross-host
   arbitration.

## Consequences

- New federation work is reviewable against these three children instead of one
  unbounded program issue.
- Station and disposable-computer tracks stay free to land Machine kinds
  without rewriting the client merge contract.
- Anything that needs hosts to trust each other, or a window to act as
  authority across hosts, is out of shape until a later record supersedes this
  one and 0013.

## Related

- 0013 Remote access: single host, paired devices, and mobile
- 0015 Workspace shell model
- 0031 Hosts as environments
- 0040 Collaboration: share a host or a git remote
- 0048 Linux Stations isolate Code work in execution capsules
