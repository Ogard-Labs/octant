# Octant roadmap

One consolidated view of where Octant is going. It replaces the older
per-feature status tables and deferred registers. Items are grouped by
horizon, not by date; an item moves forward only when the smallest useful slice
is defined and its prerequisites are stable. Planning detail lives in the issue
tracker; this document records direction.

## Now — technical preview

The first release is an Apple Silicon technical preview. Declared releases
are signed with a Developer ID, notarized, and update themselves. A local
package is unsigned because signing needs maintainer credentials.
Everything here is merged or being hardened for it.

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
  worktrees, repository test discovery, PR observation and creation, thread
  board, Environment summary with local-server discovery, external-editor handoff.
- **Work workspace** — confined document production (docx, pptx, pdf, image),
  research with citations, project overview, secure split-view previews, board.
- **App-managed, provider-neutral tools** — browser automation, macOS
  computer use with allowlists, confined test runner, Apple Development
  Workbench (Xcode discovery, Simulator, validation evidence).
- **Extensions marketplace** — hostile package inspection, install/trust/enable
  as separate steps, quarantined executables, skill discovery from
  `.agents/skills/`, structured `@plugin` and `$skill` addressing.
- **Unified subagents** — managed children run as in-process provider sessions
  with clamped authority, isolated worktrees, hierarchy panel, and durable
  results.
- **Remote access** — pairing, revocable device keys, HTTPS private listener on
  LAN or Tailscale, fail-closed remote route policy, paired-browser client.
- **Shell and appearance** — borderless macOS shell, dockable tabs and splits,
  command palette, semantic themes and presets, sidebar materials, Zen focus
  workspace with backgrounds, notes, checklists, and timer.
- **Operations** — usage dashboard, diagnostics export, first-run onboarding,
  packaged desktop smoke scripts.

Hardening in progress for the preview:

- Run the end-to-end acceptance scenarios on real macOS hardware; CI cannot
  substitute for platform- and credential-gated checks.
- Remote reconnect replay is in: a client that sleeps through events catches up
  from the authoritative snapshot, keeps retrying when the host is unreachable
  rather than freezing the thread, renews a session whose window closed while
  the machine slept, and stays paired through a moment of no network. What is
  still open is proving it on real hardware across a genuine sleep/wake cycle.
- Dogfood-driven fixes as they surface.

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
    work. Linear is not an extraction: it is added as a bundled-off plugin
    through the Integration kind and must not be compiled into the host first.
    The shared integration port and a renderer seam that actually renders
    plugin Settings sections and sidebar destinations land before Linear.
    Linear Settings OAuth now uses those ports as a bundled-off plugin; tokens
    stay in the host credential service.
- **Linear integration** — the first bundled-off integration plugin, after
  those host seams: Settings connection (OAuth tokens stored only as host
  credential-service opaque refs, never in plugin state) is in; read-only issue
  browse in Code first, then issue intake and delivery-target sync, with the
  same authority model as GitHub. Chat or Work Linear browsing is a separate
  host mode-policy change, not a plugin side effect. Not a connector/OAuth
  marketplace.
- **Headless host and multi-host federation** — run the server and web client
  without Electron on macOS or Linux; pair desktop and web clients with several
  hosts, show an `All Hosts` view, and choose the destination host per new
  thread. Hosts never trust each other; offline host data is stale and
  read-only.
  - The first isolation tracer is in progress: a Linux Station owns one gVisor
    execution capsule per Code thread or writing child, with independent clones,
    fixed-size private disk images, resource admission, deny-default networking,
    reviewed bundle export, and explicit release. Product thread wiring,
    Station provisioning, Devices and Machines navigation, and E2B Disposable
    Desktops remain separate follow-up deliveries.
- **Canvas artifacts** — provider-neutral interactive reports, dashboards, and
  agent controls with journaled lifecycle; sharing only after secure local use.
- **Automation Center** — host-owned, Project-bound agent schedules that create
  ordinary Work or Code threads with durable occurrence recovery.
- **Native agent harness** — Octant-owned agent loop for direct and local
  endpoints with app-managed tools, Goals, roles, session trees, and CLI
  parity with the GUI.
- **Dogfood-driven fixes** — whatever daily use of the preview surfaces first.

## Later

Explicitly deferred by the current release boundary, except where a later
decision opens a slice. Each remaining item needs its own design before work
starts.

- **Windows desktop confinement and credentials** — the identical desktop app
  (0058) sequences Windows after Linux + macOS parity; Work/Code stay
  `incompatible` until a Windows sandbox ADR exists.
- **Mobile maturity** — device builds, live push notifications, native capture,
  voice input, and public store distribution for the Expo client.
- **Hosted relay** — only if LAN, Tailscale, or SSH cannot satisfy a concrete
  reachability need; local-first remote access comes first.
- **Connector / OAuth marketplace** — OAuth, revocation, publisher trust, and
  data boundaries are much larger than plugin distribution.
- **Full LSP / extension host / debugger** — Monaco and explicit external-editor
  handoff remain primary; a full IDE would run as a separately launched
  companion.
- **Apple devices and distribution** — physical devices, provisioning,
  TestFlight, and App Store submission on top of the Simulator loop.
- **Provider identity extensions** — Azure Entra ID/OAuth and full Amazon
  Bedrock Converse/IAM adapters beyond the API-key paths.
- **Remote SSH development environments**, **live guest sharing**, **thread
  retention and purge**, **usage spend ceilings**, **agent-to-agent
  messaging** (authority model in
  [decisions/0060-agent-to-agent-messaging.md](decisions/0060-agent-to-agent-messaging.md);
  implementation waits on acceptance), and **in-app changelog** — each waits
  on the foundation named in its own design note.

## Not planned

Intentionally out of scope; changing this requires an approved design change.

- **General task Kanban** — boards are runtime-derived Work and Code thread
  boards only; Chat has no board and work-list items never become cards.
- **Swarm, Dispatch, race, or model-comparison launch surfaces** — replaced by
  unified subagents.
- **Features that mutate pull requests** (merge, force-push, review approval)
  from the desktop, unless a specific design authorizes them.
- **Octant-operated cloud accounts or telemetry** — the product stays
  local-first and privacy-preserving by default.
- **Auto-installing or auto-updating provider runtimes** — Octant detects
  binaries, versions, and readiness but never installs them.
- **Core capabilities that require a specific provider or an optional
  extension** — browser/computer use, tests, Apple validation, approvals,
  memory, and subagents stay app-managed and provider-neutral.
