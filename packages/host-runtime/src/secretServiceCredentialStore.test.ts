import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  makeSecretServiceCredentialStore,
  probeSecretService,
  SECRET_SERVICE_ATTRIBUTE,
  SECRET_SERVICE_BUSCTL_PATH,
  SECRET_TOOL_PATH,
  type SecretToolCommandExecutor,
  type SecretToolCommandResult,
} from "./secretServiceCredentialStore";
import { CredentialStoreFailure } from "./credentialStore";

const providerInstanceId = randomUUID();
const credential = "provider-secret";

function result(overrides: Partial<SecretToolCommandResult> = {}): SecretToolCommandResult {
  return { exitCode: 0, stdout: "", stderr: "", ...overrides };
}

describe("Secret Service credential store", () => {
  it("round-trips credentials through secret-tool stdin and fixed attributes", async () => {
    const values = new Map<string, string>();
    const commands: Array<{ command: string; args: readonly string[]; stdin?: string }> = [];
    const execute: SecretToolCommandExecutor = async (spec) => {
      commands.push(spec);
      const account = spec.args.at(-1);
      if (spec.args[0] === "store" && account !== undefined) {
        values.set(account, spec.stdin ?? "");
        return result();
      }
      if (spec.args[0] === "lookup" && account !== undefined) {
        const value = values.get(account);
        return value === undefined
          ? result({ exitCode: 1, stderr: "No such secret" })
          : result({ stdout: `${value}\n` });
      }
      if (spec.args[0] === "clear" && account !== undefined) {
        values.delete(account);
        return result();
      }
      throw new Error("unexpected command");
    };
    const store = makeSecretServiceCredentialStore({ execute });

    await store.set(providerInstanceId, credential);
    await expect(store.has(providerInstanceId)).resolves.toBe(true);
    await expect(store.resolve(providerInstanceId)).resolves.toBe(credential);
    await store.delete(providerInstanceId);
    await expect(store.has(providerInstanceId)).resolves.toBe(false);

    expect(commands[0]).toEqual({
      command: SECRET_TOOL_PATH,
      args: [
        "store",
        "--label=Octant provider credential",
        "service",
        SECRET_SERVICE_ATTRIBUTE,
        "account",
        providerInstanceId,
      ],
      stdin: credential,
    });
    expect(commands.every(({ command }) => command === SECRET_TOOL_PATH)).toBe(true);
    expect(commands.every(({ args }) => !args.includes(credential))).toBe(true);
  });

  it("keeps whitespace-only credentials present after lookup", async () => {
    const values = new Map<string, string>();
    const execute: SecretToolCommandExecutor = async (spec) => {
      const account = spec.args.at(-1);
      if (spec.args[0] === "store" && account !== undefined) {
        values.set(account, spec.stdin ?? "");
        return result();
      }
      if (spec.args[0] === "lookup" && account !== undefined) {
        const value = values.get(account);
        return value === undefined
          ? result({ exitCode: 1, stderr: "No such secret" })
          : result({ stdout: `${value}\n` });
      }
      throw new Error("unexpected command");
    };
    const store = makeSecretServiceCredentialStore({ execute });

    await store.set(providerInstanceId, " ");
    await expect(store.has(providerInstanceId)).resolves.toBe(true);
    await expect(store.resolve(providerInstanceId)).resolves.toBe(" ");
  });

  it("maps missing tools, locked stores, nonzero exits, and empty output to typed failures", async () => {
    const unavailable = makeSecretServiceCredentialStore({
      execute: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    await expect(unavailable.has(providerInstanceId)).rejects.toMatchObject({
      name: "CredentialStoreFailure",
      category: "unavailable",
    });

    const locked = makeSecretServiceCredentialStore({
      execute: async () => result({ exitCode: 1, stderr: "The collection is locked" }),
    });
    await expect(locked.resolve(providerInstanceId)).rejects.toMatchObject({
      name: "CredentialStoreFailure",
      category: "unavailable",
    });

    const failed = makeSecretServiceCredentialStore({
      execute: async () => result({ exitCode: 1, stderr: "unexpected failure" }),
    });
    await expect(failed.resolve(providerInstanceId)).rejects.toMatchObject({
      name: "CredentialStoreFailure",
      category: "failed",
    });

    const empty = makeSecretServiceCredentialStore({
      execute: async () => result(),
    });
    await expect(empty.has(providerInstanceId)).rejects.toMatchObject({
      name: "CredentialStoreFailure",
      category: "failed",
    });
    await expect(empty.resolve(providerInstanceId)).rejects.toMatchObject({
      name: "CredentialStoreFailure",
      category: "failed",
    });

    const timeout = makeSecretServiceCredentialStore({
      execute: async () => {
        throw new Error("secret-tool timed out");
      },
    });
    await expect(timeout.delete(providerInstanceId)).rejects.toBeInstanceOf(CredentialStoreFailure);
  });

  it("requires both a responding Secret Service and the client tool", async () => {
    const commands: string[] = [];
    const available = await probeSecretService(
      {
        run: async (command) => {
          commands.push(command);
          return { stdout: "available\n", stderr: "" };
        },
      },
      async () => true,
    );
    expect(available).toEqual({ available: true, service: "available", tool: "available" });
    expect(commands).toEqual([SECRET_SERVICE_BUSCTL_PATH]);

    const missingTool = await probeSecretService(
      {
        run: async () => {
          return { stdout: "available\n", stderr: "" };
        },
      },
      async () => false,
    );
    expect(missingTool).toEqual({ available: false, service: "available", tool: "unavailable" });
  });

  it("treats Secret Service diagnostics on stderr as unavailable", async () => {
    const result = await probeSecretService(
      {
        run: async () => ({ stdout: "", stderr: "service unavailable" }),
      },
      async () => true,
    );
    expect(result).toEqual({ available: false, service: "unavailable", tool: "available" });
  });

  it("treats a bus response with diagnostics on stderr as unavailable", async () => {
    const result = await probeSecretService(
      {
        run: async () => ({ stdout: "service present", stderr: "diagnostic" }),
      },
      async () => true,
    );
    expect(result).toEqual({ available: false, service: "unavailable", tool: "available" });
  });
});
