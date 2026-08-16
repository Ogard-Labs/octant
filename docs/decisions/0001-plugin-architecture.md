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
removes files, and extension-owned credentials only after explicit
confirmation. Turn records that referenced a now-disabled plugin are not
rewritten.

### 3. Built-in plugin candidates

| Candidate                     | What it does today                                                                                         | Why separable                                                              | Coupling | Phase            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------- | ---------------- |
| Kanban / thread board         | `codeThreadBoardService` and `CodeThreadBoard` derive Ready/In progress/Waiting/Done cards; Work board too | Pure projection over thread metadata plus one sidebar destination          | low      | bundled, enabled |
| GitHub integration            | `gh` auth, repository catalogue, clone, PR create/observe/mergeability, PR pane, PR list sidebar entry     | All behind `gh` ports and `/api/github/*`; Code works without it           | medium   | bundled, enabled |
| Linear integration (planned)  | Not yet built; issue intake and delivery-target sync                                                       | New code, no existing coupling; first proof of the integration kind        | low      | bundled, off     |
| Canvas artifacts              | Canvas event store, share service, skill contributions, renderer blocks and panels                         | Own contracts and store; large surface with its own skill hooks            | medium   | bundled, enabled |
| Browser / computer use panes  | `BrowserWorkspace`, computer-use lifecycle surface, desktop runtime broker                                 | UI is separable; the capability itself stays app-managed per invariants    | high     | later            |
| Preview viewers               | PDF, slides, table, workbook, document viewers behind `PreviewRegistry`                                    | Registry already exists; each viewer is an independent module              | low      | bundled, enabled |
| Zen mode and backgrounds      | Zen surface, assistant, background store and routes, appearance panel                                      | Self-contained routes and store; appearance pack is the model case         | low      | bundled, enabled |
| Theme presets / appearance    | Theme presets, sidebar backgrounds, typography bundles                                                     | Static assets plus registry entries                                        | low      | bundled, enabled |
| Agent-run hierarchy           | Agent run creation, supervisor, projection, hierarchy panel                                                | Subagents are a core capability; only the panel and settings are separable | high     | later            |
| Automations center            | Automation definitions, editor, notifications                                                              | Own routes and store, sidebar entry already gated                          | medium   | bundled, off     |
| Remote pairing / mobile       | Pairing, private listener, remote gateway, mobile app                                                      | Off by default already; listener lifecycle touches host security           | high     | later            |
| Diagnostics export            | Export CLI, routes, settings control                                                                       | Single command plus settings entry                                         | low      | bundled, enabled |
| Usage dashboard               | Usage routes, model, dashboard view                                                                        | Projection plus settings section                                           | low      | bundled, enabled |
| Navigator assistant           | Sidebar assistant with binding store and settings                                                          | Optional helper; own service and settings                                  | medium   | bundled, off     |
| Apple development workbench   | Xcode discovery, simulator, validation evidence                                                            | Core Apple development is app-managed; only optional adapters plug in      | high     | later            |
| MCP registry / marketplace UI | Catalog search, preview, install views                                                                     | Host feature; must exist to install anything else                          | high     | stays in host    |
| Provider drivers              | Per-vendor drivers under `provider-sdk`; generic ACP stack                                                 | Driver interface exists; each vendor becomes a provider plugin             | medium   | bundled, enabled |

Boards for Work and Code remain server-authoritative; Chat gets no board.
Moving the board into a plugin does not create a general task Kanban.

### 4. Migration sequence

1. **Rename and publish the API.** Move `packages/extensions` to
   `packages/plugin-host`; extract the schemas third parties need into
   `packages/plugin-api` (manifest, component kinds, capabilities, contribution
   point records, activation events). No behavior change; existing tests move.
2. **Add renderer contribution points.** Introduce the contribution registry
   and convert the existing hard-coded sidebar destinations and settings
   sections to registry entries populated from a static first-party manifest
   list. Availability still comes from the server catalog.
3. **First bundled plugins.** Package zen backgrounds and preview viewers as
   `@octant/*` plugins loaded from the bundled catalog and enabled by default.
   This proves appearance and preview kinds with no server authority surface.
4. **First integration and board plugins.** Move the thread board and the
   GitHub integration behind the integration and board component kinds with
   typed server ports; add Linear as the first bundled-off integration.
5. **Provider drivers as plugins.** Register vendor drivers through the
   provider-driver kind once the generic ACP stack has landed, keeping the
   honest-capability and fail-closed rules in the host.

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
into a package below both, which is out of scope here. Step 2 landed narrowly:
a `sidebar.destination` contribution registry (`apps/web/src/shell/contributionRegistry.ts`)
replaces the hard-coded thread-board/pull-requests availability check;
`settings.section` and the remaining contribution points (panes, preview
viewers, appearance) are not yet built.

