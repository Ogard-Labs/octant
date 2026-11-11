# Browser captures

This topic specification owns how a thread keeps, retains, reads, and shows the
screenshots and recordings taken in its Browser. Architecture owns the
boundary: which screenshots are kept, where, for how many, and who may read them
([Architecture: persistence](../architecture.md#persistence)). Workspace owns
the Browser pane
([Workspace: tool lifecycles](workspace.md#tool-lifecycles)).

## What is kept

- Only an explicit screenshot is kept: the agent's `screenshot` operation on the
  browser tool, and the person's Screenshot control in the Browser pane. The
  picture the model receives after any other action is not kept.
- The agent's recording is kept the same way: a `steps` or `flow-run` call
  with `record: true` keeps one animated PNG of its page while the call ran
  ([Recordings](#recordings)). Nothing else records, and the person's pane has
  no record control.
- The Screenshot control is the pane toolbar's camera button. It posts to its
  own route, `POST /api/browser/captures/take`, which wraps the ordinary action
  request and refuses any kind but `screenshot`. "Refresh preview" and every other
  pane action use the ordinary action route and keep nothing.
- The host decides who asked from the route, never from tool input: the agent
  tools name themselves, the take route names the person, and a caller that names
  no one keeps nothing. A paired device keeps nothing.
- The thread-less Project browser keeps nothing.
- A CLI the person types into a thread terminal that holds a Browser grant keeps
  nothing: no journal actor describes it, so it names no one
  ([Terminal Browser grant](terminal-browser-grant.md)).
- Keeping writes only under the data directory, never a Project. A screenshot
  in Plan mode is kept like any other, as the thread's own capture
  ([Browser for agents: Plan mode](browser-agent-tool.md#plan-mode)).

## Storage

- The bytes live in the managed attachment store under
  `browser-captures/<thread id>/<capture id>`, declared in the host data map
  (it appears under Caches in Settings → Data & storage as "Browser captures").
- The media type is sniffed from the bytes, never read from the data URL. A
  screenshot's size is bounded by the screenshot envelope (about 40 KiB): a
  capture is the picture the model received, not a full-resolution screenshot.
  A recording has its own bound, 2 MiB, and is always `image/png`.
- The journal records `browser.capture-kept@1` on one `browser-capture`
  aggregate per thread (aggregate id = thread id): capture id, thread id, page
  origin, URL, title, SHA-256 content hash, size, media type, time, and, for a
  page in a Project or Personal profile, that profile. A recording also carries
  `recording`: its frame count, its length in milliseconds, and, when a bound
  cut it short, which one (`truncated`). Never bytes or a data URL.
- Rationale: a recording is the same event with one optional field, not a
  sibling event, so it shares the one aggregate, the one retention rule, the
  one listing, the export records, and the purge, and an old reader of the
  event never meets a second shape. The schema holds a capture without
  `recording` to the screenshot envelope, so only a recording may be larger.
- The envelope actor says who took it: the agent (provider instance and thread)
  or the local person.
- A capture is kept after the observation that produced it was recorded, so the
  thread is already tainted by `thread.external-content-ingested@1`. The capture
  adds only the origin it came from.

## Tool result

- A screenshot the thread kept returns `captureId` beside the image, so the agent
  can declare it as a `browser-capture` asset in a Canvas design. Nothing else of
  the capture is returned.
- A recording the thread kept returns `recording` on the call's answer: its
  `captureId`, `frames`, `durationMs`, and `truncated` when a bound cut it
  short. The animation itself never reaches the model.

## Failure

- Keeping is best effort. The screenshot succeeds either way.
- A capture that was not kept says why on the observation (`too-large`,
  `not-an-image`, `no-page-origin`, `no-picture`, `unavailable`). `no-picture`
  is the runtime withholding the screenshot itself, as it does when a frame on
  the page holds a credential field. The agent sees
  `captureNotKept` in the tool result, and the pane says "This screenshot could
  not be kept" with the reason in words.
- A recording that was not kept answers `recordingNotKept` with the same
  reasons; `no-picture` there is a recording whose page showed a credential
  field or painted nothing, and a stop that was refused names its refusal
  (`browser-person-took-over`, for one). The call itself succeeds or fails on
  its own steps either way.

## Retention

- A thread keeps its newest 32 captures, screenshots and recordings together.
- At most 8 of them are recordings. Keeping a ninth recording drops the
  thread's oldest recording, never a screenshot: within the window, every
  screenshot is kept and only the newest 8 recordings are.
- Retention is a rule over the journal: the newest 32 aggregate versions
  survive, of those the recordings past the newest 8 do not, and listing reads
  exactly what remains (`browserRetainedCaptures`). Reading, the export
  records, a Canvas design asset, and recovery all go through that listing, so
  a dropped recording is not found by any of them. No event records the drop;
  its bytes are removed when the recording that replaced it is kept, and
  otherwise by the next recovery pass.
- Rationale for the recording cap: a recording may be 2 MiB, about fifty
  screenshots, so 32 recordings could hold about 64 MiB per thread. Eight hold
  about 16 MiB, enough for the checks a pull request shows. Dropping the
  oldest recording rather than the oldest capture keeps a new recording from
  pushing out the screenshots the proof's steps name; the 32-version window
  still ages out the oldest capture of either kind as before, so screenshots
  keep exactly the room they had.
- Removing the bytes of an older capture is repeatable cleanup. `recover` at host
  start removes any finalized bytes the journal does not retain and any staged
  leftovers, so a crash between the append and the removal loses nothing.
- Rationale: a separate "capture dropped" event would make the allowance a second
  source of truth that has to agree with the bytes. Deriving it from the
  aggregate version leaves one rule that a rebuild, a recovery pass, and a
  listing all apply the same way.
- A confirmed thread purge erases the aggregate with the thread's other
  aggregates (its events carry `threadId`) and removes the thread's directory.
- Captures are not in Canvas shares, replica sync, or the diagnostics export,
  none of which read the aggregate or the directory.

## Thread export

- A capture leaves the host only in an export the local owner takes: an export
  of that thread, or the host-wide data export, which embeds each thread's
  bundle. A page can show personal data, so a capture's URL and title travel
  no other way.
- Each capture is one attachment record beside the thread's generated images:
  media type, size, and a `capture` block with the capture id, page origin, URL,
  title (absent when the page had none), and capture time. Bytes stay omitted
  like every attachment's, so the bundle counts them under `attachment-bytes`
  rather than inlining a picture.
- The file name is `browser-capture-<capture id>.<extension>`, from the id and
  media type alone. A page title or URL never names a file.
- Records follow the strip: the retained window, newest first. A capture list
  that cannot be read leaves the captures out and the export still succeeds. A
  thread with no captures exports unchanged.
- No new route. The export route already requires that the caller can open the
  thread, and only a local window's export carries captures: a paired device
  never reads them, so its export leaves them out.
- Implemented by `browserCaptureExportAttachments` in the domain package and the
  `browserCaptures` option of the server's thread export service.

## Reads

- `POST /api/browser/captures` lists the retained captures, newest first.
  `POST /api/browser/captures/image` returns one as an image data URL.
- Both answer only a local window that can open the thread (403 otherwise),
  under the same rule that lets a window read the thread's generated images.
  The thread need not be live: an archived thread, a thread in an archived
  Project, and a thread whose provider is switched off still show what they
  kept. A capture id the thread does not retain is 404.
- The take route drives the Browser, so it needs the thread's live Browser
  authority as well, and the context must belong to the named thread. An
  archived thread shows its captures and takes no new one.
- The product route classifier leaves all three unlisted, so a paired device is
  stopped before the route too.

## Canvas design assets

- A Work or Code Canvas design may declare a `browser-capture` asset and draw
  the stored screenshot in its preview. The server reads it through the
  service's `read`, which finds only a retained capture of the Canvas's own
  thread, so another thread's capture and a dropped one are missing, and a Chat
  Canvas refuses the source.
- The stored picture is already a screenshot, so the size bound stays the
  screenshot envelope (about 40 KiB); the design asset caps are far above it. A
  recording may be declared the same way: its 2 MiB bound is under a design
  asset's 3 MiB cap, and it is drawn like any other PNG asset.
- Exports and shares never carry the picture: a share carries no declared image,
  and a Canvas export leaves captures out like every other design asset.

## Strip

- A thread with captures shows a "Browser captures" strip in its transcript
  beside the generated images (Chat, Work, and Code); it is absent until there
  is one. It sits in the thread column, in line with the messages.
- Each row is a small picture, the page title (the origin when there is none),
  and the origin. Choosing it opens the full picture with its URL and time as a
  workspace content view, or in place where none is available.
- A recording's row shows its first frame, still, with a play mark (a triangle
  and its length, such as "2.5 s") in the picture's corner, and the row's
  control reads "Play recording of <title>, <length>". Opening it plays the
  animation, with **Stop** and **Play** beside a caption that gives its length,
  its frame count, and in words why it stopped early when a bound cut it short.
  With reduced motion, from the system or Octant's own setting, it opens on its
  first frame and plays only on **Play**.
- Rationale: an animation that moved in the transcript on its own would be the
  ambient motion the design system rules out, so a recording is still until
  the person asks to watch it. The still frame is the same file with its
  animation chunks left out, so no second picture is stored.
- The strip reads every five seconds while the window is visible and stops
  asking for a thread once the host refuses the window. A transient failure
  retries on the next beat.
- Visual rules are in [DESIGN.md](../../DESIGN.md#transcript).

## Marking up a capture

A person can draw on a picture of the page and put it in the thread's message.
The marked-up picture is an attachment of that message, not a capture.

- **Where it is offered.** The toolbar's **Draw on page** button (a pen-line
  icon beside Screenshot) is offered where the Screenshot control is, and only
  in a Work or Code thread's Browser, where the thread's composer is the place
  a picture goes. A Project's Browser, Zen's research Browser, and a paired
  device have no such composer, so the button is absent there, not dead.
  Chat has no Browser.
- **The still is the person's own capture.** Pressing the button takes a
  screenshot through the person's Screenshot route and reads that capture back
  through the ordinary image read, so the credential-field refusal, the
  `browser.capture-kept@1` record naming the person, the thread's taint, the
  32-capture window and the capture strip all behave as for a screenshot. A
  capture that was not kept says why in the Screenshot control's own words and
  no drawing starts. Nothing else reads the page's pixels: the native page's
  view is never read, and a capture the window may not read is never read.
  Rationale: one source of pictures means one place that decides whether a page
  may be pictured. Private and stored-profile pages follow whatever the
  Screenshot control does for them; drawing adds no exception either way.
- **Taint.** The capture the still comes from is kept after the observation
  that produced it, so the thread is already marked as holding outside content
  and the capture adds the page's origin ([What is kept](#what-is-kept)). The
  marked-up picture is page content: it carries that origin's taint with the
  thread, and adding it to the message changes nothing about it.
- **Drawing.** The still replaces the page area, fitted and centred, with a
  drawing layer in the picture's own pixels over it. The live page is not
  interactive meanwhile: a native page leaves the window for as long as the
  layer exists, and a headless preview is not mounted, so a stroke never clicks
  the page. Using a navigation control of the Browser leaves drawing and
  discards the marks. Rationale: a drawing over a page that is changing under
  it would no longer mark what the person saw.
- **Tools.** A bar floats at the bottom centre of the page area
  (`role="toolbar"`, "Drawing tools"): **Select** (move a mark), **Pen**,
  **Box**, **Arrow**, **Text**, an ink choice (red by default, then yellow,
  green, blue, white, black), **Thin stroke** and **Thick stroke**, **Undo**,
  **Redo**, **Delete** (the selected mark; disabled with none), **Add to chat**,
  and **Discard drawing**. Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z undo and redo,
  Delete or Backspace removes the selected mark, and Escape drops a stroke in
  progress or the selection and nothing more.
  Text is typed at the clicked point (Enter or leaving the field keeps it,
  Escape cancels, empty text adds nothing) in the interface font with a thin
  outline contrasting with its ink so it reads on any page.
- **Limits.** At most 200 marks, and a stroke is thinned to 300 points. A click
  that draws nothing (a box under 4 pixels across, a one-point stroke, a
  nearly zero-length arrow) adds no mark. Undo reaches back 200 steps. The ink
  colours are drawn into a picture that leaves the app, so they are fixed
  values in code and do not follow the theme.
- **Add to chat.** The still and the marks are composed at the still's own size
  and exported as a PNG file (`browser-markup.png`). The drawing layer and the
  export read one description of each mark, so the attached picture is what
  was drawn. The file goes to the composer of that thread, in this window,
  through the composer's own image attach: its limits (PNG, JPEG, WebP, GIF;
  10 MiB each; at most 8 a turn), its refusal when the model reads no images,
  its upload to the host's staging area in Code, and its thumbnail apply
  unchanged. Nothing is sent until the person sends the message. Drawing ends,
  the toolbar says "Added to the message", and the thread's prompt takes focus
  only when its composer is open in this window.
- **Waiting.** If the thread's composer is not open, the picture waits in this
  window's memory for it, at most 8 per thread, and is attached when the
  composer opens; the toolbar says it will be. A reload drops it. Nothing is
  stored on the host, in the journal, or in the data directory: the marked-up
  picture exists only as the message's attachment, and the capture beneath it
  stays the thread's only record of the page.
- **Sharpness.** The still is the bounded capture picture (about 40 KiB, up to
  1280 pixels wide), so it is soft beside the page: small text on it can blur.
  Drawing does not raise its quality.

## Proof

Proof is a thread's record of a Browser check: the agent's recent Browser steps
and the captures it kept, read together. A person can attach it to a pull
request, and only by choosing to.

- **The step list.** A thread keeps a short record of the agent's Browser
  steps: at most the last 50. A step is one fixed host action the agent tool
  asked for, never anything the person did in the pane, a terminal CLI, or a
  caller that names no one (the rule that decides who takes a capture).
- **What a step holds.** The operation (`navigate`, `click`, `type`, and so on);
  for an action that named its element by ref, the element's role and
  accessible name; the page's origin and path; a result built from fixed categories
  ("Address changed to <origin and path>", "Title changed", "Page content
  changed", "Nothing changed") or, for an action that failed, the failure
  category; the capture it kept, when it
  was a screenshot that was kept; the recording time; and, for a page in a
  Project or Personal profile, that profile.
- **What a step never holds.** Text the agent typed, the value of any field,
  a selector, the page's text, a picture, a query string or fragment of the
  address, or anything from a failure message. The record has no field for
  them, and the request itself is never handed to the recorder. The result is
  never copied from the page's `changed` line: a page can echo what was typed
  into its title or text (search results do), so the record compares the
  before and after page states and says only which of address, title, and
  content changed.
- **Same keeping as captures.** One `browser-step` aggregate per thread
  (aggregate id = thread id) with one `browser.step-recorded@1` event per step,
  actor the agent (provider instance and thread). The newest 50 aggregate
  versions are the steps, by the same rule as captures: listing reads that
  window, and a confirmed thread purge erases the events with the thread's
  others. Recording is best effort and never fails the action. Steps are not in
  telemetry, diagnostics exports, Canvas shares, or replica sync.
- Rationale: a step holds the element by role and accessible name rather than
  by selector so the list reads as what a person would have done, and so
  nothing a page or the agent made up (an id, a class) is kept. A field's value
  is not part of an accessible name, so typing leaves no trace of what was
  typed.
- **Reads.** `POST /api/browser/steps` lists them, oldest first, and answers
  exactly the callers `POST /api/browser/captures` answers: a local window that
  can open the thread, archived or not. The product route classifier leaves it
  unlisted, so a paired device is stopped before the route.
- Rationale: the proof names pages and elements the person browsed and sits
  beside pictures a paired device may not read, so reading it is the same
  authority as reading a capture, not wider. A paired device therefore cannot
  view, attach, or save the proof; Code threads' pull-request flow reads it
  from the person's own window.
- **The agent.** It reads its own step list only as it reads any tool result
  today (`changed` and the failure it gets back). No new operation reads the
  list back.
- **The panel.** Beside the strip, a thread with steps shows a "Browser proof"
  panel: folded, with a "Show N steps" control, then the steps as a numbered
  list. Each capture appears under the step that took it; a capture no
  retained step names (the person's own, or one whose step has aged out)
  appears under the last step recorded before it. A failed step is marked in
  words and in the danger colour.
- **Attaching to a pull request.** The Code pull-request form, which writes a
  pull request body, offers "Include Browser proof", off by default. Choosing
  it reads the proof, says how many steps it will add, and on Create adds a
  "Browser check" section to the body after the person's text: the numbered
  steps, and for each capture the name of its file, as "Screenshot:" or, for
  a recording, "Recording:". A section with a recording says that a recording
  plays as an animation where its file is dropped. The files are
  named by position, so if the captures changed after the person saved them,
  Create stops and asks for another save first. The proof is
  read again at Create, so the section reflects the steps as they stand then.
  If it cannot be read, nothing is created and the form says why. The form is
  the only place pull-request text is written by a person; the agent's own
  pull-request operations do not read the proof. There is no description-edit
  flow in the app, so the choice is not offered anywhere else.
- **Screenshots.** GitHub offers no way to put pictures into a pull request body
  from here, and sending them to another host would send a page's picture off
  this computer. "Save screenshots…" (in the panel and beside the choice) opens
  the desktop app's native folder picker and writes the thread's captures
  there as `browser-check-01.png`, `-02`, ... (oldest first, extension from the
  media type), so the person can drag them into the description. The names in
  the section are those files. The desktop main process writes the files, never
  overwrites one (a name already in the folder stops the whole save), and tells
  the page only the count and the folder's name. Recordings are saved in the
  same numbered run: an animated PNG keeps `.png`, and GitHub draws one dragged
  into a description as an animation. Once the thread has a recording the
  control reads "Save screenshots and recordings…" and its result counts files.
- Rationale: saving to a folder the person picks is the narrowest option that
  works: nothing is uploaded, no new credential or host is involved, and the
  picker is the person's consent for the one folder.
- **Paired devices.** Reading the proof is refused for a paired device, so a
  pull-request form reached from one says "Browser proof can be attached only
  from a window on this computer." and creates nothing until the person turns
  the choice off. "Save screenshots…" exists only where the desktop app's bridge
  does. The product route classifier already lets a paired device send other
  Code commands; this adds nothing to what it may do there.
- **Signed-in pages.** A capture or step of a page in a Project or Personal
  profile follows the capture rules: it is kept, names its profile, and is read
  only by a local window. Attaching it to a pull request is the person's
  choice like any other proof.

## Recordings

A recording shows a reviewer what a change does: a short moving picture of
the agent's page while one Browser call ran, kept beside the screenshots and
attached the same way.

- **Asked for, one call at a time.** The agent asks with `record: true` on a
  `steps` or `flow-run` call, on a page that is already open. The tool starts
  the recording, runs the call, and ends the recording when the call ends,
  whether it succeeded, failed at a step, or the turn was stopped. Nothing
  records between calls, and no call records by default
  ([Browser for agents: Results](browser-agent-tool.md#results)).
- **Bounds.** At most 30 seconds, a frame at most every 250 ms (4 frames a
  second), at most 120 frames, each scaled by the page's own screencast to fit
  800 pixels on its longer side, and at most 2 MiB in all. It stops taking
  frames at whichever it meets first and says which (`duration-limit`,
  `frame-limit`, `size-limit`). A frame of a different size (the page was
  resized) ends it too (`viewport-changed`): an animation has one size. The
  call goes on; only the recording stops. A capture is labelled with the
  recorded tab's address and title as they were when frame collection
  stopped: at the bound, for one cut short, so a later navigation of the same
  tab does not lend it the name of a page it never showed; at the call's end,
  for one that ran that long, whose last frame is of that page even when the
  call navigated on the way.
- **One tab.** A recording belongs to the tab it started on. When another tab
  comes to the front (the call opens or switches to one, the person switches,
  or the recorded tab closes), the recording stops at that moment
  (`tab-changed`) and takes no frame from either tab after it; frames that had
  already arrived are still checked and kept. The capture is kept under the
  recorded tab's address and title as they were when the recording stopped,
  never the tab in front when the call ends, so the page origin a capture
  needs is the recorded tab's and the call's later steps do not appear in it.
  The rule is the same on the desktop and the headless Browser.
- Rationale: the screencast is a property of one page, so following the front
  tab would mean a second screencast and frames of two pages, possibly of
  different sizes, in one animation; and labelling one tab's frames with
  another's address would file the capture under a page it does not show, or
  refuse it for a blank new tab. Stopping, as a resize already does, keeps one
  picture of one page under that page's own address.
- **Frames.** The desktop and the headless Browser both take frames from the
  page's own screencast (the debugger protocol's `Page.startScreencast`, in
  PNG) and keep the newest frame of each 250 ms, so the last state of a change
  survives; a frame identical to the one before is dropped, so a page that
  waits adds nothing but time. Each frame is acknowledged only after it was
  looked at, so a busy page cannot queue frames without bound.
- **Credential fields.** Before a frame is kept, the page is checked for a
  credential field the way a screenshot is: a frame of a page that holds one
  anywhere, in a frame or a shadow root too, is left out, and so is a frame of
  a page that could not be checked (the check fails closed, as a page between
  documents does). The frame before it stays on screen in its place. A
  recording whose every frame was left out keeps nothing (`no-picture`).
- **Approved origins only.** A frame is kept only when the page it shows is on
  an origin the thread's Browser context approved. A frame of a page on any
  other origin is left out, and so is one whose page has no web origin to
  check: a blank page, the browser's own error page, or an address that cannot
  be read. The page's address is read as each frame arrives and again after
  its credential check, and a frame whose page moved in between is left out
  too. The rule is the same on the desktop and the headless Browser
  (`browserRecordingFrameKept`), and a left-out frame is handled as a
  credential frame is: the frame before it stays on screen, and a recording
  whose every frame was left out keeps nothing.
- Rationale: leaving out the frame, rather than the whole recording, is what
  the screenshot rule says for each picture, and a flow that passes through a
  page mid-load (every navigation does) would otherwise never be kept. The
  origin rule exists because a frame is a picture of whatever the view shows,
  not of what the approval covered: on the desktop the person can take the
  agent's own view to any site while a call runs, and a request the context
  refuses still paints an error page. The approval is the thread's whole
  authority to look at a page, so a recording must hold no picture of a page
  it did not cover, and a page whose origin cannot be told cannot be shown to
  be covered. Each frame is checked within milliseconds of being painted (the
  page sends the next frame only once the last is acknowledged), so the
  remaining window is a page that left an approved origin and came back
  between one paint and its check.
- **When it ends early.** The page closing, or the context stopping or
  expiring, drops the recording. While the person has taken the page over, or
  is signing in, the call's closing stop is refused like any other agent call,
  so nothing of what they did is kept; the frames are dropped when the next
  recording starts or the page closes, and the screencast itself ends at the
  duration bound at the latest. A turn that is stopped still ends the
  recording it started and keeps what was recorded.
- **Who may.** Recording is a read of a page the agent already drives, the same
  class as `screenshot`, so it is allowed where a screenshot is, outside Plan: every
  admission a screenshot passes (the thread's authority, the model binding, the
  origin approval, the person's hold) applies to starting and ending it. Plan
  admits a screenshot but refuses a recording, because the thread keeps the
  recording as an artifact and Plan only reads; a recorded call in Plan runs
  nothing, and a recording already running when Plan begins is stopped and
  discarded ([Browser for agents: Plan mode](browser-agent-tool.md#plan-mode)). The
  recorded observation marks the thread as having read outside content, as a
  screenshot's does. Only the agent tool records: the service refuses a
  recording from the pane, a paired device, a terminal CLI, and any caller that
  does not name the agent, and the product route refuses a paired device first.
  A Browser that cannot record (no screencast) refuses in words, and the call
  does not run (`recording-refused`).
- **The animated PNG.** The frames are joined into an animated PNG that loops:
  the first frame's header, then each frame's compressed image data, carried
  over byte for byte, behind its frame-control chunk. No frame is decoded or
  compressed again, and no image library is used: the chunks need only their
  framing and a CRC-32 the domain package computes itself
  (`encodeBrowserRecordingApng`).
- Rationale: GitHub draws an animated PNG dragged into a pull request body as
  an animation, so a recording reaches a reviewer the same way a screenshot
  does, with nothing uploaded by Octant, and a viewer that does not animate PNG
  still shows the first frame. An animated GIF would need palette quantization
  and an LZW encoder, and an animated WebP a VP8 encoder; a video would not play
  inline in a description. The screencast already sends complete PNGs of one
  size, so joining them is framing, not encoding. Tying a recording to one call
  bounds it by that call as well as by its own limits, so it cannot outlive a
  turn or be left running by an agent that forgot to stop it. The 2 MiB bound
  keeps a recording below a Canvas design asset's cap, and with at most 8
  recordings per thread ([Retention](#retention)) keeps a thread's recordings
  within about 16 MiB; screen-sized PNG frames of an ordinary page are tens
  of kilobytes, so the bound holds a few dozen distinct frames, and a waiting
  page costs none.
- **Privacy.** A recording follows every capture rule: it stays on this
  computer, under the data directory; only a local window that can open the
  thread reads it, never a paired device; it is in no telemetry, Canvas share,
  replica sync, or diagnostics export; and it leaves the host only in the local
  owner's thread or data export and in the folder the person saves it to.

## Verification

`browserCapturePolicy.test.ts`, `browserCaptureService.test.ts`,
`browserAutomationService.test.ts`, `browserAutomationRoutes.test.ts`,
`threadPurge.test.ts`, `threadExportService.test.ts`, `canvasDesignAssets.test.ts`, `BrowserCaptureList.test.tsx`, and `BrowserWorkspace.test.tsx`.
Proof adds `browserProofPolicy.test.ts`, the steps cases of `browserCaptureService.test.ts`, `browserAutomationService.test.ts`, and `browserAutomationRoutes.test.ts`, `CodePullRequestPane.test.tsx`, and the desktop `browserProofSaver.test.ts` and `preload.test.ts`.
Recordings add `browserRecording.test.ts` (an animated PNG read back by a parser in the test: frame count, delays, size, CRCs, the still frame, every bound, and which frames may be kept), the recording cases of `browserCapture.test.ts`, `browserCapturePolicy.test.ts` (the recording cap: newest eight kept, screenshots never dropped), `browserCaptureService.test.ts` (a ninth recording drops the oldest one and its bytes, recovery finishes the removal), `browserAutomationPolicy.test.ts`, `browserProofPolicy.test.ts`, `browserAutomationService.test.ts`, `browserAppManagedTools.test.ts`, `browserAutomationRoutes.test.ts`, `desktopBrowserRuntime.test.ts`, `BrowserCaptureList.test.tsx`, and the desktop `browserRuntimeBroker.test.ts` and `browserProofSaver.test.ts`; and real Chromium pages in `browserAgentTool.smoke.test.ts` (headless) and `browserSurfaceHost.realPage.test.ts` (the desktop Browser's code), which read the pixels of every kept frame to show that no page off the approved origin, and no blank or error page, was recorded.
