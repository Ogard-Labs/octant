import type { ServiceLimitBucket } from "@octant/contracts/context";
import type { CodeProviderLimit } from "@octant/contracts/code-operations";
import {
  providerLimitWindowLabel,
  providerLimitWindowName,
} from "../providers/providerLimitWindow";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import { matchKeybinding } from "@octant/domain";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isApplePlatform } from "../platform";
import { useKeybindings } from "../keybindings/useKeybindings";
import { ContextInspector } from "./ContextInspector";
import {
  autoCompactRoom,
  contextHealthLabel,
  contextWindowModel,
  contextAccuracyLabel,
  contextWindowUsedSourceLabel,
  providerWindowModel,
  type ContextWindowSegment,
  type ProviderWindowCount,
  type ProviderWindowModel,
} from "./contextInspectorModel";
import {
  useComposerContextMeterScope,
  type ComposerContextUsageFallback,
} from "./composerContextMeterScope";
import { resetCountdownLabel } from "../lib/relativeTime";
import { ThreadStatsMenu } from "../threadStats/ThreadStatsMenu";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantPopover } from "../ui/base/OctantPopover";
import "./context.css";

const RING_SIZE = 16;
const RING_RADIUS = 7;
/** The share at which the ring and a limit's bar take the warning ink. */
const NEAR_LIMIT_PERCENT = 80;

export function ComposerContextMeterShortcut() {
  const { requestOpen } = useComposerContextMeterScope();
  const { keybindings } = useKeybindings();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (matchKeybinding(keybindings, event, isApplePlatform()) !== "context-usage") return;
      event.preventDefault();
      requestOpen();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, requestOpen]);
  return null;
}

