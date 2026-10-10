import { describe, expect, it, vi } from "vitest";
import { createRuntimeBinaryPicker, RuntimeBinaryPickerError } from "./runtimeBinaryPicker";

const windowId = "44000000-0000-4000-8000-000000000001";

describe("createRuntimeBinaryPicker", () => {
  it("trades the chosen executable for a receipt and never hands the renderer its path", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ receiptId: "B".repeat(43), expiresAt: 1_000 }, { status: 201 }),
      );
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ["/Users/demo/tools/codex"],
    });
    const picker = createRuntimeBinaryPicker({
      desktopBridgeSecret: "desktop-secret",
      dialog: { showOpenDialog },
      fetch,
      resolveOwnedWindow: () => ({ isDestroyed: () => false }),
      serverUrl: "http://127.0.0.1:13773",
      windowId,
    });

    const result = await picker({ sender: {} });

    expect(result).toEqual({ kind: "selected", receiptId: "B".repeat(43), displayName: "codex" });
    expect(JSON.stringify(result)).not.toContain("/Users/demo/tools");
    expect(showOpenDialog.mock.calls[0]?.[1]).toEqual({
      properties: ["openFile", "dontAddToRecent"],
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:13773/api/providers/discovery/binary-receipts",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-desktop-secret": "desktop-secret" }),
        body: JSON.stringify({ windowId, absolutePath: "/Users/demo/tools/codex" }),
      }),
    );
  });

  it("asks the host for nothing when the picker is dismissed or the window is not its own", async () => {
    const fetch = vi.fn();
    const dismissed = createRuntimeBinaryPicker({
      desktopBridgeSecret: "desktop-secret",
      dialog: { showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }) },
      fetch,
      resolveOwnedWindow: () => ({ isDestroyed: () => false }),
      serverUrl: "http://127.0.0.1:13773",
      windowId,
    });
    await expect(dismissed({ sender: {} })).resolves.toEqual({ kind: "cancelled" });

    const foreign = createRuntimeBinaryPicker({
      desktopBridgeSecret: "desktop-secret",
      dialog: { showOpenDialog: vi.fn() },
      fetch,
      resolveOwnedWindow: () => undefined,
      serverUrl: "http://127.0.0.1:13773",
      windowId,
    });
    await expect(foreign({ sender: {} })).rejects.toBeInstanceOf(RuntimeBinaryPickerError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
