# Mobile maturity

This topic specification owns the mobile phases beyond the paired
remote-control client: Android internal builds, host-originated push
notifications, capture and voice as remote input, and public store
distribution. Architecture owns the boundary it extends: the phone as a remote
principal ([Process topology](../architecture.md#process-topology), Mobile),
remote-client authority
([Security and authority](../architecture.md#security-and-authority), Remote
clients), and the release scope
([Current Release Boundary](../architecture.md#current-release-boundary)). The
internal iOS TestFlight track keeps its runbook in
[Octant Mobile internal TestFlight](../mobile-testflight.md), and the shipped
remote client (pairing, inbox, approvals, thread screen, appearance) stays as
architecture describes it; this specification adds to that client and does
not redesign it.

**Status.** Accepted 2026-10-26; slice 1 (the host keeps push registrations
and drops them with the device) and slice 2 (the host builds sealed, redacted
thread notifications) are implemented; slice 3 (camera and file capture) is
implemented and verified in the container, and its physical-device camera pass
is a maintainer gate; slices 4 to 9 are not started. The
maintainer authorized this scope as post-preview work and accepted the
[maintainer decisions](#maintainer-decisions) below on 2026-10-26. That
authorizes design, planning, and implementation of the slices below that need
no new account, spend, hosted service, store submission, or widened authority;
the account, deployment, and sign-off gates the decisions name stay maintainer
actions. The release-boundary statement in `AGENTS.md` and architecture is
updated by a separate change; until it lands, public store work (Phase E) does
not start. Nothing below is implemented unless
[Exists today](#exists-today) says so.

## Outcome

A person who pairs a phone with their computer can, without ever giving the
phone more authority than the host grants:

1. install the same remote client on Android as on iOS without a cable or a
   developer toolchain;
2. learn on a locked phone that a thread is waiting, failed, finished, or needs
   an approval, without the notification revealing what the thread is about to
   Apple, Google, a relay, or a bystander;
3. attach a photo, image, or file and dictate a prompt from the phone, with all
   processing on the host; and, later,
4. install the client from the public app stores.

## The phone stays a remote client

These rules hold for every phase and are not reopened by any slice:

- The host is authoritative for mode, Project, thread, provider, approval, and
  Done. The phone is a remote principal with a revocable device key; it runs no
  agent loop, holds no checkout or provider credential, and has no filesystem
  root. Every phone mutation is checked and journaled on the host with its
  principal.
- A new phone capability is a new remote input or output on an existing host
  route class, admitted by the fail-closed remote route classifier
  (`apps/server/src/remoteRoutePolicy.ts`) and refused on every route it does
  not name. Local-host-required actions stay unavailable on the phone.
- A notification is awareness, never authority. It carries no action that
  approves, denies, sends, or mutates; opening it lands on the thread, where the
  ordinary authenticated session and biometric gate apply.
- Revoking a device on the host ends its sessions, streams, and notifications
  together. Disconnected or stale hosts present read-only; the phone queues no
  mutation for later delivery, including through a notification path.
- Sensors (camera, microphone, photo library, files) are touched only on an
  explicit, visible user act, never in the background, and their permission
  strings name each use.
- The app receives no over-the-air code updates; every build carries its own
  JavaScript. An update channel is a code-delivery channel and would need its
  own signing design.
- Optional native pieces (push transport, recorders, pickers) reach the app
  through the existing ports in `apps/mobile/src/notifications/` and
  `apps/mobile/src/security/` and the host through `PushDeliveryTransport`;
  vendor wire formats stop at those adapters. Per the
  [plugin boundary table](../architecture.md#plugin-boundaries-and-remaining-extraction),
  only presentation and optional adapters are extraction candidates; push
  policy, redaction, and device lifecycle stay host-owned.

## Exists today

| Area              | Current state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| iOS distribution  | Internal TestFlight through EAS (`apps/mobile/eas.json`, `.github/workflows/mobile-testflight.yml`); App ID enables no optional capability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Android           | `app.config.ts` names package `app.octant.mobile`; pinned TLS has an Android implementation (`apps/mobile/modules/octant-pinned-tls/android`). No Android build profile, workflow, or device acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Push contracts    | `packages/contracts/src/remotePushNotifications.ts`: registration (token, the phone's notification public key, per-kind preferences and the thread-title opt-in), its receipts, the sealed content (kind, host, thread, mode, title ≤ 80 B, body ≤ 120 B), the delivery envelope, and the journaled delivery receipt                                                                                                                                                                                                                                                                                                                                                                                                           |
| Push policy       | `packages/domain/src/pushNotificationPolicy.ts` builds display text under [decision M2](#maintainer-decisions) (kind and computer label; a thread title or Automation name only for a phone that opted in) and owns per-kind preferences, deduplication keys, the per-device rate limit, and urgency                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Push on the host  | `PUT`/`DELETE /api/remote/auth/push-token` (`remoteHttpAuthentication.ts`) store a registration per `{hostId, deviceId}` in the owner-only `remote/push-registrations.json` (`apps/server/src/remote/pushNotificationTokenStore.ts`), as [What the host keeps](#what-the-host-keeps) describes: it survives a restart and is cleared with the device. Ordinary threads in every mode (`threadNotificationDeliveryService.ts`) and Automation runs (`automationNotificationDeliveryService.ts`) seal each notification to the phone (`pushNotificationSealing.ts`) as [Sealing](#sealing) and [Sending](#sending) describe, and hand the envelope to `createUnavailablePushDeliveryTransport`, which never sends, until slice 7 |
| Push on the phone | `notificationPermissionPort.ts` is the unavailable stub; `PushNotificationsPanel.tsx` offers only clearing a registered token; `deepLinks.ts` parses `octant://hosts/{hostId}/threads/[{mode}/]{threadId}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Capture           | Chat, Work, and Code threads attach a camera photo, a library image, or a document-picker file (`apps/mobile/src/inbox/thread/pickAttachment.ts`, `useThreadAttachments.ts`) through each mode's own attachment route (`packages/client-runtime/src/mobileAttachmentClient.ts`), offered only for media the thread's model takes. The listener admits those routes for a paired device (`remoteRoutePolicy.ts`), and the host removes image metadata from every paired upload before a route sees it (`apps/server/src/attachments/imageMetadataRemoval.ts`, applied in `authenticatedProductRoutes.ts`). The camera and photo-library permission strings name both uses; the physical-device camera pass is a maintainer gate |
| Voice             | Host speech routes (`/api/speech/*`) require window authority and are not admitted for paired devices; the phone composer shows a disabled microphone (`apps/mobile/src/ui/FloatingComposer.tsx`); `app.config.ts` disables the microphone permission                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Hardening ports   | Screenshot privacy and device integrity are unavailable stubs (`screenshotPrivacyPort.ts`, `deviceIntegrityPort.ts`) disclosed in Settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Phase B (Android): internal builds of the same client

- The Android artifact is the same `apps/mobile` client with the same authority
  and the same package name. It is distributed to maintainer-chosen testers
  only; no public Play listing, open or closed testing track with external
  sign-up, or store review is opened.
- Builds run from a manually dispatched workflow on `main` in a protected
  environment, like the iOS workflow. Pull requests receive no release
  credential. The signing keystore lives in EAS's credential service, never in
  the repository, GitHub variables, artifacts, or logs.
- Before a build counts, Android reaches parity on the hardening the iOS pass
  checks: keys in hardware-backed storage where the device offers it, the
  biometric or device-credential gate, pinned TLS to a self-made listener
  certificate, and screenshot and recents protection through the existing
  screenshot privacy port (the platform's secure-window flag) for screens that
  can show thread content. A missing adapter is named as unavailable, as on
  iOS, never recorded as passing.
- Acceptance is the [device acceptance pass](../mobile-testflight.md#device-acceptance-pass)
  on a physical Android device, with the build and device recorded.

## Phase C: host-originated push

### Off until the person turns it on

- Settings › Remote access › **Notifications** on the host is off by default.
  Its row names the delivery path's URL. While it is off, no request reaches
  the delivery path, the host reports push `unavailable` (the current honest
  state), and the phone does not offer enablement.
- Push is off for every device until the person enables it on that phone. The
  phone then asks the operating system for permission, obtains a destination
  from the delivery path, and registers it with each host it chooses.
- The host owner sees, in Settings › Remote access, which paired devices receive
  notifications and can turn any of them off. A device can change only its own
  preferences. Preferences are per device and per kind: approval needed,
  waiting, failed, completed.
- Disabling on the phone clears the registration on every host it can reach
  and invalidates the destination; a host it cannot reach drops it on its next
  delivery failure or on revoke.

### What the host keeps

- The destination record (device id, platform, delivery capability, the
  phone's notification public key, preferences, the collapse key the host
  makes for it, updated time) is kept
  owner-only under the data directory, beside the device inventory, outside
  the journal and every export. It survives a restart and is deleted when the
  device is revoked, revokes itself, signs out, or is removed as
  `pairing-abandoned`.
- The journal records that a device's push registration was added, changed, or
  cleared, and one delivery receipt per notification (kind, device id, thread
  id, outcome, time). It records no capability, token, key, or notification
  text. Capabilities and tokens never appear in logs, responses, diagnostics,
  or receipts.
- The record lives in `remote/push-registrations.json` (directory `0700`, file
  `0600`), written by an atomic rename, and is one of the named `remote/`
  files that removing all local data deletes. Each device's registration is
  one journal aggregate (`remote-push-registration`, keyed by device id) with
  `remote.push-registration-recorded@1` (change `added` or `changed`, with the
  platform) and `remote.push-registration-cleared@1` (with the reason). A
  repeat of the current registration or of a clear journals nothing. A file
  that cannot be read back exactly holds no registrations, so the host
  delivers nothing until each phone registers again.
- Which credential changes clear a registration: a sign-out, and every loss
  of standing (a revoke by the host or by the device, `pairing-abandoned`,
  credential expiry, host key recovery). A key rotation keeps it, and so does
  a listener stop, which is how a restart ends sessions. A reason the host
  does not name clears it as a revoke, so a new way to lose standing cannot
  leave a phone receiving notifications. When the remote gateway is enabled,
  any registration whose device is not active is cleared
  (`device-without-standing`), because the clear runs after the revoke
  commits and a host stopped between the two would otherwise keep it.
- A clear removes the token before journaling it, so a failed append still
  leaves it gone and is reported (a revoke's receipt counts it as a failed
  hook, and a retry clears again). A registration writes the file inside the
  journal's transaction and restores the previous file if the append fails,
  so no token is kept that the journal does not record. The registration
  route checks the device's session again after reading the body, so a
  registration cannot land after a concurrent revoke or sign-out cleared it.

### What leaves the host

A notification has two layers:

| Layer             | Seen by                                              | Contents                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery envelope | Delivery path, Apple or Google, the operating system | A fixed placeholder alert ("Octant" / "A paired computer has an update"), a opaque collapse id the host derives per destination and thread with a key it keeps, an urgency, and the sealed content. No host name, thread id, title, or kind |
| Sealed content    | Only the phone that registered the key               | Kind, host id, thread id, mode, and display text built by the domain redaction policy                                                                                                                                                       |

- The sealed content is encrypted to the phone's per-host notification key
  pair, created on the phone at registration and kept in its secure storage;
  only the public key goes to the host. The construction is HPKE (RFC 9180)
  base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, and AES-256-GCM, with
  the host id and device id bound into the HPKE info, and sealed content is at most
  2 KiB.
- The phone opens the sealed content on the device (an iOS notification service
  extension; an Android data-message receiver that posts the notification
  itself) and replaces the placeholder. If it cannot open it, the placeholder
  stays and nothing else is shown.
- Display text follows the redaction policy: kind and the computer's label by
  default. The thread title appears only when the person enabled thread names
  for that phone ([decision M2](#maintainer-decisions)). Prompts, transcript
  text, diffs, paths, tool arguments, and secrets never appear in either
  layer; the existing scrubber stays as a second guard, not the primary rule.
- On revoke, sign-out, or host removal the phone removes delivered
  notifications for that host and forgets its notification key.

#### Sealing

- The registration carries the phone's raw X25519 public key for this host
  (43 unpadded base64url characters) and its preferences: approval needed,
  waiting, failed, completed, and thread titles, which the phone sends off
  until the person turns them on. A registration without them is refused. A
  change to either is journaled as `changed`, and keeps the destination's
  collapse key.
- The envelope (`RemotePushEnvelopeV1`) is the placeholder alert; a collapse
  id of 22 unpadded base64url characters, the first 16 bytes of HMAC-SHA256
  over the thread id (the run id for an Automation run without a thread)
  under a random 32-byte key the host makes per registration and keeps beside
  it; an urgency, `high` for approval needed and waiting and `normal`
  otherwise; and the sealed content as `encapsulatedKey` and `ciphertext`
  (content and tag), both unpadded base64url.
- Sealing is single-shot HPKE (sequence 0) with empty associated data and the
  UTF-8 info `octant-push-v1\n<hostId>\n<deviceId>`, where the host id is the
  one the phone paired with. The plaintext is the sealed content as JSON,
  padded with trailing spaces to 2 KiB so the ciphertext's length names no
  kind or title. The
  host builds it with `node:crypto` alone and checks it against the published
  RFC 9180 vector for this suite. Content over 2 KiB, or a key that is not a
  usable X25519 public key (a low-order point included), is refused and
  journaled as a failure, never sent in another form.
- The display text is the kind ("Approval needed", "Waiting for you", "Thread
  failed", "Thread completed") and "On" the computer's label, the name the
  listener's hello shows. Only for a phone that opted in does ": " and the
  thread title follow the kind. A title the scrubber flags as a secret or a
  path is left out whole. Automation runs follow the same rule, with the
  automation's name where a thread title would be, and show no failure
  message.

### When the host sends

- Ordinary threads in every mode notify on the four kinds above, observed from
  journal lifecycle facts, deduplicated per thread, kind, and run, and rate
  limited per device. Automation runs keep their existing delivery service and
  receipts, moved onto the same transport and sealing.
- An approval-needed notification is sent whether or not the approval is
  remotely answerable; the thread screen states which. The host never sends a
  notification to a device whose authority could not read that thread.
- Delivery failure never changes thread, run, or approval state. A delivery
  path that refuses a destination as gone clears it.

#### Sending

- The lifecycle facts are: a Chat `chat.attempt-updated@1` whose outcome is
  completed, failed, or waiting; a Work `work.turn-updated@1` with the same
  statuses and a `work.request-recorded@1` that requests an approval (approval
  needed) or an answer (waiting); a Code `code.runtime-work-updated@1` for a
  provider turn with the same states and a `code.operation-event-recorded@1`
  that requests an approval or an answer; and the harness's
  `native-harness-approval-asked@1` and `native-harness-question-asked@1` in
  any mode. Interrupted and cancelled turns notify nothing. The run is the
  attempt or turn for a lifecycle fact, and the request itself (the Work
  request, the Code approval or question, the harness ask) for one that asks
  the person, since one turn can ask several.
- Every registration in the host's file is the host's own, under the listener
  host id the phone paired with; the host's local id names none of them. So
  delivery reads them all and seals each under its own host id. A device
  receives a notification only while its record under that host id is active
  and unexpired. That is asked for every notification, immediately before its
  send, not only when the gateway starts, so a revoke or sign-out that lands
  first stops it. The device must also want the kind, and a paired device must
  be able to read the thread: it exists, is not being deleted, is not a Side
  Chat or assistant lane, and its mode is on. A device's preferences filter
  Automation runs too.
- Each notification to one device is one journal aggregate
  (`remote-push-delivery`) holding one `remote.push-delivery-recorded@1`: host
  id, device id, thread id, kind, outcome (`delivered`, `failed`,
  `rate-limited`, `destination-gone`), a failure-category slug, and the time. A
  fact whose receipt already exists sends nothing, so a repeat after a restart
  stays silent. Ordinary-thread notifications are tried once.
- A device receives at most six notifications in any sixty seconds; the rest
  are journaled `rate-limited` and not sent later. A burst of threads ending
  together reaches the phone as its first few, and the thread list shows the
  rest; a later send would be stale.
- While the transport is unavailable, ordinary threads seal, send, and journal
  nothing. The transport is unavailable while the Notifications setting is
  off, and always until slice 7. Automation runs keep their existing receipts.

### Delivery path

Apple and Google deliver only on behalf of the developer account that signs
the app, with that account's credential. Hosts are people's own computers, so
that credential cannot be shipped to them. Remote push therefore needs a
sender holding it. The sender is a minimal Octant push gateway
([decision M1](#maintainer-decisions)):

- The phone, when push is enabled, sends its platform token and the host's
  identity fingerprint to the gateway once per host and receives a delivery
  capability: the token, platform, and fingerprint sealed under a gateway key.
  The gateway stores nothing per device.
- The phone gives the capability to the host over the existing pinned,
  device-authenticated push registration route. The host sends the envelope
  with the capability, signing the request with its host identity key. The
  gateway accepts only a request signed by the key whose fingerprint is sealed
  in the capability, so a leaked capability alone sends nothing.
- The gateway never sees sealed content in the clear, product traffic,
  pairing material, or host routes. It is not a principal, cannot reach a
  host, and carries nothing toward one; it is not the hosted relay the release
  boundary excludes. It keeps per-capability rate counters in memory and logs
  counts and failure categories only.
- The phone uses the gateway compiled into its build, because only a gateway
  holding that build's signing-account credential can deliver to it. The
  host's gateway URL is the Notifications setting, with the Octant service as
  the default; a capability is valid only at the gateway that issued it, and a
  mismatch reports `unavailable` rather than failing silently.

## Phase D: capture and voice as remote input

### Capture

- The phone attaches a camera photo, a photo-library image, or a file from the
  system document picker, through the thread's own attachment route for its
  mode and under that thread's authority. A mode or provider that does not
  accept that media type is not offered it (honest capability). Capture never
  writes into a Work or Code folder; the attachment is thread content.
- The camera permission string names both uses (pairing scan and attaching a
  photo). The phone requests no location access.
- The host removes location and other identifying metadata (EXIF, XMP, IPTC)
  from every image a paired device uploads before it is stored or sent to a
  provider, and keeps the existing type sniffing and size bounds. The phone
  keeps no copy beyond the upload.

#### Capture rules

- The listener admits each mode's attachment upload route for a paired device:
  `POST /api/chat/attachments`, and `PUT /api/work/attachments` and
  `PUT /api/code/attachments`, each only for the media types that mode takes
  (Chat: text, PNG, JPEG, WebP, GIF, PDF; Work and Code: the four image
  types) and with that mode's identity headers. Staging a Work image is the
  Work turn action and a Code image the Code turn action; the route still
  checks the thread's own authority. No other product route takes an image.
- A paired upload is at most 10 MiB in every mode, the Work and Code bound,
  even though Chat at the host takes 25 MiB: the listener holds the whole body
  to check the device's proof before forwarding it, so the bound is what a
  phone photo needs. The phone refuses a larger file before sending it.
- Metadata removal runs once, where a paired device's request enters the
  product routes (after its proof and action are checked, before any route
  sees the body), for every request whose media type is an image. Each format
  keeps an allow-list of what draws the picture and its colour: JPEG keeps
  JFIF, the ICC profile, and Adobe's colour transform and drops every other
  APPn segment and comment; PNG keeps its image, colour, scale, and animation
  chunks and drops text, EXIF, time, and every unknown ancillary chunk; WebP
  drops EXIF and XMP and clears the header flags that named them; GIF drops
  comments and every application block but looping. Bytes after the image's
  end are dropped, since some cameras append metadata there. An image whose
  bytes are not the type it names, a type the host cannot clean (HEIC, say),
  or one whose structure cannot be walked to its end is refused with 415,
  never stored partly cleaned. The signed body is what the device sent; what
  the route stores is the cleaned image.
- The phone offers a source only when the thread's mode route and the model
  its next turn runs on both take the media: the provider must report native
  attachments supported and the model must declare the modality (image, or
  document for Chat's text and PDF). A model the host does not list as ready
  is offered nothing. The camera and the library are offered when an image
  is; the document picker is limited to the accepted types. The library asks
  the system for a compatible JPEG rather than HEIC, and a file whose type
  neither the picker nor its name gives is not guessed into one.
- Picking asks for that source's permission only on the person's tap.
  Attachments upload as soon as they are picked, under the thread's authority,
  and the turn carries only their ids. The copy the camera or picker left in
  the app's cache is deleted when the upload ends, either way.

### Voice

- The phone records only while the microphone control is held or visibly
  recording, at most 60 seconds per clip, and discards the audio after the
  transcript returns or the upload fails. Recording stops when the app leaves
  the foreground.
- Transcription runs on the host's configured Voice endpoint
  ([decision M5](#maintainer-decisions)): the host admits the transcription
  route for a paired device with the same audio sniffing and bounds as the
  desktop, a per-device budget, and the same `ready`/`unconfigured`/`unavailable`
  status; it persists nothing. The phone shows the microphone only while
  transcription is `ready`.
- The transcript is appended to the draft; the person still sends. Read-aloud
  stays desktop-only. The system keyboard's own dictation is outside Octant's
  control and unaffected.

## Phase E: public store distribution

Post-preview, and only after the release-boundary change lands and Phases B to
D have been dogfooded so that store presence is the remaining gap.

- The listed app is the same remote client. It requires no Octant account; it
  is useful only with the person's own computer.
- Store review needs a usable app without a reviewer's computer. The app offers
  a clearly labelled offline demo built from the existing mock scenario, with
  no network access and no pairing ([decision M6](#maintainer-decisions)).
- The privacy disclosures state that Octant collects no data; that content goes
  only to computers the person paired; and, when push is enabled, that the
  platform token and host fingerprint go to the push gateway. Listing copy
  names no third-party product and promises no capability the host may not
  grant.
- Export compliance, publisher identity, and the privacy policy page are
  maintainer and legal sign-offs, recorded in the release change.

## Threat model

Extends [Mobile remote-control threat model](../security/mobile-remote-control-threat-model.md);
its T2, T7, and T9 residuals are closed by Phase C.

| Id  | Threat                                                    | Mitigation                                                                                                                            |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Apple, Google, or the gateway read what a thread is about | Envelope carries only a placeholder and a keyed collapse hash; content is sealed to a key only the phone holds                        |
| P2  | Lock-screen bystander reads thread detail                 | Default text is kind and computer label; thread titles opt-in per phone; scrubber as second guard                                     |
| P3  | Revoked or lost phone keeps receiving                     | Destination deleted with the device; phone forgets keys and clears delivered notifications on revoke, sign-out, or host removal       |
| P4  | Leaked capability used to spam or phish a phone           | Gateway requires the sealed host fingerprint's signature; per-capability rate limit; undecryptable content shows only the placeholder |
| P5  | Notification used to approve or act without the vault     | Notifications carry no actions; approval runs only in the authenticated session behind the biometric gate                             |
| P6  | Gateway becomes a relay or an authority                   | Gateway has no host route, stores no per-device state, and carries nothing toward a host; host checks stay as today                   |
| P7  | Photo reveals location or device identity to providers    | Host strips image metadata for every paired-device upload; phone requests no location                                                 |
| P8  | Microphone or camera used without the person knowing      | Explicit, visible acts only; foreground only; 60-second clip cap; audio not persisted on phone or host                                |
| P9  | Phone spends the host owner's transcription budget        | Per-device budget; same `ready` gate; host owner can revoke the device                                                                |
| P10 | Android build weaker than iOS (screenshots, key storage)  | Parity adapters are acceptance criteria; missing ones named unavailable, never passed                                                 |
| P11 | Release credential exposed through CI                     | Manual dispatch from `main`, protected environment, Expo token only; signing material stays in EAS                                    |
| P12 | Store build or demo exposes host data or bypasses pairing | Demo has no network and no pairing; store build is the same client with the same authority                                            |

Residual: a compromised host can still send whatever notifications its policy
allows; the gateway operator can observe delivery timing, host and phone IP
addresses, and platform tokens.

## Settled by existing specifications

- The phone is a remote principal with host-owned threads and a revocable
  device key; remote routes are classified fail-closed
  ([architecture](../architecture.md#security-and-authority)).
- Internal iOS TestFlight is authorized and its credential boundary stands
  ([runbook](../mobile-testflight.md)).
- Phone approvals require the biometric or device-credential gate; remote merge
  is refused (threat model trust boundary 3).
- Voice uses the host's OpenAI-compatible Voice endpoint and persists no audio
  ([Providers](../architecture.md#providers)).
- A hosted relay stays out unless reachability evidence opens it
  ([remote path research](../remote-path-sufficiency.md)); the push gateway
  above carries no product traffic and is not that relay.
- A maintainer-operated service follows the Canvas public links shape: off by
  default, named in Settings, with a replaceable URL
  ([Canvas public links](canvas-public-links.md)).

## Maintainer decisions

The maintainer accepted these on 2026-10-26. Each rule is decided; the
alternatives considered stay beside it as rationale, and the gates a rule
names are still maintainer actions, not facts.

| Id  | Decision                       | Rule                                                                                                        | Alternatives considered, and remaining gates                                                                                                                                                                                                         |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Push delivery path             | The Octant push gateway described above, in `octant-webapp` beside the Canvas share service, off by default | Rejected: Expo's push service, which sees envelopes and whose token is itself a send capability; no remote push, notifying only while the phone runs. Gates: the Apple push capability, a Firebase project, deployment, and a release-boundary entry |
| M2  | Lock-screen text               | Kind and computer label; thread titles only when the person opts in for that phone                          | Rejected: thread title always (the current policy); placeholder only                                                                                                                                                                                 |
| M3  | Android internal distribution  | EAS internal distribution (signed APK by link) now                                                          | Play internal testing track only when Phase E opens; it needs a Play Console account and fee                                                                                                                                                         |
| M4  | Signing and publisher identity | Organization accounts before Phase E; internal tracks stay on the current accounts                          | Rejected: personal accounts for the store. Gate: creating the organization accounts (a D-U-N-S number; new personal Google developer accounts must run a closed test before production access)                                                       |
| M5  | Where speech is transcribed    | The host's Voice endpoint                                                                                   | Rejected: the phone's operating-system recognizer, which may send audio to Apple or Google outside host policy                                                                                                                                       |
| M6  | Store review path              | An offline, clearly labelled demo                                                                           | Rejected: a reviewer-reachable demo host, which would be a hosted, always-on Octant host                                                                                                                                                             |

## Delivery plan

Each slice is one reviewable pull request. "Container" means an agent can
implement and verify it in a Linux container without accounts or hardware.

| #   | Slice                                                        | Acceptance                                                                                                                                                                                     | Verification                                                                                     | Needs                                                                     |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1   | Host keeps push registrations and drops them with the device | Registration survives restart; revoke, revoke-self, sign-out, and `pairing-abandoned` delete it; journal records add/clear without the token; no token in any response, log, or export         | Server tests: restart, each revoke path, route auth negatives, export and log scans              | Container                                                                 |
| 2   | Host builds sealed, redacted thread notifications            | Ordinary threads in all modes produce deduplicated, rate-limited deliveries for the four kinds; envelope carries no content; sealed content opens only with the device key; receipts journaled | Domain redaction and sealing tests; server delivery tests with the recording transport           | Container (M2 title rule)                                                 |
| 3   | Camera and file capture                                      | Phone attaches camera photo, library image, or file where the thread accepts it; host strips image metadata for paired uploads; permission copy names both camera uses                         | Host metadata-strip tests; client-runtime tests; rendered phone QA; device pass for camera       | Container for code; physical device for acceptance                        |
| 4   | Voice input through the host                                 | Paired device transcribes within bounds and budget only while `ready`; audio persisted nowhere; draft receives transcript; mic hidden otherwise                                                | Route admission and negatives (window-only paths stay refused), budget tests; device pass        | M5; container for host; physical device for acceptance                    |
| 5   | Android internal builds                                      | Manual workflow builds a signed internal APK from `main`; secure-window, key storage, biometric, and pinned TLS adapters work; device pass recorded                                            | Expo config validation in CI; Android device acceptance pass                                     | M3; maintainer `EXPO_TOKEN` and protected environment; Android device     |
| 6   | Phone push adapters                                          | Enable flow registers per host; notification service extension and Android receiver open sealed content; deep link lands on the thread; revoke clears delivered notifications and keys         | Mobile unit tests; device pass on iOS and Android with a test gateway                            | M1; Apple push capability and keychain sharing, Firebase project; devices |
| 7   | Push gateway and host transport                              | Gateway issues sealed capabilities, verifies host signatures, rate limits, stores nothing per device; host transport reports `available` only when configured                                  | Gateway tests against fake APNs/FCM; host transport tests against a local gateway; live delivery | M1; deployment, DNS, credentials; release-boundary entry                  |
| 8   | Store readiness without submission                           | Offline demo, privacy disclosures and data-safety answers drafted, listing copy reviewed, screenshot protection on both platforms                                                              | Rendered QA of demo; doc review                                                                  | M6; container for demo; release-boundary change landed                    |
| 9   | Store submission                                             | Listings live on both stores for the same client                                                                                                                                               | Store review outcome; post-install device pass                                                   | M4, M6; maintainer accounts, legal sign-off, submission                   |

Slices 1 to 4 do not depend on each other, and with M5 decided none waits on a
maintainer decision. Slice 6 depends on 1, 2, and 7; slice 9 on 8.

## Rationale

- **Sealed push rather than redaction alone.** Redaction decides what a
  bystander sees; it does not stop the delivery path, Apple, or Google from
  reading the payload, and thread titles routinely name customers, projects,
  and incidents. Sealing to a phone-held key keeps the local-first promise for
  every party between host and phone at the cost of a notification extension.
- **A gateway rather than credentials on hosts.** The platform push credential
  is bound to the signing account and can send to every install; putting it on
  people's computers would leak it. A stateless gateway with host-signed,
  fingerprint-bound capabilities is the smallest sender that keeps no device
  database. Expo's service was rejected as the default because it sees
  envelopes, and its tokens are bearer send rights unless every send carries
  an account access token, which hosts cannot be given.
- **Metadata stripped on the host.** Stripping on the phone depends on each
  picker and platform; one host rule covers phone and paired browser and is
  testable without a device.
- **Internal APK before Play.** It needs no new account or listing and proves
  Android parity, which is the Phase B exit; Play tracks matter only for store
  distribution.

## Verification

Prose alone needs no new test. Each slice carries the verification in its row;
physical-device passes, live delivery, and store outcomes are named maintainer
gates and are never replaced by a green repository suite, a successful EAS
build, or a processed upload.
