import type { CanvasBlock } from "@octant/contracts/canvas";
import { CodeBlocks } from "./CodeBlocks";
import { DataBlocks } from "./DataBlocks";
import { PlanBlock, type PlanTaskRuntime } from "./PlanBlock";
import { ReferenceBlocks } from "./ReferenceBlocks";
import type { DiagramBoardLayoutRuntime } from "./DiagramBoard";
import {
  ErDiagram,
  MindmapDiagram,
  SequenceDiagram,
  StateDiagram,
  SwimlaneDiagram,
} from "./KindDiagrams";
import { DesignBlock } from "./DesignBlock";
import { MockupBlock } from "./MockupBlock";
import { StructuredBlocks } from "./StructuredBlocks";
import { TextBlocks } from "./TextBlocks";
import { TreemapBlock } from "./TreemapBlock";
import { HeatmapBlock } from "./HeatmapBlock";
import { BarListBlock } from "./BarListBlock";
import type { CanvasActionRuntime } from "../canvasActionRuntime";

export function CanvasBlockRenderer({
  block,
  layoutRuntime,
  planRuntime,
  actionRuntime,
}: {
  readonly block: CanvasBlock;
  /** Lets a diagram journal a drag; absent on surfaces that cannot. */
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
  /** Lets a plan journal a task's status; absent on surfaces that cannot. */
  readonly planRuntime?: PlanTaskRuntime;
  /**
   * Lets a block offer an allowlisted action, such as a treemap leaf opening
   * its file; absent on surfaces that cannot dispatch one.
   */
  readonly actionRuntime?: CanvasActionRuntime;
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
    case "sequence":
      return <SequenceDiagram block={block} />;
    case "state":
      return <StateDiagram block={block} />;
    case "er":
      return <ErDiagram block={block} />;
    case "swimlane":
      return <SwimlaneDiagram block={block} />;
    case "mindmap":
      return <MindmapDiagram block={block} />;
    case "mockup":
      return <MockupBlock block={block} />;
    case "treemap":
      return (
        <TreemapBlock block={block} {...(actionRuntime === undefined ? {} : { actionRuntime })} />
      );
    case "heatmap":
      return <HeatmapBlock block={block} />;
    case "design":
      return <DesignBlock block={block} />;
    case "bar-list":
      return (
        <BarListBlock block={block} {...(actionRuntime === undefined ? {} : { actionRuntime })} />
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
    case "plan":
      return (
        <PlanBlock block={block} {...(planRuntime === undefined ? {} : { runtime: planRuntime })} />
      );
    default:
      return null;
  }
}
