import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CredentialPurgeFailure, CredentialStoreFailure } from "@octant/host-runtime";
import {
  KEYCHAIN_HELPER_MAX_BYTES,
  keychainHelperSpec,
  keychainPurgeHelperSpec,
  makeKeychainCredentialPurgeStore as makeNativeKeychainCredentialPurgeStore,
  makeKeychainCredentialStore as makeNativeKeychainCredentialStore,
  type KeychainHelperExecutor,
} from "./keychainCredentialStore";

const providerInstanceId = "7d444840-9dc0-11d1-b245-5ffdce74fad2";
const storeScope = "7d444840-9dc0-41d1-b245-5ffdce74fad2";
const helperPath = "/Applications/Octant.app/Contents/Resources/native/octant-keychain-helper";

type StoreOptions = Omit<Parameters<typeof makeNativeKeychainCredentialStore>[1], "storeScope">;

function makeKeychainCredentialStore(helperPath: string, options: StoreOptions = {}) {
  return makeNativeKeychainCredentialStore(helperPath, { storeScope, ...options });
}

function makeKeychainCredentialPurgeStore(helperPath: string, options: StoreOptions = {}) {
  return makeNativeKeychainCredentialPurgeStore(helperPath, { storeScope, ...options });
}

function purgeInput(dryRun: boolean) {
  return { dryRun, providerInstanceIds: [providerInstanceId] };
}

describe("keychainHelperSpec", () => {
  it("passes set credentials through stdin and never process arguments", () => {
    const spec = keychainHelperSpec(
      helperPath,
      {
        operation: "set",
        providerInstanceId,
        credential: "private-value",
      },
      storeScope,
    );

    expect(spec.command).toBe(helperPath);
    expect(spec.args).toEqual([]);
    expect(spec.stdin).toContain("private-value");
    expect(spec.stdin.endsWith("\n")).toBe(true);
    expect(JSON.parse(spec.stdin)).toEqual({
      version: 1,
      storeScope,
      operation: "set",
      providerInstanceId,
      credential: "private-value",
    });
    expect(JSON.stringify(spec.args)).not.toContain("private-value");
  });

  it("uses the fixed service implicitly rather than accepting arbitrary Keychain keys", () => {
    const spec = keychainHelperSpec(
      helperPath,
      {
        operation: "has",
        providerInstanceId,
      },
      storeScope,
    );

    expect(JSON.parse(spec.stdin)).toEqual({
      version: 1,
      storeScope,
      operation: "has",
      providerInstanceId,
    });
    expect(spec.stdin).not.toContain("service");
  });
});

