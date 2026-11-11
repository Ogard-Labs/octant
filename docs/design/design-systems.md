# Project design systems

A Project's design system is a `DESIGN.md` file in its folder. People and
agents both read it: prose rules for how the product looks, reads, and behaves,
with optional named tokens for colour, type, radii, and spacing. Octant lists
these files, draws them, edits and creates them, gives the governing one to
every Work and Code turn, and lends its tokens to Canvas: designs draw with
them as a brand and typed blocks (charts, tables, metrics, diagrams) take
their colours from them. A person chooses which design system a Project
follows and can switch a single Canvas to another. This topic owns those
rules. [Canvas](canvas.md#presentation-and-schema-versions)
owns how a brand is drawn in a frame, and [Workspace](workspace.md#navigation-and-projects)
owns where the Project overview shows the panel. Octant's own visual language
is the repository's [DESIGN.md](../../DESIGN.md), which is a design system in
this sense too.

## The file

- **Name and place.** A design system is a regular file named exactly
  `DESIGN.md` in a Work or Code Project's main folder or one of its extra
  folders. A `DESIGN.md` governs the files under its own folder, and the
  nearest one above a file wins, so a monorepo can keep one per app. A Chat
  Project has no folder and keeps using its
  [brand kit](canvas.md#presentation-and-schema-versions).
- **The Project's own.** Which design system speaks for the whole Project is
  the person's choice. Without one (the automatic rule) it is the `DESIGN.md`
  at the top of the main folder, else the only one the Project has. A person
  may instead choose any of its `DESIGN.md` files, found by the search or
  deeper, or turn design systems off (`none`). The choice is a Project setting
  (`designSystem` on a Work or Code Project: `{ kind: "file", folder, path }`
  or `{ kind: "none" }`, absent for the automatic rule), set with
  `change-project-design-system` and journaled as
  `project.design-system-changed@1`; the domain refuses a folder the Project
  does not lend and any choice for a Chat Project. A chosen file that is gone
  leaves the Project with no design system until it is back or another is
  chosen, rather than silently following a different one. A Code turn maps a
  choice in the main folder onto its worktree, so it reads the same path
  there. Like the brand kit, the choice grants no authority.
- **Front matter.** Tokens go in YAML front matter between `---` lines:
  `name`, `description`, and four groups. `colors` (or `colours`) become
  `color-*` tokens, `typography` (or `fonts`) `font-*`, `radius` (or `radii`,
  `rounded`) `radius-*`, and `spacing` (or `space`) `space-*`. A key is
  slugged (`onPrimary` becomes `color-on-primary`); `chart-1` to `chart-6`
  under `colors` are its chart palette; a typography entry may be a
  family stack or an object naming `fontFamily`; a bare number in a radius or
  spacing scale means pixels. Other keys (components, motion, and so on) stay
  for people and agents to read and are listed as not used by Canvas.
- **Prose.** Everything after the front matter. Its level-two headings are
  shown as the system's sections. A file with no front matter is still a design
  system: turns follow its text, and Canvas draws without tokens from it.
- **Tokens and Canvas.** Each token passes the same rule as a design's own
  brand (`designBrandTokenRefusal`): a colour is a hex value or a colour
  function, a radius or step is a bounded length, and nothing may end its
  declaration or load a resource. A font stack keeps only the system faces and
  generic families Canvas can draw and says which faces it left out, because
  no design loads a web font; a stack with none left is refused. At most 32
  tokens are carried, in file order. Every token is reported as `carried`,
  `adjusted` (a font stack shortened), or `refused` with the reason, so the
  person sees exactly what reaches Canvas. The pure reader is
  `readDesignSystem` in `@octant/domain/design-system-policy`; the host parses
  the YAML and never evaluates it.

## Where it is used

- **Work and Code turns.** Every turn in a Work or Code Project with a design
  system carries a standing instruction to follow it for anything a person
  sees (interface code, styles, components, and every Canvas document, deck,
  design, or diagram), to use its tokens rather than invent values, that the
  nearest `DESIGN.md` governs, and to change the file only when asked. The
  instruction lists every other design system by path. The Project's own file
  follows as keyed standing context (`project-design-system`), read from the
  folder on every turn, so a runtime that keeps its own conversation is sent it
  again only when it changed ([Held standing context](../architecture.md#held-standing-context)).
  A file longer than 16,000 characters is cut there with a note to read the
  rest from the file. A Code turn reads from the folder its runtime works in,
  so a worktree's own `DESIGN.md` is the one it follows. A server Project's
  folder is on another machine, so the host adds nothing and the runtime reads
  the file there. This is not an agent brief: Octant reads it as product
  context, writes nothing on its own, and the rule that a Work turn loads no
  `AGENTS.md` is unchanged.
- **Canvas designs.** `describe` returns `designSystem` (path, name, and
  tokens as `brand`) when the Project's own `DESIGN.md` carries at least one
  token, with guidance to author every design with `theme: "brand"` and those
  tokens: documents, slide decks and the deck block that presents them,
  websites, app screens, UI kits, and flow screens. A design that runs script
  cannot take a brand theme, so the agent writes the same values into its own
  stylesheet. A design keeps its own copy of the tokens, so shares, public
  links, and exports draw them identically.
- **Canvas typed blocks.** A Canvas may follow a design system
  (`designSystem` on its definition: a name, the path a person reads, and the
  tokens; Canvas schema version 27). Its charts, tables, metrics, treemaps,
  and diagrams then draw their series colours from it: `color-chart-1` to
  `color-chart-6` when the file names a chart palette, else its primary colour
  as series 1 and its secondary as series 2, with the theme's own colours for
  any series it leaves unnamed; its primary colour is also the accent a
  progress bar or highlighted bar fills with. Status tones (success, warning,
  danger) and text stay the reader's theme, because they are tuned for
  contrast on the reader's light or dark scheme and a brand's usually suit
  one; colour never stands alone, since every mark keeps its dash, shape, or
  label ([Canvas visuals](canvas-visuals.md)). The renderer writes the colours
  as custom properties on the document (`canvasDesignSystemProperties`, which
  repeats the brand rule on every value) and on a deck's Present view, which
  opens outside it; the HTML file export draws its charts and treemaps with
  the same palette. A public share draws typed blocks as data tables, so it
  carries no design system and needs no new share version.
- **A Canvas created in the Project follows it.** When an agent creates a
  Canvas in a Project whose own design system carries tokens, the host stamps
  that design system on it; the model never names one. A revision keeps
  whatever the Canvas follows. The Canvas carries its own copy, so a later
  edit to the file changes the Canvas only when someone applies it again.
- **Swapping a Canvas's design system.** The Canvas's More menu offers
  **Design system…** on the head version of a Canvas that belongs to a
  Project. It lists the Project's design systems (`GET
/api/canvas/design-systems`) and switches to one or to none
  (`POST /api/canvas/design-system-apply`, command
  `canvas-design-system-apply` naming a location or `null`). The host reads
  the chosen file under the Canvas's own Project, never one the window names,
  refuses a file it cannot read as `unavailable`, and journals the switch as a
  new version recorded as the host's person, like a deck proposal: the
  Canvas follows the new design system and every design drawn in a brand is
  redrawn in it, while a design in the workspace theme or its own palette is
  left as made. Switching to none leaves brand designs their brand. The switch
  shows in history, so switching back undoes it. Neither route is admitted for
  a paired device.
- **Precedence.** A design system with tokens takes the place of the
  Project's brand kit: code and documents then share one palette. A Project
  whose design system carries no tokens, that has none, or that turned them
  off keeps its brand kit as before.

## The Design system panel

The Project overview's Context group has a **Design system** row on Work and
Code Projects. It lists every `DESIGN.md` (name and path, the Project's own
marked), opens one, and draws it: colour swatches, a type sample per font
stack, radius and spacing samples, the notes for adjusted tokens, the tokens
Canvas does not use and why, front-matter keys left for reading, and the
sections. A line says which design system the Project follows (or that the
chosen file is missing, or that design systems are off); **Use for this
Project** on any other file makes it the Project's own, **Follow the top-level
file** returns to the automatic rule, and **Turn off design systems** sets
`none`. **Edit** opens the file's text; **Save** writes it only over the exact
revision it opened (a SHA-256 of the text), so a change made meanwhile in an
editor or by an agent is refused as `stale` and the draft is kept with a
**Reload from disk**. **Create DESIGN.md** writes a starter (a palette, three
font stacks, radius and spacing scales, and Principles, Colour, Typography,
Layout, Components, and Voice sections) at the top of the Project or in a named
existing folder, and refuses to replace a file that exists.

## Constraints

- **Local windows only.** `GET /api/design-systems`, `GET
/api/design-systems/file`, and `POST /api/design-systems/file` answer only a
  window on this host. They read and write the person's folder as their own
  editor would, so a paired device's narrower reach is not widened by them.
  The Project must be one the window's bootstrap lists, and the folder one the
  Project lends.
- **No link is followed.** The search does not descend into a linked
  directory, skips hidden, dependency, and build directories, stops at depth 4,
  4,000 directories per folder, and 64 files, and says when it stopped early.
  A read or write refuses a folder that no longer resolves to itself, any
  linked directory on the way, and a name that is a link or not a regular file.
  Opens use `O_NOFOLLOW` and `O_NONBLOCK`, as the Work status file does.
- **Bounded.** Files over 256 KiB are left to the person's editor. A path must
  be relative, end in `DESIGN.md`, and hold no `.` or `..` segment.
- **The file is the source.** A design system's content is never stored on
  the Project record or journaled, so a clone, an editor, and Octant always
  agree; only the person's choice of which file speaks for the Project is
  journaled. A Canvas keeps the copy it was given, as a design keeps its
  brand.

## Verification

- `packages/domain/src/designSystemPolicy.test.ts`: front matter, token
  mapping, refusals, the 32-token limit, the primary file, and the turn rule.
- `apps/server/src/designSystemRoutes.test.ts`: listing (with a skipped
  dependency tree), create, stale saves, linked directories, unlent folders,
  bad paths, Chat Projects, and missing capability, on a real folder.
- `apps/server/src/work/workTurnService.test.ts` and
  `apps/server/src/code/codeOperationRuntime.test.ts`: the keyed context and
  instruction in Work and Code turns.
- `apps/server/src/canvas/canvasAgentTools.test.ts`: `describe` returns the
  design system and guidance that names every design kind, and a Canvas the
  agent creates carries it.
- `packages/domain/src/canvasDesignSystemPolicy.test.ts`: the series palette
  and accent, unsafe values left out, the version-27 gate, and a switch that
  redraws brand designs, switches to none, and refuses a stale head.
- `apps/server/src/canvasRoutes.test.ts`: the switch reads the file from the
  Canvas's Project, refuses one it cannot read, journals versions, and
  switches back to none.
- `apps/server/src/canvas/artifactDocumentRender.test.ts`: an HTML export
  draws charts in the design system's colours.
- `packages/domain/src/projectPolicy.test.ts`,
  `apps/server/src/projectService.test.ts`, and
  `apps/server/src/designSystemRoutes.test.ts`: the Project choice, its
  journaling, refusals, a missing chosen file, and `none`.
- `apps/web/src/canvas/CanvasDesignSystemPanel.test.tsx`: the document's
  colours and the Canvas switch.
- `apps/web/src/projects/ProjectDesignSystemSection.test.tsx`: list, drawn
  tokens, saves over the opened revision, a stale save keeps the draft,
  create, and swapping the Project's design system.
