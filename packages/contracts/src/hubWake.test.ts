import { describe, expect, it } from "vitest";
import {
  decodeHubWakeCopy,
  decodeHubWakeHardwareAddressRequest,
  decodeHubWakeNudge,
  decodeHubWakeNudgeAnswer,
  decodeHubWakeReport,
} from "./hubWake";

const routineId = "AbCdEfGhIjKlMnOpQrStUv";
const nextAt = "2026-10-29T08:00:00.000Z";

describe("hub wake wire shapes", () => {
  it("decodes a report of opaque ids and times, with an address only when one was entered", () => {
    expect(decodeHubWakeReport({ times: [{ routineId, nextAt }] }).times).toHaveLength(1);
    expect(
      decodeHubWakeReport({ times: [], hardwareAddress: "aa:bb:cc:dd:ee:ff" }).hardwareAddress,
    ).toBe("aa:bb:cc:dd:ee:ff");
    expect(() => decodeHubWakeReport({ times: [], hardwareAddress: "AA-BB" })).toThrow();
  });

  it("refuses any field that could carry routine content", () => {
    for (const extra of ["prompt", "projectId", "profileId", "name", "schedule", "memberId"]) {
      expect(() => decodeHubWakeReport({ times: [{ routineId, nextAt }], [extra]: "x" })).toThrow();
      expect(() => decodeHubWakeReport({ times: [{ routineId, nextAt, [extra]: "x" }] })).toThrow();
    }
  });

  it("refuses a routine id that could be a real routine's own id or a repeat", () => {
    expect(() => decodeHubWakeReport({ times: [{ routineId: "short", nextAt }] })).toThrow();
    expect(() =>
      decodeHubWakeReport({
        times: [
          { routineId, nextAt },
          { routineId, nextAt },
        ],
      }),
    ).toThrow();
  });

  it("decodes a nudge that names only an id and a time, and the two answers to it", () => {
    expect(decodeHubWakeNudge({ routineId, occurrenceAt: nextAt }).routineId).toBe(routineId);
    expect(() => decodeHubWakeNudge({ routineId, occurrenceAt: nextAt, run: true })).toThrow();
    expect(decodeHubWakeNudgeAnswer({ status: "accepted" })).toEqual({ status: "accepted" });
    expect(decodeHubWakeNudgeAnswer({ status: "ignored", kind: "too-early" }).status).toBe(
      "ignored",
    );
    expect(() => decodeHubWakeNudgeAnswer({ status: "ignored", kind: "started" })).toThrow();
  });

  it("decodes the copy a standby holds and the address a person enters or clears", () => {
    expect(decodeHubWakeCopy({ spokes: [] }).spokes).toEqual([]);
    // A copy from a hub that predates the switch carries none, and a standby reads that as off.
    expect(decodeHubWakeCopy({ spokes: [] }).enabled).toBeUndefined();
    expect(decodeHubWakeCopy({ enabled: true, spokes: [] }).enabled).toBe(true);
    expect(decodeHubWakeHardwareAddressRequest({ address: null }).address).toBeNull();
    expect(() => decodeHubWakeHardwareAddressRequest({})).toThrow();
  });
});
