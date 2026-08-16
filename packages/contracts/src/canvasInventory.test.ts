import { describe, expect, it } from "vitest";
import {
  decodeCanvasGetOutcome,
  decodeCanvasInventoryEntry,
  decodeCanvasInventoryList,
  decodeWorkspaceTab,
} from "@octant/contracts";

const ids = {
  tab: "01000000-0000-4000-8000-000000000001",
  canvas: "11111111-1111-4111-8111-111111111111",
  project: "77777777-7777-4777-8777-777777777777",
  version: "22222222-2222-4222-8222-222222222222",
} as const;

describe("canvas inventory contracts", () => {
  it("decodes inventory entries without definition bodies", () => {
    const entry = decodeCanvasInventoryEntry({
      canvasId: ids.canvas,
      projectId: ids.project,
      mode: "chat",
      title: "Quarterly summary",
      versionCount: 2,
      currentVersionId: ids.version,
      currentSequence: 2,
      updatedAt: "2026-08-01T21:00:00.000Z",
    });
    expect(entry.title).toBe("Quarterly summary");
    expect(entry.versionCount).toBe(2);
  });

  it("decodes inventory list replies", () => {
    const list = decodeCanvasInventoryList({
      projectId: ids.project,
      entries: [
        {
          canvasId: ids.canvas,
          projectId: ids.project,
          mode: "work",
          title: "Runbook",
          versionCount: 1,
          currentVersionId: ids.version,
          currentSequence: 1,
          updatedAt: "2026-08-01T21:00:00.000Z",
        },
      ],
    });
    expect(list.entries.length).toBe(1);
  });

  it("decodes ready and unavailable get outcomes", () => {
    expect(
      decodeCanvasGetOutcome({
        kind: "unavailable",
        canvasId: ids.canvas,
        reason: "Canvas is unavailable.",
      }).kind,
    ).toBe("unavailable");
    expect(decodeCanvasGetOutcome({ kind: "unauthorized", canvasId: ids.canvas }).kind).toBe(
      "unauthorized",
    );
  });
});

describe("canvas workspace tab", () => {
  it("decodes a canvas tab carrying opaque identity only", () => {
    const tab = decodeWorkspaceTab({
      kind: "canvas",
      id: ids.tab,
      mode: "code",
      title: "Architecture board",
      canvasId: ids.canvas,
      projectId: ids.project,
    });
    expect(tab.kind).toBe("canvas");
    if (tab.kind !== "canvas") throw new Error("unreachable");
    expect(tab.canvasId).toBe(ids.canvas);
    expect(tab.projectId).toBe(ids.project);
  });
});
