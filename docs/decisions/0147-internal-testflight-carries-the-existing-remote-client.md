# 0147. Internal TestFlight carries the existing remote client

**Status:** Accepted

## Context

0013 defines Octant Mobile as a paired remote-control client whose authority
stays on the user's host. The mobile maturity plan separates hardened remote
control from device distribution and keeps a public store listing for a later
phase. Simulator and local development prove code paths, but they do not let a
maintainer install and dogfood the same signed build through Apple's ordinary
beta channel.

The maintainer has authorized Mobile Phase B: prepare and operate an internal
TestFlight track for the existing Expo client. That requires an Apple App ID,
an App Store Connect record, an EAS project, signing credentials, a protected
CI entry point, and a device acceptance pass. It does not authorize a public
listing, external beta group, App Review submission, push infrastructure, or
new mobile authority.

## Decision

- The TestFlight artifact is the existing `apps/mobile` remote client. Its
  bundle identifier is `app.octant.mobile`; its installed product name remains
  Octant, while its App Store Connect record is named Octant Mobile because
  the unqualified store name is unavailable.
- EAS Build owns iOS archive construction and Apple distribution signing for
  this client. Build numbers come from EAS remote version state and increment
  for every production build. Source version `0.1.0` remains the explicit beta
  version until a separate release decision changes it.
- The `production` EAS profile means App Store distribution, not public
  release. A successful EAS Submit upload creates or updates a TestFlight
  build; it never selects a public App Store version or submits one to App
  Review.
- GitHub exposes one manually dispatched `Mobile (TestFlight)` workflow. Its
  build job runs only from `main`, uses the protected `mobile-testflight`
  environment, and requires an explicit `submit` input before it adds
  `--auto-submit`. Pull requests receive no release credential.
- GitHub holds only the revocable Expo access token needed to ask EAS to run.
  Apple distribution certificates, provisioning profiles, and the App Store
  Connect submit key live in EAS's encrypted credential service. Raw Apple
  private keys and signing archives never enter the repository or workflow
  logs.
- The Apple App ID enables no optional capability in this phase. Push
  Notifications, Associated Domains, Sign in with Apple, iCloud, and other
  services remain disabled until their own product and threat-model decisions
  require them.
- Internal testers are maintainer-controlled App Store Connect users. External
  TestFlight groups, public links, beta App Review, public listing metadata,
  pricing, availability, and App Review submission remain outside this
  decision.
- A build is not accepted because EAS built it or Apple processed it. The
  device pass must verify install and cold launch, pairing to a real host over
  supported HTTPS, vault lock and biometric recovery, Chat/Work/Code reads and
  permitted mutations, stale-host refusal, background/foreground reconnect,
  and screenshot/privacy behavior. Gaps remain named rather than being folded
  into “TestFlight ready.”

## Consequences

- Maintainers can install the real signed client through TestFlight without a
  local Xcode archive ritual, while the phone remains a remote principal with
  no new host authority.
- Apple processing, TestFlight availability, and real-device acceptance remain
  separate delivery states after repository and CI configuration are ready.
- Public App Store distribution remains closed by the existing V1 hold and
  still requires the Phase E boundary change.

## Related

- 0013 Remote access: single host, paired devices, and mobile
- 0026 Shipping to a user-owned target
- Mobile remote-control threat model
- Mobile maturity phases beyond remote control
