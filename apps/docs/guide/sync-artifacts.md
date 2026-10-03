---
description: What leaves this computer when artifact sync is on, where those copies go, and how to turn sync off.
---

# Sync artifacts across your computers

Read this before you turn sync on. Sync copies artifact versions to a store
you own, so another computer running Octant can import them. It stays off
until you turn it on. This preview does not yet offer that control, so
nothing is copied until it does. When the control is offered, Settings states
the same fact this page does — the storage provider can read the files —
before the switch can be turned on.

## What leaves this computer

Readable artifact versions, and a tombstone when you delete one. Each entry
is a plain JSON bundle, the same shape as an export, signed by the computer
that wrote it. You can open the files. The storage provider can read them.
Octant does not encrypt them.

Threads, settings, and credentials do not leave this way. Canvas comments
are not part of this copy.

## Where it goes

A synced folder you set up, or an S3-compatible bucket you set up. Octant
does not operate a store, and it does not run a relay. Another computer
running Octant imports those entries as new versions of its own. It does not
replace a version you already have.

If two computers revise the same artifact from the same parent, the library
shows both. You pick one, or you merge them into a new version. Nothing is
chosen for you.

The mirror and the export are separate. They still write plain files for you
and for other tools, and they never push to git. Pointing a sync client at
the mirror folder is not this sync.

## Turning sync off

Turning sync off stops this computer writing to the store and reading from
it. Copies already in the store stay there. Versions already imported stay
in the library. A copy that fails does not undo a version you already
committed on this computer.
