import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHostRuntimePaths } from "@octant/host-runtime";
import {
  createLaunchdUserServiceManager,
  createSystemdUserServiceManager,
  type ServiceCommandRunner,
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
