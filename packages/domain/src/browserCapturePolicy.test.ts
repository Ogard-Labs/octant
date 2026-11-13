import { decodeBrowserCapture, type BrowserCapture } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  browserCaptureExportAttachments,
  browserCaptureRetention,
  browserCapturePageOrigin,
  browserCaptureTaker,
  browserRetainedCaptures,
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

  it("keeps a recording only when the agent's own call ends one", () => {
    expect(browserCaptureTaker("record-stop", "agent")).toBe("agent");
    expect(browserCaptureTaker("record-stop", "person")).toBeUndefined();
    expect(browserCaptureTaker("record-stop", undefined)).toBeUndefined();
    expect(browserCaptureTaker("record-start", "agent")).toBeUndefined();
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
    expect(browserCaptureRetention(200)).toEqual({ firstRetainedVersion: 1 });
  });

  it("drops the oldest capture first once the default 200 is passed", () => {
    expect(browserCaptureRetention(201)).toEqual({ firstRetainedVersion: 2 });
  });

  it("keeps the newest few when the allowance is smaller", () => {
    expect(browserCaptureRetention(10, 3)).toEqual({ firstRetainedVersion: 8 });
  });
});

describe("browserRetainedCaptures", () => {
  const shot = (index: number): BrowserCapture =>
    decodeBrowserCapture({
      captureId: `b1000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
      threadId: "b0000000-0000-4000-8000-000000000002",
      origin: "https://example.com",
      url: "https://example.com/",
      hash: "a".repeat(64),
      size: 10,
      mime: "image/png",
      capturedAt: "2026-10-12T09:00:00.000Z",
    });
  const recording = (index: number): BrowserCapture =>
    decodeBrowserCapture({ ...shot(index), recording: { frames: 2, durationMs: 500 } });
  const ids = (captures: ReadonlyArray<BrowserCapture>) =>
    captures.map((capture) => capture.captureId.slice(-2));

  it("keeps the newest eight recordings and drops older ones, newest first", () => {
    // Newest first, as the journal window is listed: recordings 10 down to 1.
    const window = Array.from({ length: 10 }, (_, index) => recording(10 - index));
    expect(ids(browserRetainedCaptures(window))).toEqual([
      "10",
      "09",
      "08",
      "07",
      "06",
      "05",
      "04",
      "03",
    ]);
  });

  it("never drops a screenshot to make room for a recording", () => {
    const window = [
      recording(20),
      shot(19),
      ...Array.from({ length: 8 }, (_, index) => recording(18 - index)),
      shot(10),
    ];
    const retained = browserRetainedCaptures(window);
    expect(ids(retained)).toEqual(["20", "19", "18", "17", "16", "15", "14", "13", "12", "10"]);
    expect(retained.filter((capture) => capture.recording === undefined)).toHaveLength(2);
  });

  it("leaves a window of screenshots as it is", () => {
    const window = Array.from({ length: 32 }, (_, index) => shot(32 - index));
    expect(browserRetainedCaptures(window)).toEqual(window);
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
