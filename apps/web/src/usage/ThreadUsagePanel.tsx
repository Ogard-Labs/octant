import { Gauge } from "lucide-react";
import { EnvironmentGroup } from "../environment/EnvironmentGroup";
import {
  decodeAggregateVersion,
  type SpendCeilingSnapshot,
  type SpendCeilingThreadType,
  type UsageQueryFilter,
} from "@octant/contracts";
import type { UsageDashboardClient } from "@octant/client-runtime";
import type { SpendCeilingClient } from "@octant/client-runtime/spend-ceiling-client";
import { spendCeilingLimits, spendCeilingRemainingPhrases } from "./spendCeilingLimits";
import { useEffect, useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { useUsageDashboardController } from "./useUsageDashboardController";
import "./usageWorkspace.css";

export interface ThreadUsagePanelProps {
  readonly client: UsageDashboardClient | undefined;
  readonly spendCeilingClient?: SpendCeilingClient;
  readonly subjectType: SpendCeilingThreadType | string;
  readonly subjectId: string;
  readonly projectId?: string;
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
    // A section of the Environment rail like any other: it folds, its title
    // lines up with theirs, and the way to the full dashboard sits on its
    // head. It had its own heading and a centred link between the numbers and
    // the ceiling, belonging to neither.
    <EnvironmentGroup
      icon={Gauge}
      title="Usage"
      // A request with no reported usage is not zero usage, so a total that
      // leaves some out is not shown folded, where the caveat is hidden.
      {...(summary === undefined ||
      summary.totals.totalRequests === 0 ||
      summary.requestsWithUnavailableUsage > 0
        ? {}
        : {
            summary: `${compactTokens(summary.totals.totalInputTokens + summary.totals.totalOutputTokens)} tokens`,
          })}
    >
      <section aria-label="Thread usage" className="thread-usage">
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
          // Label and figure on one line each, the same list the checkout facts
          // use. As four boxed tiles the numbers read as a dashboard inside the
          // rail, and a count of zero unreported requests took a tile to say so.
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
            {summary.requestsWithUnavailableUsage === 0 ? null : (
              <div>
                <dt>Requests without reported usage</dt>
                <dd>{summary.requestsWithUnavailableUsage.toLocaleString()}</dd>
              </div>
            )}
          </dl>
        )}
        {props.spendCeilingClient === undefined ? null : (
          <SpendCeilingControls
            client={props.spendCeilingClient}
            subjectId={props.subjectId}
            subjectType={props.subjectType}
            {...(props.projectId === undefined ? {} : { projectId: props.projectId })}
          />
        )}
        {/* The way to the full dashboard closes the section it expands: on the
            row's head it sat after the chevron, where it read as part of the
            toggle. */}
        {props.onOpenUsageDashboard === undefined ? null : (
          <OctantButton
            aria-label="Open in Usage dashboard"
            className="thread-usage__dashboard"
            onClick={() => props.onOpenUsageDashboard?.(filter)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Open Usage dashboard
          </OctantButton>
        )}
      </section>
    </EnvironmentGroup>
  );
}

/** "29.9k" for a head that has room for one short figure. */
function compactTokens(count: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    count,
  );
}

function isThreadType(value: string): value is SpendCeilingThreadType {
  return value === "chat-thread" || value === "work-thread" || value === "code-thread";
}

function displayedSpendRemaining(
  snapshot: SpendCeilingSnapshot | undefined,
): ReadonlyArray<string> | undefined {
  const remainings = [snapshot?.threadRemaining, snapshot?.projectRemaining].filter(
    (remaining) => remaining !== undefined,
  );
  if (remainings.length === 0) return undefined;
  return spendCeilingRemainingPhrases(remainings);
}

