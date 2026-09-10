---
description: Host-owned isolated browser contexts and host-controlled computer use with server-authoritative policy.
---

# Browser and Computer Use

Octant provides host-owned browser and computer-use surfaces with
server-authoritative policy. Neither surface grants authority by itself; every
action is re-authorized before any effect.

## Browser

Open **Browser** from a Work or Code thread's tool launcher. The host requires
exactly one owning thread before it can create an isolated context.

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

The Browser pane provides an address bar, history controls, and the isolated
page. Lifecycle and stop controls remain visible when a session needs them.
The renderer requests lifecycle through authenticated routes; a denial creates
no observation or evidence.

### Agent control

Agent control is separate from manual Browser availability. A provider needs a
verified app-managed tool transport; an authenticated provider or a visible
Browser tab alone does not prove that transport works.

In any Chat, Work, or Code composer, type `@Browser` and choose the structured
Browser mention to tell the selected agent to use Octant's built-in Browser.
The mention carries a host-owned selection; it never opens an origin or grants
approval by itself. The existing Browser tool still requests origin approval at
the first action that needs it.

Where supported, Octant registers `octant_browser` when the provider session
starts. The agent does not need a separate browser skill, a debugging URL, or
a shell-launched browser. The tool can navigate, read page text, click and fill
CSS-selected elements, press a browser key, scroll horizontally or vertically,
wait for an element, take a screenshot, and stop its session. Page observations
include a revision that subsequent actions may use to refuse stale targets.

The tool's built-in guidance tells the agent to navigate, inspect the page,
act using the observed target and revision, and inspect the result to verify
success. The same definition reaches supported providers in every mode.
Installing a browser skill or configuring a global MCP server is unnecessary.

Chat, Work, and approval-gated Code tasks may request an isolated browser
session for an origin through an inline approval. This does not change the task to Full
access. Unsupported runtimes, expired grants, changed owners, and cancelled
requests are refused explicitly. Chat keeps its virtual scope: Browser access
adds no filesystem or shell authority. Background tasks retain their own
browser when the visible pane changes within the same Project. Switching the
selected model requires a fresh origin approval before that model can use the
existing page.

The host supplies the tool transport automatically for supported runtimes:

| Runtime          | Transport and current boundary                                  |
| ---------------- | --------------------------------------------------------------- |
| Codex            | App-server dynamic tools                                        |
| Claude Code      | Agent SDK managed tools                                         |
| OpenCode         | Private MCP profile, verified on 1.18.21 with macOS confinement |
| ACP runtimes     | HTTP MCP when the runtime advertises and accepts it             |
| Pi               | Owned extension and verified CLI catalogue on 0.85.1            |
| Direct endpoints | Only models with verified tool support                          |

A supported transport is checked before it is advertised. It does not require
editing a user's global MCP configuration or granting Full access. A runtime
or platform that cannot carry the tool within its confinement policy stays
unavailable; Linux OpenCode/ACP/Pi bridge support is not inferred from a macOS
check. Oh My Pi remains unavailable where its driver is probe-only.

## Computer use

Computer use is a bundled plugin for the Apple Silicon macOS desktop app.
Choose **Computer** from the `@` picker in a Chat, Work, or Code composer, then
describe what to do. The selected Computer chip gives a supported provider
the `octant_computer` tool and instructions for using it. Ordinary text that
mentions a computer does not enable the tool.

Open **Settings → Computer use** to enable the plugin, set up Accessibility
and Screen Recording permissions, and check the installed CuaDriver version.
macOS may require you to relaunch Octant after changing permissions. Each task
asks before accessing an application; **Allow app for 5 minutes** grants that
task temporary access. Plan mode, remote clients, unavailable permissions,
and unsupported provider transports refuse control.

The agent lists applications and windows, observes a chosen window, and uses
its numbered controls to click, type, navigate, or scroll in the background.
Image-capable models also receive screenshots and can use window-image
coordinates where supported. Each action returns a new observation to verify
the result. Protected fields and macOS permission controls remain for you to
operate. Use **Stop computer use** or disable the plugin to revoke access.

Octant bundles its own CuaDriver, including the native SDK, and does not require
a separate installation. **Automatic updates** is enabled by default: Octant
checks upstream daily, verifies the publisher, checksum, architecture, and
driver compatibility, then upgrades after computer-use tasks finish. If the
replacement cannot start, Octant retains the previous verified driver. You
can turn automatic checks off or use **Check for updates** in Settings.
Checks send no task content or identifiers.

When a session is active it renders the
**Computer use** lifecycle pane (eyebrow **Host-controlled computer use**)
and, for the owning Work or Code thread, a **Computer Use** activity
preview.

Application allowlists, sensitive-field protection, and scoped approvals
bound to the task's authority govern every action before any effect.

The lifecycle pane exposes:

- **Allow app for 5 minutes** and **Deny** while plugin access is pending
- **Approve once** for other one-time host actions
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

## Picture in Picture

Active Work and Code threads show a compact activity preview over the main
conversation. The Code Environment panel has a **Picture in Picture** control
for showing or hiding that preview. Hiding it changes presentation only; it
does not stop the browser or computer-use session.

Point at the preview or focus it with the keyboard to reveal its controls.
A browser preview opens the same thread-owned Browser tab. Stop remains
available, and computer-use approvals stay visible when they need a decision.
The preview does not live inside Environment and does not open a separate OS
window.

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
