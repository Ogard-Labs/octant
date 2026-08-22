import type { ServiceLimitBucket } from "@octant/contracts/context";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import { matchKeybinding } from "@octant/domain";
import { useEffect, useId, useRef, useState } from "react";
import { isApplePlatform } from "../platform";
import { useKeybindings } from "../keybindings/useKeybindings";
import { ContextInspector } from "./ContextInspector";
import {
  contextHealthLabel,
  contextWindowModel,
  contextWindowUsedSourceLabel,
  type ContextWindowSegment,
} from "./contextInspectorModel";
import { useComposerContextMeterScope } from "./composerContextMeterScope";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
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
  const [open, setOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
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
    queueMicrotask(() => trigger.current?.focus());
  }, [scope.openNonce, scope.visible]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (trigger.current?.contains(event.target) || panel.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      queueMicrotask(() => trigger.current?.focus());
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!scope.visible) return null;

  const windowModel = snapshot === undefined ? undefined : contextWindowModel(snapshot);
  const health = snapshot === undefined ? undefined : snapshot.next.plan.health;
  const percent = windowModel === undefined ? 0 : windowModel.percent;
  const usedArc = (Math.max(0, Math.min(100, percent)) / 100) * METER_CIRCUMFERENCE;
  const label = meterLabel({
    open,
    status: scope.status,
    windowModel,
    ...(snapshot === undefined ? {} : { snapshotLabel: snapshot.displayLabel }),
    ...(health === undefined ? {} : { healthLabel: contextHealthLabel(health) }),
  });

  return (
    <div className="composer-context-meter" data-health={health}>
      <OctantButton
        aria-controls={panelId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="composer-context-meter__button"
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        size="icon"
        type="button"
        variant="ghost"
      >
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
      </OctantButton>
      <span aria-live="polite" className="sr-only">
        {liveLabel({
          status: scope.status,
          windowModel,
          ...(snapshot === undefined ? {} : { snapshotLabel: snapshot.displayLabel }),
          ...(health === undefined ? {} : { healthLabel: contextHealthLabel(health) }),
        })}
      </span>
      {open ? (
        <div
          aria-label="Context usage"
          className="popover-panel context-window-popover composer-context-meter__popover window-no-drag"
          id={panelId}
          ref={panel}
          role="dialog"
        >
          {windowModel === undefined || snapshot === undefined ? (
            <p>{emptyMessage(scope.status)}</p>
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
        </div>
      ) : null}
      {inspecting && snapshot !== undefined ? (
        <OctantDialog
          className="context-inspector-dialog"
          label="Context inspector"
          onClose={() => setInspecting(false)}
          open
          restoreFocus={trigger}
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

function ContextUsagePopover(props: {
  readonly onInspect: () => void;
  readonly snapshot: ContextInspectorSnapshot;
  readonly windowModel: ReturnType<typeof contextWindowModel>;
}) {
  const { windowModel } = props;
  const free = windowModel.segments.find((segment) => segment.kind === "free");
  const availableLimits = (
    [
      { label: "Requests", limit: props.snapshot.serviceLimits.requests },
      { label: "Tokens", limit: props.snapshot.serviceLimits.tokens },
      { label: "Concurrent turns", limit: props.snapshot.serviceLimits.concurrency },
    ] as const
  ).flatMap((row) => (isAvailableLimit(row.limit) ? [{ label: row.label, limit: row.limit }] : []));

  return (
    <>
      <header className="context-window-popover__header">
        <span>Context usage</span>
        <strong>
          {windowModel.usageLabel} ({String(Math.round(windowModel.percent))}%)
        </strong>
      </header>
      <p className="context-window-popover__source">
        {windowModel.sourceLabel} · {props.snapshot.modelLimits.modelId} ·{" "}
        {contextWindowUsedSourceLabel(windowModel.usedSource)}
      </p>
      <dl className="context-window-popover__facts">
        <Fact
          label="Used"
          value={`${formatTokens(windowModel.usedTokens)} · ${contextWindowUsedSourceLabel(windowModel.usedSource)}`}
        />
        <Fact label="Maximum" value={formatTokens(windowModel.totalTokens)} />
        <Fact label="Percentage" value={formatPercent(windowModel.percent)} />
        <Fact
          label="Free space"
          value={
            free === undefined || free.tokens === undefined ? "Unknown" : formatTokens(free.tokens)
          }
        />
      </dl>
      <ContextMeter segments={windowModel.segments} totalTokens={windowModel.totalTokens} />
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
      {availableLimits.length === 0 ? null : (
        <section aria-label="Provider account limits" className="context-window-popover__limits">
          <h3>Provider account limits</h3>
          {availableLimits.map((row) => (
            <CapacityRow key={row.label} label={row.label} limit={row.limit} />
          ))}
        </section>
      )}
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

function CapacityRow(props: {
  readonly label: string;
  readonly limit: Extract<ServiceLimitBucket, { readonly status: "available" }>;
}) {
  const used = props.limit.limit - props.limit.remaining;
  const percent = props.limit.limit === 0 ? 0 : Math.round((used / props.limit.limit) * 100);
  return (
    <p>
      <span>{props.label}</span>
      <span>
        {compactTokens(props.limit.remaining)} of {compactTokens(props.limit.limit)} left ·{" "}
        {String(percent)}% used
      </span>
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
  readonly healthLabel?: string;
  readonly open: boolean;
  readonly snapshotLabel?: string;
  readonly status: string;
  readonly windowModel: ReturnType<typeof contextWindowModel> | undefined;
}): string {
  const action = input.open ? "Hide" : "Show";
  if (input.windowModel === undefined) {
    return `${action} context usage. ${emptyMessage(input.status)}`;
  }
  const unknown = input.windowModel.hasUnknown ? ", plus unknown" : "";
  const source = contextWindowUsedSourceLabel(input.windowModel.usedSource);
  const health = input.healthLabel === undefined ? "" : ` ${input.healthLabel}.`;
  const scope = input.snapshotLabel === undefined ? "" : ` for ${input.snapshotLabel}`;
  return `${action} context usage${scope}. ${input.windowModel.usageLabel} (${String(Math.round(input.windowModel.percent))}%)${unknown}. ${source}.${health}`;
}

function liveLabel(input: {
  readonly healthLabel?: string;
  readonly snapshotLabel?: string;
  readonly status: string;
  readonly windowModel: ReturnType<typeof contextWindowModel> | undefined;
}): string {
  if (input.windowModel === undefined) return emptyMessage(input.status);
  const unknown = input.windowModel.hasUnknown ? " plus unknown" : "";
  const source = contextWindowUsedSourceLabel(input.windowModel.usedSource);
  const health = input.healthLabel === undefined ? "" : ` ${input.healthLabel}.`;
  const scope = input.snapshotLabel === undefined ? "Context" : input.snapshotLabel;
  return `${scope}. ${input.windowModel.sourceLabel} ${input.windowModel.usageLabel} (${String(Math.round(input.windowModel.percent))}%)${unknown}. ${source}.${health}`;
}

function isAvailableLimit(
  limit: ServiceLimitBucket,
): limit is Extract<ServiceLimitBucket, { readonly status: "available" }> {
  return limit.status === "available";
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
