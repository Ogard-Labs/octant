import {
  decodeImageGenerationOfferId,
  decodeVideoGenerateOffer,
  decodeVideoSaveOffer,
  type ProviderInstanceId,
  type ProviderModelId,
  type ServiceOffer,
  type VideoGenerateOffer,
  type VideoSaveOffer,
  type WindowId,
} from "@octant/contracts";
import type { ServiceOfferAnswer } from "../offers/serviceOfferDecision";
import type { ServiceOfferService } from "../offers/serviceOfferService";
import type { VideoOfferOutcome } from "./videoOfferDecisionRules";

export interface VideoGenerationChoice {
  readonly profileInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

type ThreadScope = Pick<VideoGenerateOffer, "threadKind" | "scopeId">;

/**
 * The video card's questions through the shared offer queue. "Don't ask
 * again" from a thread outside a Project is kept here in memory, as for
 * images; a thread in a Project keeps it on the Project
 * (`createKeptImageGenerationChoices` with `media: "video"`).
 */
export class VideoOfferService {
  readonly #remembered = new Map<string, VideoGenerationChoice>();
  readonly #offers: Pick<ServiceOfferService<ServiceOffer, ServiceOfferAnswer>, "wait">;

  constructor(offers: Pick<ServiceOfferService<ServiceOffer, ServiceOfferAnswer>, "wait">) {
    this.#offers = offers;
  }

  async offerGenerate(input: {
    readonly windowId: WindowId;
    readonly offer: Omit<VideoGenerateOffer, "offerId" | "requestedAt">;
    readonly signal?: AbortSignal;
  }): Promise<VideoOfferOutcome | { readonly status: "too-many-waiting" }> {
    const outcome = await this.#offers.wait({
      ...input,
      stamp: (offerId, requestedAt) =>
        decodeVideoGenerateOffer({
          ...input.offer,
          offerId: decodeImageGenerationOfferId(offerId),
          requestedAt,
        }),
    });
    if (outcome.status === "too-many-waiting") return outcome;
    return outcome.status === "video-generate" ? outcome : { status: "cancelled" };
  }

  async offerSave(input: {
    readonly windowId: WindowId;
    readonly offer: Omit<VideoSaveOffer, "offerId" | "requestedAt">;
    readonly signal?: AbortSignal;
  }): Promise<VideoOfferOutcome | { readonly status: "too-many-waiting" }> {
    const outcome = await this.#offers.wait({
      ...input,
      stamp: (offerId, requestedAt) =>
        decodeVideoSaveOffer({
          ...input.offer,
          offerId: decodeImageGenerationOfferId(offerId),
          requestedAt,
        }),
    });
    if (outcome.status === "too-many-waiting") return outcome;
    return outcome.status === "video-save" ? outcome : { status: "cancelled" };
  }

  remember(scope: ThreadScope, choice: VideoGenerationChoice): void {
    this.#remembered.set(scopeKey(scope), choice);
  }

  remembered(scope: ThreadScope): VideoGenerationChoice | undefined {
    return this.#remembered.get(scopeKey(scope));
  }

  forget(scope: ThreadScope): void {
    this.#remembered.delete(scopeKey(scope));
  }
}

function scopeKey(scope: ThreadScope): string {
  return `${scope.threadKind}:${String(scope.scopeId)}`;
}
