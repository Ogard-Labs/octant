---
description: Host-owned isolated browser contexts and host-controlled computer use with server-authoritative policy.
---

# Browser and Computer Use

Octant provides host-owned browser and computer-use surfaces with
server-authoritative policy. Neither surface grants authority by itself; every
action is re-authorized before any effect.

## Browser

Browser surfaces open from a Work or Code thread via **Open surface →
Browser**. The
host requires exactly one owning thread before it can create an isolated
context.

- Each context is an isolated incognito context scoped to exactly one owning
  thread (thread, host, mode, Project or root, provider, action, correlation,
  and window authority are re-resolved server-side before any effect).
- An **origin allowlist** governs navigation; an empty allowlist fails
  closed. Disallowed origins and redirects, popup tabs, and cross-thread or
  cross-window use are denied.
- **Credential-field protection** is always on: password and credential
  fields are blocked.
- Session settings include a max concurrent tab count and a session timeout
  (5 minutes in the interface).

Observations are bounded: each entry renders only the title, URL, a SHA-256
content hash, and a correlated-evidence count. No launch token, window
capability, provider credential, typed value, page body, screenshot, or raw
browser diagnostic enters committed evidence.

The browser pane exposes lifecycle controls — **Start browser**, **Go**,
**Stop**, and **Cancel** — plus **Click** and **Type** actions against a
**Selector**, and an optional **Value**. Statuses are `ready`, `waiting`,
`running`, `stopped`, `unavailable`, `failed`, `interrupted`, and `stale`.
There is no network start-control route; the renderer requests lifecycle
through authenticated routes only, and denials produce no observation or
evidence.

## Computer use

Computer use is its own host-owned macOS surface, not the Apple workbench's
Simulator interaction path. When a session is active it renders the
**Computer use** lifecycle pane (eyebrow **Host-controlled computer use**)
and, for the owning Work or Code thread, a **Computer Use** activity
preview.

Application allowlists, sensitive-field protection, and scoped one-time
approvals bound to host, Project, thread, provider, action, and client
govern every action before any effect.

The lifecycle pane exposes:

- **Approve once** and **Deny** while a one-time approval is pending
- Visible **Stop computer use** while the session is waiting for approval,
  running, or stopping (the thread activity preview labels the same stop
  **Stop Computer Use**)
- A **Computer-use lifecycle evidence** list
- States: Waiting for approval, Running, Stopping, Stopped, Expired,
  Interrupted, Failed, Completed
- **Retry** when the host lifecycle is unavailable, failed, or interrupted

Using computer use as the Apple workbench fallback for UI that lacks a
structured tool — with the next accessibility snapshot, screenshot, log, or
assertion verifying a tap — is not yet built. Today that workbench offers
Simulator screenshots, destination controls, and the `octant_apple` tool;
see [Apple Development Workbench](/advanced/apple-workbench).

## Boundaries

Browser and computer use are provider-neutral and app-managed. Interactive
accessibility-permission QA on a visible macOS fixture remains a manual
review step. The broader browser and computer-use program is progressing
toward the technical preview and does not depend on any provider or
extension.

## Next steps

- [Apple Development Workbench](/advanced/apple-workbench) for validation workflows
- [Privacy and security](/advanced/privacy-and-security) for isolation and evidence policy
- [Plugins and skills](/advanced/plugins-and-skills) for extension authority
