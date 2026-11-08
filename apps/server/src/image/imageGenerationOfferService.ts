import {
  decodeImageGenerationOffer,
  decodeImageGenerationOfferId,
  MAX_PENDING_IMAGE_GENERATION_OFFERS,
  type ImageGenerationOffer,
  type ImageGenerationOfferId,
  type ProviderInstanceId,
  type ProviderModelId,
  type WindowId,
} from "@octant/contracts";

const DEFAULT_TTL_MS = 10 * 60_000;

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
  | { readonly status: "expired" }
  | { readonly status: "too-many-waiting" };

type ThreadScope = Pick<ImageGenerationOffer, "threadKind" | "scopeId">;

/** An offer as the asking tool describes it; the service stamps its id and time. */
export type ImageGenerationOfferRequest = ImageGenerationOffer extends infer Offer
  ? Offer extends ImageGenerationOffer
    ? Omit<Offer, "offerId" | "requestedAt">
    : never
  : never;

export interface ImageGenerationOfferServiceOptions {
  readonly uuid: () => string;
  readonly now: () => number;
  readonly ttlMs?: number;
  /** The waiting set changed. Wired at composition to the change feed. */
  readonly onChanged?: () => void;
}

interface PendingOffer {
  readonly view: ImageGenerationOffer;
  readonly windowId: WindowId;
  readonly settle: (outcome: ImageGenerationOfferOutcome) => void;
}

/**
 * Image generations an agent asked the person to start, and saves of a
 * generated image it asked to make, held until they
 * answer, as routine proposals are: visible only to the window whose turn
 * asked, settled by exactly one answer, and given up when the turn stops, the
 * window goes away, or ten minutes pass.
 *
 * "Don't ask again in this thread" is remembered here, in memory, together
 * with the model the person chose. A host restart forgets it, so a thread asks
 * once more rather than spending on a choice nobody can see being kept.
 */
export class ImageGenerationOfferService {
  readonly #pending = new Map<string, PendingOffer>();
  readonly #remembered = new Map<string, ImageGenerationChoice>();
  readonly #ttlMs: number;
  readonly #options: ImageGenerationOfferServiceOptions;

  constructor(options: ImageGenerationOfferServiceOptions) {
    this.#options = options;
    this.#ttlMs = Math.max(1_000, Math.min(options.ttlMs ?? DEFAULT_TTL_MS, DEFAULT_TTL_MS));
  }

  offer(input: {
    readonly windowId: WindowId;
    readonly offer: ImageGenerationOfferRequest;
    readonly signal?: AbortSignal;
  }): Promise<ImageGenerationOfferOutcome> {
    if (input.signal?.aborted) return Promise.resolve({ status: "cancelled" });
    if (this.#pending.size >= MAX_PENDING_IMAGE_GENERATION_OFFERS) {
      return Promise.resolve({ status: "too-many-waiting" });
    }
    const view = decodeImageGenerationOffer({
      ...input.offer,
      offerId: decodeImageGenerationOfferId(this.#options.uuid()),
      requestedAt: new Date(this.#options.now()).toISOString(),
    });
    const key = String(view.offerId);
    const signal = input.signal;
    return new Promise((resolve) => {
      const onAbort = () => settle({ status: "cancelled" });
      const timer = setTimeout(() => settle({ status: "expired" }), this.#ttlMs);
      timer.unref?.();
      let settled = false;
      const settle = (outcome: ImageGenerationOfferOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.#pending.delete(key)) this.#options.onChanged?.();
        resolve(outcome);
      };
      this.#pending.set(key, { view, windowId: input.windowId, settle });
      this.#options.onChanged?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The offers this window may answer for one thread, oldest first. */
  list(windowId: WindowId, scope: ThreadScope): ReadonlyArray<ImageGenerationOffer> {
    return [...this.#pending.values()]
      .filter(
        (pending) =>
          String(pending.windowId) === String(windowId) &&
          pending.view.threadKind === scope.threadKind &&
          String(pending.view.scopeId) === String(scope.scopeId),
      )
      .map((pending) => pending.view);
  }

  /** The waiting offer this window asked for, without taking it off the list. */
  find(windowId: WindowId, offerId: ImageGenerationOfferId): ImageGenerationOffer | undefined {
    const pending = this.#pending.get(String(offerId));
    return pending === undefined || String(pending.windowId) !== String(windowId)
      ? undefined
      : pending.view;
  }

  /**
   * Take one waiting offer off the list so exactly one answer acts on it; a
   * second claim, from a retry or another tab of the same window, finds
   * nothing.
   */
  claim(
    windowId: WindowId,
    offerId: ImageGenerationOfferId,
  ):
    | {
        readonly offer: ImageGenerationOffer;
        readonly settle: (outcome: ImageGenerationOfferOutcome) => void;
      }
    | undefined {
    const key = String(offerId);
    const pending = this.#pending.get(key);
    if (pending === undefined || String(pending.windowId) !== String(windowId)) return undefined;
    this.#pending.delete(key);
    this.#options.onChanged?.();
    return { offer: pending.view, settle: pending.settle };
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

  revokeWindow(windowId: WindowId): void {
    for (const pending of this.#pending.values()) {
      if (String(pending.windowId) === String(windowId)) pending.settle({ status: "cancelled" });
    }
  }

  close(): void {
    for (const pending of this.#pending.values()) pending.settle({ status: "cancelled" });
  }
}

function scopeKey(scope: ThreadScope): string {
  return `${scope.threadKind}:${String(scope.scopeId)}`;
}
