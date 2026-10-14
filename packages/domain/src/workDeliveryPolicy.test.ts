import { describe, expect, it } from "vitest";
import { evaluateWorkDeliverySatisfaction } from "./workDeliveryPolicy";

describe("evaluateWorkDeliverySatisfaction", () => {
  it("stays pending until a person marks the thread Done", () => {
    expect(evaluateWorkDeliverySatisfaction({ completionConfirmed: false })).toBe("pending");
  });

  it("is Done once a person marks the thread Done, with no evidence text", () => {
    expect(evaluateWorkDeliverySatisfaction({ completionConfirmed: true })).toBe("done");
  });
});
