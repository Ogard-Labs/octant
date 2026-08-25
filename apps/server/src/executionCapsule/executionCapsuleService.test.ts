import {
  decodeExecutionCapsuleAcquireRequest,
  decodeExecutionCapsuleExportId,
  decodeExecutionCapsuleId,
} from "@octant/contracts/execution-capsule";
import { describe, expect, it, vi } from "vitest";
import { ExecutionCapsuleService, type ExecutionCapsuleDriver } from "./executionCapsuleService";

const image = `ghcr.io/ogard-labs/octant-capsule@sha256:${"a".repeat(64)}`;

function request(capsuleId: string, threadId: string) {
  return decodeExecutionCapsuleAcquireRequest({
    capsuleId,
    owner: { kind: "code-thread", threadId },
    projectId: "33333333-3333-4333-8333-333333333333",
    recipe: {
      recipeId: "44444444-4444-4444-8444-444444444444",
      revision: 1,
      image,
      setup: [],
    },
    budget: {
      cpuMillicores: 1_000,
      memoryBytes: 2 * 1_024 * 1_024 * 1_024,
      diskBytes: 10 * 1_024 * 1_024 * 1_024,
      pidLimit: 512,
    },
  });
}

function protectedDriver(): ExecutionCapsuleDriver & {
  readonly create: ReturnType<typeof vi.fn<ExecutionCapsuleDriver["create"]>>;
  readonly execute: ReturnType<typeof vi.fn<ExecutionCapsuleDriver["execute"]>>;
  readonly exportGitBundle: ReturnType<typeof vi.fn<ExecutionCapsuleDriver["exportGitBundle"]>>;
  readonly release: ReturnType<typeof vi.fn<ExecutionCapsuleDriver["release"]>>;
  readonly stop: ReturnType<typeof vi.fn<ExecutionCapsuleDriver["stop"]>>;
  readonly recover: ReturnType<typeof vi.fn<ExecutionCapsuleDriver["recover"]>>;
  readonly verifyRecoveredExport: ReturnType<
    typeof vi.fn<ExecutionCapsuleDriver["verifyRecoveredExport"]>
  >;
  readonly discardCreated: ReturnType<typeof vi.fn<ExecutionCapsuleDriver["discardCreated"]>>;
} {
  return {
    probe: async () => ({
      host: {
        platform: "linux",
        rootlessPodman: true,
        runsc: true,
        systrap: true,
        cgroupsV2: true,
        dedicatedIdentity: true,
      },
      available: {
        cpuMillicores: 4_000,
        memoryBytes: 8 * 1_024 * 1_024 * 1_024,
        diskBytes: 40 * 1_024 * 1_024 * 1_024,
        pidLimit: 2_048,
      },
    }),
    create: vi.fn(async (input) => ({
      status: "ready" as const,
      runtimeId: `runtime-${String(input.request.capsuleId)}`,
    })),
    execute: vi.fn(async () => ({
      status: "exited" as const,
      exitCode: 0,
      stdout: "capsule-a\n",
      stderr: "",
    })),
    exportGitBundle: vi.fn(async () => ({
      status: "exported" as const,
      artifactPath: "/exports/capsule.bundle",
      sha256: "b".repeat(64),
      byteLength: 4_096,
      headRevision: "c".repeat(40),
    })),
    release: vi.fn(async () => ({ status: "released" as const })),
    stop: vi.fn(async () => ({ status: "stopped" as const })),
    recover: vi.fn(async (input) => ({
      status: "stopped" as const,
      runtimeId: `runtime-${String(input.request.capsuleId)}`,
    })),
    verifyRecoveredExport: vi.fn(async () => true),
    discardCreated: vi.fn(async () => undefined),
  };
}