function SpendCeilingControls(props: {
  readonly client: SpendCeilingClient;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly projectId?: string;
}) {
  const threadType = isThreadType(props.subjectType) ? props.subjectType : undefined;
  const [snapshot, setSnapshot] = useState<SpendCeilingSnapshot | undefined>(undefined);
  const [budget, setBudget] = useState("");
  const [turns, setTurns] = useState("");
  const [hours, setHours] = useState("");
  const [message, setMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void props.client
      .snapshot({
        threadId: props.subjectId,
        ...(threadType === undefined ? {} : { threadType }),
        ...(props.projectId === undefined ? {} : { projectId: props.projectId }),
      })
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setMessage(error instanceof Error ? error.message : "Spend ceiling is unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, props.projectId, props.subjectId, threadType]);

  const remaining = displayedSpendRemaining(snapshot);
  const refusal = snapshot?.refusal;
  const threadCeilingSet = snapshot?.thread !== undefined;
  const version = snapshot?.thread?.version ?? 0;
  const scope =
    threadType === undefined
      ? undefined
      : ({
          kind: "thread" as const,
          threadType,
          threadId: props.subjectId,
        } as const);

  async function submit(kind: "set" | "raise" | "clear"): Promise<void> {
    if (scope === undefined) return;
    const limits = spendCeilingLimits({ tokens: budget, turns, hours });
    const expectedVersion = decodeAggregateVersion(version);
    const command =
      kind === "clear"
        ? { kind: "clear-spend-ceiling" as const, scope, expectedVersion }
        : kind === "raise"
          ? {
              kind: "raise-spend-ceiling" as const,
              scope,
              expectedVersion,
              ...limits,
            }
          : {
              kind: "set-spend-ceiling" as const,
              scope,
              expectedVersion,
              policy: limits,
              window: { kind: "lifetime" as const },
            };
    try {
      const result = await props.client.execute(command);
      if (result.kind === "refused") {
        setMessage(result.refusal.message);
        return;
      }
      setMessage(undefined);
      setSnapshot(
        await props.client.snapshot({
          threadId: props.subjectId,
          ...(threadType === undefined ? {} : { threadType }),
          ...(props.projectId === undefined ? {} : { projectId: props.projectId }),
        }),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Spend ceiling could not be changed.");
    }
  }

  return (
    <div className="thread-usage__ceiling">
      <div className="thread-usage__ceiling-head">
        <h4 className="thread-usage__subtitle">Spend ceiling</h4>
        {remaining === undefined ? (
          <p className="thread-usage__ceiling-value" role="note">
            None
          </p>
        ) : (
          <p className="thread-usage__ceiling-value" role="status">
            {remaining.join(" · ")}
          </p>
        )}
      </div>
      {refusal === undefined ? null : (
        <p className="thread-usage__status" role="alert">
          {refusal.message}
        </p>
      )}
      {scope === undefined ? null : (
        // One line: the number and what to do with it. The field had sat alone
        // and unlabelled across the rail with its button wrapped under it.
        <form
          className="thread-usage__ceiling-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit(threadCeilingSet ? "raise" : "set");
          }}
        >
          <OctantInput
            aria-label="Token spend ceiling"
            inputMode="numeric"
            onChange={(event) => setBudget(event.target.value)}
            placeholder={threadCeilingSet ? "New ceiling in tokens" : "Tokens, e.g. 200000"}
            value={budget}
          />
          <OctantInput
            aria-label="Turn ceiling"
            inputMode="numeric"
            onChange={(event) => setTurns(event.target.value)}
            placeholder="Turns"
            value={turns}
          />
          <OctantInput
            aria-label="Agent run time ceiling in hours"
            inputMode="decimal"
            onChange={(event) => setHours(event.target.value)}
            placeholder="Hours"
            value={hours}
          />
          <OctantButton
            aria-label={threadCeilingSet ? "Raise spend ceiling" : "Set spend ceiling"}
            size="sm"
            type="submit"
            variant="outline"
          >
            {threadCeilingSet ? "Raise" : "Set"}
          </OctantButton>
          {threadCeilingSet ? (
            <OctantButton
              aria-label="Clear ceiling"
              onClick={() => void submit("clear")}
              size="sm"
              type="button"
              variant="ghost"
            >
              Clear
            </OctantButton>
          ) : null}
        </form>
      )}
      {message === undefined ? null : (
        <p className="thread-usage__status" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
