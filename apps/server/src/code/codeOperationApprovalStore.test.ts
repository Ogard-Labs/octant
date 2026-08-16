import { describe, expect, it } from "vitest";
import { decodeCodeOperationId, type CodeApprovalEffect } from "@octant/contracts";
import {
  CodeOperationApprovalStore,
  CodeOperationApprovalUnavailableError,
} from "./codeOperationApprovalStore";
import { WindowAuthorityStore } from "../windowAuthorityStore";

const windowId = "10000000-0000-4000-8000-000000000001" as never;
const operationId = decodeCodeOperationId("20000000-0000-4000-8000-000000000001");
const approvalId = "30000000-0000-4000-8000-000000000001";
const threadId = "40000000-0000-4000-8000-000000000001" as never;
const checkoutId = "70000000-0000-4000-8000-000000000001" as never;
const contextDigest = "c".repeat(64);

function terminalEffect(terminalId = "80000000-0000-4000-8000-000000000001") {
  return {
    kind: "operation",
    command: {
      kind: "start-terminal",
      threadId,
      checkoutId,
      operationId,
      terminalId,
      columns: 100,
      rows: 30,
      credentialRefs: [],
    },
  } as unknown as CodeApprovalEffect;
}

describe("CodeOperationApprovalStore", () => {
  it("consumes a host-issued receipt only for the exact canonical effect", async () => {
    const store = new CodeOperationApprovalStore({ uuid: () => approvalId, now: () => 1_000 });
    const effect = terminalEffect();
    expect(store.issue({ windowId, effect, contextDigest })).toEqual({ approvalId });

    await expect(store.validate({ windowId, effect, contextDigest, approvalId })).resolves.toBe(
      true,
    );
    await expect(store.validate({ windowId, effect, contextDigest, approvalId })).resolves.toBe(
      false,
    );
  });

  it("rejects same-kind payload substitution without consuming the exact grant", async () => {
    const store = new CodeOperationApprovalStore({ uuid: () => approvalId, now: () => 1_000 });
    const effect = terminalEffect();
    store.issue({ windowId, effect, contextDigest });

    await expect(
      store.validate({
        windowId,
        effect: terminalEffect("90000000-0000-4000-8000-000000000001"),
        contextDigest,
        approvalId,
      }),
    ).resolves.toBe(false);
    await expect(store.validate({ windowId, effect, contextDigest, approvalId })).resolves.toBe(
      true,
    );
  });

  it("binds a confirmed native challenge to the authoritative scope digest", async () => {
    let uuid = 0;
    const store = new CodeOperationApprovalStore({
      uuid: () => `30000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`,
      now: () => 1_000,
    });
    const effect = terminalEffect();
    const challenge = store.prepare({
      windowId,
      effect,
      contextDigest,
      projectId: "60000000-0000-4000-8000-000000000001" as never,
      threadId,
      threadTitle: "Fix login",
      checkoutId,
      repositoryId: `repo_${"a".repeat(64)}` as never,
      checkoutHead: {
        kind: "branch",
        name: "feature/phase-7" as never,
        oid: "b".repeat(40) as never,
      },
      message: "Allow terminal access?",
      detail: "Authoritative scope",
    });
    expect(challenge).toBeDefined();
    const receipt = store.confirm({ windowId, challengeId: challenge!.challengeId });
    expect(receipt).toBeDefined();
    const confirmedReceipt = receipt!;
    await expect(
      store.validate({
        windowId,
        effect,
        contextDigest: "d".repeat(64),
        approvalId: confirmedReceipt.approvalId,
      }),
    ).resolves.toBe(false);
    await expect(
      store.validate({ windowId, effect, contextDigest, approvalId: confirmedReceipt.approvalId }),
    ).resolves.toBe(true);
  });

  it("rejects expired grants and revokes every grant owned by a rotated window", async () => {
    let now = 1_000;
    const store = new CodeOperationApprovalStore({ uuid: () => approvalId, now: () => now });
    const effect = terminalEffect();
    store.issue({ windowId, effect, contextDigest });
    now += 5 * 60_000 + 1;
    await expect(store.validate({ windowId, effect, contextDigest, approvalId })).resolves.toBe(
      false,
    );

    now = 1_000;
    store.issue({ windowId, effect, contextDigest });
    store.revokeWindow(windowId);
    await expect(store.validate({ windowId, effect, contextDigest, approvalId })).resolves.toBe(
      false,
    );
  });

  describe("monotonic clamp and fail-closed posture", () => {
    function monotonicClampNow(): (wallClockMs: number) => number {
      let highWaterMark = 0;
      return (wallClockMs: number) => {
        highWaterMark = Math.max(highWaterMark, wallClockMs);
        return highWaterMark;
      };
    }

    it("cannot revive an expired grant with a backward wall-clock jump", async () => {
      const clampNow = monotonicClampNow();
      const store = new CodeOperationApprovalStore({
        uuid: () => approvalId,
        now: () => 1_000,
        clampNow,
      });
      const effect = terminalEffect();
      store.issue({ windowId, effect, contextDigest });
      // Real time legitimately advances past the grant's expiry and is
      // observed by the shared clamp.
      clampNow(1_000 + 5 * 60_000 + 1);
      // Host wall clock then rolls back to a raw reading that is, at face
      // value, still inside the original TTL window (`now: () => 1_000`
      // above). Without the clamp, `#removeExpired`/`validate` would compare
      // against the stale unclamped value and the grant would still be
      // considered live.
      await expect(store.validate({ windowId, effect, contextDigest, approvalId })).resolves.toBe(
        false,
      );
    });

    it("refuses to mint a new approval receipt while clock posture is recovery-required", () => {
      const store = new CodeOperationApprovalStore({
        uuid: () => approvalId,
        now: () => 1_000,
        clockPosture: () => "recovery-required",
      });
      const effect = terminalEffect();
      expect(() => store.issue({ windowId, effect, contextDigest })).toThrow(
        CodeOperationApprovalUnavailableError,
      );
    });

    it("refuses to mint a new approval challenge while clock posture is recovery-required", () => {
      const store = new CodeOperationApprovalStore({
        uuid: () => approvalId,
        now: () => 1_000,
        clockPosture: () => "recovery-required",
      });
      const effect = terminalEffect();
      expect(() =>
        store.prepare({
          windowId,
          effect,
          contextDigest,
          projectId: "60000000-0000-4000-8000-000000000001" as never,
          threadId,
          threadTitle: "Fix login",
          checkoutId,
          repositoryId: `repo_${"a".repeat(64)}` as never,
          checkoutHead: {
            kind: "branch",
            name: "feature/phase-7" as never,
            oid: "b".repeat(40) as never,
          },
          message: "Allow terminal access?",
          detail: "Authoritative scope",
        }),
      ).toThrow(CodeOperationApprovalUnavailableError);
    });

    it("rechecks recovery after the authority clock observation used for issuance", () => {
      let observations = 0;
      let posture: "ok" | "recovery-required" = "ok";
      const store = new CodeOperationApprovalStore({
        uuid: () => approvalId,
        now: () => 1_000,
        clampNow: (now) => {
          observations += 1;
          // Simulate a rollback detected by the final observation in the old
          // implementation. The fixed path has no later observation after
          // checking posture, so it must never mint this grant.
          if (observations === 2) posture = "recovery-required";
          return now;
        },
        clockPosture: () => posture,
      });
      const effect = terminalEffect();

      expect(store.issue({ windowId, effect, contextDigest })).toBeDefined();
      expect(observations).toBe(1);
      expect(posture).toBe("ok");
    });

    it("issues and validates normally when clock posture is ok", async () => {
      const store = new CodeOperationApprovalStore({
        uuid: () => approvalId,
        now: () => 1_000,
        clockPosture: () => "ok",
      });
      const effect = terminalEffect();
      expect(store.issue({ windowId, effect, contextDigest })).toEqual({ approvalId });
      await expect(store.validate({ windowId, effect, contextDigest, approvalId })).resolves.toBe(
        true,
      );
    });
  });

  it("cannot reuse a grant after the native window closes and re-registers", async () => {
    const store = new CodeOperationApprovalStore({ uuid: () => approvalId, now: () => 1_000 });
    const authority = new WindowAuthorityStore((revoked) => store.revokeWindow(revoked));
    const firstCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const nextCapability = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
    authority.register({ windowId, capability: firstCapability, now: 1_000 });
    const effect = terminalEffect();
    store.issue({ windowId, effect, contextDigest });

    authority.revoke(windowId);
    authority.register({ windowId, capability: nextCapability, now: 1_001 });

    expect(authority.authenticate(nextCapability, 1_002)).toBe(windowId);
    await expect(store.validate({ windowId, effect, contextDigest, approvalId })).resolves.toBe(
      false,
    );
  });
});
