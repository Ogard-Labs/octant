import type { AutomationRunLifecycle, AutomationSummary } from "@octant/contracts";
import type { AutomationFormatOptions } from "./automationCenterModel";

/** How many recent runs a row draws, oldest on the left. */
export const RUN_STRIP_LENGTH = 7;

export type RunStripTone = "success" | "failure" | "active" | "quiet" | "empty";

export interface RunStripCell {
  readonly tone: RunStripTone;
  readonly lifecycle?: AutomationRunLifecycle;
  readonly at?: string;
}

type RecentRun = { readonly lifecycle: AutomationRunLifecycle; readonly at: string };

function runTone(lifecycle: AutomationRunLifecycle): RunStripTone {
  switch (lifecycle) {
    case "completed":
      return "success";
    case "failed":
    case "interrupted":
      return "failure";
    case "queued":
    case "dispatching":
    case "recovering-dispatch":
    case "running":
    case "waiting":
      return "active";
    case "cancelled":
    case "skipped":
      return "quiet";
  }
}

/**
 * The last runs as a fixed row of seven cells, oldest first. A routine with
 * fewer runs keeps empty cells on the left, so every row's newest run sits in
 * the same column and a run arriving shifts the row by one cell, never its width.
 */
export function runStripCells(
  recentRuns: ReadonlyArray<RecentRun> | undefined,
): ReadonlyArray<RunStripCell> {
  const runs = (recentRuns ?? []).slice(-RUN_STRIP_LENGTH);
  const empty: ReadonlyArray<RunStripCell> = Array.from(
    { length: RUN_STRIP_LENGTH - runs.length },
    () => ({ tone: "empty" }),
  );
  return [
    ...empty,
    ...runs.map((run) => ({ tone: runTone(run.lifecycle), lifecycle: run.lifecycle, at: run.at })),
  ];
}

/** The strip in words, for its accessible name: "Last 7 runs: 5 completed, 2 failed". */
export function runStripSummary(recentRuns: ReadonlyArray<RecentRun> | undefined): string {
  const runs = (recentRuns ?? []).slice(-RUN_STRIP_LENGTH);
  if (runs.length === 0) return "No runs yet";
  const counts = new Map<string, number>();
  for (const run of runs) {
    const word =
      runTone(run.lifecycle) === "success"
        ? "completed"
        : runTone(run.lifecycle) === "failure"
          ? "failed"
          : runTone(run.lifecycle) === "active"
            ? "running"
            : "skipped";
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const parts = ["completed", "failed", "running", "skipped"].flatMap((word) => {
    const count = counts.get(word);
    return count === undefined ? [] : [`${String(count)} ${word}`];
  });
  return `Last ${String(runs.length)} ${runs.length === 1 ? "run" : "runs"}: ${parts.join(", ")}`;
}

/** "21h 55m", "2d 8h", "12m", "now": a span short enough for a table cell. */
export function compactSpan(milliseconds: number): string {
  const minutes = Math.floor(Math.abs(milliseconds) / 60_000);
  if (minutes < 1) return "now";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours === 0 ? `${String(days)}d` : `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(minutes)}m`;
}

export interface NextRunCell {
  /** The first line: when, or what state stands in for when. */
  readonly primary: string;
  /** The quiet second line: how far off, or how long since the last run. */
  readonly secondary?: string;
  readonly tone: "default" | "paused" | "quiet";
}

/**
 * The Next run column. A scheduled routine names the day and time and how far
 * off it is; one that waits on an event or files says so; a paused one says
 * Paused, and both of those say when it last ran, because "when did this last
 * do anything" is the question a row with no next run leaves.
 */
export function nextRunCell(
  summary: Pick<
    AutomationSummary,
    "lifecycle" | "trigger" | "nextDueAt" | "recentRuns" | "latestRunLifecycle"
  >,
  now: string,
  options: AutomationFormatOptions = {},
): NextRunCell {
  const lastRunAt = summary.recentRuns?.at(-1)?.at;
  const sinceSpan =
    lastRunAt === undefined ? undefined : compactSpan(Date.parse(now) - Date.parse(lastRunAt));
  const since =
    sinceSpan === undefined
      ? undefined
      : sinceSpan === "now"
        ? "last just now"
        : `last ${sinceSpan} ago`;
  if (summary.lifecycle === "paused") {
    return {
      primary: "Paused",
      ...(since === undefined ? {} : { secondary: since }),
      tone: "paused",
    };
  }
  if (summary.lifecycle === "archived") {
    return {
      primary: "Archived",
      ...(since === undefined ? {} : { secondary: since }),
      tone: "quiet",
    };
  }
  if (summary.trigger.kind === "integration-event") {
    return {
      primary: "On event",
      ...(since === undefined ? {} : { secondary: since }),
      tone: "default",
    };
  }
  if (summary.trigger.kind === "file-arrival") {
    return {
      primary: "On new files",
      ...(since === undefined ? {} : { secondary: since }),
      tone: "default",
    };
  }
  if (summary.nextDueAt === null) {
    return {
      primary: summary.trigger.kind === "once" ? "Done" : "Not scheduled",
      ...(since === undefined ? {} : { secondary: since }),
      tone: "quiet",
    };
  }
  const due = Date.parse(summary.nextDueAt);
  const span = due - Date.parse(now);
  return {
    primary: new Intl.DateTimeFormat("en-GB", {
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(due)),
    secondary: span <= 60_000 ? "due now" : `in ${compactSpan(span)}`,
    tone: "default",
  };
}

/** "25 of 100 enabled · 299 runs in 30 days · 49.8% succeeded". */
export function automationTotalsLine(totals: {
  readonly automations: number;
  readonly enabled: number;
  readonly windowDays: number;
  readonly runs: number;
  readonly succeeded: number;
}): string {
  const parts = [`${String(totals.enabled)} of ${String(totals.automations)} enabled`];
  parts.push(
    `${String(totals.runs)} ${totals.runs === 1 ? "run" : "runs"} in ${String(totals.windowDays)} days`,
  );
  if (totals.runs > 0) {
    const share = Math.round((totals.succeeded / totals.runs) * 1000) / 10;
    parts.push(`${String(share)}% succeeded`);
  }
  return parts.join(" · ");
}
