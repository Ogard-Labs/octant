import type { CanvasDefinition } from "@octant/contracts/canvas";

/** What a reader would call a block, for a marker's accessible name. */
export function canvasBlockLabel(block: CanvasDefinition["blocks"][number]): string {
  switch (block.kind) {
    case "heading":
      return block.text;
    case "diagram":
      return "Board";
    case "sequence":
      return "Sequence";
    case "state":
      return "State machine";
    case "er":
      return "Entity relationship";
    case "swimlane":
      return "Swimlane";
    case "mindmap":
      return "Mind map";
    case "comparison-matrix":
      return "Comparison matrix";
    case "math":
      return block.layout === "display" ? (block.caption ?? "Formula") : "Math";
    case "mockup":
    case "design":
      return block.title;
    case "plan":
    case "dashboard":
      return block.title;
    case "callout":
      return block.title ?? "Callout";
    case "tabs":
      return "Tabs";
    case "columns":
      return "Columns";
    default:
      return block.kind.replace("-", " ");
  }
}
