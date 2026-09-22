# 0158. Thread titles and composer location

**Status:** Accepted

## Context

Pane headers repeat project identity beside thread names and separate active
provider chrome from the content tabs. Work follow-up composers lack the location
strip already available in Code.

## Decision

- Workspace content and dock tool tabs share one compact recipe for height,
  spacing, selected state, and close controls.
- Pane headers name each thread once. Project and folder details belong with the
  composer, not beside the title. A multi-content strip keeps a quiet drag handle;
  the selected tab owns its background and close action. Other close actions appear
  on hover or keyboard focus, and remain visible on touch devices.
- Work uses the shared follow-up composer context slot to show its project and
  working folder. A root path is displayed only when the thread's binding revision
  matches the available project snapshot. Missing metadata never supplies another
  project's folder. The strip remains mounted while metadata loads.
- Work gains no branch controls or Git authority. Code retains its checkout,
  branch, diff, and pull-request controls. Tab selection, closing, and dragging
  retain the existing navigation and authorization behavior.

## Scope

This extends 0098's attached context strip to Work and refines 0156's title-row
presentation. Their message layout, navigation lifetime, and authority rules
remain unchanged.

## Consequences

Location is read beside the message it applies to, leaving compact title-only
navigation in narrow split panes. Full folder paths remain available in tooltips.
