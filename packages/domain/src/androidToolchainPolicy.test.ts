import { describe, expect, it } from "vitest";
import {
  evaluateAndroidEmulatorRequest,
  isAndroidEmulatorInputKind,
  isAndroidEmulatorOpenInputKind,
  redactedAndroidInputDiagnostic,
} from "./androidToolchainPolicy";
import type {
  AndroidEmulatorRecord,
  AndroidEmulatorRequest,
  AndroidSdkDiscovery,
  ToolActionAuthority,
} from "@octant/contracts";

const authority: ToolActionAuthority = {
  hostId: "00000000-0000-4000-8000-000000000004" as never,
  mode: "code",
  projectId: "00000000-0000-4000-8000-000000000005" as never,
  providerInstanceId: "00000000-0000-4000-8000-000000000006" as never,
  extension: { kind: "core" },
};

const sdk: AndroidSdkDiscovery = {
  sdkId: "00000000-0000-4000-8000-000000000001" as never,
  available: true,
  discoveredAt: "2026-09-20T12:00:00.000Z" as never,
};

const booted: AndroidEmulatorRecord = {
  emulatorId: "Pixel_8_API_34" as never,
  name: "Pixel 8",
  state: "booted",
  serial: "emulator-5554",
};

const tap: AndroidEmulatorRequest = {
  actionId: "10000000-0000-4000-8000-000000000001" as never,
  correlationId: "10000000-0000-4000-8000-000000000002" as never,
  authority,
  threadId: "10000000-0000-4000-8000-000000000007" as never,
  checkoutId: "10000000-0000-4000-8000-000000000008" as never,
  kind: "tap",
  emulatorId: booted.emulatorId,
  requestedBy: { kind: "local-user", actorId: "10000000-0000-4000-8000-000000000099" as never },
  point: { x: 12, y: 34 },
  timeoutMs: 30_000,
  approval: { kind: "approved", approvalId: "10000000-0000-4000-8000-000000000009" as never },
};

const scope = {
  authority,
  threadId: tap.threadId,
  checkoutId: tap.checkoutId,
  executionPolicy: "approval-gated" as const,
  approvalValid: true,
};

describe("evaluateAndroidEmulatorRequest", () => {
  it("lets a live grant cover taps and still asks for Allow input and shutdown", () => {
    const granted = { ...scope, inputGranted: true };
    const withoutToken = { ...tap, approval: { kind: "not-required" as const } };
    expect(evaluateAndroidEmulatorRequest(withoutToken, granted, [booted], sdk)).toEqual({
      kind: "allowed",
    });
    expect(evaluateAndroidEmulatorRequest(withoutToken, scope, [booted], sdk)).toMatchObject({
      reason: "approval-required",
    });
    const openInput = {
      ...tap,
      kind: "open-input" as const,
      point: undefined,
      approval: { kind: "not-required" as const },
    };
    expect(isAndroidEmulatorOpenInputKind("open-input")).toBe(true);
    expect(isAndroidEmulatorInputKind("open-input")).toBe(false);
    expect(evaluateAndroidEmulatorRequest(openInput, granted, [booted], sdk)).toMatchObject({
      reason: "approval-required",
    });
    expect(
      evaluateAndroidEmulatorRequest(
        { ...withoutToken, kind: "shutdown", point: undefined, requestedBy: undefined },
        granted,
        [booted],
        sdk,
      ),
    ).toMatchObject({ reason: "approval-required" });
  });

  it("redacts typed characters from durable diagnostic copy", () => {
    expect(redactedAndroidInputDiagnostic({ kind: "type-text", text: "secret" }).message).toBe(
      "type-text completed (length=6; redacted)",
    );
    expect(
      redactedAndroidInputDiagnostic({ kind: "type-text", text: "secret" }).message,
    ).not.toContain("secret");
  });
});
