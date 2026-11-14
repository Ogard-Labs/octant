import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { Activity } from "lucide-react";
import { useMemo } from "react";
import { elapsedLabel, relativeTimeLabel } from "../lib/relativeTime";
import type { HomeListCardDefinition, HomeListRead } from "./homeCards";
import { workingNowListRow } from "./homeListRows";
import { useActiveAgentRuns } from "./useActiveAgentRuns";
import {
  buildWorkingNowRows,
  type WorkingNowInput,
  type WorkingNowRow,
} from "./workingNow";

export const WORKING_NOW_CARD_ID = "working-now";

/** The one quiet line both the card and the Running tab say when nothing is running. */
export const WORKING_NOW_EMPTY_LABEL = "Nothing is running right now.";

export interface WorkingNowCardSource extends Omit<WorkingNowInput, "runs"> {
  /** This window's AgentRun reader; without one only threads are listed. */
  readonly agentRunClient: AgentRunClient | undefined;
  /** Bumps when the thread lists change, so the run read follows them. */
  readonly runRevision: number;
  /** The clock the age labels read, advanced once a minute by the shell. */
  readonly now: number;
  readonly onOpenRow: (row: WorkingNowRow) => void;
  /** Opens the Running view, which lists every row the card cannot fit. */
  readonly onOpenRunning: () => void;
}

/**
 * The Working now card: threads and agent runs in progress across Projects,
 * read from the navigation rows and AgentRun projection the shell already
 * holds. It is never unavailable (a window always sees its own threads). Like
 * Needs you it leaves the grid while nothing runs: an empty card saying so
 * stood beside the start screen's other cards on every visit.
 */
export function createWorkingNowCard(source: WorkingNowCardSource): HomeListCardDefinition {
  return {
    id: WORKING_NOW_CARD_ID,
    title: "Working now",
    icon: Activity,
    defaultOn: true,
    available: true,
    useListRows: () => useWorkingNowListRows(source),
  };
}

/** The rows the card lists, for the start screen's list; "See all" is the Running view. */
function useWorkingNowListRows(source: WorkingNowCardSource): HomeListRead {
  const rows = useWorkingNowRows(source);
  return {
    status: "ready",
    seeAll: { "in-progress": { label: "See all", onSelect: source.onOpenRunning } },
    rows: rows.map((row) => workingNowListRow(row, source.now, () => source.onOpenRow(row))),
  };
}

/**
 * The rows the card lists, newest first. The Running tab on the composer reads
 * the same hook, so the two never list different work.
 */
export function useWorkingNowRows(source: WorkingNowCardSource): ReadonlyArray<WorkingNowRow> {
  const runs = useActiveAgentRuns(source.agentRunClient, source.runRevision);
  const { threads, modes, projectNames, providers, boardFacts, host } = source;
  return useMemo(
    () =>
      buildWorkingNowRows({
        threads,
        modes,
        projectNames,
        providers,
        boardFacts,
        runs,
        ...(host === undefined ? {} : { host }),
      }),
    [boardFacts, host, modes, projectNames, providers, runs, threads],
  );
}

/** Work with a known start says how long it has run; a thread whose host reports none says when it last moved. */
export function WorkingNowTime(props: { readonly row: WorkingNowRow; readonly now: number }) {
  const { row } = props;
  if (row.startedAt !== undefined) {
    return (
      <span className="oct-meta working-now__time">{`Running ${elapsedLabel(row.startedAt, props.now)}`}</span>
    );
  }
  if (row.activeAt !== undefined) {
    return (
      <span className="oct-meta working-now__time">{`Active ${relativeTimeLabel(row.activeAt, props.now)}`}</span>
    );
  }
  return null;
}
