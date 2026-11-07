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

- A new context is Private unless you approve a Project or Personal profile.
  Each context is scoped to exactly one owning
  thread (thread, host, mode, Project or root, provider, action, correlation,
  and window authority are re-resolved server-side before any effect).
- An **origin allowlist** governs navigation; an empty allowlist fails
  closed. Disallowed origins and redirects, popup tabs, and cross-thread or
  cross-window use are denied.
- **Credential-field protection** applies to fixed actions and readers:
  they refuse password entry and redact protected values. Full-access scripts
  have the separate DOM/account authority described below.
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

In Plan mode the agent can still look at the page already open in its thread's
Browser: take a snapshot, read its text, take a screenshot, read what it
logged and failed to load, audit its accessibility or performance, list its
tabs, wait for it to reach a state, list the Project's saved flows, and stop
the Browser. It cannot open a page or tab, click, type, scroll, resize, switch
or close a tab, upload, save a download, sign in, run a script, record, or save
or run a flow. You are still asked about a site
or a model you have not allowed, even for a read.

### Recovering the agent's page

If the agent's Browser reaches a site the page has not approved, the tool's
refusal explains how to recover: stop the page, then navigate to the intended
site and request its approval. Keep the same Project or Personal profile when
reopening if you need its sign-in. For an SSO redirect in the Octant app, the
agent can use **sign-in** so you finish signing in yourself. If you press
**Continue** while still on an unapproved site, the answer says so and the
agent cannot read that page.

An expired page reports **context-expired** with the profile it used. It never
reopens on its own. The agent must navigate explicitly, naming the same profile
again for Project or Personal. A new page with no profile argument still opens
Private. The recovery hint contains no page text, picture, password, or account
detail and is kept only temporarily in the host's bounded memory.

The agent's page stays open while the agent or you use it, and closes after ten
minutes without that activity. Watching the page or its preview does not keep
it open. Sign-in or Take over keeps it open for eleven minutes from the handoff
or your latest take-over input, then two minutes after Continue or Hand back,
using whichever deadline is later than the ordinary idle deadline.

A Work or Code agent can request a Project or Personal profile. You can also
choose a **Default browser profile for this task**; the agent's new pages then
open in it until you change it. The default grants no access: Octant still asks
you before the agent uses a site in a signed-in profile.

### Browser profiles

A Browser page is **Private** by default: its cookies and site data live in
memory and are forgotten when the page closes. To stay signed in to a site,
choose a profile from the control at the left of the address bar:

| Profile      | Kept                            | Shared by                                         |
| ------------ | ------------------------------- | ------------------------------------------------- |
| **Private**  | Until the page closes           | That page and the tabs it opens                   |
| **Project**  | On this Mac, until you sign out | Every page of this Work or Code Project           |
| **Personal** | On this Mac, until you sign out | Every page, in any Project, that chooses Personal |

- Sign in manually or approve a selected-item brokered fill through **Login
  permission**. Fill and submit are separate approvals; neither confirms
  authentication. Choosing another profile opens the same address again as a new page in
  that profile; the old page closes and nothing it held carries over.
- The control remembers your last choice for each Project, for pages you open.
  It never changes a page the agent opened.
- Project and Personal pages open only in the Octant app's own Browser. On a
  host without the app they are refused with a message, never opened in a copy
  that would disagree about who is signed in. Chat has no Browser, so it has no
  profile.
- **Sign out of this profile…** in the control's menu, or **Settings → Data &
  privacy → Browser profiles**, closes every page of the profile and removes its
  cookies, site storage, and cache after you confirm. The Settings list shows
  each profile's size. Profiles are never in an export, a Canvas share, sync, a
  backup, or diagnostics.
- Purging a Project removes its profile with the Project's other data. Archiving
  a Project closes its profile's pages and keeps the profile.

