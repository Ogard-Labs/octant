# 0001. Plugin architecture

**Status:** Proposed

## Context

Octant is a local-first macOS workspace for Chat, Work, and Code across many AI
providers. Today the renderer, server, and desktop host ship every feature as
built-in code: the Code thread board, GitHub authentication and pull request
surfaces, canvas artifacts, browser and computer-use panes, preview viewers,
agent-run hierarchy, remote pairing, zen appearance packs, automations,
diagnostics export, and the extensions marketplace itself. Each of these adds
sidebar entries, settings sections, server routes, contracts, and event-store
projections that are compiled in whether or not a user wants them.

Compiled-in is not the expensive part; unbounded reach is. A feature built as
host code can call any host code, so the blast radius of adding the next
provider, tool, or integration is the whole product rather than the surface
being extended. That is the driving cost: Octant's stated purpose is breadth
across many providers, so expansion is not an occasional event but the normal
mode of work, and every expansion currently carries a chance of regressing an
unrelated part of the system.

What contains that blast radius is a narrow, enforced boundary, not the fact
that code is loaded as a plugin. A plugin host whose API is wide reproduces the
same coupling and adds indirection on top. So the boundary is the primary
deliverable and the host is what it enables. Two protections follow from it and
should not be conflated: a seam bounds what new code can reach at build time and
is available without a host at all, while process isolation, crash containment,
and user-visible enable/disable require the host described below.

`packages/extensions` already implements the _content_ half of a plugin
system: an `ExtensionPackageManifest` with components (`skill-instructions`,
`mcp-server`, `mcp-tool`, `mcp-prompt`, `mcp-resource`, `hook`, `app`,
`agent`, `apple-development-adapter`), declared capabilities (`filesystem`,
`shell`, `network`, `browser`, `computer-use`, `credentials`, ...), a
fail-closed activation ladder (`resolveExtensionActivation`), per-mode
component and capability policy (`isExtensionComponentModeSafe`), composer
addressing (`@plugin`, `@plugin/component`, `$skill`), an Agent Plugins 1.0.0
loader, and a marketplace/installer flow where install, trust, and enable are
separate state transitions. What it does not have is a way for a package to
contribute _product surfaces_ (a board, a settings page, a provider driver, an
integration with an external service) or a stable public API for third
parties.

The move to a fresh open-source repository is the moment to decide whether
Octant becomes a small host with many toggleable plugins, and how the existing
extensions model grows into that host without weakening its invariants.

## Decision

Octant adopts a plugin host built on the existing extensions model. Built-in
features that are separable become first-party plugins with the same manifest,
activation ladder, and enable/disable controls as third-party plugins. The
server remains the only authority; plugins contribute content and UI, never
policy. `packages/extensions` becomes `@octant/plugin-host` (pure model and
policy) plus a public `@octant/plugin-api` (types and contribution point
schemas). Existing package, component, and capability schemas are extended, not
replaced.

### 1. Plugin kinds and manifest

A plugin is one package that may contribute any mix of these kinds:

| Kind            | What it contributes                                                                       | Executable |
| --------------- | ----------------------------------------------------------------------------------------- | ---------- |
| Skill           | `SKILL.md` instructions (existing `skill-instructions`)                                   | no         |
| MCP server      | stdio or Streamable HTTP tool/prompt/resource server (existing)                           | yes        |
| Hook / agent    | lifecycle hook or agent definition (existing, Code mode only)                             | yes        |
| Provider driver | a `provider-sdk` driver for a model vendor or ACP-compatible agent                        | yes        |
| Integration     | server-side connector to an external service (GitHub, Linear) exposing typed read/write   | yes        |
| UI surface      | renderer contributions: sidebar destination, workspace tab, thread pane, settings section | no         |
| Board           | a server-authoritative board projection plus its renderer view                            | yes        |
| Appearance pack | theme presets, sidebar backgrounds, zen backgrounds, typography bundles                   | no         |
| Preview viewer  | a renderer for a file family in the preview shell                                         | no         |

