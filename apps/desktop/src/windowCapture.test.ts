import { describe, expect, it, vi } from "vitest";
import { createWindowCapture, type WindowCapturePorts } from "./windowCapture";

const png = new Uint8Array([137, 80, 78, 71]);

function ports(overrides: Partial<WindowCapturePorts> = {}): WindowCapturePorts {
  return {
    platform: "darwin",
    screenAccess: () => "granted",
    windowSources: vi.fn(async () => [
      { id: "window:1:0", name: "Notes" },
      { id: "window:2:0", name: "  " },
    ]),
    grabFrame: vi.fn(async () => png),
    openScreenRecordingSettings: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("window capture", () => {
  it("lists window titles without reading any window's pixels", async () => {
    const windowSources = vi.fn(async () => [
      { id: "window:1:0", name: "Notes" },
      { id: "w", name: "  " },
    ]);
    const grabFrame = vi.fn(async () => png);
    const capture = createWindowCapture(ports({ windowSources, grabFrame }));
    await expect(capture.list()).resolves.toEqual({
      kind: "windows",
      windows: [{ id: "window:1:0", name: "Notes" }],
    });
    expect(windowSources).toHaveBeenCalledOnce();
    expect(grabFrame).not.toHaveBeenCalled();
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

  it("opens a stream for the picked window alone and never lists with thumbnails", async () => {
    const notes = { id: "window:1:0", name: "Notes" };
    const mail = { id: "window:9:0", name: "Mail" };
    // A non-zero thumbnail size would read every open window's pixels, so the
    // listing port takes no size at all and every call must pass none.
    const windowSources = vi.fn(async (..._size: ReadonlyArray<unknown>) => [notes, mail]);
    const grabFrame = vi.fn(async () => png);
    const capture = createWindowCapture(
      ports({ windowSources: windowSources as WindowCapturePorts["windowSources"], grabFrame }),
    );
    await expect(capture.capture("window:1:0")).resolves.toEqual({
      kind: "captured",
      name: "Notes",
      mimeType: "image/png",
      bytes: png,
    });
    expect(grabFrame).toHaveBeenCalledExactlyOnceWith(notes);
    for (const call of windowSources.mock.calls) expect(call).toEqual([]);
  });

  it("says so when the picked window closed before the capture", async () => {
    const capture = createWindowCapture(ports());
    await expect(capture.capture("window:404:0")).resolves.toEqual({ kind: "gone" });
  });

  it("explains an empty or oversized capture instead of attaching it", async () => {
    const empty = createWindowCapture(ports({ grabFrame: vi.fn(async () => undefined) }));
    await expect(empty.capture("window:1:0")).resolves.toMatchObject({ kind: "failed" });
    const failing = createWindowCapture(
      ports({ grabFrame: vi.fn(async () => Promise.reject(new Error("no stream"))) }),
    );
    await expect(failing.capture("window:1:0")).resolves.toMatchObject({ kind: "failed" });
    const huge = createWindowCapture(
      ports({ grabFrame: vi.fn(async () => new Uint8Array(21 * 1024 * 1024)) }),
    );
    await expect(huge.capture("window:1:0")).resolves.toMatchObject({
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
