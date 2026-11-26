import { afterEach, describe, expect, it, vi } from "vitest";
import { sheetsClosing } from "./sheetsClosing";

afterEach(() => {
  vi.useRealTimers();
});

describe("a sheet asked for while another is leaving", () => {
  it("waits until the one before it has gone", () => {
    const details = Symbol("details");
    const panes = Symbol("panes");
    const heard = vi.fn();
    const stop = sheetsClosing.subscribe(heard);

    sheetsClosing.leaves(details);
    expect(sheetsClosing.othersLeaving(panes)).toBe(true);
    // A sheet leaving does not hold itself back from coming again.
    expect(sheetsClosing.othersLeaving(details)).toBe(false);

    sheetsClosing.gone(details);
    expect(sheetsClosing.othersLeaving(panes)).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it("is shown anyway once the one before it has had well over its exit time", () => {
    vi.useFakeTimers();
    const silent = Symbol("silent");
    const next = Symbol("next");

    sheetsClosing.leaves(silent);
    vi.advanceTimersByTime(900);
    expect(sheetsClosing.othersLeaving(next)).toBe(true);
    vi.advanceTimersByTime(200);
    expect(sheetsClosing.othersLeaving(next)).toBe(false);
  });

  it("still waits for a sheet that left, came back and is leaving again", () => {
    vi.useFakeTimers();
    const todo = Symbol("todo");
    const next = Symbol("next");

    sheetsClosing.leaves(todo);
    vi.advanceTimersByTime(300);
    sheetsClosing.gone(todo);
    vi.advanceTimersByTime(500);
    sheetsClosing.leaves(todo);
    // The first exit's time is up now; the second exit's is not.
    vi.advanceTimersByTime(300);
    expect(sheetsClosing.othersLeaving(next)).toBe(true);
    sheetsClosing.gone(todo);
  });
});
