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
**Slice 1 (seam and policy) is built; nothing launches a language server
yet.** Slice 2 is next. Monaco editing and the explicit
external-editor handoff stay the primary Code editing paths and are unchanged
by every slice.

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
  (`ExtensionComponentKind`). Slice 1 added the `language-server` kind; there
  is no debug-adapter kind.
- **Language seam (slice 1).** `packages/contracts/src/extensions.ts` declares
  the `language-server` kind and its `languageServer` declaration;
  `packages/plugin-host/src/activation.ts` admits it in Code only;
  `packages/domain/src/languageServerLaunchPolicy.ts` decides a launch;
  `packages/contracts/src/codeLanguage.ts` holds the read and refusal
  contracts; and `code.language.read` is remote-approvable in
  `remoteAccessPolicy.ts`. No server module uses them yet.
- **Network levels.** `apps/server/src/process/threadEgressPolicy.ts` resolves
  `none`, `provider-endpoints-only`, and `unrestricted`. The
  [harness tool egress rules](../architecture.md#harness-tool-egress-rules)
  materialize `proxied` for commands.
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
- **Read before start.** Every authority check of a read, `no-reach`
  included, runs before the launch decision is consulted. A refused read never
  starts a server, so a paired device can start a `static` server only for a
  thread it already reaches (D4).
- **Not yet wired.** No server module uses the policy or the read contracts
  until slice 2. The module wiring check lists both as islands until then.

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
- **Journal.** Slices 1 to 5 add no journal events. Approvals added in later
  slices are journaled like every other grant. Diagnostics exports carry
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
4. **Ship the binary.** Container: partly.
   - Include the per-architecture binary in the packaged desktop app and the
     headless artifact (`scripts/package-headless.ts`), signed with the app on
     macOS, with its license notice.
   - _Accepts when:_ a packaged app serves slice 3's scenario with no
     development checkout present.
   - _Verify:_ unsigned Linux packaging in the container. A signed and
     notarized Apple Silicon package needs the maintainer's signing credentials
     and a Mac.
5. **User-added `static` servers.** Container: yes.
   - Install through the existing package store, quarantined. The review card
     names the binary, digest, languages, class, and "cannot write, run other
     programs, or reach the network". Then enable.
   - _Accepts when:_ an unreviewed server never starts, and a server that tries
     to exec or connect fails under confinement.
   - _Verify:_ extension lifecycle and supervisor tests, plus a hostile fixture
     server.
6. **`repo-tooling` servers.** Container: yes.
   - Use the shell-command approval per checkout and component, rememberable
     per Project from a local window only. Plan refuses. The class can write to
     the checkout after approval and reaches the network through `proxied`
     under D6.
   - _Accepts when:_ no launch happens without approval, a remote device cannot
     start one, and egress outside the rules is refused and journaled the way
     `proxied` journals.
   - _Verify:_ approval, permission-negative, and egress tests.
7. **Agent read tools** (D5; after the editor slices ship). Container: yes.
   - Add read-only `code-diagnostics` and `code-definition` app-managed tools
     to the closed catalog, through the provider SDK's tool transport, for
     every provider that supports app-managed tools. Providers without that
     support report it unsupported.
   - _Accepts when:_ the conformance harness passes and Plan threads can use
     the tools.
   - _Verify:_ provider-sdk conformance. A real-provider smoke needs the
     maintainer's provider sign-in.
8. **Debugger.** Container: design yes, implementation yes for Linux.
   - First a design addendum in this spec, approved before any code.
   - The addendum covers a `debug-adapter` component kind using the Debug
     Adapter Protocol. Starting a session is local-host only and needs the
     shell-command approval. The debuggee is confined by the thread's posture,
     as a terminal is. Plan refuses. Launch configurations found in the
     repository are proposals the person confirms, never run on their own.
   - _Verify:_ set by the addendum, including a macOS confined-debuggee smoke
     on a Mac.

The extension host is not planned (D7). Each slice is reviewable and leaves
the editor working when the companion is off or refused.

## Verification for this document

Documentation only: formatter, path and decision checks, and `git diff
--check`. The 2026-10-26 binary smoke above is design evidence, not
implementation evidence. Slice 2 repeats it as a test.
