import { describe, expect, it } from "vitest";
import {
  decodeExecutionCapsuleAcquireRequest,
  decodeExecutionCapsuleGitBundleReceipt,
  decodeExecutionCapsuleReceipt,
} from "./executionCapsule";

const ids = {
  capsule: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  recipe: "33333333-3333-4333-8333-333333333333",
  thread: "44444444-4444-4444-8444-444444444444",
};

describe("execution capsule contracts", () => {
  it("accepts a bounded thread-owned request only with a digest-pinned image", () => {
    const request = {
      capsuleId: ids.capsule,
      owner: { kind: "code-thread", threadId: ids.thread },
      projectId: ids.project,
      recipe: {
        recipeId: ids.recipe,
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
    };

    expect(decodeExecutionCapsuleAcquireRequest(request)).toMatchObject({
      owner: { kind: "code-thread", threadId: ids.thread },
      recipe: { revision: 1 },
      budget: { pidLimit: 512 },
    });
    expect(() =>
      decodeExecutionCapsuleAcquireRequest({
        ...request,
        recipe: { ...request.recipe, image: "ghcr.io/ogard-labs/octant-capsule:latest" },
      }),
    ).toThrow();
  });

  it("keeps runtime identity and filesystem paths off the public receipt", () => {
    const receipt = {
      capsuleId: ids.capsule,
      owner: { kind: "code-thread", threadId: ids.thread },
      projectId: ids.project,
      recipeId: ids.recipe,
      recipeRevision: 1,
      backend: "gvisor-systrap",
      status: "ready",
    };

    expect(decodeExecutionCapsuleReceipt(receipt)).toEqual(receipt);
    expect(() =>
      decodeExecutionCapsuleReceipt({
        ...receipt,
        runtimeId: "podman-container-name",
      }),
    ).toThrow();
    expect(() =>
      decodeExecutionCapsuleReceipt({
        ...receipt,
        workspaceRoot: "/var/lib/octant/capsules/one",
      }),
    ).toThrow();
  });

  it("describes a verified Git bundle without exposing its host path", () => {
    const receipt = {
      exportId: "77777777-7777-4777-8777-777777777777",
      capsuleId: ids.capsule,
      kind: "git-bundle",
      sha256: "b".repeat(64),
      byteLength: 4_096,
      headRevision: "c".repeat(40),
      verified: true,
    };

    expect(decodeExecutionCapsuleGitBundleReceipt(receipt)).toEqual(receipt);
    expect(() =>
      decodeExecutionCapsuleGitBundleReceipt({
        ...receipt,
        artifactPath: "/var/lib/octant/exports/capsule.bundle",
      }),
    ).toThrow();
  });
});
