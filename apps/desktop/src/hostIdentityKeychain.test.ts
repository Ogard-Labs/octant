import { describe, expect, it, vi } from "vitest";
import {
  HOST_IDENTITY_KEYCHAIN_NAMESPACE,
  HOST_IDENTITY_KEY_ID,
  HostIdentitySigningFailure,
  decodeHostSigningResponse,
  hostSigningHelperSpec,
  makeHostIdentitySigningService,
  type KeychainHelperExecutor,
} from "./hostIdentityKeychain";

const helperPath = "/Applications/Octant.app/Contents/Resources/native/octant-keychain-helper";
const fingerprint = "a".repeat(64);
const storeScope = "7d444840-9dc0-41d1-b245-5ffdce74fad2";

function okResponse(body: Record<string, unknown>, exitCode = 0) {
  return {
    exitCode,
    stdout: `${JSON.stringify(body)}\n`,
    stderr: "",
  };
}

describe("host identity Keychain contract", () => {
  it("uses a fixed namespace and keeps private operations on stdin", () => {
    const spec = hostSigningHelperSpec(
      helperPath,
      {
        operation: "sign",
        keyId: HOST_IDENTITY_KEY_ID,
        payload: "challenge-bytes",
      },
      storeScope,
    );
    expect(HOST_IDENTITY_KEYCHAIN_NAMESPACE).toBe("app.octant.host-identity.v1");
    expect(spec.args).toEqual([]);
    expect(spec.stdin).toContain("challenge-bytes");
    expect(spec.stdin).toContain(HOST_IDENTITY_KEYCHAIN_NAMESPACE);
    expect(spec.stdin).not.toContain("privateKey");
  });

  it("accepts public metadata and signatures but never private keys", () => {
    expect(
      decodeHostSigningResponse({
        version: 1,
        ok: true,
        operation: "sign",
        keyId: HOST_IDENTITY_KEY_ID,
        fingerprint,
        signature: "sig_123",
      }),
    ).toMatchObject({ ok: true, signature: "sig_123" });
    expect(() =>
      decodeHostSigningResponse({
        version: 1,
        ok: true,
        operation: "sign",
        keyId: HOST_IDENTITY_KEY_ID,
        fingerprint,
        signature: "sig_123",
        privateKey: "must-not-cross",
      }),
    ).toThrow();
  });

  it("returns typed unavailable status without helper diagnostics", () => {
    expect(
      decodeHostSigningResponse({
        version: 1,
        ok: false,
        error: "unavailable",
      }),
    ).toEqual({
      version: 1,
      ok: false,
      error: "unavailable",
    });
    expect(() =>
      decodeHostSigningResponse({
        version: 1,
        ok: false,
        error: "unavailable",
        diagnostic: "private helper output",
      }),
    ).toThrow();
  });
});

