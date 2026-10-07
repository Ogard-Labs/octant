import { useEffect, useRef, useState } from "react";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantButton } from "../ui/base/OctantButton";
import type { StopRowOutcome } from "./stopRunningRow";
import {
  useWorkingNowRows,
  WORKING_NOW_EMPTY_LABEL,
  WorkingNowTime,
  type WorkingNowCardSource,
} from "./WorkingNowCard";
import type { WorkingNowRow } from "./workingNow";

export interface RunningTabProps {
  /** The Working now card's own source, so both list the same rows. */
  readonly source: WorkingNowCardSource;
  /** Stops what a row shows through the mode's existing stop command. */
  readonly onStop: (row: WorkingNowRow) => Promise<StopRowOutcome>;
}

/**
 * The Running tab: every row the Working now card would list, without its
 * five-row limit, each with Open and Stop.
 */
export function RunningTab(props: RunningTabProps) {
  const rows = useWorkingNowRows(props.source);
  if (rows.length === 0) {
    return <p className="oct-row-detail running-tab__quiet">{WORKING_NOW_EMPTY_LABEL}</p>;
  }
  return (
    <ul aria-label="Running now" className="running-tab__list">
      {rows.map((row) => (
        <RunningRow
          key={row.key}
          now={props.source.now}
          onOpen={() => props.source.onOpenRow(row)}
          onStop={() => props.onStop(row)}
          row={row}
        />
      ))}
    </ul>
  );
}

type StopPhase =
  | { readonly kind: "idle"; readonly note?: string }
  | { readonly kind: "confirming" }
  | { readonly kind: "stopping" };

function RunningRow(props: {
  readonly row: WorkingNowRow;
  readonly now: number;
  readonly onOpen: () => void;
  readonly onStop: () => Promise<StopRowOutcome>;
}) {
  const { row } = props;
  const [phase, setPhase] = useState<StopPhase>({ kind: "idle" });
  const stopRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Focus follows the swap: the safe answer takes it when the question opens,
  // and the Stop control gets it back when the person keeps the work running.
  const previousKind = useRef(phase.kind);
  useEffect(() => {
    if (previousKind.current !== phase.kind) {
      if (phase.kind === "confirming") keepRef.current?.focus();
      else if (previousKind.current === "confirming" && phase.kind === "idle") {
        stopRef.current?.focus();
      }
    }
    previousKind.current = phase.kind;
  }, [phase.kind]);

  async function stop() {
    setPhase({ kind: "stopping" });
    const outcome = await props.onStop();
    if (!mounted.current) return;
    setPhase({
      kind: "idle",
      note:
        outcome.kind === "stopped"
          ? "Stopped."
          : outcome.kind === "nothing-running"
            ? "Already finished."
            : outcome.message,
    });
  }

  const subject = row.runId === undefined ? "turn" : "agent run";
  return (
    <li className="running-tab__row" data-phase={phase.kind}>
      <div className="working-now__face running-tab__face">
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
        {phase.kind === "idle" && phase.note !== undefined ? (
          <span className="oct-meta running-tab__note" role="status">
            {phase.note}
          </span>
        ) : null}
      </div>
      {phase.kind === "confirming" ? (
        <div
          aria-label={`Confirm stopping ${row.title}`}
          className="running-tab__confirm"
          role="group"
        >
          <span className="oct-meta">{`Stop this ${subject}?`}</span>
          <OctantButton
            aria-label={`Stop ${row.title} now`}
            onClick={() => void stop()}
            size="xs"
            type="button"
            variant="destructive"
          >
            Stop
          </OctantButton>
          <OctantButton
            onClick={() => setPhase({ kind: "idle" })}
            ref={keepRef}
            size="xs"
            type="button"
            variant="ghost"
          >
            Keep running
          </OctantButton>
        </div>
      ) : (
        <div className="running-tab__actions">
          <OctantButton
            aria-label={`Open ${row.title}`}
            onClick={props.onOpen}
            size="xs"
            type="button"
            variant="ghost"
          >
            Open
          </OctantButton>
          <OctantButton
            aria-label={`Stop ${row.title}`}
            disabled={phase.kind === "stopping"}
            onClick={() => setPhase({ kind: "confirming" })}
            ref={stopRef}
            size="xs"
            type="button"
            variant="ghost"
          >
            {phase.kind === "stopping" ? "Stopping…" : "Stop"}
          </OctantButton>
        </div>
      )}
    </li>
  );
}