UI surface, board, appearance, and preview kinds are new component kinds in the
`ExtensionComponentKind` union. Executable kinds keep the existing quarantine
rules; non-executable kinds still require source review before enablement.

The manifest is the existing `ExtensionPackageManifest` (Agent Plugins
`plugin.json` normalizes into it) with these declarations:

- `id`: `@scope/name`; first-party plugins use `@octant/*`. Stable package and
  component UUIDs continue to be seeded from name and source.
- `version`, `digest`, provenance, license, compatibility (`platforms`,
  `modes`, `providerFamilies`, host version range).
- `declaredCapabilities`: the existing capability ceiling, plus
  `integrations:<service>` and `ui` entries. A component may not declare a
  capability its package did not.
- `components[]`: id, kind, declared capabilities, entry point, integrity data.
- `contributions`: typed records per contribution point (see below); rejected
  when the contribution point is unknown to the host version.
- `activationEvents`: `onStartup`, `onMode:<chat|work|code>`,
  `onThreadKind:<kind>`, `onCommand:<id>`, `onSurface:<contribution-point>`,
  `onProviderFamily:<family>`. Activation events schedule loading; they never
  bypass the activation ladder.
- `permissions`: user-facing summary of what the capabilities mean, shown in
  the review checklist; informational only, the capability list is enforced.

### 2. Host contract

**Server enforces.** Everything the marketplace design already requires holds
for every plugin kind, first-party or not:

- Installation never implies trust, activation, enablement, or authority.
  Install, trust, plugin master switch, component switch, compatibility, and
  mode/Project/thread policy remain independent state dimensions resolved
  fail-closed by `resolveExtensionActivation`.
- Disabled components contribute no context: no prompt, schema, tool, route,
  sidebar entry, settings section, or projection subscription.
- Executable components run under the existing supervisor: default-deny
  sandbox, per-scope runtime ownership, drain-then-stop on disable. Integration
  and board plugins run in the server process behind a typed port and receive
  only the ports their capabilities allow; they never receive raw filesystem,
  shell, or credential handles.
- Credentials remain host-owned opaque references through the Keychain
  credential broker. A plugin names a reference; it never receives, stores, or
  refreshes raw token material, and it has no portable credential field in
  manifest or plugin state. Settings OAuth for an integration writes access and
  refresh tokens only to that host service.
- Authority checks occur on the server before side effects. A plugin cannot
  widen mode, Project, thread, provider, sandbox, or approval authority;
  approvals, Plan mode read-only, and Code approval gating apply unchanged to
  any tool a plugin exposes.
- Structured plugin references cannot install, trust, enable, elevate, or
  bypass policy. Skills are discovered only from valid `.agents/skills/`
  packages in the permitted ancestry and user-global directory.
- Every supported provider driver reports capabilities honestly in every mode
  and fails closed when unsupported. No core capability may require a specific
  provider plugin.
- Browser/computer use, tests, Apple validation, approvals, memory, and
  subagents stay app-managed, provider-neutral host capabilities. Core Apple
  development cannot depend on an optional plugin.
- The event journal is authoritative. Plugin projections are namespaced by
  package id, rebuildable, and idempotent.

**Renderer provides.** Contribution points, each a typed slot filled from the
effective activation catalog and re-evaluated when it changes:

- `sidebar.destination` (mode-scoped; today's Thread board and Pull requests
  entries become contributions).
