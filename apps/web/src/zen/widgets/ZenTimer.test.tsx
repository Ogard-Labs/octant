import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ZenTimerElementPayload } from "@octant/contracts/zen";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZenTimer } from "./ZenTimer";

const timer: ZenTimerElementPayload = {
  elementId: "00000000-0000-4000-8000-000000000931" as never,
  kind: "timer",
  durationMs: 2_000,
  remainingMs: 2_000,
  status: "running",
  startedAt: "2026-07-29T08:00:00.000Z" as never,
  deadlineAt: "2026-07-29T08:00:02.000Z" as never,
  clockSessionId: "server-session",
  monotonicStartedMs: 10_000,
  geometry: { x: 40, y: 40, width: 360, height: 220 },
  zIndex: 1,
  minimized: false,
  locked: false,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ZenTimer", () => {
  it("uses local ticking only for display and waits for authoritative completion state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00.000Z"));
    const onElapsed = vi.fn();
    const { rerender } = render(
      <ZenTimer
        onAction={() => undefined}
        onElapsed={onElapsed}
        reducedMotion={false}
        timer={timer}
      />,
    );

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByRole("timer")).toHaveTextContent("00:01");
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByRole("timer")).toHaveTextContent("00:00");
    expect(screen.getByRole("status", { name: "Timer status" })).toHaveTextContent("Running");
    expect(onElapsed).toHaveBeenCalledOnce();

    rerender(
      <ZenTimer
        onAction={() => undefined}
        onElapsed={onElapsed}
        reducedMotion={false}
        timer={{
          ...timer,
          status: "completed",
          remainingMs: 0,
          startedAt: null,
          deadlineAt: null,
          clockSessionId: null,
          monotonicStartedMs: null,
        }}
      />,
    );
    expect(screen.getByRole("status", { name: "Timer status" })).toHaveTextContent(
      "Timer complete",
    );
  });

  it("refreshes immediately after background throttling and keeps controls keyboard accessible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00.000Z"));
    const onAction = vi.fn();
    const onElapsed = vi.fn();
    render(<ZenTimer onAction={onAction} onElapsed={onElapsed} reducedMotion timer={timer} />);

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    fireEvent(document, new Event("visibilitychange"));
    expect(onElapsed).toHaveBeenCalledOnce();
    expect(screen.getByRole("timer")).toHaveTextContent("00:00");
    fireEvent.click(screen.getByRole("button", { name: "Pause timer" }));
    expect(onAction).toHaveBeenCalledWith("pause");
  });

  it("refreshes once after wall time crosses the deadline while performance time is suspended", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00.000Z"));
    const onElapsed = vi.fn();
    render(
      <ZenTimer onAction={() => undefined} onElapsed={onElapsed} reducedMotion timer={timer} />,
    );

    vi.setSystemTime(new Date("2026-07-29T08:00:03.000Z"));
    fireEvent(document, new Event("visibilitychange"));

    expect(screen.getByRole("timer")).toHaveTextContent("00:00");
    expect(onElapsed).toHaveBeenCalledOnce();
    fireEvent(document, new Event("visibilitychange"));
    expect(onElapsed).toHaveBeenCalledOnce();
  });
});
