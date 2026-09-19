# Octant Mobile internal TestFlight

This is the operator runbook for the internal TestFlight track authorized by
[0137](decisions/0137-internal-testflight-carries-the-existing-remote-client.md).
It does not open a public App Store listing or submit an app version to App
Review.

## Registered identity

| System                     | Value                                  |
| -------------------------- | -------------------------------------- |
| Apple App ID               | `app.octant.mobile` (`Octant Mobile`)  |
| App Store Connect Apple ID | `6813937035`                           |
| Installed display name     | `Octant`                               |
| App Store Connect name     | `Octant Mobile`                        |
| Apple team                 | `45AD7E7G5G`                           |
| Expo account and project   | `@henrikogard/octant-mobile`           |
| EAS project ID             | `348816ec-d222-4e6a-bc5c-1c2c89e4bff6` |

The unqualified App Store name `Octant` is already in use. The store record's
qualified name does not change the name shown beneath the installed app icon.

## Credential boundary

The GitHub `mobile-testflight` environment contains one secret:

- `EXPO_TOKEN` — a revocable Expo access token that can operate the EAS
  project.

The environment is limited to `main` and should require the maintainer as a
reviewer. Pull-request jobs never receive the token.

EAS stores the iOS Distribution certificate, App Store provisioning profile,
and App Store Connect API key. Do not add `.p8`, `.p12`, provisioning profiles,
Apple passwords, or their encoded contents to GitHub variables, repository
files, workflow artifacts, or logs. Prefer a Developer-role App Store Connect
team key for build upload; a public App Store release would need a separate
review of whether broader permission is required.

## One-time setup

1. In Expo, create a revocable access token for the account and save it as the
   `EXPO_TOKEN` secret in GitHub's `mobile-testflight` environment.
2. In EAS credentials for `@henrikogard/octant-mobile`, select the production
   iOS profile and let EAS create or reuse one Apple Distribution certificate
   and App Store provisioning profile for `app.octant.mobile`.
3. Configure the App Store Connect API key for EAS Submit. Keep the private key
   only in Apple's one-time download backup and EAS's encrypted credential
   store.
4. Confirm the GitHub environment allows only `main` and has the required
   reviewer before running the workflow.

The first interactive EAS credential setup is intentionally local and
maintainer-authenticated. Once it succeeds, GitHub runs non-interactively.

## Build and upload

Run the `Mobile (TestFlight)` workflow from `main`:

- `submit: false` builds the App Store-signed `.ipa` in EAS and stops before
  Apple upload.
- `submit: true` builds and hands the successful artifact to EAS Submit. This
  uploads it to App Store Connect/TestFlight only; it does not submit an App
  Store version for review.

Treat the states independently:

1. GitHub validation passed.
2. EAS build completed and signed.
3. EAS Submit uploaded the build.
4. Apple processing completed without errors or unresolved warnings.
5. The build was assigned to the intended internal tester group.
6. The real-device acceptance pass completed.

## Internal tester notes

Use this initial “What to Test” text:

> Pair Octant with a host you control, then exercise Inbox, Agents, thread
> follow-ups, approvals, and host switching. Please report pairing or reconnect
> failures, stale state that still allows mutation, biometric prompts that can
> be bypassed, exposed paths or secrets, and screenshots that retain sensitive
> thread content.

Do not create an external group or public TestFlight link in this phase.

## Native connection preflight

Before queuing a TestFlight build, use a native Simulator build against an
isolated Octant host with its own `OCTANT_DATA_DIR` and a private HTTPS listener.
Trust the test certificate only in that Simulator; never disable TLS verification.

1. Cold-launch the app and unlock the vault. A build alone does not prove launch.
2. Pair through a fresh ticket and host approval, then read the real inbox.
3. Create Chat, send a prompt, and verify the response in both mobile and the
   host's thread API. A deterministic local provider is sufficient to isolate
   transport and journal behavior; real-provider behavior remains a separate check.
4. Verify NDJSON event replay, terminate/relaunch, and resume with the saved
   device key. Confirm host-only routes are refused to the remote principal.
5. Revoke that test device on the host and verify that resumption is refused.
6. Test background/foreground and network loss through the ordinary app UI;
   native transport probes do not replace vault or device UX acceptance.

The mobile Vitest suite runs in Node. It cannot validate Hermes cryptography,
SecureStore, URLSession cookie handling, or UIKit launch behavior. The existing
key-store and remote-client tests complement this native pass. Screenshot
capture protection, push notifications, and device-integrity detection currently
have unavailable native adapters and must not be recorded as passing checks.
The app names those limitations before interaction: unavailable capture settings
and push enablement are not offered, while clearing a previously registered push
token remains possible on a connected host. Device-integrity status remains
unknown and does not block pairing. Installing a TestFlight build does not enable
any of these missing adapters.

## Code connection validation

A paired device uses authenticated request-scoped Code Project access (ADR 0138).
The host checks active Projects and the thread's checkout, provider, and approval
policy without creating a desktop workspace for the device. Code prompt evidence
uses the route's bounded plain-text upload with the ordinary device proof.

Validate creation, completed provider response, follow-up, and transcript reload
against the intended host. A successful transport smoke does not replace the
physical-device acceptance pass below. Root binding and desktop shell commands
remain local-only.

## Device acceptance pass

- Install from TestFlight, cold launch, terminate, and relaunch.
- Pair with a real host over its supported HTTPS listener; refuse plain HTTP
  away from loopback.
- Lock and unlock the vault; exercise passcode fallback and cancel paths.
- Read Chat, Work, and Code threads and send only mutations the host advertises
  as remotely available.
- Confirm local-host-required actions remain unavailable on the phone.
- Background the app, let the session age, return, and verify reconnect/replay
  without duplicate turns or queued offline mutations.
- Make the host stale or unreachable and verify honest read-only presentation.
- Revoke the phone from the host and verify sessions and streams stop.
- Inspect app-switcher and screenshot behavior for prompts, paths, credentials,
  and other sensitive content.
- Record the EAS build ID, App Store Connect build number, device and iOS
  version, host revision, and each failed or skipped scenario.

Physical-device acceptance remains a maintainer gate. A green repository suite,
successful EAS archive, Apple upload, or TestFlight processing does not replace
it.
