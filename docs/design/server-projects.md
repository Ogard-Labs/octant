# Server Projects

This topic specification owns Code and Work Projects bound to a folder on one
of the person's registered servers, reached over SSH. Architecture owns the boundary
([Modes: Chat, Work, and Code](../architecture.md#modes-chat-work-and-code),
[Octant Shield: servers over SSH](../architecture.md#octant-shield), and the
[Current Release Boundary](../architecture.md#current-release-boundary)).

**Delivery state.** Built: the server Project catalog, its journal and replay,
the SSH connection, and the folder check at binding (`/api/server-projects`);
Code threads there on the Octant Harness, with file tools, commands, and Git
on the server at every level; thread terminals there; the Project terminal;
the Git tab and the dock's Review tool, whose Git runs on the server; the
Files panel and file editor, and the Tests panel, which read, write and run
on the server; a thread's own worktree on the server and its pull request
([Worktrees and pull requests](#worktrees-and-pull-requests)); and the Code
sidebar, composer, and thread view that open them; and Work Projects there,
whose Work threads run on the Octant Harness with file tools and commands on
the server, with the Work sidebar, composer, and thread view that open them
([Work Projects](#work-projects)). Not built yet: the
items under [Not built yet](#not-built-yet).

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
- A binding names its mode: Code (the default, and the only mode a binding
  journaled before Work Projects names) or Work (`mode: "work"` on the bound
  Project). A Code Project's record carries no mode at all, so it is exactly
  what an older build journaled and reads. A Work Project's record names its
  mode, so an older build cannot decode it and binds nothing for it rather
  than reading it as a Code Project. A Project's mode never changes.
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
  `PermitLocalCommand=no`, a ten-second connect timeout, and keepalives that
  end a silent connection after about thirty seconds.
- **One shared connection per server.** Calls to one server and user (file
  tools, commands, folder checks, and Git) share one connection through an
  OpenSSH control socket, which stays open for sixty seconds after its last
  call. The socket lives in a folder under `/tmp` that only this host's user
  can open (`0700`), named by a digest of the server and user. Every Seatbelt
  profile Octant builds ends by denying a socket there and the folder's files,
  so a confined launch can neither open the socket nor move or link it out,
  network or not, and a
  Linux capsule has a `/tmp` of its own; a confined command's SSH config keeps
  `ControlMaster no`. A dropped shared connection fails the calls on it, and
  the next call logs in again. An interactive terminal keeps a connection of
  its own (`ControlMaster=no`). _Rationale:_ one login per call made every Git
  command a fresh login. The socket runs commands with no Shield decision, so
  a confined launch must not reach it; denying the folder's reads is not
  enough (measured on macOS 27, a launch with network reached a socket in a
  read-denied folder, and one that could write `/tmp` renamed the socket out
  and connected), so the profiles deny the socket and its folder. An unconfined
  process already runs as the person and can reach their SSH agent, so the
  socket gives it nothing new.
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
  The Git, Files, and Tests panels reach it only through the server
  ([Panels](#panels)), and a thread's own worktree is made there
  ([Worktrees and pull requests](#worktrees-and-pull-requests)).
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
- **Project terminal.** A Code server Project's own terminal (the one with
  no thread, opened from the dock's quick tools of a new task) is the same SSH
  login shell in the folder, owned by the local window that opened it and
  journaled as a local Project terminal is. It has no other folder, no saved
  actions or suggestions (those read a Project's files on this host), and no
  browser beside it. A server removed from the registry refuses the next
  start; removing the Project ends its shells. Its posture is recorded as
  Full access. _Rationale:_ the posture says what holds the shell, and on a
  server nothing does: Octant has no sandbox there, and the person opening
  their own shell is the approval, as it is for a local Project terminal.
- **Fail closed in a turn.** A file call that cannot reach the server is
  refused `target-unavailable` and a command reports the shell unavailable;
  the next call tries the server again. Nothing a server thread asks for runs
  on this host.
- **Windows.** A window binds a server Project with no folder of this host
  (`boundRoot: null`), so Files, Browser, and every root-backed surface fail
  closed, and a server thread opens only its own view.
- **Checkpoints.** A turn on a server takes no checkpoint, so restoring
  files is not offered there and Rewind to here rewinds the conversation
  only, saying why; Git on the server is the way back for files.

### Work Projects

- **A Work Project on a server** is bound as a Code one is (same command,
  same folder check, local window only, same catalog) with `mode: "work"`.
  Its threads are Work threads; no Code thread, checkout, Git service, or
  terminal resolves it, and a Code Project there holds no Work thread.
- **Threads.** A Work thread there is an ordinary Work thread on this host's
  journal, created against a binding revision derived from the Project alone
  under a label of its own (`octant.server-work-project-binding.v1`), which
  the catalog shows as the Project's `workBindingRevisionId`. It starts in the
  Project's folder at the account's default Work access (a server Project
  has no access override of its own) and stays there: moving it to another
  Project or folder is refused. It takes no GitHub or Linear issue and no
  terminal session at creation. _Rationale:_ the issue readers and the session
  reader read this host's accounts and folders on the thread's behalf; the
  narrower choice keeps the thread's sources on the server it works on.
- **Turns.** A turn runs on the Octant Harness only, with the same file tools
  and shell on the server as a Code thread there ([Threads](#threads)): the
  same access levels and approvals, every command asking again below Full
  access, every command journaled as `shield-remote-commands.ran@1`, and no
  delegation. No tool of this host is offered: no Browser, Computer, side
  task, routine, Canvas, or extension, and a turn that selects an extension
  is refused. Nothing watches the folder for written files, and the Project's
  status file and extra folders are not read, since each is a folder of this
  host. A turn that cannot bind (a removed server, a runtime other than the
  Octant Harness) is refused before it starts, and a call that cannot reach
  the server runs nothing anywhere.
- **Windows.** A window binds a server Work Project, and its threads, with no
  folder of this host (`boundRoot: null`), so Work Files, Browser, and every
  root-backed Work surface fail closed for it.
- **Views.** Settings › Access › Servers binds one with **Project kind: Work**.
  The Work sidebar lists it under **On your servers** with its threads; the
  Work composer offers it, with only Octant Harness models choosable and no
  extension, issue, or terminal session to start from; and its thread view
  names its server and folder and offers no Browser, extension, image
  generation, or file mention. Its dock keeps only Side chat, Document,
  Canvas, Plan, and Agents, since Work's Files, terminal, and other tools read
  a folder of this host and none has a server form yet.

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
- **Review tool.** The dock's Review tool opens for a server thread. Its
  working tree is the Git tab's diff, and its local commits and history are
  read by Git on the server in the folder, read-only, through the same
  connection rules; nothing is read on this host. A server that cannot be
  reached or left the registry shows them unavailable. Reading is allowed at
  every level, Plan included, as locally.
- **Plan changes nothing.** At Plan every Git change from the tab is refused
  on a server. _Rationale:_ locally Plan's read-only rule is a confinement
  around Git; Octant has none on the server, so refusing is the only way to
  keep Plan read-only there.
- **Fail closed.** A Git command that cannot reach the server runs nothing and
  the tab says Git is unavailable; a server removed from the registry refuses
  the next command. Its commands share the server's one connection, so only
  the first after a quiet minute pays for a login.
- **One queue per Project.** Git changes on one server Project run one after
  another, as they do on one local checkout. A change the tab stops waiting
  for may still finish on the server; the next look at the tab shows it.
- **Files.** A server thread's Files panel, file editor, and `@` path
  mentions list, open, and save the thread's folder on the server: the
  Project's own, or the thread's own worktree. The Tests panel runs there
  too. Each path is
  resolved to its real path on the server and refused there before any byte
  travels when it is outside the folder or in a key or credential location
  (the file tools' rule). A listing names only real folders and files, never
  a link, skips `.git` and `node_modules` as a local listing does, and leaves
  out credential locations; it keeps the local listing's entry and depth
  bounds. A file's identity is its real path on the server, and a save is
  refused as a conflict when the file's content changed since it was opened,
  compared by digest. Saving is the person's own action, so it asks no
  approval below Full access, as a local save does, and Plan refuses it. The
  file references are journaled as a local file's are. _Rationale:_ file
  times and inode numbers mean nothing from one server to the next, so the
  digest is the only change check that holds everywhere; the check and the
  write are two calls, so a change made on the server between them is
  overwritten, and the write replaces the file whole so no reader there sees
  half of it.
- **No live updates.** The folder is not watched: the panel lists it when it
  opens and again on **Refresh**, and a search across the folder is not
  offered there. _Rationale:_ watching would keep a connection and a process
  open on the server for as long as the panel is; a refresh costs one call.
- **Tests.** The Tests panel offers what the folder's `package.json` and
  `.octant/tests.json` define, read on the server through the Files rules.
  A run is the discovered command, run on a terminal on the server in the
  folder, with no environment of this host's; cancelling or timing out hangs
  it up. The levels and approvals are a local run's: Plan refuses, and below
  Full access the level's approver is asked. Each run is journaled as
  `shield-remote-commands.ran@1`. A run needs a Git repository on the server
  (its commit is the run's revision, read there with `git rev-parse`), and a
  server that cannot be reached runs nothing anywhere.
- Run review and merge (mergeability needs a scratch object store on this
  host), checkpoints, and a drafted commit message stay refused for a server
  thread. _Rationale:_ the draft's model session is opened with the checkout
  as its folder, which would name a server path as a folder of this host.

### Worktrees and pull requests

- **A thread's own worktree is on the server.** The composer's **Workspace**
  menu offers **Managed worktree** for a server Project, and its branch list
  is read with Git on the server (`git for-each-ref`). Creating the thread
  runs `git worktree add` on the server, on a new branch (the thread's
  delivery branch) from the chosen source, at
  `<parent of the folder>/.octant-worktrees/<repository id>/<thread id>`: beside
  the folder, where a local managed worktree sits beside its repository, at
  a path derived from the Project and the thread alone. Start from origin
  fetches only that branch there. Nothing is created, read, or fetched on
  this host.
- A worktree is made only when the Project's folder is its repository's top
  folder, only on a branch that does not exist yet, and only where nothing
  exists at its path; otherwise nothing is made. A fork is not offered, since
  its files live in this host's checkpoints. A server that cannot be reached
  makes nothing anywhere.
- **Its identity.** The thread's checkout is a `remote-root` like the
  Project's, with an id that is a digest of the Project and the thread under
  a label of its own, journaled as `code.checkout-observed@1` before the
  thread. The thread's file tools, commands, terminals, and Git act in the
  worktree's folder; the folder is derived again from the Project and thread
  on each use, never read back from a record, and a thread holding another
  thread's worktree checkout is not that thread.
- **Plan makes none.** A Plan thread is not started in a new worktree on a
  server, since the worktree is a Git change there and Octant has no
  confinement on the server to hold Plan read-only. It starts in Current
  checkout instead.
- **Removing it is the person's.** If binding the new thread fails, the
  worktree and branch this creation just made are removed again. Otherwise
  Octant never removes a worktree on a server: a thread purge on this host
  leaves it, and the person removes it there (`git worktree remove`).
  _Rationale:_ a purge runs without a connection to the server and cannot
  confirm what it would delete there, so it deletes nothing.
- **A remembered habit stays local.** A Project's remembered workspace choice
  is this host's; a server thread starts in Current checkout unless the
  person picks a worktree in the composer.
- **Pull requests.** A server thread creates, updates, comments on, observes,
  and merges its pull request as a local thread does, through this host's
  `gh`, by repository and branch name alone: the branch is pushed from the
  server first (**Git** › push), and no server path is handed to a process of
  this host. The check that the checkout has a GitHub remote reads the remote
  with Git on the server. The checkout bar offers **Create pull request**.
  The same approvals, levels, and merge rules as a local thread apply.
- **Its repository.** When the thread's delivery target names the
  composer's `local/…` placeholder (a composer reads no remote of a server),
  the pull request's repository is the GitHub repository of the delivery
  remote on the server, read when the pull request is made. A repository the
  person named stays. A server that cannot be reached leaves the
  placeholder, and no pull request is opened. _Rationale:_ the remote the
  thread pushes to is the repository its branch is on; reading it at that
  moment needs no new record of a server's remotes on this host.

## Not built yet

- Work Files, research sources, the status file and due dates, and the
  Project terminal for a Work Project on a server; its threads are built. A
  local Work Project shows its terminal through its Developer tools switch on
  its overview, and a Work Project on a server has neither yet.
- Extra folders in a server Project.
- Saved Project actions and their suggestions for a server Project; its
  Project terminal is built.
- A Project-level guardrail level or reviewer for a server Project; the
  thread and account levels apply.
- Real servers are untested: the connection, folder check, file tools,
  commands, terminals, the Git tab, the Review tool's history, Files, Tests
  and worktrees were exercised against a throwaway local `sshd` only, and
  pull requests against a stand-in for `gh`, never GitHub. Linux
  hosts are likewise untested; the connection uses only `ssh` options both
  platforms share.
