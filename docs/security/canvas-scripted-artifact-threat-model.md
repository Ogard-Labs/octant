# Canvas scripted-artifact threat model

- Date: 2026-10-10
- Threat model id: `canvas-scripted-artifact-v0`
- Status: Stub. No scripted Canvas tier is implemented. 0164 deferred
  frames that run script; [0165](../decisions/0165-a-canvas-in-the-thread-can-be-the-whole-answer.md)
  keeps that deferral for documents. This record is the threat model a
  later decision must satisfy before any such tier ships.
- Scope: a future Canvas artifact that may run agent-authored script,
  isolated from the Octant renderer

## Assets

- Host credentials, cookies, and renderer origin state
- Project files, artifacts, and Canvas definitions the thread can read
- The renderer process (hang, memory, GPU)
- Snapshot, gist, and folder-export recipients
- Paired remote clients viewing the same Canvas

## Explicit non-goals

- Today's `design` block (static HTML/CSS, empty sandbox, fragment links)
- Typed catalog blocks, including the layout and diagram work in 0165
- Public or anonymous share links
- A third-party canvas or diagram engine that executes markup

## Trust boundaries

1. Octant UI, journal, and RPC stay on the app origin. A scripted artifact
   never shares that origin and never receives a host token, cookie, or
   preload.
2. The artifact is served from an isolated origin the host controls, with
   a content policy that loads nothing but the artifact's own bytes.
   Network is deny-by-default. No `fetch` to Project, loopback, or the
   public internet unless a later decision names an allowlist and the
   server reauthorizes it.
3. The frame is sandboxed. It cannot open windows, submit to Octant, or
   reach parent DOM. Pointer and keyboard stay inside the frame only
   while the person is interacting with it.
4. Mode and Project authority do not change. A Chat Project still has no
   filesystem. A Work or Code script that needs a file goes through an
   existing host-authorized tool, not through the frame.
5. Share, gist, and Markdown/HTML export refuse the program, the way they
   already refuse a `design`. A snapshot cannot become a drive-by.

## Threats and mitigations

| ID  | Threat | Mitigation required before ship |
| --- | --- | --- |
| S1  | Script reads Octant cookies, tokens, or parent DOM | Isolated origin + empty host bindings + `sandbox` without `allow-same-origin` unless a separate, reviewed origin is used |
| S2  | Script fetches Project files, loopback services, or the internet | CSP `connect-src 'none'` (or an explicit later allowlist); abort any request the preview path does not expect, matching today's Canvas preview page |
| S3  | Script hangs or OOMs the renderer | Time and memory budget; kill the guest frame; show an honest stalled state; never block the thread composer |
| S4  | Script navigates the app or phishes chrome | `sandbox` without `allow-top-navigation`; refuse non-fragment navigation the way `canvasDesignMarkupRefusal` already does for designs |
| S5  | Shared or exported program runs on another machine | Fail closed at snapshot/export create (`unsafe-payload`); export may keep a title and a still picture, never the script |
| S6  | Remote client exceeds host, mode, or Project authority | Same Canvas authority as any other block; the guest gains no extra tools |
| S7  | Agent smuggles a scripted block into an older schema | Version gate; older runtimes refuse the document rather than draw it |
| S8  | Person mistakes a program for a document | Distinct chrome: the frame is labeled as a running prototype, not as ordinary Canvas text |

## Residual risk

- Chromium has already failed to paint sandboxed frames that were `inert`
  or `pointer-events: none` (0164). A scripted frame will need the same
  honest hit-testing, plus a hang story those static frames do not need.
- An isolated origin is new packaging and desktop-shell work. It is not a
  CSS change on `design`.
- Until this model is implemented and the maintainer accepts a follow-up
  decision, agents author documents through the closed catalog and static
  `design` frames only.

## Related

- [0164](../decisions/0164-canvas-designs-are-html-in-a-frame-that-runs-nothing.md)
- [0165](../decisions/0165-a-canvas-in-the-thread-can-be-the-whole-answer.md)
- [0010](../decisions/0010-secure-preview-and-canvas.md)
- [canvas-share-authenticated-snapshot-threat-model.md](canvas-share-authenticated-snapshot-threat-model.md)
- [canvas-share-static-export-threat-model.md](canvas-share-static-export-threat-model.md)
- [Plan](../plans/canvas-rich-artifacts.md)
