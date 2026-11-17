import { afterEach, expect, it, vi } from "vitest";
import { decodeSandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import { configureSandboxRestrictionsAuthority } from "../process/sandboxRuntimePolicy";
import { prepareProjectTerminalProtections } from "./projectTerminalProtections";

const selection = decodeSandboxPolicySelection({
  policy: {
    schemaVersion: 1,
    revision: 1,
    filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
    network: "deny",
    hostServices: "blocked",
    credentials: "existing-policy",
  },
  context: {
    root: "/project",
    hostId: "host",
    projectId: "20000000-0000-4000-8000-000000000001",
    checkoutId: "checkout",
    sessionId: "terminal",
    provider: "terminal",
  },
});
const request = {
  terminalId: "30000000-0000-4000-8000-000000000001",
  projectId: selection.context.projectId,
  root: "/project",
  mode: "code" as const,
  executionPolicy: "full-access" as const,
};
afterEach(() => configureSandboxRestrictionsAuthority(undefined));

it("owns the terminal's policy and proxy until close, and refuses later work from an expired scope", async () => {
  let current = true;
  const end = vi.fn(async () => {
    current = false;
  });
  const release = vi.fn(async () => undefined);
  configureSandboxRestrictionsAuthority({
    active: () => selection,
    validateSelection: () => current,
    storageDirectory: () => undefined,
    deny: () => undefined,
    registerCleanup: () => () => undefined,
    beginTurn: (input) => {
      expect(input.executionRoute).toBe("terminal");
      return {
        status: "admitted",
        turn: { strict: true, selection, current: () => current, end, summary: "Strict" },
      };
    },
  });
  const prepared = await prepareProjectTerminalProtections(request, {
    start: async () => ({
      status: "proxied",
      endpoint: { kind: "loopback", port: 3128 },
      environment: {},
      release,
    }),
  });
  if (prepared.status !== "admitted") throw new Error(prepared.message);
  expect(prepared.launch.sandboxPolicy).toBe(selection);
  expect(prepared.current()).toBe(true);
  expect(release).not.toHaveBeenCalled();
  await prepared.end();
  expect(prepared.current()).toBe(false);
  expect(release).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledOnce();
});

it("refuses a selected terminal protection when its broker is unavailable and releases the unused scope", async () => {
  const end = vi.fn(async () => undefined);
  configureSandboxRestrictionsAuthority({
    active: () => selection,
    validateSelection: () => true,
    storageDirectory: () => undefined,
    deny: () => undefined,
    registerCleanup: () => () => undefined,
    beginTurn: () => ({
      status: "admitted",
      turn: { strict: true, selection, current: () => true, end, summary: "Strict" },
    }),
  });
  expect(await prepareProjectTerminalProtections(request, undefined)).toMatchObject({
    status: "refused",
    message: expect.stringContaining("broker"),
  });
  expect(end).toHaveBeenCalledOnce();
});
