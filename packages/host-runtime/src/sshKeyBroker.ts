import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { CredentialStore } from "./credentialStore";

/**
 * SSH sign-in keys Octant keeps for a registered server, in a credential
 * namespace of their own. Canonical: docs/architecture.md § Octant Shield
 * (servers as built).
 *
 * The broker makes each key itself and never hands it out: no route returns
 * the private key, only its public line and a signature over one SSH login
 * request for that very key. So neither the server process nor a command can
 * read the key, and a signature cannot stand in for anything but a login.
 */

const KEY_TYPE = "ssh-ed25519";
/** `SSH_MSG_USERAUTH_REQUEST`, RFC 4252 § 7. */
const USERAUTH_REQUEST = 50;
const HOSTBOUND_PUBLICKEY = "publickey-hostbound-v00@openssh.com";
/** A login request is a session id, a user, and the key: far below this. */
const MAX_LOGIN_REQUEST_BYTES = 8 * 1_024;

export type SshKeySignature =
  | { readonly status: "signed"; readonly signature: Buffer }
  | { readonly status: "missing" }
  | { readonly status: "refused" };

/** The key's public line, making the key first when the server has none. */
export async function ensureSshKey(store: CredentialStore, serverId: string): Promise<string> {
  if (await store.has(serverId)) return publicLineOf(await store.resolve(serverId));
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  await store.set(serverId, pem);
  return publicLineOf(pem);
}

/** The key's public line, or undefined when the server has no key. */
export async function sshPublicKey(
  store: CredentialStore,
  serverId: string,
): Promise<string | undefined> {
  if (!(await store.has(serverId))) return undefined;
  return publicLineOf(await store.resolve(serverId));
}

/**
 * Signs `data` only when it is an SSH public-key login request for this
 * server's own key (RFC 4252 § 7, or OpenSSH's host-bound form of it):
 * anything else is refused, so the key signs
 * logins and nothing a caller could reuse elsewhere.
 */
export async function signSshLogin(
  store: CredentialStore,
  serverId: string,
  data: Buffer,
): Promise<SshKeySignature> {
  if (!(await store.has(serverId))) return { status: "missing" };
  const pem = await store.resolve(serverId);
  if (!isLoginRequestFor(data, publicBlobOf(pem))) return { status: "refused" };
  const raw = sign(null, data, createPrivateKey(pem));
  return { status: "signed", signature: Buffer.concat([sshString(KEY_TYPE), sshString(raw)]) };
}

export function isLoginRequestFor(data: Buffer, keyBlob: Buffer): boolean {
  if (data.length > MAX_LOGIN_REQUEST_BYTES) return false;
  const reader = sshReader(data);
  const sessionId = reader.string();
  if (sessionId === undefined || sessionId.length === 0) return false;
  if (reader.byte() !== USERAUTH_REQUEST) return false;
  if (reader.string() === undefined) return false;
  if (reader.string()?.toString("latin1") !== "ssh-connection") return false;
  const method = reader.string()?.toString("latin1");
  if (method !== "publickey" && method !== HOSTBOUND_PUBLICKEY) return false;
  if (reader.byte() !== 1) return false;
  if (reader.string()?.toString("latin1") !== KEY_TYPE) return false;
  const blob = reader.string();
  if (blob === undefined || !blob.equals(keyBlob)) return false;
  // OpenSSH 8.9 and later sign the host-bound form, which ends with the
  // server's host key.
  if (method === HOSTBOUND_PUBLICKEY && reader.string() === undefined) return false;
  return reader.done();
}

/** The SSH wire form of the key's public half: its type, then its 32 bytes. */
export function publicBlobOf(pem: string): Buffer {
  const jwk = createPublicKey(pem).export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("The SSH key has no public half.");
  return Buffer.concat([sshString(KEY_TYPE), sshString(Buffer.from(jwk.x, "base64url"))]);
}

function publicLineOf(pem: string): string {
  return `${KEY_TYPE} ${publicBlobOf(pem).toString("base64")}`;
}

function sshString(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "latin1") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function sshReader(data: Buffer) {
  let offset = 0;
  return {
    byte: (): number | undefined => {
      if (offset >= data.length) return undefined;
      return data[offset++];
    },
    string: (): Buffer | undefined => {
      if (offset + 4 > data.length) return undefined;
      const length = data.readUInt32BE(offset);
      if (offset + 4 + length > data.length) return undefined;
      const value = data.subarray(offset + 4, offset + 4 + length);
      offset += 4 + length;
      return value;
    },
    done: () => offset === data.length,
  };
}
