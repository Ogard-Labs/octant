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
  `not-an-image`, `no-page-origin`, `unavailable`). The agent sees
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
  none of which read the aggregate or the directory. The thread export does not
  include them yet.

## Reads

- `POST /api/browser/captures` lists the retained captures, newest first.
  `POST /api/browser/captures/image` returns one as an image data URL.
- Both, and the take route, answer only a local window that can open the thread
  (403 otherwise). A capture id the thread does not retain is 404. The product
  route classifier leaves all three unlisted, so a paired device is stopped
  before the route too.
- The take route also requires the context to belong to the named thread.

## Strip

- A thread with captures shows a "Browser captures" strip in its transcript
  beside the generated images (Chat, Work, and Code); it is absent until there
  is one.
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
`threadPurge.test.ts`, `BrowserCaptureList.test.tsx`, and `BrowserWorkspace.test.tsx`.