**Import cookies from another browser.** In **Settings → Data & storage →
Browser profiles**, **Import cookies…** on a Project or Personal profile copies the
cookies of one profile of a browser installed on this Mac (Chrome, Chromium, Brave,
Edge, Vivaldi, Arc, or Firefox) so you stay signed in. Nothing is read until you
pick a browser and profile and press **Import**. For a Chromium-family browser
macOS then asks whether Octant may read that browser's cookie key from your
Keychain; if you decline, nothing is imported and Octant says so. The cookies go
only into that profile, on this Mac: they are not uploaded, logged, exported, or
shown to an agent, and Octant records only the browser, its profile, and how many
cookies arrived. Expired and malformed cookies are left behind and counted. To
bring only one website's sign-in, choose **One website only** and type the site,
such as `github.com`: Octant then imports just that site's cookies and its
parent domains', and leaves every other cookie unread.
**Clear cookies…** removes a profile's cookies and keeps its other data.

**What the agent may do on a signed-in page.** A Project or Personal page is
treated as signed in, because Octant cannot tell. A Work or Code agent can ask for one by
passing `profile` (`project` or `personal`) when it opens a page. Octant asks
you first, naming the site and the profile: "Let the agent use github.com in
the Personal profile?" Choosing **Always allow** remembers that site for that
profile only, under **Settings → Permissions → Remembered websites**. A site you
allowed Private does not cover a signed-in page, and one profile's grant does
not cover another. A routine, a subagent, or a CLI typed into a thread terminal
cannot open a signed-in page, and neither can a paired phone or browser, which
sees only "Signed-in page — open it on this Mac." If a turn you started from
your phone needs such a site, its question waits for a window on this Mac. While
the agent drives a signed-in page, the Browser's status label and the floating
preview name the profile. Plan mode allows only reads of the page already open,
as above, and fixed readers keep password and one-time-code values protected.

### Synchronous page scripts

For a local native Code page already at **Full access**, the agent can use
`run-script` when the fixed actions cannot express the task. It supplies source
and the revision from a fresh page read. Existing site/profile approval still
applies; no additional script prompt appears. Work, headless, paired, routine,
subagent, terminal and Plan callers are refused. Scripts below Full access are
currently unavailable because Octant cannot establish whether a Private page
is signed in. Private means temporary storage, not a signed-out account.

A script has normal page DOM and account access. It can read values a form
populated or reflected and install callbacks that survive the call. Those
values can reach the requesting provider. The fixed-reader and credential
broker protections do not make arbitrary scripts unable to observe passwords.
The page's main-world CSP does not constrain isolated-world script execution.

Source is limited to 8KiB UTF-8 and native execution/serialization to 150ms.
Results are synchronous and bounded, and may be truncated. Promises, functions
and DOM handles are unsupported results. There is no Node, Electron IPC, host
filesystem or raw debugging access. Scripts cannot run in batches or flows.
Read the page again after possible effects before reusing refs or revisions.

Fill/private credential use and scripts exclude each other while held. An
uncertain result means execution could have affected the page; cancellation
cannot undo it or remove callbacks. If a native connection failed, agent reads
may remain held until the actual context ends. Stop that owned Browser page to
retire it before opening another; this does not clear profile cookies or data.

### Browser extensions

Extensions add features to pages, such as a reading tool or an ad blocker. They
work in the Octant app on this Mac, in a Project or Personal profile, and never
in a Private page. They are off until you turn them on, and an extension can
read and change the pages it runs on, including what the agent reads there.

- **Install** from **Settings → Data & storage → Browser extensions → Install
  extension…**, then choose an unpacked Manifest V3 extension folder. Octant
  copies the folder, so later edits to it change nothing; choose the folder again
  to update. There is no web store, and extensions that need native messaging
  (most password managers) or a store sign-in do not work.
