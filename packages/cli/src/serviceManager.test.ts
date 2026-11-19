import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHostRuntimePaths } from "@octant/host-runtime";
import {
  createLaunchdUserServiceManager,
  createSystemdUserServiceManager,
  createWindowsUserServiceManager,
  quoteWindowsCommandLine,
  type ServiceCommandRunner,
  type WindowsHostObservation,
  type WindowsHostOwnerPort,
  type WindowsHostSpawnSpec,
} from "./serviceManager";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function paths(root: string) {
  return resolveHostRuntimePaths({
    env: { OCTANT_DATA_DIR: join(root, "data") },
    platform: "linux",
    home: join(root, "home"),
    temporaryDirectory: "/tmp",
    uid: process.getuid?.() ?? 0,
  });
}

function xdgPaths(root: string) {
  return resolveHostRuntimePaths({
    env: {
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
    },
    platform: "linux",
    home: join(root, "home"),
    temporaryDirectory: "/tmp",
    uid: process.getuid?.() ?? 0,
  });
}

describe("per-user service managers", () => {
  it("reports manager command failures as typed failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-manager-failure-"));
    roots.push(root);
    const runner: ServiceCommandRunner = {
      run: vi.fn(async () => {
        throw new Error("manager process failed");
      }),
    };
    const manager = createSystemdUserServiceManager({
      paths: paths(root),
      uid: process.getuid?.() ?? 0,
      home: join(root, "home"),
      executable: "/opt/octant/bin/octant",
      runner,
    });

    await expect(manager.install()).rejects.toMatchObject({
      name: "ServiceManagerError",
      code: "manager-failed",
    });
  });

  it("uses launchctl in the user GUI domain and keeps descriptors secret-free", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-launchd-manager-"));
    roots.push(root);
    const runtimePaths = paths(root);
    const cliEntryPoint = join(root, "repo", "packages", "cli", "src", "bin.ts");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: ServiceCommandRunner = {
      run: vi.fn(async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "" };
      }),
    };
    const manager = createLaunchdUserServiceManager({
      paths: runtimePaths,
      uid: process.getuid?.() ?? 0,
      home: join(root, "home"),
      executable: "/opt/homebrew/bin/bun",
      cliEntryPoint,
      runtimeEnvironment: {
        OCTANT_DATA_DIR: runtimePaths.dataDirectory,
        XDG_CONFIG_HOME: join(root, "config-home"),
        XDG_STATE_HOME: join(root, "state-home"),
        OCTANT_SERVER_PORT: "17777",
        OCTANT_DESKTOP_BRIDGE_SECRET: "not-persisted",
        OCTANT_CREDENTIAL_BROKER_TOKEN: "not-persisted",
      },
      runner,
    });

    await manager.install();

    const descriptor = await readFile(
      join(root, "home", "Library", "LaunchAgents", "app.octant.server.plist"),
      "utf8",
    );
    expect(descriptor).not.toMatch(/secret|token|credential|password|api[_-]?key/i);
    expect(descriptor).toContain("<string>/opt/homebrew/bin/bun</string>");
    expect(descriptor).toContain(`<string>${cliEntryPoint}</string>`);
    expect(descriptor).toContain("<key>OCTANT_DATA_DIR</key>");
    expect(descriptor).toContain(runtimePaths.dataDirectory);
    expect(descriptor).toContain("<key>OCTANT_SERVER_PORT</key><string>17777</string>");
    expect(descriptor).not.toContain("bun</string><string>server</string><string>run</string>");
    expect(calls[0]?.command).toBe("/bin/launchctl");
    expect(calls[0]?.args.slice(0, 2)).toEqual(["bootstrap", `gui/${process.getuid?.() ?? 0}`]);
    expect(calls.flatMap((call) => call.args)).not.toContain("sudo");
  });

  it("uses only the systemd user manager and bounded restart policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-systemd-manager-"));
    roots.push(root);
    const runtimePaths = xdgPaths(root);
    const cliEntryPoint = join(root, "repo", "packages", "cli", "src", "bin.ts");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: ServiceCommandRunner = {
      run: vi.fn(async (command, args) => {
        calls.push({ command, args });
        return { stdout: args.includes("show-user") ? "yes\n" : "active\n", stderr: "" };
      }),
    };
    const manager = createSystemdUserServiceManager({
      paths: runtimePaths,
      uid: process.getuid?.() ?? 0,
      home: join(root, "home"),
      executable: "/opt/homebrew/bin/bun",
      cliEntryPoint,
      runtimeEnvironment: {
        XDG_CONFIG_HOME: join(root, "config-home"),
        XDG_STATE_HOME: join(root, "state-home"),
        XDG_DATA_HOME: join(root, "data-home"),
        OCTANT_SERVER_PORT: "17777",
      },
      runner,
    });

    await manager.install();
    const unit = await readFile(
      join(root, "home", ".config", "systemd", "user", "octant.service"),
      "utf8",
    );
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StartLimitIntervalSec=60s");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit.indexOf("StartLimitIntervalSec=60s")).toBeLessThan(unit.indexOf("[Service]"));
    expect(unit.indexOf("StartLimitBurst=5")).toBeLessThan(unit.indexOf("[Service]"));
    expect(unit).toContain(`ExecStart=/opt/homebrew/bin/bun ${cliEntryPoint} server run`);
    expect(unit).toContain("Environment=OCTANT_SERVER_PORT=17777");
    expect(unit).toContain(`Environment=XDG_CONFIG_HOME=${dirname(runtimePaths.configDirectory)}`);
    expect(unit).toContain(`Environment=XDG_STATE_HOME=${dirname(runtimePaths.stateDirectory)}`);
    expect(unit).not.toMatch(/sudo|secret|token|credential|password|api[_-]?key/i);
    expect(calls[0]).toEqual({
      command: "/usr/bin/systemctl",
      args: ["--user", "--no-ask-password", "daemon-reload"],
    });
  });

  it("refuses to install a unit whose runtime is not an absolute path", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-relative-runtime-"));
    roots.push(root);
    const runner: ServiceCommandRunner = {
      run: vi.fn(async () => ({ stdout: "", stderr: "" })),
    };
    expect(() =>
      createSystemdUserServiceManager({
        paths: paths(root),
        uid: process.getuid?.() ?? 0,
        home: join(root, "home"),
        executable: "bun",
        cliEntryPoint: join(root, "bin.ts"),
        runtimeEnvironment: {},
        runner,
      }),
    ).toThrow(expect.objectContaining({ name: "ServiceManagerError", code: "unsafe-descriptor" }));
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("reports a systemd unit that is not installed yet as stopped, not as an unavailable manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-systemd-missing-unit-"));
    roots.push(root);
    // systemd 259 answers `is-active` and `is-enabled` for a unit it has never
    // loaded with exit 4 ("no such unit") rather than 3 or 1.
    const noSuchUnit = Object.assign(new Error("Command failed"), {
      code: 4,
      stdout: "",
      stderr: "",
    });
    const runner: ServiceCommandRunner = {
      run: vi.fn(async (command, args) => {
        if (args.includes("is-active") || args.includes("is-enabled")) throw noSuchUnit;
        if (command === "/usr/bin/loginctl") {
          return {
            stdout: args.some((arg: string) => arg.includes("Linger")) ? "yes\n" : "active\n",
            stderr: "",
          };
        }
        return {
          stdout: "ActiveState=inactive\nUnitFileState=\nResult=success\nNRestarts=0\n",
          stderr: "",
        };
      }),
    };
    const manager = createSystemdUserServiceManager({
      paths: xdgPaths(root),
      uid: process.getuid?.() ?? 0,
      home: join(root, "home"),
      executable: "/opt/homebrew/bin/bun",
      cliEntryPoint: join(root, "bin.ts"),
      runtimeEnvironment: {},
      runner,
    });

    await expect(manager.status()).resolves.toMatchObject({
      kind: "systemd",
      enabled: false,
      active: false,
      crashLoop: false,
    });
  });

  it("runs an installed build's own launcher, through the current link it was started from", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-installed-launcher-"));
    roots.push(root);
    const version = join(root, "install", "versions", "1.0.0");
    await mkdir(join(version, "bin"), { recursive: true });
    await writeFile(join(version, "octant-artifact.json"), "{}");
    await writeFile(join(version, "bin", "octant"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(version, "bin", "octant.mjs"), "");
    await symlink(version, join(root, "install", "current"));
    const runtimePaths = xdgPaths(root);
    const manager = createSystemdUserServiceManager({
      paths: runtimePaths,
      uid: process.getuid?.() ?? 0,
      home: join(root, "home"),
      cliEntryPoint: join(root, "install", "current", "bin", "octant.mjs"),
      runtimeEnvironment: {},
      runner: { run: vi.fn(async () => ({ stdout: "", stderr: "" })) },
    });

    await manager.install();

    const unit = await readFile(
      join(root, "home", ".config", "systemd", "user", "octant.service"),
      "utf8",
    );
    // The launcher starts the Bun the build carries; through `current`, an
    // upgrade's switch is what the next start runs.
    expect(unit).toContain(
      `ExecStart=${join(root, "install", "current", "bin", "octant")} server run`,
    );
  });

  it("uses the absolute CLI artifact when no executable or entrypoint is injected", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-default-cli-artifact-"));
    roots.push(root);
    const runtimePaths = xdgPaths(root);
    const runner: ServiceCommandRunner = {
      run: vi.fn(async () => ({ stdout: "", stderr: "" })),
    };
    const manager = createSystemdUserServiceManager({
      paths: runtimePaths,
      uid: process.getuid?.() ?? 0,
      home: join(root, "home"),
      runtimeEnvironment: {},
      runner,
    });

    await manager.install();

    const unit = await readFile(
      join(root, "home", ".config", "systemd", "user", "octant.service"),
      "utf8",
    );
    const cliEntryPoint = fileURLToPath(new URL("./bin.ts", import.meta.url));
    expect(unit).toContain(`ExecStart=${process.execPath} ${cliEntryPoint} server run`);
    expect(unit).toContain(`Environment=XDG_DATA_HOME=${dirname(runtimePaths.dataDirectory)}`);
    expect(unit).toContain(`Environment=XDG_CONFIG_HOME=${dirname(runtimePaths.configDirectory)}`);
    expect(unit).toContain(`Environment=XDG_STATE_HOME=${dirname(runtimePaths.stateDirectory)}`);
  });

  it("starts the app's own windowless host with no inherited environment when asked to", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-launchd-app-host-"));
    roots.push(root);
    const manager = createLaunchdUserServiceManager({
      paths: paths(root),
      uid: process.getuid?.() ?? 0,
      home: join(root, "home"),
      executable: "/Applications/Octant.app/Contents/MacOS/Octant",
      hostArguments: ["--octant-host-only"],
      runtimeEnvironment: { OCTANT_DATA_DIR: join(root, "data"), OCTANT_SERVER_PORT: "17777" },
      runner: { run: vi.fn(async () => ({ stdout: "", stderr: "" })) },
    });

    await manager.install();

    const descriptor = await readFile(
      join(root, "home", "Library", "LaunchAgents", "app.octant.server.plist"),
      "utf8",
    );
    expect(descriptor).toContain(
      "<array><string>/Applications/Octant.app/Contents/MacOS/Octant</string><string>--octant-host-only</string></array>",
    );
    expect(descriptor).toContain("<key>EnvironmentVariables</key><dict></dict>");
  });

  it("reports what is installed on disk and removes it on uninstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-launchd-uninstall-"));
    roots.push(root);
    const notLoaded = Object.assign(new Error("Command failed"), { code: 113 });
    const calls: Array<readonly string[]> = [];
    const options = {
      paths: paths(root),
      uid: process.getuid?.() ?? 0,
      home: join(root, "home"),
      executable: "/Applications/Octant.app/Contents/MacOS/Octant",
      hostArguments: ["--octant-host-only"],
      runner: {
        run: vi.fn(async (_command: string, args: readonly string[]) => {
          calls.push(args);
          if (args[0] === "print" || args[0] === "bootout") throw notLoaded;
          return { stdout: "", stderr: "" };
        }),
      },
    };
    await createLaunchdUserServiceManager(options).install();

    // A fresh manager, as after a restart, reads the descriptor from disk.
    const later = createLaunchdUserServiceManager(options);
    await expect(later.status()).resolves.toMatchObject({ installed: true });
    await later.uninstall();
    await expect(later.status()).resolves.toMatchObject({ installed: false, active: false });
    await expect(
      readFile(join(root, "home", "Library", "LaunchAgents", "app.octant.server.plist")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toContainEqual(["bootout", `gui/${process.getuid?.() ?? 0}/app.octant.server`]);
  });

  it("disables, removes and forgets the systemd unit on uninstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-systemd-uninstall-"));
    roots.push(root);
    const calls: Array<readonly string[]> = [];
    const manager = createSystemdUserServiceManager({
      paths: xdgPaths(root),
      uid: process.getuid?.() ?? 0,
      home: join(root, "home"),
      executable: "/opt/Octant/octant",
      hostArguments: ["--octant-host-only"],
      runner: {
        run: vi.fn(async (_command: string, args: readonly string[]) => {
          calls.push(args);
          return { stdout: "", stderr: "" };
        }),
      },
    });
    await manager.install();

    await manager.uninstall();

    await expect(
      readFile(join(root, "home", ".config", "systemd", "user", "octant.service")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls.slice(-2)).toEqual([
      ["--user", "--no-ask-password", "disable", "--now", "octant.service"],
      ["--user", "--no-ask-password", "daemon-reload"],
    ]);
  });
});

