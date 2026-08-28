import { describe, expect, it } from "vitest";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";
import {
  resolveAuthCliCommand,
  resolvePairCliCommand,
  runRemoteAccessCliCommand,
} from "./remoteAccessCommand";

function fixture(responses: (request: LocalControlRequest) => LocalControlResponse) {
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    sent,
    out,
    err,
    run: (command: Parameters<typeof runRemoteAccessCliCommand>[0]["command"]) =>
      runRemoteAccessCliCommand({
        command,
        session: {
          kind: "opened",
          windowId: "11111111-1111-4111-8111-111111111111",
          send: async (request) => {
            sent.push(request);
            return responses(request);
          },
          close: async () => undefined,
        },
        stdout: { write: (chunk) => out.push(chunk) },
        stderr: { write: (chunk) => err.push(chunk) },
      }),
  };
}

describe("resolvePairCliCommand", () => {
  it("mints a loopback token unless another network class is named", () => {
    expect(resolvePairCliCommand([], {})).toEqual({ action: "pair", sourceClass: "loopback" });
    expect(resolvePairCliCommand([], { source: "tailscale" })).toEqual({
      action: "pair",
      sourceClass: "tailscale",
    });
  });

  it("refuses a network class Octant does not pair over", () => {
    expect(resolvePairCliCommand([], { source: "public" })).toBeUndefined();
  });
});

describe("resolveAuthCliCommand", () => {
  it("lists paired devices by default", () => {
    expect(resolveAuthCliCommand([], {})).toEqual({ action: "list-devices" });
    expect(resolveAuthCliCommand(["list"], {})).toEqual({ action: "list-devices" });
  });

  it("revokes one device or every device", () => {
    expect(resolveAuthCliCommand(["revoke", "66666666-6666-4666-8666-666666666666"], {})).toEqual({
      action: "revoke-device",
      deviceId: "66666666-6666-4666-8666-666666666666",
    });
    expect(resolveAuthCliCommand(["revoke"], { all: true })).toEqual({
      action: "revoke-all-devices",
    });
  });

  it("refuses a revocation that names no recognizable device", () => {
    expect(resolveAuthCliCommand(["revoke", "device-2"], {})).toBeUndefined();
  });
});

describe("runRemoteAccessCliCommand", () => {
  it("prints the pairing token a device claims and the host approves", async () => {
    const test = fixture(() => ({
      status: 201,
      body: {
        ticket: {
          ticketId: "77777777-7777-4777-8777-777777777777",
          ticketProof: "proof",
          expiresAt: 1_767_225_600_000,
          sourceClass: "lan-private",
        },
      },
    }));
    expect(await test.run({ action: "pair", sourceClass: "lan-private" })).toBe(0);
    expect(test.sent[0]).toMatchObject({
      path: "/api/desktop/remote/pairing-tickets",
      body: { sourceClass: "lan-private" },
    });
    expect(test.out.join("")).toContain("77777777-7777-4777-8777-777777777777");
    expect(test.out.join("")).toContain("proof");
  });

  it("says so when no device is paired with the host", async () => {
    const test = fixture(() => ({ status: 200, body: { devices: [] } }));
    expect(await test.run({ action: "list-devices" })).toBe(0);
    expect(test.out.join("")).toContain("No devices are paired");
  });

  it("lists each paired device with the state Octant records", async () => {
    const test = fixture(() => ({
      status: 200,
      body: {
        devices: [
          {
            deviceId: "88888888-8888-4888-8888-888888888888",
            deviceLabel: "Phone",
            state: "active",
          },
        ],
      },
    }));
    expect(await test.run({ action: "list-devices" })).toBe(0);
    expect(test.out.join("")).toContain("Phone");
    expect(test.out.join("")).toContain("active");
  });

  it("reports the reason Octant refused a revocation", async () => {
    const test = fixture(() => ({ status: 401, body: { category: "unauthorized" } }));
    expect(
      await test.run({ action: "revoke-device", deviceId: "99999999-9999-4999-8999-999999999999" }),
    ).toBe(1);
    expect(test.err.join("")).toContain("refused");
  });
});
