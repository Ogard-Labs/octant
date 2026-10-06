---
description: How exporting a Canvas or artifact to a folder works, which folder it uses, and what happens when a file is already there.
---

# Export a Canvas or artifact to a folder

Export writes a readable copy of a Canvas or an artifact into a folder you
choose. The copy is Markdown or HTML, so any editor, viewer, or other tool can
open it. Octant writes the file itself and makes no network call: nothing about
an export leaves your computer.

The Canvas or artifact itself stays in Octant. A file is output — deleting it
does not delete anything, and editing it changes nothing until you import it
back, which adds a version rather than replacing one.

## Choose a folder

Export uses one folder per choice:

- A folder you choose while a Canvas or artifact is open is remembered for that
  Project.
- A thread filed under no Project exports to the host's folder. Choose one the
  same way from any Canvas, and it applies to everything without a Project of
  its own.

The folder always comes from Octant's own folder browser, which lists folders on
this computer. Octant never takes a folder path typed or sent from a window.
A folder must be inside your home folder; reaching outside it needs the standing
access-outside-project approval, which this preview does not offer, so an outside
folder is refused rather than assumed.

Put the folder inside a folder your sync client already watches if you want the
files on your other computers. Octant adds no cloud of its own for this.

## What the approval card shows

Export renders the document first and shows it to you before anything is
written. The card carries the rendered payload and the exact file it will write,
including the folder and the file name. Nothing is written until you approve it,
and declining writes nothing at all.

The receipt after an export is the path of the file that was written.

## File names, and when a file is already there

The name comes from the Canvas title, made safe for a file system, plus `.md` or
`.html` for the format you chose. Titles that contain path separators or
reserved characters are flattened into plain words.

If a file with that name is already in the folder, the approval card names it and
says it will be replaced. Approving that card is what replaces it. Anything that
is not confirmed that way — an export that could not name its file — is written
beside it instead, as `name (2).md`, then `name (3).md`, so an export never
quietly overwrites a file you kept.

## Status

The folder destination reports one of three states:

- **Not connected** — no folder has been chosen yet. Choose one from the export
  panel.
- **Ready** — a folder is chosen and can be written.
- **Refused**, with the reason — the folder has been moved, deleted, had its
  permissions taken away, or sits outside your home folder.

## Formats and platforms

Markdown and HTML are rendered today. PDF and PNG are named in the export seam
so a later destination can declare them; this host does not render them.

Export to a folder works on macOS and Linux.
