import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  captureBrowserFeedbackPoint,
  type BrowserFeedbackCapturePort,
} from "./browserPointCapture";

function fixture() {
  let current = true;
  let node = 42;
  let frame = "top";
  let blocked = false;
  let screenshot: (() => Promise<unknown>) | undefined;
  const sensitive = vi.fn(async () => false);
  const send = vi.fn(
    async (method: string, _parameters?: Record<string, unknown>): Promise<unknown> => {
      if (method === "Page.getFrameTree")
        return {
          frameTree: {
            frame: {
              id: "top",
              loaderId: "document-1",
              url: "https://example.com/page?token=credential",
            },
          },
        };
      if (method === "Page.getLayoutMetrics")
        return {
          cssVisualViewport: {
            clientWidth: 640,
            clientHeight: 480,
            pageX: 0,
            pageY: 100,
            offsetX: 0,
            offsetY: 0,
            scale: 1,
          },
        };
      if (method === "DOM.getNodeForLocation") return { frameId: frame, backendNodeId: node };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate")
        return {
          result: {
            value: {
              title: "Example",
              read: {
                element: {
                  selector: "#save",
                  role: "button",
                  text: "Save",
                  bounds: { x: 0.25, y: 0.25, width: 0.1, height: 0.1 },
                },
                context: {
                  viewport: { width: 640, height: 480 },
                  tag: "button",
                  ancestors: ["main"],
                  children: [],
                  styles: [{ property: "color", value: "rgb(0, 0, 0)" }],
                  omissions: blocked ? ["crop-withheld-for-uninspected-region"] : [],
                },
                cropBlocked: blocked,
              },
            },
          },
        };
      if (method === "Page.captureScreenshot") return screenshot?.() ?? { data: "/9j/AA==" };
      throw new Error(`Unexpected protocol method ${method}`);
    },
  );
  const port: BrowserFeedbackCapturePort = {
    send,
    sensitive,
    current: () => current,
    admits: (url) => new URL(url).origin === "https://example.com",
    digest: (value) => createHash("sha256").update(value).digest("hex"),
  };
  return {
    port,
    send,
    sensitive,
    retire: () => {
      current = false;
    },
    replaceNode: () => {
      node += 1;
    },
    crossFrame: () => {
      frame = "unapproved-child";
    },
    opaqueCrop: () => {
      blocked = true;
    },
    holdScreenshot: (effect: () => Promise<unknown>) => {
      screenshot = effect;
    },
  };
}

describe("host point capture", () => {
  it("binds bounded DOM/style data and the crop to one document/node/viewport", async () => {
    const f = fixture();
    const result = await captureBrowserFeedbackPoint(
      f.port,
      { x: 0.3, y: 0.3 },
      new AbortController().signal,
    );
    expect(result.status).toBe("described");
    if (result.status !== "described") throw new Error("Missing capture");
    expect(result.element.context?.captureId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.element.context?.styles).toEqual([{ property: "color", value: "rgb(0, 0, 0)" }]);
    expect(result.url).toBe("https://example.com/page?token=redacted");
    expect(result.cropDataUrl).toBe("data:image/jpeg;base64,/9j/AA==");
    expect(f.send).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
      captureBeyondViewport: false,
      clip: { x: 136, y: 196, width: 112, height: 96, scale: 1 },
    });
  });

  it("does not enter a child frame merely because CDP can hit its node", async () => {
    const f = fixture();
    f.crossFrame();
    expect(
      await captureBrowserFeedbackPoint(f.port, { x: 0.3, y: 0.3 }, new AbortController().signal),
    ).toEqual({ status: "unavailable", reason: "frame-unavailable" });
    expect(f.send.mock.calls.some(([method]) => method === "Runtime.evaluate")).toBe(false);
    expect(f.send.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(false);
  });

  it("withholds an opaque overlapping frame crop while retaining the bounded top-frame context", async () => {
    const f = fixture();
    f.opaqueCrop();
    const result = await captureBrowserFeedbackPoint(
      f.port,
      { x: 0.3, y: 0.3 },
      new AbortController().signal,
    );
    if (result.status !== "described") throw new Error("Missing capture");
    expect(result.cropDataUrl).toBeUndefined();
    expect(result.element.context?.omissions).toContain("crop-withheld-for-uninspected-region");
    expect(f.send.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(false);
  });

  it("refuses an identical-description replacement node between DOM and screenshot", async () => {
    const f = fixture();
    f.holdScreenshot(async () => {
      f.replaceNode();
      return { data: "/9j/AA==" };
    });
    expect(
      await captureBrowserFeedbackPoint(f.port, { x: 0.3, y: 0.3 }, new AbortController().signal),
    ).toEqual({ status: "unavailable", reason: "page-changed" });
  });

  it("settles a hung screenshot on abort and never publishes its later bytes", async () => {
    const f = fixture();
    let release: ((value: unknown) => void) | undefined;
    f.holdScreenshot(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const abort = new AbortController();
    const result = captureBrowserFeedbackPoint(f.port, { x: 0.3, y: 0.3 }, abort.signal);
    await vi.waitFor(() => expect(release).toBeDefined());
    abort.abort();
    await expect(result).resolves.toEqual({ status: "unavailable", reason: "page-changed" });
    release?.({ data: "/9j/AA==" });
    await Promise.resolve();
    expect(f.send.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(1);
  });

  it.each(["before", "after"] as const)(
    "withholds all output when credential observation pauses %s the crop",
    async (phase) => {
      const f = fixture();
      if (phase === "before") f.sensitive.mockResolvedValue(true);
      else
        f.holdScreenshot(async () => {
          f.sensitive.mockResolvedValue(true);
          return { data: "/9j/AA==" };
        });
      expect(
        await captureBrowserFeedbackPoint(f.port, { x: 0.3, y: 0.3 }, new AbortController().signal),
      ).toEqual({ status: "unavailable", reason: "observation-paused" });
      if (phase === "before") expect(f.send).not.toHaveBeenCalled();
    },
  );

  it("withholds output if current host ownership retires after native work completes", async () => {
    const f = fixture();
    f.holdScreenshot(async () => {
      f.retire();
      return { data: "/9j/AA==" };
    });
    expect(
      await captureBrowserFeedbackPoint(f.port, { x: 0.3, y: 0.3 }, new AbortController().signal),
    ).toEqual({ status: "unavailable", reason: "page-changed" });
  });
});
