import { describe, expect, it } from "vitest";
import * as ApplePolicy from "./appleToolchainPolicy";
import {
  evaluateAppleBuildRequest,
  canUseSimulator,
  isSimulatorReady,
  canRecordAppleBuildEvidence,
  requiresSimulatorForAction,
  isCoreAppleCapability,
  isToolchainAvailable,
} from "./appleToolchainPolicy";
import type {
  AppleBuildEvidence,
  AppleBuildRequest,
  AppleSimulatorRecord,
  AppleToolchainDiscovery,
  ToolActionAuthority,
} from "@octant/contracts";

const authority: ToolActionAuthority = {
  hostId: "00000000-0000-4000-8000-000000000004" as any,
  mode: "code",
  projectId: "00000000-0000-4000-8000-000000000005" as any,
  providerInstanceId: "00000000-0000-4000-8000-000000000006" as any,
  extension: { kind: "core" },
};

const availableToolchain: AppleToolchainDiscovery = {
  toolchainId: "00000000-0000-4000-8000-000000000001" as any,
  xcodeVersion: "16.0",
  sdks: [],
  available: true,
  discoveredAt: "2026-07-24T12:00:00.000Z" as any,
};

const unavailableToolchain: AppleToolchainDiscovery = {
  toolchainId: "00000000-0000-4000-8000-000000000002" as any,
  available: false,
  sdks: [],
  discoveredAt: "2026-07-24T12:00:00.000Z" as any,
};

function makeRequest(overrides?: Partial<AppleBuildRequest>): AppleBuildRequest {
  return {
    actionId: "00000000-0000-4000-8000-000000000002" as any,
    correlationId: "00000000-0000-4000-8000-000000000003" as any,
    authority,
    threadId: "00000000-0000-4000-8000-000000000007" as any,
    checkoutId: "00000000-0000-4000-8000-000000000008" as any,
    kind: "build",
    platform: "ios",
    projectPath: "MyApp.xcodeproj",
    timeoutMs: 60_000,
    approval: {
      kind: "approved",
      approvalId: "00000000-0000-4000-8000-000000000009" as any,
    },
    ...overrides,
  };
}

function executionScope(overrides?: Partial<Parameters<typeof evaluateAppleBuildRequest>[2]>) {
  const request = makeRequest();
  return {
    authority,
    threadId: request.threadId,
    checkoutId: request.checkoutId,
    executionPolicy: "full-access" as const,
    approvalValid: true,
    ...overrides,
  };
}

describe("evaluateAppleBuildRequest", () => {
  it("allows matching authority with available toolchain", () => {
    expect(
      evaluateAppleBuildRequest(makeRequest(), availableToolchain, executionScope()).kind,
    ).toBe("allowed");
  });

  it("denies a mismatched thread or checkout before any side effect", () => {
    expect(
      evaluateAppleBuildRequest(
        makeRequest(),
        availableToolchain,
        executionScope({
          threadId: "10000000-0000-4000-8000-000000000001",
        } as any),
      ),
    ).toMatchObject({ kind: "denied", reason: "thread-mismatch" });
  });

  it("denies side effects in Plan and unapproved approval-gated execution", () => {
    const scope = executionScope({
      executionPolicy: "plan",
      approvalValid: false,
    });
    expect(evaluateAppleBuildRequest(makeRequest(), availableToolchain, scope)).toMatchObject({
      kind: "denied",
      reason: "read-only-policy",
    });
    expect(
      evaluateAppleBuildRequest(makeRequest(), availableToolchain, {
        ...scope,
        executionPolicy: "approval-gated",
      }),
    ).toMatchObject({ kind: "denied", reason: "approval-required" });
  });

  it("rejects an extension-owned request for the core Apple capability", () => {
    const extensionAuthority: ToolActionAuthority = {
      ...authority,
      extension: {
        kind: "trusted-extension",
        extensionId: "10000000-0000-4000-8000-000000000001" as any,
      },
    };
    expect(
      evaluateAppleBuildRequest(
        makeRequest({ authority: extensionAuthority }),
        availableToolchain,
        executionScope({ authority: extensionAuthority }),
      ),
    ).toMatchObject({ kind: "denied", reason: "core-capability-required" });
  });

  it("denies mismatched authority", () => {
    const other: ToolActionAuthority = { ...authority, mode: "chat" };
    expect(
      evaluateAppleBuildRequest(
        makeRequest(),
        availableToolchain,
        executionScope({ authority: other }),
      ).kind,
    ).toBe("denied");
  });

  it("denies unavailable toolchain", () => {
    expect(
      evaluateAppleBuildRequest(makeRequest(), unavailableToolchain, executionScope()).kind,
    ).toBe("denied");
  });

  it("denies archive for watchos", () => {
    expect(
      evaluateAppleBuildRequest(
        makeRequest({ kind: "archive", platform: "watchos" }),
        availableToolchain,
        executionScope(),
      ).kind,
    ).toBe("denied");
  });

  it("allows archive for ios", () => {
    expect(
      evaluateAppleBuildRequest(
        makeRequest({ kind: "archive", platform: "ios" }),
        availableToolchain,
        executionScope(),
      ).kind,
    ).toBe("allowed");
  });

  it("keeps an invalid, unavailable, or cross-platform build destination distinct", () => {
    const simulator: AppleSimulatorRecord = {
      simulatorId: "20000000-0000-4000-8000-000000000001" as any,
      name: "iPhone 16",
      platform: "ios",
      runtimeVersion: "18.0",
      state: "shutdown",
      udid: "20000000-0000-4000-8000-000000000001",
    };
    expect(
      evaluateAppleBuildRequest(
        makeRequest({ kind: "run", simulatorId: "20000000-0000-4000-8000-000000000002" as any }),
        availableToolchain,
        executionScope(),
        [simulator],
      ),
    ).toMatchObject({ kind: "denied", reason: "invalid-destination" });
    expect(
      evaluateAppleBuildRequest(
        makeRequest({ kind: "test", simulatorId: simulator.simulatorId }),
        availableToolchain,
        executionScope(),
        [{ ...simulator, state: "unavailable" }],
      ),
    ).toMatchObject({ kind: "denied", reason: "destination-unavailable" });
    expect(
      evaluateAppleBuildRequest(
        makeRequest({ kind: "run", platform: "tvos", simulatorId: simulator.simulatorId }),
        availableToolchain,
        executionScope(),
        [simulator],
      ),
    ).toMatchObject({ kind: "denied", reason: "invalid-destination" });
  });
});

