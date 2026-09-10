import { describe, expect, it, vi } from "vitest";
import type {
  DiscoveryCandidate,
  DiscoverySnapshot,
  FirstRunOnboardingStatus,
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
  const binaryPath = input.binaryPath ?? defaultBinaryPath(driverKind);
  return {
    id: (input.id ?? "00000000-0000-4000-8000-000000000901") as ProviderInstance["id"],
    displayName: displayNameFor(driverKind),
    driverKind,
    configuration: configurationFor(driverKind, binaryPath),
    enabled: input.enabled ?? false,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-07-26T12:00:02.000Z",
    updatedAt: "2026-07-26T12:00:02.000Z",
  } as unknown as ProviderInstance;
}

function defaultBinaryPath(driverKind: DiscoveryCandidate["driverKind"]): string {
  switch (driverKind) {
    case "claude":
      return "/opt/homebrew/bin/claude";
    case "opencode":
      return "/opt/homebrew/bin/opencode";
    case "grok":
      return "/opt/homebrew/bin/grok";
    default:
      return "/opt/homebrew/bin/codex";
  }
}

function displayNameFor(driverKind: DiscoveryCandidate["driverKind"]): string {
  switch (driverKind) {
    case "claude":
      return "Claude Code";
    case "opencode":
      return "OpenCode CLI";
    case "grok":
      return "Grok";
    default:
      return "Codex CLI";
  }
}

function configurationFor(
  driverKind: DiscoveryCandidate["driverKind"],
  binaryPath: string,
): ProviderInstance["configuration"] {
  switch (driverKind) {
    case "claude":
      return {
        kind: "claude-agent-sdk",
        binaryPath,
        authentication: "subscription",
      } as ProviderInstance["configuration"];
    case "opencode":
      return { kind: "opencode-cli", binaryPath } as ProviderInstance["configuration"];
    case "grok":
      return {
        kind: "grok-acp",
        binaryPath,
        authentication: "subscription",
      } as ProviderInstance["configuration"];
    default:
      return { kind: "codex-cli", binaryPath } as ProviderInstance["configuration"];
  }
}

function claudeCandidate(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return makeCandidate({
    driverKind: "claude",
    displayName: "Claude Code",
    binaryPath: "/opt/homebrew/bin/claude",
    pathSummary: "/opt/homebrew/bin/claude",
    ...overrides,
  });
}

function opencodeCandidate(): DiscoveryCandidate {
  return makeCandidate({
    driverKind: "opencode",
    displayName: "OpenCode CLI",
    binaryPath: "/opt/homebrew/bin/opencode",
    pathSummary: "/opt/homebrew/bin/opencode",
  });
}

async function autoRegister(input: {
  readonly candidates?: ReadonlyArray<DiscoveryCandidate>;
  readonly snapshot?: DiscoverySnapshot;
  readonly instances?: ReadonlyArray<ProviderInstance>;
  readonly listInstances?: () => Promise<ReadonlyArray<ProviderInstance>>;
  readonly createFromDiscovery?: (
    candidate: DiscoveryCandidate,
    options: { readonly enabled: boolean },
  ) => Promise<ProviderInstanceId>;
  readonly firstRunOnboarding?: FirstRunOnboardingStatus;
}) {
  const createFromDiscovery = vi.fn(
    input.createFromDiscovery ??
      (async () => "00000000-0000-4000-8000-000000000911" as ProviderInstanceId),
  );
  const result = await autoRegisterPreferredCandidates({
    snapshot: input.snapshot ?? makeSnapshot(input.candidates ?? [makeCandidate()]),
    listInstances: input.listInstances ?? (async () => input.instances ?? []),
    createFromDiscovery,
    firstRunOnboarding: input.firstRunOnboarding ?? "pending",
  });
  return { result, createFromDiscovery };
}

