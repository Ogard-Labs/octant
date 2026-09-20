import { describe, expect, it } from "vitest";
import { replayedFrom } from "./appleToolchainService";
import { SimulatorInputGrants } from "./simulatorInputGrants";

const desktopWindow = "0d1d6a5c-2c3d-4d0e-9a53-7d0f1cf7f0a1";
const browserWindow = "9a0c4a1b-6f57-4b0e-8f5b-0b7a3f8f6a22";
const thread = "c5b0e039-ee21-40cb-a8b7-7c8d6da68354";
const otherThread = "5265586c-56e8-4b36-a0cd-c8ad5ca0ceb7";
const iphone = "348b3796-90be-4b03-adc1-46d7468c9d43";
const ipad = "319f7fa5-fb03-420d-80c3-714ff475bda4";
const minutes = (n: number) => n * 60_000;

const scope = (simulatorId: string, threadId = thread, windowId = desktopWindow) => ({
  windowId,
  threadId,
  simulatorId,
});
const who = (threadId = thread, windowId = desktopWindow) => ({ windowId, threadId });

describe("Simulator input grants", () => {
  it("opens one Simulator to one window on one thread, and each delivered input keeps it open another fifteen minutes", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    expect(grants.isOpen(scope(iphone))).toBe(false);

    grants.open(scope(iphone));
    expect(grants.isOpen(scope(iphone))).toBe(true);
    expect(grants.isOpen(scope(ipad))).toBe(false);
    expect(grants.isOpen(scope(iphone, otherThread))).toBe(false);

    now = minutes(14);
    grants.renew(scope(iphone));
    now = minutes(28);
    expect(grants.isOpen(scope(iphone))).toBe(true);
    now = minutes(14) + minutes(15);
    expect(grants.isOpen(scope(iphone))).toBe(false);
  });

  it("does not let another window on the same thread ride a grant it was not given", () => {
    const grants = new SimulatorInputGrants(() => 0);
    grants.open(scope(iphone));

    // A browser tab on the same thread and Simulator needs its own approval.
    expect(grants.isOpen(scope(iphone, thread, browserWindow))).toBe(false);
    expect(grants.list(browserWindow, thread)).toEqual([]);

    // Renewing from the other window does not make one either.
    grants.renew(scope(iphone, thread, browserWindow), true);
    expect(grants.isOpen(scope(iphone, thread, browserWindow))).toBe(false);
  });

  it("ends a window's grants with the window, and leaves every other window's alone", () => {
    const grants = new SimulatorInputGrants(() => 0);
    grants.open(scope(iphone));
    grants.open(scope(ipad, otherThread));
    grants.open(scope(iphone, thread, browserWindow));

    grants.revokeWindow(desktopWindow);
    expect(grants.isOpen(scope(iphone))).toBe(false);
    expect(grants.isOpen(scope(ipad, otherThread))).toBe(false);
    expect(grants.isOpen(scope(iphone, thread, browserWindow))).toBe(true);
  });

  it("keeps a grant open for an input the grant admitted that finished just after it ran out", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    const tap = { kind: "tap" as const, simulatorId: iphone };
    grants.open(scope(iphone));

    // Admitted under the live grant, delivered a little past its deadline.
    now = minutes(16);
    expect(grants.isOpen(scope(iphone))).toBe(false);
    grants.afterAction(who(), tap, "succeeded", true);
    now = minutes(30);
    expect(grants.isOpen(scope(iphone))).toBe(true);
  });

  it("does not revive a grant that ran out for an input that was admitted some other way", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    grants.open(scope(iphone));

    // A window with full access sends input: it needed no grant, so it must not make one.
    now = minutes(16);
    grants.afterAction(who(), { kind: "tap", simulatorId: iphone }, "succeeded", false);
    now = minutes(17);
    expect(grants.isOpen(scope(iphone))).toBe(false);
  });

  it("does not keep a grant open just because something looked at it", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    grants.open(scope(iphone));

    // Every request that fails still looks: only a delivered input renews.
    now = minutes(14);
    expect(grants.isOpen(scope(iphone))).toBe(true);
    now = minutes(16);
    expect(grants.isOpen(scope(iphone))).toBe(false);
  });

  it("renews a grant only for an input that was delivered, and closes a Simulator only when it was shut down", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    const tap = { kind: "tap" as const, simulatorId: iphone };
    grants.open(scope(iphone));
    grants.open(scope(iphone, otherThread));

    // A failed input, or anything that is not input, does not keep it open.
    now = minutes(14);
    grants.afterAction(who(), tap, "failed");
    grants.afterAction(who(), { kind: "boot", simulatorId: iphone }, "succeeded");
    now = minutes(16);
    expect(grants.isOpen(scope(iphone))).toBe(false);

    // A delivered input does.
    now = minutes(20);
    grants.open(scope(iphone));
    now = minutes(30);
    grants.afterAction(who(), { ...tap }, "succeeded");
    now = minutes(44);
    expect(grants.isOpen(scope(iphone))).toBe(true);

    // A shutdown that failed leaves the session as it was; one that worked ends it for everyone.
    grants.afterAction(who(), { kind: "shutdown", simulatorId: iphone }, "failed");
    expect(grants.isOpen(scope(iphone))).toBe(true);
    grants.open(scope(iphone, otherThread));
    grants.open(scope(iphone, thread, browserWindow));
    grants.afterAction(who(), { kind: "shutdown", simulatorId: iphone }, "succeeded");
    expect(grants.isOpen(scope(iphone))).toBe(false);
    expect(grants.isOpen(scope(iphone, otherThread))).toBe(false);
    expect(grants.isOpen(scope(iphone, thread, browserWindow))).toBe(false);
  });

  it("settles a finished action for the window and thread it ran on, from the request, its evidence and the context it ran under", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    const evidence = (outcome = "succeeded") => ({ outcome });
    const tap = { kind: "tap", simulatorId: iphone };
    grants.open(scope(iphone));

    // Delivered at ten minutes: the grant now runs to twenty-five.
    now = minutes(10);
    grants.settle(desktopWindow, tap, evidence(), { threadId: thread });
    now = minutes(24);
    expect(grants.isOpen(scope(iphone))).toBe(true);

    // The same request answered again from the service's memory delivered nothing.
    now = minutes(20);
    grants.settle(desktopWindow, tap, replayedFrom(evidence()), { threadId: thread });
    now = minutes(26);
    expect(grants.isOpen(scope(iphone))).toBe(false);

    // A shutdown that worked, run by an agent or a pane alike, closes every window and thread.
    grants.open(scope(iphone));
    grants.open(scope(iphone, otherThread, browserWindow));
    grants.settle(browserWindow, { kind: "shutdown", simulatorId: iphone }, evidence(), {
      threadId: otherThread,
    });
    expect(grants.isOpen(scope(iphone))).toBe(false);
    expect(grants.isOpen(scope(iphone, otherThread, browserWindow))).toBe(false);
  });

  it("closes a Simulator's grants when discovery finds it no longer booted, whoever shut it down", () => {
    const grants = new SimulatorInputGrants(() => 0);
    grants.open(scope(iphone));
    grants.open(scope(iphone, otherThread, browserWindow));
    grants.open(scope(ipad));

    // Shut down from Xcode or `simctl`, so no Octant action saw it end. A
    // later boot is a new device session and asks again.
    grants.closeUnlessBooted([
      { simulatorId: iphone, state: "shutdown" },
      { simulatorId: ipad, state: "booted" },
    ]);
    expect(grants.isOpen(scope(iphone))).toBe(false);
    expect(grants.isOpen(scope(iphone, otherThread, browserWindow))).toBe(false);
    expect(grants.isOpen(scope(ipad))).toBe(true);

    // A Simulator that is still starting up or going down has no session to ride either.
    grants.closeUnlessBooted([{ simulatorId: ipad, state: "shutting-down" }]);
    expect(grants.isOpen(scope(ipad))).toBe(false);
  });

  it("lists a window's live grants on a thread with their expiry for the pane", () => {
    let now = Date.parse("2026-09-19T20:00:00.000Z");
    const grants = new SimulatorInputGrants(
      () => now,
      () => now,
    );
    grants.open(scope(iphone));
    grants.open(scope(ipad, otherThread));
    grants.open(scope(ipad, thread, browserWindow));
    expect(grants.list(desktopWindow, thread)).toEqual([
      { simulatorId: iphone, expiresAt: "2026-09-19T20:15:00.000Z" },
    ]);
    now += minutes(16);
    expect(grants.list(desktopWindow, thread)).toEqual([]);
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
    grants.open(scope(iphone));
    authority += minutes(5);
    wall += minutes(5);
    expect(grants.list(desktopWindow, thread)).toEqual([
      { simulatorId: iphone, expiresAt: "2026-09-19T23:15:00.000Z" },
    ]);
  });
});
