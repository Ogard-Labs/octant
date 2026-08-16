import type { UsageQueryFilter } from "@octant/contracts";
import type { UsageDashboardClient } from "@octant/client-runtime";
import { useMemo } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { useUsageDashboardController } from "./useUsageDashboardController";
import "./usageWorkspace.css";

export interface ThreadUsagePanelProps {
  readonly client: UsageDashboardClient | undefined;
  readonly subjectType: string;
  readonly subjectId: string;
  /** Opens the global Usage destination with this thread already filtered. */
  readonly onOpenUsageDashboard?: (filter: UsageQueryFilter) => void;
}

/**
 * Compact per-thread usage for the thread Environment panel.
 *
 * The panel answers "what has this thread cost so far" without duplicating the
 * dashboard: it reads the same host projection with the thread pre-filtered and
 * hands that identical filter to the full surface, so the two views can never
 * disagree about which thread is being described.
 */
export function ThreadUsagePanel(props: ThreadUsagePanelProps) {
  const filter = useMemo(
    (): UsageQueryFilter =>
      ({
        subjectAggregateType: props.subjectType,
        subjectAggregateId: props.subjectId,
      }) as UsageQueryFilter,
    [props.subjectType, props.subjectId],
  );

  const controller = useUsageDashboardController({
    client: props.client,
    request: useMemo(() => ({ filter, detailLimit: 1, breakdownLimit: 5 }), [filter]),
  });

  const summary = controller.dashboard?.summary;

  return (
    <section aria-label="Thread usage" className="thread-usage">
      <h3 className="thread-usage__title">Usage</h3>

      {controller.status === "loading" ? (
        <p className="thread-usage__status" role="status">
          Loading thread usage…
        </p>
      ) : null}

      {controller.status === "unauthorized" ||
      controller.status === "unavailable" ||
      controller.status === "failure" ? (
        <p className="thread-usage__status" role="alert">
          {controller.errorMessage ?? "Thread usage could not be loaded."}
        </p>
      ) : null}

      {summary === undefined ? null : summary.totals.totalRequests === 0 ? (
        <p className="thread-usage__status" role="note">
          No usage has been recorded for this thread yet.
        </p>
      ) : (
        <dl className="thread-usage__totals">
          <div>
            <dt>Requests</dt>
            <dd>{summary.totals.totalRequests.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Input tokens</dt>
            <dd>{summary.totals.totalInputTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{summary.totals.totalOutputTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Requests without reported usage</dt>
            <dd>{summary.requestsWithUnavailableUsage.toLocaleString()}</dd>
          </div>
        </dl>
      )}

      {props.onOpenUsageDashboard === undefined ? null : (
        <OctantButton
          onClick={() => props.onOpenUsageDashboard?.(filter)}
          type="button"
          variant="ghost"
        >
          Open in Usage dashboard
        </OctantButton>
      )}
    </section>
  );
}
