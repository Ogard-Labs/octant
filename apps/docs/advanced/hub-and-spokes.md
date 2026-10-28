---
description: Turn one Octant computer into a hub, add your other devices, and join a hub from a laptop, over Tailscale, a similar private network, or your home network.
---

# Hub and spokes

A hub is one Octant computer that keeps a list of your own devices. The other
computers that join it are spokes. Use it when you run Octant on more than one
machine, for example a Mac mini at home and a laptop.

Everything here is off until you turn it on. Nothing changes on a computer
until you act on it.

## What a hub is

- The hub is an ordinary Octant host with one extra role.
- It keeps the roster: the list of members and who is an owner.
- A computer that joins a hub is a spoke. The spoke stays in charge of its own
  threads, Projects, files, sign-ins, sandbox, and approvals. The hub cannot
  change any of those.
- A spoke joins one hub at a time.

## Where it works

The hub works only over Tailscale, a similar private network, or the same home
or office network (LAN). It never works over the open internet.

- The hub needs the remote listener turned on, on a Tailscale or private LAN
  address. Octant refuses a public address.
- The listener must use the certificate Octant makes itself, which you get by
  turning it on without a certificate and key. The join code carries that
  certificate's fingerprint, so the other computer can check it is talking to the
  hub. A listener that uses a pasted certificate is refused.
- A computer that joins also needs its own remote listener running the same way,
  so the hub can check it too.
- Joining never goes through a relay.

See [Remote Access](/advanced/remote-access) for turning on the listener.

## Turn on the hub

In the desktop app on the hub computer:

1. Open **Settings → Remote access**.
2. Check that the remote listener is on.
3. Turn on **Act as hub**.

If Octant cannot turn it on, it says why in one sentence, for example that the
listener is off or is not on a private address.

From a shell on the hub computer:

```sh
octant hub enable
```

On macOS and Linux the hub should start at boot with no one logged in. That
needs one administrator step:

- `octant hub enable` prints the one command to run. Run it yourself, and enter
  your administrator password when asked.
- Or run `octant hub enable --install-service`. Octant then runs that one
  command for you and you enter the password.
- Octant never runs an administrator command unless you pass
  `--install-service`.
- On macOS the boot service is a launch daemon. On Linux it is a systemd user
  service with lingering turned on.
- On macOS, `octant hub enable` also prints `sudo pmset -a autorestart 1`. Run it
  if you want the computer to start again after a power cut.

The hub keeps its keys in a file in the Octant data folder that only your
account can read. That is safe only on an encrypted disk. If the disk is not
encrypted, `octant hub enable` warns you. Turn on FileVault on macOS or use LUKS
on Linux.

A disk that asks for a password at start-up waits for you after a power cut.
Until you unlock it, the hub is down.

The hub role is not available on Windows yet.

To turn it off, use the switch again, or run `octant hub disable`. To go back to
the ordinary login service, run the command it prints, or run
`octant hub disable --remove-service`.

## Add a device

On the hub, under **Add a device**:

1. Choose whether the device that joins is an owner. Leave it off for an
   ordinary device.
2. Choose **Make a join code**.
3. Octant shows the code as a QR code and as text, with the time left. The code
   works once and expires after a few minutes.
4. The other device joins with the code (next section).
5. The device's request appears with a short comparison code. If it matches the
   code on the other device, choose **Approve**. If not, choose **Deny**.

From a shell on the hub:

```sh
octant hub join-code
```

Add `--owner` to make the device that joins an owner.

## Join a hub from a laptop

Turn on the laptop's remote listener first. Then, under **Settings → Remote
access → Join a hub**:

1. Paste the join code and choose **Join the hub**.
2. Octant shows the hub's name and a comparison code. Check that it matches the
   one on the hub. Then approve on the hub.
3. The **hub grant** screen opens. It lists what the hub may do on this laptop.
   Choose the items and select **Accept**.

From a shell on the laptop:

```sh
octant hub join <code>
```

The shell shows the same comparison code and asks whether to keep the default
grant. Pass `--items roster,introduce` to choose items without a question, or
`--items none` for none.

## The hub grant

The grant is a closed list. You can change every item, at any time, on the
spoke. Only the spoke can change it.

| Item      | What it lets the hub do                                                                   |
| --------- | ----------------------------------------------------------------------------------------- |
| Roster    | Send this computer the hub's signed list of members. On by default.                       |
| Introduce | Introduce other members to this computer. Each becomes a full member here. On by default. |
| Owners    | Let your owner devices act here after a fresh unlock. On by default.                      |
| Status    | Read this computer's resources, thread titles and states, and waiting approvals.          |
| Wake      | Hold this computer's routine wake times and wake it.                                      |
| Standby   | Let a standby hub you named use this grant.                                               |
| Push      | Send this computer's phone notifications through the hub.                                 |
| Provision | Offer settings as proposals that you apply.                                               |
| Act       | Act here as a paired device would, in Projects you name.                                  |

Ticking an item records your choice. In this release the hub can use only
Roster and Status. The other items, including Introduce and Owners, do nothing
yet, because the features behind them are not available yet.

Whatever you tick, the computer keeps its files, sign-ins, sandbox, and every
approval.

To change the grant later, open **Settings → Remote access → Join a hub**, or
run `octant hub grant --items <list>`. `octant hub grant` on its own shows the
current grant.

## Leave a hub and remove a device

**Leave** is done on the spoke. In **Settings → Remote access → Join a hub**,
choose **Leave the hub** and confirm. Or run `octant hub leave`. The hub is told
when it can be reached and drops the computer from its roster. If the hub is
down, remove the computer from the roster there. Your threads, Projects, and
sign-ins stay as they are.

**Remove** is done on the hub. Under **Members**, choose **Remove** next to a
device and confirm. Or run `octant hub remove <name or id>`. List the members
with `octant hub status`.

## If something goes wrong

| Situation               | What you do                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add a new laptop        | Make a join code on the hub. Join from the laptop. Compare the short code and approve on the hub.                                                            |
| Lose a laptop           | On the hub, remove it. Other spokes drop what they held for it at the next roster.                                                                           |
| Lose every owner device | Sit at any computer, or reach the hub over SSH on the private network. Run `octant hub join-code --owner`. The device that joins with that code is an owner. |

These are not available yet: using owner devices to administer a hub, a standby
hub that takes over when the hub is down, and alerts about members you did not
add. If the hub is down or lost, each computer keeps working on its own. Join the
computers to a new hub from each one.

## Next steps

- [Remote Access](/advanced/remote-access) for the listener and pairing
- [Privacy and security](/advanced/privacy-and-security) for the broader security model
