# 0144. System compact typography is the default

**Status:** Accepted

## Context

0073 made the bundled interface face the renderer's default and kept the
platform face as a fallback. The persisted typography seam already supports
independent interface, editor, and terminal settings, but the shipped values
were larger than the compact working scale Octant uses for its long-running
desktop surfaces. The default should read as platform-native on first launch,
while the bundled face remains available to people who prefer it.

## Decision

- This record supersedes only 0073's default interface-face and default-size
  rule. Its surface hierarchy, shell, welcome, usage, and marketing-language
  rules remain in force.
- The default interface stack is `-apple-system, BlinkMacSystemFont,
'Segoe UI', system-ui, sans-serif` at 13px and weight 400. The bundled
  variable face remains available as an explicit Appearance choice.
- The default editor stack is `'JetBrains Mono Variable', 'JetBrains Mono',
'SF Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace`
  at 13px, 1.5 line height, and enabled ligatures.
- The default terminal stack is `'JetBrains Mono Variable', 'JetBrains Mono',
'SF Mono', Menlo, 'Symbols Nerd Font Mono', monospace` at 12px, 1.4 line
  height, and disabled ligatures. Prompt glyphs may fall back per character.
- Transcript text defaults to 13px. The shared interface type ladder keeps one
  scale and uses 13px as its baseline, so changing the interface size still
  moves ordinary chrome together.
- Theme typography remains owned by the existing contract and projection seam.
  Themes cannot load remote or untrusted fonts; unavailable local faces fall
  back through the declared stack.

## Consequences

- A new Octant install starts with the platform interface face and compact
  working text without requiring a theme edit.
- Code and terminal surfaces use the same local-first monospace family order
  across the renderer, editor, and terminal projections.
- Existing saved settings keep their explicit family and size choices. The
  legacy platform stack continues to resolve as the current default.
- The existing bundled interface font remains a selectable opt-in face, so
  the platform default does not remove a shipped accessibility or preference
  path.

## Related

- 0016 Component foundation and theme
- 0073 One surface language across the renderer and the site (partially superseded)
