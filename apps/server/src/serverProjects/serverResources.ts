import { decodeHostResourceSnapshot, decodeUtcTimestamp } from "@octant/contracts";
import type { HostResourceSnapshot } from "@octant/contracts";
import {
  createHostVitalsSampler,
  parseProcDiskstats,
  parseProcNetDev,
  type CumulativeCounters,
} from "../hostVitals";
import type { ServerAddress, ServerCall, ServerConnection } from "./serverConnection";

/**
 * Load on a registered server, read over the same SSH connection its Project
 * already uses. One short POSIX script prints `/proc` and `/sys` readings
 * between marker lines; this module parses them into the host-resources
 * snapshot. Linux servers only: any other server answers nothing and the
 * Vitals tool says so. Nothing in the answer names a path, user or process.
 */

const CALL_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const CACHE_MS = 5_000;

export const SERVER_RESOURCE_SCRIPT = String.raw`m() { printf '#octant:%s\n' "$1"; }
[ -r /proc/stat ] || exit 3
m stat1; grep '^cpu ' /proc/stat
sleep 0.2 2>/dev/null || sleep 1
m stat2; grep '^cpu ' /proc/stat
m cores; grep -c '^processor' /proc/cpuinfo 2>/dev/null
m mem; grep -E '^(MemTotal|MemAvailable|MemFree):' /proc/meminfo
m net; cat /proc/net/dev 2>/dev/null
m diskstats; cat /proc/diskstats 2>/dev/null
m df; df -Pk "$1" 2>/dev/null | tail -n 1
m gpu; cat /sys/class/drm/card*/device/gpu_busy_percent 2>/dev/null
nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null
m battery; cat /sys/class/power_supply/BAT0/capacity /sys/class/power_supply/BAT0/status 2>/dev/null
`;

export interface ServerResourceReading {
  readonly cores: number;
  readonly cpuPercent: number;
  readonly memory: { readonly usedBytes: number; readonly totalBytes: number };
  readonly disk?: { readonly usedBytes: number; readonly freeBytes: number };
  readonly network?: CumulativeCounters;
  readonly diskIo?: CumulativeCounters;
  readonly gpuPercent?: number;
  readonly battery?: { readonly percent: number; readonly charging: boolean };
}

function sections(text: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  let name: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (name !== undefined) result.set(name, lines.join("\n"));
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("#octant:")) {
      flush();
      name = line.slice("#octant:".length).trim();
      lines = [];
    } else lines.push(line);
  }
  flush();
  return result;
}

function cpuTimes(line: string | undefined): { busy: number; total: number } | undefined {
  const fields = (line ?? "").trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) return undefined;
  const total = fields.slice(0, 8).reduce((sum, value) => sum + value, 0);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { busy: total - idle, total };
}

/** `undefined` when the output is not a Linux `/proc` reading. */
export function parseServerResourceOutput(text: string): ServerResourceReading | undefined {
  const part = sections(text);
  const first = cpuTimes(part.get("stat1"));
  const second = cpuTimes(part.get("stat2"));
  const meminfo = part.get("mem") ?? "";
  const kilobytes = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(meminfo);
    return match === null ? undefined : Number(match[1]) * 1024;
  };
  const totalBytes = kilobytes("MemTotal");
  const availableBytes = kilobytes("MemAvailable") ?? kilobytes("MemFree");
  if (first === undefined || second === undefined) return undefined;
  if (totalBytes === undefined || availableBytes === undefined) return undefined;
  const elapsed = second.total - first.total;
  const cpuPercent = elapsed <= 0 ? 0 : ((second.busy - first.busy) / elapsed) * 100;
  const cores = Number((part.get("cores") ?? "").trim());
  const dfFields = (part.get("df") ?? "").trim().split(/\s+/);
  const dfUsed = Number(dfFields[2]) * 1024;
  const dfFree = Number(dfFields[3]) * 1024;
  const network = parseProcNetDev(part.get("net") ?? "");
  const diskIo = parseProcDiskstats(part.get("diskstats") ?? "");
  const gpuValues = (part.get("gpu") ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
  const batteryLines = (part.get("battery") ?? "").trim().split("\n");
  const batteryPercent = Number(batteryLines[0]);
  return {
    cores: Number.isFinite(cores) ? cores : 0,
    cpuPercent,
    memory: { usedBytes: Math.max(0, totalBytes - availableBytes), totalBytes },
    ...(Number.isFinite(dfUsed + dfFree) ? { disk: { usedBytes: dfUsed, freeBytes: dfFree } } : {}),
    ...(network === undefined ? {} : { network }),
    ...(diskIo === undefined ? {} : { diskIo }),
    ...(gpuValues.length === 0 ? {} : { gpuPercent: Math.max(...gpuValues) }),
    ...(batteryLines[0] !== undefined && batteryLines[0] !== "" && Number.isFinite(batteryPercent)
      ? { battery: { percent: batteryPercent, charging: batteryLines[1]?.trim() === "Charging" } }
      : {}),
  };
}

