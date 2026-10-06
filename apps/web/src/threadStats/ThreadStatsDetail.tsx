import { threadStats, threadStatsInputOf, turnDetail, type TurnDetailRow } from "@octant/domain";
import type { TurnMetricsRecord } from "@octant/contracts";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { useThreadStatsScope } from "./threadStatsScope";
import "./threadStats.css";

/**
 * One turn at a time: tokens, timing, and cost, with the whole thread's
 * figures beneath. Opened from the quiet line or from the context meter, so it
 * is there whether or not the line is shown. The app mounts it once.
 */
export function ThreadStatsDetailDialog() {
  const scope = useThreadStatsScope();
  if (scope.summary === undefined) return null;
  return (
    <ThreadStatsDetail
      onClose={scope.closeDetail}
      open={scope.detailOpen}
      summary={scope.summary}
    />
  );
}

function ThreadStatsDetail(props: {
  readonly onClose: () => void;
  readonly open: boolean;
  readonly summary: NonNullable<ReturnType<typeof useThreadStatsScope>["summary"]>;
}) {
  const titleId = useId();
  const stats = useMemo(() => threadStats(threadStatsInputOf(props.summary)), [props.summary]);
  const { turns, turnCount } = props.summary;
  const [index, setIndex] = useState(turns.length - 1);
  useEffect(() => {
    // A new turn lands at the end; a reader on the latest stays on the latest.
    setIndex(turns.length - 1);
  }, [turns.length, props.open]);
  const turn = turns[Math.min(Math.max(index, 0), turns.length - 1)];
  const position = turn === undefined ? 0 : turnCount - turns.length + turns.indexOf(turn) + 1;
  return (
    <OctantDialog
      className="thread-stats-dialog"
      label="Turn details"
      labelledBy={titleId}
      onClose={props.onClose}
      open={props.open}
    >
      <div className="thread-stats-detail" data-testid="thread-stats-detail">
        <header className="thread-stats-detail__header">
          <h2 className="thread-stats-detail__title" id={titleId}>
            Turn details
          </h2>
          {turn === undefined ? null : (
            <div className="thread-stats-detail__nav">
              <OctantButton
                aria-label="Previous turn"
                disabled={index <= 0}
                onClick={() => setIndex((current) => current - 1)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <ChevronLeft aria-hidden="true" size={14} />
              </OctantButton>
              <span aria-live="polite" className="thread-stats-detail__position">
                Turn {position} of {turnCount}
              </span>
              <OctantButton
                aria-label="Next turn"
                disabled={index >= turns.length - 1}
                onClick={() => setIndex((current) => current + 1)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <ChevronRight aria-hidden="true" size={14} />
              </OctantButton>
            </div>
          )}
        </header>
        {turn === undefined ? null : <TurnSections turn={turn} />}
        {stats.length === 0 ? null : (
          <section aria-label="Whole thread" className="thread-stats-detail__section">
            <h3>Whole thread</h3>
            <ul className="thread-stats-detail__totals">
              {stats.map((stat) => (
                <li key={stat.key}>
                  {stat.label}
                  {stat.hint === undefined ? null : (
                    <span className="thread-stats-detail__hint">{stat.hint}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </OctantDialog>
  );
}

function TurnSections(props: { readonly turn: TurnMetricsRecord }) {
  const detail = useMemo(() => turnDetail(props.turn), [props.turn]);
  return (
    <>
      <p className="thread-stats-detail__subject">
        {String(props.turn.modelId)} · {formatClock(props.turn.endedAt)}
      </p>
      {detail.tokens.length === 0 ? null : <DetailSection rows={detail.tokens} title="Tokens" />}
      <DetailSection rows={detail.timing} title="Timing" />
      {detail.cost === undefined ? null : <DetailSection rows={[detail.cost]} title="Cost" />}
      {detail.notes.map((note) => (
        <p className="thread-stats-detail__note" key={note}>
          {note}
        </p>
      ))}
    </>
  );
}

function DetailSection(props: {
  readonly rows: ReadonlyArray<TurnDetailRow>;
  readonly title: string;
}) {
  return (
    <section aria-label={props.title} className="thread-stats-detail__section">
      <h3>{props.title}</h3>
      <dl className="thread-stats-detail__rows">
        {props.rows.map((row) => (
          <div key={row.key}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
            {row.hint === undefined ? null : (
              <dd className="thread-stats-detail__hint">{row.hint}</dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
