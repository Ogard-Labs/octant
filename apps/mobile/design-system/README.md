# Octant Mobile Design System

The React Native projection of Octant's product-wide design language.
Shared semantic colors come from `@octant/theme`; this directory owns only the
native mapping, mobile-only materials and touch geometry. Do not copy the core
palette here or import third-party product assets, copy, registries, or
distinctive implementation structures.

## Layering (do not invert)

1. **Tokens** — shared neutral greys and semantic statuses from `@octant/theme`;
   the base accent is the colour style's blue on every surface (the phone has no Mono choice yet).
2. **Home** — a compact header (menu, title, search), one row of status pills
   (Needs you, Working, In review) that open the filtered list, the Work and
   Code threads that need the person first under Recent, then Computers.
3. **Surfaces** — flat opaque panels (default, desktop-consistent) or Apple
   liquid-glass; user-selectable.
4. **Conversation-first thread** — conversation spacing, full-width assistant prose,
   message actions (copy), and a floating composer with arrow-up send.

## Token and material direction

Use the desktop's neutral, high-contrast tokens on a quiet flat ground. The
Octant canvas is a workspace colour with a whisper of neutral wash — not a loud
photo. Glass panels and the bundled atmosphere photo remain opt-in materials
(ScreenCanvas `backgroundMode="atmosphere"`, Appearance → Background).

## Thread behavior

The thread is conversation-first:

- `ThreadScreen` and `FloatingComposer` keep the transcript and composer clear.
- `MessageBubble` and `MessageActions` make copy and follow-up actions available.
- Assistant prose stretches within a surface panel; user replies use solid ink bubbles.
- `ReasoningPart`, `ToolPartCard`, `MessageBlocks`, and `AttemptStatus` render
  structured conversation state.
- `ThemeProvider` supplies the Octant light and dark tokens, while Hosts →
  Appearance → Surfaces controls glass or flat panels.

## Cross-surface adoption (web / desktop later)

Shared, client-agnostic pieces already land in:

- `@octant/contracts` — optional `ChatContentBody.parts`
- `@octant/domain/chat-message-parts` — resolve / parse helpers

Mobile renders them first. **Web and desktop should reuse those contracts and
domain helpers** when their Distilled UI track starts; do not fork a second
message-part dialect. App shells (React web vs Expo) stay separate.

## Layout

```text
design-system/
  tokens.ts / materials.ts / theme.tsx / themeAtmospheres.ts
  ScreenCanvas.tsx / GlassSurface.tsx / GlassCard.tsx / GlassChip.tsx
src/ui/
  MessageBubble.tsx / MessageActions.tsx / MessageBlocks.tsx
  ReasoningPart.tsx / ToolPartCard.tsx / AttemptStatus.tsx
  FloatingComposer.tsx / StatusPill.tsx
  messageDocument.ts
```

Live thread controls subscribe to host Chat NDJSON events (with quiet reconnect),
show attempt status, Stop / Retry, a Distilled work shelf (complete / cancel /
complete follow-up), and image attach upload. PDF/text attach remains a follow-up.

## Appearance

Hosts → Appearance:

- **Theme:** System / Light / Dark
- **Surfaces:** Flat (solid, default) or Glass (frosted)
- **Background:** Octant canvas (default), atmosphere photo, or custom photo

## Principles

1. **Ground first** — flat workspace colour; material stays quiet unless opted in.
2. **Soft idle** — danger color only after a failed mutation.
3. **Continuous corners** — compact radii (card 16, composer 22). Large tiles
   and soft oversized corners are not the Octant look.
4. **Rows over tiles** — lists are flat rows on hairlines; panels are for
   content the person reads, not for navigation targets.
5. **Hairline light** — neutral ink-alpha borders.
6. **Octant-owned** — tokens, copy, assets stay `@octant/*`.
