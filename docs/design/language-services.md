# Language services and debugging companion

This topic specification owns how a Code thread's editor gets language
services (diagnostics and go-to-definition first, more requests later) and,
in later slices, a debugger, from separately launched processes that run under
Code Project and thread authority. Architecture owns the boundaries it builds
on: [process topology](../architecture.md#process-topology), the
[sandbox and approvals](../architecture.md#security-and-authority), and the
[extension activation ladder](../architecture.md#extensions-and-skills). The
start gates this design answers are in
[release-boundary holds](../release-boundary-holds.md#full-lsp--extension-host--debugger).

**Scope and delivery state.** The maintainer authorized this scope as
post-preview work on 2026-10-26, when parked backlog work was unlocked. That
authorizes the design and the slices below; the release-boundary statement in
`AGENTS.md` and the architecture is updated separately. The maintainer
accepted this design and its [decisions](#maintainer-decisions) on 2026-10-26.
**Slices 1 (seam and policy), 2 (companion and the bundled TypeScript
server), and 3 (editor wiring) are built: the Code editor shows the host's
diagnostics and jumps to definitions, locally and from a paired device.**
Slice 4 (ship the binary) is built: packages carry the server, and a signed
Apple Silicon package awaits the maintainer. Slice 5 (user-added `static`
servers), slice 6 (repository-tooling servers, started only after a local
window's approval and networked under the Project's egress rules), and slice 7
(read-only agent tools for diagnostics and definitions, which never start or
read through a repository-tooling server) are also built; slice 7's
real-provider smoke awaits the maintainer. Slice 8's [Debugger addendum](#debugger-addendum) was accepted by the
maintainer on 2026-10-27; its sub-slices 8a (seam and policy) and 8b (session
host) are built: the host installs a reviewed adapter, records a local
window's confirmation, and runs, controls, and ends sessions behind local-only
routes that no window calls until 8c's panel. Monaco editing and the explicit external-editor
handoff stay the primary Code editing paths and are unchanged by every slice.

## Outcome

A person editing a TypeScript or JavaScript file in a Code thread sees the
Project's real type errors in the editor and can jump to a definition in
another file of the same checkout. The analysis runs in a confined child
process the host launches for that checkout. It cannot write, run other
programs, or reach the network, and it acts only for callers that already hold
that thread. Later slices add other languages, servers that must run the
repository's own tooling, an agent-facing read tool, and a debugger, each
behind its own approval and confinement rules.

## What exists today

- **Editor.** `apps/web/src/code/MonacoEditorPane.tsx` and
  `MonacoEditorAdapter.tsx` mount Monaco on `octant-code:` model URIs
  (`monacoRuntime.ts` refuses any other scheme). The pane loads content through
  the Code client (`content`, `save`), keeps drafts in the thread draft store,
  and is read-only in Plan. Monaco's own language workers
  (`monacoEnvironment.ts`: TypeScript, JSON, CSS, HTML) run in the renderer on
  the models open there. They do not read the checkout, its `tsconfig`, or its
  dependencies, so they cannot report Project type errors or resolve a
  definition in an unopened file.
- **External editor.** `apps/server/src/codeExternalEditorRoutes.ts` hands one
  file to the person's editor after `isCodeExternalEditorTargetCurrent` checks
  the thread, checkout and file reference. A paired device cannot do this
  (`code.open-external-editor` is local-host only in
  `packages/domain/src/remoteAccessPolicy.ts`).
- **Confined children.** Terminals (`apps/server/src/code/terminalProcessPort.ts`),
  repository tests (`repositoryTestProcessPort.ts`), Git, and provider version
  reads launch through `ProcessConfinementPort`
  (`apps/server/src/process/seatbeltProfile.ts`). That is Seatbelt on macOS and
  Bubblewrap on Linux. Other platforms are refused. Terminals refuse Plan.
  Durable process receipts (`process/nodeOwnedProcessReceipt.ts`) let a
  restarted host reap orphans.
- **Executable extensions.** `apps/server/src/extensions/extensionSupervisor.ts`
  supervises reviewed executable components: ready handshake, bounded output,
  crash budget (two restarts a minute), receipts, drain-then-stop. Component
  kinds live in `packages/contracts/src/extensions.ts`
  (`ExtensionComponentKind`). Slice 1 added the `language-server` kind and
  sub-slice 8a the `debug-adapter` kind.
- **Debugger seam (8a).** `packages/contracts/src/extensions.ts` declares the
  `debug-adapter` kind and its `debugAdapter` declaration;
  `@octant/plugin-api/debug-adapter-package` is the public package document;
  `packages/contracts/src/codeDebug.ts` holds the configuration, proposal, and
  start refusal schemas; and `packages/domain/src/debugSessionStartPolicy.ts`
  and `debugLaunchFileImport.ts` decide a start and map a launch file. The
  rules are under [Debugger seam rules](#debugger-seam-rules).
- **Debugger session host (8b).** `apps/server/src/extensions/debugAdapterPackage.ts`
  reads an adapter's folder into the package store and the inspection
  review names it; `apps/server/src/code/installedDebugAdapters.ts` offers
  the adapters effective in Code; `debugConfigurationApprovals.ts` journals
  confirmations; `debugAdapterProcess.ts` launches the capsule with its
  receipt and `debugSessionEgress.ts` its proxy; `debugAdapterConnection.ts`
  holds the protocol; `debugSessionResults.ts` turns answers into contracts;
  `debugSessionRecords.ts` journals each session's start and end; and
  `codeDebugService.ts` authorizes every request and ends sessions. The
  local-only routes are `POST /api/code/debug/configurations`, `/approvals`,
  `/start`, and `/session`. The rules are under
  [Debugger session rules](#debugger-session-rules).
- **Language seam (slice 1).** `packages/contracts/src/extensions.ts` declares
  the `language-server` kind and its `languageServer` declaration;
  `packages/plugin-host/src/activation.ts` admits it in Code only;
  `packages/domain/src/languageServerLaunchPolicy.ts` decides a launch;
  `packages/contracts/src/codeLanguage.ts` holds the read, document, and
  refusal contracts; and `code.language.read` is remote-approvable in
  `remoteAccessPolicy.ts`.
- **Companion (slice 2).** `apps/server/src/code/codeLanguageService.ts`
  authorizes each request and runs one server per checkout and component;
  `languageServerProcess.ts` launches it confined and keeps its receipt;
  `languageServerConnection.ts` holds the protocol; and
  `languageServerResults.ts` turns answers into Octant contracts.
  `packages/plugin-host/src/bundledLanguageServers.ts` declares the bundled
  TypeScript server, and `wiring/codeTooling.ts` resolves its binary from the
  pinned `typescript` package. `POST /api/code/language/documents` and
  `POST /api/code/language/read` serve them.
- **Editor wiring (slice 3).** The Code client's `syncLanguageDocument` and
  `readLanguage` call those routes. `apps/web/src/code/useCodeLanguageServices.ts`
  keeps the editor's file open and reads its diagnostics,
  `codeLanguageEditor.ts` turns Octant contracts into Monaco's shapes and the
  editor's states, `monacoRuntime.ts` shows the markers and answers
  definitions, and `CodeSettingsView.tsx` holds the Settings › Code switch
  (`bundledLanguageServer` in the Code settings).
- **User-added servers (slice 5).** `@octant/plugin-api/language-server-package`
  is the public package document; `apps/server/src/extensions/languageServerPackage.ts`
  reads a local folder that holds one into the package store, and
  `apps/server/src/code/installedLanguageServers.ts` offers the installed
  servers the activation ladder makes effective in Code to the companion.
- **Repository tooling (slice 6).** `apps/server/src/code/languageServerApprovals.ts`
  journals a local window's approval of a `repo-tooling` server for a
  checkout or Project, `POST /api/code/language/approvals` records it,
  `languageServerEgress.ts` gives each start its own `proxied` egress proxy
  under the Project's rules, and the editor offers **Allow in this checkout**
  and **Allow in this Project** when the host answers `approval-required`.
- **Agent read tools (slice 7).** `apps/server/src/code/codeLanguageAgentTools.ts`
  offers `octant_code_diagnostics` and `octant_code_definition` to every Code
  turn whose provider carries Octant's tools, and
  `CodeLanguageService.readForAgent` answers them for the saved file through
  the same checks and per-request launch decision as an editor's read, as a
  start the person at the machine did not make.
- **Network levels.** `apps/server/src/process/threadEgressPolicy.ts` resolves
  `none`, `provider-endpoints-only`, and `unrestricted`. The
  [harness tool egress rules](../architecture.md#harness-tool-egress-rules)
  materialize `proxied` for commands.
- **Packaging (slice 4).** `scripts/package-desktop.ts` stages the target's
  native package beside the server's runtime packages, `sign-desktop.ts`
  signs its binary, `package-headless.ts` vendors it into the headless
  artifact, and `scripts/smoke-packaged-language-services.ts` serves the
  editor's scenario from a package outside any checkout.
- **A server already present.** The repository's pinned `typescript` 7.0.2
  dependency ships a native binary per platform
  (`@typescript/typescript-<platform>-<arch>`, about 24 MB) that speaks the
  Language Server Protocol over stdio (`tsc --lsp --stdio`). On 2026-10-26 a
  scratch smoke on Linux x64 ran it under `bwrap --unshare-all` (no network) on
  a read-only bind of a two-file project with no writable root but a private
  tmpfs. `textDocument/definition` resolved across files and a pulled
  `textDocument/diagnostic` returned the expected type error. Its only
  server-to-client request was `client/registerCapability` for
  configuration. The seccomp no-fork filter and Seatbelt were not tried.

## Design

### Process model

- **A companion is a confined child of the server.** The server, not the
  renderer, the Electron main process, or a separate broker, launches each
  language server through `ProcessConfinementPort`. Authority already lives in
  the server, a headless host has no desktop process, and confinement is per
  launch, so an intermediate host process would add a hop without adding a
  boundary. Monaco only talks to the server through the Code client.
- **One server per checkout, component, and launch class.** Threads on the
  same checkout share it, and every request is authorized on its own. No server
  ever spans two checkouts, so one repository's server never reads another's
  files or cache.
- **Lazy start, bounded life.** A server starts when an authorized caller asks
  for a language read on a file whose language an enabled component declares.
  It never starts at host start or because a repository file asks. It stops
  after ten minutes without an open document, at once when its checkout becomes
  unavailable or the last active thread on it is archived or completed, with
  drain-then-stop when its component is disabled, and at host shutdown. The
  supervisor's crash budget applies. After the budget the server reports
  `crashed` until the person retries from the editor.
- **Protocol stays at the adapter.** The Language Server Protocol wire is
  JSON-RPC on stdio. Frames are capped at 4 MiB, a frame over the cap stops the
  child, and each request has a 10-second deadline that returns `timed-out`.
  The renderer never sees protocol payloads. It sees Octant contracts: a
  diagnostic is a checkout-relative path, a range, a severity, a bounded message
  and a source label, and a definition is a checkout-relative location or an
  `outside-checkout` result (below). Later servers and protocol versions change
  only the adapter.
- **What Octant sends.** Slice 2's allow-list: `initialize`, `initialized`,
  `shutdown`, `exit`, `textDocument/didOpen`, `didChange`, `didClose`, pulled
  `textDocument/diagnostic` (a pushed `publishDiagnostics` is also accepted),
  `textDocument/definition`, `workspace/didChangeWatchedFiles` fed from
  `codeFileWatchService`, and `$/cancelRequest`. Each later request type is
  added on purpose with its own contract.
- **What a server may ask.** `client/registerCapability` is accepted only for
  methods on the allow-list. `workspace/configuration` gets Octant's fixed
  values. `window/workDoneProgress/create` is accepted. Every other request,
  including `workspace/applyEdit`, `window/showDocument`, and
  `workspace/executeCommand`, gets a method-not-found error and has no effect.
  `window/logMessage` goes to a bounded in-memory log shown under Diagnostics;
  `telemetry/event` is dropped.

### Launch classes

The component declares a class and confinement enforces it. A server that
declares the narrow class and needs more fails; it does not get more.

| Class          | Reads                                                        | Writes                             | Runs other programs                                                                    | Network                                                  | Code postures                                                | Approval                                                     |
| -------------- | ------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `static`       | Checkout (read-only), the component's own install, its cache | Its private cache only             | No: exec only its own binary; Linux loads the no-fork seccomp filter Plan already uses | `none`                                                   | All, Plan included                                           | None (see below)                                             |
| `repo-tooling` | Checkout, toolchain roots it declares, its cache             | Checkout and cache, after approval | Yes, confined as a terminal is                                                         | `proxied` under the Project's egress rules (decision D6) | Approval-gated, auto-accept-edits, Full access; Plan refuses | Shell-command category, per checkout and component (slice 6) |

A `static` server needs no approval because it falls in no approval category.
It writes nothing in the checkout, runs nothing from it, reaches no network,
and reads only what the thread can already read. The person's act is opening a
file in an editor with an enabled component. That is also why it may serve a
Plan thread, whose read-only rule it cannot breach.

### Seam and launch decision

Slice 1 settled these details. Where the design left a choice open, the more
restrictive one was taken.

- **Declaration.** A `language-server` component carries
  `languageServer: { languages, launchClass }`, present exactly when the kind
  is `language-server`. `languages` holds 1 to 32 Language Server Protocol
  identifiers (`^[a-z][a-z0-9-]{0,63}$`), which normalization sorts and
  de-duplicates. The kind is executable, so it needs an entry point. An
  unknown class, an unknown field, or an unknown kind is refused when the
  manifest is decoded. The class decides confinement, so a class the host does
  not know is never mapped to a nearby one.
- **Updates.** An update that moves a component to `repo-tooling` counts as a
  capability expansion even when its kind and declared capabilities are
  unchanged. The package is quarantined and its trust and switches are
  cleared, as for any other expansion. Reason: the class alone lets the
  server write the checkout, run tooling, and reach the network. Adding or
  removing languages, or moving to `static`, is not an expansion.
- **Launch decision.** `decideLanguageServerLaunch` takes the class, the
  thread's posture, the host platform, who caused the start (local window or
  paired device), and whether the shell-command approval for this checkout and
  component is on record. It returns a launch shape or the first refusal in
  this order: `unsupported-platform` (neither macOS nor Linux),
  `plan-read-only`, `local-host-required`, `approval-required`. The last three
  apply only to `repo-tooling`. A `static` server may start when a paired
  device's authorized read asks for one, because starting it grants nothing
  beyond that read. Starting `repo-tooling` from a paired device is refused even
  with an approval on record, and there is no remote action for it, so the
  remote gate rejects the request too. Reason: the approval is the person's
  act at the machine, and D4 keeps running repository tooling there.
- **Read contracts** (`@octant/contracts/code-language`). A read names a thread,
  checkout, and file reference, never a path. Diagnostics and definitions use
  zero-based lines and UTF-16 character offsets. A result is diagnostics (at
  most 1,000, with a `truncated` flag; messages at most 2,048 characters;
  source labels at most 64 and holding no path separator), definition
  targets (at most 64), `unavailable`
  (`starting`, `crashed`, `timed-out`: states to wait out or retry), or
  `refused` with one reason. The refusal reasons are `thread-inactive`,
  `checkout-unavailable`, `checkout-mismatch`, `file-outside-thread`,
  `path-outside-checkout`, `no-reach`, `turned-off` (the Settings switch,
  D2), `no-language-server`, `confinement-unavailable`, and the four launch
  refusals unchanged. An installed component that is not effective reads as
  `no-language-server`, so a read never shows which disabled or unreviewed
  components exist.
- **Host paths in message text.** Structured paths are checkout-relative by
  schema, but a diagnostic message is the server's free text and can name a
  host path, such as a `tsconfig` it could not read outside the checkout. The
  adapter rewrites every absolute path or `file:` URI in a message: one inside
  the checkout becomes checkout-relative, and any other becomes
  `<outside checkout>`. The schema cannot enforce this, so slice 2 tests it.
  A quoted span that starts like a path is rewritten whole, spaces included,
  because the TypeScript server quotes the paths it names. An unquoted path
  with a space in it is cut at the space, and the words after it stay.
- **Read before start.** Every authority check of a read, `no-reach`
  included, runs before the launch decision is consulted. A refused read never
  starts a server, so a paired device can start a `static` server only for a
  thread it already reaches (D4).

### Companion rules

Slice 2 settled these details, taking the more restrictive option where the
design left a choice open.

- **Open documents.** The editor opens a document with
  `POST /api/code/language/documents` (`open`), naming a checkout-relative path
  and its current text. The host confines the path, derives the file reference
  the editor's other Code surfaces use, and sends `didOpen`. `change` and
  `close` name that reference. A read names only the reference, and a
  reference this thread has not opened on this checkout is refused as
  `file-outside-thread`. Reason: a read must never name a path, and the host
  cannot turn a file reference back into one. Two threads on one checkout
  share one server document; it closes when the last of them closes it. A
  document whose text would not fit a 4 MiB frame is answered `too-large` and
  not sent.
- **Which language a file is.** Octant's own table maps file extensions to
  languages (`.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`).
  Repository configuration never changes it, so it never picks a server.
- **Refusal order.** `no-reach` comes first, and a thread that does not exist
  reads the same, so a refusal never says which threads a host has. Then
  `thread-inactive` (archived, waiting, interrupted, or completed: only an
  active thread may read, as only it may save), `checkout-mismatch`,
  `checkout-unavailable`. A change or read then needs a document this thread
  opened (`file-outside-thread`). The path is contained again on every open
  and read, symlinks resolved, and must be a regular file
  (`path-outside-checkout`). Then `no-language-server`, the launch refusals,
  and last `confinement-unavailable`. Nothing is launched until all of them
  pass.
- **Repository tooling.** The launch decision is asked with the approval the
  store holds for this checkout and component; slice 6's rules are under
  [Repository tooling](#repository-tooling). A launch class this host cannot
  confine is refused as `confinement-unavailable`, never run as `static`.
- **Registrations.** A server's `client/registerCapability` is accepted only
  when every method in it is one Octant sends; otherwise the whole request is
  refused. TypeScript's request for configuration-change notices is refused
  this way and the server carries on. `workspace/didChangeWatchedFiles` is
  sent only after the server registered for it, with each changed path from
  the checkout's file watch.
- **Answers that are not results.** A request the server answers with an error
  is reported as `timed-out`, as one it did not answer in time is: no result
  arrived, and retrying is the remedy. A connection that ends mid-request reads
  as `crashed`. A server that does not offer pulled diagnostics is read from
  what it last pushed, and reads as `starting` until it pushes something.
- **Crash budget and retry.** Two restarts a minute, as the extension
  supervisor allows. A restart reopens every document still held. Past the
  budget the server stays `crashed` for reads until the editor opens a
  document again, which is the retry. A frame over the cap or one that is not
  a frame counts as a crash.
- **Idle.** A document no request has touched for ten minutes is closed, so a
  window that vanished without closing its documents cannot keep a server
  alive. A server with no open document stops ten minutes after it was last
  used.
- **Lifecycle stops.** Each committed `code-thread` or `code-checkout` event
  runs the stop check at once, and a timed check runs every minute. A server
  stops when its checkout is unavailable, when no active thread is left on its
  checkout, or when its component is no longer effective (drained with
  `shutdown` and `exit` first). Host shutdown stops every server.
- **Launch.** The checkout is the read-only bound root, the component's install
  is a read root, and its cache is the only write root; the cache parent is
  denied so no server reads a sibling's cache. The temporary directory inside
  the cache is made anew at every start, because the server may write there
  and confinement grants a launch root's resolved target: a link it left
  would otherwise grant the next run whatever folder the link names. Network
  is `none`. On macOS Seatbelt lets the server exec only its own binary. On
  Linux the filter refuses fork, clone, and `execveat`, and the host's program
  folders are hidden. Bubblewrap applies the filter before it starts the
  server, so it cannot refuse `execve`, and the server could replace itself
  with another file it can see. That file runs with the same confinement:
  no fork, no network, and writes only to the cache. Seatbelt also
  gets the broad system read every other confined launch uses, because a
  binary cannot start without the system libraries, while the home folder and
  the private system paths stay denied. The environment holds only `HOME` and
  `TMPDIR` (the cache) and a minimal `PATH`.
- **Cache bound.** A cache past 512 MB is cleared before the server's next
  start. A cache holds nothing a server cannot rebuild, so clearing all of it
  is the simplest eviction that keeps the bound.
- **Receipts.** Each server's process group is recorded before the server is
  used, under its own supervisor name. A server whose receipt cannot be
  written does not run. The host reaps last run's servers at startup, before
  it starts any.
- **Remote.** `POST /api/code/language/documents` and
  `POST /api/code/language/read` are both `code.language.read`: syncing the
  editor's text feeds a read and writes nothing. A paired device with Code
  reach may start a `static` server through them.
- **Not built yet.** The bounded `window/logMessage` log and the lifecycle
  counts under Diagnostics, and removing a cache when its checkout is removed
  or its component uninstalled.

### Editor rules

Slice 3 settled these details, taking the more restrictive option where the
design left a choice open.

- **The switch.** Settings › Code › Editor › Language services is the bundled
  component's own desired switch on the activation ladder, not a second gate.
  It is stored as `bundledLanguageServer` in the Code settings, so changing it
  is the existing journaled `code.settings-updated@1` event; there is no new
  event. A store without the value reads as on (D2). Off, the component
  contributes nothing, the host drains its running servers at once (the
  settings event runs the stop check), and a file only it would read is
  refused `turned-off`. A file no component declares stays
  `no-language-server`, so the refusal names only the switch the person
  holds. A window's update carries the switch only when it changes it; the
  host keeps the stored value otherwise.
- **Diagnostics.** Markers show only diagnostics for the editor's own file.
  While the server serves a file its markers are the only ones on that model:
  Monaco's worker reads one file without the Project, and its errors (an
  import it cannot resolve) would contradict the server's. The worker's
  markers are cleared each time it sets them; once the server stops serving
  the file they come back with the worker's next check, on the next edit,
  since Monaco offers no way to ask it for one model. A read-only editor draws them too: Monaco's default
  hid every diagnostic in Plan.
- **Definitions.** Monaco merges every provider's definitions, and the worker's
  answer for an imported name (the import's own binding) turned each jump into
  a two-entry peek beside the server's location. The worker's definition
  provider is therefore turned off before any model exists, and Octant's
  provider answers: from the server while it serves the file, and from the
  worker, within that file only, while it does not. The worker's jumps into
  its bundled library files are not offered.
- **Opening a definition elsewhere.** A target in another checkout file opens
  through the ordinary file-open path as a Code file tab, which then reveals
  the target. The renderer holds that place for 30 seconds; a later, unrelated
  open of the file does not jump. Monaco only ever sees a placeholder link for
  the target, never a model with its text. A target outside the checkout opens
  nothing and shows a notice naming only its label.
- **Syncing drafts.** The editor sends the whole text 300 ms after typing
  stops, then reads diagnostics again; text typed while the file was opening
  is sent once the open settles. It reads diagnostics again when focus comes
  back to the pane from elsewhere, since another file's edits may have
  changed them. Closing the editor closes the document.
- **States.** `starting` shows only when the first answer takes over 400 ms; a
  server still `starting` is asked again each second, and after 30 tries is
  shown as not answering. `crashed` and `timed-out` offer Retry, which closes
  and reopens the document, the retry the companion already honours. Because
  opening resets the crash budget, an edit never reopens a document on its
  own; only a `too-large` file is opened again when its text changes. A
  document the host no longer holds (after a restart or the idle close) is
  reopened once on its own before it is reported. Any other refusal stands:
  the editor sends no more text until a retry, and focus coming back to an
  editor whose services are off reopens it, so turning the switch back on
  needs no reload. A file no server reads shows nothing, and every state
  leaves editing and saving untouched.

### User-added servers

Slice 5 settled these details, taking the more restrictive option where the
design left a choice open.

- **Package.** A person adds a server as a folder with
  `octant-language-server.json` at its root, imported from Settings › Skills &
  Extensions › Marketplace with the native folder picker, so the folder's path
  stays with the desktop and the server. The document is
  `{ manifest }`, an ordinary package manifest without the facts only the host
  states: an author who writes `extensionId`, `packageId`, `digest`, `source`,
  or `provenance.reviewed` is refused, not overwritten. The host derives the
  identity from the folder and the slug, so a folder can never take the
  bundled server's identity or another package's, and records it unreviewed.
  A folder with the document is read as a language server and as nothing
  else; one that also holds an outside provider driver's
  `octant-provider-driver.json` is refused as neither. Other sources are refused until a marketplace package can carry a
  publisher signature.
- **What a package may hold.** Exactly one `language-server` component, Code
  only, for no provider family, with no contributions, whose entry point is a
  file in the package. A `static` server declares at most the `filesystem`
  capability; a `repo-tooling` server at most `filesystem`, `shell`, and
  `network` (slice 6), because those are what its class grants. The binary is
  the package's only executable file; another is refused, because a `static`
  server may run its own binary and nothing else, and a `repo-tooling` server
  runs the repository's tooling, not programs its package brings. The slug
  and `builtin:` entry points of the bundled server are refused. The class is
  never narrowed to `static` for the author. The package store's bounds apply
  (16 MiB per file, 64 MiB per package).
- **Launch.** The server starts with no arguments: the schema has no field for
  them, so nothing but the binary decides how it runs. It is confined exactly
  as the bundled server is, with its stored package version as the read-only
  install root.
- **Review.** The inspection preview names the binary by its path in the
  package, the binary file's own SHA-256 digest (beside the package digest,
  so it can be checked against the author's release), the languages, the
  class, and, for `static`, that the server reads the checkout, keeps a
  private cache, and cannot write, run other programs, or reach the network.
  For `repo-tooling` it says that the server runs the repository's own
  tools, starts only after the person allows it for a checkout or a Project,
  can then write that checkout, run programs, and reach the hosts the
  Project's network rules allow, and never runs in Plan or for a paired
  device. Confirm install stores it untrusted with its switches off.
- **Effective.** The companion offers an installed server only while the
  ladder makes it effective in Code: installed, not quarantined, trusted, the
  plugin and component switched on, compatible with this host's platform and
  app version. Withdrawing any of them commits an extension event, which runs
  the stop check at once and stops a running server. Project and thread
  policy is the read's own authority check, so it is not asked twice.
- **Verified at every start.** The binary's path is resolved from the stored
  version only after the whole version verifies against its digest. A binary
  changed after review does not run; the start counts against the crash
  budget and reads as `crashed`, and the next host start quarantines the
  version.
- **Identity per digest.** An installed server's key includes its package
  digest, so an update starts a new server with its own cache rather than
  serving from the old binary's process or files.
- **Which server reads a file.** Octant's extension table now lists the
  common languages by the protocol specification's identifiers (C and C++,
  C#, CSS, Dart, Elixir, Erlang, Go, HTML, Java, JSON, Lua, Markdown,
  Objective-C, PHP, Python, Ruby, Rust, Scala, SCSS, shell, SQL, Swift, XML,
  YAML); `.h` reads as C. When more than one effective server declares a
  file's language, the bundled server serves it, then installed servers by
  package name, so install order never decides.

### Repository tooling

Slice 6 settled these details, taking the more restrictive option where the
design left a choice open. The approval store is
`apps/server/src/code/languageServerApprovals.ts`, the class's network is
`languageServerEgress.ts`, and `languageServerProcess.ts` launches both
classes.

- **Asking.** A `repo-tooling` server with no approval on record answers
  `approval-required`. The editor of a local window then names what allowing
  it grants (writing this checkout, running programs, and reaching the hosts
  the Project's network rules allow) and offers **Allow in this checkout** and
  **Allow in this Project**. `POST /api/code/language/approvals` names the
  thread, checkout, file path, and scope, never a server: the host confines
  the path and picks the server from its own table, as `open` does, because a
  server waiting for its approval never opened the document. A server that
  is `static` answers `not-required`.
- **Who approves.** Only the person at a local window. A paired device is
  refused before anything is read (`local-host-required`); the route has no
  remote action, so the remote gate denies it, and the route answers 403 to a
  device that reached it anyway. Every check a read makes runs next, then the
  launch decision with the approval granted, so Plan refuses
  (`plan-read-only`) and nothing is recorded for a server the thread could
  not start.
- **Journal first.** An approval is `code.language-server-approval-granted@1`
  on the Project's `code-language-server-approval` aggregate, in the
  `shell-commands` approval class, scoped to one checkout or to the Project.
  One that cannot be appended answers `not-recorded` and is not in force. A
  restarted host rebuilds the approvals from the journal. The record names no
  thread, so a thread purge leaves it, and a Project erase removes it and
  ends it in the running host at once, since the Project lives on after an
  erase.
- **What an approval covers.** One server in one package state: its
  extension, component, package digest, and the package's lifecycle version.
  Any later change to the package (an update, a switch, trust given or
  withdrawn, an uninstall) leaves the approval covering a state that no longer
  exists, so a running server stops at once (the change is an extension
  event, which runs the stop check) and the next start asks again. Reason:
  that is the one revocation a crash between two appends cannot lose, and it
  is how a person takes an approval back: switch the server off in Settings.
- **Decided on every request.** A paired device and a Plan thread are refused
  a `repo-tooling` server even while it runs for another thread, because the
  document a caller opens is what the server then runs the repository's
  tooling on. A running server stops when no approval covers its current
  package state, and a restart after a crash, which no request decided, starts
  it only while one does.
- **Launch.** As a terminal is confined: the checkout writable, programs and
  child processes allowed, the server's install readable, and its private
  cache as for `static`. The environment holds only `HOME` and `TMPDIR` (the
  cache), a minimal `PATH`, and the proxy variables below. The declaration has
  no field for toolchain roots yet, so a server reads the system folders a
  terminal's launch reads and nothing under the home folder; a toolchain
  installed there is out of reach until such a field exists.
- **Ending its children.** Stopping the server ends its process group, and
  then its proxy closes. On Linux that ends every descendant: Bubblewrap's
  `--unshare-all` gives the server its own PID namespace and
  `--die-with-parent` ends the namespace with the capsule, so a child that
  called `setsid()` dies with it. On macOS Seatbelt has no PID namespace, so
  a child that calls `setsid()` leaves the group and outlives the stop. It
  keeps the server's confinement (the checkout and cache writable, no home
  folder), and its only network was the proxy, which has closed. A
  terminal's commands share this residual, since both end a process group.
  Not yet measured: on a Mac, a `repo-tooling` fixture server and a terminal
  command that each start a child calling `setsid()` and sleeping, stopped by
  the host (server stop, terminal close, host restart), then `ps` shows
  whether the child survived each stop and whether the restart's receipt reap
  ends it. A shared fix waits on that measurement.
- **Network (D6).** Each start gets its own egress proxy, the one harness
  commands use, and the `proxied` OS level: loopback on macOS, a Unix socket
  and in-capsule forwarder on Linux. Its connections are decided on the Code
  Project's rules alone. Those rules are suspended while any active thread
  that can write the server's folder has taken in outside content, because
  that thread's agent may have written the tooling the server runs. That is
  every thread on the checkout and every thread of any Code Project whose
  folder is the server's, holds it, or lies inside it, compared by canonical
  real path on the host: two Projects bound to one folder give their threads
  different checkout ids, and a tainted thread in either can write the
  files. A thread whose folder the host cannot tell counts as writing it. The
  proxy joins the egress rules' active recheck, so a Project rule revoked, or
  a thread taking in outside content, closes an idle tunnel at once rather
  than at its next chunk. A proxy whose listener or start record fails, or
  that cannot join the recheck, means the server does not start; a host with
  no proxy refuses the class as `confinement-unavailable`, never runs it with
  no network or an open one.
- **Audit.** Each start is journaled the way a `proxied` command's launch is,
  with the same payloads and limits, under
  `code.language-server-egress-launch-started@1`,
  `-decisions-recorded@1`, and `-launch-summarized@1` on a
  `code-language-server-egress` aggregate of its own. The launch names the
  Project and the thread whose read started the server. A server's bytes
  reach no model, so they taint no thread, and nothing is proposed: a
  proposal surfaces on a thread, and this server serves a checkout. A person
  adds a Project rule from a thread's Network access list. A launch the host
  stopped before its summary keeps its start and batches, and nothing is
  reconstructed, since no taint depends on it. A thread purge leaves these
  records and a Project erase removes them.

### Authority

- **Code only.** The component kind is `mode-prohibited` in Chat and Work. Work
  has no developer environment, and Chat has no folder.
- **Every read is checked when it runs.** The thread is an active Code thread.
  Its checkout is available and is the one the request names. The file
  reference belongs to that thread and checkout, and its path is contained by
  `codePathConfinement.ts` with symlinks resolved. The caller is either a local
  window whose Project binding holds the thread (a window-held service, judged
  on the binding and liveness at call time like a terminal) or a paired device
  with Code reach under a new remote-approvable `code.language.read` action.
  Starting a `repo-tooling` server or a debug session is local-host only, like
  `terminal.write`.
- **The repository never picks what runs.** The executable, arguments,
  environment, and class come only from the enabled component. Repository files
  are data the server parses inside confinement: compiler configuration and its
  plugin lists, editor settings folders that name a server or SDK path,
  repository-declared server lists (the architecture already denies a
  provider's `.github/lsp.json` servers), and recommended-extension lists. They
  never choose an executable or widen a class.
- **Environment is allow-listed.** `HOME` is the private cache and `PATH` is
  minimal. No provider key, token, broker credential, or other `OCTANT_*`
  value reaches the child, which is the managed-device-tools rule.
- **Results outside the checkout.** A definition in the server's bundled
  standard library or anywhere outside the checkout is returned as
  `outside-checkout` with a label (`bundled-library` or `elsewhere`) and no path
  or content. A dependency inside the checkout, such as `node_modules`, is an
  ordinary location.
- **Plugin-shaped.** Language servers are a new executable component kind,
  `language-server` (declared languages and class), on the existing activation
  ladder, published through `@octant/contracts/extensions` and
  `@octant/plugin-api`. The bundled TypeScript server is an in-tree package of
  that kind and takes no path a third-party package could not. A user-added
  server is installed, quarantined, reviewed, and enabled like any executable
  component. Installing it never trusts or enables it.
- **Platforms.** macOS and Linux. Any other platform refuses with
  `unsupported-platform`. A missing Seatbelt or Bubblewrap backend fails closed
  and names the recovery, as confinement already does.

### Packaging rules

Slice 4 settled these details, taking the more restrictive option where the
design left a choice open.

- **What ships.** Each package carries the native package for its own target,
  `@typescript/typescript-<platform>-<arch>`, resolved through the pinned
  `typescript` package so its version is the lockfile's. It ships whole and
  unchanged, neither stripped nor rebuilt: the binary (`lib/tsc`), the
  standard library declarations it reads from its own folder (`lib/*.d.ts`),
  and the package's `LICENSE` and `NOTICE.txt`, which are its license notice.
  The desktop app holds it under the server's runtime packages
  (`Resources/app/apps/server/node_modules`) and the headless artifact under
  its top-level `node_modules`, where the server's existing resolution finds
  it. A package build refuses to finish when the binary, the standard
  library, the license, or the notices are missing, or when the copy it
  resolved is not the version `typescript` pins (resolution walks up past the
  repository, so a nested checkout could reach an outer install's). Reason: the server finds
  the binary by walking up from its bundle, so a package without its own copy
  would serve whichever copy sat above wherever the app was put, a checkout's
  or a stranger's.
- **Headless artifact.** The artifact's general rule drops type declarations
  from vendored packages; the language server's are kept, since without them
  every file reports missing global types. The binary is recorded as a
  `native-module` component, the role that installs executable, so it is
  verified by digest at install and at every start like the others.
- **macOS signing.** A release build signs the binary with the Developer ID,
  the hardened runtime, and a secure timestamp, before it seals the app, and
  with none of Octant's entitlements. Reason: notarization refuses an
  unsigned executable in the bundle, and the entitlements (JIT, unsigned
  executable memory, audio input) exist for Electron and dictation; a server
  that compiles nothing and records nothing gains only reach from them.
- **Linux.** The binary ships unsigned, as the image does. Packaging checks
  that it is an executable 64-bit ELF file.
- **Evidence.** `scripts/smoke-packaged-language-services.ts` starts a
  package's own server from a copy outside the repository, with no
  `node_modules` above it, and serves slice 3's scenario for a Plan thread: the
  cross-file type error, the definition in the other file, and a standard
  library name read as `bundled-library`. It also checks that the process
  that answered runs the package's binary and that stopping the host stops it.
  It takes `desktop` (the packaged app for this host) or `headless` (an
  artifact tarball).

### Agent read rules

Slice 7 settled these details, taking the more restrictive option where the
design left a choice open.

- **Tools.** `octant_code_diagnostics` and `octant_code_definition` are the
  closed catalog's `code-diagnostics` and `code-definition`
  (`packages/contracts/src/toolCatalog.ts`); their argument schemas and
  definitions are in `@octant/contracts/code-language`. Both are Code only,
  `filesystem`, and `project-file-reads`, so Plan keeps them, no posture asks,
  and a marked thread is not asked afresh: they read only what the thread can
  already read, through a server that cannot write, run other programs, or
  reach the network. Their results mark nothing, as a file read marks
  nothing. A profile allowlist names them by these tool names.
- **Transport.** They travel through the provider SDK's ordinary app-managed
  tool transport (`apps/server/src/code/codeLanguageAgentTools.ts`, added to
  every Code turn through the runtime's contributed tools), so every runtime
  that carries Octant's tools carries them. A provider without app-managed
  tools is never offered them and refuses a turn that carries them as
  `unsupported`. The SDK's chat conformance now also fails a driver that asks
  for a tool its turn did not offer, since the host answers no other name.
- **By path, as saved.** An agent names a file by its checkout-relative path,
  as its other file tools do; it holds no editor document, so it has no file
  reference. The read answers for the file as saved, and lines and columns
  are one-based, as the agent's own reads and searches number them; the host
  converts them. Reason: an agent reads and edits the saved file, so an answer
  for other text, or counted from zero, points at the wrong line.
- **Never an editor's draft.** When an editor holds the file with text other
  than the saved file's, the read answers `unsaved-edits` and changes nothing:
  the person's draft is neither replaced on the server nor read out to a
  provider. A file only agents hold is brought up to the saved text on the
  next read, and an agent's hold closes under the ten-minute idle rule. When
  the last editor closes a file, the agents' holds on it close too, so a
  draft the person discards is not kept on the server for the agent's reads
  of other files; the agent's next read reopens the saved file. An answer
  computed while an editor changed the file's text is `unsaved-edits`.
  Residual: a diagnostic for a saved file can still name something from
  another file's unsaved draft, since one server reads the whole checkout.
- **Checks.** Each call is decoded against its schema, wrapped as a
  `ToolActionRequest` under the thread's authority as it stands, and passed
  through the tool-call choke point. The language service then runs every
  check an editor's read passes, in the same order, on the turn's window as
  it stands when the call runs (the standing authority other Project-scoped
  app-managed tools use). A refused read starts nothing.
- **Starts.** The launch decision is asked on every read as a request the
  person at the machine did not make, as a paired device's is, so an agent can
  start a `static` server and never starts or reads through a `repo-tooling`
  one (`local-host-required`, in every posture), even one already running
  under a person's approval. Reason: running repository tooling stays the person's act
  at the machine (D4), and an agent's call is not that act. An agent's read
  never resets the crash budget either; reopening the file in the editor stays
  the person's retry.
- **Answers.** Results keep the editor's bounds, and a definition outside the
  checkout is only its label. `starting`, `crashed`, `timed-out`, `too-large`,
  `unsaved-edits`, and each refusal come back as a tool error with one
  sentence saying what to do next. Slice 7 adds no journal events.

### Data lifecycle and privacy

- **Drafts.** Unsaved editor text goes from the renderer to the server over the
  existing authenticated transport, then to the child's stdin. Octant keeps it
  in memory and writes none of it to disk for this feature. The draft store is
  unchanged.
- **Results** are ephemeral reads, like Git history: not journaled, not
  projected, recomputed on demand.
- **Cache.** Each server gets its own owner-only directory under the host data
  directory, keyed by checkout and component, capped at 512 MB with the oldest
  entries evicted. Other servers' cache directories are denied, as terminal
  state directories are. The directory is removed when its checkout is removed
  or its component is uninstalled.
- **Journal.** Slices 1 to 5 add no journal events. Slice 6 journals each
  `repo-tooling` approval and each such server's egress launch records
  ([Repository tooling](#repository-tooling)); they hold identifiers, hosts,
  ports, and counts, never paths or file content. Approvals later slices add
  are journaled the same way. Diagnostics exports carry
  lifecycle counts (starts, crashes, refusals by reason) and no paths or file
  content.
- **Network.** No telemetry and no outbound calls. `static` servers have none.
  The bundled server changes version only with an Octant update and never
  updates itself.

### Threat model

| Threat                                                                                                                          | Mitigation                                                                                                                                                                                     | Residual                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A hostile repository makes the server run its code: compiler plugins, build scripts, macros, or a settings file naming a binary | The component alone picks the executable. A `static` server cannot exec or fork. A server that runs repository tooling is `repo-tooling`: approved, refused in Plan, confined as a terminal is | A bug in the server's parser runs inside the `static` sandbox: no write, no exec, no network         |
| Source leaves the machine                                                                                                       | `static`: network `none`. `repo-tooling`: `proxied` under the Project's rules, so only hosts a person allowed                                                                                  | A `repo-tooling` server can send source to an allowed host, the same as an approved terminal command |
| The server writes into the checkout or elsewhere                                                                                | `static` writes only its cache. `repo-tooling` writes the checkout only after approval                                                                                                         | None beyond the class                                                                                |
| The server asks for edits, commands, or to open documents or URLs                                                               | Server-to-client requests are allow-listed. `applyEdit`, `executeCommand`, and `showDocument` get method-not-found. A person's save stays the only write path                                  | None                                                                                                 |
| Results point outside the checkout or through a symlink                                                                         | Locations are resolved and contained. Anything outside becomes `outside-checkout` with no path or content                                                                                      | The label says a definition exists outside the checkout                                              |
| Authority drifts: archived thread, rebound window, swapped checkout, paired device                                              | Each request is checked when it runs. The server stops when its checkout or last active thread goes. Remote reads need Code reach, and remote starts are refused                               | A request already answered stays answered                                                            |
| Resource exhaustion                                                                                                             | Frame cap, request deadline, bounded diagnostics and logs, idle stop, crash budget, receipts reaped after a restart                                                                            | No OS memory cap on macOS. A runaway server is stopped by the person or the idle timer               |
| Cross-checkout leakage                                                                                                          | One server per checkout. Sibling cache directories are denied                                                                                                                                  | None                                                                                                 |
| Injected text reaches an agent (slice 7)                                                                                        | Results are repository-derived data with provenance, never instructions, under the server-side tool-call policy                                                                                | The same as an agent reading the file                                                                |
| The bundled binary is compromised                                                                                               | Pinned in the lockfile, shipped inside the signed app, changed only by an Octant update                                                                                                        | Trust in the pinned release                                                                          |

## Debugger addendum

**Status: accepted by the maintainer on 2026-10-27, with every decision as
recommended.** This is slice 8's design addendum. Each **Decision** names its
rule and the rejected alternatives; the rest follows from rules already
accepted above (slices 5 and 6) or in the architecture.

### Debugger outcome

A person working in a Code thread at a local window picks a debug
configuration, presses Start, and the program stops at their breakpoints in
the Monaco editor. They see the call stack and variables, step, continue,
evaluate an expression they type, and stop. The adapter and the program run in
one confined process tree that writes only the checkout and its own state,
reaches the network only as the thread's posture allows, and ends when the
session, the thread's authority, or the adapter's approval ends. A
configuration found in the repository is a proposal. It runs only after the
person confirms it.

### Component and package

- **Kind.** A new executable component kind, `debug-adapter`, on the same
  activation ladder as `language-server`. It is `mode-prohibited` in Chat and
  Work and quarantined until reviewed.
- **Declaration.** A `debug-adapter` component carries
  `debugAdapter: { runtimes, launchArguments, importTypes, debugPorts }`,
  present exactly when the kind is `debug-adapter`. Unknown fields are refused
  on decode.
  - `runtimes`: 1 to 8 Octant runtime identifiers
    (`^[a-z][a-z0-9-]{0,31}$`, such as `node`, `python`, `native`). They label
    the adapter in the configuration picker and choose nothing.
  - `launchArguments`: a JSON object of at most 8 KiB, the body of the DAP
    `launch` request this adapter needs. A string value is either a literal or
    exactly one whole placeholder: `{{program}}`, `{{args}}`, `{{cwd}}`,
    `{{env}}`, `{{stopOnEntry}}`, or `{{debugPort}}`. A placeholder inside a
    longer string is refused. Reason: Octant fills only values it has
    checked, and a whole-value placeholder cannot splice a configuration's text
    into another key.
  - `importTypes`: 0 to 8 strings matched against the `type` of an entry in an
    imported repository file (below). They are matching labels only.
  - `debugPorts`: `0` or `1`, whether the adapter needs one loopback port to
    reach the program it launched (below).
- **Package.** As a user-added language server is (slice 5): a local folder
  with `octant-debug-adapter.json` at its root holding `{ manifest }`, imported
  from Settings › Skills & Extensions › Marketplace with the native folder
  picker. The host states the identity, digest, source, and review state, and
  refuses an author who writes them. A folder holding another Octant package
  document is refused as both. The package holds exactly one `debug-adapter`
  component, Code only, for no provider family, with no contributions, and
  declares at most the `filesystem`, `shell`, and `network` capabilities. Its
  binary is its only executable file; the adapter may still run programs the
  capsule can see, such as a runtime on the system path, because the program
  being debugged needs them. The package store's bounds apply.
- **Updates.** Adding the kind, changing `launchArguments`, or raising
  `debugPorts` is a capability expansion: quarantine, trust and switches
  cleared. Changing `runtimes` or `importTypes` is not.
- **Review.** The inspection preview names the binary, its own SHA-256 digest,
  the runtimes, the `launch` body with its placeholders, and whether it uses a
  debug port, and says that the adapter runs programs from the checkout, can
  write the checkout, reaches only the hosts the thread's network rules allow,
  and never runs in Plan, for a paired device, or for an agent.
- **Verified at every start.** As slice 5: the stored version verifies against
  its digest before the binary path is resolved, and a changed binary does not
  run.

**Decision DB1: no bundled adapter
first.** Debug adapters arrive only as user-added packages until a real one has
passed the container and Mac smokes. Recommended because each language's
adapter needs its own runtime, licence review, and size budget, and the seam
can be proven with a fixture adapter. Rejected: bundling a JavaScript adapter
now (it needs a Node runtime outside the package and adds a large dependency
before the seam is proven); bundling a native adapter now (see DB6).

### Debug configurations

A debug configuration is Octant's own record of what a session runs. It is not
another product's launch file and is never written back to the repository.

- **Shape.** `{ name, adapter, program, args, cwd, env, stopOnEntry }`.
  `name` is at most 128 characters. `adapter` names an installed
  `debug-adapter` component. `program` and `cwd` are checkout-relative paths,
  contained by `codePathConfinement.ts` with symlinks resolved when the
  configuration is confirmed and again at every start; `program` must be a
  regular file. `args` holds at most 64 strings of at most 1 KiB. `env` holds
  at most 32 entries whose keys match `^[A-Za-z_][A-Za-z0-9_]{0,127}$` and whose
  values are at most 1 KiB. A key starting `OCTANT_`, or naming a variable the
  host's credential environment rules strip from children, is refused. `request`
  is always `launch`.
- **Where they come from.** The person writes one in the Run and debug panel,
  or confirms one the panel proposes from a repository file. Both end in the
  same confirmation (below).
- **Stored on the host.** A confirmed configuration is journaled with its
  approval (below), not kept in the checkout. Reason: a repository file can
  change under the person after they confirmed it; the record of what they
  approved must not.

**Decision DB2: read `.vscode/launch.json`
as proposals only.** When the person opens the Run and debug panel, the host
reads that one file in the checkout, if present, as JSON with comments,
bounded at 256 KiB, and maps each entry to a proposed Octant configuration. The
host never runs, writes, or watches it, and reads no other launch, task, or
workspace file.

- An entry maps only when its `request` is `launch`, its `type` matches one
  effective adapter's `importTypes`, and every value it uses resolves. Mapped
  fields are `name`, `program`, `args`, `cwd`, `env`, and `stopOnEntry`.
- Variables resolve from a closed set: `${workspaceFolder}`,
  `${workspaceFolderBasename}`, and, from the editor's current file,
  `${file}`, `${relativeFile}`, and `${fileDirname}`. Any other variable,
  including `${env:…}`, `${command:…}`, `${input:…}`, and `${config:…}`, makes
  the entry unmappable, because each reads host state or runs an editor
  command. A path that resolves outside the checkout makes it unmappable.
- Every other field (`preLaunchTask`, `postDebugTask`, `runtimeExecutable`,
  `envFile`, `console`, adapter-specific options) is not used. The proposal
  lists each by name as "Octant does not use this", so the person sees what the
  file asked for and Octant will not do. Octant runs no tasks.
- Originality: Octant reads this file as data the person's repository already
  holds, as the connector import reads other tools' MCP configuration. Octant's
  stored schema, its names, and its copy are its own, and it never writes the
  file.

Recommended because many repositories already describe how to start their
program there, and a proposal the person confirms keeps the repository from
choosing what runs. Rejected: reading no repository file (every person retypes
what the repository already says); passing an entry's adapter-specific fields
through to the adapter (the person could no longer see what they confirm, and
fields such as a runtime executable or a pre-launch task choose what runs); an
Octant-owned repository file (it would still only be a proposal, and adds a
format nobody has).

### Approval and starting

- **Confirming is the shell-command approval.** The person at a local window
  confirms a configuration on a card that shows the adapter, the program, its
  arguments, its working folder, each environment entry, and, for an imported
  one, the ignored fields. Confirming appends
  `code.debug-configuration-approved@1` on the Project's
  `code-debug-configuration` aggregate, in the `shell-commands` approval class,
  scoped to one checkout or to the Project. It covers one configuration digest
  and one adapter package state (extension, component, package digest,
  lifecycle version), as slice 6's approval does. One that cannot be appended
  is not in force.
- **Starting.** Start is a person's act at a local window, every time. A start
  succeeds only while an approval covers the configuration's current digest and
  the adapter's current package state. Any edit of the configuration, or any
  change to the package (update, switch, trust, uninstall), needs a new
  confirmation. Full access does not skip it: the posture governs what an
  agent may do unasked, and no agent starts a session.
- **Launch decision.** A pure `decideDebugSessionStart` takes the host
  platform, the thread's mode and posture, who caused the start, the approval,
  and whether the configuration's paths still resolve. It returns a launch
  shape or the first refusal in this order: `unsupported-platform`,
  `mode-prohibited`, `plan-read-only`, `local-host-required`, `approval-required`,
  `configuration-invalid`. The read-side checks of the companion (`no-reach`,
  `thread-inactive`, `checkout-mismatch`, `checkout-unavailable`) run first,
  and `confinement-unavailable` last; nothing launches until all pass.
- **One session per thread.** A thread holds at most one debug session, and a
  host at most four. A second Start on a thread asks to stop the first.

**Decision DB3: approve per
configuration.** Recommended because what runs is the program and its
arguments, not only the adapter. Rejected: one approval per adapter and
checkout, as slice 6 does for a language server (it would let any later
configuration, repository-proposed included, run unasked); a prompt at every
Start (the confirmation already records the same act, and a second prompt
trains people to click through).

### Session process model

- **One capsule.** The server launches the adapter through
  `ProcessConfinementPort`, and the adapter launches the program as its own
  child inside the same capsule. Both are confined as the thread's terminal is:
  the checkout writable, programs and child processes allowed, reads as a
  terminal's launch reads, the adapter's stored version a read root, and a
  per-session state folder, made fresh at every start and removed at the end,
  as `HOME` and `TMPDIR`. The environment holds those, a minimal `PATH`, the
  locale, and the configuration's `env`; no provider key, token, broker
  credential, or other `OCTANT_*` value. Plan refuses before anything launches.
- **Network.** Below; it is the only part that follows the posture beyond Plan.
- **Receipts and stops.** The capsule's process group is recorded before the
  adapter is used, under its own supervisor name, and the host reaps last run's
  sessions at startup. A session ends, with `disconnect`
  (`terminateDebuggee: true`) and then the process group stopped after five
  seconds, when the person stops it, the program exits, the thread stops being
  active, the thread moves to Plan, its posture changes the session's network
  level, the checkout becomes unavailable, no approval covers the
  configuration and package state any more, the Project is erased, or the host
  shuts down. Committed `code-thread`, `code-checkout`, extension, and approval
  events run that check at once.
- **No restart on its own.** A crashed adapter is not restarted. Restarting
  would run the program again, which only the person may cause.

**Decision DB4: adapter and program share
one capsule; DAP on stdio; no `runInTerminal`, no `attach`.** Recommended
because debugging needs the adapter and the program in one process tree (on
Linux a separate PID namespace hides one from the other; on macOS crossing
sandboxes needs task-port rights Octant should not grant), and stdio needs no
listener. Rejected: honouring `runInTerminal` to start the program in a
second capsule (the adapter would choose the argv, environment, and folder of a
process the host launches); an adapter reached as a TCP debug server (a
listener another local process could reach); `attach` to a process by id or
address (the process sits outside the session's confinement, and attaching
reads its memory). A later slice may add `attach` to a process the session
itself started, with its own decision.

### Session network

**Decision DB5: the program's network
follows the thread's posture as its commands do.** Approval-gated and
auto-accept-edits run on `proxied`, decided exactly as that thread's harness
commands are (`decideToolEgress`, the thread's and the Project's rules, taint
suspending standing rules); Full access runs on `allow`. Each session gets its
own proxy listener and launch records on a `code-debug-egress` aggregate,
journaled the way a `proxied` command's launch is, naming the Project, thread,
and configuration. A refused connection becomes a proposal on the thread's
Network access list. Nothing the program receives reaches a model, so it
taints no thread. A host with no proxy refuses as `confinement-unavailable`
below Full access, never runs on `allow` or `none` instead.

Recommended because the program is often code the thread's agent wrote, the
adapter is third-party code, and the thread's rules already say which hosts
that thread's work may reach. Residual: `proxied` refuses loopback and private
destinations, so below Full access a program that needs a local database or
service cannot reach it; the person debugs it under Full access or from a
terminal. Rejected: `allow` in every posture, as a person's terminal has (it
gives third-party adapter code an open network for every session); `none`
(most real programs fail at their first connection); the Project's rules alone,
as a `repo-tooling` server uses (a session belongs to one thread, so that
thread's rules and taint apply).

**Decision DB6: the debug port.** On
Linux the capsule's private network namespace keeps loopback between the
adapter and the program inside the capsule, under every level. On macOS
Seatbelt's `none` and `proxied` deny loopback, so an adapter that declares
`debugPorts: 1` gets one host-chosen port, filled into `{{debugPort}}`, and the
profile allows binding, inbound, and outbound on `localhost:<port>` only.
Residual: on macOS another process of the same user can connect to that port
while the session runs, as it could to a program started with a debug flag in
a terminal; most runtime debug protocols are unauthenticated. Native debugging
on macOS (an adapter that needs the program's task port) is refused as
`unsupported-platform` until a Mac measurement shows which Seatbelt rights it
needs and the maintainer approves them. Rejected: allowing all of
`localhost` (it reaches every local service, Octant's own listener included);
refusing port-using adapters on macOS (it rules out most interpreted-language
adapters).

### Protocol

The Debug Adapter Protocol wire is JSON with a `Content-Length` header on
stdio. Frames are capped at 4 MiB; a frame over the cap or one that is not a
frame ends the session. Each request has a 10-second deadline and reports
`timed-out`. The renderer never sees protocol payloads, only Octant contracts.

- **What Octant sends** (closed list): `initialize`, `launch` (the adapter's
  `launchArguments` with its placeholders filled), `configurationDone`,
  `setBreakpoints`, `setExceptionBreakpoints` (only filters the adapter
  advertised), `threads`, `stackTrace`, `scopes`, `variables`, `source` (by
  source reference only), `exceptionInfo`, `continue`, `next`, `stepIn`,
  `stepOut`, `pause`, `evaluate`, `terminate`, `disconnect`, and `cancel`.
  `evaluate` carries only an expression the person typed or a watch they
  added, in the `repl`, `watch`, or `hover` context. Each later request is
  added on purpose with its own contract. Not sent: `attach`, `restart`
  (Octant stops and starts), `setVariable`, `setExpression`, `goto`,
  `stepBack`, `reverseContinue`, `readMemory`, `writeMemory`, `disassemble`,
  and data or instruction breakpoints.
- **What an adapter may ask.** `runInTerminal` and `startDebugging` get an
  error and have no effect. Measured in 8b with debugpy 1.8.22: it never asks
  for `startDebugging`. It announces a child process with its own
  `debugpyAttach` event, which is not on the accepted list, so Octant drops it
  and does not debug the child; with debugpy's `subProcess` on, a Python child
  then waits for a client that never comes, so a debugpy package sets
  `subProcess: false` in its `launch` body. Debugging child processes needs
  its own rule, proposed under [Child processes](#child-processes-proposed)
  and not yet decided.
- **Events accepted.** `initialized`, `stopped`, `continued`, `exited`,
  `terminated`, `thread`, `output` (`console`, `stdout`, `stderr`,
  `important`), `breakpoint`, `capabilities`, `invalidated`, `process`, and
  the progress events. `telemetry` output and every other event are dropped.
- **Contracts.** A stack frame is a bounded name (256 characters) and a source
  location that is checkout-relative or `outside-checkout` with a label, as a
  definition is; host paths in frame names and output are rewritten as
  diagnostic messages are. A variable is a name (256), a value truncated at
  4 KiB with a `truncated` flag, a type (256), and an expansion reference;
  pages hold at most 200. Stack traces hold at most 200 frames. A source
  fetched by reference is shown read-only, at most 1 MiB. Octant opens no file
  outside the checkout.

### Debugger authority

- **Local person only.** Starting, controlling (breakpoints, stepping,
  `evaluate`), and stopping a session is the person at a local window whose
  Project binding holds the thread, checked on every request as a terminal's
  input is. Another local window holding the thread may control the session.
- **No agent.** No provider, tool call, subagent, routine, or hook can start,
  control, or read a session. Nothing a session shows enters a prompt.
- **Code only, macOS and Linux.** As the companion.

**Decision DB7: paired devices neither
start, control, nor observe.** The debug routes have no remote action, so the
remote gate denies them and the routes answer 403 to a device that reached them
anyway. Recommended because stepping and `evaluate` run the program on the
host, which D4 keeps with the person at the machine, and a stopped program's
variables often hold secrets, which a paired device should not read through a
new surface in the first slices. Rejected: remote observe now (a later,
remote-approvable `code.debug.observe` read of the stopped state, without
`evaluate`, can be proposed once the local panel ships); remote control.

**Decision DB8: no agent debug tools in
this addendum.** Recommended because an agent driving a debugger runs the
program and reads its memory, which needs its own approval and taint design.
Rejected: a read-only agent tool for the stopped state now.

### Debugger data and privacy

- **Never journaled or exported:** variable values, `evaluate` expressions and
  results, stack frames, program output, breakpoints, and fetched sources. They
  live in the host's memory for the session (output in a 1 MiB ring, as a
  Project terminal's transcript is) and are gone when it ends. Diagnostics
  exports carry session counts and end reasons only.
- **Journaled:** the configuration approval (its configuration, because it is
  the record of what the person allowed to run, so the confirmation card says
  the arguments and environment values are kept in this Project's record), and
  session lifecycle as `code.debug-session-started@1` and
  `code.debug-session-ended@1` on a `code-debug-session` aggregate, naming the
  Project, thread, configuration digest, and end reason. A thread purge removes
  the session records; a Project erase removes those, the approvals, and the
  egress records, and ends running sessions at once.
- **Breakpoints** are the window's state for the thread, sent at each start,
  and are not kept by the host after the session.
- **No memory views.** Memory, disassembly, and register views are not offered.

### Debugger threat model

| Threat                                                                            | Mitigation                                                                                                                                                     | Residual                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A repository file starts a program                                                | Repository files are only proposals. Nothing starts without a configuration the person confirmed at a local window and a Start they pressed                    | The person can confirm a hostile program; it then runs confined as a terminal command does |
| A launch file hides what runs (tasks, runtime executables, command variables)     | Only six fields map; every other field is listed as unused; `${command:}`, `${env:}`, `${input:}`, `${config:}` make an entry unmappable; Octant runs no tasks | None beyond what the card shows                                                            |
| A confirmed configuration changes later                                           | The approval covers one configuration digest and one adapter package state; any change asks again                                                              | None                                                                                       |
| The program or adapter writes outside the checkout                                | One capsule confined as a terminal: checkout and session state writable only                                                                                   | It can change the checkout, as a terminal command can                                      |
| Source or secrets leave the machine                                               | Below Full access, `proxied` under the thread's rules with taint suspending standing rules; Full access is the person's choice of `allow`                      | Allowed hosts can receive data, as for the thread's commands                               |
| The adapter asks the host to run or open something                                | `runInTerminal` and `startDebugging` refused; no request outside the closed list is honoured                                                                   | None                                                                                       |
| The session reads or controls a process outside its confinement                   | No `attach`; no memory requests; Linux PID namespace; native debugging on macOS refused until measured                                                         | Same-user processes on macOS stay visible to the capsule's broad read, as to a terminal    |
| Another local process drives the program's debug port                             | Linux: the port lives in the capsule's private namespace. macOS: one host-chosen port per session, nothing else on loopback                                    | On macOS a same-user process can connect to that port during the session                   |
| Variable values or output leak to the journal, exports, a paired device, or agent | Never journaled or exported; no remote action; no agent tool; output never enters a prompt                                                                     | Values on the local screen                                                                 |
| Authority drifts: Plan, archive, rebound window, package change, Project erase    | Every request is checked when it runs; each of these ends the session at once                                                                                  | A step already taken stays taken                                                           |
| Credentials reach the program                                                     | Allow-listed environment; `OCTANT_*` and stripped credential keys refused in a configuration                                                                   | A value the person typed into `env` is theirs to choose                                    |
| Resource exhaustion                                                               | Frame cap, request deadline, bounded output, frames, variables, and sources; one session per thread and four per host; receipts reaped after a restart         | No OS memory cap on macOS; the person stops a runaway program                              |

### Debugger seam rules

Sub-slice 8a settled these details, taking the more restrictive option where
the addendum left a choice open.

- **Launch body.** Any `{{` or `}}` in a string that is not exactly one whole
  placeholder is refused, an unknown `{{name}}` included, and an object key
  holds neither. The body must contain `{{program}}`, so the program the
  person confirmed is the one that runs. `{{debugPort}}` appears exactly when
  `debugPorts` is `1`: a declared port the adapter never receives is a grant
  nothing uses. The body is plain JSON (finite numbers, no `__proto__` key,
  nested at most 16 deep), and the 8 KiB bound is its UTF-8 JSON text.
  `importTypes` entries match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; plugin-host
  normalization sorts and de-duplicates them and `runtimes`.
- **Updates.** Two launch bodies are compared with their keys sorted, so key
  order alone is not a change.
- **Package.** `octant-debug-adapter.json` is read by
  `@octant/plugin-api/debug-adapter-package`, sharing the language server
  package's authored-manifest rules. A folder holding it is read as a debug
  adapter and nothing else (8b; until then the host refused it), and a folder
  holding two Octant package documents is refused.
- **Configuration.** An absent `cwd` is the checkout's root. `env` is a list
  of `{ key, value }` entries with unique keys, so no key can become an
  object's prototype. Argument and value bounds are UTF-8 bytes, and a NUL is
  refused. `OCTANT_` is refused in any letter case, and the credential names
  the host keeps from children are the closed list
  `HOST_CREDENTIAL_ENVIRONMENT_KEYS` in `@octant/contracts/code-debug`
  (provider keys and tokens, and the GitHub CLI's `GH_TOKEN`, `GITHUB_TOKEN`,
  `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN`).
- **Start decision.** `decideDebugSessionStart` refuses a thread that is not
  a Code thread as `mode-prohibited`, after `unsupported-platform` and before
  `plan-read-only`, because the kind is Code only. A start from anything but a
  local window, a paired device or an agent, is `local-host-required`. The
  policy decides coverage itself: an approval covers a start only for the
  same configuration digest, extension, component, package digest, and
  lifecycle version, in its checkout or its Project. The launch shape names
  one capsule for adapter and program, `proxied-under-thread-rules` below Full
  access and `allow` under it, and the debug port: none, inside the capsule's
  namespace on Linux, or one host-chosen `localhost` port on macOS. The
  contract's start refusals list the read-side checks first, then the
  decision's reasons, then `confinement-unavailable`.
- **Import mapping.** The host passes the parsed file, the checkout's
  folder, the editor's current file, and the effective adapters. A file with
  no `configurations` list is unreadable, and at most 64 entries are proposed,
  with `truncated` set past that. An entry whose `type` more than one
  effective adapter imports is unmappable (`adapter-ambiguous`) rather than
  given to one. A variable outside the closed set anywhere in an entry,
  unused fields included, makes it unmappable, because the entry asked the
  editor to read host state or run a command. A current-file variable with no
  file open is `needs-open-file`. A relative program or folder is taken from
  the checkout's root, and an absolute one maps only inside the checkout;
  these checks are lexical, and the host contains the result again with
  symlinks resolved. Path variables in arguments and environment values
  resolve to host paths, as the file meant. A missing or mistyped value, a
  value out of the configuration's bounds, more than 64 unused fields, or a
  field name over 128 characters is `invalid`.

### Debugger session rules

Sub-slice 8b settled these details, taking the more restrictive option where
the addendum left a choice open.

- **Configuration digest.** `sha256:` over the canonical text
  `canonicalDebugConfigurationText` builds in `@octant/domain`: a versioned
  JSON array of the name, adapter, program, arguments, folder (`null` when
  absent), environment entries sorted by name, and `stopOnEntry`. Only the
  environment's order is not an edit; a renamed configuration is a new one,
  since the record is of what the person confirmed.
- **Package and review.** An adapter's folder is read as a language server's
  is: a local folder only, the host states the identity under its own
  namespace, the binary is the package's only executable file, and the
  review names the binary, its own digest, the runtimes, the `launch` body,
  and the debug port, with the grant in words (Settings shows it). An
  installed adapter is offered only while the activation ladder makes it
  effective in Code.
- **Refusal order.** The read-side checks, then `no-debug-adapter` (a
  configuration naming an adapter that is not effective, reading the same as
  none so a refusal never says which disabled adapters exist), then the
  start decision, then `confinement-unavailable`. Listing configurations,
  confirming, and every request on a session refuse anything but a local
  window first (`local-host-required`), before reading anything; a start
  follows the decision's order. The routes answer `403` to a paired device
  before reading its body, and the remote gate classifies every path under
  `/api/code/debug/` as having no action, whatever its method.
- **Native code on macOS.** An adapter that declares the runtime `native` is
  refused as `unsupported-platform` on macOS. The declaration has no other
  field that says so; an adapter that needs the task port without declaring
  it is refused by Seatbelt itself, which grants no task-port rights.
- **Confirming.** `code.debug-configuration-approved@1` holds the approval id,
  Project, `shell-commands` class, digest, the configuration, the adapter's
  package state, and the scope. Every check a start makes runs first with the
  confirmation taken as given, so Plan refuses and nothing is recorded for a
  configuration the thread could not start; the paths are contained with links
  followed, the program a regular file and the folder a directory. A
  confirmation not appended answers `not-recorded`.
- **Limits.** A second Start on a thread with a session answers `busy`
  (`thread-has-session`) and the panel asks to stop the first; a fifth
  session on a host answers `busy` (`host-limit`). A Start counts toward both
  from the moment its checks pass, so two at once cannot both run.
- **Start.** The start record is appended before anything launches; one that
  cannot be appended means nothing runs (`launch-failed`). A stored binary
  that no longer matches the reviewed digest runs nothing
  (`adapter-unverified`). Then `initialize`, `launch` with the body filled,
  the window's breakpoints once the adapter is `initialized`, the adapter's
  default exception filters, and `configurationDone`; `launch` is awaited
  last because adapters (debugpy among them) answer it only after
  `configurationDone`. An error or a missed deadline anywhere ends the
  session as `start-failed` and answers `adapter-refused`.
- **Capsule.** The configuration's environment comes first, so the person may
  set `PATH` or the locale; `HOME`, `TMPDIR`, and the proxy variables are the
  host's and come last. Without the person's entries the environment is
  `PATH=/usr/bin:/bin` and the host's `LANG`. Sibling sessions' state folders
  are denied, and the state root is cleared at host start, so a crashed run's
  folder does not outlive it. A debug port on Linux is a free port the host
  picks (never the egress forwarder's) inside the capsule's namespace; on
  macOS the profile allows binding, inbound, and outbound on
  `localhost:<port>` only. Those Seatbelt rules are unmeasured: no Mac has
  run an adapter with a debug port yet, and 8d measures whether they work.
- **Network.** The session's egress launch id is its session id, so its
  records on `code-debug-egress` and its journaled start (which names the
  configuration digest) are one launch. Decisions use the thread's and its
  Project's rules with the thread's taint, through the same egress rules a
  command uses, so a revocation or a taint change rechecks its open tunnels;
  refusals are proposed on the thread when the session ends. Full access
  runs on `allow` with no proxy.
- **Ending.** A session ends once: `disconnect` with `terminateDebuggee`, the
  capsule's group stopped after five seconds, the end journaled, the output
  ring cleared. End reasons are `stopped`, `program-exited`,
  `adapter-exited`, `protocol-violation`, `start-failed`, `thread-inactive`,
  `plan-read-only`, `network-changed` (the posture crossed Full access),
  `checkout-unavailable`, `approval-ended` (no confirmation covers the
  configuration and the adapter as it stands, or the adapter's package
  changed since the session started, even if confirmed again), `project-erased`,
  `host-shutdown`, and `host-restarted`, which a host appends at its next
  start for every session a previous run left open. Every request re-checks
  these before it runs, and committed `code-thread`, `code-checkout`,
  extension, and confirmation events run the check once the call that
  committed them has finished, because a window leaving its own session grant
  of Full access commits the thread's event before it drops the grant. A
  thread purge ends the thread's session before it removes anything, and a
  Start the host's shutdown overtakes launches nothing. A window reading a
  session that ended learns why
  (the last 64 endings are remembered, never their values). The posture is
  the thread's as the window that pressed Start holds it, because Full access
  can be that window's own session grant; a grant that lapses without a
  journal event (the window closed) is noticed at the next request or the
  minute's sweep.
- **Answers.** Lines and columns are one-based, as the editor numbers them. A
  frame's source is placed by its resolved path; one outside the checkout is
  `elsewhere`, or `adapter-source` with its reference. Host paths are
  rewritten in frame, thread, and scope names, messages, and output, not in
  variable values, which are the program's own data. Output entries are cut
  at 64 KiB, kept in a 1 MiB ring, and answered at most 512 at a time after
  the window's last sequence, with `outputDropped` when some were lost. The
  adapter's own stderr is drained and never shown. Only exception filters the
  adapter advertised are sent. An adapter's error answer reaches the window
  as one bounded, path-rewritten message.
- **Launch file.** `POST /api/code/debug/configurations` reads
  `.vscode/launch.json` through the checkout's containment (a missing file or
  one that leads out of the checkout is `absent`), as UTF-8 JSON with line
  and block comments and trailing commas, and maps it with the import
  policy. A comment between a trailing comma and its bracket reads as
  `unreadable` rather than guessed at.
- **Diagnostics.** A diagnostics export carries `debugSessions`: over the
  journal growth window, how many sessions started and how many ended for
  each end reason, read by one grouped query on the journal's time index. It
  names no session, configuration, thread, or Project, the contract admits
  only the closed end reasons, and a packet that carries it is version 3. A
  host where no session started or ended in the window exports no section,
  so its packets stay version 2. A purged thread's or erased Project's
  sessions are no longer counted, since their records are gone.

### Debugger panel rules

Sub-slice 8c settled these details, taking the more restrictive option where
the addendum left a choice open.

- **Where it lives.** Run and debug is a Code dock tool. It reads the
  thread and checkout the dock follows and calls the four local-window
  routes through `@octant/client-runtime/code-debug-client`; it decides no
  refusal itself. An answer of `403`, which the remote gate and the routes
  give a paired device, shows that debugging stays on this computer and
  offers nothing to start or confirm.
- **Breakpoints.** A line breakpoint is set from the editor's glyph gutter
  or with F9 on the cursor's line, so the pointer is never the only way.
  They are held in the renderer's memory for the thread on its checkout,
  shared by the editor and the panel and never persisted, so a reload
  starts with none. A toggle past 256 lines in a file or 64 files takes
  none, since the host would refuse the Start, and the editor says which
  bound it reached until the next toggle it takes. Start sends them all;
  while a session runs, each file whose lines change is sent at once with
  `set-breakpoints`. The panel offers no conditions, exception filters,
  watches, or hover evaluation yet: the adapter's default exception filters
  apply, as the host sends them.
- **The current file.** A launch file's current-file variables are filled
  from the editor file the person last opened or focused for the thread,
  and the panel lists again when it changes.
- **Confirming.** A proposal or a written configuration opens the same card:
  the adapter with the package and version it came from (the host lists
  both, as Settings names the package), program, each argument, the
  working folder, each environment entry, whether it pauses at the first line, every field Octant does not
  use, and that the values are kept in the Project's record. A written
  configuration is checked against the contract's shape before the card;
  the host checks paths and everything else when it is confirmed. Where two
  effective adapters share a name, the list and the adapter picker name each
  one's package and version too, and its id when even those match.
- **One session per thread.** While a session runs, the panel shows it in
  place of the configuration list, so a person stops it before starting
  another. A `busy` answer for a session the panel does not hold (another
  window's, or one from before a reload) says so and offers nothing: no
  route names a thread's running session, so the panel cannot stop it.
- **Reading a session.** The panel asks for the state every 400 ms while
  the program runs and every second while it is paused, one request at a
  time. At each new revision while paused it reads the stack, the top
  frame's scopes, and the first scope that is not marked expensive; an
  expensive scope is read when opened, and nested values open on demand to a
  depth of eight. What it read is dropped when the program runs again or
  the session ends; the console keeps its last 1,000 lines in the
  renderer's memory for the session only. A notice that the host could not
  be reached clears at the host's next answer, so a recovered poll leaves
  no stale warning.
- **The stopped place.** At each stop the top frame's checkout file opens
  through the ordinary file-open path at its line, and the editor marks the
  line until the program runs, the session ends, or the Run and debug tool
  closes. With the tool closed nothing polls the session, so a kept mark
  could name a line the program has left; the session keeps running, and
  reopening the tool reads the stop and marks it again. A frame outside the
  checkout opens nothing; an `adapter-source` frame's text is fetched by
  reference and shown read-only in the panel.
- **Evaluate.** The console sends what the person typed as `repl` in the
  selected frame; the adapter's error answer is a console line.

### Child processes (proposed)

**Status: proposed on 2026-10-28; waits on the maintainer's decision DB9.
Not built.** Until DB9 is decided, the [Protocol](#protocol) rule stands: an
adapter's child announcement is dropped, and the child runs undebugged.

The outcome: a program that starts another program (Python's `subprocess` or
`multiprocessing`, a test runner's workers) stops at the person's breakpoints
in the child too, and the panel lists each child under the session.

**Why the accepted rules do not cover it.** Measured in 8b with debugpy
1.8.22, debugpy announces a child with its `debugpyAttach` event. The event's
body is the configuration for a second DAP connection: an `attach` request
naming the child, and a `connect` host and port where the adapter listens for
that connection. Answering it needs three things the addendum refuses: the host
opening a connection to a listener the adapter holds (DB4 rejects an adapter
reached over TCP), the `attach` request (DB4), and on macOS loopback ports
beyond the session's one debug port (DB6). DB4 left this open: a later slice
may add `attach` to a process the session itself started, with its own
decision.

The proposed rule, which is the recommended answer to DB9:

- **Declared, not assumed.** An adapter that debugs children declares
  `childSessions: 1` (default `0`) in `debugAdapter` and names how it
  announces a child: the standard DAP `startDebugging` request, or one event
  name of its own (`debugpyAttach` for debugpy). Raising `childSessions` or
  changing the announcement is a capability expansion: quarantine, trust, and
  switches cleared. The review card says the adapter also debugs the child
  processes of the program it starts. An adapter that declares nothing keeps
  today's behaviour.
- **Discovery is the announcement, on the session's own connection.** The
  host never scans processes, reads another process's state, or attaches by
  process id. An announcement counts only while its parent session runs and
  is not ending. A session holds at most 8 children at once and 32 over its
  life; past either bound the announcement is dropped and the panel says a
  child ran undebugged.
- **The host chooses the port.** A session whose adapter declares children
  gets one host-chosen child port, set by the host as
  `OCTANT_DEBUG_CHILD_PORT` in the capsule's environment after the person's
  entries, as `HOME` and `TMPDIR` are. The adapter's package makes its child
  listener use that port. An announcement whose host is not loopback, or whose
  port is not the session's child port, is refused, and the host connects
  nowhere. Reason: under Full access on Linux the capsule shares the host's
  network, so a port the adapter named could be any local service, Octant's
  own listener included.
- **Reaching the child port.** On Linux under `proxied`, the capsule's private
  namespace hides its loopback from the host, so a relay started inside the
  capsule beside the egress forwarder listens on a Unix socket in the
  session's state folder and connects only to the child port inside the
  namespace; the host connects to that socket. On Linux under Full access the
  host connects to the child port on loopback. On macOS the profile allows
  binding, inbound, and outbound on `localhost:<child port>`, as DB6 allows
  the debug port.
- **The child reaching the adapter.** Before it is announced, a debugpy child
  connects back to the adapter on a second listener. On Linux that connection
  stays inside the capsule's namespace, or on the open loopback under Full
  access. On macOS Seatbelt denies it unless that listener also uses a
  host-chosen port, so an adapter that declares children gets a second one,
  `OCTANT_DEBUG_CHILD_SERVER_PORT`, on the same terms. Whether debugpy's
  package wrapper can pin both listeners to host-chosen ports is unmeasured
  and is the slice's first measurement. If it cannot, children are refused on
  macOS as `unsupported-platform`; loopback is not opened further.
- **What the host sends on a child connection.** The closed list is
  unchanged, except that `attach` takes the place of `launch`, sent once. Its
  body is the announced configuration, bounded at 8 KiB, with `connect`
  removed; the host adds nothing. The `attach` reaches the same adapter in the
  same capsule, so it reaches only processes the capsule already reaches: on
  Linux the PID namespace hides every other process, and on macOS Seatbelt
  grants no task port. A parent session still refuses `attach`.
- **Approval.** The configuration's approval covers the children of the
  program it starts, with no prompt per child. Reason: the child is code the
  confirmed program chose to run, in the same capsule and network, and it can
  already run undebugged. A child session is not a Start: it counts toward
  neither the per-thread nor the per-host session limit.
- **Same confinement.** A child runs in its parent's capsule, with the same
  filesystem, environment, network level, egress proxy and rules, and
  receipt. The host launches nothing for a child; the Linux relay is one per
  session.
- **Ending.** A child session ends when its process exits, when the adapter
  closes the child connection, or when the person stops that child, with
  `disconnect` and `terminateDebuggee: true`. Every end of the parent ends its
  children first; a child's end never ends the parent. The parent's
  `code.debug-session-ended@1` record adds how many children were attached,
  as a count only.
- **Authority and data.** As the parent: a local window only, no paired
  device, no agent, and nothing from a child journaled or exported. The panel
  lists children under the session; the window's breakpoints apply to the
  parent and every child.

**Decision DB9 (open).** The maintainer decides whether the host may open a
connection into a running session's capsule (the Linux relay and the macOS
child listener), whether `attach` may be sent at all, and whether macOS gets
up to two more loopback ports per session. Recommended: the rule above.
Alternatives:

1. Leave children undebugged, as today. Nothing new is granted, a debugpy
   package keeps `subProcess: false`, and a program that does its work in a
   child cannot be debugged in Octant.
2. The rule above on Linux only, with children refused on macOS until 8d has
   measured the one debug port's Seatbelt rules. Grants no new loopback on
   macOS now.
3. The rule above with a prompt at each child. Not recommended: it repeats
   the confirmation's act, a worker pool would prompt many times, and
   repeated prompts train people to accept them unread.
4. The standard `startDebugging` request only, never an adapter's own event.
   Provider-neutral, but it does nothing for debugpy, the one adapter
   measured.

| Threat                                               | Mitigation in the proposed rule                                                                                                     | Residual                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| The adapter points the host at another local service | The host connects only to the session's own host-chosen child port; any other host or port is refused before a connection is opened | None                                                                                     |
| `attach` reaches a process outside the session       | Sent only on a child connection to the same adapter in the same capsule; Linux PID namespace; no task port on macOS                 | As for the parent: same-user processes on macOS stay visible to the capsule's broad read |
| A child escapes the parent's confinement or network  | The child runs in the parent's capsule; the host launches nothing for it                                                            | None beyond the parent's                                                                 |
| Another local process drives a child port on macOS   | Host-chosen ports, held only while the session runs                                                                                 | A same-user process can connect to them during the session, as to the debug port         |
| A program floods the host with children              | At most 8 at once and 32 per session; the rest run undebugged                                                                       | None                                                                                     |
| A child outlives its session                         | Every end of the parent ends its children, then the capsule's group as today                                                        | As for the parent: a process that calls `setsid()` leaves the group                      |

_Verify, if accepted:_ a fixture adapter that announces a child by event and
by `startDebugging`, under Bubblewrap in an approval-gated thread: the child
stops at a breakpoint and answers its stack; an announcement naming another
port is refused and nothing connects; an announcement after the parent ended,
past the bounds, or from an adapter that declared nothing is dropped; a
parent's Stop ends its children; the child cannot write outside the checkout
and its connection to a host no rule allows is refused by the session's
proxy. Then real debugpy under Bubblewrap, and on a Mac with 8d.

### Debugger delivery

Each sub-slice is its own pull request with this addendum updated in place.

- **8a. Seam and policy.** Container: yes.
  - Add the `debug-adapter` kind and `debugAdapter` declaration to
    `@octant/contracts/extensions`, `@octant/plugin-api` (with the
    `debug-adapter-package` document), and `@octant/plugin-host`
    normalization; Code only, quarantined by default.
  - Add the pure `decideDebugSessionStart`, the configuration schema, and the
    pure import mapping from a parsed launch file to proposals.
  - _Accepts when:_ the refusal order holds for every platform, mode, posture,
    starter, approval, and configuration state; unknown fields and in-string
    placeholders are refused on decode; the mapping drops and lists unused
    fields, refuses `${command:}`-style variables and outside-checkout paths,
    and maps only `launch` entries; an update that changes `launchArguments`
    or raises `debugPorts` is quarantined.
  - _Verify:_ focused contract, domain, and plugin-host tests; typecheck
    consumers; `style:check`.
  - _State:_ built. The start policy's refusal order holds for every
    platform, mode, posture, starter, approval state (none, this checkout, the
    Project, another checkout, an edited configuration, a changed package),
    and configuration state (`debugSessionStartPolicy.test.ts`). Unknown
    fields, in-string and unknown placeholders, a body without the program,
    and an unfilled or undeclared port fail to decode (`extensions.test.ts`),
    as do configurations with host paths, escapes, or reserved environment
    names (`codeDebug.test.ts`). The mapping maps only `launch` entries one
    adapter imports, lists unused fields, and refuses `${command:}`-style
    variables and outside-checkout paths (`debugLaunchFileImport.test.ts`).
    Installed through the lifecycle service, an adapter stays untrusted and
    disabled and is `mode-prohibited` in Chat and Work, and an update that
    changes its launch body or raises its ports is quarantined
    (`extensionLifecycleService.test.ts`). The rules are under
    [Debugger seam rules](#debugger-seam-rules).
- **8b. Session host.** Container: yes for Linux.
  - The server reads the package, records approvals, launches the capsule with
    its receipt and egress proxy, holds the DAP connection with its closed
    lists, serves local-window routes, and ends sessions on every stop above.
  - _Accepts when:_ a fixture adapter and fixture program in an
    approval-gated thread hit a breakpoint, return a stack and variables, step,
    continue, and exit, through the real companion under Bubblewrap; nothing
    launches without a confirmed configuration; Plan, a paired device, an
    agent's request, and a changed configuration or package are refused; the
    program cannot write outside the checkout and its connection to a host no
    rule allows is refused by the proxy and journaled; `runInTerminal`,
    `attach`, and an oversize frame are refused or end the session; a restarted
    host reaps receipts; no variable value appears in the journal.
  - _Real adapter:_ one open-source adapter that speaks DAP on stdio,
    debugging a fixture in the container, records whether it needs
    `startDebugging` and whether `ptrace` works inside the capsule.
  - _Verify:_ server integration and permission-negative tests. The
    `macos-15` CI job runs the same process test for Seatbelt evidence.
  - _State:_ built for Linux. Under Bubblewrap, through the real companion
    (`codeDebugServiceProcess.test.ts`), the fixture adapter and program in an
    approval-gated thread stop at a breakpoint, return the stack (a host path
    in a frame name rewritten, frames outside the checkout labelled) and
    variables, evaluate, step, continue, and exit; the program writes the
    checkout but not the home folder, cannot reach a host listener directly,
    and its `CONNECT` to `example.com:443` is refused `403` by the session's
    proxy, journaled on `code-debug-egress`, and proposed on the thread; no
    variable value or program output is in the journal. Nothing launches
    before a confirmation; Plan, a paired device (service and route `403`),
    an edited configuration, and a package switched off and on are refused;
    Plan, a posture across Full access, a package change, an archived thread,
    a Project erase, a Stop, and host shutdown each end a running session.
    The adapter's `runInTerminal` and `startDebugging` are refused and run
    nothing; `attach` and memory requests do not decode and are not on the
    connection's closed list (`debugAdapterConnection.test.ts`,
    `codeRoutes.test.ts`); an oversize frame ends the session; a restarted
    host reaps the capsule's receipt and closes its open session record.
    Agents have no tool or route that reaches a session, and the start
    policy refuses an `agent` starter. _Real adapter:_ debugpy 1.8.22 (MIT,
    from PyPI, vendored into a scratch package; not committed) on CPython
    3.13 under Bubblewrap 0.9.0, Linux 6.18, `proxied`: a breakpoint, the
    stack, locals, `evaluate`, a step, continue, and exit all worked through
    the session host. It needs no `startDebugging` (above). `ptrace` works
    inside the capsule: the program attached to its own forked child with
    `PTRACE_ATTACH`. The `macos-15` CI job ran the same process test under
    Seatbelt and passed on 2026-10-27 ([job][macos-ci-2026-10-27]). Still to
    run: the Mac smoke of 8d.
- **8c. Run and debug panel.** Container: yes.
  - Gutter breakpoints, the configuration list with imported proposals and the
    confirmation card, the session toolbar, call stack, variables, the debug
    console with `evaluate`, and every refusal state; a user-guide page.
  - _Accepts when:_ a person confirms an imported configuration, starts it,
    stops at a breakpoint, inspects a variable, steps, and stops, in an
    approval-gated thread; Plan and a paired browser show the refusal.
  - _Verify:_ component tests and rendered QA at pane and dock widths, in light
    and dark themes.
  - _State:_ built. In the component tests (`RunDebugPanel.test.tsx`) a person
    reviews a launch file proposal (its unused fields listed, its unmappable
    sibling with its reason), confirms it for the checkout, starts it with the
    window's breakpoints, sees the program paused at the breakpoint with its
    stack (a frame outside the checkout labelled), a variable, and a nested
    value, evaluates an expression in the selected frame, steps, sets a
    breakpoint that reaches the running session, and stops; the editor is
    asked to show each stopped line and clears it at the end. A Plan thread's
    refusal and a paired browser's `403` show as refusals; a written
    configuration refuses a malformed environment line and is confirmed for
    the Project. The editor sets and clears a breakpoint from its gutter and
    marks the stopped line (`MonacoEditorPane.test.tsx`), and the client
    reads a `403` as local-only (`codeDebugClient.test.ts`). Rendered QA on
    Linux drove the real Monaco editor, the panel, and the client against the
    real session host with the fixture adapter under Bubblewrap in an
    approval-gated thread, at a 1280 px window with a 420 px dock and a
    760 px window with a 320 px dock, in light and dark: a gutter
    breakpoint, a confirmed launch file proposal, a stop at the breakpoint
    with the editor marking the line, a nested variable, an evaluated
    expression and an adapter error, a step to the next line, and Stop
    clearing the mark, with no horizontal overflow. The same run against a
    Plan thread showed the host's refusal on confirming, and against a
    paired device's `403` showed that debugging stays on this computer.
    Review follow-ups are built too: a gutter toggle past either breakpoint
    bound says which one (`MonacoEditorPane.test.tsx`); two adapters that
    share a name are told apart by package and version in the list and on
    the card; closing the tool clears the editor's stopped line and
    reopening it marks the line again; and the unreachable-host notice
    clears once the session answers (`RunDebugPanel.test.tsx`). The listing
    names each adapter's package and version
    (`codeDebugServiceProcess.test.ts`), and a diagnostics export counts
    sessions by end reason (`diagnosticsExportService.test.ts`). Rendered
    QA of these on 2026-10-27 (the real Monaco editor and the panel against
    a fake host, Chromium at 1280 and 390 px, light and dark) showed both
    breakpoint notices, the shared-name list and card, and the unreachable
    notice clearing, with no horizontal overflow or console errors. The
    rules are under [Debugger panel rules](#debugger-panel-rules).
- **8d. macOS confined-program smoke.** Container: no; a Mac (the `macos-15`
  CI job where it can, otherwise the maintainer).
  - _Accepts when:_ on Apple Silicon, under Seatbelt, a session's adapter and
    program are refused a write outside the checkout and session state, a
    connection outside the thread's rules, and loopback ports other than the
    session's own; the session's own debug port works; quitting the host ends
    the session's process group; the result is recorded here with the macOS
    and Octant versions.

## Settled by existing specifications

- Authority is checked on the server before effects, and the renderer holds
  none ([architecture](../architecture.md#security-and-authority)).
- One confinement port. A missing backend fails closed, and Windows Code is
  refused until its confinement design exists
  ([architecture](../architecture.md#current-release-boundary)).
- Executable components are quarantined until reviewed, then supervised.
  Installing never implies trust or enablement, and disabled components
  contribute nothing ([activation ladder](../architecture.md#extensions-and-skills)).
- New capabilities reach the host through published seams. A seam is widened
  in its own change ([AGENTS.md](../../AGENTS.md#product-invariants)).
- Plan is read-only, Code starts approval-gated, and approvals are categorized
  and journaled ([security and authority](../architecture.md#security-and-authority)).
- Remote clients never exceed host authority, and running commands on the host
  stays with the person at the machine (`remoteAccessPolicy.ts`).
- Repository-controlled configuration never activates a tool. Skills discovery
  uses a closed allow-list, and provider runtimes are kept off repository-declared
  servers ([extensions and skills](../architecture.md#extensions-and-skills)).
- Ephemeral reads are not a second journal
  ([Workspace: tool lifecycles](workspace.md#tool-lifecycles)).

## Maintainer decisions

The maintainer accepted these on 2026-10-26. Each states the rule; the
alternatives considered and the reason for the choice follow it.

1. **D1. Source of the first server.** Octant bundles the pinned `typescript`
   native binary, about 24 MB per architecture. It is already a dependency, it
   speaks LSP natively, and it runs no repository code. Rejected for now: using
   the Project's own installed TypeScript, which runs a repository-supplied
   binary and so would be `repo-tooling`; it could come later as a person's
   explicit choice. Rejected: a third-party language-server dependency, which
   adds a dependency for nothing the bundled binary lacks.

2. **D2. Bundled server on by default.** The bundled server is on for Code,
   with a Settings › Code switch to turn it off. It ships inside the signed app,
   as Monaco does, and as a `static` server it grants nothing beyond what the
   thread can already read. User-added servers always follow the full ladder.
   Rejected: off until the person turns it on.

3. **D3. Plan threads.** Plan threads are served by `static` servers, and
   `repo-tooling` servers are refused there. Rejected: refusing every server in
   Plan.
4. **D4. Paired devices.** Paired devices may read (`code.language.read`) for
   threads they can already reach; starting `repo-tooling` servers and debug
   sessions stays local-host only. Rejected: local windows only.
5. **D5. Agent access** (slice 7). Agents get read-only app-managed tools in
   the closed catalog, available in Plan and provider-neutral, after the editor
   slices ship. Rejected: never, with agents running checks through their own
   tools.
6. **D6. Network for `repo-tooling` servers.** `proxied` under the Code
   Project's egress rules. A thread rule does not apply because the server
   serves the checkout, not one thread. Rejected: `none`, and following the
   starting thread's posture.

7. **D7. Extension host.** Octant hosts no other editor's extension API.
   Language-server and debug-adapter component kinds on the existing ladder
   satisfy the "extension host" scope. Rejected: a distinct extension host. A
   foreign extension API is a very large, fast-moving surface; emulating it
   imports another product's API, and its install-equals-run model conflicts
   with the activation ladder.

## Delivery plan

Each slice is its own pull request with this spec updated in place. "Container"
means an agent can implement and verify the slice in a Linux container without
accounts or hardware.

1. **Seam and policy.** Container: yes.
   - Add the `language-server` component kind (declared languages and class)
     to `@octant/contracts/extensions`, `@octant/plugin-api`, and
     `@octant/plugin-host` normalization. It is executable, so it is
     quarantined by default, and it is `mode-prohibited` outside Code.
   - Add the pure domain launch policy (class × posture × platform → a launch
     shape or a refusal reason).
   - Add the wire schemas for diagnostics and definition reads and their
     refusal union, and classify `code.language.read` as a remote action.
   - _Accepts when:_ the policy table above holds in focused tests, unknown
     classes and kinds are refused on decode, and every consumer typechecks.
   - _Verify:_ focused contract and domain tests, typecheck consumers,
     `style:check`.
   - _State:_ built. The launch table holds for every class, posture,
     platform, starter, and approval in the domain tests. Unknown classes,
     fields, and kinds fail to decode. Installing a language-server package
     through the lifecycle service leaves it untrusted and disabled, and once
     enabled it is still `mode-prohibited` in Chat and Work. An update that
     widens it to `repo-tooling` is quarantined for review. The rules settled
     on the way are under [Seam and launch decision](#seam-and-launch-decision).
2. **Companion supervisor and the bundled TypeScript server.** Container: yes
   for Linux.
   - The server launches, frames, allow-lists, times out, idles, crash-limits,
     and receipts the companion, and serves the two reads with every authority
     check above.
   - _Accepts when:_ a two-file fixture returns its type error and
     cross-file definition through the real binary under Bubblewrap with the
     network unshared, the no-fork filter loaded, and the checkout read-only.
   - _Negatives:_ an archived thread, a checkout mismatch, a path escape
     through a symlink, an outside-checkout definition, a diagnostic message
     naming a host path outside the checkout, a server `applyEdit`,
     an oversize frame, the crash budget, missing `bwrap`, another platform,
     and a device without reach are each refused or contained. A restarted
     host reaps receipts.
   - _Verify:_ server integration tests. macOS Seatbelt evidence needs a Mac:
     either the slice adds this test to the existing `macos-15` CI job, or a
     maintainer runs it.
   - _State:_ built. On Linux the bundled `tsc --lsp --stdio` 7.0.2 answers the
     two-file fixture's type error and cross-file definition under Bubblewrap
     with the network unshared, the no-fork filter loaded, and the
     checkout bound read-only, in a Plan thread
     (`codeLanguageServiceProcess.test.ts`). A hostile fake server covers
     `applyEdit`, `executeCommand`, and `showDocument` (method-not-found, the
     checkout unchanged), host paths in messages, outside-checkout and
     symlinked definitions, an oversize frame, a missed deadline with its
     `$/cancelRequest`, the crash budget and retry, idle and archive stops, and
     a restarted host reaping receipts. Archived and completed threads, a
     checkout mismatch or unavailable checkout, a symlink escape, a device
     without reach, another platform, and a missing `bwrap` are refused before
     anything launches. The `macos-15` CI job runs the same test for Seatbelt
     evidence; it passed there on 2026-10-27 ([job][macos-ci-2026-10-27]).
     The rules are under
     [Companion rules](#companion-rules).
3. **Editor wiring.** Container: yes.
   - Monaco shows the companion's diagnostics as markers. Definition (F12 or
     Cmd-click) opens an in-checkout target through the ordinary file-open
     path and shows an outside-checkout result as a short notice.
   - Drafts sync with debounced `didChange`.
   - The editor shows starting, off, refused, crashed (with retry), and
     unsupported-platform states.
   - A model the companion serves shows only its diagnostics. Monaco's workers
     keep colouring and single-file editing.
   - Add the Settings › Code switch and a user-guide page.
   - _Accepts when:_ a person sees a cross-file type error and jumps across
     files in a Code thread, Plan included, locally and from a paired browser.
   - _Verify:_ component tests and rendered QA at pane and dock widths, in
     light and dark themes.
   - _State:_ built. Component tests cover the markers (Plan included), one
     debounced change per settled draft, a definition opened in another file at
     its place, the outside-checkout notice, the off, refused, and
     unsupported-platform states, and a crash with its Retry; the Settings
     switch and the host's `turned-off` answer, with its running server
     stopped, are tested at the view, settings, and service levels. Rendered QA
     on Linux drove the real Monaco editor and Code client against the real
     language service and bundled `tsc --lsp --stdio` under Bubblewrap, for a
     Plan thread, at 900 and 420 px in light and dark: the cross-file type
     error appeared as a marker with the server's message, F12 and Ctrl-click
     opened the definition in the other file at its line, F12 on a standard
     library name showed the outside-checkout notice, and the off state showed
     with the switch off. The same run as a paired device's caller served it
     too. The paired-device route's classification is the slice 2 route test;
     a packaged app on a Mac is slice 4's. Rendered QA of the Settings ›
     Code switch on 2026-10-27 (from `46834576e`, Chromium at 1440 and
     390 px, light and dark through the app's theme provider) showed it on,
     off, and refused with no horizontal overflow or console errors. It found
     that a refused change left the switch showing the refused position while
     the host kept the old one, and no later change sent it. A switch or pick
     that is not saved, whether the host refuses it, refuses it as stale after
     another change, or the window holds it back for an unfinished editor
     path, now returns to what the host holds, and typed text stays
     (`CodeSettingsView.test.tsx`). The rules are under
     [Editor rules](#editor-rules).
4. **Ship the binary.** Container: partly.
   - Include the per-architecture binary in the packaged desktop app and the
     headless artifact (`scripts/package-headless.ts`), signed with the app on
     macOS, with its license notice.
   - _Accepts when:_ a packaged app serves slice 3's scenario with no
     development checkout present.
   - _Verify:_ unsigned Linux packaging in the container. A signed and
     notarized Apple Silicon package needs the maintainer's signing credentials
     and a Mac.
   - _State:_ built; the signed Apple Silicon run is the maintainer's. The
     Linux x64 headless artifact, extracted outside the repository with no
     `node_modules` above it, served the scenario through its own server and
     its own binary under Bubblewrap, and stopping the host stopped the
     binary; an artifact built without this slice refused the same open as
     `no-language-server`. Packaging tests cover the staged package, the
     refusals, the headless roles, and the signing order and arguments. The
     Linux AppImage was not built in the container: its native rebuild
     fetches Electron's headers from `electronjs.org`, which the container's
     network refused. Still to run: `bun run package:desktop` with signing
     credentials on an Apple Silicon Mac, then
     `bun scripts/smoke-packaged-language-services.ts desktop`; the same smoke
     covers the Linux AppImage's portable folder where its packaging can
     reach that host. The rules are under [Packaging rules](#packaging-rules).
5. **User-added `static` servers.** Container: yes.
   - Install through the existing package store, untrusted and switched off.
     The review card names the binary, digest, languages, class, and "cannot
     write, run other programs, or reach the network". Then enable.
   - _Accepts when:_ an unreviewed server never starts, and a server that tries
     to exec or connect fails under confinement.
   - _Verify:_ extension lifecycle and supervisor tests, plus a hostile fixture
     server.
   - _State:_ built. A package folder imported through the local folder
     registry and installed through the extension lifecycle stays out of the
     companion while untrusted, with only its plugin switched on, and until its
     component is on; withdrawn trust stops it; and a binary changed in the
     store after review never runs (`installedLanguageServersProcess.test.ts`).
     On Linux a hostile fixture server, installed, trusted, and enabled the
     same way and started by the real companion under Bubblewrap in a Plan
     thread, could not start a child (`EPERM` from the no-fork filter),
     connect to a listener on the host's loopback or to an internet address,
     or write the checkout (`EROFS`); it wrote only its cache, and the host's
     listener saw no connection. The `macos-15` CI job runs the same test for
     Seatbelt evidence; it passed there on 2026-10-27
     ([job][macos-ci-2026-10-27]). The inspection preview's
     language-server review is covered in the server test and in Settings
     (`ExtensionsSettingsView.test.tsx`). Rendered QA on 2026-10-27 (from
     `46834576e`, Chromium at 1440 and 390 px, light and dark) showed the
     review card for a `static` and a `repo-tooling` server inside Settings,
     and the installed card effective, blocked by mode, and awaiting review,
     with no horizontal overflow or console errors. At 390 px it found the
     digest drawn over its label, the component's kind over its name, and the
     grant sentence cut off inside a scroll box above Confirm install. Now the
     label keeps its column, the kind line goes under the name on a phone,
     and only a package's own text is bounded. A debug adapter review and a
     plugin's bundled skill instructions, rendered the same way, keep their
     labels clear and their grant sentence and heading in view, with only
     the launch request or instructions scrolling. The rules are under
     [User-added servers](#user-added-servers).
6. **`repo-tooling` servers.** Container: yes.
   - Use the shell-command approval per checkout and component, rememberable
     per Project from a local window only. Plan refuses. The class can write to
     the checkout after approval and reaches the network through `proxied`
     under D6.
   - _Accepts when:_ no launch happens without approval, a remote device cannot
     start one, and egress outside the rules is refused and journaled the way
     `proxied` journals.
   - _Verify:_ approval, permission-negative, and egress tests.
   - _State:_ built. A `repo-tooling` package installs untrusted with its class
     in review. Reviewed, trusted, and switched on, it answers
     `approval-required` and nothing launches; a paired device can neither
     start nor approve it, Plan cannot approve it, and nothing is journaled
     until the person at a local window approves it. Once approved it starts,
     still refuses a paired device and a Plan thread while it runs, survives a
     restart through the journal, and stops and asks again after its package
     changes, a crash restart included (`installedLanguageServersProcess.test.ts`,
     `languageServerApprovals.test.ts`). On Linux, approved and started by the
     real companion under Bubblewrap, a fixture server ran another program and
     wrote the checkout, reached neither this host nor the internet directly,
     and its proxy answered `403 no-rule` for a public host and `ip-literal`
     for this host's listener, which saw no connection; the launch's start and
     summary, with the refusal, are in the journal. The route answers only a
     local window, and a paired device is refused before the service
     (`codeRoutes.test.ts`); the editor's approval and the review copy are
     covered in `MonacoEditorPane.test.tsx` and
     `ExtensionsSettingsView.test.tsx`. Rendered QA on 2026-10-27 (from
     `46834576e`, the real Monaco editor in Chromium at 1440 and 390 px,
     light and dark) showed the approval line with Allow in this checkout and
     Allow in this Project, an approval that opened the file with one marker,
     a host refusal naming the local window, and an approval not recorded,
     with no horizontal overflow or console errors. A Project erase removes the
     approvals, from the running host too, and the egress records
     (`threadPurge.test.ts`). A revoked Project rule, or a thread taking in
     outside content, closes a server's idle tunnel at once,
     and a proxy that cannot join that recheck does not start
     (`nativeHarnessEgress.hostile.test.ts`), and a tainted thread in
     another Project bound to the same folder, to one holding it, or to one
     inside it (a child named `..cache` included) suspends the rules (`codeLanguageServiceProcess.test.ts`). The `macos-15` CI
     job runs the same process test for Seatbelt evidence; it passed there on
     2026-10-27 ([job][macos-ci-2026-10-27]). The rules are under
     [Repository tooling](#repository-tooling).
7. **Agent read tools** (D5; after the editor slices ship). Container: yes.
   - Add read-only `code-diagnostics` and `code-definition` app-managed tools
     to the closed catalog, through the provider SDK's tool transport, for
     every provider that supports app-managed tools. Providers without that
     support report it unsupported.
   - _Accepts when:_ the conformance harness passes and Plan threads can use
     the tools.
   - _Verify:_ provider-sdk conformance. A real-provider smoke needs the
     maintainer's provider sign-in.
   - _State:_ built; the real-provider smoke is the maintainer's. The provider
     SDK's chat conformance carries both reads to a Code session in Plan and
     answers one, proves a provider without app-managed tools refuses them
     before sending, and fails a driver that asks for a tool the turn did not
     offer (`chatConformance.test.ts`); every in-tree adapter's conformance
     passes with that check. The Code runtime offers a Plan turn both reads
     and answers one through the language service, and offers neither to a
     provider without app-managed tools (`codeOperationRuntime.test.ts`). On
     Linux the bundled `tsc --lsp --stdio` under Bubblewrap answered an
     agent's diagnostics and cross-file definition for a saved file in a Plan
     thread, and its next read saw a saved fix
     (`codeLanguageServiceProcess.test.ts`); the same suite covers refusals
     before any launch, a `repo-tooling` server never started or read through
     even while a local approval covers it and the editor runs it, an editor's
     draft left in place, a file too large, and the crash budget. Still to
     run: one Code turn in Plan on a signed-in Claude Code and a signed-in
     Codex provider, asking the agent to read a type error and a definition
     through the two tools. The rules are under
     [Agent read rules](#agent-read-rules).
8. **Debugger.** Container: design yes, implementation yes for Linux.
   - First a design addendum in this spec, approved before any code.
   - The addendum covers a `debug-adapter` component kind using the Debug
     Adapter Protocol. Starting a session is local-host only and needs the
     shell-command approval. The debuggee is confined by the thread's posture,
     as a terminal is. Plan refuses. Launch configurations found in the
     repository are proposals the person confirms, never run on their own.
   - _Verify:_ set by the addendum, including a macOS confined-debuggee smoke
     on a Mac.
   - _State:_ the [Debugger addendum](#debugger-addendum) was accepted on
     2026-10-27; its sub-slices 8a to 8d are the delivery plan. 8a to 8c are
     built; 8d needs a Mac. Debugging a program's child processes (debugpy's
     `debugpyAttach`) is [proposed](#child-processes-proposed), waits on
     decision DB9, and is not built.

The extension host is not planned (D7). Each slice is reviewable and leaves
the editor working when the companion is off or refused.

[macos-ci-2026-10-27]: https://github.com/Ogard-Labs/octant/actions/runs/40518838249/job/122239890114

## Verification for this document

Documentation only: formatter, path and decision checks, and `git diff
--check`. The 2026-10-26 binary smoke above is design evidence, not
implementation evidence. Slice 2 repeats it as a test.
