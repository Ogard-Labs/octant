# Server Projects

This topic specification owns Code Projects bound to a folder on one of the
person's registered servers, reached over SSH. Architecture owns the boundary
([Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code),
[Octant Shield: servers over SSH](../architecture.md#octant-shield), and the
[Current Release Boundary](../architecture.md#current-release-boundary)).

**Delivery state.** Built: the server Project catalog, its journal and replay,
the SSH connection, and the folder check at binding (`/api/server-projects`);
Code threads there on the Octant Harness, with file tools, commands, and Git
on the server at every level; thread terminals there; the Git tab, whose Git
runs on the server; and the Code sidebar, composer, and thread view that open
them. Not built yet: the items under [Not built yet](#not-built-yet).

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
- Each call runs a short `sh` script through the login shell, its arguments
  single-quoted, so the login shell must read POSIX single quotes (`sh`,
  `bash`, `zsh`, `dash`, and `fish` do; `csh` and `tcsh` are not supported).
  The script's own exit status 255 is reported as 254, so 255 always means
  ssh itself failed.
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
  The Git tab reaches it only through Git on the server ([Panels](#panels)).
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
- **Terminals.** A thread terminal in a server Project is an SSH login shell
  in the folder, through the same connection rules, started on a
  pseudo-terminal here that runs only `ssh`. It carries no credential, Browser
  grant, or other folder from this host, and Plan starts none. When the
  connection drops the terminal ends; it is never restarted on this host.
- **Fail closed in a turn.** A file call that cannot reach the server is
  refused `target-unavailable` and a command reports the shell unavailable;
  the next call tries the server again. Nothing a server thread asks for runs
  on this host.
- **Windows.** A window binds a server Project with no folder of this host
  (`boundRoot: null`), so Files, Browser, and every root-backed surface fail
  closed, and a server thread opens only its own view.
- **Checkpoints.** A turn on a server takes no checkpoint, so rewind and
  restore are not offered there; Git on the server is the way back.

### Panels

- **Git tab.** A server thread's Git tab is the Git tab of any Code thread:
  status, diff, stage, unstage, discard, commit, and push. This host's own Git service runs it, and every command that
  service runs goes to the server as `git` in the folder, through the same
  connection rules; nothing is read from or written to this host's disk. The
  thread's checkout bar opens it with **Git**. The approvals, refusals, and
  push rules are the ones a local Git tab has.
- **Git's setup on the server is the server's.** Git there reads the server's
  own system and global config, so the person's identity, signing, and
  credential helper on the server apply; only this host's switches that stop
  prompts and lock contention are passed. When the server has no identity,
  the commit falls back to the person's profile here, as a local commit does.
  _Rationale:_ locally the global config is hidden because the sandbox hides
  it; the server has no sandbox, and the person's own `git` there would read
  it, so hiding it would be stricter than the server itself.
- **Plan changes nothing.** At Plan every Git change from the tab is refused
  on a server. _Rationale:_ locally Plan's read-only rule is a confinement
  around Git; Octant has none on the server, so refusing is the only way to
  keep Plan read-only there.
- **Fail closed.** A Git command that cannot reach the server runs nothing and
  the tab says Git is unavailable; a server removed from the registry refuses
  the next command. One login per command makes the tab slower than a local
  one; that is the connection rule's known cost.
- **One queue per Project.** Git changes on one server Project run one after
  another, as they do on one local checkout. A change the tab stops waiting
  for may still finish on the server; the next look at the tab shows it.
- Run review and merge (mergeability needs a scratch object store on this
  host), checkpoints, and a drafted commit message stay refused for a server
  thread. _Rationale:_ the draft's model session is opened with the checkout
  as its folder, which would name a server path as a folder of this host.

## Not built yet

- Work Projects on a server, and extra folders in a server Project.
- The file browser, tests, managed worktrees, and pull request delivery for a
  server Project, and the dock's Review tool there; the Git tab is built.
- The Project terminal (the thread-less one) for a server Project; thread
  terminals are built.
- A Project-level guardrail level or reviewer for a server Project; the
  thread and account levels apply.
- Real servers are untested: the connection, folder check, file tools,
  commands, terminals and the Git tab were exercised against a throwaway local `sshd` only. Linux
  hosts are likewise untested; the connection uses only `ssh` options both
  platforms share.
