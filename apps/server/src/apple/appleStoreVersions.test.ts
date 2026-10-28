import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  AppleBundleIdentifier,
  decodeAppleDeviceRequest,
  type AppleDeviceRequest,
  type AppleStoreVersionEvidence,
} from "@octant/contracts";
import type { AppStoreConnectTokenSigning } from "../providers/credentialBrokerClient";
import { composeAppleValidationEvents } from "./appleValidationEvidence";
import { AppleStoreVersions } from "./appleStoreVersions";
import type {
  AppStoreConnectApi,
  AppStoreConnectStep,
  AppStoreConnectVersion,
} from "./appStoreConnectClient";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.signed-for-one-step.signature";
const authority = {
  hostId: "60000000-0000-4000-8000-000000000000",
  mode: "code",
  projectId: "60000000-0000-4000-8000-000000000001",
  providerInstanceId: "60000000-0000-4000-8000-000000000002",
  extension: { kind: "core" },
};
const agent = {
  kind: "agent",
  actorId: "60000000-0000-4000-8000-000000000011",
  providerInstanceId: authority.providerInstanceId,
  threadId: "60000000-0000-4000-8000-000000000003",
};
const storeVersion = {
  bundleIdentifier: "app.octant.fixture",
  version: "1.2",
  buildNumber: "7",
  platform: "ios",
};

let requestNumber = 0;
function stepRequest(
  kind: "submit-for-review" | "release-version",
  extra: Record<string, unknown> = {},
): AppleDeviceRequest {
  requestNumber += 1;
  const suffix = String(requestNumber).padStart(12, "0");
  return decodeAppleDeviceRequest({
    actionId: `61000000-0000-4000-8000-${suffix}`,
    correlationId: `62000000-0000-4000-8000-${suffix}`,
    authority,
    threadId: agent.threadId,
    checkoutId: "60000000-0000-4000-8000-000000000004",
    kind,
    requestedBy: agent,
    storeVersion,
    timeoutMs: 60_000,
    approval: { kind: "approved", approvalId: "60000000-0000-4000-8000-000000000021" },
    ...extra,
  });
}

function heldVersion(overrides: Partial<AppStoreConnectVersion> = {}): AppStoreConnectVersion {
  return {
    appId: "1234567890",
    versionId: "a1b2c3d4-0000-4000-8000-000000000001",
    state: "PREPARE_FOR_SUBMISSION",
    build: { buildNumber: "7", processingState: "VALID" },
    ...overrides,
  };
}

function setup(
  input: {
    readonly version?: AppStoreConnectVersion;
    readonly signing?: AppStoreConnectTokenSigning;
    readonly step?: AppStoreConnectStep;
  } = {},
) {
  const sign = vi.fn(
    async (): Promise<AppStoreConnectTokenSigning> =>
      input.signing ?? { kind: "signed", token: TOKEN },
  );
  const api = {
    readVersion: vi.fn<AppStoreConnectApi["readVersion"]>(async () => ({
      kind: "found",
      version: input.version ?? heldVersion(),
    })),
    submitForReview: vi.fn<AppStoreConnectApi["submitForReview"]>(
      async () => input.step ?? { kind: "done", id: "c0ffee00-0000-4000-8000-000000000001" },
    ),
    release: vi.fn<AppStoreConnectApi["release"]>(
      async () => input.step ?? { kind: "done", id: "c0ffee00-0000-4000-8000-000000000002" },
    ),
  } satisfies AppStoreConnectApi;
  const recorded: AppleStoreVersionEvidence[] = [];
  const readApp = vi.fn(async () => ({
    kind: "read" as const,
    bundleIdentifier: Schema.decodeUnknownSync(AppleBundleIdentifier)("app.octant.fixture"),
    version: "1.2",
    buildNumber: "7",
  }));
  let tick = 0;
  const versions = new AppleStoreVersions({
    readApp,
    tokens: { sign },
    api,
    recordEvidence: (evidence) => recorded.push(evidence),
    now: () => new Date(Date.parse("2026-10-28T12:00:00.000Z") + 1_000 * tick++).toISOString(),
  });
  return { versions, api, sign, recorded, readApp };
}

