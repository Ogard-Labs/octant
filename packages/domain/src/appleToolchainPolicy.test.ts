import { describe, expect, it } from "vitest";
import * as ApplePolicy from "./appleToolchainPolicy";
import {
  evaluateAppleBuildRequest,
  evaluateAppleSimulatorRequest,
  canUseSimulator,
  isSimulatorReady,
  canRecordAppleBuildEvidence,
  requiresSimulatorForAction,
  isCoreAppleCapability,
  isToolchainAvailable,
  isAppleSimulatorInputKind,
  isAppleSimulatorOpenInputKind,
  appleActionOpensInputGrant,
  redactedAppleInputDiagnostic,
  evaluateAppleDeviceRequest,
  type AppleDeviceExecutionScope,
  type AppleDeviceHost,
  type AppleDeviceThreadHoldings,
} from "./appleToolchainPolicy";
import {
  decodeAppleDeviceLease,
  decodeAppleDeviceRecord,
  decodeAppleDeviceRequest,
  decodeEventActor,
  decodeToolActionAuthority,
} from "@octant/contracts";
import type {
  AppleBuildEvidence,
  AppleBuildRequest,
  AppleDeviceLease,
  AppleDeviceRecord,
  AppleDeviceRequest,
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

describe("a Simulator screenshot", () => {
  const booted: AppleSimulatorRecord = {
    simulatorId: "10000000-0000-4000-8000-000000000003" as never,
    name: "iPhone 16",
    platform: "ios",
    runtimeVersion: "18.0",
    state: "booted",
    udid: "ABCD-1234",
  };
  const request = {
    actionId: "10000000-0000-4000-8000-000000000001" as never,
    correlationId: "10000000-0000-4000-8000-000000000002" as never,
    authority,
    threadId: makeRequest().threadId,
    checkoutId: makeRequest().checkoutId,
    kind: "screenshot" as const,
    simulatorId: booted.simulatorId,
    timeoutMs: 30_000,
    approval: { kind: "not-required" as const },
  };
  const scope = {
    authority,
    threadId: request.threadId,
    checkoutId: request.checkoutId,
    executionPolicy: "approval-gated" as const,
    approvalValid: false,
  };

  it("reads the screen of a booted Simulator without an approval, like reading its logs", () => {
    expect(evaluateAppleSimulatorRequest(request, scope, [booted])).toEqual({ kind: "allowed" });
  });

  it("stays available in Plan mode because it changes nothing", () => {
    expect(
      evaluateAppleSimulatorRequest(request, { ...scope, executionPolicy: "plan" }, [booted]),
    ).toEqual({ kind: "allowed" });
  });

  it("refuses a Simulator that is not booted, which has no screen to read", () => {
    expect(
      evaluateAppleSimulatorRequest(request, scope, [{ ...booted, state: "shutdown" }]),
    ).toMatchObject({ kind: "denied", reason: "destination-not-booted" });
  });

  it("still refuses a screenshot the user explicitly denied", () => {
    expect(
      evaluateAppleSimulatorRequest(
        {
          ...request,
          approval: { kind: "denied" as const },
        },
        scope,
        [booted],
      ),
    ).toMatchObject({ kind: "denied", reason: "approval-denied" });
  });
});

describe("Simulator frame input", () => {
  const booted: AppleSimulatorRecord = {
    simulatorId: "10000000-0000-4000-8000-000000000003" as never,
    name: "iPhone 16",
    platform: "ios",
    runtimeVersion: "18.0",
    state: "booted",
    udid: "ABCD-1234",
  };
  const actor = {
    kind: "local-user" as const,
    actorId: "10000000-0000-4000-8000-000000000099" as never,
  };
  const tap = {
    actionId: "10000000-0000-4000-8000-000000000001" as never,
    correlationId: "10000000-0000-4000-8000-000000000002" as never,
    authority,
    threadId: makeRequest().threadId,
    checkoutId: makeRequest().checkoutId,
    kind: "tap" as const,
    simulatorId: booted.simulatorId,
    requestedBy: actor,
    point: { x: 12, y: 34 },
    timeoutMs: 30_000,
    approval: {
      kind: "approved" as const,
      approvalId: "10000000-0000-4000-8000-000000000009" as never,
    },
  };
  const scope = {
    authority,
    threadId: tap.threadId,
    checkoutId: tap.checkoutId,
    executionPolicy: "approval-gated" as const,
    approvalValid: true,
  };

  it("lets a Simulator the host holds open take input without a one-shot approval, and nothing else", () => {
    const granted = { ...scope, inputGranted: true };
    const withoutToken = { ...tap, approval: { kind: "not-required" as const } };
    const decide = (request: unknown, scoped: unknown) =>
      ApplePolicy.evaluateAppleSimulatorRequest(request as never, scoped as never, [booted]);

    // The pane sends no approval when the host says the Simulator is open.
    expect(decide(withoutToken, granted)).toEqual({ kind: "allowed" });
    // Without the host's grant the same request is refused, as before.
    expect(decide(withoutToken, scope)).toMatchObject({ reason: "approval-required" });
    // The grant covers input. Shutting the Simulator down still asks.
    const shutdown = {
      ...withoutToken,
      kind: "shutdown" as const,
      point: undefined,
      requestedBy: undefined,
    };
    expect(decide(shutdown, granted)).toMatchObject({ reason: "approval-required" });
    // A denial still wins, and Plan mode is still read-only.
    expect(
      decide({ ...withoutToken, approval: { kind: "denied" as const } }, granted),
    ).toMatchObject({ reason: "approval-denied" });
    expect(decide(withoutToken, { ...granted, executionPolicy: "plan" as const })).toMatchObject({
      reason: "read-only-policy",
    });
  });

  it("treats Allow input as the confirmation that opens a Simulator, not as a click", () => {
    const openInput = {
      ...tap,
      kind: "open-input" as const,
      point: undefined,
    };
    const withoutToken = { ...openInput, approval: { kind: "not-required" as const } };
    expect(isAppleSimulatorOpenInputKind("open-input")).toBe(true);
    expect(isAppleSimulatorInputKind("open-input")).toBe(false);
    expect(evaluateAppleSimulatorRequest(openInput, scope, [booted])).toEqual({ kind: "allowed" });
    expect(
      evaluateAppleSimulatorRequest(withoutToken, { ...scope, inputGranted: true }, [booted]),
    ).toMatchObject({ reason: "approval-required" });
    expect(
      evaluateAppleSimulatorRequest(openInput, scope, [{ ...booted, state: "shutdown" }]),
    ).toMatchObject({ kind: "denied", reason: "destination-not-booted" });
  });

  it("treats tap, type-text, and key-press as destination effects that need a booted Simulator", () => {
    expect(isAppleSimulatorInputKind("tap")).toBe(true);
    expect(evaluateAppleSimulatorRequest(tap, scope, [booted])).toEqual({ kind: "allowed" });
    expect(
      evaluateAppleSimulatorRequest(tap, scope, [{ ...booted, state: "shutdown" }]),
    ).toMatchObject({ kind: "denied", reason: "destination-not-booted" });
  });

  it("treats a swipe as input like a tap, and records where it went without anything typed", () => {
    const swipe = { ...tap, kind: "swipe" as const, toPoint: { x: 12, y: 300 } };
    expect(isAppleSimulatorInputKind("swipe")).toBe(true);
    expect(isAppleSimulatorInputKind("open-input")).toBe(false);
    expect(isAppleSimulatorOpenInputKind("open-input")).toBe(true);
    expect(appleActionOpensInputGrant("open-input")).toBe(true);
    expect(appleActionOpensInputGrant("tap")).toBe(true);
    expect(appleActionOpensInputGrant("shutdown")).toBe(false);
    expect(evaluateAppleSimulatorRequest(swipe, scope, [booted])).toEqual({ kind: "allowed" });
    expect(
      evaluateAppleSimulatorRequest(swipe, { ...scope, executionPolicy: "plan" }, [booted]),
    ).toMatchObject({ kind: "denied", reason: "read-only-policy" });
    expect(redactedAppleInputDiagnostic(swipe).message).toBe(
      "swipe completed (x=12, y=34 to x=12, y=300)",
    );
  });

  it("refuses Plan mode and missing actor attribution for injected input", () => {
    expect(
      evaluateAppleSimulatorRequest(tap, { ...scope, executionPolicy: "plan" }, [booted]),
    ).toMatchObject({ kind: "denied", reason: "read-only-policy" });
    const { requestedBy: _omit, ...withoutActor } = tap;
    expect(
      evaluateAppleSimulatorRequest(withoutActor as typeof tap, scope, [booted]),
    ).toMatchObject({ kind: "denied", reason: "actor-required" });
  });

  it("redacts typed characters from durable diagnostic copy", () => {
    expect(
      redactedAppleInputDiagnostic({
        kind: "type-text",
        text: "super-secret-password",
      }).message,
    ).toBe("type-text completed (length=21; redacted)");
    expect(
      redactedAppleInputDiagnostic({
        kind: "type-text",
        text: "super-secret-password",
      }).message,
    ).not.toContain("super-secret");
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

describe("Simulator input grant", () => {
  it("reads a live grant for one Simulator from the host's snapshot and nothing from an expired or absent one", async () => {
    const { appleInputGrantIsLive } = await import("./appleToolchainPolicy");
    const now = Date.parse("2026-09-19T20:00:00.000Z");
    const snapshot = {
      inputGrants: [
        { simulatorId: "sim-live", expiresAt: "2026-09-19T20:10:00.000Z" },
        { simulatorId: "sim-expired", expiresAt: "2026-09-19T19:59:59.000Z" },
      ],
    } as never;
    expect(appleInputGrantIsLive(snapshot, "sim-live", now)).toBe(true);
    expect(appleInputGrantIsLive(snapshot, "sim-expired", now)).toBe(false);
    expect(appleInputGrantIsLive(snapshot, "sim-other", now)).toBe(false);
    expect(appleInputGrantIsLive(undefined, "sim-live", now)).toBe(false);
    expect(appleInputGrantIsLive({} as never, "sim-live", now)).toBe(false);
  });
});

describe("evaluateAppleDeviceRequest", () => {
  const ids = {
    device: "40000000-0000-4000-8000-000000000001",
    otherDevice: "40000000-0000-4000-8000-000000000002",
    thread: "40000000-0000-4000-8000-000000000007",
    otherThread: "40000000-0000-4000-8000-000000000017",
    checkout: "40000000-0000-4000-8000-000000000008",
    otherCheckout: "40000000-0000-4000-8000-000000000018",
  };
  const deviceAuthority = decodeToolActionAuthority({
    hostId: "40000000-0000-4000-8000-000000000004",
    mode: "code",
    projectId: "40000000-0000-4000-8000-000000000005",
    providerInstanceId: "40000000-0000-4000-8000-000000000006",
    extension: { kind: "core" },
  });
  const agent = decodeEventActor({
    kind: "agent",
    actorId: "40000000-0000-4000-8000-000000000010",
    providerInstanceId: "40000000-0000-4000-8000-000000000006",
    threadId: ids.thread,
  });
  const person = decodeEventActor({
    kind: "local-user",
    actorId: "40000000-0000-4000-8000-000000000011",
  });
  const remotePerson = decodeEventActor({
    kind: "remote-device",
    actorId: "40000000-0000-4000-8000-000000000011",
    deviceId: "40000000-0000-4000-8000-000000000012",
  });
  const approved = { kind: "approved", approvalId: "40000000-0000-4000-8000-000000000009" };
  const postures = ["plan", "approval-gated", "auto-accept-edits", "full-access"] as const;
  type Posture = (typeof postures)[number];

  function device(state = "connected", deviceId = ids.device): AppleDeviceRecord {
    return decodeAppleDeviceRecord({
      deviceId,
      name: "Henrik's iPhone",
      model: "iPhone 16 Pro",
      platform: "ios",
      osVersion: "26.1",
      connection: "wired",
      state,
    });
  }

  function lease(threadId = ids.thread, checkoutId = ids.checkout): AppleDeviceLease {
    return decodeAppleDeviceLease({
      deviceId: ids.device,
      threadId,
      checkoutId,
      grantedBy: { kind: "local-user", actorId: "40000000-0000-4000-8000-000000000011" },
      grantedAt: "2026-10-26T12:00:00.000Z",
    });
  }

  const fieldsByKind: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    build: { projectPath: "Fixture.xcodeproj", teamId: "A1B2C3D4E5" },
    run: { projectPath: "Fixture.xcodeproj", teamId: "A1B2C3D4E5" },
    install: { artifact: "apple-product-1" },
    launch: { bundleIdentifier: "sh.octant.Fixture" },
    terminate: { bundleIdentifier: "sh.octant.Fixture" },
    uninstall: { bundleIdentifier: "sh.octant.Fixture" },
    logs: { bundleIdentifier: "sh.octant.Fixture" },
  };

  const distributionKinds: ReadonlyArray<string> = [
    "upload",
    "submit-for-review",
    "release-version",
  ];

  function deviceRequest(
    kind: string,
    overrides: Readonly<Record<string, unknown>> = {},
  ): AppleDeviceRequest {
    const targetsNoDevice = kind === "discover" || distributionKinds.includes(kind);
    return decodeAppleDeviceRequest({
      actionId: "40000000-0000-4000-8000-000000000002",
      correlationId: "40000000-0000-4000-8000-000000000003",
      authority: deviceAuthority,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      kind,
      requestedBy: agent,
      ...(targetsNoDevice ? {} : { deviceId: ids.device }),
      timeoutMs: 60_000,
      approval: { kind: "not-required" },
      ...fieldsByKind[kind],
      ...overrides,
    });
  }

  const threadScope = deviceRequest("status");
  function scope(
    executionPolicy: Posture,
    overrides: Partial<AppleDeviceExecutionScope> = {},
  ): AppleDeviceExecutionScope {
    return {
      authority: deviceAuthority,
      threadId: threadScope.threadId,
      checkoutId: threadScope.checkoutId,
      executionPolicy,
      approvalValid: false,
      ...overrides,
    };
  }
  function approvedScope(executionPolicy: Posture, approvedBy = person) {
    return scope(executionPolicy, { approvalValid: true, approvedBy });
  }

  const mac: AppleDeviceHost = {
    macos: true,
    toolchain: availableToolchain,
    tooling: [
      "list-devices",
      "install-app",
      "launch-app",
      "terminate-process",
      "uninstall-app",
      "screenshot",
      "console-logs",
    ],
    devices: [device()],
    leases: [lease()],
    distributionEnabled: false,
  };
  // The upload row of the authority table, as it will apply once the release
  // boundary admits distribution.
  const distributing: AppleDeviceHost = { ...mac, distributionEnabled: true };
  const holdings: AppleDeviceThreadHoldings = {
    builtProducts: [deviceRequest("install").artifact ?? "apple-product-1"],
    installed: [{ deviceId: device().deviceId, bundleIdentifier: "sh.octant.Fixture" }],
    launched: [{ deviceId: device().deviceId, bundleIdentifier: "sh.octant.Fixture" }],
  };
  const nothingHeld: AppleDeviceThreadHoldings = { builtProducts: [], installed: [], launched: [] };

  const allowed = { kind: "allowed" };
  const denied = (reason: string) => ({ kind: "denied", reason });

  describe("the per-operation authority table", () => {
    it("runs discover and status under every posture without a lease or approval", () => {
      for (const posture of postures) {
        for (const kind of ["discover", "status"]) {
          expect(
            evaluateAppleDeviceRequest(
              deviceRequest(kind),
              scope(posture),
              { ...mac, leases: [] },
              nothingHeld,
            ),
          ).toEqual(allowed);
        }
      }
    });

    it("asks a person to start a lease under every posture, Full access and Plan included", () => {
      const host = { ...mac, leases: [] };
      for (const posture of postures) {
        expect(
          evaluateAppleDeviceRequest(deviceRequest("use-device"), scope(posture), host, holdings),
        ).toEqual(denied("confirmation-required"));
        expect(
          evaluateAppleDeviceRequest(
            deviceRequest("use-device", { approval: approved }),
            approvedScope(posture),
            host,
            holdings,
          ),
        ).toEqual(allowed);
      }
    });

    it("lets a thread end its own lease under every posture", () => {
      for (const posture of postures) {
        expect(
          evaluateAppleDeviceRequest(
            deviceRequest("release-device"),
            scope(posture),
            mac,
            holdings,
          ),
        ).toEqual(allowed);
      }
    });

    it("reads a screenshot and its own process's console inside the lease under every posture", () => {
      for (const posture of postures) {
        for (const kind of ["screenshot", "logs"]) {
          expect(
            evaluateAppleDeviceRequest(deviceRequest(kind), scope(posture), mac, holdings),
          ).toEqual(allowed);
        }
      }
    });

    it("refuses build, run, install, launch, and terminate in Plan, asks per request when gated, and runs under Full access", () => {
      for (const kind of ["build", "run", "install", "launch", "terminate"]) {
        expect(
          evaluateAppleDeviceRequest(
            deviceRequest(kind, { approval: approved }),
            approvedScope("plan"),
            mac,
            holdings,
          ),
        ).toEqual(denied("read-only-policy"));
        for (const posture of ["approval-gated", "auto-accept-edits"] as const) {
          expect(
            evaluateAppleDeviceRequest(deviceRequest(kind), scope(posture), mac, holdings),
          ).toEqual(denied("approval-required"));
          expect(
            evaluateAppleDeviceRequest(
              deviceRequest(kind, { approval: approved }),
              approvedScope(posture, agent),
              mac,
              holdings,
            ),
          ).toEqual(allowed);
        }
        expect(
          evaluateAppleDeviceRequest(deviceRequest(kind), scope("full-access"), mac, holdings),
        ).toEqual(allowed);
      }
    });

    it("uninstalls only when a person asks and confirms, and never in Plan", () => {
      const asked = deviceRequest("uninstall", { requestedBy: person, approval: approved });
      expect(evaluateAppleDeviceRequest(asked, approvedScope("plan"), mac, holdings)).toEqual(
        denied("read-only-policy"),
      );
      for (const posture of ["approval-gated", "auto-accept-edits", "full-access"] as const) {
        expect(
          evaluateAppleDeviceRequest(
            deviceRequest("uninstall", { requestedBy: person }),
            scope(posture),
            mac,
            holdings,
          ),
        ).toEqual(denied("confirmation-required"));
        expect(evaluateAppleDeviceRequest(asked, approvedScope(posture), mac, holdings)).toEqual(
          allowed,
        );
        expect(
          evaluateAppleDeviceRequest(
            deviceRequest("uninstall", { approval: approved }),
            approvedScope(posture),
            mac,
            holdings,
          ),
        ).toEqual(denied("person-required"));
      }
    });

    it("never offers a provisioning update, whoever asks and under any posture", () => {
      for (const posture of postures) {
        for (const requestedBy of [agent, person]) {
          expect(
            evaluateAppleDeviceRequest(
              deviceRequest("provisioning-update", { requestedBy, approval: approved }),
              approvedScope(posture),
              mac,
              holdings,
            ),
          ).toEqual(denied("provisioning-updates-not-offered"));
        }
      }
    });

    it("uploads, submits for App Review, and releases only when a person at the Mac asks and confirms, never in Plan and never for an agent", () => {
      for (const kind of distributionKinds) {
        const asked = deviceRequest(kind, { requestedBy: person, approval: approved });
        expect(
          evaluateAppleDeviceRequest(asked, approvedScope("plan"), distributing, nothingHeld),
        ).toEqual(denied("read-only-policy"));
        for (const posture of ["approval-gated", "auto-accept-edits", "full-access"] as const) {
          expect(
            evaluateAppleDeviceRequest(
              deviceRequest(kind, { requestedBy: person }),
              scope(posture),
              distributing,
              nothingHeld,
            ),
          ).toEqual(denied("confirmation-required"));
          expect(
            evaluateAppleDeviceRequest(asked, approvedScope(posture), distributing, nothingHeld),
          ).toEqual(allowed);
          expect(
            evaluateAppleDeviceRequest(
              deviceRequest(kind, { approval: approved }),
              approvedScope(posture),
              distributing,
              nothingHeld,
            ),
          ).toEqual(denied("person-required"));
        }
      }
    });

    it("refuses every distribution step while the release boundary does not admit distribution", () => {
      for (const kind of distributionKinds) {
        for (const posture of postures) {
          for (const requestedBy of [agent, person, remotePerson]) {
            expect(
              evaluateAppleDeviceRequest(
                deviceRequest(kind, { requestedBy, approval: approved }),
                approvedScope(posture),
                mac,
                nothingHeld,
              ),
            ).toEqual(denied("distribution-not-enabled"));
          }
        }
      }
    });
  });

  describe("refusals", () => {
    it("refuses every device and distribution request on a host that is not a Mac", () => {
      const linux = { ...mac, macos: false };
      for (const kind of [
        "discover",
        "status",
        "use-device",
        "release-device",
        "screenshot",
        "logs",
        "build",
        "run",
        "install",
        "launch",
        "terminate",
        "uninstall",
        "provisioning-update",
        ...distributionKinds,
      ]) {
        expect(
          evaluateAppleDeviceRequest(
            deviceRequest(kind, { requestedBy: person, approval: approved }),
            approvedScope("full-access"),
            linux,
            holdings,
          ),
        ).toEqual(denied("toolchain-unavailable"));
      }
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("discover"),
          scope("full-access"),
          { ...mac, toolchain: unavailableToolchain },
          holdings,
        ),
      ).toEqual(denied("toolchain-unavailable"));
    });

    it("refuses a request outside the thread's own Code authority", () => {
      const extension = decodeToolActionAuthority({
        ...deviceAuthority,
        extension: {
          kind: "trusted-extension",
          extensionId: "40000000-0000-4000-8000-000000000020",
        },
      });
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("status", { authority: extension }),
          scope("full-access", { authority: extension }),
          mac,
          holdings,
        ),
      ).toEqual(denied("core-capability-required"));
      const chat = decodeToolActionAuthority({ ...deviceAuthority, mode: "chat" });
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("status", { authority: chat }),
          scope("full-access", { authority: chat }),
          mac,
          holdings,
        ),
      ).toEqual(denied("code-mode-required"));
      const otherProject = decodeToolActionAuthority({
        ...deviceAuthority,
        projectId: "40000000-0000-4000-8000-000000000021",
      });
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("status"),
          scope("full-access", { authority: otherProject }),
          mac,
          holdings,
        ),
      ).toEqual(denied("authority-mismatch"));
      const otherThread = deviceRequest("status", { threadId: ids.otherThread });
      expect(evaluateAppleDeviceRequest(otherThread, scope("full-access"), mac, holdings)).toEqual(
        denied("thread-mismatch"),
      );
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("status", { checkoutId: ids.otherCheckout }),
          scope("full-access"),
          mac,
          holdings,
        ),
      ).toEqual(denied("checkout-mismatch"));
    });

    it("refuses an agent acting for a different thread than the request names", () => {
      const strayAgent = decodeEventActor({ ...agent, threadId: ids.otherThread });
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("status", { requestedBy: strayAgent }),
          scope("full-access"),
          mac,
          holdings,
        ),
      ).toEqual(denied("thread-mismatch"));
    });

    it("reports an operation the selected Xcode's tooling does not offer as unavailable", () => {
      const noScreenshot = { ...mac, tooling: mac.tooling.filter((op) => op !== "screenshot") };
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("screenshot"),
          scope("plan"),
          noScreenshot,
          holdings,
        ),
      ).toEqual(denied("operation-unavailable"));
      const noLaunch = { ...mac, tooling: mac.tooling.filter((op) => op !== "launch-app") };
      expect(
        evaluateAppleDeviceRequest(deviceRequest("run"), scope("full-access"), noLaunch, holdings),
      ).toEqual(denied("operation-unavailable"));
      const noListing = { ...mac, tooling: [] };
      expect(
        evaluateAppleDeviceRequest(deviceRequest("discover"), scope("plan"), noListing, holdings),
      ).toEqual(denied("operation-unavailable"));
    });

    it("lets a remote person observe device status and nothing else", () => {
      for (const kind of ["discover", "status"]) {
        expect(
          evaluateAppleDeviceRequest(
            deviceRequest(kind, { requestedBy: remotePerson }),
            scope("full-access"),
            mac,
            holdings,
          ),
        ).toEqual(allowed);
      }
      for (const kind of [
        "use-device",
        "release-device",
        "screenshot",
        "logs",
        "build",
        "run",
        "install",
        "launch",
        "terminate",
        "uninstall",
        ...distributionKinds,
      ]) {
        expect(
          evaluateAppleDeviceRequest(
            deviceRequest(kind, { requestedBy: remotePerson, approval: approved }),
            approvedScope("full-access", remotePerson),
            distributing,
            holdings,
          ),
        ).toEqual(denied("local-person-required"));
      }
    });

    it("never takes a lease, uninstall, or distribution confirmation from a remote device", () => {
      for (const [kind, requestedBy, host] of [
        ["use-device", agent, { ...mac, leases: [] }],
        ["uninstall", person, mac],
        ["upload", person, distributing],
        ["submit-for-review", person, distributing],
        ["release-version", person, distributing],
      ] as const) {
        expect(
          evaluateAppleDeviceRequest(
            deviceRequest(kind, { requestedBy, approval: approved }),
            approvedScope("full-access", remotePerson),
            host,
            holdings,
          ),
        ).toEqual(denied("local-person-required"));
      }
    });

    it("refuses an approval the person denied", () => {
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("install", { approval: { kind: "denied" } }),
          scope("approval-gated"),
          mac,
          holdings,
        ),
      ).toEqual(denied("approval-denied"));
    });

    it("refuses an approval the host did not validate for this request", () => {
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("install", { approval: approved }),
          scope("approval-gated"),
          mac,
          holdings,
        ),
      ).toEqual(denied("approval-required"));
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("use-device", { approval: approved }),
          scope("full-access", { approvedBy: person }),
          { ...mac, leases: [] },
          holdings,
        ),
      ).toEqual(denied("confirmation-required"));
    });

    it("refuses a device the host does not know", () => {
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("status", { deviceId: ids.otherDevice }),
          scope("full-access"),
          mac,
          holdings,
        ),
      ).toEqual(denied("invalid-destination"));
    });

    it("refuses another thread's request for a leased device without naming the holder", () => {
      const heldElsewhere = { ...mac, leases: [lease(ids.otherThread, ids.otherCheckout)] };
      for (const kind of ["use-device", "screenshot", "install", "release-device"]) {
        const decision = evaluateAppleDeviceRequest(
          deviceRequest(kind, { approval: approved }),
          approvedScope("full-access"),
          heldElsewhere,
          holdings,
        );
        expect(decision).toEqual(denied("destination-leased"));
        expect(JSON.stringify(decision)).not.toContain(ids.otherThread);
      }
    });

    it("lets only a person at the Mac move a lease, naming the thread that holds it", () => {
      const heldElsewhere = { ...mac, leases: [lease(ids.otherThread, ids.otherCheckout)] };
      const move = deviceRequest("use-device", {
        requestedBy: person,
        fromThreadId: ids.otherThread,
        approval: approved,
      });
      expect(
        evaluateAppleDeviceRequest(move, approvedScope("plan"), heldElsewhere, holdings),
      ).toEqual(allowed);
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("use-device", {
            fromThreadId: ids.otherThread,
            approval: approved,
          }),
          approvedScope("full-access"),
          heldElsewhere,
          holdings,
        ),
      ).toEqual(denied("person-required"));
      // The confirmation named a holder that no longer holds the device.
      for (const host of [
        { ...mac, leases: [] },
        { ...mac, leases: [lease(ids.thread, ids.checkout)] },
      ]) {
        expect(evaluateAppleDeviceRequest(move, approvedScope("plan"), host, holdings)).toEqual(
          denied("lease-changed"),
        );
      }
    });

    it("starts no new confirmation for a lease the thread already holds", () => {
      expect(
        evaluateAppleDeviceRequest(deviceRequest("use-device"), scope("plan"), mac, holdings),
      ).toEqual(allowed);
    });

    it("refuses every operation inside a lease the thread does not hold", () => {
      const host = { ...mac, leases: [] };
      for (const kind of [
        "release-device",
        "screenshot",
        "logs",
        "build",
        "run",
        "install",
        "launch",
        "terminate",
      ]) {
        expect(
          evaluateAppleDeviceRequest(deviceRequest(kind), scope("full-access"), host, holdings),
        ).toEqual(denied("lease-required"));
      }
      // A lease bound to the thread's earlier checkout does not survive a rebind.
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("install"),
          scope("full-access"),
          { ...mac, leases: [lease(ids.thread, ids.otherCheckout)] },
          holdings,
        ),
      ).toEqual(denied("lease-required"));
    });

    it("refuses an operation on the device with the state that stops it", () => {
      for (const state of ["locked", "developer-mode-off", "untrusted", "unavailable"]) {
        const host = { ...mac, devices: [device(state)] };
        for (const kind of ["screenshot", "logs", "run", "install", "launch", "terminate"]) {
          expect(
            evaluateAppleDeviceRequest(deviceRequest(kind), scope("full-access"), host, holdings),
          ).toEqual(denied(state));
        }
        expect(
          evaluateAppleDeviceRequest(deviceRequest("status"), scope("plan"), host, holdings),
        ).toEqual(allowed);
      }
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("use-device", { approval: approved }),
          approvedScope("full-access"),
          { ...mac, leases: [], devices: [device("unavailable")] },
          holdings,
        ),
      ).toEqual(denied("unavailable"));
    });

    it("installs only a product this thread's own build produced", () => {
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("install", { artifact: "apple-product-elsewhere" }),
          scope("full-access"),
          mac,
          holdings,
        ),
      ).toEqual(denied("invalid-artifact"));
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("install"),
          scope("full-access"),
          mac,
          nothingHeld,
        ),
      ).toEqual(denied("invalid-artifact"));
    });

    it("launches, stops, reads, or removes only the bundle Octant installed for this thread", () => {
      for (const kind of ["launch", "terminate", "logs"]) {
        expect(
          evaluateAppleDeviceRequest(
            deviceRequest(kind, { bundleIdentifier: "com.apple.mobilesafari" }),
            scope("full-access"),
            mac,
            holdings,
          ),
        ).toEqual(denied("foreign-bundle"));
      }
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("uninstall", {
            requestedBy: person,
            bundleIdentifier: "com.apple.mobilesafari",
            approval: approved,
          }),
          approvedScope("full-access"),
          mac,
          holdings,
        ),
      ).toEqual(denied("foreign-bundle"));
      // An install on another device is not an install on this one.
      const installedElsewhere = {
        ...holdings,
        installed: [
          {
            deviceId: device("connected", ids.otherDevice).deviceId,
            bundleIdentifier: "sh.octant.Fixture",
          },
        ],
      };
      expect(
        evaluateAppleDeviceRequest(
          deviceRequest("launch"),
          scope("full-access"),
          mac,
          installedElsewhere,
        ),
      ).toEqual(denied("foreign-bundle"));
    });

    it("refuses a call that would fail anyway before asking anyone to approve or confirm it", () => {
      const locked = { ...mac, devices: [device("locked")] };
      const heldElsewhere = { ...mac, leases: [lease(ids.otherThread, ids.otherCheckout)] };
      const noInstall = { ...mac, tooling: mac.tooling.filter((op) => op !== "install-app") };
      for (const [request, host, reason] of [
        [deviceRequest("install"), locked, "locked"],
        [deviceRequest("install"), noInstall, "operation-unavailable"],
        [
          deviceRequest("launch", { bundleIdentifier: "com.apple.mobilesafari" }),
          mac,
          "foreign-bundle",
        ],
        [deviceRequest("uninstall", { requestedBy: person }), locked, "locked"],
        [deviceRequest("use-device"), heldElsewhere, "destination-leased"],
      ] as const) {
        expect(
          evaluateAppleDeviceRequest(request, scope("approval-gated"), host, holdings),
        ).toEqual(denied(reason));
      }
    });

    it("stops and reads only a process Octant launched", () => {
      const notLaunched = { ...holdings, launched: [] };
      for (const kind of ["terminate", "logs"]) {
        expect(
          evaluateAppleDeviceRequest(deviceRequest(kind), scope("full-access"), mac, notLaunched),
        ).toEqual(denied("process-not-owned"));
      }
    });
  });
});
