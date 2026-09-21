# 0155. Conversations share a quiet reading surface

**Status:** Accepted

## Context

Over the application background, every agent reply wore a reading card.
Short replies, tool activity, and the composer had the same broad outline,
and the last visible reply could touch the input while scrolling. Glass
softened their material but kept the repeated card shapes. The exposed
pattern between them competed with the conversation.

## Decision

- Chat, Work, and Code conversations share one continuous reading background
  over the application ground. It uses the theme's workspace colour, with
  97% opacity across the centre and 90% at the outer edges. The pattern is
  subdued under the text and remains faintly visible at the margins.
- The fallback is an opaque workspace background. An app or OS reduced
  transparency preference keeps it opaque; engines without colour mixing
  also retain the opaque declaration.
- Ordinary agent replies stay bare prose on this shared surface, including
  on translucent workspaces. Structured results, code blocks, file changes,
  and approval requests retain their existing containers and controls.
- User bubbles and composers keep their existing materials. The composer is
  the distinct input surface, with its typing room and attached context strip.
- Follow-up composers reserve 24px above the frame, outside the transcript's
  scrolling area, in addition to the transcript's end padding. A partially
  visible reply cannot meet the input edge while the person reads scrollback.
- The existing 72ch prose measure, wider code and tables, draft persistence,
  tool disclosure, failure visibility, and provider/access controls stand.

This supersedes only 0150's requirement that agent replies carry individual
reading cards with thick glass. Its glass rules for user bubbles and composers,
its accessibility fallbacks, and all other rules remain in force. Zen and
welcome screens are unchanged.

## Consequences

`surface.css` owns the conversation background; `octant.css` retains the shared
reply and composer recipes. The background no longer requires a blur per reply.
The change is presentation-only and does not alter transcript or tool state.

## Related

- 0091 Application background
- 0098 Follow-up composers separate the message and its context
- 0150 A thread over the application ground wears glass
