import { Gauge } from "../ui/icons";
import { EnvironmentGroup } from "../environment/EnvironmentGroup";
import { compactTokenCount } from "../context/contextInspectorModel";
import {
  decodeAggregateVersion,
  type SpendCeilingRemaining,
  type SpendCeilingSnapshot,
  type SpendCeilingThreadType,
  type UsageQueryFilter,
} from "@octant/contracts";
import type { UsageDashboardClient } from "@octant/client-runtime";
import type { SpendCeilingClient } from "@octant/client-runtime/spend-ceiling-client";
import {
  MONEY_CEILING_NOTE,
  hasMoneyCeiling,
  notMeasuredProvidersNote,
  spendCeilingLimits,
  spendCeilingRemainingPhrases,
  spendCeilingShortReading,
} from "./spendCeilingLimits";
import { useEffect, useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";
import { ChevronRight } from "../ui/icons";
import { useUsageDashboardController } from "./useUsageDashboardController";
import "./usageWorkspace.css";
import { OctantAlert } from "../ui/base/OctantAlert";

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
      // The row's own value says the state, so the body has no sentence for
      // it. A request with no reported usage is not zero usage, so a total that
      // leaves some out is not shown folded, where the caveat is hidden.
      {...(summary === undefined
        ? {}
        : summary.totals.totalRequests === 0
          ? { summary: "No usage yet" }
          : summary.requestsWithUnavailableUsage > 0
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
          <OctantAlert className="thread-usage__status" tone="warning">
            {controller.errorMessage ?? "Thread usage could not be loaded."}
          </OctantAlert>
        ) : null}

        {summary === undefined || summary.totals.totalRequests === 0 ? null : (
          // Label and figure on one line each, the same list the checkout facts
          // use. As four boxed tiles the numbers read as a dashboard inside the
          // rail, and a count of zero unreported requests took a tile to say so.
          <dl className="thread-usage__totals">
            <div>
              <dt>Requests</dt>
              <dd>{summary.totals.totalRequests.toLocaleString("en")}</dd>
            </div>
            <div>
              <dt>Input tokens</dt>
              <dd>{summary.totals.totalInputTokens.toLocaleString("en")}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{summary.totals.totalOutputTokens.toLocaleString("en")}</dd>
            </div>
            {summary.requestsWithUnavailableUsage === 0 ? null : (
              <div>
                <dt>Requests without reported usage</dt>
                <dd>{summary.requestsWithUnavailableUsage.toLocaleString("en")}</dd>
              </div>
            )}
          </dl>
        )}
        {props.spendCeilingClient === undefined ? null : (
          <SpendCeilingControls
            key={`${props.subjectType}:${props.subjectId}`}
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
  return compactTokenCount(count);
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
  const [dollars, setDollars] = useState("");
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
  const notMeasured = notMeasuredProvidersNote([
    snapshot?.threadRemaining,
    snapshot?.projectRemaining,
  ]);
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
    const reading =
      kind === "clear" ? undefined : spendCeilingLimits({ tokens: budget, turns, hours, dollars });
    if (reading?.status === "refused") {
      setMessage(reading.message);
      return;
    }
    const limits = reading?.limits ?? {};
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

  const reading = spendCeilingShortReading(
    [snapshot?.threadRemaining, snapshot?.projectRemaining].filter(
      (remaining) => remaining !== undefined,
    ),
  );
  const value =
    remaining === undefined ? "None" : remaining.length === 0 ? "Cannot be measured" : reading;
  const [open, setOpen] = useState(false);
  const messageAlert =
    message === undefined ? null : (
      <OctantAlert className="thread-usage__status" tone="warning">
        {message}
      </OctantAlert>
    );

  return (
    <div className="thread-usage__ceiling">
      {/* One row: the label and what is set. The four fields, the buttons and
          the notes open from it, so a thread with no ceiling spends one line
          on it instead of a form. */}
      <OctantPopover
        align="end"
        className="thread-usage__popover"
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setBudget("");
            setTurns("");
            setHours("");
            setDollars("");
          }
        }}
        open={open}
        title="Spend ceiling"
        trigger={
          <>
            <span className="thread-usage__ceiling-label">Spend ceiling</span>
            <span className="thread-usage__ceiling-value">{value}</span>
            <ChevronRight aria-hidden="true" className="thread-usage__ceiling-chevron" size={14} />
          </>
        }
        triggerClassName="thread-usage__ceiling-row"
        triggerLabel={`Spend ceiling, ${value}`}
      >
        <div className="thread-usage__ceiling-sheet">
          {remaining === undefined || remaining.length === 0 ? null : (
            <p className="thread-usage__ceiling-note" role="status">
              {remaining.join(" · ")}
            </p>
          )}
          {notMeasured === undefined ? null : (
            <p className="thread-usage__ceiling-note" role="note">
              {notMeasured}
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
                placeholder={threadCeilingSet ? "New tokens" : "Tokens"}
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
              <OctantInput
                aria-label="Money ceiling in US dollars"
                inputMode="decimal"
                onChange={(event) => setDollars(event.target.value)}
                placeholder="$"
                value={dollars}
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
          {/* The alert itself stays in the group behind this sheet. A refused
              Set would otherwise go unseen until the sheet closed, so the sheet
              repeats the words as a plain line; the alert has already spoken. */}
          {message === undefined ? null : (
            <p className="thread-usage__ceiling-note thread-usage__ceiling-problem">{message}</p>
          )}
          {hasMoneyCeiling([snapshot?.thread, snapshot?.project]) ? (
            <p className="thread-usage__ceiling-note" role="note">
              {MONEY_CEILING_NOTE}
            </p>
          ) : null}
        </div>
      </OctantPopover>
      {refusal === undefined ? null : (
        <OctantAlert className="thread-usage__status" tone="warning">
          {refusal.message}
        </OctantAlert>
      )}
      {/* Always here, open or closed: moving it into the popover moved the
          dashboard link under the pointer when the popover opened. */}
      {messageAlert}
    </div>
  );
}
