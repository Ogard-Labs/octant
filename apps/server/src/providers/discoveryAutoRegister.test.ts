import { describe, expect, it, vi } from "vitest";
import type {
  DiscoveryCandidate,
  DiscoverySnapshot,
  ProviderInstance,
  ProviderInstanceId,
} from "@octant/contracts";
import { autoRegisterPreferredCandidates } from "./discoveryAutoRegister";

function makeCandidate(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    driverKind: "codex",
    displayName: "Codex CLI",
    binaryPath: "/opt/homebrew/bin/codex",
    readiness: "ready",
    pathSummary: "/opt/homebrew/bin/codex",
    detectedAt: "2026-07-26T12:00:00.000Z",
    ...overrides,
  } as unknown as DiscoveryCandidate;
}

function makeSnapshot(
  candidates: ReadonlyArray<DiscoveryCandidate>,
  overrides: Partial<DiscoverySnapshot> = {},
): DiscoverySnapshot {
  return {
    hostId: "local",
    candidates,
    scannedAt: "2026-07-26T12:00:01.000Z",
    scanDurationMs: 100,
    status: "completed",
    ...overrides,
  } as unknown as DiscoverySnapshot;
}

function makeInstance(
  input: {
    id?: string;
    driverKind?: DiscoveryCandidate["driverKind"];
    binaryPath?: string;
    enabled?: boolean;
  } = {},
): ProviderInstance {
  const driverKind = input.driverKind ?? "codex";
  const binaryPath =
    input.binaryPath ??
    (driverKind === "claude" ? "/opt/homebrew/bin/claude" : "/opt/homebrew/bin/codex");
  const configuration =
    driverKind === "claude"
      ? {
          kind: "claude-agent-sdk",
          binaryPath,
          authentication: "subscription",
        }
      : {
          kind: "codex-cli",
          binaryPath,
        };
  return {
    id: (input.id ?? "00000000-0000-4000-8000-000000000901") as ProviderInstance["id"],
    displayName: driverKind === "claude" ? "Claude CLI" : "Codex CLI",
    driverKind,
    configuration,
    enabled: input.enabled ?? false,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-07-26T12:00:02.000Z",
    updatedAt: "2026-07-26T12:00:02.000Z",
  } as unknown as ProviderInstance;
}

describe("autoRegisterPreferredCandidates", () => {
  it("creates one disabled instance for the preferred candidate in a driver family", async () => {
    const createDisabled = vi.fn(async () => {
      return "00000000-0000-4000-8000-000000000911" as ProviderInstanceId;
    });

    const result = await autoRegisterPreferredCandidates({
      snapshot: makeSnapshot([
        makeCandidate({
          binaryPath: "/opt/homebrew/bin/codex",
          pathSummary: "/opt/homebrew/bin/codex",
        }),
        makeCandidate({
          binaryPath: "/usr/local/bin/codex",
          pathSummary: "/usr/local/bin/codex",
        }),
      ]),
      listInstances: async () => [],
      createDisabled,
    });

    expect(createDisabled).toHaveBeenCalledTimes(1);
    expect(createDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "/opt/homebrew/bin/codex" }),
    );
    expect(result.createdIds).toEqual(["00000000-0000-4000-8000-000000000911"]);
    expect(result.snapshot.autoRegisteredInstanceIds).toEqual(result.createdIds);
  });

  it("skips auto-register on a second scan after the family was already created", async () => {
    const configured: ProviderInstance[] = [];
    const snapshot = makeSnapshot([makeCandidate()]);
    const createDisabled = vi.fn(async (candidate: DiscoveryCandidate) => {
      const createdId = "00000000-0000-4000-8000-000000000912";
      configured.push(
        makeInstance({
          id: createdId,
          driverKind: candidate.driverKind,
          binaryPath: candidate.binaryPath,
          enabled: false,
        }),
      );
      return createdId as ProviderInstanceId;
    });

    const first = await autoRegisterPreferredCandidates({
      snapshot,
      listInstances: async () => configured,
      createDisabled,
    });
    const second = await autoRegisterPreferredCandidates({
      snapshot,
      listInstances: async () => configured,
      createDisabled,
    });

    expect(first.createdIds).toEqual(["00000000-0000-4000-8000-000000000912"]);
    expect(second.createdIds).toEqual([]);
    expect(second.snapshot.autoRegisteredInstanceIds).toEqual([]);
    expect(createDisabled).toHaveBeenCalledTimes(1);
  });

  it("skips auto-register when the driver family already has an instance", async () => {
    const createDisabled = vi.fn(async () => {
      return "00000000-0000-4000-8000-000000000913" as ProviderInstanceId;
    });

    const result = await autoRegisterPreferredCandidates({
      snapshot: makeSnapshot([
        makeCandidate({
          driverKind: "claude",
          displayName: "Claude CLI",
          binaryPath: "/opt/homebrew/bin/claude",
          pathSummary: "/opt/homebrew/bin/claude",
        }),
      ]),
      listInstances: async () => [
        makeInstance({
          driverKind: "claude",
          binaryPath: "/usr/local/bin/claude",
          enabled: false,
        }),
      ],
      createDisabled,
    });

    expect(createDisabled).not.toHaveBeenCalled();
    expect(result.createdIds).toEqual([]);
    expect(result.snapshot.autoRegisteredInstanceIds).toEqual([]);
  });

  it("keeps discovered candidates usable when one family cannot be auto-registered", async () => {
    const createDisabled = vi.fn(async (candidate: DiscoveryCandidate) => {
      if (candidate.driverKind === "codex") {
        throw new Error("provider create rejected");
      }
      return "00000000-0000-4000-8000-000000000915" as ProviderInstanceId;
    });

    const result = await autoRegisterPreferredCandidates({
      snapshot: makeSnapshot([
        makeCandidate(),
        makeCandidate({
          driverKind: "claude",
          displayName: "Claude Code",
          binaryPath: "/opt/homebrew/bin/claude",
          pathSummary: "/opt/homebrew/bin/claude",
        }),
      ]),
      listInstances: async () => [],
      createDisabled,
    });

    expect(createDisabled).toHaveBeenCalledTimes(2);
    expect(result.createdIds).toEqual(["00000000-0000-4000-8000-000000000915"]);
    expect(result.snapshot.candidates).toHaveLength(2);
    expect(result.snapshot.autoRegisteredInstanceIds).toEqual(result.createdIds);
  });

  it("skips cancelled empty scans without listing or creating instances", async () => {
    const listInstances = vi.fn(async () => []);
    const createDisabled = vi.fn(async () => {
      return "00000000-0000-4000-8000-000000000914" as ProviderInstanceId;
    });

    const result = await autoRegisterPreferredCandidates({
      snapshot: makeSnapshot([], { status: "cancelled" }),
      listInstances,
      createDisabled,
    });

    expect(listInstances).not.toHaveBeenCalled();
    expect(createDisabled).not.toHaveBeenCalled();
    expect(result.createdIds).toEqual([]);
    expect(result.snapshot.autoRegisteredInstanceIds).toEqual([]);
  });
});
