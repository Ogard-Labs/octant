import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { CredentialStoreFailure } from "./credentialStore";
import { makeWindowsCredentialStore, type WindowsCommandSpec } from "./windowsCredentialStore";

const providerInstanceId = "72000000-0000-4000-8000-000000000005";
const storeScope = "72000000-0000-4000-8000-000000000006";
const helperPath = "C:\\Octant\\native\\octant-credential-helper.exe";
function reply(status = 0, value = "") {
  const bytes = Buffer.from(value, "utf8");
  const result = Buffer.alloc(9 + bytes.length);
  result.write("OCCR", 0, "ascii");
  result[4] = status;
  result.writeUInt32LE(bytes.length, 5);
  bytes.copy(result, 9);
  return { exitCode: 0, stdout: result };
}
function fixture(response = reply()) {
  const calls: WindowsCommandSpec[] = [];
  const store = makeWindowsCredentialStore({
    helperPath,
    storeScope,
    serviceFamily: "octant-nightly-test-data",
    execute: async (spec) => {
      calls.push({ ...spec, input: Buffer.from(spec.input) });
      return { ...response, stdout: Buffer.from(response.stdout) };
    },
  });
  return { calls, store };
}

describe("Windows provider credentials", () => {
  it("keeps the key and scoped identity in the private request pipe", async () => {
    const { store, calls } = fixture();
    await store.set(providerInstanceId, "synthetic-λ-key");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.command).toBe(helperPath);
    expect(call?.args).toEqual([]);
    expect(call?.environment).toEqual({});
    const input = Buffer.from(call?.input ?? []);
    expect(input.toString("ascii", 0, 4)).toBe("OCCR");
    expect(input[4]).toBe(1);
    expect(input[5]).toBe(1);
    expect(input[6]).toBe(1);
    expect(input.toString("ascii", 7, 43)).toBe(storeScope);
    expect(input.toString("ascii", 43, 79)).toBe(providerInstanceId);
    expect(input.readUInt32LE(79)).toBe(Buffer.byteLength("synthetic-λ-key"));
    expect(input.toString("utf8", 83)).toBe("synthetic-λ-key");
  });

  it("accepts the exact native byte cap and refuses overflow before invoking the helper", async () => {
    const { store, calls } = fixture();
    await store.set(providerInstanceId, "λ".repeat(1280));
    await expect(store.set(providerInstanceId, "λ".repeat(1280) + "x")).rejects.toMatchObject({
      category: "invalid",
    });
    await expect(store.set(providerInstanceId, "\ud800")).rejects.toMatchObject({
      category: "invalid",
    });
    await expect(store.set(providerInstanceId, "")).rejects.toMatchObject({ category: "invalid" });
    expect(calls).toHaveLength(1);
  });

  it("distinguishes missing from unavailable without returning platform diagnostics", async () => {
    await expect(fixture(reply(1)).store.has(providerInstanceId)).resolves.toBe(false);
    await expect(fixture(reply(1)).store.resolve(providerInstanceId)).rejects.toMatchObject({
      category: "missing",
    });
    await expect(fixture(reply(3)).store.has(providerInstanceId)).rejects.toMatchObject({
      category: "unavailable",
    });
    await expect(fixture(reply(4)).store.resolve(providerInstanceId)).rejects.toMatchObject({
      category: "failed",
    });
  });

  it("reads a complete bounded Unicode key and never accepts malformed replies", async () => {
    await expect(fixture(reply(0, "λ-fixture")).store.resolve(providerInstanceId)).resolves.toBe(
      "λ-fixture",
    );
    for (const response of [
      { ...reply(), stdout: Buffer.from("not-a-frame") },
      { ...reply(), stdout: Buffer.concat([reply().stdout, Buffer.from("extra")]) },
      { ...reply(), stdout: Buffer.from([207, 67, 67, 82, 0, 0, 0, 0, 0]) },
      reply(0, "x".repeat(2561)),
      reply(0, ""),
      { ...reply(0, "x"), exitCode: 1 },
    ])
      await expect(fixture(response).store.resolve(providerInstanceId)).rejects.toMatchObject({
        category: "failed",
      });
    await expect(
      fixture(reply(0, "unexpected-key")).store.has(providerInstanceId),
    ).rejects.toMatchObject({ category: "failed" });
    await expect(
      fixture(reply(0, "unexpected-key")).store.set(providerInstanceId, "key"),
    ).rejects.toMatchObject({ category: "failed" });
  });

  it("never dispatches a malformed reference, scope, helper path or service family", async () => {
    const { store, calls } = fixture();
    await expect(store.delete("../other")).rejects.toBeInstanceOf(CredentialStoreFailure);
    expect(calls).toHaveLength(0);
    for (const options of [
      { helperPath: "relative.exe", storeScope },
      { helperPath: "\\\\server\\helper.exe", storeScope },
      { helperPath, storeScope: "other" },
      { helperPath, storeScope, timeoutMs: 0 },
    ])
      expect(() => makeWindowsCredentialStore(options)).toThrow(CredentialStoreFailure);
  });

  it("sends distinct scoped remove and presence operations without reading legacy targets", async () => {
    const { store, calls } = fixture();
    await expect(store.has(providerInstanceId)).resolves.toBe(true);
    await store.delete(providerInstanceId);
    expect(calls.map((call) => Buffer.from(call.input)[5])).toEqual([2, 4]);
    expect(calls.every((call) => !JSON.stringify(call.args).includes(providerInstanceId))).toBe(
      true,
    );
  });
});

it("joins a timed-out owned process before reporting credential unavailability", async () => {
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
  const store = makeWindowsCredentialStore({ helperPath, storeScope, timeoutMs: 30 });
  try {
    await expect(store.resolve(providerInstanceId)).rejects.toMatchObject({
      category: "unavailable",
      cause: "timed-out",
    });
    expect(closed).toBe(true);
    expect(child?.pid).toBeTypeOf("number");
    const pid = child?.pid;
    if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (child !== undefined && !closed) child.kill();
  }
});

it("terminates and joins a helper whose reply exceeds the private pipe limit", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let child: ReturnType<typeof spawn> | undefined;
  let closed = false;
  vi.mocked(spawn).mockImplementationOnce(() => {
    child = actual.spawn(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.alloc(3000)); setTimeout(() => process.exit(0), 10000)"],
      { env: {}, stdio: ["pipe", "pipe", "ignore"] },
    );
    child.once("close", () => {
      closed = true;
    });
    return child;
  });
  const store = makeWindowsCredentialStore({ helperPath, storeScope });
  try {
    await expect(store.resolve(providerInstanceId)).rejects.toMatchObject({
      category: "unavailable",
    });
    expect(closed).toBe(true);
    const pid = child?.pid;
    if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (child !== undefined && !closed) child.kill();
  }
});
