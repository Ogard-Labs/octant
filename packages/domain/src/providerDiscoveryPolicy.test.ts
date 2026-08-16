import { describe, expect, it } from "vitest";
import {
  canConnectCandidate,
  isDuplicateInstallation,
  groupByDriverKind,
  isScanStale,
  canAutoDetectDriverKind,
  requiresManualEndpoint,
  isUnclassifiedDriverKind,
  selectPreferredCandidate,
  shouldAutoRegisterCandidate,
} from "./providerDiscoveryPolicy";
import type { DiscoveryCandidate, DiscoverySnapshot } from "@octant/contracts";

function makeCandidate(overrides?: Partial<DiscoveryCandidate>): DiscoveryCandidate {
  return {
    driverKind: "codex",
    displayName: "Codex CLI",
    binaryPath: "/usr/local/bin/codex",
    readiness: "ready",
    pathSummary: "/usr/local/bin/codex",
    detectedAt: "2026-07-24T12:00:00.000Z",
    ...overrides,
  } as unknown as DiscoveryCandidate;
}

function makeSnapshot(candidates: DiscoveryCandidate[]): DiscoverySnapshot {
  return {
    hostId: "local",
    candidates,
    scannedAt: "2026-07-24T12:00:00.000Z",
    scanDurationMs: 100,
    status: "completed",
  } as unknown as DiscoverySnapshot;
}

describe("canConnectCandidate", () => {
  it("allows candidate present in snapshot", () => {
    const candidate = makeCandidate();
    expect(canConnectCandidate(candidate, makeSnapshot([candidate])).kind).toBe("allowed");
  });

  it("denies candidate not in snapshot", () => {
    const candidate = makeCandidate();
    expect(canConnectCandidate(candidate, makeSnapshot([])).kind).toBe("denied");
  });

  it("denies candidate with changed path", () => {
    const candidate = makeCandidate();
    const stale = makeCandidate({
      binaryPath: "/other/bin/codex" as DiscoveryCandidate["binaryPath"],
    });
    expect(canConnectCandidate(stale, makeSnapshot([candidate])).kind).toBe("denied");
  });
});

describe("isDuplicateInstallation", () => {
  it("returns false for unique candidate", () => {
    const a = makeCandidate({ driverKind: "codex" });
    const b = makeCandidate({ driverKind: "claude", binaryPath: "/usr/local/bin/claude" as any });
    expect(isDuplicateInstallation(a, [b])).toBe(false);
  });

  it("returns true for same driver and path", () => {
    const a = makeCandidate();
    const b = makeCandidate();
    expect(isDuplicateInstallation(a, [b])).toBe(true);
  });
});

describe("groupByDriverKind", () => {
  it("groups candidates by driver kind", () => {
    const candidates = [
      makeCandidate({ driverKind: "codex" }),
      makeCandidate({
        driverKind: "claude",
        binaryPath: "/usr/local/bin/claude" as any,
      }),
      makeCandidate({
        driverKind: "codex",
        binaryPath: "/opt/homebrew/bin/codex" as any,
      }),
    ];
    const groups = groupByDriverKind(candidates);
    expect(groups.get("codex")).toHaveLength(2);
    expect(groups.get("claude")).toHaveLength(1);
  });
});

describe("isScanStale", () => {
  it("returns false within max age", () => {
    const snapshot = makeSnapshot([]);
    const scannedAt = new Date("2026-07-24T12:00:00.000Z").getTime();
    expect(isScanStale(snapshot, 60_000, scannedAt + 1_000)).toBe(false);
  });

  it("returns true after max age", () => {
    const snapshot = makeSnapshot([]);
    const scannedAt = new Date("2026-07-24T12:00:00.000Z").getTime();
    expect(isScanStale(snapshot, 60_000, scannedAt + 120_000)).toBe(true);
  });
});

describe("selectPreferredCandidate", () => {
  it("selects the first candidate as preferred within a driver group", () => {
    const preferred = selectPreferredCandidate([
      makeCandidate({
        driverKind: "codex",
        binaryPath: "/opt/homebrew/bin/codex" as DiscoveryCandidate["binaryPath"],
      }),
      makeCandidate({
        driverKind: "codex",
        binaryPath: "/usr/local/bin/codex" as DiscoveryCandidate["binaryPath"],
      }),
    ]);
    expect(preferred?.binaryPath).toBe("/opt/homebrew/bin/codex");
  });
});

describe("shouldAutoRegisterCandidate", () => {
  it("denies auto-register when the driver family already has an instance", () => {
    const decision = shouldAutoRegisterCandidate({
      candidate: makeCandidate({
        driverKind: "claude",
        binaryPath: "/opt/homebrew/bin/claude" as DiscoveryCandidate["binaryPath"],
      }),
      existingInstances: [{ driverKind: "claude", binaryPath: "/old/claude" }],
    });
    expect(decision.kind).toBe("denied");
  });

  it("denies auto-register when the canonical path is already configured", () => {
    const decision = shouldAutoRegisterCandidate({
      candidate: makeCandidate({
        driverKind: "opencode",
        binaryPath: "/bin/opencode" as DiscoveryCandidate["binaryPath"],
      }),
      existingInstances: [{ driverKind: "opencode", binaryPath: "/bin/opencode" }],
    });
    expect(decision.kind).toBe("denied");
  });

  it("allows auto-register for a new preferred family path", () => {
    const decision = shouldAutoRegisterCandidate({
      candidate: makeCandidate({
        driverKind: "codex",
        binaryPath: "/bin/codex" as DiscoveryCandidate["binaryPath"],
      }),
      existingInstances: [],
    });
    expect(decision).toEqual({ kind: "allowed" });
  });

  it("denies auto-register for direct API driver kinds even with no existing instances", () => {
    const decision = shouldAutoRegisterCandidate({
      candidate: makeCandidate({
        driverKind: "openai-compatible",
        displayName: "OpenAI Compatible",
        binaryPath: "" as DiscoveryCandidate["binaryPath"],
      }),
      existingInstances: [],
    });
    expect(decision.kind).toBe("denied");
  });
});

describe("driver classification", () => {
  it("classifies CLI drivers as auto-detectable", () => {
    expect(canAutoDetectDriverKind("codex")).toBe(true);
    expect(canAutoDetectDriverKind("claude")).toBe(true);
  });

  it("classifies HTTP endpoint drivers as manual", () => {
    expect(requiresManualEndpoint("openai-compatible")).toBe(true);
    expect(requiresManualEndpoint("azure-foundry")).toBe(true);
  });

  it("reports no unclassified known drivers", () => {
    expect(isUnclassifiedDriverKind("codex")).toBe(false);
    expect(isUnclassifiedDriverKind("openai-compatible")).toBe(false);
  });
});
