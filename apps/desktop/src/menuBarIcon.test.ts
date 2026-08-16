import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HOST_TRAY_ICON_SIZE, createHostTrayImage, shouldPresentHostTray } from "./menuBarIcon";

describe("macOS menu-bar icon", () => {
  it("keeps the status item available while the app is running, including stopped host state", () => {
    expect(shouldPresentHostTray("darwin", "running")).toBe(true);
    expect(shouldPresentHostTray("darwin", "stopped")).toBe(true);
    expect(shouldPresentHostTray("linux", "running")).toBe(false);
  });

  it("creates an 18px monochrome template glyph from a non-empty source", () => {
    const setTemplateImage = vi.fn();
    const resized = {
      isEmpty: () => false,
      resize: vi.fn(() => resized),
      setTemplateImage,
    };
    const source = {
      isEmpty: () => false,
      resize: vi.fn(() => resized),
      setTemplateImage: vi.fn(),
    };
    const createFromPath = vi.fn(() => source);

    expect(createHostTrayImage({ createFromPath }, "/tmp/menuBarTemplate.png")).toBe(resized);
    expect(source.resize).toHaveBeenCalledWith({
      height: HOST_TRAY_ICON_SIZE,
      quality: "best",
      width: HOST_TRAY_ICON_SIZE,
    });
    expect(setTemplateImage).toHaveBeenCalledWith(true);
  });

  it("ships the supplied transparent 1x and 2x PNG representations for Electron", async () => {
    const [standard, retina] = await Promise.all([
      readFile(resolve(import.meta.dirname, "../resources/menuBarTemplate.png")),
      readFile(resolve(import.meta.dirname, "../resources/menuBarTemplate@2x.png")),
    ]);
    expect([standard.readUInt32BE(16), standard.readUInt32BE(20)]).toEqual([18, 18]);
    expect([retina.readUInt32BE(16), retina.readUInt32BE(20)]).toEqual([36, 36]);
    expect([standard[24], standard[25]]).toEqual([8, 6]);
    expect([retina[24], retina[25]]).toEqual([8, 6]);
  });
});
