import { describe, expect, it, vi } from "vitest";
import { MAX_WAITING_OFFERS, createThreadImageOffers } from "./threadImageOffers";

const file = (name: string) => new File(["x"], name, { type: "image/png" });

describe("pictures offered to a thread's message", () => {
  it("hands a picture straight to the composer that is open for that thread", () => {
    const offers = createThreadImageOffers();
    const taken = vi.fn();
    offers.subscribe("code:t1", taken);
    expect(offers.offer("code:t1", file("a.png"))).toBe("taken");
    expect(taken).toHaveBeenCalledWith(expect.objectContaining({ name: "a.png" }), "live");
  });

  it("keeps a picture for a thread whose composer is not open until one opens", () => {
    const offers = createThreadImageOffers();
    expect(offers.offer("code:t1", file("a.png"))).toBe("waiting");
    const taken = vi.fn();
    offers.subscribe("code:t1", taken);
    expect(taken).toHaveBeenCalledOnce();
    expect(taken).toHaveBeenCalledWith(expect.objectContaining({ name: "a.png" }), "waiting");
    const second = vi.fn();
    offers.subscribe("code:t1", second);
    expect(second).not.toHaveBeenCalled();
  });

  it("never gives one thread's picture to another thread or mode", () => {
    const offers = createThreadImageOffers();
    const other = vi.fn();
    offers.subscribe("code:t2", other);
    offers.subscribe("work:t1", other);
    offers.offer("code:t1", file("a.png"));
    expect(other).not.toHaveBeenCalled();
  });

  it("gives a picture to one composer when two are open for the thread", () => {
    const offers = createThreadImageOffers();
    const first = vi.fn();
    const second = vi.fn();
    offers.subscribe("work:t1", first);
    offers.subscribe("work:t1", second);
    offers.offer("work:t1", file("a.png"));
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("holds at most a handful of waiting pictures per thread", () => {
    const offers = createThreadImageOffers();
    for (let index = 0; index < MAX_WAITING_OFFERS; index += 1) {
      expect(offers.offer("code:t1", file(`${String(index)}.png`))).toBe("waiting");
    }
    expect(offers.offer("code:t1", file("extra.png"))).toBe("full");
    expect(offers.offer("code:t2", file("other.png"))).toBe("waiting");
  });

  it("waits again once the composer has closed", () => {
    const offers = createThreadImageOffers();
    const unsubscribe = offers.subscribe("code:t1", vi.fn());
    unsubscribe();
    expect(offers.offer("code:t1", file("a.png"))).toBe("waiting");
  });
});