describe("makeHostIdentitySigningService", () => {
  it("ensures a host identity key and returns only the fingerprint", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async (spec) => {
      expect(spec.command).toBe(helperPath);
      expect(spec.args).toEqual([]);
      const request = JSON.parse(spec.stdin.trim()) as Record<string, unknown>;
      expect(request).toEqual({
        version: 1,
        namespace: HOST_IDENTITY_KEYCHAIN_NAMESPACE,
        storeScope,
        operation: "ensure",
        keyId: HOST_IDENTITY_KEY_ID,
      });
      return okResponse({
        version: 1,
        ok: true,
        operation: "ensure",
        keyId: HOST_IDENTITY_KEY_ID,
        fingerprint,
      });
    });

    const service = makeHostIdentitySigningService(helperPath, {
      execute,
      storeScope,
    });
    await expect(service.ensureIdentityKey()).resolves.toEqual({ fingerprint });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("forwards persisted fingerprint proof only when authorizing a legacy-key migration", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async (spec) => {
      expect(JSON.parse(spec.stdin.trim())).toEqual({
        version: 1,
        namespace: HOST_IDENTITY_KEYCHAIN_NAMESPACE,
        storeScope,
        operation: "ensure",
        keyId: HOST_IDENTITY_KEY_ID,
        expectedFingerprint: fingerprint,
      });
      return okResponse({
        version: 1,
        ok: true,
        operation: "ensure",
        keyId: HOST_IDENTITY_KEY_ID,
        fingerprint,
      });
    });
    const service = makeHostIdentitySigningService(helperPath, {
      execute,
      storeScope,
    });

    await expect(service.ensureIdentityKey(fingerprint)).resolves.toEqual({
      fingerprint,
    });
  });

  it("rejects malformed legacy-key ownership evidence before invoking the helper", async () => {
    const execute = vi.fn<KeychainHelperExecutor>();
    const service = makeHostIdentitySigningService(helperPath, {
      execute,
      storeScope,
    });

    await expect(service.ensureIdentityKey("not-a-fingerprint")).rejects.toMatchObject({
      category: "invalid",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("signs payloads and returns fingerprint plus signature without private key material", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async (spec) => {
      const request = JSON.parse(spec.stdin.trim()) as Record<string, unknown>;
      if (request.operation === "ensure") {
        return okResponse({
          version: 1,
          ok: true,
          operation: "ensure",
          keyId: HOST_IDENTITY_KEY_ID,
          fingerprint,
        });
      }
      expect(request.operation).toBe("sign");
      expect(request.payload).toBe(Buffer.from("hello-host", "utf8").toString("base64"));
      expect(JSON.stringify(request)).not.toContain("private");
      return okResponse({
        version: 1,
        ok: true,
        operation: "sign",
        keyId: HOST_IDENTITY_KEY_ID,
        fingerprint,
        signature: "c2lnbmF0dXJl",
      });
    });

    const service = makeHostIdentitySigningService(helperPath, {
      execute,
      storeScope,
    });
    await expect(service.sign(new TextEncoder().encode("hello-host"))).resolves.toEqual({
      fingerprint,
      signature: "c2lnbmF0dXJl",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("uses the persisted server fingerprint before normal signing and recovery", async () => {
    const requests: Record<string, unknown>[] = [];
    const execute = vi.fn<KeychainHelperExecutor>(async (spec) => {
      const request = JSON.parse(spec.stdin.trim()) as Record<string, unknown>;
      requests.push(request);
      if (request.operation === "ensure") {
        return okResponse({
          version: 1,
          ok: true,
          operation: "ensure",
          keyId: HOST_IDENTITY_KEY_ID,
          fingerprint,
        });
      }
      return okResponse({
        version: 1,
        ok: true,
        operation: "sign",
        keyId: HOST_IDENTITY_KEY_ID,
        fingerprint,
        signature: "c2lnbmF0dXJl",
      });
    });
    const service = makeHostIdentitySigningService(helperPath, {
      execute,
      storeScope,
      expectedLegacyFingerprint: async () => fingerprint,
    });

    await expect(service.sign(new TextEncoder().encode("hello-host"))).resolves.toMatchObject({
      fingerprint,
    });
    await expect(service.probeRecoveryState()).resolves.toMatchObject({ status: "ready" });
    expect(requests).toEqual([
      expect.objectContaining({ operation: "ensure", expectedFingerprint: fingerprint }),
      expect.objectContaining({ operation: "sign" }),
      expect.objectContaining({ operation: "ensure", expectedFingerprint: fingerprint }),
    ]);
  });

  it("rotates the host identity key and returns the new fingerprint only", async () => {
    const nextFingerprint = "b".repeat(64);
    const execute = vi.fn<KeychainHelperExecutor>(async () =>
      okResponse({
        version: 1,
        ok: true,
        operation: "rotate",
        keyId: HOST_IDENTITY_KEY_ID,
        fingerprint: nextFingerprint,
      }),
    );
    const service = makeHostIdentitySigningService(helperPath, {
      execute,
      storeScope,
    });
    await expect(service.rotateIdentityKey()).resolves.toEqual({
      fingerprint: nextFingerprint,
    });
  });

  it("maps locked/unavailable helper failures to typed recovery-safe errors", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async () =>
      okResponse({ version: 1, ok: false, error: "unavailable" }, 1),
    );
    const service = makeHostIdentitySigningService(helperPath, {
      execute,
      storeScope,
    });
    await expect(service.ensureIdentityKey()).rejects.toMatchObject({
      name: "HostIdentitySigningFailure",
      category: "unavailable",
    });
    expect(() => {
      throw new HostIdentitySigningFailure("unavailable");
    }).toThrow(/unavailable|recovery|secure host identity/i);
  });

  it("rejects non-absolute helper paths and never invokes the helper", async () => {
    const execute = vi.fn<KeychainHelperExecutor>();
    expect(() =>
      makeHostIdentitySigningService("relative/helper", {
        execute,
        storeScope,
      }),
    ).toThrow(HostIdentitySigningFailure);
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats helper execution crashes as unavailable without leaking diagnostics", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async () => {
      throw new Error("spawn EACCES /secret/path");
    });
    const service = makeHostIdentitySigningService(helperPath, {
      execute,
      storeScope,
    });
    await expect(service.sign(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      category: "unavailable",
    });
  });

  it("exposes recovery state that disables remote identity use when Keychain is unavailable", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async () =>
      okResponse({ version: 1, ok: false, error: "unavailable" }, 1),
    );
    const service = makeHostIdentitySigningService(helperPath, {
      execute,
      storeScope,
    });
    const recovery = await service.probeRecoveryState();
    expect(recovery).toEqual({
      status: "recovery-required",
      reason: "unavailable",
      remoteIdentityUsable: false,
      localDesktopUsable: true,
    });
  });

  it("reports ready recovery state when ensure succeeds", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async () =>
      okResponse({
        version: 1,
        ok: true,
        operation: "ensure",
        keyId: HOST_IDENTITY_KEY_ID,
        fingerprint,
      }),
    );
    const service = makeHostIdentitySigningService(helperPath, {
      execute,
      storeScope,
    });
    await expect(service.probeRecoveryState()).resolves.toEqual({
      status: "ready",
      reason: null,
      remoteIdentityUsable: true,
      localDesktopUsable: true,
      fingerprint,
    });
  });
});
