import { Fragment, type ReactNode } from "react";
import type { TrackerReferenceResolution } from "@octant/contracts";
import { recognizeTrackerReferences, type TrackerReferenceSpan } from "@octant/domain";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { useTrackerReferenceResolutions } from "./TrackerReferenceContext";
import { trackerReferenceIdentity } from "./trackerReferenceResolve";

export interface TrackerReferenceTextProps {
  readonly text: string;
  /** When true, wrap the result in a paragraph. Default is an inline span. */
  readonly asParagraph?: boolean;
}

/**
 * Render a text run with recognized tracker tags replaced by title/status
 * chips when resolution succeeds. Unclaimed, unavailable, and not-found tags
 * stay as ordinary text (fail closed).
 */
export function TrackerReferenceText(props: TrackerReferenceTextProps) {
  const { spans, byIdentity } = useTrackerReferenceResolutions(props.text);
  const content = renderWithTrackerReferences(props.text, spans, byIdentity);
  if (props.asParagraph === true) {
    return <p className="tracker-reference-text">{content}</p>;
  }
  return <span className="tracker-reference-text">{content}</span>;
}

export function renderWithTrackerReferences(
  text: string,
  spans: ReadonlyArray<TrackerReferenceSpan>,
  byIdentity: ReadonlyMap<string, TrackerReferenceResolution>,
): ReactNode {
  if (spans.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, index) => {
    if (span.start > cursor) {
      parts.push(<Fragment key={`t-${cursor}`}>{text.slice(cursor, span.start)}</Fragment>);
    }
    const resolution = byIdentity.get(trackerReferenceIdentity(span.reference));
    if (resolution?.status === "resolved") {
      parts.push(<TrackerReferenceChip key={`r-${span.start}-${index}`} resolution={resolution} />);
    } else {
      parts.push(<Fragment key={`r-${span.start}-${index}`}>{span.reference.raw}</Fragment>);
    }
    cursor = span.end;
  });
  if (cursor < text.length) {
    parts.push(<Fragment key={`t-${cursor}`}>{text.slice(cursor)}</Fragment>);
  }
  return parts;
}

/**
 * Inline chip for a resolved tracker tag. The tooltip carries title and
 * status; the visible label stays the typed raw token so the transcript does
 * not invent a different identity than the journal text.
 */
export function TrackerReferenceChip(props: {
  readonly resolution: Extract<TrackerReferenceResolution, { readonly status: "resolved" }>;
}) {
  const { resolution } = props;
  const stateLabel = chipStateLabel(resolution);
  const label = (
    <span className="tracker-reference-chip__tooltip">
      <span className="tracker-reference-chip__title">{resolution.title}</span>
      <span className="tracker-reference-chip__state">{stateLabel}</span>
    </span>
  );
  return (
    <OctantTooltip label={label} side="top">
      <a
        aria-label={`${resolution.reference.raw}: ${resolution.title} (${stateLabel})`}
        className="tracker-reference-chip"
        href={resolution.url}
        rel="noreferrer"
        target="_blank"
      >
        <span className="tracker-reference-chip__raw">{resolution.reference.raw}</span>
        <span aria-hidden="true" className="tracker-reference-chip__meta">
          {stateLabel}
        </span>
      </a>
    </OctantTooltip>
  );
}

function chipStateLabel(
  resolution: Extract<TrackerReferenceResolution, { readonly status: "resolved" }>,
): string {
  if (resolution.kind === "pull-request") {
    if (resolution.state === "draft") return "Draft";
    if (resolution.state === "merged") return "Merged";
    if (resolution.state === "closed") return "Closed";
    return "Open";
  }
  return resolution.state === "closed" ? "Closed" : "Open";
}

/** Split used by ChatRichText plain tokens. */
export function splitPlainTextWithTrackerReferences(
  text: string,
  byIdentity: ReadonlyMap<string, TrackerReferenceResolution>,
): ReactNode {
  const spans = recognizeTrackerReferences(text);
  return renderWithTrackerReferences(text, spans, byIdentity);
}
