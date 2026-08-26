import type { ContextEntryId, ContextRemedy, ServiceLimitBucket } from "@octant/contracts/context";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import type { RefObject } from "react";
import {
  contextCategoryLabel,
  contextCompositionEntries,
  contextEntryControls,
  contextHealthLabel,
  serviceLimitLabel,
  tokenMeasurementLabel,
  type ContextCompositionEntry,
} from "./contextInspectorModel";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCard } from "../ui/base/OctantCard";
import "./context.css";

const numberFormat = new Intl.NumberFormat();
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export interface ContextInspectorProps {
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRebuild: () => void;
  readonly onSetExcluded: (entryId: ContextEntryId, excluded: boolean) => void;
  readonly onSetPinned: (entryId: ContextEntryId, pinned: boolean) => void;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
  readonly snapshot: ContextInspectorSnapshot;
}

export function ContextInspector(props: ContextInspectorProps) {
  const { snapshot } = props;
  const { plan } = snapshot.next;
  const composition = contextCompositionEntries(snapshot);
  const close = () => {
    props.onClose();
    queueMicrotask(() => props.restoreFocus?.current?.focus());
  };
  return (
    <aside aria-label="Context inspector" className="context-inspector">
      <header className="context-inspector__header">
        <div>
          <span className="context-inspector__eyebrow">{snapshot.displayLabel}</span>
          <h2>Context inspector</h2>
        </div>
        <div className="context-inspector__header-actions">
          <OctantButton
            disabled={props.busy}
            onClick={props.onRebuild}
            type="button"
            variant="secondary"
          >
            Rebuild context plan
          </OctantButton>
          <OctantButton
            aria-label="Close context inspector"
            onClick={close}
            type="button"
            variant="ghost"
          >
            Close
          </OctantButton>
        </div>
      </header>

      <div className="context-inspector__scroll">
        <section aria-labelledby="context-health-title" className="context-inspector__section">
          <h3 id="context-health-title">Planned next turn</h3>
          <p
            className="context-inspector__health"
            data-health={plan.health}
            role={plan.blocked ? "alert" : "status"}
          >
            <strong>{contextHealthLabel(plan.health)}</strong>
            <span>
              {plan.blocked ? "No safe request can be constructed." : "Plan is server evaluated."}
            </span>
          </p>
          <dl className="context-inspector__facts">
            <Fact label="Model" value={snapshot.modelLimits.modelId} />
            <Fact label="Context window" value={formatNumber(snapshot.modelLimits.contextWindow)} />
            <Fact label="Maximum output" value={formatNumber(snapshot.modelLimits.maxOutput)} />
            <Fact label="Safe input budget" value={formatNumber(plan.safeInputBudget)} />
            <Fact label="Planned input" value={formatNumber(plan.plannedInputTokens)} />
            <Fact label="Response reserve" value={formatNumber(plan.reserves.response)} />
            <Fact label="Reasoning reserve" value={formatNumber(plan.reserves.reasoning)} />
            <Fact label="Framing reserve" value={formatNumber(plan.reserves.framing)} />
            <Fact label="Variance reserve" value={formatNumber(plan.reserves.variance)} />
            <Fact label="Safety reserve" value={formatNumber(plan.reserves.safety)} />
          </dl>
        </section>

        <section aria-labelledby="context-service-title" className="context-inspector__section">
          <h3 id="context-service-title">Provider capacity</h3>
          <p className="context-inspector__freshness">
            <span>Updated</span>{" "}
            <time dateTime={snapshot.serviceLimits.updatedAt}>
              {formatTime(snapshot.serviceLimits.updatedAt)}
            </time>
          </p>
          {hasUnavailableLimit(snapshot) ? <p>Unavailable</p> : null}
          <dl className="context-inspector__facts">
            <Fact label="Requests" value={serviceLimitLabel(snapshot.serviceLimits.requests)} />
            <Fact label="Tokens" value={serviceLimitLabel(snapshot.serviceLimits.tokens)} />
            <Fact
              label="Concurrency"
              value={serviceLimitLabel(snapshot.serviceLimits.concurrency)}
            />
            <Fact label="Quota" value={snapshot.serviceLimits.quota} />
            <Fact label="Reservation" value={snapshot.capacity?.state ?? "Unavailable"} />
            <Fact label="Retry" value={retryLabel(snapshot)} />
            <Fact label="Requests reset" value={resetLabel(snapshot.serviceLimits.requests)} />
            <Fact label="Tokens reset" value={resetLabel(snapshot.serviceLimits.tokens)} />
            <Fact
              label="Concurrency reset"
              value={resetLabel(snapshot.serviceLimits.concurrency)}
            />
          </dl>
        </section>

        <section aria-labelledby="context-composition-title" className="context-inspector__section">
          <div className="context-inspector__section-heading">
            <h3 id="context-composition-title">Composition</h3>
            <span>
              Tools {snapshot.capabilities.loadedTools}/{snapshot.capabilities.availableTools} · MCP{" "}
              {snapshot.capabilities.loadedMcp}/{snapshot.capabilities.availableMcp}
            </span>
          </div>
          <div className="context-inspector__entries">
            {composition.map((entry) => (
              <ContextEntryCard
                busy={props.busy}
                entry={entry}
                key={entry.id}
                onSetExcluded={props.onSetExcluded}
                onSetPinned={props.onSetPinned}
                snapshot={snapshot}
              />
            ))}
          </div>
        </section>

        <section aria-labelledby="context-history-title" className="context-inspector__section">
          <h3 id="context-history-title">Latest sent</h3>
          {snapshot.latestSent === undefined ? (
            <p>No sent plan is available.</p>
          ) : (
            <LatestSent snapshot={snapshot} />
          )}
          <h4>Reconciliation</h4>
          {snapshot.latestUsage === undefined ? (
            <p>Provider usage unavailable.</p>
          ) : (
            <p>
              Actual input {formatNumber(snapshot.latestUsage.actualInputTokens)} · Output{" "}
              {formatNumber(snapshot.latestUsage.actualOutputTokens)} · Variance{" "}
              {signed(snapshot.latestUsage.varianceTokens)}
            </p>
          )}
          <h4>Summary provenance</h4>
          {snapshot.summaries.length === 0 ? (
            <p>No reusable summaries yet.</p>
          ) : (
            <ul>
              {snapshot.summaries.map((summary) => (
                <li key={summary.id}>
                  {summary.sourceEntryIds.length} source entries ·{" "}
                  {formatNumber(summary.estimatedSavingsTokens)} estimated tokens saved
                </li>
              ))}
            </ul>
          )}
        </section>

        {plan.remedies.length === 0 ? null : (
          <section aria-labelledby="context-remedies-title" className="context-inspector__section">
            <h3 id="context-remedies-title">Safe remedies</h3>
            <ul>
              {uniqueRemedies(plan.remedies).map((remedy) => (
                <li key={remedyKey(remedy)}>{remedyLabel(remedy)}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <p aria-live="polite" className="sr-only">
        {props.busy
          ? "Updating context plan."
          : `${contextHealthLabel(plan.health)} context plan loaded.`}
      </p>
    </aside>
  );
}

function ContextEntryCard(props: {
  readonly busy: boolean;
  readonly entry: ContextCompositionEntry;
  readonly onSetExcluded: ContextInspectorProps["onSetExcluded"];
  readonly onSetPinned: ContextInspectorProps["onSetPinned"];
  readonly snapshot: ContextInspectorSnapshot;
}) {
  const controls = contextEntryControls(props.entry, props.snapshot);
  return (
    <OctantCard
      aria-label={props.entry.label}
      className="context-entry-card gap-0 p-2"
      data-state={props.entry.plannedState}
      role="article"
    >
      <header>
        <div>
          <span>{contextCategoryLabel(props.entry.category)}</span>
          <h4>{props.entry.label}</h4>
        </div>
        <span>{props.entry.plannedState}</span>
      </header>
      <dl className="context-entry-card__facts">
        <Fact label="Tokens" value={tokenMeasurementLabel(props.entry.plannedTokens)} />
        <Fact
          label="Size"
          value={`${formatNumber(props.entry.includedSize)} of ${formatNumber(props.entry.originalSize)}`}
        />
        <Fact label="Reason" value={humanize(props.entry.planReason)} />
        <Fact label="Preview" value={props.entry.preview.label ?? "Redacted"} />
      </dl>
      <div className="context-entry-card__actions">
        <OctantButton
          aria-pressed={controls.pinned}
          disabled={props.busy || (!controls.pinned && !controls.canPin)}
          onClick={() => props.onSetPinned(props.entry.id, !controls.pinned)}
          type="button"
          variant="secondary"
        >
          {controls.pinned ? "Unpin" : "Pin"} {props.entry.label} next turn
        </OctantButton>
        <OctantButton
          aria-pressed={controls.excluded}
          disabled={props.busy || (!controls.excluded && !controls.canExclude)}
          onClick={() => props.onSetExcluded(props.entry.id, !controls.excluded)}
          type="button"
          variant="ghost"
        >
          {controls.excluded ? "Include" : "Exclude"} {props.entry.label} next turn
        </OctantButton>
      </div>
    </OctantCard>
  );
}

function LatestSent(props: { readonly snapshot: ContextInspectorSnapshot }) {
  const latest = props.snapshot.latestSent;
  if (latest === undefined) return null;
  const entries = contextCompositionEntries(props.snapshot, latest);
  return (
    <div className="context-latest-sent">
      <dl className="context-inspector__facts">
        <Fact label="Manifest" value={latest.manifest.id} />
        <Fact label="Plan" value={latest.plan.id} />
        <Fact label="Planned input" value={formatNumber(latest.plan.plannedInputTokens)} />
        <Fact label="Response reserve" value={formatNumber(latest.plan.reserves.response)} />
        <Fact label="Reasoning reserve" value={formatNumber(latest.plan.reserves.reasoning)} />
        <Fact label="Framing reserve" value={formatNumber(latest.plan.reserves.framing)} />
        <Fact label="Variance reserve" value={formatNumber(latest.plan.reserves.variance)} />
        <Fact label="Safety reserve" value={formatNumber(latest.plan.reserves.safety)} />
      </dl>
      <div className="context-latest-sent__entries">
        {entries.map((entry) => (
          <article aria-label={`Sent ${entry.label}`} key={entry.id}>
            <h4>{entry.label}</h4>
            <dl className="context-entry-card__facts">
              <Fact label="State" value={humanize(entry.plannedState)} />
              <Fact label="Reason" value={humanize(entry.planReason)} />
              <Fact label="Tokens" value={tokenMeasurementLabel(entry.plannedTokens)} />
              <Fact
                label="Reduction"
                value={
                  entry.plannedState === "included"
                    ? "None"
                    : `${humanize(entry.plannedState)} from ${formatNumber(entry.originalSize)} source units`
                }
              />
            </dl>
          </article>
        ))}
      </div>
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

function hasUnavailableLimit(snapshot: ContextInspectorSnapshot): boolean {
  return (
    snapshot.serviceLimits.requests.status === "unavailable" ||
    snapshot.serviceLimits.tokens.status === "unavailable" ||
    snapshot.serviceLimits.concurrency.status === "unavailable"
  );
}

function retryLabel(snapshot: ContextInspectorSnapshot): string {
  return snapshot.serviceLimits.retry.status === "inactive"
    ? "Inactive"
    : `Active until ${formatTime(snapshot.serviceLimits.retry.until)}`;
}

function resetLabel(bucket: ServiceLimitBucket): string {
  if (bucket.status === "unavailable") return "Unavailable";
  return bucket.resetsAt === undefined ? "Not reported" : formatTime(bucket.resetsAt);
}

function formatNumber(value: number): string {
  return numberFormat.format(value);
}

function formatTime(timestamp: string): string {
  return dateTimeFormat.format(new Date(timestamp));
}

function signed(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function humanize(value: string): string {
  return value.replaceAll("-", " ");
}

function remedyLabel(remedy: ContextRemedy): string {
  return {
    "unpin-context": "Unpin context",
    "exclude-context": "Exclude optional context",
    "compact-range": "Compact a conversation range",
    "unload-capabilities": "Unload optional capabilities",
    "replace-with-reference": "Replace content with a local reference",
    "reduce-output-reserve": "Reduce the explicit output reserve",
    "switch-model": "Switch to a larger context model",
    "fork-thread": "Start from a structured handoff",
  }[remedy.kind];
}

function remedyKey(remedy: ContextRemedy): string {
  return `${remedy.kind}:${remedy.entryId ?? "global"}`;
}

function uniqueRemedies(remedies: ReadonlyArray<ContextRemedy>): ReadonlyArray<ContextRemedy> {
  return [...new Map(remedies.map((remedy) => [remedyKey(remedy), remedy])).values()];
}
