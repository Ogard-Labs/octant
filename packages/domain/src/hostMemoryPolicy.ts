export type HostMemoryPressure = "normal" | "elevated" | "critical";

/** What the operating system says about memory, before the host adds its own size. */
export type SystemMemorySignal = "normal" | "warning" | "critical" | "unknown";

export interface HostMemoryReading {
  readonly system: SystemMemorySignal;
  readonly processRssBytes: number;
  /** Physical memory of the machine; zero when it could not be read. */
  readonly totalBytes: number;
}

export interface HostMemoryClassification {
  readonly pressure: HostMemoryPressure;
  /** Which reading raised the pressure, so a notice can say where it came from. */
  readonly source: "none" | "system" | "process" | "both";
}

const GIB = 1024 ** 3;
const ELEVATED_PROCESS_BYTES = 2 * GIB;
const CRITICAL_PROCESS_BYTES = 4 * GIB;
const ELEVATED_PROCESS_SHARE = 0.25;
const CRITICAL_PROCESS_SHARE = 0.5;

/** The same level and a second relief within this window is skipped. */
export const HOST_MEMORY_RELIEF_COOLDOWN_MS = 60_000;

const RANK: Readonly<Record<HostMemoryPressure, number>> = { normal: 0, elevated: 1, critical: 2 };

function fromSystem(signal: SystemMemorySignal): HostMemoryPressure {
  if (signal === "critical") return "critical";
  if (signal === "warning") return "elevated";
  return "normal";
}

/**
 * The host's own size counts as pressure on its own: a host that holds half a
 * small machine starves everything else long before the system signal moves.
 * The limits shrink with the machine and never exceed their fixed ceilings.
 */
function fromProcess(reading: HostMemoryReading): HostMemoryPressure {
  const known = reading.totalBytes > 0;
  const elevatedAt = known
    ? Math.min(ELEVATED_PROCESS_BYTES, reading.totalBytes * ELEVATED_PROCESS_SHARE)
    : ELEVATED_PROCESS_BYTES;
  const criticalAt = known
    ? Math.min(CRITICAL_PROCESS_BYTES, reading.totalBytes * CRITICAL_PROCESS_SHARE)
    : CRITICAL_PROCESS_BYTES;
  if (reading.processRssBytes >= criticalAt) return "critical";
  if (reading.processRssBytes >= elevatedAt) return "elevated";
  return "normal";
}

export function classifyHostMemory(reading: HostMemoryReading): HostMemoryClassification {
  const system = fromSystem(reading.system);
  const process = fromProcess(reading);
  const pressure = RANK[system] >= RANK[process] ? system : process;
  if (pressure === "normal") return { pressure, source: "none" };
  if (RANK[system] === RANK[process]) return { pressure, source: "both" };
  return { pressure, source: RANK[system] > RANK[process] ? "system" : "process" };
}

export interface HostMemoryReliefInput {
  readonly pressure: HostMemoryPressure;
  readonly now: number;
  readonly lastRelief: { readonly at: number; readonly pressure: HostMemoryPressure } | undefined;
}

/**
 * Relief runs on the first pressure reading, whenever pressure rises, and then
 * at most once per cooldown while it stays: a sampled loop must not stop a
 * provider process the person has just started again every few seconds.
 */
export function shouldRelieveHostMemory(input: HostMemoryReliefInput): boolean {
  if (input.pressure === "normal") return false;
  if (input.lastRelief === undefined) return true;
  if (RANK[input.pressure] > RANK[input.lastRelief.pressure]) return true;
  return input.now - input.lastRelief.at >= HOST_MEMORY_RELIEF_COOLDOWN_MS;
}
