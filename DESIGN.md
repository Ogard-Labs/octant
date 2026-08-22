---
version: alpha
name: "Octant"
description: "A calm, local-first agent workspace with a graphite shell, thread-first hierarchy, and contextual tools."
colors:
  primary: "#202020"
  dark-background: "#171717"
  dark-sidebar: "#202020"
  dark-raised: "#242424"
  dark-control: "#292929"
  dark-hover: "#303030"
  dark-border: "#2D2D2D"
  dark-border-strong: "#454545"
  dark-text: "#F2F2F2"
  dark-text-secondary: "#B5B5B5"
  dark-text-muted: "#8A8A8A"
  dark-accent: "#F2F2F2"
  light-background: "#F7F7F7"
  light-sidebar: "#F0F0F0"
  light-workspace: "#FFFFFF"
  light-raised: "#F3F3F3"
  light-border: "#DEDEDE"
  light-text: "#202020"
  focus-dark: "#F2F2F2"
  focus-light: "#202020"
  success: "#6BB299"
  warning: "#EDBC26"
  danger: "#E17D96"
typography:
  sans:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "13px"
    lineHeight: "1.45"
  mono:
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace"
    fontSize: "12px"
    lineHeight: "1.45"
rounded:
  DEFAULT: "8px"
  chip: "6px"
  control: "8px"
  panel: "10px"
  composer: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  sidebar-width: "232px"
  reading-width: "720px"
components:
  button:
    height: "34px"
    rounded: "8px"
  sidebar:
    width: "232px"
    padding: "8px"
  composer:
    rounded: "14px"
  panel:
    rounded: "10px"
---

# Octant Design System

## Overview

### Creative North Star

Octant should feel like a quiet professional workbench cut from graphite: one clear work surface, a shallow folder hierarchy at the left, and tools that appear beside the work only when needed. ChatGPT/Codex and reference app are interaction references for restraint, project/thread nesting, composer prominence, and contextual right-side tools. They are direction, not source material to copy.

### Product context and register

- **Audience and primary job:** developers and knowledge workers supervising several AI threads, agents, Projects, changes, and delivery states from one local-first application.
- **Target market and evidence:** a general technical-preview audience; no market-specific visual shorthand is assumed.
- **Locales:** owned interface copy is English today. Layouts must tolerate localization without fixed character-count assumptions.
- **Usage scene:** a macOS desktop application used for long, high-attention sessions with dense technical content.
- **Register:** product. Task clarity, state truth, and earned familiarity lead; brand expression stays restrained.
- **Memorable signature:** a generous central transcript and composer framed by a compact Project tree and a thread-aware tool dock.
- **Restraint:** navigation, forms, boards, review, terminals, and status surfaces use familiar desktop patterns and scarce accent.
- **Anti-references:** no dashboard wall of cards, decorative gradients, neon developer styling, oversized setup panels, pill-shaped everything, or permanent low-frequency actions.
- **Token ownership and runtime mapping:** `packages/theme/src/tokens.ts` is the canonical runtime color source. `apps/web/src/styles.css` supplies startup fallbacks; `apps/web/src/styles/octant-bridge.css` and `apps/web/src/styles/shadcn-theme.css` project the semantic roles into the owned CSS and component layers. This file records the durable intent and normative core values; code and this document change together.

## Colors

The default system uses neutral graphite rather than warm brown. Dark mode keeps the workspace at `#171717`, lifts the sidebar to `#202020`, and reserves `#242424` and `#292929` for discrete raised surfaces and controls. Hierarchy comes from restrained tonal steps and hairlines, not multiple card backgrounds.

Primary dark text is `#F2F2F2`; supporting information steps down through `#B5B5B5` and `#8A8A8A`. Light mode reverses the relationship with a white workspace, `#F0F0F0` sidebar, and `#202020` text. Monochrome primary actions invert against their surface. Semantic success, warning, danger, diff, runtime, and Project View colors remain available, but color never carries status alone.

The original charcoal-and-brass palette remains an optional `Octant` theme preset. It is not the default system appearance.

## Typography

Use the macOS system sans stack for shell, navigation, controls, and transcript chrome. Body chrome is 13px at approximately 1.45 line height; compact metadata may use 11–12px only when a nearby visible label provides context. Use 500–600 weight for selected rows, headings, and primary labels; avoid bold body paragraphs.

Use the configured editor/terminal monospace stack only for code, paths, identifiers, commands, diffs, and aligned technical data. Project names, thread titles, navigation labels, and ordinary status copy stay sans-serif.

## Layout

The persistent desktop shell has a 232px navigation sidebar, the central workspace, an optional thread-aware right dock, and an optional horizontal bottom panel. The central transcript and composer are always the primary reading surface.

