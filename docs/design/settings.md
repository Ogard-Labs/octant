# Settings

How Settings is organised and what its particular pages hold. The kit every Settings page is built from (page header, sections, rows, compact rows, saved state, destructive groups) is in [DESIGN.md: Settings layout](../../DESIGN.md#page-shell); provider catalog and model endpoint pages are in [Providers and model endpoints](model-endpoints.md).

## Settings sheet

Settings opens as a sheet over the app (`OctantSheet`): a floating surface
at most 1040 by 760px, on the float fill with the pop shadow, over a light
scrim through which the window stays drawn. The app behind it is mounted and
live, so a change to the theme, the accent, the type or the sidebar shows
where it lands while the control is still under the pointer. As a page that
replaced the window, Settings showed none of what a change did until a person
went back. The sheet holds the Settings rail and the page, divided by one
line; the rail is 232px wide there and is not resized (the saved sidebar
width is the full-window page's). A section's card steps up from the sheet's
own fill. A native Browser page leaves the window while the sheet is up, as it
does for a dialog. It closes with the
close control in its corner, with Escape, or with a press on the window behind
it, and focus returns to where it was. It carries no "Back to app": the person
never left. The presentation is decided when Settings opens and kept until it
closes. The sheet arrives and leaves with the shared
[overlay motion](../../DESIGN.md#motion-and-interaction); it stays mounted while Settings is
closed so that its leaving can be seen. While Settings loads, the sheet shows
Settings in outline on its own fill, inside its own box: a rail and a page of
skeleton bars (`SettingsLoading`), styled with the shell and not with
Settings, whose own stylesheet is part of what is still loading. In a window at the narrow breakpoint Settings covers the window, as
before, with "Back to app"; a sheet open while the window is made narrow
fills the window and keeps its page. The Usage page still covers the
workspace at every width.

## Groups and pages

Settings is the same shell with a 920px measure and its own
navigation rail; the rail names each group of pages with a quiet label and
draws no hairline between groups. There are six groups, each one question a
person brings to Settings, and a group lists its pages in this order: General
(General alone: who you are, app-wide defaults, and what Octant tells you), Look &
feel (Appearance, Sidebar, Keybindings), AI (Providers & Models, Octant Harness,
Voice & images, then Chat, Work and Code: which provider or model answers each
job, and how each mode starts), Tools (Skills & Extensions, Computer use, Device
tools, GitHub, Linear: what a running agent may reach), Safety (Permissions,
Secret stores, Memory: what an agent may touch, reach and remember), and
Data & devices (Data & storage, Sync, Remote access, Host, Usage: what this
computer stores and the other machines it talks to). An earlier Privacy & data
group had grown to seven pages answering three different questions, Modes stood
apart from the models its pages choose, and Advanced held two pages. General
opens on Your identity (the profile) and ends on Notifications (what Octant
sends while a person is away); Permissions holds the files no agent may touch,
then the network places and servers agents may reach (Network limits, Safe
networks, Servers), then what a person has already allowed (remembered
websites, remembered tool approvals, public links). Profile and Notifications
were pages of one and two controls, and Access was the other half of the
question Permissions answers, so the rail listed three pages a person rarely
needed alone; links to those pages open the page that holds them now. Data &
storage holds what the host keeps (data map, caches, backup, recovery, export,
retention, purge). AI
lists each provider kind on the page of what it serves: Providers & Models
holds the agent runtimes Octant drives (ACP agents, CLIs, the Agent SDK, RPC
runtimes), and its manual add form offers only those kinds. It opens on the
person's providers and their Defaults, then Find providers and Octant's own
OpenCode copy, with the Provider catalog under them; Octant Harness
opens with Model endpoints, every endpoint Octant calls over an API itself
(OpenAI-compatible, Anthropic-compatible, Ollama, Azure AI Foundry), followed
by model roles, helper agents, and Navigator's models; with no endpoint yet it offers three ways
in instead (Sign in with ChatGPT, Sign in with OpenRouter, Add endpoint), each
sign-in one click with its terms as a consent line under the button. Voice &
images holds speech, transcription, the image profiles, and custom image
sources. The Provider catalog lists every bundled driver of both kinds and
sends each one to the page that configures it. A sign-in
endpoint's row says who is signed in, its detail page offers sign out and
sign in again, and its configuration fixes the base URL and asks for no key. The
instances, commands, and credentials are the same on every page. A setting lives
on the page of the thing it changes, and a moved setting keeps answering links
to its old page. Look & feel holds Appearance (theme, window glass, background,
text, accessibility, and Reading: transcript text size and width, Reply detail
and the usage bars) and a separate Sidebar page (layout, destinations, sidebar
background, and a thread-row grid of detail by list). A page names its scope once, under its title, and a row names
its own only when it differs. Settings folds long choices it does not need
open: the built-in background pictures sit behind the current one and a
Change action, and the pattern dials appear only while the pattern is drawn.
Rows in Settings are `SettingRow`; rows everywhere else are `surface-row`. Both
draw the same hairline.

Selecting a page replaces its controls as well as its heading. Plugin pages
resolve the currently selected entry point; a missing entry point shows an
error instead of retaining another integration's account controls.

## Search

**Search.** The search field is always shown at the top of the rail, under
the "Settings" heading, with its shortcut (Cmd/Ctrl+F) at its trailing edge
until something is typed. Every typed word must match the start of a word in
a row's name, keywords, or page, in any order; filler words ("my", "the")
are ignored, and everyday words map to the rows' own (dark mode → colour
scheme presets, password → credentials, delete → purge, telemetry → what
leaves this machine, connector → MCP). Results rank a row named by the query
above one that only lists it as a keyword, mark the matched part of each
name in weight rather than a fill, and name the page. Enter opens the top
result, Down moves into the list, and Escape clears the field, then leaves
it. Every Settings row a person can see is indexed; a test fails when a new
row is not.

## Settings page layout

Settings is a grouped form page. The shared resizable navigation rail
stays fixed while one centred, bounded 920px reading column scrolls. A 32–64px
workspace gutter protects the content at narrower widths. The page title,
section labels, and row labels have distinct roles; sections follow a
consistent 28px rhythm. Navigation groups use quiet sentence-case labels
without hairlines between groups. A section is a label and its one-line
description over one grouped card of hairline-divided rows (see "Page shell"
for the kit). Discrete editors and install reviews keep their own boundaries
inside a section. Everything inside takes the card's 16px inset, including
content that is not a row. Keybindings have their own destination and raw JSON
stays behind an advanced disclosure. Inline profile and provider editors keep
their aligned row edges, measured from the card's inset. Ready providers
open onto a bounded model list with search, shown counts, and shared visibility
switches. Routine connection diagnostics and capabilities use a separate
disclosure; setup and authentication guidance remains visible. Visual theme
previews and confirmation dialogs retain their discrete boundaries. A
destructive group is its own section at the end of its page, marked by that
placement and by its confirm control, not by heading colour. Labels and
descriptions align left, controls align right, and compound editors may expand
below. A row's "more" (a custom font stack, network details, what an update
check sends) sits behind one `.settings-disclosure` recipe: a 12px summary with
the app's chevron, never the browser's marker. Loading and status lines are one
quiet sentence; only an error keeps a box. Essential labels and explanatory
text are at least 12px at the default interface scale. Every control uses the
owned Octant/shadcn adapter, inherits the interface typography projection, and
either saves immediately or uses a compact Save action for a compound form.
Save controls retain a contextual accessible name. Model visibility changes keep
the open editor, filter, focus, and drafts stable; hiding the last model does not
trigger provider discovery.
Scope metadata remains available to assistive technology but does not compete
with the setting label.

## Settings stability

Background refresh preserves already loaded controls and active drafts. Use the
initial loading view only before a surface has data. Provider and theme feedback
occupy bounded, scrollable status slots; a changed status must not push the form
below it. A provider row's status line keeps its place under the name and shows Checking during probes.
Last observed model facts are presentation only and never authorize selection
or execution. Saved Chat/Code revisions reconcile untouched fields without
remounting the form. Keep deliberate section expansion, text growth, and manual
resizing distinct from unsolicited layout movement.

## Optional Settings details

Keep common preferences and host health visible. Use the shared
`SettingsDisclosure` for optional inventories or specialist controls; it keeps
its contents mounted so closing it does not discard an unfinished field.
A deep-linked setting reveals its enclosing details before receiving focus.
Appearance keeps interface typography visible, with editor and terminal fonts
in named disclosures. Host data inventory lives under Stored data. Installed
skills and collision diagnostics scroll within a bounded collection while
search, counts, and Show all remain outside that scroller.

## Models, providers, and skills

Chat and Navigator defaults use the same compact model chooser as composers,
with the current selection in the row and the searchable catalog in a bounded
popup. Unconfigured defaults say Choose model.

Operational settings use progressive disclosure. Provider and skill lists lead
with compact readiness counts. On Providers & Models each provider group is
one aligned list on the Settings grouped-row surface, one row per provider,
rows divided by the surface's inset hairline and never filled. A row holds a
20px provider mark with no tile (the licensed bundled mark, or a monogram when
there is none, never an approximation of a brand mark), the name in the
row-label role, one status line in secondary ink (state, model count, maker
and runtime), and the details chevron and enable switch at the trailing edge.
The chevron is the row's disclosure (`aria-expanded`). A provider a person
opens becomes the page: its row and details stand alone, with every control and
fact, and the other rows, the group headings, the list's heading, the sections
around it and the page outline step away. One **Providers** Back control above
it, the chevron, or Escape returns to the list and puts focus back on the
row's chevron. The page opens at most one row by itself, in place in the list,
the first that needs attention (a sign-in, or a binary the scan found for a
broken runtime), and none when no provider does; a row that comes to need
attention while a provider's page is up waits, open, in the list. Remove is the
last thing in those details, alone under a hairline with one line saying what
it does, never among Check connection, Configure and the other routine actions.
A card per provider, two to a row, made the boxes the loudest thing on the
page; details expanded in place, one row at a time, still grew the page by a
provider's models and actions among rows that had nothing to do with them, to
about four screens. The state line
reads from a dot that carries the state without colour: a filled ink dot is
ready, a ring in ink needs setup or a sign-in, a muted ring is off or not
checked, and a failure keeps its red role. Only under Colour does ready turn the
palette's green and setup the palette's orange. The detected, supported-but-not-
detected, and other groups are Settings sections; the readiness summary is the
label's description. Ordering controls appear only in an explicit Reorder mode.
A runtime installed in an unusual location is fixed from its own row rather
than a manual form: the row's details carry a "Locate binary…"
action beside Check connection, shown only where the desktop's file picker
exists and only for a runtime whose version probe the host can run. Its
answer is one quiet line under the actions (the version the host read), or a
warning box saying why the host refused the file. A scan repairs a saved
binary that no longer exists by itself. A row whose saved binary is still
unusable, while the latest scan found that runtime elsewhere, says "Found at
~/.local/bin/claude (2.1.306)." on the row beside a "Use it" button,
visible while the details are closed; pressing it opens the details and gives
the same answer without the picker. See
[Providers and model endpoints](model-endpoints.md).

Provider catalog and the Octant Harness model endpoints (rows, detail
sub-pages, and Add endpoint) follow
[Providers and model endpoints](model-endpoints.md): one link per
row named with its state, the state in words beside a dot whose shape carries
it, one plain fix per problem, and precise protocol terms only in Diagnostics.
Skill rows show the source class and one effective state;
filesystem paths, qualified identifiers, hashes, requested/effective
breakdowns, and content size live behind Details. Usage opens on requests,
input, output, and measurement quality. Its thread table uses the same figures
as the figures in Thread info: cache, speed, and first token are columns,
omitted when unavailable, and opening a row lists that thread's turns. The
table stays a hairline table, not a card. Reasoning, cache, execution time, and
latency live in one Operational details disclosure; technical filters stay
collapsed in Settings. The standalone Usage destination also exposes provider
capacity independently of ledger loading. Each provider window leads with its
remaining percentage and an accessible meter, followed by its reset countdown.
Account, model, and provider-instance scopes remain distinct. An elapsed reset
shows Awaiting updated limits until a fresh reading arrives; it never implies
refilled capacity. Provider cards use the shared surface typography and tokens
and stack at narrow widths. Inside Settings, Usage has no title of its own: its
controls sit above kit sections (overview, token totals, provider limits,
breakdown), each a label over one card, and the Settings header is the only
title.

## Extension, skill, and Usage cards

Usage totals sit in the Settings kit's card inside Settings. Provider create
forms, individual extension objects, and artifact cards use the same raised
recipe; in Settings, the extension and skill collections are kit cards too, and
the Installed and Marketplace switch rides the first section's label line.

## Permissions

Inline provider, extension, and Browser permission requests use
`OctantApprovalCard` in the thread column. It owns the neutral card material,
pending icon, readable summary and detail, wrapping action row, and inline
failure announcement. The requesting feature supplies the scope, choices, and
callbacks; the existing host or server still decides whether an action may
proceed. Native Code approvals keep their isolated host-owned document. The
extension tool request names the plugin, its server, and the tool, and adds
"Always allow in this Project" only when the host marks the call rememberable
and the window is a local one. The same card offers "Allow all tools of this
server", which remembers the server instead of the one tool, and a Chat thread
outside a Project offers "Always allow for this account" in place of the
Project choice (maintainer request, 2026-11-12; not built yet: today a grant
covers one tool and needs a Project). Settings › Permissions lists those answers by
Project, each with Revoke, beside Remembered websites. Settings › Work and
Settings › Code show the global guardrail level with one-click change,
which governs Work and Code alike; a Work or Code Project overrides it from
its overview (Default mode), and each thread's header shows the level in force
and the scope it came from, in one quiet line ("Auto · set by this Project").
The levels, top to bottom, are Ask first,
Accept edits, Auto, and Full access; Full access is the lowest, and there is
no separate switch below it. The first time a machine or a Project picks Full
access, a one-time warning asks to confirm, in the warning role: "Agents can
change any file and run any command without asking, with no sandbox. Protected
files, such as SSH and cloud keys, are guarded by Octant's own tools and
redaction only, and a shell command can read them." It
offers Cancel (focused) and Use Full access, and is not shown again for that
scope. **Protected files** opens Settings › Permissions, above Remembered
websites: one row per built-in group (SSH private keys, cloud credentials,
and so on) whose description lists the paths it covers on this host and the
channel that replaces them, with a secondary **Remove** button; a removed group
reads "(not protected)" and offers **Protect again**. Remove opens
`OctantConfirmDialog` in the destructive role ("Stop protecting …?", Cancel
focused, **Remove protection**), because every agent can then read those
files; the host journals the confirmed removal. Paths the person added follow
as rows with Remove (no confirmation), then one "Protect another path" row with
a text field and an **Add** button; a refused path is said in the section's
feedback line. A paired device edits the section as a local window does
(maintainer decision, 2026-11-12; not built yet: today a paired device sees the
section as set on the host machine).
**Worktrees** in Settings › Code, above Open in applications, lists the managed
worktrees archived threads still keep, largest first: the thread's title, then
a line of Project, branch in mono, and size ("more than" when the count stopped
early), then the folder in mono. Each row's secondary **Remove** opens
`OctantConfirmDialog` in the destructive role ("Remove this worktree?", Cancel
focused, **Remove worktree**), saying the folder and its ignored files go and
the branch and its commits stay. A refusal (uncommitted changes, or a turn
still running in the thread) is said in the
section's feedback line and the row stays. With none kept it says so in one
line; a paired device uses the section as a local window does (maintainer
decision, 2026-11-12; not built yet: today a paired device sees the section
as managed on the host machine)
([rules](../architecture.md#modes-chat-work-and-code)).
**Worktrees on this computer** follows it: a first row says when the host last
scanned ("Not scanned since Octant started" until then) and how many it found,
with **Scan** and, when any qualify, **Remove N merged or gone**, which asks
once in the destructive role (ignored files go with each folder), then removes
each and reports how many stayed because they need a look. Worktrees are
grouped under their repository's path in mono; each row is the branch (or
"Detached HEAD"), then a line of facts (Folder is gone, Locked by Git, Merged
or pushed, or Has commits only here; size; last used) and the folder in mono,
with **Remove** (**Forget** when the folder is gone; disabled when locked).
Remove asks once in the destructive role; when the host answers that commits
exist only on the branch it asks again listing up to ten of them, and when the
worktree was used in the last 15 minutes it asks once more (**Remove anyway**).
**Xcode builds**, on a Mac only, lists DerivedData folders whose project is
gone or that Xcode has not opened for 30 days, largest first, each with its
state, size and workspace path in mono, a **Remove** per row and **Remove N
whose project is gone**, both asking once.

The section also shows, each
as an account default a Project
may override: **Auto reviewer** (Provider's own / Octant Shield), **Safe
networks** (trusted hosts, domains, address ranges, and private-network tags),
and **Servers** (registered SSH hosts, each with a Read-only, Operate, or Admin
profile and an optional notes file), and, with the memory distiller's model, the account choices under **Automatic
model calls** (each thread's provider with its smallest model, or one configured
account and model). The rules behind them are in
[Octant Shield](../architecture.md#octant-shield). Built for Code: Auto
reviewer in Settings › Code › Access, **Automatic model calls** in Settings ›
Providers & Models (a section with one select per job, a plain note of where the
work goes, and the account's problem when it has one; the second opinion on
decisions starts at **Off** and is the only job with no default account), and the reviewer
override as a select on a Code Project's overview; **Servers** is built below
Safe networks in Settings › Permissions as an account list and a **Project**
picker that says whether the chosen Project uses the account's servers or
its own list, which starts as a copy of the account list and is edited with
the same rows and form. **Safe networks** is built on Settings › Permissions, after
Protected files: a **Network limits** panel with a
switch that is on by default, a sentence saying plainly whether limits are on
(and, when on, that they hold sandboxed runtimes only),
and a note that a change applies to the next runtime started; then an intro
sentence, the **Every
Project** list, a **Project** picker that says whether the chosen Project
follows the every-Project list or has its own (with **Use its own list** and
**Follow every-Project list**), and **Recently refused**. A place row shows its
kind in the meta role, its value in the code font, an optional port, and a
quiet Remove; the add row is Kind, value, optional Port, and Add place, and
Save sends the whole list. A refusal from the host shows inline in the alert
role and marks the refused row; nothing decides validity in the renderer
beyond a port's range. Each refused host row shows `host:port`, the runtime,
its count and age, and a quiet **Trust**, which adds that host and port to
the list being edited. While limits are off, or when the host cannot route
runtimes through these rules, a plain note says the lists are saved but not applied
([Provider runtime network](../architecture.md#provider-runtime-network)).
**Servers** opens with a sentence saying agents reach these servers with the
person's SSH agent or a key Octant makes and keeps for one server, and Octant
never reads key files, a quiet note when no SSH agent is running, one line per
profile (Read-only, Operate, Admin) and one saying lock-out and destructive
actions always ask. A server row shows `user@alias` in the code font, its
profile, its runbook path, how many deploys it has, and "Key Octant keeps"
when it signs in with one, with quiet Change and Remove, and **Show key** for
such a server. Show key opens a line under the row: "Add this line to
`~/.ssh/authorized_keys` for <user> on <alias>.", the public key in the code
font, wrapping, and a quiet Copy that reads Copied once it has; a refusal
shows there in the alert role. The form is Alias, User, Profile, Sign in with
(Your SSH agent, the default, or A key Octant keeps), Deploy commands (one per
line, shown for Operate and Admin), and Runbook path. A refusal from the host shows inline in the alert role.
Below it, **Projects on your servers** lists each server Project as its
name and its kind and `alias:folder` (`Work · web-1:/srv/notes`) in the code
font with a quiet Remove, and a form of Project kind (Code, the default, or
Work), Project name, Server (`user@alias`), and Folder on the server whose button
reads **Bind folder** and **Checking the folder…** while the host checks it
over SSH; with no registered server the form is replaced by a line asking for
one ([Server Projects](server-projects.md)).
A Work Project's **Developer tools** switch is presentation, not a
permission, so it lives on that Project's overview, not here
([Workspace](workspace.md)). A Browser request from a
CLI in a Code thread's terminal names the origin and the thread and says a
program in the terminal asked, not the thread's agent
([Terminal Browser grant](terminal-browser-grant.md#the-window)).

## Secret stores

Settings › Secret stores sits with Permissions under Safety and is
host-scoped. It has two cards. **Linked secret stores** is a plain row per
tool: the tool's name, one line saying whether it is linked and whether the
store is ready, locked, not installed, or unreachable, and one button, Link or
Unlink. Unlink waits for a confirmation that says which providers stop getting
their key and that nothing in the store is changed. A refusal (a locked store,
a missing tool) appears in the card's feedback slot, in the host's own words.
**Check an item** takes an item reference and answers Found, locked, missing, or
unreachable; it never shows what an item holds. On a host with no credential
broker the card says so and offers no button.

A provider's key from a store lives on the provider's own card, under **Key from
a secret store**, beside the API keys. It appears only when a store is linked or
the provider already points at an item, so a card never carries a section most
people do not use. It shows the item reference in code type with Check, Change
item, and Remove, or one reference field with Use this item. No control on
either surface has a field for a key, and nothing on them shows one.

## Save diagnostics

Host › Maintenance holds Save diagnostics beside the failure report. The row's
button, **Save diagnostics…**, saves nothing: it opens a plain list in place,
headed "This file will include", with one row per section (name, how many
entries it holds now or "Not available", and one sentence on what it holds),
then "It never includes" and its plain lines. Only **Save file** asks the host
to build the bundle; **Cancel** closes the list. In the desktop app Save file
opens the native save dialog, offering `octant-diagnostics-<date>.zip` in
Downloads; dismissing it returns to the list with nothing written. A browser or
paired client downloads the zip instead. The saved line names the file and says
nothing was sent. A host that cannot list or
build the bundle shows one error sentence and keeps the button. The list is
text and tabular counts on the page ground, with a hairline between rows and no
cards. The rule for what the file holds is in
[Architecture: persistence](../architecture.md#persistence).

## Connection removal and device keys

Settings connection removal uses the same confirmation while retaining its
host command and GitHub's explicit local-logout confirmation.

Remote device-key rotation uses the same confirmation. It remains limited to
the paired browser and requires its own explicit choice after opening the
dialog; cancellation leaves the key untouched.

## Usage

The Usage destination opens local provider history by default when that host
supports it. Octant records remain a separate source; the two totals are never
added. A period change replaces the query, cancels the previous read, and cannot
render a late result under the new period. A refresh keeps the previous reading
visible. Resumable imports continue in bounded batches; read errors and hard
limits remain visibly partial.

History leads with the total and provider list beside a daily chart, followed
by processed, cached, uncached, output, and estimated cache-savings totals.
Cost and Tokens share the same geometry. Model and Day breakdowns are compact
read-only tables. Individual chart readings also have a disclosed table.
Unknown prices and missing quota measurements are unavailable, never zero.
API estimates, provider-recorded costs, pricing revisions, and measured-record
coverage remain distinguishable.

Diagnostics is the third source in the same toggle group, offered when the host
answers turn diagnostics. It reads how turns went across every provider and mode
([architecture: reading how turns went](../architecture.md#context-and-usage-accounting))
and has its own Range (24 hours to all recorded turns), Mode, Provider, and
Trend-by controls. It opens as a dashboard drawn with the Canvas visuals, so
every chart has hover readings and a disclosed table: headline tiles (turns, finished share, failed and stopped turns, turns cut at
the output limit, tool failure rate, typical and slow first token, typical
speed, typical and slow turn length, retries, provider-reported cost, likely
cache misses), each
with a sparkline and, for a bounded range, its change against the same span
before, toned by which way is good; How turns ended (finished, stopped, and
failed stacked by day or hour, failures in the alarm hue, beside the share that
failed or stopped); Speed over time (typical first token and speed); Model
comparison (ranked bars of typical and p95 first token and speed, full model
names); and What fails most (failed turns by cause, failing tools). A tile's
change is shown only beside the reading whose span it was measured against.
Details follow: Benchmarks by model with p50 and p95 first-token, speed, and turn
length; Turns by day or hour as a disclosed table of every bucket's turns,
failures, stops, tool failures, retries, first token, and speed; Failures by
cause with the newest redacted message; Tools, most failures
first; Retries, limits, and waits; Turns to investigate, whose Open button
leaves Usage for that thread; Likely prompt-cache misses, worded as a
likelihood; and Host health, one small chart per measure on its own scale
(memory in use, event-loop stalls, longest stall, slow database statements,
request p95, database size), each with its peak and when, a restart note, and a
disclosed table. A figure no turn measured is left out or reads Unavailable,
never zero. The header copies the whole report as JSON for offline analysis and benchmarking.

The following canonical map applies to the Usage flow and its Settings entry:

| Capability      | Canonical owner                                                             | Source of truth                                 | Allowed variants                                                                | Verification                                 |
| --------------- | --------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| Table Selection | UsageWorkspace, ProviderUsageHistoryWorkspace, and TurnDiagnosticsWorkspace | Usage contracts and this document               | Read-only model/day/detail tables; no bulk selection                            | Usage component tests and narrow rendered QA |
| Select/Listbox  | OctantSelectField and OctantToggleGroup                                     | Shared UI adapters                              | Select fields for filters; toggle groups for source, metric, and period         | Shared-control and Usage interaction tests   |
| Date            | ProviderUsageHistoryWorkspace period controls                               | LocalUsageHistoryRequest                        | Past 24h, 7, 30, and 90 days; explicit viewing timezone                         | Range and stale-response tests               |
| Form            | UsageDashboard filters and shared field adapters                            | UsageQueryFilter                                | App-owned validation; retained filter values                                    | UsageDashboard tests                         |
| Scrollbar       | Usage workspace viewport and table scroll regions                           | usageWorkspace.css and providerUsageHistory.css | One page scroller; horizontal table overflow and disclosed chart-data scrolling | Narrow viewport and keyboard QA              |
| Toast           | Inline usage status and error regions                                       | Query and provider-limit state                  | Retained stale readings and inline recovery; no critical toast-only feedback    | Failure, refresh, and client-switch tests    |
| CRUD            | UsageDashboard in Settings                                                  | Usage client and retention/export contracts     | Main Usage is read-only; retention and export stay in Settings                  | Existing usage action tests                  |
