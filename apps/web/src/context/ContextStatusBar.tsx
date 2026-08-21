import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import type { ServiceLimitBucket } from "@octant/contracts/context";
import { ChevronUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  contextStatusModel,
  contextWindowModel,
  type ContextFocus,
  type ContextWindowSegment,
} from "./contextInspectorModel";
import { OctantButton } from "../ui/base/OctantButton";
import "./context.css";

export interface ContextStatusBarProps {
  readonly focus: ContextFocus;
  readonly onOpenInspector: () => void;
  readonly snapshot: ContextInspectorSnapshot;
}

export function ContextStatusBar(props: ContextStatusBarProps) {
  const model = contextStatusModel(props.snapshot, props.focus);
  const windowModel = contextWindowModel(props.snapshot);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

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

  return (
    <div className="context-status-bar" data-health={model.health}>
      <OctantButton
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} context window for ${props.snapshot.displayLabel}. ${model.healthLabel}.`}
        className="context-status-bar__button"
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        type="button"
        variant="ghost"
      >
        <span className="context-status-bar__scope">{model.scopeLabel}</span>
        <span className="context-status-bar__window-label">Context window</span>
        <span className="context-status-bar__usage">
          {windowModel.usageLabel} ({String(Math.round(windowModel.percent))}%)
          {windowModel.hasUnknown ? " + unknown" : ""}
        </span>
        <span className="context-status-bar__health">
          <span aria-hidden="true">{healthMark(model.health)}</span>
          {model.healthLabel}
        </span>
        {model.attentionLabel === undefined ? null : (
          <span className="context-status-bar__attention">{model.attentionLabel}</span>
        )}
        <ChevronUp aria-hidden="true" className="context-status-bar__chevron" size={12} />
      </OctantButton>
      {open ? (
        <div
          aria-label="Context window"
          className="popover-panel context-window-popover window-no-drag"
          id={panelId}
          ref={panel}
          role="dialog"
        >
          <header className="context-window-popover__header">
            <span>Context window</span>
            <strong>
              {windowModel.usageLabel} ({String(Math.round(windowModel.percent))}%)
            </strong>
          </header>
          <p className="context-window-popover__source">
            {windowModel.sourceLabel} · {props.snapshot.modelLimits.modelId}
          </p>
          <ContextMeter segments={windowModel.segments} totalTokens={windowModel.totalTokens} />
          <dl className="context-window-popover__breakdown">
            {windowModel.segments.map((segment) => (
              <div key={segment.key}>
                <dt>
                  <span aria-hidden="true" data-tone={segment.tone} />
                  {segment.label}
                </dt>
                <dd>
                  {segment.tokens === undefined ? "Unknown" : compactTokens(segment.tokens)}
                  {segment.tokens === undefined ? null : (
                    <span>{formatPercent(segment.percent)}</span>
                  )}
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
          <section aria-label="Provider capacity" className="context-window-popover__limits">
            <h3>Provider capacity</h3>
            <CapacityRow label="Requests" limit={props.snapshot.serviceLimits.requests} />
            <CapacityRow label="Tokens" limit={props.snapshot.serviceLimits.tokens} />
            <CapacityRow
              label="Concurrent turns"
              limit={props.snapshot.serviceLimits.concurrency}
            />
          </section>
          <OctantButton
            className="context-window-popover__inspect"
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
              props.onOpenInspector();
            }}
            type="button"
            variant="ghost"
          >
            Open full context inspector
          </OctantButton>
        </div>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {`${model.scopeLabel}. ${windowModel.sourceLabel} context ${windowModel.usageLabel}${windowModel.hasUnknown ? " plus unknown" : ""}. ${model.headroomLabel}. ${model.toolsLabel}. ${model.healthLabel}.`}
      </span>
    </div>
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
  const { limit } = props;
  if (limit.status === "unavailable") {
    return (
      <p data-state="unavailable">
        <span>{props.label}</span>
        <span>Not reported</span>
      </p>
    );
  }
  const used = limit.limit - limit.remaining;
  const percent = limit.limit === 0 ? 0 : Math.round((used / limit.limit) * 100);
  return (
    <p>
      <span>{props.label}</span>
      <span>
        {compactTokens(limit.remaining)} of {compactTokens(limit.limit)} left · {String(percent)}%
        used
      </span>
    </p>
  );
}

const tokenNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function compactTokens(tokens: number): string {
  return tokenNumber.format(tokens);
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(percent < 1 && percent > 0 ? 1 : 0)}%`;
}

function healthMark(health: ContextInspectorSnapshot["next"]["plan"]["health"]): string {
  if (health === "healthy") return "✓";
  if (health === "optimizing") return "↻";
  if (health === "rate-limited") return "◷";
  return "!";
}
