import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { RepositoryTestProcessPort } from "./repositoryTestProcessPort";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function confinedOptions(
  overrides: ConstructorParameters<typeof RepositoryTestProcessPort>[0] = {},
) {
  const fake = createFakeSandboxConfinement();
  directories.push(fake.root);
  return {
    confinement: fake.confinement,
    temporaryDirectory: fake.temporaryDirectory,
    ...overrides,
  };
}

describe("RepositoryTestProcessPort", () => {
  it("executes structured argv without a shell at the exact cwd using a sanitized environment", async () => {
    const cwd = temporaryDirectory();
    vi.stubEnv("OCTANT_UNSCOPED_SECRET", "must-not-leak");
    const port = new RepositoryTestProcessPort(confinedOptions());
    const script = [
      "process.stdout.write(JSON.stringify({cwd:process.cwd(),allowed:process.env.TEST_ALLOWED,leaked:process.env.OCTANT_UNSCOPED_SECRET,arg:process.argv[1]}));",
      "process.stderr.write('stderr');",
    ].join("");

    const result = await port.execute({
      argv: [process.execPath, "-e", script, "; touch should-not-run"],
      cwd: realpathSync(cwd),
      environment: { TEST_ALLOWED: "present" },
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      termination: "exited",
      exitCode: 0,
      parserFailed: false,
      cleanupUncertain: false,
    });
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      cwd: realpathSync(cwd),
      allowed: "present",
      arg: "; touch should-not-run",
    });
    expect(new TextDecoder().decode(result.stderr)).toBe("stderr");
  });

  it("launches through Seatbelt and fails closed when sandbox-exec is unavailable", async () => {
    const child = fakeChild(99);
    const spawn = vi.fn(() => child);
    const fake = createFakeSandboxConfinement();
    directories.push(fake.root);
    const port = new RepositoryTestProcessPort({
      platform: "darwin",
      sandboxPath: fake.sandboxPath,
      temporaryDirectory: fake.temporaryDirectory,
      seatbeltHomeDirectory: fake.root,
      seatbeltUsersDirectory: fake.root,
      spawn,
      networkEgress: "none",
    });
    const execution = port.execute({
      argv: ["/usr/bin/true"],
      cwd: temporaryDirectory(),
      environment: {},
      timeoutMs: 1_000,
    });
    expect(spawn).toHaveBeenCalled();
    const firstCall = spawn.mock.calls[0] as unknown as [string, string[], unknown?];
    expect(firstCall[0]).toBe(fake.sandboxPath);
    expect(firstCall[1][0]).toBe("-p");
    expect(String(firstCall[1][1])).toContain("(deny default)");
    expect(String(firstCall[1][1])).not.toContain("(allow network*)");
    child.close(0, null);
    await expect(execution).resolves.toMatchObject({ termination: "exited", exitCode: 0 });

    const missingSpawn = vi.fn();
    const missing = new RepositoryTestProcessPort({
      platform: "darwin",
      sandboxPath: join(fake.root, "missing-sandbox-exec"),
      temporaryDirectory: fake.temporaryDirectory,
      spawn: missingSpawn,
    });
    await expect(
      missing.execute({
        argv: ["/usr/bin/true"],
        cwd: temporaryDirectory(),
        environment: {},
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ termination: "unavailable" });
    expect(missingSpawn).not.toHaveBeenCalled();

    const linuxSpawn = vi.fn();
    const linux = new RepositoryTestProcessPort({
      platform: "linux",
      sandboxPath: join(fake.root, "missing-bwrap"),
      temporaryDirectory: fake.temporaryDirectory,
      spawn: linuxSpawn,
    });
    await expect(
      linux.execute({
        argv: ["/usr/bin/true"],
        cwd: temporaryDirectory(),
        environment: {},
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ termination: "unavailable" });
    expect(linuxSpawn).not.toHaveBeenCalled();
  });

  it("writes and removes a test-runner receipt around a clean exit", async () => {
    const receiptDirectory = temporaryDirectory();
    const child = fakeChild(4321);
    const port = new RepositoryTestProcessPort(
      confinedOptions({
        spawn: () => child,
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
      }),
    );
    const execution = port.execute({
      argv: ["/usr/bin/test"],
      cwd: "/repo",
      environment: {},
      timeoutMs: 5_000,
    });
    await vi.waitFor(async () => expect(await readdir(receiptDirectory)).toHaveLength(1));
    child.close(0, null);
    await execution;
    await expect(readdir(receiptDirectory)).resolves.toHaveLength(0);
  });

  it("does not report a fast clean exit before its delayed receipt is removed", async () => {
    const receiptDirectory = temporaryDirectory();
    const child = fakeChild(4321);
    let releaseIdentity!: () => void;
    const identityReady = new Promise<string>((resolve) => {
      releaseIdentity = () => resolve(`sha256:${"a".repeat(64)}`);
    });
    const port = new RepositoryTestProcessPort(
      confinedOptions({
        spawn: () => child,
        receiptDirectory,
        processIdentity: async () => identityReady,
      }),
    );
    let settled = false;
    const execution = port
      .execute({
        argv: ["/usr/bin/test"],
        cwd: "/repo",
        environment: {},
        timeoutMs: 5_000,
      })
      .then((result) => {
        settled = true;
        return result;
      });

    child.close(0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    releaseIdentity();
    await expect(execution).resolves.toMatchObject({
      termination: "exited",
      cleanupUncertain: false,
    });
    await expect(readdir(receiptDirectory)).resolves.toHaveLength(0);
  });

  it("retains a normal-exit receipt when the detached group survives", async () => {
    const receiptDirectory = temporaryDirectory();
    const child = fakeChild(4321);
    const port = new RepositoryTestProcessPort(
      confinedOptions({
        spawn: () => child,
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
        processGroupExists: () => true,
        gracefulTimeoutMs: 1,
      }),
    );
    const execution = port.execute({
      argv: ["/usr/bin/test"],
      cwd: "/repo",
      environment: {},
      timeoutMs: 5_000,
    });
    await vi.waitFor(async () => expect(await readdir(receiptDirectory)).toHaveLength(1));
    child.close(0, null);

    await expect(execution).resolves.toMatchObject({
      termination: "exited",
      exitCode: 0,
      cleanupUncertain: true,
    });
    await expect(readdir(receiptDirectory)).resolves.toHaveLength(1);
  });

  it("preserves a fast exit when receipt identity inspection loses the race", async () => {
    const child = fakeChild(4321);
    let releaseIdentity!: () => void;
    const identityReady = new Promise<string>((resolve) => {
      releaseIdentity = () => resolve(`sha256:${"a".repeat(64)}`);
    });
    const port = new RepositoryTestProcessPort(
      confinedOptions({
        spawn: () => child,
        receiptDirectory: temporaryDirectory(),
        processIdentity: async () => identityReady,
      }),
    );
    const execution = port.execute({
      argv: ["/usr/bin/true"],
      cwd: "/repo",
      environment: {},
      timeoutMs: 5_000,
    });
    child.stdout.write("done");
    child.close(0, null);
    await Promise.resolve();
    releaseIdentity();
    await expect(execution).resolves.toMatchObject({
      termination: "exited",
      exitCode: 0,
    });
  });

  it("reports uncertain cleanup when receipt persistence fails and the group survives", async () => {
    const child = fakeChild(4321);
    const port = new RepositoryTestProcessPort(
      confinedOptions({
        spawn: () => child,
        receiptDirectory: temporaryDirectory(),
        processIdentity: async () => {
          throw new Error("identity unavailable");
        },
        processGroupExists: () => true,
        killProcessGroup: vi.fn(),
        gracefulTimeoutMs: 1,
      }),
    );
    const execution = port.execute({
      argv: ["/usr/bin/test"],
      cwd: "/repo",
      environment: {},
      timeoutMs: 5_000,
    });
    await expect(execution).resolves.toMatchObject({
      termination: "unavailable",
      cleanupUncertain: true,
    });
  });

  it("signals a surviving group when a fast-exit receipt attempt fails", async () => {
    const child = fakeChild(4321);
    const signals: Array<[number, NodeJS.Signals]> = [];
    const port = new RepositoryTestProcessPort(
      confinedOptions({
        spawn: () => child,
        receiptDirectory: temporaryDirectory(),
        processIdentity: async () => {
          throw new Error("identity unavailable");
        },
        processGroupExists: () => true,
        killProcessGroup: (pid, signal) => signals.push([pid, signal]),
        gracefulTimeoutMs: 1,
      }),
    );
    const execution = port.execute({
      argv: ["/usr/bin/true"],
      cwd: "/repo",
      environment: {},
      timeoutMs: 5_000,
    });
    child.close(0, null);
    await expect(execution).resolves.toMatchObject({ cleanupUncertain: true });
    await vi.waitFor(() => expect(signals).toContainEqual([-4321, "SIGTERM"]));
  });

  it.each(["timed-out", "cancelled"] as const)(
    "observes %s while receipt persistence is pending",
    async (termination) => {
      const child = fakeChild(4321);
      const receiptDirectory = temporaryDirectory();
      let releaseIdentity!: () => void;
      const identityReady = new Promise<string>((resolve) => {
        releaseIdentity = () => resolve(`sha256:${"a".repeat(64)}`);
      });
      const signals: Array<[number, NodeJS.Signals]> = [];
      const controller = new AbortController();
      const port = new RepositoryTestProcessPort(
        confinedOptions({
          spawn: () => child,
          receiptDirectory,
          processIdentity: async () => identityReady,
          processGroupExists: () => false,
          killProcessGroup: (pid, signal) => {
            signals.push([pid, signal]);
            child.close(null, signal);
          },
          gracefulTimeoutMs: 1,
        }),
      );
      const execution = port.execute(
        { argv: ["/usr/bin/test"], cwd: "/repo", environment: {}, timeoutMs: 1 },
        controller.signal,
      );
      if (termination === "cancelled") controller.abort();

      await expect(execution).resolves.toMatchObject({
        termination,
        cleanupUncertain: false,
      });
      expect(signals[0]).toEqual([-4321, "SIGTERM"]);
      releaseIdentity();
    },
  );

  it("bounds stdout and stderr together while retaining one overflow byte for the runner", async () => {
    const child = fakeChild(4321);
    const port = new RepositoryTestProcessPort(
      confinedOptions({ spawn: vi.fn(() => child), maxOutputBytes: 8 }),
    );

    const execution = port.execute({
      argv: ["/usr/bin/test"],
      cwd: "/repo",
      environment: {},
      timeoutMs: 5_000,
    });
    child.stdout.write("123456");
    child.stderr.write("abcdef");
    child.close(0, null);
    const result = await execution;

    expect(result.stdout.byteLength + result.stderr.byteLength).toBe(9);
    expect(new TextDecoder().decode(result.stdout)).toBe("123456");
    expect(new TextDecoder().decode(result.stderr)).toBe("abc");
  });

  it("escalates timeout and cancellation from process-group TERM to KILL", async () => {
    for (const termination of ["timed-out", "cancelled"] as const) {
      const child = fakeChild(4321);
      const signals: Array<[number, NodeJS.Signals]> = [];
      const controller = new AbortController();
      const port = new RepositoryTestProcessPort(
        confinedOptions({
          spawn: () => child,
          killProcessGroup: (pid, signal) => {
            signals.push([pid, signal]);
            if (signal === "SIGKILL") child.close(null, "SIGKILL");
          },
          gracefulTimeoutMs: 1,
        }),
      );
      const execution = port.execute(
        { argv: ["/usr/bin/test"], cwd: "/repo", environment: {}, timeoutMs: 1 },
        controller.signal,
      );
      if (termination === "cancelled") controller.abort();

      await expect(execution).resolves.toMatchObject({
        termination,
        cleanupUncertain: false,
      });
      expect(signals).toEqual([
        [-4321, "SIGTERM"],
        [-4321, "SIGKILL"],
      ]);
    }
  });

  it("reports uncertain cleanup and fails closed on unsupported process-group platforms", async () => {
    const child = fakeChild(4321);
    const receiptDirectory = temporaryDirectory();
    const uncertain = new RepositoryTestProcessPort(
      confinedOptions({
        spawn: () => child,
        killProcessGroup: vi.fn(),
        processGroupExists: () => true,
        gracefulTimeoutMs: 1,
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
      }),
    );
    await expect(
      uncertain.execute({ argv: ["/usr/bin/test"], cwd: "/repo", environment: {}, timeoutMs: 1 }),
    ).resolves.toMatchObject({ termination: "timed-out", cleanupUncertain: true });
    await expect(readdir(receiptDirectory)).resolves.toHaveLength(1);

    const spawn = vi.fn();
    const unsupported = new RepositoryTestProcessPort({ platform: "win32", spawn });
    await expect(
      unsupported.execute({ argv: ["C:/test.exe"], cwd: "C:/repo", environment: {}, timeoutMs: 1 }),
    ).resolves.toMatchObject({ termination: "unavailable", cleanupUncertain: false });
    expect(spawn).not.toHaveBeenCalled();

    const unknownSpawn = vi.fn();
    const unknown = new RepositoryTestProcessPort({
      platform: "haiku" as NodeJS.Platform,
      spawn: unknownSpawn,
    });
    await expect(
      unknown.execute({ argv: ["/usr/bin/test"], cwd: "/repo", environment: {}, timeoutMs: 1 }),
    ).resolves.toMatchObject({ termination: "unavailable", cleanupUncertain: false });
    expect(unknownSpawn).not.toHaveBeenCalled();
  });

  it("does not spawn an already-cancelled test and reports invalid output encoding", async () => {
    const spawn = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const cancelled = new RepositoryTestProcessPort(confinedOptions({ spawn }));
    await expect(
      cancelled.execute(
        { argv: ["/usr/bin/test"], cwd: "/repo", environment: {}, timeoutMs: 1_000 },
        controller.signal,
      ),
    ).resolves.toMatchObject({ termination: "cancelled", cleanupUncertain: false });
    expect(spawn).not.toHaveBeenCalled();

    const child = fakeChild(4321);
    const invalid = new RepositoryTestProcessPort(confinedOptions({ spawn: () => child }));
    const execution = invalid.execute({
      argv: ["/usr/bin/test"],
      cwd: "/repo",
      environment: {},
      timeoutMs: 1_000,
    });
    child.stdout.write(new Uint8Array([0xff]));
    child.close(0, null);
    await expect(execution).resolves.toMatchObject({ parserFailed: true });
  });

  it("rejects shell-shaped argv before spawning", async () => {
    const spawn = vi.fn();
    const port = new RepositoryTestProcessPort(confinedOptions({ spawn }));

    for (const argv of [
      ["bash", "-c", "echo unsafe"],
      ["/bin/sh", "script.sh"],
      [process.execPath, "-c", "echo unsafe"],
    ]) {
      await expect(
        port.execute({ argv, cwd: "/repo", environment: {}, timeoutMs: 1_000 }),
      ).resolves.toMatchObject({ termination: "unavailable" });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects environment entries that can redirect executable loading or credential prompts", async () => {
    for (const name of [
      "PATH",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "GIT_ASKPASS",
    ]) {
      const spawn = vi.fn();
      const port = new RepositoryTestProcessPort(confinedOptions({ spawn }));
      await expect(
        port.execute({
          argv: [process.execPath, "--version"],
          cwd: "/repo",
          environment: { [name]: "attacker-controlled" },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ termination: "unavailable" });
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  it("reads only contained artifacts with a maximum-plus-one probe", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    mkdirSync(join(root, "artifacts"));
    writeFileSync(join(root, "artifacts", "report.bin"), new Uint8Array([1, 2, 3, 4, 5]));
    writeFileSync(join(outside, "secret.bin"), "secret");
    symlinkSync(join(outside, "secret.bin"), join(root, "artifacts", "escape.bin"));
    const port = new RepositoryTestProcessPort(confinedOptions());

    await expect(
      port.readArtifact({
        checkoutRoot: root,
        relativePath: "artifacts/report.bin",
        maximumBytes: 3,
      }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
    await expect(
      port.readArtifact({
        checkoutRoot: root,
        relativePath: "artifacts/missing.bin",
        maximumBytes: 3,
      }),
    ).resolves.toBeUndefined();
    await expect(
      port.readArtifact({
        checkoutRoot: root,
        relativePath: "artifacts/escape.bin",
        maximumBytes: 3,
      }),
    ).rejects.toThrow();
    await expect(
      port.readArtifact({ checkoutRoot: root, relativePath: "../secret.bin", maximumBytes: 3 }),
    ).rejects.toThrow();
    await expect(
      port.readArtifact({ checkoutRoot: root, relativePath: "artifacts", maximumBytes: 3 }),
    ).rejects.toThrow();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-repository-test-process-"));
  directories.push(directory);
  return directory;
}

function fakeChild(pid: number) {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    close(code: number | null, signal: NodeJS.Signals | null) {
      child.stdout.end();
      child.stderr.end();
      events.emit("close", code, signal);
    },
  });
  return child;
}