- **Import from another browser** with **Import from another browser…** next
  to it. Pick Chrome, Chromium, Brave, Edge, Vivaldi, or Arc, one of its
  profiles, and an extension. Octant copies the extension into its own folder and
  never opens that browser's profile. It arrives off, like any install. Extensions
  that use the older Manifest V2 format or need native messaging are listed with
  the reason and cannot be picked. Some extensions may not work in Octant even
  when they import.
- **Enable** an extension for one profile at a time. Octant lists in plain words
  the sites it can read and change and the permissions it asks for, and enables
  it only when you confirm. An update that asks for more than the version you
  allowed turns off everywhere and asks again, showing only what is new.
- **Use** an extension from the puzzle-piece button in the Browser toolbar,
  which appears when one is on in the page's profile. Choose an extension to open
  its popup or options page. An extension with no popup gets a click instead, as
  it would from a toolbar icon. While the agent drives the page, the button shows
  how many extensions are on, and the agent's site question says so.
- **Remove** turns an extension off in every profile and deletes its copy.
- Only you, at a window on this Mac, install or enable extensions. The agent,
  plugins, skills, and a paired phone cannot; a phone can see the list.
- Extensions that call parts of the browser Octant does not provide fail inside
  the extension. `chrome.tabs` works for what a popup needs: it sees only the
  pages of the same profile in the same window, shows page addresses and titles
  only to an extension that asked for the `tabs` permission, and opens or changes
  a page only on a site the page already allows.

### Browser captures

