import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostKeyOfKnownHostLine, loginSessionId, verifiedSessionBinding } from "./sshSessionBind";

function sshString(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "latin1") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function mpint(value: Buffer): Buffer {
  return sshString((value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

interface HostKey {
  readonly blob: Buffer;
  readonly signs: (data: Buffer) => Buffer;
}

function ed25519(): HostKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  return {
    blob: Buffer.concat([sshString("ssh-ed25519"), sshString(x)]),
    signs: (data) =>
      Buffer.concat([sshString("ssh-ed25519"), sshString(sign(null, data, privateKey))]),
  };
}

function ecdsa(): HostKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
  return {
    blob: Buffer.concat([
      sshString("ecdsa-sha2-nistp256"),
      sshString("nistp256"),
      sshString(point),
    ]),
    signs: (data) => {
      const raw = sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
      return Buffer.concat([
        sshString("ecdsa-sha2-nistp256"),
        sshString(Buffer.concat([mpint(raw.subarray(0, 32)), mpint(raw.subarray(32))])),
      ]);
    },
  };
}

function rsa(signatureType: "rsa-sha2-256" | "ssh-rsa" = "rsa-sha2-256"): HostKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    blob: Buffer.concat([
      sshString("ssh-rsa"),
      mpint(Buffer.from(jwk.e ?? "", "base64url")),
      mpint(Buffer.from(jwk.n ?? "", "base64url")),
    ]),
    signs: (data) =>
      Buffer.concat([
        sshString(signatureType),
        sshString(sign(signatureType === "ssh-rsa" ? "sha1" : "sha256", data, privateKey as KeyObject)),
      ]),
  };
}

function bindMessage(key: HostKey, sessionId: Buffer, options: { readonly forwarding?: boolean; readonly signedBy?: HostKey } = {}) {
  return Buffer.concat([
    Buffer.from([27]),
    sshString("session-bind@openssh.com"),
    sshString(key.blob),
    sshString(sessionId),
    sshString((options.signedBy ?? key).signs(sessionId)),
    Buffer.from([options.forwarding === true ? 1 : 0]),
  ]);
}

describe("an ssh session's binding to its server's host key", () => {
  const sessionId = Buffer.alloc(32, 9);

  it("accepts a binding each common host key type really signed", () => {
    for (const key of [ed25519(), ecdsa(), rsa()]) {
      expect(verifiedSessionBinding(bindMessage(key, sessionId))).toEqual({
        hostKey: key.blob,
        sessionId,
        forwarding: false,
      });
    }
  });

  it("refuses a binding another key signed, a SHA-1 signature, or a malformed message", () => {
    const key = ed25519();
    expect(verifiedSessionBinding(bindMessage(key, sessionId, { signedBy: ed25519() }))).toBeUndefined();
    expect(verifiedSessionBinding(bindMessage(rsa("ssh-rsa"), sessionId))).toBeUndefined();
    const good = bindMessage(key, sessionId);
    expect(verifiedSessionBinding(good.subarray(0, good.length - 1))).toBeUndefined();
    expect(verifiedSessionBinding(Buffer.concat([good, Buffer.from([0])]))).toBeUndefined();
    expect(verifiedSessionBinding(Buffer.from([11]))).toBeUndefined();
  });

  it("says when the binding came through a forwarded agent", () => {
    expect(verifiedSessionBinding(bindMessage(ecdsa(), sessionId, { forwarding: true }))?.forwarding).toBe(
      true,
    );
  });

  it("reads the session id a login request names and the key a known-hosts line records", () => {
    const key = ed25519();
    expect(loginSessionId(Buffer.concat([sshString(sessionId), Buffer.from([50])]))).toEqual(sessionId);
    expect(hostKeyOfKnownHostLine(`web1 ssh-ed25519 ${key.blob.toString("base64")}`)).toEqual(key.blob);
    expect(hostKeyOfKnownHostLine(`@cert-authority * ssh-ed25519 ${key.blob.toString("base64")}`)).toBeUndefined();
  });
});
