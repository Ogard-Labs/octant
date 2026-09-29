# 0161. Geist is the default interface face

**Status:** Accepted

## Context

0149 restored the bundled Inter variable face as the interface default. Using
it, the maintainer reviewed rendered mockups of five candidates — Inter,
the platform stack, Geist, IBM Plex Sans, and Figtree — and asked for Geist as
the default going forward.

Geist ships under the SIL Open Font License, the same licence family as the
Inter and Space Grotesk faces already bundled, so vendoring costs nothing new:
one `@fontsource-variable` package beside Inter's.

## Decision

The interface default is the bundled Geist variable face, with the same
platform stack behind it:
`'Geist Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`.
Size, weight, and the rest of the compact typography are unchanged. Inter
remains bundled and selectable in the Appearance pickers, so existing
screenshots and anyone who preferred it keep the option.

Saved settings keep their meaning: a person who never chose a face sees Geist;
a saved Inter or custom stack is honoured verbatim, and the saved system stack
still means "the default" through the migration in `savedUiFamily`.

## Consequences

- New installs render interface text in Geist; nothing else about the compact
  scale, tracking, or the System interface choice changes.
- The native approval view names Geist first in its stack and still falls back
  to the platform faces where the bundled file is unavailable.
- A future default change edits `DEFAULT_THEME_SETTINGS` and the pickers, and
  supersedes this record the same way.

## Related

- 0073 A bundled display face belongs to the design system
- 0144 System compact typography is the default
- 0149 Inter is the default interface face (superseded here)
