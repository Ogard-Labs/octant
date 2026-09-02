import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeWindowId, type WindowId } from "@octant/contracts";
import {
  resolveHostRuntimePaths,
  ServicePolicyStore,
  type HostServicePolicy,
} from "@octant/host-runtime";

const DEFAULT_PORT = 13_773;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_READY_TIMEOUT_MS = 30_000;

export interface HostHealth {
  readonly status: "ready" | "disabled" | "timeout";
  readonly url?: URL;
  readonly instanceId?: string;
  readonly version?: string;
}

export interface HostLauncherDependencies {
  readonly bridgeSecret: string | undefined;
  readonly hostname?: string | undefined;
  readonly port?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly spawn?: (spec: HostSpawnSpec) => HostChildProcess;
  readonly waitForHost?: (options: WaitForHostOptions) => Promise<HostHealth>;
  readonly readyTimeoutMs?: number;
  readonly serverStartCommand?: () => {
    readonly command: string;
    readonly args: readonly string[];
  };
  readonly resolveAttachedHost?: () => Promise<AttachedHostCandidate | undefined>;
  readonly environment?: NodeJS.ProcessEnv;
  /** Persisted automatic-startup policy. Launch paths inject a real store. */
  readonly policyStore?: HostServicePolicyReader;
}

export type HostServicePolicyReader = Pick<ServicePolicyStore, "read">;

export interface HostSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly bridgeSecret: string;
  readonly port: number;
}

export interface HostChildProcess {
  readonly pid?: number;
  kill(signal?: string): void;
  on(event: "exit", listener: (code: number | null) => void): void;
}

export interface WaitForHostOptions {
  readonly url: URL;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly resolveAttachedHost?: () => Promise<AttachedHostCandidate | undefined>;
}

export interface AttachedHostCandidate {
  readonly url: URL;
  readonly instanceId: string;
}

export type HostLauncherResult =
  | {
      readonly kind: "attached";
      readonly url: URL;
      readonly instanceId?: string;
      readonly version?: string;
    }
  | {
      readonly kind: "started";
      readonly url: URL;
      readonly instanceId?: string;
      readonly version?: string;
    }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "start-failed"; readonly reason: string };

export async function attachOrCreateHost(
  dependencies: HostLauncherDependencies,
): Promise<HostLauncherResult> {
  const hostname = dependencies.hostname ?? DEFAULT_HOSTNAME;
  const port = dependencies.port ?? DEFAULT_PORT;
  const url = new URL(`http://${hostname}:${port}`);
  const fetch = dependencies.fetch ?? globalThis.fetch;

  const probe = await probeHostHealth({ url, fetch });
  if (probe.status === "ready") {
    return {
      kind: "attached",
      url,
      ...(probe.instanceId === undefined ? {} : { instanceId: probe.instanceId }),
      ...(probe.version === undefined ? {} : { version: probe.version }),
    };
  }
  if (probe.status === "disabled") {
    return {
      kind: "disabled",
      reason:
        "Octant host storage is not ready. Restart the Octant desktop application or `octant server` and retry.",
    };
  }

  const attached = await probeAttachedCandidate(dependencies.resolveAttachedHost, fetch);
  if (attached !== undefined) {
    return {
      kind: "attached",
      url: attached.url,
      instanceId: attached.instanceId,
      ...(attached.version === undefined ? {} : { version: attached.version }),
    };
  }

  if (dependencies.bridgeSecret === undefined) {
    return {
      kind: "start-failed",
      reason:
        "Octant desktop bridge secret is unavailable. Start the host from the Octant desktop application or set OCTANT_DESKTOP_BRIDGE_SECRET.",
    };
  }
  let policy: HostServicePolicy;
  try {
    policy = await (dependencies.policyStore ?? createDefaultServicePolicyStore()).read();
  } catch {
    return {
      kind: "start-failed",
      reason: "Octant could not read its automatic startup policy.",
    };
  }
  if (!policy.enabled) {
    return {
      kind: "disabled",
      reason:
        "Octant automatic startup is disabled. Use `octant server start` or `server run` to start it explicitly.",
    };
  }
  const spawn = dependencies.spawn ?? defaultSpawn;
  const command = dependencies.serverStartCommand?.() ?? defaultServerStartCommand();
  const child = spawn({
    command: command.command,
    args: command.args,
    env: {
      ...process.env,
      ...dependencies.environment,
      OCTANT_DESKTOP_BRIDGE_SECRET: dependencies.bridgeSecret,
      OCTANT_SERVER_PORT: String(port),
      OCTANT_HOST_SERVICE_MODE: "web",
    },
    bridgeSecret: dependencies.bridgeSecret,
    port,
  });

  const wait = dependencies.waitForHost ?? defaultWaitForHost;
  const ready = await wait({
    url,
    timeoutMs: dependencies.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    fetch,
    ...(dependencies.resolveAttachedHost === undefined
      ? {}
      : { resolveAttachedHost: dependencies.resolveAttachedHost }),
  });
  if (ready.status === "ready") {
    const readyUrl = ready.url ?? url;
    const startedCanonicalHost = readyUrl.toString() === url.toString();
    if (!startedCanonicalHost) stopSpawnedChild(child);
    return {
      kind: startedCanonicalHost ? "started" : "attached",
      url: readyUrl,
      ...(ready.instanceId === undefined ? {} : { instanceId: ready.instanceId }),
      ...(ready.version === undefined ? {} : { version: ready.version }),
    };
  }
  if (ready.status === "disabled") {
    stopSpawnedChild(child);
    return {
      kind: "disabled",
      reason:
        "Octant host storage did not become ready. Restart the Octant desktop application or `octant server` and retry.",
    };
  }
  stopSpawnedChild(child);
  return {
    kind: "start-failed",
    reason: `Octant host did not become ready within ${dependencies.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms. Another process may already own port ${port}.`,
  };
}

