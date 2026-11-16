import type { HostMemoryPressureLevel, HostMemoryStatus } from "@octant/contracts/host-control";

export interface HostMemoryNotice {
  /** Stable for one event, so a dismissed notice stays dismissed. */
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Reports something Octant did and asks nothing: it may leave by itself. */
  readonly transient: boolean;
}

const PRESSURE_LABEL: Readonly<Record<HostMemoryPressureLevel, string>> = {
  normal: "Normal",
  elevated: "Low",
  critical: "Very low",
};

/** What the notices and the Memory fact read; the limits belong to the Memory limits control. */
export type HostMemoryReading = Omit<HostMemoryStatus, "limits" | "effectiveLimits">;

export function hostMemoryFact(memory: HostMemoryReading): string {
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

/**
 * Three short sentences: it runs again, what memory read last, and the record
 * kept. The first wording ran to five lines of a notice that stays until it is
 * dismissed, over the top of whatever pane stood under it.
 */
function stopDetail(stop: NonNullable<HostMemoryStatus["previousStop"]>): string {
  const reading =
    stop.pressure === "normal"
      ? `Memory looked normal at the last reading (host at ${stop.processMegabytes} MB), so the cause is not known.`
      : `Memory was ${stop.pressure === "critical" ? "very low" : "low"} at the last reading (host at ${stop.processMegabytes} MB).`;
  const record =
    stop.crashRecord === undefined
      ? ""
      : ` A crash record is kept on this device (${stop.crashRecord.exitReason}, ${formatMemoryEventTime(stop.crashRecord.recordedAt)}). Save diagnostics includes it; nothing was sent.`;
  return `It is running again. ${reading}${record}`;
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
  memory: HostMemoryReading | undefined,
): ReadonlyArray<HostMemoryNotice> {
  if (memory === undefined) return [];
  const notices: HostMemoryNotice[] = [];
  if (memory.previousStop !== undefined) {
    notices.push({
      id: `stop:${memory.previousStop.lastSeenAt}`,
      title: "Octant stopped unexpectedly",
      detail: stopDetail(memory.previousStop),
      transient: false,
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
      transient: true,
    });
  }
  return notices;
}
