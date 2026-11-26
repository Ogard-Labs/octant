import type {
  ImageGenerationProfileView,
  ServiceOffer,
  ServiceOfferDecision,
  ServiceOfferEnvelope,
} from "@octant/contracts";
import { useLayoutEffect, useMemo, type ComponentType } from "react";

export interface OfferCardProps<Offer> {
  readonly offer: Offer;
  readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
  readonly keptIn: "project" | "thread";
  readonly busy: boolean;
  readonly decide: (answer: ServiceOfferDecision) => void;
}

/** A listed offer before its payload is read, and where to say the payload is refused. */
export interface ListedOfferCardProps extends OfferCardProps<ServiceOfferEnvelope> {
  readonly refuse: (offerId: ServiceOfferEnvelope["offerId"]) => void;
}

/**
 * A kind's card behind its strict payload decode. An offer with a field this
 * build does not know renders nothing at all, so a person is never shown, and
 * can never answer, less than the offer asks.
 */
export function strictOfferCard<Offer extends ServiceOffer>(
  decode: (listed: unknown) => Offer,
  Card: ComponentType<OfferCardProps<Offer>>,
): ComponentType<ListedOfferCardProps> {
  return function StrictOfferCard({ offer: listed, refuse, ...props }) {
    const offer = useMemo(() => {
      try {
        return decode(listed);
      } catch {
        return undefined;
      }
    }, [listed]);
    const refused = offer === undefined;
    // Before paint, so a refused offer never shows an empty prompt.
    useLayoutEffect(() => {
      if (refused) refuse(listed.offerId);
    }, [listed.offerId, refuse, refused]);
    return offer === undefined ? null : <Card {...props} offer={offer} />;
  };
}
