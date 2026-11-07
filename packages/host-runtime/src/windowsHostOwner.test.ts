import { describe, expect, it, vi } from "vitest";
import { respondToHostControlLine } from "./ownerControlProtocol";

const receipt = {
  schemaVersion: 1,
  hostId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
  endpoint: "/fixture.sock",
  pid: 1,
  processStart: "fixture",
  serverVersion: "1",
  wireVersion: "1",
  serviceMode: "foreground",
  nonceDigest: "0".repeat(64),
  createdAt: new Date(0).toISOString(),
} as const;

describe("private host control messages", () => {
  it("refuses null and non-object messages without dispatching a host command", async () => {
    const stop = vi.fn();
    for (const line of ["null", "[]", "12", '"fixture"']) {
      const reply = vi.fn();
      await expect(
        respondToHostControlLine(reply, line, receipt, "synthetic-control-nonce", stop, undefined),
      ).resolves.toBeUndefined();
      expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "invalid-request" });
    }
    expect(stop).not.toHaveBeenCalled();
  });
});

import { acquireWindowsHostRuntimeOwner, type WindowsHostOwnerNative } from "./windowsHostOwner";
const scope = "33333333-3333-4333-8333-333333333333";
const endpoint = "\\\\.\\pipe\\Octant-host-" + "a".repeat(64);
function nativeFixture(claimStatus = "owned") {
  const events: unknown[] = [];
  let nonce = Buffer.alloc(0);
  let claimed: unknown;
  const responses: unknown[] = [];
  const native: WindowsHostOwnerNative = {
    apiVersion: 1,
    frameBytes: 16384,
    prepare: () => ({
      status: "prepared",
      pid: 4242,
      processStart: "win32:0000000100000002",
      endpoint,
    }),
    claim: (raw, secret) => {
      claimed = JSON.parse(raw.toString("utf8"));
      nonce = Buffer.from(secret);
      return { status: claimStatus };
    },
    poll: () => events.shift() ?? { status: "idle" },
    reply: (_id, raw) => {
      responses.push(JSON.parse(raw.toString("utf8")));
      return { status: "accepted" };
    },
    close: vi.fn(() => {
      nonce.fill(0);
      return { status: "closed" };
    }),
    lookup: () => ({ status: "missing" }),
    beginRequest: () => ({ status: "refused" }),
    pollRequest: () => ({ status: "refused" }),
    closeRequest: () => ({ status: "closed" }),
  };
  return {
    native,
    events,
    responses,
    claimed: () => claimed,
    frame: (type: string, authorized = true) => ({
      status: "request",
      id: 1,
      bytes: Buffer.from(
        JSON.stringify({
          version: 1,
          principal: "local",
          type,
          secret: authorized ? nonce.toString("base64url") : "invalid-synthetic",
        }),
      ),
    }),
  };
}
const ownerOptions = {
  scope,
  hostId: receipt.hostId,
  instanceId: receipt.instanceId,
  serverVersion: "1",
  wireVersion: "1",
  serviceMode: "foreground",
} as const;

describe("native Windows owner admission", () => {
  it("records the native process birth and refuses unauthenticated control effects", async () => {
    const fake = nativeFixture();
    const stop = vi.fn();
    const result = await acquireWindowsHostRuntimeOwner({
      ...ownerOptions,
      native: fake.native,
      onStopRequested: stop,
    });
    if (result.kind !== "owner") throw new Error("expected owner");
    try {
      expect(result.receipt.pid).toBe(4242);
      expect(result.receipt.processStart).toBe("win32:0000000100000002");
      expect(fake.claimed()).toMatchObject({ pid: 4242, endpoint });
      fake.events.push(fake.frame("stop", false));
      await vi.waitFor(() => expect(fake.responses).toHaveLength(1));
      expect(fake.responses[0]).toEqual({ ok: false, error: "unauthorized" });
      expect(stop).not.toHaveBeenCalled();
      fake.events.push(fake.frame("status"));
      await vi.waitFor(() => expect(fake.responses).toHaveLength(2));
      expect(fake.responses[1]).toMatchObject({ ok: true, owner: { pid: 4242 } });
    } finally {
      await result.release();
    }
    expect(fake.native.close).toHaveBeenCalledTimes(1);
  });

  it("never takes over an unknown prior writer", async () => {
    const fake = nativeFixture("unknown");
    await expect(
      acquireWindowsHostRuntimeOwner({ ...ownerOptions, native: fake.native }),
    ).rejects.toMatchObject({ code: "owner-unhealthy" });
    expect(fake.native.close).toHaveBeenCalled();
    expect(fake.responses).toHaveLength(0);
  });

  it("refuses a late control reply after closing its owned native endpoint", async () => {
    const fake = nativeFixture();
    let finish = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started = false;
    const result = await acquireWindowsHostRuntimeOwner({
      ...ownerOptions,
      native: fake.native,
      onControlRequest: async () => {
        started = true;
        await held;
        return {};
      },
    });
    if (result.kind !== "owner") throw new Error("expected owner");
    try {
      fake.events.push(fake.frame("diagnostics"));
      await vi.waitFor(() => expect(started).toBe(true));
      await result.release();
      finish();
      await held;
      await Promise.resolve();
      expect(fake.responses).toHaveLength(0);
    } finally {
      finish();
      await result.release();
    }
  });
});
