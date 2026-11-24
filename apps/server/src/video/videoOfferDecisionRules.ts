import type {
  ServiceOfferDecision,
  VideoClipOptions,
  VideoGenerateOffer,
  VideoSaveOffer,
} from "@octant/contracts";
import { checkVideoClipOptions } from "@octant/provider-sdk/video-generation";
import type { KeptImageGenerationChoices } from "../image/keptImageGenerationChoices";
import type { ServiceOfferRules } from "../offers/serviceOfferDecision";

/** What the asking video tool call learns from the person's answer. */
export type VideoOfferOutcome =
  | {
      readonly status: "video-generate";
      readonly options: VideoClipOptions;
      readonly rememberForThread: boolean;
    }
  | { readonly status: "video-save" }
  | { readonly status: "cancelled" };

/**
 * How a person's answer to a video card becomes the tool call's outcome. The
 * options they chose are checked again against what the offered model
 * declares, so a client cannot widen them; "Don't ask again" keeps the
 * profile and model by the same rule as images, never with images attached.
 */
export function videoOfferDecisionRules(input: {
  readonly kept?: Pick<KeptImageGenerationChoices, "remember">;
}): ServiceOfferRules<
  VideoGenerateOffer | VideoSaveOffer,
  ServiceOfferDecision,
  VideoOfferOutcome
> {
  const wrongKind = { reason: "That answer does not fit this request." };
  const cancel = { outcome: { status: "cancelled" } } as const;
  return {
    "video-generate"(offer, decision) {
      if (decision.decision === "cancel") return cancel;
      if (decision.decision !== "video-generate") return wrongKind;
      const check = checkVideoClipOptions(offer.model, decision.options, {
        firstFrame: offer.images.some((image) => image.role === "first-frame"),
        lastFrame: offer.images.some((image) => image.role === "last-frame"),
        referenceCount: offer.images.filter((image) => image.role === "reference").length,
      });
      if (check.status === "refused") return { reason: check.reason };
      const kept = input.kept;
      const remember = decision.rememberForThread && offer.canRemember;
      return {
        outcome: {
          status: "video-generate",
          options: decision.options,
          rememberForThread: remember,
        },
        ...(kept === undefined || !remember
          ? {}
          : {
              remember: async (actor) => {
                await kept
                  .remember(
                    { threadKind: offer.threadKind, scopeId: offer.scopeId },
                    { profileInstanceId: offer.profileInstanceId, modelId: offer.model.modelId },
                    actor,
                  )
                  .catch(() => undefined);
              },
            }),
      };
    },
    "video-save"(_offer, decision) {
      if (decision.decision === "cancel") return cancel;
      return decision.decision === "video-save" ? { outcome: { status: "video-save" } } : wrongKind;
    },
  };
}
