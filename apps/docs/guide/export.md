---
description: How exporting a Canvas or artifact works — to a folder you choose, to a GitHub Gist, or to a private page on your Anthropic account — what the approval card shows, and what the receipt is.
---

# Export a Canvas or artifact

Export writes a readable copy of a Canvas or an artifact somewhere you choose.
The copy is Markdown or HTML, so any editor, viewer, or other tool can open it.
Three destinations ship today: a folder on this Mac, a GitHub Gist, and a
private page on your Anthropic account ("Share to Claude").

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
folder is refused rather than assumed. Octant remembers the folder by where it
really is: if the folder, or a folder above it, is later replaced by a link to
somewhere else, the export is refused instead of following the link.

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

## Share to Claude

**Share to Claude** publishes the rendered HTML as a private page on your
Anthropic account and gives you its link. Octant uses the Claude Code sign-in
you already have for the Claude provider; you do not sign in again, and Octant
holds no credential for it. The page is published by the Claude runtime on this
Mac, started once for that page alone and allowed to do nothing but publish it.

HTML only. The page is the rendered document exactly as the approval card shows
it.

### What the approval card shows

The card carries the rendered HTML, the Claude account it will publish as, and
a note that the page is private: only you can open it until you share it on
your Anthropic account. Nothing is sent until you approve the card, and
declining sends nothing. Approving the card is the whole consent; Claude does
not ask again.

Each share makes a new page. Sharing the same Canvas again creates another page
rather than replacing the first; the card says so.

### Secret boundary

The HTML goes through the same checks as every other export: no absolute file
paths and no secret-shaped values. A document that still contains one is
refused rather than published.

### The receipt, and when Claude refuses

The receipt is the page's link. It appears where export results appear, and
you can open it or copy it from there. Octant records the link with the export,
and keeps no copy of the page itself. Octant does not delete a page afterward;
remove it on your Anthropic account.

If the Claude runtime refuses to publish, if it does not finish, or if nothing
was published, the export says so and nothing is shown as published.

### Status

The destination is named after the Claude provider as you named it in Settings,
so it reads **Share to Claude** for a provider named "Claude". It is listed
once that provider is enabled and its connection check has seen a signed-in
account; until then it does not appear. Sign in with the official Claude Code
application, then run the provider's connection check from Settings →
Providers & Models. Once listed, it reports one of two states:

- **Ready** — the signed-in Claude account can publish.
- **Refused**, with the reason — the Claude provider is signed in with an API
  key. Pages belong to a Claude sign-in, so an API key cannot publish one.

## Formats and platforms

Markdown and HTML are rendered today. PDF and PNG are named in the export seam
so a later destination can declare them; this host does not render them.

Export to a folder works on macOS and Linux. The gist destination needs a
working GitHub connection. Share to Claude needs an enabled Claude provider
signed in with a Claude account.
