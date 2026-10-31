# 0128. Workspace background owns a covered sidebar

**Status:** Accepted

## Context

An everywhere background can cover the sidebar while separate sidebar image,
gradient and overlay controls remain active. Both decorations then compete,
and Settings does not explain which one is visible.

## Decision

This is a scoped exception to 0091's rule that a covered sidebar composites its
own decoration above the application ground. All other rules in 0091 remain.

When an active everywhere background covers the sidebar, omit the separate
sidebar background layer. Disable its decoration controls with an explanation
that turning off Cover the sidebar restores them. Keep the saved values intact.

A welcome-only background, no background, or increased contrast does not suspend
sidebar decoration. Native material and accessibility behavior retain their
existing contracts. No stored settings are reset by changing background scope.

## Consequences

Settings and shell rendering follow the same effective background state. A user
can switch between shared and separate backgrounds without losing either setup.
