import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CredentialStoreFailure,
  startCredentialBroker,
  type CredentialBroker,
  type CredentialStore,
} from "@octant/host-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openKeyAgent } from "./sshKeyAgent";
import { makeServerSshKeysBrokerClient } from "./sshKeyBrokerClient";

const SERVER = "5e7e0000-0000-4000-8000-0000000000b1";

function memoryStore(): CredentialStore & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    set: async (id, value) => void entries.set(id, value),
    has: async (id) => entries.has(id),
    resolve: async (id) => {
      const value = entries.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void entries.delete(id),
  };
}

const canRun = existsSync("/usr/bin/ssh-add") && existsSync("/usr/bin/ssh-keygen");

describe.skipIf(!canRun)("the agent socket for a key Octant keeps", () => {
  let broker: CredentialBroker;
  let folder = "";
  const sshKeys = memoryStore();

  beforeAll(async () => {
    broker = await startCredentialBroker(
      memoryStore(),
      undefined,
      undefined,
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      undefined,
      sshKeys,
    );
    // A Unix socket path has a short length limit.
    folder = realpathSync(mkdtempSync("/tmp/octant-key-agent-"));
  });

  afterAll(async () => {
    await broker.close();
    rmSync(folder, { recursive: true, force: true });
  });

  // Run apart from this process: the socket answers on this event loop.
  const sshAdd = (socket: string, args: ReadonlyArray<string>) =>
    new Promise<{ readonly code: number | null; readonly stdout: string }>((done) => {
      const child = spawn("/usr/bin/ssh-add", [...args], {
        env: { ...process.env, SSH_AUTH_SOCK: socket },
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.on("close", (code) => done({ code, stdout }));
    });

  it("lists the server's key and refuses to add or remove one", async () => {
    const keys = makeServerSshKeysBrokerClient({ url: broker.url, token: broker.token });
    const publicKey = await keys.ensure(SERVER);
    expect(publicKey).toMatch(/^ssh-ed25519 /);
    const socket = join(folder, "key-0");
    const agent = await openKeyAgent(socket, SERVER, "octant web1", keys);
    if (agent === undefined) throw new Error("Expected an agent.");
    try {
      const listed = await sshAdd(socket, ["-L"]);
      expect(listed.code).toBe(0);
      expect(listed.stdout.trim()).toBe(`${publicKey ?? ""} octant web1`);
      expect((await sshAdd(socket, ["-D"])).code).not.toBe(0);
      const keyFile = join(folder, "added");
      spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile]);
      expect((await sshAdd(socket, ["-q", keyFile])).code).not.toBe(0);
      // Only the key Octant made is in the store; the socket handed nothing else to it.
      expect([...sshKeys.entries.keys()]).toEqual([SERVER]);
    } finally {
      await agent.close();
    }
  });

  it("opens no socket for a server the broker holds no key for", async () => {
    const keys = makeServerSshKeysBrokerClient({ url: broker.url, token: broker.token });
    const socket = join(folder, "key-1");
    expect(
      await openKeyAgent(socket, "5e7e0000-0000-4000-8000-0000000000b2", "octant db1", keys),
    ).toBeUndefined();
    expect(existsSync(socket)).toBe(false);
  });
});
