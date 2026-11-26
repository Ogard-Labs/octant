# Octant Mobile Design System

The React Native projection of Octant's product-wide design language.
Shared semantic colors come from `@octant/theme`; this directory owns only the
native mapping, mobile-only materials and touch geometry. Do not copy the core
palette here or import third-party product assets, copy, registries, or
distinctive implementation structures.

## Native first

The phone is drawn with the platform's own parts wherever the platform has
one, and with Octant's tokens only inside them. It follows Apple's Human
Interface Guidelines on iOS and Material Design on Android through their own
components; Android is Material, not an iPhone look-alike. The layout,
density and interactions may follow the reference app the maintainer named
for this redesign; its copy, assets, logo, colours, icon set, identifiers and
code are never taken, and it is not named.

| Part           | What the phone uses                                                                                                                                                                                                         | Where                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Places and bar | The system tab bar, icons only with a spoken label each: Home, Threads, Inbox (Bots second and Pull requests fourth stay hidden until their work lands); the floating glass bar on iOS 26 and later                         | `src/navigation/places.ts`, `PlaceTabs.native.tsx`                                                           |
| New            | A round button beside the bar that opens the New thread sheet from every place                                                                                                                                              | `src/navigation/NewButton.tsx`                                                                               |
| Screens        | One native stack per place, with swipe-back; large titles that collapse on a place's root; system header buttons and menus                                                                                                  | `src/navigation/RootNavigator.tsx`, `ScreenHeader.tsx`                                                       |
| Sheets         | The system sheet on iOS (its grabber, heights and swipe), the Material bottom sheet on Android; fitted, half or full height. A sheet asked for while another leaves waits for it; a sheet over another opens from inside it | `src/ui/BottomSheet.tsx`, `sheetsClosing.ts`                                                                 |
| Menus          | The system menu on a long press for a thread row and a message, and as a pull-down for filters and choices; each refused action says why                                                                                    | `src/inbox/ThreadRowMenu.ios.tsx`, `src/ui/MessageMenu.ios.tsx`, `ChoicePill.ios.tsx`, `FilterChips.ios.tsx` |
| Confirmations  | The system alert: Remove computer, the Full access warning, a waiting message that may have been sent                                                                                                                       | `src/hosts/RemoveHostPanel.tsx`, `src/inbox/thread/ThreadLevelPanel.tsx`                                     |
| Controls       | The system segmented control                                                                                                                                                                                                | `src/ui/SegmentedControl.ios.tsx`                                                                            |
| Rows           | Swipe actions for settle, wake and pin, with the way back                                                                                                                                                                   | `src/inbox/ThreadRowSwipe.native.tsx`                                                                        |
| Icons          | SF Symbols on iOS through one name table                                                                                                                                                                                    | `src/ui/symbols.ts`, `Icon.ios.tsx`                                                                          |
| Haptics        | On send, success, failure and selection                                                                                                                                                                                     | `src/ui/haptics.native.ts`                                                                                   |
| Composer       | Liquid Glass where the system has it, riding the keyboard                                                                                                                                                                   | `src/ui/ComposerSurface.ios.tsx`, `FloatingComposer.tsx`, `KeyboardRoom.native.tsx`                          |
| Text           | Every style follows the system text size and fits at the largest accessibility size                                                                                                                                         | each screen                                                                                                  |

The web build that runs the development mock draws JavaScript stand-ins for
these parts. It is a layout check, not a fidelity check; it shows no system
alert.

Not built yet: Android's Material menus and dialogs (rows and messages still
open a sheet there), iPad and foldable columns, the virtualized transcript,
native markdown, and the native diff and terminal views.

## Layering (do not invert)

1. **Tokens** — shared neutral greys, control fills, palette hues and semantic
   statuses from `@octant/theme`; the base accent is the colour style's blue on
   every surface (the phone has no Mono choice yet). Radii follow the product
   scale (control or row 8, card or a person's message 12, composer or dialog
   14). Sheets take the system's corner.
2. **Platform parts** — the table above. Screens compose these and
   `ListSection`, `ListRow` and `ListNote` (`src/ui/NativeChrome.tsx`) rather
   than drawing page headings, chip rows, or free-floating text.
3. **Home** — the large title with search, To-dos and Settings in the header,
   one row of three count tiles (Needs you blue with a tray, Working orange
   with a play circle, To review purple with an eye: the desktop's tiles and
   marks), the threads that need the person first under Recent, then
   Computers.
4. **Surfaces** — the system page by default. A picture ground and glass or
   flat panels are Appearance choices, drawn behind content only and never in
   bars, the tab bar, sheets, menus or alerts.
5. **Conversation-first thread** — bare prose replies, a person's message in
   the control fill, reasoning and tool calls as compact rows, plain glyph
   message actions (also in the long-press menu), and a floating composer
   with arrow-up send.

## Thread behavior

The thread is conversation-first, following docs/design/thread-view.md:

- `ThreadScreen` and `FloatingComposer` keep the transcript and composer clear.
- `MessageBubble`, `MessageActions` and `MessageMenu` make copy, retry, fork
  and rewind available under a message and on a long press.
- A reply is bare prose with no card; only a person's message is boxed, in the
  control fill with no accent. Markdown headings in a reply are labels (17 and
  15, weight 600), not page titles.
- `ReasoningPart` is a 32pt row; `ToolActivity` draws a run of tool calls as
  28pt rows on one rail, folding a settled run behind "N tool calls". Open
  detail hangs off a hairline under the row. `MessageBlocks` and
  `AttemptStatus` render the rest of the structured conversation state.
- `ThemeProvider` supplies the Octant light and dark tokens and follows the
  person's scheme.

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
  ScreenCanvas.tsx / PrintedGround.tsx / groundPrint.ts / groundPictures.ts
  GlassSurface.tsx / GlassCard.tsx / GlassChip.tsx
src/navigation/
  places.ts / PlaceTabs.native.tsx / RootNavigator.tsx / ScreenHeader.tsx / NewButton.tsx
src/ui/
  BottomSheet.tsx / sheetsClosing.ts / MessageMenu.ios.tsx / SegmentedControl.ios.tsx
  MessageBubble.tsx / MessageActions.tsx / MessageBlocks.tsx
  ReasoningPart.tsx / ToolActivity.tsx / AttemptStatus.tsx
  FloatingComposer.tsx / ComposerSurface.ios.tsx / CountTile.tsx / NativeChrome.tsx
  symbols.ts / haptics.native.ts / messageDocument.ts
```

## Appearance

Settings:

- **Theme:** System (default) / Light / Dark
- **Background:** Plain, the system page (default), or a picture: Soft glow,
  Graphite, Sunset, Atmosphere, or the person's photo, printed as it is,
  pixelated, dithered, or in ASCII
- **Surfaces:** Glass or Flat panels over a picture

## Principles

1. **System first** — the platform's own bars, sheets, menus, alerts, controls
   and type, on the system page; a picture ground is the person's choice and
   stays behind content.
2. **Soft idle** — danger color only after a failed mutation.
3. **Product radii** — control 8, card 12, composer 14; pills only for compact
   chips and circular controls.
4. **Counts in three tiles** — never a grid of cards.
5. **Hairline light** — neutral ink-alpha borders.
6. **Octant-owned** — tokens, copy, assets stay `@octant/*`.
