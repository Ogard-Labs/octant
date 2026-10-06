import { cpus, freemem, totalmem } from "node:os";
import { statfs as statfsVolume } from "node:fs/promises";
import {
  decodeHostResourceSnapshot,
  decodeUtcTimestamp,
  type HostResourceSnapshot,
} from "@octant/contracts";
import { isLoopbackHostname } from "./shellRoutes";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { readPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import type { ClientPrincipal } from "./clientPrincipal";

/**
 * Read-only load snapshot for the host this process is.
 *
 * The local owner sees the figures. A paired remote client sees them only
 * when its authenticated device is already paired to this host's identity;
 * every other caller is refused and the refusal carries no figures. The
 * body never names a path, a user, or a process. One snapshot is reused for
 * about five seconds so a visible card does not resample on every paint.
 */

export const HOST_RESOURCE_PATH = "/api/host/resources";
export const HOST_RESOURCE_CACHE_MS = 5_000;
export const HOST_RESOURCE_CPU_WINDOW_MS = 200;

const ALLOWED_KEYS = new Set(["cores", "cpuPercent", "memory", "disk", "sampledAt"]);

export interface HostVolumeStats {
  readonly bsize: number;
  readonly blocks: number;
  readonly bavail: number;
}

export interface HostResourceMemoryReading {
  readonly usedBytes: number;
  readonly totalBytes: number;
}

export interface HostResourceRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** This host's stable identity. Absent until one has been projected. */
  readonly hostId: () => string | undefined;
  readonly dataDirectory: string;
  readonly now?: () => number;
  readonly cacheMs?: number;
  /** Replaces the live sample. The route still caches whatever it returns. */
  readonly read?: () => Promise<HostResourceSnapshot>;
  readonly cpuPercent?: () => Promise<number>;
  readonly statfs?: (path: string) => Promise<HostVolumeStats>;
  readonly memory?: () => HostResourceMemoryReading;
  readonly cores?: () => number;
}

export function createHostResourceRouteHandler(
  dependencies: HostResourceRouteDependencies,
): (request: Request) => Promise<Response | undefined> {
  const now = dependencies.now ?? Date.now;
  const cacheMs = dependencies.cacheMs ?? HOST_RESOURCE_CACHE_MS;
  const read = dependencies.read ?? (() => readHostResourceSnapshot(dependencies));
  let cached: { readonly at: number; readonly snapshot: HostResourceSnapshot } | undefined;
  let inflight: Promise<HostResourceSnapshot> | undefined;

  const current = (): Promise<HostResourceSnapshot> => {
    const at = now();
    if (cached !== undefined && at - cached.at < cacheMs) return Promise.resolve(cached.snapshot);
    if (inflight !== undefined) return inflight;
    const pending = read()
      .then((snapshot) => {
        cached = { at: now(), snapshot };
        inflight = undefined;
        return snapshot;
      })
      .catch((error: unknown) => {
        inflight = undefined;
        throw error;
      });
    inflight = pending;
    return pending;
  };

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== HOST_RESOURCE_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Host resources must be read on loopback.", 400, origin);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, origin);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return failure("HTTP method is not supported for this route.", 405, origin);
    }
    if (url.search !== "") {
      return failure("Host resources request is invalid.", 400, origin);
    }
    if (!admits(request, dependencies)) {
      return failure("Host resources are not available to this client.", 403, origin);
    }
    try {
      const snapshot = await current();
      return json(snapshotBody(snapshot), 200, origin);
    } catch {
      return failure("Host resources are unavailable.", 500, origin);
    }
  };
}

/**
 * Sample this process. Disk is omitted when the data volume cannot be read,
 * and nothing returned names the directory that was sampled.
 */
