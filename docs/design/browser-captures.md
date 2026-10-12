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
- Keeping writes only under the data directory, never a Project. Plan mode still
  refuses the agent's Browser operations as the architecture states.

## Storage

- The bytes live in the managed attachment store under
  `browser-captures/<thread id>/<capture id>`, declared in the host data map
  (it appears under Caches in Settings → Data & privacy as "Browser captures").
- The media type is sniffed from the bytes, never read from the data URL. The
  size is bounded by the screenshot envelope (about 40 KiB): a capture is the
  picture the model received, not a full-resolution screenshot.
- The journal records `browser.capture-kept@1` on one `browser-capture`
  aggregate per thread (aggregate id = thread id): capture id, thread id, page
  origin, URL, title, SHA-256 content hash, size, media type, and time. Never
  bytes or a data URL.
- The envelope actor says who took it: the agent (provider instance and thread)
  or the local person.
- A capture is kept after the observation that produced it was recorded, so the
  thread is already tainted by `thread.external-content-ingested@1`. The capture
  adds only the origin it came from.

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

- A thread export carries the thread's retained captures, and nowhere else does
  a capture leave the host. A page can show personal data, so a capture's URL
  and title leave only when the person exports that thread.
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
  never reads them, so its export leaves them out. The host-wide data export is
  a local-owner read that embeds each thread's bundle, so it carries the same
  records.
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

## Verification

`browserCapturePolicy.test.ts`, `browserCaptureService.test.ts`,
`browserAutomationService.test.ts`, `browserAutomationRoutes.test.ts`,
`threadPurge.test.ts`, `threadExportService.test.ts`, `BrowserCaptureList.test.tsx`, and `BrowserWorkspace.test.tsx`.
