import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { Activity } from "lucide-react";
import { useMemo } from "react";
import { elapsedLabel, relativeTimeLabel } from "../lib/relativeTime";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantButton } from "../ui/base/OctantButton";
import type { HomeCardContent, HomeCardDefinition } from "./homeCards";
import { useActiveAgentRuns } from "./useActiveAgentRuns";
import {
  buildWorkingNowRows,
  WORKING_NOW_ROW_LIMIT,
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
 * holds. It is never unavailable (a window always sees its own threads), and
 * says so in one line when nothing is running.
 */
export function createWorkingNowCard(source: WorkingNowCardSource): HomeCardDefinition {
  return {
    id: WORKING_NOW_CARD_ID,
    title: "Working now",
    icon: Activity,
    defaultOn: true,
    available: true,
    emptyLabel: WORKING_NOW_EMPTY_LABEL,
    useContent: () => useWorkingNowContent(source),
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

function useWorkingNowContent(source: WorkingNowCardSource): HomeCardContent {
  const rows = useWorkingNowRows(source);
  return {
    status: "ready",
    count: rows.length,
    body: (
      <WorkingNowRows
        now={source.now}
        onOpenRow={source.onOpenRow}
        onOpenRunning={source.onOpenRunning}
        rows={rows}
      />
    ),
  };
}

function WorkingNowRows(props: {
  readonly rows: ReadonlyArray<WorkingNowRow>;
  readonly now: number;
  readonly onOpenRow: (row: WorkingNowRow) => void;
  readonly onOpenRunning: () => void;
}) {
  const shown = props.rows.slice(0, WORKING_NOW_ROW_LIMIT);
  const hidden = props.rows.length - shown.length;
  return (
    <>
      <ul className="working-now__list">
        {shown.map((row) => (
          <li key={row.key}>
            <OctantButton
              className="working-now__row window-no-drag"
              onClick={() => props.onOpenRow(row)}
              type="button"
              variant="bare"
            >
              <span className="working-now__face">
                <span className="working-now__head">
                  {row.provider === undefined ? null : (
                    <ProviderGlyph
                      className="working-now__provider"
                      displayName={row.provider.displayName}
                      driverKind={row.provider.driverKind}
                      size={16}
                    />
                  )}
                  <span className="oct-row-label working-now__title">{row.title}</span>
                  <WorkingNowTime now={props.now} row={row} />
                </span>
                {row.step === undefined &&
                row.projectName === undefined &&
                row.host === undefined ? null : (
                  <span className="working-now__line">
                    {row.step === undefined ? (
                      <span className="oct-meta working-now__step">{row.projectName}</span>
                    ) : (
                      <span
                        className={
                          row.stepKind === "status"
                            ? "oct-meta working-now__step"
                            : "oct-meta oct-meta--mono working-now__step"
                        }
                        title={row.step}
                      >
                        {row.step}
                      </span>
                    )}
                    {row.host === undefined ? null : (
                      <span className="oct-meta working-now__host">{row.host}</span>
                    )}
                  </span>
                )}
              </span>
            </OctantButton>
          </li>
        ))}
      </ul>
      {hidden <= 0 ? null : (
        <OctantButton
          className="working-now__more window-no-drag"
          onClick={props.onOpenRunning}
          size="sm"
          type="button"
          variant="link"
        >
          {`+${String(hidden)} more`}
        </OctantButton>
      )}
    </>
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
