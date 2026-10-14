# Terminal Browser grant

This topic specification owns how a provider CLI that a person types into a Code
thread's terminal can drive that thread's Browser. Architecture owns the
boundary: the grant is one more transport for the Browser family, with no new
authority ([Architecture: app-managed tool transport](../architecture.md#providers)
and [Architecture: security and authority](../architecture.md#security-and-authority)).

**Delivery state.** Built: the grant, its loopback endpoint, its lifecycle, and
its refusals; the `octant mcp` command that a CLI is pointed at; the switch in a
local window, the approval card that names the terminal, and the user guide
(`apps/docs/advanced/terminal-browser.md`).
Not built: desktop packaging of the command. Until it lands the desktop app puts
no `octant` on a terminal's `PATH`, so the feature works there only with a
headless install's command, and the window says so before it restarts a
terminal.

## The problem

A CLI the person starts by hand in a thread terminal is not started by Octant, so
it receives none of Octant's tools, the thread's Browser included. The grant lends
it exactly that one tool family, as that thread, and nothing wider.

## Current behavior

- **Off by default, switched on per terminal.** A thread terminal starts with a
  grant only when the start command says `browserGrant: "on"`. Only the person at
  a local window can ask: any other caller (a paired device, a routine, an agent)
  is refused `not-local-window` and **no terminal is started**, so a shell never
  looks as if it has what it lacks. A running shell cannot be given the variables,
  so the grant applies to a terminal session started with it on.
- **Code threads only.** The thread must be an active Code thread this window can
  open under the rule Code already uses (`not-a-code-thread` covers an unknown id
  and a Work or Chat thread alike; `thread-not-active` an archived or completed
  one; `window-cannot-open-thread` a window that does not hold the Project). Work
  has no shell. The thread-less Project terminal has no way to ask: its command
  schema refuses the field and its launch carries no credentials.
- **Browser only.** The endpoint serves the Browser tool and its `help` operation,
  built by the same factory a managed turn uses, for this thread. It offers no
  Computer, terminal, Apple, Android, planner, or any other family. A host that
  lends no Browser, or a thread whose tool constraints exclude it, is refused
  `browser-unavailable` when the grant is asked for; a constraint that changes
  later makes each call answer `tool-unavailable`.
- **Two variables, nothing else.** The terminal starts with
  `OCTANT_BROWSER_MCP_URL` (the loopback address of this terminal's own
  endpoint, whose path is unguessable) and `OCTANT_BROWSER_MCP_TOKEN` (the
  matching bearer token). They enter through the terminal's existing brokered
  credential path, one named variable each, so the inherited-environment
  allowlist is unchanged for every other terminal and the terminal's transcript
  redacts both values if the shell prints them. Octant never writes a provider's
  MCP or hook configuration, and the CLI never receives the desktop bridge secret,
  which is owner authority.
- **The endpoint** is the session-scoped, loopback-only HTTP MCP endpoint ACP
  runtimes already use (`127.0.0.1` only, a random path, a matching bearer token,
  a `Host` check, no browser `Origin`), one per grant. It is reused rather than
  copied, because it serves a second caller without any change to a published
  seam. Its ACP-specific attestation promise is unused here.
- **Calls run as the thread.** Each call re-reads the thread, then builds the
  Browser tool set for that thread and the window that switched the grant on. So
  the per-action Browser policy, the origin allowlist, the credential-field
  protection, authority staleness, and Plan refusal are the existing code paths,
  not copies. The first effect on an origin asks the person through the host's
  Browser approval service, bound to that window and thread; an origin the person
  chose to always allow is not asked again. A context a managed turn approved is
  asked about again, because the grant keeps its own approval bindings. A page
  read marks the thread `thread.external-content-ingested@1`, because the Browser
  service records that on every observation whoever asked. An approval answered
  after the thread moved into Plan is treated as cancelled.
- **No captures.** A screenshot through the endpoint is not kept as a thread
  Browser capture: no journal actor describes a hand-typed CLI, so `capturedBy`
  is never named and the service keeps nothing ([Browser captures](browser-captures.md)).
- **Fail closed.** A revoked, ended, or unknown grant answers every call
  `unauthorized`, and the endpoint stops listening. A call that finds the grant
  over (a lifecycle notice was missed) is answered `unauthorized` first, then the
  listener closes after a short grace so the answer is delivered. No call throws
  into its caller; an unexpected failure is `tool-unavailable`.

## The `octant mcp` command

`octant mcp` is a stdio MCP server inside the existing `octant` command, and
nothing more than a pipe to the grant's endpoint. A provider CLI that the person
typed into the terminal is pointed at it (`octant mcp` as the CLI's stdio MCP
server) and so reaches the thread's Browser tool. The command holds no policy:
which tools exist, approvals, Plan, and revocation are the host's, and the
command never reads, remembers, or filters a tool result except to notice that
the grant is over.

- **Inputs.** Only `OCTANT_BROWSER_MCP_URL` and `OCTANT_BROWSER_MCP_TOKEN` from
  its own environment. It never opens a data directory, reads the desktop bridge
  secret, looks for a host, or reads or writes a provider's configuration. It
  writes nothing to disk. It takes no arguments beyond `--help`.
- **Framing.** The calling CLI speaks one JSON-RPC message per line on stdin and
  stdout. Each message is sent to the endpoint as one HTTP POST carrying the
  bearer token, the session id and protocol version the endpoint chose in its
  `initialize` answer, and no `Origin`; the `Host` header is the loopback address
  and port. The endpoint's answer, a JSON body or a stream of events, is written
  back one message per line as it arrives, so progress notices pass through.
  Calls run side by side, so a cancellation can overtake a call that is waiting
  on a person's approval; only `initialize` holds later messages until it is
  answered. When the caller closes its input the command lets the calls it made
  finish, releases the endpoint's session (the endpoint serves a few sessions at
  once), and exits `0`. It opens no stream for notices the host starts, because
  the Browser endpoint sends none.
- **Loopback only.** The address must be `http://127.0.0.1:<port>/<path>`: no
  other host (a name that resolves to loopback included), scheme, credential,
  missing port, or bare `/`. The variables are settable by anything in a shell,
  so anything else is treated as having no grant, and the token is never sent. The
  command connects with Node's HTTP client directly: no proxy, no redirect
  following.
- **Fail closed without a grant.** With either variable missing or empty, or an
  address that is refused above, the command makes no host call at all. It still
  answers the handshake so the calling CLI neither hangs nor crashes, lists no
  tools, answers a tool call as an error, and says why in the place MCP gives for
  it (the `instructions` of the `initialize` answer) and once on stderr: this
  terminal has no Browser grant; it is switched on for one thread terminal at a
  time from the Octant window. It exits `1` when the caller closes its input.
- **The grant ends.** When the host answers a call `unauthorized` (the endpoint
  does so for a revoked or unknown grant, an ended terminal, an archived or
  completed thread, and a window that lost the Project), the answer reaches the
  calling CLI unchanged, any other call it was still waiting on is answered the
  same way, one line goes to stderr, and the command exits `1` without retrying.
  The calling CLI therefore sees a refused `unauthorized` and a server that has
  gone, not a hang. Every `unauthorized` ends the command, including the one a
  window that lost its Project gets while the grant itself is still alive: the
  command cannot tell the two apart and does not guess, so that case also needs
  the CLI started again.
- **A host that does not answer is the same.** The grant lives only in host
  memory, and the endpoint stops listening the moment it ends, so a refused
  connection, a connection cut mid-call, or an HTTP 401, 403, or 404 means the
  grant is over. The pending call is answered refused `unauthorized` (a JSON-RPC
  error with that text for anything but a tool call), one line goes to stderr
  that names neither the address nor the cause, and the command exits `1`. Waiting
  for a host that may come back would only keep a CLI believing it still has a
  Browser. Any other failure of one request (a malformed reply, a 5xx, a full
  session table) answers that request alone with a JSON-RPC internal error and
  the session continues.
- **Nothing secret is printed.** No message, error, or help text names the token,
  the address, or its path. A line on stdin that is not a message is answered
  with a JSON-RPC parse error and does not reach the host. stdout carries
  protocol frames only; everything a person should read goes to stderr.

## The window

- **The switch.** A Code thread terminal's actions menu (the floating button
  and the right-click menu) offers **Let this terminal use the Browser…** when
  the terminal belongs to a Code thread this window can restart and the thread
  is not in Plan. A running shell cannot be given the variables, so a confirmation
  says first that the terminal restarts and anything running in it stops, and
  that the `octant` command must be on the terminal's `PATH` (a headless install
  has it; the desktop app does not yet). Confirming stops the shell and starts
  the same terminal with `browserGrant: "on"`. A refusal shows the host's reason
  and the terminal stays stopped, so a shell never looks as if it has what it
  lacks; the menu's **Restart terminal** goes on without it. The Zen terminal
  card, which cannot restart its shell, shows the state and **Switch off** but
  offers no switch-on.