When the agent takes a screenshot with its Browser, or you press **Screenshot**
(the camera button in the Browser pane's toolbar), Octant keeps a copy with the
thread. **Refresh preview** does not keep one. A **Browser captures** strip
appears in the conversation beside any generated images, newest first, each
with the page title and its origin. Choose one to see it full size with its
address and time. The strip is absent until the thread has a capture.

- Only a screenshot, or a [recording](#browser-recordings) the agent asked for,
  is kept. The picture the agent receives after other actions, such as clicking
  or scrolling, is not.
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
- A capture of a page in a Project or Personal profile names the profile, because the picture can show an account.
- An archived thread still shows the captures it kept.

#### Browser recordings

To show what a change does, the agent can record a short check: it runs a few
Browser steps, or replays a saved flow, and asks for a recording of that call.
Octant keeps an animated picture of the page while the call ran, as a capture
of the thread. Ask the agent to "record the check" when you want one; it never
records on its own.

- In the strip a recording shows its first frame with a play mark and its
  length. Choose it to watch it play; **Stop** and **Play** sit under it. With
  reduced motion turned on (in your system settings or in Octant), it waits
  for **Play**.
- A recording lasts at most 30 seconds, takes up to 4 frames a second, is at
  most 800 pixels on its longer side, and at most 2 MB. It stops early at any
  of these, when the page is resized, and when another tab comes to the front,
  and says so under the picture. A recording shows only the tab it started on
  and is listed under that tab's address.
- A page with a password or other credential field on screen is never recorded:
  its frames are left out, and a recording of nothing else keeps nothing.
- Only the sites you approved for the agent's page are recorded. If the page
  shows any other site (for example because you took it somewhere else while
  the agent worked), a blank page, or an error page, those moments are left
  out the same way.
- If you take over the page, or the agent asks you to sign in, while it is
  recording, nothing of what you do is kept.
- Recordings follow every capture rule above: they stay on this computer, count
  toward the thread's 32 captures, are not sent anywhere, and a paired device
  cannot see them. The agent cannot record in Plan, and a recording already
  running when Plan begins is stopped and not kept.
- A thread keeps at most 8 recordings. A newer one replaces the oldest
  recording; your screenshots are never dropped to make room.

#### Browser proof

Octant also keeps a short record of the steps the agent took in its Browser, at
most the last 50 per thread. A **Browser proof** panel appears under the
captures strip (folded: choose **Show N steps**). It lists the steps as a
numbered list, for example `click button "Save" on https://example.com/settings`,
with what changed, or why a step failed, and puts each screenshot under the step
that took it.

- A step records the action, the element it acted on by role and name, the
  page's address without its query, and the result. It never records what the
  agent typed, a field's value, or a page's text.
- Only the agent's own steps are recorded, not what you do in the pane.
- The record stays on this computer with the thread and is deleted with it. It
  is not sent anywhere, and a paired device cannot see it.
- **Save screenshots…** (in the Octant desktop app) asks you for a folder and
  writes the thread's captures there as `browser-check-01.png`, `-02`, and so
  on. It never replaces a file that is already there. When the thread has a
  recording the button reads **Save screenshots and recordings…**: a recording
  is saved in the same numbered run as an animated `.png`, which GitHub plays
  when you drag it into a pull request description.
- To put the steps in a pull request, see [Code threads](../guide/code.md): the
  **Include Browser proof** choice there is off unless you turn it on.

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

You do not pick the Browser in the composer. In Work and Code, every turn whose
provider can carry Octant's tools is offered the Browser, and the agent uses it
when your request needs a web page: ask "check the pricing page on
example.com" and it browses. Being offered the tool opens nothing and approves
nothing: the first time the agent acts on a site, Octant asks you. Chat does
not offer Browser.

Where supported, Octant registers `octant_browser` when the provider session
starts. The agent does not need a separate browser skill, a debugging URL, or
a shell-launched browser. The tool can navigate, take a snapshot of the page,
read page text, click and fill elements, hover over a menu, choose an option
in a list, drag one element onto another, press a key or a shortcut such as
Control+A, scroll horizontally or vertically, wait for an element, open and
switch between tabs, take a screenshot, audit the page's accessibility or
performance, and stop its session.

The agent can also put files into a page's file field, for example to attach a
report to a form. It may only send files from the thread's own folder (the
Project folder in Work, the checkout in Code), never a linked file or one
outside that folder, and Octant asks you every time, naming each file and the
site: **Upload once** or **Deny**. There is no "Always allow" for uploads.

Downloads are blocked by default. To let agents download files, turn on **Let
agents download files** in Settings → Permissions; only you can, from a window
on this computer, and a phone, a routine, a subagent or the agent itself cannot.
With it on, a file a page starts downloading while the agent drives it is held
on this computer, outside your project, and the agent tells you its name, size
and type. Nothing reaches your project until the agent asks to save it and you
agree: Octant asks every time, for example "Let the agent save report.pdf
(1.2 MB, PDF) from https://example.com into this thread's workspace?", and
there is no "Always allow". A saved file goes into a `downloads` folder at the
top of the thread's own folder, never over a file that is already there (a
second `report.pdf` becomes `report (2).pdf`). Octant stops files over 25 MB,
keeps at most five held at a time, and refuses programs and installers (such as
`.exe`, `.dmg`, `.pkg`, `.sh`) even if they are renamed. Held files are deleted
when you answer, when the page closes, and when Octant starts. Downloads you
start yourself in the Browser pane stay blocked.

A snapshot is a short outline of the page: its headings, text, and controls,
each control with a reference such as `e4` the agent passes back to click or
type there. A password or one-time-code field appears as protected, and the
outline never shows what is typed in it; on a sign-in page no field's value is
shown. Octant keeps the references itself and refuses one that no longer
matches the page, so the agent snapshots again instead of acting on the wrong
element.

The outline includes what sits inside frames and inside web components (open
shadow roots), and the agent can act there by reference too. Password fields
stay protected in every frame. On a page in a Project or Personal profile, a
frame from another website is left out unless you approved that website for
the profile, because it may be signed in to your account there.

After a click, typing, or another action, the agent hears back the page's
address and title and one line on what changed, such as a new title or
changed text. It gets the page's text, a picture, or a fresh outline only when
it asks for them, which keeps each step small. Octant takes no picture of the
page the agent did not ask for; the activity preview still shows the page,
because it takes its own.

