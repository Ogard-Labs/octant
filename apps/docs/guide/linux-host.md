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

## Desktop sandbox prerequisites

The Linux AppImage keeps Chromium sandboxing enabled. If Chromium reports
`No usable sandbox` or refuses a user namespace, do not add `--no-sandbox`,
disable AppArmor, or disable the host's unprivileged-user-namespace restriction.
The headless server and browser ADE remain usable while the desktop prerequisite
is resolved.

On Ubuntu with AppArmor user-namespace restrictions, ask the administrator to
review a profile scoped to the exact installed Octant executable. Use a stable,
owner-controlled installation path; do not grant every temporary AppImage mount
or every executable in a home directory permission. The profile must preserve
sandboxing for renderer children. A successful `unshare` command is not proof
that Octant has permission, and a refused one is not proof that Octant lacks it.
See [Ubuntu's AppArmor documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).
A supported installation must be checked with a real sandboxed launch before
claiming packaged desktop acceptance. Octant does not install or relax host
security policy automatically.

### Isolated desktop installation

A pre-existing rootless Cua Space is a tested option when direct launch on the
Ubuntu host is restricted. Use a Space whose existing policy already permits
Chromium to create its sandbox; do not change container privileges, seccomp,
AppArmor, or host sysctls just to make the application launch. Containers share
the host kernel, so this is not a separate VM security boundary.

On the validated Ubuntu 24.04.5 x64 Space, copy the built AppImage to a fixed
path in the Space's home directory and verify its SHA-256 against the build
artifact. Run as the ordinary desktop user, with the Space's existing display
and D-Bus session environment:

```sh
# Run inside the Space, after verifying the copied artifact's checksum.
mkdir -p "$HOME/Octant-validation/data"
chmod 700 "$HOME/Octant-validation/data"
APPIMAGE_EXTRACT_AND_RUN=1 \
  OCTANT_DATA_DIR="$HOME/Octant-validation/data" \
  OCTANT_SERVER_PORT=14790 \
  "$HOME/Octant-0.1.0-linux-x64.AppImage"
```

Use the actual filename for your build. The extraction option avoids a FUSE
mount; it does not disable Chromium's sandbox. Do not copy host credentials or
mount host directories for this launch check. No SUID helper installation is
needed on the tested Space. A direct host installation remains a separate
administrator-reviewed configuration; this recipe does not authorize an
AppArmor exception for home or temporary paths.

Verify more than a visible window. For the real renderer PID, `/proc/<pid>/status`
must show `NoNewPrivs: 1`, `Seccomp: 2`, zero effective capabilities, and a
Chromium seccomp filter in addition to any container filter. Its user, PID, and
network namespace identities under `/proc/<pid>/ns/` must differ from the main
Electron process. Confirm `--enable-sandbox` on the renderer and no
`--no-sandbox` or `--disable-setuid-sandbox` on the launch or renderer. Chromium
may also create a separate `--no-zygote-sandbox` zygote for utility processes;
that is not the renderer sandbox verdict. Test a UI interaction and host health.

This check passed on 19 October 2026 with Electron 43.7.11 and the AppImage built
from commit `608e44553ab4ea670356d3a65255a1bff9e1da3e`. The renderer had two
seccomp filters versus the main process's one, distinct namespaces, and no
effective capabilities. The existing rootless runtime's AppArmor label was
`crun (unconfined)`; no new profile or exception was added. The host's
`kernel.apparmor_restrict_unprivileged_userns=1` stayed enabled. The same artifact
refused direct launch on the Ubuntu host because no usable Chromium sandbox was
available. These results cover desktop launch, not provider, credential, or
Work/Code confinement acceptance. Quit this isolated app to stop the test;
preserve its data until cleanup is explicitly authorized.

## Requirements

- **x64 Linux.** Ubuntu is the tested distribution.
- **Bun 1.3.14 or later** and a source checkout of Octant.
- **Bubblewrap** (`bwrap`). Code shell commands and terminals run inside it.
  Without it a provider reports **Incompatible**, and a task terminal says
  that bubblewrap is missing and how to install it
  (`sudo apt-get install -y bubblewrap`); Octant never runs an unconfined
  shell instead. Bubblewrap 0.2.0 or later is needed; an older one refuses
  the launch. A confined command has no root privileges even when Octant
  runs as root: it cannot write a file only root's privileges would let it
  write, such as another user's file in the Project. A Full access thread
  keeps root's privileges.
- **A Bubblewrap that is not setuid**, for Full access with providers whose
  sign-in or extension files Octant hides, such as Kimi. Some older
  distributions install `bwrap` setuid root because they turn off
  unprivileged user namespaces, and a setuid `bwrap` would leave those files
  readable to the runtime. Octant checks the file before each such launch
  and refuses Full access with a message saying why. `ls -l /usr/bin/bwrap`
  shows an `s` in place of the owner's `x` when it is setuid. To fix it,
  enable unprivileged user namespaces (on most distributions the
  `kernel.unprivileged_userns_clone` or `user.max_user_namespaces` sysctl)
  and install the distribution's Bubblewrap without the setuid bit, or use
  approval-gated instead. Other permissions do not depend on how `bwrap` is
  installed and are not refused for it.
- **`lsof`.** Running services and Local servers use it to find the servers
  your projects started. A stock Ubuntu install lacks it; without it the card
  says Octant could not check this computer for local servers.
- **Git 2.36 or later.** Code Projects need a Git repository.
- **A Secret Service session and `secret-tool`**, only for storing provider
  credentials. Without one, `octant status` reports
  `Secret store: unavailable`; Chat, Work, and Code still run, but no stored
  credential is available to a provider.
- **A provider.** Use a provider CLI that keeps its own login (install it under
  `~/.local/bin` and point the provider at that absolute path), or an endpoint
  that needs no key, such as a model server on the same machine. An endpoint
  that needs an API key or bearer token takes it from
  [`octant provider key set`](#save-an-api-key-for-an-endpoint); an Azure AI
  Foundry endpoint that uses your organization account signs in with
  [`octant provider sign-in`](#sign-in-an-organization-endpoint-with-a-code).

`scripts/ade/install-linux-host-deps.sh` installs Bubblewrap, `lsof`,
`secret-tool`, the GNOME keyring, and a recent Git with `sudo`. For a packaged
install, `sudo apt-get install -y bubblewrap lsof` covers the first two;
`octant server install`, `start`, `restart`, and `enable` print which of them
are missing but never install anything. If you install packages
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

## Add Claude API-key accounts

In **Settings → Providers & Models → Add provider manually**, choose
**Claude Agent SDK**, give the account a distinct name, and select
**Anthropic API key**. Add the profile without a key. The browser keeps the
key input disabled; each new profile gets its own managed account directory.
On the host, save the key with `octant provider key set "Profile name"`,
then check the connection in Settings. The saved profile’s Setup section keeps
this command available after creation. Repeat with another name for a second
API-key account. Both accounts run through the official Claude Code CLI.
Subscription sign-in remains a separate official CLI flow.

## Save an API key for an endpoint

A browser cannot save a provider key, not even one running on the host. Add
the endpoint in Settings from the browser without a key, then save its key in
a terminal on the host itself (an SSH session is fine):

```sh
octant provider key set "My gateway"
```

The command prompts for the key and does not echo it. Name the provider by
its display name or its id; if two providers share a name, the command lists
their ids. To read the key from another program or a file instead, give
`--stdin` and send it on standard input (one trailing newline is dropped):

```sh
octant provider key set "My gateway" --stdin < ~/gateway.key
```

The key is never taken as an argument or an environment variable, because
other processes and your shell history can read those.

- `octant provider key status <provider>` says whether a key is stored.
- `octant provider key set <provider> --replace` overwrites a stored key. A
  provider that holds several keys refuses; remove them first.
- `octant provider key remove <provider>` clears the key and leaves the
  provider configured. It also takes the id of a provider you already removed,
  to clear a key it left behind.
- `octant provider remove <provider>` removes the provider and then its
  stored key, so no key is left behind. It refuses for the same reasons
  `key remove` does, and when the provider itself cannot be removed (for
  example it has an active session) the provider and its key stay. If the key
  cannot be cleared after the provider is gone, the command says so and names
  `octant provider key remove <id>`; the server also clears it the next time it
  starts.

Each key change is recorded in the host's journal without the key, so a stop
in the middle of a change is settled at the next start.

The key goes to the running server over its loopback administration session,
which only processes running as your user can open, and the server stores it
in Secret Service. The next connection check or turn uses it without a
restart.

If the server started without Secret Service, the command says
`Nothing was saved: the Octant server has no credential store.` Start and
unlock the keyring (see
[Installation](./installation#headless-linux-for-ade-testing)), then run
`octant server restart` and try again. Octant never falls back to a file or
an environment variable.

## Sign in an organization endpoint with a code

An Azure AI Foundry endpoint that uses
[your organization account](../advanced/providers#azure-ai-foundry-with-your-organization-account)
normally signs in through a browser on the same computer as Octant, which a
headless host does not have. Sign it in with a code instead:

1. In Settings, open the endpoint, turn on **Allow sign-in with a code from
   this host's terminal** under **Name and address**, and save. It is off
   until you turn it on: many organizations block signing in with a code,
   and a code is easier to misuse than a browser sign-in.
2. In a terminal on the host (an SSH session is fine), run:

   ```sh
   octant provider sign-in "Contoso Foundry"
   ```

   The first time, the command shows what the sign-in does and asks you to
   accept.

3. On any device, open the Microsoft page the command names (such as
   `https://microsoft.com/devicelogin`) and enter the code it shows. Enter a
   code only because you just ran the command yourself; never enter one
   someone sent you.
4. The command says who is signed in. If you stop it with Ctrl-C, a sign-in
   you finish before the code runs out (about 15 minutes) still completes.

Your administrator's app registration must also set **Authentication ›
Allow public client flows** to **Yes**; otherwise the command says your
organization refused the sign-in.

An [Amazon Bedrock endpoint](../advanced/providers#amazon-bedrock-with-your-organization-s-single-sign-on)
signs in only this way, with no setting to turn on: run the same command, open
the page it names (on `device.sso.<region>.amazonaws.com` or your
organization's access portal), and enter the code. If the portal does not give
you the endpoint's account and role, the command says so and nothing is
saved. The command needs the same Secret Service
session as `octant provider key set`. A paired device cannot run it or start
a sign-in, and the browser's Settings never shows a code.

## Pair a laptop over Tailscale

The shortest path is one command on the Linux machine,
`octant server install --artifact <directory> --pair` (or
`octant server start --pair` from a checkout), which turns the listener on at
the machine's Tailscale address with a certificate Octant makes, prints a
pairing code, and asks you to approve the device. See
[Add a computer in one step](../advanced/remote-access#add-a-computer-in-one-step)
for what it does and its limits. The steps below are the browser path, which
needs a Tailscale certificate.

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
| Terminals and other Full-access tools from `octant agent` | `octant agent` opens Code threads approval-gated, so the tool answers `This tool needs Full access for the thread.` Remembered Full access (`octant project access <name> full-access`) applies to threads that ask for it. |
| Raising a thread to Full access from a paired device      | Refused: Full access is chosen in an Octant window on this host.                                                                                                                                                            |
| Browser tool from `octant agent`                          | The site approval is not shown in the terminal, so the turn waits.                                                                                                                                                          |
| Apple and Xcode tools                                     | Unavailable on Linux.                                                                                                                                                                                                       |
