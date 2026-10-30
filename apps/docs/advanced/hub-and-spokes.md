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
passkey, because its window already has the computer's authority.

To join from a browser, open the hub's web app at its tailnet name, then go to
**Settings → Remote access → Hub**. Paste the hub's join code, compare the short
code with the one the hub shows, and approve there. For an owner code, tick **This
is an owner code**: the browser makes a passkey for that address first and sends
only its public key. If the browser cannot make a passkey, the box stays off and
it can join only as a plain guest. If you cancel the passkey, nothing is sent to
the hub. **Leave the hub** forgets the hub on this browser; remove the browser on
the hub too.

A browser reaches only the address that served its page and the tailnet names the
hub's roster lists for its computers, and it checks each one's certificate itself.
After you join, the hub's page lists the computers on the hub. A computer that has
a tailnet name and its Tailscale certificate on gets an **Open** link to its own
web app and a **Connect** button, which asks that computer directly (not through
the hub) to know this browser. A computer you have not set to accept new guests
refuses it, and says so.

A browser that joined as an owner also sees each computer's new-member alerts on
the hub's page. To confirm, dismiss, or remove, open that computer's own page,
because a passkey works for only one address. None of this has been tried against
a real hub yet.

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
software keys. A phone with Face ID or a fingerprint, a real passkey (none has been
run, in a browser or anywhere else), and Android have not been tried. Expect rough edges the first time you use them.

## The hub grant

The grant is a closed list. You can change every item, at any time, on the
spoke. Only the spoke can change it.

| Item      | What it lets the hub do                                                                   |
| --------- | ----------------------------------------------------------------------------------------- |
| Roster    | Send this computer the hub's signed list of members. On by default.                       |
| Introduce | Introduce other members to this computer. Each becomes a full member here. On by default. |
| Owners    | Let your owner devices act here after a fresh unlock. On by default.                      |
| Status    | Read this computer's resources, thread titles and states, and waiting approvals.          |
| Wake      | Hold this computer's routine times and wake it before one is due.                         |
| Standby   | Let a standby hub you named take over the roster while the hub is down.                   |
| Push      | Send this computer's phone notifications through the hub.                                 |
| Provision | Offer settings as proposals that you apply.                                               |
| Sign-in   | Ask you to sign in to a Claude or Codex account here. Nothing starts until you accept.    |
| Act       | Act here as a paired device would, in Projects you name.                                  |

