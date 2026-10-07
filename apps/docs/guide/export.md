---
description: How exporting a Canvas or artifact works — to a folder you choose or to a GitHub Gist — what the approval card shows, and what the receipt is.
---

# Export a Canvas or artifact

Export writes a readable copy of a Canvas or an artifact somewhere you choose.
The copy is Markdown or HTML, so any editor, viewer, or other tool can open it.
Two destinations ship today: a folder on this Mac, and a GitHub Gist.

Whatever the destination, Octant renders the document first and shows it to you
before anything is sent or written. A destination is called only after you
approve the card. The Canvas or artifact itself stays in Octant: deleting or
editing an export does not delete or change anything, and importing it back adds
a version rather than replacing one.

## Export to a folder

A folder export writes a file and makes no network call: nothing about it leaves
your computer.

### Choose a folder

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

### What the approval card shows

Export renders the document first and shows it to you before anything is
written. The card carries the rendered payload and the exact file it will write,
including the folder and the file name. Nothing is written until you approve it,
and declining writes nothing at all.

The receipt after a folder export is the path of the file that was written.

### File names, and when a file is already there

The name comes from the Canvas title, made safe for a file system, plus `.md` or
`.html` for the format you chose. Titles that contain path separators or
reserved characters are flattened into plain words.

If a file with that name is already in the folder, the approval card names it and
says it will be replaced. Approving that card is what replaces it. Anything that
is not confirmed that way — an export that could not name its file — is written
beside it instead, as `name (2).md`, then `name (3).md`, so an export never
quietly overwrites a file you kept.

### Status

The folder destination reports one of three states:

- **Not connected** — no folder has been chosen yet. Choose one from the export
  panel.
- **Ready** — a folder is chosen and can be written.
- **Refused**, with the reason — the folder has been moved, deleted, had its
  permissions taken away, or sits outside your home folder.

## Export to a GitHub Gist

A gist is a small file hosted by GitHub. Export uses the GitHub connection
Octant already has for your repositories and issues — you do not connect
anything again. If GitHub is not connected, the gist destination says so and
cannot be chosen.

Markdown only, for now. The gist contains one file, named from the Canvas title
with a `.md` extension. HTML can follow.

### What the approval card shows

The card carries the rendered payload, the account it will be posted as, and who
can see it:

- **Secret** (the default) — the gist is unlisted: it appears on no profile
  and in no search, but anyone who has its URL can view it.
- **Public** — anyone on the internet can see it. The card says this plainly
  before you choose it.

Nothing is sent until you approve the card. Declining sends nothing. The gist is
created only after approval, and only against GitHub's API.

### Secret boundary

The document goes through the same checks as every other export: no absolute
file paths and no secret-shaped values. A document that still contains one is
refused rather than posted.

### The receipt, and when GitHub refuses

The receipt is the gist's URL and its id. If GitHub refuses the credential — for
example, because it has been revoked or expired — the export is refused with a
clear message and nothing is posted; reconnect GitHub and try again. If GitHub
declines to create the gist for another reason, most often because the
connection lacks the `gist` scope, the export says GitHub declined it rather
than that GitHub could not be reached.

### Status

The gist destination reports one of three states:

- **Not connected** — GitHub is not connected. Connect it from Settings.
  Octant checks the connection when you open the export panel, not when it
  starts, so connecting GitHub shows up the next time you open it.
- **Ready** — GitHub is connected and the export will post as your account.
- **Refused**, with the reason — GitHub is signed in, but its credential is
  stored in plain text on this Mac, so Octant will not send through it. The same
  rule applies to Octant's other GitHub features.

## Formats and platforms

Markdown and HTML are rendered today. PDF and PNG are named in the export seam
so a later destination can declare them; this host does not render them.

Export to a folder works on macOS and Linux. The gist destination needs a
working GitHub connection.
