import type { CanvasBlock } from "@octant/contracts/canvas";
import { CodeBlocks } from "./CodeBlocks";
import { DataBlocks } from "./DataBlocks";
import { ReferenceBlocks } from "./ReferenceBlocks";
import type { DiagramBoardLayoutRuntime } from "./DiagramBoard";
import { StructuredBlocks } from "./StructuredBlocks";
import { TextBlocks } from "./TextBlocks";

export function CanvasBlockRenderer({
  block,
  layoutRuntime,
}: {
  readonly block: CanvasBlock;
  /** Lets a diagram journal a drag; absent on surfaces that cannot. */
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
}) {
  switch (block.kind) {
    case "heading":
    case "rich-text":
    case "callout":
    case "link":
    case "divider":
    case "citation":
      return <TextBlocks block={block} />;
    case "metric":
    case "progress":
    case "status":
    case "key-value":
      return <DataBlocks block={block} />;
    case "table":
    case "chart":
    case "timeline":
    case "diagram":
      return (
        <StructuredBlocks
          block={block}
          {...(layoutRuntime === undefined ? {} : { layoutRuntime })}
        />
      );
    case "code-excerpt":
    case "pseudocode":
    case "diff":
      return <CodeBlocks block={block} />;
    case "source-reference":
    case "summary":
    case "artifact-reference":
    case "file-reference":
    case "preview-reference":
    case "browser-reference":
    case "evidence-reference":
    case "image":
      return <ReferenceBlocks block={block} />;
    default:
      return null;
  }
}