The agent can wait for text to appear, an address to change, or a button to
become enabled, for at most 30 seconds, and every action waits a moment for the
page to settle before it reports back. If a page shows its own alert, Octant
accepts it; if it asks to confirm something or to type an answer, Octant
declines. The agent is told about each one.

The agent can also test how a page looks on another device. It can resize its
page to a phone, a phone held sideways, a tablet, or a desktop, or to a size it
picks. On a phone or tablet the page also sees a touch screen, and the agent's
clicks reach it as taps. It can turn touch on or off by itself, and switch the
page between light and dark mode. When it is done, one resize with nothing
else puts the size, touch, and color scheme back. This changes only the agent's
own page. Your own Browser window and your other pages keep their size and
look, and a page you opened developer tools on keeps its touch and color
scheme as they are. The agent is told what the page now reports.

While you build a web app, the agent can audit the page it has open. An
accessibility audit finds images without a text alternative, buttons, links,
and form fields without a name, a missing page title or language, skipped
heading levels, repeated ids that labels point at, text with too little
contrast, focusable elements hidden from screen readers, and, after the agent
switches the page to a phone, touch targets that are too small and too close
together. Each problem names the element so the agent can go and fix it. A
performance audit reports how the page loaded: time to first byte, first and
largest paint, layout shift, and blocking time, each rated good, needs
improvement, or poor, with the requests by type and the largest files (their
addresses with secrets removed). An audit only reads the page: it never
reloads it, so to measure a fresh load the agent opens the page again first.
Audits run on this computer and send nothing anywhere, and Plan mode allows
them, since an audit only reads the page already open.

When a page needs you to sign in, the agent can hand it to you instead of
giving up. A card in the thread says which site and why, with **Continue** and
**Cancel**, and the Browser comes forward. Sign in on the page yourself; the
agent waits and never sees what you type. Press **Continue** and the agent
picks up from the page you left. A routine, a subagent, a program in a
terminal, or a turn started from your phone cannot ask this.

You and the agent can use the same page. If you type or click while the agent
is working, your keys and clicks go through; nothing is dropped. The agent is
told that you used the page, and it will not click or type again until it has
looked at the page afresh, so it never writes over what you were typing.

To work on the page without the agent, press **Take over** in the Browser's
toolbar. The agent's Browser calls are refused while you have the page, and the
toolbar says "You have the page". Press **Hand back** when you are done; the
agent's next step is answered with a fresh look at the page you left. These toolbar
controls are local: a turn started from your phone,
a routine, a subagent, or a program in a terminal cannot. If you walk away, a
page you took over closes after 11 minutes without use, like any other page.

### Use an open page from an owner browser

An enrolled owner browser can control an already-open **Code Private** page on
the host Mac. Keep that page visible in its original Octant window. Open that
host's own web app and go to **Settings → Remote access → Hub**, then find
**Owner Browser** for that host. This requires an owner identity and passkey
already confirmed on the host; ordinary paired access is not enough.

Choose **List open pages**, check the exact thread, site and Private profile,
then **Unlock and take over** for that page. This always asks for a fresh owner
unlock, even if you opened an administration session. Control lasts at most
60 seconds and names the active owner on both screens.

The frame is for you and may show account content or credentials. Octant does
not save it as a screenshot, send it to the agent, or put it in the journal.
Tap a point in the picture, use the key or scroll buttons, or type into the
masked text box and choose **Type text**. The box clears after you send it.
Each input needs a current frame. A changed page, tab or viewport ends that
target's control; list and unlock the current page again.

**Stop remote control** leaves the page held for a person. **Hand back to the
agent** explicitly releases that hold, and the agent must read the page again
before acting. At the host Mac, **Reclaim locally**, or local page input, stops
remote control while preserving local use. An input already sent may have taken
effect; Octant never retries it automatically or claims it was undone.

