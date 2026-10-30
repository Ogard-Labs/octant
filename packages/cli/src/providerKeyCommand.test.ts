import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";
import {
  readHiddenLineFromTerminal,
  resolveProviderKeyCliCommand,
  runProviderKeyCliCommand,
  type ProviderKeyCliCommand,
  type ProviderKeyInput,
} from "./providerKeyCommand";

const KEY = "sk-test-0123456789";
const ID = "80000000-0000-4000-8000-000000000401";

function fixture(
  respond: (request: LocalControlRequest) => LocalControlResponse = () => ({
    status: 200,
    body: { outcome: "stored", instanceId: ID, displayName: "Private gateway" },
  }),
) {
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    sent,
    out,
    err,
    run: (
      command: ProviderKeyCliCommand,
      key: Partial<ProviderKeyInput> = {},
      platform: NodeJS.Platform = "linux",
    ) =>
      runProviderKeyCliCommand({
        command,
        session: {
          kind: "opened",
          windowId: "33333333-3333-4333-8333-333333333333",
          send: async (request) => {
            sent.push(request);
            return respond(request);
          },
          close: async () => undefined,
        },
        key: {
          interactive: true,
          readHidden: async () => KEY,
          readStdin: async () => "",
          ...key,
        },
        platform,
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => err.push(chunk) },
      }),
  };
}

const SET: ProviderKeyCliCommand = {
  action: "set",
  instance: "Private gateway",
  fromStdin: false,
  replace: false,
};

describe("octant provider key", () => {
  it("never takes the key as an argument or a flag value", () => {
    expect(resolveProviderKeyCliCommand(["key", "set", "gw", KEY], {})).toBeUndefined();
    expect(resolveProviderKeyCliCommand(["key", "set", "gw"], { stdin: KEY })).toBeUndefined();
    expect(resolveProviderKeyCliCommand(["key", "set", "gw"], { key: KEY })).toBeUndefined();
    expect(resolveProviderKeyCliCommand(["key", "set", "gw"], { replace: true })).toEqual({
      action: "set",
      instance: "gw",
      fromStdin: false,
      replace: true,
    });
  });

  it("sends a key read from the hidden prompt once and prints only the outcome", async () => {
    const { sent, out, err, run } = fixture();

    expect(await run(SET)).toBe(0);

    expect(sent).toEqual([
      {
        path: "/api/desktop/provider-credentials/set",
        method: "POST",
        body: { instance: "Private gateway", credential: KEY, replace: false },
      },
    ]);
    expect(out.join("")).toBe("Private gateway (" + ID + ") has a stored key.\n");
    expect([...out, ...err].join("")).not.toContain(KEY);
  });

  it("refuses without a terminal unless the key is piped in with --stdin", async () => {
    const { sent, err, run } = fixture();

    expect(await run(SET, { interactive: false })).toBe(1);
    expect(sent).toEqual([]);
    expect(err.join("")).toContain("--stdin");
  });

  it("reads a piped key and drops the one trailing newline", async () => {
    const { sent, run } = fixture();

    expect(
      await run(
        { ...SET, fromStdin: true },
        { interactive: false, readStdin: async () => `${KEY}\n` },
      ),
    ).toBe(0);
    expect(sent[0]?.body).toMatchObject({ credential: KEY });
  });

  it("sends nothing for an empty, cancelled, or oversized key", async () => {
    const { sent, run } = fixture();

    expect(await run(SET, { readHidden: async () => "" })).toBe(1);
    expect(await run(SET, { readHidden: async () => undefined })).toBe(1);
    expect(await run(SET, { readHidden: async () => "k".repeat(12 * 1_024 + 1) })).toBe(1);
    expect(sent).toEqual([]);
  });

  it("names Secret Service and secret-tool when a Linux host has no credential store", async () => {
    const { err, run } = fixture(() => ({
      status: 503,
      body: { category: "credential-store-unavailable", message: "unavailable" },
    }));

    expect(await run(SET)).toBe(1);
    expect(err.join("")).toContain("org.freedesktop.secrets");
    expect(err.join("")).toContain("/usr/bin/secret-tool");
    expect(err.join("")).toContain("octant server restart");
  });

  it("tells a Linux person whether the keyring is locked or has no Login keyring", async () => {
    for (const [cause, words] of [
      ["locked", "keyring is locked"],
      ["no-login-collection", 'no "Login" keyring'],
    ] as const) {
      const { err, run } = fixture(() => ({
        status: 503,
        body: { category: "credential-store-unavailable", message: "unavailable", cause },
      }));

      expect(await run(SET)).toBe(1);
      expect(err.join("")).toContain(words);
    }
  });

  it("points a macOS host without a credential store at the desktop app", async () => {
    const { err, run } = fixture(() => ({
      status: 503,
      body: { category: "credential-store-unavailable", message: "unavailable" },
    }));

    expect(await run(SET, {}, "darwin")).toBe(1);
    expect(err.join("")).toContain("desktop app");
  });

  it("lists the providers a shared name could mean", async () => {
    const { err, run } = fixture(() => ({
      status: 409,
      body: {
        category: "ambiguous",
        message: "ambiguous",
        candidates: [{ id: ID, displayName: "Private gateway" }],
      },
    }));

    expect(await run(SET)).toBe(1);
    expect(err.join("")).toContain(`  ${ID}  Private gateway`);
  });
});

