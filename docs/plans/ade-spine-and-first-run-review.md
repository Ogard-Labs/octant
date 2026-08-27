# Octant ADE cleanup, shell rework, and dogfood plan

## Approved product decisions

Henrik approved these decisions on 2026-08-21:

- Environment is a compact thread summary with a transient disclosure. Its
  open state is not persisted.
- Local changes and pull-request details open in a thread-aware Review panel in
  the right dock. The old full-window diff is removed after migration.
- Secondary turn and server actions use keyboard-accessible overflow menus
  mirrored by right-click. Primary actions remain visible.
- One main window may pin several same-authority threads into persistent split
  panes. The right dock follows the active pane and never shows another
  thread's content.
- The right dock hosts live thread-owned tools, not only launch buttons or
  static summaries. Browser, Terminal, Files, Review, Agents, and other
  capability-valid tools may remain open there for the active thread.
- All thread-scoped working tools belong in the right dock: Browser, Review,
  Files, Terminal, conditional Plan and Delivery, conditional Agents, Canvas,
  and Side chat when mode and capability allow them. The central pane remains
  the thread, a board, a Project overview, or a Project-level list.
- Context-window usage is a circular meter in the active thread's composer.
  It opens a compact, authoritative breakdown popover and is not a right-dock
  tool.
- Project memory belongs in the Project Overview. Navigator is one host-wide
  chat popover opened from the profile and Settings control at the bottom of
  the left sidebar. Neither is a right-dock tab.
- The generic Context, Project memory, Navigator, and Thread dock tabs are
  removed. The right dock addresses useful tools directly.
- Publish is renamed Delivery and appears only when the server reports a real
  enabled target or actionable delivery plan. An unconfigured empty panel is
  absent.
- Compact child-run status remains in the thread header. Agents appears as a
  direct dock tool only when child runs exist or the user invokes `Add agent`.

The visual direction is calm and thread-first: a restrained sidebar, generous
central reading space, compact contextual disclosures, a clearly marked active
pane, and right-side tools that appear only when useful. Reference screenshots
are design guidance, not source material to copy.

## Problem statement

Octant has many of the right backend pieces, but the app does not yet work as
one dependable agent development environment. The server has useful authority,
journal, provider, Git, worktree, and AgentRun boundaries. The renderer exposes
them as several competing products:

- low-frequency turn actions are always visible in the transcript;
- the Environment panel grows into a long stack of Git facts, local-server
  cards, and working-folder controls beside the work itself;
- `View diff` replaces the central workspace with a mostly empty full-window
  surface instead of supporting review beside the thread;
- Code has a partial thread board, Work advertises a board that is not wired,
  and the two do not share one truthful model;
- Pull requests have thread-scoped pieces but no working Project-level list;
- agent creation is incomplete and can expose raw implementation identifiers;
- first run configures settings, but the full path from a clean launch to a
  useful agent turn is not a release gate;
- a small set of security, folder-navigation, deferred-provider, PR-mutation,
  and wiring paths are incomplete or no longer belong in the preview.

The result feels crowded and unfinished at the same time. The work should not
be one broad rewrite. It should be a sequence of complete slices that steadily
turn the current app into a smaller, clearer ADE.

## Assessment of the two plans

The previous Octant plan gets the product scope right: one AgentRun control
model, real Work and Code boards, Project-scoped pull requests, documentation
truth, and cautious cleanup around large composition modules.

Grok's review adds several concrete corrections worth keeping:

- GitHub access should continue through the authenticated `gh` CLI, with no
  Octant-owned GitHub token.
- GitHub list and detail reads must be user-triggered. Navigation, board
  queries, app launch, and ordinary cache reads must not contact GitHub.
- GitHub cache data is temporary integration data, not journal authority.
- stale data should remain visible when GitHub is unavailable or rate-limited.
- folder search and breadcrumb authority need explicit integration tests.
- external-content taint needs a durable ingestion event and replay evidence.
- server-owned board data should not persist client-specific unread state.
- unsupported PR mutation and Cursor ACP production contracts should leave the
  technical preview rather than remain as misleading dormant product paths.

The Grok plan is too narrow where it excludes the Work board. Henrik has
explicitly put both Work and Code boards in scope. The previous plan is too
broad where it puts an Agents Center, boards, PRs, cleanup, and visual redesign
into one undifferentiated implementation stream. This integrated plan keeps the
full ADE goal and delivers it as ordered pull requests.

## Product outcome

Octant should open into a calm work surface with one obvious primary activity:
the current thread and its composer. Persistent chrome shows only information
needed throughout a turn. Review, environment details, files, terminals,
browser, context, memory, and agent hierarchy are available without taking over
the transcript. The right dock can grow into a resizable working area for live
thread tools while the main pane remains the conversation and composer.

The core product loop is:

1. Connect a provider and Project.
2. Start or open a Chat, Work, or Code thread.
3. Create and control appropriate child runs under that thread.
4. Inspect live work, approvals, changes, and recovery without leaving the
   thread unnecessarily.
