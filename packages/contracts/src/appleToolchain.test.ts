import { describe, expect, it } from "vitest";
import * as AppleContracts from "./appleToolchain";
import {
  decodeApplePlatform,
  decodeAppleBuildConfiguration,
  decodeAppleToolchainDiscovery,
  decodeAppleSimulatorState,
  decodeAppleSimulatorRecord,
  decodeAppleBuildActionKind,
  decodeAppleBuildRequest,
  decodeAppleBuildOutcome,
  decodeAppleBuildEvidence,
  decodeAppleToolchainFailure,
} from "./appleToolchain";

describe("ApplePlatform", () => {
  it("accepts all valid platforms", () => {
    for (const p of ["ios", "macos", "watchos", "tvos", "visionos"] as const) {
      expect(decodeApplePlatform(p)).toBe(p);
    }
  });
  it("rejects unknown platforms", () => {
    expect(() => decodeApplePlatform("android")).toThrow();
  });
});

describe("AppleBuildConfiguration", () => {
  it("accepts debug and release", () => {
    expect(decodeAppleBuildConfiguration("debug")).toBe("debug");
    expect(decodeAppleBuildConfiguration("release")).toBe("release");
  });
});

describe("AppleToolchainDiscovery", () => {
  it("decodes a discovered toolchain", () => {
    const disc = decodeAppleToolchainDiscovery({
      toolchainId: "00000000-0000-4000-8000-000000000001",
      xcodeVersion: "16.0",
      xcodePath: "/Applications/Xcode.app",
      developerDirectory: "/Applications/Xcode.app/Contents/Developer",
      swiftVersion: "6.0",
      sdks: [
        {
          canonicalName: "iphonesimulator18.0",
          displayName: "iOS Simulator 18.0",
          platform: "ios",
          version: "18.0",
        },
      ],
      available: true,
      discoveredAt: "2026-07-24T12:00:00.000Z",
    });
    expect(disc.available).toBe(true);
    expect(disc.xcodeVersion).toBe("16.0");
  });
  it("decodes an unavailable toolchain", () => {
    const disc = decodeAppleToolchainDiscovery({
      toolchainId: "00000000-0000-4000-8000-000000000002",
      available: false,
      discoveredAt: "2026-07-24T12:00:00.000Z",
    });
    expect(disc.available).toBe(false);
    expect(disc.xcodeVersion).toBeUndefined();
  });
});

describe("AppleSimulatorState", () => {
  it("accepts all valid states", () => {
    for (const s of ["booted", "shutdown", "booting", "shutting-down", "unavailable"] as const) {
      expect(decodeAppleSimulatorState(s)).toBe(s);
    }
  });
});

describe("AppleSimulatorRecord", () => {
  it("decodes a booted simulator", () => {
    const sim = decodeAppleSimulatorRecord({
      simulatorId: "00000000-0000-4000-8000-000000000010",
      name: "iPhone 16 Pro",
      platform: "ios",
      runtimeVersion: "18.0",
      state: "booted",
      udid: "ABCD-1234",
    });
    expect(sim.state).toBe("booted");
    expect(sim.platform).toBe("ios");
  });
});

describe("AppleBuildActionKind", () => {
  it("accepts all valid kinds", () => {
    for (const k of ["build", "test", "run", "clean", "archive"] as const) {
      expect(decodeAppleBuildActionKind(k)).toBe(k);
    }
  });
});

