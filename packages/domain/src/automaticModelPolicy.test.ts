import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_MODEL_DISCLOSURE,
  AUTOMATIC_MODEL_JOB_LABELS,
  DECISION_REVIEW_OFF_LABEL,
  automaticModelUnavailableReason,
} from "./automaticModelPolicy";

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

describe("the second opinion on decisions", () => {
  it("is told apart from the other jobs, names what leaves, and has no default account", () => {
    expect(AUTOMATIC_MODEL_JOB_LABELS["decision-review"]).toBe("Second opinion on decisions");
    expect(AUTOMATIC_MODEL_DISCLOSURE["decision-review"]).toContain("at most 3,000 characters");
    expect(AUTOMATIC_MODEL_DISCLOSURE["decision-review"]).toContain("with secrets removed");
    expect(AUTOMATIC_MODEL_DISCLOSURE["decision-review"]).toContain("one request");
    expect(DECISION_REVIEW_OFF_LABEL).toBe("Off");
  });
});
