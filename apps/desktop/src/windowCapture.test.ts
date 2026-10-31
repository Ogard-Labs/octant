import { describe, expect, it, vi } from "vitest";
import { createWindowCapture, type WindowCapturePorts } from "./windowCapture";

function source(id: string, name: string, png = new Uint8Array([137, 80, 78, 71])) {
  return {
    id,
    name,
    thumbnail: { isEmpty: () => png.byteLength === 0, toPNG: () => png },
  };
}

function ports(overrides: Partial<WindowCapturePorts> = {}): WindowCapturePorts {
  return {
    platform: "darwin",
    screenAccess: () => "granted",
    windowSources: vi.fn(async () => [source("window:1:0", "Notes"), source("window:2:0", "  ")]),
    openScreenRecordingSettings: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("window capture", () => {
  it("lists window titles without reading any window's pixels", async () => {
    const windowSources = vi.fn(async () => [source("window:1:0", "Notes"), source("w", "  ")]);
    const capture = createWindowCapture(ports({ windowSources }));
    await expect(capture.list()).resolves.toEqual({
      kind: "windows",
      windows: [{ id: "window:1:0", name: "Notes" }],
    });
    expect(windowSources).toHaveBeenCalledExactlyOnceWith({ width: 0, height: 0 });
  });

  it("does not touch the capture API, and so does not prompt, before the person agreed", async () => {
    const windowSources = vi.fn(async () => []);
    const capture = createWindowCapture(
      ports({ screenAccess: () => "not-determined", windowSources }),
    );
    await expect(capture.list()).resolves.toEqual({
      kind: "permission-needed",
      access: "not-determined",
    });
    await expect(capture.capture("window:1:0")).resolves.toEqual({ kind: "permission-needed" });
    expect(windowSources).not.toHaveBeenCalled();
  });

  it("asks macOS once the person agreed, and reports whether it was granted", async () => {
    let access: "not-determined" | "granted" = "not-determined";
    const windowSources = vi.fn(async () => {
      access = "granted";
      return [];
    });
    const capture = createWindowCapture(ports({ screenAccess: () => access, windowSources }));
    await expect(capture.requestPermission()).resolves.toEqual({ kind: "granted" });
    expect(windowSources).toHaveBeenCalledOnce();

    const stuck = createWindowCapture(
      ports({ screenAccess: () => "not-determined", windowSources: vi.fn(async () => []) }),
    );
    await expect(stuck.requestPermission()).resolves.toEqual({ kind: "needs-settings" });
  });

  it("sends a person who denied it to System Settings instead of prompting again", async () => {
    const windowSources = vi.fn(async () => []);
    const openScreenRecordingSettings = vi.fn(async () => undefined);
    const capture = createWindowCapture(
      ports({ screenAccess: () => "denied", windowSources, openScreenRecordingSettings }),
    );
    await expect(capture.requestPermission()).resolves.toEqual({ kind: "needs-settings" });
    expect(openScreenRecordingSettings).toHaveBeenCalledOnce();
    expect(windowSources).not.toHaveBeenCalled();
  });

  it("captures only the window that was picked", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const capture = createWindowCapture(
      ports({
        windowSources: vi.fn(async () => [
          source("window:1:0", "Notes", png),
          source("window:9:0", "Mail", new Uint8Array([9, 9])),
        ]),
      }),
    );
    await expect(capture.capture("window:1:0")).resolves.toEqual({
      kind: "captured",
      name: "Notes",
      mimeType: "image/png",
      bytes: png,
    });
  });

  it("says so when the picked window closed before the capture", async () => {
    const capture = createWindowCapture(ports());
    await expect(capture.capture("window:404:0")).resolves.toEqual({ kind: "gone" });
  });

  it("explains an empty or oversized capture instead of attaching it", async () => {
    const empty = createWindowCapture(
      ports({ windowSources: vi.fn(async () => [source("a", "Notes", new Uint8Array())]) }),
    );
    await expect(empty.capture("a")).resolves.toMatchObject({ kind: "failed" });
    const huge = createWindowCapture(
      ports({
        windowSources: vi.fn(async () => [source("a", "Notes", new Uint8Array(21 * 1024 * 1024))]),
      }),
    );
    await expect(huge.capture("a")).resolves.toMatchObject({
      kind: "failed",
      message: "That window is too large to attach as an image.",
    });
  });

  it("offers nothing off macOS", async () => {
    const windowSources = vi.fn(async () => []);
    const capture = createWindowCapture(ports({ platform: "linux", windowSources }));
    await expect(capture.list()).resolves.toEqual({ kind: "windows", windows: [] });
    await expect(capture.capture("a")).resolves.toMatchObject({ kind: "failed" });
    expect(windowSources).not.toHaveBeenCalled();
  });
});
