---
description: Draft data-residency statement — local-first means the user's machine, in the region where that machine sits.
---

# Data Residency

::: warning Draft pending legal review
This page is a draft. It names where Octant actually stores data today. It
is **not** a published residency guarantee or a choice of Octant-operated
regions.
:::

Local-first means **your machine, your region**. Octant does not operate a
cloud region you pick from a menu. The store lives on the host that runs
the server, in whatever country or jurisdiction that machine already sits.

## The host is the region

Projects, threads, memory, the event journal, projections, layouts, and
credential references stay on that host. Remote access, when you enable it,
is a connection to the same store over your network. It does not copy the
journal into another data center.

A paired browser or the Expo client stores only device keys, a host
registry, and session material. Threads remain host-owned.

## Default locations

On macOS:

```text
~/Library/Application Support/Octant/
~/Library/Logs/Octant/
```

The authoritative SQLite store is `octant.sqlite3` in the data directory.
Set `OCTANT_DATA_DIR` to an absolute path to put the store somewhere else
you control — another volume, an encrypted disk image, or a machine in a
particular office.

The headless Linux runtime uses owner-private XDG roots when no override is
set (`~/.local/share/octant` for data, plus the matching config, state, and
runtime directories). Packaged Linux is not part of the Apple Silicon
preview, and macOS Keychain integration is not present on those sessions.

Directories are created owner-only. Unsafe ownership, permissions,
relative paths, and symlink components fail closed before persistence
opens.

## What this is not

- There is no Octant-operated EU or US region.
- There is no hosted relay in the preview. You cannot ask Octant to hold
  the store "in the EU" on your behalf.
- App-level database encryption is not in the preview; residency here is
  filesystem location plus host protection, not a ciphertext that can
  travel.
- Moving a data directory to another machine moves the store to that
  machine's region. Downgrade of a newer store is refused.

## Provider and update traffic

A provider turn is processed where **that provider** processes it, under
the contract you have with them. That is independent of where your Octant
store lives. See [Sub-processors](/advanced/sub-processors).

An update check or marketplace fetch is processed where the feed or
registry you contacted is hosted. Those requests do not relocate the
journal.

## Shared infrastructure, if you run it

A later design would let a team run one headless host on infrastructure
they control. That host's region would still be the region of _their_
machine or cluster, not an Octant region. It has not shipped. Who is
controller of that shared journal is a separate question from residency;
see the draft at `docs/legal/shared-host-controller.md`.

## Next steps

- [Privacy notice](/advanced/privacy-notice) for what the store holds and what can leave
- [SCC position](/advanced/scc-position) for transfers that are not "move the journal"
- [Privacy and security](/advanced/privacy-and-security) for owner-only permissions and credentials
- [Release compatibility](/advanced/release-compatibility) for preview platform boundaries
- [Installation](/guide/installation) for `OCTANT_DATA_DIR` and update-check location
