import type { ShipTarget } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ShipService, type ShipDependencies } from "./shipService";

const targetId = "00000000-0000-4000-8000-000000000501";
const threadId = "00000000-0000-4000-8000-000000000502";
const revision = "1".repeat(40);
const digest = `sha256:${"a".repeat(64)}`;

function target(overrides: Partial<ShipTarget> = {}): ShipTarget {
  return {
    id: targetId,
    extensionId: "ship-to-a-branch",
    displayName: "Public site",
    destination: {
      kind: "git-branch",
      remoteName: "origin",
      branch: "published",
      artifactDirectory: "dist",
    },
    enabled: true,
    credentialReference: "credential/site",
    version: 2,
    updatedAt: "2026-08-19T09:00:00.000Z",
    ...overrides,
  } as ShipTarget;
}

function harness(
  options: {
    readonly target?: ShipTarget;
    readonly clean?: boolean;
    readonly reviewedRevision?: string | undefined;
    readonly artifact?: { readonly digest: string; readonly producedByRunId: string } | undefined;
    readonly approval?: {
      readonly targetId: string;
      readonly revision: string;
      readonly artifactDigest: string;
    };
    readonly credentialHandle?: { readonly handleId: string } | undefined;
    readonly publishFails?: boolean;
  } = {},
) {
  let current = options.target ?? target();
  const journal = { append: vi.fn() };
  const publish = vi.fn(async (_input: Parameters<ShipDependencies["publish"]>[0]) =>
    options.publishFails === true
      ? ({ outcome: "failed", detail: "The remote rejected the push." } as const)
      : ({ outcome: "published" } as const),
  );
  const credentialHandle = vi.fn(async (_reference: string) =>
    "credentialHandle" in options ? options.credentialHandle : { handleId: "handle-1" },
  );
  const dependencies: ShipDependencies = {
    listTargets: () => [current],
    writeTarget: (next) => {
      current = next;
    },
    checkout: () => ({
      checkoutRoot: "/repos/site",
      clean: options.clean ?? true,
      headRevision: revision,
      reviewedRevision: "reviewedRevision" in options ? options.reviewedRevision : revision,
      executionPolicy: "approval-gated",
    }),
    observedArtifact: async () =>
      "artifact" in options ? options.artifact : { digest, producedByRunId: "run-1" },
    credentialHandle,
    publish,
    approval: (approvalId) =>
      approvalId === "approval-1"
        ? (options.approval ?? { targetId, revision, artifactDigest: digest })
        : undefined,
    journal,
    uuid: () => "00000000-0000-4000-8000-000000000503",
    clock: () => "2026-08-19T09:00:00.000Z" as never,
  };
  return { service: new ShipService(dependencies), journal, publish, credentialHandle };
}

const shipCommand = {
  kind: "ship" as const,
  targetId,
  threadId,
  approvalId: "approval-1",
  revision,
  artifactDigest: digest,
};

describe("publishing to a target the person owns", () => {
  it("names the target, revision, and build before anyone approves anything", async () => {
    const h = harness();

    const result = await h.service.execute({ kind: "plan-ship", targetId, threadId });

    expect(result).toMatchObject({
      kind: "ship-plan",
      plan: {
        targetName: "Public site",
        revision,
        artifactDigest: digest,
        producedByRunId: "run-1",
      },
    });
  });

  it("publishes once, with a handle rather than a secret, and journals the receipt", async () => {
    const h = harness();

    const result = await h.service.execute(shipCommand);

    expect(result).toMatchObject({
      kind: "ship-receipt",
      receipt: { outcome: "published", approvalId: "approval-1" },
    });
    expect(h.credentialHandle).toHaveBeenCalledWith("credential/site");
    expect(h.publish.mock.calls[0]?.[0]).toMatchObject({
      credentialHandleId: "handle-1",
      remoteName: "origin",
      branch: "published",
      revision,
    });
    // Nothing about the credential itself reached the push.
    expect(JSON.stringify(h.publish.mock.calls[0]?.[0])).not.toContain("credential/site");
    expect(h.journal.append.mock.calls.at(-1)?.[0]?.eventName).toBe("ship-recorded@1");
  });

  it("refuses a dirty checkout, an unreviewed revision, and an unwatched build", async () => {
    for (const [options, reason] of [
      [{ clean: false }, "checkout-dirty"],
      [{ reviewedRevision: undefined }, "revision-not-reviewed"],
      [{ artifact: undefined }, "artifact-unobserved"],
    ] as const) {
      const h = harness(options);

      const result = await h.service.execute(shipCommand);

      expect(result).toMatchObject({
        kind: "ship-receipt",
        receipt: { outcome: "refused", reason },
      });
      expect(h.publish).not.toHaveBeenCalled();
    }
  });

  it("refuses an approval given for a different build, and journals the refusal", async () => {
    const h = harness({
      approval: { targetId, revision, artifactDigest: `sha256:${"b".repeat(64)}` },
    });

    const result = await h.service.execute(shipCommand);

    expect(result).toMatchObject({
      receipt: { outcome: "refused", reason: "approval-not-per-act" },
    });
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.journal.append).toHaveBeenCalled();
  });

  it("refuses when nobody approved this act at all", async () => {
    const h = harness();

    const result = await h.service.execute({ ...shipCommand, approvalId: "approval-other" });

    expect(result).toMatchObject({ receipt: { outcome: "refused", reason: "approval-required" } });
  });

  it("refuses a target that is installed but not enabled", async () => {
    const h = harness({ target: target({ enabled: false }) });

    expect(await h.service.execute(shipCommand)).toMatchObject({
      receipt: { outcome: "refused", reason: "target-not-enabled" },
    });
  });

  it("refuses when the broker will not produce a handle, rather than pushing without one", async () => {
    const h = harness({ credentialHandle: undefined });

    const result = await h.service.execute(shipCommand);

    expect(result).toMatchObject({ receipt: { outcome: "refused", reason: "credential-unbound" } });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("records a push the remote rejected as failed rather than as published", async () => {
    const h = harness({ publishFails: true });

    expect(await h.service.execute(shipCommand)).toMatchObject({
      receipt: { outcome: "failed", reason: "publish-failed" },
    });
  });

  it("keeps enabling and binding a credential as two separate decisions", async () => {
    const h = harness({ target: target({ enabled: false, credentialReference: undefined }) });

    const bound = await h.service.execute({
      kind: "bind-ship-credential",
      targetId,
      expectedVersion: 2,
      credentialReference: "credential/site",
    });
    expect(bound).toMatchObject({ kind: "ship-targets" });
    // Binding a credential did not enable anything.
    expect(await h.service.execute(shipCommand)).toMatchObject({
      receipt: { outcome: "refused", reason: "target-not-enabled" },
    });

    await h.service.execute({
      kind: "enable-ship-target",
      targetId,
      expectedVersion: 3,
      enabled: true,
    });
    expect(await h.service.execute(shipCommand)).toMatchObject({
      receipt: { outcome: "published" },
    });
  });
});
