import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { AggregateId } from "@octant/contracts";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import type { ServerAddress, ServerCallInput } from "./serverConnection";
import { RemoteSetupChecks } from "./remoteSetupChecks";

const server: ShieldServer = {
  serverId: Schema.decodeUnknownSync(AggregateId)("00000000-0000-4000-8000-000000000710"),
  alias: "web1",
  user: "deploy",
  profile: "read-only",
  deployCommands: [],
};
const input = { serverId: server.serverId, runtime: "octant-harness" as const, folder: "/srv/app" };
const ran = {
  status: "ran" as const,
  exitCode: 0,
  output: Buffer.from("/srv/app\n"),
  truncated: false,
  errorOutput: "",
};

function fixture(result = ran) {
  const run = vi.fn(async (_server: ServerAddress, _input: ServerCallInput) => result);
  const checks = new RemoteSetupChecks({
    servers: () => [server],
    agentAvailable: () => true,
    connection: { run },
  });
  return { checks, run };
}

describe("read-only remote setup checks", () => {
  it("checks a registered address with a fixed fresh probe without binding or running a task", async () => {
    const { checks, run } = fixture();
    expect(await checks.check(input)).toMatchObject({
      status: "connected",
      reason: "ready",
      folder: "/srv/app",
    });
    expect(run).toHaveBeenCalledWith(
      { alias: "web1", user: "deploy" },
      expect.objectContaining({
        freshConnection: true,
        args: ["/srv/app"],
        timeoutMs: 12_000,
        maxOutputBytes: 2_048,
      }),
    );
    expect(run.mock.calls[0]?.[1]?.script).not.toContain("/srv/app");
  });

  it("bounds overlapping fresh checks and releases capacity when they finish", async () => {
    let finish: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = vi.fn(async () => {
      await held;
      return ran;
    });
    const checks = new RemoteSetupChecks({
      servers: () => [server],
      agentAvailable: () => true,
      connection: { run },
    });
    const pending = Array.from({ length: 4 }, () => checks.check(input));
    expect(await checks.check(input)).toMatchObject({ status: "stopped", reason: "busy" });
    expect(run).toHaveBeenCalledTimes(4);
    finish?.();
    await Promise.all(pending);
    expect(await checks.check(input)).toMatchObject({ status: "connected" });
  });

  it("refuses unsupported runtimes and missing agents before starting SSH", async () => {
    const { checks, run } = fixture();
    expect(await checks.check({ ...input, runtime: "native-provider" })).toMatchObject({
      reason: "unsupported-runtime",
    });
    const missing = new RemoteSetupChecks({
      servers: () => [server],
      agentAvailable: () => false,
      connection: { run },
    });
    expect(await missing.check(input)).toMatchObject({ reason: "missing-agent" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    [
      "No ED25519 host key is known for host and you have requested strict checking.\nHost key verification failed.",
      "unknown-identity",
    ],
    [
      "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.",
      "changed-identity",
    ],
    ["deploy@host: Permission denied (publickey).", "authentication-refused"],
    ["Connection refused", "host-unavailable"],
  ])("offers a separate remedy for %s without accepting trust", async (message, reason) => {
    const checks = new RemoteSetupChecks({
      servers: () => [server],
      agentAvailable: () => true,
      connection: { run: async () => ({ status: "unreachable", message, errorOutput: message }) },
    });
    expect(await checks.check(input)).toMatchObject({ status: "disconnected", reason });
  });

  it("does not claim a connection for an incomplete probe or a directory refusal", async () => {
    const { checks } = fixture({ ...ran, exitCode: 3 });
    expect(await checks.check(input)).toMatchObject({ reason: "directory-unavailable" });
    const { checks: partial } = fixture({ ...ran, truncated: true });
    expect(await partial.check(input)).toMatchObject({ reason: "probe-unavailable" });
  });

  it("discards a successful response if the registered target changed during the check", async () => {
    let servers = [server];
    const checks = new RemoteSetupChecks({
      servers: () => servers,
      agentAvailable: () => true,
      connection: {
        run: async () => {
          servers = [{ ...server, alias: "other" }];
          return ran;
        },
      },
    });
    expect(await checks.check(input)).toMatchObject({ reason: "registration-changed" });
  });
});

import { afterAll, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ServerConnection } from "./serverConnection";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

describe.skipIf(!canRunThrowawaySshd)("setup checks on a real throwaway SSH server", () => {
  let sshd: ThrowawaySshd;
  beforeAll(async () => {
    sshd = await startThrowawaySshd();
  }, 30_000);
  afterAll(() => sshd?.stop());
  const checksFor = (alias: string, agent: string | undefined = sshd.agentSocket) =>
    new RemoteSetupChecks({
      servers: () => [{ ...server, alias, user: sshd.user }],
      agentAvailable: () => agent !== undefined,
      connection: new ServerConnection({ agentSocket: () => agent, configFile: sshd.configFile }),
    });
  it("connects and resolves a permitted directory without changing SSH configuration or known hosts", async () => {
    const config = readFileSync(sshd.configFile, "utf8");
    const known = readFileSync(join(sshd.root, "known_hosts"), "utf8");
    expect(await checksFor(sshd.alias).check({ ...input, folder: sshd.root })).toMatchObject({
      status: "connected",
      folder: sshd.root,
    });
    expect(readFileSync(sshd.configFile, "utf8")).toBe(config);
    expect(readFileSync(join(sshd.root, "known_hosts"), "utf8")).toBe(known);
  });
  it("separates actual unknown and changed identities while leaving both refused", async () => {
    for (const [alias, reason] of [
      [sshd.unknownHostAlias, "unknown-identity"],
      [sshd.changedHostAlias, "changed-identity"],
    ]) {
      expect(await checksFor(alias ?? "").check(input)).toMatchObject({
        status: "disconnected",
        reason,
      });
    }
    expect(readFileSync(join(sshd.root, "empty_known_hosts"), "utf8")).toBe("");
  });
  it("separates an unavailable directory, missing agent and stopped listener", async () => {
    expect(
      await checksFor(sshd.alias).check({ ...input, folder: `${sshd.root}/absent` }),
    ).toMatchObject({ reason: "directory-unavailable" });
    const missing = new RemoteSetupChecks({
      servers: () => [{ ...server, alias: sshd.alias }],
      agentAvailable: () => false,
      connection: { run: vi.fn() },
    });
    expect(await missing.check(input)).toMatchObject({ reason: "missing-agent" });
    expect(await checksFor(sshd.closedAlias).check(input)).toMatchObject({
      reason: "host-unavailable",
    });
  });
  it("does not reuse a previously authenticated control connection when the agent disappears", async () => {
    let agent: string | undefined = sshd.agentSocket;
    const connection = new ServerConnection({
      agentSocket: () => agent,
      configFile: sshd.configFile,
    });
    const address = { alias: sshd.alias, user: sshd.user };
    expect(
      await connection.run(address, { script: "true", timeoutMs: 12_000, maxOutputBytes: 64 }),
    ).toMatchObject({ status: "ran" });
    agent = undefined;
    const checks = new RemoteSetupChecks({
      servers: () => [{ ...server, ...address }],
      agentAvailable: () => true,
      connection,
    });
    expect(await checks.check(input)).toMatchObject({
      status: "disconnected",
      reason: "authentication-refused",
    });
  });
  it("stops a disconnected pending probe and permits only an explicit new read-only check", async () => {
    const connection = new ServerConnection({
      agentSocket: () => sshd.agentSocket,
      configFile: sshd.configFile,
    });
    const pending = connection.run(
      { alias: sshd.alias, user: sshd.user },
      { script: "sleep 10", timeoutMs: 12_000, maxOutputBytes: 64, freshConnection: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    sshd.dropConnections();
    expect(await pending).toMatchObject({ status: "unreachable" });
    expect(await checksFor(sshd.alias).check({ ...input, folder: sshd.root })).toMatchObject({
      status: "connected",
    });
  });
});
