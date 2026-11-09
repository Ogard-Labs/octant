import type { TurnDiagnosticsReport } from "@octant/contracts";
import { BarListBlock } from "../canvas/blocks/BarListBlock";
import { ChartBlock } from "../canvas/blocks/ChartBlock";
import { DataBlocks } from "../canvas/blocks/DataBlocks";
import { SurfaceSection } from "../surface/SurfaceHeader";
import { diagnosticsDashboard } from "./diagnosticsDashboard";

/**
 * The top of the Diagnostics page: headline tiles with a trend and the change
 * since the previous span, how turns ended over time, speed over time, the
 * model comparison, and what fails most. Every chart is a Canvas chart, so it
 * answers hover and keyboard with exact readings and discloses its table.
 */
export function DiagnosticsDashboardView(props: {
  readonly report: TurnDiagnosticsReport;
  readonly previous: TurnDiagnosticsReport | undefined;
  readonly previousLabel: string | undefined;
}) {
  const dashboard = diagnosticsDashboard(props.report, props.previous, props.previousLabel);
  return (
    <>
      <section aria-label="Headline figures" className="diagnostics-dashboard__kpis">
        {dashboard.kpis.map((block) => (
          <div className="diagnostics-dashboard__kpi" key={block.blockId}>
            <DataBlocks block={block} />
          </div>
        ))}
      </section>

      {dashboard.turnsOverTime === undefined ? null : (
        <SurfaceSection label="How turns ended">
          <div className="diagnostics-dashboard__pair">
            <div className="diagnostics-dashboard__panel">
              <ChartBlock block={dashboard.turnsOverTime} />
            </div>
            {dashboard.troubledShareOverTime === undefined ? null : (
              <div className="diagnostics-dashboard__panel">
                <ChartBlock block={dashboard.troubledShareOverTime} />
              </div>
            )}
          </div>
        </SurfaceSection>
      )}

      {dashboard.firstTokenOverTime === undefined &&
      dashboard.speedOverTime === undefined ? null : (
        <SurfaceSection label="Speed over time">
          <div className="diagnostics-dashboard__pair">
            {dashboard.firstTokenOverTime === undefined ? null : (
              <div className="diagnostics-dashboard__panel">
                <ChartBlock block={dashboard.firstTokenOverTime} />
              </div>
            )}
            {dashboard.speedOverTime === undefined ? null : (
              <div className="diagnostics-dashboard__panel">
                <ChartBlock block={dashboard.speedOverTime} />
              </div>
            )}
          </div>
        </SurfaceSection>
      )}

      {dashboard.firstTokenByModel === undefined && dashboard.speedByModel === undefined ? null : (
        <SurfaceSection label="Model comparison">
          <div className="diagnostics-dashboard__pair">
            {dashboard.firstTokenByModel === undefined ? null : (
              <div className="diagnostics-dashboard__panel">
                <h3 className="usage-workspace__subheading">First token by model</h3>
                <BarListBlock block={dashboard.firstTokenByModel} />
              </div>
            )}
            {dashboard.speedByModel === undefined ? null : (
              <div className="diagnostics-dashboard__panel">
                <h3 className="usage-workspace__subheading">Speed by model</h3>
                <BarListBlock block={dashboard.speedByModel} />
              </div>
            )}
          </div>
        </SurfaceSection>
      )}

      {dashboard.failureCauses === undefined && dashboard.toolFailures === undefined ? null : (
        <SurfaceSection label="What fails most">
          <div className="diagnostics-dashboard__pair">
            {dashboard.failureCauses === undefined ? null : (
              <div className="diagnostics-dashboard__panel">
                <h3 className="usage-workspace__subheading">Failed turns by cause</h3>
                <BarListBlock block={dashboard.failureCauses} />
              </div>
            )}
            {dashboard.toolFailures === undefined ? null : (
              <div className="diagnostics-dashboard__panel">
                <h3 className="usage-workspace__subheading">Failing tools</h3>
                <BarListBlock block={dashboard.toolFailures} />
              </div>
            )}
          </div>
        </SurfaceSection>
      )}
    </>
  );
}