- **State comes from the host.** The window shows **Browser on** only when the
  host's latest answer about that running shell carries a live grant: the start
  that minted it, or an attach. An attach to a running terminal reports the
  terminal's live grant for that thread, so a reload, a second window, or a
  return from another thread reads the grant as it is; a shell that stopped took
  its grant with it. The on notice carries **Switch off** and says that a
  Project change in this window means starting the CLI again.
- **Switch off** sends `revoke-terminal-browser-grant` and leaves the shell
  running. The notice that follows says a CLI that used the Browser stops at its
  next call and has to be started again after the Browser is switched back on.
- **A paired device has no switch.** The paired-device client renders no thread
  terminal, and the host refuses its start with a grant (`not-local-window`)
  before any terminal starts.
- **The approval card.** The Code thread column lists the host's Browser
  approvals for that thread (mode `code`) and shows the first as an approval
  card labelled **Browser request from a terminal**: it names the origin and the
  thread and says a program in the thread's terminal asked, not the thread's
  agent. In Code only a terminal grant asks through the host's Browser approval
  service, because a managed Code turn asks through its own operation approval,
  so every Code entry there came from a terminal. If that ever changes, the
  approval view must carry who asked before this card may keep its wording. The
  card offers **Approve once**, **Always allow** (the host's remembered origin,
  the same one Work offers), and **Deny**; an answer the host no longer accepts
  is reported as an ended request, never as a silent no-op.

