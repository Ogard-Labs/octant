import { describe, expect, it } from "vitest";
import { decodeBrowserObservation } from "./browserAutomation";
import {
  decodeBrowserCapture,
  decodeBrowserCaptureImage,
  decodeBrowserCapturesResponse,
  MAX_BROWSER_CAPTURE_BYTES,
  MAX_BROWSER_CAPTURES_PER_THREAD,
} from "./browserCapture";

const capture = {
  captureId: "b0000000-0000-4000-8000-000000000001",
  threadId: "b0000000-0000-4000-8000-000000000002",
  origin: "https://example.com",
  url: "https://example.com/pricing",
  title: "Pricing",
  hash: "a".repeat(64),
  size: 2_048,
  mime: "image/png",
  capturedAt: "2026-10-12T09:00:00.000Z",
};

describe("BrowserCapture", () => {
  it("names the picture by digest and carries no bytes", () => {
    expect(decodeBrowserCapture(capture).hash).toBe("a".repeat(64));
    expect(() =>
      decodeBrowserCapture({ ...capture, dataUrl: "data:image/png;base64,AAAA" }),
    ).toThrow();
    expect(() => decodeBrowserCapture({ ...capture, bytes: "AAAA" })).toThrow();
  });

  it("refuses a capture larger than the screenshot envelope", () => {
    expect(() =>
      decodeBrowserCapture({ ...capture, size: MAX_BROWSER_CAPTURE_BYTES + 1 }),
    ).toThrow();
    expect(decodeBrowserCapture({ ...capture, size: MAX_BROWSER_CAPTURE_BYTES }).size).toBe(
      MAX_BROWSER_CAPTURE_BYTES,
    );
  });

  it("refuses more captures than a thread keeps in one listing", () => {
    const many = Array.from({ length: MAX_BROWSER_CAPTURES_PER_THREAD + 1 }, () => capture);
    expect(() => decodeBrowserCapturesResponse({ captures: many })).toThrow();
  });

  it("serves the picture only as an image data URL", () => {
    expect(
      decodeBrowserCaptureImage({
        captureId: capture.captureId,
        dataUrl: "data:image/png;base64,AAAA",
      }).captureId,
    ).toBe(capture.captureId);
    expect(() =>
      decodeBrowserCaptureImage({
        captureId: capture.captureId,
        dataUrl: "data:text/html;base64,AAAA",
      }),
    ).toThrow();
  });
});

describe("BrowserObservation capture outcome", () => {
  const observation = {
    contextId: "b0000000-0000-4000-8000-000000000003",
    actionId: "b0000000-0000-4000-8000-000000000004",
    correlationId: "b0000000-0000-4000-8000-000000000005",
    authority: {
      hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
      providerInstanceId: "b0000000-0000-4000-8000-000000000006",
      extension: { kind: "core" },
      mode: "chat",
    },
    observedAt: "2026-10-12T09:00:00.000Z",
    stale: false,
  };

  it("says whether a screenshot was kept and why it was not", () => {
    expect(
      decodeBrowserObservation({
        ...observation,
        capture: { status: "kept", captureId: capture.captureId },
      }).capture,
    ).toEqual({ status: "kept", captureId: capture.captureId });
    expect(
      decodeBrowserObservation({
        ...observation,
        capture: { status: "not-kept", reason: "too-large" },
      }).capture,
    ).toEqual({ status: "not-kept", reason: "too-large" });
    expect(() =>
      decodeBrowserObservation({
        ...observation,
        capture: { status: "not-kept", reason: "disk on fire" },
      }),
    ).toThrow();
  });
});
