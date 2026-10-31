import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  makeSecretServiceCredentialStore,
  probeSecretService,
  SECRET_SERVICE_ATTRIBUTE,
  SECRET_SERVICE_BUSCTL_PATH,
  SECRET_SERVICE_REPLICA_DEVICE_KEY_ATTRIBUTE,
  SECRET_SERVICE_REPLICA_STORE_CREDENTIAL_ATTRIBUTE,
  SECRET_TOOL_PATH,
  type SecretToolCommandExecutor,
  type SecretToolCommandResult,
} from "./secretServiceCredentialStore";
import { addApiKey, apiKeysInUseOrder } from "./apiKeyPool";
import { CredentialStoreFailure } from "./credentialStore";

const providerInstanceId = randomUUID();
const credential = "provider-secret";

function result(overrides: Partial<SecretToolCommandResult> = {}): SecretToolCommandResult {
  return { exitCode: 0, stdout: "", stderr: "", ...overrides };
}

describe("Secret Service credential store", () => {
  it("files replica device keys under their own service attribute", async () => {
    const commands: Array<{ readonly args: readonly string[] }> = [];
    const execute: SecretToolCommandExecutor = async (spec) => {
      commands.push(spec);
      return result({ stdout: spec.args[0] === "lookup" ? "device-private" : "" });
    };
    const deviceKeys = makeSecretServiceCredentialStore({
      execute,
      namespace: "replica-device-key",
    });
    await deviceKeys.set(providerInstanceId, "device-private");
    await deviceKeys.resolve(providerInstanceId);
    await deviceKeys.delete(providerInstanceId);
    for (const command of commands) {
      const service = command.args[command.args.indexOf("service") + 1];
      expect(service).toBe(SECRET_SERVICE_REPLICA_DEVICE_KEY_ATTRIBUTE);
      expect(service).not.toBe(SECRET_SERVICE_ATTRIBUTE);
    }
  });

  it("files sync bucket key pairs under their own service attribute", async () => {
    const commands: Array<{ readonly args: readonly string[] }> = [];
    const execute: SecretToolCommandExecutor = async (spec) => {
      commands.push(spec);
      return result({ stdout: spec.args[0] === "lookup" ? "bucket-key-pair" : "" });
    };
    const bucketKeys = makeSecretServiceCredentialStore({
      execute,
      namespace: "replica-store-credential",
    });
    await bucketKeys.set(providerInstanceId, "bucket-key-pair");
    await bucketKeys.resolve(providerInstanceId);
    await bucketKeys.delete(providerInstanceId);
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      const service = command.args[command.args.indexOf("service") + 1];
      expect(service).toBe(SECRET_SERVICE_REPLICA_STORE_CREDENTIAL_ATTRIBUTE);
      expect(service).not.toBe(SECRET_SERVICE_ATTRIBUTE);
      expect(service).not.toBe(SECRET_SERVICE_REPLICA_DEVICE_KEY_ATTRIBUTE);
    }
  });

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

  it("says a locked keyring is locked and a missing login keyring is missing", async () => {
    const storing = (stderr: string) =>
      makeSecretServiceCredentialStore({
        execute: async () => result({ exitCode: 1, stderr }),
      }).set(providerInstanceId, credential);
    await expect(
      storing("secret-tool: Cannot create an item in a locked collection"),
    ).rejects.toMatchObject({
      category: "unavailable",
      cause: "locked",
    });
    await expect(
      storing("secret-tool: Cannot get secret of a locked object"),
    ).rejects.toMatchObject({ cause: "locked" });
    await expect(
      storing(
        'secret-tool: Object does not exist at path "/org/freedesktop/secrets/collection/login"',
      ),
    ).rejects.toMatchObject({ category: "unavailable", cause: "no-login-collection" });
    await expect(storing("secret-tool: unexpected failure")).rejects.toMatchObject({
      category: "failed",
      cause: undefined,
    });
  });

  it("names a keyring nobody started, a denied caller, and a missing tool", async () => {
    const storing = (stderr: string) =>
      makeSecretServiceCredentialStore({
        execute: async () => result({ exitCode: 1, stderr }),
      }).set(providerInstanceId, credential);
    for (const stderr of [
      "secret-tool: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files",
      "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY",
      "secret-tool: dbus connection refused",
    ]) {
      await expect(storing(stderr)).rejects.toMatchObject({
        category: "unavailable",
        cause: "no-service",
      });
    }
    await expect(
      storing(
        "secret-tool: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: Permission denied",
      ),
    ).rejects.toMatchObject({ category: "unavailable", cause: "denied" });

    const missingTool = makeSecretServiceCredentialStore({
      execute: async () => {
        throw Object.assign(new Error("spawn /usr/bin/secret-tool ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(missingTool.set(providerInstanceId, credential)).rejects.toMatchObject({
      category: "unavailable",
      cause: "no-tool",
    });

    const silent = makeSecretServiceCredentialStore({
      execute: async () => {
        throw new Error("secret-tool timed out");
      },
    });
    await expect(silent.set(providerInstanceId, credential)).rejects.toMatchObject({
      category: "unavailable",
      cause: "timed-out",
    });
  });

  it("reads a keyring that is not running as unavailable, never as a missing key", async () => {
    const down = makeSecretServiceCredentialStore({
      execute: async () =>
        result({
          exitCode: 1,
          stderr:
            "secret-tool: The name org.freedesktop.secrets was not provided by any .service files",
        }),
    });
    await expect(down.has(providerInstanceId)).rejects.toMatchObject({ cause: "no-service" });
    await expect(down.resolve(providerInstanceId)).rejects.toMatchObject({ cause: "no-service" });
  });

  it("hands back exactly the key a person entered, whatever the label around it holds", async () => {
    const stored = new Map<string, string>();
    const store = makeSecretServiceCredentialStore({
      execute: async (spec) => {
        const account = spec.args[spec.args.indexOf("account") + 1] ?? "";
        if (spec.args[0] === "store") {
          stored.set(account, spec.stdin ?? "");
          return result();
        }
        // secret-tool prints the stored bytes as they are.
        return result({ stdout: stored.get(account) ?? "" });
      },
    });
    const typed = `test-key_${"Ab0-_=".repeat(16)}`;
    // A pasted key often carries its line break; only that edge is dropped.
    const entered = addApiKey(undefined, { secret: `${typed}\n`, label: "Nøkkel – work" });
    await store.set(providerInstanceId, entered.stored);
    const [key] = apiKeysInUseOrder(await store.resolve(providerInstanceId));
    expect(key?.secret).toBe(typed);
    expect(key?.label).toBe("Nøkkel – work");
  });

  it("works on the next call once a keyring that was down starts answering", async () => {
    let running = false;
    const stored = new Map<string, string>();
    const store = makeSecretServiceCredentialStore({
      execute: async (spec) => {
        if (!running) {
          return result({ exitCode: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" });
        }
        const account = spec.args[spec.args.indexOf("account") + 1] ?? "";
        if (spec.args[0] === "store") {
          stored.set(account, spec.stdin ?? "");
          return result();
        }
        const value = stored.get(account);
        return value === undefined ? result({ exitCode: 1 }) : result({ stdout: value });
      },
    });
    await expect(store.set(providerInstanceId, credential)).rejects.toMatchObject({
      cause: "no-service",
    });
    running = true;
    await store.set(providerInstanceId, credential);
    await expect(store.resolve(providerInstanceId)).resolves.toBe(credential);
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