Ticking an item records your choice. In this release the hub can use only
Roster, Status, Wake, Push, Provision, and Sign-in. Wake works only once you turn on the
hub's wake service (see [Wake a sleeping computer](#wake-a-sleeping-computer)).
Push works only once you turn on the hub's push sender (see
[Send phone notifications through the hub](#send-phone-notifications-through-the-hub)).
Provision works only once you turn on the hub's offers (see
[Offer settings from the hub](#offer-settings-from-the-hub)). Sign-in works for a
request from the hub's window or your owner device (see
[Ask a computer to sign in](#ask-a-computer-to-sign-in)). Owners works for your own owner devices (see
[Owner devices](#owner-devices)). Introduce makes this computer accept the other
spokes and your phones as full members (see
[Delegate work to another computer](#delegate-work-to-another-computer)).
Standby lets a standby hub you named act here while the hub is down (see
[If the hub goes down](#if-the-hub-goes-down)). Act does nothing yet, because the
feature behind it is not available yet.

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
request or one that names a provider profile is refused.

An agent in a Work thread can ask for a helper on another computer by naming that
member and the Project to use there. Each computer has its own Project ids, so
you give the agent the id from the other computer. It sends a task and nothing
else: no model, no earlier helpers to wait on, and none of the thread's
conversation. The work asks before each edit, and never
runs above the thread's own access or the other computer's grant. If the thread
has no hub, the member is unknown, the other computer has not granted it, or the
thread is paused, the agent is told the request was refused. Reading the result
and cancelling one request still go through the local administration channel on
the asking computer.

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
standby order is cleared. A computer where you ticked **Standby** follows the new
hub by itself once the old hub has been out of reach for the failover time, and
keeps exactly the permissions it gave the old hub. On each other computer, run
`octant hub accept-hub <name of the new hub>` in its own window. A computer
asks the new hub over the connection it already trusted for that standby, and
accepts it only if it answers as that standby with a list that includes the
computer. Phones that joined as guests join the new hub again with a new code.

A standby also holds a copy of the wake times (see
[Wake a sleeping computer](#wake-a-sleeping-computer)). While it stands in, it
wakes the computers that ticked both **Wake** and **Standby**, takes their new
routine times, and hands those back to the hub with the rest.

A standby also forwards phone notifications while it stands in (see
[Send phone notifications through the hub](#send-phone-notifications-through-the-hub)),
for the computers that ticked both **Push** and **Standby**, and only while they
cannot reach the hub.

## Wake a sleeping computer

Routines run only while their computer is awake. The hub can wake a computer
just before one of its routines is due. This is off until you turn it on, and a
computer takes part only if its own person ticked **Wake**.

**Turn it on (the hub).** On the computer that is the hub, open **Settings →
Remote access → Wake service** and switch it on, or run `octant hub wake on`.
`octant hub wake off` turns it off and the hub forgets every time it held. Only
the hub's own window changes this.

**Take part (a spoke).** Tick **Wake** in the spoke's hub grant (see
[The hub grant](#the-hub-grant)). The spoke then tells the hub, for each enabled
routine, when it next runs, under a random id the spoke made up. That is all:
never the routine's prompt, Project, profile, name, or schedule. The spoke sends
a new list when a time changes, and a routine you pause or delete drops out of
it. Unticking Wake withdraws the list.

**Wake-on-LAN (optional).** If you also want the hub to send a Wake-on-LAN magic
packet on your home network, enter the computer's hardware (MAC) address under
**Settings → Remote access → Join a hub**, on that computer. The address goes to
the hub only while Wake is ticked, and only if you entered it. Without it the hub
sends only the message over your private network, which reaches a computer that
is awake but idle. On a Mac, turn on **Wake for network access** in Energy
settings for the packet to work.

**What happens.**

- A couple of minutes before a routine is due, the hub wakes the computer: the
  magic packet if you entered an address, and a signed message to its listener.
- The message names only the random id and the time. The computer acts on it
  only if the id is one of its routines, the time is that routine's own next
  time, and its grant still ticks Wake. Otherwise it does nothing and says why.
- When it believes the message, the computer only makes sure its own scheduler is
  awake. The scheduler runs the routine at its time under that routine's own
  rules, and a missed time follows the routine's missed-run setting. The hub
  never tells a computer to run anything.
- If neither the packet nor the message gets through, the hub records the time as
  unreachable. The computer settles it when it is back, under its missed-run
  setting.

`octant hub status` and the hub's **Wake service** section show, for each
computer, how many wakes are ahead and how the last one went.

A machine that is powered off, away from home, or not set to wake cannot be
woken. A real Wake-on-LAN wake of a sleeping Mac has not been tried yet.

## Send phone notifications through the hub

A computer sends phone notifications through the push gateway named in its own
**Settings › Notifications › Phone notifications** (see
[Remote Access](/advanced/remote-access#phone-notifications)). With the
hub's push sender, a spoke can hand its notifications to the hub, and the hub
passes them on. This is off until you turn it on, and a computer takes part only
if its own person ticked **Push**.

**Turn it on (the hub).** On the computer that is the hub, open **Settings →
Remote access → Push sender** and switch it on, or run `octant hub push on`.
`octant hub push off` turns it off. Only the hub's own window changes this. The
hub forwards only to the gateway in its own **Notifications** setting, so turn
phone notifications on there too, or the hub refuses every request.

**Take part (a spoke).** Tick **Push** in the spoke's hub grant (see
[The hub grant](#the-hub-grant)).

**What happens.**

- The spoke seals each notification to your phone's key and signs the delivery
  request with its own key, exactly as it would to send it itself. It hands that
  request to the hub instead of calling the gateway.
- The hub checks that the sender is a spoke in its list, that its own switch is
  on, and that the request is small and not too frequent. Then it asks the spoke
  whether its grant still ticks Push, and only if the spoke says so does it pass
  the request to the gateway, unchanged. It never signs for the spoke, never opens
  the content (it has no key to), and keeps nothing of the request afterwards.
- The gateway's answer goes back to the spoke, which treats it as if it had sent
  the request itself.
- If the hub cannot be reached, or refuses, the spoke sends to the gateway itself
  when its own **Notifications** setting allows it. Otherwise the notification is
  reported as not sent.
- While a standby stands in, it forwards for the computers that ticked both
  **Push** and **Standby**, and only while those computers cannot reach the hub.
  It uses the gateway in its own **Notifications** setting, and only if the hub's
  push sender was on.

`octant hub status` and the hub's **Push sender** section show, for each
computer, how many notifications the hub forwarded and refused and how the last
one went. The hub's journal records which computer, how large, and why a request
was refused, never what was in it.

By default the hub passes notifications to the push gateway only. It sends to
Apple and Google itself only if you build the phone app yourself and turn on
direct sending, below. A delivery to a real phone through the hub has not been
tried yet.

### Send notifications directly (your own phone app)

If you build the phone app yourself, with your own Apple Developer and Firebase
accounts, your hub can be that phone's push gateway, so nothing goes through an
Octant-run service. The store build of the phone app cannot use this: only the
account that signs an app can send notifications to it.

1. Build the app with your own bundle identifier and the Push Notifications
   capability, add your Firebase project's `google-services.json` for Android, and
   set the app's push gateway address to your hub's private address. The steps are
   in [Building the phone app yourself](https://github.com/Ogard-Labs/octant/blob/main/docs/design/mobile-maturity.md#building-the-phone-app-yourself).
2. On the hub, open **Settings → Remote access → Send notifications directly**.
   Enter your Apple key ID, team ID, bundle ID and the `.p8` key, and paste your
   Firebase service-account JSON. Settings then says **Stored**. It never shows a
   key again.
3. Turn on **Development build** if you installed the app straight from Xcode.
   Leave it off for TestFlight and App Store builds.
4. Switch on **Send notifications directly**. It is off by default.

Only the hub's own window changes any of this. Phones reach the hub over your
private network only, and while the switch is off the hub answers that
notifications are unavailable. The hub calls Apple and Google with your
credentials, and nobody else; what it sends is the same sealed notification the
gateway would get, which only your phone can read. A computer that ticked
**Push** hands its notifications to the hub as before, and the hub delivers them
itself. A delivery to a real phone this way has not been tried yet.

## Offer settings from the hub

The hub can offer its spokes a piece of configuration. An offer is only data. It
lands on a spoke as a **proposal** that the spoke's own person applies or
dismisses. Nothing arrives trusted or switched on, and no offer carries a key.
This is off until you turn it on, and a computer takes part only if its own
person ticked **Provision**.

**Turn it on (the hub).** On the hub, open **Settings → Remote access → Offers**
and switch it on, or run `octant hub provision on`. `octant hub provision off`
turns it off and forgets the offers the hub held. Only the hub's own window makes
offers.

**Make an offer (the hub).** Settings offers the stable or preview update channel.
`octant hub offer` offers every kind:

| Kind           | Command                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| Update channel | `octant hub offer update-channel stable\|preview [--mirror <signed-feed.json>]` |
| Plugin         | `octant hub offer plugin <catalog-id> <entry-id> <sha256:digest>`               |
| Agent profile  | `octant hub offer agent-profile <fields.json>`                                  |
| Model endpoint | `octant hub offer model-endpoint <fields.json>`                                 |
| Routine        | `octant hub offer routine <fields.json>`                                        |

`octant hub offer-withdraw <offer-id>` withdraws one. A profile, endpoint, or
routine file holds the fields of the offer and nothing else. An endpoint has no
field for a key, and Octant refuses any offer with a field it does not define, an
address with a name, password, or query in it, or text that looks like a key.

**Take part (a spoke).** Tick **Provision** in the spoke's hub grant (see
[The hub grant](#the-hub-grant)). Each offer then appears under **Settings →
Remote access → Join a hub → Offers from the hub**, or in `octant hub status`.
Choose **Apply** or **Dismiss**, or run `octant hub apply <offer-id>` or
`octant hub dismiss <offer-id>`. A proposal lapses after a week, and a computer
holds at most 32.

**What applying does.** It uses the same service you would use yourself:

- **Update channel.** The computer follows the stable or preview channel. It
  never moves to the candidate channel on an offer. If the hub mirrors the signed
  feed, the computer fetches that copy and checks the feed's own signature against
  the release keys this build trusts. Bytes the hub changed, or signed itself,
  fail that check and nothing changes.
- **Plugin.** The package is fetched and checked the ordinary way and installed.
  It arrives untrusted and switched off. You trust and enable it yourself.
- **Agent profile.** It is added without a secret. A profile that asks for Full
  access or a remembered permission is refused.
- **Model endpoint.** The row is added switched off and without a key. Add the key
  from the endpoint's own page.
- **Routine.** It waits for you, always. You choose its Project, and it is made by
  this computer under its own limits, as a routine you wrote would be. Apply it
  with `octant hub apply <offer-id> --project <project-id>`. It must be a Work
  Project. The routine is made paused, with approval-gated Work authority and
  Work's default model, so it does nothing until you resume it in Automation
  Center. A Code routine is not accepted yet.

**Apply on arrival (a spoke).** Each of these is off until you turn it on:
update channel, plugin install (untrusted and off), and agent profile. Turn them
on under **Offers from the hub**, or run `octant hub auto-apply <kind> on|off`.
It does exactly what **Apply** does and never more. A routine and a model
endpoint always wait for you.

The journal records each offer made, proposed, applied (by whom, and whether you
or the standing choice did), dismissed, and refused, with the reason. It never
holds an offer's text.

This computer applies a routine only where it can build one itself. In this
release it cannot, so a routine proposal can be read and dismissed but not
applied yet.

## Ask a computer to sign in

A Claude or Codex account sign-in belongs to the computer that holds it. Octant
never copies one, because these sign-ins refresh themselves and a copy would log
the original out. Instead, the hub can ask a computer to sign in on its own. Nothing
is sent to the hub except one word at the end, and no code, link, or account name
leaves the computer.

**Ask (the hub).** On the hub, open **Settings → Remote access → Hub**, find the
computer under **Members**, and choose **Ask to sign in**. Then choose the Claude
account or the Codex account. You can do this from the hub's window, or from an owner
device that is unlocked. Phones that joined as guests cannot be asked. The member's
row then shows one word: waiting for its person, signed in, declined, expired, or
failed. If the computer refused, the row says why in plain words.

**Take part (a computer).** Tick **Sign-in** in the hub grant (see
[The hub grant](#the-hub-grant)). It is off by default. A request then appears under
**Settings → Remote access → Join a hub → Sign-in requests from the hub**. Nothing
starts until you choose **Accept** in this computer's own window, or on this
computer's own owner device after an unlock. The hub cannot accept for you.

**Finish the sign-in.** After you accept, Octant shows the provider's own sign-in
command, for example `claude auth login` or `codex login`. Run it in a terminal on
this computer and finish the sign-in there. Any code or link the provider prints
stays in that terminal. Then choose **Check sign-in**. Octant looks only at whether
the provider's own app is now signed in, and tells the hub the result. **Decline**
turns the request down.

A computer refuses a request, and tells the hub why, when:

- Sign-in is not ticked in the grant.
- It has no such account to sign in to. Add the Claude or Codex provider first.
- The account is already signed in.
- A request for that account is already waiting.
- The hub already asked three times this hour.

A request lapses ten minutes after it arrives, and the hub is told it expired. The
journal on the computer records the request, your answer, and how it ended, and
never a token, code, link, or account name. A real Claude or Codex sign-in started
this way on a second computer has not been tried yet.

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

Claude and Codex account sign-ins are never copied between computers; ask the
computer to sign in instead (see [Ask a computer to sign in](#ask-a-computer-to-sign-in)).
Posture changes from an owner device are not available yet. With no standby, a computer whose hub is down or lost keeps
working on its own. Join the computers to a new hub from each one.

## Next steps

- [Remote Access](/advanced/remote-access) for the listener and pairing
- [Privacy and security](/advanced/privacy-and-security) for the broader security model