5. Track real Work and Code threads on server-derived boards.
6. Manually refresh active pull requests from connected Code Projects.
7. Review a local change or selected pull request in the right dock.
8. Finish only when the thread's confirmed delivery target has objective
   evidence.

## User stories

1. As a user, I want the transcript and composer to dominate the window so I
   can follow the agent without scanning unrelated controls.
2. As a keyboard user, I want every contextual action available through a
   focusable menu, not only through right-click or hover.
3. As a Code user, I want a compact repository, branch, change, and server
   summary so I can understand the current environment at a glance.
4. As a Code user, I want Environment details to open temporarily and close
   without changing my workspace layout.
5. As a Code user, I want local servers grouped into compact rows so duplicate
   loopback listeners and unmanaged processes do not become a wall of cards.
6. As a Code user, I want `View changes` to open Review in the right dock so I
   can inspect a diff beside the thread.
7. As a Code user, I want a changed-file list and per-file diff in Review so an
   empty full-window diff does not replace my work.
8. As a user, I want fork, checkpoint, and restore actions available when I
   need them without displaying them under every turn.
9. As a user, I want destructive in-place file restore clearly separated from
   checkpoint restore, which creates a new thread.
10. As a new user, I want first run to leave me with a provider, a Project, and
    a clear way to start a real thread, or tell me exactly what remains.
11. As a parent-thread user, I want to create, inspect, steer, stop, retry, and
    acknowledge child runs from one hierarchy.
12. As a Chat user, I want children to remain research-only with no implicit
    filesystem or shell authority.
13. As a Work user, I want children confined to the current Work Project root.
14. As a Code user, I want implementation and review children to use verified
    isolated worktrees and never the parent checkout.
15. As a Work user, I want a board of real Work threads rather than a
    placeholder or a separate task system.
16. As a Code user, I want the board to explain why a thread is Ready, In
    Progress, Waiting, or Done.
17. As a user, I want board failures to preserve the last useful view rather
    than turn it into an empty board.
18. As a user with several Code Projects, I want one Pull Requests workspace
    showing active open and draft pull requests grouped by Project.
19. As a user, I want GitHub requests to occur only after a visible refresh or
    explicit detail action so rate limits remain under my control.
20. As a user, I want stale and rate-limited PR data labelled with its last
    successful refresh time.
21. As a user, I want a selected PR reviewed in the right dock and an exact
    linked thread opened without fuzzy matching.
22. As a user, I want Octant to expose neither local paths nor GitHub
    credentials through renderer-authored repository requests.
23. As a user on a narrow window, I want the right dock to become an accessible
    drawer while the transcript remains usable.
24. As a dogfooder, I want every visible control to work, explain why it is
    unavailable, or be absent.
25. As a user comparing or supervising work, I want to pin several threads in
    one main window and have the right dock follow whichever pane I activate.
26. As a Code user, I want Browser, Terminal, Files, and Review to run inside
    the right dock so I can work beside the thread without replacing it.
27. As a user, I want a Plan dock tool only when the active thread has a real
    plan artifact, rather than an empty proposal form in a generic Thread tab.
28. As a user, I want Canvas to run as a live thread-aware dock tool without
    copying its document state or widening thread authority.
29. As a user, I want a circular context meter in the composer so I can inspect
    used capacity, free space, category breakdown, and authoritative provider
    limits without opening another workspace.
30. As a Project user, I want Project memory in the Project Overview where its
    Project ownership is obvious.
31. As a user, I want Navigator to open as one app-wide chat popover from the
    profile and Settings area rather than occupying a thread-aware dock tab.
32. As a Code user, I want Delivery to appear only when there is a real target
    or actionable delivery plan, rather than an empty Publish panel.
33. As a parent-thread user, I want compact child status always available while
    the full Agents tool opens only for existing runs or an explicit Add agent
    action.

## Interaction and information-architecture decisions

### Persistent, contextual, and removed controls

Primary work stays visible. Secondary work moves behind accessible menus or
temporary panels. Right-click may mirror an action, but it is never the only
way to reach it.

| Placement                 | Content                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Persistent thread surface | transcript, composer, active run state, approvals, stop, delivery status, recovery state                                       |
| Compact thread header     | Project, branch or root, clean or dirty state, running-server count, child-run count, dock disclosure                          |
| Turn overflow menu        | fork from here, mark or forget checkpoint, copy references, mode-valid secondary actions                                       |
| Destructive turn menu     | in-place working-tree restore with explicit confirmation and copy that distinguishes it from checkpoint restore                |
| Environment disclosure    | concise checkout facts, current-checkout servers, other servers, and a `Change working folder` action                          |
| Composer context meter    | circular used-capacity indicator and a thread-specific breakdown popover                                                       |
| Project Overview          | Project memory, Project facts, bindings, health, and Project-scoped controls                                                   |
| Profile and Settings      | app-wide Navigator chat popover and Navigator configuration                                                                    |
| Right dock                | Review, Files, Terminal, Browser, conditional Plan and Delivery, conditional Agents, Canvas, and Side chat when allowed        |
| Removed                   | permanent low-frequency text links, dead controls, placeholder destinations, duplicate identity rows, unsupported stop buttons |

