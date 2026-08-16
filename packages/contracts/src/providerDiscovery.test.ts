import { describe, expect, it } from "vitest";
import {
  decodeDiscoveryCandidate,
  decodeDiscoveryCommand,
  decodeDiscoveryCommandResult,
  decodeDiscoveryReadiness,
  decodeDiscoveryScanStatus,
  decodeDiscoverySnapshot,
} from "./providerDiscovery";

const validCandidate = {
  driverKind: "codex",
  displayName: "Codex CLI",
  binaryPath: "/usr/local/bin/codex",
  version: "0.1.2507100955",
  readiness: "ready",
  pathSummary: "/usr/local/bin/codex",
  detectedAt: "2026-07-25T10:00:00.000Z",
};

const validSnapshot = {
  hostId: "local",
  candidates: [validCandidate],
  scannedAt: "2026-07-25T10:00:00.000Z",
  scanDurationMs: 450,
  status: "completed",
};

describe("provider discovery contracts", () => {
  describe("DiscoveryReadiness", () => {
    it.each(["ready", "unauthenticated", "incompatible", "unavailable", "unknown"] as const)(
      "decodes %s",
      (value) => {
        expect(decodeDiscoveryReadiness(value)).toBe(value);
      },
    );

    it("rejects invalid readiness", () => {
      expect(() => decodeDiscoveryReadiness("broken")).toThrow();
    });
  });

  describe("DiscoveryCandidate", () => {
    it("decodes a valid candidate", () => {
      const decoded = decodeDiscoveryCandidate(validCandidate);
      expect(decoded.driverKind).toBe("codex");
      expect(decoded.binaryPath).toBe("/usr/local/bin/codex");
      expect(decoded.version).toBe("0.1.2507100955");
      expect(decoded.readiness).toBe("ready");
    });

    it("decodes a candidate without optional fields", () => {
      const minimal = {
        driverKind: "codex",
        displayName: "Codex CLI",
        binaryPath: "/usr/local/bin/codex",
        readiness: "ready",
        pathSummary: "/usr/local/bin/codex",
        detectedAt: "2026-07-25T10:00:00.000Z",
      };
      const decoded = decodeDiscoveryCandidate(minimal);
      expect(decoded.version).toBeUndefined();
      expect(decoded.onboardingGuidance).toBeUndefined();
    });

    it("rejects a non-absolute binary path", () => {
      expect(() =>
        decodeDiscoveryCandidate({ ...validCandidate, binaryPath: "relative/path" }),
      ).toThrow();
    });

    it("rejects excess properties", () => {
      expect(() => decodeDiscoveryCandidate({ ...validCandidate, extra: "field" })).toThrow();
    });
  });

  describe("DiscoverySnapshot", () => {
    it("decodes a valid snapshot", () => {
      const decoded = decodeDiscoverySnapshot(validSnapshot);
      expect(decoded.hostId).toBe("local");
      expect(decoded.candidates).toHaveLength(1);
      expect(decoded.scanDurationMs).toBe(450);
      expect(decoded.status).toBe("completed");
    });

    it("decodes an empty snapshot", () => {
      const empty = { ...validSnapshot, candidates: [], scanDurationMs: 100 };
      const decoded = decodeDiscoverySnapshot(empty);
      expect(decoded.candidates).toHaveLength(0);
    });

    it("rejects more than 64 candidates", () => {
      const tooMany = {
        ...validSnapshot,
        candidates: Array.from({ length: 65 }, () => validCandidate),
      };
      expect(() => decodeDiscoverySnapshot(tooMany)).toThrow();
    });

    it("rejects negative scan duration", () => {
      expect(() => decodeDiscoverySnapshot({ ...validSnapshot, scanDurationMs: -1 })).toThrow();
    });

    it("decodes with optional message", () => {
      const withMessage = { ...validSnapshot, message: "Scan timed out after 5s" };
      const decoded = decodeDiscoverySnapshot(withMessage);
      expect(decoded.message).toBe("Scan timed out after 5s");
    });

    it("round-trips with autoRegisteredInstanceIds", () => {
      const withAutoRegistered = {
        ...validSnapshot,
        autoRegisteredInstanceIds: ["00000000-0000-4000-8000-000000000901"],
      };
      const decoded = decodeDiscoverySnapshot(withAutoRegistered);
      expect(decoded.autoRegisteredInstanceIds).toEqual(["00000000-0000-4000-8000-000000000901"]);
      expect(decoded.autoRegisteredInstanceIds).toEqual(
        withAutoRegistered.autoRegisteredInstanceIds,
      );
    });
  });

  describe("DiscoveryScanStatus", () => {
    it.each(["completed", "partial", "cancelled", "failed"] as const)("decodes %s", (value) => {
      expect(decodeDiscoveryScanStatus(value)).toBe(value);
    });
  });

  describe("DiscoveryCommand", () => {
    it("decodes a scan command", () => {
      const decoded = decodeDiscoveryCommand({ kind: "scan" });
      expect(decoded.kind).toBe("scan");
    });

    it("decodes a connect command", () => {
      const decoded = decodeDiscoveryCommand({
        kind: "connect",
        driverKind: "codex",
        binaryPath: "/usr/local/bin/codex",
        displayName: "Codex CLI",
      });
      expect(decoded.kind).toBe("connect");
    });

    it("rejects a connect command with non-absolute path", () => {
      expect(() =>
        decodeDiscoveryCommand({
          kind: "connect",
          driverKind: "codex",
          binaryPath: "codex",
          displayName: "Codex CLI",
        }),
      ).toThrow();
    });

    it("rejects unknown command kinds", () => {
      expect(() => decodeDiscoveryCommand({ kind: "install" })).toThrow();
    });
  });

  describe("DiscoveryCommandResult", () => {
    it("decodes a scan-completed result", () => {
      const decoded = decodeDiscoveryCommandResult({
        kind: "scan-completed",
        snapshot: validSnapshot,
      });
      expect(decoded.kind).toBe("scan-completed");
    });

    it("decodes a candidate-connected result", () => {
      const decoded = decodeDiscoveryCommandResult({
        kind: "candidate-connected",
        instanceId: "00000000-0000-4000-8000-000000000901",
      });
      expect(decoded.kind).toBe("candidate-connected");
    });
  });
});
