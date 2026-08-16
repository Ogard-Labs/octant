import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_RESULTS,
  operationExpectations,
  requiredEvidence,
  validateCompleteEvidence,
  validateCompletedLifecycleProbe,
  validateProbeResults,
} from "./smoke-packaged-work-confinement";

describe("packaged Work confinement smoke", () => {
  it("requires exact trusted and same-identifier foreign authentication results", () => {
    expect(EXPECTED_RESULTS.authentication).toEqual({
      "trusted-peer": "allowed",
      "foreign-client": "denied",
      "broker-rejection-evidence": "allowed",
    });
    expect(requiredEvidence.authentication["foreign-client"]).toBe(
      "NSXPCConnectionInterrupted4097",
    );
    expect(requiredEvidence.authentication["broker-rejection-evidence"]).toBe(
      "ExactRequirementInstalled",
    );
  });

  it("requires the complete bookmark lifecycle result map", () => {
    expect(EXPECTED_RESULTS.lifecycle).toEqual({
      selection: "allowed",
      "fresh-package-relaunch": "allowed",
      stale: "stale",
      revoked: "denied",
      "old-generation-replay": "denied",
    });
  });

  it("requires bounded file operations and every escape denial", () => {
    expect(operationExpectations).toEqual({
      "allowed-create-read-write-rename-delete": "allowed",
      absolute: "denied",
      traversal: "denied",
      symlink: "denied",
      hardlink: "denied",
      mount: "denied",
      unicode: "denied",
      race: "denied",
      archive: "denied",
      process: "denied",
      "loopback-network": "denied",
      "external-network": "denied",
    });
  });

  it("requires clean process cleanup and complete exact evidence", () => {
    expect(EXPECTED_RESULTS.cleanup).toEqual({ "process-cleanup": "clean" });
    expect(() => validateCompleteEvidence([])).toThrow("missing probe");
    expect(() =>
      validateCompleteEvidence([
        { probe: "process-cleanup", result: "escaped", category: "Unavailable" },
      ]),
    ).toThrow("process-cleanup");
  });

  it("uses descriptor-relative no-follow operations and bounded payloads", async () => {
    const broker = await readFile(
      new URL(
        "../apps/desktop/native/work-confinement-gate/OctantWorkConfinementBroker.swift",
        import.meta.url,
      ),
      "utf8",
    );
    const host = await readFile(
      new URL(
        "../apps/desktop/native/work-confinement-gate/OctantWorkConfinementGate.swift",
        import.meta.url,
      ),
      "utf8",
    );
    const source = await readFile(
      new URL("./smoke-packaged-work-confinement.ts", import.meta.url),
      "utf8",
    );

    expect(broker).toContain("openat(");
    expect(broker).toContain("fstatat(");
    expect(broker).toContain("O_NOFOLLOW");
    expect(broker).toContain("st_dev");
    expect(broker).toContain("st_ino");
    expect(broker).toContain("st_nlink");
    expect(broker).toContain("renameat(");
    expect(broker).toContain("fsync(");
    expect(broker).toContain("offset <= UInt64(Int64.max)");
    expect(broker).toContain("destinationMetadata");
    expect(broker).toContain("case .spawnProcess:");
    expect(broker).not.toContain("posix_spawn(");
    expect(host).toContain("deniedReadAndWriteProbeResult(");
    expect(host).toContain("SIG_IGN");
    expect(source).toContain('selectionProcess.kill("SIGTERM")');
    expect(source).toContain('hangingProcess.kill("SIGKILL")');
    expect(source).toContain("validateCompleteEvidence(combinedResults)");
  });

  it("fails closed on missing, duplicate, unexpected, or incorrect probe results", () => {
    expect(() =>
      validateProbeResults(EXPECTED_RESULTS.authentication, [
        { probe: "trusted-peer", result: "unavailable", category: "Unavailable" },
        { probe: "foreign-client", result: "allowed", category: "None" },
        {
          probe: "broker-rejection-evidence",
          result: "allowed",
          category: "ExactRequirementInstalled",
        },
      ]),
    ).toThrow("Work confinement gate failed");
    expect(() =>
      validateProbeResults(EXPECTED_RESULTS.authentication, [
        { probe: "trusted-peer", result: "allowed", category: "None" },
        { probe: "trusted-peer", result: "allowed", category: "None" },
        {
          probe: "foreign-client",
          result: "denied",
          category: "NSXPCConnectionCodeSigningRequirementFailure",
        },
        {
          probe: "broker-rejection-evidence",
          result: "allowed",
          category: "ExactRequirementInstalled",
        },
      ]),
    ).toThrow("Work confinement gate failed");
  });

  it("stops the lifecycle at the first failed completed probe", () => {
    expect(() =>
      validateCompletedLifecycleProbe({
        probe: "selection",
        result: "unavailable",
        category: "InvalidRequest",
      }),
    ).toThrow("selection (unavailable/InvalidRequest)");
  });

  it("targets the exact spawned selection process instead of an app name", async () => {
    const source = await readFile(
      new URL("./smoke-packaged-work-confinement.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("selectionProcess.pid");
    expect(source).toContain("unix id is targetPID");
    expect(source).toContain("delay 5");
    expect(source).toContain(
      "if (count of (every process whose unix id is targetPID)) > 0 then key code 36",
    );
    expect(source).not.toContain("repeat 3 times");
    expect(source).toContain("set frontmost of targetProcess to true");
    expect(source).not.toContain('perform action "AXRaise" of window 1');
    expect(source).not.toContain("if (count of windows) > 0 then exit repeat");
    expect(source).not.toContain('tell process "Octant Work Confinement Gate"');
  });
});