When no tool is open, the dock uses a compact keyboard-accessible launcher.
Once tools are open, a restrained tool strip switches among that thread's live
dock instances. This strip is for tools, not threads, and must not recreate the
workspace tab system. It shows only capabilities available for the active
pane. Narrow windows use the existing modal-drawer behavior.

### Remove the generic dock categories

The current Context, Project memory, Navigator, and Thread tabs are categories
invented by the renderer. They make the user choose an implementation bucket
before reaching the thing they need.

- Remove the generic Thread tool and its accordion of Files, Plan, Publish, and
  Agents.
- Files becomes a direct dock tool.
- Plan becomes a direct dock tool only when the active thread has a current
  plan artifact. The dock displays that artifact, revisions, approval, and step
  state. It does not show an empty `Propose plan` form. Plan creation happens
  through the thread's planning workflow and results in the artifact.
- Rename Publish to Delivery. Keep its reviewed revision, destination, digest,
  explicit approval, refusal, and receipt behavior, but show the tool only when
  the server returns an enabled target or an actionable delivery plan.
- Keep compact child-run status in the thread header. Show the direct Agents
  tool when the hierarchy contains runs or the user invokes `Add agent`. The
  current raw provider, model, workspace, and authority form does not survive
  the server-derived AgentRun redesign.
- Project memory moves into every mode's Project Overview, with the same
  versioned mutations, history, transfer, and archived read-only behavior.
- Navigator keeps one host-owned conversation and controller. The profile and
  Settings control at the bottom left opens it as an app-wide popover. Opening
  it never changes the active thread or Project.
- Context capacity moves to the composer meter and popover described below.
- The dock launcher and tool strip name real capabilities directly. A tool that
  has no truthful state or available action is absent rather than represented
  by an empty accordion.

### The right dock hosts live thread tools

The right side is a resizable working region, not a list of shortcuts.

- Review, Browser, Terminal, Files, conditional Plan and Delivery, conditional
  Agents, Canvas, and Side chat render their real interactive content in the
  dock when the active thread and mode allow them.
- Tool instances are owned by the thread or Project authority that created
  them. Switching panes never rebinds a running terminal, browser context, file
  view, or agent control to another thread.
- Activating a pane shows that thread's dock tools and last selected tool. A
  thread with no open tools shows the compact launcher.
- Background terminal and browser lifecycles remain server-authoritative.
  Hiding a dock tool does not imply stopping its process or context; an
  explicit close or stop action keeps its existing product meaning.
- The dock may hold more than one live tool for a thread, using a compact tool
  strip with identity, active state, close behavior, keyboard navigation, and
  overflow. It does not hold multiple thread tabs.
- A Canvas dock instance addresses the existing authorized Canvas document.
  It does not copy content, create a parallel history, or treat renderer focus
  as authority. Closing the dock view does not delete the document.
- The dock is resizable within existing window limits. The main thread retains
  a usable minimum width, and a narrow window presents the active tool as an
  accessible drawer.

### Multiple pinned threads use the existing split tree

Pinning a thread places it in a persistent pane of the existing recursive split
tree. It does not add tab strips, background tabs, a second thread lifecycle,
or a second authority model.

- The active pane has a clear visual and accessibility state.
- Clicking or focusing another pane retargets the right dock immediately.
- Review, Files, Terminal, Browser, conditional Agents, Canvas, Side chat,
  Environment, composer context usage, and any active Plan or Delivery artifact
  resolve against the active pane's subject and capability.
- Each pane restores its thread-owned dock tools without copying or lending a
  live tool instance to another pane.
- If the selected dock panel cannot describe the newly active pane, the dock
  shows an explicit unavailable state. It never leaves the previous thread's
  content visible.
- Same-mode, same-Project threads may share one window. Cross-mode,
  cross-Project, or cross-host pinning is refused or offered in a new window,
  preserving the shell authority key.
- Pane placement, proportions, active pane, and pinned thread identities use
  the existing server-authoritative workspace layout and restore behavior.

### Context usage lives in the composer

The active thread's composer carries a compact circular context meter. It is a
status control, not another workspace destination.

- The ring communicates used versus available context and includes an
  accessible text label. Color is never the only signal.
- Clicking, pressing Enter or Space, or using its keyboard shortcut opens a
  popover anchored to the composer. Escape and outside click close it and
  return focus to the meter.
- The popover shows used capacity, maximum capacity, percentage, free space,
  and only the categories Octant can measure honestly, such as messages,
  system prompt, tools, skills, memory, attachments, agent context, and
  automatic compaction reserve.
- Deferred, unavailable, estimated, or provider-reported values say so. The UI
  does not fabricate precise token counts from text length.
