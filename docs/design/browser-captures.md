# Browser captures

This topic specification owns how a thread keeps, retains, reads, and shows the
screenshots taken in its Browser. Architecture owns the boundary: which
screenshots are kept, where, for how many, and who may read them
([Architecture: persistence](../architecture.md#persistence)). Workspace owns
the Browser pane
([Workspace: tool lifecycles](workspace.md#tool-lifecycles)).

## What is kept

- Only an explicit screenshot is kept: the agent's `screenshot` operation on the
  browser tool, and the person's Screenshot control in the Browser pane. The
  picture the model receives after any other action is not kept.
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
- Keeping writes only under the data directory, never a Project. Plan mode still
  refuses the agent's Browser operations as the architecture states.

## Storage

- The bytes live in the managed attachment store under
  `browser-captures/<thread id>/<capture id>`, declared in the host data map
  (it appears under Caches in Settings → Data & storage as "Browser captures").
- The media type is sniffed from the bytes, never read from the data URL. The
  size is bounded by the screenshot envelope (about 40 KiB): a capture is the
  picture the model received, not a full-resolution screenshot.
- The journal records `browser.capture-kept@1` on one `browser-capture`
  aggregate per thread (aggregate id = thread id): capture id, thread id, page
  origin, URL, title, SHA-256 content hash, size, media type, time, and, for a
  page in a Project or Personal profile, that profile. Never bytes or a data URL.
- The envelope actor says who took it: the agent (provider instance and thread)
  or the local person.
- A capture is kept after the observation that produced it was recorded, so the
  thread is already tainted by `thread.external-content-ingested@1`. The capture
  adds only the origin it came from.

## Tool result

- A screenshot the thread kept returns `captureId` beside the image, so the agent
  can declare it as a `browser-capture` asset in a Canvas design. Nothing else of
  the capture is returned.

## Failure

- Keeping is best effort. The screenshot succeeds either way.
- A capture that was not kept says why on the observation (`too-large`,
  `not-an-image`, `no-page-origin`, `no-picture`, `unavailable`). `no-picture`
  is the runtime withholding the screenshot itself, as it does when a frame on
  the page holds a credential field. The agent sees
  `captureNotKept` in the tool result, and the pane says "This screenshot could
  not be kept" with the reason in words.

## Retention

- A thread keeps its newest 32 captures.
- Retention is a rule over the journal: the newest 32 aggregate versions
  survive, and listing reads exactly that window.
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
  screenshot envelope (about 40 KiB); the design asset caps are far above it.
- Exports and shares never carry the picture: a share carries no declared image,
  and a Canvas export leaves captures out like every other design asset.

## Strip

- A thread with captures shows a "Browser captures" strip in its transcript
  beside the generated images (Chat, Work, and Code); it is absent until there
  is one. It sits in the thread column, in line with the messages.
- Each row is a small picture, the page title (the origin when there is none),
  and the origin. Choosing it opens the full picture with its URL and time as a
  workspace content view, or in place where none is available.
- The strip reads every five seconds while the window is visible and stops
  asking for a thread once the host refuses the window. A transient failure
  retries on the next beat.
- Visual rules are in [DESIGN.md](../../DESIGN.md#transcript).

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
  accessible name; the page's origin and path; the one-line `changed` result or,
  for an action that failed, the failure category; the capture it kept, when it
  was a screenshot that was kept; the recording time; and, for a page in a
  Project or Personal profile, that profile.
- **What a step never holds.** Text the agent typed, the value of any field,
  a selector, the page's text, a picture, a query string or fragment of the
  address, or anything from a failure message. The record has no field for
  them, and the request itself is never handed to the recorder. Any address the
  `changed` line quotes passes through the same redaction a diagnostic's
  address does: no user or password, no fragment, and every query value whose
  name suggests a secret replaced.
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
  steps, and for each capture the name of its screenshot file. The proof is
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
  the page only the count and the folder's name.
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

## Verification

`browserCapturePolicy.test.ts`, `browserCaptureService.test.ts`,
`browserAutomationService.test.ts`, `browserAutomationRoutes.test.ts`,
`threadPurge.test.ts`, `threadExportService.test.ts`, `canvasDesignAssets.test.ts`, `BrowserCaptureList.test.tsx`, and `BrowserWorkspace.test.tsx`.
Proof adds `browserProofPolicy.test.ts`, the steps cases of `browserCaptureService.test.ts`, `browserAutomationService.test.ts`, and `browserAutomationRoutes.test.ts`, `CodePullRequestPane.test.tsx`, and the desktop `browserProofSaver.test.ts` and `preload.test.ts`.
