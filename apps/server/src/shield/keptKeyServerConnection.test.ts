import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ServerCall, ServerCallInput } from "../serverProjects/serverConnection";
import { keptKeyServerConnection } from "./keptKeyServerConnection";

const ran: ServerCall = {
  status: "ran",
  exitCode: 0,
  output: Buffer.from("ok"),
  truncated: false,
  errorOutput: "",
};
const call: ServerCallInput = { script: "true", timeoutMs: 1_000, maxOutputBytes: 1_024 };
const servers = [
  {
    serverId: "11111111-1111-4111-8111-111111111111",
    alias: "devbox",
    user: "me",
    signIn: "octant-key",
  },
  { serverId: "22222222-2222-4222-8222-222222222222", alias: "web-1", user: "me", signIn: "agent" },
];
const keys = {
  publicKey: vi.fn(async () => "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== octant"),
  signLogin: vi.fn(async () => undefined),
};

describe("install, update and removal calls to a registered server", () => {
  it("sign in to a server registered with a kept key through that key alone, not the person's agent", async () => {
    const seen: ServerCallInput[] = [];
    const open: boolean[] = [];
    const run = vi.fn(async (_server: unknown, input: ServerCallInput) => {
      seen.push(input);
      // The key's socket is open while the call runs.
      open.push(input.identityAgent === undefined ? false : existsSync(input.identityAgent));
      return ran;
    });
    const connection = keptKeyServerConnection({
      connection: { run },
      servers: () => servers,
      keys,
    });

    expect(await connection.run({ alias: "devbox", user: "me" }, call)).toBe(ran);
    expect(keys.publicKey).toHaveBeenCalledWith(servers[0]?.serverId);
    const socket = seen[0]?.identityAgent;
    expect(socket).toBeDefined();
    expect(open[0]).toBe(true);
    expect(existsSync(socket ?? "")).toBe(false);

    await connection.run({ alias: "web-1", user: "me" }, call);
    expect(seen[1]?.identityAgent).toBeUndefined();
  });

  it("refuses a kept-key server when Octant holds no key for it, without trying the person's agent", async () => {
    const run = vi.fn(async () => ran);
    const connection = keptKeyServerConnection({
      connection: { run },
      servers: () => servers,
      keys: undefined,
    });

    expect(await connection.run({ alias: "devbox", user: "me" }, call)).toMatchObject({
      status: "unreachable",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
