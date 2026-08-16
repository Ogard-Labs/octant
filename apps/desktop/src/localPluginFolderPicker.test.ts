import { describe, expect, it, vi } from "vitest";
import {
  createLocalPluginFolderPicker,
  LocalPluginFolderPickerError,
} from "./localPluginFolderPicker";

describe("createLocalPluginFolderPicker", () => {
  it("exchanges the selected directory for an opaque receipt", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ receiptId: "A".repeat(43), expiresAt: 1_000 }, { status: 201 }),
      );
    const picker = createLocalPluginFolderPicker({
      desktopBridgeSecret: "desktop-secret",
      dialog: {
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: ["/Users/demo/my-plugin"],
        }),
      },
      fetch,
      resolveOwnedWindow: () => ({ isDestroyed: () => false }),
      serverUrl: "http://127.0.0.1:13773",
      windowId: "44000000-0000-4000-8000-000000000001",
    });
    const result = await picker({ sender: {} });
    expect(result).toEqual({
      kind: "selected",
      receiptId: "A".repeat(43),
      displayName: "my-plugin",
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:13773/api/extensions/import-local-receipts",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-desktop-secret": "desktop-secret" }),
        body: JSON.stringify({
          windowId: "44000000-0000-4000-8000-000000000001",
          absolutePath: "/Users/demo/my-plugin",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("/Users/demo/my-plugin");
  });

  it("returns cancelled when the dialog is dismissed", async () => {
    const picker = createLocalPluginFolderPicker({
      desktopBridgeSecret: "desktop-secret",
      dialog: {
        showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
      },
      resolveOwnedWindow: () => ({ isDestroyed: () => false }),
      serverUrl: "http://127.0.0.1:13773",
      windowId: "44000000-0000-4000-8000-000000000001",
    });
    await expect(picker({ sender: {} })).resolves.toEqual({ kind: "cancelled" });
  });

  it("rejects unauthorized or destroyed windows", async () => {
    const missing = createLocalPluginFolderPicker({
      desktopBridgeSecret: "desktop-secret",
      dialog: { showOpenDialog: vi.fn() },
      resolveOwnedWindow: () => undefined,
      serverUrl: "http://127.0.0.1:13773",
      windowId: "44000000-0000-4000-8000-000000000001",
    });
    await expect(missing({ sender: {} })).rejects.toBeInstanceOf(LocalPluginFolderPickerError);

    const destroyed = createLocalPluginFolderPicker({
      desktopBridgeSecret: "desktop-secret",
      dialog: { showOpenDialog: vi.fn() },
      resolveOwnedWindow: () => ({ isDestroyed: () => true }),
      serverUrl: "http://127.0.0.1:13773",
      windowId: "44000000-0000-4000-8000-000000000001",
    });
    await expect(destroyed({ sender: {} })).rejects.toBeInstanceOf(LocalPluginFolderPickerError);
  });
});