export async function readHostResourceSnapshot(
  dependencies: Pick<
    HostResourceRouteDependencies,
    "dataDirectory" | "cpuPercent" | "statfs" | "memory" | "cores" | "now"
  >,
): Promise<HostResourceSnapshot> {
  const cpuPercent =
    dependencies.cpuPercent ?? (() => averageCpuPercent(HOST_RESOURCE_CPU_WINDOW_MS));
  const memory = dependencies.memory ?? readMemory;
  const cores = dependencies.cores ?? (() => cpus().length);
  const volume = dependencies.statfs ?? statfsVolume;
  const clock = dependencies.now ?? Date.now;
  const [percent, usedMemory] = await Promise.all([cpuPercent(), Promise.resolve(memory())]);
  const disk = await readDisk(volume, dependencies.dataDirectory);
  return decodeHostResourceSnapshot({
    cores: cores(),
    cpuPercent: clampPercent(percent),
    memory: usedMemory,
    ...(disk === undefined ? {} : { disk }),
    sampledAt: decodeUtcTimestamp(new Date(clock()).toISOString()),
  });
}

export function snapshotRevealsOnlyLoad(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) return false;
  }
  return true;
}

function admits(request: Request, dependencies: HostResourceRouteDependencies): boolean {
  const bound = readPrincipalRouteContext(request);
  if (bound !== undefined) return principalMayRead(bound.principal, dependencies.hostId());
  try {
    const context = authenticateRoutePrincipal({
      request,
      store: dependencies.windowAuthorityStore,
      now: (dependencies.now ?? Date.now)(),
    });
    return principalMayRead(context.principal, dependencies.hostId());
  } catch (error) {
    if (error instanceof WindowAuthorityError) return false;
    return false;
  }
}

function principalMayRead(principal: ClientPrincipal, hostId: string | undefined): boolean {
  if (principal.kind === "local-window") return true;
  if (principal.kind !== "remote-device") return false;
  if (hostId === undefined || hostId.length === 0) return false;
  return String(principal.hostId) === hostId;
}

async function readDisk(
  volume: (path: string) => Promise<HostVolumeStats>,
  dataDirectory: string,
): Promise<HostResourceSnapshot["disk"]> {
  try {
    const stats = await volume(dataDirectory);
    const total = safeProduct(stats.blocks, stats.bsize);
    const free = safeProduct(stats.bavail, stats.bsize);
    if (total === undefined || free === undefined) return undefined;
    return { usedBytes: Math.max(0, total - free), freeBytes: free };
  } catch {
    return undefined;
  }
}

function readMemory(): HostResourceMemoryReading {
  const totalBytes = totalmem();
  const freeBytes = freemem();
  return { usedBytes: Math.max(0, totalBytes - freeBytes), totalBytes };
}

function safeProduct(left: number, right: number): number | undefined {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    return undefined;
  }
  const product = left * right;
  return Number.isSafeInteger(product) ? product : undefined;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

async function averageCpuPercent(windowMs: number): Promise<number> {
  const first = cpuTimes();
  await delay(windowMs);
  const second = cpuTimes();
  const total = second.total - first.total;
  if (total <= 0) return 0;
  return ((second.busy - first.busy) / total) * 100;
}

function cpuTimes(): { readonly busy: number; readonly total: number } {
  let busy = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const times = cpu.times;
    const sum = times.user + times.nice + times.sys + times.idle + times.irq;
    busy += sum - times.idle;
    total += sum;
  }
  return { busy, total };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function snapshotBody(snapshot: HostResourceSnapshot): HostResourceSnapshot {
  return {
    cores: snapshot.cores,
    cpuPercent: snapshot.cpuPercent,
    memory: { usedBytes: snapshot.memory.usedBytes, totalBytes: snapshot.memory.totalBytes },
    ...(snapshot.disk === undefined
      ? {}
      : { disk: { usedBytes: snapshot.disk.usedBytes, freeBytes: snapshot.disk.freeBytes } }),
    sampledAt: snapshot.sampledAt,
  };
}

function json(body: HostResourceSnapshot, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...(origin === null ? {} : { "access-control-allow-origin": origin }),
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
    vary: "Origin",
  };
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === "null") return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) ||
      parsed.protocol === "app:"
    );
  } catch {
    return false;
  }
}
