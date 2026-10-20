import { describe, expect, it } from "vitest";
import { createPollGuard } from "./pollGuard";

describe("poll guard", () => {
  it("skips a timer tick while a request is still in flight", () => {
    const guard = createPollGuard();
    const first = guard.start();
    expect(first).toBeDefined();
    expect(guard.start()).toBeUndefined();
    if (first !== undefined) expect(guard.finish(first)).toBe(true);
    expect(guard.start()).toBeDefined();
  });

  it("lets a forced reload overlap and discards the older answer", () => {
    const guard = createPollGuard();
    const older = guard.start();
    const newer = guard.start({ force: true });
    expect(older).toBeDefined();
    expect(newer).toBeDefined();
    if (older === undefined || newer === undefined) return;
    expect(guard.finish(older)).toBe(false);
    // The older answer must not free the slot the newer request still holds.
    expect(guard.start()).toBeUndefined();
    expect(guard.finish(newer)).toBe(true);
  });

  it("ignores answers and refuses new requests after dispose", () => {
    const guard = createPollGuard();
    const ticket = guard.start();
    guard.dispose();
    if (ticket !== undefined) expect(guard.finish(ticket)).toBe(false);
    expect(guard.start({ force: true })).toBeUndefined();
  });
});
