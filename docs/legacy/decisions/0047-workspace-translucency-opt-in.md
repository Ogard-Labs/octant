# 0047. Workspace translucency opt-in

**Status:** Accepted

## Context

0015 states the sidebar may use native translucency while "the workspace
stays visually solid." That was correct for the shell's default look, but the
native vibrancy Electron already applies for the sidebar
(`apps/desktop/src/windowPresentation.ts`) frosts the whole window's backing
store at the OS compositing level; only the sidebar's own CSS currently
chooses to reveal that frost, while the workspace layer paints itself fully
opaque over the rest of it. Some users running Octant over desktop wallpaper,
another app, or a terminal want that same frosted-glass read across the whole
window, not just the navigation rail. Extending translucency to the workspace
layer is therefore a settings-and-CSS change layered on an already-present
native material, not a new capability, a new window type, or a change to
layout geometry.

## Decision

- A new opt-in shell setting, `workspaceMaterial` (`"system"|"opaque"`,
  default `"opaque"`), extends translucency from the sidebar to the
  workspace background. It has effect only when the sidebar's own resolved
  material is already translucent — `sidebarMaterial: "system"` and every
  existing accessibility, performance, and host-support gate already passed.
  It never enables translucency the sidebar setting itself would refuse.
- The default is opaque. A settings store persisted before this setting
  shipped, and every user who never opens it, keeps the workspace exactly as
  0015 originally described.
- Enabling it reuses the sidebar's existing native vibrancy instance and
  vibrancy-intensity tier (off/subtle/strong) rather than requesting a
  second, independently gated native material; the workspace and sidebar
  frost by the same degree at the same time.
- Individual surfaces drawn inside the workspace — menus, dialogs,
  Environment, ordinary popovers, panel chrome — stay opaque semantic
  surfaces per 0046. This setting affects only the outer workspace-layer
  background paint, not any control drawn on top of it.

## Consequences

- 0015's "the workspace stays visually solid" holds only when this setting is
  off, which remains the default and the only behavior for any user who never
  opens the setting.
- No new Electron `BrowserWindow` vibrancy material, IPC channel, or host
  capability is introduced; the setting is gated entirely by state the host
  already publishes for the sidebar, so reduced-transparency, high-contrast,
  thermal, and unsupported-host behavior stays identical for both surfaces by
  construction rather than by duplicated logic.
- A future, visually distinct workspace material (a separate native vibrancy
  value, independent of the sidebar's) is a later, additive decision and not
  required by this record.

## Related

Narrows one clause of 0015-workspace-shell-model.md: "the workspace stays
visually solid" now holds only when workspace translucency is off, the
default. 0015 remains Accepted for the shell model outside that clause, the
same way 0041, 0042, and 0044 narrow parts of it without superseding it
wholesale.

- 0015 Workspace shell model
- 0046 shadcn recipes own product controls