Hiding or leaving the owner view aborts its pending requests and sends a stop
without another unlock. If the host cannot be reached, its finite control lease
can remain until expiry. The page still stays held for a person after expiry.
An unsettled native input cannot be treated as a confirmed handback. Finish on
the host Mac when a device-local authenticator, popup or unsupported form needs
it. Work, stored profiles, embedded or hidden pages, headless pages, transfers,
new tabs and address navigation are not part of this control path.

To find out why a page misbehaves, the agent can read the page's console
errors (and warnings if it asks), requests that failed, and requests that came
back with an error status such as 404 or 500. It sees only the address and the
status, never the content or headers, and reading leaves the list in place for
the next look.

The agent can send up to 10 of these steps in one call, such as filling three
fields and pressing Save. Octant checks each step on its own, exactly as if it
came alone, and stops at the first one that fails.

The tool's built-in guidance tells the agent to navigate, take a snapshot, act
by reference, and inspect the result to verify success. The always-visible description stays short; the agent asks the tool's
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
| Pi                         | Owned extension and verified CLI catalogue, only on 0.85.1 and 1.1.0 or later, when the probe attests it                |
| Direct endpoints           | Only models whose tool use you verified                                                                                 |
| A CLI in a thread terminal | `octant mcp`, Browser only; see [Browser for a CLI in a terminal](/advanced/terminal-browser)                           |

A supported transport is checked before it is advertised. It does not require
editing a user's global MCP configuration or granting Full access. A runtime
or platform that cannot carry the tool within its confinement policy stays
unavailable; Linux OpenCode/ACP/Pi bridge support is not inferred from a macOS
check. Oh My Pi remains unavailable where its driver is probe-only.

Support follows the exact release, not the runtime's name. An OpenCode or Pi
release Octant has not verified still lists its models, but it reports Octant
tools as unavailable and its turns are not offered the Browser: an OpenCode
2.0.28 found on your `PATH` is one such release. A runtime whose connection
check cannot confirm its transport is treated the same way, and so is an ACP
agent that does not advertise HTTP MCP, unless Octant verified that exact
release accepts it anyway. Nothing is routed to another model or
provider in its place.

### Saved flows

When the agent has done a check once, it can save it as a flow in the Project
and repeat it later without working out each step again. Ask, for example, "save
that as a flow called Order check", and later "run the Order check flow". A flow
is a fixed list of the steps the agent took, with the element each one used
described by its role and name, and the page address path and title expected
after each step. It holds no page text and no script.

Each step of a replay is checked as if the agent had made it by hand: you are
asked about a site you have not allowed, Plan mode refuses it, and a page that
needs your sign-in is never part of a flow. The replay stops at the first step
that fails, finds no single matching element (a button that changed its name,
say), or leaves the page at a different address or title than before, and the
agent tells you which step and what it found instead. A routine can run a flow on
a private page but cannot save one, and a turn started from your phone can do
neither.

Settings › Data & storage › Browser flows lists the flows of every Project with
their step count and starting address. Run asks you to choose an existing idle
Work or Code task in that Project, then review its model, access, profile and
fixed steps. You can edit the text of a type step and a recorded expected title for this run without
changing the saved flow. If your new text changes the expected page title,
review that title too; Octant does not guess substitutions or skip the check. Run fixed steps starts it; the ordinary site and profile
approvals still apply. Plan and server Projects cannot use this local runner.

The dialog shows progress. If the person holds the page before a step runs,
hand it back and choose Resume. Changes to the flow, task authority, profile or
site approval require a new review. Other failures stop without retrying an
uncertain action. Closing the dialog stops an active run; an operation already
sent to the page may have acted. Runs expire after 15 minutes. Delete still asks
for confirmation. A saved flow stays on this Mac with its Project, goes when
the Project is erased, and is not part of a thread export.

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
- **The provider cannot carry the tool.** Its turns are not offered the
  Browser, so the agent answers without it and can say it could not browse.

