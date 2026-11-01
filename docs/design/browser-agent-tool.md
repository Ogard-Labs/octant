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

Status: the page snapshot, element refs, and short results are built. More
actions, batched steps, richer waits, dialogs and viewport size, the sign-in
handoff, and fuller diagnostics are allowed; not built yet.

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
  by its own text, which is what was typed into it.
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
  drops them. Before acting, the runtime checks that the element behind the
  ref still has the role and name the snapshot recorded; one that does not is
  refused as `stale` and the action does not run.
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
- Rationale: measured on a local page with 40 paragraphs and a two-field form
  (headless Chromium), the per-action observation the host built and kept fell
  from 31.7 to 40.4 KB (a picture and the page text on every action) to about
  0.7 KB. A navigate, read, type, click, and verifying read cost the model
  15,903 bytes of tool results before; navigate, snapshot, type, and click,
  whose result says what changed, cost 4,538 bytes after.

## Actions

Allowed; not built yet. `hover`, `select`, `drag`, key chords, `upload`, and
tabs (list, open, switch, close). Upload sends files only from the thread's
workspace, refuses symlinks, and asks the person each time. Downloads stay
blocked.

## Steps

Allowed; not built yet. Up to 10 operations in one call, stopping at the first
failure, with each step admitted by the server on its own.

## Waiting, dialogs, and viewport

Allowed; not built yet. Waits for text, an address, a load state, or an
element's state, with a hard time limit; actions that wait for the page to
settle; dialogs answered by a fixed policy and reported; and a viewport size
within bounds on the agent's own page.

## Asking the person to sign in

Allowed; not built yet. The agent asks the person to sign in: a card in the
thread, the Browser brought forward, the agent's actions held, and a fresh
snapshot after the person presses Continue. Refused on routine, subagent, and
paired-device turns.

## Diagnostics

Allowed; not built yet. Console warnings and responses with a 4xx or 5xx status,
read with a cursor so reads do not clear each other. No bodies and no headers.

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
