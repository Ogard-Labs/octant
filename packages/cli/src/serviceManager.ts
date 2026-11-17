import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { HostRuntimePaths, HostLogReadResult, HostLogReadOptions } from "@octant/host-runtime";
import {
  BoundedHostLogStore,
  isWindowsSystemRoot,
  windowsLogonEntryPresent,
  WINDOWS_LOGON_ENTRY_KEY as WINDOWS_RUN_KEY,
  WINDOWS_LOGON_ENTRY_VALUE as WINDOWS_RUN_VALUE,
} from "@octant/host-runtime";

const execFileAsync = promisify(execFile);
const LAUNCHD_LABEL = "app.octant.server";
const SYSTEMD_UNIT = "octant.service";

export type ServiceManagerKind = "launchd" | "systemd" | "run-key";
export type ServiceSessionState = "active" | "logged-out" | "unknown";
export type ServiceLingeringState = "enabled" | "disabled" | "unknown";
export type ManagedOwnerState =
  | "none"
  | "starting"
  | "ready"
  | "degraded"
  | "incompatible"
  | "unauthorized";

export interface UserServiceStatus {
  readonly kind: ServiceManagerKind;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly session: ServiceSessionState;
  readonly lingering: ServiceLingeringState;
  readonly ownerState?: ManagedOwnerState;
  readonly restartFailures?: number;
  readonly crashLoop?: boolean;
}

export interface UserServiceManager {
  readonly kind: ServiceManagerKind;
  install(): Promise<void>;
  /** Stops the service and removes its descriptor; a service that is absent is left absent. */
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  status(): Promise<UserServiceStatus>;
  logs(options?: HostLogReadOptions): Promise<HostLogReadResult>;
}

export class ServiceManagerError extends Error {
  readonly code: "manager-unavailable" | "manager-failed" | "unsafe-descriptor";

  constructor(code: ServiceManagerError["code"], message: string) {
    super(message);
    this.name = "ServiceManagerError";
    this.code = code;
  }
}

