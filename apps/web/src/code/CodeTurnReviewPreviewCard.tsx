import type { CodeTurnReviewCapture, CodeTurnReviewPreview } from "@octant/contracts";
import { Camera, ChevronRight } from "../ui/icons";
import { CodeTurnChangedFilesCard } from "./CodeTurnChangedFilesCard";

export function CodeTurnReviewPreviewCard(props: {
  readonly preview: CodeTurnReviewPreview;
  readonly onReviewFile?: (path: string, capture: CodeTurnReviewCapture) => void;
  readonly reviewUnavailable?: string;
  readonly settled: boolean;
}) {
  const capture = props.preview.capture;
  const finalMissing = props.settled && capture?.final !== true;
  return (
    <section aria-label="Captured turn changes">
      {/* The host's notes about the checkout read as one quiet line under the
          reply, so they are not mistaken for part of the answer. */}
      <details className="turn-activity__disclosure code-turn-capture">
        <summary>
          <ChevronRight aria-hidden="true" className="turn-activity__chevron" size={14} />
          <Camera aria-hidden="true" className="turn-activity__kind-icon" size={14} />
          <span className="turn-activity__name">
            Checkout capture
            {capture === undefined ? null : (
              <>
                {" · "}
                <time dateTime={capture.capturedAt}>
                  {new Date(capture.capturedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </>
            )}
          </span>
        </summary>
        <div className="turn-activity__notes">
          {capture === undefined ? null : (
            <>
              <p>
                {capture.final ? "Final" : "Latest"} capture {capture.version} ·{" "}
                <time dateTime={capture.capturedAt}>
                  {new Date(capture.capturedAt).toLocaleTimeString()}
                </time>
              </p>
              <p>
                Checkout changes since start tree {capture.baseline.slice(0, 8)}. Other people or
                agents may have changed these files.
              </p>
              {capture.changedFiles.total === 0 ? (
                <p>No changed paths were captured. Later edits may be uncaptured.</p>
              ) : null}
              {capture.diff.truncated === true ? (
                <p role="status">Only part of this captured comparison is retained.</p>
              ) : null}
            </>
          )}
          <p role="status">
            {finalMissing
              ? "A final comparison was not captured. The last valid version remains available; later edits may be missing."
              : props.preview.explanation}
          </p>
        </div>
      </details>
      {capture === undefined ? null : (
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
      )}
    </section>
  );
}
