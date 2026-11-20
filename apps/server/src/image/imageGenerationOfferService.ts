import {
  decodeImageGenerationOffer,
  decodeImageGenerationOfferId,
  type ImageGenerationOffer,
  type ProviderInstanceId,
  type ProviderModelId,
  type WindowId,
} from "@octant/contracts";
import type { ServiceOfferService } from "../offers/serviceOfferService";

export interface ImageGenerationChoice {
  readonly profileInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

/**
 * What the asking tool call learns. Only `generate` spends anything, and only
 * with the profile and model the person chose.
 */
export type ImageGenerationOfferOutcome =
  | ({ readonly status: "generate" } & ImageGenerationChoice)
  | { readonly status: "agent-draws" }
  | { readonly status: "save" }
  | { readonly status: "cancelled" }
  | { readonly status: "too-many-waiting" };

export type ImageOfferAnswer = Exclude<
  ImageGenerationOfferOutcome,
  { status: "cancelled" | "too-many-waiting" }
>;

type ThreadScope = Pick<ImageGenerationOffer, "threadKind" | "scopeId">;

/** An offer as the asking tool describes it; the service stamps its id and time. */
export type ImageGenerationOfferRequest = ImageGenerationOffer extends infer Offer
  ? Offer extends ImageGenerationOffer
    ? Omit<Offer, "offerId" | "requestedAt">
    : never
  : never;

/**
 * "Don't ask again" from a thread outside a Project is remembered here, in
 * memory, together with the model the person chose; a host restart forgets
 * it. A thread in a Project keeps its choice on the Project instead, journaled
 * (`createKeptImageGenerationChoices`).
 */
export class ImageGenerationOfferService {
  readonly #remembered = new Map<string, ImageGenerationChoice>();
  readonly #offers: Pick<ServiceOfferService<ImageGenerationOffer, ImageOfferAnswer>, "wait">;

  constructor(offers: Pick<ServiceOfferService<ImageGenerationOffer, ImageOfferAnswer>, "wait">) {
    this.#offers = offers;
  }

  offer(input: {
    readonly windowId: WindowId;
    readonly offer: ImageGenerationOfferRequest;
    readonly signal?: AbortSignal;
  }): Promise<ImageGenerationOfferOutcome> {
    return this.#offers.wait({
      ...input,
      stamp: (offerId, requestedAt) =>
        decodeImageGenerationOffer({
          ...input.offer,
          offerId: decodeImageGenerationOfferId(offerId),
          requestedAt,
        }),
    });
  }

  remember(scope: ThreadScope, choice: ImageGenerationChoice): void {
    this.#remembered.set(scopeKey(scope), choice);
  }

  remembered(scope: ThreadScope): ImageGenerationChoice | undefined {
    return this.#remembered.get(scopeKey(scope));
  }

  forget(scope: ThreadScope): void {
    this.#remembered.delete(scopeKey(scope));
  }
}

function scopeKey(scope: ThreadScope): string {
  return `${scope.threadKind}:${String(scope.scopeId)}`;
}
