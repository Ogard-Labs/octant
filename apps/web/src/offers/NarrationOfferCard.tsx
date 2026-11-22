import { useId, useState } from "react";
import type { ServiceOffer, ServiceOfferDecision } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";

export function NarrationOfferCard({
  offer,
  busy,
  decide,
}: {
  readonly offer: ServiceOffer;
  readonly busy: boolean;
  readonly decide: (answer: ServiceOfferDecision) => void;
}) {
  const [remember, setRemember] = useState(false);
  const id = useId();
  if (offer.kind !== "narrate") return null;
  const truncated = offer.characters > offer.excerpt.length;
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
      <label className="follow-up-card__summary" htmlFor={id}>
        <OctantCheckbox
          id={id}
          disabled={busy}
          checked={remember}
          onChange={(event) => setRemember(event.currentTarget.checked)}
        />{" "}
        Don't ask again in this thread
      </label>
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
            decide({ decision: "narrate", offerId: offer.offerId, rememberForThread: remember })
          }
        >
          Narrate
        </OctantButton>
      </div>
    </article>
  );
}
