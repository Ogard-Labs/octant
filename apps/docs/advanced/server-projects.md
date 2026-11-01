---
description: Bind a folder on one of your own servers as a Code or Work Project, reached over SSH with your own SSH agent.
---

# Projects on your servers

You can keep a Code or Work Project in a folder on one of your own servers. Octant
reaches the server with `ssh` on this computer, signed in through your own SSH
agent, and never falls back to this computer when the server cannot be
reached.

## Bind a folder

1. Register the server in **Settings → Access → Servers**: the host alias from
   your SSH config and the user you sign in as. See
   [Your servers over SSH](./privacy-and-security#your-servers-over-ssh).
2. Connect to it once yourself with `ssh` in a terminal, so its host key is in
   your known hosts. Octant never accepts a new or changed host key for you.
3. Under **Projects on your servers**, choose **Code** or **Work**, give the
   Project a name, choose the server, and type the folder's path on the server. Octant checks over SSH
   that the folder is there before it binds it, and stores the folder's real
   path.

Only someone at this computer can bind or remove a server Project.

## What Octant does and does not do

- Octant uses this computer's own `ssh`, your SSH config, and your SSH agent.
  It names no key file, reads no key, writes no SSH config, and forwards
  nothing to the server: no agent, no ports, no windows.
- Octant keeps one connection to each server open while you work and closes
  it after a quiet minute, so Git and the file tools do not log in for every
  step. When the server cannot be reached, or the connection drops, that call
  fails and nothing runs on this computer instead; the next call logs in
  again.
- Removing a server from **Servers** keeps its Projects, but they cannot
  connect until you register the server again or remove them.
- While a Project is bound to a server, that server's alias and user cannot
  change, since its folder was checked on that host. To move, remove the Project
  or register the new address as another server. Its profile can still change.
- Any login shell works, fish and tcsh included. The server needs a POSIX `sh`.

## Work in a server Project

Server Projects are listed in the Code sidebar under **On your servers**.
Choose one to start a thread there.

- **Octant Harness only.** A thread in a server Project runs on a model the
  Octant Harness runs. Other runtimes act on this computer's files, so the
  composer shows them as unavailable there.
- **Files, commands, and Git run on the server.** The agent reads and edits
  files in the folder on the server and runs commands there, Git included.
  Every command is recorded with the server and its exit status.
- **The same access levels.** Plan, Ask first, Accept edits, Auto, and Full
  access mean what they mean in any Code Project. Octant cannot sandbox a
  server, so below Full access every command asks again, even when you
  allowed commands earlier in the thread. Full access asks nothing.
- **Protected files.** Octant's file tools, the Files panel, and search refuse
  the list in **Settings → Permissions → Protected files** on the server too, at
  every level, your changes included. A command is different: it can read
  anything your server user can, so what guards it is the access level. Ask
  first asks you, Auto hands it to its reviewer, and Full access asks nobody.
- **Auto follows the server's profile.** With Octant Shield reviewing, a server's
  action profile caps what passes without asking: a Read-only server gets reads
  only, and edits in the folder need Admin. Everything a server sends back is
  treated as possible outside content.
- **Terminals.** A terminal in the thread is a login shell in the folder on
  the server. When the connection drops, the terminal ends.
- **Project terminal.** When you start a new task in a server Project, the
  dock's quick tools offer **Terminal**: a login shell in the folder on the
  server, with no thread. There is no Browser beside it, and saved Project
  actions are not available there yet.
- **Git tab.** Choose **Git** on the thread's checkout bar to see the
  changes in the folder on the server, stage, commit, and push. Git runs on
  the server with the server's own Git setup. At Plan it changes nothing.
- **Review.** The dock's Review tool shows the working tree, local commits,
  and history of the folder on the server, read by Git there.
- **A worktree of its own.** In the composer, choose **Workspace** ›
  **Managed worktree** to start the thread on a new branch in its own
  worktree on the server, beside the Project's folder, from the branch you
  pick. The Project's folder must be its repository's top folder. Octant
  never removes that worktree; remove it on the server when you are done
  (`git worktree remove`). Plan cannot start a thread in a new worktree.
- **Pull requests.** Push the thread's branch from **Git**, then choose
  **Create pull request** on the checkout bar. Octant opens it with this
  computer's GitHub sign-in, on the GitHub repository of the remote on the
  server.
- **Files and Tests.** The Files panel lists the folder on the server, and
  files open and save there. Choose **Refresh** to see changes made on the
  server, since the folder is not watched. The Tests panel runs the tests
  your `package.json` or `.octant/tests.json` defines, on the server, under
  the thread's access level. A save is refused when the file changed on the
  server after you opened it.
- **Not available there yet:** connectors and plugins, Browser and Computer,
  subagents, forks, checkpoints and rewind, and searching across the folder.
  Ask the agent to do it on the server, or use a terminal.

## Work Projects on a server

A Work Project on a server is listed in the Work sidebar under **On your
servers**. Choose it to start a Work thread there.

- **Octant Harness only, with files and commands on the server.** The agent
  reads and edits files in the folder on the server and runs commands there,
  under the thread's access level. Below Full access every command asks
  again, and every command is recorded with the server and its exit status.
- **Nothing of this computer.** A Work thread there has no Browser, Computer,
  extensions, image generation, or file mentions, and starts without an issue
  or a terminal session. It stays in the Project's folder: it cannot be moved
  to another Project or folder.
- **Not available there yet:** the Work Files panel, research sources, and the
  Project's status file and due dates.

## Testing

- **Tested on a throwaway local server only.** Octant's tests ran this against
  an `sshd` started on this computer for the test, never a real server.
