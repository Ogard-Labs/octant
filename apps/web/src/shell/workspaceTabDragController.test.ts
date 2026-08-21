import { decodePaneId, decodeWorkspaceTabId, type WorkspaceTab } from "@octant/contracts/shell";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSurfaceDragController } from "./workspaceTabDragController";
import type {
  WorkspaceSurfaceDragSource,
  WorkspaceSurfaceDropDestination,
} from "./workspaceTabDragGeometry";

const paneId = decodePaneId("00000000-0000-4000-8000-000000001201");
const targetPaneId = decodePaneId("00000000-0000-4000-8000-000000001202");
const surface: WorkspaceTab = {
  kind: "welcome",
  id: decodeWorkspaceTabId("00000000-0000-4000-8000-000000001203"),
  mode: "chat",
  title: "Conversation",
};
const source: WorkspaceSurfaceDragSource = {
  dragKey: `pane:${String(paneId)}`,
  paneId,
  surface,
  title: surface.title,
};
const destination: WorkspaceSurfaceDropDestination = { kind: "center", targetPaneId };

describe("WorkspaceSurfaceDragController", () => {
  it("keeps an ordinary pointer gesture pending until it crosses the threshold", () => {
    const onDrop = vi.fn();
    const controller = new WorkspaceSurfaceDragController({
      onDrop,
      resolveDestination: () => destination,
    });

    controller.start(7, source, { x: 10, y: 10 });
    controller.move(7, { x: 14, y: 13 });
    expect(controller.getSnapshot().phase).toBe("pending");

    controller.drop(7);
    expect(onDrop).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({ phase: "idle" });
  });

  it("commits one resolved destination after a valid drag", () => {
    const onDrop = vi.fn();
    const controller = new WorkspaceSurfaceDragController({
      onDrop,
      resolveDestination: () => destination,
    });

    controller.start(7, source, { x: 10, y: 10 });
    controller.move(7, { x: 16, y: 10 });
    expect(controller.getSnapshot()).toMatchObject({ phase: "dragging", destination });
    controller.drop(7);

    expect(onDrop).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledWith(source, destination);
    expect(controller.consumeClickSuppression(source.dragKey)).toBe(true);
    expect(controller.consumeClickSuppression(source.dragKey)).toBe(false);
  });

  it("cancels without committing on Escape-equivalent cancellation or a foreign pointer", () => {
    const onDrop = vi.fn();
    const controller = new WorkspaceSurfaceDragController({
      onDrop,
      resolveDestination: () => destination,
    });

    controller.start(7, source, { x: 10, y: 10 });
    controller.move(8, { x: 30, y: 10 });
    expect(controller.getSnapshot().phase).toBe("pending");
    controller.move(7, { x: 30, y: 10 });
    controller.cancel();

    expect(controller.getSnapshot()).toEqual({ phase: "idle" });
    expect(onDrop).not.toHaveBeenCalled();
    expect(controller.consumeClickSuppression(source.dragKey)).toBe(true);
  });
});
