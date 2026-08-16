import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface ServerRunSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface ServerRunChild {
  readonly exited: Promise<number>;
  kill(signal: "SIGTERM"): void;
}

export interface ServerRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly port?: number;
  readonly spawn?: (spec: ServerRunSpawnSpec) => ServerRunChild;
  readonly serverStartCommand?: () => {
    readonly command: string;
    readonly args: readonly string[];
  };
  readonly instanceId?: () => string;
  readonly bridgeSecret?: () => string;
  readonly installSignalHandler?: (handler: () => void) => () => void;
  readonly afterSpawn?: () => void | Promise<void>;
}

export async function runServerRunCommand(options: ServerRunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const command = options.serverStartCommand?.() ?? defaultServerStartCommand();
  const child = (options.spawn ?? defaultSpawn)({
    command: command.command,
    args: command.args,
    env: {
      ...env,
      OCTANT_DESKTOP_BRIDGE_SECRET: (options.bridgeSecret ?? createBridgeSecret)(),
      OCTANT_HOST_SERVICE_MODE: env.OCTANT_HOST_SERVICE_MODE ?? "foreground",
      OCTANT_SERVER_INSTANCE_ID: (options.instanceId ?? randomUUID)(),
      ...(options.port === undefined ? {} : { OCTANT_SERVER_PORT: String(options.port) }),
    },
  });
  const removeSignalHandler = (options.installSignalHandler ?? defaultInstallSignalHandler)(() =>
    child.kill("SIGTERM"),
  );
  try {
    await options.afterSpawn?.();
    return await child.exited;
  } finally {
    removeSignalHandler();
  }
}

export function resolveServerRunOptions(
  flags: Readonly<Record<string, string | boolean>>,
  positional: readonly string[],
): Pick<ServerRunOptions, "port"> | undefined {
  if (positional.length !== 1 || positional[0] !== "run") return undefined;
  if (Object.keys(flags).some((name) => name !== "port")) return undefined;
  if (!("port" in flags)) return {};
  const rawPort = flags.port;
  if (typeof rawPort !== "string" || !/^\d+$/.test(rawPort)) return undefined;
  const port = Number(rawPort);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? { port } : undefined;
}

function createBridgeSecret(): string {
  return randomBytes(32).toString("base64url");
}

function defaultServerStartCommand(): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return {
    command: process.execPath,
    args: [
      "run",
      "--cwd",
      fileURLToPath(new URL("../../../apps/server", import.meta.url)),
      "start",
    ],
  };
}

function defaultSpawn(spec: ServerRunSpawnSpec): ServerRunChild {
  const child = Bun.spawn({
    cmd: [spec.command, ...spec.args],
    env: spec.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return {
    exited: child.exited,
    kill: (signal) => void child.kill(signal),
  };
}

function defaultInstallSignalHandler(handler: () => void): () => void {
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
  };
}
