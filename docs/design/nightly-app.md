# Octant Nightly

This topic specification owns the second desktop app, Octant Nightly: what
makes it a separate app, how it shares Octant's data while both run, which
builds ship as it, and how a person gets it. Architecture owns the boundary:
one host per data folder, how updates are verified, and which rings exist
([Architecture: persistence](../architecture.md#persistence) and
[current release boundary](../architecture.md#current-release-boundary)).
DESIGN.md owns Settings presentation.

Status: identity, packaging, inverted icons and update-ring foundations are
implemented. The functional stable-host desktop client bridge is not built.
A packaged Nightly launch therefore refuses before importing the host-owning
desktop module, which prevents credential initialization, host startup and
migrations.

The remaining delivery includes the typed per-window native broker connection,
stable host-only launch and retention, shared sign-in operations, the complete
`octant-nightly` command, the installer and removal controls, Nightly labels,
and the functional release preflight. Coexistence, reconnect and rollback
still need their implementation and packaged evidence. The
preview/candidate workflow now selects the Nightly flavor and matching artifact
and payload-smoke paths, but an explicit early gate stops that workflow before
build, signing or publication. The functional client change must replace the
gate with lifecycle, credential and native-surface parity evidence. Stable
release and local packaging are unaffected by that gate.
Nothing in this foundation authorizes installation or publication.

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

## Embedded Browser

Nightly presents the Browser inside its own window. A stable-owned companion
window is not an accepted fallback. Octant remains the sole owner of persistent
Browser profiles and their live sessions; Nightly must neither open those
profiles concurrently nor copy them into another profile.

The embedded display must preserve normal person-controlled browsing, including
focus, keyboard and text input, IME composition, accessibility, and native
popups. A bounded bitmap transport proves only frame delivery. It does not
establish those capabilities or authorize reusing agent observations/actions
as a credential-bearing human display/input channel. Local client/process
attestation and the production transport still require their own implementation
and authority checks.

The current foundation remains publication-gated while the functional bridge
and input, IME, accessibility, and native-popup parity need implementation and
evidence. An isolated synthetic fixture is feasibility evidence only; it is not
packaged coexistence, signed-in browsing, or native identity verification.

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
- The identity is one record per flavor in `@octant/host-runtime`, consumed by
  `DESKTOP_PACKAGE_IDENTITY` and desktop packaging. The packaged manifest stamps
  the flavor, and the desktop reads that manifest rather than a launch
  environment variable. Its name, scheme, window storage folder, rings and host
  ownership come from that record. A malformed or mismatched identity refuses
  startup. Development keeps its existing entry and unrestricted ring tests.
- `OCTANT_DATA_DIR` and `OCTANT_SERVER_PORT` still override either app, as for a
  development build. A development build (`bun run dev`) is neither app and is
  unchanged.

## Getting Octant Nightly

- **From Octant.** Settings › Updates replaces the ring switch with an Octant
  Nightly row: "Install Octant Nightly" downloads the newest preview build and
  places it beside Octant after three checks:
  - The feed signature, against the preview ring's trust set (the preview key
    and the stable key). This installer is the only part of Octant that reads
    a preview feed; Octant's own updater still trusts and checks only `stable`.
  - The artifact hash inside that signed feed.
  - On macOS, a code-signature requirement written for Nightly: bundle id
    `app.octant.desktop.nightly`, signed by Octant's own Developer ID team. It
    is not the self-updater's check, which requires the running app's bundle
    id and would refuse Nightly; and it is never just "validly signed", which
    would admit another publisher's app.
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
  code-signature check also requires the running app's bundle id. An update
  check or download that finishes after its ring was changed or refused cannot
  restore the older offer, failure or native download result.
- Nothing has shipped on any ring, so no install needs moving between apps.
- **Release order.** The first technical preview ships as Octant on the
  `stable` ring, so a person's first install has a host. Octant Nightly is
  published only once a stable Octant exists for it to attach to; "technical
  preview" names the product's stage, not the ring.

## Presentation

- The Nightly icon is the Octant icon with its colours inverted: the same
  silhouette and sizes, so the Dock and the app switcher tell the two apart at
  a glance. Packaging selects committed `icon-nightly.png` and
  `icon-nightly.icns` assets; Stable continues to use its unchanged originals.
  `bun scripts/generate-nightly-icons.ts --write` derives the Nightly assets on
  macOS with ImageIO, inverting unassociated RGB while preserving every alpha
  value, image size and density. `--check` verifies both the generated and
  committed pixels, including every ICNS representation. Linux packaging uses
  these committed assets without requiring a macOS generator.
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
- Preview and candidate builds are versioned `<base>-<ring>.<YYYYMMDD>.<run>`
  by one workflow, so the updater orders them by date and then run, ignoring
  the ring label. A candidate newer than the installed preview is offered after
  a ring switch; switching back offers nothing until a preview build is newer
  than the installed candidate. Equal or older builds are never offered.
- Octant offers only stable updates. Nightly offers preview and candidate, and
  refuses a feed signed for `stable`.

## Rationale: whose host owns the data

Octant's host owns the data, so a nightly can never upgrade it out from under
the app a person works in. The cost is that Nightly tests new screens, while
host changes (agents, providers, tools) run only once they ship in Octant.
Rejected: the newest installed host owns the data and serves both apps.
Nightly would then test everything, but once it migrated the data Octant
alone could not open it until Octant updated (the host keeps a backup before
every migration), and a broken nightly host would hold the data until a fix or
a restore.
