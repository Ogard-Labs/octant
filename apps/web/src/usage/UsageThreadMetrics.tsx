import {
  turnDetail,
  usageThreadColumns,
  usageThreadReading,
  type UsageThreadFigureKey,
  type UsageThreadRow,
} from "@octant/domain";
import type { TurnMetricsRecord, TurnMetricsSummary } from "@octant/contracts";
import { useId, useState } from "react";
import { SurfaceSection } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import "../styles/usage.css";
import { UsageName } from "./UsageName";

const COLUMN_LABEL: Readonly<Record<UsageThreadFigureKey, string>> = {
  input: "Input",
  output: "Output",
  cache: "Cache",
  speed: "Speed",
  "first-token": "First token",
  cost: "Cost",
};

/**
 * Per-thread rows and the turn drill-in for a usage reading.
 *
 * The figures are the composer's: cache, speed, first token, and cost come
 * from the shared wording, and a column with nothing to say is left out.
 */
export function UsageThreadMetrics(props: {
  readonly summary: TurnMetricsSummary | undefined;
  /** The query named one thread, so its totals are that thread's. */
  readonly scopedToThread?: boolean;
  readonly isNarrow?: boolean;
}) {
  const reading = usageThreadReading(
    props.summary,
    props.scopedToThread === undefined ? {} : { scopedToThread: props.scopedToThread },
  );
  const columns = usageThreadColumns(reading.rows);
  const [openThreadId, setOpenThreadId] = useState<string | undefined>(undefined);
  if (reading.rows.length === 0) return null;
  return (
    <SurfaceSection
      className="usage-dashboard__section"
      label="Threads"
      note={
        reading.listedTurnsOnly
          ? "Older turns are not in this reading, so a thread's figures here cover only the turns still listed."
          : "The same figures as the line under the composer. A figure the provider did not report is left out."
      }
    >
      <div className="usage-table-scroll">
        <table
          aria-label="Usage by thread"
          className={`usage-dashboard__table usage-thread-metrics${props.isNarrow === true ? " usage-dashboard__table--narrow" : ""}`}
        >
          <thead>
            <tr>
              <th scope="col">Thread</th>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {COLUMN_LABEL[column]}
                </th>
              ))}
              <th scope="col">
                <span className="visually-hidden">Turns</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {reading.rows.map((row) => (
              <ThreadRows
                key={row.threadId}
                columns={columns}
                open={openThreadId === row.threadId}
                row={row}
                onToggle={() =>
                  setOpenThreadId((current) =>
                    current === row.threadId ? undefined : row.threadId,
                  )
                }
              />
            ))}
          </tbody>
        </table>
      </div>
    </SurfaceSection>
  );
}

function ThreadRows(props: {
  readonly columns: ReadonlyArray<UsageThreadFigureKey>;
  readonly open: boolean;
  readonly row: UsageThreadRow;
  readonly onToggle: () => void;
}) {
  const headingId = useId();
  const panelId = useId();
  const kind = `${props.row.mode}-thread`;
  return (
    <>
      <tr>
        <th id={headingId} scope="row">
          <UsageName id={props.row.threadId} kind={kind} />
        </th>
        {props.columns.map((column) => {
          const stat = props.row.stats.find((candidate) => candidate.key === column);
          return (
            <td key={column}>
              {stat === undefined ? null : (
                <span
                  aria-label={stat.label}
                  {...(stat.hint === undefined ? {} : { title: stat.hint })}
                >
                  {stat.text}
                </span>
              )}
            </td>
          );
        })}
        <td>
          <OctantButton
            aria-controls={panelId}
            aria-describedby={headingId}
            aria-expanded={props.open}
            onClick={props.onToggle}
            size="sm"
            type="button"
            variant="ghost"
          >
            {props.open ? "Hide turns" : "Show turns"}
          </OctantButton>
        </td>
      </tr>
      {props.open ? (
        <tr>
          <td colSpan={props.columns.length + 2}>
            <div className="usage-thread-metrics__drill" id={panelId}>
              {[...props.row.turns].reverse().map((turn, index) => (
                <TurnDrill key={`${turn.threadId}-${turn.endedAt}-${String(index)}`} turn={turn} />
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function TurnDrill(props: { readonly turn: TurnMetricsRecord }) {
  const detail = turnDetail(props.turn);
  const ended = new Date(props.turn.endedAt);
  const when = Number.isNaN(ended.getTime())
    ? props.turn.endedAt
    : ended.toLocaleString([], {
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
        day: "numeric",
      });
  return (
    <section
      aria-label={`Turn on ${String(props.turn.modelId)}`}
      className="usage-thread-metrics__turn"
    >
      <h3 className="usage-workspace__subheading">
        {String(props.turn.modelId)} · {when}
      </h3>
      {detail.tokens.length === 0 ? null : <DetailList rows={detail.tokens} title="Tokens" />}
      <DetailList rows={detail.timing} title="Timing" />
      {detail.cost === undefined ? null : <DetailList rows={[detail.cost]} title="Cost" />}
      {detail.notes.map((note) => (
        <p className="usage-thread-metrics__note" key={note}>
          {note}
        </p>
      ))}
    </section>
  );
}

function DetailList(props: {
  readonly rows: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly value: string;
    readonly hint?: string;
  }>;
  readonly title: string;
}) {
  return (
    <div>
      <h4 className="usage-thread-metrics__label">{props.title}</h4>
      <dl className="usage-thread-metrics__rows">
        {props.rows.map((row) => (
          <div key={row.key}>
            <dt>{row.label}</dt>
            <dd>
              {row.value}
              {row.hint === undefined ? null : (
                <span className="usage-thread-metrics__note"> {row.hint}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
