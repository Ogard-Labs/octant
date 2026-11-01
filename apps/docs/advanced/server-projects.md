---
description: Bind a folder on one of your own servers as a Code Project, reached over SSH with your own SSH agent.
---

# Code Projects on your servers

You can keep a Code Project in a folder on one of your own servers. Octant
reaches the server with `ssh` on this computer, signed in through your own SSH
agent, and never falls back to this computer when the server cannot be
reached.

## Bind a folder

1. Register the server in **Settings → Access → Servers**: the host alias from
   your SSH config and the user you sign in as. See
   [Your servers over SSH](./privacy-and-security#your-servers-over-ssh).
2. Connect to it once yourself with `ssh` in a terminal, so its host key is in
   your known hosts. Octant never accepts a new or changed host key for you.
3. Under **Code Projects on your servers**, give the Project a name, choose the
   server, and type the folder's path on the server. Octant checks over SSH
   that the folder is there before it binds it, and stores the folder's real
   path.

Only someone at this computer can bind or remove a server Project.

## What Octant does and does not do

- Octant uses this computer's own `ssh`, your SSH config, and your SSH agent.
  It names no key file, reads no key, writes no SSH config, and forwards
  nothing to the server: no agent, no ports, no windows.
- Every call is its own connection. When the server cannot be reached, or the
  connection drops, that call fails and nothing runs on this computer instead.
- Removing a server from **Servers** keeps its Projects, but they cannot
  connect until you register the server again or remove them.

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
- **Terminals.** A terminal in the thread is a login shell in the folder on
  the server. When the connection drops, the terminal ends.
- **Not available there yet:** connectors and plugins, Browser and Computer,
  subagents, forks, checkpoints and rewind, and the Git, Files, and Tests
  panels. Ask the agent to do it on the server, or use a terminal.