- Provider account or plan usage limits may appear below context capacity only
  when the provider reports them authoritatively. Context capacity and account
  limits remain separate concepts.
- The meter and popover always follow the active thread. Switching a pinned
  pane replaces every value and closes any popover that belonged to the
  previous pane.
- The display reads existing context and usage projections. Opening it causes
  no unrequested provider or network call.

### Environment becomes a disclosure, not a second workspace

The current long floating panel is the wrong default. Revise the proposed
Environment decision before implementation:

- the thread header always carries a compact, truthful summary;
- opening the summary shows a transient popover or overlay anchored to the
  thread, not a persisted in-flow panel;
- Escape, outside click, or activating another pane closes it;
- open or closed presentation is renderer state and does not need a journaled
  per-thread preference;
- the Environment answers only checkout identity, changes, local servers, and
  working location;
- Files, Plan, Publish, Agents, Browser, and Review do not live inside it.

For local servers, show one compact row per logical listener. Group duplicate
loopback addresses by process and port. Separate the current checkout from
other listeners. Keep `Open` visible for a usable listener. Put `Copy URL`,
details, and `Stop` in the row menu. Show `Stop` only when Octant owns a safe
stop operation; an unmanaged process says `Unmanaged` and has no fake stop
control.

Working-folder changes are infrequent configuration. Replace the permanent
text field with `Change working folder...`, which opens a focused picker or
dialog and shows the resulting relative folder in the compact summary.

### Review lives in the right dock

Add a thread-scoped `Review` dock surface and make it the destination for local
changes and pull-request review.

- `View diff` becomes `View changes` and opens the dock on Review.
- For a Code thread, Review starts with local checkout changes: changed-file
  list, additions and deletions, selected-file diff, inline or side-by-side
  layout, truncated or stale state, and safe discard only when existing
  authority and approval rules allow it.
- A clean checkout renders a compact clean state in the dock. It never opens a
  blank full-window surface.
- For a selected PR, Review shows description, commits, files, diff, checks,
  reviews, comments, freshness, and the exact linked thread when one exists.
- A Project-level PR list stays in the central workspace while the selected
  PR's detail opens beside it in Review.
- On narrow windows, Review is the dock's accessible drawer.

After every caller uses the Review dock, remove the obsolete full-workspace
Code diff surface, its restore path, and dead renderer branches. Do not keep a
second default diff experience for compatibility in the technical preview.

### Transcript action density

Hide fork and checkpoint actions until the turn is hovered or focused, then
present one `More actions` button. The same menu opens from the turn's context
menu. Keep checkpoint markers visible only when a checkpoint exists. Use
separate copy for:

- `Start a new thread from this point`, which preserves the source thread;
- `Mark checkpoint` or `Forget checkpoint`;
- `Restore working tree to before this turn`, which is destructive, applies
  only to Code, and requires the existing approval and confirmation path.

## Implementation decisions and delivery sequence

### 0. Reconcile product truth and lock the shell decisions

This is a documentation and evidence slice. It does not change product code.

- Verify the landed single-surface pane behavior before accepting its proposed
  decision. Cross-reference it from the accepted shell decision.
- Revise the proposed Environment decision to the compact disclosure described
  above. Do not accept the current always-floating default and then reverse it
  in code.
- Keep source and package builds described as unsigned previews. Signing,
  notarization, and self-update become current product truth only after a real
  signed feed, artifact, install, and update proof exist.
- Separate implemented, available-but-hidden, deferred, and absent behavior in
  the subagent, board, GitHub, and first-run documentation.
- Capture the current thread, Environment, board, Pull Requests, Agents, and
  first-run states as before evidence for later rendered comparisons.

### 1. Simplify the shell and make Review usable

This slice establishes the interaction grammar used by later Agent, board, and
PR work.

- Add the capability-gated Review dock surface and route local `View changes`
  into it.
- Make pinning a sidebar thread into a split pane use the existing workspace
  layout, with an unambiguous active pane and thread-aware dock retargeting.
- Make the dock host real Browser, Terminal, Files, Review, and other
  capability-valid thread tools, including conditional Plan, Delivery, Agents,
  Canvas, and Side chat. Use a compact launcher when empty and a tool strip
  when instances are open.
- Remove the generic Thread dock tool. Promote Files directly, show Plan only
  for a real plan artifact, and do not expose the existing empty plan-authoring
  form in the dock.
- Rename Publish to Delivery and suppress it when no real enabled target or
  actionable plan exists. Make Agents conditional on child state or `Add
agent`, with the compact hierarchy status remaining in the thread header.
- Move Project memory into Project Overview and Navigator into an app-wide
  popover launched from the bottom-left profile and Settings control.
- Add the composer context meter and authoritative breakdown popover. Retire
  the redundant Context dock destination after equivalent information and
  source navigation have a truthful home.
- Retain truthful active-pane scoping and server-owned tool lifecycles when the
  active pane changes.
