# Browser profiles and extensions

This topic specification owns where a Browser page keeps its cookies and site
data, how a person signs in once and reuses that sign-in, what an agent may do
on a signed-in page, and how browser extensions are installed and enabled.
Architecture owns the boundary: who may open, read, and drive a Browser, and
what an approval covers
([Architecture: security and authority](../architecture.md#security-and-authority)).
Workspace owns the Browser pane
([Workspace: tool lifecycles](workspace.md#tool-lifecycles)). DESIGN.md owns
the controls and the approval card.

Status: profiles, their storage, site approvals, refusals, Settings, and cookie
import are built. Browser extensions are approved design, not yet built; the Extensions
section below is that design. Four smaller pieces of the profile design are not
built yet and are marked where they appear: purging a Project removes its
profile, a kept screenshot's record names the profile, the driver indicator and
floating preview show the profile's name, and a phone-started turn's approval
waiting for a local window.

## Profiles

A profile is the store a page keeps cookies, local storage, IndexedDB, cache,
and service workers in. There are three kinds:

| Profile  | Lives                                 | Shared by                                  | Survives a restart |
| -------- | ------------------------------------- | ------------------------------------------ | ------------------ |
| Private  | In memory, one per browsing context   | That page and the tabs it opens            | No                 |
| Project  | On disk, one per Work or Code Project | Every page of that Project, in any thread  | Yes                |
| Personal | On disk, one per host                 | Every page that chooses it, in any Project | Yes                |

- Private is the default for every page, the person's and the agent's. It is
  today's isolated, ephemeral context, unchanged.
- A Project profile is how a team of threads shares one sign-in: sign in to the
  staging site once in that Project's profile, and every thread of the Project
  that opens a page in it is signed in.
- The Personal profile is for sites the person uses across Projects. It is not
  their everyday browser's profile: Octant never opens another browser's profile
  in place. The `existing-profile` profile mode in the Browser contract is
  retired: the schema no longer decodes it, so no caller can ask for it. The one
  way another browser's sign-ins reach Octant is the person's explicit
  [cookie import](#cookie-import) into a Project or Personal profile.
- Chat has no Browser, so it has no profile. A Chat Project has no Project
  profile.
- The person signs in by typing into the page themselves. Octant saves no
  passwords and fills none.

### Choosing a profile

- The profile is chosen per page. A new page opens Private. The person changes
  it from the profile control at the left of the Browser toolbar's address field
  (Private, Project, Personal). Changing it opens the same address in the chosen
  profile as a new browsing context; the old context closes, and nothing it held
  (cookies, approvals, an agent's binding) carries over. The host turns "Project"
  into the thread's or window's own Project, so a caller cannot name another
  Project's profile.
- Tabs a page opens stay in its profile.
- The control remembers the person's last choice per Project for new pages they
  open. It never changes the profile of a page the agent opens.
- An agent's own new page is Private. The agent may ask to open a page in the
  Project or Personal profile (a `profile` argument on the Browser tool's
  `navigate` operation, honoured only when no page is open). The host decides,
  not the tool argument: the request raises a site approval naming the profile
  unless the person already remembered that (origin, profile) pair, and
  rebinding a page to a different model or authority still asks (see below). A
  page keeps the profile it opened in; the agent changes it only by stopping its
  Browser and opening again, which asks again.
- The thread-less Project Browser (the person's own browser for a Project) uses
  the same control. It has no agent, so no approval applies there.

### Storage

- The desktop app keeps a profile in a persistent Electron partition:
  `persist:octant-profile-personal` and `persist:octant-profile-project-<project id>`.
  A Private page keeps its in-memory `octant-browser-<context id>` partition.
- That partition is the only store a profile has. A profile page opens only in
  the desktop app's native Browser. When the native Browser is not available
  (a host with no desktop app, or the app not running), a profile page is
  refused with `profile-unavailable` rather than opened in a headless page;
  Private pages still fall back to a headless page as they do today.
- Rationale: the host routes each new browsing context to the native or the
  headless runtime and falls back to headless when the native owner is gone. A
  second, headless copy of a profile would hold different cookies from the
  native one, so pages of one "shared" profile would disagree about who is
  signed in. One store, refused elsewhere, keeps the promise exact.
- Profiles are never written inside a Project folder.
- On macOS, Chromium encrypts a persistent profile's cookies with a key it keeps
  in the login keychain. Octant adds no second encryption layer.
- Profiles are declared in the host data map (the desktop app tells the host the
  folder it keeps them in) and listed in Settings › Data & privacy under
  "Browser profiles", each with its size. The size is the space the profile's
  folder occupies; the host never reads a cookie to produce it. The Personal
  profile is always listed; a Project profile is listed once it has a store, by
  the Project's name, or as "A Project that no longer exists" when the Project
  is gone.
- Profiles are never in a thread export, a Canvas share, replica sync, a backup
  Octant makes, or the diagnostics export. A profile holds sign-ins, which are
  credentials.

### Signing out and clearing

- The profile control's menu has "Sign out of this profile…". After a
  confirmation it closes every page of that profile and clears all of its
  storage (cookies, storage, cache, service workers). The Settings row has the
  same action.
- Clearing is the person's, at a local window only, and has two scopes: all of a
  profile's storage (what "Sign out" does) or its cookies alone. The host closes
  the profile's pages, in the server's records and in the desktop app's views,
  before it removes anything, and journals `browser.profile-cleared@1` with the
  profile and the scope. The record names no site, cookie, or count.
- Archiving a Project closes its profile's pages and keeps the profile.
  Purging the Project removes the profile with the Project's other data (not
  built yet: until it is, a purged Project's profile stays listed in Settings,
  where the person can sign out of it).
- Turning a mode off closes its Projects' profile pages and keeps the profiles.

### Page rules that do not change

A profile changes only where site data is kept. Every other page rule stays as
it is for a Private page: downloads are blocked; camera, microphone, location,
notifications, devices, and screen capture are refused; only http and https
addresses open; a loopback HTTPS certificate is accepted only by the context
opened for it; the host's session ceiling and tab limit apply.

## Cookie import

A person can bring the sign-ins they already have in another browser on this Mac
into one Project or Personal profile, so they do not sign in again.

- **Only on the person's pick.** Settings › Data & privacy › Browser profiles has
  "Import cookies…" on each stored profile. The dialog lists the browsers
  installed on this Mac and each one's profiles by the names that browser shows;
  nothing is opened to produce the list. The person chooses a browser and one of
  its profiles and presses Import. Octant never imports in the background, on
  startup, on a schedule, or because an agent, a routine, a plugin, or a paired
  device asked. Only a local window can send the command, and the host refuses a
  paired device before it reads anything.
- **Which browsers.** Chromium-family browsers (Chrome, Chromium, Brave, Edge,
  Vivaldi, Arc) and Firefox. Safari is not offered: its cookie store sits behind
  a macOS privacy permission Octant does not ask for.
- **The browser's own encryption.** A Chromium-family browser on macOS encrypts
  cookie values with a key it keeps in the login Keychain as "<Browser> Safe
  Storage". Octant asks for that key through the platform's documented tool
  (`security find-generic-password`), which makes macOS show its own Keychain
  prompt naming the item. If the person declines, or macOS cannot answer, the
  import reports "macOS did not allow Octant to read the browser's cookie key"
  and imports nothing. A database with nothing encrypted needs no prompt, and
  Firefox stores values in the clear. The key is held in memory for the one read
  and dropped.
- **How it reads.** The host copies the browser's cookie database (and its
  write-ahead files) into a fresh owner-only temporary folder, reads the copy
  read-only, and deletes the folder, so the browser may be running and its own
  files are never touched. The source is accepted only if the listing offered it,
  so a profile name cannot become a path.
- **What it keeps and leaves.** Cookies for web hosts, with an expiry in the
  future (or none), a name and value a browser would store, and a shape its
  prefix rules allow, are set in the chosen profile's own session by the desktop
  app. Expired cookies, malformed ones, cookies partitioned by top-level site, and
  a Firefox container tab's cookies are left behind and counted. Imported cookies
  merge with what the profile already holds; a cookie of the same name, domain,
  and path is replaced.
- **Where cookies go.** From the source database, through the host's memory, to
  the desktop app over the authenticated loopback broker in batches of at most
  200, into the profile's session. They are never sent off this Mac, never
  written anywhere else, and never in a journal, a log, an answer to a window, a
  thread, a capture, an export, or anything an agent reads. A failure reports a
  fixed sentence that names no cookie or site.
- **The record.** The host journals `browser.cookies-imported@1` with the source
  browser, its profile id, the Octant profile, and the number imported and left
  behind. It holds no cookie, name, site, or value. A store failure part way
  still records what arrived.
- **Clearing.** "Clear cookies…" on the same row removes a profile's cookies and
  keeps its other storage (it is the `cookies` scope of the clear described
  above); "Sign out…" removes everything.

## The agent on a signed-in page

A Project or Personal page is treated as signed in, whether or not it is. The
host cannot tell, and a page in a shared profile may hold a sign-in another
thread made.

- **A site approval for every origin.** Before the agent reads or acts on an
  origin in a profile page, the thread raises a site approval that names the
  origin and the profile: "Let the agent use github.com in the Personal profile?"
  The approval covers reading (snapshots, screenshots, text) as well as acting,
  because reading a signed-in page reads the person's account.
- **Remembered per profile.** "Always allow" on that approval remembers the pair
  (origin, profile) in the shell settings
  (`rememberedBrowserProfileSites`), journaled like today's remembered origins:
  it grows only through the approval answer, and a settings write may forget a
  pair but never add one. The pairs are listed in
  Settings › Data & privacy › Remembered websites with the profile beside the
  site. A remembered Private origin never covers a profile page, and a pair
  remembered for one Project's profile never covers another Project's profile or
  the Personal profile.
- **Rebinding still asks**, as today: a remembered pair covers the page, not who
  drives it.
- **Credential fields stay protected.** Credential-field protection is always
  on: the agent never types into, reads, or receives a picture of a password or
  one-time-code field. A screenshot of a frame that holds one is withheld.
- **Plan mode** refuses every Browser operation on every profile, as it does
  today, except stopping the thread's own Browser.
- **Paired devices.** A paired device may not open a profile page, switch a page
  to a profile, answer a profile site approval, act on a profile page, list or
  clear a profile, or see a profile page's picture, text, address, or title. It
  sees "Signed-in page — open it on this Mac." (Built.) A turn that a phone
  started still raises the approval; the approval waits for a local window (not
  built yet: today a phone-started turn's approval is answered the way every
  Browser approval already is).
- **Unattended turns.** A routine's turn and a subagent's turn are refused on
  profile pages (`profile-needs-a-person`). A subagent's own Browser is Private.
- **Terminal Browser grant.** A CLI in a thread terminal may drive the thread's
  Private pages only; a profile page refuses it (`profile-needs-a-person`).
- **Taint.** What the agent reads on a profile page taints the thread as any
  Browser observation does.
- **Captures.** A screenshot the agent or person keeps from a profile page is
  kept by the thread under the usual
  [Browser captures](browser-captures.md) rules, and its record names the
  profile (not built yet: today the record does not name the profile).

The agent's activity on a profile page is visible: while the agent drives one,
the Browser toolbar's driver indicator and the floating page preview both show
the profile's name (not built yet; the toolbar's profile control already shows
the page's profile).

## Extensions

Browser extensions add features to pages (for example an ad blocker or a
reading tool). They run inside the page's profile and can see and change every
page they are allowed on, including what the agent reads.

### What works

- The desktop app loads extensions with Electron's `session.extensions` API.
  Electron supports Manifest V3 extensions with a subset of the `chrome.*`
  APIs; an extension that calls an unsupported API fails inside itself.
  Extensions that need native messaging (most password managers) or a store
  sign-in do not work.
- A headless host does not load extensions. Its Browser says "Extensions need
  the Octant app on this Mac."
- Manifest V2 extensions are refused.

### Installing

- Only the person at a local window installs an extension, from an unpacked
  extension folder chosen with the native folder picker (a host-issued binding
  receipt, as for Add folder). There is no web store.
- The host validates the manifest (Manifest V3, a name, a version), copies the
  folder into the host data directory under `browser-extensions/<extension id>/`,
  and journals `browser.extension-installed@1` with the name, version, content
  hash, and the permissions and host patterns it asks for. Later edits to the
  source folder change nothing; installing the folder again updates it and
  journals `browser.extension-updated@1` with the same fields.
- Installing never enables. A newly installed extension is off everywhere.
- An update that asks for any permission or host pattern the installed version
  did not is disabled in every profile, and each profile needs the person's
  confirmation again, showing what is new. An update that asks for the same or
  less stays enabled where it was, and Settings shows the new version.
- Removing an extension disables it in every profile and deletes its copy.

### Enabling

- An extension is enabled per profile: in the Personal profile, or in one
  Project's profile. It is never loaded into a Private page. An agent's own
  Private page therefore never runs an extension.
- Enabling shows what the extension asks for in plain words (the sites it can
  read and change, and its permissions) and needs the person's confirmation. It
  journals `browser.extension-enabled@1` with the profile; disabling journals
  `browser.extension-disabled@1`.
- Only a local window enables or disables. A paired device sees the list and
  changes nothing. An agent cannot install, enable, or disable an extension, and
  no plugin, skill, or structured reference can either.
- An extension's own pages (`chrome-extension://` addresses: popups, options)
  are outside every agent allowlist. The agent cannot open or act on them.

### Popups

Electron alone does not show an extension's toolbar popup or implement most of
`chrome.tabs`. Octant builds this support itself, after the extensions above
work without it, and takes no extension-support package:

- Choosing an extension in the extensions button's list opens its
  `action.default_popup` page in a small Octant popover anchored to the button,
  loaded in the page's profile. Clicking outside it or pressing Escape closes
  it. An extension without a popup page gets the `chrome.action.onClicked`
  event instead.
- The popup and the background worker get the part of `chrome.tabs` a popup
  needs, scoped to the page's profile: the active tab's address and title,
  sending a message to a tab's content script, and opening or updating a tab in
  that profile. A tab call never reaches another profile or a Private page.
- Anything else in `chrome.tabs` stays unsupported and fails inside the
  extension, as other unsupported APIs do.
- Rationale: the one package that adds popups is offered under GPL-3.0 or a
  paid commercial license; the maintainer chose to build the needed part
  rather than take either.

### Showing it

- The Browser toolbar shows an extensions button (a puzzle-piece icon) when at
  least one extension is enabled in the page's profile. It lists them, opens an
  extension's options page, and has "Manage extensions…", which opens Settings.
- When the agent drives a page whose profile has extensions enabled, the
  button carries a count badge, and the site approval card says so ("2
  extensions are on in this profile"), because they can read and change what the
  agent sees.
- Settings has a Browser extensions list under Data & privacy, beside Browser
  profiles: each extension with its version, where it is enabled, Enable per
  profile, and Remove.

## Refusals

| Reason                   | When                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `profile-not-local`      | A paired device tries to open, switch to, or answer for a profile page                                |
| `profile-needs-a-person` | A routine, a subagent, or a terminal Browser grant tries to use a profile page                        |
| `profile-unavailable`    | The Project is archived, its mode is off, the native Browser is not available, or the store is locked |
| `source-not-found`       | A cookie import names a browser or profile that is not on this Mac                                    |
| `keychain-refused`       | The person declined the Keychain prompt for the browser's cookie key, or macOS would not answer       |
| `source-unreadable`      | A cookie database could not be opened or decrypted, or the browser keeps no key in the Keychain       |
| `extension-not-local`    | A paired device or any non-person caller tries to install, enable, or disable an extension            |
| `extension-unsupported`  | The manifest is not Manifest V3, or the host has no desktop app                                       |

Each refusal is a value the pane shows in words; none is a silent no-op.

## Rationale

- **Rationale for per-pair approvals.** Remembering an origin for Private pages
  is safe because a Private page carries no sign-in. The same origin in a
  profile acts as the person's account, so the grant has to name the profile it
  covers, and a grant for one profile cannot spill into another.
