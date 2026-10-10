---
description: Run Octant on an always-on Linux machine, reach it from your laptop over Tailscale, and know what works there today.
---

# Linux Host

An always-on Linux machine can run the Octant server for Chat, Work, and Code
while your laptop sleeps. The server is the same one the desktop app runs; on
Linux it runs without Electron and confines Work and Code with Bubblewrap.

This page is a draft written from a run on an x64 Ubuntu 26.04 machine with a
loopback test endpoint rather than a real model. The last section lists what
does not work yet.

## Requirements

- **x64 Linux.** Ubuntu is the tested distribution.
- **Bun 1.3.14 or later** and a source checkout of Octant.
- **Bubblewrap** (`bwrap`). Code shell commands and terminals run inside it.
  Without it a provider reports **Incompatible**; Octant never runs an
  unconfined shell instead.
- **Git 2.36 or later.** Code Projects need a Git repository.
- **A Secret Service session and `secret-tool`**, only for storing provider
  credentials. Without one, `octant status` reports
  `Secret store: unavailable`; Chat, Work, and Code still run, but no stored
  credential is available to a provider.
- **A provider.** Use a provider CLI that keeps its own login (install it under
  `~/.local/bin` and point the provider at that absolute path), or an endpoint
  that needs no key, such as a model server on the same machine. See
  [what does not work yet](#what-does-not-work-yet) for API-key endpoints.

`scripts/ade/install-linux-host-deps.sh` installs Bubblewrap, `secret-tool`,
the GNOME keyring, and a recent Git with `sudo`. If you install packages
yourself, see [Installation](./installation#headless-linux-for-ade-testing)
for the keyring session it sets up.

## Install the server

From the checkout:

```sh
bun install --frozen-lockfile
bun run --cwd apps/web build
bun packages/cli/src/bin.ts server start
bun packages/cli/src/bin.ts server status
```

`octant server start` writes a per-user systemd unit
(`~/.config/systemd/user/octant.service`) that runs `octant server run` from
this checkout. The unit restarts the server after a crash and stops restarting
after five failures in a minute. The server listens on loopback only. Set
`OCTANT_DATA_DIR` (an owner-only directory) and `OCTANT_SERVER_PORT` before
`server start` to choose the store and port; the unit records both.

The service stops at logout unless lingering is on for your user. Check it
with `loginctl show-user "$USER" -p Linger`. Turning lingering on can need an
administrator (`loginctl enable-linger <user>`).

To run in the foreground instead, use `octant server run`. It drains running
work on SIGINT or SIGTERM.

### `octant server install`

`octant server install --artifact <directory>` installs an unpacked headless
artifact built by `bun scripts/package-headless.ts linux-x64` under
`~/.local/state/octant/install`, keeping versions side by side for
`octant server upgrade` and rollback. The artifact carries the packages its
CLI and server import, so it runs without a checkout.

## Pair a laptop over Tailscale

A paired browser reaches the host only through Octant's own HTTPS listener,
bound to the machine's tailnet name. Tailscale is the route, not the identity:
you still pair and approve each device.

1. Get a browser-trusted certificate for the machine's tailnet name. Run this
   as your user; no root is needed when Tailscale lets you fetch certificates:

   ```sh
   tailscale cert <machine>.<tailnet>.ts.net
   ```

2. Allow the listener port on the `tailscale0` interface if the machine runs a
   firewall. Ubuntu's `ufw` drops it otherwise, and the browser times out
   without an error from Octant.
3. Enable the listener with that name, a port, and the certificate and key.
   Octant refuses loopback and public addresses.
4. Mint a single-use pairing ticket that expires in five minutes:

   ```sh
   bun packages/cli/src/bin.ts pair --source tailscale
   ```

   Open `https://<machine>.<tailnet>.ts.net:<port>/#ticketId=<token>&ticketProof=<proof>`
   on the laptop.

5. Approve the request on the host after its six-digit code matches the one
   the browser shows.

Steps 3 and 5 have no command yet; see below. Until the listener is enabled,
`octant pair` answers `Local device administration is unavailable.`

[Remote Access](../advanced/remote-access) describes what a paired browser can
and cannot do.

## What survives laptop sleep

- **Everything on the host.** Running turns, approvals waiting for you,
  terminals, and the journal live on the Linux machine. Closing the laptop
  does not interrupt them.
- **Your pairing.** The browser keeps a non-exportable key. A device stays
  registered for 30 days without use (90 days at most), so waking the laptop
  and reloading signs in again without a new ticket.
- **Your place in a thread.** A browser session ends after 15 minutes idle.
  On wake, the browser shows the thread as stale and read-only, signs in
  again, takes a fresh snapshot, and replays from where it stopped. A draft
  stays in the composer; sending while stale is refused, not queued.

What does not survive is a **host restart's listener**: the listener comes
back disabled after the server restarts and has to be enabled again.

## What does not work yet

Each item is a known gap on a Linux host, not a permanent limit.

| What                                                      | What you see                                                                                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enabling the remote listener and approving pairing        | No command exists, and Settings → Remote access, which does both, is only in the desktop app.                                                                                                                               |
| The listener after a server restart                       | It comes back disabled.                                                                                                                                                                                                     |
| Saving an API key or bearer token for an endpoint         | The browser client says `Provider credential management is unavailable on this host.` A Secret Service session does not change that yet.                                                                                    |
| Terminals and other Full-access tools from `octant agent` | `octant agent` opens Code threads approval-gated, so the tool answers `This tool needs Full access for the thread.` Remembered Full access (`octant project access <name> full-access`) applies to threads that ask for it. |
| Raising a thread to Full access for one session           | Refused by design on a host with no native confirmation; use the remembered Project decision above.                                                                                                                         |
| Browser tool from `octant agent`                          | The site approval is not shown in the terminal, so the turn waits.                                                                                                                                                          |
| Apple and Xcode tools                                     | Unavailable on Linux.                                                                                                                                                                                                       |
