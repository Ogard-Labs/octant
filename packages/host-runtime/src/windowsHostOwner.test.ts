import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { respondToHostControlLine } from "./ownerControlProtocol";

const bindingLoad = vi.hoisted(() => ({
  load: vi.fn<(path: string) => unknown>(),
  mainThread: true,
}));
vi.mock("node:module", async (original) => ({
  ...(await original<typeof import("node:module")>()),
  createRequire: () => bindingLoad.load,
}));
vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  get isMainThread() {
    return bindingLoad.mainThread;
  },
}));

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

import {
  acquireWindowsHostRuntimeOwner,
  attachWindowsHostRuntimeOwner,
  loadWindowsHostOwnerNative,
  type WindowsHostOwnerNative,
} from "./windowsHostOwner";
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

describe("native Windows binding loading", () => {
  const ordinary = "C:\\Octant\\resources\\native\\octant-windows-host-owner.node";
  beforeEach(() => {
    bindingLoad.load.mockReset();
    bindingLoad.mainThread = true;
    vi.stubGlobal("process", { ...process, platform: "win32" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    bindingLoad.mainThread = true;
  });

  it.each([ordinary, `\\\\?\\${ordinary}`])(
    "loads the fixed native binding from a canonical absolute Windows resource path: %s",
    (path) => {
      const native = nativeFixture().native;
      bindingLoad.load.mockReturnValue(native);
      expect(loadWindowsHostOwnerNative(path)).toBe(native);
      expect(bindingLoad.load).toHaveBeenCalledExactlyOnceWith(path);
    },
  );

  it("refuses relative, noncanonical, UNC and device paths before loading native code", () => {
    for (const path of [
      "octant-windows-host-owner.node",
      "C:octant-windows-host-owner.node",
      "\\\\server\\share\\octant-windows-host-owner.node",
      "\\\\?\\UNC\\server\\share\\octant-windows-host-owner.node",
      `\\\\.\\${ordinary}`,
      "\\\\?\\GLOBALROOT\\native\\octant-windows-host-owner.node",
      "C:/Octant/resources/native/octant-windows-host-owner.node",
      "\\\\?\\C:/Octant/resources/native/octant-windows-host-owner.node",
      "C:\\Octant\\resources\\native\\..\\native\\octant-windows-host-owner.node",
      "\\\\?\\C:\\Octant\\resources\\native\\.\\octant-windows-host-owner.node",
      "C:\\Octant\\resources\\native\\another.node",
      `${ordinary}\0`,
    ])
      expect(loadWindowsHostOwnerNative(path)).toBeUndefined();
    expect(bindingLoad.load).not.toHaveBeenCalled();
  });

  it("refuses loading host authority outside the Windows main thread", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(loadWindowsHostOwnerNative(ordinary)).toBeUndefined();
    vi.stubGlobal("process", { ...process, platform: "win32" });
    bindingLoad.mainThread = false;
    expect(loadWindowsHostOwnerNative(ordinary)).toBeUndefined();
    expect(bindingLoad.load).not.toHaveBeenCalled();
  });

  it("refuses incompatible native exports and failed library loads", () => {
    const native = nativeFixture().native;
    for (const value of [
      { ...native, apiVersion: 2 },
      { ...native, frameBytes: 1 },
      { ...native, beginRequest: undefined },
    ]) {
      bindingLoad.load.mockReturnValue(value);
      expect(loadWindowsHostOwnerNative(ordinary)).toBeUndefined();
    }
    bindingLoad.load.mockImplementation(() => {
      throw Error("The synthetic native library is unavailable.");
    });
    expect(loadWindowsHostOwnerNative(ordinary)).toBeUndefined();
  });
});

describe("native Windows owner admission", () => {
  it("drains a stop acknowledgement on its exact native connection before stopping the owner", async () => {
    const fake = nativeFixture();
    const stop = vi.fn();
    const owner = await acquireWindowsHostRuntimeOwner({
      ...ownerOptions,
      native: fake.native,
      onStopRequested: stop,
    });
    if (owner.kind !== "owner") throw Error("Expected owned fixture.");
    try {
      fake.events.push({ status: "connection-closed", responseWritten: true });
      await vi.waitFor(() => expect(fake.events).toHaveLength(0));
      expect(stop).not.toHaveBeenCalled();
      fake.events.push(fake.frame("stop"));
      await vi.waitFor(() => expect(fake.responses).toHaveLength(1));
      expect(fake.responses[0]).toEqual({ ok: true });
      expect(stop).not.toHaveBeenCalled();
      fake.events.push({ status: "connection-closed", id: 2, responseWritten: true });
      await vi.waitFor(() => expect(fake.events).toHaveLength(0));
      expect(stop).not.toHaveBeenCalled();
      fake.events.push({ status: "connection-closed", id: 1, responseWritten: false });
      await vi.waitFor(() => expect(fake.events).toHaveLength(0));
      expect(stop).not.toHaveBeenCalled();
      fake.events.push({ ...fake.frame("stop"), id: 3 });
      await vi.waitFor(() => expect(fake.responses).toHaveLength(2));
      expect(stop).not.toHaveBeenCalled();
      fake.events.push({ status: "connection-closed", id: 3, responseWritten: true });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    } finally {
      await owner.release();
    }
  });

  it("discovers absence or refuses uncertain ownership without preparing or claiming", async () => {
    const fake = nativeFixture();
    const prepare = vi.spyOn(fake.native, "prepare");
    const claim = vi.spyOn(fake.native, "claim");
    for (const status of ["missing", "dead", "unknown"]) {
      vi.spyOn(fake.native, "lookup").mockReturnValue({ status });
      expect(await attachWindowsHostRuntimeOwner({ ...ownerOptions, native: fake.native })).toEqual(
        status === "unknown" ? { status: "refused", reason: "lookup" } : { status: "missing" },
      );
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(fake.native.close).not.toHaveBeenCalled();
  });

  it("distinguishes a verified owner whose pipe never answers from a forged owner record", async () => {
    const fake = nativeFixture();
    const nonce = Buffer.alloc(32, 7);
    const owner = {
      ...receipt,
      hostId: ownerOptions.hostId,
      endpoint,
      pid: 4242,
      processStart: "win32:0000000100000002",
      nonceDigest: createHash("sha256").update(nonce.toString("base64url")).digest("hex"),
    };
    const lookup = (record: typeof owner) => ({
      status: "existing",
      endpoint,
      pid: 4242,
      processStart: "win32:0000000100000002",
      receipt: Buffer.from(JSON.stringify(record)),
      secret: Buffer.from(nonce),
    });
    vi.spyOn(fake.native, "lookup").mockImplementation(() => lookup(owner));
    vi.spyOn(fake.native, "beginRequest").mockReturnValue({ status: "pending", id: 9 });
    vi.spyOn(fake.native, "pollRequest").mockReturnValue({ status: "refused" });
    expect(await attachWindowsHostRuntimeOwner({ ...ownerOptions, native: fake.native })).toEqual({
      status: "refused",
      reason: "unanswered",
    });
    vi.spyOn(fake.native, "lookup").mockImplementation(() =>
      lookup({ ...owner, nonceDigest: "0".repeat(64) }),
    );
    expect(await attachWindowsHostRuntimeOwner({ ...ownerOptions, native: fake.native })).toEqual({
      status: "refused",
      reason: "owner-record",
    });
  });

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

import { createHash } from "node:crypto";
it("waits for a busy pipe before dispatch and never replays a refused dispatched request", async () => {
  const fake = nativeFixture();
  const nonce = Buffer.alloc(32, 7);
  const previous = {
    ...receipt,
    endpoint,
    pid: 5555,
    processStart: "win32:0000000100000003",
    nonceDigest: createHash("sha256").update(nonce.toString("base64url")).digest("hex"),
  };
  let attempts = 0;
  let dispatchedRefused = false;
  const native: WindowsHostOwnerNative = {
    ...fake.native,
    claim: () => ({
      status: "existing",
      pid: previous.pid,
      processStart: previous.processStart,
      secret: Buffer.from(nonce),
      receipt: Buffer.from(JSON.stringify(previous)),
    }),
    beginRequest: () => {
      attempts++;
      return attempts <= 2 ? { status: "busy" } : { status: "pending", id: attempts };
    },
    pollRequest: () =>
      dispatchedRefused
        ? { status: "refused" }
        : { status: "response", bytes: Buffer.from(JSON.stringify({ ok: true, owner: previous })) },
  };
  try {
    const attached = await acquireWindowsHostRuntimeOwner({ ...ownerOptions, native });
    expect(attached.kind).toBe("attached");
    expect(attempts).toBe(3);
    if (attached.kind !== "attached") throw new Error("Expected native attachment.");
    dispatchedRefused = true;
    await expect(
      attached.request({ type: "diagnostics", principal: "local" }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(4);
  } finally {
    nonce.fill(0);
    native.close();
  }
});

it("does not close an existing owner when another acquisition is refused", async () => {
  const fake = nativeFixture();
  let preparations = 0;
  const native: WindowsHostOwnerNative = {
    ...fake.native,
    prepare: () =>
      ++preparations === 1
        ? { status: "prepared", pid: 4242, processStart: "win32:0000000100000002", endpoint }
        : { status: "refused" },
  };
  const first = await acquireWindowsHostRuntimeOwner({ ...ownerOptions, native });
  if (first.kind !== "owner") throw new Error("Expected first owner.");
  try {
    await expect(
      acquireWindowsHostRuntimeOwner({
        ...ownerOptions,
        scope: "44444444-4444-4444-8444-444444444444",
        native,
      }),
    ).rejects.toMatchObject({ code: "owner-unhealthy" });
    expect(native.close).not.toHaveBeenCalled();
  } finally {
    await first.release();
  }
});
