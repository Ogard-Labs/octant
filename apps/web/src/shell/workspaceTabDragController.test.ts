import { describe, expect, it, vi } from "vitest";
import { WorkspaceTabDragController } from "./workspaceTabDragController";
import type { WorkspaceTabDropDestination } from "./workspaceTabDragGeometry";

const groupId = "00000000-0000-4000-8000-000000001201" as never;
const tabId = "00000000-0000-4000-8000-000000001202" as never;
const destination: WorkspaceTabDropDestination = {
  kind: "reorder",
  sourceGroupId: groupId,
  targetGroupId: groupId,
  tabId,
  index: 1,
};

describe("WorkspaceTabDragController", () => {
  it("keeps an ordinary pointer gesture pending until it crosses the threshold", () => {
    const onDrop = vi.fn();
    const controller = new WorkspaceTabDragController({
      onDrop,
      resolveDestination: () => destination,
    });

    controller.start(7, { groupId, index: 0, tabId, title: "Conversation" }, { x: 10, y: 10 });
    controller.move(7, { x: 14, y: 13 });
    expect(controller.getSnapshot().phase).toBe("pending");

    controller.drop(7);
    expect(onDrop).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({ phase: "idle" });
  });

  it("commits one resolved destination after a valid drag", () => {
    const onDrop = vi.fn();
    const controller = new WorkspaceTabDragController({
      onDrop,
      resolveDestination: () => destination,
    });

    controller.start(7, { groupId, index: 0, tabId, title: "Conversation" }, { x: 10, y: 10 });
    controller.move(7, { x: 16, y: 10 });
    expect(controller.getSnapshot()).toMatchObject({ phase: "dragging", destination });
    controller.drop(7);

    expect(onDrop).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledWith(destination);
    expect(controller.consumeClickSuppression(tabId)).toBe(true);
    expect(controller.consumeClickSuppression(tabId)).toBe(false);
  });

  it("cancels without committing on Escape-equivalent cancellation or a foreign pointer", () => {
    const onDrop = vi.fn();
    const controller = new WorkspaceTabDragController({
      onDrop,
      resolveDestination: () => destination,
    });

    controller.start(7, { groupId, index: 0, tabId, title: "Conversation" }, { x: 10, y: 10 });
    controller.move(8, { x: 30, y: 10 });
    expect(controller.getSnapshot().phase).toBe("pending");
    controller.move(7, { x: 30, y: 10 });
    controller.cancel();

    expect(controller.getSnapshot()).toEqual({ phase: "idle" });
    expect(onDrop).not.toHaveBeenCalled();
    expect(controller.consumeClickSuppression(tabId)).toBe(true);
  });
});