export interface ServiceCommandRunner {
  run(
    command: string,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export interface UserServiceManagerOptions {
  readonly paths: HostRuntimePaths;
  readonly uid: number;
  readonly home?: string;
  readonly executable?: string;
  /** The script/module passed to a runtime-hosted CLI such as Bun. */
  readonly cliEntryPoint?: string;
  /** Non-secret environment inherited by the foreground host runtime. */
  readonly runtimeEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceCommandRunner;
  readonly platform?: NodeJS.Platform;
  /**
   * Runs `executable` with exactly these arguments instead of the CLI's
   * `server run`, and passes no environment. The desktop app uses this to
   * start its own host without a window: the app resolves its own paths the
   * way it does when a person opens it.
   */
  readonly hostArguments?: readonly string[];
}

export function createUserServiceManager(options: UserServiceManagerOptions): UserServiceManager {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return createLaunchdUserServiceManager(options);
  if (platform === "linux") return createSystemdUserServiceManager(options);
  throw new ServiceManagerError(
    "manager-unavailable",
    "Octant has no service manager for this platform.",
  );
}

export function createLaunchdUserServiceManager(
  options: UserServiceManagerOptions,
): UserServiceManager {
  const runner = options.runner ?? nodeServiceCommandRunner;
  const home = options.home ?? homedir();
  const descriptorPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const invocation = resolveServiceInvocation(options);
  const logStore = new BoundedHostLogStore({ path: options.paths.serviceLogPath });
  let installed = false;
  let enabled = false;

  return {
    kind: "launchd",
    install: async () => {
      const descriptor = launchdDescriptor(invocation);
      await mkdir(dirname(descriptorPath), { recursive: true, mode: 0o700 });
      await writePrivateDescriptor(descriptorPath, descriptor, options.uid);
      installed = true;
      try {
        await runner.run("/bin/launchctl", ["bootstrap", `gui/${options.uid}`, descriptorPath]);
      } catch (error) {
        if (!isAlreadyLoaded(error)) throw mapManagerError(error, "launchctl");
      }
    },
    uninstall: async () => {
      try {
        await runner.run("/bin/launchctl", ["bootout", `gui/${options.uid}/${LAUNCHD_LABEL}`]);
      } catch (error) {
        // launchctl exits 3 or 113 for a label it has not loaded, which is
        // the state uninstall wants.
        if (!isExpectedExit(error, [3, 113])) throw mapManagerError(error, "launchctl");
      }
      await rm(descriptorPath, { force: true });
      installed = false;
      enabled = false;
    },
    start: async () => {
      await runManagerCommand(runner, "/bin/launchctl", [
        "kickstart",
        `gui/${options.uid}/${LAUNCHD_LABEL}`,
      ]);
    },
    stop: async () => {
      await runManagerCommand(runner, "/bin/launchctl", [
        "kill",
        "SIGTERM",
        `gui/${options.uid}/${LAUNCHD_LABEL}`,
      ]);
    },
    enable: async () => {
      await runManagerCommand(runner, "/bin/launchctl", [
        "enable",
        `gui/${options.uid}/${LAUNCHD_LABEL}`,
      ]);
      enabled = true;
    },
    disable: async () => {
      await runManagerCommand(runner, "/bin/launchctl", [
        "disable",
        `gui/${options.uid}/${LAUNCHD_LABEL}`,
      ]);
      enabled = false;
    },
    status: async () => {
      const result = await runManagerStatusCommand(
        runner,
        "/bin/launchctl",
        ["print", `gui/${options.uid}/${LAUNCHD_LABEL}`],
        [3, 113],
      );
      // The descriptor on disk is what a login reads, so it decides whether
      // the service is installed, whatever this process did earlier.
      installed = await descriptorExists(descriptorPath);
      if (result === undefined) {
        return {
          kind: "launchd",
          installed,
          enabled,
          active: false,
          session: "active",
          lingering: "unknown",
        };
      }
      return {
        kind: "launchd",
        installed,
        enabled,
        active: /\bstate\s*=\s*running\b/i.test(result.stdout),
        session: "active",
        lingering: "unknown",
        crashLoop: /\blast exit code\s*=\s*[1-9]\d*\b/i.test(result.stdout),
      };
    },
    logs: (readOptions) => logStore.read(readOptions),
  };
}

export function createSystemdUserServiceManager(
  options: UserServiceManagerOptions,
): UserServiceManager {
  const runner = options.runner ?? nodeServiceCommandRunner;
  const home = options.home ?? homedir();
  const unitPath = join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
  const invocation = resolveServiceInvocation(options);
  const logStore = new BoundedHostLogStore({ path: options.paths.serviceLogPath });
  let installed = false;

  const runSystemctl = (args: readonly string[]) =>
    runManagerCommand(runner, "/usr/bin/systemctl", ["--user", "--no-ask-password", ...args]);
  const runSystemctlStatus = (args: readonly string[], expectedExitCodes: readonly number[]) =>
    runManagerStatusCommand(
      runner,
      "/usr/bin/systemctl",
      ["--user", "--no-ask-password", ...args],
      expectedExitCodes,
    );

  return {
    kind: "systemd",
    install: async () => {
      await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
      await writePrivateDescriptor(unitPath, systemdUnit(invocation), options.uid);
      installed = true;
      await runSystemctl(["daemon-reload"]);
    },
    uninstall: async () => {
      // `disable --now` on a unit systemd does not know exits 1 or 5; either
      // way nothing is left running or enabled.
      await runSystemctlStatus(["disable", "--now", SYSTEMD_UNIT], [1, 5]);
      await rm(unitPath, { force: true });
      installed = false;
      await runSystemctl(["daemon-reload"]);
    },
    start: () => runSystemctl(["start", SYSTEMD_UNIT]).then(() => undefined),
    stop: () => runSystemctl(["stop", SYSTEMD_UNIT]).then(() => undefined),
    enable: () => runSystemctl(["enable", SYSTEMD_UNIT]).then(() => undefined),
    disable: () => runSystemctl(["disable", SYSTEMD_UNIT]).then(() => undefined),
    status: async () => {
      installed = await descriptorExists(unitPath);
      try {
        const [activeResult, enabledResult, session, lingering] = await Promise.all([
          // Exit 4 is systemd's "no such unit": the unit is not installed yet,
          // which is stopped and disabled, not a manager failure.
          runSystemctlStatus(["is-active", SYSTEMD_UNIT], [3, 4]),
          runSystemctlStatus(["is-enabled", SYSTEMD_UNIT], [1, 4, 5]),
          runner
            .run("/usr/bin/loginctl", [
              "show-user",
              String(options.uid),
              "--property=State",
              "--value",
            ])
            .catch(() => ({ stdout: "", stderr: "" })),
          runner
            .run("/usr/bin/loginctl", [
              "show-user",
              String(options.uid),
              "--property=Linger",
              "--value",
            ])
            .catch(() => ({ stdout: "", stderr: "" })),
        ]);
        const detailsResult = await runSystemctlStatus(
          ["show", SYSTEMD_UNIT, "--property=ActiveState,UnitFileState,NRestarts,Result"],
          [1, 5],
        );
        const properties = parseSystemdProperties(detailsResult?.stdout ?? "");
        const restartFailures = Number(properties.NRestarts ?? "0");
        const sessionState = session.stdout.trim();
        const lingeringState = lingering.stdout.trim();
        return {
          kind: "systemd",
          installed,
          enabled: enabledResult !== undefined,
          active: activeResult !== undefined,
          session:
            sessionState === ""
              ? "unknown"
              : /active/i.test(sessionState)
                ? "active"
                : "logged-out",
          lingering:
            lingeringState === ""
              ? "unknown"
              : /^yes\s*$/i.test(lingeringState)
                ? "enabled"
                : "disabled",
          ...(Number.isSafeInteger(restartFailures) && restartFailures > 0
            ? { restartFailures }
            : {}),
          crashLoop:
            Number.isSafeInteger(restartFailures) && restartFailures >= 5
              ? true
              : properties.Result === "failed" && activeResult === undefined,
        };
      } catch (error) {
        if (error instanceof ServiceManagerError) throw error;
        throw mapManagerError(error, "systemctl");
      }
    },
    logs: (readOptions) => logStore.read(readOptions),
  };
}

interface ServiceInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

function resolveServiceInvocation(options: UserServiceManagerOptions): ServiceInvocation {
  const command = options.executable ?? process.execPath;
  const runtimeEntryPoint =
    options.cliEntryPoint ??
    (options.executable === undefined ? resolveCurrentCliEntryPoint() : undefined);
  const args =
    options.hostArguments ??
    (runtimeEntryPoint === undefined ? ["server", "run"] : [runtimeEntryPoint, "server", "run"]);
  const environment = options.hostArguments === undefined ? resolveServiceEnvironment(options) : {};
  if (!isAbsolute(command)) {
    throw new ServiceManagerError(
      "unsafe-descriptor",
      "Managed service runtime must be an absolute executable path.",
    );
  }
  if (runtimeEntryPoint !== undefined && !isAbsolute(runtimeEntryPoint)) {
    throw new ServiceManagerError(
      "unsafe-descriptor",
      "Managed service CLI entrypoint must be an absolute path.",
    );
  }
  assertSafeDescriptorValue(command);
  for (const argument of args) assertSafeDescriptorValue(argument);
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new ServiceManagerError("unsafe-descriptor", "Service environment key is unsafe.");
    }
    assertSafeDescriptorValue(value);
  }
  return { command, args, environment };
}