export function ComposerContextMeter() {
  const scope = useComposerContextMeterScope();
  const snapshot = scope.snapshot;
  const fallback = snapshot === undefined ? scope.fallback : undefined;
  const [open, setOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const seenOpenNonce = useRef(scope.openNonce);

  useEffect(() => {
    setOpen(false);
    setInspecting(false);
  }, [scope.subjectKey]);

  useEffect(() => {
    if (scope.visible) return;
    setOpen(false);
    setInspecting(false);
  }, [scope.visible]);

  useEffect(() => {
    if (scope.openNonce === seenOpenNonce.current) return;
    seenOpenNonce.current = scope.openNonce;
    if (!scope.visible || scope.openNonce === 0) return;
    setOpen(true);
  }, [scope.openNonce, scope.visible]);

  if (!scope.visible) return null;

  const windowModel = snapshot === undefined ? undefined : contextWindowModel(snapshot);
  const health = snapshot === undefined ? undefined : snapshot.next.plan.health;
  const reported = fallback === undefined ? undefined : reportedWindow(fallback);
  const limit =
    fallback === undefined || reported !== undefined ? undefined : bindingLimit(fallback);
  const percent =
    windowModel === undefined ? (reported?.percent ?? limit?.percent ?? 0) : windowModel.percent;
  const usedPercent = Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10;
  const limitAlert =
    snapshot?.serviceLimits.quota === "exhausted"
      ? "exhausted"
      : fallback === undefined
        ? undefined
        : limitAlertState(fallback);
  const limitAlertText =
    limitAlert === undefined
      ? ""
      : limitAlert === "exhausted"
        ? " A provider limit is exhausted."
        : " A provider limit is running low.";
  const label = meterLabel({
    open,
    status: scope.status,
    windowModel,
    ...(fallback === undefined ? {} : { fallback }),
    ...(snapshot === undefined ? {} : { snapshotLabel: snapshot.displayLabel }),
    ...(health === undefined ? {} : { healthLabel: `Next turn: ${contextHealthLabel(health)}` }),
  });
  const triggerLabel = label + limitAlertText;
  const openUsage = scope.openUsage;

  // The panel shows one of three things, and a screen reader that is told the
  // dialog is named for a heading it does not contain has been told the wrong
  // thing. Name it for whichever title the reader is actually looking at.
  const panelTitle =
    windowModel === undefined || snapshot === undefined
      ? fallback === undefined
        ? "Context usage"
        : reported === undefined
          ? "Provider usage"
          : "Context window"
      : "Context window";

  return (
    <div
      className="composer-context-meter"
      data-health={health}
      {...(usedPercent >= NEAR_LIMIT_PERCENT ? { "data-fill": "high" } : {})}
      {...(limitAlert === undefined ? {} : { "data-limit-alert": limitAlert })}
    >
      <OctantPopover
        align="end"
        className="context-window-popover composer-context-meter__popover window-no-drag"
        onOpenChange={setOpen}
        open={open}
        side="top"
        title={panelTitle}
        trigger={<UsageRing alert={limitAlert !== undefined} usedPercent={usedPercent} />}
        triggerClassName="composer-context-meter__button"
        triggerLabel={triggerLabel}
        triggerVariant="ghost-icon"
      >
        {windowModel === undefined || snapshot === undefined ? (
          fallback === undefined ? (
            <p className="context-window-popover__source">{emptyMessage(scope.status)}</p>
          ) : (
            <ContextUsageFallback
              fallback={fallback}
              {...(openUsage === undefined
                ? {}
                : {
                    onOpenUsage: () => {
                      setOpen(false);
                      openUsage();
                    },
                  })}
            />
          )
        ) : (
          <ContextUsagePopover
            onInspect={() => {
              setOpen(false);
              setInspecting(true);
            }}
            snapshot={snapshot}
            windowModel={windowModel}
          />
        )}
        <ThreadStatsMenu onOpenDetail={() => setOpen(false)} />
      </OctantPopover>
      <span aria-live="polite" className="sr-only">
        {liveLabel({
          status: scope.status,
          windowModel,
          ...(fallback === undefined ? {} : { fallback }),
          ...(snapshot === undefined ? {} : { snapshotLabel: snapshot.displayLabel }),
          ...(health === undefined
            ? {}
            : { healthLabel: `Next turn: ${contextHealthLabel(health)}` }),
        })}
        {limitAlertText}
      </span>
      {inspecting && snapshot !== undefined ? (
        <OctantDialog
          className="context-inspector-dialog"
          label="Context inspector"
          onClose={() => setInspecting(false)}
          open
        >
          <ContextInspector
            busy={scope.busy}
            onClose={() => setInspecting(false)}
            onRebuild={scope.rebuild}
            onSetExcluded={scope.setExcluded}
            onSetPinned={scope.setPinned}
            snapshot={snapshot}
          />
        </OctantDialog>
      ) : null}
    </div>
  );
}

/**
 * A gauge, not an activity mark: a full faint track with the used share drawn
 * clockwise from twelve o'clock. The arc is measured on a path length of 100,
 * so its dash is the used percentage itself. The earlier ring read as a
 * spinner because its track was barely visible and the arc wore the secondary
 * ink, so a short arc looked like something turning rather than filling.
 */
function UsageRing(props: { readonly alert: boolean; readonly usedPercent: number }) {
  const centre = RING_SIZE / 2;
  return (
    <svg
      aria-hidden="true"
      className="composer-context-meter__ring"
      viewBox={`0 0 ${String(RING_SIZE)} ${String(RING_SIZE)}`}
    >
      <circle
        className="composer-context-meter__track"
        cx={centre}
        cy={centre}
        fill="none"
        r={RING_RADIUS}
      />
      {props.usedPercent > 0 ? (
        <circle
          className="composer-context-meter__used"
          cx={centre}
          cy={centre}
          fill="none"
          pathLength={100}
          r={RING_RADIUS}
          strokeDasharray={`${String(props.usedPercent)} 100`}
          transform={`rotate(-90 ${String(centre)} ${String(centre)})`}
        />
      ) : null}
      {props.alert ? (
        <circle className="composer-context-meter__alert" cx="13" cy="3" r="2.5" />
      ) : null}
    </svg>
  );
}

/**
 * The share of the model's window the provider itself reported with its last
 * turn. A runtime the host does not plan has no context plan to measure, so
 * the provider's own figure is the window the meter shows. When the usage
 * report named the occupancy but not the window, the limit the provider
 * declared for the selected model stands in — the popover says whose number
 * it is.
 */
/**
 * How full the window is, from the same two sources the meter itself reads: the
 * host's context plan, or, where no plan exists, the provider's own report.
 * Absent when neither names a window, so a caller shows nothing rather than a
 * guessed share.
 */
export function composerContextOccupancy(input: {
  readonly snapshot?: ContextInspectorSnapshot | undefined;
  readonly fallback?: ComposerContextUsageFallback | undefined;
}):
  | {
      readonly usedTokens: number;
      readonly totalTokens: number;
      readonly percent: number;
      readonly label: string;
    }
  | undefined {
  if (input.snapshot !== undefined) {
    const model = contextWindowModel(input.snapshot);
    if (model.totalTokens <= 0) return undefined;
    return {
      usedTokens: model.usedTokens,
      totalTokens: model.totalTokens,
      percent: model.percent,
      label: `${compactTokens(model.usedTokens)} of ${compactTokens(model.totalTokens)}`,
    };
  }
  const reported = input.fallback === undefined ? undefined : reportedWindow(input.fallback);
  if (reported === undefined) return undefined;
  return {
    usedTokens: reported.usedTokens,
    totalTokens: reported.windowTokens,
    percent: reported.percent,
    label: `${compactTokens(reported.usedTokens)} of ${compactTokens(reported.windowTokens)}`,
  };
}

/**
 * What a provider that is not planned by the host reports about its window: one
 * occupancy figure, and from some runtimes the parts of it. The thread's input
 * and output totals are sums over turns, not parts of that occupancy, so they
 * are never segments of it. The window's parts, and what holds the rest, come
 * from `providerWindowModel`, which also settles what the window holds when a
 * breakdown and the occupancy disagree, so the ring, the figure and the bar
 * always read the same number.
 */
function reportedWindow(fallback: ComposerContextUsageFallback):
  | {
      readonly percent: number;
      readonly label: string;
      readonly total: string;
      readonly declared: boolean;
      readonly model: ProviderWindowModel;
      readonly usedTokens: number;
      readonly windowTokens: number;
    }
  | undefined {
  const window = fallback.contextWindow ?? fallback.modelContextWindow;
  if (window === undefined || fallback.contextTokens === undefined) return undefined;
  const model = providerWindowModel({
    breakdown: fallback.contextBreakdown,
    usedTokens: fallback.contextTokens,
    windowTokens: window,
  });
  const percent = Math.max(0, Math.min(100, (model.usedTokens / window) * 100));
  const share = `(${String(Math.round(percent))}%)`;
  return {
    percent,
    declared: fallback.contextWindow === undefined,
    label: `${compactTokens(model.usedTokens)} of ${compactTokens(window)} ${share}`,
    total: `${compactTokens(model.usedTokens)} / ${compactTokens(window)} ${share}`,
    model,
    usedTokens: model.usedTokens,
    windowTokens: window,
  };
}

/**
 * The fullest provider account window, when no context share exists to draw.
 * A provider that cannot say how large the model's window is may still report
 * how much of the account's quota is spent — a dead ring next to a number the
 * popover already carries is the misleading option.
 */
function bindingLimit(
  fallback: ComposerContextUsageFallback,
): { readonly percent: number; readonly window: string } | undefined {
  let binding: { readonly percent: number; readonly window: string } | undefined;
  for (const limit of fallback.limits) {
    if (limit.utilization === undefined) continue;
    const percent = Math.max(0, Math.min(100, limit.utilization * 100));
    if (binding === undefined || percent > binding.percent) {
      binding = { percent, window: limit.window };
    }
  }
  return binding;
}

/**
 * The worst account window the provider reported. The ring's dot is the only
 * at-a-glance warning left in the composer once the status line moved in,
 * so "exhausted" must win over "warning" and "allowed" draws nothing.
 */
function limitAlertState(
  fallback: ComposerContextUsageFallback,
): "exhausted" | "warning" | undefined {
  let state: "exhausted" | "warning" | undefined;
  for (const limit of fallback.limits) {
    if (limit.status === "exhausted") return "exhausted";
    if (limit.status === "warning") state = "warning";
  }
  return state;
}

function providerUsageLabel(fallback: ComposerContextUsageFallback): string {
  if (fallback.inputTokens === undefined || fallback.outputTokens === undefined) {
    return "Usage not reported";
  }
  return `Provider reported ${compactTokens(fallback.inputTokens)} input and ${compactTokens(fallback.outputTokens)} output`;
}

function ContextUsageFallback(props: {
  readonly fallback: ComposerContextUsageFallback;
  readonly onOpenUsage?: () => void;
}) {
  const { fallback } = props;
  const reported = reportedWindow(fallback);
  const room = fallbackAutoCompactRoom(fallback, reported?.usedTokens ?? fallback.contextTokens);
  const [expanded, setExpanded] = useState(false);
  const breakdownId = useId();
  const totals = <ThreadTotals fallback={fallback} />;

  return (
    <>
      {reported === undefined ? (
        <>
          <UsageHeader
            title="Provider usage"
            total={
              fallback.inputTokens === undefined
                ? "Not reported"
                : `${formatTokens(fallback.inputTokens)} in`
            }
          />
          <p className="context-window-popover__source">
            {fallback.inputTokens === undefined || fallback.outputTokens === undefined
              ? "No usage has been reported for this thread."
              : "This provider reports what a turn spent, but not a context-window maximum, so there is no share of a window to show."}
          </p>
          <AutoCompactRoom room={room} />
          {totals}
        </>
      ) : (
        <>
          <UsageHeader
            breakdownId={breakdownId}
            expanded={expanded}
            onToggle={() => setExpanded((current) => !current)}
            title="Context window"
            total={reported.total}
          />
          <SegmentBar
            label={`Context window used, ${reported.label}`}
            percent={reported.percent}
            segments={reported.model.segments}
          />
          <AutoCompactRoom room={room} />
          {/* A window the provider did not name is a caveat on the figure
              itself, so it stays in view; the ordinary provenance line waits
              in the breakdown with the rest of the detail. */}
          {reported.declared ? (
            <p className="context-window-popover__source">
              The provider did not name a window; this divides the last request's occupancy by the
              context limit declared for the selected model.
            </p>
          ) : null}
          {expanded ? (
            <div className="context-window-popover__details" id={breakdownId}>
              <SegmentLegend segments={reported.model.segments} />
              {reportedSourceNote(reported.model, reported.declared) === undefined ? null : (
                <p className="context-window-popover__source">
                  {reportedSourceNote(reported.model, reported.declared)}
                </p>
              )}
              <ProviderCounts counts={reported.model.counts} />
              {totals}
            </div>
          ) : null}
        </>
      )}
      <LimitSection>
        {fallback.limits.length === 0 ? (
          <p className="context-window-popover__limit-state">
            <span>Usage windows</span>
            <span>Not reported</span>
          </p>
        ) : (
          fallback.limits.map((limit) => (
            <WindowLimitRow
              key={limit.window}
              limit={limit}
              showScope={distinctScopes(fallback.limits) > 1}
            />
          ))
        )}
      </LimitSection>
      {props.onOpenUsage === undefined ? null : (
        <FooterAction label="View usage" onClick={props.onOpenUsage} />
      )}
    </>
  );
}

/**
 * Where the figures in the breakdown come from. A part the runtime reported is
 * the provider's own count; a part Octant counted is named as the estimate it
 * is, with how it was estimated, and the remainder is said to be what is left of
 * the reported total. A window the provider did not name already carries its
 * own caveat, so only the estimate note remains for it.
 */
function reportedSourceNote(model: ProviderWindowModel, declared: boolean): string | undefined {
  const estimate =
    model.estimatedAccuracies.length === 0
      ? undefined
      : `Parts marked Estimated are Octant's own count (${model.estimatedAccuracies
          .map((accuracy) => contextAccuracyLabel(accuracy).toLowerCase())
          .join(", ")}). The provider reported the total, and Other (provider) is the rest of it.`;
  if (declared) return estimate;
  return estimate ?? "Reported by the provider with its last turn.";
}

/**
 * How many tools, MCP tools, memory files, skills and agents the window holds,
 * where the runtime or Octant knows. Deferred tools are known but not loaded, so
 * they are counted here and take no share of the bar.
 */
function ProviderCounts(props: { readonly counts: ReadonlyArray<ProviderWindowCount> }) {
  if (props.counts.length === 0) return null;
  return (
    <div className="context-window-popover__capabilities">
      {props.counts.map((count) => (
        <p key={count.key}>
          <span>{count.label}</span>
          <span>
            {[
              count.loaded === undefined ? undefined : `${String(count.loaded)} loaded`,
              count.deferred === undefined
                ? undefined
                : count.deferred.count === undefined
                  ? "some deferred"
                  : `${String(count.deferred.count)} deferred`,
            ]
              .filter((part) => part !== undefined)
              .join(" · ")}
          </span>
        </p>
      ))}
    </div>
  );
}

/**
 * The room a runtime that compacts its own session has left. The report's
 * threshold is what makes this thread's compaction automatic: a runtime that
 * names none leaves the kind unknown, and the line stays out. The room is
 * measured from what the window holds as the popover shows it, so the line and
 * the figure above it never disagree.
 */
function fallbackAutoCompactRoom(
  fallback: ComposerContextUsageFallback,
  usedTokens: number | undefined,
) {
  return autoCompactRoom({
    compaction: fallback.autoCompactThreshold === undefined ? "unknown" : "automatic",
    thresholdTokens: fallback.autoCompactThreshold,
    usedTokens,
  });
}

function AutoCompactRoom(props: { readonly room: ReturnType<typeof autoCompactRoom> }) {
  if (props.room === undefined) return null;
  return (
    <p className="context-window-popover__source" data-auto-compact="">
      {props.room.tokens === 0
        ? "At the auto-compact threshold"
        : `${compactTokens(props.room.tokens)} until auto-compact`}
    </p>
  );
}

/**
 * The thread's own totals. They are sums over every turn the provider
 * reported, which is why they sit apart from the window's occupancy rather
 * than inside its breakdown.
 */
function ThreadTotals(props: { readonly fallback: ComposerContextUsageFallback }) {
  const { fallback } = props;
  return (
    <dl aria-label="This thread" className="context-window-popover__facts">
      <Fact
        label="Input"
        value={
          fallback.inputTokens === undefined ? "Not reported" : formatTokens(fallback.inputTokens)
        }
      />
      <Fact
        label="Output"
        value={
          fallback.outputTokens === undefined ? "Not reported" : formatTokens(fallback.outputTokens)
        }
      />
      {fallback.costUsd === undefined ? null : (
        <Fact
          label="Cost"
          value={new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: 4,
          }).format(fallback.costUsd)}
        />
      )}
    </dl>
  );
}

