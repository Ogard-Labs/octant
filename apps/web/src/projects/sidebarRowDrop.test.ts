import { describe, expect, it } from "vitest";
import { resolveSidebarRowDropZone, sidebarRowDropAction } from "./sidebarRowDropRules";

const rect = (top: number, height: number) => ({ left: 0, top, width: 240, height });

describe("a thread row dropped within the sidebar", () => {
  it("pins a Code thread dropped on Pinned and unpins one dragged out", () => {
    expect(sidebarRowDropAction({ row: {}, zone: "pinned", canPin: true })).toBe("pin");
    expect(
      sidebarRowDropAction({
        row: { pinned: true, fromPinned: true },
        zone: "list",
        canPin: true,
      }),
    ).toBe("unpin");
    // A row already pinned asks nothing of Pinned, and Chat and Work have no pin.
    expect(sidebarRowDropAction({ row: { pinned: true }, zone: "pinned", canPin: true })).toBe(
      null,
    );
    expect(sidebarRowDropAction({ row: {}, zone: "pinned", canPin: false })).toBe(null);
    // A pinned row dragged from the Project tree was never in the Pinned group.
    expect(sidebarRowDropAction({ row: { pinned: true }, zone: "list", canPin: true })).toBe(null);
  });

  it("settles a thread dropped on the Settled shelf and un-settles one dragged out", () => {
    expect(sidebarRowDropAction({ row: {}, zone: "completed", canPin: false })).toBe("settle");
    expect(sidebarRowDropAction({ row: { shelf: "completed" }, zone: "list", canPin: false })).toBe(
      "reopen",
    );
    expect(
      sidebarRowDropAction({ row: { shelf: "completed" }, zone: "completed", canPin: false }),
    ).toBe(null);
  });

  it("wakes a snoozed thread dragged out of Snoozed and never snoozes by a drop", () => {
    expect(sidebarRowDropAction({ row: { shelf: "snoozed" }, zone: "list", canPin: false })).toBe(
      "wake",
    );
    expect(sidebarRowDropAction({ row: {}, zone: "snoozed", canPin: false })).toBe(null);
  });

  it("takes the shelf under the pointer over the list around it", () => {
    const zones = [
      { zone: "list" as const, rect: rect(0, 600) },
      { zone: "completed" as const, rect: rect(500, 80) },
    ];
    expect(resolveSidebarRowDropZone({ x: 20, y: 520 }, zones)).toBe("completed");
    expect(resolveSidebarRowDropZone({ x: 20, y: 100 }, zones)).toBe("list");
    expect(resolveSidebarRowDropZone({ x: 400, y: 100 }, zones)).toBe(null);
  });
});