export function resolveCurrentCliEntryPoint(): string {
  const current = process.argv[1];
  if (current !== undefined && isAbsolute(current)) {
    // Windows hands the entry point over with backslashes.
    const filename = current.split(/[\\/]/).pop() ?? "";
    if (/^(?:bin\.(?:ts|js|mjs)|octant)$/.test(filename)) return current;
  }
  return fileURLToPath(new URL("./bin.ts", import.meta.url));
}

function resolveServiceEnvironment(
  options: UserServiceManagerOptions,
): Readonly<Record<string, string>> {
  const source = options.runtimeEnvironment ?? process.env;
  const environment: Record<string, string> = {
    OCTANT_HOST_SERVICE_MODE: "service",
  };

  // The service must inherit the same path authority as the foreground CLI.
  // Explicit data roots are canonical; non-default Linux XDG roots are kept
  // when they are the source of config/state paths. The socket path remains
  // deterministic from the persisted data root and uid.
  const dataBackedPaths =
    options.paths.platform === "darwin" ||
    (options.paths.configDirectory === join(options.paths.dataDirectory, "config") &&
      options.paths.stateDirectory === join(options.paths.dataDirectory, "state"));
  if (source.OCTANT_DATA_DIR !== undefined || dataBackedPaths) {
    environment.OCTANT_DATA_DIR = options.paths.dataDirectory;
  } else {
    environment.XDG_DATA_HOME = dirname(options.paths.dataDirectory);
    environment.XDG_CONFIG_HOME = dirname(options.paths.configDirectory);
    environment.XDG_STATE_HOME = dirname(options.paths.stateDirectory);
  }

  for (const key of [
    "OCTANT_SERVER_PORT",
    "OCTANT_PACKAGED_RUNTIME",
    "OCTANT_CODE_FILE_HELPER_PATH",
    "OCTANT_SANDBOX_SCOPE_PATH",
  ] as const) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function launchdDescriptor(invocation: ServiceInvocation): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    "<key>ProgramArguments</key><array>",
    `<string>${escapeXml(invocation.command)}</string>${invocation.args
      .map((argument) => `<string>${escapeXml(argument)}</string>`)
      .join("")}`,
    "</array>",
    `<key>EnvironmentVariables</key><dict>${Object.entries(invocation.environment)
      .map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
      .join("")}</dict>`,
    "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "<key>ThrottleInterval</key><integer>30</integer>",
    "<key>RunAtLoad</key><true/>",
    "</dict></plist>\n",
  ].join("");
}

