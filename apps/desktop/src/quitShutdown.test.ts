import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_STOP_BOUND_MS,
  QUIT_DEADLINE_MS,
  WINDOW_STATE_FLUSH_BOUND_MS,
  armQuitDeadline,
  saveWindowStateWithoutBlocking,
  shutDownForQuit,
} from "./quitShutdown";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const never = () => new Promise<void>(() => undefined);

describe("shutting down for quit", () => {
  it("stops the host after the window state is saved and reports a clean quit", async () => {
    const order: string[] = [];
    const log = vi.fn();

    const outcome = await shutDownForQuit({
      flushWindowState: async () => void order.push("window-state"),
      stopHost: async () => void order.push("host"),
      log,
    });

    expect(order).toEqual(["window-state", "host"]);
    expect(outcome).toEqual({ windowState: "completed", host: "completed" });
    expect(log).not.toHaveBeenCalled();
  });

  it("still stops the host and logs when saving the window state fails", async () => {
    const stopHost = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const outcome = await shutDownForQuit({
      flushWindowState: () => Promise.reject(new Error("disk full")),
      stopHost,
      log,
    });

    expect(stopHost).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ windowState: "failed", host: "completed" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("window state"));
  });

  it("gives up on a window state save that never finishes", async () => {
    const stopHost = vi.fn().mockResolvedValue(undefined);
    const pending = shutDownForQuit({ flushWindowState: never, stopHost, log: vi.fn() });

    await vi.advanceTimersByTimeAsync(WINDOW_STATE_FLUSH_BOUND_MS);

    await expect(pending).resolves.toEqual({ windowState: "timed-out", host: "completed" });
    expect(stopHost).toHaveBeenCalledOnce();
  });

  it("finishes and logs when stopping the host fails", async () => {
    const log = vi.fn();

    const outcome = await shutDownForQuit({
      flushWindowState: async () => undefined,
      stopHost: () => Promise.reject(new Error("exit-timeout")),
      log,
    });

    expect(outcome).toEqual({ windowState: "completed", host: "failed" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("local server"));
  });

  it("finishes within a bound when stopping the host never returns", async () => {
    const log = vi.fn();
    const pending = shutDownForQuit({
      flushWindowState: never,
      stopHost: never,
      log,
    });

    await vi.advanceTimersByTimeAsync(WINDOW_STATE_FLUSH_BOUND_MS + HOST_STOP_BOUND_MS);

    await expect(pending).resolves.toEqual({ windowState: "timed-out", host: "timed-out" });
    expect(WINDOW_STATE_FLUSH_BOUND_MS + HOST_STOP_BOUND_MS).toBeLessThan(QUIT_DEADLINE_MS);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("treats a flush or stop that throws synchronously as a failure", async () => {
    const outcome = await shutDownForQuit({
      flushWindowState: () => {
        throw new Error("window destroyed");
      },
      stopHost: () => {
        throw new Error("no server");
      },
      log: vi.fn(),
    });

    expect(outcome).toEqual({ windowState: "failed", host: "failed" });
  });
});

describe("saving window state when a window closes", () => {
  it("returns without raising anything when the save fails or hangs", async () => {
    const log = vi.fn();

    await expect(
      saveWindowStateWithoutBlocking({
        flushWindowState: () => Promise.reject(new Error("read-only volume")),
        log,
      }),
    ).resolves.toBeUndefined();

    const hung = saveWindowStateWithoutBlocking({ flushWindowState: never, log });
    await vi.advanceTimersByTimeAsync(WINDOW_STATE_FLUSH_BOUND_MS);
    await expect(hung).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe("the quit deadline", () => {
  it("ends the app once the bound passes", () => {
    const forceExit = vi.fn();
    armQuitDeadline({ forceExit, boundMs: 1_000 });

    vi.advanceTimersByTime(999);
    expect(forceExit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(forceExit).toHaveBeenCalledOnce();
  });

  it("does nothing once cancelled", () => {
    const forceExit = vi.fn();
    const cancel = armQuitDeadline({ forceExit, boundMs: 1_000 });

    cancel();
    vi.advanceTimersByTime(5_000);

    expect(forceExit).not.toHaveBeenCalled();
  });
});