- Replace the persistent Environment presentation with the compact summary and
  transient disclosure.
- Condense local-server rows, group duplicate listeners, remove unsupported
  actions, and move secondary actions into accessible row menus.
- Replace the permanent working-folder field with a focused action and picker.
- Move fork, checkpoint, and in-place restore into the turn action menu while
  preserving focus, keyboard, screen-reader, and confirmation behavior.
- Remove the full-workspace diff surface only after the dock path has equivalent
  local-change behavior and every caller has migrated.
- Rebalance the central column, typography, spacing, contrast, focus rings, and
  hit targets so the transcript reads as the primary surface at normal and
  narrow widths.

### 2. Make first run lead to real work

Keep the accepted profile and first-run decisions unless a separate decision
explicitly supersedes them. This slice fixes the journey rather than adding
another onboarding system.

- Validate a clean install with no provider, no Project, and no prior settings.
- Keep each accepted answer durable when first run is dismissed or interrupted.
- End in a truthful readiness view with three concrete facts: provider ready,
  Project ready, and a mode-valid default model ready.
- Offer one next action that starts a real thread in the selected mode. If a
  prerequisite is missing, open the exact setup surface and return to the same
  draft afterward.
- Do not advertise Navigator, Work, Agents, boards, or GitHub destinations when
  their server capability is absent.
- Align the guide with what the binary actually does and test resume after
  provider settings, failed writes, skip, restart, and partially completed
  setup.

### 3. Establish one server-authoritative AgentRun control model

The existing fail-closed parent and child mode check lands first. Build on the
existing AgentRun journal and projection rather than creating a second agent
model.

- Add server preparation for child workspaces. Chat gets a virtual workspace.
  Work gets a receipt for the current confined Project root and binding
  revision. Code gets a prepared and then confirmed managed worktree receipt.
- Reject stale, foreign-thread, parent-checkout, unavailable, or
  wider-than-parent receipts before admission.
- Derive mode, Project, provider, model, reasoning, workspace, and maximum
  authority from the parent on the server. The renderer does not type or claim
  identifiers.
- Replace raw authority checkboxes with mode-valid roles such as Research,
  Implement, and Review. Show the resolved provider, model, workspace, and
  authority as read-only facts before creation.
- Keep Chat children research-only. Keep Work children inside the bound root.
  Keep Code implementation and review children in isolated worktrees.
- Select provider-native execution only when the capability report proves the
  required workspace, authority, observability, cancellation, steering, and
  recovery guarantees. Otherwise use Octant-managed execution and show why.
- Provide create, inspect, steer, stop, retry or resume, and acknowledge through
  one hierarchy. Every command is authorized against the parent and expected
  version before side effects.
- Make thread-local control reliable first. Add the Agents Center afterward as
  a projection of the same hierarchy across modes and Projects, not as a new
  execution system.

### 4. Build one Work and Code thread-board model

The board monitors real threads. It is not a task manager and cards never move
manually.

- Put Ready, In Progress, Waiting, and Done derivation in one domain policy
  with mode-specific evidence. The server owns status and the reason behind it.
- Done requires the user-confirmed delivery target and objective evidence. A
  completed model turn alone is not Done.
- Work cards show Project, root binding, active request, artifacts, citations,
  child runs, delivery state, follow-up, recovery, and activity.
- Code cards show Project, checkout or worktree, branch, changed files,
  provider and model, child runs, linked PR evidence, checks, review, delivery
  state, follow-up, recovery, and activity.
- Keep unread state out of server board cards. The client overlays unread from
  its own thread state.
- Board queries never call GitHub. They may display already-cached PR evidence
  with its freshness label.
- `Refresh` re-queries the local authoritative projection only. Keep the last
  useful result during refresh and on failure.
- Use compact columns at wide widths and a grouped list at narrow widths. Show
  the specific Waiting reason on the card. Avoid giant empty columns and
  oversized cards.
- Replace the Work placeholder and the separate Code implementation with the
  shared board surface. Chat has no board.

### 5. Add the manually refreshed Pull Requests workspace

The workspace shows active open and draft pull requests from connected Code
Projects. Merged and closed history is not part of the first dogfood slice.

- A connected repository is an active Code Project whose authorized binding
  resolves to a Git top-level with a verified GitHub.com origin.
- Resolve HTTPS, SCP-style, and `ssh://` GitHub remotes on the server. Never
  accept renderer-authored owner, repository, root, or credential data.
- Use the installed authenticated `gh` CLI. Octant stores no GitHub token.
- Make `Refresh all`, per-Project refresh, and explicit missing-detail load the
  only GitHub network triggers. Opening the app, navigating, querying a board,
  and reading cached PR data issue no GitHub command.
- Refresh repositories sequentially. Bound the preview to 25 connected
  repositories and 100 active PRs, and label truncation rather than silently
  dropping results.
- Keep the last authorized in-memory result on disconnect, timeout, malformed
  output, or rate limit. Show last successful refresh, stale reason, and retry
  time when GitHub supplies one.
