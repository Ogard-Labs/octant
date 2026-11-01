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

Status: built. The page snapshot and element refs, short results, hover,
select, drag, key chords, upload, tabs, batched steps, waits, settling, dialogs,
viewport size, the sign-in handoff, and diagnostics with a cursor are built on
the headless and desktop Browsers. Flows (recording a run, saving it in the
Project, and replaying it by name) are built in Work and Code; the person can
list and delete a Project's flows in Settings, and runs one by asking the
agent.

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
- A snapshot carries no picture and no page text beyond the outline. It reads
  the top document: an iframe is listed as `iframe "not included"`, and shadow
  roots are not listed.
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
  upload, or open, switch, or close a tab, as it may not navigate or type
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
- Downloads stay blocked; this adds no download.
- Rationale: an upload is the one Browser action that reads a file off this
  computer and sends it to a site, so it keeps the narrowest reach the request
  allowed. The workspace is the folder the thread's own file tools already
  treat as its root; a Work Project's extra folders are left out until a person
  asks for them. Asking every time follows the Browser's first-action ask,
  which a separate maintainer decision keeps at every access level.

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
- A batch cannot hold another batch, an upload, `stop`, a flow operation, or a
  `navigate` with a profile: each of those needs a call, and for an upload or a
  signed-in page a question to the person, of its own. A malformed step refuses the whole batch
  before any step runs.
- A batch is a list of fixed operations, never a script: nothing an agent
  writes runs in the page.
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
  `diagnostics`, `tab-list`, and `help` are not stored, and a failed or refused
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
  than one, stops the replay. After each step the server compares the page's
  path and title with the recorded ones, and the first step whose outcome
  differs, or that fails or is refused, stops the replay. The answer names that
  step (its number, its operation, and the expected and found path and title, the
  element it could not find, or the refusal) and lists the steps that ran with
  what each changed; a replay that finishes answers as a `steps` batch does. A
  replayed navigation still raises its origin approval, and the replay's own
  steps are recorded like any other operation of the agent.
- **Who may.** The thread's own agent in Work and Code saves, lists, and runs. A
  paired device may not save or run (a flow navigates and types, which it may
  not), and Plan mode refuses every flow operation like every other Browser
  operation. A routine or a subagent may run a flow, on a Private page only,
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
  confirmation, from a local window only (`/api/browser/flows`; a paired device
  is refused). A person runs a flow by asking the agent to; a run needs a model's
  authority and approvals, which a Settings button cannot hold.
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
  ends what can be saved because a replay has nobody to ask. A failed operation is
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
- It downloads nothing: downloads stay blocked on every page
  ([Browser profiles: page rules](browser-profiles.md#page-rules-that-do-not-change)).

## Verification

- `apps/server/src/browser/browserAgentTool.smoke.test.ts` drives the tool,
  the server's service, and a real headless Chromium on a local page.
- `apps/desktop/src/browserSurfaceHost.realPage.test.ts` drives the desktop
  Browser's action code against a real Chromium page standing in for Electron's
  view.
- `apps/server/src/browser/browserAutomationService.test.ts` covers ref
  resolution and refusal on the server.
- The smoke test also records, saves, and replays a flow on a fresh page, stops
  at a renamed button, a different title, and an ambiguous element, asks again
  for an origin a replay opens, and refuses Plan mode and a paired device.
  `browserFlowService.test.ts` covers saving, replacing, listing, deleting,
  limits, replay of the journal, and erasing a Project.
