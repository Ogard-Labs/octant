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
batched steps, waits, settling, dialogs, viewport size, the sign-in handoff,
and diagnostics with a cursor are built on the headless and desktop Browsers.

## One tool for every provider

- Every provider that carries Octant's tools gets the same `octant_browser`
  definition in Work and Code, through the transport its adapter verified. A
  Code thread and a Work thread read an operation's arguments and shape its
  answer the same way; they differ only in who approves and how a page opens.
- The always-visible description tells the model to take a snapshot after it
  navigates and to act by ref. The full usage stays behind `help`.
- Every operation runs on the server's admission path: the thread's authority,
  the model binding, the origin approval, Plan mode, the stale check, and the
  credential check. No operation adds authority a page did not already have.

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
  element it named changed. Withholding every value on a page with a credential
  field keeps the rule the rest of the Browser follows, which is to show such a
  page's structure at most and never what was typed into it.

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
  for the hash.
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
- A paired device may hover and list tabs. It may not choose an option, drag,
  upload, save a download, or open, switch, or close a tab, as it may not
  navigate or type
  ([Architecture: remote access](../architecture.md#security-and-authority)).

### Upload

A file leaves this computer through a page only from the thread's workspace and
only after the person approves it.

- `upload` puts files into one file field. `files` names them relative to the
  thread's workspace: the Work thread's Project folder, or the Code thread's
  checkout. An absolute path, a path that climbs out, and a path that is not a
  plain file are refused before anyone is asked.
- A symbolic link is refused, at the file and anywhere between the workspace
  and the file: the file's canonical path must be the path named.
- At most 5 files, each at most 25 MB.
- The host copies each checked file into a private temporary folder before it
  asks, reading it through a descriptor that does not follow a link and that
  must still be the file it checked, and the page receives the copies. A file
  swapped for a link while the person reads the question is therefore never
  what is sent. A page reads an attached file when its form is sent, often in
  a later action, so the copies stay until the page's browsing context closes
  (at most 8 uploads' worth per context, the oldest deleted first), and are
  deleted then, or at once if the upload never reached the page.
- The person is asked every time, naming each file with its size and the site:
  "Let the agent upload report.pdf (12 KB) to https://example.com?" The answer
  covers those files to that site once. It is never remembered, so the card has
  no "Always allow", and it is asked at every access level, Full access
  included, as the first Browser action on a site is. Work asks in the thread's
  Browser approval card; Code asks in the thread's tool approval.
- Only the agent tool can upload: it resolves the files and holds the answer,
  and the server's Browser service refuses an upload that did not come with
  them, so no route or paired device can hand a runtime a path. A CLI in a
  thread terminal cannot upload.
- Rationale: an upload is the one Browser action that reads a file off this
  computer and sends it to a site, so it keeps the narrowest reach the request
  allowed. The workspace is the folder the thread's own file tools already
  treat as its root; a Work Project's extra folders are left out until a person
  asks for them. Asking every time follows the Browser's first-action ask,
  which a separate maintainer decision keeps at every access level.

### Download

A file comes from a page into a thread's workspace only when the person has
turned on a switch, and then only after they answer for that file.

- **The switch.** Settings › Permissions has "Let agents download files", off
  by default. It is a host setting in the shell settings, which only a window
  of this computer writes: the shell route is local-only, so a paired device, a
  routine, a subagent, a plugin, a CLI in a thread terminal, and an agent have
  no way to set it, and a change is journaled like every shell setting. Off,
  every download on every page stays blocked, as before: the runtime cancels
  it, and the action's answer says nothing about it.
- **Holding.** With the switch on, a download a page starts while an agent
  action of the agent tool runs (the action and the settling after it) is held:
  the runtime keeps the file in a private temporary folder of the host (never
  the workspace) and cancels it as soon as more than 25 MB has arrived. At
  most 5 files are held per browsing context, the oldest discarded first. Any
  other download, including one the person starts in the pane and one a page
  starts on its own between actions, is cancelled as it is with the switch off.
- **The report.** The answer to that action carries `downloads`: for each held
  file a `downloadId` (`d1`, `d2`, and so on), its name (the page's suggestion
  reduced to a safe basename), its size, and its media type sniffed from the
  file's own bytes, never from the page's header. A file that was stopped
  (over the cap, unfinished after 10 seconds, or failed) is reported by name
  and reason and holds nothing. Each is reported once.
- **Saving.** `download-save` names a reported `downloadId`. The server checks
  the file, then asks the person every time: "Let the agent save report.pdf
  (1.2 MB, PDF) from https://example.com into this thread's workspace?" It
  names the file, its size, its type, and the site. The answer covers that file
  once and is never remembered, so the card has no "Always allow", and it is
  asked at every access level, Full access included. Work asks in the thread's
  Browser approval card ("Save once" or "Deny"); Code asks in the thread's tool
  approval.
- **Where it lands.** In `downloads/` at the root of the thread's workspace:
  the Work thread's Project folder, or the Code thread's checkout, the same
  root an upload reads from. The name is the safe basename (no path part, no
  leading dot, at most 120 characters); a name already taken becomes
  `report (2).pdf`, and a file is never overwritten. A symbolic link at
  `downloads/` or anywhere on the path is refused, and the file is created
  exclusively without following a link.
- **What is refused.** A program or installer, whatever its name says: bytes
  that begin like a Mach-O, ELF, or PE/COFF file, and names ending `.app`,
  `.pkg`, `.dmg`, `.exe`, `.msi`, `.bat`, `.cmd`, `.command`, `.sh`, `.scpt`,
  `.jar`, `.deb`, `.rpm`, or `.appimage`. This is refused before anyone is
  asked. Everything else may be saved. A file over 25 MB, as for an upload, is
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
  device can name a host path or save a file. A paired device's turn, a CLI in
  a thread terminal, and Plan mode refuse (`download-needs-this-computer`,
  `download-needs-a-person`, `plan-mode-read-only`), and such a turn holds no
  download. A routine's or a subagent's turn follows upload: the question goes
  to a window that can see the thread, and an unanswered question expires and saves nothing. A batch cannot hold `download-save`.
- Rationale: an agent's download is a file written by a page into a folder the
  thread's own file tools and a shell can reach, so it keeps the narrowest
  reach the request allowed: off by default; held outside the workspace until
  a person says yes to that one file; one folder; never over a file; and no
  program, which a later shell command would run. The switch is a person-only
  host setting for the same reason the remembered sites are: an agent must not
  be able to widen its own reach. Cancelling at the cap, rather than checking
  afterwards, keeps a page from filling the disk with a file nobody asked for;
  the headless runtime cannot tell which file in its download folder belongs
  to which download, so when any file passes the cap it cancels the context's
  running downloads. The person's own download in the pane stays blocked: this
  switch is for agents' downloads into the workspace only, and a file the
  person wants they can fetch themselves.
- Not covered: a person's own downloads in the Browser pane, and a download
  that starts after an action's settling has ended (it is cancelled). The check that the file is not written through a
  link is made on the folder's path before and after the write; a process of
  the person's own that swaps `downloads/` for a link in between, which can
  already write anywhere in the workspace, is not stopped.

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
- A batch cannot hold another batch, an upload, a `download-save`, `stop`, or a
  `navigate` with a profile: each of those needs a call, and for an upload, a
  download, or a signed-in page a question to the person, of its own. A malformed step refuses the whole batch
  before any step runs.
- A batch is a list of fixed operations, never a script: nothing an agent
  writes runs in the page.
- An agent's action that names an `expectedObservationRevision` the page has
  moved past is refused as `stale` and does not run, so a batch stops there
  rather than carrying on as if the step had run. The person's pane, which
  re-polls on its own, keeps getting the page back without a refusal.
- The field a `type` or `select` changes is not page text, so such a step
  reports that the field holds the new value when nothing else changed.

## Waiting, dialogs, and viewport

- `wait` waits for an element to appear (a selector or ref), or for up to 5
  conditions: text present or absent in the page's visible text (never a
  field's value), an address that contains a string, the page's
  `domcontentloaded` or `load`, or an element attached, detached, visible,
  hidden, enabled, or disabled. `match` is `all` (the default) or `any`.
- Every wait has a hard limit: `timeoutMs` up to 30 seconds, 10 seconds when
  it names none, on both Browsers. A wait that runs out fails and names the
  conditions that never held. A ref in a wait becomes the snapshot's selector
  without the identity check an action makes, because waiting for an element
  to change or leave is the point.
- **Settling.** After `navigate`, `click`, `type`, `press`, `scroll`, `hover`,
  `select`, `drag`, `upload`, and `resize`, the Browser waits for the page's
  load and then for the document to stop changing for 250 ms, at most 2
  seconds in all, before it reads the page and answers. A page that never stops
  changing costs the cap and still answers.
- **Dialogs.** A page's own dialogs are answered by one fixed rule: an alert and
  a leave-page question are accepted; a confirm and a prompt are dismissed, so
  the page never gets an answer the agent was not asked for. Each dialog is
  reported in the next answer as `dialogs`, with its type, its message (at most
  512 characters), and the answer. The headless Browser applies the rule to
  every dialog; the desktop Browser applies it while an agent's action runs,
  and a dialog that opens while the person drives stays theirs. The desktop
  Browser leaves alone a page whose developer tools someone else attached.
- **Viewport.** `resize` sets the page to a width of 320 to 3840 and a height
  of 320 to 2160 CSS pixels, and `resize` with neither restores the page's own
  size. It acts only on the agent's own page, the thread's Browser context: the
  headless Browser sets its viewport, and the desktop Browser emulates the size
  inside the pane without moving or resizing the person's view, so the person
  sees the page at that size until it is restored. A paired device cannot
  resize.
- Rationale: answering a dialog by a fixed rule instead of asking keeps the
  agent from deciding what the page asked the person, and dismissing a
  confirm is the answer that changes nothing. Bounding the viewport to common
  phone and desktop sizes keeps the page renderable at any size it reaches.

## Asking the person to sign in

- `sign-in` (with an optional `reason`, at most 300 characters) hands the open
  page to the person when it needs an account. It needs a page open already, in
  the desktop app's own Browser: a headless page reaches the person only as a
  picture, and typing into its password field is refused like any other
  relayed typing, so there it is refused (`sign-in-needs-the-app-browser`).
- The person sees a card in the thread: "The agent asks you to sign in on
  example.com", the reason, and **Continue** and **Cancel**. Work shows it with
  the thread's Browser approvals and Code with the Browser requests in its
  thread; both are the same host approval, never remembered, and it waits up to
  10 minutes, the longest a Browser approval waits.
- The page is marked as waiting for the person. Every window showing the thread
  brings its Browser forward once, through the thread's activity preview, and
  the agent tool holds every other agent Browser call on the page until the
  card is answered (`browser-waiting-for-person`); `stop` still works.
  The hold is checked again right before an action runs, so a call that was
  already waiting on an approval when the hand-off began does not act either.
  One hand-off at a time per page.
- The page outlives the hand-off: it stays open past its 10-minute session
  while the person signs in, and for 2 minutes after the card is answered so
  the agent can read it.
- The person signs in by typing into the page themselves. Octant saves no
  password and fills none, and the agent never sees what they typed: a
  credential field never shows a value.
- On **Continue** the agent gets a fresh snapshot of whatever page the person
  left. **Cancel**, the card expiring, or the turn stopping ends the hand-off with
  `browser-sign-in-denied`, `-expired`, or `-cancelled`, and the page is the
  agent's again.
- Refused before anyone is asked on a routine's or a subagent's turn and for a
  CLI in a thread terminal (`sign-in-needs-a-person`), and on a paired device's
  turn (`sign-in-needs-this-computer`): nobody there can sign in, or the person
  there cannot see the page.
- Rationale: the hand-off fits the rule that a person's sign-ins are never read
  by an agent. The page keeps its profile; a Private page's sign-in lasts as
  long as the page, and a Project or Personal page keeps it for the next page
  in that profile ([Browser profiles](browser-profiles.md#profiles)).

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

## What the tool never does

- It saves no password and fills none. The person signs in by typing into the
  page themselves ([Browser profiles](browser-profiles.md#profiles)).
- It runs no script an agent wrote inside the page. Every operation is a fixed
  host action, so authority checks stay on the server and never move into page
  code.
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
