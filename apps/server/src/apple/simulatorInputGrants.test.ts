import { describe, expect, it } from "vitest";
import { SimulatorInputGrants } from "./simulatorInputGrants";

const thread = "c5b0e039-ee21-40cb-a8b7-7c8d6da68354";
const otherThread = "5265586c-56e8-4b36-a0cd-c8ad5ca0ceb7";
const iphone = "348b3796-90be-4b03-adc1-46d7468c9d43";
const ipad = "319f7fa5-fb03-420d-80c3-714ff475bda4";
const minutes = (n: number) => n * 60_000;

describe("Simulator input grants", () => {
  it("opens one Simulator on one thread, and each input keeps it open another fifteen minutes", () => {
    let now = 0;
    const grants = new SimulatorInputGrants(() => now);
    expect(grants.use(thread, iphone)).toBe(false);

    grants.open(thread, iphone);
    expect(grants.use(thread, iphone)).toBe(true);
    expect(grants.use(thread, ipad)).toBe(false);
    expect(grants.use(otherThread, iphone)).toBe(false);

    now = minutes(14);
    expect(grants.use(thread, iphone)).toBe(true);
    now = minutes(28);
    expect(grants.use(thread, iphone)).toBe(true);
    now = minutes(28) + minutes(15);
    expect(grants.use(thread, iphone)).toBe(false);
    // An expired grant is gone, not revived by a later look.
    now = minutes(28);
    expect(grants.use(thread, iphone)).toBe(false);
  });

  it("closes a Simulator for every thread when it shuts down, and a thread's grants when the thread loses them", () => {
    const grants = new SimulatorInputGrants(() => 0);
    grants.open(thread, iphone);
    grants.open(otherThread, iphone);
    grants.open(thread, ipad);

    grants.revokeSimulator(iphone);
    expect(grants.use(thread, iphone)).toBe(false);
    expect(grants.use(otherThread, iphone)).toBe(false);
    expect(grants.use(thread, ipad)).toBe(true);

    grants.revokeThread(thread);
    expect(grants.use(thread, ipad)).toBe(false);
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
