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

Status: approved design, not yet built. Until it is built, every Browser page is
Private, as described below.

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
  their everyday browser's profile: Octant never opens, reads, copies, or imports
  another browser's profile, cookies, history, or saved passwords. The
  `existing-profile` profile mode in the Browser contract is retired and is
  refused everywhere.
- Chat has no Browser, so it has no profile. A Chat Project has no Project
  profile.
- The person signs in by typing into the page themselves. Octant saves no
  passwords and fills none.

### Choosing a profile

- The profile is chosen per page. A new page opens Private. The person changes
  it from the profile control at the left of the Browser toolbar's address field
  (Private, Project, Personal). Changing it opens the same address in the chosen
  profile as a new browsing context; the old context closes, and nothing it held
  (cookies, approvals, an agent's binding) carries over.
- Tabs a page opens stay in its profile.
- The control remembers the person's last choice per Project for new pages they
  open. It never changes the profile of a page the agent opens.
- An agent's own new page is Private. The agent may ask to open a page in the
  Project or Personal profile (a `profile` argument on the Browser tool's open
  operation); that request always raises a site approval naming the profile (see
  below), and the host decides, not the tool argument.
- The thread-less Project Browser (the person's own browser for a Project) uses
  the same control. It has no agent, so no approval applies there.

### Storage

- The desktop app keeps a profile in a persistent Electron partition:
  `persist:octant-profile-personal` and `persist:octant-profile-project-<project id>`.
  A Private page keeps its in-memory `octant-browser-<context id>` partition.
- A host without the desktop app drives a headless page. Its runtime keeps a
  profile as a persistent context in a user-data directory under the host data
  directory, `browser-profiles/personal/` and
  `browser-profiles/project-<project id>/`, created with mode `0700`. The
  runtime holds at most one persistent context per profile and opens every page
  of that profile in it.
- Profiles are never written inside a Project folder.
- On macOS, Chromium encrypts a persistent profile's cookies with a key it keeps
  in the login keychain. Octant adds no second encryption layer.
- Profiles are declared in the host data map and listed in Settings › Data &
  privacy under "Browser profiles", each with its size.
- Profiles are never in a thread export, a Canvas share, replica sync, a backup
  Octant makes, or the diagnostics export. A profile holds sign-ins, which are
  credentials.

### Signing out and clearing

- The profile control's menu has "Sign out of this profile…". After a
  confirmation it closes every page of that profile and clears all of its
  storage (cookies, storage, cache, service workers). The Settings row has the
  same action.
- Archiving a Project closes its profile's pages and keeps the profile.
  Purging the Project removes the profile with the Project's other data.
- Turning a mode off closes its Projects' profile pages and keeps the profiles.

### Page rules that do not change

A profile changes only where site data is kept. Every other page rule stays as
it is for a Private page: downloads are blocked; camera, microphone, location,
notifications, devices, and screen capture are refused; only http and https
addresses open; a loopback HTTPS certificate is accepted only by the context
opened for it; the host's session ceiling and tab limit apply.

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
  (origin, profile), journaled like today's remembered origins, and listed in
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
  to a profile, answer a profile site approval, or see a profile page's picture.
  It sees "Signed-in page — open it on this Mac." A turn that a phone started
  still raises the approval; the approval waits for a local window.
- **Unattended turns.** A routine's turn and a subagent's turn are refused on
  profile pages (`profile-needs-a-person`). A subagent's own Browser is Private.
- **Terminal Browser grant.** A CLI in a thread terminal may drive the thread's
  Private pages only; a profile page refuses it (`profile-needs-a-person`).
- **Taint.** What the agent reads on a profile page taints the thread as any
  Browser observation does.
- **Captures.** A screenshot the agent or person keeps from a profile page is
  kept by the thread under the usual
  [Browser captures](browser-captures.md) rules, and its record names the
  profile.

The agent's activity on a profile page is visible: while the agent drives one,
the Browser toolbar's driver indicator and the floating page preview both show
the profile's name.

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
  source folder change nothing; installing the folder again updates it.
- Installing never enables. A newly installed extension is off everywhere.
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

| Reason                   | When                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `profile-not-local`      | A paired device tries to open, switch to, or answer for a profile page                                 |
| `profile-needs-a-person` | A routine, a subagent, or a terminal Browser grant tries to use a profile page                         |
| `profile-unavailable`    | The Project is archived, its mode is off, or the profile cannot be opened (for example a locked store) |
| `extension-not-local`    | A paired device or any non-person caller tries to install, enable, or disable an extension             |
| `extension-unsupported`  | The manifest is not Manifest V3, or the host has no desktop app                                        |

Each refusal is a value the pane shows in words; none is a silent no-op.

## Decisions for review

- **Extension toolbar popups.** Electron alone does not show an extension's
  toolbar popup or implement most of `chrome.tabs`. The MIT-licensed
  `electron-chrome-extensions` package adds both. Without it, extensions get
  content scripts, a background service worker, and an options page, which is
  enough for page-changing extensions but not for ones driven from a popup.
  This specification builds without it first; adding it is a separate change
  that needs the maintainer's approval of the dependency.
- **Rationale for per-pair approvals.** Remembering an origin for Private pages
  is safe because a Private page carries no sign-in. The same origin in a
  profile acts as the person's account, so the grant has to name the profile it
  covers, and a grant for one profile cannot spill into another.
