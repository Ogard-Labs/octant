import { afterEach, describe, expect, it } from "vitest";
import { decodeSandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import {
  configureSandboxRestrictionsAuthority,
  configureSandboxToolNetwork,
  sandboxToolPolicy,
  withSandboxToolPolicy,
} from "./sandboxRuntimePolicy";
const selection = decodeSandboxPolicySelection({
  policy: {
    schemaVersion: 1,
    revision: 1,
    filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
    network: "existing-policy",
    credentials: "existing-policy",
    hostServices: "blocked",
  },
  context: {
    root: "/project",
    hostId: "host",
    projectId: "20000000-0000-4000-8000-000000000001",
    checkoutId: "checkout",
    sessionId: "session",
    provider: "codex",
  },
});
afterEach(() => {
  configureSandboxRestrictionsAuthority(undefined);
  configureSandboxToolNetwork(undefined, () => true);
});
function fixture() {
  const cleanups = new Set<() => Promise<void>>();
  let active = true;
  configureSandboxRestrictionsAuthority({
    validateSelection: () => true,
    active: () => (active ? selection : undefined),
    beginTurn: () => ({ status: "refused", message: "unused" }),
    storageDirectory: () => undefined,
    deny: () => undefined,
    registerCleanup: (_id, cleanup) => {
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    },
  });
  return {
    cleanups,
    expire: () => {
      active = false;
    },
  };
}
describe("sandbox host-tool lifetime", () => {
  it("keeps the admitted selection across awaits and refuses detached asynchronous work after the call ends", async () => {
    fixture();
    let release = () => {};
    const later = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached: Promise<unknown> = Promise.resolve();
    await withSandboxToolPolicy("thread", async () => {
      await Promise.resolve();
      expect(sandboxToolPolicy()).toBe(selection);
      detached = later.then(() => sandboxToolPolicy());
      void detached.catch(() => undefined);
    });
    release();
    await expect(detached).rejects.toThrow(/expired/);
    expect(sandboxToolPolicy()).toBeUndefined();
  });
  it("releases tool ownership when the network broker cannot start", async () => {
    const f = fixture();
    configureSandboxToolNetwork(
      async () => {
        throw new Error("Broker unavailable");
      },
      () => true,
    );
    await expect(withSandboxToolPolicy("thread", async () => "must not run")).rejects.toThrow(
      "Broker unavailable",
    );
    expect(f.cleanups.size).toBe(0);
  });
  it("invalidates an in-flight tool as soon as turn cleanup begins", async () => {
    const f = fixture();
    await withSandboxToolPolicy("thread", async () => {
      f.expire();
      expect(() => sandboxToolPolicy()).toThrow(/expired/);
    });
    expect(f.cleanups.size).toBe(0);
  });
});