- Drop private actionable data when Project authority or GitHub access is
  revoked. Do not persist PR list or detail cache as journal state.
- Group rows by Project and repository. Show title, number, draft state,
  author, branches, update time, checks summary, review summary, linked thread,
  and freshness.
- Selecting a row opens Review in the right dock. A missing detail may load
  once because the user explicitly selected it; cached detail never refreshes
  silently.
- Match a thread only by authorized repository and exact delivery branch or
  recorded PR identity. Never match by title or loose branch text.
- Keep the workspace read-only. Preserve the already-authorized create flow,
  but remove merge, approve, request-changes, comment, close, force-push, and
  other PR mutation commands from the technical-preview product contracts.
- Put repository-context reads behind the existing provider-neutral integration
  boundary. Full GitHub plugin extraction remains a later deliverable.

### 6. Fix confirmed correctness and security gaps

- Make folder browsing honor the search request. Keep search confined to the
  authorized root and return scoped candidate receipts.
- Build breadcrumbs from canonical absolute ancestors and issue valid
  window-and-mode-bound candidates for clickable ancestors. Never reconstruct
  a relative path in the renderer.
- Add a versioned external-content-ingested journal event. Wire browser, tool,
  and imported external-content paths into it and rebuild thread-lifetime taint
  on replay.
- Require fresh confirmation for irreversible actions on a tainted thread after
  restart, even when the thread previously held a broader standing approval.
- Ensure every real desktop, server, and CLI launch path injects the service
  policy store. Unavailable policy remains test-fixture behavior only.
- Keep unregistered routes and uncalled endpoints at zero. Every sidebar
  destination must have a real route and renderer or be absent.

### 7. Remove proven dead and unauthorized code

- Remove PR merge wire contracts, runtime methods, client commands, UI, domain
  policy, and tests after the read-only PR workspace covers required evidence.
- Remove Cursor ACP production exports, settings entries, and compatibility
  contracts while retaining only a clearly named conformance or historical
  probe fixture if a live test still needs it.
- Remove no-op automation fallbacks from product modules. Put unavailable ports
  in test fixtures when tests need them.
- Remove stale wiring exemptions such as a Canvas access-log exemption once a
  live service test proves the route is connected.
- Remove the old full-workspace diff contract and code after Review migration.
- Keep security escape helpers and provider conformance helpers when tests use
  them. Do not reduce the island count by deleting useful safety evidence.
- Do not delete Mobile, Canvas, Automation, provider, or security subsystems
  wholesale. Cleanup requires a caller search, wiring evidence, and focused
  tests proving the path is unused or outside the release boundary.

### 8. Reduce composition concentration without a rewrite

Do not rewrite the main server or renderer composition modules. New behavior
lives in dedicated modules and registers through their current seams. After a
slice stabilizes:

- extract only composition blocks with one clear responsibility and tests at
  their public boundary;
- keep authority and side effects server-side;
- keep schema-only contracts and pure status or policy derivation in the domain;
- avoid adding a second state model for the dock, board, PR cache, or agents;
- remove compatibility branches made obsolete by the technical-preview change
  in the same pull request that replaces them.

### 9. Run the polish and dogfood pass against real states

Polish starts with the shell slice and continues after every feature. It is not
a final CSS-only phase.

- Use real thread, approval, child-run, board, PR, rate-limit, stale, empty,
  error, and first-run states. Do not approve mocked happy-path screenshots as
  sufficient evidence.
- Check normal, narrow, zoomed, reduced-motion, reduced-transparency,
  high-contrast, keyboard-only, and screen-reader-labelled states.
- Keep ordinary panes flat with hairline separation. Use cards only for
  discrete objects. Reserve accent color for selection, status, approval, and
  the primary action.
- Give the transcript a readable maximum width and keep the composer aligned to
  it. Remove empty ornamental space and tiny low-contrast labels.
- Preserve the established semantic tokens and component wrappers. Add tokens
  only for reusable roles, not one-off colors or shadows.
- Use Computer Use to capture and compare the real packaged or development app
  at every shell-changing pull request.

## Public contracts and seams

- Revise Environment presentation so visibility is transient renderer state;
  environment facts remain server-authoritative.
- Add a Review dock subject that can describe local Code changes or a selected
  authorized Project pull request.
- Keep pinned-thread identity and active-pane selection in the existing
  server-authoritative workspace layout. Do not add a parallel pin registry.
- Address dock tool instances by their owning thread or Project context and
  existing server-issued terminal, browser, file, agent, or Canvas identity.
  Do not rebind a live tool by changing renderer focus.
- Add a thread-specific context-usage summary with capacity, measured category
  breakdown, free space, provenance or confidence, and optional authoritative
  provider-limit data. Do not derive account limits in the renderer.
- Remove generic Context, Project memory, Navigator, and Thread dock identifiers
  after their replacement entry points are wired and restored state migrates
  safely.
