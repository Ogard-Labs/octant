import { useMemo } from "react";
import type { PreviewChunk, PreviewManifest } from "@octant/contracts/previews";
import { PreviewFidelityNotice } from "./PreviewFidelityNotice";
import { buildDocumentViewModel } from "./previewChunkModel";

/**
 * Read-only DOCX preview viewer. Renders paragraph blocks in document
 * order with a structural text view. Complex layout, fonts, fields,
 * comments, and tracked changes are not preserved; the fidelity notice
 * surfaces the limitation.
 */
export function DocumentViewer(props: {
  readonly manifest: PreviewManifest;
  readonly chunks: ReadonlyArray<PreviewChunk>;
}) {
  const model = useMemo(() => buildDocumentViewModel(props.chunks), [props.chunks]);

  if (model.blocks.length === 0) {
    return (
      <section className="preview-viewer" aria-label="Document preview">
        <PreviewFidelityNotice fidelity={props.manifest.fidelity} />
        <div className="preview-empty" role="status">
          No document text extracted.
        </div>
      </section>
    );
  }

  return (
    <section className="preview-viewer" aria-label="Document preview">
      <PreviewFidelityNotice fidelity={props.manifest.fidelity} />
      <div className="preview-viewer__chrome">
        <h2 className="preview-viewer__title" title={props.manifest.target.displayName}>
          {props.manifest.target.displayName}
        </h2>
        <div className="preview-viewer__meta">
          <span>{model.blocks.length} paragraphs</span>
        </div>
      </div>
      <div className="preview-viewer__body">
        <article className="preview-document">
          {model.blocks.map((block, index) => (
            <p
              key={index}
              className={`preview-document__block${block.length === 0 ? " preview-document__block--empty" : ""}`}
            >
              {block.length > 0 ? block : "\u00a0"}
            </p>
          ))}
        </article>
      </div>
    </section>
  );
}
