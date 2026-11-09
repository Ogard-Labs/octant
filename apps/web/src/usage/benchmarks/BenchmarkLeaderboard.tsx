import { OctantButton } from "../../ui/base/OctantButton";
import { useCallback, useMemo, useState } from "react";
import type {
  BenchmarkCellMetrics,
  BenchmarkLeaderboardRow,
  BenchmarkRun,
} from "@octant/contracts";
import { BarListBlock } from "../../canvas/blocks/BarListBlock";
import { SurfaceSection } from "../../surface/SurfaceHeader";
import { CellState, cellElapsedMs, cellTokens } from "./BenchmarkLiveGrid";
import {
  COLUMN_BEST_FIRST,
  comparisonBlocks,
  contenderLabel,
  formatDuration,
  formatRatio,
  formatScore,
  formatSpeed,
  formatTokens,
  formatUsd,
  leaderboardHeadline,
  sortLeaderboard,
  type ContenderNames,
  type LeaderboardColumn,
  type SortDirection,
} from "./benchmarkPresentation";

interface ColumnSpec {
  readonly column: LeaderboardColumn;
  readonly label: string;
  readonly show: (
    row: BenchmarkLeaderboardRow,
    labelOf: (row: BenchmarkLeaderboardRow) => string,
  ) => string;
}

const COLUMNS: ReadonlyArray<ColumnSpec> = [
  {
    column: "checkPassRate",
    label: "Check pass rate",
    show: (row) => formatRatio(row.checkPassRate),
  },
  {
    column: "meanJudgeScore",
    label: "Judge score",
    show: (row) => formatScore(row.meanJudgeScore),
  },
  { column: "meanStars", label: "Stars", show: (row) => formatScore(row.meanStars) },
  {
    column: "firstTokenP50Ms",
    label: "First token, typical",
    show: (row) => formatDuration(row.firstTokenP50Ms),
  },
  {
    column: "firstTokenP95Ms",
    label: "First token, slow",
    show: (row) => formatDuration(row.firstTokenP95Ms),
  },
  {
    column: "tokensPerSecondP50",
    label: "Speed, typical",
    show: (row) => formatSpeed(row.tokensPerSecondP50),
  },
  {
    column: "tokensPerSecondP95",
    label: "Speed, fast",
    show: (row) => formatSpeed(row.tokensPerSecondP95),
  },
  { column: "totalTokens", label: "Tokens", show: (row) => formatTokens(row.totalTokens) },
  { column: "totalCostUsd", label: "Cost", show: (row) => formatUsd(row.totalCostUsd) },
  {
    column: "toolFailureRate",
    label: "Tool failures",
    show: (row) => formatRatio(row.toolFailureRate),
  },
  {
    column: "failedCount",
    label: "Failures",
    show: (row) =>
      row.blockedCount > 0
        ? `${row.failedCount} · ${row.blockedCount} blocked`
        : String(row.failedCount),
  },
];

export interface BenchmarkLeaderboardProps {
  readonly run: BenchmarkRun;
  readonly rows: ReadonlyArray<BenchmarkLeaderboardRow>;
  readonly metricsByCell: ReadonlyMap<string, BenchmarkCellMetrics>;
  readonly names: ContenderNames;
  readonly onSelectCase: (caseId: string) => void;
}

/**
 * One row per contender, from the figures the host computed. Every column
 * sorts, with a contender that has no reading for it always last, and a row
 * opens that contender's cells. A score no one gave reads as a dash.
 */
