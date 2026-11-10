# Project design systems

A Project's design system is a `DESIGN.md` file in its folder. People and
agents both read it: prose rules for how the product looks, reads, and behaves,
with optional named tokens for colour, type, radii, and spacing. Octant lists
these files, draws them, edits and creates them, gives the governing one to
every Work and Code turn, and lends its tokens to Canvas as the brand designs
draw with. This topic owns those rules. [Canvas](canvas.md#presentation-and-schema-versions)
owns how a brand is drawn in a frame, and [Workspace](workspace.md#navigation-and-projects)
owns where the Project overview shows the panel. Octant's own visual language
is the repository's [DESIGN.md](../../DESIGN.md), which is a design system in
this sense too.

## The file

- **Name and place.** A design system is a regular file named exactly
  `DESIGN.md` in a Work or Code Project's main folder or one of its extra
  folders. The one at the top of the main folder is the Project's own; with
  none there, a Project that has exactly one `DESIGN.md` uses that one. A
  `DESIGN.md` governs the files under its own folder, and the nearest one above
  a file wins, so a monorepo can keep one per app. A Chat Project has no folder
  and keeps using its [brand kit](canvas.md#presentation-and-schema-versions).
- **Front matter.** Tokens go in YAML front matter between `---` lines:
  `name`, `description`, and four groups. `colors` (or `colours`) become
  `color-*` tokens, `typography` (or `fonts`) `font-*`, `radius` (or `radii`,
  `rounded`) `radius-*`, and `spacing` (or `space`) `space-*`. A key is
  slugged (`onPrimary` becomes `color-on-primary`); a typography entry may be a
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
- **Canvas.** `describe` returns `designSystem` (path, name, and tokens as
  `brand`) when the Project's own `DESIGN.md` carries at least one token, with
  guidance to author every design with `theme: "brand"` and those tokens:
  documents, slide decks and the deck block that presents them, websites, app
  screens, UI kits, and flow screens. A design that runs script cannot take a
  brand theme, so the agent writes the same values into its own stylesheet.
  Typed blocks (charts, tables, metrics) keep the reader's theme and its
  validated series palette for legibility and accessibility
  ([Canvas visuals](canvas-visuals.md)); the agent titles and labels them in
  the design system's voice. A design keeps its own copy of the tokens, so a
  later edit changes new designs, not ones already made, and shares, public
  links, and exports draw them identically.
- **Precedence.** A design system with tokens takes the place of the
  Project's brand kit: code and documents then share one palette. A Project
  whose design system carries no tokens, or that has none, keeps its brand kit
  as before.

## The Design system panel

The Project overview's Context group has a **Design system** row on Work and
Code Projects. It lists every `DESIGN.md` (name and path, the Project's own
marked), opens one, and draws it: colour swatches, a type sample per font
stack, radius and spacing samples, the notes for adjusted tokens, the tokens
Canvas does not use and why, front-matter keys left for reading, and the
sections. **Edit** opens the file's text; **Save** writes it only over the exact
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
- **No record, no journal.** Nothing about a design system is stored on the
  Project record or journaled; the file is the only source, so a clone, an
  editor, and Octant always agree.

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
  design system and guidance that names every design kind.
- `apps/web/src/projects/ProjectDesignSystemSection.test.tsx`: list, drawn
  tokens, saves over the opened revision, a stale save keeps the draft, and
  create.
