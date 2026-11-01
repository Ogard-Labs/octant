import { createPublicKey, verify, type webcrypto } from "node:crypto";

type JsonWebKey = webcrypto.JsonWebKey;

/**
 * Reading OpenSSH's `session-bind@openssh.com` agent extension, which `ssh`
 * sends before it asks for a login signature: the server's host key, the
 * session id, and the host key's signature over that id. Canonical:
 * docs/architecture.md § Octant Shield (provider runtimes' own commands).
 *
 * An agent that checks the signature knows which server the connection
 * really reached, because only that server holds the host key's private
 * half. Octant's runtime agent signs a login only on a connection bound this
 * way to a registered server's recorded host key, and only for that
 * session's id.
 */

export interface SessionBinding {
  /** The host key's SSH wire form. */
  readonly hostKey: Buffer;
  readonly sessionId: Buffer;
  /** The binding was made on a forwarded agent: `ssh` on another host asked. */
  readonly forwarding: boolean;
}

const SESSION_BIND = "session-bind@openssh.com";
const AGENT_EXTENSION = 27;

/**
 * The binding a `session-bind@openssh.com` message names, when its host key
 * really signed the session id. Undefined for any other message, a key type
 * the check cannot read, or a signature that does not verify.
 */
export function verifiedSessionBinding(message: Buffer): SessionBinding | undefined {
  const reader = sshReader(message);
  if (reader.byte() !== AGENT_EXTENSION) return undefined;
  if (reader.string()?.toString("latin1") !== SESSION_BIND) return undefined;
  const hostKey = reader.string();
  const sessionId = reader.string();
  const signature = reader.string();
  const forwarding = reader.byte();
  if (
    hostKey === undefined ||
    sessionId === undefined ||
    sessionId.length === 0 ||
    signature === undefined ||
    forwarding === undefined ||
    forwarding > 1 ||
    !reader.done()
  ) {
    return undefined;
  }
  if (!hostKeySigned(hostKey, sessionId, signature)) return undefined;
  return { hostKey, sessionId, forwarding: forwarding === 1 };
}

/** The session id a login request (RFC 4252 § 7) names first, as ssh asks an agent to sign it. */
export function loginSessionId(data: Buffer): Buffer | undefined {
  return sshReader(data).string();
}

/** The SSH wire form of the key in a known-hosts line (`[marker] hosts type base64`). */
export function hostKeyOfKnownHostLine(line: string): Buffer | undefined {
  const fields = line.trim().split(/\s+/);
  if ((fields[0] ?? "").startsWith("@")) return undefined;
  const key = fields[2];
  if (key === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return undefined;
  return Buffer.from(key, "base64");
}

function hostKeySigned(hostKey: Buffer, data: Buffer, signature: Buffer): boolean {
  const key = sshReader(hostKey);
  const keyType = key.string()?.toString("latin1");
  const sig = sshReader(signature);
  const signatureType = sig.string()?.toString("latin1");
  const raw = sig.string();
  if (keyType === undefined || signatureType === undefined || raw === undefined || !sig.done()) {
    return false;
  }
  try {
    if (keyType === "ssh-ed25519") {
      const point = key.string();
      if (point === undefined || !key.done() || signatureType !== keyType) return false;
      return verify(null, data, publicKey({ kty: "OKP", crv: "Ed25519", x: url(point) }), raw);
    }
    const curve = ECDSA_CURVES[keyType];
    if (curve !== undefined) {
      key.string();
      const point = key.string();
      if (point === undefined || !key.done() || signatureType !== keyType) return false;
      if (point[0] !== 4 || point.length !== 1 + 2 * curve.size) return false;
      const parts = sshReader(raw);
      const r = parts.string();
      const s = parts.string();
      if (r === undefined || s === undefined || !parts.done()) return false;
      const jwk: JsonWebKey = {
        kty: "EC",
        crv: curve.crv,
        x: url(point.subarray(1, 1 + curve.size)),
        y: url(point.subarray(1 + curve.size)),
      };
      return verify(
        curve.hash,
        data,
        { key: publicKey(jwk), dsaEncoding: "ieee-p1363" },
        Buffer.concat([fixed(r, curve.size), fixed(s, curve.size)]),
      );
    }
    if (keyType === "ssh-rsa") {
      const hash = RSA_HASHES[signatureType];
      const e = key.string();
      const n = key.string();
      if (hash === undefined || e === undefined || n === undefined || !key.done()) return false;
      return verify(hash, data, publicKey({ kty: "RSA", e: url(unsigned(e)), n: url(unsigned(n)) }), raw);
    }
  } catch {
    return false;
  }
  return false;
}

const ECDSA_CURVES: Readonly<
  Record<string, { readonly crv: string; readonly size: number; readonly hash: string }>
> = {
  "ecdsa-sha2-nistp256": { crv: "P-256", size: 32, hash: "sha256" },
  "ecdsa-sha2-nistp384": { crv: "P-384", size: 48, hash: "sha384" },
  "ecdsa-sha2-nistp521": { crv: "P-521", size: 66, hash: "sha512" },
};

/** SHA-1 `ssh-rsa` signatures are refused, as current OpenSSH refuses them. */
const RSA_HASHES: Readonly<Record<string, string>> = {
  "rsa-sha2-256": "sha256",
  "rsa-sha2-512": "sha512",
};

function publicKey(jwk: JsonWebKey) {
  return createPublicKey({ key: jwk, format: "jwk" });
}

function url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** An SSH mpint without its sign byte. */
function unsigned(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  return value.subarray(start);
}

/** An mpint as exactly `size` big-endian bytes. */
function fixed(value: Buffer, size: number): Buffer {
  const bytes = unsigned(value);
  if (bytes.length > size) throw new Error("The signature part is too long.");
  return Buffer.concat([Buffer.alloc(size - bytes.length), bytes]);
}

function sshReader(data: Buffer) {
  let offset = 0;
  return {
    byte: (): number | undefined => (offset < data.length ? data[offset++] : undefined),
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