- Remove the obsolete full-workspace Code diff variant after migration.
- Add server-derived AgentRun creation context, Work-root receipts, prepared
  and confirmed Code worktree receipts, and versioned steer or retry commands.
- Add one mode-neutral board query envelope with separate Work and Code card
  schemas. Do not fill one card type with nullable fields for the other mode.
- Remove server-owned unread from board responses.
- Add authorized repository-context reads and manually refreshed PR summary and
  detail results with freshness, stale reason, pagination or truncation, and
  exact linked-thread identity.
- Add the external-content-ingested journal event and replay projection.
- Remove PR mutation and Cursor ACP production contracts without a compatibility
  shim. Technical-preview clients upgrade with the host.

## Testing decisions

Every behavior change starts with the closest failing test. Tests assert user
or boundary behavior rather than component internals.

### Focused automated tests

- Shell and Review: active-pane retargeting, unavailable subjects, local-change
  loading, file selection, clean and truncated states, narrow drawer, focus
  return, menu keyboard behavior, multi-pane restore, same-authority pinning,
  cross-authority refusal, live Browser and Terminal ownership, dock-tool
  restore, launcher and tool-strip states, and retirement of full-workspace
  diff opens.
- Canvas and context: existing-document identity, authorization, no copied
  Canvas state, composer-meter retargeting, measured and unavailable context
  categories, provider-limit separation, popover focus, and no network call on
  open.
- Dock destinations: direct Files, artifact-gated Plan, Project Overview memory,
  app-wide Navigator popover, restored-state migration, and no generic Thread
  or empty accordion destinations.
- Conditional tools: Delivery appears only for a server-confirmed target or
  plan; Agents appears for an existing hierarchy or explicit creation entry.
- Environment: compact summaries, listener grouping, managed versus unmanaged
  actions, hidden scanning, working-folder dialog, stale checkout, and no
  persisted open state.
- Turns: hover and focus action discovery, context-menu parity, checkpoint
  states, destructive restore copy, approvals, and focus recovery.
- First run: clean state, partial state, failed writes, skip, restart, provider
  settings round trip, Project creation, and first real thread handoff.
- AgentRun: mode mismatch, server-derived route, receipt freshness and scope,
  authority clamp, native eligibility, managed fallback, steering, stop,
  recovery, and replay.
- Boards: Work and Code status reasons, delivery evidence, cached PR evidence,
  client unread overlay, no GitHub calls, refresh preservation, filters,
  grouping, and narrow rendering.
- Pull requests: Project authority, remote parsing, deduplication, sequential
  manual refresh, no passive calls, rate limit, stale retention, revocation,
  malformed output, truncation, exact thread matching, safe external URLs, and
  absence of mutation commands.
- Folder picker: search behavior, canonical breadcrumbs, expired candidates,
  window and mode isolation, root confinement, and keyboard navigation.
- Security: external-content ingestion, restart and replay, named sources, and
  fresh confirmation for irreversible actions.
- Wiring and cleanup: no unregistered routes, no uncalled endpoints, and no
  production import of test-only fallbacks.

### Rendered and native checks

- Render each changed UI in a real desktop or browser host at normal and narrow
  widths.
- Use Computer Use for the first-run journey, a live Code thread, Environment,
  local Review, Agents, both boards, manual PR refresh, rate limit, and linked
  thread navigation.
- Run a packaged desktop smoke with a fake `gh` executable. Assert zero GitHub
  invocations on launch and navigation, one bounded sequential invocation per
  repository on refresh, and no mutation commands.
- When authenticated GitHub access is available, compare one manual refresh
  with `gh pr list --state open` at the same time. Treat this as credentialed
  smoke evidence, not a mandatory local test.

### Repository checks

Run focused format, lint, typecheck, and package tests for each slice, plus
path, wiring, decision, and diff checks. Run the full repository verification
for every cross-package slice and the final program head. Record native process,
socket, packaged, credentialed, or device checks that could not run.

## Dogfood acceptance scenarios

1. Complete or skip first run and reach a truthful ready or not-ready state.
2. Create a Chat research child and verify it has no filesystem or shell
   authority.
3. Create a Work child and verify its root matches the current Work binding.
4. Create a Code implementation child and verify its worktree differs from the
   parent checkout.
5. Steer and stop a running child, then acknowledge a completed result.
6. Open Environment, inspect a compact current-checkout server list, and close
   it without changing layout.
7. Open local changes in Review, select a file, change diff layout, and return
   focus to the thread.
8. Pin two same-Project threads into one window, activate each pane, and verify
   every thread-aware dock panel retargets without showing stale content.
9. Open Browser, Terminal, Files, Review, an existing Plan artifact, Agents, and
   Canvas in one thread's dock, switch to a second thread, and verify no live
   tool is rebound or leaked between them.
10. Open the composer context meter for both pinned threads and verify capacity,
    categories, unavailable values, and provider limits retarget without a
    network call or stale data.
