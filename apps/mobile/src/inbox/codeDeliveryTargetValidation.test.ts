import { describe, expect, it } from "vitest";
import { validateCodeDeliveryTargetFields } from "./codeDeliveryTargetValidation";

const valid = {
  branchIntent: "feature/mobile-code",
  remoteName: "origin",
  proposedBaseRepository: "owner/repository",
  proposedBaseBranch: "main",
};

describe("Code delivery target validation", () => {
  it("reports an actionable branch length error before contract decoding", () => {
    expect(validateCodeDeliveryTargetFields({ ...valid, branchIntent: "b".repeat(256) })).toBe(
      "Delivery branch must be 255 characters or fewer.",
    );
  });

  it("reports an actionable remote length error before contract decoding", () => {
    expect(validateCodeDeliveryTargetFields({ ...valid, remoteName: "r".repeat(256) })).toBe(
      "Remote name must be 255 characters or fewer.",
    );
  });

  it("reports an actionable base repository length error before contract decoding", () => {
    expect(
      validateCodeDeliveryTargetFields({
        ...valid,
        proposedBaseRepository: "r".repeat(513),
      }),
    ).toBe("Base repository must be 512 characters or fewer.");
  });

  it("accepts fields at the contract limits", () => {
    expect(
      validateCodeDeliveryTargetFields({
        branchIntent: "b".repeat(255),
        remoteName: "r".repeat(255),
        proposedBaseRepository: "o".repeat(512),
        proposedBaseBranch: "m".repeat(255),
      }),
    ).toBeUndefined();
  });
});
