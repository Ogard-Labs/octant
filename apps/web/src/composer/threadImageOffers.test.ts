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
    // A thread's second picture is handed over once its first was answered.
    await vi.waitFor(() => expect(names).toHaveLength(MAX_WAITING_OFFERS_IN_ALL));
    expect(names).not.toContain("0.png");
    expect(names).not.toContain("2.png");
    expect(names).toContain(`${String(total - 1)}.png`);
  });

  it("hands pictures to the composer one at a time, each after the last was answered", async () => {
    const offers = createThreadImageOffers();
    await offers.offer("code:t1", file("a.png"));
    await offers.offer("code:t1", file("b.png"));
    const answers: Array<(verdict: ThreadImageVerdict) => void> = [];
    const taken = vi.fn(
      (_file: File) =>
        new Promise<ThreadImageVerdict>((resolve) => {
          answers.push(resolve);
        }),
    );
    offers.subscribe("code:t1", taken);
    expect(taken).toHaveBeenCalledOnce();
    // A picture offered while the first is still being attached waits its turn too.
    const live = offers.offer("code:t1", file("c.png"));
    await Promise.resolve();
    expect(taken).toHaveBeenCalledOnce();
    answers[0]?.(accepted);
    await vi.waitFor(() => expect(taken).toHaveBeenCalledTimes(2));
    expect(taken.mock.calls[1]?.[0]).toMatchObject({ name: "b.png" });
    answers[1]?.(accepted);
    await vi.waitFor(() => expect(taken).toHaveBeenCalledTimes(3));
    expect(taken.mock.calls[2]?.[0]).toMatchObject({ name: "c.png" });
    answers[2]?.(accepted);
    await expect(live).resolves.toEqual({ status: "added" });
  });

  it("keeps the pictures a composer had not reached when it closes", async () => {
    const offers = createThreadImageOffers();
    await offers.offer("code:t1", file("a.png"));
    await offers.offer("code:t1", file("b.png"));
    let answer: (verdict: ThreadImageVerdict) => void = () => undefined;
    const first = vi.fn(
      (_file: File) =>
        new Promise<ThreadImageVerdict>((resolve) => {
          answer = resolve;
        }),
    );
    const close = offers.subscribe("code:t1", first);
    close();
    answer(accepted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first).toHaveBeenCalledOnce();
    const next = vi.fn(() => accepted);
    offers.subscribe("code:t1", next);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: "b.png" }), "waiting");
  });

  it("waits again once the composer has closed", async () => {
    const offers = createThreadImageOffers();
    const unsubscribe = offers.subscribe("code:t1", () => accepted);
    unsubscribe();
    await expect(offers.offer("code:t1", file("a.png"))).resolves.toEqual({ status: "waiting" });
  });
});
