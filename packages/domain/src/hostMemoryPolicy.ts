import {
  HOST_MEMORY_LIMIT_MAX_GB,
  HOST_MEMORY_LIMIT_MIN_GB,
  type HostMemoryLimits,
  type HostMemoryLimitsRefusalCode,
  type SetHostMemoryLimitsRequest,
} from "@octant/contracts/host-control";
import { authorizeHostControlAction } from "./hostControlPolicy";
import type { PrincipalKind } from "./remoteAccessPolicy";

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

export interface ResolvedHostMemoryLimits {
  readonly pressuredBytes: number;
  readonly criticalBytes: number;
}

/**
 * The byte limits the host's own size is judged by. Automatic is the fixed
 * pair, shrunk to a share of a small machine; custom is the person's pair, used
 * exactly as given on any machine, because they chose it knowing what else the
 * machine runs.
 */
export function resolveHostMemoryLimits(
  limits: HostMemoryLimits,
  totalBytes: number,
): ResolvedHostMemoryLimits {
  if (limits.kind === "custom") {
    return { pressuredBytes: limits.pressuredGb * GIB, criticalBytes: limits.criticalGb * GIB };
  }
  const known = totalBytes > 0;
  return {
    pressuredBytes: known
      ? Math.min(ELEVATED_PROCESS_BYTES, totalBytes * ELEVATED_PROCESS_SHARE)
      : ELEVATED_PROCESS_BYTES,
    criticalBytes: known
      ? Math.min(CRITICAL_PROCESS_BYTES, totalBytes * CRITICAL_PROCESS_SHARE)
      : CRITICAL_PROCESS_BYTES,
  };
}

/**
 * The host's own size counts as pressure on its own: a host that holds half a
 * small machine starves everything else long before the system signal moves.
 */
function fromProcess(reading: HostMemoryReading, limits: HostMemoryLimits): HostMemoryPressure {
  const { pressuredBytes, criticalBytes } = resolveHostMemoryLimits(limits, reading.totalBytes);
  if (reading.processRssBytes >= criticalBytes) return "critical";
  if (reading.processRssBytes >= pressuredBytes) return "elevated";
  return "normal";
}

export function classifyHostMemory(
  reading: HostMemoryReading,
  limits: HostMemoryLimits = { kind: "automatic" },
): HostMemoryClassification {
  const system = fromSystem(reading.system);
  const process = fromProcess(reading, limits);
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

export type HostMemoryLimitsDecision =
  | { readonly kind: "allow"; readonly limits: HostMemoryLimits }
  | {
      readonly kind: "refused";
      readonly code: HostMemoryLimitsRefusalCode;
      readonly message: string;
    };

const LIMITS_UNAUTHORIZED_MESSAGE = "Memory limits can only be changed on this host.";
const LIMITS_OUT_OF_RANGE_MESSAGE = `Memory limits must be between ${HOST_MEMORY_LIMIT_MIN_GB} and ${HOST_MEMORY_LIMIT_MAX_GB} GB.`;
const LIMITS_ORDER_MESSAGE = "The critical limit must be above the pressured limit.";

function inRange(value: number): boolean {
  return (
    Number.isFinite(value) && value >= HOST_MEMORY_LIMIT_MIN_GB && value <= HOST_MEMORY_LIMIT_MAX_GB
  );
}

/**
 * A change of the memory limits needs a local window, and a custom pair must
 * sit inside the bounds with critical above pressured. A refusal is a value
 * with a message a person can act on, never an exception.
 */
export function decideHostMemoryLimits(input: {
  readonly principalKind: PrincipalKind;
  readonly limits: SetHostMemoryLimitsRequest["limits"];
}): HostMemoryLimitsDecision {
  const authority = authorizeHostControlAction({
    principalKind: input.principalKind,
    operation: "memory-limits",
  });
  if (authority.kind === "deny") {
    return { kind: "refused", code: "unauthorized", message: LIMITS_UNAUTHORIZED_MESSAGE };
  }
  const { limits } = input;
  if (limits.kind === "automatic") return { kind: "allow", limits };
  if (!inRange(limits.pressuredGb) || !inRange(limits.criticalGb)) {
    return { kind: "refused", code: "out-of-range", message: LIMITS_OUT_OF_RANGE_MESSAGE };
  }
  if (limits.criticalGb <= limits.pressuredGb) {
    return {
      kind: "refused",
      code: "critical-not-above-pressured",
      message: LIMITS_ORDER_MESSAGE,
    };
  }
  return { kind: "allow", limits };
}
