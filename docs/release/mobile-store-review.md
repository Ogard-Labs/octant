# Mobile store review pack

Draft for assessment, 7 November 2026. No store forms have been submitted and no
listing, signing, account, release or deployment action is authorized by this
pack. [Mobile maturity](../design/mobile-maturity.md#phase-e-public-store-distribution)
owns the product boundary. Source implementation and unit checks do not establish
real-device or store-review acceptance.

## Listing copy

| Field                        | Draft                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                         | Octant                                                                                                                                                                                                                                                                                                                                            |
| Subtitle / short description | Your workspace, remotely                                                                                                                                                                                                                                                                                                                          |
| Description                  | Keep up with your Octant workspace from your phone. Connect to Octant on your own computer, read Chat, Work and Code conversations, and send follow-up instructions within each task's existing permissions. Explore the offline sample workspace before pairing. No Octant account is needed. Your computer decides which actions are available. |

Do not claim that a particular host platform, push capability, background mode,
provider or release channel works until its corresponding acceptance passes.
Use the publisher, contact and business facts already confirmed by the maintainer;
legal assessment still owns their final store presentation.

## Reviewer path

1. Use a fresh install with no saved computer. Choose **Explore offline demo**
   before device authentication or pairing. The **Offline demo · sample data**
   banner remains visible while browsing.
2. Browse the Inbox and the sample Chat, Work and Code threads. Create a sample
   conversation or send a sample reply: only the in-memory fixture changes.
3. Device recording, file capture, pairing, owner recovery and device settings
   are not offered in the demo. No real model call, host or account is involved.
4. Choose **Leave demo**. Re-entering starts with the original sample data.
   **Connect a computer** leaves the demo route and uses the normal vault and
   pairing requirements. A phone with saved computers keeps its normal vault
   startup rather than silently switching to sample data.

This path is an assessment candidate. Apple's review guidance requires usable
review access, including necessary hardware/resources; a demo is not an automatic
waiver of those requirements. The assessor must confirm whether the sample path
is sufficient for this remote client and identify any additional review material.
See [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/#app-completeness).

## Data-flow brief for legal assessment

The following describes the intended software boundaries, not a completed audit
of an installed build or gateway deployment.

| Flow                   | Current boundary                                                                                                                                     | Assessment still needed                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Demo                   | Bundled sample data and memory-backed transport/preferences; no pairing or live session                                                              | Confirm native build makes no network connection and exposes no device effects                                    |
| Paired content         | Task text, selected files, photos and voice clips go to the computer explicitly paired by the person; that host's selected provider may process them | Classify developer/operator responsibilities and store declarations for user-controlled hosts and providers       |
| Device credentials     | Device signing keys stay in platform secure storage; demo uses separate memory storage                                                               | Confirm both native platforms and final bundle/SDK behaviour                                                      |
| Optional push          | The platform token and host fingerprint go through the configured gateway; notification content is sealed to the phone                               | Confirm actual operator, logs, retention, subprocessors and whether identifiers/metadata require store disclosure |
| Analytics and tracking | No advertising or analytics feature is intentionally added by this client                                                                            | Audit the final SDK/bundle and platform services before a final declaration                                       |
| Permissions            | Camera/pickers, microphone, notifications and local authentication serve explicit client actions                                                     | Check final permission descriptions and real-device refusal/cancellation paths                                    |

Apple's definition of collection distinguishes real-time request servicing from
longer access or retention; that distinction requires evidence of actual handling.
Do not infer a final answer from the word “stateless.” See
[Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/).

Google's Data safety form asks about off-device processing and includes ephemeral
processing in the form response even when qualifying processing is not displayed
in the public section. Its form covers the package across distributed versions.
Use the release's real flows and configuration, not demo behaviour alone. See
[Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en).

Questions for assessment are the applicable data categories, collection/sharing
classification, retention wording, privacy-policy text, publisher identity,
export compliance and review-access sufficiency. Do not select a blanket **No data
collected** or an encryption exemption solely from this pack. Existing build
metadata has not been changed here.

## Validation before submission

| Evidence                                   | Required result                                                                                                         | Owner                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Fresh-install demo on iOS and Android      | Entry, sample create/reply, exit/reset, safe areas and large text work without a host                                   | Implementation agents when native test environments are available  |
| Network/device isolation                   | No host reconnect, deep-link consumption, real credential access, recording, capture or owner operation in demo         | Implementation agents in isolated native tests                     |
| Demo and paired screenshots                | Only fixture data in review material; normal screenshot privacy and refusal behaviour remains correct on both platforms | Maintainer supplies devices/build authority; agents execute checks |
| Push/device acceptance                     | Real configured gateway and phones pass their separate matrix                                                           | Maintainer prerequisites and existing live-smoke list              |
| Final privacy answers and policy           | Assessed against final build, SDKs and deployment facts                                                                 | Maintainer and legal assessor                                      |
| Publisher, signing and export declarations | Confirmed for the actual store accounts and release                                                                     | Maintainer                                                         |
| Submission and post-install acceptance     | Explicit submission action, store outcome and installed device pass                                                     | Maintainer                                                         |

Use sample data for all listing screenshots. Do not disable screenshot protection
automatically to generate marketing material. No screenshot, native test, legal
assessment or submission is marked complete by the existence of this document.
