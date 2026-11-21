import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readHostCrashRecords, recordHostCrashSync } from "./crashRecords";
import {
  installProcessErrorNet,
  REVIEWED_BENIGN_TEARDOWN_ERRORS,
  type ProcessErrorNetEvent,
  type ProcessErrorNetTarget,
} from "./processErrorNet";

class FakeProcessTarget extends EventEmitter implements ProcessErrorNetTarget {}

class FakeStdioStream extends EventEmitter {}

const MODULE_PATH = fileURLToPath(new URL("./processErrorNet.ts", import.meta.url));
const CRASH_RECORDS_MODULE_PATH = fileURLToPath(new URL("./crashRecords.ts", import.meta.url));

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

  it("redacts a multiline secret across the complete error stack before selecting stack frames", () => {
    const target = new FakeProcessTarget();
    const lines: string[] = [];
    const fatalEvents: ProcessErrorNetEvent[] = [];
    const exit = vi.fn();

    const net = installProcessErrorNet({
      processName: "host",
      target,
      stdioStreams: [],
      homeDirectory: "/Users/ada",
      writeLine: (line) => lines.push(line),
      onFatal: (event) => fatalEvents.push(event),
      exit,
    });

    const failure = new Error('password="first-secret-line\nsecond-secret-line\nat third-secret"');
    target.emit("uncaughtException", failure);

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toHaveLength(1);
    const logged = lines[0] ?? "";
    expect(logged).not.toContain("first-secret-line");
    expect(logged).not.toContain("second-secret-line");
    expect(logged).not.toContain("third-secret");
    expect(fatalEvents[0]?.stack ?? "").not.toContain("second-secret-line");
    expect(fatalEvents[0]?.stack ?? "").not.toContain("third-secret");
    expect(fatalEvents[0]?.line ?? "").not.toContain("second-secret-line");
    // Real stack frames below the multiline message are still preserved.
    expect(logged).toContain("\nat ");

    net.uninstall();
  });

  it("redacts a multiline custom-registered secret before normalizing line breaks in summary and crash record", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "octant-process-error-net-multiline-"));
    try {
      const target = new FakeProcessTarget();
      const lines: string[] = [];
      const fatalEvents: ProcessErrorNetEvent[] = [];
      const exit = vi.fn();
      const multilineSecret = "first-secret-line\nsecond-secret-line";

      const net = installProcessErrorNet({
        processName: "host",
        target,
        stdioStreams: [],
        homeDirectory: "/Users/ada",
        redact: (text) => text.replaceAll(multilineSecret, "[REDACTED]"),
        writeLine: (line) => lines.push(line),
        onFatal: (event) => {
          fatalEvents.push(event);
          recordHostCrashSync(dataDirectory, {
            recordedAt: event.timestamp,
            process: "host",
            exitReason: event.kind,
            lastLines: event.line.split("\n"),
            homeDirectory: "/Users/ada",
          });
        },
        exit,
      });

      target.emit("uncaughtException", new Error(`broker secret leaked: ${multilineSecret}`));

      expect(exit).toHaveBeenCalledWith(1);
      expect(lines).toHaveLength(1);
      const logged = lines[0] ?? "";
      expect(logged).toContain("broker secret leaked: [REDACTED]");
      expect(logged).not.toContain("first-secret-line");
      expect(logged).not.toContain("second-secret-line");
      expect(fatalEvents[0]?.message).toContain("[REDACTED]");
      expect(fatalEvents[0]?.message ?? "").not.toContain("first-secret-line");
      expect(fatalEvents[0]?.message ?? "").not.toContain("second-secret-line");
      expect(fatalEvents[0]?.stack ?? "").not.toContain("first-secret-line");
      expect(fatalEvents[0]?.stack ?? "").not.toContain("second-secret-line");

      const records = await readHostCrashRecords(dataDirectory);
      expect(records).toHaveLength(1);
      const joined = records[0]?.lastLines.join("\n") ?? "";
      expect(joined).toContain("broker secret leaked: [REDACTED]");
      expect(joined).not.toContain("first-secret-line");
      expect(joined).not.toContain("second-secret-line");

      net.uninstall();
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("preserves redacted native leaf and caller stack frames even when the error message exceeds the redactor length cap", () => {
    const target = new FakeProcessTarget();
    const lines: string[] = [];
    const fatalEvents: ProcessErrorNetEvent[] = [];
    const exit = vi.fn();
    const homeDirectory = dirname(MODULE_PATH);

    const net = installProcessErrorNet({
      processName: "host",
      target,
      stdioStreams: [],
      homeDirectory,
      writeLine: (line) => lines.push(line),
      onFatal: (event) => fatalEvents.push(event),
      exit,
    });

    const longMessage = `token=sk-longsecret12345 at ${homeDirectory}/secret-dir ${"x".repeat(10_000)}`;
    function buildLongMessageFailure(): Error {
      return new Error(longMessage);
    }
    function invokeLongMessageFailure(): Error {
      return buildLongMessageFailure();
    }
    target.emit("uncaughtException", invokeLongMessageFailure());

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toHaveLength(1);
    const logged = lines[0] ?? "";
    expect(logged).not.toContain("sk-longsecret12345");
    expect(logged).not.toContain(homeDirectory);
    expect(logged).toContain("~/secret-dir");
    expect(logged).toContain("buildLongMessageFailure");
    expect(logged).toContain("invokeLongMessageFailure");
    expect(logged).toContain("~/processErrorNet.test.ts");
    const stackLines = (fatalEvents[0]?.stack ?? "").split("\n");
    expect(
      stackLines.some(
        (line) =>
          line.startsWith("at ") &&
          line.includes("buildLongMessageFailure") &&
          line.includes("~/processErrorNet.test.ts"),
      ),
    ).toBe(true);
    expect(
      stackLines.some(
        (line) =>
          line.startsWith("at ") &&
          line.includes("invokeLongMessageFailure") &&
          line.includes("~/processErrorNet.test.ts"),
      ),
    ).toBe(true);
    expect(fatalEvents[0]?.stack ?? "").not.toContain(homeDirectory);

    net.uninstall();
  });

  it("ends a real child process non-zero with redacted cause and native leaf and caller stack frames in stderr and crash record", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "octant-process-error-net-"));
    const childCwd = process.cwd();
    try {
      const script = [
        `import { installProcessErrorNet } from ${JSON.stringify(MODULE_PATH)};`,
        `import { recordHostCrashSync } from ${JSON.stringify(CRASH_RECORDS_MODULE_PATH)};`,
        `const dataDirectory = ${JSON.stringify(dataDirectory)};`,
        `const homeDirectory = ${JSON.stringify(childCwd)};`,
        `installProcessErrorNet({`,
        `  processName: "host",`,
        `  homeDirectory,`,
        `  onFatal: (event) => {`,
        `    recordHostCrashSync(dataDirectory, {`,
        `      recordedAt: event.timestamp,`,
        `      process: "host",`,
        `      exitReason: event.kind,`,
        `      lastLines: event.line.split("\\n"),`,
        `      homeDirectory,`,
        `    });`,
        `  },`,
        `});`,
        `function explodeInChildProcess() {`,
        `  throw new Error(\`fatal crash at \${homeDirectory}/repo Authorization: Bearer topsecretvalue12345 \${"x".repeat(10_000)}\`);`,
        `}`,
        `function callExplodeInChildProcess() {`,
        `  explodeInChildProcess();`,
        `}`,
        `setTimeout(() => {`,
        `  callExplodeInChildProcess();`,
        `}, 5);`,
      ].join("\n");

      const result = spawnSync("bun", ["-e", script], {
        cwd: childCwd,
        encoding: "utf8",
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[octant:host] fatal uncaughtException");
      expect(result.stderr).toContain("fatal crash at ~/repo");
      const stderrLines = result.stderr.trim().split("\n");
      expect(
        stderrLines.some(
          (line) => line.startsWith("at ") && line.includes("explodeInChildProcess"),
        ),
      ).toBe(true);
      expect(
        stderrLines.some(
          (line) => line.startsWith("at ") && line.includes("callExplodeInChildProcess"),
        ),
      ).toBe(true);
      expect(result.stderr).not.toContain(childCwd);
      expect(result.stderr).not.toContain("topsecretvalue12345");

      const records = await readHostCrashRecords(dataDirectory);
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record?.process).toBe("host");
      expect(record?.exitReason).toBe("uncaughtException");
      expect(record?.lastLines[0]).toContain("[octant:host] fatal uncaughtException");
      expect(record?.lastLines[0]).toContain("fatal crash at ~/repo");
      expect(
        record?.lastLines.some(
          (line) => line.startsWith("at ") && line.includes("explodeInChildProcess"),
        ),
      ).toBe(true);
      expect(
        record?.lastLines.some(
          (line) => line.startsWith("at ") && line.includes("callExplodeInChildProcess"),
        ),
      ).toBe(true);
      const joined = record?.lastLines.join("\n") ?? "";
      expect(joined).not.toContain(childCwd);
      expect(joined).not.toContain("topsecretvalue12345");
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
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
