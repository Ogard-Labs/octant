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

## Join a phone as a guest

A phone joins as a guest, not as a spoke. A guest runs no agents, has no files or
Projects of its own, and receives no delegated work. It opens each computer on
the hub the way an ordinary paired phone would.

1. On the hub, make a join code (**Add a device**).
2. On the phone, open **Add computer**. Under **Join a hub as a guest**, scan the
   hub's QR code or paste the code, then choose **Join the hub**.
3. The phone shows a comparison code. Check that it matches the one on the hub,
   then approve on the hub.
4. The phone asks each computer on the hub to let it in. Every computer that
   does appears in the phone's list of computers, ready to open. A computer that
   does not shows as **Not accepted on that computer**. There is nothing to do on
   the phone for it: the choice is made on that computer.

Each computer decides for itself. A spoke lets a guest in only if its hub grant
has **Introduce** ticked and it accepted the guest from the hub's signed roster.
The phone talks to each computer directly. Nothing a phone does on a computer
passes through the hub.

When the app opens, the phone asks the hub for its roster again. A computer that
left the hub disappears from the phone's list, and a computer that joined is
asked to let the phone in. If the hub is not reachable, the phone keeps what it
has. If the hub removed the phone, the computers added through it are removed.

A guest can do what a paired phone can do on each computer it was let into: read
threads, answer approvals, and start work there, within what that computer
allows. It cannot change the hub, the roster, or any computer's grant, and you can
revoke it on any computer.

This has not been tried on a real phone yet. It is built and tested without one,
so expect rough edges the first time you use it on a device.

## Open the web app from a browser on your tailnet

The hub's listener serves the same web app as the desktop window, so a laptop or
phone with no Octant installed can open it in a browser on your tailnet. A
browser cannot check the certificate fingerprint the apps use, so it needs a
certificate it already trusts. Tailscale can supply one.

Turn it on under **Settings → Remote access → Tailscale certificate**, or run:

```sh
octant hub certificate --enable --acknowledge-transparency
```

It is off by default, and the switch stays off until you tick that you read the
note below.

**What you should know first.** Tailscale gets this certificate from a public
authority. Public authorities publish every certificate they issue in open logs
(certificate transparency). This computer's tailnet name, for example
`mini.tail1234.ts.net`, will appear in those logs for anyone to read. The logs
show the name, not your traffic.

You also need HTTPS turned on for your tailnet in the Tailscale admin console,
and Tailscale installed and signed in on this computer. Octant runs the
`tailscale` command on this computer to ask for the certificate. If it cannot,
it says which of these is missing.

`octant hub certificate --status` shows whether it is on, the name, and whether
a renewal is due. `octant hub certificate --disable` turns it off.

Octant asks for a new certificate before the old one expires. Each new
certificate, and turning the option on or off, briefly restarts the remote
listener.

The listener keeps the certificate Octant made and serves the Tailscale one only
to a browser that opens this computer's tailnet name. The phone app, the desktop
apps, and the other computers on the hub still see the original certificate and
the same fingerprint, so nothing they hold changes. If Tailscale hands over a
certificate that does not check out, Octant does not install it and the
listener keeps serving the original.

## Owner devices

An owner device is one of your own devices that can do from afar what you could
do at a computer's window, for example remove a member or change who else is an
owner. It can do this only right after you prove you are there.

**Each computer keeps its own owner list.** The hub's roster shows which
members are owners and carries each owner's unlock key. But the roster never
makes anyone an owner on a computer. A computer lists only the owners you
confirmed on it.

**How a device becomes an owner**

- On the hub: make the join code with **The device that joins is an owner of
  this hub** ticked, or run `octant hub join-code --owner`. The device that joins
  with that code is the hub's first owner. A phone shows a switch, **This is an
  owner code**, before it joins. Turn it on for an owner code.
- On a spoke: when the spoke joins with **Owners** ticked, open **Settings →
  Remote access** on that spoke. Under **Owner devices** it lists the hub's owner
  devices by name, device key fingerprint, and unlock key fingerprint. You paste
  nothing. Check that the name and both fingerprints match what the device shows,
  and choose **Add**. The hub cannot add an owner to a spoke.
- Later: add or remove owners in that computer's own window the same way.
- If the roster later lists a different unlock key for an owner you already
  added, the spoke keeps the key you confirmed and shows a warning. To accept the
  new key, remove that owner and add it again.

