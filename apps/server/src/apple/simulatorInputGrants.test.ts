import { describe, expect, it } from "vitest";
import { SimulatorInputGrants } from "./simulatorInputGrants";

const thread = "c5b0e039-ee21-40cb-a8b7-7c8d6da68354";
const otherThread = "5265586c-56e8-4b36-a0cd-c8ad5ca0ceb7";
const iphone = "348b3796-90be-4b03-adc1-46d7468c9d43";
const ipad = "319f7fa5-fb03-420d-80c3-714ff475bda4";
const minutes = (n: number) => n * 60_000;

describe("Simulator input grants", () => {
  it("opens one Simulator on one thread, and each delivered input keeps it open another fifteen minutes", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    expect(grants.isOpen(thread, iphone)).toBe(false);

    grants.open(thread, iphone);
    expect(grants.isOpen(thread, iphone)).toBe(true);
    expect(grants.isOpen(thread, ipad)).toBe(false);
    expect(grants.isOpen(otherThread, iphone)).toBe(false);

    now = minutes(14);
    grants.renew(thread, iphone);
    now = minutes(28);
    expect(grants.isOpen(thread, iphone)).toBe(true);
    now = minutes(14) + minutes(15);
    expect(grants.isOpen(thread, iphone)).toBe(false);
  });

  it("keeps a grant open for an input that finished just after it ran out, and not for one that finished long after", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    const tap = { kind: "tap" as const, simulatorId: iphone };

    // Authorized under the live grant, delivered a little past its deadline.
    grants.open(thread, iphone);
    now = minutes(16);
    expect(grants.isOpen(thread, iphone)).toBe(false);
    grants.afterAction(thread, { ...tap, actionId: "a1" }, "succeeded");
    now = minutes(30);
    expect(grants.isOpen(thread, iphone)).toBe(true);

    // No input runs longer than ten minutes, so nothing that finishes later
    // than that after the deadline was authorized under it.
    grants.open(otherThread, iphone);
    now = minutes(30) + minutes(15) + minutes(11);
    grants.afterAction(otherThread, { ...tap, actionId: "a2" }, "succeeded");
    expect(grants.isOpen(otherThread, iphone)).toBe(false);
  });

  it("renews nothing when the same request is answered again from what was stored", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    const tap = { kind: "tap" as const, simulatorId: iphone, actionId: "a1" };
    grants.open(thread, iphone);

    now = minutes(10);
    grants.afterAction(thread, tap, "succeeded");
    // A client retries the finished request: the answer is the stored one and
    // nothing was delivered, so it must not keep the grant alive.
    now = minutes(20);
    grants.afterAction(thread, tap, "succeeded");
    now = minutes(26);
    expect(grants.isOpen(thread, iphone)).toBe(false);
  });

  it("does not keep a grant open just because something looked at it", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    grants.open(thread, iphone);

    // Every request that fails still looks: only a delivered input renews.
    now = minutes(14);
    expect(grants.isOpen(thread, iphone)).toBe(true);
    now = minutes(16);
    expect(grants.isOpen(thread, iphone)).toBe(false);
  });

  it("renews a grant only for an input that was delivered, and closes a Simulator only when it was shut down", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    const tap = { kind: "tap" as const, simulatorId: iphone, actionId: "t1" };
    grants.open(thread, iphone);
    grants.open(otherThread, iphone);

    // A failed input, or anything that is not input, does not keep it open.
    now = minutes(14);
    grants.afterAction(thread, tap, "failed");
    grants.afterAction(thread, { kind: "boot", simulatorId: iphone, actionId: "b1" }, "succeeded");
    now = minutes(16);
    expect(grants.isOpen(thread, iphone)).toBe(false);

    // A delivered input does.
    now = minutes(20);
    grants.open(thread, iphone);
    now = minutes(30);
    grants.afterAction(thread, { ...tap, actionId: "t2" }, "succeeded");
    now = minutes(44);
    expect(grants.isOpen(thread, iphone)).toBe(true);

    // A shutdown that failed leaves the session as it was; one that worked ends it for everyone.
    grants.afterAction(thread, { kind: "shutdown", simulatorId: iphone, actionId: "s1" }, "failed");
    expect(grants.isOpen(thread, iphone)).toBe(true);
    grants.open(otherThread, iphone);
    grants.afterAction(
      thread,
      { kind: "shutdown", simulatorId: iphone, actionId: "s2" },
      "succeeded",
    );
    expect(grants.isOpen(thread, iphone)).toBe(false);
    expect(grants.isOpen(otherThread, iphone)).toBe(false);
  });

  it("closes a Simulator for every thread when it shuts down, and a thread's grants when the thread loses them", () => {
    const grants = new SimulatorInputGrants(() => 0);
    grants.open(thread, iphone);
    grants.open(otherThread, iphone);
    grants.open(thread, ipad);

    grants.revokeSimulator(iphone);
    expect(grants.isOpen(thread, iphone)).toBe(false);
    expect(grants.isOpen(otherThread, iphone)).toBe(false);
    expect(grants.isOpen(thread, ipad)).toBe(true);

    grants.revokeThread(thread);
    expect(grants.isOpen(thread, ipad)).toBe(false);
  });

  it("lists a thread's live grants with their expiry for the pane", () => {
    let now = Date.parse("2026-09-19T20:00:00.000Z");
    const grants = new SimulatorInputGrants(() => now);
    grants.open(thread, iphone);
    grants.open(otherThread, ipad);
    expect(grants.list(thread)).toEqual([
      { simulatorId: iphone, expiresAt: "2026-09-19T20:15:00.000Z" },
    ]);
    now += minutes(16);
    expect(grants.list(thread)).toEqual([]);
  });
});
