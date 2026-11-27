import {
  mobileSubagentIsActive,
  type MobileProviderDirectoryEntry,
  type MobileSubagent,
} from "@octant/client-runtime";

export type SubagentTone = "working" | "done" | "failed" | "stopped";

/** The word a row shows for the host's lifecycle status, and its colour role. */
export function subagentStatus(status: string): {
  readonly label: string;
  readonly tone: SubagentTone;
} {
  switch (status) {
    case "queued":
      return { label: "Queued", tone: "working" };
    case "starting":
      return { label: "Starting", tone: "working" };
    case "running":
      return { label: "Running", tone: "working" };
    case "waiting":
      return { label: "Waiting", tone: "working" };
    case "completed":
      return { label: "Completed", tone: "done" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "cancelled":
      return { label: "Stopped", tone: "stopped" };
    case "interrupted":
      return { label: "Interrupted", tone: "failed" };
    default:
      return { label: "Unknown", tone: "stopped" };
  }
}

/**
 * "5m 21s", "17s", "1h 4m": how long a subagent ran, or has run so far. A
 * finished one's time stops at its last update. Empty when the start is unknown.
 */
export function subagentRunTime(subagent: MobileSubagent, now: number): string {
  if (subagent.startedAt === undefined) return "";
  const started = Date.parse(subagent.startedAt);
  const ended = mobileSubagentIsActive(subagent.status) ? now : Date.parse(subagent.updatedAt);
  const seconds = Math.max(0, Math.floor((ended - started) / 1_000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function capitalized(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

/**
 * "Claude · Opus 5.5 · Medium": where the subagent runs, by the names the
 * computer's provider list gives, falling back to the ids it reported.
 */
export function subagentRouteLabel(
  subagent: MobileSubagent,
  directory: ReadonlyArray<MobileProviderDirectoryEntry>,
): string {
  const provider = directory.find(
    (entry) => entry.providerInstanceId === subagent.providerInstanceId,
  );
  const model =
    subagent.modelId === undefined
      ? undefined
      : (provider?.models.find((entry) => entry.modelId === subagent.modelId)?.displayName ??
        subagent.modelId);
  return [
    provider?.displayName,
    model,
    subagent.effort === undefined ? undefined : capitalized(subagent.effort),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" · ");
}

/** A subagent's title: its task's first line, or a stand-in when none was given. */
export function subagentTitle(subagent: MobileSubagent): string {
  const line = subagent.task
    .split("\n")
    .find((part) => part.trim().length > 0)
    ?.trim();
  return line ?? "Subagent";
}

/**
 * The subagents in the order a person reads them: those at work first, then
 * the rest, each part in the host's order.
 */
export function orderedSubagents(
  subagents: ReadonlyArray<MobileSubagent>,
): ReadonlyArray<MobileSubagent> {
  return [
    ...subagents.filter((subagent) => mobileSubagentIsActive(subagent.status)),
    ...subagents.filter((subagent) => !mobileSubagentIsActive(subagent.status)),
  ];
}

/**
 * The pill over the composer: "2 running · 1 failed · 11 done", naming only
 * the counts that are not zero. Undefined when the thread has no subagents.
 */
export function subagentsPillLabel(subagents: ReadonlyArray<MobileSubagent>): string | undefined {
  if (subagents.length === 0) return undefined;
  let running = 0;
  let failed = 0;
  let done = 0;
  for (const subagent of subagents) {
    const { tone } = subagentStatus(subagent.status);
    if (tone === "working") running += 1;
    else if (tone === "failed") failed += 1;
    else done += 1;
  }
  return [
    running > 0 ? `${running} running` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    done > 0 ? `${done} done` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}