function ContextUsagePopover(props: {
  readonly onInspect: () => void;
  readonly snapshot: ContextInspectorSnapshot;
  readonly windowModel: ReturnType<typeof contextWindowModel>;
}) {
  const { windowModel, snapshot } = props;
  const [expanded, setExpanded] = useState(false);
  const breakdownId = useId();
  const now = Date.now();
  const buckets = [
    { label: "Requests", limit: snapshot.serviceLimits.requests },
    { label: "Tokens", limit: snapshot.serviceLimits.tokens },
    { label: "Concurrent turns", limit: snapshot.serviceLimits.concurrency },
  ] as const;
  const windows = snapshot.serviceLimits.rateLimitWindows ?? [];
  const percentLabel = `(${String(Math.round(windowModel.percent))}%)`;

  return (
    <>
      <UsageHeader
        breakdownId={breakdownId}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        title="Context window"
        total={`${windowModel.usageLabel} ${percentLabel}`}
      />
      <SegmentBar
        label={`Context window composition across ${compactTokens(windowModel.totalTokens)} tokens`}
        percent={windowModel.percent}
        segments={windowModel.segments}
      />
      {expanded ? (
        <div className="context-window-popover__details" id={breakdownId}>
          <SegmentLegend segments={windowModel.segments} />
          <p className="context-window-popover__source">
            {windowModel.sourceLabel} · {snapshot.modelLimits.modelId} ·{" "}
            {contextWindowUsedSourceLabel(windowModel.usedSource)}
          </p>
          <div className="context-window-popover__capabilities">
            {windowModel.capabilities.map((capability) => (
              <p key={capability.key}>
                <span>{capability.label}</span>
                <span>
                  {String(capability.loaded)} loaded · {String(capability.deferred)} deferred
                </span>
              </p>
            ))}
          </div>
        </div>
      ) : null}
      <LimitSection updatedAt={snapshot.serviceLimits.updatedAt}>
        {buckets.map((row) => (
          <BucketLimitRow key={row.label} label={row.label} limit={row.limit} now={now} />
        ))}
        {windows.map((limit) => (
          <WindowLimitRow
            key={limit.window}
            limit={limit}
            showScope={distinctScopes(windows) > 1}
          />
        ))}
        <p className="context-window-popover__limit-state">
          <span>Quota</span>
          <span>{quotaLabel(snapshot.serviceLimits.quota)}</span>
        </p>
        {snapshot.serviceLimits.retry.status === "active" ? (
          <p className="context-window-popover__limit-state" data-state="rate-limited">
            <span>Retry</span>
            <span>Rate limited until {formatTime(snapshot.serviceLimits.retry.until)}</span>
          </p>
        ) : null}
      </LimitSection>
      <FooterAction label="Inspect context" onClick={props.onInspect} />
    </>
  );
}