function systemdUnit(invocation: ServiceInvocation): string {
  return [
    "[Unit]",
    "Description=Octant per-user host service",
    "After=default.target",
    "StartLimitIntervalSec=60s",
    "StartLimitBurst=5",
    "",
    "[Service]",
    `ExecStart=${[invocation.command, ...invocation.args].map(systemdQuote).join(" ")}`,
    ...Object.entries(invocation.environment).map(
      ([key, value]) => `Environment=${key}=${systemdQuote(value)}`,
    ),
    "Restart=on-failure",
    "RestartSec=1s",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function assertSafeDescriptorValue(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    /(?:secret|token|password|credential|authorization|api[_-]?key)/i.test(value)
  ) {
    throw new ServiceManagerError(
      "unsafe-descriptor",
      "Service descriptor contains unsafe authority material.",
    );
  }
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character] ?? character,
  );
}

function systemdQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseSystemdProperties(output: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return properties;
}

export const nodeServiceCommandRunner: ServiceCommandRunner = {
  run: async (command, args) => {
    try {
      return await execFileAsync(command, [...args], {
        shell: false,
        timeout: 5_000,
        maxBuffer: 64 * 1_024,
        env: { ...process.env, LC_ALL: "C" },
      });
    } catch (error) {
      if (isCommandUnavailable(error)) throw managerUnavailable(command);
      throw error;
    }
  },
};

