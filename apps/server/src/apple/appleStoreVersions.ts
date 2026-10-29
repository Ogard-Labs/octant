import { Schema } from "effect";
import {
  AppleBundleVersion,
  decodeAppleDeviceResponse,
  decodeAppleStoreVersion,
  decodeAppleStoreVersionEvidence,
  type AppleBuildOutcome,
  type AppleDeviceRefusalReason,
  type AppleDeviceRequest,
  type AppleDeviceResponse,
  type AppleStoreVersion,
  type AppleStoreVersionEvidence,
} from "@octant/contracts";
import type { AppleStoreVersionPreparation } from "@octant/contracts/apple-toolchain-rpc";
import type { AppStoreConnectTokens } from "../providers/credentialBrokerClient";
import type { AppleDeviceExecutionContext } from "./appleDeviceService";
import type { AppleDistributionUpload } from "./appleDistributionUpload";
import type { AppStoreConnectApi, AppStoreConnectVersion } from "./appStoreConnectClient";

export interface AppleStoreVersionsOptions {
  /** Reads the app and version the scheme declares; nothing that writes runs. */
  readonly readApp: AppleDistributionUpload["readDeclaredApp"];
  /** The broker's token signer; undefined on a host with no broker for the key. */
  readonly tokens: AppStoreConnectTokens | undefined;
  readonly api: AppStoreConnectApi;
  /** Journals what a submission or release did; never the key or the token. */
  readonly recordEvidence?: (evidence: AppleStoreVersionEvidence, startedAt: string) => void;
  readonly now: () => string;
}

// States in which App Store Connect takes a version into a new review
// submission: never submitted, ready for review, or rejected and edited since.
const SUBMITTABLE_STATES: ReadonlySet<string> = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
]);
/** Approved, and held for the person to release by hand. */
const AWAITING_MANUAL_RELEASE = "PENDING_DEVELOPER_RELEASE";
const MAX_DIAGNOSTIC_LENGTH = 2_048;

const KEY_MESSAGES = {
  missing: "No App Store Connect key is saved on this Mac. Add one in Settings › Device tools.",
  "key-source-unavailable":
    "The App Store Connect key could not be read from 1Password: op is missing or signed out, or the request was declined.",
  unavailable: "The credential broker did not sign an App Store Connect request.",
} as const;

/**
 * A person-confirmed submission for App Review, or release, of one version
 * of their own app (slice 8 of docs/design/apple-devices.md). Octant submits
 * only what App Store Connect already holds: the version, with the build
 * already selected for it. It writes no metadata, screenshots, pricing,
 * availability, or export-compliance answer, and never sets a version to
 * release on its own after approval.
 *
 * Every App Store Connect request carries a token the credential broker
 * signed for that one step; the server never holds the key. Nothing here
 * decides who may act: the device policy has already required a local
 * person's confirmation of exactly this version before a step gets here.
 */
export class AppleStoreVersions {
  readonly #options: AppleStoreVersionsOptions;

  constructor(options: AppleStoreVersionsOptions) {
    this.#options = options;
  }

