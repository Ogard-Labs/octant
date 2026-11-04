import { describe, expect, it, vi } from "vitest";
import {
  createLocalPluginFolderPicker,
  LocalPluginFolderPickerError,
} from "./localPluginFolderPicker";

describe("createLocalPluginFolderPicker", () => {
  it("refuses an opaque skill receipt if its window dies while the actual reply body is decoded", async () => {
    let destroyed = false;
    const window = { isDestroyed: () => destroyed };
    const decoding = Promise.withResolvers<void>();
    let writer: ReadableStreamDefaultController<Uint8Array> | undefined;
    const reply = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          writer = controller;
        },
      }),
      { status: 201 },
    );
    const json = reply.json.bind(reply);
    reply.json = () => {
      decoding.resolve();
      return json();
    };
    const picker = createLocalPluginFolderPicker({
      desktopBridgeSecret: "fixture-secret",
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/skills"] }) },
      fetch: async () => reply,
      resolveOwnedWindow: () => window,
      serverUrl: "http://127.0.0.1:1",
      windowId: "44000000-0000-4000-8000-000000000001",
    });
    const pending = picker({ sender: {} }, "skill-folder");
    await decoding.promise;
    destroyed = true;
    writer?.enqueue(
      new TextEncoder().encode(JSON.stringify({ receiptId: "S".repeat(43), expiresAt: 1000 })),
    );
    writer?.close();
    await expect(pending).rejects.toBeInstanceOf(LocalPluginFolderPickerError);
  });
  it("mints only a skill-folder purpose receipt while returning no path to the renderer", async () => {
    const window = { isDestroyed: () => false };
    const fetch = vi.fn(async () =>
      Response.json({ receiptId: "S".repeat(43), expiresAt: 1000 }, { status: 201 }),
    );
    const picker = createLocalPluginFolderPicker({
      desktopBridgeSecret: "fixture-secret",
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/skills"] }) },
      fetch,
      resolveOwnedWindow: () => window,
      serverUrl: "http://127.0.0.1:1",
      windowId: "44000000-0000-4000-8000-000000000001",
    });
    const result = await picker({ sender: {} }, "skill-folder");
    expect(result).toMatchObject({
      kind: "selected",
      receiptId: "S".repeat(43),
      displayName: "skills",
    });
    expect(JSON.stringify(result)).not.toContain("/tmp/skills");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          windowId: "44000000-0000-4000-8000-000000000001",
          absolutePath: "/tmp/skills",
          purpose: "skill-folder",
        }),
      }),
    );
  });
  it("refuses a skill selection if its native window is destroyed while the picker is open", async () => {
    let destroyed = false;
    const window = { isDestroyed: () => destroyed };
    const selected = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>();
    const fetch = vi.fn();
    const picker = createLocalPluginFolderPicker({
      desktopBridgeSecret: "fixture-secret",
      dialog: { showOpenDialog: () => selected.promise },
      fetch,
      resolveOwnedWindow: () => window,
      serverUrl: "http://127.0.0.1:1",
      windowId: "44000000-0000-4000-8000-000000000001",
    });
    const pending = picker({ sender: {} }, "skill-folder");
    destroyed = true;
    selected.resolve({ canceled: false, filePaths: ["/tmp/skills"] });
    await expect(pending).rejects.toBeInstanceOf(LocalPluginFolderPickerError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("exchanges the selected directory for an opaque receipt", async () => {
    const window = { isDestroyed: () => false };
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
      resolveOwnedWindow: () => window,
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