function managerUnavailable(command: string): ServiceManagerError {
  return new ServiceManagerError(
    "manager-unavailable",
    `The per-user ${command} manager is unavailable.`,
  );
}

async function writePrivateDescriptor(path: string, contents: string, uid: number): Promise<void> {
  try {
    const existing = await lstat(path);
    if (
      existing.isSymbolicLink() ||
      !existing.isFile() ||
      existing.uid !== uid ||
      (existing.mode & 0o077) !== 0
    ) {
      throw new ServiceManagerError("unsafe-descriptor", "Existing service descriptor is unsafe.");
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function isCommandUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { readonly code?: unknown }).code === "ENOENT" ||
      (error as { readonly code?: unknown }).code === "ENOTSUP")
  );
}

async function runManagerCommand(
  runner: ServiceCommandRunner,
  command: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  try {
    return await runner.run(command, args);
  } catch (error) {
    throw mapManagerError(error, command);
  }
}

async function runManagerStatusCommand(
  runner: ServiceCommandRunner,
  command: string,
  args: readonly string[],
  expectedExitCodes: readonly number[],
): Promise<{ readonly stdout: string; readonly stderr: string } | undefined> {
  try {
    return await runner.run(command, args);
  } catch (error) {
    if (error instanceof ServiceManagerError) throw error;
    if (isCommandUnavailable(error)) throw managerUnavailable(command);
    if (isExpectedExit(error, expectedExitCodes)) return undefined;
    throw mapManagerError(error, command);
  }
}

function mapManagerError(error: unknown, command: string): ServiceManagerError {
  if (error instanceof ServiceManagerError) return error;
  if (isCommandUnavailable(error)) return managerUnavailable(command);
  return new ServiceManagerError(
    "manager-failed",
    `The per-user ${command} manager command failed.`,
  );
}

function isExpectedExit(error: unknown, expectedExitCodes: readonly number[]): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { readonly code?: unknown; readonly status?: unknown };
  const code = typeof record.code === "number" ? record.code : record.status;
  return typeof code === "number" && expectedExitCodes.includes(code);
}

function isAlreadyLoaded(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { readonly message?: unknown; readonly stderr?: unknown };
  const text = `${typeof record.message === "string" ? record.message : ""} ${typeof record.stderr === "string" ? record.stderr : ""}`;
  return /already\s+(?:bootstrapped|loaded)|service\s+already\s+loaded/i.test(text);
}

async function descriptorExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

const WINDOWS_POLL_MS = 250;
const WINDOWS_START_ATTEMPTS = 120;
const WINDOWS_GRACEFUL_STOP_ATTEMPTS = 40;
const WINDOWS_FORCED_STOP_ATTEMPTS = 20;

/**
 * What the native owner lookup proves about the host. `running` carries the
 * process ID only after the owner answered an authenticated status request
 * whose PID and process birth match its native record; `unanswered` is a
 * record whose pipe did not answer, which may be a host still starting or
 * exiting.
 */
export type WindowsHostObservation =
  | { readonly status: "running"; readonly pid: number }
  | { readonly status: "absent" }
  | { readonly status: "unanswered" };

export interface WindowsHostOwnerPort {
  observe(): Promise<WindowsHostObservation>;
  /** Sends the authenticated graceful stop; false when no owner accepted it. */
  requestStop(): Promise<boolean>;
}

