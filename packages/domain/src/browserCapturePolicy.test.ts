import { decodeBrowserCapture, type BrowserCapture } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  browserCaptureExportAttachments,
  browserCaptureRetention,
  browserCapturePageOrigin,
  browserCaptureTaker,
} from "./browserCapturePolicy";

describe("browserCaptureTaker", () => {
  it("keeps an explicit screenshot by whoever asked for it", () => {
    expect(browserCaptureTaker("screenshot", "agent")).toBe("agent");
    expect(browserCaptureTaker("screenshot", "person")).toBe("person");
  });

  it("keeps nothing for the picture that follows any other action", () => {
    for (const kind of [
      "navigate",
      "click",
      "type",
      "press",
      "scroll",
      "extract-text",
      "wait",
      "close-tab",
      "observe-diagnostics",
    ] as const) {
      expect(browserCaptureTaker(kind, "agent")).toBeUndefined();
      expect(browserCaptureTaker(kind, "person")).toBeUndefined();
    }
  });

  it("keeps nothing when the caller does not say who asked", () => {
    expect(browserCaptureTaker("screenshot", undefined)).toBeUndefined();
  });
});

describe("browserCapturePageOrigin", () => {
  it("records the origin of a web page and nothing else", () => {
    expect(browserCapturePageOrigin("https://example.com:8443/a?b=1#c")).toBe(
      "https://example.com:8443",
    );
    expect(browserCapturePageOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(browserCapturePageOrigin("about:blank")).toBeUndefined();
    expect(browserCapturePageOrigin("file:///etc/hosts")).toBeUndefined();
    expect(browserCapturePageOrigin("not a url")).toBeUndefined();
    expect(browserCapturePageOrigin(undefined)).toBeUndefined();
  });
});

describe("browserCaptureRetention", () => {
  it("keeps every capture until a thread passes its allowance", () => {
    expect(browserCaptureRetention(1)).toEqual({ firstRetainedVersion: 1 });
    expect(browserCaptureRetention(32)).toEqual({ firstRetainedVersion: 1 });
  });

  it("drops the oldest capture first once the allowance is passed", () => {
    expect(browserCaptureRetention(33)).toEqual({ firstRetainedVersion: 2 });
  });

  it("keeps the newest few when the allowance is smaller", () => {
    expect(browserCaptureRetention(10, 3)).toEqual({ firstRetainedVersion: 8 });
  });
});

describe("browserCaptureExportAttachments", () => {
  const capture = (overrides: Record<string, unknown>): BrowserCapture =>
    decodeBrowserCapture({
      captureId: "b1000000-0000-4000-8000-000000000001",
      threadId: "b1000000-0000-4000-8000-0000000000aa",
      origin: "https://example.com",
      url: "https://example.com/account/orders?id=7",
      title: "Your orders",
      hash: "a".repeat(64),
      size: 2048,
      mime: "image/png",
      capturedAt: "2026-10-12T09:00:00.000Z",
      ...overrides,
    });

  it("names each capture from its identity and media type, never from the page", () => {
    const [png, jpeg] = browserCaptureExportAttachments([
      capture({}),
      capture({
        captureId: "b1000000-0000-4000-8000-000000000002",
        mime: "image/jpeg",
        title: "../../etc/passwd",
      }),
    ]);
    expect(png?.displayName).toBe("browser-capture-b1000000-0000-4000-8000-000000000001.png");
    expect(jpeg?.displayName).toBe("browser-capture-b1000000-0000-4000-8000-000000000002.jpg");
  });

  it("carries the page title, URL, origin, and capture time with the size and media type", () => {
    expect(browserCaptureExportAttachments([capture({})])).toEqual([
      {
        displayName: "browser-capture-b1000000-0000-4000-8000-000000000001.png",
        mediaType: "image/png",
        byteLength: 2048,
        status: "finalized",
        capture: {
          captureId: "b1000000-0000-4000-8000-000000000001",
          origin: "https://example.com",
          url: "https://example.com/account/orders?id=7",
          title: "Your orders",
          capturedAt: "2026-10-12T09:00:00.000Z",
        },
      },
    ]);
  });

  it("leaves the title out when the page had none and keeps the given order", () => {
    const [first, second] = browserCaptureExportAttachments([
      capture({ title: undefined }),
      capture({ captureId: "b1000000-0000-4000-8000-000000000003" }),
    ]);
    expect(first?.capture).not.toHaveProperty("title");
    expect(second?.capture?.captureId).toBe("b1000000-0000-4000-8000-000000000003");
  });

  it("exports nothing for a thread without captures", () => {
    expect(browserCaptureExportAttachments([])).toEqual([]);
  });
});