  /**
   * What App Store Connect holds for the version this project declares, and
   * which step it is ready for. It only reads, so it runs before anyone is
   * asked to confirm anything.
   */
  async prepare(
    input: { readonly projectPath: string; readonly scheme?: string },
    context: Pick<AppleDeviceExecutionContext, "checkoutRoot">,
    signal?: AbortSignal,
  ): Promise<AppleStoreVersionPreparation> {
    const declared = await this.#options.readApp(input, context, signal);
    if (declared.kind === "failed") return declared;
    const token = await this.#sign();
    if (token.kind !== "signed") return { kind: "failed", message: KEY_MESSAGES[token.kind] };
    const read = await this.#options.api.readVersion(
      token.token,
      { bundleIdentifier: String(declared.bundleIdentifier), version: declared.version },
      signal,
    );
    switch (read.kind) {
      case "no-app":
        return {
          kind: "failed",
          message: `App Store Connect has no app with the bundle ID ${declared.bundleIdentifier} for this key.`,
        };
      case "no-version":
        return {
          kind: "failed",
          message: `App Store Connect has no iOS version ${declared.version} of ${declared.bundleIdentifier}. Create it in App Store Connect; Octant does not create versions.`,
        };
      case "refused":
        return { kind: "failed", message: `App Store Connect refused: ${read.reason}` };
      case "unclassified":
        return { kind: "failed", message: "App Store Connect's answer could not be read." };
      case "found":
        break;
    }
    const storeVersion = storeVersionOf(
      String(declared.bundleIdentifier),
      declared.version,
      read.version,
    );
    if (storeVersion === undefined) {
      return {
        kind: "failed",
        message: `Version ${declared.version} has no build selected in App Store Connect. Select the build there; Octant submits only what App Store Connect already holds.`,
      };
    }
    if (releasesOnItsOwn(read.version)) {
      return {
        kind: "failed",
        message: `App Store Connect would release ${declared.version} on its own once approved (release ${read.version.releaseType ?? "not set"}). Set the version to release manually in App Store Connect; Octant submits only a version you release yourself.`,
      };
    }
    return {
      kind: "prepared",
      storeVersion,
      ready: readiness(read.version),
      state: read.version.state,
    };
  }

  /**
   * Submits or releases exactly the version the person confirmed. App Store
   * Connect is read again first; if the version no longer has the confirmed
   * build or is no longer ready for this step, nothing is sent.
   */
  async carryOut(request: AppleDeviceRequest, signal?: AbortSignal): Promise<AppleDeviceResponse> {
    const confirmed = request.storeVersion;
    if (
      confirmed === undefined ||
      (request.kind !== "submit-for-review" && request.kind !== "release-version")
    ) {
      return refused("store-version-changed");
    }
    const step = request.kind;
    const startedAt = this.#options.now();
    const token = await this.#sign();
    // A key kept in 1Password that `op` could not read refuses before App
    // Store Connect is asked anything, and is not asked for again.
    if (token.kind === "key-source-unavailable") return refused("key-source-unavailable");
    if (token.kind !== "signed") {
      return this.#record(request, step, confirmed, startedAt, {
        outcome: token.kind === "missing" ? "failed" : "unavailable",
        message: KEY_MESSAGES[token.kind],
      });
    }
    const read = await this.#options.api.readVersion(
      token.token,
      { bundleIdentifier: String(confirmed.bundleIdentifier), version: String(confirmed.version) },
      signal,
    );
    if (read.kind === "refused" || read.kind === "unclassified") {
      return this.#record(request, step, confirmed, startedAt, {
        outcome: "failed",
        message:
          read.kind === "refused"
            ? `App Store Connect refused: ${read.reason}`
            : "App Store Connect's answer could not be read, so nothing was sent.",
      });
    }
    if (read.kind !== "found") return refused("store-version-changed");
    const current = storeVersionOf(
      String(confirmed.bundleIdentifier),
      String(confirmed.version),
      read.version,
    );
    if (current === undefined || String(current.buildNumber) !== String(confirmed.buildNumber)) {
      return refused("store-version-changed");
    }
    // Rechecked here, not only when the step was offered: a version set since
    // to release after approval would go live without the person's release.
    if (step === "submit-for-review" && releasesOnItsOwn(read.version)) {
      return refused("release-not-manual");
    }
    if (readiness(read.version) !== step) return refused("store-version-changed");
    const answer =
      step === "submit-for-review"
        ? await this.#options.api.submitForReview(
            token.token,
            { appId: read.version.appId, versionId: read.version.versionId },
            signal,
          )
        : await this.#options.api.release(
            token.token,
            { versionId: read.version.versionId },
            signal,
          );
    const label = `${confirmed.bundleIdentifier} ${confirmed.version} (${confirmed.buildNumber})`;
    switch (answer.kind) {
      case "done":
        return this.#record(request, step, confirmed, startedAt, {
          outcome: "succeeded",
          message:
            step === "submit-for-review"
              ? `Submitted ${label} for App Review.`
              : `Released ${label} to the App Store.`,
          appStoreConnectId: answer.id,
        });
      case "refused":
        return this.#record(request, step, confirmed, startedAt, {
          outcome: "failed",
          message: `App Store Connect refused: ${answer.reason}`,
        });
      case "uncertain":
        return this.#record(request, step, confirmed, startedAt, {
          outcome: "interrupted",
          message: `App Store Connect's answer to submission ${answer.id} was lost or could not be read, so Octant does not know whether ${label} is in App Review. It left the submission as it is. Check App Store Connect before submitting again.`,
        });
      case "unclassified":
        return this.#record(request, step, confirmed, startedAt, {
          outcome: "interrupted",
          message:
            step === "submit-for-review"
              ? "App Store Connect's answer could not be read, so Octant does not count the version as submitted. Check App Store Connect before submitting again."
              : "App Store Connect's answer could not be read, so Octant does not count the version as released. Check App Store Connect before releasing again.",
        });
    }
  }

  async #sign() {
    const tokens = this.#options.tokens;
    if (tokens === undefined) return { kind: "unavailable" } as const;
    return await tokens.sign();
  }

  #record(
    request: AppleDeviceRequest,
    step: "submit-for-review" | "release-version",
    storeVersion: AppleStoreVersion,
    startedAt: string,
    result: {
      readonly outcome: AppleBuildOutcome;
      readonly message: string;
      readonly appStoreConnectId?: string;
    },
  ): AppleDeviceResponse {
    const completedAt = this.#options.now();
    const evidence = decodeAppleStoreVersionEvidence({
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority: request.authority,
      kind: step,
      requestedBy: request.requestedBy,
      outcome: result.outcome,
      storeVersion,
      ...(result.appStoreConnectId === undefined
        ? {}
        : { appStoreConnectId: result.appStoreConnectId }),
      diagnostics: [
        {
          severity: result.outcome === "succeeded" ? "note" : "error",
          message: result.message.slice(0, MAX_DIAGNOSTIC_LENGTH),
        },
      ],
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      completedAt,
    });
    this.#options.recordEvidence?.(evidence, startedAt);
    return decodeAppleDeviceResponse({ kind: "apple-store-version-evidence", evidence });
  }
}

