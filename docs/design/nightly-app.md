# Octant Nightly

This topic specification owns the second desktop app, Octant Nightly: what
makes it a separate app, how it shares Octant's data while both run, which
builds ship as it, and how a person gets it. Architecture owns the boundary:
one host per data folder, how updates are verified, and which rings exist
([Architecture: persistence](../architecture.md#persistence) and
[current release boundary](../architecture.md#current-release-boundary)).
DESIGN.md owns Settings presentation.

Status: proposed for review, not yet built. Until it is built, there is one
app, and Settings › Updates switches its ring.

## Two apps, one set of data

Octant ships as two apps that install side by side and can be open at the same
time:

- **Octant** follows the `stable` ring. It is the app a person works in.
- **Octant Nightly** follows the `preview` ring (scheduled builds of `main`) and
  can follow `candidate` (one-off builds of a chosen ref). It shows what is
  next.

Both apps work on the same threads, Projects, settings, sign-ins, and history.
A thread started in one is live in the other, as it is in two windows of one
app.

## One host serves both

The data folder has one host, and it is Octant's.

- The journal has one writer, and its migrations are forward-only: a host
  refuses data that a newer host has migrated
  ([persistence](../architecture.md#persistence)). Two hosts on one folder, or a
  nightly host upgrading the folder, would leave Octant unable to open its own
  data. So Octant Nightly never runs a host of its own on that folder.
- Octant Nightly's windows connect to Octant's running host as a client, the
  way a second window does. When no host is running, Nightly starts Octant's
  host without opening an Octant window. Nightly therefore needs Octant
  installed; on its own it says so and offers the download.
- What Nightly brings is its shell and screens: the renderer and the desktop
  process. New host behavior (agents, providers, tools, persistence) reaches a
  person when it ships in Octant. Nightly decodes host answers the forgiving
  way every client does, and a Nightly feature that needs a host command
  Octant does not have yet says "Needs a newer Octant" instead of failing
  silently.
- The host keeps running while either app has a window open. Quitting one app
  leaves the other working; quitting the last one stops the host, as today.
  Updating Octant restarts the host, and Nightly reconnects when it is back.
- The credential broker and Keychain items stay with the host's app, so a sign-in
  made from either window is stored once.

## Identity

The apps differ only in what macOS and Linux need to keep two apps apart:

| Value                       | Octant                                 | Octant Nightly                                 |
| --------------------------- | -------------------------------------- | ---------------------------------------------- |
| Product name and menu title | Octant                                 | Octant Nightly                                 |
| Bundle id                   | `app.octant.desktop`                   | `app.octant.desktop.nightly`                   |
| Host data folder            | `~/Library/Application Support/Octant` | The same folder, through Octant's host         |
| Window storage (macOS)      | Inside the data folder, as today       | `~/Library/Application Support/Octant Nightly` |
| Host port                   | `13773`                                | None of its own; it uses Octant's host         |
| Link scheme                 | `octant://`                            | `octant-nightly://`                            |
| Command-line tool           | `octant`                               | `octant-nightly`                               |
| Rings                       | `stable`                               | `preview` (default), `candidate`               |
| Icon                        | The Octant icon                        | The Octant icon with its colours inverted      |

- Window storage is the desktop process's own browser storage (window
  positions, local storage, cookies of the app's renderer) and the
  single-instance lock. It is separate so the two apps never fight over one
  lock or one window layout file; it holds no thread or Project data.
- `octant-nightly` is the Nightly build of the command-line tool. It attaches to
  the same host as `octant`, so a person can try a newer tool against their
  real data without replacing `octant`.
- The identity is one record per flavor next to `DESKTOP_PACKAGE_IDENTITY`. The
  desktop process reads its name, scheme, window storage folder, and whether it
  may start a host from that record, never from a literal.
- `OCTANT_DATA_DIR` and `OCTANT_SERVER_PORT` still override either app, as for a
  development build. A development build (`bun run dev`) is neither app and is
  unchanged.

## Getting Octant Nightly

- **From Octant.** Settings › Updates replaces the ring switch with an Octant
  Nightly row: "Install Octant Nightly" downloads the newest preview build,
  verifies it exactly as an update is verified (feed signature, artifact
  hash, then the platform's code-signature check), and places it beside Octant.
  Once installed, the row offers "Open Octant Nightly" and "Remove Octant
  Nightly", which moves the app to the Trash and leaves the shared data alone.
  Installing is a download the person starts; Octant never installs Nightly by
  itself.
- **From the website.** octant.sh offers both downloads. The Nightly download
  says it works with Octant and needs it installed.
- Nightly then updates itself on its own rings. Octant's updater only ever
  checks `stable`.

## Which build is which

- A build's flavor follows its ring: a `stable` release packages as Octant; a
  `preview` or `candidate` release packages as Octant Nightly. The release
  workflows pass the flavor with the version, and packaging refuses a stable
  version under the Nightly identity or a prerelease under Octant's.
- A local `bun run package:desktop` builds Octant unless
  `OCTANT_PACKAGE_FLAVOR=nightly` is set, so a maintainer's own packaged build
  keeps opening their existing data.
- Feed keys are unchanged: Octant trusts the stable key; Octant Nightly trusts
  the preview key and the stable key, as the preview and candidate rings do
  today. An update for one app can never install the other: the signed ring
  must equal a ring the app follows, and on macOS the platform updater's
  code-signature check also requires the running app's bundle id.
- Nothing has shipped on any ring, so no install needs moving between apps.

## Presentation

- The Nightly icon is the Octant icon with its colours inverted: the same
  silhouette and sizes, so the Dock and the app switcher tell the two apart at
  a glance.
- A small "Nightly" pill sits beside the name in the sidebar header. When the
  sidebar is collapsed, it moves to the window's title bar. It is a quiet
  label at the meta step, not a warning colour.
- The window title, menu bar, About panel, notifications, and menu-bar extra
  name the app ("Octant Nightly"). Copy that names the product reads its name
  from the identity record.

## Acceptance

- Octant and Octant Nightly open together; a thread started in one appears
  live in the other, and both show the same Projects and settings.
- With only Nightly open, its windows work, and exactly one host runs.
- Quitting either app leaves the other's windows working.
- An `octant://` link opens Octant, and an `octant-nightly://` link opens
  Nightly.
- `octant` and `octant-nightly` both reach the one running host.
- Install from Settings refuses a build whose signature, hash, or code
  signature does not verify. Remove leaves the data untouched.
- Octant offers only stable updates. Nightly offers preview and candidate, and
  refuses a feed signed for `stable`.

## Decisions for review

- **Whose host owns the data.** This design gives the host to Octant, so a
  nightly can never upgrade the data out from under it. The cost: Nightly
  tests new screens, but host changes (agents, providers, tools) run only once
  they ship in Octant. The alternative is that the newest installed host owns
  the data and serves both apps. Nightly would then test everything. But once
  it migrates the data, Octant alone cannot open it until Octant updates (the
  host keeps a backup before every migration), and a broken nightly host would
  hold the data until a fix or a restore.
