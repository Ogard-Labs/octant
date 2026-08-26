import { createServer, type AddressInfo } from "node:net";
import {
  HostRuntimePathError,
  type HostInfoReceipt,
  type ServicePolicyStore,
} from "@octant/host-runtime";

export class AutomaticHostStartupDisabled extends Error {
  readonly code = "automatic-start-disabled" as const;

  constructor() {
    super("Octant automatic host startup is disabled.");
    this.name = "AutomaticHostStartupDisabled";
  }
}

export async function assertAutomaticHostStartupEnabled(
  policyStore: Pick<ServicePolicyStore, "read">,
): Promise<void> {
  const policy = await policyStore.read();
  if (!policy.enabled) throw new AutomaticHostStartupDisabled();
}

interface ServerSpawnSpecOptions {
  readonly browserBrokerToken: string;
  readonly browserBrokerUrl: string;
  readonly codeFileHelperPath: string;
  readonly credentialBrokerToken: string;
  readonly credentialBrokerUrl: string;
  readonly desktopBridgeSecret: string;
  readonly root: string;
  readonly port: number;
  readonly instanceId: string;
  readonly packaged: boolean;
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
}

const trustedMacOsExecutablePaths = [
  "/usr/bin",
  "/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
] as const;

/**
 * Packaged apps do not inherit the interactive shell PATH that users configure
 * for developer CLIs. Keep the packaged child deterministic while allowing
 * the server to discover binaries installed in the standard system package
 * manager locations.
 */
export function resolvePackagedServerPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "darwin") return pathValue;
  const entries =
    pathValue
      ?.split(":")
      .filter((entry) =>
        trustedMacOsExecutablePaths.includes(entry as (typeof trustedMacOsExecutablePaths)[number]),
      ) ?? [];
  return [...new Set([...entries, ...trustedMacOsExecutablePaths])].join(":");
}

export function serverSpawnSpec(options: ServerSpawnSpecOptions) {
  const inheritedEnv = options.packaged
    ? Object.fromEntries(
        Object.entries(options.env).filter(([name]) => name !== "OCTANT_DEV_WEB_BOOTSTRAP"),
      )
    : options.env;
  const env = {
    ...inheritedEnv,
    OCTANT_BROWSER_BROKER_TOKEN: options.browserBrokerToken,
    OCTANT_BROWSER_BROKER_URL: options.browserBrokerUrl,
    OCTANT_CODE_FILE_HELPER_PATH: options.codeFileHelperPath,
    OCTANT_CREDENTIAL_BROKER_TOKEN: options.credentialBrokerToken,
    OCTANT_CREDENTIAL_BROKER_URL: options.credentialBrokerUrl,
    OCTANT_DESKTOP_BRIDGE_SECRET: options.desktopBridgeSecret,
    OCTANT_DESKTOP_PARENT_WATCH: "1",
    OCTANT_SERVER_INSTANCE_ID: options.instanceId,
    OCTANT_HOST_SERVICE_MODE: "desktop",
    OCTANT_SERVER_PORT: String(options.port),
  };
  if (!options.packaged) {
    return {
      command: "bun",
      args: ["run", "--cwd", `${options.root}/apps/server`, "start"],
      env,
      stdio: ["pipe", "inherit", "inherit"],
    } as const;
  }
  const packagedPath = resolvePackagedServerPath(options.env.PATH);
  return {
    command: options.execPath,
    args: [`${options.root}/apps/server/dist/main.mjs`],
    env: {
      ...env,
      ...(packagedPath === undefined ? {} : { PATH: packagedPath }),
      ELECTRON_RUN_AS_NODE: "1",
      OCTANT_PACKAGED_RUNTIME: "1",
    },
    stdio: ["pipe", "inherit", "inherit"],
  } as const;
}

export class ServerReadyTimeout extends Error {
  readonly category = "server-unavailable";

  constructor(
    timeoutMs: number,
    readonly lastProbeOutcome: StorageReadyProbeOutcome = "not-attempted",
    readonly attemptCount = 0,
  ) {
    super(
      `Octant storage did not become ready within ${timeoutMs}ms ` +
        `(last probe: ${lastProbeOutcome}; attempts: ${attemptCount}).`,
    );
    this.name = "ServerReadyTimeout";
  }
}

