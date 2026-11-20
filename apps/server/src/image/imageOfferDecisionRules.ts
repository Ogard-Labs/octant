import type {
  ImageGenerationOffer,
  ImageGenerationOfferDecision,
  ImageGenerationProfileView,
  ImageGenerationSettings,
  ProviderInstance,
} from "@octant/contracts";
import { imageProfileSupportsReferences, listEligibleImageProfiles } from "@octant/domain";
import type { ServiceOfferRules } from "../offers/serviceOfferDecision";
import type { ImageGenerationOfferOutcome } from "./imageGenerationOfferService";
import type { KeptImageGenerationChoices } from "./keptImageGenerationChoices";

export function unavailableImageModel(
  profiles: ReadonlyArray<ImageGenerationProfileView>,
  decision: Extract<ImageGenerationOfferDecision, { decision: "generate" }>,
): string | undefined {
  return profiles.some(
    (profile) =>
      String(profile.instanceId) === String(decision.profileInstanceId) &&
      profile.modelAllowlist.some((id) => String(id) === String(decision.modelId)),
  )
    ? undefined
    : "That image model is not available. Choose another one.";
}

export function imageOfferDecisionRules(input: {
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  readonly readImageGenerationSettings: () => ImageGenerationSettings;
  readonly kept?: Pick<KeptImageGenerationChoices, "remember">;
}): ServiceOfferRules<
  ImageGenerationOffer,
  ImageGenerationOfferDecision,
  Exclude<ImageGenerationOfferOutcome, { status: "too-many-waiting" }>
> {
  const wrongKind = { reason: "That answer does not fit this request." };
  const cancel = { outcome: { status: "cancelled" } } as const;
  return {
    generate(offer, decision) {
      if (decision.decision === "cancel") return cancel;
      if (decision.decision === "agent-draws") return { outcome: { status: "agent-draws" } };
      if (decision.decision !== "generate") return wrongKind;
      const profiles = listEligibleImageProfiles(
        input.listInstances(),
        input.readImageGenerationSettings().customSources,
      );
      const reason = unavailableImageModel(profiles, decision);
      if (reason !== undefined) return { reason };
      const eligible = profiles.find(
        (profile) => String(profile.instanceId) === String(decision.profileInstanceId),
      );
      if (offer.references !== undefined) {
        if (eligible === undefined || !imageProfileSupportsReferences(eligible)) {
          return { reason: "That model can't use reference images. Choose another one." };
        }
        if (decision.referenceImagesConfirmed !== true) {
          return { reason: "Open this offer in a client that shows which images will be sent." };
        }
      }
      const choice = { profileInstanceId: decision.profileInstanceId, modelId: decision.modelId };
      const kept = input.kept;
      return {
        outcome: { status: "generate", ...choice },
        ...(kept === undefined || !decision.rememberForThread || offer.references !== undefined
          ? {}
          : {
              remember: async (actor) => {
                await kept.remember(offer, choice, actor).catch(() => undefined);
              },
            }),
      };
    },
    save(_offer, decision) {
      if (decision.decision === "cancel") return cancel;
      return decision.decision === "save" ? { outcome: { status: "save" } } : wrongKind;
    },
  };
}
