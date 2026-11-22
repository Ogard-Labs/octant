import {
  decodeImageGenerationOffer,
  decodeImageGenerationOfferId,
  type ImageGenerationOffer,
  type ProviderInstanceId,
  type ProviderModelId,
  type WindowId,
} from "@octant/contracts";
import type { ServiceOfferService } from "../offers/serviceOfferService";
import type { ServiceOfferAnswer } from "../offers/serviceOfferDecision";
import { whileAwaitingToolApproval } from "../toolEffects/toolEffectLedger";

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
  readonly #offers: Pick<ServiceOfferService<ImageGenerationOffer, ServiceOfferAnswer>, "wait">;

  constructor(offers: Pick<ServiceOfferService<ImageGenerationOffer, ServiceOfferAnswer>, "wait">) {
    this.#offers = offers;
  }

  async offer(input: {
    readonly windowId: WindowId;
    readonly offer: ImageGenerationOfferRequest;
    readonly signal?: AbortSignal;
  }): Promise<ImageGenerationOfferOutcome> {
    // Every offer comes before what it offers (a generation, a save, an icon
    // set's files), so while it waits the call's record says nothing ran.
    const outcome = await whileAwaitingToolApproval(() =>
      this.#offers.wait({
        ...input,
        stamp: (offerId, requestedAt) =>
          decodeImageGenerationOffer({
            ...input.offer,
            offerId: decodeImageGenerationOfferId(offerId),
            requestedAt,
          }),
      }),
    );
    return outcome.status === "generate" ||
      outcome.status === "agent-draws" ||
      outcome.status === "save" ||
      outcome.status === "too-many-waiting"
      ? outcome
      : { status: "cancelled" };
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
