import type { BenchmarkHistoryRun } from "@octant/contracts";
import { ChartBlock } from "../../canvas/blocks/ChartBlock";
import { SurfaceSection } from "../../surface/SurfaceHeader";
import {
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
} from "./benchmarkPresentation";
import { useMemo } from "react";

export interface BenchmarkHistoryProps {
  readonly runs: ReadonlyArray<BenchmarkHistoryRun>;
  readonly names: ContenderNames;
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
            {charts.checkPassRate === undefined ? null : (
              <div className="diagnostics-dashboard__panel">
                <ChartBlock block={charts.checkPassRate} />
              </div>
            )}
            {charts.judgeScore === undefined ? null : (
              <div className="diagnostics-dashboard__panel">
                <ChartBlock block={charts.judgeScore} />
              </div>
            )}
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
