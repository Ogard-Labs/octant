# Octant Mobile internal Android builds

This is the operator runbook for internal Android builds of the paired remote
client, under
[Mobile maturity: Phase B](design/mobile-maturity.md#phase-b-android-internal-builds-of-the-same-client).
It opens no Play listing, testing track, or store review. The Android build is
the same `apps/mobile` client as the iOS TestFlight build, with the same
package name (`app.octant.mobile`) and the same authority.

## Credential boundary

The GitHub `mobile-android-internal` environment contains one secret:

- `EXPO_TOKEN`: a revocable Expo access token that can operate the
  `@henrikogard/octant-mobile` EAS project.

The environment is limited to `main` and requires the maintainer as a
reviewer. Pull-request jobs never receive the token. It is a separate
environment from `mobile-testflight`, so an Android build is its own approval.

EAS's credential service holds the one Android upload keystore. Do not add a
keystore, its passwords, or their encoded contents to the repository, GitHub
variables, workflow artifacts, or logs. The workflow runs EAS with
`--freeze-credentials`, so it refuses to make a keystore rather than create a
second signing identity.

The repository is public, and so are its workflow logs. Anyone holding an
internal build's page or APK link can install it, so the workflow keeps EAS's
output on the runner and prints it only with every link and build id withheld.
Share the install link from the EAS dashboard with each chosen tester
directly.

## One-time setup

1. In GitHub, create the `mobile-android-internal` environment, limit its
   deployment branches to `main`, and add the maintainer as a required
   reviewer.
2. Save an Expo access token as that environment's `EXPO_TOKEN` secret. The
   TestFlight environment's token may be reused, or a separate one made so
   either can be revoked alone.
3. From `apps/mobile`, signed in to Expo as the maintainer, run
   `eas credentials --platform android`, choose the `android-internal` build
   profile, then "Keystore: Manage everything needed to build your project"
   and "Set up a new keystore", and let EAS generate it. Keep EAS as its only
   store.
4. Confirm the environment allows only `main` and has the reviewer before
   running the workflow.

## Build

Run the `Mobile (Android internal)` workflow from `main`. Its validate job
typechecks and tests the mobile app and resolves the Expo configuration for
the `android-internal` profile; its build job asks EAS for a signed APK
(`distribution: internal`, version code from EAS's remote version state) and
waits for it.

Treat the states independently:

1. GitHub validation passed.
2. EAS build completed and signed.
3. The maintainer sent the install link to the intended testers.
4. The device acceptance pass completed on a physical Android phone.

## What the Android build adds

- **Screen privacy.** The window carries Android's secure flag from launch, so
  screenshots, screen recording, and the recents preview show no Octant
  content. Computers › Privacy & security can switch to standard capture for the rest of
  that launch; the next launch is protected again.
- **Key storage.** Secure storage encrypts with a keystore key. Computers ›
  Privacy & security states whether this phone holds it in secure hardware or in
  software only, from a probe key made the same way.
- **Biometric gate.** Unlock and high-risk confirmations accept Class 3
  biometrics or the device PIN, pattern, or password, never a Class 2 face
  unlock. Android 9 and 10 cannot ask for that pair, so there the prompt
  keeps Android's default and also accepts a Class 2 biometric.
- **Pinned TLS.** The in-tree exchange (`modules/octant-pinned-tls/android`)
  dials the judged address and passes the TLS 1.3 handshake only for the
  pinned key. The server smoke test runs this Kotlin source on a JVM against a
  real host listener wherever `kotlinc` is installed.
- **Nothing backed up, no location.** Android backup is off, and the overlay
  and location permissions, the media-location one included, are removed from
  the manifest.

## Device acceptance

Run the [device acceptance pass](mobile-testflight.md#device-acceptance-pass)
on a physical Android phone. A green repository suite or a finished EAS build
does not replace it.
