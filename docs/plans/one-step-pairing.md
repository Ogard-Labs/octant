# One-step pairing with a self-made listener certificate

**Status: approved by the maintainer on 2026-10-14; slices 1 and 2 are built,
the rest is not.** Nothing else here is in force. [Architecture](../architecture.md)
holds only the rules that are true today, and each slice below moves its rules
there when it lands; the host certificate's key, storage, renewal, pin format,
and status fields, and the pairing code's format, QR code, and reading rules,
are already there. Today the host can serve a certificate it makes itself and
show a pairing code that pins it, but no client reads the code or pins the
key, so a client reaches only a listener that
serves a certificate the person brings, and a second, always-on computer first
needs a Tailscale certificate or the person's own certificate authority. This plan lets
the host make its own certificate and has the pairing code carry a fingerprint
of its key, which Octant's own clients pin, so adding a computer takes one
command there and one approval. It does not authorize merging or releasing
anything.

## Design

- **What stays.** No public ingress, no relay, and no Octant-operated
  service. The listener stays HTTPS-only and binds only a private LAN or
  Tailscale address under the same address classifier. Pairing stays a
  single-use ticket approved on the host, and every request still carries
  the device-key proof, replay nonce, CSRF value, and exact-origin checks.
  The pin is checked before any of those and replaces none of them.
  Listener, pairing, and key administration stay on the loopback
  administration channel. Revocation is unchanged: revoking a device bumps
  its generation and ends its sessions and streams, whatever certificate the
  listener serves.
- **Why the pin is required, not optional.** Today the certificate is the
  only thing that authenticates the host on first contact. The host hello
  names the host identity key's fingerprint and carries a signature, but a
  client holds no public key to check that signature against: it records the
  fingerprint as the host states it at pairing and compares it on later
  connections. A self-made certificate without a pin would leave first
  contact unauthenticated, so the self-made path exists only together with
  a pin.
- **Settings.** Settings makes the PEM fields optional behind "Use my own
  certificate"; enabling with none uses the self-made certificate, as the
  administration route and `octant listener enable` already do.
- **Pin prefix.** The pin's `sha256-` prefix names the algorithm: a client
  refuses a prefix it does not know rather than skipping the check.
- **Pairing code and QR code.** For a self-made listener the host mints an
  app pairing code, `octant-pair-1.<payload>`, where the payload is the
  unpadded base64url of a JSON object holding the listener origin, ticket
  id, ticket proof, and pin. It deliberately has no URL scheme, so no
  operating system hands it to an app: an unrelated app that registers a
  scheme cannot receive the ticket. The QR code encodes the same text. The
  Octant app reads it only from its own QR scanner or its paste field, and
  the desktop app only from its paste field; a phone's system camera shows
  it as text and opens nothing. A handoff through a registered scheme is
  refused because the receiving app could claim the ticket with its own key
  and show the very comparison code the host shows, so the code could not
  tell the person's device from a lookalike. An OS-verified app link would
  need a domain Octant operates, which the release boundary excludes. The
  10-character human-entry code has no room for a pin and is not offered for
  a self-made listener. The pin is public; the pairing code is as
  trustworthy as the way it reaches the device, scanned from the host's
  screen or terminal by the Octant app or pasted by the person. The
  host-side approval with the comparison code stays the check that the claim
  is the person's.
