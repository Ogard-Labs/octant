import type { CanvasBlock, CanvasSourceKind } from "@octant/contracts/canvas";
import { formatScalar } from "../canvasRuntime";

type ReferenceKind =
  | "source-reference"
  | "artifact-reference"
  | "file-reference"
  | "preview-reference"
  | "browser-reference"
  | "evidence-reference";

type Block = Extract<CanvasBlock, { readonly kind: ReferenceKind | "summary" | "image" }>;

const referenceLabel: Record<ReferenceKind, string> = {
  "source-reference": "Source",
  "artifact-reference": "Artifact",
  "file-reference": "File",
  "preview-reference": "Preview",
  "browser-reference": "Browser",
  "evidence-reference": "Evidence",
};

const sourceKindLabel: Partial<Record<CanvasSourceKind, string>> = {
  attachment: "Attachment",
  file: "File",
  artifact: "Artifact",
  preview: "Preview",
  browser: "Browser",
  evidence: "Evidence",
  image: "Image",
  thread: "Thread",
};

export function ReferenceBlocks({ block }: { readonly block: Block }) {
  switch (block.kind) {
    case "image":
      return (
        <figure className="canvas-block__image">
          <div role="img" aria-label={block.alt} className="canvas-block__image-frame">
            <span>{sourceKindLabel.image ?? "Image"}</span>
          </div>
          <figcaption>{block.caption ?? block.alt}</figcaption>
        </figure>
      );
    case "summary":
      return (
        <section className="canvas-block__summary" aria-label={`${block.summaryKind} summary`}>
          <h3 className="canvas-block__summary-title">{block.title}</h3>
          <ul>
            {block.items.map((item, index) => (
              <li
                key={index}
                className={
                  item.status !== undefined
                    ? `canvas-block__summary-item canvas-block__summary-item--${item.status}`
                    : "canvas-block__summary-item"
                }
              >
                {item.status !== undefined ? (
                  <span className="canvas-block__summary-dot" aria-hidden="true" />
                ) : null}
                <span className="canvas-block__summary-label">{item.label}</span>
                {item.value !== undefined ? (
                  <span className="canvas-block__summary-value">{formatScalar(item.value)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      );
    case "source-reference":
    case "artifact-reference":
    case "file-reference":
    case "preview-reference":
    case "browser-reference":
    case "evidence-reference":
      return (
        <div className="canvas-block__reference" role="listitem">
          <span className="canvas-block__reference-kind">{referenceLabel[block.kind]}</span>
          <span className="canvas-block__reference-label">{block.label}</span>
          {block.detail !== undefined ? (
            <span className="canvas-block__reference-detail">{block.detail}</span>
          ) : null}
          <span className="canvas-block__reference-note">Source not linked</span>
        </div>
      );
  }
}
