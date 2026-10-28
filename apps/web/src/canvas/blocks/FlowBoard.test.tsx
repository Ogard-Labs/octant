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
import { FlowBoard, flowDesignHotspotTarget } from "./FlowBoard";
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

  it("gives a phone design screen its portrait shape instead of a landscape box", () => {
    const phoneDesign = decodeCanvasBlock({
      ...base,
      blockId: "phone-site",
      kind: "design",
      title: "Phone site",
      size: "phone",
      frames: [{ frameId: "home", title: "Home", html: "<h1>Home</h1>" }],
    });
    const decoded = decodeCanvasBlock({
      ...base,
      blockId: "phone-flow",
      kind: "flow",
      title: "Phone flow",
      screens: [{ screenId: "home", blockId: "phone-site", frameId: "home" }],
      edges: [],
    });
    if (decoded.kind !== "flow") throw new Error("expected a flow block");
    const { container } = render(<FlowBoard block={decoded} blocks={[phoneDesign]} />);
    const wrapper = container.querySelector<HTMLElement>(".canvas-flow-board__design-frame");
    const [width, height] = (wrapper?.style.aspectRatio ?? "")
      .split("/")
      .map((part) => Number(part.trim()));
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(width ?? 0);
  });
});

describe("flow click-through Play", () => {
  it("opens on the first screen and navigates by a tapped hotspot, then goes Back", async () => {
    const user = userEvent.setup();
    render(<FlowBoard block={flow} blocks={[searchMockup, resultsMockup]} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    const player = screen.getByRole("dialog", { name: "Playing Search flow" });
    expect(within(player).getByRole("tree", { name: "Search" })).toBeInTheDocument();
    // The hotspot the edge named is the one live control in the drawing.
    const go = await within(player).findByRole("button", { name: "Go" });
    await user.click(go);
    expect(within(player).getByRole("tree", { name: "Results" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(within(player).getByRole("tree", { name: "Search" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reaches a hotspot with the keyboard and lists a screen-level transition as Go to", async () => {
    const screenLevelFlow = {
      ...flow,
      edges: [{ edgeId: "open", fromScreenId: "s1", toScreenId: "s2", label: "Open results" }],
    } as never;
    const user = userEvent.setup();
    render(<FlowBoard block={screenLevelFlow} blocks={[searchMockup, resultsMockup]} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    const player = screen.getByRole("dialog", { name: "Playing Search flow" });
    // A transition without a hotspot waits in the Go to list.
    const open = within(player).getByRole("button", { name: "Open results →" });
    open.focus();
    await user.keyboard("{Enter}");
    expect(within(player).getByRole("tree", { name: "Results" })).toBeInTheDocument();
  });

  it("keeps every control inert outside Play", () => {
    render(<FlowBoard block={flow} blocks={[searchMockup, resultsMockup]} />);
    const board = screen.getByRole("group", { name: "Flow board" });
    // The board's screens hold no live hotspot; only Play itself is a button.
    expect(within(board).queryAllByRole("button", { name: "Go" })).toHaveLength(0);
  });
});

describe("design hotspots in a flow", () => {
  it("reads the screen a design frame's own anchor names", () => {
    expect(flowDesignHotspotTarget("#octant-flow:results")).toBe("results");
    expect(flowDesignHotspotTarget("#octant-flow:two-words.v2")).toBe("two-words.v2");
    expect(flowDesignHotspotTarget("#other")).toBeUndefined();
    expect(flowDesignHotspotTarget("")).toBeUndefined();
  });

  it("draws a played design screen same-origin so its anchors can be followed", async () => {
    const design = decodeCanvasBlock({
      ...base,
      blockId: "site",
      kind: "design",
      title: "Site",
      size: "phone",
      frames: [
        { frameId: "home", title: "Home", html: '<a id="go" href="#octant-flow:s2">Go</a>' },
      ],
    });
    const designFlow = decodeCanvasBlock({
      ...base,
      blockId: "app-flow",
      kind: "flow",
      title: "Site flow",
      screens: [
        { screenId: "s1", blockId: "site", frameId: "home" },
        { screenId: "s2", blockId: "results" },
      ],
      edges: [{ edgeId: "go", fromScreenId: "s1", toScreenId: "s2", fromNodeId: "go" }],
    });
    if (designFlow.kind !== "flow") throw new Error("expected a flow");
    const user = userEvent.setup();
    render(<FlowBoard block={designFlow} blocks={[design, resultsMockup]} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    const player = screen.getByRole("dialog", { name: "Playing Site flow" });
    // The player's frame is the same-origin one; the board's thumbnail behind
    // it stays unsandboxed-origin, as the document drawing always is.
    const frame = within(player).getByTitle("Home, design screen");
    expect(frame).toHaveAttribute("sandbox", "allow-same-origin");
  });
});

describe("flow callouts", () => {
  it("numbers a callout on its screen and lists the note with the screen's label", () => {
    const annotatedFlow = decodeCanvasBlock({
      ...base,
      blockId: "app-flow",
      kind: "flow",
      title: "Search flow",
      screens: [
        { screenId: "s1", blockId: "search" },
        { screenId: "s2", blockId: "results" },
      ],
      edges: [],
      annotations: [{ nodeId: "s1", note: "Start here; the field is sticky." }],
    });
    if (annotatedFlow.kind !== "flow") throw new Error("expected a flow");
    render(<FlowBoard block={annotatedFlow} blocks={[searchMockup, resultsMockup]} />);
    const board = screen.getByRole("group", { name: "Flow board" });
    // The badge draws on the screen's node: exactly one, beside the note's list.
    expect(screen.getAllByText("1")).toHaveLength(2);
    // The note lists under the board, numbered, with the screen's label.
    const notes = within(board).getByLabelText("Callouts on Search flow");
    expect(within(notes).getByText(/Start here/)).toBeInTheDocument();
    expect(within(notes).getByText("Search")).toBeInTheDocument();
  });
});
