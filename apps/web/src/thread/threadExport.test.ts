import { THREAD_EXPORT_FORMAT, type ThreadExportOutcome } from "@octant/contracts/thread-export";
import { describe, expect, it, vi } from "vitest";
import { exportThreadBundle, resolveThreadExportClient } from "./threadExport";

const threadId = "00000000-0000-4000-8000-000000000901";

function exported(): ThreadExportOutcome {
  return {
    kind: "exported",
    bundle: {
      octant: {
        format: THREAD_EXPORT_FORMAT,
        threadId,
        mode: "chat",
        title: "Launch plan",
        hostId: "local" as never,
        version: 1,
        sequence: 1,
        generatedAt: "2026-08-19T12:00:00.000Z" as never,
      },
      transcript: { entries: [], activeCount: 0, revisedCount: 0 },
      evidence: { artifacts: [], attachments: [], citations: [] },
      provenance: {
        mode: "chat",
        threadId,
        hostId: "local" as never,
        providerInstanceId: "10000000-0000-4000-8000-000000000001" as never,
        modelId: "model-a" as never,
        createdAt: "2026-08-19T12:00:00.000Z" as never,
        updatedAt: "2026-08-19T12:00:00.000Z" as never,
      },
      omissions: [],
    },
  };
}

describe("exporting a thread", () => {
  it("asks the host for the cut and downloads it", async () => {
    const exportThread = vi.fn(async () => exported());
    const createObjectURL = vi.fn(() => "blob:thread-export");
    const originalCreateObjectURL = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const message = await exportThreadBundle(
        { exportThread },
        { mode: "chat", threadId, title: "Launch plan" },
      );

      expect(exportThread).toHaveBeenCalledWith({ mode: "chat", threadId });
      expect(message).toBe("Saved launch-plan.octant-thread.json.");
      expect(click).toHaveBeenCalled();
    } finally {
      click.mockRestore();
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
    }
  });

  it("says so when the host refuses", async () => {
    const exportThread = vi.fn(async () => ({
      kind: "refused" as const,
      reason: "not-found" as const,
    }));
    await expect(
      exportThreadBundle({ exportThread }, { mode: "work", threadId, title: "Brief" }),
    ).resolves.toBe("This thread could not be exported.");
  });

  it("resolves no export client for a window with no server capability", () => {
    expect(resolveThreadExportClient({ serverUrl: "http://127.0.0.1:1" })).toBeUndefined();
    expect(resolveThreadExportClient({})).toBeUndefined();
  });
});
