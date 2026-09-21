# 0149. Inter is the default interface face

**Status:** Accepted

## Context

0073 shipped the bundled Inter variable face as the interface default. 0144
replaced that default with the platform stack at a compact 13px, keeping Inter
as an explicit Appearance choice. Using it, the maintainer asked for Inter back
as the default face, and did not ask to change the compact size.

Two strings get in the way. A settings store saved while the platform stack was
the default holds that stack verbatim, and the renderer already reads that exact
string as "the default" rather than as a choice. Appearance's System interface
option saved the same string. So once the default is Inter again, a person who
picked System interface would quietly be given Inter.

## Decision

- This record supersedes only 0144's default interface-face rule. The 13px
  interface and transcript sizes, the editor and terminal stacks, and the
  rest of 0144 stand.
- The default interface stack is `'Inter Variable', -apple-system,
BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif` at 13px and weight 400. The face is bundled with the renderer, so it loads nothing remote.
- A saved `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui,
sans-serif` still means "the default", so settings saved under 0144 move to
  Inter without a migration. Appearance names that setting as the default face,
  not as a custom stack.
- The System interface choice saves a different spelling of the platform stack,
  `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`, so
  choosing it keeps the platform face.

## Consequences

- A new install, and every install that never chose a face, draws the interface
  in Inter at 13px.
- Someone who deliberately chose System interface while it saved the old
  spelling cannot be told apart from someone who never chose, so they are moved
  to Inter and must choose System interface again.
- DESIGN.md and the themes guide name Inter as the default and the platform
  face as the System interface choice.

## Related

- 0073 One surface language across the renderer and the site
- 0144 System compact typography is the default (partially superseded)
