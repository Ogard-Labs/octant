import { describe, expect, it } from "vitest";
import { partitionDockTools } from "./dockToolStrip";

const tools = [{ id: "files" }, { id: "browser" }, { id: "terminal" }, { id: "canvas" }] as const;

describe("partitioning the dock tool strip", () => {
  it("keeps every tool visible when they all fit", () => {
    expect(partitionDockTools(tools, "browser", 4)).toEqual({
      visible: tools,
      overflow: [],
    });
  });

  it("keeps the active tool on the strip and overflows the rest in order", () => {
    expect(partitionDockTools(tools, "terminal", 2)).toEqual({
      visible: [{ id: "files" }, { id: "terminal" }],
      overflow: [{ id: "browser" }, { id: "canvas" }],
    });
  });

  it("still shows the active tool when the strip can hold only one", () => {
    expect(partitionDockTools(tools, "canvas", 0)).toEqual({
      visible: [{ id: "canvas" }],
      overflow: [{ id: "files" }, { id: "browser" }, { id: "terminal" }],
    });
  });
});
