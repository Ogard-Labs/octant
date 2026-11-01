import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CredentialStore } from "./credentialStore";
import { ensureSshKey, signSshLogin, sshPublicKey } from "./sshKeyBroker";

const SERVER = "5e7e0000-0000-4000-8000-0000000000a1";
const OTHER = "5e7e0000-0000-4000-8000-0000000000a2";

function memoryStore(): CredentialStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    delete: async (id) => void values.delete(id),
  };
}

function sshString(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "latin1") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** The bytes an SSH client asks an agent to sign for a public-key login. */
function loginRequest(
  publicLine: string,
  overrides: { readonly method?: string; readonly hostKey?: Buffer } = {},
): Buffer {
  const blob = Buffer.from(publicLine.split(" ")[1] ?? "", "base64");
  return Buffer.concat([
    sshString(Buffer.alloc(32, 7)),
    Buffer.from([50]),
    sshString("deploy"),
    sshString("ssh-connection"),
    sshString(overrides.method ?? "publickey"),
    Buffer.from([1]),
    sshString("ssh-ed25519"),
    sshString(blob),
    ...(overrides.hostKey === undefined ? [] : [sshString(overrides.hostKey)]),
  ]);
}

describe("SSH keys Octant keeps", () => {
  it("makes a key once per server and gives out only its public line", async () => {
    const store = memoryStore();
    const line = await ensureSshKey(store, SERVER);
    expect(line).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+$/);
    expect(await ensureSshKey(store, SERVER)).toBe(line);
    expect(await sshPublicKey(store, SERVER)).toBe(line);
    expect(await sshPublicKey(store, OTHER)).toBeUndefined();
    expect(await ensureSshKey(store, OTHER)).not.toBe(line);
  });

  it("signs a login request for its own key, with a signature the public key verifies", async () => {
    const store = memoryStore();
    const line = await ensureSshKey(store, SERVER);
    const request = loginRequest(line);
    const result = await signSshLogin(store, SERVER, request);
    if (result.status !== "signed") throw new Error(`Expected a signature, got ${result.status}.`);
    // The SSH signature blob: the key type, then the 64-byte Ed25519 signature.
    expect(result.signature.subarray(4, 15).toString("latin1")).toBe("ssh-ed25519");
    const raw = result.signature.subarray(19);
    expect(raw).toHaveLength(64);
    const pem = store.values.get(SERVER) ?? "";
    expect(verify(null, request, createPublicKey(pem), raw)).toBe(true);
    // Current OpenSSH signs the host-bound form, which names the server's host key last.
    const hostBound = loginRequest(line, {
      method: "publickey-hostbound-v00@openssh.com",
      hostKey: Buffer.from("host key blob"),
    });
    expect((await signSshLogin(store, SERVER, hostBound)).status).toBe("signed");
  });

  it("refuses to sign anything but a login for its own key", async () => {
    const store = memoryStore();
    const line = await ensureSshKey(store, SERVER);
    const otherLine = await ensureSshKey(store, OTHER);
    for (const data of [
      Buffer.from("a git commit, a token, or any other text"),
      loginRequest(otherLine),
      loginRequest(line, { method: "hostbased" }),
      Buffer.concat([loginRequest(line), Buffer.from([0])]),
    ]) {
      expect((await signSshLogin(store, SERVER, data)).status).toBe("refused");
    }
    expect((await signSshLogin(memoryStore(), SERVER, loginRequest(line))).status).toBe("missing");
  });
});