Step 4 landed the board half. `apps/server/src/extensions/firstPartyPlugins.ts`
seeds a real `@octant/board` package (component kind `board`, zero declared
capabilities, `entryPoint: "builtin:board"`, an opaque marker never handed to
the Agent Plugins loader — the board stays statically wired in `server.ts`)
idempotently into the projection at startup by appending the same
install-committed / source-trust-changed / plugin-desired-state-changed /
component-desired-state-changed events the real lifecycle commands produce.
It is a real row in the existing Settings > Plugins UI, toggleable through the
existing generic commands — no new toggle UI was built.
`apps/server/src/extensions/firstPartyPluginGate.ts` resolves board's
effective state by reusing the server's existing `ExtensionActivationService`
instance and the unmodified activation ladder — the same ladder third-party
plugins go through, not an analogy. `apps/server/src/codeRoutes.ts`'s `board`
route case gates on it, returning the existing `unavailable` failure shape;
`CodeThreadBoard`'s already-existing `loadBoard` error handling (not new code)
surfaces that as an inline "board is unavailable" state with the server's
message. The board's sidebar entry visibility was **not** wired to this live
state: `apps/web/src/shell/ShellSidebar.tsx`'s `FIRST_PARTY_PLUGINS_EFFECTIVE`
stays a stub. The board's manifest declares Code-only compatibility but its
sidebar contribution spans Work and Code (matching pre-existing behavior), so
a single per-component boolean can't represent a mode-scoped effective state
correctly; making the sidebar row itself reactive needs a small design of its
own (likely a live per-mode query, not a static bootstrap field) and is
deferred to a focused follow-up shared with the GitHub half of this step.

Step 4's GitHub half landed the same way, reusing every piece above rather
than inventing parallel ones. `seedFirstPartyPlugins` now seeds `@octant/github`
alongside `@octant/board` (component kind `integration`, capabilities
`network`/`credentials`/`external-application`, `entryPoint: "builtin:github"`).
`firstPartyPluginGate.ts`'s `isFirstPartyPluginEffective` is unchanged and
generic; it is called once per plugin. Gating covers all four
`GhAuthenticationPort.observe()`-derived consumers (`GithubCapabilityService`,
`GithubCatalogueService`, `ManagedCloneService`, `GithubReadToolService`)
through a single new choke point, `apps/server/src/github/gatedGithubAuthenticationPort.ts`:
a structural `GhAuthenticationPortLike` wrapper that returns
`{kind: "unavailable"}` (and throws on `execute`) without ever spawning the
`gh` subprocess once disabled, requiring zero changes to any of those four
services. `apps/server/src/githubRoutes.ts` and `githubCloneRoutes.ts` each
gate on the same boolean at the route layer; the clone routes gate new
commands only; reading in-flight and completed clone operations stays
available while disabled, matching drain-not-force-cancel semantics.

Pull request lifecycle (`GhPullRequestPort`) is a deliberate, explicitly
scoped exception: it stays host-embedded rather than moving into the plugin,
because it is wired deep into Code's approval-gated command pipeline as a
consumer of GitHub's authentication, not a peer, self-contained surface like
auth/catalogue/clone. `codeOperationRuntime.ts`'s `createPullRequestPort` gets
one added condition mirroring its existing `options.ghExecutable === undefined`
fallback; this is a boot-time-only gate, matching that existing pattern's own
boot-time nature, not a live per-request check. After this step, "GitHub
integration is a plugin" is true for auth/catalogue/clone; PR lifecycle is a
Code-runtime capability _powered by_ that plugin's effective state, not itself
relocated. The Settings `github` section's availability is wired through the
same shared `FIRST_PARTY_PLUGINS_EFFECTIVE`/`isPluginSettingsSectionAvailable`
path used by the sidebar stub above — `resolveSettingsSectionContributions`
was already mode-agnostic from step 2, so the section's host-scoped placement
against a Code-only manifest needed no special-casing, only the wiring into
`SettingsView.tsx`. The `pull-requests` sidebar row's presence is not yet
gated live, for the same reason the board's row is not: it is covered by the
same deferred live-query follow-up.

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
  routes, contracts, and event projections at once.

## Open questions

1. Should first-party plugins that are bundled and enabled be uninstallable, or
   only disableable, in the first release?
2. Do integration plugins get a portable credential field, or does the host
   keep credentials strictly out of manifests and provide only Keychain-backed
   references through a host port?
3. Which contribution points are frozen for the public API in the first
   release, and which stay first-party only until they stabilize?
4. Does a plugin get one shared `PLUGIN_DATA` per package or one per
   host/mode/Project scope, given boards and integrations project per-Project
   data?
5. Where does the generic ACP stack live: as a host capability that provider
   plugins configure, or as itself a plugin that other provider plugins depend
   on?