## Lifecycle

A grant is bound to one host run, one thread, one terminal session, and one
window. It lives only in host memory; a restarted host mints nothing by itself.
It ends when:

| Reason                 | Cause                                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `switched-off`         | The person switches it off (`revoke-terminal-browser-grant`), any window that can open the thread, in any posture and whether or not the thread's checkout is still available, since it only narrows authority |
| `terminal-closed`      | The terminal stops, exits, or is replaced; also found by any call that sees the shell not running                                                                                                              |
| `terminal-not-started` | The terminal's launch failed, or returned a shell that had already exited, after the grant was minted; the start result reports the grant revoked, never granted                                               |
| `thread-completed`     | The thread is completed                                                                                                                                                                                        |
| `thread-archived`      | The thread is archived                                                                                                                                                                                         |
| `thread-deleted`       | The thread is purged                                                                                                                                                                                           |
| `window-revoked`       | The window that switched it on loses host authority                                                                                                                                                            |
| `host-stopped`         | The host shuts down cleanly                                                                                                                                                                                    |

## Persistence

Issue and end are journaled on a `terminal-browser-grant` aggregate
(`code.terminal-browser-grant-issued@1`, `code.terminal-browser-grant-revoked@1`):
ids, thread, terminal, window, time, and reason. Issue and a person's switch-off
are the `local-user` actor; every other end is the host's `system` actor. The
token and the endpoint address are never journaled, logged, or returned in a
response; the only copy leaves the host in the terminal's environment. Every
payload names `threadId`, so a thread purge erases a grant's records with the
rest of the thread.

## Constraints and known gaps

- The confined terminal must be able to reach `127.0.0.1` for a CLI to use the
  endpoint. On macOS the thread terminal's Seatbelt profile allows network
  (`networkEgress` is `allow` for every terminal launch), and a shell started
  under it reached a loopback listener and the pipe completed an `initialize`
  through it (checked on macOS 27 with the real terminal port, 2026-10-13). On
  Linux, read but not run: the same launch passes `--unshare-all --share-net` to
  `bwrap`, so the terminal shares the host's network namespace and `127.0.0.1` is
  the host's loopback, which the endpoint listens on. A launch with
  `networkEgress` `none` would unshare the network and could not reach the
  endpoint; the terminal never uses it. Confinement is unchanged here.
- The packaged form of the command is not decided. Run from a source checkout
  with Bun inside the confined macOS terminal, the runtime fails to read the
  person's home directory (`EPERM` listing it) before it loads anything; the
  same pipe bundled into one file and run with Node worked there. The desktop
  packaging slice must pick a runtime that starts inside the terminal's profile.
- A call is bound to the window that switched the grant on. If that window's
  Project changes, calls answer `unauthorized` until it returns.

## Verification

`apps/server/src/code/terminalBrowserGrantService.test.ts` covers the grant, the
endpoint, the hostile requests (wrong token, wrong path, foreign `Host`, browser
`Origin`, after switch-off, after the terminal closed, after the thread was
archived or completed, another thread's context, Plan), and that the token and
address stay out of the journal, logs, and responses. Its last suite drives the
real `octant mcp` module against a real grant: handshake, the Browser tool
listed, an approved call, and a call refused `unauthorized` after switch-off and
after the thread was archived.
`packages/cli/src/mcpCommand.test.ts` covers the command against a stand-in
loopback endpoint: no grant (missing, empty, and every refused address, with no
host call), relaying with the bearer token and session, the `unauthorized`,
unreachable, and unexpected-failure endings, and that neither the token nor the
address reaches stdout or stderr.
`apps/server/src/code/codeOperationService.test.ts` covers the start and switch-off
commands and the live grant an attach reports, `apps/server/src/codeRoutes.test.ts`
that a paired device's start with a grant reaches the host as an agent (which the
host refuses), and `apps/server/src/persistence/threadPurge.test.ts` the purge.
`apps/web/src/code/CodeTerminalPane.test.tsx` covers the switch (confirmation,
restart with the grant, the on state from the host's answer, switch-off without a
restart, a refusal, and no switch in Plan or on a terminal the window cannot
restart), and `apps/web/src/code/TerminalBrowserApprovalPrompt.test.tsx` the
approval card's wording and scope.