async function probeAttachedCandidate(
  resolveAttachedHost: (() => Promise<AttachedHostCandidate | undefined>) | undefined,
  fetch: typeof globalThis.fetch,
): Promise<(AttachedHostCandidate & { readonly version?: string }) | undefined> {
  if (resolveAttachedHost === undefined) return undefined;
  try {
    const candidate = await resolveAttachedHost();
    if (candidate === undefined) return undefined;
    const probe = await probeHostHealth({ url: candidate.url, fetch });
    if (probe.status !== "ready" || probe.instanceId !== candidate.instanceId) return undefined;
    return {
      ...candidate,
      ...(probe.version === undefined ? {} : { version: probe.version }),
    };
  } catch {
    return undefined;
  }
}

function stopSpawnedChild(child: HostChildProcess | undefined): void {
  try {
    child?.kill("SIGTERM");
  } catch {
    // A competing canonical host may win after this child has already exited.
  }
}

export async function probeHostHealth(options: {
  readonly url: URL;
  readonly fetch?: typeof globalThis.fetch | undefined;
}): Promise<HostHealth> {
  const fetch = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetch(new URL("/health", options.url));
    if (!response.ok) return { status: "timeout" };
    const body = (await response.json()) as {
      readonly product?: string;
      readonly status?: string;
      readonly storage?: string;
      readonly instanceId?: string;
      readonly version?: string;
    };
    if (body.product !== "Octant" || body.status !== "ok") return { status: "timeout" };
    if (body.storage !== "ready") {
      return {
        status: "disabled",
        ...(body.instanceId === undefined ? {} : { instanceId: body.instanceId }),
        ...(body.version === undefined ? {} : { version: body.version }),
      };
    }
    return {
      status: "ready",
      url: options.url,
      ...(body.instanceId === undefined ? {} : { instanceId: body.instanceId }),
      ...(body.version === undefined ? {} : { version: body.version }),
    };
  } catch {
    return { status: "timeout" };
  }
}

async function defaultWaitForHost(options: WaitForHostOptions): Promise<HostHealth> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await options.resolveAttachedHost?.();
    const probe = await probeHostHealth({ url: options.url, fetch: options.fetch });
    const candidateOwnsPrimaryUrl = candidate?.url.toString() === options.url.toString();
    if (
      (probe.status === "ready" || probe.status === "disabled") &&
      (!candidateOwnsPrimaryUrl || probe.instanceId === candidate.instanceId)
    ) {
      return probe;
    }
    if (candidate !== undefined && !candidateOwnsPrimaryUrl) {
      const attached = await probeHostHealth({ url: candidate.url, fetch: options.fetch });
      if (
        (attached.status === "ready" || attached.status === "disabled") &&
        attached.instanceId === candidate.instanceId
      ) {
        return attached;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { status: "timeout" };
}

function defaultServerStartCommand(): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return { command: "bun", args: ["run", "--cwd", defaultServerRoot(), "start"] };
}

function defaultSpawn(spec: HostSpawnSpec): HostChildProcess {
  const child = Bun.spawn({
    cmd: [spec.command, ...spec.args],
    env: spec.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  return {
    pid: child.pid,
    kill: (signal?: string) => void child.kill((signal ?? "SIGTERM") as NodeJS.Signals),
    on: (event, listener) => {
      if (event === "exit") {
        child.exited.then((code) => listener(code)).catch(() => listener(null));
      }
    },
  };
}

function defaultServerRoot(): string {
  return process.env.OCTANT_SERVER_ROOT ?? resolveDefaultServerRoot();
}

export function createDefaultServicePolicyStore(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServicePolicyStore {
  return new ServicePolicyStore({
    path: resolveHostRuntimePaths({
      env,
      platform: process.platform,
      home: homedir(),
      temporaryDirectory: canonicalTemporaryDirectory(),
      uid: process.getuid?.() ?? 0,
    }).servicePolicyPath,
  });
}

function canonicalTemporaryDirectory(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return resolve(tmpdir());
  }
}

export function resolveDefaultServerRoot(): string {
  return fileURLToPath(new URL("../../../apps/server", import.meta.url));
}

export interface CreateLaunchSessionOptions {
  readonly bridgeSecret: string;
  readonly serverUrl: URL;
  readonly windowId: WindowId;
  readonly capability: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface LaunchSessionReceipt {
  readonly launchToken: string;
  readonly expiresAt: number;
}

export async function createLaunchSession(
  options: CreateLaunchSessionOptions,
): Promise<LaunchSessionReceipt | undefined> {
  const fetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetch(new URL("/api/desktop/launch-sessions", options.serverUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-desktop-secret": options.bridgeSecret,
      },
      body: JSON.stringify({ windowId: options.windowId, capability: options.capability }),
    });
  } catch {
    return undefined;
  }
  if (response.status === 201) {
    return (await response.json()) as LaunchSessionReceipt;
  }
  return undefined;
}

export function buildWebClientUrl(options: {
  readonly serverUrl: URL;
  readonly launchToken: string;
}): URL {
  const url = new URL(options.serverUrl);
  url.searchParams.set("serverUrl", options.serverUrl.toString());
  url.hash = `launchToken=${options.launchToken}`;
  return url;
}

export function generateWindowId(): WindowId {
  return decodeWindowId(randomUUID());
}