/**
 * The popover's first line: what is measured, the figure, and — when there is
 * a breakdown to show — the control that shows it. The breakdown starts
 * folded every time the popover opens; the bar already answers "how full",
 * and the parts are a second question.
 */
function UsageHeader(props: {
  readonly breakdownId?: string;
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
  readonly title: string;
  readonly total: string;
}) {
  return (
    <header className="context-window-popover__header">
      <span className="context-window-popover__title">{props.title}</span>
      <strong className="context-window-popover__total">{props.total}</strong>
      {props.onToggle === undefined ? null : (
        <OctantButton
          aria-controls={props.breakdownId}
          aria-expanded={props.expanded === true}
          aria-label="Context breakdown"
          className="context-window-popover__toggle"
          onClick={props.onToggle}
          size="icon-xs"
          title="Context breakdown"
          type="button"
          variant="ghost"
        >
          <ChevronDown
            aria-hidden="true"
            className="context-window-popover__chevron"
            data-expanded={props.expanded === true}
            size={12}
          />
        </OctantButton>
      )}
    </header>
  );
}

/**
 * One thin bar, one segment per reported part in the order the breakdown
 * lists them. Free space is not painted: it is the track the parts have not
 * reached, so the bar's empty length and the window's free room are the same
 * thing to the eye.
 */