describe("AppleBuildRequest", () => {
  it("decodes a bounded thread and checkout scoped build request", () => {
    const req = decodeAppleBuildRequest({
      actionId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "code",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      threadId: "00000000-0000-4000-8000-000000000007",
      checkoutId: "00000000-0000-4000-8000-000000000008",
      kind: "build",
      platform: "ios",
      projectPath: "Fixtures/SimulatorApp/SimulatorApp.xcodeproj",
      timeoutMs: 120000,
      approval: { kind: "approved", approvalId: "00000000-0000-4000-8000-000000000009" },
    });
    expect(req.kind).toBe("build");
    expect(req.platform).toBe("ios");
  });

  it("rejects raw absolute paths and requests without exact thread authority", () => {
    expect(() =>
      decodeAppleBuildRequest({
        actionId: "00000000-0000-4000-8000-000000000002",
        correlationId: "00000000-0000-4000-8000-000000000003",
        authority: {
          hostId: "00000000-0000-4000-8000-000000000004",
          mode: "code",
          projectId: "00000000-0000-4000-8000-000000000005",
          providerInstanceId: "00000000-0000-4000-8000-000000000006",
          extension: { kind: "core" },
        },
        kind: "build",
        platform: "ios",
        projectPath: "/Users/dev/MyApp.xcodeproj",
      }),
    ).toThrow();
  });
});

describe("AppleBuildOutcome", () => {
  it("accepts all valid outcomes", () => {
    for (const o of [
      "succeeded",
      "failed",
      "cancelled",
      "timed-out",
      "interrupted",
      "unavailable",
      "unauthorized",
      "invalid-destination",
      "process-died",
    ] as const) {
      expect(decodeAppleBuildOutcome(o)).toBe(o);
    }
  });
});

describe("AppleBuildEvidence", () => {
  it("decodes a succeeded build", () => {
    const ev = decodeAppleBuildEvidence({
      actionId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "code",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      kind: "build",
      outcome: "succeeded",
      diagnostics: [],
      artifacts: [{ kind: "log", reference: "apple-log-0001" }],
      cleanup: "not-required",
      durationMs: 45000,
      completedAt: "2026-07-24T12:01:00.000Z",
    });
    expect(ev.outcome).toBe("succeeded");
    expect(ev.durationMs).toBe(45000);
  });

  it("rejects raw artifact paths", () => {
    expect(() =>
      decodeAppleBuildEvidence({
        actionId: "00000000-0000-4000-8000-000000000002",
        correlationId: "00000000-0000-4000-8000-000000000003",
        authority: {
          hostId: "00000000-0000-4000-8000-000000000004",
          mode: "code",
          projectId: "00000000-0000-4000-8000-000000000005",
          providerInstanceId: "00000000-0000-4000-8000-000000000006",
          extension: { kind: "core" },
        },
        kind: "test",
        outcome: "failed",
        diagnostics: [],
        artifacts: [{ kind: "xcresult", reference: "/private/results/Test.xcresult" }],
        cleanup: "complete",
        durationMs: 10,
        completedAt: "2026-07-24T12:01:00.000Z",
      }),
    ).toThrow();
  });
});

describe("AppleToolchainFailure", () => {
  it("decodes each failure category", () => {
    for (const c of [
      "invalid",
      "unauthorized",
      "unavailable",
      "xcode-not-found",
      "simulator-not-found",
      "build-failed",
      "approval-denied",
    ] as const) {
      const f = decodeAppleToolchainFailure({ category: c, message: "test" });
      expect(f.category).toBe(c);
    }
  });
});

