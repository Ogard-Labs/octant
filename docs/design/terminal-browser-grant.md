# Terminal Browser grant

This topic specification owns how a provider CLI that a person types into a Code
thread's terminal can drive that thread's Browser. Architecture owns the
boundary: the grant is one more transport for the Browser family, with no new
authority ([Architecture: app-managed tool transport](../architecture.md#providers)
and [Architecture: security and authority](../architecture.md#security-and-authority)).

**Delivery state.** The host side is built: the grant, its loopback endpoint, its
lifecycle, and its refusals. Not built: the `octant mcp` command that a CLI is
pointed at, the switch in the local window and the approval wording that names
the terminal, the user guide, and desktop packaging of the command. Until those
land nothing in the product starts a terminal with a grant on, so the feature is
inert for a person.

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

## Lifecycle

A grant is bound to one host run, one thread, one terminal session, and one
window. It lives only in host memory; a restarted host mints nothing by itself.
It ends when:

| Reason                 | Cause                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `switched-off`         | The person switches it off (`revoke-terminal-browser-grant`), any window that can open the thread, in any posture, since it only narrows authority |
| `terminal-closed`      | The terminal stops, exits, or is replaced; also found by any call that sees the shell not running                                                  |
| `terminal-not-started` | The terminal's launch failed after the grant was minted                                                                                            |
| `thread-completed`     | The thread is completed                                                                                                                            |
| `thread-archived`      | The thread is archived                                                                                                                             |
| `thread-deleted`       | The thread is purged                                                                                                                               |
| `window-revoked`       | The window that switched it on loses host authority                                                                                                |
| `host-stopped`         | The host shuts down cleanly                                                                                                                        |

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

- The Code workspace does not yet show a Browser approval raised through the
  host's Browser approval service (Chat and Work do). Until the window switch
  lands, an effect that needs an approval waits and expires as a denial rather
  than running.
- The confined terminal must be able to reach `127.0.0.1` for a CLI to use the
  endpoint; that is checked with the `octant mcp` command, not here.
- A call is bound to the window that switched the grant on. If that window's
  Project changes, calls answer `unauthorized` until it returns.

## Verification

`apps/server/src/code/terminalBrowserGrantService.test.ts` covers the grant, the
endpoint, the hostile requests (wrong token, wrong path, foreign `Host`, browser
`Origin`, after switch-off, after the terminal closed, after the thread was
archived or completed, another thread's context, Plan), and that the token and
address stay out of the journal, logs, and responses.
`apps/server/src/code/codeOperationService.test.ts` covers the start and switch-off
commands, and `apps/server/src/persistence/threadPurge.test.ts` the purge.
