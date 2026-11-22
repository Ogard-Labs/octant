import type { ServiceOfferClient } from "@octant/client-runtime/service-offer-client";
import type {
  ImageGenerationProfileView,
  ServiceOffer,
  ServiceOfferDecision,
  ServiceOffersResponse,
} from "@octant/contracts";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import "../followUps/follow-up-suggestions.css";
import { ImageGenerateOfferCard, ImageSaveOfferCard } from "../image/imageOfferCards";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantAlert } from "../ui/base/OctantAlert";
import { NarrationOfferCard } from "./NarrationOfferCard";
import { TranscriptionOfferCard } from "./TranscriptionOfferCard";

const ACTIVE_OFFER_POLL_MS = 500;
const IDLE_OFFER_POLL_MS = 5_000;

interface OfferCardProps {
  readonly offer: ServiceOffer;
  readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
  readonly keptIn: "project" | "thread";
  readonly busy: boolean;
  readonly decide: (answer: ServiceOfferDecision) => void;
}

const CARD_RENDERERS: Record<ServiceOffer["kind"], ComponentType<OfferCardProps>> = {
  generate: ImageGenerateOfferCard,
  save: ImageSaveOfferCard,
  transcribe: TranscriptionOfferCard,
  narrate: NarrationOfferCard,
};

export function ServiceOfferPrompt(props: {
  readonly client: ServiceOfferClient | undefined;
  readonly threadKind: ServiceOffer["threadKind"];
  readonly scopeId: ServiceOffer["scopeId"] | undefined;
  readonly keptIn: "project" | "thread";
  readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
  readonly turnActive: boolean;
  readonly className?: string;
}) {
  const { client, scopeId, threadKind, turnActive } = props;
  const [listed, setListed] = useState<ServiceOffersResponse>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    readonly offerId: ServiceOffer["offerId"];
    readonly message: string;
  }>();
  const revision = useThreadActivityRevision("toolApprovals");

  useEffect(() => {
    setListed(undefined);
  }, [client, scopeId, threadKind]);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined || scopeId === undefined) return;
      try {
        const listed = await client.offers({ threadKind, scopeId });
        if (signal.aborted) return;
        setListed((current) =>
          current !== undefined && samePollingData(current, listed) ? current : listed,
        );
      } catch {
        if (!signal.aborted) setListed(undefined);
      }
    },
    [client, scopeId, threadKind],
  );
  useVisibleRefresh(
    refresh,
    revision,
    turnActive
      ? ACTIVE_OFFER_POLL_MS
      : revision === undefined
        ? IDLE_OFFER_POLL_MS
        : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const pending = listed?.offers[0];
  if (
    pending === undefined ||
    client === undefined ||
    pending.threadKind !== threadKind ||
    String(pending.scopeId) !== String(scopeId)
  )
    return null;
  const Card = CARD_RENDERERS[pending.kind];
  const message = failure?.offerId === pending.offerId ? failure.message : undefined;

  async function decide(answer: ServiceOfferDecision) {
    if (client === undefined || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await client.decide(answer);
      if (result.kind === "offer-refused") {
        setFailure({ offerId: answer.offerId, message: result.reason });
        return;
      }
      setListed((current) =>
        current === undefined
          ? undefined
          : {
              ...current,
              offers: current.offers.filter((offer) => offer.offerId !== answer.offerId),
            },
      );
    } catch {
      setFailure({
        offerId: answer.offerId,
        message: "Your answer could not be sent. The request is still waiting; try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Asked by the agent" className={`follow-up-cards ${props.className ?? ""}`}>
      <Card
        key={pending.offerId}
        offer={pending}
        profiles={listed?.imageProfiles ?? props.profiles}
        keptIn={props.keptIn}
        busy={busy}
        decide={(answer) => void decide(answer)}
      />
      {message === undefined ? null : (
        <OctantAlert className="follow-up-cards__error" tone="danger">
          {message}
        </OctantAlert>
      )}
    </section>
  );
}
