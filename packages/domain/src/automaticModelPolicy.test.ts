import { describe, expect, it } from "vitest";
import { automaticModelUnavailableReason } from "./automaticModelPolicy";

const on = { enabled: true, displayName: "Work account" };

describe("an account chosen for an automatic call", () => {
  it("may be used when it is on, ready and under its limit", () => {
    expect(
      automaticModelUnavailableReason({ instance: on, readiness: "ready", atLimit: false }),
    ).toBeUndefined();
  });

  it("may be used while its readiness is still being checked", () => {
    expect(
      automaticModelUnavailableReason({ instance: on, readiness: "checking", atLimit: false }),
    ).toBeUndefined();
  });

  it("is refused in plain words when it was removed, is off, is at its limit or is not ready", () => {
    expect(
      automaticModelUnavailableReason({
        instance: undefined,
        readiness: undefined,
        atLimit: false,
      }),
    ).toBe("The account you chose was removed.");
    expect(
      automaticModelUnavailableReason({
        instance: { enabled: false, displayName: "Work account" },
        readiness: "ready",
        atLimit: false,
      }),
    ).toBe("Work account is turned off.");
    expect(
      automaticModelUnavailableReason({ instance: on, readiness: "ready", atLimit: true }),
    ).toBe("Work account is at its usage limit.");
    expect(
      automaticModelUnavailableReason({
        instance: on,
        readiness: "unauthenticated",
        atLimit: false,
      }),
    ).toBe("Work account is not ready.");
  });
});
