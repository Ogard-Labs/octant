import type { WindowId } from "@octant/contracts";

type Prepared<Outcome> =
  | { readonly reason: string }
  | { readonly outcome: Outcome; readonly remember?: () => Promise<void> };

export type ServiceOfferRules<View extends { readonly kind: string }, Decision, Outcome> = {
  readonly [Kind in View["kind"]]: (
    offer: View & { readonly kind: Kind },
    decision: Decision,
  ) => Prepared<Outcome>;
};

type OfferView = {
  readonly offerId: string;
  readonly kind: string;
  readonly threadKind: string;
  readonly scopeId: string;
};

export async function resolveServiceOfferDecision<
  View extends OfferView,
  Decision extends { readonly offerId: string },
  Outcome,
>(input: {
  readonly offers: {
    readonly find: (windowId: WindowId, offerId: string) => View | undefined;
    readonly claim: (
      windowId: WindowId,
      offerId: string,
    ) => { readonly settle: (outcome: Outcome) => void } | undefined;
  };
  readonly windowId: WindowId;
  readonly decision: Decision;
  readonly authorize: (offer: View) => Promise<boolean>;
  readonly rules: ServiceOfferRules<View, Decision, Outcome>;
}) {
  const { offers, windowId, decision } = input;
  const waiting = offers.find(windowId, decision.offerId);
  if (waiting === undefined) return { kind: "offer-gone" } as const;
  if (!(await input.authorize(waiting))) return { kind: "offer-inaccessible" } as const;
  const kind: View["kind"] = waiting.kind;
  const prepared = input.rules[kind](waiting, decision);
  if ("reason" in prepared) return { kind: "offer-refused", reason: prepared.reason } as const;
  const claimed = offers.claim(windowId, decision.offerId);
  if (claimed === undefined) return { kind: "offer-gone" } as const;
  // Remembering is optional: even if a Project changed under the answer, the
  // current tool call still hears what the person chose.
  try {
    await prepared.remember?.();
  } finally {
    claimed.settle(prepared.outcome);
  }
  return { kind: "offer-answered" } as const;
}
