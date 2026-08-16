import { decodeCanvasId, decodeProjectId, type CanvasInventoryEntry } from "@octant/contracts";

export const canvasInventoryProjectId = decodeProjectId("77777777-7777-4777-8777-777777777777");
export const quarterlyCanvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
export const roadmapCanvasId = decodeCanvasId("22222222-2222-4222-8222-222222222222");

export const quarterlyInventoryEntry: CanvasInventoryEntry = {
  canvasId: quarterlyCanvasId,
  projectId: canvasInventoryProjectId,
  mode: "chat",
  title: "Quarterly summary",
  versionCount: 2,
  currentVersionId: "33333333-3333-4333-8333-333333333333" as never,
  currentSequence: 2,
  updatedAt: "2026-08-01T21:00:00.000Z" as never,
};

export const roadmapInventoryEntry: CanvasInventoryEntry = {
  canvasId: roadmapCanvasId,
  projectId: canvasInventoryProjectId,
  mode: "chat",
  title: "Product roadmap",
  versionCount: 1,
  currentVersionId: "44444444-4444-4444-8444-444444444444" as never,
  currentSequence: 1,
  updatedAt: "2026-08-02T10:00:00.000Z" as never,
};

export const canvasInventoryEntries = [quarterlyInventoryEntry, roadmapInventoryEntry] as const;
