import type { ServiceLimitBucket } from "@octant/contracts/context";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import { matchKeybinding } from "@octant/domain";
import { useEffect, useRef, useState } from "react";
import { isApplePlatform } from "../platform";
import { useKeybindings } from "../keybindings/useKeybindings";
import { ContextInspector } from "./ContextInspector";
import {
  contextHealthLabel,
  contextWindowModel,
  contextWindowUsedSourceLabel,
  type ContextWindowSegment,
} from "./contextInspectorModel";
import {
  useComposerContextMeterScope,
  type ComposerContextUsageFallback,
} from "./composerContextMeterScope";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantPopover } from "../ui/base/OctantPopover";
import "./context.css";

const METER_RADIUS = 7;
const METER_SIZE = 18;
const METER_CIRCUMFERENCE = 2 * Math.PI * METER_RADIUS;

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
  const percent = windowModel === undefined ? 0 : windowModel.percent;
  const usedArc = (Math.max(0, Math.min(100, percent)) / 100) * METER_CIRCUMFERENCE;
  const label = meterLabel({
    open,
    status: scope.status,
    windowModel,
    ...(fallback === undefined ? {} : { fallback }),
    ...(snapshot === undefined ? {} : { snapshotLabel: snapshot.displayLabel }),
    ...(health === undefined ? {} : { healthLabel: contextHealthLabel(health) }),
  });

  // The panel shows one of three things, and a screen reader that is told the
  // dialog is named for a heading it does not contain has been told the wrong
  // thing. Name it for whichever title the reader is actually looking at.
  const panelTitle =
    windowModel === undefined || snapshot === undefined
      ? fallback === undefined
        ? "Context usage"
        : "Provider usage"
      : "Context window";

  return (
    <div className="composer-context-meter" data-health={health}>
      <OctantPopover
        align="end"
        className="context-window-popover composer-context-meter__popover window-no-drag"
        onOpenChange={setOpen}
        open={open}
        side="top"
        title={panelTitle}
        trigger={
          <svg
            aria-hidden="true"
            className="composer-context-meter__ring"
            viewBox={`0 0 ${String(METER_SIZE)} ${String(METER_SIZE)}`}
          >
            <circle
              className="composer-context-meter__track"
              cx={METER_SIZE / 2}
              cy={METER_SIZE / 2}
              fill="none"
              r={METER_RADIUS}
            />
            {usedArc > 0 ? (
              <circle
                className="composer-context-meter__used"
                cx={METER_SIZE / 2}
                cy={METER_SIZE / 2}
                fill="none"
                r={METER_RADIUS}
                strokeDasharray={`${String(usedArc)} ${String(METER_CIRCUMFERENCE)}`}
                transform={`rotate(-90 ${String(METER_SIZE / 2)} ${String(METER_SIZE / 2)})`}
              />
            ) : null}
          </svg>
        }
        triggerClassName="composer-context-meter__button"
        triggerLabel={label}
        triggerVariant="ghost-icon"
      >
        {windowModel === undefined || snapshot === undefined ? (
          fallback === undefined ? (
            <p>{emptyMessage(scope.status)}</p>
          ) : (
            <ContextUsageFallback fallback={fallback} />
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
      </OctantPopover>
      <span aria-live="polite" className="sr-only">
        {liveLabel({
          status: scope.status,
          windowModel,
          ...(fallback === undefined ? {} : { fallback }),
          ...(snapshot === undefined ? {} : { snapshotLabel: snapshot.displayLabel }),
          ...(health === undefined ? {} : { healthLabel: contextHealthLabel(health) }),
        })}
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

function ContextUsageFallback(props: { readonly fallback: ComposerContextUsageFallback }) {
  return (
    <>
      <header className="context-window-popover__header">
        <span>Provider usage</span>
        <strong>{formatTokens(props.fallback.inputTokens)} input</strong>
      </header>
      <p className="context-window-popover__source">
        The provider reported usage, but not an authoritative context-window maximum.
      </p>
      <dl className="context-window-popover__facts">
        <Fact label="Input" value={formatTokens(props.fallback.inputTokens)} />
        <Fact label="Output" value={formatTokens(props.fallback.outputTokens)} />
        <Fact label="Context maximum" value="Unavailable" />
        <Fact
          label="Cost"
          value={
            props.fallback.costUsd === undefined
              ? "Not reported"
              : new Intl.NumberFormat(undefined, {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 4,
                }).format(props.fallback.costUsd)
          }
        />
      </dl>
      <section aria-label="Provider account limits" className="context-window-popover__limits">
        <div className="context-window-popover__limits-heading">
          <h3>Provider account limits</h3>
        </div>
        {props.fallback.limits.length === 0 ? (
          <p className="context-window-popover__limit-state">
            <span>Usage windows</span>
            <span>Not reported</span>
          </p>
        ) : (
          props.fallback.limits.map((limit) => (
            <p className="context-window-popover__limit-state" key={limit.window}>
              <span>{limit.window.replaceAll("_", " ")}</span>
              <span>{codeProviderLimitLabel(limit)}</span>
            </p>
          ))
        )}
      </section>
    </>
  );
}

function ContextUsagePopover(props: {
  readonly onInspect: () => void;
  readonly snapshot: ContextInspectorSnapshot;
  readonly windowModel: ReturnType<typeof contextWindowModel>;
}) {
  const { windowModel } = props;
  const limitRows = [
    { label: "Requests", limit: props.snapshot.serviceLimits.requests },
    { label: "Tokens", limit: props.snapshot.serviceLimits.tokens },
    { label: "Concurrent turns", limit: props.snapshot.serviceLimits.concurrency },
  ] as const;

  return (
    <>
      <header className="context-window-popover__header">
        <span>Context window</span>
        <strong>
          {windowModel.usageLabel} ({String(Math.round(windowModel.percent))}%)
        </strong>
      </header>
      <ContextMeter segments={windowModel.segments} totalTokens={windowModel.totalTokens} />
      <p className="context-window-popover__source">
        {windowModel.sourceLabel} · {props.snapshot.modelLimits.modelId} ·{" "}
        {contextWindowUsedSourceLabel(windowModel.usedSource)}
      </p>
      <dl className="context-window-popover__breakdown">
        {windowModel.segments.map((segment) => (
          <div key={segment.key}>
            <dt>
              <span aria-hidden="true" data-tone={segment.tone} />
              {segment.label}
            </dt>
            <dd>
              {segment.tokens === undefined
                ? "Unknown"
                : segment.estimated === true
                  ? `${compactTokens(segment.tokens)} · Estimated`
                  : compactTokens(segment.tokens)}
              {segment.tokens === undefined ? null : <span>{formatPercent(segment.percent)}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div className="context-window-popover__capabilities">
        {windowModel.capabilities.map((capability) => (
          <p key={capability.key}>
            <span>{capability.label}</span>
            <strong>{String(capability.loaded)} loaded</strong>
            <span>· {String(capability.deferred)} deferred</span>
          </p>
        ))}
      </div>
      <section aria-label="Provider account limits" className="context-window-popover__limits">
        <div className="context-window-popover__limits-heading">
          <h3>Provider account limits</h3>
          <time dateTime={props.snapshot.serviceLimits.updatedAt}>
            Updated {formatRelativeTime(props.snapshot.serviceLimits.updatedAt)}
          </time>
        </div>
        {limitRows.map((row) => (
          <CapacityRow key={row.label} label={row.label} limit={row.limit} />
        ))}
        <p className="context-window-popover__limit-state">
          <span>Quota</span>
          <span>{quotaLabel(props.snapshot.serviceLimits.quota)}</span>
        </p>
        {props.snapshot.serviceLimits.retry.status === "active" ? (
          <p className="context-window-popover__limit-state" data-state="rate-limited">
            <span>Retry</span>
            <span>Rate limited until {formatTime(props.snapshot.serviceLimits.retry.until)}</span>
          </p>
        ) : null}
      </section>
      <OctantButton
        className="context-window-popover__inspect"
        onClick={props.onInspect}
        type="button"
        variant="ghost"
      >
        Inspect context
      </OctantButton>
    </>
  );
}

function ContextMeter(props: {
  readonly segments: ReadonlyArray<ContextWindowSegment>;
  readonly totalTokens: number;
}) {
  return (
    <span
      aria-label={`Context window composition across ${compactTokens(props.totalTokens)} tokens`}
      className="context-window-popover__meter"
      role="img"
    >
      {props.segments
        .filter((segment) => segment.tokens !== undefined && segment.percent > 0)
        .map((segment) => (
          <span
            data-kind={segment.kind}
            data-tone={segment.tone}
            key={segment.key}
            style={{ inlineSize: `${String(segment.percent)}%` }}
          />
        ))}
    </span>
  );
}

function CapacityRow(props: { readonly label: string; readonly limit: ServiceLimitBucket }) {
  if (props.limit.status === "unavailable") {
    return (
      <p data-state="unavailable">
        <span>{props.label}</span>
        <span>Unavailable</span>
      </p>
    );
  }
  const used = props.limit.limit - props.limit.remaining;
  const percent = props.limit.limit === 0 ? 0 : Math.round((used / props.limit.limit) * 100);
  return (
    <p>
      <span>{props.label}</span>
      <span>
        {compactTokens(props.limit.remaining)} of {compactTokens(props.limit.limit)} left ·{" "}
        {String(percent)}% used
      </span>
      {props.limit.resetsAt === undefined ? null : (
        <span className="context-window-popover__reset">
          Resets {formatTime(props.limit.resetsAt)}
        </span>
      )}
    </p>
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
      return `${action} context usage. Provider reported ${compactTokens(input.fallback.inputTokens)} input and ${compactTokens(input.fallback.outputTokens)} output. Context window maximum unavailable.`;
    }
    return `${action} context usage. ${emptyMessage(input.status)}`;
  }
  const unknown = input.windowModel.hasUnknown ? ", plus unknown" : "";
  const source = contextWindowUsedSourceLabel(input.windowModel.usedSource);
  const health = input.healthLabel === undefined ? "" : ` ${input.healthLabel}.`;
  const scope = input.snapshotLabel === undefined ? "" : ` for ${input.snapshotLabel}`;
  return `${action} context usage${scope}. ${input.windowModel.usageLabel} (${String(Math.round(input.windowModel.percent))}%)${unknown}. ${source}.${health}`;
}

function codeProviderLimitLabel(limit: ComposerContextUsageFallback["limits"][number]): string {
  const share =
    limit.utilization === undefined ? undefined : `${Math.round(limit.utilization * 100)}% used`;
  const reset =
    limit.resetsAt === undefined
      ? undefined
      : `resets ${new Date(limit.resetsAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`;
  const state =
    limit.status === "exhausted" ? "Spent" : limit.status === "warning" ? "Low" : "Available";
  return [state, share, reset].filter((part): part is string => part !== undefined).join(" · ");
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
      return `Provider reported ${compactTokens(input.fallback.inputTokens)} input and ${compactTokens(input.fallback.outputTokens)} output. Context window maximum unavailable.`;
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
