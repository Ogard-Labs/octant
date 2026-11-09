import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import type { HostResourceEnergy, HostResourceGpu, HostResourceRate } from "@octant/contracts";

/**
 * Optional host vitals beyond CPU, memory and volume space: network and block
 * device throughput, GPU utilisation, and battery state.
 *
 * Every reader answers `undefined` when the host cannot supply the figure
 * (another platform, a container without the counter, a missing tool). The
 * tool shows nothing rather than a guess. Counters are cumulative, so the
 * sampler turns two readings into a rate and answers no rate for the first.
 */

export interface CumulativeCounters {
  readonly inBytes: number;
  readonly outBytes: number;
}

export interface HostVitalsReaders {
  readonly network: () => Promise<CumulativeCounters | undefined>;
  readonly diskIo: () => Promise<CumulativeCounters | undefined>;
  readonly gpu: () => Promise<HostResourceGpu | undefined>;
  readonly energy: () => Promise<HostResourceEnergy | undefined>;
}

export interface HostVitals {
  readonly network?: HostResourceRate;
  readonly diskIo?: HostResourceRate;
  readonly gpu?: HostResourceGpu;
  readonly energy?: HostResourceEnergy;
}

const SECTOR_BYTES = 512;
const COMMAND_TIMEOUT_MS = 2_000;

export function createHostVitalsSampler(
  readers: HostVitalsReaders = platformReaders(process.platform),
  now: () => number = Date.now,
): () => Promise<HostVitals> {
  let previous:
    | {
        readonly at: number;
        readonly network?: CumulativeCounters;
        readonly diskIo?: CumulativeCounters;
      }
    | undefined;
  return async () => {
    const [network, diskIo, gpu, energy] = await Promise.all([
      readers.network().catch(() => undefined),
      readers.diskIo().catch(() => undefined),
      readers.gpu().catch(() => undefined),
      readers.energy().catch(() => undefined),
    ]);
    const at = now();
    const seconds = previous === undefined ? 0 : (at - previous.at) / 1_000;
    const networkRate = rate(previous?.network, network, seconds);
    const diskRate = rate(previous?.diskIo, diskIo, seconds);
    previous = {
      at,
      ...(network === undefined ? {} : { network }),
      ...(diskIo === undefined ? {} : { diskIo }),
    };
    return {
      ...(networkRate === undefined ? {} : { network: networkRate }),
      ...(diskRate === undefined ? {} : { diskIo: diskRate }),
      ...(gpu === undefined ? {} : { gpu }),
      ...(energy === undefined ? {} : { energy }),
    };
  };
}

function rate(
  before: CumulativeCounters | undefined,
  after: CumulativeCounters | undefined,
  seconds: number,
): HostResourceRate | undefined {
  if (before === undefined || after === undefined || seconds <= 0) return undefined;
  // A counter that went backwards was reset (interface restart, reboot); no rate this round.
  if (after.inBytes < before.inBytes || after.outBytes < before.outBytes) return undefined;
  return {
    inBytesPerSecond: Math.round((after.inBytes - before.inBytes) / seconds),
    outBytesPerSecond: Math.round((after.outBytes - before.outBytes) / seconds),
  };
}

export function platformReaders(platform: NodeJS.Platform): HostVitalsReaders {
  if (platform === "linux") {
    return {
      network: async () => parseProcNetDev(await readFile("/proc/net/dev", "utf8")),
      diskIo: async () => parseProcDiskstats(await readFile("/proc/diskstats", "utf8")),
      gpu: readLinuxGpu,
      energy: readLinuxBattery,
    };
  }
  if (platform === "darwin") {
    return {
      network: async () => parseNetstatInterfaces(await run("netstat", ["-ibn"])),
      diskIo: async () =>
        parseIoregDiskStatistics(await run("ioreg", ["-r", "-c", "IOBlockStorageDriver", "-w0"])),
      gpu: async () =>
        parseIoregGpu(await run("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator", "-w0"])),
      energy: async () => parsePmsetBattery(await run("pmset", ["-g", "batt"])),
    };
  }
  const none = async () => undefined;
  return { network: none, diskIo: none, gpu: none, energy: none };
}

export function parseProcNetDev(text: string): CumulativeCounters | undefined {
  let inBytes = 0;
  let outBytes = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name === "lo") continue;
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    const received = fields[0];
    const sent = fields[8];
    if (received === undefined || sent === undefined || !Number.isFinite(received + sent)) continue;
    inBytes += received;
    outBytes += sent;
    seen = true;
  }
  return seen ? { inBytes, outBytes } : undefined;
}

