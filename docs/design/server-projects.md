# Server Projects

This topic specification owns Code Projects bound to a folder on one of the
person's registered servers, reached over SSH. Architecture owns the boundary
([Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code),
[Octant Shield: servers over SSH](../architecture.md#octant-shield), and the
[Current Release Boundary](../architecture.md#current-release-boundary)).

**Delivery state.** Built: the server Project catalog, its journal and replay,
the SSH connection, and the folder check at binding (`/api/server-projects`).
Not built yet: Code threads that run there, terminals there, and the windows
that bind and open one. Each later slice moves its part to built here.

## Outcome

A person who keeps code on their own server binds a Code Project to a folder
there. A Code thread in that Project reads and edits files, runs commands, uses
Git, and opens terminals on the server, under the same guardrail levels,
approvals, and journal as a Project on this computer. Inference, approvals,
every authority check, and the journal stay on this host; only the thread's
hands are on the server.

## Terms

- **Registered server.** A server in the person's Octant Shield registry
  (Settings › Access › Servers): a host alias from their SSH config and a user
  ([Octant Shield](../architecture.md#octant-shield)).
- **Server Project.** A Code Project whose folder is an absolute path on one
  registered server. It has no folder on this host.
- **Hands.** The file tools, shell, and terminals a thread acts through.

## Rules

### Binding

- Only a person at a local window binds, renames, or removes a server Project.
  A paired device, a routine, and an agent are refused `needs-local-window`.
- A binding names a registered server and an absolute folder path. Before it
  is journaled, the host connects and resolves the folder on the server to its
  real path (`cd` then `pwd -P`); a folder that does not exist, is not a
  folder, or cannot be reached is refused, and nothing is journaled. The
  resolved path is the one stored.
- Server Projects live in their own catalog: the `server-projects` aggregate,
  with `server-projects.bound@1`, `server-projects.renamed@1`, and
  `server-projects.removed@1`, each journaled whole and journal first, and
  rebuilt at startup. They are never in the local Project catalog, so no
  service that reads a local Project's folder can be handed a server path.
  _Rationale:_ a Project binding's folder is read as a path on this host in
  well over a hundred places; a separate catalog keeps every one of them
  unable to reach a server Project, instead of auditing each for a path that
  is not local.
- A server Project whose server was removed from the registry stays in the
  catalog and refuses every connection (`server-not-registered`) until the
  person removes the Project or registers the server again.
- These event names are new. The retired names of the earlier SSH target
  build (`ssh-target.*`, `ssh-remote-*`, `provider-runtime-egress.*`) stay
  retired, and a thread left on a retired `remote-root` checkout still refuses
  every operation, because its Project is in neither catalog.

### Connection

- Octant connects with this host's own `ssh`, as the registered user, to the
  registered alias, so the person's SSH config, known hosts, and SSH agent
  decide how the server is reached and how the login is signed.
- **Keys stay with the host.** Octant names no key file, reads no key, writes
  no SSH config, and forwards no agent to the server. Each connection runs
  with `BatchMode=yes` (no password or passphrase prompt),
  `StrictHostKeyChecking=yes` (an unknown or changed host key refuses; the
  person accepts a new server's key by running `ssh` to it once themselves),
  `ForwardAgent=no`, `ForwardX11=no`, `ClearAllForwardings=yes`,
  `PermitLocalCommand=no`, `ControlMaster=no`, a ten-second connect timeout,
  and keepalives that end a silent connection after about thirty seconds.
  _Rationale:_ a shared control socket would be one more place a session
  could be borrowed from; one connection per call costs a login each time and
  keeps nothing open between calls.
- **Fail closed.** When a call cannot reach the server (the connection drops,
  times out, is refused, or the host key does not match), that call is refused
  with `server-unreachable` and nothing runs anywhere else. There is no local
  fallback: a server Project has no folder on this host, and no code path
  resolves one for it.

### Threads

- A server Project's thread is an ordinary Code thread on this host's journal.
  Its checkout is a `remote-root` checkout whose ids are digests of the
  Project, server, and folder under labels of their own, so it can never name a
  retired checkout, and every host-side Git, file, test, checkpoint, and
  worktree path keeps refusing it as it refuses every `remote-root` checkout.
- **Octant Harness only.** A thread there runs on the Octant Harness, whose
  inference stays on this host and whose hands are on the server. Every other
  runtime is refused before it launches, naming why: its own tools act on this
  host's files. Delegation, Browser, Computer, connectors, and forks are not
  offered there, since each acts on this host.
- **The same levels.** The thread's guardrail level is resolved as it is for
  any Code thread (thread, then the account default), and decides each call as
  it does locally: Plan is read-only, Guarded asks for every command and edit,
  Accept edits waives edits inside the folder, Reviewed hands each request to
  the chosen reviewer, and Full access asks nobody.
- **No sandbox on the server.** Octant has no OS confinement and no egress
  rules on the server at any level, so below Full access the approval is the
  only guard on a command there. A remembered approval therefore does not
  cover a command on a server; each one asks the level's approver again.
  _Rationale:_ a remembered approval was given for commands that run inside
  this host's sandbox, and carrying it to a server with none would widen what
  the person agreed to. Full access is no sandbox and no prompts, as locally.
- **Files.** The file tools resolve every path on the server to its real path
  and refuse one outside the folder, judged on this host. A path in a key or
  credential folder (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`,
  `.config/gh`) or a credential file (`.netrc`, `.git-credentials`, `.npmrc`,
  `.pypirc`, `*.pem`, `*.key`) is refused at every level, as the secret
  guard's tools refuse one locally. A search uses the server's `find` and
  `grep -E`, so its pattern is a POSIX extended expression there.
- **Commands and Git.** A command runs with `sh -c` in the folder on the
  server, with the thread's timeout and output bound. Git runs there as a
  command. Every command is journaled on the thread as
  `shield-remote-commands.ran@1` with the server, the redacted command, and
  how it ended, at every level.
- **Terminals.** A terminal in a server Project is an SSH login shell in the
  folder, through the same connection rules. When the connection drops the
  terminal ends and says so; it is never restarted on this host.
- **Checkpoints.** A turn on a server takes no checkpoint, so rewind and
  restore are not offered there; Git on the server is the way back.

## Not built yet

- Work Projects on a server, and extra folders in a server Project.
- Host-side Git panels, the file browser, tests, managed worktrees, and pull
  request delivery for a server Project.
- A Project-level guardrail level or reviewer for a server Project; the
  thread and account levels apply.
- Linux hosts are untested; the connection uses only `ssh` options both
  platforms share.