describe("canUseSimulator", () => {
  const sim: AppleSimulatorRecord = {
    simulatorId: "00000000-0000-4000-8000-000000000010" as any,
    name: "iPhone 16",
    platform: "ios",
    runtimeVersion: "18.0",
    state: "booted",
    udid: "ABCD-1234",
  };

  it("returns true for matching platform", () => {
    expect(canUseSimulator(sim, "ios")).toBe(true);
  });

  it("returns false for wrong platform", () => {
    expect(canUseSimulator(sim, "macos")).toBe(false);
  });

  it("returns false for unavailable simulator", () => {
    expect(canUseSimulator({ ...sim, state: "unavailable" }, "ios")).toBe(false);
  });
});

describe("isSimulatorReady", () => {
  it("returns true for booted", () => {
    const sim: AppleSimulatorRecord = {
      simulatorId: "00000000-0000-4000-8000-000000000010" as any,
      name: "iPhone 16",
      platform: "ios",
      runtimeVersion: "18.0",
      state: "booted",
      udid: "ABCD-1234",
    };
    expect(isSimulatorReady(sim)).toBe(true);
  });

  it("returns false for shutdown", () => {
    const sim: AppleSimulatorRecord = {
      simulatorId: "00000000-0000-4000-8000-000000000010" as any,
      name: "iPhone 16",
      platform: "ios",
      runtimeVersion: "18.0",
      state: "shutdown",
      udid: "ABCD-1234",
    };
    expect(isSimulatorReady(sim)).toBe(false);
  });
});

describe("canRecordAppleBuildEvidence", () => {
  const request = makeRequest();
  it("returns true for matching evidence", () => {
    const evidence: AppleBuildEvidence = {
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority,
      kind: "build",
      outcome: "succeeded",
      diagnostics: [],
      artifacts: [],
      cleanup: "not-required",
      durationMs: 1000,
      completedAt: "2026-07-24T12:01:00.000Z" as any,
    };
    expect(canRecordAppleBuildEvidence(evidence, request)).toBe(true);
  });

  it("returns false for mismatched kind", () => {
    const evidence: AppleBuildEvidence = {
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority,
      kind: "test",
      outcome: "succeeded",
      diagnostics: [],
      artifacts: [],
      cleanup: "not-required",
      durationMs: 1000,
      completedAt: "2026-07-24T12:01:00.000Z" as any,
    };
    expect(canRecordAppleBuildEvidence(evidence, request)).toBe(false);
  });
});

describe("evaluateAppleSimulatorRequest", () => {
  it("keeps invalid destination and unavailable state distinct", () => {
    const evaluate = (ApplePolicy as unknown as Record<string, unknown>)
      .evaluateAppleSimulatorRequest;
    expect(evaluate).toBeTypeOf("function");
    const request = {
      actionId: "10000000-0000-4000-8000-000000000001",
      correlationId: "10000000-0000-4000-8000-000000000002",
      authority,
      threadId: makeRequest().threadId,
      checkoutId: makeRequest().checkoutId,
      kind: "boot",
      simulatorId: "10000000-0000-4000-8000-000000000003",
      timeoutMs: 30_000,
      approval: makeRequest().approval,
    } as const;
    const scope = {
      authority,
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      executionPolicy: "full-access" as const,
      approvalValid: true,
    };
    expect((evaluate as Function)(request, scope, [])).toMatchObject({
      kind: "denied",
      reason: "invalid-destination",
    });
    expect(
      (evaluate as Function)(request, scope, [
        {
          simulatorId: request.simulatorId,
          name: "iPhone 16",
          platform: "ios",
          runtimeVersion: "18.0",
          state: "unavailable",
          udid: "ABCD-1234",
        },
      ]),
    ).toMatchObject({ kind: "denied", reason: "destination-unavailable" });
  });
});

describe("requiresSimulatorForAction", () => {
  it("returns true for run on ios", () => {
    expect(requiresSimulatorForAction("run", "ios")).toBe(true);
  });

  it("returns true for test on ios", () => {
    expect(requiresSimulatorForAction("test", "ios")).toBe(true);
  });

  it("returns false for build on ios", () => {
    expect(requiresSimulatorForAction("build", "ios")).toBe(false);
  });

  it("returns false for any action on macos", () => {
    expect(requiresSimulatorForAction("run", "macos")).toBe(false);
    expect(requiresSimulatorForAction("test", "macos")).toBe(false);
  });
});

describe("isCoreAppleCapability", () => {
  it("returns true", () => {
    expect(isCoreAppleCapability()).toBe(true);
  });
});

describe("isToolchainAvailable", () => {
  it("returns true for available toolchain", () => {
    expect(isToolchainAvailable(availableToolchain)).toBe(true);
  });

  it("returns false for unavailable toolchain", () => {
    expect(isToolchainAvailable(unavailableToolchain)).toBe(false);
  });
});
