import type { HostMemoryPressureLevel, HostMemoryStatus } from "@octant/contracts/host-control";

export interface HostMemoryNotice {
  /** Stable for one event, so a dismissed notice stays dismissed. */
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

const PRESSURE_LABEL: Readonly<Record<HostMemoryPressureLevel, string>> = {
  normal: "Normal",
  elevated: "Low",
  critical: "Very low",
};

export function hostMemoryFact(memory: HostMemoryStatus): string {
  return `${PRESSURE_LABEL[memory.pressure]}, host using ${memory.processMegabytes} MB`;
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function reliefDetail(relief: NonNullable<HostMemoryStatus["lastRelief"]>): string {
  const parts: string[] = [];
  if (relief.idleProviderRuntimesStopped > 0) {
    parts.push(
      `stopped ${count(relief.idleProviderRuntimesStopped, "idle provider process", "idle provider processes")}`,
    );
  }
  if (relief.idleSessionsReleased > 0) {
    parts.push(`released ${count(relief.idleSessionsReleased, "paused session")}`);
  }
  const what =
    parts.length > 0
      ? `Memory was running low, so Octant ${parts.join(" and ")}.`
      : "Memory was running low. Octant trimmed its caches and left the rest running.";
  return relief.activeTurnsKept > 0
    ? `${what} ${count(relief.activeTurnsKept, "running turn")} kept going.`
    : what;
}

export function hostReliefFact(relief: NonNullable<HostMemoryStatus["lastRelief"]>): string {
  return `${formatMemoryEventTime(relief.at)}: stopped ${count(relief.idleProviderRuntimesStopped, "idle provider process", "idle provider processes")}, released ${count(relief.idleSessionsReleased, "paused session")}, ${count(relief.activeTurnsKept, "running turn")} kept going`;
}

function stopDetail(stop: NonNullable<HostMemoryStatus["previousStop"]>): string {
  const reading =
    stop.pressure === "normal"
      ? `At the last reading memory looked normal and the host held ${stop.processMegabytes} MB, so the cause is not known.`
      : `At the last reading memory was ${stop.pressure === "critical" ? "very low" : "low"} and the host held ${stop.processMegabytes} MB.`;
  return `Octant ended without a clean stop and is running again. ${reading}`;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatMemoryEventTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : timeFormatter.format(date);
}

/**
 * What the person should hear about, oldest cause first. A relief that only
 * trimmed caches at moderate pressure is not worth a notice: the quiet rule is
 * that Octant speaks when it stopped something or when memory is very low.
 */
export function hostMemoryNotices(
  memory: HostMemoryStatus | undefined,
): ReadonlyArray<HostMemoryNotice> {
  if (memory === undefined) return [];
  const notices: HostMemoryNotice[] = [];
  if (memory.previousStop !== undefined) {
    notices.push({
      id: `stop:${memory.previousStop.lastSeenAt}`,
      title: "Octant stopped unexpectedly",
      detail: stopDetail(memory.previousStop),
    });
  }
  const relief = memory.lastRelief;
  if (
    relief !== undefined &&
    (relief.pressure === "critical" ||
      relief.idleProviderRuntimesStopped + relief.idleSessionsReleased > 0)
  ) {
    notices.push({
      id: `relief:${relief.at}`,
      title: "Octant freed memory",
      detail: reliefDetail(relief),
    });
  }
  return notices;
}
