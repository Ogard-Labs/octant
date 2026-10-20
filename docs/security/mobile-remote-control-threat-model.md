# Mobile remote-control threat model

- Date: 2026-08-05
- Threat model id: `mobile-remote-control-v1`
- Scope: Expo iOS/Android remote clients paired to Octant hosts
- Track: Mobile D hardening (post-preview)
- Design: `docs/decisions/0013-remote-access-and-mobile.md`

## Assets

- Device credential key material in SecureStore (never provider secrets)
- Per-host session cookies / request-proof material held only for live sessions
- Per-host push tokens registered with hosts
- Thread titles, approval summaries, and redacted notification copy on the phone
- Host registry entries (origin, hostId, label) on the device

## Explicit non-goals

- Host-side Keychain, provider API keys, or desktop Full-access elevation from the phone
- Public App Store / Play listing and store review packaging
- Defeating a determined attacker with a compromised host listener
- Guaranteeing root/jailbreak detection (heuristics fail soft only)

## Trust boundaries

1. The host remains authoritative for mode, Project, thread, and approval policy.
2. The phone is a remote principal; revoke removes only that device registration.
3. High-risk mutations (approve, including Allow this session, and revoke) require
   biometric or device-credential confirmation on the phone in addition to host checks.
   Pull-request merge is not a remote mutation: the host refuses it from every paired
   device.
4. Lock-screen and recents/screenshot surfaces must never show secrets, absolute
   paths, or full prompts — hosts build redacted payloads via domain policy.
5. Stale or unhealthy hosts present honest read-only state; the phone must not
   queue product mutations when the host is not ready.
6. Extension install/trust/enable remains host-only; mobile cannot bypass quarantine.

## Threats and mitigations

| ID  | Threat                                            | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Lost/stolen phone with unlocked vault access      | SecureStore-backed keys; biometric or device-credential gate for approvals (Allow, Allow this session; Deny is ungated) and revoke; host refuses remote merge; host revoke-self removes device; other clients stay up                                                                                                                                                                                                                                                                              |
| T2  | Lost phone with lock-screen push previews         | Redacted push payloads only (`buildRedactedPushNotification`); no secrets/paths/prompts                                                                                                                                                                                                                                                                                                                                                                                                            |
| T3  | Jailbroken/rooted device exfiltrates SecureStore  | Fail-soft integrity heuristic + soft warn UI; do not brick pairing; host revoke remains available                                                                                                                                                                                                                                                                                                                                                                                                  |
| T4  | Screenshots / app switcher leak thread detail     | Native capture blocking unavailable in the current client; scrub UI strings for secretish/path content and disclose the limit in Settings                                                                                                                                                                                                                                                                                                                                                          |
| T5  | Stale host still accepts phone mutations          | Session health + host mutation gate; stale presentation copy; zero queued mutations when not ready                                                                                                                                                                                                                                                                                                                                                                                                 |
| T6  | Concurrent desktop + phone; revoke wrong client   | Device-scoped revoke; concurrent-session tests (Mobile A)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T7  | Push token reused across hosts/devices            | Token store keyed by `{ hostId, deviceId }`; clear on revoke path residual                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T8  | Deep link opens wrong host thread                 | Deep links carry explicit `hostId` + `threadId`; parse rejects foreign schemes                                                                                                                                                                                                                                                                                                                                                                                                                     |
| T9  | Notification content over-sharing after C lands   | Domain redaction tests; Mobile C residual for live provider send                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T10 | Public store listing before internal evidence     | Store decision deferred (`MOBILE-LATER-STORE`); internal EAS profiles only                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T11 | Something at the paired address poses as the host | Each hello request names a fresh client nonce, and the host signs it into the hello with its identity key (canonical version 2 payload). Before a claim or challenge the client checks key, fingerprint, that the hello echoes its nonce, signature, and expiry, then the pinned host id and fingerprint. Stops a responder that states the paired fingerprint without the key, relabels another host's hello, or replays a genuine hello it recorded; see residual risk for what it does not stop |

## Residual risk

- Device-integrity detection, native screenshot/app-switcher protection, and push
  delivery are unavailable in the current client, including device builds. Settings
  disclose those limits and omit unavailable capture and push-enablement controls;
  integrity stays unknown. Vault locking is not evidence of native capture protection.
  Platform adapters and device acceptance are still required.
- EAS `projectId`, signing, TestFlight, and Play internal uploads need Henrik-owned
  credentials.
- Live APNs/FCM delivery remains a Mobile C residual.
- A compromised host can still send whatever the host policy allows to a paired
  device; mobile cannot exceed host authority but also cannot save a malicious host.
- The client nonce proves the key holder answered the phone's own hello
  request, so a recorded hello no longer passes. Nothing after the hello is
  bound to it, and the phone does not check the negotiation record's
  `hostSignature`: an attacker who can present a certificate the phone trusts
  for the listener's name and can reach the real host can relay the live hello
  and answer or forward the rest. First contact pins the key from the first
  verified hello over TLS. Pinning the listener certificate closes the relay
  for a listener paired from its pairing code: the desktop app and the phone
  app pin its key and check it during the handshake, before any request. A
  listener with a pasted certificate is still reached under platform trust.
- A phone updated before its host refuses that host ("Update Octant on the
  host") until the host is updated, and keeps the pairing.
- Anything that answers at the paired address can still deny service: a hello
  signed with its own key shows "host identity changed", and a 401 naming the
  device revoked or expired shows that state. Neither deletes the device key;
  the phone deletes it when the person pairs that address again or signs out.
  Removing a host from the phone's list does not delete its key (unchanged).