Sidebar order is stable: compact mode identity, New thread, mode-valid Board and Pull requests, Project Views, the Project/thread tree, then the bottom-left name menu. Code and Work keep separate saved Project View sets; their compact-list versus icon presentation is one global preference. Project folders use explicit folder glyphs and child threads indent by 20px. Clicking the folder row toggles its children; Project Overview remains in its accessible actions menu.

The pane title is the only top bar. Its far-right edge may show Environment, bottom-panel, and right-dock toggles as capability allows. Zen belongs in the bottom-left name menu. Environment opens the existing transient window; Project, branch, clean/dirty state, working folder, listener count, and availability live in that disclosure and its accessible description rather than a second header line.

At narrow widths the sidebar and dock follow their existing responsive contracts, and the bottom panel remains closed. Do not create a squeeze where navigation, workspace, Environment, and utility regions all demand permanent columns.

## Elevation & Depth

Static panes are flat and separated by one-pixel semantic borders. Hover and selection use a single tonal step. Shadows belong only to popovers, dialogs, transient Environment, and other layers that genuinely float above content. Do not wrap every section, status, or empty state in a card.

Native translucency may soften the sidebar when the host and accessibility settings permit it. The opaque fallback keeps identical geometry and hierarchy. Blur is material, not decoration.

## Shapes

Use 6px for compact chips and row-level controls, 8px for ordinary buttons and inputs, 10px for panels and popovers, and 14px for composers. Pills are reserved for compact categorical chips or prompt suggestions; rows, cards, and large controls are not pills.

Lucide icons use 1.5–1.8px strokes and usually render at 14–16px. Icons clarify labels; they do not replace essential text unless the control has an accessible name and a familiar, repeatedly used placement.

## Components

### Foundational visual states

Default controls are quiet. Hover adds one neutral surface step. Selected navigation uses stronger text plus a restrained fill or one-pixel marker. Focus-visible uses the semantic focus ring without moving geometry. Disabled controls are visibly subdued and non-interactive. Busy, stale, unavailable, empty, and error are distinct states with concise copy and stable layout.

### Buttons and actions

Keep one obvious primary action per local decision point. Secondary actions are neutral; destructive actions are separated and explicitly named. Low-frequency row actions appear on hover and focus, remain in flow to prevent layout shift, and are mirrored by keyboard-accessible menus. Right-click is never the only route.

### Navigation and data display

Chat, Work, and Code remain permanent modes behind one compact labeled selector. Primary sidebar destinations are New thread, Thread board, and Pull requests as the active mode allows. Agents, Automations, Artifacts, Plugins, Navigator, Settings, Usage, Providers, and Zen live in the grouped bottom-left name menu when available.

Board and Pull-request destinations remain discoverable in supported modes. Their surfaces state setup, unavailable, stale, empty, refreshing, and loaded conditions honestly; they never display invented data or silently poll GitHub.

### Forms and overlays

The new-thread surface is composer-first. One compact context row carries Project, provider/model, access, branch, and delivery controls; optional prompt suggestions sit below and never compete with the input. Configuration problems appear as compact inline recovery states rather than oversized setup cards.

The right dock is closed by default. Its toolbar opens a compact launcher; selected Browser, Terminal, Files, Review, Plan, Canvas, Agents, Delivery, Tests, Simulator, or Side Chat tools occupy the dock as live thread-owned surfaces. Empty dock chrome is not a full-page illustration or card.

The bottom panel is also closed in a new window and restores open state and height per window. Terminal is its first tab. One thread-owned Terminal has one presentation: moving it between right and bottom regions preserves the session and never duplicates or rebinds it.

### Iconography

Use Lucide only. Project folders, mode identity, status, tool type, and action intent receive semantic icons. Do not use emoji, text glyphs, handcrafted SVG art, or provider logos as decorative furniture.

### Motion

Use 100–160ms feedback transitions for color, opacity, and small disclosure changes. Avoid decorative entrance motion. Running-state animation must stop under Reduced Motion and retain a non-animated textual or shape distinction.

### Content and data visualization

Copy is direct and operational: state what happened, what is unavailable, why, and the next available action. Avoid implementation identifiers, marketing language, or repeated explanatory prose in routine flows. Technical values use tabular numerals where comparison matters.

## Do's and Don'ts

- **Do:** keep the active thread and composer visually dominant.
- **Do:** preserve real capabilities while moving low-frequency entry points into logical groups.
- **Do:** use one Project/thread hierarchy and one thread-aware right dock.
- **Do:** show honest stale, empty, unavailable, permission, and failure states.
- **Don't:** turn every feature into a permanent sidebar row, tab, disclosure, or card.
- **Don't:** use raw UUIDs, paths, provider internals, or backend capability names as primary UI copy.
- **Don't:** hide essential actions exclusively behind hover or right-click.
- **Don't:** use warm brass as the default system accent; it remains available through the original Octant theme preset.
