import {
  decodeAggregateVersion,
  type SpendCeilingSnapshot,
  type SpendCeilingThreadType,
  type UsageQueryFilter,
} from "@octant/contracts";
import type { UsageDashboardClient } from "@octant/client-runtime";
import type { SpendCeilingClient } from "@octant/client-runtime/spend-ceiling-client";
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
      {props.spendCeilingClient === undefined ? null : (
        <SpendCeilingControls
          client={props.spendCeilingClient}
          subjectId={props.subjectId}
          subjectType={props.subjectType}
          {...(props.projectId === undefined ? {} : { projectId: props.projectId })}
        />
      )}
    </section>
  );
}

function isThreadType(value: string): value is SpendCeilingThreadType {
  return value === "chat-thread" || value === "work-thread" || value === "code-thread";
}

function displayedSpendRemaining(
  snapshot: SpendCeilingSnapshot | undefined,
): SpendCeilingSnapshot["threadRemaining"] {
  const thread = snapshot?.threadRemaining;
  const project = snapshot?.projectRemaining;
  if (thread === undefined) return project;
  if (project === undefined) return thread;
  return thread.remainingTokens <= project.remainingTokens ? thread : project;
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
    const tokenBudget = Number.parseInt(budget, 10);
    const expectedVersion = decodeAggregateVersion(version);
    const command =
      kind === "clear"
        ? { kind: "clear-spend-ceiling" as const, scope, expectedVersion }
        : kind === "raise"
          ? {
              kind: "raise-spend-ceiling" as const,
              scope,
              expectedVersion,
              tokenBudget,
            }
          : {
              kind: "set-spend-ceiling" as const,
              scope,
              expectedVersion,
              policy: { tokenBudget },
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
      <h4 className="thread-usage__title">Token spend ceiling</h4>
      {remaining === undefined ? (
        <p className="thread-usage__status" role="note">
          No token ceiling is set on this thread. Setting one is a host owner command.
        </p>
      ) : (
        <p className="thread-usage__status" role="status">
          {remaining.remainingTokens.toLocaleString()} of {remaining.ceilingTokens.toLocaleString()}{" "}
          tokens remaining
        </p>
      )}
      {refusal === undefined ? null : (
        <p className="thread-usage__status" role="alert">
          {refusal.message}
        </p>
      )}
      {scope === undefined ? null : (
        <form
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
            value={budget}
          />
          <OctantButton type="submit" variant="outline">
            {threadCeilingSet ? "Raise token ceiling" : "Set token ceiling"}
          </OctantButton>
          {threadCeilingSet ? (
            <OctantButton onClick={() => void submit("clear")} type="button" variant="ghost">
              Clear ceiling
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