describe("makeKeychainCredentialStore", () => {
  it("round-trips only typed protocol responses through a bounded executor", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async (_spec, limits) => {
      expect(limits).toEqual({ maxBytes: KEYCHAIN_HELPER_MAX_BYTES, timeoutMs: 2_000 });
      return {
        exitCode: 0,
        stdout: '{"version":1,"ok":true,"credential":"stored-value"}\n',
        stderr: "",
      };
    });
    const store = makeKeychainCredentialStore(helperPath, { execute });

    await expect(store.resolve(providerInstanceId)).resolves.toBe("stored-value");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("supports set, presence, and delete without exposing credentials in arguments", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async (spec) => {
      const request = JSON.parse(spec.stdin) as { operation: string };
      if (request.operation === "has") {
        return { exitCode: 0, stdout: '{"version":1,"ok":true,"present":true}\n', stderr: "" };
      }
      return { exitCode: 0, stdout: '{"version":1,"ok":true}\n', stderr: "" };
    });
    const store = makeKeychainCredentialStore(helperPath, { execute });

    await expect(store.set(providerInstanceId, "private-value")).resolves.toBeUndefined();
    await expect(store.has(providerInstanceId)).resolves.toBe(true);
    await expect(store.delete(providerInstanceId)).resolves.toBeUndefined();
    expect(execute.mock.calls[0]?.[0].args).toEqual([]);
    expect(JSON.stringify(execute.mock.calls[0]?.[0].args)).not.toContain("private-value");
  });

  it.each(["not-a-uuid", ""])(
    "rejects invalid provider-instance ID %j before launching the helper",
    async (invalidId) => {
      const execute = vi.fn<KeychainHelperExecutor>();
      const store = makeKeychainCredentialStore(helperPath, { execute });

      await expect(store.has(invalidId)).rejects.toMatchObject({
        name: "CredentialStoreFailure",
        category: "invalid",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("normalizes valid UUID text to one deterministic Keychain account", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async (spec) => {
      expect(JSON.parse(spec.stdin)).toMatchObject({ providerInstanceId });
      return { exitCode: 0, stdout: '{"version":1,"ok":true,"present":false}\n', stderr: "" };
    });
    const store = makeKeychainCredentialStore(helperPath, { execute });

    await expect(store.has(providerInstanceId.toUpperCase())).resolves.toBe(false);
  });

  it("rejects oversized credentials before launching the helper", async () => {
    const execute = vi.fn<KeychainHelperExecutor>();
    const store = makeKeychainCredentialStore(helperPath, { execute });

    await expect(
      store.set(providerInstanceId, "s".repeat(KEYCHAIN_HELPER_MAX_BYTES)),
    ).rejects.toBeInstanceOf(CredentialStoreFailure);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "missing"],
    ["unavailable", "unavailable"],
    ["failed", "failed"],
  ] as const)("maps helper %s status without raw diagnostics", async (status, category) => {
    const execute: KeychainHelperExecutor = async () => ({
      exitCode: 1,
      stdout: JSON.stringify({ version: 1, ok: false, error: status }) + "\n",
      stderr: "",
    });
    const store = makeKeychainCredentialStore(helperPath, { execute });

    await expect(store.resolve(providerInstanceId)).rejects.toMatchObject({
      name: "CredentialStoreFailure",
      category,
    });
  });

  it.each([
    ["stderr", { exitCode: 0, stdout: '{"version":1,"ok":true}\n', stderr: "private diagnostic" }],
    ["malformed output", { exitCode: 0, stdout: "not-json\n", stderr: "" }],
    ["multiple output lines", { exitCode: 0, stdout: "{}\n{}\n", stderr: "" }],
    [
      "oversized output",
      { exitCode: 0, stdout: "x".repeat(KEYCHAIN_HELPER_MAX_BYTES + 1), stderr: "" },
    ],
  ])("rejects %s with a sanitized failure", async (_case, result) => {
    const execute: KeychainHelperExecutor = async () => result;
    const store = makeKeychainCredentialStore(helperPath, { execute });

    const failure = await store.has(providerInstanceId).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "CredentialStoreFailure", category: "failed" });
    expect(String(failure)).not.toContain("private diagnostic");
  });

  it("rejects diagnostic fields attached to a stable helper failure", async () => {
    const execute: KeychainHelperExecutor = async () => ({
      exitCode: 1,
      stdout: '{"version":1,"ok":false,"error":"missing","diagnostic":"private diagnostic"}\n',
      stderr: "",
    });
    const store = makeKeychainCredentialStore(helperPath, { execute });

    await expect(store.resolve(providerInstanceId)).rejects.toMatchObject({
      name: "CredentialStoreFailure",
      category: "failed",
    });
  });

  it("maps executor timeout/failure without leaking raw errors", async () => {
    const execute: KeychainHelperExecutor = async () => {
      throw new Error("private-value from helper");
    };
    const store = makeKeychainCredentialStore(helperPath, { execute, timeoutMs: 10 });

    const failure = await store.has(providerInstanceId).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "CredentialStoreFailure", category: "unavailable" });
    expect(String(failure)).not.toContain("private-value");
  });

  it("preserves a stable helper failure response from a nonzero child exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-keychain-helper-"));
    const executable = join(directory, "helper");
    await writeFile(
      executable,
      '#!/bin/sh\nread -r request\nprintf \'%s\\n\' \'{"version":1,"ok":false,"error":"missing"}\'\nexit 1\n',
      "utf8",
    );
    await chmod(executable, 0o700);

    try {
      const store = makeKeychainCredentialStore(executable);
      await expect(store.resolve(providerInstanceId)).rejects.toMatchObject({
        name: "CredentialStoreFailure",
        category: "missing",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a success payload from a nonzero child exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-keychain-helper-"));
    const executable = join(directory, "helper");
    await writeFile(
      executable,
      '#!/bin/sh\nread -r request\nprintf \'%s\\n\' \'{"version":1,"ok":true,"present":true}\'\nexit 1\n',
      "utf8",
    );
    await chmod(executable, 0o700);

    try {
      const store = makeKeychainCredentialStore(executable);
      await expect(store.has(providerInstanceId)).rejects.toMatchObject({
        name: "CredentialStoreFailure",
        category: "failed",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for a timed-out helper to close and clears captured buffers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-keychain-timeout-"));
    const executable = join(directory, "helper");
    const pidPath = join(directory, "pid");
    const readyPath = join(directory, "ready");
    const partialOutput = '{"private":"partial-value"';
    await writeFile(
      executable,
      `#!/bin/sh\nread -r request\nprintf '%s' "$$" > ${JSON.stringify(pidPath)}\nprintf '%s' '${partialOutput}'\nprintf 'ready' > ${JSON.stringify(readyPath)}\nexec sleep 60\n`,
      "utf8",
    );
    await chmod(executable, 0o700);
    const originalFill = Buffer.prototype.fill;
    const originalToString = Buffer.prototype.toString;
    const clearedContents: string[] = [];
    const convertedContents: string[] = [];
    const fill = vi.spyOn(Buffer.prototype, "fill").mockImplementation(function (
      this: Buffer,
      ...args: unknown[]
    ) {
      clearedContents.push(originalToString.call(this, "utf8"));
      return Reflect.apply(originalFill, this, args) as Buffer;
    });
    const toString = vi.spyOn(Buffer.prototype, "toString").mockImplementation(function (
      this: Buffer,
      ...args: unknown[]
    ) {
      const value = Reflect.apply(originalToString, this, args) as string;
      convertedContents.push(value);
      return value;
    });

    try {
      const store = makeKeychainCredentialStore(executable, { timeoutMs: 3_000 });
      const operation = store.has(providerInstanceId);
      await waitForFile(readyPath);
      const pid = Number(await readFile(pidPath, "utf8"));
      const failure = await operation.catch((error: unknown) => error);

      expect(failure).toMatchObject({
        name: "CredentialStoreFailure",
        category: "unavailable",
      });
      expect(() => process.kill(pid, 0)).toThrow();
      expect(clearedContents).toContain(partialOutput);
      expect(clearedContents).toContain(
        JSON.stringify({ version: 1, storeScope, operation: "has", providerInstanceId }) + "\n",
      );
      expect(convertedContents).not.toContain(partialOutput);
    } finally {
      toString.mockRestore();
      fill.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("keychainPurgeHelperSpec", () => {
  it("sends only the selected store's provider identities through stdin", () => {
    const spec = keychainPurgeHelperSpec(helperPath, purgeInput(true), storeScope);

    expect(spec.command).toBe(helperPath);
    expect(spec.args).toEqual([]);
    expect(JSON.parse(spec.stdin)).toEqual({
      version: 1,
      operation: "purge",
      dryRun: true,
      storeScope,
      providerInstanceIds: [providerInstanceId],
      hostIdentityFingerprint: null,
    });
  });
});

describe("makeKeychainCredentialPurgeStore", () => {
  it("reports a dry-run match count without deleting anything", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async (spec) => {
      expect(JSON.parse(spec.stdin)).toEqual({
        version: 1,
        operation: "purge",
        dryRun: true,
        storeScope,
        providerInstanceIds: [providerInstanceId],
        hostIdentityFingerprint: null,
      });
      return {
        exitCode: 0,
        stdout: '{"version":1,"ok":true,"operation":"purge","dryRun":true,"matchedCount":3}\n',
        stderr: "",
      };
    });
    const store = makeKeychainCredentialPurgeStore(helperPath, { execute });

    await expect(store.purge(purgeInput(true))).resolves.toEqual({ dryRun: true, matchedCount: 3 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("forwards only the selected store's unique provider identities", async () => {
    const secondStoreProvider = "8d444840-9dc0-41d1-b245-5ffdce74fad2";
    const secondStoreScope = "9d444840-9dc0-41d1-b245-5ffdce74fad2";
    const observedRequests: unknown[] = [];
    const execute = vi.fn<KeychainHelperExecutor>(async (spec) => {
      const request = JSON.parse(spec.stdin) as {
        storeScope: string;
        providerInstanceIds: unknown;
      };
      observedRequests.push(request);
      return {
        exitCode: 0,
        stdout: '{"version":1,"ok":true,"operation":"purge","dryRun":true,"matchedCount":1}\n',
        stderr: "",
      };
    });
    const firstStore = makeKeychainCredentialPurgeStore(helperPath, { execute });
    const secondStore = makeNativeKeychainCredentialPurgeStore(helperPath, {
      execute,
      storeScope: secondStoreScope,
    });

    await expect(firstStore.purge(purgeInput(true))).resolves.toEqual({
      dryRun: true,
      matchedCount: 1,
    });
    await expect(
      firstStore.purge({
        dryRun: true,
        providerInstanceIds: [providerInstanceId, providerInstanceId],
      }),
    ).rejects.toMatchObject({ name: "CredentialPurgeFailure", category: "failed" });
    await expect(
      secondStore.purge({ dryRun: true, providerInstanceIds: [secondStoreProvider] }),
    ).resolves.toEqual({ dryRun: true, matchedCount: 1 });
    expect(observedRequests).toEqual([
      {
        version: 1,
        operation: "purge",
        dryRun: true,
        storeScope,
        providerInstanceIds: [providerInstanceId],
        hostIdentityFingerprint: null,
      },
      {
        version: 1,
        operation: "purge",
        dryRun: true,
        storeScope: secondStoreScope,
        providerInstanceIds: [secondStoreProvider],
        hostIdentityFingerprint: null,
      },
    ]);
  });

  it("forwards selected-store host identity evidence only through the purge protocol", async () => {
    const hostIdentityFingerprint = "a".repeat(64);
    const execute = vi.fn<KeychainHelperExecutor>(async (spec) => {
      expect(JSON.parse(spec.stdin)).toMatchObject({
        operation: "purge",
        storeScope,
        providerInstanceIds: [providerInstanceId],
        hostIdentityFingerprint,
      });
      return {
        exitCode: 0,
        stdout: '{"version":1,"ok":true,"operation":"purge","dryRun":true,"matchedCount":1}\n',
        stderr: "",
      };
    });
    const store = makeKeychainCredentialPurgeStore(helperPath, { execute });

    await expect(store.purge({ ...purgeInput(true), hostIdentityFingerprint })).resolves.toEqual({
      dryRun: true,
      matchedCount: 1,
    });
  });

  it("rejects malformed host identity evidence before invoking the helper", async () => {
    const execute = vi.fn<KeychainHelperExecutor>();
    const store = makeKeychainCredentialPurgeStore(helperPath, { execute });

    await expect(
      store.purge({ ...purgeInput(true), hostIdentityFingerprint: "not-a-fingerprint" }),
    ).rejects.toMatchObject({ category: "failed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a completed purge with the exact deleted count", async () => {
    const execute: KeychainHelperExecutor = async () => ({
      exitCode: 0,
      stdout:
        '{"version":1,"ok":true,"operation":"purge","dryRun":false,"deletedCount":2,"failedCount":0}\n',
      stderr: "",
    });
    const store = makeKeychainCredentialPurgeStore(helperPath, { execute });

    await expect(store.purge(purgeInput(false))).resolves.toEqual({
      dryRun: false,
      deletedCount: 2,
      failedCount: 0,
    });
  });

  it("reports a partially failing purge instead of hiding the failure count", async () => {
    const execute: KeychainHelperExecutor = async () => ({
      exitCode: 0,
      stdout:
        '{"version":1,"ok":true,"operation":"purge","dryRun":false,"deletedCount":1,"failedCount":1}\n',
      stderr: "",
    });
    const store = makeKeychainCredentialPurgeStore(helperPath, { execute });

    await expect(store.purge(purgeInput(false))).resolves.toEqual({
      dryRun: false,
      deletedCount: 1,
      failedCount: 1,
    });
  });

  it.each([
    ["locked", "locked"],
    ["unavailable", "unavailable"],
    ["failed", "failed"],
  ] as const)("maps a %s helper error without raw diagnostics", async (status, category) => {
    const execute: KeychainHelperExecutor = async () => ({
      exitCode: 1,
      stdout: JSON.stringify({ version: 1, ok: false, error: status }) + "\n",
      stderr: "",
    });
    const store = makeKeychainCredentialPurgeStore(helperPath, { execute });

    await expect(store.purge(purgeInput(false))).rejects.toMatchObject({
      name: "CredentialPurgeFailure",
      category,
    });
  });

  it("never leaks stderr diagnostics on a malformed purge response", async () => {
    const execute: KeychainHelperExecutor = async () => ({
      exitCode: 0,
      stdout: '{"version":1,"ok":true,"operation":"purge","dryRun":false,"deletedCount":1}\n',
      stderr: "private diagnostic",
    });
    const store = makeKeychainCredentialPurgeStore(helperPath, { execute });

    const failure = await store.purge(purgeInput(false)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialPurgeFailure);
    expect(String(failure)).not.toContain("private diagnostic");
  });

  it("maps a dry-run executor timeout/crash to unavailable without leaking raw errors", async () => {
    const execute: KeychainHelperExecutor = async () => {
      throw new Error("private-value from helper");
    };
    const store = makeKeychainCredentialPurgeStore(helperPath, { execute, timeoutMs: 10 });

    const failure = await store.purge(purgeInput(true)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "CredentialPurgeFailure", category: "unavailable" });
    expect(String(failure)).not.toContain("private-value");
  });

  it("classifies a destructive executor timeout/crash as indeterminate", async () => {
    const execute: KeychainHelperExecutor = async () => {
      throw new Error("private-value from helper");
    };
    const store = makeKeychainCredentialPurgeStore(helperPath, { execute, timeoutMs: 10 });

    await expect(store.purge(purgeInput(false))).rejects.toMatchObject({
      name: "CredentialPurgeFailure",
      category: "indeterminate",
    });
  });

  it("classifies a malformed destructive response as indeterminate", async () => {
    const execute: KeychainHelperExecutor = async () => ({
      exitCode: 0,
      stdout: '{"version":1,"ok":true,"operation":"purge","dryRun":false,"deletedCount":1}\n',
      stderr: "",
    });
    const store = makeKeychainCredentialPurgeStore(helperPath, { execute });

    await expect(store.purge(purgeInput(false))).rejects.toMatchObject({
      name: "CredentialPurgeFailure",
      category: "indeterminate",
    });
  });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed-out helper did not start.");
}
