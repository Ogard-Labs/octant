# 0098. Follow-up composers separate the message and its context

**Status:** Accepted

## Context

Existing-thread composers used the welcome frame's large corners and elevation.
Checkout facts floated above the input, and transient status or quota text changed
the frame height and toolbar position between otherwise similar panes.

## Decision

- Chat, Work, and Code follow-up composers use one compact message surface with
  a hairline boundary and the shared medium radius. Focus changes the boundary
  tone without adding a shadow or halo.
- A fixed feedback lane sits between the message and its toolbar. It stays
  mounted when empty so status changes do not move the toolbar. Long feedback
  remains scrollable and accessible; interactive recovery controls remain usable.
- Code checkout identity, branch, diff facts, and the pull-request action sit in
  a separate attached context strip beneath the message surface. They continue
  to read the same authoritative checkout context.
- Input grows when the person adds lines. Model selection, attachments, typing,
  sending, stopping, and draft persistence keep their existing owners and behavior.
- Welcome composers retain their current paragraph-height input, context band,
  radius, and elevation.

This supersedes only 0090's fixed composer radius and shadow for follow-up
composers. Its token ownership and all other surface rules remain in force;
0094 continues to govern quiet focus treatment.

## Consequences

`ThreadComposer` owns the follow-up presentation and optional context slot.
Feature callers supply their message, feedback, and context without duplicating
the frame. Code checkout facts no longer consume a separate row above the input.

## Related

- 0078 Welcome composer context band
- 0090 Recipes own their shape
- 0094 Quiet focus and selection
