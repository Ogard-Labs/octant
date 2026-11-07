import type { CodeTurnReviewCapture, CodeTurnReviewPreview } from "@octant/contracts";
import { CodeTurnChangedFilesCard } from "./CodeTurnChangedFilesCard";

export function CodeTurnReviewPreviewCard(props: {
  readonly preview: CodeTurnReviewPreview;
  readonly onReviewFile?: (path: string, capture: CodeTurnReviewCapture) => void;
  readonly reviewUnavailable?: string;
  readonly settled: boolean;
}) {
  const capture = props.preview.capture;
  return (
    <section aria-label="Captured turn changes">
      {capture === undefined ? null : (
        <>
          <p>
            {capture.final ? "Final" : "Latest"} capture {capture.version} ·{" "}
            <time dateTime={capture.capturedAt}>
              {new Date(capture.capturedAt).toLocaleTimeString()}
            </time>
          </p>
          <p>
            Checkout changes since start tree {capture.baseline.slice(0, 8)}. Other people or agents
            may have changed these files.
          </p>
          {capture.changedFiles.total === 0 ? (
            <p>No changed paths were captured. Later edits may be uncaptured.</p>
          ) : null}
          {capture.diff.truncated === true ? (
            <p role="status">Only part of this captured comparison is retained.</p>
          ) : null}
          <CodeTurnChangedFilesCard
            changedFiles={capture.changedFiles}
            comparison="captured-turn"
            {...(props.onReviewFile === undefined
              ? {}
              : { onReviewFile: (path) => props.onReviewFile?.(path, capture) })}
            {...(props.reviewUnavailable === undefined
              ? {}
              : { reviewUnavailable: props.reviewUnavailable })}
          />
        </>
      )}
      <p role="status">
        {props.settled && capture?.final !== true
          ? "A final comparison was not captured. The last valid version remains available; later edits may be missing."
          : props.preview.explanation}
      </p>
    </section>
  );
}
