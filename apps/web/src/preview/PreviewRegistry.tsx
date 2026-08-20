import type { ReactNode } from "react";
import type { PreviewChunk, PreviewKind, PreviewManifest } from "@octant/contracts/previews";
import {
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  isPreviewViewerAvailable,
  type FirstPartyPluginComponentId,
} from "../shell/contributionRegistry";
import { PdfViewer } from "./PdfViewer";
import { TableViewer } from "./TableViewer";
import { WorkbookViewer } from "./WorkbookViewer";
import { DocumentViewer } from "./DocumentViewer";
import { SlidesViewer } from "./SlidesViewer";
import { selectPreviewViewer } from "./previewViewers";

/**
 * Single dispatch point for preview viewers. Structured formats render
 * through their dedicated viewers; text/markdown/image reuse the closed
 * primitive registry from `previewViewers`. Unknown kinds render an honest
 * unsupported state instead of a broken viewer. Plugin-contributed kinds
 * disappear when their component is not effective.
 */
export function renderPreviewViewer(props: {
  readonly manifest: PreviewManifest;
  readonly chunks: ReadonlyArray<PreviewChunk>;
  readonly effectivePlugins?: ReadonlyMap<FirstPartyPluginComponentId, boolean>;
}): ReactNode {
  const kind = props.manifest.kind;
  if (!isPreviewViewerAvailable(kind, props.effectivePlugins ?? FIRST_PARTY_PLUGINS_EFFECTIVE)) {
    return renderUnsupported(props.manifest);
  }
  return renderForKind(kind, props.manifest, props.chunks);
}

function renderForKind(
  kind: PreviewKind,
  manifest: PreviewManifest,
  chunks: ReadonlyArray<PreviewChunk>,
): ReactNode {
  switch (kind) {
    case "pdf":
      return <PdfViewer manifest={manifest} chunks={chunks} />;
    case "table":
      return <TableViewer manifest={manifest} chunks={chunks} />;
    case "workbook":
      return <WorkbookViewer manifest={manifest} chunks={chunks} />;
    case "document":
      return <DocumentViewer manifest={manifest} chunks={chunks} />;
    case "slides":
      return <SlidesViewer manifest={manifest} chunks={chunks} />;
    case "text":
    case "markdown":
    case "image": {
      const viewer = selectPreviewViewer(kind);
      if (viewer === undefined) {
        return (
          <section className="preview-viewer" aria-label="Unsupported preview">
            <div className="preview-empty" role="status">
              No viewer for this format.
            </div>
          </section>
        );
      }
      return viewer.render({ chunks });
    }
    case "unsupported":
    default:
      return renderUnsupported(manifest);
  }
}

function renderUnsupported(manifest: PreviewManifest): ReactNode {
  return (
    <section className="preview-viewer" aria-label="Unsupported preview">
      <div className="preview-viewer__chrome">
        <h2 className="preview-viewer__title">{manifest.target.displayName}</h2>
        <div className="preview-viewer__meta">
          <span>No structured viewer for this format.</span>
        </div>
      </div>
      <div className="preview-empty" role="status">
        Open the file externally for a full-fidelity view.
      </div>
    </section>
  );
}
