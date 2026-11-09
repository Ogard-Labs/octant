// Bulk-part ports for the per-mode move host tests: one capture to carry, and
// a destination that records what it was asked to keep.

import { decodeBrowserCapture } from "@octant/contracts";
import type { ThreadPartsDestination, ThreadPartsSource } from "./movedThreadParts";

/** A thread that owns no bulk part. */
export function noThreadParts(): {
  readonly source: ThreadPartsSource;
  readonly destination: ThreadPartsDestination;
} {
  return oneCaptureThreadParts({ captures: false }).parts;
}

/** A thread that kept one Browser capture, and a destination that records each capture it keeps. */
export function oneCaptureThreadParts(input: { readonly captures?: boolean } = {}) {
  const kept: Array<Parameters<ThreadPartsDestination["carryBrowserCapture"]>[0]> = [];
  const source: ThreadPartsSource = {
    generatedImages: () => [],
    readGeneratedImage: async () => undefined,
    browserCaptures: (threadId) =>
      input.captures === false
        ? []
        : [
            decodeBrowserCapture({
              captureId: "cccccccc-0000-4000-8000-000000000001",
              threadId,
              origin: "https://example.com",
              url: "https://example.com/agenda",
              title: "Agenda",
              hash: "a".repeat(64),
              size: 3,
              mime: "image/png",
              capturedAt: "2026-11-08T10:00:00.000Z",
            }),
          ],
    readBrowserCapture: async () => Uint8Array.from([1, 2, 3]),
    canvases: () => [],
  };
  const destination: ThreadPartsDestination = {
    carryGeneratedImage: async () => {},
    carryBrowserCapture: async (capture) => {
      kept.push(capture);
    },
    carryCanvas: () => {},
  };
  return { parts: { source, destination }, kept };
}