const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export function parseProcDiskstats(text: string): CumulativeCounters | undefined {
  let inBytes = 0;
  let outBytes = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const name = fields[2];
    if (name === undefined || !WHOLE_DISK.test(name)) continue;
    const read = Number(fields[5]);
    const written = Number(fields[9]);
    if (!Number.isFinite(read + written)) continue;
    inBytes += read * SECTOR_BYTES;
    outBytes += written * SECTOR_BYTES;
    seen = true;
  }
  return seen ? { inBytes, outBytes } : undefined;
}

async function readLinuxGpu(): Promise<HostResourceGpu | undefined> {
  const cards = (await readdir("/sys/class/drm").catch(() => [])).filter((name) =>
    /^card\d+$/.test(name),
  );
  let busiest: number | undefined;
  for (const card of cards) {
    const text = await readFile(`/sys/class/drm/${card}/device/gpu_busy_percent`, "utf8").catch(
      () => undefined,
    );
    const value = text === undefined ? Number.NaN : Number(text.trim());
    if (Number.isFinite(value)) busiest = Math.max(busiest ?? 0, value);
  }
  return busiest === undefined ? undefined : { percent: clampPercent(busiest) };
}

async function readLinuxBattery(): Promise<HostResourceEnergy | undefined> {
  const supplies = (await readdir("/sys/class/power_supply").catch(() => [])).filter((name) =>
    /^BAT\d+$/.test(name),
  );
  const first = supplies.sort()[0];
  if (first === undefined) return undefined;
  const base = `/sys/class/power_supply/${first}`;
  const capacity = Number((await readFile(`${base}/capacity`, "utf8").catch(() => "")).trim());
  if (!Number.isFinite(capacity)) return undefined;
  const status = (await readFile(`${base}/status`, "utf8").catch(() => "")).trim();
  return { batteryPercent: clampPercent(capacity), charging: status === "Charging" };
}

export function parseNetstatInterfaces(text: string): CumulativeCounters | undefined {
  const lines = text.split("\n");
  const header = lines[0]?.trim().split(/\s+/);
  const ibytes = header?.indexOf("Ibytes") ?? -1;
  const obytes = header?.indexOf("Obytes") ?? -1;
  if (header === undefined || ibytes < 0 || obytes < 0) return undefined;
  const counted = new Set<string>();
  let inBytes = 0;
  let outBytes = 0;
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    const name = fields[0];
    // One row per interface carries a <Link#n> network; later rows repeat it per address.
    if (name === undefined || name.startsWith("lo") || counted.has(name)) continue;
    if (!(fields[2] ?? "").startsWith("<Link#")) continue;
    // Rows without a MAC address drop one column, so index from the header's end.
    const shift = fields.length - header.length;
    const received = Number(fields[ibytes + shift]);
    const sent = Number(fields[obytes + shift]);
    if (!Number.isFinite(received + sent)) continue;
    counted.add(name);
    inBytes += received;
    outBytes += sent;
  }
  return counted.size === 0 ? undefined : { inBytes, outBytes };
}

export function parseIoregDiskStatistics(text: string): CumulativeCounters | undefined {
  let inBytes = 0;
  let outBytes = 0;
  let seen = false;
  for (const match of text.matchAll(/"Bytes \(Read\)"=(\d+)/g)) {
    inBytes += Number(match[1]);
    seen = true;
  }
  for (const match of text.matchAll(/"Bytes \(Write\)"=(\d+)/g)) outBytes += Number(match[1]);
  return seen ? { inBytes, outBytes } : undefined;
}

export function parseIoregGpu(text: string): HostResourceGpu | undefined {
  let busiest: number | undefined;
  for (const match of text.matchAll(/"Device Utilization %"=(\d+)/g)) {
    busiest = Math.max(busiest ?? 0, Number(match[1]));
  }
  return busiest === undefined ? undefined : { percent: clampPercent(busiest) };
}

export function parsePmsetBattery(text: string): HostResourceEnergy | undefined {
  const percent = /(\d+)%/.exec(text);
  if (percent === null || !/InternalBattery/.test(text)) return undefined;
  return {
    batteryPercent: clampPercent(Number(percent[1])),
    charging: /;\s*(charging|finishing charge)/.test(text),
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function run(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4_000_000 },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(stdout);
      },
    );
  });
}