11. Use fork, checkpoint, and destructive restore from the keyboard-accessible
    turn menu and verify their different outcomes.
12. Open Work and Code boards and see truthful status reasons without any GitHub
    call.
13. Refresh both boards while preserving the last useful result.
14. Manually refresh active PRs for two connected Projects and no unrelated
    repository.
15. Open a PR in Review and navigate to its exact linked thread.
16. Simulate GitHub rate limiting and retain labelled stale results.
17. Restart after external-content ingestion and verify an irreversible action
    requires fresh confirmation.
18. Search and navigate folder breadcrumbs without escaping the authorized
    root.
19. Repeat the core path at narrow width and with keyboard-only navigation.
20. Capture normal, narrow, and high-contrast Computer Use evidence for the
    chosen shell and visual direction.
21. Open Project memory from Project Overview and Navigator from the
    bottom-left profile control, and verify neither depends on a generic dock
    tab or changes thread authority.
22. Verify Delivery is absent without an enabled target, appears with an
    actionable server plan, and preserves explicit approval and receipt
    behavior.
23. Verify child status remains in the thread header, Agents is absent for an
    empty hierarchy, and `Add agent` opens the server-derived creation flow.

## Pull-request delivery plan

One pull request delivers one coherent outcome. The expected order is:

1. product truth and decision alignment;
2. Review dock and Environment simplification;
3. transcript action menus and shell visual cleanup;
4. first-run journey fixes;
5. AgentRun workspace preparation and thread-local control;
6. Agents Center projection;
7. shared Work and Code board;
8. manual Pull Requests workspace;
9. folder, taint, wiring, and unauthorized-code cleanup;
10. final cross-flow polish and dogfood evidence.

Dependent pull requests wait for the preceding contract to land. Each branch
uses an isolated worktree, stages exact paths, links its Linear issue in the PR
description, and targets `main`. No pull request is merged without Henrik's
explicit instruction for that pull request.

## Out of scope

- Chat board or a general task Kanban.
- Automatic GitHub polling, webhooks, background retries, or GitHub Enterprise.
- PR merge, approve, request-changes, comment, close, force-push, or other
  mutation beyond the already-authorized create flow.
- Full GitHub plugin extraction before the dogfood path works.
- Linear integration, hosted relay, new schedules, native mobile distribution,
  Intel or non-macOS packaging, and new Canvas capabilities beyond hosting the
  existing authorized Canvas in the dock.
- Wholesale deletion of Mobile, Canvas, Automation, provider, or security code.
- Signing credentials or release publication. The plan may verify release
  readiness but cannot provide maintainer credentials or approval.
- A full rewrite of the main server, renderer composition, or journal model.

## Completion criteria

- The central thread is visually and functionally primary.
- Several same-authority threads can be pinned into one restored split layout,
  and the right dock always follows the active pane without stale content.
- Browser, Terminal, Files, Review, artifact-gated Plan and Delivery,
  conditional Agents, Canvas, Side chat, and other supported tools run inside
  the active thread's dock without replacing the transcript or crossing thread
  authority.
- The generic Context, Project memory, Navigator, and Thread dock tabs are gone.
  Project memory lives in Project Overview, Navigator is an app-wide popover,
  and Plan appears only for a real thread plan artifact.
- Delivery appears only for a real target or actionable plan. Agents appears
  only for an existing hierarchy or explicit `Add agent` action, while compact
  child status stays in the thread header.
- The composer context meter follows the active thread and reports capacity,
  measured breakdown, free space, and optional authoritative provider limits
  without inventing values or contacting the provider on open.
- Environment is compact and temporary, with no wall of server cards or
  permanent working-folder form.
- `View changes` opens useful local review in the right dock, and the old blank
  full-window diff path is gone.
- Secondary turn actions are discoverable through accessible menus and no
  action is right-click-only.
- First run reaches a real thread or names the missing prerequisite precisely.
- Chat, Work, and Code use one server-authoritative AgentRun hierarchy with
  mode-correct workspace and authority.
- Work and Code boards are real projections with specific status reasons,
  local refresh, useful narrow rendering, and no GitHub side effects.
- Pull Requests shows active PRs from authorized connected Projects after
  explicit refresh, retains honest stale data, and opens detail in Review.
- Folder search and breadcrumbs work under server-issued authority.
- External-content taint survives restart and affects irreversible approvals.
- Unsupported PR mutation, Cursor ACP production paths, stale fallbacks, dead
  diff contracts, and proven wiring exemptions are removed.
- Documentation describes the binary that exists, not the intended roadmap.
- The complete dogfood scenarios pass with automated, rendered, and native
  evidence, with unavailable credentialed checks recorded precisely.

## Further notes

This plan intentionally fronts the shell decisions. Agent control, boards, and
pull requests would otherwise land inside an interaction model we already know
is wrong and then require a second migration. The order still preserves the
authority work already in review: fail-closed parent and child mode enforcement
is a prerequisite, not something the shell may weaken.