## Computer use

Computer access requests show a compact, left-aligned approval card with the
server-provided application, task scope, and duration, the agent's own reason
for the action when it gave one, and any outside content the task has read.
**Deny** and **Approve once** remain visible together; the activity footer does
not repeat the approval status.

Typing targets an observed text field directly; a preceding background click to
focus the field is unnecessary. After an application restarts, request its current
window list rather than reusing earlier window IDs.

Computer use is a bundled plugin for the Apple Silicon macOS desktop app. You
do not pick it in the composer: while it is on, every Chat, Work, or Code turn
on a supported provider is offered the `octant_computer` tool, and the agent
uses it when your request needs an app, as in "open Notes and add today's
list". Being offered the tool controls nothing. Plan mode, a provider without
Octant's tools, or the plugin turned off offers no tool at all.

The first time the agent acts on an app in a task, Octant asks you, even when
the task has Full access. After the task has read outside content, such as a
web page, every action asks again, one action at a time, and the card names
what the task read.

Open **Settings → Computer use** to enable the plugin, set up Accessibility
and Screen Recording permissions, and check the installed CuaDriver version.
**Set up permissions** asks macOS for access and opens Screen Recording settings
if access is still missing. macOS may not show another permission prompt. Enable
Octant there; if it is absent, use **+** to add the installed Octant app. Relaunch
Octant after changing permissions, then choose **Recheck**. Recheck reads the
current state without requesting access. Settings shows **Allowed** only when
the computer-use driver Octant starts holds the permission too; an unsigned
Octant build can be allowed while its driver is refused. Each task asks before accessing an
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
that its protocol is compatible with this Octant, then upgrades after computer-use tasks finish. If the
replacement is incompatible or cannot start, Octant keeps the previous verified driver. You
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
it, even under Full access; the key stays on this host. A desktop on another
of your computers, such as a Cua Space on **Your other computer**, also asks
each time and names the computer it runs on: if this computer stops, Octant
cannot end it, and it may keep running there until you delete it. The pane's
title names the computer while the desktop runs. Octant shows and drives it
only while Cua reaches it end to end, never through the relay's HTTPS path,
where Cua's relay could read it; while that is the only way through, the pane
says **Not shown: the connection could be read**, the desktop keeps running,
and **Try again** looks once more. This version does not offer a cloud
provider or another computer yet.

A desktop that bills you starts only under a monthly cap you set in
**Settings → Computer use → Desktops that bill you**; until you set one, none
starts. Before each one starts, Octant estimates the most it could cost from
the recipe's **Cost per hour**, over its longest run or, for a Cua Space in
your AWS, Google Cloud, or Modal account, over the time that cloud keeps it
running if this computer stops (8 hours for AWS and Google Cloud by default,
up to a day for Modal), whichever is longer. If this month's spending plus
that estimate would pass the cap, the desktop doesn't start and the pane says
why; desktops already running keep running. The confirmation shows the
estimate and what this month has counted. A month is a calendar month in UTC.
Only a window on the host itself can see or change the cap; an agent never
can.

A paired phone or browser that can open the thread can watch and use its
desktop too.

#### Setting a desktop recipe

Desktop starts a desktop from the Project's **desktop recipe**. Until the
Project has one, the pane says so instead of offering **Start desktop**. To
set one, open the Code Project, then **Disposable desktop** → **Manage** in its
settings:

- **Provider** lists the desktop providers this host offers. On Linux that
  includes this host itself, once Bubblewrap, Xvfb, xdotool, and ImageMagick
  are installed and Octant has restarted, and Cua Spaces; E2B is listed on
  every host. A line under the list says where the provider runs, whose
  account it uses, and whether it bills you. A provider that isn't set up
  here shows **(needs setup)** and can't be chosen, and what it needs is
  listed under the selector: E2B needs this computer
  to have a credential store for your API key, and Cua Spaces needs its app
  running and signed in on this computer. Nothing starts on a provider until
  you save a recipe that names it, and a desktop that bills you still asks
  you first.
