import { describe, expect, it, vi } from "vitest";
import { decodeBrowserCredentialHostCommand } from "@octant/contracts/browser-credential-use";
import type { LinkedSecretStores } from "@octant/host-runtime";
import type { ReturnTypeOfBrowserSurfaceHost } from "./browserSurfaceHost";
import { createDesktopBrowserCredentialFill } from "./desktopBrowserCredentialFill";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stage = decodeBrowserCredentialHostCommand({
  kind: "stage-browser-credential-fill",
  expiresAt: new Date(Date.now() + 180_000).toISOString(),
  contextId: id(1),
  planId: id(2),
  owner: { windowId: id(3), threadId: id(4) },
  metadata: {
    item: {
      store: "onepassword",
      accountId: "a".repeat(26),
      vaultId: "v".repeat(26),
      itemId: "i".repeat(26),
    },
    title: "Fixture",
    version: 1,
    websiteOrigins: ["https://login.example"],
    storeRevision: "revision",
  },
});
function fixture(consume?: NonNullable<LinkedSecretStores["consumeBrowserCredential"]>) {
  let current = true;
  const native = {
    reserveCredentialFill: vi.fn(async () => ({ status: "reserved" as const })),
    validateCredentialFill: vi.fn(async () => true),
    commitCredentialFill: vi.fn<ReturnTypeOfBrowserSurfaceHost["commitCredentialFill"]>(
      async () => ({ status: "filled" as const, effect: "completed" as const }),
    ),
    cancelCredentialFill: vi.fn(() => ({ status: "cancelled" as const, effect: "none" as const })),
  };
  const stores: LinkedSecretStores = {
    status: async () => [],
    link: async () => ({ status: "linked" }),
    unlink: async () => undefined,
    isLinked: async () => true,
    isValidReference: () => true,
    read: async () => ({ status: "missing" }),
    check: async () => ({ status: "missing" }),
    awsCliPointer: async () => undefined,
    setAwsCliPointer: async () => undefined,
    browserRevisionCurrent: () => current,
    consumeBrowserCredential:
      consume ??
      (async (_metadata, use) => {
        await use({ username: "fixture-user", password: "fixture-secret" });
        return { status: "consumed" };
      }),
  };
  return {
    native,
    port: createDesktopBrowserCredentialFill({ stores, surface: () => native }),
    changed: () => {
      current = false;
    },
  };
}
describe("native Browser credential custody", () => {
  it("does not start native fill after the grant deadline passes during final validation", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let finish: (() => void) | undefined;
      f.native.commitCredentialFill.mockImplementation(
        async (_context, _owner, _plan, _values, canCommit, onCommitStart) => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          if (canCommit?.() === false) return { status: "cancelled", effect: "none" };
          onCommitStart?.();
          return { status: "filled", effect: "completed" };
        },
      );
      const timed = decodeBrowserCredentialHostCommand({
        ...stage,
        expiresAt: new Date(Date.now() + 100).toISOString(),
      });
      const ready = await f.port.execute(timed);
      if (ready.status !== "ready") throw new Error("Expected custody");
      const pending = f.port.execute(
        decodeBrowserCredentialHostCommand({
          kind: "commit-browser-credential-fill",
          contextId: stage.contextId,
          owner: stage.owner,
          planId: stage.planId,
          custodyId: ready.custodyId,
        }),
      );
      await vi.advanceTimersByTimeAsync(101);
      finish?.();
      expect(await pending).toEqual({ status: "cancelled", effect: "none" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes cancellation during final validation from cancellation after native commit starts", async () => {
    for (const started of [false, true]) {
      const f = fixture();
      let finish: (() => void) | undefined;
      f.native.commitCredentialFill.mockImplementation(
        async (_context, _owner, _plan, _values, canCommit, onCommitStart) => {
          if (started) onCommitStart?.();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          if (!started && canCommit?.() === false) return { status: "cancelled", effect: "none" };
          return { status: "filled", effect: "completed" };
        },
      );
      const ready = await f.port.execute(stage);
      if (ready.status !== "ready") throw new Error("Expected custody");
      const pending = f.port.execute(
        decodeBrowserCredentialHostCommand({
          kind: "commit-browser-credential-fill",
          contextId: stage.contextId,
          owner: stage.owner,
          planId: stage.planId,
          custodyId: ready.custodyId,
        }),
      );
      await vi.waitFor(() => expect(finish).toBeDefined());
      expect(
        await f.port.execute(
          decodeBrowserCredentialHostCommand({
            kind: "cancel-browser-credential-fill",
            contextId: stage.contextId,
            owner: stage.owner,
            planId: stage.planId,
          }),
        ),
      ).toEqual({ status: "cancelled", effect: started ? "possible" : "none" });
      finish?.();
      expect(await pending).toEqual(
        started
          ? { status: "filled", effect: "completed" }
          : { status: "cancelled", effect: "none" },
      );
    }
  });

  it("stages only a reference receipt, refuses stale revision, and consumes a commit once", async () => {
    const f = fixture();
    const ready = await f.port.execute(stage);
    expect(ready.status).toBe("ready");
    expect(JSON.stringify(ready)).not.toContain("fixture-secret");
    if (ready.status !== "ready") throw new Error("Expected custody receipt");
    const command = decodeBrowserCredentialHostCommand({
      kind: "commit-browser-credential-fill",
      contextId: stage.contextId,
      owner: stage.owner,
      planId: stage.planId,
      custodyId: ready.custodyId,
    });
    expect(await f.port.execute(command)).toEqual({ status: "filled", effect: "completed" });
    expect(await f.port.execute(command)).toEqual({ status: "filled", effect: "completed" });
    expect(f.native.commitCredentialFill).toHaveBeenCalledOnce();
    const stale = fixture();
    const held = await stale.port.execute(stage);
    if (held.status !== "ready") throw new Error("Expected custody");
    stale.changed();
    expect(
      await stale.port.execute(
        decodeBrowserCredentialHostCommand({
          kind: "commit-browser-credential-fill",
          contextId: stage.contextId,
          owner: stage.owner,
          planId: stage.planId,
          custodyId: held.custodyId,
        }),
      ),
    ).toEqual({ status: "cancelled", effect: "none" });
    expect(stale.native.commitCredentialFill).not.toHaveBeenCalled();
  });
  it("retains observation exclusion until a cancelled private read settles and never stages its late value", async () => {
    let finish: (() => void) | undefined;
    const f = fixture(async (_metadata, use) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await use({ username: "fixture-user", password: "fixture-secret" });
      return { status: "consumed" };
    });
    const pending = f.port.execute(stage);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.port.execute(
      decodeBrowserCredentialHostCommand({
        kind: "cancel-browser-credential-fill",
        contextId: stage.contextId,
        owner: stage.owner,
        planId: stage.planId,
      }),
    );
    expect(f.native.cancelCredentialFill).not.toHaveBeenCalled();
    finish?.();
    expect(await pending).toEqual({ status: "refused", reason: "cancelled" });
    expect(f.native.cancelCredentialFill).toHaveBeenCalledOnce();
    expect(f.native.commitCredentialFill).not.toHaveBeenCalled();
  });
});