describe("AppleStoreVersions", () => {
  it("reads the project's version from App Store Connect and says which step it is ready for", async () => {
    const context = { checkoutRoot: "/checkout" };
    const input = { projectPath: "App.xcodeproj" };
    await expect(setup().versions.prepare(input, context)).resolves.toEqual({
      kind: "prepared",
      storeVersion,
      ready: "submit-for-review",
      state: "PREPARE_FOR_SUBMISSION",
    });
    await expect(
      setup({ version: heldVersion({ state: "PENDING_DEVELOPER_RELEASE" }) }).versions.prepare(
        input,
        context,
      ),
    ).resolves.toMatchObject({ kind: "prepared", ready: "release-version" });
    // A build App Store Connect is still processing is not ready for review.
    await expect(
      setup({
        version: heldVersion({ build: { buildNumber: "7", processingState: "PROCESSING" } }),
      }).versions.prepare(input, context),
    ).resolves.toMatchObject({ kind: "prepared", ready: "neither" });
    await expect(
      setup({ version: heldVersion({ state: "WAITING_FOR_REVIEW" }) }).versions.prepare(
        input,
        context,
      ),
    ).resolves.toMatchObject({ kind: "prepared", ready: "neither", state: "WAITING_FOR_REVIEW" });
    const { build: _build, ...noBuild } = heldVersion();
    await expect(
      setup({ version: noBuild }).versions.prepare(input, context),
    ).resolves.toMatchObject({ kind: "failed" });
  });

  it("submits exactly the confirmed version, with one signed token, and journals it without the token", async () => {
    const { versions, api, sign, recorded } = setup();
    const answer = await versions.carryOut(stepRequest("submit-for-review"));
    expect(api.submitForReview).toHaveBeenCalledTimes(1);
    expect(api.submitForReview).toHaveBeenCalledWith(
      TOKEN,
      { appId: "1234567890", versionId: "a1b2c3d4-0000-4000-8000-000000000001" },
      undefined,
    );
    expect(api.release).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({
      kind: "apple-store-version-evidence",
      evidence: {
        kind: "submit-for-review",
        outcome: "succeeded",
        storeVersion,
        appStoreConnectId: "c0ffee00-0000-4000-8000-000000000001",
      },
    });
    const [evidence] = recorded;
    if (evidence === undefined) throw new Error("the submission was not journaled");
    const journaled = composeAppleValidationEvents({
      evidence,
      startedAt: "2026-10-28T12:00:00.000Z",
      newId: () => "60000000-0000-4000-8000-000000000099",
    });
    // The record names the actor, app, version, result, and App Store
    // Connect's identifier, and never the token.
    expect(journaled.record.detail).toContain(
      "Submission for App Review succeeded: app.octant.fixture 1.2 (7) for ios",
    );
    expect(journaled.record.detail).toContain("requested by the thread's agent");
    expect(journaled.record.detail).toContain("c0ffee00-0000-4000-8000-000000000001");
    expect(JSON.stringify([answer, journaled])).not.toContain(TOKEN);
  });

  it("releases only a version approved and waiting for a manual release", async () => {
    const waiting = setup({ version: heldVersion({ state: "PENDING_DEVELOPER_RELEASE" }) });
    await expect(waiting.versions.carryOut(stepRequest("release-version"))).resolves.toMatchObject({
      evidence: { kind: "release-version", outcome: "succeeded" },
    });
    expect(waiting.api.release).toHaveBeenCalledWith(
      TOKEN,
      { versionId: "a1b2c3d4-0000-4000-8000-000000000001" },
      undefined,
    );

    for (const state of [
      "READY_FOR_DISTRIBUTION",
      "WAITING_FOR_REVIEW",
      "PREPARE_FOR_SUBMISSION",
    ]) {
      const notWaiting = setup({ version: heldVersion({ state }) });
      await expect(notWaiting.versions.carryOut(stepRequest("release-version"))).resolves.toEqual({
        kind: "apple-device-refused",
        reason: "store-version-changed",
      });
      expect(notWaiting.api.release).not.toHaveBeenCalled();
      expect(notWaiting.recorded).toEqual([]);
    }
  });

  it("sends nothing when App Store Connect now holds another build for the confirmed version", async () => {
    const changed = setup({
      version: heldVersion({ build: { buildNumber: "8", processingState: "VALID" } }),
    });
    await expect(changed.versions.carryOut(stepRequest("submit-for-review"))).resolves.toEqual({
      kind: "apple-device-refused",
      reason: "store-version-changed",
    });
    expect(changed.api.submitForReview).not.toHaveBeenCalled();
  });

  it("refuses as key-source-unavailable before asking App Store Connect anything, and asks 1Password once", async () => {
    const unread = setup({ signing: { kind: "key-source-unavailable" } });
    await expect(unread.versions.carryOut(stepRequest("submit-for-review"))).resolves.toEqual({
      kind: "apple-device-refused",
      reason: "key-source-unavailable",
    });
    expect(unread.sign).toHaveBeenCalledTimes(1);
    expect(unread.api.readVersion).not.toHaveBeenCalled();
    expect(unread.api.submitForReview).not.toHaveBeenCalled();
  });

  it("records App Store Connect's reason for a refused submission as not done and does not retry", async () => {
    const refusedStep = setup({
      step: { kind: "refused", reason: "The app is missing required screenshots." },
    });
    await expect(
      refusedStep.versions.carryOut(stepRequest("submit-for-review")),
    ).resolves.toMatchObject({
      evidence: {
        outcome: "failed",
        diagnostics: [
          {
            severity: "error",
            message: "App Store Connect refused: The app is missing required screenshots.",
          },
        ],
      },
    });
    expect(refusedStep.api.submitForReview).toHaveBeenCalledTimes(1);
    expect(refusedStep.recorded).toHaveLength(1);
  });
});
