import { describe, expect, it, vi } from "vitest";
import {
  MAX_WAITING_OFFERS,
  MAX_WAITING_OFFERS_IN_ALL,
  createThreadImageOffers,
  type ThreadImageVerdict,
} from "./threadImageOffers";

const file = (name: string) => new File(["x"], name, { type: "image/png" });
const accepted: ThreadImageVerdict = { status: "accepted" };

describe("pictures offered to a thread's message", () => {
  it("hands a picture straight to the composer that is open and reports that it was added", async () => {
    const offers = createThreadImageOffers();
    const taken = vi.fn(() => accepted);
    offers.subscribe("code:t1", taken);
    await expect(offers.offer("code:t1", file("a.png"))).resolves.toEqual({ status: "added" });
    expect(taken).toHaveBeenCalledWith(expect.objectContaining({ name: "a.png" }), "live");
  });

  it("reports the composer's own refusal, waiting for an asynchronous answer", async () => {
    const offers = createThreadImageOffers();
    offers.subscribe("code:t1", async () => ({ status: "refused", reason: "No vision model." }));
    await expect(offers.offer("code:t1", file("a.png"))).resolves.toEqual({
      status: "refused",
      reason: "No vision model.",
    });
  });

  it("reports a refusal when the composer fails instead of answering", async () => {
    const offers = createThreadImageOffers();
    offers.subscribe("code:t1", () => Promise.reject(new Error("boom")));
    await expect(offers.offer("code:t1", file("a.png"))).resolves.toMatchObject({
      status: "refused",
    });
  });

  it("keeps a picture for a thread whose composer is not open until one opens", async () => {
    const offers = createThreadImageOffers();
    await expect(offers.offer("code:t1", file("a.png"))).resolves.toEqual({ status: "waiting" });
    const taken = vi.fn(() => accepted);
    offers.subscribe("code:t1", taken);
    expect(taken).toHaveBeenCalledOnce();
    expect(taken).toHaveBeenCalledWith(expect.objectContaining({ name: "a.png" }), "waiting");
    const second = vi.fn(() => accepted);
    offers.subscribe("code:t1", second);
    expect(second).not.toHaveBeenCalled();
  });

  it("never gives one thread's picture to another thread or mode", async () => {
    const offers = createThreadImageOffers();
    const other = vi.fn(() => accepted);
    offers.subscribe("code:t2", other);
    offers.subscribe("work:t1", other);
    await offers.offer("code:t1", file("a.png"));
    expect(other).not.toHaveBeenCalled();
  });

  it("gives a picture to one composer when two are open for the thread", async () => {
    const offers = createThreadImageOffers();
    const first = vi.fn(() => accepted);
    const second = vi.fn(() => accepted);
    offers.subscribe("work:t1", first);
    offers.subscribe("work:t1", second);
    await offers.offer("work:t1", file("a.png"));
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("holds at most a handful of waiting pictures per thread", async () => {
    const offers = createThreadImageOffers();
    for (let index = 0; index < MAX_WAITING_OFFERS; index += 1) {
      await expect(offers.offer("code:t1", file(`${String(index)}.png`))).resolves.toEqual({
        status: "waiting",
      });
    }
    await expect(offers.offer("code:t1", file("extra.png"))).resolves.toEqual({ status: "full" });
    await expect(offers.offer("code:t2", file("other.png"))).resolves.toEqual({
      status: "waiting",
    });
  });

  it("holds a bounded number of waiting pictures in all, dropping the oldest first", async () => {
    const offers = createThreadImageOffers();
    const total = MAX_WAITING_OFFERS_IN_ALL + 3;
    for (let index = 0; index < total; index += 1) {
      // Two pictures per thread, so no single thread reaches its own limit.
      await offers.offer(`code:t${String(Math.floor(index / 2))}`, file(`${String(index)}.png`));
    }
    const names: string[] = [];
    for (let thread = 0; thread < Math.ceil(total / 2); thread += 1) {
      offers.subscribe(`code:t${String(thread)}`, (picture) => {
        names.push(picture.name);
        return accepted;
      });
    }
    expect(names).toHaveLength(MAX_WAITING_OFFERS_IN_ALL);
    expect(names).not.toContain("0.png");
    expect(names).not.toContain("2.png");
    expect(names).toContain(`${String(total - 1)}.png`);
  });

  it("waits again once the composer has closed", async () => {
    const offers = createThreadImageOffers();
    const unsubscribe = offers.subscribe("code:t1", () => accepted);
    unsubscribe();
    await expect(offers.offer("code:t1", file("a.png"))).resolves.toEqual({ status: "waiting" });
  });
});
