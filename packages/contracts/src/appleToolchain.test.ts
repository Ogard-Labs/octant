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

  it("rejects Simulator input evidence without requestedBy", () => {
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
        kind: "tap",
        outcome: "succeeded",
        diagnostics: [{ severity: "note", message: "tap completed (x=1, y=2)" }],
        artifacts: [],
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

  it("decodes a failure without a step, as an older host sends it", () => {
    const failure = decodeAppleToolchainFailure({ category: "unavailable", message: "incomplete" });
    expect(failure).not.toHaveProperty("step");
  });

  it("decodes the discovery step a host names and rejects one it does not know", () => {
    for (const step of ["xcode", "licence", "runtime", "project"] as const) {
      expect(
        decodeAppleToolchainFailure({ category: "unavailable", message: "incomplete", step }),
      ).toMatchObject({ step });
    }
    expect(() =>
      decodeAppleToolchainFailure({ category: "unavailable", message: "incomplete", step: "x" }),
    ).toThrow();
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

  it("decodes tap, type-text, and key-press with actor attribution", () => {
    const decode = contracts.decodeAppleSimulatorRequest as (value: unknown) => any;
    const base = {
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
      simulatorId: "10000000-0000-4000-8000-000000000010",
      timeoutMs: 30000,
      approval: { kind: "approved", approvalId: "10000000-0000-4000-8000-000000000011" },
      requestedBy: {
        kind: "local-user",
        actorId: "10000000-0000-4000-8000-000000000012",
      },
    };
    expect(decode({ ...base, kind: "tap", point: { x: 1, y: 2 } }).kind).toBe("tap");
    expect(decode({ ...base, kind: "type-text", text: "hello" }).text).toBe("hello");
    expect(decode({ ...base, kind: "type-text", text: " spaced " }).text).toBe(" spaced ");
    expect(decode({ ...base, kind: "key-press", key: "return" }).key).toBe("return");
    expect(decode({ ...base, kind: "open-input" }).kind).toBe("open-input");
    expect(() => decode({ ...base, kind: "open-input", requestedBy: undefined })).toThrow();
    expect(() => decode({ ...base, kind: "tap" })).toThrow();
    expect(() =>
      decode({ ...base, kind: "type-text", text: "hello", requestedBy: undefined }),
    ).toThrow();
    expect(() => decode({ ...base, kind: "type-text", text: "   " })).toThrow();
  });

  it("decodes a swipe only with both ends, a bounded duration, and an actor", () => {
    const decode = contracts.decodeAppleSimulatorRequest as (value: unknown) => any;
    const swipe = {
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
      simulatorId: "10000000-0000-4000-8000-000000000010",
      timeoutMs: 30000,
      approval: { kind: "approved", approvalId: "10000000-0000-4000-8000-000000000011" },
      requestedBy: { kind: "local-user", actorId: "10000000-0000-4000-8000-000000000012" },
      kind: "swipe",
      point: { x: 600, y: 2000 },
      toPoint: { x: 600, y: 800 },
      durationMs: 250,
    };
    expect(decode(swipe).toPoint).toEqual({ x: 600, y: 800 });
    const { durationMs: _duration, ...untimed } = swipe;
    expect(decode(untimed).kind).toBe("swipe");
    const { toPoint: _end, ...oneEnded } = swipe;
    expect(() => decode(oneEnded)).toThrow();
    expect(() => decode({ ...swipe, durationMs: 60_000 })).toThrow();
    expect(() => decode({ ...swipe, requestedBy: undefined })).toThrow();
  });

  it("decodes Open URL only with an http(s) address and the person who asked", () => {
    const decode = contracts.decodeAppleSimulatorRequest as (value: unknown) => any;
    const openUrl = {
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
      simulatorId: "10000000-0000-4000-8000-000000000010",
      timeoutMs: 30000,
      approval: { kind: "approved", approvalId: "10000000-0000-4000-8000-000000000011" },
      requestedBy: { kind: "local-user", actorId: "10000000-0000-4000-8000-000000000012" },
      kind: "open-url",
      url: "https://example.com/welcome?from=octant",
    };
    expect(decode(openUrl).url).toBe("https://example.com/welcome?from=octant");
    expect(() => decode({ ...openUrl, url: undefined })).toThrow();
    expect(() => decode({ ...openUrl, requestedBy: undefined })).toThrow();
    expect(() => decode({ ...openUrl, url: "javascript:alert(1)" })).toThrow();
    expect(() => decode({ ...openUrl, url: "file:///etc/hosts" })).toThrow();
  });

  it("decodes Rotate only with the person who asked, and an orientation when one is named", () => {
    const decode = contracts.decodeAppleSimulatorRequest as (value: unknown) => any;
    const rotate = {
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
      simulatorId: "10000000-0000-4000-8000-000000000010",
      timeoutMs: 30000,
      approval: { kind: "approved", approvalId: "10000000-0000-4000-8000-000000000011" },
      requestedBy: { kind: "local-user", actorId: "10000000-0000-4000-8000-000000000012" },
      kind: "rotate",
      orientation: "landscape",
    };
    expect(decode(rotate).orientation).toBe("landscape");
    // Without one, the host turns the Simulator the other way.
    expect(decode({ ...rotate, orientation: undefined }).orientation).toBeUndefined();
    expect(() => decode({ ...rotate, requestedBy: undefined })).toThrow();
    expect(() => decode({ ...rotate, orientation: "upside-down" })).toThrow();
  });

  it("decodes screen recording only with the person who asked, and lists live recordings", () => {
    const decode = contracts.decodeAppleSimulatorRequest as (value: unknown) => any;
    const base = {
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
      simulatorId: "10000000-0000-4000-8000-000000000010",
      timeoutMs: 30000,
      approval: { kind: "approved", approvalId: "10000000-0000-4000-8000-000000000011" },
      requestedBy: { kind: "local-user", actorId: "10000000-0000-4000-8000-000000000012" },
    };
    for (const kind of ["start-recording", "stop-recording"]) {
      expect(decode({ ...base, kind }).kind).toBe(kind);
      expect(() => decode({ ...base, kind, requestedBy: undefined })).toThrow();
    }
    const decodeSnapshot = contracts.decodeAppleRuntimeSnapshot as (value: unknown) => any;
    const snapshot = {
      sequence: 1,
      snapshotAt: "2026-10-14T20:00:00.000Z",
      toolchain: {
        toolchainId: "10000000-0000-4000-8000-000000000012",
        available: true,
        discoveredAt: "2026-10-14T20:00:00.000Z",
      },
      simulators: [],
      active: [],
      recentEvidence: [],
      capabilities: { recordScreen: true },
      recordings: [
        {
          simulatorId: "10000000-0000-4000-8000-000000000010",
          startedAt: "2026-10-14T20:00:00.000Z",
        },
      ],
    };
    expect(decodeSnapshot(snapshot).recordings).toHaveLength(1);
    expect(decodeSnapshot(snapshot).capabilities).toEqual({ recordScreen: true });
  });

  it("tells the pane which newer device actions the host performs", () => {
    const decodeSnapshot = contracts.decodeAppleRuntimeSnapshot as (value: unknown) => any;
    const older = {
      sequence: 1,
      snapshotAt: "2026-10-14T20:00:00.000Z",
      toolchain: {
        toolchainId: "10000000-0000-4000-8000-000000000012",
        available: true,
        discoveredAt: "2026-10-14T20:00:00.000Z",
      },
      simulators: [],
      active: [],
      recentEvidence: [],
    };
    // A host that predates the flag says nothing, and the pane offers nothing.
    expect(decodeSnapshot(older).capabilities).toBeUndefined();
    expect(decodeSnapshot({ ...older, capabilities: { openUrl: true } }).capabilities).toEqual({
      openUrl: true,
    });
    expect(decodeSnapshot({ ...older, capabilities: { rotate: true } }).capabilities).toEqual({
      rotate: true,
    });
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
    expect(snapshot.paneOpenRequest).toBeUndefined();
    const opening = (decodeSnapshot as (value: unknown) => any)({
      ...snapshot,
      paneOpenRequest: {
        requestId: "10000000-0000-4000-8000-000000000013",
        simulatorId: "10000000-0000-4000-8000-000000000014",
        requestedAt: "2026-07-27T20:00:01.000Z",
      },
    });
    expect(opening.paneOpenRequest.simulatorId).toBe("10000000-0000-4000-8000-000000000014");
    expect(() =>
      (decodeSnapshot as (value: unknown) => any)({
        ...snapshot,
        paneOpenRequest: {
          requestId: "not-a-uuid",
          simulatorId: "10000000-0000-4000-8000-000000000014",
          requestedAt: "2026-07-27T20:00:01.000Z",
        },
      }),
    ).toThrow();
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

  it("accepts a Simulator screen capture that names no application", () => {
    const decode = contracts.decodeAppleSimulatorRequest as (value: unknown) => any;
    const request = {
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
      kind: "screenshot",
      simulatorId: "20000000-0000-4000-8000-000000000008",
      timeoutMs: 30_000,
      approval: { kind: "not-required" },
    };

    expect(decode(request).kind).toBe("screenshot");
    // Terminating an app or reading its logs still has to name one.
    expect(() => decode({ ...request, kind: "logs" })).toThrow();
  });

  it("records a captured screen as evidence of a screenshot action", () => {
    const decode = contracts.decodeAppleBuildEvidence as (value: unknown) => any;
    const evidence = decode({
      actionId: "20000000-0000-4000-8000-000000000001",
      correlationId: "20000000-0000-4000-8000-000000000002",
      authority: {
        hostId: "20000000-0000-4000-8000-000000000003",
        mode: "code",
        projectId: "20000000-0000-4000-8000-000000000004",
        providerInstanceId: "20000000-0000-4000-8000-000000000005",
        extension: { kind: "core" },
      },
      kind: "screenshot",
      outcome: "succeeded",
      diagnostics: [],
      artifacts: [{ kind: "screenshot", reference: "apple-screenshot-1" }],
      cleanup: "not-required",
      durationMs: 120,
      completedAt: "2026-07-27T20:00:00.000Z",
    });

    expect(evidence.artifacts[0].kind).toBe("screenshot");
    expect(
      (contracts.decodeAppleActionProgress as (value: unknown) => any)({
        actionId: evidence.actionId,
        correlationId: evidence.correlationId,
        authority: evidence.authority,
        kind: "screenshot",
        state: "running",
        step: "capturing-screen",
        sequence: 1,
        updatedAt: "2026-07-27T20:00:00.000Z",
      }).step,
    ).toBe("capturing-screen");
  });
});

describe("Apple physical device contracts", () => {
  const device = {
    deviceId: "30000000-0000-4000-8000-000000000001",
    name: "Henrik's iPhone",
    model: "iPhone 16 Pro",
    platform: "ios",
    osVersion: "26.1",
    connection: "wired",
    state: "connected",
  };
  const agent = {
    kind: "agent",
    actorId: "30000000-0000-4000-8000-000000000010",
    providerInstanceId: "30000000-0000-4000-8000-000000000011",
    threadId: "30000000-0000-4000-8000-000000000007",
  };
  const request = {
    actionId: "30000000-0000-4000-8000-000000000002",
    correlationId: "30000000-0000-4000-8000-000000000003",
    authority: {
      hostId: "30000000-0000-4000-8000-000000000004",
      mode: "code",
      projectId: "30000000-0000-4000-8000-000000000005",
      providerInstanceId: "30000000-0000-4000-8000-000000000006",
      extension: { kind: "core" },
    },
    threadId: "30000000-0000-4000-8000-000000000007",
    checkoutId: "30000000-0000-4000-8000-000000000008",
    kind: "status",
    deviceId: device.deviceId,
    requestedBy: agent,
    timeoutMs: 30_000,
    approval: { kind: "not-required" },
  };

  it("keeps a device's hardware identifiers out of the record the agent and remotes see", () => {
    expect(AppleContracts.decodeAppleDeviceRecord(device).name).toBe("Henrik's iPhone");
    for (const identifier of ["udid", "serialNumber", "ecid", "coreDeviceIdentifier"]) {
      expect(() =>
        AppleContracts.decodeAppleDeviceRecord({ ...device, [identifier]: "00008140-000A" }),
      ).toThrow();
    }
  });

  it("admits only iPhone and iPad hardware as a device destination", () => {
    expect(() =>
      AppleContracts.decodeAppleDeviceRecord({ ...device, platform: "watchos" }),
    ).toThrow();
  });

  it("reports every device state the policy refuses by", () => {
    for (const state of ["connected", "locked", "developer-mode-off", "untrusted", "unavailable"]) {
      expect(AppleContracts.decodeAppleDeviceRecord({ ...device, state }).state).toBe(state);
    }
  });

  it("refuses a device request that does not say who asked for it", () => {
    const { requestedBy: _requestedBy, ...anonymous } = request;
    expect(() => AppleContracts.decodeAppleDeviceRequest(anonymous)).toThrow();
  });

  it("has no way to ask a build for provisioning updates", () => {
    const build = {
      ...request,
      kind: "build",
      projectPath: "App.xcodeproj",
      teamId: "A1B2C3D4E5",
      approval: { kind: "pending" },
    };
    expect(AppleContracts.decodeAppleDeviceRequest(build).teamId).toBe("A1B2C3D4E5");
    expect(() =>
      AppleContracts.decodeAppleDeviceRequest({ ...build, allowProvisioningUpdates: true }),
    ).toThrow();
    // Signing is selected by team; a build without one cannot be signed for a device.
    const { teamId: _teamId, ...unsigned } = build;
    expect(() => AppleContracts.decodeAppleDeviceRequest(unsigned)).toThrow();
    expect(() =>
      AppleContracts.decodeAppleDeviceRequest({ ...build, teamId: "not-a-team" }),
    ).toThrow();
  });

  it("installs only an Octant-held product reference, never a path", () => {
    const install = { ...request, kind: "install", artifact: "apple-product-1" };
    expect(AppleContracts.decodeAppleDeviceRequest(install).artifact).toBe("apple-product-1");
    expect(() =>
      AppleContracts.decodeAppleDeviceRequest({ ...install, artifact: "/Users/me/Other.app" }),
    ).toThrow();
    expect(() =>
      AppleContracts.decodeAppleDeviceRequest({ ...request, kind: "install" }),
    ).toThrow();
  });

  it("requires the bundle a launch, terminate, uninstall, or log read acts on", () => {
    for (const kind of ["launch", "terminate", "uninstall", "logs"]) {
      expect(() => AppleContracts.decodeAppleDeviceRequest({ ...request, kind })).toThrow();
      expect(
        AppleContracts.decodeAppleDeviceRequest({
          ...request,
          kind,
          bundleIdentifier: "sh.octant.Fixture",
        }).kind,
      ).toBe(kind);
    }
  });

  it("names a device for every operation but discovery and distribution", () => {
    const { deviceId: _deviceId, ...noDevice } = request;
    for (const kind of ["discover", "upload", "submit-for-review", "release-version"] as const) {
      expect(AppleContracts.decodeAppleDeviceRequest({ ...noDevice, kind }).kind).toBe(kind);
      expect(() => AppleContracts.decodeAppleDeviceRequest({ ...request, kind })).toThrow();
    }
    expect(() =>
      AppleContracts.decodeAppleDeviceRequest({ ...noDevice, kind: "use-device" }),
    ).toThrow();
  });

  it("names the holding thread only on a request to move a lease", () => {
    const fromThreadId = "30000000-0000-4000-8000-000000000020";
    expect(
      AppleContracts.decodeAppleDeviceRequest({ ...request, kind: "use-device", fromThreadId })
        .fromThreadId,
    ).toBe(fromThreadId);
    expect(() =>
      AppleContracts.decodeAppleDeviceRequest({ ...request, kind: "release-device", fromThreadId }),
    ).toThrow();
  });

  it("answers a discovery that says a device is leased without naming the other thread", () => {
    const answer = AppleContracts.decodeAppleDeviceResponse({
      kind: "apple-device-discovery",
      discovery: {
        devices: [device],
        tooling: ["list-devices", "install-app"],
        leases: [{ deviceId: device.deviceId, holder: "another-thread" }],
        discoveredAt: "2026-10-26T12:00:00.000Z",
      },
    });
    expect(answer.kind).toBe("apple-device-discovery");
    expect(() =>
      AppleContracts.decodeAppleDeviceResponse({
        kind: "apple-device-discovery",
        discovery: {
          devices: [device],
          tooling: [],
          leases: [
            { deviceId: device.deviceId, holder: "another-thread", threadId: request.threadId },
          ],
          discoveredAt: "2026-10-26T12:00:00.000Z",
        },
      }),
    ).toThrow();
    expect(() =>
      AppleContracts.decodeAppleDeviceResponse({
        kind: "apple-device-refused",
        reason: "destination-leased",
        threadId: request.threadId,
      }),
    ).toThrow();
  });

  it("records a lease only as granted by a person at the Mac", () => {
    const lease = {
      deviceId: device.deviceId,
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      grantedBy: { kind: "local-user", actorId: "30000000-0000-4000-8000-000000000030" },
      grantedAt: "2026-10-26T12:00:00.000Z",
    };
    expect(AppleContracts.decodeAppleDeviceLease(lease).grantedBy.kind).toBe("local-user");
    expect(() => AppleContracts.decodeAppleDeviceLease({ ...lease, grantedBy: agent })).toThrow();
    expect(() =>
      AppleContracts.decodeAppleDeviceLease({
        ...lease,
        grantedBy: {
          kind: "remote-device",
          actorId: "30000000-0000-4000-8000-000000000030",
          deviceId: "30000000-0000-4000-8000-000000000031",
        },
      }),
    ).toThrow();
  });

  const signedBuild = {
    actionId: request.actionId,
    correlationId: request.correlationId,
    authority: request.authority,
    kind: "build",
    deviceId: device.deviceId,
    requestedBy: { kind: "local-user", actorId: "30000000-0000-4000-8000-000000000030" },
    outcome: "succeeded",
    bundleIdentifier: "sh.octant.Fixture",
    product: "apple-device-product-30000000-0000-4000-8000-000000000002",
    signing: { teamId: "A1B2C3D4E5", identity: "0123456789ABCDEF0123456789ABCDEF01234567" },
    diagnostics: [],
    artifacts: [{ kind: "log", reference: "apple-device-log-1" }],
    cleanup: "complete",
    durationMs: 1200,
    completedAt: "2026-10-26T12:00:00.000Z",
  };

  it("records which identity signed which product, by team and fingerprint only", () => {
    const answer = AppleContracts.decodeAppleDeviceResponse({
      kind: "apple-device-evidence",
      evidence: signedBuild,
    });
    expect(answer.kind === "apple-device-evidence" && answer.evidence.signing?.teamId).toBe(
      "A1B2C3D4E5",
    );
    // The identity's name carries the person's name; the evidence has no field for it.
    expect(() =>
      AppleContracts.decodeAppleDeviceEvidence({
        ...signedBuild,
        signing: { ...signedBuild.signing, name: "Apple Development: Jane Doe (Z9Y8X7W6V5)" },
      }),
    ).toThrow();
    expect(() =>
      AppleContracts.decodeAppleDeviceEvidence({
        ...signedBuild,
        signing: { ...signedBuild.signing, identity: "not-a-fingerprint" },
      }),
    ).toThrow();
    for (const identifier of ["udid", "serialNumber", "ecid", "coreDeviceIdentifier", "path"]) {
      expect(() =>
        AppleContracts.decodeAppleDeviceEvidence({ ...signedBuild, [identifier]: "x" }),
      ).toThrow();
    }
  });

  it("holds a signed product only as the evidence of a build or run", () => {
    for (const kind of ["install", "launch", "terminate", "logs"]) {
      expect(() => AppleContracts.decodeAppleDeviceEvidence({ ...signedBuild, kind })).toThrow();
      const { product: _product, signing: _signing, ...plain } = signedBuild;
      expect(AppleContracts.decodeAppleDeviceEvidence({ ...plain, kind }).kind).toBe(kind);
    }
    expect(() =>
      AppleContracts.decodeAppleDeviceEvidence({ ...signedBuild, product: "/Users/me/Other.app" }),
    ).toThrow();
    // A product is never held unsigned, and a signature always names its product.
    const { signing: _signing, ...unsigned } = signedBuild;
    expect(() => AppleContracts.decodeAppleDeviceEvidence(unsigned)).toThrow();
  });

  it("has no evidence for an operation this host does not carry out on a device", () => {
    for (const kind of ["use-device", "uninstall", "provisioning-update", "upload", "screenshot"]) {
      expect(() => AppleContracts.decodeAppleDeviceEvidence({ ...signedBuild, kind })).toThrow();
    }
  });
});
