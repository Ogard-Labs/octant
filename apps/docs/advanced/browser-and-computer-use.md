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
browser diagnostic enters committed evidence. A kept screenshot is a separate
thread capture, described under Browser captures below; the journal holds only a
reference to it, never its bytes.

A new Browser starts with an empty address bar. In a Code thread it lists the
web servers running for that checkout, with any other running ones after them,
and fills in the first. Choose one to open it, or type another address.

The Browser pane provides an address bar, history controls, and the isolated
page. Lifecycle and stop controls remain visible when a session needs them.
The renderer requests lifecycle through authenticated routes; a denial creates
no observation or evidence.

### Browser captures

When the agent takes a screenshot with its Browser, or you press **Screenshot**
(the camera button in the Browser pane's toolbar), Octant keeps a copy with the
thread. **Refresh preview** does not keep one. A **Browser captures** strip
appears in the conversation beside any generated images, newest first, each
with the page title and its origin. Choose one to see it full size with its
address and time. The strip is absent until the thread has a capture.

- Only a screenshot is kept. The picture the agent receives after other actions,
  such as clicking or scrolling, is not.
- A thread keeps its newest 32 captures; the oldest is dropped when a new one
  arrives. Deleting the thread deletes its captures.
- Captures stay on this computer, in Octant's data folder. **Settings → Data &
  storage** lists **Browser captures** under Caches with where they are stored. They are not added to Canvases, shared,
  synced to your other computers, or included in diagnostics. Exporting a thread
  includes them: each capture is listed with its page title, address, and time,
  but not the picture itself. A paired device's export leaves them out.
- The page you captured counts as outside content: a thread that has looked at
  a page is already marked as having read outside content, and keeping a
  picture of it changes nothing about that.
- If a picture cannot be kept (too large, not a recognised image, a page with
  no web address, no picture from the Browser, or a storage problem), the
  screenshot still works. The agent is told the capture was not kept, the
  Browser pane says so when you pressed Screenshot, and nothing is added to the
  strip. The Browser gives no picture of a page it treats as sensitive, for
  example one with a password field.
- An archived thread still shows the captures it kept.

Links inside a Work or Code conversation open in the app: following one
creates a dedicated Browser context confined to that link's origin and opens
it in the thread's right dock, or in a split beside the pane when the dock
describes a different thread. Right-clicking a link offers **Open in Octant**,
**Open in external browser**, and **Copy URL**. Surfaces that cannot host a
Browser — Chat, dock tools, dialogs — keep the external open and copy.

### Agent control

Agent control is separate from manual Browser availability. A provider needs a
verified app-managed tool transport; an authenticated provider or a visible
Browser tab alone does not prove that transport works.

In a Work or Code composer, type `@Browser` and choose the structured
Browser mention to tell the selected agent to use Octant's built-in Browser.
The mention carries a host-owned selection; it never opens an origin or grants
approval by itself. The existing Browser tool still requests origin approval at
the first action that needs it. Chat does not offer Browser.

Where supported, Octant registers `octant_browser` when the provider session
starts. The agent does not need a separate browser skill, a debugging URL, or
a shell-launched browser. The tool can navigate, read page text, click and fill
CSS-selected elements, press a browser key, scroll horizontally or vertically,
wait for an element, take a screenshot, and stop its session. Page observations
include a revision that subsequent actions may use to refuse stale targets.

The tool's built-in guidance tells the agent to navigate, inspect the page,
act using the observed target and revision, and inspect the result to verify
success. The always-visible description stays short; the agent asks the tool's
`help` operation for the full usage when it needs it, as it can for Computer
use and Code's terminal, Apple, and Android tools. The same definition reaches
supported providers in Work and Code. Installing a browser skill or configuring a global MCP server is unnecessary.

Work and approval-gated Code tasks may request an isolated browser
session for an origin through an inline approval. This does not change the task to Full
access. Unsupported runtimes, expired grants, changed owners, and cancelled
requests are refused explicitly. Background tasks retain their own
browser when the visible pane changes within the same Project. Switching the
selected model requires a fresh origin approval before that model can use the
existing page.

The host supplies the tool transport automatically for supported runtimes:

| Runtime                    | Transport and current boundary                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Codex                      | App-server dynamic tools                                                                                                |
| Claude Code                | Agent SDK in-process MCP server                                                                                         |
| OpenCode                   | Private MCP profile on macOS, only on the releases whose isolation Octant verified: 1.18.21, 2.0.22 and 2.0.27, exactly |
| ACP runtimes               | HTTP MCP on macOS, when the runtime advertises and accepts it, or Octant verified that release accepts it               |
| Pi                         | Owned extension and verified CLI catalogue, only on the verified releases 0.85.1 and 1.1.0                              |
| Direct endpoints           | Only models whose tool use you verified                                                                                 |
| A CLI in a thread terminal | `octant mcp`, Browser only; see [Browser for a CLI in a terminal](/advanced/terminal-browser)                           |

A supported transport is checked before it is advertised. It does not require
editing a user's global MCP configuration or granting Full access. A runtime
or platform that cannot carry the tool within its confinement policy stays
unavailable; Linux OpenCode/ACP/Pi bridge support is not inferred from a macOS
check. Oh My Pi remains unavailable where its driver is probe-only.

Support follows the exact release, not the runtime's name. An OpenCode or Pi
release Octant has not verified still lists its models, but it reports Octant
tools as unavailable and the composers do not offer `@Browser`: an OpenCode
2.0.28 found on your `PATH` is one such release. A runtime whose connection
check cannot confirm its transport is treated the same way, and so is an ACP
agent that does not advertise HTTP MCP, unless Octant verified that exact
release accepts it anyway. Nothing is routed to another model or
provider in its place.

### When a Browser call does not go through

Each of these is a named, visible result; none of them leaves the agent
waiting or the page half-open.

- **You decline a site.** The call is refused as `browser-approval-denied`.
  Nothing loads, and the turn continues so the agent can say it could not open
  the page.
- **You stop the task while a site ask is waiting.** The ask is withdrawn, the
  page is never requested, and the task's Browser grant is released.
- **Octant restarts.** Browser contexts end with the host. The thread's next
  turn can use the Browser again, and asks again for any site you did not
  choose **Always allow** for.
- **You chose Always allow for a site.** It opens without asking, in Work and
  Code, until you forget it under **Settings → Permissions → Remembered
  websites**. Switching the thread's model still asks, because the remembered
  site covers the page, not who drives it.
- **The provider cannot carry the tool.** The composer does not offer
  `@Browser`. If you type it anyway, the turn is refused, or ends with a
  message that the Browser is unavailable for that provider.

## Computer use

Computer access requests show a compact, left-aligned approval card with the
server-provided application, task scope, and duration. **Deny** and **Approve once**
remain visible together; the activity footer does not repeat the approval status.

Typing targets an observed text field directly; a preceding background click to
focus the field is unnecessary. After an application restarts, request its current
window list rather than reusing earlier window IDs.

Computer use is a bundled plugin for the Apple Silicon macOS desktop app.
Choose **Computer** from the `@` picker in a Chat, Work, or Code composer, then
describe what to do. The selected Computer chip gives a supported provider
the `octant_computer` tool and instructions for using it. Ordinary text that
mentions a computer does not enable the tool.

Open **Settings → Computer use** to enable the plugin, set up Accessibility
and Screen Recording permissions, and check the installed CuaDriver version.
**Set up permissions** asks macOS for access and opens Screen Recording settings
if access is still missing. macOS may not show another permission prompt. Enable
Octant there; if it is absent, use **+** to add the installed Octant app. Relaunch
Octant after changing permissions, then choose **Recheck**. Recheck reads the
current state without requesting access. Each task asks before accessing an
application; **Allow app for 5 minutes** grants that
task temporary access. Plan mode, remote clients, unavailable permissions,
and unsupported provider transports refuse control.

The agent lists applications and windows, observes a chosen window, and uses
its numbered controls to click, type, navigate, or scroll in the background.
Image-capable models also receive screenshots and can use window-image
coordinates where supported. Each action returns a new observation to verify
the result. Protected fields and macOS permission controls remain for you to
operate. Use **Stop computer use** or disable the plugin to revoke access.

Octant bundles its own CuaDriver, including the native SDK, and does not require
a separate installation. **Automatic updates** is off by default. When you turn
it on, Octant checks upstream daily, verifies the publisher, checksum, architecture, and
driver compatibility, then upgrades after computer-use tasks finish. If the
replacement cannot start, Octant retains the previous verified driver. You
can use **Check for updates** in Settings at any time.
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

### Disposable desktops

On a Linux host, a Code thread can lease a throwaway Linux desktop to run what
it built. Open **Desktop** from the dock's **Add tool** (under Devices). The
desktop runs on this host with no network, no checkout, and nothing of the
host's; a file reaches it only when the agent sends one.

- **Start desktop** creates one. Octant does not ask again, because you
  started it; Plan mode refuses. A thread holds at most two, and the host runs
  at most two at once.
- While it is live, click the screen to use it: clicks, the wheel, and typing
  go to the desktop, and **Ctrl+Esc** (**⌘Esc** on a Mac) moves focus back out.
  The agent can use the same desktop at the same time; whatever either of you
  does is recorded as yours or the agent's.
- A desktop lasts 30 minutes. **Add 30 minutes** extends it up to four hours,
  and it is released after 15 minutes with no open tab and nobody using it.
  **Release** destroys it after you confirm.
- Closing the tab leaves the desktop running. A tab that comes back after a
  reload shows **Show desktop** instead of reconnecting by itself, and a
  desktop ended by a host restart shows as ended.
- **Still running** means Octant could not confirm the desktop is gone. It
  keeps trying, starts no new desktop on that provider meanwhile, and
  **Retry** tries again now.

A desktop on a cloud provider such as E2B runs on your own account and bills
it, so Octant asks you to confirm each one before it starts
it, even under Full access; the key stays on this host. This version does not
offer a cloud provider yet.

A paired phone or browser that can open the thread can watch and use its
desktop too.

#### Setting a desktop recipe

Desktop starts a desktop from the Project's **desktop recipe**. Until the
Project has one, the pane says so instead of offering **Start desktop**. To
set one, open the Code Project, then **Disposable desktop** → **Manage** in its
settings:

- **Provider** lists only the desktop providers this host has ready. On Linux
  that is this host itself, offered once Bubblewrap, Xvfb, xdotool, and
  ImageMagick are installed and Octant has restarted.
- **Screen** sets the desktop's size.
- **Lasts**, **Longest**, and **Idle** set how long a desktop lasts at first,
  the most it can be extended to, and how long it may sit unused. They start
  at 30 minutes, four hours, and 15 minutes.

**Set recipe** saves it; the next desktop uses it. The desktop never has
network access. **Remove recipe** asks first: removing it, or changing its
provider, ends the Project's running desktops. Only a window on the host
itself can set or remove a recipe; a paired phone or browser sees it but
can't change it.

## Picture in Picture

When an agent has a Browser open for a Work or Code thread and you cannot see
that Browser, Octant floats a small live picture of its active page over the
conversation. It is a preview, not a second Browser: it takes no authority over
the page.

- It appears only while the thread's Browser is out of sight, and it goes away
  the moment the Browser opens, whether as a pane, a dock tab, or in the bottom
  panel. Closing the Browser brings it back.
- Click the preview to open the Browser. Point at it or focus it with the
  keyboard to see the page's title or host and a close control. Closing the
  preview hides it for that session only; the next session shows it again.
- Before the first picture arrives it shows a blank placeholder. When the
  session has more than one page open, it shows the active one with a count.
- Drag it to any corner and it stays there. With the keyboard, focus the
  preview and press an arrow key to send it to that side. Its bottom corners
  rest above the composer, never over it.
- Octant captures the page only while the preview is on screen, pauses while
  the window is hidden, and looks less often while the page does not change.

When agent-owned Browser activity first appears, Octant opens the same
thread-owned Browser tab once; a preview then covers it after you close it.
Computer use keeps its own compact card: the Code Environment panel has a
**Picture in Picture** control for showing or hiding that card, hiding it
changes presentation only, and approvals stay visible when they need a
decision. Neither preview lives inside Environment or opens a separate OS
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