/** The one step App Store Connect's state admits for a version now. */
function readiness(
  version: AppStoreConnectVersion,
): "submit-for-review" | "release-version" | "neither" {
  if (version.state === AWAITING_MANUAL_RELEASE && version.build !== undefined) {
    return "release-version";
  }
  if (
    SUBMITTABLE_STATES.has(version.state) &&
    version.build?.processingState === "VALID" &&
    version.releaseType === "MANUAL"
  ) {
    return "submit-for-review";
  }
  return "neither";
}

/**
 * A version ready for review that App Store Connect would publish by itself
 * once approved (`AFTER_APPROVAL`, `SCHEDULED`, or no release type it named).
 * Octant never submits one: the confirmation says submitting does not
 * release, and it does not change the release setting for the person.
 */
function releasesOnItsOwn(version: AppStoreConnectVersion): boolean {
  return (
    SUBMITTABLE_STATES.has(version.state) &&
    version.build?.processingState === "VALID" &&
    version.releaseType !== "MANUAL"
  );
}

function storeVersionOf(
  bundleIdentifier: string,
  version: string,
  held: AppStoreConnectVersion,
): AppleStoreVersion | undefined {
  const buildNumber = held.build?.buildNumber;
  if (buildNumber === undefined || !Schema.is(AppleBundleVersion)(buildNumber)) return undefined;
  try {
    return decodeAppleStoreVersion({ bundleIdentifier, version, buildNumber, platform: "ios" });
  } catch {
    return undefined;
  }
}

function refused(reason: AppleDeviceRefusalReason): AppleDeviceResponse {
  return decodeAppleDeviceResponse({ kind: "apple-device-refused", reason });
}
