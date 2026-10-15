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
