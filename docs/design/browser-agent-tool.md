# Browser for agents

This topic specification owns what the agent's Browser tool, `octant_browser`,
does on a page: its operations, what each one returns, the page snapshot and
its element refs, and the limits on waiting, batching, and reading what a page
reported. Architecture owns who may open, read, and drive a Browser and what an
approval covers
([Architecture: security and authority](../architecture.md#security-and-authority)).
[Browser profiles and extensions](browser-profiles.md) owns signed-in pages,
and [Browser captures](browser-captures.md) owns which screenshots a thread
keeps.

Status: built. The page snapshot and element refs (frames and open shadow
roots included), short results, hover, select, drag, key chords, upload,
download (behind a person-only switch and an answer for every file), tabs,
batched steps, waits, settling, dialogs, viewport size and device emulation
(presets, touch, color scheme), the sign-in handoff, person and agent together
(the person's input kept, Take over and Hand back), diagnostics with a
cursor, and accessibility and performance audits are built on the headless
and desktop Browsers, and so is recording a call as an animated PNG. Flows
(recording a run,
saving it in the Project, and replaying it by name) are built in Work and Code;
the person can list and delete a Project's flows in Settings, and runs one by
asking the agent.

## One tool for every provider

- Every provider that carries Octant's tools gets the same `octant_browser`
  definition in Work and Code, through the transport its adapter verified. A
  Code thread and a Work thread read an operation's arguments and shape its
  answer the same way; they differ only in who approves and how a page opens.
- The always-visible description tells the model to take a snapshot after it
  navigates and to act by ref, and, to show a reviewer a UI change, to run the
  short flow as `steps` with `record: true`. The full usage stays behind `help`.
- Stored-profile selection through `navigate`, and a task's default Browser
  profile, are wired in both Work's and Code's adapters, each through the
  stored-profile site approval. See
  [Browser profiles](browser-profiles.md#choosing-a-profile).
- Every operation runs on the server's admission path: the thread's authority,
  the model binding, the origin approval, Plan mode, the stale check, and the
  credential check. No operation adds authority a page did not already have.

## Plan mode

Plan may look and propose but changes nothing
([Architecture: principles](../architecture.md#overview-and-principles)). In
both adapters (Code's, and Work's, which a terminal grant also uses), Plan
admits a Browser operation that only reads the page
already open in the thread's own Browser, or the Project's saved flows, and
sends no request; it refuses every other one as `plan-mode-read-only` before
the page, the workspace, or the person is reached.

| Verdict in Plan   | Operations                                                                                             | Why                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admitted: reads   | `snapshot`, `read-page`, `screenshot`, `diagnostics`, `audit`, `tab-list`, `wait`, `flow-list`, `help` | Each reads what the open page or the Project already holds: the outline, text, pixels (kept as this thread's own capture), what the page already logged, accessibility findings or the browser's own record of the load, the tab list, a state the page reaches by itself, the saved flows, or static usage. |
| Admitted          | `stop`                                                                                                 | It closes only this thread's own Browser.                                                                                                                                                                                                                                                                    |
| Each step         | `steps`                                                                                                | Each step is admitted as a call of its own, so a batch of reads runs and the first step that would change something ends it.                                                                                                                                                                                 |
| Refused           | `navigate`, `tab-open`                                                                                 | A request, a new page.                                                                                                                                                                                                                                                                                       |
| Refused           | `click`, `type`, `press`, `select`, `drag`, `hover`                                                    | Input reaches the page; hover runs its handlers and opens menus.                                                                                                                                                                                                                                             |
| Refused           | `scroll`, `resize`                                                                                     | The page moves or changes size and emulation, which it may answer with requests (more of the page, other images).                                                                                                                                                                                            |
| Refused           | `tab-switch`, `tab-close`                                                                              | Which page is shown changes, or a page closes.                                                                                                                                                                                                                                                               |
| Refused           | `upload`, `download-save`, `sign-in`, `run-script`                                                     | Files leave the workspace or enter it, the person acts on the page, or arbitrary JavaScript runs.                                                                                                                                                                                                            |
| Refused           | `flow-save`, `flow-run`                                                                                | A save writes the Project's flows; a replay acts.                                                                                                                                                                                                                                                            |
| Refused           | `record-start` (host-issued for `record: true`)                                                        | A recording is an artifact the thread keeps, and Plan only reads, so a `steps` with `record: true` answers `recording-refused` and runs nothing; a recorded `flow-run` is refused as a replay.                                                                                                               |
| Admitted: cleanup | `record-stop` (host-issued)                                                                            | It ends a recording a call started before Plan began. It reaches the runtime in every posture, so the screencast never runs on to its own bound, and in Plan it keeps nothing: the answer says `recordingNotKept: plan-mode-read-only`.                                                                      |

- Every other gate applies to an admitted read unchanged: the thread's
  authority and model binding, the origin approval (a page this model or
  thread was not approved for still asks, and a declined answer reads
  nothing), the person's hold, the stale check, and outside-content taint. A
  read never opens a page: with none open it answers `browser-navigation-required`.
- Code re-asks after every wait (an approval, the action itself), so a thread
  that moves into Plan while a click is in flight is still refused it and the
  page released, while a read in flight finishes. A terminal grant decides Plan
  once per call; an approval answered for an effect after its thread moved into
  Plan is still cancelled.
- The rule is one table, `BROWSER_OPERATION_EFFECT` in
  `apps/server/src/browser/browserToolOperations.ts`, keyed by the operations
  the definition advertises and the two the host issues around a recorded
  call, so a new operation does not compile until it takes a row. `audit`,
  admitted exactly where `diagnostics` is, takes the `reads` row. A recording
  does not follow `screenshot`: the thread keeps it as an artifact, so its
  start is refused in Plan and the call it wraps never runs. A recording
  already running when Plan begins is stopped and discarded.

## Page snapshot

- `snapshot` returns a compact outline of the page: one line per heading, short
  text block (the first 80 characters of a paragraph or list item), and control, indented by nesting. Each
  element an agent can act on carries a ref (`[ref=e4]`), its role, its
  accessible name, its state (checked, disabled, expanded, selected, required),
  and its value.
- A credential field (a password, one-time code, card number, or anything the
  host's credential test matches) reads `protected` and never carries a value.
  On a page that holds a credential field anywhere (a frame and a shadow root
  included), no field shows a value at all. An editable element is never named
  by its own text, which is what was typed into it, and a label's text leaves
  out the fields inside it.
- A snapshot carries no picture and no page text beyond the outline.
- **Frames and shadow roots.** The outline reads the page as a person sees it:
  an open shadow root's content in place of its host's, a slot's assigned
  content in place of its fallback, and each frame's content indented under
  its `iframe "title"` line. A closed shadow root stays unread, because the
  page closed it to its own scripts too. Frames nest at most 4 deep and one
  snapshot reads at most 16; one budget of refs, lines, and text covers the
  whole page, frames included.
- A ref inside a frame or a shadow root acts like any other: `click`, `type`,
  `hover`, `select`, `drag` (both ends in one frame), `upload`, `wait`, and
  `read-page` reach it, and the stale check runs in its own frame. Its stored
  selector steps into the frame or the shadow root; a model cannot write one
  that reaches further than a ref could.
- **Which frames are read.** On a Private page every frame is part of the page
  the approval covered, whatever its origin. On a Project or Personal page a
  frame on another origin is read only when the context's approved origins
  include it, as a page there would need its own site approval; otherwise it
  is listed as `iframe "https://other.example" not included`. A frame the
  Browser cannot load or reach, and one that is not http or https, is listed
  the same way. The headless Browser loads nothing outside the page's approved
  origins, so there a frame on another origin is always listed as not included.
- **Credential checks run in every frame.** A credential field in any frame or
  shadow root reads `protected`, withholds every value on the page, and
  refuses typing and focused key presses, in that frame as in the top page.
- The desktop Browser reaches a frame through the debugger protocol: each
  frame gets an isolated world of its own, so the page's scripts never see the
  reader, and a frame on another site is reached through its own session.
  Input still goes to the page at page coordinates. While someone else holds
  the page's developer tools the desktop Browser reads no frame and lists each
  as not included.
- Rationale: a screenshot already shows every frame, and on a Private page a
  frame's site holds no sign-in older than the page, so reading it adds
  nothing the approval did not cover. On a signed-in page a frame on another
  site may be signed in to that site's account, which is exactly what a site
  approval per origin and profile exists for, so the narrower rule keeps it.
- An outline is bounded: at most 400 refs, 800 lines, and 24 KiB of text. A
  longer page ends with `(outline truncated)`.
- `click`, `type`, `wait`, and `read-page` accept `ref` in place of a CSS
  `selector`; passing both is refused as invalid.
- **Refs are kept and resolved on the server.** The server keeps what each ref of
  the latest snapshot names (a selector path, the role, and the name) and turns
  a ref into that selector before the runtime is asked. A model cannot point a
  ref at an element the snapshot did not list.
- **A stale ref is refused.** A ref the latest snapshot did not list is refused as
  `stale` before any runtime is called. A new snapshot replaces every earlier
  ref, and a navigation, or any action that leaves the page the snapshot read,
  drops them. Before acting, the runtime checks that the page is still at the
  address the snapshot read and that the element behind the ref still has the
  role and name the snapshot recorded; a page that moved on by itself, or an
  element that changed, is refused as `stale` and the action does not run.
- The same snapshot is built on the desktop Browser and the headless Browser:
  one page reader runs inside the page in both, so a ref means the same thing
  on either.
- Rationale: refs are checked by role and name, not by a page revision, so a
  ref survives an action that leaves its element as it was (typing into one
  field, then clicking the button beside it) and is refused only when the
  element it named changed. Detected credential fields never expose field
  values in the outline. This does not prove that the site's own text or
  callbacks cannot reflect input; brokered use therefore holds observations
  during the effect and requires a person to check the page before resuming.

## Results

- An action (`navigate`, `click`, `type`, `press`, `scroll`, `wait`) answers with
  the page's address, title, observation revision, and `changed`: one line on
  what the action did, from the page before and after it: a new address, a new
  title, changed page text, or "Nothing visible on the page changed." A page
  that holds a credential field is not compared, and the line says so.
- An action returns no page text, picture, or outline unless the call asks with
  `include` (any of `snapshot`, `text`, `screenshot`). Asking costs what the
  matching reading operation costs, in the same answer. An included snapshot
  replaces the refs exactly as a `snapshot` operation does.
- `read-page`, `snapshot`, and `screenshot` return what they read and carry no
  `changed` line. The page's text hash stays on the server, which compares it;
  the model no longer receives it.
- **The runtime takes no picture an agent did not ask for.** Neither the headless
  nor the desktop Browser captures the page after an agent's action unless the
  call is a `screenshot` or includes one, and neither returns the page's text
  unless it is a `read-page` or includes it. Each still reads the page's text
  for the hash. Neither records the page unless the call is a `steps` or
  `flow-run` that asks with `record: true`, and then only while that call runs.
- **Recording a call.** `record: true` on `steps` or `flow-run` keeps a short
  animated PNG of the page while the call runs, as a thread capture the person
  can attach to a pull request; the model never receives the animation. It
  needs a page already open and is admitted like a `screenshot`, except that
  Plan refuses it ([Plan mode](#plan-mode)); a start that is refused answers `recording-refused` with the refusal, and the call does
  not run. The call's answer carries `recording` (`captureId`, `frames`,
  `durationMs`, and `truncated` when a bound cut it short) or
  `recordingNotKept` with the reason. Starting and ending a recording leave
  the observation revision where it was, so a batch's first step may name the
  revision the call before it returned, and the next call may name the one the
  batch returned. The bounds, the frames, the credential rule, and the
  rationale for one recording per call are in
  [Browser captures: Recordings](browser-captures.md#recordings).
- **The person keeps their picture.** The activity preview takes its own
  picture through the host's peek, which now runs right after an agent action
  that took none (at most once per 1.5 seconds), so the preview shows the page
  the agent left. A person's own action from the Browser pane or a paired
  device still brings a picture back, because a headless page is seen only as
  one, and so does opening a page in the thread-less Project browser.
- A preview's picture of the same page (same address and title) keeps the
  observation revision, so an agent's next action that names the revision its
  last action returned still runs while a preview is open.
- Rationale: measured on a local page with 40 paragraphs and a two-field form
  (headless Chromium), the per-action observation the host built and kept fell
  from 31.7 to 40.4 KB (a picture and the page text on every action) to about
  0.7 KB. A navigate, read, type, click, and verifying read cost the model
  15,903 bytes of tool results before; navigate, snapshot, type, and click,
  whose result says what changed, cost 4,538 bytes after.

### Refusal and expiry recovery

- An origin outside the page's approved origins stays refused as
  `policy-denied` with reason `origin-not-approved`. The answer says to call
  `stop`, then `navigate` to the intended URL and keep the same profile argument
  if one was used, so the new site's approval is requested. For SSO in the
  desktop app's Browser, it instead offers `sign-in` so the person can finish
  the redirect chain. It reports only the refused origin, never that URL's
  path, query, or fragment.
- At Full access a Private page needs no site approval and may navigate
  across origins, so this refusal is left there to profile pages, which keep
  their site approval ([the Full access rule](../architecture.md#security-and-authority);
  maintainer request, 2026-11-12). Built, in Work and Code:
  - The agent tool opens the page with one allowlist entry, `*`, which stands
    for every http and https site. The browser service admits that entry only
    from the agent tool of a thread at Full access, alone, and never beside a
    stored profile; a window, a paired device, and a profile switch cannot
    open such a page. Credential-field protection, Take over and Hand back,
    and the paired-device reach are the same on it as on any page.
  - A Private page opened below Full access holds its one site. When the
    thread is at Full access and the agent navigates it to another origin, the
    tool closes it and opens the any-site page there instead of refusing; a
    link or redirect on the one-site page that leaves its origin is still
    refused until then.
  - A page that admits every site has no site approval to stand on below Full
    access. When the thread's level drops, the agent's next `navigate` closes
    it and opens a one-site page through the ordinary approval, and every
    other operation answers `browser-navigation-required`. Plan still reads
    it, because Plan cannot move it.
  - At Full access a different model or a person-switched Private page needs
    no approval either; the ask that rebinding raises is a site approval.
- After a page expires, ordinary agent calls answer `context-expired` and name
  its former Private, Project, or Personal profile, rather than claiming it
  never opened. Reopening requires an explicit `navigate`; a stored profile
  must be named again. Expiry never reopens a page, selects a profile, or grants
  a site's approval.
- The host keeps only a bounded, in-memory expiry receipt, without observations,
  text, pictures, or evidence. It is scoped to the original window, thread, and
  authority, and the agent receives the hint only under its original model
  binding. A new page, explicit stop, window revocation, profile clear, or host
  close clears the corresponding hint. Old hints may be evicted like the
  tool's bounded model bindings; they are not persistent page history.
- Session deadlines follow [Page lifetime](#page-lifetime): the agent tool
  opens a page with a ten-minute idle interval, which admitted agent activity
  renews. A sign-in hand-off keeps it for as long as its card waits. A
  take-over keeps it for eleven minutes from the hold, take-over input
  renews that retention, and release of either keeps it for two minutes, always using
  the later of that retention and the ordinary idle deadline.

## Actions

- `hover` moves the pointer over an element, for menus that open on hover.
- `select` chooses one option of a list by its value or its label. A list with
  no such option refuses at once instead of waiting.
- `drag` presses on one element and releases on another (`toRef` or
  `toSelector`); both ends are checked like a ref when they came from one. The
  desktop Browser moves the pointer in steps, which pages that follow pointer
  events and pages that use the HTML drag events both see as a drop.
- `press` takes a named key, a letter, a digit, or F1 to F12, alone or with
  `Control`, `Alt`, `Shift`, and `Meta` (each at most once): `Control+A`,
  `Shift+ArrowDown`. A letter reaches the page as a keyboard sends it: lower
  case unless Shift is held. A focused credential field still refuses every
  key.
- Tabs: `tab-list` names the context's tabs `t1`, `t2`, and so on, with the one
  in front; `tab-open` opens a tab, at most the context's tab limit, optionally
  at a URL, which must pass the same origin admission as a navigation;
  `tab-switch` brings one to the front, and `tab-close` closes one but never the
  last. Every other operation acts on the tab in front. A tab action drops the
  snapshot's refs. On the desktop Browser the person sees the tab the agent
  brings forward. A page's own popup is still refused or closed. A tab that
  lands outside the allowed origins, by a redirect too, is left for a blank
  page and the action is refused.
- On the desktop Browser the person's own tabs share the context. A tab the
  person took to a site no approval covers is listed without its address or
  title; the agent cannot switch to it, read it, or act on it, and with it in
  front the agent can still list tabs and switch to another. On the headless
  Browser, a tab that followed a redirect off the allowed origins after its own
  action is sent to a blank page before it is listed.
- A paired device does all of this as a local window does: hover, list tabs,
  choose an option, drag, upload, save a download, open, switch, and close a
  tab, navigate and type (maintainer decision, 2026-11-12). Not built yet: today
  it may hover and list tabs only
  ([Architecture: remote access](../architecture.md#security-and-authority)).

### Upload

Below Full access a file leaves this computer through a page only after a
person approves its file authority. Ordinary uploads use the thread's workspace
and an answer the person may remember for the site; a recurring routine may
instead use the explicit manifest below. At Full access an upload does not ask
and the path checks below still hold
([the Full access rule](../architecture.md#security-and-authority); maintainer
request, 2026-11-12). Not built yet: an unanswered ask still expires instead
of waiting.

- `upload` puts files into one file field. `files` names them relative to the
  thread's workspace: the Work thread's Project folder, or the Code thread's
  checkout. An absolute path, a path that climbs out, and a path that is not a
  plain file are refused before anyone is asked.
- A symbolic link is refused, at the file and anywhere between the workspace
  and the file: the file's canonical path must be the path named.
- At most 5 files, each at most 25 MB. Both are Settings defaults the person
  can change (Settings › Permissions › Browser uploads and downloads): Largest
  file, 1 MB to 1 GB (the ceiling is fixed because a save reads the whole held
  file into memory and journaled receipts bound their size by it), and Files
  per upload, 1 to 50 (maintainer decision, 2026-11-13; the ceiling is fixed
  because every file is copied to a private folder before the page gets it,
  and a context keeps its last uploads' copies until it closes). Both are
  shell settings, journaled like every shell setting, and read for each
  upload. A recurring manifest keeps 25 MB and 5 files whatever the settings
  say.
- The host copies each checked file into a private temporary folder before it
  asks, reading it through a descriptor that does not follow a link and that
  must still be the file it checked, and the page receives the copies. A file
  swapped for a link while the person reads the question is therefore never
  what is sent. A page reads an attached file when its form is sent, often in
  a later action, so the copies stay until the page's browsing context closes
  (at most 8 uploads' worth per context, the oldest deleted first), and are
  deleted then, or at once if the upload never reached the page.
- For an ordinary upload below Full access, the person is asked, naming each file with its size and the site:
  "Let the agent upload report.pdf (12 KB) to https://example.com?" The answer
  covers those files to that site once, or, with "Always allow", later uploads
  to that site from that folder in that profile: the remembered answer is
  keyed by site, folder and profile (maintainer decision, 2026-11-12). Built:
  the remembered answer is one direction, one site and one workspace folder; it
  is journaled in the shell settings like a remembered site, lifts no path or
  size check, and is listed with a Forget control in Settings › Permissions ›
  Browser uploads and downloads. Not built yet: the remembered answer is not
  keyed by profile, and it grows only through the approval answer of a window
  of this computer (a paired device's answer covers one upload). An unanswered ask waits in Needs
  you. At Full access nothing is asked. Work and Code both ask in the
  thread's Browser approval card ("Upload once", "Always allow" or "Deny"),
  through one host function that reads the remembered answer and raises the
  card, so the key of a remembered answer is the same in both modes
  (maintainer decision, 2026-11-13). A Code thread's workspace folder is its
  checkout.
- Only the agent tool can upload: it resolves the files and holds the answer,
  and the server's Browser service refuses an upload that did not come with
  them, so no route or paired device can hand a runtime a path. A CLI in a
  thread terminal cannot upload.
- Rationale: an upload is the one Browser action that reads a file off this
  computer and sends it to a site, so it keeps the narrowest reach the request
  allowed. The workspace is the folder the thread's own file tools already
  treat as its root. Broader approved-folder selection belongs only to an
  explicit recurring manifest. At Full access the same agent already holds an
  unwrapped shell and an open network, so an ask on an upload protects nothing
  the shell does not already reach; below it the ask stays and can be
  remembered per site, folder and profile.

### Recurring upload manifests

Scope hold: upload manifests take no new scope until
[the Full access rule](../architecture.md#security-and-authority) is built
(maintainer request, 2026-11-12).

Settings › Data & storage › Recurring uploads lets a local person review a
separate file permission for one enabled local Work/Code routine, its current
definition/model/authority, stored Browser profile, exact HTTPS origin and one
approved Project folder. Main and extra folders use their current host-issued
folder identities; an agent cannot supply an absolute root or choose another
folder implicitly. The selected files are relative to that folder, which stays
explicit even when a Code run has its own checkout. The profile's account-use
permission remains separate and must also be current.

A manifest names up to five plain files, their exact content digests, sizes and
extensions. The host stages bounded private copies before review and on every
use, opens without following a link, and compares full file identity and copied
contents. Hard-linked manifest files refuse. A changed file or root identity
invalidates the permission; it does not silently approve the replacement.
Ordinary one-use uploads keep their current behavior.

The person explicitly reviews a total file-use count (at most 100), total file
bytes (at most 250 MiB) and expiry (seven days by default, at most 30 days).
Each file stays capped at 25 MiB. Quota counts file contents, not HTTP framing.
Every admitted file consumes quota before the Browser receives it; later
cancellation or uncertainty is not automatically refunded. A synchronous
journal reservation makes concurrent uploads share one remaining budget. An
audit-write failure refuses the upload. The journal keeps the manifest and use
metadata, including relative file names, never file bodies or absolute roots.
A host restart restores no permission. A Project erase removes its manifest
metadata and active grants without creating replacement audit records. Manifest
metadata stays out of thread/host data exports and replica sync.

The routine selects the explicit `uploadPermissionId` and exact manifest file
paths. A missing-permission response lists only that caller/profile/site's
available manifests and remaining quotas. No file permission starts a run,
chooses an account, permits another file/site or authorizes downloads. Managed
children, terminal sessions, paired clients and ordinary task turns do not gain
recurring file permission from this routine grant. Their existing one-use or
refusal rules remain.

Expiry, Revoke, profile clear or changed routine authority invalidates pending
uses. The Browser rechecks authority while an upload waits and on later page
effects while it retains the attached copies. Revocation closes that affected
context and releases its copies; data already handed to the page/site cannot be
recalled. Existing credential, frame, ref, origin, redirect, Plan and native-owner
checks remain. No native owner means unavailable; source verification alone does
not establish packaged or personal-account acceptance.

### Download

A file comes from a page into a thread's workspace only while a switch is on.
At Full access the switch is on by default and a save does not ask; below Full
access the person turns it on and answers for the file, an answer they may
remember for the site, or separately reviews the bounded routine download manifest below
([the Full access rule](../architecture.md#security-and-authority); maintainer
request, 2026-11-12). At Full access a download is not kept waiting for a
second call either: it is saved as the action that started it answers
(maintainer decision, 2026-11-13). Not built yet: an unanswered ask still
expires instead of waiting; and the person's own download, built in the
desktop pane's download handler, has not been run in a packaged window.

- **The switch.** Settings › Permissions has "Let agents download files", off
  by default below Full access and on by default for a thread at Full access.
  It is a host setting in the shell settings, which a window of this computer
  or a paired device writes (maintainer decision, 2026-11-12; not built yet:
  today the shell route is local-only and a paired device cannot); a
  routine, a subagent, a plugin, a CLI in a thread terminal, and an agent have
  no way to set it, and a change is journaled like every shell setting. Off,
  every download on every page of a thread below Full access stays blocked, as
  before: the runtime cancels it, and the action's answer says nothing about
  it. For a thread at Full access a download is held whatever the switch says.
- **Holding.** With the switch on, a download a page starts while an agent
  action of the agent tool runs (the action and the settling after it) is held:
  the runtime keeps the file in a private temporary folder of the host (never
  the workspace) and cancels it as soon as more than 25 MB has arrived. At
  most 5 files are held per browsing context, the oldest discarded first. Both
  caps are Settings defaults the person can change (Settings › Permissions ›
  Browser uploads and downloads: Largest file, 1 MB to 1 GB, shared with
  uploads; Downloads kept waiting, 1 to 50). The server sends the current
  limits to the runtime with each action that may hold. A download a page
  starts on its own between actions is cancelled as it is with the switch off.
- **No holding at Full access.** Holding exists so a person can be asked
  about the file. A turn at Full access asks nobody, so each download its
  action started is saved into `downloads/` of the thread's workspace as that
  action answers, by the same save `download-save` runs, and the answer's
  `downloads` reports it as `saved` with its workspace path, size and sniffed
  type, or as `refused` with the reason (maintainer decision, 2026-11-13). The
  level is the one the turn runs at. What is not a review stays: the runtime
  still receives the file in its private temporary folder first, because the
  size cap and the type sniff need the bytes before they reach the workspace;
  a file over the cap is still stopped; a symbolic link on the path is still
  refused; and the save is still journaled. A turn on a paired device, which
  is not at the computer the file would land on, and a routine's manifest,
  which names its own destination, save nothing this way. Below Full access
  nothing changes: the file is held and `download-save` asks.
- **The person's own download.** A download the person starts in the Browser
  pane saves to the person's Downloads folder at every level, whatever the
  switch says; it never enters the workspace and the agent is told nothing
  about it. The desktop pane treats a download as the person's when no agent
  action is holding and the person was the last to drive the pane (a key or a
  click since the agent's last action). It is saved under the page's suggested
  name reduced to a safe basename, numbered past any file already there, with
  no size cap and no type refusal. A download a page starts on its own after an
  agent action, with no such input, is cancelled.
- **The report.** The answer to that action carries `downloads`: for each held
  file a `downloadId` (`d1`, `d2`, and so on), its name (the page's suggestion
  reduced to a safe basename), its size, and its media type sniffed from the
  file's own bytes, never from the page's header. A file that was stopped
  (over the cap, unfinished after 10 seconds, or failed) is reported by name
  and reason and holds nothing. Each is reported once.
  A native runtime may attach `source` with `kind: https-origin-chain` and
  the complete redirect chain reduced to exact HTTPS origins, at most 32.
  It comes from that completed native download item, never from the requesting
  page or an agent argument. URL paths, query values and fragments are removed;
  a missing, oversized, credential-bearing or non-HTTPS chain is unverified.
  The headless runtime currently supplies no complete-chain receipt. Omitting
  it preserves ordinary per-file review and grants no recurring authority.
- **Saving.** `download-save` names a reported `downloadId`. The server checks
  the file, then, below Full access, asks the person: "Let the agent save report.pdf
  (1.2 MB, PDF) into this thread's workspace? Page: https://example.com.
  Download source: https://example.com → https://files.example.com." It
  names the file, its size, its type, the requesting page and the attested
  source origins separately. Without a native receipt, it says "Download
  source: unverified." A page address is never substituted as source proof.
  The card carries the whole attested chain, in Code as in Work. The answer covers that file
  once, or, with "Always allow", later saves from that site into that folder
  in that profile: the remembered answer is keyed by site, folder and profile
  (maintainer decision, 2026-11-12). Built: "Always allow" covers later saves
  from that site into this thread's workspace, remembered and forgotten as an
  upload's is. Not built yet: the remembered answer is not keyed by profile. At Full access the save is not asked and the checks, the
  destination rules and the journal record still apply. Work and Code both ask in the thread's
  Browser approval card ("Save once", "Always allow" or "Deny"), through the same host
  function an upload asks through (maintainer decision, 2026-11-13).
- **Where it lands.** In `downloads/` at the root of the thread's workspace:
  the Work thread's Project folder, or the Code thread's checkout, the same
  root an upload reads from. The name is the safe basename (no path part, no
  leading dot, at most 120 characters); a name already taken becomes
  `report (2).pdf`, and a file is never overwritten. A symbolic link at
  `downloads/` or anywhere on the path is refused, and the file is created
  exclusively without following a link.
- **What is refused.** Below Full access, a program or installer, whatever its name says: bytes
  that begin like a Mach-O, ELF, or PE/COFF file, and names ending `.app`,
  `.pkg`, `.dmg`, `.exe`, `.msi`, `.bat`, `.cmd`, `.command`, `.sh`, `.scpt`,
  `.jar`, `.deb`, `.rpm`, or `.appimage`. This is refused before anyone is
  asked. Everything else may be saved. At Full access a program or installer
  may be saved like any other file, since the thread's shell could fetch and
  run one already. A file over the size cap, as for an upload, is
  never held.
- **Clean-up.** A held file is deleted when it is saved, refused, or denied,
  when its browsing context closes, and when the host starts. The headless
  and the desktop Browser keep separate folders, so one starting never clears
  the other's.
- **Journal.** `browser.download-saved@1` records the thread, the page's
  origin, the saved path relative to the workspace, the size, the media type,
  and the SHA-256, and `browser.download-refused@1` records a download that
  was stopped, refused, or denied with the thread, origin, name, and reason
  (`too-large`, `executable`, `denied`, `cancelled`, `expired`, `symlink`,
  `changed`, or `unavailable`). Neither holds bytes. Both sit on one
  `browser-download` aggregate per thread, so a thread purge removes them with
  the thread.
- **Who can save.** Only the agent tool: it names a held file by the id the
  runtime issued and the server resolves the rest, so no route and no paired
  device can name a host path or save a file. A CLI in a thread terminal and
  Plan mode refuse (`download-needs-a-person`, `plan-mode-read-only`), and
  such a turn holds no download. A paired device's turn saves as a local
  window's does (maintainer decision, 2026-11-12; not built yet: today it
  refuses with `download-needs-this-computer`). A routine's or a subagent's turn follows upload: the question goes
  to a window that can see the thread, and an unanswered question waits in Needs you and saves nothing until it is answered. A batch cannot hold `download-save`.
- Rationale: an agent's download is a file written by a page into a folder the
  thread's own file tools and a shell can reach, so below Full access it keeps
  the narrowest reach the request allowed: off by default; held outside the
  workspace until a person says yes; one folder; never over a file; and no
  program, which a later shell command would run. At Full access the thread's
  shell can already fetch and run any file, so only the path, overwrite and
  size rules remain. The switch is a person-only
  host setting for the same reason the remembered sites are: an agent must not
  be able to widen its own reach. Cancelling at the cap, rather than checking
  afterwards, keeps a page from filling the disk with a file nobody asked for;
  the headless runtime watches the browser's shared download folder. A uniquely
  attributed file cancels only its own download at the cap. When concurrent
  arrivals cannot be attributed and an unclaimed file crosses the cap, every
  still-running candidate is cancelled, including candidates in other contexts;
  waiting for completion would leave the in-flight limit unenforced. Downloads
  whose files are already attributed are not candidates. A native completion
  that races a cancellation remains refused and its file is deleted. The person's own download in the pane is theirs: it
  goes to their Downloads folder, outside the workspace, and this switch, which
  is for agents' downloads into the workspace only, does not govern it.
- Destination creation holds the checked folder as a working directory,
  verifies its physical location before creating a file, and writes only an
  exclusive relative basename. A concurrent ancestor/directory-link swap
  cannot redirect that creation or its cleanup to an outside folder. An
  unavailable destination refuses without a saved receipt. Only macOS and
  Linux have this save path; unsupported platforms refuse.
- The save boundary accepts a trusted host-selected destination internally;
  the ordinary `download-save` tool still passes only the workspace default.
  The internal selection carries the current host-resolved approved Project
  folder (main or extra), its canonical root, the exact reviewed bounded
  relative directory (`.` for that root), and the reviewed directory's device
  and inode. The directory must already exist. The host rechecks that this
  folder identity still belongs to the Project; an unavailable selection never
  falls back to the current checkout. Agent JSON cannot supply a root or these
  callbacks. This port does not itself grant recurring transfer permission or
  add a destination picker.
- Root and destination proofs are read-only. The native writer checks the
  root identity and its held destination's device/inode and physical canonical
  position before exclusive relative creation. It uses native `realpath` so
  Node's cached working-directory string cannot hide a rename. An ordinary
  missing `downloads/` is made only inside that writer after admission; an
  internal selected directory is never made implicitly.
- The save checks cancellation and selection currentness after asynchronous
  preparation. The final bytes must retain the sniffed prefix, so a held-file
  rewrite cannot carry stale type facts into admission. Once all held bytes
  and target proofs are available, a
  synchronous host callback admits current source, authority and any quota
  reservation immediately before writer dispatch. The ordinary service supplies
  its current context/authority fence and combines context and caller
  cancellation. Refusal before dispatch creates no file or directory. After
  dispatch an unsuccessful writer may have written: this boundary never refunds
  a reservation or dispatches a retry on an uncertain result.
- Ordinary saved receipts and the existing journal remain workspace-relative.
  A trusted selected save instead returns its opaque approved-folder id, a
  path-free display label and an explicit `selected-root` path base: its path
  is relative to that selected approved root, not to the thread's workspace.
  A future selected-destination consumer must carry that receipt honestly;
  it cannot write it as a legacy workspace-relative event.
- Not covered: a download
  that starts after an action's settling has ended (it is cancelled).

## Steps

- `steps` runs up to 10 operations in one call. Each step is written exactly as
  the operation would be alone, and runs through the same path a single call
  takes, so the server admits each step on its own: the thread's authority, the
  model binding, the origin approval, Plan mode, the stale check, and the
  credential check.
- The first step that fails ends the batch. The answer names it (its number,
  its operation, and its own refusal or failure) and lists the steps that ran
  before it with what each changed; no later step runs. A batch that succeeds
  answers as its last step does, with a line per step.
- A batch cannot hold another batch, an upload, a `sign-in`, a `download-save`, `stop`, a flow
  operation, or a `navigate` with a profile: each of those needs a call, and for
  an upload, a download, or a signed-in page a question to the person, of its own. A malformed step refuses the whole batch
  before any step runs.
- A batch is a list of fixed operations, never a script: nothing an agent
  writes runs in the page.
- `record: true` on the batch records the page while it runs
  ([Results](#results)). A step cannot carry it, and the start and end of a
  recording are never steps a model can write or a flow can store.
- An agent's action that names an `expectedObservationRevision` the page has
  moved past is refused as `stale` and does not run, so a batch stops there
  rather than carrying on as if the step had run. The person's pane, which
  re-polls on its own, keeps getting the page back without a refusal.
- The field a `type` or `select` changes is not page text, so such a step
  reports that the field holds the new value when nothing else changed.

## Flows

A flow is a named, fixed list of the operations an agent ran once, saved in the
Project so a later turn can repeat the check without a model turn per step. It
is `steps` kept for later: never a script, and every step is admitted when it
runs, not when it was recorded.

- **Recording.** The server keeps, for each thread's Browser page, the agent's
  successful operations since the page opened, at most 50. Each is stored as the
  operation would be written as a call (without the `expectedObservationRevision`
  and `include` that belong to one call). `snapshot`, `screenshot`, `read-page`,
  `diagnostics`, `audit`, `tab-list`, and `help` are not stored, and a failed or refused
  operation is not stored. A ref is stored as the element's role and accessible
  name, with the snapshot's selector as a hint for a reader; the ref id is never
  stored, because it means nothing on a fresh page.
- **What a flow cannot hold.** `upload`, `sign-in`, `stop`, a download save, a
  `navigate` with a profile, and an address that carries a user, a password, or a
  query value whose name suggests a secret (the same test diagnostics apply)
  each end what can be saved: the run on that page cannot be saved, and
  `flow-save` answers `flow-run-needs-a-person` naming the operation. A run
  longer than 50 steps answers `flow-run-too-long`. `stop` also drops the run.
- **Expected outcome.** Each step stores the page's path (not its query or
  fragment) and title after it, the facts behind the `changed` line, and no page
  text.
- **Saving.** `flow-save` with a `name` of 1 to 80 characters saves the current
  run as a flow of the thread's Project (Work or Code), replacing a flow of the
  same name. A Project keeps at most 50 flows, each at most 256 KiB stored.
- **Listing.** `flow-list` answers the Project's flow names with their step
  counts and first address.
- **Replay.** `flow-run` with a `name` runs the steps in order with no model turn
  between them, each through exactly the path a single call takes: thread
  authority, model binding, origin approval, Plan mode, the stale check, and the
  credential check. A step that acted by ref first takes a snapshot of the fresh
  page and picks the one element with the recorded role and name; none, or more
  than one, stops the replay. An untargeted keypress also takes a fresh snapshot
  before dispatch, including after a person hands back the page. A hand-back
  answer that substituted a snapshot is never counted as an executed step.
  After each step the server compares the page's
  path and title with the recorded ones, and the first step whose outcome
  differs, or that fails or is refused, stops the replay. The answer names that
  step (its number, its operation, and the expected and found path and title, the
  element it could not find, or the refusal) and lists the steps that ran with
  what each changed; a replay that finishes answers as a `steps` batch does. A
  replayed navigation still raises its origin approval, and the replay's own
  steps are recorded like any other operation of the agent. `flow-run` with
  `record: true` keeps an animated recording of the replay, as a `steps` batch
  does ([Results](#results)); a saved flow never holds a recording.
- **Who may.** The thread's own agent in Work and Code saves, lists, and runs. A
  paired device's turn saves and runs as a local window's does (maintainer
  decision, 2026-11-12; not built yet: today it may not, because a flow
  navigates and types, which it may not), and Plan mode lists but refuses to save or run
  ([Plan mode](#plan-mode)). A routine or a subagent may run a flow, on a Private page only,
  because the profile rules apply to each replayed step as to any call; it may
  not save one. A terminal grant has no flows. Chat has no Browser.
- **Where flows live.** Flows are host data per Project, journaled as
  `browser.flow-saved@1` and `browser.flow-deleted@1` on one aggregate per
  Project, not files in the Project folder. They are erased with the Project.
  They are not in a thread export, the host-wide data export that embeds one,
  or replica sync: those carry a thread's and a Canvas's records, and a Project's
  Browser records (profiles, approvals) travel in none of them.
- **The person's view.** Settings › Data & storage › Browser flows lists every
  Project's flows with step count and first address and deletes one after a
  confirmation, from a local window or a paired device (`/api/browser/flows`;
  maintainer decision, 2026-11-12; not built yet: today a paired device is
  refused). A person may also select an existing active, idle Work or Code task,
  review its fixed steps and run-specific text, and start through that task's
  current model and authority. Settings supplies no authority of its own.
- **Reviewed run.** The server binds the local window, flow version, task/model,
  authority and profile to a host-issued review id. A type step's text and a
  recorded expected title are editable for this run (8,192 text characters,
  1,024 title characters, existing 256 KiB total). Operations, targets and paths
  remain fixed. The person must review a changed expected title explicitly;
  Octant does not infer substitutions or drop outcome checks when text changes.
  Values stay in finite host memory and never replace the saved flow. Plan,
  unavailable providers and server Projects refuse rather than fall back to
  local execution. Each fixed step uses ordinary Browser admission with no
  provider calls between steps.
- **Progress and Resume.** A run holds exclusive agent Browser custody for its
  task, including while paused; the person may still take over and hand back.
  Only a refusal proving that a human-held operation did not run becomes Paused.
  Resume is explicit and repeats that unexecuted step with a fresh snapshot.
  A changed flow, task/model/authority, profile, context or site approval refuses
  Resume and requires review again. Other failures and uncertain effects stop
  without retry. Closing or cancelling stops the run; an already dispatched
  operation may have acted. A review/run expires after 15 minutes, and at most
  20 runs are retained. Window revocation or host shutdown cancels custody.
  Progress reads never dispatch or resume a step.
- Rationale: a stored step is read again with the tool's own parser at replay,
  so a flow can carry nothing a call could not, and a corrupted or edited record
  cannot add an operation. Refs are stored as role and name because a ref
  names an element of one snapshot, while a role and name is what the stale check
  already trusts; requiring exactly one match turns a page that changed under a
  flow into a stop, not a click on the wrong element. Comparing path and title,
  not text, keeps the check cheap and keeps page content out of the Project's
  data. Typed text is stored as typed: credential fields can never be typed into
  (a `type` or `press` into one is refused before any runtime acts), so no
  password, code, or card number reaches a flow through a step, and an address
  that holds a secret ends the recording instead. A step that needs the person
  ends what can be saved because a stored step carries no credential or sign-in authority. A failed operation is
  not stored and does not end the run: the page is as it was, and storing it
  would replay a mistake. A routine may run but not save because saving writes a
  Project's data for good, with nobody there to have meant it. A secret in an
  address's path or in a query value under a name the test does not know is not
  detected, and text typed into a field the page did not mark as a credential is
  stored as typed, so a flow is Project data the person can read and delete in
  Settings. A fragment is left out of the stored address because it never reaches
  a server and often carries a token. A tab id is stored as the context's own
  ordinal, so a flow with tab steps is meant for a fresh page. The Settings list
  deletes but does not run for the reason above. Measured on a local page with
  a two-field form (headless Chromium), the model's tool results for navigate,
  snapshot, type, click, and a verifying read-page were 175, 353, 179, 149, and
  226 bytes, 1,082 in all; `flow-run` of the three steps that remain
  (navigate, type, click) answered once in 461 bytes, and the model sent one
  short call instead of five. A longer page widens the gap, because a snapshot
  grows with the page and a replay does not.

## Waiting, dialogs, and viewport

- `wait` waits for an element to appear (a selector or ref), or for up to 5
  conditions: text present or absent in the page's visible text (never a
  field's value), an address that contains a string, the page's
  `domcontentloaded` or `load`, or an element attached, detached, visible,
  hidden, enabled, or disabled. `match` is `all` (the default) or `any`.
- Every wait has a limit: `timeoutMs` up to 10 minutes, 10 seconds when
  it names none, on both Browsers. The 10-minute ceiling is a Settings default
  the person can change (maintainer request, 2026-11-12). Not built yet: today
  the ceiling is a fixed 30 seconds. A wait that runs out fails and names the
  conditions that never held. A ref in a wait becomes the snapshot's selector
  without the identity check an action makes, because waiting for an element
  to change or leave is the point.
- **Settling.** After `navigate`, `click`, `type`, `press`, `scroll`, `hover`,
  `select`, `drag`, `upload`, and `resize`, the Browser waits for the page's
  load and then for the document to stop changing for 250 ms, at most 2
  seconds in all, before it reads the page and answers. A page that never stops
  changing costs the cap and still answers.
- **Dialogs.** The agent can answer a page's dialog itself: accept it, dismiss
  it, or give the text for a prompt (maintainer request, 2026-11-12). A dialog
  the agent does not answer is answered by one fixed rule: an alert and
  a leave-page question are accepted; a confirm and a prompt are dismissed, so
  the page never gets an answer the agent did not give. Not built yet: today
  the agent cannot answer and the fixed rule answers every dialog. Each dialog is
  reported in the next answer as `dialogs`, with its type, its message (at most
  512 characters), and the answer. The headless Browser applies the rule to
  every dialog; the desktop Browser applies it while an agent's action runs,
  and a dialog that opens while the person drives stays theirs. The desktop
  Browser leaves alone a page whose developer tools someone else attached.
- **Viewport and device.** `resize` makes the agent's page look like another
  device. Each field changes only what it names, and `resize` with none of them
  restores the page's own size, touch, and color scheme together.
  - A `preset` names a whole device: `phone` (390 by 844, pixel ratio 3,
    mobile), `phone-landscape` (844 by 390, ratio 3, mobile), `tablet` (820 by
    1180, ratio 2, mobile), or `desktop` (1280 by 800, ratio 1, not mobile). A
    mobile preset also turns touch on, and `desktop` turns it off, unless the
    call sets `touch` too. A preset beside `width` or `height` is refused.
  - `width` and `height` together set a plain size of 320 to 3840 by 320 to
    2160 CSS pixels, with pixel ratio 1 and no mobile flag.
  - `touch` true makes the page a touch device: touch events, `pointer: coarse`,
    and `navigator.maxTouchPoints` above 0. A `click` on a touch page then
    reaches it as a tap (a touch start and end at the element's center) where
    the runtime can send one, and the page sees the touch events a finger
    sends. A page that tests `'ontouchstart' in window` once, as it loads,
    needs a navigation to see the change. `touch` false turns it off.
  - `colorScheme` is `light` or `dark`, which sets `prefers-color-scheme`, or
    `default`, which returns the page to the scheme it had before.
  - The answer's `emulation` says what the page now reports about itself,
    measured in the page: its width, height, pixel ratio, whether it is a touch
    device, and its color scheme.
  - It acts only on the agent's own page, the thread's Browser context, and
    on the tab in front when it runs: emulation belongs to that tab, a new tab
    starts without it, and a restore acts on the tab in front. The headless Browser sets that page's
    viewport, media, and touch through its protocol session. The desktop
    Browser uses the view's device emulation for the size, so the person's
    window and other contexts do not move or restyle, and the debugger protocol
    for touch and color scheme. Those protocol overrides last only while the
    debugger is attached, so the desktop Browser keeps its own attachment on a
    page while touch or a color scheme is emulated and lets it go on restore.
    A page whose developer tools someone else attached is left alone: touch and
    color scheme are refused there (`Browser automation control is already in
use`), a size still applies. The person sees the page at the emulated size
    until it is restored. A paired device resizes and emulates as a local
    window does (maintainer decision, 2026-11-12; not built yet: today it
    cannot), and Plan
    mode refuses it ([Plan mode](#plan-mode)).
- Rationale: emulation is optional fields on `resize` rather than a separate
  operation. The operation already means "change how the page is sized, and
  restore it", it keeps one restore that undoes everything, and the model learns
  no new verb; the fields stay narrow because each is a fixed host action with
  an enumerated value. Presets are a short fixed list, not free numbers, so the
  pixel ratio and mobile flag the agent can set are only those of a real device,
  and a size without a preset can never claim to be mobile. Touch on a mobile
  preset follows the device it names, because a phone without touch tests
  nothing. The answer reports what the page measures instead of echoing the
  request, so an emulation that did not take hold shows.
- Rationale: a dialog the agent does not answer gets a fixed rule instead of
  a question to the person, and dismissing a
  confirm is the answer that changes nothing. Bounding the viewport to common
  phone and desktop sizes keeps the page renderable at any size it reaches.

## Page lifetime

A Browser context is a live resource on this host, not a persistent owner or an
approval grant. Its existing `sessionTimeoutMs` is an idle interval: ten minutes
for an agent-opened page and five minutes for the person's ordinary toolbar
page. Creation has that same finite bound from its start; activation starts a
fresh idle interval. A late native creation is closed after timeout rather than
made active.

- **Meaningful activity renews idle.** Terminal-grant operations use host-owned
  activity attribution independently of capture retention: an explicit terminal
  read renews idle without keeping a capture or extending a person's hold.
  An explicitly requested Browser operation
  renews the interval after authority, policy, revision/ref and credential
  checks, immediately before it reaches the runtime, and again when it finishes
  while the context is still live. Intentional agent reads, snapshots,
  screenshots, waits, tab operations, diagnostics and audits count, as navigation and
  input do. A runtime failure after true admission is still a recent attempt;
  a refusal, a held call or a call waiting in the queue is not activity.
- **The person's input counts.** Native keys and clicks, and the existing
  meaningful actions relayed through the pane, renew idle. An intentional
  screenshot taken by the person also counts. Moving the pointer, focus,
  key-up and ordinary scrolling do not. This does not change which person
  input invalidates the agent's refs.
- **Watching does not keep a page open.** Renderer inspection, preview pictures,
  dashboard listings and automatic polling never renew it. The toolbar names
  the page's idle interval, or its separate person hold; it is not a countdown.
- **Active work can last longer than ten minutes.** There is no new
  creation-based cap that closes a page while meaningful authorized work
  continues. Each operation still revalidates authority. Without activity, the
  finite idle deadline aborts pending runtime calls and closes the context;
  a hung call, queued call, late answer or late input cannot extend or revive
  it. A timer that was already queued checks the latest deadline before expiry,
  and cannot restart a stopped context's scheduling.
- **A waiting transfer question keeps its page.** An upload or download
  question has no expiry (maintainer decision, 2026-11-13), and its page has
  no idle deadline while the question waits, so a later answer still finds
  the page. When the question ends, by an answer, the call or turn stopping,
  the thread's archive, the window's revocation or the host stopping, the
  page returns to a finite deadline (two minutes of grace, or its ordinary
  idle deadline if later). The staged upload copies and the held download
  file are deleted on any outcome but approval, and a download question also
  ends when its page closes, so a question that waits holds nothing after it
  is withdrawn. A site approval holds no page and needs none.
- **Handoffs have their own phase bounds.** A sign-in card has no expiry
  ([Asking the person to sign in](#asking-the-person-to-sign-in)), and its page
  has no deadline and holds no expiry timer while the card waits: the card is
  the wait, and a page that closed under it would leave the person a card
  with nothing to sign in to. The card ends, and the page returns to a finite
  deadline, when the person answers, the turn stops, the thread is archived,
  the window's authority is revoked, or the host stops. A take-over's page is
  retained for eleven minutes from the hold, and take-over
  input renews that eleven-minute hold, with the existing one-minute scheduling
  throttle. Answering the card or handing back replaces the hold with two
  minutes of grace, taking the later of that grace and the ordinary idle
  deadline. The release control alone does not grant a fresh normal interval;
  subsequent admitted work or person input does. Waiting agent calls and
  passive handoff polling never extend it.
- **Closing and recovery keep their authority.** Stop, revocation, window/host
  close and process death keep their existing teardown behavior. Expiry is
  recoverable only by an explicit newly authorized navigation; it never
  silently opens a page or changes profile. A stored profile may keep its site
  data, but an expired context, refs and controller binding do not survive.
  Routine, child, terminal-grant, paired-device and profile restrictions remain
  unchanged; activity adds no persistent owner, sign-in right or new grant.

Rationale: applying the existing interval to actual work fixes creation-based
expiry without turning renderer observation into a keepalive or inventing a new
absolute limit that would interrupt an active task again. Activity stays in
host memory; no cookies, account inventory or persistent activity journal is
needed.

## Asking the person to sign in

- `sign-in` (with an optional `reason`, at most 300 characters) hands the open
  page to the person when it needs an account. It needs a page open already, in
  the desktop app's own Browser: a headless page reaches the person only as a
  picture, and typing into its password field is refused like any other
  relayed typing, so there it is refused (`sign-in-needs-the-app-browser`).
- The person sees a card in the thread: "The agent asks you to sign in on
  example.com", the reason, and **Continue** and **Cancel**. Work shows it with
  the thread's Browser approvals and Code with the Browser requests in its
  thread; both are the same host approval, never remembered, and it waits until
  the person answers it, as every ask does under
  [Unattended work](../architecture.md#security-and-authority) (maintainer
  request, 2026-11-12; built). It is cancelled, never answered for the person,
  when the turn stops, the thread is archived, the window's authority is
  revoked, or the host stops. Not built yet: the pending-requests read (Needs
  you) does not list it; it waits as the card in its thread.
- The page is marked as waiting for the person. Every window showing the thread
  brings its Browser forward once, through the thread's activity preview, and
  the agent tool holds every other agent Browser call on the page until the
  card is answered (`browser-waiting-for-person`); `stop` still works.
  The hold is checked again right before an action runs, so a call that was
  already waiting on an approval when the hand-off began does not act either.
  One hand-off at a time per page.
- The page outlives the hand-off under the finite phase windows described in
  [Page lifetime](#page-lifetime): for as long as the card waits, then the later
  of its ordinary idle deadline and two minutes after the card is answered so
  the agent can read it.
- The person signs in manually or explicitly approves a selected 1Password
  binding and reviewed login form. Ordinary agent typing into credential
  fields still refuses. Brokered filling keeps values in host custody and
  holds agent actions/observations during private read, fill and submit;
  overlapping observations cannot publish after release. The website's own
  code can retain or reflect input, so later page content may disclose it.
- On **Continue** the agent gets a fresh snapshot of whatever page the person
  left. If that site is unapproved, the refusal says plainly that the person
  left the page on an unapproved site after Continue; it reads nothing there
  and does not widen the original origin approval. **Cancel** ends the hand-off with `browser-sign-in-denied`, and the turn
  stopping, the thread's archive, or the window's revocation with
  `browser-sign-in-cancelled`, and the page is the agent's again.
- Refused before anyone is asked on a routine's or a subagent's turn and for a
  CLI in a thread terminal (`sign-in-needs-a-person`): nobody there can sign
  in. A paired device's turn is offered the sign-in, and the person signs in
  from that device or at the computer (maintainer decision, 2026-11-12; not built
  yet: today it is refused, `sign-in-needs-this-computer`).
- While a native page is held for sign-in or take-over, **Login permission**
  lets the person review one 1Password account/vault/item by immutable IDs.
  The review names the exact HTTPS origin and port, top frame, profile and
  Project/task scope before **Allow selected item** records permission.
  **Revoke permission** removes it. This records no authentication result,
  grants no iframe or script access. Saving permission fills nothing.
  **Review login form** names the selected fields and exact submission/return
  sites before separate **Fill selected fields** and **Submit sign-in form**
  actions. Filled/authentication-required outcomes do not mean signed-in.
  MFA, CAPTCHA, passkeys and ambiguous forms remain manual. Cancellation before
  native commit prevents it; after start, the receipt states possible/completed
  effect, not undo. Exact approved SSO hops keep the same task/profile with a
  bounded top-frame/view-only admission, without widening agent origins. Its
  reference-only host-session/eight-hour lifecycle and per-use validation
  follow [the credential boundary](../architecture.md#linked-secret-stores).

- Rationale: the handoff keeps credential resolution outside the agent and
  holds its page access during use. The person checks what the site shows
  before continuing because site code may reflect credentials. The page keeps its profile; a Private page's sign-in lasts as
  long as the page, and a Project or Personal page keeps it for the next page
  in that profile ([Browser profiles](browser-profiles.md#profiles)).

## Person and agent together

The page is the person's as much as the agent's. Neither takes it from the
other without saying so, and the server, not the pane, decides.

### Recurring download manifests

Scope hold: download manifests take no new scope until
[the Full access rule](../architecture.md#security-and-authority) is built
(maintainer request, 2026-11-12).

Settings › Data & storage › Recurring downloads lets a local person review a
separate file permission for one enabled local Work/Code routine, its current
definition/model/authority, stored Browser profile, exact requesting-page HTTPS
origin and complete allowed source-origin set. Account access remains a
separate permission, and the local host's download switch must stay on.
The routine must explicitly name its `downloadPermissionId`; neither a parent
nor an account permission lends file authority. Ordinary turns, children,
terminals, paired clients and Plan gain no recurring download permission.
The eligible routine's tool schema explains discovery: a `download-save` call
without that id lists only this routine and current profile's reviewed manifests,
including their ids, source/page origins, destination, types, remaining quotas
and expiry. It saves nothing and consumes neither the held file nor quota.
The agent selects a matching reviewed scope and retries the save with that
returned `permissionId` as `downloadPermissionId`. The person need not copy an
id from Settings. No match means a local person must review a new manifest;
discovery never creates or broadens a grant.

Review names one current approved main or extra Project folder, an existing
relative directory, allowed sniffed file types, total count and byte limits
(at most 100 files and 250 MiB), and expiry (seven days by default, at most
30 days). Each file remains capped at 25 MiB. The complete native download
receipt must attest every redirect origin as an exact member of the reviewed
set; absent, unsafe, headless or foreign-origin receipts refuse. The page's
origin never substitutes for source proof. Paths, queries and fragments are
not retained as source metadata.

The host pins the approved root and reviewed directory identities independently.
It resolves no agent-supplied root and falls back to no checkout. Changed or
linked directories, expired/revoked permission, changed routine/model/authority,
cleared profiles and unsupported writers refuse. The final source/type/current
checks and synchronous journal-before-dispatch quota reservation follow complete
byte reads and directory proofs. Concurrent saves share the remaining quota;
uncertain effects are not refunded. A held download id is consumed before any
await, so a retry cannot dispatch that same held file a second time. Native
creation remains exclusive and never overwrites an existing file.

A selected save returns its opaque approved-folder id, path-free label and
explicit `selected-root` path base. Its path is relative to that selected root,
not the thread checkout. A distinct selected-save journal event preserves the
ordinary workspace receipt unchanged. Grant/use audit keeps no bytes or
absolute roots; it is erased with the Project. A host restart restores no
permission. Revocation/expiry interrupts pending uses and closes affected
contexts; a file already dispatched may have been saved and must be inspected
before retrying. The journal reports actual owning threads, never a temporary
routine execution id as their data owner. This is implementation scope, not
packaged, personal-account or cross-platform acceptance evidence.

### The person's input is kept

- On the desktop Browser, the person's keys and clicks reach the page while the
  agent acts. Nothing is dropped, and nothing in the page is held back. The
  agent's own input comes through the debugger and never through the person's
  input path, so the two are told apart by how they arrive. A pointer moving
  over the page, a key coming up, and a scroll are not the person using it.
- On the headless Browser, the person acts only through the pane's relayed
  actions; one that changes what the page shows or holds (navigate, click, type,
  press, hover, choose, drag, a tab change) counts the same way. A screenshot,
  scroll, or read does not.
- **Person input drops the agent's refs.** The desktop Browser tells the server
  which pages the person used. The server drops the snapshot's refs as a
  navigation does, and notes that the person used the page.
- **The agent is told once.** The next answer to an agent Browser call carries
  one line, `note`: "The person used the page since you last looked. Take a
  fresh snapshot before acting." It is said once per stretch of the person's
  input, on whatever the call answers, a refusal included.
- **An agent action never overwrites what the person is typing.** The action in
  flight when the person started finishes. After the person's input, the next
  agent action that clicks, types, presses a key, hovers, chooses, drags, or
  uploads is refused as `stale` and does not run, whether it names a ref or a
  selector, until the agent has taken a snapshot (a `snapshot` operation or an
  `include` of one). Reading, waiting, scrolling, screenshots, diagnostics,
  audits, tab listing, and navigating still run. A snapshot that was already in flight when
  the person typed does not clear it: it began before their input.
- The desktop Browser enforces the same rule at its own action boundary, where
  the person's key is known the moment it lands, not a poll later: it refuses an
  agent key or click as `stale` until the agent has read the page since.
- Rationale: refusing only a ref would leave a selector, a bare `press`, and a
  `type` into the focused field free to land in a field the person is typing
  in, so the narrowest rule that protects their text refuses every action that
  sends a key or a click until the agent has read the page again. Refusing
  costs the agent one snapshot; overwriting costs the person their text. The
  in-flight action finishes because it cannot be taken back without leaving the
  page half changed.

### Take over and Hand back

- While a page is open, the Browser pane's toolbar carries **Take over** as an icon
  button after the address field (in the More menu when the trailing icons do not fit), on the desktop and the headless Browser alike. One click
  holds every agent Browser call on that page for the person: the sign-in
  hold, under another name (`waitingForPerson` is `take-over`), not a second
  mechanism. The status icon then reads "You have the page" and the toolbar shows **Hand back**
  in place of Take over. Hand back releases the hold.
- While held, an agent Browser call is refused with `browser-person-took-over`
  and a message saying the person took over and that it should say it is
  waiting rather than retry. The check runs again right before an action
  runs, as it does for a sign-in. `stop` still works and ends the page and
  the hold with it.
- The hold is checked again inside the page's action queue, after a call is
  dequeued and before it is admitted, so a call that was already waiting
  behind another action when the person took over never runs; it is answered
  as the hold.
- The person's own relayed actions are not held: on the headless Browser they
  are how the person drives the page. Every one counts as the person using it.
- After **Hand back**, the first agent call that would click, type, press,
  hover, choose, drag, or upload is not run: it is answered with a fresh
  snapshot, the way **Continue** answers a sign-in, with a `note` saying the
  person handed the page back and the call did not run. A `steps` batch
  stops at that step and answers with the snapshot and the note, so later steps,
  planned against the old page, do not run. Other calls run as
  they would and carry the ordinary note that the person used the page. The
  agent's refs are good again from that snapshot.
- One hold at a time per page: while the agent's sign-in ask is open, Take over
  is refused, and Hand back never ends a sign-in; only its card does. A second
  Take over is the same one. The page stays open while the person holds it, and
  for as long as they keep using it; with no input for 11 minutes it ends like
  any page whose session ran out.
- Taking over changes no authority. It keeps the agent out and adds nothing for
  anyone to do on the page, so it is not journaled, as the sign-in hold is not.
- **Who may.** Take over and Hand back are the person's, from a window of this
  computer that can see the thread, through `/api/browser/contexts/take-over`
  and `/api/browser/contexts/hand-back`. The route checks the window's
  capability and its authority over the thread; the service refuses a routine's
  window and a page that is not there, in another window, or whose authority
  ended. A routine, a subagent, and a terminal CLI never reach it: it is not
  an operation of the agent tool. A paired device takes over and hands back
  as a local window does (maintainer decision, 2026-11-12). Not built yet:
  today a paired device may not, and the gateway does not admit the paths for
  it.
- Rationale for what is built today: a paired device may tap, press, and
  scroll a Private page (`remoteBrowserActionReach`) but cannot type, choose,
  or navigate, so holding the agent out of a page was worth nothing to it. Once
  a paired device types and navigates, the hold is as useful to it as to a
  window.

### Owner control of an open Code page

An enrolled owner has a separate signed control path. It is what is built
today; once every paired device controls the Browser as a local window does
(maintainer decision, 2026-11-12), this unlock gates nothing and the path
is kept only until that is built. It does not widen the
ordinary paired-device routes above. The first supported resource is an
already-open, visible native Code Private page in its original local window.
Work, Chat, dedicated pages, routine/subagent scopes, stored profiles, embedded
or hidden views, and headless pages are refused. Listing targets exposes only
the exact thread, site and controller metadata, under owner administration
consent. It exposes neither page content nor a local window capability.

Taking over always needs a fresh own-class unlock bound to that selected host,
thread, context, document and origin-policy version. An administration session
cannot authorize it. One controller receives at most 60 seconds, measured from
admission with an absolute native deadline. Every subsequent request is signed
by that original owner identity, uses a one-use sequence, and revalidates owner
list/key/device status, task/window authority and the native target. A control
ID alone grants nothing. A changed document, active tab or viewport refuses
old coordinates; the person must select and unlock the current target again.

The owner uses a closed touch-tap/touch-scroll/key/text operation set. Native
mouse dispatch cannot stand in for a tap: the supported Electron runtime emits
the same reclaim event for a dispatched mouse click as for local mouse input.
Fixed touch dispatch preserves local mouse/key reclaim without suppressing it.
There is no URL,
selector, JavaScript, arbitrary protocol, transfer, profile or credential-broker
operation. Page navigation remains inside the task's existing reviewed origins;
owner input does not add origins. Device-local authenticators, popups, unsupported
pages and cross-origin sign-in paths may require **Finish on the host Mac**.

Frames are volatile, person-only JPEG responses, at most 1920 by 1200 and
4 MiB of JPEG bytes, with bounded base64/JSON transport. They can contain credentials.
They never enter agent observations, captures, artifacts, journal, export or
logs. The native source must still be visible and current after capture.
Private fill/script custody blocks owner frame/input admission, including an
acquire-and-release interval overlapping a late frame. Owner control likewise
blocks private fill/script acquisition and agent observations; an earlier
agent capture cannot publish after a control interval has ended.

The local toolbar names the active owner and offers **Reclaim locally**. Local
input immediately invalidates remote control at the native boundary. **Stop
remote control**, lease expiry and disconnect do not resume the agent: the
existing person hold remains. Closing or hiding the owner view aborts pending
requests and sends a bounded, signed stop without another unlock. An unreachable
host may retain its finite lease until expiry; instantaneous network-disconnect
revocation is not promised. A sent input can have a possible effect and is never
automatically retried. Only an explicitly confirmed **Hand back** releases the
person hold and requires the agent's fresh reading before acting again.
A handback is confirmed only while the native controller is still current, so
after local input reclaims the page a remote **Hand back** is refused and the
person hold stays. An input still awaiting its native result prevents a
confirmed handback, another controller and agent observations on that page. A transport failure is not proof
that input stopped; an unsettled native input keeps those operations refused.
Host-observed membership and journaled device/resource changes revalidate the
current controller and abort its queued requests before input admission. This
does not promise atomic revocation across a disconnected host or an effect that
has already started.

The journal records only bounded authority/effect metadata with the actual
`owner-unlock` petitioner. Its service envelope is `system`, not a fabricated
local user. Typed values, origins, frames and signing material are absent, and
thread purge removes these thread-owned records. The live controller and
frames are not recovered after host restart.

- Rationale: reusing the sign-in hold keeps one place that decides the page is
  the person's, so every agent path (Work, Code, a batch's steps, an action
  that waited on an approval) already checks it. The refusal names a different
  reason because "waiting for the person to sign in" would be false.

## Diagnostics

- `diagnostics` returns what the page reported: console errors, requests that
  never completed (`failedRequests`), and responses with a 4xx or 5xx status
  (`httpErrors`: address, method, and status). `warnings: true` adds console
  warnings.
- No body and no header of any request or response is read or kept. Both
  Browsers redact a reported address: no user or password, no fragment, and a
  query value whose name suggests a secret (token, key, code, password) reads
  `redacted`.
- The cursor counts every kind, warnings included, so a read with warnings
  after a cursor from a read without them starts after warnings it did not
  return; read with `warnings: true` throughout to follow them.
- Every entry carries a number, counted per page context across all kinds, and
  each answer carries `diagnosticsCursor`, the last number it covers. Passing
  it as `since` returns only what came after. A read clears nothing, so the
  agent and any other reader never take entries from each other.
- At most 32 entries of each kind are kept, the oldest dropped first, each at
  most 2 KiB of text. Diagnostics stay on this computer: no telemetry.
- Rationale: a read that cleared made the second reader see nothing, and a
  cursor answers the agent's real question, "what happened since I last
  looked", without that.

## Page audits

`audit` checks the open page the way a developer does while building it:
`{"operation":"audit","kind":"accessibility"}` or `"kind":"performance"`.

- **A read.** An audit reads the page in front and never navigates, reloads,
  or changes it; it takes no other argument, so no option can make it act. It
  is admitted exactly where `diagnostics` is: the thread's authority, the
  model binding, the origin approval, the person's hold, and Plan, which
  admits it as it admits every read of the open page
  ([Plan mode](#plan-mode)). It may be a
  step of a batch, a flow does not store it, and its answer carries no
  `changed` line. The page's address and title come back with it, so a
  snapshot's refs stay good. Like every read, it marks the thread as having
  read outside content, and its result stays on this computer: no telemetry,
  no upload.
- **The same reader in both Browsers.** The checks run in the shared page
  reader (`readBrowserPage`), in the desktop Browser's isolated world and in
  the headless page, and the server shapes what it read, so both Browsers
  answer with the same rules, words, bounds, and redaction. A Browser that
  cannot audit (an older desktop app) refuses with `unavailable` ("This
  Browser cannot audit pages."), never an empty result that would read as a
  clean page.
- **Scope.** The top document and its open shadow roots. Frames are not
  audited; the answer counts them in `framesNotAudited`.

### Accessibility

- Each finding has a `rule`, a `severity` (`serious` or `moderate`), the
  host's own `message` (with the WCAG criterion), and the element: its `ref`
  when the latest snapshot of this page gave it one, otherwise its `selector`
  (left out when longer than 256 characters rather than shortened into
  another), with its role and accessible name as the snapshot names them, or
  its first 80 characters of text when it has no role. No field value is
  read, so a credential field is named, never valued.
- The rules:

  | Rule                | Finds                                                                                                                     |
  | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
  | `image-alt`         | An image, image button, or `role="img"` with no text alternative; `alt=""` is decorative and passes                       |
  | `button-name`       | A button with no accessible name                                                                                          |
  | `link-name`         | A link with no accessible name                                                                                            |
  | `field-name`        | A form field or custom field role with no label, `aria-label`, `aria-labelledby`, title, or placeholder                   |
  | `document-title`    | A page with no title                                                                                                      |
  | `document-lang`     | An `<html>` with no `lang`                                                                                                |
  | `heading-order`     | A heading more than one level below the heading before it                                                                 |
  | `duplicate-id-aria` | An id used more than once in its root when a label or an aria attribute points at it                                      |
  | `color-contrast`    | Text under 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold), over a background it can know                          |
  | `focusable-hidden`  | An element in the tab order inside `aria-hidden="true"`                                                                   |
  | `target-size`       | A touch target under 24 by 24 CSS pixels whose 24 px circle reaches another target, only while the page is a touch device |

- A name counts from every source a browser uses that the reader can see:
  `aria-labelledby`, `aria-label`, labels, title, placeholder, the default
  name of a submit or reset button, the text of the content, alt text and
  labels of descendants, an SVG's title, and CSS-generated text. Content that
  is not drawn (`hidden`, `display: none`, `visibility: hidden`) or is
  `aria-hidden` names nothing, so `<button><span hidden>Save</span></button>`
  is unnamed; a label or `aria-labelledby` target that is itself hidden still
  names, as browsers name from it. A finding is made only when every source
  is empty, so the rule errs toward silence.
- Elements not drawn, and elements hidden from assistive technology
  (`aria-hidden`, or inside an `inert` subtree), are not checked for names,
  heading order, or target size. Inline links in a sentence and browser-drawn checkboxes
  and radios are exempt from target size, as WCAG 2.5.8 exempts them.
- Contrast is judged only where the colours are known: solid background
  colours composited up the element's ancestors onto the white page. Text over
  a background image or gradient, with a text shadow, inside a positioned
  element with no background of its own, on a dark page canvas, or with
  colours in a space other than sRGB is counted in `contrastNotMeasured` and
  not judged. So is text under a filter, blend mode, or partial opacity on
  itself or on any ancestor, even when its own background is opaque: the
  effect changes text and background together.
  Disabled controls are exempt.
- `target-size` runs only while the page reports a coarse pointer; otherwise
  `notRun` names it with how to run it (`resize` with `preset` `phone` or
  `touch` true).
- **Bounds.** The reader reads at most 6,000 elements, in tree order, and
  every rule looks only at those: an id or reference past the bound is not
  read, so `duplicate-id-aria` counts holders among the elements read. At most 10 findings per
  rule and 25 in all are listed, serious rules first; `found` counts every
  rule's findings, listed or not, and `truncated` says when more exist or the
  page was larger than the reader reads.

### Performance

- **What is measured.** The browser's own record of the load that made this
  document: the navigation timing (`domContentLoadedMs`, `loadMs`, the type),
  first contentful paint, the largest contentful paint and the element it
  drew (by ref or selector, and its resource's address), layout shifts, long
  tasks, and the resources the page fetched, all read through `buffered`
  performance observers by fixed code; nothing is installed in the page. The
  answer's `documentAgeMs` says how long ago that load began.
- **Vitals.** `ttfb`, `fcp`, `lcp`, `cls` (the largest burst of shifts: less
  than a second apart, at most five seconds, shifts after input left out), and
  `tbt` (each long task after first contentful paint, past its first 50 ms,
  up to the audit). Each is rated `good`, `needs-improvement`, or `poor`:

  | Metric | Good up to | Poor above |
  | ------ | ---------- | ---------- |
  | TTFB   | 800 ms     | 1,800 ms   |
  | FCP    | 1,800 ms   | 3,000 ms   |
  | LCP    | 2,500 ms   | 4,000 ms   |
  | CLS    | 0.1        | 0.25       |
  | TBT    | 200 ms     | 600 ms     |

- **Requests.** The count and transfer size of the document and every
  resource, by type (`document`, `script`, `stylesheet`, `image`, `font`,
  `fetch`, `media`, `other`), and the five largest by transfer size. A
  resource's address is redacted exactly as diagnostics redacts one (no user
  or password, no fragment, a secret-named query value reads `redacted`) and
  capped at 1,024 characters. A cache hit, or a resource from another origin
  that does not allow timing, transfers 0 bytes as the browser reports it.
  Chromium keeps 250 resource entries; a list that full says `listFull`.
- **The page now.** Live DOM nodes, script heap in use, and event listeners,
  read with the debugging protocol's `Performance.getMetrics`, which the
  audit enables and disables around the read. Its duration counters start when
  the domain is enabled, so they are not reported. While someone else holds
  the desktop page's developer tools these are not read.
- **What is not measured,** in `notMeasured` with the reason: a metric the
  page has not produced yet (no paint, load not finished), one the browser
  does not report, the page counters when they could not be read, and always
  `inp`.
- **A fresh load is a navigation.** An audit never reloads. To measure a fresh
  load the agent navigates to the page again, which the navigation rules
  admit, and then audits.
- Rationale: the browser already buffers every one of these entries from the
  document's start, so reading them back measures the real load without
  injecting an observer into every page or giving a read the power to reload.
  INP is left out because Chromium does not record input sent through the
  debugging protocol as interactions (measured: a 180 ms click handler driven
  this way left no `event` or `first-input` entry), so it would read as "no
  interaction" after the agent clicked; TBT is the lab stand-in. The protocol's
  duration counters are left out because they read zero when enabled at the
  audit (measured on headless Chromium 1243).

### Rationale

- One operation with a `kind` keeps the verb list short and the authority one
  rule: both audits are reads of the page in front.
- The accessibility checks run in the shared page reader rather than over the
  browser's accessibility tree (`Accessibility.getFullAXTree`). A finding is
  only actionable with the element's ref, and the reader computes the same
  selector the snapshot keeps for each ref, so the server names a finding by
  ref with no extra round trip. Mapping accessibility-tree nodes back to
  snapshot refs needs a protocol round trip per node that differs between the
  two Browsers, and the desktop Browser cannot reach the protocol while
  someone else holds the page's developer tools. The reader instead looks
  wider than the snapshot's own naming and reports only when every source is
  empty.
- Not shipped as unreliable: contrast over images, gradients, and layered
  elements (counted, not guessed); the validity of a `lang` value; landmark
  and region rules, which are advice rather than failures; INP and the
  protocol's duration counters (above).

## Parallel threads

Several threads of one Project may each drive their own page at the same time.

- A thread's Browser operations reach only that thread's browsing context. The
  agent tool, a subagent's tool, and a terminal grant are each built for one
  thread and look the context up by that thread, so a tab id such as `t2` means
  a tab of the caller's own context and no other. The server also checks it a
  second time: an agent action names its thread, and the service refuses a
  context another thread owns even when both threads share a Project, and so an
  authority, and even when the request carries that context's action and
  correlation ids. Inspect, stop, and release already check the thread.
- Contexts do not wait on each other. The server and the desktop host each queue
  actions per context (surface), never across them, so one thread waiting on its
  page does not hold up another's click. Actions on the same page still run one
  at a time, in the order they were asked.
- The person sees the pages in the Project browser dock's tab strip
  ([Workspace](workspace.md#tool-lifecycles)): page title or
  host, the owning thread's title, and an "Agent active" mark. The list is a
  server route (`/api/browser/project-agent-pages`) for a window that holds the
  Project; it names a thread's page only when the window also holds that
  thread's live Browser authority, and returns the page's title and host, the
  thread's id and title, and whether an agent drives it. It returns no page text
  and no picture; a selected page's picture is read through its own thread's
  route, under that thread's authority, as the dock's Browser card reads it. A
  paired device reads the same list (maintainer decision, 2026-11-12; not built yet:
  today it gets a page in a stored profile named by its existence alone).
- An agent counts as driving a page while an agent action is queued or running
  on it and for 15 seconds after the last one ends; a CLI in a terminal grant
  is not marked.
- Rationale: threads of a Project share an authority, so the request's authority
  cannot tell their pages apart; the thread the caller acts for is the only fact
  that can. Per-context queues cost nothing and make the "at the same time"
  promise true on both Browsers. The 15-second linger keeps the mark steady
  while a model thinks between steps.

## Bounded page scripts

`run-script` reaches the same owned native page as the fixed actions when a
local Code or Work thread has Full access, or a local Code thread has a scoped
script permission (Work at Full access: maintainer request, 2026-11-12; not
built yet, today Work is refused). It takes `source` and the
`expectedObservationRevision` from a fresh page read. It opens no page or
profile and takes no additional script approval at Full access. Existing site,
profile, model, window, Project and thread authority still apply. Work below
Full access, headless, paired, routine, managed-subagent and terminal-grant callers are
currently refused. Scripts cannot enter `steps` or saved/replayed flows.

Below Full access, a local Code task may request a separate one-use script
permission. The prompt shows the exact source and HTTPS origin, names the task
and selected profile, and explains that it grants the page's account authority,
even in Private or when sign-in state is unknown. It is never remembered as a
site grant and cannot change host filesystem, process or network confinement.
Existing site/profile approvals remain necessary. A changed task/model,
posture, profile, context, page revision, person hold or cancellation invalidates
the answer before dispatch. Each script request needs its own answer.

Plan refuses arbitrary JavaScript. Below Full access, native DOM inspection
must also cover the top document and open shadow roots without credential
fields. An iframe, frame, embed, object, closed shadow root, missing inspection
or exceeded inspection bound refuses the script. The check runs during native
preparation and again before execution. This is a credential and coverage gate,
not proof that the page is signed out, nor a guarantee against future page
changes or callbacks installed by an explicitly authorized script.

Source has the page's normal DOM and account authority, including same-origin
frame access and page API effects. The dispatch target is its current top
document, not a caller-selected native frame or debugger session. It has no
Node, Electron IPC, host filesystem or raw debugging API. The isolated world
is separate from fixed-reader/fill world `1001`. Page main-world CSP does not
constrain isolated-world evaluation; no CSP preservation guarantee is made.
No browser CSP bypass or universal-access setting is enabled.

Execution and fixed serialization have a native 150ms deadline. Only
synchronous results are supported. Promises, functions, DOM and remote-object
handles are unsupported results, not asynchronous work that was stopped.
Callbacks and page changes may survive the call. Source is at most 8KiB UTF-8;
fixed traversal bounds depth 5, 128 nodes, 64 keys, 2048 code units per string
and 6000 content units, with explicit truncation including shortened or colliding
keys. Returned value JSON is at most 24KiB UTF-8, the actual private broker
response is at most 32KiB, and the provider tool result is at most 24KiB after
escaping. These are return bounds, not renderer allocation or memory bounds.
Pristine serializer intrinsics stay in a private closure across calls; source
runs through indirect evaluation outside that closure.

The private native path prepares the exact source/document/owner without
executing source, expires that one-use preparation after 2s on a monotonic
clock, then executes only after a fresh server policy/caller check. At most 32
preparations/runs are retained. Source, values and exception stacks are not
added to lifecycle journal events. Source and the allowed result naturally
reach the requesting provider through the tool conversation.

A script and private credential use cannot acquire each other's native hold.
Agent actions and observations refuse while script custody is held. A result
that began before hold acquisition and finishes after release still needs the
observation epoch check. Human page presentation and input remain available;
focus or input during a script does not mint a person-origin grant for script
navigation. Point cancellation cannot release script or fill custody.

Cancellation before dispatch prevents script execution and reports no page effect. After dispatch, receipts retain
possible effects and withhold stale/cancelled values. A 2s request timeout or an
arbitrary transport failure does not prove native execution stopped: an
uncertain reservation remains until known native completion or actual exact
execution-context/webContents destruction. Navigation start, committed
navigation, BFCache and a no-longer-current page do not establish destruction.
Unknown retained worlds are capped at 32; further script preparation refuses
instead of accumulating state or inferring destruction. The person can stop
that owned Browser page to retire it; no profile storage is cleared.

This narrows the credential guarantee. Fixed readers redact credential fields
and the broker never returns credential values. A Full-access script can read
populated or reflected DOM values and install callbacks that observe later
changes, including after a failed submit or resumed page. A saved credential
permission does not authorize scripts, and holds do not claim to remove older
callbacks or erase values already received by the website. After a script
attempt with possible effects, old refs are dropped and its observation is
stale until the page is read again.

## What the tool never does

- Fixed actions and broker APIs never return or type an agent-supplied password. The person signs in
  manually or separately approves brokered form fill and submit under the
  [held sign-in boundary](#asking-the-person-to-sign-in).
- Arbitrary source never runs through a fixed action or a public renderer
  action route. The separate bounded script operation keeps authorization on
  the server and has the explicit DOM/account authority described above.
- It saves no file from a page unless the person turned on "Let agents
  download files" and answers for that file ([Download](#download)); every
  other download stays blocked on every page
  ([Browser profiles: page rules](browser-profiles.md#page-rules-that-do-not-change)).

## Verification

- `apps/server/src/browser/browserAgentTool.smoke.test.ts` drives the tool,
  the server's service, and a real headless Chromium on a local page.
- `apps/desktop/src/browserSurfaceHost.realPage.test.ts` drives the desktop
  Browser's action code against a real Chromium page standing in for Electron's
  view.
- Both of those also prove device emulation: a phone preset gives a 390 wide
  page with a coarse pointer and a tap that arrives as touch, dark mode matches
  `prefers-color-scheme: dark`, and a bare `resize` undoes all three.
  `apps/server/src/browser/browserAppManagedTools.test.ts` covers the arguments
  and their refusals.
- `apps/server/src/browser/browserAutomationService.test.ts` covers ref
  resolution and refusal on the server, and that only an agent action with the
  switch on asks a runtime to hold a download.
- The download rules run against real Chromium in both Browsers: the smoke test
  above (switch off, held and saved with the right bytes, denied, a program
  refused by its bytes, a file stopped at the cap, a numbered name, a symbolic
  link at `downloads/`, a paired device) and the desktop real-page test, where a
  Playwright download stands in for Electron's `will-download` item. The cap
  while a file is still arriving is covered against a fake session item
  (`browserDownloadHold.test.ts`) because Electron is not present there.
- Page audits: `packages/domain/src/browserPageAudit.test.ts` covers the
  answer's shaping (refs by selector, per-rule and total caps with counts and
  truncation, ratings at the boundaries, layout-shift windows, blocking time,
  request types, address redaction, and what is not measured);
  `browserAppManagedTools.test.ts` the arguments, their refusals, and Plan
  admitting an audit as it admits diagnostics; `browserAutomationService.test.ts`
  findings named by the latest snapshot's refs and a Browser that cannot audit
  refusing; and `browserRuntimeBroker.test.ts` the desktop broker admitting only
  a known audit. Against real Chromium, the smoke test above audits a fixture
  page (an unlabelled field found by its ref, contrast of 2.32:1, target size
  only under the phone preset, a ref still acting afterwards) and a fixture
  load (rated vitals, a long task, a layout shift, a redacted largest resource,
  Plan not refusing it), and the desktop real-page test finds each planted problem and
  nothing on the clean elements, reads the load without reloading the
  document, and leaves the counters unread while someone else holds the
  developer tools.
- Recording runs against real Chromium in both Browsers: the smoke test above
  records a batch into an animated PNG with the frame count its answer names,
  keeps the revision the batch answered with current, withholds a page with a
  password field, keeps no frame of the error and blank pages a refused
  off-origin link leaves, and refuses Plan and a page that is not open; the
  desktop real-page test records the desktop Browser's actions through its own
  debugger attachment, lets the attachment go when the recording ends,
  withholds a credential page, and keeps no frame of a site the person took
  the view to that the thread did not approve (both read each kept frame's
  pixels). `browserAppManagedTools.test.ts` covers the start, the stop after a
  failed step, a Browser that cannot record, and the `record` argument;
  `browserRecording.test.ts` covers the animated PNG, its bounds, and which
  frames may be kept.
- `apps/server/src/browser/browserThreadOwnership.test.ts` covers one thread's
  page being out of reach of another thread, a subagent, and another thread's
  terminal grant, and the Project's page list.
- The smoke test also records, saves, and replays a flow on a fresh page, stops
  at a renamed button, a different title, and an ambiguous element, asks again
  for an origin a replay opens, refuses a save or a run in Plan mode and for a
  paired device, and lists in Plan mode.
- `browserAppManagedTools.test.ts` (Work) and `codeAppManagedTools.test.ts`
  (Code) run one call of every operation in Plan from
  `browserToolPlanCalls.test-support.ts`, keyed like `BROWSER_OPERATION_EFFECT`:
  each read (`audit` included) runs on the open page without asking, each
  refused operation reaches neither the page nor the person, a recorded batch
  or replay is refused before anything runs, a recording started before the
  thread moved into Plan is stopped and keeps nothing, a batch stops at its first refused
  step, and a read of a page the model was not approved for still asks.
  `terminalBrowserGrantService.test.ts` covers a terminal read in Plan.
  `browserFlowService.test.ts` covers saving, replacing, listing, deleting,
  limits, replay of the journal, and erasing a Project.

## Pointed-at product feedback

A local person can choose an element in an exposed Code or Work Browser and
inspect a static crop, bounded DOM neighborhood, computed style and capture
time before adding a comment. The native surface consumes the selected click
only while its explicit pointing mode is armed; a renderer overlay does not
pretend to intercept a native page. Headless screenshot selection refers to the
shown observation revision. Both paths use the same host-owned safe capture
reader, current page/origin/credential checks and finite deadlines.

Comments can be amended or removed while pending, and the person chooses which
notes accompany an ordinary message. The original capture remains immutable.
No note action sends, queues, steers, approves or resolves work. Automatic
continuations leave chosen notes pending. Native Electron input acceptance is a
separate runtime gate from controlled-port tests or real Chromium DOM tests. The
embedded native-client presentation does not support pointing yet; its control
stays disabled with an explicit unavailable reason.
A note has split provenance: its comment is the person's request, while the
selector, DOM, style and image are outside content that taints the destination
thread and is framed as evidence, never instructions.

- Pointing first prepares a static preview. The person inspects its crop and
  bounded DOM/style context before committing a comment. Pending comments and
  inclusion can be amended with a version check; element evidence, capture
  time and crop association remain immutable. An excluded note stays pending.
  Choosing, committing or editing a note never sends a message, queues a turn,
  approves execution or resolves a finding.
- Native selection uses an expiring host selection token bound to the original
  window, context, tab, document, bounds and actual person input. A renderer
  request ID correlates the panel's arm/cancel replies; it grants no capture
  authority. Selection consumes only its pointing click, while ordinary input
  retains its existing behavior. Selection expires after 60 seconds, and a
  point read has a 10-second deadline. Navigation, replacement, credential
  observation pause, Stop or revoked authority prevents late fresh evidence.
- Native and headless point reads share one fixed top-frame reader and capture
  sequence. It rechecks approved origin, frame/loader/node identity, viewport
  and credential protection across DOM and screenshot waits. It never enters
  a child frame to inspect an element. A crop overlapping editable content or
  an uninspected iframe/embed region is withheld. Native protocol inspection
  also detects closed shadow roots on ordinary elements. Open shadow roots are
  walked independently of their host bounds, and overflowing contenteditable
  text ranges are checked too; element/root/rectangle limits withhold the crop
  when coverage is incomplete. Their descendants can
  overflow the host's bounds, so any closed root or incomplete native coverage
  withholds the optional crop for that read; safe bounded context and the
  person's comment remain, with an explicit omission. Filtering DOM text does
  not imply that arbitrary screenshots have their form values redacted.
- Preview memory is host-owned and temporary: eight per window/task, 32 across
  the host including in-flight reservations, 256 KiB crop characters and 16 KiB
  serialized metadata per preview, and 8 MiB aggregate UTF-8 bytes. Reservations
  count before capture starts; full capacity refuses rather than evicting a
  live preview. Previews expire after ten minutes or release on cancel, window
  revoke, task purge or host close. JavaScript strings and objects have bounded
  additional overhead; this is not a process RSS limit. An expired or refused
  preview preserves the local comment and offers explicit recapture.
- Committing a preview checks its original local capability and current task
  scope, then atomically stores crop, outside-content mark and note on the
  existing SQLite connection. Failed commits roll back all three without
  deleting a crop shared by another note. A response lost after a successful
  commit asks the person to refresh before retrying; it does not imply that
  nothing was saved.
- Ordinary admission snapshots exact selected note IDs and versions. Claims
  happen only at the existing current-authority delivery boundary; a changed
  selection remains pending and requires refresh. Text-only models and missing
  images receive honest omissions. Notes cannot expand Browser, child,
  unattended, terminal or paired-device authority.

A durable delivery claim identifies the admitted operation, not an SDK receipt.
If synchronous publication retires the original authority, the host keeps that
private consumed status and sends no fresh note evidence. A failed or lost
acknowledgement does not automatically replay notes. The person refreshes notes
and the turn result before deciding what to send again.

The shared bounded protocol capture sequence lives in `@octant/host-runtime`;
the domain package retains the fixed element-reading description and pure
policies. Native element feedback obeys the same credential-fill, page-script
and owner-control observation holds as other Browser reads. A hold acquired
during a capture invalidates the result even if it has already been released.
