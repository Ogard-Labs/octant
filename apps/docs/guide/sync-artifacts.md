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
Octant does not encrypt them. Credentials, secret-shaped text, and absolute
file paths in that text are refused or removed before an entry is written.
A copy this computer imported is not written out again. A later edit here is
a new version.

Threads, settings, and credentials do not leave this way. Canvas comments
are not part of this copy. Joining another computer can import the versions
in the store. It does not bring back threads, Projects, or settings.

## Where it goes

A synced folder you set up, or an S3-compatible bucket you set up. Octant
does not operate a store, and it does not run a relay. Another computer
running Octant imports those entries as new versions of its own. It does not
replace a version you already have.

If two computers revise the same artifact from the same parent, the library
shows both. You pick one, or you merge them into a new version. Nothing is
chosen for you. A deletion and a revision from the same parent are both kept.
The revision stays visible. The artifact is hidden only when the deletion is
the only version left, and you can undo that.

The mirror and the export are separate. They still write plain files for you
and for other tools, and they never push to git. Pointing a sync client at
the mirror folder is not this sync.

## An S3-compatible bucket

An S3-compatible bucket needs its endpoint address, region, bucket name, an
optional folder prefix, and whether the provider uses path-style or
virtual-host addressing. The access key and secret are kept in your computer's
Keychain (macOS) or Secret Service (Linux) — the same place your model provider
credentials live. Octant never writes them to a store entry, to your journal,
or to a log. It contacts only the endpoint you configured, and only while sync
is on. The endpoint must be an `https` address; a plain one is refused, and no
credential is sent on it.

A **Test connection** button proves the setup by writing one small probe file
in the bucket. It deletes nothing, and the app ignores that file when it reads
the store. Octant does not delete objects from your bucket on your behalf.

## Joining another computer

This preview does not offer joining yet either. When it does, it works like
this. The new computer writes a request into the store, signed with a key
kept in its own Keychain or Secret Service. A computer that already shares
the store shows that the new one wants to join, and both screens show the
same six-digit code. You approve only if the codes match, then confirm on the
new computer. The code is a quick consistency check that both screens mean
the same two computers, the same key on the approving one, and the same
computer that set up the store. A store someone tampered with usually shows a
different code, but six digits are short: someone who can write to the store
could search offline for a substituted request that shows the same code. The
signatures on every record, not the code, are what Octant trusts. The code is
not a password, and nothing secret passes through the store.

The new computer then confirms. It signs a record saying which approval it
accepted, so the computer that approved it is the one that brought it in,
and nobody else can claim that place later.

Revoking a computer writes a signed record that marks the last of its entries
you accept. You can revoke a computer that yours brought in, directly or
through others; the computer that set up the store can revoke any of them.
To revoke a computer another one of yours brought in, revoke it from that
computer, or from the one that set up the store. A computer you revoke cannot
remove the computer that brought it in.

Before it revokes, your computer reads the store, so what the revoked
computer already signed - artifact versions and approvals alike - keeps
counting and the computers it brought in stay. The revoke screen lists those
computers, so you can revoke them in the same step, for example when the
computer was stolen, and it lists the revocations the computer already wrote.
You can also move the point earlier, before one of those revocations, say;
computers it approved after that point then join again. If one of the
revocations in a step cannot be written, the screen says which computers were
not revoked, so you can try them again. After your other computers read the
record, they ignore anything the revoked computer wrote after that point.

A revoked computer, or one that lost its place because the computer that
approved it was revoked before that approval, joins again as a new computer,
with a new key. If the computer that set up the store is lost, set up a new
store and join your computers to it.

If someone with write access to the store fills the places where one of your
computers writes next, that computer stops publishing and says so. Remove
those files with your storage provider's own tools, change the store's access
keys, or move to a new store.

## Turning sync off

Turning sync off stops this computer writing to the store and reading from
it. Copies already in the store stay there. Versions already imported stay
in the library. A copy that fails does not undo a version you already
committed on this computer.
