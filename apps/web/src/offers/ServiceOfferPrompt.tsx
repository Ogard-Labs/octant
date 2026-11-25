import type { ServiceOfferClient } from "@octant/client-runtime/service-offer-client";
import type {
  ImageGenerationProfileView,
  ServiceOffer,
  ServiceOfferDecision,
  ServiceOfferEnvelope,
  ServiceOfferEnvelopes,
} from "@octant/contracts";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import "../followUps/follow-up-suggestions.css";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantAlert } from "../ui/base/OctantAlert";
import type { ListedOfferCardProps } from "./strictOfferCard";

const ACTIVE_OFFER_POLL_MS = 500;
const IDLE_OFFER_POLL_MS = 5_000;

type ListedOfferCard = LazyExoticComponent<ComponentType<ListedOfferCardProps>>;

/**
 * Each kind's card brings its payload schema with it, when the first such
 * offer shows. A card that cannot load is set aside as an offer this build
 * cannot read is, rather than taking the thread's pane down with it; the
 * offer stays listed and waiting, and the thread's next offer is asked.
 */
const card = (load: () => Promise<ComponentType<ListedOfferCardProps>>): ListedOfferCard =>
  lazy(() =>
    load().then(
      (Card) => ({ default: Card }),
      () => ({ default: UnloadedCard }),
    ),
  );

/** Set aside like a refused offer, so the thread's next offer is asked. */
function UnloadedCard({ offer, refuse }: ListedOfferCardProps) {
  useLayoutEffect(() => refuse(offer.offerId), [offer.offerId, refuse]);
  return null;
}

const CARDS: Record<ServiceOffer["kind"], ListedOfferCard> = {
  generate: card(async () => (await import("../image/imageOfferCards")).ImageGenerateOfferCard),
  save: card(async () => (await import("../image/imageOfferCards")).ImageSaveOfferCard),
  transcribe: card(async () => (await import("./TranscriptionOfferCard")).TranscriptionOfferCard),
  narrate: card(async () => (await import("./NarrationOfferCard")).NarrationOfferCard),
  "video-generate": card(
    async () => (await import("../video/videoOfferCards")).VideoGenerateOfferCard,
  ),
  "video-save": card(async () => (await import("../video/videoOfferCards")).VideoSaveOfferCard),
};

const CARD_KINDS: ReadonlyMap<string, ListedOfferCard> = new Map(Object.entries(CARDS));

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
  const [listed, setListed] = useState<ServiceOfferEnvelopes>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    readonly offerId: ServiceOffer["offerId"];
    readonly message: string;
  }>();
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  const revision = useThreadActivityRevision("toolApprovals");

  useEffect(() => {
    setListed(undefined);
    setRefused(new Set());
  }, [client, scopeId, threadKind]);

  const refuse = useCallback(
    (offerId: ServiceOfferEnvelope["offerId"]) =>
      setRefused((current) => new Set([...current, String(offerId)])),
    [],
  );

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

  // An offer this build cannot show waits for a build that can; the thread's
  // other offers are asked meanwhile.
  const pending = listed?.offers.find(
    (offer) => CARD_KINDS.has(offer.kind) && !refused.has(String(offer.offerId)),
  );
  const Card = pending === undefined ? undefined : CARD_KINDS.get(pending.kind);
  if (
    pending === undefined ||
    Card === undefined ||
    client === undefined ||
    pending.threadKind !== threadKind ||
    String(pending.scopeId) !== String(scopeId)
  )
    return null;
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
    <Suspense fallback={null}>
      <section
        aria-label="Asked by the agent"
        className={`follow-up-cards ${props.className ?? ""}`}
      >
        <Card
          key={pending.offerId}
          offer={pending}
          profiles={listed?.imageProfiles ?? props.profiles}
          keptIn={props.keptIn}
          busy={busy}
          decide={(answer) => void decide(answer)}
          refuse={refuse}
        />
        {message === undefined ? null : (
          <OctantAlert className="follow-up-cards__error" tone="danger">
            {message}
          </OctantAlert>
        )}
      </section>
    </Suspense>
  );
}
