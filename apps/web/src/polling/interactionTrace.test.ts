import { afterEach, describe, expect, it } from "vitest";
import {
  clearInteractionMarks,
  markInteraction,
  markInteractionAfterPaint,
  readInteractionMarks,
} from "./interactionTrace";

describe("interactionTrace", () => {
  afterEach(() => {
    delete (globalThis as { __OCTANT_PERF_TRACE?: boolean }).__OCTANT_PERF_TRACE;
    clearInteractionMarks();
  });

  it("records nothing unless the local trace flag is on", () => {
    markInteraction("renderer", "thread-switch");
    expect(readInteractionMarks()).toEqual([]);
  });

  it("records a layered mark when the local trace flag is on", () => {
    (globalThis as { __OCTANT_PERF_TRACE?: boolean }).__OCTANT_PERF_TRACE = true;
    markInteraction("renderer", "thread-switch");
    markInteraction("server", "code-navigation");
    const marks = readInteractionMarks();
    expect(marks.map((mark) => `${mark.layer}:${mark.name}`)).toEqual([
      "renderer:thread-switch",
      "server:code-navigation",
    ]);
  });

  it("records when an interaction reaches the next painted frame", async () => {
    (globalThis as { __OCTANT_PERF_TRACE?: boolean }).__OCTANT_PERF_TRACE = true;
    markInteractionAfterPaint("mode-switch");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(readInteractionMarks().map((mark) => mark.name)).toEqual(["mode-switch-painted"]);
  });
});
