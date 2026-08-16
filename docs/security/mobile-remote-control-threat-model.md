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
3. High-risk mutations (merge, revoke; future approve/reject if ever remote) require
   biometric or device-credential confirmation on the phone in addition to host checks.
4. Lock-screen and recents/screenshot surfaces must never show secrets, absolute
   paths, or full prompts — hosts build redacted payloads via domain policy.
5. Stale or unhealthy hosts present honest read-only state; the phone must not
   queue product mutations when the host is not ready.
6. Extension install/trust/enable remains host-only; mobile cannot bypass quarantine.

## Threats and mitigations

| ID  | Threat                                           | Mitigation                                                                                                                  |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| T1  | Lost/stolen phone with unlocked vault access     | SecureStore-backed keys; biometric gate for merge/revoke; host revoke-self removes device; other clients stay up            |
| T2  | Lost phone with lock-screen push previews        | Redacted push payloads only (`buildRedactedPushNotification`); no secrets/paths/prompts                                     |
| T3  | Jailbroken/rooted device exfiltrates SecureStore | Fail-soft integrity heuristic + soft warn UI; do not brick pairing; host revoke remains available                           |
| T4  | Screenshots / app switcher leak thread detail    | Screenshot privacy mode preference + port (native FLAG_SECURE / blur residual); scrub UI strings for secretish/path content |
| T5  | Stale host still accepts phone mutations         | Session health + host mutation gate; stale presentation copy; zero queued mutations when not ready                          |
| T6  | Concurrent desktop + phone; revoke wrong client  | Device-scoped revoke; concurrent-session tests (Mobile A)                                                                   |
| T7  | Push token reused across hosts/devices           | Token store keyed by `{ hostId, deviceId }`; clear on revoke path residual                                                  |
| T8  | Deep link opens wrong host thread                | Deep links carry explicit `hostId` + `threadId`; parse rejects foreign schemes                                              |
| T9  | Notification content over-sharing after C lands  | Domain redaction tests; Mobile C residual for live provider send                                                            |
| T10 | Public store listing before internal evidence    | Store decision deferred (`MOBILE-LATER-STORE`); internal EAS profiles only                                                  |

## Residual risk

- Live jailbreak/root SDK signals and real screen-capture blocking require device
  builds and platform APIs not available in Linux cloud agents.
- EAS `projectId`, signing, TestFlight, and Play internal uploads need Henrik-owned
  credentials.
- Live APNs/FCM delivery remains a Mobile C residual.
- A compromised host can still send whatever the host policy allows to a paired
  device; mobile cannot exceed host authority but also cannot save a malicious host.
