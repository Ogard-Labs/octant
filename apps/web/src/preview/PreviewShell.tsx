import type { ReactNode } from "react";
import type { PreviewHandoffKind, PreviewTarget } from "@octant/contracts/previews";
import { OctantButton } from "../ui/base/OctantButton";
import type { PreviewControllerModel } from "./usePreviewController";
import { selectPreviewViewer } from "./previewViewers";
import { renderPreviewViewer } from "./PreviewRegistry";

export interface PreviewShellProps {
  readonly target: PreviewTarget | undefined;
  readonly model: PreviewControllerModel;
  readonly onRetry?: () => void;
  readonly onCancel?: () => void;
  readonly onHandoff?: (kind: PreviewHandoffKind) => Promise<void>;
  readonly handoffPending?: boolean;
  readonly onCancelHandoff?: () => void;
  readonly handoffMessage?: string;
}

export function PreviewShell(props: PreviewShellProps): ReactNode {
  const { model } = props;
  const canHandoff = model.status !== "stale" && props.onHandoff !== undefined;
  const canRevealInFinder =
    model.canRevealInFinder || model.manifest?.capabilities.canRevealInFinder === true;
  const canQuickLook = model.canQuickLook || model.manifest?.capabilities.canQuickLook === true;
  return (
    <section aria-label="Preview" className="preview-shell">
      <header className="preview-shell__header">
        <h2>{props.target?.displayName ?? "Preview"}</h2>
        <div className="preview-shell__actions">
          {model.canRetry ? (
            <OctantButton
              className="project-button"
              onClick={() => props.onRetry?.()}
              type="button"
              variant="secondary"
            >
              Retry
            </OctantButton>
          ) : null}
          {(model.status === "streaming" || model.status === "opening") && props.onCancel ? (
            <OctantButton
              className="project-button project-button--quiet"
              onClick={() => props.onCancel?.()}
              type="button"
              variant="ghost"
            >
              Cancel
            </OctantButton>
          ) : null}
          {canHandoff ? (
            <>
              {props.handoffPending && props.onCancelHandoff ? (
                <OctantButton
                  aria-label="Cancel native preview handoff"
                  className="project-button project-button--quiet"
                  onClick={() => props.onCancelHandoff?.()}
                  type="button"
                  variant="ghost"
                >
                  Cancel handoff
                </OctantButton>
              ) : null}
              {canRevealInFinder ? (
                <OctantButton
                  aria-label="Reveal preview in Finder"
                  className="project-button"
                  onClick={() => void props.onHandoff?.("reveal-in-finder")}
                  type="button"
                  variant="secondary"
                >
                  Reveal in Finder
                </OctantButton>
              ) : null}
              {canQuickLook ? (
                <OctantButton
                  aria-label="Open preview in Quick Look"
                  className="project-button"
                  onClick={() => void props.onHandoff?.("quick-look")}
                  type="button"
                  variant="secondary"
                >
                  Quick Look
                </OctantButton>
              ) : null}
              {model.canOpenExternally ? (
                <OctantButton
                  aria-label="Open preview externally"
                  className="project-button"
                  onClick={() => void props.onHandoff?.("open-external")}
                  type="button"
                  variant="secondary"
                >
                  Open externally
                </OctantButton>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      {props.handoffMessage === undefined ? null : (
        <p role="status" className="preview-shell__handoff-status">
          {props.handoffMessage}
        </p>
      )}
      <div className="preview-shell__body">{renderBody(props)}</div>
    </section>
  );
}

function renderBody(props: PreviewShellProps): ReactNode {
  const { model } = props;
  switch (model.status) {
    case "idle":
      return <p role="status">No preview selected.</p>;
    case "opening":
      return <p role="status">{model.message ?? "Opening preview…"}</p>;
    case "streaming":
    case "ready":
    case "limited-fidelity": {
      if (model.manifestKind === undefined) {
        return <p role="status">{model.message ?? "Loading…"}</p>;
      }
      if (model.manifest !== undefined) {
        return renderPreviewViewer({
          manifest: model.manifest,
          chunks: model.chunks,
        });
      }
      const viewer = selectPreviewViewer(model.manifestKind);
      if (viewer === undefined) {
        return <p role="status">{model.message ?? `No viewer for ${model.manifestKind}.`}</p>;
      }
      return viewer.render({
        chunks: model.chunks,
        ...(model.message === undefined ? {} : { message: model.message }),
      });
    }
    case "reconnecting":
      return <p role="status">{model.message ?? "Reconnecting…"}</p>;
    case "unauthorized":
      return <p role="alert">You do not have access to this preview.</p>;
    case "unavailable":
      return (
        <p role="status">
          {model.message ?? "Preview is unavailable."}
          {model.canRetry ? " Select Retry to try again." : ""}
        </p>
      );
    case "unsupported":
      return (
        <p role="status">
          {model.message ?? "This format is not supported for preview."}
          {model.canOpenExternally ? " You can open it in its native application." : ""}
        </p>
      );
    case "stale":
      return (
        <p role="status">
          {model.message ?? "The source changed since this preview was opened."}
          {model.canRetry ? " Select Retry to refresh." : ""}
        </p>
      );
    case "too-large":
      return (
        <p role="status">
          {model.message ?? "This file is too large to preview."}
          {model.canOpenExternally ? " You can open it in its native application." : ""}
        </p>
      );
    case "interrupted":
      return (
        <p role="status">
          {model.message ?? "Preview was interrupted."}
          {model.canRetry ? " Select Retry to continue." : ""}
        </p>
      );
    case "failure":
      return (
        <p role="alert">
          {model.message ?? "Preview could not be loaded."}
          {model.canRetry ? " Select Retry to try again." : ""}
        </p>
      );
  }
}
