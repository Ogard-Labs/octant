import { describe, expect, it } from "vitest";
import {
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