describe("Apple runtime contracts", () => {
  const contracts = AppleContracts as unknown as Record<string, unknown>;

  it("decodes scoped Simulator lifecycle requests", () => {
    const decode = contracts.decodeAppleSimulatorRequest;
    expect(decode).toBeTypeOf("function");
    const request = (decode as (value: unknown) => any)({
      actionId: "10000000-0000-4000-8000-000000000001",
      correlationId: "10000000-0000-4000-8000-000000000002",
      authority: {
        hostId: "10000000-0000-4000-8000-000000000003",
        mode: "code",
        projectId: "10000000-0000-4000-8000-000000000004",
        rootId: "10000000-0000-4000-8000-000000000005",
        worktreeId: "10000000-0000-4000-8000-000000000006",
        providerInstanceId: "10000000-0000-4000-8000-000000000007",
        extension: { kind: "core" },
      },
      threadId: "10000000-0000-4000-8000-000000000008",
      checkoutId: "10000000-0000-4000-8000-000000000009",
      kind: "logs",
      simulatorId: "10000000-0000-4000-8000-000000000010",
      bundleIdentifier: "app.octant.fixture",
      timeoutMs: 30000,
      approval: { kind: "not-required" },
    });
    expect(request.kind).toBe("logs");
  });

  it("requires a bundle identity for app log and terminate operations", () => {
    const decode = contracts.decodeAppleSimulatorRequest as (value: unknown) => unknown;
    expect(() =>
      decode({
        actionId: "10000000-0000-4000-8000-000000000001",
        correlationId: "10000000-0000-4000-8000-000000000002",
        authority: {
          hostId: "10000000-0000-4000-8000-000000000003",
          mode: "code",
          projectId: "10000000-0000-4000-8000-000000000004",
          providerInstanceId: "10000000-0000-4000-8000-000000000007",
          extension: { kind: "core" },
        },
        threadId: "10000000-0000-4000-8000-000000000008",
        checkoutId: "10000000-0000-4000-8000-000000000009",
        kind: "terminate",
        simulatorId: "10000000-0000-4000-8000-000000000010",
        timeoutMs: 30000,
        approval: { kind: "approved", approvalId: "10000000-0000-4000-8000-000000000011" },
      }),
    ).toThrow();
  });

  it("decodes replay-safe progress and bounded runtime snapshots", () => {
    const decodeProgress = contracts.decodeAppleActionProgress;
    const decodeSnapshot = contracts.decodeAppleRuntimeSnapshot;
    expect(decodeProgress).toBeTypeOf("function");
    expect(decodeSnapshot).toBeTypeOf("function");
    const progress = (decodeProgress as (value: unknown) => any)({
      actionId: "10000000-0000-4000-8000-000000000001",
      correlationId: "10000000-0000-4000-8000-000000000002",
      authority: {
        hostId: "10000000-0000-4000-8000-000000000003",
        mode: "code",
        projectId: "10000000-0000-4000-8000-000000000004",
        providerInstanceId: "10000000-0000-4000-8000-000000000007",
        extension: { kind: "core" },
      },
      kind: "test",
      state: "running",
      step: "testing",
      sequence: 2,
      updatedAt: "2026-07-27T20:00:00.000Z",
    });
    const snapshot = (decodeSnapshot as (value: unknown) => any)({
      sequence: 2,
      snapshotAt: "2026-07-27T20:00:00.000Z",
      toolchain: {
        toolchainId: "10000000-0000-4000-8000-000000000012",
        available: false,
        discoveredAt: "2026-07-27T20:00:00.000Z",
      },
      simulators: [],
      active: [progress],
      recentEvidence: [],
    });
    expect(snapshot.active[0].step).toBe("testing");
  });

  it("decodes project discovery without exposing an absolute repository path", () => {
    const decodeRequest = contracts.decodeAppleDiscoveryRequest;
    const decodeResult = contracts.decodeAppleWorkspaceDiscovery;
    expect(decodeRequest).toBeTypeOf("function");
    expect(decodeResult).toBeTypeOf("function");
    const request = (decodeRequest as (value: unknown) => any)({
      actionId: "20000000-0000-4000-8000-000000000001",
      correlationId: "20000000-0000-4000-8000-000000000002",
      authority: {
        hostId: "20000000-0000-4000-8000-000000000003",
        mode: "code",
        projectId: "20000000-0000-4000-8000-000000000004",
        providerInstanceId: "20000000-0000-4000-8000-000000000005",
        extension: { kind: "core" },
      },
      threadId: "20000000-0000-4000-8000-000000000006",
      checkoutId: "20000000-0000-4000-8000-000000000007",
      projectPath: "Fixture/Fixture.xcodeproj",
    });
    const result = (decodeResult as (value: unknown) => any)({
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority: request.authority,
      projectPath: request.projectPath,
      projectKind: "xcode-project",
      schemes: ["Fixture"],
      configurations: ["Debug", "Release"],
      targets: ["Fixture", "FixtureTests"],
      sourceRevision: "a".repeat(40),
      discoveredAt: "2026-07-27T20:00:00.000Z",
    });
    expect(result.schemes).toEqual(["Fixture"]);
    expect(JSON.stringify(result)).not.toContain("/Users/");
  });
});
