# Octant product shell

Octant’s window is a calm project-first workspace: one mode, one Project
tree, one selected thread, and live tools beside it. The visual language is
**Octant, distilled** — near-black graphite, hairline pane boundaries,
compact rows, typography-led hierarchy, scarce accent. Tokens, not
one-off colors, carry that language. See
[0016](decisions/0016-component-foundation-and-theme.md) and
[0038](decisions/0038-owned-design-system-stylesheet.md).

## Surfaces

| Region       | Job                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Left sidebar | Mode, then New thread / Thread board / Pull requests as the mode allows, then Projects and their threads. Secondary surfaces live in the bottom-left app menu. |
| Center       | The transcript, board, or Project overview. Composer stays in this column.                                                                                     |
| Right dock   | Live tools owned by the active pane’s thread. A compact launcher when none are open; a tool strip when some are.                                               |
| Top chrome   | Identity, status, and window controls. Overflows before it collides.                                                                                           |

Mode changes authority and density, not this grammar. Chat is calmest, Work
adds artifact context, Code is densest.

## Destination grammar

Permanent sidebar rows above Projects are only **New thread**, **Thread
board**, and **Pull requests**. Chat has New thread. Work adds Thread
board. Code adds both Thread board and Pull requests. Hide a destination
that is honestly unavailable.

Projects are folders; threads are children. One selected state. Status is a
small labelled mark, never a row of badges. Raw identifiers (thread ids,
checkout ids, operation ids) stay off the row.

Agents, Automations, Artifacts, Plugins, Navigator, and Settings open from
the bottom-left app menu. A gated item is absent.

## Empty and error

Setup, empty, loading, unavailable, stale, and error states are compact copy
plus the one action that would change the state. They do not occupy the
center with large cards, disabled rows, or destinations that cannot run.

## Tokens

Semantic `--octant-*` roles are the source of truth (`packages/theme` and
the runtime projection in `apps/web/src/styles.css`). `--oct-*` is the
consumption alias in the design-system sheet (`apps/web/src/styles/octant.css`).
Do not introduce a parallel palette. Tailwind and shadcn variables are a
further projection and never own persistence.

| Role                                         | Use                                         |
| -------------------------------------------- | ------------------------------------------- |
| `--octant-workspace` / `--oct-bg`            | Solid workspace ground                      |
| `--octant-sidebar-opaque` / `--oct-fg-soft`  | Sidebar fill and quiet selection            |
| `--octant-text-primary` / `--oct-fg`         | Selected title, primary copy                |
| `--octant-text-secondary` / `--oct-muted`    | Unselected rows, supporting copy            |
| `--octant-text-muted` / `--oct-meta`         | Section labels, idle marks                  |
| `--octant-border` / `--octant-border-strong` | Hairline pane and menu edges                |
| `--octant-focus`                             | Keyboard focus only                         |
| `--oct-accent` / `--octant-accent-text`      | Scarce accent; never ordinary selection     |
| `--oct-warn` / `--octant-warning-text`       | Attention and relink, with a non-color mark |

Navigation and list rows target 24–32 px. Radii stay at the system scale
(6 px chips, 8 px controls, 10 px panels). Ordinary panes stay flat.
Accent is not a selected-row fill.

## Controls

Complex menus, dialogs, and selects use the Octant wrappers over Base UI
(`apps/web/src/ui/base`). Shell chrome stays Octant-owned and styled with
these tokens. Feature code does not import `@base-ui/react/*` or
`ui/shadcn/*` directly.

## Related

- [0015](decisions/0015-workspace-shell-model.md) layout, split tree, authority
- [0045](decisions/0045-sidebar-is-a-calm-project-first-workspace.md) sidebar destinations
- [0044](decisions/0044-the-dock-hosts-live-thread-owned-tools.md) dock tools
