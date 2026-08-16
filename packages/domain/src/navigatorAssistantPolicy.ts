import type { ImageInputCapability, ProviderInputModality } from "@octant/contracts/providers";
import type { SettingsDeepLink } from "@octant/contracts";

/** Deep link to the Navigator default-model setting. */
export const NAVIGATOR_ASSISTANT_DEFAULT_MODEL_TARGET: SettingsDeepLink = {
  section: "navigator-assistant",
  setting: "default-model",
};

/** Deep link to the Navigator vision-reviewer setting. */
export const NAVIGATOR_ASSISTANT_VISION_REVIEWER_TARGET: SettingsDeepLink = {
  section: "navigator-assistant",
  setting: "vision-reviewer",
};

/** The model facts the image policy reads; a subset of `ProviderModel`. */
export interface NavigatorAssistantImageModelFacts {
  readonly imageInput?: ImageInputCapability | undefined;
  readonly inputModalities: ReadonlyArray<ProviderInputModality>;
}

/**
 * Normalize a model's image-input capability to the honest tri-state.
 *
 * A driver-reported `imageInput` wins outright. Without one, a reported
 * `image` modality is genuine driver metadata and counts as supported, but a
 * text-only list proves nothing: most drivers hardcode a text-only fallback
 * when they hold no modality metadata, so text-only without an explicit
 * report normalizes to `unknown` — never to `unsupported`, and never to
 * `supported`. An unobserved model is `unknown`.
 */
export function imageInputCapabilityOf(
  model: NavigatorAssistantImageModelFacts | undefined,
): ImageInputCapability {
  if (model === undefined) return "unknown";
  if (model.imageInput !== undefined) return model.imageInput;
  return model.inputModalities.includes("image") ? "supported" : "unknown";
}

export type NavigatorAssistantImageDecision =
  | { readonly kind: "send-to-primary" }
  | { readonly kind: "review-then-send" }
  | {
      readonly kind: "refuse";
      readonly reason: string;
      readonly settingsTarget: SettingsDeepLink;
    };

/**
 * Decide how Navigator handles a turn carrying an image.
 *
 * Only affirmative `supported` sends the image to the primary model —
 * `unknown` is not `supported`, so an unverified model never silently
 * receives an image it may not be able to read. Anything less than supported
 * goes to the configured vision reviewer, which returns text to the primary
 * conversation; with no reviewer the image is refused with a precise reason
 * and the settings deep link that fixes it, never dropped silently.
 */
export function navigatorAssistantImagePolicy(input: {
  readonly imageInput: ImageInputCapability;
  readonly visionReviewerConfigured: boolean;
}): NavigatorAssistantImageDecision {
  if (input.imageInput === "supported") return { kind: "send-to-primary" };
  if (input.visionReviewerConfigured) return { kind: "review-then-send" };
  return {
    kind: "refuse",
    reason:
      input.imageInput === "unsupported"
        ? "The Navigator default model cannot read images. Configure a vision reviewer to describe images for it."
        : "Image support is unverified for the Navigator default model. Configure a vision reviewer to describe images for it.",
    settingsTarget: NAVIGATOR_ASSISTANT_VISION_REVIEWER_TARGET,
  };
}
