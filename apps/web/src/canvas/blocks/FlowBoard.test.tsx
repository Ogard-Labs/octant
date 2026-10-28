import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  decodeCanvasBlock,
  type CanvasDefinition,
  type CanvasFlowBlock,
} from "@octant/contracts/canvas";
import { describe, expect, it, vi } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";
import { FlowBoard } from "./FlowBoard";
import type { DiagramBoardLayoutRuntime } from "./DiagramBoard";

const base = { schemaVersion: canvasFixture.schemaVersion };

const searchMockup = decodeCanvasBlock({
  ...base,
  blockId: "search",
  kind: "mockup",
  device: "phone",
  title: "Search",
  nodes: [
    { nodeId: "window", component: "window", label: "Search" },
    { nodeId: "go", parentId: "window", component: "button", label: "Go" },
  ],
});

const resultsMockup = decodeCanvasBlock({
  ...base,
  blockId: "results",
  kind: "mockup",
  device: "phone",
  title: "Results",
  nodes: [{ nodeId: "window", component: "window", label: "Results" }],
});

const decodedFlow = decodeCanvasBlock({
  ...base,
  blockId: "app-flow",
  kind: "flow",
  title: "Search flow",
  screens: [
    { screenId: "s1", blockId: "search" },
    { screenId: "s2", blockId: "results" },
  ],
  edges: [
    { edgeId: "run", fromScreenId: "s1", toScreenId: "s2", fromNodeId: "go", label: "Run search" },
  ],
});
if (decodedFlow.kind !== "flow") throw new Error("expected a flow block");
const flow: CanvasFlowBlock = decodedFlow;

function document(): CanvasDefinition {
  return { ...canvasFixture, blocks: [searchMockup, resultsMockup, flow] };
}

describe("flow board", () => {
  it("draws the screens it names and the transitions between them", () => {
    render(<CanvasDocument definition={document()} />);
    const section = screen.getByRole("group", { name: "Flow board" });
    expect(section).toHaveAttribute("data-editable", "false");
    const search = within(section).getByLabelText("Search screen");
    const results = within(section).getByLabelText("Results screen");
    expect(search).toBeInTheDocument();
    expect(results).toBeInTheDocument();
    // The outline names each screen and each transition with its hotspot.
    const outline = within(section).getByText("Outline");
    expect(outline).toBeInTheDocument();
    expect(within(section).getByText("Search → Results: Run search (via Go)")).toBeInTheDocument();
  });

  it("never draws a placed screen again at its own position", () => {
    render(<CanvasDocument definition={document()} />);
    // The document reads one flow, not a flow plus two loose mockup blocks.
    expect(screen.queryAllByRole("region", { name: /mockup/ })).toHaveLength(0);
    expect(screen.getAllByRole("group", { name: "Flow board" })).toHaveLength(1);
  });

  it("hands a finished drag to the host", async () => {
    const onRevise = vi.fn<DiagramBoardLayoutRuntime["onRevise"]>(() =>
      Promise.resolve({ kind: "accepted" as const }),
    );
    render(
      <FlowBoard
        block={flow}
        blocks={[searchMockup, resultsMockup]}
        layoutRuntime={{ onRevise }}
      />,
    );
    const search = screen.getByRole("button", { name: "Search screen" });
    fireEvent.pointerDown(search, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(search, { clientX: 140, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(search, { clientX: 140, clientY: 130, pointerId: 1 });
    await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(1));
    const call = onRevise.mock.calls[0];
    expect(String(call?.[0])).toBe("app-flow");
    expect(call?.[1]).toHaveLength(1);
    expect(String(call?.[1]?.[0]?.nodeId)).toBe("s1");
  });

  it("keeps a refused drag out of the document and says why", async () => {
    const onRevise = vi.fn<DiagramBoardLayoutRuntime["onRevise"]>(() =>
      Promise.resolve({
        kind: "denied" as const,
        message: "The board moved on; the drag landed on an older version.",
      }),
    );
    render(
      <FlowBoard
        block={flow}
        blocks={[searchMockup, resultsMockup]}
        layoutRuntime={{ onRevise }}
      />,
    );
    const search = screen.getByRole("button", { name: "Search screen" });
    fireEvent.pointerDown(search, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(search, { clientX: 140, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(search, { clientX: 140, clientY: 130, pointerId: 1 });
    expect(
      await screen.findByText("The board moved on; the drag landed on an older version."),
    ).toBeInTheDocument();
  });

  it("offers a keyboard path for a screen the person can drag", async () => {
    const onRevise = vi.fn<DiagramBoardLayoutRuntime["onRevise"]>(() =>
      Promise.resolve({ kind: "accepted" as const }),
    );
    const user = userEvent.setup();
    render(
      <FlowBoard
        block={flow}
        blocks={[searchMockup, resultsMockup]}
        layoutRuntime={{ onRevise }}
      />,
    );
    screen.getByRole("button", { name: "Search screen" }).focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(1));
    const call = onRevise.mock.calls[0];
    expect(call?.[1]?.[0]?.x).toBe(10);
    expect(call?.[1]?.[0]?.y).toBe(0);
  });
});