- `workspace.tab`, `thread.pane`, `thread.card.badge`.
- `settings.section` (today's `github`, `usage`, `agents` sections).
- `composer.reference` (existing `@`/`$` palette).
- `preview.viewer`, `appearance.preset`, `board.view`.
- `command` (palette entries and keyboard shortcuts).

Renderer contributions are declarative (manifest records plus a lazily loaded
module behind the host's module allowlist). The renderer never decides
availability; it renders what the server catalog marks effective.

**Toggling.** Enable/disable is the existing plugin master switch and per
component switch, persisted globally, shown per thread as effective state with
a structured block reason. Disabling stops new activation immediately, drains
running executables, removes routes and renderer contributions, and marks the
plugin's projections dormant. Data is kept, not deleted: package files,
component choices, settings, credential references, projections, and event
history remain so re-enabling restores the previous selection. Only uninstall
removes files, and only an explicit confirmation removes host-held credentials
bound to the extension. Turn records that referenced a now-disabled plugin are
not rewritten.

### 3. Built-in plugin candidates

| Candidate                     | What it does today                                                                                                                                           | Why separable                                                                                                                | Coupling | Phase            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| Kanban / thread board         | `codeThreadBoardService`/`CodeThreadBoard` and `workThreadBoardService`/`WorkThreadBoard` derive Ready/In progress/Waiting/Done cards from the shared policy | Pure projection over thread metadata plus one sidebar destination                                                            | low      | bundled, enabled |
| GitHub integration            | `gh` auth, repository catalogue, clone, PR create/observe/mergeability, PR pane, PR list sidebar entry                                                       | All behind `gh` ports and `/api/github/*`; Code works without it                                                             | medium   | bundled, enabled |
| Linear integration (planned)  | Not yet built; Settings connection, issue browse, later intake and delivery-target sync                                                                      | New code, no existing coupling; first proof of the Integration kind. Add as a plugin; do not compile it into the host first. | low      | bundled, off     |
| Canvas artifacts              | Canvas event store, share service, skill contributions, renderer blocks and panels                                                                           | Own contracts and store; large surface with its own skill hooks                                                              | medium   | bundled, enabled |
| Browser / computer use panes  | `BrowserWorkspace`, computer-use lifecycle surface, desktop runtime broker                                                                                   | UI is separable; the capability itself stays app-managed per invariants                                                      | high     | later            |
| Preview viewers               | PDF, slides, table, workbook, document viewers behind `PreviewRegistry`                                                                                      | Registry already exists; each viewer is an independent module                                                                | low      | bundled, enabled |
| Zen mode and backgrounds      | Zen surface, assistant, background store and routes, appearance panel                                                                                        | Self-contained routes and store; appearance pack is the model case                                                           | low      | bundled, enabled |
| Theme presets / appearance    | Theme presets, sidebar backgrounds, typography bundles                                                                                                       | Static assets plus registry entries                                                                                          | low      | bundled, enabled |
| Agent-run hierarchy           | Agent run creation, supervisor, projection, hierarchy panel                                                                                                  | Subagents are a core capability; only the panel and settings are separable                                                   | high     | later            |
| Automations center            | Automation definitions, editor, notifications                                                                                                                | Own routes and store, sidebar entry already gated                                                                            | medium   | bundled, off     |
| Remote pairing / mobile       | Pairing, private listener, remote gateway, mobile app                                                                                                        | Off by default already; listener lifecycle touches host security                                                             | high     | later            |
| Diagnostics export            | Export CLI, routes, settings control                                                                                                                         | Single command plus settings entry                                                                                           | low      | bundled, enabled |
| Usage dashboard               | Usage routes, model, dashboard view                                                                                                                          | Projection plus settings section                                                                                             | low      | bundled, enabled |
| Navigator assistant           | Sidebar assistant with binding store and settings                                                                                                            | Optional helper; own service and settings                                                                                    | medium   | bundled, off     |
| Apple development workbench   | Xcode discovery, simulator, validation evidence                                                                                                              | Core Apple development is app-managed; only optional adapters plug in                                                        | high     | later            |
| MCP registry / marketplace UI | Catalog search, preview, install views                                                                                                                       | Host feature; must exist to install anything else                                                                            | high     | stays in host    |
| Provider drivers              | Per-vendor drivers under `provider-sdk`; generic ACP stack                                                                                                   | Driver interface exists; each vendor becomes a provider plugin                                                               | medium   | bundled, enabled |

Boards for Work and Code remain server-authoritative; Chat gets no board.
Moving the board into a plugin does not create a general task Kanban.

GitHub issue browse and create-from-issue, when implemented, stay on the
existing first-party GitHub plugin: a second `sidebar.destination`
(`github-issues`), catalogue reads gated by `issues-read` through
`/api/github/catalogue/reads`, and create-from-issue framing that never writes
back. That work must not take a shortcut a later GitHub plugin could not take,
and it does not wait for step 5 extraction. Disabled GitHub contributes no
Issues row. See
[github-repository-onboarding-threat-model.md](../security/github-repository-onboarding-threat-model.md).

### 4. Migration sequence

Once the seams exist, order the moves by how often a surface expands, not by how
cheap it is to move. Containment is only worth what it covers, so a sequence that
ends with the surfaces that change weekly leaves the driving cost unpaid until
the end. This trades away the original ordering's appeal, which was to prove the
machinery on kinds with no server authority surface first. The trade is
acceptable for provider drivers specifically, because that boundary is the
repository's most mature: `packages/provider-sdk` already owns the driver
interface and a conformance harness, so moving vendors behind it exercises an
established seam rather than betting the first move on an unproven one. It would
not be acceptable for kinds whose contribution points do not exist yet.

1. **Rename and publish the API.** Move `packages/extensions` to
   `packages/plugin-host`; extract the schemas third parties need into
   `packages/plugin-api` (manifest, component kinds, capabilities, contribution
   point records, activation events). No behavior change; existing tests move.
2. **Add renderer contribution points.** Introduce the contribution registry
   and convert the existing hard-coded sidebar destinations and settings
   sections to registry entries populated from a static first-party manifest
   list. Availability still comes from the server catalog.
3. **Provider drivers as plugins.** Register vendor drivers through the
   provider-driver kind once the generic ACP stack has landed, keeping the
   honest-capability and fail-closed rules in the host. First because adding and
   revising vendors is the repository's highest-frequency expansion, so it is
   where unbounded reach costs the most.
4. **Integration port and plugin renderer seam.** Publish a provider-neutral
   typed server port for the Integration kind, and open `settings.section` and
   `sidebar.destination` so the host renders a plugin module rather than a
   host-compiled Settings registry and two hard-coded destination ids. These
   are host changes. They land before any Integration plugin, including Linear,
   and before GitHub is extracted. Widening either seam for one vendor is not
   a substitute. If Chat or Work must browse an integration, that is a separate
   provider-neutral host mode-policy change; it is not folded into a vendor
   plugin. The Integration kind stays Code-mode-safe, and Chat still forbids
   the `credentials` capability, until that host change lands.
5. **First integration and board plugins.** Move the thread board and GitHub
   behind those ports. Add Linear as the first bundled-off integration plugin
   through the same ports — new code, not an extraction. Do not wire Linear
   into server internals the way GitHub is today and extract it later; that is
   the migration risk this record warns about. Linear may land before GitHub is
   extracted only after the shared port and renderer seam exist. Credentials
   stay host-owned opaque references; Settings OAuth stores Linear access and
   refresh tokens only in the host credential service, never in plugin state.
   Linear does not widen mode policy: its executable and credentials stay in
   Code unless the separate host mode-policy change in step 4 has already
   landed. Second because external services change on their own schedule, so
   these surfaces are revised without the change ever originating in Octant.
6. **Appearance and preview kinds.** Package zen backgrounds and preview viewers
   as `@octant/*` plugins loaded from the bundled catalog and enabled by
   default. Last because they are the surfaces that change least, so moving them
   buys the least containment; they remain worth moving for the user-facing
   enable/disable and packaging benefits.

Each step keeps `git diff --check`, existing extension conformance tests, and
the activation ladder tests green; a step that requires weakening an invariant
is out of scope.

Step 1 landed with one deviation from the text above: `packages/extensions`
renamed to `packages/plugin-host` as described, but `packages/plugin-api` is a
curated re-export of `@octant/contracts/extensions` rather than a physical
schema relocation. The manifest composes core primitives (`OctantMode`,
`ToolExtensionId`) that `packages/contracts` already owns and that
`packages/plugin-api` cannot depend on without inverting `packages/contracts`'
zero-first-party-dependency invariant (0004). Re-export preserves that
invariant and still gives third parties a narrow, named import surface;
physical extraction would require first factoring those shared primitives
into a package below both, which is out of scope here. Step 2 landed: renderer
contribution-point schemas (`sidebar.destination`, `settings.section`,
`workspace.tab`, `thread.pane`, `preview.viewer`, `appearance.preset`,
`board.view`) live on the existing manifest version, and unknown points are
rejected. The renderer registry
(`apps/web/src/shell/contributionRegistry.ts`) resolves each point from a
static first-party manifest catalog and the effective activation map; it does
not decide availability. Bundled `@octant` appearance-pack and preview-viewer
plugins prove those two points: the branded Octant theme preset and the
structured preview viewers come from those contributions and disappear when
the component is not effective. Settings sections still come from the
host-compiled `octantSettingsRegistry`, and sidebar destinations other than
`thread-board` and `pull-requests` are discarded, so plugin-provided Settings
and navigation are not yet a published seam. Completing that seam, and
publishing the Integration port, are step 4 and land before Linear. Extracting
the thread board and GitHub remains step 5. Linear is not on that extraction
list: it is added as a bundled-off plugin through the Integration kind after
those host seams exist. Packaging remaining zen/appearance assets and every
viewer as separable `@octant/*` plugins remains step 6. Marketplace/host stays
in the host. Connector/OAuth marketplace stays Later; a first-party Linear
plugin is not that marketplace. Step 3 landed: each in-tree vendor driver is a
bundled, enabled-by-default `provider-driver` plugin. The host admits a driver
only when that component is effective, so a disabled or incompatible plugin
contributes no models, tools, or capabilities. Honest capability reporting and
fail-closed unsupported modes stay host-enforced through `provider-sdk`; plugins
do not declare provider capabilities of their own. The generic ACP stack remains
a host capability that ACP vendor plugins configure — there is no second ACP
runtime. Provider Settings rows remain host-compiled; this step does not open a
Settings-section plugin seam.

## Consequences

- Product surfaces become explainable: every sidebar entry, pane, and settings
  section traces to a package id and an effective-state reason.
- The host shrinks and the number of first-party packages grows; release
  packaging must bundle and pin them, and the bundled catalog becomes part of
  the release boundary.
- Third parties get a stable, documented API, which means contribution point
  schemas need versioning and deprecation discipline from the start.
- Some features cannot be fully separated without violating invariants
  (browser/computer use, subagents, Apple validation, marketplace). Their
  panels may become plugins; their capabilities stay in the host.
- More indirection in the renderer; contribution rendering must stay lazy so
  disabled plugins cost nothing at startup.
- Migration risk concentrates in the GitHub and canvas moves, which touch
  routes, contracts, and event projections at once. Moving code to prevent
  regressions can cause them, so extraction is its own deliberate change with
  its own evidence, never folded into an unrelated fix or feature.
- Ordering by expansion frequency front-loads the surfaces with server
  authority, so the earlier steps carry more risk per step than the original
  sequence did. The payoff is that containment arrives where changes actually
  land, instead of after every cheap move is exhausted.

## Open questions

1. Should first-party plugins that are bundled and enabled be uninstallable, or
   only disableable, in the first release?
2. Which contribution points are frozen for the public API in the first
   release, and which stay first-party only until they stabilize?
3. Does a plugin get one shared `PLUGIN_DATA` per package or one per
   host/mode/Project scope, given boards and integrations project per-Project
   data?
4. Where does the generic ACP stack live: as a host capability that provider
   plugins configure, or as itself a plugin that other provider plugins depend
   on? **Resolved:** it stays a host capability. ACP vendor plugins configure the
   existing generic stack; they do not ship a second ACP runtime.
