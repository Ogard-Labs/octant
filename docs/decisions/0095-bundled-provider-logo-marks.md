# 0095. Bundled provider logo marks stay offline and licensed

**Status:** Accepted

## Context

Provider rows and model picker rails need to identify a provider at a glance.
The renderer previously used hand-drawn abstract marks for several known
providers, which made the identity ambiguous and made the settings surface
feel unfinished. The app is local-first, so a remote image request would be a
poor fit and would make the same provider render differently while offline.

## Decision

- `ProviderGlyph` uses a small, checked-in set of provider paths for known
  driver kinds. The paths are rendered inline, inherit the theme color, and do
  not load a URL, font, or image at runtime.
- The bundled paths come from the Simple Icons and SVG Logos collections. Both
  collections publish these paths under CC0 1.0. Pi's compact mark comes from
  its official `pi.dev/logo-auto.svg` press asset. The source and license links
  stay beside the implementation so the asset provenance is reviewable.
- The set covers the supported named providers with available licensed marks:
  Claude, Codex, Devin, Grok, Kilo, Kimi, Mistral, OpenCode, Pi, Gemini,
  Copilot, Cline, Qwen, Ollama, and Azure AI Foundry. Image-provider kinds
  reuse their parent provider mark.
- Generic compatibility endpoints and future providers keep the truthful
  monogram or neutral Octant mark. A mark is never guessed from a display name
  and is never fetched from a provider website.
- Marks remain single-color in the renderer. Provider-specific color tokens may
  still theme a mark, while the shell and controls keep the application’s
  monochrome surface language.

## Consequences

- Settings rows, model-picker rails, thread metadata, and usage surfaces share
  one stable identity primitive with no network dependency.
- Adding another provider requires a reviewed path and source/license entry;
  unsupported or private endpoints remain clearly generic.
- The paths are trademarks of their respective owners. Octant presents them as
  provider identifiers and does not imply endorsement or ownership.

## Related

- 0016 Component foundation and theme
- 0073 One surface language across the renderer and the site
- 0094 Focus is quiet; selection carries state