export type ServerResourceRead =
  | { readonly status: "ready"; readonly snapshot: HostResourceSnapshot }
  | { readonly status: "unsupported" }
  | { readonly status: "unavailable"; readonly message: string };

export interface ServerResourceReaderOptions {
  readonly connection: Pick<ServerConnection, "run">;
  /** Read each call, so a server removed mid-session refuses the next read. */
  readonly address: () => { readonly server: ServerAddress; readonly folder: string } | undefined;
  readonly now?: () => number;
}

/** One reader per server Project: it keeps the last counters so throughput is a rate. */
export function createServerResourceReader(
  options: ServerResourceReaderOptions,
): (signal?: AbortSignal) => Promise<ServerResourceRead> {
  const now = options.now ?? Date.now;
  let latest: ServerResourceReading | undefined;
  const sample = createHostVitalsSampler(
    {
      network: async () => latest?.network,
      diskIo: async () => latest?.diskIo,
      gpu: async () =>
        latest?.gpuPercent === undefined
          ? undefined
          : { percent: Math.min(100, Math.max(0, Math.round(latest.gpuPercent))) },
      energy: async () =>
        latest?.battery === undefined
          ? undefined
          : {
              batteryPercent: Math.min(100, Math.max(0, Math.round(latest.battery.percent))),
              charging: latest.battery.charging,
            },
    },
    now,
  );
  let cached: { readonly at: number; readonly read: ServerResourceRead } | undefined;
  let inflight: Promise<ServerResourceRead> | undefined;

  const fetchOnce = async (signal: AbortSignal | undefined): Promise<ServerResourceRead> => {
    const target = options.address();
    if (target === undefined)
      return { status: "unavailable", message: "The server is no longer registered." };
    const call: ServerCall = await options.connection.run(target.server, {
      script: SERVER_RESOURCE_SCRIPT,
      args: [target.folder],
      timeoutMs: CALL_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    if (call.status === "unreachable") {
      return {
        status: "unavailable",
        message: `The server could not be reached (${call.message}).`,
      };
    }
    if (call.status !== "ran")
      return { status: "unavailable", message: "The read did not finish." };
    const reading = call.truncated
      ? undefined
      : parseServerResourceOutput(call.output.toString("utf8"));
    if (reading === undefined) return { status: "unsupported" };
    latest = reading;
    const vitals = await sample();
    return {
      status: "ready",
      snapshot: decodeHostResourceSnapshot({
        cores: Math.min(4_096, Math.max(0, reading.cores)),
        cpuPercent: Math.min(100, Math.max(0, Math.round(reading.cpuPercent))),
        memory: {
          usedBytes: Math.round(reading.memory.usedBytes),
          totalBytes: Math.round(reading.memory.totalBytes),
        },
        ...(reading.disk === undefined
          ? {}
          : {
              disk: {
                usedBytes: Math.max(0, Math.round(reading.disk.usedBytes)),
                freeBytes: Math.max(0, Math.round(reading.disk.freeBytes)),
              },
            }),
        ...vitals,
        sampledAt: decodeUtcTimestamp(new Date(now()).toISOString()),
      }),
    };
  };

  return (signal) => {
    const at = now();
    if (cached !== undefined && at - cached.at < CACHE_MS) return Promise.resolve(cached.read);
    if (inflight !== undefined) return inflight;
    const pending = fetchOnce(signal)
      .then((read) => {
        if (read.status === "ready" || read.status === "unsupported") {
          cached = { at: now(), read };
        }
        return read;
      })
      .finally(() => {
        inflight = undefined;
      });
    inflight = pending;
    return pending;
  };
}
