import type { MobileContextMeter, MobileDiffFile, MobileInboxMode } from "@octant/client-runtime";
import type { CodeBoardCard, LocalServerListener } from "@octant/contracts";
import { formatExactCount, formatTokenCount } from "@octant/domain";

export type MobileThreadPaneId = "environment" | "review" | "context" | "agents";

export interface MobileThreadPaneOption {
  readonly id: MobileThreadPaneId;
  readonly label: string;
}

/**
 * The thread's side panes the phone offers, read-only, in the desktop dock's
 * order. Environment and Review describe a Code checkout, so only a Code
 * thread has them; every mode has Context & usage and Agents, as the desktop
 * Thread info and Agents tool do.
 */
export function listMobileThreadPanes(
  mode: MobileInboxMode,
): ReadonlyArray<MobileThreadPaneOption> {
  const every: ReadonlyArray<MobileThreadPaneOption> = [
    { id: "context", label: "Context" },
    { id: "agents", label: "Agents" },
  ];
  if (mode !== "code") return every;
  // "Environment" does not fit a quarter of a phone's width; the sheet's
  // title names the pane in full.
  return [{ id: "environment", label: "Env" }, { id: "review", label: "Review" }, ...every];
}

/** `+42 −12`, the desktop's diffstat, with a true minus sign. */
export function diffstatText(additions: number, deletions: number): string {
  return `+${formatExactCount(additions)} −${formatExactCount(deletions)}`;
}

/** The working tree's totals across every file the diff carried. */
export function workingTreeTotals(files: ReadonlyArray<MobileDiffFile>): {
  readonly additions: number;
  readonly deletions: number;
} {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export interface ContextMeterPresentation {
  /** 0..1 for the bar; absent when there is nothing measured to draw. */
  readonly fraction?: number;
  readonly label: string;
  readonly note: string;
}

/**
 * The context meter in words. The phone never estimates: a window the host
 * did not plan or the provider did not report says so instead of a bar.
 */
export function contextMeterPresentation(meter: MobileContextMeter): ContextMeterPresentation {
  if (meter.kind === "not-planned") {
    return { label: "No context plan yet", note: "The host plans the context on the next turn." };
  }
  if (meter.kind === "unreported") {
    return {
      label: "Not reported",
      note: "The provider has not reported this thread's context window.",
    };
  }
  const fraction = Math.min(1, meter.usedTokens / meter.windowTokens);
  const percent = Math.floor(fraction * 100);
  return {
    fraction,
    label: `${formatTokenCount(meter.usedTokens)} of ${formatTokenCount(meter.windowTokens)} (${percent}%)`,
    note:
      meter.source === "provider-reported"
        ? "As the provider reported it after the latest turn."
        : "The host's plan for the next turn.",
  };
}

/**
 * The subagent counts the desktop Environment's Subagents row states:
 * working, to review, and done. Failed runs are named only when there are
 * some; with nothing delegated the row says None rather than vanishing.
 */
export function subagentSummary(agents: CodeBoardCard["childAgents"]): string {
  const parts = [
    agents.active > 0 ? `${agents.active} working` : undefined,
    agents.unacknowledgedResults > 0 ? `${agents.unacknowledgedResults} to review` : undefined,
    agents.completed > 0 ? `${agents.completed} done` : undefined,
    agents.failed > 0 ? `${agents.failed} failed` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "None" : parts.join(" · ");
}

/** One local server as a row: what it is and whether the host found it answering. */
export function localServerRow(listener: LocalServerListener): {
  readonly label: string;
  readonly detail: string;
} {
  const health =
    listener.health === "listening"
      ? "Listening"
      : listener.health === "unresponsive"
        ? "Not answering"
        : "Not determined";
  return {
    label: `${listener.framework ?? listener.processName} · :${listener.port}`,
    detail: health,
  };
}

/** A folder's last component: the phone never shows a host's absolute path. */
export function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
