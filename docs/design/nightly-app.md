# Octant Nightly

This topic specification owns the second desktop app, Octant Nightly: what
makes it a separate app, how it shares Octant's data while both run, which
builds ship as it, and how a person gets it. Architecture owns the boundary:
one host per data folder, how updates are verified, and which rings exist
([Architecture: persistence](../architecture.md#persistence) and
[current release boundary](../architecture.md#current-release-boundary)).
DESIGN.md owns Settings presentation.

Status: identity, packaging, inverted icons, update-ring and authenticated window-bootstrap
foundations are implemented. A compatible authenticated Stable app can register
an ordinary Nightly window and give its own bundled renderer a short-lived host
capability. Development, ad-hoc and incompatible builds refuse. Nightly never
imports the host-owning desktop module, initializes host credentials, owns a
host or migrates shared data. When Stable is closed, Nightly can ask a validated
installed Stable to start its host without opening a Stable window. The bounded embedded Browser frame/input path is implemented. Complete Browser
and other native broker parity remain unfinished; this is not yet a usable
second app.

The remaining delivery includes complete embedded browsing parity,
full lifecycle acceptance, shared sign-in operations and the functional
release preflight. The full `octant-nightly` command is built
([below](#the-octant-nightly-command)). Coexistence and rollback
still need their remaining implementation and packaged evidence. Bounded native
lease reconnect is implemented; full signed lifecycle acceptance remains separate. The
preview workflow selects each run's flavor, artifact and payload-smoke paths
from its ring. An explicit early gate stops only the scheduled Nightly run
before build, signing or publication; a dispatched run builds Octant on
`candidate` and is not held by it. The functional client change must replace
the gate with lifecycle, credential and native-surface parity evidence. Stable
release and local packaging are unaffected by that gate.
Nothing in this foundation authorizes installation or publication.

The two-binary channel split below (2026-11-05) is built: Octant follows
`stable` or `candidate`, Nightly follows only `preview`, packaging and the
release workflow stamp the flavor from the ring, and the scheduled Nightly run
alone is held by the functional-client preflight. The Octant Nightly row in
Octant's Settings › Updates is built for packaged macOS Octant, including its
three checks; a signed install from a published Nightly build has not yet been
exercised. Nightly's own host on separate test data is built for macOS: the
Data choice in Settings › Updates with its relaunch offer and removal, the
Test data label, startup on its own folder, port, logs and Keychain service
names, and the host payload and worker runtime in packaged Nightly. A signed
Nightly running its test host has not yet been exercised.

Every desktop channel now has a class in Nightly's client mode, and Octant-only
administration is absent from a Nightly client window
([below](#what-a-nightly-client-window-offers)). The four maintainer decisions of
2026-11-06 ([below](#maintainer-decisions-2026-11-06)) are recorded; apart from
that classification they are not built.
[Before Nightly publishes](#before-nightly-publishes) lists what the first
Nightly publication still needs.

## Maintainer decisions (2026-11-06)

1. **Native operations through the host.** Nightly reaches the host's native
   operations by the host trusting a distinct native-main token per Nightly
   window, admitted only on a closed allowlist of routes and bound to that
   window's native lease. The token is neither the renderer's window
   capability nor Octant's administrative bridge secret, and it ends with the
   lease. Administration stays with Octant and is hidden in Nightly: remote
   access and the private listener, hub administration, device pairing and
   paired computers, launch sessions, owner unlock and host identity.
   The channel classification below and the host's token admission are
   built; the brokered flows that use it are planned.
2. **Embedded Browser parity blocks publication.** Every gap in the embedded
   Browser blocks the first Nightly publication, accessibility (VoiceOver in
   the embedded page) included. A companion window stays rejected. Planned.
3. **Linux Nightly stays in scope.** It needs its own Linux client trust design,
   because Linux has no code-signature check or audit-token peer identity to
   admit a Nightly main by. Designed, not built; the design comes first.
4. **The signed feed names its app.** The signed update feed will name the app
   it is for (Octant or Octant Nightly), and each app refuses a feed for the
   other with a clear message, beside the existing ring check. Planned.

## Two apps, one set of data

Octant ships as two apps that install side by side and can be open at the same
time (maintainer decision, 2026-11-05):

- **Octant** is the app a person works in. Settings › Updates has a three-option
  channel switch, Stable | Preview | Nightly. Stable follows the `stable` ring.
  Preview follows the `candidate` ring: pre-release builds of the next stable
  version, cut from the ref a maintainer chooses. Nightly keeps Octant on the
  `candidate` ring too and adds the Octant Nightly install row; Octant never
  follows `preview`. Because Preview and Nightly share a ring, the choice is
  stored as its own shared setting, `updateChannel`, beside `releaseRing`; where
  it is absent it derives from the ring (`stable` is Stable, `candidate` is
  Preview), and a stored channel that disagrees with the ring is ignored. One
  binary serves every channel; the channel is an in-app choice, not a second
  download.
- **Octant Nightly** follows Nightly (the `preview` ring): scheduled builds of
  `main`. It shows what is next. It has no channel choice.

Ring ids stay as they are because feed paths and the version tags installed
builds follow carry them; Settings shows the names Stable, Preview and Nightly.

Both apps work on the same threads, Projects, settings, sign-ins, and history.
A thread started in one is live in the other, as it is in two windows of one
app. For development and testing, Nightly can instead run its own host on
separate test data ([below](#nightlys-own-host-for-development-and-testing)).

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
  silently. That wording is kept for a host that lacks the feature; a channel
  Nightly does not answer for another reason refuses by its class
  ([below](#what-a-nightly-client-window-offers)).
- The host keeps running while either app has a window open. Quitting one app
  leaves the other working; quitting the last one stops the host, as today.
  Updating Octant restarts the host, and Nightly reconnects when it is back.
- The credential broker and Keychain items stay with the host's app, so a sign-in
  made from either window is stored once.
- Octant on Preview runs a newer host on the person's real data. That is the
  person's choice of channel, and the forward-only rule still holds: after a
  Preview host migrates the data, switching back to Stable offers nothing until
  a stable release at least as new exists, so an older host never opens it.

## Nightly's own host for development and testing

Nightly can run a host of its own, for development and testing, on data that is
never Octant's:

- It is opt-in. Nightly's Settings offers **Data: Octant's data** (the default)
  or **Separate test data**. The choice is stored in Nightly's window storage
  and applies on the next launch; Nightly says so and offers to relaunch.
- With separate test data, Nightly starts its own host on
  `~/Library/Application Support/Octant Nightly/Test Data` (or its platform
  equivalent) and its own loopback port, `13774`. It never reads, writes,
  locks or migrates Octant's data folder, never connects to Octant's host, and
  never asks Octant to start one. Octant and Nightly can both run, each with
  its own host.
- Credentials Octant keeps in the Keychain stay apart: the test host's
  credential broker stores its items under Nightly's own Keychain service
  names, so a key or secret saved for test data never replaces or reads one of
  Octant's, and a person enters them again for test data. Provider command-line
  tools keep their own sign-ins in the home folder (`~/.claude`, `~/.codex` and
  the like), and those are shared with Octant.
- New host behavior (agents, providers, tools, persistence) from `main` runs
  here, which the client mode cannot test. The test data is disposable:
  Nightly's Settings can remove it (moved to the Trash) when its host is
  stopped.
- The window shows a quiet "Test data" label beside the Nightly label, so a
  person never mistakes it for their real work.
- Packaged Nightly therefore carries the host payload and its worker runtime,
  as Octant does. The host role starts only from this stored choice; the
  [fixed entry](#fixed-packaged-entry) still refuses caller-selected roles,
  scripts and data folders.
- `OCTANT_DATA_DIR` and `OCTANT_SERVER_PORT` still override either app, as for
  a development build. Pointing Nightly's own host at Octant's folder that way
  is the developer's explicit choice and is not a supported configuration.
- The choice is `data-choice.json` in Nightly's window storage. Only an exact
  `{"data":"test-data"}` selects test data; a missing, oversized, linked or
  malformed file means Octant's data. The main process reads it once at launch
  and no renderer request changes the running role.
- Separate test data is macOS only for now. Linux Secret Service items carry no
  store scope, so a Linux test host would share Octant's credentials; Nightly
  does not offer the choice there, and a stored choice refuses with a message
  instead of starting a host.
- Nightly refuses to start its test host when its folder is, or lies inside,
  Octant's data folder, or contains it, unless `OCTANT_DATA_DIR` set the folder
  explicitly. A Nightly process that reaches the host-owning desktop without a
  test-host role (its choice changed or became unreadable during launch)
  refuses and quits; it never falls back to Octant's folder or port `13773`.
- The test host's service log is `~/Library/Logs/Octant Nightly/service.log`,
  passed to its host as `OCTANT_LOGS_DIR`, so it never shares Octant's log.
- Its default folder is `~/Octant Nightly` rather than `~/Octant`, passed as
  `OCTANT_DEFAULT_FOLDER`, so Work and Code without a Project, the artifact
  mirror and managed repository clones never touch Octant's files. Its Keychain
  family reaches the host as `OCTANT_KEYCHAIN_SERVICE_FAMILY`, so the data map
  names the services it really uses; any other value refuses host startup.
- Still shared with Octant, as for any second host on the same account:
  provider command-line configuration and sign-ins in the home folder, and
  developer toolchains such as the Android SDK and Xcode.
- A Nightly client and the test host take the same single-instance lock in
  Nightly's window storage, so only one runs at a time and a second launch
  focuses the first. Removal also refuses while the test folder's owner receipt
  names a live process, and when the folder's real path is not its fixed path.
- A relaunch asked for from Settings arms only once its quit is accepted; a
  cancelled quit forgets it.
- The test host's macOS Keychain services are named
  `app.octant.desktop.nightly.test-data.*` rather than `app.octant.*`. Because
  Octant's unscoped legacy items live only under Octant's names, the helper's
  legacy re-scoping can never claim one for test data.
- Removal moves only the fixed test folder to the Trash, refuses while the test
  host runs, and refuses a linked folder.

## Starting a closed Stable host

On packaged macOS, a native `not-running` status can trigger one launch of the
installed Stable app. Launch Services locates the candidate; its registration
and path grant no trust. Before launch, Nightly validates its own primary-app
identity and the candidate's same-Team Developer ID signature, hardened runtime,
retained library validation, strict nested-resource seal, local volume, fixed
entry, ASAR integrity metadata and fuses. The signed `host-only-v1` capability
marker additionally proves that Stable recognizes this role. Missing, older,
unsigned or invalid artifacts refuse. Ambiguous or invalid status never launches
a replacement, and no shell command or caller-selected executable is accepted.

The native launcher opens only that validated bundle URL without activation,
recent-item changes, prompts, a forced new instance or substitution of an app
at another URL. Stable accepts the exact `--octant-host-only` role and uses its
existing single-instance lock and host lifecycle. It starts or attaches the host
before advertising native status and opens no workspace window. A repeated
host-only process entry leaves the existing shell alone; an ordinary launch can
still open it. Nightly never starts a second host or opens shared Browser profiles.

A launch receipt grants no connection authority. Nightly retries authenticated
status for at most 15 seconds after launch, with every native operation separately
bounded; a status call already in flight may take up to its own three-second
bound. Only a fresh valid response can proceed to the existing authenticated
window protocol. Failure keeps the renderer closed. No installer or persistent
service is involved. Security validation is not an atomic filesystem snapshot,
and a native launch deadline cannot cancel an OS launch already submitted.
Native close reports failure while an OS launch completion is still outstanding.

Unsigned native refusal and a synthetic host startup fixture do not establish
signed installed-app launch, complete host payload, simultaneous-start races or
coexistence. Full signed quit-one/quit-last and reconnect acceptance remain
separate validation.

## Keeping the host for current clients

An in-app Quit command closes Stable's registered workspace windows while
Nightly has at least one acknowledged, unexpired window lease for the current
host instance. The same Stable main process keeps the host and native brokers
alive. Its external Nightly offscreen Browser windows are not local workspace
windows and remain owned. Ordinary local-window close retains its existing
menu-bar behavior. An ordinary launch or reopen can bring Stable's shell back.

The lease owner publishes count changes only after acknowledgement, and removes
revoked state before notifying observers. Pending acquisition, expired leases,
other host instances and failed replies cannot retain a host. Observer failure
cannot skip lease or context cleanup. A closing host admits no new native lease.

When the final current Nightly client leaves after Stable's UI quit, the host
uses the existing fresh active-work confirmation before its normal shutdown.
Cancellation keeps the background host available. A new client or ordinary
reopen during that cancellable wait withdraws the older conditional quit. If a
new client arrives and leaves before the old question settles, the host checks
the new empty state once afterward. A person's cancellation of an unchanged
question does not prompt again. Acceptance closes native admission synchronously
before window-state flushing or cleanup can await, so a later registration
cannot slip between the final check and host shutdown.

Local close and reopen have an admission generation. Reopen waits for a pending
local close; an older pending window registration cannot construct or resurrect
a window afterward. A reopen that joins such a retired opening retries it under
its own admission, so one reopen always shows a window. The retained UI close never permanently shuts down Project
window lifecycles. Terminal helper/resource cleanup still runs only through the
existing accepted-quit path. OS signals, logout, updater quit and unclassified
termination requests keep that terminal behavior; they are not person-scoped UI
quit requests.

A host-only launch waits 30 seconds after the host is ready for its first current
Nightly lease. This spans the existing 15-second status retry, a status operation
of up to three seconds, a window registration operation of up to three seconds,
and a finite scheduling margin. It does not extend any native or lease deadline.
Empty notifications and unsuccessful acquisition do not restart the grace. A
real first lease cancels it; a later final-client departure uses the conditional
quit above. Ordinary reopen cancels the grace, and a reopen that
arrives while the host is still starting means the grace is never armed. If no client arrives, its expiry
uses the same active-work confirmation and current-intent check.

This lifetime policy is implemented before the existing shutdown callback.
The independent native-helper and acquired-resource cleanup changes keep their
own ownership and evidence. An extracted startup or synthetic peer fixture is
not full signed-app or host-payload acceptance.

## Reconnecting after host loss

An opened Nightly window that loses its native lease destroys its stale renderer
before recovering. One recovery attempt runs at a time, for at most 30 seconds
from loss, including cleanup of the old lease. Refused attempts back off from
250 milliseconds to a two-second maximum. Existing native operation deadlines
remain three seconds; an exchange already in flight can take its own bounded
cleanup time. A malformed receipt ends recovery immediately. Exhaustion explains
the failure and closes Nightly. Ordinary first-launch refusal does not start
this recovery loop.

Every attempt registers a new native handle and obtains a fresh host instance,
server-issued window identity, renderer identity and capability. The native
window protocol independently validates the current peer's audit token and full
signed identity for each exchange; the one-shot status preflight is not reopened.
No cached descriptor grants authority, and recovery never launches a host or
trusts a discovered replacement. Person close or quit cancels the loop and
destroys/revokes an acquisition that completes late. A pending renderer load
cannot show a window after cancellation or lease expiry.

Only normal in-memory window bounds carry into the fresh window. Old window
capabilities, layout and drafts are not migrated to a new server window identity;
window-state continuity remains separate work. Reconnection never resumes an
interrupted provider turn implicitly.

An app-managed host restart grants a grace only when Stable is already retaining
its host for a current authenticated Nightly client. Its restart wait is bounded
to 30 seconds, spanning the existing bounded host stop and 15-second readiness
wait. Repeated requests cannot extend that wait. After actual host readiness,
an absent fresh client receives the existing 30-second first-client grace; a
fresh current lease cancels it. Failure or expiry uses the normal guarded
last-client quit. Ordinary reopen invalidates the grace. Ungraceful host loss
does not receive this restart grant, and an arbitrary restart request cannot
create retained intent.

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

The current implementation routes an authenticated native window's human
presentation through the host's existing Browser ownership. Stable alone creates
a hidden ordinary Browser window and opens its profile partition. It captures
at most one CSS-sized image at a time without showing or activating that window.
Unchanged image bytes do not advance the displayed frame sequence. A pure current-context
check requires the same window, thread or Project, native backend, active
binding and unexpired context before any presentation operation and after an
await. Creating a presentation never creates a Browser context or grants an
origin or permission.

The closed human route additionally authenticates a main-only renderer identity
header against the current native window lease. Ordinary renderer request
headers strip that header and never add it. Nightly main supplies it only after
checking its actual owned, visible and focused window; neither a renderer body
flag nor an ordinary shell identity header grants human presentation. The private
Browser broker secret stays in Stable. Agent reads, screenshots and custody
never consume these human frames, and an agent observation hold does not blank
the person's display.

Each presentation has a fresh epoch bound to its active tab and document. It
retains one published frame for retransmission until its exact acknowledgement
and only the newest pending image. Images are bounded before encoding and JPEG
bodies are bounded before decoding; display and input share CSS-sized coordinates,
with a maximum of 1920 by 1200 pixels and 4 MiB encoded image bytes. Hidden,
expired, replaced or detached epochs cannot publish pixels or accept new input.
A retired detach cannot hide its successor, and expiry also removes the profile's
visible-page eligibility. Observer failures cannot skip presentation cleanup.

Pointer motion may coalesce, while accepted key/button releases retain their
ordering and bypass the bounded replaceable queue. Key, character, button and
wheel events are never coalesced: they queue in order under their own larger
bound, so a slow frame request cannot drop typed text. The person's input is
delivered while an agent action runs, as in a native Browser view; it counts as
person input, so the agent must read the page again before its next keystroke
or click. Releases match an accepted
hold in the same presentation epoch, including across frame advance. New stale
coordinate actions refuse. The renderer remembers each physical key's original
down value so a modifier change cannot strand its release. Enter sends its
required carriage-return character only while Enter or Return is held. Tab stays
inside the page; Control-Escape moves focus out and retires the presentation to
release held inputs. Normal pointer-capture completion keeps the presentation
attached; unexpected capture loss or blur retires it.

### Standard text composition

The human input path supports native composition in text, search, URL,
telephone, email and number inputs, textareas and rich text editors (an editing
host with `contenteditable`), in the main frame and in nested frames. Stable's
sandboxed document-start preload runs in every frame of the hidden window and
installs the first window-capture focus observers before page scripts. It
exposes a read-only bridge only in isolated world 1002, separate from agent
scripts, and names that world so Stable can find it in a nested frame. The bridge
returns a fresh field incarnation, its kind and either bounded UTF16 selection
offsets or a page-computed caret, never field contents or surrounding text. A
document replacement that removes those observers refuses until a real
navigation installs the preload again. Date, time, color and other non-text
inputs stay unsupported.

The field's kind decides where its caret comes from:

| Kind     | Fields                                 | Caret                                                         | Nightly receives         |
| -------- | -------------------------------------- | ------------------------------------------------------------- | ------------------------ |
| Text     | text, search, URL, telephone; textarea | native lookup at the selection start, on its own line         | identity, offsets, caret |
| Field    | email, number                          | start of the field's text box; no selection API exists        | identity, caret          |
| Rich     | `contenteditable` editing host         | the page's own line box at the selection start, one line high | identity, caret          |
| Password | password                               | native lookup, kept in Stable for the editing menu            | identity only            |

Stable binds its own hidden window once to an opaque main-only native object.
The public requested-range text-input API returns caret geometry for the observed
selection start of a text or password field. Chromium answers it for whichever
frame holds focus, already in the page's coordinates, and for a multiline field
the rectangle is the caret's own line. Native cached selection and marked-text
flags can lag hidden Chromium documents, so they do not establish the field or
its selection. A lookup may return that point or the exact host-observed selected
span, never a partial or displaced range. The host rechecks the same field and
selection after geometry lookup. A rich editor's caret is the line box at the
collapsed selection start, or the empty line's own start, never the whole
selection or editor; a selected range stays bounded to its first line. No native
pointer crosses the presentation protocol.

A password field never sends its value, offsets, caret or selection text to
Nightly: its editor is its identity alone, and composition refuses it at both
the host and the client. Nightly focuses a local password field instead of its
composition input, so Chromium in Nightly turns on macOS secure event input and
the ASCII-capable input sources for as long as it has focus: no input method
window, accessibility value or input observer sees the person's keys. The keys
still reach the page over the ordinary input lane, and a dead key's composed
character follows as a typed character; the local field never holds it.

**Nested frames.** The top document's bridge reports only that focus sits in a
frame. Stable then follows the focus chain through its own protocol attachment,
at most 8 frames deep: in each document a Stable-owned isolated world reads the
focused frame element and where that frame's content sits, without scrolling the
page; a frame on the same site shares its parent's session, and a frame on
another site is its own target, announced by the attachment's automatic frame
attachment. The focused frame's bridge world is found by its name in that
frame's session. A caret the page computes is moved by the frame's offset and
scale into the top page's coordinates. One frame holds focus at a time, and a
chain that cannot be followed refuses rather than guessing. Composition commands
go to the page, and Chromium delivers them to the focused frame on either site.
The automatic frame attachment is shared with agent actions, which still send
their commands to the page itself.

Nightly positions its local native input context at that caret. It holds only
the person's current candidate, at most 256 well-formed UTF16 code units. Closed
begin, update, commit and cancel operations bind an issued composition identity
to the current view, document, field and presentation. An old cancellation cannot
act on a successor field. Focus, layout, navigation, hide and lease loss retire
the transaction; cleanup precedes a successor acquisition. A queued terminal
operation is not treated as a completed commit. A real operating-system commit
that precedes blur cannot be undone by later cancellation. Native event trust
flags are not authority; the owned main, current native lease and server checks
remain authoritative.

Pointer input is admitted against the exact current displayed frame before
awaiting composition cleanup, then dispatched once only within the same current
layout and lease. Paired releases stay ordered behind their down. A frame that
was already stale at admission still refuses. The person's input has its own
ordered lane and never waits behind an agent action. Composition is the
exception to delivery during agent work: begin, update and commit refuse while an
agent action holds the surface, rechecked immediately before each edit is sent,
so an agent action that starts while an edit awaits its field never has its text
changed mid-action; cancellation still reaches the field. Control-Escape blurs
whichever element inside the page holds focus, including the text input.

### Local native menus

Nightly's own shared renderer uses the same bounded native dropdown and context
menu contract as Stable. Its main validates the current owned top-level window,
main frame and bundled renderer before opening the menu, and rechecks that owner
before returning a selected item. Navigation, window retirement and superseding
menus dismiss the old instance. A selected menu-entry ID grants no host authority;
the existing renderer callback still uses ordinary server authorization.

Ordinary editable fields in the Nightly shell receive the platform editing menu.
These roles act on Nightly's own fields. They do not forward clipboard data,
editing commands or menus into the Stable-owned page behind an embedded image.

### Standard page editing menus

A pointer right-click in an already focused, supported field (any kind above, in
any frame) opens a native editing menu in Nightly. Shift+F10 or a context-menu key
uses the same supported field through a paired user key gesture. Stable captures that field's
issued incarnation before forwarding the gesture, accepts only an actual
editable context-menu event, from whichever frame reports it, and rechecks the
field in the focused frame, the same view, presentation,
layout, field and live native lease before executing one enabled action. The
keyboard gesture binds a host-issued pending identity to its captured field and
selection. Only its matching user key release may activate it. Cleanup key
releases cannot activate a menu. Where Chromium does not emit a menu event for
the key, Stable forwards a fixed native right-button pair just inside the
verified selection-start rectangle, within the current actual viewport. The
same field and selection must still match after the geometry lookup. No
renderer-selected coordinates or synthetic DOM menu event are accepted. Fixed
Undo, Redo, Cut, Copy, Paste and Select All commands use Stable's native page
methods. Clipboard contents stay in the local OS operation and never enter the
menu response or renderer JavaScript.

Menu identities and edit flags travel only between the authenticated main
processes. The ordinary renderer IPC refuses menu read, watch, action and dismiss
requests, including pending-key activation. The main consumes pending identities
without exposing them through the preload. A menu identity grants no additional authority. A bounded main-only
watch dismisses the exact native popup on source retirement, field replacement,
navigation, layout change, hide or lease loss. An old callback or detach cannot
act on or dismiss its successor. Already committed native effects are not undone
by later cancellation. Before a native popup opens, the main releases the same
presentation's held source keys and buttons. New presses while that popup is
preparing, open or retiring belong to the popup and are not forwarded to its
page; matching held releases remain available. A queued earlier press cannot
reappear after popup retirement.

Native evidence covers pointer Select All and Undo, plus Shift+F10 invocation,
Select All, reopening a selected range, dismissal and reinvocation. The physical
context-menu key uses the same policy but has no separate hardware acceptance.
Clipboard actions are wired through the same closed commands but have no live
clipboard acceptance evidence. Keyboard navigation within an open menu is
separate from invoking it. A password field's menu offers what Chromium enables
there, which never includes Cut or Copy. Spelling remains separate parity work; link
and image menus, select lists and page accessibility follow below.

### Page popups

A page popup in Stable's hidden window would draw over a window nobody sees, so
Stable holds it and offers it over the same authenticated presentation route.
Nightly shows it in its own window. No new route, token or admission is
involved: the popup requests carry the presentation's existing lease, main-only
renderer identity and current-context checks, and the ordinary renderer IPC
refuses them.

- **Select lists.** The hidden window's sandboxed document-start preload, in the
  same private isolated world as the editable observer, holds a trusted press
  that would open a single-choice `<select>`, in any frame (button press, Space,
  F4, Alt+arrow, and the plain arrows on macOS) and keeps Chromium's popup
  closed. Any other trusted press ends the hold. Stable offers a hold only when
  it is at most 1.5 seconds old, no older than the person's own press through
  the presentation, and made while no agent action held the page and none has
  run since; an agent's click on a list is held but never offered. The offer
  carries at most 512 options, each label at most 256 UTF16 units, their
  optgroup labels, disabled flags, the selected index and the field's
  rectangle, moved by the frame's offset into the page's coordinates. A list
  whose options, group headings and separators exceed 1,024
  native menu entries is refused as too many rather than cut short. Nightly shows the options as radio items in a native menu, with
  group headings, and places the selected item at the field (the press point and
  the cursor give the Browser image's origin). The chosen index returns to
  Stable, which sets it on the same held field and fires `input` then `change`,
  as Chromium's own popup does. A list box (`multiple` or `size` above one) draws
  inside the page and needs no popup.
- **Page dialogs.** Stable's own protocol attachment on the hidden window holds
  `alert`, `confirm` and `beforeunload` dialogs while no agent action runs; while
  one runs, the agent's fixed dialog policy answers instead, and a debugger
  someone else attached leaves dialogs alone. A dialog's message is bounded to
  2,048 UTF16 units. Nightly shows it as a sheet on its window under the fixed
  heading "This page says", never with page text as the heading;
  `beforeunload` uses fixed Leave and Stay copy. Electron offers no page
  `prompt`, so Stable answers one as cancelled, as its own Browser does. One
  dialog is held at a time; a second opening while one is held is dismissed.
  When an agent action starts while a dialog is held for the person, the
  page is blocked behind it, so the action's fixed policy answers that dialog,
  reports it to the agent and retires the person's popup. After three dialogs
  within 10 seconds in one page load, Stable answers every further dialog of
  that load by the same fixed policy, however long the page waits, until a new
  document loads, and tells the person once with a system
  notification instead of a sheet. Chromium reports a dialog from any frame,
  on the page's site or another, to the page itself, so a frame's dialog is held
  the same way. Electron has no sheet scoped to part of a
  window, so a held dialog stays window-modal; that limit keeps a page from
  holding the window with dialog after dialog.
- **Link and image menus.** A right-click on a link or image right after the
  person's own press offers a menu with Open Link in New Tab, Copy Link
  Address, Copy Image and Copy Image Address, as they apply. The page's
  addresses stay in Stable: the menu carries only whether a link and an image
  are present, and Stable performs the chosen action with its own clipboard or
  opens the link as a new tab of the same Browser context under the person's
  ordinary navigation admission and tab limit. Saving an image is not offered,
  because the person's Browser blocks downloads.
- **File choosers.** Stable intercepts the hidden window's file chooser through
  the same protocol attachment, so Chromium opens no panel there, and offers it
  only right after the person's press. Nightly shows its own open panel,
  allowing several files only for a `multiple` field. Electron's open panel
  takes no abort and has no call that closes it, so when Stable retires the
  chooser (an agent navigates, say) the panel stays until the person closes
  it; its choice then reaches nothing, and Nightly shows that window's next
  popup only after the panel has closed. At most 8 absolute paths
  of at most 1,024 UTF16 units each return, under the route's body bound; Stable
  hands the field only paths that are existing regular files, through
  Chromium's file-input command for the same chooser node and document. That
  command waits behind any agent action and is refused while one holds the
  page. A chooser in a frame on the page's own site is held like the page's. A
  frame on another site is its own protocol target: when automatic attachment
  announces it, Stable enables its page events and holds its choosers in that
  session, at most 64 frame sessions per page, and answers through the same
  session. When the person's watch ends while an agent keeps the attachment,
  each frame session stops holding choosers too.
- **New windows.** `window.open` and `target="_blank"` follow Stable's existing
  Browser policy: the page's own popup is refused, and no free window opens in
  either app.

Every popup has a fresh single-use identity issued by Stable. An answer is
refused after the page navigated, the tab changed, the presentation retired or
an agent action took the page, for a stale or spent identity, for a disabled
option, and for a kind that does not match the popup. While a popup is open,
Nightly releases the presentation's held keys and buttons, keeps new presses out
of the page, and sends Stable a dismissal when the person closes it without a
choice or the presentation retires. Nightly shows a popup only while its
window is visible and focused, never shows the same pending popup twice, and
holds a bounded watch on the shown popup so its sheet or menu closes as soon as
Stable retires it, as when the page closed its own dialog. Page text in a popup is display copy and
grants nothing.

Evidence: contract tests for the bounds; Stable surface tests for dialog,
select, link-menu and file-chooser capture and their negatives (two dialogs,
stale and spent identities, an answer after navigation, an oversized option
list or one too long for a native menu, a missing file, a file answer behind an
agent action, a hold older than the person's press or made during an agent
action, a dialog handed to an agent action, a dialog burst, another debugger);
real-page tests in Chromium that hold a select list and an `alert`, refuse a
disabled option, apply an enabled one and answer the dialog, hand a timer
dialog to an agent action that then completes, never offer a list an agent's
click opened, hold a same-site and a cross-site frame's file chooser and
answer the cross-site one, and hold and answer a select list and an `alert`
inside a same-site and a cross-site frame; and Nightly presentation tests for showing, answering, dismissing,
detaching, closing on retirement, not reshowing, not asking while unfocused and
refusing renderer popup requests. No packaged Electron run has yet confirmed that Electron's own
message box stays out of sight while the hidden window's dialog is held.

Field evidence: real-page tests in Chromium that present email and number
fields with a caret and no value, a password field by identity alone and refuse
its composition, leave a date field unsupported, place a rich editor's caret on
each of its lines and compose into it, and follow focus into a same-site and a
cross-site frame for an email field's mapped caret, a text field's composition
and a rich editor's line; desktop tests that a password field's editor carries
no offsets or caret and never composes, and that a nested frame's editing menu
is offered; IPC tests that refuse a password editor with offsets, a caret or a
value; and a renderer test that focus moves to the local password field and
back. The Chromium harness has no native view, so a text control's native caret
there is a stand-in: per-line textarea geometry and macOS secure input rest on
Chromium's own behavior and the maintainers' physical IME check. No packaged
Electron run has yet confirmed the preload in nested frames or its named world.
Known limits: the whole frame walk refuses after 1 second, so a frame that stops
answering refuses its field rather than stalling the person's input; once a
nested frame is followed, the protocol's runtime events stay on for that page; a
loaded Browser extension's own isolated world could carry the bridge's name, and
then answers for that frame's fields in place of the preload; and a select list
held in a frame the walk cannot follow stays closed rather than opening
Chromium's popup in the hidden window.

The current foundation remains publication-gated while full IME reconversion,
other native brokers, the maintainers' physical VoiceOver check and the
remaining lifecycle behavior need implementation and evidence. An isolated synthetic fixture validates only the exercised components; it does not establish
packaged coexistence, signed-in browsing, or native identity verification.

### Accessibility

Nightly shows the page as pixels, so a screen reader there would find nothing to
read. Stable reads the page's accessibility tree through its own protocol
attachment on the hidden window and offers a bounded description of it over the
same authenticated presentation route; Nightly mirrors that description as a
positioned, visually transparent DOM subtree over the Browser image, which
VoiceOver reads and operates like any other part of the window. A companion
window is not a fallback.

- **When.** Nightly's main asks Stable for the mirror only while Chromium
  reports an assistive technology reading the app
  (`app.accessibilitySupportEnabled`), the window is shown and the Browser
  view's layout is visible. Otherwise it refuses the renderer's ask without
  calling Stable, and Stable never reads the tree. Stable turns the page's
  accessibility events on at the first ask and off again after 5 seconds
  without one.
- **What travels.** Each node carries a mirror identity (its document's ordinal
  and the page's node number; a frame keeps its ordinal for as long as the top
  document stands, so an identity Nightly holds never comes to name another
  frame's node), one of a closed list of ARIA roles (anything
  else is `generic`), its name and description (each at most 512 UTF16 units),
  its value exactly as the field holds it (at most 1,024), its states (checked, pressed, expanded, selected,
  disabled, focusable, required, invalid, read-only, multiline, heading level,
  range values, live politeness), its border box in the top page's
  coordinates, and its children in page order. A password field carries its
  role, name and states with a `secure` flag and never a value: Stable checks
  the element of every text, search, combo box and spin button node for the
  password type, whatever role the page gave it, treats one it cannot check as
  a password field, and also withholds a value Chromium shows as mask
  characters. Link
  addresses and other page addresses never travel. Ignored and unnamed generic
  nodes give their children to their parent, except an unnamed live region, a form control (field, check box, option and the like) travels without its
  descendants, a container named by its content (button, link, heading, menu
  item, tab) keeps only descendants that are interactive, focusable, live or
  named beyond its own name, such as a link inside a heading, and
  line boxes are dropped.
- **Bounds.** At most 1,500 nodes, 64 levels and 512 children per node; past
  any bound the tree is cut in page order and marked truncated. The contract
  refuses a tree whose identities repeat, whose children are missing or have
  two parents, that the root does not reach in full, that is deeper than the
  bound, or whose focused node is absent. Content further than the page
  rectangle's range from the viewport travels without bounds.
- **Frames.** A frame element holds its document's tree, at most 8 frames deep
  and 16 documents per page. A frame on the page's site is read in its
  parent's session by its frame identity, and the same renderer already
  reports its boxes in the top page's coordinates; a frame on another site is
  its own target, found by the attachment's automatic frame attachment, and
  its boxes are moved by its frame element's content box, measured again
  before a press, as the page may have scrolled since the read.
- **Updates.** Nightly's ask names the revision it holds and is held open for
  up to half a second while nothing changes. Stable rebuilds at most every
  250 ms, on the page's accessibility, document and frame events and otherwise
  every half second, keeps the revision when a rebuild finds the same tree,
  and answers with nothing when the tree is the same, a patch against
  exactly the held revision when few nodes changed, or the full tree. A new
  document starts again from a full tree. One ask per presentation is in
  flight, outside the ordered input queue, so the person's typing never waits
  behind it. A read that takes longer than 1 second is dropped, and no new read
  starts while it still runs, so an ask stays inside the route's 2-second
  bound. Nightly keeps the mirror it holds through one or two refused asks and
  drops it after the third, so a slow read does not cost VoiceOver its place.
- **Mirror.** Nightly renders each node with its ARIA role, name and states at
  its scaled bounds; the subtree takes no pointer events, so the person's
  clicks still reach the image. Text fields are local fields showing the
  page's value; a password field is a local empty password field, so Chromium
  holds macOS secure input while it has focus, and a dead key's character is
  sent on as typed. Focus follows the page's focused node while the person is
  in the Browser, and moving VoiceOver's focus to a node focuses it in the page.
  While the person composes in a mirrored field, the field keeps the candidate
  and ignores the page's snapshot value; the committed text is sent as a new
  value and shown until the page's value matches it, for at most 2 seconds.
  Live regions are announced through Nightly's own polite and assertive live
  regions when their text changes after the first read, each announcement as a
  fresh element, and an emptied region clears its announcement so the same
  words are said again; the mirrored live nodes themselves stay quiet so
  nothing is said twice.
- **Actions.** A mirrored node can be pressed, focused, scrolled into view,
  stepped up or down (sliders and spin buttons) and, for a native `input` or
  `textarea` text field whose whole value travelled and that is not a password
  field, given a value; a rich text editor or a field cut at the value bound
  takes none, as replacing it would rewrite text Nightly never held. Each action names the
  node and a revision of the current document, travels on the ordered input
  queue under the same focus, visibility, popup and menu rules as a press, and
  in Stable runs on the person's input lane: a press is a click at the node's
  centre through the presentation's own native input, after scrolling it into
  view; a step is an arrow key on the focused node; a value selects the field's
  text and types over it as a composition commit does. A disabled node takes
  only focus and scrolling. Every action is refused while an agent action holds
  the page, counts as the person's input so the agent must read the page again,
  and a press from the mirror may open a select list or dialog as the person's
  own press would. Trusted keys pressed on a mirrored node reach the page
  through the Browser group as ordinary typing; a key an assistive technology
  makes up becomes the matching step or is dropped.

The mirror grants nothing: it only describes the page, and its actions pass the
same checks in Stable as the person's own input. Its identities are not
selectors and name nothing outside the current document.

Evidence: contract and preload tests for the bounds, the tree rule, password
values and the closed actions; Stable tests for reduction (roles, names,
password withholding, flattening, node, depth, child and text bounds, frame
grafting, an unnamed live region, exact field values), updates and revisions
(nothing sent for an unchanged rebuild, a frame's ordinal kept when an earlier
frame appears), and the action rules (a value only for a whole native field, a
frame measured again before a press); a real-page test in
Chromium that a fixture's heading, link, navigation, fields, slider and the
buttons of a same-site and a cross-site frame appear with their names, values
and page-coordinate bounds, that the password value never travels, that
pressing a mirrored button and a cross-site frame's button clicks them, that a
value replaces an email field's text and is refused for the password field,
and that an action is refused while an agent action holds the page; Nightly
presentation tests that nothing is asked or acted on without an assistive
technology, while hidden or unfocused, and that a held ask never delays typing;
and renderer tests of the mirror's roles, names, values, bounds, focus, live
announcements, actions and patch refusal. Known limits: the maintainers'
physical VoiceOver check is outstanding; the Chromium harness has no native
view, so whether VoiceOver's own cursor and rotor behave over the transparent
subtree rests on that check; whether a composition in a mirrored field
commits on a physical input method rests on it too; a frame with a transform is offset by its content
box but not scaled; while a mirrored text field has focus, input methods commit
through a new value rather than through the page's own composition; and a
truncated tree leaves the page's later content unreachable from the mirror.

## What a Nightly client window offers

In client mode, Nightly's main gives every desktop channel one class from a
closed table (`apps/desktop/src/nightlyClientChannels.ts`); a test fails when a
channel is missing from it:

| Class         | Meaning                                                                   | Refusal while unanswered                          |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| `local`       | Nightly's own main answers it, itself or through native-main admission    | "Needs a newer Octant" for a missing host feature |
| `brokered`    | It needs the host and has no Nightly broker yet (Canvas, tools, windows)  | "Not available in Octant Nightly yet."            |
| `octant-only` | Administration that stays with Octant (decision 1) and installing Nightly | "Managed in Octant. Open Octant to change this."  |
| `replaced`    | Nightly uses another mechanism: the Browser's human presentation          | Names the Browser presentation                    |

- Nightly's main refuses to start if it answers a channel its table does not
  mark `local`, or leaves a `local` channel unanswered. The exceptions are the
  channels it only sends to the renderer (menu commands, Code links, the
  resolved sidebar material) and the Data channels where Nightly does not offer
  Data. An unlisted channel counts as Octant-only.
- Brokered channels stay refused until Nightly has a broker for them. Opening
  a Project in a new window is brokered: a second window needs its own lease
  from the host.
- Nightly's main answers these through the window's
  [native-main admission](#native-main-admission), over its own Node
  transport, once the host's feature list names them:
  - the Project, plugin, skill and runtime-binary pickers and the support
    bundle save (`project-root-receipts`, `local-folder-receipts`,
    `runtime-binary-receipts`, `support-bundle-save`);
  - opening a Code file in the external editor, a checkout in one of the
    Open in apps, and a preview handoff (`code-external-editor-target`,
    `code-checkout-open-target`, `preview-handoff`);
  - provider key status, set and clear (`provider-credentials`) and the API
    key pool: list, add, rename, replace, remove, set active and move
    (`provider-api-keys`). The keys stay in the host app's credential store;
  - Code operation approvals in the owner-only native approval view Octant
    uses (`code-operation-approval`).

  Where the host's feature list lacks the flow, or the window has no
  main-only token, Nightly refuses it with "Needs a newer Octant" before any
  dialog opens or any host route is called.

- Nightly's own main, without the host, answers the native surfaces a window
  needs:
  - An application menu named Octant Nightly, with **Settings…** (⌘,) and the
    guarded ⌘Q. A packaged Nightly drops Reload and the developer tools
    from View; on Linux a packaged Nightly shows no menu bar.
  - External links, such as sign-in pages, open in the default browser after
    the same check Octant runs: only `http` and `https` URLs without embedded
    credentials leave the app.
  - Attention notifications and the Dock badge, summed across Nightly's
    windows.
  - `octant-nightly://` Code links. Nightly claims the scheme. Its entry
    holds the newest eight links from its first step, because macOS delivers
    a launch link while Nightly is still checking Octant's host and the link
    is not in the launch arguments. The client keeps each link until a window
    has loaded, and drops any link Octant would drop.
  - Resetting the window's bounds, and the sidebar material and vibrancy Octant
    uses, from the same window presentation.
  - Window capture for the composer, under Nightly's own Screen Recording
    grant; the Open in list; and saving Browser proof pictures to a folder the
    person picks.
  - The menu-bar open-thread report is accepted and dropped: Nightly has no
    menu-bar item, and Octant's lists the host's threads.
- The preload of a Nightly client window omits every member that reaches an
  Octant-only channel, so the shared renderer hides those screens as it does
  for a remote client. Where Settings › Remote access would be, it shows one
  quiet line: "Managed in Octant", naming what is set up there.
- Nightly's test-host mode runs the full host-owning main, keeps every channel
  and shows every screen.

## Before Nightly publishes

The first scheduled Nightly publication needs all of these, each with its own
evidence; the preflight that replaces the early gate checks them:

- [x] Every desktop channel classified; Octant-only administration hidden in
      the Nightly client.
- [ ] A synthetic Nightly client smoke that runs in CI, never packaged.
- [x] Nightly's local native surfaces: app menu without developer tools,
      external links, notifications and badge, `octant-nightly://` links,
      reset bounds, sidebar material, window capture and the Open in list.
- [x] Native-main token admission on the host's closed route allowlist, with
      negative tests, and a host feature list in the window bootstrap.
- [x] Pickers and file handoffs, provider credentials and API keys, and Code
      operation approvals through that admission.
- [ ] "Needs a newer Octant" driven by the host's feature list.
- [x] Embedded Browser page popups: select lists, page dialogs, link and
      image menus, file chooser and `window.open` (see
      [page popups](#page-popups)).
- [x] Embedded Browser fields: email, number and password (secure input),
      nested frames on either site (fields, composition, editing menus and
      popups), rich text editors and multiline caret (see
      [standard text composition](#standard-text-composition)).
- [x] Embedded Browser accessibility (decision 2): a bounded mirror of the
      page's accessibility tree that VoiceOver reads and operates (see
      [accessibility](#accessibility)).
- [ ] Lifecycle and coexistence evidence: quit-one, quit-last, reconnect and
      an unsigned packaged Nightly smoke.
- [x] The full `octant-nightly` command (see
      [the `octant-nightly` command](#the-octant-nightly-command)).
- [ ] Roll-forward rollback, a published host feature list and the app named
      in the signed feed (decision 4).
- [ ] Linux client trust, designed and built (decision 3).
- [ ] The usable-client preflight in place of the early gate, with no secrets,
      checking compatibility against the published Octant features.
- [ ] Maintainer checks: a signed pair, a signed install from Settings,
      real-account sign-ins, physical IME and VoiceOver checks, and approval of
      the first scheduled publication.

## Fixed packaged entry

Both packaged macOS desktop apps run their trusted application entry from `app.asar`.
Packaging verifies the archive header against `ElectronAsarIntegrity` and checks
its file bytes before signing. Application JavaScript stays inside the archive;
only the listed native addons, adjacent libraries, PTY executable and language
server are unpacked to physical paths and signed before the app seal.

Both desktop executables disable Electron's Node-mode, Node-options environment
and Node inspection entry paths. It requires ASAR-only loading and embedded ASAR integrity
validation, with fuse readback on the artifact before signing. Its application
entry accepts a bounded set of launch arguments: ordinary startup, one macOS
Launch Services process token, its own valid Code link, or the fixed scoped
terminal role. Stable also accepts its fixed Canvas prototype-host and host-only roles;
Nightly accepts the Canvas prototype-host role only while its stored Data choice
makes it its own test host, because only the host-owning desktop starts that child.
The host-only role cannot be combined with a Code link or another role. It
refuses unknown positional entries, loader options and
Chromium remote-debugging options before importing host or client-registration
code. Refusal in JavaScript alone does not establish that Chromium exposed no
debugging endpoint during startup; native startup checks cover that separately.

Nightly's bundled terminal `octant mcp` and help entry remains a fixed role, without
loading the host-owning GUI module or accepting a caller-selected script. It is
not evidence of Code-terminal parity. Nightly's full `octant-nightly` command is a
separate resource run by its worker runtime
([below](#the-octant-nightly-command)), never by this role.
Stable's public terminal command instead runs the existing standalone scoped CLI
bundle through its separate Node runtime. A real Code-profile check showed that
the sealed GUI role aborts during LaunchServices/WindowServer registration; the
Node command preserves confinement without granting GUI services. Its script is
an ordinary signed bundle resource, never trusted desktop code for peer admission.

Each app retains a separate, same-version `Octant Runtime.app` inside its
Frameworks folder for its host, managed tools and approved executable extensions;
Nightly's runs only its test host. Its bundle id is `app.octant.desktop.runtime`
in both apps, distinct from both desktop mains and their helpers, and it must
never be admitted as a desktop peer. This runtime keeps
standalone Node behavior and current stdin supervision and confinement contracts.
Node consumers use the physical server/web payload under `Resources/app`, which
contains no loose desktop module; trusted desktop code stays in ASAR. Development
and Linux runtime routing keep their existing behavior.

The worker runtime has independent Framework files and relative symlinks. Fuse
writes must refuse escaped paths or shared Framework inodes. Packaging checks
both identities and fuse policies; signing seals the nested runtime before the
outer app. The duplicate pinned runtime costs about 279 MiB uncompressed. This
preserves current executable and stdin contracts; replacing them with Electron's
main-only utility-process API would also require a supervision and plugin-dispatch
migration. No system Node or new runtime version is substituted.

A production-packaging-helper fixture using the pinned runtime measured ZIP
growth from 126,827,838 to 247,669,865 bytes: 120,842,027 bytes (about 115.24 MiB)
added. This is the same-runtime primary/worker subset, not a full release artifact;
the final signed distribution still needs its own size measurement.

These restrictions are a prerequisite for native peer admission. A signature on
an interpreter that also accepts arbitrary JavaScript would not identify trusted
Nightly application code. Fixed-entry packaging alone does not authenticate a
peer, grant a window capability, establish same-Team signed-app acceptance or
complete the stable-host bridge. Opening the renderer requires the authenticated
window protocol below. Publication remains gated until the full lifecycle,
native brokers and embedded Browser parity are implemented and verified.

## Authenticated desktop status preflight

Packaged macOS Stable owns a transient status endpoint directly in its ordinary
Electron main process. Ordinary Nightly queries it before importing any
host-owning module. The fixed terminal and Canvas roles cannot register this
endpoint. Development and ad-hoc builds report a typed refusal; ordinary Stable
startup remains available when it cannot advertise authenticated status.

The local bootstrap name is discovery only. Every request and reply uses the
kernel message audit token, including effective user, login audit user and audit
session matched to the current desktop's scope. Neither a payload PID nor a
caller-provided path identifies a peer. Each side requires the opposite primary
bundle identifier and exact main executable, the same validated Developer ID
Team, hardened runtime and library validation. Runtime/helper identities,
debuggable or DYLD-override builds and old unsealed Stable builds are refused.

The native binding checks dynamic code validity against the audit token and
strict static/nested resource validity. Only then does it consume artifact
metadata. A signed `sealed-main-v1` entry marker, ASAR integrity configuration and
required fuse states bind the packaging policy. A fresh static check, matching
CodeDirectory identity and metadata, and final dynamic check surround the
read-only fuse observation. These checks do not assert an atomic filesystem
snapshot. The streaming reader uses bounded owned buffers and refuses unknown,
malformed or truncated fuse schemas; it never patches a runtime. Artifact inputs
must be on a local volume.

The fixed protocol returns only its version and the authenticated app version;
it conveys no host URL, secret, credential, window registration or lease.
Missing status cannot distinguish a closed Stable app from an older app without
this endpoint, so startup says so. An authenticated status response alone cannot register a window. The separate
window protocol below must succeed before Nightly opens its renderer. Neither
result establishes usable Nightly, shared native surfaces or Browser parity.

The status operations are `start`, `status` and `close`. The local-only
`launchStableHost` function performs the validated installed-app launch above;
it adds no Mach request or registration authority. A separate closed
window protocol shares the binding; neither offers an arbitrary Mach operation
or renderer access to the native binding. Queue and message sizes are fixed, send/receive and
validation decisions have deadlines, and expensive Security/filesystem work
runs off the main loop. OS validation calls cannot be forcibly cancelled: an
expired observation is refused, and shutdown reports failure rather than claiming
closed while validation remains active. Accepted quit closes the owned endpoint
and awaits its worker alongside host cleanup; rejected quit leaves it available.
Malformed and oversized messages dispose transferred rights without ending the
listener, and close never unregisters a replacement's name.

Normal desktop builds do not require Node native headers. macOS packaging builds
only this component from source through the existing pinned Electron rebuild
pipeline, which supplies headers as needed; no runtime version is substituted.
The addon is an exact signed `Resources/native` payload outside ASAR. This keeps
the existing JavaScript archive/unpack policy intact. Same-Team Developer ID
positive acceptance, active authenticated-owner teardown and full production
package validation still need their own evidence; unsigned fixture refusal does
not satisfy those cases.

## Native client window leases

Ordinary Nightly uses a separate mutually authenticated window protocol after
status. Its main process creates an opaque client handle for its real window.
Stable issues a fresh server window ID, capability and renderer identity; the
client cannot choose another window's server identity. The reply includes only
that scope, the validated literal-loopback host origin and current host instance,
and, for a client that accepts them, the window's native-main token and the
host's brokered features (below).
Stable's administrative bridge secret stays in Stable. Runtime, helper, terminal
and Canvas roles cannot register these windows.

Each registration binds the actual kernel audit-token process incarnation and
login scope to its process registration, client handle and window generation.
Native process-exit observation checks the audit incarnation after installing
its process watch. A reused PID or transferred messaging right cannot stand in
for the exited owner. The status protocol continues to return no URL or lease.

The server grants a 15-second native lease, renewed every five seconds. It
checks expiry on both window and renderer authentication and takes native
generation from the stored authority. An ordinary local registration cannot
refresh a live native lease into its normal 24-hour capability. Native leases
also use suspend-aware elapsed time. The existing server authority clock derives
its epoch from elapsed time and ignores later caller wall-clock readings; no
wall-clock recovery mode is implied by this protocol.

Expiry first revokes state and aborts held requests, then notifies every owner
of the window. One failing cleanup cannot skip sibling owners or resurrect the
lease. Native held responses discard queued bytes with an abort error; late
producer reads and late completed JSON responses cannot publish after expiry.
Renewal preserves the current abort lifetime, while re-registration gets a new
one. Existing local and remote request semantics remain unchanged.

Stable's main also holds a conservative local deadline and rejects an owner
whose host instance changed. It reserves a closing client handle until cleanup
settles, and cleans only its host-issued server ID and generation. A failed
registration does not establish ownership of Browser contexts. Close waits for
pending acquisition and attempts server revocation and owned-context cleanup;
failure remains observable. Current acknowledged leases feed the retained-client
lifetime above. Host replacement uses the bounded fresh-registration
[reconnect rules](#reconnecting-after-host-loss); full signed acceptance remains
unrun.

### Native-main admission

Each native registration also carries a main-only token that Stable's main
mints beside the window capability and renderer identity, distinct from both.
The host binds it to that window's native lease record. Only the registration
reply returns it, to the registered Nightly main. The renderer never receives
it: ordinary renderer request headers strip `x-octant-native-main-authority`
and never add it, and Nightly main keeps it in memory only.

With its window capability and that token, Nightly main may call a closed list
of brokered host routes in place of Octant's bridge secret, as a POST with no
query string and no origin, for its own window only. A body that names a
window must name that window. The list lives in one host module with a test
that pins it:

- Project, plugin, skill and runtime-binary picker receipts
- Code external editor target and Code checkout open target
- preview handoff
- support bundle save
- Code operation approval prepare, confirm and cancel
- provider key status, set and clear
- the API key pool: list, add, rename, replace, remove, set active and move

Expiry, revocation and lease loss end the token with the lease. An ordinary
local window has no token, and a request forwarded from the remote listener is
refused. The administration of decision 1 stays secret-only, as do window
registration, provider sign-in and provider removal.

A support bundle save names no window and no save dialog the host can see, so
for a native main it only creates a new file and refuses a path that already
exists. Octant's own save dialog confirms a replacement, so its bridge-secret
save still replaces.

The registration reply names the host's brokered features from a closed
contracts vocabulary. A client ignores names it does not know. When the token
or a feature is absent, Nightly offers that flow as needing a newer Octant
instead of calling the route.

The reply's new fields reach only a client that asks for them. A current
client names `native-main-v1` after the leading NUL of its request payload. The
first window server checked only that first byte, so it still answers such a
client with its original reply, and the client then brokers nothing. An older
client sends nothing and gets that original reply, which its strict decoder
accepts. Neither direction of version skew refuses a window.

Two rules bind the brokered flows built on this admission:

- **A person confirms an approval in Nightly's main.** Nightly confirms a Code
  operation approval only from the owner-only native approval view its main
  shows, the one Octant uses, after the person's own click, exactly as Octant
  does. Only a decision from that view's own web contents with its one-time
  token reaches the confirm route; a renderer message alone never does.
- **A linked key is never overwritten.** The host's provider key routes refuse
  to set, clear or edit the pool of a key that points into a linked secret
  store, as Octant's own Settings does; the link is removed in Settings first.
  Each key change is journaled before and after the store is touched.
- **Brokered calls bypass the renderer session.** Nightly main sends them over
  its own Node transport, never `net.fetch` on the default session, whose
  request-header decoration strips the token.

Nightly sets its separate window storage before Electron is ready, loads its
own existing renderer/preload and installs the trusted renderer-header registry
for the returned host origin. Its administrative secret is never a renderer
argument. Window creation, navigation guards, expiry and renewal use the real
client path. Native contributions that are not connected to their owning broker
refuse explicitly. The connected Browser uses the separate bounded human
presentation path above; device panes remain unavailable. This does not establish
complete Browser parity or allow a companion window or a second opening of
persistent profiles.

Unsigned native refusal and mechanical lifecycle tests are separate from
Developer ID same-Team admission. Actual signed-pair registration, active-owner
process exit and full-payload renderer/native acceptance still need their
evidence. The retained-client policy has separate focused and synthetic evidence;
full signed lifecycle acceptance remains unrun. The functional publication gate stays in force.

## Identity

The apps differ only in what macOS and Linux need to keep two apps apart:

| Value                       | Octant                                 | Octant Nightly                                                                     |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| Product name and menu title | Octant                                 | Octant Nightly                                                                     |
| Bundle id                   | `app.octant.desktop`                   | `app.octant.desktop.nightly`                                                       |
| Host data folder            | `~/Library/Application Support/Octant` | The same folder, through Octant's host; with test data, `Octant Nightly/Test Data` |
| Window storage (macOS)      | Inside the data folder, as today       | `~/Library/Application Support/Octant Nightly`                                     |
| Host port                   | `13773`                                | None of its own; with test data, `13774`                                           |
| Link scheme                 | `octant://`                            | `octant-nightly://`                                                                |
| Command-line tool           | `octant`                               | `octant-nightly`                                                                   |
| Rings                       | `stable` (default), `candidate`        | `preview`                                                                          |
| Icon                        | The Octant icon                        | The Octant icon with its colours inverted                                          |

- Window storage is the desktop process's own browser storage (window
  positions, local storage, cookies of the app's renderer) and the
  single-instance lock. It is separate so the two apps never fight over one
  lock or one window layout file; it holds no thread or Project data.
- `octant-nightly` is the Nightly build of the command-line tool. It attaches to
  the same host as `octant`, so a person can try a newer tool against their
  real data without replacing `octant`
  ([below](#the-octant-nightly-command)).
- The identity is one record per flavor in `@octant/host-runtime`, consumed by
  `DESKTOP_PACKAGE_IDENTITY` and desktop packaging. The packaged manifest stamps
  the flavor, and the desktop reads that manifest rather than a launch
  environment variable. Its name, scheme, window storage folder, rings and host
  ownership come from that record. A malformed or mismatched identity refuses
  startup. Development keeps its existing entry and unrestricted ring tests.
- `OCTANT_DATA_DIR` and `OCTANT_SERVER_PORT` still override either app, as for a
  development build. A development build (`bun run dev`) is neither app and is
  unchanged.

## The `octant-nightly` command

`octant` and `octant-nightly` are one command-line source. The entry passes its
flavor's identity record, and the tool's name, help text and product name come
from that record; `--version` prints the name and the release version packaging
stamps beside the bundle (`development` from source). The tool prints no link,
so the link scheme does not appear in it.

- **Which host.** By default `octant-nightly` attaches to Octant's host: the
  same data folder, host receipt, bridge-secret discovery and window authority
  as `octant`. When Nightly's stored Data choice is Separate test data, it
  attaches to Nightly's test host on its folder and port `13774` instead. It
  reads `data-choice.json` with the desktop's own rule (the same host-runtime
  reader): only an exact `{"data":"test-data"}` regular file selects test
  data, and a missing, oversized, linked, malformed or unreadable choice means
  Octant's data. A stored test-data choice on Linux refuses with a message, as
  the desktop does. `OCTANT_DATA_DIR` and `OCTANT_SERVER_PORT` override either,
  as for `octant`; an explicit `OCTANT_DATA_DIR` skips the stored choice.
- **Never a host.** `octant-nightly` never starts, stops, installs, upgrades or
  runs a host, and never writes a login or boot service, so it can never own or
  migrate Octant's data. `server start|stop|restart|enable|disable|run|install|upgrade|uninstall`,
  `web --dev`, `hub enable --install-service` and `hub disable --remove-service`
  refuse before anything runs, and help lists only what it offers. `hub enable`
  and `hub disable` never print a boot-service command either. With test data,
  `server status` and `server logs` refuse and name `octant-nightly status` and
  the test host's log, because the only service they read is Octant's. When no
  host is running, a command that `octant` would answer by starting one says
  which host is missing and how to start it: Octant (the app or
  `octant server start`) or, with test data, Octant Nightly.
- **Not the test host either.** `octant` starts its own host in the analogous
  case, but that start runs Octant's login service without Nightly's test-host
  environment (its Keychain service family, default folder and log folder),
  so a host started that way would keep test-data credentials under Octant's
  Keychain names. The test host therefore starts only with Octant Nightly.
- **Needs a newer Octant.** A host answers a route it does not have with its
  catch-all plain `Not Found`, and a missing resource on a route it has with a
  JSON refusal. When a command's request meets the catch-all, or the host does
  not accept command-line sessions at all, the tool reports "Needs a newer
  Octant", naming the request and the host's advertised `/health` version, and
  the command fails. A command's existing fallback for an older host keeps
  working, since the status is unchanged.
- **Packaging.** Packaged macOS Nightly carries
  `Contents/Resources/command-line/octant-nightly` and its one-file bundle
  `octant-nightly.mjs` beside it. The shell launcher follows the link a person
  put on `PATH` back to the app, then runs only that bundle with
  `Octant Runtime.app` in Node mode, passing every argument to the command and
  none to the runtime. The sealed GUI main never runs it. The bundle carries
  every dependency except the full-screen terminal library, whose native core
  is not shipped, so `octant-nightly agent` uses its line mode. Both files are
  sealed by the app signature. Octant ships no such folder. Stable installs no
  `octant` on `PATH` and has no Settings action for it, so Nightly has none
  either: a person links the command (user guide). Linux Nightly ships no
  command yet.

## Getting Octant Nightly

- **From Octant on the Nightly channel.** Nightly is opt-in. When the channel
  switch is on Nightly (Octant itself stays on `candidate`), Settings › Updates
  shows an Octant Nightly row directly under the switch. Choosing Nightly
  downloads nothing; only the explicit click does:
  "Install Octant Nightly" downloads the newest Nightly (`preview` ring) build
  and places it beside Octant after three checks:
  - The feed signature, against the preview ring's trust set (the preview key
    and the stable key). This installer is the only part of Octant that reads
    a `preview` feed; Octant's own updater checks only `stable` or
    `candidate`.
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
  - The desktop main process decides every step; the renderer only asks, with
    no arguments. The location is fixed: `Octant Nightly.app` in the folder
    that holds the running `Octant.app` (normally `/Applications`). A launch
    that is not a plain `Octant.app` bundle, or that macOS translocated,
    refuses. The feed and artifact downloads together must finish within 15
    minutes, or the install stops as timed out. The download is written to a
    private temporary folder and
    extracted with `ditto` into a staging folder beside the target, the
    requirement is checked on that extracted bundle, and only then is it
    renamed into place. Something other than Octant Nightly at the location
    (by its Info.plist bundle id) is left alone and refuses. An installed
    Nightly is replaced only by a strictly newer build, by the updater's own
    version ordering against its `CFBundleShortVersionString`: an equal or
    older offer (a replayed feed, say) refuses as not newer, and an installed
    version that cannot be read refuses rather than allowing a downgrade. With
    no Nightly installed, any verified preview build may install. The
    replacement is a rename; the old copy is restored if the new one cannot be
    moved in, and otherwise goes to the Trash, since it was never verified
    here. Replacing and removing refuse while Octant Nightly is running (or
    when that cannot be told), asking the person to quit it first, and check
    again just before the move. No quarantine attribute is set or cleared: the
    file is written by Octant itself, as Octant's own updater does.
    "Installed" means that location holds a bundle whose id is Nightly's;
    that decides whether the row shows. Open and Remove act only on a bundle
    that also verifies against Nightly's requirement: Open then opens it
    through Launch Services, and Remove moves it to the Trash. A bundle that
    is installed but does not verify is left alone. Each refusal names the
    check that refused, and a check that could not run says so instead of
    blaming the signature.
  - Linux has no code-signature check to bind the download to Octant's
    publisher, so packaged Linux Octant does not offer the row and refuses an
    install as not supported on this platform; Linux Nightly comes from the
    website.
- **From the website.** octant.sh offers both downloads. The Nightly download
  says it works with Octant and needs it installed.
- Switching Octant to Stable or Preview leaves an installed Nightly in place;
  the row stays while Nightly is installed so it can still be opened or
  removed, and is hidden otherwise. Main still allows an install only while
  Octant follows `candidate`.
- Nightly then updates itself on its own ring. Octant's updater only ever
  checks `stable` or `candidate`.

## Nightly's own updates

The authenticated Nightly main owns its update checks, downloads, apply and
bundled What's new operations. These use the existing signed-feed verifier,
artifact hash check and platform updater requirement for the running app.
Unsigned or incompatible packaged clients cannot acquire the native window
authority needed to reach these operations. Being packaged alone grants no
update authority, and Nightly never asks Stable to replace either application.

Nightly persists its ring and automatic-check choice in its own window-storage
directory. Its bundled preload marks these preferences as local: the renderer
neither synchronizes shared host update settings into Nightly nor writes a
Nightly choice back to those shared settings. Nightly follows only `preview`
and shows no channel switch; Octant's running identity permits `stable` and
`candidate`. Its Updates section otherwise matches Octant's: the same Version
row (What's new, Check for updates, Relaunch to update), the same ready and
refusal notices, the same Automatic checks row and "What a check sends"
disclosure, and the same copy style. In place of the switch is one quiet line
saying Nightly gets a new build of what is being built every night, and there
is no install row. Automatic checks
start off until Nightly's own stored choice is read. Invalid or redirected
preference files leave them off. What's new and its acknowledgement also stay
in Nightly's own bundled resources and window storage.

An explicit apply uses fresh bounded host activity for the exact native-bootstrap
host instance. Missing or mismatched activity waits, as does active work. The
request must still belong to the same current top-level window after that
await. Only then does Nightly close its own lease and Browser presentations.
Failed or rejected cleanup refuses the apply request and restores a fresh
authenticated window; it cannot latch accepted quit. A previous unconfirmed
cleanup remains visible until Nightly is closed and reopened. A concurrent
person quit supersedes apply. A platform apply failure likewise leaves ordinary
reopen and retry available. Stable's host and its shutdown inventory are never
owned by this path.

Synthetic updater/feed tests establish ordering and preference separation, not
a signed installed update, OS replacement, rollback or publication. Those
remain separate packaged acceptance.

## Which build is which

- A build's flavor follows its ring: a `stable` or `candidate` release
  packages as Octant; a `preview` release packages as Octant Nightly. The
  release workflows pass the flavor with the version: the scheduled run builds
  Nightly on `preview`, and a dispatched run builds Octant on `candidate`.
  Packaging refuses a stable or candidate version under the Nightly identity,
  and a preview version under Octant's.
- A local `bun run package:desktop` builds Octant unless
  `OCTANT_PACKAGE_FLAVOR=nightly` is set, so a maintainer's own packaged build
  keeps opening their existing data.
- Feed keys are unchanged per ring: `stable` trusts only the stable key;
  `candidate` and `preview` trust the preview key and the stable key. Octant
  on Preview therefore accepts a preview-key signature only for a release
  signed for `candidate`, never for `stable`. An update for one app can never
  install the other: the signed ring
  must equal a ring the app follows, and on macOS the platform updater's
  code-signature check also requires the running app's bundle id. An update
  check or download that finishes after its ring was changed or refused cannot
  restore the older offer, failure or native download result.
- Nothing has shipped on any ring, so no install needs moving between apps.
- **Release order.** A person's first install is Octant, so it has a host.
  Octant on Preview may publish before the first stable release. Octant
  Nightly is published only once an Octant build (Stable or Preview) exists
  for it to attach to; "technical preview" names the product's stage, not the
  ring.

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
- A small neutral "Nightly" pill sits beside "Octant" in a compact sidebar
  identity row below the native window controls. The existing title rail,
  traffic-light clearance and navigation actions keep their geometry. When the
  sidebar is collapsed, the same label moves to the window's measured leading
  title-bar cluster, including when the icon rail remains visible. Standalone
  Settings keeps one label in its own sidebar, or in the title bar at narrow
  widths. It is a quiet label at the meta step, not a warning colour.
  The local application bootstrap supplies the closed flavor and product name
  from the existing immutable identity record. The preload requires one matching
  name/flavor pair before exposing this display-only identity; it never
  identifies a host or window and grants no capability or shared-data authority.
  Stable and remote clients do not show the Nightly label.
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
- `octant` and `octant-nightly` both reach the one running host. With test data,
  `octant-nightly` reaches Nightly's test host, and with no host running it
  starts none.
- Install from Settings is offered only while Octant follows Preview, and
  refuses a build whose signature, hash, or code signature does not verify.
  Remove leaves the data untouched.
- Preview and candidate builds are versioned `<base>-<ring>.<YYYYMMDD>.<run>`
  by one workflow, so the updater orders them by date and then run, ignoring
  the ring label. Octant switched from Stable to Preview is offered a newer
  candidate; switching back offers nothing until a stable release is newer
  than the installed candidate. Equal or older builds are never offered.
- Octant offers stable and candidate updates and refuses a feed signed for
  `preview`. Nightly offers only preview and refuses `stable` and `candidate`.
- With separate test data, Nightly's host runs beside Octant's, each on its own
  folder and port; Octant's data, Keychain items and host are untouched, and
  switching back to Octant's data after a relaunch reconnects as a client.

## Rationale: whose host owns the data

Octant's host owns the data, so a nightly can never upgrade it out from under
the app a person works in. The cost is that Nightly tests new screens, while
host changes (agents, providers, tools) run only once they ship in Octant.
The separate test-data host closes that gap for development and testing
without touching a person's real data.
Rejected: the newest installed host owns the data and serves both apps.
Nightly would then test everything, but once it migrated the data Octant
alone could not open it until Octant updated (the host keeps a backup before
every migration), and a broken nightly host would hold the data until a fix or
a restore.