describe("ExecutionCapsuleService", () => {
  it("owns a distinct protected runtime for each Code thread", async () => {
    const driver = protectedDriver();
    const service = new ExecutionCapsuleService({ driver });
    const first = request(
      "11111111-1111-4111-8111-111111111111",
      "55555555-5555-4555-8555-555555555555",
    );
    const second = request(
      "22222222-2222-4222-8222-222222222222",
      "66666666-6666-4666-8666-666666666666",
    );

    await expect(
      service.acquire({
        request: first,
        source: {
          bundlePath: "/source/octant.bundle",
          sha256: "d".repeat(64),
          byteLength: 4_096,
          revision: "a".repeat(40),
        },
      }),
    ).resolves.toMatchObject({ status: "ready", receipt: { capsuleId: first.capsuleId } });
    await expect(
      service.acquire({
        request: second,
        source: {
          bundlePath: "/source/octant.bundle",
          sha256: "d".repeat(64),
          byteLength: 4_096,
          revision: "a".repeat(40),
        },
      }),
    ).resolves.toMatchObject({ status: "ready", receipt: { capsuleId: second.capsuleId } });

    expect(driver.create).toHaveBeenCalledTimes(2);
    expect(driver.create.mock.calls.map(([input]) => input.request.capsuleId)).toEqual([
      first.capsuleId,
      second.capsuleId,
    ]);
    expect(service.list()).toEqual([
      expect.objectContaining({ capsuleId: first.capsuleId, status: "ready" }),
      expect.objectContaining({ capsuleId: second.capsuleId, status: "ready" }),
    ]);
    expect(JSON.stringify(service.list())).not.toContain("runtime-");
    expect(JSON.stringify(service.list())).not.toContain("/source/octant.bundle");
  });

  it("dispatches argv through the hidden runtime identity and refuses an unknown capsule", async () => {
    const driver = protectedDriver();
    const service = new ExecutionCapsuleService({ driver });
    const capsule = request(
      "11111111-1111-4111-8111-111111111111",
      "55555555-5555-4555-8555-555555555555",
    );
    await service.acquire({
      request: capsule,
      source: {
        bundlePath: "/source/octant.bundle",
        sha256: "d".repeat(64),
        byteLength: 4_096,
        revision: "a".repeat(40),
      },
    });

    await expect(
      service.execute({ capsuleId: capsule.capsuleId, argv: ["git", "status", "--short"] }),
    ).resolves.toEqual({ status: "exited", exitCode: 0, stdout: "capsule-a\n", stderr: "" });
    expect(driver.execute).toHaveBeenCalledWith({
      runtimeId: `runtime-${String(capsule.capsuleId)}`,
      argv: ["git", "status", "--short"],
    });

    await expect(
      service.execute({
        capsuleId: decodeExecutionCapsuleId("77777777-7777-4777-8777-777777777777"),
        argv: ["git", "status"],
      }),
    ).resolves.toEqual({ status: "refused", reason: "capsule-unavailable" });
  });

  it("exports a verified Git bundle receipt without returning the host artifact path", async () => {
    const driver = protectedDriver();
    const service = new ExecutionCapsuleService({
      driver,
      createExportId: () => "88888888-8888-4888-8888-888888888888",
    });
    const capsule = request(
      "11111111-1111-4111-8111-111111111111",
      "55555555-5555-4555-8555-555555555555",
    );
    await service.acquire({
      request: capsule,
      source: {
        bundlePath: "/source/octant.bundle",
        sha256: "d".repeat(64),
        byteLength: 4_096,
        revision: "a".repeat(40),
      },
    });

    const exported = await service.exportGitBundle(capsule.capsuleId);

    expect(driver.exportGitBundle).toHaveBeenCalledWith({
      runtimeId: `runtime-${String(capsule.capsuleId)}`,
    });
    expect(exported).toEqual({
      status: "exported",
      receipt: {
        exportId: "88888888-8888-4888-8888-888888888888",
        capsuleId: capsule.capsuleId,
        kind: "git-bundle",
        sha256: "b".repeat(64),
        byteLength: 4_096,
        headRevision: "c".repeat(40),
        verified: true,
      },
    });
    expect(JSON.stringify(exported)).not.toContain("/exports/capsule.bundle");
  });

  it("requires a verified export before explicit release destroys the runtime", async () => {
    const driver = protectedDriver();
    const service = new ExecutionCapsuleService({
      driver,
      createExportId: () => "88888888-8888-4888-8888-888888888888",
    });
    const capsule = request(
      "11111111-1111-4111-8111-111111111111",
      "55555555-5555-4555-8555-555555555555",
    );
    await service.acquire({
      request: capsule,
      source: {
        bundlePath: "/source/octant.bundle",
        sha256: "d".repeat(64),
        byteLength: 4_096,
        revision: "a".repeat(40),
      },
    });

    await expect(
      service.release({
        capsuleId: capsule.capsuleId,
        exportId: decodeExecutionCapsuleExportId("99999999-9999-4999-8999-999999999999"),
      }),
    ).resolves.toEqual({ status: "refused", reason: "export-required" });
    expect(driver.release).not.toHaveBeenCalled();

    const exported = await service.exportGitBundle(capsule.capsuleId);
    if (exported.status !== "exported") throw new Error("Expected the fixture export to succeed.");
    await expect(
      service.release({ capsuleId: capsule.capsuleId, exportId: exported.receipt.exportId }),
    ).resolves.toMatchObject({
      status: "released",
      receipt: { capsuleId: capsule.capsuleId, status: "released" },
    });
    expect(driver.release).toHaveBeenCalledWith({
      runtimeId: `runtime-${String(capsule.capsuleId)}`,
    });
    expect(service.list()).toEqual([]);
  });

  it("refuses to release a reacquired capsuleId using an export from the released generation", async () => {
    const driver = protectedDriver();
    const exportIds = [
      "88888888-8888-4888-8888-888888888888",
      "77777777-7777-4777-8777-777777777777",
    ];
    const service = new ExecutionCapsuleService({
      driver,
      createExportId: () => exportIds.shift() ?? "unused",
    });
    const source = {
      bundlePath: "/source/octant.bundle",
      sha256: "d".repeat(64),
      byteLength: 4_096,
      revision: "a".repeat(40),
    };
    const capsuleId = "11111111-1111-4111-8111-111111111111";
    const firstOwner = request(capsuleId, "55555555-5555-4555-8555-555555555555");

    await service.acquire({ request: firstOwner, source });
    const firstExport = await service.exportGitBundle(firstOwner.capsuleId);
    if (firstExport.status !== "exported") {
      throw new Error("Expected the fixture export to succeed.");
    }
    await expect(
      service.release({ capsuleId: firstOwner.capsuleId, exportId: firstExport.receipt.exportId }),
    ).resolves.toMatchObject({ status: "released" });

    // The capsuleId is client-supplied and can be reused for an unrelated
    // owner once the first generation is released.
    const secondOwner = request(capsuleId, "66666666-6666-4666-8666-666666666666");
    await expect(service.acquire({ request: secondOwner, source })).resolves.toMatchObject({
      status: "ready",
    });

    // The stale export from the released generation must not satisfy the
    // export-required gate for the new capsule occupying the same id.
    await expect(
      service.release({ capsuleId: secondOwner.capsuleId, exportId: firstExport.receipt.exportId }),
    ).resolves.toEqual({ status: "refused", reason: "export-required" });
  });

  it("stops without destroying files and recovers as stopped after a Station restart", async () => {
    const driver = protectedDriver();
    const capsule = request(
      "11111111-1111-4111-8111-111111111111",
      "55555555-5555-4555-8555-555555555555",
    );
    const source = {
      bundlePath: "/source/octant.bundle",
      sha256: "d".repeat(64),
      byteLength: 4_096,
      revision: "a".repeat(40),
    };
    const beforeRestart = new ExecutionCapsuleService({ driver });
    await beforeRestart.acquire({ request: capsule, source });

    await expect(beforeRestart.stop(capsule.capsuleId)).resolves.toMatchObject({
      status: "stopped",
      receipt: { capsuleId: capsule.capsuleId, status: "stopped" },
    });
    expect(driver.stop).toHaveBeenCalledWith({
      runtimeId: `runtime-${String(capsule.capsuleId)}`,
    });
    await expect(
      beforeRestart.execute({ capsuleId: capsule.capsuleId, argv: ["git", "status"] }),
    ).resolves.toEqual({ status: "refused", reason: "capsule-unavailable" });

    const noLiveAuthority = new ExecutionCapsuleService({ driver });
    await expect(noLiveAuthority.recover({ request: capsule, source })).resolves.toEqual({
      status: "refused",
      reason: "authority-drift",
    });
    expect(driver.recover).not.toHaveBeenCalled();

    const afterRestart = new ExecutionCapsuleService({
      driver,
      revalidateRecovery: async () => ({ status: "valid" }),
    });
    await expect(afterRestart.recover({ request: capsule, source })).resolves.toMatchObject({
      status: "stopped",
      receipt: { capsuleId: capsule.capsuleId, status: "stopped" },
    });
    expect(driver.recover).toHaveBeenCalledWith({ request: capsule, source });
    await expect(
      afterRestart.execute({ capsuleId: capsule.capsuleId, argv: ["git", "status"] }),
    ).resolves.toEqual({ status: "refused", reason: "capsule-unavailable" });
  });

  it("reserves the owner before awaiting runtime creation", async () => {
    const driver = protectedDriver();
    let finishFirst:
      | ((result: Awaited<ReturnType<ExecutionCapsuleDriver["create"]>>) => void)
      | undefined;
    driver.create.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    const service = new ExecutionCapsuleService({ driver });
    const first = request(
      "11111111-1111-4111-8111-111111111111",
      "55555555-5555-4555-8555-555555555555",
    );
    const second = request(
      "22222222-2222-4222-8222-222222222222",
      "55555555-5555-4555-8555-555555555555",
    );
    const source = {
      bundlePath: "/source/octant.bundle",
      sha256: "d".repeat(64),
      byteLength: 4_096,
      revision: "a".repeat(40),
    };

    const firstAcquire = service.acquire({ request: first, source });
    await vi.waitFor(() => expect(finishFirst).toBeDefined());
    await expect(service.acquire({ request: second, source })).resolves.toEqual({
      status: "refused",
      reason: "owner-already-bound",
    });
    expect(driver.create).toHaveBeenCalledTimes(1);
    finishFirst?.({ status: "ready", runtimeId: `runtime-${String(first.capsuleId)}` });
    await expect(firstAcquire).resolves.toMatchObject({ status: "ready" });
  });

  it("reserves the owner before awaiting Station restart recovery", async () => {
    const driver = protectedDriver();
    let finishFirst:
      | ((result: Awaited<ReturnType<ExecutionCapsuleDriver["recover"]>>) => void)
      | undefined;
    driver.recover.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    const service = new ExecutionCapsuleService({
      driver,
      revalidateRecovery: async () => ({ status: "valid" }),
    });
    const first = request(
      "11111111-1111-4111-8111-111111111111",
      "55555555-5555-4555-8555-555555555555",
    );
    const second = request(
      "22222222-2222-4222-8222-222222222222",
      "55555555-5555-4555-8555-555555555555",
    );
    const source = {
      bundlePath: "/source/octant.bundle",
      sha256: "d".repeat(64),
      byteLength: 4_096,
      revision: "a".repeat(40),
    };

    const firstRecovery = service.recover({ request: first, source });
    await vi.waitFor(() => expect(finishFirst).toBeDefined());
    await expect(service.recover({ request: second, source })).resolves.toEqual({
      status: "refused",
      reason: "owner-already-bound",
    });
    expect(driver.recover).toHaveBeenCalledTimes(1);
    finishFirst?.({ status: "stopped", runtimeId: `runtime-${String(first.capsuleId)}` });
    await expect(firstRecovery).resolves.toMatchObject({ status: "stopped" });
  });
});
