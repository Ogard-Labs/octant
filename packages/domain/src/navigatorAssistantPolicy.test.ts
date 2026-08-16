import { describe, expect, it } from "vitest";
import {
  imageInputCapabilityOf,
  navigatorAssistantImagePolicy,
  NAVIGATOR_ASSISTANT_DEFAULT_MODEL_TARGET,
  NAVIGATOR_ASSISTANT_VISION_REVIEWER_TARGET,
} from "./navigatorAssistantPolicy";

describe("imageInputCapabilityOf", () => {
  it("normalizes an unobserved model to unknown", () => {
    expect(imageInputCapabilityOf(undefined)).toBe("unknown");
  });

  it("prefers the driver-reported tri-state over modality inference", () => {
    expect(
      imageInputCapabilityOf({ imageInput: "unsupported", inputModalities: ["text", "image"] }),
    ).toBe("unsupported");
    expect(imageInputCapabilityOf({ imageInput: "supported", inputModalities: ["text"] })).toBe(
      "supported",
    );
  });

  it("treats a driver-reported image modality as supported", () => {
    expect(imageInputCapabilityOf({ inputModalities: ["text", "image"] })).toBe("supported");
  });

  it("treats an unreported text-only modality list as unknown, never unsupported", () => {
    // Most drivers hardcode a text-only fallback when they have no modality
    // metadata, so text-only without an explicit report proves nothing.
    expect(imageInputCapabilityOf({ inputModalities: ["text"] })).toBe("unknown");
  });
});

describe("navigatorAssistantImagePolicy", () => {
  it("sends to the primary model only when image input is affirmatively supported", () => {
    expect(
      navigatorAssistantImagePolicy({ imageInput: "supported", visionReviewerConfigured: false }),
    ).toEqual({ kind: "send-to-primary" });
  });

  it("never treats unknown as supported: unknown without a reviewer refuses", () => {
    const decision = navigatorAssistantImagePolicy({
      imageInput: "unknown",
      visionReviewerConfigured: false,
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.settingsTarget).toEqual(NAVIGATOR_ASSISTANT_VISION_REVIEWER_TARGET);
      expect(decision.reason).toMatch(/vision reviewer/i);
    }
  });

  it("routes unknown or unsupported image input through a configured reviewer", () => {
    expect(
      navigatorAssistantImagePolicy({ imageInput: "unknown", visionReviewerConfigured: true }),
    ).toEqual({ kind: "review-then-send" });
    expect(
      navigatorAssistantImagePolicy({ imageInput: "unsupported", visionReviewerConfigured: true }),
    ).toEqual({ kind: "review-then-send" });
  });

  it("refuses unsupported image input without a reviewer, pointing at the setting", () => {
    const decision = navigatorAssistantImagePolicy({
      imageInput: "unsupported",
      visionReviewerConfigured: false,
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.settingsTarget).toEqual(NAVIGATOR_ASSISTANT_VISION_REVIEWER_TARGET);
    }
  });

  it("exposes the default-model settings target for unconfigured readiness", () => {
    expect(NAVIGATOR_ASSISTANT_DEFAULT_MODEL_TARGET).toEqual({
      section: "navigator-assistant",
      setting: "default-model",
    });
  });
});
