# Octant roadmap

One consolidated view of where Octant is going. It replaces the older
per-feature status tables and deferred registers. Items are grouped by
horizon, not by date; an item moves forward only when the smallest useful slice
is defined and its prerequisites are stable. Planning detail lives in the issue
tracker; this document records direction.

## Now — technical preview

What the first release includes and defers is stated once, in the
[Current Release Boundary](architecture.md#current-release-boundary). Everything
here is merged or being hardened for it.

- **Chat, Work, and Code as server-enforced modes** — virtual Chat Projects, one
  confined root per Work Project, one confined directory per Code Project,
  approval-gated Code with read-only Plan mode, explicit Work-to-Code promotion.
- **Durable event platform** — SQLite journal, rebuildable projections,
  forward-only migrations with backup, crash and restart recovery, `db:*`
  tooling.
- **Provider registry with honest capabilities** — direct HTTP, SDK/RPC, and
  ACP-based drivers (one generic ACP stack with per-provider profiles) behind
  one conformance harness; provider-first model picker; in-thread provider and model changes; Keychain-backed credentials.
- **Code workspace** — Monaco editor, file explorer, terminals, Git and
  worktrees, repository test discovery, PR observation and creation, a
  person's confirmed PR merge from its review, thread board, Environment summary with local-server discovery, external-editor handoff.
- **Work workspace** — confined document production (docx, pptx, pdf, image),
  research with citations, project overview, secure split-view previews, board.
- **App-managed, provider-neutral tools** — browser automation, macOS
  computer use with allowlists, confined test runner, Apple Development
  Workbench (Xcode discovery, Simulator, validation evidence).
- **Extensions marketplace** — hostile package inspection, install/trust/enable
  as separate steps, quarantined executables, skill discovery from
  `.agents/skills/` and `.claude/skills/`, structured `@plugin` and `$skill`
  addressing.
- **Unified subagents** — managed children run as in-process provider sessions
  with clamped authority, isolated worktrees, hierarchy panel, and durable
  results.
- **Agent-to-agent messaging** — a Code thread's agent can leave a bounded
  message for another thread of the same Project through
  `octant_agent_message`; the host delivers it as framed, untrusted data at
  the start of that thread's next turn, and the Agents center shows the
  bounds. Design and
  [threat model](security/agent-to-agent-messaging-threat-model.md) approved
  2026-10-12; messaging across Projects, modes, or child runs is not offered.
- **Remote access** — pairing, revocable device keys, HTTPS private listener on
  LAN or Tailscale, fail-closed remote route policy, paired-browser client.
- **Shell and appearance** — borderless macOS shell, dockable tabs and splits,
  command palette, semantic themes and presets, sidebar materials, Zen focus
  workspace with backgrounds, notes, checklists, and timer.
- **Routines (Automation Center)** — host-local, Project-bound schedules that
  start ordinary Work or Code threads under a capped authority, with durable
  occurrence recovery and no cloud wake.
- **Operations** — usage dashboard, optional Project and thread spend
  ceilings over tokens, turns, run time, and money, checked at turn admission
  (tokens by atomic reservation; money, turns, and run time against recorded
  and in-flight spend), thread retention windows and confirmed purge, diagnostics export,
  first-run onboarding, packaged desktop smoke scripts, and What's new from
  bundled notes plus a signed summary when an update is offered.

Hardening in progress for the preview:

- Run the end-to-end acceptance scenarios on real macOS hardware; CI cannot
  substitute for platform- and credential-gated checks.
- Remote reconnect replay is in: a client that sleeps through events catches up
  from the authoritative snapshot, keeps retrying when the host is unreachable
  rather than freezing the thread, renews a session whose window closed while
  the machine slept, and stays paired through a moment of no network. What is
  still open is proving it on real hardware across a genuine sleep/wake cycle.
- Dogfood-driven fixes as they surface.
- Internal TestFlight packaging for the existing mobile remote client: signing,
  protected CI, Apple processing, and real-device acceptance are separate
  gates under [0147](decisions/0147-internal-testflight-carries-the-existing-remote-client.md).
- Four shipped features take bug fixes only until the preview ships: artifact
  replica sync, the artifact mirror, model role slots, and local provider usage
  history.

## Next

- **Plugin architecture** — grow the extensions model into a plugin host so
  separable first-party features ship as toggleable `@octant/*` plugins with
  the same manifest, activation ladder, and enable/disable controls as
  third-party ones. Direction and migration order are in
  [decisions/0001-plugin-architecture.md](decisions/0001-plugin-architecture.md).
  - `@octant/plugin-api` extracted as a narrow, curated re-export of
    `@octant/contracts/extensions` (manifest, component kinds, capabilities),
    plus `board`/`integration`/`ui-surface`/`appearance-pack`/`preview-viewer`
    /`provider-driver` kinds and renderer contribution schemas (`sidebar.destination`,
    `settings.section`, `workspace.tab`, `thread.pane`, `preview.viewer`,
    `appearance.preset`, `board.view`). The renderer registry resolves every
    point from a static first-party catalog; disabled components contribute
    no sidebar entry, settings section, appearance preset, or preview viewer.
    In-tree vendor drivers register as bundled `provider-driver` plugins and
    reach the host only through `provider-sdk`; the generic ACP stack stays a
    host capability those plugins configure.
  - First bundled plugins: an appearance pack (Octant theme preset) and
    structured preview viewers, as proof those points work. Extracting the
    thread board and GitHub behind typed server ports remains later sequenced
    work. Linear is not an extraction: it is a bundled plugin through the
    Integration kind, built on the shared integration port and the renderer
    seam for plugin Settings sections and sidebar destinations; tokens stay in
    the host credential service.
- **Linear integration** — the first bundled Integration plugin, enabled by
  default like GitHub; nothing reaches Linear until the person connects an
  account. Settings connection (OAuth tokens stored only as host
  credential-service opaque refs, never in plugin state), read-only issue
  browse in Code, and issue intake through `Create from…` are in;
  delivery-target sync is next, with the same authority model as GitHub. Chat or Work Linear browsing is a separate
  host mode-policy change, not a plugin side effect. Not a connector/OAuth
  marketplace.
- **Connectors** — opened on 2026-10-20: MCP servers added by hand, imported
  from other tools on this Mac, or chosen from a bundled catalog, with sign-in
  through the MCP authorization flow, under the architecture's
  [connector rules](architecture.md#extensions-and-skills).
- **Headless host and multi-host federation** — run the server and web client
  without Electron on macOS or Linux; pair desktop and web clients with several
  hosts, show an `All Hosts` view, and choose the destination host per new
  thread. Hosts never trust each other; offline host data is stale and
  read-only.
  - Per-thread isolation on a Linux Station is not built: Code threads on a
    Linux host run under the same Bubblewrap confinement as every other
    confined process. Station provisioning, Devices and Machines navigation,
    and [disposable desktops](design/disposable-desktops.md) remain separate
    follow-up deliveries.
- **Canvas artifacts** — provider-neutral interactive reports, dashboards, and
  agent controls with journaled lifecycle; sharing only after secure local use.
- **Native agent harness** — Octant-owned agent loop for direct and local
  endpoints with app-managed tools, Goals, roles, session trees, and CLI
  parity with the GUI.
- **Dogfood-driven fixes** — whatever daily use of the preview surfaces first.

## Later

Outside the technical preview. Except for Windows, which stays sequenced
behind the preview, these are post-preview tracks the maintainer authorized on
2026-10-26 under the
[Current Release Boundary](architecture.md#current-release-boundary). Each is
design-first: work starts only once its owning specification documents its
authority, privacy, and release boundaries.

- **Windows desktop confinement, credentials, and packaging** — the identical
  desktop app (0058) sequences Windows after the macOS technical preview and
  Linux self-update evidence on a real image, per the
  [release boundary](architecture.md#current-release-boundary); no Windows
  work starts before both exist; Work/Code stay `incompatible` until an
  approved Windows confinement design is documented in the architecture.
- **Mobile maturity after internal TestFlight** — Android device builds, live
  push notifications, native capture, voice input, and public store
  distribution for the Expo client. Design:
  [Mobile maturity](design/mobile-maturity.md).
- **Hosted relay** — designed as an opt-in, self-hostable, ciphertext-only
  fallback for already-paired apps, accepted 2026-10-26 as self-hosted only;
  no reachability gap over LAN, Tailscale, or SSH has been demonstrated, and an
  Octant-run relay waits on written evidence of one. Design: [design/hosted-relay.md](design/hosted-relay.md).
- **Full LSP / extension host / debugger** — Monaco and explicit external-editor
  handoff remain primary; a full IDE would run as a separately launched
  companion. Design gates:
  [release-boundary holds](release-boundary-holds.md#full-lsp--extension-host--debugger).
- **Provider identity extensions** — Azure Entra ID/OAuth and full Amazon
  Bedrock Converse/IAM adapters beyond the API-key paths. Design:
  [Enterprise provider identity](design/enterprise-provider-identity.md).
- **Disposable Linux desktops for headless hosts** — short-lived desktops a
  headless host can drive.
- **Third-party provider-driver plugins** — outside drivers admitted to the
  provider catalog through the published seams.
- **EU/GDPR compliance package** — pending legal review.
- **Live guest sharing** — waits on the foundation named in its own design
  note; not among the 2026-10-26 tracks.

## Not planned

Intentionally out of scope; changing this requires an approved design change.

- **General task Kanban** — boards are runtime-derived Work and Code thread
  boards only; Chat has no board and work-list items never become cards.
- **Swarm, Dispatch, race, or model-comparison launch surfaces** — replaced by
  unified subagents. The one authorized exception is the Project planner
  thread ([0065](decisions/0065-project-planner-thread.md)): a single
  designated Code thread per Code Project that reads the Project's board and
  proposes work the user must explicitly confirm. It launches and redirects
  nothing.
- **Other pull-request mutation and agent-initiated merge** — force-push,
  review approval, comments, closing, and any merge an agent or remote client
  starts. The person's own confirmed merge and an agent opening or editing
  its own thread's draft, ready, or stacked pull request on request are the
  exceptions ([architecture](architecture.md#modes-chat-work-and-code)).
- **Octant-operated cloud accounts or telemetry** — the product stays
  local-first and privacy-preserving by default.
- **Auto-installing or auto-updating provider runtimes** — Octant detects
  binaries, versions, and readiness but never installs or silently updates
  them; explicit provider-owned update actions remain user-triggered.
- **Core capabilities that depend on an optional extension** — browser/computer
  use, tests, Apple validation, approvals, memory, and subagents stay
  app-managed and provider-neutral. Beyond them, a first-class provider may
  offer a capability in full while every other provider gets a documented
  degraded form or reports the capability unsupported
  ([architecture](architecture.md#overview-and-principles)).