function SegmentBar(props: {
  readonly label: string;
  readonly percent: number;
  readonly segments: ReadonlyArray<ContextWindowSegment>;
}) {
  return (
    <span
      aria-label={props.label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(props.percent)}
      className="context-window-popover__meter"
      role="meter"
    >
      {props.segments
        .filter(
          (segment) =>
            segment.kind !== "free" && segment.tokens !== undefined && segment.percent > 0,
        )
        .map((segment) => (
          <span
            data-kind={segment.kind}
            data-tone={segment.tone}
            key={segment.key}
            style={
              { "--context-window-meter-size": `${String(segment.percent)}%` } as CSSProperties
            }
          />
        ))}
    </span>
  );
}

/**
 * The bar's key. Each swatch carries its category's name beside it, so hue only
 * has to tell adjacent segments apart, never name them. An estimated figure
 * says so in words on its row.
 */
function SegmentLegend(props: { readonly segments: ReadonlyArray<ContextWindowSegment> }) {
  return (
    <table className="context-window-popover__legend">
      <thead className="sr-only">
        <tr>
          <th scope="col">Category</th>
          <th scope="col">Tokens</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {props.segments.map((segment) => (
          <tr data-kind={segment.kind} data-tone={segment.tone} key={segment.key}>
            <th scope="row">
              <span aria-hidden="true" className="context-window-popover__swatch" />
              <span>{segment.label}</span>
              {segment.estimated === true ? (
                <span
                  className="context-window-popover__qualifier"
                  {...(segment.accuracy === undefined
                    ? {}
                    : { title: contextAccuracyLabel(segment.accuracy) })}
                >
                  Estimated
                </span>
              ) : null}
            </th>
            <td>{segment.tokens === undefined ? "Unknown" : compactTokens(segment.tokens)}</td>
            <td>{segment.tokens === undefined ? "" : formatPercent(segment.percent)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LimitSection(props: { readonly children: ReactNode; readonly updatedAt?: string }) {
  return (
    <section aria-label="Provider account limits" className="context-window-popover__limits">
      <div className="context-window-popover__limits-heading">
        <h3>Provider account limits</h3>
        {props.updatedAt === undefined ? null : (
          <time dateTime={props.updatedAt}>Updated {formatRelativeTime(props.updatedAt)}</time>
        )}
      </div>
      {props.children}
    </section>
  );
}

type LimitLevel = "ok" | "near" | "spent";

/**
 * One limit as a line and a bar: its name, when it resets, and how much is
 * used, over a bar that ranks it against the others at a glance. A limit near
 * its cap is marked on the row itself (`data-level`) and in the bar's value
 * text, so the warning ink is never the only sign.
 */
function LimitRow(props: {
  readonly level: LimitLevel;
  readonly name: string;
  readonly percent?: number;
  readonly qualifier?: string;
  readonly reset?: string;
  readonly value?: string;
}) {
  const levelText =
    props.level === "spent" ? ", spent" : props.level === "near" ? ", running low" : "";
  return (
    <div
      className="context-window-popover__limit"
      data-level={props.level}
      {...(props.percent === undefined ? { "data-share": "none" } : {})}
    >
      <p>
        <span className="context-window-popover__limit-name">
          {props.name}
          {props.qualifier === undefined ? null : (
            <span className="context-window-popover__qualifier">{props.qualifier}</span>
          )}
        </span>
        {props.reset === undefined ? null : (
          <span className="context-window-popover__reset">{props.reset}</span>
        )}
        <span className="context-window-popover__limit-value">{limitValueText(props)}</span>
      </p>
      {props.percent === undefined ? null : (
        <span
          aria-label={`${props.name} used`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={props.percent}
          aria-valuetext={`${String(props.percent)}% used${levelText}`}
          className="context-window-popover__limit-meter"
          role="meter"
        >
          <span style={{ width: `${String(Math.max(0, Math.min(100, props.percent)))}%` }} />
        </span>
      )}
    </div>
  );
}

/**
 * A measured share still names a `near`/`spent` provider status next to the
 * percentage: a reader who only reads figures, not the row's warning ink,
 * must see the same word a screen reader announces via `aria-valuetext`.
 */
function limitValueText(props: {
  readonly level: LimitLevel;
  readonly percent?: number;
  readonly value?: string;
}): string {
  if (props.percent === undefined) return props.value ?? "";
  const percentText = `${String(props.percent)}%`;
  if (props.level === "ok" || props.value === undefined) return percentText;
  return `${percentText} · ${props.value}`;
}

function WindowLimitRow(props: {
  readonly limit: Pick<CodeProviderLimit, "window" | "status" | "utilization" | "resetsAt">;
  readonly showScope: boolean;
}) {
  const { limit } = props;
  const name = providerLimitWindowName(limit.window);
  const percent = limit.utilization === undefined ? undefined : Math.round(limit.utilization * 100);
  const level: LimitLevel =
    limit.status === "exhausted"
      ? "spent"
      : limit.status === "warning" || (percent ?? 0) >= NEAR_LIMIT_PERCENT
        ? "near"
        : "ok";
  return (
    <LimitRow
      level={level}
      name={name.label}
      {...(percent === undefined ? {} : { percent })}
      {...(props.showScope && name.scope !== undefined ? { qualifier: name.scope } : {})}
      {...(limit.resetsAt === undefined
        ? {}
        : { reset: resetCountdownLabel(limit.resetsAt, Date.now()) })}
      value={
        limit.status === "exhausted" ? "Spent" : limit.status === "warning" ? "Low" : "Available"
      }
    />
  );
}

function BucketLimitRow(props: {
  readonly label: string;
  readonly limit: ServiceLimitBucket;
  readonly now: number;
}) {
  if (props.limit.status === "unavailable") {
    return <LimitRow level="ok" name={props.label} value="Unavailable" />;
  }
  const { limit, remaining, resetsAt } = props.limit;
  const percent = limit === 0 ? 0 : Math.round(((limit - remaining) / limit) * 100);
  const level: LimitLevel =
    remaining === 0 ? "spent" : percent >= NEAR_LIMIT_PERCENT ? "near" : "ok";
  return (
    <LimitRow
      level={level}
      name={props.label}
      percent={percent}
      qualifier={`${compactTokens(remaining)} of ${compactTokens(limit)} left`}
      {...(resetsAt === undefined ? {} : { reset: resetCountdownLabel(resetsAt, props.now) })}
    />
  );
}

/** Two windows of the same length on different scopes would read alike. */
function distinctScopes(limits: ReadonlyArray<{ readonly window: string }>): number {
  return new Set(limits.map((limit) => providerLimitWindowName(limit.window).scope ?? "")).size;
}

function FooterAction(props: { readonly label: string; readonly onClick: () => void }) {
  return (
    <div className="context-window-popover__footer">
      <OctantButton
        className="context-window-popover__footer-action"
        onClick={props.onClick}
        size="sm"
        type="button"
        variant="ghost"
      >
        <span>{props.label}</span>
        <ChevronRight aria-hidden="true" size={14} />
      </OctantButton>
    </div>
  );
}

function Fact(props: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function meterLabel(input: {
  readonly fallback?: ComposerContextUsageFallback;
  readonly healthLabel?: string;
  readonly open: boolean;
  readonly snapshotLabel?: string;
  readonly status: string;
  readonly windowModel: ReturnType<typeof contextWindowModel> | undefined;
}): string {
  const action = input.open ? "Hide" : "Show";
  if (input.windowModel === undefined) {
    if (input.fallback !== undefined) {
      const reported = reportedWindow(input.fallback);
      if (reported !== undefined) {
        const source = reported.declared
          ? "against the selected model's declared context limit"
          : "as the provider reported it";
        return `${action} context usage. Context window ${reported.label}, ${source}.`;
      }
      const limit = bindingLimit(input.fallback);
      const limitText =
        limit === undefined
          ? ""
          : ` The ring shows ${String(Math.round(limit.percent))}% of the ${providerLimitWindowLabel(limit.window)} used.`;
      return `${action} context usage. ${providerUsageLabel(input.fallback)}. Context window maximum unavailable.${limitText}`;
    }
    return `${action} context usage. ${emptyMessage(input.status)}`;
  }
  const unknown = input.windowModel.hasUnknown ? ", plus unknown" : "";
  const source = contextWindowUsedSourceLabel(input.windowModel.usedSource);
  const health = input.healthLabel === undefined ? "" : ` ${input.healthLabel}.`;
  const scope = input.snapshotLabel === undefined ? "" : ` for ${input.snapshotLabel}`;
  return `${action} context usage${scope}. ${input.windowModel.usageLabel} (${String(Math.round(input.windowModel.percent))}%)${unknown}. ${source}.${health}`;
}

function liveLabel(input: {
  readonly fallback?: ComposerContextUsageFallback;
  readonly healthLabel?: string;
  readonly snapshotLabel?: string;
  readonly status: string;
  readonly windowModel: ReturnType<typeof contextWindowModel> | undefined;
}): string {
  if (input.windowModel === undefined) {
    if (input.fallback !== undefined) {
      const reported = reportedWindow(input.fallback);
      if (reported !== undefined) {
        const source = reported.declared
          ? "against the selected model's declared context limit"
          : "as the provider reported it";
        return `Context window ${reported.label}, ${source}.`;
      }
      const limit = bindingLimit(input.fallback);
      const limitText =
        limit === undefined
          ? ""
          : ` The ring shows ${String(Math.round(limit.percent))}% of the ${providerLimitWindowLabel(limit.window)} used.`;
      return `${providerUsageLabel(input.fallback)}. Context window maximum unavailable.${limitText}`;
    }
    return emptyMessage(input.status);
  }
  const unknown = input.windowModel.hasUnknown ? " plus unknown" : "";
  const source = contextWindowUsedSourceLabel(input.windowModel.usedSource);
  const health = input.healthLabel === undefined ? "" : ` ${input.healthLabel}.`;
  const scope = input.snapshotLabel === undefined ? "Context" : input.snapshotLabel;
  return `${scope}. ${input.windowModel.sourceLabel} ${input.windowModel.usageLabel} (${String(Math.round(input.windowModel.percent))}%)${unknown}. ${source}.${health}`;
}

function emptyMessage(status: string): string {
  if (status === "not-planned") return "No context plan yet.";
  if (status === "disconnected") return "Context is unavailable.";
  if (status === "loading" || status === "updating") return "Loading context.";
  return "Context is unavailable.";
}

const tokenNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactNumber = new Intl.NumberFormat();

function compactTokens(tokens: number): string {
  return tokenNumber.format(tokens);
}

function formatTokens(tokens: number): string {
  return exactNumber.format(tokens);
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(percent < 1 && percent > 0 ? 1 : 0)}%`;
}

function quotaLabel(quota: ContextInspectorSnapshot["serviceLimits"]["quota"]): string {
  return quota === "available"
    ? "Available"
    : quota === "exhausted"
      ? "Exhausted"
      : quota === "unavailable"
        ? "Unavailable"
        : "Unknown";
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

function formatTime(timestamp: string): string {
  return dateTimeFormat.format(new Date(timestamp));
}

function formatRelativeTime(timestamp: string): string {
  const elapsedMs = Math.max(0, Date.now() - new Date(timestamp).getTime());
  if (elapsedMs < 60_000) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return formatTime(timestamp);
}
