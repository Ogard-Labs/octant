import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  installProcessErrorNet,
  REVIEWED_BENIGN_TEARDOWN_ERRORS,
  type ProcessErrorNetEvent,
  type ProcessErrorNetTarget,
} from "./processErrorNet";

class FakeProcessTarget extends EventEmitter implements ProcessErrorNetTarget {}

class FakeStdioStream extends EventEmitter {}

const MODULE_PATH = fileURLToPath(new URL("./processErrorNet.ts", import.meta.url));

describe("process error net", () => {
  it("an unhandled error event ends the process with a logged cause", () => {
    const target = new FakeProcessTarget();
    const lines: string[] = [];
    const fatalEvents: ProcessErrorNetEvent[] = [];
    const exit = vi.fn();

    const net = installProcessErrorNet({
      processName: "host",
      target,
      stdioStreams: [],
      homeDirectory: "/Users/ada",
      redact: (text) => text.replaceAll("broker-secret-value-99", "[REDACTED]"),
      writeLine: (line) => lines.push(line),
      onFatal: (event) => fatalEvents.push(event),
      exit,
      now: () => new Date("2026-11-21T10:00:00.000Z"),
    });

    const failure = new Error(
      "boom at /Users/ada/work token=sk-secret1234567890 broker-secret-value-99",
    );
    target.emit("uncaughtException", failure);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[octant:host] fatal uncaughtException (2026-11-21T10:00:00.000Z)");
    expect(lines[0]).toContain("boom at ~/work");
    expect(lines[0]).not.toContain("/Users/ada");
    expect(lines[0]).not.toContain("sk-secret1234567890");
    expect(lines[0]).not.toContain("broker-secret-value-99");
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0]?.kind).toBe("uncaughtException");

    net.uninstall();
  });

  it("ends a real child process non-zero with a redacted cause on an unhandled error event", () => {
    const script = [
      `import { installProcessErrorNet } from ${JSON.stringify(MODULE_PATH)};`,
      `installProcessErrorNet({ processName: "host", homeDirectory: "/Users/ada" });`,
      `setTimeout(() => {`,
      `  throw new Error("fatal crash at /Users/ada/repo Authorization: Bearer topsecretvalue12345");`,
      `}, 5);`,
    ].join("\n");

    const result = spawnSync("bun", ["-e", script], {
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[octant:host] fatal uncaughtException");
    expect(result.stderr).toContain("fatal crash at ~/repo");
    expect(result.stderr).not.toContain("/Users/ada");
    expect(result.stderr).not.toContain("topsecretvalue12345");
  });

  it("logs an unhandled rejection and guards against re-entrant crashes", () => {
    const target = new FakeProcessTarget();
    const lines: string[] = [];
    const exit = vi.fn();

    const net = installProcessErrorNet({
      processName: "desktop",
      target,
      stdioStreams: [],
      writeLine: (line) => lines.push(line),
      onFatal: () => {
        target.emit("uncaughtException", new Error("re-entrant crash"));
        throw new Error("sink failed");
      },
      exit,
    });

    target.emit("unhandledRejection", new Error("forgotten promise"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[octant:desktop] fatal unhandledRejection");
    expect(lines[0]).toContain("forgotten promise");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    net.uninstall();
  });

  it("exits non-zero on every error outside shutdown, including EPIPE and IPC channel errors", () => {
    for (const error of [
      Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" }),
      Object.assign(new Error("channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" }),
      new Error("Object has been destroyed"),
    ]) {
      const target = new FakeProcessTarget();
      const exit = vi.fn();
      const net = installProcessErrorNet({
        processName: "desktop",
        target,
        stdioStreams: [],
        writeLine: () => undefined,
        exit,
      });

      target.emit("uncaughtException", error);
      expect(exit).toHaveBeenCalledWith(1);
      net.uninstall();
    }
  });

  it("ignores only the explicit reviewed benign teardown errors while shutting down", () => {
    expect(REVIEWED_BENIGN_TEARDOWN_ERRORS.length).toBeGreaterThan(0);

    const target = new FakeProcessTarget();
    const lines: string[] = [];
    const ignored: string[] = [];
    const exit = vi.fn();

    const net = installProcessErrorNet({
      processName: "desktop",
      target,
      stdioStreams: [],
      isShuttingDown: () => true,
      writeLine: (line) => lines.push(line),
      onIgnoredTeardownError: (_event, reason) => ignored.push(reason),
      exit,
    });

    target.emit(
      "unhandledRejection",
      Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" }),
    );
    target.emit("uncaughtException", new Error("Object has been destroyed"));

    expect(exit).not.toHaveBeenCalled();
    expect(ignored).toHaveLength(2);
    expect(lines).toHaveLength(2);

    // An unreviewed error during shutdown still exits non-zero.
    target.emit("uncaughtException", new Error("unexpected state corruption"));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    net.uninstall();
  });

  it("absorbs EPIPE on the process's own stdio streams without catching child-stream EPIPE", () => {
    const target = new FakeProcessTarget();
    const stderr = new FakeStdioStream();
    const exit = vi.fn();

    const net = installProcessErrorNet({
      processName: "host",
      target,
      stdioStreams: [stderr],
      writeLine: () => undefined,
      exit,
    });

    // Broken pipe on the process's own stderr does not crash the process.
    expect(() =>
      stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    ).not.toThrow();
    expect(exit).not.toHaveBeenCalled();

    // Non-EPIPE error on stdout/stderr is still forwarded to the fatal net.
    stderr.emit("error", Object.assign(new Error("I/O error"), { code: "EIO" }));
    expect(exit).toHaveBeenCalledWith(1);

    net.uninstall();
  });
});
