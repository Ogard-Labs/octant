---
description: What leaves this computer when artifact sync is on, where those copies go, and how to turn sync off.
---

# Sync artifacts across your computers

Read this before you turn sync on. Sync copies artifact versions to a store
you own, so another computer running Octant can import them. It stays off
until you turn it on in **Settings › Sync**. Above the switch, Settings states
the same fact this page does: the storage provider can read the files, which
are signed but not encrypted.

## What turning sync on does in this preview

You can choose a store and turn sync on, and **Test connection** writes its
probe file there. Artifact versions are not copied yet, and nothing is
imported from the store yet. Turning sync on lets Octant reach the store you
chose; it does not start copying. This page describes what is copied once
that ships.

## Set up a store

Open **Settings › Sync** on the computer that runs Octant. A paired phone or
browser cannot change it. Choose one store:

- **Synced folder.** Choose a folder with Octant's folder browser, such as one
  your Dropbox, iCloud Drive, or OneDrive client already watches. Octant writes
  only inside an `Octant Sync` folder in it. The folder must be inside your home
  folder.
- **S3-compatible bucket.** Enter the connection details described
  [below](#an-s3-compatible-bucket), then **Save**.
- **None.** No store, and nothing is reachable.

Changing the store turns sync off, so you read the fact above the switch again
for the new store before you turn it back on. Choosing a different store also
removes a bucket's access key and secret from your Keychain or Secret Service.

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

Once sync is on, **Test connection** proves the setup by writing one small
probe file: under `.octant-probe/` in the bucket, or in the folder's
`Octant Sync/.octant-probe/`. It deletes nothing, and the app ignores that file
when it reads the store. Octant does not delete objects from your bucket or
files from your folder on your behalf. With sync off, Test connection calls
nothing.

## Joining another computer

This preview does not offer joining yet. When it does, it works like
this. The new computer writes a request into the store, signed with a key
kept in its own Keychain or Secret Service. A computer that already shares
the store shows that the new one wants to join, and both screens show the
same six-digit code. You approve only if the codes match, then confirm on the
new computer. The code is a check that both screens mean the same two
computers; it is not a password, and nothing secret passes through the store.

Revoking a computer writes a signed record. After your other computers read
it, they refuse anything that computer writes. A revoked computer that wants
back in joins again as a new computer.

## Turning sync off

Turn off **Sync artifacts** in **Settings › Sync**. Turning sync off stops
this computer writing to the store and reading from it. Copies already in the
store stay there. Versions already imported stay in the library. A copy that
fails does not undo a version you already committed on this computer.
