# 0109. A settings section is an object

**Status:** Accepted

## Context

Settings is a grouped form page: a navigation rail, and one 800px reading
column holding sections, each a quiet label over a handful of rows.

Every one of those sections was drawn open on the application ground, with a
hairline between rows and nothing around the whole. `DESIGN.md` said so
plainly: "Routine related rows stay open on the application ground with
hairline separators."

The result is a page a reader cannot see the shape of. Measured on
Settings › General at 1440x900: five sections, each announced by a label in
the secondary ink at the detail size — the quietest type the system
produces — and separated from the next by 67 to 84 pixels of nothing. A row
and the section label above it are drawn with the same weight of edge, which
is none. Where one section ends and the next begins has to be inferred from
the size of a gap, and a row's own extent has to be inferred from where its
text happens to stop. Seventeen destinations are built this way.

The maintainer's word for it was "horrible", with a request to make Settings
cleaner and easier to read and adjust.

## Decision

A settings section is an object. It draws its own edge — the same hairline
ring `OctantCard` uses (0090), over the surface fill — and its label is the
first line inside that edge, so a label and the rows it governs are one
thing rather than two things a gap apart.

**The object is the section, not the group inside it.** Several sections
carry rows that never sit in a `.setgroup`: GitHub's account state, the host
facts, the harness summary. Drawing an edge around only the sections that
happen to use that wrapper reads worse than drawing none, because one boxed
row then floats among flat ones. Keying on the section covers all seventeen
destinations from one rule.

A section keeps `overflow: visible`. Its rows hold menus, popovers and
comboboxes that have to escape the box, and clipping them is the failure this
repository has already shipped once (the Code tray's Project menu).

What does not change: the 800px measure, the 32px rhythm between sections,
the navigation rail and its quiet group labels, the hairline between rows
inside a section, and the rule that a shared control is never repainted by a
feature stylesheet (0046).

## Consequences

- `DESIGN.md` no longer says routine related rows stay open on the
  application ground. It says a section is an object and names what that
  costs and covers.
- 0096, which put inline profile and provider editors on the flat page ground
  with aligned row edges, keeps the aligned edges and loses the flat ground:
  those editors are inside the section object now, and their alignment is the
  section's inset rather than the page's.
- Everything inside a section takes that inset, including content that is not
  a row. The theme preview strip in Appearance ran past the new edge until it
  did.
- The change is one rule plus its insets, so a destination added later is an
  object without asking.
