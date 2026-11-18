import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMinuteClock } from "./minuteClock";

function Age() {
  return <span data-testid="clock">{String(useMinuteClock())}</span>;
}

describe("The shared minute clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 12, 0, 10));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves every row on with one timer, once a minute, and stops it with the last row", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const first = render(<Age />);
    const second = render(<Age />);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const before = first.container.textContent;

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(first.container.textContent).toBe(before);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(first.container.textContent).not.toBe(before);
    expect(second.container.textContent).toBe(first.container.textContent);

    first.unmount();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    second.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