export interface WindowsHostSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface WindowsUserServiceManagerOptions {
  /** The Windows folder; reg.exe and taskkill.exe run from its System32 by absolute path. */
  readonly systemRoot: string;
  /** The CLI's own `server start`, as an absolute executable and its arguments. */
  readonly logonCommand: readonly string[];
  /** The host process a start launches; called once per start for a fresh instance. */
  readonly host: () => WindowsHostSpawnSpec;
  readonly owner: WindowsHostOwnerPort;
  readonly logs: (options?: HostLogReadOptions) => Promise<HostLogReadResult>;
  readonly runner?: ServiceCommandRunner;
  readonly spawn?: (spec: WindowsHostSpawnSpec) => { readonly running: () => boolean };
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * The per-user logon entry: a value under the current user's Run key that
 * runs the CLI's own `server start` at sign-in. Writing it needs no
 * administrator rights. Start launches the host directly, hidden and
 * detached; stop asks the authenticated owner to stop and ends its whole
 * process tree only when it outlives that request.
 */
export function createWindowsUserServiceManager(
  options: WindowsUserServiceManagerOptions,
): UserServiceManager {
  const runner = options.runner ?? nodeServiceCommandRunner;
  const spawnHost = options.spawn ?? spawnDetachedWindowsHost;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const system32 = windowsSystem32(options.systemRoot);
  const reg = win32.join(system32, "reg.exe");
  const taskkill = win32.join(system32, "taskkill.exe");
  const [executable] = options.logonCommand;
  if (executable === undefined || !win32.isAbsolute(executable)) {
    throw new ServiceManagerError(
      "unsafe-descriptor",
      "The logon entry must name an absolute executable path.",
    );
  }
  for (const argument of options.logonCommand) {
    assertSafeDescriptorValue(argument);
    // A Windows path never contains a quote, so one here is not a path.
    if (argument.includes('"')) {
      throw new ServiceManagerError("unsafe-descriptor", "The logon entry contains a quote.");
    }
  }
  const commandLine = quoteWindowsCommandLine(options.logonCommand);

  const writeRunValue = () =>
    runManagerCommand(runner, reg, [
      "add",
      WINDOWS_RUN_KEY,
      "/v",
      WINDOWS_RUN_VALUE,
      "/t",
      "REG_SZ",
      "/d",
      commandLine,
      "/f",
    ]).then(() => undefined);
  // reg.exe exits 1 when the value is absent, which is the state removal wants.
  const removeRunValue = () =>
    runManagerStatusCommand(
      runner,
      reg,
      ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"],
      [1],
    ).then(() => undefined);

  const stop = async (): Promise<void> => {
    const first = await options.owner.observe();
    if (first.status === "absent") return;
    await options.owner.requestStop();
    for (let attempt = 0; attempt < WINDOWS_GRACEFUL_STOP_ATTEMPTS; attempt += 1) {
      await sleep(WINDOWS_POLL_MS);
      if ((await options.owner.observe()).status === "absent") return;
    }
    // Only a PID the owner itself just authenticated is ever ended, and it
    // is read again right before the call so a stale one is not reused.
    const remaining = await options.owner.observe();
    if (remaining.status === "absent") return;
    if (remaining.status !== "running") {
      throw new ServiceManagerError(
        "manager-failed",
        "The Octant host did not stop and its owner could not be authenticated.",
      );
    }
    await runManagerCommand(runner, taskkill, ["/PID", String(remaining.pid), "/T", "/F"]);
    for (let attempt = 0; attempt < WINDOWS_FORCED_STOP_ATTEMPTS; attempt += 1) {
      if ((await options.owner.observe()).status === "absent") return;
      await sleep(WINDOWS_POLL_MS);
    }
    throw new ServiceManagerError("manager-failed", "The Octant host process tree did not end.");
  };

  return {
    kind: "run-key",
    install: writeRunValue,
    uninstall: async () => {
      await stop();
      await removeRunValue();
    },
    start: async () => {
      if ((await options.owner.observe()).status !== "absent") return;
      const child = spawnHost(options.host());
      for (let attempt = 0; attempt < WINDOWS_START_ATTEMPTS; attempt += 1) {
        await sleep(WINDOWS_POLL_MS);
        if ((await options.owner.observe()).status === "running") return;
        if (!child.running()) {
          throw new ServiceManagerError(
            "manager-failed",
            "The Octant host exited before it was ready; `octant server logs` has its record.",
          );
        }
      }
      // Still starting: the lifecycle command reports it as starting.
    },
    stop,
    enable: writeRunValue,
    disable: removeRunValue,
    status: async () => {
      const [value, observation] = await Promise.all([
        runManagerStatusCommand(
          runner,
          reg,
          ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE],
          [1],
        ),
        options.owner.observe(),
      ]);
      const installed = value !== undefined && windowsLogonEntryPresent(value.stdout);
      return {
        kind: "run-key",
        installed,
        enabled: installed,
        active: observation.status !== "absent",
        session: "active",
        lingering: "unknown",
      };
    },
    logs: (readOptions) => options.logs(readOptions),
  };
}

