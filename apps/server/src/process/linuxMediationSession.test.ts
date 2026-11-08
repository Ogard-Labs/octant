import { EventEmitter } from "node:events";
import { Duplex, PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareLinuxMediationSession } from "./linuxMediationSession";

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  identity: vi.fn(),
  receipt: vi.fn(),
  terminate: vi.fn(),
  dead: new Set<number>(),
}));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));
vi.mock("node:fs/promises", () => ({ lstat: fixture.lstat, realpath: fixture.realpath }));
vi.mock("./linuxConfinement", () => ({
  buildBubblewrapLaunch: () => ({ command: "/usr/bin/bwrap", args: ["--unshare-all"] }),
}));
vi.mock("./nodeOwnedProcessReceipt", () => ({
  readProcessIdentity: fixture.identity,
  terminateOwnedProcess: fixture.terminate,
  persistProcessReceipt: fixture.receipt,
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const input = (signal: AbortSignal, maximumMs = 1_000) => ({
  ownerId: "fixture",
  signal,
  maximumMs,
  receiptDirectory: "/private-receipts",
  environment: {},
  brokerExecutable: "/fixed-worker",
  nativeExecutable: "/fixed-relay",
  launch: {
    executable: "/command",
    args: [],
    boundRoot: "/project",
    temporaryDirectory: "/temporary",
    networkEgress: "none" as const,
  },
  policy: { entries: [], ownAccountPaths: [], sshCompanionDirectory: undefined },
});

function worker(write: (callback: (error?: Error | null) => void) => void) {
  const child = new EventEmitter();
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      write(callback);
    },
  });
  const control = new Duplex({
    read() {},
    write(bytes, _encoding, callback) {
      const tag = bytes.toString();
      if (tag === "L") this.push('{"status":"command","pid":1003}\n');
      else if (tag === "X") {
        queueMicrotask(() => {
          this.push(null);
          stdout.end();
          stderr.end();
          child.emit("exit", 0);
          child.emit("close", 0);
        });
      } else if (tag !== "E") this.push('{"status":"ready","relayPid":1002}\n');
      callback();
    },
  });
  return Object.assign(child, {
    control,
    pid: 1001,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, control],
    kill: vi.fn(),
  });
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  fixture.spawn.mockReset();
  fixture.lstat.mockReset();
  fixture.realpath.mockReset();
  fixture.lstat.mockResolvedValue({
    isDirectory: () => true,
    uid: process.getuid?.(),
    mode: 0o700,
  });
  fixture.realpath.mockResolvedValue("/private-receipts");
  fixture.dead.clear();
  fixture.identity
    .mockReset()
    .mockImplementation(async (pid: number) =>
      fixture.dead.has(pid) ? undefined : "fixture-birth",
    );
  fixture.terminate.mockReset().mockImplementation(async (pid: number) => {
    fixture.dead.add(pid);
  });
  fixture.receipt
    .mockReset()
    .mockResolvedValue({ ready: Promise.resolve(), remove: async () => undefined });
});
afterEach(() => {
  if (originalPlatform !== undefined) Object.defineProperty(process, "platform", originalPlatform);
});

