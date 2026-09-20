import { describe, expect, it } from "vitest";
import {
  decodeSimulatorDeviceInput,
  decodeSimulatorDeviceInputResult,
  decodeSimulatorDeviceWatch,
} from "./simulatorDevice";

const udid = "7E29846E-F920-438E-8AB2-930C1A0F7FB7";

describe("Simulator device input", () => {
  it("accepts a tap, typed text and a key for one Simulator", () => {
    expect(
      decodeSimulatorDeviceInput({
        kind: "tap",
        udid,
        budgetMs: 30_000,
        point: { x: 603, y: 1311 },
      }),
    ).toMatchObject({ kind: "tap" });
    expect(
      decodeSimulatorDeviceInput({ kind: "type-text", udid, budgetMs: 30_000, text: "Octant 42" }),
    ).toMatchObject({ kind: "type-text" });
    expect(
      decodeSimulatorDeviceInput({ kind: "key-press", udid, budgetMs: 30_000, key: "home" }),
    ).toMatchObject({ kind: "key-press" });
  });

  it("refuses a destination that is not a Simulator identifier", () => {
    expect(() =>
      decodeSimulatorDeviceInput({
        kind: "key-press",
        udid: "--set /tmp/devices",
        budgetMs: 30_000,
        key: "home",
      }),
    ).toThrow();
  });

  it("refuses a point off the screen's origin side, an empty text, and unknown fields", () => {
    expect(() =>
      decodeSimulatorDeviceInput({ kind: "tap", udid, budgetMs: 30_000, point: { x: -1, y: 4 } }),
    ).toThrow();
    expect(() =>
      decodeSimulatorDeviceInput({ kind: "type-text", udid, budgetMs: 30_000, text: "" }),
    ).toThrow();
    expect(() =>
      decodeSimulatorDeviceInput({
        kind: "key-press",
        udid,
        budgetMs: 30_000,
        key: "home",
        window: "Simulator",
      }),
    ).toThrow();
  });

  it("tells a helper's refusal from a helper that never answered", () => {
    expect(decodeSimulatorDeviceInputResult({ kind: "delivered" })).toEqual({ kind: "delivered" });
    expect(
      decodeSimulatorDeviceInputResult({
        kind: "refused",
        reason: "not-booted",
        message: "the Simulator is Shutdown",
      }).kind,
    ).toBe("refused");
    expect(
      decodeSimulatorDeviceInputResult({
        kind: "unavailable",
        reason: "helper-unavailable",
        message: "The device helper did not answer in time.",
      }).kind,
    ).toBe("unavailable");
  });

  it("bounds what a viewer may ask of the screen stream", () => {
    const watch = { udid, maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 };
    expect(decodeSimulatorDeviceWatch(watch)).toEqual(watch);
    expect(() => decodeSimulatorDeviceWatch({ ...watch, framesPerSecond: 240 })).toThrow();
    expect(() => decodeSimulatorDeviceWatch({ ...watch, maxHeight: 16 })).toThrow();
    expect(() => decodeSimulatorDeviceWatch({ ...watch, udid: "booted" })).toThrow();
  });
});
