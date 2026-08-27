import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { nextRestartBackoff } from "@octant/host-runtime";

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
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly now?: () => number;
  readonly writeNotice?: (message: string) => void;
}

export async function runServerRunCommand(options: ServerRunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const command = options.serverStartCommand?.() ?? defaultServerStartCommand();
  const spawn = options.spawn ?? defaultSpawn;
  const sleep =
    options.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;
  const writeNotice =
    options.writeNotice ?? ((message: string) => process.stderr.write(`${message}\n`));
  let currentChild: ServerRunChild | undefined;
  let shutdownRequested = false;
  const removeSignalHandler = (options.installSignalHandler ?? defaultInstallSignalHandler)(() => {
    shutdownRequested = true;
    currentChild?.kill("SIGTERM");
  });
  let failures = 0;
  let firstSpawn = true;
  let lastExitCode = 0;
  try {
    while (true) {
      const startedAt = now();
      currentChild = spawn({
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
      if (firstSpawn) {
        firstSpawn = false;
        await options.afterSpawn?.();
      }
      lastExitCode = await currentChild.exited;
      currentChild = undefined;
      if (shutdownRequested || lastExitCode === 0) return lastExitCode;
      if (now() - startedAt >= 60_000) failures = 0;
      const backoff = nextRestartBackoff({ failures, now: now() });
      if (backoff.crashLoop) return lastExitCode;
      failures += 1;
      writeNotice(
        `Octant server exited with code ${lastExitCode}; restarting in ${backoff.delayMs}ms.`,
      );
      await sleep(backoff.delayMs);
      if (shutdownRequested) return lastExitCode;
    }
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
