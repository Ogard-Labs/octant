import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_STOP_BOUND_MS,
  QUIT_DEADLINE_MS,
  WINDOW_STATE_FLUSH_BOUND_MS,
  armQuitDeadline,
  quitAfterStartupFailure,
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

describe("quitting after a start-up that cannot proceed", () => {
  const startupFailure = (showFailure: () => Promise<void>) => {
    const order: string[] = [];
    let requestQuit: (() => void) | undefined;
    let release: () => void = () => undefined;
    const pending = quitAfterStartupFailure({
      message: "Octant storage did not become ready within 60000ms.",
      log: (message) => void order.push(`log: ${message}`),
      showFailure: async () => {
        order.push("shown");
        await showFailure();
        order.push("dismissed");
      },
      shutDown: () => {
        order.push("releasing");
        return new Promise<void>((resolve) => {
          release = () => {
            order.push("released");
            resolve();
          };
        });
      },
      onQuitRequested: (quit) => {
        requestQuit = quit;
      },
      armDeadline: () => void order.push("deadline"),
      finish: () => void order.push("finished"),
    });
    return {
      order,
      pending,
      requestQuit: () => requestQuit?.(),
      release: () => release(),
    };
  };

  it("logs the reason and releases the failed start before showing it, then quits on dismissal", async () => {
    const run = startupFailure(async () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.order).toEqual([
      "log: Octant could not start: Octant storage did not become ready within 60000ms.",
      "releasing",
    ]);

    run.release();
    await run.pending;

    expect(run.order.slice(2)).toEqual(["released", "shown", "dismissed", "deadline", "finished"]);
  });

  it("quits without showing the failure when a signal arrives while it is being released", async () => {
    const run = startupFailure(never);
    run.requestQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.order).not.toContain("finished");

    run.release();
    await run.pending;

    expect(run.order).not.toContain("shown");
    expect(run.order.slice(-2)).toEqual(["deadline", "finished"]);
  });

  it("quits on a signal while the failure is shown without waiting for dismissal", async () => {
    const run = startupFailure(never);
    run.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.order.at(-1)).toBe("shown");

    run.requestQuit();
    run.requestQuit();

    expect(run.order.slice(-2)).toEqual(["deadline", "finished"]);
    expect(run.order.filter((step) => step === "finished")).toHaveLength(1);
  });

  it("ends the app once when a signal arrives and the failure is then dismissed", async () => {
    let dismiss: () => void = () => undefined;
    const run = startupFailure(() => new Promise<void>((resolve) => (dismiss = resolve)));
    run.release();
    await vi.advanceTimersByTimeAsync(0);
    run.requestQuit();
    dismiss();
    await run.pending;

    expect(run.order.filter((step) => step === "finished")).toHaveLength(1);
    expect(run.order.filter((step) => step === "deadline")).toHaveLength(1);
  });

  it("still ends the app when the failure cannot be shown", async () => {
    const run = startupFailure(() => Promise.reject(new Error("no display")));
    run.release();
    await run.pending;

    expect(run.order).toContain("log: Octant could not show why it did not start.");
    expect(run.order.at(-1)).toBe("finished");
  });
});
