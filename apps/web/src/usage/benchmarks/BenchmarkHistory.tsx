import type { BenchmarkHistoryRun } from "@octant/contracts";
import { ChartBlock } from "../../canvas/blocks/ChartBlock";
import { SurfaceSection } from "../../surface/SurfaceHeader";
import {
  HISTORY_LEFT_OUT_NOTE,
  RUN_STATUS_WORDS,
  contenderLabel,
  formatDuration,
  formatRatio,
  formatScore,
  formatSpeed,
  formatTokens,
  formatUsd,
  historyCharts,
  type ContenderNames,
  type HistoryChart,
} from "./benchmarkPresentation";
import { useMemo } from "react";

export interface BenchmarkHistoryProps {
  readonly runs: ReadonlyArray<BenchmarkHistoryRun>;
  readonly names: ContenderNames;
}

function HistoryChartPanel({ chart }: { readonly chart: HistoryChart }) {
  if (chart.block === undefined && !chart.leftOut) return null;
  return (
    <div className="diagnostics-dashboard__panel">
      {chart.block === undefined ? null : <ChartBlock block={chart.block} />}
      {chart.leftOut ? <p className="usage-workspace__note">{HISTORY_LEFT_OUT_NOTE}</p> : null}
    </div>
  );
}

/** One suite across its runs, newest first in the table and oldest first in the lines. */
export function BenchmarkHistory({ runs, names }: BenchmarkHistoryProps) {
  const charts = useMemo(() => historyCharts(runs, names), [runs, names]);
  return (
    <SurfaceSection label="History">
      {runs.length === 0 ? (
        <p className="usage-workspace__note">This suite has no runs to compare yet.</p>
      ) : (
        <>
          <div className="benchmark-history__charts">
            <HistoryChartPanel chart={charts.checkPassRate} />
            <HistoryChartPanel chart={charts.judgeScore} />
          </div>
          <div className="usage-table-scroll">
            <table aria-label="Runs by contender" className="usage-table">
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Status</th>
                  <th scope="col">Contender</th>
                  <th scope="col">Check pass rate</th>
                  <th scope="col">Judge score</th>
                  <th scope="col">Stars</th>
                  <th scope="col">First token, typical</th>
                  <th scope="col">Speed, typical</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Failures</th>
                </tr>
              </thead>
              <tbody>
                {runs.flatMap((run) =>
                  run.rows.map((row, index) => (
                    <tr key={`${String(run.runId)}:${index}`}>
                      <th scope="row">{new Date(run.startedAt).toLocaleString()}</th>
                      <td>{RUN_STATUS_WORDS[run.status]}</td>
                      <td>{contenderLabel(row.contender, names)}</td>
                      <td>{formatRatio(row.checkPassRate)}</td>
                      <td>{formatScore(row.meanJudgeScore)}</td>
                      <td>{formatScore(row.meanStars)}</td>
                      <td>{formatDuration(row.firstTokenP50Ms)}</td>
                      <td>{formatSpeed(row.tokensPerSecondP50)}</td>
                      <td>{formatTokens(row.totalTokens)}</td>
                      <td>{formatUsd(row.totalCostUsd)}</td>
                      <td>{row.failedCount}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SurfaceSection>
  );
}
