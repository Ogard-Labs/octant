import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface ManagedDeviceToolLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

/** Native streaming needs device services and loopback, never a Project or provider account. */
export function confineManagedDeviceTool(input: {
  readonly tool: "serve-sim" | "serve-avd";
  readonly runtime: string;
  readonly entrypoint: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly stateDirectory: string;
  readonly platform?: NodeJS.Platform;
}): ManagedDeviceToolLaunch | undefined {
  try {
    const platform = input.platform ?? process.platform;
    const home = canonical(input.environment.HOME ?? homedir());
    const state = canonical(input.stateDirectory);
    const toolRoot = canonical(dirname(dirname(input.entrypoint)));
    const runtimeRoot = canonical(dirname(input.runtime));
    const sdk =
      input.tool === "serve-avd"
        ? [
            input.environment.ANDROID_HOME,
            input.environment.ANDROID_SDK_ROOT,
            join(home, "Library", "Android", "sdk"),
            join(home, "Android", "Sdk"),
            join(home, "android-sdk"),
          ].filter((path): path is string => path !== undefined && existsSync(path))
        : [];
    const deviceRoots =
      input.tool === "serve-sim"
        ? [join(home, "Library", "Developer", "CoreSimulator")]
        : [input.environment.ANDROID_USER_HOME ?? join(home, ".android")];
    const readRoots = [
      toolRoot,
      runtimeRoot,
      ...sdk,
      ...deviceRoots,
      ...(input.tool === "serve-avd" ? [join(home, ".emulator_console_auth_token")] : []),
    ].map(canonical);
    const writeRoots = [state, ...deviceRoots.filter(existsSync).map(canonical)];
    // A configured SDK/runtime symlink must not turn a device grant into the home or root.
    if (
      [state, ...readRoots, ...writeRoots].some(
        (path) =>
          !isAbsolute(path) ||
          resolve(path) !== path ||
          path === sep ||
          path === home ||
          home.startsWith(`${path}${sep}`),
      )
    )
      return undefined;
    const env: NodeJS.ProcessEnv = { ...input.environment, TMPDIR: state, TMP: state, TEMP: state };
    // The Linux capsule mounts canonical paths; the helper must name those
    // same locations when a configured SDK or device-state folder is a link.
    if (input.tool === "serve-avd") {
      for (const key of ["ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_USER_HOME"]) {
        const path = env[key];
        if (path !== undefined) env[key] = canonical(path);
      }
    }
    if (platform === "darwin") {
      const sandbox = "/usr/bin/sandbox-exec";
      accessSync(sandbox, constants.X_OK);
      const quoted = (path: string) => JSON.stringify(path);
      const reads = [
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/Library/Developer",
        "/Library/Apple",
        "/Library/Frameworks",
        "/Applications",
        "/opt",
        "/dev",
        "/private/etc",
        "/private/var/db/dyld",
        ...readRoots,
        state,
      ];
      const profile = [
        "(version 1)",
        "(deny default)",
        '(import "system.sb")',
        "(allow process-fork)",
        "(allow process-exec)",
        "(allow sysctl-read)",
        "(allow signal (target children))",
        '(allow file-read-metadata (literal "/private/var/select/sh"))',
        ...[...new Set([...readRoots, ...writeRoots].flatMap(ancestors))].map(
          (path) => `(allow file-read-metadata (literal ${quoted(path)}))`,
        ),
        '(allow network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*"))',
        '(allow network-bind (local ip "localhost:*"))',
        ...reads.map((path) => `(allow file-read* (subpath ${quoted(path)}))`),
        ...writeRoots.map((path) => `(allow file-write* (subpath ${quoted(path)}))`),
        '(allow file-write* (literal "/dev/null"))',
        ...(input.tool === "serve-sim"
          ? [
              '(allow mach-lookup (global-name-prefix "com.apple.CoreSimulator."))',
              '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
              '(allow file-read* (subpath "/private/var/run/com.apple.CoreSimulator"))',
              '(allow file-read* (subpath "/private/var/run/com.apple.security.cryptexd/mnt"))',
            ]
          : []),
      ].join("\n");
      return {
        command: sandbox,
        args: ["-p", profile, "--", input.runtime, input.entrypoint, ...input.args],
        env,
        cwd: state,
      };
    }
    if (platform === "linux") {
      const bwrap = "/usr/bin/bwrap";
      accessSync(bwrap, constants.X_OK);
      const args = [
        "--die-with-parent",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-uts",
        "--unshare-ipc",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
      ];
      // Keep the host network for the existing adb server and browser listeners.
      // Bubblewrap does not enforce the macOS loopback-only network boundary.
      for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", ...readRoots])
        if (existsSync(path)) args.push("--ro-bind", path, path);
      for (const path of writeRoots) args.push("--bind", path, path);
      args.push("--chdir", state, "--", input.runtime, input.entrypoint, ...input.args);
      return { command: bwrap, args, env, cwd: state };
    }
    return undefined;
  } catch {
    // Missing native sandbox support never launches the npm tool unconfined.
    return undefined;
  }
}

function ancestors(path: string): ReadonlyArray<string> {
  const paths: string[] = [];
  for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent))
    paths.push(parent);
  return paths;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