**The unlock.** Every change an owner device makes asks you to unlock first, with
Face ID, a fingerprint, your passcode, or a passkey. One unlock covers one
action, for at most 60 seconds. A second action asks again. An unlock that was
used, that ran out, or that was for a different action is refused, and the
screen says so in plain words. If you cancel the unlock, nothing changes.

**Phone.** The phone makes an unlock key when it joins with an owner code. Its
private half is kept only in the phone's secure storage and opens only after you
unlock. This is a narrower protection than a hardware key: the key is not bound
to the phone's secure chip, and it is in memory while one action runs. Confirming
a member asks you once. The phone drops the key when the action ends.

**Browser.** A browser on your tailnet that joined as an owner uses a passkey as
its unlock key, one passkey for each computer address it uses. A browser without
a built-in authenticator cannot be an owner. The desktop app never offers a
passkey, because its window already has the computer's authority. A browser
screen to join a hub is not built yet.

An agent, a routine, the hub, a standby hub, and another computer can never
unlock. Joining a spoke to a hub still happens on that spoke.

### Confirm new members and alerts

Under **Settings → Remote access → New members**, a spoke has **Confirm new
members**. It is off by default. With it on, a member the hub adds later can only
read status on that spoke until you confirm it, in that spoke's window or on an
owner device. **Confirm** shows only for a member the spoke is holding this way.

Every spoke also keeps an alert for each member a newer roster adds, whether or
not Confirm new members is on. The hub cannot hide or write one. An alert shows
the member's name and key fingerprint. In a window you can choose **Dismiss**,
**Remove** (this spoke drops what it gave that member and refuses it), or
**Confirm** for a member held until confirmed. An owner phone shows the same
alerts under **Owner alerts**, with **Remove**, **Confirm**, and **Dismiss**, each
asking for the unlock first. If you did not add the member, choose **Remove**,
then check the hub: a member nobody added may mean the hub is not safe.

Confirming a member signs a note with the unlock key. A passkey can sign it too.
A passkey asks twice: once for the note, once for the action. A phone asks once.

**Not checked on real hardware.** The owner features are built and tested with
software keys. A phone with Face ID or a fingerprint, a real passkey, and
Android have not been tried. Expect rough edges the first time you use them.

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
| Standby   | Let a standby hub you named take over the roster while the hub is down.                   |
| Push      | Send this computer's phone notifications through the hub.                                 |
| Provision | Offer settings as proposals that you apply.                                               |
| Act       | Act here as a paired device would, in Projects you name.                                  |