export function BenchmarkLeaderboard(props: BenchmarkLeaderboardProps) {
  const [sort, setSort] = useState<{
    readonly column: LeaderboardColumn;
    readonly direction: SortDirection;
  }>({ column: "checkPassRate", direction: "descending" });
  const [openIndex, setOpenIndex] = useState<number | undefined>(undefined);

  const { run, names } = props;
  const labelOf = useCallback(
    (row: BenchmarkLeaderboardRow): string => {
      const contender = run.contenders[row.contenderIndex];
      return contender === undefined
        ? `Contender ${row.contenderIndex + 1}`
        : contenderLabel(contender, names);
    },
    [run, names],
  );
  const sorted = useMemo(
    () => sortLeaderboard(props.rows, sort.column, sort.direction, labelOf),
    [props.rows, sort, labelOf],
  );
  const headline = leaderboardHeadline(props.rows, labelOf);
  const blocks = useMemo(() => comparisonBlocks(props.rows, labelOf), [props.rows, labelOf]);

  const choose = (column: LeaderboardColumn) =>
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === "ascending" ? "descending" : "ascending" }
        : { column, direction: COLUMN_BEST_FIRST[column] },
    );
  const header = (column: LeaderboardColumn, label: string) => (
    <th aria-sort={sort.column === column ? sort.direction : "none"} key={column} scope="col">
      <OctantButton
        variant="bare"
        className="benchmark-sort"
        onClick={() => choose(column)}
        type="button"
      >
        {label}
      </OctantButton>
    </th>
  );

  const open = openIndex === undefined ? undefined : props.run.contenders[openIndex];
  return (
    <SurfaceSection label="Leaderboard">
      {headline.length === 0 ? null : (
        <ul aria-label="Headline" className="benchmark-headline">
          {headline.map((item) => (
            <li key={item.label}>
              <span className="usage-workspace__note">{item.label}</span>
              <strong>{item.reading}</strong>
              <span>{item.contender}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="usage-table-scroll">
        <table aria-label="Leaderboard" className="usage-table">
          <thead>
            <tr>
              {header("contender", "Contender")}
              {COLUMNS.map((spec) => header(spec.column, spec.label))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.contenderIndex}>
                <th scope="row">
                  <OctantButton
                    variant="bare"
                    aria-expanded={openIndex === row.contenderIndex}
                    className="benchmark-link"
                    onClick={() =>
                      setOpenIndex(
                        openIndex === row.contenderIndex ? undefined : row.contenderIndex,
                      )
                    }
                    type="button"
                  >
                    {labelOf(row)}
                  </OctantButton>
                </th>
                {COLUMNS.map((spec) => (
                  <td key={spec.column}>{spec.show(row, labelOf)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open === undefined || openIndex === undefined ? null : (
        <div
          aria-label={`Cells of ${contenderLabel(open, props.names)}`}
          className="benchmark-cells"
          role="region"
        >
          <h3 className="usage-workspace__subheading">
            Cells of {contenderLabel(open, props.names)}
          </h3>
          <div className="usage-table-scroll">
            <table aria-label="Cells of the contender" className="usage-table">
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">State</th>
                  <th scope="col">Time</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Checks</th>
                  <th scope="col">Judge</th>
                </tr>
              </thead>
              <tbody>
                {props.run.cells
                  .filter((cell) => cell.contenderIndex === openIndex)
                  .map((cell) => {
                    const benchmarkCase = props.run.cases.find(
                      (candidate) => String(candidate.caseId) === String(cell.caseId),
                    );
                    const metrics = props.metricsByCell.get(String(cell.cellId));
                    const passed = cell.checks.filter((check) => check.passed).length;
                    return (
                      <tr key={String(cell.cellId)}>
                        <th scope="row">
                          <OctantButton
                            variant="bare"
                            className="benchmark-link"
                            onClick={() => props.onSelectCase(String(cell.caseId))}
                            type="button"
                          >
                            {benchmarkCase?.title ?? "A case"}
                            {props.run.repetitions > 1 ? ` · run ${cell.repetition}` : ""}
                          </OctantButton>
                        </th>
                        <td>
                          <CellState state={cell.state} />
                        </td>
                        <td>{formatDuration(cellElapsedMs(cell, metrics))}</td>
                        <td>{formatTokens(cellTokens(metrics))}</td>
                        <td>
                          {cell.checks.length === 0 ? "—" : `${passed} of ${cell.checks.length}`}
                        </td>
                        <td>
                          {cell.judge?.status === "scored" ? `${cell.judge.score} of 10` : "—"}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {blocks.passRate === undefined &&
      blocks.speed === undefined &&
      blocks.cost === undefined ? null : (
        <div className="benchmark-comparisons">
          {blocks.passRate === undefined ? null : (
            <div className="diagnostics-dashboard__panel">
              <h3 className="usage-workspace__subheading">Check pass rate</h3>
              <BarListBlock block={blocks.passRate} locale="en" />
            </div>
          )}
          {blocks.speed === undefined ? null : (
            <div className="diagnostics-dashboard__panel">
              <h3 className="usage-workspace__subheading">Speed</h3>
              <BarListBlock block={blocks.speed} locale="en" />
            </div>
          )}
          {blocks.cost === undefined ? null : (
            <div className="diagnostics-dashboard__panel">
              <h3 className="usage-workspace__subheading">Cost</h3>
              <BarListBlock block={blocks.cost} locale="en" />
            </div>
          )}
        </div>
      )}
    </SurfaceSection>
  );
}
