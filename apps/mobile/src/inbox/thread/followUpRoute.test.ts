import { describe, expect, it } from "vitest";
import { followUpRoute } from "./followUpRoute";

describe("where the phone sends a follow-up", () => {
  it("queues a Work or Code follow-up while a turn runs, and sends it otherwise", () => {
    expect(followUpRoute({ mode: "work", turnLive: true, queueing: false })).toBe("queue");
    expect(followUpRoute({ mode: "code", turnLive: true, queueing: false })).toBe("queue");
    expect(followUpRoute({ mode: "code", turnLive: false, queueing: false })).toBe("send");
  });

  it("never queues a Chat message", () => {
    expect(followUpRoute({ mode: "chat", turnLive: true, queueing: false })).toBe("send");
  });

  it("offers no send while a follow-up is still joining the queue", () => {
    expect(followUpRoute({ mode: "work", turnLive: true, queueing: true })).toBe("wait");
  });
});