/**
 * One command line that Windows' standard argument parsing splits back into
 * exactly these arguments: each is quoted, a quote is escaped, and the
 * backslashes before a quote or the closing quote are doubled.
 */
export function quoteWindowsCommandLine(args: readonly string[]): string {
  return args
    .map((argument) => {
      let quoted = '"';
      let backslashes = 0;
      for (const character of argument) {
        if (character === "\\") {
          backslashes += 1;
          continue;
        }
        if (character === '"') {
          quoted += "\\".repeat(backslashes * 2 + 1) + '"';
        } else {
          quoted += "\\".repeat(backslashes) + character;
        }
        backslashes = 0;
      }
      return `${quoted}${"\\".repeat(backslashes * 2)}"`;
    })
    .join(" ");
}

export { isWindowsSystemRoot };

/** The System32 folder of a drive-absolute Windows folder, or a refusal. */
export function windowsSystem32(systemRoot: string): string {
  if (!isWindowsSystemRoot(systemRoot)) {
    throw new ServiceManagerError(
      "manager-unavailable",
      "The Windows system folder is not a drive-absolute path.",
    );
  }
  return win32.join(systemRoot, "System32");
}

function spawnDetachedWindowsHost(spec: WindowsHostSpawnSpec): { readonly running: () => boolean } {
  const child = spawn(spec.command, [...spec.args], {
    detached: true,
    env: spec.env,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  let running = true;
  child.once("exit", () => {
    running = false;
  });
  child.once("error", () => {
    running = false;
  });
  child.unref();
  return { running: () => running };
}

const LAUNCH_DAEMON_PATH = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;

export interface HubBootServiceOptions extends UserServiceManagerOptions {
  /** The account the server runs as; the hub always serves as the person, never as root. */
  readonly userName: string;
  /** Where to look for an installed launch daemon; tests point it away from the real system. */
  readonly launchDaemonProbePath?: string;
}

/**
 * What it takes to make the server start with no one logged in. The CLI never
 * runs the administrator step on its own: it prints `administratorCommand`, or
 * runs it only when the person asked for that.
 */
export interface HubBootServicePlan {
  readonly kind: "launch-daemon" | "lingering-user-unit";
  /** The service description a launch daemon is installed from; absent for a user unit. */
  readonly descriptor?: string;
  /** The one command that needs administrator approval, as an argument list. */
  readonly administratorCommand: readonly string[];
  /** Whether the ordinary user service must be installed and enabled after the administrator step. */
  readonly userServiceFollowUp: "none" | "install-and-enable";
}

export interface HubBootService {
  readonly kind: HubBootServicePlan["kind"];
  /** Installing: the hub comes back after a restart with no one logged in. */
  installPlan(): HubBootServicePlan;
  /** Returning to the ordinary login service. */
  removalPlan(): HubBootServicePlan;
  /** Whether the machine currently starts the server at boot for the hub. */
  installed(): Promise<boolean>;
}

export function createHubBootService(options: HubBootServiceOptions): HubBootService {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? nodeServiceCommandRunner;
  assertSafeUserName(options.userName);
  if (platform === "darwin") {
    const home = options.home ?? homedir();
    const invocation = resolveServiceInvocation(options);
    return {
      kind: "launch-daemon",
      installPlan: () => {
        assertSafeDescriptorValue(home);
        const descriptor = launchDaemonDescriptor(
          // A daemon starts with no HOME of its own, and the server derives its
          // folders from it.
          { ...invocation, environment: { HOME: home, ...invocation.environment } },
          options.userName,
        );
        const encoded = Buffer.from(descriptor, "utf8").toString("base64");
        return {
          kind: "launch-daemon",
          descriptor,
          administratorCommand: [
            "/usr/bin/sudo",
            "/bin/sh",
            "-c",
            [
              `printf %s ${shellQuote(encoded)} | /usr/bin/base64 -D > ${LAUNCH_DAEMON_PATH}`,
              `/usr/sbin/chown root:wheel ${LAUNCH_DAEMON_PATH}`,
              `/bin/chmod 644 ${LAUNCH_DAEMON_PATH}`,
              // The login agent runs the same label; it must stop before the daemon starts.
              `(/bin/launchctl bootout gui/${options.uid}/${LAUNCHD_LABEL} 2>/dev/null || true)`,
              `/bin/launchctl bootstrap system ${LAUNCH_DAEMON_PATH}`,
            ].join(" && "),
          ],
          userServiceFollowUp: "none",
        };
      },
      removalPlan: () => ({
        kind: "launch-daemon",
        administratorCommand: [
          "/usr/bin/sudo",
          "/bin/sh",
          "-c",
          `(/bin/launchctl bootout system/${LAUNCHD_LABEL} 2>/dev/null || true) && /bin/rm -f ${LAUNCH_DAEMON_PATH}`,
        ],
        userServiceFollowUp: "install-and-enable",
      }),
      installed: () =>
        lstat(options.launchDaemonProbePath ?? LAUNCH_DAEMON_PATH).then(
          () => true,
          (error: unknown) => {
            if (isMissing(error)) return false;
            throw error;
          },
        ),
    };
  }
  if (platform === "linux") {
    return {
      kind: "lingering-user-unit",
      installPlan: () => ({
        kind: "lingering-user-unit",
        administratorCommand: [
          "/usr/bin/sudo",
          "/usr/bin/loginctl",
          "enable-linger",
          options.userName,
        ],
        userServiceFollowUp: "install-and-enable",
      }),
      removalPlan: () => ({
        kind: "lingering-user-unit",
        administratorCommand: [
          "/usr/bin/sudo",
          "/usr/bin/loginctl",
          "disable-linger",
          options.userName,
        ],
        userServiceFollowUp: "none",
      }),
      installed: async () => {
        const lingering = await runner
          .run("/usr/bin/loginctl", ["show-user", options.userName, "--property=Linger", "--value"])
          .catch(() => ({ stdout: "", stderr: "" }));
        return /^yes\s*$/i.test(lingering.stdout.trim());
      },
    };
  }
  throw new ServiceManagerError(
    "manager-unavailable",
    "The hub role has no boot service for this platform yet.",
  );
}

/** The launch daemon: the login agent's program, run as the person's account from boot. */
function launchDaemonDescriptor(invocation: ServiceInvocation, userName: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    `<key>UserName</key><string>${escapeXml(userName)}</string>`,
    "<key>ProgramArguments</key><array>",
    `<string>${escapeXml(invocation.command)}</string>${invocation.args
      .map((argument) => `<string>${escapeXml(argument)}</string>`)
      .join("")}`,
    "</array>",
    `<key>EnvironmentVariables</key><dict>${Object.entries(invocation.environment)
      .map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
      .join("")}</dict>`,
    "<key>KeepAlive</key><true/>",
    "<key>ThrottleInterval</key><integer>30</integer>",
    "<key>RunAtLoad</key><true/>",
    "</dict></plist>\n",
  ].join("");
}

function assertSafeUserName(userName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(userName)) {
    throw new ServiceManagerError("unsafe-descriptor", "The service account name is unsafe.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
