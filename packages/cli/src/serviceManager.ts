import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { HostRuntimePaths, HostLogReadResult, HostLogReadOptions } from "@octant/host-runtime";
import { BoundedHostLogStore } from "@octant/host-runtime";

const execFileAsync = promisify(execFile);
const LAUNCHD_LABEL = "app.octant.server";
const SYSTEMD_UNIT = "octant.service";

export type ServiceManagerKind = "launchd" | "systemd";
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
  const runner = options.runner ?? nodeRunner;
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
        installed: installed || result.stdout.length > 0,
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
  const runner = options.runner ?? nodeRunner;
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
    start: () => runSystemctl(["start", SYSTEMD_UNIT]).then(() => undefined),
    stop: () => runSystemctl(["stop", SYSTEMD_UNIT]).then(() => undefined),
    enable: () => runSystemctl(["enable", SYSTEMD_UNIT]).then(() => undefined),
    disable: () => runSystemctl(["disable", SYSTEMD_UNIT]).then(() => undefined),
    status: async () => {
      try {
        const [activeResult, enabledResult, session, lingering] = await Promise.all([
          runSystemctlStatus(["is-active", SYSTEMD_UNIT], [3]),
          runSystemctlStatus(["is-enabled", SYSTEMD_UNIT], [1, 5]),
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
    runtimeEntryPoint === undefined ? ["server", "run"] : [runtimeEntryPoint, "server", "run"];
  const environment = resolveServiceEnvironment(options);
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

function resolveCurrentCliEntryPoint(): string {
  const current = process.argv[1];
  if (current !== undefined && isAbsolute(current)) {
    const filename = current.slice(current.lastIndexOf("/") + 1);
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

const nodeRunner: ServiceCommandRunner = {
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

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