describe("the Windows per-user logon entry", () => {
  const systemRoot = "C:\\Windows";
  const reg = "C:\\Windows\\System32\\reg.exe";
  const taskkill = "C:\\Windows\\System32\\taskkill.exe";
  const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const logonCommand = [
    "C:\\Users\\Ada Lovelace\\.bun\\bin\\bun.exe",
    "C:\\Users\\Ada Lovelace\\octant\\packages\\cli\\src\\bin.ts",
    "server",
    "start",
  ];
  const host = {
    command: "C:\\Users\\Ada Lovelace\\.bun\\bin\\bun.exe",
    args: ["run", "--cwd", "C:\\Users\\Ada Lovelace\\octant\\apps\\server", "src/main.ts"],
    env: { OCTANT_HOST_SERVICE_MODE: "service" },
  };

  function fakeOwner(observations: Array<WindowsHostObservation>) {
    const requestStop = vi.fn(async () => true);
    return {
      requestStop,
      observe: vi.fn(async () => observations.shift() ?? { status: "absent" as const }),
    };
  }

  function manager(input: {
    readonly owner: WindowsHostOwnerPort;
    readonly run?: ServiceCommandRunner["run"];
    readonly spawn?: (spec: WindowsHostSpawnSpec) => { readonly running: () => boolean };
  }) {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawned: WindowsHostSpawnSpec[] = [];
    const created = createWindowsUserServiceManager({
      systemRoot,
      logonCommand,
      host: () => host,
      owner: input.owner,
      logs: async () => ({ entries: [], follow: false }),
      sleep: async () => undefined,
      runner: {
        run: async (command, args) => {
          calls.push({ command, args });
          return input.run === undefined ? { stdout: "", stderr: "" } : input.run(command, args);
        },
      },
      spawn: (spec) => {
        spawned.push(spec);
        return input.spawn?.(spec) ?? { running: () => true };
      },
    });
    return { created, calls, spawned };
  }

  it("quotes each argument so Windows hands it back unchanged", () => {
    expect(
      quoteWindowsCommandLine([
        "C:\\Program Files\\Octant\\bun.exe",
        "C:\\trailing slash\\",
        "plain",
        'say "hi"',
        "",
      ]),
    ).toBe(
      '"C:\\Program Files\\Octant\\bun.exe" "C:\\trailing slash\\\\" "plain" "say \\"hi\\"" ""',
    );
  });

  it("records the CLI's own `server start` under the current user's Run key, with no shell", async () => {
    const { created, calls } = manager({ owner: fakeOwner([]) });

    await created.install();

    expect(calls).toEqual([
      {
        command: reg,
        args: [
          "add",
          runKey,
          "/v",
          "Octant",
          "/t",
          "REG_SZ",
          "/d",
          '"C:\\Users\\Ada Lovelace\\.bun\\bin\\bun.exe" "C:\\Users\\Ada Lovelace\\octant\\packages\\cli\\src\\bin.ts" "server" "start"',
          "/f",
        ],
      },
    ]);
  });

  it("refuses a logon command that is relative or carries a quote", () => {
    for (const command of [
      ["bun.exe", "server", "start"],
      ["C:\\bun.exe", 'C:\\a"b\\bin.ts', "server", "start"],
    ]) {
      expect(() =>
        createWindowsUserServiceManager({
          systemRoot,
          logonCommand: command,
          host: () => host,
          owner: fakeOwner([]),
          logs: async () => ({ entries: [], follow: false }),
        }),
      ).toThrow(expect.objectContaining({ code: "unsafe-descriptor" }));
    }
  });

  it("reports the Run value and the authenticated owner as installed and active", async () => {
    const { created } = manager({
      owner: fakeOwner([{ status: "running", pid: 4242 }]),
      run: async () => ({
        stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Octant    REG_SZ    "C:\\bun.exe" "server" "start"\r\n\r\n`,
        stderr: "",
      }),
    });

    await expect(created.status()).resolves.toEqual({
      kind: "run-key",
      installed: true,
      enabled: true,
      active: true,
      session: "active",
      lingering: "unknown",
    });
  });

  it("reports a missing Run value as not installed rather than a manager failure", async () => {
    const { created } = manager({
      owner: fakeOwner([{ status: "absent" }]),
      run: async () => {
        throw Object.assign(new Error("ERROR: The system was unable to find the value."), {
          code: 1,
        });
      },
    });

    await expect(created.status()).resolves.toMatchObject({
      kind: "run-key",
      installed: false,
      enabled: false,
      active: false,
    });
  });

  it("starts the host hidden and detached, and returns once its owner answers", async () => {
    const owner = fakeOwner([
      { status: "absent" },
      { status: "unanswered" },
      { status: "running", pid: 7 },
    ]);
    const { created, spawned } = manager({ owner });

    await created.start();

    expect(spawned).toEqual([host]);
    expect(owner.observe).toHaveBeenCalledTimes(3);
  });

  it("starts nothing when an owner already answers", async () => {
    const { created, spawned } = manager({ owner: fakeOwner([{ status: "running", pid: 7 }]) });

    await created.start();

    expect(spawned).toEqual([]);
  });

  it("fails a start whose host exits before it claims ownership", async () => {
    const { created } = manager({
      owner: fakeOwner([{ status: "absent" }, { status: "absent" }]),
      spawn: () => ({ running: () => false }),
    });

    await expect(created.start()).rejects.toMatchObject({ code: "manager-failed" });
  });

  it("asks the owner to stop and leaves a host that exits on its own untouched", async () => {
    const owner = fakeOwner([
      { status: "running", pid: 31 },
      { status: "running", pid: 31 },
    ]);
    const { created, calls } = manager({ owner });

    await created.stop();

    expect(owner.requestStop).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("ends the whole process tree of an owner that outlives its graceful stop", async () => {
    const observations: WindowsHostObservation[] = Array.from({ length: 50 }, () => ({
      status: "running" as const,
      pid: 31,
    }));
    const owner = fakeOwner(observations);
    const { created, calls } = manager({
      owner,
      run: async () => {
        observations.splice(0);
        return { stdout: "", stderr: "" };
      },
    });

    await created.stop();

    expect(calls).toEqual([{ command: taskkill, args: ["/PID", "31", "/T", "/F"] }]);
  });

  it("never force-stops a host whose owner it could not authenticate", async () => {
    const { created, calls } = manager({
      owner: fakeOwner(Array.from({ length: 80 }, () => ({ status: "unanswered" as const }))),
    });

    await expect(created.stop()).rejects.toMatchObject({ code: "manager-failed" });
    expect(calls).toEqual([]);
  });

  it("stops the host and removes the Run value on uninstall, even when the value is absent", async () => {
    const owner = fakeOwner([{ status: "absent" }]);
    const { created, calls } = manager({
      owner,
      run: async () => {
        throw Object.assign(new Error("ERROR: The system was unable to find the value."), {
          code: 1,
        });
      },
    });

    await created.uninstall();

    expect(calls).toEqual([{ command: reg, args: ["delete", runKey, "/v", "Octant", "/f"] }]);
  });
});
