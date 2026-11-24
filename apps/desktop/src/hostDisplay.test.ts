import { describe, expect, it, vi } from "vitest";
import { createHostDisplay } from "./hostDisplay";

describe("personal control of the Mac display", () => {
  it("discards an in-flight frame and ends agent access when the transport disconnects", async () => {
    const frame = Promise.withResolvers<{ status: "host-frame"; jpeg: string; geometry: string }>();
    const display = createHostDisplay({
      available: () => true,
      drainAgentInput: async () => {},
      native: () => frame.promise,
    });
    const paired = { deviceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), generation: 1 };
    const base = { kind: "host-display", threadId: crypto.randomUUID() } as const;
    try {
      const opened = await display.request(paired, { ...base, action: "open" });
      if (opened.status !== "viewing") throw new Error("expected a view");
      const agent = display.agentLifetime(paired.deviceId, base.threadId);
      const transport = new AbortController();
      const pending = display.request(
        paired,
        { ...base, action: "frame", viewId: opened.viewId },
        transport.signal,
      );
      transport.abort();
      expect(agent?.aborted).toBe(true);
      frame.resolve({ status: "host-frame", jpeg: "private", geometry: "main" });
      expect(await pending).toMatchObject({ status: "refused" });
    } finally {
      display.close();
    }
  });
  it("binds frames and input to the device session and thread, and drains queued agent input before handoff", async () => {
    const native = vi.fn(async () => ({ status: "delivered" }) as const);
    const { resolve: finish, promise: draining } = Promise.withResolvers<void>();
    const display = createHostDisplay({
      available: () => true,
      native,
      drainAgentInput: () => draining,
    });
    const paired = { deviceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), generation: 1 };
    const base = { kind: "host-display", threadId: crypto.randomUUID() } as const;
    try {
      const opened = await display.request(paired, { ...base, action: "open" });
      if (opened.status !== "viewing") throw new Error("expected a view");
      const view = { ...base, viewId: opened.viewId };
      const input = {
        ...view,
        action: "input",
        geometry: "screen",
        event: { kind: "click", x: 0.5, y: 0.5 },
      } as const;
      expect(
        await display.request(
          { ...paired, sessionId: crypto.randomUUID() },
          { ...view, action: "frame" },
        ),
      ).toMatchObject({
        status: "refused",
      });
      expect(
        await display.request(paired, {
          ...view,
          threadId: crypto.randomUUID(),
          action: "frame",
        }),
      ).toMatchObject({ status: "refused" });
      const taking = display.request(paired, { ...view, action: "take-control" });
      expect(display.blocksAgent()).toBe(true);
      expect(await display.request(paired, input)).toMatchObject({ status: "refused" });
      expect(native).not.toHaveBeenCalled();
      finish();
      expect(await taking).toEqual({ status: "delivered" });
      expect(await display.request(paired, input)).toEqual({ status: "delivered" });
      expect(await display.request(paired, { ...view, action: "hand-back" })).toEqual({
        status: "delivered",
      });
      expect(display.blocksAgent()).toBe(false);
      expect(await display.request(paired, input)).toMatchObject({ status: "refused" });
      expect(native).toHaveBeenCalledTimes(1);
      display.close();
      expect(await display.request(paired, { ...view, action: "frame" })).toMatchObject({
        reason: "view-ended",
      });
    } finally {
      display.close();
    }
  });
});
