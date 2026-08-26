import { afterEach, describe, expect, it, vi } from "vitest";
import { documentIsVisible, scheduleVisibleInterval } from "./documentVisibility";

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

describe("document visibility polling", () => {
  const originalVisibility = document.visibilityState;

  afterEach(() => {
    setVisibility(originalVisibility);
    vi.useRealTimers();
  });

  it("treats a visible document as visible", () => {
    setVisibility("visible");
    expect(documentIsVisible()).toBe(true);
  });

  it("does not tick while the document is hidden, then ticks once on becoming visible", () => {
    vi.useFakeTimers();
    setVisibility("hidden");
    const tick = vi.fn();
    const stop = scheduleVisibleInterval(tick, 1_000, { runImmediately: true });

    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(tick).not.toHaveBeenCalled();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(tick).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("clears the timer when the interval is stopped", () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const tick = vi.fn();
    const stop = scheduleVisibleInterval(tick, 1_000);
    stop();
    vi.advanceTimersByTime(2_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
