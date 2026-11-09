import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
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

function worker(
  write: (callback: (error?: Error | null) => void) => void,
  joinsOnCancel = true,
  cleanup: "confirmed" | "uncertain" | "missing" = "confirmed",
) {
  const events = new EventEmitter();
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      write(callback);
    },
  });
  const child = Object.assign(events, {
    pid: 1001,
    stdin,
    stdout,
    stderr,
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdio: [stdin, stdout, stderr, null],
    kill: vi.fn(),
    disconnect: () => {
      child.connected = false;
      child.emit("disconnect");
      stdout.end();
      stderr.end();
    },
    send: (value: unknown, callback: (error: Error | null) => void) => {
      if (value === "L") child.emit("message", { status: "command", pid: 1003 });
      else if (value === "X") {
        if (joinsOnCancel)
          queueMicrotask(() => {
            if (cleanup !== "missing")
              child.emit("message", {
                status: "result",
                result: { status: "unavailable", reason: "cancelled" },
                cleanup,
              });
            child.disconnect();
            child.exitCode = 0;
            child.emit("exit", 0);
            child.emit("close", 0);
          });
      } else if (value !== "E") child.emit("message", { status: "ready", relayPid: 1002 });
      callback(null);
      // Deliberately exercise accepted IPC backpressure in every public case.
      return false;
    },
  });
  return child;
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
  it("bounds undrained input, admits it after draining, and settles pending owner loss without replay", async () => {
    const owner = new AbortController();
    const callbacks: Array<(error?: Error | null) => void> = [];
    const write = vi.fn((done: (error?: Error | null) => void) => callbacks.push(done));
    fixture.spawn.mockReturnValue(worker(write));
    const prepared = await prepareLinuxMediationSession(input(owner.signal));
    if (prepared.status !== "ready") throw new Error("Session unavailable");
    try {
      expect(await prepared.session.launch()).toEqual({ status: "released" });
      const writes = Array.from({ length: 4 }, () =>
        prepared.session.writeInput(Buffer.alloc(65_536)),
      );
      expect(writes.map((write) => write.status)).toEqual([
        "accepted",
        "accepted",
        "accepted",
        "accepted",
      ]);
      expect(prepared.session.writeInput(Buffer.alloc(65_536))).toEqual({ status: "refused" });
      const complete = callbacks.shift();
      const first = writes[0];
      if (complete === undefined || first?.status !== "accepted")
        throw new Error("Accepted write callback unavailable");
      complete();
      expect(await first.drained).toEqual({ status: "drained" });
      const additional = prepared.session.writeInput(Buffer.alloc(65_536));
      expect(additional.status).toBe("accepted");
      const writesAtAbort = write.mock.calls.length;
      owner.abort();
      const drains = [...writes, additional].map((accepted) => {
        if (accepted.status !== "accepted") throw new Error("Input was not accepted");
        return accepted.drained;
      });
      expect(await Promise.all(drains)).toEqual([
        { status: "drained" },
        ...Array.from({ length: 4 }, () => ({ status: "uncertain" })),
      ]);
      expect((await prepared.session.exited).result).toEqual({
        status: "unavailable",
        reason: "cancelled",
      });
      expect(prepared.session.writeInput(Buffer.from("after owner loss"))).toEqual({
        status: "refused",
      });
      for (const callback of callbacks) callback();
      await new Promise((resolve) => setImmediate(resolve));
      expect(write).toHaveBeenCalledTimes(writesAtAbort);
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
  it.each(["uncertain", "missing"] as const)(
    "keeps cleanup uncertain after cancellation when native cleanup acknowledgement is %s",
    async (cleanup) => {
      fixture.spawn.mockReturnValue(worker((done) => done(), true, cleanup));
      const prepared = await prepareLinuxMediationSession(input(new AbortController().signal));
      if (prepared.status !== "ready") throw new Error("Session unavailable");
      expect(await prepared.session.close()).toEqual({
        result: { status: "unavailable", reason: "cancelled" },
        cleanup: "uncertain",
      });
    },
  );
  it("reports an unexpected worker exit as unavailable without claiming caller cancellation or confirmed cleanup", async () => {
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const owner = new AbortController();
    const child = worker((done) => done(), false, "missing");
    fixture.spawn.mockReturnValue(child);
    try {
      const prepared = await prepareLinuxMediationSession(input(owner.signal));
      if (prepared.status !== "ready") throw Error("Session unavailable");
      child.signalCode = "SIGSEGV";
      child.emit("exit", null, "SIGSEGV");
      child.disconnect();
      expect(await prepared.session.exited).toEqual({
        result: { status: "unavailable", reason: "native-unavailable" },
        cleanup: "uncertain",
      });
      expect(owner.signal.aborted).toBe(false);
      expect(diagnostic).toHaveBeenCalledOnce();
      expect(JSON.parse(String(diagnostic.mock.calls[0]?.[0]))).toEqual({
        status: "mediation-worker-exit",
        pid: 1001,
        code: null,
        signal: "SIGSEGV",
        terminalAcknowledged: false,
        callerAborted: false,
      });
    } finally {
      diagnostic.mockRestore();
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
    const sent = vi.spyOn(child, "send");
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
  it("keeps cleanup uncertain when an IPC error has no observed process exit", async () => {
    const child = worker((done) => done(), false);
    fixture.spawn.mockReturnValue(child);
    const prepared = await prepareLinuxMediationSession(input(new AbortController().signal));
    if (prepared.status !== "ready") throw new Error("Session unavailable");
    child.emit("error", new Error("synthetic live-channel error"));
    expect(await prepared.session.exited).toEqual({
      result: { status: "unavailable", reason: "native-unavailable" },
      cleanup: "uncertain",
    });
    expect(fixture.terminate).toHaveBeenCalledWith(
      1001,
      "fixture-birth",
      300,
      expect.any(Function),
    );
  });
});
