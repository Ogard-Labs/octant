import { describe, expect, it, vi } from "vitest";
import { CredentialStoreFailure } from "./credentialStore";
import {
  CMDKEY_PATH,
  POWERSHELL_PATH,
  makeWindowsCredentialStore,
  type WindowsCommandResult,
  type WindowsCommandSpec,
} from "./windowsCredentialStore";

const providerInstanceId = "72000000-0000-4000-8000-000000000005";
const target = `Octant provider credential ${providerInstanceId}`;

function executor(results: ReadonlyArray<Partial<WindowsCommandResult>>) {
  const calls: WindowsCommandSpec[] = [];
  let index = 0;
  return {
    calls,
    execute: async (spec: WindowsCommandSpec): Promise<WindowsCommandResult> => {
      calls.push(spec);
      const next = results[index] ?? {};
      index += 1;
      return { exitCode: 0, stdout: "", stderr: "", ...next };
    },
  };
}

describe("makeWindowsCredentialStore", () => {
  it("stores a credential with cmdkey under a target that names the provider", async () => {
    const fake = executor([{ exitCode: 0 }]);
    const store = makeWindowsCredentialStore({ execute: fake.execute });

    await store.set(providerInstanceId, "secret-value");

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.command).toBe(CMDKEY_PATH);
    expect(fake.calls[0]?.args).toEqual([
      `/generic:${target}`,
      "/user:octant",
      "/pass:secret-value",
    ]);
  });

  it("reports presence only when the listing names this provider", async () => {
    const present = executor([{ exitCode: 0, stdout: `${target}\r\n` }]);
    await expect(
      makeWindowsCredentialStore({ execute: present.execute }).has(providerInstanceId),
    ).resolves.toBe(true);

    const absent = executor([{ exitCode: 1, stdout: "" }]);
    await expect(
      makeWindowsCredentialStore({ execute: absent.execute }).has(providerInstanceId),
    ).resolves.toBe(false);
  });

  it("reads a credential back through the Win32 API, with the target in the environment", async () => {
    const fake = executor([{ exitCode: 0, stdout: "secret-value" }]);
    const store = makeWindowsCredentialStore({ execute: fake.execute });

    await expect(store.resolve(providerInstanceId)).resolves.toBe("secret-value");

    expect(fake.calls[0]?.command).toBe(POWERSHELL_PATH);
    expect(fake.calls[0]?.args).toContain("-NoProfile");
    // The target travels in the environment, so a credential id never appears
    // in a process listing.
    expect(fake.calls[0]?.args.join(" ")).not.toContain(target);
    expect(fake.calls[0]?.environment?.OCTANT_CRED_TARGET).toBe(target);
  });

  it("reports a missing credential as missing rather than failed", async () => {
    const fake = executor([{ exitCode: 3 }]);
    const store = makeWindowsCredentialStore({ execute: fake.execute });

    await expect(store.resolve(providerInstanceId)).rejects.toMatchObject({ category: "missing" });
  });

  it("refuses an identifier that is not a provider instance id", async () => {
    const fake = executor([]);
    const store = makeWindowsCredentialStore({ execute: fake.execute });

    await expect(store.set("../../etc/passwd", "value")).rejects.toBeInstanceOf(
      CredentialStoreFailure,
    );
    await expect(store.has("not-a-uuid")).rejects.toMatchObject({ category: "invalid" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses an empty credential and an unusable timeout", async () => {
    const fake = executor([]);
    const store = makeWindowsCredentialStore({ execute: fake.execute });

    await expect(store.set(providerInstanceId, "")).rejects.toMatchObject({ category: "invalid" });
    expect(() => makeWindowsCredentialStore({ execute: fake.execute, timeoutMs: 0 })).toThrow(
      CredentialStoreFailure,
    );
  });

  it("deletes by target", async () => {
    const fake = executor([{ exitCode: 0 }]);
    const store = makeWindowsCredentialStore({ execute: fake.execute });

    await store.delete(providerInstanceId);

    expect(fake.calls[0]?.args).toEqual([`/delete:${target}`]);
  });
});
