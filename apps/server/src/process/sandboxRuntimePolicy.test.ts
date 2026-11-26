import { afterEach, describe, expect, it } from "vitest";
import { decodeSandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import {
  configureSandboxRestrictionsAuthority,
  configureSandboxToolNetwork,
  sandboxToolPolicy,
  withSandboxToolPolicy,
  authorizeSandboxHostRequest,
  beginSandboxTurn,
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
  it("does not turn off blocked host services when Network limits are off", async () => {
    fixture();
    configureSandboxToolNetwork(
      async () => ({
        permitsHostRequest: () => false,
        environment: {},
        networkEgress: "none",
        close: async () => undefined,
      }),
      () => false,
    );
    await withSandboxToolPolicy("thread", async () => {
      expect(() => authorizeSandboxHostRequest(new URL("http://127.0.0.1:5173"))).toThrow(
        /refused/,
      );
    });
  });
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
describe("a terminal admitted under a running turn", () => {
  it("lets only a terminal marked to outlive its turn do so, while a person's terminal and a helper end with it", async () => {
    const parentCleanups = new Map<string, Set<() => Promise<void>>>();
    const ended: string[] = [];
    configureSandboxRestrictionsAuthority({
      validateSelection: () => true,
      active: (threadId) => (threadId === "work-thread" ? selection : undefined),
      beginTurn: (request) => ({
        status: "admitted",
        turn: {
          summary: "",
          current: () => true,
          end: () => {
            ended.push(request.threadId);
          },
        },
      }),
      storageDirectory: () => undefined,
      deny: () => undefined,
      registerCleanup: (sessionId, cleanup) => {
        const held = parentCleanups.get(sessionId) ?? new Set();
        held.add(cleanup);
        parentCleanups.set(sessionId, held);
        return () => {
          held.delete(cleanup);
        };
      },
    });
    const request = {
      projectId: "20000000-0000-4000-8000-000000000001",
      mode: "work" as const,
      root: "/project",
      parentThreadId: "work-thread",
    };
    const terminal = beginSandboxTurn({
      ...request,
      threadId: "terminal",
      provider: "terminal",
      executionRoute: "terminal",
      outlivesParentTurn: true,
    });
    // A person's own Work-task terminal says nothing, and ends with the turn as before.
    const personal = beginSandboxTurn({
      ...request,
      threadId: "personal",
      provider: "terminal",
      executionRoute: "terminal",
    });
    const helper = beginSandboxTurn({ ...request, threadId: "helper", provider: "codex" });
    expect(terminal.status).toBe("admitted");
    expect(personal.status).toBe("admitted");
    expect(helper.status).toBe("admitted");
    // The parent turn finishes: its cleanups run.
    for (const cleanup of parentCleanups.get("session") ?? []) await cleanup();
    expect(ended.sort()).toEqual(["helper", "personal"]);
    if (terminal.status === "admitted") await terminal.turn.end();
    expect(ended).toContain("terminal");
  });
});
