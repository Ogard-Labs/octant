import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "../serverProjects/throwawaySshd.test-support";
import { openRuntimeServerAgent, type RuntimeAgentServer } from "./runtimeServerAgent";

describe.skipIf(!canRunThrowawaySshd)("a provider runtime's own ssh signing in", () => {
  let sshd: ThrowawaySshd;
  let socketParent = "";
  let hostKey = Buffer.alloc(0);

  beforeAll(async () => {
    sshd = await startThrowawaySshd();
    // A Unix socket path has a short length limit.
    socketParent = realpathSync(mkdtempSync("/tmp/octant-runtime-agent-"));
    hostKey = Buffer.from(
      readFileSync(join(sshd.root, "hostkey.pub"), "utf8").split(" ")[1] ?? "",
      "base64",
    );
  }, 30_000);

  afterAll(() => {
    sshd.stop();
    rmSync(socketParent, { recursive: true, force: true });
  });

  // The runtime's own command: the person's config, the agent socket Octant gave the launch.
  const runtimeSsh = (agentSocket: string, alias: string) =>
    new Promise<{ readonly code: number | null; readonly output: string }>((done) => {
      const child = spawn(
        "/usr/bin/ssh",
        ["-F", sshd.configFile, "-o", "BatchMode=yes", "-o", `IdentityAgent=${agentSocket}`, alias, "echo", "runtime-reached"],
        { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sshd.root } },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("close", (code) => done({ code, output }));
    });

  async function agentFor(servers: ReadonlyArray<RuntimeAgentServer>) {
    const agent = await openRuntimeServerAgent({
      servers: async () => servers,
      personAgentSocket: () => sshd.agentSocket,
      signWithOctantKey: async () => undefined,
      socketParent,
    });
    if (agent === undefined) throw new Error("Expected an agent socket.");
    return agent;
  }

  it("signs in to a registered server whose recorded host key answered", async () => {
    const agent = await agentFor([{ serverId: "s1", user: sshd.user, hostKeys: [hostKey] }]);
    try {
      const run = await runtimeSsh(agent.socketPath, sshd.alias);
      expect(run.output).toContain("runtime-reached");
      expect(run.code).toBe(0);
    } finally {
      await agent.close();
    }
  }, 30_000);

  it("signs nothing for a host that is not a registered server, or for another user", async () => {
    const otherKey = Buffer.from(
      readFileSync(join(sshd.root, "userkey.pub"), "utf8").split(" ")[1] ?? "",
      "base64",
    );
    for (const servers of [
      [],
      [{ serverId: "s1", user: sshd.user, hostKeys: [otherKey] }],
      [{ serverId: "s1", user: "someone-else", hostKeys: [hostKey] }],
    ]) {
      const agent = await agentFor(servers);
      try {
        const run = await runtimeSsh(agent.socketPath, sshd.alias);
        expect(run.output).not.toContain("runtime-reached");
        expect(run.code).not.toBe(0);
      } finally {
        await agent.close();
      }
    }
  }, 60_000);

  it("lists the person's keys but removes and adds none, and leaves nothing behind", async () => {
    const agent = await agentFor([{ serverId: "s1", user: sshd.user, hostKeys: [hostKey] }]);
    const sshAdd = (args: ReadonlyArray<string>) =>
      new Promise<number | null>((done) => {
        const child = spawn("/usr/bin/ssh-add", [...args], {
          env: { ...process.env, SSH_AUTH_SOCK: agent.socketPath },
          stdio: "ignore",
        });
        child.on("close", (code) => done(code));
      });
    expect(await sshAdd(["-l"])).toBe(0);
    expect(await sshAdd(["-D"])).not.toBe(0);
    expect(await sshAdd(["-q", join(sshd.root, "hostkey")])).not.toBe(0);
    await agent.close();
    const listed = spawnSync("/usr/bin/ssh-add", ["-l"], {
      env: { ...process.env, SSH_AUTH_SOCK: sshd.agentSocket },
      encoding: "utf8",
    });
    expect(listed.stdout.trim().split("\n")).toHaveLength(1);
    expect(() => readFileSync(agent.socketPath)).toThrow();
  }, 30_000);
});
