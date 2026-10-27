---
description: Keep a Code Project's folder on a machine you reach with ssh, and open terminals and managed worktrees there under the same confinement as on your Mac.
---

# Code on an SSH target

An SSH target is a machine this Mac reaches with `ssh`: a Linux build box, a
cloud VM, a workstation under your desk. A Code Project can keep its folder on
one. Octant on your Mac keeps the Project's record and every decision; the
target is only where the files are and where commands run, and only after it
proves it confines them as your Mac would.

In this technical preview you can register targets, bind a folder on one as a
Code Project, read its files, Git status, and diff, open terminals there, and
create managed worktrees. **Threads in a remote Project are not available
yet**: the composer's Project picker lists remote Projects so you can see
them, but does not offer them for a new task. macOS targets are not
admitted yet either.

## What the target needs

- Linux on an x64 or arm64 CPU, reachable with `ssh` from this Mac as you
  already set it up (aliases, `ProxyJump`, and hardware keys in your SSH
  configuration all work).
- A user other than root. Octant refuses a root login.
- The headless Octant of **exactly this version**, installed by you. Octant
  never installs software on the target. See [Linux host](/guide/linux-host)
  for the install; you only need the files, not a running server.
- Bubblewrap (`bwrap`), with unprivileged user namespaces enabled for that
  user, and an existing `~/.ssh` folder (Octant proves it cannot be read).

## Add a target

Open **Settings › SSH targets** in the desktop app. Under **Add an SSH
target**, enter the destination as you would type it after `ssh` and the
path of `octant` on the target, then choose **Read host key**.

Octant connects once with every login method off, reads the key the target
presents, and shows its fingerprint. Compare it with the key the target's
administrator gives you, then choose **Pin this key**. From then on Octant
connects with that key alone, from its own known-hosts file; a later change
to your own `~/.ssh/known_hosts` never re-trusts a target. If the key ever
changes, the target shows **Host key changed** until you choose **Check host
key…** and confirm the new one.

The same steps work from a terminal on this Mac:

```sh
octant ssh-target add build@devbox --executor /home/build/.local/octant/bin/octant
octant ssh-target list
```

The pin proves only that later sessions reach this key. Whoever administers
the target can read its files and alter the Octant there, so choose targets
whose administrators you trust with the code.

## What "admitted" means

On every connection, Octant on the target runs small probes in each
posture — Plan, Ask for approvals, and Auto-accept edits — that try what the
posture forbids: writing outside the folder, reading `~/.ssh`, reaching the
network around Octant's proxy, starting programs in Plan. A posture is
admitted only when every probe was refused, on this connection. Each target's
row shows what each posture admits now, and a refusal says what to do, for
example "The target has no working bubblewrap. Install bubblewrap on the
target." If any probe escapes, nothing is admitted on that connection.

## Bind a folder

Under **Remote Projects**, choose **Bind a remote folder**: pick the target,
type the folder as the target names it, and name the Project. Octant resolves
the folder on the target and refuses `/` and any folder that holds or sits in
your `~/.ssh`. From the composer, **New Project on an SSH target…** in the
Project picker opens this page.

## Terminals

**Open terminal** on a remote Project, or on one of its worktrees, opens a
shell on the target in that folder. It is yours alone: only the window that
opened it can type into it. It runs with the confinement the target proved
for Ask for approvals, and it has **no network**, because a terminal has no
thread whose egress rules could decide its connections. Its home is a fresh
folder that ends with the session, so your shell's own dotfiles on the target
are not read. The page shows one terminal at a time: opening another, or
leaving the page, stops the one it showed.

If the connection drops, the shell and everything it started end with it, and
the terminal says it was interrupted. Nothing reconnects it or replays what
you typed; connect the target again and open a new terminal.

## Managed worktrees

Type a name and choose **New worktree** to create a Git worktree of the
Project on a new branch `octant/<name>`, from the folder's checked-out commit.
It is created beside the folder, in
`<parent>/.octant-worktrees/<project>/<name>`, and no hook in the repository
runs. The bound folder must be its repository's own top level.

**Remove…** asks Git to remove the worktree without force: a worktree holding
a change or an untracked file is kept, and Octant says so. The branch and its
commits always stay. From a terminal:

```sh
octant ssh-target worktree add <project-id> fix-login
octant ssh-target worktrees
octant ssh-target worktree remove <worktree-id>
```

## Where a provider runs on the target

A provider's own runtime runs on a target only from the path you set for it
there, never from one the model, the repository, or the target suggests. Set
it from a terminal on this Mac, naming the target, the provider instance's
id, and the program's path on the target:

```sh
octant ssh-target runtime <target-id> <provider-id> /home/build/.local/bin/agent
```

Octant checks the file on the target before every launch: it must be an
executable that only you or root can change, outside the Project's folder
and your `~/.ssh`. Setting another path takes effect the next time the
runtime starts. Threads in remote Projects are not available yet, so nothing
runs from this path until they are, and no provider Octant ships can run on
a target yet.

## Removing a target

**Remove…** on a target ends its session and forgets its pinned key. Its
Projects stay listed on this Mac and take no new work. Nothing on the target
is deleted: not the folder, not its worktrees.

## What stays on this Mac

Octant journals each target, its pinned key, a digest of each connection's
attestation, the Projects bound to it, each worktree's folder, and when each
terminal opened and ended. What a terminal prints is never recorded. Provider
credentials and your SSH keys never reach the target, and agent forwarding is
always off. The host export carries targets and remote Projects without their
addresses or folders.
