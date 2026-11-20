import type {
  ImageGenerationOffer,
  ImageGenerationOfferDecision,
  ImageGenerationSettings,
  ProviderInstance,
} from "@octant/contracts";
import { listEligibleImageProfiles } from "@octant/domain";
import type { ServiceOfferRules } from "../offers/serviceOfferDecision";
import type { ImageGenerationOfferOutcome } from "./imageGenerationOfferService";
import type { KeptImageGenerationChoices } from "./keptImageGenerationChoices";

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
      const eligible = listEligibleImageProfiles(
        input.listInstances(),
        input.readImageGenerationSettings().customSources,
      ).some(
        (profile) =>
          String(profile.instanceId) === String(decision.profileInstanceId) &&
          profile.modelAllowlist.some((id) => String(id) === String(decision.modelId)),
      );
      if (!eligible) return { reason: "That image model is not available. Choose another one." };
      const choice = { profileInstanceId: decision.profileInstanceId, modelId: decision.modelId };
      const kept = input.kept;
      return {
        outcome: { status: "generate", ...choice },
        ...(kept === undefined || !decision.rememberForThread
          ? {}
          : {
              remember: async () => {
                await kept.remember(offer, choice).catch(() => undefined);
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
