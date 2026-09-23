import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForReconnect } from "./waitForReconnect";

describe("waitForReconnect", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitForReconnect(controller.signal, 10_000)).resolves.toBeUndefined();
  });

  it("resolves early when the signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = waitForReconnect(controller.signal, 10_000);

    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