describe("autoRegisterPreferredCandidates", () => {
  it("creates one instance for the preferred candidate in a driver family", async () => {
    const { result, createFromDiscovery } = await autoRegister({
      candidates: [
        makeCandidate({
          binaryPath: "/opt/homebrew/bin/codex",
          pathSummary: "/opt/homebrew/bin/codex",
        }),
        makeCandidate({
          binaryPath: "/usr/local/bin/codex",
          pathSummary: "/usr/local/bin/codex",
        }),
      ],
    });

    expect(createFromDiscovery).toHaveBeenCalledTimes(1);
    expect(createFromDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "/opt/homebrew/bin/codex" }),
      { enabled: true },
    );
    expect(result.createdIds).toEqual(["00000000-0000-4000-8000-000000000911"]);
    expect(result.snapshot.autoRegisteredInstanceIds).toEqual(result.createdIds);
  });

  it("creates a detected Claude Code instance enabled on first run", async () => {
    const { createFromDiscovery } = await autoRegister({
      candidates: [claudeCandidate()],
    });

    expect(createFromDiscovery).toHaveBeenCalledTimes(1);
    expect(createFromDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ driverKind: "claude" }),
      { enabled: true },
    );
  });

  it("creates a detected Codex CLI instance enabled on first run", async () => {
    const { createFromDiscovery } = await autoRegister({
      candidates: [makeCandidate()],
    });

    expect(createFromDiscovery).toHaveBeenCalledTimes(1);
    expect(createFromDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ driverKind: "codex" }),
      { enabled: true },
    );
  });

  it("creates both Claude Code and Codex CLI enabled when first run detects both", async () => {
    const created: Array<{ driverKind: string; enabled: boolean }> = [];
    const { result, createFromDiscovery } = await autoRegister({
      candidates: [makeCandidate(), claudeCandidate()],
      createFromDiscovery: async (candidate, options) => {
        created.push({ driverKind: candidate.driverKind, enabled: options.enabled });
        return `00000000-0000-4000-8000-00000000092${created.length}` as ProviderInstanceId;
      },
    });

    expect(createFromDiscovery).toHaveBeenCalledTimes(2);
    expect(created).toEqual(
      expect.arrayContaining([
        { driverKind: "claude", enabled: true },
        { driverKind: "codex", enabled: true },
      ]),
    );
    expect(result.createdIds).toHaveLength(2);
  });

  it("creates only the detected OpenCode runtime disabled when Claude Code and Codex CLI are absent", async () => {
    const { createFromDiscovery } = await autoRegister({
      candidates: [opencodeCandidate()],
    });

    expect(createFromDiscovery).toHaveBeenCalledTimes(1);
    expect(createFromDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ driverKind: "opencode" }),
      { enabled: false },
    );
    expect(createFromDiscovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ driverKind: "claude" }),
      expect.anything(),
    );
    expect(createFromDiscovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ driverKind: "codex" }),
      expect.anything(),
    );
  });

  it("leaves a non-default detected runtime off on first run", async () => {
    const created: Array<{ driverKind: string; enabled: boolean }> = [];
    await autoRegister({
      candidates: [claudeCandidate(), opencodeCandidate()],
      createFromDiscovery: async (candidate, options) => {
        created.push({ driverKind: candidate.driverKind, enabled: options.enabled });
        return `00000000-0000-4000-8000-00000000093${created.length}` as ProviderInstanceId;
      },
    });

    expect(created).toEqual(
      expect.arrayContaining([
        { driverKind: "claude", enabled: true },
        { driverKind: "opencode", enabled: false },
      ]),
    );
  });

  it("does not create or re-enable a user-disabled Claude Code instance on rediscovery", async () => {
    const { result, createFromDiscovery } = await autoRegister({
      candidates: [claudeCandidate()],
      instances: [
        makeInstance({
          driverKind: "claude",
          binaryPath: "/usr/local/bin/claude",
          enabled: false,
        }),
      ],
    });

    expect(createFromDiscovery).not.toHaveBeenCalled();
    expect(result.createdIds).toEqual([]);
    expect(result.snapshot.autoRegisteredInstanceIds).toEqual([]);
  });

  it("creates a newly detected Claude Code instance disabled after first run has been answered", async () => {
    const { createFromDiscovery } = await autoRegister({
      candidates: [claudeCandidate()],
      firstRunOnboarding: "completed",
    });

    expect(createFromDiscovery).toHaveBeenCalledTimes(1);
    expect(createFromDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ driverKind: "claude" }),
      { enabled: false },
    );
  });

  it("creates a newly detected Claude Code instance disabled when the host already recorded a provider choice", async () => {
    const { createFromDiscovery } = await autoRegister({
      candidates: [claudeCandidate()],
      instances: [makeInstance({ driverKind: "grok", enabled: false })],
      firstRunOnboarding: "pending",
    });

    expect(createFromDiscovery).toHaveBeenCalledTimes(1);
    expect(createFromDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ driverKind: "claude" }),
      { enabled: false },
    );
  });

  it("creates an unauthenticated Claude Code instance enabled without treating detection as ready", async () => {
    const { createFromDiscovery } = await autoRegister({
      candidates: [claudeCandidate({ readiness: "unauthenticated" })],
    });

    expect(createFromDiscovery).toHaveBeenCalledTimes(1);
    expect(createFromDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        driverKind: "claude",
        readiness: "unauthenticated",
      }),
      { enabled: true },
    );
  });

  it("skips auto-register on a second scan after the family was already created", async () => {
    const configured: ProviderInstance[] = [];
    const snapshot = makeSnapshot([makeCandidate()]);
    const createFromDiscovery = vi.fn(async (candidate: DiscoveryCandidate) => {
      const createdId = "00000000-0000-4000-8000-000000000912" as ProviderInstanceId;
      configured.push(
        makeInstance({
          id: createdId,
          driverKind: candidate.driverKind,
          binaryPath: candidate.binaryPath,
          enabled: true,
        }),
      );
      return createdId;
    });

    const first = await autoRegisterPreferredCandidates({
      snapshot,
      listInstances: async () => configured,
      createFromDiscovery,
      firstRunOnboarding: "pending",
    });
    const second = await autoRegisterPreferredCandidates({
      snapshot,
      listInstances: async () => configured,
      createFromDiscovery,
      firstRunOnboarding: "pending",
    });

    expect(first.createdIds).toEqual(["00000000-0000-4000-8000-000000000912"]);
    expect(second.createdIds).toEqual([]);
    expect(second.snapshot.autoRegisteredInstanceIds).toEqual([]);
    expect(createFromDiscovery).toHaveBeenCalledTimes(1);
    expect(createFromDiscovery).toHaveBeenCalledWith(expect.anything(), { enabled: true });
  });

  it("registers each family only once when overlapping first-run scans detect the same runtime", async () => {
    const configured: ProviderInstance[] = [];
    const snapshot = makeSnapshot([claudeCandidate()]);
    const createFromDiscovery = vi.fn(async (candidate: DiscoveryCandidate) => {
      const createdId =
        `00000000-0000-4000-8000-00000000094${configured.length + 1}` as ProviderInstanceId;
      configured.push(
        makeInstance({
          id: createdId,
          driverKind: candidate.driverKind,
          binaryPath: candidate.binaryPath,
          enabled: true,
        }),
      );
      return createdId;
    });

    const [first, second] = await Promise.all([
      autoRegisterPreferredCandidates({
        snapshot,
        listInstances: async () => configured,
        createFromDiscovery,
        firstRunOnboarding: "pending",
      }),
      autoRegisterPreferredCandidates({
        snapshot,
        listInstances: async () => configured,
        createFromDiscovery,
        firstRunOnboarding: "pending",
      }),
    ]);

    expect(createFromDiscovery).toHaveBeenCalledTimes(1);
    expect([...first.createdIds, ...second.createdIds]).toEqual([
      "00000000-0000-4000-8000-000000000941",
    ]);
  });

  it("skips auto-register when the driver family already has an instance", async () => {
    const { result, createFromDiscovery } = await autoRegister({
      candidates: [claudeCandidate()],
      instances: [
        makeInstance({
          driverKind: "claude",
          binaryPath: "/usr/local/bin/claude",
          enabled: false,
        }),
      ],
    });

    expect(createFromDiscovery).not.toHaveBeenCalled();
    expect(result.createdIds).toEqual([]);
    expect(result.snapshot.autoRegisteredInstanceIds).toEqual([]);
  });

  it("keeps discovered candidates usable when one family cannot be auto-registered", async () => {
    const createFromDiscovery = vi.fn(async (candidate: DiscoveryCandidate) => {
      if (candidate.driverKind === "codex") {
        throw new Error("provider create rejected");
      }
      return "00000000-0000-4000-8000-000000000915" as ProviderInstanceId;
    });

    const { result } = await autoRegister({
      candidates: [makeCandidate(), claudeCandidate()],
      createFromDiscovery,
    });

    expect(createFromDiscovery).toHaveBeenCalledTimes(2);
    expect(result.createdIds).toEqual(["00000000-0000-4000-8000-000000000915"]);
    expect(result.snapshot.candidates).toHaveLength(2);
    expect(result.snapshot.autoRegisteredInstanceIds).toEqual(result.createdIds);
  });

  it("skips cancelled empty scans without listing or creating instances", async () => {
    const listInstances = vi.fn(async () => []);
    const createFromDiscovery = vi.fn(async () => {
      return "00000000-0000-4000-8000-000000000914" as ProviderInstanceId;
    });

    const result = await autoRegisterPreferredCandidates({
      snapshot: makeSnapshot([], { status: "cancelled" }),
      listInstances,
      createFromDiscovery,
      firstRunOnboarding: "pending",
    });

    expect(listInstances).not.toHaveBeenCalled();
    expect(createFromDiscovery).not.toHaveBeenCalled();
    expect(result.createdIds).toEqual([]);
    expect(result.snapshot.autoRegisteredInstanceIds).toEqual([]);
  });
});
