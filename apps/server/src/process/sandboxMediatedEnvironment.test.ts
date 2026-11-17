import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { decodeSandboxPolicySelection } from "@octant/contracts/sandbox-policy";

const fixture = vi.hoisted(() => ({
  authority: undefined as string | undefined,
  prepare: vi.fn(),
}));

vi.mock("./linuxMediationProduction", () => ({
  linuxMediationProductionAvailable: () => true,
  prepareLinuxMediatedLaunch: fixture.prepare,
}));

vi.mock("./sandboxRuntimePolicy", () => ({
  recordSandboxLaunch: () => undefined,
  sandboxAuthorityDirectory: () => fixture.authority,
  sandboxSelectionIsCurrent: () => true,
  sandboxNetworkSnapshot: () => ({ limitsOn: true }),
  sandboxNetworkLimitsOn: () => true,
  sandboxToolPolicy: () => undefined,
  sandboxToolNetwork: () => ({
    networkEgress: {
      kind: "proxied" as const,
      endpoint: { kind: "unix-socket" as const, path: "/tmp/octant-egress.sock" },
    },
    environment: { HTTPS_PROXY: "http://octant:token@127.0.0.1:47001" },
    permitsHostRequest: () => true,
    close: async () => undefined,
  }),
}));

import { makeProcessConfinementLive } from "./seatbeltProfile";

const directories: string[] = [];
afterEach(() => {
  fixture.authority = undefined;
  fixture.prepare.mockReset();
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

it("preserves the packaged Electron Node switch beside a selected network environment", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-mediated-environment-")));
  directories.push(base);
  const project = join(base, "project");
  const scratch = join(base, "scratch");
  const authority = join(base, "authority");
  fixture.authority = authority;
  for (const path of [project, scratch, authority]) mkdirSync(path);
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
      root: project,
      hostId: "host",
      projectId: "20000000-0000-4000-8000-000000000001",
      checkoutId: "checkout",
      sessionId: "session",
      provider: "native-harness",
    },
  });
  fixture.prepare.mockReturnValue({
    command: "/packaged/electron",
    args: ["/private/supervisor.mjs", "/private/config.json"],
    environment: { ELECTRON_RUN_AS_NODE: "1" },
  });

  const launch = makeProcessConfinementLive({
    platform: "linux",
    sandboxPath: process.execPath,
  }).prepare({
    executable: "/bin/sh",
    args: ["-c", "true"],
    boundRoot: project,
    temporaryDirectory: scratch,
    networkEgress: "allow",
    sandboxPolicy: selection,
  });

  expect(launch.environment).toEqual({
    ELECTRON_RUN_AS_NODE: "1",
    HTTPS_PROXY: "http://octant:token@127.0.0.1:47001",
  });
});
