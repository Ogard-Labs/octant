import type { ReactNode } from "react";
import type { PreviewChunk, PreviewKind } from "@octant/contracts/previews";
import { Markdown } from "../markdown/Markdown";

/**
 * Closed viewer registry. Only text, markdown, and image kinds have native
 * viewers in this slice. Every other kind surfaces an honest `unsupported`
 * state through the shell rather than falling back to a generic renderer that
 * might leak host paths or attempt a network load. The registry is closed
 * (not extensible at runtime) so a malformed manifest kind can never select
 * an unvetted viewer.
 */
export type PreviewViewerKind = "text" | "markdown" | "image";

export interface PreviewViewerProps {
  readonly chunks: ReadonlyArray<PreviewChunk>;
  readonly message?: string;
}

export interface PreviewViewerEntry {
  readonly kind: PreviewViewerKind;
  readonly render: (props: PreviewViewerProps) => ReactNode;
}

const VIEWERS: ReadonlyArray<PreviewViewerEntry> = [
  { kind: "text", render: renderText },
  { kind: "markdown", render: renderMarkdown },
  { kind: "image", render: renderImage },
];

export function selectPreviewViewer(kind: PreviewKind): PreviewViewerEntry | undefined {
  return VIEWERS.find((viewer) => viewer.kind === kind);
}

function renderText(props: PreviewViewerProps): ReactNode {
  const text = collectText(props.chunks);
  return (
    <pre className="preview-viewer preview-viewer--text" data-testid="preview-viewer-text">
      {text === "" ? (props.message ?? "Nothing to show.") : text}
    </pre>
  );
}

function renderMarkdown(props: PreviewViewerProps): ReactNode {
  const text = collectText(props.chunks);
  return (
    <div className="preview-viewer preview-viewer--markdown" data-testid="preview-viewer-markdown">
      {text === "" ? (
        <p role="status">{props.message ?? "Nothing to show."}</p>
      ) : (
        <Markdown body={text} />
      )}
    </div>
  );
}

function renderImage(props: PreviewViewerProps): ReactNode {
  const dataUrl = collectImageDataUrl(props.chunks);
  if (dataUrl === undefined) {
    return (
      <p
        role="status"
        className="preview-viewer preview-viewer--image"
        data-testid="preview-viewer-image"
      >
        {props.message ?? "Image is unavailable."}
      </p>
    );
  }
  return (
    // The data URL is constrained by the contract to data:image/...;base64,...
    // so this img never triggers a network or local-resource load.
    <img
      alt={props.message ?? "Preview image"}
      className="preview-viewer preview-viewer--image"
      data-testid="preview-viewer-image"
      src={dataUrl}
    />
  );
}

function collectText(chunks: ReadonlyArray<PreviewChunk>): string {
  return chunks
    .filter((chunk) => chunk.payload.kind === "text" || chunk.payload.kind === "markdown")
    .map((chunk) =>
      chunk.payload.kind === "text" || chunk.payload.kind === "markdown" ? chunk.payload.text : "",
    )
    .join("");
}

function collectImageDataUrl(chunks: ReadonlyArray<PreviewChunk>): string | undefined {
  for (const chunk of chunks) {
    if (chunk.payload.kind === "image") return chunk.payload.dataUrl;
  }
  return undefined;
}