describe("octant provider remove", () => {
  const REMOVE_PROVIDER: ProviderKeyCliCommand = {
    action: "remove-provider",
    instance: "Private gateway",
  };

  it("takes one provider and no flag", () => {
    expect(resolveProviderKeyCliCommand(["remove", "gw"], {})).toEqual({
      action: "remove-provider",
      instance: "gw",
    });
    expect(resolveProviderKeyCliCommand(["remove"], {})).toBeUndefined();
    expect(resolveProviderKeyCliCommand(["remove", "gw", "other"], {})).toBeUndefined();
    expect(resolveProviderKeyCliCommand(["remove", "gw"], { stdin: true })).toBeUndefined();
  });

  it("asks the host to remove the provider and its key in one request", async () => {
    const { sent, out, run } = fixture(() => ({
      status: 200,
      body: { outcome: "removed", instanceId: ID, displayName: "Private gateway" },
    }));

    expect(await run(REMOVE_PROVIDER)).toBe(0);
    expect(sent).toEqual([
      {
        path: "/api/desktop/provider-credentials/remove-provider",
        method: "POST",
        body: { instance: "Private gateway" },
      },
    ]);
    expect(out.join("")).toBe(`Private gateway (${ID}) was removed with its stored key.\n`);
  });

  it("refuses the way key remove does for an unknown, shared or unreachable provider", async () => {
    for (const command of [
      REMOVE_PROVIDER,
      { action: "remove", instance: "Private gateway" } as const,
    ]) {
      const notFound = fixture(() => ({
        status: 404,
        body: { category: "not-found", message: "x" },
      }));
      expect(await notFound.run(command)).toBe(1);
      expect(notFound.err.join("")).toContain('No provider has the id or name "Private gateway".');

      const shared = fixture(() => ({
        status: 409,
        body: {
          category: "ambiguous",
          message: "x",
          candidates: [{ id: ID, displayName: "Private gateway" }],
        },
      }));
      expect(await shared.run(command)).toBe(1);
      expect(shared.err.join("")).toContain(`  ${ID}  Private gateway`);

      const noStore = fixture(() => ({
        status: 503,
        body: { category: "credential-store-unavailable", message: "x" },
      }));
      expect(await noStore.run(command)).toBe(1);
      expect(noStore.err.join("")).toContain("org.freedesktop.secrets");
    }
  });

  it("says why the provider stays and how to clear a key that was left", async () => {
    const refused = fixture(() => ({
      status: 409,
      body: { category: "provider-refused", message: "The provider has an active session." },
    }));
    expect(await refused.run(REMOVE_PROVIDER)).toBe(1);
    expect(refused.err.join("")).toContain("was not removed: The provider has an active session.");

    const kept = fixture(() => ({
      status: 503,
      body: { category: "provider-removed-key-kept", message: "x", instanceId: ID },
    }));
    expect(await kept.run(REMOVE_PROVIDER)).toBe(1);
    expect(kept.err.join("")).toContain(`octant provider key remove ${ID}`);
  });
});

describe("hidden terminal prompt", () => {
  it("writes the prompt but never echoes a keystroke", async () => {
    const terminal = Object.assign(new EventEmitter(), {
      isRaw: false,
      modes: [] as boolean[],
      setRawMode(mode: boolean) {
        this.modes.push(mode);
      },
      resume: () => undefined,
      pause: () => undefined,
    });
    const written: string[] = [];

    const line = readHiddenLineFromTerminal(
      terminal,
      { write: (chunk) => written.push(chunk) },
      "Key: ",
    );
    terminal.emit("data", Buffer.from("sk-tesx\u007ft-01"));
    terminal.emit("data", Buffer.from("23456789\r"));

    expect(await line).toBe(KEY);
    expect(written).toEqual(["Key: ", "\n"]);
    expect(terminal.modes).toEqual([true, false]);
  });
});