- **Runs on** appears for a provider that names where its desktops run, and
  picks where this Project's desktops run.
- **Computer** appears when they run on one of your other computers, and
  lists the computers the provider knows about, marking any that isn't
  answering now. Pick the one this Project's desktops run on; Octant never
  picks one for you.
- **Screen** sets the desktop's size.
- **Lasts**, **Longest**, and **Idle** set how long a desktop lasts at first,
  the most it can be extended to, and how long it may sit unused. They start
  at 30 minutes, four hours, and 15 minutes.
- **API key** appears for a cloud provider that bills your own account, such
  as E2B. Type the provider's API key; a cloud recipe can't be set without
  one. Octant keeps it only in this computer's credential store (Keychain on
  a Mac, Secret Service on Linux) and sends it only to that provider: the
  recipe holds a reference to it, and the key never appears in the Project,
  its history, logs, diagnostics, or an export. The line under the field says
  whether a key is saved, whether the saved key is no longer in the
  credential store, and whether the provider refused it the last time a
  desktop started. To replace it, type a new key and choose **Save recipe**.
  **Remove key** asks first, then keeps the recipe but ends its running
  desktops; no desktop starts until you enter a key again. A key you replace
  or remove is deleted from the credential store once every desktop started
  with it is gone, because Octant needs it to end them.
- **Cost per hour** appears for a desktop that bills you. Enter what an hour
  of it costs on your account, in US dollars; Octant knows no provider's
  price and estimates each desktop from this before it starts.

**Set recipe** saves it; the next desktop uses it. The desktop never has
network access. **Remove recipe** asks first: removing it, or changing its
provider, where it runs, its computer, or its key, ends the Project's running desktops. Only a window on the host
itself can set or remove a recipe or enter its key, so **Disposable desktop**
appears only there: a paired phone or browser doesn't show a Project's
settings, and the host refuses a recipe change from either.

### Several threads at once

Threads of one Project can each have their own page open and work at the same
time. Each thread's agent can use only its own page and its own tabs, never
another thread's, and one thread waiting on its page does not hold up another.

To see them together, open the Project's browser (the Browser quick tool on the
Project, or the docked Project browser). When any thread of the Project has a
live page, a tab strip appears under its title: **Your page** for your own
browser, then one tab for each thread's page. Each tab shows the page's title
(or its site if it has none) and the title of the thread that owns it, with an
**Agent active** mark while that thread's agent is driving the page. Choose a
tab to see that thread's page as its preview shows it. You can look but not
click in it, and **Open thread** takes you to the thread. Choose **Your page**
to go back to your own browser. Nothing in the strip moves a page from one
thread to another.

A paired device sees the same tabs, but a page in a signed-in profile reads
"Signed-in page — open it on this Mac."

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

### Selected login-item permission

A task's native Browser offers **Login permission** to review one explicitly
selected 1Password account, vault and item while the page is held for the
person. It records top-frame permission for the exact HTTPS site and port,
profile and Project or task. It fills nothing and includes no iframe or page
script access. Store unlock, saved permission and website sign-in are distinct.
See [the secret-store steps](/guide/secret-stores#record-permission-for-a-browser-login-item)
for scope, expiry, revocation and current limitations.

For saved selected-item permission, **Review login form** gives a fresh field,
site and profile review before **Fill selected fields**. **Submit sign-in form**
is a separate approval. The page remains held throughout private read and each
effect, including overlapping observations. Fill does not confirm sign-in;
MFA/CAPTCHA and uncertain results remain yours to complete. The website can
retain or reflect input, so check it before continuing. See
[Secret stores](../guide/secret-stores.md#record-permission-for-a-browser-login-item)
for custody, cancellation and exact SSO limits.
