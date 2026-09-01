# 0072. Settings collections stay open

**Status:** Accepted

## Context

Decision 0070 raised setup and form objects to match the renderer's public-block
visual language. Applying that treatment to every Settings group created large
grey containers around routine preferences and long extension lists. Those
containers obscured the reading hierarchy already established by Appearance:
section label, hairline rows, and one aligned control edge.

## Decision

- This record is a scoped exception to 0070's rule that Settings and Provider
  Settings use raised form cards. All other 0070 rules remain in force.
- Routine preference groups and collection shells render open on the Settings
  workspace with hairline row separators and no radius or shadow.
- Discrete objects still use the raised recipe when their boundary carries
  meaning: provider instances, setup flows, install and trust reviews,
  destructive groups, previews, and independently actionable cards.
- A list does not gain elevation merely because its rows describe discrete
  objects. The list shell stays open; a row or expanded review may establish its
  own elevation when it needs an independent boundary.
- Appearance is the reference rhythm for routine Settings pages. Code defaults
  and extension/skill collections use the same open-section grammar while
  preserving their existing authority, validation, and lifecycle behavior.

## Consequences

- Dense Settings pages scan as one coherent preference surface instead of a
  dashboard wall.
- Elevation communicates an object or workflow boundary rather than grouping
  every adjacent control.
- Visual-language contract tests distinguish open collections from the raised
  objects they contain.

## Related

- 0016 Component foundation and theme
- 0046 shadcn recipes own product controls
- 0070 Renderer visual language matches public block catalogs