- **How each client pins.** A client takes a pin only from a pairing code,
  or from the rotation route below, and records it with the device
  registration for that exact origin (device-key metadata and the host
  registry). On every connection to that origin, the first hello included,
  it checks the served key against the recorded pins before it sends a
  request, and on a mismatch it closes the connection without sending or
  reading anything. For a pinned origin the pin check replaces platform
  chain validation and never falls back to it, so a certificate a public
  authority issued for the same name does not pass. An origin with no pin
  uses platform trust only, so it never accepts a self-made certificate.
  The only exception is a rotation window the host announced over a proven
  session (below). Validation is replaced for a pinned origin, never turned
  off.
  - **Phone.** Requests to a pinned origin go through a small in-tree native
    module that checks the pins in the platform's TLS trust callback on iOS
    and Android; the app's ordinary fetch is not used for those origins. It
    must work under the platform's transport security rules without an
    arbitrary-loads exception. The pairing screen reads the pairing code
    from the app's own QR scanner, which needs camera permission, or from
    a paste; typing the origin and ticket by hand stays for hosts with a
    pasted certificate.
  - **Desktop to host.** The desktop app reaches another host through
    Electron's network stack. The main process keeps the pins owner-only
    under the app's data and checks them in the session's certificate
    verification hook. The renderer can ask main to record a pin only while
    completing a pairing code, and main records pins only for names and
    addresses the listener address classifier calls private LAN or
    Tailscale, never a public name, so a compromised renderer cannot pin a
    public site. A pinned name whose key does not match is refused even when
    its certificate is otherwise trusted.
  - **CLI.** No `octant` command connects to another host as a paired device
    today; the CLI talks only to its own host over loopback. A future one
    pins through the TLS server-identity callback under the same rule, and
    a test refuses any code path that turns off chain validation without
    the pin check.
  - **A plain browser cannot pin.** It decides trust before any Octant page
    loads, and a page served over a connection it could not authenticate
    may come from anyone, so no script on that page can check the pin.
    A browser therefore pairs only with a listener that serves a pasted
    certificate (a Tailscale certificate or the person's own), as today. For
    a self-made listener, Settings and `octant pair` offer no browser link
    and say why (Settings already does, with the host certificate). A browser that opens the listener's address anyway shows
    its own certificate warning, before Octant can show anything; the guide
    says to stop there. Once a browser has seen the listener's HSTS header
    over a trusted certificate, it does not let the person continue past
    that warning at all. Octant installs no trust root and never asks the
    person to.
- **One-line start on the new computer.**
  `octant server install --artifact <path> --pair`, and
  `octant server start --pair` from a checkout, install and start the
  service as today (`install` still needs the artifact it installs), then,
  over the loopback administration channel:
  1. find the address: an up interface with an address the classifier calls
     Tailscale, else one private LAN address. More than one candidate of
     that kind, or none, refuses and names what it found; `--hostname`
     chooses instead;
  2. enable the listener on port 8443 (`--port` overrides) with a self-made
     certificate, or with `--cert` and `--key` when given;
  3. mint a pairing ticket and print the pairing code and a QR code in the
     terminal;
  4. wait up to the ticket's five minutes for a claim, show the device
     label, key fingerprint, and comparison code, and ask `Approve? [y/N]`.
     That answer is the host-side approval; `octant pair approve` stays the
     equivalent.
- **What `--pair` leaves alone.** It changes no firewall rule and runs no
  Tailscale command. A LAN address that changes later changes the origin,
  and the device pairs again, which is why Tailscale comes first. On a Mac
  with the desktop app, Settings → Remote access does the same as the
  command: enabling with no PEMs uses a self-made certificate and shows the
  pairing code and QR code.
- **Rotation.** Renewal keeps the key and needs nothing from clients.
  Replacing the key is host-local, from Settings or
  `octant listener replace-key`. The host makes the next key and
  certificate and keeps serving the current one. For up to 30 days it
  announces the current trust and the next trust on a new authenticated
  remote route that needs a device session and request proof and joins the
  forward list and route classifier like every product route. The next
  trust is a pin, or `platform` when the next certificate is pasted. A
  device records the next trust only from that route, on a connection that
  passed its current trust, and stages it: until the window ends the device
  accepts either the current or the staged trust for that origin, and the
  first connection that passes only the staged trust makes it current and
  drops the old. So a device that reconnects before the host switches still
  passes on the current certificate, and one that reconnects after passes
  on the new one. When the person switches, or the 30 days end, the host
  serves the new certificate and, for a self-made key, deletes the old key;
  a device that did not connect during the window sees the mismatch and
  pairs again. Moving between a pasted and a self-made certificate uses the
  same staged announcement, and a device changes its trust mode only that
  way. Because the announcement travels under the old key, it cannot recover
  from a stolen key: for a suspected compromise the person replaces the key
  and revokes every device, and each device pairs again. Rotating the host
  identity key still revokes every device, unchanged.
- **Failure copy.** Each refusal is a typed failure with one line of copy:
  - pin mismatch on any client: "This isn't the computer you paired with:
    its security key has changed. Octant stopped before sending anything.
    If its key was replaced on purpose, pair again from that computer.";
  - platform trust fails for an origin with no pin: "Octant couldn't verify
    this computer's certificate. Pair with the full pairing code or QR code from
    that computer.";
  - unknown pin prefix: "This pairing code needs a newer version of
    Octant.";
  - a browser link asked for on a self-made listener: "A browser can't check
    this computer's own certificate. Pair from the Octant app or the desktop
    app, or give the listener a Tailscale certificate or your own to pair a
    browser.";
  - no address found: "No Tailscale or private network address found on
    this computer. Connect it to Tailscale or your local network, or pass
    --hostname.";
  - several addresses: "This computer has more than one <Tailscale or
    private network> address: <list>. Pass --hostname with the one your
    other devices reach.";
  - key file readable by others (the host already says the first sentence;
    the second arrives with `replace-key`): "The listener's certificate key can be
    read by other users on this computer, so Octant won't use it. Run
    `octant listener replace-key` to make a new one.";
  - no claim in time: "No device used the pairing code within five minutes. Run the
    command again for a new one."

## Decisions

The maintainer approved the recommended option for every decision on
2026-10-14. Each lists the chosen option first, then the option not taken and
why.

1. **TLS key: A, a separate key.** The host identity key is meant to move
   behind keychain-brokered signing, which a TLS server cannot use, and
   rotating it revokes every device; a separate key keeps certificate work
   away from device trust.
   - Not B, reusing the host identity key.

2. **Pin encoding: A, `sha256-` plus base64url.** It keeps the pairing code and
   QR code shorter and leaves room for another algorithm.
   - Not B, hex.

3. **Certificate generation: A, a small in-tree DER writer** for this one
   certificate shape, tested by parsing the result with the platform's X.509
   reader and a real TLS handshake. The platform crypto API makes keys but not
   certificates.
   - Not B, a new dependency.

4. **QR encoding: A, one small, maintained, dependency-free QR encoder
   package** shared by Settings and the CLI.
   - Not B, an in-tree encoder: it is more code than the rest of this design.

5. **Key storage: A, the owner-only file** under the data directory. The
   listener needs the key in process at every start, a headless host's Secret
   Service can be locked, and the host identity key and a pasted key already
   live there.
   - Not B, Keychain or Secret Service.

6. **Validity window on pinned clients: A, clients do not enforce it.** Anyone
   holding the key can make a fresh certificate, so the date adds no
   protection, and a phone with a wrong clock would be locked out. The host
   still renews.
   - Not B, enforcing the dates on pinned clients.

7. **Browsers and self-made certificates: A, no browser link for a self-made
   listener.**
   - Not B, a link with a warning to click through: it trains the person to
     accept a certificate warning, and a browser that has seen the HSTS header
     would not allow it anyway.

8. **Fetching a Tailscale certificate during `--pair`: A, not by default.** It
   needs the tailnet's HTTPS setting and publishes the machine's name in public
   certificate logs. An explicit flag can come later.
   - Not B, fetching one automatically.

9. **Phone pinning: A, the in-tree native module.** It is the one check that
   must be right, and it is small.
   - Not B, a third-party pinning library.

10. **Command shape: A, `--pair` on both `server install --artifact <path>` and
    `server start`,** keeping the artifact argument `install` needs today.
    - Not B, a separate pairing command only.

11. **Phone QR scanner: A, the app's own scanner,** which adds camera
    permission and a camera package.
    - Not B, paste only: it keeps the app smaller but makes the phone path a
      copy-and-paste chore.

## Slices

Each slice is one reviewable change with its tests. Each moves the rules it
makes true into [Architecture](../architecture.md) in the same pull request,
and the plan shrinks accordingly.

1. _Host certificate._ **Built**; its rules are in Architecture. Generation, storage, renewal, the self-made enable
   variant on the administration routes and `octant listener`, and the
   status fields. Tests: the served certificate's key hashes to `tlsPin`
   over a real TLS connection; a pasted certificate wins when both exist;
   the key is absent from every administration response, status read,
   log line, journal event, and diagnostics export; a key file another
   user can read is refused; a restart and a renewal keep the pin.
2. _Pairing code._ **Built**; its rules are in Architecture. Building and
   reading the code, Settings and `octant pair` output, the QR code, and no
   browser link or bare ticket for a self-made listener.
3. _Client pin rule._ The pin and trust mode in device-key metadata and the
   host registry, and a pinned transport port in the client runtime.
   Tests: a client refuses a host whose key does not match the pin before
   it sends a request; a pinned origin never falls back to platform trust,
   and an unpinned one never accepts a self-made certificate.
4. _Desktop._ The main-process pin store and certificate verification
   hook. Tests: against a local self-made listener, the right key passes
   and any other is refused; a public name cannot be pinned; a trusted
   certificate with the wrong key is refused for a pinned name; a
   packaged-app smoke.
5. _Phone._ The native module, in-app scanner, and pasted code. Tests: module
   tests on both platforms and the device pass from the
   [TestFlight runbook](../mobile-testflight.md) against a self-made host,
   including a refused mismatch.
6. _One-line start._ `--pair`. Tests: Tailscale is chosen over LAN,
   several candidates refuse and list them, a public address is never
   chosen, and approval needs a typed `y`. Live: pair a second machine over
   Tailscale with only the command and the host approval.
7. _Rotation._ Replace key, the announcement route, switching. Tests: the
   route refuses an unauthenticated caller and is not on the loopback-only
   list; a device stages the next trust only over a proven session that
   passed its current trust; during a self-made-to-pasted move, a device
   that reconnects before the switch and one that reconnects after both
   pass; a device that missed the window sees the mismatch; revocation is
   unchanged.

## User guide when built

`apps/docs/advanced/remote-access.md` (the HTTPS and certificate rule, both
enabling sections, and a new section for adding a computer),
`apps/docs/guide/linux-host.md` (the Tailscale pairing steps become the one
command), and `apps/docs/advanced/privacy-and-security.md` (the remote
transport paragraph). The
[mobile remote-control threat model](../security/mobile-remote-control-threat-model.md)
gains the pin, the scheme claim, and the stolen-key limit. Until then those
pages keep describing a browser-trusted certificate, which is still the only
behavior.
