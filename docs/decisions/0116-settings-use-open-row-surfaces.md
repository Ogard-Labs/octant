# 0116. Settings use open row surfaces

**Status:** Accepted

## Context

Settings needs one visual grammar across General, Appearance, modes, providers,
agents, integrations, and system pages. ADR 0109 made every section a
child-built card, which created a rounded edge around each section's content.
The edge was repeated by nested editors and made short pages read as a stack of
boxes rather than one navigable preference surface. The maintainer asked for a
simpler, Codex-like surface with less chrome while retaining clear labels and
controls.

## Decision

This record scopes a supersession of ADR 0109's child-built card rule. A
Settings section remains the object that owns its title, description, rows,
and overflow behavior, but its routine content is rendered on the page ground
as one open row list. Rows use one hairline separator and a shared 44px rhythm;
the section label and one-line description stay outside that list. Shared
controls use one right-hand value column and compound editors stack below their
labels. A discrete editor, confirmation surface, or protected action may keep
a bounded surface when its interaction hierarchy requires it.

The navigation rail, sentence-case group labels, 920px reading measure,
responsive drawer, overflow-visible rows, and shared control ownership remain
unchanged. The change is presentational and does not alter setting authority,
persistence, or server commands.

## Consequences

- All Settings destinations can use the same open section, row, state, and
  disclosure recipes without inheriting rounded card edges.
- Provider, host, extension, and harness surfaces keep their behavior while
  consuming the shared row rhythm; only deliberate editor boundaries remain
  bounded.
- ADR 0109 remains authoritative for section ownership, insets, and overflow,
  except for the child-built card presentation superseded here.

## Related

- [0096](0096-settings-editors-share-the-page-layout.md)
- [0109](0109-a-settings-section-is-an-object.md)
