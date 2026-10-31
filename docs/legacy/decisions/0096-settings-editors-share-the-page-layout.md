# 0096. Settings editors share the page layout

**Status:** Accepted

## Context

A maintainer review on 2026-09-08 found that Settings still mixed open rows with
large rounded provider editors and repeated notice cards. Expanding a preference
changed its visual language, and verbose save labels displaced the fields.

## Decision

- All Settings sections and inline editors use the same flat page ground,
  section labels, hairline separators, and aligned control edge. This includes
  provider configuration and profile preferences.
- Expanded provider details continue beneath their identity row without a
  containing card. Related configuration fields use compact Save controls;
  accessible names retain the provider and setting being saved.
- Routine guidance is inline text. Errors retain their alert semantics, while
  credentials, approvals, and provider capability limits remain explicit.
- Theme previews, install/trust reviews, confirmation dialogs, and floating
  menus retain their meaningful object boundaries. Background and theme
  preferences are unchanged.
- Model visibility changes must not trigger provider rediscovery merely because
  the last visible model was hidden. Editing must preserve local form state.

This supersedes the provider-instance and inline setup elevation exceptions in
0072 and 0073. Their collection, typography, theme, and authority rules remain.

## Consequences

Shared Settings recipes define the layout for every page. A new editor does not
need a separate opt-in class to match its surrounding preferences.

## Related

- 0072 Settings collections stay open
- 0073 One surface language across the renderer and the site
- 0090 Recipes own their shape
- 0094 Focus is quiet; selection carries state
