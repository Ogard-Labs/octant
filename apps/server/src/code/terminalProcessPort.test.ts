import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { SeatbeltConfinementError } from "../process/seatbeltProfile";
import {
  ensureNodePtySpawnHelperExecutable,
  shellStateEnvironment,
  TerminalProcessPort,
} from "./terminalProcessPort";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function confinedOptions(overrides: ConstructorParameters<typeof TerminalProcessPort>[0] = {}) {
  const fake = createFakeSandboxConfinement();
  directories.push(fake.root);
  return {
    confinement: fake.confinement,
    temporaryDirectory: fake.temporaryDirectory,
    ...overrides,
  };
}

describe("TerminalProcessPort", () => {
  it("executes commands through the runtime PTY instead of only echoing terminal input", async () => {
    const handle = new TerminalProcessPort(confinedOptions()).start({
      shell: process.platform === "darwin" ? "/bin/zsh" : "/bin/sh",
      cwd: tmpdir(),
      stateScope: "repo_test",
      environment: {
        HOME: process.env.HOME ?? tmpdir(),
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "dumb",
      },
      columns: 80,
      rows: 24,
    });
    let output = "";
    handle.onData((data) => {
      output += data;
    });
    try {
      await handle.receiptReady;
      handle.write(`printf '%s\\n' "$((1729+1))"\r`);
      await vi.waitFor(() => expect(output).toContain("1730"), { timeout: 3_000 });
      handle.write(`printf '%s\\n' "$TERM"\r`);
      await vi.waitFor(() => expect(output).toContain("xterm-256color"), { timeout: 3_000 });
    } finally {
      await handle.close();
    }
  });

  it("repairs a non-executable macOS node-pty spawn helper before launch", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "octant-node-pty-"));
    const nativeDirectory = join(packageRoot, "prebuilds", "darwin-arm64");
    const helperPath = join(nativeDirectory, "spawn-helper");
    try {
      await mkdir(nativeDirectory, { recursive: true });
      await writeFile(join(nativeDirectory, "pty.node"), "native placeholder");
      await writeFile(helperPath, "helper placeholder", { mode: 0o644 });
      await chmod(helperPath, 0o644);

      ensureNodePtySpawnHelperExecutable({
        packageRoot,
        platform: "darwin",
        architecture: "arm64",
      });

      expect((await stat(helperPath)).mode & 0o111).toBe(0o111);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("spawns the shell through Seatbelt with bounded geometry and environment", () => {
    const pty = fakePty();
    const spawn = vi.fn(() => pty);
    const fake = createFakeSandboxConfinement();
    directories.push(fake.root);
    const shellStateDirectory = join(fake.root, "terminal-shell");
    const port = new TerminalProcessPort({
      spawn,
      killProcessGroup: vi.fn(),
      confinement: fake.confinement,
      temporaryDirectory: fake.temporaryDirectory,
      shellStateDirectory,
      networkEgress: "none",
    });

    port.start({
      shell: "/bin/zsh",
      cwd: "/private/repo",
      stateScope: "repo_test",
      environment: { PATH: "/usr/bin", OCTANT_TOKEN: "secret" },
      columns: 120,
      rows: 40,
    });

    // The shell keeps its history and prompt caches in the Octant-owned state
    // directory of its own bound root instead of failing against the read-only
    // home or sharing one history with every other repository.
    const stateDirectory = launchedStateDirectory(spawn);
    expect(dirname(stateDirectory)).toBe(shellStateDirectory);
    expect(spawn).toHaveBeenCalledWith(
      fake.sandboxPath,
      expect.arrayContaining(["-p", "--", "/bin/zsh"]),
      {
        name: "xterm-256color",
        cwd: "/private/repo",
        env: {
          ...shellStateEnvironment(stateDirectory),
          PATH: "/usr/bin",
          OCTANT_TOKEN: "secret",
        },
        cols: 120,
        rows: 40,
      },
    );
    expect(existsSync(stateDirectory)).toBe(true);
    const profile = launchedProfile(spawn);
    expect(profile).toContain("(deny default)");
    expect(profile).toContain(`(allow file-write* (subpath "${realpathSync(stateDirectory)}"))`);
    expect(profile).not.toContain("(allow network*)");
  });

  it("keeps shell history and caches separate for every bound root", async () => {
    const fake = createFakeSandboxConfinement();
    directories.push(fake.root);
    const shellStateDirectory = join(fake.root, "terminal-shell");
    const first = await mkdtemp(join(fake.root, "checkout-a-"));
    const second = await mkdtemp(join(fake.root, "checkout-b-"));
    const launch = (cwd: string, stateScope = "repo_a") => {
      const spawn = vi.fn(() => fakePty());
      new TerminalProcessPort({
        spawn,
        killProcessGroup: vi.fn(),
        confinement: fake.confinement,
        temporaryDirectory: fake.temporaryDirectory,
        shellStateDirectory,
      }).start({ shell: "/bin/zsh", cwd, stateScope, environment: {}, columns: 80, rows: 24 });
      return {
        stateDirectory: launchedStateDirectory(spawn),
        profile: launchedProfile(spawn),
        environment: (spawn.mock.calls[0] as unknown as [string, string[], { env: EnvRecord }])[2]
          .env,
      };
    };

    const a = launch(first);
    const b = launch(second);

    // One Project's confined shell can neither read nor write the other's
    // history, where command lines can carry secrets.
    expect(a.stateDirectory).not.toBe(b.stateDirectory);
    expect(dirname(a.stateDirectory)).toBe(shellStateDirectory);
    expect(dirname(b.stateDirectory)).toBe(shellStateDirectory);
    expect(a.environment.HISTFILE).toBe(join(a.stateDirectory, "zsh_history"));
    expect(b.environment.HISTFILE).toBe(join(b.stateDirectory, "zsh_history"));
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      expect(own.profile).toContain(
        `(allow file-write* (subpath "${realpathSync(own.stateDirectory)}"))`,
      );
      for (const permission of ["file-read*", "file-write*"]) {
        expect(own.profile).not.toContain(
          `(allow ${permission} (subpath "${realpathSync(other.stateDirectory)}"))`,
        );
      }
      // The shared base is never itself an allow root, and it is denied as a
      // whole so a sibling created after this profile was generated is out of
      // reach too — not just the siblings that existed at generation time.
      for (const permission of ["file-read*", "file-write*"]) {
        expect(own.profile).not.toContain(
          `(allow ${permission} (subpath "${realpathSync(shellStateDirectory)}"))`,
        );
      }
      expect(own.profile).toContain(
        `(deny file-read* (subpath "${realpathSync(shellStateDirectory)}"))`,
      );
      // The base can sit under an ancestor that is itself writable, so the
      // write side needs the same stable denial.
      expect(own.profile).toContain(
        `(deny file-write* (subpath "${realpathSync(shellStateDirectory)}"))`,
      );
      expect(
        own.profile.indexOf(`(deny file-write* (subpath "${realpathSync(shellStateDirectory)}"))`),
      ).toBeLessThan(
        own.profile.indexOf(`(allow file-write* (subpath "${realpathSync(own.stateDirectory)}"))`),
      );
      expect(
        own.profile.indexOf(`(deny file-read* (subpath "${realpathSync(shellStateDirectory)}"))`),
      ).toBeLessThan(
        own.profile.indexOf(`(allow file-read* (subpath "${realpathSync(own.stateDirectory)}"))`),
      );
    }

    // A path is reusable: remove a repository and create an unrelated one in
    // its place and the new shell must not inherit the old one's history.
    expect(launch(first, "repo_b").stateDirectory).not.toBe(a.stateDirectory);
    expect(launch(first).stateDirectory).toBe(a.stateDirectory);
  });

  it("fails closed when Seatbelt confinement is unavailable", () => {
    expect(() =>
      new TerminalProcessPort({
        platform: "linux",
        spawn: vi.fn(),
      }).start({
        shell: "/bin/sh",
        cwd: tmpdir(),
        stateScope: "repo_test",
        environment: {},
        columns: 80,
        rows: 24,
      }),
    ).toThrow(SeatbeltConfinementError);
  });

  it("bounds input and geometry before invoking the PTY", () => {
    const pty = fakePty();
    const handle = new TerminalProcessPort(confinedOptions({ spawn: () => pty })).start({
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      environment: {},
      columns: 80,
      rows: 24,
    });

    expect(() => handle.write("x".repeat(65_537))).toThrow();
    expect(() => handle.resize(0, 24)).toThrow();
    expect(() => handle.resize(80, 501)).toThrow();
    expect(pty.write).not.toHaveBeenCalled();
  });

  it("escalates TERM to verified process-group KILL without broad process names", async () => {
    const pty = fakePty();
    const signals: Array<[number, NodeJS.Signals]> = [];
    const waits = [false, true];
    const port = new TerminalProcessPort(
      confinedOptions({
        spawn: () => pty,
        killProcessGroup: vi.fn((pid, signal) => signals.push([pid, signal])),
        waitForExit: vi.fn(async () => waits.shift() ?? true),
      }),
    );
    const handle = port.start({
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      environment: {},
      columns: 80,
      rows: 24,
    });

    await handle.close();

    expect(signals).toEqual([
      [-4321, "SIGTERM"],
      [-4321, "SIGKILL"],
    ]);
  });

  it("observes a PTY that exits while the graceful-exit listener is installed", async () => {
    const pty = fakePty();
    pty.onExit.mockImplementation((listener) => {
      listener({ exitCode: 0 });
      return { dispose: vi.fn() };
    });
    const killProcessGroup = vi.fn();
    const handle = new TerminalProcessPort(
      confinedOptions({ spawn: () => pty, killProcessGroup }),
    ).start({
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      environment: {},
      columns: 80,
      rows: 24,
    });

    await expect(handle.close()).resolves.toBeUndefined();
    expect(killProcessGroup).toHaveBeenCalledOnce();
  });

  it("treats a process group that exits before TERM as already closed", async () => {
    const pty = fakePty();
    const waitForExit = vi.fn(async () => true);
    const killProcessGroup = vi.fn(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    const handle = new TerminalProcessPort(
      confinedOptions({
        spawn: () => pty,
        killProcessGroup,
        waitForExit,
      }),
    ).start({
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      environment: {},
      columns: 80,
      rows: 24,
    });

    await expect(handle.close()).resolves.toBeUndefined();
    expect(killProcessGroup).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(waitForExit).not.toHaveBeenCalled();
  });

  it("treats a process group that exits before KILL as already closed", async () => {
    const pty = fakePty();
    const killProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      }
    });
    const handle = new TerminalProcessPort(
      confinedOptions({
        spawn: () => pty,
        killProcessGroup,
        waitForExit: async () => false,
      }),
    ).start({
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      environment: {},
      columns: 80,
      rows: 24,
    });

    await expect(handle.close()).resolves.toBeUndefined();
    expect(killProcessGroup).toHaveBeenCalledTimes(2);
  });

  it("writes a durable identity receipt for restart reconciliation", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-terminal-receipts-"));
    try {
      const pty = fakePty();
      const handle = new TerminalProcessPort(
        confinedOptions({
          spawn: () => pty,
          receiptDirectory,
          processIdentity: async () => `sha256:${"a".repeat(64)}`,
        }),
      ).start({
        shell: "/bin/zsh",
        cwd: "/repo",
        stateScope: "repo_test",
        environment: {},
        columns: 80,
        rows: 24,
      });
      await handle.receiptReady;
      const files = await readdir(receiptDirectory);
      expect(files).toHaveLength(1);
      expect(JSON.parse(await readFile(join(receiptDirectory, files[0]!), "utf8"))).toMatchObject({
        pid: 4321,
        processIdentity: `sha256:${"a".repeat(64)}`,
      });
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("removes the receipt when the PTY exits cleanly", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-terminal-receipts-"));
    try {
      const pty = fakePty();
      const handle = new TerminalProcessPort(
        confinedOptions({
          spawn: () => pty,
          receiptDirectory,
          processIdentity: async () => `sha256:${"a".repeat(64)}`,
        }),
      ).start({
        shell: "/bin/zsh",
        cwd: "/repo",
        stateScope: "repo_test",
        environment: {},
        columns: 80,
        rows: 24,
      });
      await handle.receiptReady;
      expect(await readdir(receiptDirectory)).toHaveLength(1);
      const exitListener = pty.onExit.mock.calls[0]?.[0] as
        | ((event: { exitCode: number }) => void)
        | undefined;
      exitListener?.({ exitCode: 0 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await readdir(receiptDirectory)).toHaveLength(0);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("removes a receipt after a fast PTY exit races identity inspection", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-terminal-receipts-"));
    try {
      let releaseIdentity!: () => void;
      const identity = new Promise<string>((resolve) => {
        releaseIdentity = () => resolve(`sha256:${"a".repeat(64)}`);
      });
      const pty = fakePty();
      const handle = new TerminalProcessPort(
        confinedOptions({
          spawn: () => pty,
          receiptDirectory,
          processIdentity: async () => identity,
        }),
      ).start({
        shell: "/bin/zsh",
        cwd: "/repo",
        stateScope: "repo_test",
        environment: {},
        columns: 80,
        rows: 24,
      });
      const exitListener = pty.onExit.mock.calls[0]?.[0] as
        | ((event: { exitCode: number }) => void)
        | undefined;
      exitListener?.({ exitCode: 0 });
      releaseIdentity();
      await handle.receiptReady;
      await vi.waitFor(async () => expect(await readdir(receiptDirectory)).toHaveLength(0));
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("retains the receipt when the terminal group survives bounded shutdown", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-terminal-receipts-"));
    try {
      const pty = fakePty();
      const handle = new TerminalProcessPort(
        confinedOptions({
          spawn: () => pty,
          receiptDirectory,
          processIdentity: async () => `sha256:${"a".repeat(64)}`,
          processGroupExists: () => true,
          killProcessGroup: vi.fn(),
          waitForExit: async () => true,
          gracefulTimeoutMs: 1,
        }),
      ).start({
        shell: "/bin/zsh",
        cwd: "/repo",
        stateScope: "repo_test",
        environment: {},
        columns: 80,
        rows: 24,
      });
      await handle.receiptReady;

      await expect(handle.close()).rejects.toThrow("did not exit");
      expect(await readdir(receiptDirectory)).toHaveLength(1);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });
});

type EnvRecord = Record<string, string>;
type SpawnMock = { readonly mock: { readonly calls: ReadonlyArray<unknown> } };

function launchedCall(spawn: SpawnMock): [string, string[], { env: EnvRecord }] {
  return spawn.mock.calls[0] as [string, string[], { env: EnvRecord }];
}

/** The state directory one launch actually pointed its shell at. */
function launchedStateDirectory(spawn: SpawnMock): string {
  return dirname(String(launchedCall(spawn)[2].env.HISTFILE));
}

function launchedProfile(spawn: SpawnMock): string {
  return String(launchedCall(spawn)[1][1]);
}

function fakePty() {
  return {
    pid: 4321,
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((_listener: (event: { exitCode: number; signal?: number }) => void) => ({
      dispose: vi.fn(),
    })),
    pause: vi.fn(),
    resume: vi.fn(),
  };
}
