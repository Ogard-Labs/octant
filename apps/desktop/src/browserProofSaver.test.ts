import { describe, expect, it, vi } from "vitest";
import { BrowserProofSaverError, createBrowserProofSaver } from "./browserProofSaver";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function saver(overrides: Record<string, unknown> = {}) {
  const write = vi.fn(async (_path: string, _bytes: Uint8Array) => undefined);
  const showOpenDialog = vi
    .fn()
    .mockResolvedValue({ canceled: false, filePaths: ["/Users/demo/Pictures/pr-12"] });
  const save = createBrowserProofSaver({
    dialog: { showOpenDialog },
    defaultDirectory: "/Users/demo/Downloads",
    resolveOwnedWindow: () => ({ isDestroyed: () => false }),
    exists: async () => false,
    write,
    ...overrides,
  });
  return { save, write, showOpenDialog };
}

describe("createBrowserProofSaver", () => {
  it("writes numbered files into the folder the person picked and answers no path", async () => {
    const { save, write, showOpenDialog } = saver();
    const result = await save({ sender: {} }, [
      { fileNumber: 1, dataUrl: PNG },
      { fileNumber: 2, dataUrl: "data:image/jpeg;base64,/9j/4AAQ" },
    ]);
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        defaultPath: "/Users/demo/Downloads",
        properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
      }),
    );
    expect(write.mock.calls.map(([path]) => path)).toEqual([
      "/Users/demo/Pictures/pr-12/browser-check-01.png",
      "/Users/demo/Pictures/pr-12/browser-check-02.jpg",
    ]);
    expect(result).toEqual({ kind: "saved", count: 2, folderName: "pr-12" });
    expect(JSON.stringify(result)).not.toContain("/Users/demo");
  });

  it("writes nothing when the person cancels the picker", async () => {
    const { save, write } = saver({
      dialog: { showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }) },
    });
    await expect(save({ sender: {} }, [{ fileNumber: 1, dataUrl: PNG }])).resolves.toEqual({
      kind: "cancelled",
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("never overwrites: a name already in the folder stops the whole save", async () => {
    const { save, write } = saver({
      exists: async (path: string) => path.endsWith("browser-check-02.png"),
    });
    await expect(
      save({ sender: {} }, [
        { fileNumber: 1, dataUrl: PNG },
        { fileNumber: 2, dataUrl: PNG },
      ]),
    ).rejects.toThrow(/browser-check-02\.png is already in that folder/);
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a window it does not own before it opens a dialog", async () => {
    const { save, showOpenDialog } = saver({ resolveOwnedWindow: () => undefined });
    await expect(save({ sender: {} }, [{ fileNumber: 1, dataUrl: PNG }])).rejects.toBeInstanceOf(
      BrowserProofSaverError,
    );
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it("refuses a request that names a path, a non-image, or a number out of range", async () => {
    const { save, showOpenDialog } = saver();
    for (const bad of [
      [],
      "not a list",
      [{ fileNumber: 1, dataUrl: PNG, path: "/etc/passwd" }],
      [{ fileNumber: 1, dataUrl: "data:text/html;base64,AAAA" }],
      [{ fileNumber: 0, dataUrl: PNG }],
      [{ fileNumber: 100, dataUrl: PNG }],
      [
        { fileNumber: 1, dataUrl: PNG },
        { fileNumber: 1, dataUrl: PNG },
      ],
      Array.from({ length: 33 }, (_, index) => ({ fileNumber: index + 1, dataUrl: PNG })),
    ]) {
      await expect(save({ sender: {} }, bad)).rejects.toBeInstanceOf(BrowserProofSaverError);
    }
    expect(showOpenDialog).not.toHaveBeenCalled();
  });
});