Ticking an item records your choice. In this release the hub can use only
Roster and Status. Owners works for your own owner devices (see
[Owner devices](#owner-devices)). Introduce makes this computer accept the other
spokes and your phones as full members (see
[Delegate work to another computer](#delegate-work-to-another-computer)).
Standby lets a standby hub you named act here while the hub is down (see
[If the hub goes down](#if-the-hub-goes-down)). The other items do nothing yet,
because the features behind them are not available yet.

Whatever you tick, the computer keeps its files, sign-ins, sandbox, and every
approval.

To change the grant later, open **Settings → Remote access → Join a hub**, or
run `octant hub grant --items <list>`. `octant hub grant` on its own shows the
current grant.

## Delegate work to another computer

A thread on one spoke can hand a piece of work to another spoke and get the
result back. Nothing is delegated until a thread asks for it.

- **The asking computer checks first.** The thread must be allowed to start
  helpers. The work runs in the same mode as the thread, with no more access than
  the thread has. A thread that already read outside content cannot start
  helpers.
- **The other computer decides.** It accepts a request only from a spoke in the
  roster it holds, signed with that spoke's key. Each member it accepts gets a
  peer grant. A new full member may hand work to every Project there, asking
  before each edit, and never at Full access. A request for more than the grant
  or the Project allows is refused, not run as something smaller. The hub and
  phones cannot hand work over at all.
- **The work is an ordinary thread there.** In Work, it appears in that
  computer's sidebar and board, runs in the Project folder, and uses that
  computer's sign-ins. No sign-in travels with the request.
- **Approvals stay there.** Every approval the work raises goes to that
  computer's own windows and to members it lets answer. The computer that asked
  and the hub cannot answer them, and cannot mark the thread Done. Only you can,
  on that computer.
- **The result comes back as data.** The asking thread gets the summary, the final
  message, and any artifact references, framed as outside content, and the thread
  is marked as having read it. Nothing in it is treated as an instruction.
- **Cancel.** Cancelling the asking thread asks the other computer to stop the
  work.

In this release only Work Projects take delegated work; a Code Project refuses
it. Work runs on the default model that computer's Work settings name. A plan-only
request or one that names a provider profile is refused. An agent's helper
request does not carry a target computer yet: you start, read, and cancel a
delegation through the local administration channel on the asking computer.

## If the hub goes down

You can name one or more spokes as **standby hubs**. A standby keeps the hub's
list of members current, and takes over that list while the hub is away. It is
off until you name one.

**Name a standby.** On the computer that is the hub, open **Settings → Remote
access → Standby hubs**, add the computer, put the standbys in the order you
want, and choose **Save the standby order**. Or run
`octant hub standby <name or id> ...`, and `octant hub standby --clear` to name
none. `octant hub standby` on its own shows the order. Only the hub's own window
changes the order. A standby can never change it, and cannot promote itself.

The computer you name must have **Standby** ticked in its own hub grant (see
[The hub grant](#the-hub-grant)). Octant asks it when you save, and refuses the
order if its person has not ticked it. A standby acts on a computer only where
that computer ticked Standby.

**What happens when the hub is away.**

- A computer that cannot reach the hub for five minutes tries the first
  standby, then the next.
- A standby that has seen no hub for those five minutes starts standing in. It
  tells the members, and shows **Standing in for the hub** in its Settings and in
  `octant hub status`.
- A computer takes a roster from a standby only while it cannot reach the hub,
  only from a standby the hub named, and only if its own hub grant ticked
  Standby. A standby cannot change the standby order in it.
- While it stands in, the standby can add and remove members. For a new
  computer, run `octant hub stand-in join-code` on the standby, join as usual
  with that code, and compare the short code. To remove a member, run
  `octant hub stand-in remove <name or id>`. A standby that is standing in cannot
  remove the hub or another standby.
- Approvals and window powers on every computer keep working, because they never
  went through the hub.

**When the hub comes back.** The standby sees it, hands its additions and
removals back, and stops standing in. The hub signs a new list that includes
them. If a member was removed on either side, it stays removed. Members return
to the hub. If the network was split and both were reachable, the only duplicated
work is a repeated roster; neither can start work on a computer, because each
computer decides for itself.

**If the hub is lost for good.** On the standby's own window, choose **Make this
computer the hub…** under **Join a hub**, and confirm. Or run
`octant hub promote --confirm` on it. The old hub leaves the list and the
standby order is cleared. Nothing follows by itself: on each other computer,
run `octant hub accept-hub <name of the new hub>` in its own window. A computer
asks the new hub over the connection it already trusted for that standby, and
accepts it only if it answers as that standby with a list that includes the
computer. Phones that joined as guests join the new hub again with a new code.

Not available yet: waking sleeping computers, which a standby will take over
with the wake times when that feature arrives.

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

| Situation                               | What you do                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a new laptop                        | Make a join code on the hub. Join from the laptop. Compare the short code and approve on the hub.                                                                               |
| Lose a laptop                           | On the hub, remove it. Other spokes drop what they held for it at the next roster.                                                                                              |
| Lose the phone                          | In a window on the hub or a spoke, or on another owner device, remove the phone: as a member on the hub, and as an owner on each computer. Join a new phone with an owner code. |
| Lose every owner device                 | Sit at any computer, or reach the hub over SSH on the private network. Run `octant hub join-code --owner`. The device that joins with that code is an owner.                    |
| An alert shows a member you did not add | Choose **Remove** in the alert, in a window or on an owner device, then check the hub.                                                                                          |
| The hub is down                         | Members switch to the standby you named after five minutes. Nothing to do. When the hub is back, they return. See [If the hub goes down](#if-the-hub-goes-down).                |
| The hub is lost for good                | On the standby's own window, make it the hub. On each other computer, accept it in its own window.                                                                              |

A thief who has the phone but not your face, finger, or passcode has only the
powers of an ordinary member until you remove it.

These are not available yet: sign-in copy between computers and posture changes
from an owner device. With no standby, a computer whose hub is down or lost keeps
working on its own. Join the computers to a new hub from each one.

## Next steps

- [Remote Access](/advanced/remote-access) for the listener and pairing
- [Privacy and security](/advanced/privacy-and-security) for the broader security model
