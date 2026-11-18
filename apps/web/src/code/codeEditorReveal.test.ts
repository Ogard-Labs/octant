import { describe, expect, it, vi } from "vitest";
import type { MonacoEditorRange } from "./MonacoEditorAdapter";
import { requestCodeEditorReveal, takeCodeEditorReveals } from "./codeEditorReveal";

const range = (line: number): MonacoEditorRange => ({
  startLineNumber: line,
  startColumn: 1,
  endLineNumber: line,
  endColumn: 2,
});

describe("codeEditorReveal", () => {
  it("hands a waiting reveal to the editor that opens its file", () => {
    const listener = vi.fn();
    requestCodeEditorReveal("reveal-recent", range(10), 1_000);

    const release = takeCodeEditorReveals("reveal-recent", listener, 2_000);

    expect(listener).toHaveBeenCalledWith(range(10));
    release();
  });

  it("drops a reveal nobody took within thirty seconds instead of jumping later", () => {
    const listener = vi.fn();
    requestCodeEditorReveal("reveal-expired", range(10), 1_000);

    const release = takeCodeEditorReveals("reveal-expired", listener, 32_000);

    expect(listener).not.toHaveBeenCalled();
    release();
  });

  it("keeps a reveal taken at the thirty-second line", () => {
    const listener = vi.fn();
    requestCodeEditorReveal("reveal-boundary", range(10), 1_000);

    const release = takeCodeEditorReveals("reveal-boundary", listener, 31_000);

    expect(listener).toHaveBeenCalledWith(range(10));
    release();
  });

  it("drops the oldest waiting reveal past 128 rather than growing forever", () => {
    const oldest = vi.fn();
    const newest = vi.fn();
    for (let index = 0; index < 129; index += 1) {
      requestCodeEditorReveal(`reveal-cap-${index}`, range(index), 1_000 + index);
    }

    const takeOldest = takeCodeEditorReveals("reveal-cap-0", oldest, 2_000);
    const takeNewest = takeCodeEditorReveals("reveal-cap-128", newest, 2_000);

    expect(oldest).not.toHaveBeenCalled();
    expect(newest).toHaveBeenCalledWith(range(128));
    takeOldest();
    takeNewest();
  });

  it("tells a listener that is already open at once, without queueing", () => {
    const listener = vi.fn();
    const release = takeCodeEditorReveals("reveal-live", listener, 1_000);

    requestCodeEditorReveal("reveal-live", range(5), 2_000);

    expect(listener).toHaveBeenCalledWith(range(5));
    release();
  });

  it("stops telling a listener once it is released", () => {
    const listener = vi.fn();
    const release = takeCodeEditorReveals("reveal-release", listener, 1_000);
    release();

    requestCodeEditorReveal("reveal-release", range(5), 2_000);
    const later = vi.fn();
    const next = takeCodeEditorReveals("reveal-release", later, 3_000);

    expect(listener).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledWith(range(5));
    next();
  });

  it("treats a re-requested reveal as the newest, evicting another file's", () => {
    requestCodeEditorReveal("reveal-evicted", range(2), 1_000);
    requestCodeEditorReveal("reveal-kept", range(1), 2_000);
    // Re-requesting the second reveal makes it newer than the first, so the
    // first is the one a full queue drops.
    requestCodeEditorReveal("reveal-kept", range(9), 3_000);
    const kept = vi.fn();
    const evicted = vi.fn();

    for (let index = 0; index < 127; index += 1) {
      requestCodeEditorReveal(`reveal-other-${index}`, range(index), 4_000 + index);
    }

    const takeKept = takeCodeEditorReveals("reveal-kept", kept, 5_000);
    const takeEvicted = takeCodeEditorReveals("reveal-evicted", evicted, 5_000);

    expect(kept).toHaveBeenCalledWith(range(9));
    expect(evicted).not.toHaveBeenCalled();
    takeKept();
    takeEvicted();
  });
});
