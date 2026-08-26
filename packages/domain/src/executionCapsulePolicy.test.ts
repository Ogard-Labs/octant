import { decodeExecutionCapsuleAcquireRequest } from "@octant/contracts/execution-capsule";
import { describe, expect, it } from "vitest";
import { planExecutionCapsuleAdmission } from "./executionCapsulePolicy";

const request = decodeExecutionCapsuleAcquireRequest({
  capsuleId: "11111111-1111-4111-8111-111111111111",
  owner: {
    kind: "code-thread",
    threadId: "22222222-2222-4222-8222-222222222222",
  },
  projectId: "33333333-3333-4333-8333-333333333333",
  recipe: {
    recipeId: "44444444-4444-4444-8444-444444444444",
    revision: 1,
    image: `ghcr.io/ogard-labs/octant-capsule@sha256:${"a".repeat(64)}`,
    setup: [],
  },
  budget: {
    cpuMillicores: 1_000,
    memoryBytes: 2 * 1_024 * 1_024 * 1_024,
    diskBytes: 10 * 1_024 * 1_024 * 1_024,
    pidLimit: 512,
  },
});

const protectedHost = {
  platform: "linux",
  rootlessPodman: true,
  runsc: true,
  systrap: true,
  cgroupsV2: true,
  dedicatedIdentity: true,
} as const;

const available = {
  cpuMillicores: 4_000,
  memoryBytes: 8 * 1_024 * 1_024 * 1_024,
  diskBytes: 40 * 1_024 * 1_024 * 1_024,
  pidLimit: 2_048,
};

describe("execution capsule admission", () => {
  it("refuses an unprotected backend and queues instead of overcommitting capacity", () => {
    expect(
      planExecutionCapsuleAdmission({
        request,
        host: { ...protectedHost, runsc: false },
        available,
      }),
    ).toEqual({ status: "refused", reason: "protected-runtime-unavailable" });

    expect(
      planExecutionCapsuleAdmission({
        request,
        host: protectedHost,
        available: { ...available, memoryBytes: request.budget.memoryBytes - 1 },
      }),
    ).toEqual({ status: "queued", reason: "capacity-unavailable" });

    expect(planExecutionCapsuleAdmission({ request, host: protectedHost, available })).toEqual({
      status: "admitted",
      budget: request.budget,
      backend: "gvisor-systrap",
    });
  });
});
