import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryTestProcessPort } from "./repositoryTestProcessPort";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function folder(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-windows-test-run-")));
  directories.push(directory);
  return directory;
}

function fakeChild(pid: number) {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    close(code: number | null) {
      child.stdout.end();
      child.stderr.end();
      events.emit("close", code, null);
    },
  });
  return child;
}

const confinementThatMustNotRun = {
  prepare: () => {
    throw new Error("A Windows test run is never prepared through the confinement port.");
  },
};

describe("a repository test or scaffold on a Windows host", () => {
  it("refuses under Strict, with a sandbox policy kept, or when the launch does not say, before anything starts", async () => {
    const spawn = vi.fn();
    const port = new RepositoryTestProcessPort({
      platform: "win32",
      spawn,
      confinement: confinementThatMustNotRun,
    });
    for (const strict of [true, undefined]) {
      await expect(
        port.execute({
          argv: [process.execPath, "-e", "void 0"],
          cwd: folder(),
          environment: {},
          timeoutMs: 1_000,
          ...(strict === undefined ? {} : { strict }),
        }),
      ).resolves.toMatchObject({ termination: "unavailable", cleanupUncertain: false });
    }
    await expect(
      port.execute({
        argv: [process.execPath, "-e", "void 0"],
        cwd: folder(),
        environment: {},
        timeoutMs: 1_000,
        strict: false,
        networkAccess: "none",
      }),
    ).resolves.toMatchObject({ termination: "unavailable" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the command unconfined outside Strict, with Windows' own environment, and ends its whole tree on timeout", async () => {
    const child = fakeChild(4242);
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: object) => child);
    const stopWindowsTree = vi.fn(async () => {
      child.close(1);
      return "stopped" as const;
    });
    const killProcessGroup = vi.fn();
    vi.stubEnv("SystemRoot", "C:\\Windows");
    try {
      const port = new RepositoryTestProcessPort({
        platform: "win32",
        spawn,
        stopWindowsTree,
        killProcessGroup,
        processGroupExists: () => false,
        confinement: confinementThatMustNotRun,
      });
      const result = await port.execute({
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: folder(),
        environment: { CI: "1" },
        timeoutMs: 20,
        strict: false,
      });
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        expect.objectContaining({
          shell: false,
          detached: false,
          env: expect.objectContaining({ CI: "1", SYSTEMROOT: "C:\\Windows" }),
        }),
      );
      expect(stopWindowsTree).toHaveBeenCalledWith(4242);
      expect(killProcessGroup).not.toHaveBeenCalled();
      expect(result).toMatchObject({ termination: "timed-out", cleanupUncertain: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves the result uncertain when the tree stop fails", async () => {
    const child = fakeChild(4343);
    const port = new RepositoryTestProcessPort({
      platform: "win32",
      spawn: () => child,
      stopWindowsTree: async () => "failed" as const,
      processGroupExists: () => true,
      confinement: confinementThatMustNotRun,
    });
    const result = await port.execute({
      argv: [process.execPath, "-e", "void 0"],
      cwd: folder(),
      environment: {},
      timeoutMs: 10,
      strict: false,
    });
    expect(result).toMatchObject({ termination: "timed-out", cleanupUncertain: true });
    child.close(null);
  });

  it.runIf(process.platform === "win32")(
    "runs a real program outside Strict and returns its output and exit code",
    async () => {
      const port = new RepositoryTestProcessPort({ receiptDirectory: join(folder(), "receipts") });
      const result = await port.execute({
        argv: [process.execPath, "-e", "console.log('tests passed'); process.exit(3)"],
        cwd: folder(),
        environment: {},
        timeoutMs: 60_000,
        strict: false,
      });
      expect(result).toMatchObject({ termination: "exited", exitCode: 3 });
      expect(new TextDecoder().decode(result.stdout)).toContain("tests passed");
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "ends a real timed-out program and the program it started",
    async () => {
      const port = new RepositoryTestProcessPort({ receiptDirectory: join(folder(), "receipts") });
      const script = [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const result = await port.execute({
        argv: [process.execPath, "-e", script],
        cwd: folder(),
        environment: {},
        timeoutMs: 3_000,
        strict: false,
      });
      expect(result).toMatchObject({ termination: "timed-out", cleanupUncertain: false });
    },
    90_000,
  );
});
