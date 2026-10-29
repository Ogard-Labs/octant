import { describe, expect, it } from "vitest";
import {
  buildWakeOnLanPacket,
  decideWakeNudge,
  normalizeHardwareAddress,
  wakeIsDue,
} from "./hubWakePolicy";

describe("hardware addresses", () => {
  it("accepts colon and dash forms in either case and writes one canonical form", () => {
    expect(normalizeHardwareAddress("AA:bb:0C:0d:0E:0f")).toBe("aa:bb:0c:0d:0e:0f");
    expect(normalizeHardwareAddress(" aa-bb-0c-0d-0e-0f ")).toBe("aa:bb:0c:0d:0e:0f");
  });

  it("refuses text that is not six hex pairs", () => {
    for (const text of [
      "",
      "aa:bb:cc",
      "aa:bb:cc:dd:ee:ff:00",
      "gg:bb:cc:dd:ee:ff",
      "aabbccddeeff",
    ]) {
      expect(normalizeHardwareAddress(text)).toBeUndefined();
    }
  });
});

describe("the magic packet", () => {
  it("is six 0xFF bytes followed by the address sixteen times", () => {
    const packet = buildWakeOnLanPacket("01:23:45:67:89:ab");
    expect(packet).toBeDefined();
    if (packet === undefined) return;
    expect(packet).toHaveLength(102);
    expect(Array.from(packet.slice(0, 6))).toEqual([255, 255, 255, 255, 255, 255]);
    for (let repeat = 0; repeat < 16; repeat += 1) {
      expect(Array.from(packet.slice(6 + repeat * 6, 12 + repeat * 6))).toEqual([
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
      ]);
    }
  });

  it("is not built for text that is not an address", () => {
    expect(buildWakeOnLanPacket("not-an-address")).toBeUndefined();
  });
});

describe("believing a nudge", () => {
  const base = {
    ownNextDueAtMs: 1_000_000,
    occurrenceAtMs: 1_000_000,
    nowMs: 990_000,
    matchWindowMs: 60_000,
    maxLeadMs: 600_000,
  };

  it("accepts the spoke's own next occurrence when it is near", () => {
    expect(decideWakeNudge(base)).toEqual({ status: "accept" });
    expect(decideWakeNudge({ ...base, occurrenceAtMs: 1_030_000 })).toEqual({ status: "accept" });
  });

  it("ignores an occurrence that is not the spoke's own next one", () => {
    expect(decideWakeNudge({ ...base, occurrenceAtMs: 1_200_000 })).toEqual({
      status: "ignore",
      kind: "time-mismatch",
    });
  });

  it("ignores a nudge that comes long before the occurrence", () => {
    expect(decideWakeNudge({ ...base, nowMs: 100_000 })).toEqual({
      status: "ignore",
      kind: "too-early",
    });
  });
});

describe("when the hub wakes", () => {
  const base = { occurrenceAtMs: 1_000_000, leadMs: 120_000, staleAfterMs: 600_000 };

  it("starts at the lead time and ends once the occurrence is long past", () => {
    expect(wakeIsDue({ ...base, nowMs: 879_999 })).toBe(false);
    expect(wakeIsDue({ ...base, nowMs: 880_000 })).toBe(true);
    expect(wakeIsDue({ ...base, nowMs: 1_600_000 })).toBe(true);
    expect(wakeIsDue({ ...base, nowMs: 1_600_001 })).toBe(false);
  });
});
