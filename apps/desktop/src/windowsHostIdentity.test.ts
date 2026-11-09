import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { hostSigningHelperSpec, makeHostIdentitySigningService } from "./hostIdentityKeychain";
import { makeWindowsHostSigningExecutor } from "./windowsHostIdentity";
import type { WindowsCommandSpec } from "@octant/host-runtime";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const helper = "C:\\Octant\\native\\octant-credential-helper.exe";
const scope = "72000000-0000-4000-8000-000000000006";
const fingerprint = "a".repeat(64);
const limits = { timeoutMs: 5000, maxBytes: 16384 };

describe("Windows desktop identity", () => {
  it("keeps native purpose, scope and payload in the bounded private pipe", async () => {
    const calls: WindowsCommandSpec[] = [];
    const execute = makeWindowsHostSigningExecutor("octant-nightly-test-data", async (spec) => {
      calls.push({ ...spec, input: Buffer.from(spec.input) });
      return {
        exitCode: 0,
        stdout: Buffer.from(
          JSON.stringify({
            version: 1,
            ok: true,
            operation: "sign",
            keyId: "host-identity",
            fingerprint,
            signature: "s",
          }) + "\n",
        ),
      };
    });
    const payload = Buffer.alloc(4096, 7);
    const spec = hostSigningHelperSpec(
      helper,
      { operation: "sign", keyId: "host-identity", payload: payload.toString("base64") },
      scope,
      "octant-nightly-test-data",
    );
    const result = await execute(spec, limits);
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.args).toEqual([]);
    expect(call?.environment).toEqual({});
    const frame = Buffer.from(call?.input ?? []);
    expect(frame.toString("ascii", 0, 4)).toBe("OCHI");
    expect([...frame.subarray(4, 7)]).toEqual([1, 2, 1]);
    expect(frame.toString("ascii", 7, 43)).toBe(scope);
    expect(frame.readUInt32LE(43)).toBe(4096);
    expect(frame.subarray(47)).toEqual(payload);
  });

  it("does not turn legacy fingerprint proof into a key import or a different namespace", async () => {
    let frame = Buffer.alloc(0);
    const execute = makeWindowsHostSigningExecutor("octant", async (spec) => {
      frame = Buffer.from(spec.input);
      return { exitCode: 0, stdout: Buffer.from("{}\n") };
    });
    await execute(
      hostSigningHelperSpec(
        helper,
        { operation: "ensure", keyId: "host-identity", expectedFingerprint: fingerprint },
        scope,
      ),
      limits,
    );
    expect(frame.length).toBe(47);
    expect([...frame.subarray(4, 7)]).toEqual([1, 1, 0]);
    expect(frame.readUInt32LE(43)).toBe(0);
  });

  it("refuses another key, namespace, family, operation or malformed payload before native dispatch", async () => {
    const native = vi.fn(async () => ({ exitCode: 0, stdout: Buffer.alloc(0) }));
    const execute = makeWindowsHostSigningExecutor("octant", native);
    const spec = hostSigningHelperSpec(
      helper,
      { operation: "sign", keyId: "host-identity", payload: "eA==" },
      scope,
    );
    for (const change of [
      { keyId: "provider" },
      { namespace: "provider" },
      { operation: "resolve" },
      { extra: true },
      { storeScope: "../other" },
      { payload: "eA==garbage" },
      { payload: "" },
      { payload: "x".repeat(16384) },
    ])
      await expect(
        execute(
          { ...spec, stdin: JSON.stringify({ ...JSON.parse(spec.stdin), ...change }) },
          limits,
        ),
      ).rejects.toThrow();
    await expect(execute({ ...spec, args: ["--other"] }, limits)).rejects.toThrow();
    expect(native).not.toHaveBeenCalled();
  });

  it("joins an unavailable owned helper before returning recovery-only state", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let child: ReturnType<typeof spawn> | undefined;
    let closed = false;
    vi.mocked(spawn).mockImplementationOnce(() => {
      child = actual.spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000)"], {
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
      });
      child.once("close", () => {
        closed = true;
      });
      return child;
    });
    const service = makeHostIdentitySigningService(helper, {
      platform: "win32",
      storeScope: scope,
      timeoutMs: 30,
    });
    try {
      await expect(service.probeRecoveryState()).resolves.toEqual({
        status: "recovery-required",
        reason: "unavailable",
        remoteIdentityUsable: false,
        localDesktopUsable: true,
      });
      expect(closed).toBe(true);
      const pid = child?.pid;
      expect(pid).toBeTypeOf("number");
      if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (!closed) child?.kill();
    }
  });
});
