import { describe, expect, it } from "vitest";
import { replayedFrom } from "./appleToolchainService";
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

  it("keeps a grant open for an input the grant admitted that finished just after it ran out", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    const tap = { kind: "tap" as const, simulatorId: iphone };
    grants.open(thread, iphone);

    // Admitted under the live grant, delivered a little past its deadline.
    now = minutes(16);
    expect(grants.isOpen(thread, iphone)).toBe(false);
    grants.afterAction(thread, tap, "succeeded", true);
    now = minutes(30);
    expect(grants.isOpen(thread, iphone)).toBe(true);
  });

  it("does not revive a grant that ran out for an input that was admitted some other way", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    grants.open(thread, iphone);

    // A window with full access sends input: it needed no grant, so it must not make one.
    now = minutes(16);
    grants.afterAction(thread, { kind: "tap", simulatorId: iphone }, "succeeded", false);
    now = minutes(17);
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
    const tap = { kind: "tap" as const, simulatorId: iphone };
    grants.open(thread, iphone);
    grants.open(otherThread, iphone);

    // A failed input, or anything that is not input, does not keep it open.
    now = minutes(14);
    grants.afterAction(thread, tap, "failed");
    grants.afterAction(thread, { kind: "boot", simulatorId: iphone }, "succeeded");
    now = minutes(16);
    expect(grants.isOpen(thread, iphone)).toBe(false);

    // A delivered input does.
    now = minutes(20);
    grants.open(thread, iphone);
    now = minutes(30);
    grants.afterAction(thread, { ...tap }, "succeeded");
    now = minutes(44);
    expect(grants.isOpen(thread, iphone)).toBe(true);

    // A shutdown that failed leaves the session as it was; one that worked ends it for everyone.
    grants.afterAction(thread, { kind: "shutdown", simulatorId: iphone }, "failed");
    expect(grants.isOpen(thread, iphone)).toBe(true);
    grants.open(otherThread, iphone);
    grants.afterAction(thread, { kind: "shutdown", simulatorId: iphone }, "succeeded");
    expect(grants.isOpen(thread, iphone)).toBe(false);
    expect(grants.isOpen(otherThread, iphone)).toBe(false);
  });

  it("settles a finished action for the thread it ran on, from the request, its evidence and the context it ran under", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    const evidence = (completedAt: string, outcome = "succeeded") => ({ outcome, completedAt });
    const at = (minute: number) => new Date(minutes(minute)).toISOString();
    const tap = { kind: "tap", simulatorId: iphone };
    grants.open(thread, iphone);

    // Delivered at ten minutes: the grant now runs to twenty-five.
    now = minutes(10);
    grants.settle(tap, evidence(at(10)), { threadId: thread });
    now = minutes(24);
    expect(grants.isOpen(thread, iphone)).toBe(true);

    // The same request answered again from the service's memory delivered nothing.
    now = minutes(20);
    grants.settle(tap, replayedFrom(evidence(at(10))), { threadId: thread });
    now = minutes(26);
    expect(grants.isOpen(thread, iphone)).toBe(false);

    // A shutdown that worked, run by an agent or a pane alike, closes every thread.
    grants.open(thread, iphone);
    grants.open(otherThread, iphone);
    grants.settle({ kind: "shutdown", simulatorId: iphone }, evidence(at(26)), {
      threadId: otherThread,
    });
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
    const grants = new SimulatorInputGrants(
      () => now,
      () => now,
    );
    grants.open(thread, iphone);
    grants.open(otherThread, ipad);
    expect(grants.list(thread)).toEqual([
      { simulatorId: iphone, expiresAt: "2026-09-19T20:15:00.000Z" },
    ]);
    now += minutes(16);
    expect(grants.list(thread)).toEqual([]);
  });

  it("tells the pane when a grant ends by the pane's own clock, even after the host's clock fell behind while the machine slept", () => {
    // The host's authority clock does not run while the machine sleeps, so it
    // can trail the wall clock by hours. The pane compares expiry to its wall
    // clock, so an expiry reported in the host's time would read as long over.
    let authority = 0;
    let wall = Date.parse("2026-09-19T23:00:00.000Z");
    const grants = new SimulatorInputGrants(
      () => authority,
      () => wall,
    );
    grants.open(thread, iphone);
    authority += minutes(5);
    wall += minutes(5);
    expect(grants.list(thread)).toEqual([
      { simulatorId: iphone, expiresAt: "2026-09-19T23:15:00.000Z" },
    ]);
  });
});
