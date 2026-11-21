import type { WindowId } from "@octant/contracts";

interface ThreadScope {
  readonly threadKind: string;
  readonly scopeId: string;
}

interface OfferView extends ThreadScope {
  readonly offerId: string;
}

type Cancelled = { readonly status: "cancelled" };
type AtCapacity = { readonly status: "too-many-waiting" };

export interface ServiceOfferServiceOptions {
  readonly uuid: () => string;
  readonly now: () => number;
  readonly onChanged?: () => void;
  readonly onAsked?: (ask: { readonly threadId: string; readonly askId: string }) => void;
}

interface PendingOffer<View, Outcome> {
  readonly view: View;
  readonly windowId: WindowId;
  readonly settle: (outcome: Outcome | Cancelled) => void;
}

/** Waiting offers never time out. The host bounds what it holds by count. */
export class ServiceOfferService<View extends OfferView, Outcome> {
  readonly #pending = new Map<string, PendingOffer<View, Outcome>>();
  readonly #capacity: number;
  readonly #options: ServiceOfferServiceOptions;

  constructor(capacity: number, options: ServiceOfferServiceOptions) {
    this.#capacity = capacity;
    this.#options = options;
  }

  wait(input: {
    readonly windowId: WindowId;
    readonly stamp: (offerId: string, requestedAt: string) => View;
    readonly signal?: AbortSignal;
  }): Promise<Outcome | Cancelled | AtCapacity> {
    if (input.signal?.aborted) return Promise.resolve({ status: "cancelled" });
    if (this.#pending.size >= this.#capacity) {
      return Promise.resolve({ status: "too-many-waiting" });
    }
    const view = input.stamp(this.#options.uuid(), new Date(this.#options.now()).toISOString());
    const key = String(view.offerId);
    const signal = input.signal;
    return new Promise((resolve) => {
      const onAbort = () => settle({ status: "cancelled" });
      let settled = false;
      const settle = (outcome: Outcome | Cancelled) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (this.#pending.delete(key)) this.#options.onChanged?.();
        resolve(outcome);
      };
      this.#pending.set(key, { view, windowId: input.windowId, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#options.onChanged?.();
      this.#options.onAsked?.({ threadId: String(view.scopeId), askId: key });
    });
  }

  list(windowId: WindowId, scope: ThreadScope): ReadonlyArray<View> {
    return this.listForWindow(windowId).filter(
      (offer) =>
        offer.threadKind === scope.threadKind && String(offer.scopeId) === String(scope.scopeId),
    );
  }

  listForWindow(windowId: WindowId): ReadonlyArray<View> {
    return [...this.#pending.values()]
      .filter((pending) => String(pending.windowId) === String(windowId))
      .map((pending) => pending.view);
  }

  #owned(windowId: WindowId, offerId: string): PendingOffer<View, Outcome> | undefined {
    const pending = this.#pending.get(String(offerId));
    return pending !== undefined && String(pending.windowId) === String(windowId)
      ? pending
      : undefined;
  }

  find(windowId: WindowId, offerId: string): View | undefined {
    return this.#owned(windowId, offerId)?.view;
  }

  claim(
    windowId: WindowId,
    offerId: string,
  ): { readonly offer: View; readonly settle: (outcome: Outcome | Cancelled) => void } | undefined {
    const pending = this.#owned(windowId, offerId);
    if (pending === undefined) return undefined;
    this.#pending.delete(String(offerId));
    this.#options.onChanged?.();
    return { offer: pending.view, settle: pending.settle };
  }

  revokeWindow(windowId: WindowId): void {
    for (const pending of this.#pending.values()) {
      if (String(pending.windowId) === String(windowId)) pending.settle({ status: "cancelled" });
    }
  }

  withdrawThread(threadId: string): void {
    for (const pending of this.#pending.values()) {
      if (String(pending.view.scopeId) === threadId) pending.settle({ status: "cancelled" });
    }
  }

  close(): void {
    for (const pending of this.#pending.values()) pending.settle({ status: "cancelled" });
  }
}
