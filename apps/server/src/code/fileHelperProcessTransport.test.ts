import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  FileHelperProcessError,
  createFileHelperProcessTransport,
  type FileHelperChildProcess,
} from "./fileHelperProcessTransport";

class FakeChild extends EventEmitter implements FileHelperChildProcess {
  readonly stdout = new EventEmitter();
  onEnd?: () => void;
  onKill?: (signal: NodeJS.Signals) => void;
  readonly stdin = {
    write: vi.fn((_frame, callback) => callback?.()),
    end: vi.fn(() => this.onEnd?.()),
  };
  readonly kill = vi.fn((signal: NodeJS.Signals) => {
    this.onKill?.(signal);
    return true;
  });
}

describe("file helper process transport", () => {
  it("spawns the exact absolute helper with no arguments, no shell, and piped stdio", () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);

    createFileHelperProcessTransport({
      helperPath: "/Applications/Octant/helper",
      platform: "darwin",
      arch: "arm64",
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith("/Applications/Octant/helper", [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  });

  it.each([
    [undefined, "unavailable"],
    ["relative/helper", "unavailable"],
    ["/helper", "unsupported", "linux", "arm64"],
    ["/helper", "unsupported", "darwin", "x64"],
  ] as const)(
    "fails closed for invalid or unsupported configuration",
    (helperPath, category, platform = "darwin", arch = "arm64") => {
      expect(() =>
        createFileHelperProcessTransport({ helperPath, platform, arch, spawn: vi.fn() }),
      ).toThrowError(expect.objectContaining({ category }));
    },
  );

  it("writes owned bytes, forwards stdout data, and reports exit once", async () => {
    const child = new FakeChild();
    const transport = createFileHelperProcessTransport({
      helperPath: "/helper",
      platform: "darwin",
      arch: "arm64",
      spawn: () => child,
    });
    const data = vi.fn();
    const exit = vi.fn();
    transport.onData(data);
    transport.onExit(exit);

    const frame = new Uint8Array([1, 2, 3]);
    await transport.write(frame);
    child.stdout.emit("data", Buffer.from([4, 5]));
    child.emit("error", new Error("private process detail"));
    child.emit("close", 1, null);

    expect(child.stdin.write).toHaveBeenCalledWith(Buffer.from(frame), expect.any(Function));
    expect(data).toHaveBeenCalledWith(new Uint8Array([4, 5]));
    expect(exit).toHaveBeenCalledOnce();
    await expect(transport.write(frame)).rejects.toBeInstanceOf(FileHelperProcessError);
  });

  it("resolves an immediate graceful close without sending a signal", async () => {
    const child = new FakeChild();
    child.onEnd = () => child.emit("close", 0, null);
    const transport = createFileHelperProcessTransport({
      helperPath: "/helper",
      platform: "darwin",
      arch: "arm64",
      spawn: () => child,
    });
    const exit = vi.fn();
    transport.onExit(exit);

    await transport.close();

    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("retains listeners while waiting for delayed graceful process death", async () => {
    const child = new FakeChild();
    const wait = deferred<void>();
    const transport = createFileHelperProcessTransport({
      helperPath: "/helper",
      platform: "darwin",
      arch: "arm64",
      spawn: () => child,
      wait: () => wait.promise,
    });
    const exit = vi.fn();
    transport.onExit(exit);

    const closing = transport.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.listenerCount("close")).toBeGreaterThan(0);
    child.emit("close", 0, "SIGTERM");
    await closing;

    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(exit).toHaveBeenCalledOnce();
    expect(child.listenerCount("close")).toBe(0);
  });

  it("escalates to SIGKILL after the bounded graceful-close interval", async () => {
    const child = new FakeChild();
    const wait = deferred<void>();
    child.onKill = (signal) => {
      if (signal === "SIGKILL") child.emit("close", null, signal);
    };
    const transport = createFileHelperProcessTransport({
      helperPath: "/helper",
      platform: "darwin",
      arch: "arm64",
      spawn: () => child,
      gracefulCloseTimeoutMs: 25,
      wait: vi.fn(() => wait.promise),
    });

    const closing = transport.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    wait.resolve();
    await closing;

    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("returns one idempotent close operation while process death is pending", async () => {
    const child = new FakeChild();
    const wait = deferred<void>();
    const transport = createFileHelperProcessTransport({
      helperPath: "/helper",
      platform: "darwin",
      arch: "arm64",
      spawn: () => child,
      wait: () => wait.promise,
    });

    const first = transport.close();
    const second = transport.close();
    expect(first).toBe(second);
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("close", 0, "SIGTERM");
    await Promise.all([first, second]);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
