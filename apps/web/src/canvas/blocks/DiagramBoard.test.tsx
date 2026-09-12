import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeCanvasBlock, type CanvasDiagramBlock } from "@octant/contracts/canvas";
import { DiagramBoard, type DiagramBoardLayoutRuntime } from "./DiagramBoard";

function diagram(): CanvasDiagramBlock {
  const block = decodeCanvasBlock({
    schemaVersion: 1,
    blockId: "board-1",
    kind: "diagram",
    nodes: [
      { nodeId: "api", label: "API" },
      { nodeId: "db", label: "Database" },
    ],
    edges: [{ edgeId: "api-db", source: "api", target: "db", label: "reads" }],
  });
  if (block.kind !== "diagram") throw new Error("fixture is not a diagram");
  return block;
}

function nodeElement(label: string): SVGGElement {
  const node = screen.getByLabelText(label);
  if (!(node instanceof SVGGElement)) throw new Error(`${label} is not a board node`);
  return node;
}

function nodeRect(label: string): { readonly x: number; readonly y: number } {
  const rect = nodeElement(label).querySelector("rect");
  return { x: Number(rect?.getAttribute("x")), y: Number(rect?.getAttribute("y")) };
}

describe("DiagramBoard", () => {
  it("zooms in, out, and fits from the controls and the keyboard", async () => {
    const user = userEvent.setup();
    render(<DiagramBoard block={diagram()} />);
    const svg = document.querySelector("svg");
    const initial = svg?.getAttribute("viewBox");

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("120%")).toBeInTheDocument();
    expect(svg?.getAttribute("viewBox")).not.toBe(initial);

    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByText("100%")).toBeInTheDocument();

    screen.getByRole("group", { name: "Board" }).focus();
    await user.keyboard("+");
    expect(screen.getByText("120%")).toBeInTheDocument();
    await user.keyboard("0");
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(svg?.getAttribute("viewBox")).toBe(initial);
  });

  it("keeps a board read-only when the host offers no layout runtime", () => {
    render(<DiagramBoard block={diagram()} />);
    expect(screen.queryByRole("button", { name: "Database" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Board" })).toHaveAttribute("data-editable", "false");
  });

  it("journals a dragged node's new position through the host and keeps it there", async () => {
    const onRevise = vi.fn(async () => ({ kind: "accepted" as const }));
    const runtime: DiagramBoardLayoutRuntime = { onRevise };
    render(<DiagramBoard block={diagram()} layoutRuntime={runtime} />);
    const before = nodeRect("Database");
    const node = nodeElement("Database");

    fireEvent.pointerDown(node, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(node, { clientX: 140, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(node, { clientX: 140, clientY: 130, pointerId: 1 });

    await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(1));
    expect(onRevise).toHaveBeenCalledWith("board-1", [
      { nodeId: "db", x: before.x + 40, y: before.y + 30 },
    ]);
    expect(nodeRect("Database")).toEqual({ x: before.x + 40, y: before.y + 30 });
  });

  it("nudges a focused node with the arrow keys and journals each step", async () => {
    const user = userEvent.setup();
    const onRevise = vi.fn(async () => ({ kind: "accepted" as const }));
    render(<DiagramBoard block={diagram()} layoutRuntime={{ onRevise }} />);
    const before = nodeRect("API");

    screen.getByRole("button", { name: "API" }).focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(1));
    expect(onRevise).toHaveBeenLastCalledWith("board-1", [
      { nodeId: "api", x: before.x + 10, y: before.y },
    ]);
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(2));
    expect(onRevise).toHaveBeenLastCalledWith("board-1", [
      { nodeId: "api", x: before.x + 10, y: before.y + 50 },
    ]);
  });

  it("puts a node back and says why when the host refuses the move", async () => {
    const user = userEvent.setup();
    const onRevise = vi.fn(async () => ({
      kind: "denied" as const,
      message: "The board changed on the host and was reloaded.",
    }));
    render(<DiagramBoard block={diagram()} layoutRuntime={{ onRevise }} />);
    const before = nodeRect("API");

    screen.getByRole("button", { name: "API" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed on the host/);
    expect(nodeRect("API")).toEqual(before);
  });
});
