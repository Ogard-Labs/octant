import type {
  ValidationEvidenceSnapshot,
  ValidationOutcome,
  ValidationTimelineEntry,
  ValidationStepSummary,
} from "@octant/contracts/validation-rpc";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  MinusCircle,
  SkipForward,
  Loader,
} from "lucide-react";
import { useMemo } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export type ValidationPaneStatus =
  | "loading"
  | "waiting"
  | "unavailable"
  | "interrupted"
  | "denied"
  | "missing"
  | "stale"
  | "superseded"
  | "failed"
  | "ready";

export interface ValidationEvidencePaneProps {
  readonly status: ValidationPaneStatus;
  readonly snapshot?: ValidationEvidenceSnapshot;
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
}

export function ValidationEvidencePane(props: ValidationEvidencePaneProps) {
  if (props.status === "loading") {
    return (
      <section
        aria-label="Validation evidence"
        className="validation-pane validation-pane--loading"
      >
        <header className="validation-pane__header">
          <Loader
            aria-hidden="true"
            size={14}
            strokeWidth={2}
            className="validation-pane__spinner"
          />
          <span>Loading validation evidence…</span>
        </header>
      </section>
    );
  }

  if (props.status === "waiting") {
    return (
      <section
        aria-label="Validation evidence"
        className="validation-pane validation-pane--waiting"
      >
        <header className="validation-pane__header">
          <Clock aria-hidden="true" size={14} strokeWidth={2} />
          <span>Waiting for validation evidence…</span>
        </header>
      </section>
    );
  }

  if (props.status === "unavailable") {
    return (
      <section
        aria-label="Validation evidence"
        className="validation-pane validation-pane--unavailable"
      >
        <header className="validation-pane__header">
          <MinusCircle aria-hidden="true" size={14} strokeWidth={2} />
          <span>Validation evidence unavailable</span>
        </header>
        {props.errorMessage !== undefined ? (
          <p className="validation-pane__message">{props.errorMessage}</p>
        ) : null}
        {props.onRetry !== undefined ? (
          <OctantButton
            className="validation-pane__retry"
            onClick={props.onRetry}
            type="button"
            variant="secondary"
          >
            Retry
          </OctantButton>
        ) : null}
      </section>
    );
  }

  if (props.status === "interrupted") {
    return (
      <section
        aria-label="Validation evidence"
        className="validation-pane validation-pane--interrupted"
      >
        <header className="validation-pane__header">
          <AlertTriangle aria-hidden="true" size={14} strokeWidth={2} />
          <span>Validation evidence interrupted</span>
        </header>
        {props.onRetry !== undefined ? (
          <OctantButton
            className="validation-pane__retry"
            onClick={props.onRetry}
            type="button"
            variant="secondary"
          >
            Retry
          </OctantButton>
        ) : null}
      </section>
    );
  }

  if (
    props.status === "denied" ||
    props.status === "missing" ||
    props.status === "stale" ||
    props.status === "superseded"
  ) {
    const label = `Validation evidence ${props.status}`;
    return (
      <section
        aria-label="Validation evidence"
        className={`validation-pane validation-pane--${props.status}`}
      >
        <header className="validation-pane__header">
          <AlertTriangle aria-hidden="true" size={14} strokeWidth={2} />
          <span>{label}</span>
        </header>
        {props.errorMessage === undefined ? null : (
          <p
            className="validation-pane__message"
            role={props.status === "denied" ? "alert" : undefined}
          >
            {props.errorMessage}
          </p>
        )}
        {props.onRetry === undefined ? null : (
          <OctantButton
            className="validation-pane__retry"
            onClick={props.onRetry}
            type="button"
            variant="secondary"
          >
            Retry
          </OctantButton>
        )}
      </section>
    );
  }

  if (props.status === "failed") {
    return (
      <section aria-label="Validation evidence" className="validation-pane validation-pane--failed">
        <header className="validation-pane__header">
          <XCircle aria-hidden="true" size={14} strokeWidth={2} />
          <span>Validation evidence failed</span>
        </header>
        {props.errorMessage !== undefined ? (
          <p className="validation-pane__message" role="alert">
            {props.errorMessage}
          </p>
        ) : null}
        {props.onRetry !== undefined ? (
          <OctantButton
            className="validation-pane__retry"
            onClick={props.onRetry}
            type="button"
            variant="secondary"
          >
            Retry
          </OctantButton>
        ) : null}
      </section>
    );
  }

  if (props.snapshot === undefined) {
    return (
      <section aria-label="Validation evidence" className="validation-pane validation-pane--empty">
        <header className="validation-pane__header">
          <span>No validation evidence yet</span>
        </header>
      </section>
    );
  }

  return (
    <section aria-label="Validation evidence" className="validation-pane">
      <header className="validation-pane__header">
        <OutcomeIcon outcome={props.snapshot.overallOutcome} />
        <span className="validation-pane__outcome-label">
          {outcomeLabel(props.snapshot.overallOutcome)}
        </span>
      </header>
      {props.snapshot.steps.length > 0 ? <ValidationStepList steps={props.snapshot.steps} /> : null}
      {props.snapshot.timeline.length > 0 ? (
        <ValidationTimeline timeline={props.snapshot.timeline} />
      ) : null}
    </section>
  );
}

