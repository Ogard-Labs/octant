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
([Work Projects](#work-projects)); routines that target a server Project,
chosen in Automation Center's editor or confirmed from a thread there and
run by this host's scheduler ([Routines](#routines)); person-operated
loopback dev-server previews ([Previews](#person-operated-dev-server-previews));
and the seam, host lifecycle, host-key pinning, suspended refusal and
Settings screen for machines in the person's own cloud account, with no
target plugin yet
([Machines in the person's cloud account](#machines-in-the-persons-cloud-account)).
Remaining items are under [Not built yet](#not-built-yet).

## Outcome

A person who keeps code on their own server binds a Code Project to a folder
there. A Code thread in that Project reads and edits files, runs commands, uses
Git, and opens terminals on the server, under the same guardrail levels,
approvals, and journal as a Project on this computer. Inference, approvals,
every authority check, and the journal stay on this host; only the thread's
hands are on the server.

## Setup entry

Settings › Remote access begins with three explicit journeys: control an Octant
host, run a command on a registered server, or work in a server folder. Selecting
one shows execution/data locations, prerequisites and a read-only first task;
Continue opens the existing pairing, server registry or server-Project binding
controls. Continuing to local listener setup focuses its real form. A client
without local administration instead directs the person to Settings on the
Octant host; it offers no inert pairing continuation. Selection starts no
connection, command, key creation or listener.
Registration alone proves no connectivity. The folder journey uses the existing
SSH folder check and focuses its binding form; missing folders, SSH keys and
unverified host identities require correction through their existing owners.
The entry explains unsupported server-Project capabilities and uncertain-result
recovery without implying parity or retrying a command.

**Private network guides.** Below the journeys, searchable guides explain
Tailscale and Cloudflare private routing, each with a button that opens the
provider's own page in the person's browser. Sign-in and network enrollment
happen with the network provider, never in Octant. A guide only explains: it
grants no device or server access, starts no connection, and changes no
listener. A client without local administration names Settings on the host
for the listener step.

**Read-only checks.** Each server journey can check a registered alias and user
without binding a Project or starting a task. Only an authenticated local window
may call `/api/remote-setup-check`; paired clients, agents and routines cannot
borrow that authority. Strict input names only a registered server, an optional
absolute folder and the runtime choice. No script, credential or SSH setting is
accepted. At most four checks run concurrently, each with a twelve-second SSH
deadline, 2 KiB response bound and owned-process cleanup. Stop cancels the check;
changing the journey or inputs discards its result. Recheck is explicit and runs
only this fixed read-only probe, never an earlier uncertain command.

The probe requires the host's SSH agent and uses the existing connection encoder
with `ControlMaster=no`, `ControlPath=none` and `ControlPersist=no`, so a cached
login cannot stand in for fresh identity/authentication. Strict host checking,
BatchMode and forwarding refusals remain in force. A fixed POSIX `sh` probe reads
`pwd -P`, optionally after `cd` to the folder argument. It writes nothing. A
changed registration invalidates even a successful response. Success proves this
connection and directory at check time, not future connectivity or task authority.

Unknown and changed/revoked identity, unavailable host, authentication refusal,
missing agent, unavailable directory, unsupported runtime and incomplete probe
have separate remedies. Bounded OpenSSH error text selects advisory copy only;
it is never returned, journaled, accepted as trust or used to edit known hosts.
The person verifies an unknown fingerprint through their own SSH connection;
changed identity requires independent administrator verification. A check never
creates a key: the kept-key workflow is explicitly unavailable to this
agent-backed probe and points to the existing key controls. Server-Project
runtime checks report Octant Harness support versus the native-provider refusal;
they do not claim a provider binary is installed or run a provider request.

Host control can reread the existing private-listener status without enabling or
restarting it. This reports only host readiness; pairing and a request from the
other device still establish actual device reachability. A missing host bridge,
older client/host or failed host request shows unavailable with the appropriate
host-window/network/awake-state remedy. Pending, reconnecting, connected for the
check, disconnected and stopped states remain distinct. Results are transient;
checks never change registry/configuration or journal state.

## Terms

- **Registered server.** A server in the person's Octant Shield registry
  (Settings › Permissions › Servers): a host alias from their SSH config and a user
  ([Octant Shield](../architecture.md#octant-shield)).
- **Server Project.** A Code Project whose folder is an absolute path on one
  registered server. It has no folder on this host.
- **Hands.** The file tools, shell, and terminals a thread acts through.

## Rules

### Binding

- Only a person, at a local window or a paired device, binds, renames, or
  removes a server Project; a routine and an agent are refused (maintainer decision, 2026-11-12).
  Not built yet: today a paired device is refused
  `needs-local-window` too.
- A binding names a registered server and an absolute folder path. Before it
  is journaled, the host connects and resolves the folder on the server to its
  real path (`cd` then `pwd -P`); a folder that does not exist, is not a
  folder, or cannot be reached is refused, and nothing is journaled. The
  resolved path is the one stored.
- Server Projects live in their own catalog: the `server-projects` aggregate,
  with `server-projects.bound@1`, `server-projects.renamed@1`,
  `server-projects.actions-replaced@1`, and `server-projects.removed@1`, each
  journaled whole and journal first, and
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
- **A bound server stays that host.** While a Project is bound to a server, the
  server's alias and user cannot change: the edit is refused with a message
  naming the Projects. Its profile and deploy commands stay editable, since they
  describe the same host. A bind whose server is pointed elsewhere during the
  folder check binds nothing. _Rationale:_ a Project's folder was checked on the
  host the alias named, so renaming it would send the next turn, Git command, or
  terminal to another host at the same path, with the folder unchecked there.
  Refusing is the narrower fix: a fresh check before every use would add a state
  every surface must honor, and removing the Project or registering a new server
  already says what the person means.
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
  person accepts a new server's key by running `ssh` to it once themselves,
  except for a cloud machine whose provider-reported key the host pinned:
  [Machines in the person's cloud account](#machines-in-the-persons-cloud-account)),
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
- **No login shell parses a call.** ssh hands its remote command to the
  person's login shell, so each call sends one fixed `sh -c` decoder and then
  the script and every argument encoded: single-quoted words of plain bytes and
  octal escapes that `sh` turns back with `printf %b`. A file path, grep pattern,
  branch name, or command never reaches the login shell as text it could read.
  A thread terminal's startup goes the same way, then `sh` replaces itself with
  the person's own shell. `sh`, `bash`, `dash`, `zsh`, `fish`, `tcsh`, and `csh`
  all work; a server needs a POSIX `sh`. An argument holding a NUL byte, and a
  call past about 120 KiB on the wire, are refused here and nothing runs.
  _Rationale:_ every shell quotes differently. Measured on fish 3.6, `\'` inside
  single quotes ended the word and ran what followed, before any level or
  approval saw it; on csh and tcsh a backtick ran and a newline was an error.
  A rule per shell would have to be right for every shell, including ones not
  yet tried, so no shell is given anything to interpret. Octal rather than
  base64 needs no program beyond `sh`'s own `printf`. A value is split into
  several words because csh refuses one past about 8 KiB.
- The script's own exit status 255 is reported as 254, so 255 always means
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
  offered there, since each acts on this host. The routine tools are offered,
  since they act only on this host's routine records ([Routines](#routines)).
- **Attached files.** A file the turn names by path rather than sends (any
  file but an image or a file the model takes natively) is copied before the
  turn is accepted, over the Project's own SSH connection, into the thread's
  attachments folder on the server,
  `<home>/.octant/thread-attachments/<thread>/<attachment>/<name>`, outside
  every Project folder. The copy is made read-only, its SHA-256 is checked
  against the journaled digest, and the turn names its path there. The thread's
  file tools read that folder and write nowhere in it; another thread's do not
  read it. A copy that fails refuses the turn with a sentence saying so. The
  copies stay on the server when the thread is deleted (not built: removing
  them). The same holds for a Work thread there
  ([Plan and Chat tool parity](../architecture.md#security-and-authority)).
- **The same levels.** The thread's guardrail level is resolved as it is for
  any Code thread (thread, then the account default), and decides each call as
  it does locally: Plan is read-only, Guarded asks for every command and edit,
  Accept edits waives edits inside the folder, Reviewed hands each request to
  the chosen reviewer, and Full access asks nobody.
- **Reviewed on a server.** Shield judges a server Project's call by that
  server's action profile, as it judges a command that names the server over
  ssh. A command is placed in the same tiers: one the profile includes passes,
  one it does not goes to the person, and a lock-out, or anything naming a
  protected path or a server's own secret, goes to the person at every profile.
  A command no tier names goes to the model at Operate and Admin, which is told
  the server and its profile, and to the person at Read-only, so a Read-only
  server stays read-only. A file edit counts as a configuration change, as an
  upload does, so it needs Admin; a read inside the folder passes. This host's
  safe places, protected paths, and Project commands judge nothing there. A
  Project whose server left the registry goes to the person.
- **Outside content on a server.** The Watcher reads every result that comes
  back from a server and marks the thread when it finds injection-shaped text.
  Shield treats a server thread as having read outside content from its first
  call, and sends commands that change the server, and reach-out commands, to
  the person. A plain read does not by itself put the thread's outside-content
  mark on. _Rationale:_ a file on a server can carry an injection, but the mark
  makes every later edit and command ask afresh at every level below Full access,
  so marking each read would turn Accept edits and Reviewed into Guarded on a
  server after the first file. The Watcher's finding, which does set it, and
  Shield's standing assumption keep the gate where the risk shows.
- **No sandbox on the server.** Octant has no OS confinement and no egress
  rules on the server at any level, so below Full access the approval is the
  only guard on a command there. A remembered approval therefore does not
  cover a command on a server; each one asks the level's approver again.
  _Rationale:_ a remembered approval was given for commands that run inside
  this host's sandbox, and carrying it to a server with none would widen what
  the person agreed to. Full access is no sandbox and no prompts, as locally.
- **Files.** The file tools resolve every path on the server to its real path
  and refuse one outside the folder, judged on this host. A search uses the
  server's `find` and `grep -E`, so its pattern is a POSIX extended expression
  there.
- **Protected paths.** The Files panel and file editor, `@` path mentions, and
  search refuse the secret guard's list at every level. A thread's file tools
  refuse it below Full access, and at Full access only the Provider sign-ins
  group, as Octant's own file tools do locally (maintainer decision,
  2026-11-15): the level is read on every call, and the server's script and
  this host's check both use that level's form of the pattern, the list with
  every other group and every added path left out. It is one list
  (`serverProtectedPathPattern` in the secret guard policy), so the two cannot
  drift, and the person's own changes in Settings › Permissions › Protected
  files apply: an added `~/x` or absolute path, and a removed group. The server
  applies it to the real path before printing a byte, this host applies it again
  to what comes back, and search and listing pass over a protected file without
  naming it or sending its lines here. How it reads on a server:
  - A home entry matches below any folder, since the server's home is not known
    here and `/root/.aws/credentials` is as secret as the login user's. Both
    platforms' entries apply, since a server may be either.
  - A group also refuses its whole folder, and key files by name anywhere:
    `.ssh`, `.aws`, `.kube`, `.docker`, `.config/gh`, `.gnupg`, and `*.pem`,
    `*.key`, `*.p12`, `*.pfx`, `*.ppk`. _Rationale:_ the local list leaves SSH
    `config` and similar readable because local programs need them; these are
    Octant's file tools, and a server already refused the folders.
  - Entries under Octant's data and runtime folders are left out, since they
    name this host's folders. An entry's exception is not kept (no regular
    expression `grep -E` reads can say it). An added absolute path means that
    path on the server.
- **What a command can still read.** The list binds Octant's own tools only.
  Octant has no sandbox on a server, so a shell command run there can read
  anything the login user can, and its output comes back to this host. What
  stands in front of one is the level: Plan runs no command, Guarded and Accept
  edits ask the person for each one, Reviewed hands each to its reviewer (Shield
  sends a command naming a protected path or a server's own secret to the
  person, but reads only the command's words, so a path built at run time is not
  seen), and Full access asks nobody. A person's terminal is their own login.
  The Git tab and Review show the contents of tracked files, so a credential
  committed to the repository is visible there, and Tests run the folder's own
  commands.
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
- **Project terminal.** A server Project's own terminal (the one with
  no thread) is the same SSH
  login shell in the folder, owned by the local window that opened it and
  journaled as a local Project terminal is. It has no extra folder and no
  browser beside it. A server removed from the registry refuses the next
  start; removing the Project ends its shells. Its posture is recorded as
  Full access. _Rationale:_ the posture says what holds the shell, and on a
  server nothing does: Octant has no sandbox there, and the person opening
  their own shell is the approval, as it is for a local Project terminal.
  A Code Project opens it from the dock's quick tools. A Work Project opens
  **Open terminal** in its Settings → Permissions → Servers row, only while this
  live local window holds that Work Project and its default-off **Developer
  tools** choice is on. Another Work Project offers its existing explicit
  **Open Project** transition first. The login user, alias, canonical folder
  and Full remote access are shown before launch. No folder override or Work
  task context is accepted: this person's shell starts at the Project root,
  and grants no task, provider, credential or Browser authority.
  The host checks the window, Work enablement, Project binding, registry
  login/profile and Developer tools before dispatch and after acquisition.
  Switching/closing the window, hiding tools, disabling Work or removing or
  changing that binding/registry retires its owned local SSH session. Stop
  during a pending start cancels only that window's exact Project/session
  and closes any late acquisition. Closing or unmounting the panel does the
  same. The terminal reuses ordinary input, resize, Stop and exit rendering.
  A dropped session is never restarted; closing SSH cannot prove every
  program on the server ended. Unknown replies never replay a start or input.
- **Saved Project actions.** Settings → Permissions → Servers edits up to
  twelve saved commands on the server Project's own catalog record. Action
  saves have an optimistic revision and a journaled `server-projects.actions-replaced@1`
  event; old records remain valid. Root package scripts and Makefile targets
  are suggestions from the existing bounded remote file reader, never from
  this host. Reading or adding a suggestion does not save or run it.
  The Project header, command palette and Settings open the existing action
  review. In Settings, a different or unbound Code Project offers an explicit
  Open Project transition through the existing server-task draft flow; its
  action editor stays usable, but reads no suggestions and offers no Run until
  this window holds that Project. Before launch the review shows the exact server login and action profile,
  canonical folder, branch, current task policy and the absence of OS confinement
  on the server. A Code task defaults to its actual remote checkout; choosing
  the server Project folder is explicit. There is no similarly named local
  folder fallback. Plan and paired-device launches refuse.

  The reviewed placement binds the saved-action revision, registered server
  identity and profile, Project binding, canonical directory device/inode,
  Git head/branch and current task/checkout authority. Launch resolves these
  again and the remote command checks its held working directory before
  executing. A removed server, changed profile, replaced checkout, changed
  action or revoked task refuses stale launch. Each accepted run journals its
  identity before starting a dedicated encoded SSH command, never writes into
  an existing terminal, and carries no copied host credentials. Its posture is
  Full access because SSH provides no OS confinement; the explicit local-person
  Run approves that command without granting an agent more access. Automatic
  worktree preparation recipes are unavailable here.

  Output and exit status use the existing bounded terminal transcript. An
  action's exit255 is reported as254, reserving SSH255 for connection loss.
  Connection loss is interrupted with uncertain remote completion; Stop and
  revocation stop the owned connection but cannot prove arbitrary remote
  descendants stopped. An unconfirmed start is recorded distinctly. Closing
  the review retains its run identity. Lost replies, repeated identities and
  host restart never replay a command; preparing another run is a fresh person
  decision after checking the server.

  Work server Projects use the same dedicated saved-action runs, with their
  own real Work binding rather than a Code checkout or local Project. A Work
  task's current access, provider/model/options, binding and relative working
  directory bind the review; changing them, completing the task, disabling Work,
  closing its window or switching that window to another Work Project retires
  its admitted action authority. A mixed-mode or stale task is refused before
  remote reads or effects. Project-level runs still require that live window's
  persisted Work Project. An explicit local-person Run approves only its saved
  SSH command; it grants no additional agent, terminal or credential authority.
  Settings uses this window's Work binding for its suggestions and Run controls;
  a different or unbound Work Project offers the same explicit Open Project
  transition as Code, while manual action edits remain available.

  The Work server Project's **Show developer tools** switch is off by default
  in its existing Settings → Permissions → Servers row. A
  `set-server-work-developer-tools` command, from a local window or a paired
  device (maintainer decision, 2026-11-12; not built yet: today local-only), journals who and when as
  `server-projects.work-developer-tools-changed@1`. It reveals the action editor,
  saved-action buttons, the person's Project terminal in this Settings row,
  and active Work header/palette entries. It changes no task authority and
  enables no general Developer tools pane or other absent server Work surfaces.
  Hiding it closes the person's SSH session; a person may turn it off while an
  already admitted command keeps its separate execution authority. Work actions
  have closed standard input, refuse interactive terminal writes, and keep their
  output in the action dialog without a terminal handoff. This is an input/UI
  boundary, not confinement of the saved command's SSH-user authority.
  They
  retain the same honest no-confinement review and uncertain remote completion
  after connection loss or Stop as Code.

- **Fail closed in a turn.** A file call that cannot reach the server is
  refused `target-unavailable` and a command reports the shell unavailable;
  the next call tries the server again. Nothing a server thread asks for runs
  on this host.
- **Windows.** A window binds a server Project with no folder of this host
  (`boundRoot: null`), so Files, Browser, and every root-backed surface fail
  closed, and a server thread opens only its own view. A server Project's
  thread can also sit in its own pane beside a local Project's, under the same
  rule: its pane's context has no bound root, and its terminal is reached only
  while a visible pane shows it.
- **Checkpoints.** A turn on a server takes no checkpoint, so restoring
  files is not offered there and Rewind to here rewinds the conversation
  only, saying why; Git on the server is the way back for files.

### Work Projects

- **A Work Project on a server** is bound as a Code one is (same command,
  same folder check, same person-only rule, same catalog) with `mode: "work"`.
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
  task, Canvas, or extension, and a turn that selects an extension is
  refused. The routine tools are the exception, since they act only on this
  host's routine records ([Routines](#routines)). Nothing watches the folder for written files, and the Project's
  status file and extra folders are not read, since each is a folder of this
  host. A turn that cannot bind (a removed server, a runtime other than the
  Octant Harness) is refused before it starts, and a call that cannot reach
  the server runs nothing anywhere.
- **Windows.** A window binds a server Work Project, and its threads, with no
  folder of this host (`boundRoot: null`). Its Files panel reads only server
  metadata through the bound server connection; Browser and other surfaces
  that need a folder of this host stay unavailable.
- **Files.** The local window admitted to an active Work thread can list names
  and byte sizes in that thread's exact server Project folder. Refresh reads
  again; there is no watcher, preview, download, reveal, editing, or attribution
  of files to Work output. Rows stay inert. The listing uses the same resolved
  root and protected-path checks as server Code files, skips links and hidden
  entries, and is capped at 1,000 entries and eight levels below the requested
  folder, with an incomplete notice when bounded output is truncated. Sizes
  come from the server's GNU or BSD `stat`, without reading file contents.
  Missing metadata makes the list incomplete. Cancellation, loss of the
  connection, removal of the server or Project, rebinding, or loss of the
  window's access withholds the result; no local folder is tried instead. The
  binding, registry and window authority are checked again after the remote
  read. Paired-device callers are refused.
- **Views.** Settings › Permissions › Servers binds one with **Project kind: Work**.
  The Work sidebar lists it under **On your servers** with its threads; the
  Work composer offers it, with only Octant Harness models choosable and no
  extension, issue, or terminal session to start from; and its thread view
  names its server and folder and offers no Browser, extension, image
  generation, or file mention. Its dock keeps only Side chat, Document,
  Canvas, Plan, Agents, and Files. Files names the server location and explains
  that it shows names and sizes only. The person's server Project terminal opens
  only from the bound Settings row above; the general dock tools still have no
  server Work form.

### Routines

A Code or Work routine may target a server Project (maintainer decision,
2026-11-14). This host's scheduler runs it, and its turn runs in the Project
exactly as a person-started turn there would: on the Octant Harness, over the
Project's connection, under the same levels, approvals, and journal.

- **Revalidation.** Every occurrence revalidates the routine against the server
  catalog, as a local routine's revalidates against the local one. A server
  Project's binding has no revisions: it is the one the Project derives from
  its id, server, and folder (a Code routine binds the Project's own folder
  checkout, a Work routine its derived Work binding), so a folder bound again
  is a new Project and never matches. The occurrence is refused, and the
  routine paused, with a reason naming the cause when the person removed the
  Project (`project-mismatch`), when its server left the registry
  (`binding-mismatch`), or when its mode or binding no longer matches; host,
  profile, provider, model, and authority are revalidated as for any routine.
- **Reaching the server.** A run's first act is on the server, before any
  thread is created: a Code run reads the branch the Project's folder has
  checked out there, which its own worktree starts from; a Work run checks the
  folder answers. A server that cannot be reached, or a folder that is gone,
  fails that run with a reason naming the server, creates no thread, and runs
  nothing anywhere; the routine stays enabled for its next occurrence.
- **Threads.** A Code run makes its own worktree on the server
  ([Worktrees and pull requests](#worktrees-and-pull-requests)); a Work run's
  thread works in the Project's folder ([Work Projects](#work-projects)). The
  run's level is chosen as for a local routine; with no Project level on a
  server Project, an opted-in routine takes the account default.
- **Routine tools.** A server Project's turns are offered the routine tools a
  local turn has (propose a routine, list and read the Project's routines, ask
  to pause or archive the thread's own, report a run's result), since they act
  only on this host's routine records. A proposal confirmed from a server
  thread binds the Project, never the thread's worktree.
- **Who sees them.** Automation lists and changes a server Project's routines
  for the host's own person, the principals that may read the server catalog;
  a restricted device reaches none.
- **The editor.** Automation Center's routine editor lists the server
  Projects of the chosen mode beside local ones, named with their
  `alias:folder`, from the server catalog the window already reads, so a
  restricted device, whose read is refused, lists none. A chosen server
  Project binds the binding its host derives (the catalog reports a Code
  Project's own folder checkout and a Work Project's binding revision, at
  version 1), its execution profile is offered Octant Harness models only,
  and the routine is saved and edited through the same Automation route as
  any other, so every occurrence revalidates it as above.
- **File triggers** watch a folder of this host, so a file routine cannot
  target a server Project: the editor offers no file trigger for one, naming
  why, the Automation route refuses one at save with the same reason, and
  revalidation refuses one at every occurrence.

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
  travels when it is outside the folder or protected
  ([Threads](#threads)). A listing names only real folders and files, never
  a link, skips `.git` and `node_modules` as a local listing does, and leaves
  out protected paths; it keeps the local listing's entry and depth
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

- Work file previews and editing, research sources, the status file and due
  dates for a Work Project on a server; its threads and person-operated Project
  terminal are built. A local Work Project shows its terminal through its
  Developer tools switch on its overview. A server Work Project uses the
  Settings row above, which also offers a saved-action presentation switch; a
  general Developer tools pane remains absent.
- Extra folders in a server Project.
- A Project-level guardrail level or reviewer for a server Project; the
  thread and account levels apply.
- Real servers are untested: the connection, folder check, file tools,
  commands, terminals, the Git tab, the Review tool's history, Files, Tests
  and worktrees were exercised against a throwaway local `sshd` only, and
  pull requests against a stand-in for `gh`, never GitHub. Routines there were
  exercised against fakes of the connection only. The connection and
  file tools also ran against a throwaway Linux container's `sshd` with bash,
  dash, zsh, fish 3.6, tcsh, and csh as login shells. Linux hosts are likewise
  untested; the connection uses only `ssh` options both platforms share.

## Machines in the person's cloud account

Partly built (maintainer decision, 2026-11-14). Octant may create a machine in
the person's own cloud account and bind it as a server Project, as a
[delivery target the person owns](../architecture.md#modes-chat-work-and-code).
Octant operates no hosted machines of its own; an Octant-operated hosted
service stays out of scope
([Current Release Boundary](../architecture.md#current-release-boundary)).

- **A target is a plugin.** A cloud machine target is a plugin contribution
  (component kind `cloud-machine-target`, `@octant/plugin-api/cloud-machine-target`)
  that creates a machine from a recipe (the provider's image, size and region
  names, and an optional setup script of at most 16 KiB), describes it,
  suspends, resumes and destroys it, and reports the SSH endpoint (a host name
  or address and a login, port 22) the server Project connection uses. The
  plugin host offers a target only once its plugin is installed, trusted and
  enabled, read again at every act, and withholds every target that shares an
  id (`@octant/plugin-host/cloud-machine-targets`). A target is never offered
  to a thread in any mode, and no stored package may run one until a launch
  class confines a process that needs a cloud provider's network.
- **Credentials stay in the broker.** The cloud credential is a credential
  broker reference. For each act the host resolves it to a handle scoped to
  that target and act; the target names the handle and never sees the value.
  The journal records the reference, never a value or a handle.
- **Every act is the person's.** Creating, binding, refreshing, suspending,
  resuming and destroying are the person's acts at a local window
  (`/api/cloud-machines`). An agent and a routine are refused `needs-person`
  before any target or broker is asked. The design also lets a device the
  host's own person paired act; not built yet, it is refused
  `needs-local-window`, as binding a server Project still is.
- **Destroy asks once.** Destroying is irreversible and ends what the
  person's account pays for, so it needs a confirmation the host issues for
  exactly that machine (`request-cloud-machine-destroy`). The confirmation is
  single-use, expires after five minutes, and is spent by any attempt that
  carries it; a confirmation for one machine never destroys another.
- **Journal.** Each machine is its own `cloud-machines` aggregate:
  `creation-requested@1` is journaled before the provider is asked, so a
  machine the person pays for always has a record; then `created@1` with the
  provider's decoded answer, or `creation-ended@1` as `refused` (the target
  asserts nothing was created) or `uncertain` (no answer, or one that did not
  decode: a machine may exist, and the person is told to check their
  account). `project-bound@1`, `state-changed@1` (suspend, resume, a destroy
  the provider is still finishing, or a refresh) and `destroyed@1` follow.
  The machines are rebuilt from the journal at startup.
- **In-between states are reconciled, never gated on.** A provider may accept
  an act and finish it later, answering `suspending`, `resuming` or
  `destroying` (or `provisioning`, `unknown`). Before a suspend or resume on a
  machine journaled in such a state, the host asks the target to describe it
  and journals the answer, then decides; the person may also refresh a
  machine (`refresh-cloud-machine`). A machine is recorded destroyed only when
  its provider reports it destroyed or no longer has it; one still
  `destroying` stays live, counts against the limit of 32 live machines, and
  is refreshed until it is gone.
- **The list is bounded.** The view lists every live machine (at most 32)
  and only the 16 most recent destroyed machines and refused creations; older
  settled ones stay in the journal.
- **Binding.** A created machine's endpoint is registered as a server
  (Read-only profile, the person's SSH agent), or the person's existing
  registration at the same address and login is reused, and the Project is
  bound through the catalog's own folder check. A refused binding leaves the
  machine created and on record; the person binds again
  (`bind-cloud-machine-project`) or destroys it. Destroying leaves the Project
  and server registration for the person to remove.
- **State on the Project.** The server Project catalog shows the machine
  behind a Project and the state its provider last reported (`cloudMachine`
  on the catalog entry). Octant never claims a state or a cost it did not
  read.
- **Host keys are pinned at creation.** A target reports the machine's SSH
  host public keys with its endpoint (`hostKeys`, at most eight, OpenSSH
  key types only, read from the provider's own record of the machine, never
  by connecting to it). They are journaled in `created@1`, and from then on
  every connection to that server (calls, terminals, previews, setup checks,
  and the binding's own folder check) checks the host key against those keys
  alone: the host writes them to a known hosts file in the private folder
  its shared connections use and adds `UserKnownHostsFile` (that file),
  `GlobalKnownHostsFile=none`, `KnownHostsCommand=none`,
  `VerifyHostKeyDNS=no`, `CheckHostIP=no` and a fixed `HostKeyAlias`, with
  `StrictHostKeyChecking=yes` and `UpdateHostKeys=no` unchanged, so no
  setting of the person's (DNS SSHFP records included) can vouch for another
  key. The pinned keys are part of the shared connection's identity, so a
  connection opened before a pin was installed or changed is never reused
  under it. So a
  brand-new machine is accepted without a manual first login, and a machine
  that answers with any other key is refused as `server-unreachable`. The
  pin never changes after creation, whatever a later describe reports, and a
  destroyed machine pins nothing, so an address the provider reuses is not
  held to an old key. A target that reports no keys leaves the person's
  known hosts to decide, as for any registered server. This is the one file
  Octant writes for SSH; it holds only public keys the person's own
  provider reported.
- **A suspended machine refuses by name.** While a machine's last reported
  state is `suspended`, a turn in its Project is refused before it launches,
  and every call, terminal and preview stream to its server is refused
  before ssh starts, with "This
  machine is suspended; resume it first in Settings › Permissions ›
  Servers." instead of failing as an unreachable server. The Project's row
  in Settings › Permissions › Servers says so and offers Resume there.
- **Reported cost only.** A target may report the provider's own hourly
  cost (`costPerHour`: the amount as the provider wrote it, an ISO 4217
  currency, and the provider record it came from), with creation or any
  later answer. The host journals it with the answer and shows it as
  reported, with its source and when it was read; it never estimates,
  converts or totals a cost, and shows none when the provider reports none.
- **Screen.** Settings › Permissions › Servers lists the machines (state,
  target, when the provider last answered, reported cost, endpoint and
  whether its key is pinned) with Refresh, Suspend, Resume, Bind Project and
  Destroy, Destroy asking the host's one-time confirmation in a dialog, and
  a Create form for an offered target (name, Project kind, folder, image,
  size, region, the credential broker reference and an optional setup
  script). The section is absent when no target is offered and no live
  machine is on record, and when the host refuses the list, as it does for a
  restricted device; every act is still the host's to refuse.

_Rationale:_ creation is journaled first because the failure that matters is
a paid machine nobody knows about; a refused or uncertain creation still
lists the machine. Destroy's confirmation is host-issued and bound to one
machine, rather than a flag in the request, so a replayed or forged request
cannot stand in for the person's answer.

**Not built yet** (next slice):

- The first real target plugin for one cloud provider, with the launch class
  that confines it, its credential broker namespace and the person's
  credential setup (the Create form takes a broker reference until then).
  With no target plugin, the screen stays absent.
- A key Octant makes for each machine (`octant-key` sign-in), installed at
  creation.
- Waking a suspended machine when the person opens its Project.

## Person-operated dev-server previews

A local person can open **Dev server preview** under a bound Project in Settings
› Permissions › Servers. Choose the port of an already running HTTP dev server on
that server's literal `127.0.0.1`, and a local port, or `0` to choose a free one.
The effective local URL and remote port are visible. Where a paired Octant
host already owns the dev server, use its existing paired-host preview. An SSH
alias is not evidence of a paired-host identity.

The plain SSH path owns a private loopback TCP listener and at most eight
concurrent, dedicated `ssh -W` stdio streams. This carries HTTP and WebSocket
upgrades unchanged. It uses no shared command socket, starts no remote program,
forwards no agent, and retains `BatchMode=yes`, strict known-host checking and
`ClearAllForwardings=yes`. Stdio forwarding does not enable configured local,
remote or dynamic listeners. Ordinary command connections are unchanged.

Only an authenticated local window can start, stop or reconnect its preview.
Before listening and before each stream, the host checks the current Project,
registered server, binding identity and owner. A one-second sweep closes the
listener and its streams after removal or owner revocation, and after one hour,
including a lost preview whose owner is gone. A revoked preview releases its
ownership: any current local window may start a new preview for that Project.
Stopping a preview leaves the remote program running. A port collision refuses
without choosing another address. A failed SSH stream marks the preview lost
and closes the listener. **Reconnect same endpoint** makes one explicit attempt
with the same local port, remote port and current binding, without retrying a
remote command or accepting a changed host key. Reusing the local port may fail
if another process has taken it. Listening locally is not proof the remote app
has answered; SSH connects when the preview is opened.

Stop, restart, reconnect and host shutdown await the retained receipt for the
actual listener and SSH child cleanup. A second stop joins the existing cleanup;
a status change alone is not proof that the owned processes have exited.
Shutdown also waits for a listen attempt that has not yet published its preview.
Reconnect keeps the old ownership until cleanup settles, then rechecks the
original binding and owner before reopening the same endpoint. Stop can cancel
that pending reconnect.

Cleanup sends SIGTERM and escalates to SIGKILL after one second. If settlement
cannot be confirmed within three seconds, stop or reopen is refused as
`cleanup-unsettled`, and host shutdown reports a failure while completing its
other cleanup. The actual receipt stays retained after that deadline; a later
attempt must still await it and cannot replace a live owned process. A completed
stop outcome is journaled only after cleanup settles.

The journal records Project, owner window, selected ports, effective local URL
and lifecycle outcomes as `server-projects.preview-outcome@1`. It records no
credentials, stderr, HTTP bodies or page contents. Active listeners are not
restored on restart. Opening a new preview requires another person action.