export function formatDesktopStartupFailure(error: unknown): string {
  if (error instanceof HostRuntimePathError) {
    if (error.code === "unsafe-mode") {
      const directory = error.path ?? "The Octant data directory";
      return (
        `Octant host path validation failed (unsafe-mode). ` +
        `${directory} must have mode 0700 and must not be accessible to group or other users.`
      );
    }
    if (error.path === undefined) {
      return `Octant host path validation failed (${error.code}). ${error.message}`;
    }
    return `Octant host path validation failed (${error.code}): ${error.path}. ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return "Octant could not start its local server.";
}

export type StorageReadyProbeOutcome =
  | "http-not-ok"
  | "identity-mismatch"
  | "invalid-health-payload"
  | "instance-mismatch"
  | "invalid-json"
  | "not-attempted"
  | "request-failed"
  | "storage-not-ready";

export class ManagedServerCleanupFailed extends Error {
  readonly category = "server-cleanup-failed";

  constructor(readonly stage: "exit-timeout" | "sigkill" | "sigterm") {
    super(`Octant managed server cleanup failed during ${stage}.`);
    this.name = "ManagedServerCleanupFailed";
  }
}

interface WaitForStorageReadyOptions {
  readonly serverUrl: string;
  readonly instanceId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly resolveAttachedHost?: () => Promise<LocalHostProbe | undefined>;
}

export interface LoopbackPortReservation {
  readonly port: number;
  readonly close: () => Promise<void>;
}

export interface LocalHostProbe {
  readonly url: string;
  readonly instanceId: string;
  readonly version?: string;
  readonly activeAgentCount?: number;
  readonly attentionRequired?: boolean;
}

export async function probeLocalHost(options: {
  readonly url: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<LocalHostProbe | undefined> {
  const fetch = options.fetch ?? globalThis.fetch;
  try {
    const baseUrl = new URL(options.url);
    if (
      baseUrl.protocol !== "http:" ||
      (baseUrl.hostname !== "127.0.0.1" && baseUrl.hostname !== "localhost") ||
      baseUrl.username !== "" ||
      baseUrl.password !== "" ||
      baseUrl.search !== "" ||
      baseUrl.hash !== ""
    ) {
      return undefined;
    }
    baseUrl.pathname = "/";
    const normalizedUrl = baseUrl.toString();
    const healthUrl = new URL("/health", normalizedUrl).toString();
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const body = payload as Record<string, unknown>;
    if (
      body.product !== "Octant" ||
      body.status !== "ok" ||
      body.storage !== "ready" ||
      typeof body.instanceId !== "string" ||
      body.instanceId.trim() === ""
    ) {
      return undefined;
    }
    const activeAgentCount = body.activeAgentCount;
    return {
      url: normalizedUrl,
      instanceId: body.instanceId,
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof activeAgentCount === "number" &&
      Number.isSafeInteger(activeAgentCount) &&
      activeAgentCount >= 0
        ? { activeAgentCount }
        : {}),
      ...(typeof body.attentionRequired === "boolean"
        ? { attentionRequired: body.attentionRequired }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export async function probeHostInfoReceipt(options: {
  readonly receipt: HostInfoReceipt;
  readonly expectedHostId: string;
  readonly expectedWireVersion: string;
  readonly expectedControlEndpoint: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<LocalHostProbe | undefined> {
  if (
    options.receipt.hostId !== options.expectedHostId ||
    options.receipt.wireVersion !== options.expectedWireVersion ||
    options.receipt.controlEndpoint !== options.expectedControlEndpoint
  ) {
    return undefined;
  }
  const probe = await probeLocalHost({
    url: options.receipt.url,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return probe?.instanceId === options.receipt.instanceId ? probe : undefined;
}

export async function resolveStableHostAttachment(options: {
  readonly readReceipt: () => Promise<HostInfoReceipt | undefined>;
  readonly readBridgeSecret: () => string | undefined;
  readonly probeReceipt: (receipt: HostInfoReceipt) => Promise<LocalHostProbe | undefined>;
}): Promise<{ readonly probe: LocalHostProbe; readonly bridgeSecret: string } | undefined> {
  const receiptBefore = await options.readReceipt();
  if (receiptBefore === undefined) return undefined;
  const secretBefore = options.readBridgeSecret();
  if (secretBefore === undefined || secretBefore === "") return undefined;
  const probe = await options.probeReceipt(receiptBefore);
  if (probe === undefined || probe.instanceId !== receiptBefore.instanceId) return undefined;
  const receiptAfter = await options.readReceipt();
  const secretAfter = options.readBridgeSecret();
  if (
    receiptAfter === undefined ||
    !sameHostInfoGeneration(receiptBefore, receiptAfter) ||
    secretAfter !== secretBefore
  ) {
    return undefined;
  }
  return Object.freeze({ probe, bridgeSecret: secretAfter });
}

function sameHostInfoGeneration(left: HostInfoReceipt, right: HostInfoReceipt): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.hostId === right.hostId &&
    left.instanceId === right.instanceId &&
    left.url === right.url &&
    left.controlEndpoint === right.controlEndpoint &&
    left.serviceMode === right.serviceMode &&
    left.serverVersion === right.serverVersion &&
    left.wireVersion === right.wireVersion &&
    left.updatedAt === right.updatedAt
  );
}

export function resolveManagedServerUrl(options: {
  readonly needsServerStart: boolean;
  readonly activeServerUrl: string | undefined;
  readonly reservedPort: number | undefined;
}): string {
  if (options.needsServerStart) {
    if (options.reservedPort === undefined) {
      throw new Error("Octant managed server URL is unavailable.");
    }
    return `http://127.0.0.1:${options.reservedPort}/`;
  }
  if (options.activeServerUrl !== undefined) return options.activeServerUrl;
  throw new Error("Octant managed server URL is unavailable.");
}

