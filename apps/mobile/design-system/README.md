# Octant Mobile Design System

The React Native projection of Octant's product-wide design language.
Shared semantic colors come from `@octant/theme`; this directory owns only the
native mapping, mobile-only materials and touch geometry. Do not copy the core
palette here or import third-party product assets, copy, registries, or
distinctive implementation structures.

## Layering (do not invert)

1. **Tokens** — shared neutral greys, control fills, palette hues and semantic
   statuses from `@octant/theme`; the base accent is the colour style's blue on
   every surface (the phone has no Mono choice yet). Radii follow the product
   scale (control or row 8, card or a person's message 12, composer or dialog
   14); the bottom sheet's 20 is the one phone-only radius.
2. **Native chrome** (`src/ui/NativeChrome.tsx`, `TabBar.tsx`) — the phone looks
   and behaves like a native app, not a web page: a bottom tab bar for the top
   places (Inbox, Chat, Work, Code, Settings), a large title on each tab's
   root, a centred nav bar with a back chevron on a pushed screen, inset
   grouped lists with separators that start where the text does, checkmark
   selection lists, the system segmented control, and sheets with a grabber.
   Screens compose these rather than drawing page headings, chip rows, or
   free-floating text.
3. **Home** — the large title with search and compose in the toolbar, one row
   of three count tiles (Needs you blue with a tray, Working orange with a play
   circle, In review purple with an eye: the desktop's tiles and marks), the
   Work and Code threads that need the person first under Recent, then
   Computers. A tile is a solid hue face with white ink in light and a tint
   with a coloured count in dark, as on the desktop.
4. **Surfaces** — flat opaque panels (default, desktop-consistent) or Apple
   liquid-glass; user-selectable.
5. **Conversation-first thread** — bare prose replies, a person's message in a
   control-fill bubble with a hairline, reasoning and tool calls as compact
   rows, plain glyph message actions, and a floating composer with arrow-up
   send.

## Token and material direction

Use the desktop's neutral, high-contrast tokens on a quiet flat ground. The
Octant canvas is a workspace colour with a whisper of neutral wash — not a loud
photo. Glass panels and the bundled atmosphere photo remain opt-in materials
(ScreenCanvas `backgroundMode="atmosphere"`, Appearance → Background).

## Thread behavior

The thread is conversation-first, following docs/design/thread-view.md:

- `ThreadScreen` and `FloatingComposer` keep the transcript and composer clear.
- `MessageBubble` and `MessageActions` make copy and follow-up actions available.
- A reply is bare prose with no card; only a person's message is boxed, in the
  control fill with a hairline and no accent. Markdown headings in a reply are
  labels (17 and 15, weight 600), not page titles.
- `ReasoningPart` and `ToolPartCard` are 32pt rows; their open detail hangs
  off a hairline under the row. `MessageBlocks` and `AttemptStatus` render the
  rest of the structured conversation state.
- `ThemeProvider` supplies the Octant light and dark tokens, while Settings →
  Surfaces controls glass or flat panels.

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
  FloatingComposer.tsx / CountTile.tsx / NativeChrome.tsx / TabBar.tsx
  messageDocument.ts
```

Live thread controls subscribe to host Chat NDJSON events (with quiet reconnect),
show attempt status, Stop / Retry, a Distilled work shelf (complete / cancel /
complete follow-up), and image attach upload. PDF/text attach remains a follow-up.

## Appearance

Settings:

- **Theme:** System / Light / Dark
- **Surfaces:** Flat (solid, default) or Glass (frosted)
- **Background:** Octant canvas (default), atmosphere photo, or custom photo

## Principles

1. **Ground first** — flat workspace colour; material stays quiet unless opted in.
2. **Soft idle** — danger color only after a failed mutation.
3. **Product radii** — control 8, card 12, composer 14; pills only for compact
   chips and circular controls.
4. **Native first** — system patterns (tab bar, large titles, grouped lists,
   segmented controls, sheets) over page-like layouts; counts live in three
   tiles, never a grid of cards.
5. **Hairline light** — neutral ink-alpha borders.
6. **Octant-owned** — tokens, copy, assets stay `@octant/*`.
