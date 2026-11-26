import { useId, useState } from "react";
import { decodeNarrationOffer, type NarrationOffer } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { strictOfferCard, type OfferCardProps } from "./strictOfferCard";

export const NarrationOfferCard = strictOfferCard(decodeNarrationOffer, NarrationCard);

function NarrationCard({ offer, busy, decide }: OfferCardProps<NarrationOffer>) {
  const [remember, setRemember] = useState(false);
  const id = useId();
  const truncated = offer.characters > offer.excerpt.length;
  const canRemember = offer.canRemember !== false;
  return (
    <article aria-label="Narration request" className="follow-up-card">
      <p className="follow-up-card__title">Narrate this text to an audio file?</p>
      <p className="follow-up-card__prompt">
        {offer.excerpt}
        {truncated ? "…" : ""}
      </p>
      <p className="follow-up-card__summary">
        Saves to {offer.relativePath} ({offer.format}, never replaces an existing file) ·{" "}
        {offer.characters.toLocaleString()} {offer.characters === 1 ? "character" : "characters"} ·
        Voice {offer.voice} on {offer.endpointName} ({offer.modelId}). Your provider may charge for
        synthesis.
      </p>
      {canRemember ? (
        <label className="follow-up-card__summary" htmlFor={id}>
          <OctantCheckbox
            id={id}
            disabled={busy}
            checked={remember}
            onChange={(event) => setRemember(event.currentTarget.checked)}
          />{" "}
          Don't ask again in this thread
        </label>
      ) : null}
      <div className="follow-up-card__actions">
        <OctantButton
          disabled={busy}
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => decide({ decision: "cancel", offerId: offer.offerId })}
        >
          Don't narrate
        </OctantButton>
        <OctantButton
          disabled={busy}
          size="xs"
          type="button"
          onClick={() =>
            decide({
              decision: "narrate",
              offerId: offer.offerId,
              rememberForThread: canRemember && remember,
            })
          }
        >
          Narrate
        </OctantButton>
      </div>
    </article>
  );
}
