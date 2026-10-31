import { describe, expect, it, vi } from "vitest";
import {
  createSupportBundleSaver,
  defaultSupportBundleFileName,
  SupportBundleSaverError,
} from "./supportBundleSaver";

const options = (overrides: Record<string, unknown> = {}) => ({
  desktopBridgeSecret: "desktop-secret",
  defaultDirectory: "/Users/demo/Downloads",
  now: () => new Date("2026-10-31T10:00:00.000Z"),
  resolveOwnedWindow: () => ({ isDestroyed: () => false }),
  serverUrl: "http://127.0.0.1:13773",
  ...overrides,
});

describe("createSupportBundleSaver", () => {
  it("offers a dated zip name in Downloads and asks the host to write the chosen path", async () => {
    const showSaveDialog = vi
      .fn()
      .mockResolvedValue({ canceled: false, filePath: "/Users/demo/Desktop/for-support.zip" });
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ kind: "saved", fileName: "for-support.zip" }));
    const save = createSupportBundleSaver({
      ...options(),
      dialog: { showSaveDialog },
      fetch,
    });

    const result = await save({ sender: {} });

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        defaultPath: "/Users/demo/Downloads/octant-diagnostics-20261031.zip",
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:13773/api/diagnostics/bundle/save",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-desktop-secret": "desktop-secret" }),
        body: JSON.stringify({ absolutePath: "/Users/demo/Desktop/for-support.zip" }),
      }),
    );
    expect(result).toEqual({ kind: "saved", fileName: "for-support.zip" });
    expect(JSON.stringify(result)).not.toContain("/Users/demo");
  });

  it("adds .zip to a name typed without it", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ kind: "saved" }));
    const save = createSupportBundleSaver({
      ...options(),
      dialog: {
        showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: "/tmp/bundle" }),
      },
      fetch,
    });
    await expect(save({ sender: {} })).resolves.toEqual({ kind: "saved", fileName: "bundle.zip" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      absolutePath: "/tmp/bundle.zip",
    });
  });

  it("writes nothing when the dialog is dismissed", async () => {
    const fetch = vi.fn();
    const save = createSupportBundleSaver({
      ...options(),
      dialog: { showSaveDialog: vi.fn().mockResolvedValue({ canceled: true, filePath: "" }) },
      fetch,
    });
    await expect(save({ sender: {} })).resolves.toEqual({ kind: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized or destroyed window before opening a dialog", async () => {
    const showSaveDialog = vi.fn();
    for (const resolveOwnedWindow of [() => undefined, () => ({ isDestroyed: () => true })]) {
      const save = createSupportBundleSaver({
        ...options({ resolveOwnedWindow }),
        dialog: { showSaveDialog },
      });
      await expect(save({ sender: {} })).rejects.toBeInstanceOf(SupportBundleSaverError);
    }
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it("passes the host's own sentence on when it could not write there", async () => {
    const save = createSupportBundleSaver({
      ...options(),
      dialog: {
        showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: "/ro/x.zip" }),
      },
      fetch: vi
        .fn()
        .mockResolvedValue(
          Response.json(
            {
              kind: "failed",
              message: "Octant could not write the support bundle there. Nothing was saved.",
            },
            { status: 422 },
          ),
        ),
    });
    await expect(save({ sender: {} })).rejects.toThrow("Nothing was saved");
  });
});

describe("defaultSupportBundleFileName", () => {
  it("dates the name in UTC", () => {
    expect(defaultSupportBundleFileName(new Date("2026-01-02T23:59:59.000Z"))).toBe(
      "octant-diagnostics-20260102.zip",
    );
  });
});