function ValidationStepList(props: { readonly steps: ReadonlyArray<ValidationStepSummary> }) {
  return (
    <div className="validation-pane__steps" role="list" aria-label="Validation steps">
      {props.steps.map((step) => (
        <div className="validation-pane__step" key={step.stepId} role="listitem">
          <OutcomeIcon outcome={step.outcome} />
          <div className="validation-pane__step-content">
            <span className="validation-pane__step-description">{step.description}</span>
            <span className="validation-pane__step-meta">
              {step.evidenceCount} evidence · {step.sourceKinds.join(", ")}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ValidationTimeline(props: { readonly timeline: ReadonlyArray<ValidationTimelineEntry> }) {
  const sorted = useMemo(
    () => [...props.timeline].sort((a, b) => a.sequence - b.sequence),
    [props.timeline],
  );
  return (
    <div className="validation-pane__timeline" role="list" aria-label="Evidence timeline">
      {sorted.map((entry) => (
        <div
          className="validation-pane__timeline-entry"
          key={String(entry.evidenceId)}
          role="listitem"
        >
          <OutcomeIcon outcome={entry.outcome} />
          <div className="validation-pane__timeline-content">
            <span className="validation-pane__timeline-kind">{entry.sourceKind}</span>
            <span className="validation-pane__timeline-ref">{entry.sourceReference}</span>
            {entry.redacted ? (
              <span className="validation-pane__timeline-redacted">Redacted</span>
            ) : null}
            {entry.detail !== undefined ? (
              <pre className="validation-pane__timeline-detail">{entry.detail}</pre>
            ) : null}
          </div>
          <time className="validation-pane__timeline-time" dateTime={entry.observedAt}>
            {formatTime(entry.observedAt)}
          </time>
        </div>
      ))}
    </div>
  );
}

function OutcomeIcon(props: { readonly outcome: ValidationOutcome }) {
  switch (props.outcome) {
    case "passed":
      return (
        <CheckCircle
          aria-label="Passed"
          className="validation-pane__icon validation-pane__icon--passed"
          size={14}
          strokeWidth={2}
        />
      );
    case "failed":
      return (
        <XCircle
          aria-label="Failed"
          className="validation-pane__icon validation-pane__icon--failed"
          size={14}
          strokeWidth={2}
        />
      );
    case "inconclusive":
      return (
        <AlertTriangle
          aria-label="Inconclusive"
          className="validation-pane__icon validation-pane__icon--inconclusive"
          size={14}
          strokeWidth={2}
        />
      );
    case "unavailable":
      return (
        <MinusCircle
          aria-label="Unavailable"
          className="validation-pane__icon validation-pane__icon--unavailable"
          size={14}
          strokeWidth={2}
        />
      );
    case "interrupted":
      return (
        <AlertTriangle
          aria-label="Interrupted"
          className="validation-pane__icon validation-pane__icon--interrupted"
          size={14}
          strokeWidth={2}
        />
      );
    case "skipped":
      return (
        <SkipForward
          aria-label="Skipped"
          className="validation-pane__icon validation-pane__icon--skipped"
          size={14}
          strokeWidth={2}
        />
      );
  }
}

function outcomeLabel(outcome: ValidationOutcome): string {
  switch (outcome) {
    case "passed":
      return "All checks passed";
    case "failed":
      return "Some checks failed";
    case "inconclusive":
      return "Inconclusive";
    case "unavailable":
      return "Unavailable";
    case "interrupted":
      return "Interrupted";
    case "skipped":
      return "Skipped";
    default:
      return outcome;
  }
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString();
  } catch {
    return timestamp;
  }
}
