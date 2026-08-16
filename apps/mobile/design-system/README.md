# Octant Mobile Design System

Owned Distilled language for `@octant/mobile`. It uses Octant tokens,
copy, assets, and components; do not import third-party product assets, copy,
registries, or distinctive implementation structures.

## Layering (do not invert)

1. **Tokens** — cream / warm ink / `#F54E00` (and Distilled dark charcoal).
2. **Home** — status cards + Workspaces (unchanged by chat chrome).
3. **Surfaces** — Apple liquid-glass (default) or flat solid panels; user-selectable.
4. **Conversation-first thread** — conversation spacing, full-width assistant prose,
   message actions (copy), and a floating composer with arrow-up send.

## Token and material direction

Use warm, high-contrast tokens with **translucent liquid-glass** over theme
atmosphere photos (wireframe light / aurora dark).

## Thread behavior

The thread is conversation-first:

- `ThreadScreen` and `FloatingComposer` keep the transcript and composer clear.
- `MessageBubble` and `MessageActions` make copy and follow-up actions available.
- Assistant prose stretches within a surface panel; user replies use solid ink bubbles.
- `ReasoningPart`, `ToolPartCard`, `MessageBlocks`, and `AttemptStatus` render
  structured conversation state.
- `ThemeProvider` supplies Distilled light and dark tokens, while Hosts →
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
  FloatingComposer.tsx / StatusCard.tsx
  messageDocument.ts
```

Live thread controls subscribe to host Chat NDJSON events (with quiet reconnect),
show attempt status, Stop / Retry, a Distilled work shelf (complete / cancel /
complete follow-up), and image attach upload. PDF/text attach remains a follow-up.

## Appearance

Hosts → Appearance:

- **Theme:** System / Light / Dark
- **Surfaces:** Glass (frosted, default) or Flat (solid Distilled)
- **Background:** atmosphere canvas or custom photo

## Principles

1. **Material first** — frosted translucent glass over atmosphere photos.
2. **Soft idle** — danger color only after a failed mutation.
3. **Continuous corners** — large radii (card 20–28, composer ~30).
4. **Hairline light** — warm ink-alpha borders.
5. **Octant-owned** — tokens, copy, assets stay `@octant/*`.
