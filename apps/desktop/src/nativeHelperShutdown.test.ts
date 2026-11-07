import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createNativeHelperShutdown } from "./nativeHelperShutdown";

function childEvents() {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    pid: 123,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  const lifetime = createNativeHelperShutdown({
    child,
    closeGracefully: vi.fn(),
    gracefulMs: 0,
    terminateMs: 5,
    killMs: 5,
  });
  return { events, child, lifetime };
}

describe("native helper shutdown evidence", () => {
  it("settles on exit, tolerates a late IPC error and releases its error guard when channels close", async () => {
    const { events, child, lifetime } = childEvents();
    const stopping = lifetime.stop();
    events.emit("exit");
    await expect(stopping).resolves.toEqual({ status: "stopped" });
    expect(() => events.emit("error", new Error("late IPC write"))).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
    events.emit("close");
    expect(events.listenerCount("exit")).toBe(0);
    expect(events.listenerCount("error")).toBe(0);
    expect(events.listenerCount("close")).toBe(0);
    await expect(lifetime.exited).resolves.toBeUndefined();
  });

  it("reports unconfirmed exit after escalation and still observes a later exit", async () => {
    const { events, child, lifetime } = childEvents();
    await expect(lifetime.stop()).resolves.toEqual({
      status: "failed",
      reason: "exit-not-confirmed",
    });
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(lifetime.state()).toBe("stopping");
    events.emit("exit");
    events.emit("close");
    await lifetime.exited;
    expect(lifetime.state()).toBe("exited");
  });
});
