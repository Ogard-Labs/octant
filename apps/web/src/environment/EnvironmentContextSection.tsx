import "../styles/environment-details.css";
import "../context/context.css";
import type { ContextCompactionExecutor } from "@octant/contracts/context";
import { useState } from "react";
import { CompactSessionButton, CompactSessionConfirm } from "../context/CompactSession";
import { composerContextReading } from "../context/composerContextMeterReading";
import { useComposerContextMeterScope } from "../context/composerContextMeterScope";
import { compactTokenCount, type ContextWindowSegment } from "../context/contextInspectorModel";
import { compactionOffer } from "../context/sessionCompactionPresentation";
import { EnvironmentCard } from "./EnvironmentGroup";

/**
 * How full the thread's context window is, and what fills it, exactly as far as
 * the host or the provider reported. It reads the same answer as the composer's
 * ring (`composerContextReading`), so the two cannot disagree, and it shows
 * nothing the answer does not hold: no share without a named maximum, no
 * category rows without reported categories, and no zero for "unknown".
 */
export function EnvironmentContextSection() {
  const scope = useComposerContextMeterScope();
  // The compaction dialog is owned here, not by the composer's popover: this
  // button asks the same host path, through the same confirmation.
  const [confirming, setConfirming] = useState<ContextCompactionExecutor | undefined>(undefined);
  if (!scope.visible) return null;
  const reading = composerContextReading({
    snapshot: scope.snapshot,
    fallback: scope.fallback,
  });
  const compaction = scope.compaction;
  const offer = compactionOffer(compaction?.controller.state);

  if (reading.kind === "none") {
    return (
      <EnvironmentCard caption="Context" foldId="context">
        <p className="environment-context__none">
          {noReadingLine(scope.status, scope.usageReporting)}
        </p>
      </EnvironmentCard>
    );
  }

  const percent =
    reading.kind === "window" ? Math.max(0, Math.min(100, reading.percent)) : undefined;
  const percentText = percent === undefined ? undefined : `${formatShare(percent)} used`;
  const figure =
    reading.kind === "window"
      ? `${compactTokenCount(reading.usedTokens)} / ${compactTokenCount(reading.totalTokens)}`
      : `${compactTokenCount(reading.usedTokens)} used`;
  const segments = reading.kind === "window" ? reading.segments : [];
  const compactable =
    compaction !== undefined && (offer.kind === "available" || offer.kind === "disabled");

  return (
    <EnvironmentCard
      caption="Context"
      className="environment-context"
      foldId="context"
      summary={percentText ?? figure}
      summaryMark={
        percent === undefined ? null : (
          <span aria-hidden="true" className="environment-context__mini">
            <span style={{ width: `${String(percent)}%` }} />
          </span>
        )
      }
    >
      <p className="environment-context__head">
        <span className="environment-context__percent">{percentText ?? figure}</span>
        {percentText === undefined ? null : (
          <span className="environment-context__figure">{figure}</span>
        )}
      </p>
      {percent === undefined ? null : (
        <span
          aria-label={`Context window used, ${reading.kind === "window" ? reading.label : ""}`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(percent)}
          className="environment-context__meter"
          role="meter"
        >
          {segments.length === 0 ? (
            <span style={{ flexBasis: `${String(percent)}%` }} />
          ) : (
            segments.map((segment) => (
              <span
                data-tone={segment.tone}
                key={segment.key}
                style={{ flexBasis: `${String(segment.percent ?? 0)}%` }}
              />
            ))
          )}
        </span>
      )}
      {segments.length === 0 ? null : (
        <ul aria-label="What fills the context window" className="environment-context__parts">
          {segments.map((segment) => (
            <CategoryRow key={segment.key} segment={segment} />
          ))}
        </ul>
      )}
      {!compactable ? null : (
        <div className="environment-context__actions">
          <CompactSessionButton
            offer={offer}
            onRequest={() => {
              if (offer.kind === "available") setConfirming(offer.executor);
            }}
            starting={compaction.controller.starting}
          />
        </div>
      )}
      {confirming === undefined || compaction === undefined ? null : (
        <CompactSessionConfirm
          executor={confirming}
          names={compaction.names}
          onCancel={() => setConfirming(undefined)}
          onConfirm={() => {
            void compaction.controller.compact().finally(() => setConfirming(undefined));
          }}
          pending={compaction.controller.starting}
        />
      )}
    </EnvironmentCard>
  );
}

function CategoryRow(props: { readonly segment: ContextWindowSegment }) {
  const { segment } = props;
  return (
    <li className="environment-context__part" data-tone={segment.tone}>
      <span aria-hidden="true" className="context-window-popover__swatch" />
      <span className="environment-context__part-name">{segment.label}</span>
      <span className="environment-context__part-tokens">
        {segment.tokens === undefined ? "" : compactTokenCount(segment.tokens)}
      </span>
      <span className="environment-context__part-share">
        {segment.percent === undefined ? "" : formatShare(segment.percent)}
      </span>
    </li>
  );
}

/** The share as the composer's own panel writes it: one decimal only below a percent. */
function formatShare(percent: number): string {
  return `${percent.toFixed(percent < 1 && percent > 0 ? 1 : 0)}%`;
}

function noReadingLine(status: string, usageReporting: string | undefined): string {
  // Words that claim a provider never reports must not appear while a read is
  // still out, or for a provider that does report once it has something to say.
  if (status === "loading" || status === "updating") return "Reading context use.";
  if (usageReporting === "reported") return "No context use reported yet.";
  // Only a provider the host has confirmed as not reporting is said not to.
  // A provider not yet observed, or one whose reporting is unconfirmed, got
  // the same permanent claim, which was false for it.
  if (usageReporting === "not-reported") return "This provider does not report context use.";
  return "No context use reported.";
}