export async function reserveLoopbackPort(
  preferredPort?: number,
): Promise<LoopbackPortReservation> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      listener.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      listener.off("error", onError);
      resolve();
    };
    listener.once("error", onError);
    listener.once("listening", onListening);
    listener.listen({ host: "127.0.0.1", port: preferredPort ?? 0 });
  });
  const address = listener.address() as AddressInfo | null;
  if (address === null || typeof address === "string" || address.port === 0) {
    await closeLoopbackPort(listener);
    throw new Error("Octant could not reserve a local server port.");
  }
  return {
    port: address.port,
    close: () => closeLoopbackPort(listener),
  };
}

function closeLoopbackPort(listener: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    listener.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export async function waitForStorageReady(
  options: WaitForStorageReadyOptions,
): Promise<LocalHostProbe | undefined> {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 500;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  const healthUrl = new URL("/health", options.serverUrl).toString();
  let attemptCount = 0;
  let lastProbeOutcome: StorageReadyProbeOutcome = "not-attempted";

  while (now() < deadline) {
    attemptCount += 1;
    try {
      const remaining = Math.max(1, deadline - now());
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(Math.min(probeTimeoutMs, remaining)),
      });
      const outcome = await storageReadyProbeOutcome(response, options.instanceId);
      if (outcome === "ready") return undefined;
      lastProbeOutcome = outcome;
    } catch {
      lastProbeOutcome = "request-failed";
      // The managed child may not have bound its loopback socket yet.
    }
    const attached = await options.resolveAttachedHost?.();
    if (attached !== undefined && attached.instanceId !== options.instanceId) return attached;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  throw new ServerReadyTimeout(timeoutMs, lastProbeOutcome, attemptCount);
}

async function storageReadyProbeOutcome(
  response: Response,
  instanceId: string,
): Promise<StorageReadyProbeOutcome | "ready"> {
  if (!response.ok) return "http-not-ok";
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return "invalid-json";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "invalid-health-payload";
  }
  const body = parsed as Record<string, unknown>;
  if (body.product !== "Octant" || body.status !== "ok") return "identity-mismatch";
  if (body.instanceId !== instanceId) return "instance-mismatch";
  if (body.storage !== "ready") return "storage-not-ready";
  return "ready";
}

export interface ManagedChildProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly kill: (signal: NodeJS.Signals) => boolean | void;
  readonly once?: (event: "exit", listener: () => void) => unknown;
  readonly off?: (event: "exit", listener: () => void) => unknown;
}

export function managedServerNeedsStart(child: ManagedChildProcess | undefined): boolean {
  return child === undefined || hasExited(child);
}

export function createSingleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | undefined;
  return () => {
    if (current !== undefined) return current;
    const tracked = operation().finally(() => {
      if (current === tracked) current = undefined;
    });
    current = tracked;
    return tracked;
  };
}

interface ShutdownManagedServerOptions {
  readonly gracePeriodMs?: number;
  readonly forceKillWaitMs?: number;
  readonly waitForExit?: (child: ManagedChildProcess, timeoutMs: number) => Promise<boolean>;
}

export async function shutdownManagedServer(
  child: ManagedChildProcess,
  options: ShutdownManagedServerOptions = {},
): Promise<void> {
  if (hasExited(child)) return;
  const gracePeriodMs = options.gracePeriodMs ?? 5_000;
  const forceKillWaitMs = options.forceKillWaitMs ?? 1_000;
  deliverSignal(child, "SIGTERM", "sigterm");
  const exited = await (options.waitForExit ?? waitForChildExit)(child, gracePeriodMs);
  if (exited || hasExited(child)) return;
  deliverSignal(child, "SIGKILL", "sigkill");
  const forcedExit = await (options.waitForExit ?? waitForChildExit)(child, forceKillWaitMs);
  if (!forcedExit && !hasExited(child)) throw new ManagedServerCleanupFailed("exit-timeout");
}

function deliverSignal(
  child: ManagedChildProcess,
  signal: "SIGKILL" | "SIGTERM",
  stage: "sigkill" | "sigterm",
): void {
  try {
    if (child.kill(signal) === false) throw new ManagedServerCleanupFailed(stage);
  } catch (error) {
    if (error instanceof ManagedServerCleanupFailed) throw error;
    throw new ManagedServerCleanupFailed(stage);
  }
}

function hasExited(child: ManagedChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ManagedChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  if (child.once === undefined || child.off === undefined) return false;
  return await new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off?.("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once?.("exit", onExit);
  });
}
