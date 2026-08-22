import { describe, expect, it } from "vitest";
import { evaluateWorkDeliverySatisfaction } from "./workDeliveryPolicy";

describe("evaluateWorkDeliverySatisfaction", () => {
  it("stays pending until the user confirms the current delivery target", () => {
    expect(
      evaluateWorkDeliverySatisfaction({
        completionConfirmed: false,
        currentDeliveryTarget: "Draft brief",
        evidenceFreshness: "fresh",
      }),
    ).toBe("pending");
  });

  it("does not treat a completed model turn as Done when confirmation is absent", () => {
    expect(
      evaluateWorkDeliverySatisfaction({
        completionConfirmed: false,
        currentDeliveryTarget: "Draft brief",
        childAgents: { active: 0, unacknowledgedResults: 0 },
        evidenceFreshness: "fresh",
      }),
    ).toBe("pending");
  });

  it("is Done only when confirmation names the current target with objective evidence", () => {
    expect(
      evaluateWorkDeliverySatisfaction({
        completionConfirmed: true,
        completionEvidence: {
          deliveryTarget: "Draft brief",
          satisfactionEvidence: "The brief is in the Project root.",
        },
        currentDeliveryTarget: "Draft brief",
        evidenceFreshness: "fresh",
      }),
    ).toBe("done");
  });

  it("waits when confirmation names a different target than the thread currently holds", () => {
    expect(
      evaluateWorkDeliverySatisfaction({
        completionConfirmed: true,
        completionEvidence: {
          deliveryTarget: "Draft brief",
          satisfactionEvidence: "The brief is in the Project root.",
        },
        currentDeliveryTarget: "Renamed brief",
        evidenceFreshness: "fresh",
      }),
    ).toBe("waiting");
  });

  it("waits when confirmation is missing satisfaction evidence", () => {
    expect(
      evaluateWorkDeliverySatisfaction({
        completionConfirmed: true,
        currentDeliveryTarget: "Draft brief",
        evidenceFreshness: "fresh",
      }),
    ).toBe("waiting");
  });

  it("waits when supporting artifact or citation evidence is stale", () => {
    expect(
      evaluateWorkDeliverySatisfaction({
        completionConfirmed: true,
        completionEvidence: {
          deliveryTarget: "Draft brief",
          satisfactionEvidence: "The brief is in the Project root.",
        },
        currentDeliveryTarget: "Draft brief",
        evidenceFreshness: "stale",
      }),
    ).toBe("waiting");
  });

  it("waits while child runs are still active or unacknowledged", () => {
    expect(
      evaluateWorkDeliverySatisfaction({
        completionConfirmed: true,
        completionEvidence: {
          deliveryTarget: "Draft brief",
          satisfactionEvidence: "The brief is in the Project root.",
        },
        currentDeliveryTarget: "Draft brief",
        childAgents: { active: 1, unacknowledgedResults: 0 },
        evidenceFreshness: "fresh",
      }),
    ).toBe("waiting");
    expect(
      evaluateWorkDeliverySatisfaction({
        completionConfirmed: true,
        completionEvidence: {
          deliveryTarget: "Draft brief",
          satisfactionEvidence: "The brief is in the Project root.",
        },
        currentDeliveryTarget: "Draft brief",
        childAgents: { active: 0, unacknowledgedResults: 1 },
        evidenceFreshness: "fresh",
      }),
    ).toBe("waiting");
  });
});
