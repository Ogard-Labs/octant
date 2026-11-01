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

## Not available yet

Code threads and terminals in a server Project are not available yet. When
they are, they will run under the same access levels and approvals as any Code
Project.
