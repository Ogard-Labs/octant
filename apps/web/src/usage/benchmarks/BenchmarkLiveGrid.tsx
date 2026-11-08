import {
  Ban,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  LoaderCircle,
  SkipForward,
  type LucideIcon,
} from "lucide-react";
import type {
  BenchmarkCell,
  BenchmarkCellMetrics,
  BenchmarkCellState,
  BenchmarkRun,
} from "@octant/contracts";
import { OctantButton } from "../../ui/base/OctantButton";
import { SurfaceSection } from "../../surface/SurfaceHeader";
import {
  CELL_STATE_WORDS,
  contenderLabel,
  formatDuration,
  formatTokens,
  RUN_STATUS_WORDS,
  type ContenderNames,
} from "./benchmarkPresentation";

const CELL_STATE_ICONS: Readonly<Record<BenchmarkCellState, LucideIcon>> = {
  queued: CircleDashed,
  running: LoaderCircle,
  answered: CircleCheck,
  failed: CircleX,
  "blocked-on-approval": CirclePause,
  cancelled: Ban,
  "skipped-budget": SkipForward,
};

/** A state is always an icon and a word together, never a colour alone. */
export function CellState(props: { readonly state: BenchmarkCellState }) {
  const Icon = CELL_STATE_ICONS[props.state];
  return (
    <span className="benchmark-cell__state" data-state={props.state}>
      <Icon aria-hidden="true" size={14} />
      {CELL_STATE_WORDS[props.state]}
    </span>
  );
}

export function cellElapsedMs(
  cell: BenchmarkCell,
  metrics: BenchmarkCellMetrics | undefined,
): number | undefined {
  if (metrics !== undefined) return metrics.wallMs;
  if (cell.startedAt !== undefined && cell.settledAt !== undefined) {
    return Math.max(0, Date.parse(cell.settledAt) - Date.parse(cell.startedAt));
  }
  return undefined;
}

export function cellTokens(metrics: BenchmarkCellMetrics | undefined): number | undefined {
  if (metrics === undefined) return undefined;
  return (
    metrics.totalTokens ??
    (metrics.inputTokens === undefined && metrics.outputTokens === undefined
      ? undefined
      : (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0))
  );
}

export interface BenchmarkLiveGridProps {
  readonly run: BenchmarkRun;
  readonly metricsByCell: ReadonlyMap<string, BenchmarkCellMetrics>;
  readonly names: ContenderNames;
  readonly selectedCaseId: string | undefined;
  readonly onSelectCase: (caseId: string) => void;
  readonly onCancel: () => void;
  readonly cancelPending: boolean;
}

/**
 * Every case against every contender, each cell with its state, time, and
 * tokens. A case's title opens it in Case compare. The grid is a table, so
 * it scrolls inside its own container at a phone width.
 */
export function BenchmarkLiveGrid(props: BenchmarkLiveGridProps) {
  const { run } = props;
  const running = run.status === "running";
  const settled = run.cells.filter(
    (cell) => cell.state !== "queued" && cell.state !== "running",
  ).length;
  return (
    <SurfaceSection
      actions={
        running ? (
          <OctantButton
            disabled={props.cancelPending}
            onClick={props.onCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel run
          </OctantButton>
        ) : undefined
      }
      label="Live grid"
    >
      <p aria-live="polite" className="usage-workspace__status" role="status">
        {RUN_STATUS_WORDS[run.status]} · {settled} of {run.cells.length} cells settled
      </p>
      {running ? null : (
        <p className="benchmark-end-reason">
          <span className="usage-workspace__note">End reason</span>{" "}
          {run.endReason ?? RUN_STATUS_WORDS[run.status]}
        </p>
      )}
      <div className="usage-table-scroll">
        <table aria-label="Cases by contender" className="usage-table benchmark-grid">
          <thead>
            <tr>
              <th scope="col">Case</th>
              {run.contenders.map((contender, index) => (
                <th key={index} scope="col">
                  {contenderLabel(contender, props.names)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.cases.map((benchmarkCase) => (
              <tr key={String(benchmarkCase.caseId)}>
                <th scope="row">
                  <OctantButton
                    variant="bare"
                    aria-pressed={props.selectedCaseId === String(benchmarkCase.caseId)}
                    className="benchmark-link"
                    onClick={() => props.onSelectCase(String(benchmarkCase.caseId))}
                    type="button"
                  >
                    {benchmarkCase.title}
                  </OctantButton>
                </th>
                {run.contenders.map((_contender, contenderIndex) => (
                  <td key={contenderIndex}>
                    {run.cells
                      .filter(
                        (cell) =>
                          String(cell.caseId) === String(benchmarkCase.caseId) &&
                          cell.contenderIndex === contenderIndex,
                      )
                      .sort((left, right) => left.repetition - right.repetition)
                      .map((cell) => (
                        <GridCell
                          cell={cell}
                          key={String(cell.cellId)}
                          metrics={props.metricsByCell.get(String(cell.cellId))}
                          repetitions={run.repetitions}
                        />
                      ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SurfaceSection>
  );
}

function GridCell(props: {
  readonly cell: BenchmarkCell;
  readonly metrics: BenchmarkCellMetrics | undefined;
  readonly repetitions: number;
}) {
  const time = cellElapsedMs(props.cell, props.metrics);
  const tokens = cellTokens(props.metrics);
  return (
    <div className="benchmark-cell" data-state={props.cell.state}>
      <CellState state={props.cell.state} />
      {props.repetitions > 1 ? (
        <span className="usage-workspace__note"> · run {props.cell.repetition}</span>
      ) : null}
      <span className="benchmark-cell__figures">
        {formatDuration(time)} · {tokens === undefined ? "—" : `${formatTokens(tokens)} tokens`}
      </span>
      {props.cell.judge === undefined ? null : (
        <span className="benchmark-cell__figures">
          {props.cell.judge.status === "scored"
            ? `Judge ${props.cell.judge.score} of 10`
            : `Judge did not score: ${props.cell.judge.reason}`}
        </span>
      )}
      {props.cell.rating === undefined ? null : (
        <span className="benchmark-cell__figures">Rated {props.cell.rating.stars} of 5</span>
      )}
    </div>
  );
}