describe("owned mediation session admission and input", () => {
  it("returns the preparation deadline and never spawns after a late filesystem reply", async () => {
    let complete: (value: object) => void = () => undefined;
    fixture.lstat.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const result = await prepareLinuxMediationSession(input(new AbortController().signal, 5));
    expect(result).toEqual({ status: "unavailable", reason: "deadline", cleanup: "confirmed" });
    complete({ isDirectory: () => true, uid: process.getuid?.(), mode: 0o700 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it("returns cancellation while preparation is held and never spawns when it later completes", async () => {
    const owner = new AbortController();
    let complete: (value: object) => void = () => undefined;
    fixture.lstat.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const preparing = prepareLinuxMediationSession(input(owner.signal));
    owner.abort();
    expect(await preparing).toEqual({
      status: "unavailable",
      reason: "cancelled",
      cleanup: "confirmed",
    });
    complete({ isDirectory: () => true, uid: process.getuid?.(), mode: 0o700 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it("refuses input after EOF without dispatching another write", async () => {
    const write = vi.fn((done: (error?: Error | null) => void) => done());
    fixture.spawn.mockReturnValue(worker(write));
    const prepared = await prepareLinuxMediationSession(input(new AbortController().signal));
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Session unavailable");
    try {
      expect(await prepared.session.launch()).toEqual({ status: "released" });
      prepared.session.endInput();
      expect(prepared.session.writeInput(Buffer.from("must not dispatch"))).toEqual({
        status: "refused",
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      await prepared.session.close();
    }
  });
  it("reports an accepted pipe failure as uncertain and never advises replay", async () => {
    fixture.spawn.mockReturnValue(worker((done) => done(new Error("synthetic pipe loss"))));
    const prepared = await prepareLinuxMediationSession(input(new AbortController().signal));
    if (prepared.status !== "ready") throw new Error("Session unavailable");
    expect(await prepared.session.launch()).toEqual({ status: "released" });
    const written = prepared.session.writeInput(Buffer.from("one accepted write"));
    expect(written.status).toBe("accepted");
    if (written.status === "accepted")
      expect(await written.drained).toEqual({ status: "uncertain" });
    expect((await prepared.session.exited).result).toEqual({
      status: "unavailable",
      reason: "native-unavailable",
    });
  });
  it("bounds accepted input during backpressure and settles it uncertain on owner loss without replay", async () => {
    const owner = new AbortController();
    const held: Array<(error?: Error | null) => void> = [];
    const write = vi.fn((done: (error?: Error | null) => void) => {
      held.push(done);
    });
    fixture.spawn.mockReturnValue(worker(write));
    const prepared = await prepareLinuxMediationSession(input(owner.signal));
    if (prepared.status !== "ready") throw new Error("Session unavailable");
    try {
      expect(await prepared.session.launch()).toEqual({ status: "released" });
      const drains: Array<Promise<{ readonly status: "drained" | "uncertain" }>> = [];
      for (let index = 0; index < 4; index++) {
        const accepted = prepared.session.writeInput(Buffer.alloc(65_536, index));
        expect(accepted.status).toBe("accepted");
        if (accepted.status !== "accepted") throw new Error("Input was not accepted.");
        drains.push(accepted.drained);
      }
      expect(prepared.session.writeInput(Buffer.from("over the pending byte bound"))).toEqual({
        status: "refused",
      });
      expect(write).toHaveBeenCalledOnce();
      owner.abort();
      expect(await Promise.all(drains)).toEqual(
        Array.from({ length: 4 }, () => ({ status: "uncertain" })),
      );
      expect((await prepared.session.exited).result).toEqual({
        status: "unavailable",
        reason: "cancelled",
      });
      expect(prepared.session.writeInput(Buffer.from("after owner loss"))).toEqual({
        status: "refused",
      });
      for (const callback of held) callback();
      await new Promise((resolve) => setImmediate(resolve));
      expect(write).toHaveBeenCalledOnce();
    } finally {
      await prepared.session.close();
    }
  });
  it("never releases execution when the owner cancels during command ownership acquisition", async () => {
    const owner = new AbortController();
    let release = () => {},
      entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commandRequested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fixture.receipt.mockImplementation(async (_options: unknown, _owner: string, pid: number) => {
      if (pid === 1003) entered();
      return { ready: pid === 1003 ? gate : Promise.resolve(), remove: async () => undefined };
    });
    const child = worker((done) => done());
    const sent = vi.spyOn(child.control, "write");
    fixture.spawn.mockReturnValue(child);
    const prepared = await prepareLinuxMediationSession(input(owner.signal));
    if (prepared.status !== "ready") throw new Error("Session unavailable");
    try {
      const launching = prepared.session.launch();
      await commandRequested;
      expect(sent.mock.calls.some(([frame]) => frame === "E")).toBe(false);
      owner.abort();
      expect(await launching).toEqual({ status: "refused" });
      release();
      expect(await prepared.session.exited).toEqual({
        result: { status: "unavailable", reason: "cancelled" },
        cleanup: "confirmed",
      });
      expect(sent.mock.calls.some(([frame]) => frame === "E")).toBe(false);
      expect(fixture.dead.has(1003)).toBe(true);
    } finally {
      release();
      await prepared.session.close();
    }
  });
  it("retains cleanup uncertainty when a pending identity acquisition fails during shutdown", async () => {
    const owner = new AbortController();
    let failReceipt: (error: Error) => void = () => undefined;
    let requested: () => void = () => undefined;
    const relayRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    fixture.receipt
      .mockImplementationOnce(async () => ({
        ready: Promise.resolve(),
        remove: async () => undefined,
      }))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failReceipt = reject;
            requested();
          }),
      );
    fixture.spawn.mockReturnValue(worker((done) => done()));
    const preparing = prepareLinuxMediationSession(input(owner.signal));
    await relayRequested;
    owner.abort();
    // The cooperative worker exit is already queued; reject while cleanup is
    // awaiting this acquisition, rather than before it samples retirement.
    await new Promise((resolve) => setTimeout(resolve, 25));
    failReceipt(new Error("synthetic receipt loss during retirement"));
    expect(await preparing).toEqual({
      status: "unavailable",
      reason: "cancelled",
      cleanup: "uncertain",
    });
  });
});
