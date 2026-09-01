# 0073. One surface language across the renderer and the site

**Status:** Accepted

## Context

Decisions 0070–0072 raised Settings, first run, and the welcome composers to
one visual language, but every other route kept the shell it had grown:
Inbox closed with "Close", boards with a text "Back to workspace", Automations
and the Agents center with a raised button, Archive with an "×". Pull requests
sat in a narrow centred column while boards ran edge to edge and Artifacts
stretched a search field across the window. Usage was a wall of stat tiles
and pill buttons. Chat put its context inside the composer bar, Work put its
tray under the prompt, Code put it above. Headings mixed 600 and uppercase
eyebrows with 11.5px metadata, and the interface face differed between the
app (system) and the marketing site.

A maintainer review on 2026-09-01 against a crafted reference concluded that
hierarchy has to come from size and colour, not weight and capitals, and that
the same language has to hold outside the app.

## Decision

- **One face.** The interface face is Inter (variable, optical sizing),
  shipped with the renderer as the Latin subset and first in the default
  typography stack; the system face is the fallback. Monospace is unchanged.
  The marketing site and docs use the same stack.
- **One type hierarchy.** `styles/surface.css` defines the only heading and
  label roles: hero, title, section label, row label, body, detail, meta, and
  mono identifier. Only the page title is 600; no label is uppercase or
  letter-spaced; no surface authors an 11.5px or 12.5px size.
- **One page shell.** Lists, boards, readers, and preference pages render
  inside `Surface` with `SurfaceHeader` (title, one-line subtitle, actions),
  an optional `surface-toolbar`, `SurfaceSection` groups over hairlines, and
  `SurfaceEmpty` text. Leaving a reader route is always the ghost
  "Back to workspace" control in the header. List surfaces share the 880px
  reading measure; boards opt into the full width.
- **One welcome.** Chat, Work, and Code open on the shared `.welcome`,
  `.composer-stack`, and `.composer-tray` recipes: hero question, rear
  context tray, raised composer. The tray holds where the thread runs; the
  composer bar holds how it runs, with model and access beside send.
- **Usage joins the open grammar.** This supersedes 0070's "Usage: stat
  cards" composition target. Totals are one row of labelled numbers, exports
  are ordinary buttons, and provider limits are rows over hairlines.
- **Provider, Host, GitHub, and Profile pages are open collections** under 0072. Discrete objects inside them (a provider instance's setup, an install
  review) keep their elevation; the list shells do not.

## Consequences

- A new route starts from `Surface` and the type roles, not from a copy of a
  neighbour's CSS.
- `DESIGN.md` gains a "Language" section that the marketing site can follow
  without reading the renderer sections.
- The renderer carries a 73KB font file; the Appearance picker keeps a
  "System interface" option for anyone who prefers the platform face.
- Contract tests pin the shell: one back control, no uppercase labels in
  surface headers, and no stat-card recipe on Usage.

## Related

- 0016 Component foundation and theme
- 0046 shadcn recipes own product controls
- 0070 Renderer visual language matches public block catalogs
- 0071 One navigation and surface hierarchy
- 0072 Settings collections stay open
