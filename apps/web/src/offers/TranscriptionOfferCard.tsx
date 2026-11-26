import { useId, useState } from "react";
import { decodeTranscriptionOffer, type TranscriptionOffer } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { strictOfferCard, type OfferCardProps } from "./strictOfferCard";

export const TranscriptionOfferCard = strictOfferCard(decodeTranscriptionOffer, TranscriptionCard);

function TranscriptionCard({ offer, busy, decide }: OfferCardProps<TranscriptionOffer>) {
  const [remember, setRemember] = useState(false);
  const id = useId();
  return (
    <article aria-label="Transcription request" className="follow-up-card">
      <p className="follow-up-card__title">Transcribe this recording?</p>
      <p className="follow-up-card__prompt">
        {offer.relativePath} ({offer.sizeBytes.toLocaleString()} bytes)
      </p>
      <p className="follow-up-card__summary">
        Sent to {offer.endpointName} ({offer.modelId}). Your provider may charge for transcription.
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
          Don't transcribe
        </OctantButton>
        <OctantButton
          disabled={busy}
          size="xs"
          type="button"
          onClick={() =>
            decide({ decision: "transcribe", offerId: offer.offerId, rememberForThread: remember })
          }
        >
          Transcribe
        </OctantButton>
      </div>
    </article>
  );
}
